-- ============================================================
-- AFA Transportes — Programa de Mantenimiento editable por unidad
-- Permite ajustar el intervalo SOLO para un vehículo sin tocar el plan del
-- fabricante (que es compartido por todas las unidades del mismo modelo).
-- Ejecutar en Supabase SQL Editor.
-- ============================================================

ALTER TABLE vehiculos_plan ADD COLUMN IF NOT EXISTS intervalo_km_override    INT;
ALTER TABLE vehiculos_plan ADD COLUMN IF NOT EXISTS intervalo_meses_override INT;
ALTER TABLE vehiculos_plan ADD COLUMN IF NOT EXISTS notas                    TEXT;
ALTER TABLE vehiculos_plan ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ DEFAULT now();

COMMENT ON COLUMN vehiculos_plan.intervalo_km_override    IS 'Si está, manda sobre planes_mantenimiento.intervalo_base_km para ESTA unidad';
COMMENT ON COLUMN vehiculos_plan.intervalo_meses_override IS 'Si está, manda sobre planes_mantenimiento.intervalo_base_meses para ESTA unidad';
