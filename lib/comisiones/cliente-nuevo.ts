// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/cliente-nuevo.ts — ¿Este cliente comisiona, y hasta cuándo?
//
// Toda la política de comisiones existe para premiar al vendedor que trae un cliente
// NUEVO. Un cliente ya establecido no comisiona, por eso `esClienteNuevo` es la puerta
// de entrada y `dentroDeVentana` la de salida.
//
// DOS VENTANAS DISTINTAS, Y CONFUNDIRLAS ROMPE LOS CASOS 9-11:
//
//   · ENTRADA (`esClienteNuevo`): se mide hacia ATRÁS desde la fecha de la COTIZACIÓN.
//     Nuevo = no está en la lista firmada ∧ no tuvo servicio en los 12 meses previos a
//     la cotización. La ventana de atrás se mide por FECHA DE SERVICIO.
//
//   · SALIDA (`dentroDeVentana`): se mide hacia ADELANTE desde el PRIMER SERVICIO
//     COBRADO. El cliente deja de comisionar a los `ventanaMeses` del primer servicio
//     cobrado, también por FECHA DE SERVICIO. Medio-abierta: [ancla, ancla+N meses).
//
// Las dos son por FECHA DE SERVICIO (no de cobro) porque lo que mide la antigüedad de la
// relación es cuándo se le prestó el servicio, no cuándo pagó.
// ──────────────────────────────────────────────────────────────────────────────

import { sumarMeses } from "./calendario";

export type ContextoCliente = {
  /** ¿Está en la lista firmada de clientes ya existentes? Si sí, nunca es nuevo. */
  enListaFirmada: boolean;
  /** Fechas de servicio ("YYYY-MM-DD") de sus servicios ANTERIORES a la cotización. */
  fechasServicioPrevias: readonly string[];
  /** "YYYY-MM-DD" de la cotización con la que se evalúa la novedad del cliente. */
  fechaCotizacion: string;
  /** Fecha de servicio del primer servicio COBRADO, el ancla de la ventana de salida.
   *  Si no se pasa, el motor la deriva del mínimo entre los servicios cobrados. */
  primerServicioCobradoFecha?: string | null;
};

export type VeredictoClienteNuevo = {
  nuevo: boolean;
  /** Por qué NO es nuevo (para la traza). `null` cuando sí lo es. */
  motivo: "en_lista" | "servicio_reciente" | null;
};

/**
 * ¿Es cliente nuevo a la fecha de la cotización?
 *  - En lista firmada → NO (motivo `en_lista`).
 *  - Con algún servicio en [cotización − `ventanaMeses`, cotización) → NO (`servicio_reciente`).
 *  - Si no → SÍ.
 */
export function esClienteNuevo(ctx: ContextoCliente, ventanaMeses: number): VeredictoClienteNuevo {
  if (ctx.enListaFirmada) return { nuevo: false, motivo: "en_lista" };
  const desde = sumarMeses(ctx.fechaCotizacion, -ventanaMeses);
  const reciente = ctx.fechasServicioPrevias.some(
    (f) => f >= desde && f < ctx.fechaCotizacion,
  );
  if (reciente) return { nuevo: false, motivo: "servicio_reciente" };
  return { nuevo: true, motivo: null };
}

/** Fin de la ventana de comisión: `ancla` + `ventanaMeses` (exclusivo). Servicios con
 *  fecha de servicio ESTRICTAMENTE menor comisionan; en esa fecha o después, no. */
export function finVentana(ancla: string, ventanaMeses: number): string {
  return sumarMeses(ancla, ventanaMeses);
}

/** ¿La fecha de servicio cae dentro de la ventana que arranca en `ancla`? */
export function dentroDeVentana(
  fechaServicio: string,
  ancla: string,
  ventanaMeses: number,
): boolean {
  return fechaServicio < finVentana(ancla, ventanaMeses);
}
