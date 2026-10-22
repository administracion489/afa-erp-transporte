-- ══ diagnostico-reserva-traslado.sql · SOLO LEE · a cualquier hora (segundos) ════════════════════════════════════════
-- ¿Está lista la base para que la IA del CRM reserve traslados y pida el adelanto? Córrelo ANTES y DESPUÉS de reservas-09a/b/c,
-- cotizaciones-06, traslados-09 y alertas-reserva-traslado. SQL Editor: pega el archivo ENTERO y Run: sale UNA tabla. Si falta
-- una tabla o columna, esa pregunta dice «NO SE PUDO: …». No escribe datos: la función es TEMPORAL (pg_temp).
set local statement_timeout = '30s';
create or replace function pg_temp.filas_de(q text) returns setof text language plpgsql as $f$
  begin return query execute q; exception when others then return next 'NO SE PUDO: ' || sqlerrm; end $f$;
with p(o, pregunta, q, como) as (values
  (1, 'Migraciones y configuración', $q$
    select s || ': ' || case when ok then 'sí' else 'FALTA' end from (values
      (1, 'reservas-09a · reserva_solicitudes', to_regclass('public.reserva_solicitudes') is not null),
      (2, 'reservas-09b · reserva_solicitud_comprobantes', to_regclass('public.reserva_solicitud_comprobantes') is not null),
      (3, 'reservas-09c · pagos.reserva_solicitud_id', exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'pagos' and column_name = 'reserva_solicitud_id')),
      (4, 'cotizaciones-06 · cotizacion_plantillas.condiciones_reserva', exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'cotizacion_plantillas' and column_name = 'condiciones_reserva')),
      (5, 'alertas-reserva-traslado · las dos filas', (select count(*) from public.alerta_config
            where clave in ('reserva_sin_confirmar', 'devolucion_pendiente')) = 2)) v(k, s, ok)
    union all select 'traslados_config · ' || key || ' = ' || coalesce(value, 'null')
      from jsonb_each_text((select to_jsonb(t) from public.traslados_config t order by t.id limit 1))
     where key like 'reserva\_%' or key in ('ia_cotiza', 'envio_automatico') $q$,
   'Sin reserva_* = falta traslados-09. reserva_ia false = la IA no ofrece reservar aunque todo lo demás exista.'),
  (2, 'Líneas de las plantillas de la IA', $q$
    select (j->>'id') || ' · ' || replace(k, 'condiciones_', '') || ' ' || n || ': «' || l || '»'
           || case when lower(translate(l, 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) ~ ('(https?://|www\.|[a-z0-9-]+\.(com|pe|net|org|io|ly|me|app'
                || '|info|link|co|xyz|site|online|store|shop|gl|gg|to|tk|click|top|biz)\M)') then '  ⚠ DOMINIO O ENLACE' else '' end
           || case when l ~ '[^[:space:]@]+@[^[:space:]@]+' then '  ⚠ CORREO' else '' end
           || case when regexp_replace(regexp_replace(l, '\m\d{4}-\d{1,2}-\d{1,2}\M|\m\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\M'
                || '|\m\d{1,2}:\d{2}(:\d{2})?\M', ' ', 'g'), '[^0-9[:space:].-]', ' ', 'g') ~ '([0-9][[:space:].-]?){5}[0-9]'
                then '  ⚠ NÚMERO DE 6+ DÍGITOS' else '' end
      from (select to_jsonb(t) as j from public.cotizacion_plantillas t where t.id in ('traslados_ia', 'traslados_ia_usd')) x
     cross join unnest(array['condiciones_generales', 'condiciones_incluye', 'condiciones_no_incluye', 'condiciones_reserva']) k
     cross join lateral jsonb_array_elements_text(case when jsonb_typeof(j->k) = 'array' then j->k else '[]' end)
           with ordinality e(l, n)
     order by j->>'id', k, n $q$,
   'Una línea con ⚠ deja en REVISIÓN toda cotización de la IA (condicionesSospechosas) o la política que se envía: quítale '
   || 'el teléfono, el correo o el dominio (la línea de contacto la arma el código). Sin filas de «reserva» = sin política.'),
  (3, 'Cuentas que imprime cada plantilla, por moneda', $q$
    with e as (select coalesce((select ep.cuentas_bancarias from public.empresa_perfil ep order by ep.id limit 1), '[]') as cs)
    select (j->>'id') || ' · ' || case when j->>'mostrar_cuentas_bancarias' = 'false' then 'NO IMPRIME CUENTAS'
             else 'de ' || f end || coalesce(' · ' || (c->>'banco') || ' · cta ' || coalesce(nullif(c->>'cuenta', ''), '—')
             || ' · CCI ' || coalesce(nullif(c->>'cci', ''), '—') || ' · ' || case upper(coalesce(c->>'moneda', ''))
               when 'PEN' then 'solo SOLES' when 'USD' then 'solo DÓLARES' else 'sin moneda: sale en las dos' || case when lower(c->>'banco')
               ~ '(d[oó]lar|usd|us\$|\msol(es)?\M|\mpen\M)' then '  ⚠ el nombre dice la moneda: declárala en el perfil' else '' end end, '')
      from (select to_jsonb(t) as j from public.cotizacion_plantillas t where t.id in ('traslados_ia', 'traslados_ia_usd')) x
     cross join e cross join lateral (select case when coalesce(j->>'usar_bancos_propios', 'false') <> 'true'
             and jsonb_typeof(e.cs) = 'array' and jsonb_array_length(e.cs) > 0 then 'empresa_perfil' else 'la plantilla' end f) s
     left join lateral jsonb_array_elements(case when s.f = 'empresa_perfil' then e.cs else jsonb_build_array(
             jsonb_build_object('banco', j->>'banco_1_nombre', 'cuenta', j->>'banco_1_cuenta', 'cci', j->>'banco_1_cci'),
             jsonb_build_object('banco', j->>'banco_2_nombre', 'cuenta', j->>'banco_2_cuenta', 'cci', j->>'banco_2_cci'),
             jsonb_build_object('banco', j->>'banco_3_nombre', 'cuenta', j->>'banco_3_cuenta', 'cci', j->>'banco_3_cci')) end) c
       on coalesce(c->>'banco', '') <> '' and (coalesce(c->>'cuenta', '') <> '' or coalesce(c->>'cci', '') <> '')
     order by 1 $q$,
   'La IA pide el adelanto a estas mismas cuentas (las del PDF). En soles valen las «solo SOLES» y las «sin moneda»; en '
   || 'dólares, las «solo DÓLARES» y las «sin moneda». Ninguna en la moneda de la cotización = `sin_cuentas`: no pide pago.'),
  (4, 'Horario de atención del equipo (comportamiento->atencion_*)', $q$
    select a.nombre || case when a.activo then ' (activo)' else ' (inactivo)' end || ' · ' || k.key || ' = ' || k.value::text
      from public.crm_agentes_ia a cross join lateral jsonb_each(case when jsonb_typeof(a.comportamiento) = 'object'
           then a.comportamiento else '{}' end) k where k.key like 'atencion%'
    union all select a.nombre || ' · horario de la IA (no es el del equipo): ' || coalesce(a.hora_inicio, '—') || '–' || coalesce(a.hora_fin, '—') || ' · horario_activo = ' || coalesce(a.horario_activo::text, '—') from public.crm_agentes_ia a $q$,
   'Sin atencion_activa = true (con días y horas válidos) la IA nunca pide el pago primero: `sin_horario_equipo` → confirma '
   || 'disponibilidad. P y M (traslados_config) se cuentan sobre ESTE horario.'),
  (5, 'Frases de pago en las instrucciones del agente', $q$
    select a.nombre || ' · ' || c.campo || ': «…' || regexp_replace(m[1], '\s+', ' ', 'g') || '…»'
      from public.crm_agentes_ia a
     cross join lateral (values ('persona', a.persona), ('empresa_contexto', a.empresa_contexto), ('conocimiento', a.conocimiento)) c(campo, txt)
     cross join lateral regexp_matches(coalesce(c.txt, ''), '(.{0,60}(deposit|cuenta|pago).{0,60})', 'gi') m
     where c.txt ilike '%deposit%' or c.txt ilike '%cuenta%' or c.txt ilike '%pago%' limit 60 $q$,
   'Una instrucción del dueño que pide un depósito, da una cuenta o promete «pago confirmado» choca con el flujo nuevo (el '
   || 'monto y las cuentas los arma el código; confirma una persona): el auditor de /crm/agente la nombrará.'),
  (6, 'Reservas que la IA propuso después de enviar una cotización de traslado (mismo hilo)', $q$
    select left(r.conversacion_id::text, 8) || ' · cotización ' || coalesce(c.numero_cotizacion, ct.payload->>'numero', '—')
           || ' enviada ' || to_char(ct.creada_at at time zone 'America/Lima', 'DD/MM HH24:MI') || ' → reserva '
           || to_char(r.creada_at at time zone 'America/Lima', 'DD/MM HH24:MI') || ' (' || coalesce(r.estado, '—') || ', '
           || round(extract(epoch from r.creada_at - ct.creada_at) / 60) || ' min después) · servicio '
           || coalesce(c.fecha_servicio::text || ' ' || coalesce(c.hora_ida, ''), (r.payload->>'fecha_servicio') || ' '
           || coalesce(r.payload->>'hora_servicio', ''), '—') || ' · anticipación '
           || coalesce(round(extract(epoch from s.inicio - r.creada_at) / 3600.0, 1)::text || ' h', 'sin dato')
      from public.crm_acciones_ia r
     cross join lateral (select * from public.crm_acciones_ia ct where ct.tipo = 'cotizacion_traslado'
             and ct.conversacion_id = r.conversacion_id and ct.creada_at < r.creada_at order by ct.creada_at desc limit 1) ct
      left join public.cotizaciones c on c.id = case when ct.payload->>'cotizacion_id' ~ '^[0-9]{1,18}$'
             then (ct.payload->>'cotizacion_id')::bigint end
     cross join lateral (select case when c.fecha_servicio is not null and coalesce(c.hora_ida, '') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
             then (c.fecha_servicio + substring(c.hora_ida from '^[0-9]{1,2}:[0-9]{2}')::time) at time zone 'America/Lima' end inicio) s
     where r.tipo = 'reserva' order by r.creada_at desc $q$,
   'Es lo que hoy hace proponer_reserva. Con pocas horas de anticipación, P + M (traslados_config) decide si se pide el pago '
   || 'o se confirma disponibilidad primero, o se deriva (si ningún humano alcanza antes del servicio).'),
  (7, 'Pagos con reserva_id, por sentido', $q$
    select p.sentido || ' · ' || p.moneda || case when p.anulado then ' · ANULADOS' else ' · vigentes' end || ': ' || count(*)
           || ' por ' || to_char(sum(p.monto), 'FM999G999G990D00') || ' · con solicitud de reserva: '
           || count(*) filter (where to_jsonb(p)->>'reserva_solicitud_id' is not null)
      from public.pagos p where p.reserva_id is not null group by p.sentido, p.moneda, p.anulado order by 1 $q$,
   'Hoy solo debería haber «cobro» (los adelantos de la Confirmación de Reserva). Un «pago» con reserva_id sumaba como adelanto '
   || 'en la Confirmación: el código nuevo filtra sentido = cobro.'))
select p.o || coalesce('.' || r.k, '') as "#", p.pregunta, coalesce(r.t, '— ninguna fila') as respuesta, p.como as "cómo se lee"
  from p left join lateral pg_temp.filas_de(p.q) with ordinality r(t, k) on true
 order by p.o, r.k;
-- FIN de diagnostico-reserva-traslado.sql
