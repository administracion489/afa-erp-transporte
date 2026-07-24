-- ─────────────────────────────────────────────────────────────────────────────
-- Revisión de combustible con fotos + edición + aprendizaje IA + flota tercerizada
--
-- Incremental sobre supabase/radar-ia.sql y radar-ia-combustible-multifoto.sql (ya
-- corridos en prod). Correr una vez en el editor SQL de Supabase. Todo IF NOT EXISTS /
-- nullable → seguro de correr antes o después del deploy del código.
--
-- Cubre cuatro necesidades del panel de revisión de /radar-ia?tab=combustible:
--   1. Ver la(s) foto(s) que la IA procesó  → radar_combustible.fotos (jsonb).
--   2. Registrar recargas de unidades TERCERIZADAS → combustible.vehiculo_tercero_id
--      (espejo de lecturas_odometro.vehiculo_tercero_id — ver odometro-terceros.sql).
--   3. Que la IA APRENDA de las correcciones del revisor → radar_combustible_correcciones
--      (espejo de odometro_correcciones — ver odometro-anulacion.sql).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Combustible de flota tercerizada ────────────────────────────────────────
--    Columna separada (NO discriminador es_tercero) para conservar integridad
--    referencial en ambas flotas, igual que lecturas_odometro.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS vehiculo_tercero_id INT
    REFERENCES vehiculos_tercero(id) ON DELETE SET NULL;

-- `vehiculo_id` deja de ser obligatorio: una carga es de flota propia XOR tercero.
ALTER TABLE combustible
  ALTER COLUMN vehiculo_id DROP NOT NULL;

-- Exactamente una flota por carga. Las filas existentes (vehiculo_id NOT NULL,
-- vehiculo_tercero_id NULL) ya satisfacen el CHECK → se agrega ya validado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_una_flota'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_una_flota
      CHECK ( (vehiculo_id IS NOT NULL) <> (vehiculo_tercero_id IS NOT NULL) );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_terc
  ON combustible(vehiculo_tercero_id, fecha DESC);

-- 2) Fotos + destino tercero en radar_combustible ────────────────────────────
--    `fotos`: lista de { url, mime, nombre } con TODAS las fotos del cluster que la
--    IA procesó (surtidor / nota / tablero). El UI de revisión hace fallback a
--    radar_mensajes.media_url para filas viejas donde `fotos` está vacío.
ALTER TABLE radar_combustible
  ADD COLUMN IF NOT EXISTS fotos jsonb DEFAULT '[]'::jsonb;

ALTER TABLE radar_combustible
  ADD COLUMN IF NOT EXISTS vehiculo_tercero_id INT
    REFERENCES vehiculos_tercero(id) ON DELETE SET NULL;

-- 3) Dataset de aprendizaje: correcciones humanas de lectura de vouchers ──────
--    Espejo de odometro_correcciones. Cada campo que el revisor corrige antes de
--    registrar (grifo mal leído, galones, precio, monto, fecha) se guarda aquí y
--    lib/radar/lecciones-combustible.ts lo inyecta como ejemplo en el prompt de
--    extracción con visión para que ELIA no repita el error.
CREATE TABLE IF NOT EXISTS radar_combustible_correcciones (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_combustible_id UUID REFERENCES radar_combustible(id) ON DELETE SET NULL,
  campo                TEXT NOT NULL,   -- grifo | galones | litros | precio | monto | fecha
  valor_ia             TEXT,            -- lo que extrajo la IA (null si no leyó nada)
  valor_correcto       TEXT,            -- lo que dejó el revisor
  foto_url             TEXT,            -- evidencia (primera foto del cluster)
  nota                 TEXT,            -- detalle libre opcional
  usuario              TEXT,            -- email de quien corrigió
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_radar_comb_corr_fecha
  ON radar_combustible_correcciones(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radar_comb_corr_campo
  ON radar_combustible_correcciones(campo, created_at DESC);

ALTER TABLE radar_combustible_correcciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "radar_comb_corr_all" ON radar_combustible_correcciones;
CREATE POLICY "radar_comb_corr_all" ON radar_combustible_correcciones FOR ALL
  USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
