// scripts/prueba-licitaciones-pdf.mts — Matriz del PDF de la PROPUESTA TÉCNICA (lib/licitaciones/pdf/
// propuesta.ts) y de sus piezas compartidas (lib/licitaciones/pdf/comun.ts).
//   npx tsx scripts/prueba-licitaciones-pdf.mts
//   MUESTRA_DIR=<carpeta> npx tsx scripts/prueba-licitaciones-pdf.mts   → escribe propuesta-muestra.pdf
//
// Fija, con la TRAZA (cada texto dibujado con su hoja, zona y caja; sin un lector de PDF):
//  1. **negrita**, saltos de línea, emojis y «≥ → ✓» (salen sin lanzar, con su equivalente o sin él).
//  2. Un documento de 20 secciones con tablas de 130 filas y celdas larguísimas, imágenes PNG y JPEG,
//     una imagen null y otra ausente, carta y cierre con firma:
//     · `PDFDocument.load` da el mismo número de hojas que devuelve el motor;
//     · cada hoja salvo la portada lleva cabecera y pie con «Página X de Y» correcto; la portada, ninguno;
//     · el número de cada entrada del índice es la hoja (visible) donde quedó su título, y el índice
//       lo imprime a la derecha;
//     · ningún texto sale de los márgenes (x + ancho) ni del cuerpo (arriba/abajo);
//     · la tabla que parte hoja repite su cabecera en cada hoja; ninguna fila se parte;
//     · la celda que no cabe en una hoja se recorta con «…» y queda en `recortes`;
//     · ningún título de sección ni subtítulo queda solo al pie de una hoja;
//     · la marca de agua sale en cada hoja.
//  3. Con `numeroPrimeraPagina: 5` la numeración arranca en 5 (la portada) y el índice se corre igual.
//  4. Portada en modo imagen (con y sin la imagen), documento mínimo, portada con textos desmesurados.
//  5. Barrido: documentos al azar (semilla fija) con las mismas invariantes.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { dibujarPropuesta, type EntradaPropuesta } from "../lib/licitaciones/pdf/propuesta";
import {
  GEOMETRIA_LIC, anchoTexto, cargarFuentes, colorDe, incrustarImagen, recortarConElipsis, renglones,
  textoDeRenglon, textoPie, trozosNegrita, type ImagenPdf,
} from "../lib/licitaciones/pdf/comun";
import { aWinAnsi } from "../lib/pdf-winansi";
import type { BloqueResuelto, DocumentoResuelto, SeccionResuelta, TrazaLic, EntradaIndice } from "../lib/licitaciones/tipos";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; if (fallos <= 120) console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);

const G = GEOMETRIA_LIC;
const docFuentes = await PDFDocument.create();
const F = await cargarFuentes(docFuentes);
const JUEGO = F.juego;

// ── Imágenes de prueba (generadas aquí) ──
const gradiente = (w: number, h: number) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = (x * 255) / w; raw[i + 1] = (y * 255) / h; raw[i + 2] = 140;
  }
  return raw;
};
const PNG = new Uint8Array(await sharp(gradiente(160, 90), { raw: { width: 160, height: 90, channels: 3 } }).png().toBuffer());
const JPG = new Uint8Array(await sharp(gradiente(120, 160), { raw: { width: 120, height: 160, channels: 3 } }).jpeg({ quality: 70 }).toBuffer());
const PORTADA_JPG = new Uint8Array(await sharp(gradiente(300, 424), { raw: { width: 300, height: 424, channels: 3 } }).jpeg({ quality: 60 }).toBuffer());
const FIRMA_PNG = new Uint8Array(await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from(`<svg width="200" height="80"><path d="M10 60 C 40 10, 70 70, 100 30 S 160 50, 190 20" stroke="#1a237e" stroke-width="4" fill="none"/></svg>`) }]).png().toBuffer());
const LOGO_PNG = new Uint8Array(await sharp({ create: { width: 240, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from(`<svg width="240" height="80"><rect x="4" y="10" width="60" height="60" rx="10" fill="#123d6b"/><text x="76" y="54" font-size="34" font-family="sans-serif" font-weight="bold" fill="#123d6b">LOGO</text></svg>`) }]).png().toBuffer());

const IMG: Record<string, ImagenPdf | null> = {
  "https://x.test/img/png.png": { bytes: PNG, tipo: "png" },
  "https://x.test/img/jpg.jpg": { bytes: JPG, tipo: "jpg" },
  "https://x.test/img/mal-declarada.jpg": { bytes: PNG, tipo: "jpg" }, // PNG con tipo jpg: manda la firma
  "https://x.test/img/nula.png": null,
  "https://x.test/img/basura.png": { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), tipo: "png" },
  "https://x.test/portada.jpg": { bytes: PORTADA_JPG, tipo: "jpg" },
};

