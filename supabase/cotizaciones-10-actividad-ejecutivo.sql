-- cotizaciones-10-actividad-ejecutivo.sql — Cuándo tocó una PERSONA la cotización por última vez.
--   La IA de traslados usa una cotización que una persona corrigió (el pedido del adelanto, su reenvío,
--   las políticas, el «ya te la envié» con el total) solo cuando pasó la pausa del ejecutivo
--   (`crm_agentes_ia.pausa_humano_horas`) desde esa corrección, o si se reactivó la IA en el chat
--   después (lib/traslados/cotizacion-corregida.ts). Esa hora la deja aquí la base:
--   · cotizaciones.editada_at (timestamptz) y editada_por (uuid): las escribe un trigger en todo INSERT
--     o UPDATE hecho con la sesión de una persona (PostgREST con su JWT: auth.uid() no es null). Lo que
--     mande el navegador en esas columnas se PISA: una sesión no puede fecharla hacia atrás.
--   · El servidor (service-role) y el SQL Editor no tienen auth.uid(): sus cambios no las tocan (la fila
--     conserva lo que tenía). Así un cambio del sistema —el cambio de clave de una categoría, «Vincular
--     cliente» de la tarjeta— no cuenta como actividad de una persona.
--   · Las cotizaciones que YA existen quedan con editada_at = el momento de correr este SQL: no se sabe
--     cuándo las tocaron, y ese es el tope. Se hace con un DEFAULT que se retira enseguida (PostgreSQL
--     guarda el valor de las filas viejas sin reescribir la tabla ni disparar triggers); solo la PRIMERA
--     vez, al crear la columna: volver a correrlo no vuelve a fecharlas.
-- Sin este SQL, la IA no usa ninguna cotización corregida (no sabe cuándo se corrigió) y el adelanto lo
-- pide el ejecutivo desde la tarjeta. No cambia nada de una cotización que nadie corrigió.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente.

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'cotizaciones' and column_name = 'editada_at') then
    alter table public.cotizaciones add column editada_at timestamptz default now();
    alter table public.cotizaciones alter column editada_at drop default;
  end if;
end $$;

alter table public.cotizaciones add column if not exists editada_por uuid;

comment on column public.cotizaciones.editada_at is
  'Última vez que una PERSONA (sesión del ERP) creó o cambió la cotización; la pone el trigger trg_cotizaciones_actividad_persona. NULL = ninguna persona (sesión del ERP) la tocó desde que existe la columna. Las que ya existían al crearla tienen la hora de la migración (no se sabe cuándo las tocaron: es el tope).';
comment on column public.cotizaciones.editada_por is
  'La persona (auth.uid()) de editada_at. NULL = ninguna persona (sesión del ERP) la tocó desde que existe la columna.';

create or replace function public.fn_cotizaciones_actividad_persona()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  quien uuid := auth.uid();
begin
  -- Solo la sesión de una persona: lo que mande en estas columnas se pisa con la hora y su id.
  if quien is not null then
    new.editada_at := now();
    new.editada_por := quien;
  end if;
  -- El servidor y el SQL Editor (sin auth.uid()) no las tocan: queda lo que venía en la fila.
  return new;
end;
$$;

revoke all on function public.fn_cotizaciones_actividad_persona() from public, anon, authenticated;

drop trigger if exists trg_cotizaciones_actividad_persona on public.cotizaciones;
create trigger trg_cotizaciones_actividad_persona
  before insert or update on public.cotizaciones
  for each row execute function public.fn_cotizaciones_actividad_persona();

-- Volver atrás (la IA deja de usar cotizaciones corregidas hasta que se vuelva a correr):
--   drop trigger if exists trg_cotizaciones_actividad_persona on public.cotizaciones;
--   drop function if exists public.fn_cotizaciones_actividad_persona();
--   alter table public.cotizaciones drop column if exists editada_por, drop column if exists editada_at;

-- Comprobación (solo lee).
select count(*) as cotizaciones,
       count(editada_at) as con_editada_at,
       count(*) filter (where editada_at is null) as sin_editada_at,
       count(editada_por) as con_editada_por,
       (select count(*) from pg_trigger where tgname = 'trg_cotizaciones_actividad_persona' and not tgisinternal) as triggers
  from public.cotizaciones;

-- FIN de cotizaciones-10-actividad-ejecutivo
