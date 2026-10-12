-- ══ diagnostico-gps-analitica-2-indices.sql · SOLO LEE · a cualquier hora ═══════
-- Los índices de ubicaciones_gps con lo que pg_indexes no dice: si son VÁLIDOS, cuánto pesan
-- y cuántas veces se usaron (desde el último reinicio de estadísticas). Un índice grande con
-- 0 usos se mantiene en cada INSERT de GPS y nadie lo aprovecha.
-- SQL Editor: pega el archivo ENTERO y Run. Termina con «-- FIN».
select ic.relname                                     as indice,
       i.indisvalid                                   as valido,
       i.indisunique                                  as unico,
       pg_get_indexdef(i.indexrelid, 1, true)         as primera_columna,
       pg_get_expr(i.indpred, i.indrelid, true)       as "parcial: solo filas donde",
       pg_size_pretty(pg_relation_size(i.indexrelid)) as tamano,
       s.idx_scan                                     as usos,
       pg_get_indexdef(i.indexrelid)                  as definicion
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
 where i.indrelid = to_regclass('public.ubicaciones_gps')
 order by pg_relation_size(i.indexrelid) desc;

-- ════════════════════════════════════════════════════════════════════════════
-- SI LA FILA 4 DEL RESUMEN DICE «NO» (no hay índice por reserva_id): propuesta, NO la
-- corras sin decidirlo. Por psql (Supabase → Connect → Connection string), sin bloquear
-- los INSERT de GPS. La clave sigue el orden en que se lee la traza (created_at, id), así
-- que sirve también para paginar sin ordenar:
--
--   create index concurrently if not exists idx_gps_reserva_fecha
--     on public.ubicaciones_gps (reserva_id, created_at, id) where reserva_id is not null;
--
-- Desde el SQL Editor (sin `concurrently`) bloquearía los INSERT de toda la flota mientras
-- se construye — y este, a diferencia de idx_gps_rapidos, indexa casi toda la tabla.
-- ════════════════════════════════════════════════════════════════════════════
-- FIN de diagnostico-gps-analitica-2-indices.sql
