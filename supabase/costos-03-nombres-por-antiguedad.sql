-- ============================================================================
-- AFA Transportes — Los nombres de las fichas dicen la ANTIGÜEDAD
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
--
--   «Bus 50 pax Diésel · Premium (0 km)»      →  «… · Premium (<10 años)»
--   «Bus 50 pax Diésel · Estándar (usado)»    →  «… · Estándar (>10 años)»
-- ============================================================================
--
-- POR QUÉ. «Premium» significaba DOS cosas en la misma pantalla del cotizador: la ficha de la
-- unidad (`· Premium (0 km)`) y el escenario de margen del 25 % (`⭐ Premium (25%)`). Con un bus
-- premium seleccionado, la pantalla ofrecía además un «precio estándar» y un «precio premium»,
-- que no son clases de bus sino políticas de precio. Son dos ejes distintos y tenían el mismo
-- nombre:
--
--   · la UNIDAD decide el COSTO      → la ficha: Premium (<10 años) / Estándar (>10 años)
--   · la POLÍTICA decide el PRECIO   → el margen: mínimo 15 % / objetivo 20 % / alto 25 %
--
-- Esta migración arregla la mitad que vive en la base (el nombre de la ficha); la otra mitad
-- —los tres cuadros, que ahora se llaman por su margen— viaja en el código del cotizador. La
-- palabra «Estándar» puede volver a la ficha justamente porque los cuadros ya no la usan.
--
-- Y el paréntesis no es decoración: **10 años es el mismo umbral que la columna «Flota»** de
-- 📉 Depreciación usa para avisar que una categoría mezcla unidades nuevas y usadas
-- (`cotejarAntiguedadTipo`, que compara la edad real de cada placa contra la vida útil que
-- declara la ficha). El nombre dice el criterio con el que se decide a qué categoría va una
-- placa, que es lo que alguien tiene delante en /vehiculos → Categoría de costeo.
--
-- SOLO SE TOCA EL NOMBRE. La CLAVE `tipo_vehiculo` (incluido el sufijo `_ESTANDAR`) NO se
-- renombra jamás: es el puente sin FK con `vehiculos.tipo_vehiculo_costeo`,
-- `vehiculos_tercero.tipo_vehiculo_costeo`, `historial_costos.tipo_vehiculo` y
-- `cotizaciones.tipo_vehiculo`. Renombrarla dejaría todo eso apuntando a una clave que no
-- existe — escribir con una identidad y leer con otra, el patrón que este repo ya pagó caro.
-- Por eso `lib/costos/equilibrio-usado.ts` empareja por la CLAVE y no por el nombre.
-- ============================================================================

BEGIN;

-- La unidad nueva. Se cubren las dos redacciones que pudo dejar `costos-02` y una segunda
-- corrida de este mismo archivo (el REPLACE no encuentra nada y no toca la fila).
UPDATE parametros_costos
   SET nombre = replace(nombre, ' · Premium (0 km)', ' · Premium (<10 años)'),
       updated_by = 'migracion costos-03'
 WHERE nombre LIKE '%· Premium (0 km)%';

-- La unidad comprada usada.
UPDATE parametros_costos
   SET nombre = replace(nombre, ' · Estándar (usado)', ' · Estándar (>10 años)'),
       updated_by = 'migracion costos-03'
 WHERE nombre LIKE '%· Estándar (usado)%';

COMMIT;

-- ── COMPROBACIÓN ────────────────────────────────────────────────────────────
-- Cada par junto. La CLAVE manda: la estándar es la misma clave con `_ESTANDAR` al final.
SELECT
  replace(tipo_vehiculo, '_ESTANDAR', '') AS familia,
  CASE WHEN tipo_vehiculo LIKE '%\_ESTANDAR' THEN 'estándar' ELSE 'premium' END AS clase,
  tipo_vehiculo,
  nombre
FROM parametros_costos
WHERE activo = true
ORDER BY familia, clase DESC;
