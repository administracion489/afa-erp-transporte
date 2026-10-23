-- seguridad-05-reserva-dinero.sql — Dos huecos de la reserva de traslados (auditoría S1 del 22-10-2026):
-- (1) Un cobro o una devolución YA ATADO a una reserva (reserva_id, reservas-08) o a una solicitud de reserva
--     (reserva_solicitud_id, reservas-09c) no se EDITA desde una sesión del navegador: ni monto, ni moneda, ni sentido,
--     ni fecha, ni contraparte. Los dos triggers anteriores solo frenaban las FK y `anulado`, y la política de pagos
--     (finanzas-01) deja escribir a cualquier usuario con sesión: con eso se inflaba lo «cobrado», y de ahí salen la
--     devolución que transfiere Tesorería, el cargo retenido y la Confirmación de Reserva. Se anula y se registra de
--     nuevo desde el servidor (Confirmación de Reserva o Tesorería), que entra con service-role.
-- (2) traslados_config.reserva_correo (adónde van los comprobantes de pago con datos del cliente) solo lo cambia un
--     ADMINISTRADOR. Quien tiene «tarifas» sigue editando el resto de la fila. Cubre también borrar e insertar la fila.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente. Requiere reservas-09c y traslados-09.
-- SECURITY INVOKER en los triggers a propósito: con DEFINER, current_user sería el dueño y no frenaría a nadie.

do $$ declare f text := ''; begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pagos'
                   and column_name = 'reserva_solicitud_id') then f := f || ' reservas-09c-pagos-solicitud.sql'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'traslados_config'
                   and column_name = 'reserva_correo') then f := f || ' traslados-09-reserva-ia.sql'; end if;
  if f <> '' then raise exception 'Antes de seguridad-05 hay que correr:%', f; end if;
end $$;

-- (1) Un pago atado es inmutable para una sesión (solo service-role o el SQL Editor lo tocan).
create or replace function public.fn_pagos_atados_inmutables()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (old.reserva_id is not null or old.reserva_solicitud_id is not null) and new is distinct from old then
    raise exception 'Un cobro o una devolución de una reserva no se edita: anúlalo y regístralo de nuevo desde la Confirmación de Reserva o Tesorería.'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_pagos_atados_inmutables on public.pagos;
create trigger trg_pagos_atados_inmutables before update on public.pagos
  for each row execute function public.fn_pagos_atados_inmutables();

-- (2) ¿Es administrador del ERP? DEFINER solo para leer usuarios sin depender de su RLS.
create or replace function public.fn_es_admin_erp(p_uid uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.usuarios u
                  where u.id = p_uid and u.rol = 'admin' and coalesce(u.activo, true) = true);
$$;
revoke all on function public.fn_es_admin_erp(uuid) from public, anon;
grant execute on function public.fn_es_admin_erp(uuid) to authenticated;

create or replace function public.fn_traslados_correo_solo_admin()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_cambia boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_cambia := case tg_op
    when 'INSERT' then new.reserva_correo is not null
    when 'UPDATE' then new.reserva_correo is distinct from old.reserva_correo
    else old.reserva_correo is not null end;
  if v_cambia and not public.fn_es_admin_erp(auth.uid()) then
    raise exception 'El correo que recibe los comprobantes de reserva solo lo cambia un administrador.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_traslados_correo_solo_admin on public.traslados_config;
create trigger trg_traslados_correo_solo_admin before insert or update or delete on public.traslados_config
  for each row execute function public.fn_traslados_correo_solo_admin();

-- Verificación (solo lee): los triggers nuevos y que sus funciones sean invoker (la de admin, definer).
select 'trigger' as que, tgname::text as nombre, pg_get_triggerdef(oid) as detalle from pg_trigger
 where tgname in ('trg_pagos_atados_inmutables', 'trg_traslados_correo_solo_admin') and not tgisinternal
union all select 'función', p.proname::text, case when p.prosecdef then 'security definer' else 'security invoker' end
  from pg_proc p where p.proname in ('fn_pagos_atados_inmutables', 'fn_traslados_correo_solo_admin', 'fn_es_admin_erp')
order by 1, 2;
-- FIN de seguridad-05-reserva-dinero.sql
