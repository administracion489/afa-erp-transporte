// lib/gps-traza-ajustada-datos.ts — el que LEE y ESCRIBE la traza ajustada guardada (solo servidor,
// service-role). Las decisiones son del motor puro lib/gps-traza-ajustada.ts; el ajuste (la ÚNICA parte
// que habla con Mapbox) es lib/gps-traza-ajustada-calculo.ts. Aquí no hay ninguna llamada de red
// directa (scripts/prueba-traza-ajustada.mts §7).
//
// TABLAS (supabase/gps-traza-ajustada-01.sql, NO la corre el deploy): `gps_traza_ajustada` (una fila por
// reserva, la fila AUTORITATIVA de la traza), `gps_traza_ajuste_intentos` (bitácora del gasto y CANDADO:
// índice único parcial `(reserva_id) where terminado_en is null`) y `gps_traza_config` (fila única).
// Las tres con RLS y SIN políticas: solo service-role. Sin la migración, todo responde `sin_migracion` y
// el modal sigue ajustando en el navegador, como antes.
//
// IDENTIDAD: la firma es sha256 de `${VERSION_AJUSTE}\n${canonEntradaAjuste(filasOk)}`, con `filasOk` de
// `huellaDelServicio` (lib/gps-huella-servicio-datos.ts) — el MISMO lector de /api/cliente/gps. Quien
// escribe (calcularYGuardar, lectura ESTRICTA) y quien lee (ajustadaParaRespuesta, la lectura de la ruta)
// derivan la firma por el mismo camino.
//
// EL TOKEN de Mapbox del servidor (`MAPBOX_TOKEN_SERVIDOR`) va dentro de la URL de Map Matching: nunca se
// registra una URL ni se devuelve el token. No cae a NEXT_PUBLIC_MAPBOX_TOKEN.

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { huellaDeFilas, type FetchMapbox } from "./huella";
import { huellaDelServicio, LecturaHuellaFallida, type ReservaHuella } from "./gps-huella-servicio-datos";
import {
  VERSION_AJUSTE, MAX_FILAS_AJUSTE, MAX_LLAMADAS_SERVICIO, MOTIVO_CALCULO, canonEntradaAjuste,
  decidirLectura, previoALectura, resultadoDelCalculo, llamadasEstimadas,
  fechaDentroDeVentana,
  type ConfigTraza, type GuardadaLeida, type RespuestaAjustada, type CodigoCalculo, type TrazaGuardada,
} from "./gps-traza-ajustada";
import { ajustarServicioCompleto, fetchMapboxServidor } from "./gps-traza-ajustada-calculo";
import { tablaFaltante } from "./columna-faltante";
import { limpiarValorEnv } from "./crm-gmail-reglas";
import { DIAS_RASTREO } from "./gps-cobertura-datos";

/* eslint-disable @typescript-eslint/no-explicit-any -- cliente de Supabase y filas crudas de PostgREST */

// ── Dependencias inyectables (la matriz usa dobles) ───────────────────────────────────────
export type DepsTraza = {
  admin?: any;
  /** El fetch de Map Matching (por defecto, `fetchMapboxServidor()`). */
  fetch?: FetchMapbox;
  /** El token (por defecto, MAPBOX_TOKEN_SERVIDOR). `null` = sin token. */
  token?: string | null;
  /** El reloj (epoch ms). */
  ahora?: () => number;
};
let adminPorDefecto: any = null;
const adminDe = (d?: DepsTraza) => d?.admin ?? (adminPorDefecto ??= createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
));
const ahoraDe = (d?: DepsTraza) => (d?.ahora ?? Date.now)();

/** Un intento ABIERTO más viejo que esto se da por muerto (la función que lo tomó murió). */
export const CANDADO_MUERTO_MS = 5 * 60 * 1000;
/** Margen de seguridad del cálculo dentro de la función (maxDuration 60 s). Operativo, no medido. */
export const PLAZO_CALCULO_MS = 45_000;

// ── Configuración ────────────────────────────────────────────────────────────────────────
export type ConfigTrazaLeida =
  | { estado: "ok"; guardar: boolean; borrarGuardadas: boolean; presupuestoHora: number; presupuestoMes: number; precalcularDias: number; porCorrida: number }
  | { estado: "sin_migracion" }
  | { estado: "no_se_pudo_leer" };
