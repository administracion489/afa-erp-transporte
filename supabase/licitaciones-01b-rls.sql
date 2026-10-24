-- licitaciones-01b-rls.sql — Quién lee y escribe las tablas del módulo Licitaciones: SOLO quien tiene el módulo
-- «licitaciones» (o es admin), también para LEER. Las bases, la experiencia y lo presentado son comerciales.
-- NO LA CORRE EL DEPLOY: Supabase → SQL Editor → pegar ENTERA → Run. Idempotente.
-- ORDEN: 01a → 01b (esta) → 02-experiencia → 03-bucket → 04-columnas-accesorias. Requiere 01a: si falta, se
-- detiene nombrándola y NO cambia nada. SIN ESTA: las tablas de 01a siguen con RLS y sin políticas (nadie lee).
-- QUÉ DEJA: licitaciones → leer y escribir con el módulo (el guardado es un UPDATE con bloqueo por version).
-- licitacion_analisis → solo LEER con el módulo; la escribe el servidor (service-role, que no mira RLS).
-- licitacion_emisiones → leer y REGISTRAR con el módulo, y solo a nombre propio (emitido_por = la sesión);
-- SIN UPDATE NI DELETE: una emisión es la constancia de lo presentado y no se reescribe. anon: nada.
-- Se borran TODAS las políticas que hubiera en las tres tablas antes de crear las de aquí: una política permisiva
-- creada a mano desde el panel se sumaría (las políticas se combinan con OR) y abriría la tabla.

do $$ begin
  if to_regclass('public.licitaciones') is null or to_regclass('public.licitacion_analisis') is null
     or to_regclass('public.licitacion_emisiones') is null then
    raise exception 'Antes de licitaciones-01b hay que correr: licitaciones-01a-tablas.sql'; end if;
end $$;

-- La misma función que seguros-05 y traslados-01 (cuerpo idéntico): reafirmarla no cambia nada si ya existe.
create or replace function public.fn_puede_modulo(p_uid uuid, p_modulo text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
     where u.id = p_uid and coalesce(u.activo, true) = true
       and (u.rol = 'admin'
            or exists (select 1 from public.permisos_usuario pu
                        where pu.usuario_id = p_uid and pu.modulo = p_modulo
                          and pu.permitido = true))
  );
$$;
revoke all on function public.fn_puede_modulo(uuid, text) from public, anon;
grant execute on function public.fn_puede_modulo(uuid, text) to authenticated;

do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public'
            and tablename in ('licitaciones', 'licitacion_analisis', 'licitacion_emisiones') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- (select …) alrededor de la función y de auth.uid(): se evalúa UNA vez por consulta, no por fila.
create policy licitaciones_modulo on public.licitaciones for all to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')))
  with check ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')));
create policy licitacion_analisis_leer on public.licitacion_analisis for select to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')));
create policy licitacion_emisiones_leer on public.licitacion_emisiones for select to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')));
-- El trigger de 01a pone emitido_por = auth.uid() ANTES de que se mire este WITH CHECK.
create policy licitacion_emisiones_registrar on public.licitacion_emisiones for insert to authenticated
  with check ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and emitido_por = (select auth.uid()));

alter table public.licitaciones enable row level security;
alter table public.licitacion_analisis enable row level security;
alter table public.licitacion_emisiones enable row level security;
revoke all on public.licitaciones, public.licitacion_analisis, public.licitacion_emisiones from anon;
-- Además de no tener política, sin el permiso de tabla (TRUNCATE no pasa por RLS).
revoke truncate on public.licitaciones from authenticated;
revoke insert, update, delete, truncate on public.licitacion_analisis from authenticated;
revoke update, delete, truncate on public.licitacion_emisiones from authenticated;

-- Verificación (solo lee). Debe salir: 4 políticas (licitaciones ALL · analisis SELECT · emisiones SELECT e INSERT),
-- anon «ninguno» en las tres, y authenticated: licitaciones S/I/U/D · analisis solo SELECT · emisiones SELECT, INSERT.
select 'política' as que, tablename || ' · ' || policyname as nombre, cmd || ' · ' || roles::text as detalle
  from pg_policies where schemaname = 'public' and tablename in ('licitaciones', 'licitacion_analisis', 'licitacion_emisiones')
union all
select 'permiso ' || r, t, coalesce(string_agg(p, ', ' order by p) filter (where has_table_privilege(r, 'public.' || t, p)), 'ninguno')
  from unnest(array['anon', 'authenticated']) r, unnest(array['licitaciones', 'licitacion_analisis', 'licitacion_emisiones']) t,
       unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p group by r, t
union all
select 'función', 'fn_puede_modulo', 'anon ejecuta ' || has_function_privilege('anon', 'public.fn_puede_modulo(uuid,text)', 'execute')
       || ' (debe: false) · authenticated ejecuta ' || has_function_privilege('authenticated', 'public.fn_puede_modulo(uuid,text)', 'execute')
order by 1, 2;
-- FIN de licitaciones-01b-rls.sql
