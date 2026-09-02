-- ────────────────────────────────────────────────────────────────────────────
-- costeo-01-planilla-y-presupuesto.sql — Qué cuesta de verdad un servicio con
-- unidad propia, y cuánto deja antes de impuestos.
--
-- EL PROBLEMA
--
-- El ERP sabe qué GASTÓ un servicio: v_egresos junta combustible, peajes, caja
-- chica y mantenimiento por reserva, y v_costo_servicio los suma. Lo que no sabe
-- es dos cosas:
--
--   1) Qué PENSABA gastar. Sin un plan no hay desvío, y sin desvío el costo real
--      es un número que se mira y no enseña nada.
--   2) Cuánto cuesta el CONDUCTOR y el DESGASTE de la unidad. Ninguno de los dos
--      llega como comprobante atado a la reserva, así que hoy valen cero y todo
--      servicio propio parece dejar el 100 % de margen.
--
-- LO QUE AGREGA
--
--   config_laboral_regimen      — los TRES regímenes del Perú, con vigencia
--   config_laboral              — cuál usa esta empresa, la RMV y el SCTR
--   conductores.sueldo_basico   — lo que falta para calcular su costo empresa
--   cat_concepto_costo          — un solo catálogo de conceptos de costo
--   servicio_costo_estimado     — el presupuesto, con su desglose
--   v_conductor_planilla        — los INSUMOS del costo empresa (no la fórmula)
--   v_utilidad_servicio         — la utilidad antes de impuestos, por servicio
--
-- LA FÓRMULA NO ESTÁ AQUÍ, A PROPÓSITO. El costo empresa de un conductor se
-- calcula en lib/costeo-conductor.ts. Si además se calculara en SQL habría dos
-- motores con la misma fórmula, y el día que divergen nadie sabe cuál creer — es
-- la misma razón por la que lib/costeo-propio.ts se extrajo del cotizador en vez
-- de copiarse. Aquí las vistas publican los INSUMOS ya resueltos.
--
-- Requiere: finanzas-06 (v_egresos, gastos_generales), pacto-01 (v_costo_servicio),
-- contabilidad-04 (activos_fijos, depreciacion). Es aditivo: no toca nada existente.
-- ────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- 1) LOS TRES REGÍMENES LABORALES
--
-- No se configura "el régimen de AFA": se cargan los tres y la empresa elige el
-- suyo. El ERP puede venderse a quien esté en microempresa o en general, y una
-- constante en el código haría ese cambio imposible sin tocar el código.
--
-- VIGENCIA. Las filas no se editan al cambiar de régimen ni al cambiar una tasa:
-- se inserta una nueva con otra fecha. Así los servicios de agosto se costean con
-- las reglas de agosto aunque en noviembre la empresa pase a general. Sin esto,
-- cambiar de régimen reescribiría la historia y todos los márgenes pasados se
-- moverían solos.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.config_laboral_regimen (
  id                        bigserial primary key,
  regimen                   text not null
                            check (regimen in ('microempresa','pequena_empresa','general')),
  vigente_desde             date not null default current_date,
  nombre                    text not null,

  -- ── Salud ──
  -- En microempresa el trabajador va al SIS y el empleador aporta un monto fijo
  -- (o puede optar por EsSalud). En pequeña y general, EsSalud sobre la
  -- remuneración computable.
  essalud_pct               numeric(6,4) not null default 0.09,
  usa_sis                   boolean      not null default false,
  sis_aporte_mensual        numeric(10,2) not null default 0,

  -- ── Gratificaciones, en SUELDOS al año ──
  -- General 2 (julio y diciembre completos). Pequeña 1 (medio y medio).
  -- Micro 0: no le corresponde.
  gratificaciones_sueldos   numeric(6,4) not null default 2,
  -- Bonificación extraordinaria de la Ley 30334: el 9 % de EsSalud que no se
  -- aporta sobre la gratificación se le entrega al trabajador. Es costo igual.
  bonif_extraordinaria_pct  numeric(6,4) not null default 0.09,

  -- ── CTS, en SUELDOS equivalentes al año ──
  -- General: un sueldo más 1/6 de gratificación = 1.1667.
  -- Pequeña: 15 remuneraciones diarias = medio sueldo = 0.5 (tope 90 diarias).
  -- Micro: no le corresponde.
  cts_sueldos_anio          numeric(6,4) not null default 1.1667,

  -- No cambia el desembolso mensual, pero SÍ los días trabajados del año, que es
  -- el divisor del costo por día.
  vacaciones_dias           int not null default 30,

  notas                     text,
  created_at                timestamptz not null default now(),
  unique (regimen, vigente_desde)
);

