// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/docx/importar.ts — Importa una propuesta técnica escrita en Word (.docx) a las
// secciones y bloques del editor de Licitaciones. PURO e isomórfico: recibe los bytes y devuelve el
// resultado; no sube nada (la pantalla sube las imágenes de `pendientes` y completa el ArchivoRef).
//
// Cómo decide, de la evidencia al juicio:
//  · El ESTILO se reconoce por su NOMBRE en styles.xml, no por su id: Word guarda w:name="heading 1"
//    aunque el id sea "Ttulo1" (Word en castellano), y "toc 1"/"List Paragraph" aunque el id sea
//    "TDC1"/"Prrafodelista". Se sigue w:basedOn; de respaldo, el w:outlineLvl del estilo y el id
//    (/^(heading|ttulo|titulo|título)(\d)$/i). Un estilo con outlineLvl 9 es texto, aunque herede de
//    un título (así se escribe «TOC Heading»).
//  · Título 1 abre una SECCIÓN; Título 2/3, un SUBTÍTULO. La numeración escrita a mano («3.1 …») se
//    quita: la pone el ERP. Un «título» de más de 120 caracteres es un párrafo con estilo de título
//    (el caso del 3.1 de la propuesta real) y entra como párrafo, AVISADO.
//  · Lo que hay ANTES del primer Título 1 son los preliminares: la imagen de portada (la primera de
//    6 pulgadas o más), la tabla «Control del documento», la tabla «Glosario», la carta (lo que hay
//    entre el glosario y el índice) y el índice, que se OMITE (el ERP arma el suyo con páginas reales).
//  · Nada se descarta en silencio: lo que no tiene equivalente (gráfico, cuadro de texto, imagen EMF,
//    celdas combinadas, un dato del control sin campo) se convierte en lo más cercano o se omite, y
//    queda un AVISO que lo nombra y dice dónde se arregla.
//
// No se interpreta el contenido: el texto entra tal cual (con **negrita** donde Word la tenía).
// ──────────────────────────────────────────────────────────────────────────────
import type {
  AvisoImportacion, Bloque, Carta, ControlDocumento, EntradaGlosario, ImagenImportada, ResultadoImportacion, Seccion,
} from "../tipos";
import { TOPES_DOC } from "../tipos";
import { ErrorXml, attr, canonizarPrefijos, hijo, hijosLlamados, parsearXml, type NodoXml } from "./xml";
import { ErrorZip, TOPES_ZIP, leerZip, parteZip } from "./zip-lectura";

/** Topes de la importación: NO medidos, declarados. El lado seguro es bajarlos. */
export const TOPES_IMPORTACION = {
  maxBytesArchivo: TOPES_ZIP.maxBytesEntrada,       // 25 MB, el mismo del zip
  maxCaracteresXml: 40_000_000,                     // una parte XML (document.xml) ya decodificada
  maxImagenes: 300,
  maxAvisos: 200,
  maxCaracteresTitulo: 120,                         // más largo = párrafo con estilo de título
  maxCaracteresPie: 200,                            // pie de imagen: corto y en cursiva
  anchoPortadaEmu: 5_486_400,                       // 6 pulgadas
  anchoTextoDefectoEmu: 5_760_720,                  // A4 con márgenes de 2.5 cm, si el documento no lo dice
} as const;

export const SECCION_SIN_TITULOS = "Contenido importado";
export type CodigoAvisoImportacion = AvisoImportacion["codigo"];

// ══ Espacios de nombres → prefijos canónicos ═════════════════════════════════
const NS: Readonly<Record<string, string>> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
  "http://purl.oclc.org/ooxml/drawingml/chart": "c",
  "http://schemas.microsoft.com/office/drawing/2014/chartex": "cx",
  "http://schemas.openxmlformats.org/drawingml/2006/diagram": "dgm",
  "urn:schemas-microsoft-com:vml": "v",
  "urn:schemas-microsoft-com:office:office": "o",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup": "wpg",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas": "wpc",
  "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
  "http://schemas.openxmlformats.org/package/2006/relationships": "",
  "http://schemas.openxmlformats.org/package/2006/content-types": "",
};

// ══ Errores que terminan la importación ══════════════════════════════════════
type CodigoFallo = Extract<ResultadoImportacion, { ok: false }>["codigo"];
class Fallo extends Error {
  codigo: CodigoFallo;
  constructor(codigo: CodigoFallo, detalle: string) { super(detalle); this.codigo = codigo; }
}

// ══ Texto: normalizar para comparar rótulos ══════════════════════════════════
/** minúsculas, sin tildes, espacios colapsados, sin «:» ni «.» al final. Solo para COMPARAR. */
export function normalizarRotulo(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\s+/g, " ").trim().replace(/[\s:.\-–—]+$/g, "").trim();
}
const colapsar = (t: string) => t.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();

/** Quita «3.1 », «1. », «10.4 » del inicio. Exige que quede texto y que el primer número tenga ≤ 2 cifras
 *  («2026 en cifras» no es una numeración). */
export function quitarNumeracion(t: string): { texto: string; quitada: boolean } {
  const m = /^(\d{1,2})((\.\d{1,3})*)\.?\s+(?=\S)/.exec(t);
  if (!m) return { texto: t, quitada: false };
  return { texto: t.slice(m[0].length), quitada: true };
}

// ══ Fechas ═══════════════════════════════════════════════════════════════════
const MESES = new Map<string, number>([
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4], ["mayo", 5], ["junio", 6], ["julio", 7], ["agosto", 8],
  ["septiembre", 9], ["setiembre", 9], ["octubre", 10], ["noviembre", 11], ["diciembre", 12],
]);
function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Primera fecha reconocible del texto, en ISO. Día/mes/año (Perú), año-mes-día, o «17 de octubre de 2026». */
export function fechaIsoDeTexto(t: string): string | null {
  const s = normalizarRotulo(t);
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = /(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de(?:l)?\s+)?(\d{4})/.exec(s);
  if (m && MESES.has(m[2])) return iso(+m[3], MESES.get(m[2])!, +m[1]);
  return null;
}

// ══ Relaciones y partes ══════════════════════════════════════════════════════
type Rel = { tipo: string; destino: string; externo: boolean };

function dirDe(parte: string): string { const k = parte.lastIndexOf("/"); return k < 0 ? "" : parte.slice(0, k + 1); }
function resolverRuta(base: string, destino: string): string {
  const t = destino.replace(/\\/g, "/");
  const partes = (t.startsWith("/") ? t.slice(1) : base + t).split("/");
  const out: string[] = [];
  for (const p of partes) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}
function decodificarNombreParte(ruta: string): string {
  try { return decodeURIComponent(ruta); } catch { return ruta; }
}

// ══ Texto de bytes ═══════════════════════════════════════════════════════════
function textoDeBytes(b: Uint8Array): string {
  try {
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  } catch { /* cae a UTF-8 */ }
  return new TextDecoder("utf-8").decode(b);
}

// ══ Estilos ══════════════════════════════════════════════════════════════════
type ClaseParrafo =
  | { clase: "titulo"; nivel: number }
  | { clase: "indice" }
  | { clase: "titulo_indice" }
  | { clase: "lista" }
  | { clase: "titulo_doc" }
  | { clase: "leyenda" }
  | { clase: "normal" };
type EstiloW = {
  id: string; tipo: string; nombre: string; basadoEn: string | null; outline: number | null;
  numId: string | null; ilvl: number | null; negrita: boolean | null; cursiva: boolean | null; oculto: boolean | null;
};

