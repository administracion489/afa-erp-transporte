-- gps-traza-ajustada-01 · La traza ajustada a la vía de un servicio FINALIZADO se
-- guarda para siempre (una fila por reserva) y no se vuelve a pagar Map Matching.
-- NO LA CORRE EL DEPLOY: se pega ENTERA en el SQL Editor de Supabase y Run.
-- Sin ella todo sigue como hoy (el modal GPS ajusta en el navegador) y lo dice.
--
-- gps_traza_ajustada: SOLO la salida de Mapbox (vértices, esCrudo, colaSnapped) y
--   la firma (sha256) de las filas GPS con que se calculó. Los puentes son de
--   Google (máx. 30 días) y NO se guardan: se derivan al abrir.
-- gps_traza_ajuste_intentos: bitácora del gasto y CANDADO (un cálculo a la vez
--   por reserva). Sin FK a reservas: borrar un servicio no borra su gasto.
-- gps_traza_config (fila única), banderas reversibles con un UPDATE:
--   guardar=false          -> el servidor no lee ni escribe trazas; el modal
--                             vuelve a ajustar en el navegador, como antes.
--   borrar_guardadas=true  -> el cron borra las guardadas por lotes.
--   precalcular_dias=0     -> el cron no precalcula nada (nace apagado).
-- presupuesto_hora / presupuesto_mes (llamadas a Map Matching del SERVIDOR) NO
-- ESTÁN MEDIDOS; la cuota gratis de Mapbox tampoco está confirmada.
-- Seguridad: RLS activo y NINGUNA política (patrón whatsapp_tokens): solo
-- service-role. Leen y escriben únicamente las rutas del servidor.
--
-- Revisión (copiar aparte): llamadas gastadas este mes (Lima), por origen.
-- select origen, resultado, count(*) as intentos, sum(llamadas) as llamadas
--   from public.gps_traza_ajuste_intentos
--  where empezado_en >= date_trunc('month', now() at time zone 'America/Lima')
--                       at time zone 'America/Lima'
--  group by origen, resultado order by llamadas desc nulls last;

create table if not exists public.gps_traza_ajustada (
  reserva_id   bigint primary key references public.reservas(id) on delete cascade,
  version      smallint not null,
  firma        text not null,
  n_filas      int not null,
  ultimo_ts    timestamptz,
  traza        jsonb not null,
  vertices     int not null,
  bytes        int not null check (bytes between 1 and 900000),
  llamadas     int not null default 0,
  recalculos   smallint not null default 0,
  origen       text not null check (origen in ('apertura','cron')),
  calculado_en timestamptz not null default now()
);

create table if not exists public.gps_traza_ajuste_intentos (
  id           bigserial primary key,
  reserva_id   bigint not null,
  origen       text,
  sujeto       text,
  empezado_en  timestamptz default now(),
  terminado_en timestamptz,
  llamadas     int default 0,
  resultado    text
);

-- El candado: a lo sumo un intento ABIERTO por reserva.
create unique index if not exists uq_gps_traza_intento_abierto
  on public.gps_traza_ajuste_intentos (reserva_id) where terminado_en is null;
-- Suma del gasto de la última hora y del mes.
create index if not exists idx_gps_traza_intento_empezado
  on public.gps_traza_ajuste_intentos (empezado_en);

create table if not exists public.gps_traza_config (
  id               smallint primary key default 1 check (id = 1),
  guardar          boolean not null default true,
  borrar_guardadas boolean not null default false,
  presupuesto_hora int not null default 2000,
  presupuesto_mes  int not null default 50000,
  precalcular_dias smallint not null default 0 check (precalcular_dias between 0 and 90),
  por_corrida      smallint not null default 20,
  actualizado_en   timestamptz default now()
);

insert into public.gps_traza_config (id) values (1) on conflict (id) do nothing;

alter table public.gps_traza_ajustada        enable row level security;
alter table public.gps_traza_ajuste_intentos enable row level security;
alter table public.gps_traza_config          enable row level security;
-- Sin política a propósito: ninguna = nadie salvo service-role.

revoke all on table public.gps_traza_ajustada        from anon, authenticated;
revoke all on table public.gps_traza_ajuste_intentos from anon, authenticated;
revoke all on table public.gps_traza_config          from anon, authenticated;
revoke all on sequence public.gps_traza_ajuste_intentos_id_seq from anon, authenticated;

-- Verificación (copiar aparte; debe dar 3 filas con rls=true y politicas=0):
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as politicas
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname like 'gps_traza_%' and c.relkind = 'r';

-- FIN de gps-traza-ajustada-01
