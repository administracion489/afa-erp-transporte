-- ══════════════════════════════════════════════════════════════════════════════
-- COMISIONES · FASE 03 — Clasificaciones (reclamos, cancelaciones), fondo y pruebas
--
-- QUÉ HACE: las tablas donde se CLASIFICA a mano lo que el cálculo no puede deducir
-- y donde se registra la evidencia del cobro.
--   · comisiones_reclamos      — un reclamo del cliente, con gravedad y si es
--                                 atribuible al vendedor (afecta el indicador de quejas).
--   · comisiones_cancelaciones — una cancelación, si era evitable y si hubo constancia
--                                 escrita (afecta el indicador de cancelaciones).
--   · comisiones_operacion_admin — el FONDO: el VENDEDOR marca qué administrativo lo
--                                 ayudó en un servicio; el ADMIN lo CORROBORA a fin de
--                                 mes. Solo lo corroborado entra al reparto del fondo.
--   · comisiones_cobro_prueba  — las pruebas de que un servicio se cobró (depósito,
--                                 factura PDF, factura XML). El dinero del vendedor se
--                                 reconoce cuando el servicio está COBRADO, y "marcar
--                                 cobrado" exige las tres pruebas (lo valida el backend).
--
-- POR QUÉ: la gravedad de un reclamo o si una cancelación era evitable es un JUICIO,
-- no un dato que el motor pueda inferir; debe escribirlo una persona y quedar trazado.
-- Y el cobro reconocido con evidencia (regla de oro: una fila autoritativa por hecho,
-- con su respaldo en el bucket PRIVADO `documentos`, nunca uno público).
--
-- SI NO SE CORRE: no hay clasificaciones ni fondo ni pruebas de cobro; el módulo de
-- comisiones no puede penalizar ni reconocer cobros manuales. No toca nada desplegado.
--
-- Requiere: finanzas-00 (_fin_add_fk), finanzas-06 (fn_es_aprobador). Idempotente.
-- EL DEPLOY NO LO CORRE. Orden: 01 → 02 → 03 → 04.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 0) PUENTE usuario ↔ personal administrativo.
--    El login es un usuarios.id (= auth.uid()); el personal administrativo tiene su
--    propio id. Para que un administrativo pueda VER su parte del fondo por RLS hace
--    falta mapear los dos. Se agrega `personal_administrativo.usuario_id` vía
--    _fin_add_fk (idempotente; si ya existe, se reutiliza). SUPUESTO: el backend
--    puebla esta columna cuando el administrativo también es usuario del ERP. Si no
--    se puede crear, las políticas que la usan simplemente no devuelven filas para
--    ese usuario (deny-by-default, seguro).
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('personal_administrativo','usuario_id','usuarios');

-- ────────────────────────────────────────────────────────────────────────────
-- 1) RECLAMOS del cliente.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_reclamos (
  id                  bigserial primary key,
  gravedad            text not null default 'leve'
                      check (gravedad in ('leve','moderada','grave')),
  fundado             boolean not null default false,
  atribuible_vendedor boolean not null default false,
  nota                text,
  clasificado_por     uuid references public.usuarios(id) on delete set null,
  clasificado_en      timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
select public._fin_add_fk('comisiones_reclamos','reserva_id','reservas');
select public._fin_add_fk('comisiones_reclamos','cliente_id','clientes');
create index if not exists idx_com_reclamos_reserva on public.comisiones_reclamos (reserva_id);
create index if not exists idx_com_reclamos_cliente on public.comisiones_reclamos (cliente_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) CANCELACIONES.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_cancelaciones (
  id                bigserial primary key,
  evitable          boolean not null default false,
  constancia_escrita boolean not null default false,
  nota              text,
  clasificado_por   uuid references public.usuarios(id) on delete set null,
  clasificado_en    timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
select public._fin_add_fk('comisiones_cancelaciones','reserva_id','reservas');
create index if not exists idx_com_cancel_reserva on public.comisiones_cancelaciones (reserva_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) FONDO de operación/administración.
--    `periodo_id` se declara bigint SIN FK aquí: comisiones_periodo se crea en la
--    fase 04 y la FK se agrega allí (la columna ya existe como bigint, que es el
--    tipo del bigserial de comisiones_periodo). Nullable hasta el cierre.
--    `marcado_por` = el vendedor que afirma que lo ayudaron. `corroborado_por` /
--    `corroborado_en` = el admin a fin de mes; SOLO lo corroborado entra al reparto.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_operacion_admin (
  id              bigserial primary key,
  periodo_id      bigint,                                   -- FK a comisiones_periodo (fase 04)
  marcado_por     uuid references public.usuarios(id) on delete set null,
  marcado_en      timestamptz not null default now(),
  corroborado_por uuid references public.usuarios(id) on delete set null,
  corroborado_en  timestamptz,                              -- null = aún no corroborado
  nota            text,
  created_at      timestamptz not null default now()
);
select public._fin_add_fk('comisiones_operacion_admin','reserva_id','reservas');
select public._fin_add_fk('comisiones_operacion_admin','personal_administrativo_id','personal_administrativo');
create index if not exists idx_com_opadmin_periodo on public.comisiones_operacion_admin (periodo_id);
create index if not exists idx_com_opadmin_pa       on public.comisiones_operacion_admin (personal_administrativo_id);
-- Lo que entra al reparto: lo corroborado. Índice para filtrar rápido por cierre.
create index if not exists idx_com_opadmin_corroborado
  on public.comisiones_operacion_admin (periodo_id)
  where corroborado_en is not null;

comment on table public.comisiones_operacion_admin is
  'Fondo administrativo. El VENDEDOR marca (marcado_por) que un administrativo lo '
  'ayudó en una reserva; el ADMIN lo corrobora (corroborado_en). Solo lo corroborado '
  'entra al reparto del fondo en el cierre (fase 04).';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) PRUEBAS DE COBRO. El botón manual "marcar cobrado" exige las TRES pruebas
--    (depósito + factura PDF + factura XML). Esa regla la valida el backend; aquí
--    se deja la estructura que AYUDA: una fila por tipo de prueba y un índice único
--    parcial por (destino, tipo) para que no se repita un tipo y las tres filas
--    distintas basten. CHECK: exactamente UN destino (reserva XOR factura).
--    `archivo_url` es la RUTA dentro del bucket PRIVADO `documentos` (no público):
--    un depósito o una factura traen datos comerciales. Se lee con createSignedUrl.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_cobro_prueba (
  id             bigserial primary key,
  tipo_prueba    text not null
                 check (tipo_prueba in ('deposito','factura_pdf','factura_xml')),
  archivo_url    text not null,                             -- ruta en bucket privado `documentos`
  registrado_por uuid references public.usuarios(id) on delete set null,
  registrado_en  timestamptz not null default now()
);
select public._fin_add_fk('comisiones_cobro_prueba','reserva_id','reservas');
select public._fin_add_fk('comisiones_cobro_prueba','factura_id','facturas');

-- Exactamente un destino: reserva XOR factura (se aplica una vez existen las columnas).
alter table public.comisiones_cobro_prueba
  drop constraint if exists comisiones_cobro_prueba_destino;
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_cobro_prueba' and column_name='reserva_id')
     and exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_cobro_prueba' and column_name='factura_id')
  then
    execute 'alter table public.comisiones_cobro_prueba
             add constraint comisiones_cobro_prueba_destino
             check ((reserva_id is not null)::int + (factura_id is not null)::int = 1)';
  end if;
exception when others then
  raise notice '[comisiones03] constraint comisiones_cobro_prueba_destino no aplicada: %', sqlerrm;
end $$;

-- Un tipo de prueba no se repite para el mismo destino → tres filas = tres pruebas.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_cobro_prueba' and column_name='reserva_id') then
    execute 'create unique index if not exists uq_com_cobro_prueba_reserva
             on public.comisiones_cobro_prueba (reserva_id, tipo_prueba) where reserva_id is not null';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_cobro_prueba' and column_name='factura_id') then
    execute 'create unique index if not exists uq_com_cobro_prueba_factura
             on public.comisiones_cobro_prueba (factura_id, tipo_prueba) where factura_id is not null';
  end if;
