-- ══════════════════════════════════════════════════════════════════════════════
-- COMISIONES · FASE 04 — Períodos y líneas de comisión (trazabilidad + cierre)
--
-- QUÉ HACE: el libro final del módulo.
--   · comisiones_periodo — un mes de comisiones. `preliminar` mientras se puede
--                          recalcular; `cerrado` = INMUTABLE (no se recalcula más).
--   · comisiones_linea   — una línea por cada concepto que se le paga a alguien
--                          (eventual, fijo, bono_arranque, bono_atencion, fondo_admin),
--                          con TODA su traza: la base de utilidad, el % aplicado, el
--                          monto, de qué reserva/cliente/cotización salió, y el
--                          `parametros_id` (snapshot de la versión de parámetros usada)
--                          para que un mes cerrado nunca cambie si mañana suben una tasa.
--
-- POR QUÉ: el dinero se calcula una vez y se CONGELA con su evidencia. El snapshot de
-- parámetros es lo que hace que cerrar un mes signifique algo. Y la RLS POR FILA PROPIA
-- (nueva en el ERP: hasta hoy solo se filtra por módulo) deja que cada vendedor vea
-- SOLO lo suyo, el admin/gerente vea todo, y el administrativo vea su parte del fondo.
--
-- SI NO SE CORRE: no hay cálculo ni cierre de comisiones. No toca nada desplegado.
--
-- Requiere: 01 (comisiones_parametros), 02, 03 (comisiones_operacion_admin),
-- finanzas-00 (_fin_add_fk), finanzas-06 (fn_es_aprobador). Idempotente.
-- EL DEPLOY NO LO CORRE. Orden: 01 → 02 → 03 → 04.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) PERÍODO. Un mes (anio_mes = 'AAAA-MM'). `cerrado` es inmutable (lo garantiza el
--    backend: solo escribe con service-role y no reescribe un período cerrado).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_periodo (
  id           bigserial primary key,
  anio_mes     text not null check (anio_mes ~ '^\d{4}-\d{2}$'),
  estado       text not null default 'preliminar'
               check (estado in ('preliminar','cerrado')),
  calculado_en timestamptz,
  cerrado_por  uuid references public.usuarios(id) on delete set null,
  cerrado_en   timestamptz,
  created_at   timestamptz not null default now(),
  unique (anio_mes)
);

comment on table public.comisiones_periodo is
  'Un mes de comisiones. estado cerrado = INMUTABLE: no se recalcula. El snapshot de '
  'parámetros vive en cada comisiones_linea.parametros_id.';

-- 1.1) Ahora que comisiones_periodo existe, se cierra la FK que la fase 03 dejó
--      pendiente en el fondo (la columna ya es bigint; _fin_add_fk solo agrega la FK).
select public._fin_add_fk('comisiones_operacion_admin','periodo_id','comisiones_periodo');

-- ────────────────────────────────────────────────────────────────────────────
-- 2) LÍNEA de comisión — la trazabilidad completa.
--    `vendedor_id` NULLABLE a propósito: las líneas de fondo (tipo='fondo_admin') NO
--    tienen vendedor; su beneficiario es un administrativo (personal_administrativo_id).
--    `personal_administrativo_id` se agrega vía _fin_add_fk (se usa en fondo_admin).
--    reserva_id / cliente_id / cotizacion_id son el ORIGEN, nullables según el tipo.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_linea (
  id                bigserial primary key,
  periodo_id        bigint not null references public.comisiones_periodo(id) on delete cascade,
  vendedor_id       uuid references public.usuarios(id) on delete set null,
  tipo              text not null
                    check (tipo in ('eventual','fijo','bono_arranque','bono_atencion','fondo_admin')),
  base_utilidad     numeric(14,2),      -- v_utilidad_servicio.utilidad_antes_impuestos (snapshot)
  pct_aplicado      numeric(6,4),
  monto             numeric(14,2) not null default 0,
  fecha_cobro_origen timestamptz,       -- reservas.fecha_cobro del servicio que la originó
  orden_eventual    int,                -- posición del eventual en el período (tramo 1 vs 2)
  parametros_id     bigint references public.comisiones_parametros(id) on delete restrict,
  traza_json        jsonb,              -- detalle del cómputo (para auditar sin recalcular)
  estado            text not null default 'preliminar'
                    check (estado in ('preliminar','confirmada')),
  created_at        timestamptz not null default now()
);
select public._fin_add_fk('comisiones_linea','reserva_id','reservas');
select public._fin_add_fk('comisiones_linea','cliente_id','clientes');
select public._fin_add_fk('comisiones_linea','cotizacion_id','cotizaciones');
-- Beneficiario del fondo (tipo='fondo_admin'); nullable para el resto de tipos.
select public._fin_add_fk('comisiones_linea','personal_administrativo_id','personal_administrativo');

