-- CRM IA: comportamiento editable del agente (/crm/agente → Ajustes). No la corre el deploy.
-- Idempotente. Sin estas columnas el agente usa los valores por defecto del código.
-- comportamiento: saludo del día, derivación a ejecutivo, audios, archivos, esperas, reglas.
alter table public.crm_agentes_ia add column if not exists comportamiento jsonb not null default '{}'::jsonb;
-- Mensaje que manda al derivar a un ejecutivo (si no corriste crm-ia-mensaje-derivacion.sql).
alter table public.crm_agentes_ia add column if not exists mensaje_derivacion text;
-- FIN de crm-ia-comportamiento.sql
