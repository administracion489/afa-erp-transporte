-- ============================================================
-- Números de WhatsApp de la empresa, en la base en vez de en variables de entorno.
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- Antes cada número vivía en una env var de Vercel (META_PHONE_NUMBER_ID,
-- META_PHONE_NUMBER_ID_AVISOS) y los ids de WABA estaban escritos a mano en tres
-- archivos. Añadir un tercer número exigía tocar código y redesplegar.
--
-- El TOKEN sigue en META_WA_TOKEN y NO se guarda aquí: todos los números de AFA
-- cuelgan del mismo system user de Meta, así que un solo token los cubre. Cuando se
-- venda el ERP a otras empresas hará falta un token por cliente — ese es otro paso,
-- y guardarlo pedirá cifrado, no una columna de texto plano.
-- ============================================================

create table if not exists public.whatsapp_numeros (
  id uuid primary key default gen_random_uuid(),

  -- Id de Meta del número. Es lo que se pone en la URL al ENVIAR:
  --   POST graph.facebook.com/v25.0/{phone_number_id}/messages
  phone_number_id text not null unique,

  -- Como lo manda el webhook en value.metadata.display_phone_number: "51966707225",
  -- sin + ni espacios. Es la clave para saber por qué número entró un mensaje.
  display_phone_number text unique,

  -- Cuenta de WhatsApp Business a la que pertenece. Necesario para listar y crear
  -- plantillas (graph.facebook.com/{waba_id}/message_templates).
  waba_id text,

  -- Nombre corto para la interfaz: "Ventas", "Avisos", "Soporte".
  alias text not null,

  -- Para qué se usa. Un número puede cubrir varios usos (hoy Ventas hace CRM y
  -- campañas). Los índices de abajo garantizan que no haya dos números compitiendo
  -- por el mismo uso: sin eso el código elegiría uno al azar y los mensajes saldrían
  -- unas veces por uno y otras por otro.
  usa_crm      boolean not null default false,  -- atención al cliente + agente IA
  usa_avisos   boolean not null default false,  -- recordatorios a pasajeros/conductores
  usa_campanas boolean not null default false,  -- envíos masivos de marketing

  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Un solo número activo por uso.
create unique index if not exists uq_wa_num_crm
  on public.whatsapp_numeros (usa_crm) where usa_crm and activo;
create unique index if not exists uq_wa_num_avisos
  on public.whatsapp_numeros (usa_avisos) where usa_avisos and activo;
create unique index if not exists uq_wa_num_campanas
  on public.whatsapp_numeros (usa_campanas) where usa_campanas and activo;

alter table public.whatsapp_numeros enable row level security;

-- Lectura para usuarios autenticados (el Inbox necesita los alias). No hay datos
-- sensibles: son identificadores públicos, el token no está aquí.
drop policy if exists wa_num_lectura on public.whatsapp_numeros;
create policy wa_num_lectura on public.whatsapp_numeros
  for select to authenticated using (true);

-- La escritura pasa por el service-role (registro automático al conectar un número
-- y la pantalla de configuración), nunca por el cliente.

-- ── Sembrado ─────────────────────────────────────────────────────────────────
-- No se siembra aquí a propósito: los phone_number_id viven en las env vars de
-- Vercel y este archivo no puede leerlas. Se registran solos de dos maneras:
--   1. al conectar un número desde el CRM (el Embedded Signup devuelve los ids), o
--   2. con el botón "Detectar números" de la configuración, que los pide a Meta.
-- Mientras la tabla esté vacía, lib/whatsapp-numeros.ts cae a las env vars de
-- siempre, así que nada deja de funcionar.

-- ── Smoke test ───────────────────────────────────────────────────────────────
-- select alias, display_phone_number, phone_number_id, waba_id,
--        usa_crm, usa_avisos, usa_campanas, activo
--   from public.whatsapp_numeros order by alias;
