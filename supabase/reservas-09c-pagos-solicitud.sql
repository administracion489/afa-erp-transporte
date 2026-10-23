-- reservas-09c-pagos-solicitud.sql — El cobro (adelanto) y la devolución de una solicitud de reserva de traslado
-- (reservas-09a) son filas de `pagos` que saben de QUÉ solicitud son: pagos.reserva_solicitud_id.
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere
-- reservas-08-confirmacion-reserva.sql y reservas-09a-solicitudes.sql: si falta una, se detiene nombrándola y NO cambia
-- nada. SIN ELLA Tesorería no puede registrar el adelanto ni la devolución de una solicitud (la pantalla lo dice) y lo
-- cobrado no se puede atar a la solicitud antes de que exista la reserva.
-- REGLA DE ORO: el dinero vive en `pagos` (sentido cobro = adelanto recibido; sentido pago = devolución al cliente) y la
-- solicitud lo LEE: cobrado, devuelto y devolución pendiente se derivan sumando estas filas, no se guardan. Un cobro con
-- reserva sigue llevando además pagos.reserva_id (reservas-08): son dos FK, cada una con su trigger.
-- SOLO EL SERVIDOR escribe esta columna: misma regla que fn_pagos_reserva_solo_servidor (reservas-08) aplicada a
-- reserva_solicitud_id, en una función y un trigger APARTE (aquella NO se reescribe: dos copias de su cuerpo
-- terminarían distintas). SECURITY INVOKER a propósito: con DEFINER, current_user sería el dueño y no frenaría a nadie.
-- Bloqueo: columna nullable sin default sobre `pagos` (no reescribe la tabla) e índice parcial que nace vacío.

do $$ declare f text := ''; begin
  if to_regprocedure('public.fn_pagos_reserva_solo_servidor()') is null or not exists (select 1
       from information_schema.columns where table_schema = 'public' and table_name = 'pagos' and column_name = 'reserva_id')
    then f := f || ' reservas-08-confirmacion-reserva.sql'; end if;
  if to_regclass('public.reserva_solicitudes') is null then f := f || ' reservas-09a-solicitudes.sql'; end if;
  if f <> '' then raise exception 'Antes de reservas-09c hay que correr:%', f; end if;
end $$;

alter table public.pagos
  add column if not exists reserva_solicitud_id bigint references public.reserva_solicitudes(id) on delete set null;
create index if not exists idx_pagos_reserva_solicitud on public.pagos (reserva_solicitud_id)
  where reserva_solicitud_id is not null;
comment on column public.pagos.reserva_solicitud_id is
  'Solicitud de reserva de traslado del cobro (adelanto) o de la devolución. La escribe solo el servidor (Tesorería / Finanzas).';

-- Se frena lo que toca reserva_solicitud_id, o anula un pago que la tiene, salvo service-role o el SQL Editor.
create or replace function public.fn_pagos_solicitud_solo_servidor()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_toca boolean := false;
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    v_toca := new.reserva_solicitud_id is not null;
  elsif tg_op = 'UPDATE' then
    v_toca := new.reserva_solicitud_id is distinct from old.reserva_solicitud_id
           or (old.reserva_solicitud_id is not null and new.anulado is distinct from old.anulado);
  else
    v_toca := old.reserva_solicitud_id is not null;
  end if;
  if v_toca then
    raise exception 'El adelanto o la devolución de una reserva de traslado se registra desde la solicitud de reserva (Tesorería / Finanzas).'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_pagos_solicitud_solo_servidor on public.pagos;
create trigger trg_pagos_solicitud_solo_servidor
  before insert or update or delete on public.pagos
  for each row execute function public.fn_pagos_solicitud_solo_servidor();

-- Verificación (solo lee): la columna con su FK e índice, y los DOS triggers de solo-servidor sobre pagos.
select 'columna' as que, 'pagos.reserva_solicitud_id' as nombre, data_type || ' · nullable ' || is_nullable as detalle
  from information_schema.columns where table_schema = 'public' and table_name = 'pagos' and column_name = 'reserva_solicitud_id'
union all select 'FK', conname::text, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.pagos'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%reserva_solicitudes%'
union all select 'índice', indexname::text, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'pagos' and indexname = 'idx_pagos_reserva_solicitud'
union all select 'trigger', tgname::text, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.pagos'::regclass and not tgisinternal and tgname like '%solo_servidor'
union all select 'función', p.proname::text, case when p.prosecdef then 'SECURITY DEFINER (MAL)' else 'security invoker' end
  from pg_proc p where p.proname in ('fn_pagos_reserva_solo_servidor', 'fn_pagos_solicitud_solo_servidor')
order by 1, 2;
-- FIN de reservas-09c-pagos-solicitud.sql
