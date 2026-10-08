-- ============================================================================
-- combustible-05 · la HORA del despacho
-- ============================================================================
-- El formulario de /combustible pedía la fecha y no la hora. Sin hora, el odómetro de la carga
-- solo se puede ubicar en su DÍA: las lecturas de ese mismo día (check-in, check-out) no la
-- acotan, y `registrarLectura` la trata como del final del día. Con la hora impresa en el voucher
-- la lectura queda exacta y se juzga contra la de antes y la de después.
--
-- Nullable y SIN default: una carga vieja no tiene hora, y un default afirmaría una que nadie leyó.
-- Sin esta migración el formulario guarda igual (sin la hora en la carga) y lo dice; la lectura de
-- odómetro sí lleva la hora, porque esa columna (`lecturas_odometro.capturado_en`) ya existe.
--
-- NO la corre el deploy.
-- ============================================================================

alter table public.combustible add column if not exists hora time;

comment on column public.combustible.hora is
  'Hora del despacho (la impresa en el voucher), hora Lima. null = no se registró.';
