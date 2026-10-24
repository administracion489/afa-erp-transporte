// scripts/prueba-licitaciones-expediente.mts — Matriz de lib/licitaciones/pdf/expediente.ts (el PDF de
// cada bloque del expediente: portada separadora, fichas, cuadro de experiencia, tablas, unión de PDF
// e imágenes, folios) y de lib/zip-sin-compresion.ts.
//   npx tsx scripts/prueba-licitaciones-expediente.mts
//   MUESTRA_DIR=/ruta npx tsx scripts/prueba-licitaciones-expediente.mts   (deja PDF y ZIP de muestra)
//
// Fija: un PDF con /Encrypt en el trailer (hecho a mano) es `pdf_protegido` — también si el /Encrypt
// apunta a un objeto que no existe (pdf-lib lo daría por bueno) —, basura es `pdf_ilegible`, y NUNCA se
// lee con ignoreEncryption (R11); portada + PDF de 2 págs + PNG + JPEG = 5 páginas; lo que no se puede
// unir se OMITE con su código y el bloque sale igual; la portada es UNA hoja aunque la lista no quepa;
// el cuadro de experiencia no suma PEN con USD; `mapaFolios` ascendente/descendente con y sin portadas
// (casos exactos); `foliar` escribe el folio correcto en TODAS las páginas (traza) y sale DERECHO y en
// la esquina que se VE en hojas giradas, recortadas o con la matriz del contenido sin cerrar (lo lee
// pdftotext si está instalado); y el ciclo ZIP: armarZip → XLSX.CFB / python zipfile devuelven los
// mismos bytes y nombres con tildes, y el CRC coincide con zlib.crc32.

import { PDFDocument, StandardFonts, degrees, concatTransformationMatrix } from "pdf-lib";
import * as XLSX from "xlsx";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  revisarPdf, armarBloque, mapaFolios, foliar, unirPdfs, textoFolio, textoRangoFolios, formatoDeBytes,
  orientacionJpeg, declaraCifrado, filaTotalesCuadro, importeTexto, fechaCorta, MAX_COLUMNAS_VERTICAL, escalaFolio,
  type ComunBloque, type CuadroExperienciaPdf,
} from "../lib/licitaciones/pdf/expediente";
import { armarZip, crc32, LIMITES_ZIP, problemaNombreZip, fechaDos, ErrorZip } from "../lib/zip-sin-compresion";
import type { BloqueExpedienteResuelto, OpcionesFoliado, TrazaLic, FichaUnidad, ParteFuente } from "../lib/licitaciones/tipos";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const enc = new TextEncoder();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lic-exp-"));
const tiene = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };

// ══ Fixtures ═══════════════════════════════════════════════════════════════════

/** PDF clásico escrito a mano (objetos + xref + trailer), con lo que se le pida en el trailer. */
function pdfAMano(objetos: string[], trailerExtra: string): Uint8Array {
  let s = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offs: number[] = [];
  objetos.forEach((o, i) => { offs.push(Buffer.byteLength(s, "latin1")); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(s, "latin1");
  s += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) s += `${String(o).padStart(10, "0")} 00000 n \n`;
  s += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, "latin1"));
}
const OBJ_BASE = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
];
const DICT_CIFRADO = "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A> /U <B5A4C8C0A9E2A3E9B6F4E4A8D2C3E1F0A9B8C7D6E5F4A3B2C1D0E9F8A7B6C5D4> /P -3904 >>";
const ID = "/ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]";
const PDF_CIFRADO = pdfAMano([...OBJ_BASE, DICT_CIFRADO], `/Encrypt 4 0 R ${ID}`);
const PDF_CIFRADO_SOLO_PROPIETARIO = pdfAMano([...OBJ_BASE, DICT_CIFRADO.replace("/P -3904", "/P -44")], `/Encrypt 4 0 R ${ID}`);
const PDF_ENCRYPT_HUERFANO = pdfAMano([...OBJ_BASE], `/Encrypt 9 0 R ${ID}`);
const PDF_ENCRYPT_EN_LINEA = pdfAMano([...OBJ_BASE], `/Encrypt ${DICT_CIFRADO} ${ID}`);
const PDF_A_MANO_SANO = pdfAMano([...OBJ_BASE], ID);

async function pdfDePaginas(n: number, o: { rot?: number; crop?: [number, number, number, number]; ctmSinCerrar?: boolean; tam?: [number, number] } = {}): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = d.addPage(o.tam ?? [595.28, 841.89]);
    p.drawText(`Documento de prueba · hoja ${i + 1}`, { x: 60, y: p.getHeight() - 80, size: 14, font: f });
    if (o.rot) p.setRotation(degrees(o.rot));
    if (o.crop) p.setCropBox(...o.crop);
    if (o.ctmSinCerrar) p.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 0, 0)); // sin q/Q: deja la matriz cambiada
  }
  return d.save();
}

/** PNG RGB mínimo (sin dependencias: deflate + CRC propios). */
function png(w: number, h: number, color: [number, number, number]): Uint8Array {
  const crudo = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { crudo[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) crudo.set(color, y * (w * 3 + 1) + 1 + x * 3); }
  const trozo = (tipo: string, datos: Buffer) => {
    const t = Buffer.concat([Buffer.from(tipo, "latin1"), datos]);
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(new Uint8Array(t)));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo("IHDR", ihdr), trozo("IDAT", zlib.deflateSync(crudo)), trozo("IEND", Buffer.alloc(0))]));
}
async function jpeg(w: number, h: number, orientacion?: number, svg?: string): Promise<Uint8Array> {
  let s = svg ? sharp(Buffer.from(svg)).resize(w, h) : sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } } });
  s = s.jpeg({ quality: 80 });
  if (orientacion) s = s.withMetadata({ orientation: orientacion });
  return new Uint8Array(await s.toBuffer());
}

const OP: OpcionesFoliado = { modo: "ascendente", formato: "Folio {n}", digitos: 3, posicion: "inferior_derecha", foliarPortadas: true, foliarBloquesSueltos: true };
const comunVacio = (o: Partial<ComunBloque> = {}): ComunBloque => ({ cabecera: "Propuesta Técnica – Licitación Cliente Ejemplo", color: "#1f3c78", logo: null, firma: null, archivos: {}, imagenes: {}, propuesta: null, ...o });
const sep = (o: Partial<BloqueExpedienteResuelto["separador"]> = {}) => ({ titulo: "SECCIÓN II", subtitulo: "REQUISITOS LEGALES", referencia: "Sección IV de las bases", contenido: ["Copia literal de partida registral (antigüedad no mayor a 30 días)", "Copia del DNI del representante legal", "Vigencia de poder del representante legal", "Copia de la Ficha RUC actualizada"], ...o });
const textos = (tz: TrazaLic[], pagina?: number) => tz.filter((t) => pagina == null || t.pagina === pagina).map((t) => t.texto);
const unido = (tz: TrazaLic[], pagina?: number) => textos(tz, pagina).join(" ");
async function tamanos(bytes: Uint8Array) { const d = await PDFDocument.load(bytes); return d.getPages().map((p) => [p.getWidth(), p.getHeight()] as [number, number]); }

