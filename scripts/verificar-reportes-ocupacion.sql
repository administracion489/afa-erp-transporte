-- ══════════════════════════════════════════════════════════════════════════════
-- ¿SE CORRIERON LOS SQL DEL REPORTE DE OCUPACIÓN?
--
-- Pégalo entero en el SQL Editor de Supabase y dale Run. Cada fila dice si esa
-- pieza está o falta, y CUÁL de los archivos hay que volver a correr.
--
-- No escribe nada: solo lee el catálogo de Postgres.
--
-- ─── POR QUÉ ESTO NO CUENTA CLIENTES NI ENVÍOS ──────────────────────────────
--
-- La primera versión terminaba con un `count(*) from clientes where
-- reporte_ocupacion_activo`, protegido por un CASE. No funciona: Postgres ANALIZA
-- la consulta entera antes de ejecutar nada, así que si la columna no existe el
-- script muere con «column ... does not exist» y NO se ve ninguna de las filas de
-- arriba. O sea: el verificador se rompía exactamente en el único caso en que hace
-- falta. Lo que se consulta por catálogo (`information_schema`, `pg_*`) es seguro
-- siempre, porque son tablas que existen pase lo que pase.
--
-- El conteo de clientes encendidos va al final, comentado, para pegarlo APARTE
-- cuando lo de arriba ya salga en verde.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── reportes-01: a quién se le manda ────────────────────────────────────────
select '01 · clientes.' || c as revisar,
       case when exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'clientes' and column_name = c
       ) then '✅ existe'
         else '❌ FALTA — corre supabase/reportes-01-ocupacion-semanal.sql' end as estado
  from unnest(array[
    'reporte_ocupacion_activo',
    'reporte_ocupacion_correos',
    'reporte_ocupacion_sugerencias'
  ]) as c

union all

-- ── Los DEFAULTS son parte de la migración, no un detalle ───────────────────
--
-- `reporte_ocupacion_activo` tiene que nacer en FALSE: es lo que hace que correr
-- el SQL no empiece a mandarle correos a todos los clientes de la base. Si alguien
-- corrió una versión editada a mano con otro default, las columnas "existen" y el
-- módulo hace algo distinto de lo que dice su documentación. Por eso se comprueba.
select '01 · default de ' || d.col,
       case when coalesce((
              select column_default from information_schema.columns
               where table_schema = 'public' and table_name = 'clientes'
                 and column_name = d.col
            ), '(sin columna)') like d.esperado || '%'
            then '✅ ' || d.esperado
            else '⚠️ revisa: se esperaba ' || d.esperado || ' y hay '
                 || coalesce((
                      select coalesce(column_default, '(ninguno)')
                        from information_schema.columns
                       where table_schema = 'public' and table_name = 'clientes'
                         and column_name = d.col
                    ), '(sin columna)') end
  from (values
    ('reporte_ocupacion_activo',      'false'),
    ('reporte_ocupacion_sugerencias', 'true')
  ) as d(col, esperado)

union all

-- ── reportes-01: la bitácora y su candado ───────────────────────────────────
select '01 · tabla reporte_ocupacion_envios',
       case when exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'reporte_ocupacion_envios'
       ) then '✅ existe'
         else '❌ FALTA — corre supabase/reportes-01-ocupacion-semanal.sql' end

union all

-- El índice único es lo que impide que un reintento del cron mande el mismo correo
-- dos veces. La tabla puede existir sin él, así que se revisa aparte.
select '01 · candado anti-correo-doble (uq_reporte_ocupacion_envio)',
       case when exists (
         select 1 from pg_indexes
          where schemaname = 'public' and indexname = 'uq_reporte_ocupacion_envio'
       ) then '✅ existe'
         else '❌ FALTA — corre supabase/reportes-01-ocupacion-semanal.sql' end

union all

select '01 · RLS activo en reporte_ocupacion_envios',
       case when coalesce((
         select c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'reporte_ocupacion_envios'
       ), false) then '✅ activo'
         else '❌ FALTA — corre supabase/reportes-01-ocupacion-semanal.sql' end

union all

-- ── reportes-02: cada cuánto se manda y cuánto abarca ───────────────────────
--
-- ACCESORIO: sin él el módulo corre con su comportamiento original (sábados,
-- últimos 7 días) y no se rompe nada. Por eso su aviso es ⚠️ y no ❌.
select '02 · clientes.' || c,
       case when exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'clientes' and column_name = c
       ) then '✅ existe'
         else '⚠️ falta (opcional) — sin esto va sábados + últimos 7 días · '
              || 'corre supabase/reportes-02-cadencia.sql' end
  from unnest(array[
    'reporte_ocupacion_frecuencia',
    'reporte_ocupacion_ventana'
  ]) as c

