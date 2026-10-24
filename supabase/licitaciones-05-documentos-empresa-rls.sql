-- licitaciones-05-documentos-empresa-rls.sql — Quién lee y escribe documentos_empresa (el legajo de la empresa y los
-- documentos de los conductores para licitar: DNI del representante, antecedentes, exámenes médicos, contratos, SST).
-- NO LA CORRE EL DEPLOY: Supabase → SQL Editor → pegar ENTERA → Run. Idempotente. No toca ninguna fila.
-- ORDEN: 01a → 01b → 02 → 03 → 04 → 05 (esta). Requiere 01b (fn_puede_modulo): si falta, se detiene sin cambiar nada.
-- POR QUÉ: la tabla tenía cinco políticas «todo permitido» para cualquier sesión del ERP (auditoría de seguridad del
-- módulo Licitaciones): quien no tiene ni /documentos ni /licitaciones podía leer, cambiar y borrar el legajo.
-- QUÉ DEJA: leer, crear, cambiar y borrar con el módulo «documentos» (la pantalla /documentos, toda la tabla) o con
-- «licitaciones» (solo las filas del legajo y de los conductores: alcance 'empresa' o 'conductor'). admin, todo
-- (fn_puede_modulo). anon: nada. ELIA lee con la service-role y filtra por módulo en el código: no cambia.
-- Se borran TODAS las políticas que hubiera en la tabla antes de crear las de aquí: una permisiva que quedara se
-- sumaría (las políticas se combinan con OR) y la volvería a abrir.
-- OJO: los ARCHIVOS que /documentos sube siguen yendo al bucket `documentos` (abierto a toda sesión del ERP); los
-- que sube /licitaciones (legajo y conductores) van al bucket privado `licitaciones` (03).

do $$ begin
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null then
    raise exception 'Antes de licitaciones-05 hay que correr: licitaciones-01b-rls.sql'; end if;
  if to_regclass('public.documentos_empresa') is null then
    raise exception 'No existe public.documentos_empresa: esta migración es para una base que ya la tiene.'; end if;
end $$;

do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'documentos_empresa' loop
    execute format('drop policy %I on public.documentos_empresa', p.policyname);
  end loop;
end $$;

-- (select …) alrededor de la función y de auth.uid(): se evalúa UNA vez por consulta, no por fila. El alcance se
-- mira en la fila (USING) y en la fila nueva (WITH CHECK): con «licitaciones» no se puede pasar una fila a otro alcance.
create policy documentos_empresa_leer on public.documentos_empresa for select to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'documentos'))
    or ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and alcance in ('empresa', 'conductor')));
create policy documentos_empresa_crear on public.documentos_empresa for insert to authenticated
  with check ((select public.fn_puede_modulo((select auth.uid()), 'documentos'))
    or ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and alcance in ('empresa', 'conductor')));
create policy documentos_empresa_cambiar on public.documentos_empresa for update to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'documentos'))
    or ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and alcance in ('empresa', 'conductor')))
  with check ((select public.fn_puede_modulo((select auth.uid()), 'documentos'))
    or ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and alcance in ('empresa', 'conductor')));
create policy documentos_empresa_borrar on public.documentos_empresa for delete to authenticated
  using ((select public.fn_puede_modulo((select auth.uid()), 'documentos'))
    or ((select public.fn_puede_modulo((select auth.uid()), 'licitaciones')) and alcance in ('empresa', 'conductor')));

alter table public.documentos_empresa enable row level security;
revoke all on public.documentos_empresa from anon;
revoke truncate on public.documentos_empresa from authenticated;   -- TRUNCATE no pasa por RLS

-- Verificación (solo lee). Debe salir: RLS true · 4 políticas (SELECT, INSERT, UPDATE, DELETE, todas «authenticated»)
-- · anon «ninguno» · authenticated SELECT, INSERT, UPDATE, DELETE (sin TRUNCATE).
select 'tabla' as que, 'documentos_empresa' as nombre, 'RLS ' || relrowsecurity || ' · políticas '
       || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'documentos_empresa') as detalle
  from pg_class where oid = 'public.documentos_empresa'::regclass
union all
select 'política', policyname, cmd || ' · ' || roles::text
  from pg_policies where schemaname = 'public' and tablename = 'documentos_empresa'
union all
select 'permiso ' || r, 'documentos_empresa', coalesce(string_agg(p, ', ' order by p)
         filter (where has_table_privilege(r, 'public.documentos_empresa', p)), 'ninguno')
  from unnest(array['anon', 'authenticated']) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p group by r
order by 1, 2;
-- FIN de licitaciones-05-documentos-empresa-rls.sql