// ══ 1. revisarPdf ══════════════════════════════════════════════════════════════
sec("1. revisarPdf: cifrado, ilegible, sano");
{
  const r1 = await revisarPdf(PDF_CIFRADO);
  check(!r1.ok && r1.codigo === "pdf_protegido", `/Encrypt en el trailer → pdf_protegido: ${JSON.stringify(r1)}`);
  const r2 = await revisarPdf(PDF_CIFRADO_SOLO_PROPIETARIO);
  check(!r2.ok && r2.codigo === "pdf_protegido", "solo contraseña de propietario → pdf_protegido (R11: se omite igual)");
  const r3 = await revisarPdf(PDF_ENCRYPT_HUERFANO);
  check(!r3.ok && r3.codigo === "pdf_protegido", `/Encrypt a un objeto que no existe (pdf-lib lo daría por bueno) → pdf_protegido: ${JSON.stringify(r3)}`);
  let pdflibLoAcepta = false;
  try { await PDFDocument.load(PDF_ENCRYPT_HUERFANO); pdflibLoAcepta = true; } catch { /* */ }
  check(pdflibLoAcepta, "(el caso existe: pdf-lib carga ese PDF sin quejarse)");
  const r4 = await revisarPdf(PDF_ENCRYPT_EN_LINEA);
  check(!r4.ok && r4.codigo === "pdf_protegido", "/Encrypt << … >> en línea → pdf_protegido");
  const r5 = await revisarPdf(enc.encode("esto es basura y no un PDF"));
  check(!r5.ok && r5.codigo === "pdf_ilegible" && /%PDF-/.test(r5.detalle), `basura → pdf_ilegible nombrando el encabezado: ${JSON.stringify(r5)}`);
  const r6 = await revisarPdf(enc.encode("%PDF-1.4\nhola, sin objetos ni trailer\n%%EOF"));
  check(!r6.ok && r6.codigo === "pdf_ilegible", "encabezado sin cuerpo → pdf_ilegible");
  const r7 = await revisarPdf(new Uint8Array(0));
  check(!r7.ok && r7.codigo === "pdf_ilegible", "vacío → pdf_ilegible");
  const r8 = await revisarPdf(PDF_A_MANO_SANO);
  check(r8.ok && r8.paginas === 1, `PDF a mano sin cifrar → ok, 1 página: ${JSON.stringify(r8)}`);
  const r9 = await revisarPdf(await pdfDePaginas(2));
  check(r9.ok && r9.paginas === 2, "PDF de pdf-lib → ok, 2 páginas");
  check(declaraCifrado(PDF_CIFRADO) && declaraCifrado(PDF_ENCRYPT_EN_LINEA) && !declaraCifrado(PDF_A_MANO_SANO), "declaraCifrado mira /Encrypt <ref|dict>");
  check(!declaraCifrado(enc.encode("<< /EncryptMetadata false >>")), "/EncryptMetadata no es /Encrypt");
  const fuente = fs.readFileSync(new URL("../lib/licitaciones/pdf/expediente.ts", import.meta.url), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  check(!/ignoreEncryption/.test(fuente), "el código (sin comentarios) no usa ignoreEncryption en ningún sitio (R11)");
}

// ══ 2. Formato e imagen ════════════════════════════════════════════════════════
sec("2. Formato por firma y orientación EXIF");
const PNG_APAISADO = png(300, 150, [200, 60, 60]);
const JPG_O6 = await jpeg(400, 200, 6);          // guardado apaisado; se ve VERTICAL
const JPG_O1 = await jpeg(200, 300);
{
  check(formatoDeBytes(PNG_APAISADO) === "png" && formatoDeBytes(JPG_O6) === "jpg" && formatoDeBytes(PDF_A_MANO_SANO) === "pdf", "png · jpg · pdf por la firma");
  check(formatoDeBytes(enc.encode("hola mundo")) === null, "otra cosa → null");
  check(orientacionJpeg(JPG_O6) === 6 && orientacionJpeg(JPG_O1) === 1 && orientacionJpeg(await jpeg(50, 40, 8)) === 8 && orientacionJpeg(await jpeg(50, 40, 3)) === 3, "EXIF 6 · 1 · 8 · 3");
  check(orientacionJpeg(await jpeg(50, 40, 5)) === 6 && orientacionJpeg(await jpeg(50, 40, 7)) === 8, "espejados 5 → 6, 7 → 8");
  check(orientacionJpeg(PNG_APAISADO) === 1 && orientacionJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00])) === 1, "PNG y JPEG truncado → 1 (sin lanzar)");

  // El giro dibujado ≡ el auto-orientado de sharp: un bloque rojo en la esquina superior izquierda de lo
  // GUARDADO tiene que caer, en la hoja rasterizada, en el mismo cuadrante que en `sharp().rotate()`.
  if (tiene("pdftoppm")) {
    const svgMarca = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#0000ff"/><rect width="200" height="100" fill="#ff0000"/></svg>`;
    const cuadrante = (rgbs: Uint8Array, w: number, h: number, canales: number, recorte?: { x0: number; y0: number; x1: number; y1: number }) => {
      let sx = 0, sy = 0, n = 0;
      const r0 = recorte ?? { x0: 0, y0: 0, x1: w, y1: h };
      for (let y = r0.y0; y < r0.y1; y++) for (let x = r0.x0; x < r0.x1; x++) {
        const i = (y * w + x) * canales;
        if (rgbs[i] > 180 && rgbs[i + 1] < 90 && rgbs[i + 2] < 90) { sx += x - r0.x0; sy += y - r0.y0; n++; }
      }
      if (!n) return "sin rojo";
      return `${sy / n < (r0.y1 - r0.y0) / 2 ? "arriba" : "abajo"}-${sx / n < (r0.x1 - r0.x0) / 2 ? "izq" : "der"}`;
    };
    for (const o of [1, 3, 6, 8]) {
      const jpg = new Uint8Array(await sharp(Buffer.from(svgMarca)).jpeg({ quality: 95 }).withMetadata({ orientation: o }).toBuffer());
      const ref = await sharp(Buffer.from(jpg)).rotate().raw().toBuffer({ resolveWithObject: true });
      const esperado = cuadrante(new Uint8Array(ref.data), ref.info.width, ref.info.height, ref.info.channels);
      const r = await armarBloque({ id: "rot", separador: sep(), conPortada: false, partes: [{ tipo: "archivo", itemId: "i", titulo: "Img", url: "u", nombre: "i.jpg", origen: "storage_privado", etiquetaFuente: "x" }] }, comunVacio({ archivos: { u: { bytes: jpg, formato: "jpg" } } }));
      const fpdf = path.join(TMP, `rot-${o}.pdf`);
      fs.writeFileSync(fpdf, r.bytes);
      execFileSync("pdftoppm", ["-r", "20", "-singlefile", fpdf, path.join(TMP, `rot-${o}`)]);
      const ppm = fs.readFileSync(path.join(TMP, `rot-${o}.ppm`));
      const cab = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString("latin1"))!;
      const w = Number(cab[1]), h = Number(cab[2]);
      const px = new Uint8Array(ppm.subarray(cab[0].length));
      // Recorte a la imagen: lo que no es blanco.
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; if (px[i] + px[i + 1] + px[i + 2] < 700) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); } }
      const visto = cuadrante(px, w, h, 3, { x0, y0, x1, y1 });
      const formaOk = (ref.info.width > ref.info.height) === (x1 - x0 > y1 - y0);
      check(visto === esperado && formaOk, `EXIF ${o}: el rojo cae ${visto} como en sharp (${esperado}) y la forma coincide`);
    }
  } else console.log("  (pdftoppm no está instalado: se omite el cotejo del giro EXIF)");
}

