// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/index.ts — Registro y resolución de la ayuda contextual.
//
// El panel "?" del layout llama a `ayudaDeRuta(pathname)` y pinta lo que devuelva.
// Si una pantalla todavía no tiene ficha, se devuelve null y el botón no aparece:
// mejor no ofrecer ayuda que ofrecer una vacía.
// ──────────────────────────────────────────────────────────────────────────────

import type { AyudaModulo, Concepto } from "@/lib/ayuda/tipos";
import { GLOSARIO } from "@/lib/ayuda/glosario";
import { MODULOS_FINANZAS } from "@/lib/ayuda/modulos-finanzas";
import { MODULOS_OPERACIONES } from "@/lib/ayuda/modulos-operaciones";
import { MODULOS_FLOTA } from "@/lib/ayuda/modulos-flota";

export type { AyudaModulo, Concepto, Faq, ComoHacer } from "@/lib/ayuda/tipos";
export { GLOSARIO } from "@/lib/ayuda/glosario";

export const MODULOS_AYUDA: AyudaModulo[] = [
  ...MODULOS_FINANZAS,
  ...MODULOS_OPERACIONES,
  ...MODULOS_FLOTA,
];

/**
 * Resuelve la ayuda de una ruta. Gana SIEMPRE la coincidencia más larga: así
 * "/crm/campanas" toma su propia ficha aunque "/crm" también sea candidata, y no hay
 * que preocuparse por el orden en que se declaran los módulos.
 */
export function ayudaDeRuta(pathname: string | null | undefined): AyudaModulo | null {
  const ruta = (pathname ?? "").split("?")[0].replace(/\/+$/, "") || "/";
  let mejor: AyudaModulo | null = null;
  let largo = -1;

  for (const m of MODULOS_AYUDA) {
    for (const r of m.rutas) {
      const base = r.replace(/\/+$/, "");
      const calza = ruta === base || ruta.startsWith(base + "/");
      if (calza && base.length > largo) {
        mejor = m;
        largo = base.length;
      }
    }
  }
  return mejor;
}

/** Los conceptos de un módulo, ya resueltos contra el glosario y sin claves muertas. */
export function conceptosDe(modulo: AyudaModulo): Concepto[] {
  return (modulo.conceptos ?? [])
    .map((c) => GLOSARIO[c])
    .filter((c): c is Concepto => Boolean(c));
}

/** Todo el glosario ordenado alfabéticamente, para la pestaña de búsqueda de términos. */
export function glosarioOrdenado(): Concepto[] {
  return Object.values(GLOSARIO).sort((a, b) => a.termino.localeCompare(b.termino, "es"));
}

/** Busca en término, definición y ejemplo. Tolerante a tildes y mayúsculas. */
export function buscarConceptos(texto: string): Concepto[] {
  const q = normaliza(texto);
  if (!q) return glosarioOrdenado();
  return glosarioOrdenado().filter((c) =>
    normaliza(`${c.termino} ${c.definicion} ${c.ejemplo ?? ""} ${c.ojo ?? ""}`).includes(q)
  );
}

function normaliza(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
