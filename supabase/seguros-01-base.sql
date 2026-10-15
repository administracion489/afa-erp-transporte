-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-01-base.sql · La tabla `seguros` con la forma que lee /seguros.
-- (NO la corre el deploy: Supabase → SQL Editor → Run. Idempotente.)
--
-- POR QUÉ: /seguros lee y escribe `seguros`, que nunca tuvo migración en el repo.
-- Desde este cambio la tabla guarda SOLO pólizas de verdad —sobre todo las
-- COLECTIVAS (SCTR, Vida Ley, RC de flota, Todo Riesgo de flotilla)—, y la
-- pantalla DERIVA el SOAT de documentos_vehiculo/documentos_tercero y el
-- SCTR/Vida Ley individual de las fichas (ver seguros-03). Nada se copia aquí:
-- SIN BACKFILL. Una póliza tiene una fila; a quién cubre va en seguro_cobertura.
--
-- Columnas NUEVAS (accesorias, nullable y sin default — nadie las afirmó aún):
--   vehiculo_tercero_id → póliza de UNA unidad tercerizada (vehiculo_id es la propia).
--   alcance             → 'individual' | 'colectiva' | null (null = no se declaró;
--                         el código NO debe deducirlo de que tenga coberturas).
-- SI NO SE CORRE: la página sigue igual (la tabla ya existía hecha a mano) y el
-- código debe soltar vehiculo_tercero_id/alcance si el error las nombra.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.seguros (
  id                bigserial primary key,
  tipo              text not null default 'otro',
  aseguradora       text not null,
  numero_poliza     text,
  titular           text,
  vehiculo_id       bigint references public.vehiculos(id) on delete set null,
  proveedor_id      bigint references public.proveedores(id) on delete set null,
  fecha_inicio      date,
  fecha_vencimiento date not null,
  prima_total       numeric(12,2) not null default 0,
  cuota_mensual     numeric(12,2) not null default 0,
  estado            text,
  archivo_url       text,
  observaciones     text,
  created_at        timestamptz not null default now()
);

-- Si la tabla ya existía con otra forma: se completa sin tocar lo que hay.
alter table public.seguros add column if not exists tipo              text;
alter table public.seguros add column if not exists aseguradora       text;
alter table public.seguros add column if not exists numero_poliza     text;
alter table public.seguros add column if not exists titular           text;
alter table public.seguros add column if not exists vehiculo_id       bigint;
alter table public.seguros add column if not exists proveedor_id      bigint;
alter table public.seguros add column if not exists fecha_inicio      date;
alter table public.seguros add column if not exists fecha_vencimiento date;
alter table public.seguros add column if not exists prima_total       numeric(12,2) default 0;
alter table public.seguros add column if not exists cuota_mensual     numeric(12,2) default 0;
alter table public.seguros add column if not exists estado            text;
alter table public.seguros add column if not exists archivo_url       text;
alter table public.seguros add column if not exists observaciones     text;
alter table public.seguros add column if not exists created_at        timestamptz default now();

-- Nuevas: nullable, SIN default.
alter table public.seguros add column if not exists vehiculo_tercero_id bigint;
alter table public.seguros add column if not exists alcance             text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_seguros_vehiculo_tercero') then
    alter table public.seguros add constraint fk_seguros_vehiculo_tercero
      foreign key (vehiculo_tercero_id) references public.vehiculos_tercero(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_seguros_alcance') then
    alter table public.seguros add constraint ck_seguros_alcance
      check (alcance is null or alcance in ('individual','colectiva'));
  end if;
end $$;

-- Lo que filtra la página (orden por vencimiento) y los cruces por unidad.
create index if not exists idx_seguros_vencimiento on public.seguros (fecha_vencimiento);
create index if not exists idx_seguros_tipo        on public.seguros (tipo);
create index if not exists idx_seguros_veh_tercero on public.seguros (vehiculo_tercero_id)
  where vehiculo_tercero_id is not null;

-- RLS: solo usuarios del ERP. El nombre es el que usa seguridad-01-rls.sql.
alter table public.seguros enable row level security;
drop policy if exists seguros_authenticated on public.seguros;
create policy seguros_authenticated on public.seguros
  for all to authenticated using (true) with check (true);
revoke all on public.seguros from anon;

-- Verificación (debe salir alcance y vehiculo_tercero_id, y rls = true):
-- select column_name from information_schema.columns
--   where table_name='seguros' and column_name in ('alcance','vehiculo_tercero_id');
-- select relrowsecurity from pg_class where oid = 'public.seguros'::regclass;

-- FIN de seguros-01-base.sql
