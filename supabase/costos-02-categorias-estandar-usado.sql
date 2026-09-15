-- ============================================================================
-- AFA Transportes — Categorías PREMIUM (0 km) y ESTÁNDAR (usado)
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- QUÉ RESUELVE
--
-- `parametros_costos` deprecia con UNA sola cifra por tipo (`valor_compra`,
-- `residual_pct`, `vida_util_anios`, `km_anio`). Eso describe una unidad, no dos. Cuando la
-- misma ficha cubre un bus 0 km y otro comprado usado al 20-30 % de su valor, esa cifra está
-- mal para los dos a la vez: infla el costo del usado y, si alguien la corrige hacia abajo
-- pensando en el usado, desinfla el del nuevo.
--
-- La separación correcta NO es un descuento sobre la depreciación: es DUPLICAR la categoría.
-- Todo el motor de costeo trabaja por `parametros_costos.tipo_vehiculo` y cada placa apunta a
-- una ficha por `vehiculos.tipo_vehiculo_costeo`, así que con dos filas el cotizador, el
-- tarifario y el presupuesto por servicio quedan bien los tres a la vez.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ LO MÁS IMPORTANTE DE ESTE ARCHIVO: LOS NÚMEROS DE LA ESTÁNDAR SON REFERENCIALES.
--
-- Son factores sobre la ficha premium, no mediciones de esta flota. Sirven para arrancar y
-- para que las pantallas dejen de mostrar una sola cifra donde hay dos realidades; están
-- pensados para EDITARSE en /configuracion/costos → Flota / Vehículos conforme aparezca el
-- dato real de cada unidad. Cada factor lleva escrito de dónde salió y cuál es su riesgo.
--
-- Y HAY UN ERROR QUE ESTE ARCHIVO EXISTE PARA NO COMETER: bajar SOLO la depreciación.
-- Medido sobre la propia flota de AFA (Bus 50 pax, 106 km, depreciación S/ 77.73 = 0.73 S/km),
-- una unidad usada ahorra ~0.43 S/km de capital... y un mantenimiento 0.70 S/km más caro se lo
-- come entero. Una categoría estándar con la depreciación baja y el mantenimiento del bus nuevo
-- hace que el ERP oferte POR DEBAJO de su costo real — y un costo corto no se discute antes de
-- vender: se descubre cuando el servicio ya se prestó.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- DE DÓNDE SALE CADA FACTOR
--
--  · valor_compra × 0.25 — el rango 20-30 % es el que declara AFA para lo que paga por una
--    unidad usada frente a su valor 0 km. Contraste de mercado (NeoAuto, set-2026): King Long
--    bus urbano 9 m 2014 con 267 000 km ofertado en US$ 28 000, contra un 9 m nuevo bastante
--    por encima de S/ 300 000 → del orden del 30 %. Se toma el centro del rango declarado.
--
--  · vida_util_anios = 5 — la vida que le QUEDA, no otros diez años. Coincide con el tope
--    tributario de 20 % anual para vehículos de transporte terrestre (art. 22 del Reglamento de
--    la Ley del Impuesto a la Renta), así que es defendible ante el contador y cae del lado
--    caro, que es el seguro: una vida más corta sube la depreciación por km.
--
--  · residual_pct = 0.30 — sobre lo que SE PAGÓ, no sobre el valor 0 km. Es más alto que el de
--    la premium (0.15-0.18) a propósito: la unidad ya sufrió la caída fuerte de la curva y lo
--    que le queda se sostiene. En el mercado peruano una Coaster 1994 sigue ofertada en
--    US$ 40 000 (NeoAuto, set-2026), que es justo lo que significa un residual alto.
--
--  · km_anio — IGUAL que la premium. La unidad usada corre la misma ruta y el mismo contrato;
--    bajarle los km le subiría artificialmente la depreciación y los fijos por kilómetro.
--
--  · mantenimiento_km × 1.60 — EL NÚMERO MÁS INCIERTO DE TODO EL ARCHIVO, y el que más pesa.
--    No hay dato público de S/km de taller en Perú: el factor refleja que una unidad fuera de
--    garantía y con más de diez años interviene más seguido y más caro. NO LO DEJES ASÍ: la
--    columna «Medido» de la categoría 🔧 Mantenimiento calcula el S/km real de cada tipo con
--    las órdenes de trabajo de /mantenimiento y propone el número medido. Ese es el que manda.
--
--  · rendimiento_1 × 0.90 — un motor con más de diez años rinde menos. Mismo camino: la
--    columna «Medido» de ⛽ Combustible lo corrige con las cargas reales de la unidad.
--
--  · seguro_anual × 0.50 — la prima de casco se cotiza sobre el valor asegurado, y aquí ese
--    valor es una cuarta parte. SOAT, revisión técnica y permisos NO cambian: dependen del uso
--    (transporte de personas) y no del año de fabricación.
--
--  · vida_neumatico_km × 0.90 — suspensión y alineamiento más gastados comen cocada.
--    El precio y el número de neumáticos no cambian: la llanta cuesta lo mismo.
--
--  · euronorm = 'Euro III' y usa_urea = false — FORZADO, no clonado. Una unidad de más de diez
--    años no es Euro V, y clonar la norma de la premium le cargaría AdBlue a un motor que no lo
--    consume: el renglón de urea saldría en toda cotización de la categoría usada.
--
--  · conductor_dia, capacidad, ícono y grupo — IGUALES. El conductor cuesta lo mismo y los
--    asientos son los mismos.
--
-- LO QUE ESTE SCRIPT NO HACE: reasignar placas. Eso se hace a mano, unidad por unidad, en
-- /vehiculos → Editar → Categoría de costeo, que es donde alguien mira la placa y sabe si se
-- compró nueva o usada. Un UPDATE masivo por año de fabricación adivinaría, y adivinar aquí
-- mueve el precio de venta de esa unidad.
-- ============================================================================

