-- diagnostico-huella-reserva.sql · SOLO LEE, no cambia nada.
-- Las posiciones GPS del INICIO de un servicio y sus paraderos, en un solo texto, para revisar
-- su huella fuera del ERP (con la misma tubería del modal GPS: scripts que leen este texto).
--
-- Uso: cambia el número de reserva y, si hace falta, la hora en las líneas marcadas con ←, pega
-- TODO en el SQL Editor y pulsa Run. Sale UNA fila con UNA celda: ábrela, copia el texto entero y
-- pégalo en el chat. Trae hasta 900 posiciones (≈ 45 min con un fix cada 3 s) desde esa hora.
with params as (
  select 1459::bigint as reserva,           -- ← la reserva a revisar
         null::time  as desde               -- ← hora de Lima desde la que traer ('17:05'), o null
),
gps as (
  select to_jsonb(u) as j, u.created_at, u.id
  from public.ubicaciones_gps u, params p
  where u.reserva_id = p.reserva
    and (p.desde is null or (u.created_at at time zone 'America/Lima')::time >= p.desde)
  order by u.created_at, u.id
  limit 900
),
lineas_gps as (
  select row_number() over (order by created_at, id) as n,
         concat(
           to_char(created_at at time zone 'America/Lima', 'HH24:MI:SS'), ',',
           coalesce(round((j->>'lat')::numeric, 6)::text, ''), ',',
           coalesce(round((j->>'lng')::numeric, 6)::text, ''), ',',
           coalesce(j->>'precision_m', ''), ',',
           coalesce(j->>'velocidad', ''), ',',
           coalesce(j->>'rumbo', ''), ',',
           coalesce(j->>'estado', ''), ',',
           coalesce(j->>'simulado', ''), ',',
           -- segundos entre la hora del fix del chip y la del registro (vacío si no hay columna)
           coalesce(round(extract(epoch from created_at - (j->>'fix_ts')::timestamptz))::text, ''), ',',
           -- segundos que tardó en llegar al servidor (cola offline); vacío si no hay columna
           coalesce(round(extract(epoch from (j->>'recibido_en')::timestamptz - created_at))::text, '')
         ) as linea
  from gps
),
paraderos as (
  select string_agg(
           concat(p.orden, ',', coalesce(round(p.lat::numeric, 6)::text, ''), ',',
                  coalesce(round(p.lng::numeric, 6)::text, ''), ',',
                  coalesce(p.estado, ''), ',', coalesce(p.hora_estimada::text, ''), ',',
                  coalesce(to_char(p.hora_llegada::timestamptz at time zone 'America/Lima',
                                   'HH24:MI:SS'), ''), ',',
                  replace(coalesce(p.nombre, ''), ',', ' ')),
           E'\n' order by p.orden) as txt
  from public.paradas p
  where p.reserva_id = (select reserva from params)
)
select concat(
  '#RESERVA ', (select reserva from params),
  ' · fecha ', (select to_char(min(created_at) at time zone 'America/Lima', 'YYYY-MM-DD') from gps),
  ' · ', (select count(*) from gps), ' posiciones', E'\n',
  '#GPS hora,lat,lng,precision_m,velocidad,rumbo,estado,simulado,s_desde_fix,s_hasta_llegar', E'\n',
  (select string_agg(linea, E'\n' order by n) from lineas_gps), E'\n',
  '#PARADEROS orden,lat,lng,estado,hora_estimada,hora_llegada,nombre', E'\n',
  (select txt from paraderos)
) as copiar_todo_este_texto;
-- FIN de diagnostico-huella-reserva.sql
