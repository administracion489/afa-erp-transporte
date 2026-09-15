-- supabase/whatsapp-coexistencia.sql — Coexistencia de WhatsApp (app del celular + Cloud API)
-- Correr una vez en el editor SQL de Supabase. Idempotente.
-- Prerrequisito: supabase/whatsapp-numeros.sql y supabase/crm-schema.sql.
--
-- ============================================================================
-- QUÉ ES LA COEXISTENCIA Y POR QUÉ HACÍA FALTA ESTO
-- ============================================================================
-- Meta permite que un MISMO número siga en la app WhatsApp Business del celular y
-- a la vez esté conectado a la Cloud API. El dueño sigue contestando desde el
-- teléfono como siempre, y el ERP ve esa misma conversación. No se desvincula
-- nada: no es el QR de WhatsApp Web, es el onboarding oficial de Meta.
--
-- Solo lo puede ofrecer un Tech Provider aprobado — AFA lo es desde ago-2026, y
-- por eso esta migración existe ahora y no antes.
--
-- Los tres números de AFA, para no confundirlos nunca:
--   +51 966 707 225  Atención al cliente (CRM)  → API OFICIAL, en COEXISTENCIA
--   +51 905 438 216  Notificaciones / avisos    → API OFICIAL
--   +51 997 683 199  Radar IA                   → Baileys/QR, número dedicado aparte
--                                                 (radar-worker/, NO tocar desde aquí)
--
-- ============================================================================
-- LO QUE LA COEXISTENCIA TRAE Y EL ESQUEMA NO SABÍA GUARDAR
-- ============================================================================
-- 1. `smb_message_echoes` — lo que el dueño responde DESDE EL CELULAR llega por
--    webhook. Es un mensaje SALIENTE que nadie escribió en el ERP: hay que poder
--    distinguirlo de uno enviado por la API, o el agente IA creería que contestó
--    él y el Inbox mostraría autores falsos.
-- 2. `history` — Meta reenvía hasta 6 meses de conversaciones al onboardear. Son
--    mensajes viejos: no deben disparar la IA ni contar como "no leídos".
-- 3. Un **business token por empresa**. Hasta hoy todo colgaba de un único
--    META_WA_TOKEN (el system user de AFA). Al vender el ERP, cada cliente que
--    complete el Embedded Signup devuelve SU token, y hay que guardarlo cifrado.
-- ============================================================================

-- ============================================================
-- 1) Tokens de negocio, en su propia tabla y CIFRADOS
-- ============================================================
-- No van como columna de `whatsapp_numeros` a propósito: esa tabla la lee
-- cualquier usuario autenticado (el Inbox necesita los alias) y su propio
-- comentario promete que "el token no está aquí". Un business token permite
-- mandar mensajes en nombre de la empresa y leer sus conversaciones; se guarda
-- aparte, cifrado con AES-256-GCM por lib/meta-tokens.ts, y sin política de RLS
-- permisiva: solo el service-role lo toca.
create table if not exists public.whatsapp_tokens (
  id uuid primary key default gen_random_uuid(),

  -- A qué número pertenece. Se referencia por phone_number_id (el id de Meta) y no
  -- por el uuid de la fila, para poder guardar el token en el mismo paso del
  -- onboarding en que aún se está creando/actualizando el número.
  phone_number_id text not null unique,
  waba_id text,

  -- Multi-empresa: al vender el ERP cada cliente trae su WABA y su token.
  tenant text not null default 'afa',

  -- Ciphertext en base64 producido por lib/meta-tokens.ts (iv + tag + datos).
  -- NUNCA guardar aquí el token en claro.
  token_cifrado text not null,

  -- Meta devuelve business tokens de larga duración (sin expiración salvo
  -- revocación), pero manda `expires_in` igual: se guarda para poder avisar.
  expira_en timestamptz,

  actualizado_en timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.whatsapp_tokens is
  'Business integration system user access tokens por número, cifrados (AES-256-GCM). Deny-all: solo service-role.';

alter table public.whatsapp_tokens enable row level security;
-- Sin política permisiva a propósito: RLS activo y ninguna policy = nadie que no
-- sea service-role puede leerlo, ni siquiera un usuario autenticado del ERP.
drop policy if exists wa_tokens_auth on public.whatsapp_tokens;

-- ============================================================
-- 2) Estado de coexistencia de cada número
-- ============================================================
alter table public.whatsapp_numeros
  -- ¿Este número está en coexistencia (sigue en el celular) o es API pura?
  add column if not exists es_coexistencia boolean not null default false,

  -- Última verificación contra Meta:
  --   GET /{phone_number_id}?fields=is_on_biz_app,platform_type
  add column if not exists is_on_biz_app boolean,
  add column if not exists platform_type text,

  -- Onboarding: pendiente → activando → activo | error.
  add column if not exists onboarding_estado text not null default 'pendiente',
  add column if not exists onboarding_detalle text,
  add column if not exists onboarding_en timestamptz,

  -- Meta da 24 h desde el onboarding para pedir la sincronización del historial;
  -- pasado ese plazo hay que dar de baja el número y repetir el proceso. Guardar
  -- cuándo se pidió es lo que permite avisarlo a tiempo en vez de descubrirlo tarde.
  add column if not exists historial_solicitado_en timestamptz,
  add column if not exists contactos_solicitados_en timestamptz,

  -- Multi-empresa, igual que en whatsapp_tokens.
  add column if not exists tenant text not null default 'afa';