const DEFECTO_CONFIG = { guardar: true, borrarGuardadas: false, presupuestoHora: 2000, presupuestoMes: 50000, precalcularDias: 0, porCorrida: 20 };
/** /api/cliente/gps se sondea cada 15 s: la fila única se cachea 30 s por instancia (y por cliente). */
const TTL_CONFIG_MS = 30_000;
const cacheConfig = new WeakMap<object, { at: number; c: ConfigTrazaLeida }>();

/** La fila única de `gps_traza_config`. Sin la tabla: `sin_migracion`. Un error: `no_se_pudo_leer`. */
export async function leerConfigTraza(d?: DepsTraza, opts?: { sinCache?: boolean }): Promise<ConfigTrazaLeida> {
  const admin = adminDe(d);
  const ahora = ahoraDe(d);
  const c = cacheConfig.get(admin);
  if (!opts?.sinCache && c && ahora - c.at < TTL_CONFIG_MS) return c.c;
  let res: ConfigTrazaLeida;
  try {
    const { data, error } = await admin.from("gps_traza_config")
      .select("guardar,borrar_guardadas,presupuesto_hora,presupuesto_mes,precalcular_dias,por_corrida")
      .eq("id", 1).maybeSingle();
    if (error) res = tablaFaltante(error, "gps_traza_config") ? { estado: "sin_migracion" } : { estado: "no_se_pudo_leer" };
    else {
      // Sin la fila (alguien la borró): los defaults de la migración, que son los que alguien firmó.
      const f = data ?? {};
      const num = (v: any, def: number) => (Number.isFinite(Number(v)) && v != null ? Number(v) : def);
      res = {
        estado: "ok",
        guardar: f.guardar == null ? DEFECTO_CONFIG.guardar : f.guardar === true,
        borrarGuardadas: f.borrar_guardadas === true,
        presupuestoHora: num(f.presupuesto_hora, DEFECTO_CONFIG.presupuestoHora),
        presupuestoMes: num(f.presupuesto_mes, DEFECTO_CONFIG.presupuestoMes),
        precalcularDias: Math.max(0, Math.min(90, num(f.precalcular_dias, DEFECTO_CONFIG.precalcularDias))),
        porCorrida: Math.max(0, num(f.por_corrida, DEFECTO_CONFIG.porCorrida)),
      };
    }
  } catch {
    res = { estado: "no_se_pudo_leer" };
  }
  if (res.estado !== "no_se_pudo_leer") cacheConfig.set(admin, { at: ahora, c: res });
  return res;
}
const comoConfigTraza = (c: ConfigTrazaLeida): ConfigTraza =>
  c.estado === "ok" ? { estado: "ok", guardar: c.guardar } : c;

// ── La fila guardada ─────────────────────────────────────────────────────────────────────
export type FilaTraza = GuardadaLeida & { llamadas: number; origen: string | null };
/** La tabla `gps_traza_ajustada` no existe (falta correr la migración). */
export class SinMigracionTraza extends Error {
  constructor() { super("Falta correr supabase/gps-traza-ajustada-01.sql"); this.name = "SinMigracionTraza"; }
}
const COLS_META = "reserva_id,version,firma,n_filas,recalculos,calculado_en,llamadas,origen";

/**
 * La traza guardada de una reserva. `null` si no hay fila. LANZA ante cualquier error: un fallo de
 * lectura nunca es «no hay» (si no, el modal pediría calcular otra vez lo que ya está guardado).
 * Con `conTraza: false` no trae el jsonb (para comprobar si el cliente ya la tiene).
 */
export async function leerTrazaGuardada(reservaId: number, d?: DepsTraza, opts?: { conTraza?: boolean }): Promise<FilaTraza | null> {
  const conTraza = opts?.conTraza !== false;
  const { data, error } = await adminDe(d).from("gps_traza_ajustada")
    .select(conTraza ? `${COLS_META},traza` : COLS_META).eq("reserva_id", reservaId).maybeSingle();
  if (error) {
    if (tablaFaltante(error, "gps_traza_ajustada")) throw new SinMigracionTraza();
    throw new Error(`No se pudo leer la traza guardada: ${error.message ?? error}`);
  }
  if (!data) return null;
  return {
    version: Number(data.version), firma: String(data.firma), nFilas: Number(data.n_filas),
    recalculos: Number(data.recalculos) || 0, calculadoEn: String(data.calculado_en),
    llamadas: Number(data.llamadas) || 0, origen: data.origen ?? null,
    ...(conTraza ? { traza: data.traza } : {}),
  };
}

