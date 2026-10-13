-- ══ gps-analitica-01b-velocimetro.sql · parte 2 de 3 · a cualquier hora ═════════
-- Crea fn_gps_velocimetro: por conductor, ¿mandó GPS? ¿alguno con velocidad > 0? Separa
-- «0 excesos» de «su teléfono no reporta velocidad: no se puede juzgar». Solo el servidor.
-- EL DEPLOY NO LO CORRE: SQL Editor → pega el archivo ENTERO → Run. Idempotente.
-- No bloquea la tabla GPS: va a cualquier hora. Los índices son la parte 3 (hora valle).
-- Contrato y razones: supabase/gps-analitica-01-notas.md · «01b».
-- La última línea es «-- FIN de gps-analitica-01b-velocimetro.sql».

create or replace function public.fn_gps_velocimetro(
  p_desde    timestamptz,
  p_hasta    timestamptz,
  p_propios  bigint[],
  p_terceros bigint[]
)
returns table(tabla text, conductor_id bigint, hay_puntos boolean, hay_velocidad boolean)
language plpgsql
stable
security invoker
set search_path = public
as $fn$
#variable_conflict use_column
begin
  if p_desde is null or p_hasta is null then
    raise exception 'fn_gps_velocimetro: desde y hasta son obligatorios'
      using errcode = '22023';
  end if;
  if p_hasta <= p_desde then
    raise exception 'fn_gps_velocimetro: hasta (%) tiene que ser posterior a desde (%)', p_hasta, p_desde
      using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '8 days' then
    raise exception 'fn_gps_velocimetro: el rango % excede 8 días', p_hasta - p_desde
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_propios), 0) > 300 or coalesce(cardinality(p_terceros), 0) > 300 then
    raise exception 'fn_gps_velocimetro: como mucho 300 conductores por arreglo (llegaron % propios y % terceros)',
                    coalesce(cardinality(p_propios), 0), coalesce(cardinality(p_terceros), 0)
      using errcode = '22023';
  end if;

  -- Todo calificado: `conductor_id` es columna de ubicaciones_gps y columna de salida.
  return query
  select x.tabla, x.cid, x.hp,
         case when x.hp then
           case x.tabla
             when 'conductores' then exists (
               select 1 from public.ubicaciones_gps g
                where g.conductor_id = x.cid
                  and g.created_at >= p_desde and g.created_at < p_hasta
                  and g.velocidad > 0)
             else exists (
               select 1 from public.ubicaciones_gps g
                where g.conductor_tercero_id = x.cid
                  and g.created_at >= p_desde and g.created_at < p_hasta
                  and g.velocidad > 0)
           end
         end
    from (
      select 'conductores'::text as tabla, u.cid,
             exists (select 1 from public.ubicaciones_gps g
                      where g.conductor_id = u.cid
                        and g.created_at >= p_desde and g.created_at < p_hasta) as hp
        from (select distinct a.v as cid
                from unnest(coalesce(p_propios, '{}'::bigint[])) as a(v)
               where a.v is not null) u
      union all
      select 'conductores_tercero'::text, u.cid,
             exists (select 1 from public.ubicaciones_gps g
                      where g.conductor_tercero_id = u.cid
                        and g.created_at >= p_desde and g.created_at < p_hasta)
        from (select distinct a.v as cid
                from unnest(coalesce(p_terceros, '{}'::bigint[])) as a(v)
               where a.v is not null) u
    ) x
   order by 1, 2;
end
$fn$;

-- Solo el servidor. Se repite en cada corrida: `create or replace` conserva los permisos viejos.
revoke all on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[])
  to service_role;

comment on function public.fn_gps_velocimetro(timestamptz, timestamptz, bigint[], bigint[]) is
  'Por conductor (tabla = conductores | conductores_tercero): hay_puntos = mandó GPS en [desde, hasta) '
  '(<= 8 días); hay_velocidad = alguno con velocidad > 0, NULL si no hubo puntos. <= 300 ids por '
  'arreglo. Solo service-role. Migración: supabase/gps-analitica-01b-velocimetro.sql.';

notify pgrst, 'reload schema';

-- FIN de gps-analitica-01b-velocimetro.sql
