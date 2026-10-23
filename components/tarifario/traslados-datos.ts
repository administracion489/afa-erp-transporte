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
import { CONFIG_RESERVA_DEFECTO, normalizarConfigReserva, type ConfigReserva } from "@/lib/traslados/reserva-pago";
import type { CategoriaFila, TarifaFila, UnidadFotos, ZonaFila } from "./traslados-pantalla";

export type ConfigFila = {
  validez_dias: number;
  espera_gratis_min: number;
  consideraciones: string[];
  consideraciones_usd: string[];
  /** traslados-05: la IA del CRM cotiza traslados. Sin la migración, false. */
  ia_cotiza: boolean;
  /** traslados-05: maestro del envío SIN revisión. Sin la migración, false. */
  envio_automatico: boolean;
  /** traslados-07: lo que INCLUYE un traslado (la cotización lo copia). Sin la migración, vacía. */
  incluye: string[];
  /** traslados-07: lo que NO incluye. Sin la migración, vacía. */
  no_incluye: string[];
  /**
   * traslados-09: la reserva y el pago por la IA (`reserva_*`), leídos con `normalizarConfigReserva`
   * —la MISMA lectura que hace el servidor—. Sin la migración, la reserva apagada y los defectos.
   */
  reserva: ConfigReserva;
};

export const CONFIG_VACIA: ConfigFila = {
  validez_dias: 30, espera_gratis_min: 30, consideraciones: [], consideraciones_usd: [], ia_cotiza: false, envio_automatico: false,
  incluye: [], no_incluye: [], reserva: { ...CONFIG_RESERVA_DEFECTO },
};

/**
 * `sinMigracionIA`: falta alguna columna de traslados-05 (los tres interruptores). La pantalla
 * funciona igual, lee los tres como apagados y lo dice nombrando el SQL. `colsZona` son las
 * columnas que se pueden pedir de vuelta tras escribir una zona: con la columna ausente, pedirla
 * haría fallar la escritura entera. Lo mismo `colsCategoria` y `colsConfig`.
 * `sinMigracionFotos` / `sinMigracionListas`: faltan columnas de traslados-07 (las fotos y la
 * descripción de la categoría; las listas Incluye / No incluye). Sin ellas la pantalla sigue como
 * antes y lo dice en ámbar. `sinMigracionReserva`: faltan las de traslados-09 (`reserva_*`): el
 * bloque «Reserva y pago por la IA» no se ofrece y lo dice nombrando el SQL.
 */
