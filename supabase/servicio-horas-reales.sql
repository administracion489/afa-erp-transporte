-- ──────────────────────────────────────────────────────────────────────────────
-- supabase/servicio-horas-reales.sql — el INSTANTE real del servicio, con procedencia
--
-- ── EL PROBLEMA QUE ARREGLA ───────────────────────────────────────────────────
-- `reservas.hora_real_inicio` y `reservas.hora_real_fin` son text "HH:MM:SS" DEL DÍA,
-- SIN fecha. Eso rompe de dos formas distintas:
--
--   1) LA MEDIANOCHE. Un servicio que sale 22:00 y cierra 01:30 da −1230 minutos de
--      duración. Hoy eso se tapa con Math.max(0, fin − ini) (app/seguimiento/page.tsx:1150)
--      y la duración se imprime como "0 min" sin que nadie se entere. Y no es un caso
--      raro de laboratorio: hay tours full day de hasta 24 h, y el propio repo ya
--      dimensiona sus ventanas con 26 h por eso (app/api/cliente/gps/route.ts:56-58).
--
--   2) LA PROCEDENCIA. "05:12" no dice si lo marcó el conductor en el paradero, si lo
--      tecleó un operador tres días después de memoria, o si salió del GPS. Son hechos
--      de valor MUY distinto —uno se factura y el otro no— y hoy se guardan iguales.
--
-- Sobre eso se apila el problema de fondo: medido en producción sobre 30 días (corte
-- 2026-08-20, 575 servicios operados), `hora_real_fin` está en 0 de 575 y
-- `hora_real_inicio` en 1 de 575. La ficha del drawer YA muestra la hora derivada de la
-- evidencia (lib/servicio-tiempos.ts), pero el DATO sigue vacío en la BD: la liquidación
-- imprime la llegada en blanco (lib/liquidacion-datos.ts:217-218) y las alertas de solape
-- asumen un bloque de 4 h por defecto (lib/alertas-flota.ts:40) porque no hay nada que leer.
--
-- ── LO QUE AGREGA ─────────────────────────────────────────────────────────────
--   inicio_real_ts      timestamptz  instante COMPLETO de salida (UTC, con fecha)
--   fin_real_ts         timestamptz  instante COMPLETO de cierre
--   inicio_real_fuente  text         de dónde salió ese instante
--   fin_real_fuente     text         de dónde salió ese instante
--
-- Un timestamptz no tiene el problema de la medianoche: 22:00 y 01:30 son dos instantes
-- y la resta da 3 h 30 min sin que nadie tenga que adivinar el día.
--
-- ── LAS COLUMNAS VIEJAS SE CONSERVAN Y SE SIGUEN ESCRIBIENDO ──────────────────
-- Esto NO es una migración destructiva. `hora_real_inicio` / `hora_real_fin` quedan
-- donde están y hay que seguir escribiéndolas en paralelo: las leen la liquidación
-- (lib/liquidacion-datos.ts:151,217-218), las alertas de flota
-- (app/api/alertas-flota/tick/route.ts:76,637 y lib/alertas-flota.ts:14,40), la descarga
-- masiva (lib/descarga-masiva.ts:140,353-354), la analítica de odómetro
-- (app/api/mantenimiento/odometro-analitica/route.ts:146,256), ELIA
-- (lib/elia/herramientas.ts:1699) y el propio drawer. Ninguno de esos consumidores puede
-- romperse por esta migración, así que no se toca ni una fila existente.
--
-- ── LA DOCTRINA, QUE ESTAS COLUMNAS NO PUEDEN VIOLAR ──────────────────────────
-- lib/avance-paradas.ts:30 la fijó: "inferir para PINTAR es otra cosa que inferir para
-- ESCRIBIR". Aquí SOLO se persiste evidencia dura de un acto humano registrado — el
-- conductor marcó la parada, alguien escaneó un QR, el conductor pulsó finalizar. Una
-- hora estimada por GPS se PINTA (lib/servicio-tiempos.ts la devuelve con estimado:true
-- y en cursiva con "~"), JAMÁS se guarda aquí.
--
-- ¿Y por qué el CHECK admite entonces 'gps', 'gps_finalizado' y 'gps_ultimo'? Porque la
-- columna describe PROCEDENCIA, no permiso: si algún día alguien escribe una hora de GPS
-- —a mano, en una corrección, o por un bug— el sistema tiene que poder decir de dónde
-- vino en vez de disfrazarla de dato duro. El candado está en el lector:
-- lib/servicio-tiempos.ts marca `estimado: true` para toda fuente gps* aunque venga de
-- esta columna, así que una hora estimada NO puede lavarse pasándola por la base y
-- volviendo. El escritor no debe usar esos valores; el lector no se fía de que no lo haga.
--
-- ── SIN BACKFILL, A PROPÓSITO ─────────────────────────────────────────────────
-- Este script NO rellena nada. Rellenar sería derivar en masa 575 servicios y persistir
-- el resultado, que es exactamente lo que la doctrina prohíbe hacer sin mirar la
-- evidencia caso por caso. Quién escribe estas columnas, cuándo y con qué prueba se
-- decide fuera de este archivo. Hasta entonces las columnas quedan en NULL y
-- lib/servicio-tiempos.ts sigue funcionando igual que hoy (cae a la cascada de siempre).
--
-- Idempotente: se puede correr las veces que haga falta. No toca RLS (las políticas
-- existentes de `reservas` ya cubren estas columnas). Instantáneo: son columnas nullable,
-- Postgres no reescribe la tabla, y el índice es parcial sobre un conjunto hoy vacío.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar.
-- ──────────────────────────────────────────────────────────────────────────────