// ════════════════════════════════════════════════════════════════════════════
sec("1. Texto: negrita, saltos, emojis, recortes");
{
  const t = trozosNegrita("hola **mundo** y **más**");
  check(t.length === 4 && t[1].negrita && t[1].texto === "mundo" && !t[2].negrita && t[3].texto === "más", "trozos con dos negritas");
  check(JSON.stringify(trozosNegrita("sin cerrar **aquí")) === JSON.stringify([{ texto: "sin cerrar **aquí", negrita: false }]), "marca sin cerrar queda literal");
  check(trozosNegrita("****").length === 0, "negrita vacía no deja tramo");
  check(trozosNegrita("a**b**c").map((x) => `${x.negrita ? "N" : "R"}:${x.texto}`).join("|") === "R:a|N:b|R:c", "negrita pegada");
  check(trozosNegrita("").length === 0, "vacío");

  const rs = renglones("Seguridad ✅ ≥ 30 → ok ✓ 🚌 fin", F, 10, 400);
  check(rs.length === 1 && textoDeRenglon(rs[0]) === "Seguridad >= 30 -> ok fin", `emojis y flechas: «${rs.map(textoDeRenglon).join("|")}»`);
  const rb = renglones("normal **negrita** normal", F, 10, 400);
  check(rb[0].piezas.some((p) => p.texto === "negrita" && p.fuente === F.neg) && rb[0].piezas[0].fuente === F.reg, "la negrita usa Helvetica-Bold");
  const rl = renglones("a\nb\n\nc", F, 10, 400);
  check(rl.length === 4 && rl[2].piezas.length === 0 && rl.every((r) => r.fin), "saltos de línea y renglón vacío");
  const largo = "x".repeat(400) + " palabra";
  const rw = renglones(largo, F, 10, 120);
  check(rw.length > 3 && rw.every((r) => r.ancho <= 120.01), "palabra enorme cortada por letras dentro del ancho");
  const rc = recortarConElipsis("Un título muy largo que no cabe en el renglón del índice", F.reg, 10, 100);
  check(rc.endsWith("…") && anchoTexto(F.reg, rc, 10) <= 100.01, "recorte con elipsis dentro del ancho");
  check(recortarConElipsis("corto", F.reg, 10, 100) === "corto", "lo que cabe no se recorta");
  check(anchoTexto(F.reg, "AV", 12) >= F.reg.widthOfTextAtSize("AV", 12), "el ancho se mide sin interletraje (lo que dibuja pdf-lib)");
  const c1 = colorDe("#ff0000"), c2 = colorDe("rojo"), c3 = colorDe(null, "#00ff00");
  check(c1.red === 1 && c1.green === 0, "color válido");
  check(Math.abs(c2.red - 0x1f / 255) < 1e-9, "color inválido → respaldo neutro");
  check(c3.green === 1, "color nulo → respaldo pedido");
  check(textoPie("Página {pagina} de {total}", 3, 9) === "Página 3 de 9" && textoPie("", 2, 4) === "Página 2 de 4", "texto del pie");
  const d0 = await PDFDocument.create();
  check((await incrustarImagen(d0, { bytes: PNG, tipo: "jpg" })) !== null, "PNG declarado JPEG: se incrusta por su firma");
  check((await incrustarImagen(d0, { bytes: new Uint8Array([9, 9, 9]), tipo: "png" })) === null, "basura → null");
  check((await incrustarImagen(d0, null)) === null, "null → null");
  check((await incrustarImagen(d0, { bytes: new Uint8Array(PNG.subarray(0, 60)), tipo: "png" })) === null, "PNG cortado → null (no lanza)");
}

// ════════════════════════════════════════════════════════════════════════════
// Documento grande
// ════════════════════════════════════════════════════════════════════════════
const LOREM = "El servicio se presta con **unidades revisadas** y conductores capacitados, conforme a las bases y a la absolución de consultas; el control de abordaje es electrónico ✅ y la puntualidad ≥ 98 % → medida cada mes. ";
const parrafo = (n: number) => Array.from({ length: n }, () => LOREM).join("");
let idb = 0;
const id = () => `b${++idb}`;
const p = (texto: string): BloqueResuelto => ({ id: id(), tipo: "parrafo", texto });
const sub = (texto: string, nivel: 2 | 3, numero: string | null): BloqueResuelto => ({ id: id(), tipo: "subtitulo", texto, nivel, numero });
const tabla = (titulo: string | null, columnas: string[], filas: string[][], anchos: number[] | null = null, pie: string[] | null = null): BloqueResuelto => ({ id: id(), tipo: "tabla", titulo, columnas, filas, anchos, pie });

