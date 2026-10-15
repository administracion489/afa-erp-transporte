-- ══════════════════════════════════════════════════════════════════════════════
-- RRHH · FASE 02 — Trabajo en CAMPO con GPS (personal fuera de la sede)
--
-- QUÉ HACE: habilita rastrear por GPS al personal que trabaja FUERA de la sede
-- (comerciales, supervisores, mensajería) sin montar una tabla de posiciones nueva
-- ni tocar el motor de flota. Dos piezas:
--   · ubicaciones_gps.empleado_usuario_id — DISCRIMINADOR. Una posición de CAMPO se
--       guarda en la MISMA tabla que la flota, pero marcada con el usuarios.id del
--       empleado y con conductor_id/vehiculo_id/conductor_tercero_id/vehiculo_tercero_id
--       en NULL. Así monitoreo, huella y analítica —que filtran SIEMPRE por conductor o
--       vehículo— NO la ven, y el campo de personal no contamina el rastreo de buses.
--       Un ÍNDICE PARCIAL (solo filas con empleado_usuario_id) deja leer las posiciones
--       de campo sin barrer la tabla MÁS ESCRITA del ERP.
--   · rrhh_autorizacion_campo — el PERMISO, con ventana de vigencia y flujo de
--       aprobación (solicitada → aprobada|rechazada|vencida). Rastrear a una persona es
--       dato sensible: tiene que estar AUTORIZADO, con motivo, por quién y hasta cuándo.
--
-- POR QUÉ: rastrear personas es más sensible que rastrear buses, así que (a) se reúsa la
-- infraestructura probada (ubicaciones_gps, su realtime, su índice por fecha) en vez de
-- duplicarla, pero (b) la posición de campo lleva su PROPIO discriminador para que ninguna
-- de las lecturas de flota la recoja por error, y (c) el rastreo exige una autorización
-- explícita y con caducidad. La LECTURA de las posiciones de campo NO se abre por RLS: va
-- por /api/* con service-role, que resuelve qué empleado puede ver RRHH (igual que la
-- lectura de flota de /api/monitoreo). Por eso NO se toca la RLS de ubicaciones_gps: es
-- una tabla COMPARTIDA con la flota y cambiar su política afectaría a todo el rastreo.
--
-- SI NO SE CORRE: no existe el discriminador ni la autorización; las pantallas de campo de
-- RRHH se comportan como si las columnas no existieran (el backend suelta la columna que el
-- error nombra, como el resto del ERP). NO toca nada de lo ya desplegado: solo AGREGA una
-- columna nullable + un índice parcial a ubicaciones_gps, y CREA una tabla nueva. El
-- rastreo de flota, el monitoreo y la huella siguen byte a byte como están.
--
-- Reusa (NO recrea): ubicaciones_gps (tabla núcleo del rastreo; sus columnas reales:
--   id, created_at, estado, conductor_id, vehiculo_id, conductor_tercero_id,
--   vehiculo_tercero_id, reserva_id, lat, lng, velocidad, rumbo, precision_m, fix_ts,
--   simulado, recibido_en), usuarios (PK = auth.uid(), uuid), fn_es_rrhh(uuid) de rrhh-01.
-- Requiere: rrhh-01 (fn_es_rrhh). Idempotente (se puede correr dos veces). EL DEPLOY NO LO
-- CORRE: se ejecuta a mano en Supabase → SQL Editor. Reversión al pie.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) DISCRIMINADOR en ubicaciones_gps. add column if not exists es seguro sobre una
--    tabla núcleo (no reescribe filas; PG lo resuelve con un default "missing" y aquí ni
--    hay default). Una fila de CAMPO lleva empleado_usuario_id y deja conductor_id,
--    vehiculo_id, conductor_tercero_id y vehiculo_tercero_id en NULL: así no entra en
--    monitoreo (lee por vehículo/conductor vigente), ni en la huella/analítica (filtran por
--    conductor/vehículo), ni en el semáforo de puntualidad (filtra por reserva).
--    NO se cambia la RLS de ubicaciones_gps: es una tabla COMPARTIDA; la lectura de campo
--    va por API service-role que resuelve qué puede ver RRHH.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.ubicaciones_gps
  add column if not exists empleado_usuario_id uuid references public.usuarios(id);

comment on column public.ubicaciones_gps.empleado_usuario_id is
  'Discriminador de posición de CAMPO (personal fuera de la sede). Una fila de campo lleva '
  'este usuarios.id y deja conductor_id/vehiculo_id/conductor_tercero_id/vehiculo_tercero_id '
  'en NULL, para no contaminar monitoreo/huella/analítica (que filtran por conductor/vehículo). '
  'La lee /api/* con service-role; NO se abre por RLS (tabla compartida con la flota).';

-- Índice PARCIAL: solo las filas de campo (una fracción mínima de la tabla más escrita del
-- ERP). Deja leer las posiciones de un empleado por fecha sin barrer el rastreo de la flota.
create index if not exists idx_ubicaciones_gps_empleado
  on public.ubicaciones_gps (empleado_usuario_id, created_at)
  where empleado_usuario_id is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) AUTORIZACIÓN de rastreo en campo. Una fila por autorización, con ventana de vigencia
--    (vigente_desde/vigente_hasta) y flujo de aprobación. 'vencida' es un estado explícito:
--    lo escribe el backend cuando pasa vigente_hasta, para que una autorización caducada no
--    siga figurando como 'aprobada'. El índice (estado, vigente_hasta) sirve justo a ese
--    barrido de vencimiento; (usuario_id, estado) resuelve "¿tiene este empleado una
--    autorización vigente?".
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.rrhh_autorizacion_campo (
  id            bigserial primary key,
  usuario_id    uuid not null references public.usuarios(id),
  motivo        text,
  solicitado_en timestamptz default now(),
  vigente_desde timestamptz,
  vigente_hasta timestamptz,
  estado        text default 'solicitada'
                check (estado in ('solicitada','aprobada','rechazada','vencida')),
  aprobado_por  uuid,
  aprobado_en   timestamptz,
  nota          text,
  created_at    timestamptz default now()
);

create index if not exists idx_rrhh_autorizacion_campo_usuario
  on public.rrhh_autorizacion_campo (usuario_id, estado);

create index if not exists idx_rrhh_autorizacion_campo_vigencia
  on public.rrhh_autorizacion_campo (estado, vigente_hasta);

comment on table public.rrhh_autorizacion_campo is
  'Permiso para rastrear por GPS a un empleado en campo, con ventana de vigencia y flujo '
  'solicitada→aprobada|rechazada|vencida. El backend (service-role) decide y marca vencida '
  'al pasar vigente_hasta. Rastrear a una persona exige autorización explícita con caducidad.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) RLS POR FILA PROPIA (patrón comisiones-04 / rrhh-01).
--    SELECT: el dueño de la fila (usuario_id = auth.uid()) O RRHH/admin (fn_es_rrhh). Así
--      un empleado ve SU autorización (sabe si lo están rastreando y hasta cuándo) y RRHH
--      ve todas.
--    ESCRITURA: NINGUNA política → solo service-role. Solicitar, aprobar, rechazar y vencer
--      pasan por /api/* que valida identidad y permiso de RRHH; un cliente con la anon key
--      no puede auto-aprobarse un rastreo ni fabricar una autorización ajena.
--    Activar RLS aquí es OBLIGATORIO y nace con la tabla: sin él, seguridad-01 (paso 1)
--    —que solo toca tablas con RLS DESACTIVADA— le pondría una política permisiva de lectura
--    Y ESCRITURA para authenticated, justo lo contrario de "solo el servidor autoriza el
--    rastreo". Con la RLS ya activa, el barrido de seguridad-01 la salta.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.rrhh_autorizacion_campo enable row level security;
drop policy if exists rrhh_autorizacion_campo_sel on public.rrhh_autorizacion_campo;
create policy rrhh_autorizacion_campo_sel on public.rrhh_autorizacion_campo
  for select to authenticated using (
    usuario_id = auth.uid() or public.fn_es_rrhh(auth.uid())
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- CONTRATO DE NOMBRES (el backend depende de esto) ──────────────────────────────
--   ubicaciones_gps.empleado_usuario_id (uuid, FK usuarios, nullable)
--     — una fila de CAMPO lo lleva y deja conductor_id/vehiculo_id/
--       conductor_tercero_id/vehiculo_tercero_id en NULL.
--     — índice parcial idx_ubicaciones_gps_empleado (empleado_usuario_id, created_at)
--       where empleado_usuario_id is not null.
--
--   rrhh_autorizacion_campo(
--     id            bigserial PK,
--     usuario_id    uuid NOT NULL (FK usuarios),
--     motivo        text,
--     solicitado_en timestamptz (default now()),
--     vigente_desde timestamptz,
--     vigente_hasta timestamptz,
--     estado        solicitada|aprobada|rechazada|vencida (default 'solicitada'),
--     aprobado_por  uuid,            -- usuarios.id de quien aprobó (sin FK, como rrhh-01)
--     aprobado_en   timestamptz,
--     nota          text,
--     created_at    timestamptz (default now()))
--     — índices: (usuario_id, estado), (estado, vigente_hasta)
--     — RLS: SELECT para el dueño o RRHH; escritura solo service-role.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop policy if exists rrhh_autorizacion_campo_sel on public.rrhh_autorizacion_campo;
-- drop table if exists public.rrhh_autorizacion_campo;
-- drop index if exists public.idx_ubicaciones_gps_empleado;
-- alter table public.ubicaciones_gps drop column if exists empleado_usuario_id;
--   -- OJO: dropear la columna borra el discriminador de toda posición de campo ya grabada.

-- ── Verificación post-migración ──────────────────────────────────────────────
-- La columna discriminadora existe en ubicaciones_gps:
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='ubicaciones_gps'
--      and column_name='empleado_usuario_id';            -- empleado_usuario_id | uuid
-- El índice parcial existe y es parcial (indpred no nulo):
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='ubicaciones_gps'
--      and indexname='idx_ubicaciones_gps_empleado';
-- La tabla de autorización existe:
--   select to_regclass('public.rrhh_autorizacion_campo');
-- RLS ACTIVA en la tabla nueva (relrowsecurity = t) y SOLO política de SELECT:
--   select c.relrowsecurity from pg_class c
--    where c.oid = 'public.rrhh_autorizacion_campo'::regclass;   -- t
--   select policyname, cmd, roles from pg_policies
--    where schemaname='public' and tablename='rrhh_autorizacion_campo';  -- *_sel | SELECT | {authenticated}
-- La RLS de ubicaciones_gps NO se tocó (sigue como estaba):
--   select relrowsecurity from pg_class where oid='public.ubicaciones_gps'::regclass;
