-- CRM IA: horas que la IA se aparta de un chat después de que respondió una persona.
-- No la corre el deploy. Sin la columna el motor usa 12 h.
alter table public.crm_agentes_ia add column if not exists pausa_humano_horas int not null default 12;
-- FIN de crm-ia-pausa-humano.sql
