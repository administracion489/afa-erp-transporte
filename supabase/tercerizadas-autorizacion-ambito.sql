-- supabase/tercerizadas-autorizacion-ambito.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- UNA EMPRESA TIENE UNA AUTORIZACIÓN, Y ESA AUTORIZACIÓN TIENE UN TERRITORIO
--
-- La ficha pedía "N° Autorización MTC" y "N° Habilitación SUTRAN" como si todo transportista
-- tuviera las dos. No es así: la autoriza UNA autoridad —MTC (nacional), Gobierno Regional
-- (regional), ATU (Lima y Callao) o Municipalidad Provincial (provincial)— y esa autoridad
-- decide hasta dónde puede circular. SUTRAN, además, no autoriza: fiscaliza.
--
-- Lo que faltaba no era un campo más: era el dato que permite avisar de lo único que de
-- verdad importa al asignar un servicio — que el viaje se sale del ámbito autorizado. Un
-- operador con autorización de la ATU que hace un paseo a Ica está prestando servicio sin
-- autorización, y el cliente contrató a AFA.
--
-- ACCESORIA: la app degrada sin ella (app/tercerizadas/page.tsx reintenta el SELECT sin estas
-- columnas y avisa en pantalla), pero mientras no se corra NO se puede guardar la autoridad
-- ni verificar ningún alcance.
--
-- Idempotente: se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · QUIÉN AUTORIZA ─────────────────────────────────────────────────────────
alter table public.empresas_tercerizadas
  add column if not exists autoridad_habilitante text;

alter table public.empresas_tercerizadas
  drop constraint if exists empresas_ter_autoridad_check;
alter table public.empresas_tercerizadas
  add constraint empresas_ter_autoridad_check
  check (autoridad_habilitante is null
         or autoridad_habilitante in ('mtc', 'atu', 'regional', 'provincial'));

comment on column public.empresas_tercerizadas.autoridad_habilitante is
  'Quién firmó la autorización de transporte de personas: mtc (ámbito nacional) | atu '
  '(Lima Metropolitana y Callao, Ley 30900) | regional (Gobierno Regional) | provincial '
  '(Municipalidad Provincial). EL ÁMBITO NO SE GUARDA: se DERIVA de este campo en '
  'lib/autorizacion-transporte.ts (ambitoDeAutoridad). Guardarlo abriría la puerta a un '
  '"ATU + nacional" que no existe.';

-- ── 2 · DE QUÉ REGIÓN O DE QUÉ PROVINCIA ───────────────────────────────────────
-- Sin esto, "regional" no dice nada: es la diferencia entre "puede ir a Ica" y "no puede
-- salir de Lima". Para MTC y ATU se queda NULL a propósito — el territorio es fijo por ley
-- y ofrecer un campo para escribirlo solo invita a escribirlo mal.
alter table public.empresas_tercerizadas
  add column if not exists autoridad_emisor text;

comment on column public.empresas_tercerizadas.autoridad_emisor is
  'Gobierno Regional (p. ej. "Ica") o Municipalidad Provincial (p. ej. "Cañete") que otorgó '
  'la autorización. NULL para mtc y atu: su territorio es fijo por ley (todo el país / Lima '
  'Metropolitana y Callao) y no depende de ningún dato tecleado.';

-- ── 3 · LO QUE YA ESTABA ESCRITO ───────────────────────────────────────────────
-- `autorizacion_mtc` / `venc_autorizacion` pasan a ser LA autorización, venga de quien
-- venga. No se renombra la columna: media docena de módulos la leen por nombre y un rename
-- es exactamente el "escribir con una identidad y leer con otra" que este repo ya pagó tres
-- veces. Lo que sí se hace es dejar escrito qué significa hoy.
comment on column public.empresas_tercerizadas.autorizacion_mtc is
  'N° de la resolución que autoriza a la empresa, la haya emitido el MTC, la ATU, un '
  'Gobierno Regional o una Municipalidad Provincial. El nombre de la columna es histórico: '
  'quién la emitió está en autoridad_habilitante.';

-- Backfill conservador: quien ya tiene número de MTC cargado es, por definición, de ámbito
-- nacional. No se toca a nadie más — inventarle una autoridad a una ficha vacía sería
-- afirmar un alcance que nadie verificó, y el alcance es justo lo que se va a usar para
-- dejar o no salir un servicio.
update public.empresas_tercerizadas
   set autoridad_habilitante = 'mtc'
 where autoridad_habilitante is null
   and coalesce(btrim(autorizacion_mtc), '') <> '';

-- `habilitacion_sutran` / `venc_habilitacion` QUEDAN HUÉRFANAS: por decisión del dueño el
-- ERP ya no las lee ni las escribe en ningún sitio. SUTRAN fiscaliza, no autoriza, y lo que
-- se pedía ahí era en realidad la habilitación VEHICULAR — que es por placa y hoy vive como
-- "Tarjeta Única de Circulación (TUC)" en `documentos_tercero`.
--
-- NO SE HACE `drop column`, y es a propósito: borrar una columna es irreversible y estas
-- pueden tener datos que alguien tecleó. Se quedan ahí, inertes y consultables. Antes de
-- borrarlas de verdad hay que MIRAR qué guardan (consulta al pie).
comment on column public.empresas_tercerizadas.habilitacion_sutran is
  'OBSOLETA · el ERP ya no la lee ni la escribe. SUTRAN fiscaliza, no autoriza: lo que se '
  'registraba aquí era la habilitación vehicular, que es por placa y hoy es la TUC en '
  'documentos_tercero. Se conserva por si guarda datos históricos; ver el pie de '
  'supabase/tercerizadas-autorizacion-ambito.sql antes de eliminarla.';

comment on column public.empresas_tercerizadas.venc_habilitacion is
  'OBSOLETA · misma historia que habilitacion_sutran. El ERP ya no la lee.';

-- ── VERIFICACIÓN ───────────────────────────────────────────────────────────────
-- 1) Qué falta por completar a mano. Las filas con autoridad_habilitante NULL son las que
--    el ERP todavía no puede verificar; lo dice en pantalla mientras tanto.
-- select autoridad_habilitante, autoridad_emisor, count(*)
--   from public.empresas_tercerizadas group by 1, 2 order by 3 desc;
--
-- 2) ¿Qué guardaban de verdad las columnas de SUTRAN? Correr ESTO ANTES de plantearse
--    borrarlas: si sale vacío, no hay nada que perder; si sale un número, mirar qué es —
--    lo más probable es una TUC que le corresponde a una placa, no a la empresa.
-- select razon_social, habilitacion_sutran, venc_habilitacion
--   from public.empresas_tercerizadas
--  where coalesce(btrim(habilitacion_sutran), '') <> '' or venc_habilitacion is not null;
--
-- 3) Solo si (2) sale vacío o ya moviste lo que había, y con esa decisión tomada:
-- alter table public.empresas_tercerizadas drop column if exists habilitacion_sutran;
-- alter table public.empresas_tercerizadas drop column if exists venc_habilitacion;
