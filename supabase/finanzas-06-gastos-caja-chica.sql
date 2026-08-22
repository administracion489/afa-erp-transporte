-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS · FASE 6 — Control de gastos · Caja chica · Planilla · Lotes de pago ·
--                     Conciliación bancaria · Costo real por servicio
--
-- Requiere: finanzas-00-fundacion.sql (helper _fin_add_fk), 01 (pagos/tesorería),
--           02 (documentos_compra) y liquidaciones-v2.sql.
--
-- Implementa el "Plan Maestro de Arquitectura Financiera" RESPETANDO la regla de oro
-- declarada en finanzas-00 (líneas 22-24): cada monto tiene UNA fila autoritativa; el
-- resto lo referencia por FK y lo DERIVA. Por eso, frente al plan original:
--
--   · `cuentas_por_pagar`  → NO se crea como tabla. Duplicaría `documentos_compra`
--     (el comprobante de compra ya es el ancla fiscal de la CxP y su saldo ya se
--     deriva de pagos_aplicacion). En su lugar se le agrega a documentos_compra el
--     EJE OPERATIVO que le faltaba (placa, código de servicio, turno/ruta, adelantos,
--     nº de operación) + un eje ORTOGONAL de aprobación, y se publica la vista
--     `v_cuentas_por_pagar` con la forma que pide el plan.
--   · `caja_chica_viaticos` → se normaliza en TRES tablas (fondo · rendición · gasto)
--     en vez de una sola con `comprobantes_json`. Un JSON no se puede filtrar por
--     categoría, ni sumar por vehículo, ni atar a una reserva, ni entrar a v_egresos.
--   · `monto_rendido` / `saldo_pendiente` → NO se guardan: se derivan en
--     `v_caja_chica_rendiciones`, igual que el saldo de un comprobante en la fase 01.
--   · `conciliacion_bancaria` → se parte en cabecera de importación + movimientos,
--     para poder re-importar un extracto sin duplicar filas (hash por fila).
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Perfil GERENTE — quien aprueba el gasto no es necesariamente el admin del ERP.
--    `usuarios.rol` es texto libre; aquí solo se documenta el valor y se publica un
--    helper para que las políticas/consultas no repitan la lista de roles.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_es_aprobador(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
     where u.id = p_uid
       and coalesce(u.activo, true) = true
       and u.rol in ('admin', 'gerente')
  );
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 0.1) Datos bancarios del beneficiario que pedía el Plan Maestro y que hoy faltan.
--      `proveedores` ya recibió cuenta_bancaria/cci en la fase 02, pero no el banco
--      ni el titular (que puede diferir de la razón social: muchos transportistas
--      cobran a nombre del dueño de la unidad). `razon_social` se AGREGA en vez de
--      renombrar `nombre`, porque media docena de pantallas ya leen `nombre`.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare tbl text;
begin
  foreach tbl in array array['proveedores','empresas_tercerizadas'] loop
    execute format('alter table public.%I add column if not exists razon_social text', tbl);
    execute format('alter table public.%I add column if not exists titular_cuenta text', tbl);
    execute format('alter table public.%I add column if not exists banco text', tbl);
    execute format('alter table public.%I add column if not exists tipo_cuenta text', tbl);
  end loop;
exception when others then
  raise notice '[fase06] columnas bancarias del beneficiario no agregadas: %', sqlerrm;
end $$;

-- Backfill conservador: si no hay razón social, la razón social ES el nombre; y si
-- no hay titular declarado, se asume que cobra el propio proveedor.
update public.proveedores
   set razon_social = coalesce(razon_social, nombre),
       titular_cuenta = coalesce(titular_cuenta, nombre)
 where razon_social is null or titular_cuenta is null;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1) CAJA CHICA — fondo · rendición · gasto
-- ══════════════════════════════════════════════════════════════════════════════

