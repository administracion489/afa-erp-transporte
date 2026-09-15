-- ============================================================================
-- DIAGNÓSTICO · ¿POR QUÉ LA COLUMNA «MEDIDO» DE 🔧 MANTENIMIENTO NO DA UN NÚMERO?
--
-- SOLO LEE. No escribe nada, no crea nada, no hace falta correrlo para que el ERP
-- funcione. Contesta, tipo por tipo, la pregunta exacta que la pantalla contesta —
-- sirve para verlo AHORA, sin esperar al despliegue, y para cotejar que lo que dice
-- la pantalla es lo que dice la base.
--
-- Un TRAMO es el trecho entre DOS órdenes con odómetro anotado: con una sola no hay
-- tramo, y eso NO significa que falte ningún dato.
-- ============================================================================

-- ── BLOQUE 1 · Por qué cada tipo no mide, y qué le falta exactamente ──────────
with ot as (
  select m.vehiculo_id,
         m.id, m.fecha, m.kilometraje, m.costo, m.estado, m.tipo
    from mantenimiento m
   where coalesce(lower(m.estado), '') not in ('cancelado', 'cancelada')
     and m.fecha <= (now() at time zone 'America/Lima')::date
),
por_veh as (
  select v.id                                as vehiculo_id,
         v.placa,
         v.tipo_vehiculo_costeo              as tipo,
         count(o.id)                         as ots,
         count(o.id) filter (where coalesce(o.kilometraje, 0) > 0) as con_km,
         count(o.id) filter (where lower(coalesce(o.tipo, '')) = 'preventivo'
                               and coalesce(o.costo, 0) > 0)       as preventivas,
         sum(coalesce(o.costo, 0)) filter (where lower(coalesce(o.tipo, '')) = 'preventivo'
                               and coalesce(o.costo, 0) > 0)       as soles_preventivos
    from vehiculos v
    left join ot o on o.vehiculo_id = v.id
   where v.tipo_vehiculo_costeo is not null
   group by v.id, v.placa, v.tipo_vehiculo_costeo
),
-- El intervalo declarado del plan, con el override por unidad mandando sobre el del
-- plan (la misma cascada que usan /api/mantenimiento/alertas y la pestaña Programa).
inter as (
  select vp.vehiculo_id,
         min(coalesce(vp.intervalo_km_override, pm.intervalo_base_km)) as km_min,
         max(coalesce(vp.intervalo_km_override, pm.intervalo_base_km)) as km_max
    from vehiculos_plan vp
    join planes_mantenimiento pm on pm.id = vp.plan_id
   where coalesce(vp.activo, true)
     and coalesce(vp.intervalo_km_override, pm.intervalo_base_km) > 0
   group by vp.vehiculo_id
)
select p.tipo                                          as "categoría de costeo",
       p.placa,
       p.ots                                           as "OT (ocurridas, no anuladas)",
       p.con_km                                        as "con odómetro",
       case
         when p.ots = 0      then '— sin órdenes registradas'
         when p.con_km = 0   then '⚠ órdenes sin kilometraje · se teclea en /mantenimiento → Historial'
         when p.con_km = 1   then '· falta la SEGUNDA orden · no falta ningún dato, lo cierra el próximo servicio'
         else                     '✅ hay 2+ con odómetro: si aun así no mide, es que NO ENCADENAN (retrocede o el salto es imposible)'
       end                                             as "por qué no hay tramo",
       case
         when i.km_min is null      then '— sin plan enrolado: sin estimado por plan'
         when i.km_min <> i.km_max  then '— dos planes activos con intervalos distintos: no se elige ninguno'
         when p.preventivas = 0     then '— no hay órdenes preventivas con costo'
         else to_char(p.soles_preventivos / (p.preventivas * i.km_min), 'FM990.0000')
              || ' S/km SOLO PROGRAMADO (servicio cada ' || i.km_min || ' km · '
              || p.preventivas || ' preventiva(s) a S/ '
              || to_char(p.soles_preventivos / p.preventivas, 'FM999G999D00') || ')'
       end                                             as "estimado por el plan (NO proponible)"
  from por_veh p
  left join inter i on i.vehiculo_id = p.vehiculo_id
 order by p.tipo, p.placa;


-- ── BLOQUE 2 · Las órdenes CON odómetro, en el orden en que se encadenan ──────
-- Si el bloque 1 dice "2+ con odómetro" y la pantalla sigue sin medir, la respuesta
-- está aquí: la columna «salto» tiene que ser positiva y plausible (≤ 1500 km/día,
-- el mismo tope que `config_mantenimiento.km_dia_max`). La PRIMERA fila de cada
-- unidad es la cabecera y nunca aporta costo: el mantenimiento se paga DESPUÉS del
-- desgaste que lo causó, así que su tramo es anterior al registro.
select v.placa,
       v.tipo_vehiculo_costeo as "categoría",
       m.fecha,
       m.kilometraje,
       m.costo,
       m.tipo,
       m.kilometraje - lag(m.kilometraje) over (partition by m.vehiculo_id order by m.fecha, m.kilometraje) as "salto km",
       case
         when lag(m.kilometraje) over (partition by m.vehiculo_id order by m.fecha, m.kilometraje) is null
           then 'cabecera — no aporta costo'
         when m.kilometraje - lag(m.kilometraje) over (partition by m.vehiculo_id order by m.fecha, m.kilometraje) <= 0
           then '⚠ NO ENCADENA: el odómetro no avanza — hay un número mal'
         when (m.kilometraje - lag(m.kilometraje) over (partition by m.vehiculo_id order by m.fecha, m.kilometraje))
              / greatest(1, m.fecha - lag(m.fecha) over (partition by m.vehiculo_id order by m.fecha, m.kilometraje)) > 1500
           then '⚠ NO ENCADENA: más de 1500 km/día — hay un número mal'
         else '✅ tramo medible'
       end as "veredicto"
  from mantenimiento m
  join vehiculos v on v.id = m.vehiculo_id
 where coalesce(m.kilometraje, 0) > 0
   and coalesce(lower(m.estado), '') not in ('cancelado', 'cancelada')
   and m.fecha <= (now() at time zone 'America/Lima')::date
 order by v.placa, m.fecha, m.kilometraje;
