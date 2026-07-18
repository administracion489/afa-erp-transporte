-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS · FASE 1 — Tesorería + Pagos (la primitiva ausente en todo el ERP)
--
-- Requiere: supabase/finanzas-00-fundacion.sql (usa el helper _fin_add_fk()).
--
-- Hoy "cobrada" es un enum en facturas.estado / reservas.estado_admin: un booleano
-- sin monto, fecha, método real ni pagos parciales. Esta fase crea el LIBRO de
-- movimientos de dinero:
--   · cuentas_tesoreria     — caja/banco (la entidad que hoy no existe)
--   · movimientos_tesoreria — libro de caja/bancos (base de conciliación bancaria)
--   · pagos                 — cabecera de un cobro (in) o pago (out)
--   · pagos_aplicacion      — CÓMO se reparte un pago entre 1..N comprobantes
--
-- El SALDO de un comprobante = total − Σ pagos_aplicacion → DERIVADO, nunca guardado.
-- "cobrada"/"pagada" pasa a significar saldo = 0. Un anticipo es un pago SIN aplicar
-- (o aplicado parcialmente). Un pago puede cubrir varios comprobantes y un
-- comprobante pagarse en varias armadas.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Cuentas de tesorería (caja chica, bancos, billeteras).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.cuentas_tesoreria (
  id            bigserial primary key,
  nombre        text not null,                 -- "BCP Corriente Soles", "Caja Chica Oficina"
  tipo          text not null default 'banco', -- banco | caja | billetera
  moneda        text not null default 'PEN',
  banco         text,
  numero_cuenta text,
  cci           text,
  saldo_inicial numeric(14,2) not null default 0,
  activo        boolean not null default true,
  observaciones text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_cuentas_tes_activo on public.cuentas_tesoreria (activo);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Pagos (cabecera). sentido = cobro (entra) | pago (sale).
--    contraparte_tipo/id apunta a cliente (cobro) o proveedor/tercero (pago).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pagos (
  id                  bigserial primary key,
  codigo              text unique,                    -- RC/OP-AAAA-NNNNNN (trigger)
  sentido             text not null check (sentido in ('cobro','pago')),
  cuenta_tesoreria_id bigint references public.cuentas_tesoreria(id),
  fecha               date not null default current_date,
  monto               numeric(14,2) not null,
  moneda              text not null default 'PEN',
  tipo_cambio         numeric(10,4),
  metodo              text,                            -- transferencia|deposito|yape|plin|efectivo|tarjeta|detraccion
  contraparte_tipo    text check (contraparte_tipo in ('cliente','proveedor','tercero','otro')),
  contraparte_id      bigint,                          -- id en clientes|proveedores|empresas_tercerizadas
  referencia          text,                            -- nro de operación bancaria / voucher
  comprobante_url     text,
  observaciones       text,
  anulado             boolean not null default false,
  creado_por          text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_pagos_sentido on public.pagos (sentido, fecha desc);
create index if not exists idx_pagos_contraparte on public.pagos (contraparte_tipo, contraparte_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Aplicación del pago a comprobantes (la pieza clave: pagos parciales/múltiples).
--    documento_tipo: 'factura' (venta) | 'documento_compra' (compra) | 'liquidacion_*'.
--    monto SIN aplicar de un pago = pago.monto − Σ aplicaciones → es el ANTICIPO.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pagos_aplicacion (
  id             bigserial primary key,
  pago_id        bigint not null references public.pagos(id) on delete cascade,
  documento_tipo text not null check (documento_tipo in
                   ('factura','documento_compra','liquidacion_cliente','liquidacion_proveedor')),
  documento_id   bigint not null,
  monto_aplicado numeric(14,2) not null check (monto_aplicado > 0),
  created_at     timestamptz not null default now()
);
create index if not exists idx_pagos_aplic_pago on public.pagos_aplicacion (pago_id);
create index if not exists idx_pagos_aplic_doc  on public.pagos_aplicacion (documento_tipo, documento_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Movimientos de tesorería (libro de caja/bancos). Cada pago genera 1 movimiento;
--    también admite movimientos manuales (comisiones, intereses, transferencias
--    internas). conciliado/fecha_conciliacion → base de la conciliación bancaria.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.movimientos_tesoreria (
  id                  bigserial primary key,
  cuenta_tesoreria_id bigint not null references public.cuentas_tesoreria(id) on delete cascade,
  fecha               date not null default current_date,
  sentido             text not null check (sentido in ('entrada','salida')),
  monto               numeric(14,2) not null,
  moneda              text not null default 'PEN',
  concepto            text,
  pago_id             bigint references public.pagos(id) on delete set null,
  referencia          text,
  conciliado          boolean not null default false,
  fecha_conciliacion  date,
  created_at          timestamptz not null default now()
);
create index if not exists idx_mov_tes_cuenta on public.movimientos_tesoreria (cuenta_tesoreria_id, fecha desc);
create index if not exists idx_mov_tes_conc   on public.movimientos_tesoreria (conciliado) where conciliado = false;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Correlativo de recibos/órdenes de pago: RC-AAAA-NNNNNN (cobro) · OP-AAAA-NNNNNN.
--    Replica el patrón atómico SECURITY DEFINER de oc_secuencia (ordenes-compra.sql).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pago_secuencia (
  clave  text primary key,   -- 'RC-2026' | 'OP-2026'
  ultimo int not null default 0
);
alter table public.pago_secuencia enable row level security;

create or replace function public.fn_pagos_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio    int;
  v_pref    text;
  v_clave   text;
  v_n       int;
begin
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;
  v_anio := extract(year from coalesce(new.fecha, (now() at time zone 'America/Lima')::date))::int;
  v_pref := case when new.sentido = 'cobro' then 'RC' else 'OP' end;
  v_clave := v_pref || '-' || v_anio::text;

  insert into public.pago_secuencia (clave, ultimo)
    values (v_clave, 1)
    on conflict (clave) do update set ultimo = pago_secuencia.ultimo + 1
    returning ultimo into v_n;

  new.codigo := v_clave || '-' || lpad(v_n::text, 6, '0');
  return new;
end $$;

drop trigger if exists trg_pagos_set_codigo on public.pagos;
create trigger trg_pagos_set_codigo
  before insert on public.pagos
  for each row execute function public.fn_pagos_set_codigo();

-- ────────────────────────────────────────────────────────────────────────────
-- 6) RLS (mismo patrón authenticated de radar-ia.sql).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['cuentas_tesoreria','pagos','pagos_aplicacion','movimientos_tesoreria'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select * from public.cuentas_tesoreria;
-- Saldo de una factura (derivado): total − aplicado
--   select f.id, f.total,
--          coalesce((select sum(monto_aplicado) from pagos_aplicacion pa
--                    where pa.documento_tipo='factura' and pa.documento_id=f.id),0) as pagado
--     from facturas f;
