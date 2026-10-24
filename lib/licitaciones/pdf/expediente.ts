// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/pdf/expediente.ts — Arma los PDF del EXPEDIENTE de adjuntos: un PDF por bloque
// (portada separadora + documentos unidos + páginas generadas), los FOLIA y los une. PURO e
// ISOMÓRFICO (pdf-lib): corre en el navegador (la emisión se arma ahí, D10) y en node (las matrices).
// No lee la base, no hace fetch, no toca window: recibe bytes ya bajados y devuelve bytes.
//
// QUÉ SE IMPRIME NO SE DECIDE AQUÍ (D11): lo decide `resolverExpediente` (lib/licitaciones/
// expediente.ts) en `BloqueExpedienteResuelto`. Aquí solo se decide CÓMO se ve y se UNE. Las piezas de
// dibujo (fuentes, texto, tablas, cabecera) son las de pdf/comun.ts, las mismas de la propuesta.
//
// LO QUE NO SE PUEDE UNIR SE OMITE Y SE NOMBRA (D7, R11), NUNCA LANZA: una parte `faltante`, un
// archivo que no llegó (null), un enlace externo, un PDF cifrado (también el de solo contraseña de
// propietario: pdf-lib no copia un PDF cifrado, y `ignoreEncryption` lo copiaría con el contenido
// ilegible) o uno que pdf-lib no sabe leer van a `omitidos` con su código. El bloque sale igual con
// lo demás. Sí lanza un fallo propio (pdf-lib al guardar, un error de programación).
//
// DECISIONES DECLARADAS (las fija la matriz scripts/prueba-licitaciones-expediente.mts):
//  · PORTADA SEPARADORA = UNA hoja, siempre. `SeparadorResuelto.titulo` va ARRIBA, en color
//    («SECCIÓN II», «ANEXO 3») y `subtitulo` en la BANDA («REQUISITOS LEGALES»), en el orden en que se
//    leen. Si falta uno de los dos, el que hay va en la banda. Si la lista «Contenido» no cabe, se
//    achica la letra hasta 7 pt y, si aun así no cabe, se corta con «… y N documento(s) más» (así
//    `mapaFolios` puede tratar la portada como UNA página: `paginasPortada`).
//  · CUADRO DE EXPERIENCIA en A4 HORIZONTAL: `encabezado[0]` es el TÍTULO (centrado, en color);
//    el resto de `encabezado` es el destinatario («Señores», «COMITÉ…», «Presente.-»), alineado a la
//    izquierda, con **negrita**. El IMPORTE es la ÚLTIMA columna de la tabla. Los totales: si
//    `tabla.pie` viene, se imprime TAL CUAL (lo resolvió el resolvedor); si no, una fila «TOTAL:»
//    con un importe POR MONEDA, uno debajo de otro — NUNCA se suman PEN y USD. El contrato no trae
//    el «Lima, 21 de septiembre de 2026»: se acepta `lugarFecha` como campo OPCIONAL del cuadro
//    (`CuadroExperienciaPdf`); sin él, la firma va sin esa línea.
//  · UNA IMAGEN (PNG o JPEG) OCUPA UNA PÁGINA, ajustada a márgenes sin deformarse, en A4 vertical o
//    horizontal según su forma, y respetando la orientación EXIF de un JPEG de teléfono (si no, una
//    foto de un documento saldría acostada). El formato se decide por la FIRMA de los bytes, no por
//    el declarado.
//  · FOLIOS: «{n}» del formato se rellena a `digitos` («Folio 001»); un formato sin «{n}» lleva el
//    número al final. Se escriben en un recuadro blanco, respetando la rotación (/Rotate) y la
//    CropBox de cada hoja: en una hoja escaneada girada el folio sale derecho y en la esquina que se
//    VE. `mapaFolios` cuenta la página 1-based dentro de cada bloque.
//  · TRAZA: cada texto dibujado con su hoja (1 = la primera hoja de ESTE PDF), zona y caja; `y` es la
//    línea base en la coordenada de pdf-lib (desde abajo) — el contrato de pdf/comun.ts.
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import {
  A4, ANCHO_UTIL, BLANCO, GEOMETRIA_LIC, GRIS_BORDE, GRIS_CEBRA, GRIS_TEXTO, Lienzo, MARGEN_X, TINTA,
  anchoTexto, cargarFuentes, colorDe, conTope, dibujarCabecera, escalarImagen, limpiar, lineaBase,
  renglones, type Fuentes, type ImagenPdf, type Renglon, type ZonaTraza,
} from "./comun";
import type {
  BloqueExpedienteResuelto, CodigoHallazgo, CuadroExperiencia, FichaUnidad, Moneda, OmitidoEmision,
  OpcionesFoliado, ParteFuente, SeparadorResuelto, TablaPlano, TrazaLic,
} from "../tipos";

export type { ImagenPdf };

// ══ Revisión de un PDF ═════════════════════════════════════════════════════════

export type CodigoPdfNoUnible = "pdf_protegido" | "pdf_ilegible";
export type RevisionPdf = { ok: true; paginas: number } | { ok: false; codigo: CodigoPdfNoUnible; detalle: string };

/** Hasta dónde se busca «%PDF-» (Acrobat acepta el encabezado dentro del primer KB). */
const BYTES_ENCABEZADO_PDF = 1024;

