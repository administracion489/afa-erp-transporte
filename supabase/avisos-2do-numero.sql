-- ============================================================
-- 2do número WhatsApp (905438216) — avisos a pasajeros/conductores + Campañas
-- Ejecutar en Supabase SQL Editor. Idempotente (IF NOT EXISTS / DROP NOT NULL).
-- ============================================================
-- Contexto:
--   • El nuevo número vive bajo la MISMA WABA "Afa Transporte" que el CRM.
--   • Es un número de solo-salida (Cloud API puro, sin coexistencia).
--   • Env var única para los 3 usos: META_PHONE_NUMBER_ID_AVISOS
--     (fallback legacy: META_PHONE_NUMBER_ID_PASAJEROS).
-- ============================================================

-- ── 0) VERIFICACIÓN PREVIA (solo lectura) ─────────────────────────────────
--    ¿notificaciones_enviadas tiene un CHECK que restrinja `tipo`? Si sí y no
--    incluye 'whatsapp'/'email'/'push', el log de conductor fallaría en silencio.
select c.conname, pg_get_constraintdef(c.oid) as definicion
from pg_constraint c
join pg_class t     on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'notificaciones_enviadas'
  and c.contype = 'c';

-- ── 1) LOG: admitir destinatario CONDUCTOR ────────────────────────────────
--    Hoy la tabla asume pasajero_id. Un aviso a conductor no tiene pasajero:
--    dejamos pasajero_id nullable y agregamos conductor_id (uno u otro).
alter table public.notificaciones_enviadas
  add column if not exists conductor_id bigint;

-- Quitar NOT NULL de pasajero_id si lo tuviera (no-op si ya es nullable).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notificaciones_enviadas'
      and column_name  = 'pasajero_id'
      and is_nullable  = 'NO'
  ) then
    alter table public.notificaciones_enviadas alter column pasajero_id drop not null;
  end if;
end$$;

create index if not exists idx_notif_conductor on public.notificaciones_enviadas(conductor_id);

-- ── 2) CONSENTIMIENTO WHATSAPP / EMAIL en contactos del CRM ────────────────
--    Meta EXIGE opt-in para plantillas de MARKETING (campañas). Regla que
--    aplicamos: quien te escribe por WhatsApp queda opt-in automáticamente
--    (se setea en el webhook). Los prospectos en frío (nunca escribieron)
--    NO reciben WhatsApp de marketing → se les contacta por email.
alter table public.crm_contactos
  add column if not exists wa_opt_in     boolean     default false,
  add column if not exists wa_opt_in_at  timestamptz,
  add column if not exists wa_baja       boolean     default false,   -- respondió BAJA/STOP
  add column if not exists wa_baja_at    timestamptz,
  add column if not exists email_baja    boolean     default false,
  add column if not exists email_baja_at timestamptz;

create index if not exists idx_contacto_wa_optin on public.crm_contactos(wa_opt_in) where wa_opt_in = true;

-- ── 3) CAMPAÑAS ────────────────────────────────────────────────────────────
create table if not exists public.campanas (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null,
  canal          text not null default 'whatsapp' check (canal in ('whatsapp','email')),
  -- WhatsApp: nombre de la plantilla MARKETING aprobada en Meta + idioma + params
  plantilla      text,
  idioma         text default 'es',
  parametros     jsonb default '[]'::jsonb,   -- variables fijas {{1}},{{2}}… de la plantilla
  -- Email: asunto + cuerpo HTML
  asunto         text,
  cuerpo         text,
  -- Audiencia (descriptor declarativo; el backend resuelve la lista)
  audiencia      jsonb default '{}'::jsonb,    -- { tipo:'crm', filtro:{...} }
  estado         text not null default 'borrador'
                 check (estado in ('borrador','enviando','enviada','cancelada')),
  programada_para timestamptz,
  total          int default 0,
  enviados       int default 0,
  errores        int default 0,
  omitidos       int default 0,
  creada_por     uuid references public.usuarios(id),
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create table if not exists public.campanas_envios (
  id           uuid primary key default gen_random_uuid(),
  campana_id   uuid not null references public.campanas(id) on delete cascade,
  contacto_id  uuid references public.crm_contactos(id) on delete set null,
  destinatario text not null,                 -- teléfono E.164 o email (email en minúsculas)
  estado       text not null default 'pendiente'
               check (estado in ('pendiente','procesando','enviado','error','omitido')),
  motivo       text,                           -- p.ej. 'sin_optin', 'baja'
  meta_message_id text,
  error        text,
  created_at    timestamptz default now(),
  procesando_at timestamptz,                   -- cuándo lo reclamó un worker (recuperación)
  enviado_at    timestamptz
);

-- Idempotencia POR DESTINATARIO (no por contacto): dos contactos distintos con el
-- mismo correo no deben recibir la campaña dos veces. destinatario es NOT NULL, así
-- que sirve de árbitro de ON CONFLICT (índice NO parcial → válido para PostgREST).
create unique index if not exists uq_campana_destinatario
  on public.campanas_envios(campana_id, destinatario);

create index if not exists idx_envios_campana   on public.campanas_envios(campana_id);
create index if not exists idx_envios_pendiente on public.campanas_envios(estado) where estado = 'pendiente';

-- RECLAMO ATÓMICO de un lote: evita el doble envío cuando el cron y el botón
-- "Continuar" (o un doble clic) procesan la misma campaña a la vez. FOR UPDATE SKIP
-- LOCKED entrega lotes DISJUNTOS a workers concurrentes. Devuelve las filas ya
-- marcadas 'procesando' para que el llamador solo trabaje lo que reclamó.
create or replace function public.reclamar_envios(p_campana uuid, p_max int)
returns setof public.campanas_envios
language plpgsql
as $$
begin
  return query
  update public.campanas_envios
     set estado = 'procesando', procesando_at = now()
   where id in (
     select id from public.campanas_envios
      where campana_id = p_campana and estado = 'pendiente'
      order by created_at
      limit p_max
      for update skip locked
   )
  returning *;
end$$;

-- ── 4) RLS — SOLO usuarios autenticados (campanas_envios contiene PII: teléfonos
--    y correos de la audiencia). NO usar using(true): eso deja el rol anon (la
--    NEXT_PUBLIC_SUPABASE_ANON_KEY viaja al navegador) leer/borrar la lista entera.
--    El backend usa service-role, que omite RLS, así que sigue funcionando.
alter table public.campanas        enable row level security;
alter table public.campanas_envios enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='campanas' and policyname='campanas_auth') then
    create policy "campanas_auth" on public.campanas
      for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename='campanas_envios' and policyname='campanas_envios_auth') then
    create policy "campanas_envios_auth" on public.campanas_envios
      for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
  end if;
end$$;

-- Smoke test:
-- select count(*) from public.campanas;
-- select count(*) from public.campanas_envios;
-- select column_name, is_nullable from information_schema.columns
--   where table_name='notificaciones_enviadas' and column_name in ('pasajero_id','conductor_id');