/** La firma de la entrada del ajuste: sha256 de `${VERSION_AJUSTE}\n${canonEntradaAjuste(filas)}`. */
export function firmaDeFilas(filas: any[]): string {
  return createHash("sha256").update(`${VERSION_AJUSTE}\n${canonEntradaAjuste(filas)}`).digest("hex");
}

/** El token de Mapbox del SERVIDOR, limpio. Sin la variable: null (NO cae al token público). */
export function tokenMapboxServidor(): string | null {
  const t = limpiarValorEnv(process.env.MAPBOX_TOKEN_SERVIDOR);
  return t ? t : null;
}
const tokenDe = (d?: DepsTraza) => (d && "token" in d ? (d.token || null) : tokenMapboxServidor());

/** Último `created_at` de las filas (para la columna `ultimo_ts`). */
function ultimoTs(filas: any[]): string | null {
  let max = -Infinity;
  for (const f of filas) { const t = Date.parse(f?.created_at); if (Number.isFinite(t) && t > max) max = t; }
  return Number.isFinite(max) ? new Date(max).toISOString() : null;
}

// ── La lectura para /api/cliente/gps ─────────────────────────────────────────────────────
/**
 * El campo `ajustada` de /api/cliente/gps (modo huella, solo con la reserva `finalizada`). BEST-EFFORT:
 * cualquier error da `no_se_pudo_leer` — nunca rompe la respuesta de la huella. La firma se calcula
 * sobre las MISMAS `filasOk` que la ruta devuelve. `conocida` es el `calculadoEn` de la traza que el
 * modal ya tiene: si coincide con la fila, no se vuelve a leer ni a enviar el jsonb (`sinCambios`).
 */
export async function ajustadaParaRespuesta(
  e: { reservaId: number; reserva: ReservaHuella | null; filasOk: any[]; completa: boolean; ahoraMs: number; conocida?: unknown },
  d?: DepsTraza,
): Promise<RespuestaAjustada> {
  try {
    const finalizada = e.reserva?.estado === "finalizada";
    const config = finalizada ? await leerConfigTraza(d) : ({ estado: "ok", guardar: true } as ConfigTrazaLeida);
    const previo = previoALectura({ finalizada, config: comoConfigTraza(config), lecturaCompleta: e.completa });
    if (previo) return previo;
    if (!Number.isInteger(e.reservaId) || e.reservaId <= 0) throw new Error("id de reserva inválido");
    return await decidirConFila(e.reservaId, e, config, d);
  } catch (err: any) {
    console.error("[gps-traza-ajustada] lectura:", err?.message ?? err);
    return { estado: "no_se_pudo_leer", puedeCalcular: false, detalle: "no se pudo leer el ajuste guardado o las posiciones; vuelve a intentarlo" };
  }
}

async function decidirConFila(
  reservaId: number,
  e: { reserva: ReservaHuella | null; filasOk: any[]; ahoraMs: number; conocida?: unknown },
  config: ConfigTrazaLeida, d?: DepsTraza,
): Promise<RespuestaAjustada> {
  const conocida = typeof e.conocida === "string" && e.conocida ? e.conocida : null;
  let guardada: FilaTraza | null | "error";
  let clienteLaTiene = false;
  try {
    if (conocida) {
      const meta = await leerTrazaGuardada(reservaId, d, { conTraza: false });
      clienteLaTiene = !!meta && meta.calculadoEn === conocida && meta.version === VERSION_AJUSTE;
      guardada = !meta || clienteLaTiene ? meta : await leerTrazaGuardada(reservaId, d);
    } else guardada = await leerTrazaGuardada(reservaId, d);
  } catch (err: any) {
    if (err instanceof SinMigracionTraza) return { estado: "sin_migracion", puedeCalcular: false, detalle: "falta correr supabase/gps-traza-ajustada-01.sql" };
    console.error("[gps-traza-ajustada] fila:", err?.message ?? err);
    guardada = "error";
  }
  return decidirLectura({
    finalizada: true, config: comoConfigTraza(config), lecturaCompleta: true,
    guardada, clienteLaTiene,
    firmaAhora: firmaDeFilas(e.filasOk), nFilasAhora: e.filasOk.length,
    dentroDeVentana: fechaDentroDeVentana(e.reserva?.fecha_servicio, e.ahoraMs, DIAS_RASTREO),
    tokenServidor: !!tokenDe(d), ahoraMs: e.ahoraMs,
  });
}

