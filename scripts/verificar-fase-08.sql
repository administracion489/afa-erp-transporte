-- ══════════════════════════════════════════════════════════════════════════════
-- Verificación de la fase 08 — caja chica para TODO el personal.
-- Pégalo entero en el SQL Editor de Supabase y dale Run, DESPUÉS de correr
-- supabase/finanzas-08-caja-chica-todo-el-personal.sql.
--
-- Es UNA SOLA consulta a propósito: el SQL Editor de Supabase solo muestra el
-- resultado de la ÚLTIMA sentencia, así que si esto fueran tres consultas
-- separadas solo verías la tercera. Todo sale en una tabla, en tres bloques:
--   1 · REVISIÓN     — cada pieza de la migración
--   2 · TUS FONDOS   — cuánto hay en la calle por área
--   3 · TUS EGRESOS  — no debe haber cambiado con esta migración
-- ══════════════════════════════════════════════════════════════════════════════

with revision as (

  select 'El fondo acepta personal administrativo' as detalle,
         case when exists (
           select 1 from pg_constraint
            where conname = 'caja_chica_fondos_responsable_tipo_check'
              and pg_get_constraintdef(oid) like '%personal_administrativo%'
         ) then '✅ correcto' else '❌ FALTA — vuelve a correr finanzas-08' end as estado

  union all
  select 'Columna caja_chica_fondos.' || c,
         case when exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'caja_chica_fondos' and column_name = c
         ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-08' end
    from unnest(array['personal_administrativo_id','cargo','centro_costo']) as c

  union all
  select 'Un solo fondo activo por persona (' || i || ')',
         case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i)
              then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-08' end
    from unnest(array['uq_cc_fondo_conductor','uq_cc_fondo_administrativo']) as i

  union all
  select 'El fondo no puede apuntar a dos personas a la vez',
         case when exists (select 1 from pg_constraint where conname = 'cc_fondos_responsable_coherente')
              then '✅ correcto' else '❌ FALTA — vuelve a correr finanzas-08' end

  union all
  select 'Las vistas publican el área derivada',
         case when (
           select count(*) from information_schema.columns
            where table_schema = 'public'
              and table_name in ('v_caja_chica_rendiciones','v_caja_chica_saldos')
              and column_name = 'area'
         ) = 2 then '✅ correcto'
         else '⚠️ revisar — ¿existe la tabla personal_administrativo?' end

  union all
  select 'Vista v_caja_chica_por_area (gasto por área y mes)',
         case when exists (
           select 1 from information_schema.views
            where table_schema = 'public' and table_name = 'v_caja_chica_por_area'
         ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-08' end

  union all
  select 'Categorías de oficina en los comprobantes',
         case when exists (
           select 1 from pg_constraint
            where conname = 'caja_chica_gastos_categoria_check'
              and pg_get_constraintdef(oid) like '%utiles_oficina%'
              and pg_get_constraintdef(oid) like '%representacion%'
         ) then '✅ correcto' else '❌ FALTA — vuelve a correr finanzas-08' end

  union all
  -- Este arregla la fragilidad de la fase 06 en bases sin finanzas-03.
  select 'documentos_compra.liquidacion_proveedor_id (lo pide v_cuentas_por_pagar)',
         case when exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'documentos_compra'
              and column_name = 'liquidacion_proveedor_id'
         ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-06' end

  union all
  select 'La regla de bloqueo sigue viva',
         case when exists (select 1 from pg_proc where proname = 'fn_caja_chica_puede_asignar')
              then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-06' end
),

fondos as (
  select responsable_tipo || ' · ' || coalesce(area, 'Sin área') as detalle,
         count(*)::text || ' fondo(s) · S/ ' || to_char(coalesce(sum(saldo_en_calle), 0), 'FM999G999G990D00')
           || ' en la calle' as estado
    from public.v_caja_chica_saldos
   group by responsable_tipo, area
),

egresos as (
  select fuente as detalle,
         count(*)::text || ' fila(s) · S/ ' || to_char(sum(monto), 'FM999G999G990D00') as estado
    from public.v_egresos
   group by fuente
)

select '1 · REVISIÓN' as bloque, detalle, estado from revision
union all
select '2 · TUS FONDOS', detalle, estado from fondos
union all
select '2 · TUS FONDOS', '(todavía no hay ningún fondo creado)', 'Créalos en /caja-chica → Fondos'
 where not exists (select 1 from public.v_caja_chica_saldos)
union all
select '3 · TUS EGRESOS', detalle, estado from egresos
union all
select '3 · TUS EGRESOS', 'TOTAL', 'S/ ' || to_char(coalesce(sum(monto), 0), 'FM999G999G990D00')
  from public.v_egresos
 order by 1, 2;