/** Propiedad «toggle» de Word: presente sin valor o con 1/true/on = sí; 0/false/off = no; ausente = null. */
function toggle(n: NodoXml | null): boolean | null {
  if (!n) return null;
  const v = attr(n, "w:val");
  if (v === null) return true;
  const s = v.toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "none");
}
function entero(v: string | null): number | null {
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

const RE_ID_TITULO = /^(heading|ttulo|titulo|título)([1-9])$/i;
const RE_ID_INDICE = /^(toc|tdc)([1-9])$/i;

class Estilos {
  porId = new Map<string, EstiloW>();
  defectoParrafo: string | null = null;

  constructor(raiz: NodoXml | null) {
    if (!raiz) return;
    for (const s of hijosLlamados(raiz, "w:style")) {
      const id = attr(s, "w:styleId");
      if (!id) continue;
      const tipo = attr(s, "w:type") ?? "paragraph";
      const ppr = hijo(s, "w:pPr"), rpr = hijo(s, "w:rPr"), num = hijo(ppr, "w:numPr");
      this.porId.set(id, {
        id, tipo,
        nombre: (attr(hijo(s, "w:name"), "w:val") ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
        basadoEn: attr(hijo(s, "w:basedOn"), "w:val"),
        outline: entero(attr(hijo(ppr, "w:outlineLvl"), "w:val")),
        numId: attr(hijo(num, "w:numId"), "w:val"),
        ilvl: entero(attr(hijo(num, "w:ilvl"), "w:val")),
        negrita: toggle(hijo(rpr, "w:b")), cursiva: toggle(hijo(rpr, "w:i")),
        oculto: toggle(hijo(rpr, "w:vanish")),
      });
      const def = (attr(s, "w:default") ?? "").toLowerCase();
      if (tipo === "paragraph" && (def === "1" || def === "true" || def === "on")) this.defectoParrafo = id;
    }
  }

  private cadena(id: string | null): EstiloW[] {
    const out: EstiloW[] = [];
    const vistos = new Set<string>();
    let act = id;
    while (act && !vistos.has(act) && out.length < 30) {
      vistos.add(act);
      const s = this.porId.get(act);
      if (!s) break;
      out.push(s);
      act = s.basadoEn;
    }
    return out;
  }

  /** Clase del estilo de párrafo, de la evidencia al juicio, nivel por nivel de la herencia. */
  clase(idEstilo: string | null): ClaseParrafo {
    const id = idEstilo ?? this.defectoParrafo;
    if (!id) return { clase: "normal" };
    const cadena = this.cadena(id);
    if (!cadena.length) {
      // El id no está en styles.xml (o no hay styles.xml): solo queda el respaldo por id.
      let m = RE_ID_TITULO.exec(id);
      if (m) return { clase: "titulo", nivel: +m[2] };
      m = RE_ID_INDICE.exec(id);
      if (m) return { clase: "indice" };
      return { clase: "normal" };
    }
    for (const s of cadena) {
      const nom = s.nombre;
      let m = /^heading ?([1-9])$/.exec(nom);
      if (m) return { clase: "titulo", nivel: +m[1] };
      m = /^toc ?([1-9])$/.exec(nom);
      if (m) return { clase: "indice" };
      if (nom === "toc heading") return { clase: "titulo_indice" };
      if (nom === "title") return { clase: "titulo_doc" };
      if (nom === "caption") return { clase: "leyenda" };
      if (nom === "list paragraph" || /^list (bullet|number)( [2-9])?$/.test(nom)) return { clase: "lista" };
      m = RE_ID_TITULO.exec(s.id);
      if (m) return { clase: "titulo", nivel: +m[2] };
      m = RE_ID_INDICE.exec(s.id);
      if (m) return { clase: "indice" };
      if (s.outline !== null) {
        if (s.outline >= 0 && s.outline <= 8) return { clase: "titulo", nivel: s.outline + 1 };
        return { clase: "normal" }; // 9 = cuerpo de texto, explícito
      }
    }
    return { clase: "normal" };
  }

  numPr(idEstilo: string | null): { numId: string | null; ilvl: number | null } {
    for (const s of this.cadena(idEstilo ?? this.defectoParrafo)) {
      if (s.numId !== null || s.ilvl !== null) return { numId: s.numId, ilvl: s.ilvl };
    }
    return { numId: null, ilvl: null };
  }
  private prop(idEstilo: string | null, k: "negrita" | "cursiva" | "oculto"): boolean | null {
    for (const s of this.cadena(idEstilo)) if (s[k] !== null) return s[k];
    return null;
  }
  negrita(id: string | null) { return this.prop(id, "negrita"); }
  cursiva(id: string | null) { return this.prop(id, "cursiva"); }
  oculto(id: string | null) { return this.prop(id, "oculto"); }
  numIdDeEstiloNumeracion(idEstilo: string): string | null {
    for (const s of this.cadena(idEstilo)) if (s.numId) return s.numId;
    return null;
  }
}

// ══ Numeración ═══════════════════════════════════════════════════════════════
type NivelNum = { fmt: string; inicio: number };
class Numeracion {
  private abstractos = new Map<string, { niveles: Map<number, NivelNum>; enlace: string | null }>();
  private nums = new Map<string, { abs: string; overrides: Map<number, { inicio?: number; fmt?: string }> }>();

  constructor(raiz: NodoXml | null, private estilos: Estilos) {
    if (!raiz) return;
    for (const a of hijosLlamados(raiz, "w:abstractNum")) {
      const id = attr(a, "w:abstractNumId");
      if (id === null) continue;
      const niveles = new Map<number, NivelNum>();
      for (const l of hijosLlamados(a, "w:lvl")) {
        const il = entero(attr(l, "w:ilvl"));
        if (il === null) continue;
        niveles.set(il, { fmt: attr(hijo(l, "w:numFmt"), "w:val") ?? "decimal", inicio: entero(attr(hijo(l, "w:start"), "w:val")) ?? 1 });
      }
      this.abstractos.set(id, { niveles, enlace: attr(hijo(a, "w:numStyleLink"), "w:val") });
    }
    for (const nu of hijosLlamados(raiz, "w:num")) {
      const id = attr(nu, "w:numId");
      const abs = attr(hijo(nu, "w:abstractNumId"), "w:val");
      if (id === null || abs === null) continue;
      const overrides = new Map<number, { inicio?: number; fmt?: string }>();
      for (const o of hijosLlamados(nu, "w:lvlOverride")) {
        const il = entero(attr(o, "w:ilvl"));
        if (il === null) continue;
        const so = entero(attr(hijo(o, "w:startOverride"), "w:val"));
        const lvl = hijo(o, "w:lvl");
        const fmt = attr(hijo(lvl, "w:numFmt"), "w:val") ?? undefined;
        const inicioLvl = entero(attr(hijo(lvl, "w:start"), "w:val"));
        overrides.set(il, { inicio: so ?? inicioLvl ?? undefined, fmt });
      }
      this.nums.set(id, { abs, overrides });
    }
  }

  nivel(numId: string, ilvl: number, salto = 0): NivelNum | null {
    const num = this.nums.get(numId);
    if (!num) return null;
    const a = this.abstractos.get(num.abs);
    let base: NivelNum | null = a?.niveles.get(ilvl) ?? null;
    if (!base && a?.enlace && salto < 2) {
      const otro = this.estilos.numIdDeEstiloNumeracion(a.enlace);
      if (otro && otro !== numId) base = this.nivel(otro, ilvl, salto + 1);
    }
    const ov = num.overrides.get(ilvl);
    if (!base && !ov?.fmt) return null;
    return { fmt: ov?.fmt ?? base!.fmt, inicio: ov?.inicio ?? base?.inicio ?? 1 };
  }
}

// ══ Lo que se lee de un párrafo ══════════════════════════════════════════════
/** `bp`: la negrita viene SOLO del estilo del párrafo (ninguna run ni estilo de carácter la dijo). */
type Seg = { t: string; b: boolean; i: boolean; bp?: boolean };
type RefImagen = { rid: string | null; externo: boolean; cx: number | null; cy: number | null };
type Pieza =
  | { k: "texto"; seg: Seg }
  | { k: "salto" }
  | { k: "img"; ref: RefImagen }
  | { k: "cuadro"; bloques: NodoXml[] }
  | { k: "grafico" }
  | { k: "nota_pie" };
type ListaInfo = { numId: string | null; ilvl: number; ordenada: boolean; fmt: string | null; inicio: number };
type ParrafoU = { k: "p"; clase: ClaseParrafo; lista: ListaInfo | null; segs: Seg[]; plano: string; enCuadro: boolean };
type CeldaU = { segs: Seg[]; plano: string; span: number; vmerge: "restart" | "continue" | null };
/** `conImagen`: alguna celda traía una imagen (que se pone debajo de la tabla). */
type FilaU = { celdas: CeldaU[]; encabezado: boolean; antes: number; despues: number; conImagen: boolean };
type TablaU = { filas: FilaU[]; grid: number[]; imagenes: RefImagen[]; cuadros: number; graficos: number };
type Unidad =
  | ParrafoU
  | { k: "img"; ref: RefImagen }
  | { k: "salto" }
  | { k: "tabla"; tabla: TablaU }
  | { k: "grafico" }
  | { k: "indice" }
  | { k: "cuadro_aviso" }
  | { k: "omitido"; que: string };

const planoDe = (segs: Seg[]) => colapsar(segs.map((s) => s.t).join(""));
const todoEn = (segs: Seg[], k: "b" | "i") => {
  let alguno = false;
  for (const s of segs) {
    if (!/\S/.test(s.t)) continue;
    alguno = true;
    if (!s[k]) return false;
  }
  return alguno;
};

/**
 * Texto con **negrita** a partir de los segmentos. La negrita se junta entre segmentos seguidos y
 * los espacios de los bordes quedan FUERA de las marcas. Con `max`, se corta por segmentos sin dejar
 * una marca abierta y se termina en «…».
 */
export function marcarNegrita(segs: { t: string; b: boolean }[], max?: number): { texto: string; recortado: boolean } {
  const juntos: { t: string; b: boolean }[] = [];
  for (const s of segs) {
    if (!s.t) continue;
    const ult = juntos[juntos.length - 1];
    // Un segmento solo de espacios no corta una negrita: se pega al anterior.
    if (ult && (ult.b === s.b || !/\S/.test(s.t))) ult.t += s.t;
    else juntos.push({ t: s.t, b: s.b && /\S/.test(s.t) });
  }
  let out = "";
  let recortado = false;
  const limite = max ?? Infinity;
  for (const s of juntos) {
    const t = s.t.replace(/[ \t ]+/g, " ");
    let pieza: string;
    if (!s.b) pieza = t;
    else {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
      pieza = m[2] ? `${m[1]}**${m[2]}**${m[3]}` : t;
    }
    if (out.length + pieza.length > limite) {
      recortado = true;
      const resto = limite - out.length - 1;
      if (resto > 0) {
        if (!s.b) out += t.slice(0, resto);
        else {
          const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
          const dentro = m[2].slice(0, Math.max(0, resto - m[1].length - 4));
          out += dentro ? `${m[1]}**${dentro}**` : m[1];
        }
      }
      out = out.trimEnd() + "…";
      break;
    }
    out += pieza;
  }
  return { texto: colapsar(out), recortado };
}

function recortarTexto(t: string, max: number): { texto: string; recortado: boolean } {
  if (t.length <= max) return { texto: t, recortado: false };
  return { texto: t.slice(0, Math.max(0, max - 1)).trimEnd() + "…", recortado: true };
}

// ══ El importador ════════════════════════════════════════════════════════════
const TITULOS_CONTROL = new Set(["control del documento", "control de documento", "control documental", "datos del documento", "informacion del documento", "ficha del documento"]);
const TITULOS_GLOSARIO = new Set(["glosario", "glosario de terminos", "terminos y definiciones", "definiciones", "abreviaturas", "siglas", "siglas y abreviaturas", "acronimos", "definiciones y abreviaturas"]);
const TITULOS_INDICE = new Set(["indice", "indice general", "contenido", "contenidos", "tabla de contenido", "tabla de contenidos", "table of contents", "index"]);
const ENCABEZADOS_GLOSARIO = new Set(["termino", "terminos", "sigla", "siglas", "concepto", "abreviatura", "abreviaturas", "acronimo", "acronimos"]);

type CampoControl = Exclude<keyof ControlDocumento, "activo">;
const ROTULOS_CONTROL = new Map<string, CampoControl>([
  ["documento", "documento"], ["titulo", "documento"], ["titulo del documento", "documento"], ["nombre del documento", "documento"],
  ["version", "version"], ["version del documento", "version"], ["revision", "version"], ["rev", "version"],
  ["codigo", "codigo"], ["codigo del documento", "codigo"], ["cod", "codigo"],
  ["elaborado por", "elaboradoPor"], ["elaborado", "elaboradoPor"], ["preparado por", "elaboradoPor"], ["preparado", "elaboradoPor"], ["autor", "elaboradoPor"],
  ["revisado por", "revisadoPor"], ["revisado", "revisadoPor"],
  ["aprobado por", "aprobadoPor"], ["aprobado", "aprobadoPor"],
  ["fecha", "fecha"], ["fecha de emision", "fecha"], ["fecha de elaboracion", "fecha"], ["fecha del documento", "fecha"], ["fecha de la version", "fecha"],
  ["confidencialidad", "confidencialidad"], ["clasificacion", "confidencialidad"], ["nivel de confidencialidad", "confidencialidad"],
]);
/** Filas del control que el ERP arma solo con los datos de la licitación y del perfil: no se importan. */
const ROTULOS_DERIVADOS = new Set(["cliente", "entidad", "postor", "empresa", "razon social", "ruc", "concurso", "proceso", "licitacion"]);
const ENCABEZADOS_CONTROL = new Set(["campo", "dato", "concepto", "item", "rubro", "atributo", "detalle"]);

const RE_LUGAR_FECHA = /^[A-Za-zÁÉÍÓÚÑáéíóúñü .'’-]{2,40},\s*((\d{1,2}\s+de\s+)?[A-Za-zÁÉÍÓÚáéíóú]+\s+(de|del)\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\.?$/;
const RE_SENORES = /^se[ñn]or(es|a|as|ita)?\b(?!\s*:)/i;
const RE_ATENCION = /^(atenci[oó]n|attn?\.?|at\.)\s*[:.\-–]?\s*/i;
const RE_REFERENCIA = /^(referencia|ref\.?|asunto)\s*[:.\-–]\s*/i;
const RE_PALABRAS_REFERENCIA = /\b(concurso|licitaci[oó]n|proceso|convocatoria|invitaci[oó]n|cotizaci[oó]n|adjudicaci[oó]n|contrataci[oó]n)\b|\b[A-Z]{2,}-[A-Z0-9-]*\d/i;
const RE_PRESENTE = /^presente\b/i;
const RE_SALUDO = /^(de (nuestra|mi) (mayor )?consideraci[oó]n|estimad[oa]s?\b|muy se[ñn]or|se[ñn]or(es|a|as)?\s*:)/i;
const RE_DESPEDIDA = /^(muy\s+)?(atentamente|cordialmente|saludos cordiales|saludos)\b/i;

class Importador {
  avisos: AvisoImportacion[] = [];
  private agregados = new Map<string, { codigo: CodigoAvisoImportacion; donde: string | null; n: number; texto: (n: number) => string }>();
  private avisoTopeDado = false;
  imagenesPorRuta = new Map<string, ImagenImportada>();
  imagenes: ImagenImportada[] = [];
  pendientes: Record<string, string> = {};
  private usosNumId = new Map<string, number>();
  private indiceAvisado = false;
  private numeracionQuitada = { n: 0, ejemplo: "" };
  donde: string | null = null;
  anchoTextoEmu: number = TOPES_IMPORTACION.anchoTextoDefectoEmu;

  constructor(
    private zip: Map<string, Uint8Array>,
    private parteDoc: string,
    private rels: Map<string, Rel>,
    private estilos: Estilos,
    private numeracion: Numeracion,
    private nuevoId: () => string,
  ) {}

  // ── Avisos ──
  aviso(codigo: CodigoAvisoImportacion, texto: string, donde: string | null = this.donde) {
    if (this.avisos.length >= TOPES_IMPORTACION.maxAvisos) {
      if (!this.avisoTopeDado) {
        this.avisoTopeDado = true;
        this.avisos.push({ codigo: "recortado", texto: `Hay más de ${TOPES_IMPORTACION.maxAvisos} avisos: se muestran los primeros. Revisa el contenido importado sección por sección.`, donde: null });
      }
      return;
    }
    this.avisos.push({ codigo, texto, donde });
  }
  /** Cuenta un aviso que se emite UNA vez por sección (o por documento) con el total. */
  agregar(codigo: CodigoAvisoImportacion, texto: (n: number) => string, donde: string | null = this.donde) {
    const k = `${codigo}|${donde ?? ""}`;
    const a = this.agregados.get(k);
    if (a) a.n++; else this.agregados.set(k, { codigo, donde, n: 1, texto });
  }
  volcarAgregados() {
    for (const a of this.agregados.values()) this.aviso(a.codigo, a.texto(a.n), a.donde);
    this.agregados.clear();
  }
  numeracionQuitadaEn(original: string) {
    this.numeracionQuitada.n++;
    if (!this.numeracionQuitada.ejemplo) this.numeracionQuitada.ejemplo = original.slice(0, 60);
  }
  cerrarAvisosGlobales() {
    const q = this.numeracionQuitada;
    if (q.n) {
      this.aviso("numeracion_quitada",
        `Se quitó la numeración escrita a mano en ${q.n} título(s) (por ejemplo «${q.ejemplo}»): el ERP numera las secciones y los subtítulos solo.`, null);
    }
  }
  indiceOmitido() {
    if (this.indiceAvisado) return;
    this.indiceAvisado = true;
    this.aviso("indice_omitido", "El índice del Word no se importó: el ERP arma el suyo con las páginas reales (se activa en Contenido → Índice).", null);
  }

  // ── Imágenes ──
  registrarImagen(ref: RefImagen): { img: ImagenImportada | null; motivo: string | null } {
    if (!ref.rid) return { img: null, motivo: "una imagen sin referencia al archivo" };
    if (ref.externo) return { img: null, motivo: "una imagen vinculada desde fuera del documento: no viaja dentro del .docx" };
    const rel = this.rels.get(ref.rid);
    if (!rel) return { img: null, motivo: "una imagen cuyo archivo no está declarado en el documento" };
    if (rel.externo) return { img: null, motivo: `una imagen vinculada desde fuera del documento (${rel.destino.slice(0, 80)}): no viaja dentro del .docx` };
    const ruta = resolverRuta(dirDe(this.parteDoc), decodificarNombreParte(rel.destino));
    const clave = ruta.toLowerCase();
    const ya = this.imagenesPorRuta.get(clave);
    if (ya) {
      if (ya.anchoEmu === null && ref.cx !== null) { ya.anchoEmu = ref.cx; ya.altoEmu = ref.cy; }
      return { img: ya, motivo: null };
    }
    const bytes = parteZip(this.zip, ruta);
    if (!bytes) return { img: null, motivo: `una imagen que no está dentro del archivo (${ruta.slice(0, 80)})` };
    if (bytes.length > TOPES_DOC.maxBytesArchivo) return { img: null, motivo: `la imagen ${ruta.split("/").pop()} pesa más de ${Math.round(TOPES_DOC.maxBytesArchivo / 1048576)} MB` };
    if (this.imagenes.length >= TOPES_IMPORTACION.maxImagenes) return { img: null, motivo: `más de ${TOPES_IMPORTACION.maxImagenes} imágenes: las siguientes no se importaron` };
    const img: ImagenImportada = {
      clave: `img-${this.imagenes.length + 1}`, ruta, mime: mimeDeImagen(bytes, ruta), bytes,
      anchoEmu: ref.cx, altoEmu: ref.cy,
    };
    this.imagenes.push(img);
    this.imagenesPorRuta.set(clave, img);
    return { img, motivo: null };
  }
  /** Bloque imagen pendiente de subir, o null con el aviso dado. */
  bloqueImagen(ref: RefImagen, pie: string | null): Bloque | null {
    const { img, motivo } = this.registrarImagen(ref);
    if (!img) { this.aviso("imagen_no_soportada", `No se importó ${motivo}.`); return null; }
    if (!esImagenSoportada(img.mime)) {
      this.aviso("imagen_no_soportada",
        `La imagen ${img.ruta.split("/").pop()} está en formato ${etiquetaMime(img.mime)}, que el PDF no puede dibujar: no se importó. Guárdala como PNG o JPG y agrégala en Contenido con un bloque de imagen.`);
      return null;
    }
    const id = this.nuevoId();
    this.pendientes[id] = img.clave;
    const ancho = ref.cx ?? img.anchoEmu;
    const pct = ancho ? Math.round((ancho / this.anchoTextoEmu) * 100) : 100;
    return { id, tipo: "imagen", archivo: null, pie, anchoPct: Math.min(100, Math.max(10, pct)) };
  }

  // ── Lectura de párrafos ──
  piezasDe(p: NodoXml): { piezas: Pieza[]; estilo: string | null; directo: { numId: string | null; ilvl: number | null }; saltoAntes: boolean; outline: number | null } {
    const ppr = hijo(p, "w:pPr");
    const estilo = attr(hijo(ppr, "w:pStyle"), "w:val");
    const num = hijo(ppr, "w:numPr");
    const directo = { numId: attr(hijo(num, "w:numId"), "w:val"), ilvl: entero(attr(hijo(num, "w:ilvl"), "w:val")) };
    const saltoAntes = toggle(hijo(ppr, "w:pageBreakBefore")) === true;
    const outline = entero(attr(hijo(ppr, "w:outlineLvl"), "w:val"));
    const bParrafo = this.estilos.negrita(estilo ?? this.estilos.defectoParrafo);
    const iParrafo = this.estilos.cursiva(estilo ?? this.estilos.defectoParrafo);
    const piezas: Pieza[] = [];
    const campos: ("codigo" | "resultado")[] = [];
    const enCodigo = () => campos.includes("codigo");

    const recorrerRun = (r: NodoXml, contenido?: (NodoXml | string)[]) => {
      const rpr = hijo(r, "w:rPr");
      const rStyle = attr(hijo(rpr, "w:rStyle"), "w:val");
      const oculto = toggle(hijo(rpr, "w:vanish")) ?? (rStyle ? this.estilos.oculto(rStyle) : null) ?? false;
      const bExplicita = toggle(hijo(rpr, "w:b")) ?? (rStyle ? this.estilos.negrita(rStyle) : null);
      const b = bExplicita ?? bParrafo ?? false;
      const bp = bExplicita === null && !!bParrafo;
      const i = toggle(hijo(rpr, "w:i")) ?? (rStyle ? this.estilos.cursiva(rStyle) : null) ?? iParrafo ?? false;
      const texto = (t: string) => { if (!oculto && !enCodigo()) piezas.push({ k: "texto", seg: { t, b, i, bp } }); };
      for (const h of contenido ?? r.hijos) {
        if (typeof h === "string") continue;
        switch (h.nombre) {
          case "w:t": texto(h.hijos.filter((x): x is string => typeof x === "string").join("")); break;
          case "w:tab": case "w:ptab": texto(" "); break;
          case "w:br": {
            const tipo = attr(h, "w:type");
            if (tipo === "page") { if (!oculto) piezas.push({ k: "salto" }); }
            else if (tipo !== "column") texto("\n");
            break;
          }
          case "w:cr": texto("\n"); break;
          case "w:noBreakHyphen": texto("-"); break;
          case "w:fldChar": {
            const t = attr(h, "w:fldCharType");
            if (t === "begin") campos.push("codigo");
            else if (t === "separate") { if (campos.length) campos[campos.length - 1] = "resultado"; }
            else if (t === "end") campos.pop();
            break;
          }
          case "w:drawing": if (!oculto) this.dibujo(h, piezas); break;
          case "w:pict": case "w:object": if (!oculto) this.vml(h, piezas); break;
          case "mc:AlternateContent": { const alt = alternativa(h); if (alt) recorrerRun(r, alt.hijos); break; }
          case "w:footnoteReference": case "w:endnoteReference": piezas.push({ k: "nota_pie" }); break;
          case "w:ruby": { const base = hijo(h, "w:rubyBase"); if (base) recorrerInline(base); break; }
          default: break; // instrText, delText, sym, softHyphen, lastRenderedPageBreak, rPr…
        }
      }
    };
    const recorrerInline = (n: NodoXml) => {
      for (const h of n.hijos) {
        if (typeof h === "string") continue;
        switch (h.nombre) {
          case "w:r": recorrerRun(h); break;
          case "w:hyperlink": case "w:ins": case "w:moveTo": case "w:smartTag": case "w:customXml":
          case "w:bdo": case "w:dir": case "w:fldSimple": case "w:sdtContent": case "w:rubyBase":
            recorrerInline(h); break;
          case "w:sdt": { const c = hijo(h, "w:sdtContent"); if (c) recorrerInline(c); break; }
          case "mc:AlternateContent": { const alt = alternativa(h); if (alt) recorrerInline(alt); break; }
          case "m:oMath": case "m:oMathPara": {
            const t = textoMath(h);
            if (t && !enCodigo()) piezas.push({ k: "texto", seg: { t, b: false, i: false } });
            break;
          }
          default: break; // pPr, del, moveFrom, bookmarks, proofErr, comentarios…
        }
      }
    };
    recorrerInline(p);
    return { piezas, estilo, directo, saltoAntes, outline };
  }

  /** w:drawing → imágenes, gráficos y cuadros de texto, en orden de documento. */
  private dibujo(d: NodoXml, piezas: Pieza[]) {
    for (const cont of d.hijos) {
      if (typeof cont === "string") continue;
      const ext = hijo(cont, "wp:extent");
      const cx = entero(attr(ext, "cx")), cy = entero(attr(ext, "cy"));
      const graf = buscarPrimero(cont, "a:graphicData");
      const uri = attr(graf, "uri") ?? "";
      if (/\/chart(ex)?$/i.test(uri) || /\/diagram$/i.test(uri)) { piezas.push({ k: "grafico" }); continue; }
      const blips: NodoXml[] = [];
      recorrerHasta(cont, (n) => {
        if (n.nombre === "w:txbxContent") { piezas.push({ k: "cuadro", bloques: n.hijos.filter((x): x is NodoXml => typeof x !== "string") }); return false; }
        if (n.nombre === "c:chart" || n.nombre === "cx:chart" || n.nombre === "dgm:relIds") { piezas.push({ k: "grafico" }); return false; }
        if (n.nombre === "a:blip") { blips.push(n); return false; }
        return true;
      });
      for (const bl of blips) {
        const embed = attr(bl, "r:embed"), link = attr(bl, "r:link");
        piezas.push({ k: "img", ref: { rid: embed ?? link, externo: !embed && !!link, cx: blips.length === 1 ? cx : null, cy: blips.length === 1 ? cy : null } });
      }
    }
  }
  /** w:pict / w:object (VML) → v:imagedata y v:textbox. El tamaño va en el `style` de la forma
   *  que contiene la imagen (v:shape, v:rect…). */
  private vml(n: NodoXml, piezas: Pieza[]) {
    const FORMAS = new Set(["v:shape", "v:rect", "v:roundrect", "v:oval", "v:image"]);
    const pila: { nodo: NodoXml; cx: number | null; cy: number | null }[] = [{ nodo: n, cx: null, cy: null }];
    while (pila.length) {
      const { nodo, cx: cx0, cy: cy0 } = pila.pop()!;
      let cx = cx0, cy = cy0;
      if (FORMAS.has(nodo.nombre)) ({ cx, cy } = tamanoVml(attr(nodo, "style") ?? ""));
      if (nodo.nombre === "w:txbxContent") { piezas.push({ k: "cuadro", bloques: nodosDe(nodo) }); continue; }
      if (nodo.nombre === "v:imagedata") {
        const rid = attr(nodo, "r:id") ?? attr(nodo, "o:relid") ?? attr(nodo, "r:pict");
        piezas.push({ k: "img", ref: { rid, externo: false, cx, cy } });
        continue;
      }
      for (let k = nodo.hijos.length - 1; k >= 0; k--) {
        const h = nodo.hijos[k];
        if (typeof h === "string") continue;
        if (h.nombre === "mc:AlternateContent") { const alt = alternativa(h); if (alt) pila.push({ nodo: alt, cx, cy }); continue; }
        pila.push({ nodo: h, cx, cy });
      }
    }
  }

  /** Lista del párrafo (numeración directa, o la del estilo), o null. */
  listaDe(estilo: string | null, directo: { numId: string | null; ilvl: number | null }, clase: ClaseParrafo): ListaInfo | null {
    const deEstilo = this.estilos.numPr(estilo);
    const numId = directo.numId ?? deEstilo.numId;
    const ilvl = directo.ilvl ?? deEstilo.ilvl ?? 0;
    if (numId !== null && numId !== "0") {
      const nivel = this.numeracion.nivel(numId, ilvl);
      if (nivel && nivel.fmt === "none") return null;
      const fmt = nivel?.fmt ?? null;
      return { numId, ilvl, ordenada: fmt !== null && fmt !== "bullet", fmt, inicio: nivel?.inicio ?? 1 };
    }
    if (numId === "0") return null;
    if (clase.clase === "lista") return { numId: null, ilvl: 0, ordenada: false, fmt: null, inicio: 1 };
    return null;
  }

  /** w:p → unidades (párrafo de texto, imágenes, saltos, cuadros de texto…). */
  unidadesDeParrafo(p: NodoXml, enCuadro: boolean, out: Unidad[]) {
    const { piezas, estilo, directo, saltoAntes, outline } = this.piezasDe(p);
    let clase = this.estilos.clase(estilo);
    if (outline !== null && clase.clase !== "indice" && clase.clase !== "titulo_indice") {
      clase = outline >= 0 && outline <= 8 ? { clase: "titulo", nivel: outline + 1 } : { clase: "normal" };
    }
    if (enCuadro && (clase.clase === "titulo" || clase.clase === "titulo_doc")) clase = { clase: "normal" };
    const lista = clase.clase === "titulo" ? null : this.listaDe(estilo, directo, clase);
    if (saltoAntes) out.push({ k: "salto" });

    const esTitulo = clase.clase === "titulo" || clase.clase === "indice" || clase.clase === "titulo_indice";
    if (esTitulo) {
      // Un título no se parte: su texto entero va en una unidad y lo demás después.
      const segs: Seg[] = [];
      const despues: Unidad[] = [];
      for (const pz of piezas) {
        if (pz.k === "texto") segs.push(pz.seg);
        else if (pz.k === "salto") (segs.length ? despues : out).push({ k: "salto" });
        else this.especial(pz, despues);
      }
      const plano = planoDe(segs);
      if (plano) out.push({ k: "p", clase, lista: null, segs, plano, enCuadro });
      else if (clase.clase === "indice") out.push({ k: "indice" });
      out.push(...despues);
      return;
    }
    let segs: Seg[] = [];
    const cerrar = () => {
      const plano = planoDe(segs);
      if (plano) out.push({ k: "p", clase, lista, segs, plano, enCuadro });
      segs = [];
    };
    for (const pz of piezas) {
      if (pz.k === "texto") { segs.push(pz.seg); continue; }
      cerrar();
      if (pz.k === "salto") out.push({ k: "salto" });
      else this.especial(pz, out);
    }
    cerrar();
  }
  private especial(pz: Pieza, out: Unidad[]) {
    if (pz.k === "img") out.push({ k: "img", ref: pz.ref });
    else if (pz.k === "grafico") out.push({ k: "grafico" });
    else if (pz.k === "nota_pie") out.push({ k: "omitido", que: "nota_pie" });
    else if (pz.k === "cuadro") {
      out.push({ k: "cuadro_aviso" });
      this.unidadesDeBloques(pz.bloques, true, out);
    }
  }

  /** Hijos de bloque (w:body, w:txbxContent, w:sdtContent…) → unidades, en orden. */
  unidadesDeBloques(hijos: NodoXml[], enCuadro: boolean, out: Unidad[]) {
    for (const h of hijos) {
      switch (h.nombre) {
        case "w:p": this.unidadesDeParrafo(h, enCuadro, out); break;
        case "w:tbl": out.push({ k: "tabla", tabla: this.tabla(h) }); break;
        case "w:sdt": {
          const c = hijo(h, "w:sdtContent");
          if (!c) break;
          const galeria = attr(hijo(hijo(hijo(h, "w:sdtPr"), "w:docPartObj"), "w:docPartGallery"), "w:val") ?? "";
          if (/table of contents/i.test(galeria)) { out.push({ k: "indice" }); break; }
          this.unidadesDeBloques(nodosDe(c), enCuadro, out);
          break;
        }
        case "w:customXml": case "w:ins": case "w:moveTo": this.unidadesDeBloques(nodosDe(h), enCuadro, out); break;
        case "mc:AlternateContent": { const alt = alternativa(h); if (alt) this.unidadesDeBloques(nodosDe(alt), enCuadro, out); break; }
        case "w:altChunk": out.push({ k: "omitido", que: "altchunk" }); break;
        default: break; // sectPr, bookmarks, del…
      }
    }
  }

  /** w:tbl → filas con celdas ya leídas (sin decidir aún encabezado ni topes). */
  tabla(t: NodoXml): TablaU {
    const grid = hijosLlamados(hijo(t, "w:tblGrid"), "w:gridCol").map((g) => entero(attr(g, "w:w")) ?? 0);
    const tabla: TablaU = { filas: [], grid, imagenes: [], cuadros: 0, graficos: 0 };
    const filas: NodoXml[] = [];
    const juntarFilas = (n: NodoXml) => {
      for (const h of n.hijos) {
        if (typeof h === "string") continue;
        if (h.nombre === "w:tr") filas.push(h);
        else if (h.nombre === "w:sdt") { const c = hijo(h, "w:sdtContent"); if (c) juntarFilas(c); }
        else if (h.nombre === "w:customXml" || h.nombre === "w:ins") juntarFilas(h);
      }
    };
    juntarFilas(t);
    for (const tr of filas) {
      const trPr = hijo(tr, "w:trPr");
      const fila: FilaU = {
        celdas: [], encabezado: toggle(hijo(trPr, "w:tblHeader")) === true,
        antes: entero(attr(hijo(trPr, "w:gridBefore"), "w:val")) ?? 0,
        despues: entero(attr(hijo(trPr, "w:gridAfter"), "w:val")) ?? 0,
        conImagen: false,
      };
      const celdas: NodoXml[] = [];
      const juntarCeldas = (n: NodoXml) => {
        for (const h of n.hijos) {
          if (typeof h === "string") continue;
          if (h.nombre === "w:tc") celdas.push(h);
          else if (h.nombre === "w:sdt") { const c = hijo(h, "w:sdtContent"); if (c) juntarCeldas(c); }
          else if (h.nombre === "w:customXml" || h.nombre === "w:ins") juntarCeldas(h);
        }
      };
      juntarCeldas(tr);
      for (const tc of celdas) {
        const tcPr = hijo(tc, "w:tcPr");
        const vm = hijo(tcPr, "w:vMerge");
        const imagenesAntes = tabla.imagenes.length;
        const segs = this.segsDeCelda(nodosDe(tc), tabla);
        if (tabla.imagenes.length > imagenesAntes) fila.conImagen = true;
        fila.celdas.push({
          segs, plano: planoDe(segs).replace(/\n/g, " "),
          span: Math.max(1, Math.min(64, entero(attr(hijo(tcPr, "w:gridSpan"), "w:val")) ?? 1)),
          vmerge: vm ? (attr(vm, "w:val") === "restart" ? "restart" : "continue") : null,
        });
      }
      tabla.filas.push(fila);
    }
    return tabla;
  }
  /** Texto de una celda: sus párrafos unidos con " "; tablas anidadas aplanadas; imágenes aparte. */
  private segsDeCelda(hijos: NodoXml[], tabla: TablaU): Seg[] {
    const segs: Seg[] = [];
    const unidades: Unidad[] = [];
    this.unidadesDeBloques(hijos, false, unidades);
    for (const u of unidades) {
      if (u.k === "p") {
        if (segs.length) segs.push({ t: " ", b: false, i: false });
        for (const s of u.segs) segs.push({ ...s, t: s.t.replace(/\n/g, " ") });
      } else if (u.k === "img") tabla.imagenes.push(u.ref);
      else if (u.k === "cuadro_aviso") tabla.cuadros++;
      else if (u.k === "grafico") tabla.graficos++;
      else if (u.k === "tabla") {
        tabla.imagenes.push(...u.tabla.imagenes);
        tabla.cuadros += u.tabla.cuadros; tabla.graficos += u.tabla.graficos;
        for (const f of u.tabla.filas) for (const c of f.celdas) {
          if (!c.plano) continue;
          if (segs.length) segs.push({ t: " ", b: false, i: false });
          segs.push(...c.segs.map((s) => ({ ...s, t: s.t.replace(/\n/g, " ") })));
        }
      }
    }
    return segs;
  }

  // ── Bloques ──
  /** Tabla leída → bloque tabla (encabezado, celdas combinadas aplanadas, topes). */
  bloqueTabla(t: TablaU): Bloque | null {
    // Una fila cuyo único contenido era una imagen queda vacía al moverla debajo: se quita.
    const filasU = t.filas.filter((f) => !(f.conImagen && f.celdas.every((c) => !c.plano)));
    if (!filasU.length) return null;
    let combinada = false;
    const expandida = filasU.map((f) => {
      const plano: string[] = [], marcado: string[] = [];
      const negrita: boolean[] = [];
      for (let k = 0; k < f.antes; k++) { plano.push(""); marcado.push(""); negrita.push(false); }
      for (const c of f.celdas) {
        const continua = c.vmerge === "continue";
        if (continua || c.span > 1) combinada = true;
        const texto = continua ? "" : c.plano;
        const marca = continua ? "" : marcarNegrita(c.segs.map((s) => ({ t: s.t, b: s.b }))).texto.replace(/\n/g, " ");
        plano.push(texto); marcado.push(marca); negrita.push(!continua && todoEn(c.segs, "b"));
        for (let k = 1; k < c.span; k++) { plano.push(""); marcado.push(""); negrita.push(false); }
      }
      for (let k = 0; k < f.despues; k++) { plano.push(""); marcado.push(""); negrita.push(false); }
      return { plano, marcado, negrita, encabezado: f.encabezado };
    });
    let ancho = expandida.reduce((m, f) => Math.max(m, f.plano.length), t.grid.length);
    if (ancho <= 0) return null;
    for (const f of expandida) while (f.plano.length < ancho) { f.plano.push(""); f.marcado.push(""); f.negrita.push(false); }

    const primera = expandida[0];
    const conTexto = primera.plano.filter((x) => x).length;
    const esEncabezado = primera.encabezado || (conTexto > 0 && primera.plano.every((x, k) => !x || primera.negrita[k]));
    let columnas = esEncabezado ? primera.plano.slice() : new Array<string>(ancho).fill("");
    let filas = (esEncabezado ? expandida.slice(1) : expandida).map((f) => f.marcado);

    let anchos: number[] | null = null;
    const grid = t.grid.length === ancho && t.grid.every((g) => g > 0) ? t.grid.slice() : null;
    if (ancho > TOPES_DOC.maxColumnas) {
      const max = TOPES_DOC.maxColumnas;
      const juntar = (fila: string[]) => [...fila.slice(0, max - 1), fila.slice(max - 1).filter((x) => x).join(" · ")];
      columnas = juntar(columnas);
      filas = filas.map(juntar);
      if (grid) grid.splice(max - 1, grid.length, grid.slice(max - 1).reduce((a, b) => a + b, 0));
      this.aviso("recortado", `Una tabla tenía ${ancho} columnas y el ERP admite ${max}: las ${ancho - max + 1} últimas quedaron juntas en la columna ${max}.`);
      ancho = max;
    }
    if (grid) {
      const total = grid.reduce((a, b) => a + b, 0);
      anchos = grid.map((g) => Math.max(1, Math.round((g / total) * 100)));
      const dif = 100 - anchos.reduce((a, b) => a + b, 0);
      anchos[anchos.length - 1] = Math.max(1, anchos[anchos.length - 1] + dif);
    }
    if (filas.length > TOPES_DOC.maxFilasTabla) {
      this.aviso("recortado", `Una tabla tenía ${filas.length} filas y el ERP admite ${TOPES_DOC.maxFilasTabla}: las ${filas.length - TOPES_DOC.maxFilasTabla} últimas no se importaron.`);
      filas = filas.slice(0, TOPES_DOC.maxFilasTabla);
    }
    let celdaLarga = 0;
    const cortar = (x: string) => { const r = recortarTexto(x, TOPES_DOC.maxTextoBloque); if (r.recortado) celdaLarga++; return r.texto; };
    columnas = columnas.map(cortar);
    filas = filas.map((f) => f.map(cortar));
    if (celdaLarga) this.aviso("recortado", `${celdaLarga} celda(s) de una tabla pasaban de ${TOPES_DOC.maxTextoBloque} caracteres y se cortaron.`);
    if (combinada) this.agregar("tabla_combinada", (n) => `${n} tabla(s) tenían celdas combinadas: se separaron y las celdas que estaban unidas quedaron vacías. Revisa que cada dato siga en su fila y columna.`);
    if (t.cuadros) this.agregar("cuadro_de_texto", (n) => `${n} cuadro(s) de texto dentro de una tabla: su texto se pasó a la celda.`);
    if (t.graficos) this.agregar("grafico_omitido", (n) => `${n} gráfico(s) o SmartArt dentro de una tabla no se importaron: agrégalos como imagen (captura en PNG) en Contenido.`);
    return { id: this.nuevoId(), tipo: "tabla", titulo: null, columnas, filas, anchos };
  }

  /** Unidades → bloques de una sección (o del resto de los preliminares). */
  bloques(unidades: Unidad[]): Bloque[] {
    const out: Bloque[] = [];
    let k = 0;
    while (k < unidades.length) {
      const u = unidades[k];
      if (u.k === "p") {
        const c = u.clase;
        if (c.clase === "indice" || c.clase === "titulo_indice") { this.indiceOmitido(); k++; continue; }
        if (c.clase === "titulo") {
          if (u.plano.length > TOPES_IMPORTACION.maxCaracteresTitulo || c.nivel === 1) {
            this.sospechoso(u, c.nivel, out);
            k++; continue;
          }
          const { texto, quitada } = quitarNumeracion(u.plano);
          if (quitada) this.numeracionQuitadaEn(u.plano);
          if (c.nivel >= 4) {
            const nv = c.nivel;
            this.agregar("estilo_desconocido", (n) => `${n} título(s) de nivel ${nv} se importaron como subtítulo de nivel 3 (el ERP tiene hasta el 3).`);
          }
          out.push({ id: this.nuevoId(), tipo: "subtitulo", texto, nivel: c.nivel === 2 ? 2 : 3, numerado: true });
          k++; continue;
        }
        if (u.lista) { k = this.lista(unidades, k, out); continue; }
        const r = marcarNegrita(u.segs, TOPES_DOC.maxTextoBloque);
        if (r.recortado) this.aviso("recortado", `Un párrafo pasaba de ${TOPES_DOC.maxTextoBloque} caracteres y se cortó («${u.plano.slice(0, 50)}…»).`);
        if (r.texto) out.push({ id: this.nuevoId(), tipo: "parrafo", texto: r.texto });
        k++; continue;
      }
      if (u.k === "img") {
        let pie: string | null = null;
        const sig = unidades[k + 1];
        if (sig && sig.k === "p" && !sig.lista && (sig.clase.clase === "normal" || sig.clase.clase === "leyenda")
          && sig.plano.length <= TOPES_IMPORTACION.maxCaracteresPie && (todoEn(sig.segs, "i") || sig.clase.clase === "leyenda")) {
          pie = sig.plano.replace(/\n/g, " ");
        }
        const b = this.bloqueImagen(u.ref, pie);
        if (b) { out.push(b); if (pie !== null) k++; }
        k++; continue;
      }
      if (u.k === "salto") { out.push({ id: this.nuevoId(), tipo: "salto_pagina" }); k++; continue; }
      if (u.k === "tabla") {
        const b = this.bloqueTabla(u.tabla);
        if (b) out.push(b);
        if (u.tabla.imagenes.length) {
          let puestas = 0;
          for (const ref of u.tabla.imagenes) { const bi = this.bloqueImagen(ref, null); if (bi) { out.push(bi); puestas++; } }
          if (puestas) this.agregar("imagen_en_tabla", (n) => `${n} imagen(es) estaban dentro de una tabla: se pusieron debajo de su tabla. Muévelas si hace falta.`);
        }
        k++; continue;
      }
      if (u.k === "grafico") {
        this.agregar("grafico_omitido", (n) => `${n} gráfico(s) o SmartArt no se importaron (el ERP no los dibuja): pégalos como imagen PNG en un bloque de imagen.`);
        k++; continue;
      }
      if (u.k === "cuadro_aviso") {
        this.agregar("cuadro_de_texto", (n) => `${n} cuadro(s) de texto: su texto entró como párrafos normales, en el lugar del cuadro. Revisa el orden.`);
        k++; continue;
      }
      if (u.k === "indice") { this.indiceOmitido(); k++; continue; }
      if (u.k === "omitido") {
        if (u.que === "nota_pie") this.agregar("dato_omitido", (n) => `${n} llamada(s) a nota al pie: el texto de las notas no se importó. Si hace falta, pásalo a un párrafo.`);
        else this.agregar("dato_omitido", (n) => `${n} fragmento(s) incrustado(s) de otro formato (altChunk) no se importaron.`);
        k++; continue;
      }
      k++;
    }
    return podarSaltos(out);
  }

  /** Un párrafo con estilo de título. Su negrita es la de las runs; la que hereda del estilo de título
   *  no es énfasis y se descarta. */
  private sospechoso(u: ParrafoU, nivel: number, out: Bloque[]) {
    const r = marcarNegrita(u.segs.map((s) => ({ t: s.t, b: s.b && !s.bp })), TOPES_DOC.maxTextoBloque);
    this.aviso("subtitulo_sospechoso",
      `Un párrafo de ${u.plano.length} caracteres tenía estilo «Título ${nivel}» («${u.plano.slice(0, 60)}…»): entró como párrafo. Si era un subtítulo, acórtalo y cámbialo en Contenido.`);
    if (r.texto) out.push({ id: this.nuevoId(), tipo: "parrafo", texto: r.texto });
  }

  /** Agrupa ítems de lista seguidos con la misma numeración en un bloque de viñetas. */
  private lista(unidades: Unidad[], desde: number, out: Bloque[]): number {
    const primero = unidades[desde] as ParrafoU;
    const numId = primero.lista!.numId;
    const items: ParrafoU[] = [];
    let k = desde;
    while (k < unidades.length) {
      const u = unidades[k];
      if (u.k !== "p" || !u.lista || u.lista.numId !== numId || u.clase.clase === "titulo") break;
      items.push(u);
      k++;
    }
    const minNivel = Math.min(...items.map((x) => x.lista!.ilvl));
    const ref = items.find((x) => x.lista!.ilvl === minNivel)!.lista!;
    const ordenada = ref.ordenada;
    const textos: string[] = [];
    let largos = 0;
    for (const it of items) {
      const r = marcarNegrita(it.segs, TOPES_DOC.maxTextoBloque);
      if (r.recortado) largos++;
      if (r.texto) textos.push(r.texto);
    }
    if (largos) this.aviso("recortado", `${largos} elemento(s) de una lista pasaban de ${TOPES_DOC.maxTextoBloque} caracteres y se cortaron.`);
    let items2 = textos;
    if (items2.length > TOPES_DOC.maxFilasTabla) {
      this.aviso("recortado", `Una lista tenía ${items2.length} elementos y el ERP admite ${TOPES_DOC.maxFilasTabla}: los últimos no se importaron.`);
      items2 = items2.slice(0, TOPES_DOC.maxFilasTabla);
    }
    const motivos: string[] = [];
    if (items.some((x) => x.lista!.ilvl > minNivel)) motivos.push("tenía subniveles y en el ERP queda en un solo nivel");
    if (ordenada) {
      if (ref.fmt && ref.fmt !== "decimal" && ref.fmt !== "decimalZero") motivos.push(`se numeraba con ${etiquetaFormato(ref.fmt)} y en el ERP se numera 1, 2, 3`);
      const previos = numId !== null ? this.usosNumId.get(numId) ?? 0 : 0;
      if (previos > 0) motivos.push("en Word seguía la numeración de una lista anterior y en el ERP empieza en 1");
      else if (ref.inicio !== 1) motivos.push(`en Word empezaba en ${ref.inicio} y en el ERP empieza en 1`);
    }
    if (numId !== null) this.usosNumId.set(numId, (this.usosNumId.get(numId) ?? 0) + items.length);
    if (motivos.length) this.aviso("lista_numerada", `Una lista ${ordenada ? "numerada" : "con viñetas"} («${items[0].plano.slice(0, 50)}») ${motivos.join("; ")}.`);
    if (items2.length) out.push({ id: this.nuevoId(), tipo: "vinetas", items: items2, ordenada });
    return k;
  }
}

/** Quita saltos de página repetidos y los que quedan al principio o al final. */
function podarSaltos(bloques: Bloque[]): Bloque[] {
  const out: Bloque[] = [];
  for (const b of bloques) {
    if (b.tipo === "salto_pagina" && (!out.length || out[out.length - 1].tipo === "salto_pagina")) continue;
    out.push(b);
  }
  while (out.length && out[out.length - 1].tipo === "salto_pagina") out.pop();
  return out;
}

function nodosDe(n: NodoXml): NodoXml[] { return n.hijos.filter((x): x is NodoXml => typeof x !== "string"); }

/** mc:AlternateContent → el primer mc:Choice (o mc:Fallback si no hay). Nunca los dos: duplicaría. */
function alternativa(n: NodoXml): NodoXml | null {
  return hijo(n, "mc:Choice") ?? hijo(n, "mc:Fallback");
}

/** Recorre en orden de documento; `visitar` devuelve false para no bajar a los hijos de ese nodo. Iterativo. */
function recorrerHasta(raiz: NodoXml, visitar: (n: NodoXml) => boolean) {
  const pila: NodoXml[] = [raiz];
  while (pila.length) {
    const n = pila.pop()!;
    if (!visitar(n)) continue;
    for (let k = n.hijos.length - 1; k >= 0; k--) {
      const h = n.hijos[k];
      if (typeof h === "string") continue;
      if (h.nombre === "mc:AlternateContent") { const alt = alternativa(h); if (alt) pila.push(alt); continue; }
      pila.push(h);
    }
  }
}
function buscarPrimero(raiz: NodoXml, nombre: string): NodoXml | null {
  let hallado: NodoXml | null = null;
  recorrerHasta(raiz, (n) => { if (hallado) return false; if (n.nombre === nombre) { hallado = n; return false; } return true; });
  return hallado;
}
function textoMath(n: NodoXml): string {
  let t = "";
  recorrerHasta(n, (x) => {
    if (x.nombre === "m:t" || x.nombre === "w:t") { t += x.hijos.filter((y): y is string => typeof y === "string").join(""); return false; }
    return true;
  });
  return t;
}
function tamanoVml(estilo: string): { cx: number | null; cy: number | null } {
  const medida = (clave: string): number | null => {
    const m = new RegExp(`(?:^|;)\\s*${clave}\\s*:\\s*([0-9.]+)\\s*(pt|in|cm|mm|px)?`, "i").exec(estilo);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const u = (m[2] ?? "px").toLowerCase();
    const emu = u === "pt" ? 12700 : u === "in" ? 914400 : u === "cm" ? 360000 : u === "mm" ? 36000 : 9525;
    return Number.isFinite(v) ? Math.round(v * emu) : null;
  };
  return { cx: medida("width"), cy: medida("height") };
}

/** Formato por los BYTES (la extensión puede mentir); la extensión solo para EMF/WMF. */
export function mimeDeImagen(b: Uint8Array, ruta: string): ImagenImportada["mime"] {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 44 && b[0] === 0x01 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[40] === 0x20 && b[41] === 0x45 && b[42] === 0x4d && b[43] === 0x46) return "image/x-emf";
  if (b.length >= 4 && ((b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) || ((b[0] === 1 || b[0] === 2) && b[1] === 0 && b[2] === 9 && b[3] === 0))) return "image/x-wmf";
  const ext = (ruta.split(".").pop() ?? "").toLowerCase();
  if (ext === "emf") return "image/x-emf";
  if (ext === "wmf") return "image/x-wmf";
  return "otro";
}
export function esImagenSoportada(m: ImagenImportada["mime"]): boolean {
  return m === "image/png" || m === "image/jpeg" || m === "image/gif";
}
function etiquetaMime(m: ImagenImportada["mime"]): string {
  return m === "image/x-emf" ? "EMF" : m === "image/x-wmf" ? "WMF" : "desconocido";
}
function etiquetaFormato(fmt: string): string {
  const f = fmt.toLowerCase();
  if (f.includes("letter")) return "letras";
  if (f.includes("roman")) return "números romanos";
  return `formato «${fmt}»`;
}

// ══ Preliminares ═════════════════════════════════════════════════════════════
type Preliminares = Extract<ResultadoImportacion, { ok: true }>["preliminares"];

function esTablaControl(t: TablaU): boolean {
  let n = 0;
  for (const f of t.filas) {
    const c = f.celdas[0];
    if (c && ROTULOS_CONTROL.has(normalizarRotulo(c.plano))) n++;
  }
  return n >= 3 && t.filas.some((f) => f.celdas.length >= 2);
}
function esTablaGlosario(t: TablaU): boolean {
  const f = t.filas[0];
  return !!f && f.celdas.length >= 2 && ENCABEZADOS_GLOSARIO.has(normalizarRotulo(f.celdas[0].plano));
}
const valorDeFila = (f: FilaU) => colapsar(f.celdas.slice(1).filter((c) => c.vmerge !== "continue").map((c) => c.plano).filter((x) => x).join(" "));

function controlDeTabla(t: TablaU, imp: Importador): Partial<ControlDocumento> {
  const out: Partial<ControlDocumento> = { activo: true };
  t.filas.forEach((f, k) => {
    const rot = f.celdas[0] ? normalizarRotulo(f.celdas[0].plano) : "";
    const valor = valorDeFila(f);
    const campo = ROTULOS_CONTROL.get(rot);
    if (!campo) {
      if (!rot && !valor) return;
      if (k === 0 && (f.encabezado || ENCABEZADOS_CONTROL.has(rot))) return;
      if (ROTULOS_DERIVADOS.has(rot)) return;
      imp.aviso("dato_omitido", `El control del documento traía «${f.celdas[0]?.plano.slice(0, 40) ?? ""}: ${valor.slice(0, 60)}», que no tiene campo en el ERP: no se importó.`);
      return;
    }
    if (!valor) return;
    if (campo === "fecha") {
      const f2 = fechaIsoDeTexto(valor);
      if (f2) out.fecha = f2;
      else imp.aviso("dato_omitido", `La fecha del control del documento («${valor.slice(0, 40)}») no se reconoció: escríbela en Contenido → Control del documento.`);
      return;
    }
    out[campo] = recortarTexto(valor, 300).texto;
  });
  return out;
}
function glosarioDeTabla(t: TablaU, nuevoId: () => string): EntradaGlosario[] {
  const out: EntradaGlosario[] = [];
  t.filas.forEach((f, k) => {
    const termino = colapsar(f.celdas[0]?.plano ?? "");
    const definicion = valorDeFila(f);
    if (k === 0 && (f.encabezado || ENCABEZADOS_GLOSARIO.has(normalizarRotulo(termino)))) return;
    if (!termino && !definicion) return;
    if (out.length >= TOPES_DOC.maxFilasTabla) return;
    out.push({ id: nuevoId(), termino: recortarTexto(termino, 200).texto, definicion: recortarTexto(definicion, TOPES_DOC.maxTextoBloque).texto });
  });
  return out;
}

function esMarcaCarta(p: ParrafoU): boolean {
  const t = p.plano;
  return RE_LUGAR_FECHA.test(t) || RE_SENORES.test(t) || RE_ATENCION.test(t) || RE_SALUDO.test(t) || RE_PRESENTE.test(t)
    || (RE_DESPEDIDA.test(t) && t.length <= 60);
}

/** Lee la carta de la zona. Devuelve la carta y los índices (en `zona`) que consumió. */
function cartaDeZona(zona: { u: Unidad; i: number }[], imp: Importador): { carta: Partial<Carta>; usados: Set<number> } | null {
  const ps = zona.filter((z) => z.u.k === "p" && !(z.u as ParrafoU).enCuadro);
  if (ps.filter((z) => esMarcaCarta(z.u as ParrafoU)).length < 2) return null;
  const usados = new Set<number>();
  const carta: Partial<Carta> = { activa: true };
  const dest: string[] = [], referencia: string[] = [], cuerpo: string[] = [];
  let fase: "dest" | "ref" | "cuerpo" | "firma" = "dest";
  let idxDespedida = -1;
  let k = 0;
  if (ps.length && RE_LUGAR_FECHA.test((ps[0].u as ParrafoU).plano)) {
    carta.lugarFecha = (ps[0].u as ParrafoU).plano; usados.add(ps[0].i); k = 1;
  }
  for (; k < ps.length; k++) {
    const p = ps[k].u as ParrafoU;
    const t = p.plano.replace(/\n/g, " ");
    if (fase === "firma") break;
    const esDespedida = RE_DESPEDIDA.test(t) && t.length <= 60;
    if (esDespedida) { carta.despedida = t; idxDespedida = ps[k].i; usados.add(ps[k].i); fase = "firma"; continue; }
    if (fase === "dest" || fase === "ref") {
      if (RE_ATENCION.test(t) && t.length <= 200) { carta.atencion = t.replace(RE_ATENCION, ""); usados.add(ps[k].i); fase = "ref"; continue; }
      if (RE_REFERENCIA.test(t)) { referencia.push(t.replace(RE_REFERENCIA, "")); usados.add(ps[k].i); fase = "ref"; continue; }
      if (RE_PRESENTE.test(t) || RE_SALUDO.test(t) || t.length > 160) { fase = "cuerpo"; }
      else if (fase === "ref" || (dest.length > 0 && RE_PALABRAS_REFERENCIA.test(t))) { referencia.push(t); usados.add(ps[k].i); fase = "ref"; continue; }
      else { dest.push(t); usados.add(ps[k].i); continue; }
    }
    cuerpo.push(marcarNegrita(p.segs).texto);
    usados.add(ps[k].i);
  }
  if (dest.length) carta.destinatario = dest.join("\n");
  if (referencia.length) carta.referencia = referencia.join(" ");
  if (cuerpo.length) {
    const r = recortarTexto(cuerpo.join("\n\n"), TOPES_DOC.maxTextoBloque);
    if (r.recortado) imp.aviso("recortado", `El cuerpo de la carta pasaba de ${TOPES_DOC.maxTextoBloque} caracteres y se cortó.`);
    carta.cuerpo = r.texto;
  }
  // La firma: una imagen pegada a la despedida (justo antes o después) o posterior a ella.
  if (idxDespedida >= 0) {
    for (const z of zona) {
      if (z.u.k === "img" && z.i >= idxDespedida - 1) { usados.add(z.i); carta.conFirma = true; imp.registrarImagen(z.u.ref); }
    }
  }
  return { carta, usados };
}

function preliminaresDe(pre: Unidad[], imp: Importador, nuevoId: () => string): Preliminares {
  const usados = new Set<number>();
  const resultado: Preliminares = { control: null, glosario: null, carta: null, portadaImagen: null, resto: [] };
  const sig = (k: number) => k + 1 < pre.length ? k + 1 : -1;

  // Índice
  let inicioIndice = -1;
  pre.forEach((u, k) => {
    const esIndice = u.k === "indice" || (u.k === "p" && (u.clase.clase === "indice" || u.clase.clase === "titulo_indice"));
    if (!esIndice) return;
    usados.add(k);
    if (inicioIndice < 0) inicioIndice = k;
    imp.indiceOmitido();
  });
  pre.forEach((u, k) => {
    if (u.k === "p" && !usados.has(k) && TITULOS_INDICE.has(normalizarRotulo(u.plano))) {
      const s = sig(k);
      if (s >= 0 && usados.has(s) && (pre[s].k === "indice" || pre[s].k === "p")) { usados.add(k); if (k < inicioIndice || inicioIndice < 0) inicioIndice = k; }
    }
  });

  // Portada: la primera imagen de 6 pulgadas o más que el PDF pueda dibujar.
  let finPortada = -1;
  for (let k = 0; k < pre.length; k++) {
    const u = pre[k];
    if (u.k !== "img" || (u.ref.cx ?? 0) < TOPES_IMPORTACION.anchoPortadaEmu) continue;
    const { img, motivo } = imp.registrarImagen(u.ref);
    usados.add(k);
    if (img && esImagenSoportada(img.mime)) { resultado.portadaImagen = img.clave; finPortada = k; }
    else imp.aviso("imagen_no_soportada", img
      ? `La imagen de portada está en formato ${etiquetaMime(img.mime)}: no se importó. Súbela como PNG o JPG en Contenido → Portada.`
      : `No se importó la imagen de portada: ${motivo}.`);
    break;
  }

  // Control del documento y glosario: por su rótulo y la tabla que le sigue; de respaldo, por la tabla sola.
  let finControl = -1, finGlosario = -1;
  const tomarTabla = (titulos: Set<string>, parece: (t: TablaU) => boolean): number => {
    for (let k = 0; k < pre.length; k++) {
      const u = pre[k];
      if (usados.has(k) || u.k !== "p" || !titulos.has(normalizarRotulo(u.plano))) continue;
      const s = sig(k);
      if (s >= 0 && pre[s].k === "tabla" && !usados.has(s)) { usados.add(k); usados.add(s); return s; }
    }
    for (let k = 0; k < pre.length; k++) {
      const u = pre[k];
      if (!usados.has(k) && u.k === "tabla" && parece(u.tabla)) { usados.add(k); return k; }
    }
    return -1;
  };
  finControl = tomarTabla(TITULOS_CONTROL, esTablaControl);
  if (finControl >= 0) resultado.control = controlDeTabla((pre[finControl] as { tabla: TablaU }).tabla, imp);
  finGlosario = tomarTabla(TITULOS_GLOSARIO, esTablaGlosario);
  if (finGlosario >= 0) {
    const g = glosarioDeTabla((pre[finGlosario] as { tabla: TablaU }).tabla, nuevoId);
    resultado.glosario = g;
  }

  // Carta: entre el control/glosario (o la portada) y el índice.
  const inicio = Math.max(finControl, finGlosario, finPortada) + 1;
  const fin = inicioIndice > inicio ? inicioIndice : pre.length;
  const zona: { u: Unidad; i: number }[] = [];
  for (let k = inicio; k < fin; k++) if (!usados.has(k)) zona.push({ u: pre[k], i: k });
  const carta = cartaDeZona(zona, imp);
  if (carta) {
    resultado.carta = carta.carta;
    for (const k of carta.usados) usados.add(k);
  }

  // En los preliminares un salto de página no dice nada: el ERP maqueta portada, control, carta e índice solo.
  const resto = pre.filter((u, k) => !usados.has(k) && u.k !== "salto");
  resultado.resto = imp.bloques(resto);
  return resultado;
}

// ══ Entrada ══════════════════════════════════════════════════════════════════
function parteXml(zip: Map<string, Uint8Array>, ruta: string, obligatoria: boolean): NodoXml | null {
  const b = parteZip(zip, ruta);
  if (!b) {
    if (obligatoria) throw new Fallo("sin_documento", `El archivo no trae «${ruta}»: no es un documento de Word.`);
    return null;
  }
  const texto = textoDeBytes(b);
  if (texto.length > TOPES_IMPORTACION.maxCaracteresXml) {
    throw new Fallo("demasiado_grande", `La parte «${ruta}» es demasiado grande para importarla.`);
  }
  try {
    return canonizarPrefijos(parsearXml(texto), NS);
  } catch (e) {
    if (e instanceof ErrorXml) {
      const porque = e.codigo === "dtd_prohibido"
        ? "trae una declaración DOCTYPE o ENTITY, que el ERP no acepta por seguridad"
        : e.codigo === "anidamiento" ? "anida demasiados niveles" : `está dañada (${e.message})`;
      throw new Fallo("xml_ilegible", `La parte «${ruta}» del documento ${porque}. Ábrelo en Word y vuelve a guardarlo como .docx.`);
    }
    throw e;
  }
}
function relsDe(zip: Map<string, Uint8Array>, parte: string): Map<string, Rel> {
  const ruta = `${dirDe(parte)}_rels/${parte.slice(dirDe(parte).length)}.rels`;
  const raiz = parteXml(zip, ruta, false);
  const out = new Map<string, Rel>();
  if (!raiz) return out;
  for (const r of hijosLlamados(raiz, "Relationship")) {
    const id = attr(r, "Id"), destino = attr(r, "Target");
    if (!id || destino === null) continue;
    out.set(id, { tipo: attr(r, "Type") ?? "", destino, externo: (attr(r, "TargetMode") ?? "").toLowerCase() === "external" });
  }
  return out;
}
function relDeTipo(rels: Map<string, Rel>, sufijo: string): Rel | null {
  for (const r of rels.values()) if (r.tipo.endsWith(sufijo) && !r.externo) return r;
  return null;
}

/**
 * Importa un .docx. Nunca lanza: lo que impide importar vuelve como { ok: false, codigo, detalle }.
 * `imagenes` trae TODAS las imágenes encontradas (soportadas o no); la pantalla sube solo las que nombran
 * `pendientes` (bloqueId → clave) y `preliminares.portadaImagen`.
 */
export function importarDocx(bytes: Uint8Array, opts: { nuevoId: () => string }): ResultadoImportacion {
  try {
    return importarOLanzar(bytes, opts.nuevoId);
  } catch (e) {
    if (e instanceof Fallo) return { ok: false, codigo: e.codigo, detalle: e.message };
    if (e instanceof ErrorZip) {
      const grande = e.codigo === "demasiado_grande" || e.codigo === "demasiadas_entradas" || e.codigo === "bomba_zip";
      const detalle = e.codigo === "ole"
        ? "Es un documento de Word antiguo (.doc) o un .docx protegido con contraseña. Ábrelo en Word, quítale la contraseña si la tiene y guárdalo como «Documento de Word (.docx)»."
        : e.codigo === "zip_cifrado" ? "El documento está protegido con contraseña: quítasela en Word y vuelve a guardarlo."
        : grande ? `${e.message} Reduce las imágenes (Archivo → Comprimir imágenes) o divide el documento.`
        : `${e.message} Ábrelo en Word y guárdalo como «Documento de Word (.docx)».`;
      return { ok: false, codigo: grande ? "demasiado_grande" : "archivo_no_docx", detalle };
    }
    if (e instanceof RangeError) {
      return { ok: false, codigo: "demasiado_grande", detalle: "El documento es demasiado grande para leerlo en el navegador." };
    }
    return { ok: false, codigo: "xml_ilegible", detalle: "El documento no se pudo leer. Ábrelo en Word y vuelve a guardarlo como .docx." };
  }
}

function importarOLanzar(bytes: Uint8Array, nuevoId: () => string): ResultadoImportacion {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Fallo("archivo_no_docx", "No llegó ningún archivo.");
  if (bytes.length > TOPES_IMPORTACION.maxBytesArchivo) {
    throw new Fallo("demasiado_grande", `El archivo pesa ${(bytes.length / 1048576).toFixed(1)} MB; el máximo es ${Math.round(TOPES_IMPORTACION.maxBytesArchivo / 1048576)} MB. Reduce las imágenes (Archivo → Comprimir imágenes).`);
  }
  const zip = leerZip(bytes);

  // La parte principal la dice _rels/.rels; de respaldo, word/document.xml.
  const relsPaquete = relsDe(zip, "");
  const principal = relDeTipo(relsPaquete, "/officeDocument");
  const parteDoc = principal ? resolverRuta("", decodificarNombreParte(principal.destino)) : "word/document.xml";
  if (!parteZip(zip, parteDoc)) {
    const cual = parteZip(zip, "xl/workbook.xml") ? "una hoja de Excel" : parteZip(zip, "ppt/presentation.xml") ? "una presentación de PowerPoint" : "un zip que no es un documento de Word";
    throw new Fallo("sin_documento", `El archivo es ${cual}: no trae el cuerpo de un documento de Word.`);
  }
  const rels = relsDe(zip, parteDoc);
  const relEstilos = relDeTipo(rels, "/styles");
  const relNum = relDeTipo(rels, "/numbering");
  const base = dirDe(parteDoc);
  const estilos = new Estilos(parteXml(zip, relEstilos ? resolverRuta(base, relEstilos.destino) : `${base}styles.xml`, false));
  const numeracion = new Numeracion(parteXml(zip, relNum ? resolverRuta(base, relNum.destino) : `${base}numbering.xml`, false), estilos);
  const doc = parteXml(zip, parteDoc, true)!;
  const body = hijo(doc, "w:body");
  if (doc.nombre !== "w:document" || !body) throw new Fallo("sin_documento", "El archivo no tiene el cuerpo de un documento de Word.");

  const imp = new Importador(zip, parteDoc, rels, estilos, numeracion, nuevoId);
  const sect = hijo(body, "w:sectPr");
  if (sect) {
    const w = entero(attr(hijo(sect, "w:pgSz"), "w:w"));
    const mar = hijo(sect, "w:pgMar");
    const l = entero(attr(mar, "w:left")) ?? 0, r = entero(attr(mar, "w:right")) ?? 0;
    if (w && w - l - r > 1000) imp.anchoTextoEmu = (w - l - r) * 635;
  }

  const unidades: Unidad[] = [];
  imp.unidadesDeBloques(nodosDe(body), false, unidades);

  const esH1 = (u: Unidad): u is ParrafoU =>
    u.k === "p" && !u.enCuadro && u.clase.clase === "titulo" && u.clase.nivel === 1 && u.plano.length <= TOPES_IMPORTACION.maxCaracteresTitulo;
  const cortes: number[] = [];
  unidades.forEach((u, k) => { if (esH1(u)) cortes.push(k); });

  const secciones: Seccion[] = [];
  let preliminares: Preliminares = { control: null, glosario: null, carta: null, portadaImagen: null, resto: [] };
  if (!cortes.length) {
    imp.donde = SECCION_SIN_TITULOS;
    imp.aviso("sin_titulos", "El documento no usa el estilo «Título 1»: todo entró en una sola sección. Para separarlo en secciones, aplica «Título 1» a cada título en Word y vuelve a importar, o divídelo en Contenido.", null);
    const bloques = recortarBloques(imp.bloques(unidades), imp);
    imp.volcarAgregados();
    secciones.push({ id: nuevoId(), titulo: SECCION_SIN_TITULOS, activa: true, numerada: true, bloques });
  } else {
    imp.donde = "Antes del primer título";
    preliminares = preliminaresDe(unidades.slice(0, cortes[0]), imp, nuevoId);
    imp.volcarAgregados();
    const total = cortes.length;
    if (total > TOPES_DOC.maxSecciones) {
      const primero = quitarNumeracion((unidades[cortes[TOPES_DOC.maxSecciones]] as ParrafoU).plano).texto;
      imp.aviso("recortado", `El documento tiene ${total} títulos de nivel 1 y el ERP admite ${TOPES_DOC.maxSecciones} secciones: desde «${primero.slice(0, 60)}» no se importó.`, null);
    }
    for (let s = 0; s < Math.min(total, TOPES_DOC.maxSecciones); s++) {
      const h = unidades[cortes[s]] as ParrafoU;
      const { texto, quitada } = quitarNumeracion(h.plano.replace(/\n/g, " "));
      if (quitada) imp.numeracionQuitadaEn(h.plano);
      const titulo = texto;
      imp.donde = `Sección ${s + 1} «${titulo.slice(0, 60)}»`;
      const fin = s + 1 < total ? cortes[s + 1] : unidades.length;
      const bloques = recortarBloques(imp.bloques(unidades.slice(cortes[s] + 1, fin)), imp);
      imp.volcarAgregados();
      secciones.push({ id: nuevoId(), titulo, activa: true, numerada: true, bloques });
    }
  }
  imp.donde = null;
  imp.cerrarAvisosGlobales();
  return { ok: true, secciones, preliminares, imagenes: imp.imagenes, pendientes: imp.pendientes, avisos: imp.avisos };
}

function recortarBloques(bloques: Bloque[], imp: Importador): Bloque[] {
  const max = TOPES_DOC.maxBloquesSeccion;
  if (bloques.length <= max) return bloques;
  imp.aviso("recortado", `La sección tenía ${bloques.length} bloques y el ERP admite ${max}: los ${bloques.length - max} últimos no se importaron. Divídela en dos secciones en Word y vuelve a importar.`);
  const quedan = bloques.slice(0, max);
  const ids = new Set(quedan.map((b) => b.id));
  for (const b of bloques) if (!ids.has(b.id) && b.tipo === "imagen") delete imp.pendientes[b.id];
  return quedan;
}
