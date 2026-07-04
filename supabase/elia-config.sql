-- ============================================================
-- ELIA — Configuración y control de gasto mensual.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
-- Sin esto, ELIA sigue funcionando con valores por defecto
-- (Opus 4.8, sin límite) y no registra el gasto.
-- ============================================================

-- Configuración (una sola fila, id = 1)
create table if not exists elia_config (
  id int primary key default 1,
  activa boolean not null default true,
  modelo text not null default 'claude-opus-4-8',
  limite_mensual_usd numeric not null default 100,  -- 0 = sin límite
  aviso_pct int not null default 80,                -- % del límite para marcar "cerca del tope"
  actualizado_at timestamptz default now(),
  actualizado_por uuid
);
insert into elia_config (id) values (1) on conflict (id) do nothing;

-- Detalle de uso (una fila por respuesta de ELIA)
create table if not exists elia_uso (
  id bigserial primary key,
  usuario_id uuid,
  usuario_nombre text,
  modelo text,
  mes text not null,                 -- 'YYYY-MM' en hora Lima
  tokens_entrada int default 0,
  tokens_salida int default 0,
  tokens_cache_leidos int default 0,
  tokens_cache_escritos int default 0,
  herramientas int default 0,
  iteraciones int default 0,
  costo_usd numeric default 0,
  created_at timestamptz default now()
);
create index if not exists idx_elia_uso_mes on elia_uso (mes);
create index if not exists idx_elia_uso_usuario on elia_uso (usuario_id, mes);

-- Acumulador mensual (lectura O(1) para el freno de presupuesto)
create table if not exists elia_gasto_mensual (
  mes text primary key,              -- 'YYYY-MM'
  total_usd numeric not null default 0,
  mensajes int not null default 0
);

-- Suma atómica (evita carreras entre respuestas simultáneas)
create or replace function elia_sumar_gasto(p_mes text, p_costo numeric)
returns void
language sql
security definer
as $$
  insert into elia_gasto_mensual (mes, total_usd, mensajes)
  values (p_mes, p_costo, 1)
  on conflict (mes) do update
    set total_usd = elia_gasto_mensual.total_usd + excluded.total_usd,
        mensajes  = elia_gasto_mensual.mensajes + 1;
$$;

-- Estas tablas solo se tocan desde el servidor (service-role).
alter table elia_config enable row level security;
alter table elia_uso enable row level security;
alter table elia_gasto_mensual enable row level security;
