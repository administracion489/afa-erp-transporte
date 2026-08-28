-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 0 — COSTEO HONESTO Y RESCATE DE LOS SERVICIOS TRABADOS
--
-- Requiere haber corrido antes: supabase/pacto-00-tributario.sql
--
-- Arregla tres cosas que hoy hacen que el tablero mienta:
--
--   (a) v_costo_servicio calcula margen_real SIN restar el costo del tercero
--       (finanzas-06-gastos-caja-chica.sql:1055-1059). Todo servicio tercerizado
--       aparece con 100 % de margen.
--   (b) La columna que debía traerlo, costo_facturado_tercero, vale 0 SIEMPRE: el
--       único insert del repo sobre documentos_compra_detalle (lib/contabilidad/
--       factura-ia.ts:242) nunca llena reserva_id. El join existe y nunca encuentra
--       nada. Se enciende desde lib/liquidaciones.ts en este mismo commit.
--   (c) Ningún importe se normaliza por afectación, así que un costo exonerado y uno
--       gravado se restan como si fueran comparables. No lo son.
--
-- Y agrega lo que el operador necesita para no volver a dejar un costo en cero:
--   · fn_costo_sugerido — el "tarifario de compra" que ya existe: tu propio historial.
--   · v_costo_tercero_huerfano — el importe de los servicios trabados que YA pagaste
--     y está en la otra punta del ERP.
--
-- Es 100 % aditivo: vistas y funciones. No crea triggers ni bloquea escrituras.
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Índices que faltaban. El primero es el que hace viable el join de la CxP con
--    el servicio; el segundo, el autocompletado del costo.
-- ────────────────────────────────────────────────────────────────────────────
create index if not exists idx_docs_compra_det_reserva
  on public.documentos_compra_detalle (reserva_id) where reserva_id is not null;

create index if not exists idx_reservas_emp_fecha
  on public.reservas (empresa_tercerizada_id, fecha_servicio desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 1) EL TARIFARIO DE COMPRA YA EXISTE: es lo que realmente pactaste.
--
--    En vez de crear una tabla de tarifas por proveedor que nadie llenaría ni
--    mantendría, se lee el historial. Prioriza misma ruta > misma unidad > mismo
--    proveedor, y solo mira costos efectivamente pactados de los últimos 6 meses.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_costo_sugerido(
  p_empresa          bigint,
  p_ruta             text default null,
  p_vehiculo_tercero bigint default null
) returns table (costo numeric, fecha date, os text, base text, dias int)
language sql stable security definer set search_path = public, pg_temp as $$
  with c as (
    select r.costo_proveedor, r.fecha_servicio, r.codigo,
           case
             when p_ruta is not null
                  and upper(coalesce(r.ruta_nombre,'')) = upper(p_ruta)  then 1
             when p_vehiculo_tercero is not null
                  and r.vehiculo_tercero_id = p_vehiculo_tercero          then 2
             else 3
           end as prio
      from public.reservas r
     where r.empresa_tercerizada_id = p_empresa
       and coalesce(r.costo_proveedor, 0) > 0
       and r.fecha_servicio >= current_date - 180
  )
  select costo_proveedor, fecha_servicio, codigo,
         case prio when 1 then 'misma ruta'
                   when 2 then 'misma unidad'
                   else 'mismo proveedor' end,
         (current_date - fecha_servicio)::int
    from c
   order by prio, fecha_servicio desc
   limit 1;
$$;

comment on function public.fn_costo_sugerido(bigint,text,bigint) is
  'Autocompleta el costo al cambiar de proveedor. Es lo único del Pacto que le AHORRA '
  'trabajo al operador: hoy ese número vive solo en la cabeza de una persona.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) v_costo_servicio — CORREGIDA.
