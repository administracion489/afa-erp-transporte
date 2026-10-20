-- traslados-07-fotos-categoria.sql — Fotos y descripción de la CATEGORÍA para el PDF corporativo del traslado,
-- y las listas Incluye / No incluye de la cotización.
-- NO la corre el deploy: hay que ejecutarla en Supabase (SQL Editor → pegar ENTERA → Run). Idempotente.
-- Requiere traslados-01. Si falta, se detiene nombrándola y NO cambia nada. NO siembra nada: las fotos las
-- elige una persona en /tarifario → Zonas y traslados → Vehículos, y las listas nacen vacías (lista vacía
-- no se imprime). Correrla no cambia ningún PDF hasta que alguien suba una foto o escriba una lista.
-- SIN ESTA MIGRACIÓN el PDF sale sin fotos ni listas (solo la descripción por defecto con capacidad y
-- bodega) y la pantalla lo dice en ámbar nombrando este archivo.
-- Bloqueo: las columnas no tienen default o lo tienen constante (PG11+: no reescriben la tabla). Los CHECK
-- revalidan traslado_categorias, que son unas pocas filas.

-- 0) Requisitos. Y se DETIENE (sin cambiar nada) si storage.objects tiene una política de escritura que
--    no se acota por bucket_id: valdría para todos los buckets y abriría también traslados-fotos (ver 3).
do $$ declare g text; begin
  if to_regclass('public.traslado_categorias') is null or to_regclass('public.traslados_config') is null then
    raise exception 'Antes de traslados-07 hay que correr: traslados-01-tablas.sql';
  end if;
  g := (select string_agg(policyname || ' (' || cmd || ')', ', ') from pg_policies
         where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
           and not (roles <@ array['service_role']::name[])
           and coalesce(qual, '') || ' ' || coalesce(with_check, '') !~* 'bucket_id');
  if g is not null then
    raise exception 'storage.objects tiene políticas de escritura sin bucket_id: %. Acótalas con bucket_id = ''…'' y vuelve a correr.', g;
  end if;
end $$;

-- 1) La categoría: foto exterior, foto interior y la descripción que lee el cliente (≤ 300 caracteres).
--    La URL tiene la forma EXACTA que escribe el servidor (rutaFoto, lib/traslados/fotos-categoria.ts):
--    https://<host>/storage/v1/object/public/traslados-fotos/categorias/<CLAVE>/<lado>-<uuid>.jpg, y el
--    lado es el de su columna. Sin `..`, comillas, consulta ni usuario. El CHECK no sabe el host del
--    proyecto: lo comprueba el servidor antes de descargar (urlFotoPermitida). La CLAVE no se ata a la de
--    la fila a propósito: renombrar una categoría (on update cascade) no puede chocar con su foto.
alter table public.traslado_categorias
  add column if not exists foto_externa_url    text,
  add column if not exists foto_interna_url    text,
  add column if not exists descripcion_cliente text;
alter table public.traslado_categorias
  drop constraint if exists traslado_categorias_foto_externa_ck,
  drop constraint if exists traslado_categorias_foto_interna_ck,
  drop constraint if exists traslado_categorias_descripcion_ck,
  add constraint traslado_categorias_foto_externa_ck check (foto_externa_url is null or foto_externa_url ~
    '^https://[A-Za-z0-9-]+([.][A-Za-z0-9-]+)*(:[0-9]{1,5})?/storage/v1/object/public/traslados-fotos/categorias/[A-Z0-9_]{1,30}/externa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$'),
  add constraint traslado_categorias_foto_interna_ck check (foto_interna_url is null or foto_interna_url ~
    '^https://[A-Za-z0-9-]+([.][A-Za-z0-9-]+)*(:[0-9]{1,5})?/storage/v1/object/public/traslados-fotos/categorias/[A-Z0-9_]{1,30}/interna-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$'),
  add constraint traslado_categorias_descripcion_ck check (descripcion_cliente is null
    or char_length(descripcion_cliente) <= 300);

