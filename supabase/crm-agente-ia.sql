-- ============================================================
-- CRM AFA Transportes — Agente IA (Claude)
-- Ejecutar en Supabase SQL Editor después de crm-schema.sql
-- ============================================================

-- ── Configuración del agente (estilo "Conversation AI" de Zolutium) ──────────
-- Una fila = un agente. La app usa el primer agente activo.
CREATE TABLE IF NOT EXISTS crm_agentes_ia (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            TEXT NOT NULL DEFAULT 'Asistente AFA',
  activo            BOOLEAN DEFAULT false,
  modelo            TEXT DEFAULT 'claude-opus-4-8',  -- claude-opus-4-8 | claude-sonnet-4-6 | claude-haiku-4-5

  -- Personalidad
  persona           TEXT,    -- rol y tono ("Eres el asistente comercial de AFA…")
  empresa_contexto  TEXT,    -- info de la empresa que el bot debe conocer
  idioma            TEXT DEFAULT 'es',

  -- Goals (objetivos): array de { titulo, instrucciones }
  goals             JSONB DEFAULT '[]'::jsonb,

  -- Base de conocimiento (FAQ, políticas, info de rutas en texto libre)
  conocimiento      TEXT,

  -- Canales donde el agente genera respuesta
  canales           JSONB DEFAULT '["whatsapp"]'::jsonb,
  -- Subconjunto de "canales" donde envía SOLO (sin aprobación humana)
  canales_autonomos JSONB DEFAULT '[]'::jsonb,

  -- Ajustes
  horario_activo    BOOLEAN DEFAULT false,   -- restringir autonomía a horario laboral
  hora_inicio       TEXT DEFAULT '08:00',
  hora_fin          TEXT DEFAULT '20:00',
  delay_segundos    INT DEFAULT 0,           -- espera antes de responder (parecer humano)
  max_turnos_auto   INT DEFAULT 0,           -- tras N turnos de IA, escala a humano (0 = ilimitado)
  escalar_si        TEXT,                    -- frases que fuerzan escalamiento (separadas por coma)
  firma             TEXT,                    -- firma que se añade al final del mensaje

  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ── Acciones propuestas por la IA que requieren confirmación humana ───────────
CREATE TABLE IF NOT EXISTS crm_acciones_ia (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id UUID REFERENCES crm_conversaciones(id) ON DELETE CASCADE,
  contacto_id     UUID REFERENCES crm_contactos(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,             -- 'cotizacion' | 'reserva'
  resumen         TEXT,                      -- resumen legible para el humano
  payload         JSONB DEFAULT '{}'::jsonb, -- propuesta estructurada
  estado          TEXT DEFAULT 'pendiente',  -- pendiente | aprobada | rechazada
  resultado_tipo  TEXT,                      -- 'cotizaciones' | 'reservas' (tabla creada al aprobar)
  resultado_id    INT,                       -- id del registro creado
  creada_at       TIMESTAMPTZ DEFAULT now(),
  resuelta_at     TIMESTAMPTZ,
  resuelta_por    UUID REFERENCES usuarios(id)
);

-- ── Columnas nuevas en conversaciones (borrador IA + pausa por hilo) ──────────
ALTER TABLE crm_conversaciones ADD COLUMN IF NOT EXISTS ia_pausada     BOOLEAN DEFAULT false;
ALTER TABLE crm_conversaciones ADD COLUMN IF NOT EXISTS borrador_ia    TEXT;
ALTER TABLE crm_conversaciones ADD COLUMN IF NOT EXISTS borrador_ia_at TIMESTAMPTZ;

-- ── Marcar mensajes generados por IA ─────────────────────────────────────────
ALTER TABLE crm_mensajes ADD COLUMN IF NOT EXISTS generado_por_ia BOOLEAN DEFAULT false;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_crm_acciones_conv   ON crm_acciones_ia(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_crm_acciones_estado ON crm_acciones_ia(estado);

-- ── RLS (igual que el resto del CRM — todo usuario autenticado) ───────────────
ALTER TABLE crm_agentes_ia  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_acciones_ia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_agentes_all"  ON crm_agentes_ia;
DROP POLICY IF EXISTS "crm_acciones_all" ON crm_acciones_ia;
CREATE POLICY "crm_agentes_all"  ON crm_agentes_ia  FOR ALL USING (true);
CREATE POLICY "crm_acciones_all" ON crm_acciones_ia FOR ALL USING (true);

-- ── Semilla: un agente por defecto (inactivo, listo para configurar) ──────────
INSERT INTO crm_agentes_ia (nombre, persona, empresa_contexto, goals, conocimiento)
SELECT
  'Asistente AFA',
  'Eres el asistente comercial de AFA Transportes, un operador de transporte de personal y turismo en Perú. Hablas español peruano, eres cordial, claro y profesional. Tuteas con respeto. Respuestas breves y útiles, como un buen agente de ventas por WhatsApp.',
  'AFA Transportes brinda servicios de transporte de personal (empresas), transporte turístico y traslados eventuales en Lima y todo el Perú. Flota propia y de terceros: buses, minibuses, vans y autos.',
  '[
    {"titulo":"Atender y calificar leads","instrucciones":"Saluda, identifica qué servicio necesita el cliente (personal/turismo/eventual), de dónde a dónde, fecha, cantidad de pasajeros y si es ida o ida-retorno. Registra estos datos."},
    {"titulo":"Dar cotización estimada","instrucciones":"Cuando tengas origen, destino y tipo de vehículo, usa la herramienta de cotización para dar un rango referencial. Aclara siempre que es estimado y que el equipo confirmará el precio final."},
    {"titulo":"Escalar cuando corresponda","instrucciones":"Si el cliente pide hablar con una persona, está molesto, o el caso es complejo (contrato, reclamo, licitación), escala a un humano."}
  ]'::jsonb,
  'Horario de atención comercial: Lun-Sáb 8:00-20:00. Para servicios fijos de personal se cotiza por día y mes. Los precios mostrados no incluyen IGV salvo que se indique.'
WHERE NOT EXISTS (SELECT 1 FROM crm_agentes_ia);
