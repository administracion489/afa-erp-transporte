-- supabase/radar-ia.sql — Módulo Radar IA (WhatsApp Web → ELIA → ERP)
-- Correr una vez en el editor SQL de Supabase. Idempotente.
--
-- El worker externo (radar-worker/, Baileys) escribe con service-role:
--   radar_estado (sesión/QR), radar_grupos (upsert por wa_group_id) y radar_mensajes (crudo).
-- El pipeline del ERP (lib/radar/motor.ts vía /api/radar/procesar) clasifica con ELIA,
-- extrae datos y ejecuta acciones: radar_oportunidades, radar_combustible, radar_alertas,
-- e inserta en las tablas reales (combustible, mantenimiento, cotizaciones) según config.
-- NO toca ninguna tabla crm_* ni el webhook de Meta: módulos independientes.

-- ============================================================
-- 1) Estado de la sesión WhatsApp del worker (fila única id=1)
-- ============================================================
create table if not exists radar_estado (
  id int primary key default 1 check (id = 1),
  estado text not null default 'desconectado',  -- desconectado | esperando_qr | conectado
  qr_data_url text,                             -- QR vigente (data URL) para mostrar en /radar-ia
  numero text,                                  -- número conectado (wa id)
  detalle text,                                 -- último motivo de desconexión / nota del worker
  version_worker text,
  conectado_desde timestamptz,
  ultimo_latido timestamptz,                    -- heartbeat del worker (cada 60 s)
  updated_at timestamptz default now()
);
insert into radar_estado (id) values (1) on conflict (id) do nothing;

-- ============================================================
-- 2) Grupos de WhatsApp detectados (el usuario activa cuáles monitorear)
-- ============================================================
create table if not exists radar_grupos (
  id uuid primary key default gen_random_uuid(),
  wa_group_id text unique not null,             -- p.ej. 1203630xxxx@g.us
  nombre text not null default '',
  participantes int default 0,
  activo boolean not null default false,        -- solo los activos se procesan
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 3) Mensajes capturados (crudo + resultado del análisis de ELIA)
-- ============================================================
create table if not exists radar_mensajes (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text unique not null,           -- dedupe (reconexiones re-entregan)
  grupo_id uuid references radar_grupos(id) on delete set null,
  wa_group_id text,
  grupo_nombre text,
  remitente_wa text,                            -- jid del autor
  remitente_nombre text,                        -- pushName
  tipo text not null default 'texto',           -- texto|imagen|documento|audio|video|otro
  texto text,                                   -- cuerpo o caption
  media_url text,                               -- URL pública en bucket radar-media
  media_mime text,
  media_nombre text,                            -- nombre de archivo (documentos)
  transcripcion text,                           -- notas de voz (si hay proveedor de transcripción)
  ts_mensaje timestamptz not null,              -- hora del mensaje en WhatsApp
  recibido_en timestamptz default now(),
  -- Resultado del pipeline:
  estado text not null default 'pendiente',     -- pendiente|procesando|procesado|descartado|error
  categoria text,                               -- CategoriaRadar (lib/radar/tipos.ts)
  confianza numeric,                            -- 0..1
  resumen_ia text,                              -- una línea de ELIA sobre el mensaje
  resultado jsonb,                              -- datos extraídos + detalle de la acción
  accion text,                                  -- qué hizo el sistema (p.ej. combustible_registrado)
  error text,
  feedback text,                                -- correcto | incorrecto (para medir precisión)
  tokens_entrada int default 0,
  tokens_salida int default 0,
  costo_usd numeric default 0,
  procesado_en timestamptz
);
create index if not exists idx_radar_mensajes_pendientes on radar_mensajes (recibido_en) where estado = 'pendiente';
create index if not exists idx_radar_mensajes_recibido on radar_mensajes (recibido_en desc);
create index if not exists idx_radar_mensajes_categoria on radar_mensajes (categoria);

-- ============================================================
-- 4) Oportunidades comerciales detectadas
-- ============================================================
create table if not exists radar_oportunidades (
  id uuid primary key default gen_random_uuid(),
  mensaje_id uuid references radar_mensajes(id) on delete cascade,
  estado text not null default 'nueva',         -- nueva|revisada|cotizada|descartada
  fecha_servicio date,
  hora_servicio text,
  ciudad text,
  distrito text,
  origen text,
  destino text,
  pasajeros int,
  tipo_vehiculo text,
  unidades int,
  tiempo_espera text,
  servicios_adicionales text,
  cliente_nombre text,
  empresa text,
  telefono text,
  observaciones text,
  cliente_id bigint,                            -- match contra clientes (si se encontró)
  disponibilidad jsonb,                         -- { vehiculos_libres, conductores_libres, detalle }
  precio_referencial numeric,                   -- del tarifario (sin IGV) si hubo match
  utilidad_estimada numeric,
  probabilidad int,                             -- 0..100
  cotizacion_id bigint,                         -- id en cotizaciones al crearla con un clic
  created_at timestamptz default now()
);
create index if not exists idx_radar_oportunidades_estado on radar_oportunidades (estado);

