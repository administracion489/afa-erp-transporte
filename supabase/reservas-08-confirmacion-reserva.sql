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

-- 3) EL ADELANTO DE UNA RESERVA SOLO LO ESCRIBE EL SERVIDOR. La política de `pagos` (finanzas-01)
--    deja escribir a cualquier sesión del ERP, y ahora un cobro con reserva_id HABILITA la
--    confirmación: desde la consola del navegador se podría «registrar» un adelanto sin Tesorería.
--    No se cambia la política (Finanzas escribe cobros de facturas desde el navegador): se frena
--    solo lo que toca reserva_id o anula un cobro de reserva, salvo service-role o el SQL Editor.
--    SECURITY INVOKER a propósito: con DEFINER, current_user sería el dueño y no frenaría a nadie.
create or replace function public.fn_pagos_reserva_solo_servidor()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_toca boolean := false;
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    v_toca := new.reserva_id is not null;
  elsif tg_op = 'UPDATE' then
    v_toca := new.reserva_id is distinct from old.reserva_id
           or (old.reserva_id is not null and new.anulado is distinct from old.anulado);
  else
    v_toca := old.reserva_id is not null;
  end if;
  if v_toca then
    raise exception 'El adelanto de una reserva se registra desde la Confirmación de Reserva (Finanzas / Cuentas por Pagar).'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_pagos_reserva_solo_servidor on public.pagos;
create trigger trg_pagos_reserva_solo_servidor
  before insert or update or delete on public.pagos
  for each row execute function public.fn_pagos_reserva_solo_servidor();

-- Verificación:
--   select column_name from information_schema.columns where table_name='pagos' and column_name='reserva_id';
--   select count(*) from public.reserva_confirmaciones;
-- FIN de reservas-08-confirmacion-reserva.sql
