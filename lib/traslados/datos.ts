// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/datos.ts — Lee el catálogo de traslados (zonas, categorías, tarifas, ajustes),
// el tipo de cambio y el IGV. Recibe el cliente de Supabase (servidor o navegador).
//
// La lectura es ESTRICTA: una página de tarifas que falla LANZA. Una lista de precios incompleta
// diría «sin tarifa» de un par que sí la tiene, y aunque eso cae del lado seguro (deriva), el
// ejecutivo recibiría pedidos que el sistema sí sabía cotizar sin que nada explique por qué.
//
// Las columnas de la fase 2 (supabase/traslados-05-cotizacion-ia.sql: los interruptores de la IA
// y la marca de envío automático por zona) son ACCESORIAS: sin ellas se relee sin ellas, todo
// queda apagado y el catálogo lo DICE (`sinMigracionIA`). Lo demás sigue siendo estricto.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, faltaColumna, tablaQueFalta, type ErrorSupabase } from "../columna-faltante";
import { normalizarConfigReserva, type ConfigReserva } from "./reserva-pago";
import type { CategoriaTraslado, TarifaTraslado } from "./motor";
import type { ZonaEnvio } from "./envio-ia";

// El cliente llega de varios sitios (servidor con service-role, navegador): se tipa lo mínimo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type ConfigTraslados = {
  validez_dias: number;
  espera_gratis_min: number;
  consideraciones: string[];
  consideraciones_usd: string[];
  /** traslados-05: la IA del CRM puede cotizar traslados. Ausente = no. */
  ia_cotiza?: boolean;
  /** traslados-05: maestro del envío SIN revisión. Ausente = no. */
  envio_automatico?: boolean;
  /** traslados-07: lo que INCLUYE un traslado (la cotización lo copia). Ausente = vacía (no se imprime). */
  incluye?: string[];
  /** traslados-07: lo que NO incluye. Ausente = vacía. */
  no_incluye?: string[];
};

export const CONFIG_DEFECTO: ConfigTraslados = {
  validez_dias: 30, espera_gratis_min: 30, consideraciones: [], consideraciones_usd: [], ia_cotiza: false, envio_automatico: false,
  incluye: [], no_incluye: [],
};

export type CatalogoTraslados = {
  zonas: ZonaEnvio[];
  categorias: CategoriaTraslado[];
  tarifas: TarifaTraslado[];
  config: ConfigTraslados;
  /** Faltan las columnas de traslados-05: la IA no cotiza y nada sale solo. */
  sinMigracionIA: boolean;
  /** Faltan las listas Incluye / No incluye de traslados-07: las cotizaciones nacen sin ellas. */
  sinMigracionListas?: boolean;
};

/** Las columnas de traslados-05 que se leen con el catálogo. */
export const COLUMNAS_IA = ["envio_automatico", "ia_cotiza"] as const;
/** Las columnas de traslados-07 de `traslados_config`. */
export const COLUMNAS_LISTAS = ["incluye", "no_incluye"] as const;

export const TABLAS_TRASLADOS = ["zonas_traslado", "traslado_categorias", "tarifas_traslado", "traslados_config"] as const;

export class SinMigracionTraslados extends Error {
  constructor(public tabla: string) {
    super(`Falta la tabla ${tabla}: corre supabase/traslados-01-tablas.sql (y -02, -03).`);
  }
}

const PAG = 1000;

/** Una tabla entera, paginada con orden total. Falta la tabla → SinMigracionTraslados; otro error → lanza con el error. */
async function todas<T>(sb: Sb, tabla: string, cols: string, orden: string): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    const { data, error } = await sb.from(tabla).select(cols).order(orden, { ascending: true }).range(desde, desde + PAG - 1);
    if (error) {
      if (tablaQueFalta(error)) throw new SinMigracionTraslados(tabla);
      throw new ErrorLectura(tabla, error);
    }
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAG) return out;
  }
}

class ErrorLectura extends Error {
  constructor(tabla: string, public error: ErrorSupabase) {
    super(`No se pudo leer ${tabla}: ${error?.message ?? "error desconocido"}`);
  }
}

/**
 * Como `todas`, pero con columnas ACCESORIAS: si el error nombra una de ellas, se relee sin ESA
 * (solo la que el error nombra: hay columnas de dos migraciones, traslados-05 y -07) y se apunta en
 * `faltan`. Ante otro error, lanza.
 */
async function todasConAccesorias<T>(sb: Sb, tabla: string, base: string, accesorias: readonly string[], orden: string): Promise<{ filas: T[]; faltan: string[] }> {
  let quedan = [...accesorias];
  const faltan: string[] = [];
  for (;;) {
    try {
      return { filas: await todas<T>(sb, tabla, quedan.length ? `${base}, ${quedan.join(", ")}` : base, orden), faltan };
    } catch (e) {
      const col = e instanceof ErrorLectura ? faltaAlguna(e.error, quedan) : null;
      if (!col) throw e;
      faltan.push(col);
      quedan = quedan.filter((c) => c !== col);
    }
  }
}

