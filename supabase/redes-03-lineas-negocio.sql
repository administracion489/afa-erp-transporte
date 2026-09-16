-- ─────────────────────────────────────────────────────────────────────────────
-- redes-03-lineas-negocio.sql — El canal deja de hablar de un solo negocio.
--
-- EL DEPLOY NO CORRE ESTO. Hay que ejecutarlo a mano en Supabase → SQL Editor.
--
-- QUÉ VIENE A ARREGLAR
-- El prompt del redactor decía «una empresa de transporte de PERSONAL» y nada más, así que
-- el canal hablaba todos los días del mismo negocio. AFA hace cuatro: personal, turismo,
-- paseos escolares y alquiler de buses. Las otras tres no se publicaban nunca — no porque
-- alguien lo hubiera decidido, sino porque el prompt no las nombraba.
--
-- DOS COLUMNAS, Y HACEN COSAS DISTINTAS
--   redes_config.lineas        — QUÉ NEGOCIOS OFRECE esta empresa. Lo declara una persona.
--   redes_publicaciones.linea  — DE CUÁL habla el post de hoy. Rota sobre las activas.
--
-- EL DEFAULT ES `{personal}` Y ESO NO ES UN DESCUIDO: **este ERP se vende.** Sembrar las
-- cuatro haría que la instalación de un comprador empezara a publicar sobre paseos
-- escolares sin que nadie haya dicho que los hace — un dato inventado de los caros, el
-- mismo error que los respaldos de `empresa-perfil` pero por la puerta del marketing. Con
-- `{personal}` el comportamiento es byte a byte el de antes de esta migración, y las demás
-- las enciende una persona en /redes → Ajustes.
--
-- El UPDATE del final es para ESTA instalación, porque el dueño de AFA declaró estas cuatro
-- líneas por escrito. Un comprador NO debe correrlo: está separado y rotulado para que se
-- pueda dejar fuera al pegar el script.
--
-- SIN CHECK NI TABLA DE CATÁLOGO, y es deliberado: qué significa cada línea —a quién le
-- habla, de qué se puede hablar y sobre todo QUÉ NO SE PUEDE DECIR— vive en
-- `lib/redes/lineas.ts`, que es lo único que el modelo lee. Una tabla solo podría cargar la
-- etiqueta y dejaría DOS fuentes para la misma pregunta; `lineasValidas` descarta en
-- lectura cualquier valor que el catálogo no conozca, que es el mismo trabajo que haría un
-- CHECK sin partir la definición en dos sitios. Mismo criterio que `cat_combustible`.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.redes_config
  add column if not exists lineas text[] not null default '{personal}';

alter table public.redes_publicaciones
  add column if not exists linea text;

comment on column public.redes_config.lineas is
  'Líneas de negocio que esta empresa publica: personal | turismo | escolar | alquiler. El significado de cada una vive en lib/redes/lineas.ts, no aquí.';

comment on column public.redes_publicaciones.linea is
  'De qué línea de negocio habla este post. Rota por día del año sobre redes_config.lineas; el operador puede cambiarla.';

-- Índice para el historial por línea («enséñame lo último de turismo»). Parcial: la
-- inmensa mayoría de las filas viejas la tienen en null y no aportan nada al índice.
create index if not exists ix_redes_pub_linea
  on public.redes_publicaciones (linea, fecha desc)
  where linea is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- SOLO PARA LA INSTALACIÓN DE AFA — un comprador NO corre esto.
-- Son las cuatro líneas que el dueño declaró. Cambiarlas después es marcar y desmarcar
-- casillas en /redes → Ajustes; esto solo evita tener que hacerlo la primera vez.
-- ─────────────────────────────────────────────────────────────────────────────

update public.redes_config
   set lineas = '{personal,turismo,escolar,alquiler}'
 where id = 1;
