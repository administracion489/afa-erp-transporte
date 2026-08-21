-- ─────────────────────────────────────────────────────────────────────────────
-- supabase/retrasos.sql — Semáforo de PUNTUALIDAD
--
-- Sustituye la detección binaria de retraso ("pasó la hora y nadie tocó el botón")
-- por un veredicto con evidencia: dónde está el bus, cuándo llegará y por qué.
-- Ver la cabecera de lib/retrasos.ts para la doctrina completa.
--
-- Idempotente: se puede correr las veces que haga falta.
-- El módulo FUNCIONA sin este SQL (cae a los defaults del código y a la estimación
-- gratis de ETA), pero sin él no hay historial, ni histéresis, ni techo de gasto
-- compartido entre instancias, ni el reporte de cumplimiento de terceros.
--
-- ANTES DE CORRER: todo esto es instantáneo salvo la sección 7 (índices sobre
-- `ubicaciones_gps`), que bloquea los INSERT de GPS mientras construye. Léela: dice
-- cómo medir cuánto tardará y cómo hacerlo sin bloqueo si la tabla resulta grande.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1) Config editable (fila única) ──────────────────────────────────────────
-- Los defaults reproducen exactamente CONFIG_RETRASO_DEFAULT de lib/retrasos.ts.
create table if not exists public.retraso_config (
  id                        int primary key default 1,
  -- el bus debe estar EN el primer paradero estos minutos ANTES de la hora pactada.
  -- Decisión del operador (2026-08-20): la hora pactada no es "llegar", es "estar listo".
  anticipacion_min          int not null default 10,
  tolerancia_min            int not null default 10,   -- gracia tras la hora → retraso consumado
  riesgo_min                int not null default 8,    -- desvío que declara RIESGO
  riesgo_limpia_min         int not null default 3,    -- histéresis: por debajo se limpia
  persistencia_punto_min    int not null default 10,   -- en el punto sin iniciar → escala
  no_realizado_min          int not null default 120,  -- pasada la hora → ya no es retraso
  ventana_prevision_min     int not null default 60,   -- desde cuándo se vigila
  tolerancia_ruta_min       int not null default 10,   -- gracia del retraso EN RUTA
  updated_at                timestamptz default now(),
  constraint retraso_config_una_fila check (id = 1)
);
insert into public.retraso_config (id) values (1) on conflict (id) do nothing;

-- ── 2) Estado vigente por servicio ───────────────────────────────────────────
-- Una fila por reserva (upsert). Sirve para tres cosas: histéresis del chip de riesgo,
-- pintar sin recalcular, y —vía retraso_evento— el reporte mensual de cumplimiento.
create table if not exists public.retraso_estado (
  reserva_id   bigint primary key,
  nivel        text not null,
  minutos      int,
  causa        text,
  evidencia    text,
  posicion     text,          -- en_punto | lejos | desconocida
  distancia_m  int,
  evaluado_at  timestamptz not null default now()
);
create index if not exists idx_retraso_estado_nivel on public.retraso_estado (nivel);

-- ── 3) Historial de CAMBIOS de nivel (append-only) ───────────────────────────
-- retraso_estado se sobrescribe: si un tercero abre el link tarde, su "sin rastreo"
-- desaparecería y el incumplimiento quedaría sin registro. Esta tabla solo inserta
-- cuando el nivel CAMBIA, así que conserva lo que de verdad pasó, barato.
create table if not exists public.retraso_evento (
  id          bigserial primary key,
  reserva_id  bigint not null,
  nivel       text not null,
  nivel_prev  text,
  minutos     int,
  evidencia   text,
  creado_at   timestamptz not null default now()
);
create index if not exists idx_retraso_evento_reserva on public.retraso_evento (reserva_id, creado_at);
create index if not exists idx_retraso_evento_fecha   on public.retraso_evento (creado_at);

