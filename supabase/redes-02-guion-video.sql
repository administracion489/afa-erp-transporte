-- ─────────────────────────────────────────────────────────────────────────────
-- redes-02-guion-video.sql — El guion del video y las fotos de más.
--
-- EL DEPLOY NO CORRE ESTO. Hay que ejecutarlo a mano en Supabase → SQL Editor.
-- Es una migración ACCESORIA: sin ella /redes sigue funcionando entera y el video se
-- puede montar igual — lo único que se pierde es que el guion quede GUARDADO, y la
-- pantalla lo dice nombrando este archivo en vez de fingir que se guardó. Todo lo que
-- toca estas columnas reintenta sin ellas (mismo patrón que `COLUMNAS_OPCIONALES`).
--
-- QUÉ VIENE A ARREGLAR
-- La primera versión del modo «generado» montaba UNA foto fija con el caption entero
-- encima. Eso no es un video, es una foto con un párrafo. El arreglo tiene dos mitades y
-- estas dos columnas son la que vive en la base:
--
--   imagenes — LAS DEMÁS FOTOS del día. `imagen_url` sigue siendo la principal (la que
--              se publica en Facebook e Instagram cuando no hay video) y no se toca: es
--              lo que ya está escrito y lo que leen el motor y los publicadores. Esta
--              columna es el resto, y solo la lee el video. Meter todo en un array y
--              hacer que `imagen_url` fuese `imagenes[0]` habría sido cambiar la
--              identidad de un dato que seis sitios ya leen — escribir bajo una clave y
--              leer con otra, por enésima vez en este repo.
--
--   guion    — el storyboard, tal como lo devuelve `normalizarGuion`: la lista de
--              escenas con su foto, su frase de pantalla, su duración, su movimiento de
--              cámara y su transición. Se guarda NORMALIZADO, nunca el crudo del
--              modelo: normalizar otra vez al leerlo sería la misma pregunta contestada
--              en dos sitios.
--
-- POR QUÉ `guion` ES jsonb Y NO UNA TABLA `redes_escenas`
-- Una escena no tiene vida propia: no se consulta, no se agrega, no se referencia desde
-- ningún sitio y no sobrevive a su publicación. Se lee y se escribe SIEMPRE entera, con
-- su publicación. Una tabla hija obligaría a un borrado-e-inserción transaccional en
-- cada edición del guion, que es justamente lo que `reagruparLineas` documenta como
-- caro. Es el mismo criterio que `items_json` en cotizaciones y `paradas_json` en
-- reservas.
--
-- NO HAY BACKFILL, Y NO ES PEREZA. Un guion escrito hoy sobre una publicación de la
-- semana pasada describiría unas fotos que nadie miró al escribirlo. La ausencia de
-- guion ya significa algo —«se monta con el reparto por defecto»— y la pantalla lo dice
-- con esas palabras.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.redes_publicaciones
  add column if not exists imagenes     text[],
  add column if not exists guion        jsonb,
  add column if not exists guion_modelo text;

comment on column public.redes_publicaciones.imagenes is
  'Fotos ADICIONALES del día, para el video. La principal sigue siendo imagen_url y no se duplica aquí.';

comment on column public.redes_publicaciones.guion is
  'Storyboard normalizado del video: {escenas:[{imagen,titulo,texto,movimiento,duracion_seg,transicion,tipo}],marca}. Lo escribe la IA mirando las fotos y lo pinta lib/redes/video.ts.';

comment on column public.redes_publicaciones.guion_modelo is
  'Qué modelo escribió el guion. Sirve para saber con qué se hizo cuando el resultado cambie.';

-- Sin índices: estas tres columnas solo se leen por `id` o por `fecha`, que ya los
-- tienen. Un índice sobre un jsonb que nadie consulta es mantenimiento sin lector.
