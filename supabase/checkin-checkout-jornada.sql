-- supabase/checkin-checkout-jornada.sql — Fase 3: Check-in / Check-out de jornada + auditoría de km.
-- Incremental e idempotente. Correr una vez en el editor SQL de Supabase.
--
-- Filosofía (spec del operador): la app trabaja PARA el conductor. El check-in es el inicio
-- oficial de la jornada del vehículo (km inicial, una vez al día, antes de salir de cochera); el
-- check-out es el cierre (km final). La auditoría cruza: km jornada = check-out − check-in;
-- km operativos = Σ km de servicios (GPS, lib/km-servicio.ts); km no justificados = jornada − operativos.

-- 1) Vincular una lectura de odómetro al MOMENTO de jornada (check-in / check-out) y, opcionalmente,
--    a una reserva. Nullable → las lecturas existentes (combustible, checklist, radar) no se tocan.
alter table lecturas_odometro add column if not exists momento text;      -- 'checkin' | 'checkout' | null
alter table lecturas_odometro add column if not exists reserva_id bigint; -- opcional: servicio asociado

-- 2) Check-out de jornada del conductor (espejo de checklist_conductor, que ya guarda el check-in).
create table if not exists checkout_conductor (
  id                bigserial primary key,
  conductor_id      bigint,
  vehiculo_id       bigint,
  es_tercero        boolean not null default false,
  fecha             date not null,
  km_fin            int,
  nivel_combustible text,        -- 'lleno' | '3/4' | '1/2' | '1/4' | 'reserva' (o texto libre)
  observaciones     text,
  foto_url          text,        -- foto del odómetro final (evidencia)
  created_at        timestamptz default now()
);
create index if not exists idx_checkout_conductor_fecha on checkout_conductor (conductor_id, fecha);

-- 3) Config editable de la auditoría de kilometraje no justificado (umbrales en km) + cadencia del
--    recordatorio de check-out. Editable desde el ERP sin tocar código (spec del operador:
--    Normal 0-5 · Advertencia 6-15 · Revisión 16-30 · Alta >30).
create table if not exists jornada_config (
  id                          int primary key default 1,
  umbral_advertencia          int not null default 6,   -- >= advertencia (amarillo)
  umbral_revision             int not null default 16,  -- >= revisión
  umbral_alto                 int not null default 31,  -- >= alta diferencia
  recordar_checkout_cada_min  int not null default 60,  -- cadencia del recordatorio horario
  updated_at                  timestamptz default now(),
  constraint jornada_config_una_fila check (id = 1)
);
insert into jornada_config (id) values (1) on conflict (id) do nothing;