function tieneEncabezadoPdf(b: Uint8Array): boolean {
  const lim = Math.min(b.length - 5, BYTES_ENCABEZADO_PDF);
  for (let i = 0; i <= lim; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

const ENCRYPT = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
const esBlancoPdf = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/**
 * ¿Algún diccionario declara `/Encrypt <ref | dict>`? Solo lo hace el trailer (o el diccionario de
 * un XRef stream, que nunca va comprimido). Respaldo de pdf-lib, que da por NO cifrado un PDF cuyo
 * /Encrypt apunta a un objeto que no encuentra — y ese PDF tiene el contenido cifrado igual.
 */
export function declaraCifrado(b: Uint8Array): boolean {
  const n = b.length - ENCRYPT.length;
  outer: for (let i = 0; i <= n; i++) {
    if (b[i] !== 0x2f) continue;
    for (let k = 1; k < ENCRYPT.length; k++) if (b[i + k] !== ENCRYPT[k]) continue outer;
    let j = i + ENCRYPT.length;
    while (j < b.length && esBlancoPdf(b[j])) j++;
    const c = b[j];
    if ((c >= 0x30 && c <= 0x39) || (c === 0x3c && b[j + 1] === 0x3c)) return true; // «5 0 R» o «<<»
  }
  return false;
}

type CargaPdf = { ok: true; doc: PDFDocument; paginas: number } | { ok: false; codigo: CodigoPdfNoUnible; detalle: string };

/** Lee un PDF SIN `ignoreEncryption` (R11). Nunca lanza. */
async function cargarPdf(bytes: Uint8Array): Promise<CargaPdf> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) {
    return { ok: false, codigo: "pdf_ilegible", detalle: "El archivo está vacío o es demasiado corto para ser un PDF." };
  }
  if (!tieneEncabezadoPdf(bytes)) {
    return { ok: false, codigo: "pdf_ilegible", detalle: "El archivo no empieza con «%PDF-»: no es un PDF." };
  }
  const cifrado = declaraCifrado(bytes);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e ?? "");
    // pdf-lib lanza EncryptedPDFError, pero con su transpilado `instanceof` no lo reconoce: se mira el mensaje.
    if (/is encrypted/i.test(msg) || cifrado) {
      return { ok: false, codigo: "pdf_protegido", detalle: "El PDF está protegido con contraseña o cifrado (también el de solo «contraseña de propietario»): no se puede unir. Pide una copia sin protección o imprímelo a PDF." };
    }
    return { ok: false, codigo: "pdf_ilegible", detalle: `El PDF está dañado o no se pudo leer (${msg.slice(0, 160) || "error desconocido"}).` };
  }
  if (cifrado || doc.isEncrypted) {
    return { ok: false, codigo: "pdf_protegido", detalle: "El PDF declara cifrado (/Encrypt): no se puede unir. Pide una copia sin protección o imprímelo a PDF." };
  }
  let paginas = 0;
  try { paginas = doc.getPageCount(); } catch (e: unknown) {
    return { ok: false, codigo: "pdf_ilegible", detalle: `El árbol de páginas del PDF está dañado (${String((e as Error)?.message ?? e).slice(0, 160)}).` };
  }
  if (!paginas) return { ok: false, codigo: "pdf_ilegible", detalle: "El PDF no tiene páginas." };
  return { ok: true, doc, paginas };
}

/**
 * ¿Se puede unir este PDF? Exige «%PDF-», lo lee SIN `ignoreEncryption` (R11): un PDF cifrado —
 * EncryptedPDFError o un trailer con /Encrypt— es `pdf_protegido`; cualquier otro fallo, o un PDF
 * sin páginas, `pdf_ilegible`. Nunca lanza.
 */
export async function revisarPdf(bytes: Uint8Array): Promise<RevisionPdf> {
  const r = await cargarPdf(bytes);
  return r.ok ? { ok: true, paginas: r.paginas } : { ok: false, codigo: r.codigo, detalle: r.detalle };
}

// ══ Imágenes: firma y orientación EXIF ═════════════════════════════════════════

export type FormatoArchivo = "pdf" | "png" | "jpg";

/** El formato por la FIRMA de los bytes (no por el nombre ni el declarado); null = ninguno de los tres. */
export function formatoDeBytes(b: Uint8Array): FormatoArchivo | null {
  if (!(b instanceof Uint8Array) || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (tieneEncabezadoPdf(b)) return "pdf";
  return null;
}

/** Orientación EXIF de un JPEG reducida a giros: 1 (derecha), 3 (180°), 6 (girar 90° horario), 8 (90° antihorario). */
export type Orientacion = 1 | 3 | 6 | 8;

/** Lee la etiqueta 0x0112 del APP1 Exif. Lo espejado (2, 4, 5, 7) se trata como su giro. Sin dato → 1. */
export function orientacionJpeg(b: Uint8Array): Orientacion {
  if (formatoDeBytes(b) !== "jpg") return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const marca = b[i + 1];
    if (marca === 0xd8 || (marca >= 0xd0 && marca <= 0xd7) || marca === 0x01) { i += 2; continue; }
    if (marca === 0xda || marca === 0xd9) return 1; // empieza la imagen: ya no hay APP1
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (largo < 2) return 1;
    if (marca === 0xe1 && largo >= 16 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
      const t = i + 10;                       // cabecera TIFF
      const fin = Math.min(b.length, i + 2 + largo);
      const le = b[t] === 0x49 && b[t + 1] === 0x49;
      const be = b[t] === 0x4d && b[t + 1] === 0x4d;
      if (!le && !be) return 1;
      const u16 = (o: number) => (o + 2 <= fin ? (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]) : -1);
      const u32 = (o: number) => (o + 4 <= fin ? (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0) : -1);
      const ifd = u32(t + 4);
      if (ifd < 0) return 1;
      const n = u16(t + ifd);
      if (n < 0) return 1;
      for (let k = 0; k < n && k < 512; k++) {
        const e = t + ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v === 3 || v === 4 ? 3 : v === 5 || v === 6 ? 6 : v === 7 || v === 8 ? 8 : 1;
        }
      }
      return 1;
    }
    i += 2 + largo;
  }
  return 1;
}

/** Ancho y alto como se VEN (con la orientación aplicada). */
function dimensionesVistas(img: { width: number; height: number }, o: Orientacion): { ancho: number; alto: number } {
  const w = img.width > 0 ? img.width : 1, h = img.height > 0 ? img.height : 1;
  return o === 6 || o === 8 ? { ancho: h, alto: w } : { ancho: w, alto: h };
}

/**
 * Dibuja una imagen dentro de una caja (coordenadas de pdf-lib: x, y = esquina inferior izquierda),
 * centrada, sin deformarla, y girada según su orientación EXIF.
 */
