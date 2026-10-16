-- CRM IA: el mensaje que la IA manda cuando deriva un chat a un ejecutivo
-- (no encontró el servicio, no pudo escuchar un audio, reclamo…). No la corre el deploy.
-- Vacío = el motor usa su texto por defecto. {nombre} se reemplaza por el primer nombre.
alter table public.crm_agentes_ia add column if not exists mensaje_derivacion text;
-- FIN de crm-ia-mensaje-derivacion.sql
