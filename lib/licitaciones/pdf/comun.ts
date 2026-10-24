// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/pdf/comun.ts — Las piezas de dibujo (pdf-lib) que comparten la PROPUESTA
// TÉCNICA (pdf/propuesta.ts) y el EXPEDIENTE (pdf/expediente.ts). PURO e ISOMÓRFICO: corre en el
// navegador (la emisión se arma ahí, D10) y en node (las matrices). No lee la base, no hace fetch,
// no toca window: recibe bytes y devuelve bytes.
//
// QUÉ HAY AQUÍ, para quien escriba otro PDF del módulo:
//  · GEOMETRÍA: A4 en PUNTOS (72 por pulgada), márgenes, dónde empieza y termina el cuerpo de cada
//    hoja, dónde va la línea de la cabecera y la del pie (`GEOMETRIA_LIC`). Todo el módulo dibuja
//    con «distancia desde ARRIBA» (top) y convierte a la coordenada de pdf-lib (origen ABAJO) al
//    final, en un solo sitio (`Lienzo.texto`, `Lienzo.rect`…).
//  · TEXTO: `limpiar` (aWinAnsi: Helvetica no tiene ✓, →, ≥ ni emojis, y pdf-lib LANZA con ellos),
//    `trozosNegrita` (**negrita**, propio: NO depende de lib/licitaciones/texto.ts), `renglones`
//    (parte un texto rico en renglones que caben en un ancho; una palabra enorme se corta por
//    letras), `recortarConElipsis`. Los anchos se miden SIN interletraje (`anchoTexto`): pdf-lib
//    mide con kerning pero DIBUJA sin él, y medir con kerning dejaba los textos unas décimas más
//    anchos que lo medido — o sea, fuera del margen.
//  · IMÁGENES: `incrustarImagen` mira la FIRMA de los bytes (formatoPorFirma) antes de pasarlos a
//    pdf-lib: un PNG declarado JPEG se incrusta como PNG; lo que no es PNG ni JPEG, o lo que pdf-lib
//    no puede leer, devuelve null. Nunca lanza.
//  · `Lienzo`: el cursor de maquetación (hojas, `y`, salto de hoja) con los bloques partibles que
//    sirven a los dos PDF: párrafo justificado, lista con sangría francesa, tabla (repite la fila
//    de cabecera en cada hoja, nunca parte una fila, recorta con «…» la celda que no cabe en una
//    hoja entera y lo DICE en `recortes`), nota en recuadro, figura con pie («imagen no disponible»
//    si falta), bloque de firma. Y, después de maquetar, cabecera + pie («Página X de Y») y la marca
//    de agua en cada hoja.
//  · TRAZA (`TrazaLic`, lib/licitaciones/tipos.ts): cada texto dibujado, en orden, con su hoja
//    (1 = la primera hoja de ESTE PDF), su zona y su caja: `x` y `ancho` en puntos desde la
//    izquierda; `y` es la LÍNEA BASE en la coordenada de pdf-lib (puntos desde ABAJO). Con eso la
//    matriz comprueba márgenes, cabeceras repetidas y números de página sin un lector de PDF.
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { aWinAnsi } from "../../pdf-winansi";
import { formatoPorFirma } from "../../traslados/fotos-categoria";
import type { ImagenPdf } from "../../pdf-corporativo";
import type { TrazaLic } from "../tipos";

export type { ImagenPdf };
export type ZonaTraza = TrazaLic["zona"];

// ══ Geometría (puntos) ═════════════════════════════════════════════════════════

export const A4 = { ancho: 595.28, alto: 841.89 } as const;
/** 2 cm a cada lado (como un documento de Word): ancho útil ≈ 482 pt. */
export const MARGEN_X = 56.69;
export const ANCHO_UTIL = A4.ancho - 2 * MARGEN_X;
/** Distancias desde ARRIBA de la hoja. */
export const GEOMETRIA_LIC = {
  ancho: A4.ancho,
  alto: A4.alto,
  margenX: MARGEN_X,
  anchoUtil: ANCHO_UTIL,
  /** Borde superior del logo y del texto de la cabecera. */
  cabeceraDesde: 24,
  /** Línea bajo la cabecera. */
  lineaCabecera: 60,
  /** Donde empieza el cuerpo de cada hoja (salvo la portada). */
  cuerpoDesde: 78,
  /** Donde termina el cuerpo: ningún renglón del cuerpo baja de aquí. */
  cuerpoHasta: A4.alto - 64,
  /** Línea sobre el pie. */
  lineaPie: A4.alto - 52,
  /** Línea base del texto del pie. */
  basePie: A4.alto - 38,
} as const;

// ══ Colores ════════════════════════════════════════════════════════════════════

/** Respaldo neutro (no es el color de ninguna empresa). */
export const COLOR_RESPALDO = "#1f4e79";

/** «#RRGGBB» → RGB. Un valor que no tiene esa forma cae al respaldo (y si el respaldo tampoco, al neutro). */
export function colorDe(hex: string | null | undefined, respaldo: string = COLOR_RESPALDO): RGB {
  const valido = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim());
  const s = (valido(hex) ? hex.trim() : valido(respaldo) ? respaldo.trim() : COLOR_RESPALDO).slice(1);
  return rgb(parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255);
}
/** Mezcla con blanco: t = 0 deja el color, t = 1 es blanco. */
export function aclarar(c: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return rgb(c.red + (1 - c.red) * k, c.green + (1 - c.green) * k, c.blue + (1 - c.blue) * k);
}
/** Mezcla con negro: t = 0 deja el color, t = 1 es negro. */
export function oscurecer(c: RGB, t: number): RGB {
  const k = 1 - Math.max(0, Math.min(1, t));
  return rgb(c.red * k, c.green * k, c.blue * k);
}
export const BLANCO = rgb(1, 1, 1);
export const TINTA = colorDe("#1a1a1a");
export const GRIS_TEXTO = colorDe("#5b6470");
export const GRIS_BORDE = colorDe("#c5ccd5");
export const GRIS_CEBRA = colorDe("#f3f5f8");

