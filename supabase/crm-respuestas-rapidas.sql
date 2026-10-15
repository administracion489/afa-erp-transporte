-- Respuestas rápidas del CRM: se escriben con «/atajo» en el chat. Compartidas por el equipo.
-- No la corre el deploy. Idempotente.
create table if not exists public.crm_respuestas_rapidas (
  id uuid primary key default gen_random_uuid(),
  atajo text not null unique,
  texto text not null,
  created_at timestamptz not null default now()
);
alter table public.crm_respuestas_rapidas enable row level security;
drop policy if exists crm_rr_equipo on public.crm_respuestas_rapidas;
create policy crm_rr_equipo on public.crm_respuestas_rapidas
  for all to authenticated using (true) with check (true);
revoke all on public.crm_respuestas_rapidas from anon;
-- FIN de crm-respuestas-rapidas.sql
