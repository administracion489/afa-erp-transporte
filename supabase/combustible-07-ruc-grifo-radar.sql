-- ============================================================================
-- combustible-07 · el RUC del grifo que leyó el Radar
-- ============================================================================
-- La nota de despacho trae el RUC del grifo en el encabezado («COESTI S.A. - RUC: 20127765279») y
-- el Radar lo leía y lo tiraba: `radar_combustible` no tenía dónde guardarlo. Con él el ERP nombra
-- al grifo por su RUC —una sola identidad por empresa, con la razón social de su factura SUNAT
-- (lib/combustible/grifo-canonico.ts)— y, al registrar la carga desde el panel de revisión, lo pasa
-- a `combustible.ruc_proveedor`, que es con lo que el saldo de la cuenta prepago reconoce sus cargas
-- sin depender de cómo se escribió el nombre.
--
-- Se guarda VALIDADO (11 cifras con su dígito verificador) o null. Nullable y sin default, sin
-- backfill: las filas viejas no lo leyeron, y uno inventado atribuiría la carga a otro grifo.
--
-- Sin esta migración el Radar guarda la recarga igual (lib/radar/guardado-radar.ts suelta la columna
-- que el error nombra) y el grifo se sigue nombrando por su RUC al procesar; solo se pierde llevar el
-- RUC hasta la carga cuando se registra desde el panel.
--
-- NO la corre el deploy.
-- ============================================================================

alter table public.radar_combustible add column if not exists ruc_grifo text;

comment on column public.radar_combustible.ruc_grifo is
  'RUC del grifo leído del encabezado de la nota, validado (dígito verificador). null = no se leyó o no era válido.';
