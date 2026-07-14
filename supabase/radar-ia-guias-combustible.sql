-- supabase/radar-ia-guias-combustible.sql — guías de lectura para vouchers y odómetro.
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase.
--
-- Problema real: cada vehículo tiene un tablero distinto (el odómetro no está en el
-- mismo lugar ni con el mismo formato), y algunos vouchers de grifo tienen particularidades
-- (p.ej. el monto real dice "TOTAL" y no "SUBTOTAL"). Esto deja que el operador le explique
-- a ELIA, en texto simple, cómo leer cada cosa — se inyecta en la extracción con visión.

alter table radar_config add column if not exists guia_voucher text;
alter table vehiculos add column if not exists guia_odometro text;
alter table vehiculos_tercero add column if not exists guia_odometro text;