-- ── 4) Caché y techo de gasto del ETA con tráfico ────────────────────────────
-- `departure_time` factura en el SKU Advanced ($10/1000, 5.000 gratis/mes). Ver
-- lib/eta-trafico.ts. La caché corta la ráfaga de refrescos; el contador pone el techo.
create table if not exists public.eta_trafico_cache (
  clave      text primary key,      -- "latO,lngO>latD,lngD" (origen ~110 m, destino ~1 m)
  minutos    int not null,
  creado_at  timestamptz not null default now()
);
create index if not exists idx_eta_cache_creado on public.eta_trafico_cache (creado_at);

create table if not exists public.eta_gasto_dia (
  fecha     date primary key,       -- día de Lima
  llamadas  int  not null default 0
);

-- Incremento ATÓMICO del contador: entre instancias serverless un
-- select+upsert pierde carreras y el techo se pasaría de largo.
create or replace function public.eta_gasto_incrementar(p_fecha date)
  returns int language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  insert into public.eta_gasto_dia (fecha, llamadas) values (p_fecha, 1)
    on conflict (fecha) do update set llamadas = public.eta_gasto_dia.llamadas + 1
    returning llamadas into n;
  return n;
end $fn$;

-- ── 5) Tipos de aviso nuevos en el motor de alertas ──────────────────────────
-- Nada hardcodeado: cada uno se enciende, se le pone umbral y se le eligen
-- destinatarios desde el panel de configuración, igual que los existentes.
-- Todos nacen APAGADOS (activo=false): un deploy no debe estrenar avisos solo.
--
-- `umbral` de cada uno:
--   riesgo_retraso        → minutos de desvío previsto que ameritan avisar
--   en_punto_sin_iniciar  → minutos en el punto pasada la hora antes de escalar
--   retraso_en_ruta       → minutos de desvío contra la hora del siguiente paradero
--   sin_rastreo_previo    → minutos antes de la hora a partir de los cuales exigir señal
insert into public.alerta_config
  (clave, nombre, descripcion, activo, modo_tiempo, min_anticipacion, hora_fija, umbral,
   notifica_conductor, notifica_pasajero, plantilla, plantilla_directorio)
values
  ('riesgo_retraso','Riesgo de retraso (previsión)',
   'El bus no llegará al primer paradero a tiempo según su posición y el tráfico',
   false,'evento',null,null,8, false,false,null,'coordinador_alerta'),

  ('en_punto_sin_iniciar','En el punto, sin iniciar',
   'El GPS confirma el bus en el paradero pero el conductor no marcó inicio. Aviso AL CONDUCTOR; escala al coordinador solo si persiste',
   false,'evento',null,null,10, true,false,'conductor_recuerda_iniciar','coordinador_alerta'),

  ('retraso_en_ruta','Retraso en ruta',
   'Servicio ya iniciado que llegará tarde al siguiente paradero',
   false,'evento',null,null,10, false,false,null,'coordinador_alerta'),

  ('sin_rastreo_previo','Sin rastreo antes del servicio',
   'No hay señal GPS de la unidad con el servicio a punto de empezar (el tercero no abrió el link)',
   false,'evento',null,null,30, false,false,null,'coordinador_alerta')
on conflict (clave) do nothing;

-- ── 6) RLS ───────────────────────────────────────────────────────────────────
-- Config: mismo candado que el resto de la mensajería (admin o módulo configuración).
-- Estado/eventos: lectura para cualquier autenticado (los pinta la torre vía API con
-- service-role, pero dejar la lectura abierta permite un panel futuro sin migración).
-- Caché y gasto: SIN policy → solo service-role.
alter table public.retraso_config     enable row level security;
alter table public.retraso_estado     enable row level security;
alter table public.retraso_evento     enable row level security;
alter table public.eta_trafico_cache  enable row level security;
alter table public.eta_gasto_dia      enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='retraso_config' and policyname='retraso_config_config') then
    create policy "retraso_config_config" on public.retraso_config
      for all using (public.puede_config_alertas()) with check (public.puede_config_alertas());
  end if;
  if not exists (select 1 from pg_policies where tablename='retraso_estado' and policyname='retraso_estado_auth') then
    create policy "retraso_estado_auth" on public.retraso_estado
      for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies where tablename='retraso_evento' and policyname='retraso_evento_auth') then
    create policy "retraso_evento_auth" on public.retraso_evento
      for select using (auth.role() = 'authenticated');
  end if;
