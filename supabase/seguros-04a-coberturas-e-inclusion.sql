-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-04a-coberturas-e-inclusion.sql · Una póliza puede cubrir VARIOS
-- tipos de persona, y una inclusión puede estar SOLICITADA y aún no hecha.
-- (NO la corre el deploy: Supabase → SQL Editor → Run, DESPUÉS de seguros-01..03
-- y ANTES de seguros-04b. Idempotente. Explicación larga: seguros-04-notas.md.)
--
-- seguros.coberturas text[]  → los tipos que cubre esa póliza (SCTR salud +
--   pensión + Vida Ley en un solo contrato). null = solo `tipo` (lo de siempre).
--   SIN backfill: que una póliza cubra más de un tipo lo declara una persona.
-- seguro_cobertura.estado     → null = incluida (lo de siempre) | 'solicitada'
--   (se pidió a la aseguradora, aún no cubre) | 'incluida' | 'excluida' (baja,
--   exige `hasta`). solicitada_en, constancia_url y nota: el rastro del trámite.
-- SI NO SE CORRE: todo sigue igual; el código debe soltar estas columnas si el
-- error las nombra, y seguros-04b no se puede crear.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.seguros add column if not exists coberturas text[];

alter table public.seguro_cobertura add column if not exists estado        text;
alter table public.seguro_cobertura add column if not exists solicitada_en date;
alter table public.seguro_cobertura add column if not exists constancia_url text;
alter table public.seguro_cobertura add column if not exists nota          text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_seguros_coberturas') then
    alter table public.seguros add constraint ck_seguros_coberturas check (
      coberturas is null or (
        cardinality(coberturas) between 1 and 3
        and coberturas <@ array['sctr_salud','sctr_pension','vida_ley']::text[]
        and tipo = any(coberturas)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_seg_cob_estado') then
    alter table public.seguro_cobertura add constraint ck_seg_cob_estado
      check (estado is null or estado in ('solicitada','incluida','excluida'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_seg_cob_excluida_hasta') then
    alter table public.seguro_cobertura add constraint ck_seg_cob_excluida_hasta
      check (estado is distinct from 'excluida' or hasta is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_seg_cob_solicitada_fecha') then
    alter table public.seguro_cobertura add constraint ck_seg_cob_solicitada_fecha
      check (estado is distinct from 'solicitada' or solicitada_en is not null);
  end if;
end $$;

-- "¿Qué inclusiones siguen pedidas y sin confirmar?" — la bandeja del trámite.
create index if not exists idx_seg_cob_solicitada on public.seguro_cobertura (seguro_id)
  where estado = 'solicitada';

-- Verificación:
-- select conname from pg_constraint where conname like 'ck_seg%' order by 1;
-- select count(*) from public.seguros where coberturas is not null;  -- 0 tras correrla

-- FIN de seguros-04a-coberturas-e-inclusion.sql