-- ── 1) Las columnas ──────────────────────────────────────────────────────────
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS inicio_real_ts     timestamptz,
  ADD COLUMN IF NOT EXISTS fin_real_ts        timestamptz,
  ADD COLUMN IF NOT EXISTS inicio_real_fuente text,
  ADD COLUMN IF NOT EXISTS fin_real_fuente    text;

COMMENT ON COLUMN public.reservas.inicio_real_ts IS
  'Instante COMPLETO de salida del servicio (timestamptz). Sustituye a hora_real_inicio ("HH:MM:SS" sin fecha), que se conserva y se sigue escribiendo en paralelo. Solo evidencia dura: ver supabase/servicio-horas-reales.sql.';
COMMENT ON COLUMN public.reservas.fin_real_ts IS
  'Instante COMPLETO de cierre del servicio (timestamptz). Sustituye a hora_real_fin ("HH:MM:SS" sin fecha), que se conserva y se sigue escribiendo en paralelo.';
COMMENT ON COLUMN public.reservas.inicio_real_fuente IS
  'De dónde salió inicio_real_ts: parada | abordaje | evento_salio | gps | operador | radar. Manda sobre la etiqueta que pinta la app (lib/servicio-tiempos.ts).';
COMMENT ON COLUMN public.reservas.fin_real_fuente IS
  'De dónde salió fin_real_ts: parada | conductor_finalizo | gps_finalizado | gps_ultimo | operador | radar. "conductor_finalizo" = el conductor pulsó finalizar en su app y el servidor registró el instante: evidencia dura, no estimada.';