// ══ Fuentes y texto ════════════════════════════════════════════════════════════

export type Fuentes = { reg: PDFFont; neg: PDFFont; ita: PDFFont; negIta: PDFFont; juego: ReadonlySet<number> };

/** Las cuatro Helvetica estándar (no se incrusta ningún archivo de fuente) y su juego de caracteres. */
export async function cargarFuentes(doc: PDFDocument): Promise<Fuentes> {
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const neg = await doc.embedFont(StandardFonts.HelveticaBold);
  const ita = await doc.embedFont(StandardFonts.HelveticaOblique);
  const negIta = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  return { reg, neg, ita, negIta, juego: new Set(reg.getCharacterSet()) };
}

/** Un renglón suelto (sin saltos) con solo lo que la fuente puede dibujar. Con `max`, corta con «…». */
export function limpiar(texto: unknown, juego: ReadonlySet<number>, max?: number): string {
  return aWinAnsi(String(texto ?? ""), juego, max);
}

const anchosCache = new WeakMap<PDFFont, Map<string, number>>();
/**
 * Ancho de un texto YA limpio, en puntos, como lo DIBUJA pdf-lib: suma de los anchos de cada
 * glifo, sin interletraje (widthOfTextAtSize lo suma y drawText no lo aplica).
 */
export function anchoTexto(fuente: PDFFont, texto: string, tam: number): number {
  let c = anchosCache.get(fuente);
  if (!c) { c = new Map(); anchosCache.set(fuente, c); }
  let total = 0;
  for (const ch of texto) {
    let w = c.get(ch);
    if (w === undefined) { w = fuente.widthOfTextAtSize(ch, 1000); c.set(ch, w); }
    total += w;
  }
  return (total * tam) / 1000;
}

export type TrozoTexto = { texto: string; negrita: boolean };

/**
 * Los tramos de un texto con **negrita**. Una marca `**` sin cerrar se deja como texto (no pone en
 * negrita todo lo que sigue); dos tramos seguidos del mismo estilo se juntan; los vacíos se quitan.
 */
export function trozosNegrita(texto: string): TrozoTexto[] {
  const s = String(texto ?? "");
  const out: TrozoTexto[] = [];
  const push = (t: string, negrita: boolean) => {
    if (!t) return;
    const u = out[out.length - 1];
    if (u && u.negrita === negrita) u.texto += t;
    else out.push({ texto: t, negrita });
  };
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf("**", i);
    if (a < 0) { push(s.slice(i), false); break; }
    const b = s.indexOf("**", a + 2);
    if (b < 0) { push(s.slice(i), false); break; }
    push(s.slice(i, a), false);
    push(s.slice(a + 2, b), true);
    i = b + 2;
  }
  return out;
}

/** Una palabra (o trozo de palabra) de un renglón, con su fuente y su desplazamiento desde el inicio. */
export type Pieza = { texto: string; fuente: PDFFont; dx: number; ancho: number; espacio: boolean };
/** `fin`: último renglón de su párrafo (antes de un salto o al final): no se justifica. */
export type Renglon = { piezas: Pieza[]; ancho: number; fin: boolean };
export type EstiloTexto = {
  /** Todo en negrita (la cabecera de una tabla). */
  negrita?: boolean;
  italica?: boolean;
  /** Interpreta **negrita** (por defecto sí). */
  marcas?: boolean;
};

export function fuenteDe(f: Fuentes, negrita: boolean, italica: boolean): PDFFont {
  return negrita ? (italica ? f.negIta : f.neg) : (italica ? f.ita : f.reg);
}

const RE_FICHA = /\r\n|\r|\n|[ \t\f\v\u2028\u2029]+|[^ \t\f\v\r\n\u2028\u2029]+/g;
const RE_BLANCO = /^[ \t\f\v\u2028\u2029]+$/;

/**
 * Parte un texto en renglones que caben en `ancho` (puntos) a `tam`. Respeta los saltos de línea
 * del texto (un renglón vacío entre dos saltos queda como renglón vacío), interpreta **negrita** y
 * pasa cada palabra por aWinAnsi (un emoji solo desaparece sin dejar dos espacios). Una palabra más
 * ancha que el renglón se corta por letras. Texto vacío → [].
 */
export function renglones(texto: unknown, f: Fuentes, tam: number, ancho: number, estilo: EstiloTexto = {}): Renglon[] {
  const s = String(texto ?? "").replace(/^\s+|\s+$/g, "");
  if (!s) return [];
  const trozos: TrozoTexto[] = estilo.marcas === false ? [{ texto: s, negrita: false }] : trozosNegrita(s);
  type Tok = { salto: true } | { salto: false; texto: string; fuente: PDFFont; espacio: boolean };
  const toks: Tok[] = [];
  let espacio = false;
  for (const t of trozos) {
    const fuente = fuenteDe(f, !!estilo.negrita || t.negrita, !!estilo.italica);
    for (const m of t.texto.matchAll(RE_FICHA)) {
      const w = m[0];
      if (w === "\n" || w === "\r\n" || w === "\r") { toks.push({ salto: true }); espacio = false; continue; }
      if (RE_BLANCO.test(w)) { espacio = true; continue; }
      const limpio = aWinAnsi(w, f.juego);
      if (!limpio) continue; // lo que la fuente no tiene se cae; el espacio queda pendiente
      toks.push({ salto: false, texto: limpio, fuente, espacio });
      espacio = false;
    }
  }
  const out: Renglon[] = [];
  let actual: Pieza[] = [];
  let x = 0;
  const cerrar = (fin: boolean) => { out.push({ piezas: actual, ancho: x, fin }); actual = []; x = 0; };
  const lim = ancho + 0.01;
  for (const tk of toks) {
    if (tk.salto) { cerrar(true); continue; }
    const wf = anchoTexto(tk.fuente, tk.texto, tam);
    const sep = actual.length && tk.espacio ? anchoTexto(tk.fuente, " ", tam) : 0;
    if (actual.length && x + sep + wf > lim) cerrar(false);
    if (!actual.length && wf > lim) {
      // Más ancha que el renglón: se corta por letras.
      let trozo = "";
      for (const ch of Array.from(tk.texto)) {
        if (trozo && anchoTexto(tk.fuente, trozo + ch, tam) > lim) {
          const w = anchoTexto(tk.fuente, trozo, tam);
          actual.push({ texto: trozo, fuente: tk.fuente, dx: 0, ancho: w, espacio: false });
          x = w;
          cerrar(false);
          trozo = ch;
        } else trozo += ch;
      }
      const w = anchoTexto(tk.fuente, trozo, tam);
      actual.push({ texto: trozo, fuente: tk.fuente, dx: 0, ancho: w, espacio: false });
      x = w;
      continue;
    }
    const conSep = actual.length ? sep : 0;
    actual.push({ texto: tk.texto, fuente: tk.fuente, dx: x + conSep, ancho: wf, espacio: actual.length ? tk.espacio : false });
    x += conSep + wf;
  }
  if (actual.length) cerrar(true);
  return out;
}