end$$;

-- ── 7) Índices que este módulo necesita en ubicaciones_gps ───────────────────
-- Antes de iniciar el servicio los fixes NO llevan reserva_id: se busca por conductor
-- (o vehículo) en los últimos 25 min, una vez por servicio en ventana. Sin estos índices
-- esa consulta hace un seq scan sobre la tabla más grande del sistema.
--
-- POR QUÉ NO LLEVAN `concurrently`: el editor SQL de Supabase envuelve TODO el script en
-- una transacción y CREATE INDEX CONCURRENTLY no puede correr dentro de una
-- (ERROR 25001). Aquí van en su forma normal para que el archivo se pegue de una sola vez.
--
-- QUÉ IMPLICA: un CREATE INDEX normal toma un lock SHARE que BLOQUEA los INSERT de
-- `ubicaciones_gps` mientras construye (segundos a ~1 min según el tamaño). NO se pierde
-- rastreo —la app del conductor encola los puntos y los drena al reconectar
-- (app/conductor/page.tsx, encolar/drenarCola)— pero conviene correrlo en hora VALLE,
-- de madrugada y sin servicios en curso.
--
-- ¿Cuánto va a tardar? Mídelo antes:
--   select count(*) from public.ubicaciones_gps;
--   select pg_size_pretty(pg_total_relation_size('public.ubicaciones_gps'));
--
-- ALTERNATIVA SIN BLOQUEO: si la tabla es muy grande o hay servicios en ruta, salta este
-- bloque y corre las versiones CONCURRENTLY por psql (Connect → Connection string), donde
-- cada sentencia va en autocommit:
--   create index concurrently if not exists idx_gps_conductor_fecha
--     on public.ubicaciones_gps (conductor_id, created_at desc) where conductor_id is not null;
--   create index concurrently if not exists idx_gps_conductor_ter_fecha
--     on public.ubicaciones_gps (conductor_tercero_id, created_at desc) where conductor_tercero_id is not null;
--   create index concurrently if not exists idx_gps_vehiculo_fecha
--     on public.ubicaciones_gps (vehiculo_id, created_at desc) where vehiculo_id is not null;
--   create index concurrently if not exists idx_gps_vehiculo_ter_fecha
--     on public.ubicaciones_gps (vehiculo_tercero_id, created_at desc) where vehiculo_tercero_id is not null;

create index if not exists idx_gps_conductor_fecha
  on public.ubicaciones_gps (conductor_id, created_at desc) where conductor_id is not null;
create index if not exists idx_gps_conductor_ter_fecha
  on public.ubicaciones_gps (conductor_tercero_id, created_at desc) where conductor_tercero_id is not null;
create index if not exists idx_gps_vehiculo_fecha
  on public.ubicaciones_gps (vehiculo_id, created_at desc) where vehiculo_id is not null;
create index if not exists idx_gps_vehiculo_ter_fecha
  on public.ubicaciones_gps (vehiculo_tercero_id, created_at desc) where vehiculo_tercero_id is not null;

-- ── 8) Limpieza de la caché de ETA (opcional, si hay pg_cron) ────────────────
-- Sin esto la tabla crece unos pocos miles de filas al mes; no es urgente.
-- delete from public.eta_trafico_cache where creado_at < now() - interval '1 day';

-- ── Smoke test ───────────────────────────────────────────────────────────────
-- select * from public.retraso_config;
-- select clave, activo, umbral from public.alerta_config
--   where clave in ('riesgo_retraso','en_punto_sin_iniciar','retraso_en_ruta','sin_rastreo_previo');
-- Cumplimiento de terceros del mes (lo que justifica el nivel "sin rastreo"):
-- select e.razon_social, count(*) filter (where ev.nivel = 'sin_rastreo') as veces_sin_senal
--   from public.retraso_evento ev
--   join public.reservas r on r.id = ev.reserva_id
--   join public.empresas_tercerizadas e on e.id = r.empresa_tercerizada_id
--  where ev.creado_at >= date_trunc('month', now())
--  group by 1 order by 2 desc;
