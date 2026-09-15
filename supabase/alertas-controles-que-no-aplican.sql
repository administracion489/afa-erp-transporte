-- ============================================================
-- Controles de /configuracion/operaciones que NO aplican a los avisos de ciclo de vida
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- LO QUE PASÓ, Y ES EL DEFECTO EXACTO: el dueño configuró en la tarjeta «Servicio
-- asignado» un «Antes del servicio · 900 minutos antes» y marcó a dos personas en
-- «También avisar a (directorio)». Ninguna de las dos cosas hace nada.
--
-- El bloque 1 de /api/alertas-flota/tick (asignacion · cambio · cancelacion ·
-- desasignacion) dispara cuando DETECTA el diff por reserva, y en todo ese bloque no
-- aparece `enViaRecordatorio` (que es quien lee `modo_tiempo` / `min_anticipacion`) ni
-- `aDirectorio` (quien lee `destinatarios`). Se comprueba en dos grep sobre el route.
--
-- Una pantalla que ofrece un control que el sistema no lee es peor que no ofrecerlo: no
-- falla, no avisa, y deja a alguien esperando un comportamiento que nunca va a llegar.
-- Es el mismo defecto que `multiples_recargas_en_cluster` declarado y sin emitir, o que
-- `vehiculos_tercero.capacidad_tanque` sin formulario — solo que por la puerta contraria.
--
-- Quién decide la hora en estos cuatro es el HORARIO DE ENVÍO
-- (supabase/alertas-horario-conductor.sql), no el selector «Cuándo».
-- ============================================================

-- ── 1) Columna gemela de `tiempo_editable`, para el directorio ────────────────
-- `tiempo_editable` ya existe desde canales-por-tipo.sql con esta misma semántica:
-- "false = la UI oculta el control para no prometer algo que no aplica".
-- DEFAULT TRUE: sin la migración —o en un tipo nuevo— se muestra. Ocultar por omisión
-- escondería contactos que sí están configurados y recibiendo.
alter table public.alerta_config
  add column if not exists usa_directorio boolean not null default true;

comment on column public.alerta_config.usa_directorio is
  'false = este aviso no le escribe al directorio (el motor no llama a aDirectorio para su clave) → la tarjeta oculta el selector de contactos.';

-- ── 2) Apagar los dos controles en los cuatro avisos de ciclo de vida ─────────
-- `modo_tiempo` vuelve a 'evento', que es lo que el motor hace de verdad con ellos: una
-- fila que dice 'anticipacion' mientras el sistema dispara por evento es una fila que
-- miente, y este ERP ya pagó tres veces por eso. `min_anticipacion` NO se borra: es
-- inerte de todos modos y no hay razón para destruir lo que alguien tecleó.
--
-- `destinatarios` tampoco se vacía: si algún día el bloque 1 aprendiera a escribirle al
-- directorio, la elección seguiría ahí. Lo que se retira es la PROMESA en pantalla.
update public.alerta_config
   set tiempo_editable = false,
       modo_tiempo     = 'evento',
       usa_directorio  = false,
       updated_at      = now()
 where clave in ('asignacion', 'cambio', 'cancelacion', 'desasignacion');

-- ── 3) Comprobación ───────────────────────────────────────────────────────────
-- select clave, modo_tiempo, tiempo_editable, usa_directorio, respeta_horario,
--        horario_desde, horario_hasta
--   from public.alerta_config order by tiempo_editable, clave;
--
-- Los cuatro de arriba: modo_tiempo 'evento', los dos controles en false, y su horario
-- de envío puesto. TODOS los demás conservan tiempo_editable = true y usa_directorio =
-- true — este SQL no toca ni un tipo más.
