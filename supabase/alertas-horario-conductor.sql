-- ============================================================
-- HORARIO DE ENVÍO AL CONDUCTOR ("no molestar")
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- EL DEFECTO QUE CIERRA (reportado por el dueño, set-2026): los avisos de "vehículo
-- asignado" le llegaban al conductor a las 00:00. Tres días seguidos, reservas #18368,
-- #18369 y #18370, todas a las 12:00 a. m. — y los conductores a esa hora duermen.
--
-- La causa no es una hora mal configurada: el bloque de ciclo de vida de
-- /api/alertas-flota/tick es `modo_tiempo = 'evento'`, o sea sale cuando el motor
-- DETECTA el cambio. Y el motor consulta `fecha_servicio in (hoy, mañana)`, así que un
-- programa fijo creado con semanas de antelación entra a esa ventana justo cuando su
-- fecha pasa a ser "mañana": a medianoche. El diff por reserva lo lee entonces como
-- "recién asignado" y dispara. El aviso no llegaba tarde — llegaba lo antes posible.
--
-- Estas tres columnas son lo único que le faltaba al motor para retenerlo hasta una hora
-- decente. La lógica vive en lib/alertas-horario.ts (módulo PURO, con su matriz en
-- scripts/prueba-horario-conductor.mts); aquí solo se declara la ventana.
--
-- SEGURIDAD DE LA TRANSICIÓN, y es la razón de que `respeta_horario` nazca en FALSE:
-- un despliegue del código sin correr este SQL no retiene ni un mensaje (lib/alertas-
-- horario.ts lee la columna ausente como false), y correr este SQL solo enciende la
-- espera en los CUATRO avisos de ciclo de vida que son los que llegaban de madrugada.
-- Ningún aviso pre-inicio (proximo_inicio, recuerda_iniciar) la respeta jamás: son
-- urgentes por diseño y retenerlos sería exactamente el daño que se quiere evitar.
-- ============================================================

-- ── 1) Columnas ───────────────────────────────────────────────────────────────
-- horario_desde / horario_hasta: ventana en la que SÍ se le puede escribir al
--   conductor, en hora de Lima. Fuera de ella el aviso espera a la próxima apertura.
--   Se admite una ventana que cruce medianoche (22:00 → 06:00); el motor la resuelve.
-- respeta_horario: el interruptor por TIPO de mensaje. Se DECLARA, no se deduce de la
--   clave: que un aviso pueda esperar o no es una propiedad del mensaje, y deducirla
--   por nombre dejaría el día que se añada un tipo nuevo una regla escrita en dos sitios.
alter table public.alerta_config
  add column if not exists horario_desde   text,
  add column if not exists horario_hasta   text,
  add column if not exists respeta_horario boolean not null default false;

comment on column public.alerta_config.horario_desde is
  'Hora Lima "HH:MM" en que ABRE la ventana de envío al conductor. Fuera de ella el aviso espera.';
comment on column public.alerta_config.horario_hasta is
  'Hora Lima "HH:MM" en que CIERRA la ventana (exclusiva). Puede ser menor que horario_desde (ventana nocturna).';
comment on column public.alerta_config.respeta_horario is
  'true = este aviso acepta esperar a la ventana. Los avisos pre-inicio (urgentes por diseño) van siempre en false.';

-- ── 2) Encender la espera en los avisos de CICLO DE VIDA ──────────────────────
-- Son exactamente los que el bloque 1 del tick dispara al detectar el diff por reserva,
-- o sea los que aparecían a las 00:00:
--   asignacion    — "se te asignó este servicio"   ← el reportado
--   cambio        — cambió la hora o el vehículo
--   cancelacion   — el servicio se canceló
--   desasignacion — ya no cubres ese servicio
--
-- 12:00 lo pidió el dueño con esas palabras: «los mensajes de servicios programados para
-- el día siguiente deben llegarle al mediodía del día anterior». 22:00 NO está medido ni
-- heredado y se declara como tal: es el cierre que menos cambia lo que hoy funciona —un
-- operador que reasigna a las 21:30 sigue avisando al instante— y se baja desde
-- /configuracion/operaciones con dos clics el día que estorbe.
--
-- `where respeta_horario = false and horario_desde is null` hace esto UNA sola vez: si
-- alguien ya editó su ventana en el panel, re-ejecutar la migración no se la pisa.
update public.alerta_config
   set horario_desde   = '12:00',
       horario_hasta   = '22:00',
       respeta_horario = true,
       updated_at      = now()
 where clave in ('asignacion', 'cambio', 'cancelacion', 'desasignacion')
   and respeta_horario = false
   and horario_desde is null;

-- ── 3) Comprobación ───────────────────────────────────────────────────────────
-- select clave, nombre, respeta_horario, horario_desde, horario_hasta
--   from public.alerta_config order by respeta_horario desc, clave;
--
-- Lo que se espera ver: las cuatro de arriba en true con 12:00–22:00 y TODAS las demás
-- en false. Una fila `proximo_inicio` o `recuerda_iniciar` en true es un error: esos
-- avisos salen a 90 y 30 min del servicio y ahí no hay nada que retener.
