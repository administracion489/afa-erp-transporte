-- ══════════════════════════════════════════════════════════════════════════════
-- RRHH · FASE 04 — Horario POR EMPLEADO (hasta hoy el horario es GLOBAL)
--
-- QUÉ HACE: agrega a empleado_perfil cuatro columnas NULLABLE que, cuando traen valor,
-- SOBREESCRIBEN para ESE empleado el horario global de rrhh_config (id=1):
--   · hora_entrada   time  — su hora de entrada propia.
--   · hora_salida    time  — su hora de salida propia.
--   · tolerancia_min int   — sus minutos de gracia antes de contar tardanza.
--   · almuerzo_min   int   — su descuento de almuerzo por defecto.
-- Mismos nombres y tipos que las columnas de rrhh_config, a propósito: el backend resuelve
-- cada campo con `empleado_perfil.<campo> ?? rrhh_config.<campo>`.
--
-- POR QUÉ: hasta hoy todos marcan contra el MISMO horario (rrhh_config, fila única). Un
-- turno distinto para una persona (jornada partida, medio tiempo, horario de oficina) no
-- se podía expresar. Estas columnas son la EXCEPCIÓN por empleado; rrhh_config sigue siendo
-- el default de la empresa.
--
-- REGLA DE ORO — NULL = HEREDA EL GLOBAL, campo por campo: una columna en NULL significa
-- "este empleado usa el valor de rrhh_config para ESTE campo". Por eso:
--   · NULLABLE y SIN default: un default sembraría un horario que nadie fijó y rompería la
--     herencia (el campo dejaría de ser NULL y congelaría el global del día del ALTER).
--   · SIN seed / SIN backfill: NO se copia rrhh_config a cada fila. Escribir el global en
--     miles de empleados AFIRMARÍA un horario propio que nadie declaró; el NULL ya lo dice.
--   · SIN trigger: la herencia la hace el backend al LEER, no la base. Dos motores que
--     resuelvan el horario terminarían resolviéndolo distinto.
--
-- SI NO SE CORRE: no existe el horario por empleado; todos marcan contra rrhh_config como
-- hoy. El backend suelta las columnas que el error nombra y cae al global (comportamiento
-- byte a byte el anterior). No toca nada de lo desplegado: solo AGREGA columnas nullable.
--
-- Requiere: rrhh-01 (empleado_perfil, rrhh_config). Sin seed. Idempotente (se corre dos
-- veces sin error). EL DEPLOY NO LO CORRE: se ejecuta a mano en Supabase → SQL Editor.
-- Reversión y verificación al pie.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) HORARIO POR EMPLEADO. Las cuatro NULLABLE, sin default: NULL = hereda el global.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.empleado_perfil
  add column if not exists hora_entrada   time,
  add column if not exists hora_salida    time,
  add column if not exists tolerancia_min int,
  add column if not exists almuerzo_min   int;

comment on column public.empleado_perfil.hora_entrada is
  'Hora de entrada propia. NULL = hereda rrhh_config.hora_entrada (lo resuelve el backend).';
comment on column public.empleado_perfil.hora_salida is
  'Hora de salida propia. NULL = hereda rrhh_config.hora_salida (lo resuelve el backend).';
comment on column public.empleado_perfil.tolerancia_min is
  'Minutos de gracia propios. NULL = hereda rrhh_config.tolerancia_min.';
comment on column public.empleado_perfil.almuerzo_min is
  'Descuento de almuerzo propio. NULL = hereda rrhh_config.almuerzo_min.';

-- ══════════════════════════════════════════════════════════════════════════════
-- CONTRATO DE NOMBRES (el backend depende de esto) ──────────────────────────────
--   empleado_perfil.hora_entrada   time (nullable, sin default)
--   empleado_perfil.hora_salida    time (nullable, sin default)
--   empleado_perfil.tolerancia_min int  (nullable, sin default)
--   empleado_perfil.almuerzo_min   int  (nullable, sin default)
--   → Mismos nombres/tipos que rrhh_config. NULL en un campo ⇒ usar rrhh_config.<campo>.
--     El backend resuelve: empleado_perfil.<campo> ?? rrhh_config.<campo>. Sin trigger.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── reversión ───────────────────────────────────────────────────────────────
-- alter table public.empleado_perfil drop column if exists hora_entrada;
-- alter table public.empleado_perfil drop column if exists hora_salida;
-- alter table public.empleado_perfil drop column if exists tolerancia_min;
-- alter table public.empleado_perfil drop column if exists almuerzo_min;

-- ── Verificación post-migración ──────────────────────────────────────────────
-- Las 4 columnas existen (debe devolver 4 filas):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='empleado_perfil'
--      and column_name in ('hora_entrada','hora_salida','tolerancia_min','almuerzo_min')
--    order by column_name;
--   -- is_nullable = YES y column_default = null en las cuatro.

-- FIN de rrhh-04-horario-por-empleado.sql
