// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-moneda.ts — Cotizar en dólares sin mover la fila autoritativa. Motor PURO.
//
// LOS IMPORTES DE LA COTIZACIÓN SIGUEN SIEMPRE EN SOLES. `precio_cliente`, `precio_dia`,
// `items_json[].precio_unit`, `costo_estimado` y `margen_estimado` son la fila autoritativa y
// los leen reservas, el generador de programas, el tarifario, facturación, el CRM, ELIA y la
// liquidación. Ninguno de ellos cambia de semántica: el dólar es PRESENTACIÓN, y se deriva
//
//     USD = PEN ÷ tipo_cambio      (tipo_cambio = soles por dólar, congelado en la cotización)
//
// Por eso este módulo tiene dos direcciones y redondea distinto en cada una:
//   · soles → moneda de la cotización: a 2 decimales (lo que se imprime y se teclea);
//   · moneda de la cotización → soles: a 4 decimales (lo que se guarda), para que el ida y
//     vuelta «US$ tecleado → S/ guardado → US$ mostrado» devuelva EXACTO lo tecleado.
//
// Con PEN todo es la identidad, byte a byte: ni un redondeo nuevo sobre lo que ya existía.
// ──────────────────────────────────────────────────────────────────────────────

export type Moneda = "PEN" | "USD";
export const MONEDAS: Moneda[] = ["PEN", "USD"];

/** Un valor desconocido —o ausente, sin la migración— es PEN: lo que la cotización siempre fue. */
export function normalizarMoneda(v: unknown): Moneda {
  return String(v ?? "").trim().toUpperCase() === "USD" ? "USD" : "PEN";
}

export const SIMBOLO_MONEDA: Record<Moneda, string> = { PEN: "S/", USD: "US$" };
export const simboloMoneda = (m: Moneda): string => SIMBOLO_MONEDA[normalizarMoneda(m)];

/**
 * La banda en que un tipo de cambio puede ser soles por dólar. NO ESTÁ MEDIDA y se declara: es
 * ancha a propósito (el sol rondó 2.7–4.1 en veinte años) y existe para atrapar lo que no es un
 * tipo de cambio — un 375 sin punto, un 0.27 escrito al revés (dólares por sol).
 */
export const TC_MIN = 2.5;
export const TC_MAX = 6;

export type CodigoTc = "ok" | "falta_tc" | "tc_no_numero" | "tc_fuera_de_rango";

export type RevisionTc = { tc: number | null; codigo: CodigoTc; detalle: string };

/** Lee el tipo de cambio tecleado. Acepta coma decimal. Solo `ok` trae número. */
export function revisarTipoCambio(v: unknown): RevisionTc {
  if (v == null || String(v).trim() === "") {
    return { tc: null, codigo: "falta_tc", detalle: "Falta el tipo de cambio (soles por dólar). Sin él no se puede cotizar en dólares." };
  }
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n)) {
    return { tc: null, codigo: "tc_no_numero", detalle: `«${String(v)}» no es un tipo de cambio: escribe los soles que vale un dólar, por ejemplo 3.75.` };
  }
  if (n < TC_MIN || n > TC_MAX) {
    return {
      tc: null, codigo: "tc_fuera_de_rango",
      detalle: `${n} no parece un tipo de cambio de soles por dólar (se espera entre ${TC_MIN} y ${TC_MAX}). Revisa que no falte el punto decimal ni esté escrito al revés.`,
    };
  }
  return { tc: Math.round(n * 10000) / 10000, codigo: "ok", detalle: "" };
}

/** El tipo de cambio utilizable, o null. Con PEN no hace falta ninguno (se devuelve 1). */
export function tcEfectivo(m: Moneda, tc: unknown): number | null {
  if (normalizarMoneda(m) === "PEN") return 1;
  return revisarTipoCambio(tc).tc;
}

const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const r4 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 10000) / 10000;

/**
 * Un importe en soles, en la moneda de la cotización. Con PEN es el MISMO número (sin redondeo).
 * Con USD sin un tipo de cambio válido devuelve null: imprimir soles rotulados como dólares es
 * el error caro, así que no hay respaldo.
 */
