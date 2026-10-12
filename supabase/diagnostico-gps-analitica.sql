-- ════════════════════════════════════════════════════════════════════════════
-- diagnostico-gps-analitica.sql
-- ¿Qué índices tiene `ubicaciones_gps`, cuánto pesa, y cómo son sus puntos rápidos?
--
-- SOLO LEE. No crea, no altera y no borra nada. El deploy no lo corre (no hace falta:
-- no instala nada). Se corre ANTES de supabase/gps-analitica-01-excesos.sql, porque lo que
-- dice decide CÓMO correr esa migración (desde el editor en hora valle, o por psql con
-- CONCURRENTLY), y otra vez después, para ver que quedó.
--
-- POR QUÉ HACE FALTA: `ubicaciones_gps` se creó desde el panel de Supabase y su DDL no
-- está en el repo. Los únicos índices que el repo le crea son los cuatro parciales por
-- conductor/vehículo de retrasos.sql. Ninguno por `created_at` solo, ni por `velocidad`,
-- ni —lo más importante— por `reserva_id`, que es por donde se lee la traza de CADA
-- servicio (la torre RASTREO, el modal GPS, /gps-salud y la estadística por servicio de
-- /uso-flota). Ese índice probablemente existe, pero hay que COMPROBARLO, no suponerlo:
-- si no está, cada traza recorre la tabla más grande del sistema.
--
-- ─── CÓMO SE USA ────────────────────────────────────────────────────────────
--
-- Supabase → SQL Editor. El editor enseña solo el resultado de la ÚLTIMA consulta, así
-- que se corre DE A UNA: selecciona la consulta (desde su cabecera «CONSULTA N» hasta su
-- `;`) y dale Run. Correr el archivo entero no hace daño —las consultas pesadas no
-- recorren nada mientras su interruptor esté en `false`—, pero solo verías la última.
--
--   CONSULTA 1 · Resumen ............ a cualquier hora (catálogo y estadísticas, no lee filas)
--   CONSULTA 2 · Índices ............ a cualquier hora
--   CONSULTA 3 · Columnas y tipos ... a cualquier hora
--   CONSULTA 4 · Puntos de un día ... HORA VALLE: recorre un día entero de la tabla
--   CONSULTA 5 · Sin velocímetro .... HORA VALLE: recorre un día entero de la tabla
--
-- Las consultas 4 y 5 son LECTURAS: no bloquean los INSERT de GPS (en Postgres leer no
-- bloquea escribir), pero sin un índice por `created_at` hacen un recorrido completo de la
-- tabla y compiten por disco con la torre, que la lee cada 45 s. Por eso llevan un
-- INTERRUPTOR: nacen en `false` y no leen nada hasta que lo cambias a `true`. Con el
-- interruptor apagado devuelven UNA fila que dice «NO SE CORRIÓ» y las cifras vacías —
-- nunca ceros, que se leerían como «ese día no hubo puntos».
-- ════════════════════════════════════════════════════════════════════════════


