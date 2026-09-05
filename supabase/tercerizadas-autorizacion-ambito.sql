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

-- `habilitacion_sutran` / `venc_habilitacion` NO se borran ni se vacían: son datos que
-- alguien escribió y hay fichas que los tienen. Salen del formulario (SUTRAN fiscaliza, no
-- autoriza) pero se siguen mostrando y editando mientras tengan valor, para que nadie pierda
-- un control que ya estaba puesto.
comment on column public.empresas_tercerizadas.habilitacion_sutran is
  'HEREDADO. N° de registro ante SUTRAN. SUTRAN fiscaliza, no autoriza, así que el '
  'formulario ya no lo pide; se conserva y se sigue editando en las fichas que lo tienen.';

-- ── VERIFICACIÓN ───────────────────────────────────────────────────────────────
-- select autoridad_habilitante, autoridad_emisor, count(*)
--   from public.empresas_tercerizadas group by 1, 2 order by 3 desc;
-- Las filas con autoridad_habilitante NULL son las que hay que completar a mano: hasta
-- entonces el ERP no puede verificar su alcance y lo dice en pantalla.
