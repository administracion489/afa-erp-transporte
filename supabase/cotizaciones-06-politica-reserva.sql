-- cotizaciones-06-politica-reserva.sql — La POLÍTICA de reserva, cambios y cancelación vive en la plantilla PDF, como las
-- otras tres listas de condiciones: cotizacion_plantillas.condiciones_reserva (una línea = una regla).
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere
-- cotizaciones-05-plantillas-uso.sql (y el bloque SOLO AFA, sus plantillas traslados_ia y traslados_ia_usd): si falta, se
-- detiene nombrándolo y NO cambia nada.
-- PARTE GENERAL: la columna NACE EN NULL en todas las plantillas = «sin política propia»: el PDF no imprime el bloque y la
-- IA no tiene política que enviar (`politicas_reserva` deriva al ejecutivo). Correrla NO cambia ningún PDF.
-- La cotización la COPIA al crearse (consideraciones_json.reserva): lo que se le envió al cliente queda escrito en su fila
-- y editar la plantilla después no reescribe una cotización ya enviada (la misma regla de cotizaciones-05).
-- La lista NO lleva teléfonos, correos, dominios ni números de 6+ dígitos: una línea así deja la cotización de la IA en
-- revisión (`condicionesSospechosas`, lib/traslados/texto-libre.ts). La línea de contacto la arma el código desde el perfil
-- de la empresa. Topes: 30 líneas y 500 caracteres por línea (MAX_LINEAS_CONDICIONES / MAX_CARACTERES_CONDICION).
-- SIN ESTA MIGRACIÓN la pantalla de plantillas no ofrece la lista y la IA no envía políticas.
-- Bloqueo: columna nullable sin default sobre una tabla de pocas filas.

do $$ begin
  if to_regclass('public.cotizacion_plantillas') is null or not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'cotizacion_plantillas' and column_name = 'diseno') then
    raise exception 'Antes de cotizaciones-06 hay que correr: cotizaciones-05-plantillas-uso.sql';
  end if;
end $$;

alter table public.cotizacion_plantillas add column if not exists condiciones_reserva text[];
comment on column public.cotizacion_plantillas.condiciones_reserva is
  'Política de reserva, cambios y cancelación (una línea = una regla), de usted. La copia la cotización al crearse (consideraciones_json.reserva) y la IA la envía tal cual. Sin teléfonos, correos, dominios ni números de 6+ dígitos. NULL = sin política propia.';

-- Verificación (solo lee): la columna y cuántas líneas tiene cada plantilla (NULL = sin política propia).
select id as plantilla, coalesce(nombre, '—') as nombre, case when condiciones_reserva is null then 'NULL'
       else cardinality(condiciones_reserva)::text || ' líneas' end as politica
  from public.cotizacion_plantillas order by id;

-- ── SOLO AFA (otra instalación deja fuera este bloque) ──────────────────────────────────────────
-- La política PUBLICADA en la web de AFA (versión 01, vigente desde el 26-09-2026), regla por regla, de usted y SIN los
-- datos de contacto (se leyó el 22-10-2026). Va solo a las plantillas de los traslados de la IA y SOLO si su lista es
-- NULL: una lista que alguien ya escribió (o vació a propósito) no se toca. Volver atrás:
--   update public.cotizacion_plantillas set condiciones_reserva = null where id in ('traslados_ia', 'traslados_ia_usd');
do $$ begin
  if (select count(*) from public.cotizacion_plantillas where id in ('traslados_ia', 'traslados_ia_usd')) < 2 then
    raise exception 'Faltan las plantillas traslados_ia y traslados_ia_usd: corre cotizaciones-05-plantillas-uso.sql (traspaso).';
  end if;
end $$;
update public.cotizacion_plantillas set condiciones_reserva = array[
    'La reserva se confirma con un adelanto del 50 % del precio total.',
    'El 50 % restante se paga al iniciar el servicio.',
    'Le enviamos la confirmación de su reserva por escrito y el comprobante correspondiente (boleta o factura).',
    'Puede solicitar cambios de fecha, hora o itinerario sin costo, sujetos a la disponibilidad de unidades.',
    'Si el cambio modifica el recorrido, la duración o el tipo de unidad, le informaremos el nuevo precio antes de confirmarlo.',
    'Cancelación con 24 horas o más de anticipación: es sin costo ni penalidad, y el 100 % del monto pagado se devuelve a su titular en un plazo máximo de 48 horas.',
    'Cancelación con menos de 24 horas de anticipación, antes de que la unidad llegue al punto de recojo: puede reprogramar sin costo, y su adelanto se aplica íntegramente a la nueva fecha, sujeta a disponibilidad.',
    'Cancelación con menos de 24 horas de anticipación, antes de que la unidad llegue al punto de recojo: si prefiere cancelar, se aplica un cargo administrativo del 10 % del monto pagado, que cubre los costos de programación y reserva de la unidad y del conductor; el saldo se devuelve al titular del monto pagado en un plazo máximo de 48 horas.',
    'Si el servicio se cancela cuando la unidad ya llegó al punto de recojo, o si el pasajero no se presenta sin haber avisado, se cobra el 50 % del precio total, que corresponde al adelanto pagado, y no hay devolución.',
    'Si el servicio se interrumpe o se cancela una vez iniciado el viaje, se cobra un monto proporcional al kilometraje recorrido respecto del recorrido total contratado, con un mínimo del 50 % del precio total, y no hay devolución. Por ejemplo, si se recorrió el 70 % del trayecto, se cobra el 70 % del precio.',
    'Para cancelar o reprogramar, escríbanos indicando el nombre del titular y la fecha del servicio.',
    'El plazo de cancelación se mide desde la hora de su mensaje hasta la hora de inicio del servicio.',
    'Si no podemos prestar el servicio, o si este no puede realizarse por causas ajenas a las partes (cierre de carreteras, huaicos, conflictos sociales, disposiciones de la autoridad o condiciones climáticas que impidan viajar con seguridad), usted puede elegir entre reprogramar sin costo o recibir la devolución del 100 % de lo pagado por el servicio no prestado; en estos casos no se aplica ningún cargo por cancelación.',
    'El tiempo de espera y las horas adicionales se cobran según la tarifa indicada en su cotización, y siempre se informan antes de aplicarse.',
    'Por seguridad, no se transportan más pasajeros que la capacidad de la unidad.',
    'Los daños causados a la unidad por los pasajeros son responsabilidad del contratante.',
    'Estas condiciones se informan antes de la contratación, conforme al Código de Protección y Defensa del Consumidor (Ley N.° 29571).',
    'Si no está conforme con nuestro servicio, puede registrar su reclamo o queja en nuestro Libro de Reclamaciones virtual.'
  ]::text[]
 where id in ('traslados_ia', 'traslados_ia_usd') and condiciones_reserva is null;
-- Lo que quedó (solo lee): cada línea con su número y su largo. Ninguna debe pasar de 500 caracteres.
select p.id as plantilla, l.n as "#", char_length(l.linea) as largo, l.linea
  from public.cotizacion_plantillas p, unnest(p.condiciones_reserva) with ordinality l(linea, n)
 where p.id in ('traslados_ia', 'traslados_ia_usd') order by p.id, l.n;
-- FIN de cotizaciones-06-politica-reserva.sql