--
--    Cuatro arreglos sobre la versión de finanzas-06:1022-1082:
--      (a) margen_real ahora SÍ resta el costo del tercero.
--      (b) Se toma el FACTURADO si existe, y si no el PACTADO. Nunca los dos: no se
--          cuenta el mismo sol dos veces (regla de oro, finanzas-00:22-24).
--      (c) Se excluyen del lateral de egresos los que ya están anclados a un
--          comprobante, o al llenarse dd.reserva_id se contarían por partida doble.
--      (d) Todo importe pasa por fn_ingreso_real / fn_costo_real: recién así el
--          margen de un servicio con proveedor exonerado es comparable con el de uno
--          con proveedor gravado.
--
--    Se mantienen TODAS las columnas de la vista anterior con el mismo nombre y en el
--    mismo orden — app/gastos/ModalCostoServicio.tsx y lib/finanzas/tipos.ts:319 la
--    leen y no deben notar el cambio. Las nuevas van al final.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_costo_servicio as
  select r.id as reserva_id, r.codigo, r.fecha_servicio, r.cliente_id, r.origen, r.destino,
         r.ruta_nombre, r.tipo_asignacion, r.vehiculo_id, r.conductor_id,
         r.empresa_tercerizada_id, r.estado, r.estado_admin, r.estado_proveedor,
         r.liquidacion_cliente_id, r.liquidacion_proveedor_id,
         r.fecha_liquidacion, r.fecha_facturacion, r.fecha_cobro,
         coalesce(r.precio_cliente, 0)::numeric   as ingreso,
         coalesce(r.costo_proveedor, 0)::numeric  as costo_proveedor_pactado,
         coalesce(e.costo_gastos, 0)              as costo_gastos,
         coalesce(e.costo_combustible, 0)         as costo_combustible,
         coalesce(e.costo_mantenimiento, 0)       as costo_mantenimiento,
         coalesce(e.costo_caja_chica, 0)          as costo_caja_chica,
         coalesce(e.costo_gastos_generales, 0)    as costo_gastos_generales,
         coalesce(cxp.costo_facturado_tercero, 0) as costo_facturado_tercero,
         -- Costo real directo, normalizado por afectación.
         (coalesce(e.costo_gastos,0) + coalesce(e.costo_combustible,0)
          + coalesce(e.costo_mantenimiento,0) + coalesce(e.costo_caja_chica,0)
          + coalesce(e.costo_gastos_generales,0)
          + t.costo_tercero_real)                 as costo_real,
         (t.ingreso_real
          - coalesce(e.costo_gastos,0) - coalesce(e.costo_combustible,0)
          - coalesce(e.costo_mantenimiento,0) - coalesce(e.costo_caja_chica,0)
          - coalesce(e.costo_gastos_generales,0)
          - t.costo_tercero_real)                 as margen_real,
         coalesce(e.n_egresos, 0)                 as egresos_registrados,
         (r.estado_admin in ('liquidada','facturada','cobrada'))        as liquidado_cliente,
         (r.estado_proveedor in ('conciliada','por_pagar','pagada'))    as liquidado_proveedor,
         -- ── Columnas nuevas (van al final: create or replace lo exige) ──
         t.venta_afectacion,
         t.compra_afectacion,
         t.ingreso_real,
         t.costo_tercero_real,
         coalesce(cxp.costo_facturado_tercero,0) - coalesce(r.costo_proveedor,0)
                                                  as delta_pactado_facturado,
         case
           when coalesce(cxp.costo_facturado_tercero,0) = 0 then 'sin_factura'
           when abs(coalesce(cxp.costo_facturado_tercero,0) - coalesce(r.costo_proveedor,0))
                <= greatest(1, coalesce(r.costo_proveedor,0) * 0.02) then 'ok'
           else 'con_diferencia'
         end                                      as estado_costo_tercero
    from public.reservas r
    -- Los maestros van ANTES de los laterales: el lateral `t` los referencia y un
    -- LATERAL solo ve lo que aparece antes que él en el FROM.
    left join public.clientes              cl on cl.id = r.cliente_id
    left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
    left join lateral (
      select sum(v.monto) filter (where v.fuente = 'gasto')         as costo_gastos,
             sum(v.monto) filter (where v.fuente = 'combustible')   as costo_combustible,
             sum(v.monto) filter (where v.fuente = 'mantenimiento') as costo_mantenimiento,
             sum(v.monto) filter (where v.fuente = 'caja_chica')    as costo_caja_chica,
             sum(v.monto) filter (where v.fuente = 'gasto_general') as costo_gastos_generales,
             count(*)                                              as n_egresos
        from public.v_egresos v
       where v.reserva_id = r.id
         and coalesce(v.estado, '') <> 'anulado'
         and v.documento_compra_id is null          -- (c) anti doble conteo
    ) e on true
    left join lateral (
      select sum(dd.subtotal) as costo_facturado_tercero
        from public.documentos_compra_detalle dd
        join public.documentos_compra dc on dc.id = dd.documento_compra_id
       where dd.reserva_id = r.id
         and coalesce(dc.estado_conciliacion, '') <> 'anulado'
    ) cxp on true
    -- (d) Normalización tributaria. Un solo lateral para no repetir los coalesce.
    left join lateral (
      select
        coalesce(r.venta_afectacion,  cl.afectacion_defecto, '10') as venta_afectacion,
        coalesce(r.compra_afectacion, et.afectacion_defecto, '10') as compra_afectacion,
        public.fn_ingreso_real(coalesce(r.precio_cliente,0),
                               coalesce(r.venta_afectacion, cl.afectacion_defecto, '10'))
                                                                   as ingreso_real,
        -- (b) El facturado manda sobre el pactado; nunca se suman.
        public.fn_costo_real(
          case when coalesce(cxp.costo_facturado_tercero,0) > 0
               then cxp.costo_facturado_tercero
               else coalesce(r.costo_proveedor,0) end,
          coalesce(r.compra_afectacion, et.afectacion_defecto, '10'),
          coalesce(et.emite_factura, true))                        as costo_tercero_real
    ) t on true
   where r.estado = 'finalizada';

