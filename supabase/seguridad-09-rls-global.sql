-- ═══════════════════════════════════════════════════════════════════════════════
-- seguridad-09-rls-global.sql — CERRAR LA PUERTA DE CALLE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Responde a los dos avisos CRÍTICOS del asesor de seguridad de Supabase:
--   • rls_disabled_in_public      — tablas sin Row Level Security
--   • columnas_sensibles_expuestas — PII legible por la API sin restricción
--
-- ── EL PROBLEMA, EN UNA FRASE ────────────────────────────────────────────────
-- La clave ANON viaja en el bundle de JavaScript: es PÚBLICA por diseño (cualquiera
-- abre las DevTools y la copia). Lo único que separa esa clave de la base de datos
-- es RLS. Con RLS apagado, la clave anon es una llave maestra: se leen y se ESCRIBEN
-- todas las tablas desde cualquier consola del mundo, sin iniciar sesión.
--
-- Concretamente, hoy y sin autenticarse, cualquiera puede:
--   • volcar `pasajeros` (nombre + DNI), `conductores` (DNI, teléfono, pin_acceso),
--     `portal_usuarios` (codigo_acceso en claro) y toda la contabilidad;
--   • seguir cualquier bus en vivo leyendo `ubicaciones_gps`;
--   • y lo más grave: `update usuarios set rol='admin'` sobre su propia fila, o un
--     upsert en `permisos_usuario`. La app escribe esas dos tablas DESDE EL NAVEGADOR
--     (app/usuarios/page.tsx:287,292), así que el permiso del menú no protege nada:
--     es una escalada de privilegios de una sola línea.
--
-- ── LA REGLA DE ORO DE ESTE ARCHIVO ──────────────────────────────────────────
-- El gate de módulos de `app/layout.tsx` es UI: sirve para no mostrar botones, NO
-- para autorizar. La autorización de verdad son dos capas y ambas son obligatorias:
--   1) Postgres decide QUIÉN toca QUÉ  ← este archivo
--   2) el servidor re-verifica el módulo en las rutas API (lib/api-auth.ts)
--
-- ── QUÉ HACE, EXACTAMENTE ────────────────────────────────────────────────────
--   1. Helpers `fn_es_admin()` / `fn_usuario_activo()` (SECURITY DEFINER: sin ellos
--      una política sobre `usuarios` que consulte `usuarios` recursa infinitamente).
--   2. Corta `anon` a nivel de PERMISO (grants), no solo de política.
--   3. Enciende RLS + política base `authenticated` en toda tabla que HOY la tenga
--      apagada.
--   4. Blinda las tablas de identidad (`usuarios`, `permisos_usuario`): leer sí,
--      escribir solo admin. Aquí muere la escalada de privilegios.
--   5. Pone las vistas en `security_invoker` (una vista normal corre con los
--      permisos de su DUEÑO y por eso se salta el RLS de las tablas que consulta).
--   6. Devuelve una tabla de verificación al final.
--
-- ── LO QUE ESTE ARCHIVO NO ROMPE (verificado contra el código) ────────────────
--   • El ERP web: todas sus páginas consultan como `authenticated` (sesión Supabase).
--     La política base les da exactamente el acceso que ya tenían.
--   • La app del conductor (/conductor) y el portal del proveedor: 0 consultas
--     directas, todo pasa por /api/* con service_role, que se salta RLS por diseño.
--   • El portal del cliente (/cliente): sus últimas lecturas anon se portaron a
--     /api/cliente y /api/cliente/gps en este mismo cambio.
--   • /privacidad y el branding del login: `empresa_perfil` y `paginas_legales`
--     siguen siendo legibles por anon — son contenido público a propósito.
--
-- ── IDEMPOTENTE ──────────────────────────────────────────────────────────────
-- Se puede correr las veces que haga falta. Solo toca tablas con RLS APAGADO, así
-- que jamás pisa una política afinada a mano ni ensancha una que ya exista.
--
-- CÓMO CORRERLO: Supabase → SQL Editor → pegar todo → Run.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. HELPERS DE IDENTIDAD ──────────────────────────────────────────────────
-- SECURITY DEFINER a propósito: corren como su dueño y por lo tanto SE SALTAN el
-- RLS de `usuarios`. Eso es lo que evita la recursión infinita cuando la política
-- de `usuarios` necesita saber si el que consulta es admin. `search_path` fijo para
-- que nadie los secuestre con una tabla `usuarios` en un esquema propio.

create or replace function public.fn_es_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid()
      and u.rol = 'admin'
      and coalesce(u.activo, true)
  );
$$;

comment on function public.fn_es_admin() is
  'true si el usuario de la sesión es admin y está activo. SECURITY DEFINER para no recursar sobre el RLS de usuarios.';

create or replace function public.fn_usuario_activo()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid()
      and coalesce(u.activo, true)
  );
$$;

comment on function public.fn_usuario_activo() is
  'true si el usuario de la sesión existe en `usuarios` y no fue dado de baja.';

revoke all on function public.fn_es_admin()       from public, anon;
revoke all on function public.fn_usuario_activo() from public, anon;
grant execute on function public.fn_es_admin()       to authenticated, service_role;
grant execute on function public.fn_usuario_activo() to authenticated, service_role;


-- ─── 2. CORTAR `anon` A NIVEL DE PERMISO ──────────────────────────────────────
-- Segunda línea de defensa, independiente del RLS: aunque mañana alguien cree una
-- tabla y olvide encenderle RLS, `anon` no tendrá el GRANT para tocarla.
-- (`usage` sobre el esquema se conserva: PostgREST lo necesita para responder,
--  y el login vive en el esquema `auth`, que este bloque no toca.)

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- …y que los futuros objetos nazcan igual de cerrados.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- Excepción deliberada: contenido PÚBLICO de verdad.
-- `empresa_perfil`  → logo/colores/teléfono que pinta el login y el portal antes de autenticar.
-- `paginas_legales` → los textos de /privacidad (obligatorio que sean públicos).
--
-- OJO — HACEN FALTA LAS DOS COSAS, grant Y política. Son controles independientes y se
-- aplican en cascada: el grant deja pasar por la puerta, la política decide qué filas se
-- ven. Con el grant a secas y RLS encendido, `anon` no recibe un error: recibe CERO FILAS
-- en silencio, y el login se queda sin logo sin que nada se queje. (Este archivo tuvo ese
-- bug hasta que se probó contra un Postgres real; de ahí el énfasis.)
do $$
declare t text;
begin
  foreach t in array array['empresa_perfil', 'paginas_legales'] loop
    if to_regclass('public.' || t) is null then
      raise notice '[seguridad-09] `%` no existe; se omite su apertura pública', t;
      continue;
    end if;

    execute format('grant select on public.%I to anon', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "rls09_publico_leer" on public.%I', t);
    execute format($f$
      create policy "rls09_publico_leer" on public.%I
        for select to anon, authenticated using (true)
    $f$, t);
  end loop;
end $$;


-- ─── 3. RLS + POLÍTICA BASE EN TODA TABLA QUE HOY LA TENGA APAGADA ────────────
-- Criterio: se toca SOLO `relrowsecurity = false`. Una tabla que ya tiene RLS
-- encendido tiene detrás una decisión (fase 06, radar, secuencias…) y las políticas
-- son PERMISIVAS — se combinan con OR — así que añadirle una base `using (true)`
-- ENSANCHARÍA lo que alguien cerró a propósito. Por eso no se la añadimos.
--
-- La política base concede a `authenticated` lo mismo que la app ya tenía de facto.
-- No sustituye la autorización por módulo: la hace el servidor (lib/api-auth.ts) y
-- el gate del layout. Lo que sí hace, y es el objetivo de este archivo, es que la
-- clave anon deje de ser una llave maestra.
--
-- `usuarios` y `permisos_usuario` se excluyen: llevan política propia en el paso 4.

do $$
declare
  r         record;
  n_rls     int := 0;
  n_pol     int := 0;
  -- `empresa_perfil` y `paginas_legales` ya quedaron resueltas en el paso 2 (RLS + política
  -- para anon). El filtro `relrowsecurity = false` de abajo ya las descarta, pero se listan
  -- explícitamente para que la intención se lea sin tener que deducirla.
  excluidas text[] := array['usuarios', 'permisos_usuario', 'empresa_perfil', 'paginas_legales'];
begin
  for r in
    select c.relname as tabla
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'              -- solo tablas base (las vistas van en el paso 5)
      and c.relrowsecurity = false     -- ← solo lo que hoy está abierto
      and not (c.relname = any (excluidas))
    order by c.relname
  loop
    execute format('alter table public.%I enable row level security', r.tabla);
    n_rls := n_rls + 1;

    -- Cinturón: si la tabla estuviera sin RLS pero CON políticas viejas, no la pisamos.
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = r.tabla
    ) then
      execute format($f$
        create policy "rls09_operador_erp" on public.%I
          for all
          to authenticated
          using (true)
          with check (true)
      $f$, r.tabla);
      n_pol := n_pol + 1;
    end if;
  end loop;

  raise notice '[seguridad-09] RLS encendido en % tablas; % políticas base creadas', n_rls, n_pol;
end $$;


-- ─── 4. TABLAS DE IDENTIDAD: AQUÍ MUERE LA ESCALADA DE PRIVILEGIOS ────────────
-- Estas dos son la corona: quien las escribe, se da a sí mismo cualquier otro
-- permiso. La app las lee desde el navegador (el layout resuelve el menú con ellas),
-- así que LEER sigue abierto a cualquier operador autenticado; ESCRIBIR pasa a ser
-- exclusivo de admin. `app/usuarios/page.tsx` sigue funcionando igual para un admin,
-- y para cualquier otro deja de ser un botón de auto-ascenso.

-- 4.a `usuarios`
do $$
begin
  if to_regclass('public.usuarios') is null then
    raise notice '[seguridad-09] `usuarios` no existe; se omite su blindaje';
    return;
  end if;

  execute 'alter table public.usuarios enable row level security';

  -- Se reemplazan por nombre para que el archivo sea re-ejecutable.
  execute 'drop policy if exists "rls09_usuarios_leer"     on public.usuarios';
  execute 'drop policy if exists "rls09_usuarios_escribir" on public.usuarios';
  execute 'drop policy if exists "rls09_operador_erp"      on public.usuarios';

  -- Leer: cualquier operador autenticado (el ERP muestra "creado por", listas de
  -- responsables, el nombre en la barra superior…).
  execute $p$
    create policy "rls09_usuarios_leer" on public.usuarios
      for select to authenticated using (true)
  $p$;

  -- Escribir: SOLO admin. Cubre insert/update/delete de una vez.
  execute $p$
    create policy "rls09_usuarios_escribir" on public.usuarios
      for all to authenticated
      using (public.fn_es_admin())
      with check (public.fn_es_admin())
  $p$;
end $$;

-- 4.b `permisos_usuario`
do $$
begin
  if to_regclass('public.permisos_usuario') is null then
    raise notice '[seguridad-09] `permisos_usuario` no existe; se omite su blindaje';
    return;
  end if;

  execute 'alter table public.permisos_usuario enable row level security';

  execute 'drop policy if exists "rls09_permisos_leer"     on public.permisos_usuario';
  execute 'drop policy if exists "rls09_permisos_escribir" on public.permisos_usuario';
  execute 'drop policy if exists "rls09_operador_erp"      on public.permisos_usuario';

  -- Leer: los PROPIOS permisos (lo que necesita el layout en cada navegación) o
  -- todos, si es admin (lo que necesita la matriz de /usuarios).
  execute $p$
    create policy "rls09_permisos_leer" on public.permisos_usuario
      for select to authenticated
      using (usuario_id = auth.uid() or public.fn_es_admin())
  $p$;

  -- Escribir: SOLO admin. Sin esto, cualquiera se concede cualquier módulo.
  execute $p$
    create policy "rls09_permisos_escribir" on public.permisos_usuario
      for all to authenticated
      using (public.fn_es_admin())
      with check (public.fn_es_admin())
  $p$;
end $$;


-- ─── 5. VISTAS: `security_invoker` ────────────────────────────────────────────
-- Una vista de Postgres corre, por omisión, con los permisos de SU DUEÑO. Como aquí
-- el dueño es el rol de servicio, la vista SE SALTA el RLS de las tablas que lee: sin
-- este paso, `v_egresos` o `v_cuentas_por_pagar` serían un túnel alrededor de todo lo
-- anterior. `security_invoker = on` hace que la vista aplique el RLS de QUIEN consulta.
-- (Requiere PG15+; Supabase lo cumple. Si alguna vista falla, se avisa y se sigue.)

do $$
declare
  r     record;
  n_ok  int := 0;
  n_err int := 0;
begin
  for r in
    select c.relname as vista
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
    order by c.relname
  loop
    begin
      if r.vista like 'v_%' or r.vista in ('grupos_con_stats', 'reservas_ocupacion', 'resumen_erp') then
        execute format('alter view public.%I set (security_invoker = on)', r.vista);
        n_ok := n_ok + 1;
      end if;
    exception when others then
      -- Una vista materializada no acepta la opción, y alguna vista puede no ser
      -- alterable. Se registra y se sigue: no vale abortar la migración por eso.
      n_err := n_err + 1;
      raise notice '[seguridad-09] vista % sin security_invoker (%): revísala a mano', r.vista, sqlerrm;
    end;
  end loop;

  raise notice '[seguridad-09] % vistas en security_invoker (% omitidas)', n_ok, n_err;
end $$;


-- ─── 6. VERIFICACIÓN ──────────────────────────────────────────────────────────
-- Debe devolver CERO filas. Cada fila es una tabla que sigue abierta al mundo.

select
  c.relname                                    as tabla_sin_rls,
  '⚠ sigue expuesta a la clave anon'           as diagnostico
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false
order by c.relname;
