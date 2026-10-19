// components/tarifario/traslados-datos.ts — SOLO NAVEGADOR.
// Lo que lee y escribe la pantalla «Zonas y traslados» con el cliente de lib/supabase.ts (las
// cuatro tablas tienen RLS `to authenticated`). No decide nada: lo que significa cada fila lo
// dice lib/traslados/motor.ts.
//
// Por qué no usa `cargarCatalogo` (lib/traslados/datos.ts): aquel lee lo que necesita el MOTOR y
// esta pantalla edita además las notas de cada zona. Las dos lecturas piden las mismas tablas,
// paginadas con orden estable, y las dos distinguen «falta la tabla» de «falló la lectura».

import { supabase } from "@/lib/supabase";
import { tablaQueFalta, faltaAlguna, type ErrorSupabase } from "@/lib/columna-faltante";
import type { Moneda } from "@/lib/traslados/motor";
import type { CategoriaFila, TarifaFila, ZonaFila } from "./traslados-pantalla";

export type ConfigFila = {
  validez_dias: number;
  espera_gratis_min: number;
  consideraciones: string[];
  consideraciones_usd: string[];
  /** traslados-05: la IA del CRM cotiza traslados. Sin la migración, false. */
  ia_cotiza: boolean;
  /** traslados-05: maestro del envío SIN revisión. Sin la migración, false. */
  envio_automatico: boolean;
};

export const CONFIG_VACIA: ConfigFila = {
  validez_dias: 30, espera_gratis_min: 30, consideraciones: [], consideraciones_usd: [], ia_cotiza: false, envio_automatico: false,
};

/**
 * `sinMigracionIA`: falta alguna columna de traslados-05 (los tres interruptores). La pantalla
 * funciona igual, lee los tres como apagados y lo dice nombrando el SQL. `colsZona` son las
 * columnas que se pueden pedir de vuelta tras escribir una zona: con la columna ausente, pedirla
 * haría fallar la escritura entera.
 */
export type CargaTraslados =
  | {
    tipo: "ok"; zonas: ZonaFila[]; categorias: CategoriaFila[]; tarifas: TarifaFila[]; config: ConfigFila; configExiste: boolean;
    sinMigracionIA: boolean; colsZona: string; colsConfig: string;
  }
  | { tipo: "sin_tablas"; tabla: string }
  | { tipo: "error"; detalle: string };

export const COLS_ZONA = "id, nombre, tipo, padre_id, sector, alias, lat, lng, radio_m, orden, activo, notas";
/** Con la columna de traslados-05. */
export const COLS_ZONA_IA = `${COLS_ZONA}, envio_automatico`;
export const COLS_CONFIG = "id, validez_dias, espera_gratis_min, consideraciones, consideraciones_usd";
export const COLS_CONFIG_IA = `${COLS_CONFIG}, ia_cotiza, envio_automatico`;
export const COLS_TARIFA = "id, zona_a_id, zona_b_id, categoria, moneda, precio_tramo, activo, notas";
export const COLS_CATEGORIA = "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo, orden, activo";
const PAG = 1000;

type Lectura<T> = { filas: T[]; error: null } | { filas: null; error: ErrorSupabase };

/** Todas las filas, por páginas de 1000 con orden estable: PostgREST corta en 1000 sin avisar. */
async function todas<T>(tabla: string, cols: string, orden: string): Promise<Lectura<T>> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    const { data, error } = await supabase.from(tabla).select(cols).order(orden, { ascending: true }).range(desde, desde + PAG - 1);
    if (error) return { filas: null, error };
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAG) return { filas: out, error: null };
  }
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function normalizarZona(z: Record<string, unknown>): ZonaFila {
  return {
    id: Number(z.id),
    nombre: String(z.nombre ?? ""),
    tipo: (z.tipo === "subzona" || z.tipo === "punto" ? z.tipo : "distrito") as ZonaFila["tipo"],
    padre_id: z.padre_id == null ? null : Number(z.padre_id),
    sector: z.sector == null ? null : String(z.sector),
    alias: Array.isArray(z.alias) ? (z.alias as unknown[]).map(String) : [],
    lat: num(z.lat),
    lng: num(z.lng),
    radio_m: num(z.radio_m),
    orden: num(z.orden) ?? 0,
    activo: z.activo !== false,
    notas: z.notas == null ? null : String(z.notas),
    // Solo `true` cuenta: sin la migración la columna no viene y eso es «no».
    envio_automatico: z.envio_automatico === true,
  };
}

