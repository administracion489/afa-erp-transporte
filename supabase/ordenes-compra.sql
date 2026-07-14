-- ──────────────────────────────────────────────────────────────────────────────
-- Órdenes de Compra: documento formal de compra a un proveedor (repuestos,
-- combustible al por mayor, llantas, servicios, etc.), con ítems y flujo de
-- estados. Al marcarla "Recibida" se puede generar un registro en `gastos`
-- (columna ordenes_compra.gasto_id) para que quede reflejado en /gastos.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1) Cabecera
create table if not exists public.ordenes_compra (
  id                     serial primary key,
  numero                 text unique,                    -- OC-2026-000001, autogenerado
  proveedor_id           int references public.proveedores(id),
  categoria              text not null default 'otro',    -- mismo vocabulario que proveedores.tipo
  vehiculo_id            int references public.vehiculos(id), -- opcional: unidad destino
  fecha_emision          date not null default current_date,
  fecha_entrega_esperada date,
  estado                 text not null default 'borrador',
  condicion_pago         text not null default 'contado', -- contado|credito_15|credito_30|detraccion|otro
  moneda                 text not null default 'PEN',
  incluye_igv            boolean not null default true,
  subtotal               numeric(12,2) not null default 0,
  igv                    numeric(12,2) not null default 0,
  total                  numeric(12,2) not null default 0,
  observaciones          text,
  comprobante_url        text,
  motivo_anulacion       text,
  creado_por             text,
  aprobado_por           text,
  fecha_aprobacion       timestamptz,
  gasto_id               int references public.gastos(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint ordenes_compra_estado_chk check (estado in
    ('borrador','pendiente_aprobacion','aprobada','enviada','recibida_parcial','recibida','anulada'))
);

-- 2) Ítems
create table if not exists public.ordenes_compra_items (
  id               serial primary key,
  orden_compra_id  int not null references public.ordenes_compra(id) on delete cascade,
  descripcion      text not null,
  cantidad         numeric(12,2) not null default 1,
  unidad_medida    text not null default 'und',
  precio_unitario  numeric(12,2) not null default 0,
  subtotal         numeric(12,2) not null default 0,
  vehiculo_id      int references public.vehiculos(id),  -- ítem asignado a una unidad específica
  created_at       timestamptz not null default now()
);

create index if not exists idx_oc_proveedor    on public.ordenes_compra (proveedor_id);
create index if not exists idx_oc_estado       on public.ordenes_compra (estado);
create index if not exists idx_oc_fecha        on public.ordenes_compra (fecha_emision desc);
create index if not exists idx_oc_vehiculo     on public.ordenes_compra (vehiculo_id);
create index if not exists idx_oc_items_orden  on public.ordenes_compra_items (orden_compra_id);

-- 3) Numeración atómica por año: OC-AAAA-NNNNNN (mismo patrón que reservas.codigo).
--    Tabla interna: RLS activado y SIN policies (deny-all) porque solo la escribe
--    fn_ordenes_compra_set_numero() más abajo, que es SECURITY DEFINER y por lo
--    tanto no depende de RLS. Ningún cliente (anon/authenticated) debe tocarla directo.
create table if not exists public.oc_secuencia (
  anio   int primary key,
  ultimo int not null default 0
);
alter table public.oc_secuencia enable row level security;

create or replace function public.fn_ordenes_compra_set_numero()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio int;
  v_n    int;
begin
  if new.numero is not null and new.numero <> '' then
    return new;
  end if;

  v_anio := extract(year from coalesce(new.fecha_emision, (now() at time zone 'America/Lima')::date))::int;

  insert into public.oc_secuencia (anio, ultimo)
    values (v_anio, 1)
    on conflict (anio) do update set ultimo = oc_secuencia.ultimo + 1
    returning ultimo into v_n;

  new.numero := 'OC-' || v_anio::text || '-' || lpad(v_n::text, 6, '0');

  return new;
end;
$$;

drop trigger if exists trg_ordenes_compra_set_numero on public.ordenes_compra;
create trigger trg_ordenes_compra_set_numero
  before insert on public.ordenes_compra
  for each row execute function public.fn_ordenes_compra_set_numero();

-- 4) updated_at automático (mismo patrón que tarifario-updated-at.sql).
create or replace function public.oc_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_oc_updated_at on public.ordenes_compra;
create trigger trg_oc_updated_at
before update on public.ordenes_compra
for each row
execute function public.oc_set_updated_at();

-- 5) RLS (igual que el resto de la app: gate real vive en permisos_usuario / capa app).
alter table public.ordenes_compra       enable row level security;
alter table public.ordenes_compra_items enable row level security;

drop policy if exists "oc_all" on public.ordenes_compra;
create policy "oc_all" on public.ordenes_compra for all using (true);

drop policy if exists "oc_items_all" on public.ordenes_compra_items;
create policy "oc_items_all" on public.ordenes_compra_items for all using (true);

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select * from public.ordenes_compra order by id desc limit 20;
-- select * from public.oc_secuencia order by anio;
