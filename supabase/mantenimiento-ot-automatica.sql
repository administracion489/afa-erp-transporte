-- ============================================================
-- AFA Transportes — OT automática al vencer un mantenimiento
-- El aviso temprano (correo/chip "Próximo") sigue usando umbral_km/umbral_dias
-- de config_mantenimiento. Esto agrega un SEGUNDO umbral, más cercano al
-- vencimiento, que dispara la creación real de la orden de trabajo.
-- Ejecutar en Supabase SQL Editor.
-- ============================================================

-- ── 1. Umbral de creación de OT (más ajustado que el de aviso) ────────────────
ALTER TABLE config_mantenimiento ADD COLUMN IF NOT EXISTS umbral_ot_km      INT DEFAULT 100;
ALTER TABLE config_mantenimiento ADD COLUMN IF NOT EXISTS umbral_ot_dias    INT DEFAULT 2;
ALTER TABLE config_mantenimiento ADD COLUMN IF NOT EXISTS ot_automatica_activa BOOLEAN DEFAULT true;

COMMENT ON COLUMN config_mantenimiento.umbral_ot_km   IS 'Crea la OT automática cuando falten ≤ X km (más chico que umbral_km, el de aviso)';
COMMENT ON COLUMN config_mantenimiento.umbral_ot_dias IS 'Crea la OT automática cuando falten ≤ X días (más chico que umbral_dias, el de aviso)';

-- ── 2. Trazabilidad + dedupe en ordenes_trabajo ────────────────────────────────
-- La tabla ordenes_trabajo no está versionada en este repo (se creó directo en
-- Supabase); estas columnas se agregan de forma defensiva, sin asumir su forma.
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'manual';
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS plan_mantenimiento_id UUID REFERENCES planes_mantenimiento(id);

COMMENT ON COLUMN ordenes_trabajo.origen IS 'manual | automatica — automatica = la creó el cron de alertas al llegar al umbral_ot';
COMMENT ON COLUMN ordenes_trabajo.plan_mantenimiento_id IS 'Plan del fabricante del que salió el checklist, solo en OT automáticas';

-- Evita que el cron (que corre todos los días) duplique la misma OT automática
-- para el mismo vehículo + mismo hito de km mientras siga abierta. Si se cierra
-- o cancela, el índice deja de aplicar y el hito puede volver a generar una OT.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ordenes_trabajo_auto_dedupe
  ON ordenes_trabajo (vehiculo_id, km_apertura)
  WHERE origen = 'automatica' AND estado IN ('abierta', 'en_proceso');