comment on table public.config_laboral_regimen is
  'Los tres regímenes laborales peruanos con sus factores, versionados por fecha de '
  'vigencia. La empresa elige el suyo en config_laboral. Las tasas cambian por norma: '
  'la verdad es la fila de esta tabla, nunca una constante en el código.';

-- Semilla con las reglas vigentes a septiembre de 2026. Se inserta solo si la
-- tabla está vacía: re-correr el archivo no debe pisar tasas ya ajustadas.
insert into public.config_laboral_regimen
  (regimen, vigente_desde, nombre, essalud_pct, usa_sis, sis_aporte_mensual,
   gratificaciones_sueldos, bonif_extraordinaria_pct, cts_sueldos_anio, vacaciones_dias, notas)
select * from (values
  ('microempresa'::text, date '2025-01-01', 'Microempresa (hasta 150 UIT)'::text,
   0.00::numeric, true, 0.00::numeric,
   0.00::numeric, 0.00::numeric, 0.00::numeric, 15,
   'Sin gratificaciones ni CTS. El trabajador va al SIS y el empleador aporta el 50 % del semicontributivo; si la empresa opta por EsSalud, poner usa_sis = false y essalud_pct = 0.09.'::text),
  ('pequena_empresa', date '2025-01-01', 'Pequeña empresa (150 a 1700 UIT)',
   0.09, false, 0.00,
   1.00, 0.09, 0.50, 15,
   'Gratificación de medio sueldo en julio y medio en diciembre. CTS de 15 remuneraciones diarias al año, tope 90.'),
  ('general', date '2025-01-01', 'Régimen general',
   0.09, false, 0.00,
   2.00, 0.09, 1.1667, 30,
   'Dos gratificaciones completas y CTS de un sueldo más un sexto de gratificación.')
) as v(regimen, vigente_desde, nombre, essalud_pct, usa_sis, sis_aporte_mensual,
       gratificaciones_sueldos, bonif_extraordinaria_pct, cts_sueldos_anio, vacaciones_dias, notas)
where not exists (select 1 from public.config_laboral_regimen);

-- ════════════════════════════════════════════════════════════════════════════
-- 2) LO QUE ESTA EMPRESA USA
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.config_laboral (
  id                       int primary key default 1 check (id = 1),
  regimen                  text not null default 'pequena_empresa'
                           check (regimen in ('microempresa','pequena_empresa','general')),
  -- Remuneración Mínima Vital. Base de la asignación familiar (10 %).
  rmv                      numeric(10,2) not null default 1130,
  asignacion_familiar_pct  numeric(6,4)  not null default 0.10,
  -- SCTR de respaldo, en soles por trabajador y mes. Manda la factura del período
  -- cuando existe: ver v_conductor_planilla.
  sctr_mensual_defecto     numeric(10,2) not null default 20,
  -- Divisor alternativo, para poder contrastar el costo por día con servicio
  -- contra el teórico. Ver la nota de v_conductor_planilla.
  dias_laborables_mes      int not null default 26,
  updated_at               timestamptz not null default now()
);

insert into public.config_laboral (id) values (1) on conflict (id) do nothing;

