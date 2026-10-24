// lib/licitaciones/util.ts — Piezas pequeñas que comparten los motores de Licitaciones. Módulo PURO.
//
// Nada aquí decide nada del negocio: fechas, textos y formato de importes, para que normalizar,
// reglas, revisión y documento digan lo mismo del mismo dato.

import type { ClaveRecurso, FechaISO, Moneda } from "./tipos";

/** Lo que se imprime cuando falta un dato. Nunca un cero inventado. */
export const RAYA = "—";

/** ¿Es "YYYY-MM-DD" y existe en el calendario? (V8 acepta "2026-02-30" en Date.parse). */
export function esFechaISO(x: unknown): x is FechaISO {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const [a, m, d] = x.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return d <= dias;
}

/** La fecha si es válida (acepta un instante y toma su día), si no null. */
export function fechaONull(x: unknown): FechaISO | null {
  if (typeof x !== "string") return null;
  const s = x.slice(0, 10);
  return esFechaISO(s) ? s : null;
}

/** "2026-10-17" → "17/10/2026"; sin fecha → «—». */
export function fechaDMY(f: string | null | undefined): string {
  const s = fechaONull(f);
  if (!s) return RAYA;
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
}

/** "2026-10-17" → "10/2026". */
export function mesAnio(f: string | null | undefined): string {
  const s = fechaONull(f);
  if (!s) return RAYA;
  const [a, m] = s.split("-");
  return `${m}/${a}`;
}

export function anioDe(f: FechaISO): number { return Number(f.slice(0, 4)); }

/**
 * Texto apto para jsonb: sin NUL (Postgres no lo guarda) ni sustitutos sueltos (un emoji partido
 * hace que Postgres rechace el documento entero), recortado por caracteres completos. No recorta
 * espacios: un párrafo puede empezar con sangría a propósito.
 */
export function limpiarTexto(x: unknown, max: number): string {
  if (typeof x !== "string") return "";
  let s = x.replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  if (s.length > max) {
    s = s.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  }
  return s;
}

/** Texto corto (rótulos, nombres): limpio, recortado y sin espacios en los bordes. */
export function textoCorto(x: unknown, max: number): string {
  return limpiarTexto(x, max).trim();
}

/** Texto corto o null si queda vacío. */
export function textoONull(x: unknown, max: number): string | null {
  const s = textoCorto(x, max);
  return s ? s : null;
}

/** Entero en [min, max] o null. Un "12" en texto vale; un 12.5 no. */
export function enteroEn(x: unknown, min: number, max: number): number | null {
  if (x === null || x === undefined || x === "" || typeof x === "boolean") return null;
  const n = Number(x);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Número finito en [min, max] o null. */
export function numeroEn(x: unknown, min: number, max: number): number | null {
  if (x === null || x === undefined || x === "" || typeof x === "boolean") return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export const esObjeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

const RE_CLAVE = /^([pt]):([1-9]\d{0,14})$/;
/** "p:12" | "t:5" válida (misma forma que claveUnidad de lib/flota/excesos.ts) o null. */
export function claveRecurso(x: unknown): ClaveRecurso | null {
  if (typeof x !== "string") return null;
  const m = x.trim().match(RE_CLAVE);
  if (!m || !Number.isSafeInteger(Number(m[2]))) return null;
  return `${m[1]}:${Number(m[2])}` as ClaveRecurso;
}

/** Orden natural de códigos: U2 antes que U10, y los códigos vacíos al final. */
export function compararCodigo(a: string, b: string): number {
  const x = (a || "").trim(), y = (b || "").trim();
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return x.localeCompare(y, "es", { numeric: true, sensitivity: "base" });
}

/** "S/ 1,234.56" · "US$ 1,234.56". Formato fijo, sin depender del locale del equipo. */
export function fmtImporte(n: number, moneda: Moneda): string {
  const neg = n < 0;
  const [ent, dec] = Math.abs(n).toFixed(2).split(".");
  const conMiles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${moneda === "USD" ? "US$" : "S/"} ${conMiles}.${dec}`;
}

/** Días de `desde` a `hasta` por la cadena ISO (sin reloj). Igual que diasEntreFechas de documentos-estado. */
export function diasISO(desde: FechaISO, hasta: FechaISO): number {
  const a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
  const b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** Años cumplidos entre dos fechas ISO (aniversario completo). */
export function aniosCumplidos(desde: FechaISO, hasta: FechaISO): number {
  let n = anioDe(hasta) - anioDe(desde);
  if (hasta.slice(5) < desde.slice(5)) n--;
  return n;
}

/** Resta `anios` a una fecha ISO (29-02 → 28-02 si el año no es bisiesto). */
export function restarAnios(f: FechaISO, anios: number): FechaISO {
  const a = anioDe(f) - anios;
  let md = f.slice(5);
  if (md === "02-29" && !esFechaISO(`${a}-02-29`)) md = "02-28";
  return `${String(a).padStart(4, "0")}-${md}`;
}
