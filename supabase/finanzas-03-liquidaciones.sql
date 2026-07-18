-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS · FASE 3 — Liquidaciones (Cliente y Proveedor) como procesos separados
--
-- Requiere: finanzas-00, 01, 02.
--
-- Hoy "Por Liquidar" es UN solo enum (reservas.estado_admin) que mezcla tres cosas y
-- solo modela el lado CLIENTE. Esta fase separa DOS procesos distintos, cada uno con
-- su documento, sus líneas, sus ajustes y su aprobación:
--
--   LIQUIDACIÓN AL CLIENTE  → confirma el importe DEFINITIVO a facturar
--     (tarifa + horas/esperas/km adicionales + peajes − descuentos). Al aprobarse
--     se emite una `factura` (venta). Consolida N reservas → 1 valorización (típico
--     en cuentas corporativas de transporte de personal: imposible hoy porque
--     facturas.reserva_id es singular).
--
--   LIQUIDACIÓN AL PROVEEDOR → solo si el servicio fue tercerizado. Agrupa los
--     servicios de una empresa_tercerizada en un periodo, aplica adicionales/
--     penalidades/descuentos, calcula detracción y resta anticipos → total a pagar.
--     Al aprobarse genera una Cuenta por Pagar (documentos_compra + saldo).
--
-- Ambas son la TABLA PUENTE servicio↔dinero que permite auditar "dado este cobro/
-- pago, qué reservas cubre".
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Liquidación al CLIENTE (cabecera).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_cliente (
  id             bigserial primary key,
  codigo         text unique,                        -- LQC-AAAA-NNNNNN (trigger)
  cliente_id     bigint,
  periodo        text,                               -- 'AAAA-MM' si es valorización mensual
  fecha          date not null default current_date,
  moneda         text not null default 'PEN',
  estado         text not null default 'borrador'    -- borrador|aprobada|facturada|anulada
                 check (estado in ('borrador','aprobada','facturada','anulada')),
  -- Totales calculados desde el detalle (se persisten como snapshot al aprobar):
  subtotal       numeric(14,2) not null default 0,   -- neto sin IGV
  igv            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  factura_id     bigint,                              -- factura emitida al aprobar
  aprobada_por   text,
  fecha_aprobacion timestamptz,
  observaciones  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_liq_cli_cliente on public.liquidacion_cliente (cliente_id);
create index if not exists idx_liq_cli_estado  on public.liquidacion_cliente (estado);
select public._fin_add_fk('liquidacion_cliente','cliente_id','clientes');
select public._fin_add_fk('liquidacion_cliente','factura_id','facturas');

-- Detalle: una fila por servicio (reserva) + ajustes que confirman el importe final.
create table if not exists public.liquidacion_cliente_detalle (
  id                    bigserial primary key,
  liquidacion_id        bigint not null references public.liquidacion_cliente(id) on delete cascade,
  reserva_id            bigint,
  tarifa                numeric(14,2) not null default 0,
  horas_adicionales     numeric(14,2) not null default 0,
  espera                numeric(14,2) not null default 0,
  km_adicionales        numeric(14,2) not null default 0,
  peajes                numeric(14,2) not null default 0,
  otros_adicionales     numeric(14,2) not null default 0,
  descuento             numeric(14,2) not null default 0,
  -- subtotal_linea = tarifa + adicionales − descuento (lo calcula la app; se guarda snapshot)
  subtotal_linea        numeric(14,2) not null default 0,
  concepto              text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_liq_cli_det on public.liquidacion_cliente_detalle (liquidacion_id);
create index if not exists idx_liq_cli_det_res on public.liquidacion_cliente_detalle (reserva_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Liquidación al PROVEEDOR (cabecera). Solo tercerizados.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_proveedor (
  id                    bigserial primary key,
  codigo                text unique,                 -- LQP-AAAA-NNNNNN (trigger)
  empresa_tercerizada_id int,
  proveedor_id          int references public.proveedores(id),
  periodo               text,
  fecha                 date not null default current_date,
  moneda                text not null default 'PEN',
  estado                text not null default 'borrador'  -- borrador|aprobada|por_pagar|pagada|anulada
                        check (estado in ('borrador','aprobada','por_pagar','pagada','anulada')),
  subtotal              numeric(14,2) not null default 0,   -- Σ tarifas + adicionales − penalidades − descuentos
  igv                   numeric(14,2) not null default 0,
  detraccion_pct        numeric(6,4),
  detraccion_monto      numeric(14,2) not null default 0,
  anticipos             numeric(14,2) not null default 0,   -- pagos previos ya aplicados
  total                 numeric(14,2) not null default 0,   -- a pagar (neto de detracción/anticipos)
  documento_compra_id   bigint,                             -- CxP generada al aprobar
  aprobada_por          text,
  fecha_aprobacion      timestamptz,
  observaciones         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_liq_prov_emp    on public.liquidacion_proveedor (empresa_tercerizada_id);
create index if not exists idx_liq_prov_estado on public.liquidacion_proveedor (estado);
select public._fin_add_fk('liquidacion_proveedor','empresa_tercerizada_id','empresas_tercerizadas');
select public._fin_add_fk('liquidacion_proveedor','documento_compra_id','documentos_compra');

-- Ahora sí, el back-link documentos_compra → liquidacion_proveedor (tipo resuelto).
select public._fin_add_fk('documentos_compra','liquidacion_proveedor_id','liquidacion_proveedor');

create table if not exists public.liquidacion_proveedor_detalle (
  id             bigserial primary key,
  liquidacion_id bigint not null references public.liquidacion_proveedor(id) on delete cascade,
  reserva_id     bigint,
  oc_id          int references public.ordenes_compra(id),
  tarifa_acordada numeric(14,2) not null default 0,
  adicionales    numeric(14,2) not null default 0,
  penalidad      numeric(14,2) not null default 0,
  descuento      numeric(14,2) not null default 0,
  subtotal_linea numeric(14,2) not null default 0,   -- tarifa + adicionales − penalidad − descuento
  concepto       text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_liq_prov_det on public.liquidacion_proveedor_detalle (liquidacion_id);
create index if not exists idx_liq_prov_det_res on public.liquidacion_proveedor_detalle (reserva_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Correlativos LQC-/LQP-AAAA-NNNNNN (patrón atómico SECURITY DEFINER).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_secuencia (
  clave  text primary key,   -- 'LQC-2026' | 'LQP-2026'
  ultimo int not null default 0
);
alter table public.liquidacion_secuencia enable row level security;

create or replace function public.fn_liq_set_codigo(p_pref text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_anio int; v_clave text; v_n int;
begin
  v_anio := extract(year from (now() at time zone 'America/Lima')::date)::int;
  v_clave := p_pref || '-' || v_anio::text;
  insert into public.liquidacion_secuencia (clave, ultimo)
    values (v_clave, 1)
    on conflict (clave) do update set ultimo = liquidacion_secuencia.ultimo + 1
    returning ultimo into v_n;
  return v_clave || '-' || lpad(v_n::text, 6, '0');
end $$;

create or replace function public.trg_liq_cliente_codigo()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then new.codigo := public.fn_liq_set_codigo('LQC'); end if;
  return new;
end $$;
drop trigger if exists trg_liq_cli_codigo on public.liquidacion_cliente;
create trigger trg_liq_cli_codigo before insert on public.liquidacion_cliente
  for each row execute function public.trg_liq_cliente_codigo();

create or replace function public.trg_liq_proveedor_codigo()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then new.codigo := public.fn_liq_set_codigo('LQP'); end if;
  return new;
end $$;
drop trigger if exists trg_liq_prov_codigo on public.liquidacion_proveedor;
create trigger trg_liq_prov_codigo before insert on public.liquidacion_proveedor
  for each row execute function public.trg_liq_proveedor_codigo();

-- updated_at en ambas cabeceras.
create or replace function public.liq_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_liq_cli_upd on public.liquidacion_cliente;
create trigger trg_liq_cli_upd before update on public.liquidacion_cliente
  for each row execute function public.liq_set_updated_at();
drop trigger if exists trg_liq_prov_upd on public.liquidacion_proveedor;
create trigger trg_liq_prov_upd before update on public.liquidacion_proveedor
  for each row execute function public.liq_set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['liquidacion_cliente','liquidacion_cliente_detalle',
                           'liquidacion_proveedor','liquidacion_proveedor_detalle'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select * from public.liquidacion_cliente order by id desc limit 10;
-- select * from public.liquidacion_proveedor order by id desc limit 10;