BEGIN;

-- ── 1 · LAS ACTUALES SON LAS PREMIUM ────────────────────────────────────────
-- Solo se toca el NOMBRE (lo que se lee en el cotizador y el tarifario). La CLAVE
-- `tipo_vehiculo` NO se renombra jamás: es el puente sin FK con
-- `vehiculos.tipo_vehiculo_costeo`, `vehiculos_tercero.tipo_vehiculo_costeo`,
-- `historial_costos.tipo_vehiculo` y `cotizaciones.tipo_vehiculo`. Renombrarla dejaría todo eso
-- apuntando a una clave que no existe.
UPDATE parametros_costos
   SET nombre = nombre || ' · Premium (0 km)',
       updated_by = 'migracion costos-02'
 WHERE activo = true
   AND tipo_vehiculo NOT LIKE '%\_ESTANDAR'
   AND nombre NOT ILIKE '%premium%'
   AND nombre NOT ILIKE '%estándar%'
   AND nombre NOT ILIKE '%estandar%';

-- ── 2 · LA GEMELA ESTÁNDAR DE CADA UNA ──────────────────────────────────────
-- Se clona con INSERT ... SELECT para que funcione con las categorías que haya hoy, sean las
-- que sean, y para que una categoría nueva que se cree mañana no obligue a editar este archivo.
INSERT INTO parametros_costos (
  tipo_vehiculo, nombre, capacidad, activo, icono, grupo_vehiculo, euronorm,
  usa_urea, consumo_urea_pct,
  tipo_combustible_1, rendimiento_1, pct_uso_1,
  tipo_combustible_2, rendimiento_2, pct_uso_2,
  n_neumaticos, costo_neumatico, vida_neumatico_km,
  mantenimiento_km, valor_compra, residual_pct, vida_util_anios, km_anio,
  seguro_anual, soat_anual, revision_semestral, permisos_anual, otros_fijos_mensual,
  conductor_dia, updated_by
)
SELECT
  p.tipo_vehiculo || '_ESTANDAR',
  -- El nombre se compone desde el de la premium, sin arrastrar su sufijo.
  regexp_replace(p.nombre, '\s*·\s*Premium \(0 km\)$', '') || ' · Estándar (usado)',
  p.capacidad,
  true,
  p.icono,
  p.grupo_vehiculo,
  'Euro III',                                   -- forzado: ver la nota de la cabecera
  false,                                        -- sin AdBlue
  p.consumo_urea_pct,
  p.tipo_combustible_1,
  ROUND((p.rendimiento_1 * 0.90)::numeric, 2),  -- motor con más de diez años
  p.pct_uso_1,
  p.tipo_combustible_2,
  CASE WHEN p.rendimiento_2 IS NULL THEN NULL ELSE ROUND((p.rendimiento_2 * 0.90)::numeric, 2) END,
  p.pct_uso_2,
  p.n_neumaticos,
  p.costo_neumatico,
  ROUND((p.vida_neumatico_km * 0.90)::numeric, 0),
  ROUND((p.mantenimiento_km * 1.60)::numeric, 2),  -- ⚠ el más incierto: lo corrige «Medido»
  ROUND((p.valor_compra * 0.25)::numeric, 0),      -- 20-30 % del 0 km, centro del rango
  0.30,                                            -- residual sobre lo PAGADO
  5,                                               -- vida útil RESTANTE
  p.km_anio,                                       -- misma ruta, mismos km
  ROUND((p.seguro_anual * 0.50)::numeric, 0),      -- prima sobre un valor asegurado menor
  p.soat_anual,                                    -- por uso, no por año
  p.revision_semestral,
  p.permisos_anual,
  p.otros_fijos_mensual,
  p.conductor_dia,                                 -- el conductor cuesta lo mismo
  'migracion costos-02'