export async function cargarCatalogo(sb: Sb): Promise<CatalogoTraslados> {
  const [zonas, categorias, tarifas, cfg] = await Promise.all([
    todasConAccesorias<ZonaEnvio>(sb, "zonas_traslado", "id, nombre, tipo, padre_id, sector, alias, lat, lng, radio_m, orden, activo", ["envio_automatico"], "id"),
    todas<CategoriaTraslado>(sb, "traslado_categorias", "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo, orden, activo", "clave"),
    todas<TarifaTraslado>(sb, "tarifas_traslado", "id, zona_a_id, zona_b_id, categoria, moneda, precio_tramo, activo", "id"),
    todasConAccesorias<Partial<ConfigTraslados>>(sb, "traslados_config", "validez_dias, espera_gratis_min, consideraciones, consideraciones_usd", [...COLUMNAS_IA, ...COLUMNAS_LISTAS], "id"),
  ]);
  const sinMigracionIA = zonas.faltan.length > 0 || cfg.faltan.some((c) => (COLUMNAS_IA as readonly string[]).includes(c));
  const sinMigracionListas = cfg.faltan.some((c) => (COLUMNAS_LISTAS as readonly string[]).includes(c));
  const c = cfg.filas[0] ?? {};
  return {
    zonas: zonas.filas.map((z) => ({
      ...z, id: Number(z.id), padre_id: z.padre_id == null ? null : Number(z.padre_id),
      envio_automatico: !sinMigracionIA && z.envio_automatico === true,
    })),
    categorias: categorias.map((x) => ({ ...x, capacidad: Number(x.capacidad), maletas_bodega: Number(x.maletas_bodega) || 0 })),
    tarifas: tarifas.map((t) => ({ ...t, zona_a_id: Number(t.zona_a_id), zona_b_id: Number(t.zona_b_id), precio_tramo: Number(t.precio_tramo) })),
    config: {
      validez_dias: Number(c.validez_dias) || CONFIG_DEFECTO.validez_dias,
      espera_gratis_min: c.espera_gratis_min == null ? CONFIG_DEFECTO.espera_gratis_min : Number(c.espera_gratis_min),
      consideraciones: Array.isArray(c.consideraciones) ? c.consideraciones : [],
      consideraciones_usd: Array.isArray(c.consideraciones_usd) ? c.consideraciones_usd : [],
      ia_cotiza: !sinMigracionIA && c.ia_cotiza === true,
      envio_automatico: !sinMigracionIA && c.envio_automatico === true,
      incluye: Array.isArray(c.incluye) ? c.incluye : [],
      no_incluye: Array.isArray(c.no_incluye) ? c.no_incluye : [],
    },
    sinMigracionIA,
    sinMigracionListas,
  };
}

export type ConfigIA = {
  /** La IA puede cotizar traslados: interruptor encendido Y las tablas y columnas existen. */
  iaCotiza: boolean;
  envioMaestro: boolean;
  /** Falta traslados-01 (las tablas) o traslados-05 (las columnas de la IA o de `cotizaciones`). */
  sinMigracion: boolean;
  /** Por qué no está disponible, para el registro. */
  detalle: string | null;
  /**
   * La reserva de traslados (traslados-09, columnas `reserva_*`). Sin las columnas, o con la
   * cotización apagada, el defecto: apagada. La lee `normalizarConfigReserva` (lib/traslados/reserva-pago.ts).
   */
  reserva: ConfigReserva;
  /** La IA RESERVA: cotiza traslados, `reserva_ia` encendida y existen las tablas de reservas-09a/b/c. */
  reservaIA: boolean;
  /** Falta traslados-09 (las columnas) o alguna de reservas-09a/b/c (solo se mira con la reserva encendida). */
  reservaSinMigracion: boolean;
  /** Por qué la reserva no está disponible (o lo que no se pudo comprobar), para el registro. */
  reservaDetalle: string | null;
};

/** Las columnas de traslados-09 que se leen con los interruptores (accesorias: se suelta SOLO la que el error nombra). */
export const COLUMNAS_RESERVA = [
  "reserva_ia", "reserva_adelanto_pct", "reserva_correo", "reserva_plazo_confirmacion_min", "reserva_margen_min", "reserva_devolucion_plazo_h",
] as const;

/** Los SQL de la reserva de traslados, en el orden en que se corren. */
export const SQL_RESERVA_TRASLADOS = {
  config: "supabase/traslados-09-reserva-ia.sql",
  solicitudes: "supabase/reservas-09a-solicitudes.sql",
  comprobantes: "supabase/reservas-09b-comprobantes.sql",
  pagos: "supabase/reservas-09c-pagos-solicitud.sql",
} as const;

/**
 * ¿Existen las tablas y la columna de reservas-09a/b/c? null si todo está; si no, el SQL que falta
 * (o el error de la lectura, que también apaga la reserva: «no sé» no es «está»). Nunca lanza.
 */
