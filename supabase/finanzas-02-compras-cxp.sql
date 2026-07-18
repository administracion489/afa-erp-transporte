-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS/CONTABILIDAD · FASE 2 — Compras · Cuentas por Pagar · Comprobante de compra
--
-- Requiere: finanzas-00-fundacion.sql (helper _fin_add_fk) y 01 (pagos).
--
-- Crea el COMPROBANTE DE COMPRA del proveedor como entidad fiscal (hoy inexistente:
-- los egresos viven como `monto` plano sin RUC/serie/IGV). Es el ancla de:
--   · Cuentas por Pagar (saldo = total − Σ pagos_aplicacion, derivado)
--   · Registro de Compras / IGV compras (fase 04)
--   · La conciliación de la IA de facturas por correo (fase 05): la factura entrante
--     hace UPDATE de la cadena existente (radar_combustible → combustible →
--     documentos_compra), JAMÁS un INSERT nuevo que duplique el gasto.
--
-- Modelo cabecera/detalle: una factura de tarjeta de flota mensual agrupa N cargas.
-- Llave de dedupe FISCAL: UNIQUE(ruc_emisor, tipo_comprobante, serie, numero).
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Comprobante de compra (cabecera).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.documentos_compra (
  id                 bigserial primary key,
  proveedor_id       int references public.proveedores(id),
  ruc_emisor         text,
  razon_social       text,
  tipo_comprobante   text not null default 'factura',  -- factura|boleta|recibo_honorarios|nota_credito|nota_debito|ticket
  serie              text,
  numero             text,
  fecha_emision      date not null default current_date,
  fecha_vencimiento  date,                              -- por condición de pago
  moneda             text not null default 'PEN',
  tipo_cambio        numeric(10,4),
  subtotal           numeric(14,2) not null default 0,  -- base imponible
  igv                numeric(14,2) not null default 0,
  inafecto           numeric(14,2) not null default 0,
  detraccion_pct     numeric(6,4),
  detraccion_monto   numeric(14,2) not null default 0,
  retencion_monto    numeric(14,2) not null default 0,
  total              numeric(14,2) not null default 0,  -- total del comprobante
  categoria          text,                              -- combustible|repuestos|servicio|tercero|otro
  estado_conciliacion text not null default 'pendiente' -- pendiente|conciliado|con_diferencia|anulado
                     check (estado_conciliacion in ('pendiente','conciliado','con_diferencia','anulado')),
  oc_id              int references public.ordenes_compra(id),
  xml_url            text,
  cdr_url            text,
  pdf_url            text,
  origen             text default 'manual',             -- manual|correo_ia|radar
  observaciones      text,
  creado_por         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Dedupe fiscal (los NULL conviven en índice único de Postgres, no bloquea manuales sin serie).
create unique index if not exists uq_docs_compra_fiscal
  on public.documentos_compra (ruc_emisor, tipo_comprobante, serie, numero)
  where ruc_emisor is not null and serie is not null and numero is not null;

-- estado_pago: eje ORTOGONAL a estado_conciliacion. estado_conciliacion = ¿la factura
-- casa con la carga real? (fiscal). estado_pago = ¿está pagada? (tesorería). No mezclarlos.
alter table public.documentos_compra add column if not exists estado_pago text not null default 'impaga';
alter table public.documentos_compra drop constraint if exists documentos_compra_estado_pago_chk;
alter table public.documentos_compra
  add constraint documentos_compra_estado_pago_chk
  check (estado_pago in ('impaga','parcial','pagada'));

create index if not exists idx_docs_compra_prov  on public.documentos_compra (proveedor_id);
create index if not exists idx_docs_compra_fecha on public.documentos_compra (fecha_emision desc);
create index if not exists idx_docs_compra_estado on public.documentos_compra (estado_conciliacion);
create index if not exists idx_docs_compra_pago   on public.documentos_compra (estado_pago);

-- FK opcional a empresas_tercerizadas (tipo resuelto dinámicamente).
select public._fin_add_fk('documentos_compra','empresa_tercerizada_id','empresas_tercerizadas');
-- (La FK documentos_compra.liquidacion_proveedor_id se agrega en la fase 03,
--  cuando ya existe la tabla liquidacion_proveedor.)

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Detalle del comprobante de compra (líneas). Cada línea puede anclar a UNA
--    fila operativa ya capturada (una carga de combustible, un mantenimiento, un
--    ítem de OC) — así una factura mensual concilia contra N registros sin duplicar.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.documentos_compra_detalle (
  id                  bigserial primary key,
  documento_compra_id bigint not null references public.documentos_compra(id) on delete cascade,
  descripcion         text,
  cantidad            numeric(14,4) not null default 1,
  unidad              text default 'und',
  precio_unitario     numeric(14,4) not null default 0,
  subtotal            numeric(14,2) not null default 0,
  -- Ancla a la fila operativa que esta línea representa (0..1 de cada tipo):
  combustible_id      bigint,
  mantenimiento_id    bigint,
  gasto_id            int references public.gastos(id),
  reserva_id          bigint,
  created_at          timestamptz not null default now()
);
create index if not exists idx_docs_compra_det_doc  on public.documentos_compra_detalle (documento_compra_id);
create index if not exists idx_docs_compra_det_comb on public.documentos_compra_detalle (combustible_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) FKs documento_compra_id en las tablas de egreso EXISTENTES (ancla, no duplica).
--    Cada línea de egreso referencia a lo sumo UN comprobante de compra. El gasto de
--    caja chica sin factura queda con documento_compra_id NULL (legítimo).
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('gastos',        'documento_compra_id','documentos_compra');
select public._fin_add_fk('combustible',   'documento_compra_id','documentos_compra');
select public._fin_add_fk('mantenimiento', 'documento_compra_id','documentos_compra');
select public._fin_add_fk('ordenes_compra','documento_compra_id','documentos_compra');

-- Columnas fiscales estructuradas para el voucher del grifo capturado por el Radar
-- (hoy solo se concatena en combustible.observaciones). NO tocar combustible.total
-- (columna GENERADA = galones×precio): el total FISCAL vive en documentos_compra.
alter table public.combustible add column if not exists comprobante_serie  text;
alter table public.combustible add column if not exists comprobante_numero text;
alter table public.combustible add column if not exists ruc_proveedor      text;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) estado_pago en la OC, INDEPENDIENTE del estado logístico (recibida).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.ordenes_compra add column if not exists estado_pago text not null default 'impaga';
alter table public.ordenes_compra drop constraint if exists ordenes_compra_estado_pago_chk;
alter table public.ordenes_compra
  add constraint ordenes_compra_estado_pago_chk
  check (estado_pago in ('impaga','parcial','pagada'));

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Unificar proveedores ↔ empresas_tercerizadas + datos de tesorería del proveedor.
--    Un subcontratista ES un proveedor: FK opcional. Datos de pago pactados en días
--    (int, no texto) y CCI para automatizar pagos/detracciones.
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('empresas_tercerizadas','proveedor_id','proveedores');