-- ═══ CONSULTA 1 · RESUMEN (a cualquier hora) ════════════════════════════════
-- Una fila por pregunta, con cómo leer la respuesta.
with t as (
  select c.oid, c.reltuples,
         pg_total_relation_size(c.oid) as total,
         pg_relation_size(c.oid)       as datos,
         pg_indexes_size(c.oid)        as indices
    from pg_class c
   where c.oid = to_regclass('public.ubicaciones_gps')
),
idx as (
  select ic.relname                                  as nombre,
         i.indisvalid                                as valido,
         pg_get_indexdef(i.indexrelid, 1, true)      as primera,
         pg_get_expr(i.indpred, i.indrelid, true)    as predicado
    from t
    join pg_index i  on i.indrelid = t.oid
    join pg_class ic on ic.oid = i.indexrelid
),
st as (
  select s.n_tup_ins, s.n_live_tup,
         greatest(s.last_analyze, s.last_autoanalyze) as ultima_analyze
    from pg_stat_user_tables s
   where s.relid = (select oid from t)
),
fn as (
  select x.orden, x.nombre, to_regprocedure(x.firma) as oid
    from (values
      (8, 'fn_gps_puntos_rapidos', 'public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)'),
      (9, 'fn_gps_velocimetro',    'public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])')
    ) x(orden, nombre, firma)
),
col as (
  select column_name
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ubicaciones_gps'
),
filas(orden, pregunta, respuesta, como_se_lee) as (
  select 1, 'Tamaño de ubicaciones_gps',
         coalesce((select pg_size_pretty(total) || ' en total · ' || pg_size_pretty(datos) || ' de datos · '
                          || pg_size_pretty(indices) || ' de índices' from t),
                  'LA TABLA NO EXISTE'),
         'El CREATE INDEX de gps-analitica-01 lee la tabla entera con los INSERT de GPS bloqueados. '
         || 'Con más de ~1 GB de datos, mejor por psql con CONCURRENTLY (ver su cabecera).'
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
                     from idx where primera = 'reserva_id' and valido),
                  'NO'),
         'NO = la traza de CADA servicio (columna RASTREO, modal GPS, /gps-salud, estadística por servicio) '
         || 'recorre la tabla entera. Si sale NO, crearlo pasa a ser lo PRIMERO, antes que gps-analitica-01 '
         || '(ver la propuesta comentada al final de este archivo).'
  union all
  select 5, '¿Índice VÁLIDO que empiece por created_at?',
         coalesce((select string_agg(nombre || coalesce(' (parcial: ' || predicado || ')', ' (toda la tabla)'), ', ')
                     from idx where primera = 'created_at' and valido),
                  'ninguno'),
         'Uno de toda la tabla (sin «parcial») haría baratas las consultas 4 y 5. idx_gps_rapidos es '
         || 'parcial: solo sirve para buscar puntos a 60 km/h o más.'
  union all
  select 6, 'idx_gps_rapidos (gps-analitica-01)',
         coalesce((select case when valido then 'instalado y válido' else 'INVÁLIDO: existe pero no se usa' end
                     from idx where nombre = 'idx_gps_rapidos'),
                  'falta'),
         'Falta = /seguridad-vial lee la tabla entera por cada día que mide. INVÁLIDO = un CONCURRENTLY '
         || 'que no terminó: borrarlo y crearlo de nuevo por psql (cabecera de gps-analitica-01).'
  union all
  select 7, 'Índices por conductor (retrasos.sql)',
         (select string_agg(x.nombre || ': ' ||
                   coalesce((select case when valido then 'válido' else 'INVÁLIDO' end
                               from idx where idx.nombre = x.nombre), 'falta'), ' · ')
            from (values ('idx_gps_conductor_fecha'), ('idx_gps_conductor_ter_fecha')) x(nombre)),
         'Los usa fn_gps_velocimetro (y el semáforo de puntualidad). gps-analitica-01 los crea si faltan.'
  union all
  select f.orden, f.nombre || ' (gps-analitica-01)',
         case when f.oid is null then 'falta'
              else 'instalada · anon: '
                   || case when has_function_privilege('anon', f.oid, 'execute') then 'PUEDE EJECUTARLA' else 'no' end
                   || ' · authenticated: '
                   || case when has_function_privilege('authenticated', f.oid, 'execute') then 'PUEDE EJECUTARLA' else 'no' end
         end,
         'Falta = /seguridad-vial avisa en ámbar y no mide nada. Si anon o authenticated pueden '
         || 'ejecutarla, devuelve posiciones de toda la flota a quien la llame: vuelve a correr gps-analitica-01.'
    from fn f
  union all
  select 10, 'Columnas opcionales de ubicaciones_gps',
         'simulado: ' || case when exists (select 1 from col where column_name = 'simulado')    then 'sí' else 'NO' end
         || ' · fix_ts: '      || case when exists (select 1 from col where column_name = 'fix_ts')      then 'sí' else 'NO' end
         || ' · recibido_en: ' || case when exists (select 1 from col where column_name = 'recibido_en') then 'sí' else 'NO' end,
         'Sin «simulado» (ubicaciones-gps-simulado.sql) un exceso con GPS falso no se puede descartar: '
         || 'la función devuelve null (= no se sabe) y el motor no lo veta.'
  union all
  select 11, 'Índices INVÁLIDOS en la tabla',
         coalesce((select count(*)::text || ': ' || string_agg(nombre, ', ') from idx where not valido having count(*) > 0),
                  'ninguno'),
         'Un índice inválido no lo usa el planificador pero se sigue actualizando en cada INSERT: '
         || 'cuesta y no sirve. Se borra con DROP INDEX CONCURRENTLY por psql.'
)
select orden as "#", pregunta, respuesta, como_se_lee as "cómo se lee"
  from filas
 order by orden;


