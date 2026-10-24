-- diagnostico-licitaciones.sql · SOLO LEE. Supabase → SQL Editor → pegar ENTERO → Run. Devuelve UNA tabla
-- (orden · que · detalle). Para correr ANTES de licitaciones-01a y DESPUÉS de cada migración del módulo.
--  1 documentos_empresa (el legajo vive ahí): columnas, CHECK/FK, RLS y políticas, filas.
--  2 columnas de las fichas que lee el módulo (sin anio en vehiculos_tercero = falta licitaciones-04).
--  3 fn_puede_modulo · 4 buckets · 5 políticas de storage.objects SIN bucket_id (abrirían todos).
--  6 ¿qué se puede UNIR al expediente? archivo_url por origen: vacío · drive.google (CORS: no se baja
--    desde el navegador) · supabase /<bucket>/ · otro. Por tipo TAL COMO ESTÁ ESCRITO (el canónico lo deriva
--    tipoCanonico en TS) y fotos de las dos flotas. 7 las placas de la propuesta de referencia (cámbialas por las de
--    tu caso en las tres listas). 8 el módulo: tablas, bucket y usuarios con el permiso.
-- Las columnas que una migración agrega se leen con to_jsonb(fila)->>'col': antes de 04 no fallan, dicen «—».
with u as (
  select 'documentos_vehiculo'::text f, 'p'::text fl, dv.vehiculo_id vid, coalesce(nullif(btrim(dv.tipo), ''), '(sin tipo)') tipo, dv.archivo_url url from public.documentos_vehiculo dv
  union all select 'documentos_tercero', 't', dt.vehiculo_id, coalesce(nullif(btrim(dt.tipo), ''), '(sin tipo)')
                   || case when dt.vehiculo_id is null then ' [de la empresa]' else '' end, dt.archivo_url from public.documentos_tercero dt
  union all select 'fotos vehiculos', 'p', v.id, 'foto_externa', v.foto_externa_url from public.vehiculos v
  union all select 'fotos vehiculos', 'p', v.id, 'foto_interna', v.foto_interna_url from public.vehiculos v
  union all select 'fotos vehiculos_tercero', 't', t.id, 'foto_externa', t.foto_externa_url from public.vehiculos_tercero t
  union all select 'fotos vehiculos_tercero', 't', t.id, 'foto_interna', t.foto_interna_url from public.vehiculos_tercero t
), c as (
  select u.*, case when coalesce(btrim(url), '') = '' then 'vacío'
    when url ~* '(drive|docs)[.]google[.]' then 'drive.google'
    when url ~ '/storage/v1/object/' then 'supabase /' || coalesce(substring(url from '/storage/v1/object/[a-z]+/([^/?]+)/'), '?') || '/'
    else 'otro' end origen from u
), casos as (
  select 'p'::text fl, v.id, v.placa, v.anio::text anio, v.capacidad_pasajeros cap, v.estado, null::text empresa
    from public.vehiculos v where upper(regexp_replace(v.placa, '[^A-Za-z0-9]', '', 'g')) in ('BVI124', 'VFC962', 'BUG508', 'BYE133')
  union all
  select 't', t.id, t.placa, to_jsonb(t) ->> 'anio', t.capacidad, t.estado, e.razon_social
    from public.vehiculos_tercero t left join public.empresas_tercerizadas e on e.id = t.empresa_id
   where upper(regexp_replace(t.placa, '[^A-Za-z0-9]', '', 'g')) in ('BVI124', 'VFC962', 'BUG508', 'BYE133')
)
select 1 orden, 'documentos_empresa · columnas' que, string_agg(column_name || ':' || data_type, ', ' order by ordinal_position) detalle
  from information_schema.columns where table_schema = 'public' and table_name = 'documentos_empresa'
union all select 1, 'documentos_empresa · ' || case contype when 'c' then 'CHECK ' when 'f' then 'FK ' else contype::text || ' ' end || conname,
       pg_get_constraintdef(oid) from pg_constraint where conrelid = to_regclass('public.documentos_empresa')
