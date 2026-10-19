// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/pdf-traslado.ts — Dibuja el PDF de la cotización de traslado. Solo pdf-lib: no lee
// la base ni descarga nada (el logo llega en bytes; lo baja el servidor con sus topes).
//
// Fuentes estándar (Helvetica y Helvetica-Bold, WinAnsi): no hay que empaquetar ninguna fuente y
// cubren el castellano (á, ñ, «», °, ·, €). Lo que no cubren —un emoji, una flecha que escribió el
// cliente— hace LANZAR a pdf-lib, así que TODO texto pasa por `aWinAnsi` con el juego de
// caracteres de la propia fuente antes de medirlo o dibujarlo.
//
// El contenido (qué se imprime) lo decide lib/traslados/cotizacion-traslado.ts; aquí solo se
// decide CÓMO se ve: A4, legible en un teléfono (cuerpo de 10.5 pt), y con salto de página si los
// textos del cliente o las consideraciones lo alargan.
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { aWinAnsi, colorValido, type ContenidoPdf } from "./cotizacion-traslado";

const A4: [number, number] = [595.28, 841.89];
const M = 42;                  // margen lateral
const ANCHO = A4[0] - 2 * M;   // ancho útil
const PIE = 46;                // alto reservado al pie
const MAX_TEXTO = 2000;        // ningún texto suelto pasa de esto (el PDF no es un vertedero)

const hex = (c: string): [number, number, number] => {
  const s = colorValido(c).slice(1);
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
};
/** Mezcla con blanco: t = 0 el color, t = 1 blanco. */
const tinte = (c: [number, number, number], t: number): RGB => rgb(c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t);

const NEGRO = rgb(0.13, 0.15, 0.18);
const GRIS = rgb(0.42, 0.45, 0.5);
const LINEA = rgb(0.86, 0.88, 0.9);
const BLANCO = rgb(1, 1, 1);

