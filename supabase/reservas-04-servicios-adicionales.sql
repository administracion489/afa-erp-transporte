-- ────────────────────────────────────────────────────────────────────────────
-- reservas-04-servicios-adicionales.sql — El servicio que el cliente pide POR
-- ENCIMA de lo contratado deja de confundirse con lo contratado.
--
-- EL PROBLEMA QUE RESUELVE
--
-- Cuando un cliente pide un adicional ("mándame una unidad más el viernes a las
-- 17:00"), operaciones ya tiene un camino y es el correcto: Programa fijo →
-- elegir la cotización que tiene los paraderos bien definidos → asignar vehículo
-- y conductor. Lo que falla son tres cosas, y ninguna es de flujo:
--
--   1) EL PRECIO NO SE PUEDE PONER AL GENERAR. El modal escribe el precio del
--      ítem de la cotización en todos los servicios que crea. Como el adicional
--      casi siempre se cobra distinto, había que generarlo con el precio del
--      contrato y corregirlo después SERVICIO POR SERVICIO en Programación.
--      Y corregirlo después no es lo mismo: subir el precio de un servicio ya
--      creado dispara el acta de venta y el enlace público de conformidad
--      (fn_reservas_pacto_acta). Nacer con su precio no dispara nada, que es lo
--      correcto — el adicional no encarece nada, se cobra lo que se acordó.
--
--   2) NO SE PODÍA PEDIR SOLO LA SALIDA. Si la cotización tiene hora de retorno,
--      el generador crea SIEMPRE ida y retorno. "Una salida adicional" obligaba
--      a crear también la entrada y cancelarla a mano.
--
--   3) EL ADICIONAL DESAPARECÍA EN LA LIQUIDACIÓN. Sin marca de origen, una
--      salida extra a S/ 480 se agrupaba junto a las del contrato o, si el
--      precio difería, salía como un renglón más de servicios sin decir en
--      ninguna parte que era un adicional. El formato AFA-FL-07 ya tiene un
--      subtotal "Adicionales" (v. totalesValorizacion en
--      lib/liquidacion-agrupacion.ts) que nunca se podía llenar desde la
--      operación: solo a mano, escribiendo el importe en el editor.
--
-- LO QUE AGREGA ESTE ARCHIVO
--
--   reservas.origen_contractual  — contrato | adicional | contingencia
--   reservas.precio_cotizado     — de cuánto se partió (el precio del contrato)
--   reservas.adicional_motivo    — por qué se cobra distinto (clave pacto_motivo)
--   reservas.adicional_nota      — el detalle en palabras de quien lo registró
--   v_adicionales                — la vista para medirlos
--
-- POR QUÉ 'contingencia' ENTRA EN EL CHECK DESDE HOY aunque todavía no tenga
-- pantalla: ampliar un CHECK sobre una tabla de cientos de miles de filas obliga
-- a revalidarla entera. Que el tercer valor exista desde el día uno cuesta cero
-- ahora y evita una migración con bloqueo después. Es el mismo criterio con el
-- que pacto-02 declaró los cuatro estados del monto de una sola vez.
--
-- NO se agrega ninguna tabla "contratos": el contrato es la cotización con
-- modo_servicio='fijo', y el adicional queda amarrado a ella por el
-- cotizacion_id que la reserva ya guarda.
--
-- Requiere: supabase/liquidaciones-03-ruta-contratada.sql, y solo por el punto 5
-- (v_adicionales publica reservas.capacidad_contratada, que la agrega ese archivo).
-- Los puntos 1 a 4 son independientes de todo.
--
-- Del lado de la app las columnas son OPCIONALES: si este archivo no se corrió, se
-- reintenta sin ellas (ver `insertarReservas` y `fetchReservasCols`), así que se
-- puede desplegar antes o después del código.
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 1) El origen del servicio
--
-- NOT NULL con DEFAULT: en PostgreSQL 11+ eso no reescribe la tabla (el valor
-- por defecto se guarda en el catálogo), así que agregarlo sobre `reservas` no
-- bloquea la operación. Y el default tiene que ser 'contrato': todo lo que
-- existe hoy nació de un programa fijo o de una cotización eventual.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists origen_contractual text not null default 'contrato';

alter table public.reservas drop constraint if exists reservas_origen_contractual_check;
alter table public.reservas add constraint reservas_origen_contractual_check
  check (origen_contractual in ('contrato', 'adicional', 'contingencia'));

comment on column public.reservas.origen_contractual is
  'De dónde nace el servicio. contrato = está dentro de lo pactado (programa fijo o '
  'cotización eventual). adicional = el cliente lo pidió por encima del contrato y se '
  'cobra aparte. contingencia = lo puso AFA para cubrir una falla propia (avería, '
  'sobrecupo) y normalmente NO se cobra. Sin esta marca el adicional se fundía con las '
  'líneas del contrato en la liquidación y dejaba de existir como concepto.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) De cuánto se partió
--
-- Snapshot del precio de referencia (el ítem de la cotización) EN EL MOMENTO de
-- generar. No se deriva leyendo la cotización después: el contrato se renegocia
-- y entonces la comparación "se cobró S/ 130 más" cambiaría sola, meses después,
-- sin que nadie tocara el servicio.
--
-- Va sobre TODA reserva, no solo sobre las adicionales: saber que un servicio de
-- contrato se generó a S/ 350 cuando la cotización decía S/ 350 es lo que hace
-- verificable la comparación del adicional.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists precio_cotizado numeric(12,2);

comment on column public.reservas.precio_cotizado is
  'Precio de referencia del que partió el servicio al generarse (ítem de la cotización). '
  'Snapshot, no derivación: si el contrato se renegocia, la diferencia contra lo que se '
  'cobró de verdad tiene que seguir midiéndose contra lo que regía ese día.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Por qué se cobró distinto
