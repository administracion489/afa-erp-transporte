-- ════════════════════════════════════════════════════════════════════════════
-- gps-analitica-01-excesos.sql
-- Los puntos GPS RÁPIDOS de toda la flota, leídos con un índice, para medir los
-- excesos de velocidad (/seguridad-vial).
--
-- EL DEPLOY NO CORRE ESTE ARCHIVO: se ejecuta a mano en Supabase → SQL Editor.
-- Es idempotente: se puede pegar entero y correr las veces que haga falta. La
-- segunda corrida NO vuelve a tomar el candado de `ubicaciones_gps` (paso 6).
--
-- ANTES DE CORRERLO, corre `supabase/diagnostico-gps-analitica.sql` (solo lee): dice
-- cuánto pesa la tabla y qué índices tiene, que es lo que decide si el paso 6 se
-- puede correr desde el editor o conviene hacerlo por psql.
--
-- ─── QUÉ CREA ───────────────────────────────────────────────────────────────
--
--   1. public.fn_gps_puntos_rapidos(desde, hasta, umbral) → jsonb
--      Los puntos de UN día (≤ 26 h) con velocidad ≥ umbral, de toda la flota, en
--      UN solo valor JSON. PostgREST corta toda respuesta tabular en 1000 filas y un
--      día de carretera tiene decenas de miles de puntos rápidos: paginar eso desde
--      el servidor serían decenas de idas y vueltas por día. Un solo valor jsonb no
--      tiene ese corte.
--   2. public.fn_gps_velocimetro(desde, hasta, propios[], terceros[]) → tabla
--      Por conductor: ¿mandó puntos? ¿alguno con velocidad > 0? Es lo que separa
--      «0 excesos» de «no se puede juzgar: su teléfono no reporta la velocidad del
--      sensor» (muchos tercerizados por navegador mandan siempre 0). Sin esto la
--      pantalla afirmaría un «0» que nadie midió.
--   3. Índice parcial idx_gps_rapidos (created_at) WHERE velocidad >= 60, y copias
--      idempotentes de idx_gps_conductor_fecha / idx_gps_conductor_ter_fecha
--      (retrasos.sql), que son los que usa fn_gps_velocimetro.
--
-- ─── QUÉ PASA SI NO SE CORRE ────────────────────────────────────────────────
--
-- Solo /seguridad-vial deja de medir: muestra un aviso ámbar que nombra este archivo
-- (el lector detecta la función que falta con `funcionQueFalta`, lib/columna-faltante.ts,
-- y NO cae a recorrer la tabla entera). Nada más cambia: la estadística por servicio de
-- /uso-flota → Servicios cuenta los excesos de cada servicio leyendo su traza por
-- reserva_id, igual que la torre, y no necesita esta migración.
--
-- ─── EL CANDADO (léelo antes de correr el paso 6) ───────────────────────────
--
-- Un CREATE INDEX normal toma un lock SHARE sobre `ubicaciones_gps` que BLOQUEA los
-- INSERT de GPS de toda la flota mientras construye (segundos a ~1 min según el tamaño;
-- el índice es parcial, pero para construirlo hay que leer la tabla entera). No se pierde
-- rastreo —la app del conductor encola los puntos y los drena al reconectar— pero se
-- corre en HORA VALLE, de madrugada y sin servicios en curso. Es la misma advertencia de
-- la sección 7 de retrasos.sql.
--
-- POR QUÉ NO VA `concurrently`: el editor SQL de Supabase envuelve TODO el script en
-- una transacción y CREATE INDEX CONCURRENTLY no puede correr dentro de una (ERROR 25001).
--
-- SI EL PASO 6 FALLA (lock_timeout de 5 s porque la tabla estaba ocupada, o el editor
-- corta por tiempo), la transacción se revierte ENTERA, funciones incluidas: no queda nada
-- a medias. Se vuelve a correr en otro momento, o se toma el camino sin bloqueo:
--   a) en este archivo, comenta el paso 6 y córrelo: las funciones quedan creadas (al
--      instante, sin candado sobre la tabla);
--   b) por psql (Supabase → Connect → Connection string), donde cada sentencia va en
--      autocommit, crea los índices sin bloquear los INSERT:
--        create index concurrently if not exists idx_gps_rapidos
--          on public.ubicaciones_gps (created_at) where velocidad >= 60;
--        create index concurrently if not exists idx_gps_conductor_fecha
--          on public.ubicaciones_gps (conductor_id, created_at desc) where conductor_id is not null;
--        create index concurrently if not exists idx_gps_conductor_ter_fecha
--          on public.ubicaciones_gps (conductor_tercero_id, created_at desc) where conductor_tercero_id is not null;
--      Si un CONCURRENTLY falla a mitad, deja el índice INVÁLIDO con ese nombre (el
--      planificador no lo usa, pero se sigue manteniendo en cada INSERT). Se ve en la
--      revisión 2 de abajo y se arregla por psql:
--        drop index concurrently if exists public.idx_gps_rapidos;   -- y volver a crearlo
-- Sin el índice las funciones responden IGUAL (mismo resultado), solo que leyendo la
-- tabla entera en cada llamada: lento y compitiendo con la torre.
--
-- ─── SEGURIDAD ──────────────────────────────────────────────────────────────
--
-- Las dos funciones devuelven posiciones de TODA la flota: solo las ejecuta el servidor
-- (service-role, detrás de verificarUsuarioApi("monitoreo") en /api/flota/excesos).
-- Postgres le da EXECUTE a PUBLIC en toda función nueva, y Supabase además a anon y
-- authenticated por default privileges: se revoca a los tres y se concede solo a
-- service_role (paso 3).
--
-- SON SECURITY INVOKER A PROPÓSITO, no definer: service-role no mira RLS, así que no les
-- hace falta. Y la sección 4 de seguridad-01-rls.sql le vuelve a dar EXECUTE a
-- `authenticated` a TODA función SECURITY DEFINER de `public` cada vez que se corre: una
-- definer quedaría abierta a cualquier usuario del ERP la próxima vez que alguien corra ese
-- archivo. Las invoker no las toca. Sin SQL dinámico: todos los parámetros van como
-- parámetros, nunca concatenados.
--
-- ─── ¿QUEDÓ INSTALADO? (copiar y correr después) ────────────────────────────
--
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid)          as argumentos,
--        p.provolatile = 's'                                 as es_stable,
--        p.prosecdef                                         as es_definer,     -- debe ser false
--        p.proconfig                                         as config,         -- {search_path=public}
--        has_function_privilege('anon',          p.oid, 'execute') as anon,     -- false
--        has_function_privilege('authenticated', p.oid, 'execute') as erp,      -- false
--        has_function_privilege('service_role',  p.oid, 'execute') as servidor  -- true
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('fn_gps_puntos_rapidos', 'fn_gps_velocimetro');
--
-- select c.relname as indice, i.indisvalid as valido, pg_get_indexdef(i.indexrelid) as definicion
--   from pg_index i join pg_class c on c.oid = i.indexrelid
--  where i.indrelid = 'public.ubicaciones_gps'::regclass
--    and c.relname in ('idx_gps_rapidos', 'idx_gps_conductor_fecha', 'idx_gps_conductor_ter_fecha');
--
-- O, de una vez con el resto del ERP: supabase/diagnostico-migraciones.sql (filas
-- «Seguridad vial · …»). Más revisiones al final de este archivo.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 0) Candado con plazo ────────────────────────────────────────────────────
-- Solo el paso 6 toma un candado sobre una tabla (SHARE sobre `ubicaciones_gps`). Si
-- está ocupada, mejor FALLAR en 5 s con un mensaje claro que quedarse esperando con los
-- GPS de toda la flota encolados detrás. El plazo es para CONSEGUIR el candado, no para
-- construir el índice. Reintentar es seguro: si algo falla, se revierte completo.
set lock_timeout = '5s';


