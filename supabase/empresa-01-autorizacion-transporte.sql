-- ============================================================================
-- Autorización del regulador de transporte en la ficha de la empresa.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- POR QUÉ EXISTE: el pie de la orden de trabajo imprimía la autorización ESCRITA A MANO en el
-- código, junto con el nombre y los teléfonos de una empresa concreta. Este ERP se vende, así que
-- la orden de trabajo de un comprador salía con el nombre —y con el número de habilitación— de
-- otra empresa. Ahora todo eso sale de `empresa_perfil`, la fila única que se edita desde
-- /configuracion/perfil.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ESTA COLUMNA ES LA ÚNICA DEL PERFIL SIN VALOR POR DEFECTO, Y NO ES UN OLVIDO.
--
-- Un teléfono o una web heredados de otra empresa son un dato viejo: se nota y se corrige. Una
-- AUTORIZACIÓN DEL REGULADOR heredada es un número legal ajeno impreso en un papel que alguien
-- firma — el documento estaría afirmando una habilitación que su emisor no tiene. Por eso vacío
-- significa vacío y el documento **omite la línea entera** en vez de inventarla. Es la misma
-- regla que el PAX contratado de la liquidación y el km vigente del odómetro: sin dato no se cae
-- a otro número, se calla.
--
-- Y POR ESO ESTE ARCHIVO NO SIEMBRA NINGÚN VALOR. Escribir aquí la autorización de AFA la
-- metería en una migración que viaja con el producto, y el primer comprador que la corra se
-- llevaría el número de otro. Se teclea una vez en /configuracion/perfil.
-- ============================================================================

ALTER TABLE public.empresa_perfil ADD COLUMN IF NOT EXISTS autorizacion_mtc text;

COMMENT ON COLUMN public.empresa_perfil.autorizacion_mtc IS
  'Autorización del regulador de transporte (en Perú, la R.D. del MTC) que se imprime al pie de '
  'los documentos operativos. SIN valor por defecto a propósito: heredar el de otra empresa sería '
  'una afirmación legal falsa en un papel firmado. Vacío = la línea no se imprime.';

-- ── COMPROBACIÓN ────────────────────────────────────────────────────────────
-- Lo que hay que ver: la columna existe. Si sale en null, tecléala una vez en
-- /configuracion/perfil → «Autorización del regulador de transporte»; hasta entonces la orden de
-- trabajo se imprime sin esa línea, que es lo correcto.
SELECT nombre, ruc, telefono, autorizacion_mtc,
       CASE WHEN coalesce(autorizacion_mtc, '') = ''
            THEN 'sin autorización — la OT se imprime sin esa línea'
            ELSE 'ok' END AS diagnostico
  FROM public.empresa_perfil
 WHERE id = 1;