comment on view public.v_costo_servicio is
  'Ingreso vs costo real por servicio. margen_real ahora SÍ resta el tercero y todo pasa '
  'por la normalización tributaria: sin eso, comparar un proveedor gravado con uno '
  'exonerado se equivoca hasta en 30 %.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) LOS SERVICIOS TRABADOS — dónde está el importe que falta.
--
--    Muchos de los 67 que /liquidaciones marca "Sin costo de proveedor" YA se pagaron:
--    el dato está en la factura de compra o en el gasto de pago a tercero, en la otra
--    punta del ERP, y nadie lo fue a buscar. Esta vista lo propone.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_costo_tercero_huerfano as
select r.id as reserva_id, r.codigo as os, r.fecha_servicio, r.empresa_tercerizada_id,
       et.razon_social as proveedor,
       dc.id as origen_id, dc.total as importe_propuesto,
       'CxP ' || coalesce(dc.serie,'') || '-' || coalesce(dc.numero,'') as fuente,
       dc.fecha_emision as fuente_fecha
  from public.reservas r
  join public.documentos_compra dc
    on dc.empresa_tercerizada_id = r.empresa_tercerizada_id
   and dc.fecha_emision between r.fecha_servicio - 15 and r.fecha_servicio + 45
  left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
 where coalesce(r.costo_proveedor, 0) = 0
   and r.liquidacion_proveedor_id is null
   and coalesce(dc.estado_conciliacion,'') <> 'anulado'
   -- Un retorno cuya ida ya lleva la tarifa NO necesita importe: está incluido.
   and not exists (select 1 from public.reservas h
                    where h.id = r.reserva_vinculada_id and coalesce(h.costo_proveedor,0) > 0)
union all
select r.id, r.codigo, r.fecha_servicio, r.empresa_tercerizada_id,
       et.razon_social,
       g.id, g.monto, 'Gasto pago a tercero', g.fecha
  from public.reservas r
  join public.gastos g on g.reserva_id = r.id
  left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
 where coalesce(r.costo_proveedor, 0) = 0
   and r.liquidacion_proveedor_id is null
   and lower(coalesce(g.categoria,'')) in ('pago_tercero','tercero','tercerizado');

comment on view public.v_costo_tercero_huerfano is
  'Servicios sin costo pactado cuyo importe probablemente YA existe en el ERP. Es una '
  'PROPUESTA, no una verdad: la cruza por proveedor y ventana de fecha, así que un humano '
  'confirma antes de escribirla. Dos servicios del mismo proveedor el mismo día son la '
  'norma en transporte, no la excepción — por eso NUNCA la uses sin pasar por '
  'v_costo_tercero_propuesta, que descarta los cruces ambiguos.';

