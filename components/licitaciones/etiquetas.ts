// components/licitaciones/etiquetas.ts — Rótulos de pantalla del módulo Licitaciones. PURO (sin
// React ni base): lo usan la lista, el legajo y la experiencia, y lo puede usar el editor.
//
// Solo traduce valores cerrados de lib/licitaciones/tipos.ts a palabras y colores. Una etiqueta que
// describa al revés lo que hace el sistema es un bug: por eso los textos que salen de NÚMEROS
// (días que faltan, antigüedad) se arman aquí en un solo sitio y no dentro de cada TSX.

import type { EstadoLicitacion, InstanteISO, SustentoTipo } from "@/lib/licitaciones/tipos";
import type { TonoChip } from "./ui";

export const ESTADO_LIC: Record<EstadoLicitacion, { etiqueta: string; tono: TonoChip }> = {
  preparacion: { etiqueta: "En preparación", tono: "azul" },
  presentada: { etiqueta: "Presentada", tono: "azul" },
  adjudicada: { etiqueta: "Adjudicada", tono: "verde" },
  no_adjudicada: { etiqueta: "No adjudicada", tono: "gris" },
  desierta: { etiqueta: "Desierta", tono: "gris" },
  descartada: { etiqueta: "Descartada", tono: "gris" },
};

export const SUSTENTO_ETIQUETA: Record<SustentoTipo, string> = {
  oc: "Orden de compra",
  factura: "Factura",
  carta: "Carta de referencia",
  contrato: "Contrato",
  conformidad: "Conformidad de servicio",
  otro: "Otro",
};
export const SUSTENTOS: readonly SustentoTipo[] = ["oc", "factura", "carta", "contrato", "conformidad", "otro"];

/** «hace N días» / «en N días» / «hoy» / «mañana» / «ayer». */
export function textoDias(dias: number): string {
  if (dias === 0) return "hoy";
  if (dias === 1) return "mañana";
  if (dias === -1) return "ayer";
  return dias > 0 ? `en ${dias} días` : `hace ${-dias} días`;
}

/**
 * Lo que se dice de la fecha de presentación según el estado. Solo una licitación EN PREPARACIÓN
 * tiene una fecha por delante que importe: en las demás, la fecha es historia (gris).
 *  · en preparación y ya pasó → ámbar: o se presentó y falta cambiar el estado, o no se presentó.
 *  · en preparación y faltan ≤ 7 días → ámbar (no medido: una semana es lo que suele tomar el expediente).
 */
export const DIAS_PRESENTACION_CERCA = 7;
export function juicioPresentacion(estado: EstadoLicitacion, dias: number | null): { texto: string; tono: TonoChip } | null {
  if (dias == null) return null;
  if (estado !== "preparacion") return { texto: textoDias(dias), tono: "gris" };
  if (dias < 0) return { texto: `ya pasó (${textoDias(dias)}): ¿falta cambiar el estado?`, tono: "ambar" };
  if (dias <= DIAS_PRESENTACION_CERCA) return { texto: dias === 0 ? "se presenta hoy" : `faltan ${dias} día${dias === 1 ? "" : "s"}`, tono: "ambar" };
  return { texto: `faltan ${dias} días`, tono: "gris" };
}

/** Un instante en hora de Lima: «17/10/2026 14:32». Sin instante, «—». */
export function fmtInstante(i: InstanteISO | null | undefined): string {
  if (!i) return "—";
  const d = new Date(i);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-PE", {
    timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** «12.4 MB» · «830 KB». */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * El importe tecleado: vacío → null (un campo en blanco no es un cero). Acepta «12,500.50» (coma de
 * miles, punto decimal, como se escribe en Perú) y el símbolo de la moneda. Lo que no se entiende es
 * NaN, y validarExperiencia lo rechaza con su mensaje: nunca se adivina un número.
 */
export function leerImporte(s: string): number | null {
  const t = s.replace(/US\$|S\/\.?|\s/gi, "");
  if (!t) return null;
  // La coma solo vale como separador de MILES (grupos de tres): «12,50» es ambiguo y no se adivina.
  const bien = /^\d+(\.\d{1,2})?$/.test(t) || /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t);
  return bien ? Number(t.replace(/,/g, "")) : NaN;
}

/** Lo que acepta el selector de archivos donde el archivo va a UNIRSE a un expediente. */
export const ACCEPT_UNIBLE = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
