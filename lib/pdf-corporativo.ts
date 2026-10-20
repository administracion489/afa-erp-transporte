// ──────────────────────────────────────────────────────────────────────────────
// lib/pdf-corporativo.ts — Dibuja en el SERVIDOR (pdf-lib) la plantilla corporativa de la
// cotización: la misma que imprime /cotizaciones (`htmlCorporativo` en lib/cotizacion-pdf.ts).
// No lee la base ni descarga nada: el logo y las fotos llegan en bytes (los baja el servidor con
// sus topes, lib/traslados/enviar-cotizacion-datos.ts).
//
// QUÉ SE IMPRIME NO SE DECIDE AQUÍ: lo decide `docCorporativo` (lib/cotizacion-corporativo.ts), el
// mismo modelo que pinta el HTML. Aquí solo se decide CÓMO se ve, con la geometría del HTML impreso
// en A4: 1 px CSS = 0.75 pt, márgenes laterales de 15 mm, cabecera azul de 65 px con la tarjeta
// blanca del logo a la izquierda y el título a la derecha, cajas con borde #ccc, tabla de 7 columnas
// con los totales dentro, cuentas en dos columnas, la hoja 2 «Descripción de la unidad y
// condiciones» y el pie azul en cada hoja. Se compara con el HTML en
// scripts/prueba-traslados-pdf-corporativo.mts (texto por texto y en el mismo orden).
//
// DIVERGENCIAS DECLARADAS respecto del HTML (las comprueba la matriz):
//  · Fuentes estándar (Helvetica, WinAnsi): los emojis (✅ ❌ 📋 ⏰) y los íconos del pie no existen
//    ahí. Los de las listas se DIBUJAN (un check verde, una X roja, un portapapeles); los demás se
//    omiten. Todo texto pasa por `aWinAnsi` (lib/pdf-winansi.ts): pdf-lib LANZA con un carácter que
//    la fuente no tiene, y parte de ese texto lo escribe el cliente.
//  · Sin logo NO se usa el del bundle (es el de otra empresa, y este ERP se vende): la tarjeta
//    lleva el nombre de la empresa.
//  · Una foto que no se pudo bajar no se dibuja (el HTML pondría el recuadro con la imagen rota).
//  · Los textos desmesurados se recortan con «…» (el HTML los imprime enteros y se saldrían de la
//    hoja): una celda de la tabla no puede ocupar más de una hoja.
//  · La marca de agua (el PDF de EJEMPLO del simulador) solo existe aquí.
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { aWinAnsi } from "./pdf-winansi";
import { listaVisible, type CajaDoc, type DocCorporativo, type FilaDoc, type ListaDoc } from "./cotizacion-corporativo";
import { NOMBRE_SIN_CONFIGURAR } from "./empresa-perfil";

/** Una imagen ya bajada y comprobada por su firma. */
export type ImagenPdf = { bytes: Uint8Array; tipo: "png" | "jpg" };

export type ImagenesCorporativo = {
  logo?: ImagenPdf | null;
  /** Las fotos de las unidades por su URL (la del modelo): solo JPEG, se incrustan sin decodificar. */
  fotos?: Record<string, Uint8Array | null | undefined>;
};

/** Cada texto dibujado, en orden (para la matriz: comparar con el HTML sin un lector de PDF). */
export type TrazaPdf = { pagina: number; zona: "cabecera" | "cuerpo" | "pie" | "marca"; texto: string };

export type OpcionesCorporativo = {
  /** Texto en diagonal y claro sobre cada hoja (el PDF de ejemplo); null en uno real. */
  marcaAgua?: string | null;
  traza?: TrazaPdf[];
};

// ── Geometría: px CSS (96 por pulgada) → pt (72 por pulgada) ──────────────────

const PX = 0.75;
const AN = 595.28, AL = 841.89;          // A4 en pt
const W = AN / PX, H = AL / PX;          // A4 en px
const MX = (15 / 25.4) * 96;             // 15 mm de margen lateral
const CW = W - 2 * MX;                   // ancho útil
const CAB = 65;                          // alto de la cabecera
const TOP = 82;                          // donde empieza el cuerpo de cada hoja (body padding-top)
const LIMITE = H - 55;                   // donde termina (body padding-bottom)
/** Ningún texto suelto pasa de esto: una celda no puede ocupar más de una hoja. */
const MAX_TEXTO = 1500;

const hex = (c: string): RGB => {
  const s = /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1) : "0b315f";
  return rgb(parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255);
};
/** Un color sobre otro con transparencia (para los rgba del HTML sobre un fondo liso). */
const mezcla = (frente: RGB, fondo: RGB, alfa: number): RGB =>
  rgb(frente.red * alfa + fondo.red * (1 - alfa), frente.green * alfa + fondo.green * (1 - alfa), frente.blue * alfa + fondo.blue * (1 - alfa));

const BLANCO = rgb(1, 1, 1);
const TEXTO = hex("#1a1a1a");
const GRIS_BORDE = hex("#cccccc");
const GRIS_LINEA = hex("#e5e7eb");
const ZEBRA = hex("#f8fafc");
const GRIS_555 = hex("#555555");
const GRIS_6B = hex("#6b7280");
const ROJO_DSCTO = hex("#dc2626");
const DESC_UNIDAD = hex("#475569");
const FONDO_FOTO = hex("#f3f4f6");
const BORDE_CUENTA = hex("#dddddd");
const LI = hex("#333333");

/** La línea base de un renglón de alto `lh` cuyo borde superior está en `top` (métricas de Arial). */
const base = (top: number, lh: number, size: number) => top + lh / 2 + 0.3465 * size;

type Trozo = { texto: string; f: PDFFont };
type Ficha = { texto: string; f: PDFFont; espacio: boolean };

/**
 * Dibuja el documento corporativo. Nunca lanza por un logo o una foto que pdf-lib no pueda leer
 * (sale sin ellos); sí lanza si pdf-lib falla al guardar.
 */