// ══ 3. armarBloque: unión ══════════════════════════════════════════════════════
sec("3. armarBloque: portada + PDF (2) + PNG + JPEG = 5 páginas");
const PDF2 = await pdfDePaginas(2);
{
  const bloque: BloqueExpedienteResuelto = { id: "b1", separador: sep(), conPortada: true, partes: [
    { tipo: "archivo", itemId: "i1", titulo: "Copia literal", url: "u:pdf", nombre: "literal.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
    { tipo: "archivo", itemId: "i2", titulo: "DNI", url: "u:png", nombre: "dni.png", origen: "storage_privado", etiquetaFuente: "Legajo" },
    { tipo: "archivo", itemId: "i3", titulo: "Vigencia", url: "u:jpg", nombre: "vigencia.jpg", origen: "storage_publico", etiquetaFuente: "Legajo" },
  ] };
  const tz: TrazaLic[] = [];
  const r = await armarBloque(bloque, comunVacio({ archivos: { "u:pdf": { bytes: PDF2, formato: "pdf" }, "u:png": { bytes: PNG_APAISADO, formato: "png" }, "u:jpg": { bytes: JPG_O6, formato: "jpg" } } }), { traza: tz });
  check(r.paginas === 5, `5 páginas (portada + 2 + 1 + 1): ${r.paginas}`);
  check(JSON.stringify(r.paginasPorParte) === JSON.stringify([{ itemId: "i1", paginas: 2 }, { itemId: "i2", paginas: 1 }, { itemId: "i3", paginas: 1 }]), `páginas por parte: ${JSON.stringify(r.paginasPorParte)}`);
  check(r.omitidos.length === 0, "nada omitido");
  const ts = await tamanos(r.bytes);
  check(ts.length === 5, "el PDF guardado tiene 5 páginas");
  check(ts[3][0] > ts[3][1], "el PNG apaisado va en hoja horizontal");
  check(ts[4][0] < ts[4][1], "el JPEG guardado apaisado con EXIF 6 se VE vertical → hoja vertical");
  check(tz.every((t) => t.pagina === 1), "en la traza solo hay textos de la portada (lo copiado no se dibuja)");
  const p1 = unido(tz, 1);
  for (const t of ["SECCIÓN II", "REQUISITOS LEGALES", "Sección IV de las bases", "Contenido:", "Copia del DNI del representante legal", "Propuesta Técnica – Licitación Cliente Ejemplo"]) check(p1.includes(t), `portada lleva «${t}»`);
  const yTit = tz.find((t) => t.texto === "SECCIÓN II")!.y, ySub = tz.find((t) => t.texto === "REQUISITOS LEGALES")!.y, yRef = tz.find((t) => t.texto.startsWith("Sección IV"))!.y;
  check(yTit > ySub && ySub > yRef, "orden de lectura: título arriba, banda, referencia");
  check(tz.find((t) => t.texto.startsWith("Propuesta Técnica"))!.zona === "cabecera", "la cabecera va en zona cabecera");
  const enMargen = tz.filter((t) => t.zona !== "folio").every((t) => t.x >= 56 && t.x + t.ancho <= 595.28 - 56 + 0.5);
  check(enMargen, "todo texto de la portada dentro de los márgenes");
  const doc = await PDFDocument.load(r.bytes);
  check(doc.getTitle() === "SECCIÓN II – REQUISITOS LEGALES", `título del PDF: ${doc.getTitle()}`);
}

sec("4. armarBloque: lo que no se puede unir se OMITE con su código");
{
  const partes: ParteFuente[] = [
    { tipo: "faltante", itemId: "f1", titulo: "Plan SST", codigo: "expediente_item_sin_archivo" },
    { tipo: "archivo", itemId: "a1", titulo: "Ficha RUC", url: "u:null", nombre: "ruc.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
    { tipo: "archivo", itemId: "a2", titulo: "SOAT", url: "https://drive.google.com/x", nombre: "soat", origen: "externo", etiquetaFuente: "Unidad" },
    { tipo: "archivo", itemId: "a3", titulo: "Póliza cifrada", url: "u:cif", nombre: "poliza.pdf", origen: "storage_privado", etiquetaFuente: "Seguro" },
    { tipo: "archivo", itemId: "a4", titulo: "Basura", url: "u:bas", nombre: "x.pdf", origen: "storage_privado", etiquetaFuente: "Adjunto" },
    { tipo: "archivo", itemId: "a5", titulo: "No es imagen", url: "u:noimg", nombre: "x.png", origen: "storage_privado", etiquetaFuente: "Adjunto" },
    { tipo: "archivo", itemId: "a6", titulo: "Sin entregar", url: "u:ausente", nombre: "y.pdf", origen: "storage_privado", etiquetaFuente: "Adjunto" },
    { tipo: "archivo", itemId: "a7", titulo: "Vacío", url: "", nombre: "", origen: "vacio", etiquetaFuente: "Adjunto" },
    { tipo: "propuesta", itemId: "p1" },
    { tipo: "archivo", itemId: "ok1", titulo: "Bueno", url: "u:pdf", nombre: "b.pdf", origen: "storage_privado", etiquetaFuente: "Adjunto" },
    { tipo: "archivo", itemId: "a8", titulo: "Huérfano", url: "u:huer", nombre: "h.pdf", origen: "storage_privado", etiquetaFuente: "Adjunto" },
  ];
  let lanzo = false;
  let r: Awaited<ReturnType<typeof armarBloque>> | null = null;
  try {
    r = await armarBloque({ id: "b2", separador: sep(), conPortada: false, partes }, comunVacio({ archivos: {
      "u:null": null, "u:cif": { bytes: PDF_CIFRADO, formato: "pdf" }, "u:bas": { bytes: enc.encode("%PDF-1.7 basura"), formato: "pdf" },
      "u:noimg": { bytes: enc.encode("GIF89a no soportado"), formato: "png" }, "u:pdf": { bytes: PDF2, formato: "pdf" },
      "u:huer": { bytes: PDF_ENCRYPT_HUERFANO, formato: "pdf" },
    } }));
  } catch (e) { lanzo = true; console.log(e); }
  check(!lanzo && r, "no lanza");
  if (r) {
    const cod = Object.fromEntries(r.omitidos.map((o) => [o.itemId, o.codigo]));
    check(cod.f1 === "expediente_item_sin_archivo", "faltante → su propio código");
    check(cod.a1 === "archivo_no_descargable", "archivo null → archivo_no_descargable");
    check(cod.a2 === "expediente_item_archivo_externo", "enlace externo → expediente_item_archivo_externo");
    check(cod.a3 === "pdf_protegido", "PDF cifrado → pdf_protegido (R11)");
    check(cod.a4 === "pdf_ilegible", "PDF dañado → pdf_ilegible");
    check(cod.a5 === "archivo_formato_no_soportado", "ni PDF ni PNG ni JPEG → archivo_formato_no_soportado");
    check(cod.a6 === "archivo_no_descargable", "url sin entrada en archivos → archivo_no_descargable");
    check(cod.a7 === "expediente_item_sin_archivo", "origen vacío → expediente_item_sin_archivo");
    check(cod.p1 === "expediente_item_sin_archivo", "propuesta null → omitida");
    check(cod.a8 === "pdf_protegido", "/Encrypt huérfano → pdf_protegido");
    check(!("ok1" in cod) && r.paginas === 2, `lo bueno entra igual (2 págs, sin portada): ${r.paginas}`);
    check(r.omitidos.every((o) => o.bloqueId === "b2" && o.titulo && o.detalle), "cada omitido nombra bloque, título y detalle");
    check(r.omitidos.find((o) => o.itemId === "a3")!.url === "u:cif", "el omitido conserva su url");
    check(r.paginasPorParte.length === partes.length && r.paginasPorParte.filter((p) => p.paginas === 0).length === partes.length - 1, "una entrada por parte; las omitidas con 0 páginas");
  }
  const prop = await pdfDePaginas(3);
  const r2 = await armarBloque({ id: "b3", separador: sep(), conPortada: true, partes: [{ tipo: "propuesta", itemId: "p" }] }, comunVacio({ propuesta: prop }));
  check(r2.paginas === 4 && r2.paginasPorParte[0].paginas === 3, "la propuesta se inserta entera (portada + 3)");
  const r3 = await armarBloque({ id: "b4", separador: sep(), conPortada: true, partes: [] }, comunVacio());
  check(r3.paginas === 1, "bloque sin partes: solo la portada");
  const r4 = await armarBloque({ id: "b5", separador: sep(), conPortada: false, partes: [{ tipo: "faltante", itemId: "x", titulo: "Nada", codigo: "expediente_item_sin_archivo" }] }, comunVacio());
  check(r4.paginas === 0 && (await PDFDocument.load(r4.bytes)).getPageCount() === 0, "sin portada y todo omitido: 0 páginas DE VERDAD (pdf-lib no le agrega una hoja en blanco)");
}

sec("5. Portada: UNA hoja aunque la lista no quepa; sin subtítulo, el título va en la banda");
{
  const tz: TrazaLic[] = [];
  const muchos = Array.from({ length: 200 }, (_, i) => `Documento número ${i + 1} con un nombre bastante largo para que ocupe espacio en la hoja`);
  const r = await armarBloque({ id: "b", separador: sep({ contenido: muchos }), conPortada: true, partes: [] }, comunVacio(), { traza: tz });
  check(r.paginas === 1, `200 documentos → 1 hoja: ${r.paginas}`);
  const mas = tz.find((t) => /^… y \d+ documentos más$/.test(t.texto));
  check(!!mas, "corta con «… y N documentos más»");
  const n = Number(/y (\d+)/.exec(mas?.texto ?? "")?.[1] ?? 0);
  const listados = tz.filter((t) => t.texto === "•").length;
  check(listados + n === 200, `listados + «más» = 200: ${listados} + ${n}`);
  check(tz.every((t) => t.y >= 64 - 0.5), "nada baja del cuerpo de la hoja");
  const tz2: TrazaLic[] = [];
  await armarBloque({ id: "b", separador: sep({ subtitulo: "", contenido: [] }), conPortada: true, partes: [] }, comunVacio(), { traza: tz2 });
  const t2 = tz2.find((t) => t.texto === "SECCIÓN II");
  check(!!t2 && !tz2.some((t) => t.texto === "Contenido:"), "sin subtítulo ni contenido: el título solo, sin «Contenido:»");
  check(tz2.filter((t) => t.texto === "SECCIÓN II").length === 1, "el título no se repite arriba y en la banda");
  const tz3: TrazaLic[] = [];
  await armarBloque({ id: "b", separador: sep({ titulo: "ANEXO 3 ✓ → ok", subtitulo: "EXPERIENCIA 😀" }), conPortada: true, partes: [] }, comunVacio(), { traza: tz3 });
  check(tz3.some((t) => t.texto === "ANEXO 3 -> ok") && tz3.some((t) => t.texto === "EXPERIENCIA"), "lo que Helvetica no tiene se cambia o se quita (aWinAnsi), sin lanzar");
}

// ══ 6. Ficha técnica ═══════════════════════════════════════════════════════════
sec("6. Ficha técnica por unidad");
const FICHA: FichaUnidad = {
  codigo: "U1", rol: "titular", uso: "Ruta 1", placa: "ABC-123", marcaModelo: "Marca Modelo 50", anio: null, capacidad: 50,
  flota: "Tercerizada · Transportes Ejemplo S.A.C.", fotoExternaUrl: "f:ext", fotoInternaUrl: "f:int",
  documentos: [
    { tipo: "SOAT", numero: "123-456", vence: "2027-03-31", estado: "Vigente", adjunto: true },
    { tipo: "Revisión Técnica (CITV)", numero: null, vence: null, estado: "Sin fecha", adjunto: false },
  ],
};
{
  const tz: TrazaLic[] = [];
  const r = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "ficha_unidad", itemId: "fu", ficha: FICHA }] },
    comunVacio({ imagenes: { "f:ext": { bytes: await jpeg(320, 200), tipo: "jpg" }, "f:int": { bytes: png(200, 300, [90, 160, 90]), tipo: "png" } } }), { traza: tz });
  check(r.paginas === 1 && r.paginasPorParte[0].paginas === 1, "una hoja por unidad");
  const s = unido(tz);
  for (const t of ["FICHA TÉCNICA DE LA UNIDAD U1", "ABC-123", "Marca Modelo 50", "50 asientos", "Titular", "Sin dato", "Vista exterior", "Vista interior", "Documentos de la unidad", "SOAT", "31/03/2027", "Sí", "No", "Tercerizada · Transportes Ejemplo S.A.C."]) check(s.includes(t), `ficha lleva «${t}»`);
  check(r.avisos.length === 0, "con las dos fotos no hay avisos");
  const tz2: TrazaLic[] = [];
  const r2 = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "ficha_unidad", itemId: "fu", ficha: { ...FICHA, fotoInternaUrl: null } }] },
    comunVacio({ imagenes: { "f:ext": null } }), { traza: tz2 });
  check(!unido(tz2).includes("Vista exterior") && r2.avisos.some((a) => /foto exterior/.test(a)), "foto con url pero sin bajar: no se dibuja y se avisa");
  const tz3: TrazaLic[] = [];
  await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "ficha_unidad", itemId: "fu", ficha: { ...FICHA, documentos: [], fotoExternaUrl: null, fotoInternaUrl: null } }] }, comunVacio(), { traza: tz3 });
  check(unido(tz3).includes("Sin documentos registrados para esta unidad."), "sin documentos lo dice");
}

