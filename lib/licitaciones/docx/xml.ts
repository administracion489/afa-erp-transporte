// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/docx/xml.ts — Lector XML MÍNIMO y propio para las partes de un .docx. PURO e
// isomórfico (navegador, servidor y matrices): no usa DOMParser, que no existe en Node y que en el
// navegador resuelve una DTD si el archivo la trae.
//
// Lo que entiende, y nada más:
//  · elementos y atributos (comillas simples o dobles, `>` dentro de un valor no corta la etiqueta);
//  · las 5 entidades predefinidas (&lt; &gt; &amp; &quot; &apos;) y las numéricas (&#..; &#x..;).
//    Cualquier otro `&nombre;` se deja LITERAL: sin DTD no hay de dónde expandirlo, y no expandir
//    es lo seguro;
//  · comentarios e instrucciones de proceso se ignoran; CDATA es texto.
//
// Lo que RECHAZA (lanza ErrorXml): una declaración `<!DOCTYPE` o `<!ENTITY` (es la puerta de la
// bomba de entidades y de la XXE: un .docx legítimo nunca la trae), etiquetas mal cerradas, más de
// una raíz, y un anidamiento mayor que `maxProfundidad` (para que quien recorra el árbol con
// recursión no reviente la pila con un archivo armado a propósito).
//
// Es ITERATIVO: un document.xml de varios MB se lee con una pila explícita, sin recursión.
// ──────────────────────────────────────────────────────────────────────────────

/** Un elemento. `nombre` lleva el prefijo tal como viene ("w:p"); `atributos` NO tiene prototipo
 *  (un atributo llamado "__proto__" es una clave más). */
export type NodoXml = { nombre: string; atributos: Record<string, string>; hijos: (NodoXml | string)[] };

export type CodigoErrorXml = "dtd_prohibido" | "mal_formado" | "anidamiento";
export class ErrorXml extends Error {
  codigo: CodigoErrorXml;
  constructor(codigo: CodigoErrorXml, detalle: string) {
    super(detalle);
    this.name = "ErrorXml";
    this.codigo = codigo;
  }
}

/** Profundidad por defecto: un .docx real no pasa de ~40 niveles (tablas anidadas incluidas). */
export const MAX_PROFUNDIDAD_XML = 256;

const RE_ENTIDAD = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g;
const PREDEF: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** Decodifica SOLO las entidades predefinidas y las numéricas; el resto queda literal. */
export function decodificarEntidades(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(RE_ENTIDAD, (_m, e: string) => {
    if (e.charCodeAt(0) === 35 /* # */) {
      const cp = e.charCodeAt(1) === 120 /* x */ ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      const valido = Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valido ? String.fromCodePoint(cp) : "�";
    }
    return PREDEF[e];
  });
}

function esEspacio(c: number): boolean { return c === 32 || c === 9 || c === 10 || c === 13; }

function nuevoNodo(nombre: string): NodoXml {
  return { nombre, atributos: Object.create(null) as Record<string, string>, hijos: [] };
}

/**
 * Lee un XML y devuelve su elemento raíz. Lanza ErrorXml si el texto trae DTD, está mal formado o
 * anida más de `maxProfundidad` niveles.
 */