function documentoGrande(): DocumentoResuelto {
  const secciones: SeccionResuelta[] = [];
  for (let s = 1; s <= 20; s++) {
    const bloques: BloqueResuelto[] = [];
    bloques.push(p(parrafo(1 + (s % 3))));
    bloques.push(sub(`Alcance del punto ${s}`, 2, `${s}.1`));
    bloques.push(p(parrafo(2)));
    if (s === 3) {
      // La tabla larga: 130 filas, cabecera única, la última columna con varios renglones a veces.
      const filas = Array.from({ length: 130 }, (_, k) => {
        const n = String(k + 1).padStart(3, "0");
        return [`f${n}-a`, `Ruta ${k % 7} → paradero ${k}`, k % 9 === 0 ? `Detalle extenso ${"con texto que ocupa varios renglones ".repeat(4)}` : "corto", `f${n}-z`];
      });
      bloques.push(tabla("Relación de servicios ≥ 130", ["COL-UNICA-A", "Recorrido", "Observaciones", "COL-UNICA-Z"], filas, null, ["TOTAL", "", "", "130"]));
    }
    if (s === 5) {
      // Una celda que no cabe en una hoja entera.
      const gigante = ("Celda larguísima ✓ " + "texto ".repeat(40)).repeat(60);
      bloques.push(tabla("Tabla con celda gigante", ["Ítem", "Descripción", "Fin"], [["g1-a", "normal", "g1-z"], ["g2-a", gigante, "g2-z"], ["g3-a", "otra", "g3-z"]], [15, 70, 15]));
    }
    if (s === 6) {
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/png.png", pie: "Figura 1 · Unidad PNG", anchoPct: 70 });
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/jpg.jpg", pie: "Figura 2 · Interior JPEG", anchoPct: 40 });
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/nula.png", pie: "Figura 3 · imagen nula", anchoPct: 60 });
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/no-esta.png", pie: "Figura 4 · imagen ausente", anchoPct: 50 });
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/mal-declarada.jpg", pie: "Figura 5 · PNG declarado JPEG", anchoPct: 30 });
      bloques.push({ id: id(), tipo: "imagen", url: "https://x.test/img/basura.png", pie: "Figura 6 · bytes basura", anchoPct: 30 });
    }
    if (s % 4 === 0) {
      bloques.push({ id: id(), tipo: "vinetas", ordenada: false, items: ["Primer punto con **negrita**", parrafo(1), "Tercer punto ✓"] });
      bloques.push({ id: id(), tipo: "vinetas", ordenada: true, items: Array.from({ length: 12 }, (_, k) => `Paso ${k + 1}: ${k % 3 === 0 ? parrafo(1) : "breve"}`) });
    }
    if (s % 5 === 0) {
      bloques.push({ id: id(), tipo: "nota", tono: "info", texto: "Nota informativa: " + parrafo(1) });
      bloques.push({ id: id(), tipo: "nota", tono: "aviso", texto: "Aviso: " + parrafo(2) });
    }
    if (s === 9) bloques.push({ id: id(), tipo: "salto_pagina" });
    bloques.push(sub(`Detalle técnico ${s}`, 3, `${s}.1.1`));
    bloques.push(p(parrafo(1)));
    if (s % 2 === 0) bloques.push(tabla(`Indicadores ${s}`, ["Indicador", "Meta", "Frecuencia"], Array.from({ length: 6 + s }, (_, k) => [`Indicador ${k + 1} de la sección ${s}`, `≥ ${90 + (k % 9)} %`, k % 2 ? "Mensual" : "Diaria"])));
    bloques.push(sub(`Compromisos ${s}`, 2, `${s}.2`));
    bloques.push(p(parrafo(1)));
    const titulo = s === 7 ? "Dimensionamiento y asignación de flota con una explicación tan larga que el título no cabe en un solo renglón 🚌" : `Sección de prueba número ${s}`;
    secciones.push({ id: `s${s}`, numero: String(s), titulo, bloques });
  }
  return {
    cabecera: "Propuesta Técnica · Concurso de prueba CP-001 · Cliente de Prueba S.A.C.",
    color: "#123d6b",
    portada: {
      modo: "generada", imagenUrl: null, titulo: "PROPUESTA TÉCNICA",
      subtitulo: "SERVICIO DE TRANSPORTE DE PERSONAL ✅ · CONCURSO CP-001 · CLIENTE DE PRUEBA",
      lineas: ["Versión: 1.0 | Código: PT-PRUEBA-001 | Fecha de entrega: 03/10/2026", "PRESENTADO POR:", "**EMPRESA DE PRUEBA S.A.C.**", "RUC N° 00000000000", "Av. Siempre Viva 123, Lima", "LIMA, 3 DE OCTUBRE DE 2026"],
    },
    control: [["Documento", "Propuesta técnica"], ["Cliente", "Cliente de Prueba (CP-001)"], ["Versión", "1.0"], ["Elaborado por", "Área de Operaciones"], ["Revisado por", "Administración de Contratos"], ["Aprobado por", "Gerencia General"], ["Fecha", "03/10/2026"], ["Confidencialidad", "Uso exclusivo del concurso → CP-001"]],
    carta: {
      lugarFecha: "Lima, 3 de octubre de 2026",
      destinatario: ["Señores", "**CLIENTE DE PRUEBA S.A.C.**", "**Atención: Sr. Comprador de Prueba**"],
      referencia: "Concurso CP-001 — Transporte de personal",
      cuerpo: ["Presente. —", "De nuestra consideración:", parrafo(3), parrafo(2), "Declaramos conocer y aceptar las bases ✓."],
      despedida: "Atentamente,",
      conFirma: true,
    },
    glosario: Array.from({ length: 12 }, (_, k) => [`TÉRMINO ${k + 1}`, `Definición del término ${k + 1}: ${k % 3 === 0 ? parrafo(1) : "breve."}`] as [string, string]),
    indice: { niveles: 2 },
    secciones,
    cierre: { texto: "Quedamos atentos a cualquier consulta.\n\nCordialmente, el equipo de operaciones ✓.", conFirma: true },
    firmante: { nombre: "Persona Firmante de Prueba", dni: "12345678", cargo: "Gerente General", firmaUrl: "https://x.test/firma.png" },
    pie: { izquierda: "Empresa de Prueba S.A.C. · Propuesta técnica CP-001", derecha: "Página {pagina} de {total}" },
  };
}