-- Una FACTURA que calza con varios servicios no dice el costo de ninguno: dice el total
-- de todos. Aceptarla en cada uno multiplicaría el costo por el número de servicios.
-- Esta vista es la que debe consumir la UI: solo deja pasar los cruces 1 a 1.
create or replace view public.v_costo_tercero_propuesta as
with cruces as (
  select h.*,
         count(*) over (partition by h.reserva_id)             as candidatas_del_servicio,
         count(*) over (partition by h.fuente, h.origen_id)    as servicios_de_la_fuente
    from public.v_costo_tercero_huerfano h
)
select reserva_id, os, fecha_servicio, empresa_tercerizada_id, proveedor,
       origen_id, importe_propuesto, fuente, fuente_fecha
  from cruces
 where candidatas_del_servicio = 1     -- el servicio calza con UN solo comprobante
   and servicios_de_la_fuente   = 1;   -- y ese comprobante calza con UN solo servicio

comment on view public.v_costo_tercero_propuesta is
  'Los cruces inequívocos: un servicio ↔ un comprobante. Es lo único que se puede '
  'proponer con un clic. Todo lo demás lo decide una persona mirando el detalle.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) LA BANDEJA — todo servicio tercerizado sin costo, con su urgencia.
--    Se deriva de reservas, no de un registro de cambios: así ve TODOS los rotos,
--    los haya tocado alguien o no.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_servicios_sin_costo as
select r.id as reserva_id, r.codigo as os, r.fecha_servicio, r.hora_servicio,
       r.direccion_servicio, r.ruta_nombre, r.estado, r.estado_proveedor,
       r.cotizacion_id, r.reserva_vinculada_id,
       r.empresa_tercerizada_id, et.razon_social as proveedor,
       vt.placa,
       (r.fecha_servicio - current_date) as dias_al_servicio,
       case when r.fecha_servicio <  current_date then 'ejecutado_sin_costo'
            when r.fecha_servicio =  current_date then 'hoy'
            else 'futuro' end as urgencia,
       -- El retorno de un par cuya IDA sí tiene tarifa NO está roto: está incluido.
       exists (
         select 1 from public.reservas h
          where h.id = r.reserva_vinculada_id
            and coalesce(h.costo_proveedor,0) > 0
       ) as cubierto_por_par,
       (select count(*) from public.v_costo_tercero_huerfano h where h.reserva_id = r.id)
         as propuestas_de_importe
  from public.reservas r
  left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
  left join public.vehiculos_tercero     vt on vt.id = r.vehiculo_tercero_id
 where coalesce(r.costo_proveedor, 0) = 0
   and (coalesce(r.tipo_asignacion,'') = 'tercerizado'
        or r.empresa_tercerizada_id is not null
        or r.vehiculo_tercero_id is not null)
   and coalesce(r.estado,'') <> 'cancelada'
   and r.liquidacion_proveedor_id is null;

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   -- ¿Cuántos servicios trabados hay de verdad, descontando los retornos incluidos?
--   select urgencia, count(*) filter (where not cubierto_por_par) as reales,
--          count(*) as lineas_rojas
--     from public.v_servicios_sin_costo group by urgencia order by 1;
--
--   -- ¿A cuántos ya les podemos proponer el importe?
--   select count(distinct reserva_id) from public.v_costo_tercero_huerfano;
--
--   -- El margen ya no miente:
--   select codigo, ingreso, ingreso_real, costo_proveedor_pactado, costo_tercero_real,
--          margen_real, estado_costo_tercero
--     from public.v_costo_servicio
--    where empresa_tercerizada_id is not null
--    order by fecha_servicio desc limit 20;
--
-- ROLLBACK
--   -- v_costo_servicio: volver a correr el bloque 7 de finanzas-06-gastos-caja-chica.sql
--   drop view if exists public.v_servicios_sin_costo;
--   drop view if exists public.v_costo_tercero_huerfano;
--   drop function if exists public.fn_costo_sugerido(bigint,text,bigint);
-- ══════════════════════════════════════════════════════════════════════════════
