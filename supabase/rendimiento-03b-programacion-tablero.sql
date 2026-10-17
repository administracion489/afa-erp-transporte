-- rendimiento-03b · /programacion: el tablero (HOY · PERIODO · DINERO · CIERRE) y los ids
-- de cada marca para filtrar la lista. Requiere rendimiento-03a. ~40 ms sobre 13 700 reservas.
set lock_timeout = '5s';

create or replace function public.fn_programacion_tablero(p_desde date, p_hasta date, p_hoy date, p_ahora time)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'hoy', count(*) filter (where es_hoy and not cancelado),
    'en_curso', count(*) filter (where en_curso_hoy),
    'atrasados', count(*) filter (where atrasado),
    'por_asignar', count(*) filter (where por_asignar),
    'sobrecupo', count(*) filter (where sobrecupo),
    'sin_cerrar_total', count(*) filter (where sin_cerrar),
    'servicios', count(*) filter (where en_periodo and not cancelado),
    'prestados', count(*) filter (where en_periodo and prestado),
    'cancelados', count(*) filter (where en_periodo and cancelado),
    'sin_cerrar', count(*) filter (where en_periodo and sin_cerrar),
    'propios', count(*) filter (where en_periodo and not cancelado and propio),
    'tercerizados', count(*) filter (where en_periodo and not cancelado and not propio),
    'ventas', coalesce(sum(precio) filter (where en_periodo and not cancelado), 0),
    'costos', coalesce(sum(costo) filter (where en_periodo and not cancelado), 0),
    'margen', coalesce(sum(margen) filter (where en_periodo and not cancelado), 0),
    'con_precio', count(*) filter (where en_periodo and not cancelado and precio > 0),
    'sin_precio', count(*) filter (where en_periodo and sin_precio),
    'sin_precio_costo', coalesce(sum(costo) filter (where en_periodo and sin_precio), 0),
    'precio_en_hermano', count(*) filter (where en_periodo and precio_en_hermano),
    'sin_costo', count(*) filter (where en_periodo and sin_costo),
    'cierre', jsonb_build_object(
      'por_liquidar', jsonb_build_array(count(*) filter (where en_periodo and admin = 'por_liquidar'), coalesce(sum(precio) filter (where en_periodo and admin = 'por_liquidar'), 0)),
      'liquidada',    jsonb_build_array(count(*) filter (where en_periodo and admin = 'liquidada'),    coalesce(sum(precio) filter (where en_periodo and admin = 'liquidada'), 0)),
      'facturada',    jsonb_build_array(count(*) filter (where en_periodo and admin = 'facturada'),    coalesce(sum(precio) filter (where en_periodo and admin = 'facturada'), 0)),
      'cobrada',      jsonb_build_array(count(*) filter (where en_periodo and admin = 'cobrada'),      coalesce(sum(precio) filter (where en_periodo and admin = 'cobrada'), 0))),
    'cierre_atrasado', jsonb_build_array(count(*) filter (where cierre_atrasado), coalesce(sum(precio) filter (where cierre_atrasado), 0)))
  from public.fn_programacion_marcas(p_desde, p_hasta, p_hoy, p_ahora)
$$;

create or replace function public.fn_programacion_tablero_ids(p_marca text, p_desde date, p_hasta date, p_hoy date, p_ahora time)
returns setof bigint language sql stable security invoker set search_path = public as $$
  select id from public.fn_programacion_marcas(p_desde, p_hasta, p_hoy, p_ahora) where case p_marca
    when 'hoy' then es_hoy and not cancelado   when 'en_curso' then en_curso_hoy
    when 'atrasados' then atrasado             when 'por_asignar' then por_asignar
    when 'sobrecupo' then sobrecupo            when 'sin_cerrar_total' then sin_cerrar
    when 'servicios' then en_periodo and not cancelado  when 'prestados' then en_periodo and prestado
    when 'cancelados' then en_periodo and cancelado     when 'sin_cerrar' then en_periodo and sin_cerrar
    when 'sin_precio' then en_periodo and sin_precio    when 'sin_costo' then en_periodo and sin_costo
    when 'cierre_atrasado' then cierre_atrasado
    when 'por_liquidar' then en_periodo and admin = 'por_liquidar'  when 'liquidada' then en_periodo and admin = 'liquidada'
    when 'facturada' then en_periodo and admin = 'facturada'        when 'cobrada' then en_periodo and admin = 'cobrada'
    else false end
  limit 3000
$$;

revoke all on function public.fn_programacion_tablero(date, date, date, time) from public, anon;
revoke all on function public.fn_programacion_tablero_ids(text, date, date, date, time) from public, anon;
grant execute on function public.fn_programacion_tablero(date, date, date, time) to authenticated;
grant execute on function public.fn_programacion_tablero_ids(text, date, date, date, time) to authenticated;
notify pgrst, 'reload schema';

select public.fn_programacion_tablero(date_trunc('month', now() at time zone 'America/Lima')::date,
  (now() at time zone 'America/Lima')::date, (now() at time zone 'America/Lima')::date,
  (now() at time zone 'America/Lima')::time) as prueba;
-- FIN de rendimiento-03b-programacion-tablero.sql