-- 1.1) El FONDO: la bolsa de dinero asignada de forma permanente a una persona.
--      Un conductor o un administrativo tiene UN fondo; sobre él se abren N
--      rendiciones en el tiempo. `tope` es el máximo que puede tener en la calle.
create table if not exists public.caja_chica_fondos (
  id                  bigserial primary key,
  nombre              text not null,                       -- "Caja chica · Juan Pérez"
  responsable_tipo    text not null default 'conductor'
                      check (responsable_tipo in ('conductor','usuario','otro')),
  responsable_nombre  text not null,                       -- copia legible (el plan pide usuario_responsable)
  documento_identidad text,                                -- DNI del responsable
  cuenta_tesoreria_id bigint references public.cuentas_tesoreria(id) on delete set null,
  moneda              text not null default 'PEN',
  tope                numeric(14,2) not null default 0,     -- 0 = sin tope
  dias_para_rendir    int not null default 7,               -- vencido esto, la rendición está atrasada
  activo              boolean not null default true,
  observaciones       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- FKs a tablas legadas (tipo de PK resuelto en runtime).
select public._fin_add_fk('caja_chica_fondos','conductor_id','conductores');
select public._fin_add_fk('caja_chica_fondos','usuario_id','usuarios');

create index if not exists idx_cc_fondos_activo on public.caja_chica_fondos (activo);
create index if not exists idx_cc_fondos_resp   on public.caja_chica_fondos (responsable_tipo);

-- 1.2) La RENDICIÓN: un ciclo entrega-de-dinero → gastos → devolución/reposición.
--      Es el equivalente normalizado de `caja_chica_viaticos` del Plan Maestro.
--      monto_rendido y saldo_pendiente NO viven aquí: se derivan (ver 1.5).
create table if not exists public.caja_chica_rendiciones (
  id                bigserial primary key,
  codigo            text unique,                            -- CC-AAAA-NNNNNN (trigger)
  fondo_id          bigint not null references public.caja_chica_fondos(id) on delete cascade,
  periodo_desde     date not null default current_date,
  periodo_hasta     date,
  fecha_entrega     date not null default current_date,
  fecha_limite      date,                                   -- fecha_entrega + fondo.dias_para_rendir
  monto_asignado    numeric(14,2) not null default 0,
  monto_devuelto    numeric(14,2) not null default 0,       -- efectivo que el responsable devolvió
  moneda            text not null default 'PEN',
  estado            text not null default 'abierta'
                    check (estado in ('abierta','por_revisar','observada','liquidada','anulada')),
  -- Trazabilidad del dinero entregado y del reembolso posterior.
  pago_entrega_id   bigint references public.pagos(id) on delete set null,
  pago_reembolso_id bigint references public.pagos(id) on delete set null,
  enviada_at        timestamptz,                            -- cuando el responsable la cierra
  revisada_por      text,
  fecha_revision    timestamptz,
  aprobada_por      text,
  fecha_aprobacion  timestamptz,
  motivo_observacion text,
  observaciones     text,
  creado_por        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
select public._fin_add_fk('caja_chica_rendiciones','vehiculo_id','vehiculos');

create index if not exists idx_cc_rend_fondo  on public.caja_chica_rendiciones (fondo_id, fecha_entrega desc);
create index if not exists idx_cc_rend_estado on public.caja_chica_rendiciones (estado);
-- Un fondo no puede tener dos rendiciones vivas a la vez: es la base del bloqueo.
create unique index if not exists uq_cc_rend_abierta
  on public.caja_chica_rendiciones (fondo_id)
  where estado in ('abierta','por_revisar','observada');

-- 1.3) El GASTO rendido: una línea = un comprobante (peaje, lavado, estacionamiento…).
--      Sustituye a `comprobantes_json`: así se filtra por categoría, se suma por
--      vehículo, se ata a una reserva y entra a v_egresos como cualquier otro egreso.
create table if not exists public.caja_chica_gastos (
  id                bigserial primary key,
  rendicion_id      bigint not null references public.caja_chica_rendiciones(id) on delete cascade,
  fecha             date not null default current_date,
  categoria         text not null default 'otro'
                    check (categoria in ('peaje','lavado','estacionamiento','viaticos','movilidad',
                                         'repuesto_menor','combustible','tramite','multa','otro')),
  descripcion       text,
  monto             numeric(14,2) not null check (monto > 0),
  moneda            text not null default 'PEN',
  -- Datos fiscales del comprobante (opcionales: un peaje suele venir sin RUC).
  tipo_comprobante  text,                                   -- boleta|ticket|factura|recibo|sin_comprobante
  ruc_proveedor     text,
  comprobante_serie text,
  comprobante_numero text,
  igv               numeric(14,2) not null default 0,
  -- Evidencia. foto_hash permite detectar el mismo ticket reenviado dos veces.
  foto_url          text,
  foto_hash         text,
  lat               double precision,
  lng               double precision,
  capturado_en      timestamptz,
  -- Revisión por el área administrativa.
  estado_revision   text not null default 'pendiente'
                    check (estado_revision in ('pendiente','aprobado','rechazado')),
  motivo_rechazo    text,
  revisado_por      text,
  fecha_revision    timestamptz,
  origen            text not null default 'manual',          -- manual|conductor_app|radar|importacion
  observaciones     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Enganche al servicio y a los recursos (el pedido central del usuario).
select public._fin_add_fk('caja_chica_gastos','reserva_id','reservas');
select public._fin_add_fk('caja_chica_gastos','vehiculo_id','vehiculos');
select public._fin_add_fk('caja_chica_gastos','conductor_id','conductores');
select public._fin_add_fk('caja_chica_gastos','proveedor_id','proveedores');
-- Cuando un gasto rendido se promueve al libro `gastos` queda apuntado aquí, para
-- que NUNCA se cuente dos veces (regla de oro).
select public._fin_add_fk('caja_chica_gastos','gasto_id','gastos');

create index if not exists idx_cc_gastos_rend   on public.caja_chica_gastos (rendicion_id);
create index if not exists idx_cc_gastos_fecha  on public.caja_chica_gastos (fecha desc);
create index if not exists idx_cc_gastos_estado on public.caja_chica_gastos (estado_revision);
-- Anti-duplicado nº1: el mismo responsable no puede rendir dos veces la MISMA foto.
create unique index if not exists uq_cc_gastos_foto_hash
  on public.caja_chica_gastos (rendicion_id, foto_hash)
  where foto_hash is not null;

-- Anti-duplicado nº2: clave de idempotencia del cliente. El índice de arriba es PARCIAL
-- (solo protege lo que tiene foto), así que un gasto declarado SIN comprobante —una
-- movilidad, un parqueo sin papel— entraría dos veces si la respuesta se pierde después
-- de que el servidor ya insertó y la cola offline del conductor lo reintenta.
-- La app manda un id propio por envío (`_cola_id`) y aquí se guarda como llave.
alter table public.caja_chica_gastos add column if not exists idem_key text;
create unique index if not exists uq_cc_gastos_idem
  on public.caja_chica_gastos (idem_key)
  where idem_key is not null;

-- 1.4) Correlativo CC-AAAA-NNNNNN (mismo patrón atómico que pagos/OC).
create table if not exists public.caja_chica_secuencia (
  clave  text primary key,        -- 'CC-2026'
  ultimo int not null default 0
);
alter table public.caja_chica_secuencia enable row level security;

create or replace function public.fn_cc_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio  int;
  v_clave text;
  v_n     int;
begin
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;
  v_anio  := extract(year from coalesce(new.fecha_entrega,
                                        (now() at time zone 'America/Lima')::date))::int;
  v_clave := 'CC-' || v_anio::text;

  insert into public.caja_chica_secuencia (clave, ultimo)
    values (v_clave, 1)
    on conflict (clave) do update set ultimo = caja_chica_secuencia.ultimo + 1
    returning ultimo into v_n;

  new.codigo := v_clave || '-' || lpad(v_n::text, 6, '0');
  return new;
end $$;

drop trigger if exists trg_cc_set_codigo on public.caja_chica_rendiciones;
create trigger trg_cc_set_codigo
  before insert on public.caja_chica_rendiciones
  for each row execute function public.fn_cc_set_codigo();

-- fecha_limite automática a partir de los días pactados en el fondo.
create or replace function public.fn_cc_set_fecha_limite()
returns trigger
language plpgsql
as $$
declare v_dias int;
begin
  if new.fecha_limite is null then
    select dias_para_rendir into v_dias from public.caja_chica_fondos where id = new.fondo_id;
    new.fecha_limite := coalesce(new.fecha_entrega, current_date) + coalesce(v_dias, 7);
  end if;
  return new;
end $$;

drop trigger if exists trg_cc_fecha_limite on public.caja_chica_rendiciones;
create trigger trg_cc_fecha_limite
  before insert on public.caja_chica_rendiciones
  for each row execute function public.fn_cc_set_fecha_limite();

