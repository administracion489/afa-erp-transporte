-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 0.5 — BASE TRIBUTARIA
--
-- Por qué existe: hasta hoy el ERP asumía que TODO lleva IGV 18 %. No es cierto y
-- cuesta plata:
--
--   · Un proveedor GRAVADO que cobra S/ 550 te cuesta S/ 466.10 (el IGV vuelve como
--     crédito fiscal). Un taxi EXONERADO que cobra S/ 500 te cuesta S/ 500.00. El
--     "caro" es 7 % más barato, y hoy la pantalla muestra lo contrario.
--   · Del lado venta conviven transporte de personal (GRAVADO) y paquete turístico a
--     no domiciliado (EXPORTACIÓN, Art. 33 num. 9 de la Ley del IGV). Hoy
--     liquidacion-agrupacion.ts:607 aplica UNA sola tasa a todo el periodo, así que
--     un cierre que mezcle ambos es imposible de emitir bien.
--   · calcularDetraccion (lib/finanzas/dinero.ts) detraía con solo superar el umbral,
--     SIN preguntar si la operación es gravada. Confirmado con el contador de AFA:
--     si no hay IGV, NO hay detracción. Eso se arregla en el mismo commit.
--
-- La regla que implanta esta fase:
--     El monto autoritativo es el NETO (base imponible). La afectación se DECLARA por
--     línea. El "con IGV" se DERIVA, nunca se guarda.
--
-- Es coherente con la regla de oro de finanzas-00-fundacion.sql:22-24 — un solo monto
-- autoritativo, el resto derivado — y con el criterio de finanzas-07: las tasas y los
-- catálogos legales son FILAS editables, jamás constantes en el código.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- No crea triggers ni bloquea ninguna escritura: es 100 % aditivo y reversible.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) CATÁLOGO 07 DE SUNAT — Tipo de afectación del IGV.
--    Se usa el catálogo oficial (y no un enum propio) porque es exactamente lo que
--    pide el comprobante electrónico: así el ERP habla el mismo idioma que la factura
--    y no hay que traducir al emitir.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.cat_afectacion_igv (
  codigo          text primary key,             -- '10' | '20' | '30' | '40' …
  nombre          text not null,
  grava           boolean not null,             -- ¿lleva IGV en el comprobante?
  da_credito      boolean not null,             -- ¿la compra da derecho a crédito fiscal?
  admite_detraccion boolean not null default false,
  base_legal      text,
  notas           text,
  activo          boolean not null default true,
  orden           int not null default 100,
  updated_at      timestamptz not null default now()
);

comment on column public.cat_afectacion_igv.grava is
  'Si es false, el comprobante sale sin IGV. Manda sobre config_tributaria.igv_pct.';
comment on column public.cat_afectacion_igv.da_credito is
  'Lado COMPRA: si es false, el IGV pagado NO se recupera y el costo real es el importe '
  'completo. La exportación da crédito pleno (saldo a favor del exportador).';
comment on column public.cat_afectacion_igv.admite_detraccion is
  'Confirmado con el contador de AFA: sin IGV no hay detracción. Solo el gravado la admite.';

insert into public.cat_afectacion_igv
  (codigo, nombre, grava, da_credito, admite_detraccion, base_legal, notas, orden) values
  ('10','Gravado — Operación onerosa',        true , true , true ,
   'TUO Ley del IGV art. 1',
   'El caso normal de AFA: transporte de PERSONAL. Confirmado con el contador — no entra '
   'en la exoneración del Apéndice II num. 2, que cubre el transporte PÚBLICO de pasajeros.', 10),
  ('20','Exonerado — Operación onerosa',      false, false, false,
   'TUO Ley del IGV, Apéndice II num. 2',
   'Transporte público de pasajeros dentro del país. Es el caso del SERVICIO DE TAXI que AFA '
   'COMPRA. Al no haber IGV no hay crédito fiscal: el costo real es el importe completo.', 20),
  ('30','Inafecto — Operación onerosa',       false, false, false,
   'TUO Ley del IGV art. 2',
   'Operaciones fuera del ámbito del impuesto.', 30),
  ('40','Exportación de bienes o servicios',  false, true , false,
   'TUO Ley del IGV art. 33 num. 9',
   'Paquete turístico a favor de un operador NO DOMICILIADO. Confirmado con el contador de '
   'AFA: sí califica. Sale a 0 % y da derecho a SALDO A FAVOR DEL EXPORTADOR — el IGV de las '
   'compras atribuibles es recuperable. Exige factura con RUC del proveedor.', 40)
on conflict (codigo) do nothing;

