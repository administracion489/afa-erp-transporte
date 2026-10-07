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
--   4. Enciende los servicios DE HOY EN ADELANTE que nacieron en false por el
--      default viejo y que NADIE TOCÓ después. Se reconocen sin adivinar: el
--      trigger de nacimiento (pacto-03) sella `actualizado_at` al crear la fila
--      y el de estados lo vuelve a sellar en CADA update, así que una fila cuyo
--      `actualizado_at` sigue pegado a su `created_at` no la editó nadie — y
--      sin edición no hubo operador que la desmarcara. Los 10 minutos de margen
--      cubren el enlace ida↔retorno que el generador escribe segundos después de
--      crear las idas. Es el caso de los retornos RUTA A 17:00 del 06-10.
--
--   5. QUIÉN DESMARCÓ: agrega `autoseleccion_apagada_en`. Desde ahora, cada vez
--      que un OPERADOR desmarca la casilla (Manifiesto, «Aplicar a rango», el
--      portal) se guarda cuándo; al marcarla se borra. El generador de
--      programas HEREDA solo ese desmarcado: un servicio nuevo nace desmarcado
--      si el último día anterior del mismo contrato y sentido lo desmarcó un
--      operador. Un false SIN fecha (default viejo) no se hereda. Sin relleno:
--      de un false anterior no se sabe quién lo puso.
--
-- LO QUE NO HACE, A PROPÓSITO
--
-- No toca los false de filas que alguien editó después de crearlas: ese false
-- puede ser de un operador que desmarcó la casilla, o del default viejo en una
-- fila que después se reprogramó, y ahí la base ya no distingue. Para esos, la
-- consulta de revisión del final da los ids, y se corrigen con un UPDATE
-- dirigido a esos ids. NO con «Aplicar a rango»: ese botón escribe además el
-- nombre de ruta y «cambio de paradero» del servicio de referencia sobre todo
-- el rango, y renombraría servicios con otra hora.
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

-- Paso 4. Solo si existen las dos columnas de sello (pacto-02/03 y la de
-- creación): sin ellas no hay forma de probar que nadie tocó la fila, y no se
-- cambia nada.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'reservas' and column_name = 'actualizado_at')
     and exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'reservas' and column_name = 'created_at') then
    execute $u$
      update public.reservas
         set permite_autoseleccion = true
       where permite_autoseleccion = false
         and estado <> 'cancelada'
         and fecha_servicio >= (now() at time zone 'America/Lima')::date
         and created_at is not null
         and actualizado_at is not null
         and actualizado_at <= created_at + interval '10 minutes'
    $u$;
  end if;
end $$;

-- Paso 5.
alter table public.reservas
  add column if not exists autoseleccion_apagada_en timestamptz;

comment on column public.reservas.autoseleccion_apagada_en is
  'Cuándo un OPERADOR desmarcó «Permitir autoselección». NULL con permite_autoseleccion=false = valor por defecto viejo: no se hereda. En un servicio que lo heredó, es la fecha de la decisión original.';

-- ── Revisión (solo lee): servicios futuros que siguen desmarcados ───────────
-- Lo que queda después del paso 4: filas editadas después de crearse, cuyo
-- false puede ser de un operador. Si alguno debe ir encendido:
--   update public.reservas set permite_autoseleccion = true where id in (...);
--
-- select r.fecha_servicio, to_char(r.hora_servicio, 'HH24:MI') as hora, r.id,
--        r.ruta_nombre, r.cotizacion_id
--   from public.reservas r
--  where r.fecha_servicio >= (now() at time zone 'America/Lima')::date
--    and r.estado <> 'cancelada'
--    and r.permite_autoseleccion = false
--  order by 1, 2;
