-- ──────────────────────────────────────────────────────────────────────────────
-- Amplía los valores permitidos de proveedores.tipo para incluir 'concesionario'
-- (venta de vehículos) y 'leasing' (financiera), usados para la compra de flota.
--
-- Síntoma sin esto: al guardar un proveedor con tipo concesionario/leasing sale
--   'new row for relation "proveedores" violates check constraint "proveedores_tipo_check"'.
--
-- Se usa NOT VALID: la restricción se aplica a TODA inserción/edición futura, pero
-- NO revalida filas históricas (así nunca falla la migración por datos viejos).
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

alter table public.proveedores drop constraint if exists proveedores_tipo_check;

alter table public.proveedores
  add constraint proveedores_tipo_check
  check (tipo in (
    'taller','grifo','repuestos','concesionario','leasing','seguros',
    'neumaticos','lavadero','vulcanizadora','electricista','administrativo',
    'transporte','otro'
  )) not valid;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select tipo, count(*) from public.proveedores group by tipo order by 1;
