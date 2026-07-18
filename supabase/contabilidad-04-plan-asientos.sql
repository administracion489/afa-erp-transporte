-- ══════════════════════════════════════════════════════════════════════════════
-- CONTABILIDAD · FASE 5 — Plan de cuentas · Asientos · Periodos · Activos fijos
--
-- Requiere: finanzas-00..03.
--
-- La capa contable que hoy es CERO: sin plan de cuentas (PCGE), sin partida doble,
-- sin libros. Aquí van las tablas base; el "servicio de posting" (generar el asiento
-- balanceado a partir de una factura / documento_compra / pago / depreciación) vive
-- en lib/contabilidad/asientos.ts.
--
-- Principio: el asiento se DERIVA de un documento fuente (factura, documento_compra,
-- pago). No se re-teclea. Cada asiento apunta a su documento origen para trazabilidad.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Plan Contable (PCGE). Subconjunto sembrado, útil para un operador de transporte.
--    El contador amplía/ajusta. naturaleza: deudora|acreedora (saldo normal).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.plan_cuentas (
  codigo     text primary key,   -- '1011', '4011', '7041'…
  nombre     text not null,
  tipo       text not null check (tipo in ('activo','pasivo','patrimonio','ingreso','gasto','orden')),
  naturaleza text not null check (naturaleza in ('deudora','acreedora')),
  nivel      int not null default 4,
  imputable  boolean not null default true,  -- true = se puede usar en asientos
  activo     boolean not null default true
);

insert into public.plan_cuentas (codigo, nombre, tipo, naturaleza) values
  ('1011','Caja',                                   'activo',   'deudora'),
  ('104',  'Cuentas corrientes en instituciones financieras','activo','deudora'),
  ('1212','Facturas por cobrar - emitidas',         'activo',   'deudora'),
  ('1213','Boletas por cobrar',                      'activo',   'deudora'),
  ('167',  'Otras cuentas por cobrar diversas',      'activo',   'deudora'),
  ('253',  'Suministros (combustible/lubricantes)',  'activo',   'deudora'),
  ('334',  'Unidades de transporte',                 'activo',   'deudora'),
  ('3913','Depreciación acumulada - unidades de transporte','activo','acreedora'),
  ('40111','IGV - cuenta propia',                    'pasivo',   'acreedora'),
  ('4212','Facturas por pagar - emitidas',           'pasivo',   'acreedora'),
  ('4691','Cuentas por pagar diversas',              'pasivo',   'acreedora'),
  ('601',  'Compras de mercaderías/suministros',     'gasto',    'deudora'),
  ('631',  'Transporte / servicios de terceros',     'gasto',    'deudora'),
  ('634',  'Mantenimiento y reparaciones',           'gasto',    'deudora'),
  ('656',  'Suministros - combustible (consumo)',    'gasto',    'deudora'),
  ('6811','Depreciación de IME - unidades de transporte','gasto','deudora'),
  ('7041','Prestación de servicios - transporte',    'ingreso',  'acreedora')
