-- ══════════════════════════════════════════════════════════════════════════════
-- COMISIONES · FASE 02 — Captador del cliente y vendedor de la cotización
--
-- QUÉ HACE: engancha a las personas a los dos hechos que generan comisión.
--   1) El CAPTADOR del cliente (quién lo trajo). Se FIJA con la 1ª cotización y no
--      se vuelve a mover: la comisión de arranque y la ventana de "cliente nuevo"
--      cuelgan de ahí. No se deduce de nada; lo escribe el backend una sola vez.
--   2) El VENDEDOR de cada cotización (quién la hizo). `cotizaciones.creado_por` es
--      TEXTO con el nombre; esta fase agrega el `vendedor_id` con la identidad real.
--   3) La LISTA FIRMADA de clientes ya existentes al arrancar el módulo: define qué
--      cuenta como cliente NUEVO (y por tanto da bono de arranque) y qué no.
--
-- POR QUÉ: la comisión reparte dinero por persona. Atribuir por un nombre de texto
-- libre (`creado_por`) es el fallo más repetido del repo —escribir con una identidad
-- y leer con otra—; por eso se fija un uuid (usuarios) en el momento del hecho.
--
-- SI NO SE CORRE: el módulo de comisiones no puede atribuir ni cliente nuevo ni
-- vendedor. No rompe nada desplegado: solo agrega columnas accesorias (nullables,
-- sin default) y una tabla nueva. El código degrada soltando la columna que falte.
--
-- Requiere: finanzas-00 (helper _fin_add_fk). Idempotente. EL DEPLOY NO LO CORRE.
-- Orden: 01 → 02 → 03 → 04.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) CAPTADOR del cliente. Columnas nuevas en `clientes` (tabla existente).
--    `captador_usuario_id` vía _fin_add_fk porque el tipo de PK de usuarios/clientes
--    solo vive en Supabase; el helper lo resuelve y degrada sin abortar.
--    SIN DEFAULT y SIN BACKFILL: el captador es una afirmación ("esta persona lo
--    trajo") que nadie declaró para los clientes históricos. Lo fija el backend al
--    crear la 1ª cotización del cliente; `captador_fijado_en` deja constancia del
--    momento para que no se re-escriba.
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('clientes','captador_usuario_id','usuarios');
alter table public.clientes add column if not exists captador_fijado_en timestamptz;

comment on column public.clientes.captador_usuario_id is
  'Quién captó al cliente. Se FIJA con la 1ª cotización (backend) y no se mueve. '
  'Base del bono de arranque y de la ventana de cliente nuevo. Sin backfill: NULL '
  'significa que nadie lo declaró todavía.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) VENDEDOR de la cotización. Columna nueva en `cotizaciones` (tabla existente).
-- ────────────────────────────────────────────────────────────────────────────
select public._fin_add_fk('cotizaciones','vendedor_id','usuarios');

comment on column public.cotizaciones.vendedor_id is
  'Identidad real (usuarios.id) del vendedor de la cotización. Sustituye a '
  'creado_por (texto). Lo escribe el backend al crear la cotización; las históricas '
  'se intentan backfillear por nombre y las que no casan quedan NULL para asignación '
  'manual.';

-- 2.1) BACKFILL best-effort por nombre contra `creado_por`. SOLO cuando el match es
--      INEQUÍVOCO: `creado_por` (trim, sin importar mayúsculas) coincide con el
--      `nombre` de EXACTAMENTE un usuario activo. Lo ambiguo o sin match queda NULL
--      para asignación manual — nunca se adivina a quién pagarle. Envuelto en un
--      DO para no abortar si el esquema real difiere (nombres de columna, etc.).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='cotizaciones' and column_name='vendedor_id')
     and exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='cotizaciones' and column_name='creado_por')
     and exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='usuarios' and column_name='nombre')
  then
    update public.cotizaciones c
       set vendedor_id = u.id
      from public.usuarios u
     where c.vendedor_id is null
       and c.creado_por is not null
       and lower(btrim(c.creado_por)) = lower(btrim(u.nombre))
       and coalesce(u.activo, true) = true
       -- solo si el nombre identifica a UN único usuario activo
       and (select count(*) from public.usuarios u2
             where lower(btrim(u2.nombre)) = lower(btrim(c.creado_por))
               and coalesce(u2.activo, true) = true) = 1;
  end if;