export function normalizarTarifa(t: Record<string, unknown>): TarifaFila {
  return {
    id: Number(t.id),
    zona_a_id: Number(t.zona_a_id),
    zona_b_id: Number(t.zona_b_id),
    categoria: String(t.categoria ?? ""),
    moneda: (t.moneda === "USD" ? "USD" : "PEN") as Moneda,
    precio_tramo: Number(t.precio_tramo),
    activo: t.activo !== false,
    notas: t.notas == null ? null : String(t.notas),
  };
}

export function normalizarCategoria(c: Record<string, unknown>): CategoriaFila {
  return {
    clave: String(c.clave ?? ""),
    nombre: String(c.nombre ?? ""),
    capacidad: Number(c.capacidad) || 0,
    maletas_bodega: Number(c.maletas_bodega) || 0,
    tipo_vehiculo: c.tipo_vehiculo == null ? null : String(c.tipo_vehiculo),
    orden: num(c.orden) ?? 0,
    activo: c.activo !== false,
  };
}

export function normalizarConfig(c: Record<string, unknown> | null | undefined): ConfigFila {
  if (!c) return { ...CONFIG_VACIA };
  const lista = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    validez_dias: Number(c.validez_dias) > 0 ? Number(c.validez_dias) : CONFIG_VACIA.validez_dias,
    espera_gratis_min: c.espera_gratis_min == null ? CONFIG_VACIA.espera_gratis_min : Number(c.espera_gratis_min),
    consideraciones: lista(c.consideraciones),
    consideraciones_usd: lista(c.consideraciones_usd),
    ia_cotiza: c.ia_cotiza === true,
    envio_automatico: c.envio_automatico === true,
  };
}

/** Lee con las columnas de traslados-05 y, si el error NOMBRA una de ellas, vuelve a leer sin ellas. */
async function conRespaldo<T extends { error: ErrorSupabase }>(
  conIA: () => PromiseLike<T>, sinIA: () => PromiseLike<T>, columnas: readonly string[],
): Promise<{ r: T; falta: boolean }> {
  const r = await conIA();
  if (r.error && faltaAlguna(r.error, columnas)) return { r: await sinIA(), falta: true };
  return { r, falta: false };
}

async function leerConfig(cols: string): Promise<{ data: Record<string, unknown> | null; error: ErrorSupabase }> {
  const { data, error } = await supabase.from("traslados_config").select(cols).eq("id", 1).maybeSingle();
  return { data: (data as Record<string, unknown> | null) ?? null, error };
}