export function aMonedaCot(pen: number, m: Moneda, tc: unknown): number | null {
  if (normalizarMoneda(m) === "PEN") return pen;
  const t = tcEfectivo("USD", tc);
  if (t == null) return null;
  return r2(Number(pen) / t);
}

/** Un importe en la moneda de la cotización, en soles (lo que se GUARDA). PEN: el mismo número. */
export function aPENdesdeCot(monto: number, m: Moneda, tc: unknown): number | null {
  if (normalizarMoneda(m) === "PEN") return monto;
  const t = tcEfectivo("USD", tc);
  if (t == null) return null;
  return r4(Number(monto) * t);
}

/** Lo mínimo de un ítem que mueve dinero. Los demás campos viajan intactos. */
export type ItemMonto = { dias: number; cantidad: number; precio_unit: number; descuento_pct: number };

/** Los ítems (en soles) con el precio unitario en la moneda de la cotización. null = USD sin TC. */
export function itemsEnMoneda<T extends ItemMonto>(itemsPEN: T[], m: Moneda, tc: unknown): T[] | null {
  if (normalizarMoneda(m) === "PEN") return itemsPEN;
  const out: T[] = [];
  for (const it of itemsPEN) {
    const u = aMonedaCot(it.precio_unit, m, tc);
    if (u == null) return null;
    out.push({ ...it, precio_unit: u });
  }
  return out;
}

/** Los ítems tecleados en la moneda de la cotización, llevados a soles para guardar. */
export function itemsAPEN<T extends ItemMonto>(itemsCot: T[], m: Moneda, tc: unknown): T[] | null {
  if (normalizarMoneda(m) === "PEN") return itemsCot;
  const out: T[] = [];
  for (const it of itemsCot) {
    const p = aPENdesdeCot(it.precio_unit, m, tc);
    if (p == null) return null;
    out.push({ ...it, precio_unit: p });
  }
  return out;
}

export type TotalesMoneda = {
  moneda: Moneda;
  /** Precio unitario de cada ítem, en la moneda de la cotización. */
  unitarios: number[];
  /** Importe de cada línea (días × cantidad × unitario × (1 − dscto)). */
  lineas: number[];
  subtotal: number;
  igv: number;
  total: number;
  /** Lo que se descontó, sumado (el corporativo lo imprime aparte). */
  descuento: number;
};

/**
 * Los totales de la cotización en su moneda.
 *
 * PEN: EXACTAMENTE el `calcItems` de siempre (sin redondear, `total = s × 1.18`), porque eso es lo
 * que ya imprimían los PDF y se compara byte a byte.
 *
 * USD: se calcula DESDE LOS UNITARIOS YA CONVERTIDOS y cada línea se redondea a céntimos, para que
 * el papel cuadre a la vista — unitario × cantidad = línea, Σ líneas = subtotal, subtotal + IGV =
 * total. Convertir el total en soles daría un número que ninguna suma del documento reproduce.
 */
export function totalesEnMoneda(itemsPEN: ItemMonto[], m: Moneda, tc: unknown, conIGV = true): TotalesMoneda | null {
  const mon = normalizarMoneda(m);
  if (mon === "PEN") {
    const lineas = itemsPEN.map(it => it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100));
    const s = itemsPEN.reduce((t, it) => t + it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100), 0);
    const descuento = itemsPEN.reduce((t, it) => t + it.dias * it.cantidad * it.precio_unit * (it.descuento_pct / 100), 0);
    return {
      moneda: "PEN", unitarios: itemsPEN.map(it => it.precio_unit), lineas,
      subtotal: s, igv: conIGV ? s * 0.18 : 0, total: conIGV ? s * 1.18 : s, descuento,
    };
  }
  const conv = itemsEnMoneda(itemsPEN, "USD", tc);
  if (!conv) return null;
  const lineas = conv.map(it => r2(it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100)));
  const subtotal = r2(lineas.reduce((a, b) => a + b, 0));
  const igv = conIGV ? r2(subtotal * 0.18) : 0;
  const descuento = r2(conv.reduce((t, it) => t + it.dias * it.cantidad * it.precio_unit * (it.descuento_pct / 100), 0));
  return { moneda: "USD", unitarios: conv.map(it => it.precio_unit), lineas, subtotal, igv, total: r2(subtotal + igv), descuento };
}

