-- ============================================================
-- CENTRAL DE LLAMADAS PROPIA · la llamada al conductor que no pulsa «Iniciar»
-- Ejecutar en Supabase SQL Editor. Idempotente. (NO la corre el deploy.)
-- ============================================================
-- Lo pidió el dueño (11-10-2026): si el conductor ignora el «ya debió iniciar», una llamada a
-- los 2 minutos que le pida usar el app; y en vez de contratar Twilio, una central PROPIA.
--
-- Una llamada telefónica normal siempre sale por la línea de un operador (un chip): eso no se
-- puede evitar. Lo que se evita es el intermediario que cobra por minuto. El ERP solo deja la
-- COLA; la CENTRAL (un equipo con un chip de llamadas ilimitadas, ver docs/central-llamadas.md)
-- toma cada llamada por /api/llamadas/central, marca y devuelve lo que pasó.
--
-- EL AVISO NACE APAGADO: sin central conectada, las llamadas se quedarían en cola y vencerían
-- sin salir. Se enciende en /configuracion/operaciones («Llamada: aún no inicia») cuando la
-- central esté instalada.
--
-- SIN ESTE SQL NADA SE CAE: el cron no encuentra la fila `llamada_inicio` y no encola nada, y
-- la ficha de /seguimiento no enseña llamadas.
-- ============================================================

-- ── 1) La cola de llamadas ────────────────────────────────────────────────────
create table if not exists public.llamadas_conductor (
  id                  bigint generated always as identity primary key,
  reserva_id          bigint,                 -- null = llamada de prueba
  fecha_servicio      date,
  conductor_id        bigint,
  conductor_tabla     text check (conductor_tabla in ('conductores','conductores_tercero')),
  telefono            text not null,          -- E.164 (+51…)
  motivo              text not null,          -- 'llamada_inicio' | 'prueba'
  mensaje             text not null,          -- lo que dice la llamada (voz)
  menu                text,                   -- «marca 1 / marca 2» (solo centrales con voz)
  datos               jsonb not null default '{}'::jsonb,   -- nombre, hora, origen
  estado              text not null default 'pendiente'
                      check (estado in ('pendiente','marcando','contestada','no_contesto',
                                        'ocupado','fallida','cancelada','vencida')),
  intentos            int  not null default 0,
  max_intentos        int  not null default 2,
  proximo_intento_en  timestamptz not null default now(),
  vence_en            timestamptz not null,
  tomada_en           timestamptz,
  terminada_en        timestamptz,
  duracion_seg        int,
  opcion              text check (opcion is null or opcion in ('1','2')),
  detalle             text,
  central             text,                   -- qué equipo la hizo
  creado_por          uuid,                   -- usuario (solo las de prueba)
  created_at          timestamptz not null default now()
);

-- Una llamada por servicio y motivo: el cron de un minuto no puede encolar dos.
create unique index if not exists uq_llamadas_reserva_motivo
  on public.llamadas_conductor (reserva_id, motivo) where reserva_id is not null;
-- Lo que la central busca cada pocos segundos.
create index if not exists idx_llamadas_pendientes
  on public.llamadas_conductor (proximo_intento_en, id) where estado = 'pendiente';
-- La ficha de /seguimiento y la evidencia al coordinador leen por servicio.
create index if not exists idx_llamadas_reserva on public.llamadas_conductor (reserva_id, created_at);

-- Lectura para el ERP (la ficha del servicio). Escribe SOLO el servidor (service-role): la
-- central entra por /api/llamadas/central con su propio secreto, nunca con la anon key.
alter table public.llamadas_conductor enable row level security;
drop policy if exists llamadas_conductor_lectura on public.llamadas_conductor;
create policy llamadas_conductor_lectura on public.llamadas_conductor
  for select to authenticated using (true);
-- Y solo las COLUMNAS que la ficha enseña: el teléfono, el texto y quién la pidió no. Una llamada
-- de prueba va a un número del directorio, que solo ve quien tiene el módulo de configuración
-- (revisión de seguridad, 11-10-2026). Las vistas del servidor usan service-role y no cambian.
revoke all on public.llamadas_conductor from anon, authenticated;
grant select (id, reserva_id, estado, intentos, created_at, tomada_en, terminada_en,
              proximo_intento_en, duracion_seg, opcion, detalle, motivo)
  on public.llamadas_conductor to authenticated;

-- ── 2) El último contacto de la central ───────────────────────────────────────
-- Fila única. Con ella la pantalla dice «central conectada / no se conecta desde hace X».
create table if not exists public.central_llamadas_estado (
  id             smallint primary key default 1 check (id = 1),
  ultimo_latido  timestamptz,
  equipo         text,
  version        text,
  detalle        text,
  updated_at     timestamptz not null default now()
);
alter table public.central_llamadas_estado enable row level security;
drop policy if exists central_llamadas_estado_lectura on public.central_llamadas_estado;
create policy central_llamadas_estado_lectura on public.central_llamadas_estado
  for select to authenticated using (true);
revoke all on public.central_llamadas_estado from anon, authenticated;
grant select on public.central_llamadas_estado to authenticated;

-- ── 3) El peldaño de la escalera ──────────────────────────────────────────────
-- `umbral` = minutos después de la hora (3: dos minutos después del «ya debió iniciar»).
-- Sin plantilla: no es un WhatsApp. Los contactos marcados en su tarjeta reciben un WhatsApp
-- (coordinador_alerta) si el conductor marca 2 («hablar con el coordinador»).
insert into public.alerta_config
  (clave, nombre, descripcion, activo, modo_tiempo, min_anticipacion, hora_fija, umbral,
   notifica_conductor, notifica_pasajero, plantilla, plantilla_directorio)
values
  ('llamada_inicio','Llamada: aún no inicia',
   'Llamada telefónica al conductor desde la central propia, minutos después de la hora, si todavía no pulsó INICIAR. Si marca 2, avisa a los contactos marcados.',
   false,'evento',null,null,3, true,false,null,default)
on conflict (clave) do nothing;

do $$
begin
  -- Ninguno de los canales de mensaje aplica: es una llamada.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'canal_conductor_push') then
    update public.alerta_config
       set canal_conductor_whatsapp = false, canal_conductor_email = false, canal_conductor_push = false
     where clave = 'llamada_inicio';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'usa_directorio') then
    update public.alerta_config set usa_directorio = true where clave = 'llamada_inicio';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'tiempo_editable') then
    update public.alerta_config set tiempo_editable = false where clave = 'llamada_inicio';
  end if;
  -- Urgente por diseño: NUNCA espera al horario de envío.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerta_config'
                and column_name = 'respeta_horario') then
    update public.alerta_config set respeta_horario = false where clave = 'llamada_inicio';
  end if;
end $$;

-- ── Verificación ──────────────────────────────────────────────────────────────
-- select clave, activo, umbral, notifica_conductor_tercero from public.alerta_config where clave = 'llamada_inicio';
-- select * from public.central_llamadas_estado;
-- Las llamadas de un servicio:
-- select created_at at time zone 'America/Lima' as encolada, estado, intentos, duracion_seg, opcion, detalle
--   from public.llamadas_conductor where reserva_id = 29812 order by created_at;
