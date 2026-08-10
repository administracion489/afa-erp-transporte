-- ============================================================
-- AFA Transportes — Mejoras a Órdenes de Trabajo
-- 1) Acción por ítem editable (lo que decía el plan vs. lo que pasó de verdad)
-- 2) Cerrar una OT mueve el ancla de "próximo mantenimiento" (tabla mantenimiento)
-- 3) Foto + repuesto usado por ítem (subido desde el ERP)
-- 4) Fecha límite sugerida en la OT, para el PDF
-- Ejecutar en Supabase SQL Editor.
-- ============================================================

-- ── 1. Acción por ítem: plan vs. lo real ───────────────────────────────────────
-- Antes la acción (Cambio/Inspección/Cada servicio) venía incrustada como texto
-- dentro de checklist_ot.item, sin forma de editarla. accion_plan es la foto de
-- lo que decía el plan del fabricante al crear el ítem (no se toca después);
-- accion_final arranca igual y es la que se edita si una inspección terminó en
-- cambio real. Los ítems creados a mano (o antes de este SQL) quedan en null,
-- sin acción — el chip de la UI los muestra como "sin acción" y se puede asignar.
ALTER TABLE checklist_ot ADD COLUMN IF NOT EXISTS accion_plan  TEXT;
ALTER TABLE checklist_ot ADD COLUMN IF NOT EXISTS accion_final TEXT;
COMMENT ON COLUMN checklist_ot.accion_plan  IS 'C=Cambio · I=Inspección · R=Cada servicio · null=sin plan de fabricante detrás (ítem manual). No se edita tras crearse.';
COMMENT ON COLUMN checklist_ot.accion_final IS 'Igual a accion_plan al crear el ítem; editable — registra qué pasó realmente (ej. una inspección que terminó en cambio).';

-- ── 2. Foto + repuesto usado por ítem ──────────────────────────────────────────
ALTER TABLE checklist_ot ADD COLUMN IF NOT EXISTS foto_url TEXT;
ALTER TABLE checklist_ot ADD COLUMN IF NOT EXISTS repuesto TEXT;
COMMENT ON COLUMN checklist_ot.foto_url IS 'Evidencia del ítem (bucket vehiculos-fotos), subida desde el ERP — no desde el app del conductor.';
COMMENT ON COLUMN checklist_ot.repuesto IS 'Repuesto/insumo usado en este ítem (texto libre: marca, código, etc.)';

-- ── 3. Cerrar una OT mueve el ancla de mantenimiento ───────────────────────────
-- km_cierre: se pide al cerrar la OT (no existía ningún kilometraje de cierre,
-- solo el de apertura). fecha_limite_sugerida: la fecha por la que el plan del
-- fabricante pedía este servicio (solo en OT automáticas), para mostrarla en el PDF.
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS km_cierre INT;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS fecha_limite_sugerida DATE;
COMMENT ON COLUMN ordenes_trabajo.km_cierre IS 'Odómetro real al cerrar la OT — con esto se re-ancla mantenimiento.kilometraje al cerrar.';
COMMENT ON COLUMN ordenes_trabajo.fecha_limite_sugerida IS 'Fecha por la que el plan del fabricante pedía este servicio (solo OT automáticas).';

-- ── 4. Cuándo y a qué taller se lleva la unidad ────────────────────────────────
-- taller_proveedor_id apunta al directorio ya existente de Proveedores (tipo='taller');
-- el campo de texto libre `taller` (ya existía) queda como respaldo para talleres
-- ocasionales que no están registrados ahí — la UI prioriza el proveedor si hay uno.
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS taller_proveedor_id INT REFERENCES proveedores(id);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS fecha_programada DATE;
COMMENT ON COLUMN ordenes_trabajo.taller_proveedor_id IS 'Taller del directorio de Proveedores (tipo=taller). Si es null, se usa el texto libre de la columna taller.';
COMMENT ON COLUMN ordenes_trabajo.fecha_programada IS 'Cuándo se planea llevar la unidad al taller. Las OT automáticas nacen sin esto — lo completa quien coordina el ingreso.';