FROM parametros_costos p
WHERE p.activo = true
  AND p.tipo_vehiculo NOT LIKE '%\_ESTANDAR'
  AND NOT EXISTS (
    SELECT 1 FROM parametros_costos q WHERE q.tipo_vehiculo = p.tipo_vehiculo || '_ESTANDAR'
  );

-- ── 3 · EL ACTA ─────────────────────────────────────────────────────────────
-- El alta de una categoría mueve el precio de todo lo que se cotice con ella, así que queda en
-- el historial como cualquier otro cambio de costo. `valor_anterior` va en NULL: no había nada
-- antes, y poner ahí el valor de la premium pintaría una variación que no ocurrió.
INSERT INTO historial_costos (
  tabla_origen, tipo_vehiculo, campo_modificado, valor_anterior, valor_nuevo, motivo, cambiado_por
)
SELECT
  'parametros_costos',
  e.tipo_vehiculo,
  'alta_categoria',
  NULL,
  e.valor_compra,
  'Alta automática · categoría estándar (unidad usada) clonada de ' ||
    replace(e.tipo_vehiculo, '_ESTANDAR', '') ||
    ' con factores REFERENCIALES de mercado (costos-02). Revisar valor de compra, vida útil y ' ||
    'mantenimiento con el dato real de cada unidad.',
  'migracion costos-02'
FROM parametros_costos e
WHERE e.updated_by = 'migracion costos-02'
  AND e.tipo_vehiculo LIKE '%\_ESTANDAR'
  AND NOT EXISTS (
    SELECT 1 FROM historial_costos h
     WHERE h.tipo_vehiculo = e.tipo_vehiculo AND h.campo_modificado = 'alta_categoria'
  );

COMMIT;

-- ── 4 · COMPROBACIÓN ────────────────────────────────────────────────────────
-- Las dos fichas lado a lado. Lo que hay que mirar: que la estándar NO salga barata por todos
-- lados. Si su S/km total queda muy por debajo del de la premium, el mantenimiento está corto —
-- y ahí es donde entra la columna «Medido».
SELECT
  replace(p.tipo_vehiculo, '_ESTANDAR', '') AS familia,
  CASE WHEN p.tipo_vehiculo LIKE '%\_ESTANDAR' THEN 'estándar' ELSE 'premium' END AS clase,
  p.nombre,
  p.valor_compra,
  p.residual_pct,
  p.vida_util_anios,
  p.km_anio,
  p.rendimiento_1,
  p.mantenimiento_km,
  ROUND((p.valor_compra * (1 - p.residual_pct) / NULLIF(p.vida_util_anios * p.km_anio, 0))::numeric, 4) AS deprec_s_km
FROM parametros_costos p
WHERE p.activo = true
ORDER BY familia, clase DESC;