async function faltaReserva(sb: Sb): Promise<{ sinMigracion: boolean; detalle: string } | null> {
  const pruebas: [string, () => PromiseLike<{ error: ErrorSupabase | null }>, string][] = [
    ["reserva_solicitudes", () => sb.from("reserva_solicitudes").select("id").limit(1), SQL_RESERVA_TRASLADOS.solicitudes],
    ["reserva_solicitud_comprobantes", () => sb.from("reserva_solicitud_comprobantes").select("id").limit(1), SQL_RESERVA_TRASLADOS.comprobantes],
    ["pagos.reserva_solicitud_id", () => sb.from("pagos").select("id, reserva_solicitud_id").limit(1), SQL_RESERVA_TRASLADOS.pagos],
  ];
  for (const [que, consulta, sql] of pruebas) {
    try {
      const { error } = await consulta();
      if (!error) continue;
      if (tablaQueFalta(error) || faltaColumna(error, "reserva_solicitud_id")) return { sinMigracion: true, detalle: `Falta ${sql}.` };
      return { sinMigracion: false, detalle: `No se pudo comprobar ${que}: ${error.message ?? error.code ?? "error"}` };
    } catch (e) {
      return { sinMigracion: false, detalle: `No se pudo comprobar ${que}: ${(e as Error)?.message ?? e}` };
    }
  }
  return null;
}

/**
 * Lo que el agente del CRM necesita ANTES de su bucle: ¿se le ofrece `cotizar_traslado`? Una
 * consulta a `traslados_config` y, si está encendida, otra que comprueba que `cotizaciones` ya
 * tiene las columnas donde se guarda el traslado (sin ellas la cotización no quedaría atada a la
 * conversación y no habría cómo enviarla). Nunca lanza: ante la duda, la herramienta no se ofrece
 * y el agente se comporta como antes.
 *
 * Con la misma lectura, la RESERVA (traslados-09): sus columnas son accesorias (si el error nombra
 * una, se relee sin ESA y la reserva queda con su defecto), y con `reserva_ia` encendida se
 * comprueba que existan las tablas de reservas-09a/b/c. Sin ellas, o si no se pudo comprobar, la
 * IA no reserva (y el prompt es el de antes).
 */
export async function leerConfigIA(sb: Sb): Promise<ConfigIA> {
  const apagada = { reserva: normalizarConfigReserva(null), reservaIA: false, reservaSinMigracion: false, reservaDetalle: null };
  const no = (sinMigracion: boolean, detalle: string): ConfigIA => ({ iaCotiza: false, envioMaestro: false, sinMigracion, detalle, ...apagada });
  try {
    let quedan: string[] = [...COLUMNAS_RESERVA];
    const sueltas: string[] = [];
    let r: { data: Record<string, unknown> | null; error: ErrorSupabase | null };
    for (;;) {
      r = await sb.from("traslados_config").select(["ia_cotiza", "envio_automatico", ...quedan].join(", ")).eq("id", 1).maybeSingle();
      const col = r.error ? faltaAlguna(r.error, quedan) : null;
      if (!col) break;
      sueltas.push(col);
      quedan = quedan.filter((c) => c !== col);
    }
    const { data, error } = r;
    if (error) {
      if (tablaQueFalta(error)) return no(true, "Falta supabase/traslados-01-tablas.sql.");
      if (faltaAlguna(error, COLUMNAS_IA)) return no(true, "Falta supabase/traslados-05-cotizacion-ia.sql.");
      return no(false, `No se pudo leer traslados_config: ${error.message}`);
    }
    const iaCotiza = data?.ia_cotiza === true;
    const envioMaestro = data?.envio_automatico === true;
    const reserva = normalizarConfigReserva(sueltas.length ? null : data);
    const reservaBase = sueltas.length
      ? { reserva, reservaIA: false, reservaSinMigracion: true, reservaDetalle: `Falta ${SQL_RESERVA_TRASLADOS.config} (columna ${sueltas.join(", ")}).` }
      : { reserva, reservaIA: false, reservaSinMigracion: false, reservaDetalle: null };
    if (!iaCotiza) return { iaCotiza: false, envioMaestro, sinMigracion: false, detalle: null, ...reservaBase };
    const prueba = await sb.from("cotizaciones").select("id, crm_conversacion_id, traslado_json").limit(1);
    if (prueba.error) {
      if (faltaAlguna(prueba.error, ["crm_conversacion_id", "traslado_json"])) return no(true, "Falta supabase/traslados-05-cotizacion-ia.sql (columnas de cotizaciones).");
      return no(false, `No se pudo comprobar cotizaciones: ${prueba.error.message}`);
    }
    if (!reserva.activa || sueltas.length) return { iaCotiza: true, envioMaestro, sinMigracion: false, detalle: null, ...reservaBase };
    const falta = await faltaReserva(sb);
    return {
      iaCotiza: true, envioMaestro, sinMigracion: false, detalle: null,
      reserva, reservaIA: !falta, reservaSinMigracion: falta?.sinMigracion ?? false, reservaDetalle: falta?.detalle ?? null,
    };
  } catch (e) {
    return no(false, (e as Error)?.message ?? "Error leyendo la configuración de traslados.");
  }
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