export async function dibujarPdfCorporativo(d: DocCorporativo, img: ImagenesCorporativo = {}, opts: OpcionesCorporativo = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const neg = await doc.embedFont(StandardFonts.HelveticaBold);
  const juego: ReadonlySet<number> = new Set(reg.getCharacterSet());
  const T = (s: unknown, max = MAX_TEXTO) => aWinAnsi(String(s ?? ""), juego, max);
  const MAY = (s: unknown, max = MAX_TEXTO) => T(String(s ?? "").toLocaleUpperCase("es-PE"), max);
  const CP = hex(d.color);
  const traza = opts.traza;

  doc.setTitle(T(d.tituloVentana, 200) || "Cotización");
  if (d.empresaNombre && d.empresaNombre !== NOMBRE_SIN_CONFIGURAR) {
    doc.setAuthor(T(d.empresaNombre, 200));
    doc.setCreator(T(d.empresaNombre, 200));
  }
  doc.setProducer("pdf-lib");

  // ── Imágenes (una copia: pdf-lib lee el JPEG con un DataView sobre el buffer entero) ──
  let logo: PDFImage | null = null;
  if (img.logo?.bytes?.length) {
    try { logo = img.logo.tipo === "jpg" ? await doc.embedJpg(new Uint8Array(img.logo.bytes)) : await doc.embedPng(new Uint8Array(img.logo.bytes)); }
    catch { logo = null; /* un logo que no se puede leer no impide la cotización: sale con el nombre */ }
  }
  const fotos = new Map<string, PDFImage>();
  for (const v of d.pagina2.caracteristicas?.vehiculos ?? []) {
    for (const url of [v.fotoExterior, v.fotoInterior]) {
      if (!url || fotos.has(url)) continue;
      const b = img.fotos?.[url];
      if (!b?.length) continue;
      try { fotos.set(url, await doc.embedJpg(new Uint8Array(b))); } catch { /* sin esa foto */ }
    }
  }

  // ── Páginas, cursor y márgenes que colapsan como en CSS ──
  const paginas: PDFPage[] = [];
  let pag!: PDFPage;
  let y = TOP;
  let margen = 0;
  const nueva = () => { pag = doc.addPage([AN, AL]); paginas.push(pag); y = TOP; margen = 0; };
  const colapsar = (a: number, b: number) => (a >= 0 && b >= 0 ? Math.max(a, b) : a < 0 && b < 0 ? Math.min(a, b) : a + b);
  /** Antes de un bloque: aplica su margen superior (colapsado con el inferior del anterior). */
  const bloque = (arriba: number) => { y += colapsar(margen, arriba) - margen; margen = 0; };
  const fin = (abajo: number) => { margen = abajo; y += abajo; };
  /** Si un bloque de `alto` no cabe, nueva hoja (salvo que ya se esté arriba: no cabría en ninguna). */
  const asegurar = (alto: number) => { if (y + alto > LIMITE && y > TOP + 1) nueva(); };

  // ── Dibujo básico (todo en px) ──
  const texto = (p: PDFPage, s: string, x: number, b: number, f: PDFFont, size: number, color: RGB, zona: TrazaPdf["zona"] = "cuerpo", opacidad?: number) => {
    if (!s) return;
    p.drawText(s, { x: x * PX, y: AL - b * PX, size: size * PX, font: f, color, ...(opacidad != null ? { opacity: opacidad } : {}) });
    traza?.push({ pagina: paginas.indexOf(p) + 1, zona, texto: s });
  };
  const ancho = (s: string, f: PDFFont, size: number) => f.widthOfTextAtSize(s, size * PX) / PX;
  const rect = (p: PDFPage, x: number, top: number, w: number, h: number, o: { color?: RGB; borde?: RGB; grosor?: number }) => {
    p.drawRectangle({
      x: x * PX, y: AL - (top + h) * PX, width: w * PX, height: h * PX,
      ...(o.color ? { color: o.color } : {}),
      ...(o.borde ? { borderColor: o.borde, borderWidth: (o.grosor ?? 1) * PX } : {}),
    });
  };
  /** Rectángulo redondeado (radio en px). Con `soloDerecha`, solo las esquinas de la derecha. */
  const redondeado = (p: PDFPage, x: number, top: number, w: number, h: number, r: number, o: { color?: RGB; borde?: RGB; grosor?: number; soloDerecha?: boolean }) => {
    const k = PX;
    const R = Math.min(r, w / 2, h / 2) * k, Wp = w * k, Hp = h * k;
    const path = o.soloDerecha
      ? `M 0 0 H ${Wp - R} A ${R} ${R} 0 0 1 ${Wp} ${R} V ${Hp - R} A ${R} ${R} 0 0 1 ${Wp - R} ${Hp} H 0 Z`
      : `M ${R} 0 H ${Wp - R} A ${R} ${R} 0 0 1 ${Wp} ${R} V ${Hp - R} A ${R} ${R} 0 0 1 ${Wp - R} ${Hp} H ${R} A ${R} ${R} 0 0 1 0 ${Hp - R} V ${R} A ${R} ${R} 0 0 1 ${R} 0 Z`;
    p.drawSvgPath(path, {
      x: x * k, y: AL - top * k,
      ...(o.color ? { color: o.color } : {}),
      ...(o.borde ? { borderColor: o.borde, borderWidth: (o.grosor ?? 1) * k } : { borderWidth: 0 }),
    });
  };
  const linea = (p: PDFPage, x1: number, y1: number, x2: number, y2: number, color: RGB, grosor = 1) => {
    p.drawLine({ start: { x: x1 * PX, y: AL - y1 * PX }, end: { x: x2 * PX, y: AL - y2 * PX }, color, thickness: grosor * PX });
  };

  /** Parte un texto en renglones que caben en `w` (una palabra más ancha se corta por caracteres). */
  const partir = (s: string, f: PDFFont, size: number, w: number): string[] => {
    const limpio = s;
    if (!limpio) return [];
    const out: string[] = [];
    let ln = "";
    const cabe = (x: string) => ancho(x, f, size) <= w + 0.01;
    for (const palabra of limpio.split(" ")) {
      const cand = ln ? `${ln} ${palabra}` : palabra;
      if (cabe(cand)) { ln = cand; continue; }
      if (ln) out.push(ln);
      if (cabe(palabra)) { ln = palabra; continue; }
      let trozo = "";
      for (const ch of Array.from(palabra)) {
        if (cabe(trozo + ch)) trozo += ch;
        else { if (trozo) out.push(trozo); trozo = ch; }
      }
      ln = trozo;
    }
    if (ln) out.push(ln);
    return out;
  };

  /** Texto con trozos en negrita, partido en renglones (cada renglón: sus fichas con su fuente). */
  const partirRico = (trozos: Trozo[], size: number, w: number): Ficha[][] => {
    const fichas: Ficha[] = [];
    let espacio = false;
    for (const t of trozos) {
      const partes = t.texto.split(/( +)/);
      for (const p of partes) {
        if (!p) continue;
        if (/^ +$/.test(p)) { espacio = true; continue; }
        fichas.push({ texto: p, f: t.f, espacio });
        espacio = false;
      }
    }
    const lineas: Ficha[][] = [];
    let actual: Ficha[] = [];
    let x = 0;
    for (const fi of fichas) {
      const sep = actual.length && fi.espacio ? ancho(" ", fi.f, size) : 0;
      const wf = ancho(fi.texto, fi.f, size);
      if (actual.length && x + sep + wf > w + 0.01) { lineas.push(actual); actual = []; x = 0; }
      if (!actual.length && wf > w) {
        // Una palabra más ancha que el renglón: se corta por caracteres.
        for (const tr of partir(fi.texto, fi.f, size, w)) { if (actual.length) lineas.push(actual); actual = [{ ...fi, texto: tr, espacio: false }]; x = ancho(tr, fi.f, size); }
        continue;
      }
      actual.push(actual.length ? fi : { ...fi, espacio: false });
      x += (actual.length > 1 ? sep : 0) + wf;
    }
    if (actual.length) lineas.push(actual);
    return lineas;
  };
    /** Dibuja un renglón rico juntando las fichas seguidas de la misma fuente. */
  const pintarRenglon = (r: Ficha[], x: number, b: number, size: number, color: RGB) => {
    let cx = x, xTramo = x, tramo = "";
    let fTramo: PDFFont | null = null;
    r.forEach((fi, i) => {
      const sep = i && fi.espacio ? ancho(" ", fi.f, size) : 0;
      if (tramo && fTramo === fi.f) { tramo += (sep ? " " : "") + fi.texto; cx += sep + ancho(fi.texto, fi.f, size); return; }
      if (tramo && fTramo) texto(pag, tramo, xTramo, b, fTramo, size, color);
      cx += sep; xTramo = cx; tramo = fi.texto; fTramo = fi.f; cx += ancho(fi.texto, fi.f, size);
    });
    if (tramo && fTramo) texto(pag, tramo, xTramo, b, fTramo, size, color);
  };
  /** Como `T`, pero conserva un espacio al principio o al final (separa trozos en negrita). */
  const Tesp = (s: unknown, max = MAX_TEXTO) => {
    const x = String(s ?? "");
    const m = T(x, max);
    const a = /^\s/.test(x) ? " " : "", z = /\s$/.test(x) ? " " : "";
    return m ? a + m + z : a || z;
  };
  const trozosFila = (f: FilaDoc, max = 400): Trozo[] => [
    { texto: T(f.rotulo, 80), f: neg },
    { texto: " ", f: reg },
    ...f.segmentos.map((s) => ({ texto: Tesp(s.texto, max), f: s.negrita ? neg : reg })),
  ];

  // ── Cajas (Datos del cliente, Empresa, Detalle) ─────────────────────────────
  const BOX = { borde: 1, padV: 8, padH: 10, tituloSize: 10, tituloLh: 14, filaSize: 10.5, filaLh: 14.7 };
  const medirTitulo = (t: string, w: number) => partir(MAY(t, 200), neg, BOX.tituloSize, w);
  /** Alto del encabezado de una caja (borde + padding + título + raya + su margen). */
  const altoCabezaCaja = (tit: string[]) => BOX.borde + BOX.padV + tit.length * BOX.tituloLh + 4 + 1 + 6;
  const pintarCabezaCaja = (x: number, top: number, w: number, tit: string[]) => {
    const xi = x + BOX.borde + BOX.padH, wi = w - 2 * (BOX.borde + BOX.padH);
    tit.forEach((l, k) => texto(pag, l, xi, base(top + BOX.borde + BOX.padV + k * BOX.tituloLh, BOX.tituloLh, BOX.tituloSize), neg, BOX.tituloSize, CP));
    const yRaya = top + BOX.borde + BOX.padV + tit.length * BOX.tituloLh + 4;
    rect(pag, xi, yRaya, wi, 1, { color: GRIS_LINEA });
  };
  const medirCaja = (c: CajaDoc, w: number) => {
    const wi = w - 2 * (BOX.borde + BOX.padH);
    const tit = medirTitulo(c.titulo, wi);
    const filas = c.filas.map((f) => partirRico(trozosFila(f), BOX.filaSize, wi));
    const cuerpo = filas.reduce((a, l) => a + Math.max(1, l.length) * BOX.filaLh, 0) + (filas.length ? 3 * (filas.length - 1) + 3 : 0);
    return { tit, filas, alto: altoCabezaCaja(tit) + cuerpo + BOX.padV + BOX.borde };
  };
  const pintarFilas = (filas: Ficha[][][], x: number, top: number) => {
    let yy = top;
    filas.forEach((lineas, i) => {
      if (i) yy += 3;
      lineas.forEach((r, k) => pintarRenglon(r, x, base(yy + k * BOX.filaLh, BOX.filaLh, BOX.filaSize), BOX.filaSize, TEXTO));
      yy += Math.max(1, lineas.length) * BOX.filaLh;
    });
    return yy;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // HOJA 1
  // ════════════════════════════════════════════════════════════════════════════
  nueva();

  // ── Datos del cliente | Empresa ──
  {
    const BW = (CW - 10) / 2;
    const a = medirCaja(d.cliente, BW), b = medirCaja(d.empresa, BW);
    const alto = Math.max(a.alto, b.alto);
    bloque(0);
    asegurar(alto);
    for (const [m, x] of [[a, MX], [b, MX + BW + 10]] as const) {
      redondeado(pag, x, y, BW, alto, 4, { borde: GRIS_BORDE });
      pintarCabezaCaja(x, y, BW, m.tit);
      pintarFilas(m.filas, x + BOX.borde + BOX.padH, y + altoCabezaCaja(m.tit));
    }
    y += alto;
    fin(10);
  }

  // ── Detalle del servicio ──
  {
    const det = d.detalle;
    const wi = CW - 2 * (BOX.borde + BOX.padH);
    const tit = medirTitulo(det.titulo, wi);
    const n = det.lugares.length;
    const colL = (wi - 6 * (n - 1)) / n;
    const lugares = det.lugares.map((f) => partirRico(trozosFila(f, 300), BOX.filaSize, colL));
    const altoLug = 3 + Math.max(...lugares.map((l) => Math.max(1, l.length))) * BOX.filaLh + 3;
    const asunto = det.asunto ? partirRico(trozosFila(det.asunto, 300), BOX.filaSize, wi) : null;
    const colF = (wi - 6) / 2;
    const fechas = det.fechas.map((f) => partirRico(trozosFila(f, 120), BOX.filaSize, colF));
    const filasF: Ficha[][][][] = [];
    for (let i = 0; i < fechas.length; i += 2) filasF.push(fechas.slice(i, i + 2));
    const altosF = filasF.map((fila) => 3 + Math.max(...fila.map((l) => Math.max(1, l.length))) * BOX.filaLh + 3);
    const altoFechas = altosF.reduce((a, h) => a + h, 0) + 6 * Math.max(0, altosF.length - 1);
    const altoAsunto = asunto ? 4 + asunto.length * BOX.filaLh : 0;
    const alto = altoCabezaCaja(tit) + altoLug + altoAsunto + 4 + altoFechas + BOX.padV + BOX.borde;
    bloque(0);
    asegurar(alto);
    redondeado(pag, MX, y, CW, alto, 4, { borde: GRIS_BORDE });
    pintarCabezaCaja(MX, y, CW, tit);
    const xi = MX + BOX.borde + BOX.padH;
    let yy = y + altoCabezaCaja(tit);
    lugares.forEach((l, i) => l.forEach((r, k) => pintarRenglon(r, xi + i * (colL + 6), base(yy + 3 + k * BOX.filaLh, BOX.filaLh, BOX.filaSize), BOX.filaSize, TEXTO)));
    yy += altoLug;
    if (asunto) {
      yy += 4;
      asunto.forEach((r, k) => pintarRenglon(r, xi, base(yy + k * BOX.filaLh, BOX.filaLh, BOX.filaSize), BOX.filaSize, TEXTO));
      yy += asunto.length * BOX.filaLh;
    }
    yy += 4;
    filasF.forEach((fila, j) => {
      fila.forEach((l, i) => l.forEach((r, k) => pintarRenglon(r, xi + i * (colF + 6), base(yy + 3 + k * BOX.filaLh, BOX.filaLh, BOX.filaSize), BOX.filaSize, TEXTO)));
      yy += altosF[j] + 6;
    });
    y += alto;
    fin(10);
  }

  // ── Cronograma de varios días (no lo tiene un traslado; se dibuja simple) ──
  if (d.cronograma) {
    const c = d.cronograma;
    const conRuta = c.encabezados.ruta != null;
    const cols = conRuta ? [70, 130, 0, 70, 150] : [80, 170, 0, 90, 0];
    const fijo = cols.reduce((a, b) => a + b, 0);
    if (conRuta) cols[2] = CW - fijo; else { cols[4] = CW - fijo; cols.splice(2, 1); }
    const enc = conRuta ? [c.encabezados.dia, c.encabezados.fecha, c.encabezados.ruta!, c.encabezados.salida, c.encabezados.fin] : [c.encabezados.dia, c.encabezados.fecha, c.encabezados.salida, c.encabezados.fin];
    const centro = conRuta ? [true, false, false, true, false] : [true, false, true, false];
    bloque(12);
    const tit = partir(MAY(c.titulo, 120), neg, 9, CW - 28);
    const altoTit = 16 + tit.length * 12.6 + 1;
    asegurar(altoTit + 20 + 25);
    rect(pag, MX, y, CW, altoTit, { color: mezcla(CP, BLANCO, 0x12 / 255) });
    tit.forEach((l, k) => texto(pag, l, MX + 14, base(y + 8 + k * 12.6, 12.6, 9), neg, 9, CP));
    y += altoTit;
    const cabecera = () => {
      rect(pag, MX, y, CW, 20.6, { color: mezcla(CP, BLANCO, 0x08 / 255) });
      let x = MX;
      enc.forEach((e, i) => {
        const s = MAY(e, 40);
        const xx = centro[i] ? x + (cols[i] - ancho(s, neg, 9)) / 2 : x + 8;
        texto(pag, s, xx, base(y + 4, 12.6, 9), neg, 9, CP);
        x += cols[i];
      });
      y += 20.6;
    };
    cabecera();
    for (const f of c.filas) {
      const ruta = f.ruta ? `${f.ruta.origen} → ${f.ruta.destino}` : "";
      const fin2 = f.fin.hora ? `${f.fin.hora} ${f.fin.etiqueta}` : f.fin.etiqueta;
      const celdas = conRuta ? [f.dia, f.fecha, ruta, f.salida, fin2] : [f.dia, f.fecha, f.salida, fin2];
      const partes = celdas.map((s, i) => partir(T(s, 200), i === 0 ? neg : reg, 10, cols[i] - 16));
      const alto = 10 + Math.max(...partes.map((p) => Math.max(1, p.length))) * 14;
      if (y + alto > LIMITE) { nueva(); cabecera(); }
      let x = MX;
      partes.forEach((p, i) => {
        p.forEach((l, k) => {
          const f2 = i === 0 ? neg : reg;
          const xx = centro[i] ? x + (cols[i] - ancho(l, f2, 10)) / 2 : x + 8;
          texto(pag, l, xx, base(y + 5 + k * 14, 14, 10), f2, 10, i === 0 ? CP : TEXTO);
        });
        x += cols[i];
      });
      y += alto;
      rect(pag, MX, y - 1, CW, 1, { color: hex("#f3f4f6") });
    }
    fin(16);
  }

  // ── Tabla de ítems con los totales dentro ──
  {
    const anchos = [40, CW - 415, 45, 55, 110, 55, 110];
    const alin: ("c" | "i" | "d")[] = ["c", "i", "c", "c", "d", "c", "d"];
    const enc = d.tabla.encabezados.map((e, i) => partir(T(e, 60), neg, 10, anchos[i] - 12));
    const altoEnc = 12 + Math.max(...enc.map((l) => Math.max(1, l.length))) * 14;
    const xs: number[] = [];
    anchos.reduce((x, w) => { xs.push(x); return x + w; }, MX);
    const cabecera = () => {
      rect(pag, MX, y, CW, altoEnc, { color: CP });
      enc.forEach((ls, i) => {
        const top = y + (altoEnc - ls.length * 14) / 2;
        ls.forEach((l, k) => {
          const xx = alin[i] === "i" ? xs[i] + 6 : xs[i] + (anchos[i] - ancho(l, neg, 10)) / 2;
          texto(pag, l, xx, base(top + k * 14, 14, 10), neg, 10, BLANCO);
        });
      });
      y += altoEnc;
    };
    bloque(10);
    const filas = d.tabla.filas.map((f) => {
      const celdas = [f.item, f.descripcion, f.dias, f.cantidad, f.punit, f.dscto, f.total].map((s, i) => partir(T(s, i === 1 ? MAX_TEXTO : 60), i === 6 ? neg : reg, 10.5, anchos[i] - 12));
      return { celdas, alto: 12 + Math.max(...celdas.map((l) => Math.max(1, l.length))) * 14.7 };
    });
    asegurar(altoEnc + (filas[0]?.alto ?? 0));
    cabecera();
    filas.forEach((f, n) => {
      if (y + f.alto > LIMITE) { nueva(); cabecera(); }
      if ((n + 1) % 2 === 0) rect(pag, MX, y, CW, f.alto, { color: ZEBRA });
      f.celdas.forEach((ls, i) => {
        rect(pag, xs[i], y, anchos[i], f.alto, { borde: GRIS_BORDE });
        const top = y + (f.alto - ls.length * 14.7) / 2;
        const fnt = i === 6 ? neg : reg;
        ls.forEach((l, k) => {
          const xx = alin[i] === "i" ? xs[i] + 6 : alin[i] === "d" ? xs[i] + anchos[i] - 6 - ancho(l, fnt, 10.5) : xs[i] + (anchos[i] - ancho(l, fnt, 10.5)) / 2;
          texto(pag, l, xx, base(top + k * 14.7, 14.7, 10.5), fnt, 10.5, TEXTO);
        });
      });
      y += f.alto;
    });

    // Los totales: una celda que ocupa las 7 columnas, con su propia tabla dentro (margen 10 arriba y abajo).
    const tot = d.totales;
    const filasT = [...tot.filas.map((f) => ({ ...f, total: false })), { ...tot.total, descuento: false, total: true }];
    const sizeDe = (esTotal: boolean) => (esTotal ? 13 : 10.5);
    const anchoEt = Math.max(...filasT.map((f) => ancho(T(f.rotulo, 40), neg, sizeDe(f.total)))) + 20;
    const anchoVal = Math.max(...filasT.map((f) => ancho(T(f.valor, 40), neg, sizeDe(f.total)))) + 20;
    // Reparto de la tabla automática: cada columna su contenido y el resto en proporción a él.
    const sobra = Math.max(0, CW - anchoEt - anchoVal);
    const colEt = anchoEt + sobra * (anchoEt / (anchoEt + anchoVal));
    const notas = tot.notas.map((n) => partir(T(n, 200), reg, 9, CW - 20));
    const altoFilas = filasT.reduce((a, f) => a + (f.total ? 8 + 13 * 1.4 + 2 : 8 + 14.7), 0);
    const altoNotas = notas.reduce((a, l) => a + 2 + Math.max(1, l.length) * 12.6, 0);
    const alto = 10 + altoFilas + altoNotas + 10;
    if (y + alto > LIMITE) { nueva(); cabecera(); }
    if ((filas.length + 1) % 2 === 0) rect(pag, MX, y, CW, alto, { color: ZEBRA });
    let yy = y + 10;
    filasT.forEach((f, i) => {
      const size = sizeDe(f.total);
      const lh = f.total ? 13 * 1.4 : 14.7;
      if (f.total) { rect(pag, MX, yy, CW, 2, { color: CP }); yy += 2; }
      else if ((i + 1) % 2 === 0) rect(pag, MX, yy, CW, 8 + lh, { color: ZEBRA });
      const et = T(f.rotulo, 40), val = T(f.valor, 40);
      const b = base(yy + 4, lh, size);
      texto(pag, et, MX + colEt - 10 - ancho(et, neg, size), b, neg, size, f.total ? CP : GRIS_555);
      texto(pag, val, MX + CW - 10 - ancho(val, neg, size), b, neg, size, f.total ? CP : f.descuento ? ROJO_DSCTO : TEXTO);
      yy += 8 + lh;
    });
    notas.forEach((ls) => {
      yy += 2;
      ls.forEach((l, k) => texto(pag, l, MX + CW - 10 - ancho(l, reg, 9), base(yy + k * 12.6, 12.6, 9), reg, 9, GRIS_6B));
      yy += Math.max(1, ls.length) * 12.6;
    });
    // El borde de la celda va al final: las franjas de las filas no lo pueden tapar.
    rect(pag, MX, y, CW, alto, { borde: GRIS_BORDE });
    y += alto;
    fin(10);
  }

  // ── La nota bajo los totales (la de disponibilidad del traslado) ──
  if (d.notaTotales) {
    const ls = partir(T(d.notaTotales, 400), neg, 10, CW - 3 - 20);
    const alto = 12 + ls.length * 14;
    bloque(-4);
    asegurar(alto);
    rect(pag, MX, y, CW, alto, { color: hex("#f1f5f9") });
    rect(pag, MX, y, 3, alto, { color: CP });
    ls.forEach((l, k) => texto(pag, l, MX + 3 + 10, base(y + 6 + k * 14, 14, 10), neg, 10, CP));
    y += alto;
    fin(10);
  }

  // ── Cuentas bancarias ──
  if (d.cuentas) {
    const c = d.cuentas;
    const colW = (CW - 8) / 2;
    const cajas = c.items.map((it) => {
      const banco = partir(T(it.banco, 120), neg, 10, colW - 18);
      const lineas = it.lineas.map((l) => partir(T(l, 160), reg, 9.5, colW - 18));
      const cuerpo = lineas.reduce((a, l) => a + Math.max(1, l.length) * 13.3, 0) + (lineas.length ? 3 + (lineas.length - 1) * 1 + 1 : 0);
      return { banco, lineas, alto: 1 + 6 + banco.length * 14 + cuerpo + 6 + 1 };
    });
    const filasC: (typeof cajas)[] = [];
    for (let i = 0; i < cajas.length; i += 2) filasC.push(cajas.slice(i, i + 2));
    const altosC = filasC.map((f) => Math.max(...f.map((x) => x.alto)));
    const cab = 2 + 10 + 15.4 + 6;
    bloque(12);
    asegurar(cab + (altosC[0] ?? 0));
    rect(pag, MX, y, CW, 2, { color: CP });
    texto(pag, T(c.titulo, 80), MX, base(y + 12, 15.4, 11), neg, 11, CP);
    y += cab;
    filasC.forEach((fila, j) => {
      if (j) { y += 8; asegurar(altosC[j]); }
      fila.forEach((cj, i) => {
        const x = MX + i * (colW + 8);
        redondeado(pag, x, y, colW, altosC[j], 4, { borde: BORDE_CUENTA });
        let yy = y + 1 + 6;
        cj.banco.forEach((l) => { texto(pag, l, x + 9, base(yy, 14, 10), neg, 10, CP); yy += 14; });
        if (cj.lineas.length) yy += 3;
        cj.lineas.forEach((ls, k) => {
          if (k) yy += 1;
          ls.forEach((l) => { texto(pag, l, x + 9, base(yy, 13.3, 9.5), reg, 9.5, TEXTO); yy += 13.3; });
        });
      });
      y += altosC[j];
    });
    fin(0);
  }

  // ── Anexo: programa detallado (el itinerario escrito; no lo tiene un traslado) ──
  if (d.anexo) {
    const a = d.anexo;
    const ACENTO = hex("#1d4ed8");
    nueva();
    const x0 = MX + 40, w0 = CW - 80;
    texto(pag, MAY(a.rotulo, 40), x0, base(y, 12.6, 9), neg, 9, ACENTO);
    texto(pag, T(a.titulo, 80), x0, base(y + 16.6, 28, 20), neg, 20, CP);
    const der = [{ s: T(`N° ${a.numero}`, 60), f: reg, size: 10, c: GRIS_6B }, { s: T(a.cliente, 80), f: neg, size: 12, c: CP }, ...(a.fecha ? [{ s: T(a.fecha, 60), f: reg, size: 10, c: GRIS_6B }] : [])];
    let yd = y;
    for (const r of der) { texto(pag, r.s, x0 + w0 - ancho(r.s, r.f, r.size), base(yd, r.size * 1.4, r.size), r.f, r.size, r.c); yd += r.size * 1.4 + 2; }
    y = Math.max(y + 16.6 + 28, yd) + 12;
    rect(pag, x0, y, w0, 3, { color: CP });
    y += 3 + 24;
    for (const l of a.lineas) {
      if (l.tipo === "vacia") { y += 5; continue; }
      if (l.tipo === "dia") {
        const ls = partir(T(l.texto, 200), neg, 13, w0 - 32);
        const alto = 16 + ls.length * 18.2;
        y += 16; asegurar(alto);
        rect(pag, x0, y, w0, alto, { color: mezcla(CP, BLANCO, 0x18 / 255) });
        rect(pag, x0, y, 4, alto, { color: CP });
        ls.forEach((s, k) => texto(pag, s, x0 + 18, base(y + 8 + k * 18.2, 18.2, 13), neg, 13, CP));
        y += alto + 8;
        continue;
      }
      if (l.tipo === "hora") {
        const ls = partir(T(l.texto, 600), reg, 11, w0 - 54);
        const alto = 10 + ls.length * 15.4;
        asegurar(alto);
        texto(pag, T(l.hora, 10), x0, base(y + 6, 14, 10), neg, 10, ACENTO);
        ls.forEach((s, k) => texto(pag, s, x0 + 54, base(y + 5 + k * 15.4, 15.4, 11), reg, 11, TEXTO));
        y += alto;
        rect(pag, x0, y - 1, w0, 1, { color: hex("#f3f4f6") });
        continue;
      }
      const ls = partir(T(l.texto, 600), reg, 11, w0);
      asegurar(8 + ls.length * 15.4);
      y += 4;
      ls.forEach((s) => { texto(pag, s, x0, base(y, 15.4, 11), reg, 11, TEXTO); y += 15.4; });
      y += 4;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // HOJA 2: Descripción de la unidad y condiciones
  // ════════════════════════════════════════════════════════════════════════════
  const p2 = d.pagina2;
  nueva();
  {
    const ls = partir(T(p2.titulo, 120), neg, 14, CW);
    y = TOP + 11.6;
    ls.forEach((l) => { texto(pag, l, MX, base(y, 19.6, 14), neg, 14, CP); y += 19.6; });
    y += 6;
    rect(pag, MX, y, CW, 2, { color: CP });
    y += 2;
    fin(16);
  }

  // ── Características de la unidad: descripción y fotos exterior / interior ──
  if (p2.caracteristicas) {
    const car = p2.caracteristicas;
    const wi = CW - 2 * (BOX.borde + BOX.padH);
    const tit = medirTitulo(car.titulo, wi);
    const vehs = car.vehiculos.map((v, i) => {
      const etiqueta = v.etiqueta ? partir(T(v.etiqueta, 200), neg, 10, wi) : [];
      const desc = partir(T(v.descripcion, 600), reg, 11, wi);
      const fs = [v.fotoExterior, v.fotoInterior].map((u) => (u ? fotos.get(u) ?? null : null)).filter((x): x is PDFImage => !!x);
      return { etiqueta, desc, fs };
    });
    // Separador entre unidades: margen 10 arriba (que colapsa con el de las fotos de la anterior), raya y 12.
    const altos = vehs.map((v, i) => (i ? (vehs[i - 1].fs.length ? 0 : 10) + 1 + 12 : 0)
      + (v.etiqueta.length ? v.etiqueta.length * 14 + 5 : 0) + v.desc.length * 15.4 + (v.fs.length ? 10 + 180 + 10 : 0));
    const ultimoConFotos = vehs.length > 0 && vehs[vehs.length - 1].fs.length > 0;
    const cuerpo = altos.reduce((a, h) => a + h, 0);
    // El margen superior de la fila (3) colapsa con el del título (6, ya contado); el inferior (3),
    // con el de las fotos (10) cuando son lo último.
    const alto = altoCabezaCaja(tit) + cuerpo + (ultimoConFotos ? 0 : 3) + BOX.padV + BOX.borde;
    bloque(0);
    asegurar(alto);
    redondeado(pag, MX, y, CW, alto, 4, { borde: GRIS_BORDE });
    pintarCabezaCaja(MX, y, CW, tit);
    const xi = MX + BOX.borde + BOX.padH;
    let yy = y + altoCabezaCaja(tit);
    vehs.forEach((v, i) => {
      if (i) { yy += vehs[i - 1].fs.length ? 0 : 10; rect(pag, xi, yy, wi, 1, { color: GRIS_LINEA }); yy += 1 + 12; }
      v.etiqueta.forEach((l) => { texto(pag, l, xi, base(yy, 14, 10), neg, 10, CP); yy += 14; });
      if (v.etiqueta.length) yy += 5;
      v.desc.forEach((l) => { texto(pag, l, xi, base(yy, 15.4, 11), reg, 11, DESC_UNIDAD); yy += 15.4; });
      if (v.fs.length) {
        yy += 10;
        const n = v.fs.length;
        const colW = (wi - 12 * (n - 1)) / n;
        v.fs.forEach((im, k) => {
          const x = xi + k * (colW + 12);
          redondeado(pag, x, yy, colW, 180, 8, { color: FONDO_FOTO, borde: GRIS_LINEA });
          // `contain` sin agrandar: max-width 100 % y max-height 180 px.
          const s = Math.min(1, (colW - 2) / im.width, 178 / im.height);
          const w = im.width * s, h = im.height * s;
          pag.drawImage(im, { x: (x + (colW - w) / 2) * PX, y: AL - (yy + (180 - h) / 2 + h) * PX, width: w * PX, height: h * PX });
        });
        yy += 180 + 10;
      }
    });
    y += alto;
    fin(10);
  }

  if (p2.saltoAntesDeCondiciones) nueva();

  // ── Servicio incluye | No incluye, y Consideraciones generales ──
  {
    const om = p2.omitirVacias;
    const vInc = listaVisible(p2.incluye, om), vNo = listaVisible(p2.noIncluye, om), vGen = listaVisible(p2.generales, om);
    const VERDE_T = hex("#166534"), VERDE_B = hex("#16a34a"), ROJO_T = hex("#991b1b"), ROJO_B = hex("#dc2626");
    const LIS = 10.5, LILH = 16.8, ICONO = 15;
    type Col = { lista: ListaDoc; color: RGB; borde: RGB; icono: "check" | "x" | "nota" };
    const medirCol = (c: Col, w: number) => {
      const tit = partir(MAY(c.lista.titulo, 80), neg, LIS, w - ICONO);
      const items = c.lista.items.map((it) => partir(T(it, 600), reg, LIS, w - 40));
      return { tit, items };
    };
    const altoTit = (tit: string[]) => tit.length * 14.7 + 3 + 2;
    const altoItems = (items: string[][]) => items.reduce((a, l) => a + Math.max(1, l.length) * LILH, 0);
    const icono = (k: Col["icono"], x: number, top: number, color: RGB) => {
      const s = 11, yb = top + (14.7 - s) / 2;
      if (k === "check") {
        redondeado(pag, x, yb, s, s, 2.5, { color: VERDE_B });
        linea(pag, x + 2.6, yb + 5.8, x + 4.7, yb + 8, BLANCO, 1.6);
        linea(pag, x + 4.7, yb + 8, x + 8.6, yb + 3.2, BLANCO, 1.6);
      } else if (k === "x") {
        linea(pag, x + 1.5, yb + 1.5, x + s - 1.5, yb + s - 1.5, ROJO_B, 2.2);
        linea(pag, x + s - 1.5, yb + 1.5, x + 1.5, yb + s - 1.5, ROJO_B, 2.2);
      } else {
        redondeado(pag, x + 1, yb, s - 2, s, 1.5, { borde: color, grosor: 1.2 });
        rect(pag, x + 3.5, yb - 1, s - 7, 2.5, { color });
        for (const dy of [4, 6.5, 9]) linea(pag, x + 3, yb + dy, x + s - 3, yb + dy, color, 0.8);
      }
    };
    const pintarTitulo = (c: Col, tit: string[], x: number, w: number) => {
      icono(c.icono, x, y, c.color);
      tit.forEach((l, k) => texto(pag, l, x + ICONO, base(y + k * 14.7, 14.7, LIS), neg, LIS, c.color));
      y += tit.length * 14.7 + 3;
      rect(pag, x, y, w, 2, { color: c.borde });
      y += 2;
    };
    const vineta = (x: number, top: number) => {
      pag.drawCircle({ x: (x + 40 - 13) * PX, y: AL - (top + LILH / 2) * PX, size: 1.9 * PX, color: LI });
    };
    const pintarItems = (items: string[][], x: number, partible: boolean) => {
      for (const ls of items) {
        const alto = Math.max(1, ls.length) * LILH;
        if (partible && y + alto > LIMITE) nueva();
        vineta(x, y);
        ls.forEach((l) => { texto(pag, l, x + 40, base(y, LILH, LIS), reg, LIS, LI); y += LILH; });
      }
    };

    // Las dos columnas: se dibujan juntas (no se parten entre hojas).
    if (vInc || vNo) {
      const colW = (CW - 12) / 2;
      const cols = [
        ...(vInc ? [{ lista: p2.incluye, color: VERDE_T, borde: VERDE_B, icono: "check" as const }] : []),
        ...(vNo ? [{ lista: p2.noIncluye, color: ROJO_T, borde: ROJO_B, icono: "x" as const }] : []),
      ];
      const med = cols.map((c) => medirCol(c, colW));
      const altos = med.map((m) => 8 + altoTit(m.tit) + 11 + altoItems(m.items) + 11);
      const alto = Math.max(...altos);
      bloque(0);
      asegurar(alto);
      const y0 = y;
      cols.forEach((c, i) => {
        const x = MX + i * (colW + 12);
        y = y0 + 8;
        pintarTitulo(c, med[i].tit, x, colW);
        y += 11;
        pintarItems(med[i].items, x, false);
      });
      y = y0 + alto;
      fin(10);
    }
    if (vGen) {
      const c: Col = { lista: p2.generales, color: CP, borde: CP, icono: "nota" };
      const m = medirCol(c, CW);
      bloque(8);
      asegurar(altoTit(m.tit) + 11 + (m.items[0] ? Math.max(1, m.items[0].length) * LILH : 0));
      pintarTitulo(c, m.tit, MX, CW);
      y += 11;
      pintarItems(m.items, MX, true);
      fin(11);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CABECERA, PIE Y MARCA DE AGUA EN CADA HOJA
  // ════════════════════════════════════════════════════════════════════════════
  const titulo = T(d.titulo, 120);
  const subtitulo = T(d.subtitulo, 200);
  const SUB = mezcla(BLANCO, CP, 0.72);
  // La tarjeta del logo: se ajusta al logo (entre 140 y 175 px) o, sin logo, al nombre de la empresa.
  let lw = 0, lh = 0;
  let nombreCard: string[] = [];
  let sizeNombre = 12;
  if (logo) {
    const s = Math.min(1, 140 / logo.width, 54 / logo.height);
    lw = logo.width * s; lh = logo.height * s;
  } else {
    const nombre = T(d.empresaNombre, 120);
    for (sizeNombre = 12; sizeNombre >= 8; sizeNombre -= 1) {
      nombreCard = partir(nombre, neg, sizeNombre, 175 - 32);
      if (nombreCard.length * sizeNombre * 1.2 <= 54) break;
    }
    nombreCard = nombreCard.slice(0, Math.max(1, Math.floor(54 / (sizeNombre * 1.2))));
    lw = Math.max(0, ...nombreCard.map((l) => ancho(l, neg, sizeNombre)));
    lh = nombreCard.length * sizeNombre * 1.2;
  }
  const card = Math.min(175, Math.max(140, lw + 32));
  // El título se achica si no cabe entre la tarjeta y el margen derecho.
  let sizeTit = 16;
  while (sizeTit > 9 && ancho(titulo, neg, sizeTit) > W - card - 48) sizeTit -= 0.5;

  const pie = d.pie.map((p) => T(p.texto, 200)).filter(Boolean);
  const sepPie = "|";
  const GAP = 14;
  // Los renglones del pie (flex con wrap): partes con un separador entre las de un mismo renglón, centrados.
  const renglonesPie: string[][] = [];
  {
    const wSep = ancho(sepPie, reg, 9);
    let actual: string[] = [], wAct = 0;
    for (const p of pie) {
      const w = ancho(p, reg, 8.5);
      if (actual.length && wAct + GAP + wSep + GAP + w > W - 40) { renglonesPie.push(actual); actual = []; wAct = 0; }
      if (actual.length) { actual.push(sepPie); wAct += GAP + wSep + GAP; }
      actual.push(p); wAct += w;
    }
    if (actual.length) renglonesPie.push(actual);
  }
  const LH_PIE = 12.6;
  const altoPie = renglonesPie.length ? 18 + renglonesPie.length * LH_PIE : 18;
  const SEP = mezcla(BLANCO, CP, 0.4);

  paginas.forEach((p) => {
    // Cabecera.
    rect(p, 0, 0, W, CAB, { color: CP });
    redondeado(p, 0, 0, card, CAB, 20, { color: BLANCO, soloDerecha: true });
    if (logo) {
      const x = 14 + (card - 32 - lw) / 2, top = (CAB - lh) / 2;
      p.drawImage(logo, { x: x * PX, y: AL - (top + lh) * PX, width: lw * PX, height: lh * PX });
    } else {
      let top = (CAB - lh) / 2;
      for (const l of nombreCard) {
        texto(p, l, 14 + (card - 32 - ancho(l, neg, sizeNombre)) / 2, base(top, sizeNombre * 1.2, sizeNombre), neg, sizeNombre, CP, "cabecera");
        top += sizeNombre * 1.2;
      }
    }
    const altoBloque = sizeTit * 1.4 + 3 + 9.5 * 1.4;
    const top = (CAB - altoBloque) / 2;
    texto(p, titulo, W - 24 - ancho(titulo, neg, sizeTit), base(top, sizeTit * 1.4, sizeTit), neg, sizeTit, BLANCO, "cabecera");
    texto(p, subtitulo, W - 24 - ancho(subtitulo, reg, 9.5), base(top + sizeTit * 1.4 + 3, 9.5 * 1.4, 9.5), reg, 9.5, SUB, "cabecera");

    // Pie.
    rect(p, 0, H - altoPie, W, altoPie, { color: CP });
    renglonesPie.forEach((r, k) => {
      const anchos = r.map((it) => ancho(it, reg, it === sepPie ? 9 : 8.5));
      const total = anchos.reduce((a, b) => a + b, 0) + GAP * (r.length - 1);
      let x = (W - total) / 2;
      const top = H - altoPie + 9 + k * LH_PIE;
      r.forEach((it, i) => {
        const sep = it === sepPie;
        texto(p, it, x, base(top, LH_PIE, sep ? 9 : 8.5), reg, sep ? 9 : 8.5, sep ? SEP : BLANCO, "pie");
        x += anchos[i] + GAP;
      });
    });

    // Marca de agua.
    if (opts.marcaAgua) {
      const mk = T(opts.marcaAgua, 40);
      const size = 54;
      const w = neg.widthOfTextAtSize(mk, size);
      const ang = (35 * Math.PI) / 180;
      p.drawText(mk, {
        x: AN / 2 - (w / 2) * Math.cos(ang), y: AL / 2 - (w / 2) * Math.sin(ang),
        size, font: neg, color: CP, opacity: 0.08, rotate: degrees(35),
      });
      traza?.push({ pagina: paginas.indexOf(p) + 1, zona: "marca", texto: mk });
    }
  });

  return doc.save();
}

/** Las medidas de la hoja, para la matriz (px CSS). */
export const GEOMETRIA_CORPORATIVO = { PX, ancho: W, alto: H, margenLateral: MX, cabecera: CAB, cuerpoDesde: TOP, cuerpoHasta: LIMITE } as const;