create index if not exists idx_com_linea_periodo_vendedor
  on public.comisiones_linea (periodo_id, vendedor_id);
create index if not exists idx_com_linea_tipo    on public.comisiones_linea (tipo);
create index if not exists idx_com_linea_reserva on public.comisiones_linea (reserva_id);
create index if not exists idx_com_linea_pa      on public.comisiones_linea (personal_administrativo_id);

comment on table public.comisiones_linea is
  'Una línea por concepto pagado. vendedor_id NULL en fondo_admin (beneficiario = '
  'personal_administrativo_id). parametros_id es el snapshot de la versión usada: un '
  'mes cerrado no se recalcula aunque cambien los parámetros.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) RLS POR FILA PROPIA (nuevo en el ERP).
--    SELECT:
--      · comisiones_linea  → el vendedor ve sus líneas (vendedor_id = auth.uid()); el
--        administrativo ve las de su fondo (vía personal_administrativo.usuario_id);
--        admin/gerente ven todo (fn_es_aprobador).
--      · comisiones_periodo → admin/gerente ven todo; un vendedor/administrativo ve el
--        período si tiene alguna línea suya en él.
--    ESCRITURA: ninguna política → solo service-role (el backend calcula y cierra).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.comisiones_linea enable row level security;
drop policy if exists comisiones_linea_sel on public.comisiones_linea;
create policy comisiones_linea_sel on public.comisiones_linea
  for select to authenticated using (
    vendedor_id = auth.uid()
    or public.fn_es_aprobador(auth.uid())
    or exists (
      select 1 from public.personal_administrativo pa
       where pa.id = comisiones_linea.personal_administrativo_id
         and pa.usuario_id = auth.uid()
    )
  );

alter table public.comisiones_periodo enable row level security;
drop policy if exists comisiones_periodo_sel on public.comisiones_periodo;
create policy comisiones_periodo_sel on public.comisiones_periodo
  for select to authenticated using (
    public.fn_es_aprobador(auth.uid())
    or exists (
      select 1 from public.comisiones_linea l
       where l.periodo_id = comisiones_periodo.id
         and (
           l.vendedor_id = auth.uid()
           or exists (
             select 1 from public.personal_administrativo pa
              where pa.id = l.personal_administrativo_id
                and pa.usuario_id = auth.uid()
           )
         )
    )
  );

-- ── CONTRATO DE NOMBRES (el backend depende de esto) ────────────────────────
--   comisiones_periodo(id, anio_mes 'AAAA-MM', estado preliminar|cerrado,
--     calculado_en, cerrado_por, cerrado_en)
--   comisiones_linea(id, periodo_id, vendedor_id?, tipo eventual|fijo|bono_arranque|
--     bono_atencion|fondo_admin, reserva_id?, cliente_id?, cotizacion_id?,
--     personal_administrativo_id?, base_utilidad, pct_aplicado, monto,
--     fecha_cobro_origen, orden_eventual, parametros_id, traza_json,
--     estado preliminar|confirmada)
--   comisiones_operacion_admin.periodo_id → FK a comisiones_periodo (cerrada aquí)

-- ── reversión ───────────────────────────────────────────────────────────────
-- alter table public.comisiones_operacion_admin drop constraint if exists fk_comisiones_operacion_admin_periodo_id;
-- drop table if exists public.comisiones_linea;
-- drop table if exists public.comisiones_periodo;

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select p.anio_mes, p.estado, l.tipo, count(*), sum(l.monto)
--   from public.comisiones_periodo p
--   join public.comisiones_linea l on l.periodo_id = p.id
--  group by 1,2,3 order by 1 desc,3;
-- select vendedor_id, sum(monto) from public.comisiones_linea
--  where periodo_id = (select id from public.comisiones_periodo order by anio_mes desc limit 1)
--  group by 1;
