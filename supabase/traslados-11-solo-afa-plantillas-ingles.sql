-- traslados-11-solo-afa-plantillas-ingles.sql — ══ SOLO AFA ══ (otra instalación NO corre este archivo: sus condiciones
-- son las de AFA). PROPONE las dos plantillas EN INGLÉS del traslado de la IA, como BORRADOR:
--   · traslados_ia_en     «Traslados (IA) · inglés · BORRADOR»           (copia de traslados_ia: soles)
--   · traslados_ia_en_usd «Traslados (IA) · inglés · dólares · BORRADOR» (copia de traslados_ia_usd: dólares)
-- Copian TODAS las columnas de su original (diseño corporativo y las MISMAS cuentas) y cambian solo el idioma ('en') y
-- las cinco listas (generales, incluye, no incluye, política de reserva y su resumen), traducidas al inglés de las que
-- había en producción el 23-10-2026: mismos porcentajes, horas y plazos, ni una condición más ni una menos.
-- NACEN INACTIVAS y SIN REGLA: no encienden el inglés. Una persona las revisa en /cotizaciones/plantillas, las activa y
-- las asigna a «Traslado de la IA · inglés · soles / dólares» (cotizaciones-09). Sin teléfonos, correos, dominios ni
-- números de 6+ dígitos (dejarían en revisión toda cotización de la IA). Si el original cambió desde que se tradujo
-- (su huella no coincide), esa plantilla NO se crea y se avisa: hay que volver a traducir.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente (on conflict do nothing: una ya creada no se
-- pisa). Requiere cotizaciones-05, -06 y -08. Volver atrás (sin reglas que las usen):
--   delete from public.cotizacion_plantillas where id in ('traslados_ia_en', 'traslados_ia_en_usd');

do $$ declare f text := ''; c text; begin
  foreach c in array array['diseno', 'condiciones_reserva', 'condiciones_reserva_resumen'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and table_name = 'cotizacion_plantillas' and column_name = c) then
      f := f || case c when 'diseno' then ' cotizaciones-05-plantillas-uso.sql' when 'condiciones_reserva'
                 then ' cotizaciones-06-politica-reserva.sql' else ' cotizaciones-08-resumen-condiciones.sql' end; end if;
  end loop;
  if f <> '' then raise exception 'Antes de traslados-11 hay que correr:%', f; end if;
end $$;

do $$ declare
  gen text[] := array[
    'Prices are per leg and do not include IGV (Peruvian VAT, 18 %).',
    'Includes 30 minutes of free waiting time. Does not include airport parking due to flight delays.',
    'Subject to availability: an executive confirms the booking.'];
  gen_usd text := 'Tourist price: IGV is exempted only if the passengers present their Andean Migration Card (TAM) and passport.';
  res text[] := array[
    'The booking is confirmed with an advance payment of 50 % of the total price.',
    'The remaining 50 % is paid when the service begins.',
    'We send you the written confirmation of your booking and the corresponding receipt (boleta or factura).',
    'You may request changes to the date, time or itinerary at no cost, subject to vehicle availability.',
    'If the change alters the route, the duration or the type of vehicle, we will inform you of the new price before confirming it.',
    'Cancellation 24 hours or more in advance: there is no cost or penalty, and 100 % of the amount paid is refunded to the holder of the payment within a maximum of 48 hours.',
    'Cancellation less than 24 hours in advance, before the vehicle arrives at the pick-up point: you may reschedule at no cost, and your advance payment is applied in full to the new date, subject to availability.',
    'Cancellation less than 24 hours in advance, before the vehicle arrives at the pick-up point: if you prefer to cancel, an administrative fee of 10 % of the amount paid applies, which covers the costs of scheduling and reserving the vehicle and the driver; the balance is refunded to the holder of the amount paid within a maximum of 48 hours.',
    'If the service is cancelled when the vehicle has already arrived at the pick-up point, or if the passenger does not show up without having given notice, 50 % of the total price is charged, which corresponds to the advance paid, and there is no refund.',
    'If the service is interrupted or cancelled once the trip has started, an amount proportional to the kilometres travelled relative to the total contracted route is charged, with a minimum of 50 % of the total price, and there is no refund. For example, if 70 % of the route was covered, 70 % of the price is charged.',
    'To cancel or reschedule, write to us stating the name of the booking holder and the date of the service.',
    'The cancellation notice period is measured from the time of your message until the start time of the service.',
    'If we cannot provide the service, or if it cannot take place for reasons beyond the control of the parties (road closures, mudslides known as huaicos, social conflicts, orders of the authorities or weather conditions that prevent travelling safely), you may choose between rescheduling at no cost or receiving a refund of 100 % of the amount paid for the service not provided; in these cases no cancellation fee applies.',
    'Waiting time and additional hours are charged at the rate stated in your quotation, and they are always communicated before being applied.',
    'For safety reasons, no more passengers are carried than the capacity of the vehicle.',
    'Damage caused to the vehicle by the passengers is the responsibility of the contracting party.',
    'These conditions are disclosed before the service is contracted, in accordance with the Consumer Protection and Defense Code (Law No. 29571).',
    'If you are not satisfied with our service, you may file a claim or complaint in our virtual Complaints Book (Libro de Reclamaciones).'];
  rsm text[] := array[
    'The booking is confirmed with an advance payment of 50 % of the total price; the remaining 50 % is paid when the service begins.',
    'Cancellation 24 hours or more in advance: no cost, and 100 % of the amount paid is refunded within a maximum of 48 hours.',
    'Less than 24 hours in advance, before the vehicle arrives at the pick-up point: you may reschedule at no cost, or cancel with a fee of 10 % of the amount paid.',
    'If the vehicle has already arrived at the pick-up point, or the passenger does not show up without notice, 50 % of the total price is charged and there is no refund.',
    'If we cannot provide the service, you choose between rescheduling at no cost or receiving a refund of 100 % of the amount paid.'];
  -- origen · id nuevo · nombre · celda · huella de las cinco listas del original tal como se tradujeron (md5).
  t text[] := array[
    array['traslados_ia', 'traslados_ia_en', 'Traslados (IA) · inglés · BORRADOR', 'soles', '391fea2b5497655c34bc1fd928403ff0'],
    array['traslados_ia_usd', 'traslados_ia_en_usd', 'Traslados (IA) · inglés · dólares · BORRADOR', 'dólares', '2a4b8ec55034f80f76a4f533d3ed3aeb']];
  i int; src jsonb; cols text; sql text; o numeric;
