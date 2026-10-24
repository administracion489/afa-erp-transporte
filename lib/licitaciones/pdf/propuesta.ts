// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/pdf/propuesta.ts — Dibuja con pdf-lib el PDF de la PROPUESTA TÉCNICA a partir de
// un `DocumentoResuelto` (resolverDocumento, lib/licitaciones/documento.ts). PURO e ISOMÓRFICO: la
// emisión lo llama en el NAVEGADOR (D10); las matrices, en node. No lee la base ni baja nada: las
// imágenes llegan en bytes, indexadas por la `url` de cada bloque imagen y de la portada.
//
// EL MOTOR NO DECIDE CONTENIDO (D11): imprime lo que trae `doc`, en este orden — portada, control
// del documento, carta, glosario, índice, secciones y cierre —. Los únicos textos propios son los
// rótulos del formato («Control del documento», «Glosario», «Índice», «Campo/Detalle»,
// «Término/Definición», «DNI N°», «imagen no disponible») y ninguno nombra a una empresa.
//
// REGLAS DE MAQUETACIÓN (las fija scripts/prueba-licitaciones-pdf.mts):
//  · Cabecera y pie en cada hoja salvo la portada. La hoja k se numera `numeroPrimeraPagina + k − 1`
//    (la portada lleva el primer número aunque no lo muestre) y el total es el último número.
//  · ÍNDICE EN DOS PASADAS: cada entrada ocupa EXACTAMENTE un renglón (un título largo se recorta
//    con «…»), así que las hojas del índice se saben ANTES de maquetar el cuerpo; se reservan en
//    blanco, se maqueta todo y al final se escriben las entradas con la hoja real de cada título.
//  · Las tablas que parten hoja REPITEN su fila de cabecera; una fila nunca se parte (la celda que
//    no cabe en una hoja entera se recorta con «…» y se anota en `recortes`).
//  · Un título de sección o un subtítulo nunca queda solo al pie: si no cabe junto con el comienzo
//    de lo que sigue (dos renglones, la cabecera y la primera fila de una tabla, la imagen entera),
//    salta de hoja.
//  · Ningún texto sale de los márgenes (todo se parte o se recorta al ancho útil).
//  · `marcaAgua` (p. ej. «BORRADOR») en diagonal, gris claro, en cada hoja.
//  · Una imagen null o ausente no se dibuja: queda su recuadro con el pie y «imagen no disponible»,
//    y se anota en `recortes`. Nunca lanza por una imagen.
//
// `indice` devuelve las entradas con el número VISIBLE de la hoja donde quedó cada título (el que
// se imprime en el índice y en el pie). Con índice: las que se imprimen (nivel 2 solo si
// `niveles` = 2). Sin índice: las de los dos niveles igual, para quien las necesite (la relación de
// adjuntos con folios, por ejemplo).
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import {
  A4, ANCHO_UTIL, BLANCO, Lienzo, MARGEN_X, TINTA,
  aclarar, anchoTexto, cargarFuentes, colorDe, conTope, escalarImagen, incrustarImagen, limpiar, lineaBase,
  oscurecer, recortarConElipsis, renglones, sinMarcas,
  type Fuentes, type ImagenPdf, type Renglon, type TablaPreparada,
} from "./comun";
import type { BloqueResuelto, DocumentoResuelto, EntradaIndice, SeccionResuelta, TrazaLic } from "../tipos";

export type EntradaPropuesta = {
  doc: DocumentoResuelto;
  /** Indexado por la `url` de los bloques imagen y de `portada.imagenUrl`. null o ausente → no se dibuja. */
  imagenes: Record<string, ImagenPdf | null>;
  logo: ImagenPdf | null;
  firma: ImagenPdf | null;
};
export type OpcionesPropuesta = {
  traza?: TrazaLic[];
  /** Texto en diagonal sobre cada hoja (p. ej. «BORRADOR»). */
  marcaAgua?: string;
  /** Número visible de la primera hoja (la portada). Por defecto 1. */
  numeroPrimeraPagina?: number;
};
export type ResultadoPropuesta = { bytes: Uint8Array; paginas: number; indice: EntradaIndice[]; recortes: string[] };

