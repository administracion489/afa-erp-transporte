// lib/combustibles.ts — Catálogo ÚNICO de tipos de combustible del ERP.
//
// El identificador canónico es el que guarda `combustible.tipo_combustible`: minúsculas y
// sin tilde — diesel | gasolina | glp | gnv | urea | biodiesel. `precios_combustible.tipo`
// usa otra grafía para lo mismo ("Diésel", "GLP", "UREA"): `normalizarTipoCombustible`
// sirve de puente en los dos sentidos, igual que MAPA_TIPO en lib/precios-combustible.ts.
//
// Vive en lib/ y no dentro de app/combustible/page.tsx porque el Radar IA necesita el
// mismo catálogo: el pipeline (lib/radar/acciones.ts) decide con qué tipo registra la
// recarga que leyó de un voucher, y /radar-ia lo muestra y deja corregirlo. Tres copias
// del catálogo serían tres verdades sobre el mismo dato.

export type FuelConfig = {
  label: string;
  unidad: string;
  unidadLabel: string;
  icon: string;
  color: string;
  bg: string;
  /** Precio referencial Perú S/ — respaldo cuando `precios_combustible` no tiene la fila. */
  precioRef: number;
  /** UREA es aditivo, no combustible principal (no entra al km/gal). */
  esAditivo: boolean;
  rendimientoLabel: string;
};

export const COMBUSTIBLES: Record<string, FuelConfig> = {
  diesel:   { label: "Diésel",        unidad: "galones", unidadLabel: "gal", icon: "🛢️",  color: "#1d4ed8", bg: "#dbeafe", precioRef: 16.5, esAditivo: false, rendimientoLabel: "km/gal" },
  gasolina: { label: "Gasolina",      unidad: "galones", unidadLabel: "gal", icon: "⛽",  color: "#dc2626", bg: "#fee2e2", precioRef: 18.0, esAditivo: false, rendimientoLabel: "km/gal" },
  glp:      { label: "GLP",           unidad: "galones", unidadLabel: "gal", icon: "🔵",  color: "#7c3aed", bg: "#ede9fe", precioRef: 7.65, esAditivo: false, rendimientoLabel: "km/gal" },
  gnv:      { label: "GNV",           unidad: "m3",      unidadLabel: "m³",  icon: "💨",  color: "#0f766e", bg: "#f0fdfa", precioRef: 1.78, esAditivo: false, rendimientoLabel: "km/m³"  },
  urea:     { label: "Urea (AdBlue)", unidad: "litros",  unidadLabel: "lt",  icon: "🧪",  color: "#854d0e", bg: "#fef9c3", precioRef: 5.50, esAditivo: true,  rendimientoLabel: "lt/100km"},
  biodiesel:{ label: "Biodiésel",     unidad: "galones", unidadLabel: "gal", icon: "🌿",  color: "#166534", bg: "#dcfce7", precioRef: 15.0, esAditivo: false, rendimientoLabel: "km/gal" },
};

/** Tipos canónicos en el orden en que se ofrecen en pantalla. */
export const TIPOS_COMBUSTIBLE = Object.keys(COMBUSTIBLES);

// ── Normalización ────────────────────────────────────────────────────────────
// Un voucher peruano casi nunca dice "diesel": dice "PETROLEO D2", "DB5 S-50",
// "GASOHOL 90 PLUS", "GLP-G", "GAS NATURAL VEHICULAR". La IA devuelve lo que ve, y
// `precios_combustible` guarda la grafía con tilde. Todo eso entra por aquí.

const SINONIMOS: { tipo: string; patrones: RegExp }[] = [
  // Orden = precedencia. Los más específicos primero: "gas natural" y "gas licuado"
  // comparten la palabra "gas", así que un genérico "gas" a secas NO resuelve nada.
  { tipo: "urea",      patrones: /\b(urea|adblue|ad\s*blue|def)\b/ },
  { tipo: "biodiesel", patrones: /\b(biodiesel|bio\s*diesel|b100|b20)\b/ },
  { tipo: "gnv",       patrones: /\b(gnv|ngv|cng|gas\s*natural)\b/ },
  { tipo: "glp",       patrones: /\b(glp|glpg|autogas|gas\s*licuado)\b/ },
  { tipo: "gasolina",  patrones: /\b(gasolina|gasohol|g\s*(84|90|95|97|98)|(84|90|95|97|98)\s*octanos?)\b/ },
  { tipo: "diesel",    patrones: /\b(diesel|petroleo|d\s*2|db5|b5|s\s*50)\b/ },
];

const sinTildes = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[_/|-]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Tipo canónico de un texto libre ("PETRÓLEO D2", "Diésel", "GLP-G", "gasohol 90"), o
 * `null` si no se puede decidir. **Nunca adivina diésel**: un null es "no se sabe", y
 * quien llama decide qué hacer con eso (pedirlo, deducirlo o mandar a revisión).
 */
