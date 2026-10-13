-- ══ gps-analitica-01c-indices.sql · parte 3 de 3 · ⚠ HORA VALLE ════════════════
-- Crea el índice parcial idx_gps_rapidos (los puntos a ≥ 60 km/h) y, si faltan, los dos
-- índices por conductor de retrasos.sql. Sin él, las partes 1 y 2 responden IGUAL pero
-- leyendo la tabla GPS entera en cada llamada.
-- EL DEPLOY NO LO CORRE: SQL Editor → pega el archivo ENTERO → Run. Idempotente: un
-- índice que ya existe no se vuelve a crear ni bloquea nada.
--
-- ⚠ Mientras construye, BLOQUEA los INSERT de GPS de toda la flota (segundos con la tabla
-- de hoy; la app del conductor encola los puntos y los manda después). De madrugada y sin
-- servicios en curso. Si la tabla está ocupada falla a los 5 s («lock timeout») sin dejar
-- nada a medias: reintenta en un minuto. Camino sin bloqueo (psql): las notas, «01c».
--
-- ANTES y DESPUÉS: supabase/diagnostico-gps-analitica-1-resumen.sql (solo lee).
-- La última línea es «-- FIN de gps-analitica-01c-indices.sql».

-- Fallar en 5 s si la tabla está ocupada, en vez de dejar los GPS encolados detrás.
set lock_timeout = '5s';

do $$
declare
  r record;
begin
  -- Se comprueba ANTES: `create index if not exists` toma el candado aunque el índice exista.
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
    raise warning 'El índice % existe pero está INVÁLIDO (una creación sin bloqueo que no terminó): el planificador no lo usa. Bórralo y vuelve a crearlo por psql, sin bloqueo (supabase/gps-analitica-01-notas.md, «01c»).', r.nombre;
  end loop;
end $$;

-- No dejar el plazo de 5 s pegado a la sesión del SQL Editor.
reset lock_timeout;

-- FIN de gps-analitica-01c-indices.sql
