-- Ficha Técnica de Ruta: caché de la geometría y las métricas del recorrido.
--
-- Emitir la ficha necesita km y minutos por tramo, que salen de Google Directions.
-- Guardarlos aquí hace que emitir la MISMA ficha veinte veces cueste una sola consulta:
-- solo se vuelve a preguntar si cambian las coordenadas de los paraderos (campo `firma`).
--
-- Forma del jsonb:
-- {
--   "firma": "-12.04521,-77.03102;...|...",     -- coordenadas de ida|retorno
--   "calculado_at": "2026-08-06T18:30:00.000Z",
--   "ida":     {"poly":"<polilínea>","tramos":[{"distancia_km":3.4,"duracion_min":11}],"total_km":42.1,"total_min":95},
--   "retorno": {...} | null
-- }

alter table cotizaciones add column if not exists ficha_ruta_json jsonb;

comment on column cotizaciones.ficha_ruta_json is
  'Caché de la Ficha Técnica de Ruta: polilínea y km/min por tramo de ida y retorno. Se invalida solo si cambian las coordenadas de los paraderos (campo firma).';
