-- ──────────────────────────────────────────────────────────────────────────────
-- Dimensión B · Estado administrativo / liquidación del servicio
--
-- Agrega la columna reservas.estado_admin SIN tocar reservas.estado (dimensión A).
-- Ver lib/estados.ts para el modelo de las dos dimensiones.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1) Columna nueva (nullable). NULL = "no aplica" (servicio aún no finalizado o cancelado).
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS estado_admin text;

-- 2) Restringir a los valores válidos del flujo administrativo.
--    (DROP previo para que el script sea re-ejecutable sin error.)
ALTER TABLE public.reservas
  DROP CONSTRAINT IF EXISTS reservas_estado_admin_check;

ALTER TABLE public.reservas
  ADD CONSTRAINT reservas_estado_admin_check
  CHECK (estado_admin IS NULL OR estado_admin IN ('por_liquidar', 'liquidada', 'facturada', 'cobrada'));

-- 3) Backfill: todo servicio ya FINALIZADO que aún no tenga estado administrativo
--    arranca en "por_liquidar" (el puente entre dimensiones).
UPDATE public.reservas
  SET estado_admin = 'por_liquidar'
  WHERE estado = 'finalizada' AND estado_admin IS NULL;

-- 4) Índice para filtrar por estado administrativo (ej. "Por liquidar" en el panel).
CREATE INDEX IF NOT EXISTS idx_reservas_estado_admin
  ON public.reservas (estado_admin);

-- Nota: el "puente" en caliente (finalizada → por_liquidar al cerrar un servicio)
-- lo aplica la app (lib/estados.ts → ESTADO_ADMIN_INICIAL). Este backfill solo
-- cubre los servicios históricos ya finalizados al momento de la migración.
