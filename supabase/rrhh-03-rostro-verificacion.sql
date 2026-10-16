-- ══════════════════════════════════════════════════════════════════════════════
-- RRHH · FASE 03 — Verificación facial 1:1 en la marcación de asistencia
--
-- QUÉ HACE:
--   · rrhh_rostro_ref — la PLANTILLA BIOMÉTRICA de referencia (descriptor del rostro), UNA
--       por usuario. descriptor_cifrado se guarda CIFRADO (AES-256-GCM, lo cifra el servidor
--       antes de insertar); NUNCA texto plano. foto_url → ruta en el bucket PRIVADO `rrhh`.
--       enrolado_marca_id = la rrhh_marca.id con que se tomó la plantilla.
--   · empleado_perfil.consentimiento_facial_{en,version} — consentimiento Ley 29733
--       ESPECÍFICO del reconocimiento facial 1:1, distinto del biométrico de rrhh-01 (ese
--       cubre "se guarda una foto"; esto, "se compara tu rostro contra tu plantilla"). Se
--       SUBE la versión cuando cambia el texto; la vieja no se reescribe.
--   · rrhh_marca.rostro_verificado / rostro_distancia — EVIDENCIA por marca: si la
--       comparación 1:1 pasó y a qué distancia. DISTINTO de rrhh_marca.rostro_detectado
--       (rrhh-01), que solo dice "había un rostro en la foto".
--
-- DIVERGENCIA DECLARADA del patrón de rrhh-01: sus tablas llevan RLS "SELECT fila propia"
-- (el dueño lee lo suyo). rrhh_rostro_ref va con RLS y CERO políticas — ni `to authenticated`
-- ni para el dueño de la fila: una plantilla biométrica, AUN CIFRADA, jamás debe poder leerse
-- desde el bundle del cliente (la anon key es pública), y la comparación 1:1 es 100% en el
-- servidor. Patrón whatsapp_tokens / seguridad-01: deny-all, solo service-role.
--
-- SI NO SE CORRE: no hay enrolamiento facial ni verificación 1:1; la marcación se comporta
-- como hoy (foto de evidencia + rostro_detectado de rrhh-01). No toca nada de lo desplegado:
-- solo AGREGA una tabla y columnas NULLABLE a empleado_perfil / rrhh_marca.
--
-- Requiere: rrhh-01 (empleado_perfil, rrhh_marca, usuarios). Sin seed. Idempotente (se corre
-- dos veces sin error). EL DEPLOY NO LO CORRE: se ejecuta a mano en Supabase → SQL Editor.
-- revoke/grant dentro de este archivo. Reversión y verificación al pie.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1) PLANTILLA BIOMÉTRICA. PK = usuario_id (una por usuario). descriptor CIFRADO (servidor).
create table if not exists public.rrhh_rostro_ref (
  usuario_id         uuid primary key
                     references public.usuarios(id) on delete cascade,
  descriptor_cifrado text not null,
  foto_url           text,
  enrolado_en        timestamptz default now(),
  enrolado_marca_id  bigint,   -- id de la rrhh_marca con que se enroló (sin FK: desacoplado)
  updated_at         timestamptz default now()
);

comment on table public.rrhh_rostro_ref is
  'Plantilla facial (1 por usuario). descriptor_cifrado = AES-256-GCM, nunca texto plano. '
  'Deny-all: RLS activo y CERO políticas, solo service-role.';

-- 2) RLS deny-all. CERO políticas a propósito: RLS activo + ninguna policy = nadie que no
--    sea service-role la toca, ni el dueño de la fila. Los `drop policy` dejan la tabla sin
--    políticas por si una corrida previa dejó alguna (idempotente).
alter table public.rrhh_rostro_ref enable row level security;
drop policy if exists rrhh_rostro_ref_sel on public.rrhh_rostro_ref;
drop policy if exists rrhh_rostro_ref_all on public.rrhh_rostro_ref;

-- Supabase da a toda tabla nueva el GRANT por defecto a anon/authenticated; con RLS y sin
-- políticas ya no ven filas, pero se quita igual (deny-all). service_role sí opera.
revoke all on public.rrhh_rostro_ref from anon, authenticated;
grant select, insert, update, delete on public.rrhh_rostro_ref to service_role;

-- 3) CONSENTIMIENTO facial (Ley 29733), específico de la verificación 1:1. Nullable: nace
--    sin otorgar; lo escribe solo el backend. Distinto del biométrico de rrhh-01.
alter table public.empleado_perfil
  add column if not exists consentimiento_facial_en      timestamptz,
  add column if not exists consentimiento_facial_version text;

-- 4) EVIDENCIA por marca (la calcula el servidor tras la comparación 1:1). Nullable: una
--    marca por PIN o manual_rrhh no verifica rostro. rostro_verificado = pasó; distancia = match.
alter table public.rrhh_marca
  add column if not exists rostro_verificado boolean,
  add column if not exists rostro_distancia  numeric;

-- ══════════════════════════════════════════════════════════════════════════════
-- CONTRATO DE NOMBRES (el backend depende de esto) ──────────────────────────────
--   rrhh_rostro_ref(
--     usuario_id uuid PK (FK usuarios, on delete cascade),
--     descriptor_cifrado text NOT NULL (AES-256-GCM, lo cifra el servidor),
--     foto_url text (ruta en bucket privado rrhh),
--     enrolado_en timestamptz (default now()), enrolado_marca_id bigint,
--     updated_at timestamptz (default now()))
--   → RLS activo, CERO políticas; solo service-role lee/escribe.
--   empleado_perfil.consentimiento_facial_en timestamptz / _version text (nullable)
--   rrhh_marca.rostro_verificado boolean / rostro_distancia numeric (nullable)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop table if exists public.rrhh_rostro_ref;
-- alter table public.empleado_perfil drop column if exists consentimiento_facial_en;
-- alter table public.empleado_perfil drop column if exists consentimiento_facial_version;
-- alter table public.rrhh_marca drop column if exists rostro_verificado;
-- alter table public.rrhh_marca drop column if exists rostro_distancia;

-- ── Verificación post-migración ──────────────────────────────────────────────
-- Tabla creada:   select to_regclass('public.rrhh_rostro_ref');
-- RLS activo (t): select relrowsecurity from pg_class where oid='public.rrhh_rostro_ref'::regclass;
-- CERO políticas: select count(*) from pg_policies where schemaname='public' and tablename='rrhh_rostro_ref'; -- 0
-- Columnas nuevas: select column_name from information_schema.columns
--   where (table_name='empleado_perfil' and column_name like 'consentimiento_facial%')
--      or (table_name='rrhh_marca'      and column_name in ('rostro_verificado','rostro_distancia'));

-- FIN de rrhh-03-rostro-verificacion.sql
