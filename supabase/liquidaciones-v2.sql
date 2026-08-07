-- ══════════════════════════════════════════════════════════════════════════════
-- LIQUIDACIONES v2 — "Formato de Liquidación y Conformidad del Servicio"
--
-- Reemplaza el diseño de supabase/finanzas-03-liquidaciones.sql (que nunca se corrió)
-- por uno que sí modela el formato real que AFA usa con sus clientes: el Excel
-- AFA-FL-07, una valorización por CLIENTE + SEDE (CD Callao, CD Trujillo, CD Piura,
-- CD Huachipa…) con líneas AGRUPADAS por ruta/turno/móvil, no una fila por servicio.
--
-- Es AUTOCONTENIDO a propósito: corre solo, sin exigir finanzas-00..03. Lo que sí
-- comparte con esos archivos (helper _fin_add_fk, config_tributaria, cat_detraccion,
-- columnas de auditoría en `reservas`) está copiado literal y con `if not exists`,
-- para que correr finanzas-00 después NO rompa nada y viceversa.
--
-- Qué crea:
--   1) _fin_add_fk           helper de FK con tipo resuelto en runtime (int vs bigint)
--   2) config_tributaria     IGV y detracción de-hardcodeados
--   3) documento_control     código/versión/vigencia del formato (AFA-FL-07 / AFA-FL-08)
--   4) cliente_sedes         el CD del cliente: quién aprueba, su correo y su WhatsApp
--   5) liquidacion_cliente   cabecera + conformidad multicanal por token
--      liquidacion_cliente_linea (+ _reserva)   líneas agrupadas y su trazabilidad
--   6) liquidacion_proveedor cabecera con detracción/anticipos + sus líneas
--   7) liquidacion_envio     bitácora de envíos (correo / WhatsApp / portal)
--      liquidacion_evento    bitácora del ciclo de vida
--   8) correlativos LQC-/LQP-AAAA-NNNNNN
--   9) columnas nuevas en `reservas` (dimensión C, sede, enlaces a liquidación)
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- Regla anti-duplicación: los montos se calculan en la app y se guardan como SNAPSHOT
-- en la liquidación; la factura / cuenta por pagar se DERIVA de ese snapshot.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Helper: agrega una columna-FK hacia una tabla EXISTENTE con el tipo correcto.
--    Idéntico al de finanzas-00 (create or replace ⇒ correr ambos es inofensivo).
--    Existe porque el esquema real solo vive en Supabase: `reservas.id` puede ser
--    integer o bigint y declararlo a ciegas rompe la migración.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public._fin_add_fk(
  p_table     text,
  p_col       text,
  p_ref_table text,
  p_ref_col   text default 'id',
  p_on_delete text default 'set null'
) returns void
language plpgsql
as $$
declare
  v_type text;
  v_cons text := format('fk_%s_%s', p_table, p_col);
begin
  select data_type into v_type
  from information_schema.columns
  where table_schema = 'public' and table_name = p_ref_table and column_name = p_ref_col;

  if v_type is null then
    raise notice '[_fin_add_fk] %.% no existe todavía → se omite la columna %.%',
      p_ref_table, p_ref_col, p_table, p_col;
    return;
  end if;

  v_type := case v_type
              when 'integer'  then 'integer'
              when 'bigint'   then 'bigint'
              when 'smallint' then 'integer'
              when 'uuid'     then 'uuid'
              else v_type
            end;

  execute format('alter table public.%I add column if not exists %I %s',
                 p_table, p_col, v_type);

  if not exists (select 1 from pg_constraint where conname = v_cons) then
    begin
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.%I(%I) on delete %s',
        p_table, v_cons, p_col, p_ref_table, p_ref_col, p_on_delete);
    exception when others then
      raise notice '[_fin_add_fk] No se pudo crear FK %.% → %.% (%): la columna queda sin FK',
        p_table, p_col, p_ref_table, p_ref_col, sqlerrm;
    end;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Configuración tributaria (fila única) + catálogo de detracción.
