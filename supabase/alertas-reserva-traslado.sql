-- alertas-reserva-traslado.sql — Dos avisos al DIRECTORIO por las reservas de traslado que toma la IA del CRM:
--   reserva_sin_confirmar  una solicitud «por confirmar» o con «pago reportado» llegó a su plazo para confirmar
--                          (`confirmar_antes_de`) sin que un ejecutivo la resuelva, o nació urgente. umbral = minutos
--                          después del plazo (0 = al vencer). Vuelve a avisar si queda menos de la mitad del margen.
--   devolucion_pendiente   una devolución acordada (sin unidad o cancelación) sigue sin registrarse en `pagos` pasadas
--                          `umbral` HORAS (48) desde que se acordó.
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere alertas-operativas.sql
-- (alerta_config): si falta, se detiene nombrándolo y NO cambia nada.
-- PARTE GENERAL: las dos filas NACEN APAGADAS (activo = false), sin contactos marcados y con la plantilla de directorio
-- por defecto (coordinador_alerta, que tiene que existir APROBADA en la cuenta de avisos de Meta). Se encienden y se les
-- marcan los contactos en /configuracion/operaciones. El motor las lee en el tick (/api/alertas-flota/tick).
-- modo_tiempo = 'evento': salen cuando el tick DETECTA el caso; no leen anticipación ni hora fija (tiempo_editable = false).
-- SIN ESTA MIGRACIÓN el tick no encuentra las filas y no avisa (falta_config); nada se cae.

do $$ begin
  if to_regclass('public.alerta_config') is null then
    raise exception 'Antes de alertas-reserva-traslado hay que correr: alertas-operativas.sql';
  end if;
  -- Las claves que nacen en ESTA corrida: el bloque SOLO AFA solo enciende esas (volver a correr no reenciende).
  perform set_config('afa.alertas_reserva_nuevas', coalesce((select string_agg(c, ',') from unnest(array[
    'reserva_sin_confirmar', 'devolucion_pendiente']) c where not exists (select 1 from public.alerta_config a
    where a.clave = c)), ''), true);
end $$;

insert into public.alerta_config
  (clave, nombre, descripcion, activo, modo_tiempo, min_anticipacion, hora_fija, umbral,
   notifica_conductor, notifica_pasajero, plantilla, plantilla_directorio)
values
  ('reserva_sin_confirmar', 'Reserva de traslado sin confirmar',
   'A los contactos marcados, cuando una reserva de traslado de la IA (por confirmar disponibilidad o con pago reportado) llega a su plazo de confirmación sin que un ejecutivo la resuelva, o nace urgente.',
   false, 'evento', null, null, 0, false, false, null, default),
  ('devolucion_pendiente', 'Devolución de reserva pendiente',
   'A los contactos marcados, cuando una devolución acordada de una reserva de traslado sigue sin registrarse pasadas las horas indicadas.',
   false, 'evento', null, null, 48, false, false, null, default)
on conflict (clave) do nothing;

-- Controles de columnas accesorias (si no existen, se salta esa parte): escriben al directorio y no leen el «Cuándo».
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'usa_directorio') then
    update public.alerta_config set usa_directorio = true
     where clave = any (string_to_array(current_setting('afa.alertas_reserva_nuevas', true), ','));
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'tiempo_editable') then
    update public.alerta_config set tiempo_editable = false
     where clave in ('reserva_sin_confirmar', 'devolucion_pendiente');
  end if;
end $$;

-- Verificación (solo lee): las dos filas. Si se deja fuera el bloque SOLO AFA, es lo último que se ve.
select clave, activo, modo_tiempo, umbral, plantilla_directorio, destinatarios,
       coalesce(to_jsonb(a)->>'usa_directorio', '—') as usa_directorio, coalesce(to_jsonb(a)->>'tiempo_editable', '—') as tiempo_editable
  from public.alerta_config a where clave in ('reserva_sin_confirmar', 'devolucion_pendiente') order by clave;

-- ── SOLO AFA (otra instalación deja fuera este bloque) ──────────────────────────────────────────
-- Decisión del dueño (22-10-2026): las dos encendidas. Solo las que nacen ahora (paso 0). Sin contactos marcados en su
-- tarjeta no le llegan a nadie (la tarjeta lo pinta en ámbar): márcalos en /configuracion/operaciones. Volver atrás:
--   update public.alerta_config set activo = false where clave in ('reserva_sin_confirmar', 'devolucion_pendiente');
update public.alerta_config set activo = true
 where clave = any (string_to_array(current_setting('afa.alertas_reserva_nuevas', true), ','));
select clave, activo, case when clave = any (string_to_array(coalesce(current_setting('afa.alertas_reserva_nuevas', true), ''), ','))
         then 'encendida ahora' else 'ya existía: no se tocó' end as nota, jsonb_array_length(destinatarios) as contactos
  from public.alerta_config where clave in ('reserva_sin_confirmar', 'devolucion_pendiente') order by clave;
-- FIN de alertas-reserva-traslado.sql
