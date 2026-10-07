-- ────────────────────────────────────────────────────────────────────────────
-- reservas-06-autoseleccion-por-defecto.sql — Todo servicio NACE con
-- «Permitir autoselección»; solo un operador lo desmarca.
--
-- EL CASO (06-10)
--
-- Los pasajeros ROTAN: no se sabe quién viaja cada día, así que el manifiesto
-- del retorno no se carga de antemano y cada pasajero elige su servicio en
-- /pasajero («Elige tu ruta de hoy»). Esa lista solo ofrece reservas con
-- permite_autoseleccion = true. El retorno RUTA A 17:00 (reserva 29413) nació
-- en false —ningún código escribía la columna al crear el servicio, así que
-- tomaba su default— y sus 8 pasajeros no pudieron ver el bus mientras lo
-- esperaban. Las RUTAS B y C sí salían porque alguien les había encendido la
-- casilla a mano.
--
-- QUÉ HACE ESTE ARCHIVO
--
-- El código ya escribe permite_autoseleccion = true en los cuatro caminos que
-- crean una reserva (lib/reservas-autoseleccion.ts). Este SQL es el respaldo
-- para lo que se cree fuera del código (Supabase Studio, un import):
--
--   1. Declara la columna, que no estaba en ningún SQL del repo (se creó desde
--      el panel). `if not exists`: en la base de AFA no hace nada.
--   2. Le pone default true.
--   3. Rellena con true los servicios DE HOY EN ADELANTE que estén en NULL.
--      Un NULL no lo escribió nunca un operador: los dos interruptores
--      (ModalManifiesto y el portal) siempre escriben un booleano. Encenderlo
--      es exactamente la regla: «marcado salvo que un operador lo desmarque».
--
-- LO QUE NO HACE, A PROPÓSITO
--
-- No toca los false. Un false puede ser de un operador que lo desmarcó o del
-- default viejo, y la base no guarda cuál: cambiarlos en bloque pisaría
-- decisiones de alguien. Para los servicios futuros que nacieron en false (como
-- los retornos de la RUTA A), ver la consulta de revisión al final y
-- corregirlos desde /programacion → Manifiesto → «Aplicar a rango de fechas»
-- abierto desde un RETORNO (el rango solo alcanza al mismo sentido).
--
-- El deploy NO corre este archivo: se ejecuta a mano en el SQL Editor.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.reservas
  add column if not exists permite_autoseleccion boolean;

alter table public.reservas
  alter column permite_autoseleccion set default true;

update public.reservas
   set permite_autoseleccion = true
 where permite_autoseleccion is null
   and fecha_servicio >= (now() at time zone 'America/Lima')::date;

-- ── Revisión (solo lee): servicios futuros que siguen desmarcados ───────────
-- Cada fila es un false que puede ser de un operador o del default viejo.
--
-- select r.fecha_servicio, to_char(r.hora_servicio, 'HH24:MI') as hora, r.id,
--        r.ruta_nombre, r.cotizacion_id
--   from public.reservas r
--  where r.fecha_servicio >= (now() at time zone 'America/Lima')::date
--    and r.estado <> 'cancelada'
--    and r.permite_autoseleccion = false
--  order by 1, 2;