export function parsearXml(texto: string, opts?: { maxProfundidad?: number }): NodoXml {
  const maxProf = opts?.maxProfundidad ?? MAX_PROFUNDIDAD_XML;
  const n = texto.length;
  let i = texto.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pila: NodoXml[] = [];
  let raiz: NodoXml | null = null;

  const agregarTexto = (t: string, crudo: boolean) => {
    if (!t) return;
    const padre = pila[pila.length - 1];
    if (!padre) {
      for (let k = 0; k < t.length; k++) {
        if (!esEspacio(t.charCodeAt(k))) throw new ErrorXml("mal_formado", "Hay texto fuera del elemento raíz.");
      }
      return;
    }
    const val = crudo ? t : decodificarEntidades(t);
    const ult = padre.hijos[padre.hijos.length - 1];
    if (typeof ult === "string") padre.hijos[padre.hijos.length - 1] = ult + val;
    else padre.hijos.push(val);
  };

  while (i < n) {
    const lt = texto.indexOf("<", i);
    if (lt < 0) { agregarTexto(texto.slice(i), false); break; }
    if (lt > i) agregarTexto(texto.slice(i, lt), false);
    const c1 = texto.charCodeAt(lt + 1);

    if (c1 === 33 /* ! */) {
      if (texto.startsWith("<!--", lt)) {
        const fin = texto.indexOf("-->", lt + 4);
        if (fin < 0) throw new ErrorXml("mal_formado", "Un comentario no se cierra.");
        i = fin + 3; continue;
      }
      if (texto.startsWith("<![CDATA[", lt)) {
        const fin = texto.indexOf("]]>", lt + 9);
        if (fin < 0) throw new ErrorXml("mal_formado", "Una sección CDATA no se cierra.");
        if (!pila.length) throw new ErrorXml("mal_formado", "CDATA fuera del elemento raíz.");
        agregarTexto(texto.slice(lt + 9, fin), true);
        i = fin + 3; continue;
      }
      const decl = texto.slice(lt, lt + 12).toUpperCase();
      if (decl.startsWith("<!DOCTYPE") || decl.startsWith("<!ENTITY")) {
        throw new ErrorXml("dtd_prohibido", "El XML trae una declaración DOCTYPE o ENTITY, que no se acepta.");
      }
      throw new ErrorXml("dtd_prohibido", "El XML trae una declaración `<!…>` que no se acepta.");
    }

    if (c1 === 63 /* ? */) {
      const fin = texto.indexOf("?>", lt + 2);
      if (fin < 0) throw new ErrorXml("mal_formado", "Una instrucción de proceso no se cierra.");
      i = fin + 2; continue;
    }

    if (c1 === 47 /* / */) {
      const fin = texto.indexOf(">", lt + 2);
      if (fin < 0) throw new ErrorXml("mal_formado", "Una etiqueta de cierre no se cierra.");
      const nombre = texto.slice(lt + 2, fin).trim();
      const abierto = pila.pop();
      if (!abierto || abierto.nombre !== nombre) {
        throw new ErrorXml("mal_formado", `Cierre </${nombre.slice(0, 40)}> sin apertura que le corresponda.`);
      }
      i = fin + 1; continue;
    }

    // Etiqueta de apertura.
    let j = lt + 1;
    while (j < n) {
      const c = texto.charCodeAt(j);
      if (esEspacio(c) || c === 47 || c === 62) break;
      j++;
    }
    const nombre = texto.slice(lt + 1, j);
    if (!nombre || nombre.indexOf("<") >= 0) throw new ErrorXml("mal_formado", "Etiqueta sin nombre.");
    const nodo = nuevoNodo(nombre);
    let autocierre = false;
    for (;;) {
      while (j < n && esEspacio(texto.charCodeAt(j))) j++;
      if (j >= n) throw new ErrorXml("mal_formado", `La etiqueta <${nombre.slice(0, 40)}> no se cierra.`);
      const c = texto.charCodeAt(j);
      if (c === 62 /* > */) { j++; break; }
      if (c === 47 /* / */) {
        if (texto.charCodeAt(j + 1) !== 62) throw new ErrorXml("mal_formado", `«/» suelto en <${nombre.slice(0, 40)}>.`);
        autocierre = true; j += 2; break;
      }
      const ini = j;
      while (j < n) {
        const d = texto.charCodeAt(j);
        if (esEspacio(d) || d === 61 || d === 62 || d === 47) break;
        j++;
      }
      const anom = texto.slice(ini, j);
      if (!anom) throw new ErrorXml("mal_formado", `Atributo sin nombre en <${nombre.slice(0, 40)}>.`);
      while (j < n && esEspacio(texto.charCodeAt(j))) j++;
      if (texto.charCodeAt(j) !== 61 /* = */) throw new ErrorXml("mal_formado", `Atributo «${anom.slice(0, 40)}» sin valor.`);
      j++;
      while (j < n && esEspacio(texto.charCodeAt(j))) j++;
      const q = texto.charCodeAt(j);
      if (q !== 34 && q !== 39) throw new ErrorXml("mal_formado", `Valor del atributo «${anom.slice(0, 40)}» sin comillas.`);
      const fin = texto.indexOf(q === 34 ? "\"" : "'", j + 1);
      if (fin < 0) throw new ErrorXml("mal_formado", `Valor del atributo «${anom.slice(0, 40)}» sin cerrar.`);
      // Normalización de atributos de XML: tab, salto y retorno valen espacio (antes de las entidades).
      const crudo = texto.slice(j + 1, fin).replace(/[\t\n\r]/g, " ");
      nodo.atributos[anom] = decodificarEntidades(crudo);
      j = fin + 1;
    }

    const padre = pila[pila.length - 1];
    if (padre) padre.hijos.push(nodo);
    else {
      if (raiz) throw new ErrorXml("mal_formado", "El XML tiene más de un elemento raíz.");
      raiz = nodo;
    }
    if (!autocierre) {
      pila.push(nodo);
      if (pila.length > maxProf) throw new ErrorXml("anidamiento", `El XML anida más de ${maxProf} niveles.`);
    }
    i = j;
  }

  if (pila.length) throw new ErrorXml("mal_formado", `La etiqueta <${pila[pila.length - 1].nombre.slice(0, 40)}> no se cierra.`);
  if (!raiz) throw new ErrorXml("mal_formado", "El XML no tiene elemento raíz.");
  return raiz;
}

