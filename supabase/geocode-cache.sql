-- supabase/geocode-cache.sql
-- Caché de geocodificación (Google Geocoding API) POR TEXTO DE CONSULTA.
--
-- POR QUÉ ESTA TABLA EXISTE — dos bugs que hacían facturar en bucle infinito:
--
--   1. Las direcciones que Google NO resuelve (ZERO_RESULTS) dejaban lat/lng en null, así que
--      se volvían a pedir en la siguiente apertura del modal, y en la siguiente, para siempre.
--      Un paradero interno mal escrito ("Mz. F Lt. 12 AAHH Los Olivos") no se va a resolver
--      nunca, pero se pagaba cada vez que alguien abría la pantalla.
--   2. Muchos llamadores geocodifican paradas que NO están en la tabla `paradas`: llegan con
--      id 0 (programación) o con ids negativos sintéticos (ModalGps y portal cliente, que
--      arman las paradas desde paradas_json). El resultado no se podía persistir por id, así
--      que se re-geocodificaba en cada carga aunque hubiera salido bien.
--
-- Cachear por TEXTO arregla las dos cosas a la vez, y además comparte el resultado entre
-- reservas distintas: los mismos hoteles, minas y plantas se repiten todos los días.
--
-- `encontrado = false` es un MEMO NEGATIVO: recuerda que Google ya dijo que no, para no
-- volver a preguntar. Es la mitad del ahorro de este archivo.
--
-- Los ToS de Google permiten almacenar resultados de Geocoding hasta 30 días; `creado_at` es
-- lo que hace cumplir ese límite (ver lib/geocode-cache.ts).
--
-- Se lee/escribe SOLO con service-role desde las rutas API → RLS habilitada sin policy.
-- Idempotente.

-- Sirve para las DOS direcciones, y `texto` guarda en ambas la dirección que devolvió Google:
--   directa  → `consulta` es la dirección normalizada; el resultado va en lat/lng y en `texto`
--              queda el formatted_address, que es lo que se persiste en `paradas.direccion`
--              en vez del texto crudo que tecleó el operador.
--   inversa  → `consulta` es "inv:lat,lng" redondeado a 4 decimales (~11 m), el resultado va
--              en `texto` (dirección corta, 2 primeras partes). Lo usa el popup de los puntitos
--              de telemetría de la huella, donde un operador revisando una queja puede clicar
--              decenas de puntos de la misma calle: redondear a ~11 m hace que todos compartan
--              una sola entrada.
-- Las claves nunca chocan (el prefijo "inv:" no puede salir de una dirección normalizada), así
-- que una sola columna `texto` cubre los dos casos.
CREATE TABLE IF NOT EXISTS geocode_cache (
  consulta   TEXT PRIMARY KEY,          -- texto normalizado: minúsculas, espacios colapsados
  lat        NUMERIC,                   -- null cuando encontrado = false
  lng        NUMERIC,
  texto      TEXT,                      -- dirección resuelta por Google (directa e inversa)
  encontrado BOOLEAN     NOT NULL,
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Para bases que ya tengan la tabla de una versión anterior de este archivo.
ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS texto TEXT;

CREATE INDEX IF NOT EXISTS geocode_cache_creado_at_idx ON geocode_cache (creado_at);

ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo el service-role (que evade RLS) lee/escribe esta caché.

-- Purga manual de lo vencido (las rutas API ya ignoran lo que pase de 30 días al leer):
--   DELETE FROM geocode_cache WHERE creado_at < now() - INTERVAL '30 days';