comment on table public.config_laboral is
  'Fila única: qué régimen usa esta empresa y los valores que no dependen del régimen '
  '(RMV, asignación familiar, SCTR de respaldo).';

-- ════════════════════════════════════════════════════════════════════════════
-- 3) LO QUE LE FALTA A LA FICHA DEL CONDUCTOR
--
-- `tipo_contrato` ya existe (planilla | plazo_fijo | honorarios | service |
-- eventual). Faltaba el sueldo y si le corresponde asignación familiar, que
-- depende de tener hijos menores y no de la empresa.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.conductores
  add column if not exists sueldo_basico       numeric(10,2),
  add column if not exists asignacion_familiar boolean not null default false,
  -- Cuando el conductor va por recibo por honorarios, su costo ES el del recibo y
  -- no se prorratea nada.
  add column if not exists honorario_dia       numeric(10,2);

comment on column public.conductores.sueldo_basico is
  'Remuneración básica mensual. De aquí sale el costo EMPRESA (con gratificaciones, '
  'CTS, EsSalud y SCTR según el régimen), que es lo que cuesta de verdad un día de '
  'conductor. El sueldo a secas subestima ese costo entre 24 % y 38 %.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4) UN SOLO CATÁLOGO DE CONCEPTOS DE COSTO
--
-- Hasta ahora había tres listas distintas: la de Seguimiento (`gastos.categoria`),
-- la de caja chica y la que iba a tener el presupuesto. Con tres listas la
-- comparación presupuestado/real no se puede hacer renglón contra renglón: un
-- «viático» presupuestado no encuentra su «refrigerio» real.
--
-- `amortiza` marca los que NO tienen real por servicio: los neumáticos y la
-- depreciación no se gastan en un viaje, se reparten por kilómetro a lo largo de
-- la vida de la unidad. Ponerles una columna «real» por servicio sería inventarla.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.cat_concepto_costo (
  clave           text primary key,
  nombre          text not null,
  -- viaje    → se gasta en ese servicio y tiene comprobante
  -- unidad   → es del vehículo y se amortiza por km
  -- personal → es del conductor y se prorratea por día
  ambito          text not null check (ambito in ('viaje','unidad','personal')),
  -- Con qué se casa el REAL. `gastos.categoria` para lo que se carga en
  -- Seguimiento; `v_egresos.fuente` para combustible y mantenimiento.
  categoria_gasto text,
  fuente_egreso   text,
  amortiza        boolean not null default false,
  orden           int not null default 100,
  activo          boolean not null default true
);

insert into public.cat_concepto_costo (clave, nombre, ambito, categoria_gasto, fuente_egreso, amortiza, orden) values
  ('combustible',     'Combustible',            'viaje',    'combustible',        'combustible',   false, 10),
  ('peajes',          'Peajes',                 'viaje',    'peajes',             'gasto',         false, 20),
  ('viaticos',        'Viáticos del conductor', 'viaje',    'viaticos',           'gasto',         false, 30),
  ('estacionamiento', 'Estacionamiento',        'viaje',    'estacionamiento',    'gasto',         false, 40),
  ('pernocte',        'Pernocte de la unidad',  'viaje',    'otro',               'gasto',         false, 50),
  ('conductor',       'Conductor',              'personal', 'conductor_servicio', 'gasto',         false, 60),
  ('mantenimiento',   'Mantenimiento',          'unidad',   null,                 'mantenimiento', false, 70),
  ('neumaticos',      'Neumáticos',             'unidad',   null,                 null,            true,  80),
  ('depreciacion',    'Depreciación',           'unidad',   null,                 null,            true,  90),
  ('fijos',           'Seguros y permisos',     'unidad',   null,                 null,            true,  95),
  ('multa',           'Multas',                 'viaje',    'multa',              'gasto',         false, 96),
  ('otro',            'Otros del servicio',     'viaje',    'otro',               'gasto',         false, 99)