/** Texto plano (sin **negrita**) partido en renglones de una fuente. */
export function envolver(texto: unknown, fuente: PDFFont, f: Fuentes, tam: number, ancho: number): string[] {
  const negrita = fuente === f.neg || fuente === f.negIta;
  const italica = fuente === f.ita || fuente === f.negIta;
  return renglones(texto, f, tam, ancho, { marcas: false, negrita, italica }).map((r) => textoDeRenglon(r));
}

/** El texto de un renglón tal como se lee (las piezas con su espacio). */
export function textoDeRenglon(r: Renglon): string {
  return r.piezas.map((p, i) => (i && p.espacio ? " " : "") + p.texto).join("");
}

/** Un texto limpio recortado con «…» para que quepa en `ancho`. Si ya cabe, tal cual. */
export function recortarConElipsis(texto: string, fuente: PDFFont, tam: number, ancho: number): string {
  if (anchoTexto(fuente, texto, tam) <= ancho + 0.01) return texto;
  const el = "…";
  const wEl = anchoTexto(fuente, el, tam);
  const cps = Array.from(texto);
  let lo = 0, hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (anchoTexto(fuente, cps.slice(0, mid).join("").trimEnd(), tam) + wEl <= ancho + 0.01) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? cps.slice(0, lo).join("").trimEnd() + el : (wEl <= ancho + 0.01 ? el : "");
}

/** El prefijo más largo de un texto limpio que cabe en `ancho` (por caracteres completos). */
export function prefijoQueCabe(texto: string, fuente: PDFFont, tam: number, ancho: number): string {
  const cps = Array.from(texto);
  let lo = 0, hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (anchoTexto(fuente, cps.slice(0, mid).join(""), tam) <= ancho + 0.01) lo = mid; else hi = mid - 1;
  }
  return cps.slice(0, lo).join("");
}

/**
 * Un renglón que termina en «…» y cabe en `ancho`: el último renglón de una celda que no cabe en una
 * hoja, o el último de un texto al que se le pone tope de renglones.
 */
export function cerrarConElipsis(r: Renglon, f: Fuentes, tam: number, ancho: number): Renglon {
  const el = "…";
  const fuenteEl = r.piezas.length ? r.piezas[r.piezas.length - 1].fuente : f.reg;
  const wEl = anchoTexto(fuenteEl, el, tam);
  const out: Pieza[] = [];
  for (const p of r.piezas) {
    if (p.dx + p.ancho + wEl <= ancho + 0.01) { out.push({ ...p }); continue; }
    const t = prefijoQueCabe(p.texto, p.fuente, tam, ancho - p.dx - wEl).trimEnd();
    if (t && p.dx + wEl < ancho) out.push({ ...p, texto: t, ancho: anchoTexto(p.fuente, t, tam) });
    break;
  }
  const finX = out.length ? out[out.length - 1].dx + out[out.length - 1].ancho : 0;
  out.push({ texto: el, fuente: fuenteEl, dx: finX, ancho: wEl, espacio: false });
  return { piezas: out, ancho: finX + wEl, fin: true };
}

/** Los renglones con tope: si sobran, el último que queda termina en «…». */
export function conTope(rs: Renglon[], max: number, f: Fuentes, tam: number, ancho: number): { renglones: Renglon[]; recortado: boolean } {
  if (rs.length <= max) return { renglones: rs, recortado: false };
  const k = Math.max(1, max);
  return { renglones: [...rs.slice(0, k - 1), cerrarConElipsis(rs[k - 1], f, tam, ancho)], recortado: true };
}

// ══ Imágenes ═══════════════════════════════════════════════════════════════════

/**
 * Incrusta un PNG o JPEG después de mirar su FIRMA (la declarada en `tipo` no manda: un PNG con
 * nombre .jpg se incrusta como PNG). Lo que no es PNG ni JPEG, o lo que pdf-lib no sabe leer,
 * devuelve null. Nunca lanza. Se pasa una COPIA de los bytes (pdf-lib lee el JPEG con un DataView
 * sobre el buffer entero, y un subarray de un buffer mayor lo confundiría).
 */
export async function incrustarImagen(doc: PDFDocument, img: ImagenPdf | null | undefined): Promise<PDFImage | null> {
  const b = img?.bytes;
  if (!b || !(b instanceof Uint8Array) || !b.length) return null;
  const formato = formatoPorFirma(b);
  try {
    if (formato === "png") return await doc.embedPng(new Uint8Array(b));
    if (formato === "jpeg") return await doc.embedJpg(new Uint8Array(b));
  } catch { /* pdf-lib no la pudo leer */ }
  return null;
}

/** Ancho y alto para que una imagen quepa en una caja sin deformarse ni agrandarse más allá de la caja. */
export function escalarImagen(img: { width: number; height: number }, maxAncho: number, maxAlto: number): { ancho: number; alto: number } {
  const w = img.width > 0 ? img.width : 1, h = img.height > 0 ? img.height : 1;
  const s = Math.min(maxAncho / w, maxAlto / h);
  return { ancho: w * s, alto: h * s };
}

// ══ Lienzo ═════════════════════════════════════════════════════════════════════

