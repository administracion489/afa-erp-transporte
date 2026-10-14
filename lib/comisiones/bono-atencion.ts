// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/bono-atencion.ts — El bono de atención (≤ S/150), 7 indicadores.
//
// Regla del dueño: 7 indicadores TODO-O-NADA. Cada indicador cumplido suma su valor; el
// total topa en `topeBonoAtencion` (S/150). «Un mes sin eventos de un indicador =
// cumplido» — o sea, cada indicador se da por cumplido salvo que tenga un evento que lo
// rompa. El beneficio de la duda es a favor del vendedor.
//
// LOS CUATRO TIPOS DE INDICADOR, Y LO QUE LOS ROMPE:
//
//   · `generico` (documentación, precios, registros…): lo rompe CUALQUIER evento (un
//     error de documentación, un precio mal puesto). `eventos === 0` → cumplido.
//
//   · `rapidez`: cumplido si la fracción de respuestas en plazo ≥ `toleranciaRapidez`
//     (0.90). Sin respuestas registradas (un mes sin eventos) → cumplido. El «en plazo»
//     se mide en HORAS HÁBILES aguas arriba (ver `calendario.ts`); aquí llega contado.
//
//   · `reclamo`: lo rompe un reclamo SOLO si es `grave ∧ fundado ∧ atribuible_vendedor`.
//     Un reclamo leve, infundado o no atribuible al vendedor NO lo rompe.
//
//   · `cancelacion`: la rompe una cancelación SOLO si es `evitable ∧ constancia_escrita`.
//
// LA REGLA QUE SE PAGA ANTE LA DUDA: «reclamo/cancelación SIN clasificar al cierre =
// cumplido (se paga)». Por eso la rotura exige los flags EXACTAMENTE en `true`. Un flag
// `null` (sin clasificar) o `undefined` no rompe — la comparación `=== true` falla y el
// indicador queda cumplido. Esto es lo que fija la invariante `grave ∧ fundado ∧
// atribuible` rompe pero `grave ∧ fundado ∧ ¬atribuible` no.
// ──────────────────────────────────────────────────────────────────────────────

import { redondearCentavos, type LineaComision } from "./tipos";

/** Un reclamo clasificado (o a medio clasificar: los flags pueden ser `null`). */
export type Reclamo = {
  grave?: boolean | null;
  fundado?: boolean | null;
  atribuible?: boolean | null;
};

/** Una cancelación clasificada (o a medio clasificar). */
export type Cancelacion = {
  evitable?: boolean | null;
  constancia_escrita?: boolean | null;
};

/** Un indicador del bono, con su valor en soles y los datos que deciden si se cumplió. */
export type Indicador =
  | { clave: string; valor: number; tipo: "generico"; eventos: number }
  | { clave: string; valor: number; tipo: "rapidez"; atendidos: number; enPlazo: number }
  | { clave: string; valor: number; tipo: "reclamo"; reclamos: readonly Reclamo[] }
  | { clave: string; valor: number; tipo: "cancelacion"; cancelaciones: readonly Cancelacion[] };

export type IndicadorEvaluado = {
  clave: string;
  valor: number;
  cumplido: boolean;
  /** Por qué no se cumplió (para la traza). `null` cuando se cumplió. */
  motivo: string | null;
};

/** ¿Se cumplió este indicador? */
export function cumpleIndicador(ind: Indicador, toleranciaRapidez: number): IndicadorEvaluado {
  const base = { clave: ind.clave, valor: ind.valor };
  switch (ind.tipo) {
    case "generico": {
      const ok = ind.eventos === 0;
      return { ...base, cumplido: ok, motivo: ok ? null : `${ind.eventos} evento(s)` };
    }
    case "rapidez": {
      // Sin respuestas registradas se da por cumplido (mes sin eventos).
      const ratio = ind.atendidos === 0 ? 1 : ind.enPlazo / ind.atendidos;
      const ok = ratio >= toleranciaRapidez;
      return {
        ...base,
        cumplido: ok,
        motivo: ok ? null : `${ind.enPlazo}/${ind.atendidos} en plazo (< ${Math.round(toleranciaRapidez * 100)}%)`,
      };
    }
    case "reclamo": {
      const rompe = ind.reclamos.find(
        (r) => r.grave === true && r.fundado === true && r.atribuible === true,
      );
      return {
        ...base,
        cumplido: !rompe,
        motivo: rompe ? "reclamo grave, fundado y atribuible al vendedor" : null,
      };
    }
    case "cancelacion": {
      const rompe = ind.cancelaciones.find(
        (c) => c.evitable === true && c.constancia_escrita === true,
      );
      return {
        ...base,
        cumplido: !rompe,
        motivo: rompe ? "cancelación evitable con constancia escrita" : null,
      };
    }
  }
}

export type ResultadoBonoAtencion = {
  monto: number;
  evaluados: IndicadorEvaluado[];
  linea: LineaComision;
};

/**
 * El bono de atención del mes: suma el valor de los indicadores cumplidos y topa en
 * `tope`. Devuelve una sola línea de comisión (el bono es uno por vendedor/mes), con el
 * detalle de qué indicadores fallaron en la traza.
 */
export function comisionarBonoAtencion(
  indicadores: readonly Indicador[],
  tope: number,
  toleranciaRapidez: number,
  vendedorId?: string,
  parametroDesde?: string,
): ResultadoBonoAtencion {
  const evaluados = indicadores.map((i) => cumpleIndicador(i, toleranciaRapidez));
  const suma = evaluados.reduce((acc, e) => acc + (e.cumplido ? e.valor : 0), 0);
  const monto = redondearCentavos(Math.min(suma, tope));
  const fallidos = evaluados.filter((e) => !e.cumplido);
  const detalle = fallidos.length
    ? `Bono de atención: S/${monto}. Falló: ${fallidos.map((f) => `${f.clave} (${f.motivo})`).join("; ")}.`
    : `Bono de atención: S/${monto} (los ${evaluados.length} indicadores cumplidos).`;

  return {
    monto,
    evaluados,
    linea: {
      regla: "bono_atencion",
      codigo: "pagar",
      monto,
      base: suma,
      tasa: null,
      vendedorId,
      parametroDesde,
      detalle,
    },
  };
}
