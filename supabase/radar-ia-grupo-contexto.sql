-- supabase/radar-ia-grupo-contexto.sql — contexto y categorías permitidas por grupo.
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase.
--
-- Antes, todos los grupos activos compartían la misma lista global de categorías
-- (radar_config.categorias_activas). Esto permite que cada grupo aclare su propio
-- contexto para ELIA (p.ej. "esto es una red de apoyo entre transportistas externos,
-- NO es la flota de AFA") y, opcionalmente, restrinja qué categorías aplican para ESE
-- grupo en particular (categorias_permitidas = null → usa las globales de radar_config).

alter table radar_grupos add column if not exists contexto text;
alter table radar_grupos add column if not exists categorias_permitidas jsonb;