// ── Ayudas de recorrido (sin recursión salvo donde se indica) ──────────────────

export function esNodo(x: NodoXml | string | undefined | null): x is NodoXml {
  return typeof x === "object" && x !== null;
}
/** Primer hijo DIRECTO con ese nombre. */
export function hijo(n: NodoXml | null | undefined, nombre: string): NodoXml | null {
  if (!n) return null;
  for (const h of n.hijos) if (typeof h !== "string" && h.nombre === nombre) return h;
  return null;
}
/** Hijos DIRECTOS con ese nombre. */
export function hijosLlamados(n: NodoXml | null | undefined, nombre: string): NodoXml[] {
  const out: NodoXml[] = [];
  if (!n) return out;
  for (const h of n.hijos) if (typeof h !== "string" && h.nombre === nombre) out.push(h);
  return out;
}
/** Valor de un atributo, o null. */
export function attr(n: NodoXml | null | undefined, nombre: string): string | null {
  if (!n) return null;
  const v = n.atributos[nombre];
  return v === undefined ? null : v;
}
/** Todos los descendientes con ese nombre, en orden de documento (iterativo). */
export function descendientes(n: NodoXml, nombre: string): NodoXml[] {
  const out: NodoXml[] = [];
  const pila: NodoXml[] = [n];
  while (pila.length) {
    const x = pila.pop()!;
    for (let k = x.hijos.length - 1; k >= 0; k--) {
      const h = x.hijos[k];
      if (typeof h === "string") continue;
      pila.push(h);
    }
    if (x !== n && x.nombre === nombre) out.push(x);
  }
  return out;
}

/**
 * Reescribe IN PLACE los prefijos de elementos y atributos a los canónicos según su espacio de
 * nombres (`prefijoDeUri`: uri → prefijo, "" = sin prefijo). Un documento que declara
 * `xmlns="…/wordprocessingml/2006/main"` o usa `ns0:` en vez de `w:` queda con los nombres de
 * siempre. Los espacios desconocidos conservan su nombre. Iterativo.
 */
export function canonizarPrefijos(raiz: NodoXml, prefijoDeUri: Readonly<Record<string, string>>): NodoXml {
  type Ambito = Map<string, string>; // prefijo ("" = por defecto) → uri
  const pila: { nodo: NodoXml; ambito: Ambito }[] = [{ nodo: raiz, ambito: new Map() }];
  while (pila.length) {
    const { nodo, ambito: heredado } = pila.pop()!;
    let ambito = heredado;
    for (const k of Object.keys(nodo.atributos)) {
      if (k === "xmlns" || k.startsWith("xmlns:")) {
        if (ambito === heredado) ambito = new Map(heredado);
        ambito.set(k === "xmlns" ? "" : k.slice(6), nodo.atributos[k]);
      }
    }
    const renombrar = (nombre: string, esAtributo: boolean): string => {
      const p = nombre.indexOf(":");
      const prefijo = p < 0 ? "" : nombre.slice(0, p);
      if (prefijo === "xmlns" || (esAtributo && p < 0) || prefijo === "xml") return nombre;
      const uri = ambito.get(prefijo);
      if (uri === undefined) return nombre;
      // El uri lo declara el documento: sin hasOwnProperty, xmlns:x="constructor" leería Object.prototype.
      const canon = Object.prototype.hasOwnProperty.call(prefijoDeUri, uri) ? prefijoDeUri[uri] : undefined;
      if (canon === undefined) return nombre;
      const local = p < 0 ? nombre : nombre.slice(p + 1);
      return canon ? `${canon}:${local}` : local;
    };
    nodo.nombre = renombrar(nodo.nombre, false);
    const claves = Object.keys(nodo.atributos);
    let cambia = false;
    for (const k of claves) if (k.indexOf(":") > 0 && !k.startsWith("xmlns:")) { cambia = true; break; }
    if (cambia) {
      const nuevos = Object.create(null) as Record<string, string>;
      for (const k of claves) nuevos[renombrar(k, true)] = nodo.atributos[k];
      nodo.atributos = nuevos;
    }
    for (const h of nodo.hijos) if (typeof h !== "string") pila.push({ nodo: h, ambito });
  }
  return raiz;
}
