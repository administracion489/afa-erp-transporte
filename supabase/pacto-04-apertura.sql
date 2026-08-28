-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 1 (c) — LA APERTURA
--
-- Requiere: pacto-00 a pacto-03. Correr UNA vez, después de los triggers.
--
-- EL HISTÓRICO SE CONGELA, NO SE INVENTA.
--
-- La tentación es fabricar actas retroactivas para que todo servicio tenga su
-- historia. Sería mentir: nadie sabe quién cambió qué antes de hoy, porque el ERP no
-- guardaba nada. Un acta con un autor inventado es peor que ninguna — parece evidencia
-- y no lo es.
--
-- En su lugar se siembra UN acta de apertura por servicio vivo, marcada
-- `origen='apertura'`, con antes = después y SIN autor. Eso hace la línea de corte
-- explícita: todo lo anterior queda declarado como "así estaba el día del corte, nadie
-- firma por eso"; todo lo posterior tiene autor, fecha y motivo.
--
-- Ningún reporte histórico cambia de valor: no se toca ni un importe.
--
-- Es idempotente: se puede correr de nuevo sin duplicar (el `not exists` lo impide).
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) DECLARAR EL ESTADO DEL MONTO en lo que ya existe.
--    Los triggers solo actúan sobre filas nuevas o que se modifiquen; el parque
--    actual quedaría con costo_estado NULL y ninguna vista lo vería.
-- ────────────────────────────────────────────────────────────────────────────
update public.reservas r
   set costo_estado = case
         when coalesce(r.tipo_asignacion,'') <> 'tercerizado'
              and r.empresa_tercerizada_id is null
              and r.vehiculo_tercero_id is null                  then 'no_aplica'
         when coalesce(r.costo_proveedor,0) > 0                  then 'pactado'
         -- El retorno de un par cuya IDA sí lleva tarifa NO está roto: está incluido.
         when exists (select 1 from public.reservas h
                       where h.id = r.reserva_vinculada_id
                         and coalesce(h.costo_proveedor,0) > 0)  then 'incluido'
         else 'pendiente' end,
       costo_pactado_at = case when coalesce(r.costo_proveedor,0) > 0
                               then coalesce(r.costo_pactado_at, r.fecha_servicio::timestamptz) end
 where r.costo_estado is null;

update public.reservas r
   set precio_estado = case
         when coalesce(r.precio_cliente,0) > 0                   then 'pactado'
         when exists (select 1 from public.reservas h
                       where h.id = r.reserva_vinculada_id
                         and coalesce(h.precio_cliente,0) > 0)   then 'incluido'
         else 'pendiente' end,
       precio_pactado_at = case when coalesce(r.precio_cliente,0) > 0
                                then coalesce(r.precio_pactado_at, r.fecha_servicio::timestamptz) end
 where r.precio_estado is null;

-- Servicios tercerizados ya EJECUTADOS y sin costo: el plazo venció el día siguiente
-- al servicio. Ponerles un plazo futuro los escondería de la bandeja de urgentes.
update public.reservas r
   set costo_limite_at = (r.fecha_servicio + 1)::timestamptz
 where r.costo_estado = 'pendiente' and r.costo_limite_at is null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) EL ACTA DE APERTURA. Sin folio y sin autor: no es un cambio, es una foto.
-- ────────────────────────────────────────────────────────────────────────────
insert into public.servicio_pacto
  (reserva_id, cotizacion_id, lado, origen,
   contraparte_antes_id, contraparte_despues_id, monto_antes, monto_despues,
   afectacion_despues, severidad, veredicto,
   estado_reserva, estado_admin, estado_proveedor,
   liquidado_cliente, liquidado_proveedor, creado_at)
select r.id, r.cotizacion_id, 'venta', 'apertura',
       r.cliente_id, r.cliente_id,
       coalesce(r.precio_cliente,0), coalesce(r.precio_cliente,0),
       coalesce(r.venta_afectacion, cl.afectacion_defecto, '10'), 'inicial',
       'Estado al día del corte. Anterior al Pacto del Servicio: sin autoría registrada.',
       r.estado, r.estado_admin, r.estado_proveedor,
       r.liquidacion_cliente_id is not null, r.liquidacion_proveedor_id is not null,
       coalesce(r.fecha_servicio::timestamptz, now())
  from public.reservas r
  left join public.clientes cl on cl.id = r.cliente_id
 where not exists (select 1 from public.servicio_pacto s
                    where s.reserva_id = r.id and s.lado = 'venta');

insert into public.servicio_pacto
  (reserva_id, cotizacion_id, lado, origen,
   contraparte_antes_id, contraparte_despues_id, monto_antes, monto_despues,
   afectacion_despues, severidad, veredicto,
   estado_reserva, estado_admin, estado_proveedor,
   liquidado_cliente, liquidado_proveedor, creado_at)
select r.id, r.cotizacion_id, 'compra', 'apertura',
       r.empresa_tercerizada_id, r.empresa_tercerizada_id,
       coalesce(r.costo_proveedor,0), coalesce(r.costo_proveedor,0),
       coalesce(r.compra_afectacion, et.afectacion_defecto, '10'), 'inicial',
       case when coalesce(r.costo_proveedor,0) > 0
            then 'Estado al día del corte. Anterior al Pacto: sin autoría registrada.'
            when r.costo_estado = 'incluido'
            then 'Tramo incluido en la tarifa del servicio hermano, al día del corte.'
            else 'SIN COSTO PACTADO al día del corte. Entra a la bandeja de regularización.' end,
       r.estado, r.estado_admin, r.estado_proveedor,
       r.liquidacion_cliente_id is not null, r.liquidacion_proveedor_id is not null,
       coalesce(r.fecha_servicio::timestamptz, now())
  from public.reservas r
  left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
 where (coalesce(r.tipo_asignacion,'') = 'tercerizado'
        or r.empresa_tercerizada_id is not null
        or r.vehiculo_tercero_id is not null)
   and not exists (select 1 from public.servicio_pacto s
                    where s.reserva_id = r.id and s.lado = 'compra');

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr las tres. La primera DEBE dar 0.
--
--   select count(*) as descuadres from public.v_pactos_descuadrados;
--
--   select costo_estado, count(*) from public.reservas group by 1 order by 2 desc;
--
--   -- El pasivo real, ya sin los retornos incluidos:
--   select count(*) filter (where vencido)     as urgentes,
--          count(*) filter (where not vencido) as en_plazo
--     from public.v_pacto_guardia_inventario;
--
-- ROLLBACK
--   delete from public.servicio_pacto where origen = 'apertura';
--   update public.reservas set costo_estado = null, precio_estado = null;
-- ══════════════════════════════════════════════════════════════════════════════
