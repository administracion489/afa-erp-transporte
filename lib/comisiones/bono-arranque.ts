// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/bono-arranque.ts — El bono de arranque de un fijo nuevo.
//
// Regla del dueño: 30 % de la utilidad del MES 1, pagado 50 % al cobrar el mes 1 y 50 %
// al cobrar el mes 3. Si el contrato se cancela ANTES del mes 3, no se paga la 2ª parte.
//
// POR QUÉ ES UN MÓDULO APARTE DEL 10 % MENSUAL (`fijo.ts`): el 10 % se devenga cada mes
// que se cobra; el bono depende de la utilidad de UN mes (el primero) y se dispara con el
// cobro de OTROS meses (1 y 3). Son dos relojes distintos sobre el mismo contrato, y
// mezclarlos haría que un cobro del mes 3 recalculara el bono con la utilidad del 3 en
// vez de la del 1.
//
// LAS MITADES SON PARÁMETRO (`mitadesBonoArranque`), no 50/50 escrito a mano: el día que
// el dueño quiera 40/60 o tres tercios, se cambia el parámetro. Cada mitad dispara con el
// cobro de SU mes.
//
// CÓMO SE REPARTE EL BONO FRENTE AL 10 % MENSUAL (la ambigüedad del caso 7): NO se
// mezclan. En el mes 1 salen DOS líneas —`fijo_mensual` (10 % = 210) y `bono_arranque`
// 1ª mitad (315)— que suman 525. En el mes 3, otras dos —`fijo_mensual` (210) y
// `bono_arranque` 2ª mitad (315)— que suman 525. El bono es 30 % de la utilidad del
// mes 1 (630), partido en dos, y es independiente del 10 % de cada mes. El 10 % del mes 3
// sigue siendo sobre la utilidad del mes 3, no del 1.
// ──────────────────────────────────────────────────────────────────────────────

import {
  redondearCentavos,
  type ContratoFijo,
  type LineaComision,
  type ParametroComision,
} from "./tipos";
import { parametrosVigentes } from "./parametros";

/**
 * Las líneas del bono de arranque de un contrato. El bono se calcula sobre la utilidad
 * del mes 1 con el parámetro vigente a la FECHA DE COBRO del mes 1 (ahí nace el derecho),
 * y cada mitad se emite con el cobro de su mes.
 *
 * Reglas por mitad:
 *  - Mes de la mitad NO está en el contrato o no está cobrado → `pendiente_cobro` (0).
 *  - El contrato se canceló ANTES del mes de esa mitad → `bono_arranque_cancelado` (0).
 *  - Mes 1 sin presupuesto → no se puede calcular el 30 % → `retenido_falta_costear`.
 *  - Si no → `pagar` con la fracción.
 */
export function comisionarBonoArranque(
  contrato: ContratoFijo,
  parametros: readonly ParametroComision[],
  vendedorId?: string,
): LineaComision[] {
  const mes1 = contrato.meses.find((m) => m.mes === 1);
  // Sin mes 1 no hay base para el bono.
  if (!mes1) return [];

  const param = parametrosVigentes(parametros, mes1.fechaCobro);
  const lineas: LineaComision[] = [];
  const cancelado = contrato.canceladoEnMes ?? null;

  for (const mitad of param ? param.mitadesBonoArranque : []) {
    const comun = {
      regla: "bono_arranque" as const,
      base: mes1.utilidad,
      contratoId: contrato.id,
      clienteId: contrato.clienteId,
      vendedorId,
      parametroDesde: param!.vigente_desde,
    };

    // ¿Se canceló antes del mes que dispara esta mitad? (cancelar EN ese mes o después
    // no la bloquea: «cancelado ANTES del mes 3» es `cancelado < 3`.)
    if (cancelado !== null && cancelado < mitad.mes) {
      lineas.push({
        ...comun,
        codigo: "bono_arranque_cancelado",
        monto: 0,
        tasa: param!.tasaBonoArranque * mitad.fraccion,
        detalle: `Bono de arranque (mitad del mes ${mitad.mes}): contrato cancelado en el mes ${cancelado}, no se paga.`,
      });
      continue;
    }

    const mesDisparo = contrato.meses.find((m) => m.mes === mitad.mes);
    if (!mesDisparo || !mesDisparo.cobrado) {
      // Aún no se cobró el mes que dispara esta mitad: pendiente, no cancelado.
      lineas.push({
        ...comun,
        codigo: "pendiente_cobro",
        monto: 0,
        tasa: param!.tasaBonoArranque * mitad.fraccion,
        detalle: `Bono de arranque (mitad del mes ${mitad.mes}): el mes ${mitad.mes} aún no se ha cobrado.`,
        fechaCobro: mesDisparo?.fechaCobro,
      });
      continue;
    }

    const tasa = param!.tasaBonoArranque * mitad.fraccion; // 30 % × 0.5 = 0.15 de la utilidad del mes 1
    if (!mes1.tienePresupuesto) {
      lineas.push({
        ...comun,
        codigo: "retenido_falta_costear",
        monto: null,
        tasa,
        fechaCobro: mesDisparo.fechaCobro,
        detalle: `Bono de arranque (mitad del mes ${mitad.mes}): RETENIDO, falta costear el mes 1.`,
      });
      continue;
    }

    lineas.push({
      ...comun,
      codigo: "pagar",
      monto: redondearCentavos(mes1.utilidad * tasa),
      tasa,
      fechaCobro: mesDisparo.fechaCobro,
      detalle: `Bono de arranque (mitad del mes ${mitad.mes}): ${Math.round(mitad.fraccion * 100)}% de ${Math.round(param!.tasaBonoArranque * 100)}% de S/${mes1.utilidad} (utilidad del mes 1).`,
    });
  }

  return lineas;
}
