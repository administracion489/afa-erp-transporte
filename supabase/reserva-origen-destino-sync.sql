-- Mantener reservas.origen / reservas.destino SIEMPRE en sync con el recorrido REAL de la
-- reserva (la tabla `paradas`): origen = primera parada por orden, destino = ÚLTIMA parada por
-- orden. La última parada es el destino verdadero del servicio — incluye el último paradero de
-- RETORNO cuando corresponde, porque la propagación ya le deja a cada reserva el tramo correcto
-- (ida o retorno) en su tabla de paradas.
--
-- POR QUÉ: el conductor (y notificaciones, app pasajero, panel admin) leen las columnas crudas
-- `reservas.origen` / `reservas.destino`. Esas columnas se setean al convertir la cotización
-- (destino = cotizacion.destino, un campo libre, NO derivado de paraderos — app/cotizaciones
-- /page.tsx:1156) y SOLO se re-sincronizaban en el editor inline de programación
-- (syncOrigenDestino). El editor del MODAL "Paradas del recorrido" (GestorParadas / ModalManifiesto)
-- NO sincronizaba → la columna `destino` quedaba congelada en el valor de la cotización aunque las
-- paradas terminaran en otro lado. Caso real OS-2026-000105: el recorrido termina en "Av. Las
-- Gaviotas Mz.BLK B - Lt.4, Lima Metropolitana 15064, Perú" (último paradero de retorno) pero el
-- conductor veía "Av. Defensores del Morro Lt 17-18, Perú" (el destino viejo de la cotización).
--
-- POR QUÉ UN TRIGGER (y no parchear React): un trigger en la BD cubre TODOS los caminos de cambio
-- de paradas a la vez — modal, editor inline, reorden, propagación de cotización, importación de
-- Excel y cualquier código futuro — sin tener que tocar cada componente. Es la red de seguridad
-- definitiva contra el desfase.
--
-- ALCANCE DEL TRIGGER: se dispara solo en INSERT, DELETE y UPDATE DE (orden, nombre) — los cambios
-- que afectan cuál es la primera/última parada o su nombre. NO se dispara al actualizar `estado`
-- (p.ej. marcar "completada" durante el abordaje), para no recalcular en cada escaneo de QR.
--
-- BORRADO TOTAL: si la reserva se queda con 0 paradas, NO se tocan origen/destino (se conserva el
-- último valor conocido) — evita dejar la reserva sin dirección por una edición transitoria.

-- 1) Función de sincronización: recalcula primera/última parada de la reserva afectada.
create or replace function public.sync_reserva_origen_destino()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rid       paradas.reserva_id%type := coalesce(new.reserva_id, old.reserva_id);
  v_primera text;
  v_ultima  text;
begin
  select (array_agg(nombre order by orden asc))[1],
         (array_agg(nombre order by orden desc))[1]
    into v_primera, v_ultima
    from public.paradas
   where reserva_id = rid
     and nombre is not null and btrim(nombre) <> '';

  -- Solo actualiza si hay al menos una parada con nombre y si algo cambió (evita writes inútiles).
  if v_primera is not null then
    update public.reservas
       set origen  = v_primera,
           destino = v_ultima
     where id = rid
       and (origen is distinct from v_primera or destino is distinct from v_ultima);
  end if;

  return null; -- AFTER trigger: el valor de retorno se ignora.
end;
$$;

-- 2) Trigger: dispara en alta/baja de parada y en cambios de orden o nombre (no en `estado`).
drop trigger if exists trg_sync_reserva_od on public.paradas;
create trigger trg_sync_reserva_od
after insert or delete or update of orden, nombre on public.paradas
for each row
execute function public.sync_reserva_origen_destino();

-- 3) Backfill único: corrige TODAS las reservas que ya tienen su recorrido en `paradas`.
--    (Solo escribe las filas donde origen/destino realmente difieren del recorrido real.)
update public.reservas r
   set origen  = sub.primera,
       destino = sub.ultima
  from (
    select reserva_id,
           (array_agg(nombre order by orden asc))[1]  as primera,
           (array_agg(nombre order by orden desc))[1] as ultima
      from public.paradas
     where nombre is not null and btrim(nombre) <> ''
     group by reserva_id
  ) sub
 where r.id = sub.reserva_id
   and sub.primera is not null
   and (r.origen is distinct from sub.primera or r.destino is distinct from sub.ultima);
