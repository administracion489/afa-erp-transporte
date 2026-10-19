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
};

export const CONFIG_VACIA: ConfigFila = { validez_dias: 30, espera_gratis_min: 30, consideraciones: [], consideraciones_usd: [] };

export type CargaTraslados =
  | { tipo: "ok"; zonas: ZonaFila[]; categorias: CategoriaFila[]; tarifas: TarifaFila[]; config: ConfigFila; configExiste: boolean }
  | { tipo: "sin_tablas"; tabla: string }
  | { tipo: "error"; detalle: string };

export const COLS_ZONA = "id, nombre, tipo, padre_id, sector, alias, lat, lng, radio_m, orden, activo, notas";
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
  };
}

export async function cargarTraslados(): Promise<CargaTraslados> {
  try {
    const [z, c, t, cfg] = await Promise.all([
      todas<Record<string, unknown>>("zonas_traslado", COLS_ZONA, "id"),
      todas<Record<string, unknown>>("traslado_categorias", COLS_CATEGORIA, "clave"),
      todas<Record<string, unknown>>("tarifas_traslado", COLS_TARIFA, "id"),
      supabase.from("traslados_config").select("id, validez_dias, espera_gratis_min, consideraciones, consideraciones_usd").eq("id", 1).maybeSingle(),
    ]);
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
      config: normalizarConfig(cfg.data as Record<string, unknown> | null),
      configExiste: !!cfg.data,
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

// ── Errores de escritura, en castellano ──────────────────────────────────────

/** El error de una escritura dicho para quien lo lee, con lo que hay que hacer cuando se sabe. */
export function textoError(e: ErrorSupabase, que: string): string {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (code === "23505") return `${que}: ya existe (los nombres y las claves no se repiten).`;
  if (code === "23514") return `${que}: falta un dato obligatorio (centro en el mapa, radio o distrito) o un valor no es válido.`;
  if (code === "23503") return `${que}: hace referencia a algo que ya no existe (recarga la pantalla).`;
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return `${que}: la base no permitió escribir. ¿Venció tu sesión? Vuelve a ingresar.`;
  if (/failed to fetch|network/i.test(msg)) return `${que}: sin conexión con la base. Revisa tu internet y vuelve a intentarlo.`;
  return `${que}: ${msg || "error desconocido"}`;
}