alter table public.cat_afectacion_igv enable row level security;
drop policy if exists p_cat_afectacion_rw on public.cat_afectacion_igv;
create policy p_cat_afectacion_rw on public.cat_afectacion_igv
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ────────────────────────────────────────────────────────────────────────────
-- 2) CÓMO SE TECLEA vs CÓMO SE GUARDA.
--    base_captura es lo ÚNICO que elige la casa: si el operador escribe importes con
--    IGV incluido o sin él. El almacenamiento canónico es siempre NETO.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.config_tributaria
  add column if not exists base_captura text not null default 'bruto',
  add column if not exists afectacion_venta_defecto  text not null default '10',
  add column if not exists afectacion_compra_defecto text not null default '10';

alter table public.config_tributaria drop constraint if exists config_trib_base_captura_chk;
alter table public.config_tributaria
  add constraint config_trib_base_captura_chk check (base_captura in ('neto','bruto'));

comment on column public.config_tributaria.base_captura is
  'bruto = el operador tipea el importe CON IGV (convención actual de cotizaciones). '
  'neto = lo tipea sin IGV (convención del tarifario). Solo afecta la CAPTURA en pantalla: '
  'el monto autoritativo que se guarda y con el que se calcula el margen es siempre el neto.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) MAESTROS — de dónde hereda la afectación cada operación.
--    Sin esto no se puede calcular el costo real: si el proveedor es RUS o entrega
--    boleta, el IGV no se recupera y el costo es el importe completo.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  -- Lado VENTA
  if to_regclass('public.clientes') is not null then
    alter table public.clientes
      add column if not exists afectacion_defecto   text,
      add column if not exists sustento_afectacion  text;
    comment on column public.clientes.afectacion_defecto is
      'Catálogo 07. Corporativo → 10 (gravado). Operador turístico del exterior → 40 '
      '(exportación). Si es null se usa config_tributaria.afectacion_venta_defecto.';
  end if;

  -- Lado COMPRA: proveedores y empresas tercerizadas comparten el mismo juego de campos.
  foreach t in array array['proveedores','empresas_tercerizadas'] loop
    if to_regclass('public.' || t) is not null then
      execute format($f$
        alter table public.%I
          add column if not exists afectacion_defecto text,
          add column if not exists regimen_tributario text,
          add column if not exists emite_factura      boolean,
          add column if not exists sustento_afectacion text
      $f$, t);
      execute format($f$
        comment on column public.%I.emite_factura is
          'false = entrega boleta o es RUS: NO hay crédito fiscal y el costo real es el '
          'importe completo, aunque la afectación sea gravada. Null = se asume que sí.'
      $f$, t);
    end if;
  end loop;
end $$;

-- FKs al catálogo (si la tabla destino existe). No abortan la migración.
do $$
declare t text;
begin
  foreach t in array array['clientes','proveedores','empresas_tercerizadas'] loop
    if to_regclass('public.' || t) is not null then
      begin
        execute format(
          'alter table public.%I drop constraint if exists %I', t, t || '_afectacion_fk');
        execute format(
          'alter table public.%I add constraint %I foreign key (afectacion_defecto) '
          'references public.cat_afectacion_igv(codigo) on delete set null', t, t || '_afectacion_fk');
      exception when others then
        raise notice 'No se pudo enlazar %.afectacion_defecto al catálogo: %', t, sqlerrm;
      end;
    end if;
  end loop;
end $$;

-- Semilla de los defaults acordados. Solo toca filas que todavía no declararon nada.
do $$
begin
  if to_regclass('public.clientes') is not null then
    update public.clientes set afectacion_defecto = '10' where afectacion_defecto is null;
  end if;
  if to_regclass('public.proveedores') is not null then
    update public.proveedores set afectacion_defecto = '10' where afectacion_defecto is null;
    -- El taxi es el caso exonerado conocido. Se marca por tipo si la columna existe.
    begin
      update public.proveedores set afectacion_defecto = '20'
       where afectacion_defecto = '10' and lower(coalesce(tipo,'')) like '%taxi%';
    exception when undefined_column then null;
    end;
  end if;
  if to_regclass('public.empresas_tercerizadas') is not null then
    update public.empresas_tercerizadas set afectacion_defecto = '10' where afectacion_defecto is null;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) LA AFECTACIÓN EN EL SERVICIO — heredada del maestro, sobreescribible por servicio.
--    Un mismo proveedor puede darte un bus (gravado) y un taxi (exonerado); la última
--    palabra la tiene el servicio, no la ficha.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists venta_afectacion  text,
  add column if not exists compra_afectacion text;