-- ═══ CONSULTA 2 · ÍNDICES DE ubicaciones_gps (a cualquier hora) ═════════════
-- Lo mismo que pg_indexes, con lo que pg_indexes no dice: si es válido, cuánto pesa y
-- cuántas veces se ha usado. Un índice grande con 0 usos se mantiene en cada INSERT de
-- GPS y nadie lo aprovecha. (Los usos cuentan desde el último reinicio de estadísticas.)
select ic.relname                                   as indice,
       i.indisvalid                                 as valido,
       i.indisunique                                as unico,
       pg_get_indexdef(i.indexrelid, 1, true)       as primera_columna,
       pg_get_expr(i.indpred, i.indrelid, true)     as "parcial: solo filas donde",
       pg_size_pretty(pg_relation_size(i.indexrelid)) as tamano,
       s.idx_scan                                   as usos,
       pg_get_indexdef(i.indexrelid)                as definicion
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
 where i.indrelid = to_regclass('public.ubicaciones_gps')
 order by pg_relation_size(i.indexrelid) desc;


-- ═══ CONSULTA 3 · COLUMNAS Y TIPOS (a cualquier hora) ═══════════════════════
-- Para el registro: los tipos reales de los ids (integer o bigint), de velocidad y de
-- precision_m. Las funciones de gps-analitica-01 no dependen de ellos (castean los ids a
-- bigint y publican los números con su tipo).
select ordinal_position as "#", column_name as columna, data_type as tipo, udt_name,
       is_nullable as admite_null, column_default as por_defecto
  from information_schema.columns
 where table_schema = 'public' and table_name = 'ubicaciones_gps'
 order by ordinal_position;


