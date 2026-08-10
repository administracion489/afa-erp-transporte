-- ============================================================
-- AFA Transportes — Dirección fiscal y de cochera en Empresas Tercerizadas
-- Permite filtrar/ordenar proveedores por cercanía de distrito cuando un cliente
-- pide un servicio en una zona puntual ("¿quién tengo cerca de San Martín de Porres?").
-- Ejecutar en Supabase SQL Editor.
-- ============================================================

-- ── 1. Empresa: dirección general (por defecto para toda su flota) ────────────
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS direccion_fiscal  TEXT;
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS distrito_fiscal   TEXT;
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS direccion_cochera TEXT;
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS distrito_cochera  TEXT;
-- Opcional: solo se llenan si alguien pulsa "Geocodificar" en la ficha de la empresa.
-- No los usa el filtro por distrito (que es el mecanismo principal); son un detalle extra.
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS lat_cochera NUMERIC;
ALTER TABLE empresas_tercerizadas ADD COLUMN IF NOT EXISTS lng_cochera NUMERIC;

COMMENT ON COLUMN empresas_tercerizadas.distrito_fiscal   IS 'Distrito de la dirección fiscal/administrativa — informativo, no se usa para el filtro de cercanía.';
COMMENT ON COLUMN empresas_tercerizadas.distrito_cochera  IS 'Distrito de la cochera general de la empresa. Filtro principal de "proveedor más cercano" en /tercerizadas — ver lib/distritos-lima.ts.';
COMMENT ON COLUMN empresas_tercerizadas.lat_cochera        IS 'Opcional — geocodificado bajo demanda desde direccion_cochera (botón en la ficha), no se calcula solo.';

-- ── 2. Vehículo: override si esa unidad puntual no está en la cochera general ──
ALTER TABLE vehiculos_tercero ADD COLUMN IF NOT EXISTS direccion_cochera TEXT;
ALTER TABLE vehiculos_tercero ADD COLUMN IF NOT EXISTS distrito_cochera  TEXT;

COMMENT ON COLUMN vehiculos_tercero.distrito_cochera IS 'Override por unidad — si es null, se usa el distrito_cochera de la empresa (empresas_tercerizadas). Solo hace falta cuando una unidad puntual no está en la cochera general de la empresa.';
