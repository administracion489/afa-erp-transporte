-- traslados-06-rls-crm-ia.sql — Quién LEE y quién ESCRIBE las acciones y la configuración del agente IA del CRM.
-- NO la corre el deploy: Supabase → SQL Editor → pegar ENTERA → Run. Idempotente (se puede correr dos veces).
-- Requiere crm-agente-ia.sql y public.fn_puede_modulo (traslados-01 o seguros-05); si falta algo, se detiene
-- nombrándolo y NO cambia nada. Independiente de traslados-05 (antes o después da igual).
--
-- POR QUÉ (auditoría de la fase 2 de traslados): la IA del CRM cotiza y ENVÍA el PDF por WhatsApp desde el
-- número oficial, y el envío confía en la fila de crm_acciones_ia (a qué cotización apunta, si está pendiente).
-- Las dos tablas tenían «for all to authenticated using (true)»: cualquier sesión del ERP, sin el módulo crm,
--  · podía apuntar una acción a OTRA cotización (o fabricar una) y hacer que el número oficial enviara ese PDF.
--    Ninguna pantalla escribe crm_acciones_ia: la escriben lib/crm-ia.ts, lib/traslados/* y /api/crm/ia/accion
--    con service-role. Queda: LEER solo con el módulo crm (la Bandeja y su realtime); ESCRIBIR solo service-role.
--  · podía cambiar en crm_agentes_ia la FIRMA que se agrega a cada mensaje de la IA, sus instrucciones y el
--    mensaje de derivación. Queda: LEER cualquier usuario del ERP (/tarifario → Ajustes muestra si el agente
--    está activo con el módulo tarifas); ESCRIBIR solo con el módulo crm o admin (quien entra a /crm/agente).
-- Se borran TODAS las políticas de estas dos tablas, no solo las dos conocidas: una permisiva que quedara de un
-- SQL suelto se sumaría con OR y dejaría el hueco abierto. El SELECT final lista lo que quedó.
-- Para quien usa el CRM con su módulo NO cambia nada. Sin esta migración la app funciona igual y el hueco sigue.
--
-- fn_puede_modulo NO se vuelve a crear aquí, a propósito: ya hay tres copias (seguros-05, traslados-01 y -04), y
-- una cuarta, corrida otra vez dentro de un año, devolvería la función a esta versión aunque alguien la cambie.
-- En producción ya existe; si no, el paso 0 se detiene nombrando el archivo que la crea.

-- 0) Requisitos (y que authenticated pueda ejecutar la función: sin eso, la Bandeja del CRM dejaría de leer).
do $$ declare f text := ''; begin
  if to_regclass('public.crm_acciones_ia') is null or to_regclass('public.crm_agentes_ia') is null then
    f := f || ' crm-agente-ia.sql';
  end if;
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null then
    f := f || ' traslados-01-tablas.sql (crea public.fn_puede_modulo)';
  elsif not has_function_privilege('authenticated', 'public.fn_puede_modulo(uuid,text)', 'execute') then
    f := f || ' traslados-01-tablas.sql (da a authenticated el permiso de ejecutar public.fn_puede_modulo)';
  end if;
  if f <> '' then raise exception 'Antes de traslados-06 hay que correr:%', f; end if;
end $$;

-- 1) RLS encendido y TODAS las políticas de las dos tablas fuera (las nuevas se crean abajo, en la misma corrida).
alter table public.crm_acciones_ia enable row level security;
alter table public.crm_agentes_ia  enable row level security;
do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename in ('crm_acciones_ia', 'crm_agentes_ia') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- 2) crm_acciones_ia: leer con el módulo crm; escribir nadie desde el navegador (sin política y sin el permiso).
--    service-role no mira RLS ni estos permisos: el agente, el envío del PDF y /api/crm/ia/accion siguen igual.
--    (select …) evalúa el permiso UNA vez por consulta, no una por fila.
create policy crm_acciones_leer on public.crm_acciones_ia for select to authenticated
  using ((select public.fn_puede_modulo(auth.uid(), 'crm')));
revoke insert, update, delete, truncate on public.crm_acciones_ia from anon, authenticated;
revoke all on public.crm_acciones_ia from anon;

-- 3) crm_agentes_ia: leer cualquier usuario del ERP; crear, editar y borrar solo con el módulo crm (o admin).
create policy crm_agentes_leer on public.crm_agentes_ia for select to authenticated using (true);
create policy crm_agentes_crear on public.crm_agentes_ia for insert to authenticated
  with check ((select public.fn_puede_modulo(auth.uid(), 'crm')));
create policy crm_agentes_editar on public.crm_agentes_ia for update to authenticated
  using ((select public.fn_puede_modulo(auth.uid(), 'crm')))
  with check ((select public.fn_puede_modulo(auth.uid(), 'crm')));
create policy crm_agentes_borrar on public.crm_agentes_ia for delete to authenticated
  using ((select public.fn_puede_modulo(auth.uid(), 'crm')));
revoke truncate on public.crm_agentes_ia from authenticated;  -- TRUNCATE no pasa por RLS.
revoke all on public.crm_agentes_ia from anon;

-- 4) Verificación (solo lee). Deben salir 5 políticas (crm_acciones_leer y las 4 de crm_agentes) y los permisos:
--    anon «ninguno» en las dos; authenticated SELECT en crm_acciones_ia y DELETE, INSERT, SELECT, UPDATE en
--    crm_agentes_ia. Desde la app, con un usuario SIN el módulo crm: leer crm_acciones_ia devuelve 0 filas,
--    escribirla da «permission denied», y un update a crm_agentes_ia cambia 0 filas.
select 'política' as que, tablename::text as tabla,
       policyname || ' · ' || cmd || ' · ' || array_to_string(roles, ',') as detalle,
       concat_ws(' · ', 'using ' || qual, 'check ' || with_check) as condicion
  from pg_policies where schemaname = 'public' and tablename in ('crm_acciones_ia', 'crm_agentes_ia')
union all
select 'permiso', t, r,
       coalesce(string_agg(p, ', ' order by p) filter (where has_table_privilege(r, 'public.' || t, p)), 'ninguno')
  from unnest(array['crm_acciones_ia', 'crm_agentes_ia']) t, unnest(array['anon', 'authenticated']) r,
       unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
 group by t, r
 order by 1 desc, 2, 3;
-- FIN de traslados-06-rls-crm-ia.sql
