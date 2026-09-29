-- ═══════════════════════════════════════════════════════════════════════════
-- seguridad-02-buckets-privados.sql · `documentos`, `pasajeros-fotos` y `radar-media`
-- pasan a PRIVADOS. (NO la corre el deploy: se ejecuta a mano en Supabase → SQL Editor.)
--
-- ⚠ CÓRRELA SOLO DESPUÉS de que el despliegue que trae lib/storage-firmado.ts esté en
--   transportesafa.com. Ese código FIRMA el enlace de cada archivo al pintarlo; con el código
--   viejo, cerrar el bucket deja rotas las fotos y los documentos de todas las pantallas.
--
-- POR QUÉ: un bucket público entrega el archivo a cualquiera que tenga su enlace, sin login.
-- Estos tres guardan SOAT, licencias y documentos de proveedores (`documentos`), la cara de
-- los pasajeros (`pasajeros-fotos`) y los vouchers, tableros y audios de los grupos de
-- WhatsApp (`radar-media`).
--
-- LO QUE NO CAMBIA: la base. Sigue guardando el enlace público de cada archivo, que pasa a
-- ser solo su identificador (lib/storage-privado.ts). No hay que migrar filas ni actualizar el
-- worker del Radar en DigitalOcean: sube con la service-role, que no mira políticas.
--
-- QUÉ HACE, idempotente (se puede correr dos veces):
--   1. Crea las políticas de LECTURA para `authenticated` (los usuarios del ERP): firmar un
--      enlace exige poder leer el objeto. Y de ESCRITURA en `documentos`, que el ERP sube
--      desde el navegador (/documentos y los planes de mantenimiento).
--   2. Cierra a `anon` toda política que hoy lo deje leer, subir o borrar en estos tres
--      buckets sin mirar la sesión (p. ej. un "Public Access" creado desde el panel). Con el
--      bucket privado pero una política así, la anon key —que va en el JavaScript— seguiría
--      pudiendo bajar y listar los archivos. La foto del pasajero la sube ahora el servidor
--      (/api/pasajero → subir_foto), así que la subida anónima ya no hace falta.
--   3. Marca los tres buckets como privados.
--
-- DESPUÉS: abre /radar-ia, /documentos, /tercerizadas y /pasajeros y comprueba que las fotos
-- y los documentos se ven. Si algo no abre, se revierte al instante con:
--   update storage.buckets set public = true where id in ('documentos','pasajeros-fotos','radar-media');
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Acceso para los usuarios del ERP ──────────────────────────────────────
do $$
begin
  drop policy if exists "privados_erp_leer" on storage.objects;
  create policy "privados_erp_leer" on storage.objects
    for select to authenticated
    using (bucket_id in ('documentos', 'pasajeros-fotos', 'radar-media'));

  drop policy if exists "documentos_erp_subir" on storage.objects;
  create policy "documentos_erp_subir" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'documentos');

  -- `upsert: true` (planes de mantenimiento) necesita además poder actualizar.
  drop policy if exists "documentos_erp_actualizar" on storage.objects;
  create policy "documentos_erp_actualizar" on storage.objects
    for update to authenticated
    using (bucket_id = 'documentos')
    with check (bucket_id = 'documentos');
end $$;

-- ── 2. Nada para anon en estos tres buckets ──────────────────────────────────
do $$
declare p record;
begin
  for p in
    select policyname
      from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and ('anon' = any(roles) or 'public' = any(roles))
       -- Con las comillas: 'documentos-clientes' es OTRO bucket y no debe caer aquí.
       and coalesce(qual, '') || ' ' || coalesce(with_check, '')
           ~ '''(documentos|pasajeros-fotos|radar-media)'''
       and coalesce(qual, '') || ' ' || coalesce(with_check, '')
           !~* '(auth\.uid|auth\.role|auth\.jwt|authenticated)'
  loop
    execute format('alter policy %I on storage.objects to authenticated', p.policyname);
    raise notice 'Política de Storage cerrada a anon: %', p.policyname;
  end loop;
end $$;

-- ── 3. Buckets privados ──────────────────────────────────────────────────────
update storage.buckets
   set public = false
 where id in ('documentos', 'pasajeros-fotos', 'radar-media');

-- Comprobación: los tres deben salir con public = false.
select id, public from storage.buckets
 where id in ('documentos', 'pasajeros-fotos', 'radar-media')
 order by id;