/** La línea base de un renglón de alto `lh` cuyo borde superior está en `top` (métricas de Helvetica). */
export const lineaBase = (top: number, lh: number, tam: number) => top + lh / 2 + 0.355 * tam;

export type Alineacion = "izq" | "centro" | "der" | "just";

export type EspecTabla = {
  titulo?: string | null;
  columnas: string[];
  filas: string[][];
  /** Anchos RELATIVOS (se escalan al ancho de la tabla). null o inválidos → se reparten por contenido. */
  anchos?: number[] | null;
  /** Fila final en negrita (totales). */
  pie?: string[] | null;
  color: RGB;
  /** Primera columna en negrita y con fondo claro (tablas «campo · detalle»). */
  primeraColumnaNegrita?: boolean;
  /** Cómo se nombra la tabla en los recortes («Tabla «Relación de unidades» (sección 7)»). */
  nombre?: string;
  tam?: number;
  lh?: number;
  x?: number;
  ancho?: number;
};

type FilaPreparada = { celdas: Renglon[][]; alto: number };
export type TablaPreparada = {
  n: number;
  anchos: number[];
  xs: number[];
  x: number;
  ancho: number;
  tam: number;
  lh: number;
  titulo: Renglon[];
  altoTitulo: number;
  cab: FilaPreparada | null;
  filas: FilaPreparada[];
  pie: FilaPreparada | null;
  recortes: string[];
  color: RGB;
  primeraColumnaNegrita: boolean;
};

export type Firmante = { nombre: string; dni: string; cargo: string } | null;

/** Tope de renglones de la fila de cabecera de una tabla (un nombre de columna enorme se recorta). */
const MAX_RENGLONES_CABECERA = 4;
const PAD_H = 4.5, PAD_V = 3.5;

/**
 * El cursor de maquetación de un PDF del módulo. `y` es la distancia desde ARRIBA hasta donde va el
 * siguiente contenido; el cuerpo va de `desde` a `hasta`. Las hojas se agregan con `nueva()`.
 */
export class Lienzo {
  readonly doc: PDFDocument;
  readonly f: Fuentes;
  readonly traza?: TrazaLic[];
  readonly desde: number;
  readonly hasta: number;
  readonly paginas: PDFPage[] = [];
  private readonly indices = new Map<PDFPage, number>();
  pag!: PDFPage;
  y = 0;

  constructor(doc: PDFDocument, f: Fuentes, o: { desde?: number; hasta?: number; traza?: TrazaLic[] } = {}) {
    this.doc = doc;
    this.f = f;
    this.traza = o.traza;
    this.desde = o.desde ?? GEOMETRIA_LIC.cuerpoDesde;
    this.hasta = o.hasta ?? GEOMETRIA_LIC.cuerpoHasta;
  }

  // ── Hojas y cursor ──
  nueva(): PDFPage {
    const p = this.doc.addPage([A4.ancho, A4.alto]);
    this.paginas.push(p);
    this.indices.set(p, this.paginas.length);
    this.pag = p;
    this.y = this.desde;
    return p;
  }
  /** Número de hoja dentro de ESTE PDF (1 = la primera). */
  numero(p: PDFPage = this.pag): number { return this.indices.get(p) ?? 0; }
  get enCabeza(): boolean { return this.y <= this.desde + 0.5; }
  get altoCuerpo(): number { return this.hasta - this.desde; }
  quedan(): number { return this.hasta - this.y; }
  /** Si `alto` no cabe, hoja nueva (salvo que ya se esté al inicio del cuerpo: no cabría en ninguna). */
  asegurar(alto: number): boolean {
    if (this.y + alto > this.hasta + 0.01 && !this.enCabeza) { this.nueva(); return true; }
    return false;
  }
  /** Espacio `antes` + un bloque de `alto` que va junto: si no cabe, hoja nueva y el espacio se pierde. */
  reservar(antes: number, alto: number): void {
    if (this.enCabeza) return;
    if (this.y + antes + alto > this.hasta + 0.01) this.nueva();
    else this.y += antes;
  }

  // ── Primitivas (todo en «top»: puntos desde arriba) ──
  texto(s: string, x: number, base: number, fuente: PDFFont, tam: number, color: RGB, o: { zona?: ZonaTraza; pag?: PDFPage; opacidad?: number } = {}): void {
    if (!s) return;
    const p = o.pag ?? this.pag;
    const yPdf = A4.alto - base;
    p.drawText(s, { x, y: yPdf, size: tam, font: fuente, color, ...(o.opacidad != null ? { opacity: o.opacidad } : {}) });
    this.traza?.push({ pagina: this.numero(p), zona: o.zona ?? "cuerpo", texto: s, x, y: yPdf, ancho: anchoTexto(fuente, s, tam) });
  }
  rect(x: number, top: number, w: number, h: number, o: { relleno?: RGB; borde?: RGB; grosor?: number; pag?: PDFPage; opacidad?: number; guiones?: number[] }): void {
    if (w <= 0 || h <= 0) return;
    (o.pag ?? this.pag).drawRectangle({
      x, y: A4.alto - (top + h), width: w, height: h,
      ...(o.relleno ? { color: o.relleno } : {}),
      ...(o.borde ? { borderColor: o.borde, borderWidth: o.grosor ?? 0.5 } : { borderWidth: 0 }),
      ...(o.guiones ? { borderDashArray: o.guiones } : {}),
      ...(o.opacidad != null ? { opacity: o.opacidad, borderOpacity: o.opacidad } : {}),
    });
  }
  linea(x1: number, y1: number, x2: number, y2: number, color: RGB, grosor = 0.5, pag?: PDFPage): void {
    (pag ?? this.pag).drawLine({ start: { x: x1, y: A4.alto - y1 }, end: { x: x2, y: A4.alto - y2 }, color, thickness: grosor });
  }
  imagen(img: PDFImage, x: number, top: number, w: number, h: number, pag?: PDFPage): void {
    (pag ?? this.pag).drawImage(img, { x, y: A4.alto - (top + h), width: w, height: h });
  }

