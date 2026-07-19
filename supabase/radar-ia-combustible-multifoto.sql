-- supabase/radar-ia-combustible-multifoto.sql
-- Fase 1 del rediseño de recargas de combustible multi-foto en Radar IA.
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase. Todas las columnas son nullable / IF NOT EXISTS → seguro de
-- correr aunque el código nuevo aún no esté desplegado (y viceversa).
--
-- Contexto: hoy la capacidad del tanque estaba HARDCODEADA (app/combustible/page.tsx y
-- lib/radar/acciones.ts), con un default de 80 gal para un bus que es irreal para un kit
-- de conversión a GLP (~20-30 gal). Esto la vuelve EDITABLE por vehículo y por tipo de
-- combustible, para que el control "galones exceden el tanque" por fin sirva en GLP.

-- 1) Capacidad de tanque editable por vehículo, por tipo de combustible.
--    Forma: { "diesel": 100, "glp": 25, "gnv": 150, "gasolina": 60, "urea": 20 }
--    (galones para diesel/gasolina/glp/biodiesel, m³ para gnv, litros para urea — misma
--    unidad que muestra /combustible). Las claves ausentes caen a la heurística por categoría.
alter table vehiculos          add column if not exists capacidad_tanque jsonb;
alter table vehiculos_tercero  add column if not exists capacidad_tanque jsonb;

-- 2) Trazabilidad de la extracción multi-foto en radar_combustible (para el panel de revisión
--    de /radar-ia). El código de Fase 1 NO inserta todavía en estas columnas (los datos crudos
--    ya viven en radar_mensajes.resultado.extraccion); se agregan aquí para el UI de auditoría.
alter table radar_combustible  add column if not exists ruc text;
alter table radar_combustible  add column if not exists reconciliacion jsonb;

-- Nota: NO se hace backfill. Sin capacidad configurada, lib/radar/acciones.ts y
-- app/combustible/page.tsx siguen usando la heurística CAPACIDAD_TANQUE por categoría.
