-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS/IA · FASE 4 — Ingesta de facturas de proveedor por correo (enriquecer,
--                        no duplicar)
--
-- Requiere: finanzas-00..03 (documentos_compra).
--
-- Pipeline: correo (Gmail) → adjunto PDF/XML → IA extrae RUC/serie/número/IGV/total →
-- CONCILIA contra un documento_compra existente (por UNIQUE fiscal) o contra una carga
-- ya capturada por el Radar (radar_combustible por comprobante/placa/fecha/monto) →
-- hace UPDATE de la cadena existente (radar_combustible → combustible → documentos_compra),
-- JAMÁS un INSERT nuevo que duplique el gasto.
--
-- radar_facturas es la bandeja de correos-factura (crudo + extracción + estado de
-- conciliación). Reutiliza el patrón de radar_mensajes y radar_config.limite_diario_usd.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Enlace: la carga capturada por el Radar apunta al comprobante de compra fiscal.
--    Ese es el "anclaje" que evita el segundo registro: la factura entrante enriquece
--    ESTA fila, no crea otra.
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('radar_combustible','documento_compra_id','documentos_compra');

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Bandeja de facturas recibidas por correo.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.radar_facturas (
  id                  bigserial primary key,
  gmail_message_id    text unique,               -- dedupe por correo
  remitente_email     text,
  asunto              text,
  recibido_en         timestamptz not null default now(),
  -- Adjuntos (guardados en bucket facturas-media):
  pdf_url             text,
  xml_url             text,
  -- Extracción de la IA (visión sobre PDF y/o parse del XML UBL):
  estado              text not null default 'pendiente'  -- pendiente|procesada|conciliada|con_diferencia|descartada|error
                      check (estado in ('pendiente','procesada','conciliada','con_diferencia','descartada','error')),
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
  fuente_extraccion   text,                       -- 'xml_ubl' | 'vision_pdf'
  datos_ia            jsonb,                       -- extracción cruda para auditoría
  -- Resultado de la conciliación:
  documento_compra_id bigint references public.documentos_compra(id) on delete set null,
  radar_combustible_id uuid references public.radar_combustible(id) on delete set null,
  diferencia_detalle  text,
  tokens_entrada      int default 0,
  tokens_salida       int default 0,
  costo_usd           numeric default 0,
  procesada_en        timestamptz,
  error               text
);
create index if not exists idx_radar_facturas_estado on public.radar_facturas (estado);
create index if not exists idx_radar_facturas_fiscal on public.radar_facturas (ruc_emisor, serie, numero);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Bucket de adjuntos de correo (PDF/XML), análogo a radar-media.
-- ────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('facturas-media', 'facturas-media', true)
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS + realtime para la bandeja.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.radar_facturas enable row level security;
drop policy if exists radar_facturas_auth on public.radar_facturas;
create policy radar_facturas_auth on public.radar_facturas
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

do $$
begin
  begin
    alter publication supabase_realtime add table radar_facturas;
  exception when duplicate_object then null;
  end;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select estado, count(*) from public.radar_facturas group by 1;