-- ── 2) Valores permitidos ────────────────────────────────────────────────────
-- Los mismos identificadores que el tipo `FuenteTiempo` de lib/servicio-tiempos.ts, para
-- que la BD y el motor hablen el mismo idioma y un valor inventado no llegue a la pantalla.
--   parada             el conductor marcó el paradero      (paradas.hora_llegada)
--   abordaje           alguien escaneó un QR               (pasajeros_parada.hora_abordaje, reloj de SERVIDOR)
--   evento_salio       se avisó "tu bus ya salió"          (push_eventos_viaje)
--   conductor_finalizo el conductor pulsó FINALIZAR        (registrado por el SERVIDOR al atender la llamada)
--   gps                primer punto GPS                    ESTIMADO — no escribir
--   gps_finalizado     el conductor pulsó finalizar        (punto GPS forzado — reloj del TELÉFONO)
--   gps_ultimo         última señal, sin cierre explícito  ESTIMADO — no escribir
--   operador           lo tecleó una persona en el ERP
--   radar              lo dedujo Radar IA de un WhatsApp   (lib/radar/acciones.ts:1355-1356)
--
-- ── 'conductor_finalizo': POR QUÉ EXISTE Y POR QUÉ SOLO EN EL FIN ─────────────
-- Los dos endpoints que cierran un servicio desde la app del conductor
-- (app/api/conductor/route.ts y app/api/conductor-tercero/finalizar/route.ts) sellan un
-- hecho que NINGUNO de los otros valores describe, y por eso hubo que darle nombre
-- propio en vez de reciclar uno:
--   · 'gps_finalizado' MENTIRÍA por defecto: designa un punto de ubicaciones_gps con
--     estado='finalizado', con la hora del TELÉFONO. Puede no existir ni un punto (sin
--     señal, GPS apagado) y aun así el conductor cerró; y lib/servicio-tiempos.ts marca
--     toda fuente gps* con estimado:true, o sea que un cierre duro saldría en cursiva
--     con "~" y sin derecho a facturarse.
--   · 'operador' MENTIRÍA al revés: ese nombre está reservado para lo que un humano
--     teclea en /seguimiento, a veces días después y de memoria. Esto es el conductor en
--     la calle y el instante lo estampa el servidor.
-- El nombre lleva el ACTO ('...finalizo') y no solo a la persona ('conductor'): 'parada' y
-- 'abordaje' también las produce el conductor, así que un 'conductor' a secas se volvería
-- el cajón de sastre de cualquier hora "que vino del conductor", incluida una inferida por
-- geocerco. Es la cadena EXACTA que deben escribir ambos endpoints; no hay sinónimos.
--
-- Va SOLO en el CHECK del fin, no en el del inicio: "pulsó finalizar" es, por definición,
-- el final del servicio y como hora de salida no significa nada — la misma razón por la
-- que el inicio tampoco admite gps_finalizado/gps_ultimo. Si por un bug apareciera en
-- inicio_real_fuente, la BD lo rechaza aquí y, si aun así llegara a la app, el lector
-- (lib/servicio-tiempos.ts, FUENTES_INICIO) lo degrada a 'operador' y lo manda al fondo
-- de la cascada: se conserva el hecho de que alguien registró la hora, no la autoridad.
--
-- (DROP previo en cada uno para que el script sea re-ejecutable sin error. Añadir un valor
--  al CHECK del fin es seguro re-corriéndolo: la restricción se borra y se vuelve a crear,
--  y como solo AMPLÍA el conjunto permitido, ninguna fila ya guardada puede quedar fuera.)

ALTER TABLE public.reservas
  DROP CONSTRAINT IF EXISTS reservas_inicio_real_fuente_check;
ALTER TABLE public.reservas
  ADD CONSTRAINT reservas_inicio_real_fuente_check
  CHECK (inicio_real_fuente IS NULL OR inicio_real_fuente IN
    ('parada', 'abordaje', 'evento_salio', 'gps', 'operador', 'radar'));

ALTER TABLE public.reservas
  DROP CONSTRAINT IF EXISTS reservas_fin_real_fuente_check;
ALTER TABLE public.reservas
  ADD CONSTRAINT reservas_fin_real_fuente_check
  CHECK (fin_real_fuente IS NULL OR fin_real_fuente IN
    ('parada', 'conductor_finalizo', 'gps_finalizado', 'gps_ultimo', 'operador', 'radar'));