-- ═══ CONSULTA 4 · LOS PUNTOS DE UN DÍA (HORA VALLE) ═════════════════════════
-- Cuántos puntos hubo, cuántos con velocidad del sensor, cuántos rápidos, con qué
-- precisión y cuántos fuera de servicio. Es lo que dice si el umbral de 90 km/h y la
-- precisión de 20 m van a dejar algo que juzgar, y cuánto pesaría el JSON de la función.
--
-- El día es de Lima: [d 05:00 UTC, d+1 05:00 UTC). Por defecto, AYER.
-- PARA CORRERLA: cambia `false` por `true` en la línea del interruptor (y, si quieres otro
-- día, pon la fecha en lugar de `null`).
with interruptor as (
  select false        as correr,   -- ← true para correrla. HORA VALLE: recorre un día entero.
         null::date   as fecha     -- ← null = ayer en Lima; o p. ej. date '2026-10-10'
),
dia as (
  select i.correr,
         coalesce(i.fecha, (now() at time zone 'America/Lima')::date - 1) as fecha
    from interruptor i
),
rango as (
  select d.correr, d.fecha,
         (d.fecha::timestamp)       at time zone 'America/Lima' as desde,
         ((d.fecha + 1)::timestamp) at time zone 'America/Lima' as hasta
    from dia d
),
conteo as (
  select count(*)                                                          as puntos,
         count(*) filter (where g.velocidad > 0)                           as con_velocidad,
         count(*) filter (where g.velocidad = 0)                           as velocidad_cero,
         count(*) filter (where g.velocidad is null)                       as velocidad_nula,
         count(*) filter (where g.velocidad >= 60)                         as a_60,
         count(*) filter (where g.velocidad >= 80)                         as a_80,
         count(*) filter (where g.velocidad >= 90)                         as a_90,
         count(*) filter (where g.velocidad >= 100)                        as a_100,
         count(*) filter (where g.velocidad > 130)                         as sobre_130,
         count(*) filter (where g.precision_m is null)                     as precision_nula,
         count(*) filter (where g.precision_m > 20)                        as precision_sobre_20,
         count(*) filter (where g.velocidad >= 90
                            and (g.precision_m is null or g.precision_m > 20)) as a_90_precision_mala,
         count(*) filter (where g.reserva_id is null)                      as sin_servicio,
         count(*) filter (where g.velocidad >= 90 and g.reserva_id is null) as a_90_sin_servicio,
         count(distinct case when g.conductor_id is not null then 'p:' || g.conductor_id::text
                             when g.conductor_tercero_id is not null then 't:' || g.conductor_tercero_id::text
                        end)                                               as conductores
    from rango r
    join public.ubicaciones_gps g
      on g.created_at >= r.desde and g.created_at < r.hasta
   where (select correr from interruptor)   -- apagado: el planificador ni abre la tabla
)
select case when r.correr then 'medido'
            else 'NO SE CORRIÓ: cambia false por true en la línea del interruptor (en hora valle)' end
                                                                        as estado,
       to_char(r.fecha, 'DD/MM/YYYY')                                    as "día (Lima)",
       case when r.correr then c.puntos end                              as puntos,
       case when r.correr then c.con_velocidad end                       as "velocidad > 0",
       case when r.correr then round(100.0 * c.con_velocidad / nullif(c.puntos, 0), 1) end
                                                                        as "% con velocidad",
       case when r.correr then c.velocidad_cero end                      as "velocidad = 0",
       case when r.correr then c.velocidad_nula end                      as "velocidad nula",
       case when r.correr then c.a_60 end                                as "≥ 60",
       case when r.correr then c.a_80 end                                as "≥ 80",
       case when r.correr then c.a_90 end                                as "≥ 90",
       case when r.correr then c.a_100 end                               as "≥ 100",
       case when r.correr then c.sobre_130 end                           as "> 130 (imposibles)",
       case when r.correr then c.precision_nula end                      as "precisión nula",
       case when r.correr then c.precision_sobre_20 end                  as "precisión > 20 m",
       case when r.correr then c.a_90_precision_mala end                 as "≥ 90 con precisión nula o > 20 m",
       case when r.correr then c.sin_servicio end                        as "sin servicio (reserva_id nulo)",
       case when r.correr then c.a_90_sin_servicio end                   as "≥ 90 sin servicio",
       case when r.correr then c.conductores end                         as conductores,
       case when r.correr then c.a_60 > 60000 end                        as "umbral 60 pasaría el tope de 60 000",
       -- ~78 bytes por punto, medido sobre la salida real de fn_gps_puntos_rapidos.
       case when r.correr then round(least(c.a_60, 60000) * 78 / 1e6, 1) end
                                                                        as "MB aprox. del JSON con umbral 60"
  from rango r
  cross join conteo c;