-- ── 1) fn_gps_puntos_rapidos: los puntos rápidos de un día, en UN valor ──────
--
-- CONTRATO (lo consume lib/flota/excesos-datos.ts → puntosDeRpc, lib/flota/excesos.ts):
--
--   fn_gps_puntos_rapidos(p_desde timestamptz, p_hasta timestamptz, p_umbral integer) → jsonb
--
--   {"recortado": bool,
--    "puntos": [[epoch_ms, lat, lng, velocidad, precision_m, reserva_id, conductor_id,
--                conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, simulado], …]}
--
--   · Filas de `ubicaciones_gps` con velocidad ≥ p_umbral y created_at en [p_desde, p_hasta),
--     en orden (created_at, id). `created_at` es la hora del TELÉFONO, la misma con que se
--     mide todo lo demás del rastreo (lib/gps-cobertura-datos.ts).
--   · epoch_ms = created_at en milisegundos (truncado), entero.
--   · lat, lng, velocidad (km/h) y precision_m (m) van con su tipo numérico de la tabla;
--     precision_m nula sale null (= precisión desconocida: el motor NO la toma por buena).
--   · Los cinco ids van como entero (cast explícito a bigint, sea cual sea el tipo de la
--     columna), o null. El conductor vive en DOS columnas porque los ids de `conductores` y
--     `conductores_tercero` se solapan: va llena una de las dos.
--   · simulado: true / false / null, TRI-ESTADO como la columna (null = no se pudo
--     comprobar). Si la columna `simulado` no existe en esta base, sale null en todos.
--   · TOPE de 60 000 puntos: si había más, salen los 60 000 primeros y "recortado": true.
--     La pantalla tiene que decir que ese día está incompleto, nunca contarlo como entero.
--   · Las filas con lat/lng nulos NO se filtran aquí: el lector decide (el motor las descarta).
--
-- VALIDACIONES (raise exception, SQLSTATE 22023 → PostgREST 400; el lector lo trata como
-- error, nunca como «0 puntos»):
--   · p_umbral entre 60 y 130. 60 es ESTRUCTURAL: es el piso del índice parcial, y el WHERE
--     lleva `velocidad >= 60` literal, así que un umbral menor devolvería SOLO los ≥ 60 y
--     afirmaría en silencio que no hubo puntos entre el umbral y 60. 130 es `VMAX_BUS_KMH`
--     de lib/huella.ts: por encima, el motor ya los descarta como imposibles.
--   · p_hasta > p_desde, y como mucho 26 h: un día de Lima más el colchón de ±60 s con que el
--     lector une las tandas, con holgura. Un rango mayor no se pide de una vez: el JSON de un
--     mes no cabe en una respuesta.
--
-- EL LITERAL `velocidad >= 60` NO SOBRA. El umbral llega como parámetro, y con un plan
-- genérico (plpgsql lo usa a partir de la sexta llamada en la misma conexión) el
-- planificador no sabe cuánto vale: no puede demostrar que `velocidad >= $3` implica el
-- predicado del índice y no lo usaría. Con el literal en el texto, la implicación es
-- trivial y el índice se usa siempre. Si cambias el piso, cámbialo en los DOS sitios (el
-- índice del paso 6 y esta línea) y en UMBRAL_MIN_KMH de lib/flota/excesos.ts.
--
-- POR QUÉ `simulado` SE LEE CON to_jsonb(g) Y NO COMO COLUMNA: la columna la crea
-- ubicaciones-gps-simulado.sql, otra migración accesoria. Nombrarla directamente haría
-- fallar la función en una base sin ella. Generar el cuerpo según exista o no al correr
-- este archivo (DO + EXECUTE) lo congelaría: si la columna se agrega DESPUÉS, la función
-- seguiría devolviendo null y el veto de los puntos simulados quedaría apagado en silencio
-- hasta que alguien se acordara de volver a correr esto — un exceso con GPS falso contado
-- como de verdad. Leerla del registro en cada llamada no depende de nada: sin la columna
-- sale null (= no se sabe), con ella sale su valor, sin re-correr nada y sin SQL dinámico.
-- Cuesta convertir a JSON solo las filas que pasan el filtro (≤ 60 001): medido en un
-- PostgreSQL 16 local, ~4 µs por fila, o sea ~0.25 s en el peor caso del tope (la llamada
-- entera, con 60 000 puntos, ~0.7 s y ~4.7 MB de JSON). Con el umbral de 90 son muchas
-- menos filas.
create or replace function public.fn_gps_puntos_rapidos(
  p_desde  timestamptz,
  p_hasta  timestamptz,
  p_umbral integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  c_tope      constant integer := 60000;
  v_recortado boolean;
  v_puntos    jsonb;
begin
  if p_desde is null or p_hasta is null or p_umbral is null then
    raise exception 'fn_gps_puntos_rapidos: desde, hasta y umbral son obligatorios'
      using errcode = '22023';
  end if;
  if p_umbral < 60 or p_umbral > 130 then
    raise exception 'fn_gps_puntos_rapidos: el umbral % km/h está fuera de 60..130', p_umbral
      using errcode = '22023',
            hint = '60 es el piso del índice parcial idx_gps_rapidos; 130 es VMAX_BUS_KMH.';
  end if;
  if p_hasta <= p_desde then
    raise exception 'fn_gps_puntos_rapidos: hasta (%) tiene que ser posterior a desde (%)', p_hasta, p_desde
      using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '26 hours' then
    raise exception 'fn_gps_puntos_rapidos: el rango % excede 26 horas', p_hasta - p_desde
      using errcode = '22023',
            hint = 'Se pide un día de Lima por llamada (con su colchón); un rango mayor se parte en días.';
  end if;

  select count(*) > c_tope,
         coalesce(
           jsonb_agg(
             jsonb_build_array(
               floor(extract(epoch from s.created_at) * 1000)::bigint,
               s.lat,
               s.lng,
               s.velocidad,
               s.precision_m,
               s.reserva_id,
               s.conductor_id,
               s.conductor_tercero_id,
               s.vehiculo_id,
               s.vehiculo_tercero_id,
               s.simulado
             )
             order by s.n
           ) filter (where s.n <= c_tope),
           '[]'::jsonb)
    into v_recortado, v_puntos
    from (
      select g.created_at,
             g.lat,
             g.lng,
             g.velocidad,
             g.precision_m,
             g.reserva_id::bigint           as reserva_id,
             g.conductor_id::bigint         as conductor_id,
             g.conductor_tercero_id::bigint as conductor_tercero_id,
             g.vehiculo_id::bigint          as vehiculo_id,
             g.vehiculo_tercero_id::bigint  as vehiculo_tercero_id,
             to_jsonb(g) -> 'simulado'      as simulado,
             row_number() over (order by g.created_at, g.id) as n
        from public.ubicaciones_gps g
       where g.velocidad >= 60                -- literal: lo que hace usable el índice parcial
         and g.velocidad >= p_umbral
         and g.created_at >= p_desde
         and g.created_at <  p_hasta
       order by g.created_at, g.id
       limit c_tope + 1                       -- uno de más: así se sabe si hubo que recortar
    ) s;

  return jsonb_build_object('recortado', coalesce(v_recortado, false),
                            'puntos',    v_puntos);
end
$fn$;


-- ── 2) fn_gps_velocimetro: ¿el teléfono de cada conductor reporta velocidad? ──
--
-- CONTRATO:
--
--   fn_gps_velocimetro(p_desde timestamptz, p_hasta timestamptz,
--                      p_propios bigint[], p_terceros bigint[])
--     → table(tabla text, conductor_id bigint, hay_puntos boolean, hay_velocidad boolean)
--
--   · Una fila por id DISTINTO y no nulo de cada arreglo (un arreglo nulo vale vacío):
--       tabla = 'conductores'          para los de p_propios  (ubicaciones_gps.conductor_id)
--       tabla = 'conductores_tercero'  para los de p_terceros (ubicaciones_gps.conductor_tercero_id)
--     Los ids de las dos tablas se SOLAPAN: la clave del conductor es (tabla, conductor_id).
--   · hay_puntos    = mandó al menos un punto con created_at en [p_desde, p_hasta).
--   · hay_velocidad = alguno de esos puntos trae velocidad > 0 (la del sensor; una velocidad
--                     nula no cuenta). NULL cuando hay_puntos es false: sin puntos no hay
--                     evidencia de nada, y un false diría «su teléfono no tiene velocímetro»,
--                     que no se midió. El lector lo lee con velocimetroDe(hay_puntos,
--                     hay_velocidad) → con_velocimetro | sin_velocimetro | sin_gps | no_se_sabe.
--   · Orden (tabla, conductor_id).
--
-- Cada respuesta es un `exists`: sobre los índices (conductor_id | conductor_tercero_id,
-- created_at desc) se corta en el primer punto que la contesta. El caso caro es justo el
-- que se busca —un conductor SIN ninguna velocidad recorre todos sus puntos del rango—, y
-- por eso el rango y los arreglos tienen tope.
--
-- VALIDACIONES (raise exception, 22023): rango no nulo, hasta > desde, como mucho 8 días (la
-- semana que pide /api/flota/excesos más su colchón) y como mucho 300 ids por arreglo.
create or replace function public.fn_gps_velocimetro(
  p_desde    timestamptz,
  p_hasta    timestamptz,
  p_propios  bigint[],
  p_terceros bigint[]
)
returns table(tabla text, conductor_id bigint, hay_puntos boolean, hay_velocidad boolean)
language plpgsql
stable
security invoker
set search_path = public
as $fn$
#variable_conflict use_column
begin
  if p_desde is null or p_hasta is null then
    raise exception 'fn_gps_velocimetro: desde y hasta son obligatorios'
      using errcode = '22023';
  end if;
  if p_hasta <= p_desde then
    raise exception 'fn_gps_velocimetro: hasta (%) tiene que ser posterior a desde (%)', p_hasta, p_desde
      using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '8 days' then
    raise exception 'fn_gps_velocimetro: el rango % excede 8 días', p_hasta - p_desde
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_propios), 0) > 300 or coalesce(cardinality(p_terceros), 0) > 300 then
    raise exception 'fn_gps_velocimetro: como mucho 300 conductores por arreglo (llegaron % propios y % terceros)',
                    coalesce(cardinality(p_propios), 0), coalesce(cardinality(p_terceros), 0)
      using errcode = '22023';
  end if;

  -- Todas las columnas van calificadas: `conductor_id` es a la vez columna de
  -- ubicaciones_gps y columna de salida (variable) de esta función.
  return query
  select x.tabla, x.cid, x.hp,
         case when x.hp then
           case x.tabla
             when 'conductores' then exists (
               select 1 from public.ubicaciones_gps g
                where g.conductor_id = x.cid
                  and g.created_at >= p_desde and g.created_at < p_hasta
                  and g.velocidad > 0)
             else exists (
               select 1 from public.ubicaciones_gps g
                where g.conductor_tercero_id = x.cid
                  and g.created_at >= p_desde and g.created_at < p_hasta
                  and g.velocidad > 0)
           end
         end
    from (
      select 'conductores'::text as tabla, u.cid,
             exists (select 1 from public.ubicaciones_gps g
                      where g.conductor_id = u.cid
                        and g.created_at >= p_desde and g.created_at < p_hasta) as hp
        from (select distinct a.v as cid
                from unnest(coalesce(p_propios, '{}'::bigint[])) as a(v)
               where a.v is not null) u
      union all
      select 'conductores_tercero'::text, u.cid,
             exists (select 1 from public.ubicaciones_gps g
                      where g.conductor_tercero_id = u.cid
                        and g.created_at >= p_desde and g.created_at < p_hasta)
        from (select distinct a.v as cid
                from unnest(coalesce(p_terceros, '{}'::bigint[])) as a(v)
               where a.v is not null) u
    ) x
   order by 1, 2;
