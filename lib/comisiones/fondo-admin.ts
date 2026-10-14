// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/fondo-admin.ts — El fondo administrativo.
//
// Regla del dueño: S/4 por cada EVENTUAL NUEVO COBRADO del mes, repartido en partes
// IGUALES entre los operadores CORROBORADOS por el administrador. Lo paga la empresa; NO
// sale de la comisión del vendedor (por eso es su propia regla y su propio total, aparte
// de `totales.comisiones`).
//
// EL MONTO POR EVENTUAL ES PARÁMETRO CON VIGENCIA: el fondo total se acumula sumando, por
// cada eventual, el `montoFondoPorEventual` vigente a SU fecha de cobro. Para un mes con
// un solo juego de parámetros eso es `cantidad × 4` (los casos 1-3), pero sumar respeta
// la vigencia si el parámetro cambia a mitad de mes.
//
// UN EVENTUAL RETENIDO CUENTA PARA EL FONDO. El fondo es un importe plano por evento, no
// un porcentaje de la utilidad: no le importa si el servicio tiene presupuesto. El
// servicio ocurrió y se cobró, así que acumula sus S/4 aunque la comisión del vendedor
// esté retenida. (La retención es solo del vendedor; el fondo es de los operadores.)
//
// SIN OPERADORES CORROBORADOS no se reparte: se emite UNA línea con el total y código
// `fondo_pendiente_corroboracion`. Repartir entre cero sería dividir por cero; inventar un
// destinatario sería pagarle a quien el administrador no corroboró.
// ──────────────────────────────────────────────────────────────────────────────

import { redondearCentavos, type LineaComision } from "./tipos";

/** Una pieza del fondo: un eventual nuevo cobrado con el monto que le corresponde según su
 *  parámetro vigente. El motor arma esta lista; aquí solo se suma y se reparte. */
export type AporteFondo = {
  servicioId: string | number;
  montoPorEventual: number;
  fechaCobro?: string;
  parametroDesde?: string;
};

export type ResultadoFondo = {
  total: number;
  porPersona: number;
  lineas: LineaComision[];
};

/**
 * El fondo del periodo: suma los aportes y lo reparte en partes iguales entre los
 * operadores corroborados. Una línea por operador (con su parte), o una sola con el total
 * retenido si no hay operadores corroborados.
 */
export function comisionarFondo(
  aportes: readonly AporteFondo[],
  operadoresCorroborados: readonly string[],
): ResultadoFondo {
  const total = redondearCentavos(aportes.reduce((acc, a) => acc + a.montoPorEventual, 0));
  const n = operadoresCorroborados.length;

  // Sin eventuales nuevos no hay nada que repartir: ni siquiera líneas de S/0 a cada
  // operador (serían pagos vacíos en el detalle). Un mes sin eventuales nuevos no genera
  // fondo, haya o no operadores corroborados.
  if (aportes.length === 0 || total === 0) {
    return { total: 0, porPersona: 0, lineas: [] };
  }

  if (n === 0) {
    return {
      total,
      porPersona: 0,
      lineas: total > 0
        ? [
            {
              regla: "fondo_admin",
              codigo: "fondo_pendiente_corroboracion",
              monto: total,
              base: aportes.length,
              tasa: null,
              detalle: `Fondo administrativo S/${total} (${aportes.length} eventual(es) nuevo(s)): sin operadores corroborados, pendiente de repartir.`,
            },
          ]
        : [],
    };
  }

  const porPersona = redondearCentavos(total / n);
  const lineas: LineaComision[] = operadoresCorroborados.map((op) => ({
    regla: "fondo_admin",
    codigo: "pagar",
    monto: porPersona,
    base: aportes.length,
    tasa: null,
    operadorId: op,
    detalle: `Fondo administrativo: S/${porPersona} (S/${total} entre ${n} operador(es), ${aportes.length} eventual(es) nuevo(s)).`,
  }));
  return { total, porPersona, lineas };
}
