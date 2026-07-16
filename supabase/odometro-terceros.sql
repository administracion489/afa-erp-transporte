-- ─────────────────────────────────────────────────────────────────────────────
-- Odómetro para flota tercerizada
--
-- Hoy el kilometraje (lecturas_odometro + vehiculos.kilometraje_actual) solo existe
-- para la flota propia (tabla `vehiculos`). Este script habilita el mismo mecanismo
-- para `vehiculos_tercero` SIN romper la flota propia:
--   1. `vehiculos_tercero.kilometraje_actual` — el km vigente DERIVADO del tercero
--      (espejo de `vehiculos.kilometraje_actual`).
--   2. `lecturas_odometro.vehiculo_tercero_id` — FK propia a `vehiculos_tercero`,
--      separada de `vehiculo_id` (que sigue apuntando a `vehiculos`). Se usa columna
--      separada y NO un discriminador `es_tercero` para conservar la integridad
--      referencial y el ON DELETE CASCADE en AMBAS flotas, y porque los ids de
--      `vehiculos` y `vehiculos_tercero` se solapan (viven en columnas distintas).
--   3. CHECK "exactamente una flota": cada lectura pertenece a propia XOR tercero.
--
-- Idempotente. La RLS de lecturas_odometro (auth.role()='authenticated' para ALL)
-- ya cubre las filas nuevas — no se toca.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Km vigente del tercero (columna derivada, igual que vehiculos.kilometraje_actual)
ALTER TABLE vehiculos_tercero
  ADD COLUMN IF NOT EXISTS kilometraje_actual INT;

-- 2) FK separada a la flota tercerizada (conserva cascade)
ALTER TABLE lecturas_odometro
  ADD COLUMN IF NOT EXISTS vehiculo_tercero_id INT
    REFERENCES vehiculos_tercero(id) ON DELETE CASCADE;

-- `vehiculo_id` ya es NULLABLE en el DDL original; lo reafirmamos por si acaso.
ALTER TABLE lecturas_odometro
  ALTER COLUMN vehiculo_id DROP NOT NULL;

-- 3) Exactamente una flota por lectura (propia XOR tercero).
--    Las filas existentes (todas con vehiculo_id NOT NULL y vehiculo_tercero_id NULL)
--    satisfacen el CHECK, así que se agrega ya validado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lecturas_odometro_una_flota'
  ) THEN
    ALTER TABLE lecturas_odometro
      ADD CONSTRAINT lecturas_odometro_una_flota
      CHECK ( (vehiculo_id IS NOT NULL) <> (vehiculo_tercero_id IS NOT NULL) );
  END IF;
END $$;

-- 4) Índice para el historial por vehículo tercero (espejo del de flota propia)
CREATE INDEX IF NOT EXISTS idx_lecturas_odometro_terc
  ON lecturas_odometro(vehiculo_tercero_id, fecha DESC);
