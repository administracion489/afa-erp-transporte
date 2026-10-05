-- ══════════════════════════════════════════════════════════════════════════════
-- COMBUSTIBLE · FASE 03 — Saldo de la cuenta prepago (Primax) con aviso por correo y
-- WhatsApp, y la FACTURA del correo como respaldo oficial del Radar IA.
--
-- Motores PUROS: lib/combustible/saldo-cuenta.ts y lib/combustible/factura-lineas.ts.
-- Pantalla: /combustible (tarjeta «Saldo de combustible» + pestaña «📧 Facturas»).
-- Crons: /api/combustible/saldo (cada hora) y /api/combustible/facturas (cada 3 h).
--
-- NO LA CORRE EL DEPLOY. Supabase → SQL Editor → pegar y ejecutar. Idempotente.
-- Sin ella, /combustible lo dice en ámbar nombrando este archivo y nada más cambia.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) La cuenta prepago. El saldo NO se guarda: se DERIVA (regla de oro) de la última
--    lectura del portal + abonos − cargas. Aquí solo vive su configuración.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.combustible_cuentas (
  id                 bigserial primary key,
  nombre             text not null default 'Primax',
  activo             boolean not null default true,
  -- Cómo reconoce el ERP una carga de esta cuenta (combustible.grifo / ruc_proveedor).
  -- COESTI S.A. (RUC 20127765279) es la operadora de las estaciones Primax.
  patrones_grifo     text[] not null default '{PRIMAX,COESTI}',
  rucs               text[] not null default '{20127765279}',
  incluye_terceros   boolean not null default false,
  -- Escalones de aviso en soles. El agotamiento (S/ 0) se avisa siempre.
  umbrales           numeric[] not null default '{500,300}',
  avisar_correos     text,                      -- separados por coma
  avisar_telefonos   text,                      -- separados por coma (WhatsApp, plantilla coordinador_alerta)
  -- Estado del ciclo de avisos: el escalón más bajo ya avisado (null = rearmado).
  ultimo_umbral_avisado numeric,
  ultimo_aviso_en    timestamptz,
  -- Facturas por correo (Gmail conectado en /crm):
  correo_filtro      text not null default 'from:(primax OR coesti OR primaxsolutions) has:attachment',
  facturas_auto_registrar boolean not null default true,
  facturas_gracia_dias    int not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Abonos (depósitos a la cuenta) y LECTURAS (el saldo que dice el portal: el ancla).
create table if not exists public.combustible_cuenta_movimientos (
  id          bigserial primary key,
  cuenta_id   bigint not null references public.combustible_cuentas(id) on delete cascade,
  tipo        text not null check (tipo in ('abono','lectura')),
  monto       numeric(14,2) not null,
  fecha       date not null,
  nro_operacion text,
  nota        text,
  usuario_id  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_comb_cta_mov on public.combustible_cuenta_movimientos (cuenta_id, fecha);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) La bandeja de facturas. Normalmente ya existe (finanzas-05-facturas-correo.sql);
--    si no se corrió, se crea aquí con la misma forma.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.radar_facturas (
  id                  bigserial primary key,
  gmail_message_id    text unique,
  remitente_email     text,
  asunto              text,
  recibido_en         timestamptz not null default now(),
  pdf_url             text,
  xml_url             text,
  estado              text not null default 'pendiente',
  ruc_emisor          text,
  razon_social        text,
  tipo_comprobante    text,
  serie               text,
  numero              text,
  fecha_emision       date,
  moneda              text,
  subtotal            numeric(14,2),
  igv                 numeric(14,2),
  total               numeric(14,2),
  detraccion_monto    numeric(14,2),
  placa_detectada     text,
  confianza           numeric,
  fuente_extraccion   text,
  datos_ia            jsonb,
  documento_compra_id bigint references public.documentos_compra(id) on delete set null,
  diferencia_detalle  text,
  tokens_entrada      int default 0,
  tokens_salida       int default 0,
  costo_usd           numeric default 0,
  procesada_en        timestamptz,
  error               text
);

-- Lo nuevo: las líneas leídas y la decisión por línea (lib/combustible/factura-lineas.ts).
alter table public.radar_facturas add column if not exists lineas       jsonb;
alter table public.radar_facturas add column if not exists conciliacion jsonb;
alter table public.radar_facturas add column if not exists cuenta_id    bigint references public.combustible_cuentas(id) on delete set null;

-- El CHECK de finanzas-05 no conoce 'parcial' ni 'sin_adjunto'. Se reemplaza por uno que sí.
alter table public.radar_facturas drop constraint if exists radar_facturas_estado_check;
alter table public.radar_facturas add constraint radar_facturas_estado_check
  check (estado in ('pendiente','procesada','conciliada','con_diferencia','parcial','descartada','sin_adjunto','error'));

-- ────────────────────────────────────────────────────────────────────────────
-- 3) RLS: solo usuarios del ERP (la anon key es pública — ver seguridad-01-rls.sql).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.combustible_cuentas enable row level security;
drop policy if exists combustible_cuentas_auth on public.combustible_cuentas;
create policy combustible_cuentas_auth on public.combustible_cuentas
  for all to authenticated using (true) with check (true);

alter table public.combustible_cuenta_movimientos enable row level security;
drop policy if exists combustible_cuenta_mov_auth on public.combustible_cuenta_movimientos;
create policy combustible_cuenta_mov_auth on public.combustible_cuenta_movimientos
  for all to authenticated using (true) with check (true);

alter table public.radar_facturas enable row level security;
drop policy if exists radar_facturas_auth on public.radar_facturas;
create policy radar_facturas_auth on public.radar_facturas
  for all to authenticated using (true) with check (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Una cuenta de arranque. No siembra correos ni teléfonos ni saldo: eso lo decide
--    una persona en /combustible (este ERP se vende).
-- ────────────────────────────────────────────────────────────────────────────
insert into public.combustible_cuentas (nombre)
select 'Primax'
where not exists (select 1 from public.combustible_cuentas);

-- Verificación:
-- select * from public.combustible_cuentas;
-- select estado, count(*) from public.radar_facturas group by 1;
