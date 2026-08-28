-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 6 — CIERRE CONTABLE
--
-- Requiere: pacto-00 a pacto-04.
--
-- EL PROBLEMA QUE RESUELVE. Un servicio puede cambiar de precio o de costo DESPUÉS de
-- que su periodo ya se liquidó, se facturó o se pagó. Pasa todo el tiempo: la factura
-- del tercero llega tarde y no coincide con lo pactado, o el cliente reclama el
-- diferencial de un cambio de unidad tres semanas después.
--
-- LA REGLA: un periodo cerrado NO se reescribe. Cambiar hacia atrás un importe ya
-- facturado desalinea el ERP de lo que SUNAT ya recibió, y el Registro de Ventas deja
-- de cuadrar con la contabilidad. Lo que sí se hace —y es lo que el contador puede
-- defender— es dejar la diferencia registrada y resolverla por una de dos vías
-- legítimas:
--
--   · NOTA de crédito o débito sobre el comprobante original.
--   · LÍNEA DE AJUSTE en la liquidación del periodo siguiente.
--
-- Una tercera salida, ASUMIDO, existe para cuando la empresa decide comerse la
-- diferencia. No es un fracaso del sistema: es una decisión comercial, y queda
-- registrada como tal en vez de perderse.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) MARCAR LO QUE CAE DESPUÉS DEL CIERRE.
--
--    El trigger del acta ya guarda liquidado_cliente / liquidado_proveedor: la foto de
--    si el servicio estaba cerrado en el momento del cambio. Acá se convierte en un
--    pendiente accionable, y se congela CUÁL liquidación quedó desalineada — el dato
--    que después hace falta para emitir la nota.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_pacto_marcar_cierre()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_liq bigint;
begin
  -- Un cambio sin efecto económico no desalinea ningún cierre.
  if coalesce(new.delta, 0) = 0 then return null; end if;

  if new.lado = 'venta' and coalesce(new.liquidado_cliente, false) then
    select liquidacion_cliente_id into v_liq from public.reservas where id = new.reserva_id;
  elsif new.lado = 'compra' and coalesce(new.liquidado_proveedor, false) then
    select liquidacion_proveedor_id into v_liq from public.reservas where id = new.reserva_id;
  else
    return null;
  end if;

  update public.servicio_pacto
     set efecto_cierre = 'pendiente_regularizar',
         liquidacion_congelada_id = v_liq
   where id = new.id and efecto_cierre = 'no_aplica';
  return null;
end $$;

drop trigger if exists trg_pacto_marcar_cierre on public.servicio_pacto;
create trigger trg_pacto_marcar_cierre
  after insert on public.servicio_pacto
  for each row
  when (new.origen = 'gesto' and (new.liquidado_cliente or new.liquidado_proveedor))
  execute function public.fn_pacto_marcar_cierre();