-- ============================================================
-- 5) Abastecimientos de combustible detectados
-- ============================================================
create table if not exists radar_combustible (
  id uuid primary key default gen_random_uuid(),
  mensaje_id uuid references radar_mensajes(id) on delete cascade,
  estado text not null default 'pendiente_revision',  -- registrado|pendiente_revision|descartado
  placa text,
  vehiculo_id bigint,                           -- match contra vehiculos
  fecha date,
  hora text,
  grifo text,
  direccion_grifo text,
  tipo_combustible text,                        -- diesel|gasolina|glp|gnv|urea|biodiesel
  galones numeric,
  litros numeric,
  precio_galon numeric,
  precio_litro numeric,
  monto_total numeric,
  comprobante text,
  kilometraje int,
  conductor text,
  proveedor text,                               -- empresa proveedora del voucher
  anomalias jsonb not null default '[]'::jsonb, -- [{ codigo, detalle }]
  combustible_id bigint,                        -- id en la tabla combustible al registrarse
  created_at timestamptz default now()
);
create index if not exists idx_radar_combustible_estado on radar_combustible (estado);

-- ============================================================
-- 6) Alertas del Radar
-- ============================================================
create table if not exists radar_alertas (
  id uuid primary key default gen_random_uuid(),
  mensaje_id uuid references radar_mensajes(id) on delete set null,
  tipo text not null,                           -- oportunidad|combustible_anomalia|mantenimiento|operaciones|incidencia|documentacion|cobranza|sistema
  severidad text not null default 'info',       -- critico|atencion|info
  titulo text not null,
  detalle text,
  href text,                                    -- ruta interna del ERP relacionada
  leida boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists idx_radar_alertas_noleidas on radar_alertas (created_at desc) where leida = false;

-- ============================================================
-- 7) Configuración (fila única id=1)
-- ============================================================
create table if not exists radar_config (
  id int primary key default 1 check (id = 1),
  activo boolean not null default true,
  horario_activo boolean not null default false,  -- si true, solo analiza dentro de la ventana
  hora_inicio text not null default '06:00',      -- hora Lima
  hora_fin text not null default '22:00',
  categorias_activas jsonb not null default '["oportunidad_comercial","combustible","mantenimiento","operaciones","incidencias","documentacion","cobranza"]'::jsonb,
  -- Acciones con efectos reales por categoría (lo demás siempre es alerta+registro):
  acciones_automaticas jsonb not null default '{"combustible": true, "mantenimiento": false, "operaciones": false}'::jsonb,
  palabras_clave jsonb not null default '[]'::jsonb, -- pistas extra para el triage
  umbral_confianza numeric not null default 0.7,     -- bajo esto, la acción queda en revisión
  modelo_triage text not null default 'claude-haiku-4-5',
  modelo_extraccion text not null default 'claude-sonnet-5',
  notificar_email boolean not null default false,
  correos_alerta text,                               -- lista separada por comas
  limite_diario_usd numeric not null default 5,      -- freno de gasto IA del día
  updated_at timestamptz default now()
);
insert into radar_config (id) values (1) on conflict (id) do nothing;

-- ============================================================
-- RLS: los usuarios autenticados del ERP leen y editan (toggles, feedback, config);
-- el worker y el pipeline usan service-role (bypassean RLS).
-- Mismo patrón permisivo que supabase/mantenimiento-preventivo.sql.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['radar_estado','radar_grupos','radar_mensajes','radar_oportunidades','radar_combustible','radar_alertas','radar_config'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_auth', t);
    execute format(
      'create policy %I on %I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t
    );
  end loop;
end $$;

-- ============================================================
-- Realtime para el dashboard (ignora el error si ya estaban agregadas)
-- ============================================================
do $$
begin
  begin
    alter publication supabase_realtime add table radar_mensajes;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table radar_alertas;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table radar_estado;
  exception when duplicate_object then null;
  end;
end $$;

-- ============================================================
-- Bucket de Storage para media de WhatsApp (fotos de vouchers, PDFs, audios)
-- Público para lectura (URLs en el dashboard); solo el worker sube (service-role).
-- ============================================================
insert into storage.buckets (id, name, public)
values ('radar-media', 'radar-media', true)
on conflict (id) do nothing;