// ══ 7. Cuadro de experiencia ═══════════════════════════════════════════════════
sec("7. Cuadro de experiencia: horizontal, totales por moneda, firma");
const CUADRO: CuadroExperienciaPdf = {
  encabezado: ["ANEXO 3 · EXPERIENCIA DE LA EMPRESA CONCURSANTE", "Señores", "**COMITÉ DE SELECCIÓN DE CLIENTE EJEMPLO**", "Presente. -"],
  introduccion: "Mediante el presente, el suscrito detalla lo siguiente como experiencia en la actividad.",
  tabla: {
    columnas: ["N.º", "CLIENTE", "DATOS DE CONTACTO", "OBJETO", "INICIO", "FIN", "OC / COMPROB.", "FECHA", "RUTA / ZONA", "IMPORTE"],
    filas: [
      ["1", "CLIENTE UNO S.A.C.", "PERSONA A – 900 000 001", "TRANSPORTE DE PERSONAL", "02/2023", "02/2026", "OC/FACTURA", "2023", "Lima y Callao", importeTexto("PEN", 1000)],
      ["2", "CLIENTE DOS S.A.", "PERSONA B – 900 000 002", "TRANSPORTE DE PERSONAL", "01/2024", "VIGENTE", "FACTURA", "2024", "Lima Sur", importeTexto("USD", 500)],
    ],
    pie: null,
  },
  totales: [{ moneda: "PEN", importe: 1000 }, { moneda: "USD", importe: 500 }],
  firmante: { nombre: "NOMBRE DEL REPRESENTANTE", dni: "00000000", cargo: "Gerente General", firmaUrl: "firma:1" },
  lugarFecha: "Lima, 21 de septiembre de 2026",
};
{
  const tz: TrazaLic[] = [];
  const firmaPng = png(120, 40, [20, 20, 120]);
  const r = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "cuadro_experiencia", itemId: "cx", cuadro: CUADRO }] },
    comunVacio({ imagenes: { "firma:1": { bytes: firmaPng, tipo: "png" } } }), { traza: tz });
  const ts = await tamanos(r.bytes);
  check(ts.length === 1 && ts[0][0] > ts[0][1], "una hoja A4 horizontal");
  const s = textos(tz);
  check(s.includes("S/ 1,000.00") && s.includes("US$ 500.00"), "un total por moneda, cada uno con su signo");
  check(!s.some((t) => /1,500/.test(t)), "PEN y USD NUNCA se suman");
  check(s.includes("TOTAL:"), "fila «TOTAL:»");
  const tot = tz.filter((t) => t.texto === "S/ 1,000.00" || t.texto === "US$ 500.00");
  check(tot.length >= 3 && new Set(tot.filter((t) => t.texto === "US$ 500.00").map((t) => Math.round(t.y))).size === 2, "los totales van uno debajo de otro (y distinto)");
  const titulo = tz.find((t) => t.texto.startsWith("ANEXO 3"))!;
  check(Math.abs(titulo.x + titulo.ancho / 2 - 841.89 / 2) < 1, "encabezado[0] es el título, centrado");
  check(tz.some((t) => t.texto === "COMITÉ DE SELECCIÓN DE CLIENTE EJEMPLO"), "**negrita** del encabezado sin asteriscos");
  for (const t of ["Lima, 21 de septiembre de 2026", "NOMBRE DEL REPRESENTANTE", "DNI N° 00000000", "Gerente General"]) check(s.includes(t), `cuadro lleva «${t}»`);
  check(tz.every((t) => t.x >= 42 && t.x + t.ancho <= 841.89 - 42 + 0.5), "todo dentro de los márgenes de la hoja horizontal");
  check(r.avisos.length === 0, "sin avisos con la firma bajada");
  const tz2: TrazaLic[] = [];
  const r2 = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "cuadro_experiencia", itemId: "cx", cuadro: { ...CUADRO, tabla: { ...CUADRO.tabla, pie: ["", "TOTAL:", "", "", "", "", "", "", "", "S/ 9,999.00"] } } }] }, comunVacio(), { traza: tz2 });
  const cuenta = (tz_: TrazaLic[], t: string) => textos(tz_).filter((x) => x === t).length;
  check(cuenta(tz2, "S/ 9,999.00") === 1 && cuenta(tz2, "TOTAL:") === 1, "con tabla.pie, se imprime el pie TAL CUAL (una sola fila de total)");
  check(cuenta(tz2, "US$ 500.00") === 1 && cuenta(tz2, "S/ 1,000.00") === 1, "con pie, los totales por moneda NO se agregan (cada importe solo en su fila)");
  check(cuenta(tz, "US$ 500.00") === 2 && cuenta(tz, "S/ 1,000.00") === 2 && cuenta(tz, "TOTAL:") === 1, "sin pie: cada importe en su fila y una vez en el total");
  check(r2.avisos.some((a) => /firma/.test(a)), "firmaUrl sin imagen → aviso, va solo la línea");
  check(JSON.stringify(filaTotalesCuadro(4, [{ moneda: "PEN", importe: 1 }, { moneda: "USD", importe: 2 }])) === JSON.stringify(["", "TOTAL:", "", "S/ 1.00\nUS$ 2.00"]), "filaTotalesCuadro: etiqueta en la 2.ª, importes apilados en la última");
  check(filaTotalesCuadro(4, []) === null, "sin totales → sin fila");
  check(importeTexto("PEN", 11439682.255) === "S/ 11,439,682.26" && importeTexto("USD", -5) === "-US$ 5.00", "importeTexto: miles con coma, dos decimales");
  check(fechaCorta("2026-09-21") === "21/09/2026" && fechaCorta(null) === "—", "fechaCorta");
  // Muchas filas → la tabla sigue en otra hoja con la cabecera repetida y la firma al final.
  const filas = Array.from({ length: 60 }, (_, i) => [String(i + 1), `CLIENTE ${i + 1}`, "PERSONA", "TRANSPORTE", "01/2020", "12/2020", "FACTURA", "2020", "Lima", importeTexto("PEN", 100)]);
  const tz3: TrazaLic[] = [];
  const r3 = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "cuadro_experiencia", itemId: "cx", cuadro: { ...CUADRO, tabla: { ...CUADRO.tabla, filas } } }] }, comunVacio(), { traza: tz3 });
  check(r3.paginas >= 2, `60 filas → varias hojas: ${r3.paginas}`);
  const cabs = tz3.filter((t) => t.texto === "CLIENTE").map((t) => t.pagina);
  check(new Set(cabs).size === r3.paginas || new Set(cabs).size === r3.paginas - 1, "la fila de cabecera se repite en cada hoja con tabla");
  const firmaPag = tz3.find((t) => t.texto === "NOMBRE DEL REPRESENTANTE")!.pagina;
  check(firmaPag === r3.paginas, "la firma va al final");
}

