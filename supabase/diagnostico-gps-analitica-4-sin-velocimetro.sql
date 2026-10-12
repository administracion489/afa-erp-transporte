-- ══ diagnostico-gps-analitica-4-sin-velocimetro.sql · SOLO LEE · HORA VALLE ═════
-- Los conductores que mandaron GPS ese día y NINGÚN punto con velocidad > 0: su teléfono
-- no reporta la velocidad del sensor (típico del navegador). Para ellos /seguridad-vial
-- dirá «no se puede juzgar», nunca «0 excesos»; se arregla en el teléfono (/gps-salud).
-- Recorre un día entero de la tabla: lleva un INTERRUPTOR que nace en `false`.
-- PARA CORRERLA: cambia `false` por `true` abajo. Pega el archivo ENTERO y Run.
with interruptor as (
  select false        as correr,   -- ← true para correrla. HORA VALLE: recorre un día entero.
         null::date   as fecha     -- ← null = ayer en Lima; o p. ej. date '2026-10-10'
),
rango as (
  select i.correr,
         coalesce(i.fecha, (now() at time zone 'America/Lima')::date - 1) as fecha
    from interruptor i
),
lim as (
  select r.correr, r.fecha,
         (r.fecha::timestamp)       at time zone 'America/Lima' as desde,
         ((r.fecha + 1)::timestamp) at time zone 'America/Lima' as hasta
    from rango r
),
por as (
  select case when g.conductor_id is not null then 'conductores' else 'conductores_tercero' end as tabla,
         coalesce(g.conductor_id, g.conductor_tercero_id)::bigint                          as conductor_id,
         count(*)                                                as puntos,
         count(*) filter (where g.velocidad > 0)                 as con_velocidad,
         count(*) filter (where g.velocidad is null)             as velocidad_nula,
         count(*) filter (where g.precision_m is null)           as precision_nula,
         count(distinct g.reserva_id)                            as servicios,
         min(g.created_at)                                       as primero,
         max(g.created_at)                                       as ultimo
    from lim l
    join public.ubicaciones_gps g
      on g.created_at >= l.desde and g.created_at < l.hasta
   where (select correr from interruptor)   -- apagado: el planificador ni abre la tabla
     and (g.conductor_id is not null or g.conductor_tercero_id is not null)
   group by 1, 2
)
select 'sin velocímetro'                                          as estado,
       p.tabla,
       p.conductor_id,
       coalesce(cp.nombre, ct.nombre)                            as nombre,
       p.puntos,
       p.velocidad_nula                                          as "velocidad nula",
       round(100.0 * p.precision_nula / p.puntos, 1)             as "% precisión nula",
       p.servicios,
       to_char(p.primero at time zone 'America/Lima', 'HH24:MI') as "primer punto (Lima)",
       to_char(p.ultimo  at time zone 'America/Lima', 'HH24:MI') as "último punto (Lima)"
  from por p
  left join public.conductores         cp on p.tabla = 'conductores'         and cp.id = p.conductor_id
  left join public.conductores_tercero ct on p.tabla = 'conductores_tercero' and ct.id = p.conductor_id
 where p.con_velocidad = 0
union all
select 'NO SE CORRIÓ: cambia false por true en la línea del interruptor (en hora valle)',
       null, null, null, null, null, null, null, null, null
  from lim
 where not lim.correr
 order by 5 desc nulls last;
-- Cómo se lee: cada fila es un conductor que ese día NO se puede juzgar. «velocidad nula»
-- distinto de 0 = el equipo ni siquiera manda el campo; todo en 0 = lo manda vacío. La
-- clave es (tabla, conductor_id): los ids de las dos tablas se solapan.
-- FIN de diagnostico-gps-analitica-4-sin-velocimetro.sql
