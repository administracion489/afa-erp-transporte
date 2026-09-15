-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO · FASE 6 — SE APAGA LA CONFORMIDAD POR CAMBIO DE PRECIO
--
-- Requiere: pacto-02-acta.sql y pacto-03-triggers.sql. Es idempotente.
--
-- QUÉ SE APAGA, Y QUÉ NO. Hay DOS conformidades en el ERP y solo se toca una:
--
--   · La del CIERRE DEL MES (/liquidaciones → “✉ Enviar” → /conformidad/[token]).
--     Se manda una vez por periodo, cuando el operador decide, y es la que sustenta
--     la factura. NO SE TOCA NADA DE ESA.
--
--   · La del CAMBIO DE PRECIO (/conformidad-cambio/[token]). Se emitía SOLA: cada vez
--     que a un servicio ya creado se le subía el precio, el acta de venta nacía con un
--     token y quedaba en /pactos → Conformidades esperando que alguien se lo mandara
--     al cliente. Esta es la que se apaga.
--
-- POR QUÉ. AFA cierra el mes con una sola valorización por cliente, y ahí el cliente
-- firma el importe completo. Pedirle además una firma por cada servicio que subió de
-- precio es pedirle la misma plata dos veces por dos puertas distintas: en un contrato
-- fijo con una avería a media semana eso son varios enlaces sueltos al mes, cada uno
-- por unos soles, a la misma persona que va a firmar el total en veinte días. El
-- cliente deja de abrirlos —y el día que llegue el enlace del cierre, que sí importa,
-- ya aprendió a ignorarlos.
--
-- LO QUE NO SE PIERDE, que es el motivo de apagarlo por acá y no borrando nada:
--
--   · EL ACTA DE VENTA SIGUE ESCRIBIÉNDOSE, entera. Quién subió el precio, de cuánto a
--     cuánto, cuándo, con qué motivo y con qué efecto en el margen: eso es
--     `servicio_pacto` y no depende del enlace. La trazabilidad del cambio es interna;
--     el enlace era solo el papel del cliente. Se ve igual en /pactos → Historial.
--   · Las conformidades YA FIRMADAS (conforme / observada) quedan intactas, con su
--     token, su firmante y su fecha. Son evidencia de que ese diferencial se aceptó, y
--     sostienen un cobro: borrarlas sería tirar plata ya ganada.
--
-- POR QUÉ SE APAGA CON LA POLÍTICA Y NO REESCRIBIENDO EL TRIGGER. Dos razones:
--
--   1. `fn_reservas_pacto_acta` está DUPLICADA en el repo (pacto-03-triggers.sql y el
--      parche pacto-03-fix-token-pgcrypto.sql), y desde acá no se sabe cuál quedó
--      instalada. Las dos consultan `coalesce(pol.exige_conformidad_cliente, true)`
--      antes de emitir el token, así que bajar la bandera funciona con cualquiera de
--      las dos. Una tercera copia del cuerpo de la función solo agregaría otra versión
--      que puede desincronizarse, y el propio parche documenta lo caro que salió eso.
--   2. La bandera existe justamente para esto. Dejarla en `true` mientras el código
--      ignora la conformidad sería una fila que dice una cosa y un sistema que hace
--      otra — el error que este ERP ya pagó tres veces en producción.
--
--   Consecuencia buscada: esto se revierte con un UPDATE, no con un despliegue. Si
--   algún día se quiere de vuelta, se sube la bandera y el trigger vuelve a emitir.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar.
-- ══════════════════════════════════════════════════════════════════════════════

do $$
begin
  -- Sin las migraciones del Pacto corridas no hay nada que apagar, y reventar acá
  -- dejaría al operador creyendo que le falta algo más. Se dice y se sale.
  if to_regclass('public.pacto_politica') is null then
    raise notice 'pacto_politica no existe: falta correr pacto-02-acta.sql. Nada que apagar.';
    return;
  end if;

  -- 1) Que el trigger deje de emitir tokens nuevos.
  --
  --    El `insert` es por si la fila única de política nunca se sembró: sin ella el
  --    trigger cae en el `coalesce(..., true)` y seguiría emitiendo.
  insert into public.pacto_politica (id) values (1) on conflict (id) do nothing;
  update public.pacto_politica
     set exige_conformidad_cliente = false,
         updated_at = now()
   where id = 1
     and exige_conformidad_cliente is distinct from false;

  -- 2) Retirar las que quedaron esperando firma.
  --
  --    Sin esto la bandera solo corta el caudal: /pactos → Conformidades seguiría
  --    mostrando la cola vieja con su botón de WhatsApp, que es exactamente el envío
  --    que se está quitando. Se anula el token —un enlace ya repartido deja de abrir—
  --    y el estado pasa a 'no_aplica', que es lo que la pestaña filtra.
  --
  --    SOLO las pendientes. `conforme` y `observada` no se tocan: ya las firmó alguien.
  --    Los importes del acta (monto_antes, monto_despues, delta, motivo) no se tocan
  --    NUNCA — esos son el registro del cambio, no del enlace.
  if to_regclass('public.servicio_pacto') is not null then
    update public.servicio_pacto
       set token = null,
           conformidad_estado = 'no_aplica'
     where lado = 'venta'
       and conformidad_estado = 'pendiente';
  end if;

  -- 3) Dejar dicho en el catálogo qué significa la bandera. Va con `execute` porque
  --    `comment on` suelto reventaría en la base que ni siquiera tiene la tabla, justo
  --    el caso que el guardia de arriba acaba de dejar pasar sin ruido.
  execute $c$
    comment on column public.pacto_politica.exige_conformidad_cliente is
      'Emitir el enlace de conformidad del CLIENTE cuando sube el precio de un servicio '
      'ya creado (/conformidad-cambio/[token]). AFA lo tiene en false: la firma del '
      'cliente se pide UNA vez por periodo, en la liquidación del cierre. No tiene '
      'relación con la conformidad de la liquidación, que es otro flujo y sigue activo.'
  $c$;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (pegar aparte en el SQL Editor)
--
--   -- La bandera, y cuántas quedan en cola. Debe decir false y 0.
--   select p.exige_conformidad_cliente as emite_enlaces,
--          (select count(*) from public.servicio_pacto
--            where lado = 'venta' and conformidad_estado = 'pendiente') as en_cola
--     from public.pacto_politica p where p.id = 1;
--
--   -- Las firmadas siguen ahí, con su firmante. No debe haber bajado.
--   select conformidad_estado, count(*)
--     from public.servicio_pacto
--    where lado = 'venta' and conformidad_estado in ('conforme','observada')
--    group by 1;
--
--   -- Y el acta de venta se sigue escribiendo: sube un precio y esto suma uno.
--   select count(*) from public.servicio_pacto where lado = 'venta';
-- ──────────────────────────────────────────────────────────────────────────────