export async function cargarTraslados(): Promise<CargaTraslados> {
  try {
    const [zr, c, t, cfgr] = await Promise.all([
      conRespaldo(
        () => todas<Record<string, unknown>>("zonas_traslado", COLS_ZONA_IA, "id"),
        () => todas<Record<string, unknown>>("zonas_traslado", COLS_ZONA, "id"),
        ["envio_automatico"]),
      todas<Record<string, unknown>>("traslado_categorias", COLS_CATEGORIA, "clave"),
      todas<Record<string, unknown>>("tarifas_traslado", COLS_TARIFA, "id"),
      conRespaldo(() => leerConfig(COLS_CONFIG_IA), () => leerConfig(COLS_CONFIG), ["ia_cotiza", "envio_automatico"]),
    ]);
    const z = zr.r;
    const cfg = cfgr.r;
    const errores: [string, ErrorSupabase][] = [
      ["zonas_traslado", z.error], ["traslado_categorias", c.error], ["tarifas_traslado", t.error], ["traslados_config", cfg.error],
    ];
    for (const [tabla, e] of errores) {
      if (e && tablaQueFalta(e) != null) return { tipo: "sin_tablas", tabla: tablaQueFalta(e) || tabla };
    }
    const fallo = errores.find(([, e]) => e);
    if (fallo) return { tipo: "error", detalle: `No se pudo leer ${fallo[0]}: ${fallo[1]?.message ?? "error desconocido"}` };
    return {
      tipo: "ok",
      zonas: (z.filas ?? []).map(normalizarZona),
      categorias: (c.filas ?? []).map(normalizarCategoria),
      tarifas: (t.filas ?? []).map(normalizarTarifa),
      config: normalizarConfig(cfg.data),
      configExiste: !!cfg.data,
      sinMigracionIA: zr.falta || cfgr.falta,
      colsZona: zr.falta ? COLS_ZONA : COLS_ZONA_IA,
      colsConfig: cfgr.falta ? COLS_CONFIG : COLS_CONFIG_IA,
    };
  } catch (e) {
    return { tipo: "error", detalle: `No se pudo leer el catálogo de traslados: ${(e as Error)?.message ?? "sin conexión"}` };
  }
}

// ── Tipo de cambio ───────────────────────────────────────────────────────────

export type FilaTc = { fecha: string; venta: number | null; compra: number | null; fuente: string | null };

export type LecturaTc =
  | { tipo: "ok"; fila: FilaTc | null }
  | { tipo: "sin_tabla" }
  | { tipo: "error"; detalle: string };

/**
 * La fila de `tipo_cambio` (USD) que usaría el cotizador: la más reciente con fecha <= hoy. Un fallo
 * de lectura NO se pinta como «no hay tipo de cambio»: son dos cosas distintas y se dicen distinto.
 */
export async function leerUltimoTc(hoy: string): Promise<LecturaTc> {
  let cols = ["fecha", "venta", "compra", "fuente"];
  for (let intento = 0; intento < 3; intento++) {
    const { data, error } = await supabase.from("tipo_cambio").select(cols.join(", "))
      .eq("moneda", "USD").lte("fecha", hoy).order("fecha", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      if (tablaQueFalta(error) != null) return { tipo: "sin_tabla" };
      const col = faltaAlguna(error, ["compra", "fuente"] as const);
      if (col) { cols = cols.filter((x) => x !== col); continue; }
      return { tipo: "error", detalle: error.message };
    }
    if (!data) return { tipo: "ok", fila: null };
    const d = data as Record<string, unknown>;
    return {
      tipo: "ok",
      fila: { fecha: String(d.fecha ?? ""), venta: num(d.venta), compra: num(d.compra), fuente: d.fuente == null ? null : String(d.fuente) },
    };
  }
  return { tipo: "error", detalle: "No se pudo leer el tipo de cambio." };
}

// ── Fichas de costeo (para el selector de Vehículos) ─────────────────────────

export type FichaCosteo = { tipo_vehiculo: string; nombre: string; capacidad: number | null };

export async function leerFichasCosteo(): Promise<{ tipo: "ok"; fichas: FichaCosteo[] } | { tipo: "error"; detalle: string }> {
  const { data, error } = await supabase.from("parametros_costos").select("tipo_vehiculo, nombre, capacidad")
    .eq("activo", true).order("capacidad", { ascending: true }).order("tipo_vehiculo", { ascending: true });
  if (error) return { tipo: "error", detalle: error.message };
  return {
    tipo: "ok",
    fichas: ((data ?? []) as Record<string, unknown>[]).map((f) => ({
      tipo_vehiculo: String(f.tipo_vehiculo ?? ""), nombre: String(f.nombre ?? f.tipo_vehiculo ?? ""), capacidad: num(f.capacidad),
    })).filter((f) => f.tipo_vehiculo),
  };
}

