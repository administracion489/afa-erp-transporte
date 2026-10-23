-- ══ diagnostico-idioma-traslados.sql · SOLO LEE · a cualquier hora (segundos) ════════════════════════════════════════
-- ¿Qué plantilla PDF usa hoy el traslado de la IA, hay plantillas en inglés que pueda usar, y en qué idioma y moneda
-- salieron sus cotizaciones? Córrelo ANTES y DESPUÉS de cotizaciones-09-reglas-traslado-idioma.sql y
-- traslados-10-descripcion-ingles.sql (y del opcional SOLO AFA traslados-11). SQL Editor: pega el archivo ENTERO y Run:
-- sale UNA tabla. Si falta una tabla o columna, esa pregunta dice «NO SE PUDO: …». No escribe datos: la función es
-- TEMPORAL (pg_temp, muere con la sesión). Cuántos clientes escriben en inglés lo mide scripts/diagnostico-idioma-traslados.mts.
set local statement_timeout = '30s';
create or replace function pg_temp.filas_de(q text) returns setof text language plpgsql as $f$
  begin return query execute q; exception when others then return next 'NO SE PUDO: ' || sqlerrm; end $f$;
with p(o, pregunta, q, como) as (values
  (1, 'Migraciones', $q$
    select s || ': ' || case when ok then 'sí' else 'FALTA' end from (values
      (1, 'cotizaciones-04 · cotizaciones.idioma_pdf', exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'cotizaciones' and column_name = 'idioma_pdf')),
      (2, 'cotizaciones-05 · reglas servicio × segmento', to_regclass('public.cotizacion_plantilla_reglas') is not null),
      (3, 'cotizaciones-09 · reglas del traslado idioma × moneda', to_regclass('public.cotizacion_plantilla_reglas_traslado') is not null),
      (4, 'traslados-10 · traslado_categorias.descripcion_cliente_en', exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'traslado_categorias' and column_name = 'descripcion_cliente_en')),
      (5, 'traslados-11 (SOLO AFA) · borradores en inglés', (select count(*) from public.cotizacion_plantillas
            where id in ('traslados_ia_en', 'traslados_ia_en_usd')) = 2)) v(k, s, ok) order by k $q$,
   'FALTA en 3 = el inglés no se puede encender (la IA cotiza en castellano, como hoy). 5 es opcional.'),
  (2, 'Reglas viejas del traslado de la IA (cotizaciones-05)', $q$
    select r.segmento || ' → ' || r.plantilla_id || coalesce(' (' || (to_jsonb(t)->>'nombre') || ' · idioma '
           || coalesce(to_jsonb(t)->>'idioma', '—') || ' · diseño ' || coalesce(to_jsonb(t)->>'diseno', '—') || ' · activa '
           || coalesce(to_jsonb(t)->>'activa', '—') || ')', ' (NO EXISTE)')
      from public.cotizacion_plantilla_reglas r left join public.cotizacion_plantillas t on t.id = r.plantilla_id
     where r.servicio = 'traslado_ia'
     order by array_position(array['empresa', 'particular', 'extranjero'], r.segmento) $q$,
   'Las usa el código sin cotizaciones-09. Con ella quedan OBSOLETAS: el traspaso copia particular (o empresa) a castellano · '
   || 'soles y extranjero a castellano · dólares.'),
  (3, 'Celdas del traslado de la IA: idioma × moneda (cotizaciones-09)', $q$
    select c.i || ' · ' || c.m || ' → ' || coalesce(r.plantilla_id || coalesce(' (' || (to_jsonb(t)->>'nombre') || ' · idioma '
           || coalesce(to_jsonb(t)->>'idioma', '—') || ' · diseño ' || coalesce(to_jsonb(t)->>'diseno', '—') || ' · activa '
           || coalesce(to_jsonb(t)->>'activa', '—') || ')', ' (NO EXISTE)'), 'vacía')
      from (values (1, 'es', 'PEN'), (2, 'es', 'USD'), (3, 'en', 'PEN'), (4, 'en', 'USD')) c(o, i, m)
      left join public.cotizacion_plantilla_reglas_traslado r on r.idioma = c.i and r.moneda = c.m
      left join public.cotizacion_plantillas t on t.id = r.plantilla_id
     order by c.o $q$,
   'en vacía (o con una plantilla que no está en inglés, activa y corporativa) = inglés APAGADO en esa moneda. es vacía = '
   || 'la principal. NO SE PUDO = falta cotizaciones-09.'),
  (4, 'Plantillas', $q$
    select (j->>'id') || ' · ' || coalesce(j->>'nombre', '—') || ' · idioma ' || coalesce(j->>'idioma', 'NULL') || ' · diseño '
           || coalesce(j->>'diseno', '—') || ' · activa ' || coalesce(j->>'activa', 'NULL') || ' · principal '
           || coalesce(j->>'es_principal', 'NULL') || ' · ' || case when coalesce(j->>'activa', 'true') <> 'false'
             and coalesce(j->>'diseno', j->>'id') = 'corporativo' then 'la IA puede usarla en '
             || case when lower(trim(coalesce(j->>'idioma', ''))) = 'en' then 'INGLÉS' else 'castellano' end
             else 'la IA no puede usarla' end
      from (select to_jsonb(t) as j from public.cotizacion_plantillas t) x
     order by (j->>'orden')::numeric nulls last, j->>'id' $q$,
   'Solo cuenta como inglés el idioma «en» exacto (lib/cotizacion-idioma.ts, normalizarIdioma): «es_en» es castellano. '
   || 'La IA solo dibuja el diseño corporativo, y nunca una plantilla inactiva.'),
  (5, 'Cotizaciones de traslado de la IA, últimos 90 días: moneda × número del contacto × idioma del PDF', $q$
    with c as (select j, k.wa_id, regexp_replace(coalesce(k.wa_id, ''), '\D', '', 'g') as d, v.id as conv
                 from (select to_jsonb(t) as j from public.cotizaciones t where t.created_at >= now() - interval '90 days') x
                 left join public.crm_conversaciones v on v.id::text = j->>'crm_conversacion_id'
                 left join public.crm_contactos k on k.id = v.contacto_id
                where jsonb_typeof(j->'traslado_json') = 'object')
    select g || ': ' || count(*) from (select coalesce(j->>'moneda', '—') || ' · ' || case when wa_id ~* '^PE\.'
             or d ~ '^51[0-9]{9}$' or d ~ '^9[0-9]{8}$' then '+51' when wa_id ~ '^[A-Za-z]{2}\.' or (length(d) >= 8
             and d !~ '^51') then 'otro país' when conv is null then 'sin conversación' else 'sin número válido' end
           || ' · idioma_pdf ' || coalesce(j->>'idioma_pdf', '—') as g from c) y group by g order by g $q$,
   'El número es el wa_id del contacto (la misma regla que monedaPorTelefono). Sin el inglés todo sale «idioma_pdf es». '
   || 'Con el inglés encendido, un +51 que escribe en inglés sale USD · +51 · en.'),
  (6, 'Categorías de traslado: descripción para el cliente', $q$
    select coalesce(j->>'clave', '—') || ' · castellano ' || case when coalesce(j->>'descripcion_cliente', '') <> ''
             then 'sí' else 'no (frase del sistema)' end || ' · inglés ' || case when not (j ? 'descripcion_cliente_en')
             then '— (falta traslados-10)' when coalesce(j->>'descripcion_cliente_en', '') <> '' then 'sí'
             else 'no (frase del sistema en inglés)' end
      from (select to_jsonb(t) as j from public.traslado_categorias t) x order by (j->>'orden')::numeric, j->>'clave' $q$,
   'En inglés nunca se imprime la descripción en castellano: sin la de inglés va la frase con capacidad y bodega.'))
select p.o || coalesce('.' || r.k, '') as "#", p.pregunta, coalesce(r.t, '— ninguna fila') as respuesta, p.como as "cómo se lee"
  from p left join lateral pg_temp.filas_de(p.q) with ordinality r(t, k) on true
 order by p.o, r.k;
-- FIN de diagnostico-idioma-traslados.sql
