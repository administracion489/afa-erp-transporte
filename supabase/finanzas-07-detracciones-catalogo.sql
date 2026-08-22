-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS · FASE 7 — Catálogo de detracciones SUNAT editable
--
-- Requiere: finanzas-00-fundacion.sql (crea cat_detraccion y config_tributaria).
--
-- Dos cosas:
--
--   1) CORRIGE UN ERROR DE LA SEMILLA DE LA FASE 0. Ahí se sembró el código 027 como
--      "Transporte de personas" al 10% y el 026 como "Transporte de bienes/carga" al
--      4%. Están AL REVÉS según el Catálogo 54 de SUNAT:
--          026 = servicio de transporte de PERSONAS        → 10 %  (Anexo 3)
--          027 = servicio de transporte de CARGA/bienes    →  4 %  (R.S. 073-2006)
--      Importa para AFA, que hace transporte de personal: sus comprobantes van con el
--      026. La corrección solo toca las filas que aún tengan el valor equivocado, para
--      no pisar un ajuste que ya haya hecho el contador.
--
--   2) CARGA EL CATÁLOGO COMPLETO y lo vuelve EDITABLE desde la app: se agregan el
--      anexo, la base legal y una nota por código, más `updated_at` para saber cuándo
--      se tocó cada tasa.
--
-- LAS TASAS CAMBIAN POR RESOLUCIÓN DE SUPERINTENDENCIA SIN PREVIO AVISO. Este archivo
-- deja el catálogo cargado al día de hoy; el que manda es el que el contador mantenga
-- desde la pantalla (Cuentas por Pagar → Detracciones → Tasas y códigos).
-- Fuente: apéndices del SPOT en orientacion.sunat.gob.pe y Catálogo 54 de SUNAT.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Columnas nuevas del catálogo.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.cat_detraccion add column if not exists anexo         text;
alter table public.cat_detraccion add column if not exists base_legal    text;
alter table public.cat_detraccion add column if not exists notas         text;
alter table public.cat_detraccion add column if not exists vigente_desde date;
alter table public.cat_detraccion add column if not exists updated_at    timestamptz not null default now();

create or replace function public.fn_cat_detraccion_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_cat_detraccion_touch on public.cat_detraccion;
create trigger trg_cat_detraccion_touch
  before update on public.cat_detraccion
  for each row execute function public.fn_cat_detraccion_touch();

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Corrección del 026 ↔ 027 de la fase 0.
--    Se hace en dos pasos y con guarda: si alguien ya corrigió a mano, no se toca.
-- ────────────────────────────────────────────────────────────────────────────
update public.cat_detraccion
   set descripcion = 'Servicio de transporte de personas',
       porcentaje  = 10.0,
       umbral_min  = 700
 where codigo = '026'
   and porcentaje = 4.0;               -- todavía tiene el valor equivocado