// ── Utilidades de comprobación sobre la traza ──
const limpio = (s: string) => aWinAnsi(s, JUEGO);
const sinPunto = (n: string | null) => String(n ?? "").trim().replace(/\.+$/, "");
const etiqueta = (e: { nivel: 1 | 2; numero: string | null; titulo: string }) => {
  const n = sinPunto(e.numero);
  return limpio(n ? (e.nivel === 1 ? `${n}. ${e.titulo}` : `${n} ${e.titulo}`) : e.titulo);
};
/** Hojas que ocupa el índice: las que tienen el título «Índice». Devuelve la última. */
const finIndice = (traza: TrazaLic[]) => {
  const ini = traza.find((t) => t.zona === "cuerpo" && t.texto === "Índice")?.pagina ?? 0;
  if (!ini) return 0;
  // El índice ocupa hojas seguidas hasta la primera hoja con un título de sección; se estima por los números a la derecha.
  let fin = ini;
  for (const t of traza) if (t.zona === "cuerpo" && t.pagina > fin && /^\d+$/.test(t.texto) && Math.abs(t.x + t.ancho - (G.margenX + G.anchoUtil)) < 0.05) fin = t.pagina;
  return fin;
};

type Revision = { paginasPdf: number; titulosOk: number };
async function revisar(nombre: string, ent: EntradaPropuesta, r: { bytes: Uint8Array; paginas: number; indice: EntradaIndice[]; recortes: string[] }, traza: TrazaLic[], primera: number, conMarca: boolean): Promise<Revision> {
  const pdf = await PDFDocument.load(r.bytes);
  check(pdf.getPageCount() === r.paginas, `${nombre}: PDFDocument.load da ${pdf.getPageCount()} hojas y el motor dice ${r.paginas}`);
  const total = primera + r.paginas - 1;
  const d = ent.doc;
  // Cabecera y pie.
  for (let h = 1; h <= r.paginas; h++) {
    const pies = traza.filter((t) => t.pagina === h && t.zona === "pie").map((t) => t.texto);
    const cabs = traza.filter((t) => t.pagina === h && t.zona === "cabecera");
    if (h === 1) {
      check(!pies.length && !cabs.length, `${nombre}: la portada no lleva cabecera ni pie`);
    } else {
      const esperado = textoPie(d.pie.derecha, primera + h - 1, total);
      check(pies.includes(esperado), `${nombre}: hoja ${h} con pie «${esperado}» (tiene ${JSON.stringify(pies)})`);
      if (limpio(d.cabecera)) check(cabs.length > 0, `${nombre}: hoja ${h} con cabecera`);
    }
    if (conMarca) check(traza.some((t) => t.pagina === h && t.zona === "marca"), `${nombre}: marca de agua en la hoja ${h}`);
  }
  // Márgenes.
  const xMin = G.margenX - 0.05, xMax = G.margenX + G.anchoUtil + 0.05;
  for (const t of traza) {
    if (t.zona === "marca") continue;
    if (t.x < xMin || t.x + t.ancho > xMax) { check(false, `${nombre}: «${t.texto.slice(0, 40)}» sale del margen (hoja ${t.pagina}, x=${t.x.toFixed(2)}, fin=${(t.x + t.ancho).toFixed(2)})`); break; }
    if (t.zona === "cuerpo" && t.pagina > 1 && (t.y < G.alto - G.cuerpoHasta - 0.05 || t.y > G.alto - G.cuerpoDesde + 0.05)) { check(false, `${nombre}: «${t.texto.slice(0, 40)}» sale del cuerpo (hoja ${t.pagina}, y=${t.y.toFixed(2)})`); break; }
    if (t.pagina === 1 && (t.y < 0 || t.y > G.alto)) { check(false, `${nombre}: texto de portada fuera de la hoja`); break; }
    if ([...t.texto].some((ch) => !JUEGO.has(ch.codePointAt(0)!))) { check(false, `${nombre}: carácter fuera de WinAnsi en «${t.texto}»`); break; }
  }
  ok++;
  // Índice: cada entrada apunta a la hoja donde se dibujó su título; el título no queda solo al pie.
  const fin = d.indice ? finIndice(traza) : 1;
  let cursor = 0, titulosOk = 0;
  const cuerpo = traza.map((t, i) => ({ t, i })).filter(({ t }) => t.zona === "cuerpo" && t.pagina > fin);
  for (const e of r.indice) {
    const et = etiqueta(e);
    let k = cursor;
    while (k < cuerpo.length) {
      const tx = cuerpo[k].t.texto;
      if (tx === et || (tx.length >= Math.min(6, et.length) && et.startsWith(tx) && tx.startsWith(sinPunto(e.numero) || tx.slice(0, 3)))) break;
      k++;
    }
    if (k >= cuerpo.length) { check(false, `${nombre}: no se encontró el título «${et}» en el cuerpo`); continue; }
    cursor = k + 1;
    const tt = cuerpo[k].t;
    check(primera + tt.pagina - 1 === e.pagina, `${nombre}: «${et}» está en la hoja visible ${primera + tt.pagina - 1} y el índice dice ${e.pagina}`);
    const despues = traza.slice(cuerpo[k].i + 1).filter((u) => u.pagina === tt.pagina && u.zona === "cuerpo" && u.y < tt.y - 1 && !et.includes(u.texto));
    check(despues.length > 0, `${nombre}: el título «${et}» quedó solo al pie de la hoja ${tt.pagina}`);
    titulosOk++;
  }
  if (d.indice) {
    // El índice imprime los números a la derecha, en el orden de las entradas.
    const nums = traza.filter((t) => t.zona === "cuerpo" && t.pagina <= fin && /^\d+$/.test(t.texto) && Math.abs(t.x + t.ancho - (G.margenX + G.anchoUtil)) < 0.05).map((t) => Number(t.texto));
    check(JSON.stringify(nums) === JSON.stringify(r.indice.map((e) => e.pagina)), `${nombre}: el índice imprime los números de página de sus entradas`);
  }
  return { paginasPdf: pdf.getPageCount(), titulosOk };
}

