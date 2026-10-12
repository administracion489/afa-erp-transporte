-- ══ diagnostico-gps-analitica-3-puntos-del-dia.sql · SOLO LEE · HORA VALLE ══════
-- Cuántos puntos hubo un día, cuántos con velocidad del sensor, cuántos rápidos, con qué
-- precisión y cuántos fuera de servicio: dice si el umbral de 90 km/h y la precisión de 20 m
-- van a dejar algo que juzgar. Es una LECTURA (no bloquea los INSERT de GPS), pero sin un
-- índice por created_at recorre un día entero de la tabla: por eso lleva un INTERRUPTOR.
-- Nace en `false` y no lee nada: devuelve UNA fila «NO SE CORRIÓ» con las cifras vacías
-- (nunca ceros, que se leerían como «ese día no hubo puntos»).
-- PARA CORRERLA: cambia `false` por `true` abajo (y, si quieres otro día, pon la fecha en
-- lugar de `null`). El día es de Lima; por defecto, AYER. Pega el archivo ENTERO y Run.
with interruptor as (
  select false        as correr,   -- ← true para correrla. HORA VALLE: recorre un día entero.
         null::date   as fecha     -- ← null = ayer en Lima; o p. ej. date '2026-10-10'
),
dia as (
  select i.correr,
         coalesce(i.fecha, (now() at time zone 'America/Lima')::date - 1) as fecha
    from interruptor i
),
rango as (
  select d.correr, d.fecha,
         (d.fecha::timestamp)       at time zone 'America/Lima' as desde,
         ((d.fecha + 1)::timestamp) at time zone 'America/Lima' as hasta
    from dia d
),
conteo as (
  select count(*)                                                          as puntos,
         count(*) filter (where g.velocidad > 0)                           as con_velocidad,
         count(*) filter (where g.velocidad = 0)                           as velocidad_cero,
         count(*) filter (where g.velocidad is null)                       as velocidad_nula,
         count(*) filter (where g.velocidad >= 60)                         as a_60,
         count(*) filter (where g.velocidad >= 80)                         as a_80,
         count(*) filter (where g.velocidad >= 90)                         as a_90,
         count(*) filter (where g.velocidad >= 100)                        as a_100,
         count(*) filter (where g.velocidad > 130)                         as sobre_130,
         count(*) filter (where g.precision_m is null)                     as precision_nula,
         count(*) filter (where g.precision_m > 20)                        as precision_sobre_20,
         count(*) filter (where g.velocidad >= 90
                            and (g.precision_m is null or g.precision_m > 20)) as a_90_precision_mala,
         count(*) filter (where g.reserva_id is null)                      as sin_servicio,
         count(*) filter (where g.velocidad >= 90 and g.reserva_id is null) as a_90_sin_servicio,
         count(distinct case when g.conductor_id is not null then 'p:' || g.conductor_id::text
                             when g.conductor_tercero_id is not null then 't:' || g.conductor_tercero_id::text
                        end)                                               as conductores
    from rango r
    join public.ubicaciones_gps g
      on g.created_at >= r.desde and g.created_at < r.hasta
   where (select correr from interruptor)   -- apagado: el planificador ni abre la tabla
)
select case when r.correr then 'medido'
            else 'NO SE CORRIÓ: cambia false por true en la línea del interruptor (en hora valle)' end
                                                                        as estado,
       to_char(r.fecha, 'DD/MM/YYYY')                                    as "día (Lima)",
       case when r.correr then c.puntos end                              as puntos,
       case when r.correr then c.con_velocidad end                       as "velocidad > 0",
       case when r.correr then round(100.0 * c.con_velocidad / nullif(c.puntos, 0), 1) end
                                                                        as "% con velocidad",
       case when r.correr then c.velocidad_cero end                      as "velocidad = 0",
       case when r.correr then c.velocidad_nula end                      as "velocidad nula",
       case when r.correr then c.a_60 end                                as "≥ 60",
       case when r.correr then c.a_80 end                                as "≥ 80",
       case when r.correr then c.a_90 end                                as "≥ 90",
       case when r.correr then c.a_100 end                               as "≥ 100",
       case when r.correr then c.sobre_130 end                           as "> 130 (imposibles)",
       case when r.correr then c.precision_nula end                      as "precisión nula",
       case when r.correr then c.precision_sobre_20 end                  as "precisión > 20 m",
       case when r.correr then c.a_90_precision_mala end                 as "≥ 90 con precisión nula o > 20 m",
       case when r.correr then c.sin_servicio end                        as "sin servicio (reserva_id nulo)",
       case when r.correr then c.a_90_sin_servicio end                   as "≥ 90 sin servicio",
       case when r.correr then c.conductores end                         as conductores,
       case when r.correr then c.a_60 > 60000 end                        as "umbral 60 pasaría el tope de 60 000",
       -- ~78 bytes por punto, medido sobre la salida real de fn_gps_puntos_rapidos.
       case when r.correr then round(least(c.a_60, 60000) * 78 / 1e6, 1) end
                                                                        as "MB aprox. del JSON con umbral 60"
  from rango r
  cross join conteo c;
-- Cómo se lee:
-- · «% con velocidad» bajo = muchos teléfonos sin velocímetro: sus excesos no se pueden
--   juzgar (el diagnóstico 4 dice de quién).
-- · «≥ 90 con precisión nula o > 20 m» alto = el motor descartará esos episodios como
--   «impreciso». Si es casi todo, el umbral de 20 m (heredado de ACC_CONFIABLE_M) deja la
--   pantalla sin nada que mostrar y hay que discutirlo con datos, no a ojo.
-- · «> 130» son lecturas imposibles para un bus: el motor las descarta.
-- · «≥ 90 sin servicio» = la app abierta fuera de servicio: no se le cargan a la unidad.
-- FIN de diagnostico-gps-analitica-3-puntos-del-dia.sql
