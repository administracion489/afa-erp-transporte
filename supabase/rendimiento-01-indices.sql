-- Rendimiento · índices que faltan en las consultas más frecuentes del ERP. No la corre el deploy.
-- Idempotente: crea cada índice SOLO si la tabla no tiene ya uno VÁLIDO y completo que empiece
-- por esa columna (aunque se llame distinto). Si ya existen todos, no toca ninguna tabla.
-- OJO: el SQL Editor corre el script en UNA transacción, así que una tabla a la que se le crea
-- índice queda sin escrituras (esperan, no fallan) hasta que termina el script entero. Por eso
-- el lock_timeout: si una tabla está ocupada, el script falla a los 5 s en vez de encolar las
-- escrituras de la operación. Si falla por eso, se vuelve a correr en un momento más tranquilo.
-- (Sin bloquear nada: cada CREATE INDEX con CONCURRENTLY, uno por uno, desde psql.)
set lock_timeout = '5s';

do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- /seguimiento, /programacion, crons: los servicios de UN día
      ('reservas',           'fecha_servicio', 'idx_reservas_fecha_servicio'),
      -- paraderos, abordajes, pasajeros y gastos de los servicios del día
      ('paradas',            'reserva_id',     'idx_paradas_reserva'),
      ('pasajeros_parada',   'parada_id',      'idx_pasajeros_parada_parada'),
      ('pasajeros_parada',   'pasajero_id',    'idx_pasajeros_parada_pasajero'),
      ('pasajeros',          'reserva_id',     'idx_pasajeros_reserva'),
      ('gastos',             'reserva_id',     'idx_gastos_reserva'),
      ('documentos_vehiculo','vehiculo_id',    'idx_documentos_vehiculo_vehiculo'),
      ('documentos_tercero', 'empresa_id',     'idx_documentos_tercero_empresa'),
      ('mensajes_pasajero',  'pasajero_id',    'idx_mensajes_pasajero_pasajero')
    ) as t(tabla, columna, nombre)
  loop
    -- La tabla o la columna no existe en esta instalación: se salta.
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tabla and column_name = r.columna
    ) then
      continue;
    end if;
    -- ¿Ya hay un índice VÁLIDO y sin WHERE cuya PRIMERA columna es esta? Entonces no hace falta.
    if exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
      where n.nspname = 'public' and c.relname = r.tabla and a.attname = r.columna
        and i.indisvalid and i.indpred is null
    ) then
      continue;
    end if;
    execute format('create index if not exists %I on public.%I (%I)', r.nombre, r.tabla, r.columna);
    raise notice 'Creado % en %(%)', r.nombre, r.tabla, r.columna;
  end loop;

  -- Contador de mensajes de pasajeros SIN LEER (lo pide el menú en cada pantalla). Solo si
  -- existen las columnas y el índice no está ya (así no se toca la tabla de nuevo).
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'mensajes_pasajero' and column_name = 'leido')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'mensajes_pasajero' and column_name = 'remitente')
     and not exists (select 1 from pg_indexes
             where schemaname = 'public' and indexname = 'idx_mensajes_pasajero_no_leidos') then
    execute 'create index idx_mensajes_pasajero_no_leidos on public.mensajes_pasajero (id) '
         || 'where remitente = ''pasajero'' and leido = false';
    raise notice 'Creado idx_mensajes_pasajero_no_leidos';
  end if;
end $$;

reset lock_timeout;

-- Reporte: filas aproximadas e índices de cada tabla.
select s.relname as tabla,
       s.n_live_tup as filas_aprox,
       string_agg(i.indexrelname, ', ' order by i.indexrelname) as indices
from pg_stat_user_tables s
left join pg_stat_user_indexes i on i.relid = s.relid
where s.schemaname = 'public'
  and s.relname in ('reservas','paradas','pasajeros_parada','pasajeros','gastos','documentos_vehiculo',
                    'documentos_tercero','mensajes_pasajero','crm_mensajes','crm_conversaciones')
group by s.relname, s.n_live_tup
order by s.n_live_tup desc;
-- FIN de rendimiento-01-indices.sql