comment on column public.reservas.compra_afectacion is
  'Catálogo 07 del costo del tercero. Null = hereda de empresas_tercerizadas/proveedores. '
  'Se sobreescribe cuando el mismo proveedor presta un servicio con otra afectación.';

create index if not exists idx_reservas_compra_afect
  on public.reservas (compra_afectacion) where compra_afectacion is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) PRORRATA DEL CRÉDITO FISCAL — latente, no construida.
--
--    AFA COMPRA taxi exonerado pero no lo VENDE, así que hoy no hay prorrata: las
--    ventas son gravadas y exportación, ambas con derecho pleno. Coeficiente 100 %.
--
--    Pero el día que se venda un servicio exonerado, la prorrata mira los ÚLTIMOS 12
--    MESES. Si para entonces las operaciones anteriores no están clasificadas, hay que
--    reconstruir un año a mano. Por eso se deja lista la HISTORIA, no el cálculo:
--    el lado venta ya queda cubierto por venta_afectacion, y el lado compra necesita
--    esta única columna.
--
--    El coeficiente, el ajuste mensual y el reparto del crédito común se escribirán
--    cuando exista el primer caso real, con las reglas que confirme el contador
--    entonces. Construirlos hoy sería adivinar.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.documentos_compra
  add column if not exists destino_credito text not null default 'gravadas';

alter table public.documentos_compra drop constraint if exists documentos_compra_destino_credito_chk;
alter table public.documentos_compra
  add constraint documentos_compra_destino_credito_chk
  check (destino_credito in ('gravadas','no_gravadas','comun'));

comment on column public.documentos_compra.destino_credito is
  'A qué operaciones sirve esta compra. gravadas = crédito 100 % (incluye exportación). '
  'no_gravadas = sin crédito. comun = entra a prorrata. Mientras AFA no venda exonerado, '
  'todo es "gravadas" y la vista v_prorrata_credito_fiscal devuelve "no aplica".';

-- ────────────────────────────────────────────────────────────────────────────
-- 6) FUNCIONES DE COSTEO — el corazón de esta fase.
-- ────────────────────────────────────────────────────────────────────────────

-- Afectación efectiva de la COMPRA de un servicio: servicio → tercerizada → proveedor
-- → default de la casa. Se resuelve en un solo lugar para que la vista, el panel de
-- margen y el comprobante no puedan discrepar.
create or replace function public.fn_afectacion_compra(p_reserva_id bigint)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    r.compra_afectacion,
    (select e.afectacion_defecto from public.empresas_tercerizadas e
      where e.id = r.empresa_tercerizada_id),
    -- La tercerizada puede no declarar nada pero colgar de un proveedor que sí.
    (select p.afectacion_defecto
       from public.empresas_tercerizadas e
       join public.proveedores p on p.id = e.proveedor_id
      where e.id = r.empresa_tercerizada_id),
    (select c.afectacion_compra_defecto from public.config_tributaria c where c.id = 1),
    '10')
  from public.reservas r where r.id = p_reserva_id;
$$;

-- EL COSTO REAL de una compra: lo que de verdad sale del bolsillo de AFA.
--
--   · Gravado con factura → el IGV vuelve como crédito fiscal ⇒ cuesta el NETO.
--   · Exonerado / inafecto, o proveedor sin factura (RUS, boleta) → no hay crédito
--     que recuperar ⇒ cuesta el IMPORTE COMPLETO.
--
-- Es la función que hace comparables al proveedor de 550 y al de 500.
create or replace function public.fn_costo_real(
  p_monto        numeric,
  p_afectacion   text,
  p_emite_factura boolean default true,
  p_base         text default null          -- 'neto' | 'bruto'; null = config_tributaria
) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_igv numeric; v_base text; v_grava boolean; v_credito boolean; v_bruto numeric;
begin
  if p_monto is null or p_monto = 0 then return 0; end if;

  select igv_pct, base_captura into v_igv, v_base from public.config_tributaria where id = 1;
  v_igv  := coalesce(v_igv, 18);
  v_base := coalesce(p_base, v_base, 'bruto');

  select grava, da_credito into v_grava, v_credito
    from public.cat_afectacion_igv where codigo = coalesce(p_afectacion, '10');
  v_grava   := coalesce(v_grava, true);
  v_credito := coalesce(v_credito, true) and coalesce(p_emite_factura, true);

  -- Sin IGV en el comprobante no hay nada que separar: el monto es el costo.
  if not v_grava then return round(p_monto, 2); end if;

  v_bruto := case when v_base = 'neto' then p_monto * (1 + v_igv/100) else p_monto end;

  -- Gravado CON derecho a crédito → el costo es el neto. Sin derecho → el bruto.
  return round(case when v_credito then v_bruto / (1 + v_igv/100) else v_bruto end, 2);
