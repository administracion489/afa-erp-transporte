// components/licitaciones/editor/navegacion.ts — De un `donde.ancla` de la revisión al elemento del DOM.
//
// La revisión (lib/licitaciones/revision.ts) nombra el sitio que se corrige de dos maneras:
//  · un PANEL del paso: "datos", "requisitos", "consultas", "unidades", "conductores", "experiencia",
//    "contactos", "representante", "secciones", "expediente", "foliado", "hallazgos"…
//  · un ELEMENTO concreto como "<tipo>:<id>": "requisito:…", "unidad:p:12", "bloque:…", "seccion:…",
//    "bloque_expediente:…", "item:…".
// Los pasos pintan sus elementos con `anclaDe(tipo, id)` (contrato-editor.ts: "req-<id>", "unidad-<id>"…)
// y sus paneles con el nombre del panel como `id` (o "panel-<nombre>"). Esta función da, en orden, los
// ids del DOM que el editor prueba: el primero que exista es el destino.
import { anclaDe } from "./contrato-editor";
import type { DocLicitacion } from "@/lib/licitaciones/tipos";

type TipoAncla = Parameters<typeof anclaDe>[0];

/** Tipo de la revisión (o del propio contrato) → prefijo de anclaDe. */
const PREFIJO: Record<string, TipoAncla> = {
  requisito: "req", req: "req", consulta: "consulta", unidad: "unidad", conductor: "conductor",
  seccion: "seccion", bloque: "bloque", bloque_expediente: "bexp", bexp: "bexp", item: "item",
  item_expediente: "item", contacto: "contacto", experiencia: "exp", exp: "exp",
};

/**
 * Los ids del DOM a probar para un ancla, del más preciso al más general. Para una unidad o un
 * conductor la revisión da la CLAVE ("p:12") y el paso puede haber usado el id del elemento del doc:
 * se prueban los dos.
 */
export function candidatosAncla(ancla: string, doc?: DocLicitacion | null): string[] {
  const out: string[] = [ancla];
  const i = ancla.indexOf(":");
  if (i > 0) {
    const tipo = ancla.slice(0, i);
    const resto = ancla.slice(i + 1);
    const p = PREFIJO[tipo];
    if (p && resto) {
      out.push(anclaDe(p, resto));
      if (doc && (p === "unidad" || p === "conductor")) {
        const lista: { id: string; clave: string }[] = p === "unidad" ? doc.unidades : doc.conductores;
        const el = lista.find((x) => x.clave === resto);
        if (el) out.push(anclaDe(p, el.id));
      }
    }
  }
  out.push(`panel-${ancla}`);
  return [...new Set(out)];
}