--    Copiado literal de finanzas-00 para que ambos archivos convivan.
--    ⚠️ Los % de detracción DEBEN confirmarse con el contador: aquí son dato editable.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.config_tributaria (
  id                 int primary key default 1 check (id = 1),
  igv_pct            numeric(6,4) not null default 18.0,
  moneda_base        text not null default 'PEN',
  redondeo_decimales int not null default 2,
  regimen            text,
  ubl_version        text not null default '2.1',
  detraccion_activa  boolean not null default true,
  updated_at         timestamptz not null default now()
);
insert into public.config_tributaria (id) values (1) on conflict (id) do nothing;

create table if not exists public.cat_detraccion (
  codigo      text primary key,
  descripcion text not null,
  porcentaje  numeric(6,4) not null,
  umbral_min  numeric(12,2) not null default 700,
  activo      boolean not null default true
);
insert into public.cat_detraccion (codigo, descripcion, porcentaje, umbral_min) values
  ('027', 'Transporte de personas',    10.0, 700),
  ('026', 'Transporte de bienes/carga', 4.0, 400),
  ('037', 'Demás servicios gravados',  12.0, 700)
on conflict (codigo) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Documentos controlados del SGC. La cabecera del PDF (macroproceso, proceso,
--    código, versión, vigencia) deja de estar tecleada en el Excel de cada mes.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.documento_control (
  codigo         text primary key,          -- 'AFA-FL-07'
  titulo         text not null,
  macro_proceso  text,
  proceso        text,
  subproceso     text,
  version        text not null default '01',
  vigencia_desde date,
  activo         boolean not null default true,
  updated_at     timestamptz not null default now()
);
insert into public.documento_control (codigo, titulo, macro_proceso, proceso, subproceso, version, vigencia_desde) values
  ('AFA-FL-07', 'Formato de Liquidación y Conformidad del Servicio',
   'Gestión Logística', 'Venta de bienes y servicios', 'No aplica', '03', date '2025-01-01'),
  ('AFA-FL-08', 'Formato de Liquidación y Conformidad del Servicio — Proveedor',
   'Gestión Logística', 'Compra de bienes y servicios', 'Tercerización de transporte', '01', date '2025-01-01')
