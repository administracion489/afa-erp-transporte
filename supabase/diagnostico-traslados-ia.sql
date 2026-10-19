-- ══ diagnostico-traslados-ia.sql · SOLO LEE · a cualquier hora (segundos) ══════════════════════════════
-- ¿Está listo lo que necesita la IA del CRM para cotizar traslados y enviar el PDF (traslados-05)?
-- SQL Editor: pega el archivo ENTERO y Run: sale UNA tabla (el editor enseña solo la última sentencia).
-- Termina con «-- FIN»; «syntax error at end of input» = se cortó al copiar.
-- Funciona aunque falten las migraciones: cada pregunta corre por separado y, si su tabla o columna no
-- existe, responde «NO SE PUDO: …» y la columna «cómo se lee» dice qué archivo correr. Las columnas
-- opcionales se leen con to_jsonb(fila): si faltan salen vacías, no rompen. No escribe datos: la función
-- es TEMPORAL (pg_temp, muere con la sesión), como en diagnostico-monitoreo-flota.sql.
set local statement_timeout = '30s';
create or replace function pg_temp.filas_de(q text) returns setof text language plpgsql as $f$
  begin return query execute q; exception when others then return next 'NO SE PUDO: ' || sqlerrm; end $f$;
with p(o, pregunta, q, como) as (values
  (1, 'Migraciones', $q$
    with c5 as (select count(*) as n from information_schema.columns where table_schema = 'public'
      and (table_name, column_name) in (('traslados_config', 'ia_cotiza'), ('traslados_config', 'envio_automatico'),
        ('zonas_traslado', 'envio_automatico'), ('cotizaciones', 'crm_conversacion_id'), ('cotizaciones', 'traslado_json')))
    select s || ': ' || case when ok then 'sí' else 'FALTA' end from (values
      (1, 'traslados-01 · tablas', to_regclass('public.traslados_config') is not null),
      (2, 'traslados-04 · TC e IGV solo servidor', exists (select 1 from pg_policies where schemaname = 'public'
            and tablename = 'tipo_cambio' and policyname = 'tipo_cambio_leer')),
      (3, 'cotizaciones-04 · moneda y TC', exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = 'cotizaciones' and column_name = 'tipo_cambio')),
      (4, 'crm-ia-pausa-humano', exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = 'crm_agentes_ia' and column_name = 'pausa_humano_horas')),
      (5, 'traslados-05 · ' || (select n from c5) || ' de 5 columnas', (select n from c5) = 5)) v(k, s, ok) order by k $q$,
   'Orden: 01 → 02 → 03 (solo AFA) → 04, cotizaciones-04 → traslados-05. Los datos de 02 y 03 se ven en 4 y 6.'),
  (2, 'crm_acciones_ia · columnas', $q$
    select string_agg(column_name, ', ' order by ordinal_position) from information_schema.columns
     where table_schema = 'public' and table_name = 'crm_acciones_ia' $q$,
   'La fecha es creada_at (no created_at): ordenar por created_at deja el inbox sin acciones. Vacío = falta crm-agente-ia.'),
  (3, 'Agente IA del CRM', $q$
    select jsonb_build_object('nombre', j->'nombre', 'activo', j->'activo', 'modelo', j->'modelo', 'canales', j->'canales',
             'canales_autonomos', j->'canales_autonomos', 'horario_activo', j->'horario_activo', 'hora_inicio', j->'hora_inicio',
             'hora_fin', j->'hora_fin', 'pausa_humano_horas', j->'pausa_humano_horas', 'max_turnos_auto', j->'max_turnos_auto',
             'pausar_si_responde_humano', j->'pausar_si_responde_humano')::text
      from (select to_jsonb(a) as j from public.crm_agentes_ia a) x order by j->>'created_at' $q$,
   'Envía solo con activo y "whatsapp" en canales_autonomos (solo en canales = copiloto: todo a revisión). Con horario_activo '
   || 'true no responde fuera de hora; si un humano respondió, se aparta pausa_humano_horas. max_turnos_auto 0 = sin límite.'),
  (4, 'Zona del aeropuerto (tipo punto)', $q$
    select jsonb_build_object('nombre', j->'nombre', 'radio_m', j->'radio_m', 'activo', j->'activo',
             'envio_automatico', coalesce(j->'envio_automatico', '"sin traslados-05"'), 'lat', j->'lat', 'lng', j->'lng')::text
      from (select to_jsonb(z) as j from public.zonas_traslado z where z.tipo = 'punto' order by z.orden, z.id) x $q$,
   'Ninguna fila = falta traslados-02. NO SE PUDO = falta traslados-01. Radio sembrado: 2000 m.'),
  (5, 'Zonas con envío automático', $q$
    select coalesce(string_agg(z.nombre || ' (' || z.tipo || ')', ', ' order by z.orden), 'ninguna')
      from public.zonas_traslado z where to_jsonb(z)->>'envio_automatico' = 'true' $q$,
   'Debe ser SOLO el aeropuerto (decisión del dueño, 19-10-2026). Una subzona hereda la de su distrito.'),
  (6, 'Precios del aeropuerto (activos)', $q$
    select count(*) filter (where t.moneda = 'PEN') || ' en soles · ' || count(*) filter (where t.moneda = 'USD')
           || ' en dólares · ' || count(distinct t.categoria) || ' categorías'
      from public.tarifas_traslado t join public.zonas_traslado z on z.id in (t.zona_a_id, t.zona_b_id)
     where z.tipo = 'punto' and t.activo $q$,
   '0 = falta traslados-03 (solo AFA): sin precio todo va a un ejecutivo. AFA sembró 21 + 21.'),
  (7, 'traslados_config', $q$
    select (j - 'consideraciones' - 'consideraciones_usd')::text || ' · consideraciones '
           || jsonb_array_length(coalesce(j->'consideraciones', '[]')) || ' + '
           || jsonb_array_length(coalesce(j->'consideraciones_usd', '[]')) || ' (dólares)'
      from (select to_jsonb(c) as j from public.traslados_config c) x $q$,
   'Sin ia_cotiza ni envio_automatico en el texto = falta traslados-05. false = la IA no cotiza / todo va a revisión.'),
  (8, 'Último tipo de cambio USD', $q$
    select fecha || ' · venta ' || venta || ' · compra ' || compra || ' · ' || coalesce(fuente, '?') || ' · hace '
           || ((now() at time zone 'America/Lima')::date - fecha) || ' día(s)'
      from public.tipo_cambio where moneda = 'USD' order by fecha desc limit 1 $q$,
   'Más de 7 días o ninguna fila = no cotiza en dólares (va a un ejecutivo). Lo llena el cron /api/tipo-cambio/sunat.'),
  (9, 'IGV (config_tributaria)', $q$ select igv_pct::text from public.config_tributaria $q$,
   'Debe ser 18: el PDF calcula con 18; si el motor usa otro, la cotización va a revisión (importes_no_cuadran).'),
  (10, 'Números de WhatsApp', $q$
    select coalesce(j->>'alias', '?') || ' · ' || coalesce(j->>'display_phone_number', '?') || ' · crm ' || coalesce(j->>'usa_crm', '?')
           || ' · avisos ' || coalesce(j->>'usa_avisos', '?') || ' · activo ' || coalesce(j->>'activo', '?')
           || ' · coexistencia ' || coalesce(j->>'es_coexistencia', '—')
      from (select to_jsonb(n) as j from public.whatsapp_numeros n) x
     order by (j->>'usa_crm')::boolean desc nulls last, j->>'alias' $q$,
   'Debe haber UNO con crm true y activo: el 51966707225. Ninguna fila = la app usa las variables de entorno.'),
  (11, 'Acciones cotizacion_traslado · 14 días', $q$
    select coalesce(estado, '(null)') || ' · decision ' || coalesce(payload->>'decision', '(sin decision)') || ': ' || count(*)
      from public.crm_acciones_ia a where tipo = 'cotizacion_traslado'
       and coalesce(to_jsonb(a)->>'creada_at', to_jsonb(a)->>'created_at')::timestamptz >= now() - interval '14 days'
     group by estado, payload->>'decision' order by 1 $q$,
   'Ninguna = la IA aún no cotizó. pendiente = espera a un ejecutivo; enviando por más de 5 min = envío trabado.'),
  (12, 'Cotizaciones creadas desde el CRM · 14 días', $q$
    select count(*) || ' · última ' || coalesce(max(created_at)::text, '—') from public.cotizaciones
     where crm_conversacion_id is not null and created_at >= now() - interval '14 days' $q$,
   'NO SE PUDO (columna crm_conversacion_id) = falta traslados-05.'))
select p.o || coalesce('.' || r.k, '') as "#", p.pregunta, coalesce(r.t, '— ninguna fila') as respuesta, p.como as "cómo se lee"
  from p left join lateral pg_temp.filas_de(p.q) with ordinality r(t, k) on true
 order by p.o, r.k;
-- FIN de diagnostico-traslados-ia.sql
