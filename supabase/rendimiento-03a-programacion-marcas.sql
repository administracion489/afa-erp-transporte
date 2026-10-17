-- rendimiento-03a · /programacion: la definición ÚNICA de cada marca del tablero.
-- Correr ANTES que rendimiento-03b. El tablero las CUENTA y la lista abre sus ids, con la
-- misma definición: el número y la lista nunca dicen cosas distintas. Periodo null = sin límite.
set lock_timeout = '5s';

create or replace function public.fn_programacion_marcas(p_desde date, p_hasta date, p_hoy date, p_ahora time)
returns table(id bigint, en_periodo boolean, es_hoy boolean, en_curso_hoy boolean, atrasado boolean,
  por_asignar boolean, sobrecupo boolean, cancelado boolean, prestado boolean, sin_cerrar boolean,
  propio boolean, sin_precio boolean, precio_en_hermano boolean, sin_costo boolean,
  precio numeric, costo numeric, margen numeric, admin text, cierre_atrasado boolean)
language sql stable security invoker set search_path = public as $$
  with b as (
    select r.*, ((p_desde is null or r.fecha_servicio >= p_desde) and (p_hasta is null or r.fecha_servicio <= p_hasta)) as per
    from reservas r
    where ((p_desde is null or r.fecha_servicio >= p_desde) and (p_hasta is null or r.fecha_servicio <= p_hasta))
       or r.fecha_servicio between p_hoy and p_hoy + 7
       or (r.fecha_servicio < p_hoy and r.estado not in ('finalizada','cancelada'))
       or (r.estado = 'finalizada' and coalesce(r.estado_admin,'por_liquidar') = 'por_liquidar')
  ), h as (
    select b.*,
      exists (select 1 from reservas x where (x.id = b.reserva_vinculada_id or x.reserva_vinculada_id = b.id)
              and x.id <> b.id and coalesce(x.precio_cliente,0) > 0) as hp,
      exists (select 1 from reservas x where (x.id = b.reserva_vinculada_id or x.reserva_vinculada_id = b.id)
              and x.id <> b.id and coalesce(x.costo_proveedor,0) > 0) as hc
    from b
  )
  select h.id::bigint, h.per,
    h.fecha_servicio = p_hoy,
    h.fecha_servicio = p_hoy and h.estado = 'en_curso',
    h.fecha_servicio = p_hoy and h.estado in ('pendiente','programada','confirmada') and h.hora_servicio is not null
      and (h.fecha_servicio + h.hora_servicio + interval '10 minutes') < (p_hoy + p_ahora),
    h.fecha_servicio between p_hoy and p_hoy + 7 and h.estado in ('pendiente','programada','confirmada')
      and (case when h.tipo_asignacion = 'tercerizado'
                then h.empresa_tercerizada_id is null or h.vehiculo_tercero_id is null
                else h.vehiculo_id is null or h.conductor_id is null end),
    h.fecha_servicio between p_hoy and p_hoy + 7 and h.estado <> 'cancelada'
      and coalesce((select o.sobrecupo from reservas_ocupacion o where o.reserva_id = h.id), false),
    h.estado = 'cancelada',
    h.estado = 'finalizada',
    h.fecha_servicio < p_hoy and h.estado not in ('finalizada','cancelada'),
    coalesce(h.tipo_asignacion,'propio') <> 'tercerizado',
    h.estado <> 'cancelada' and coalesce(h.precio_cliente,0) = 0 and not h.hp,
    h.estado <> 'cancelada' and coalesce(h.precio_cliente,0) = 0 and h.hp,
    h.estado <> 'cancelada' and h.tipo_asignacion = 'tercerizado' and coalesce(h.costo_proveedor,0) = 0 and not h.hc,
    coalesce(h.precio_cliente,0), coalesce(h.costo_proveedor,0), coalesce(h.margen,0),
    case when h.estado = 'finalizada' then coalesce(h.estado_admin,'por_liquidar') end,
    h.estado = 'finalizada' and coalesce(h.estado_admin,'por_liquidar') = 'por_liquidar'
      and p_desde is not null and h.fecha_servicio < p_desde
  from h
$$;

revoke all on function public.fn_programacion_marcas(date, date, date, time) from public, anon;
grant execute on function public.fn_programacion_marcas(date, date, date, time) to authenticated;
-- FIN de rendimiento-03a-programacion-marcas.sql
