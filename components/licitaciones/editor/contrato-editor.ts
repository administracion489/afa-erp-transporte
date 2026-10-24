// components/licitaciones/editor/contrato-editor.ts — CONTRATO entre el editor de /licitaciones/[id] y
// sus cinco pasos. Lo escribió la sesión principal para que cada paso lo construya un agente distinto
// sin pisarse: el editor (page.tsx) es el ÚNICO dueño del estado y del guardado; cada paso recibe
// PasoProps, lee y propone cambios con las dos funciones, y nunca llama a guardarLicitacion.
import type { ContextoLicitacion, DocLicitacion, Licitacion, Paso, Revision } from "@/lib/licitaciones/tipos";
import type { CambiosLicitacion } from "@/lib/licitaciones/datos";

/** Las columnas de la fila que se editan junto al doc (todo COLUMNAS_EDITABLES salvo el doc). */
export type ColumnasLic = Omit<CambiosLicitacion, "doc">;

export type TonoAviso = "ok" | "error" | "aviso";

export type PasoProps = {
  /** La licitación TAL COMO SE ESTÁ EDITANDO: columnas en edición + `doc` en edición. `id` y `version`
   *  son los de la última versión guardada. Es lo que se le pasa a revisarLicitacion / resolverDocumento. */
  lic: Licitacion;
  /** Atajo de `lic.doc`. */
  doc: DocLicitacion;
  /** Cambio INMUTABLE del doc (devolver un objeto nuevo). El editor marca «sin guardar» y guarda solo. */
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  /** Cambio de columnas de la fila (nombre, cliente, fechas, estado…). */
  cambiarColumnas: (c: ColumnasLic) => void;
  /** Lo que el ERP sabe hoy (unidades/conductores ELEGIDOS, legajo, experiencia, seguros, personal…).
   *  null mientras se lee la primera vez. */
  ctx: ContextoLicitacion | null;
  ctxCargando: boolean;
  /** Volver a leer el contexto: tras elegir o quitar recursos, o tras subir un documento a una ficha
   *  (legajo, unidad, conductor, experiencia). El editor lo hace con antirrebote. */
  recargarCtx: () => void;
  /** revisarLicitacion(lic en edición, ctx). null mientras no hay contexto. */
  revision: Revision | null;
  /** Ir a otro paso (y a un ancla dentro de él: un panel («requisitos») o un elemento («requisito:<uuid>»): ver ANCLAS abajo). */
  irA: (paso: Paso, ancla?: string | null) => void;
  /** Archivada o sin permiso de escritura: los pasos no ofrecen controles de edición. */
  soloLectura: boolean;
  /** Identificador nuevo para elementos del doc (uuid). */
  nuevoId: () => string;
  /** Aviso breve (toast). */
  aviso: (texto: string, tono?: TonoAviso) => void;
};

/**
 * ANCLAS: la MISMA forma con que lib/licitaciones/revision.ts escribe `Hallazgo.donde.ancla`, para que
 * «Ir al arreglo» lleve exactamente al elemento. Dos formas:
 *  · un PANEL del paso: el id del DOM es el nombre tal cual (`id="requisitos"`, `id="unidades"`…);
 *  · un ELEMENTO concreto: `<tipo>:<id>` (`id="requisito:<uuid>"`, `id="bloque:<uuid>"`,
 *    `id="unidad:p:12"` — en unidades y conductores el id es la ClaveRecurso, no el uuid de la elección).
 * El editor busca el elemento; si no existe, cae al panel que corresponde al tipo (`panelDeAncla`).
 */
export const PANELES = [
  "datos", "bases_subidas", "analisis", "requisitos", "consultas",
  "unidades", "conductores", "experiencia", "contactos", "representante",
  "portada", "control", "carta", "glosario", "indice", "secciones", "cierre",
  "expediente", "foliado", "hallazgos", "emision",
] as const;
export type Panel = (typeof PANELES)[number];
export type TipoAncla =
  | "requisito" | "consulta" | "unidad" | "conductor" | "contacto" | "experiencia"
  | "seccion" | "bloque" | "bloque_expediente" | "item";
export const anclaDe = (tipo: TipoAncla, id: string | number): string => `${tipo}:${id}`;

const PANEL_DE_TIPO: Record<TipoAncla, Panel> = {
  requisito: "requisitos", consulta: "consultas", unidad: "unidades", conductor: "conductores", contacto: "contactos",
  experiencia: "experiencia", seccion: "secciones", bloque: "secciones", bloque_expediente: "expediente", item: "expediente",
};
/** El panel al que se cae si el elemento no está en pantalla. null = el ancla ya es un panel (o no se conoce). */
export function panelDeAncla(ancla: string): Panel | null {
  const i = ancla.indexOf(":");
  if (i < 0) return null;
  return (PANEL_DE_TIPO as Record<string, Panel>)[ancla.slice(0, i)] ?? null;
}
