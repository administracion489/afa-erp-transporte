-- Autoservicio de documentos para Empresas Tercerizadas (proveedores).
--
-- Objetivo: el proveedor recibe un correo/WhatsApp cuando un documento obligatorio está por
-- vencer o ya venció, con un link para subir el documento actualizado él mismo. ESE documento
-- NO reemplaza el vigente en `documentos_tercero` de inmediato: entra a una cola de revisión
-- (`documentos_tercero_revisiones`) y el ERP sigue mostrando "por vencer"/"vencido" con los
-- datos viejos hasta que un operador lo aprueba desde /tercerizadas. Rechazar no cambia nada.
--
-- Idempotente: se puede correr las veces que haga falta.

-- ── Config del módulo (fila única) ──────────────────────────────────────────────
create table if not exists public.config_proveedores_docs (
  id             int primary key default 1,
  activo         boolean not null default true,
  correos_alerta text,   -- operación interna: se avisa aquí cuando un proveedor sube algo nuevo
  constraint config_proveedores_docs_singleton check (id = 1)
);
insert into public.config_proveedores_docs (id) values (1) on conflict (id) do nothing;

-- ── Token de acceso al formulario público ───────────────────────────────────────
-- Uno vigente por empresa (se reutiliza mientras no expire); el cron genera uno nuevo si el
-- último ya venció. Es la ÚNICA autorización del link: largo, aleatorio, sin sesión.
create table if not exists public.proveedor_tokens (
  id         bigint generated always as identity primary key,
  empresa_id bigint not null references public.empresas_tercerizadas(id) on delete cascade,
  token      text not null unique,
  creado_en  timestamptz not null default now(),
  expira_en  timestamptz not null
);
create index if not exists idx_proveedor_tokens_empresa on public.proveedor_tokens(empresa_id);
create index if not exists idx_proveedor_tokens_vigencia on public.proveedor_tokens(empresa_id, expira_en);

-- ── Cola de revisión ─────────────────────────────────────────────────────────────
-- Lo que sube el proveedor cae ACÁ, no en documentos_tercero. `documento_id` referencia el
-- registro que reemplazaría (null = documento obligatorio que nunca se había cargado).
create table if not exists public.documentos_tercero_revisiones (
  id                        bigint generated always as identity primary key,
  empresa_id                bigint not null references public.empresas_tercerizadas(id) on delete cascade,
  documento_id              bigint references public.documentos_tercero(id) on delete set null,
  vehiculo_id               bigint references public.vehiculos_tercero(id) on delete set null,
  tipo                      text not null,
  numero                    text,
  fecha_vencimiento_actual  date,   -- copia de lo que había al momento de subir (para comparar en la revisión)
  fecha_vencimiento_propuesta date,
  entidad_emisora           text,
  archivo_url               text not null,
  observaciones_proveedor   text,
  estado                    text not null default 'pendiente' check (estado in ('pendiente','aprobado','rechazado')),
  motivo_rechazo            text,
  creado_en                 timestamptz not null default now(),
  revisado_en               timestamptz,
  revisado_por              text
);
create index if not exists idx_doc_terc_revisiones_estado  on public.documentos_tercero_revisiones(estado);
create index if not exists idx_doc_terc_revisiones_empresa on public.documentos_tercero_revisiones(empresa_id);

-- ── Log de avisos enviados (dedupe del cron) ────────────────────────────────────
-- `clave_doc` identifica QUÉ vencimiento se avisó dentro de la empresa: "doc:<id>" para un
-- documento de documentos_tercero, "auth_mtc" / "hab_sutran" para las habilitaciones propias
-- de la empresa. Mismo espíritu que `notificaciones_enviadas` (dedupe de reservas).
create table if not exists public.documentos_tercero_avisos (
  id                bigint generated always as identity primary key,
  empresa_id        bigint not null references public.empresas_tercerizadas(id) on delete cascade,
  clave_doc         text not null,
  fecha_vencimiento date,
  dias_para_vencer  int,
  canal             text not null,   -- 'email' | 'whatsapp'
  estado            text not null,   -- 'enviado' | 'error' | 'sin_canal'
  detalle           text,
  trigger_origen    text not null default 'cron_documentos_proveedor',
  creado_en         timestamptz not null default now()
);
create index if not exists idx_doc_terc_avisos_dedupe on public.documentos_tercero_avisos(empresa_id, clave_doc, creado_en);

-- Nota sobre almacenamiento: los archivos que sube el proveedor van al bucket PÚBLICO
-- "documentos" (el mismo que ya usa Mantenimiento > Planes), bajo el prefijo
-- `proveedores/<empresa_id>/...`. No hace falta crear un bucket nuevo ni políticas de storage:
-- la subida SIEMPRE pasa por /api/tercerizadas/documentos-proveedor con service-role, nunca
-- desde el navegador del proveedor.

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY · y por qué NO es la política de siempre en las cuatro
--
-- Este archivo no traía RLS, y el editor de Supabase lo canta al ejecutarlo ("This query
-- creates tables without enabling Row Level Security"). Sus dos botones se quedan cortos, los
-- dos en la misma dirección: "Run without RLS" deja `proveedor_tokens` legible por cualquiera
-- con la anon key, y "Run and enable RLS" enciende RLS SIN POLÍTICAS, con lo que el panel de
-- revisiones de /tercerizadas se queda mudo. Ni una ni otra: cada tabla necesita lo suyo.
--
-- QUIÉN TOCA QUÉ (verificado con grep sobre app/ y lib/, tabla por tabla):
--
--   tabla                          navegador (anon)   servidor (service-role)
--   ─────────────────────────────  ─────────────────  ───────────────────────
--   documentos_tercero_revisiones  SÍ · lee, aprueba  sí
--   proveedor_tokens               NO                 sí
--   config_proveedores_docs        NO                 sí
--   documentos_tercero_avisos      NO                 sí
--
-- RLS se enciende en las CUATRO. La política de `authenticated` va SOLO en la primera, que es
-- la única que el navegador necesita. Las otras tres se quedan con RLS y SIN política: el
-- service-role se salta RLS por diseño, así que el cron y las rutas de API siguen igual, y
-- la anon key no ve nada.
--
-- POR QUÉ `proveedor_tokens` NO LLEVA LA POLÍTICA DE `authenticated`, aunque el resto del
-- repo la ponga en todo: ESOS TOKENS SON LA ÚNICA AUTENTICACIÓN DEL PORTAL PÚBLICO. Cada
-- fila es la llave del formulario donde un proveedor sube sus documentos. Dejarla legible
-- —aunque sea solo a usuarios con sesión— es repartir las llaves de todos los proveedores a
-- cualquiera que consiga una cuenta. Ninguna pantalla los necesita: se leen y se escriben
-- exclusivamente desde el servidor.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.documentos_tercero_revisiones enable row level security;
alter table public.proveedor_tokens              enable row level security;
alter table public.config_proveedores_docs       enable row level security;
alter table public.documentos_tercero_avisos     enable row level security;

-- La única que se abre al navegador: /tercerizadas lista las revisiones pendientes y un
-- operador las aprueba o las rechaza desde ahí.
drop policy if exists doc_terc_revisiones_auth on public.documentos_tercero_revisiones;
create policy doc_terc_revisiones_auth on public.documentos_tercero_revisiones
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Las otras tres se quedan a propósito SIN política. No es un olvido: es la diferencia entre
-- "el servidor puede" y "cualquiera con sesión puede". Si algún día una pantalla necesita
-- leerlas, se agrega su política aquí y se dice a qué pantalla sirve — nunca "por si acaso".