-- 1.5) Vista de rendiciones con los DERIVADOS que el Plan Maestro pedía como columnas.
--      monto_rendido = Σ gastos NO rechazados. saldo_pendiente = asignado − rendido − devuelto.
create or replace view public.v_caja_chica_rendiciones as
  select r.id,
         r.codigo,
         r.fondo_id,
         f.nombre                as fondo_nombre,
         f.responsable_tipo,
         f.responsable_nombre,
         f.documento_identidad,
         f.conductor_id,
         r.vehiculo_id,
         r.periodo_desde,
         r.periodo_hasta,
         r.fecha_entrega,
         r.fecha_limite,
         r.monto_asignado,
         coalesce(g.rendido, 0)                          as monto_rendido,
         coalesce(g.pendiente_revision, 0)               as monto_por_revisar,
         coalesce(g.rechazado, 0)                        as monto_rechazado,
         r.monto_devuelto,
         (r.monto_asignado - coalesce(g.rendido, 0) - r.monto_devuelto) as saldo_pendiente,
         coalesce(g.n_comprobantes, 0)                   as comprobantes,
         r.moneda,
         r.estado,
         -- Atrasada = sigue viva y ya pasó su fecha límite (hora de Lima).
         (r.estado in ('abierta','por_revisar','observada')
          and r.fecha_limite < (now() at time zone 'America/Lima')::date) as atrasada,
         greatest(0, (now() at time zone 'America/Lima')::date - r.fecha_limite) as dias_atraso,
         r.pago_entrega_id,
         r.pago_reembolso_id,
         r.enviada_at,
         r.revisada_por,
         r.fecha_revision,
         r.aprobada_por,
         r.fecha_aprobacion,
         r.motivo_observacion,
         r.observaciones,
         r.created_at
    from public.caja_chica_rendiciones r
    join public.caja_chica_fondos f on f.id = r.fondo_id
    left join lateral (
      select sum(cg.monto) filter (where cg.estado_revision <> 'rechazado') as rendido,
             sum(cg.monto) filter (where cg.estado_revision = 'pendiente')  as pendiente_revision,
             sum(cg.monto) filter (where cg.estado_revision = 'rechazado')  as rechazado,
             count(*)                                                       as n_comprobantes
        from public.caja_chica_gastos cg
       where cg.rendicion_id = r.id
    ) g on true;

-- 1.6) Saldo consolidado por fondo (para la bandeja y para la regla de bloqueo).
create or replace view public.v_caja_chica_saldos as
  select f.id                                     as fondo_id,
         f.nombre,
         f.responsable_tipo,
         f.responsable_nombre,
         f.conductor_id,
         f.moneda,
         f.tope,
         f.activo,
         count(v.id) filter (where v.estado in ('abierta','por_revisar','observada'))   as rendiciones_vivas,
         count(v.id) filter (where v.atrasada)                                          as rendiciones_atrasadas,
         coalesce(sum(v.saldo_pendiente) filter
                  (where v.estado in ('abierta','por_revisar','observada')), 0)         as saldo_en_calle,
         max(v.fecha_entrega)                                                           as ultima_entrega
    from public.caja_chica_fondos f
    left join public.v_caja_chica_rendiciones v on v.fondo_id = f.id
   group by f.id, f.nombre, f.responsable_tipo, f.responsable_nombre,
            f.conductor_id, f.moneda, f.tope, f.activo;

-- 1.7) LA REGLA DEL PLAN MAESTRO: "bloquea asignación de fondos si el responsable
--      tiene entregas a rendir pendientes". Devuelve el veredicto y el porqué, para
--      que la UI muestre el motivo exacto en vez de un "no se puede" seco.
create or replace function public.fn_caja_chica_puede_asignar(p_fondo_id bigint)
returns table (
  puede                  boolean,
  motivo                 text,
  rendiciones_vivas      int,
  rendiciones_atrasadas  int,
  saldo_en_calle         numeric,
  tope                   numeric
)
language plpgsql
stable
as $$
declare r record;
begin
  select * into r from public.v_caja_chica_saldos s where s.fondo_id = p_fondo_id;

  if not found then
    return query select false, 'El fondo de caja chica no existe.', 0, 0, 0::numeric, 0::numeric;
    return;
  end if;

  if r.activo = false then
    return query select false, 'El fondo está inactivo.',
                 r.rendiciones_vivas::int, r.rendiciones_atrasadas::int, r.saldo_en_calle, r.tope;
    return;
  end if;

  if r.rendiciones_atrasadas > 0 then
    return query select false,
                 format('Tiene %s rendición(es) vencida(s) sin liquidar por S/ %s.',
                        r.rendiciones_atrasadas, to_char(r.saldo_en_calle, 'FM999G999D00')),
                 r.rendiciones_vivas::int, r.rendiciones_atrasadas::int, r.saldo_en_calle, r.tope;
    return;
  end if;

  if r.rendiciones_vivas > 0 then
    return query select false,
                 format('Ya tiene una rendición abierta sin liquidar (S/ %s). Ciérrala antes de entregar más dinero.',
                        to_char(r.saldo_en_calle, 'FM999G999D00')),
                 r.rendiciones_vivas::int, r.rendiciones_atrasadas::int, r.saldo_en_calle, r.tope;
    return;
  end if;

  if r.tope > 0 and r.saldo_en_calle >= r.tope then
    return query select false,
                 format('Alcanzó su tope de S/ %s.', to_char(r.tope, 'FM999G999D00')),
                 r.rendiciones_vivas::int, r.rendiciones_atrasadas::int, r.saldo_en_calle, r.tope;
    return;
  end if;

  return query select true, 'Habilitado para recibir fondos.',
               r.rendiciones_vivas::int, r.rendiciones_atrasadas::int, r.saldo_en_calle, r.tope;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2) GASTOS GENERALES — planilla, gerencia, servicios fijos, tributos
