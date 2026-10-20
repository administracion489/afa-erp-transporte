// ──────────────────────────────────────────────────────────────────────────────
// lib/pdf-winansi.ts — Texto que cabe en las fuentes estándar de un PDF (Helvetica, WinAnsi). PURO.
//
// pdf-lib LANZA con un carácter que WinAnsi no tiene (un emoji, una flecha), y en los PDF del
// servidor ese texto lo escribe a veces el cliente. Todo texto pasa por aquí con el juego de
// caracteres de la propia fuente (`font.getCharacterSet()`) antes de medirlo o dibujarlo.
// Lo usan el PDF corporativo (lib/pdf-corporativo.ts) y sus pruebas.
// ──────────────────────────────────────────────────────────────────────────────

/** Lo que las fuentes estándar no tienen y tiene un equivalente legible. */
const EQUIVALENTES: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇄": "<->", "⇒": "=>", "➜": "->", "➡": "->",
  "≥": ">=", "≤": "<=", "≠": "!=", "×": "x", "−": "-", "‐": "-", "‑": "-", "‒": "-",
  "✓": "", "✔": "", "✗": "", "✘": "",
};

/**
 * El texto con SOLO los caracteres que la fuente puede dibujar (`font.getCharacterSet()`): pdf-lib
 * LANZA con un carácter que WinAnsi no tiene (un emoji, una flecha), y ese texto lo escribe el
 * cliente. Conserva tildes, ñ, «», °, · y €; cambia flechas y signos por su equivalente; quita el
 * resto. Los saltos y tabulaciones pasan a espacio (el dibujo parte las líneas). Con `max`, corta
 * por caracteres completos y termina en «…».
 */
export function aWinAnsi(texto: string, permitidos: ReadonlySet<number>, max?: number): string {
  const base = String(texto ?? "").normalize("NFC").replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ");
  let out = "";
  for (const ch of Array.from(base)) {
    const eq = EQUIVALENTES[ch];
    const cand = eq !== undefined ? eq : ch;
    for (const c of Array.from(cand)) {
      const cp = c.codePointAt(0)!;
      if (permitidos.has(cp)) out += c;
    }
  }
  out = out.replace(/ {2,}/g, " ").trim();
  if (max != null && max > 0) {
    const cps = Array.from(out);
    if (cps.length > max) {
      const elipsis = permitidos.has(0x2026) ? "…" : "...";
      out = cps.slice(0, Math.max(0, max - Array.from(elipsis).length)).join("").trimEnd() + elipsis;
    }
  }
  return out;
}

