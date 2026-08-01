-- ============================================================
-- Push nativo al CONDUCTOR — suscripciones
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================
-- REQUISITO PREVIO: lib/conductor-auth.ts + login server-side ya desplegados. Sin
-- identidad firmada del conductor, el endpoint de suscripción sería un IDOR (cualquiera
-- registraría o borraría dispositivos a nombre de otro conductor).
--
-- Reusa push_suscripciones en vez de crear una tabla hermana: así el envío, la poda
-- (404/410/UNREGISTERED) y el contador de fallos son EXACTAMENTE el mismo código ya
-- probado con pasajeros.
--
-- OJO — CLAVE COMPUESTA: el conductor vive en DOS tablas (`conductores` y
-- `conductores_tercero`) cuyas secuencias de id SE SOLAPAN. El id 7 existe en ambas y
-- son personas distintas. La identidad es el PAR (conductor_id, conductor_tabla);
-- keyear solo por conductor_id mandaría el aviso al conductor equivocado.
-- ============================================================

-- ── 1) Dueño alternativo de la suscripción ───────────────────────────────────
alter table public.push_suscripciones
  add column if not exists conductor_id    bigint,
  add column if not exists conductor_tabla text
    check (conductor_tabla in ('conductores','conductores_tercero'));

-- pasajero_id pasa a ser opcional (una suscripción es de un pasajero O de un conductor).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='push_suscripciones'
      and column_name='pasajero_id' and is_nullable='NO'
  ) then
    alter table public.push_suscripciones alter column pasajero_id drop not null;
  end if;
end$$;

-- ── 2) Exactamente UN dueño por fila ─────────────────────────────────────────
-- Sin esto, una fila huérfana (sin dueño) nunca recibiría nada pero ocuparía el
-- índice único de endpoint/token, bloqueando la re-suscripción del dispositivo.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'push_susc_un_dueno'
  ) then
    alter table public.push_suscripciones add constraint push_susc_un_dueno check (
      (pasajero_id is not null and conductor_id is null  and conductor_tabla is null)
      or
      (pasajero_id is null     and conductor_id is not null and conductor_tabla is not null)
    );
  end if;
end$$;

-- ── 3) Índice de lectura (el envío filtra por el PAR + activo) ───────────────
create index if not exists ix_push_susc_conductor_activo
  on public.push_suscripciones (conductor_id, conductor_tabla) where activo;

-- ── 4) RLS: sin cambios ──────────────────────────────────────────────────────
-- push_suscripciones ya tiene RLS habilitado SIN policies (push-notificaciones.sql:51)
-- → solo service_role. Los endpoints /api/conductor y /api/pasajero usan service_role.

-- Smoke test:
-- select column_name, is_nullable from information_schema.columns
--   where table_name='push_suscripciones'
--     and column_name in ('pasajero_id','conductor_id','conductor_tabla');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'push_susc_un_dueno';
-- select conductor_tabla, count(*) from public.push_suscripciones
--   where conductor_id is not null group by 1;