end
$fn$;


-- ── 3) Permisos: solo el servidor ───────────────────────────────────────────
-- Se repite en cada corrida: `create or replace` conserva los permisos que ya tenía la
-- función, y este bloque deja siempre los mismos.
revoke all on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)
  to service_role;

revoke all on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])
  to service_role;


-- ── 4) Documentación en la base ─────────────────────────────────────────────
comment on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer) is
  'Puntos GPS de toda la flota con velocidad >= umbral (60..130 km/h) en [desde, hasta) '
  '(<= 26 h), en orden (created_at, id), como {"recortado": bool, "puntos": [[epoch_ms, lat, '
  'lng, velocidad, precision_m, reserva_id, conductor_id, conductor_tercero_id, vehiculo_id, '
  'vehiculo_tercero_id, simulado], ...]}, con tope de 60000 puntos. Un solo valor para '
  'esquivar el corte de 1000 filas de PostgREST. Usa el índice parcial idx_gps_rapidos. '
  'Solo service-role (/api/flota/excesos). Migración: supabase/gps-analitica-01-excesos.sql.';

comment on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[]) is
  'Por conductor (tabla = conductores | conductores_tercero): hay_puntos = mandó GPS en '
  '[desde, hasta) (<= 8 días); hay_velocidad = alguno con velocidad > 0, NULL si no hubo '
  'puntos. Separa «0 excesos» de «sin velocímetro: no se puede juzgar». <= 300 ids por '
  'arreglo. Solo service-role. Migración: supabase/gps-analitica-01-excesos.sql.';


