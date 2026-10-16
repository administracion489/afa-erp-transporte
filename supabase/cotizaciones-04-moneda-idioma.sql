-- supabase/cotizaciones-04-moneda-idioma.sql
-- Cotizar en DÓLARES y emitir el PDF en INGLÉS, sin cambiar qué significa ningún importe.
--
-- QUÉ HACE: agrega a `cotizaciones` tres columnas de PRESENTACIÓN:
--   moneda      'PEN' | 'USD'   (default 'PEN')
--   tipo_cambio soles por dólar, congelado en la cotización (null en PEN)
--   idioma_pdf  'es' | 'en'     (default 'es')
--
-- LA REGLA (regla de oro, finanzas-00-fundacion.sql): los importes de la cotización
-- (precio_cliente, precio_dia, items_json[].precio_unit, costo_estimado, margen_estimado)
-- SIGUEN SIEMPRE EN SOLES. Esa es la fila autoritativa que leen reservas, el generador de
-- programas, el tarifario, facturación, CRM, ELIA y liquidaciones. USD es solo cómo se
-- ENSEÑA: USD = PEN / tipo_cambio. Por eso aquí no se guarda ningún importe en dólares.
--
-- DEFAULTS QUE HACEN SEGURA LA MIGRACIÓN: toda cotización existente queda 'PEN' + 'es',
-- que es exactamente lo que ya era. Correr esto no cambia ningún PDF ni ningún número.
-- SIN BACKFILL de tipo_cambio: ninguna cotización vieja se cotizó en dólares.
--
-- SI NO SE CORRE: la app guarda sin estas columnas (las suelta por el nombre del error) y
-- el selector de dólares se ofrece deshabilitado nombrando este archivo. Todo en soles y
-- en español, como siempre.
--
-- CONSTRAINT cot_usd_con_tc: una cotización en dólares sin tipo de cambio no se puede
-- convertir a soles, así que no se puede guardar. La banda razonable (2.5–6.0, no medida)
-- la juzga la app; aquí solo se exige que sea positivo.
--
-- RLS: no se toca; las columnas heredan la política de la tabla (seguridad-01-rls.sql).
-- Bloqueo: agregar columnas con default constante no reescribe la tabla (PG11+); los
-- CHECK la recorren una vez (pocos miles de filas: segundos).
--
-- Idempotente: se puede correr dos veces. Se corre ENTERO con Run.
-- ESTA MIGRACIÓN NO LA CORRE EL DEPLOY: hay que ejecutarla en Supabase.

alter table public.cotizaciones
  add column if not exists moneda      text not null default 'PEN',
  add column if not exists tipo_cambio numeric(10,4),
  add column if not exists idioma_pdf  text not null default 'es';

alter table public.cotizaciones drop constraint if exists cot_moneda_valida;
alter table public.cotizaciones
  add constraint cot_moneda_valida check (moneda in ('PEN', 'USD'));

alter table public.cotizaciones drop constraint if exists cot_tipo_cambio_positivo;
alter table public.cotizaciones
  add constraint cot_tipo_cambio_positivo check (tipo_cambio is null or tipo_cambio > 0);

alter table public.cotizaciones drop constraint if exists cot_usd_con_tc;
alter table public.cotizaciones
  add constraint cot_usd_con_tc check (moneda = 'PEN' or tipo_cambio is not null);

alter table public.cotizaciones drop constraint if exists cot_idioma_pdf_valido;
alter table public.cotizaciones
  add constraint cot_idioma_pdf_valido check (idioma_pdf in ('es', 'en'));

comment on column public.cotizaciones.moneda is
  'Moneda de PRESENTACIÓN (PEN|USD). Los importes de la fila siguen en soles: USD = PEN / tipo_cambio.';
comment on column public.cotizaciones.tipo_cambio is
  'Soles por dólar congelado en esta cotización. Obligatorio si moneda = USD; null en PEN.';
comment on column public.cotizaciones.idioma_pdf is
  'Idioma de los textos fijos del PDF (es|en). Lo escrito por una persona se imprime tal cual.';

-- OPCIONAL · cargar a mano el tipo de cambio del día, del que la app SUGIERE (no impone)
-- el de una cotización nueva. Tabla de finanzas-00-fundacion.sql. Descomentar y editar:
-- insert into public.tipo_cambio (fecha, moneda, compra, venta, fuente)
-- values ('2026-10-16', 'USD', 0.0000, 0.0000, 'SBS')
-- on conflict (fecha, moneda) do update
--   set compra = excluded.compra, venta = excluded.venta, fuente = excluded.fuente;

-- VERIFICACIÓN (solo lee): deben salir las 3 columnas.
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'cotizaciones'
   and column_name in ('moneda', 'tipo_cambio', 'idioma_pdf')
 order by column_name;

-- FIN de cotizaciones-04-moneda-idioma.sql
