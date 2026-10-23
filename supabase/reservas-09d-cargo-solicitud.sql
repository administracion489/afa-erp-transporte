-- reservas-09d-cargo-solicitud.sql — El comprobante del cargo retenido (cancelación tardía de una reserva de traslado)
-- queda atado a SU solicitud con una columna, y se puede recalcular.
-- Antes el ERP lo reconocía por un texto en facturas.observaciones y lo creaba UNA vez: si después entraba un cobro
-- (o se anulaba uno), el comprobante sin número seguía con el importe viejo. Ahora el servidor lo recalcula mientras
-- esté SIN número; uno ya emitido no se toca y la tarjeta pide la nota de crédito o débito por la diferencia.
--   · facturas.reserva_solicitud_id → reserva_solicitudes(id), con índice único parcial: UN comprobante de cargo
--     vivo por solicitud (dos cálculos a la vez no crean dos borradores). Al retirarlo (ya no se retiene nada) el ERP
--     lo deja «anulada» y suelta la columna.
--   · Solo el SERVIDOR escribe esa columna (una sesión del navegador no puede atar ni desatar un comprobante: con eso
--     el recálculo cambiaría el importe de otra factura).
--   · Se rellena desde reserva_solicitudes.factura_cargo_id (lo ya enlazado).
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente. Requiere reservas-09a.

do $$ begin
  if to_regclass('public.reserva_solicitudes') is null then
    raise exception 'Antes de reservas-09d hay que correr reservas-09a-solicitudes.sql';
  end if;
end $$;

alter table public.facturas add column if not exists reserva_solicitud_id bigint
  references public.reserva_solicitudes(id) on delete set null;
comment on column public.facturas.reserva_solicitud_id is
  'Comprobante del cargo retenido de esta solicitud de reserva de traslado (reservas-09d). Lo escribe solo el servidor.';

create unique index if not exists uq_facturas_reserva_solicitud on public.facturas (reserva_solicitud_id)
  where reserva_solicitud_id is not null;

-- Lo ya enlazado desde la solicitud (solo si la factura no está atada a otra).
update public.facturas f
   set reserva_solicitud_id = s.id
  from public.reserva_solicitudes s
 where s.factura_cargo_id = f.id
   and f.reserva_solicitud_id is null
   and not exists (select 1 from public.facturas g where g.reserva_solicitud_id = s.id);

-- Una sesión no la escribe (service-role y el SQL Editor sí). INVOKER a propósito: con DEFINER no frenaría a nadie.
create or replace function public.fn_facturas_solicitud_solo_servidor()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.reserva_solicitud_id is not null then
    raise exception 'El comprobante del cargo de una reserva lo crea el ERP: no se ata a mano.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.reserva_solicitud_id is distinct from old.reserva_solicitud_id then
    raise exception 'El comprobante del cargo de una reserva no se ata ni se desata a mano.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_facturas_solicitud_solo_servidor on public.facturas;
create trigger trg_facturas_solicitud_solo_servidor before insert or update on public.facturas
  for each row execute function public.fn_facturas_solicitud_solo_servidor();

-- Comprobación.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'facturas'
            and column_name = 'reserva_solicitud_id') as columna_ok,
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_facturas_reserva_solicitud') as indice_ok,
  (select count(*) from public.facturas where reserva_solicitud_id is not null) as cargos_atados;

-- FIN de reservas-09d-cargo-solicitud.sql