// ══ 8. Tabla genérica ══════════════════════════════════════════════════════════
sec("8. Tabla genérica");
{
  const tz: TrazaLic[] = [];
  const ancha = { columnas: Array.from({ length: MAX_COLUMNAS_VERTICAL + 1 }, (_, i) => `Col ${i + 1}`), filas: [Array.from({ length: MAX_COLUMNAS_VERTICAL + 1 }, (_, i) => `v${i}`)], pie: null };
  const r = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "tabla", itemId: "t", titulo: "Relación de unidades", tabla: ancha }] }, comunVacio(), { traza: tz });
  const ts = await tamanos(r.bytes);
  check(ts[0][0] > ts[0][1], `${MAX_COLUMNAS_VERTICAL + 1} columnas → hoja horizontal`);
  check(unido(tz).includes("Relación de unidades") && unido(tz).includes("Col 8"), "título y columnas");
  const tz2: TrazaLic[] = [];
  const larga = { columnas: ["Código", "Placa", "Año"], filas: Array.from({ length: 120 }, (_, i) => [`U${i + 1}`, `PLC-${i}`, "2020"]), pie: ["Total", "120 unidades", ""] };
  const r2 = await armarBloque({ id: "b", separador: sep(), conPortada: false, partes: [{ tipo: "tabla", itemId: "t", titulo: "Relación", tabla: larga }] }, comunVacio(), { traza: tz2 });
  const t2 = await tamanos(r2.bytes);
  check(t2[0][0] < t2[0][1] && r2.paginas >= 2, `3 columnas, 120 filas → vertical, varias hojas: ${r2.paginas}`);
  check(new Set(tz2.filter((t) => t.texto === "Código").map((t) => t.pagina)).size === r2.paginas, "cabecera de la tabla repetida en cada hoja");
  check(new Set(tz2.filter((t) => t.zona === "cabecera").map((t) => t.pagina)).size === r2.paginas, "cabecera de la licitación en cada hoja");
  check(textos(tz2).includes("120 unidades"), "el pie de la tabla sale");
}

// ══ 9. mapaFolios ══════════════════════════════════════════════════════════════
sec("9. mapaFolios: casos exactos");
{
  const asc = mapaFolios([3, 2, 4], OP, { paginasPortada: [true, false, true] });
  check(JSON.stringify(asc.todos) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) && asc.total === 9, `ascendente con portadas foliadas: ${JSON.stringify(asc.todos)}`);
  check(JSON.stringify(asc.porBloque) === JSON.stringify([{ desde: 1, hasta: 3 }, { desde: 4, hasta: 5 }, { desde: 6, hasta: 9 }]), "rangos ascendentes");
  const asc2 = mapaFolios([3, 2, 4], { ...OP, foliarPortadas: false }, { paginasPortada: [true, false, true] });
  check(JSON.stringify(asc2.todos) === JSON.stringify([null, 1, 2, 3, 4, null, 5, 6, 7]) && asc2.total === 7, `ascendente sin foliar portadas: ${JSON.stringify(asc2.todos)}`);
  check(JSON.stringify(asc2.porBloque) === JSON.stringify([{ desde: 1, hasta: 2 }, { desde: 3, hasta: 4 }, { desde: 5, hasta: 7 }]), "rangos sin portadas");
  const desc = mapaFolios([3, 2, 4], { ...OP, modo: "descendente" }, { paginasPortada: [true, false, true] });
  check(JSON.stringify(desc.todos) === JSON.stringify([9, 8, 7, 6, 5, 4, 3, 2, 1]) && desc.total === 9, `descendente: ${JSON.stringify(desc.todos)}`);
  check(JSON.stringify(desc.porBloque) === JSON.stringify([{ desde: 9, hasta: 7 }, { desde: 6, hasta: 5 }, { desde: 4, hasta: 1 }]), "rangos descendentes (desde > hasta)");
  const desc2 = mapaFolios([3, 2, 4], { ...OP, modo: "descendente", foliarPortadas: false }, { paginasPortada: [true, false, true] });
  check(JSON.stringify(desc2.todos) === JSON.stringify([null, 7, 6, 5, 4, null, 3, 2, 1]), `descendente sin portadas: ${JSON.stringify(desc2.todos)}`);
  const nada = mapaFolios([3, 2], { ...OP, modo: "ninguno" });
  check(nada.todos.every((v) => v === null) && nada.total === 0 && nada.porBloque.every((r) => r.desde === 0 && r.hasta === 0), "ninguno → todo null, total 0, rangos {0,0}");
  check(asc2.folioDePagina(0, 1) === null && asc2.folioDePagina(0, 2) === 1 && asc2.folioDePagina(2, 4) === 7 && asc2.folioDePagina(2, 5) === null && asc2.folioDePagina(9, 1) === null, "folioDePagina 1-based, fuera de rango → null");
  check(JSON.stringify(asc2.foliosDeBloque(2)) === JSON.stringify([null, 5, 6, 7]), "foliosDeBloque");
  const vacio = mapaFolios([0, 1, 0], { ...OP, foliarPortadas: false }, { paginasPortada: [true, true, true] });
  check(JSON.stringify(vacio.porBloque) === JSON.stringify([{ desde: 0, hasta: 0 }, { desde: 0, hasta: 0 }, { desde: 0, hasta: 0 }]) && vacio.total === 0, "bloque vacío o solo portada sin foliar → {0,0}");
  check(mapaFolios([2, -1, NaN as unknown as number, 1.7], OP).todos.length === 3, "negativos y NaN cuentan 0; 1.7 → 1");
  // Barrido: el mapa es una biyección 1..total en el sentido pedido.
  let barridoOk = true;
  for (const modo of ["ascendente", "descendente"] as const) for (const fp of [true, false]) for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 4; c++) {
    const pp = [a % 2 === 0, b % 2 === 1, c > 1];
    const mp = mapaFolios([a, b, c], { ...OP, modo, foliarPortadas: fp }, { paginasPortada: pp });
    const nums = mp.todos.filter((v): v is number => v != null);
    const esperado = Array.from({ length: mp.total }, (_, i) => (modo === "ascendente" ? i + 1 : mp.total - i));
    const sinPort = [a, b, c].reduce((s, n, i) => s + n - (!fp && pp[i] && n > 0 ? 1 : 0), 0);
    if (JSON.stringify(nums) !== JSON.stringify(esperado) || mp.total !== sinPort || mp.todos.length !== a + b + c) barridoOk = false;
  }
  check(barridoOk, "barrido: 1..N exacto en el sentido pedido, sin huecos ni repetidos, portadas descontadas");
  check(textoFolio("Folio {n}", 1, 3) === "Folio 001" && textoFolio("Folio", 12, 3) === "Folio 012" && textoFolio("", 7, 2) === "07" && textoFolio("{n}/{n}", 5, 1) === "5/5" && textoFolio("F-{n}", 1234, 3) === "F-1234", "textoFolio");
  check(textoRangoFolios({ desde: 1, hasta: 12 }, 3) === "001–012" && textoRangoFolios({ desde: 0, hasta: 0 }, 3) === "—", "textoRangoFolios");
}

