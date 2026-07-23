-- ─────────────────────────────────────────────────────────────────────────────
-- Odómetro: hora real de captura + idempotencia anti-duplicado
--
-- Dos columnas nuevas en lecturas_odometro, ambas nullable y retrocompatibles:
--   1. capturado_en — cuándo se TOMÓ la lectura (foto del tablero / mensaje de
--      WhatsApp), no cuándo se insertó en el servidor. El Radar inserta minutos u
--      horas después (gracia 5 min + cron 15 min), así que created_at desfasa el
--      inicio/fin de jornada. La analítica ordena por coalesce(capturado_en, created_at).
--   2. idem_key — clave estable por EVENTO de origen (radar_msg:{id},
--      checkin:{veh}:{fecha}, checkout:{veh}:{fecha}, combustible:{id}). Un índice
--      único PARCIAL (solo donde idem_key IS NOT NULL) corta de raíz el reproceso
--      del Radar y el doble-POST del conductor sin afectar las filas legacy (NULL).
--
-- Idempotente. No toca RLS (la política authenticated ALL ya cubre las filas).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE lecturas_odometro
  ADD COLUMN IF NOT EXISTS capturado_en TIMESTAMPTZ;

ALTER TABLE lecturas_odometro
  ADD COLUMN IF NOT EXISTS idem_key TEXT;

-- Índice único parcial: dos lecturas con el mismo idem_key no pueden coexistir,
-- pero las históricas (idem_key NULL) quedan libres y no chocan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lecturas_odometro_idem
  ON lecturas_odometro(idem_key)
  WHERE idem_key IS NOT NULL;

-- Índice para el dedupe por foto (misma foto reenviada / mensaje reprocesado).
CREATE INDEX IF NOT EXISTS idx_lecturas_odometro_foto
  ON lecturas_odometro(foto_url)
  WHERE foto_url IS NOT NULL;