// ── Medidas del cuerpo (pt) ──
const TAM = 10, LH = 14;
const TAM_SEC = 15, LH_SEC = 19;
const TAM_SUB2 = 12, LH_SUB2 = 16;
const TAM_SUB3 = 10.5, LH_SUB3 = 14;
const TAM_PRE = 16, LH_PRE = 20;
const TAM_IND1 = 10, TAM_IND2 = 9.5, LH_IND = 16, SANGRIA_IND2 = 18;
/** Lo que ocupa el título de una hoja preliminar (control, glosario, índice): renglón + raya + aire. */
const ALTO_TITULO_PRE = LH_PRE + 5 + 1 + 12;

/** «1.» o «1» → «1»: el número se escribe sin punto final y el formato pone el suyo. */
const sinPunto = (n: string | null | undefined) => String(n ?? "").trim().replace(/\.+$/, "");
const etiquetaSeccion = (numero: string | null, titulo: string) => {
  const n = sinPunto(numero);
  return n ? `${n}. ${titulo}` : titulo;
};
const etiquetaSub = (numero: string | null, texto: string) => {
  const n = sinPunto(numero);
  return n ? `${n} ${texto}` : texto;
};
const tieneTexto = (s: unknown, f: Fuentes) => limpiar(s, f.juego) !== "";

/** Las hojas que ocupa un índice de `n` entradas (un renglón cada una). */
function hojasDeIndice(n: number, desde: number, hasta: number): number {
  const enPrimera = Math.max(1, Math.floor((hasta - desde - ALTO_TITULO_PRE + 0.01) / LH_IND));
  const enOtras = Math.max(1, Math.floor((hasta - desde + 0.01) / LH_IND));
  return n <= enPrimera ? 1 : 1 + Math.ceil((n - enPrimera) / enOtras);
}