-- ── 5) Que PostgREST vea las funciones nuevas sin esperar ───────────────────
-- Sin recargar su caché, la primera llamada RPC podría responder PGRST202 («Could not
-- find the function») y el lector lo leería como «falta la migración». Se entrega al
-- confirmar la transacción.
notify pgrst, 'reload schema';


-- ── 6) Índices en ubicaciones_gps · TOMA EL CANDADO: HORA VALLE ──────────────
--
-- VA AL FINAL A PROPÓSITO: el lock SHARE se retiene hasta que termina la transacción (el
-- editor corre todo el archivo en una), y lo último que se toma es lo que menos se retiene.
--
-- Cada índice se crea SOLO SI FALTA, y la comprobación va ANTES: `create index if not
-- exists` toma el candado de la tabla incluso cuando el índice ya existe (lo mira después
-- de bloquear), así que sin este `if` cada re-corrida detendría los INSERT de GPS para nada.
--
-- idx_gps_rapidos: parcial, solo las filas a ≥ 60 km/h — una fracción pequeña de la tabla
-- (en la ciudad casi nada pasa de 60), así que el índice es chico. Ver el literal del
-- paso 1. La clave es (created_at): el orden secundario por id lo resuelve un sort
-- incremental sobre unos pocos empates.
--
-- idx_gps_conductor_fecha / idx_gps_conductor_ter_fecha: COPIAS EXACTAS de retrasos.sql
-- (sección 7), por si este archivo se corre en una base sin ese módulo. Son los que hacen
-- que cada `exists` de fn_gps_velocimetro se corte pronto.
--
-- Un índice que existe pero quedó INVÁLIDO (un CONCURRENTLY que falló) no se toca aquí:
-- borrarlo exige un candado que bloquea también las LECTURAS de la tabla durante toda la
-- reconstrucción. Se avisa y se arregla por psql (ver la cabecera).
do $$
declare
  r record;
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'ubicaciones_gps'
                    and indexname = 'idx_gps_rapidos') then
    create index if not exists idx_gps_rapidos
      on public.ubicaciones_gps (created_at) where velocidad >= 60;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'ubicaciones_gps'
                    and indexname = 'idx_gps_conductor_fecha') then
    create index if not exists idx_gps_conductor_fecha
      on public.ubicaciones_gps (conductor_id, created_at desc) where conductor_id is not null;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'ubicaciones_gps'
                    and indexname = 'idx_gps_conductor_ter_fecha') then
    create index if not exists idx_gps_conductor_ter_fecha
      on public.ubicaciones_gps (conductor_tercero_id, created_at desc) where conductor_tercero_id is not null;
  end if;

  for r in
    select c.relname as nombre
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'public.ubicaciones_gps'::regclass
       and c.relname in ('idx_gps_rapidos', 'idx_gps_conductor_fecha', 'idx_gps_conductor_ter_fecha')
       and not i.indisvalid
  loop
    raise warning 'El índice % existe pero está INVÁLIDO (una creación sin bloqueo que no terminó): el planificador no lo usa. Bórralo y vuelve a crearlo por psql, sin bloqueo (ver la cabecera de gps-analitica-01-excesos.sql).', r.nombre;
  end loop;
