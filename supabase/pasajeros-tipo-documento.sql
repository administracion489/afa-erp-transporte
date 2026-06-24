-- supabase/pasajeros-tipo-documento.sql
-- =============================================================================
-- AFA Transportes · Agrega la columna `tipo_documento` a la tabla `pasajeros`.
--
-- Alimenta la columna "Tipo de documento" del Manifiesto MTC (R.D. 1946-2009-MTC-15),
-- que distingue DNI / Carné de extranjería / Pasaporte / Otro. Se captura desde:
--   - la app del pasajero (/pasajero → pestaña Perfil → "Mis datos")
--
-- El NÚMERO de documento sigue viviendo en la columna `dni` (es la llave de login
-- del pasajero); este script solo agrega el TIPO. Las columnas `email` y `edad`
-- ya existen (ver pasajeros-edad.sql).
--
-- IMPORTANTE: corre este script en Supabase ANTES de desplegar el código que la
-- escribe/lee. Es idempotente (IF NOT EXISTS), así que puede correrse varias veces.
-- =============================================================================

ALTER TABLE pasajeros
  ADD COLUMN IF NOT EXISTS tipo_documento text DEFAULT 'DNI';

-- Whitelist de tipos válidos (mismo set que valida /api/pasajero). Permite NULL
-- para filas legadas que aún no lo tengan (la UI cae a 'DNI' al mostrarlas).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pasajeros_tipo_documento_valido'
  ) THEN
    ALTER TABLE pasajeros
      ADD CONSTRAINT pasajeros_tipo_documento_valido
      CHECK (tipo_documento IS NULL OR tipo_documento IN ('DNI', 'CE', 'PASAPORTE', 'OTRO'));
  END IF;
END $$;