// ════════════════════════════════════════════════════════════════════════════
sec("2. Documento grande (20 secciones, tablas largas, imágenes, firma)");
const DOC = documentoGrande();
const ENT: EntradaPropuesta = { doc: DOC, imagenes: IMG, logo: { bytes: LOGO_PNG, tipo: "png" }, firma: { bytes: FIRMA_PNG, tipo: "png" } };
const traza: TrazaLic[] = [];
const R = await dibujarPropuesta(ENT, { traza, marcaAgua: "BORRADOR" });
console.log(`   ${R.paginas} hojas, ${R.indice.length} entradas de índice, ${R.recortes.length} recortes, ${(R.bytes.length / 1024).toFixed(0)} KB`);
const rev = await revisar("grande", ENT, R, traza, 1, true);
check(R.paginas >= 25, `el documento grande ocupa varias hojas (${R.paginas})`);
check(R.indice.length === 60 && R.indice.filter((e) => e.nivel === 1).length === 20, `índice con 20 secciones y 40 subtítulos de nivel 2 (${R.indice.length})`);
check(!R.indice.some((e) => /Detalle técnico/.test(e.titulo)), "los subtítulos de nivel 3 no van al índice");
check(rev.titulosOk === 60, "todos los títulos se encontraron en el cuerpo");
{
  // La tabla larga: repite cabecera en cada hoja que tiene filas suyas; ninguna fila partida.
  const hojasFilas = new Set(traza.filter((t) => /^f\d{3}-a$/.test(t.texto)).map((t) => t.pagina));
  check(hojasFilas.size >= 3, `la tabla de 130 filas ocupa varias hojas (${hojasFilas.size})`);
  for (const h of hojasFilas) {
    const cab = traza.find((t) => t.pagina === h && t.texto === "COL-UNICA-A");
    const primeraFila = traza.find((t) => t.pagina === h && /^f\d{3}-a$/.test(t.texto));
    check(cab && primeraFila && cab.y > primeraFila.y, `hoja ${h}: la cabecera de la tabla se repite arriba de sus filas`);
  }
  let partidas = 0;
  for (let k = 1; k <= 130; k++) {
    const n = String(k).padStart(3, "0");
    const a = traza.find((t) => t.texto === `f${n}-a`), z = traza.find((t) => t.texto === `f${n}-z`);
    if (!a || !z || a.pagina !== z.pagina || Math.abs(a.y - z.y) > 0.01) partidas++;
  }
  check(partidas === 0, `ninguna fila de la tabla larga se parte (${partidas} partidas)`);
  check(traza.some((t) => t.texto === "TOTAL") && traza.find((t) => t.texto === "TOTAL")!.pagina === traza.find((t) => t.texto === "130" && t.zona === "cuerpo" && t.pagina > 5)?.pagina, "la fila de totales sale entera");
  // La celda gigante: recortada, anotada, en una sola hoja con su fila.
  check(R.recortes.some((x) => /celda gigante/.test(x) && /fila 2/.test(x) && /recort/.test(x)), `el recorte de la celda gigante queda anotado (${JSON.stringify(R.recortes)})`);
  const g2a = traza.find((t) => t.texto === "g2-a"), g2z = traza.find((t) => t.texto === "g2-z");
  check(g2a && g2z && g2a.pagina === g2z.pagina, "la fila de la celda gigante no se parte");
  const enHoja = traza.filter((t) => g2a && t.pagina === g2a.pagina && t.zona === "cuerpo");
  check(enHoja.some((t) => t.texto.endsWith("…")), "la celda gigante termina en «…»");
  // Imágenes.
  check(traza.filter((t) => t.texto === "imagen no disponible").length === 3, "nula, ausente y basura dejan su recuadro «imagen no disponible»");
  check(R.recortes.filter((x) => /Imagen no disponible/.test(x)).length === 3, "las tres imágenes que faltan quedan en recortes");
  check(traza.some((t) => t.texto.includes("Figura 5")) && !R.recortes.some((x) => /Figura 5/.test(x)), "el PNG declarado JPEG se dibuja");
  // Emojis y signos.
  check(traza.some((t) => t.texto.includes(">=")) && traza.some((t) => t.texto.includes("->")), "≥ y → salen como >= y ->");
  // Carta, firma y cierre.
  check(traza.filter((t) => t.texto === "DNI N° 12345678").length === 2, "la firma (carta y cierre) lleva el DNI");
  check(traza.some((t) => t.texto === "Control del documento" && t.pagina === 2), "control del documento en la hoja 2");
  check(traza.some((t) => t.texto === "Glosario") && traza.some((t) => t.texto === "Índice"), "glosario e índice");
  // El título largo se parte en dos renglones y el índice lo recorta a uno.
  const largo = R.indice.find((e) => e.numero === "7" && e.nivel === 1)!;
  const enIndice = traza.filter((t) => t.pagina <= finIndice(traza) && t.texto.startsWith("7. Dimensionamiento"));
  check(enIndice.length === 1 && enIndice[0].texto.endsWith("…"), "el título largo ocupa un renglón del índice, recortado con «…»");
  check(largo && traza.filter((t) => t.pagina === primeraPagina(largo.pagina) && t.zona === "cuerpo" && /no cabe en un solo/.test(t.texto)).length >= 1, "el título largo se dibuja entero en el cuerpo");
}
function primeraPagina(visible: number) { return visible; }

