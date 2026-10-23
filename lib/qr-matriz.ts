// ──────────────────────────────────────────────────────────────────────────────
// lib/qr-matriz.ts — Los MÓDULOS de un código QR, para que el HTML (un SVG en línea) y el PDF del
// servidor (rectángulos de pdf-lib) dibujen EXACTAMENTE lo mismo. PURO: no pinta nada, no pide nada a
// la red y no arma una imagen (ni data URL): devuelve qué casillas van oscuras.
//
// Se guarda en TRAMOS por fila (columna inicial y largo de cada corrida oscura): un QR de versión 5
// son 37 × 37 = 1 369 casillas y unas 700 oscuras; en tramos son ~250 rectángulos en el PDF y un
// solo `path` corto en el SVG.
// Corrección de errores M (15 %): la del resto del ERP (lib/liquidacion-datos.ts, /pasajero).
// ──────────────────────────────────────────────────────────────────────────────

import QRCode from "qrcode";

/** Un tramo oscuro: fila, columna inicial y cuántas casillas seguidas. */
export type TramoQr = [fila: number, col: number, largo: number];

export type MatrizQr = {
  /** Casillas por lado (sin la zona de silencio). */
  tamano: number;
  tramos: TramoQr[];
};

/** Casillas blancas alrededor del código (la zona de silencio que necesitan los lectores). */
export const SILENCIO_QR = 3;

/**
 * El lado del QR de las condiciones en el documento corporativo, en px CSS (96 px ≈ 25 mm impreso),
 * con su zona de silencio. El SVG del HTML y el PDF del servidor usan el mismo.
 */
export const TAMANO_QR_PX = 96;

/** La matriz del QR de `texto`, o null si no se puede armar (vacío o demasiado largo). */
export function matrizQr(texto: string): MatrizQr | null {
  const t = String(texto ?? "");
  if (!t) return null;
  let q: ReturnType<typeof QRCode.create>;
  try { q = QRCode.create(t, { errorCorrectionLevel: "M" }); } catch { return null; }
  const n = q.modules.size;
  const tramos: TramoQr[] = [];
  for (let f = 0; f < n; f++) {
    let ini = -1;
    for (let c = 0; c <= n; c++) {
      const oscura = c < n && q.modules.get(f, c) === 1;
      if (oscura && ini < 0) ini = c;
      else if (!oscura && ini >= 0) { tramos.push([f, ini, c - ini]); ini = -1; }
    }
  }
  return { tamano: n, tramos };
}

/** ¿La casilla (fila, col) está oscura? (para la matriz: compara contra la librería). */
export function casillaOscura(m: MatrizQr, fila: number, col: number): boolean {
  return m.tramos.some(([f, c, l]) => f === fila && col >= c && col < c + l);
}