export type CargaTraslados =
  | {
    tipo: "ok"; zonas: ZonaFila[]; categorias: CategoriaFila[]; tarifas: TarifaFila[]; config: ConfigFila; configExiste: boolean;
    sinMigracionIA: boolean; colsZona: string; colsConfig: string;
    sinMigracionFotos: boolean; sinMigracionListas: boolean; colsCategoria: string;
    sinMigracionReserva: boolean;
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
/** Las de traslados-07 en la categoría: se piden y, si el error nombra una, se suelta SOLO esa. */
export const COLS_CATEGORIA_FOTOS = ["foto_externa_url", "foto_interna_url", "descripcion_cliente"] as const;
/** Las columnas accesorias de `traslados_config`: las de traslados-05 y las de traslados-07. */
const COLS_CONFIG_IA_LISTA = ["ia_cotiza", "envio_automatico"] as const;
const COLS_CONFIG_LISTAS = ["incluye", "no_incluye"] as const;
/** Las de traslados-09: van juntas (es una sola migración), así que si falta una se sueltan todas. */
export const COLS_CONFIG_RESERVA = [
  "reserva_ia", "reserva_adelanto_pct", "reserva_correo", "reserva_plazo_confirmacion_min", "reserva_margen_min", "reserva_devolucion_plazo_h",
] as const;
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

const textoONull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function normalizarCategoria(c: Record<string, unknown>): CategoriaFila {
  return {
    clave: String(c.clave ?? ""),
    nombre: String(c.nombre ?? ""),
    capacidad: Number(c.capacidad) || 0,
    maletas_bodega: Number(c.maletas_bodega) || 0,
    tipo_vehiculo: c.tipo_vehiculo == null ? null : String(c.tipo_vehiculo),
    orden: num(c.orden) ?? 0,
    activo: c.activo !== false,
    // traslados-07: sin la migración no vienen (y se leen como «sin foto», que la pantalla dice en ámbar).
    foto_externa_url: textoONull(c.foto_externa_url),
    foto_interna_url: textoONull(c.foto_interna_url),
    descripcion_cliente: textoONull(c.descripcion_cliente),
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
    incluye: lista(c.incluye),
    no_incluye: lista(c.no_incluye),
    reserva: normalizarConfigReserva(c),
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

/**
 * Una lectura con columnas ACCESORIAS: si el error NOMBRA una de ellas, se repite sin ESA (solo la
 * que el error nombra) y se apunta en `faltan`. Cualquier otro error se devuelve tal cual. `cols`
 * son las columnas que sí existen (las que se pueden pedir de vuelta tras escribir). Las de un
 * `grupo` (las de UNA migración) se sueltan juntas: si falta una, faltan todas, y soltarlas de a
 * una costaría una lectura por columna.
 */
async function conAccesorias<T extends { error: ErrorSupabase }>(
  leer: (cols: string) => PromiseLike<T>, base: string, accesorias: readonly string[], grupos: readonly (readonly string[])[] = [],
): Promise<{ r: T; faltan: string[]; cols: string }> {
  let quedan = [...accesorias];
  const faltan: string[] = [];
  for (;;) {
    const cols = quedan.length ? `${base}, ${quedan.join(", ")}` : base;
    const r = await leer(cols);
    const col = r.error ? faltaAlguna(r.error, quedan) : null;
    if (!col) return { r, faltan, cols };
    const grupo = grupos.find((g) => g.includes(col));
    const fuera = grupo ? quedan.filter((c) => grupo.includes(c)) : [col];
    faltan.push(...fuera);
    quedan = quedan.filter((c) => !fuera.includes(c));
  }
}

async function leerConfig(cols: string): Promise<{ data: Record<string, unknown> | null; error: ErrorSupabase }> {
  const { data, error } = await supabase.from("traslados_config").select(cols).eq("id", 1).maybeSingle();
  return { data: (data as Record<string, unknown> | null) ?? null, error };
}

export async function cargarTraslados(): Promise<CargaTraslados> {
  try {
    const [zr, cr, t, cfgr] = await Promise.all([
      conRespaldo(
        () => todas<Record<string, unknown>>("zonas_traslado", COLS_ZONA_IA, "id"),
        () => todas<Record<string, unknown>>("zonas_traslado", COLS_ZONA, "id"),
        ["envio_automatico"]),
      conAccesorias((cols) => todas<Record<string, unknown>>("traslado_categorias", cols, "clave"), COLS_CATEGORIA, COLS_CATEGORIA_FOTOS),
      todas<Record<string, unknown>>("tarifas_traslado", COLS_TARIFA, "id"),
      conAccesorias((cols) => leerConfig(cols), COLS_CONFIG, [...COLS_CONFIG_IA_LISTA, ...COLS_CONFIG_LISTAS, ...COLS_CONFIG_RESERVA], [COLS_CONFIG_RESERVA]),
    ]);
    const z = zr.r;
    const c = cr.r;
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
      sinMigracionIA: zr.falta || cfgr.faltan.some((x) => (COLS_CONFIG_IA_LISTA as readonly string[]).includes(x)),
      colsZona: zr.falta ? COLS_ZONA : COLS_ZONA_IA,
      colsConfig: cfgr.cols,
      sinMigracionFotos: cr.faltan.length > 0,
      sinMigracionListas: cfgr.faltan.some((x) => (COLS_CONFIG_LISTAS as readonly string[]).includes(x)),
      colsCategoria: cr.cols,
      sinMigracionReserva: cfgr.faltan.some((x) => (COLS_CONFIG_RESERVA as readonly string[]).includes(x)),
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

// ── Fotos de la flota (sugerencias para la categoría) ────────────────────────

export type FlotaFotos = { tipo: "ok"; unidades: UnidadFotos[] } | { tipo: "error"; detalle: string };

/**
 * Las unidades de UNA flota con sus fotos y su ficha de costeo. Sin la columna `estado` se leen
 * todas (no se puede decir cuál está inactiva); sin `tipo_vehiculo_costeo`, ninguna se puede
 * sugerir y se dice. Un fallo de lectura NUNCA se lee como «no hay unidades».
 */
async function fotosDe(tabla: "vehiculos" | "vehiculos_tercero", flota: UnidadFotos["flota"]): Promise<FlotaFotos> {
  try {
    const r = await conAccesorias((cols) => todas<Record<string, unknown>>(tabla, cols, "id"), "id, placa, foto_externa_url, foto_interna_url", ["estado", "tipo_vehiculo_costeo"]);
    if (r.r.error) return { tipo: "error", detalle: r.r.error.message ?? "error desconocido" };
    if (r.faltan.includes("tipo_vehiculo_costeo")) return { tipo: "error", detalle: `la tabla ${tabla} no tiene la columna tipo_vehiculo_costeo` };
    const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      tipo: "ok",
      unidades: (r.r.filas ?? []).map((u) => ({
        id: Number(u.id), flota, placa: String(u.placa ?? "").trim() || `#${u.id}`,
        estado: txt(u.estado), tipo_vehiculo_costeo: txt(u.tipo_vehiculo_costeo),
        foto_externa_url: txt(u.foto_externa_url), foto_interna_url: txt(u.foto_interna_url),
      })),
    };
  } catch (e) {
    return { tipo: "error", detalle: (e as Error)?.message ?? "sin conexión" };
  }
}

/** Las dos flotas (propia y tercerizada), cada una con su propio resultado. */
export async function leerFotosFlota(): Promise<{ propias: FlotaFotos; terceros: FlotaFotos }> {
  const [propias, terceros] = await Promise.all([fotosDe("vehiculos", "propia"), fotosDe("vehiculos_tercero", "tercerizada")]);
  return { propias, terceros };
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

/** La regla de supabase/seguridad-05-reserva-dinero.sql sobre `traslados_config.reserva_correo`. */
export const SOLO_ADMIN_CORREO_RESERVA = "el correo que recibe los comprobantes de pago de las reservas solo lo cambia un administrador del ERP (lleva datos de los clientes). Pídeselo a un administrador; lo demás se guarda sin tocar el correo.";

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
  // supabase/seguridad-05-reserva-dinero.sql: el correo de los comprobantes de reserva solo lo cambia un
  // administrador (el mismo 42501 que un permiso que falta, pero con su propio motivo).
  if (code === "42501" && /comprobantes de reserva/i.test(msg)) return `${que}: ${SOLO_ADMIN_CORREO_RESERVA}`;
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
