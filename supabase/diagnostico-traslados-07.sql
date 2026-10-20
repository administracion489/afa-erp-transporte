-- ══ diagnostico-traslados-07.sql · SOLO LEE · a cualquier hora (segundos) ══════════════════════════════
-- ¿Es seguro el bucket traslados-fotos y quedó bien traslados-07-fotos-categoria.sql?
-- SQL Editor: pega el archivo ENTERO y Run: sale UNA tabla (el editor enseña solo la última sentencia).
-- Termina con «-- FIN»; «syntax error at end of input» = se cortó al copiar.
-- Se puede correr ANTES de la migración: no nombra las columnas nuevas (las busca en information_schema),
-- así que las filas de la parte C dicen «FALTA» en vez de romper. No escribe nada, ni temporal.
--   A · Políticas de storage.objects que NO se acotan por bucket_id. Una política así vale para TODOS los
--       buckets, también para traslados-fotos, que existe precisamente para que ninguna sesión escriba.
--   B · Las fotos de vehiculos-fotos (de donde la pantalla sugiere): tipo y tamaño (topes: JPEG, 600 KB).
--   C · Estado tras la migración: columnas, CHECKs y configuración del bucket.
with
pol as (
  select policyname, cmd, roles::text as roles, permissive,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
    from pg_policies where schemaname = 'storage' and tablename = 'objects'),
pol_mal as (
  select policyname, cmd, roles, permissive,
         case when expr !~* 'bucket_id' then 'GLOBAL (abre el bucket nuevo)'
              when expr ~* 'traslados-fotos' then 'NOMBRA traslados-fotos (no debe haber ninguna)'
              when expr ~* '(<>|!=|\mnot\M|\mlike\M|~)' then 'REVISAR: acota con negación o patrón'
         end as problema, expr
    from pol),
vf as (
  select coalesce(metadata->>'mimetype', '(sin tipo)') as mime, (metadata->>'size')::bigint as bytes
    from storage.objects where bucket_id = 'vehiculos-fotos'),
cols(t, c) as (values ('traslado_categorias', 'foto_externa_url'), ('traslado_categorias', 'foto_interna_url'),
                      ('traslado_categorias', 'descripcion_cliente'), ('traslados_config', 'incluye'),
                      ('traslados_config', 'no_incluye')),
cks(n) as (values ('traslado_categorias_foto_externa_ck'), ('traslado_categorias_foto_interna_ck'),
                  ('traslado_categorias_descripcion_ck')),
filas(orden, pregunta, resultado, como) as (
  select 10, 'A · política de storage.objects', policyname || ' · ' || cmd || ' · ' || roles || ' · ' || problema
         || ' · ' || left(expr, 160), 'Cada fila es un problema. GLOBAL → borrarla o acotarla con bucket_id = ''…'' antes de usar el bucket.'
    from pol_mal where problema is not null
  union all
  select 11, 'A · políticas de storage.objects', count(*) || ' en total · ' || count(*) filter (where problema is not null)
         || ' con problema', 'Con 0 problemas, ninguna sesión puede escribir en traslados-fotos (solo la service-role).'
    from pol_mal
  union all
  select 12, 'A · políticas de storage.buckets', count(*)::text,
         'Debe ser 0: con políticas, una sesión podría cambiar public, mime o el tope del bucket.'
    from pg_policies where schemaname = 'storage' and tablename = 'buckets'
  union all
  select 20, 'B · vehiculos-fotos por tipo', mime || ': ' || count(*) || ' objetos · máx ' || max(bytes) || ' B · mediana '
         || round(percentile_cont(0.5) within group (order by bytes))::bigint || ' B · ' || count(*) filter (where bytes > 614400)
         || ' > 600 KB', 'Lo que no sea image/jpeg o pase de 600 KB no se sube tal cual: el navegador lo achica a JPEG.'
    from vf group by mime
  union all
  select 21, 'B · vehiculos-fotos total', count(*) || ' objetos', 'Solo es una SUGERENCIA de foto: «Usar esta» la sube de nuevo a traslados-fotos.'
    from vf
  union all
  select 30, 'C · columna ' || cols.t || '.' || cols.c,
         coalesce(ic.data_type || ' · default ' || coalesce(ic.column_default, '—') || ' · null ' || ic.is_nullable, 'FALTA'),
         'FALTA = corre traslados-07-fotos-categoria.sql. incluye/no_incluye: ARRAY, default ''{}'', null NO.'
    from cols left join information_schema.columns ic
      on ic.table_schema = 'public' and ic.table_name = cols.t and ic.column_name = cols.c
  union all
  select 31, 'C · CHECK ' || cks.n, coalesce(pg_get_constraintdef(pc.oid), 'FALTA'),
         'URL con la forma de rutaFoto: https://<host>/…/traslados-fotos/categorias/<CLAVE>/<lado>-<uuid>.jpg; descripción ≤ 300.'
    from cks left join pg_constraint pc
      on pc.conname = cks.n and pc.conrelid = to_regclass('public.traslado_categorias')
  union all
  select 32, 'C · bucket traslados-fotos', coalesce((select 'public ' || public || ' · mime ' || coalesce(allowed_mime_types::text, '—')
         || ' · máx ' || coalesce(file_size_limit::text, '—') from storage.buckets where id = 'traslados-fotos'), 'FALTA'),
         'Debe: public true · {image/jpeg} · 614400. Distinto = vuelve a correr la migración (lo reafirma).'
  union all
  select 33, 'C · objetos en traslados-fotos', count(*) || ' · ' || coalesce(sum((metadata->>'size')::bigint), 0) || ' B',
         'Cada foto se sube con un nombre nuevo (uuid): nunca se sobrescribe una ya enviada.'
    from storage.objects where bucket_id = 'traslados-fotos')
select pregunta, resultado, como as "cómo se lee" from filas order by orden, resultado;
-- FIN de diagnostico-traslados-07.sql