union all

-- Los CHECK son lo que impide que entre a la columna un valor que la pantalla no
-- sabe pintar (el código normaliza lo desconocido al defecto, pero el desplegable
-- saldría vacío sin que nada fallara).
select '02 · CHECK ' || k,
       case when exists (select 1 from pg_constraint where conname = k)
            then '✅ existe'
            else '⚠️ falta (opcional) — corre supabase/reportes-02-cadencia.sql' end
  from unnest(array[
    'clientes_reporte_ocupacion_frecuencia_check',
    'clientes_reporte_ocupacion_ventana_check'
  ]) as k

union all

-- ── reportes-03: la copia interna de AFA ────────────────────────────────────
--
-- ACCESORIO, y de los más inofensivos: sin la tabla la copia SIGUE saliendo
-- exactamente igual (a la variable REPORTE_OCUPACION_CORREOS y, si no, al correo
-- de la empresa). Lo único que falta es poder encenderla, apagarla y cambiarle el
-- destinatario desde /reportes. Por eso su aviso es ⚠️ y no ❌.
select '03 · tabla reporte_ocupacion_config',
       case when exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'reporte_ocupacion_config'
       ) then '✅ existe'
         else '⚠️ falta (opcional) — la copia sale igual, pero no se puede '
              || 'gobernar · corre supabase/reportes-03-copia-interna.sql' end

union all

-- El default TIENE que ser true, y es lo contrario del de `reporte_ocupacion_activo`:
-- aquel manda un correo a un TERCERO que no lo pidió, éste no sale de la empresa.
-- Con false, correr el SQL le apagaría la copia a operaciones sin que nadie lo diga.
select '03 · default de copia_afa_activa',
       case when coalesce((
              select column_default from information_schema.columns
               where table_schema = 'public' and table_name = 'reporte_ocupacion_config'
                 and column_name = 'copia_afa_activa'
            ), '(sin columna)') like 'true%'
            then '✅ true'
            else '⚠️ revisa: se esperaba true y hay '
                 || coalesce((
                      select coalesce(column_default, '(ninguno)')
                        from information_schema.columns
                       where table_schema = 'public' and table_name = 'reporte_ocupacion_config'
                         and column_name = 'copia_afa_activa'
                    ), '(sin columna)') end

union all

-- Sin política permisiva a propósito: la fila se lee y se escribe SOLO por
-- /api/reportes/copia-interna con service-role, porque uno de los tres escalones
-- de la cascada es una variable de entorno que la pantalla no puede ver. Una
-- política acá sería una segunda puerta que puede contestar distinto.
select '03 · RLS activo y SIN política permisiva',
       case
         when not exists (select 1 from information_schema.tables
                           where table_schema = 'public' and table_name = 'reporte_ocupacion_config')
           then '⚠️ (sin tabla todavía)'
         when not coalesce((
                select c.relrowsecurity from pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'reporte_ocupacion_config'
              ), false)
           then '❌ RLS APAGADO — corre supabase/reportes-03-copia-interna.sql'
         when exists (select 1 from pg_policies
                       where schemaname = 'public' and tablename = 'reporte_ocupacion_config')
           then '⚠️ hay una política: alguien la agregó a mano, el SQL no crea ninguna'
         else '✅ como debe'
       end

order by 1;


-- ══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — SOLO cuando todo lo de arriba salga ✅
--
-- Correr el SQL NO enciende el reporte de nadie: `reporte_ocupacion_activo` nace
-- en false y se enciende cliente por cliente en /clientes → editar. Estas dos
-- filas contestan esa otra mitad. Quita los guiones y pégalas aparte.
-- ══════════════════════════════════════════════════════════════════════════════

-- select 'Clientes con el reporte ENCENDIDO' as revisar,
--        count(*)::text || ' cliente(s)'
--          || case when count(*) = 0
--                  then ' — el cron corre y no manda nada · enciéndelo en /clientes → editar'
--             else '' end as estado
--   from public.clientes where reporte_ocupacion_activo
-- union all
-- select 'Reportes ya enviados',
--        count(*)::text || ' envío(s) exitoso(s)'
--          || coalesce(' · último periodo cerrado el ' || max(periodo_fin)::text, '')
--   from public.reporte_ocupacion_envios where error is null;
