-- ============================================================
-- «Es urgente si faltan menos de N minutos» — el margen del horario de envío
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- LO QUE PREGUNTÓ EL DUEÑO, y es lo que obligó a escribir la regla por tercera vez:
--
--   «¿Y si programo hoy a las 23:00 un servicio de mañana a las 15:00? No quiero que le
--    llegue mientras duerme. La idea es que si NO es urgente no le llegue el mensaje.»
--
-- Con la regla anterior (retener solo lo que se entregue la VÍSPERA) ese aviso salía a
-- las 23:00, aunque el horario abría a las 11:59 con tres horas de sobra antes del
-- servicio. Sobre-corregía: cerraba el «un minuto de aviso» a costa de despertarlo.
--
-- LO QUE HACE URGENTE A UN AVISO NO ES LA HORA DEL SERVICIO —un servicio de pasado
-- mañana a las 06:00 también cae de madrugada y no tiene nada de urgente— SINO QUE LA
-- PRÓXIMA APERTURA DEL HORARIO YA NO LLEGUE A TIEMPO. Eso se mide, y medirlo necesita
-- decir cuánta antelación es "a tiempo": este margen.
--
-- Con 90 min y una ventana 11:59–21:00, programando el 14 a las 23:00:
--   servicio del 15 a las 15:00 → abre 11:59, 3 h 01 de antelación → ESPERA (duerme)
--   servicio del 15 a las 12:00 → abre 11:59,      1 min           → URGENTE, sale ya
--   servicio del 15 a las 03:00 → el servicio ya habría empezado   → URGENTE, sale ya
--
-- NO HACE FALTA CORRERLA PARA QUE LA REGLA FUNCIONE: sin la columna, el código usa los
-- 90 min por defecto. Es la única excepción del módulo a «sin migración, comportamiento
-- anterior», y es deliberada — sin margen la regla vuelve a retener un aviso hasta un
-- minuto antes del servicio, que es justo el defecto que el margen cierra. La columna
-- solo lo hace EDITABLE desde /configuracion/operaciones.
-- ============================================================

-- 90 min NO es un umbral elegido para este módulo: es el `min_anticipacion` de
-- `proximo_inicio`, o sea lo que este ERP ya declara como «esto está por empezar».
-- Un 0 explícito es válido y significa «nada es urgente: todo lo detectado fuera del
-- horario espera» — por eso la columna admite 0 y el código no lo trata como ausencia.
alter table public.alerta_config
  add column if not exists horario_margen_min integer not null default 90;

comment on column public.alerta_config.horario_margen_min is
  'Minutos de antelación por debajo de los cuales el aviso es URGENTE y se envía al instante aunque el horario esté cerrado. 0 = nada es urgente.';

-- No se toca ninguna fila: el default cubre a todas y el valor lo ajusta una persona en
-- la pantalla, tipo por tipo. Escribir aquí otro número sería elegir por el operador
-- qué considera urgente su operación.

-- ── Comprobación ──────────────────────────────────────────────────────────────
-- select clave, respeta_horario, horario_desde, horario_hasta, horario_margen_min
--   from public.alerta_config where respeta_horario order by clave;