function dibujarImagenEnCaja(p: PDFPage, img: PDFImage, o: Orientacion, caja: { x: number; y: number; w: number; h: number }): void {
  const v = dimensionesVistas(img, o);
  const s = Math.min(caja.w / v.ancho, caja.h / v.alto);
  const dW = v.ancho * s, dH = v.alto * s;
  const bx = caja.x + (caja.w - dW) / 2, by = caja.y + (caja.h - dH) / 2;
  // a × b = la imagen como está guardada, escalada; la rotación de pdf-lib es antihoraria alrededor de (x, y).
  if (o === 6) p.drawImage(img, { x: bx, y: by + dH, width: dH, height: dW, rotate: degrees(-90) });
  else if (o === 8) p.drawImage(img, { x: bx + dW, y: by, width: dH, height: dW, rotate: degrees(90) });
  else if (o === 3) p.drawImage(img, { x: bx + dW, y: by + dH, width: dW, height: dH, rotate: degrees(180) });
  else p.drawImage(img, { x: bx, y: by, width: dW, height: dH });
}

/** Una imagen incrustada con su orientación. Nunca lanza (null = no se pudo leer). */
async function incrustarConOrientacion(doc: PDFDocument, bytes: Uint8Array | null | undefined): Promise<{ img: PDFImage; o: Orientacion } | null> {
  if (!bytes || !(bytes instanceof Uint8Array) || !bytes.length) return null;
  const fmt = formatoDeBytes(bytes);
  try {
    if (fmt === "png") return { img: await doc.embedPng(new Uint8Array(bytes)), o: 1 };
    if (fmt === "jpg") return { img: await doc.embedJpg(new Uint8Array(bytes)), o: orientacionJpeg(bytes) };
  } catch { /* pdf-lib no la pudo leer */ }
  return null;
}

/** Margen de las hojas que son una imagen suelta: deja libre la esquina del folio. */
const MARGEN_IMAGEN = 36;

/** Agrega una hoja A4 (vertical u horizontal según la forma de la imagen) con la imagen ajustada a márgenes. */
function hojaDeImagen(doc: PDFDocument, img: PDFImage, o: Orientacion): void {
  const v = dimensionesVistas(img, o);
  const [W, H] = v.ancho > v.alto ? [A4.alto, A4.ancho] : [A4.ancho, A4.alto];
  const p = doc.addPage([W, H]);
  dibujarImagenEnCaja(p, img, o, { x: MARGEN_IMAGEN, y: MARGEN_IMAGEN, w: W - 2 * MARGEN_IMAGEN, h: H - 2 * MARGEN_IMAGEN });
}

// ══ Lienzo apaisado (el cuadro de experiencia y las tablas anchas) ══════════════

/** A4 horizontal: 1.5 cm de margen lateral; el cuerpo arranca bajo la misma cabecera que la vertical. */
const H_ANCHO = A4.alto, H_ALTO = A4.ancho;
const H_MARGEN = 42.52;
const H_UTIL = H_ANCHO - 2 * H_MARGEN;
const H_HASTA = H_ALTO - 40;

/**
 * El Lienzo de pdf/comun.ts con hojas A4 HORIZONTALES. Las primitivas de comun convierten «desde
 * arriba» con el alto de la hoja vertical; aquí se convierte con el alto de la hoja que se dibuja.
 */
class LienzoApaisado extends Lienzo {
  constructor(doc: PDFDocument, f: Fuentes, o: { traza?: TrazaLic[] } = {}) {
    super(doc, f, { desde: GEOMETRIA_LIC.cuerpoDesde, hasta: H_HASTA, traza: o.traza });
  }
  nueva(): PDFPage {
    const p = super.nueva();
    p.setSize(H_ANCHO, H_ALTO);
    return p;
  }
  texto(s: string, x: number, base: number, fuente: PDFFont, tam: number, color: RGB, o: { zona?: ZonaTraza; pag?: PDFPage; opacidad?: number } = {}): void {
    if (!s) return;
    const p = o.pag ?? this.pag;
    const yPdf = p.getHeight() - base;
    p.drawText(s, { x, y: yPdf, size: tam, font: fuente, color, ...(o.opacidad != null ? { opacity: o.opacidad } : {}) });
    this.traza?.push({ pagina: this.numero(p), zona: o.zona ?? "cuerpo", texto: s, x, y: yPdf, ancho: anchoTexto(fuente, s, tam) });
  }
  rect(x: number, top: number, w: number, h: number, o: { relleno?: RGB; borde?: RGB; grosor?: number; pag?: PDFPage; opacidad?: number; guiones?: number[] }): void {
    if (w <= 0 || h <= 0) return;
    const p = o.pag ?? this.pag;
    p.drawRectangle({
      x, y: p.getHeight() - (top + h), width: w, height: h,
      ...(o.relleno ? { color: o.relleno } : {}),
      ...(o.borde ? { borderColor: o.borde, borderWidth: o.grosor ?? 0.5 } : { borderWidth: 0 }),
      ...(o.guiones ? { borderDashArray: o.guiones } : {}),
      ...(o.opacidad != null ? { opacity: o.opacidad, borderOpacity: o.opacidad } : {}),
    });
  }
  linea(x1: number, y1: number, x2: number, y2: number, color: RGB, grosor = 0.5, pag?: PDFPage): void {
    const p = pag ?? this.pag;
    p.drawLine({ start: { x: x1, y: p.getHeight() - y1 }, end: { x: x2, y: p.getHeight() - y2 }, color, thickness: grosor });
  }
  imagen(img: PDFImage, x: number, top: number, w: number, h: number, pag?: PDFPage): void {
    const p = pag ?? this.pag;
    p.drawImage(img, { x, y: p.getHeight() - (top + h), width: w, height: h });
  }
}

