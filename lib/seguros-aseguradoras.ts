// ═══════════════════════════════════════════════════════════════════════════
// lib/seguros-aseguradoras.ts · De dónde sale la lista de ASEGURADORAS (PURO)
//
// La aseguradora de una póliza se guarda como TEXTO en seguros.aseguradora (no
// hay FK, y no hace falta migración). La lista que ofrece /seguros es la UNIÓN de:
//   1. las de mercado que vienen de fábrica (BASE),
//   2. los proveedores con tipo «seguros» (/proveedores → Seguros / broker),
//   3. las que ya se escribieron en alguna póliza.
// Así, registrar «Sanitas» una vez —escribiéndola o dándola de alta en
// Proveedores— la deja ofrecida para siempre, sin tocar código.
//
// Dos redacciones de la misma empresa («SANITAS», «Sanitas Perú S.A.») son UNA
// opción: se compara sin tildes, sin mayúsculas y sin la forma societaria, y gana
// el nombre del proveedor (es el que alguien dio de alta a propósito).
// ═══════════════════════════════════════════════════════════════════════════

export const ASEGURADORAS_BASE = [
  "Rimac Seguros", "Pacífico Seguros", "La Positiva Seguros",
  "Mapfre Perú", "Interseguro", "Protecta Security",
  "Chubb Perú", "Zurich Seguros", "BNP Paribas Cardif",
  "Sanitas Perú", "AFOCAT (regional)",
] as const;

/** Valor centinela del desplegable: «escribir otra». Nunca se guarda. */
export const OTRA_ASEGURADORA = "__otra__";

export type OrigenAseguradora = "proveedor" | "usada" | "base";
export type OpcionAseguradora = { nombre: string; origen: OrigenAseguradora; proveedorId: number | null };

const FORMAS = /\b(s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?\s?a\.?|s\.?\s?a\.?|e\.?\s?p\.?\s?s\.?|compa[nñ]ia de seguros( y reaseguros)?|seguros?|per[uú])\b/g;

/** Clave de identidad de una aseguradora: sin tildes, mayúsculas, puntuación ni forma societaria. */
export function claveAseguradora(nombre: string | null | undefined): string {
  const base = String(nombre ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sin = base.replace(FORMAS, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // «Seguros» o «Perú» solos no identifican a nadie: se conserva el texto completo.
  return sin || base.replace(/[^a-z0-9]/g, "");
}

/** Texto que la persona escribió: espacios colapsados. «Otra» a secas no es un nombre. */
export function limpiarNombreAseguradora(t: string | null | undefined): string | null {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!s || /^otra$/i.test(s)) return null;
  return s.slice(0, 120);
}

export function opcionesAseguradora(
  proveedores: { id: number; nombre: string | null; tipo?: string | null }[],
  usadas: (string | null | undefined)[],
): OpcionAseguradora[] {
  const porClave = new Map<string, OpcionAseguradora>();
  const poner = (nombre: string | null | undefined, origen: OrigenAseguradora, proveedorId: number | null) => {
    const n = limpiarNombreAseguradora(nombre);
    if (!n) return;
    const k = claveAseguradora(n);
    if (!k || porClave.has(k)) return;
    porClave.set(k, { nombre: n, origen, proveedorId });
  };
  for (const p of proveedores) if (p.tipo === "seguros") poner(p.nombre, "proveedor", p.id);
  for (const u of usadas) poner(u, "usada", null);
  for (const b of ASEGURADORAS_BASE) poner(b, "base", null);
  return [...porClave.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** La opción que ya representa a este nombre (por clave), o null si es nuevo. */
export function aseguradoraConocida(nombre: string, opciones: OpcionAseguradora[]): OpcionAseguradora | null {
  const k = claveAseguradora(nombre);
  return opciones.find((o) => claveAseguradora(o.nombre) === k) ?? null;
}
