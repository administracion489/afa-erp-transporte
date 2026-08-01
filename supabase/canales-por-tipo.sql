-- ============================================================
-- Canal por TIPO de mensaje (WhatsApp / Email / Push)
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- Antes: el canal NO era configurable. Al conductor todo salía por WhatsApp a la
-- fuerza, y al pasajero lo gobernaba un bloque GLOBAL (config_canales, fila única
-- id=1) que además solo aplicaba a un tipo de mensaje.
--
-- Ahora: cada TIPO de mensaje (fila de alerta_config) elige sus propios canales.
--
-- Por qué en alerta_config y no en config_canales: config_canales tiene
--   `constraint config_canales_unica check (id = 1)` (alertas-operativas.sql:142)
-- → NO admite una fila por tipo. alerta_config YA es una fila por tipo.
--
-- config_canales NO se borra: queda como FALLBACK de solo lectura para que un
-- despliegue a medias (SQL corrido sin código nuevo, o al revés) no silencie los
-- avisos al pasajero en producción.
-- ============================================================

-- ── 0) Marca de migraciones (para backfills one-shot idempotentes) ────────────
create table if not exists public.migracion_marca (
  clave       text primary key,
  aplicada_at timestamptz not null default now()
);
alter table public.migracion_marca enable row level security;
-- Sin policies a propósito → solo service_role / SQL Editor.

-- ── 1) Columnas de canal por tipo ─────────────────────────────────────────────
-- Conductor: los 3 canales son independientes. NO se replica "solo si no tiene la
--   app" porque el push del conductor sale de la MISMA app que ya usa para el GPS:
--   no es un sustituto del WhatsApp, es un canal extra.
-- Pasajero: se replica la semántica EXACTA de config_canales, incluido
--   "solo_sin_app" (= mandar ese canal solo si el push NO se entregó).
--
-- DEFAULTS: reproducen el comportamiento de HOY (conductor = solo WhatsApp), para
-- que un deploy sin backfill no cambie ni un envío.
alter table public.alerta_config
  add column if not exists canal_conductor_whatsapp             boolean not null default true,
  add column if not exists canal_conductor_email                boolean not null default false,
  add column if not exists canal_conductor_push                 boolean not null default false,
  add column if not exists canal_pasajero_push                  boolean not null default true,
  add column if not exists canal_pasajero_email                 boolean not null default true,
  add column if not exists canal_pasajero_email_solo_sin_app    boolean not null default true,
  add column if not exists canal_pasajero_whatsapp              boolean not null default true,
  add column if not exists canal_pasajero_whatsapp_solo_sin_app boolean not null default true,
  -- false = tipo que NO controla horario (se dispara por evento externo, no por el
  -- tick) → la UI oculta el selector "Cuándo" para no prometer algo que no aplica.
  add column if not exists tiempo_editable                      boolean not null default true;

-- ── 2) Tipos de mensaje al PASAJERO que hoy NO existían como fila ─────────────
-- Sin estas filas, retirar el bloque global dejaría SIN control de canal a la
-- confirmación de servicio (notificarReserva desde /sincronizar y desde Elia) y al
-- aviso "el bus llegó" (avisarLlegadaWhatsApp) — que HOY sí gobierna config_canales.
insert into public.alerta_config
  (clave, nombre, descripcion, modo_tiempo, notifica_conductor, notifica_pasajero,
   plantilla, tiempo_editable)
values
  ('confirmacion_pasajero','Confirmación de servicio al pasajero',
   'Se envía al sincronizar/confirmar la reserva (botón Sincronizar o asistente ELIA)',
   'evento', false, true, 'recordatorio_servicio', false),
  ('llegada_pasajero','El bus llegó al paradero',
   'Aviso automático cuando el bus llega al paradero del pasajero (motor de proximidad)',
   'evento', false, true, 'bus_llego_paradero', false)
on conflict (clave) do nothing;

-- ── 3) BACKFILL one-shot: preservar la configuración ACTUAL del usuario ───────
-- Guardado por migracion_marca: re-ejecutar este archivo NO pisa lo que el usuario
-- haya editado después desde la UI.
do $$
declare c record;
begin
  if not exists (select 1 from public.migracion_marca where clave = 'canales_por_tipo_v1') then

    -- 3a) Pasajero: copiar TAL CUAL la fila global a los 3 tipos que gobernaba.
    --     Se copia la FILA REAL de producción, no los defaults del DDL (que difieren
    --     de los defaults del código a propósito — ver nota en lib/alertas.ts).
    select * into c from public.config_canales where id = 1;
    if found then
      update public.alerta_config set
        canal_pasajero_push                  = c.push_activo,
        canal_pasajero_email                 = c.email_activo,
        canal_pasajero_email_solo_sin_app    = c.email_solo_sin_app,
        canal_pasajero_whatsapp              = c.whatsapp_activo,
        canal_pasajero_whatsapp_solo_sin_app = c.whatsapp_solo_sin_app,
        updated_at = now()
      where clave in ('recordatorio_pasajero','confirmacion_pasajero','llegada_pasajero');
    end if;

    -- 3b) Conductor: HOY todo sale por WhatsApp forzoso. Congelar ese estado exacto
    --     para que el primer deploy no cambie ni un envío. El usuario activa email
    --     y push cuando quiera, desde la UI.
    update public.alerta_config set
      canal_conductor_whatsapp = true,
      canal_conductor_email    = false,
      canal_conductor_push     = false,
      updated_at = now();

    insert into public.migracion_marca (clave) values ('canales_por_tipo_v1');
  end if;
end$$;

-- ── 4) Caché del TEXTO de las plantillas Meta (para reusarlo en el email) ─────
-- El email NO redacta texto propio: interpola el MISMO body de la plantilla de
-- WhatsApp aprobada. Ir a Graph en cada envío pondría la red de Meta en el camino
-- crítico del correo (y /api/plantillas-meta exige sesión de usuario, así que un
-- cron no puede usarlo) → se cachea aquí y se refresca desde esa misma ruta.
create table if not exists public.plantilla_texto_cache (
  nombre         text primary key,
  idioma         text not null default 'es',
  body           text not null,
  estado         text,                       -- APPROVED / PENDING / REJECTED (informativo)
  vars           int  not null default 0,    -- nº de variables {{n}} detectadas
  actualizado_at timestamptz not null default now()
);
alter table public.plantilla_texto_cache enable row level security;
-- Sin policies a propósito → solo service_role (mismo patrón que push_suscripciones).

-- ── 5) RLS de alerta_config: nada que hacer ──────────────────────────────────
-- La policy `alerta_config_config` (alertas-operativas.sql:178-181) es FOR ALL sobre
-- la tabla y Postgres no tiene RLS por columna → las columnas nuevas quedan cubiertas
-- automáticamente por puede_config_alertas().

-- ── Smoke test ───────────────────────────────────────────────────────────────
-- select clave, activo, notifica_conductor, notifica_pasajero, tiempo_editable,
--        canal_conductor_whatsapp, canal_conductor_email, canal_conductor_push,
--        canal_pasajero_push, canal_pasajero_email, canal_pasajero_whatsapp
--   from public.alerta_config order by clave;
-- select * from public.config_canales;                    -- debe seguir intacta
-- select * from public.migracion_marca;                   -- canales_por_tipo_v1
