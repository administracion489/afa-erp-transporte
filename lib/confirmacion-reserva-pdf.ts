// ──────────────────────────────────────────────────────────────────────────────
// lib/confirmacion-reserva-pdf.ts — Dibuja en el SERVIDOR (pdf-lib) la Confirmación de Reserva.
// No lee la base ni decide qué se imprime: recibe `DocConfirmacion` (lib/confirmacion-reserva.ts)
// y el logo ya bajado y comprobado (`bajarLogo`, lib/traslados/enviar-cotizacion-datos.ts).
//
// Una hoja A4, letra grande y una sola columna de datos (etiqueta · valor): se lee entera en un
// teléfono al abrirla desde WhatsApp sin hacer zoom lateral. Si el contenido no cabe (varias
// notas largas) sigue en una segunda hoja con la misma cabecera, nunca se recorta un dato.
// Todo texto pasa por `aWinAnsi`: pdf-lib LANZA con un carácter que Helvetica no tiene, y la
// dirección o la nota las escribe una persona. Sin logo NO se usa el del bundle (es el de otra
// empresa, y este ERP se vende): la cabecera lleva el nombre de la empresa.
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { aWinAnsi } from "./pdf-winansi";
import { COLOR_CORPORATIVO } from "./cotizacion-corporativo";
import type { DocConfirmacion } from "./confirmacion-reserva";
import type { ImagenPdf } from "./pdf-corporativo";

const AN = 595.28, AL = 841.89;
const MX = 40;
const CW = AN - 2 * MX;
const CAB = 80;
const PIE = 70;

const hex = (c: string): RGB => {
  const s = /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1) : "0b315f";
  return rgb(parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255);
};
const AZUL = hex(COLOR_CORPORATIVO);
const BLANCO = rgb(1, 1, 1);
const TEXTO = hex("#1f2937");
const GRIS = hex("#6b7280");
const LINEA = hex("#e5e7eb");
const FONDO = hex("#f3f6fa");

/** Las líneas de `texto` que caben en `ancho` (parte por palabras; una palabra enorme, por letras). */
function partir(texto: string, f: PDFFont, size: number, ancho: number): string[] {
  const out: string[] = [];
  let linea = "";
  for (const palabra of texto.split(" ")) {
    const cand = linea ? `${linea} ${palabra}` : palabra;
    if (f.widthOfTextAtSize(cand, size) <= ancho) { linea = cand; continue; }
    if (linea) out.push(linea);
    let p = palabra;
    while (f.widthOfTextAtSize(p, size) > ancho && p.length > 1) {
      let i = p.length - 1;
      while (i > 1 && f.widthOfTextAtSize(p.slice(0, i), size) > ancho) i--;
      out.push(p.slice(0, i));
      p = p.slice(i);
    }
    linea = p;
  }
  if (linea) out.push(linea);
  return out.length ? out : [""];
}

/**
 * `logoClaro`: el logo es la versión para fondos oscuros (`logo_claro_url`) y va directo sobre
 * la cabecera azul. Sin él, el logo principal (letras azules) va dentro de un recuadro blanco
 * — sobre el azul no se leería.
 */