union all select 1, 'documentos_empresa · RLS', 'rls ' || relrowsecurity || ' · políticas ' || (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'documentos_empresa') from pg_class where oid = to_regclass('public.documentos_empresa')
union all select 1, 'documentos_empresa · política ' || policyname, cmd || ' · ' || roles::text || ' · using ' || coalesce(qual, '—')
       || ' · check ' || coalesce(with_check, '—') from pg_policies where schemaname = 'public' and tablename = 'documentos_empresa'
union all select 1, 'documentos_empresa · filas por alcance', coalesce(string_agg(a || ' ' || n, ' · '), '0 filas')
  from (select coalesce(alcance, '(null)') a, count(*) n from public.documentos_empresa group by 1) x
union all select 2, table_name || ' · columnas', string_agg(column_name || ':' || data_type, ', ' order by ordinal_position)
  from information_schema.columns where table_schema = 'public'
   and table_name in ('documentos_vehiculo', 'documentos_tercero', 'vehiculos_tercero', 'empresa_perfil') group by table_name
union all select 2, 'columna ' || x, case when exists (select 1 from information_schema.columns where table_schema = 'public'
       and table_name || '.' || column_name = x) then 'EXISTE' else 'no existe (la agrega licitaciones-04)' end
  from unnest(array['vehiculos_tercero.anio', 'empresa_perfil.fecha_constitucion', 'documentos_empresa.conductor_tercero_id']) x
union all select 3, 'fn_puede_modulo', coalesce((select 'existe · security definer ' || p.prosecdef || ' · anon ejecuta '
       || has_function_privilege('anon', p.oid, 'execute') || ' · authenticated ejecuta ' || has_function_privilege('authenticated', p.oid, 'execute')
  from pg_proc p where p.oid = to_regprocedure('public.fn_puede_modulo(uuid,text)')), 'NO EXISTE (la crea licitaciones-01b)')
union all select 4, 'bucket ' || id, 'public ' || public || ' · máx ' || coalesce(file_size_limit::text, '—') || ' bytes · mime '
       || coalesce(allowed_mime_types::text, '—') from storage.buckets
union all select 5, 'storage sin bucket_id · ' || policyname, cmd || ' · ' || roles::text || ' · ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
   and coalesce(qual, '') || ' ' || coalesce(with_check, '') !~* 'bucket_id'
union all select 5, 'storage sin bucket_id · total', count(*)::text || ' (debe ser 0)' from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and coalesce(qual, '') || ' ' || coalesce(with_check, '') !~* 'bucket_id'
union all select 6, f || ' · ' || tipo, string_agg(origen || ' ' || n, ' · ' order by n desc)
  from (select f, tipo, origen, count(*) n from c group by 1, 2, 3) x group by f, tipo
union all select 7, 'placa ' || cs.placa || ' (' || case cs.fl when 'p' then 'vehiculos' else 'vehiculos_tercero' end || ' #' || cs.id || ')',
       coalesce('empresa ' || cs.empresa || ' · ', '') || 'año ' || coalesce(cs.anio, '—') || ' · asientos ' || coalesce(cs.cap::text, '—')
       || ' · estado ' || coalesce(cs.estado, '—') || ' · ' || coalesce((select string_agg(c.tipo || ': ' || c.origen, ' · ' order by c.f, c.tipo)
         from c where c.fl = cs.fl and c.vid = cs.id), 'sin documentos ni fotos')
  from casos cs
union all select 7, 'placa ' || x || ' · no existe en ninguna flota', '—'
  from unnest(array['BVI124', 'VFC962', 'BUG508', 'BYE133']) x
 where not exists (select 1 from casos where upper(regexp_replace(casos.placa, '[^A-Za-z0-9]', '', 'g')) = x)
union all select 8, 'módulo · ' || x, coalesce(to_regclass('public.' || x)::text || ' existe', 'no existe')
  from unnest(array['licitaciones', 'licitacion_analisis', 'licitacion_emisiones', 'experiencia_empresa']) x
union all select 8, 'módulo · bucket licitaciones', coalesce((select 'existe · public ' || public from storage.buckets
       where id = 'licitaciones'), 'no existe (lo crea licitaciones-03)')
union all select 8, 'módulo · usuarios con permiso licitaciones', count(*)::text from public.permisos_usuario
 where modulo = 'licitaciones' and permitido = true
order by 1, 2;
-- FIN de diagnostico-licitaciones.sql
