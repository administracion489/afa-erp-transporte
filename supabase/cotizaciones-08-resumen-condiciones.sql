-- cotizaciones-08-resumen-condiciones.sql — La política de reserva, cambios y cancelación va RESUMIDA en el PDF y en el
-- WhatsApp, con un ENLACE a las condiciones completas de ESA cotización.
--   · cotizacion_plantillas.condiciones_reserva_resumen (text[]): los 4-5 puntos que mueven dinero (adelanto, cancelación,
--     no presentarse). Los escribe una persona; el ERP no recorta la política. NULL = sin resumen: el PDF y el WhatsApp
--     siguen con la política entera, como hoy. La cotización lo COPIA al crearse (consideraciones_json.reserva_resumen).
--   · cotizaciones.condiciones_token (uuid, uno por cotización, imposible de adivinar): el enlace
--     <dominio del ERP>/condiciones/<token> abre la política que quedó guardada en ESA cotización (no la de hoy de la
--     plantilla), sin datos del cliente ni precios. Es la constancia de lo que se le informó antes de pagar.
-- Sin el resumen o sin el enlace, se imprime la política completa: nunca se esconde lo que mueve dinero.
-- El resumen no lleva teléfonos, correos, dominios ni números de 6+ dígitos (dejaría la cotización de la IA en revisión).
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente. Requiere cotizaciones-06.
-- Bloqueo: agregar la columna con default reescribe `cotizaciones` (pocas filas, segundos).

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'cotizacion_plantillas' and column_name = 'condiciones_reserva') then
    raise exception 'Antes de cotizaciones-08 hay que correr: cotizaciones-06-politica-reserva.sql';
  end if;
end $$;

alter table public.cotizacion_plantillas add column if not exists condiciones_reserva_resumen text[];
comment on column public.cotizacion_plantillas.condiciones_reserva_resumen is
  'Resumen de la política de reserva (4-5 puntos de dinero) que va en el PDF y en el WhatsApp con el enlace a la política completa. NULL = sin resumen (se imprime la política entera).';

alter table public.cotizaciones add column if not exists condiciones_token uuid default gen_random_uuid();
update public.cotizaciones set condiciones_token = gen_random_uuid() where condiciones_token is null;
create unique index if not exists uq_cotizaciones_condiciones_token on public.cotizaciones (condiciones_token);
comment on column public.cotizaciones.condiciones_token is
  'Token del enlace público /condiciones/<token>: muestra la política de reserva guardada en esta cotización. Sin datos del cliente.';

-- ── SOLO AFA (otra instalación deja fuera este bloque) ──────────────────────────────────────────
-- El resumen de la política de AFA (cotizaciones-06), en las plantillas de los traslados de la IA y SOLO si su resumen es
-- NULL. Volver atrás (el PDF vuelve a la política entera):
--   update public.cotizacion_plantillas set condiciones_reserva_resumen = null where id in ('traslados_ia', 'traslados_ia_usd');
update public.cotizacion_plantillas set condiciones_reserva_resumen = array[
    'La reserva se confirma con un adelanto del 50 % del precio total; el 50 % restante se paga al iniciar el servicio.',
    'Cancelación con 24 horas o más de anticipación: sin costo, y el 100 % de lo pagado se devuelve en un máximo de 48 horas.',
    'Con menos de 24 horas, antes de que la unidad llegue al punto de recojo: puede reprogramar sin costo, o cancelar con un cargo del 10 % del monto pagado.',
    'Si la unidad ya llegó al punto de recojo, o el pasajero no se presenta sin avisar, se cobra el 50 % del precio total y no hay devolución.',
    'Si no podemos prestar el servicio, usted elige entre reprogramar sin costo o recibir la devolución del 100 % de lo pagado.'
  ]::text[]
 where id in ('traslados_ia', 'traslados_ia_usd') and condiciones_reserva_resumen is null
   and condiciones_reserva is not null;

-- Comprobación (solo lee).
select p.id as plantilla,
       case when p.condiciones_reserva is null then 'sin política' else cardinality(p.condiciones_reserva)::text || ' líneas' end as politica,
       case when p.condiciones_reserva_resumen is null then 'sin resumen (imprime la política entera)'
            else cardinality(p.condiciones_reserva_resumen)::text || ' puntos' end as resumen
  from public.cotizacion_plantillas p order by p.id;
select count(*) as cotizaciones, count(condiciones_token) as con_enlace, count(distinct condiciones_token) as tokens_distintos
  from public.cotizaciones;

-- FIN de cotizaciones-08-resumen-condiciones.sql