/** Cabecera de una hoja horizontal: la misma de comun (logo a la izquierda, texto a la derecha, línea), al ancho de la hoja. */
function cabeceraApaisada(l: LienzoApaisado, p: PDFPage, logo: PDFImage | null, texto: string, color: RGB): void {
  const g = GEOMETRIA_LIC;
  let wLogo = 0;
  if (logo) {
    const e = escalarImagen(logo, 110, 28);
    l.imagen(logo, H_MARGEN, g.cabeceraDesde + (28 - e.alto) / 2, e.ancho, e.alto, p);
    wLogo = e.ancho + 14;
  }
  const disponible = H_UTIL - wLogo;
  const rs = renglones(texto, l.f, 8, disponible, { marcas: true }).slice(0, 2);
  const lh = 10.5;
  const top = g.cabeceraDesde + (28 - rs.length * lh) / 2;
  rs.forEach((r, k) => l.pintarRenglon(r, H_MARGEN + wLogo, lineaBase(top + k * lh, lh, 8), 8, GRIS_TEXTO, "der", disponible, { zona: "cabecera", pag: p }));
  l.linea(H_MARGEN, g.lineaCabecera, H_MARGEN + H_UTIL, g.lineaCabecera, color, 1, p);
}

// ══ Piezas comunes de las hojas generadas ═════════════════════════════════════

type Marca = { logo: PDFImage | null; cabecera: string; color: RGB };

/** Cabecera en TODAS las hojas de un lienzo (después de maquetar). */
function cabeceras(l: Lienzo, m: Marca): void {
  for (const p of l.paginas) {
    if (l instanceof LienzoApaisado) cabeceraApaisada(l, p, m.logo, m.cabecera, m.color);
    else dibujarCabecera(l, p, m.logo, m.cabecera, m.color);
  }
}

/** Banda de color con un título en blanco, a lo ancho, desde `y`. */
function banda(l: Lienzo, texto: string, color: RGB, x: number, ancho: number, tam = 12): void {
  const rs = renglones(texto, l.f, tam, ancho - 24, { negrita: true, marcas: false }).slice(0, 3);
  if (!rs.length) return;
  const lh = tam * 1.3;
  const alto = Math.max(28, rs.length * lh + 14);
  l.reservar(0, alto);
  l.rect(x, l.y, ancho, alto, { relleno: color });
  const top = l.y + (alto - rs.length * lh) / 2;
  rs.forEach((r, k) => l.pintarRenglon(r, x + 12, lineaBase(top + k * lh, lh, tam), tam, BLANCO, "centro", ancho - 24));
  l.y += alto;
}