--    (tabla `gastos_generales_planilla` del Plan Maestro, con nombre más corto y
--     con el ciclo de aprobación/pago que el plan pedía en la UI).
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists public.gastos_generales (
  id                    bigserial primary key,
  codigo                text unique,                        -- GG-AAAA-NNNNNN (trigger)
  categoria             text not null default 'servicios_fijos'
                        check (categoria in ('planilla','gasto_gerencia','tercerizado',
                                             'servicios_fijos','tributos','mantenimiento',
                                             'financiero','otro')),
  beneficiario_nombre   text not null,
  documento_identidad   text,                                -- DNI / RUC del beneficiario
  concepto              text not null,
  descripcion           text,
  periodo               text,                                -- '2026-08' (mes al que corresponde)
  fecha                 date not null default current_date,  -- fecha de devengue
  fecha_vencimiento     date,
  monto                 numeric(14,2) not null default 0,
  moneda                text not null default 'PEN',
  -- Datos para el pago masivo (Telecrédito).
  banco_destino         text,
  cuenta_destino        text,
  cci_destino           text,
  -- Eje 1: aprobación (gerencia).
  estado_aprobacion     text not null default 'pendiente'
                        check (estado_aprobacion in ('pendiente','aprobado','rechazado')),
  aprobado_por          text,
  fecha_aprobacion      timestamptz,
  motivo_rechazo        text,
  -- Eje 2: pago (ortogonal al anterior, igual que en documentos_compra).
  estado_pago           text not null default 'impaga'
                        check (estado_pago in ('impaga','parcial','pagada')),
  nro_operacion_bancaria text,
  fecha_pago            date,
  -- Recurrencia: un alquiler o un sueldo se repite todos los meses.
  recurrente            boolean not null default false,
  periodicidad          text check (periodicidad in ('mensual','quincenal','semanal','anual')),
  comprobante_ref       text,                                -- N° boleta / recibo por honorarios / contrato
  comprobante_url       text,
  observaciones         text,
  creado_por            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
select public._fin_add_fk('gastos_generales','proveedor_id','proveedores');
select public._fin_add_fk('gastos_generales','vehiculo_id','vehiculos');
select public._fin_add_fk('gastos_generales','conductor_id','conductores');
select public._fin_add_fk('gastos_generales','reserva_id','reservas');

create index if not exists idx_gg_categoria on public.gastos_generales (categoria);
create index if not exists idx_gg_fecha     on public.gastos_generales (fecha desc);
create index if not exists idx_gg_aprob     on public.gastos_generales (estado_aprobacion);
create index if not exists idx_gg_pago      on public.gastos_generales (estado_pago);
create index if not exists idx_gg_venc      on public.gastos_generales (fecha_vencimiento)
  where estado_pago <> 'pagada';

create table if not exists public.gastos_generales_secuencia (
  clave  text primary key,
  ultimo int not null default 0
);
alter table public.gastos_generales_secuencia enable row level security;

create or replace function public.fn_gg_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio  int;
  v_clave text;
  v_n     int;
begin
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;
  v_anio  := extract(year from coalesce(new.fecha, (now() at time zone 'America/Lima')::date))::int;
  v_clave := 'GG-' || v_anio::text;

  insert into public.gastos_generales_secuencia (clave, ultimo)
    values (v_clave, 1)
    on conflict (clave) do update set ultimo = gastos_generales_secuencia.ultimo + 1
    returning ultimo into v_n;

  new.codigo := v_clave || '-' || lpad(v_n::text, 6, '0');
  return new;
end $$;

drop trigger if exists trg_gg_set_codigo on public.gastos_generales;
create trigger trg_gg_set_codigo
  before insert on public.gastos_generales
  for each row execute function public.fn_gg_set_codigo();

-- ══════════════════════════════════════════════════════════════════════════════
-- 3) CUENTAS POR PAGAR — el eje OPERATIVO que le faltaba a `documentos_compra`
--    (formato OSLO: placa, código de servicio, turno/ruta, adelantos) + el ciclo
--    de aprobación de gerencia y el nº de operación bancaria.
-- ══════════════════════════════════════════════════════════════════════════════
alter table public.documentos_compra add column if not exists vehiculo_placa         text;
alter table public.documentos_compra add column if not exists codigo_servicio        text;   -- COD-OSLO-01
alter table public.documentos_compra add column if not exists detalle_servicio       text;   -- turno día/noche · ruta
alter table public.documentos_compra add column if not exists turno                  text;   -- dia | noche | mixto
alter table public.documentos_compra add column if not exists fecha_servicio         date;
alter table public.documentos_compra add column if not exists adelanto_1             numeric(14,2) not null default 0;
alter table public.documentos_compra add column if not exists adelanto_2             numeric(14,2) not null default 0;
alter table public.documentos_compra add column if not exists nro_operacion_bancaria text;
alter table public.documentos_compra add column if not exists fecha_pago             date;
alter table public.documentos_compra add column if not exists voucher_url            text;
alter table public.documentos_compra add column if not exists titular_cuenta         text;
alter table public.documentos_compra add column if not exists banco_destino          text;
alter table public.documentos_compra add column if not exists cuenta_destino         text;
alter table public.documentos_compra add column if not exists cci_destino            text;
select public._fin_add_fk('documentos_compra','vehiculo_id','vehiculos');
select public._fin_add_fk('documentos_compra','reserva_id','reservas');

-- `liquidacion_proveedor_id` la declara finanzas-03, PERO el encabezado de
-- liquidaciones-v2.sql dice que la fase 03 nunca se corrió — y aun así
-- lib/liquidaciones.ts:768 escribe esa columna al aprobar una liquidación de
-- proveedor. Se agrega aquí de forma defensiva: sin ella, v_cuentas_por_pagar (7.2)
-- no se puede crear y abortaría toda esta migración.
--
-- La COLUMNA va aparte del FK a propósito: _fin_add_fk se rinde cuando la tabla
-- destino no existe, así que en una base sin finanzas-03 no llegaba a crearla y la
-- vista de CxP caía con "column d.liquidacion_proveedor_id does not exist". La
-- columna se crea siempre; la integridad referencial se agrega solo si hay a qué
-- apuntar, y si luego se corre la fase 03 esta misma línea la engancha.
alter table public.documentos_compra add column if not exists liquidacion_proveedor_id bigint;
select public._fin_add_fk('documentos_compra','liquidacion_proveedor_id','liquidacion_proveedor');

-- Estado de la DETRACCIÓN, independiente del estado de pago de la factura: se puede
-- haber pagado al proveedor y seguir debiendo el depósito al Banco de la Nación.
alter table public.documentos_compra add column if not exists estado_detraccion text not null default 'no_aplica';
alter table public.documentos_compra drop constraint if exists documentos_compra_estado_detraccion_chk;
alter table public.documentos_compra
  add constraint documentos_compra_estado_detraccion_chk
  check (estado_detraccion in ('no_aplica','pendiente','pagada'));
alter table public.documentos_compra add column if not exists detraccion_codigo      text;
alter table public.documentos_compra add column if not exists detraccion_constancia  text;   -- nº constancia BN
alter table public.documentos_compra add column if not exists detraccion_fecha_pago  date;

-- Backfill: toda factura de compra con detracción > 0 y sin estado nace PENDIENTE.
update public.documentos_compra
   set estado_detraccion = 'pendiente'
 where coalesce(detraccion_monto, 0) > 0
   and estado_detraccion = 'no_aplica';

-- EJE DE APROBACIÓN — ORTOGONAL a estado_pago (que sigue siendo impaga|parcial|pagada).
-- El Plan Maestro lo pedía como un solo enum de 5 pasos; separarlo evita que "aprobado"
-- y "pagado" se pisen y permite rechazar una factura ya parcialmente pagada.
alter table public.documentos_compra add column if not exists estado_aprobacion text not null default 'pendiente';
alter table public.documentos_compra drop constraint if exists documentos_compra_estado_aprobacion_chk;
alter table public.documentos_compra
  add constraint documentos_compra_estado_aprobacion_chk
  check (estado_aprobacion in ('pendiente','aprobado_gerencia','incluido_lote','rechazado'));
alter table public.documentos_compra add column if not exists aprobado_por     text;
alter table public.documentos_compra add column if not exists fecha_aprobacion timestamptz;
alter table public.documentos_compra add column if not exists motivo_rechazo   text;

-- MONTO A CANCELAR — calculado, exactamente como lo pide el plan.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'documentos_compra'
       and column_name = 'monto_a_cancelar'
  ) then
    execute $q$
      alter table public.documentos_compra
        add column monto_a_cancelar numeric(14,2)
        generated always as (
          coalesce(total,0) - coalesce(adelanto_1,0) - coalesce(adelanto_2,0)
                            - coalesce(detraccion_monto,0) - coalesce(retencion_monto,0)
        ) stored
    $q$;
  end if;
