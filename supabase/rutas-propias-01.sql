-- supabase/rutas-propias-01.sql — la línea de la ruta planificada armada con el GPS REAL de un
-- servicio anterior (lib/ruta-propia.ts + lib/ruta-propia-datos.ts). NO la corre el deploy.
--
-- Por qué una tabla aparte y no `rutas_cache`: lo de `rutas_cache` es contenido de Google
-- Directions y sus términos solo permiten guardarlo hasta 30 días (se purga). Esto es un
-- recorrido GPS de la propia flota: se guarda PARA SIEMPRE y a partir del día 31 el modal GPS
-- dibuja esta línea sin volver a pagarle a Google.
--
-- La clave es `firmaRuta` de los paraderos (lib/ruta-firma.ts), la misma de `rutas_cache`, + el cliente.
-- payload null = se intentó y ningún servicio tenía un recorrido válido (`motivo` dice por qué).
--
-- Seguridad: RLS encendido y SIN políticas — solo la service-role (el servidor) la lee y escribe.
-- El recorrido es el de los servicios de un cliente: no se expone a anon ni a authenticated.
--
-- Sin esta tabla nada se cae: el modal sigue con la ruta de Google como hoy.

create table if not exists public.rutas_propias (
  clave             text   not null,
  -- Una ruta por CLIENTE: dos clientes con exactamente los mismos paraderos no se ven el recorrido.
  cliente_id        bigint not null,
  payload           jsonb,
  motivo            text,
  candidatos        integer,
  fuente_reserva_id bigint,
  fuente_fecha      date,
  construida_en     timestamptz,
  revisada_en       timestamptz not null default now(),
  primary key (clave, cliente_id)
);

comment on table public.rutas_propias is
  'Ruta planificada armada con el GPS real de un servicio anterior con los mismos paraderos (lib/ruta-propia.ts). Se guarda para siempre; se renueva cada 30 días.';

alter table public.rutas_propias enable row level security;

revoke all on public.rutas_propias from anon;
revoke all on public.rutas_propias from authenticated;

-- Revisión (opcional): cuántas rutas hay armadas y cuántas no encontraron recorrido.
-- select count(*) filter (where payload is not null) as armadas,
--        count(*) filter (where payload is null)     as sin_recorrido
--   from public.rutas_propias;

-- FIN de rutas-propias-01.sql
