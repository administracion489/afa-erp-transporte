-- ─────────────────────────────────────────────────────────────────────────────
-- Anulación de lecturas de odómetro + retroalimentación para la IA
--
-- Problema: una lectura ya ACEPTADA que estaba mal (la IA leyó 435,461 en vez de
-- 43,546; foto de otra unidad; dedazo al tipear) contamina el km vigente y todo el
-- mantenimiento preventivo que cuelga de él. Borrarla a secas pierde la evidencia
-- y no enseña nada.
--
-- Diseño:
--   1. NO se borra la fila: pasa a estado 'anulada' (queda la foto y la trazabilidad).
--      `estado` es TEXT libre en lecturas_odometro — no hay CHECK que tocar.
--   2. Cada anulación exige un MOTIVO TIPIFICADO + el km correcto (si se sabe). Eso
--      se guarda en `odometro_correcciones`, que es a la vez bitácora de auditoría y
--      dataset de aprendizaje: /api/mantenimiento/leer-odometro inyecta las últimas
--      correcciones de lectura-IA como ejemplos en el prompt de visión.
--   3. El km vigente se RECALCULA desde las lecturas que quedan (lib/odometro.ts
--      → recalcularKmVigente), respetando el último reinicio de tablero.
--
-- Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS odometro_correcciones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lectura_id   UUID REFERENCES lecturas_odometro(id) ON DELETE SET NULL,
  vehiculo_id  INT  REFERENCES vehiculos(id)         ON DELETE SET NULL,
  vehiculo_tercero_id INT REFERENCES vehiculos_tercero(id) ON DELETE SET NULL,
  placa        TEXT,                 -- desnormalizado: sobrevive al borrado del vehículo
  km_leido     INT  NOT NULL,        -- lo que se había registrado (el error)
  km_correcto  INT,                  -- lo que debió ser (null si no se sabe)
  fuente       TEXT,                 -- fuente de la lectura anulada (whatsapp_foto, checklist…)
  motivo_tipo  TEXT NOT NULL,        -- ia_digito | ia_trip | otra_unidad | duplicada | tipeo | reinicio | otro
  nota         TEXT,                 -- detalle libre que escribe el usuario
  foto_url     TEXT,                 -- evidencia de la lectura anulada
  usuario      TEXT,                 -- email de quien anuló
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_odo_corr_fecha  ON odometro_correcciones(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_odo_corr_fuente ON odometro_correcciones(fuente, created_at DESC);

ALTER TABLE odometro_correcciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "odo_corr_all" ON odometro_correcciones;
CREATE POLICY "odo_corr_all" ON odometro_correcciones FOR ALL
  USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