// Determinismo.
{
  const t2: TrazaLic[] = [];
  const R2 = await dibujarPropuesta(ENT, { traza: t2, marcaAgua: "BORRADOR" });
  check(R2.paginas === R.paginas && JSON.stringify(R2.indice) === JSON.stringify(R.indice) && t2.length === traza.length, "dos emisiones del mismo documento dan lo mismo");
}

// ════════════════════════════════════════════════════════════════════════════
sec("3. numeroPrimeraPagina: 5");
{
  const t5: TrazaLic[] = [];
  const R5 = await dibujarPropuesta(ENT, { traza: t5, numeroPrimeraPagina: 5 });
  await revisar("desde-5", ENT, R5, t5, 5, false);
  check(R5.paginas === R.paginas, "mismas hojas");
  const pie2 = t5.filter((t) => t.pagina === 2 && t.zona === "pie").map((t) => t.texto);
  check(pie2.includes(`Página 6 de ${R5.paginas + 4}`), `la numeración arranca en 5 (la portada): hoja 2 = «Página 6 de ${R5.paginas + 4}» (${JSON.stringify(pie2)})`);
  check(R5.indice.every((e, i) => e.pagina === R.indice[i].pagina + 4), "el índice se corre igual (+4)");
  check(!t5.some((t) => t.zona === "marca"), "sin marcaAgua no hay marca");
  const R0 = await dibujarPropuesta(ENT, { numeroPrimeraPagina: 0 });
  check(JSON.stringify(R0.indice) === JSON.stringify(R.indice), "un número inválido (0) cae a 1");
}

