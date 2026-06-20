-- supabase/pasajeros-edad.sql
-- =============================================================================
-- AFA Transportes · Agrega la columna `edad` a la tabla `pasajeros`.
--
-- La edad alimenta la columna "Edad" del Manifiesto MTC (R.D. 1946-2009-MTC-15).
-- Se captura desde:
--   - la app del pasajero  (/pasajero → pestaña Perfil)
--   - la nómina de clientes (/clientes → Nómina de pasajeros: edición + Excel)
--
-- IMPORTANTE: corre este script en Supabase ANTES de desplegar el código que la
-- escribe/lee. Es idempotente (IF NOT EXISTS), así que puede correrse varias veces.
-- =============================================================================

ALTER TABLE pasajeros
  ADD COLUMN IF NOT EXISTS edad smallint;

-- Rango defensivo: edades plausibles (0–120). Permite NULL (dato opcional).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pasajeros_edad_rango'
  ) THEN
    ALTER TABLE pasajeros
      ADD CONSTRAINT pasajeros_edad_rango
      CHECK (edad IS NULL OR (edad >= 0 AND edad <= 120));
  END IF;
END $$;
