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
  /** Ir a otro paso (y a un ancla dentro de él: un id de elemento del DOM, p. ej. `req-<id>`). */
  irA: (paso: Paso, ancla?: string | null) => void;
  /** Archivada o sin permiso de escritura: los pasos no ofrecen controles de edición. */
  soloLectura: boolean;
  /** Identificador nuevo para elementos del doc (uuid). */
  nuevoId: () => string;
  /** Aviso breve (toast). */
  aviso: (texto: string, tono?: TonoAviso) => void;
};

/** Ancla estable de un elemento del doc, la MISMA para quien la pinta y para quien navega hacia ella. */
export const anclaDe = (tipo: "req" | "consulta" | "unidad" | "conductor" | "seccion" | "bloque" | "bexp" | "item" | "contacto" | "exp", id: string | number): string =>
  `${tipo}-${id}`;
