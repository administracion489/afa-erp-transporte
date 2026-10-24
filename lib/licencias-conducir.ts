// lib/licencias-conducir.ts — Categorías de licencia de conducir. Módulo PURO.
//
// La lista vivía dentro de app/conductores/page.tsx; se mudó aquí porque la licitación tiene que
// contestar «¿la licencia de este conductor alcanza para esta unidad?» con la MISMA lista con que se
// escribe la categoría en la ficha del conductor.
//
// QUÉ CUBRE CADA CATEGORÍA ES UNA TABLA DECLARADA, no cotejada con el texto oficial vigente del
// Reglamento Nacional de Licencias de Conducir: cada categoría de la clase A habilita las anteriores de
// su misma línea (pasajeros o carga) y la A-IIIc todas. Ante la duda el motor dice «no se puede juzgar»
// en vez de afirmar que cumple (ver lib/licitaciones/reglas.ts).

import type { CategoriaLicencia } from "./licitaciones/tipos";

// Clasificación oficial MTC — Art. 12 del Reglamento Nacional de Licencias de Conducir.
// Cada categoría habilita también las anteriores (A-IIb maneja lo de A-IIa y A-I, etc.).
export const CATEGORIAS_LIC = [
  { valor: "A-I",    desc: "Autos particulares (M1/M2) y carga liviana (N1)" },
  { valor: "A-IIa",  desc: "Taxi, escolar, turístico y colectivo de pasajeros (M1)" },
  { valor: "A-IIb",  desc: "Pasajeros (M2) y mercancías (N2)" },
  { valor: "A-IIIa", desc: "Ómnibus / transporte de pasajeros (M3, +6 t)" },
  { valor: "A-IIIb", desc: "Carga pesada / camiones (N3)" },
  { valor: "A-IIIc", desc: "Pasajeros y carga (M3 + N3)" },
  { valor: "B-I",    desc: "Vehículos no motorizados (3+ ruedas)" },
  { valor: "B-IIb",  desc: "Motocicletas (L3/L4)" },
] as const;

export const CATEGORIAS_CLASE_A: readonly CategoriaLicencia[] = ["A-I", "A-IIa", "A-IIb", "A-IIIa", "A-IIIb", "A-IIIc"];

/** Lo que habilita cada categoría (incluida ella misma). Tabla DECLARADA, ver la cabecera. */
const CUBRE: Record<CategoriaLicencia, readonly CategoriaLicencia[]> = {
  "A-I": ["A-I"],
  "A-IIa": ["A-IIa", "A-I"],
  "A-IIb": ["A-IIb", "A-IIa", "A-I"],
  "A-IIIa": ["A-IIIa", "A-IIb", "A-IIa", "A-I"],
  "A-IIIb": ["A-IIIb", "A-IIb", "A-IIa", "A-I"],
  "A-IIIc": ["A-IIIc", "A-IIIb", "A-IIIa", "A-IIb", "A-IIa", "A-I"],
};

const POR_CLAVE: Record<string, CategoriaLicencia> = {
  AI: "A-I", A1: "A-I",
  AIIA: "A-IIa", A2A: "A-IIa",
  AIIB: "A-IIb", A2B: "A-IIb",
  AIIIA: "A-IIIa", A3A: "A-IIIa",
  AIIIB: "A-IIIb", A3B: "A-IIIb",
  AIIIC: "A-IIIc", A3C: "A-IIIc",
};

/** «A-IIIa», «a iii a», «AIIIA», «A3A» → "A-IIIa". Cualquier otra cosa (B-IIb, texto libre) → null. */
export function normalizarCategoria(txt: unknown): CategoriaLicencia | null {
  if (typeof txt !== "string") return null;
  const clave = txt.normalize("NFKC").toUpperCase().replace(/[\s\-_.\/]/g, "");
  return POR_CLAVE[clave] ?? null;
}

/** ¿Una licencia de categoría `tiene` habilita a conducir lo que exige `exige`? */
export function cubreCategoria(tiene: CategoriaLicencia, exige: CategoriaLicencia): boolean {
  return (CUBRE[tiene] ?? []).includes(exige);
}

/** ¿`tiene` (texto como viene de la ficha) cubre ALGUNA de las categorías exigidas?
 *  null = la ficha no trae una categoría reconocible (no se puede juzgar). */
export function cubreAlguna(tiene: unknown, exigidas: readonly CategoriaLicencia[]): boolean | null {
  const t = normalizarCategoria(tiene);
  if (!t) return null;
  return exigidas.some((e) => cubreCategoria(t, e));
}