-- ── 3) Una hora guardada SIN procedencia no existe ───────────────────────────
-- El punto entero de estas columnas es que la hora venga con su origen: una hora sin
-- fuente es otra vez "05:12" a secas, o sea el problema de partida. Se prefiere que el
-- UPDATE falle ruidosamente a que entre un dato mudo que después alguien facture.
-- (La fuente SÍ puede quedar sola: sirve para anotar "esto lo registró el operador"
-- mientras la hora todavía no se conoce.)
-- Todas las filas existentes tienen las cuatro columnas en NULL, así que valida al vuelo.

ALTER TABLE public.reservas
  DROP CONSTRAINT IF EXISTS reservas_inicio_real_ts_con_fuente;
ALTER TABLE public.reservas
  ADD CONSTRAINT reservas_inicio_real_ts_con_fuente
  CHECK (inicio_real_ts IS NULL OR inicio_real_fuente IS NOT NULL);

ALTER TABLE public.reservas
  DROP CONSTRAINT IF EXISTS reservas_fin_real_ts_con_fuente;
ALTER TABLE public.reservas
  ADD CONSTRAINT reservas_fin_real_ts_con_fuente
  CHECK (fin_real_ts IS NULL OR fin_real_fuente IS NOT NULL);

-- ── 4) Índice ────────────────────────────────────────────────────────────────
-- PARCIAL a propósito: hoy la columna está 100 % en NULL y va a llenarse despacio (solo
-- servicios nuevos con evidencia). Un índice completo indexaría 8.000+ NULLs para nada.
-- Sirve para "servicios que de verdad salieron entre tal y tal instante" — la consulta
-- de las alertas de solape y del cierre de liquidación.
CREATE INDEX IF NOT EXISTS idx_reservas_inicio_real_ts
  ON public.reservas (inicio_real_ts DESC)
  WHERE inicio_real_ts IS NOT NULL;

-- ── Smoke test ───────────────────────────────────────────────────────────────
-- Las cuatro columnas existen y están vacías:
--   select count(*)                                  as reservas,
--          count(inicio_real_ts)                     as con_inicio,
--          count(fin_real_ts)                        as con_fin,
--          count(*) filter (where hora_real_inicio is not null) as con_inicio_viejo,
--          count(*) filter (where hora_real_fin    is not null) as con_fin_viejo
--     from public.reservas
--    where fecha_servicio >= current_date - 30;
--
-- El CHECK rechaza una fuente inventada (debe dar ERROR 23514):
--   update public.reservas set inicio_real_fuente = 'adivinado' where id = -1;
--
-- El fin SÍ admite el cierre del conductor (no debe dar error; 0 filas por el id = -1):
--   update public.reservas set fin_real_fuente = 'conductor_finalizo' where id = -1;
--
-- ...y el inicio NO lo admite, porque "pulsó finalizar" no es una hora de salida (ERROR 23514):
--   update public.reservas set inicio_real_fuente = 'conductor_finalizo' where id = -1;
--
-- Con qué se están cerrando los servicios de verdad (esto es lo que hay que mirar el día
-- después de que los endpoints empiecen a sellar; si sale 0, el CHECK y el escritor no hablan
-- el mismo idioma y `fin_real_ts` se está quedando en NULL con un warn en los logs):
--   select fin_real_fuente, count(*) from public.reservas
--    where fecha_servicio >= current_date - 7 group by 1 order by 2 desc;
--
-- Y rechaza una hora sin procedencia (debe dar ERROR 23514):
--   update public.reservas set inicio_real_ts = now(), inicio_real_fuente = null where id = -1;
--
-- Duraciones reales una vez que haya datos (esto es lo que hoy es imposible calcular):
--   select id, codigo, inicio_real_fuente, fin_real_fuente,
--          round(extract(epoch from (fin_real_ts - inicio_real_ts)) / 60) as duracion_min
--     from public.reservas
--    where inicio_real_ts is not null and fin_real_ts is not null
--    order by fecha_servicio desc limit 50;
