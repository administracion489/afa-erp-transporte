// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/datos.ts — Lee el catálogo de traslados (zonas, categorías, tarifas, ajustes),
// el tipo de cambio y el IGV. Recibe el cliente de Supabase (servidor o navegador).
//
// La lectura es ESTRICTA: una página de tarifas que falla LANZA. Una lista de precios incompleta
// diría «sin tarifa» de un par que sí la tiene, y aunque eso cae del lado seguro (deriva), el
// ejecutivo recibiría pedidos que el sistema sí sabía cotizar sin que nada explique por qué.
// ──────────────────────────────────────────────────────────────────────────────

import { tablaQueFalta } from "../columna-faltante";
import type { CategoriaTraslado, TarifaTraslado, Zona } from "./motor";

// El cliente llega de varios sitios (servidor con service-role, navegador): se tipa lo mínimo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type ConfigTraslados = {
  validez_dias: number;
  espera_gratis_min: number;
  consideraciones: string[];
  consideraciones_usd: string[];
};

export const CONFIG_DEFECTO: ConfigTraslados = { validez_dias: 30, espera_gratis_min: 30, consideraciones: [], consideraciones_usd: [] };

export type CatalogoTraslados = {
  zonas: Zona[];
  categorias: CategoriaTraslado[];
  tarifas: TarifaTraslado[];
  config: ConfigTraslados;
};

export const TABLAS_TRASLADOS = ["zonas_traslado", "traslado_categorias", "tarifas_traslado", "traslados_config"] as const;

export class SinMigracionTraslados extends Error {
  constructor(public tabla: string) {
    super(`Falta la tabla ${tabla}: corre supabase/traslados-01-tablas.sql (y -02, -03).`);
  }
}

const PAG = 1000;

async function todas<T>(sb: Sb, tabla: string, cols: string, orden: string): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    const { data, error } = await sb.from(tabla).select(cols).order(orden, { ascending: true }).range(desde, desde + PAG - 1);
    if (error) {
      if (tablaQueFalta(error)) throw new SinMigracionTraslados(tabla);
      throw new Error(`No se pudo leer ${tabla}: ${error.message}`);
    }
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAG) return out;
  }
}

export async function cargarCatalogo(sb: Sb): Promise<CatalogoTraslados> {
  const [zonas, categorias, tarifas, cfg] = await Promise.all([
    todas<Zona>(sb, "zonas_traslado", "id, nombre, tipo, padre_id, sector, alias, lat, lng, radio_m, orden, activo", "id"),
    todas<CategoriaTraslado>(sb, "traslado_categorias", "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo, orden, activo", "clave"),
    todas<TarifaTraslado>(sb, "tarifas_traslado", "id, zona_a_id, zona_b_id, categoria, moneda, precio_tramo, activo", "id"),
    todas<Partial<ConfigTraslados>>(sb, "traslados_config", "validez_dias, espera_gratis_min, consideraciones, consideraciones_usd", "id"),
  ]);
  const c = cfg[0] ?? {};
  return {
    zonas: zonas.map((z) => ({ ...z, id: Number(z.id), padre_id: z.padre_id == null ? null : Number(z.padre_id) })),
    categorias: categorias.map((x) => ({ ...x, capacidad: Number(x.capacidad), maletas_bodega: Number(x.maletas_bodega) || 0 })),
    tarifas: tarifas.map((t) => ({ ...t, zona_a_id: Number(t.zona_a_id), zona_b_id: Number(t.zona_b_id), precio_tramo: Number(t.precio_tramo) })),
    config: {
      validez_dias: Number(c.validez_dias) || CONFIG_DEFECTO.validez_dias,
      espera_gratis_min: c.espera_gratis_min == null ? CONFIG_DEFECTO.espera_gratis_min : Number(c.espera_gratis_min),
      consideraciones: Array.isArray(c.consideraciones) ? c.consideraciones : [],
      consideraciones_usd: Array.isArray(c.consideraciones_usd) ? c.consideraciones_usd : [],
    },
  };
}

/** La fila más reciente de `tipo_cambio` (USD) con fecha <= hoy, o null. Nunca lanza. */
export async function leerTipoCambioUsd(sb: Sb, hoy: string): Promise<{ fecha: string; venta: number; compra: number | null; fuente: string | null } | null> {
  try {
    const { data, error } = await sb.from("tipo_cambio").select("fecha, venta, compra, fuente")
      .eq("moneda", "USD").lte("fecha", hoy).order("fecha", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return { fecha: data.fecha, venta: Number(data.venta), compra: data.compra == null ? null : Number(data.compra), fuente: data.fuente ?? null };
  } catch {
    return null;
  }
}

/** El IGV de `config_tributaria`; 18 si no se puede leer (la tasa vigente en Perú). */
export async function leerIgvPct(sb: Sb): Promise<number> {
  try {
    const { data } = await sb.from("config_tributaria").select("igv_pct").eq("id", 1).maybeSingle();
    const n = Number(data?.igv_pct);
    return Number.isFinite(n) && n >= 0 && n < 100 ? n : 18;
  } catch {
    return 18;
  }
}
