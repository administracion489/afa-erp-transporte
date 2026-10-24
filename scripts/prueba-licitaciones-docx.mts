// scripts/prueba-licitaciones-docx.mts — Matriz de la importación de Word (.docx) de Licitaciones.
//   npx tsx scripts/prueba-licitaciones-docx.mts
//   DOCX_REAL=/ruta/propuesta.docx npx tsx scripts/prueba-licitaciones-docx.mts   (además resume ese Word)
//
// Fija, con documentos SINTÉTICOS armados aquí mismo con XLSX.CFB (comprimidos y sin comprimir) y con un
// escritor de zip propio (descriptor de datos, tamaños que mienten, entradas cifradas o repetidas):
//  1. el parser XML: entidades (solo las 5 y las numéricas), CDATA, comentarios, atributos con «>», y que
//     una DTD, un mal cierre o un anidamiento excesivo LANZAN; es iterativo (50 000 niveles sin reventar);
//  2. el zip: topes de tamaño, de entradas y de bytes descomprimidos (bomba), memoria acotada aunque una
//     entrada mienta, descriptor de datos, contraseña, OLE (.doc) y basura;
//  3. el importador con estilos en castellano (Ttulo1/TDC1/Prrafodelista con w:name en inglés) y en
//     inglés con prefijos raros (ns1:, rel:): secciones, subtítulos, numeración quitada, listas ordenadas y
//     de viñetas, tablas con encabezado y celdas combinadas, imágenes PNG/EMF/VML/vinculadas, pies,
//     cuadros de texto, gráficos, saltos de página, preliminares (portada, control, glosario, carta, índice),
//     el párrafo larguísimo con estilo de título, y sin títulos;
//  4. los topes de TOPES_DOC (recorta y avisa);
//  5. invariantes sobre TODO resultado ok (ids únicos, pendientes ⟷ bloques imagen, topes, saltos podados)
//     y un barrido de bytes mutados: el importador NUNCA lanza y solo devuelve códigos declarados.
//     Corolario: los fixtures sí producen cada tipo de bloque (un importador que no hiciera nada no pasa).

import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { parsearXml, ErrorXml, canonizarPrefijos, decodificarEntidades, type NodoXml } from "../lib/licitaciones/docx/xml";
import { leerZip, ErrorZip, TOPES_ZIP } from "../lib/licitaciones/docx/zip-lectura";
import {
  importarDocx, marcarNegrita, quitarNumeracion, fechaIsoDeTexto, mimeDeImagen, TOPES_IMPORTACION, SECCION_SIN_TITULOS,
} from "../lib/licitaciones/docx/importar";
import { TOPES_DOC, type Bloque, type ResultadoImportacion, type AvisoImportacion } from "../lib/licitaciones/tipos";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const CFB: any = (XLSX as any).CFB;
const enc = new TextEncoder();
const lanza = (f: () => unknown): unknown => { try { f(); return null; } catch (e) { return e; } };

// ══ Bytes de imagen mínimos ══════════════════════════════════════════════════
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4,
  0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0, 0, 1, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0, 0,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const EMF = (() => { const b = new Uint8Array(108); b[0] = 1; b[40] = 0x20; b[41] = 0x45; b[42] = 0x4d; b[43] = 0x46; return b; })();

// ══ Escritores de zip ════════════════════════════════════════════════════════
type Partes = Record<string, string | Uint8Array>;
const aBytes = (x: string | Uint8Array) => typeof x === "string" ? enc.encode(x) : x;
function zipCfb(partes: Partes, compression: boolean): Uint8Array {
  const z = CFB.utils.cfb_new();
  for (const [k, v] of Object.entries(partes)) CFB.utils.cfb_add(z, k, aBytes(v));
  const o = CFB.write(z, { fileType: "zip", type: "array", compression });
  return o instanceof Uint8Array ? new Uint8Array(o.buffer, o.byteOffset, o.byteLength).slice() : Uint8Array.from(o);
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
type EntradaPropia = { nombre: string; datos: Uint8Array; descriptor?: boolean; cifrada?: boolean; uszCd?: number };
/** Zip SIN compresión escrito a mano: permite el descriptor de datos, la marca de cifrado y tamaños falsos. */
function zipPropio(entradas: EntradaPropia[]): Uint8Array {
  const trozos: number[] = [];
  const cd: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const e of entradas) {
    const nombre = enc.encode(e.nombre);
    const off = trozos.length;
    const flags = (e.descriptor ? 8 : 0) | (e.cifrada ? 1 : 0) | 0x800;
    const crc = crc32(e.datos);
    u32(trozos, 0x04034b50); u16(trozos, 20); u16(trozos, flags); u16(trozos, 0); u16(trozos, 0); u16(trozos, 0);
    u32(trozos, e.descriptor ? 0 : crc); u32(trozos, e.descriptor ? 0 : e.datos.length); u32(trozos, e.descriptor ? 0 : e.datos.length);
    u16(trozos, nombre.length); u16(trozos, 0);
    trozos.push(...nombre, ...e.datos);
    if (e.descriptor) { u32(trozos, 0x08074b50); u32(trozos, crc); u32(trozos, e.datos.length); u32(trozos, e.datos.length); }
    u32(cd, 0x02014b50); u16(cd, 20); u16(cd, 20); u16(cd, flags); u16(cd, 0); u16(cd, 0); u16(cd, 0);
    u32(cd, crc); u32(cd, e.uszCd ?? e.datos.length); u32(cd, e.uszCd ?? e.datos.length);
    u16(cd, nombre.length); u16(cd, 0); u16(cd, 0); u16(cd, 0); u16(cd, 0); u32(cd, 0); u32(cd, off);
    cd.push(...nombre);
  }
  const iniCd = trozos.length;
  const fin: number[] = [];
  u32(fin, 0x06054b50); u16(fin, 0); u16(fin, 0); u16(fin, entradas.length); u16(fin, entradas.length);
  u32(fin, cd.length); u32(fin, iniCd); u16(fin, 0);
  return Uint8Array.from([...trozos, ...cd, ...fin]);
}
/** Posición del directorio central y de cada cabecera, para retocar un zip ya escrito. */
function cdEntradas(z: Uint8Array): { cd: number; nombre: string; local: number }[] {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22; while (dv.getUint32(e, true) !== 0x06054b50) e--;
  const total = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let k = 0; k < total; k++) {
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true);
    out.push({ cd: p, nombre: new TextDecoder().decode(z.subarray(p + 46, p + 46 + ln)), local: dv.getUint32(p + 42, true) });
    p += 46 + ln + le + lc;
  }
  return out;
}