on conflict (codigo) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Sedes / centros de distribución del cliente.
--    Hoy AFA lleva un Excel por CD y cada CD tiene su propio usuario que aprueba,
--    su cargo, su correo y su WhatsApp. Sin esta tabla esos datos se re-tipean cada
--    periodo y la conformidad no sabe a quién escribirle.
--
--    `patrones` alimenta la auto-asignación de servicios a la sede: si el nombre de
--    ruta, el origen, el destino o la dirección del servicio contienen alguno de los
--    textos, la reserva pertenece a esta sede. Es una AYUDA, no una verdad: la sede
--    definitiva queda escrita en reservas.cliente_sede_id.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.cliente_sedes (
  id                    bigserial primary key,
  nombre                text not null,            -- 'PEPSICO CD CALLAO'
  area_solicitante      text,                     -- va tal cual al formato
  servicio_contratado   text,                     -- 'SERVICIO DE TRANSPORTE DE PERSONAL / TURNO NOCHE'
  ubicacion_servicio    text,
  direccion             text,
  -- Quién firma la conformidad por parte del cliente (sección 1 y 4 del formato):
  usuario_solicita      text,                     -- 'MIGUEL CASTRO PORTELLA'
  cargo_solicita        text,                     -- 'SUPERVISOR DE RECURSOS HUMANOS'
  email_conformidad     text,
  whatsapp_conformidad  text,                     -- se normaliza a E.164 (+51…) en la app
  -- Copia opcional a administración/facturación del cliente:
  email_copia           text,
  orden_compra          text,                     -- OC/OS vigente del periodo
  moneda                text not null default 'PEN',
  detraccion_codigo     text,                     -- si este cliente detrae (cat_detraccion)
  patrones              text[] not null default '{}',
  activo                boolean not null default true,
  observaciones         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
select public._fin_add_fk('cliente_sedes', 'cliente_id', 'clientes', 'id', 'cascade');
create index if not exists idx_cliente_sedes_cliente on public.cliente_sedes (cliente_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) LIQUIDACIÓN AL CLIENTE — cabecera.
--    Estados: borrador → emitida → (conformada | observada) → facturada | anulada.
--    "emitida" = ya se generó el PDF y se envió; a partir de ahí los montos no se
--    tocan sin volver a borrador (el cliente ya vio ese documento).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_cliente (
  id                 bigserial primary key,
  codigo             text unique,                       -- LQC-AAAA-NNNNNN (trigger)
  documento_codigo   text not null default 'AFA-FL-07', -- → documento_control
  periodo            text,                              -- etiqueta legible del periodo
  periodo_desde      date,
  periodo_hasta      date,
  fecha              date not null default current_date,
  fecha_valorizacion date,
  moneda             text not null default 'PEN',
  estado             text not null default 'borrador'
                     check (estado in ('borrador','emitida','conformada','observada','facturada','anulada')),

  -- Snapshot de la sección 1 del formato (se precarga de cliente_sedes y es editable).
  area_solicitante    text,
  usuario_solicita    text,
  cargo_solicita      text,
  servicio_contratado text,
  ubicacion_servicio  text,
  orden_compra        text,

  -- Totales (snapshot; se recalculan desde las líneas mientras esté en borrador).
  -- `precios_incluyen_igv` resuelve la ambigüedad de reservas.precio_cliente: el formato
  -- AFA-FL-07 lista precios NETOS y suma el IGV abajo, pero en el ERP el precio puede
  -- haberse cargado con IGV incluido (ver cotizaciones.incluye_igv). Se decide por
  -- liquidación y queda escrito, para que el documento nunca salga 18% desviado.
  precios_incluyen_igv boolean not null default false,
  igv_pct   numeric(6,4) not null default 18.0,
  subtotal  numeric(14,2) not null default 0,   -- neto sin IGV, ya con adicionales y descuentos
  igv       numeric(14,2) not null default 0,
  total     numeric(14,2) not null default 0,

  -- Secciones 4 y 5 del formato.
  fecha_inicio_servicio date,
  fecha_fin_servicio    date,
  grado_satisfaccion    text,                    -- CONFORME | CONFORME CON OBSERVACIONES | NO CONFORME
  comentarios           text,
  documentacion_json    jsonb not null default '[]'::jsonb,  -- documentos entregados

  -- Conformidad multicanal (correo · WhatsApp · Portal del Cliente).
  token                 text unique,             -- enlace público /conformidad/<token>
  conformidad_estado    text not null default 'pendiente'
                        check (conformidad_estado in ('pendiente','conforme','observada')),
  conformidad_por       text,
  conformidad_cargo     text,
  conformidad_at        timestamptz,
  conformidad_ip        text,
  conformidad_canal     text,                    -- correo | whatsapp | portal | papel
  conformidad_sello     text,                    -- huella corta verificable en el QR
  conformidad_comentario text,
  vista_at              timestamptz,             -- primera vez que el cliente abrió el enlace
  enviada_at            timestamptz,

  -- Aguas abajo.
  factura_id       bigint,
  aprobada_por     text,
  fecha_aprobacion timestamptz,
  pdf_url          text,
  observaciones    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
select public._fin_add_fk('liquidacion_cliente', 'cliente_id', 'clientes');
select public._fin_add_fk('liquidacion_cliente', 'cliente_sede_id', 'cliente_sedes');
select public._fin_add_fk('liquidacion_cliente', 'factura_id', 'facturas');
create index if not exists idx_liq_cli_cliente on public.liquidacion_cliente (cliente_id);
create index if not exists idx_liq_cli_sede    on public.liquidacion_cliente (cliente_sede_id);
create index if not exists idx_liq_cli_estado  on public.liquidacion_cliente (estado);
create index if not exists idx_liq_cli_periodo on public.liquidacion_cliente (periodo_desde, periodo_hasta);

-- Línea AGRUPADA de la valorización: es lo que el cliente lee y firma.
--   tipo='servicio'  → N servicios de la misma ruta/turno/móvil a la misma tarifa
--   tipo='adicional' → servicio extra o concepto adicional autorizado
--   tipo='penalidad' / 'descuento' → restan (se guardan en positivo, el signo lo pone `tipo`)
--
-- cantidad_programada / cantidad_ejecutada son la EVIDENCIA; `cantidad` es lo que se
-- cobra. Arrancan iguales a la ejecutada; si el operador la cambia, queda registrado
-- quién y por qué (decisión del negocio: "ejecutados, pero editable").
create table if not exists public.liquidacion_cliente_linea (
  id                  bigserial primary key,
  liquidacion_id      bigint not null references public.liquidacion_cliente(id) on delete cascade,
  item                int not null default 1,
  tipo                text not null default 'servicio'
                      check (tipo in ('servicio','adicional','penalidad','descuento')),
  descripcion         text not null,
  unidad_medida       text not null default 'SERV.',
  cantidad_programada numeric(12,2),
  cantidad_ejecutada  numeric(12,2),
  cantidad            numeric(12,2) not null default 0,
  cantidad_motivo     text,
  cantidad_editada_por text,
  cantidad_editada_at timestamptz,
  precio_unitario     numeric(14,2) not null default 0,
  orden_compra        text,
  total_linea         numeric(14,2) not null default 0,   -- ± cantidad × precio (snapshot)
  agrupacion_clave    text,                                -- huella ruta|turno|móvil|tarifa
  referencia          text,                                -- 'A-01 a A-26' → Anexo 1
  created_at          timestamptz not null default now()
);
create index if not exists idx_liq_cli_linea on public.liquidacion_cliente_linea (liquidacion_id);

-- Puente línea ↔ reservas: la trazabilidad que alimenta el Anexo 1 y evita
-- que un mismo servicio entre en dos liquidaciones.
create table if not exists public.liquidacion_cliente_linea_reserva (
  id       bigserial primary key,
  linea_id bigint not null references public.liquidacion_cliente_linea(id) on delete cascade
);
select public._fin_add_fk('liquidacion_cliente_linea_reserva', 'reserva_id', 'reservas', 'id', 'cascade');
create unique index if not exists uq_liq_cli_linea_reserva
  on public.liquidacion_cliente_linea_reserva (linea_id, reserva_id);
create index if not exists idx_liq_cli_lr_reserva
  on public.liquidacion_cliente_linea_reserva (reserva_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6) LIQUIDACIÓN AL PROVEEDOR (tercerizados) — mismo formato, invertido: aquí AFA
--    es quien da la conformidad. Estados: borrador → emitida → conformada →
--    por_pagar → pagada | anulada.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_proveedor (
  id                 bigserial primary key,
  codigo             text unique,                        -- LQP-AAAA-NNNNNN
  documento_codigo   text not null default 'AFA-FL-08',
  periodo            text,
  periodo_desde      date,
  periodo_hasta      date,
  fecha              date not null default current_date,
  fecha_valorizacion date,
  moneda             text not null default 'PEN',
  estado             text not null default 'borrador'
                     check (estado in ('borrador','emitida','conformada','por_pagar','pagada','anulada')),

  servicio_contratado text,
  ubicacion_servicio  text,
  orden_compra        text,
  cuenta_detraccion   text,
  responsable_afa     text,      -- quién da la conformidad por AFA
  cargo_responsable   text,

  precios_incluyen_igv boolean not null default false,  -- ver liquidacion_cliente
  igv_pct          numeric(6,4) not null default 18.0,
  subtotal         numeric(14,2) not null default 0,
  igv              numeric(14,2) not null default 0,
  total_comprobante numeric(14,2) not null default 0,  -- subtotal + IGV (lo que factura el tercero)
  detraccion_codigo text,
  detraccion_pct   numeric(6,4),
  detraccion_monto numeric(14,2) not null default 0,
  anticipos        numeric(14,2) not null default 0,
  total            numeric(14,2) not null default 0,   -- NETO a pagar

  fecha_inicio_servicio date,
  fecha_fin_servicio    date,
  evaluacion            text,     -- CONFORME | CONFORME CON OBSERVACIONES | NO CONFORME
  comentarios           text,
  requisitos_json       jsonb not null default '[]'::jsonb,  -- condiciones para el pago

  token              text unique,
  conformidad_estado text not null default 'pendiente'
                     check (conformidad_estado in ('pendiente','conforme','observada')),
  conformidad_por    text,
  conformidad_at     timestamptz,
  conformidad_ip     text,
  conformidad_canal  text,
  conformidad_sello  text,
  conformidad_comentario text,
  vista_at           timestamptz,
  enviada_at         timestamptz,

  documento_compra_id bigint,     -- CxP generada al aprobar (si existe el módulo de compras)
  aprobada_por        text,
  fecha_aprobacion    timestamptz,
  pdf_url             text,
  observaciones       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
select public._fin_add_fk('liquidacion_proveedor', 'empresa_tercerizada_id', 'empresas_tercerizadas');
select public._fin_add_fk('liquidacion_proveedor', 'proveedor_id', 'proveedores');
select public._fin_add_fk('liquidacion_proveedor', 'documento_compra_id', 'documentos_compra');
create index if not exists idx_liq_prov_emp    on public.liquidacion_proveedor (empresa_tercerizada_id);
create index if not exists idx_liq_prov_estado on public.liquidacion_proveedor (estado);

create table if not exists public.liquidacion_proveedor_linea (
  id                  bigserial primary key,
  liquidacion_id      bigint not null references public.liquidacion_proveedor(id) on delete cascade,
  item                int not null default 1,
  tipo                text not null default 'servicio'
                      check (tipo in ('servicio','adicional','penalidad','descuento')),
  descripcion         text not null,
  unidad_medida       text not null default 'SERV.',
  cantidad_programada numeric(12,2),
  cantidad_ejecutada  numeric(12,2),
  cantidad            numeric(12,2) not null default 0,
  cantidad_motivo     text,
  cantidad_editada_por text,
  cantidad_editada_at timestamptz,
  precio_unitario     numeric(14,2) not null default 0,
  orden_compra        text,
  total_linea         numeric(14,2) not null default 0,
  agrupacion_clave    text,
  referencia          text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_liq_prov_linea on public.liquidacion_proveedor_linea (liquidacion_id);

create table if not exists public.liquidacion_proveedor_linea_reserva (
  id       bigserial primary key,
  linea_id bigint not null references public.liquidacion_proveedor_linea(id) on delete cascade
);
select public._fin_add_fk('liquidacion_proveedor_linea_reserva', 'reserva_id', 'reservas', 'id', 'cascade');
create unique index if not exists uq_liq_prov_linea_reserva
  on public.liquidacion_proveedor_linea_reserva (linea_id, reserva_id);
create index if not exists idx_liq_prov_lr_reserva
  on public.liquidacion_proveedor_linea_reserva (reserva_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 7) Bitácoras: a quién se le envió y qué pasó con el documento.
--    Sin esto, "el cliente dice que nunca le llegó" no se puede responder.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.liquidacion_envio (
  id             bigserial primary key,
  entidad        text not null check (entidad in ('cliente','proveedor')),
  liquidacion_id bigint not null,
  canal          text not null check (canal in ('correo','whatsapp','portal','manual')),
  destino        text,                       -- correo o número al que se envió
  destinatario   text,                       -- nombre de la persona
  estado         text not null default 'enviado'
                 check (estado in ('enviado','fallido','omitido')),
  detalle        text,                       -- id del mensaje o el error
  enviado_por    text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_liq_envio on public.liquidacion_envio (entidad, liquidacion_id);

create table if not exists public.liquidacion_evento (
  id             bigserial primary key,
  entidad        text not null check (entidad in ('cliente','proveedor')),
  liquidacion_id bigint not null,
  evento         text not null,              -- creada|emitida|enviada|vista|conformada|observada|facturada|anulada
  detalle        text,
  usuario        text,
  ip             text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_liq_evento on public.liquidacion_evento (entidad, liquidacion_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 8) Correlativos LQC-/LQP-AAAA-NNNNNN + token público + updated_at.
--    Mismo patrón atómico (SECURITY DEFINER) que el resto del ERP.
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

-- El token viaja por correo y WhatsApp: es la llave del enlace público, así que se
-- genera en la BD (no en el cliente) y nunca se reutiliza.
create or replace function public.trg_liq_cliente_defaults()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then new.codigo := public.fn_liq_set_codigo('LQC'); end if;
  if new.token  is null or new.token  = '' then new.token  := replace(gen_random_uuid()::text, '-', ''); end if;
  return new;
end $$;
drop trigger if exists trg_liq_cli_defaults on public.liquidacion_cliente;
create trigger trg_liq_cli_defaults before insert on public.liquidacion_cliente
  for each row execute function public.trg_liq_cliente_defaults();

create or replace function public.trg_liq_proveedor_defaults()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then new.codigo := public.fn_liq_set_codigo('LQP'); end if;
  if new.token  is null or new.token  = '' then new.token  := replace(gen_random_uuid()::text, '-', ''); end if;
  return new;
end $$;
drop trigger if exists trg_liq_prov_defaults on public.liquidacion_proveedor;
create trigger trg_liq_prov_defaults before insert on public.liquidacion_proveedor
  for each row execute function public.trg_liq_proveedor_defaults();

create or replace function public.liq_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['liquidacion_cliente','liquidacion_proveedor','cliente_sedes','documento_control'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_upd_' || t, t);
    execute format('create trigger %I before update on public.%I for each row execute function public.liq_set_updated_at()',
                   'trg_upd_' || t, t);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9) Columnas nuevas en `reservas`: dimensión C (proveedor), sede y enlaces.
--    Idéntico a finanzas-00 punto 4 + cliente_sede_id.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas add column if not exists estado_proveedor text;
alter table public.reservas drop constraint if exists reservas_estado_proveedor_check;
alter table public.reservas
  add constraint reservas_estado_proveedor_check
  check (estado_proveedor is null or estado_proveedor in
    ('por_conciliar','conciliada','por_pagar','pagada'));

alter table public.reservas add column if not exists fecha_liquidacion    timestamptz;
alter table public.reservas add column if not exists fecha_facturacion    timestamptz;
alter table public.reservas add column if not exists fecha_cobro          timestamptz;
alter table public.reservas add column if not exists fecha_pago_proveedor timestamptz;
alter table public.reservas add column if not exists liquidacion_cliente_id   bigint;
alter table public.reservas add column if not exists liquidacion_proveedor_id bigint;
select public._fin_add_fk('reservas', 'cliente_sede_id', 'cliente_sedes');

create index if not exists idx_reservas_estado_proveedor on public.reservas (estado_proveedor);
create index if not exists idx_reservas_sede             on public.reservas (cliente_sede_id);
-- La consulta que más pesa: "servicios por liquidar de este cliente en este periodo".
create index if not exists idx_reservas_liq_cliente
  on public.reservas (cliente_id, estado_admin, fecha_servicio);

-- Los servicios tercerizados ya finalizados arrancan la dimensión C.
update public.reservas
   set estado_proveedor = 'por_conciliar'
 where estado = 'finalizada'
   and estado_proveedor is null
   and coalesce(tipo_asignacion, '') = 'tercerizado';

-- ────────────────────────────────────────────────────────────────────────────
-- 10) RLS. Todo el acceso normal es de usuarios autenticados del ERP.
--     La página pública de conformidad NO lee estas tablas directo: pasa por una
--     API route con service-role que valida el token (ver app/api/liquidaciones/*).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'cliente_sedes','documento_control',
    'liquidacion_cliente','liquidacion_cliente_linea','liquidacion_cliente_linea_reserva',
    'liquidacion_proveedor','liquidacion_proveedor_linea','liquidacion_proveedor_linea_reserva',
    'liquidacion_envio','liquidacion_evento'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select codigo, titulo, version from public.documento_control;
-- select * from public.cliente_sedes order by cliente_id, nombre;
-- select codigo, estado, periodo, total, conformidad_estado from public.liquidacion_cliente order by id desc limit 10;
-- select count(*) filter (where cliente_sede_id is null) as sin_sede from public.reservas;
