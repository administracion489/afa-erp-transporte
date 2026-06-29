-- Índice único en pasajeros_parada(pasajero_id, parada_id).
--
-- INVARIANTE: un pasajero aparece como mucho UNA vez por parada. Cada `parada`
-- pertenece a una sola reserva, así que esto equivale a "una asignación del pasajero
-- por bus/tramo". Todos los writers de la app ya respetan esto (delete-then-insert,
-- check-then-insert, o insert de pasajero recién creado).
--
-- POR QUÉ: el case "embarcar_qr" de /api/conductor, para un "caminante" (pasajero no
-- asignado a la parada), hacía un INSERT plano sin protección. Dos escaneos concurrentes
-- del mismo walk-on (dos equipos a la vez, o un fallo del candado del cliente) leían
-- ambos "no existe fila" e insertaban los dos → fila duplicada + doble boarding_log
-- (inflaba el conteo de abordados del portal cliente). Este índice hace que el segundo
-- INSERT falle con 23505 (unique_violation); el código lo captura y lo trata como
-- "ya embarcado" (recupera la fila existente, no re-loguea). Defensa en profundidad para
-- el caso multi-dispositivo — el caso de un solo equipo ya lo cubre el candado del cliente.
--
-- POR QUÉ NO PARCIAL: PostgREST (.upsert / .insert con manejo de conflicto) infiere el
-- árbitro de ON CONFLICT por las columnas (pasajero_id, parada_id). Un índice PARCIAL
-- exigiría pasar su predicado WHERE en el ON CONFLICT, cosa que PostgREST no permite, así
-- que no serviría de árbitro. pasajero_id y parada_id son NOT NULL en el 100% de las filas
-- (verificado: 595/595), por lo que un índice completo se comporta igual que uno parcial.
--
-- COMPATIBLE con "eliminar sobrantes del mismo horario" de embarcar_qr: la rama 5b elige
-- como target la fila que YA está en la parada escaneada (si existe), de modo que el UPDATE
-- de parada_id nunca choca contra otra fila del mismo par; los sobrantes se borran después.
--
-- Verificado contra prod antes de crear: 0 grupos duplicados (pasajero_id, parada_id),
-- 0 nulos, y NO existía índice único previo. El de-dup de abajo es solo una red de
-- seguridad por si aparecieran duplicados entre ahora y la ejecución.

-- 1) De-dup defensivo: si hubiera duplicados, conservar UNA fila por par —
--    preferir la que ya está abordada/embarcada; en empate, el id más bajo.
with ranked as (
  select id,
         row_number() over (
           partition by pasajero_id, parada_id
           order by (estado in ('abordado','embarcado')) desc, id asc
         ) as rn
  from public.pasajeros_parada
  where pasajero_id is not null and parada_id is not null
)
delete from public.pasajeros_parada
where id in (select id from ranked where rn > 1);

-- 2) Índice único (completo, ver nota arriba).
create unique index if not exists ux_pasajeros_parada_pax_parada
  on public.pasajeros_parada (pasajero_id, parada_id);
