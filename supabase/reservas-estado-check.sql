-- ──────────────────────────────────────────────────────────────────────────────
-- Blindaje de reservas.estado al enum canónico (dimensión A · lib/estados.ts)
--
-- Valores válidos: pendiente · programada · confirmada · en_curso · finalizada · cancelada
--
-- AUDITORÍA PREVIA (jun-2026): SELECT estado, count(*) FROM reservas GROUP BY estado
-- devolvió SOLO valores canónicos (confirmada 303, finalizada 57, en_curso 12,
-- cancelada 4, programada 1). Sin basura → NO se requiere migración de normalización.
-- Si en el futuro este script falla al crear el CHECK, es señal de que entró un valor
-- fuera del enum: corre el GROUP BY de arriba para ubicarlo antes de reintentar.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

alter table public.reservas drop constraint if exists reservas_estado_check;

alter table public.reservas
  add constraint reservas_estado_check
  check (estado in ('pendiente','programada','confirmada','en_curso','finalizada','cancelada'));