comment on column public.traslado_categorias.foto_externa_url is
  'Foto EXTERIOR de la categoría para el PDF (bucket traslados-fotos, la sube el servidor). null = sin foto.';
comment on column public.traslado_categorias.foto_interna_url is
  'Foto INTERIOR de la categoría para el PDF (bucket traslados-fotos, la sube el servidor). null = sin foto.';
comment on column public.traslado_categorias.descripcion_cliente is
  'Texto para el cliente en «Características» (≤ 300). null = la frase por defecto con capacidad y bodega.';

-- 2) Las listas Incluye / No incluye que la cotización copia a consideraciones_json. Nacen vacías.
alter table public.traslados_config
  add column if not exists incluye    text[] not null default '{}',
  add column if not exists no_incluye text[] not null default '{}';
insert into public.traslados_config (id) values (1) on conflict (id) do nothing;
comment on column public.traslados_config.incluye is
  'Lo que INCLUYE un traslado cotizado (una frase por elemento). Vacía = el PDF no imprime la lista.';
comment on column public.traslados_config.no_incluye is
  'Lo que NO incluye un traslado cotizado (una frase por elemento). Vacía = el PDF no imprime la lista.';

-- 3) El bucket traslados-fotos. PÚBLICO para LEER: pdf-lib y la pantalla bajan la foto por la URL pública
--    (`/object/public/…` no consulta las políticas de storage.objects). Solo JPEG y hasta 600 KB: el
--    navegador la achica a ≤ 1280 px y el servidor la sube con contentType image/jpeg (sin él, rechaza).
--    SIN NINGUNA POLÍTICA en storage.objects, a propósito: con RLS activo y sin políticas, ninguna sesión
--    (anon ni authenticated) puede subir, sobrescribir, borrar ni listar. Solo escribe el servidor con la
--    service-role (POST/DELETE /api/traslados/categorias/foto), que verifica el módulo «tarifas» y la firma
--    del JPEG. Estas fotos las manda la IA a clientes sin revisión: no se sirven desde vehiculos-fotos, que
--    cualquier sesión del ERP puede sobrescribir. OJO: una política GLOBAL (sin bucket_id) abriría también
--    este bucket: el paso 0 se detiene si ve una, y diagnostico-traslados-07.sql las busca después. El
--    `do update` reafirma la configuración si alguien la cambió a mano.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('traslados-fotos', 'traslados-fotos', true, '{image/jpeg}', 614400)
on conflict (id) do update set public = excluded.public,
                               allowed_mime_types = excluded.allowed_mime_types,
                               file_size_limit = excluded.file_size_limit;

-- Verificación (solo lee): 5 columnas, el bucket y CERO políticas que lo nombren o lo abran.
select 'columna' as que, table_name || '.' || column_name as detalle, data_type || ' · default ' || coalesce(column_default, '—') as estado
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (('traslado_categorias', 'foto_externa_url'), ('traslado_categorias', 'foto_interna_url'),
        ('traslado_categorias', 'descripcion_cliente'), ('traslados_config', 'incluye'), ('traslados_config', 'no_incluye'))
union all
select 'bucket', id, 'public ' || public || ' · mime ' || coalesce(allowed_mime_types::text, '—')
       || ' · máx ' || coalesce(file_size_limit::text, '—') || ' bytes (debe: true · {image/jpeg} · 614400)'
  from storage.buckets where id = 'traslados-fotos'
union all
select 'política que lo abre (debe salir NINGUNA)', policyname, cmd || ' · ' || roles::text
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and (coalesce(qual, '') || coalesce(with_check, '') !~* 'bucket_id'
        or coalesce(qual, '') || coalesce(with_check, '') ~* 'traslados-fotos');
-- FIN de traslados-07-fotos-categoria.sql
