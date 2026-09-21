-- ============================================================================
-- El logo para FONDOS OSCUROS en la ficha de la empresa.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- POR QUÉ EXISTE: `logo_claro_url` estaba en el CREATE TABLE que /configuracion/perfil
-- enseña como SQL de instalación, así que una base creada DESPUÉS la tiene y una creada
-- ANTES no — y no había ningún archivo con el ALTER para las segundas. En esas, la
-- pantalla ofrecía «Logo Versión Clara», la imagen subía al bucket, el UPDATE fallaba y
-- nadie miraba su error: el toast decía «actualizado ✓» sobre una columna inexistente y
-- la vista previa se pintaba desde el estado local. Al recargar no quedaba nada.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SON DOS IMÁGENES, NO UNA CON UN FILTRO.
--
-- `logo_url` se imprime en papel: letras azules sobre fondo blanco. `logo_claro_url` es el
-- mismo logo en blanco, para el panel azul marino del portal del cliente y la barra
-- superior. El ERP no puede mirar un PNG y decidir si se ve encima de un fondo, así que
-- cuál va en cada sitio lo declara la pantalla y lo resuelve `logoDeFondo`
-- (lib/empresa-perfil.ts) — en UN solo sitio, con las dos cascadas escritas.
--
-- SIN VALOR POR DEFECTO, igual que `autorizacion_mtc`: este ERP se vende y sembrar aquí el
-- logo de AFA se lo llevaría el primer comprador que corriera la migración. Vacío es un
-- estado válido — sobre fondo oscuro se cae al logo principal, que será suyo aunque se le
-- vea el fondo blanco, y nunca al de otra empresa.
--
-- SIN CORRERLA, el comportamiento es el de antes: /cliente lee la columna y reintenta sin
-- ella (el portal no pierde el nombre ni el teléfono por un SQL accesorio), y el perfil
-- AVISA nombrando este archivo en vez de decir que guardó.
-- ============================================================================

ALTER TABLE public.empresa_perfil ADD COLUMN IF NOT EXISTS logo_claro_url text;

COMMENT ON COLUMN public.empresa_perfil.logo_claro_url IS
  'Logo para fondos OSCUROS (el panel del login de /cliente y su barra superior). Es otra '
  'imagen, no un filtro del principal. Vacío = esas pantallas caen al logo principal. Se sube '
  'en /configuracion/perfil → «Logo Versión Clara».';

-- ── COMPROBACIÓN ────────────────────────────────────────────────────────────
-- Lo que hay que ver: la columna existe. Si sale «sin logo claro», súbelo en
-- /configuracion/perfil → «Logo Versión Clara» — hasta entonces el portal del cliente pinta
-- el logo principal sobre el fondo azul, que es lo que se reportó.
SELECT nombre,
       logo_url,
       logo_claro_url,
       CASE WHEN coalesce(logo_claro_url, '') = ''
            THEN 'sin logo claro — /cliente pinta el principal sobre el fondo oscuro'
            ELSE 'ok' END AS diagnostico
  FROM public.empresa_perfil
 WHERE id = 1;