end $$;

comment on function public.fn_costo_real(numeric,text,boolean,text) is
  'Costo comparable de una compra. Ejemplo real de AFA: proveedor gravado que factura '
  'S/ 550 cuesta 466.10; taxi exonerado que cobra S/ 500 cuesta 500.00 — el "caro" es 7 % '
  'más barato. Úsala SIEMPRE antes de comparar dos costos o de calcular un margen.';

-- Ingreso comparable de una venta: el neto, sin el IGV que no es de AFA sino de SUNAT.
create or replace function public.fn_ingreso_real(
  p_monto      numeric,
  p_afectacion text,
  p_base       text default null
) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_igv numeric; v_base text; v_grava boolean;
begin
  if p_monto is null or p_monto = 0 then return 0; end if;

  select igv_pct, base_captura into v_igv, v_base from public.config_tributaria where id = 1;
  v_igv  := coalesce(v_igv, 18);
  v_base := coalesce(p_base, v_base, 'bruto');

  select grava into v_grava from public.cat_afectacion_igv where codigo = coalesce(p_afectacion, '10');
  v_grava := coalesce(v_grava, true);

  -- Exonerado y exportación no llevan IGV: lo cobrado ES el ingreso.
  if not v_grava then return round(p_monto, 2); end if;
  return round(case when v_base = 'neto' then p_monto else p_monto / (1 + v_igv/100) end, 2);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7) VISTA DE PRORRATA — dormida hasta que haga falta.
--    Hoy devuelve aplica=false y coeficiente 100. El día que aparezca una venta no
--    gravada se enciende sola, con la historia ya clasificada detrás.
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_prorrata_credito_fiscal as
with ventas as (
  select coalesce(a.grava, true) as grava,
         coalesce(a.da_credito, true) as da_credito,
         coalesce(r.precio_cliente, 0) as monto
    from public.reservas r
    left join public.clientes cl on cl.id = r.cliente_id
    left join public.cat_afectacion_igv a
           on a.codigo = coalesce(r.venta_afectacion, cl.afectacion_defecto, '10')
   where r.estado = 'finalizada'
     and r.fecha_servicio >= (current_date - interval '12 months')
)
select
  round(coalesce(sum(monto) filter (where da_credito), 0), 2)      as operaciones_con_derecho,
  round(coalesce(sum(monto) filter (where not da_credito), 0), 2)  as operaciones_sin_derecho,
  round(coalesce(sum(monto), 0), 2)                                as total_12_meses,
  case when coalesce(sum(monto), 0) = 0 then 100
       else round(coalesce(sum(monto) filter (where da_credito), 0)
                  / sum(monto) * 100, 2) end                       as coeficiente_pct,
  (coalesce(sum(monto) filter (where not da_credito), 0) > 0)      as aplica,
  case when coalesce(sum(monto) filter (where not da_credito), 0) > 0
       then 'HAY ventas no gravadas en los últimos 12 meses: la prorrata YA aplica. '
            'Clasifica las compras comunes en documentos_compra.destino_credito y pide a '
            'contabilidad las reglas del coeficiente.'
       else 'No aplica: en 12 meses no hay ventas no gravadas. Gravado y exportación dan '
            'derecho pleno al crédito fiscal.' end                 as veredicto
from ventas;

comment on view public.v_prorrata_credito_fiscal is
  'Centinela de la prorrata. Mientras AFA no VENDA exonerado devuelve aplica=false; se '
  'enciende sola el día que aparezca la primera venta no gravada, con 12 meses de historia '
  'ya clasificada. El cálculo del reparto se escribirá recién entonces.';

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   select * from public.cat_afectacion_igv order by orden;
--   select base_captura, afectacion_venta_defecto from public.config_tributaria;
--   select * from public.v_prorrata_credito_fiscal;
--   -- El caso de los dos proveedores, comprobado:
--   select public.fn_costo_real(550, '10', true, 'bruto') as gravado_550,   -- 466.10
--          public.fn_costo_real(500, '20', true, 'bruto') as exonerado_500; -- 500.00
--
-- ROLLBACK (nada de esto es obligatorio: las columnas son aditivas y no molestan)
--   drop view if exists public.v_prorrata_credito_fiscal;
--   drop function if exists public.fn_costo_real(numeric,text,boolean,text);
--   drop function if exists public.fn_ingreso_real(numeric,text,text);
--   drop function if exists public.fn_afectacion_compra(bigint);
-- ══════════════════════════════════════════════════════════════════════════════
