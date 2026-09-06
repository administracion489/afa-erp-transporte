// lib/combustible-tipos.ts — El catálogo de tipos de combustible, en UN solo sitio.
//
// Vivía dentro de `app/combustible/page.tsx` como una const privada, así que ninguna otra
// pantalla podía nombrar un combustible con la misma etiqueta ni el mismo color. `/radar-ia`
// necesitaba justamente eso para su columna nueva, y copiarlo habría sido la tercera copia de
// una tabla de este módulo (`CAPACIDAD_TANQUE` ya está duplicada entre esa página y
// `lib/radar/acciones.ts`, con el comentario que lo confiesa).
//
// DOS COSAS QUE NO SON LO MISMO, y por eso hay `familia` además del tipo:
//   · el TIPO es el producto que se compró y es lo que se guarda y se muestra
//     (`gasolina_premium`);
//   · la FAMILIA es con qué se compara (`gasolina`): la capacidad del tanque, el precio
//     referencial y el rendimiento son de la familia, no del octanaje.
//
// `gasolina` a secas se conserva como LEGADO: son las filas que ya existen en `combustible` con
// ese valor. Quitarla las dejaría cayendo al fallback (diésel) y el histórico mentiría.

export type ConfigCombustible = {
  label: string;
  /** Para chips y columnas estrechas ("G. Premium"). */
  labelCorto: string;
  unidad: "galones" | "litros" | "m3";
  unidadLabel: string;
  icon: string;
  color: string;
  bg: string;
  precioRef: number;
  esAditivo: boolean;
  rendimientoLabel: string;
  /** Con qué se compara: capacidad de tanque, precio referencial, rendimiento. */
  familia: "diesel" | "gasolina" | "glp" | "gnv" | "urea" | "biodiesel";
  /** Valor histórico que sigue en la base pero ya no se propone de primera. */
  legado?: boolean;
};