on conflict (codigo) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Periodos contables (apertura/cierre por mes).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.periodo_contable (
  periodo   text primary key,     -- 'AAAA-MM'
  estado    text not null default 'abierto' check (estado in ('abierto','cerrado')),
  cerrado_por text,
  fecha_cierre timestamptz
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Asientos (cabecera). total_debe = total_haber (partida doble). El CHECK exige
--    balance cuando el asiento está 'asentado'; en 'borrador' puede estar en construcción.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.asiento (
  id             bigserial primary key,
  numero         text unique,                       -- AS-AAAA-NNNNNN (trigger)
  periodo        text,                              -- 'AAAA-MM' (derivado de fecha)
  fecha          date not null default current_date,
  glosa          text,
  origen_tipo    text,                              -- factura|documento_compra|pago|depreciacion|manual
  origen_id      bigint,
  moneda         text not null default 'PEN',
  total_debe     numeric(14,2) not null default 0,
  total_haber    numeric(14,2) not null default 0,
  estado         text not null default 'borrador' check (estado in ('borrador','asentado','anulado')),
  creado_por     text,
  created_at     timestamptz not null default now(),
  constraint asiento_balanceado_chk
    check (estado <> 'asentado' or total_debe = total_haber)
);
create index if not exists idx_asiento_periodo on public.asiento (periodo);
create index if not exists idx_asiento_origen  on public.asiento (origen_tipo, origen_id);

create table if not exists public.asiento_detalle (
  id         bigserial primary key,
  asiento_id bigint not null references public.asiento(id) on delete cascade,
  cuenta     text not null references public.plan_cuentas(codigo),
  debe       numeric(14,2) not null default 0,
  haber      numeric(14,2) not null default 0,
  glosa      text,
  -- Analítica opcional (centro de costo por vehículo/cliente/servicio):
  vehiculo_id int,
  cliente_id  bigint,
  reserva_id  bigint,
  created_at timestamptz not null default now(),
  constraint asiento_detalle_una_via_chk check (debe = 0 or haber = 0)  -- una línea es debe XOR haber
);
create index if not exists idx_asiento_det on public.asiento_detalle (asiento_id);
create index if not exists idx_asiento_det_cuenta on public.asiento_detalle (cuenta);

-- Numeración AS-AAAA-NNNNNN.
create table if not exists public.asiento_secuencia (
  anio int primary key, ultimo int not null default 0
);
alter table public.asiento_secuencia enable row level security;

create or replace function public.fn_asiento_set_numero()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_anio int; v_n int;
begin
  if new.numero is not null and new.numero <> '' then return new; end if;
  v_anio := extract(year from coalesce(new.fecha, (now() at time zone 'America/Lima')::date))::int;
  insert into public.asiento_secuencia (anio, ultimo) values (v_anio, 1)
    on conflict (anio) do update set ultimo = asiento_secuencia.ultimo + 1
    returning ultimo into v_n;
  new.numero := 'AS-' || v_anio::text || '-' || lpad(v_n::text, 6, '0');
  if new.periodo is null then
    new.periodo := to_char(coalesce(new.fecha, (now() at time zone 'America/Lima')::date), 'YYYY-MM');
  end if;
  return new;
end $$;
drop trigger if exists trg_asiento_numero on public.asiento;
create trigger trg_asiento_numero before insert on public.asiento
  for each row execute function public.fn_asiento_set_numero();

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Activos fijos + depreciación. Los `vehiculos` son el maestro natural (FK opc).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.activos_fijos (
  id                 bigserial primary key,
  codigo             text unique,
  descripcion        text not null,
  categoria          text default 'unidad_transporte',  -- unidad_transporte|equipo|mobiliario|…
  cuenta_activo      text references public.plan_cuentas(codigo),  -- p.ej. 334
  cuenta_deprec      text references public.plan_cuentas(codigo),  -- p.ej. 3913 (acumulada)
  cuenta_gasto_deprec text references public.plan_cuentas(codigo), -- p.ej. 6811
  valor_adquisicion  numeric(14,2) not null default 0,
  valor_residual     numeric(14,2) not null default 0,
  fecha_alta         date not null default current_date,
  vida_util_meses    int not null default 60,          -- p.ej. 5 años unidades de transporte
  metodo             text not null default 'lineal',
  moneda             text not null default 'PEN',
  activo             boolean not null default true,
  created_at         timestamptz not null default now()
);
select public._fin_add_fk('activos_fijos','vehiculo_id','vehiculos');

create table if not exists public.depreciacion (
  id            bigserial primary key,
  activo_id     bigint not null references public.activos_fijos(id) on delete cascade,
  periodo       text not null,                          -- 'AAAA-MM'
  monto         numeric(14,2) not null default 0,
  acumulado     numeric(14,2) not null default 0,       -- snapshot acumulado a ese periodo
  asiento_id    bigint references public.asiento(id),   -- asiento generado
  created_at    timestamptz not null default now(),
  unique (activo_id, periodo)
);
create index if not exists idx_deprec_periodo on public.depreciacion (periodo);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Catálogos SUNAT mínimos (para XML/PLE de fases posteriores).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.cat_tipo_comprobante (
  codigo text primary key, descripcion text not null
);
insert into public.cat_tipo_comprobante (codigo, descripcion) values
  ('01','Factura'),('03','Boleta de venta'),('07','Nota de crédito'),
  ('08','Nota de débito'),('09','Guía de remisión'),('12','Ticket'),('R1','Recibo por honorarios')
on conflict (codigo) do nothing;

create table if not exists public.cat_tipo_nota_credito (
  codigo text primary key, descripcion text not null
);
insert into public.cat_tipo_nota_credito (codigo, descripcion) values
  ('01','Anulación de la operación'),('02','Anulación por error en el RUC'),
  ('03','Corrección por error en la descripción'),('04','Descuento global'),
  ('05','Descuento por ítem'),('06','Devolución total'),('07','Devolución por ítem'),
  ('13','Ajuste de operaciones de exportación')
on conflict (codigo) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) RLS.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['plan_cuentas','periodo_contable','asiento','asiento_detalle',
                           'activos_fijos','depreciacion','cat_tipo_comprobante','cat_tipo_nota_credito'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select tipo, count(*) from public.plan_cuentas group by 1;
-- Comprobar que un asiento cuadre:
--   select a.numero, a.total_debe, a.total_haber,
--          (select sum(debe) from asiento_detalle d where d.asiento_id=a.id) sd,
--          (select sum(haber) from asiento_detalle d where d.asiento_id=a.id) sh
--     from asiento a order by a.id desc limit 10;
