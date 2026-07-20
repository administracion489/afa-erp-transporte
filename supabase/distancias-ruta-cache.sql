-- supabase/distancias-ruta-cache.sql
-- Caché OPCIONAL de distancias por carretera (Google Directions) para la atribución de km
-- del odómetro (/api/mantenimiento/odometro-analitica). Es pura optimización de costo/latencia:
-- la analítica funciona sin esta tabla (solo llama a Google cada vez). Al crearla, cada firma
-- de ruta/tramo se calcula UNA vez y se reutiliza entre vehículos y meses.
--
-- `clave` = firma geográfica de los puntos redondeados (~100 m): "lat,lng|lat,lng[|...]".
-- Se lee/escribe SOLO con service-role desde la ruta API → RLS habilitada sin policy (el
-- service-role la evade; ningún cliente anónimo la toca). Idempotente.

CREATE TABLE IF NOT EXISTS distancias_ruta_cache (
  clave      TEXT PRIMARY KEY,
  km         NUMERIC NOT NULL,
  fuente     TEXT DEFAULT 'google',   -- google | recta (por si se cachea el fallback)
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE distancias_ruta_cache ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo el service-role (que evade RLS) lee/escribe esta caché.
