-- ============================================================
-- COMUNICADOS — envíos masivos (WhatsApp + Correo) a los pasajeros de una empresa cliente.
-- Ejecutar en el SQL Editor de Supabase. Idempotente (IF NOT EXISTS / on conflict).
-- ============================================================
-- Contexto:
--   • Motor calcado del de Campañas del CRM (avisos-2do-numero.sql), pero con TABLAS
--     PROPIAS para no mezclar avisos operativos a pasajeros con el marketing del CRM.
--   • WhatsApp sale del número de AVISOS (META_PHONE_NUMBER_ID_AVISOS), no del CRM.
--   • Los adjuntos (imágenes de los cuadros de horario + un PDF) se guardan en el
--     bucket público `comunicados-media`; Meta y Resend los leen por URL pública.
--   • cliente_id / pasajero_id se guardan SIN FK a propósito: las tablas base
--     (clientes, pasajeros) se crearon en el panel y su tipo de PK no está versionado;
--     evitamos un FK que podría fallar por incompatibilidad int4/int8. La integridad la
--     mantiene la app.
-- ============================================================

-- ── 1) COMUNICADOS ───────────────────────────────────────────────────────────
create table if not exists public.comunicados (
  id               uuid primary key default gen_random_uuid(),
  titulo           text not null,
  cliente_id       bigint,                              -- empresa cliente (clientes.id)
  canales          text[] not null default array['whatsapp','email']::text[],
  -- Correo
  asunto           text,
  cuerpo_html      text,                                -- HTML; admite {{nombre}} / {{empresa}}
  -- WhatsApp (plantilla Meta con encabezado de DOCUMENTO)
  mensaje_wa       text,                                -- variable {{2}} del cuerpo de la plantilla
  wa_plantilla     text,                                -- nombre de la plantilla aprobada en Meta
  wa_idioma        text default 'es',
  -- Adjuntos
  adjuntos         jsonb default '[]'::jsonb,           -- [{ url, nombre, tipo, esImagen }]
  wa_pdf_url       text,                                -- PDF único: encabezado WA + adjunto de correo
  solo_nomina_fija boolean default true,                -- pasajeros con reserva_id IS NULL
  -- Estado + contadores (fuente de verdad = comunicados_envios)
  estado           text not null default 'borrador'
                   check (estado in ('borrador','enviando','enviada','cancelada')),
  total            int default 0,
  enviados         int default 0,
  errores          int default 0,
  omitidos         int default 0,
  creada_por       uuid references public.usuarios(id),
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── 2) ENVÍOS (una fila por destinatario × canal) ────────────────────────────
create table if not exists public.comunicados_envios (
  id              uuid primary key default gen_random_uuid(),
  comunicado_id   uuid not null references public.comunicados(id) on delete cascade,
  pasajero_id     bigint,
  nombre          text,
  canal           text not null check (canal in ('whatsapp','email')),
  destinatario    text not null,                        -- teléfono E.164 o email (minúsculas)
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente','procesando','enviado','error','omitido')),
  motivo          text,
  meta_message_id text,
  error           text,
  created_at      timestamptz default now(),
  procesando_at   timestamptz,                          -- reclamo por un worker (recuperación)
  enviado_at      timestamptz
);

-- Idempotencia por (comunicado, canal, destinatario): re-sembrar no duplica envíos.
create unique index if not exists uq_comunicado_dest
  on public.comunicados_envios(comunicado_id, canal, destinatario);
create index if not exists idx_com_envios_comunicado on public.comunicados_envios(comunicado_id);
create index if not exists idx_com_envios_pendiente  on public.comunicados_envios(estado) where estado = 'pendiente';

-- ── 3) RECLAMO ATÓMICO de un lote (evita doble envío entre cron y botón) ──────
create or replace function public.reclamar_comunicados(p_comunicado uuid, p_max int)
returns setof public.comunicados_envios
language plpgsql
as $$
begin
  return query
  update public.comunicados_envios
     set estado = 'procesando', procesando_at = now()
   where id in (
     select id from public.comunicados_envios
      where comunicado_id = p_comunicado and estado = 'pendiente'
      order by created_at
      limit p_max
      for update skip locked
   )
  returning *;
end$$;

-- ── 4) RLS — SOLO autenticados (las filas de envío contienen PII: teléfonos/correos).
--    El backend usa service-role (omite RLS), así que sigue funcionando.
alter table public.comunicados        enable row level security;
alter table public.comunicados_envios enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='comunicados' and policyname='comunicados_auth') then
    create policy "comunicados_auth" on public.comunicados
      for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename='comunicados_envios' and policyname='comunicados_envios_auth') then
    create policy "comunicados_envios_auth" on public.comunicados_envios
      for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
  end if;
end$$;

-- ── 5) BUCKET PÚBLICO para adjuntos (imágenes + PDF) ─────────────────────────
insert into storage.buckets (id, name, public)
values ('comunicados-media', 'comunicados-media', true)
on conflict (id) do nothing;

-- Lectura pública (bucket público) + escritura/borrado por usuarios autenticados.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='comunicados_media_read') then
    create policy "comunicados_media_read" on storage.objects
      for select using (bucket_id = 'comunicados-media');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='comunicados_media_write') then
    create policy "comunicados_media_write" on storage.objects
      for insert to authenticated with check (bucket_id = 'comunicados-media');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='comunicados_media_delete') then
    create policy "comunicados_media_delete" on storage.objects
      for delete to authenticated using (bucket_id = 'comunicados-media');
  end if;
end$$;

-- Smoke test:
-- select count(*) from public.comunicados;
-- select count(*) from public.comunicados_envios;
-- select id, name, public from storage.buckets where id = 'comunicados-media';
