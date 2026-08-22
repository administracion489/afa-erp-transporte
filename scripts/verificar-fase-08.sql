-- ══════════════════════════════════════════════════════════════════════════════
-- Verificación de la fase 08 — caja chica para TODO el personal.
-- Pégalo entero en el SQL Editor de Supabase y dale Run, DESPUÉS de correr
-- supabase/finanzas-08-caja-chica-todo-el-personal.sql.
--
-- Si todo sale ✅ ya puedes crearle un fondo al gerente y a administración, y
-- registrar sus comprobantes desde /caja-chica sin la app del conductor.
-- ══════════════════════════════════════════════════════════════════════════════

select 'El fondo acepta personal administrativo' as revisar,
       case when exists (
         select 1 from pg_constraint
          where conname = 'caja_chica_fondos_responsable_tipo_check'
            and pg_get_constraintdef(oid) like '%personal_administrativo%'
       ) then '✅ correcto'
       else '❌ FALTA — vuelve a correr finanzas-08' end as estado

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

-- Este es el que arreglaba la fragilidad de la fase 06 en bases sin finanzas-03.
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

order by 1;

-- ── Fotografía de tus fondos, ya con el área derivada ──────────────────────────
select responsable_tipo,
       coalesce(area, 'Sin asignar') as area,
       count(*)                      as fondos,
       sum(saldo_en_calle)           as en_la_calle
  from public.v_caja_chica_saldos
 group by 1, 2
 order by 1, 2;

-- ── El total de egresos NO debe haber cambiado con esta migración ─────────────
-- Compáralo con lo que te daba antes: la fase 08 no toca ningún monto.
select fuente, count(*) as filas, sum(monto) as total
  from public.v_egresos
 group by 1
 order by 3 desc;
