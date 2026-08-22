-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS/CONTABILIDAD · FASE 0 — Fundación e higiene
--
-- Rediseño de Finanzas + Contabilidad + Liquidaciones. Este archivo es el PASO CERO:
-- no agrega features, DES-ARRIESGA todo lo demás. Correr ANTES que 01/02/03/04/05.
--
-- Incluye:
--   1) _fin_add_fk() — helper que agrega una columna-FK a una tabla EXISTENTE
--      resolviendo dinámicamente el tipo de la PK referenciada (int vs bigint), para
--      no romper por el "riesgo nº1": el esquema real de reservas/clientes/facturas
--      solo vive en Supabase y no podemos introspeccionarlo desde el repo.
--   2) config_tributaria + cat_detraccion — DES-HARDCODEA el IGV 18% y la detracción
--      10%/S/700 que hoy están tecleados en el front (app/facturacion/page.tsx).
--   3) tipo_cambio — FX centralizado (hoy facturas.tipo_cambio es por-comprobante).
--   4) Columnas de auditoría del ciclo administrativo en `reservas` + dimensión C
--      (estado_proveedor) para el lado tercerizado (ver lib/estados.ts).
--   5) Vistas canónicas v_ingresos / v_egresos — FUENTE ÚNICA que hoy cada módulo
--      (ELIA, Dashboard, Reportes, /gastos) re-deriva por su cuenta. Son VISTAS: no
--      duplican montos, solo unifican la forma.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- Regla de oro (anti-duplicación): cada monto tiene UNA fila autoritativa; el resto
-- lo referencia por FK y lo DERIVA. El dinero entra a contabilidad UNA sola vez, a
-- nivel COMPROBANTE (facturas = venta · documentos_compra = compra).
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Helper: agrega una columna-FK hacia una tabla EXISTENTE con el tipo correcto.
--    Resuelve el tipo de la PK referenciada leyendo information_schema, así el mismo
--    llamado funciona sea la PK integer o bigint. Si la tabla/columna destino no
--    existe, o el tipo no calza, NO aborta la migración: emite un NOTICE y sigue
--    (la columna igual queda usable a nivel app; la integridad referencial se puede
--    endurecer luego). Idempotente.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public._fin_add_fk(
  p_table     text,
  p_col       text,
  p_ref_table text,
  p_ref_col   text default 'id',
  p_on_delete text default 'set null'
) returns void
language plpgsql
as $$
declare
  v_type text;
  v_sql  text;
  v_cons text := format('fk_%s_%s', p_table, p_col);
begin
  select data_type into v_type
  from information_schema.columns
  where table_schema = 'public' and table_name = p_ref_table and column_name = p_ref_col;

  if v_type is null then
    raise notice '[_fin_add_fk] %.% no existe todavía → se omite la columna %.%',
      p_ref_table, p_ref_col, p_table, p_col;
    return;
  end if;

  -- Normaliza el tipo Postgres al que se declara la columna nueva.
  v_type := case v_type
              when 'integer'  then 'integer'
              when 'bigint'   then 'bigint'
              when 'smallint' then 'integer'
              when 'uuid'     then 'uuid'
              else v_type
            end;

  execute format('alter table public.%I add column if not exists %I %s',
                 p_table, p_col, v_type);

  if not exists (select 1 from pg_constraint where conname = v_cons) then
    begin
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.%I(%I) on delete %s',
        p_table, v_cons, p_col, p_ref_table, p_ref_col, p_on_delete);
    exception when others then
      raise notice '[_fin_add_fk] No se pudo crear FK %.% → %.% (%): la columna queda sin FK',
        p_table, p_col, p_ref_table, p_ref_col, sqlerrm;
    end;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Configuración tributaria (fila única) + catálogo de detracción.
--    De-hardcodea el IGV 18% y la detracción 10%/700 del front. Los porcentajes de
--    detracción de transporte (personas vs. carga) DEBEN confirmarse con el contador:
--    aquí solo se dejan como dato editable, no como verdad fijada en código.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.config_tributaria (
  id                int primary key default 1 check (id = 1),
  igv_pct           numeric(6,4) not null default 18.0,   -- % IGV vigente
  moneda_base       text not null default 'PEN',
  redondeo_decimales int not null default 2,
  regimen           text,                                  -- RER | RMT | Régimen General…
  ubl_version       text not null default '2.1',
  detraccion_activa boolean not null default true,
  updated_at        timestamptz not null default now()
);
insert into public.config_tributaria (id) values (1) on conflict (id) do nothing;

create table if not exists public.cat_detraccion (
  codigo      text primary key,          -- código de servicio SUNAT (Anexo)
  descripcion text not null,
  porcentaje  numeric(6,4) not null,     -- % a detraer
  umbral_min  numeric(12,2) not null default 700,  -- opera si el total ≥ umbral
  activo      boolean not null default true
);
-- Semillas mínimas según el Catálogo 54 de SUNAT. OJO con estos dos, que es fácil
-- invertirlos (esta semilla los tuvo al revés hasta la fase 07):
--   026 = transporte de PERSONAS → 10 % · umbral S/ 700 (Anexo 3)
--   027 = transporte de CARGA    →  4 % · umbral S/ 400 (R.S. 073-2006/SUNAT)
-- El catálogo COMPLETO y editable lo carga finanzas-07-detracciones-catalogo.sql; las
-- tasas cambian por Resolución de Superintendencia, así que la verdad es lo que el
-- contador mantenga en esta tabla, no lo que diga este archivo.
insert into public.cat_detraccion (codigo, descripcion, porcentaje, umbral_min) values
  ('026', 'Servicio de transporte de personas',                    10.0, 700),
  ('027', 'Servicio de transporte de carga (bienes por vía terrestre)', 4.0, 400),
  ('037', 'Demás servicios gravados con IGV',                      12.0, 700)
