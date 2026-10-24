// components/licitaciones/editor/contenido/bloques.ts — Lo que el paso «Contenido» necesita saber de los
// bloques sin pintar nada: qué tipos hay y qué hace cada uno, cómo se crea uno vacío, cómo se copia con
// ids nuevos, cómo se pega una tabla de Excel y cómo se envuelve una selección en **negrita**.
//
// Sin React ni base: lo importan los subcomponentes del paso. Los topes son los de TOPES_DOC (tipos.ts) y,
// los que ese contrato no declara, los MISMOS que aplica lib/licitaciones/normalizar.ts (no los exporta:
// si se cambian allí, se cambian aquí). Un tope que la pantalla deja pasar y el normalizador recorta es
// texto que el operador escribió y desaparece al guardar sin que nadie lo diga.

import { LIMITES_TEXTO as L } from "@/lib/licitaciones/normalizar";
import { TOPES_DOC, type Bloque, type Paso, type Seccion, type TipoAuto, type TipoBloque } from "@/lib/licitaciones/tipos";

/** Topes de texto del documento: los MISMOS con que normalizar.ts recorta al guardar (LIMITES_TEXTO). */
export const LIM = {
  tituloSeccion: L.titulo,
  subtitulo: L.titulo,
  tituloTabla: L.titulo,
  encabezado: L.titulo,
  pieImagen: L.pieImagen,
  texto: TOPES_DOC.maxTextoBloque,
  vinetas: L.maxVinetas,
  glosario: L.maxGlosario,
  termino: L.corto,
  definicion: L.definicion,
  portadaTitulo: L.titulo,
  portadaSubtitulo: L.subtituloPortada,
  cabecera: L.titulo,
  controlCampo: L.titulo,
  controlVersion: L.version,
  controlCodigo: L.codigoDoc,
  confidencialidad: L.confidencialidad,
  cartaCorto: L.titulo,
  cartaLargo: L.cartaLargo,
} as const;

export const ORDEN_TIPOS: readonly TipoBloque[] = ["parrafo", "subtitulo", "vinetas", "tabla", "nota", "imagen", "salto_pagina", "auto"];

export const INFO_BLOQUE: Record<TipoBloque, { icono: string; nombre: string; ayuda: string }> = {
  parrafo: { icono: "¶", nombre: "Párrafo", ayuda: "Texto corrido. Admite **negrita**, {variables} y [COMPLETAR]." },
  subtitulo: { icono: "H", nombre: "Subtítulo", ayuda: "Título dentro de la sección (1.1 o 1.1.1). Entra en el índice si es de nivel 2." },
  vinetas: { icono: "•", nombre: "Viñetas", ayuda: "Una lista, una línea por viñeta. Con o sin números." },
  tabla: { icono: "▦", nombre: "Tabla", ayuda: "Una tabla que escribes tú (o pegas desde Excel)." },
  nota: { icono: "ℹ", nombre: "Nota destacada", ayuda: "Un recuadro de color para un dato que no se debe pasar por alto." },
  imagen: { icono: "🖼", nombre: "Imagen", ayuda: "Una foto o gráfico en PNG o JPG, con su pie." },
  salto_pagina: { icono: "⤓", nombre: "Salto de página", ayuda: "Lo que sigue empieza en una hoja nueva." },
  auto: { icono: "⚙", nombre: "Tabla automática", ayuda: "Una tabla que el ERP arma sola con lo elegido en Bases, Recursos o Expediente." },
};

