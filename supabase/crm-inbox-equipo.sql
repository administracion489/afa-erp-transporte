-- CRM · trabajo en equipo: asignación, etiquetas y notas internas. No la corre el deploy.
-- Idempotente.
alter table public.crm_conversaciones add column if not exists asignado_a uuid;
alter table public.crm_conversaciones add column if not exists etiquetas text[] not null default '{}';
create index if not exists idx_crm_conv_asignado on public.crm_conversaciones (asignado_a);

-- Notas internas: las ve el equipo en el hilo, NUNCA el cliente (no van a crm_mensajes,
-- así la IA y el envío no las tocan).
create table if not exists public.crm_notas (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references public.crm_conversaciones(id) on delete cascade,
  texto text not null,
  autor_id uuid,
  autor_nombre text,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_notas_conv on public.crm_notas (conversacion_id, created_at);
alter table public.crm_notas enable row level security;
drop policy if exists crm_notas_equipo on public.crm_notas;
create policy crm_notas_equipo on public.crm_notas
  for all to authenticated using (true) with check (true);
revoke all on public.crm_notas from anon;
-- FIN de crm-inbox-equipo.sql
