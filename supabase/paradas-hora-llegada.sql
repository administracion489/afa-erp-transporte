-- ─────────────────────────────────────────────────────────────────────────────
-- Paradas: hora REAL de llegada al paradero
--
-- Una columna nueva en `paradas`, nullable y retrocompatible:
--   hora_llegada — cuándo el bus LLEGÓ al paradero. Hoy `marcar_parada` solo
--   escribía estado='completada' sin timestamp, así que no había forma de saber
--   la hora real de arribo. Con el nudge de auto-llegada (geofence en el app
--   conductor) se registra la hora de ENTRADA al radio del paradero, no la del
--   toque de confirmación; en el marcado manual, la hora del toque (o la de
--   entrada si el GPS ya la detectó).
--
-- Idempotente. No toca RLS (las políticas existentes de `paradas` ya cubren).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE paradas
  ADD COLUMN IF NOT EXISTS hora_llegada TIMESTAMPTZ;