exception when others then
  raise notice '[fase06] monto_a_cancelar no se pudo crear como columna generada (%): se deriva en la vista', sqlerrm;
end $$;

create index if not exists idx_docs_compra_aprob     on public.documentos_compra (estado_aprobacion);
create index if not exists idx_docs_compra_detrac    on public.documentos_compra (estado_detraccion)
  where estado_detraccion = 'pendiente';
create index if not exists idx_docs_compra_cod_serv  on public.documentos_compra (codigo_servicio);
create index if not exists idx_docs_compra_placa     on public.documentos_compra (vehiculo_placa);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4) LOTES DE PAGO — la "aprobación masiva" y el archivo para Telecrédito BCP
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists public.lotes_pago (
  id                  bigserial primary key,
  codigo              text unique,                          -- LP-AAAA-NNNNNN (trigger)
  fecha               date not null default current_date,
  fecha_programada    date,                                 -- cuándo se ejecuta en el banco
  cuenta_tesoreria_id bigint references public.cuentas_tesoreria(id) on delete set null,
  banco               text default 'BCP',
  moneda              text not null default 'PEN',
  estado              text not null default 'borrador'
                      check (estado in ('borrador','aprobado','enviado_banco','pagado','anulado')),
  total               numeric(14,2) not null default 0,     -- se recalcula por trigger
  items               int not null default 0,
  archivo_url         text,                                 -- TXT/CSV generado para el banco
  aprobado_por        text,
  fecha_aprobacion    timestamptz,
  observaciones       text,
  creado_por          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_lotes_estado on public.lotes_pago (estado, fecha desc);

create table if not exists public.lotes_pago_items (
  id                bigserial primary key,
  lote_id           bigint not null references public.lotes_pago(id) on delete cascade,
  -- Qué se está pagando. Mismo vocabulario que pagos_aplicacion + los nuevos orígenes.
  documento_tipo    text not null
                    check (documento_tipo in ('documento_compra','gasto_general',
                                              'caja_chica_rendicion','detraccion','otro')),
  documento_id      bigint,
  -- Datos del abono (se copian al armar el lote: si el proveedor cambia de cuenta
  -- después, el lote conserva la cuenta con la que realmente se pagó).
  beneficiario      text not null,
  documento_identidad text,
  banco             text,
  cuenta_destino    text,
  cci_destino       text,
  monto             numeric(14,2) not null check (monto > 0),
  moneda            text not null default 'PEN',
  referencia        text,                                   -- glosa que ve el beneficiario
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente','pagado','rechazado')),
  nro_operacion     text,
  fecha_pago        date,
  pago_id           bigint references public.pagos(id) on delete set null,
  motivo_rechazo    text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_lote_items_lote on public.lotes_pago_items (lote_id);
create index if not exists idx_lote_items_doc  on public.lotes_pago_items (documento_tipo, documento_id);
-- Un mismo documento no puede estar dos veces en el mismo lote.
create unique index if not exists uq_lote_items_doc
  on public.lotes_pago_items (lote_id, documento_tipo, documento_id)
  where documento_id is not null;

create table if not exists public.lote_secuencia (
  clave  text primary key,
  ultimo int not null default 0
);
alter table public.lote_secuencia enable row level security;

create or replace function public.fn_lote_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio  int;
  v_clave text;
  v_n     int;
begin
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;
  v_anio  := extract(year from coalesce(new.fecha, (now() at time zone 'America/Lima')::date))::int;
  v_clave := 'LP-' || v_anio::text;

  insert into public.lote_secuencia (clave, ultimo)
    values (v_clave, 1)
    on conflict (clave) do update set ultimo = lote_secuencia.ultimo + 1
    returning ultimo into v_n;

  new.codigo := v_clave || '-' || lpad(v_n::text, 6, '0');
  return new;
end $$;

drop trigger if exists trg_lote_set_codigo on public.lotes_pago;
create trigger trg_lote_set_codigo
  before insert on public.lotes_pago
  for each row execute function public.fn_lote_set_codigo();

-- Total e items del lote SIEMPRE recalculados desde sus líneas (nunca a mano).
create or replace function public.fn_lote_recalcular()
returns trigger
language plpgsql
as $$
declare v_lote bigint;
begin
  v_lote := coalesce(new.lote_id, old.lote_id);
  update public.lotes_pago l
     set total = coalesce((select sum(i.monto) from public.lotes_pago_items i
                            where i.lote_id = v_lote and i.estado <> 'rechazado'), 0),
         items = coalesce((select count(*) from public.lotes_pago_items i
                            where i.lote_id = v_lote), 0),
         updated_at = now()
   where l.id = v_lote;
  return null;
end $$;

drop trigger if exists trg_lote_items_recalc on public.lotes_pago_items;
create trigger trg_lote_items_recalc
  after insert or update or delete on public.lotes_pago_items
  for each row execute function public.fn_lote_recalcular();

-- ══════════════════════════════════════════════════════════════════════════════
-- 5) CONCILIACIÓN BANCARIA — importación de extractos + Regla Cero Fugas
-- ══════════════════════════════════════════════════════════════════════════════

-- 5.1) Cabecera: una importación de extracto (un archivo).
create table if not exists public.extractos_bancarios (
  id                  bigserial primary key,
  cuenta_tesoreria_id bigint references public.cuentas_tesoreria(id) on delete set null,
  banco               text not null default 'BCP',
  archivo_nombre      text,
  periodo_desde       date,
  periodo_hasta       date,
  filas_leidas        int not null default 0,
  filas_nuevas        int not null default 0,
  filas_duplicadas    int not null default 0,
  saldo_final         numeric(14,2),
  importado_por       text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_extractos_cuenta on public.extractos_bancarios (cuenta_tesoreria_id, created_at desc);

-- 5.2) Movimientos del extracto. `hash_fila` hace la importación idempotente: volver
--      a subir el mismo archivo (o un rango solapado) NO duplica movimientos.
create table if not exists public.extractos_bancarios_movimientos (
  id                  bigserial primary key,
  extracto_id         bigint references public.extractos_bancarios(id) on delete set null,
  cuenta_tesoreria_id bigint references public.cuentas_tesoreria(id) on delete set null,
  fecha_movimiento    date not null,
  fecha_valuta        date,
  nro_operacion       text,
  descripcion_banco   text,
  monto_cargo         numeric(14,2) not null default 0,     -- salida de dinero (débito)
  monto_abono         numeric(14,2) not null default 0,     -- entrada de dinero (crédito)
  saldo               numeric(14,2),
  moneda              text not null default 'PEN',
  estado_conciliacion text not null default 'no_identificado'
                      check (estado_conciliacion in ('conciliado','no_identificado','observado','ignorado')),
  -- Contra qué se casó (el `orden_pago_id` del Plan Maestro, tipado).
  documento_tipo      text check (documento_tipo in ('documento_compra','gasto_general',
                                                     'caja_chica_rendicion','factura','lote_pago','otro')),
  documento_id        bigint,
  pago_id             bigint references public.pagos(id) on delete set null,
  movimiento_tesoreria_id bigint references public.movimientos_tesoreria(id) on delete set null,
  conciliado_por      text,
  fecha_conciliacion  timestamptz,
  observaciones       text,
  hash_fila           text not null,
  created_at          timestamptz not null default now()
);
create unique index if not exists uq_extracto_mov_hash
  on public.extractos_bancarios_movimientos (hash_fila);