end $$;

comment on table public.comisiones_cobro_prueba is
  'Pruebas del cobro de un servicio (deposito|factura_pdf|factura_xml). El backend '
  'exige las tres antes de "marcar cobrado". archivo_url = ruta en el bucket PRIVADO '
  'documentos (se lee con createSignedUrl, nunca getPublicUrl).';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) RLS.
--    reclamos / cancelaciones / cobro_prueba: lectura authenticated, escritura
--    solo service-role (las escribe el admin/vendedor vía API con service-role).
--    operacion_admin: per-fila — admin/gerente ven todo; el vendedor ve lo que
--    marcó; el administrativo ve lo suyo (vía personal_administrativo.usuario_id).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['comisiones_reclamos','comisiones_cancelaciones','comisiones_cobro_prueba'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_sel', t);
  end loop;
end $$;

alter table public.comisiones_operacion_admin enable row level security;
drop policy if exists comisiones_opadmin_sel on public.comisiones_operacion_admin;
create policy comisiones_opadmin_sel on public.comisiones_operacion_admin
  for select to authenticated using (
    public.fn_es_aprobador(auth.uid())
    or marcado_por = auth.uid()
    or exists (
      select 1 from public.personal_administrativo pa
       where pa.id = comisiones_operacion_admin.personal_administrativo_id
         and pa.usuario_id = auth.uid()
    )
  );

-- ── CONTRATO DE NOMBRES (el backend depende de esto) ────────────────────────
--   personal_administrativo.usuario_id (uuid, FK usuarios) — puente para RLS
--   comisiones_reclamos(id, reserva_id?, cliente_id?, gravedad, fundado,
--     atribuible_vendedor, nota, clasificado_por, clasificado_en)
--   comisiones_cancelaciones(id, reserva_id?, evitable, constancia_escrita, nota,
--     clasificado_por, clasificado_en)
--   comisiones_operacion_admin(id, periodo_id?, reserva_id?, personal_administrativo_id?,
--     marcado_por, marcado_en, corroborado_por, corroborado_en)
--   comisiones_cobro_prueba(id, reserva_id XOR factura_id, tipo_prueba, archivo_url,
--     registrado_por, registrado_en)

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop table if exists public.comisiones_cobro_prueba;
-- drop table if exists public.comisiones_operacion_admin;
-- drop table if exists public.comisiones_cancelaciones;
-- drop table if exists public.comisiones_reclamos;
-- alter table public.personal_administrativo drop column if exists usuario_id;  -- solo si esta fase la creó

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select gravedad, count(*) from public.comisiones_reclamos group by 1;
-- select count(*) filter (where corroborado_en is not null) as corroboradas,
--        count(*) from public.comisiones_operacion_admin;
-- select reserva_id, count(distinct tipo_prueba) as pruebas
--   from public.comisiones_cobro_prueba where reserva_id is not null group by 1;