// ══ 10. foliar ═════════════════════════════════════════════════════════════════
sec("10. foliar: el folio correcto en TODAS las páginas");
{
  const b1 = await armarBloque({ id: "b1", separador: sep(), conPortada: true, partes: [{ tipo: "archivo", itemId: "i", titulo: "Doc", url: "u", nombre: "d.pdf", origen: "storage_privado", etiquetaFuente: "x" }] }, comunVacio({ archivos: { u: { bytes: PDF2, formato: "pdf" } } }));
  const b2 = await armarBloque({ id: "b2", separador: sep({ titulo: "SECCIÓN III", subtitulo: "UNIDADES" }), conPortada: true, partes: [{ tipo: "archivo", itemId: "j", titulo: "Img", url: "v", nombre: "i.png", origen: "storage_privado", etiquetaFuente: "x" }] }, comunVacio({ archivos: { v: { bytes: PNG_APAISADO, formato: "png" } } }));
  const completo = await unirPdfs([b1.bytes, b2.bytes]);
  check((await tamanos(completo)).length === 5, "unirPdfs: 3 + 2 = 5 páginas");
  const mp = mapaFolios([b1.paginas, b2.paginas], { ...OP, foliarPortadas: false }, { paginasPortada: [true, true] });
  const tz: TrazaLic[] = [];
  const fol = await foliar(completo, mp.todos, OP, { traza: tz });
  check(JSON.stringify(tz.map((t) => [t.pagina, t.texto])) === JSON.stringify([[2, "Folio 001"], [3, "Folio 002"], [5, "Folio 003"]]), `folios en las páginas que tocan: ${JSON.stringify(tz.map((t) => [t.pagina, t.texto]))}`);
  check(tz.every((t) => t.zona === "folio"), "zona folio");
  check((await tamanos(fol)).length === 5, "foliar no cambia el número de páginas");
  const tzD: TrazaLic[] = [];
  const mpD = mapaFolios([b1.paginas, b2.paginas], { ...OP, modo: "descendente" }, { paginasPortada: [true, true] });
  await foliar(completo, mpD.todos, { ...OP, modo: "descendente" }, { traza: tzD });
  check(JSON.stringify(tzD.map((t) => t.texto)) === JSON.stringify(["Folio 005", "Folio 004", "Folio 003", "Folio 002", "Folio 001"]), "descendente en TODAS las páginas");
  const tzS: TrazaLic[] = [];
  await foliar(b2.bytes, mp.foliosDeBloque(1), OP, { traza: tzS });
  check(JSON.stringify(tzS.map((t) => [t.pagina, t.texto])) === JSON.stringify([[2, "Folio 003"]]), "bloque suelto con el folio que tiene en el completo");
  check((await foliar(completo, mp.todos, { ...OP, modo: "ninguno" })) === completo, "modo ninguno → los mismos bytes");
  let lanza = false;
  try { await foliar(completo, [1, 2], OP); } catch { lanza = true; }
  check(lanza, "folios de menos → lanza (no folia mal un documento oficial)");
  // Posición: superior derecha / centro.
  const tzP: TrazaLic[] = [];
  await foliar(PDF2, [1, 2], { ...OP, posicion: "superior_derecha" }, { traza: tzP });
  check(tzP.every((t) => t.y > 841.89 - 40 && t.x + t.ancho > 595.28 - 40), "superior derecha");
  const tzC: TrazaLic[] = [];
  await foliar(PDF2, [1, 2], { ...OP, posicion: "inferior_centro" }, { traza: tzC });
  check(tzC.every((t) => Math.abs(t.x + t.ancho / 2 - 595.28 / 2) < 6 && t.y < 40), "inferior centro");
  check(escalaFolio(595.28, 841.89) === 1 && escalaFolio(841.89, 595.28) === 1 && escalaFolio(420, 595) === 1 && Math.abs(escalaFolio(612, 792) - 612 / 595.28) < 1e-9, "escalaFolio: A4 (vertical u horizontal) y A5 → 1 (nunca achica); carta, en proporción");
  check(Math.abs(escalaFolio(1700, 2200) - 1700 / 595.28) < 1e-9 && escalaFolio(9000, 9000) === 4 && escalaFolio(0, 0) === 1, "escalaFolio: escaneo enorme crece, tope 4, sin medidas → 1");
  const tzA4: TrazaLic[] = [], tzG: TrazaLic[] = [];
  await foliar(PDF2, [1, 2], OP, { traza: tzA4 });
  await foliar(await pdfDePaginas(1, { tam: [1700, 2200] }), [1], OP, { traza: tzG });
  check(Math.abs(tzG[0].ancho / tzA4[0].ancho - 1700 / 595.28) < 1e-6, "en un escaneo de 1700 pt el folio crece en proporción (impreso en A4 queda igual)");

  // Hojas giradas, recortadas y con la matriz del contenido sin cerrar: lo lee pdftotext (coordenadas de lo que SE VE).
  if (tiene("pdftotext")) {
    const casos: { nombre: string; bytes: Uint8Array; rot: number }[] = [
      { nombre: "derecha", bytes: await pdfDePaginas(1), rot: 0 },
      { nombre: "girada 90", bytes: await pdfDePaginas(1, { rot: 90 }), rot: 90 },
      { nombre: "girada 180", bytes: await pdfDePaginas(1, { rot: 180 }), rot: 180 },
      { nombre: "girada 270", bytes: await pdfDePaginas(1, { rot: 270 }), rot: 270 },
      { nombre: "CropBox corrida", bytes: await pdfDePaginas(1, { crop: [80, 120, 400, 500] }), rot: 0 },
      { nombre: "CropBox corrida y girada 90", bytes: await pdfDePaginas(1, { crop: [80, 120, 400, 500], rot: 90 }), rot: 90 },
      { nombre: "matriz sin cerrar", bytes: await pdfDePaginas(1, { ctmSinCerrar: true }), rot: 0 },
      { nombre: "carta apaisada girada 90", bytes: await pdfDePaginas(1, { rot: 90, tam: [792, 612] }), rot: 90 },
      { nombre: "escaneo enorme 1700x2200", bytes: await pdfDePaginas(1, { tam: [1700, 2200] }), rot: 0 },
    ];
    for (const c of casos) {
      for (const posicion of ["inferior_derecha", "superior_derecha", "inferior_centro"] as const) {
        const out = await foliar(c.bytes, [7], { ...OP, posicion });
        const f = path.join(TMP, `fol-${c.nombre.replace(/\W+/g, "_")}-${posicion}.pdf`);
        fs.writeFileSync(f, out);
        // -cropbox: coordenadas desde la esquina superior izquierda de lo VISIBLE, ya giradas; la caja de
        // <page> la da sin girar, así que en 90/270 se intercambia.
        const html = execFileSync("pdftotext", ["-bbox", "-cropbox", f, "-"], { encoding: "utf8" });
        const pg = /<page width="([\d.]+)" height="([\d.]+)">/.exec(html);
        const [W, H] = c.rot === 90 || c.rot === 270 ? [Number(pg?.[2]), Number(pg?.[1])] : [Number(pg?.[1]), Number(pg?.[2])];
        const palabras = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] }));
        const fo = palabras.find((w) => w.t === "Folio"), num = palabras.find((w) => w.t === "007");
        const derecho = !!fo && !!num && Math.abs(fo.y0 - num.y0) < 1 && num.x0 > fo.x1 && fo.x1 - fo.x0 > fo.y1 - fo.y0;
        let esquina = false;
        const k = escalaFolio(W, H);
        if (fo && num) {
          const xc = (fo.x0 + num.x1) / 2, yc = (fo.y0 + num.y1) / 2;
          const derechaOk = num.x1 > W - 40 * k && num.x1 <= W;
          const centroOk = Math.abs(xc - W / 2) < 8 * k;
          const abajo = yc > H - 40 * k && yc < H, arriba = yc < 40 * k && yc > 0;
          esquina = posicion === "inferior_derecha" ? derechaOk && abajo : posicion === "superior_derecha" ? derechaOk && arriba : centroOk && abajo;
        }
        check(derecho && esquina, `${c.nombre} · ${posicion}: «Folio 007» derecho y en la esquina que se ve (pdftotext ${W}×${H}: ${fo ? `${fo.x0},${fo.y0}` : "sin Folio"})`);
      }
    }
  } else console.log("  (pdftotext no está instalado: se omite la comprobación de hojas giradas)");
}