// ── Presupuesto y candado ────────────────────────────────────────────────────────────────
/** Inicio del mes calendario de Lima (UTC-5) en ISO. */
export function inicioMesLima(ahoraMs: number): string {
  const ym = new Date(ahoraMs - 5 * 3600 * 1000).toISOString().slice(0, 7);
  return new Date(`${ym}-01T00:00:00-05:00`).toISOString();
}

export type Presupuesto = { ok: boolean; gastoHora: number; gastoMes: number; motivo?: "hora" | "mes" };
/**
 * ¿Caben `estimado` llamadas más en el presupuesto? Suma `llamadas` de la bitácora en la última hora y
 * en el mes de Lima (TODOS los intentos: un intento abierto lleva su ESTIMADO, así dos cálculos a la vez
 * no pasan los dos por el mismo hueco). LANZA si no se puede leer: sin saber cuánto se gastó, no se gasta.
 */
export async function presupuestoDisponible(
  estimado: number, config: { presupuestoHora: number; presupuestoMes: number }, d?: DepsTraza,
): Promise<Presupuesto> {
  const admin = adminDe(d);
  const ahora = ahoraDe(d);
  const desdeMes = inicioMesLima(ahora);
  const hace1h = ahora - 3600_000;
  let gastoHora = 0, gastoMes = 0;
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await admin.from("gps_traza_ajuste_intentos").select("llamadas,empezado_en")
      .gte("empezado_en", desdeMes).order("empezado_en", { ascending: true }).order("id", { ascending: true })
      .range(desde, desde + 999);
    if (error) throw new Error(`No se pudo leer el gasto de Map Matching: ${error.message ?? error}`);
    for (const f of data ?? []) {
      const n = Number(f.llamadas) || 0;
      gastoMes += n;
      if (Date.parse(f.empezado_en) >= hace1h) gastoHora += n;
    }
    if (!data || data.length < 1000) break;
  }
  if (gastoHora + estimado > config.presupuestoHora) return { ok: false, gastoHora, gastoMes, motivo: "hora" };
  if (gastoMes + estimado > config.presupuestoMes) return { ok: false, gastoHora, gastoMes, motivo: "mes" };
  return { ok: true, gastoHora, gastoMes };
}

export type Candado = { ok: true; id: number } | { ok: false; motivo: "en_curso" | "sin_migracion" };
/**
 * Toma el candado del cálculo de una reserva: inserta un intento ABIERTO (el índice único parcial deja
 * uno solo). Antes da por muertos los abiertos de más de CANDADO_MUERTO_MS (la función que lo tomó
 * murió sin soltarlo). El intento nace con `llamadas = estimado`, para que el presupuesto cuente lo que
 * está en vuelo. LANZA ante un error que no sea el choque del candado ni la tabla ausente.
 */
export async function tomarCandado(
  reservaId: number, e: { origen: "apertura" | "cron"; sujeto: string; estimado: number }, d?: DepsTraza,
): Promise<Candado> {
  const admin = adminDe(d);
  const ahora = ahoraDe(d);
  const muerto = await admin.from("gps_traza_ajuste_intentos")
    .update({ terminado_en: new Date(ahora).toISOString(), resultado: "muerto" })
    .eq("reserva_id", reservaId).is("terminado_en", null).lt("empezado_en", new Date(ahora - CANDADO_MUERTO_MS).toISOString());
  if (muerto?.error && tablaFaltante(muerto.error, "gps_traza_ajuste_intentos")) return { ok: false, motivo: "sin_migracion" };
  const { data, error } = await admin.from("gps_traza_ajuste_intentos")
    .insert({ reserva_id: reservaId, origen: e.origen, sujeto: e.sujeto, llamadas: Math.max(0, Math.round(e.estimado)), empezado_en: new Date(ahora).toISOString() })
    .select("id").single();
  if (error) {
    if (error.code === "23505") return { ok: false, motivo: "en_curso" };
    if (tablaFaltante(error, "gps_traza_ajuste_intentos")) return { ok: false, motivo: "sin_migracion" };
    throw new Error(`No se pudo tomar el candado del ajuste: ${error.message ?? error}`);
  }
  return { ok: true, id: Number(data.id) };
}