// ════════════════════════════════════════════════════════════════════════════
sec("4. Portada en modo imagen, documento mínimo, textos desmesurados");
{
  const minimo = (modo: "imagen" | "generada", url: string | null, mas: Partial<DocumentoResuelto> = {}): DocumentoResuelto => ({
    cabecera: "", color: "no-es-color",
    portada: { modo, imagenUrl: url, titulo: "Propuesta", subtitulo: "", lineas: [] },
    control: null, carta: null, glosario: null, indice: null, secciones: [], cierre: null, firmante: null,
    pie: { izquierda: "", derecha: "Página {pagina} de {total}" }, ...mas,
  });
  const ti: TrazaLic[] = [];
  const Ri = await dibujarPropuesta({ doc: minimo("imagen", "https://x.test/portada.jpg"), imagenes: IMG, logo: null, firma: null }, { traza: ti });
  check(Ri.paginas === 1 && Ri.recortes.length === 0, "portada imagen sola: una hoja, sin recortes");
  check(!ti.some((t) => t.zona === "cuerpo" || t.zona === "pie"), "la portada imagen no lleva texto ni pie");
  const tf: TrazaLic[] = [];
  const Rf = await dibujarPropuesta({ doc: minimo("imagen", "https://x.test/no-esta.jpg"), imagenes: IMG, logo: null, firma: null }, { traza: tf });
  check(Rf.recortes.some((x) => /Portada/.test(x)) && tf.some((t) => t.texto === "Propuesta"), "portada imagen sin la imagen: se dibuja la generada y se anota");
  // Con cuerpo pero sin índice: el índice devuelto lleva los dos niveles igual.
  const secs: SeccionResuelta[] = [{ id: "a", numero: "1.", titulo: "Única", bloques: [sub("Uno", 2, "1.1"), p("texto"), { id: "x", tipo: "salto_pagina" }, { id: "y", tipo: "salto_pagina" }, p("después del salto")] }];
  const ts: TrazaLic[] = [];
  const Rs = await dibujarPropuesta({ doc: minimo("generada", null, { secciones: secs, cabecera: "Cab **negrita** ✓" }), imagenes: {}, logo: null, firma: null }, { traza: ts });
  check(Rs.indice.length === 2 && Rs.indice[0].pagina === 2 && Rs.indice[1].nivel === 2, "sin índice impreso, las entradas salen igual");
  check(ts.some((t) => t.texto === "1. Única"), "un número con punto final no sale con dos puntos");
  check(Rs.paginas === 3, `dos saltos seguidos no dejan una hoja en blanco (${Rs.paginas} hojas)`);
  await revisar("minimo", { doc: minimo("generada", null, { secciones: secs }), imagenes: {}, logo: null, firma: null }, Rs, ts, 1, false);
  // Portada con textos desmesurados.
  const tp: TrazaLic[] = [];
  const Rp = await dibujarPropuesta({ doc: minimo("generada", null, {
    portada: { modo: "generada", imagenUrl: null, titulo: "TÍTULO ".repeat(60), subtitulo: "Subtítulo ".repeat(120), lineas: Array.from({ length: 80 }, (_, k) => `Línea de portada número ${k + 1} con algo de texto`) },
  }), imagenes: {}, logo: { bytes: LOGO_PNG, tipo: "png" }, firma: null }, { traza: tp });
  check(Rp.recortes.filter((x) => /Portada/.test(x)).length === 3, `portada desmesurada: título, subtítulo y líneas anotados (${JSON.stringify(Rp.recortes)})`);
  check(tp.every((t) => t.x >= G.margenX - 0.05 && t.x + t.ancho <= G.margenX + G.anchoUtil + 0.05 && t.y > 40), "la portada desmesurada no se sale de la hoja ni pisa la franja del pie");
  // Un PDF corrupto como logo o firma no rompe nada.
  const Rc = await dibujarPropuesta({ doc: documentoGrande(), imagenes: {}, logo: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), tipo: "png" }, firma: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), tipo: "jpg" } });
  check(Rc.paginas > 10 && Rc.recortes.filter((x) => /Imagen no disponible/.test(x)).length === 6, "logo y firma corruptos, imágenes sin bytes: sale igual");
}

