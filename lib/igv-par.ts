/**
 * Un importe que se puede teclear SIN o CON IGV, y su par calculado.
 *
 * Lo pidió el dueño en el formulario de /cotizaciones (23-10-2026): el «Costo interno S/» no decía
 * si era con IGV o sin él, y el «Precio/día confirmado» solo se podía escribir con IGV. Cada uno
 * pasa a ser un PAR de campos: se escribe el que se tenga a mano y el otro se calcula.
 *
 * La fila guarda UN solo número por importe, y es el CON IGV: `cotizaciones.precio_dia` lo fue
 * siempre, y `cotizaciones.costo_estimado` lo es por definición del dueño (lo tecleaban así los
 * operadores: 309 de los 311 costos guardados hasta hoy). El campo sin IGV no se guarda: se
 * DERIVA del con IGV al pintarse, y al escribirse se convierte a con IGV antes de guardar. Así hay
 * una sola fila autoritativa y los dos campos nunca pueden decir cosas distintas.
 *
 * Los dos sentidos redondean al céntimo con `alCentimo`, el mismo redondeo del total impreso y
 * del adelanto. Ida y vuelta devuelven el número tecleado: el error del primer redondeo es
 * ≤ 0.005 y al dividir entre 1.18 queda en ≤ 0.0043, que no alcanza para mover el céntimo.
 *
 * PURO: lo usan el formulario y su matriz (`scripts/prueba-igv-par.mts`).
 */

import { alCentimo } from "./cotizacion-moneda";

/** La tasa del IGV con que el formulario de cotizaciones calcula (la misma `IGV` de la página). */
export const TASA_IGV = 0.18;

/** El importe con IGV de uno sin IGV, al céntimo. */
export function conIgvDe(sin: number): number {
  return alCentimo(sin * (1 + TASA_IGV));
}

/** El importe sin IGV de uno con IGV, al céntimo. */
export function sinIgvDe(con: number): number {
  return alCentimo(con / (1 + TASA_IGV));
}

/**
 * Un texto de campo como importe utilizable: un número finito y no negativo. Vacío, «-», «1e» o
 * un negativo no son un importe, y el par queda VACÍO en vez de mostrar un cero que nadie escribió.
 */
function importeDe(texto: string): number | null {
  const t = String(texto ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** El texto del campo CON IGV que corresponde a lo tecleado en el campo SIN IGV. */
export function textoConDesdeSin(sin: string): string {
  const n = importeDe(sin);
  return n == null ? "" : String(conIgvDe(n));
}

/** El texto del campo SIN IGV que corresponde a lo guardado en el campo CON IGV. */
export function textoSinDesdeCon(con: string): string {
  const n = importeDe(con);
  return n == null ? "" : String(sinIgvDe(n));
}

/**
 * Un importe guardado, listo para el campo: al céntimo y sin la cola de coma flotante
 * («352.23955799999993» → «352.24»). Vacío si no hay importe.
 */
export function textoImporte(valor: unknown): string {
  const n = Number(valor);
  return valor == null || valor === "" || !Number.isFinite(n) || n === 0 ? "" : String(alCentimo(n));
}
