-- ============================================================
-- Tipos de alerta que el CÓDIGO espera pero que faltan en la base
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- Diagnóstico: el motor (app/api/alertas-flota/tick/route.ts) busca 16 claves en
-- `alerta_config`, pero la base solo tiene 14. Estas 4 nunca se sembraron —
-- probablemente por haber corrido una versión anterior de alertas-operativas.sql.
-- `activa(clave)` devuelve null para ellas, así que sus bloques se saltan enteros:
-- esos avisos NUNCA se han enviado y ni siquiera aparecen en /configuracion/operaciones.
--
-- SE INSERTAN DESACTIVADAS (activo = false) A PROPÓSITO.
-- Son 4 avisos que nunca han salido; encenderlos todos de golpe —y ahora que el tick
-- sí está agendado— mandaría una tanda inesperada de WhatsApp a conductores y
-- coordinadores. Aparecerán como tarjetas apagadas en el panel: enciéndelas de una en
-- una, mirando el resultado antes de seguir con la siguiente.
--
-- Valores idénticos a la semilla original de supabase/alertas-operativas.sql, salvo
-- `activo`.
-- ============================================================

insert into public.alerta_config
  (clave, nombre, descripcion, activo, modo_tiempo, min_anticipacion, hora_fija, umbral,
   notifica_conductor, notifica_pasajero, plantilla, plantilla_directorio)
values
  ('proximo_inicio','Próximo a iniciar',
   'Aviso corto y urgente justo antes del servicio',
   false,'anticipacion',90,null,null, true,false,'conductor_proximo_inicio',default),

  ('recuerda_iniciar','Recuerda iniciar recorrido',
   'Solo si aún no inició en la app; a 30 min del servicio',
   false,'anticipacion',30,null,null, true,false,'conductor_recuerda_iniciar',default),

  ('alerta_no_inicio_previa','Alerta previa al coordinador',
   'A 25 min del servicio si aún no inició el GPS/recorrido en la app',
   false,'anticipacion',25,null,null, false,false,null,'coordinador_alerta'),

  ('llamar_conductor','Recordar llamar al conductor',
   'Aviso personal 1h antes para que el coordinador llame y reporte',
   false,'anticipacion',60,null,null, false,false,null,'coordinador_llamar_conductor')
on conflict (clave) do nothing;

-- ── Verificación: deben aparecer las 16 claves ───────────────────────────────
-- select clave, activo, modo_tiempo, min_anticipacion, plantilla
--   from public.alerta_config order by clave;
--
-- Las 4 de arriba salen con activo = false. Antes de encender las que usan plantilla
-- propia (conductor_proximo_inicio, conductor_recuerda_iniciar), confirma que esas
-- plantillas existen y están APROBADAS en Meta —si no, el envío falla:
--   /configuracion/operaciones → "Textos de los mensajes" → Cargar plantillas desde Meta