do $$
declare tbl text;
begin
  foreach tbl in array array['proveedores','empresas_tercerizadas'] loop
    execute format('alter table public.%I add column if not exists cuenta_bancaria text', tbl);
    execute format('alter table public.%I add column if not exists cci text', tbl);
    execute format('alter table public.%I add column if not exists moneda_pago text default ''PEN''', tbl);
    execute format('alter table public.%I add column if not exists condicion_pago_dias int default 0', tbl);
    execute format('alter table public.%I add column if not exists detraccion_pct numeric(6,4)', tbl);
    execute format('alter table public.%I add column if not exists retencion_pct numeric(6,4)', tbl);
  end loop;
exception when others then
  raise notice '[fase02] alguna columna de tesorería del proveedor no se pudo agregar: %', sqlerrm;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) Correlativo de comprobantes de VENTA por SERIE (F001-00000123, B001-…).
--    A diferencia de folio/OC (por AÑO), SUNAT exige correlativo continuo por SERIE.
--    Se reserva el número al emitir. La app llama a fn_siguiente_comprobante('F001').
--    (No es un trigger sobre `facturas` para no chocar con su esquema legado; se
--    invoca explícitamente al emitir — ver lib/finanzas/comprobantes.)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comprobante_secuencia (
  serie  text primary key,     -- 'F001' | 'B001' | 'FC01'
  ultimo int not null default 0
);
alter table public.comprobante_secuencia enable row level security;

create or replace function public.fn_siguiente_comprobante(p_serie text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  insert into public.comprobante_secuencia (serie, ultimo)
    values (p_serie, 1)
    on conflict (serie) do update set ultimo = comprobante_secuencia.ultimo + 1
    returning ultimo into v_n;
  return v_n;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7) updated_at automático + RLS.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.docs_compra_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_docs_compra_updated_at on public.documentos_compra;
create trigger trg_docs_compra_updated_at
  before update on public.documentos_compra
  for each row execute function public.docs_compra_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['documentos_compra','documentos_compra_detalle'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select public.fn_siguiente_comprobante('F001');   -- reserva y devuelve el próximo nº
-- select * from public.documentos_compra order by id desc limit 10;
