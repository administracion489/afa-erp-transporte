-- supabase/documentos-tive-y-nombres.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1) La Tarjeta de Propiedad (TIVE) NO TIENE FECHA DE VENCIMIENTO.
-- 2) Dos documentos se llamaban por el trámite y no por el papel.
--
-- ACCESORIA: el ERP funciona sin correrla. `etiquetaTipoDoc()` (lib/documentos-estado.ts)
-- resuelve los nombres viejos por alias en TODA lectura, y `docSinVencimiento()` ignora la
-- fecha de una TIVE la tenga o no. Esto solo deja la base contando lo mismo que la pantalla
-- —para el día que alguien consulte `documentos_*` con SQL a mano, que es cuando el alias no
-- está ahí para salvarlo.
--
-- Idempotente: se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · LA TIVE NO CADUCA ──────────────────────────────────────────────────────
-- Toda fecha guardada en una Tarjeta de Propiedad es un dato inventado: el documento que
-- emite SUNARP no trae ninguna. Vaciarlas no pierde información —no había ninguna que
-- perder— y evita que una consulta directa vuelva a reportar "vencidas" unidades en regla.
--
-- Se limpia por `fn_norm_tipo_doc` y no por igualdad de texto: en la base conviven
-- "Tarjeta de Propiedad", "tarjeta de propiedad" y la variante sin tildes.

create or replace function public.fn_norm_tipo_doc(t text)
returns text
language sql
immutable
as $$
  -- Espejo de normalizarTipoDoc() en lib/documentos-estado.ts: sin tildes, en minúsculas,
  -- sin puntuación, con los espacios colapsados. Si una de las dos cambia, la otra tiene que
  -- cambiar igual — la misma trampa que ya documenta fn_norm_ruta.
  --
  -- `translate` y NO `unaccent(...)`: la extensión puede no estar instalada en el proyecto
  -- Supabase donde se corra esto, y una migración que revienta a mitad deja la mitad de las
  -- filas renombradas y la otra mitad no. Las vocales acentuadas del castellano son diez;
  -- enumerarlas es más aburrido y no depende de nada.
  select nullif(
    btrim(regexp_replace(
      translate(lower(coalesce(t, '')), 'áéíóúüñ', 'aeiouun'),
      '[^a-z0-9]+', ' ', 'g')),
    ''
  );
$$;

update public.documentos_vehiculo
   set fecha_vencimiento = null
 where fecha_vencimiento is not null
   and public.fn_norm_tipo_doc(tipo) in ('tarjeta de propiedad', 'tarjeta propiedad', 'tive',
                                         'tarjeta de identificacion vehicular',
                                         'tarjeta identificacion vehicular');

update public.documentos_tercero
   set fecha_vencimiento = null
 where fecha_vencimiento is not null
   and public.fn_norm_tipo_doc(tipo) in ('tarjeta de propiedad', 'tarjeta propiedad', 'tive',
                                         'tarjeta de identificacion vehicular',
                                         'tarjeta identificacion vehicular');

-- ── 2 · LOS NOMBRES ────────────────────────────────────────────────────────────
-- "Habilitación SUTRAN" → Tarjeta Única de Circulación (TUC): la habilitación no es un
-- papel, es el estado en el registro; el papel que se lleva en la unidad es la TUC.
-- "Permiso Operación MTC" → Habilitación Vehicular (MTC/ATU): el permiso/autorización es de
-- la EMPRESA; lo que cuelga de un vehículo es su habilitación dentro de esa autorización.
-- (En Lima y Callao la otorga la ATU, de ahí el doble rótulo.)

update public.documentos_vehiculo
   set tipo = 'Tarjeta Única de Circulación (TUC)'
 where public.fn_norm_tipo_doc(tipo) in ('habilitacion sutran', 'sutran');

update public.documentos_tercero
   set tipo = 'Tarjeta Única de Circulación (TUC)'
 where public.fn_norm_tipo_doc(tipo) in ('habilitacion sutran', 'sutran');

update public.documentos_vehiculo
   set tipo = 'Habilitación Vehicular (MTC/ATU)'
 where public.fn_norm_tipo_doc(tipo) in ('permiso operacion mtc', 'permiso de operacion mtc', 'permiso mtc');

update public.documentos_tercero
   set tipo = 'Habilitación Vehicular (MTC/ATU)'
 where public.fn_norm_tipo_doc(tipo) in ('permiso operacion mtc', 'permiso de operacion mtc', 'permiso mtc');

-- Las revisiones que el proveedor subió y nadie aprobó todavía viajan con su propio `tipo`,
-- y al aprobarlas se copia a `documentos_tercero`: sin esto entraría el nombre viejo otra vez.
--
-- VA DENTRO DE UN GUARD, y esto costó un error en producción: `documentos_tercero_revisiones`
-- la crea `proveedor-documentos-autoservicio.sql`, que es OTRO módulo y puede no estar
-- instalado. Sin el guard el update revienta con 42P01 y —como el editor SQL de Supabase
-- envuelve el script en una transacción— tumba TAMBIÉN los renombres de arriba, que sí eran
-- aplicables. Una migración no puede exigir un módulo que no le pertenece.
do $$
begin
  if to_regclass('public.documentos_tercero_revisiones') is null then
    raise notice 'documentos_tercero_revisiones no existe (falta proveedor-documentos-autoservicio.sql): se omite ese bloque; el resto se aplicó igual.';
    return;
  end if;

  update public.documentos_tercero_revisiones
     set tipo = 'Tarjeta Única de Circulación (TUC)'
   where public.fn_norm_tipo_doc(tipo) in ('habilitacion sutran', 'sutran');

  update public.documentos_tercero_revisiones
     set tipo = 'Habilitación Vehicular (MTC/ATU)'
   where public.fn_norm_tipo_doc(tipo) in ('permiso operacion mtc', 'permiso de operacion mtc', 'permiso mtc');

  update public.documentos_tercero_revisiones
     set fecha_vencimiento_propuesta = null
   where fecha_vencimiento_propuesta is not null
     and public.fn_norm_tipo_doc(tipo) in ('tarjeta de propiedad', 'tarjeta propiedad', 'tive',
                                           'tarjeta de identificacion vehicular',
                                           'tarjeta identificacion vehicular');
end $$;

-- ── 3 · LO QUE NO SE TOCA, Y POR QUÉ ───────────────────────────────────────────
-- `empresas_tercerizadas.venc_autorizacion` se queda como está: es LA autorización de la
-- EMPRESA (la firme el MTC, la ATU, un Gobierno Regional o una Municipalidad Provincial), no
-- de una unidad. La TUC y la Habilitación Vehicular renombradas arriba cuelgan de un
-- vehículo: son cosas distintas con nombres parecidos, y unirlas sería perder el control de
-- la empresa para ganar una etiqueta.
--
-- `habilitacion_sutran` / `venc_habilitacion` tampoco: quedaron huérfanas por decisión del
-- dueño (el ERP ya no las lee) y su historia está en tercerizadas-autorizacion-ambito.sql.

-- ── VERIFICACIÓN ───────────────────────────────────────────────────────────────
-- select tipo, count(*) filter (where fecha_vencimiento is not null) as con_fecha, count(*)
--   from public.documentos_tercero group by tipo order by 3 desc;
-- La Tarjeta de Propiedad debe salir con con_fecha = 0, y no debe quedar ninguna fila
-- llamada "Habilitación SUTRAN" ni "Permiso Operación MTC".
