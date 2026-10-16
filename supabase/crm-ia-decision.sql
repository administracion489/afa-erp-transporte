-- CRM IA: por qué respondió (o no) la IA la última vez en cada conversación. No la corre el deploy.
-- Lo escribe lib/crm-ia.ts (registrarDecision) y el Inbox lo muestra bajo el encabezado del chat
-- cuando el último mensaje del cliente quedó sin respuesta. Sin la columna, la IA funciona igual.
alter table public.crm_conversaciones add column if not exists ia_ultima_decision jsonb;
-- FIN de crm-ia-decision.sql