export async function dibujarPdfTraslado(
  c: ContenidoPdf,
  logo?: { bytes: Uint8Array; tipo: "png" | "jpg" } | null,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fuente = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const juego: ReadonlySet<number> = new Set(fuente.getCharacterSet());
  const t = (s: unknown, max = MAX_TEXTO) => aWinAnsi(String(s ?? ""), juego, max);

  const prim = hex(c.color);
  const PRIM = rgb(prim[0], prim[1], prim[2]);
  const SUAVE = tinte(prim, 0.92);

  doc.setTitle(t(`${c.titulo} N° ${c.numero}`, 200) || "Cotización");
  if (!c.perfilSinConfigurar) { doc.setAuthor(t(c.empresa.nombre, 200)); doc.setCreator(t(c.empresa.nombre, 200)); }
  doc.setProducer("pdf-lib");

  let imagen: PDFImage | null = null;
  if (logo?.bytes?.length) {
    try { imagen = logo.tipo === "jpg" ? await doc.embedJpg(logo.bytes) : await doc.embedPng(logo.bytes); }
    catch { imagen = null; /* un logo corrupto no impide la cotización: sale sin logo */ }
  }

  // ── Página y cursor ────────────────────────────────────────────────────────
  const paginas: PDFPage[] = [];
  let pag!: PDFPage;
  let y = 0;
  const nueva = (primera = false) => {
    pag = doc.addPage(A4);
    paginas.push(pag);
    pag.drawRectangle({ x: 0, y: A4[1] - 7, width: A4[0], height: 7, color: PRIM });
    y = A4[1] - 7 - 26;
    if (!primera) {
      const cab = t(`${c.titulo} N° ${c.numero}`, 120);
      pag.drawText(cab, { x: M, y, size: 9, font: negrita, color: GRIS });
      y -= 22;
    }
  };
  const asegurar = (alto: number) => { if (y - alto < M + PIE) nueva(); };

  /** Parte un texto en líneas que caben en `ancho` (las palabras más largas que el ancho se cortan). */
  const partir = (texto: string, f: PDFFont, size: number, ancho: number): string[] => {
    const limpio = t(texto);
    if (!limpio) return [];
    const out: string[] = [];
    let linea = "";
    const cabe = (s: string) => f.widthOfTextAtSize(s, size) <= ancho;
    for (const palabra of limpio.split(" ")) {
      const cand = linea ? `${linea} ${palabra}` : palabra;
      if (cabe(cand)) { linea = cand; continue; }
      if (linea) out.push(linea);
      if (cabe(palabra)) { linea = palabra; continue; }
      // Palabra más ancha que la línea (una URL, un «aaaa…»): se corta por caracteres.
      let trozo = "";
      for (const ch of Array.from(palabra)) {
        if (cabe(trozo + ch)) trozo += ch;
        else { if (trozo) out.push(trozo); trozo = ch; }
      }
      linea = trozo;
    }
    if (linea) out.push(linea);
    return out;
  };

  const escribir = (texto: string, o: { x?: number; ancho?: number; f?: PDFFont; size?: number; color?: RGB; interlinea?: number; derecha?: boolean }) => {
    const f = o.f ?? fuente, size = o.size ?? 10.5, x = o.x ?? M, ancho = o.ancho ?? ANCHO;
    const alto = o.interlinea ?? size * 1.35;
    for (const l of partir(texto, f, size, ancho)) {
      asegurar(alto);
      const xx = o.derecha ? x + ancho - f.widthOfTextAtSize(l, size) : x;
      pag.drawText(l, { x: xx, y: y - size, size, font: f, color: o.color ?? NEGRO });
      y -= alto;
    }
  };

  const titulo = (texto: string) => {
    asegurar(40);
    y -= 10;
    pag.drawText(t(texto, 80).toUpperCase(), { x: M, y: y - 10, size: 10, font: negrita, color: PRIM });
    y -= 16;
    pag.drawRectangle({ x: M, y: y, width: ANCHO, height: 1, color: tinte(prim, 0.6) });
    y -= 8;
  };

  // ── 1. Cabecera: logo y empresa ────────────────────────────────────────────
  nueva(true);
  const arriba = y + 10;
  let bajoLogo = arriba;
  if (imagen) {
    const esc = Math.min(150 / imagen.width, 56 / imagen.height, 1);
    const w = imagen.width * esc, h = imagen.height * esc;
    pag.drawImage(imagen, { x: M, y: arriba - h, width: w, height: h });
    bajoLogo = arriba - h;
  }
  const anchoEmp = imagen ? 300 : ANCHO;
  const xEmp = M + ANCHO - anchoEmp;
  y = arriba;
  escribir(c.empresa.nombre, { x: xEmp, ancho: anchoEmp, f: negrita, size: 13, color: c.perfilSinConfigurar ? rgb(0.72, 0.12, 0.12) : NEGRO, derecha: !!imagen });
  for (const l of c.empresa.lineas) escribir(l, { x: xEmp, ancho: anchoEmp, size: 8.5, color: GRIS, interlinea: 11.5, derecha: !!imagen });
  y = Math.min(y, bajoLogo) - 20;

  // ── 2. Título, número y fecha ──────────────────────────────────────────────
  const tit = t(c.titulo, 60).toUpperCase();
  pag.drawText(tit, { x: M, y: y - 18, size: 18, font: negrita, color: PRIM });
  const num = t(`N° ${c.numero}`, 40);
  pag.drawText(num, { x: M + ANCHO - negrita.widthOfTextAtSize(num, 12.5), y: y - 14, size: 12.5, font: negrita, color: NEGRO });
  const fec = t(`Fecha: ${c.fecha}`, 40);
  pag.drawText(fec, { x: M + ANCHO - fuente.widthOfTextAtSize(fec, 9.5), y: y - 28, size: 9.5, font: fuente, color: GRIS });
  y -= 36;
  pag.drawRectangle({ x: M, y, width: ANCHO, height: 2, color: PRIM });
  y -= 14;
  if (c.atencion) {
    const et = "Atención: ";
    const wEt = negrita.widthOfTextAtSize(et, 10.5);
    pag.drawText(et, { x: M, y: y - 10.5, size: 10.5, font: negrita, color: NEGRO });
    escribir(c.atencion, { x: M + wEt, ancho: ANCHO - wEt, size: 10.5 });
    y -= 2;
  }

  // ── 3. Datos del servicio ──────────────────────────────────────────────────
  titulo("Datos del servicio");
  const wEt = 112;
  const filasServ = c.servicio.map((s) => ({ et: t(s.etiqueta, 40), lineas: partir(s.valor, fuente, 10.5, ANCHO - wEt - 16) }));
  const altoServ = filasServ.reduce((a, f) => a + Math.max(1, f.lineas.length) * 14.2 + 5, 0) + 10;
  if (y - altoServ >= M + PIE) pag.drawRectangle({ x: M, y: y - altoServ, width: ANCHO, height: altoServ, color: SUAVE });
  y -= 6;
  for (const f of filasServ) {
    asegurar(15);
    pag.drawText(f.et, { x: M + 10, y: y - 10, size: 9.5, font: negrita, color: GRIS });
    const lineas = f.lineas.length ? f.lineas : ["—"];
    for (const l of lineas) {
      asegurar(14.2);
      pag.drawText(l, { x: M + wEt + 6, y: y - 10.5, size: 10.5, font: fuente, color: NEGRO });
      y -= 14.2;
    }
    y -= 5;
  }
  y -= 4;

  // ── 4. Tabla de precios ────────────────────────────────────────────────────
  titulo("Precio");
  const anchos = [ANCHO - 58 - 108 - 100, 58, 108, 100];
  const xs = [M, M + anchos[0], M + anchos[0] + anchos[1], M + anchos[0] + anchos[1] + anchos[2]];
  const cabecera = () => {
    asegurar(24);
    pag.drawRectangle({ x: M, y: y - 20, width: ANCHO, height: 20, color: PRIM });
    c.tabla.encabezados.forEach((h, i) => {
      const s = t(h, 30);
      const x = i === 0 ? xs[0] + 8 : xs[i] + anchos[i] - 8 - negrita.widthOfTextAtSize(s, 9);
      pag.drawText(s, { x, y: y - 13.5, size: 9, font: negrita, color: BLANCO });
    });
    y -= 20;
  };
  cabecera();
  for (const fila of c.tabla.filas) {
    const desc = partir(fila[0], fuente, 10, anchos[0] - 16);
    const alto = Math.max(1, desc.length) * 13.5 + 10;
    if (y - alto < M + PIE) { nueva(); cabecera(); }
    const top = y;
    desc.forEach((l, k) => pag.drawText(l, { x: xs[0] + 8, y: top - 15 - k * 13.5, size: 10, font: fuente, color: NEGRO }));
    for (let i = 1; i < 4; i++) {
      const s = t(fila[i], 30);
      const f = i === 3 ? negrita : fuente;
      pag.drawText(s, { x: xs[i] + anchos[i] - 8 - f.widthOfTextAtSize(s, 10), y: top - 15, size: 10, font: f, color: NEGRO });
    }
    y -= alto;
    pag.drawRectangle({ x: M, y, width: ANCHO, height: 0.8, color: LINEA });
  }

  // ── 5. Totales ─────────────────────────────────────────────────────────────
  y -= 6;
  const wTot = 250, xTot = M + ANCHO - wTot;
  for (const tot of c.totales) {
    const alto = tot.fuerte ? 24 : 17;
    asegurar(alto + 2);
    const f = tot.fuerte ? negrita : fuente;
    const size = tot.fuerte ? 12 : 10;
    if (tot.fuerte) pag.drawRectangle({ x: xTot, y: y - alto, width: wTot, height: alto, color: PRIM });
    const color = tot.fuerte ? BLANCO : NEGRO;
    const et = t(tot.etiqueta, 40), val = t(tot.valor, 40);
    const base = y - (tot.fuerte ? 16 : 12);
    pag.drawText(et, { x: xTot + 10, y: base, size, font: f, color: tot.fuerte ? BLANCO : GRIS });
    pag.drawText(val, { x: xTot + wTot - 10 - f.widthOfTextAtSize(val, size), y: base, size, font: f, color });
    y -= alto + (tot.fuerte ? 2 : 0);
  }
  if (c.validez) {
    y -= 8;
    escribir(`Válida hasta el ${c.validez}`, { x: xTot, ancho: wTot, f: negrita, size: 10.5, color: PRIM, derecha: true });
  }

  // ── 6. La línea fija ───────────────────────────────────────────────────────
  y -= 12;
  const lAviso = partir(c.aviso, negrita, 10.5, ANCHO - 30);
  const altoAviso = lAviso.length * 14 + 14;
  asegurar(altoAviso);
  pag.drawRectangle({ x: M, y: y - altoAviso, width: ANCHO, height: altoAviso, color: SUAVE });
  pag.drawRectangle({ x: M, y: y - altoAviso, width: 4, height: altoAviso, color: PRIM });
  lAviso.forEach((l, k) => pag.drawText(l, { x: M + 16, y: y - 17 - k * 14, size: 10.5, font: negrita, color: NEGRO }));
  y -= altoAviso + 4;

  // ── 7. Consideraciones ─────────────────────────────────────────────────────
  for (const bloque of c.consideraciones) {
    titulo(bloque.titulo);
    for (const l of bloque.lineas) {
      const lineas = partir(l, fuente, 9.5, ANCHO - 16);
      lineas.forEach((s, k) => {
        asegurar(13);
        if (k === 0) pag.drawText(t("•"), { x: M + 2, y: y - 9.5, size: 9.5, font: fuente, color: PRIM });
        pag.drawText(s, { x: M + 14, y: y - 9.5, size: 9.5, font: fuente, color: NEGRO });
        y -= 13;
      });
      y -= 2;
    }
  }

  // ── 8. Pie y marca de agua en todas las páginas ────────────────────────────
  const total = paginas.length;
  paginas.forEach((p, i) => {
    if (c.marcaAgua) {
      const mk = t(c.marcaAgua, 40);
      const size = 54;
      const w = negrita.widthOfTextAtSize(mk, size);
      const ang = 35 * Math.PI / 180;
      p.drawText(mk, {
        x: A4[0] / 2 - (w / 2) * Math.cos(ang), y: A4[1] / 2 - (w / 2) * Math.sin(ang),
        size, font: negrita, color: PRIM, opacity: 0.08, rotate: degrees(35),
      });
    }
    p.drawRectangle({ x: M, y: M + 18, width: ANCHO, height: 0.8, color: LINEA });
    const pie = partir(c.pie, fuente, 8, ANCHO - 90)[0] ?? "";
    if (pie) p.drawText(pie, { x: M, y: M + 6, size: 8, font: fuente, color: GRIS });
    const n = t(`Página ${i + 1} de ${total}`);
    p.drawText(n, { x: M + ANCHO - fuente.widthOfTextAtSize(n, 8), y: M + 6, size: 8, font: fuente, color: GRIS });
  });

  return doc.save();
}