on conflict (codigo) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Tipo de cambio centralizado (hoy vive suelto por comprobante en facturas).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.tipo_cambio (
  fecha    date not null,
  moneda   text not null default 'USD',   -- moneda extranjera vs. PEN
  compra   numeric(10,4) not null,
  venta    numeric(10,4) not null,
  fuente   text default 'SBS',
  primary key (fecha, moneda)
);
create index if not exists idx_tipo_cambio_fecha on public.tipo_cambio (fecha desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Auditoría del ciclo administrativo + dimensión C (proveedor) en `reservas`.
--    Dimensión B (cliente): por_liquidar→liquidada→facturada→cobrada (ya existe).
--    Dimensión C (proveedor/tercero): por_conciliar→conciliada→por_pagar→pagada.
--    Ambas se gobiernan desde lib/estados.ts. Las fechas habilitan aging y cierres.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas add column if not exists estado_proveedor text;
alter table public.reservas drop constraint if exists reservas_estado_proveedor_check;
alter table public.reservas
  add constraint reservas_estado_proveedor_check
  check (estado_proveedor is null or estado_proveedor in
    ('por_conciliar','conciliada','por_pagar','pagada'));

alter table public.reservas add column if not exists fecha_liquidacion  timestamptz;
alter table public.reservas add column if not exists fecha_facturacion  timestamptz;
alter table public.reservas add column if not exists fecha_cobro        timestamptz;
alter table public.reservas add column if not exists fecha_pago_proveedor timestamptz;
alter table public.reservas add column if not exists liquidacion_cliente_id   bigint;
alter table public.reservas add column if not exists liquidacion_proveedor_id bigint;

create index if not exists idx_reservas_estado_proveedor on public.reservas (estado_proveedor);

-- Backfill: los servicios tercerizados ya finalizados y sin conciliar arrancan
-- la dimensión C en "por_conciliar" (el puente que hoy no existe).
update public.reservas
   set estado_proveedor = 'por_conciliar'
 where estado = 'finalizada'
   and estado_proveedor is null
   and coalesce(tipo_asignacion, '') = 'tercerizado';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Vistas canónicas de Ingresos y Egresos (FUENTE ÚNICA, no duplican montos).
--    v_egresos unifica las tablas operativas de gasto en una forma común. Declara
--    su plano: es GESTIÓN (costo real por vehículo/servicio). El plano FISCAL (para
--    IGV/Registro de Compras) se suma aparte sobre documentos_compra (fase 02) para
--    NO contar el mismo monto dos veces.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_egresos as
  select 'gasto'::text        as fuente, g.id::bigint as origen_id, g.fecha,
         coalesce(g.categoria,'otro') as concepto, g.monto::numeric as monto,
         'PEN'::text as moneda, g.vehiculo_id, g.reserva_id, g.proveedor_id,
         coalesce(g.estado,'pendiente') as estado
    from public.gastos g
  union all
  select 'combustible', c.id::bigint, c.fecha,
         'combustible', c.total::numeric, 'PEN', c.vehiculo_id, null::int, null::int,
         'pagado'
    from public.combustible c
  union all
  select 'mantenimiento', m.id::bigint, m.fecha,
         'mantenimiento', coalesce(m.costo,0)::numeric, 'PEN', m.vehiculo_id, null::int, null::int,
         coalesce(m.estado,'pendiente')
    from public.mantenimiento m;

-- v_ingresos: plano FISCAL de venta sobre `facturas` (el comprobante es la fuente).
create or replace view public.v_ingresos as
  select f.id::bigint as origen_id, f.fecha_emision as fecha,
         f.cliente_id, f.reserva_id,
         coalesce(f.tipo_comprobante,'factura') as tipo_comprobante,
         f.serie, f.numero,
         coalesce(f.moneda,'PEN') as moneda,
         coalesce(f.subtotal,0)::numeric as subtotal,
         coalesce(f.igv,0)::numeric as igv,
         coalesce(f.total,0)::numeric as total,
         coalesce(f.estado,'emitida') as estado
    from public.facturas f;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) RLS de las tablas nuevas de esta fase (mismo patrón que radar-ia.sql).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['config_tributaria','cat_detraccion','tipo_cambio'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- Confirmar tipos de PK antes de las siguientes fases (informativo):
--   select table_name, column_name, data_type from information_schema.columns
--   where table_schema='public' and column_name='id'
--     and table_name in ('reservas','clientes','proveedores','vehiculos',
--                        'empresas_tercerizadas','vehiculos_tercero','facturas',
--                        'gastos','combustible','ordenes_compra') order by 1;
-- select * from public.config_tributaria;
-- select * from public.cat_detraccion order by codigo;
-- select fuente, count(*), sum(monto) from public.v_egresos group by 1;