// ══ 11. unirPdfs ═══════════════════════════════════════════════════════════════
sec("11. unirPdfs");
{
  const u = await unirPdfs([PDF2, await pdfDePaginas(3)]);
  check((await tamanos(u)).length === 5, "2 + 3 = 5");
  let lanza = false;
  try { await unirPdfs([PDF2, PDF_CIFRADO]); } catch (e) { lanza = /pdf_protegido/.test(String((e as Error).message)); }
  check(lanza, "una parte cifrada → lanza nombrando pdf_protegido (son salidas propias)");
  check((await tamanos(await unirPdfs([]))).length === 0, "nada que unir → PDF de 0 páginas");
}

// ══ 12. ZIP ════════════════════════════════════════════════════════════════════
sec("12. ZIP sin compresión: CRC, ciclo con XLSX.CFB y python, nombres");
const juntar = (partes: Uint8Array[], total: number) => { const u8 = new Uint8Array(total); let o = 0; for (const p of partes) { u8.set(p, o); o += p.length; } return u8; };
{
  check(crc32(enc.encode("123456789")) === 0xCBF43926, "vector conocido «123456789» → 0xCBF43926");
  check(crc32(new Uint8Array(0)) === 0, "vacío → 0");
  const zc = (zlib as unknown as { crc32?: (b: Uint8Array) => number }).crc32;
  if (zc) {
    let iguales = true;
    for (let i = 0; i < 40; i++) {
      const b = new Uint8Array(Math.floor(Math.random() * 5000));
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(Math.random() * 256);
      if (zc(b) !== crc32(b)) iguales = false;
    }
    check(iguales, "crc32 ≡ zlib.crc32 de node sobre 40 bloques aleatorios");
    const a = enc.encode("hola "), b = enc.encode("mundo");
    check(crc32(b, crc32(a)) === zc(enc.encode("hola mundo")), "crc32 encadenado");
  } else console.log("  (node sin zlib.crc32: se usa solo el vector conocido)");

  const pdfBytes = PDF2;
  const entradas = [
    { nombre: "00 Propuesta técnica.pdf", bytes: pdfBytes, fecha: new Date("2026-10-24T15:30:20Z") },
    { nombre: "Sección II – Requisitos legales.pdf", bytes: enc.encode("contenido con ñ y tildes áéíóú") },
    { nombre: "bloques/Año 2026/Ánexo ñandú.txt", bytes: new Uint8Array(0) },
  ];
  const z = armarZip(entradas);
  const u8 = juntar(z.partes, z.bytes);
  check(z.partes.reduce((s, p) => s + p.length, 0) === z.bytes && u8.length === z.bytes, "bytes = suma de las partes");
  check(z.partes[1] === pdfBytes, "los datos se entregan sin copiar (stored)");
  const cfb = (XLSX as unknown as { CFB: { read: (d: Uint8Array, o: { type: string }) => { FullPaths: string[]; FileIndex: { name: string; type: number; content?: Uint8Array | number[] }[] } } }).CFB.read(u8, { type: "array" });
  // SheetJS no aplica la bandera UTF-8 (bit 11): devuelve el nombre como cadena binaria; se decodifica.
  const deBinario = (s: string) => new TextDecoder("utf-8").decode(Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff)));
  const leidos = new Map<string, Uint8Array>();
  cfb.FileIndex.forEach((f, i) => {
    if (f.type !== 2 || f.name === "\u0001Sh33tJ5") return;
    leidos.set(deBinario(cfb.FullPaths[i]).replace(/^Root Entry\//, ""), new Uint8Array(f.content ?? []));
  });
  for (const e of entradas) {
    const l = leidos.get(e.nombre);
    check(!!l && Buffer.compare(Buffer.from(l), Buffer.from(e.bytes)) === 0, `CFB devuelve «${e.nombre}» con sus bytes`);
  }
  // python zipfile: aplica la bandera UTF-8 y verifica el CRC de cada entrada.
  if (tiene("python3")) {
    const fz = path.join(TMP, "prueba.zip");
    fs.writeFileSync(fz, u8);
    const py = "import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({'bad':z.testzip(),'names':z.namelist(),'sizes':[i.file_size for i in z.infolist()],'meth':[i.compress_type for i in z.infolist()],'dt':list(z.infolist()[0].date_time),'utf8':[bool(i.flag_bits & 0x800) for i in z.infolist()]}))";
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", py, fz], { encoding: "utf8" }));
    check(out.bad === null, "python zipfile.testzip(): ningún CRC malo");
    check(JSON.stringify(out.names) === JSON.stringify(entradas.map((e) => e.nombre)), `python lee los nombres con tildes: ${JSON.stringify(out.names)}`);
    check(out.meth.every((m: number) => m === 0) && out.utf8.every(Boolean), "método 0 (stored) y bandera UTF-8 en todas");
    check(JSON.stringify(out.dt) === JSON.stringify([2026, 10, 24, 10, 30, 20]), `fecha DOS en hora de Lima (15:30:20Z → 10:30:20): ${JSON.stringify(out.dt)}`);
    check(JSON.stringify(out.sizes) === JSON.stringify(entradas.map((e) => e.bytes.length)), "tamaños");
  }
  if (tiene("unzip")) {
    const r = execFileSync("unzip", ["-tq", path.join(TMP, "prueba.zip")], { encoding: "utf8" });
    check(/No errors detected/.test(r), `unzip -t: ${r.trim()}`);
  }
  const fd = fechaDos(undefined);
  check(fd.fecha === 33 && fd.hora === 0, "sin fecha → 1980-01-01 00:00 (época DOS, determinista)");
  const lanzaCon = (nombres: string[], codigo: string) => {
    try { armarZip(nombres.map((nombre) => ({ nombre, bytes: new Uint8Array(1) }))); return false; } catch (e) { return (e as ErrorZip).codigo === codigo; }
  };
  check(lanzaCon(["../fuera.pdf"], "zip_nombre_invalido"), "«..» → lanza");
  check(lanzaCon(["a/../../b.pdf"], "zip_nombre_invalido"), "«..» en medio → lanza");
  check(lanzaCon(["/abs.pdf"], "zip_nombre_invalido") && lanzaCon(["\\abs.pdf"], "zip_nombre_invalido"), "empieza por / o \\ → lanza");
  check(lanzaCon([""], "zip_nombre_invalido") && lanzaCon(["   "], "zip_nombre_invalido"), "vacío → lanza");
  check(lanzaCon(["C:/x.pdf"], "zip_nombre_invalido") && lanzaCon(["a\u0000b"], "zip_nombre_invalido") && lanzaCon(["carpeta/"], "zip_nombre_invalido"), "letra de unidad, control o carpeta → lanza");
  check(lanzaCon(["a.pdf", "a.pdf"], "zip_nombre_repetido") && lanzaCon(["Anexo.pdf", "anexo.PDF"], "zip_nombre_repetido"), "repetidos (también por mayúsculas) → lanza");
  check(lanzaCon(["Sección.pdf", "Secci\u006f\u0301n.pdf"], "zip_nombre_repetido"), "NFC y NFD del mismo nombre son el mismo → lanza");
  let ex: unknown = null;
  try { armarZip([{ nombre: "../x", bytes: new Uint8Array(0) }]); } catch (e) { ex = e; }
  check(ex instanceof Error && (ex as ErrorZip).codigo === "zip_nombre_invalido" && ex instanceof ErrorZip, "el error es un Error con su código");
  check(problemaNombreZip("ok/archivo.pdf") === null && problemaNombreZip("a..b") !== null, "problemaNombreZip");
  check(LIMITES_ZIP.maxEntradas === 65534 && LIMITES_ZIP.maxBytes === 0xFFFFFFFE, "LIMITES_ZIP sin ZIP64");
  check(lanzaCon(Array.from({ length: LIMITES_ZIP.maxEntradas + 1 }, (_, i) => `f${i}`), "zip_demasiadas_entradas"), "65 535 entradas → lanza");
  const vacio = armarZip([]);
  check(vacio.bytes === 22 && vacio.partes.length === 1, "ZIP vacío = solo el fin de directorio (22 bytes)");
}

// ══ 13. Muestra ════════════════════════════════════════════════════════════════
const MUESTRA = process.env.MUESTRA_DIR;
if (MUESTRA) {
  sec(`13. Muestra en ${MUESTRA}`);
  fs.mkdirSync(MUESTRA, { recursive: true });
  const svgLogo = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="140"><rect width="560" height="140" fill="white"/><polygon points="20,120 70,20 120,120" fill="#1f3c78"/><text x="140" y="95" font-family="sans-serif" font-size="72" font-weight="bold" fill="#1f3c78">EMPRESA</text></svg>`;
  const logo = new Uint8Array(await sharp(Buffer.from(svgLogo)).png().toBuffer());
  const svgFirma = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><path d="M10 90 C 60 10, 90 110, 140 50 S 220 20, 250 80 S 320 60, 350 30" stroke="#1d3a8a" stroke-width="5" fill="none"/></svg>`;
  const firma = new Uint8Array(await sharp(Buffer.from(svgFirma)).png().toBuffer());
  const svgBus = (txt: string, fondo: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="${fondo}"/><rect x="80" y="150" width="640" height="220" rx="30" fill="#f2f2f2"/><circle cx="220" cy="380" r="50" fill="#333"/><circle cx="580" cy="380" r="50" fill="#333"/><text x="400" y="110" text-anchor="middle" font-family="sans-serif" font-size="60" fill="white">${txt}</text></svg>`;
  const fotoExt = await jpeg(800, 500, undefined, svgBus("EXTERIOR ↑", "#3b6ea8"));
  const fotoInt = await jpeg(800, 500, 6, svgBus("INTERIOR (EXIF 6) ↑", "#6a8f3b"));
  const docEscaneado = await jpeg(900, 1200, undefined, `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#fdfdf8"/><text x="450" y="120" text-anchor="middle" font-family="serif" font-size="48">DOCUMENTO ESCANEADO</text>${Array.from({ length: 24 }, (_, i) => `<rect x="90" y="${200 + i * 38}" width="${600 + (i % 3) * 60}" height="12" fill="#bbb"/>`).join("")}</svg>`);
  const comun = comunVacio({ logo: { bytes: logo, tipo: "png" }, firma: { bytes: firma, tipo: "png" },
    archivos: { "u:pdf": { bytes: PDF2, formato: "pdf" }, "u:scan": { bytes: docEscaneado, formato: "jpg" }, "u:cif": { bytes: PDF_CIFRADO, formato: "pdf" } },
    imagenes: { "f:ext": { bytes: fotoExt, tipo: "jpg" }, "f:int": { bytes: fotoInt, tipo: "jpg" }, "firma:1": { bytes: firma, tipo: "png" } } });
  const legal: BloqueExpedienteResuelto = { id: "legal", separador: sep(), conPortada: true, partes: [
    { tipo: "archivo", itemId: "l1", titulo: "Copia literal", url: "u:pdf", nombre: "literal.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
    { tipo: "archivo", itemId: "l2", titulo: "DNI", url: "u:scan", nombre: "dni.jpg", origen: "storage_privado", etiquetaFuente: "Legajo" },
    { tipo: "archivo", itemId: "l3", titulo: "Vigencia de poder (cifrada)", url: "u:cif", nombre: "vp.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
  ] };
  const unidades: BloqueExpedienteResuelto = { id: "unidades", separador: sep({ titulo: "SECCIÓN VII", subtitulo: "FLOTA OFERTADA", referencia: "Sección V, numeral 5.2 de las bases", contenido: ["Ficha técnica de cada unidad", "Tarjeta de propiedad, SOAT y CITV"] }), conPortada: true, partes: [
    { tipo: "ficha_unidad", itemId: "u1", ficha: { ...FICHA, anio: 2021 } },
    { tipo: "tabla", itemId: "t1", titulo: "Relación de unidades", tabla: { columnas: ["Código", "Uso", "Tipo", "Marca / modelo", "Placa", "Año"], filas: [["U1", "Ruta 1", "Bus", "Marca Modelo 50", "ABC-123", "2021"], ["U2", "Ruta 2", "Minibús", "Marca Modelo 30", "DEF-456", "2019"]], pie: null } },
  ] };
  const experiencia: BloqueExpedienteResuelto = { id: "exp", separador: sep({ titulo: "ANEXO 3", subtitulo: "EXPERIENCIA DE LA EMPRESA CONCURSANTE", referencia: "Sección IX, literal a) e)", contenido: ["Cuadro de experiencia", "Cartas de conformidad de clientes", "Órdenes de servicio y/o comprobantes de pago"] }), conPortada: true, partes: [
    { tipo: "cuadro_experiencia", itemId: "cx", cuadro: { ...CUADRO, tabla: { ...CUADRO.tabla, filas: [...CUADRO.tabla.filas, ...Array.from({ length: 10 }, (_, i) => [String(i + 3), `CLIENTE ${i + 3} S.A.C.`, `PERSONA ${i + 3} – 900 000 0${i + 10}`, "TRANSPORTE DE PERSONAL", "03/2021", i % 2 ? "VIGENTE" : "12/2024", "OC/FACTURA", "2021", "Lima Norte y Callao", importeTexto("PEN", 12345.6 * (i + 1))])] }, totales: [{ moneda: "PEN", importe: 1000 + 12345.6 * 55 }, { moneda: "USD", importe: 500 }] } },
  ] };
  const salidas: Uint8Array[] = [];
  const pags: number[] = [];
  for (const [nombre, b] of [["01-requisitos-legales", legal], ["02-flota", unidades], ["03-experiencia", experiencia]] as const) {
    const r = await armarBloque(b, comun);
    fs.writeFileSync(path.join(MUESTRA, `${nombre}.pdf`), r.bytes);
    salidas.push(r.bytes); pags.push(r.paginas);
    console.log(`  ${nombre}.pdf: ${r.paginas} págs · omitidos: ${r.omitidos.map((o) => `${o.titulo} (${o.codigo})`).join(", ") || "—"} · avisos: ${r.avisos.join(" | ") || "—"}`);
  }
  const completo = await unirPdfs(salidas);
  const mp = mapaFolios(pags, { ...OP, modo: "descendente" }, { paginasPortada: [true, true, true] });
  const fol = await foliar(completo, mp.todos, { ...OP, modo: "descendente" });
  fs.writeFileSync(path.join(MUESTRA, "expediente-completo-foliado.pdf"), fol);
  const z = armarZip([
    { nombre: "Expediente completo foliado.pdf", bytes: fol, fecha: new Date() },
    ...salidas.map((b, i) => ({ nombre: `Bloques/Sección ${i + 1}.pdf`, bytes: b, fecha: new Date() })),
  ]);
  fs.writeFileSync(path.join(MUESTRA, "expediente.zip"), juntar(z.partes, z.bytes));
  console.log(`  expediente-completo-foliado.pdf: ${mp.total} folios (descendente) · expediente.zip: ${z.bytes} bytes`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fallos ? "✗" : "✓"} ${ok} comprobaciones, ${fallos} fallo(s)`);
if (fallos) process.exit(1);
