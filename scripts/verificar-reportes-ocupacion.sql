-- ¿SE CORRIERON LOS SQL DEL REPORTE DE OCUPACIÓN? — pégalo entero y dale Run.
--
-- SOLO LEE EL CATÁLOGO de Postgres (information_schema, pg_*), y eso no es un
-- detalle: una versión anterior terminaba contando clientes, y como Postgres
-- ANALIZA la consulta entera antes de ejecutarla, si faltaba la columna el
-- script moría sin mostrar NI UNA fila — se rompía en el único caso en que
-- hace falta. El conteo va al final, comentado, para pegarlo aparte.
--
-- Y VA COMPACTO A PROPÓSITO: la versión documentada pasaba de 180 líneas y al
-- pegarla en el editor de Supabase se cortaba a la mitad («syntax error at end
-- of input»). Un verificador que no se puede pegar de un tirón falla igual que
-- uno que revienta.

with c(n, que, tipo, t, x, archivo, opc) as (values
  ( 1,'clientes.reporte_ocupacion_activo',       'col'  ,'clientes','reporte_ocupacion_activo'          ,'reportes-01-ocupacion-semanal.sql',false),
  ( 2,'clientes.reporte_ocupacion_correos',      'col'  ,'clientes','reporte_ocupacion_correos'         ,'reportes-01-ocupacion-semanal.sql',false),
  ( 3,'clientes.reporte_ocupacion_sugerencias',  'col'  ,'clientes','reporte_ocupacion_sugerencias'     ,'reportes-01-ocupacion-semanal.sql',false),
  -- Los DEFAULTS son parte de la migración: `activo` TIENE que nacer en false,
  -- que es lo que impide que correr el SQL le empiece a mandar correos a todos.
  ( 4,'default activo = false',                  'def'  ,'clientes','reporte_ocupacion_activo|false'    ,'reportes-01-ocupacion-semanal.sql',false),
  ( 5,'default sugerencias = true',              'def'  ,'clientes','reporte_ocupacion_sugerencias|true','reportes-01-ocupacion-semanal.sql',false),
  ( 6,'tabla reporte_ocupacion_envios',          'tabla','reporte_ocupacion_envios',''                  ,'reportes-01-ocupacion-semanal.sql',false),
  ( 7,'candado anti-correo-doble',               'idx'  ,'','uq_reporte_ocupacion_envio'                ,'reportes-01-ocupacion-semanal.sql',false),
  ( 8,'RLS en reporte_ocupacion_envios',         'rls'  ,'reporte_ocupacion_envios',''                  ,'reportes-01-ocupacion-semanal.sql',false),
  -- ACCESORIO: sin la 02 el módulo corre con su comportamiento original
  -- (sábados, últimos 7 días). Por eso su aviso es ⚠️ y no ❌.
  ( 9,'clientes.reporte_ocupacion_frecuencia',   'col'  ,'clientes','reporte_ocupacion_frecuencia'      ,'reportes-02-cadencia.sql',true),
  (10,'clientes.reporte_ocupacion_ventana',      'col'  ,'clientes','reporte_ocupacion_ventana'         ,'reportes-02-cadencia.sql',true),
  (11,'CHECK de frecuencia',                     'chk'  ,'','clientes_reporte_ocupacion_frecuencia_check','reportes-02-cadencia.sql',true),
  (12,'CHECK de ventana',                        'chk'  ,'','clientes_reporte_ocupacion_ventana_check'  ,'reportes-02-cadencia.sql',true),
  -- ACCESORIO también: sin la 03 la copia interna de AFA sale exactamente
  -- igual que hasta ahora; lo único que falta es poder gobernarla desde
  -- /reportes. Su default es `true` justo por eso.
  (13,'tabla reporte_ocupacion_config',          'tabla','reporte_ocupacion_config',''                  ,'reportes-03-copia-interna.sql',true),
  (14,'default copia_afa_activa = true',         'def'  ,'reporte_ocupacion_config','copia_afa_activa|true','reportes-03-copia-interna.sql',true),
  (15,'RLS en reporte_ocupacion_config',         'rls'  ,'reporte_ocupacion_config',''                  ,'reportes-03-copia-interna.sql',true)
)
select c.que as revisar,
       case
         when v.ok then '✅'
         when c.tipo = 'def' then '⚠️ el default no es el esperado (o falta la columna) · supabase/' || c.archivo
         when c.opc then '⚠️ falta (opcional) · corre supabase/' || c.archivo
         else '❌ FALTA · corre supabase/' || c.archivo
       end as estado
  from c
  cross join lateral (select case c.tipo
    when 'col'   then exists (select 1 from information_schema.columns
                               where table_schema = 'public' and table_name::text = c.t and column_name::text = c.x)
    when 'tabla' then exists (select 1 from information_schema.tables
                               where table_schema = 'public' and table_name::text = c.t)
    when 'idx'   then exists (select 1 from pg_indexes
                               where schemaname = 'public' and indexname::text = c.x)
    when 'chk'   then exists (select 1 from pg_constraint where conname::text = c.x)
    when 'rls'   then coalesce((select k.relrowsecurity from pg_class k
                                  join pg_namespace ns on ns.oid = k.relnamespace
                                 where ns.nspname = 'public' and k.relname::text = c.t), false)
    when 'def'   then coalesce((select column_default from information_schema.columns
                                 where table_schema = 'public' and table_name::text = c.t
                                   and column_name::text = split_part(c.x, '|', 1)), '')
                     like split_part(c.x, '|', 2) || '%'
  end) as v(ok)
 order by c.n;


-- ══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — SOLO cuando todo lo de arriba salga ✅ (quita los guiones y pégala aparte)
--
-- Correr el SQL NO enciende el reporte de nadie: `reporte_ocupacion_activo` nace
-- en false y se enciende cliente por cliente en /clientes → editar.
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
