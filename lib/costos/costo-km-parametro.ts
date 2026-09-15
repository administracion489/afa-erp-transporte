// lib/costos/costo-km-parametro.ts — Cuánto cuesta un kilómetro de un TIPO de vehículo,
// según los parámetros tecleados en /configuracion/costos. Módulo PURO: recibe la fila de
// `parametros_costos` y el mapa de precios, y devuelve números. No lee la base, igual que
// lib/costeo-propio.ts, lib/rendimiento.ts y lib/radar/coherencia-voucher.ts.
//
// POR QUÉ EXISTE. La misma fórmula estaba escrita TRES veces y una de las tres estaba mal:
//
//   1. `calcCostoKm`   (app/configuracion/costos/page.tsx:65)  — completa.
//   2. inline          (app/configuracion/costos/page.tsx:423) — `pc / rendimiento_1`, SIN
//      `pct_uso_1` y sin el segundo combustible. Es la columna "S/km comb." de la tabla
//      "Impacto en costo S/km", así que en una unidad BIMODAL esa columna lleva meses
//      publicando un número que no es el que usa el resto de la pantalla.
//   3. `calcCostoVeh`  (app/cotizaciones/page.tsx:55)          — completa, dentro del
//      cálculo del precio sugerido.
//
// SE EXTRAJO, NO SE REESCRIBIÓ. Cada término conserva su expresión y su orden literal, y
// `scripts/prueba-costos-parametros.mts` corre la versión original —copiada literal dentro
// del propio script— contra esta sobre una rejilla de fixtures y las compara con `===`.
// Mismo criterio que `scripts/prueba-costeo.mts` con lib/costeo-propio.ts: si esa prueba
// falla algún día, la fórmula cambió y las cotizaciones dejan de ser reproducibles.
//
// LO QUE A PROPÓSITO NO SE HIZO, y conviene que quede escrito porque parece una mejora:
//
// · NO se protegen los divisores. Con `rendimiento_1 = 0` esto devuelve `Infinity`, igual
//   que hoy. lib/costeo-propio.ts sí los protege, pero ahí el guard nació con su pantalla;
//   meterlo aquí cambiaría un `Infinity` —ruidoso, imposible de confundir con un precio— por
//   un número finito, barato y falso, que es justo lo que este ERP evita ("un dato que se
//   esconde obliga a ir a buscarlo a la base"). Si algún día se quiere, es su propio cambio:
//   detectar el parámetro vacío y pintar `—` diciendo cuál falta, no devolver un número.
//
// · NO se usa `calcularCostoUnidad` de lib/costeo-propio.ts, que es el motor bueno. Incluye
//   la reserva del 5 % y devolvería 3.156 donde la pantalla lleva meses diciendo 3.0058:
//   cambiar el número de referencia en el mismo commit que unifica la fórmula haría
//   imposible saber cuál de los dos cambios movió qué.
import { LITROS_POR_GALON } from "@/lib/combustible-tipos";

/**
 * Los campos de `parametros_costos` que entran en el costo por kilómetro.
 *
 * Estructural a propósito: `ParamCosto` está declarado dos veces con formas distintas
 * (app/configuracion/costos/page.tsx y app/cotizaciones/page.tsx) y las dos encajan aquí.
 */
export type ParametrosCostoKm = {
  tipo_combustible_1: string;
  rendimiento_1: number;
  pct_uso_1: number;
  tipo_combustible_2?: string | null;
  rendimiento_2?: number | null;
  pct_uso_2?: number | null;
  usa_urea?: boolean;
  consumo_urea_pct?: number | null;
  n_neumaticos: number;
  costo_neumatico: number;
  vida_neumatico_km: number;
  mantenimiento_km: number;
  valor_compra: number;
  residual_pct: number;
  vida_util_anios: number;
  km_anio: number;
  seguro_anual: number;
  soat_anual: number;
  revision_semestral: number;
  permisos_anual: number;
  otros_fijos_mensual: number;
};

/** Precio vigente por tipo de combustible, tal como lo indexa `precios_combustible.tipo`. */
export type PreciosCombustible = Record<string, number>;

/**
 * El costo por kilómetro, abierto en sus seis términos.
 *
 * Se publica abierto y no solo sumado porque los tres consumidores necesitan trozos
 * distintos: la tabla "Impacto en S/km" enseña el de combustible y el de urea por separado,
 * y `calcCostoVeh` los agrupa a su manera para multiplicar por los km. Sin esto, cada uno
 * volvería a escribir su trozo de la fórmula, que es exactamente cómo nacieron las tres
 * copias que este módulo viene a matar.
 */
export type ComponentesCostoKm = {
  /** Combustible 1 ponderado por `pct_uso_1`, más el 2 si el tipo es bimodal. */
  combustible: number;
  /** AdBlue: solo Euro V/VI con Diésel. Cero en cualquier otro caso. */
  urea: number;
  neumaticos: number;
  /** `mantenimiento_km` tal cual: ya viene expresado en S/km. */
  mantenimiento: number;
  depreciacion: number;
  /** Seguros, SOAT, dos revisiones al año, permisos y otros fijos, prorrateados por km. */
  fijos: number;
};

/**
 * La urea depende del tipo de combustible escrito con TILDE ("Diésel").
 *
 * Es una comparación literal contra el texto que guarda `parametros_costos`, que sale del
 * `<select>` alimentado por `precios_combustible.tipo`. NO se pasa por `familiaCombustible`:
 * ese normaliza a minúsculas y **cae a diésel ante cualquier valor desconocido**, así que un
 * tipo nuevo llamado "Gasohol 90" activaría el consumo de AdBlue de un motor a gasolina.
 */
const ES_DIESEL_UREA = "Diésel";

/** El costo por kilómetro abierto en sus términos. Ninguno se redondea. */
export function componentesCostoKm(
  p: ParametrosCostoKm,
  precios: PreciosCombustible
): ComponentesCostoKm {
  const pc1 = precios[p.tipo_combustible_1] || 0;
  return {
    combustible:
      (pc1 / p.rendimiento_1) * p.pct_uso_1 +
      (p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2
        ? ((precios[p.tipo_combustible_2] || 0) / p.rendimiento_2) * p.pct_uso_2
        : 0),
    urea:
      p.usa_urea && p.tipo_combustible_1 === ES_DIESEL_UREA
        ? (1 / p.rendimiento_1) * LITROS_POR_GALON * (p.consumo_urea_pct || 0.04) * (precios["UREA"] || 0)
        : 0,
    neumaticos: (p.n_neumaticos * p.costo_neumatico) / p.vida_neumatico_km,
    mantenimiento: p.mantenimiento_km,
    depreciacion: (p.valor_compra * (1 - p.residual_pct)) / (p.vida_util_anios * p.km_anio),
    fijos:
      (p.seguro_anual + p.soat_anual + p.revision_semestral * 2 + p.permisos_anual + p.otros_fijos_mensual * 12) /
      p.km_anio,
  };
}

/**
 * El costo total por kilómetro de un tipo de vehículo.
 *
 * El orden de la suma es el de `calcCostoKm` y no se reordena: en coma flotante sumar los
 * mismos seis términos en otro orden puede mover el último decimal, y este número se pinta
 * a CUATRO decimales en la pantalla de costos.
 */
export function costoKmDeParametro(p: ParametrosCostoKm, precios: PreciosCombustible): number {
  const c = componentesCostoKm(p, precios);
  return c.combustible + c.neumaticos + c.mantenimiento + c.depreciacion + c.fijos + c.urea;
}
