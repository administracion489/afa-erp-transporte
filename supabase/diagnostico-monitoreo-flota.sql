-- ══ diagnostico-monitoreo-flota.sql · SOLO LEE · a cualquier hora (unos segundos) ═══════════
-- Antes de /api/monitoreo/flota: (a) ¿están VÁLIDOS los índices por vehículo de retrasos.sql? (b) ¿los usa
-- la consulta por unidad del endpoint? (c) ¿hace cuánto transmitió cada unidad vigente? (d) ¿qué trae su
-- última fila? (e) ¿qué es la columna `timestamp`? SQL Editor: pega el archivo ENTERO y Run: sale UNA tabla
-- (el editor enseña solo la última sentencia). Termina con «-- FIN»; «syntax error at end of input» = cortado.
-- No escribe datos: la función es TEMPORAL (pg_temp, muere con la sesión), porque un EXPLAIN no se lee dentro
-- de un SELECT de otro modo. Columnas opcionales vía to_jsonb(fila): si faltan, vacías. Sin `distinct on` (sin
-- skip scan lee TODO el índice de 30 días): un LIMIT por unidad, como el endpoint. Sin índice válido, (c) y (d) no se miden.
set local statement_timeout = '60s';
create or replace function pg_temp.filas_de(q text) returns setof text language plpgsql as $f$
  begin return query execute q; exception when others then return next 'NO SE PUDO: ' || sqlerrm; end $f$;
with col as (select column_name::text as c, data_type::text as tipo, column_default::text as def
               from information_schema.columns where table_schema = 'public' and table_name = 'ubicaciones_gps'),
idx as (select x.n, x.columna, i.indisvalid as valido, pg_get_expr(i.indpred, i.indrelid, true) as pred
          from (values ('idx_gps_vehiculo_fecha', 'vehiculo_id'), ('idx_gps_vehiculo_ter_fecha', 'vehiculo_tercero_id')) x(n, columna)
          left join pg_index i on i.indexrelid = to_regclass('public.' || x.n)),
uni as (  -- unidades vigentes (estado ≠ 'inactivo'; null = vigente). Los ids de las dos tablas se solapan.
  select 'propia' as f, v.id as pid, null as tid from public.vehiculos v where to_jsonb(v) ->> 'estado' is distinct from 'inactivo' union all
  select 'tercero', null, v.id from public.vehiculos_tercero v where to_jsonb(v) ->> 'estado' is distinct from 'inactivo'),
por as (  -- por unidad: su ÚLTIMA fila (sin filtros ni fecha) y las 5 que pide el endpoint (30 d, lat, no simulada)
  select u.f, coalesce(a.j, b.j) as ultima, coalesce(c.v, d.v, '{}') as cinco from uni u
  left join lateral (select to_jsonb(g) as j from public.ubicaciones_gps g where g.vehiculo_id = u.pid order by g.created_at desc limit 1) a on true
  left join lateral (select to_jsonb(g) as j from public.ubicaciones_gps g where g.vehiculo_tercero_id = u.tid order by g.created_at desc limit 1) b on true
  left join lateral (select array_agg(to_jsonb(g) order by g.created_at desc) as v from (select * from public.ubicaciones_gps g
      where g.vehiculo_id = u.pid and g.created_at >= now() - interval '30 days' and g.lat is not null
        and to_jsonb(g) ->> 'simulado' is distinct from 'true' order by g.created_at desc limit 5) g) c on true
  left join lateral (select array_agg(to_jsonb(g) order by g.created_at desc) as v from (select * from public.ubicaciones_gps g
      where g.vehiculo_tercero_id = u.tid and g.created_at >= now() - interval '30 days' and g.lat is not null
        and to_jsonb(g) ->> 'simulado' is distinct from 'true' order by g.created_at desc limit 5) g) d on true
  where (select bool_and(coalesce(valido, false)) from idx)),
ed as (  -- edad como la medirá el motor: min(fix_ts ?? created_at, recibido_en ?? ∞, ahora)
  select f, ultima, cardinality(cinco) as n5, (ultima ->> 'created_at')::timestamptz >= now() - interval '30 days' as u30,
         cinco[1] ->> 'estado' = 'finalizado' and coalesce((cinco[1] ->> 'precision_m')::float8, 0) not between 0.01 and 150 as fin_imp,
         (select count(*) from unnest(cinco) x where (x ->> 'precision_m')::float8 between 0.01 and 150) as precisos, ultima ->> 'estado' = 'finalizado' as u_fin,
         (ultima ->> 'precision_m')::float8 as u_prec, extract(epoch from (ultima ->> 'created_at')::timestamptz - (ultima ->> 'recibido_en')::timestamptz) as adel,
         extract(epoch from now() - least(coalesce((cinco[1] ->> 'fix_ts')::timestamptz, (cinco[1] ->> 'created_at')::timestamptz),
           coalesce((cinco[1] ->> 'recibido_en')::timestamptz, 'infinity'), now())) / 60 as m
    from por),