/** Qué arma cada tabla automática y de dónde sale (el texto lo lee el operador, no el motor). */
export const INFO_AUTO: Record<TipoAuto, { nombre: string; descripcion: string; deDonde: string; paso: Paso; ancla: string | null; irEtiqueta: string }> = {
  datos_postor: {
    nombre: "Datos generales del postor",
    descripcion: "Razón social, RUC, domicilio, representante legal, autorización de transporte, contacto y web.",
    deDonde: "Sale del perfil de la empresa y del representante legal elegido en Recursos.",
    paso: "recursos", ancla: "representante", irEtiqueta: "Ir al representante",
  },
  relacion_unidades: {
    nombre: "Relación de unidades",
    descripcion: "Código, uso, tipo, marca y modelo, placa y año de cada unidad ofertada.",
    deDonde: "Sale de las unidades elegidas en Recursos (titulares y retén), con los datos de su ficha.",
    paso: "recursos", ancla: "unidades", irEtiqueta: "Ir a las unidades",
  },
  exigido_ofertado: {
    nombre: "Exigido por las bases vs. ofertado",
    descripcion: "Cada requisito de unidades o conductores con lo que ofrecen los recursos elegidos.",
    deDonde: "Sale de los requisitos de unidades y conductores (Bases) y de lo elegido en Recursos.",
    paso: "bases", ancla: "requisitos", irEtiqueta: "Ir a los requisitos",
  },
  conductores: {
    nombre: "Relación de conductores",
    descripcion: "Nombre, DNI, licencia, categoría y rol de cada conductor asignado.",
    deDonde: "Sale de los conductores elegidos en Recursos.",
    paso: "recursos", ancla: "conductores", irEtiqueta: "Ir a los conductores",
  },
  matriz_cumplimiento: {
    nombre: "Matriz de cumplimiento de requisitos",
    descripcion: "Requisito · Cumple · Sustento adjunto, con el estado que dio la revisión.",
    deDonde: "Sale de los requisitos marcados «en la matriz» en Bases y de su evaluación.",
    paso: "bases", ancla: "requisitos", irEtiqueta: "Ir a los requisitos",
  },
  absolucion_consultas: {
    nombre: "Absolución de consultas",
    descripcion: "Cada consulta con la respuesta del cliente y cómo la incorpora el postor.",
    deDonde: "Sale de las consultas absueltas registradas en Bases.",
    paso: "bases", ancla: "consultas", irEtiqueta: "Ir a las consultas",
  },
  cuadro_experiencia: {
    nombre: "Cuadro de experiencia",
    descripcion: "Los contratos acreditados con cliente, objeto, periodo e importe, y el total por moneda.",
    deDonde: "Sale de la experiencia elegida en Recursos (catálogo de experiencia de la empresa).",
    paso: "recursos", ancla: "experiencia", irEtiqueta: "Ir a la experiencia",
  },
  contactos: {
    nombre: "Contactos del contrato",
    descripcion: "Rol, nombre, cargo, teléfono y correo de cada contacto del contrato.",
    deDonde: "Sale de los contactos registrados en Recursos.",
    paso: "recursos", ancla: "contactos", irEtiqueta: "Ir a los contactos",
  },
  relacion_adjuntos: {
    nombre: "Relación de documentos adjuntos",
    descripcion: "Cada separador del expediente con su contenido, su referencia en las bases y sus folios.",
    deDonde: "Sale de los bloques activos del Expediente. Los folios se calculan al emitir (en la vista previa salen «—»).",
    paso: "expediente", ancla: "expediente", irEtiqueta: "Ir al expediente",
  },
};

/** Un bloque nuevo y vacío del tipo pedido. */
export function bloqueNuevo(tipo: TipoBloque, nuevoId: () => string, auto: TipoAuto = "datos_postor"): Bloque {
  const id = nuevoId();
  switch (tipo) {
    case "parrafo": return { id, tipo, texto: "" };
    case "subtitulo": return { id, tipo, texto: "", nivel: 2, numerado: true };
    case "vinetas": return { id, tipo, items: [""], ordenada: false };
    case "tabla": return { id, tipo, titulo: null, columnas: ["", ""], filas: [["", ""]], anchos: null };
    case "nota": return { id, tipo, texto: "", tono: "info" };
    case "imagen": return { id, tipo, archivo: null, pie: null, anchoPct: 100 };
    case "salto_pagina": return { id, tipo };
    case "auto": return { id, tipo, auto, titulo: null, filasExtra: [], conContacto: false };
  }
}

/** Copia de un bloque con id nuevo (y la referencia de su imagen con id nuevo: el archivo es el mismo). */
export function copiarBloque(b: Bloque, nuevoId: () => string): Bloque {
  const c = structuredClone(b);
  c.id = nuevoId();
  if (c.tipo === "imagen" && c.archivo) c.archivo = { ...c.archivo, id: nuevoId() };
  return c;
}

/** Copia de una sección con ids nuevos en ella y en cada bloque. */
export function copiarSeccion(s: Seccion, nuevoId: () => string, titulo?: string): Seccion {
  return { ...s, id: nuevoId(), titulo: titulo ?? s.titulo, bloques: s.bloques.map((b) => copiarBloque(b, nuevoId)) };
}

/** Mueve el elemento `de` a la posición `a` (copia nueva; índices fuera de rango → la misma lista). */
export function mover<T>(lista: readonly T[], de: number, a: number): T[] {
  if (de === a || de < 0 || a < 0 || de >= lista.length || a >= lista.length) return [...lista];
  const out = [...lista];
  const [x] = out.splice(de, 1);
  out.splice(a, 0, x);
  return out;
}