  /**
   * Dibuja un renglón. «just» reparte el espacio sobrante entre las palabras (salvo en el último
   * renglón del párrafo, o si el hueco quedaría desmesurado); los demás modos juntan las piezas
   * seguidas de la misma fuente en un solo texto.
   */
  pintarRenglon(r: Renglon, x: number, base: number, tam: number, color: RGB, alin: Alineacion, ancho: number, o: { zona?: ZonaTraza; pag?: PDFPage } = {}): void {
    if (!r.piezas.length) return;
    let off = 0;
    if (alin === "centro") off = Math.max(0, (ancho - r.ancho) / 2);
    else if (alin === "der") off = Math.max(0, ancho - r.ancho);
    if (alin === "just" && !r.fin) {
      const huecos = r.piezas.filter((p, i) => i > 0 && p.espacio).length;
      const extra = huecos ? (ancho - r.ancho) / huecos : 0;
      if (huecos && extra > 0 && extra <= tam * 1.6) {
        let acum = 0;
        r.piezas.forEach((p, i) => {
          if (i > 0 && p.espacio) acum += extra;
          this.texto(p.texto, x + p.dx + acum, base, p.fuente, tam, color, o);
        });
        return;
      }
    }
    let tramo = "", xTramo = 0, fTramo: PDFFont | null = null;
    for (const p of r.piezas) {
      if (fTramo === p.fuente && tramo) { tramo += (p.espacio ? " " : "") + p.texto; continue; }
      if (tramo && fTramo) this.texto(tramo, x + off + xTramo, base, fTramo, tam, color, o);
      tramo = p.texto; xTramo = p.dx; fTramo = p.fuente;
    }
    if (tramo && fTramo) this.texto(tramo, x + off + xTramo, base, fTramo, tam, color, o);
  }

  // ── Bloques partibles ──

  /**
   * Un párrafo partible entre hojas, renglón por renglón. Los primeros `juntos` renglones (2 por
   * defecto) no se separan: un párrafo no empieza con un renglón huérfano al pie.
   */
  parrafo(texto: unknown, o: { tam?: number; lh?: number; color?: RGB; alinear?: Alineacion; estilo?: EstiloTexto; x?: number; ancho?: number; antes?: number; despues?: number; juntos?: number } = {}): number {
    const tam = o.tam ?? 10, lh = o.lh ?? tam * 1.4;
    const x = o.x ?? MARGEN_X, ancho = o.ancho ?? ANCHO_UTIL;
    const rs = renglones(texto, this.f, tam, ancho, o.estilo);
    if (!rs.length) return 0;
    this.reservar(o.antes ?? 0, Math.min(o.juntos ?? 2, rs.length) * lh);
    this.pintarRenglones(rs, x, ancho, tam, lh, o.color ?? TINTA, o.alinear ?? "izq");
    this.y += o.despues ?? 0;
    return rs.length;
  }
  /** Renglones ya partidos, desde `y`, saltando de hoja cuando no caben. */
  pintarRenglones(rs: Renglon[], x: number, ancho: number, tam: number, lh: number, color: RGB, alin: Alineacion): void {
    for (const r of rs) {
      if (this.y + lh > this.hasta + 0.01) this.nueva();
      this.pintarRenglon(r, x, lineaBase(this.y, lh, tam), tam, color, alin, ancho);
      this.y += lh;
    }
  }

  /** Lista con viñetas o numerada, con sangría francesa. Partible renglón por renglón. */
  lista(items: string[], ordenada: boolean, o: { tam?: number; lh?: number; color?: RGB; sangria?: number; antes?: number; despues?: number; entreItems?: number } = {}): void {
    const tam = o.tam ?? 10, lh = o.lh ?? tam * 1.4;
    const sangria = o.sangria ?? 10;
    const etiquetas = items.map((_, i) => (ordenada ? `${i + 1}.` : "•"));
    const wEt = Math.max(0, ...etiquetas.map((e) => anchoTexto(this.f.reg, e, tam)));
    const xEt = MARGEN_X + sangria, xTx = xEt + wEt + 6, ancho = MARGEN_X + ANCHO_UTIL - xTx;
    const prep = items.map((t) => renglones(t, this.f, tam, ancho)).map((rs, i) => ({ rs, et: etiquetas[i] })).filter((p) => p.rs.length);
    if (!prep.length) return;
    this.reservar(o.antes ?? 0, Math.min(2, prep[0].rs.length) * lh);
    prep.forEach((p, i) => {
      if (i) this.y += o.entreItems ?? 2;
      if (this.y + Math.min(2, p.rs.length) * lh > this.hasta + 0.01) this.nueva();
      p.rs.forEach((r, k) => {
        if (this.y + lh > this.hasta + 0.01) this.nueva();
        const b = lineaBase(this.y, lh, tam);
        if (k === 0) this.texto(p.et, ordenada ? xEt + wEt - anchoTexto(this.f.reg, p.et, tam) : xEt, b, this.f.reg, tam, o.color ?? TINTA);
        this.pintarRenglon(r, xTx, b, tam, o.color ?? TINTA, "just", ancho);
        this.y += lh;
      });
    });
    this.y += o.despues ?? 0;
  }

  /** Nota en recuadro con barra de color a la izquierda. Partible entre hojas. */
  nota(texto: unknown, o: { fondo: RGB; barra: RGB; tam?: number; lh?: number; color?: RGB; antes?: number; despues?: number }): void {
    const tam = o.tam ?? 9.5, lh = o.lh ?? tam * 1.4, pad = 7, barra = 3;
    const xTx = MARGEN_X + barra + pad + 2, ancho = ANCHO_UTIL - barra - 2 * pad - 2;
    const rs = renglones(texto, this.f, tam, ancho);
    if (!rs.length) return;
    this.reservar(o.antes ?? 0, 2 * pad + Math.min(2, rs.length) * lh);
    let i = 0;
    while (i < rs.length) {
      if (this.y + 2 * pad + lh > this.hasta + 0.01 && !this.enCabeza) this.nueva();
      const caben = Math.max(1, Math.floor((this.hasta - this.y - 2 * pad + 0.01) / lh));
      const k = Math.min(caben, rs.length - i);
      const alto = 2 * pad + k * lh;
      this.rect(MARGEN_X, this.y, ANCHO_UTIL, alto, { relleno: o.fondo });
      this.rect(MARGEN_X, this.y, barra, alto, { relleno: o.barra });
      for (let j = 0; j < k; j++) this.pintarRenglon(rs[i + j], xTx, lineaBase(this.y + pad + j * lh, lh, tam), tam, o.color ?? TINTA, "just", ancho);
      this.y += alto;
      i += k;
      if (i < rs.length) this.nueva();
    }
    this.y += o.despues ?? 0;
  }

