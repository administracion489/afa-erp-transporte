-- supabase/radar-ia-relink.sql — botón "Generar QR nuevo" en /radar-ia.
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase.
--
-- Antes, la única forma de forzar un QR nuevo era borrar radar-worker/auth/ y reiniciar
-- el proceso a mano. Ahora el dashboard solo prende esta bandera; el worker la revisa
-- cada pocos segundos y, si está prendida, cierra su sesión de WhatsApp (lo que dispara
-- el mismo flujo de "sesión cerrada" que ya limpia las credenciales y pide un QR nuevo).

alter table radar_estado add column if not exists solicitar_relink boolean not null default false;
