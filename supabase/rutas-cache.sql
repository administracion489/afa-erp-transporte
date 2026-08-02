-- supabase/rutas-cache.sql
-- Caché de geometría de rutas planificadas (Google Directions) para /api/ruta.
--
-- POR QUÉ: la geometría de una ruta entre las mismas paradas NO cambia. Hoy cada apertura de
-- modal, cada visita al portal del cliente y cada pasajero que abre su app pagan una llamada
-- a Directions por la MISMA línea. Un contrato fijo de 22 días hábiles con ida y vuelta
-- genera ~44 llamadas/mes de geometría idéntica que deberían ser 2.
--
-- SOLO se cachea el caso determinista: peticiones SIN tráfico (`conTrafico: false`, el
-- default de /api/ruta). El ETA en vivo pide tráfico y nunca toca esta tabla, porque su
-- respuesta depende de la hora y de las coordenadas móviles del bus.
--
-- Los Términos de Servicio de Google permiten almacenar resultados de Directions hasta 30
-- días; `creado_at` es lo que hace cumplir ese límite (ver lib/rutas-cache.ts).
--
-- `clave` = firma geográfica de los waypoints redondeados a 5 decimales (~1 m), en orden:
--   "-12.04318,-77.02824|-12.09611,-77.00472|..."
-- Como las coordenadas salen de la tabla `paradas` y son estables, dos peticiones de la misma
-- ruta producen exactamente la misma clave.
--
-- Se lee/escribe SOLO con service-role desde la ruta API → RLS habilitada sin policy (el
-- service-role la evade; ningún cliente anónimo la toca). Idempotente.

CREATE TABLE IF NOT EXISTS rutas_cache (
  clave      TEXT PRIMARY KEY,
  payload    JSONB       NOT NULL,   -- { coordenadas, tramos, total_km, total_min }
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Para la purga por antigüedad (entradas > 30 días).
CREATE INDEX IF NOT EXISTS rutas_cache_creado_at_idx ON rutas_cache (creado_at);

ALTER TABLE rutas_cache ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo el service-role (que evade RLS) lee/escribe esta caché.

-- Purga manual de lo vencido (opcional; /api/ruta ya ignora lo que pase de 30 días al leer):
--   DELETE FROM rutas_cache WHERE creado_at < now() - INTERVAL '30 days';
