-- supabase/radar-ia-oportunidad-dedupe.sql — deduplicación de oportunidades comerciales.
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase.
--
-- Problema real: transportistas terceros comparten la misma solicitud en 2+ grupos
-- que el Radar monitorea (reenvío o repost manual), generando una oportunidad
-- comercial duplicada por cada grupo. A partir de ahora, cuando el mismo remitente
-- (mismo número de WhatsApp) pide la misma ruta para la misma fecha en más de un
-- mensaje, se fusiona en UNA sola fila y se lleva la cuenta de cuántas veces se vio.

alter table radar_oportunidades add column if not exists veces_detectada int not null default 1;
alter table radar_oportunidades add column if not exists grupos_json jsonb not null default '[]'::jsonb;
