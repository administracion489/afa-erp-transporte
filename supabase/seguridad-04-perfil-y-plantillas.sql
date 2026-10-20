-- ═══════════════════════════════════════════════════════════════════════════
-- seguridad-04-perfil-y-plantillas.sql · el perfil de la empresa, las plantillas PDF y el logo
-- solo los ESCRIBE quien tiene su módulo. (NO la corre el deploy: Supabase → SQL Editor → pegar
-- ENTERA → Run.) Idempotente. Requiere fn_puede_modulo (traslados-01); si falta, se detiene.
--
-- POR QUÉ: la IA del CRM manda por WhatsApp, SIN que nadie lo revise, el PDF de los traslados, y
-- ese PDF imprime las CUENTAS BANCARIAS de `empresa_perfil` y de la plantilla `corporativo` de
-- `cotizacion_plantillas`, y el LOGO del bucket `empresa`. Las tres tenían «todo permitido» para
-- cualquier usuario con sesión: desde la consola del navegador, cualquier cuenta del ERP podía
-- cambiar el número de cuenta y el cliente le depositaría a otro, en un papel con nuestro logo.
--
-- QUIÉN ESCRIBE (comprobado en el código, 20-10-2026):
--   · empresa_perfil y el logo → solo /configuracion/perfil (módulo `configuracion`). Hace upsert
--     de la fila y `upload(…, {upsert:true})` del logo: necesitan INSERT y UPDATE.
--   · cotizacion_plantillas    → solo /cotizaciones/plantillas (módulo `cotizaciones`), update.
--   · el servidor usa service-role, que no pasa por RLS: no cambia nada.
-- LO QUE NO CAMBIA: leer. Los usuarios del ERP siguen leyendo las dos tablas; anon sigue leyendo
-- empresa_perfil (portal, login) y el logo (lectura pública del bucket). admin = todos los módulos.
-- Se revierte volviendo a crear la política FOR ALL `using (true) with check (true)` de cada tabla.
-- ═══════════════════════════════════════════════════════════════════════════

-- 0) Requisitos.
do $$ begin
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null then
    raise exception 'Antes de seguridad-04 hay que correr: traslados-01-tablas.sql (crea fn_puede_modulo)';
  end if;
  if to_regclass('public.empresa_perfil') is null or to_regclass('public.cotizacion_plantillas') is null then
    raise exception 'Faltan empresa_perfil o cotizacion_plantillas: no hay nada que proteger en esta base';
  end if;
end $$;

-- 1) Las dos tablas: se quitan TODAS sus políticas (la FOR ALL abierta y cualquier genérica de
--    seguridad-01) y se deja solo lo de abajo. Una permisiva olvidada anularía todo el archivo.
do $$
declare p record; t record; c text;
begin
  for p in select policyname, tablename from pg_policies
            where schemaname = 'public' and tablename in ('empresa_perfil', 'cotizacion_plantillas') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
  for t in select * from (values ('empresa_perfil', 'configuracion'), ('cotizacion_plantillas', 'cotizaciones')) v(tabla, modulo) loop
    execute format('alter table public.%I enable row level security', t.tabla);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t.tabla || '_leer', t.tabla);
    foreach c in array array['insert', 'update', 'delete'] loop
      execute format('create policy %I on public.%I for %s to authenticated %s',
        t.tabla || '_' || c, t.tabla, c,
        case c when 'insert' then format('with check (public.fn_puede_modulo(auth.uid(), %L))', t.modulo)
               when 'update' then format('using (public.fn_puede_modulo(auth.uid(), %L)) with check (public.fn_puede_modulo(auth.uid(), %L))', t.modulo, t.modulo)
               else format('using (public.fn_puede_modulo(auth.uid(), %L))', t.modulo) end);
    end loop;
  end loop;
end $$;
-- anon: solo lee el perfil (la política de siempre) y nada de las plantillas.
create policy empresa_perfil_lectura_publica on public.empresa_perfil for select to anon using (true);
revoke insert, update, delete, truncate on public.empresa_perfil from anon;
revoke all on public.cotizacion_plantillas from anon;

-- 2) El logo (bucket `empresa`): subir y reemplazar exige además el módulo `configuracion`. Mismos
--    nombres de política. La lectura pública («Lectura pública empresa») no se toca: el reemplazo
--    (upsert) necesita poder LEER el objeto, y esa política lo cubre.
drop policy if exists "Subida autenticada empresa" on storage.objects;
create policy "Subida autenticada empresa" on storage.objects for insert to authenticated
  with check (bucket_id = 'empresa' and public.fn_puede_modulo(auth.uid(), 'configuracion'));
drop policy if exists "Actualización autenticada empresa" on storage.objects;
create policy "Actualización autenticada empresa" on storage.objects for update to authenticated
  using (bucket_id = 'empresa' and public.fn_puede_modulo(auth.uid(), 'configuracion'))
  with check (bucket_id = 'empresa' and public.fn_puede_modulo(auth.uid(), 'configuracion'));

-- Comprobación (solo lee): las dos tablas con _leer + insert/update/delete con su módulo (y la de anon
-- en el perfil), y las políticas del bucket `empresa`. Ninguna escritura debe decir «true» a secas.
select tablename as tabla, policyname as politica, cmd, roles::text as roles,
       coalesce(qual, '—') as usando, coalesce(with_check, '—') as con_check
  from pg_policies
 where (schemaname = 'public' and tablename in ('empresa_perfil', 'cotizacion_plantillas'))
    or (schemaname = 'storage' and tablename = 'objects'
        and coalesce(qual, '') || coalesce(with_check, '') ~ 'bucket_id = ''empresa''')
 order by 1, 2;
-- FIN de seguridad-04-perfil-y-plantillas.sql
