-- ============================================================
-- CRM AFA Transportes — ejecutar en Supabase SQL Editor
-- ============================================================

-- Contactos / prospectos
CREATE TABLE IF NOT EXISTS crm_contactos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       TEXT NOT NULL,
  empresa      TEXT,
  cargo        TEXT,
  telefono     TEXT,
  email        TEXT,
  canal_origen TEXT DEFAULT 'manual', -- whatsapp|messenger|instagram|gmail|llamada|manual
  wa_id        TEXT UNIQUE,           -- WhatsApp phone number / sender ID
  fb_psid      TEXT UNIQUE,           -- Facebook Page Scoped ID
  ig_id        TEXT UNIQUE,           -- Instagram Scoped ID
  gmail_email  TEXT,
  asignado_a   UUID REFERENCES usuarios(id),
  cliente_id   INT,                   -- enlace a tabla clientes si se convierte
  notas        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Conversaciones (un hilo por canal por contacto)
CREATE TABLE IF NOT EXISTS crm_conversaciones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto_id       UUID REFERENCES crm_contactos(id) ON DELETE CASCADE,
  canal             TEXT NOT NULL,          -- whatsapp|messenger|instagram|gmail|llamada
  estado            TEXT DEFAULT 'abierta', -- abierta|en_progreso|resuelta|spam
  asignado_a        UUID REFERENCES usuarios(id),
  asunto            TEXT,                   -- para hilos de email
  gmail_thread_id   TEXT,
  ultimo_mensaje_at TIMESTAMPTZ,
  no_leidos         INT DEFAULT 0,
  pipeline_id       UUID,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Mensajes individuales
CREATE TABLE IF NOT EXISTS crm_mensajes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  UUID REFERENCES crm_conversaciones(id) ON DELETE CASCADE,
  direccion        TEXT NOT NULL,           -- entrante|saliente
  tipo             TEXT DEFAULT 'texto',    -- texto|imagen|audio|video|documento|llamada
  contenido        TEXT,
  media_url        TEXT,
  media_tipo       TEXT,
  meta_message_id  TEXT UNIQUE,             -- WA/Meta message ID para dedup
  gmail_message_id TEXT,
  enviado_por      UUID REFERENCES usuarios(id),
  leido            BOOLEAN DEFAULT false,
  error            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Pipeline de ventas (embudo para transporte de personal)
CREATE TABLE IF NOT EXISTS crm_pipeline (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto_id       UUID REFERENCES crm_contactos(id),
  etapa             TEXT DEFAULT 'nuevo_lead',
  -- nuevo_lead | calificando | cotizacion_enviada | negociacion | ganado | perdido
  empresa_nombre    TEXT,
  n_trabajadores    INT,
  rutas_descripcion TEXT,
  frecuencia        TEXT, -- diaria|semanal|mensual|eventual
  fecha_inicio_req  DATE,
  monto_estimado    DECIMAL(12,2),
  cotizacion_id     INT,  -- enlace a tabla cotizaciones
  reserva_id        INT,  -- enlace a tabla reservas cuando se gana
  motivo_perdida    TEXT,
  notas             TEXT,
  asignado_a        UUID REFERENCES usuarios(id),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE crm_conversaciones
  ADD CONSTRAINT fk_conv_pipeline
  FOREIGN KEY (pipeline_id) REFERENCES crm_pipeline(id);

-- Actividades / historial
CREATE TABLE IF NOT EXISTS crm_actividades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto_id   UUID REFERENCES crm_contactos(id),
  pipeline_id   UUID REFERENCES crm_pipeline(id),
  tipo          TEXT NOT NULL, -- nota|llamada|reunion|tarea|email
  descripcion   TEXT,
  fecha         TIMESTAMPTZ DEFAULT now(),
  realizado_por UUID REFERENCES usuarios(id),
  completado    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Config CRM (tokens OAuth, etc.)
CREATE TABLE IF NOT EXISTS crm_config (
  clave TEXT PRIMARY KEY,
  valor TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_crm_conv_contacto  ON crm_conversaciones(contacto_id);
CREATE INDEX IF NOT EXISTS idx_crm_conv_canal      ON crm_conversaciones(canal);
CREATE INDEX IF NOT EXISTS idx_crm_conv_estado     ON crm_conversaciones(estado);
CREATE INDEX IF NOT EXISTS idx_crm_conv_ultimo_msg ON crm_conversaciones(ultimo_mensaje_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_msg_conv        ON crm_mensajes(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_crm_msg_created     ON crm_mensajes(created_at);
CREATE INDEX IF NOT EXISTS idx_crm_pipeline_etapa  ON crm_pipeline(etapa);
CREATE INDEX IF NOT EXISTS idx_crm_contacto_wa     ON crm_contactos(wa_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacto_fb     ON crm_contactos(fb_psid);

-- RLS (igual que el resto de la app — todo usuario autenticado)
ALTER TABLE crm_contactos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_mensajes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_actividades    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_config         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_all" ON crm_contactos      FOR ALL USING (true);
CREATE POLICY "crm_all" ON crm_conversaciones  FOR ALL USING (true);
CREATE POLICY "crm_all" ON crm_mensajes        FOR ALL USING (true);
CREATE POLICY "crm_all" ON crm_pipeline        FOR ALL USING (true);
CREATE POLICY "crm_all" ON crm_actividades     FOR ALL USING (true);
CREATE POLICY "crm_config_all" ON crm_config   FOR ALL USING (true);
