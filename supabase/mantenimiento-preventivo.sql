-- ============================================================
-- AFA Transportes — Mantenimiento Preventivo
-- Plan del fabricante (IA) + odómetro consolidado + alertas por correo
-- Ejecutar en Supabase SQL Editor.
-- ============================================================

-- ── 0. Nº de serie / chasis en vehículos (lo pide la plantilla del Excel) ─────
ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS nro_serie TEXT;

-- ── 1. Planes de mantenimiento del fabricante (por modelo) ────────────────────
CREATE TABLE IF NOT EXISTS planes_mantenimiento (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marca                TEXT NOT NULL,
  modelo               TEXT NOT NULL,
  motor                TEXT,                       -- ej. "2.7L"
  anio_desde           INT,
  anio_hasta           INT,
  intervalo_base_km    INT,                        -- servicio cada X km (ej. 5000)
  intervalo_base_meses INT,                        -- servicio cada X meses (ej. 6)
  fuente_doc_url       TEXT,                       -- foto/PDF original del fabricante
  parsed_por_ia        BOOLEAN DEFAULT false,
  estado               TEXT DEFAULT 'borrador',    -- borrador | aprobado
  notas                TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- ── 2. Tareas del plan (la matriz tarea × hito de km del fabricante) ──────────
CREATE TABLE IF NOT EXISTS plan_tareas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID REFERENCES planes_mantenimiento(id) ON DELETE CASCADE,
  orden           INT DEFAULT 0,
  tarea           TEXT NOT NULL,                   -- ej. "Aceite Motor"
  especificacion  TEXT,                            -- ej. "5W-30 API SN"
  categoria       TEXT,                            -- Fluidos | Repuestos | Inspección | ...
  unidad          TEXT,
  cantidad        NUMERIC,
  km_intervalo    INT,                             -- cambio cada X km (derivado, si aplica)
  meses_intervalo INT,                             -- cambio cada X meses (si aplica)
  cada_servicio   BOOLEAN DEFAULT false,           -- "R" — se realiza en cada servicio
  acciones        JSONB DEFAULT '[]'::jsonb,       -- [{"km":5000,"accion":"C"},...] fidelidad completa
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_tareas_plan ON plan_tareas(plan_id);

-- ── 3. Enrolamiento de vehículos a un plan (+ ancla de cálculo) ───────────────
CREATE TABLE IF NOT EXISTS vehiculos_plan (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehiculo_id INT REFERENCES vehiculos(id) ON DELETE CASCADE,
  plan_id     UUID REFERENCES planes_mantenimiento(id) ON DELETE CASCADE,
  activo      BOOLEAN DEFAULT true,
  km_base     INT,                                 -- km del último servicio conocido (ancla)
  fecha_base  DATE,                                -- fecha del último servicio conocido (ancla)
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (vehiculo_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_vehiculos_plan_veh ON vehiculos_plan(vehiculo_id);

-- ── 4. Historial de lecturas de odómetro (con procedencia) ────────────────────
CREATE TABLE IF NOT EXISTS lecturas_odometro (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehiculo_id INT REFERENCES vehiculos(id) ON DELETE CASCADE,
  km          INT NOT NULL,
  fuente      TEXT NOT NULL,        -- combustible | checklist | servicio | whatsapp_foto | whatsapp_manual | manual
  fecha       DATE DEFAULT (now() AT TIME ZONE 'America/Lima')::date,
  foto_url    TEXT,
  ref_origen  TEXT,                 -- referencia al registro origen (ej. "combustible:123")
  estado      TEXT DEFAULT 'aceptada', -- aceptada | sospechosa | rechazada | reinicio
  motivo      TEXT,                 -- por qué quedó marcada
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lecturas_odometro_veh ON lecturas_odometro(vehiculo_id, fecha DESC);

-- ── 5. Configuración de alertas de mantenimiento (fila única id=1) ────────────
CREATE TABLE IF NOT EXISTS config_mantenimiento (
  id                  INT PRIMARY KEY DEFAULT 1,
  correos_alerta      TEXT,                  -- destinatarios separados por coma
  umbral_km           INT DEFAULT 500,       -- avisar cuando falten ≤ X km
  umbral_dias         INT DEFAULT 7,         -- avisar cuando falten ≤ X días
  km_dia_max          INT DEFAULT 1500,      -- tope de plausibilidad (km/día) del odómetro
  alertas_activas     BOOLEAN DEFAULT true,
  ultima_alerta_fecha DATE,                  -- dedupe: último día (Lima) en que se envió
  updated_at          TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT config_mantenimiento_unica CHECK (id = 1)
);
INSERT INTO config_mantenimiento (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 6. RLS (mismo patrón permisivo que el resto de la app) ────────────────────
ALTER TABLE planes_mantenimiento ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_tareas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehiculos_plan       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lecturas_odometro    ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_mantenimiento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "planes_all"     ON planes_mantenimiento;
DROP POLICY IF EXISTS "tareas_all"     ON plan_tareas;
DROP POLICY IF EXISTS "vehplan_all"    ON vehiculos_plan;
DROP POLICY IF EXISTS "lecturas_all"   ON lecturas_odometro;
DROP POLICY IF EXISTS "configmant_all" ON config_mantenimiento;
CREATE POLICY "planes_all"     ON planes_mantenimiento FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "tareas_all"     ON plan_tareas          FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "vehplan_all"    ON vehiculos_plan       FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "lecturas_all"   ON lecturas_odometro    FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "configmant_all" ON config_mantenimiento FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