  /** Alto de una figura (la imagen escalada a `anchoPct` del ancho útil, o el recuadro si falta, más el pie). */
  medirFigura(img: PDFImage | null, anchoPct: number, pie: string | null): { ancho: number; alto: number; altoImagen: number; pie: Renglon[] } {
    const pct = Number.isFinite(anchoPct) ? Math.max(10, Math.min(100, anchoPct)) : 100;
    let w = (ANCHO_UTIL * pct) / 100;
    const pieRs = renglones(pie ?? "", this.f, 8.5, ANCHO_UTIL, { italica: true });
    const altoPie = pieRs.length ? 4 + pieRs.length * 11 : 0;
    let h: number;
    if (img) {
      h = w * (img.height / Math.max(1, img.width));
      const maxH = this.altoCuerpo - altoPie - 2;
      if (h > maxH) { w *= maxH / h; h = maxH; }
    } else h = Math.min(w * 0.5, 170);
    return { ancho: w, alto: h + altoPie, altoImagen: h, pie: pieRs };
  }
  /** Figura centrada con su pie. Sin imagen: recuadro punteado con «imagen no disponible». */
  figura(img: PDFImage | null, anchoPct: number, pie: string | null, o: { antes?: number; despues?: number } = {}): void {
    const m = this.medirFigura(img, anchoPct, pie);
    this.reservar(o.antes ?? 0, m.alto);
    const x = MARGEN_X + (ANCHO_UTIL - m.ancho) / 2;
    if (img) this.imagen(img, x, this.y, m.ancho, m.altoImagen);
    else {
      this.rect(x, this.y, m.ancho, m.altoImagen, { relleno: GRIS_CEBRA, borde: GRIS_BORDE, grosor: 0.8, guiones: [4, 3] });
      const t = "imagen no disponible";
      this.texto(t, MARGEN_X + (ANCHO_UTIL - anchoTexto(this.f.ita, t, 9)) / 2, lineaBase(this.y + m.altoImagen / 2 - 6, 12, 9), this.f.ita, 9, GRIS_TEXTO);
    }
    this.y += m.altoImagen;
    if (m.pie.length) {
      this.y += 4;
      for (const r of m.pie) { this.pintarRenglon(r, MARGEN_X, lineaBase(this.y, 11, 8.5), 8.5, GRIS_TEXTO, "centro", ANCHO_UTIL); this.y += 11; }
    }
    this.y += o.despues ?? 0;
  }

  /** Alto del bloque de firma. */
  altoFirma(fir: Firmante, img: PDFImage | null): number {
    const lineas = fir ? [fir.nombre, fir.dni, fir.cargo].filter((s) => limpiar(s, this.f.juego)).length : 0;
    return (img ? 58 : 34) + 4 + lineas * 13;
  }
  /** Firma: la imagen (si hay) sobre una línea, y debajo nombre, DNI y cargo. No se parte. */
  firma(fir: Firmante, img: PDFImage | null, o: { antes?: number; x?: number } = {}): void {
    const alto = this.altoFirma(fir, img);
    this.reservar(o.antes ?? 0, alto);
    const x = o.x ?? MARGEN_X, w = 190;
    const yLinea = this.y + (img ? 58 : 34);
    if (img) {
      const e = escalarImagen(img, 170, 54);
      this.imagen(img, x + (w - e.ancho) / 2, yLinea - 2 - e.alto, e.ancho, e.alto);
    }
    this.linea(x, yLinea, x + w, yLinea, TINTA, 0.6);
    let yy = yLinea + 4;
    const fila = (s: string, fuente: PDFFont) => {
      const t = recortarConElipsis(limpiar(s, this.f.juego, 200), fuente, 9.5, MARGEN_X + ANCHO_UTIL - x);
      if (!t) return;
      this.texto(t, x, lineaBase(yy, 13, 9.5), fuente, 9.5, TINTA);
      yy += 13;
    };
    if (fir) {
      if (limpiar(fir.nombre, this.f.juego)) fila(fir.nombre, this.f.neg);
      if (limpiar(fir.dni, this.f.juego)) fila(`DNI N° ${fir.dni}`, this.f.reg);
      if (limpiar(fir.cargo, this.f.juego)) fila(fir.cargo, this.f.reg);
    }
    this.y += alto;
  }

  // ── Tablas ──