/** ¿El bloque tiene algo escrito? (para pedir confirmación antes de quitarlo). */
export function tieneContenido(b: Bloque): boolean {
  switch (b.tipo) {
    case "parrafo": case "nota": case "subtitulo": return b.texto.trim() !== "";
    case "vinetas": return b.items.some((i) => i.trim() !== "");
    case "tabla": return !!b.titulo?.trim() || b.columnas.some((c) => c.trim()) || b.filas.some((f) => f.some((c) => c.trim()));
    case "imagen": return !!b.archivo || !!b.pie?.trim();
    case "salto_pagina": return false;
    case "auto": return !!b.titulo?.trim() || b.filasExtra.length > 0;
  }
}

const corto = (t: string, n = 60) => {
  const s = t.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Cómo se nombra un bloque en una confirmación («el párrafo «Los servicios…»»). */
export function rotuloBloque(b: Bloque): string {
  switch (b.tipo) {
    case "parrafo": return b.texto.trim() ? `el párrafo «${corto(b.texto)}»` : "el párrafo vacío";
    case "subtitulo": return b.texto.trim() ? `el subtítulo «${corto(b.texto)}»` : "el subtítulo vacío";
    case "nota": return b.texto.trim() ? `la nota «${corto(b.texto)}»` : "la nota vacía";
    case "vinetas": { const n = b.items.filter((i) => i.trim()).length; return `la lista de ${n} ${n === 1 ? "viñeta" : "viñetas"}`; }
    case "tabla": return `la tabla${b.titulo?.trim() ? ` «${corto(b.titulo)}»` : ""} de ${b.filas.length} ${b.filas.length === 1 ? "fila" : "filas"}`;
    case "imagen": return b.archivo ? `la imagen «${corto(b.archivo.nombre)}»` : "la imagen sin archivo";
    case "salto_pagina": return "el salto de página";
    case "auto": return `la tabla automática «${INFO_AUTO[b.auto].nombre}»${b.filasExtra.length ? ` (con ${b.filasExtra.length} filas escritas a mano)` : ""}`;
  }
}

/** Cuántos bloques de una sección tienen algo escrito. */
export const bloquesConContenido = (s: Seccion) => s.bloques.filter(tieneContenido).length;

// ══ Pegar desde Excel ═══════════════════════════════════════════════════════════

/**
 * Lo que Excel, Google Sheets o Word ponen en el portapapeles al copiar celdas: filas separadas por salto
 * de línea y celdas por tabulación; una celda con salto de línea, tabulación o comillas va entre comillas
 * con las comillas internas dobladas. Las filas vacías del final se quitan (Excel siempre añade una).
 */
export function parsearTabulado(t: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let enComillas = false;
  let inicio = true;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (enComillas) {
      if (ch === '"') {
        if (t[i + 1] === '"') { celda += '"'; i++; continue; }
        enComillas = false;
        continue;
      }
      celda += ch;
      continue;
    }
    if (ch === '"' && inicio) { enComillas = true; inicio = false; continue; }
    if (ch === "\t") { fila.push(celda); celda = ""; inicio = true; continue; }
    if (ch === "\r" || ch === "\n") {
      fila.push(celda); filas.push(fila);
      fila = []; celda = ""; inicio = true;
      if (ch === "\r" && t[i + 1] === "\n") i++;
      continue;
    }
    celda += ch;
    inicio = false;
  }
  if (celda !== "" || fila.length) { fila.push(celda); filas.push(fila); }
  while (filas.length && filas[filas.length - 1].every((c) => c.trim() === "")) filas.pop();
  return filas.map((f) => f.map((c) => c.replace(/\r\n?/g, "\n").trim()));
}

/** ¿Lo pegado es más de una celda? (si no, el pegado normal del navegador basta). */
export const esPegadoDeVariasCeldas = (t: string) => /\t|\r|\n/.test(t.replace(/[\r\n]+$/, ""));

export type TablaEditable = { columnas: string[]; filas: string[][]; anchos: number[] | null };

/**
 * Pega `datos` empezando en (fila, col) de la tabla: agrega filas y columnas que falten hasta los topes.
 * `fila = -1` pega en los encabezados (la primera fila pegada va a las columnas y el resto, debajo).
 * Devuelve la tabla nueva y cuánto NO cupo, para decirlo.
 */
