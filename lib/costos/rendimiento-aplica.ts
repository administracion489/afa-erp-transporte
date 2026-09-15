// lib/costos/rendimiento-aplica.ts — ¿El rendimiento MEDIDO de esta placa puede sustituir al
// TECLEADO de su tipo en el presupuesto de un servicio? Módulo PURO: recibe el parámetro y la
// medición, y devuelve el número que se va a usar con el motivo de por qué es ése.
//
// POR QUÉ EXISTE. `calcularPresupuesto` (lib/costeo-servicio.ts) sustituía así:
//
//     const rendAplica = ctx.rendimientoMedido && ctx.parametros
//       ? ctx.rendimientoMedido.familia === familiaCombustible(ctx.parametros.tipo_combustible_1)
//       : false;
//
// Una sola condición —la familia— y tres agujeros detrás:
//
// 1 · NO MIRABA `resumen.confiable`. `serieRendimiento` publica su mediana en cuanto hay UN
//     tramo bueno, así que una unidad recién comprada con dos cargas ya pisaba el parámetro
//     del tipo en el presupuesto de cada uno de sus servicios. Una mediana de un solo valor
//     ES ese valor: si ese tramo salió corto (llenado a medias, tráfico un martes), el
//     servicio se costea con él. `juzgarTramo` en lib/rendimiento.ts ya exigía `r.confiable`
//     antes de levantar un hallazgo, por exactamente la misma razón — este archivo solo
//     lleva ese guard al sitio donde el número se convierte en dinero.
//
// 2 · EL "km/gal" ESTABA HARDCODEADO EN LAS DOS RAMAS del renglón. Una unidad de GNV mide en
//     km/m³ y su renglón de presupuesto firmaba "km/gal" sobre ese número, en la rama medida
//     y en la del parámetro. La etiqueta sale ahora de `labelDeFamilia` (lib/rendimiento.ts),
//     que es de donde ya sale la de /combustible: una sola definición de en qué unidad va.
//
// 3 · SUSTITUÍA EN LOS TIPOS BIMODALES, y ahí la cuenta se descuenta dos veces. La fórmula de
//     lib/costeo-propio.ts es `(precio1/rend1)*pct_uso_1 + (precio2/rend2)*pct_uso_2`, así que
//     `rendimiento_1` significa "km por galón del combustible 1 SOBRE LOS KM HECHOS CON EL
//     COMBUSTIBLE 1". La mediana medida es Δodómetro ÷ galones de la familia mayoritaria, y el
//     odómetro no sabe de qué tanque salieron los km: sale inflada ~1/pct_uso_1, y la fórmula
//     la vuelve a multiplicar por pct_uso_1. Con un GLP/gasolina 60/40 eso costea el
//     combustible a la mitad de lo que cuesta.
//
// LA ASIMETRÍA QUE GOBIERNA LOS TRES: en un presupuesto, equivocarse hacia ABAJO (costear de
// menos) es lo caro. Un costo inflado se discute antes de vender; un costo corto se descubre
// cuando el servicio ya se prestó. Por eso ante la duda se usa el parámetro tecleado, que es
// una premisa que alguien firmó, y no una mediana que el ERP dedujo de dos cargas.
//
// EL MOTIVO SE DECLARA, NO SE OLFATEA. Cada caso tiene su código y su prosa, y cada uno se
// arregla en otro sitio: `pocos_tramos` se cierra registrando cargas con odómetro,
// `familia_distinta` corrigiendo el combustible del tipo, `tipo_bimodal` no se cierra nunca.
// Misma regla que MotivoSinRendimiento y que los bloqueos de /liquidaciones.
import { labelDeFamilia, MIN_TRAMOS_CONFIABLE } from "@/lib/rendimiento";
import { familiaCombustible } from "@/lib/combustible-tipos";

