-- ============================================================
-- ESCALERA DE INICIO · el conductor que no pulsó «Iniciar» y el «¿le llegó?»
-- Ejecutar en Supabase SQL Editor. Idempotente. (NO la corre el deploy.)
-- ============================================================
-- El caso (reserva #29812, I.C. LOGÍSTICA, 11-10-2026): el conductor hizo el servicio sin
-- abrir el app, y no había forma de saber si le habían llegado los avisos para que no se
-- olvidara. Tres huecos, y este archivo cierra la parte de la base de los tres:
--
--   1. Los avisos de inicio salían SIN el número de reserva: no quedaban en
--      `notificaciones_enviadas`. El código ya los registra con la reserva y la clave del
--      aviso; estas columnas guardan además el id del WhatsApp para casarle su estado.
--   2. El webhook de Meta descartaba los estados «entregado / leído / falló». El código ya
--      los escribe aquí (lib/entrega-whatsapp.ts), siempre que existan estas columnas.
--   3. Faltaban dos peldaños: «Inicia ahora» (5 min antes) y «Ya debió iniciar» (1 min
--      después), que corren en un cron de UN minuto (/api/alertas-flota/inicio): con el
--      tick de 10 min, una ventana de 5 min se perdía la mitad de las veces.
--
-- SIN ESTE SQL NADA SE CAE: el registro se escribe sin las columnas nuevas (y se pierde el
-- «entregado / leído»), el webhook las ignora, y los dos avisos nuevos no existen (el cron
-- no encuentra su fila y no manda nada).
-- ============================================================

-- ── 1) Registro: id del WhatsApp, clave del aviso y estado de entrega ─────────
alter table public.notificaciones_enviadas
  add column if not exists wamid          text,          -- id del mensaje en Meta
  add column if not exists alerta_clave   text,          -- alerta_config.clave del aviso
  add column if not exists entregado_en   timestamptz,   -- Meta: delivered
  add column if not exists leido_en       timestamptz,   -- Meta: read (solo si el usuario
                                                         -- tiene la confirmación encendida)
  add column if not exists fallo_entrega  text;          -- Meta: failed (código · motivo)

-- El webhook casa cada estado por el id del mensaje.
create index if not exists idx_notif_wamid
  on public.notificaciones_enviadas (wamid) where wamid is not null;
-- La línea de tiempo de /seguimiento y el resumen al coordinador leen por reserva.
create index if not exists idx_notif_reserva_creado
  on public.notificaciones_enviadas (reserva_id, created_at);

-- ── 2) Los dos peldaños nuevos ────────────────────────────────────────────────
-- SE INSERTAN ENCENDIDOS: los pidió el dueño (11-10-2026). Usan plantillas que ya existen
-- y ya salen hoy (las mismas de «Recuerda iniciar» y de «No inició»), así que no hay que
-- aprobar nada en Meta. Para apagarlos: su tarjeta en /configuracion/operaciones.
--   · inicia_ahora  → conductor_recuerda_iniciar ({{1}} nombre, {{2}} hora, {{3}} origen)
--   · debio_iniciar → conductor_no_inicio ({{1}} nombre, {{2}} hora, {{3}} ruta, {{4}} teléfono
--                      de contingencia)
-- `notifica_conductor_tercero` nace en false como el resto: avisar a personal de otra
-- empresa es una decisión comercial, y se enciende en la tarjeta.
insert into public.alerta_config
  (clave, nombre, descripcion, activo, modo_tiempo, min_anticipacion, hora_fija, umbral,
   notifica_conductor, notifica_pasajero, plantilla, plantilla_directorio)
values
  ('inicia_ahora','Inicia ahora',
   'Al conductor, minutos antes de la hora, si todavía no pulsó INICIAR en el app (WhatsApp + notificación del app)',
   true,'anticipacion',5,null,null, true,false,'conductor_recuerda_iniciar',default),
  ('debio_iniciar','Ya debió iniciar',
   'Al conductor, minutos después de la hora, si todavía no pulsó INICIAR en el app (WhatsApp + notificación del app)',
   true,'evento',null,null,1, true,false,'conductor_no_inicio',default)
on conflict (clave) do nothing;

-- Canales y controles de las dos filas. En un bloque aparte porque esas columnas vienen de
-- migraciones accesorias (canales-por-tipo.sql, alertas-controles-que-no-aplican.sql): si
-- alguna no se corrió, se salta esa parte en vez de abortar el archivo entero.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'canal_conductor_push') then
    update public.alerta_config
       set canal_conductor_whatsapp = true, canal_conductor_push = true
     where clave in ('inicia_ahora','debio_iniciar');
  end if;
  -- Ninguno de los dos le escribe al directorio: la tarjeta no ofrece contactos.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'usa_directorio') then
    update public.alerta_config set usa_directorio = false
     where clave in ('inicia_ahora','debio_iniciar');
  end if;
  -- Avisos pre-inicio: urgentes por diseño, NUNCA esperan al horario de envío.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'respeta_horario') then
    update public.alerta_config set respeta_horario = false
     where clave in ('inicia_ahora','debio_iniciar');
  end if;
end $$;

-- ── 3) (OPCIONAL) Notificación del app también en los avisos de inicio que ya existen ──
-- Enciende el canal «app» (push, estilo Uber) en los peldaños de siempre. No apaga nada
-- (el de 90 min se conserva, decisión del dueño) y no cuesta: el push es gratis y solo le
-- llega al conductor que activó las notificaciones en su app. Si prefieres decidirlo
-- tarjeta por tarjeta, NO corras este bloque.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'canal_conductor_push') then
    update public.alerta_config set canal_conductor_push = true
     where clave in ('proximo_inicio','recuerda_iniciar','no_inicio','en_punto_sin_iniciar');
  end if;
end $$;

-- ── Verificación ──────────────────────────────────────────────────────────────
-- select clave, activo, modo_tiempo, min_anticipacion, umbral, plantilla,
--        canal_conductor_whatsapp, canal_conductor_push, notifica_conductor_tercero
--   from public.alerta_config
--  where clave in ('proximo_inicio','recuerda_iniciar','inicia_ahora','debio_iniciar',
--                  'en_punto_sin_iniciar','no_inicio')
--  order by clave;
--
-- Lo que se le avisó a un conductor por un servicio (después de este SQL):
-- select created_at at time zone 'America/Lima' as hora, alerta_clave, tipo, estado,
--        entregado_en at time zone 'America/Lima' as entregado,
--        leido_en at time zone 'America/Lima' as leido, fallo_entrega, error_detalle
--   from public.notificaciones_enviadas
--  where reserva_id = 29812 and conductor_id is not null
--  order by created_at;
