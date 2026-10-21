-- ══════════════════════════════════════════════════════════════════════════════
-- RESERVAS · 08 — Confirmación de Reserva (el documento para el cliente) y su adelanto.
--
-- NO LA CORRE EL DEPLOY. Pégala entera en Supabase → SQL Editor → Run. Es idempotente.
-- Sin ella, /programacion enseña el botón «Confirmación» con un aviso que nombra este SQL y no
-- emite nada.
--
-- 1) pagos.reserva_id — EL ADELANTO DE UNA RESERVA ES UN COBRO DE `pagos`. finanzas-01 ya lo
--    dice: «un anticipo es un pago SIN aplicar». Lo que faltaba es saber de QUÉ reserva es:
--    sin esta columna el cobro existe pero ninguna pantalla puede decir cuánto se adelantó de
--    un servicio. Se escribe UNA vez, al registrarlo (Tesorería / Finanzas, desde la
--    confirmación); se aplicará a la factura cuando exista, como cualquier anticipo.
--    No duplica dinero: el monto vive en `pagos` y la confirmación lo LEE.
-- 2) reserva_confirmaciones — una FILA POR VERSIÓN emitida. `datos` es la FOTO de lo que se
--    imprimió (cliente, servicio, unidad, importes) y `firma` su huella: el PDF se vuelve a
--    dibujar desde la foto, así una descarga repetida da el MISMO documento y un cambio de
--    horario, unidad, conductor o importe emite la versión siguiente sin tocar la anterior.
--    `reserva_id` es el tramo de menor id del día (la ida y su retorno son UNA confirmación).
--    El PDF no se guarda en ningún bucket: no hay enlace público que pueda circular.
--
-- RLS SIN POLÍTICAS en reserva_confirmaciones (patrón whatsapp_tokens): la escribe y la lee solo
-- el servidor (/api/reservas/confirmacion, con el módulo «programacion»). Una política permisiva
-- sería una segunda puerta que puede contestar distinto.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1) El cobro sabe de qué reserva es.
alter table public.pagos
  add column if not exists reserva_id bigint references public.reservas(id) on delete set null;
create index if not exists idx_pagos_reserva on public.pagos (reserva_id) where reserva_id is not null;
comment on column public.pagos.reserva_id is
  'Reserva a la que corresponde el cobro (adelanto). Lo escribe Tesorería/Finanzas desde la Confirmación de Reserva.';

-- 2) Las versiones emitidas.
create table if not exists public.reserva_confirmaciones (
  id                  bigserial primary key,
  reserva_id          bigint not null references public.reservas(id) on delete cascade,
  version             int not null check (version > 0),
  codigo              text not null,
  firma               text not null,
  datos               jsonb not null,
  cambios             text[] not null default '{}',
  generado_por        uuid,
  generado_por_nombre text,
  generado_en         timestamptz not null default now(),
  unique (reserva_id, version)
);
create index if not exists idx_reserva_conf_reserva on public.reserva_confirmaciones (reserva_id, version desc);
comment on table public.reserva_confirmaciones is
  'Confirmaciones de reserva emitidas al cliente: una fila por versión, con la foto de lo impreso. Solo servidor.';

alter table public.reserva_confirmaciones enable row level security;
revoke all on public.reserva_confirmaciones from anon, authenticated;
revoke all on sequence public.reserva_confirmaciones_id_seq from anon, authenticated;

-- Verificación:
--   select column_name from information_schema.columns where table_name='pagos' and column_name='reserva_id';
--   select count(*) from public.reserva_confirmaciones;
-- FIN de reservas-08-confirmacion-reserva.sql
