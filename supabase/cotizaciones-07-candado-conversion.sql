-- cotizaciones-07-candado-conversion.sql — Un candado para convertir una cotización en reserva UNA vez a la vez.
-- «→ Res.» (/cotizaciones) y «✅ Hay unidad» (la tarjeta de reserva del CRM) crean la ida y el retorno de la MISMA
-- cotización con la misma lógica: leen qué reservas ya tiene y crean las que faltan. Pulsados a la vez, los dos leían
-- «todavía no tiene reservas» y los dos las creaban: la reserva quedaba DUPLICADA en Programación.
--   · cotizaciones.conversion_hasta: quien convierte la toma por unos segundos (con la hora del SERVIDOR, no la del
--     navegador) y la suelta al terminar. Si la conversión muere a mitad, vence sola.
--   · fn_cotizacion_reclamar_conversion(id, segundos) → {estado: tomado | ocupado | no_tomado | no_existe, hasta}.
--     «no_tomado»: la fila se ve libre pero no se pudo escribir (otra conversión la tomó en ese mismo instante, o la
--     sesión no puede editar la cotización). En los dos casos no se crea nada.
--   · fn_cotizacion_soltar_conversion(id, hasta) → la suelta solo si sigue siendo la suya.
-- Un candado de más de 15 minutos no es de nadie (nadie lo pide tan largo): se puede volver a tomar.
-- Sin este SQL todo funciona como antes (sin candado) y la pantalla lo dice al convertir.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente.
-- SECURITY INVOKER: la usa quien ya puede editar la cotización (su RLS manda); anon no la ejecuta.

alter table public.cotizaciones add column if not exists conversion_hasta timestamptz;
comment on column public.cotizaciones.conversion_hasta is
  'Candado de «→ Res.» / «Hay unidad»: hasta cuándo alguien está creando sus reservas. NULL = libre. Lo escriben fn_cotizacion_reclamar_conversion y fn_cotizacion_soltar_conversion.';

create or replace function public.fn_cotizacion_reclamar_conversion(p_cotizacion_id bigint, p_segundos integer default 120)
returns jsonb language sql volatile security invoker set search_path = public, pg_temp as $$
  with tomado as (
    update public.cotizaciones
       set conversion_hasta = now() + make_interval(secs => least(greatest(coalesce(p_segundos, 120), 10), 600))
     where id = p_cotizacion_id
       and (conversion_hasta is null or conversion_hasta < now() or conversion_hasta > now() + interval '15 minutes')
     returning conversion_hasta
  ), actual as (
    select c.conversion_hasta from public.cotizaciones c where c.id = p_cotizacion_id
  )
  select case
    when exists (select 1 from tomado)
      then jsonb_build_object('estado', 'tomado', 'hasta', (select t.conversion_hasta from tomado t limit 1))
    when not exists (select 1 from actual)
      then jsonb_build_object('estado', 'no_existe')
    when (select a.conversion_hasta from actual a) is null
      or (select a.conversion_hasta from actual a) < now()
      or (select a.conversion_hasta from actual a) > now() + interval '15 minutes'
      then jsonb_build_object('estado', 'no_tomado')
    else jsonb_build_object('estado', 'ocupado')
  end;
$$;

create or replace function public.fn_cotizacion_soltar_conversion(p_cotizacion_id bigint, p_hasta timestamptz)
returns boolean language sql volatile security invoker set search_path = public, pg_temp as $$
  with suelto as (
    update public.cotizaciones set conversion_hasta = null
     where id = p_cotizacion_id and conversion_hasta = p_hasta
     returning 1
  )
  select exists (select 1 from suelto);
$$;

revoke all on function public.fn_cotizacion_reclamar_conversion(bigint, integer) from public, anon;
revoke all on function public.fn_cotizacion_soltar_conversion(bigint, timestamptz) from public, anon;
grant execute on function public.fn_cotizacion_reclamar_conversion(bigint, integer) to authenticated, service_role;
grant execute on function public.fn_cotizacion_soltar_conversion(bigint, timestamptz) to authenticated, service_role;

-- Comprobación: la columna y las dos funciones.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cotizaciones'
            and column_name = 'conversion_hasta') as columna_ok,
  exists (select 1 from pg_proc where proname = 'fn_cotizacion_reclamar_conversion') as reclamar_ok,
  exists (select 1 from pg_proc where proname = 'fn_cotizacion_soltar_conversion') as soltar_ok;

-- FIN de cotizaciones-07-candado-conversion.sql