on conflict (clave) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 5) EL PRESUPUESTO DEL SERVICIO
--
-- TABLA Y NO COLUMNAS EN `reservas`: el desglose son diez renglones, se re-estima
-- cuando aparece el km real del GPS, y hay que poder ver la versión anterior.
--
-- `parametros_json` congela con qué se calculó. Si en octubre sube el diésel, el
-- presupuesto de agosto NO puede moverse solo: se compara contra lo que de verdad
-- se planeó ese día, no contra lo que se habría planeado hoy.
--
-- NUNCA se escribe en reservas.costo_proveedor. Ese campo es lo que se le debe a
-- un tercero; en flota propia no hay tercero (fn_reservas_pacto_nacimiento le pone
-- costo_estado = 'no_aplica'), v_costo_servicio ya lo suma como costo del tercero
-- cuando no hay factura, y cada cambio suyo levanta un acta de compra con folio.
-- Un estimado ahí contaría los mismos soles dos veces y ensuciaría la bandeja de
-- gerencia con actas contra un proveedor inexistente.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.servicio_costo_estimado (
  id              bigserial primary key,
  reserva_id      bigint not null references public.reservas(id) on delete cascade,
  version         int not null default 1,
  km              numeric(10,2),
  -- gps | ruta | manual — de dónde salieron los kilómetros. Un estimado que no
  -- declara su fuente no se puede discutir, y lo que no se discute se ignora.
  km_fuente       text,
  dias            numeric(6,2) not null default 1,
  -- Cuántos servicios se repartieron el día del conductor. 2 = ese día hizo dos
  -- vueltas y cada una carga la mitad.
  servicios_del_dia int not null default 1,
  parametros_json jsonb,
  -- Total del presupuesto y, de ese total, cuánto es imputado (lo que se amortiza
  -- y nunca va a tener un comprobante propio).
  total_estimado  numeric(12,2) not null default 0,
  total_imputado  numeric(12,2) not null default 0,
  notas           text,
  creado_por      text,
  created_at      timestamptz not null default now(),
  unique (reserva_id, version)
);

create table if not exists public.servicio_costo_estimado_linea (
  id           bigserial primary key,
  estimado_id  bigint not null references public.servicio_costo_estimado(id) on delete cascade,
  concepto     text not null references public.cat_concepto_costo(clave),
  monto        numeric(12,2) not null default 0,
  -- Cómo se llegó a ese número: "64 km · 24.5 km/gal medido en 6 cargas · S/ 16.40".
  base         text,
  orden        int not null default 100,
  unique (estimado_id, concepto)
);

create index if not exists idx_costo_estimado_reserva
  on public.servicio_costo_estimado (reserva_id, version desc);

-- La versión vigente de cada servicio. Todo lo que consulta el presupuesto debe
-- leer esta vista y no la tabla, o acabará sumando las versiones viejas.
create or replace view public.v_servicio_costo_estimado as
  select distinct on (e.reserva_id)
         e.id, e.reserva_id, e.version, e.km, e.km_fuente, e.dias,
         e.servicios_del_dia, e.total_estimado, e.total_imputado,
         e.parametros_json, e.notas, e.creado_por, e.created_at
    from public.servicio_costo_estimado e
   order by e.reserva_id, e.version desc;

