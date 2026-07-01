-- ──────────────────────────────────────────────────────────────────────────────
-- Folio público estable "ID AFA" para reservas:  PREFIJO-AAAA-NNNNNN
--   ej.  OS-2026-000123
--
-- · Vive en la columna NUEVA reservas.codigo (text, único).
-- · DESACOPLADO de la PK: reservas.id sigue siendo la llave interna y NINGUNA FK
--   cambia (paradas.reserva_id, pasajeros.reserva_id, GPS, etc. quedan igual).
--   Esto solo agrega un identificador de cara al usuario; no toca relaciones.
-- · Prefijo CONFIGURABLE en public.app_config (white-label / multi-tenant a futuro):
--   hoy un solo registro 'OS'; mañana puede volverse por-inquilino sin tocar código.
-- · Generación 100% en la BD (trigger BEFORE INSERT) → cubre TODOS los puntos que
--   crean reservas (programacion, cotizaciones, cotizador, ModalGenerarPrograma…).
-- · Numeración por AÑO, tomada de fecha_servicio (fallback: fecha actual Lima).
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1) Config key-value reutilizable. Prefijo del folio = 'OS' por defecto.
--    Para cambiarlo: update public.app_config set valor='XXX' where clave='folio_prefijo';
create table if not exists public.app_config (
  clave text primary key,
  valor text not null
);
insert into public.app_config (clave, valor)
  values ('folio_prefijo', 'OS')
  on conflict (clave) do nothing;            -- no pisar si ya lo configuraron

-- 2) Contador atómico por año (concurrencia-seguro vía ON CONFLICT).
create table if not exists public.folio_secuencia (
  anio   int primary key,
  ultimo int not null default 0
);

-- 3) Columna del folio + unicidad. (Los NULL conviven en un índice único de Postgres.)
alter table public.reservas add column if not exists codigo text;
create unique index if not exists idx_reservas_codigo on public.reservas (codigo);

-- 4) Función generadora del folio (corre en cada INSERT de reservas).
--    SECURITY DEFINER: el contador `folio_secuencia` tiene RLS activado y NINGUNA policy
--    (tabla interna, nunca expuesta al API). El trigger la escribe en nombre del dueño
--    (postgres), saltándose RLS — igual que sync_reserva_origen_destino. Sin esto, el
--    INSERT lo corre el rol `authenticated` del navegador y RLS lo bloquea:
--    "new row violates row-level security policy for table folio_secuencia".
create or replace function public.fn_reservas_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio    int;
  v_n       int;
  v_prefijo text;
begin
  -- Respeta un código ya provisto (backfill, importaciones, migraciones).
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;

  v_anio := extract(year from coalesce(new.fecha_servicio, (now() at time zone 'America/Lima')::date))::int;

  -- Incremento atómico del contador del año.
  insert into public.folio_secuencia (anio, ultimo)
    values (v_anio, 1)
    on conflict (anio) do update set ultimo = folio_secuencia.ultimo + 1
    returning ultimo into v_n;

  v_prefijo := coalesce((select valor from public.app_config where clave = 'folio_prefijo'), 'OS');

  new.codigo := case when v_prefijo <> '' then v_prefijo || '-' else '' end
                || v_anio::text || '-' || lpad(v_n::text, 6, '0');

  return new;
end;
$$;

-- 5) Trigger BEFORE INSERT.
drop trigger if exists trg_reservas_set_codigo on public.reservas;
create trigger trg_reservas_set_codigo
  before insert on public.reservas
  for each row execute function public.fn_reservas_set_codigo();

-- 6) Backfill de históricos + sembrado del contador, en UNA sola sentencia atómica.
--    (CTE que modifica datos; idempotente: re-ejecutar no cambia nada porque ya no
--     quedan filas con codigo NULL.)
with ordered as (
  select
    id,
    extract(year from coalesce(fecha_servicio, (now() at time zone 'America/Lima')::date))::int as anio,
    row_number() over (
      partition by extract(year from coalesce(fecha_servicio, (now() at time zone 'America/Lima')::date))
      order by coalesce(fecha_servicio, '1900-01-01'::date), id
    ) as seq
  from public.reservas
  where codigo is null
),
upd as (
  update public.reservas r
     set codigo = coalesce(
                    (select case when valor <> '' then valor || '-' else '' end
                       from public.app_config where clave = 'folio_prefijo'),
                    'OS-'
                  ) || o.anio::text || '-' || lpad(o.seq::text, 6, '0')
    from ordered o
   where r.id = o.id
  returning o.anio as anio, o.seq as seq
)
insert into public.folio_secuencia (anio, ultimo)
  select anio, max(seq) from upd group by anio
  on conflict (anio) do update set ultimo = greatest(folio_secuencia.ultimo, excluded.ultimo);

-- 7) (Opcional, recomendado tras verificar el backfill) hacer el folio obligatorio:
--    Si esto falla, es que quedó alguna reserva sin codigo → revisar antes de forzar.
-- alter table public.reservas alter column codigo set not null;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select id, fecha_servicio, codigo from public.reservas order by id desc limit 20;
-- select * from public.folio_secuencia order by anio;