-- Cómo se lee:
-- · «% con velocidad» bajo = muchos teléfonos sin velocímetro: sus excesos no se pueden
--   juzgar (la consulta 5 dice de quién).
-- · «≥ 90 con precisión nula o > 20 m» alto = el motor descartará esos episodios como
--   «impreciso». Si es casi todo, el umbral de 20 m (heredado de ACC_CONFIABLE_M) deja la
--   pantalla sin nada que mostrar y hay que discutirlo con datos, no a ojo.
-- · «> 130» son lecturas imposibles para un bus: el motor las descarta.
-- · «≥ 90 sin servicio» = la app abierta fuera de servicio: no se le cargan a la unidad.


-- ═══ CONSULTA 5 · CONDUCTORES CON PUNTOS PERO SIN VELOCÍMETRO (HORA VALLE) ═══
-- Los que mandaron GPS ese día y NINGÚN punto con velocidad > 0: su teléfono no reporta
-- la velocidad del sensor (típico del navegador). Para ellos /seguridad-vial dirá «no se
-- puede juzgar», nunca «0 excesos». Se arregla desde la configuración del teléfono
-- (/gps-salud).
-- PARA CORRERLA: cambia `false` por `true` en la línea del interruptor.
with interruptor as (
  select false        as correr,   -- ← true para correrla. HORA VALLE: recorre un día entero.
         null::date   as fecha     -- ← null = ayer en Lima; o p. ej. date '2026-10-10'
),
rango as (
  select i.correr,
         coalesce(i.fecha, (now() at time zone 'America/Lima')::date - 1) as fecha
    from interruptor i
),
lim as (
  select r.correr, r.fecha,
         (r.fecha::timestamp)       at time zone 'America/Lima' as desde,
         ((r.fecha + 1)::timestamp) at time zone 'America/Lima' as hasta
    from rango r
),
por as (
  select case when g.conductor_id is not null then 'conductores' else 'conductores_tercero' end as tabla,
         coalesce(g.conductor_id, g.conductor_tercero_id)::bigint                          as conductor_id,
         count(*)                                                as puntos,
         count(*) filter (where g.velocidad > 0)                 as con_velocidad,
         count(*) filter (where g.velocidad is null)             as velocidad_nula,
         count(*) filter (where g.precision_m is null)           as precision_nula,
         count(distinct g.reserva_id)                            as servicios,
         min(g.created_at)                                       as primero,
         max(g.created_at)                                       as ultimo
    from lim l
    join public.ubicaciones_gps g
      on g.created_at >= l.desde and g.created_at < l.hasta
   where (select correr from interruptor)   -- apagado: el planificador ni abre la tabla
     and (g.conductor_id is not null or g.conductor_tercero_id is not null)
   group by 1, 2
)
select 'sin velocímetro'                                          as estado,
       p.tabla,
       p.conductor_id,
       coalesce(cp.nombre, ct.nombre)                            as nombre,
       p.puntos,
       p.velocidad_nula                                          as "velocidad nula",
       round(100.0 * p.precision_nula / p.puntos, 1)             as "% precisión nula",
       p.servicios,
       to_char(p.primero at time zone 'America/Lima', 'HH24:MI') as "primer punto (Lima)",
       to_char(p.ultimo  at time zone 'America/Lima', 'HH24:MI') as "último punto (Lima)"
  from por p
  left join public.conductores         cp on p.tabla = 'conductores'         and cp.id = p.conductor_id
  left join public.conductores_tercero ct on p.tabla = 'conductores_tercero' and ct.id = p.conductor_id
 where p.con_velocidad = 0
union all
select 'NO SE CORRIÓ: cambia false por true en la línea del interruptor (en hora valle)',
       null, null, null, null, null, null, null, null, null
  from lim
 where not lim.correr
 order by 5 desc nulls last;
-- Cómo se lee: cada fila es un conductor que ese día NO se puede juzgar. «velocidad nula»
-- distinto de 0 = el equipo ni siquiera manda el campo; todo en 0 = lo manda vacío. La
-- clave es (tabla, conductor_id): los ids de las dos tablas se solapan.


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