// ── Escrituras: con RLS, «sin permiso» puede ser un error O cero filas ───────────────────

/** Escribir en las cuatro tablas exige el módulo «tarifas» (o admin). Leer, no. */
export const SIN_PERMISO_TARIFAS = "hace falta el permiso del módulo Tarifas (lo da un administrador en Usuarios)";

/** Los límites que exigen los CHECK de traslados-01-tablas.sql: el formulario los valida antes de guardar. */
export const LIMITES = {
  radio_m: [1, 10000],
  capacidad: [1, 100],
  maletas_bodega: [0, 200],
  validez_dias: [1, 365],
  espera_gratis_min: [0, 600],
} as const;

/** El error de una escritura dicho para quien lo lee, con lo que hay que hacer cuando se sabe. */
export function textoError(e: ErrorSupabase, que: string): string {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return `${que}: no se guardó porque ${SIN_PERMISO_TARIFAS}.`;
  if (code === "23505") return `${que}: ya existe (los nombres y las claves no se repiten).`;
  if (code === "23514") return `${que}: un dato está fuera de rango o falta (centro en el mapa, radio de 1 a 10 000 m, asientos de 1 a 100, bodega de 0 a 200…).`;
  if (code === "23503") return `${que}: hace referencia a algo que ya no existe (recarga la pantalla).`;
  if (/failed to fetch|network/i.test(msg)) return `${que}: sin conexión con la base. Revisa tu internet y vuelve a intentarlo.`;
  return `${que}: ${msg || "error desconocido"}`;
}

/**
 * Lo que devolvió una escritura hecha CON `.select()`. Con RLS, un UPDATE, DELETE o el lado
 * «update» de un upsert sin permiso NO da error: afecta cero filas. Por eso toda escritura de esta
 * pantalla pide las filas de vuelta, y menos filas de las esperadas se dicen, nunca se dan por
 * guardadas.
 */
export function filasEscritas<T>(
  res: { data: T[] | T | null; error: ErrorSupabase },
  que: string,
  esperadas = 1,
): { ok: true; filas: T[]; faltan: number } | { ok: false; detalle: string; cero: boolean } {
  if (res.error) return { ok: false, detalle: textoError(res.error, que), cero: false };
  const filas = res.data == null ? [] : Array.isArray(res.data) ? res.data : [res.data];
  if (filas.length === 0) return { ok: false, detalle: `${que}: no se guardó porque ${SIN_PERMISO_TARIFAS}.`, cero: true };
  return { ok: true, filas, faltan: Math.max(0, esperadas - filas.length) };
}

/**
 * Cero filas tiene DOS causas: falta el permiso, o la fila ya no existe (otra persona la borró).
 * Leer está abierto a todo el ERP, así que se comprueba cuál fue en vez de acusar al permiso.
 */
export async function motivoCeroFilas(tabla: string, col: string, valor: string | number, que: string): Promise<string> {
  try {
    const { data, error } = await supabase.from(tabla).select(col).eq(col, valor).limit(1);
    if (!error && (data ?? []).length === 0) return `${que}: ya no existe en la base (alguien la borró). Pulsa «↻ Recargar».`;
  } catch { /* si no se puede comprobar, queda el motivo del permiso */ }
  return `${que}: no se guardó porque ${SIN_PERMISO_TARIFAS}.`;
}

/** De unos ids de tarifas, los que todavía existen (null si no se pudo comprobar). */
export async function tarifasQueSiguen(ids: number[]): Promise<Set<number> | null> {
  try {
    const { data, error } = await supabase.from("tarifas_traslado").select("id").in("id", ids);
    if (error) return null;
    return new Set(((data ?? []) as { id: unknown }[]).map((x) => Number(x.id)));
  } catch { return null; }
}
