-- CRM IA: cuándo una persona reactivó la IA en un chat.
-- Desde ese momento la pausa por respuesta humana (pausa_humano_horas) y el límite de turnos
-- automáticos cuentan solo lo que pasó DESPUÉS. No la corre el deploy; sin ella, reactivar quita
-- la pausa pero las 12 h siguen contando desde la última respuesta humana (comportamiento anterior).
alter table public.crm_conversaciones add column if not exists ia_reactivada_at timestamptz;
-- FIN de crm-ia-reactivacion.sql
