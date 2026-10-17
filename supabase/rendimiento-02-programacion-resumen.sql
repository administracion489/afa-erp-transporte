-- supabase/rendimiento-02-programacion-resumen.sql
-- /programacion: los TOTALES los suma la base y la búsqueda en el historial la hace la base.
-- Antes la pantalla descargaba TODAS las reservas (~14 consultas en paralelo de 1000 filas,
-- cada una ordenando la tabla) en cada apertura y tras cada cambio de estado: 61 251 veces,
-- 1,4 s de promedio, la consulta más cara del proyecto (caída del 16-10-2026).
-- No cambia ningún dato. Sin correrlo, la pantalla sigue funcionando como antes.
-- Se corre ENTERO con Run, en un momento tranquilo. NO LA CORRE EL DEPLOY.
set lock_timeout = '5s';

-- Índice CUBRIENTE: los totales se leen del índice (pocos KB por fila menos) sin tocar la
-- fila, que pesa ~8 KB por los JSON. Si falla por el lock_timeout, volver a correr.
create index if not exists idx_reservas_resumen
  on public.reservas (fecha_servicio)
  include (estado, estado_admin, precio_cliente, costo_proveedor, margen, sincronizado_app);

-- Totales del tablero. SECURITY INVOKER: respeta la RLS de quien llama.
create or replace function public.fn_programacion_resumen(p_hoy date, p_hasta7 date)
returns jsonb language sql stable security invoker set search_path = public as $$
  with r as (select estado, estado_admin, fecha_servicio, precio_cliente, costo_proveedor,
                    margen, sincronizado_app from public.reservas)
  select jsonb_build_object(
    'total',         (select count(*) from r),
    'por_estado',    coalesce((select jsonb_object_agg(estado, n) from
                       (select estado, count(*) n from r where estado is not null group by estado) e), '{}'::jsonb),
    'por_admin',     coalesce((select jsonb_object_agg(estado_admin, n) from
                       (select estado_admin, count(*) n from r where estado_admin is not null group by estado_admin) a), '{}'::jsonb),
    'hoy',           (select count(*) from r where fecha_servicio = p_hoy),
    'prox7d',        (select count(*) from r where fecha_servicio between p_hoy and p_hasta7
                        and estado not in ('cancelada', 'finalizada')),
    'sincronizadas', (select count(*) from r where sincronizado_app),
    'ventas',        (select coalesce(sum(precio_cliente), 0) from r),
    'costos',        (select coalesce(sum(costo_proveedor), 0) from r),
    'margen',        (select coalesce(sum(margen), 0) from r)
  );
$$;

-- Ventas/costos/margen de un rango (sin canceladas). Nulls = sin límite.
create or replace function public.fn_programacion_finanzas(p_desde date, p_hasta date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'ventas', coalesce(sum(precio_cliente), 0),
    'costos', coalesce(sum(costo_proveedor), 0),
    'margen', coalesce(sum(margen), 0))
  from public.reservas
  where estado <> 'cancelada'
    and (p_desde is null or fecha_servicio >= p_desde)
    and (p_hasta is null or fecha_servicio <= p_hasta);
$$;

-- Búsqueda en TODO el historial con la misma regla que la pantalla (lib/busqueda-texto.ts):
-- sin tildes ni mayúsculas ni signos, todas las palabras en cualquier orden, y también
-- contra el texto sin espacios (placa/código). Devuelve solo los ids, los más recientes.
create or replace function public.fn_programacion_buscar(p_terminos text[], p_limite int default 300)
returns setof bigint language sql stable security invoker set search_path = public as $$
  with t as (
    select r.id, r.fecha_servicio,
      trim(regexp_replace(lower(translate(replace(concat_ws(' ', r.codigo, r.id::text,
        c.numero_cotizacion, cl.nombre, cl.empresa, r.ruta_nombre, r.origen, r.destino), '.', ''),
        'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ', 'aeiouunAEIOUUNaeiouAEIOU')), '[^a-z0-9]+', ' ', 'g')) as txt
    from public.reservas r
    left join public.clientes cl on cl.id = r.cliente_id
    left join public.cotizaciones c on c.id = r.cotizacion_id
  )
  select id from t
  where coalesce(array_length(p_terminos, 1), 0) > 0
    and not exists (select 1 from unnest(p_terminos) w
                    where position(w in txt) = 0 and position(w in replace(txt, ' ', '')) = 0)
  order by fecha_servicio desc nulls last, id desc
  limit least(greatest(coalesce(p_limite, 300), 1), 500);
$$;

revoke all on function public.fn_programacion_resumen(date, date) from public, anon;
revoke all on function public.fn_programacion_finanzas(date, date) from public, anon;
revoke all on function public.fn_programacion_buscar(text[], int) from public, anon;
grant execute on function public.fn_programacion_resumen(date, date) to authenticated;
grant execute on function public.fn_programacion_finanzas(date, date) to authenticated;
grant execute on function public.fn_programacion_buscar(text[], int) to authenticated;

notify pgrst, 'reload schema';

-- VERIFICACIÓN (solo lee): debe devolver el total de reservas.
select public.fn_programacion_resumen(current_date, current_date + 7) ->> 'total' as total;

-- FIN de rendimiento-02-programacion-resumen.sql