export function normalizarTipoCombustible(v: unknown): string | null {
  const t = sinTildes(String(v ?? ""));
  if (!t) return null;
  if (COMBUSTIBLES[t]) return t;                       // ya es canónico
  if (/^(84|90|95|97|98)$/.test(t)) return "gasolina"; // octanaje suelto
  for (const { tipo, patrones } of SINONIMOS) if (patrones.test(t)) return tipo;
  return null;
}

/** Etiqueta legible de un tipo, o el texto crudo si no está en el catálogo. */
export function etiquetaCombustible(tipo: string | null | undefined): string {
  if (!tipo) return "—";
  return COMBUSTIBLES[normalizarTipoCombustible(tipo) ?? ""]?.label ?? String(tipo);
}

// ── Deducción por PRECIO ─────────────────────────────────────────────────────
// El precio unitario es evidencia de la propia transacción, y en Perú los tipos están
// muy separados (GLP ~S/ 7.6, diésel ~S/ 16.5, GNV ~S/ 1.8/m³): un voucher a S/ 7.55/gal
// no es diésel por más que nadie haya escrito "GLP" en la foto.

export type CandidatoPrecio = { tipo: string; referencia: number; desvio: number };

/**
 * Referencias de precio por tipo canónico. Se arma con `precios_combustible` (lo que el
 * operador mantiene en /configuracion/costos) y se rellenan con `precioRef` los tipos que
 * esa tabla no tenga, para que la deducción no dependa de que estén las 6 filas.
 */
export function referenciasDePrecio(filas: { tipo?: string | null; precio?: unknown }[] | null | undefined): Record<string, number> {
  const refs: Record<string, number> = {};
  for (const [tipo, cfg] of Object.entries(COMBUSTIBLES)) refs[tipo] = cfg.precioRef;
  for (const f of filas ?? []) {
    const tipo = normalizarTipoCombustible(f?.tipo);
    const precio = Number(f?.precio);
    if (tipo && Number.isFinite(precio) && precio > 0) refs[tipo] = precio;
  }
  return refs;
}

/**
 * Tipos cuyo precio de referencia está a menos de `tolerancia` del precio pagado,
 * del más cercano al más lejano. Un solo candidato = deducción; varios = ambigüedad
 * (no se elige), ninguno = precio raro (que es en sí una señal).
 *
 * ALCANCE REAL, medido en scripts/prueba-combustible-tipo.mts: esto separa los gases
 * (GLP ~7.65, GNV ~1.78) de los líquidos, que es el caso de AFA — las unidades con kit
 * GLP. Entre diésel (16.5), biodiésel (15.0) y gasolina (18.0) las referencias están
 * demasiado juntas para decidir, y ahí devuelve varios candidatos a propósito: quien
 * llama debe caer al siguiente escalón (la ficha de la unidad), no elegir el primero.
 */
export function candidatosPorPrecio(
  precio: number | null | undefined,
  refs: Record<string, number>,
  tolerancia = 0.1
): CandidatoPrecio[] {
  const p = Number(precio);
  if (!Number.isFinite(p) || p <= 0) return [];
  return Object.entries(refs)
    .filter(([, ref]) => Number(ref) > 0)
    .map(([tipo, ref]) => ({ tipo, referencia: Number(ref), desvio: Math.abs(p - Number(ref)) / Number(ref) }))
    .filter((c) => c.desvio <= tolerancia)
    .sort((a, b) => a.desvio - b.desvio);
}

/** Desvío relativo del precio pagado contra la referencia de un tipo (null si no hay). */
export function desvioDePrecio(precio: number | null | undefined, tipo: string | null, refs: Record<string, number>): number | null {
  const p = Number(precio);
  const ref = tipo ? Number(refs[tipo]) : NaN;
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(ref) || ref <= 0) return null;
  return Math.abs(p - ref) / ref;
}

// ── Capacidad de tanque ──────────────────────────────────────────────────────
// Heurística por categoría de unidad, siempre por debajo de lo que el operador haya
// configurado en `vehiculos.capacidad_tanque` (jsonb { diesel: 80, glp: 25, … }): un bus
// convertido a GLP carga ~25 gal de GLP, no los 80 que supone la heurística del bus.

export const CAPACIDAD_TANQUE: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};

export function getCapacidad(
  vehOCat: string | { categoria?: string | null; capacidad_tanque?: Record<string, number> | null } | null | undefined,
  tipo: string
): number {
  // La capacidad EDITABLE por vehículo tiene prioridad sobre la heurística.
  if (vehOCat && typeof vehOCat === "object") {
    const edit = vehOCat.capacidad_tanque?.[tipo];
    if (edit != null && Number(edit) > 0) return Number(edit);
  }
  const categoria = typeof vehOCat === "string" ? vehOCat : vehOCat?.categoria ?? undefined;
  if (!categoria) return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
  const cat = categoria.toUpperCase();
  for (const [k, v] of Object.entries(CAPACIDAD_TANQUE)) {
    if (cat.includes(k)) return v[tipo] || v.diesel || 80;
  }
  return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
}
