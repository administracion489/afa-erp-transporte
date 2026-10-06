-- ══════════════════════════════════════════════════════════════════════════════
-- COMBUSTIBLE · FASE 04 — La fecha del DESPACHO de una carga registrada desde la factura.
--
-- La factura electrónica no trae la fecha del despacho (el XML de COESTI solo lleva la de
-- emisión), así que una factura de UNA línea se registraba con la fecha de EMISIÓN, que en
-- COESTI suele ser el día siguiente. El ERP MIDE el desfase sobre las recargas del Radar que
-- casaron con su factura y lo aplica solo (lib/combustible/desfase-factura.ts).
--
-- Esta columna solo sirve para FIJARLO a mano. NO LA CORRE EL DEPLOY, y no hace falta para que
-- el desfase funcione: sin ella todo es automático (medido) y la configuración lo dice en ámbar.
-- Supabase → SQL Editor → pegar y ejecutar. Idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

alter table public.combustible_cuentas
  add column if not exists facturas_desfase_dias int;

-- 0..3: más de tres días no es un desfase de facturación, es otra carga (MAX_DESFASE).
alter table public.combustible_cuentas drop constraint if exists combustible_cuentas_facturas_desfase_dias_check;
alter table public.combustible_cuentas add constraint combustible_cuentas_facturas_desfase_dias_check
  check (facturas_desfase_dias is null or facturas_desfase_dias between 0 and 3);

comment on column public.combustible_cuentas.facturas_desfase_dias is
  'Días entre el despacho y la emisión de la factura, para fechar la carga que se registra desde una factura de UNA línea (que no trae la fecha del despacho). NULL = automático: lo mide el ERP sobre las recargas del Radar conciliadas con su factura. 0 = la fecha de emisión tal cual. Ver lib/combustible/desfase-factura.ts.';

-- Sin backfill a propósito: NULL (automático) es el valor correcto para las cuentas que ya existen.