-- ════════════════════════════════════════════════════════════════════════════
-- 6) LOS INSUMOS DEL COSTO DEL CONDUCTOR
--
-- Publica lo que hace falta para calcular el costo empresa, NO el costo. La
-- fórmula vive en lib/costeo-conductor.ts, una sola vez.
--
-- El SCTR sale de su factura del período cuando existe —repartida entre los
-- conductores activos— y si no del importe configurado. Así el costo sube solo
-- cuando sube la póliza, sin que nadie tenga que acordarse de actualizar nada.
-- ════════════════════════════════════════════════════════════════════════════
create or replace view public.v_conductor_planilla as
  with cfg as (
    select c.regimen, c.rmv, c.asignacion_familiar_pct,
           c.sctr_mensual_defecto, c.dias_laborables_mes
      from public.config_laboral c where c.id = 1
  ),
  reg as (
    -- La fila vigente del régimen que usa la empresa: la más reciente que ya
    -- empezó. Si mañana se agrega una con fecha futura, no afecta a hoy.
    select distinct on (r.regimen) r.*
      from public.config_laboral_regimen r, cfg
     where r.regimen = cfg.regimen and r.vigente_desde <= current_date
     order by r.regimen, r.vigente_desde desc
  ),
  sctr as (
    -- Facturas de SCTR del período, por si se quiere el importe real. Se
    -- identifican por el concepto en gastos_generales; si no hay, manda el
    -- configurado.
    select gg.periodo, sum(gg.monto) as total
      from public.gastos_generales gg
     where gg.categoria in ('planilla','servicios_fijos')
       and gg.concepto ilike '%sctr%'
     group by gg.periodo
  ),
  activos as (
    select count(*)::numeric as n from public.conductores where coalesce(estado,'activo') = 'activo'
  )
  select co.id                                as conductor_id,
         co.nombre,
         co.tipo_contrato,
         co.sueldo_basico,
         co.honorario_dia,
         co.asignacion_familiar               as tiene_asignacion,
         cfg.regimen,
         cfg.rmv,
         cfg.asignacion_familiar_pct,
         cfg.dias_laborables_mes,
         reg.nombre                           as regimen_nombre,
         reg.essalud_pct,
         reg.usa_sis,
         reg.sis_aporte_mensual,
         reg.gratificaciones_sueldos,
         reg.bonif_extraordinaria_pct,
         reg.cts_sueldos_anio,
         reg.vacaciones_dias,
         -- SCTR por persona: la factura del período repartida, o el configurado.
         coalesce(
           (select s.total / nullif(a.n, 0) from sctr s, activos a
             where s.periodo = to_char(current_date, 'YYYY-MM')),
           cfg.sctr_mensual_defecto
         )::numeric(10,2)                     as sctr_mensual
    from public.conductores co, cfg, reg;

comment on view public.v_conductor_planilla is
  'INSUMOS del costo empresa de cada conductor: su sueldo, si le corresponde asignación '
  'familiar, y los factores del régimen vigente. La fórmula NO está aquí — vive en '
  'lib/costeo-conductor.ts, una sola vez, para que no haya dos motores que discrepen.';

-- Días en que un conductor tuvo servicio, y cuántos servicios por día. Es el
-- divisor del costo por día y el repartidor entre los servicios de esa jornada.
create or replace view public.v_conductor_dias_servicio as
  select r.conductor_id,
         to_char(r.fecha_servicio, 'YYYY-MM')      as periodo,
         r.fecha_servicio,
         count(*)::int                             as servicios_del_dia
    from public.reservas r
   where r.conductor_id is not null
     and r.fecha_servicio is not null
     and coalesce(r.estado,'') not in ('cancelada','anulada')
   group by r.conductor_id, r.fecha_servicio;