top as (  -- la unidad de cada flota con más filas entre las 5000 últimas insertadas (por la PK, sin recorrer)
  select distinct on (columna) columna, id from (select case when vehiculo_id is null then 'vehiculo_tercero_id' else 'vehiculo_id' end as columna,
           coalesce(vehiculo_id, vehiculo_tercero_id) as id, count(*) as n from (select vehiculo_id, vehiculo_tercero_id from public.ubicaciones_gps
           order by id desc limit 5000) r where coalesce(vehiculo_id, vehiculo_tercero_id) is not null group by 1, 2) z order by columna, n desc),
pl as (  -- la consulta EXACTA del endpoint (lib/monitoreo-datos.ts) para esa unidad; ANALYZE solo con índice válido
  select t.columna, t.id, i.n as indice, p.l, p.k from top t join idx i on i.columna = t.columna
  cross join lateral pg_temp.filas_de('explain (' || case when i.valido then 'analyze, buffers, ' else '' end || 'costs) '
    || 'select * from public.ubicaciones_gps where ' || t.columna || ' = ' || t.id || ' and created_at >= now() - interval ''30 days'''
    || case when t.columna = 'vehiculo_id' then ' and vehiculo_tercero_id is null' else '' end
    || ' and not (lat is null)' || case when exists (select 1 from col where c = 'simulado')
       then ' and (simulado is null or simulado = false)' else '' end || ' order by created_at desc limit 5') with ordinality p(l, k)),
rec as (  -- de las 20 000 últimas filas INSERTADAS (por la PK), las de la última hora; `timestamp` solo si es de tipo fecha
  select * from (select (j ->> 'created_at')::timestamptz as ca, (j ->> 'recibido_en')::timestamptz as rcb, case when (select tipo from col
                          where c = 'timestamp') like 'timestamp%' then (j ->> 'timestamp')::timestamptz end as tsc, coalesce(j ->> 'vehiculo_id',
                          j ->> 'vehiculo_tercero_id') is null as sin_unidad, coalesce('p' || (j ->> 'conductor_id'), 't' || (j ->> 'conductor_tercero_id')) as cond
                   from (select to_jsonb(g) as j from public.ubicaciones_gps g order by g.id desc limit 20000) x) y
   where coalesce(rcb, tsc, ca) >= now() - interval '1 hour'),
