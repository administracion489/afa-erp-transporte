-- ──────────────────────────────────────────────────────────────────────────────
-- Marca de lote para reservas generadas en tanda desde "Programa fijo"
-- (ModalGenerarPrograma). Permite ofrecer "Deshacer generación" con un clic
-- justo después de generar, y aislar ese lote para el borrado en grupo de
-- /programacion.
--
-- · Columna NUEVA, nullable, SIN backfill: solo las próximas generaciones
--   quedan marcadas. Igual de "inofensivo" que los huecos del folio
--   OS-AAAA-NNNNNN (ver reservas-folio-codigo.sql) — no es la fuente de
--   verdad de nada, solo un helper de UI.
-- · No reemplaza cotizacion_id como agrupador natural; complementa filtrar
--   por cotización/fechas para lotes ya generados antes de este cambio.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

alter table public.reservas add column if not exists lote_generacion uuid;

create index if not exists idx_reservas_lote_generacion
  on public.reservas (lote_generacion)
  where lote_generacion is not null;