begin
  cols := (select string_agg(format('%I', column_name), ', ' order by ordinal_position) from information_schema.columns
            where table_schema = 'public' and table_name = 'cotizacion_plantillas' and is_generated = 'NEVER'
              and identity_generation is distinct from 'ALWAYS');
  sql := format('insert into public.cotizacion_plantillas (%1$s) select %1$s from jsonb_populate_record('
    || 'null::public.cotizacion_plantillas, $1) on conflict (id) do nothing', cols);
  o := coalesce((select max((to_jsonb(p)->>'orden')::numeric) from public.cotizacion_plantillas p), 0);
  for i in 1 .. 2 loop
    src := (select to_jsonb(p) from public.cotizacion_plantillas p where p.id = t[i][1]);
    if exists (select 1 from public.cotizacion_plantillas where id = t[i][2]) then continue; end if;
    if src is null then raise notice 'No existe la plantilla %: no se crea %.', t[i][1], t[i][2]; continue; end if;
    if md5(jsonb_build_array(src->'condiciones_generales', src->'condiciones_incluye', src->'condiciones_no_incluye',
             src->'condiciones_reserva', src->'condiciones_reserva_resumen')::text) <> t[i][5] then
      raise notice 'Las condiciones de % cambiaron desde que se tradujeron: no se crea %. Hay que volver a traducir.',
        t[i][1], t[i][2]; continue; end if;
    execute sql using src || jsonb_build_object('id', t[i][2], 'nombre', t[i][3], 'idioma', 'en', 'activa', false,
      'es_principal', false, 'orden', o + i, 'recomendado_para', null, 'diseno', 'corporativo', 'updated_at', now(),
      'descripcion', 'Traducción propuesta: revísala en Plantillas PDF, actívala y asígnala a Traslado de la IA · inglés · '
        || t[i][4] || '.', 'titulo_documento', 'SERVICE QUOTATION',
      'mensaje_cierre', 'Thank you for your preference. We remain at your disposal.',
      'condiciones_generales', to_jsonb(case when i = 1 then gen else gen || gen_usd end),
      'condiciones_incluye', '[]'::jsonb, 'condiciones_no_incluye', '[]'::jsonb,
      'condiciones_reserva', to_jsonb(res), 'condiciones_reserva_resumen', to_jsonb(rsm));
  end loop;
end $$;

-- Comprobación (solo lee): las cuatro plantillas del traslado de la IA, su idioma, si están activas y sus listas.
select id, nombre, idioma, activa, es_principal, diseno, cardinality(condiciones_generales) as generales,
       cardinality(condiciones_reserva) as politica, cardinality(condiciones_reserva_resumen) as resumen
  from public.cotizacion_plantillas where id like 'traslados\_ia%' order by orden, id;
-- FIN de traslados-11-solo-afa-plantillas-ingles.sql