/** Suelta el candado: escribe SIEMPRE `terminado_en`, las llamadas reales y el resultado. No lanza. */
export async function soltarCandado(id: number, e: { llamadas: number; resultado: string }, d?: DepsTraza): Promise<void> {
  try {
    const { error } = await adminDe(d).from("gps_traza_ajuste_intentos")
      .update({ terminado_en: new Date(ahoraDe(d)).toISOString(), llamadas: Math.max(0, e.llamadas), resultado: e.resultado })
      .eq("id", id);
    if (error) console.error("[gps-traza-ajustada] soltar candado:", error.message ?? error);
  } catch (err: any) {
    console.error("[gps-traza-ajustada] soltar candado:", err?.message ?? err);
  }
}

// ── El cálculo ───────────────────────────────────────────────────────────────────────────
export type ResultadoCalculo = {
  codigo: CodigoCalculo;
  traza?: TrazaGuardada;
  firma?: string;
  calculadoEn?: string;
  detalle: string;
  /** Llamadas a Map Matching de este cálculo (0 si no se ajustó). */
  llamadas: number;
  /** La reserva no existe (la ruta responde 404). */
  reservaNoExiste?: boolean;
};
const res = (codigo: CodigoCalculo, extra: Partial<ResultadoCalculo> = {}): ResultadoCalculo =>
  ({ codigo, detalle: MOTIVO_CALCULO[codigo].texto, llamadas: 0, ...extra });

/**
 * Ajusta a la vía la traza de un servicio FINALIZADO y la guarda (si se puede). Los vehículos se
 * DERIVAN de la reserva, nunca de quien llama. En orden:
 *   configuración (sin_migracion · apagada) → token → la reserva (existe · finalizada · dentro de la
 *   ventana de DIAS_RASTREO) → la huella ESTRICTA (sin_filas · excede_servicio) → la fila guardada
 *   (vigente → ya_guardada; desactualizada sin recálculo → ya_guardada con la guardada) → presupuesto →
 *   candado (en_curso) → ajuste → resultadoDelCalculo → upsert SOLO si se puede guardar.
 * El candado se suelta SIEMPRE (finally) con las llamadas reales.
 */
