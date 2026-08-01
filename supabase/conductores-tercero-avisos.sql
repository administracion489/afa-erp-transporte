-- ============================================================
-- Avisos a conductores TERCERIZADOS (correo + inclusión en el motor de alertas)
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- Situación previa (verificada en el código):
--   • `conductores_tercero` NO tenía columna `email` — el correo era imposible para
--     ellos aunque el canal estuviera habilitado.
--   • El motor de alertas NUNCA los avisaba. Tres barreras acumuladas:
--       1. el select de `reservas` ni siquiera traía `conductor_tercero_id`;
--       2. seis bloques filtran `tipo_asignacion <> 'propio'`;
--       3. el mapa de conductores se llenaba SOLO desde `conductores`, y en una
--          reserva tercerizada `conductor_id` es NULL por construcción.
--     Además `notificarConductor()` cortaba con "no aplica (tercero o sin conductor)".
--
-- Este archivo habilita la posibilidad; el interruptor por tipo de mensaje
-- (`notifica_conductor_tercero`) queda en FALSE para que NADA cambie al desplegar.
-- El usuario lo enciende desde /configuracion/operaciones cuando quiera.
-- ============================================================

-- ── 1) Correo del conductor tercerizado ──────────────────────────────────────
alter table public.conductores_tercero
  add column if not exists email text;

-- ── 2) Interruptor por tipo de mensaje ───────────────────────────────────────
-- Separado de `notifica_conductor` a propósito: encender los avisos para la flota
-- tercerizada es una decisión comercial (son personal de otra empresa), no un
-- detalle técnico. Default FALSE = comportamiento actual, cero mensajes nuevos.
alter table public.alerta_config
  add column if not exists notifica_conductor_tercero boolean not null default false;

-- ── 3) Discriminador de tabla en el estado de ciclo de vida ──────────────────
-- `avisos_conductor_estado.conductor_avisado` guarda SOLO el id. Como los ids de
-- `conductores` y `conductores_tercero` se solapan, una reserva que pasa del propio
-- #7 al tercerizado #7 parecería "sin cambios" y NO se avisaría la reasignación.
-- Con esta columna la comparación es por el PAR (id, tabla).
-- Default 'conductores' = todo lo ya registrado es de flota propia (cierto: hasta hoy
-- los tercerizados nunca entraban a este bloque).
alter table public.avisos_conductor_estado
  add column if not exists conductor_tabla_avisada text not null default 'conductores'
    check (conductor_tabla_avisada in ('conductores','conductores_tercero'));

-- ── Smoke test ───────────────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_name = 'conductores_tercero' and column_name = 'email';
-- select clave, notifica_conductor, notifica_conductor_tercero
--   from public.alerta_config order by clave;
-- select id, nombre, telefono, email from public.conductores_tercero order by id;
