-- licitaciones-03-bucket.sql — Bucket PRIVADO `licitaciones`: bases y anexos subidos, imágenes de la propuesta,
-- firmas, sustentos de experiencia y las COPIAS EMITIDAS (la constancia de lo presentado).
-- NO LA CORRE EL DEPLOY: Supabase → SQL Editor → pegar ENTERA → Run. Idempotente.
-- ORDEN: 01a → 01b → 02-experiencia → 03 (esta) → 04-columnas-accesorias. Requiere 01b (fn_puede_modulo).
-- SIN ESTA: no se puede subir ningún archivo a una licitación (la pantalla lo dice nombrando este archivo) y la
-- emisión se descarga igual, pero sin subir copias: queda registrada con «no se subió» en cada archivo.
-- LEER (firmar un enlace) y SUBIR: solo con el módulo «licitaciones» (o admin). SIN UPDATE NI DELETE, a propósito:
-- nadie sobrescribe ni borra lo subido (se sube siempre con un nombre NUEVO y upsert false); el bucket `documentos`
-- deja sobrescribir a cualquier sesión y por eso las copias emitidas no viven ahí. Solo se sube a una ruta con la
-- forma EXACTA que arma lib/licitaciones/archivos.ts:
--   rutaNueva:   <bases|adjuntos|imagenes|firmas>/<licId>/<uuid>.<ext>  ·  experiencia/<uuid>.<ext>
--   rutaEmision: emisiones/<licId>/<uuid de la emisión>/<nombre ASCII sin ..>
-- (las carpetas son CARPETAS_LICITACION de lib/licitaciones/tipos.ts). Solo PDF, PNG, JPEG, ZIP, DOCX, XLSX y XLS,
-- hasta 50 MB por archivo: el navegador manda SIEMPRE el contentType de MimeArchivo (Windows etiqueta un .zip como
-- application/x-zip-compressed y Storage lo rechazaría). Una copia emitida de más de 50 MB no se sube y se dice.

-- 0) Requisitos. Y se DETIENE (sin cambiar nada) si storage.objects tiene una política que no se acota por bucket_id
--    (valdría para todos los buckets y abriría también este: aquí cuenta también LEER, porque es privado), o si ya
--    hay otra política que nombra este bucket (una creada a mano desde el panel se sumaría a las de aquí con OR).
do $$ declare g text; o text; begin
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null then
    raise exception 'Antes de licitaciones-03 hay que correr: licitaciones-01b-rls.sql';
  end if;
  g := (select string_agg(policyname || ' (' || cmd || ')', ', ') from pg_policies
         where schemaname = 'storage' and tablename = 'objects' and cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')
           and not (roles <@ array['service_role']::name[])
           and coalesce(qual, '') || ' ' || coalesce(with_check, '') !~* 'bucket_id');
  if g is not null then
    raise exception 'storage.objects tiene políticas sin bucket_id: %. Acótalas con bucket_id = ''…'' y vuelve a correr.', g;
  end if;
  o := (select string_agg(policyname || ' (' || cmd || ')', ', ') from pg_policies
         where schemaname = 'storage' and tablename = 'objects' and policyname not in ('lic_leer', 'lic_subir')
           and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '''licitaciones''');
  if o is not null then
    raise exception 'storage.objects ya tiene otras políticas sobre el bucket licitaciones: %. Bórralas y vuelve a correr.', o;
  end if;
end $$;

-- 1) El bucket. PRIVADO: el archivo solo sale por un enlace firmado (lib/storage-firmado.ts). El `do update`
--    reafirma la configuración si alguien la cambió a mano.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('licitaciones', 'licitaciones', false, 52428800, array['application/pdf', 'image/png', 'image/jpeg', 'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- 2) Leer y subir, con el módulo. NINGUNA política de UPDATE ni DELETE: sin ellas, nadie (salvo el servidor con la
--    service-role) puede sobrescribir, mover ni borrar. (select …): una evaluación por consulta, no por fila.
drop policy if exists lic_leer on storage.objects;
create policy lic_leer on storage.objects for select to authenticated
  using (bucket_id = 'licitaciones' and (select public.fn_puede_modulo((select auth.uid()), 'licitaciones')));
drop policy if exists lic_subir on storage.objects;
create policy lic_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'licitaciones' and (select public.fn_puede_modulo((select auth.uid()), 'licitaciones'))
    and (storage.foldername(name))[1] in ('bases', 'adjuntos', 'imagenes', 'firmas', 'experiencia', 'emisiones')
    and (name ~ '^((bases|adjuntos|imagenes|firmas)/[1-9][0-9]{0,17}|experiencia)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](pdf|png|jpg|zip|docx|xlsx|xls)$'
      or (name ~ '^emisiones/[1-9][0-9]{0,17}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
          and name !~ '[.][.]')));

-- Verificación (solo lee): el bucket privado con su límite y sus 7 tipos, lic_leer (SELECT) y lic_subir (INSERT), y
-- NINGUNA otra política que lo nombre o que no se acote por bucket_id.
select 'bucket' as que, id as nombre, 'public ' || public || ' · máx ' || coalesce(file_size_limit::text, '—') || ' bytes · '
       || coalesce(array_length(allowed_mime_types, 1), 0) || ' tipos (debe: false · 52428800 · 7)' as detalle
  from storage.buckets where id = 'licitaciones'
union all
select case when policyname in ('lic_leer', 'lic_subir') then 'política del módulo' else 'política que lo abre (debe salir NINGUNA)' end,
       policyname, cmd || ' · ' || roles::text
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
   and (coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '''licitaciones'''
        or coalesce(qual, '') || ' ' || coalesce(with_check, '') !~* 'bucket_id')
order by 1, 2;
-- FIN de licitaciones-03-bucket.sql
