-- ══════════════════════════════════════════════════════════════════════════════
-- Verificación de las fases 06 y 07 — pégalo entero en el SQL Editor y dale Run.
-- Cada fila dice si esa pieza quedó bien. Si TODO sale ✅, ya puedes usar
-- /caja-chica y /tesoreria con datos reales.
-- ══════════════════════════════════════════════════════════════════════════════

select 'Tabla: ' || t as revisar,
       case when exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = t
       ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-06' end as estado
  from unnest(array[
    'caja_chica_fondos','caja_chica_rendiciones','caja_chica_gastos',
    'gastos_generales','lotes_pago','lotes_pago_items',
    'extractos_bancarios','extractos_bancarios_movimientos','importaciones_finanzas'
  ]) as t

union all

select 'Vista: ' || v,
       case when exists (
         select 1 from information_schema.views
          where table_schema = 'public' and table_name = v
       ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-06' end
  from unnest(array[
    'v_cuentas_por_pagar','v_caja_chica_rendiciones','v_caja_chica_saldos',
    'v_detracciones_pendientes','v_fugas_bancarias','v_costo_servicio','v_egresos'
  ]) as v

union all

select 'Regla de bloqueo (fn_caja_chica_puede_asignar)',
       case when exists (
         select 1 from pg_proc where proname = 'fn_caja_chica_puede_asignar'
       ) then '✅ existe' else '❌ FALTA — vuelve a correr finanzas-06' end

union all

select 'Bucket de Storage "comprobantes" (privado)',
       case
         when exists (select 1 from storage.buckets where id = 'comprobantes' and public = false)
           then '✅ existe y es privado'
         when exists (select 1 from storage.buckets where id = 'comprobantes')
           then '⚠️ existe pero quedó PÚBLICO — cámbialo a privado en Storage'
         else '❌ FALTA — créalo a mano: Storage → New bucket → "comprobantes" → Public OFF'
       end

union all

select 'Detracción 026 = transporte de personas, 10%',
       case when exists (select 1 from public.cat_detraccion where codigo = '026' and porcentaje = 10)
            then '✅ correcto' else '❌ revisar cat_detraccion' end

union all

select 'Detracción 027 = transporte de carga, 4%',
       case when exists (select 1 from public.cat_detraccion where codigo = '027' and porcentaje = 4)
            then '✅ correcto' else '❌ revisar cat_detraccion' end

union all

select 'Código de detracción por defecto = 026',
       case when exists (select 1 from public.config_tributaria where id = 1 and detraccion_codigo_defecto = '026')
            then '✅ correcto' else '⚠️ revisar config_tributaria' end

union all

select 'Catálogo completo cargado (debería haber ~29 códigos)',
       (select count(*)::text || ' códigos' from public.cat_detraccion)

order by 1;

-- ── Si todo salió ✅, esta consulta te confirma que /gastos sigue cuadrando ──
-- select fuente, count(*) as filas, sum(monto) as total
--   from public.v_egresos group by 1 order by 3 desc;
