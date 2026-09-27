-- ────────────────────────────────────────────────────────────────────────────
-- liquidaciones-04-etiquetas-item.sql — El ÍTEM de la liquidación lo deciden tres
-- ETIQUETAS que escribe una persona: RUTA, TURNO y MÓVIL. La hora deja de partirlo.
--
-- EL PROBLEMA QUE RESUELVE
--
-- Hasta aquí el ítem del AFA-FL-07 salía de REDACTAR el nombre de la ruta:
--
--     RUTA A/ ENTRADA 04:35/ SANTA ANITA→BSF PUNTA HERMOSA
--
-- y ese texto lleva la HORA dentro. Cuando el cliente corre el horario —la RUTA A
-- turno 1 sale a las 04:35 una semana y a las 05:00 la siguiente— el mismo servicio
-- contratado quedaba partido en dos ítems, aunque sea la misma ruta, el mismo turno
-- y el mismo bus. La agrupación ya borraba la hora al comparar (`sinHoraRuta`), pero
-- un segundo turno de la misma ruta (04:35 y 06:35) se distingue SOLO por la hora,
-- así que no había forma de juntar el primero sin fundir los dos.
--
-- Lo que el dueño pidió, con sus palabras: el ítem es
--
--     TRANSPORTE DE PERSONAL / 50 PAX / DEL 01-09-2026 AL 30-09-2026 / RUTA A / TURNO 1
--
-- y solo se abre OTRO ítem cuando cambia la RUTA (A → B), el TURNO, el MÓVIL (dos
-- buses saliendo a la vez en la misma ruta y turno: MÓVIL 1 DE 2), los PAX
-- contratados o la tarifa.
--
-- LO QUE AGREGA ESTE ARCHIVO
--
--   reservas.ruta_etiqueta  — 'RUTA A', 'RUTA B', 'RUTA NORTE'…
--   reservas.turno          — 1, 2, 3… (T1 = la salida más temprana de la ruta)
--   reservas.movil          — 1, 2… SOLO cuando salen 2+ buses a la vez en la misma
--                             ruta y turno. NULL = único móvil (se lee como 1).
--
-- Los PAX NO son una etiqueta nueva: ya existen como `capacidad_contratada`
-- (liquidaciones-03) y la liquidación los resuelve con su cascada de siempre. Una
-- cuarta columna con los mismos asientos sería el mismo dato en dos sitios.
--
-- POR QUÉ COLUMNAS EN `reservas` Y NO UNA FICHA APARTE
--
-- Porque son del SERVICIO, igual que `capacidad_contratada` y `precio_cliente`: se
-- escriben en cada tramo (la ida y el retorno llevan las mismas) y se corrigen en
-- lote desde Programación, Seguimiento y el cierre de Liquidaciones. La reserva no
-- sabe de qué ítem de la cotización nació, así que no había un sitio de más arriba
-- de donde heredarlas sin adivinar.
--
-- NADA SE RELLENA AQUÍ, a propósito. Un servicio sin etiquetas se sigue agrupando
-- exactamente como antes (por el nombre sin la hora y por los extremos en el mapa),
-- así que correr este archivo no mueve un solo ítem de ningún documento. Las
-- etiquetas las pone una persona —o las PROPONE el ERP por horario y una persona las
-- confirma— desde el botón "🏷 Etiquetas" de Liquidaciones o de Programación.
--
-- DEPENDENCIAS: ninguna. El código tolera que falte: sin estas columnas la
-- liquidación agrupa como siempre y la pantalla dice qué archivo correr.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.reservas add column if not exists ruta_etiqueta text;
alter table public.reservas add column if not exists turno         smallint;
alter table public.reservas add column if not exists movil         smallint;

comment on column public.reservas.ruta_etiqueta is
  'Etiqueta de RUTA del ítem de liquidación (''RUTA A''). La confirma una persona (el ERP '
  'la PROPONE cuando el nombre empieza por «RUTA X»); la liquidación nunca la deduce al '
  'agrupar. Con turno define el ítem del AFA-FL-07: la hora ya no lo parte.';
comment on column public.reservas.turno is
  'Turno de la ruta (1 = la salida más temprana). Parte del ítem de liquidación.';
comment on column public.reservas.movil is
  'Móvil dentro de la misma ruta y turno, SOLO cuando salen 2+ buses a la vez. '
  'NULL = único móvil. Imprime "MÓVIL k DE N" y separa ítems.';

-- Vacío no es un valor: o hay etiqueta o es NULL. Un '' pasaría por "etiquetado" en
-- cualquier consulta que pregunte `is not null` y agruparía servicios sin nombre.
alter table public.reservas drop constraint if exists reservas_ruta_etiqueta_check;
alter table public.reservas add constraint reservas_ruta_etiqueta_check
  check (ruta_etiqueta is null or length(btrim(ruta_etiqueta)) between 1 and 40);

alter table public.reservas drop constraint if exists reservas_turno_check;
alter table public.reservas add constraint reservas_turno_check
  check (turno is null or turno between 1 and 99);

alter table public.reservas drop constraint if exists reservas_movil_check;
alter table public.reservas add constraint reservas_movil_check
  check (movil is null or movil between 1 and 99);

-- ────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano después de aplicar)
--
--   -- 1. Las columnas existen:
--   select column_name, data_type
--     from information_schema.columns
--    where table_name = 'reservas' and column_name in ('ruta_etiqueta','turno','movil');
--
--   -- 2. Cuánto del mes ya está etiquetado (la ida y el retorno cuentan aparte):
--   select count(*) filter (where ruta_etiqueta is not null and turno is not null) as etiquetados,
--          count(*) as total
--     from public.reservas
--    where fecha_servicio between '2026-09-01' and '2026-09-30';
-- ────────────────────────────────────────────────────────────────────────────
