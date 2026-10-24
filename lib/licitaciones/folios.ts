// lib/licitaciones/folios.ts — El ÚNICO mapa de folios del expediente y cómo se escribe un folio. PURO y sin
// dependencias: lo importan el foliado del PDF (pdf/expediente.ts, que lo re-exporta), la emisión y la pantalla
// del paso Expediente, que así no carga pdf-lib para enseñar «Folio 001».
import type { OpcionesFoliado } from "./tipos";

/** «Folio {n}» con el número relleno a `digitos` («Folio 001»). Sin «{n}» el número va al final. */
export function textoFolio(formato: string, n: number, digitos: number): string {
  const d = Number.isFinite(digitos) ? Math.max(1, Math.min(8, Math.floor(digitos))) : 3;
  const num = String(Math.max(0, Math.floor(n))).padStart(d, "0");
  const fmt = String(formato ?? "").trim();
  if (!fmt) return num;
  return fmt.includes("{n}") ? fmt.split("{n}").join(num) : `${fmt} ${num}`;
}

/** «001–012» para la relación de adjuntos (ancho fijo); un rango vacío ({0, 0}) → «—». */
export function textoRangoFolios(r: { desde: number; hasta: number }, digitos: number): string {
  if (!r || !r.desde || !r.hasta) return "—";
  const d = Number.isFinite(digitos) ? Math.max(1, Math.min(8, Math.floor(digitos))) : 3;
  return `${String(r.desde).padStart(d, "0")}–${String(r.hasta).padStart(d, "0")}`;
}

export type MapaFolios = {
  /** Folio de la PRIMERA y de la ÚLTIMA página foliada de cada bloque (en descendente, desde > hasta). {0, 0} = el bloque no lleva folio. */
  porBloque: { desde: number; hasta: number }[];
  /** Cuántas páginas llevan folio (= el folio más alto). */
  total: number;
  /** Folio de la página `pagina` (1-based dentro del bloque); null = no lleva folio o no existe. */
  folioDePagina: (bloque: number, pagina: number) => number | null;
  /** Los folios de todas las páginas de un bloque, en orden (para `foliar` el PDF suelto del bloque). */
  foliosDeBloque: (bloque: number) => (number | null)[];
  /** Los folios de todas las páginas de todos los bloques, en orden (para `foliar` el completo). */
  todos: (number | null)[];
};

/**
 * EL mapa de folios (D13): lo usan el expediente completo, los bloques sueltos, el índice y la
 * relación de adjuntos. Ascendente: 1..N en el orden de lectura. Descendente: N..1 (la primera hoja
 * lleva el número más alto, como en las licitaciones del Estado peruano). Con `foliarPortadas`
 * false, la primera página de cada bloque cuya `paginasPortada[b]` sea true no lleva folio ni
 * consume número. Modo «ninguno»: todo null. PURO.
 */
export function mapaFolios(paginasPorBloque: number[], op: OpcionesFoliado, opts: { paginasPortada?: boolean[] } = {}): MapaFolios {
  const n = (paginasPorBloque ?? []).map((p) => (Number.isFinite(p) && p > 0 ? Math.floor(p) : 0));
  const portada = opts.paginasPortada ?? [];
  const foliable = n.map((cant, b) => Array.from({ length: cant }, (_, i) =>
    op.modo !== "ninguno" && !(i === 0 && portada[b] === true && !op.foliarPortadas)));
  const total = foliable.reduce((a, arr) => a + arr.filter(Boolean).length, 0);
  let k = 0;
  const folios: (number | null)[][] = foliable.map((arr) => arr.map((f) => {
    if (!f) return null;
    k++;
    return op.modo === "descendente" ? total - k + 1 : k;
  }));
  const porBloque = folios.map((arr) => {
    const xs = arr.filter((v): v is number => v != null);
    return xs.length ? { desde: xs[0], hasta: xs[xs.length - 1] } : { desde: 0, hasta: 0 };
  });
  const todos: (number | null)[] = [];
  for (const arr of folios) for (const v of arr) todos.push(v);
  return {
    porBloque,
    total,
    folioDePagina: (b, p) => (Number.isInteger(b) && Number.isInteger(p) ? folios[b]?.[p - 1] ?? null : null),
    foliosDeBloque: (b) => [...(folios[b] ?? [])],
    todos,
  };
}