export async function calcularYGuardar(
  reservaId: number, e: { origen: "apertura" | "cron"; sujeto: string; hastaMs?: number }, d?: DepsTraza,
): Promise<ResultadoCalculo> {
  const admin = adminDe(d);
  const config = await leerConfigTraza(d, { sinCache: true });
  if (config.estado === "sin_migracion") return res("sin_migracion");
  if (config.estado === "no_se_pudo_leer") return res("error", { detalle: "no se pudo leer la configuración del ajuste (gps_traza_config); vuelve a intentarlo" });
  if (!config.guardar) return res("apagada");
  const token = tokenDe(d);
  if (!token) return res("sin_token");

  const { data: rsv, error: errRsv } = await admin.from("reservas")
    .select("id,estado,fecha_servicio,vehiculo_id,vehiculo_tercero_id").eq("id", reservaId).maybeSingle();
  if (errRsv) { console.error("[gps-traza-ajustada] reserva:", errRsv.message ?? errRsv); return res("error"); }
  if (!rsv) return res("error", { reservaNoExiste: true, detalle: "el servicio no existe" });
  if (rsv.estado !== "finalizada") return res("no_finalizada");
  const ahora = ahoraDe(d);
  if (!fechaDentroDeVentana(rsv.fecha_servicio, ahora, DIAS_RASTREO)) return res("fuera_de_ventana");

  let filasOk: any[];
  try {
    const h = await huellaDelServicio(admin, {
      reservaId, vehiculoId: rsv.vehiculo_id ?? null, vehiculoTerceroId: rsv.vehiculo_tercero_id ?? null,
    }, ahora, { estricto: true });
    filasOk = h.filasOk;
  } catch (err: any) {
    console.error("[gps-traza-ajustada] huella:", err?.message ?? err);
    return res("error", { detalle: err instanceof LecturaHuellaFallida ? "no se pudieron leer todas las posiciones del servicio; vuelve a intentarlo" : MOTIVO_CALCULO.error.texto });
  }
  const limpio = huellaDeFilas(filasOk).limpio;
  if (limpio.length < 2) return res("sin_filas");
  if (limpio.length > MAX_FILAS_AJUSTE) return res("excede_servicio");
  const firma = firmaDeFilas(filasOk);

  let existente: FilaTraza | null;
  try { existente = await leerTrazaGuardada(reservaId, d); }
  catch (err: any) {
    if (err instanceof SinMigracionTraza) return res("sin_migracion");
    console.error("[gps-traza-ajustada] fila:", err?.message ?? err);
    return res("error");
  }
  const lectura = decidirLectura({
    finalizada: true, config: { estado: "ok", guardar: true }, lecturaCompleta: true,
    guardada: existente, firmaAhora: firma, nFilasAhora: filasOk.length,
    dentroDeVentana: true, tokenServidor: true, ahoraMs: ahora,
  });
  if (lectura.estado === "guardada" && lectura.traza) {
    return res("ya_guardada", { traza: lectura.traza, firma, calculadoEn: lectura.calculadoEn });
  }
  if (lectura.estado === "desactualizada" && !lectura.puedeCalcular && lectura.traza) {
    return res("ya_guardada", { traza: lectura.traza, firma: existente?.firma, calculadoEn: lectura.calculadoEn, detalle: lectura.detalle });
  }
  if (!lectura.puedeCalcular) return res("sin_filas");

  const estimado = llamadasEstimadas(limpio.length);
  let presupuesto: Presupuesto;
  try { presupuesto = await presupuestoDisponible(estimado, config, d); }
  catch (err: any) { console.error("[gps-traza-ajustada] presupuesto:", err?.message ?? err); return res("error"); }
  if (!presupuesto.ok) {
    return res("presupuesto_agotado", {
      detalle: presupuesto.motivo === "hora"
        ? `se agotó el presupuesto de consultas a Mapbox de esta hora (${presupuesto.gastoHora} de ${config.presupuestoHora}, gps_traza_config.presupuesto_hora)`
        : `se agotó el presupuesto de consultas a Mapbox de este mes (${presupuesto.gastoMes} de ${config.presupuestoMes}, gps_traza_config.presupuesto_mes)`,
    });
  }

  let candado: Candado;
  try { candado = await tomarCandado(reservaId, { origen: e.origen, sujeto: e.sujeto, estimado }, d); }
  catch (err: any) { console.error("[gps-traza-ajustada] candado:", err?.message ?? err); return res("error"); }
  if (!candado.ok) return res(candado.motivo === "en_curso" ? "en_curso" : "sin_migracion");

  let llamadas = 0;
  let salida: ResultadoCalculo = res("error");
  try {
    const ajuste = await ajustarServicioCompleto(limpio, token, d?.fetch ?? fetchMapboxServidor(), MAX_LLAMADAS_SERVICIO, {
      hastaMs: Math.min(ahoraDe(d) + PLAZO_CALCULO_MS, e.hastaMs ?? Infinity), reloj: () => ahoraDe(d),
    });
    llamadas = ajuste.llamadas;
    const r = resultadoDelCalculo(ajuste);
    if (r.codigo === "token_rechazado") console.error(`[gps-traza-ajustada] Mapbox rechazó la credencial del servidor en ${ajuste.rechazos} consultas (401/403: inválida o con restricción por dominio)`);
    if (r.codigo === "excede_servicio" && ajuste.porTiempo) {
      salida = res("excede_servicio", { llamadas, detalle: "el servicio es demasiado largo para ajustarlo en el tiempo de una consulta; no se guardó" });
    } else if (!r.guardar || !r.traza) {
      salida = res(r.codigo, { llamadas, traza: r.traza, firma });
    } else {
      const calculadoEn = new Date(ahoraDe(d)).toISOString();
      const fila = {
        reserva_id: reservaId, version: VERSION_AJUSTE, firma, n_filas: filasOk.length, ultimo_ts: ultimoTs(filasOk),
        traza: r.traza, vertices: r.traza.n, bytes: r.bytes, llamadas,
        recalculos: existente ? Math.min(32767, existente.recalculos + 1) : 0,
        origen: e.origen, calculado_en: calculadoEn,
      };
      const { error } = await admin.from("gps_traza_ajustada").upsert(fila, { onConflict: "reserva_id" });
      if (error) {
        console.error("[gps-traza-ajustada] guardar:", error.message ?? error);
        salida = res("calculada_sin_guardar", { llamadas, traza: r.traza, firma, detalle: "se ajustó, pero no se pudo guardar; se vuelve a intentar al abrirlo otra vez" });
      } else {
        salida = res("calculada", { llamadas, traza: r.traza, firma, calculadoEn });
      }
    }
  } catch (err: any) {
    console.error("[gps-traza-ajustada] cálculo:", err?.message ?? err);
    salida = res("error", { llamadas });
  } finally {
    await soltarCandado(candado.id, { llamadas, resultado: salida.codigo }, d);
  }
  return salida;
}