/** Generador determinista (la red decorativa de la portada sale igual en cada emisión). */
function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function dibujarPropuesta(entrada: EntradaPropuesta, opts: OpcionesPropuesta = {}): Promise<ResultadoPropuesta> {
  const d = entrada.doc;
  const pdf = await PDFDocument.create();
  const f = await cargarFuentes(pdf);
  const C = colorDe(d.color);
  const recortes: string[] = [];
  const primera = Number.isFinite(opts.numeroPrimeraPagina) && (opts.numeroPrimeraPagina as number) >= 1 ? Math.floor(opts.numeroPrimeraPagina as number) : 1;
  pdf.setTitle(limpiar(d.portada?.titulo, f.juego, 200) || "Propuesta técnica");
  pdf.setProducer("pdf-lib");

  // ── Imágenes (una vez por URL) ──
  const logo = await incrustarImagen(pdf, entrada.logo);
  const firmaImg = await incrustarImagen(pdf, entrada.firma);
  const imagenes = new Map<string, PDFImage | null>();
  const fuenteImg = entrada.imagenes ?? {};
  const urls = new Set<string>();
  if (d.portada?.modo === "imagen" && d.portada.imagenUrl) urls.add(d.portada.imagenUrl);
  for (const s of d.secciones ?? []) for (const b of s.bloques ?? []) if (b.tipo === "imagen" && b.url) urls.add(b.url);
  for (const u of urls) {
    const img = Object.prototype.hasOwnProperty.call(fuenteImg, u) ? fuenteImg[u] : null;
    imagenes.set(u, await incrustarImagen(pdf, img));
  }
  const imagenDe = (u: string | null | undefined) => (u ? imagenes.get(u) ?? null : null);

  const L = new Lienzo(pdf, f, { traza: opts.traza });
  const firmante = d.firmante ? { nombre: d.firmante.nombre, dni: d.firmante.dni, cargo: d.firmante.cargo } : null;

  // ════════════════════════════════════════════════════════════════════════════
  // PORTADA
  // ════════════════════════════════════════════════════════════════════════════
  L.nueva();
  {
    const p = d.portada ?? { modo: "generada" as const, imagenUrl: null, titulo: "", subtitulo: "", lineas: [] };
    const img = p.modo === "imagen" ? imagenDe(p.imagenUrl) : null;
    if (img) {
      // A página completa: cubre la hoja sin deformarse (lo que sobra queda fuera del borde).
      const s = Math.max(A4.ancho / Math.max(1, img.width), A4.alto / Math.max(1, img.height));
      const w = img.width * s, h = img.height * s;
      L.imagen(img, (A4.ancho - w) / 2, (A4.alto - h) / 2, w, h);
    } else {
      if (p.modo === "imagen") recortes.push("Portada: la imagen no está disponible; se dibujó la portada generada.");
      portadaGenerada(L, p, logo, C, recortes);
    }
  }

  // ── Título de una hoja preliminar ──
  const tituloPreliminar = (t: string) => {
    const s = recortarConElipsis(limpiar(t, f.juego, 120), f.neg, TAM_PRE, ANCHO_UTIL);
    L.texto(s, MARGEN_X, lineaBase(L.y, LH_PRE, TAM_PRE), f.neg, TAM_PRE, C);
    L.y += LH_PRE + 5;
    L.rect(MARGEN_X, L.y, ANCHO_UTIL, 1, { relleno: C });
    L.y += 1 + 12;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // CONTROL DEL DOCUMENTO
  // ════════════════════════════════════════════════════════════════════════════
  if (d.control && d.control.length) {
    L.nueva();
    tituloPreliminar("Control del documento");
    const t = L.prepararTabla({ columnas: ["Campo", "Detalle"], filas: d.control.map(([a, b]) => [a, b]), anchos: [30, 70], color: C, primeraColumnaNegrita: true, nombre: "Control del documento", tam: 9, lh: 12 });
    L.dibujarTabla(t);
    recortes.push(...t.recortes);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CARTA
  // ════════════════════════════════════════════════════════════════════════════
  if (d.carta) {
    const c = d.carta;
    L.nueva();
    if (tieneTexto(c.lugarFecha, f)) L.parrafo(c.lugarFecha, { alinear: "der", despues: 18 });
    const dest = (c.destinatario ?? []).filter((s) => tieneTexto(s, f));
    dest.forEach((s) => L.parrafo(s, { juntos: 1 }));
    if (dest.length) L.y += 12;
    if (tieneTexto(c.referencia, f)) L.parrafo(c.referencia, { estilo: { negrita: true }, despues: 12 });
    for (const parr of c.cuerpo ?? []) if (tieneTexto(parr, f)) L.parrafo(parr, { alinear: "just", despues: 8 });
    if (tieneTexto(c.despedida, f)) L.parrafo(c.despedida, { antes: 4, despues: 2 });
    if (c.conFirma) L.firma(firmante, firmaImg, { antes: 8 });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GLOSARIO
  // ════════════════════════════════════════════════════════════════════════════
  if (d.glosario && d.glosario.length) {
    L.nueva();
    tituloPreliminar("Glosario");
    const t = L.prepararTabla({ columnas: ["Término", "Definición"], filas: d.glosario.map(([a, b]) => [a, b]), anchos: [28, 72], color: C, primeraColumnaNegrita: true, nombre: "Glosario", tam: 9, lh: 12 });
    L.dibujarTabla(t);
    recortes.push(...t.recortes);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ÍNDICE (primera pasada: las entradas y cuántas hojas ocupan)
  // ════════════════════════════════════════════════════════════════════════════
  const secciones = (d.secciones ?? []).filter((s) => s && Array.isArray(s.bloques));
  const niveles = d.indice ? d.indice.niveles : 2;
  const entradas: EntradaIndice[] = [];
  const entradaDe = new Map<object, EntradaIndice>();
  for (const s of secciones) {
    if (tieneTexto(s.titulo, f) || sinPunto(s.numero)) {
      const e: EntradaIndice = { nivel: 1, numero: s.numero ?? null, titulo: s.titulo ?? "", pagina: 0 };
      entradas.push(e);
      entradaDe.set(s, e);
    }
    if (niveles === 2) {
      for (const b of s.bloques) {
        if (b.tipo === "subtitulo" && b.nivel === 2 && (tieneTexto(b.texto, f) || sinPunto(b.numero))) {
          const e: EntradaIndice = { nivel: 2, numero: b.numero ?? null, titulo: b.texto ?? "", pagina: 0 };
          entradas.push(e);
          entradaDe.set(b, e);
        }
      }
    }
  }
  const hojasIndice: PDFPage[] = [];
  if (d.indice) {
    const n = hojasDeIndice(entradas.length, L.desde, L.hasta);
    for (let i = 0; i < n; i++) hojasIndice.push(L.nueva());
  }
  const visible = (p: PDFPage) => primera + L.numero(p) - 1;

  // ════════════════════════════════════════════════════════════════════════════
  // SECCIONES Y CIERRE
  // ════════════════════════════════════════════════════════════════════════════
  // El cuerpo es una sola secuencia (títulos de sección, bloques y el cierre): así un título sabe qué
  // viene DESPUÉS aunque sea el título de la sección siguiente, y no queda solo al pie.
  type Elem =
    | { k: "titulo"; s: SeccionResuelta; rs: Renglon[] }
    | { k: "bloque"; s: SeccionResuelta; b: BloqueResuelto }
    | { k: "cierre"; parrafos: string[] };
  const esEncabezado = (e: Elem | undefined) => !!e && (e.k === "titulo" || (e.k === "bloque" && e.b.tipo === "subtitulo"));
  const esSalto = (e: Elem | undefined) => !!e && e.k === "bloque" && e.b.tipo === "salto_pagina";
  const elems: Elem[] = [];
  /**
   * Un salto de página que sigue a uno o varios encabezados (título, subtítulos) se MUEVE antes de
   * ellos: un encabezado seguido de un salto quedaría solo al final de su hoja. Dos saltos seguidos
   * son uno (no dejan una hoja en blanco).
   */
  const agregar = (e: Elem) => {
    if (!esSalto(e)) { elems.push(e); return; }
    let k = elems.length;
    while (k > 0 && esEncabezado(elems[k - 1])) k--;
    if (k > 0 && esSalto(elems[k - 1])) return;
    elems.splice(k, 0, e);
  };
  for (const s of secciones) {
    if (entradaDe.has(s) || tieneTexto(s.titulo, f)) {
      agregar({ k: "titulo", s, rs: renglones(etiquetaSeccion(s.numero, s.titulo ?? ""), f, TAM_SEC, ANCHO_UTIL, { negrita: true }) });
    }
    for (const b of s.bloques) if (b) agregar({ k: "bloque", s, b });
  }
  if (d.cierre) agregar({ k: "cierre", parrafos: String(d.cierre.texto ?? "").split(/\n[ \t]*\n/).filter((t) => tieneTexto(t, f)) });

  const tablas = new Map<BloqueResuelto, TablaPreparada>();
  const nombreSeccion = (s: SeccionResuelta) => (sinPunto(s.numero) ? `sección ${sinPunto(s.numero)}` : `«${limpiar(sinMarcas(s.titulo), f.juego, 60)}»`);
  const tablaDe = (b: Extract<BloqueResuelto, { tipo: "tabla" }>, s: SeccionResuelta) => {
    let t = tablas.get(b);
    if (!t) {
      const nombre = b.titulo && tieneTexto(b.titulo, f) ? `Tabla «${limpiar(sinMarcas(b.titulo), f.juego, 80)}» (${nombreSeccion(s)})` : `Tabla de la ${nombreSeccion(s)}`;
      t = L.prepararTabla({ titulo: b.titulo, columnas: b.columnas ?? [], filas: b.filas ?? [], anchos: b.anchos, pie: b.pie, color: C, nombre });
      tablas.set(b, t);
    }
    return t;
  };
  const medidaSub = (b: Extract<BloqueResuelto, { tipo: "subtitulo" }>) => {
    const [tam, lh] = b.nivel === 2 ? [TAM_SUB2, LH_SUB2] : [TAM_SUB3, LH_SUB3];
    const rs = renglones(etiquetaSub(b.numero, b.texto), f, tam, ANCHO_UTIL, { negrita: true });
    return { rs, tam, lh, alto: rs.length ? rs.length * lh + 4 : 0 };
  };
  const altoTitulo = (rs: Renglon[]) => rs.length * LH_SEC + 4 + 0.8 + 8;
  /** El aire que un elemento deja ARRIBA de sí (se pierde al inicio de una hoja). */
  const antesDe = (e: Elem | undefined): number => {
    if (!e) return 0;
    if (e.k === "titulo") return 18;
    if (e.k === "cierre") return 14;
    if (e.b.tipo === "subtitulo") return e.b.nivel === 2 ? 10 : 7;
    if (e.b.tipo === "tabla") return 2;
    return 0;
  };
  /**
   * Lo mínimo de un elemento que tiene que caber junto al encabezado que lo precede. Un encabezado
   * arrastra al siguiente (una cadena de encabezados va junta hasta el primer contenido).
   */
  const minimo = (i: number, prof: number): number => {
    const e = elems[i];
    if (!e) return 0;
    const yLuego = (alto: number) => alto + (prof < 8 && !esSalto(elems[i + 1]) ? antesDe(elems[i + 1]) + minimo(i + 1, prof + 1) : 0);
    if (e.k === "titulo") return yLuego(altoTitulo(e.rs));
    if (e.k === "cierre") {
      const r0 = e.parrafos.map((t) => renglones(t, f, TAM, ANCHO_UTIL)).find((r) => r.length);
      return r0 ? Math.min(2, r0.length) * LH : 0;
    }
    const b = e.b;
    switch (b.tipo) {
      case "parrafo": return Math.min(2, renglones(b.texto, f, TAM, ANCHO_UTIL).length) * LH;
      case "vinetas": {
        const r0 = (b.items ?? []).map((t) => renglones(t, f, TAM, ANCHO_UTIL - 30)).find((r) => r.length);
        return r0 ? Math.min(2, r0.length) * LH : 0;
      }
      case "tabla": return L.altoInicioTabla(tablaDe(b, e.s));
      case "nota": return 14 + Math.min(2, renglones(b.texto, f, 9.5, ANCHO_UTIL - 19).length) * 9.5 * 1.4;
      case "imagen": return L.medirFigura(imagenDe(b.url), b.anchoPct, b.pie).alto;
      case "subtitulo": return yLuego(medidaSub(b).alto);
      default: return 0;
    }
  };
  /** Antes de un encabezado de `alto`: se reserva junto con el comienzo de lo que sigue (o salta de hoja). */
  const prepararEncabezado = (i: number, alto: number) => {
    const sigue = Math.min(L.altoCuerpo - alto, esSalto(elems[i + 1]) ? 0 : antesDe(elems[i + 1]) + minimo(i + 1, 1));
    L.reservar(antesDe(elems[i]), alto + Math.max(0, sigue));
  };

  if (elems.length) L.nueva();
  elems.forEach((e, i) => {
    if (e.k === "titulo") {
      prepararEncabezado(i, altoTitulo(e.rs));
      const en = entradaDe.get(e.s);
      if (en) en.pagina = visible(L.pag);
      for (const r of e.rs) { L.pintarRenglon(r, MARGEN_X, lineaBase(L.y, LH_SEC, TAM_SEC), TAM_SEC, C, "izq", ANCHO_UTIL); L.y += LH_SEC; }
      L.y += 4;
      L.rect(MARGEN_X, L.y, ANCHO_UTIL, 0.8, { relleno: C });
      L.y += 0.8 + 8;
      return;
    }
    if (e.k === "cierre") {
      e.parrafos.forEach((t, j) => L.parrafo(t, { alinear: "just", antes: j === 0 ? antesDe(e) : 0, despues: 8 }));
      if (d.cierre?.conFirma) L.firma(firmante, firmaImg, { antes: 10 });
      return;
    }
    const b = e.b, s = e.s;
    switch (b.tipo) {
      case "parrafo":
        L.parrafo(b.texto, { alinear: "just", despues: 6 });
        break;
      case "subtitulo": {
        const m = medidaSub(b);
        if (!m.rs.length) break;
        prepararEncabezado(i, m.alto);
        const en = entradaDe.get(b);
        if (en) en.pagina = visible(L.pag);
        const color = b.nivel === 2 ? C : TINTA;
        for (const r of m.rs) { L.pintarRenglon(r, MARGEN_X, lineaBase(L.y, m.lh, m.tam), m.tam, color, "izq", ANCHO_UTIL); L.y += m.lh; }
        L.y += 4;
        break;
      }
      case "vinetas":
        L.lista(b.items ?? [], !!b.ordenada, { despues: 6 });
        break;
      case "tabla": {
        const t = tablaDe(b, s);
        L.dibujarTabla(t, { antes: antesDe(e), despues: 10 });
        recortes.push(...t.recortes);
        break;
      }
      case "nota": {
        const aviso = b.tono === "aviso";
        L.nota(b.texto, { fondo: aviso ? colorDe("#fff6e5") : aclarar(C, 0.9), barra: aviso ? colorDe("#d97706") : C, despues: 8 });
        break;
      }
      case "imagen": {
        const img = imagenDe(b.url);
        if (!img) recortes.push(`Imagen no disponible (${nombreSeccion(s)})${b.pie && tieneTexto(b.pie, f) ? `: «${limpiar(b.pie, f.juego, 80)}»` : ""}. Quedó su recuadro con el pie.`);
        L.figura(img, b.anchoPct, b.pie, { despues: 10 });
        break;
      }
      case "salto_pagina":
        if (!L.enCabeza) L.nueva();
        break;
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ÍNDICE (segunda pasada: las hojas reales)
  // ════════════════════════════════════════════════════════════════════════════
  if (d.indice && hojasIndice.length) {
    let h = 0;
    L.pag = hojasIndice[0];
    L.y = L.desde;
    tituloPreliminar("Índice");
    for (const e of entradas) {
      if (L.y + LH_IND > L.hasta + 0.01) { h++; L.pag = hojasIndice[Math.min(h, hojasIndice.length - 1)]; L.y = L.desde; }
      renglonIndice(L, e, C);
      L.y += LH_IND;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CABECERA, PIE Y MARCA DE AGUA
  // ════════════════════════════════════════════════════════════════════════════
  L.cabecerasYPies({ logo, cabecera: d.cabecera ?? "", color: C, pieIzquierda: d.pie?.izquierda ?? "", pieDerecha: d.pie?.derecha ?? "", primera, omitir: (hoja) => hoja === 1 });
  if (opts.marcaAgua) L.marcaAgua(opts.marcaAgua);

  const bytes = await pdf.save();
  return { bytes, paginas: L.paginas.length, indice: entradas, recortes };
}

/** Un renglón del índice: «N. Título ........ 12», el número a la derecha y el título recortado si no cabe. */
function renglonIndice(L: Lienzo, e: EntradaIndice, C: RGB): void {
  const f = L.f;
  const [fuente, tam, x0, color] = e.nivel === 1 ? [f.neg, TAM_IND1, MARGEN_X, TINTA] : [f.reg, TAM_IND2, MARGEN_X + SANGRIA_IND2, TINTA];
  const base = lineaBase(L.y, LH_IND, tam);
  const num = limpiar(String(e.pagina), f.juego);
  const wNum = anchoTexto(fuente, num, tam);
  const xNum = MARGEN_X + ANCHO_UTIL - wNum;
  const etiqueta = limpiar(sinMarcas(e.nivel === 1 ? etiquetaSeccion(e.numero, e.titulo) : etiquetaSub(e.numero, e.titulo)), f.juego, 300);
  const titulo = recortarConElipsis(etiqueta, fuente, tam, Math.max(0, xNum - 18 - x0));
  L.texto(titulo, x0, base, fuente, tam, color);
  const xIni = x0 + anchoTexto(fuente, titulo, tam) + 4;
  const wPunto = anchoTexto(f.reg, ".", tam), wEsp = anchoTexto(f.reg, " ", tam);
  const n = Math.floor((xNum - 4 - xIni + wEsp) / (wPunto + wEsp));
  if (n > 0) {
    // Puntos guía espaciados, alineados a la derecha (contra el número).
    const guia = Array.from({ length: n }, () => ".").join(" ");
    const wGuia = anchoTexto(f.reg, guia, tam);
    L.texto(guia, xNum - 4 - wGuia, base, f.reg, tam, aclarar(C, 0.35));
  }
  L.texto(num, xNum, base, fuente, tam, color);
}

/** Portada generada: logo arriba, red decorativa clara, banda de color con el título, subtítulo y líneas. */
function portadaGenerada(L: Lienzo, p: DocumentoResuelto["portada"], logo: PDFImage | null, C: RGB, recortes: string[]): void {
  const f = L.f;
  const AN = A4.ancho, AL = A4.alto;
  const banda = AL * 0.42;
  const pie = 40;

  // Red decorativa (determinista) en la zona blanca.
  {
    const r = azar(0x51ca);
    const puntos = Array.from({ length: 16 }, () => ({ x: 20 + r() * (AN - 40), y: 18 + r() * (banda - 60) }));
    const tinte = aclarar(C, 0.84);
    for (let i = 0; i < puntos.length; i++) {
      for (let j = i + 1; j < puntos.length; j++) {
        const a = puntos[i], b = puntos[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 135) L.linea(a.x, a.y, b.x, b.y, tinte, 0.5);
      }
    }
    for (const q of puntos) L.pag.drawCircle({ x: q.x, y: AL - q.y, size: 1.8, color: aclarar(C, 0.7) });
  }

  // Logo arriba, centrado.
  if (logo) {
    const e = escalarImagen(logo, 230, 86);
    L.imagen(logo, (AN - e.ancho) / 2, 64 + (86 - e.alto) / 2, e.ancho, e.alto);
  }

  // Banda de color con borde superior curvo, una franja clara encima y una franja oscura al pie.
  L.pag.drawSvgPath(`M 0 ${banda + 30} Q ${AN * 0.42} ${banda - 34} ${AN} ${banda + 2} L ${AN} ${AL} L 0 ${AL} Z`, { x: 0, y: AL, color: C, borderWidth: 0 });
  L.pag.drawSvgPath(`M 0 ${banda + 18} Q ${AN * 0.42} ${banda - 46} ${AN} ${banda - 10} L ${AN} ${banda + 2} Q ${AN * 0.42} ${banda - 34} 0 ${banda + 30} Z`, { x: 0, y: AL, color: aclarar(C, 0.55), borderWidth: 0 });
  L.rect(0, AL - pie, AN, pie, { relleno: oscurecer(C, 0.32) });

  const x = MARGEN_X, ancho = ANCHO_UTIL;
  let y = banda + 72;

  // Título: grande, hasta 3 renglones (se achica antes de recortarse).
  if (limpiar(p.titulo, f.juego)) {
    let tam = 34;
    let rs: Renglon[] = [];
    for (; tam >= 18; tam -= 2) {
      rs = renglones(p.titulo, f, tam, ancho, { negrita: true });
      if (rs.length <= 3) break;
    }
    tam = Math.max(18, tam);
    const c = conTope(rs, 3, f, tam, ancho);
    if (c.recortado) recortes.push("Portada: el título no cabe en tres renglones y se recortó con «…».");
    const lh = tam * 1.15;
    for (const r of c.renglones) { L.pintarRenglon(r, x, lineaBase(y, lh, tam), tam, BLANCO, "centro", ancho); y += lh; }
    y += 12;
    L.rect(AN / 2 - 26, y, 52, 2.2, { relleno: BLANCO });
    y += 2.2 + 18;
  }

  // Subtítulo en un recuadro de borde claro.
  const sub = conTope(renglones(p.subtitulo, f, 10.5, ancho - 32, { negrita: true }), 4, f, 10.5, ancho - 32);
  if (sub.recortado) recortes.push("Portada: el subtítulo no cabe en cuatro renglones y se recortó con «…».");
  if (sub.renglones.length) {
    const lh = 15, alto = sub.renglones.length * lh + 18;
    L.pag.drawRectangle({ x: x + 6, y: AL - (y + alto), width: ancho - 12, height: alto, borderColor: aclarar(C, 0.5), borderWidth: 0.8, color: oscurecer(C, 0.08) });
    let yy = y + 9;
    for (const r of sub.renglones) { L.pintarRenglon(r, x + 16, lineaBase(yy, lh, 10.5), 10.5, BLANCO, "centro", ancho - 32); yy += lh; }
    y += alto + 20;
  }

  // Líneas: centradas; se achican si no caben antes de la franja del pie, y al final se recortan.
  const lineas = (p.lineas ?? []).filter((s) => limpiar(s, f.juego));
  if (lineas.length) {
    const limite = AL - pie - 14;
    let tam = 10, lh = 14, rs: Renglon[][] = [];
    for (; tam >= 7.5; tam -= 0.5) {
      lh = tam * 1.42;
      rs = lineas.map((s) => renglones(s, f, tam, ancho - 20));
      if (y + rs.reduce((a, r) => a + r.length, 0) * lh <= limite) break;
    }
    tam = Math.max(7.5, tam);
    let cortado = false;
    for (const grupo of rs) {
      for (const r of grupo) {
        if (y + lh > limite + 0.01) { cortado = true; break; }
        L.pintarRenglon(r, x + 10, lineaBase(y, lh, tam), tam, BLANCO, "centro", ancho - 20);
        y += lh;
      }
      if (cortado) break;
    }
    if (cortado) recortes.push("Portada: las líneas no caben en la hoja y las últimas se omitieron.");
  }
}
