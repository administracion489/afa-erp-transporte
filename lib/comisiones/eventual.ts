// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/eventual.ts — La comisión del servicio EVENTUAL, por tramo.
//
// Regla del dueño: 20 % de la utilidad en los servicios 1–30 del mes, 12 % del 31 en
// adelante. El contador REINICIA cada mes. El orden dentro del mes es por fecha de cobro
// y, a igualdad, por id (para que el resultado no dependa de cómo llegaron las filas).
//
// ESTE MOTOR RECIBE YA FILTRADO lo elegible (cobrado ∧ cliente nuevo ∧ dentro de
// ventana): esa compuerta vive en `motor.ts`, que es quien conoce al cliente. Aquí solo
// se ordena, se cuenta la posición y se aplica el tramo del parámetro vigente en la
// fecha de cobro de CADA servicio.
//
// EL `retenido` OCUPA POSICIÓN. Un eventual sin presupuesto es un servicio REAL, nuevo y
// cobrado: ocurrió y ocupa su lugar en la fila del mes. Lo único que se retiene es el
// MONTO (la utilidad puede estar inflada). Si no ocupara posición, costear un servicio
// atrasado correría a todos los de abajo de tramo y les cambiaría la comisión ya pagada.
// Por eso cuenta para la posición y para el fondo (ver `fondo-admin.ts`), y solo su
// monto queda en `null`. Decisión documentada: el dueño pidió «retener y avisar, nunca
// pagar de más», y mover posiciones ya pagadas sería pagar distinto, no retener.
// ──────────────────────────────────────────────────────────────────────────────

import { mesDe } from "./calendario";
import { parametrosVigentes } from "./parametros";
import {
  redondearCentavos,
  type LineaComision,
  type ParametroComision,
  type ServicioEventual,
  type Tramo,
} from "./tipos";

/** La tasa del tramo para una posición 1-based. Los tramos vienen en orden ascendente de
 *  `hasta`, con un `hasta: null` al final que recoge el resto. */
export function tasaDeTramo(tramos: readonly Tramo[], posicion: number): number {
  for (const t of tramos) {
    if (t.hasta === null || posicion <= t.hasta) return t.tasa;
  }
  // Defensivo: si faltara el `hasta: null`, el último tramo recoge el resto.
  return tramos.length ? tramos[tramos.length - 1].tasa : 0;
}

/** El criterio de orden dentro del mes: fecha de cobro, y a igualdad, id. Uno solo, para
 *  que nadie lo redefina distinto en otro sitio. */
function ordenar(a: ServicioEventual, b: ServicioEventual): number {
  if (a.fechaCobro !== b.fechaCobro) return a.fechaCobro < b.fechaCobro ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * Comisiona un conjunto de eventuales YA ELEGIBLES. Agrupa por mes de cobro, ordena,
 * asigna posición y tramo, y emite una línea por servicio. El vendedor y el cliente se
 * copian a la traza; `vendedorId` es opcional porque el motor lo puede setear después.
 */
export function comisionarEventuales(
  elegibles: readonly ServicioEventual[],
  parametros: readonly ParametroComision[],
  vendedorId?: string,
): LineaComision[] {
  // Agrupar por mes de la fecha de cobro — el contador reinicia cada mes.
  const porMes = new Map<string, ServicioEventual[]>();
  for (const s of elegibles) {
    const m = mesDe(s.fechaCobro);
    (porMes.get(m) ?? porMes.set(m, []).get(m)!).push(s);
  }

  const lineas: LineaComision[] = [];
  for (const [, servicios] of porMes) {
    const ordenados = [...servicios].sort(ordenar);
    let posicion = 0;
    for (const s of ordenados) {
      posicion += 1;
      const param = parametrosVigentes(parametros, s.fechaCobro);
      if (!param) {
        lineas.push({
          regla: "eventual",
          codigo: "sin_parametros",
          monto: null,
          base: s.utilidad,
          tasa: null,
          servicioId: s.id,
          clienteId: s.clienteId,
          vendedorId,
          fechaCobro: s.fechaCobro,
          posicion,
          detalle: `Sin parámetro de comisión vigente al ${s.fechaCobro}.`,
        });
        continue;
      }
      const tasa = tasaDeTramo(param.tramosEventual, posicion);
      const comun = {
        regla: "eventual" as const,
        base: s.utilidad,
        tasa,
        servicioId: s.id,
        clienteId: s.clienteId,
        vendedorId,
        fechaCobro: s.fechaCobro,
        posicion,
        parametroDesde: param.vigente_desde,
      };
      if (!s.tienePresupuesto) {
        // Retenido: ocupa posición, pero no se emite monto porque la utilidad puede
        // estar inflada. Se avisa, no se paga de más.
        lineas.push({
          ...comun,
          codigo: "retenido_falta_costear",
          monto: null,
          detalle: `Eventual #${s.id} (posición ${posicion}, ${Math.round(tasa * 100)}%): RETENIDO, falta costear el servicio.`,
        });
      } else {
        lineas.push({
          ...comun,
          codigo: "pagar",
          monto: redondearCentavos(s.utilidad * tasa),
          detalle: `Eventual #${s.id} (posición ${posicion}): ${Math.round(tasa * 100)}% de S/${s.utilidad}.`,
        });
      }
    }
  }
  return lineas;
}
