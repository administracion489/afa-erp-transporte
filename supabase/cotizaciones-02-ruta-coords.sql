-- supabase/cotizaciones-02-ruta-coords.sql
-- Las coordenadas del ORIGEN, DESTINO y RETORNO de la cotización (lib/cotizacion-ruta-coords.ts).
--
-- Antes la cotización guardaba solo el TEXTO de los tres puntos: al reabrirla volvían sin
-- coordenadas («Ruta del servicio no está jalando las coordenadas»). Sin esta columna /cotizaciones
-- sigue funcionando: guarda sin ella y, al reabrir, saca las coordenadas del paradero 1 / último
-- o las busca por el texto (aproximadas, y la pantalla lo dice).
--
-- Forma: {"v":1,"origen":{"texto","lat","lng","placeId"}|null,"destino":…,"retorno":…}
-- El texto va dentro: si alguien cambió el texto por otra vía, la coordenada guardada ya no vale.
-- Sin default ni backfill: una cotización vieja no tiene coordenadas que inventarle.

alter table public.cotizaciones add column if not exists ruta_coords_json jsonb;

comment on column public.cotizaciones.ruta_coords_json is
  'Coordenadas de origen/destino/retorno con el texto para el que valen (lib/cotizacion-ruta-coords.ts).';

-- FIN