// ── El cron (opcional, nace apagado) ─────────────────────────────────────────────────────
/** Un servicio se precalcula solo si su última posición tiene más de esto (la cola offline del teléfono
 *  todavía puede estar entregando). Operativo, NO medido. */
export const ESPERA_COLA_CRON_MS = 60 * 60 * 1000;
/** Presupuesto de tiempo de una corrida del cron (maxDuration 60 s). */
export const PLAZO_TICK_MS = 45_000;
/** Un cálculo no se empieza si quedan menos de esto del plazo de la corrida. */
export const MIN_RESTANTE_TICK_MS = 10_000;
/** Lote del borrado y de las consultas `in`. */
export const LOTE_TRAZA = 200;
/** Lo que el cron ya intentó en las últimas 24 h no se vuelve a intentar (si no, un servicio sin
 *  posiciones ocuparía cada corrida para siempre). */
export const REINTENTO_CRON_MS = 24 * 3600 * 1000;

export type ResumenTick =
  | { estado: "sin_migracion" | "error" | "apagado" | "sin_token"; detalle: string }
  | { estado: "borrando"; borradas: number; quedan: boolean }
  | { estado: "ok"; candidatas: number; calculadas: number; saltadas_por_codigo: Record<string, number>; gasto_hora: number; gasto_mes: number };

/**
 * Una corrida del cron `/api/gps/traza-ajustada/tick`. En orden:
 *   · `borrar_guardadas` → borra por lotes de LOTE_TRAZA y termina (aunque `guardar` siga encendido).
 *   · `guardar` apagado o `precalcular_dias = 0` → no hace nada. Sin token → no hace nada.
 *   · Si no: finalizados de los últimos `precalcular_dias` días SIN fila guardada y sin intento del cron
 *     en las últimas 24 h, del más reciente al más antiguo, hasta `por_corrida` cálculos y PLAZO_TICK_MS.
 *     Solo los que dejaron de recibir posiciones hace más de ESPERA_COLA_CRON_MS (sin posiciones con su
 *     reserva —terceros—: solo de anteayer para atrás, porque su ventana dura hasta 26 h). Un presupuesto
 *     agotado corta la corrida. Lo que el cron intentó sin gastar consultas se anota en la bitácora
 *     (cerrado, 0 llamadas) para no repetirlo cada hora.
 * Las filas que ya existen (también las desactualizadas) no las toca: el recálculo lo pide quien abre.
 */