create index if not exists idx_extracto_mov_fecha  on public.extractos_bancarios_movimientos (fecha_movimiento desc);
create index if not exists idx_extracto_mov_estado on public.extractos_bancarios_movimientos (estado_conciliacion);
create index if not exists idx_extracto_mov_op     on public.extractos_bancarios_movimientos (nro_operacion);

-- 5.3) REGLA CERO FUGAS: todo cargo del banco que el ERP no sabe justificar.
create or replace view public.v_fugas_bancarias as
  select m.id,
         m.cuenta_tesoreria_id,
         c.nombre               as cuenta_nombre,
         m.fecha_movimiento,
         m.nro_operacion,
         m.descripcion_banco,
         m.monto_cargo,
         m.moneda,
         m.estado_conciliacion,
         (now() at time zone 'America/Lima')::date - m.fecha_movimiento as dias_sin_justificar
    from public.extractos_bancarios_movimientos m
    left join public.cuentas_tesoreria c on c.id = m.cuenta_tesoreria_id
   where m.monto_cargo > 0
     and m.estado_conciliacion in ('no_identificado','observado');

-- ══════════════════════════════════════════════════════════════════════════════
-- 6) ENGANCHE GASTO → SERVICIO EJECUTADO Y LIQUIDADO
--    Hoy solo `gastos` tiene reserva_id; combustible y mantenimiento se inyectan en
--    v_egresos con null hardcodeado, así que un servicio propio no tiene costo real.
-- ══════════════════════════════════════════════════════════════════════════════
select public._fin_add_fk('combustible',   'reserva_id','reservas');
select public._fin_add_fk('mantenimiento', 'reserva_id','reservas');
-- Los neumáticos son costo de VEHÍCULO (se amortizan por km), no de un servicio
-- puntual: a propósito NO reciben reserva_id. Sí entran a v_egresos (ver 7.1), que
-- es la inconsistencia por la que hoy /gastos y /finanzas dan totales distintos.
alter table public.neumaticos add column if not exists documento_compra_id bigint;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_neumaticos_documento_compra_id') then
    alter table public.neumaticos
      add constraint fk_neumaticos_documento_compra_id
      foreign key (documento_compra_id) references public.documentos_compra(id) on delete set null;
  end if;
exception when others then
  raise notice '[fase06] FK neumaticos.documento_compra_id no creada: %', sqlerrm;
end $$;

create index if not exists idx_combustible_reserva   on public.combustible (reserva_id);
create index if not exists idx_mantenimiento_reserva on public.mantenimiento (reserva_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- 7) VISTAS CANÓNICAS
-- ══════════════════════════════════════════════════════════════════════════════

-- 7.1) v_egresos AMPLIADA. Sigue siendo el plano de GESTIÓN (costo real por
--      vehículo/servicio), NO el fiscal — documentos_compra se suma aparte para no
--      contar el mismo sol dos veces. Novedades frente a finanzas-00:
--        · entran neumáticos (antes quedaban fuera y descuadraban /gastos vs /finanzas)
--        · entran caja chica y gastos generales
--        · combustible y mantenimiento ya no fuerzan reserva_id = null
--      Se hace DROP porque cambia la lista de columnas (create or replace no puede).
drop view if exists public.v_egresos cascade;
create view public.v_egresos as
  select 'gasto'::text            as fuente,
         g.id::bigint             as origen_id,
         g.fecha,
         coalesce(g.categoria, 'otro')   as concepto,
         g.monto::numeric         as monto,
         'PEN'::text              as moneda,
         g.vehiculo_id,
         g.reserva_id::bigint     as reserva_id,
         g.proveedor_id,
         coalesce(g.estado, 'pendiente') as estado,
         g.documento_compra_id
    from public.gastos g
  union all
  select 'combustible', c.id::bigint, c.fecha,
         'combustible', c.total::numeric, 'PEN', c.vehiculo_id, c.reserva_id::bigint, null::int,
         'pagado', c.documento_compra_id
    from public.combustible c
  union all
  select 'mantenimiento', m.id::bigint, m.fecha,
         'mantenimiento', coalesce(m.costo, 0)::numeric, 'PEN', m.vehiculo_id, m.reserva_id::bigint, null::int,
         coalesce(m.estado, 'pendiente'), m.documento_compra_id
    from public.mantenimiento m
  union all
  select 'neumaticos', n.id::bigint, coalesce(n.fecha_instalacion, n.created_at::date),
         'neumaticos', coalesce(n.costo_compra, 0)::numeric, 'PEN', n.vehiculo_id, null::bigint, null::int,
         'pagado', n.documento_compra_id
    from public.neumaticos n
   where coalesce(n.costo_compra, 0) > 0
  union all
  select 'caja_chica', cg.id::bigint, cg.fecha,
         cg.categoria, cg.monto::numeric, cg.moneda, cg.vehiculo_id, cg.reserva_id::bigint, cg.proveedor_id,
         case cg.estado_revision when 'aprobado' then 'pagado'
                                 when 'rechazado' then 'anulado'
                                 else 'pendiente' end,
         null::bigint
    from public.caja_chica_gastos cg
   -- Si el gasto ya se promovió al libro `gastos`, NO se cuenta aquí (regla de oro).
   where cg.gasto_id is null
  union all
  select 'gasto_general', gg.id::bigint, gg.fecha,
         gg.categoria, gg.monto::numeric, gg.moneda, gg.vehiculo_id, gg.reserva_id::bigint, gg.proveedor_id,
         case gg.estado_pago when 'pagada' then 'pagado' else 'pendiente' end,
         null::bigint
    from public.gastos_generales gg
   where gg.estado_aprobacion <> 'rechazado';