export function pegarEnTabla(t: TablaEditable, fila: number, col: number, datos: string[][], max: { columnas: number; filas: number; texto: number }): { tabla: TablaEditable; sinCupo: { filas: number; columnas: number; recortadas: number } } {
  const columnas = [...t.columnas];
  let anchos = t.anchos ? [...t.anchos] : null;
  const filas = t.filas.map((f) => [...f]);
  let recortadas = 0;
  const cortar = (s: string, n: number) => { if (s.length > n) { recortadas++; return s.slice(0, n); } return s; };
  const anchoPedido = Math.max(0, ...datos.map((d) => d.length)) + col;
  const nuevasCols = Math.min(max.columnas, Math.max(columnas.length, anchoPedido));
  const sinCupoCols = Math.max(0, anchoPedido - max.columnas);
  while (columnas.length < nuevasCols) {
    columnas.push("");
    if (anchos) anchos.push(Math.max(1, Math.round(anchos.reduce((a, b) => a + b, 0) / anchos.length)));
  }
  for (const f of filas) while (f.length < columnas.length) f.push("");
  let resto = datos;
  if (fila < 0 && datos.length) {
    datos[0].forEach((v, j) => { if (col + j < columnas.length) columnas[col + j] = cortar(v, LIM.encabezado); });
    resto = datos.slice(1);
    fila = 0;
  }
  let sinCupoFilas = 0;
  resto.forEach((d, i) => {
    const r = fila + i;
    if (r >= max.filas) { sinCupoFilas++; return; }
    while (filas.length <= r) filas.push(Array.from({ length: columnas.length }, () => ""));
    d.forEach((v, j) => { if (col + j < columnas.length) filas[r][col + j] = cortar(v, max.texto); });
  });
  if (anchos && anchos.length !== columnas.length) anchos = null;
  return { tabla: { columnas, filas, anchos }, sinCupo: { filas: sinCupoFilas, columnas: sinCupoCols, recortadas } };
}

/** Frase con lo que no cupo al pegar, o null si cupo todo. */
export function fraseSinCupo(s: { filas: number; columnas: number; recortadas: number }, max: { columnas: number; filas: number }): string | null {
  const partes: string[] = [];
  if (s.filas) partes.push(`${s.filas} ${s.filas === 1 ? "fila" : "filas"} (el tope es ${max.filas})`);
  if (s.columnas) partes.push(`${s.columnas} ${s.columnas === 1 ? "columna" : "columnas"} (el tope es ${max.columnas})`);
  if (s.recortadas) partes.push(`${s.recortadas} ${s.recortadas === 1 ? "celda se recortó" : "celdas se recortaron"} por largo`);
  return partes.length ? `No cupo todo lo pegado: ${partes.join(", ")}.` : null;
}

// ══ Texto: negrita e inserciones en el cursor ═══════════════════════════════════

/**
 * Envuelve la selección [ini, fin) en **…**. Si la selección ya está envuelta, la desenvuelve. Sin
 * selección deja «****» con el cursor en medio. Los espacios de los bordes quedan FUERA de la marca
 * («** hola**» no es negrita para trozosDe).
 */
export function alternarNegrita(valor: string, ini: number, fin: number): { valor: string; ini: number; fin: number } {
  const a = Math.max(0, Math.min(ini, fin)), b = Math.min(valor.length, Math.max(ini, fin));
  if (valor.slice(Math.max(0, a - 2), a) === "**" && valor.slice(b, b + 2) === "**" && b > a) {
    return { valor: valor.slice(0, a - 2) + valor.slice(a, b) + valor.slice(b + 2), ini: a - 2, fin: b - 2 };
  }
  let s = a, e = b;
  while (s < e && /\s/.test(valor[s])) s++;
  while (e > s && /\s/.test(valor[e - 1])) e--;
  if (s === e) {
    const v = valor.slice(0, a) + "****" + valor.slice(b);
    return { valor: v, ini: a + 2, fin: a + 2 };
  }
  const v = valor.slice(0, s) + "**" + valor.slice(s, e) + "**" + valor.slice(e);
  return { valor: v, ini: s + 2, fin: e + 2 };
}

/** Inserta `texto` en el cursor (reemplazando la selección). */
export function insertarEnCursor(valor: string, ini: number, fin: number, texto: string): { valor: string; cursor: number } {
  const a = Math.max(0, Math.min(ini, fin, valor.length)), b = Math.min(valor.length, Math.max(ini, fin));
  return { valor: valor.slice(0, a) + texto + valor.slice(b), cursor: a + texto.length };
}

/** Número que se imprimirá para cada sección activa y numerada (el mismo cálculo de resolverDocumento). */
export function numerosDeSecciones(secciones: readonly Seccion[]): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const s of secciones) if (s.activa && s.numerada) out.set(s.id, String(++n));
  return out;
}

/** Número que se imprimirá para cada subtítulo de una sección (1.1, 1.1.1), como resolverDocumento. */
export function numerosDeSubtitulos(s: Seccion, numero: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!numero) return out;
  let n2 = 0, n3 = 0;
  for (const b of s.bloques) {
    if (b.tipo !== "subtitulo" || !b.numerado) continue;
    if (b.nivel === 2) { n2++; n3 = 0; out.set(b.id, `${numero}.${n2}`); }
    else { n3++; out.set(b.id, `${numero}.${Math.max(n2, 1)}.${n3}`); }
  }
  return out;
}