export type EstadoMoneda = {
  moneda: Moneda;
  tipoCambio: unknown;
  /** Los ítems en SOLES (la fila autoritativa). */
  itemsPEN: ItemMonto[];
  precioDiaPEN?: number | null;
};

export type CodigoCambioMoneda = "sin_cambio" | "a_soles" | "a_dolares" | "a_dolares_sin_tc";

/**
 * Cambiar la moneda de la cotización NO reinterpreta ningún número: los soles se conservan y
 * lo único que cambia es cómo se ENSEÑAN. Un `S/ 1 000` no pasa a ser `US$ 1 000`.
 */
export function planCambioMoneda<E extends EstadoMoneda>(estado: E, monedaNueva: Moneda): E & { codigo: CodigoCambioMoneda; detalle: string } {
  const nueva = normalizarMoneda(monedaNueva);
  const actual = normalizarMoneda(estado.moneda);
  const base = { ...estado, moneda: nueva, itemsPEN: estado.itemsPEN, precioDiaPEN: estado.precioDiaPEN };
  if (nueva === actual) return { ...base, codigo: "sin_cambio", detalle: "" };
  if (nueva === "PEN") return { ...base, codigo: "a_soles", detalle: "Los importes se conservan: se enseñan en soles, que es como están guardados." };
  if (revisarTipoCambio(estado.tipoCambio).codigo !== "ok") {
    return { ...base, codigo: "a_dolares_sin_tc", detalle: "Escribe el tipo de cambio para ver los importes en dólares. Los soles no cambian." };
  }
  return { ...base, codigo: "a_dolares", detalle: "Los importes se conservan en soles y se enseñan en dólares al tipo de cambio de la cotización." };
}

/**
 * Cambiar el TIPO DE CAMBIO de una cotización en dólares conserva los dólares TECLEADOS (lo que
 * el cliente ve) y recalcula los soles. Devuelve los ítems en soles, o null si el TC no vale.
 */
export function planCambioTipoCambio<T extends ItemMonto>(itemsEnPantalla: T[], m: Moneda, tcNuevo: unknown): T[] | null {
  return itemsAPEN(itemsEnPantalla, m, tcNuevo);
}

export type FuenteTc = "tabla_tipo_cambio" | "ultima_cotizacion_usd" | "sin_fuente";

export type SugerenciaTc = { tc: number | null; fuente: FuenteTc; detalle: string };

/**
 * El tipo de cambio que se PROPONE en una cotización nueva en dólares. Ningún número en el
 * código: la venta del día en `tipo_cambio` (fecha ≤ hoy), si no el de la última cotización en
 * dólares, y si no, vacío. Lo propuesto lo confirma una persona.
 */
export function sugerirTipoCambio(x: {
  filaTabla?: { venta: unknown; fecha?: string | null } | null;
  ultimaCotUsd?: { tipo_cambio: unknown; numero_cotizacion?: string | null; created_at?: string | null } | null;
}): SugerenciaTc {
  const t = x.filaTabla ? revisarTipoCambio(x.filaTabla.venta) : null;
  if (t?.codigo === "ok") {
    return { tc: t.tc, fuente: "tabla_tipo_cambio", detalle: `Venta del ${x.filaTabla?.fecha ?? "último día registrado"} (tabla de tipo de cambio).` };
  }
  const c = x.ultimaCotUsd ? revisarTipoCambio(x.ultimaCotUsd.tipo_cambio) : null;
  if (c?.codigo === "ok") {
    const n = x.ultimaCotUsd?.numero_cotizacion;
    return { tc: c.tc, fuente: "ultima_cotizacion_usd", detalle: `El de la última cotización en dólares${n ? ` (${n})` : ""}.` };
  }
  return { tc: null, fuente: "sin_fuente", detalle: "No hay un tipo de cambio registrado: escríbelo." };
}
