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
 * Abajo, el margen de una cotización, que se calcula SIN IGV en los dos lados (`margenSinIgv`).
 *
 * PURO: lo usan el formulario, la lista, el cotizador y su matriz (`scripts/prueba-igv-par.mts`).
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

// ── El margen, siempre SIN IGV en los dos lados ─────────────────────────────────────────────
//
// Lo pidió el dueño (23-10-2026). `margen_estimado` restaba el costo CON IGV de `precio_cliente`,
// y `precio_cliente` no siempre está con IGV: en una cotización eventual que NO incluye IGV es el
// subtotal SIN IGV. Ahí el margen salía corto justo en el IGV del costo, y en las demás salía con
// el IGV del precio dentro, que no es de la empresa (se le entrega a SUNAT).
//
// Sobre qué base está `precio_cliente` lo dice la propia fila, y está medido en producción
// (23-10-2026, las 716 cotizaciones, ninguna fuera de la regla):
//   - eventual que no incluye IGV → el subtotal, SIN IGV (403 filas);
//   - eventual que incluye IGV (o sin dato: la columna nace en true) → el total CON IGV (164);
//   - fija con precio/día → ese precio/día, que es CON IGV siempre (18).
// Una fija sin precio/día guarda el total de los ítems, y sigue la regla de las eventuales.
//
// La misma pregunta (`precioClienteConIgv`) sirve para LEER el margen y para ESCRIBIR un precio
// que llega con IGV (los botones del panel de precios): escribir con una base y leer con otra es
// el error que este ERP ya pagó varias veces.

/** Lo que el margen necesita de una fila de `cotizaciones`. */
export type FilaMargen = {
  modo_servicio?: string | null;
  incluye_igv?: boolean | null;
  precio_cliente?: number | string | null;
  precio_dia?: number | string | null;
  costo_estimado?: number | string | null;
};

/** ¿El `precio_cliente` de esta fila está CON IGV? */
export function precioClienteConIgv(f: FilaMargen): boolean {
  if (f.modo_servicio === "fijo" && Number(f.precio_dia) > 0) return true;
  return f.incluye_igv !== false;
}

/** Un importe positivo de la base, o null si no hay (vacío, cero, texto, negativo). */
function positivo(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** El precio SIN IGV de la fila, al céntimo; null sin precio. */
export function precioSinIgvDeFila(f: FilaMargen): number | null {
  const p = positivo(f.precio_cliente);
  if (p == null) return null;
  return precioClienteConIgv(f) ? sinIgvDe(p) : alCentimo(p);
}

/**
 * El margen SIN IGV: precio sin IGV − costo interno sin IGV, en soles y al céntimo (en una fija,
 * por día). Null sin precio o sin costo interno: sin costo no hay margen que calcular, y enseñar
 * el precio entero como margen sería un número que nadie midió.
 */
export function margenSinIgv(f: FilaMargen): number | null {
  const precio = precioSinIgvDeFila(f);
  const costo = positivo(f.costo_estimado);
  if (precio == null || costo == null) return null;
  return alCentimo(precio - sinIgvDe(costo));
}

/**
 * El `precio_cliente` que hay que escribir en esta fila para un precio que llega CON IGV: tal cual
 * si la fila guarda con IGV, sin IGV si no. Así lo que se escribe se vuelve a leer en su base.
 */
export function precioClienteDesdeConIgv(f: FilaMargen, con: number): number {
  return precioClienteConIgv(f) ? con : sinIgvDe(con);
}
