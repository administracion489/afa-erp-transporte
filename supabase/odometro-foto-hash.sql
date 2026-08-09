-- ─────────────────────────────────────────────────────────────────────────────
-- Odómetro: huella del CONTENIDO de la foto (anti-reenvío real)
--
-- Por qué: el dedupe existente compara `foto_url`, y eso solo atrapa el mismo
-- archivo en la misma ubicación. Una foto REENVIADA por WhatsApp llega como un
-- mensaje nuevo, el worker la sube con otro nombre y su URL es distinta aunque el
-- binario sea idéntico — justo el caso que hay que detectar.
--
-- `foto_hash` guarda el SHA-256 del binario, así que dos subidas del mismo archivo
-- coinciden aunque la URL cambie. Esto es lo que permite retirar la regla vieja
-- ("mismo km dentro de 12 h = duplicada"), que en la operación real solo acusaba al
-- patrón normal: check-out ~21:00 y check-in ~05:20 del día siguiente con el bus
-- parado en cochera. Auditoría del 09/08/2026 sobre 58 grupos con el mismo km
-- repetido: NINGUNO compartía foto — 0 reenvíos, 56 con fotos distintas.
--
-- Nullable y retrocompatible: las lecturas históricas quedan con NULL y el código
-- funciona igual sin esta columna (el INSERT reintenta sin ella si no existe).
-- Idempotente. No toca RLS (la política authenticated ALL ya cubre las filas).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE lecturas_odometro
  ADD COLUMN IF NOT EXISTS foto_hash TEXT;

COMMENT ON COLUMN lecturas_odometro.foto_hash IS
  'SHA-256 del binario de la foto. Detecta la MISMA imagen aunque se suba con otra URL (reenvío de WhatsApp). NULL = histórica o sin foto.';

-- Búsqueda del dedupe: se consulta por (vehículo, hash) al registrar cada lectura.
CREATE INDEX IF NOT EXISTS idx_lecturas_odometro_foto_hash
  ON lecturas_odometro(foto_hash)
  WHERE foto_hash IS NOT NULL;