// ════════════════════════════════════════════════════════════════════════════
sec("5. Barrido de documentos al azar");
{
  let a = 12345;
  const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
  const ri = (n: number) => Math.floor(rnd() * n);
  const palabras = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "eiusmod", "tempor", "≥", "→", "✓", "🚌", "**clave**", "x".repeat(70)];
  const frase = (n: number) => Array.from({ length: n }, () => palabras[ri(palabras.length)]).join(" ");
  let hojas = 0, entradasTot = 0;
  for (let caso = 0; caso < 24; caso++) {
    const secciones: SeccionResuelta[] = [];
    const ns = 1 + ri(8);
    for (let s = 1; s <= ns; s++) {
      const bloques: BloqueResuelto[] = [];
      const nb = ri(9);
      let nsub = 0;
      for (let b = 0; b < nb; b++) {
        const tipo = ri(8);
        if (tipo === 0) bloques.push(p(frase(5 + ri(160))));
        else if (tipo === 1) bloques.push(sub(`Subtítulo ${s}-${++nsub} ${frase(ri(4))}`, ri(2) ? 2 : 3, `${s}.${nsub}`));
        else if (tipo === 2) bloques.push({ id: id(), tipo: "vinetas", ordenada: !!ri(2), items: Array.from({ length: 1 + ri(8) }, () => frase(2 + ri(40))) });
        else if (tipo === 3) {
          const nc = 1 + ri(6), nf = ri(70);
          bloques.push(tabla(ri(2) ? `Tabla ${caso}-${s}-${b}` : null, Array.from({ length: nc }, (_, c) => `C${c} ${frase(ri(3))}`),
            Array.from({ length: nf }, (_, k) => Array.from({ length: nc }, (_, c) => (c === 0 ? `T${caso}S${s}B${b}R${k}-a` : c === nc - 1 && nc > 1 ? `T${caso}S${s}B${b}R${k}-z` : frase(ri(30))))),
            ri(3) ? null : Array.from({ length: nc }, () => 1 + ri(5)), ri(4) ? null : Array.from({ length: nc }, (_, c) => (c ? "" : "Total"))));
        } else if (tipo === 4) bloques.push({ id: id(), tipo: "nota", tono: ri(2) ? "info" : "aviso", texto: frase(3 + ri(120)) });
        else if (tipo === 5) bloques.push({ id: id(), tipo: "imagen", url: ["https://x.test/img/png.png", "https://x.test/img/jpg.jpg", "https://x.test/img/nula.png"][ri(3)], pie: ri(2) ? frase(3) : null, anchoPct: 10 + ri(91) });
        else if (tipo === 6) bloques.push({ id: id(), tipo: "salto_pagina" });
        else bloques.push(p(frase(3 + ri(40))));
      }
      secciones.push({ id: `c${caso}s${s}`, numero: ri(6) ? String(s) : null, titulo: `Sección ${caso}-${s} ${frase(ri(12))}`, bloques });
    }
    const doc: DocumentoResuelto = {
      cabecera: frase(ri(30)), color: ["#123d6b", "#7a1f1f", "#000000", "zzz"][ri(4)],
      portada: { modo: ri(4) ? "generada" : "imagen", imagenUrl: ri(2) ? "https://x.test/portada.jpg" : null, titulo: frase(1 + ri(10)), subtitulo: frase(ri(30)), lineas: Array.from({ length: ri(8) }, () => frase(1 + ri(10))) },
      control: ri(2) ? Array.from({ length: 1 + ri(10) }, () => [frase(1 + ri(3)), frase(1 + ri(20))] as [string, string]) : null,
      carta: ri(2) ? { lugarFecha: frase(4), destinatario: [frase(2), frase(3)], referencia: frase(6), cuerpo: Array.from({ length: ri(5) }, () => frase(10 + ri(80))), despedida: "Atentamente,", conFirma: !!ri(2) } : null,
      glosario: ri(2) ? Array.from({ length: 1 + ri(30) }, () => [frase(1), frase(3 + ri(30))] as [string, string]) : null,
      indice: ri(4) ? { niveles: ri(2) ? 1 : 2 } : null,
      secciones,
      cierre: ri(2) ? { texto: frase(10 + ri(60)), conFirma: !!ri(2) } : null,
      firmante: ri(2) ? { nombre: frase(3), dni: "00000001", cargo: frase(2), firmaUrl: null } : null,
      pie: { izquierda: frase(ri(40)), derecha: "Página {pagina} de {total}" },
    };
    const ent: EntradaPropuesta = { doc, imagenes: IMG, logo: ri(2) ? { bytes: LOGO_PNG, tipo: "png" } : null, firma: ri(2) ? { bytes: FIRMA_PNG, tipo: "png" } : null };
    const t: TrazaLic[] = [];
    const primera = 1 + ri(3) * 7;
    let r;
    try { r = await dibujarPropuesta(ent, { traza: t, numeroPrimeraPagina: primera, marcaAgua: ri(2) ? "BORRADOR ✓" : undefined }); }
    catch (e) { check(false, `caso ${caso}: lanzó ${(e as Error).message}`); continue; }
    hojas += r.paginas; entradasTot += r.indice.length;
    await revisar(`azar-${caso}`, ent, r, t, primera, false);
    // Filas no partidas.
    const porFila = new Map<string, TrazaLic[]>();
    for (const x of t) { const m = /^(T\d+S\d+B\d+R\d+)-[az]$/.exec(x.texto); if (m) porFila.set(m[1], [...(porFila.get(m[1]) ?? []), x]); }
    let partidas = 0;
    for (const xs of porFila.values()) if (xs.length === 2 && (xs[0].pagina !== xs[1].pagina || Math.abs(xs[0].y - xs[1].y) > 0.01)) partidas++;
    check(partidas === 0, `azar-${caso}: ninguna fila partida (${partidas})`);
  }
  console.log(`   24 documentos, ${hojas} hojas, ${entradasTot} entradas de índice`);
}

// ════════════════════════════════════════════════════════════════════════════
if (process.env.MUESTRA_DIR) {
  mkdirSync(process.env.MUESTRA_DIR, { recursive: true });
  const ruta = join(process.env.MUESTRA_DIR, "propuesta-muestra.pdf");
  writeFileSync(ruta, R.bytes);
  console.log(`\nMuestra: ${ruta} (${R.paginas} hojas)`);
}

void StandardFonts;
console.log(`\n${fallos ? "✗" : "✓"} ${ok} comprobaciones, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