end $$;

-- No dejar el plazo de 5 s pegado a la sesión del SQL Editor. (Si algo falló, el SET se
-- revirtió con la transacción y esta línea no hace falta.)
reset lock_timeout;


-- ════════════════════════════════════════════════════════════════════════════
-- REVISIÓN (después de correrlo). Comentadas a propósito: se copian de a una.
-- El SQL Editor corre como `postgres`, dueño de las funciones: las puede llamar aunque
-- anon y authenticated no.
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1) Las funciones, su forma y sus permisos (ver «¿QUEDÓ INSTALADO?» en la cabecera):
--    es_stable true · es_definer false · config {search_path=public} ·
--    anon false · erp false · servidor true.
--
-- 2) Los índices de la tabla y si son VÁLIDOS (un inválido no lo usa el planificador):
-- select c.relname as indice, i.indisvalid as valido,
--        pg_size_pretty(pg_relation_size(i.indexrelid)) as tamano,
--        pg_get_indexdef(i.indexrelid) as definicion
--   from pg_index i join pg_class c on c.oid = i.indexrelid
--  where i.indrelid = 'public.ubicaciones_gps'::regclass
--  order by 1;
--
-- 3) El plan de la consulta de la función (la misma consulta, con el umbral como literal;
--    EXPLAIN sin ANALYZE no la ejecuta). ESPERADO:
--      Limit → WindowAgg → Incremental Sort (Presorted Key: created_at)
--            → Index Scan using idx_gps_rapidos (Index Cond: created_at >= … AND created_at < …;
--                                                Filter: velocidad >= 90)
--    Si sale «Seq Scan on ubicaciones_gps», el índice no está o no es válido (revisión 2).
-- explain
-- select g.created_at, row_number() over (order by g.created_at, g.id)
--   from public.ubicaciones_gps g
--  where g.velocidad >= 60 and g.velocidad >= 90
--    and g.created_at >= now() - interval '1 day' and g.created_at < now()
--  order by g.created_at, g.id
--  limit 60001;
--
-- 4) Una llamada de verdad: ayer en Lima ([05:00Z, 05:00Z del día siguiente)), umbral 90.
--    Cuántos puntos, si se recortó, y el primero.
-- with d as (
--   select ((date_trunc('day', now() at time zone 'America/Lima') - interval '1 day')
--             at time zone 'America/Lima') as desde,
--          (date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima') as hasta
-- ), r as (
--   select public.fn_gps_puntos_rapidos(d.desde, d.hasta, 90) as j from d
-- )
-- select jsonb_array_length(j -> 'puntos') as puntos,
--        j -> 'recortado'                  as recortado,
--        j -> 'puntos' -> 0                as primero
--   from r;
--
-- 5) Las validaciones (cada una debe FALLAR con 22023):
-- select public.fn_gps_puntos_rapidos(now(), now() - interval '1 hour', 90);   -- hasta <= desde
-- select public.fn_gps_puntos_rapidos(now() - interval '2 days', now(), 90);   -- > 26 h
-- select public.fn_gps_puntos_rapidos(now() - interval '1 day', now(), 50);    -- umbral < 60
-- select * from public.fn_gps_velocimetro(now() - interval '9 days', now(), null, null);  -- > 8 días
--
-- 6) El velocímetro de los conductores que mandaron GPS ayer (salen con hay_puntos true;
--    los de hay_velocidad false son los que /seguridad-vial dirá «sin velocímetro»):
-- with d as (
--   select ((date_trunc('day', now() at time zone 'America/Lima') - interval '1 day')
--             at time zone 'America/Lima') as desde,
--          (date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima') as hasta
-- )
-- select v.*
--   from d,
--        public.fn_gps_velocimetro(
--          d.desde, d.hasta,
--          (select array_agg(id::bigint) from (select id from public.conductores order by id limit 300) x),
--          (select array_agg(id::bigint) from (select id from public.conductores_tercero order by id limit 300) y)
--        ) v
--  where v.hay_puntos
--  order by v.hay_velocidad nulls first, v.tabla, v.conductor_id;
