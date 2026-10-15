-- reservas-07-despacho-sin-cotizar.sql
-- QUE HACE: agrega a reservas dos columnas para marcar un servicio creado en
-- /despachador (origen_despacho) sin cotizacion_id como "no requiere cotizacion",
-- con su motivo y la hora en que se marco, mas un indice parcial para listarlos.
-- POR QUE: hoy todo servicio de despacho sin cotizacion cuenta como "sin cotizar",
-- aunque una persona ya haya decidido que no la necesita.
-- SI NO SE CORRE: la app funciona igual; no se puede guardar la marca (el guardado
-- suelta estas columnas y lo avisa) y todos siguen contando como "sin cotizar".
-- Idempotente. Sin default ni backfill: la marca la afirma una persona.
-- NO LA CORRE EL DEPLOY: hay que ejecutarla en Supabase (SQL Editor, Run).

alter table public.reservas
  add column if not exists cotizacion_no_requerida_motivo text;

alter table public.reservas
  add column if not exists cotizacion_no_requerida_en timestamptz;

comment on column public.reservas.cotizacion_no_requerida_motivo is
  'Motivo escrito por una persona: este servicio de despacho no requiere cotizacion. Null = no se marco.';
comment on column public.reservas.cotizacion_no_requerida_en is
  'Cuando se marco como no requiere cotizacion.';

-- origen_despacho no esta declarado en ningun SQL del repo: "is true" no depende
-- de que sea boolean NOT NULL.
create index if not exists idx_reservas_despacho_sin_cot
  on public.reservas (fecha_servicio, id)
  where origen_despacho is true and cotizacion_id is null;

-- Sin cambios de RLS: reservas ya tiene sus politicas.

-- Verificacion (solo lee):
-- select column_name, data_type from information_schema.columns
--  where table_name = 'reservas' and column_name like 'cotizacion_no_requerida%';
-- Diagnostico:
-- select estado, fecha_servicio, count(*) from reservas
--  where origen_despacho is true and cotizacion_id is null
--  group by 1,2 order by 2;

-- FIN de reservas-07-despacho-sin-cotizar.sql
