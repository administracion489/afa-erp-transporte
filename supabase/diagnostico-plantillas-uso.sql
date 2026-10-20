-- ══ diagnostico-plantillas-uso.sql · SOLO LEE · a cualquier hora (segundos) ══════════════════════════════════════════
-- ¿Qué dicen hoy las plantillas PDF, qué imprime cada cotización y qué traspasaría cotizaciones-05-plantillas-uso.sql?
-- Córrelo ANTES y DESPUÉS de esa migración. SQL Editor: pega el archivo ENTERO y Run: sale UNA tabla (el editor enseña
-- solo la última sentencia). Termina con «-- FIN»; «syntax error at end of input» = se cortó al copiar.
-- Funciona aunque falten migraciones: cada pregunta corre por separado y, si su tabla o columna no existe, responde
-- «NO SE PUDO: …». Las columnas se leen con to_jsonb(fila): si faltan salen «—», no rompen. No escribe datos: la
-- función es TEMPORAL (pg_temp, muere con la sesión), como en diagnostico-traslados-ia.sql.
set local statement_timeout = '30s';
create or replace function pg_temp.filas_de(q text) returns setof text language plpgsql as $f$
  begin return query execute q; exception when others then return next 'NO SE PUDO: ' || sqlerrm; end $f$;
with p(o, pregunta, q, como) as (values
  (1, 'Requisitos y migraciones', $q$
    select s || ': ' || case when ok then 'sí' else 'FALTA' end from (values
      (1, 'traslados-01 · fn_puede_modulo y fn_traslados_updated_at', to_regprocedure('public.fn_puede_modulo(uuid,text)') is not null
            and to_regprocedure('public.fn_traslados_updated_at()') is not null),
      (2, 'seguridad-04 · las plantillas solo las escribe el módulo Cotizaciones', exists (select 1 from pg_policies
            where schemaname = 'public' and tablename = 'cotizacion_plantillas' and policyname = 'cotizacion_plantillas_insert')),
      (3, 'traslados-07 · incluye / no_incluye en traslados_config', exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'traslados_config' and column_name = 'no_incluye')),
      (4, 'cotizaciones-05 · columna diseno', exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = 'cotizacion_plantillas' and column_name = 'diseno')),
      (5, 'cotizaciones-05 · tabla de reglas', to_regclass('public.cotizacion_plantilla_reglas') is not null)) v(k, s, ok) order by k $q$,
   'FALTA en 1 o 2 = cotizaciones-05 se detiene nombrando el archivo. FALTA en 4 y 5 = cotizaciones-05 aún no se corrió.'),
  (2, 'Columnas de cotizacion_plantillas', $q$
    select string_agg(column_name || ' ' || data_type || case when is_nullable = 'NO' then ' NOT NULL' else '' end, ', '
             order by ordinal_position) from information_schema.columns
     where table_schema = 'public' and table_name = 'cotizacion_plantillas'
    union all
    select 'clave primaria: ' || coalesce((select string_agg(a.attname, ', ') from pg_constraint c join pg_attribute a
             on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
            where c.conrelid = 'public.cotizacion_plantillas'::regclass and c.contype = 'p'), 'NINGUNA') $q$,
   'El traspaso copia `corporativo` con todas sus columnas. La tabla de reglas exige que id sea la clave primaria.'),
  (3, 'Plantillas', $q$
    select (j->>'id') || ' · ' || coalesce(j->>'nombre', '—') || ' · diseño ' || coalesce(j->>'diseno', '—')
           || ' · activa ' || coalesce(j->>'activa', '—') || ' · principal ' || coalesce(j->>'es_principal', '—')
           || ' · idioma ' || coalesce(j->>'idioma', '—') || ' · color ' || coalesce(j->>'color_primario', '—')
           || ' · título «' || coalesce(j->>'titulo_documento', '—') || '» · cierre «' || coalesce(j->>'mensaje_cierre', '—')
           || '» · bancos propios ' || coalesce(j->>'usar_bancos_propios', '—') || ' · muestra cuentas '
           || coalesce(j->>'mostrar_cuentas_bancarias', '—') || ' · generales/incluye/no incluye '
           || (select string_agg(case jsonb_typeof(j->k) when 'array' then jsonb_array_length(j->k)::text
                 when 'null' then 'NULL' else '—' end, '/' order by n)
                 from unnest(array['condiciones_generales', 'condiciones_incluye', 'condiciones_no_incluye']) with ordinality u(k, n))
      from (select to_jsonb(t) as j from public.cotizacion_plantillas t) x
     order by (j->>'orden')::numeric nulls last, j->>'id' $q$,
   'Listas: NULL = sin condiciones propias (imprime las de cada cotización); 0 = vacía (en español la plantilla gana y no '
   || 'imprime esa lista); — = la columna no existe. diseño «—» = falta cotizaciones-05.'),
  (4, 'Cotizaciones por plantilla_pdf', $q$
    with c as (select coalesce(j->>'plantilla_pdf', 'corporativo') as pid, j->>'plantilla_pdf' is null as sin_pid,
                      j->'consideraciones_json' as cj, coalesce(j->>'idioma_pdf', 'es') = 'en' as en,
                      jsonb_typeof(j->'traslado_json') = 'object' as ia
                 from (select to_jsonb(t) as j from public.cotizaciones t) x)
    select c.pid || ': ' || count(*) || ' (' || count(*) filter (where sin_pid) || ' sin plantilla_pdf · '
           || count(*) filter (where ia) || ' traslados de la IA · ' || count(*) filter (where en) || ' en inglés · '
           || count(*) filter (where jsonb_typeof(cj) is distinct from 'object') || ' sin consideraciones_json · '
           || count(*) filter (where jsonb_typeof(cj) = 'object' and cj ? 'version') || ' fijadas en versión 2) · '
           || case when p.j is null then 'la plantilla NO EXISTE' else count(*) filter (where not ia and not en
                and jsonb_typeof(cj) = 'object' and not cj ? 'version' and exists (select 1 from unnest(
                  array['condiciones_incluye', 'condiciones_no_incluye', 'condiciones_generales'],
                  array['incluye', 'no_incluye', 'generales']) u(kp, kc)
                 where jsonb_typeof(p.j->kp) = 'array' and cj ? kc and cj->kc is distinct from p.j->kp))
                || ' con condiciones propias distintas de las de su plantilla (hoy NO se imprimen)' end
      from c left join (select to_jsonb(t) as j from public.cotizacion_plantillas t) p on p.j->>'id' = c.pid
     group by c.pid, p.j order by count(*) desc, c.pid $q$,
   'Sin plantilla_pdf se cuenta como corporativo (la que el modal preselecciona). En español una lista NO NULL de la '
   || 'plantilla gana sobre la de la cotización; los traslados de la IA y el inglés imprimen las de la fila.'),
  (5, 'traslados_config (lo que traspasa cotizaciones-05)', $q$
    select key || ': ' || value from jsonb_each_text((select to_jsonb(t) from public.traslados_config t order by t.id limit 1))
     order by key $q$,
   'consideraciones → generales de «Traslados (IA)» (traslados_ia); incluye / no_incluye → sus listas. consideraciones_usd '
   || 'con algo → además «Traslados (IA) · dólares» (traslados_ia_usd), con generales = consideraciones + consideraciones_usd.'),
  (6, 'Ids que no cumplen ^[a-z0-9_]{3,40}$', $q$
    select coalesce(string_agg(id::text, ', ' order by id::text), 'ninguno') from public.cotizacion_plantillas
     where id::text !~ '^[a-z0-9_]{3,40}$' $q$,
   'ninguno = cotizaciones-05 pone el CHECK del formato del id. Si hay alguno, no lo pone (lo dice su comprobación).'),
  (7, 'Reglas de uso (cotizaciones-05)', $q$
    select r.servicio || ' × ' || r.segmento || ' → ' || r.plantilla_id || coalesce(' (' || (to_jsonb(t)->>'nombre') || ' · diseño '
           || coalesce(to_jsonb(t)->>'diseno', '—') || ' · activa ' || coalesce(to_jsonb(t)->>'activa', '—') || ')', ' (NO EXISTE)')
      from public.cotizacion_plantilla_reglas r left join public.cotizacion_plantillas t on t.id = r.plantilla_id
     order by array_position(array['traslado_ia', 'eventual', 'turismo', 'fijo'], r.servicio),
              array_position(array['empresa', 'particular', 'extranjero'], r.segmento) $q$,
   'NO SE PUDO = aún no se corrió cotizaciones-05. Una celda que no sale usa la plantilla principal.'))
select p.o || coalesce('.' || r.k, '') as "#", p.pregunta, coalesce(r.t, '— ninguna fila') as respuesta, p.como as "cómo se lee"
  from p left join lateral pg_temp.filas_de(p.q) with ordinality r(t, k) on true
 order by p.o, r.k;
-- FIN de diagnostico-plantillas-uso.sql