filas(o, pregunta, respuesta, como) as (
  select 10 + row_number() over (order by n), '(a) ' || n, case when valido is null then 'FALTA' when not valido
           then 'INVÁLIDO: existe pero no se usa' else 'VÁLIDO · parcial: ' || coalesce(pred, '—') end,
         'FALTA/INVÁLIDO = cada consulta por unidad lee la tabla entera. Sección 7 de retrasos.sql (hora valle) o psql CONCURRENTLY.' from idx
  union all select 13, '(a) Columnas opcionales', string_agg(x.c || ': ' || case when col.c is null then 'NO' else 'sí' end, ' · '),
         'La que falte, el endpoint la suelta y el motor pierde ese dato.' from (values ('simulado'), ('fix_ts'), ('recibido_en'), ('timestamp')) x(c) left join col on col.c = x.c
  union all select 20.01 + 0.01 * (i.columna = 'vehiculo_tercero_id')::int, '(b) ' || i.columna || coalesce(' = ' || pl.id, '') || ': ¿usa ' || i.n || '?',
         case when pl.id is null then 'Sin filas recientes de esta flota: no hay unidad que probar' when bool_or(pl.l like 'NO SE PUDO%') then 'NO SE PUDO (ver abajo)'
              when bool_or(pl.l like '%' || i.n || '%') and not bool_or(pl.l ~ '(Seq Scan|Sort)') then 'SÍ: recorre el índice en orden y para en 5'
              else 'NO: Seq Scan o Sort = lee TODAS las filas de 30 días de la unidad (ver el plan)' end,
         'La unidad real con más filas recientes de esa flota. Con ANALYZE: «actual time» y «Buffers» = costo real.'
    from idx i left join pl on pl.indice = i.n group by i.n, i.columna, pl.id
  union all select 20.01 + 0.01 * (columna = 'vehiculo_tercero_id')::int + 0.0001 * k, '(b) plan · ' || columna, l, '' from pl
  union all select 30, '(c) y (d) NO SE MIDIERON', 'Falta o está INVÁLIDO un índice de (a)', 'Medirlas leería la tabla entera una vez por unidad.'
    from idx having not bool_and(coalesce(valido, false))
  union all select 30 + (f = 'tercero')::int * 0.5 + 0.01 * array_position(array['≤2 min','≤1 h','≤1 d','≤7 d','≤30 d','solo descartadas','>30 d','nunca'], t),
         '(c) ' || f || ' · ' || t, count(*)::text, 'Última posición VÁLIDA (lo que ve el endpoint). Descartadas = simuladas o sin lat.'
    from (select f, case when n5 > 0 then case when m <= 2 then '≤2 min' when m <= 60 then '≤1 h' when m <= 1440 then '≤1 d'
            when m <= 10080 then '≤7 d' else '≤30 d' end when ultima is null then 'nunca' when u30 then 'solo descartadas' else '>30 d' end as t
            from ed) z group by f, t
  union all select 41, '(d) Última fila de 30 d · ' || count(*) || ' unidades', 'simulada ' || count(*) filter (where (ultima ->> 'simulado')::boolean)
         || ' · (0,0) ' || count(*) filter (where (ultima ->> 'lat')::float8 = 0 and (ultima ->> 'lng')::float8 = 0) || ' · finalizado ' || count(*) filter
           (where u_fin) || ' (precisión nula o >150: ' || count(*) filter (where u_fin and coalesce(u_prec, 999) > 150) || ', precisión 0: ' || count(*) filter
           (where u_fin and u_prec = 0) || ') · created_at > recibido_en ' || count(*) filter (where adel > 0) || ' (por >2 min: ' || count(*) filter (where adel > 120)
         || ') · sin recibido_en ' || count(*) filter (where ultima ->> 'recibido_en' is null) || ' · sin fix_ts ' || count(*) filter (where ultima ->> 'fix_ts' is null),
         'Precisión 0 = no se sabe (la app del tercero escribe 0). created_at > recibido_en = reloj del teléfono adelantado.' from ed where u30 having count(*) > 0
  union all select 42, '(d) Las 5 filas del endpoint', 'unidades con 1-4 filas válidas ' || count(*) filter (where n5 between 1 and 4)
         || ' · la primera es un finalizado impreciso (nula, 0 o >150 m) ' || count(*) filter (where fin_imp)
         || ', y de esas con un fix preciso entre las 5: ' || count(*) filter (where fin_imp and precisos > 0),
         'Si muchos finalizados imprecisos NO tienen un fix preciso entre las 5, FILAS_POR_UNIDAD = 5 no alcanza.' from ed having count(*) > 0
  union all select 43, '(d) Filas de la última hora SIN unidad', count(*) filter (where sin_unidad) || ' de ' || count(*) || ', de '
         || count(distinct cond) filter (where sin_unidad) || ' conductor(es)', 'Sin vehiculo_id ni vehiculo_tercero_id (app sin vehículo elegido): el endpoint por unidad NO las ve.' from rec
  union all select 51, '(e) Columna `timestamp`', coalesce((select tipo || ' · default ' || coalesce(def, 'NINGUNO') from col where c = 'timestamp'), 'NO EXISTE'),
         'default now() = hora del SERVIDOR al insertar (como recibido_en). Sin zona: el navegador la lee como hora LOCAL.'
  union all select 52 + 0.1 * row_number() over (order by k.k desc), '(e) ' || k.k || ' · última hora (s)', coalesce('n ' || w.n || ' · p1 ' || round(w.q[1]::numeric, 1)
           || ' · p5 ' || round(w.q[2]::numeric, 1) || ' · p50 ' || round(w.q[3]::numeric, 1) || ' · p95 ' || round(w.q[4]::numeric, 1) || ' · p99 '
           || round(w.q[5]::numeric, 1), 'sin filas'), 'Negativo = teléfono adelantado; p95/p99 altos = colas offline.' from (values ('timestamp − created_at'),
           ('recibido_en − created_at')) k(k) cross join lateral (select count(d) as n, percentile_cont(array[.01, .05, .5, .95, .99]::float8[]) within group
           (order by d) as q from (select extract(epoch from case when k.k like 'timestamp%' then tsc else rcb end - ca)::float8 as d from rec) r) w
  union all select 54, '(e) timestamp = recibido_en en la misma fila', count(*) filter (where tsc = rcb) || ' de ' || count(*) filter (where tsc is not null and rcb is not null),
         'Iguales = las dos son el now() de la misma inserción: `timestamp` haría de recibido_en en filas viejas.' from rec)
select o as "#", pregunta, respuesta, como as "cómo se lee" from filas order by o;
-- FIN de diagnostico-monitoreo-flota.sql