-- 7.2) v_cuentas_por_pagar — la forma que pide el Plan Maestro, sobre la fuente única.
--      El saldo se DERIVA de pagos_aplicacion, nunca se guarda.
create or replace view public.v_cuentas_por_pagar as
  select d.id,
         d.proveedor_id,
         coalesce(d.razon_social, p.nombre)          as proveedor_razon_social,
         coalesce(d.ruc_emisor, p.ruc)               as proveedor_ruc,
         coalesce(d.titular_cuenta, p.nombre)        as titular_cuenta,
         coalesce(d.banco_destino, p.banco)          as banco,
         coalesce(d.cuenta_destino, p.cuenta_bancaria) as numero_cuenta,
         coalesce(d.cci_destino, p.cci)              as cci,
         d.empresa_tercerizada_id,
         d.vehiculo_id,
         d.vehiculo_placa,
         d.codigo_servicio,
         d.detalle_servicio,
         d.turno,
         d.fecha_servicio,
         d.reserva_id,
         d.tipo_comprobante,
         d.serie,
         d.numero,
         nullif(concat_ws('-', d.serie, d.numero), '') as numero_factura,
         d.fecha_emision,
         d.fecha_vencimiento,
         d.moneda,
         d.subtotal,
         d.igv,
         d.total                                     as monto_neto,
         d.adelanto_1,
         d.adelanto_2,
         d.detraccion_pct,
         d.detraccion_monto,
         d.detraccion_codigo,
         d.estado_detraccion,
         d.detraccion_constancia,
         d.detraccion_fecha_pago,
         d.retencion_monto,
         (coalesce(d.total,0) - coalesce(d.adelanto_1,0) - coalesce(d.adelanto_2,0)
                              - coalesce(d.detraccion_monto,0) - coalesce(d.retencion_monto,0))
                                                     as monto_a_cancelar,
         coalesce(ap.pagado, 0)                      as pagado,
         (coalesce(d.total,0) - coalesce(ap.pagado, 0)) as saldo,
         d.estado_aprobacion,
         d.aprobado_por,
         d.fecha_aprobacion,
         d.estado_pago,
         d.estado_conciliacion,
         d.nro_operacion_bancaria,
         d.fecha_pago,
         d.voucher_url,
         d.categoria,
         d.oc_id,
         d.liquidacion_proveedor_id,
         li.lote_id,
         d.origen,
         d.observaciones,
         -- Aging respecto de hoy (Lima). Negativo = aún no vence.
         ((now() at time zone 'America/Lima')::date - d.fecha_vencimiento) as dias_vencido,
         d.created_at
    from public.documentos_compra d
    left join public.proveedores p on p.id = d.proveedor_id
    left join lateral (
      select sum(pa.monto_aplicado) as pagado
        from public.pagos_aplicacion pa
        join public.pagos pg on pg.id = pa.pago_id and pg.anulado = false
       where pa.documento_tipo = 'documento_compra' and pa.documento_id = d.id
    ) ap on true
    left join lateral (
      select i.lote_id
        from public.lotes_pago_items i
       where i.documento_tipo = 'documento_compra' and i.documento_id = d.id
       order by i.id desc limit 1
    ) li on true
   where coalesce(d.estado_conciliacion, '') <> 'anulado';

-- 7.3) v_detracciones_pendientes — la bandeja de control SUNAT / Banco de la Nación.
--      Une el lado COMPRA (documentos_compra) con el lado VENTA (facturas), que es
--      donde el cliente nos detrae a nosotros.
--
--      El lado VENTA lee columnas de `facturas`, una tabla LEGADA cuyo DDL nunca se
--      versionó (solo vive en Supabase): monto_detraccion, nro_op_detraccion y
--      fecha_detraccion se infirieron del tipo del front. Por eso ese medio se agrega
--      condicionalmente: si esas columnas no existen, la vista se crea solo con el lado
--      COMPRA (que es el que alimenta el pago al Banco de la Nación) en vez de abortar
--      la migración entera.
do $vw$
declare v_tiene_venta boolean;
begin
  select count(*) = 3 into v_tiene_venta
    from information_schema.columns
   where table_schema = 'public' and table_name = 'facturas'
     and column_name in ('monto_detraccion','nro_op_detraccion','fecha_detraccion');

  if v_tiene_venta then
    execute $q$
      create or replace view public.v_detracciones_pendientes as
        select 'compra'::text                  as lado,
               d.id                            as origen_id,
               coalesce(d.razon_social, p.nombre) as contraparte,
               coalesce(d.ruc_emisor, p.ruc)   as ruc,
               nullif(concat_ws('-', d.serie, d.numero), '') as comprobante,
               d.fecha_emision,
               d.total,
               d.detraccion_codigo,
               d.detraccion_pct,
               d.detraccion_monto,
               d.estado_detraccion,
               d.detraccion_constancia,
               d.detraccion_fecha_pago,
               ((now() at time zone 'America/Lima')::date - d.fecha_emision) as dias_desde_emision
          from public.documentos_compra d
          left join public.proveedores p on p.id = d.proveedor_id
         where coalesce(d.detraccion_monto, 0) > 0
           and d.estado_detraccion = 'pendiente'
        union all
        select 'venta',
               f.id,
               cl.nombre,
               cl.ruc,
               nullif(concat_ws('-', f.serie, f.numero), ''),
               f.fecha_emision,
               f.total,
               null::text,
               null::numeric,
               coalesce(f.monto_detraccion, 0),
               case when f.nro_op_detraccion is not null then 'pagada' else 'pendiente' end,
               f.nro_op_detraccion,
               f.fecha_detraccion,
               ((now() at time zone 'America/Lima')::date - f.fecha_emision)
          from public.facturas f
          left join public.clientes cl on cl.id = f.cliente_id
         where coalesce(f.monto_detraccion, 0) > 0
           and f.nro_op_detraccion is null
           and coalesce(f.estado, '') <> 'anulada'
    $q$;
  else
    raise notice '[fase06] facturas no tiene las columnas de detracción de VENTA: v_detracciones_pendientes se crea solo con el lado COMPRA';
    execute $q$
      create or replace view public.v_detracciones_pendientes as
        select 'compra'::text                  as lado,
               d.id                            as origen_id,
               coalesce(d.razon_social, p.nombre) as contraparte,
               coalesce(d.ruc_emisor, p.ruc)   as ruc,
               nullif(concat_ws('-', d.serie, d.numero), '') as comprobante,
               d.fecha_emision,
               d.total,
               d.detraccion_codigo,
               d.detraccion_pct,
               d.detraccion_monto,
               d.estado_detraccion,
               d.detraccion_constancia,
               d.detraccion_fecha_pago,
               ((now() at time zone 'America/Lima')::date - d.fecha_emision) as dias_desde_emision
          from public.documentos_compra d
          left join public.proveedores p on p.id = d.proveedor_id
         where coalesce(d.detraccion_monto, 0) > 0
           and d.estado_detraccion = 'pendiente'
    $q$;
  end if;
end $vw$;