  /**
   * Mide una tabla sin dibujarla: anchos de columna, renglones de cada celda y alto de cada fila.
   * Una fila nunca se parte entre hojas, así que su alto máximo es una hoja entera menos la fila de
   * cabecera y el título: la celda que no cabe se recorta con «…» y se anota en `recortes`.
   */
  prepararTabla(e: EspecTabla): TablaPreparada {
    const f = this.f;
    const tam = e.tam ?? 8.5, lh = e.lh ?? tam * 1.3;
    const x = e.x ?? MARGEN_X, ancho = e.ancho ?? ANCHO_UTIL;
    const recortes: string[] = [];
    const nombre = e.nombre ?? (e.titulo ? `Tabla «${limpiar(e.titulo, f.juego, 80)}»` : "Tabla");
    const columnas = (e.columnas ?? []).map((c) => String(c ?? ""));
    const hayCab = columnas.some((c) => limpiar(c, f.juego) !== "");
    const filasSrc = (e.filas ?? []).filter((r) => Array.isArray(r));
    const pieSrc = Array.isArray(e.pie) && e.pie.some((c) => limpiar(c, f.juego) !== "") ? e.pie : null;
    const n = Math.max(columnas.length, ...filasSrc.map((r) => r.length), pieSrc?.length ?? 0, 0);
    const vacia: TablaPreparada = { n: 0, anchos: [], xs: [], x, ancho, tam, lh, titulo: [], altoTitulo: 0, cab: null, filas: [], pie: null, recortes, color: e.color, primeraColumnaNegrita: !!e.primeraColumnaNegrita };
    const titulo = renglones(e.titulo ?? "", f, 9.5, ancho, { negrita: true });
    const altoTitulo = titulo.length ? titulo.length * 13 + 4 : 0;
    if (!n) return { ...vacia, titulo, altoTitulo };
    const celda = (r: string[] | null, i: number) => String(r?.[i] ?? "");
    const negritaCol = (i: number, enCab: boolean, enPie: boolean) => enCab || enPie || (!!e.primeraColumnaNegrita && i === 0);

    // ── Anchos ──
    let anchos: number[];
    const rel = Array.isArray(e.anchos) && e.anchos.length === n && e.anchos.every((a) => Number.isFinite(a) && a > 0) ? e.anchos : null;
    if (rel) {
      const s = rel.reduce((a, b) => a + b, 0);
      anchos = rel.map((a) => (a / s) * ancho);
    } else {
      const piso = Math.min(30, ancho / n);
      const tope = Math.max(piso, ancho * 0.35);
      const nat = new Array<number>(n).fill(piso), min = new Array<number>(n).fill(piso);
      const medir = (texto: string, i: number, negrita: boolean) => {
        const rs = renglones(texto, f, tam, Infinity, { negrita });
        for (const r of rs) {
          nat[i] = Math.max(nat[i], Math.min(ancho, r.ancho + 2 * PAD_H));
          for (const p of r.piezas) min[i] = Math.max(min[i], Math.min(tope, p.ancho + 2 * PAD_H));
        }
      };
      for (let i = 0; i < n; i++) {
        if (hayCab) medir(celda(columnas, i), i, true);
        for (const r of filasSrc) medir(celda(r, i), i, negritaCol(i, false, false));
        if (pieSrc) medir(celda(pieSrc, i), i, true);
      }
      const sNat = nat.reduce((a, b) => a + b, 0), sMin = min.reduce((a, b) => a + b, 0);
      if (sNat <= ancho) anchos = nat.map((w) => (w / sNat) * ancho);
      else if (sMin >= ancho) anchos = min.map((w) => (w / sMin) * ancho);
      else anchos = min.map((w, i) => w + ((nat[i] - w) * (ancho - sMin)) / (sNat - sMin));
    }
    const xs: number[] = [];
    anchos.reduce((acc, w) => { xs.push(acc); return acc + w; }, x);

    const partirFila = (r: string[] | null, enCab: boolean, enPie: boolean, maxRenglones: number, k: number | null): FilaPreparada => {
      let recortada = false;
      const celdas = anchos.map((w, i) => {
        const c = conTope(renglones(celda(r, i), f, tam, Math.max(1, w - 2 * PAD_H), { negrita: negritaCol(i, enCab, enPie) }), maxRenglones, f, tam, w - 2 * PAD_H);
        if (c.recortado) recortada = true;
        return c.renglones;
      });
      if (recortada) {
        recortes.push(enCab
          ? `${nombre}: un nombre de columna era demasiado largo y se recortó con «…».`
          : `${nombre}: ${enPie ? "la fila de totales" : `la fila ${k}`} tiene una celda que no cabe en una hoja entera y se recortó con «…».`);
      }
      const alto = 2 * PAD_V + Math.max(1, ...celdas.map((c) => c.length)) * lh;
      return { celdas, alto };
    };
    const cab = hayCab ? partirFila(columnas, true, false, MAX_RENGLONES_CABECERA, null) : null;
    const altoCab = cab?.alto ?? 0;
    const maxAlto = this.altoCuerpo - altoCab - altoTitulo - 1;
    const maxRenglones = Math.max(1, Math.floor((maxAlto - 2 * PAD_V) / lh));
    const filas = filasSrc.map((r, k) => partirFila(r, false, false, maxRenglones, k + 1));
    const pie = pieSrc ? partirFila(pieSrc, false, true, maxRenglones, null) : null;
    return { n, anchos, xs, x, ancho, tam, lh, titulo, altoTitulo, cab, filas, pie, recortes, color: e.color, primeraColumnaNegrita: !!e.primeraColumnaNegrita };
  }
  /** Lo que tiene que caber junto para empezar la tabla: título, cabecera y la primera fila. */
  altoInicioTabla(t: TablaPreparada): number {
    return t.altoTitulo + (t.cab?.alto ?? 0) + (t.filas[0]?.alto ?? t.pie?.alto ?? 0);
  }
  /** Dibuja una tabla preparada desde `y`: repite la cabecera en cada hoja y nunca parte una fila. */
  dibujarTabla(t: TablaPreparada, o: { antes?: number; despues?: number } = {}): void {
    if (!t.n && !t.titulo.length) return;
    this.reservar(o.antes ?? 0, this.altoInicioTabla(t));
    for (const r of t.titulo) { this.pintarRenglon(r, t.x, lineaBase(this.y, 13, 9.5), 9.5, t.color, "izq", t.ancho); this.y += 13; }
    if (t.titulo.length) this.y += 4;
    if (!t.n) { this.y += o.despues ?? 0; return; }
    const pintarFila = (fila: FilaPreparada, tipo: "cab" | "fila" | "pie", k: number) => {
      const fondo = tipo === "cab" ? t.color : tipo === "pie" ? aclarar(t.color, 0.84) : k % 2 === 1 ? GRIS_CEBRA : null;
      if (fondo) this.rect(t.x, this.y, t.ancho, fila.alto, { relleno: fondo });
      if (tipo === "fila" && t.primeraColumnaNegrita) this.rect(t.x, this.y, t.anchos[0], fila.alto, { relleno: aclarar(t.color, 0.9) });
      fila.celdas.forEach((rs, i) => {
        const w = t.anchos[i];
        this.rect(t.xs[i], this.y, w, fila.alto, { borde: tipo === "cab" ? aclarar(t.color, 0.35) : GRIS_BORDE, grosor: 0.5 });
        const top = tipo === "cab" ? this.y + (fila.alto - rs.length * t.lh) / 2 : this.y + PAD_V;
        rs.forEach((r, j) => this.pintarRenglon(r, t.xs[i] + PAD_H, lineaBase(top + j * t.lh, t.lh, t.tam), t.tam, tipo === "cab" ? BLANCO : TINTA, "izq", w - 2 * PAD_H));
      });
      this.y += fila.alto;
    };
    const cabecera = () => { if (t.cab) pintarFila(t.cab, "cab", 0); };
    cabecera();
    t.filas.forEach((fila, k) => {
      if (this.y + fila.alto > this.hasta + 0.01) { this.nueva(); cabecera(); }
      pintarFila(fila, "fila", k);
    });
    if (t.pie) {
      if (this.y + t.pie.alto > this.hasta + 0.01) { this.nueva(); cabecera(); }
      pintarFila(t.pie, "pie", 0);
    }
    this.y += o.despues ?? 0;
  }