comment on column public.whatsapp_numeros.es_coexistencia is
  'true = el número sigue usándose en la app WhatsApp Business del celular y además está en la Cloud API.';
comment on column public.whatsapp_numeros.historial_solicitado_en is
  'Cuándo se pidió POST /{phone_number_id}/smb_app_data sync_type=history. Meta solo lo acepta dentro de las 24 h del onboarding.';

-- ============================================================
-- 3) De dónde salió cada mensaje del CRM
-- ============================================================
-- Sin esto, un mensaje que el dueño escribió desde el celular (echo) entraría al
-- Inbox indistinguible de uno enviado por el ERP. Importa por tres razones:
--   · el agente IA cuenta sus propios turnos (`generado_por_ia`) y no debe
--     confundir con los suyos los mensajes de una persona;
--   · el historial de 6 meses no debe marcar conversaciones como no leídas;
--   · quien atiende necesita ver quién contestó, y desde dónde.
alter table public.crm_mensajes
  add column if not exists origen text not null default 'api';

comment on column public.crm_mensajes.origen is
  'api = enviado por el ERP · app_movil = echo, lo escribió una persona desde el celular · historial = backfill de 6 meses al onboardear · entrante = del cliente.';

alter table public.crm_conversaciones
  add column if not exists historial_importado boolean not null default false;

-- ============================================================
-- 3.b) Que la IA no le hable encima a quien contesta desde el celular
-- ============================================================
-- Esto es NUEVO con la coexistencia y no existía antes: hasta ahora, si el agente
-- IA estaba activo, era el único que respondía por WhatsApp. Ahora el dueño puede
-- estar contestando el mismo chat desde el teléfono, y el cliente recibiría dos
-- respuestas distintas al mismo mensaje.
--
-- Por defecto ACTIVADO: en cuanto llega un echo (alguien escribió desde el
-- celular), ese hilo queda con ia_pausada = true y la persona sigue al mando.
-- Se reanuda desde el Inbox, con el mismo botón de siempre.
alter table public.crm_agentes_ia
  add column if not exists pausar_si_responde_humano boolean not null default true;

comment on column public.crm_agentes_ia.pausar_si_responde_humano is
  'Coexistencia: si alguien responde desde la app del celular, se pausa la IA en ese hilo para no contestar dos veces.';

-- Las filas anteriores a esta migración son todas de la API.
update public.crm_mensajes set origen = 'api' where origen is null;

-- El backfill del historial inserta miles de filas de golpe y cada una se
-- deduplica por meta_message_id (que ya es UNIQUE). El índice de conversación +
-- fecha es el que usa el Inbox para pintar el hilo; sin él, un hilo con 6 meses
-- importados tarda en abrir.
create index if not exists idx_crm_msg_conv_fecha
  on public.crm_mensajes (conversacion_id, created_at desc);
create index if not exists idx_crm_msg_origen
  on public.crm_mensajes (origen) where origen <> 'api';

-- ============================================================
-- 4) Verificación
-- ============================================================
select alias,
       display_phone_number,
       es_coexistencia,
       onboarding_estado,
       coalesce(platform_type, '—')             as platform_type,
       (select count(*) from public.whatsapp_tokens t
         where t.phone_number_id = n.phone_number_id) as tiene_token
  from public.whatsapp_numeros n
 order by alias;