update public.cat_detraccion
   set descripcion = 'Servicio de transporte de carga (bienes por vía terrestre)',
       porcentaje  = 4.0,
       umbral_min  = 400
 where codigo = '027'
   and porcentaje = 10.0;              -- todavía tiene el valor equivocado

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Catálogo completo. `on conflict do nothing` a propósito: agrega lo que falta y
--    NO pisa las tasas que el contador haya ajustado. Para reponer un código a su
--    valor de fábrica, bórralo y vuelve a correr este archivo.
-- ────────────────────────────────────────────────────────────────────────────
insert into public.cat_detraccion (codigo, descripcion, porcentaje, umbral_min, anexo, base_legal, notas, activo) values
  -- ── Anexo 1 · bienes (suspendido desde el 01.01.2015 por la R.S. 343-2014/SUNAT) ──
  ('001', 'Azúcar y melaza de caña',                              10.0, 700, 'Anexo 1', 'R.S. 183-2004/SUNAT', 'Anexo 1 suspendido desde 01.01.2015 (R.S. 343-2014/SUNAT).', false),
  ('003', 'Alcohol etílico',                                      10.0, 700, 'Anexo 1', 'R.S. 183-2004/SUNAT', 'Anexo 1 suspendido desde 01.01.2015 (R.S. 343-2014/SUNAT).', false),

  -- ── Anexo 2 · bienes ──
  ('004', 'Recursos hidrobiológicos',                              4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('005', 'Maíz amarillo duro',                                    4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('007', 'Caña de azúcar',                                       10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('008', 'Madera',                                                4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('009', 'Arena y piedra',                                       10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('010', 'Residuos, subproductos, desechos, recortes y desperdicios', 15.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('014', 'Carnes y despojos comestibles',                         4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('016', 'Aceite de pescado',                                    10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('017', 'Harina, polvo y pellets de pescado, crustáceos y moluscos', 4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('023', 'Leche',                                                 4.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('031', 'Oro gravado con IGV',                                  10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('032', 'Páprika y otros frutos de los géneros capsicum o pimienta', 10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('034', 'Minerales metálicos no auríferos',                     10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('035', 'Bienes exonerados del IGV',                             1.5, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('036', 'Oro y demás minerales metálicos exonerados del IGV',    1.5, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('039', 'Minerales no metálicos',                               10.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),
  ('041', 'Plomo',                                                15.0, 700, 'Anexo 2', 'R.S. 183-2004/SUNAT', null, true),

  -- ── Anexo 3 · servicios ──
  ('012', 'Intermediación laboral y tercerización',               12.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', 'Subió de 10 % a 12 % el 01.04.2018.', true),
  ('019', 'Arrendamiento de bienes',                              10.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', null, true),
  ('020', 'Mantenimiento y reparación de bienes muebles',         12.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', 'Subió de 10 % a 12 % el 01.04.2018.', true),
  ('021', 'Movimiento de carga',                                  10.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', null, true),
  ('022', 'Otros servicios empresariales',                        12.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', 'Subió de 10 % a 12 % el 01.04.2018.', true),
  ('024', 'Comisión mercantil',                                   10.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', null, true),
  ('025', 'Fabricación de bienes por encargo',                    10.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', null, true),
  ('026', 'Servicio de transporte de personas',                   10.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', 'El que suele aplicar AFA: transporte de personal y turístico.', true),
  ('030', 'Contratos de construcción',                             4.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', null, true),
  ('037', 'Demás servicios gravados con IGV',                     12.0, 700, 'Anexo 3', 'R.S. 183-2004/SUNAT', 'Cajón de sastre: aplica cuando el servicio no encaja en ningún otro código.', true),

  -- ── Regímenes propios (no son el Anexo 3) ──
  ('027', 'Servicio de transporte de carga (bienes por vía terrestre)', 4.0, 400, 'Régimen propio', 'R.S. 073-2006/SUNAT', 'Se aplica sobre el importe de la operación o el VALOR REFERENCIAL, el que sea MAYOR. Umbral S/ 400.', true),
  ('028', 'Transporte público de pasajeros por vía terrestre',    10.0,   0, 'Régimen propio', 'R.S. 057-2007/SUNAT', 'Régimen distinto: se deposita un MONTO FIJO por vehículo al pasar por garita, no un porcentaje. Confírmalo con tu contador antes de usarlo.', false)
on conflict (codigo) do nothing;

-- Completar anexo/base legal en las filas que ya existían de la fase 0 y quedaron sin
-- ese dato (el `do nothing` de arriba no las toca).
update public.cat_detraccion
   set anexo = coalesce(anexo, case
         when codigo in ('001','003') then 'Anexo 1'
         when codigo in ('027','028') then 'Régimen propio'
         when codigo in ('012','019','020','021','022','024','025','026','030','037') then 'Anexo 3'
         else 'Anexo 2' end),
       base_legal = coalesce(base_legal, case
         when codigo = '027' then 'R.S. 073-2006/SUNAT'
         when codigo = '028' then 'R.S. 057-2007/SUNAT'
         else 'R.S. 183-2004/SUNAT' end)
 where anexo is null or base_legal is null;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Código por defecto de la empresa. Evita que cada quien elija a mano en cada
--    comprobante: el formulario lo propone y se puede cambiar por operación.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.config_tributaria add column if not exists detraccion_codigo_defecto text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_config_trib_detraccion') then
    alter table public.config_tributaria
      add constraint fk_config_trib_detraccion
      foreign key (detraccion_codigo_defecto) references public.cat_detraccion(codigo) on delete set null;
  end if;
exception when others then
  raise notice '[fase07] FK config_tributaria.detraccion_codigo_defecto no creada: %', sqlerrm;
end $$;

update public.config_tributaria
   set detraccion_codigo_defecto = '026'
 where id = 1 and detraccion_codigo_defecto is null;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select codigo, descripcion, porcentaje, umbral_min, anexo, activo
--   from public.cat_detraccion order by anexo, codigo;
-- select igv_pct, detraccion_activa, detraccion_codigo_defecto from public.config_tributaria;
-- Los dos que importan a AFA:
--   select * from public.cat_detraccion where codigo in ('026','027');