// ══ Armado de documentos ═════════════════════════════════════════════════════
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NSW = [
  `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`,
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`,
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`,
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`,
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`,
  `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"`,
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`,
  `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`,
  `xmlns:v="urn:schemas-microsoft-com:vml"`, `xmlns:o="urn:schemas-microsoft-com:office:office"`,
].join(" ");
type OpRun = { b?: boolean | "0"; i?: boolean; oculto?: boolean; rStyle?: string };
const run = (t: string, o: OpRun = {}) => {
  const rpr = (o.rStyle ? `<w:rStyle w:val="${o.rStyle}"/>` : "") + (o.b === "0" ? `<w:b w:val="0"/>` : o.b ? "<w:b/>" : "") + (o.i ? "<w:i/>" : "") + (o.oculto ? "<w:vanish/>" : "");
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
};
type OpP = { estilo?: string; numId?: string; ilvl?: number; extra?: string; saltoAntes?: boolean };
const par = (contenido: string, o: OpP = {}) => {
  const ppr = (o.estilo ? `<w:pStyle w:val="${o.estilo}"/>` : "") + (o.saltoAntes ? "<w:pageBreakBefore/>" : "")
    + (o.numId !== undefined ? `<w:numPr><w:ilvl w:val="${o.ilvl ?? 0}"/><w:numId w:val="${o.numId}"/></w:numPr>` : "") + (o.extra ?? "");
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${contenido}</w:p>`;
};
const p = (t: string, o: OpP = {}) => par(run(t), o);
const vacio = () => "<w:p/>";
const salto = () => `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
const dibujo = (rid: string, cx: number, cy: number, ancla = false, link = false) => {
  const cuerpo = `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="i"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${link ? "r:link" : "r:embed"}="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>`;
  return `<w:r><w:drawing>${ancla ? `<wp:anchor>${cuerpo}</wp:anchor>` : `<wp:inline>${cuerpo}</wp:inline>`}</w:drawing></w:r>`;
};
const grafico = () => `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId99"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const cuadroTexto = (parrafos: string) => `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="900000" cy="250000"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${parrafos}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect style="width:74pt;height:19pt"><v:textbox><w:txbxContent>${parrafos}</w:txbxContent></v:textbox></v:rect></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
type OpTabla = { encabezado?: boolean; negritaPrimera?: boolean; grid?: number[] };
const celda = (contenido: string, tcpr = "") => `<w:tc>${tcpr ? `<w:tcPr>${tcpr}</w:tcPr>` : ""}${contenido || "<w:p/>"}</w:tc>`;
const tabla = (filas: string[][], o: OpTabla = {}) => {
  const grid = o.grid ? `<w:tblGrid>${o.grid.map((g) => `<w:gridCol w:w="${g}"/>`).join("")}</w:tblGrid>` : "";
  const trs = filas.map((f, k) => {
    const enc1 = k === 0 && o.encabezado ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
    return `<w:tr>${enc1}${f.map((c) => celda(c ? par(run(c, { b: k === 0 && o.negritaPrimera })) : "")).join("")}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr/>${grid}${trs}</w:tbl>`;
};
const SECT = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418"/></w:sectPr>`;
const documento = (cuerpo: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NSW}><w:body>${cuerpo}${SECT}</w:body></w:document>`;

const ESTILOS_ES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="TDC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="TtuloTDC"><w:name w:val="TOC Heading"/><w:basedOn w:val="Ttulo1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Prrafodelista"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="SeccionAFA"><w:name w:val="Seccion personalizada"/><w:basedOn w:val="Ttulo1"/></w:style>
<w:style w:type="paragraph" w:styleId="MiTitulo"><w:name w:val="Mi titulo"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Cuerpo9"><w:name w:val="Cuerpo largo"/><w:basedOn w:val="Ttulo2"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Descripcin"><w:name w:val="caption"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="character" w:styleId="Fuerte"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;
const NUMERACION = `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="none"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>
<w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
const REL_PAQUETE = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const TIPOS = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
const relsDoc = (extra: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${extra}</Relationships>`;
const relImg = (id: string, destino: string, externo = false) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${destino}"${externo ? ` TargetMode="External"` : ""}/>`;

// ── Fixture A: estilos en castellano, todo lo que el importador sabe tratar ──
const textoLargo = "Prestar el servicio de transporte de acercamiento para el personal desde los paraderos definidos hasta el centro de distribución, de lunes a sábado, en dos rutas conforme al anexo.";
const PIEZAS_A = [
  par(dibujo("rId10", 7_600_000, 10_700_000, true), { extra: `<w:jc w:val="center"/>` }),
  par(cuadroTexto(par(run("Versión 1.0", { b: true })) + vacio()) + `<w:r><w:br w:type="page"/></w:r>`),
  vacio(),
  p("Control del documento"),
  tabla([["Campo", "Detalle"], ["Documento", "Propuesta técnica de prueba"], ["Versión", "1.0 – Presentación"], ["Código", "PT-01"],
    ["Elaborado por", "Área de Operaciones"], ["Revisado por", "Fulana de Tal"], ["Aprobado por", "Mengano Pérez"], ["Fecha", "17/10/2026"],
    ["Confidencialidad", "Uso exclusivo del concurso"], ["Cliente", "ACME S.A."], ["Observación", "Algo sin campo"]], { encabezado: true, negritaPrimera: true }),
  vacio(),
  p("Glosario:"),
  tabla([["Término", "Definición"], ["CD", "Centro de distribución."], ["SLA", "Acuerdo de nivel de servicio."], ["GDH", "Gestión humana."]], { encabezado: true, negritaPrimera: true }),
  salto(),
  p("Lima, 3 de octubre de 2026"), vacio(), p("Señores"), par(run("EMPRESA CLIENTE S.A.", { b: true })),
  p("Atención: Sr. Juan Pérez – Compras"), p("Concurso ABC-2026 – Transporte de personal"), p("Presente.-"),
  p("De nuestra consideración:"),
  par(run("Nuestra empresa ") + run("presenta", { b: true }) + run(" su propuesta técnica conforme a las bases.")),
  par(dibujo("rId11", 1_800_000, 1_100_000, true) + run("Atentamente,")),
  p("Juan Firmante"),
  `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>`
    + p("Contenido", { estilo: "TtuloTDC" })
    + par(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\o "1-2"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` + run("1. Resumen ejecutivo") + `<w:r><w:tab/></w:r>` + run("3"), { estilo: "TDC1" })
    + par(run("2. Tablas") + `<w:r><w:fldChar w:fldCharType="end"/></w:r>`, { estilo: "TDC1" })
    + `</w:sdtContent></w:sdt>`,
  salto(),
  // ── Sección 1 ──
  p("1. Resumen ejecutivo", { estilo: "Ttulo1" }),
  par(run("Texto ") + run("importante", { b: true }) + run(" y") + `<w:r><w:tab/></w:r>` + run("más") + run(" OCULTO", { oculto: true })
    + `<w:del><w:r><w:delText>BORRADO</w:delText></w:r></w:del><w:ins><w:r><w:t xml:space="preserve"> insertado</w:t></w:r></w:ins>`
    + `<w:hyperlink r:id="rId20"><w:r><w:t xml:space="preserve"> enlace</w:t></w:r></w:hyperlink>`
    + `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>CODIGO</w:t></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve"> 7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    + run(" final") + run(" fuerte", { rStyle: "Fuerte" }) + run(" no", { rStyle: "Fuerte", b: "0" })),
  p("1.1 Cifras clave", { estilo: "Ttulo2" }),
  p("Uno", { numId: "1" }), p("Dos", { numId: "1" }), p("Dos-a", { numId: "1", ilvl: 1 }), p("Tres", { numId: "1" }),
  p("Intermedio"),
  par(run("A.", { b: true }) + run(" Primera viñeta"), { estilo: "Prrafodelista", numId: "2" }), p("Segunda viñeta", { estilo: "Prrafodelista", numId: "2" }),
  p("Otro intermedio"),
  p("Suelta sin numeración", { estilo: "Prrafodelista" }),
  p("Tras la suelta"),
  p("Cuatro", { numId: "1" }),
  p("Romano uno", { numId: "3" }),
  p("Desde cinco", { numId: "4" }),
  p("Sin número visible", { numId: "5" }),
  p("Lista anulada", { estilo: "Prrafodelista", numId: "0" }),
  p("1.1.1 Detalle", { estilo: "Ttulo3" }),
  p("Nivel cuatro", { estilo: "Ttulo4" }),
  par(run(textoLargo), { estilo: "Ttulo2" }),
  p("Texto con estilo de cuerpo", { estilo: "Cuerpo9" }),
  // ── Sección 2 (estilo personalizado basado en Título 1) ──
  p("2 Tablas", { estilo: "SeccionAFA" }),
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/><w:gridCol w:w="5000"/></w:tblGrid>`
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${celda(p("A"))}${celda(p("B"))}${celda(p("C"))}</w:tr>`
    + `<w:tr>${celda(p("x"), `<w:gridSpan w:val="2"/>`)}${celda(p("y"))}</w:tr>`
    + `<w:tr>${celda(p("m"), `<w:vMerge w:val="restart"/>`)}${celda(p("n"))}${celda(p("o"))}</w:tr>`
    + `<w:tr>${celda("", `<w:vMerge/>`)}${celda(p("p") + p("q2"))}${celda(p("q"))}</w:tr></w:tbl>`,
  tabla([["a", "b"], ["c", "d"]]),
  tabla([["H1", "H2"], ["v1", "v2"]], { negritaPrimera: true }),
  `<w:tbl><w:tblPr/><w:tr>${celda(p("Mapa"))}</w:tr><w:tr>${celda(par(dibujo("rId12", 2_000_000, 1_000_000)))}</w:tr><w:tr>${celda(p("Leyenda del mapa"))}</w:tr></w:tbl>`,
  tabla([Array.from({ length: 14 }, (_, k) => `C${k + 1}`), Array.from({ length: 14 }, (_, k) => `v${k + 1}`)], { encabezado: true }),
  p("Antes del salto"), salto(), salto(), p("Después del salto"),
  // ── Sección 3 (outlineLvl 0 en un estilo propio) ──
  p("Imágenes", { estilo: "MiTitulo" }),
  par(dibujo("rId12", 2_880_000, 1_440_000)), par(run("Figura 1. Prueba de pie", { i: true })),
  par(dibujo("rId12", 2_880_000, 1_440_000)), vacio(), p("Figura 2. Con estilo Descripción", { estilo: "Descripcin" }),
  par(dibujo("rId13", 2_000_000, 1_000_000)),
  `<w:p><w:r><w:pict><v:shape style="width:144pt;height:72pt"><v:imagedata r:id="rId15" o:title=""/></v:shape></w:pict></w:r></w:p>`,
  par(dibujo("rId16", 2_000_000, 1_000_000, false, true)),
  par(grafico()),
  par(run("Ancla del cuadro") + cuadroTexto(p("Cuadro uno") + p("Cuadro dos"))),
  par(run("Con nota") + `<w:r><w:footnoteReference w:id="1"/></w:r>`),
  par(run(textoLargo), { estilo: "Ttulo1" }),
  p("Cierre de la sección"),
  salto(),
];
const cuerpoA = PIEZAS_A.join("");
const PARTES_A: Partes = {
  "[Content_Types].xml": TIPOS, "_rels/.rels": REL_PAQUETE, "word/document.xml": documento(cuerpoA),
  "word/styles.xml": ESTILOS_ES, "word/numbering.xml": NUMERACION,
  "word/_rels/document.xml.rels": relsDoc(relImg("rId10", "media/image1.png") + relImg("rId11", "media/image2.png") + relImg("rId12", "media/image3.png")
    + relImg("rId13", "media/image4.emf") + relImg("rId15", "media/image5.jpeg") + relImg("rId16", "http://ejemplo.invalid/x.png", true)
    + `<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://ejemplo.invalid" TargetMode="External"/>`),
  "word/media/image1.png": PNG, "word/media/image2.png": PNG, "word/media/image3.png": PNG, "word/media/image4.emf": EMF, "word/media/image5.jpeg": PNG,
};

// ── Fixture B: estilos en inglés y prefijos no habituales (ns1:, rel:), sin compresión ──
const NB = `xmlns:ns1="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const pB = (t: string, estilo?: string, num?: string) =>
  `<ns1:p>${estilo || num ? `<ns1:pPr>${estilo ? `<ns1:pStyle ns1:val="${estilo}"/>` : ""}${num ? `<ns1:numPr><ns1:ilvl ns1:val="0"/><ns1:numId ns1:val="${num}"/></ns1:numPr>` : ""}</ns1:pPr>` : ""}<ns1:r><ns1:t>${esc(t)}</ns1:t></ns1:r></ns1:p>`;
const cuerpoB = [
  pB("Executive summary", "Heading1"), pB("Plain paragraph."), pB("1.2 Scope", "Heading2"), pB("Fallback by id", "Titulo2"),
  pB("first", undefined, "7"), pB("second", undefined, "7"), pB("Index entry", "TOC1"), pB("Bullet via style", "ListParagraph"),
].join("");
const PARTES_B: Partes = {
  "[Content_Types].xml": TIPOS,
  "_rels/.rels": `<?xml version="1.0"?><pr:Relationships xmlns:pr="http://schemas.openxmlformats.org/package/2006/relationships"><pr:Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></pr:Relationships>`,
  "word/document.xml": `<?xml version="1.0"?><ns1:document ${NB}><ns1:body>${cuerpoB}</ns1:body></ns1:document>`,
  "word/styles.xml": `<?xml version="1.0"?><ns1:styles ${NB}>`
    + `<ns1:style ns1:type="paragraph" ns1:styleId="Heading1"><ns1:name ns1:val="heading 1"/></ns1:style>`
    + `<ns1:style ns1:type="paragraph" ns1:styleId="Heading2"><ns1:name ns1:val="heading 2"/></ns1:style>`
    + `<ns1:style ns1:type="paragraph" ns1:styleId="TOC1"><ns1:name ns1:val="toc 1"/></ns1:style>`
    + `<ns1:style ns1:type="paragraph" ns1:styleId="ListParagraph"><ns1:name ns1:val="List Paragraph"/></ns1:style></ns1:styles>`,
  "word/numbering.xml": `<?xml version="1.0"?><ns1:numbering ${NB}><ns1:abstractNum ns1:abstractNumId="9"><ns1:lvl ns1:ilvl="0"><ns1:numFmt ns1:val="decimal"/></ns1:lvl></ns1:abstractNum><ns1:num ns1:numId="7"><ns1:abstractNumId ns1:val="9"/></ns1:num></ns1:numbering>`,
  "word/_rels/document.xml.rels": relsDoc(""),
};

const docMinimo = (cuerpo: string, extra: Partes = {}): Partes => ({
  "[Content_Types].xml": TIPOS, "_rels/.rels": REL_PAQUETE, "word/document.xml": documento(cuerpo),
  "word/styles.xml": ESTILOS_ES, "word/numbering.xml": NUMERACION, "word/_rels/document.xml.rels": relsDoc(""), ...extra,
});

let idN = 0;
const nuevoId = () => `b${++idN}`;
const importar = (z: Uint8Array) => importarDocx(z, { nuevoId });
const deTipo = <T extends Bloque["tipo"]>(bs: Bloque[], t: T) => bs.filter((b): b is Extract<Bloque, { tipo: T }> => b.tipo === t);
const avisosDe = (r: ResultadoImportacion, c: AvisoImportacion["codigo"]) => r.ok ? r.avisos.filter((a) => a.codigo === c) : [];
const CODIGOS_AVISO = new Set<AvisoImportacion["codigo"]>(["estilo_desconocido", "imagen_no_soportada", "tabla_combinada", "subtitulo_sospechoso",
  "cuadro_de_texto", "grafico_omitido", "indice_omitido", "numeracion_quitada", "sin_titulos", "lista_numerada", "recortado", "imagen_en_tabla", "dato_omitido"]);
const CODIGOS_FALLO = new Set(["archivo_no_docx", "demasiado_grande", "sin_documento", "xml_ilegible"]);

/** Invariantes que TODO resultado ok tiene que cumplir. Devuelve la lista de violaciones. */
function violaciones(r: ResultadoImportacion): string[] {
  if (!r.ok) return CODIGOS_FALLO.has(r.codigo) && r.detalle ? [] : [`fallo con código o detalle inválido: ${r.codigo}`];
  const v: string[] = [];
  const ids = new Set<string>();
  const verId = (id: string) => { if (ids.has(id)) v.push(`id repetido ${id}`); ids.add(id); };
  const claves = new Map(r.imagenes.map((i) => [i.clave, i]));
  if (claves.size !== r.imagenes.length) v.push("claves de imagen repetidas");
  const bloquesImagen = new Set<string>();
  const revisar = (bs: Bloque[], donde: string) => {
    if (bs.length > TOPES_DOC.maxBloquesSeccion) v.push(`${donde}: ${bs.length} bloques`);
    bs.forEach((b, k) => {
      verId(b.id);
      if (b.tipo === "salto_pagina" && (k === 0 || k === bs.length - 1 || bs[k - 1].tipo === "salto_pagina")) v.push(`${donde}: salto sin podar`);
      if ((b.tipo === "parrafo" || b.tipo === "subtitulo") && (!b.texto || b.texto.length > TOPES_DOC.maxTextoBloque)) v.push(`${donde}: texto vacío o largo`);
      if ((b.tipo === "parrafo") && (b.texto.split("**").length - 1) % 2) v.push(`${donde}: negrita sin cerrar «${b.texto.slice(0, 40)}»`);
      if (b.tipo === "subtitulo" && (b.nivel !== 2 && b.nivel !== 3 || b.texto.length > TOPES_IMPORTACION.maxCaracteresTitulo)) v.push(`${donde}: subtítulo inválido`);
      if (b.tipo === "vinetas" && (!b.items.length || b.items.some((x) => !x || x.length > TOPES_DOC.maxTextoBloque))) v.push(`${donde}: viñetas inválidas`);
      if (b.tipo === "tabla") {
        if (b.columnas.length > TOPES_DOC.maxColumnas || b.filas.length > TOPES_DOC.maxFilasTabla) v.push(`${donde}: tabla excede topes`);
        if (b.filas.some((f) => f.length !== b.columnas.length)) v.push(`${donde}: fila de ancho distinto`);
        if (b.anchos && (b.anchos.length !== b.columnas.length || b.anchos.reduce((a, c) => a + c, 0) !== 100)) v.push(`${donde}: anchos inválidos ${b.anchos}`);
      }
      if (b.tipo === "imagen") {
        bloquesImagen.add(b.id);
        if (b.archivo !== null || b.anchoPct < 10 || b.anchoPct > 100) v.push(`${donde}: imagen inválida`);
        const c = r.pendientes[b.id];
        const img = c ? claves.get(c) : undefined;
        if (!img || !["image/png", "image/jpeg", "image/gif"].includes(img.mime)) v.push(`${donde}: imagen sin pendiente soportado`);
      }
    });
  };
  if (r.secciones.length > TOPES_DOC.maxSecciones || !r.secciones.length) v.push(`${r.secciones.length} secciones`);
  for (const s of r.secciones) {
    verId(s.id);
    if (!s.titulo || !s.activa || !s.numerada) v.push(`sección inválida «${s.titulo}»`);
    revisar(s.bloques, s.titulo);
  }
  revisar(r.preliminares.resto, "resto");
  for (const g of r.preliminares.glosario ?? []) verId(g.id);
  for (const k of Object.keys(r.pendientes)) if (!bloquesImagen.has(k)) v.push(`pendiente sin bloque ${k}`);
  if (r.preliminares.portadaImagen && !claves.has(r.preliminares.portadaImagen)) v.push("portada sin imagen");
  for (const a of r.avisos) if (!CODIGOS_AVISO.has(a.codigo) || !a.texto) v.push(`aviso inválido ${a.codigo}`);
  if (r.avisos.length > TOPES_IMPORTACION.maxAvisos + 1) v.push("demasiados avisos");
  return v;
}

// ══ 1. Parser XML ════════════════════════════════════════════════════════════
sec("1. Parser XML");
{
  const r = parsearXml(`\uFEFF<?xml version="1.0"?><!-- c --><raiz a='1 &gt; 0' b="x>y" c="&#233;&#x1F600;&amp;&nbsp;"><h>uno &lt;dos&gt; &amp; &quot;tres&quot; &apos;</h><![CDATA[<no es etiqueta> &amp;]]><v/>fin</raiz>`);
  check(r.nombre === "raiz", "raíz");
  check(r.atributos.a === "1 > 0" && r.atributos.b === "x>y", `atributos con «>»: ${JSON.stringify(r.atributos)}`);
  check(r.atributos.c === "é😀&&nbsp;", `numéricas y desconocida literal: ${r.atributos.c}`);
  const h = r.hijos[0] as NodoXml;
  check(h.hijos[0] === `uno <dos> & "tres" '`, "las 5 predefinidas");
  check(r.hijos[1] === "<no es etiqueta> &amp;", "CDATA es texto crudo");
  check((r.hijos[2] as NodoXml).nombre === "v" && r.hijos[3] === "fin", "autocierre y texto final");
  check(decodificarEntidades("&#0;&#xD800;&#1114112;") === "\uFFFD\uFFFD\uFFFD", "numéricas inválidas → U+FFFD");
  const proto = parsearXml(`<a __proto__="x" constructor="y"/>`);
  check(proto.atributos["__proto__"] === "x" && Object.getPrototypeOf(proto.atributos) === null && ({} as any).x === undefined, "__proto__ es una clave más");
  const norm = parsearXml(`<a v="l1\nl2\tt&#10;"/>`);
  check(norm.atributos.v === "l1 l2 t\n", "normalización de atributos (y &#10; se conserva)");
  const codigo = (x: string) => { const e = lanza(() => parsearXml(x)); return e instanceof ErrorXml ? e.codigo : e; };
  check(codigo(`<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`) === "dtd_prohibido", "DOCTYPE lanza");
  check(codigo(`<a><!ENTITY x "y"></a>`) === "dtd_prohibido", "ENTITY lanza");
  check(codigo(`<a><b></a></b>`) === "mal_formado", "cierre cruzado lanza");
  check(codigo(`<a>`) === "mal_formado", "sin cerrar lanza");
  check(codigo(`<a/><b/>`) === "mal_formado", "dos raíces lanza");
  check(codigo(`texto<a/>`) === "mal_formado", "texto fuera de la raíz lanza");
  check(codigo(`<a b=c/>`) === "mal_formado", "valor sin comillas lanza");
  check(codigo("<a>" + "<b>".repeat(300) + "</b>".repeat(300) + "</a>") === "anidamiento", "anidamiento > 256 lanza");
  const prof = 50_000;
  const hondo = parsearXml("<x>".repeat(prof) + "</x>".repeat(prof), { maxProfundidad: prof + 1 });
  let d = 0, n: NodoXml | undefined = hondo; while (n) { d++; n = n.hijos[0] as NodoXml | undefined; }
  check(d === prof, `iterativo: ${d} niveles sin reventar la pila`);
  // Prefijos canónicos por espacio de nombres.
  const c = canonizarPrefijos(parsearXml(`<x:doc xmlns:x="urn:w" xmlns="urn:d"><x:p x:val="1" plano="2"/><q/></x:doc>`), { "urn:w": "w", "urn:d": "d" });
  check(c.nombre === "w:doc" && (c.hijos[0] as NodoXml).nombre === "w:p" && (c.hijos[0] as NodoXml).atributos["w:val"] === "1"
    && (c.hijos[0] as NodoXml).atributos.plano === "2" && (c.hijos[1] as NodoXml).nombre === "d:q", "canonizar prefijos de elementos y atributos");
  // Rendimiento: un documento de ~3 MB.
  const grande = "<r>" + "<w:p><w:r><w:t>texto de prueba con &amp; entidades</w:t></w:r></w:p>".repeat(50_000) + "</r>";
  const t0 = Date.now(); const g = parsearXml(grande);
  check(g.hijos.length === 50_000 && Date.now() - t0 < 5000, `3 MB en ${Date.now() - t0} ms`);
}

// ══ 2. Zip ═══════════════════════════════════════════════════════════════════
sec("2. Zip: lectura, topes y archivos hostiles");
{
  const z1 = zipCfb({ "a.txt": "hola ñ", "carpeta/b.bin": PNG }, true);
  const m1 = leerZip(z1);
  check(new TextDecoder().decode(m1.get("a.txt")!) === "hola ñ" && m1.get("carpeta/b.bin")!.length === PNG.length, "comprimido (CFB)");
  const m2 = leerZip(zipCfb({ "a.txt": "x".repeat(1000) }, false));
  check(m2.get("a.txt")!.length === 1000, "sin comprimir (CFB)");
  const dd = leerZip(zipPropio([{ nombre: "uno.txt", datos: enc.encode("con descriptor") , descriptor: true }, { nombre: "dós.txt", datos: enc.encode("utf8") }]));
  check(new TextDecoder().decode(dd.get("uno.txt")!) === "con descriptor", "descriptor de datos (tamaños locales en 0)");
  check(dd.has("dós.txt"), "nombre UTF-8");
  const codigoZip = (b: Uint8Array, t?: Parameters<typeof leerZip>[1]) => { const e = lanza(() => leerZip(b, t)); return e instanceof ErrorZip ? e.codigo : e; };
  check(codigoZip(enc.encode("esto no es un zip, solo texto")) === "no_es_zip", "basura → no_es_zip");
  check(codigoZip(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])) === "ole", "OLE (.doc o .docx con contraseña) → ole");
  check(codigoZip(new Uint8Array(TOPES_ZIP.maxBytesEntrada + 1)) === "demasiado_grande", "más de 25 MB");
  check(codigoZip(zipPropio([{ nombre: "c.txt", datos: enc.encode("x"), cifrada: true }])) === "zip_cifrado", "entrada cifrada");
  check(codigoZip(zipPropio([{ nombre: "a.txt", datos: enc.encode("1") }, { nombre: "A.TXT", datos: enc.encode("2") }])) === "zip_ilegible", "parte repetida");
  const muchas = zipPropio(Array.from({ length: TOPES_ZIP.maxEntradas + 1 }, (_, k) => ({ nombre: `e${k}`, datos: enc.encode("x") })));
  check(codigoZip(muchas) === "demasiadas_entradas", "más de 2 000 entradas");
  // Bomba por tamaños declarados: el directorio central dice 200 MB → no se llega a inflar.
  const bomba = zipCfb({ "word/document.xml": "a".repeat(10_000) }, true);
  for (const e of cdEntradas(bomba)) if (e.nombre.endsWith("document.xml")) new DataView(bomba.buffer).setUint32(e.cd + 24, 200 * 1024 * 1024, true);
  check(codigoZip(bomba) === "bomba_zip", "suma declarada > tope → bomba_zip");
  // Bomba real con un tope chico: 2 MB de «a» comprimen a casi nada.
  const real = zipCfb({ "x.txt": "a".repeat(2 * 1024 * 1024) }, true);
  check(real.length < 200_000 && codigoZip(real, { ...TOPES_ZIP, maxBytesDescomprimidos: 1024 * 1024 }) === "bomba_zip", `2 MB en ${real.length} bytes → bomba_zip con tope de 1 MB`);
  // Una entrada que MIENTE (dice 1 000 bytes e infla 1 MB): la memoria queda en lo declarado.
  const miente = zipCfb({ "x.txt": "b".repeat(1024 * 1024) }, true);
  const dv = new DataView(miente.buffer);
  for (const e of cdEntradas(miente)) { dv.setUint32(e.cd + 24, 1000, true); dv.setUint32(e.local + 22, 1000, true); }
  const mm = lanza(() => leerZip(miente));
  const mv = mm === null ? leerZip(miente).get("x.txt") : null;
  check(mm === null && mv?.length === 1000, `entrada que miente (dice 1 000, infla 1 MB): queda en lo declarado (${mv?.length})`);
  check(zipCfb({ a: "x" }, true) !== null && leerZip(z1) !== m1, "no muta la entrada");
  const copia = z1.slice(); leerZip(z1);
  check(copia.every((x, k) => x === z1[k]), "los bytes de entrada no se tocan");
}

// ══ 3. Importador ════════════════════════════════════════════════════════════
sec("3a. Documento con estilos en castellano (comprimido)");
const zA = zipCfb(PARTES_A, true);
const rA = importar(zA);
check(rA.ok, `importa: ${!rA.ok ? (rA as any).detalle : ""}`);
if (rA.ok) {
  check(violaciones(rA).length === 0, `invariantes A: ${violaciones(rA).join(" · ")}`);
  const titulos = rA.secciones.map((s) => s.titulo);
  check(JSON.stringify(titulos) === JSON.stringify(["Resumen ejecutivo", "Tablas", "Imágenes"]), `secciones: ${JSON.stringify(titulos)}`);
  const [s1, s2, s3] = rA.secciones;
  // Preliminares
  const pr = rA.preliminares;
  const portada = rA.imagenes.find((i) => i.clave === pr.portadaImagen);
  check(portada?.ruta === "word/media/image1.png" && portada.anchoEmu === 7_600_000, "portada: la imagen de ≥ 6 pulgadas");
  check(pr.control?.documento === "Propuesta técnica de prueba" && pr.control.version === "1.0 – Presentación" && pr.control.codigo === "PT-01"
    && pr.control.elaboradoPor === "Área de Operaciones" && pr.control.revisadoPor === "Fulana de Tal" && pr.control.aprobadoPor === "Mengano Pérez"
    && pr.control.fecha === "2026-10-17" && pr.control.confidencialidad === "Uso exclusivo del concurso" && pr.control.activo === true,
    `control: ${JSON.stringify(pr.control)}`);
  check(avisosDe(rA, "dato_omitido").some((a) => a.texto.includes("Observación")) && !avisosDe(rA, "dato_omitido").some((a) => a.texto.includes("ACME")),
    "control: fila sin campo avisada; la derivada (Cliente) se calla");
  check(pr.glosario?.length === 3 && pr.glosario[0].termino === "CD" && pr.glosario[2].definicion === "Gestión humana.", `glosario: ${JSON.stringify(pr.glosario)}`);
  const c = pr.carta;
  check(c?.activa === true && c.lugarFecha === "Lima, 3 de octubre de 2026" && c.destinatario === "Señores\nEMPRESA CLIENTE S.A."
    && c.atencion === "Sr. Juan Pérez – Compras" && c.referencia === "Concurso ABC-2026 – Transporte de personal", `carta (encabezado): ${JSON.stringify(c)}`);
  check(c?.cuerpo === "Presente.-\n\nDe nuestra consideración:\n\nNuestra empresa **presenta** su propuesta técnica conforme a las bases."
    && c.despedida === "Atentamente," && c.conFirma === true, `carta (cuerpo y firma): ${JSON.stringify(c?.cuerpo)} · ${c?.despedida} · ${c?.conFirma}`);
  check(rA.imagenes.some((i) => i.ruta === "word/media/image2.png") && !Object.values(rA.pendientes).includes(rA.imagenes.find((i) => i.ruta === "word/media/image2.png")!.clave),
    "la firma se encuentra pero no es bloque");
  const resto = pr.resto.map((b) => b.tipo === "parrafo" ? b.texto : b.tipo);
  check(JSON.stringify(resto) === JSON.stringify(["**Versión 1.0**", "Juan Firmante"]), `resto: ${JSON.stringify(resto)}`);
  check(avisosDe(rA, "cuadro_de_texto").some((a) => a.donde === "Antes del primer título"), "cuadro de texto de la portada avisado (una sola vez su texto)");
  check(avisosDe(rA, "indice_omitido").length === 1, "índice omitido, un aviso");
  // Sección 1
  const par1 = deTipo(s1.bloques, "parrafo")[0];
  check(par1?.texto === "Texto **importante** y más insertado enlace 7 final **fuerte** no", `runs: «${par1?.texto}»`);
  const sub = deTipo(s1.bloques, "subtitulo");
  check(sub[0]?.texto === "Cifras clave" && sub[0].nivel === 2 && sub[0].numerado, "Título 2 → subtítulo sin «1.1»");
  check(sub[1]?.texto === "Detalle" && sub[1].nivel === 3, "Título 3 → subtítulo 3 sin «1.1.1»");
  check(sub[2]?.texto === "Nivel cuatro" && sub[2].nivel === 3 && avisosDe(rA, "estilo_desconocido").length === 1, "Título 4 → nivel 3 y aviso");
  const listas = deTipo(s1.bloques, "vinetas");
  check(JSON.stringify(listas[0]?.items) === JSON.stringify(["Uno", "Dos", "Dos-a", "Tres"]) && listas[0].ordenada, "lista decimal agrupada");
  check(JSON.stringify(listas[1]?.items) === JSON.stringify(["**A.** Primera viñeta", "Segunda viñeta"]) && !listas[1].ordenada, "viñetas con negrita");
  check(JSON.stringify(listas[2]?.items) === JSON.stringify(["Suelta sin numeración"]) && !listas[2].ordenada, "List Paragraph sin numPr → viñeta");
  check(JSON.stringify(listas[3]?.items) === JSON.stringify(["Cuatro"]) && listas[3].ordenada, "lista que continúa");
  check(listas[4]?.ordenada && listas[5]?.ordenada && listas.length === 6, `romanos y desde 5: ${listas.length} listas`);
  const ln = avisosDe(rA, "lista_numerada").map((a) => a.texto);
  check(ln.some((t) => t.includes("subniveles")) && ln.some((t) => t.includes("lista anterior")) && ln.some((t) => t.includes("números romanos"))
    && ln.some((t) => t.includes("empezaba en 5")), `avisos de listas: ${ln.join(" | ")}`);
  const parrafos1 = deTipo(s1.bloques, "parrafo").map((b) => b.texto);
  check(parrafos1.includes("Sin número visible") && parrafos1.includes("Lista anulada"), "numFmt none y numId 0 → párrafos");
  check(parrafos1.includes(textoLargo) && avisosDe(rA, "subtitulo_sospechoso").length === 2, "título larguísimo → párrafo sin la negrita del estilo, avisado");
  check(parrafos1.includes("**Texto con estilo de cuerpo**") && !sub.some((x) => x.texto.includes("estilo de cuerpo")),
    "outlineLvl 9 gana sobre el título heredado (párrafo, con la negrita que hereda el estilo)");
  check(avisosDe(rA, "numeracion_quitada").length === 1 && avisosDe(rA, "numeracion_quitada")[0].texto.includes("4 título"), `numeración quitada: ${avisosDe(rA, "numeracion_quitada")[0]?.texto}`);
  // Sección 2: tablas
  const tablas = deTipo(s2.bloques, "tabla");
  const t1 = tablas[0];
  check(JSON.stringify(t1?.columnas) === JSON.stringify(["A", "B", "C"]) && JSON.stringify(t1.filas) === JSON.stringify([["x", "", "y"], ["m", "n", "o"], ["", "p q2", "q"]]),
    `celdas combinadas aplanadas: ${JSON.stringify(t1?.filas)}`);
  check(JSON.stringify(t1?.anchos) === JSON.stringify([20, 30, 50]), `anchos del grid: ${t1?.anchos}`);
  check(avisosDe(rA, "tabla_combinada").length === 1, "tabla combinada avisada");
  check(JSON.stringify(tablas[1]?.columnas) === JSON.stringify(["", ""]) && tablas[1].filas.length === 2 && tablas[1].anchos === null, "sin encabezado → columnas vacías");
  check(JSON.stringify(tablas[2]?.columnas) === JSON.stringify(["H1", "H2"]) && JSON.stringify(tablas[2].filas) === JSON.stringify([["v1", "v2"]]), "encabezado por negrita");
  check(JSON.stringify(tablas[3]?.filas) === JSON.stringify([["Mapa"], ["Leyenda del mapa"]]) && JSON.stringify(tablas[3].columnas) === JSON.stringify([""]), `fila de solo imagen quitada: ${JSON.stringify(tablas[3])}`);
  const trasMapa = s2.bloques[s2.bloques.indexOf(tablas[3]) + 1];
  check(trasMapa?.tipo === "imagen" && avisosDe(rA, "imagen_en_tabla").length === 1, "imagen de la celda debajo de la tabla");
  check(tablas[4]?.columnas.length === 12 && tablas[4].columnas[11] === "C12 · C13 · C14" && tablas[4].filas[0][11] === "v12 · v13 · v14"
    && avisosDe(rA, "recortado").some((a) => a.texto.includes("14 columnas")), "14 columnas → 12, juntas y avisado");
  const tiposS2 = s2.bloques.map((b) => b.tipo);
  const iSalto = tiposS2.indexOf("salto_pagina");
  check(iSalto > 0 && tiposS2[iSalto + 1] === "parrafo" && tiposS2.filter((t) => t === "salto_pagina").length === 1, "dos saltos seguidos → uno");
  // Sección 3: imágenes
  const imgs = deTipo(s3.bloques, "imagen");
  check(imgs.length === 3, `imágenes en la sección 3: ${imgs.length} (PNG ×2 + VML; EMF y vinculada fuera)`);
  check(imgs[0]?.pie === "Figura 1. Prueba de pie" && imgs[0].anchoPct === 50, `pie en cursiva y ancho: ${imgs[0]?.pie} ${imgs[0]?.anchoPct}`);
  check(imgs[1]?.pie === "Figura 2. Con estilo Descripción", "pie con estilo Descripción tras un vacío");
  check(rA.pendientes[imgs[0].id] === rA.pendientes[imgs[1].id], "la misma imagen dos veces = una clave");
  check(imgs[2]?.anchoPct === 32 && rA.imagenes.find((i) => i.clave === rA.pendientes[imgs[2].id])?.mime === "image/png", "VML: tamaño del estilo y formato por bytes (.jpeg que es PNG)");
  const ns = avisosDe(rA, "imagen_no_soportada").map((a) => a.texto);
  check(ns.some((t) => t.includes("EMF")) && ns.some((t) => t.includes("vinculada")), `EMF y vinculada avisadas: ${ns.join(" | ")}`);
  check(rA.imagenes.some((i) => i.mime === "image/x-emf"), "la EMF figura en imagenes (sin bloque)");
  check(avisosDe(rA, "grafico_omitido").length === 1, "gráfico omitido");
  const p3 = deTipo(s3.bloques, "parrafo").map((b) => b.texto);
  check(p3.includes("Ancla del cuadro") && p3.includes("Cuadro uno") && p3.includes("Cuadro dos") && p3.indexOf("Cuadro uno") > p3.indexOf("Ancla del cuadro"), "cuadro de texto en su lugar");
  check(avisosDe(rA, "dato_omitido").some((a) => a.texto.includes("nota al pie")), "nota al pie avisada");
  check(s3.bloques[s3.bloques.length - 1].tipo !== "salto_pagina" && p3.includes(textoLargo) && p3.includes("Cierre de la sección"),
    "salto final podado; un Título 1 larguísimo no abre sección");
  // Corolario: el importador sí produce cada tipo de bloque.
  const todos = rA.secciones.flatMap((s) => s.bloques.map((b) => b.tipo));
  for (const t of ["parrafo", "subtitulo", "vinetas", "tabla", "imagen", "salto_pagina"] as const) check(todos.includes(t), `produce ${t}`);
}

sec("3b. Estilos en inglés, prefijos raros, sin compresión");
{
  const r = importar(zipCfb(PARTES_B, false));
  check(r.ok && violaciones(r).length === 0, `importa B: ${r.ok ? violaciones(r).join(" · ") : (r as any).detalle}`);
  if (r.ok) {
    check(r.secciones.length === 1 && r.secciones[0].titulo === "Executive summary", "Heading1 con prefijo ns1:");
    const b = r.secciones[0].bloques;
    const subs = deTipo(b, "subtitulo").map((x) => x.texto);
    check(JSON.stringify(subs) === JSON.stringify(["Scope", "Fallback by id"]), `Heading2 y respaldo por id: ${JSON.stringify(subs)}`);
    const l = deTipo(b, "vinetas");
    check(l[0]?.ordenada && JSON.stringify(l[0].items) === JSON.stringify(["first", "second"]) && l[1] && !l[1].ordenada, "listas con numeración ns1:");
    check(!deTipo(b, "parrafo").some((x) => x.texto === "Index entry") && avisosDe(r, "indice_omitido").length === 1, "toc 1 omitido");
  }
}

sec("3c. Sin títulos, descriptor de datos y fallos");
{
  const r = importar(zipCfb(docMinimo(p("Solo un párrafo") + p("Y otro") + p("Con subtítulo", { estilo: "Ttulo2" })), true));
  check(r.ok && r.secciones.length === 1 && r.secciones[0].titulo === SECCION_SIN_TITULOS && avisosDe(r, "sin_titulos").length === 1
    && r.ok && r.secciones[0].bloques.length === 3, "sin Título 1 → «Contenido importado»");
  const partes = docMinimo(p("Título", { estilo: "Ttulo1" }) + p("cuerpo"));
  const rd = importar(zipPropio(Object.entries(partes).map(([nombre, v]) => ({ nombre, datos: aBytes(v), descriptor: true }))));
  check(rd.ok && rd.secciones[0].titulo === "Título", "zip con descriptor de datos");
  const fallo = (r: ResultadoImportacion) => r.ok ? "ok" : r.codigo;
  check(fallo(importar(zipCfb(docMinimo(p("x")), true).slice(0, 0))) === "archivo_no_docx", "vacío");
  check(fallo(importar(enc.encode("no soy un docx"))) === "archivo_no_docx", "basura");
  const ole = importar(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
  check(fallo(ole) === "archivo_no_docx" && !ole.ok && ole.detalle.includes("contraseña"), "OLE nombra .doc / contraseña");
  check(fallo(importar(new Uint8Array(TOPES_IMPORTACION.maxBytesArchivo + 1))) === "demasiado_grande", "> 25 MB");
  const xl = importar(zipCfb({ "[Content_Types].xml": TIPOS, "xl/workbook.xml": "<workbook/>" }, true));
  check(fallo(xl) === "sin_documento" && !xl.ok && xl.detalle.includes("Excel"), "un xlsx → sin_documento nombrando Excel");
  const dtd = importar(zipCfb({ ...docMinimo(""), "word/document.xml": `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY a "aaaaaaaa">]><w:document ${NSW}><w:body>${p("&a;")}</w:body></w:document>` }, true));
  check(fallo(dtd) === "xml_ilegible" && !dtd.ok && dtd.detalle.includes("DOCTYPE"), "DOCTYPE → xml_ilegible");
  check(fallo(importar(zipCfb({ ...docMinimo(p("x")), "word/styles.xml": `<w:styles><!ENTITY x "y"></w:styles>` }, true))) === "xml_ilegible", "ENTITY en styles → xml_ilegible");
  check(fallo(importar(zipCfb({ ...docMinimo(""), "word/document.xml": `<w:document ${NSW}><w:body><w:p></w:body></w:document>` }, true))) === "xml_ilegible", "mal formado → xml_ilegible");
  check(fallo(importar(zipCfb({ ...docMinimo(""), "word/document.xml": `<w:otra ${NSW}/>` }, true))) === "sin_documento", "sin w:body → sin_documento");
  const bomba = zipCfb(docMinimo(p("x")), true);
  for (const e of cdEntradas(bomba)) if (e.nombre.endsWith("document.xml")) new DataView(bomba.buffer).setUint32(e.cd + 24, 300 * 1024 * 1024, true);
  check(fallo(importar(bomba)) === "demasiado_grande", "bomba zip → demasiado_grande");
  check(fallo(importar(zipPropio([{ nombre: "word/document.xml", datos: enc.encode("x"), cifrada: true }]))) === "archivo_no_docx", "cifrado → archivo_no_docx");
}

// ══ 4. Topes ═════════════════════════════════════════════════════════════════
sec("4. Topes de TOPES_DOC: recorta y avisa");
{
  const muchos = Array.from({ length: TOPES_DOC.maxSecciones + 5 }, (_, k) => p(`Sección ${k + 1}`, { estilo: "Ttulo1" }) + p("cuerpo")).join("");
  const r1 = importar(zipCfb(docMinimo(muchos), true));
  check(r1.ok && r1.secciones.length === TOPES_DOC.maxSecciones && avisosDe(r1, "recortado").some((a) => a.texto.includes("Sección 61")), "65 títulos → 60 secciones, avisado");
  const largo = p("S", { estilo: "Ttulo1" }) + Array.from({ length: TOPES_DOC.maxBloquesSeccion + 10 }, (_, k) => p(`p${k}`)).join("");
  const r2 = importar(zipCfb(docMinimo(largo), true));
  check(r2.ok && r2.secciones[0].bloques.length === TOPES_DOC.maxBloquesSeccion && avisosDe(r2, "recortado").length === 1, "310 bloques → 300, avisado");
  const enorme = p("S", { estilo: "Ttulo1" }) + par(run("a".repeat(5000)) + run("b".repeat(5000), { b: true }));
  const r3 = importar(zipCfb(docMinimo(enorme), true));
  const t3 = r3.ok ? deTipo(r3.secciones[0].bloques, "parrafo")[0]?.texto ?? "" : "";
  check(t3.length <= TOPES_DOC.maxTextoBloque && t3.endsWith("…") && (t3.split("**").length - 1) % 2 === 0 && avisosDe(r3, "recortado").length === 1,
    `párrafo de 10 000 → ≤ 8 000 sin marca abierta (${t3.length})`);
  const filas = [["c1", "c2"], ...Array.from({ length: TOPES_DOC.maxFilasTabla + 10 }, (_, k) => [`f${k}`, "x"])];
  const r4 = importar(zipCfb(docMinimo(p("S", { estilo: "Ttulo1" }) + tabla(filas, { encabezado: true })), true));
  const t4 = r4.ok ? deTipo(r4.secciones[0].bloques, "tabla")[0] : null;
  check(t4?.filas.length === TOPES_DOC.maxFilasTabla && avisosDe(r4, "recortado").some((a) => a.texto.includes("410 filas")), "410 filas → 400, avisado");
  check(r1.ok && violaciones(r1).length === 0 && r2.ok && violaciones(r2).length === 0 && r3.ok && violaciones(r3).length === 0 && r4.ok && violaciones(r4).length === 0,
    "invariantes con topes");
}

// ══ 5. Piezas puras ══════════════════════════════════════════════════════════
sec("5. Piezas puras");
{
  check(marcarNegrita([{ t: "Hola ", b: true }, { t: "mundo", b: true }, { t: " y", b: false }]).texto === "**Hola mundo** y", "negrita juntada");
  check(marcarNegrita([{ t: "a", b: false }, { t: " b ", b: true }, { t: "c", b: false }]).texto === "a **b** c", "espacios fuera de las marcas");
  check(marcarNegrita([{ t: "  ", b: true }, { t: "x", b: false }]).texto === "x", "negrita de solo espacios no marca");
  check(marcarNegrita([{ t: "uno", b: true }, { t: " ", b: false }, { t: "dos", b: true }]).texto === "**uno dos**", "un espacio no corta la negrita");
  const cut = marcarNegrita([{ t: "x".repeat(50), b: false }, { t: "y".repeat(50), b: true }], 70);
  check(cut.recortado && cut.texto.length <= 70 && (cut.texto.split("**").length - 1) % 2 === 0, `recorte sin marca abierta: ${cut.texto}`);
  check(quitarNumeracion("3.1 Objeto").texto === "Objeto" && quitarNumeracion("1. Resumen").texto === "Resumen" && quitarNumeracion("10.4.2 Portal").texto === "Portal", "numeraciones");
  check(!quitarNumeracion("2026 en cifras").quitada && !quitarNumeracion("1.1").quitada && !quitarNumeracion("Plan 2026").quitada, "no es numeración");
  check(fechaIsoDeTexto("17/10/2026") === "2026-10-17" && fechaIsoDeTexto("2026-10-17") === "2026-10-17" && fechaIsoDeTexto("3 de octubre de 2026") === "2026-10-03"
    && fechaIsoDeTexto("1 setiembre 2026") === "2026-09-01", "fechas reconocidas");
  check(fechaIsoDeTexto("31/02/2026") === null && fechaIsoDeTexto("constructor 2026") === null && fechaIsoDeTexto("pronto") === null, "fechas imposibles → null");
  check(mimeDeImagen(PNG, "x.jpeg") === "image/png" && mimeDeImagen(EMF, "x.bin") === "image/x-emf" && mimeDeImagen(Uint8Array.from([1, 2, 3]), "x.tif") === "otro", "formato por bytes");
}

// ══ 6. Barrido: bytes mutados, nunca lanza ═══════════════════════════════════
sec("6. Barrido de mutaciones");
{
  let semilla = 12345;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) & 0x7fffffff; return semilla / 0x7fffffff; };
  const base = zipCfb(PARTES_A, false); // sin comprimir: las mutaciones tocan el XML
  let lanzo = 0, invalidos = 0, oks = 0, fallos2 = 0;
  for (let k = 0; k < 300; k++) {
    const m = base.slice();
    const n = 1 + Math.floor(azar() * 20);
    for (let j = 0; j < n; j++) {
      const pos = Math.floor(azar() * m.length);
      m[pos] = [0x3c, 0x3e, 0x26, 0x22, 0x2f, Math.floor(azar() * 256)][Math.floor(azar() * 6)];
    }
    try {
      const r = importar(m);
      if (r.ok) { oks++; if (violaciones(r).length) invalidos++; } else { fallos2++; if (!CODIGOS_FALLO.has(r.codigo)) invalidos++; }
    } catch { lanzo++; }
  }
  check(lanzo === 0 && invalidos === 0, `300 mutaciones: ${oks} ok · ${fallos2} fallos declarados · ${lanzo} lanzaron · ${invalidos} inválidos`);
  check(oks > 0 && fallos2 > 0, "el barrido produce los dos desenlaces");
  // Recombinaciones BIEN FORMADAS de los bloques del fixture A (orden, repeticiones, omisiones): ejercita la
  // lógica del importador, no solo el lector. Siempre ok y siempre con las invariantes.
  let okRec = 0, malRec = 0;
  const muestra: string[] = [];
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(azar() * 40);
    const cuerpo = Array.from({ length: n }, () => PIEZAS_A[Math.floor(azar() * PIEZAS_A.length)]).join("");
    try {
      const r = importar(zipCfb({ ...PARTES_A, "word/document.xml": documento(cuerpo) }, k % 2 === 0));
      const v = violaciones(r);
      if (r.ok && !v.length) okRec++; else { malRec++; if (muestra.length < 3) muestra.push(r.ok ? v.join(" · ") : r.codigo); }
    } catch (e) { malRec++; if (muestra.length < 3) muestra.push(String(e)); }
  }
  check(malRec === 0, `200 recombinaciones: ${okRec} ok con invariantes · ${malRec} mal (${muestra.join(" | ")})`);
  // XML aleatorio directo al parser: o árbol o ErrorXml, nunca otra excepción.
  const piezas = ["<a>", "</a>", "<b x='1'/>", "&amp;", "&#x41;", "&raro;", "<![CDATA[x]]>", "<!--c-->", "<?pi?>", "texto", "<", ">", "\"", "<!DOCTYPE x>"];
  let otra = 0;
  for (let k = 0; k < 2000; k++) {
    const s = Array.from({ length: 1 + Math.floor(azar() * 12) }, () => piezas[Math.floor(azar() * piezas.length)]).join("");
    try { parsearXml(s); } catch (e) { if (!(e instanceof ErrorXml)) otra++; }
  }
  check(otra === 0, `2 000 XML aleatorios: ${otra} excepciones que no son ErrorXml`);
}