export const COMBUSTIBLES: Record<string, ConfigCombustible> = {
  diesel:            { label: "Diésel",            labelCorto: "Diésel",      unidad: "galones", unidadLabel: "gal", icon: "🛢️", color: "#1d4ed8", bg: "#dbeafe", precioRef: 16.5, esAditivo: false, rendimientoLabel: "km/gal",  familia: "diesel" },
  glp:               { label: "GLP",               labelCorto: "GLP",         unidad: "galones", unidadLabel: "gal", icon: "🔵", color: "#7c3aed", bg: "#ede9fe", precioRef: 7.65, esAditivo: false, rendimientoLabel: "km/gal",  familia: "glp" },
  gnv:               { label: "GNV",               labelCorto: "GNV",         unidad: "m3",      unidadLabel: "m³",  icon: "💨", color: "#0f766e", bg: "#f0fdfa", precioRef: 1.78, esAditivo: false, rendimientoLabel: "km/m³",   familia: "gnv" },
  gasolina_regular:  { label: "Gasolina regular",  labelCorto: "G. Regular",  unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#dc2626", bg: "#fee2e2", precioRef: 17.0, esAditivo: false, rendimientoLabel: "km/gal",  familia: "gasolina" },
  gasolina_premium:  { label: "Gasolina premium",  labelCorto: "G. Premium",  unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#b91c1c", bg: "#fee2e2", precioRef: 19.5, esAditivo: false, rendimientoLabel: "km/gal",  familia: "gasolina" },
  urea:              { label: "Urea (AdBlue)",     labelCorto: "Urea",        unidad: "litros",  unidadLabel: "lt",  icon: "🧪", color: "#854d0e", bg: "#fef9c3", precioRef: 5.50, esAditivo: true,  rendimientoLabel: "lt/100km", familia: "urea" },
  biodiesel:         { label: "Biodiésel",         labelCorto: "Biodiésel",   unidad: "galones", unidadLabel: "gal", icon: "🌿", color: "#166534", bg: "#dcfce7", precioRef: 15.0, esAditivo: false, rendimientoLabel: "km/gal",  familia: "biodiesel" },
  // Legado: las filas que ya están guardadas como "gasolina" sin grado. Se sigue pintando
  // igual; solo deja de ofrecerse cuando hay que ELEGIR uno (ver TIPOS_PARA_ELEGIR).
  gasolina:          { label: "Gasolina",          labelCorto: "Gasolina",    unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#dc2626", bg: "#fee2e2", precioRef: 18.0, esAditivo: false, rendimientoLabel: "km/gal",  familia: "gasolina", legado: true },
};

/**
 * Litros por galón (US), para convertir una cantidad a la unidad de su familia.
 *
 * Vive aquí porque este catálogo es el dueño de `unidad` por tipo. Hace falta porque el
 * Radar guarda LITROS en la columna `combustible.galones` con `unidad: "litros"`
 * (lib/radar/acciones.ts) y quien calcula rendimiento tiene que mirarlo: sin convertir, un
 * diésel cargado en litros da un km/gal inflado ×3.785. La plata de esas filas está bien
 * (`total` = litros × precio/litro); lo único que hay que normalizar es la cantidad.
 *
 * El literal equivalente de lib/costeo-propio.ts NO se sustituye por éste: ese módulo está
 * congelado y scripts/prueba-costeo.mts lo compara al sexto decimal contra una copia literal.
 */
export const LITROS_POR_GALON = 3.785;

/** Todos los tipos, incluido el legado (para pintar cualquier fila guardada). */
export const TIPOS_COMBUSTIBLE = Object.keys(COMBUSTIBLES);

/** Los que se ofrecen al ELEGIR uno: sin los de legado, que ya no se deben escribir. */
export const TIPOS_PARA_ELEGIR = TIPOS_COMBUSTIBLE.filter((t) => !COMBUSTIBLES[t].legado);

/** Config de un tipo, con el diésel como respaldo (es el 90 % de la flota). */
export function configCombustible(tipo?: string | null): ConfigCombustible {
  const t = String(tipo ?? "").trim().toLowerCase();
  return COMBUSTIBLES[t] ?? COMBUSTIBLES.diesel;
}

/** La familia de un tipo: con qué comparar tanque, precio y rendimiento. */
export function familiaCombustible(tipo?: string | null): string {
  return configCombustible(tipo).familia;
}

// ── Normalización de lo que imprime un voucher ───────────────────────────────

/**
 * De la DESCRIPCIÓN DEL PRODUCTO de un voucher al tipo del catálogo. Devuelve null cuando no
 * hay señal: sin dato es mejor un hueco que un diésel inventado.
 *
 * **EL TIPO SALE DEL PRODUCTO, NUNCA DEL CÓDIGO DE UNIDAD.** En la nota de COESTI la línea es
 * `040002019 UGL 8.799x 24.640` seguida de `MAX-D DIESEL B5 S50 UV`: ahí `UGL` es la UNIDAD
 * (galones) de una venta de DIÉSEL. El prompt del Radar llegó a decir que "UGL" significaba
 * GLP, lo que convertía en GLP cada voucher de diésel de ese grifo.
 *
 * Octanaje peruano: 84 y 90 son regular, 95/97/98 son premium. Los grifos las venden como
 * "Gasohol 90", "G-95", "Primax 97" — el número es la señal fiable, la palabra comercial no.
 */
export function normalizarTipoCombustible(texto?: string | null): string | null {
  const t = String(texto ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!t.trim()) return null;

  // Aditivo primero: "UREA" puede aparecer junto al nombre del diésel en la misma boleta.
  if (/\b(UREA|ADBLUE|AD BLUE|DEF)\b/.test(t)) return "urea";
  if (/\b(GNV|GAS NATURAL)\b/.test(t)) return "gnv";
  // GLP: el producto, no la unidad. "UGL"/"U.GAL"/"GLN" son unidades y NO cuentan.
  if (/\b(GLP|GAS LICUADO|PROPANO)\b/.test(t)) return "glp";
  if (/\bBIODIESEL\b/.test(t)) return "biodiesel";
  // Diésel peruano: "MAX-D", "DB5", "B5 S50", "DIESEL", "PETROLEO".
  if (/\b(DIESEL|MAX ?-? ?D|DB5|B5|S50|PETROLEO)\b/.test(t)) return "diesel";

  if (/\b(GASOHOL|GASOLINA|GASOL)\b/.test(t) || /\bG ?-? ?(84|90|95|97|98)\b/.test(t)) {
    const octano = /\b(84|90|95|97|98)\b/.exec(t);
    if (octano) return Number(octano[1]) >= 95 ? "gasolina_premium" : "gasolina_regular";
    if (/\b(PREMIUM|SUPER|SUPREMO)\b/.test(t)) return "gasolina_premium";
    if (/\bREGULAR\b/.test(t)) return "gasolina_regular";
    return "gasolina"; // gasolina sin grado legible: el legado, no se inventa el octanaje
  }
  if (/\b(PREMIUM|SUPER)\b/.test(t)) return "gasolina_premium";
  return null;
}
