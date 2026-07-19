-- reservas-sincronizar-cliente-cotizacion.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Sincroniza el CLIENTE de cada servicio (reserva) con el de su cotización de
-- origen. Corrige de una sola pasada TODO el historial ya divergente.
--
-- CONTEXTO DEL BUG (reportado con la cotización #00238):
--   reservas.cliente_id se fija al GENERAR el servicio desde la cotización y nunca
--   se re-sincronizaba al editar la cotización. Si en /cotizaciones se cambiaba el
--   cliente, Programación seguía mostrando el cliente viejo. El fix de código en
--   app/cotizaciones/page.tsx (guardarCotizacion) evita que vuelva a pasar a futuro;
--   este script limpia lo que ya quedó desincronizado.
--
-- SEGURIDAD: NO toca servicios cancelados ni ya facturados/cobrados — cambiarles el
--   cliente rompería la traza con el comprobante SUNAT ya emitido. `is distinct from`
--   maneja NULL correctamente (una reserva con cliente_id NULL también se corrige).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) PREVISUALIZAR qué se va a corregir (córrelo primero y revisa la lista):
select r.id,
       r.cotizacion_id,
       r.cliente_id            as cliente_actual,
       c.cliente_id            as cliente_correcto,
       r.estado,
       r.estado_admin,
       r.fecha_servicio
from reservas r
join cotizaciones c on c.id = r.cotizacion_id
where r.cliente_id is distinct from c.cliente_id
  and r.estado <> 'cancelada'
  and coalesce(r.estado_admin, '') not in ('facturada', 'cobrada')
order by r.cotizacion_id, r.fecha_servicio;

-- 2) APLICAR la corrección:
update reservas r
set cliente_id = c.cliente_id
from cotizaciones c
where r.cotizacion_id = c.id
  and r.cliente_id is distinct from c.cliente_id
  and r.estado <> 'cancelada'
  and coalesce(r.estado_admin, '') not in ('facturada', 'cobrada');