export async function dibujarConfirmacion(d: DocConfirmacion, opts: { logo?: ImagenPdf | null; logoClaro?: boolean; empresa: string; marcaAgua?: string | null }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(d.titulo);
  doc.setCreator(opts.empresa);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const neg = await doc.embedFont(StandardFonts.HelveticaBold);
  const juego: ReadonlySet<number> = new Set(reg.getCharacterSet());
  const w = (s: string, max?: number) => aWinAnsi(s, juego, max);

  let logo: PDFImage | null = null;
  if (opts.logo) {
    try { logo = opts.logo.tipo === "jpg" ? await doc.embedJpg(new Uint8Array(opts.logo.bytes)) : await doc.embedPng(new Uint8Array(opts.logo.bytes)); }
    catch { logo = null; }
  }

  let pagina: PDFPage = doc.addPage([AN, AL]);
  let y = 0;

  const cabecera = (p: PDFPage) => {
    p.drawRectangle({ x: 0, y: AL - CAB, width: AN, height: CAB, color: AZUL });
    let xTitulo = MX;
    if (logo) {
      const alto = 46, ancho = Math.min(130, (logo.width / logo.height) * alto);
      if (!opts.logoClaro) p.drawRectangle({ x: MX - 6, y: AL - CAB / 2 - alto / 2 - 6, width: ancho + 12, height: alto + 12, color: BLANCO });
      p.drawImage(logo, { x: MX, y: AL - CAB / 2 - alto / 2, width: ancho, height: alto });
      xTitulo = MX + ancho + 24;
    } else {
      p.drawText(w(opts.empresa, 40), { x: MX, y: AL - CAB / 2 + 14, size: 11, font: neg, color: BLANCO });
    }
    const titulo = w(d.titulo);
    let size = 20;
    while (size > 12 && neg.widthOfTextAtSize(titulo, size) > AN - MX - xTitulo) size--;
    const tw = neg.widthOfTextAtSize(titulo, size);
    p.drawText(titulo, { x: AN - MX - tw, y: AL - CAB / 2 - 2, size, font: neg, color: BLANCO });
    const cod = w(d.cabecera[0] ? `${d.cabecera[0].label}: ${d.cabecera[0].valor}` : "");
    const cw = reg.widthOfTextAtSize(cod, 10);
    p.drawText(cod, { x: AN - MX - cw, y: AL - CAB / 2 - 20, size: 10, font: reg, color: BLANCO });
    if (opts.marcaAgua) {
      p.drawText(w(opts.marcaAgua), { x: MX, y: AL / 2, size: 60, font: neg, color: hex("#fca5a5"), opacity: 0.35 });
    }
    return AL - CAB - 18;
  };
  y = cabecera(pagina);

  const pie = (p: PDFPage, n: number) => {
    p.drawLine({ start: { x: MX, y: PIE }, end: { x: AN - MX, y: PIE }, thickness: 0.6, color: LINEA });
    let yy = PIE - 13;
    for (const l of d.pie) {
      for (const s of partir(w(l, 400), reg, 8.5, CW)) {
        p.drawText(s, { x: MX, y: yy, size: 8.5, font: reg, color: GRIS });
        yy -= 11;
      }
    }
    const t = `${n}`;
    p.drawText(t, { x: AN - MX - reg.widthOfTextAtSize(t, 8), y: 18, size: 8, font: reg, color: GRIS });
  };
  let nPag = 1;
  const necesita = (alto: number) => {
    if (y - alto >= PIE + 10) return;
    pie(pagina, nPag);
    pagina = doc.addPage([AN, AL]);
    nPag++;
    y = cabecera(pagina);
  };

  // Fila de datos de cabecera (código, versión, emisión, cotización), en recuadro claro.
  const cab = d.cabecera.slice(1);
  if (cab.length) {
    const alto = 32;
    pagina.drawRectangle({ x: MX, y: y - alto, width: CW, height: alto, color: FONDO });
    const col = CW / cab.length;
    cab.forEach((c, i) => {
      pagina.drawText(w(c.label.toUpperCase()), { x: MX + 10 + i * col, y: y - 13, size: 7.5, font: neg, color: GRIS });
      pagina.drawText(w(c.valor, 40), { x: MX + 10 + i * col, y: y - 26, size: 10.5, font: neg, color: TEXTO });
    });
    y -= alto + 8;
  }

  const LABEL = 150;
  const fila = (label: string, valor: string) => {
    const lineas = partir(w(valor, 600), reg, 10.5, CW - LABEL - 8);
    const lab = partir(w(label), reg, 9, LABEL - 8);
    const alto = Math.max(lineas.length * 13, lab.length * 11) + 4;
    necesita(alto);
    lab.forEach((s, i) => pagina.drawText(s, { x: MX, y: y - 10 - i * 11, size: 9, font: reg, color: GRIS }));
    lineas.forEach((s, i) => pagina.drawText(s, { x: MX + LABEL, y: y - 10 - i * 13, size: 10.5, font: neg, color: TEXTO }));
    y -= alto;
  };

  // Una sección corta no se parte entre dos hojas: si no cabe entera, empieza en la siguiente.
  const altoSeccion = (s: DocConfirmacion["secciones"][number]) =>
    (s.titulo ? 27 : 0) + (s.subtitulo ? 21 : 0) + s.filas.length * 17 + (s.nota ? 14 * Math.ceil(s.nota.length / 95) : 0);

  for (const s of d.secciones) {
    const h = altoSeccion(s);
    if (h < AL - CAB - PIE - 60) necesita(h);
    if (s.titulo) {
      necesita(40);
      y -= 4;
      pagina.drawText(w(s.titulo), { x: MX, y: y - 10, size: 10, font: neg, color: AZUL });
      y -= 14;
      pagina.drawLine({ start: { x: MX, y }, end: { x: AN - MX, y }, thickness: 1, color: AZUL });
      y -= 6;
    }
    if (s.subtitulo) {
      necesita(36);
      const t = w(s.subtitulo);
      const tw = neg.widthOfTextAtSize(t, 8.5) + 14;
      pagina.drawRectangle({ x: MX, y: y - 15, width: tw, height: 15, color: FONDO, borderColor: AZUL, borderWidth: 0.6 });
      pagina.drawText(t, { x: MX + 7, y: y - 11, size: 8.5, font: neg, color: AZUL });
      y -= 21;
    }
    for (const f of s.filas) fila(f.label, f.valor);
    if (s.nota) {
      const lineas = partir(w(s.nota, 600), reg, 9.5, CW);
      necesita(lineas.length * 12.5 + 6);
      lineas.forEach((l, i) => pagina.drawText(l, { x: MX, y: y - 10 - i * 12.5, size: 9.5, font: reg, color: TEXTO }));
      y -= lineas.length * 12.5 + 6;
    }
    y -= 2;
  }
  pie(pagina, nPag);
  return await doc.save();
}
