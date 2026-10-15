-- ═══════════════════════════════════════════════════════════════════════════
-- diagnostico-seguros.sql · SOLO LEE. Se pega entero en Supabase → SQL Editor → Run.
--
-- Para qué: antes de correr seguros-01/02/03, saber qué hay de verdad.
-- /seguros lee solo la tabla `seguros` (sin migración en el repo) y sale vacía,
-- mientras el SOAT vive en documentos_vehiculo/documentos_tercero y el
-- SCTR/Vida Ley en las fichas de conductores y personal_administrativo.
-- Cada bloque devuelve una tabla; el Editor muestra el ÚLTIMO resultado, así
-- que si hace falta ver uno en concreto, se selecciona y se corre solo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columnas y tipos reales de `seguros` (vacío = la tabla no existe).
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'seguros'
order by ordinal_position;

-- 2. Tipo del id de cada tabla a la que seguros-01/02 apuntan con FK
--    (las FK se crean en bigint: sirve contra int y bigint, NO contra uuid).
select table_name, data_type
from information_schema.columns
where table_schema = 'public' and column_name = 'id'
  and table_name in ('seguros','conductores','personal_administrativo',
                     'vehiculos','vehiculos_tercero','proveedores')
order by table_name;

-- 3. Columnas de la ficha que leerá v_seguro_persona (deben salir 4 por tabla).
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('conductores','personal_administrativo')
  and column_name in ('sctr_salud_venc','sctr_pension_venc','vida_ley','vida_ley_venc')
order by table_name, column_name;

-- 4. Todo lo demás en una sola tabla de conteos.
select 'seguros · filas' as que, null::text as tipo, count(*) as n
from public.seguros
union all
select 'seguros · por tipo', tipo, count(*) from public.seguros group by tipo
union all
select 'documentos_vehiculo', tipo, count(*) from public.documentos_vehiculo group by tipo
union all
select 'documentos_tercero', tipo, count(*) from public.documentos_tercero group by tipo
union all
select 'conductores', 'sctr_salud_venc', count(*) from public.conductores where sctr_salud_venc is not null
union all
select 'conductores', 'sctr_pension_venc', count(*) from public.conductores where sctr_pension_venc is not null
union all
select 'conductores', 'vida_ley_venc (con vida_ley)', count(*) from public.conductores
  where vida_ley_venc is not null and vida_ley is true
union all
select 'personal_administrativo', 'sctr_salud_venc', count(*) from public.personal_administrativo
  where sctr_salud_venc is not null
union all
select 'personal_administrativo', 'sctr_pension_venc', count(*) from public.personal_administrativo
  where sctr_pension_venc is not null
union all
select 'personal_administrativo', 'vida_ley_venc (con vida_ley)', count(*) from public.personal_administrativo
  where vida_ley_venc is not null and vida_ley is true
order by 1, 2;
-- Si el bloque 4 falla con 42P01 en `seguros`, la tabla no existe: quita esas
-- dos primeras líneas del union y vuelve a correrlo.

-- FIN de diagnostico-seguros.sql
