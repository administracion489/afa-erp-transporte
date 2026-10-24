// components/licitaciones/editor/recursos/hallazgos.ts — A qué parte del paso «Recursos» pertenece cada
// hallazgo de la revisión y a qué elemento lleva. NO juzga nada: los hallazgos los produce
// revisarLicitacion (lib/licitaciones/revision.ts); aquí solo se reparten para pintarlos junto a su sujeto.
//
// Lo único que se calla es lo FALSO POR DESFASE: un recurso recién elegido todavía no está en el contexto
// (el editor lo vuelve a leer con antirrebote), así que la revisión dice «ya no existe en el ERP» de una
// unidad que la lista de la flota sí trae. Mientras dure eso, la pantalla dice «comprobando…».

import { anclaDe } from "../contrato-editor";
import type { Hallazgo } from "@/lib/licitaciones/tipos";

export type GrupoRecursos = "unidades" | "conductores" | "experiencia" | "contactos" | "representante";
export const GRUPOS_RECURSOS: readonly GrupoRecursos[] = ["unidades", "conductores", "experiencia", "contactos", "representante"];
export const TITULO_GRUPO: Record<GrupoRecursos, string> = {
  unidades: "Unidades", conductores: "Conductores", experiencia: "Experiencia", contactos: "Contactos del contrato", representante: "Representante legal",
};

const FUENTE_GRUPO: Record<string, GrupoRecursos> = {
  "fuente:unidades": "unidades", "fuente:conductores": "conductores", "fuente:experiencia": "experiencia", "fuente:personal": "representante",
};

/** El grupo del paso al que pertenece el hallazgo, o null si es de otro paso. */
export function grupoDe(h: Hallazgo): GrupoRecursos | null {
  if (h.sujeto.tipo === "unidad") return "unidades";
  if (h.sujeto.tipo === "conductor") return "conductores";
  if (h.sujeto.tipo === "experiencia") return "experiencia";
  if (h.codigo === "fuente_no_leida") return FUENTE_GRUPO[h.sujeto.id] ?? null;
  const c = h.codigo;
  if (c.startsWith("unidad") || c === "reten_insuficiente" || c === "tercero_sin_autorizacion") return "unidades";
  if (c.startsWith("conductor")) return "conductores";
  if (c.startsWith("experiencia")) return "experiencia";
  if (c === "representante_incompleto" || c === "firma_falta") return "representante";
  if ("paso" in h.donde && h.donde.paso === "recursos") {
    const a = h.donde.ancla ?? "";
    return (GRUPOS_RECURSOS as readonly string[]).includes(a) ? (a as GrupoRecursos) : null;
  }
  return null;
}

/** Clave del sujeto de un hallazgo de recurso: "unidad:p:12", "conductor:t:5", "experiencia:7". */
export const sujetoClave = (h: Hallazgo): string | null =>
  h.sujeto.tipo === "unidad" || h.sujeto.tipo === "conductor" || h.sujeto.tipo === "experiencia" ? `${h.sujeto.tipo}:${h.sujeto.id}` : null;

const NO_EXISTE = new Set(["unidad_no_existe", "conductor_no_existe", "experiencia_no_existe"]);

/**
 * Los hallazgos del paso, sin los «no existe» de lo que todavía se está comprobando (`pendientes`: claves
 * de sujeto que la lista del ERP trae y el contexto aún no).
 */
export function hallazgosDelPaso(hs: readonly Hallazgo[] | null | undefined, pendientes: ReadonlySet<string>): Hallazgo[] {
  return (hs ?? []).filter((h) => {
    if (!grupoDe(h)) return false;
    const k = sujetoClave(h);
    return !(k && pendientes.has(k) && NO_EXISTE.has(h.codigo));
  });
}

/**
 * El ancla del elemento al que lleva el hallazgo (o la de su panel). Misma forma que contrato-editor:
 * en unidades y conductores el id es la ClaveRecurso del sujeto; si el elemento ya no está, el editor
 * cae al panel.
 */
export function anclaDeHallazgo(h: Hallazgo): string | null {
  if (h.sujeto.tipo === "unidad") return anclaDe("unidad", h.sujeto.id);
  if (h.sujeto.tipo === "conductor") return anclaDe("conductor", h.sujeto.id);
  if (h.sujeto.tipo === "experiencia") return anclaDe("experiencia", h.sujeto.id);
  return grupoDe(h);
}

/** Hallazgos de UN sujeto (una unidad, un conductor, un contrato). */
export const deSujeto = (hs: readonly Hallazgo[], tipo: "unidad" | "conductor" | "experiencia", id: string) =>
  hs.filter((h) => h.sujeto.tipo === tipo && h.sujeto.id === id);

/** Hallazgos de un grupo que no son de un sujeto concreto (van arriba de la sección). */
export const generalesDe = (hs: readonly Hallazgo[], g: GrupoRecursos) => hs.filter((h) => grupoDe(h) === g && !sujetoClave(h));

/** Cuenta sin los aceptados, por gravedad. */
export function cuenta(hs: readonly Hallazgo[]): { alarma: number; aviso: number; info: number } {
  const c = { alarma: 0, aviso: 0, info: 0 };
  for (const h of hs) if (!h.aceptado) c[h.gravedad]++;
  return c;
}