exception when others then
  raise notice '[comisiones02] backfill de vendedor_id omitido: %', sqlerrm;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) LISTA FIRMADA de clientes ya existentes al arrancar el módulo. Es la que
--    define "cliente nuevo": quien NO está en esta lista (y fue captado dentro de
--    la ventana) da bono de arranque. Puede apuntar a un cliente ya creado
--    (cliente_id) o, si aún no existe como ficha, guardarse por ruc/nombre.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_lista_clientes_existentes (
  id          bigserial primary key,
  ruc         text,
  nombre      text,
  cargada_por uuid references public.usuarios(id) on delete set null,
  cargada_en  timestamptz not null default now()
);
-- cliente_id vía _fin_add_fk (tipo de PK de clientes resuelto en runtime).
select public._fin_add_fk('comisiones_lista_clientes_existentes','cliente_id','clientes');

-- El CHECK "identifica a alguien" se aplica después de que exista cliente_id (así
-- incluye cliente_id en el OR). Idempotente: drop + add.
alter table public.comisiones_lista_clientes_existentes
  drop constraint if exists comisiones_lce_identifica;
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_lista_clientes_existentes'
                and column_name='cliente_id')
  then
    execute 'alter table public.comisiones_lista_clientes_existentes
             add constraint comisiones_lce_identifica
             check (cliente_id is not null or ruc is not null or nombre is not null)';
  else
    execute 'alter table public.comisiones_lista_clientes_existentes
             add constraint comisiones_lce_identifica
             check (ruc is not null or nombre is not null)';
  end if;
exception when others then
  raise notice '[comisiones02] constraint comisiones_lce_identifica no aplicada: %', sqlerrm;
end $$;

-- Un cliente ya listado no se repite: índices únicos parciales por cada identidad.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='comisiones_lista_clientes_existentes'
                and column_name='cliente_id')
  then
    execute 'create unique index if not exists uq_com_lce_cliente
             on public.comisiones_lista_clientes_existentes (cliente_id)
             where cliente_id is not null';
  end if;
end $$;
create unique index if not exists uq_com_lce_ruc
  on public.comisiones_lista_clientes_existentes (ruc)
  where ruc is not null;

comment on table public.comisiones_lista_clientes_existentes is
  'La "lista firmada" de clientes que ya existían al arrancar el módulo. Define '
  'qué es cliente NUEVO (bono de arranque). cliente_id si ya hay ficha; si no, '
  'ruc/nombre. La carga el backend con service-role.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS de la tabla nueva — lectura `to authenticated`, escritura solo service-role.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.comisiones_lista_clientes_existentes enable row level security;
drop policy if exists comisiones_lce_sel on public.comisiones_lista_clientes_existentes;
create policy comisiones_lce_sel on public.comisiones_lista_clientes_existentes
  for select to authenticated using (true);

-- ── CONTRATO DE NOMBRES (el backend depende de esto) ────────────────────────
--   clientes.captador_usuario_id (uuid, FK usuarios), clientes.captador_fijado_en
--   cotizaciones.vendedor_id (uuid, FK usuarios)
--   comisiones_lista_clientes_existentes(id, cliente_id?, ruc?, nombre?, cargada_por, cargada_en)

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop table if exists public.comisiones_lista_clientes_existentes;
-- alter table public.cotizaciones drop column if exists vendedor_id;
-- alter table public.clientes drop column if exists captador_usuario_id;
-- alter table public.clientes drop column if exists captador_fijado_en;

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select count(*) filter (where vendedor_id is not null) as con_vendedor,
--        count(*) filter (where vendedor_id is null)     as sin_vendedor
--   from public.cotizaciones;
-- select count(*) from public.clientes where captador_usuario_id is not null;
-- select * from public.comisiones_lista_clientes_existentes order by cargada_en desc limit 20;
