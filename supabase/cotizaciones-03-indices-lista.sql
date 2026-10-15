-- supabase/cotizaciones-03-indices-lista.sql
-- Índices para la LISTA LIVIANA de /cotizaciones (periodo + paginado con orden total).
--
-- QUÉ HACE: (1) índice por fecha de EMISIÓN `(created_at desc, id desc)` — el eje por
-- defecto de la lista, que pagina con `.range()` y orden `id desc` dentro del periodo;
-- (2) índice por fecha de SERVICIO `(fecha_servicio, id)` — el otro eje del filtro;
-- (3) columna generada `paradas_n` (cuántos paraderos tiene la ida), para que la lista
-- pueda enseñar el número sin traer `paradas_json` entero (el JSON pesa por fila).
--
-- SI NO SE CORRE: la pantalla funciona igual. Sin los índices, cada página es un
-- recorrido + orden de la tabla entera (lento al crecer, no roto). Sin `paradas_n`, el
-- código suelta la columna que el error nombra y no enseña el conteo de paraderos.
--
-- ⚠ CORRER EN HORA VALLE: agregar una columna generada STORED REESCRIBE la tabla
-- `cotizaciones` entera bajo un candado exclusivo (nadie puede guardar una cotización
-- mientras dura). Los `create index` normales también bloquean las escrituras mientras se
-- construyen. Con pocos miles de filas son segundos, pero no a media mañana.
--
-- TIPO DE `paradas_json`: ningún SQL del repo lo declara (la tabla nació fuera del repo);
-- el código lo trata como jsonb (app/cotizaciones/page.tsx: "Viaja en paradas_json
-- (jsonb)"). Por eso el paso 3 MIRA el tipo real antes de crear la columna: jsonb → las
-- funciones jsonb_*; json → las json_*; cualquier otro tipo → no la crea y lo avisa
-- (NOTICE), sin fallar. Una fila con algo que no sea un array cuenta 0 paraderos.
--
-- RLS: no se toca. La política `to authenticated` que dejó seguridad-01-rls.sql sigue
-- vigente; una columna generada la hereda (la RLS es por fila, no por columna).
--
-- Idempotente: se puede correr dos veces. Se corre ENTERO con Run.

-- 1. Eje EMISIÓN (por defecto): periodo sobre created_at, orden total con id.
create index if not exists idx_cotizaciones_created_at
  on public.cotizaciones (created_at desc, id desc);

-- 2. Eje SERVICIO: periodo sobre fecha_servicio, orden total con id.
create index if not exists idx_cotizaciones_fecha_servicio
  on public.cotizaciones (fecha_servicio, id);

-- 3. Conteo de paraderos de la ida, derivado (nunca se escribe a mano).
do $$
declare
  tipo text := (
    select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'cotizaciones'
      and column_name = 'paradas_json'
  );
  ya boolean := exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cotizaciones'
      and column_name = 'paradas_n'
  );
begin
  if ya then
    raise notice 'paradas_n ya existe: no se toca.';
  elsif tipo = 'jsonb' then
    execute 'alter table public.cotizaciones add column if not exists paradas_n int '
         || 'generated always as (case jsonb_typeof(paradas_json) when ''array'' '
         || 'then jsonb_array_length(paradas_json) else 0 end) stored';
  elsif tipo = 'json' then
    execute 'alter table public.cotizaciones add column if not exists paradas_n int '
         || 'generated always as (case json_typeof(paradas_json) when ''array'' '
         || 'then json_array_length(paradas_json) else 0 end) stored';
  else
    raise notice 'paradas_json es de tipo % (o no existe): paradas_n NO se crea.', coalesce(tipo, 'ninguno');
  end if;
end $$;

comment on index public.idx_cotizaciones_created_at is
  'Lista de /cotizaciones por fecha de emisión, paginada con orden total (created_at, id).';
comment on index public.idx_cotizaciones_fecha_servicio is
  'Lista de /cotizaciones por fecha de servicio, paginada con orden total (fecha_servicio, id).';

-- VERIFICACIÓN (después de correrlo):
--   select indexname from pg_indexes where tablename = 'cotizaciones'
--     and indexname like 'idx_cotizaciones_%';
--   select paradas_n, count(*) from public.cotizaciones group by 1 order by 1;

-- FIN de cotizaciones-03-indices-lista.sql
