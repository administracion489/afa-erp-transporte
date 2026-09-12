-- ============================================================================
-- AFA Transportes — «Premium» pasa a «Full Equipo» en el NOMBRE de cada ficha.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- Decisión del dueño del ERP: **en términos comerciales AFA vende «Full Equipo», no «Premium»**.
-- Esa es la palabra con la que se habla con el cliente, así que es la que tiene que estar en
-- pantalla y en los documentos; «Premium» obligaba a traducirla mentalmente en cada cotización.
--
-- El par queda **Full Equipo / Estándar**, que son las dos palabras que AFA ya usaba: «Estándar»
-- es la que el propio dueño empleó al describir las unidades de más de diez años.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SOLO CAMBIA EL NOMBRE. LA CLAVE `tipo_vehiculo` NO SE TOCA JAMÁS.
--
-- Es la misma línea que trazó `costos-03`, y por la misma razón: `tipo_vehiculo` es texto sin FK
-- y es el puente con `vehiculos.tipo_vehiculo_costeo`, `vehiculos_tercero.tipo_vehiculo_costeo`,
-- `historial_costos.tipo_vehiculo` (de donde sale el sello de procedencia del rendimiento medido)
-- y `cotizaciones.tipo_vehiculo`. El sufijo `_ESTANDAR` que empareja cada gemela seguirá
-- diciendo `_ESTANDAR` para siempre — `emparejarFlota` empareja por la CLAVE, nunca por el
-- nombre, que es texto editable desde el modal de ficha.
--
-- Tampoco se toca `equipamiento` en `vehiculos`, `cotizaciones` ni `tarifario`: ahí los valores
-- son `full_equipo`/`basico`, y `basico` forma parte del índice único del tarifario. Renombrarlo
-- a `estandar` dejaría huérfana la lista de precios entera.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL PARÉNTESIS SE QUEDA, Y NO ES DECORACIÓN
--
-- `· Full Equipo (<10 años)` y `· Estándar (>10 años)`: 10 años es el mismo umbral con el que la
-- columna **Flota** de 📉 Depreciación avisa que una categoría mezcla unidades nuevas y usadas,
-- así que el nombre sigue diciendo con qué criterio se decide a qué ficha va una placa.
-- ============================================================================

BEGIN;

UPDATE public.parametros_costos
   SET nombre = replace(nombre, '· Premium (<10 años)', '· Full Equipo (<10 años)')
 WHERE nombre LIKE '%· Premium (<10 años)%';

-- Las dos redacciones anteriores de la misma ficha, por si alguna base se quedó en `costos-02`
-- sin correr `costos-03`. Correr esto sobre una base ya migrada no encuentra ninguna fila.
UPDATE public.parametros_costos
   SET nombre = replace(nombre, '· Premium (0 km)', '· Full Equipo (<10 años)')
 WHERE nombre LIKE '%· Premium (0 km)%';

UPDATE public.parametros_costos
   SET nombre = replace(nombre, '· Estándar (usado)', '· Estándar (>10 años)')
 WHERE nombre LIKE '%· Estándar (usado)%';

COMMIT;

-- ── COMPROBACIÓN ────────────────────────────────────────────────────────────
-- Cada par junto. Lo que hay que ver: ninguna fila con «Premium» en el nombre, y la CLAVE
-- intacta — las Estándar siguen terminando en `_ESTANDAR`.
SELECT tipo_vehiculo AS clave,
       nombre,
       CASE WHEN nombre ILIKE '%premium%' THEN 'QUEDA UN PREMIUM — revisar' ELSE 'ok' END AS diagnostico
  FROM public.parametros_costos
 WHERE activo = true
 ORDER BY replace(tipo_vehiculo, '_ESTANDAR', ''), tipo_vehiculo;
