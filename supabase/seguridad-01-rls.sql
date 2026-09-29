-- ═══════════════════════════════════════════════════════════════════════════
-- seguridad-01-rls.sql · Cierra la base al rol ANÓNIMO.
-- (NO la corre el deploy: se ejecuta a mano en Supabase → SQL Editor.)
--
-- Responde a las alertas del Security Advisor de Supabase del 27-09-2026
-- (rls_disabled_in_public · sensitive_columns_exposed).
--
-- EL MODELO DE AMENAZA, en una línea: la anon key NO es un secreto. Va dentro del
-- JavaScript de transportesafa.com, así que "el rol anon" = cualquier persona de
-- internet. Todo lo que ese rol pueda leer, lo puede leer cualquiera, con un curl.
--
-- QUIÉN USA SUPABASE CON QUÉ ROL (y por qué esto no rompe nada):
--   · El ERP (usuarios con login de Supabase Auth) → rol `authenticated`.
--   · Portal del cliente, app del conductor, app del pasajero, seguimiento por
--     enlace, conformidades, proveedor → NO usan Supabase Auth: pasan por /api/*
--     con la service-role, que no mira RLS. Las lecturas anónimas directas que
--     quedaban (conductor/placa/GPS del portal, realtime del seguimiento) se
--     movieron a /api en el mismo cambio que trae este archivo.
--   · Lo ÚNICO que se deja legible para anon: `empresa_perfil` y
--     `paginas_legales` (logo, nombre y la política de privacidad pública).
--
-- QUÉ HACE, en cuatro pasos, todos idempotentes (se puede correr dos veces):
--   1. Toda tabla de `public` SIN RLS → se le activa, con una política
--      `<tabla>_authenticated` para el rol authenticated. Es exactamente lo que el
--      ERP podía hacer hasta hoy; lo que se pierde es solo el acceso anónimo.
--   2. Toda política que hoy aplica a `anon`/`public` SIN mirar la sesión
--      (`using (true)` sin `to authenticated`: crm_*, ordenes_compra*, …) → se
--      reasigna a `authenticated` con ALTER POLICY, sin tocar su expresión.
--   3. Las VISTAS de `public` corren con los permisos de su dueño y se saltan el
--      RLS de sus tablas: v_egresos, v_cuentas_por_pagar, v_utilidad_servicio…
--      eran legibles por anon. Se les quita el permiso a anon (REVOKE); el ERP
--      las sigue leyendo igual.
--   4. Las funciones SECURITY DEFINER también se saltan el RLS: se les quita el
--      EXECUTE a anon (y a PUBLIC, que lo incluye), y se le devuelve explícito a
--      authenticated y service_role para no cambiar nada del ERP. Los triggers no
--      necesitan ese permiso para dispararse.
--
-- ANTES de correrlo: corre seguridad-00-diagnostico.sql y guarda el resultado.
-- DESPUÉS: vuelve a correr el diagnóstico — las secciones 1, 2 y 5 deben salir
-- vacías (salvo las dos tablas públicas a propósito) y Security Advisor → Rerun.
--
-- CÓMO SE REVIERTE una tabla puntual si algo dejara de verse:
--   alter table public.<tabla> disable row level security;
-- (y avisar: significaría que alguna pantalla pública sigue leyendo directo).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. RLS en toda tabla de public que no lo tenga ───────────────────────────
do $$
declare t text;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = t
                      and policyname = t || '_authenticated') then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated', t);
    end if;
    raise notice 'RLS activado: % (acceso solo para usuarios del ERP)', t;
  end loop;
end $$;

-- ── 2. Políticas abiertas a anon/public que no miran la sesión → authenticated ─
do $$
declare p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and ('anon' = any(roles) or 'public' = any(roles))
       and tablename not in ('empresa_perfil', 'paginas_legales')
       and coalesce(qual, '') || ' ' || coalesce(with_check, '')
           !~* '(auth\.uid|auth\.role|auth\.jwt|authenticated|fn_es_|puede_|es_admin)'
  loop
    execute format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
    raise notice 'Política cerrada a anon: %.%', p.tablename, p.policyname;
  end loop;
end $$;

-- Lo público a propósito: solo LECTURA, y solo estas dos tablas.
do $$
declare t text;
begin
  foreach t in array array['empresa_perfil', 'paginas_legales'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename = t and policyname = t || '_lectura_publica') then
      execute format('create policy %I on public.%I for select to anon using (true)',
                     t || '_lectura_publica', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename = t and policyname = t || '_authenticated') then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated', t);
    end if;
  end loop;
end $$;

-- Cualquier otra política de esas dos tablas que dejara ESCRIBIR a anon se cierra.
do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('empresa_perfil', 'paginas_legales')
       and ('anon' = any(roles) or 'public' = any(roles))
       and cmd <> 'SELECT'
  loop
    execute format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
    raise notice 'Escritura anónima cerrada: %.%', p.tablename, p.policyname;
  end loop;
end $$;

-- ── 3. Vistas: anon no lee ninguna ───────────────────────────────────────────
do $$
declare v text;
begin
  for v in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v','m')
  loop
    execute format('revoke all on public.%I from anon', v);
  end loop;
end $$;
-- Las vistas que se creen A FUTURO nacen con el grant por defecto de Supabase: al crear
-- una, termina el SQL con `revoke all on public.<vista> from anon;` (o vuelve a correr este
-- archivo). La sección 3 de seguridad-00-diagnostico.sql las lista.

-- ── 4. Funciones SECURITY DEFINER: anon no las ejecuta ───────────────────────
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon', f.firma);
    execute format('grant execute on function %s to authenticated, service_role', f.firma);
  end loop;
end $$;
