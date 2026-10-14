// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/fijo.ts — La comisión del contrato FIJO (tercerizado o propio).
//
// Regla del dueño: 10 % de la utilidad MENSUAL mientras el mes esté cobrado y dentro de
// la ventana de 12 meses. Más el bono de arranque (`bono-arranque.ts`), que se suma pero
// NO se mezcla con el 10 %: en el mes 1 salen la línea del 10 % y la 1ª mitad del bono
// por separado, y eso es lo que da el 525 del caso 7.
//
// LA VENTANA SE ANCLA EN EL PRIMER SERVICIO COBRADO (por fecha de servicio), igual que la
// del cliente nuevo. Un mes cuya fecha de servicio ya pasó la ventana no comisiona
// (`fuera_de_ventana`), que es lo que deja el mes 13 del caso 7 en cero. La ancla se
// puede pasar explícita; si no, se deriva del mínimo de fechas de servicio de los meses
// COBRADOS del propio contrato.
//
// Un mes NO cobrado no comisiona (su 10 % aún no se devengó), pero no se le pone un
// código de bloqueo: simplemente no genera línea de pago. Un mes sin presupuesto se
// retiene, igual que el eventual.
// ──────────────────────────────────────────────────────────────────────────────

import { comisionarBonoArranque } from "./bono-arranque";
import { dentroDeVentana } from "./cliente-nuevo";
import { parametrosVigentes } from "./parametros";
import {
  redondearCentavos,
  type ContratoFijo,
  type LineaComision,
  type ParametroComision,
} from "./tipos";

/** El ancla de la ventana: la fecha de servicio del primer mes COBRADO del contrato. */
export function anclaContrato(contrato: ContratoFijo): string | null {
  const cobrados = contrato.meses.filter((m) => m.cobrado);
  if (!cobrados.length) return null;
  return cobrados.reduce((min, m) => (m.fechaServicio < min ? m.fechaServicio : min), cobrados[0].fechaServicio);
}

/**
 * Las líneas del contrato fijo: el 10 % de cada mes cobrado dentro de la ventana, más el
 * bono de arranque. `anclaVentana` permite forzar la ancla (p.ej. cuando el cliente ya
 * tenía otro contrato); si no se pasa, se deriva del propio contrato.
 */
export function comisionarFijo(
  contrato: ContratoFijo,
  parametros: readonly ParametroComision[],
  vendedorId?: string,
  anclaVentana?: string | null,
): LineaComision[] {
  const lineas: LineaComision[] = [];
  const ancla = anclaVentana ?? anclaContrato(contrato);

  for (const m of contrato.meses) {
    // Un mes no cobrado aún no devenga su 10 %: no genera línea de pago.
    if (!m.cobrado) continue;

    const param = parametrosVigentes(parametros, m.fechaCobro);
    if (!param) {
      lineas.push({
        regla: "fijo_mensual",
        codigo: "sin_parametros",
        monto: null,
        base: m.utilidad,
        tasa: null,
        contratoId: contrato.id,
        clienteId: contrato.clienteId,
        vendedorId,
        fechaCobro: m.fechaCobro,
        detalle: `Fijo mes ${m.mes}: sin parámetro de comisión vigente al ${m.fechaCobro}.`,
      });
      continue;
    }

    const comun = {
      regla: "fijo_mensual" as const,
      base: m.utilidad,
      tasa: param.tasaFijo,
      contratoId: contrato.id,
      clienteId: contrato.clienteId,
      vendedorId,
      fechaCobro: m.fechaCobro,
      parametroDesde: param.vigente_desde,
    };

    // Fuera de la ventana de 12 meses (por fecha de servicio) → no comisiona.
    if (ancla && !dentroDeVentana(m.fechaServicio, ancla, param.ventanaMeses)) {
      lineas.push({
        ...comun,
        codigo: "fuera_de_ventana",
        monto: 0,
        detalle: `Fijo mes ${m.mes}: fuera de la ventana de ${param.ventanaMeses} meses (servicio ${m.fechaServicio}).`,
      });
      continue;
    }

    if (!m.tienePresupuesto) {
      lineas.push({
        ...comun,
        codigo: "retenido_falta_costear",
        monto: null,
        detalle: `Fijo mes ${m.mes}: RETENIDO, falta costear.`,
      });
      continue;
    }

    lineas.push({
      ...comun,
      codigo: "pagar",
      monto: redondearCentavos(m.utilidad * param.tasaFijo),
      detalle: `Fijo mes ${m.mes}: ${Math.round(param.tasaFijo * 100)}% de S/${m.utilidad}.`,
    });
  }

  // El bono de arranque se calcula aparte y se suma. Su 1ª mitad cae con el cobro del mes
  // 1 (dentro de la ventana por construcción) y la 2ª con el del mes 3.
  lineas.push(...comisionarBonoArranque(contrato, parametros, vendedorId));

  return lineas;
}
