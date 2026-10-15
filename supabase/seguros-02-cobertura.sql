-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-02-cobertura.sql · A QUIÉN cubre cada póliza (N:M).
-- (NO la corre el deploy: Supabase → SQL Editor → Run, DESPUÉS de seguros-01.
-- Idempotente.)
--
-- POR QUÉ: una póliza colectiva (SCTR, Vida Ley, RC de flota, Todo Riesgo de
-- flotilla) cubre a muchas personas o unidades. La póliza es UNA fila en
-- `seguros` (el monto vive ahí, una sola vez); esta tabla solo dice quién está
-- dentro y desde/hasta cuándo. Cada fila apunta a UN sujeto exactamente.
-- desde/hasta: null = toda la vigencia de la póliza (seguros.fecha_inicio /
-- fecha_vencimiento). `hasta` sirve para dar de baja a alguien sin borrar el rastro.
-- Las FK van en bigint: valen contra un id int o bigint (ver diagnostico-seguros.sql).
-- SI NO SE CORRE: no hay pólizas colectivas; v_seguro_persona (seguros-03) no
-- se puede crear y la pantalla usa solo las fichas.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.seguro_cobertura (
  id                         bigserial primary key,
  seguro_id                  bigint not null references public.seguros(id) on delete cascade,
  conductor_id               bigint references public.conductores(id) on delete cascade,
  personal_administrativo_id bigint references public.personal_administrativo(id) on delete cascade,
  vehiculo_id                bigint references public.vehiculos(id) on delete cascade,
  vehiculo_tercero_id        bigint references public.vehiculos_tercero(id) on delete cascade,
  desde                      date,
  hasta                      date,
  created_at                 timestamptz not null default now(),
  constraint ck_seguro_cobertura_un_sujeto check (
    num_nonnulls(conductor_id, personal_administrativo_id, vehiculo_id, vehiculo_tercero_id) = 1),
  constraint ck_seguro_cobertura_rango check (desde is null or hasta is null or desde <= hasta)
);

-- Un sujeto entra UNA vez por póliza: última defensa contra el doble alta.
create unique index if not exists uq_seg_cob_conductor on public.seguro_cobertura (seguro_id, conductor_id)
  where conductor_id is not null;
create unique index if not exists uq_seg_cob_personal on public.seguro_cobertura (seguro_id, personal_administrativo_id)
  where personal_administrativo_id is not null;
create unique index if not exists uq_seg_cob_vehiculo on public.seguro_cobertura (seguro_id, vehiculo_id)
  where vehiculo_id is not null;
create unique index if not exists uq_seg_cob_veh_tercero on public.seguro_cobertura (seguro_id, vehiculo_tercero_id)
  where vehiculo_tercero_id is not null;

-- Lectura por sujeto ("¿qué pólizas cubren a este conductor?") — la de la vista.
create index if not exists idx_seg_cob_conductor on public.seguro_cobertura (conductor_id)
  where conductor_id is not null;
create index if not exists idx_seg_cob_personal on public.seguro_cobertura (personal_administrativo_id)
  where personal_administrativo_id is not null;
create index if not exists idx_seg_cob_vehiculo on public.seguro_cobertura (vehiculo_id)
  where vehiculo_id is not null;
create index if not exists idx_seg_cob_veh_tercero on public.seguro_cobertura (vehiculo_tercero_id)
  where vehiculo_tercero_id is not null;
-- Los cuatro únicos son PARCIALES: no sirven al borrado en cascada desde
-- seguros (where seguro_id = X), que necesita uno sin predicado.
create index if not exists idx_seg_cob_seguro on public.seguro_cobertura (seguro_id);

alter table public.seguro_cobertura enable row level security;
drop policy if exists seguro_cobertura_authenticated on public.seguro_cobertura;
create policy seguro_cobertura_authenticated on public.seguro_cobertura
  for all to authenticated using (true) with check (true);
revoke all on public.seguro_cobertura from anon;
revoke all on sequence public.seguro_cobertura_id_seq from anon;

-- Verificación (debe fallar con 23514 · ck_seguro_cobertura_un_sujeto):
-- insert into public.seguro_cobertura (seguro_id) values (1);

-- FIN de seguros-02-cobertura.sql