export async function tickTrazaAjustada(d?: DepsTraza): Promise<ResumenTick> {
  const admin = adminDe(d);
  const inicio = ahoraDe(d);
  const config = await leerConfigTraza(d, { sinCache: true });
  if (config.estado === "sin_migracion") return { estado: "sin_migracion", detalle: MOTIVO_CALCULO.sin_migracion.texto };
  if (config.estado === "no_se_pudo_leer") return { estado: "error", detalle: "no se pudo leer gps_traza_config" };

  if (config.borrarGuardadas) {
    let borradas = 0;
    while (ahoraDe(d) - inicio < PLAZO_TICK_MS) {
      const { data, error } = await admin.from("gps_traza_ajustada").select("reserva_id").order("reserva_id", { ascending: true }).limit(LOTE_TRAZA);
      if (error) return { estado: "error", detalle: `no se pudieron leer las trazas a borrar: ${error.message ?? error}` };
      const ids = (data ?? []).map((f: any) => f.reserva_id);
      if (!ids.length) return { estado: "borrando", borradas, quedan: false };
      const del = await admin.from("gps_traza_ajustada").delete().in("reserva_id", ids);
      if (del?.error) return { estado: "error", detalle: `no se pudieron borrar las trazas: ${del.error.message ?? del.error}` };
      borradas += ids.length;
    }
    return { estado: "borrando", borradas, quedan: true };
  }
  if (!config.guardar || config.precalcularDias <= 0) return { estado: "apagado", detalle: "gps_traza_config: guardar apagado o precalcular_dias = 0" };
  const token = tokenDe(d);
  if (!token) return { estado: "sin_token", detalle: MOTIVO_CALCULO.sin_token.texto };

  // Candidatas: finalizadas de la ventana (paginado, orden total).
  const hoy = new Date(inicio - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const restar = (f: string, dias: number) => new Date(Date.parse(`${f}T12:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
  const desde = restar(hoy, config.precalcularDias);
  const anteayer = restar(hoy, 2);
  const reservas: any[] = [];
  for (let off = 0; off < 10_000; off += 1000) {
    const { data, error } = await admin.from("reservas").select("id,fecha_servicio")
      .eq("estado", "finalizada").gte("fecha_servicio", desde).lte("fecha_servicio", hoy)
      .order("fecha_servicio", { ascending: false }).order("id", { ascending: false }).range(off, off + 999);
    if (error) return { estado: "error", detalle: `no se pudieron leer los servicios finalizados: ${error.message ?? error}` };
    reservas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const excluir = new Set<number>();
  for (let i = 0; i < reservas.length; i += LOTE_TRAZA) {
    const ids = reservas.slice(i, i + LOTE_TRAZA).map((r) => r.id);
    const { data, error } = await admin.from("gps_traza_ajustada").select("reserva_id").in("reserva_id", ids);
    if (error) return { estado: "error", detalle: `no se pudieron leer las trazas guardadas: ${error.message ?? error}` };
    for (const f of data ?? []) excluir.add(Number(f.reserva_id));
  }
  {
    const { data, error } = await admin.from("gps_traza_ajuste_intentos").select("reserva_id")
      .eq("origen", "cron").gte("empezado_en", new Date(inicio - REINTENTO_CRON_MS).toISOString());
    if (error) return { estado: "error", detalle: `no se pudo leer la bitácora de intentos: ${error.message ?? error}` };
    for (const f of data ?? []) excluir.add(Number(f.reserva_id));
  }
  const candidatas = reservas.filter((r) => !excluir.has(Number(r.id)));

  const saltadas: Record<string, number> = {};
  const saltar = (c: string) => { saltadas[c] = (saltadas[c] ?? 0) + 1; };
  let calculadas = 0, intentadas = 0;
  for (const r of candidatas) {
    if (intentadas >= config.porCorrida) break;
    if (inicio + PLAZO_TICK_MS - ahoraDe(d) < MIN_RESTANTE_TICK_MS) { saltar("sin_tiempo"); break; }
    const { data: ult, error: errUlt } = await admin.from("ubicaciones_gps").select("created_at")
      .eq("reserva_id", r.id).order("created_at", { ascending: false }).limit(1);
    if (errUlt) { saltar("error"); continue; }
    const ultTs = ult?.[0]?.created_at ? Date.parse(ult[0].created_at) : null;
    if (ultTs != null ? ahoraDe(d) - ultTs < ESPERA_COLA_CRON_MS : r.fecha_servicio > anteayer) { saltar("reciente"); continue; }
    intentadas++;
    const res = await calcularYGuardar(Number(r.id), { origen: "cron", sujeto: "cron", hastaMs: inicio + PLAZO_TICK_MS }, d);
    if (res.codigo === "calculada") calculadas++;
    else saltar(res.codigo);
    if (res.llamadas === 0 && res.codigo !== "en_curso") {
      // Anotado (cerrado, 0 llamadas) para no repetirlo en cada corrida durante 24 h.
      const ins = await admin.from("gps_traza_ajuste_intentos").insert({
        reserva_id: Number(r.id), origen: "cron", sujeto: "cron", llamadas: 0, resultado: res.codigo,
        empezado_en: new Date(ahoraDe(d)).toISOString(), terminado_en: new Date(ahoraDe(d)).toISOString(),
      });
      if (ins?.error) console.error("[gps-traza-ajustada] tick, anotar:", ins.error.message ?? ins.error);
    }
    if (res.codigo === "presupuesto_agotado") break;
  }
  let gasto = { gastoHora: 0, gastoMes: 0 };
  try { gasto = await presupuestoDisponible(0, config, d); } catch { /* el resumen sin gasto */ }
  return { estado: "ok", candidatas: candidatas.length, calculadas, saltadas_por_codigo: saltadas, gasto_hora: gasto.gastoHora, gasto_mes: gasto.gastoMes };
}
