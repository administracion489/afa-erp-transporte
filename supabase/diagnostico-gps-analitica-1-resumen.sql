-- ══ diagnostico-gps-analitica-1-resumen.sql · SOLO LEE · a cualquier hora ═══════
-- ¿Cuánto pesa ubicaciones_gps, qué índices tiene y si gps-analitica-01a/b/c ya están? Antes
-- y después de esa migración. SQL Editor: pega el archivo ENTERO y Run. No recorre filas.
-- Termina con «-- FIN». Si sale «syntax error at end of input», se pegó cortado.
with t as (
  select c.oid, c.reltuples, pg_total_relation_size(c.oid) as total,
         pg_relation_size(c.oid) as datos, pg_indexes_size(c.oid) as indices
    from pg_class c where c.oid = to_regclass('public.ubicaciones_gps')
),
idx as (
  select ic.relname as nombre, i.indisvalid as valido,
         pg_get_indexdef(i.indexrelid, 1, true) as primera,
         pg_get_expr(i.indpred, i.indrelid, true) as predicado
    from t join pg_index i on i.indrelid = t.oid join pg_class ic on ic.oid = i.indexrelid
),
st as (
  select s.n_tup_ins, greatest(s.last_analyze, s.last_autoanalyze) as ultima_analyze
    from pg_stat_user_tables s where s.relid = (select oid from t)
),
fn as (
  select x.orden, x.nombre, x.parte, to_regprocedure(x.firma) as oid
    from (values
      (8, 'fn_gps_puntos_rapidos', 'public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)', '01a'),
      (9, 'fn_gps_velocimetro',    'public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])', '01b')
    ) x(orden, nombre, firma, parte)
),
col as (
  select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'ubicaciones_gps'
),
filas(orden, pregunta, respuesta, como_se_lee) as (
  select 1, 'Tamaño de ubicaciones_gps',
         coalesce((select pg_size_pretty(total) || ' en total · ' || pg_size_pretty(datos) || ' de datos · '
                          || pg_size_pretty(indices) || ' de índices' from t), 'LA TABLA NO EXISTE'),
         'El CREATE INDEX de gps-analitica-01c lee la tabla entera con los INSERT de GPS bloqueados. '
         || 'Con más de ~1 GB de datos, mejor por psql con CONCURRENTLY (gps-analitica-01-notas.md).'
  union all
  select 2, 'Filas (estimado, sin recorrer la tabla)',
         (select case when reltuples < 0 then 'sin estadísticas: la tabla nunca se analizó'
                      else to_char(reltuples, 'FM999G999G999G999') end from t),
         'Es la cifra de la última ANALYZE. La exacta (select count(*)) recorre la tabla entera.'
  union all
  select 3, 'Última ANALYZE / inserciones registradas',
         coalesce((select coalesce(to_char(ultima_analyze at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI'), 'nunca')
                          || ' (Lima) · ' || to_char(n_tup_ins, 'FM999G999G999G999') || ' inserciones'
                     from st), 'sin estadísticas'),
         'Si la ANALYZE es vieja, el estimado de la fila 2 también.'
  union all
  select 4, '¿Índice VÁLIDO que empiece por reserva_id?',
         coalesce((select string_agg(nombre || coalesce(' (parcial: ' || predicado || ')', ''), ', ')
                     from idx where primera = 'reserva_id' and valido), 'NO'),
         'NO = la traza de CADA servicio (RASTREO, modal GPS, /gps-salud, estadística por servicio) recorre '
         || 'la tabla entera: crearlo pasa a ser lo PRIMERO (propuesta al final de diagnostico-gps-analitica-2-indices.sql).'
  union all
  select 5, '¿Índice VÁLIDO que empiece por created_at?',
         coalesce((select string_agg(nombre || coalesce(' (parcial: ' || predicado || ')', ' (toda la tabla)'), ', ')
                     from idx where primera = 'created_at' and valido), 'ninguno'),
         'Uno de toda la tabla (sin «parcial») haría baratos los diagnósticos 3 y 4. idx_gps_rapidos es '
         || 'parcial: solo sirve para buscar puntos a 60 km/h o más.'
  union all
  select 6, 'idx_gps_rapidos (gps-analitica-01c)',
         coalesce((select case when valido then 'instalado y válido' else 'INVÁLIDO: existe pero no se usa' end
                     from idx where nombre = 'idx_gps_rapidos'), 'falta'),
         'Falta = /seguridad-vial lee la tabla entera por cada día que mide. INVÁLIDO = un CONCURRENTLY '
         || 'que no terminó: borrarlo y crearlo de nuevo por psql (gps-analitica-01-notas.md).'
  union all
  select 7, 'Índices por conductor (retrasos.sql)',
         (select string_agg(x.nombre || ': ' || coalesce((select case when valido then 'válido' else 'INVÁLIDO' end
                               from idx where idx.nombre = x.nombre), 'falta'), ' · ')
            from (values ('idx_gps_conductor_fecha'), ('idx_gps_conductor_ter_fecha')) x(nombre)),
         'Los usa fn_gps_velocimetro (y el semáforo de puntualidad). gps-analitica-01c los crea si faltan.'
  union all
  select f.orden, f.nombre || ' (gps-analitica-' || f.parte || ')',
         case when f.oid is null then 'falta'
              else 'instalada · anon: '
                   || case when has_function_privilege('anon', f.oid, 'execute') then 'PUEDE EJECUTARLA' else 'no' end
                   || ' · authenticated: '
                   || case when has_function_privilege('authenticated', f.oid, 'execute') then 'PUEDE EJECUTARLA' else 'no' end
         end,
         'Falta = /seguridad-vial avisa en ámbar y no mide nada. Si anon o authenticated pueden ejecutarla, '
         || 'devuelve posiciones de toda la flota a quien la llame: vuelve a correr su archivo (01a o 01b).'
    from fn f
  union all
  select 10, 'Columnas opcionales de ubicaciones_gps',
         'simulado: ' || case when exists (select 1 from col where column_name = 'simulado') then 'sí' else 'NO' end
         || ' · fix_ts: ' || case when exists (select 1 from col where column_name = 'fix_ts') then 'sí' else 'NO' end
         || ' · recibido_en: ' || case when exists (select 1 from col where column_name = 'recibido_en') then 'sí' else 'NO' end,
         'Sin «simulado» (ubicaciones-gps-simulado.sql) un exceso con GPS falso no se puede descartar.'
  union all
  select 11, 'Índices INVÁLIDOS en la tabla',
         coalesce((select count(*)::text || ': ' || string_agg(nombre, ', ') from idx where not valido having count(*) > 0),
                  'ninguno'),
         'Un índice inválido no lo usa el planificador pero se actualiza en cada INSERT. Se borra con DROP INDEX CONCURRENTLY por psql.'
)
select orden as "#", pregunta, respuesta, como_se_lee as "cómo se lee" from filas order by orden;
-- FIN de diagnostico-gps-analitica-1-resumen.sql
