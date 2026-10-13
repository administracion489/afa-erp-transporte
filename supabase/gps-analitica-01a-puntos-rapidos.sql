-- ══ gps-analitica-01a-puntos-rapidos.sql · parte 1 de 3 · a cualquier hora ══════
-- Crea fn_gps_puntos_rapidos: los puntos GPS a ≥ umbral km/h de UN día, de toda la flota,
-- para /seguridad-vial. Solo la ejecuta el servidor (service_role), nunca anon ni el ERP.
-- EL DEPLOY NO LO CORRE: SQL Editor → pega el archivo ENTERO → Run. Idempotente.
-- No bloquea la tabla GPS: va a cualquier hora. Los índices son la parte 3 (hora valle).
-- Contrato y razones: supabase/gps-analitica-01-notas.md · «01a».
-- La última línea es «-- FIN de gps-analitica-01a-puntos-rapidos.sql».

create or replace function public.fn_gps_puntos_rapidos(
  p_desde  timestamptz,
  p_hasta  timestamptz,
  p_umbral integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  c_tope      constant integer := 60000;
begin
  if p_desde is null or p_hasta is null or p_umbral is null then
    raise exception 'fn_gps_puntos_rapidos: desde, hasta y umbral son obligatorios'
      using errcode = '22023';
  end if;
  if p_umbral < 60 or p_umbral > 130 then
    raise exception 'fn_gps_puntos_rapidos: el umbral % km/h está fuera de 60..130', p_umbral
      using errcode = '22023',
            hint = '60 es el piso del índice parcial idx_gps_rapidos; 130 es VMAX_BUS_KMH.';
  end if;
  if p_hasta <= p_desde then
    raise exception 'fn_gps_puntos_rapidos: hasta (%) tiene que ser posterior a desde (%)', p_hasta, p_desde
      using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '26 hours' then
    raise exception 'fn_gps_puntos_rapidos: el rango % excede 26 horas', p_hasta - p_desde
      using errcode = '22023',
            hint = 'Se pide un día de Lima por llamada (con su colchón); un rango mayor se parte en días.';
  end if;

  return (
    select jsonb_build_object(
             'recortado', count(*) > c_tope,
             'puntos', coalesce(
               jsonb_agg(
                 jsonb_build_array(
                   floor(extract(epoch from s.created_at) * 1000)::bigint,
                   s.lat, s.lng, s.velocidad, s.precision_m,
                   s.reserva_id, s.conductor_id, s.conductor_tercero_id,
                   s.vehiculo_id, s.vehiculo_tercero_id, s.simulado)
                 order by s.n
               ) filter (where s.n <= c_tope),
               '[]'::jsonb))
      from (
        select g.created_at, g.lat, g.lng, g.velocidad, g.precision_m,
               g.reserva_id::bigint           as reserva_id,
               g.conductor_id::bigint         as conductor_id,
               g.conductor_tercero_id::bigint as conductor_tercero_id,
               g.vehiculo_id::bigint          as vehiculo_id,
               g.vehiculo_tercero_id::bigint  as vehiculo_tercero_id,
               to_jsonb(g) -> 'simulado'      as simulado,
               row_number() over (order by g.created_at, g.id) as n
          from public.ubicaciones_gps g
         where g.velocidad >= 60              -- literal: lo que hace usable el índice parcial
           and g.velocidad >= p_umbral
           and g.created_at >= p_desde
           and g.created_at <  p_hasta
         order by g.created_at, g.id
         limit c_tope + 1                     -- uno de más: así se sabe si hubo que recortar
      ) s);
end
$fn$;

-- Solo el servidor. Se repite en cada corrida: `create or replace` conserva los permisos viejos.
revoke all on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer)
  to service_role;

comment on function public.fn_gps_puntos_rapidos(timestamptz, timestamptz, integer) is
  'Puntos GPS de toda la flota con velocidad >= umbral (60..130 km/h) en [desde, hasta) (<= 26 h), '
  'en orden (created_at, id), como {"recortado": bool, "puntos": [[epoch_ms, lat, lng, velocidad, '
  'precision_m, reserva_id, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, '
  'simulado], ...]}, tope 60000. Un solo valor para esquivar el corte de 1000 filas de PostgREST. '
  'Solo service-role (/api/flota/excesos). Migración: supabase/gps-analitica-01a-puntos-rapidos.sql.';

-- Que PostgREST vea la función sin esperar (si no, la primera llamada daría PGRST202).
notify pgrst, 'reload schema';

-- FIN de gps-analitica-01a-puntos-rapidos.sql