// ══ 7. Word real (opcional) ══════════════════════════════════════════════════
const RUTA_REAL = process.env.DOCX_REAL;
if (RUTA_REAL) {
  sec(`7. Word real: ${RUTA_REAL}`);
  const b = readFileSync(RUTA_REAL);
  const t0 = Date.now();
  const r = importar(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  const ms = Date.now() - t0;
  check(r.ok, `importa el Word real: ${!r.ok ? (r as any).detalle : ""}`);
  if (r.ok) {
    check(violaciones(r).length === 0, `invariantes del Word real: ${violaciones(r).join(" · ")}`);
    console.log(`   ${(b.length / 1048576).toFixed(1)} MB en ${ms} ms · ${r.secciones.length} secciones · ${r.imagenes.length} imágenes · ${Object.keys(r.pendientes).length} bloques de imagen pendientes`);
    r.secciones.forEach((s, k) => {
      const c: Record<string, number> = {};
      for (const bl of s.bloques) c[bl.tipo] = (c[bl.tipo] ?? 0) + 1;
      console.log(`   ${String(k + 1).padStart(2)}. ${s.titulo.slice(0, 60).padEnd(60)} ${Object.entries(c).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
    });
    const pr = r.preliminares;
    const portada = r.imagenes.find((i) => i.clave === pr.portadaImagen);
    console.log(`   Portada: ${portada ? `${portada.ruta} (${(portada.bytes.length / 1048576).toFixed(1)} MB, ${((portada.anchoEmu ?? 0) / 914400).toFixed(1)} pulg.)` : "no detectada"}`);
    console.log(`   Control: ${JSON.stringify(pr.control)}`);
    console.log(`   Glosario: ${pr.glosario?.length ?? 0} términos (${(pr.glosario ?? []).map((g) => g.termino).join(", ")})`);
    if (pr.carta) {
      const { cuerpo, ...cab } = pr.carta;
      console.log(`   Carta: ${JSON.stringify(cab)} · cuerpo ${cuerpo?.length ?? 0} caracteres, ${(cuerpo ?? "").split("\n\n").length} párrafos`);
    } else console.log("   Carta: no detectada");
    console.log(`   Resto: ${JSON.stringify(pr.resto.map((x) => x.tipo === "parrafo" ? x.texto.slice(0, 60) : x.tipo))}`);
    console.log("   Avisos:");
    for (const a of r.avisos) console.log(`     · [${a.codigo}] ${a.donde ? `(${a.donde}) ` : ""}${a.texto}`);
  }
}

console.log(`\n${fallos === 0 ? "✔" : "✗"} ${ok} comprobaciones, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