-- ────────────────────────────────────────────────────────────────────────────
-- 2) RESOLVER LA DIFERENCIA. Tres salidas, todas explícitas y con autor.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_pacto_regularizar(
  p_pacto_id bigint,
  p_via      text,                       -- nota | periodo_siguiente | asumido
  p_nota     text default null
) returns table (ok boolean, mensaje text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_estado text; v_destino text; v_delta numeric;
begin
  select efecto_cierre, delta into v_estado, v_delta
    from public.servicio_pacto where id = p_pacto_id;

  if v_estado is null then
    ok := false; mensaje := 'Ese pacto no existe.'; return next; return;
  end if;
  if v_estado <> 'pendiente_regularizar' then
    ok := false;
    mensaje := 'Ese pacto no está pendiente de regularizar (está en "' || v_estado || '").';
    return next; return;
  end if;

  v_destino := case p_via
    when 'nota'              then 'regularizado_nota'
    when 'periodo_siguiente' then 'regularizado_periodo_siguiente'
    when 'asumido'           then 'asumido'
    else null end;

  if v_destino is null then
    ok := false; mensaje := 'Vía no válida: usa nota, periodo_siguiente o asumido.';
    return next; return;
  end if;

  -- Comerse una diferencia es una decisión comercial: tiene que quedar por escrito
  -- quién la tomó y por qué. Las otras dos vías dejan su rastro en el comprobante.
  if p_via = 'asumido' and coalesce(trim(p_nota), '') = '' then
    ok := false; mensaje := 'Para asumir la diferencia hay que explicar por qué.';
    return next; return;
  end if;

  update public.servicio_pacto
     set efecto_cierre = v_destino,
         motivo_nota = case when coalesce(trim(p_nota),'') = '' then motivo_nota
                            else coalesce(motivo_nota || ' · ', '') || trim(p_nota) end
   where id = p_pacto_id and efecto_cierre = 'pendiente_regularizar';

  ok := true;
  mensaje := case p_via
    when 'nota' then 'Marcado para nota de ' ||
                     case when coalesce(v_delta,0) > 0 then 'débito' else 'crédito' end || '.'
    when 'periodo_siguiente' then 'Irá como línea de ajuste en el periodo siguiente.'
    else 'Diferencia asumida por la empresa.' end;
  return next;
end $$;

comment on function public.fn_pacto_regularizar(bigint,text,text) is
  'Cierra una diferencia posterior al periodo. NO reescribe el importe original: un mes '
  'liquidado no se toca, se corrige por nota o por ajuste del periodo siguiente.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) LA BANDEJA DE REGULARIZACIÓN.
-- ────────────────────────────────────────────────────────────────────────────
drop view if exists public.v_regularizaciones_pendientes cascade;
create view public.v_regularizaciones_pendientes as
select v.id, v.codigo, v.reserva_id, v.os, v.fecha_servicio, v.ruta_nombre,
       v.lado, v.monto_antes, v.monto_despues, v.delta,
       v.motivo, v.motivo_nota, v.severidad, v.creado_at,
       v.liquidacion_congelada_id,
       v.proveedor_despues,
       -- Un delta POSITIVO del lado venta es más que cobrar (nota de débito al
       -- cliente); del lado compra es más que pagar (el proveedor factura de más).
       case when v.lado = 'venta' and v.delta > 0 then 'Cobrar de más al cliente'
            when v.lado = 'venta'                  then 'Devolver al cliente'
            when v.delta > 0                       then 'Pagar de más al proveedor'
            else 'Cobrar al proveedor' end as que_significa,
       case when v.delta > 0 then 'debito' else 'credito' end as tipo_nota
  from public.v_pactos_servicio v
 where v.efecto_cierre = 'pendiente_regularizar';

comment on view public.v_regularizaciones_pendientes is
  'Diferencias que aparecieron DESPUÉS de cerrar el periodo. No se corrigen hacia atrás: '
  'salen por nota de crédito/débito o como línea de ajuste del periodo siguiente.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) BACKFILL. Los cambios que ya ocurrieron sobre periodos cerrados desde que
--    corre el acta, y que nacieron antes de existir este trigger.
-- ────────────────────────────────────────────────────────────────────────────
update public.servicio_pacto p
   set efecto_cierre = 'pendiente_regularizar',
       liquidacion_congelada_id = coalesce(p.liquidacion_congelada_id, (
         select case when p.lado = 'venta' then r.liquidacion_cliente_id
                     else r.liquidacion_proveedor_id end
           from public.reservas r where r.id = p.reserva_id))
 where p.origen = 'gesto'
   and p.efecto_cierre = 'no_aplica'
   and coalesce(p.delta, 0) <> 0
   and ((p.lado = 'venta'  and coalesce(p.liquidado_cliente, false))
     or (p.lado = 'compra' and coalesce(p.liquidado_proveedor, false)));

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   select que_significa, count(*), sum(delta)
--     from public.v_regularizaciones_pendientes group by 1;
--
--   -- Resolver una:
--   select * from public.fn_pacto_regularizar(123, 'periodo_siguiente', 'Va en el cierre de setiembre');
--
-- ROLLBACK
--   drop trigger if exists trg_pacto_marcar_cierre on public.servicio_pacto;
--   drop function if exists public.fn_pacto_regularizar(bigint,text,text);
--   drop view if exists public.v_regularizaciones_pendientes;
--   update public.servicio_pacto set efecto_cierre = 'no_aplica'
--    where efecto_cierre = 'pendiente_regularizar';
-- ══════════════════════════════════════════════════════════════════════════════
