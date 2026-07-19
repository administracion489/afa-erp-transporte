-- supabase/checkin-checkout-foto.sql — Fase 3: foto de odómetro OBLIGATORIA + guardada + anti-trampa.
-- Incremental e idempotente. Correr DESPUÉS de supabase/checkin-checkout-jornada.sql.
--
-- La foto es evidencia; pero la foto SOLA no evita el km inventado (el conductor puede fotografiar
-- cualquier tablero y teclear otro número). Por eso se guarda TAMBIÉN lo que leyó la IA (km_ocr) para
-- cruzarlo con lo que quedó registrado, + GPS y hora de captura. La defensa dura contra el número
-- inventado sigue siendo el anti-retroceso de lib/odometro.ts (evaluarLectura).

-- Check-in (checklist_conductor ya existe; no tenía foto).
alter table checklist_conductor add column if not exists foto_url     text;
alter table checklist_conductor add column if not exists km_ocr       int;          -- km que leyó la IA (para cruzar con km_inicio)
alter table checklist_conductor add column if not exists gps_lat      numeric;
alter table checklist_conductor add column if not exists gps_lng      numeric;
alter table checklist_conductor add column if not exists capturado_en timestamptz;  -- hora de captura en el celular (no del archivo)

-- Check-out (checkout_conductor.foto_url ya existe desde checkin-checkout-jornada.sql).
alter table checkout_conductor  add column if not exists km_ocr          int;
alter table checkout_conductor  add column if not exists gps_lat         numeric;
alter table checkout_conductor  add column if not exists gps_lng         numeric;
alter table checkout_conductor  add column if not exists capturado_en    timestamptz;
alter table checkout_conductor  add column if not exists sin_foto_motivo text;       -- 'taller'|'averia'|'tablero_apagado'|'unidad_entregada' cuando se cierra sin foto