  // ── Después de maquetar ──

  /**
   * Cabecera (logo a la izquierda, texto a la derecha, línea de color) y pie (izquierda · derecha)
   * en cada hoja salvo las que `omitir` devuelva true. `pieDerecha` admite «{pagina}» y «{total}»:
   * la hoja k (1-based) se numera `primera + k - 1` y el total es `primera + hojas - 1`.
   */
  cabecerasYPies(o: {
    logo: PDFImage | null; cabecera: string; color: RGB; pieIzquierda: string; pieDerecha: string;
    primera?: number; omitir?: (hoja: number) => boolean;
  }): void {
    const primera = o.primera ?? 1;
    const total = primera + this.paginas.length - 1;
    this.paginas.forEach((p, i) => {
      const hoja = i + 1;
      if (o.omitir?.(hoja)) return;
      dibujarCabecera(this, p, o.logo, o.cabecera, o.color);
      dibujarPie(this, p, o.pieIzquierda, textoPie(o.pieDerecha, primera + i, total), o.color);
    });
  }
  /** La marca de agua (p. ej. «BORRADOR») en diagonal, gris claro, sobre cada hoja. */
  marcaAgua(texto: string): void {
    const mk = limpiar(texto, this.f.juego, 40);
    if (!mk) return;
    const ang = Math.atan2(A4.alto, A4.ancho);
    let tam = 96;
    while (tam > 20 && anchoTexto(this.f.neg, mk, tam) > Math.hypot(A4.ancho, A4.alto) * 0.7) tam -= 4;
    const w = anchoTexto(this.f.neg, mk, tam);
    const x = A4.ancho / 2 - (w / 2) * Math.cos(ang) + (tam * 0.35) * Math.sin(ang);
    const y = A4.alto / 2 - (w / 2) * Math.sin(ang) - (tam * 0.35) * Math.cos(ang);
    for (const p of this.paginas) {
      p.drawText(mk, { x, y, size: tam, font: this.f.neg, color: colorDe("#808080"), opacity: 0.13, rotate: degrees((ang * 180) / Math.PI) });
      this.traza?.push({ pagina: this.numero(p), zona: "marca", texto: mk, x, y, ancho: w });
    }
  }
}

/** «Página {pagina} de {total}» con los números puestos. Vacío → «Página X de Y». */
export function textoPie(plantilla: string, pagina: number, total: number): string {
  const p = String(plantilla ?? "").trim() || "Página {pagina} de {total}";
  return p.replace(/\{pagina\}/g, String(pagina)).replace(/\{total\}/g, String(total));
}

/** Cabecera de una hoja: logo (≤ 110 × 28 pt) a la izquierda, texto (≤ 2 renglones) a la derecha, línea de color. */
export function dibujarCabecera(l: Lienzo, p: PDFPage, logo: PDFImage | null, texto: string, color: RGB): void {
  const g = GEOMETRIA_LIC;
  let wLogo = 0;
  if (logo) {
    const e = escalarImagen(logo, 110, 28);
    l.imagen(logo, MARGEN_X, g.cabeceraDesde + (28 - e.alto) / 2, e.ancho, e.alto, p);
    wLogo = e.ancho + 14;
  }
  const disponible = ANCHO_UTIL - wLogo;
  const rs = conTope(renglones(texto, l.f, 8, disponible), 2, l.f, 8, disponible).renglones;
  const lh = 10.5;
  const top = g.cabeceraDesde + (28 - rs.length * lh) / 2;
  rs.forEach((r, k) => {
    l.pintarRenglon(r, MARGEN_X + wLogo, lineaBase(top + k * lh, lh, 8), 8, GRIS_TEXTO, "der", disponible, { zona: "cabecera", pag: p });
  });
  l.linea(MARGEN_X, g.lineaCabecera, MARGEN_X + ANCHO_UTIL, g.lineaCabecera, color, 1, p);
}

/** Pie de una hoja: línea fina, texto a la izquierda (recortado si choca) y el de la derecha (el número). */
export function dibujarPie(l: Lienzo, p: PDFPage, izquierda: string, derecha: string, color: RGB): void {
  const g = GEOMETRIA_LIC;
  l.linea(MARGEN_X, g.lineaPie, MARGEN_X + ANCHO_UTIL, g.lineaPie, aclarar(color, 0.55), 0.5, p);
  const der = recortarConElipsis(limpiar(derecha, l.f.juego, 80), l.f.reg, 7.5, ANCHO_UTIL);
  const wDer = anchoTexto(l.f.reg, der, 7.5);
  const izq = recortarConElipsis(limpiar(izquierda, l.f.juego, 300), l.f.reg, 7.5, Math.max(0, ANCHO_UTIL - wDer - 12));
  l.texto(izq, MARGEN_X, g.basePie, l.f.reg, 7.5, GRIS_TEXTO, { zona: "pie", pag: p });
  l.texto(der, MARGEN_X + ANCHO_UTIL - wDer, g.basePie, l.f.reg, 7.5, GRIS_TEXTO, { zona: "pie", pag: p });
}
