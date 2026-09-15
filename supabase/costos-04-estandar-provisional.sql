-- ============================================================================
-- AFA Transportes — La ficha Estándar (>10 años), en PROVISIONAL
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
--
--   vida_util_anios   de la Estándar  ←  la de su gemela Premium (10 años)
--   mantenimiento_km  de la Estándar  ←  el de su gemela Premium
-- ============================================================================
--
-- DECISIÓN DEL DUEÑO DEL ERP, tomada con la evidencia delante y de forma explícita:
-- igualar los dos parámetros «de manera provisional hasta lograr información real poco a poco».
-- No es un descuido ni un valor heredado — está escrito aquí para que ninguna sesión futura lo
-- «arregle» de vuelta sin saber que fue una decisión.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LO QUE ESTE ARCHIVO AFIRMA, Y HAY QUE SABERLO
--
-- Al igualar el mantenimiento, el ERP pasa a costear la unidad de más de 10 años **como si
-- mantuviera igual que una de fábrica**. Si en la realidad gasta un 30-50 % más de taller, el
-- S/km de la Estándar queda entre 8 % y 15 % por debajo del real, y eso es un costo CORTO: no
-- se discute antes de vender, se descubre cuando el servicio ya se prestó.
--
-- Se acepta a propósito y con dos condiciones que lo hacen reversible:
--   1. El acta que este archivo deja en `historial_costos` dice PROVISIONAL, con su fecha.
--   2. La columna «Medido» de 🔧 Mantenimiento en /configuracion/costos sigue proponiendo el
--      número real en cuanto haya órdenes de trabajo con kilometraje. ESE es el que manda, y el
--      día que aparezca hay que aplicarlo.
--
-- Para ver en cualquier momento de qué lado quedó cada ficha:
--     npx tsx scripts/equilibrio-usado.mts
-- El «punto de equilibrio» que imprime es el mantenimiento al que las dos gemelas costarían lo
-- MISMO por km. Después de correr este archivo, las Estándar quedan POR DEBAJO de él — o sea,
-- el ERP dice que la unidad vieja cuesta menos por kilómetro. Esa es la afirmación que se está
-- haciendo, y el script la mide.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ LA VIDA ÚTIL VUELVE A 10 AÑOS
--
-- `costos-02` le puso 5 —la vida RESTANTE, alineada con el tope tributario del 20 % anual del
-- art. 22 del Reglamento de la LIR—. La vida útil de gestión, sin embargo, es **cuántos años
-- esperas SERVIR con esa unidad**, no el tope fiscal: si un bus comprado a los 12 años va a
-- trabajar 10 más, repartir su capital en 5 sobre-recupera y encarece cada kilómetro.
--
-- PENDIENTE CONOCIDO, y no se toca aquí para no mezclar dos decisiones: con vida útil de 10
-- años, el `residual_pct = 0.30` que dejó `costos-02` describe una unidad de 22 años valiendo
-- el 30 % de lo que se pagó por ella a los 12. Si eso resulta alto, bajarlo (p. ej. a 0.15)
-- sube la depreciación ~0.03 S/km en un bus. Es un ajuste menor y se hace en la celda.
--
-- NADA DE ESTO TOCA LA CLAVE `tipo_vehiculo`: el emparejamiento es por el sufijo `_ESTANDAR`,
-- que es la identidad que escribió `costos-02` y que nunca se renombra.
-- ============================================================================

BEGIN;

-- ── 1 · LAS ACTAS VAN PRIMERO ───────────────────────────────────────────────
-- Necesitan el valor VIEJO, así que se insertan antes del UPDATE. El historial es POR CAMPO,
-- así que son dos filas por ficha. `IS DISTINCT FROM` las hace idempotentes: una segunda
-- corrida no encuentra diferencias y no escribe un acta de un cambio que no ocurrió.

INSERT INTO historial_costos (
  tabla_origen, tipo_vehiculo, campo_modificado, valor_anterior, valor_nuevo, motivo, cambiado_por
)
SELECT
  'parametros_costos', e.tipo_vehiculo, 'vida_util_anios', e.vida_util_anios, p.vida_util_anios,
  'PROVISIONAL (costos-04): vida útil igualada a la de ' || p.tipo_vehiculo ||
    '. La vida útil de gestión son los años que se espera SERVIR con la unidad, no el tope ' ||
    'tributario de 5. Revisar cuando se sepa cuánto va a trabajar de verdad.',
  'migracion costos-04'
FROM parametros_costos e
JOIN parametros_costos p ON e.tipo_vehiculo = p.tipo_vehiculo || '_ESTANDAR'
WHERE e.activo = true AND p.activo = true
  AND e.vida_util_anios IS DISTINCT FROM p.vida_util_anios;

INSERT INTO historial_costos (
  tabla_origen, tipo_vehiculo, campo_modificado, valor_anterior, valor_nuevo, motivo, cambiado_por
)
SELECT
  'parametros_costos', e.tipo_vehiculo, 'mantenimiento_km', e.mantenimiento_km, p.mantenimiento_km,
  'PROVISIONAL (costos-04): mantenimiento igualado al de ' || p.tipo_vehiculo ||
    ' hasta tener datos reales. OJO: esto afirma que una unidad de más de 10 años mantiene como ' ||
    'una de fábrica; si gasta más, este S/km está corto. Lo reemplaza la columna Medido de ' ||
    'Mantenimiento en cuanto haya órdenes de trabajo con kilometraje.',
  'migracion costos-04'
FROM parametros_costos e
JOIN parametros_costos p ON e.tipo_vehiculo = p.tipo_vehiculo || '_ESTANDAR'
WHERE e.activo = true AND p.activo = true
  AND e.mantenimiento_km IS DISTINCT FROM p.mantenimiento_km;

-- ── 2 · LOS DOS CAMPOS, COPIADOS DE LA GEMELA ───────────────────────────────
-- Se copian de la Premium en vez de escribir un literal: si mañana una categoría cambia su
-- vida útil o su mantenimiento, volver a correr esto las vuelve a igualar sin editar el archivo.
UPDATE parametros_costos e
   SET vida_util_anios  = p.vida_util_anios,
       mantenimiento_km = p.mantenimiento_km,
       updated_by       = 'migracion costos-04'
  FROM parametros_costos p
 WHERE e.tipo_vehiculo = p.tipo_vehiculo || '_ESTANDAR'
   AND e.activo = true AND p.activo = true;

COMMIT;

-- ── 3 · COMPROBACIÓN ────────────────────────────────────────────────────────
-- Cada par junto. Lo que hay que ver: misma vida útil, mismo mantenimiento, y la depreciación
-- de la Estándar bastante por debajo — que es de donde sale que ahora salga más barata.
SELECT
  replace(p.tipo_vehiculo, '_ESTANDAR', '') AS familia,
  CASE WHEN p.tipo_vehiculo LIKE '%\_ESTANDAR' THEN 'estándar' ELSE 'premium' END AS clase,
  p.nombre,
  p.valor_compra,
  p.residual_pct,
  p.vida_util_anios,
  p.km_anio,
  p.mantenimiento_km,
  p.rendimiento_1,
  ROUND((p.valor_compra * (1 - p.residual_pct) / NULLIF(p.vida_util_anios * p.km_anio, 0))::numeric, 4) AS deprec_s_km
FROM parametros_costos p
WHERE p.activo = true
ORDER BY familia, clase DESC;