-- 7.4) v_costo_servicio — LA VISTA QUE PEDÍA EL USUARIO: qué costó de verdad cada
--      servicio EJECUTADO, contra lo que se le cobró al cliente, y en qué estado de
--      liquidación/facturación/cobro está. Solo costos DIRECTOS (los que llevan
--      reserva_id); los costos de vehículo (neumáticos) no se prorratean aquí porque
--      el criterio de prorrateo es una decisión contable, no un dato.
create or replace view public.v_costo_servicio as
  select r.id                                   as reserva_id,
         r.codigo,
         r.fecha_servicio,
         r.cliente_id,
         r.origen,
         r.destino,
         r.ruta_nombre,
         r.tipo_asignacion,
         r.vehiculo_id,
         r.conductor_id,
         r.empresa_tercerizada_id,
         r.estado,
         r.estado_admin,
         r.estado_proveedor,
         r.liquidacion_cliente_id,
         r.liquidacion_proveedor_id,
         r.fecha_liquidacion,
         r.fecha_facturacion,
         r.fecha_cobro,
         coalesce(r.precio_cliente, 0)::numeric as ingreso,
         coalesce(r.costo_proveedor, 0)::numeric as costo_proveedor_pactado,
         coalesce(e.costo_gastos, 0)            as costo_gastos,
         coalesce(e.costo_combustible, 0)       as costo_combustible,
         coalesce(e.costo_mantenimiento, 0)     as costo_mantenimiento,
         coalesce(e.costo_caja_chica, 0)        as costo_caja_chica,
         coalesce(e.costo_gastos_generales, 0)  as costo_gastos_generales,
         coalesce(cxp.costo_facturado_tercero, 0) as costo_facturado_tercero,
         -- Costo real directo: todo lo que lleva el reserva_id de este servicio.
         (coalesce(e.costo_gastos, 0) + coalesce(e.costo_combustible, 0)
          + coalesce(e.costo_mantenimiento, 0) + coalesce(e.costo_caja_chica, 0)
          + coalesce(e.costo_gastos_generales, 0) + coalesce(cxp.costo_facturado_tercero, 0))
                                                as costo_real,
         (coalesce(r.precio_cliente, 0)
          - coalesce(e.costo_gastos, 0) - coalesce(e.costo_combustible, 0)
          - coalesce(e.costo_mantenimiento, 0) - coalesce(e.costo_caja_chica, 0)
          - coalesce(e.costo_gastos_generales, 0) - coalesce(cxp.costo_facturado_tercero, 0))
                                                as margen_real,
         coalesce(e.n_egresos, 0)               as egresos_registrados,
         -- ¿Este servicio ya está cerrado del lado del cliente y del proveedor?
         (r.estado_admin in ('liquidada','facturada','cobrada'))       as liquidado_cliente,
         (r.estado_proveedor in ('conciliada','por_pagar','pagada'))   as liquidado_proveedor
    from public.reservas r
    left join lateral (
      select sum(v.monto) filter (where v.fuente = 'gasto')          as costo_gastos,
             sum(v.monto) filter (where v.fuente = 'combustible')    as costo_combustible,
             sum(v.monto) filter (where v.fuente = 'mantenimiento')  as costo_mantenimiento,
             sum(v.monto) filter (where v.fuente = 'caja_chica')     as costo_caja_chica,
             sum(v.monto) filter (where v.fuente = 'gasto_general')  as costo_gastos_generales,
             count(*)                                                as n_egresos
        from public.v_egresos v
       where v.reserva_id = r.id and coalesce(v.estado, '') <> 'anulado'
    ) e on true
    left join lateral (
      select sum(dd.subtotal) as costo_facturado_tercero
        from public.documentos_compra_detalle dd
        join public.documentos_compra dc on dc.id = dd.documento_compra_id
       where dd.reserva_id = r.id
         and coalesce(dc.estado_conciliacion, '') <> 'anulado'
    ) cxp on true
   where r.estado = 'finalizada';

-- ══════════════════════════════════════════════════════════════════════════════
-- 8) BITÁCORA DE IMPORTACIONES — para saber qué Google Sheet entró, cuándo y con qué
--    resultado, y poder revertir una carga histórica que salió mal.
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists public.importaciones_finanzas (
  id              bigserial primary key,
  perfil          text not null,                            -- cxp_oslo | cxp_tradicional | gastos_generales | …
  destino_tabla   text not null,
  archivo_nombre  text,
  filas_leidas    int not null default 0,
  filas_creadas   int not null default 0,
  filas_actualizadas int not null default 0,
  filas_con_error int not null default 0,
  errores_json    jsonb,
  ids_creados     jsonb,                                    -- permite deshacer la carga
  importado_por   text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_import_fin_fecha on public.importaciones_finanzas (created_at desc);

-- ══════════════════════════════════════════════════════════════════════════════
-- 9) updated_at automático en las tablas nuevas que lo declaran.
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.fn_fase06_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['caja_chica_fondos','caja_chica_rendiciones','caja_chica_gastos',
                           'gastos_generales','lotes_pago'] loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I for each row execute function public.fn_fase06_touch_updated_at()',
      t, t);
  end loop;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 10) RLS — mismo patrón `authenticated` del resto del ERP.
-- ══════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['caja_chica_fondos','caja_chica_rendiciones','caja_chica_gastos',
                           'gastos_generales','lotes_pago','lotes_pago_items',
                           'extractos_bancarios','extractos_bancarios_movimientos',
                           'importaciones_finanzas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      t || '_auth', t);
  end loop;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 11) STORAGE — bucket privado para vouchers y comprobantes de caja chica.
--     Privado a propósito: un ticket de peaje trae placa y ubicación. Se lee con
--     createSignedUrl (patrón de app/clientes/page.tsx), no con getPublicUrl.
-- ══════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
  values ('comprobantes', 'comprobantes', false)
  on conflict (id) do nothing;

do $$
begin
  drop policy if exists "comprobantes_leer"   on storage.objects;
  drop policy if exists "comprobantes_subir"  on storage.objects;
  drop policy if exists "comprobantes_borrar" on storage.objects;

  create policy "comprobantes_leer" on storage.objects
    for select using (bucket_id = 'comprobantes' and auth.role() = 'authenticated');
  create policy "comprobantes_subir" on storage.objects
    for insert with check (bucket_id = 'comprobantes' and auth.role() = 'authenticated');
  create policy "comprobantes_borrar" on storage.objects
    for delete using (bucket_id = 'comprobantes' and auth.role() = 'authenticated');
exception when others then
  raise notice '[fase06] políticas del bucket comprobantes no aplicadas (%): créalas desde el panel', sqlerrm;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select * from public.v_caja_chica_saldos order by saldo_en_calle desc;
-- select * from public.fn_caja_chica_puede_asignar(1);
-- select fuente, count(*), sum(monto) from public.v_egresos group by 1 order by 3 desc;
-- select * from public.v_cuentas_por_pagar where saldo > 0 order by dias_vencido desc limit 20;
-- select * from public.v_detracciones_pendientes order by dias_desde_emision desc;
-- select * from public.v_fugas_bancarias order by fecha_movimiento desc;
-- Rentabilidad real de los servicios ya liquidados:
--   select count(*), sum(ingreso), sum(costo_real), sum(margen_real)
--     from public.v_costo_servicio where liquidado_cliente;
