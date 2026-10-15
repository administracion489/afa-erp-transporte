-- ══════════════════════════════════════════════════════════════════════════════
-- RRHH · FASE 01 — Perfil del empleado + Asistencia (marcación) + Ausencias
--
-- QUÉ HACE: pone los cimientos del módulo de Control de Personal.
--   · conductores.usuario_id  — el PUENTE que faltaba: un conductor que además es
--       usuario del ERP (login de Supabase Auth) se ata a su usuarios.id. Sin él la
--       RLS de este módulo no puede reconocer a un conductor que entra a ver su perfil,
--       así que por defecto no vería nada (deny-by-default seguro). Lo puebla el backend.
--   · empleado_perfil   — la ficha del empleado que ÉL MISMO edita (foto, datos de
--       contacto, contacto de emergencia) + los campos que solo escribe el backend
--       (consentimientos biométrico/monitoreo, si debe marcar asistencia). SIN correo
--       ni sueldo: esos viven en usuarios / personal_administrativo / conductores.
--   · rrhh_config       — fila única con la sede (lat/lng/radio), el horario, la
--       tolerancia y si la geocerca BLOQUEA o solo avisa.
--   · rrhh_marca        — cada marcación de entrada/almuerzo/salida, con su foto, su
--       ubicación y si cayó dentro de la geocerca.
--   · rrhh_ausencia     — vacaciones / permisos / descansos médicos / faltas, con su
--       documento de respaldo y su flujo de aprobación.
--   · fn_es_rrhh(uid)   — helper: ¿este usuario es de RRHH? (admin, o permiso 'rrhh').
--
-- POR QUÉ: cada persona ve y edita SOLO su propia ficha; RRHH (y admin) ve todo. Se usa
-- la RLS POR FILA PROPIA (misma idea que comisiones-04): hasta hoy el ERP filtraba solo
-- por módulo, y aquí un empleado no-privilegiado tiene que poder leer lo suyo sin ver lo
-- de los demás. La ESCRITURA de todo lo sensible (marcas, consentimientos, config) no
-- tiene política: solo el service-role escribe, desde /api/* que valida identidad y
-- geocerca en el servidor — un cliente con la anon key no puede fabricar una marcación.
--
-- SI NO SE CORRE: no existe el perfil del empleado ni la marcación de asistencia; las
-- pantallas de /mi-perfil y /rrhh se comportan como si las columnas no existieran. No
-- toca nada de lo ya desplegado (solo AGREGA una columna nullable a conductores).
--
-- Reusa (NO recrea): usuarios (PK = auth.uid(), uuid; rol, activo), conductores,
--   personal_administrativo (usuario_id desde comisiones-03), permisos_usuario
--   (usuario_id, modulo, permitido; único (usuario_id, modulo)), fn_es_aprobador.
-- Requiere: finanzas-06 (fn_es_aprobador), comisiones-03 (personal_administrativo.usuario_id).
-- Idempotente (se puede correr dos veces). EL DEPLOY NO LO CORRE: se ejecuta a mano en
-- Supabase → SQL Editor. Reversión al pie.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) PUENTE conductor ↔ usuario. Nullable: un conductor puede no tener login. El
--    backend lo puebla cuando el conductor es también usuario del ERP. Sin este dato
--    la RLS no reconoce al conductor y no le muestra nada (lado seguro).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.conductores
  add column if not exists usuario_id uuid references public.usuarios(id);

create index if not exists idx_conductores_usuario
  on public.conductores (usuario_id);

comment on column public.conductores.usuario_id is
  'Puente al usuarios.id (login) cuando el conductor es usuario del ERP. Nullable; lo '
  'puebla el backend. Usado por la RLS de RRHH para que el conductor vea SOLO lo suyo.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) PERFIL DEL EMPLEADO. PK = usuario_id (una ficha por usuario). Dos clases de campo:
--    · AUTOEDITABLES por el dueño de la fila (foto, contacto, emergencia).
--    · SOLO-BACKEND (consentimientos, marca_asistencia): nadie los toca desde el cliente.
--    NO lleva correo ni sueldo: fuente única en usuarios / personal_administrativo /
--    conductores (regla de oro: un dato, una fila autoritativa).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.empleado_perfil (
  usuario_id                     uuid primary key
                                 references public.usuarios(id) on delete cascade,
  -- Autoeditables por el dueño de la fila:
  foto_url                       text,
  fecha_nacimiento               date,
  telefono_personal              text,
  direccion                      text,
  contacto_emergencia_nombre     text,
  contacto_emergencia_telefono   text,
  contacto_emergencia_parentesco text,
  -- Solo-backend (service-role):
  consentimiento_biometrico_en      timestamptz,
  consentimiento_biometrico_version text,
  consentimiento_monitoreo_en       timestamptz,
  consentimiento_monitoreo_version  text,
  marca_asistencia                  boolean default false,
  updated_at                        timestamptz default now()
);

comment on table public.empleado_perfil is
  'Ficha del empleado. foto_url y los datos de contacto/emergencia los edita el dueño '
  'de la fila; consentimientos y marca_asistencia solo el backend. Sin correo ni sueldo.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) CONFIG de RRHH — fila única (id=1). La sede nace SIN coordenadas: la geocerca no
--    puede bloquear hasta que alguien declare dónde está la sede (lado seguro). Por eso
--    geocerca_bloquea nace en false: correr este SQL no cambia el comportamiento de
--    nadie hasta que RRHH lo decida.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.rrhh_config (
  id               int primary key default 1 check (id = 1),
  sede_lat         double precision,
  sede_lng         double precision,
  sede_radio_m     int     default 150,
  hora_entrada     time    default '08:00',
  hora_salida      time    default '18:00',
  tolerancia_min   int     default 10,
  almuerzo_min     int     default 60,
  geocerca_bloquea boolean default false,
  updated_at       timestamptz default now()
);

insert into public.rrhh_config (id) values (1) on conflict do nothing;

comment on table public.rrhh_config is
  'Fila única (id=1). Sede sin coordenadas sembradas y geocerca_bloquea=false: correr '
  'este SQL no bloquea a nadie hasta que RRHH configure la sede.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) MARCA de asistencia. Una fila por fichaje. La geocerca y la detección de rostro se
--    evalúan en el SERVIDOR y se graban aquí (dentro_geocerca, distancia_m,
--    rostro_detectado): el cliente no puede afirmar que estuvo en la sede. La foto va al
--    bucket PRIVADO `rrhh` (ver nota al pie); foto_url guarda su ruta/enlace.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.rrhh_marca (
  id               bigserial primary key,
  usuario_id       uuid not null references public.usuarios(id),
  tipo             text not null
                   check (tipo in ('entrada','salida_almuerzo','regreso_almuerzo','salida')),
  marcado_en       timestamptz default now(),
  lat              double precision,
  lng              double precision,
  precision_m      numeric,
  dentro_geocerca  boolean,
  distancia_m      numeric,
  foto_url         text,
  rostro_detectado boolean,
  metodo           text check (metodo in ('facial','pin','manual_rrhh')),
  origen           text default 'web'
);

create index if not exists idx_rrhh_marca_usuario
  on public.rrhh_marca (usuario_id, marcado_en);

comment on table public.rrhh_marca is
  'Fichaje de asistencia. dentro_geocerca / distancia_m / rostro_detectado los calcula '
  'el servidor, no el cliente. foto_url → bucket privado rrhh.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) AUSENCIA. Vacaciones, permisos, descansos médicos, licencias, faltas, suspensiones.
--    Flujo de aprobación (solicitada → aprobada|rechazada). El documento de respaldo
--    (descanso médico, licencia) va al bucket privado `rrhh`; documento_url es su ruta.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.rrhh_ausencia (
  id            bigserial primary key,
  usuario_id    uuid not null references public.usuarios(id),
  tipo          text check (tipo in ('vacaciones','permiso','descanso_medico','licencia','falta','suspension')),
  desde         date,
  hasta         date,
  goce          boolean,
  motivo        text,
  documento_url text,
  aprobado_por  uuid,
  aprobado_en   timestamptz,
  estado        text default 'solicitada'
                check (estado in ('solicitada','aprobada','rechazada')),
  created_at    timestamptz default now()
);

create index if not exists idx_rrhh_ausencia_usuario
  on public.rrhh_ausencia (usuario_id, desde);

comment on table public.rrhh_ausencia is
  'Ausencias con flujo solicitada→aprobada|rechazada. documento_url → bucket privado rrhh.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6) HELPER fn_es_rrhh(uid): ¿es personal de RRHH? admin (usuarios.rol), o permiso
--    'rrhh'. security definer + search_path fijo para leer usuarios/permisos_usuario sin
--    depender del RLS del llamante (igual que fn_es_aprobador). No mira al gerente a
--    propósito: ver la ficha y la asistencia de todos es un permiso de RRHH, no de quien
--    aprueba gasto. Se exige el usuario ACTIVO.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_es_rrhh(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
     where u.id = p_uid
       and coalesce(u.activo, true) = true
       and (
         u.rol = 'admin'
         or exists (
           select 1 from public.permisos_usuario p
            where p.usuario_id = u.id
              and p.modulo     = 'rrhh'
              and p.permitido  = true
         )
       )
  );
$$;

-- anon no la ejecuta (la anon key es pública); authenticated sí, para la RLS; service_role
-- también. Idempotente y alineado con seguridad-01 (paso 4).
revoke execute on function public.fn_es_rrhh(uuid) from public, anon;
grant  execute on function public.fn_es_rrhh(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 7) RLS POR FILA PROPIA (patrón comisiones-04).
--    SELECT: el dueño de la fila (usuario_id = auth.uid()) O RRHH/admin (fn_es_rrhh).
--    ESCRITURA: ninguna política → solo service-role. El /api/* valida identidad,
--      geocerca y consentimientos antes de escribir; un cliente con la anon key no puede.
--    rrhh_config: SELECT abierto a authenticated (la UI de marcación necesita la sede y
--      el horario); escritura ninguna.
--    NOTA: activar RLS aquí es OBLIGATORIO. Sin él, seguridad-01 (paso 1) le pondría a
--    estas tablas una política permisiva de lectura Y ESCRITURA para authenticated, que
--    es justo lo contrario de "solo el servidor escribe asistencia".
-- ────────────────────────────────────────────────────────────────────────────
alter table public.empleado_perfil enable row level security;
drop policy if exists empleado_perfil_sel on public.empleado_perfil;
create policy empleado_perfil_sel on public.empleado_perfil
  for select to authenticated using (
    usuario_id = auth.uid() or public.fn_es_rrhh(auth.uid())
  );

alter table public.rrhh_marca enable row level security;
drop policy if exists rrhh_marca_sel on public.rrhh_marca;
create policy rrhh_marca_sel on public.rrhh_marca
  for select to authenticated using (
    usuario_id = auth.uid() or public.fn_es_rrhh(auth.uid())
  );

alter table public.rrhh_ausencia enable row level security;
drop policy if exists rrhh_ausencia_sel on public.rrhh_ausencia;
create policy rrhh_ausencia_sel on public.rrhh_ausencia
  for select to authenticated using (
    usuario_id = auth.uid() or public.fn_es_rrhh(auth.uid())
  );

alter table public.rrhh_config enable row level security;
drop policy if exists rrhh_config_sel on public.rrhh_config;
create policy rrhh_config_sel on public.rrhh_config
  for select to authenticated using (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 8) SEED de permisos: el self-service (ver/editar MI perfil, marcar MI asistencia) llega
--    a TODOS los usuarios, como el dashboard. El módulo privilegiado 'rrhh' (ver todo) NO
--    se siembra: se otorga a mano al personal de RRHH. permisos_usuario tiene único
--    (usuario_id, modulo) → on conflict do nothing es idempotente.
--    (El módulo 'mi-perfil' debe además registrarse en las 3 listas de la app: menuGrupos
--     de app/layout.tsx, MODULOS de app/api/crear-usuario, y GRUPOS_MODULOS/nombresModulo
--     de app/usuarios — eso es trabajo de backend/frontend, no de este SQL.)
-- ────────────────────────────────────────────────────────────────────────────
insert into public.permisos_usuario (usuario_id, modulo, permitido)
  select id, 'mi-perfil', true from public.usuarios
  on conflict do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 9) STORAGE — este SQL NO crea buckets. Hay que crear a mano un bucket PRIVADO `rrhh`
--    en Supabase → Storage (Public = OFF). Convención de paths (la escribe el backend):
--      · marcas/<usuario_id>/<AAAA-MM-DD>/<tipo>-<uuid>.jpg      (foto de la marcación)
--      · ausencias/<usuario_id>/<uuid>.<ext>                     (documento de respaldo)
--    Las fotos traen rostro y ubicación: NUNCA un bucket público. foto_url/documento_url
--    guardan la ruta dentro del bucket; se leen con createSignedUrl (lib/storage-privado),
--    nunca con getPublicUrl, y se pintan con <ImgPrivada>/<EnlacePrivado>.
-- ────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- CONTRATO DE NOMBRES (el backend depende de esto) ──────────────────────────────
--   conductores.usuario_id (uuid, FK usuarios, nullable) — puente login↔conductor
--
--   empleado_perfil(
--     usuario_id uuid PK (FK usuarios, on delete cascade),
--     -- autoeditables por el dueño:
--     foto_url, fecha_nacimiento date, telefono_personal, direccion,
--     contacto_emergencia_nombre, contacto_emergencia_telefono,
--     contacto_emergencia_parentesco,
--     -- solo-backend:
--     consentimiento_biometrico_en timestamptz, consentimiento_biometrico_version text,
--     consentimiento_monitoreo_en  timestamptz, consentimiento_monitoreo_version  text,
--     marca_asistencia boolean (default false), updated_at timestamptz)
--
--   rrhh_config(id=1, sede_lat double, sede_lng double, sede_radio_m int (150),
--     hora_entrada time (08:00), hora_salida time (18:00), tolerancia_min int (10),
--     almuerzo_min int (60), geocerca_bloquea boolean (false), updated_at)
--
--   rrhh_marca(id bigserial, usuario_id uuid NOT NULL (FK usuarios),
--     tipo entrada|salida_almuerzo|regreso_almuerzo|salida, marcado_en timestamptz,
--     lat double, lng double, precision_m numeric, dentro_geocerca boolean,
--     distancia_m numeric, foto_url text, rostro_detectado boolean,
--     metodo facial|pin|manual_rrhh, origen text (default 'web'))
--
--   rrhh_ausencia(id bigserial, usuario_id uuid NOT NULL (FK usuarios),
--     tipo vacaciones|permiso|descanso_medico|licencia|falta|suspension,
--     desde date, hasta date, goce boolean, motivo text, documento_url text,
--     aprobado_por uuid, aprobado_en timestamptz,
--     estado solicitada|aprobada|rechazada (default 'solicitada'), created_at)
--
--   fn_es_rrhh(uuid) → boolean (admin por usuarios.rol, o permiso 'rrhh')
--   permiso sembrado a todos: modulo='mi-perfil'. Módulo privilegiado: 'rrhh'.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop policy if exists empleado_perfil_sel on public.empleado_perfil;
-- drop policy if exists rrhh_marca_sel      on public.rrhh_marca;
-- drop policy if exists rrhh_ausencia_sel   on public.rrhh_ausencia;
-- drop policy if exists rrhh_config_sel     on public.rrhh_config;
-- drop table if exists public.rrhh_ausencia;
-- drop table if exists public.rrhh_marca;
-- drop table if exists public.rrhh_config;
-- drop table if exists public.empleado_perfil;
-- drop function if exists public.fn_es_rrhh(uuid);
-- delete from public.permisos_usuario where modulo = 'mi-perfil';
-- alter table public.conductores drop column if exists usuario_id;  -- solo si esta fase la creó

-- ── Verificación post-migración ──────────────────────────────────────────────
-- Estructura creada:
--   select to_regclass('public.empleado_perfil'), to_regclass('public.rrhh_config'),
--          to_regclass('public.rrhh_marca'), to_regclass('public.rrhh_ausencia');
-- La fila única de config existe (y SIN coordenadas sembradas):
--   select id, sede_lat, sede_lng, geocerca_bloquea from public.rrhh_config;  -- 1 | null | null | f
-- El puente en conductores:
--   select column_name from information_schema.columns
--    where table_name='conductores' and column_name='usuario_id';
-- RLS activo en las 4 tablas (relrowsecurity = t) y SOLO política de SELECT en 3 de ellas:
--   select tablename, policyname, cmd, roles from pg_policies
--    where schemaname='public' and tablename like 'rrhh_%' or tablename='empleado_perfil'
--    order by 1;
-- El helper:
--   select public.fn_es_rrhh(auth.uid());  -- desde una sesión del ERP
-- El permiso self-service llegó a todos:
--   select count(*) filter (where modulo='mi-perfil') as con_perfil,
--          (select count(*) from public.usuarios) as total_usuarios
--     from public.permisos_usuario;