--
-- El adicional NACE con su precio, así que no dispara el acta de venta (esa vive
-- en el AFTER UPDATE). Este par de columnas es entonces el ÚNICO sitio donde
-- queda registrado el porqué, y es la respuesta a la pregunta que llega tres
-- meses después: "¿por qué esta salida costó S/ 480 si la ruta está a S/ 350?".
--
-- Hasta la fase 6 del Pacto el AFTER UPDATE emitía además un enlace de
-- conformidad para el cliente; ya no (pacto-06-sin-conformidad-de-cambio.sql).
-- No cambia nada de acá: la razón por la que estas dos columnas existen siempre
-- fue el acta, que se sigue escribiendo.
--
-- `adicional_motivo` guarda una clave de pacto_motivo (la misma lista de un clic
-- que ya usa Programación) pero SIN FK: pacto_motivo es un catálogo afinable y
-- un adicional de 2026 no puede volverse inguardable porque en 2027 se retire un
-- motivo. Es el mismo criterio con el que reservas.cambio_motivo tampoco la
-- tiene.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists adicional_motivo text,
  add column if not exists adicional_nota   text;

comment on column public.reservas.adicional_motivo is
  'Por qué el adicional se cobra distinto al precio de la cotización. Clave de '
  'pacto_motivo, sin FK a propósito. Solo se pide cuando precio_cliente difiere de '
  'precio_cotizado: si el adicional se cobra al mismo precio, no hay nada que explicar.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Índice PARCIAL
--
-- Los adicionales son una minoría por definición. Un índice sobre toda la
-- columna sería casi tan grande como la tabla y no serviría para nada: el 99 %
-- de las filas dice 'contrato'. El parcial indexa solo lo que se consulta.
-- ────────────────────────────────────────────────────────────────────────────
create index if not exists idx_reservas_origen_no_contrato
  on public.reservas (origen_contractual, fecha_servicio desc)
  where origen_contractual <> 'contrato';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) v_adicionales — la vista para medirlos
--
-- Publica UNA FILA POR SERVICIO adicional con todo lo necesario para los seis
-- indicadores: creados, ejecutados, pendientes de liquidar, facturados, importe
-- y la comparación contra lo contratado.
--
-- No suma nada: agregar es de quien consulta. Una vista que ya devuelve totales
-- obliga a una vista nueva por cada corte (por cliente, por mes, por ruta) y
-- termina siendo cinco vistas que se contradicen.
--
-- `liquidacion_cliente_id` + el estado de esa liquidación es lo que separa
-- "pendiente de liquidar" de "facturado": son dos momentos distintos y hasta
-- ahora no había forma de contarlos por separado para un adicional.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_adicionales as
  select r.id                                as reserva_id,
         r.codigo,
         r.origen_contractual,
         r.fecha_servicio,
         r.hora_servicio,
         r.cliente_id,
         cl.nombre                           as cliente_nombre,
         r.cotizacion_id,
         r.ruta_nombre,
         r.direccion_servicio,
         r.reserva_vinculada_id,
         r.origen,
         r.destino,
         r.estado,
         r.estado_admin,
         r.precio_cliente,
         r.precio_cotizado,
         -- Positivo = se cobró MÁS que lo contratado. null cuando no hay referencia:
         -- un cero ahí diría "se cobró igual", que es una afirmación distinta.
         case when r.precio_cotizado is not null
              then round(coalesce(r.precio_cliente,0) - r.precio_cotizado, 2) end
                                             as diferencia_precio,
         r.adicional_motivo,
         r.adicional_nota,
         r.costo_proveedor,
         r.empresa_tercerizada_id,
         r.vehiculo_id,
         r.vehiculo_tercero_id,
         r.capacidad_contratada,
         r.liquidacion_cliente_id,
         lq.codigo                           as liquidacion_codigo,
         lq.estado                           as liquidacion_estado,
         -- Los tres momentos que hay que poder contar por separado.
         (r.estado = 'finalizada')           as ejecutado,
         (r.estado = 'finalizada'
          and r.liquidacion_cliente_id is null)
                                             as pendiente_liquidar,
         (lq.estado = 'facturada')           as facturado,
         r.lote_generacion,
         r.created_at
    from public.reservas r
    left join public.clientes cl            on cl.id = r.cliente_id
    left join public.liquidacion_cliente lq on lq.id = r.liquidacion_cliente_id
   where r.origen_contractual <> 'contrato';

comment on view public.v_adicionales is
  'Un renglón por servicio fuera del contrato (adicional o contingencia), con el '
  'importe, la diferencia contra lo cotizado y en qué punto del ciclo está. No agrega: '
  'los cortes por cliente, mes o ruta los hace quien consulta.';

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- 1) Las columnas existen y el default no tocó los datos históricos:
--
--      select origen_contractual, count(*)
--        from public.reservas group by 1 order by 2 desc;
--      -- debe devolver una sola fila: contrato = <todas>
--
-- 2) Adicionales del mes, con cuánto se apartaron de la tarifa del contrato:
--
--      select fecha_servicio, cliente_nombre, ruta_nombre,
--             precio_cliente, precio_cotizado, diferencia_precio, adicional_motivo
--        from public.v_adicionales
--       where fecha_servicio between '2026-09-01' and '2026-09-30'
--       order by fecha_servicio;
--
-- 3) Adicionales prestados que todavía nadie facturó (la fuga que esto evita):
--
--      select count(*), sum(precio_cliente)
--        from public.v_adicionales
--       where pendiente_liquidar;