-- ════════════════════════════════════════════════════════════════════════════
-- 7) LA UTILIDAD ANTES DE IMPUESTOS, POR SERVICIO
--
-- Es el objetivo de todo esto. Tres números que se publican POR SEPARADO porque
-- significan cosas distintas y mezclarlos es lo que hace que un tablero mienta:
--
--   ingreso_real          — el precio SIN IGV. El IGV que le cobras al cliente no
--                           es tuyo: lo tienes un rato y se lo entregas a SUNAT.
--   costo_directo_real    — lo que se gastó y tiene comprobante atado a la reserva.
--   costo_imputado        — conductor, depreciación, neumáticos y fijos. No tienen
--                           comprobante por servicio; salen del presupuesto, que
--                           es la mejor imputación disponible. Si no hay
--                           presupuesto valen 0 y `sin_presupuesto` lo dice.
--
-- «Antes de impuestos» = antes del Impuesto a la Renta. El IGV ya quedó fuera al
-- usar los importes netos, que es lo que hacen fn_ingreso_real / fn_costo_real.
-- ════════════════════════════════════════════════════════════════════════════
create or replace view public.v_utilidad_servicio as
  select cs.reserva_id,
         cs.codigo,
         cs.fecha_servicio,
         cs.cliente_id,
         cs.ruta_nombre,
         cs.tipo_asignacion,
         cs.vehiculo_id,
         cs.conductor_id,
         cs.empresa_tercerizada_id,
         r.origen_contractual,
         cs.ingreso_real,
         -- Egresos con comprobante + el costo del tercero, ya normalizados.
         cs.costo_real                            as costo_directo_real,
         coalesce(imp.monto, 0)::numeric(14,2)    as costo_imputado,
         (cs.ingreso_real - cs.costo_real - coalesce(imp.monto, 0))::numeric(14,2)
                                                  as utilidad_antes_impuestos,
         case when cs.ingreso_real > 0
              then round(((cs.ingreso_real - cs.costo_real - coalesce(imp.monto,0))
                          / cs.ingreso_real) * 100, 2) end
                                                  as utilidad_pct,
         est.total_estimado,
         -- Positivo = se gastó MÁS de lo presupuestado, contando solo lo comparable.
         case when est.total_estimado is not null
              then round(cs.costo_real - (est.total_estimado - est.total_imputado), 2) end
                                                  as desvio,
         (est.id is null)                         as sin_presupuesto,
         cs.egresos_registrados,
         cs.liquidado_cliente,
         cs.liquidado_proveedor
    from public.v_costo_servicio cs
    join public.reservas r on r.id = cs.reserva_id
    left join public.v_servicio_costo_estimado est on est.reserva_id = cs.reserva_id
    left join lateral (
      -- Solo los conceptos que NO tienen comprobante por servicio. Sumar aquí los
      -- que sí lo tienen contaría dos veces lo que ya está en costo_real.
      select sum(l.monto) as monto
        from public.servicio_costo_estimado_linea l
        join public.cat_concepto_costo cc on cc.clave = l.concepto
       where l.estimado_id = est.id
         and (cc.amortiza or cc.ambito = 'personal')
    ) imp on true;

comment on view public.v_utilidad_servicio is
  'Utilidad antes de impuestos por servicio, con el costo directo real y el imputado '
  '(conductor y desgaste) publicados por separado. No agrega: el promedio y los cortes '
  'por cliente, ruta, unidad u origen contractual los hace quien consulta.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['config_laboral_regimen','config_laboral','cat_concepto_costo',
                           'servicio_costo_estimado','servicio_costo_estimado_linea'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth', t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''authenticated'') '
      'with check (auth.role() = ''authenticated'')', t || '_auth', t);
  end loop;
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- 1) Los tres regímenes cargados y cuál usa la empresa:
--
--      select regimen, nombre, gratificaciones_sueldos, cts_sueldos_anio, vacaciones_dias
--        from public.config_laboral_regimen order by regimen;
--      select regimen, rmv, sctr_mensual_defecto from public.config_laboral;
--
-- 2) Conductores a los que les falta el sueldo (sin él no hay costo empresa):
--
--      select id, nombre, tipo_contrato, sueldo_basico, honorario_dia
--        from public.conductores
--       where coalesce(estado,'activo') = 'activo'
--         and coalesce(sueldo_basico, honorario_dia) is null;
--
-- 3) Utilidad del mes, y cuántos servicios todavía no tienen presupuesto:
--
--      select count(*) filter (where sin_presupuesto) as sin_presupuesto,
--             count(*)                                as servicios,
--             round(avg(utilidad_antes_impuestos), 2) as utilidad_promedio,
--             round(avg(utilidad_pct), 2)             as pct_promedio
--        from public.v_utilidad_servicio
--       where fecha_servicio between '2026-09-01' and '2026-09-30';