/** La medición de UNA placa, tal como la resuelve `rendimientoMedido` de lib/costeo-servicio. */
export type MedicionPlaca = {
  /** La mediana, en la unidad de `familia`. El nombre es histórico; puede ser km/m³. */
  kmGal: number;
  /** TRAMOS medidos, no cargas: 10 cargas con un hueco dan 8 tramos. */
  tramos: number;
  familia: string;
  /** `resumen.label` — "km/gal" o "km/m³". */
  label: string;
  /** `resumen.confiable` — al menos MIN_TRAMOS_CONFIABLE tramos. */
  confiable: boolean;
};

/** Lo mínimo del parámetro que hace falta para decidir. */
export type ParametroRendimiento = {
  rendimiento_1: number;
  tipo_combustible_1: string;
  tipo_combustible_2?: string | null;
  pct_uso_2?: number | null;
};

export type MotivoNoAplica =
  /** El tipo consume dos combustibles: la medición no dice cuántos km hizo con cada uno. */
  | "tipo_bimodal"
  /** Esa placa no tiene ninguna mediana (sin cargas, sin odómetro, o todo descartado). */
  | "sin_medicion"
  /** Lo medido es de otro combustible que el del parámetro (GNV contra diésel). */
  | "familia_distinta"
  /** Hay mediana, pero sobre menos tramos de los que hacen falta para fiarse. */
  | "pocos_tramos";

export type DecisionRendimiento = {
  aplica: boolean;
  /** INVARIANTE: `motivo === null` exactamente cuando `aplica === true`. */
  motivo: MotivoNoAplica | null;
  /** El número que entra a la fórmula. */
  valor: number;
  /** La unidad del PARÁMETRO, que es en la que se costea. Nunca un literal. */
  label: string;
  /** El texto del renglón del presupuesto. Ninguna pantalla lo redacta. */
  base: string;
};

/**
 * Qué rendimiento usa el presupuesto de un servicio de esta placa, y por qué ése.
 *
 * El orden de las comprobaciones va de lo ESTRUCTURAL a lo estadístico, igual que los
 * descartes de `serieRendimiento`: un tipo bimodal no va a poder usar una medición nunca,
 * así que decirlo gana sobre decir que hoy no hay cargas suficientes.
 */
export function decidirRendimiento(
  parametro: ParametroRendimiento,
  medicion: MedicionPlaca | null
): DecisionRendimiento {
  // La unidad SIEMPRE es la del parámetro: es el número con el que se costea, y cuando la
  // medición no aplica es el único que hay.
  const label = labelDeFamilia(familiaCombustible(parametro.tipo_combustible_1));
  /** Se queda el tecleado, y el renglón dice por qué. */
  const no = (motivo: MotivoNoAplica, nota?: string): DecisionRendimiento => ({
    aplica: false,
    motivo,
    valor: parametro.rendimiento_1,
    label,
    base: `${parametro.rendimiento_1} ${label} del parámetro del tipo${nota ? ` (${nota})` : ""}`,
  });

  const bimodal = !!(parametro.tipo_combustible_2 && Number(parametro.pct_uso_2) > 0);
  if (bimodal) {
    return no(
      "tipo_bimodal",
      "el tipo usa dos combustibles y la medición no dice cuántos km hizo con cada uno"
    );
  }

  if (!medicion) return no("sin_medicion");

  if (medicion.familia !== familiaCombustible(parametro.tipo_combustible_1)) {
    return no(
      "familia_distinta",
      `lo medido en esta placa es de otro combustible (${medicion.label})`
    );
  }

  if (!medicion.confiable) {
    return no(
      "pocos_tramos",
      `esta placa solo tiene ${medicion.tramos} tramo(s) medido(s); hacen falta ${MIN_TRAMOS_CONFIABLE}`
    );
  }

  return {
    aplica: true,
    motivo: null,
    valor: medicion.kmGal,
    label,
    base: `${medicion.kmGal} ${label} medido en ${medicion.tramos} tramos de esta placa`,
  };
}