/** «dd/mm/aaaa» de una FechaISO; lo que no es fecha queda «—». */
export function fechaCorta(f: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** «S/ 1,234.56» · «US$ 1,234.56». Agrupa miles con coma y dos decimales, como las bases peruanas. */
export function importeTexto(moneda: Moneda, n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const neg = v < 0;
  const [ent, dec] = Math.abs(v).toFixed(2).split(".");
  const conMiles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${moneda === "USD" ? "US$" : "S/"} ${conMiles}.${dec}`;
}

// ══ Portada separadora ════════════════════════════════════════════════════════

/** Tamaños de letra que prueba la lista «Contenido» antes de cortarla. */
const TAMANOS_CONTENIDO = [10, 9, 8, 7] as const;

/** Dibuja la portada separadora en UNA hoja nueva del lienzo. */
function dibujarSeparador(l: Lienzo, s: SeparadorResuelto, m: Marca): void {
  const f = l.f;
  const p = l.nueva();
  const x = MARGEN_X, w = ANCHO_UTIL;
  const titulo = String(s.titulo ?? "").trim(), subtitulo = String(s.subtitulo ?? "").trim();
  const enBanda = subtitulo || titulo;
  const arriba = subtitulo ? titulo : "";
  let y = 190;

  if (arriba) {
    const rs = renglones(arriba, f, 15, w, { negrita: true, marcas: false }).slice(0, 2);
    for (const r of rs) { l.pintarRenglon(r, x, lineaBase(y, 19, 15), 15, m.color, "centro", w); y += 19; }
    y += 8;
  } else y += 27;

  if (enBanda) {
    const tam = 17, lh = 21;
    const rs = conTope(renglones(enBanda, f, tam, w - 40, { negrita: true, marcas: false }), 3, f, tam, w - 40).renglones;
    const alto = Math.max(44, rs.length * lh + 18);
    l.rect(x, y, w, alto, { relleno: m.color });
    const top = y + (alto - rs.length * lh) / 2;
    rs.forEach((r, k) => l.pintarRenglon(r, x + 20, lineaBase(top + k * lh, lh, tam), tam, BLANCO, "centro", w - 40));
    y += alto + 16;
  }

  const ref = String(s.referencia ?? "").trim();
  if (ref) {
    const rs = renglones(ref, f, 10, w, { italica: true, marcas: false }).slice(0, 2);
    for (const r of rs) { l.pintarRenglon(r, x, lineaBase(y, 14, 10), 10, GRIS_TEXTO, "centro", w); y += 14; }
    y += 14;
  }

  const items = (s.contenido ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (items.length) {
    l.texto(limpiar("Contenido:", f.juego), x, lineaBase(y, 15, 10.5), f.neg, 10.5, m.color);
    y += 19;
    const xBala = x + 42, xTexto = xBala + 11, anchoTexto_ = x + w - xTexto;
    const disponible = l.hasta - y;
    const medir = (tam: number) => items.map((t) => renglones(t, f, tam, anchoTexto_, { marcas: false }));
    let tam: number = TAMANOS_CONTENIDO[0];
    let prep = medir(tam);
    const alto = (rs: Renglon[][], t: number) => rs.reduce((a, r) => a + Math.max(1, r.length) * t * 1.45 + 2, 0);
    for (const t of TAMANOS_CONTENIDO) {
      tam = t; prep = medir(t);
      if (alto(prep, t) <= disponible) break;
    }
    const lh = tam * 1.45;
    let quedan = items.length;
    for (let i = 0; i < prep.length; i++) {
      const rs = prep[i];
      const altoItem = Math.max(1, rs.length) * lh + 2;
      const resto = items.length - i - 1;
      // Si este ítem no cabe con la línea de «… y N más» debajo (cuando quedan más), se corta aquí.
      if (y + altoItem + (resto > 0 ? lh : 0) > l.hasta + 0.01) break;
      l.texto("•", xBala, lineaBase(y, lh, tam), f.reg, tam, TINTA, { pag: p });
      rs.forEach((r, k) => l.pintarRenglon(r, xTexto, lineaBase(y + k * lh, lh, tam), tam, TINTA, "izq", anchoTexto_, { pag: p }));
      y += altoItem;
      quedan--;
    }
    if (quedan > 0) {
      const t = limpiar(`… y ${quedan} documento${quedan === 1 ? "" : "s"} más`, f.juego);
      l.texto(t, xTexto, lineaBase(y, lh, tam), f.ita, tam, GRIS_TEXTO, { pag: p });
    }
  }
  l.y = l.hasta;
  dibujarCabecera(l, p, m.logo, m.cabecera, m.color);
}

// ══ Ficha técnica por unidad ═══════════════════════════════════════════════════

const ROL_UNIDAD: Record<string, string> = { titular: "Titular", reten: "Retén" };

/** La ficha de una unidad (una hoja; la tabla de documentos sigue en otra si no cabe). */
function dibujarFicha(
  l: Lienzo, fi: FichaUnidad, m: Marca,
  fotos: Map<string, { img: PDFImage; o: Orientacion }>, avisos: string[],
): void {
  const f = l.f;
  l.nueva();
  const codigo = String(fi.codigo ?? "").trim();
  banda(l, `FICHA TÉCNICA DE LA UNIDAD${codigo ? ` ${codigo}` : ""}`, m.color, MARGEN_X, ANCHO_UTIL);
  l.y += 10;
  const sinDato = "Sin dato";
  const datos: string[][] = [
    ["Código", codigo || "—"],
    ["Rol", ROL_UNIDAD[fi.rol] ?? (String(fi.rol ?? "") || "—")],
    ["Uso", String(fi.uso ?? "").trim() || "—"],
    ["Placa", String(fi.placa ?? "").trim() || "—"],
    ["Marca y modelo", String(fi.marcaModelo ?? "").trim() || "—"],
    ["Año de fabricación", fi.anio != null && Number.isFinite(fi.anio) ? String(fi.anio) : sinDato],
    ["Capacidad", fi.capacidad != null && Number.isFinite(fi.capacidad) ? `${fi.capacidad} asientos` : sinDato],
    ["Flota", String(fi.flota ?? "").trim() || "—"],
  ];
  const tDatos = l.prepararTabla({ columnas: [], filas: datos, anchos: [1, 2.4], color: m.color, primeraColumnaNegrita: true, tam: 9.5, nombre: `Ficha ${codigo}` });
  l.dibujarTabla(tDatos);
  avisos.push(...tDatos.recortes);

  // ── Fotos lado a lado ──
  const slots: { titulo: string; url: string | null; lado: string }[] = [
    { titulo: "Vista exterior", url: fi.fotoExternaUrl, lado: "exterior" },
    { titulo: "Vista interior", url: fi.fotoInternaUrl, lado: "interior" },
  ];
  const conImagen = slots.filter((s) => s.url && fotos.has(s.url));
  for (const s of slots) {
    if (s.url && !fotos.has(s.url)) avisos.push(`Ficha ${codigo || fi.placa}: la foto ${s.lado} no se pudo dibujar (no se bajó o no es PNG/JPEG).`);
  }
  if (conImagen.length) {
    const sep = 14, wCaja = (ANCHO_UTIL - sep) / 2, hCaja = 190, hTit = 16;
    l.reservar(14, hTit + hCaja);
    const xs = conImagen.length === 2 ? [MARGEN_X, MARGEN_X + wCaja + sep] : [MARGEN_X + (ANCHO_UTIL - wCaja) / 2];
    conImagen.forEach((s, k) => {
      const x = xs[k];
      const t = limpiar(s.titulo, f.juego);
      l.texto(t, x + (wCaja - anchoTexto(f.neg, t, 9)) / 2, lineaBase(l.y, hTit, 9), f.neg, 9, GRIS_TEXTO);
      l.rect(x, l.y + hTit, wCaja, hCaja, { relleno: GRIS_CEBRA, borde: GRIS_BORDE, grosor: 0.6 });
      const foto = fotos.get(s.url!)!;
      dibujarImagenEnCaja(l.pag, foto.img, foto.o, { x: x + 4, y: A4.alto - (l.y + hTit + hCaja) + 4, w: wCaja - 8, h: hCaja - 8 });
    });
    l.y += hTit + hCaja;
  }

  // ── Documentos ──
  const docs = (fi.documentos ?? []).filter(Boolean);
  if (docs.length) {
    const t = l.prepararTabla({
      titulo: "Documentos de la unidad",
      columnas: ["Documento", "Número", "Vence", "Estado", "Adjunto"],
      filas: docs.map((d) => [String(d.tipo ?? ""), String(d.numero ?? "").trim() || "—", fechaCorta(d.vence), String(d.estado ?? ""), d.adjunto ? "Sí" : "No"]),
      anchos: [2.6, 1.6, 1.1, 1.3, 0.8], color: m.color, tam: 8.5, nombre: `Documentos de ${codigo || fi.placa}`,
    });
    l.dibujarTabla(t, { antes: 14 });
    avisos.push(...t.recortes);
  } else {
    l.parrafo("Sin documentos registrados para esta unidad.", { antes: 14, tam: 9, color: GRIS_TEXTO, estilo: { italica: true, marcas: false } });
  }
  cabeceras(l, m);
}

// ══ Tabla genérica ═════════════════════════════════════════════════════════════

/** Más columnas que esto → hoja horizontal (no medido: a 8.5 pt, 7 columnas caben en una vertical). */
export const MAX_COLUMNAS_VERTICAL = 7;

function dibujarTablaParte(l: Lienzo, titulo: string, tabla: TablaPlano, m: Marca, avisos: string[]): void {
  const apaisada = l instanceof LienzoApaisado;
  const x = apaisada ? H_MARGEN : MARGEN_X, ancho = apaisada ? H_UTIL : ANCHO_UTIL;
  l.nueva();
  const tit = String(titulo ?? "").trim();
  if (tit) { banda(l, tit, m.color, x, ancho); l.y += 10; }
  const t = l.prepararTabla({ columnas: tabla.columnas ?? [], filas: tabla.filas ?? [], pie: tabla.pie ?? null, color: m.color, tam: 8.5, x, ancho, nombre: tit ? `Tabla «${tit}»` : "Tabla" });
  if (!t.n) l.parrafo("Sin filas.", { tam: 9, color: GRIS_TEXTO, estilo: { italica: true, marcas: false }, x, ancho });
  else l.dibujarTabla(t);
  avisos.push(...t.recortes);
  cabeceras(l, m);
}

// ══ Cuadro de experiencia ══════════════════════════════════════════════════════

/** El cuadro con el campo OPCIONAL que el contrato no trae: «Lima, 21 de septiembre de 2026». */
export type CuadroExperienciaPdf = CuadroExperiencia & { lugarFecha?: string | null };

/**
 * La fila de totales del cuadro cuando el resolvedor no mandó `tabla.pie`: «TOTAL:» en la segunda
 * columna (la primera es el N.º) y en la ÚLTIMA un importe por moneda, uno debajo de otro. Nunca
 * suma monedas distintas. Sin totales → null.
 */
export function filaTotalesCuadro(columnas: number, totales: { moneda: Moneda; importe: number }[]): string[] | null {
  const ts = (totales ?? []).filter((t) => t && (t.moneda === "PEN" || t.moneda === "USD") && Number.isFinite(t.importe));
  if (!ts.length || columnas < 1) return null;
  const fila = new Array<string>(columnas).fill("");
  const iEtiqueta = columnas >= 3 ? 1 : 0;
  fila[iEtiqueta] = "TOTAL:";
  fila[columnas - 1] = (fila[columnas - 1] ? fila[columnas - 1] + "\n" : "") + ts.map((t) => importeTexto(t.moneda, t.importe)).join("\n");
  return fila;
}

function dibujarCuadro(l: LienzoApaisado, c: CuadroExperienciaPdf, m: Marca, firma: PDFImage | null, avisos: string[]): void {
  const f = l.f;
  l.nueva();
  const x = H_MARGEN, w = H_UTIL;
  const enc = (c.encabezado ?? []).map((s) => String(s ?? "")).filter((s) => s.trim());
  if (enc.length) {
    const rs = renglones(enc[0], f, 11, w, { negrita: true }).slice(0, 3);
    for (const r of rs) { l.pintarRenglon(r, x, lineaBase(l.y, 15, 11), 11, m.color, "centro", w); l.y += 15; }
    l.y += 6;
    for (const linea of enc.slice(1)) l.parrafo(linea, { x, ancho: w, tam: 9, lh: 12, juntos: 1 });
  }
  if (String(c.introduccion ?? "").trim()) l.parrafo(c.introduccion, { x, ancho: w, tam: 9, lh: 12, alinear: "just", antes: 3 });

  const tabla = c.tabla ?? { columnas: [], filas: [], pie: null };
  const n = Math.max((tabla.columnas ?? []).length, ...(tabla.filas ?? []).map((r) => r.length), 0);
  const pie = Array.isArray(tabla.pie) && tabla.pie.some((s) => String(s ?? "").trim()) ? tabla.pie : filaTotalesCuadro(n, c.totales ?? []);
  const t = l.prepararTabla({ columnas: tabla.columnas ?? [], filas: tabla.filas ?? [], pie, color: m.color, tam: 7.5, lh: 9.5, x, ancho: w, nombre: "Cuadro de experiencia" });
  if (t.n) l.dibujarTabla(t, { antes: 6 });
  avisos.push(...t.recortes);

  const lugar = String(c.lugarFecha ?? "").trim();
  if (lugar) l.parrafo(lugar, { x, ancho: w, tam: 9, antes: 8, juntos: 1 });
  if (c.firmante) {
    const fir = { nombre: String(c.firmante.nombre ?? ""), dni: String(c.firmante.dni ?? ""), cargo: String(c.firmante.cargo ?? "") };
    l.firma(fir, firma, { antes: 10, x: x + (w - 190) / 2 });
  }
  cabeceras(l, m);
}

// ══ armarBloque ════════════════════════════════════════════════════════════════

export type ArchivoBajado = { bytes: Uint8Array; formato: FormatoArchivo };

export type ComunBloque = {
  cabecera: string;
  color: string;
  logo: ImagenPdf | null;
  firma: ImagenPdf | null;
  /** Los archivos de las partes por su url; null = no se pudo bajar. */
  archivos: Record<string, ArchivoBajado | null>;
  /** Las imágenes de las fichas (fotos) y de la firma por su url; null = no se pudo bajar. */
  imagenes: Record<string, ImagenPdf | null>;
  /** La propuesta técnica ya armada (para la parte `propuesta`). */
  propuesta: Uint8Array | null;
};

export type ResultadoBloque = {
  bytes: Uint8Array;
  paginas: number;
  /** Una entrada por PARTE, en orden; una parte omitida va con 0 páginas. La portada no es una parte. */
  paginasPorParte: { itemId: string; paginas: number }[];
  omitidos: OmitidoEmision[];
  /** Lo que se recortó o no se pudo dibujar dentro de una hoja generada (una celda enorme, una foto que no se leyó). */
  avisos: string[];
};

function tituloParte(p: ParteFuente): string {
  switch (p.tipo) {
    case "archivo": return p.titulo || p.nombre || "Archivo";
    case "ficha_unidad": return `Ficha técnica ${p.ficha.codigo || p.ficha.placa || ""}`.trim();
    case "cuadro_experiencia": return "Cuadro de experiencia";
    case "tabla": return p.titulo || "Tabla";
    case "propuesta": return "Propuesta técnica";
    case "faltante": return p.titulo || "Documento";
  }
}

const DETALLE_FALTANTE: Partial<Record<CodigoHallazgo, string>> = {
  expediente_item_sin_archivo: "No tiene archivo para unir.",
  expediente_item_archivo_externo: "Es un enlace externo (Drive u otro sitio): no se puede unir. Súbelo como PDF.",
  adjunto_no_unible: "El adjunto no se puede unir al PDF.",
  archivo_no_descargable: "No se pudo bajar el archivo.",
};

/**
 * Arma el PDF de UN bloque del expediente: la portada separadora (si `conPortada`) y cada parte en
 * orden. Un PDF se copia página a página; una imagen ocupa una página; las fichas, el cuadro y las
 * tablas se dibujan; `propuesta` inserta los bytes de la propuesta ya armada. Lo que no se puede unir
 * (parte `faltante`, archivo null, enlace externo, PDF cifrado o ilegible, imagen que no se lee) se
 * OMITE y va a `omitidos` con su código: NUNCA lanza por eso.
 */
export async function armarBloque(bloque: BloqueExpedienteResuelto, comun: ComunBloque, opts: { traza?: TrazaLic[] } = {}): Promise<ResultadoBloque> {
  const doc = await PDFDocument.create();
  const f = await cargarFuentes(doc);
  const sep = bloque.separador ?? { titulo: "", subtitulo: "", referencia: "", contenido: [] };
  const tituloDoc = limpiar([sep.titulo, sep.subtitulo].filter((s) => String(s ?? "").trim()).join(" – "), f.juego, 200);
  if (tituloDoc) doc.setTitle(tituloDoc);
  doc.setProducer("pdf-lib");

  const logoImg = await incrustarConOrientacion(doc, comun.logo?.bytes ?? null);
  const m: Marca = { logo: logoImg?.img ?? null, cabecera: String(comun.cabecera ?? ""), color: colorDe(comun.color) };
  const omitidos: OmitidoEmision[] = [];
  const avisos: string[] = [];
  const paginasPorParte: { itemId: string; paginas: number }[] = [];

  /** Corre un dibujo con su propio Lienzo y pasa su traza a la del bloque, con la hoja corrida al lugar que ocupa en ESTE PDF. */
  const conLienzo = (crear: (traza: TrazaLic[] | undefined) => Lienzo, dibujar: (l: Lienzo) => void) => {
    const offset = doc.getPageCount();
    const local: TrazaLic[] | undefined = opts.traza ? [] : undefined;
    const l = crear(local);
    dibujar(l);
    if (opts.traza && local) for (const t of local) opts.traza.push({ ...t, pagina: t.pagina + offset });
  };
  const vertical = (traza?: TrazaLic[]) => new Lienzo(doc, f, { traza });
  const horizontal = (traza?: TrazaLic[]) => new LienzoApaisado(doc, f, { traza });

  if (bloque.conPortada) conLienzo(vertical, (l) => dibujarSeparador(l, sep, m));

  const omitir = (p: ParteFuente, url: string | null, codigo: CodigoHallazgo, detalle: string) =>
    omitidos.push({ itemId: p.itemId, bloqueId: bloque.id, titulo: tituloParte(p), url, codigo, detalle });

  /** Copia todas las páginas de un PDF ya leído. Nunca lanza: un fallo al copiar → ilegible. */
  const copiarPdf = async (src: PDFDocument): Promise<string | null> => {
    try {
      const copiadas = await doc.copyPages(src, src.getPageIndices());
      for (const pg of copiadas) doc.addPage(pg);
      return null;
    } catch (e: unknown) {
      return `No se pudieron copiar sus páginas (${String((e as Error)?.message ?? e).slice(0, 160)}).`;
    }
  };

  for (const parte of bloque.partes ?? []) {
    const antes = doc.getPageCount();
    switch (parte.tipo) {
      case "faltante":
        omitir(parte, null, parte.codigo, DETALLE_FALTANTE[parte.codigo] ?? "No hay documento para unir.");
        break;

      case "archivo": {
        if (parte.origen === "externo") { omitir(parte, parte.url, "expediente_item_archivo_externo", DETALLE_FALTANTE.expediente_item_archivo_externo!); break; }
        if (parte.origen === "vacio" || !parte.url) { omitir(parte, parte.url || null, "expediente_item_sin_archivo", DETALLE_FALTANTE.expediente_item_sin_archivo!); break; }
        const a = comun.archivos?.[parte.url];
        if (!a || !(a.bytes instanceof Uint8Array) || !a.bytes.length) { omitir(parte, parte.url, "archivo_no_descargable", DETALLE_FALTANTE.archivo_no_descargable!); break; }
        const fmt = formatoDeBytes(a.bytes) ?? a.formato;
        if (fmt === "pdf") {
          const c = await cargarPdf(a.bytes);
          if (!c.ok) { omitir(parte, parte.url, c.codigo, c.detalle); break; }
          const err = await copiarPdf(c.doc);
          if (err) { omitir(parte, parte.url, "pdf_ilegible", err); while (doc.getPageCount() > antes) doc.removePage(doc.getPageCount() - 1); }
        } else {
          const im = await incrustarConOrientacion(doc, a.bytes);
          if (!im) { omitir(parte, parte.url, "archivo_formato_no_soportado", "No es un PDF, PNG ni JPEG que se pueda leer."); break; }
          hojaDeImagen(doc, im.img, im.o);
        }
        break;
      }

      case "propuesta": {
        if (!comun.propuesta?.length) { omitir(parte, null, "expediente_item_sin_archivo", "La propuesta técnica no se armó: no hay nada que insertar."); break; }
        const c = await cargarPdf(comun.propuesta);
        if (!c.ok) { omitir(parte, null, c.codigo, `La propuesta técnica: ${c.detalle}`); break; }
        const err = await copiarPdf(c.doc);
        if (err) { omitir(parte, null, "pdf_ilegible", err); while (doc.getPageCount() > antes) doc.removePage(doc.getPageCount() - 1); }
        break;
      }

      case "ficha_unidad": {
        const fotos = new Map<string, { img: PDFImage; o: Orientacion }>();
        for (const url of [parte.ficha.fotoExternaUrl, parte.ficha.fotoInternaUrl]) {
          if (!url || fotos.has(url)) continue;
          const im = await incrustarConOrientacion(doc, comun.imagenes?.[url]?.bytes ?? null);
          if (im) fotos.set(url, im);
        }
        conLienzo(vertical, (l) => dibujarFicha(l, parte.ficha, m, fotos, avisos));
        break;
      }

      case "cuadro_experiencia": {
        const fu = parte.cuadro.firmante?.firmaUrl ?? null;
        const fuente = fu ? (comun.imagenes?.[fu] ?? comun.firma) : null;
        const firma = (await incrustarConOrientacion(doc, fuente?.bytes ?? null))?.img ?? null;
        if (fu && !firma) avisos.push("Cuadro de experiencia: la firma no se pudo dibujar (no se bajó o no es PNG/JPEG); va solo la línea.");
        conLienzo(horizontal, (l) => dibujarCuadro(l as LienzoApaisado, parte.cuadro as CuadroExperienciaPdf, m, firma, avisos));
        break;
      }

      case "tabla": {
        const cols = Math.max((parte.tabla?.columnas ?? []).length, ...(parte.tabla?.filas ?? []).map((r) => r.length), 0);
        conLienzo(cols > MAX_COLUMNAS_VERTICAL ? horizontal : vertical, (l) => dibujarTablaParte(l, parte.titulo, parte.tabla ?? { columnas: [], filas: [], pie: null }, m, avisos));
        break;
      }
    }
    paginasPorParte.push({ itemId: parte.itemId, paginas: doc.getPageCount() - antes });
  }

  const paginas = doc.getPageCount();
  const bytes = await doc.save();
  return { bytes, paginas, paginasPorParte, omitidos, avisos };
}

// ══ Folios ═════════════════════════════════════════════════════════════════════

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

/** Distancia del recuadro del folio al borde que se VE, y su letra. */
const FOLIO = { margen: 16, tam: 9, padX: 4, padY: 3 } as const;

/**
 * Escribe el folio de cada página (`folios[i]` para la hoja i; null = no se toca) con `op.formato`
 * y `op.digitos`, en `op.posicion`, en un recuadro blanco con borde. Respeta /Rotate y la CropBox:
 * el folio sale derecho y en la esquina que se ve. Con modo «ninguno» devuelve los mismos bytes.
 * LANZA si `folios` no tiene una entrada por página (un desfase foliaría mal un documento oficial).
 */
export async function foliar(bytes: Uint8Array, folios: (number | null)[], op: OpcionesFoliado, opts: { traza?: TrazaLic[] } = {}): Promise<Uint8Array> {
  if (op.modo === "ninguno" || !folios.some((v) => v != null)) return bytes;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const paginas = doc.getPages();
  if (folios.length !== paginas.length) throw new Error(`foliar: ${folios.length} folio(s) para ${paginas.length} página(s).`);
  const fuente = await doc.embedFont(StandardFonts.HelveticaBold);
  const juego: ReadonlySet<number> = new Set(fuente.getCharacterSet());
  const negro = colorDe("#111111");
  const borde = colorDe("#555555");

  paginas.forEach((p, i) => {
    const n = folios[i];
    if (n == null) return;
    const texto = limpiar(textoFolio(op.formato, n, op.digitos), juego, 40);
    if (!texto) return;
    // Primero la fuente: pdf-lib envuelve el contenido original en q/Q al registrarla, antes de crear el nuestro.
    p.setFont(fuente);
    const mb = p.getMediaBox(), cb = p.getCropBox();
    const cx = Math.max(mb.x, cb.x), cy = Math.max(mb.y, cb.y);
    const W = Math.max(1, Math.min(mb.x + mb.width, cb.x + cb.width) - cx);
    const H = Math.max(1, Math.min(mb.y + mb.height, cb.y + cb.height) - cy);
    const r = ((Math.round((p.getRotation().angle || 0) / 90) * 90) % 360 + 360) % 360;
    const [vW, vH] = r === 90 || r === 270 ? [H, W] : [W, H];   // lo que se VE
    const wt = anchoTexto(fuente, texto, FOLIO.tam);
    const bw = wt + 2 * FOLIO.padX, bh = FOLIO.tam + 2 * FOLIO.padY;
    const u0 = op.posicion === "inferior_centro" ? (vW - bw) / 2 : vW - FOLIO.margen - bw;
    const v0 = op.posicion === "superior_derecha" ? vH - FOLIO.margen - bh : FOLIO.margen;
    // (u, v) en lo que se ve → (x, y) en la hoja sin girar.
    const aHoja = (u: number, v: number): [number, number] => {
      if (r === 90) return [cx + W - v, cy + u];
      if (r === 180) return [cx + W - u, cy + H - v];
      if (r === 270) return [cx + v, cy + H - u];
      return [cx + u, cy + v];
    };
    const rot = degrees(r);
    const [rx, ry] = aHoja(u0, v0);
    p.drawRectangle({ x: rx, y: ry, width: bw, height: bh, color: colorDe("#ffffff"), borderColor: borde, borderWidth: 0.6, rotate: rot });
    const [tx, ty] = aHoja(u0 + FOLIO.padX, v0 + FOLIO.padY + 0.22 * FOLIO.tam);
    p.drawText(texto, { x: tx, y: ty, size: FOLIO.tam, font: fuente, color: negro, rotate: rot });
    opts.traza?.push({ pagina: i + 1, zona: "folio", texto, x: tx, y: ty, ancho: wt });
  });
  return doc.save();
}

// ══ Unir ═══════════════════════════════════════════════════════════════════════

/**
 * Une PDF ya armados por este módulo (bloques, propuesta) en uno, página a página y en orden. LANZA
 * si alguno no se puede leer: son salidas propias, y un expediente completo con un bloque de menos
 * no puede salir en silencio.
 */
export async function unirPdfs(partes: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer("pdf-lib");
  for (let i = 0; i < partes.length; i++) {
    const c = await cargarPdf(partes[i]);
    if (!c.ok) throw new Error(`unirPdfs: la parte ${i + 1} no se puede unir (${c.codigo}): ${c.detalle}`);
    const copiadas = await out.copyPages(c.doc, c.doc.getPageIndices());
    for (const pg of copiadas) out.addPage(pg);
  }
  return out.save();
}
