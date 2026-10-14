// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/parametros.ts — El parámetro vigente en una fecha.
//
// «Parámetros con vigencia por fecha: cada cálculo usa los vigentes en la fecha de
// cobro» (regla del dueño). El día que el 20 % pasa a 18 % se agrega una fila con su
// `vigente_desde`; los cobros anteriores a esa fecha siguen calculándose con el juego
// viejo, igual que `config_laboral_regimen` y las tasas de detracción del ERP. Un
// cálculo no se vuelve a mover porque alguien cambió un parámetro el mes siguiente.
// ──────────────────────────────────────────────────────────────────────────────

import type { ParametroComision } from "./tipos";

/**
 * El parámetro vigente en `fecha`: el de mayor `vigente_desde` que no sea posterior a
 * `fecha`. Devuelve `null` cuando ninguno rige todavía (no se inventa uno) — el motor lo
 * traduce a una línea con código `sin_parametros`, nunca a un monto adivinado.
 */
export function parametrosVigentes(
  lista: readonly ParametroComision[],
  fecha: string,
): ParametroComision | null {
  let elegido: ParametroComision | null = null;
  for (const p of lista) {
    if (p.vigente_desde <= fecha) {
      if (!elegido || p.vigente_desde > elegido.vigente_desde) elegido = p;
    }
  }
  return elegido;
}
