// lib/monitoreo-datos.ts — SOLO SERVIDOR. El que LEE para el mapa de /monitoreo: las unidades
// vigentes, la última posición de cada una y el umbral del «no inició». Recibe el cliente de
// Supabase INYECTADO (service-role en /api/monitoreo/flota; uno falso en
// scripts/prueba-monitoreo-datos.mts). No decide nada: qué fila es la última, qué edad tiene y
// cómo se pinta lo decide lib/monitoreo-estado.ts (puro).
//
// ── POR QUÉ UNA CONSULTA POR UNIDAD ────────────────────────────────────────────────────────
// La pantalla anterior pedía «las 500 filas más recientes de toda la flota»: con 20 buses
// transmitiendo cada pocos segundos eso cubre 3-4 minutos, y toda unidad parada desaparecía. La
// pregunta del mapa es «la ÚLTIMA posición de CADA unidad», y la única forma barata de contestarla
// sin una función SQL es una consulta por unidad que baja por su índice (idx_gps_vehiculo_fecha /
// idx_gps_vehiculo_ter_fecha, supabase/retrasos.sql) y se corta en FILAS_POR_UNIDAD filas.
//
// ── UNA LECTURA QUE FALLA NO ES «SIN POSICIÓN» ─────────────────────────────────────────────
// Una consulta que vence, que da error o que no alcanzó a lanzarse dentro del presupuesto va a
// `sinLeer`, NUNCA al mapa de posiciones con null: el motor la juzga `no_se_pudo_leer` y la pantalla
// no afirma que la unidad no transmite. Leer de menos es visible; afirmar un vacío por un error no.
//
// ── LAS COLUMNAS ACCESORIAS SE SUELTAN POR NOMBRE ──────────────────────────────────────────
// `fix_ts`, `recibido_en`, `simulado` y `precision_m` son de migraciones que el deploy no corre. Si
// el error NOMBRA una (`faltaAlguna`, lib/columna-faltante.ts), se suelta esa y solo esa y la consulta
// se repite; si es `simulado`, se quita también el filtro `.or(...)` que la usa. Lo detectado se
// MEMORIZA por cliente (en la ruta, por instancia del servidor): la siguiente petición ya no paga el
// error. Ante cualquier otro error NO se reintenta a ciegas: la unidad va a `sinLeer`.
//
// ── LA IDENTIDAD, IGUAL QUE EL MOTOR ───────────────────────────────────────────────────────
// `claveUnidad` (lib/flota/excesos.ts) le da precedencia al TERCERO: una fila con los dos ids es de
// «t:ID». Por eso la consulta de una unidad propia pide además `vehiculo_tercero_id is null` (si no,
// esas filas ocuparían su cupo de FILAS_POR_UNIDAD sin ser suyas), y en memoria se descarta toda
// fila cuya unidad no sea la consultada: la posición que sale nunca es de otra unidad.
//
// Matriz: npx tsx scripts/prueba-monitoreo-datos.mts

import { faltaAlguna } from "./columna-faltante";
import { claveUnidad } from "./flota/excesos";
import { fechaLima } from "./alertas-horario";
import {
  DIAS_ULTIMA_POSICION, FILAS_POR_UNIDAD, NO_INICIO_MIN_DEFECTO,
  ultimaPosicion, unidadDeFila, unidadVigente,
  type FilaGpsMonitoreo, type PosicionUnidad, type PuntoMonitoreo, type RespuestaFlotaMonitoreo,
} from "./monitoreo-estado";

// ══ CONSTANTES OPERATIVAS (no medidas) ════════════════════════════════════════════════════

/** Consultas de GPS a la vez. Con ~190 unidades y ~100 ms por consulta, ~2 s en total. */
export const CONCURRENCIA_DEFECTO = 12;
/** Tope de UNA consulta de GPS. Una unidad que no contesta en esto va a `sinLeer`. */
export const TOPE_CONSULTA_MS = 4_000;
/** Tiempo para LANZAR consultas de GPS; pasado esto, las que faltan van a `sinLeer` y `parcial`. */
export const PRESUPUESTO_MS = 20_000;
/** Tope de una página de la flota o de la fila del umbral. */
const TOPE_TABLA_MS = 8_000;
const PAGINA = 1000;
const DIA_MS = 86_400_000;

/** Columnas de `ubicaciones_gps` de migraciones accesorias, que se sueltan si el error las nombra. */
export const COLS_OPCIONALES_GPS = ["fix_ts", "recibido_en", "simulado", "precision_m"] as const;
export type ColOpcionalGps = (typeof COLS_OPCIONALES_GPS)[number];
/** Todo lo que se pide, en este orden (las opcionales que falten se quitan). */
const COLS_GPS = [
  "lat", "lng", "created_at", "fix_ts", "recibido_en", "simulado", "precision_m", "estado",
  "reserva_id", "velocidad", "vehiculo_id", "vehiculo_tercero_id", "conductor_id", "conductor_tercero_id",
] as const;
const ES_OPCIONAL = new Set<string>(COLS_OPCIONALES_GPS);

// ══ EL CLIENTE Y SUS RESPUESTAS ═══════════════════════════════════════════════════════════

/** Lo mínimo de un cliente de Supabase que usa este módulo (la matriz le pasa uno falso). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClienteMonitoreo = { from: (tabla: string) => any };

type ErrorLectura = { code?: string | null; message?: string | null };
type Resultado = { data: unknown; error: ErrorLectura | null };

/**
 * Ejecuta una consulta con un tope DURO de tiempo. `abortSignal` corta la petición HTTP, pero no se
 * confía solo en él: una promesa que no se resuelve dejaría colgado todo el cálculo. Nunca lanza:
 * un fallo vuelve como `error`.
 */
async function ejecutar(consulta: PromiseLike<Resultado>, topeMs: number): Promise<Resultado> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vencida = new Promise<Resultado>((ok) => {
      timer = setTimeout(() => ok({ data: null, error: { code: "TIEMPO", message: `sin respuesta en ${topeMs} ms` } }), topeMs);
    });
    const respuesta = Promise.resolve(consulta).then(
      (r) => (r && typeof r === "object" ? r : { data: null, error: { message: "respuesta vacía" } }),
    );
    return await Promise.race([respuesta, vencida]);
  } catch (e) {
    const err = e as { message?: string; code?: string } | null;
    return { data: null, error: { code: err?.code ?? null, message: err?.message ?? String(e) } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const senal = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

/** Pone el abort al constructor si lo hay (los dos clientes reales lo tienen). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conAbort(q: any, ms: number): any {
  const s = senal(ms);
  return s && typeof q?.abortSignal === "function" ? q.abortSignal(s) : q;
}

// ══ LAS UNIDADES VIGENTES ═════════════════════════════════════════════════════════════════

export type TablaUnidad = "vehiculos" | "vehiculos_tercero";
export type UnidadMonitoreo = {
  /** «p:ID» / «t:ID» (`claveUnidad`): los ids de las dos tablas se solapan. */
  clave: string;
  tabla: TablaUnidad;
  id: number;
};

type FilaFicha = { id: unknown; estado?: unknown };

/** Lee una tabla de la flota ENTERA (paginada, orden por id). Si `estado` no existe, se suelta y
 *  todas cuentan como vigentes; cualquier otro error LANZA. */
async function leerFlota(admin: ClienteMonitoreo, tabla: TablaUnidad): Promise<FilaFicha[]> {
  let columnas = ["id", "estado"];
  for (let intento = 0; intento < 2; intento++) {
    const filas: FilaFicha[] = [];
    let fallo: ErrorLectura | null = null;
    for (let desde = 0; desde < 200_000; desde += PAGINA) {
      const q = admin.from(tabla).select(columnas.join(", ")).order("id", { ascending: true })
        .range(desde, desde + PAGINA - 1);
      const { data, error } = await ejecutar(conAbort(q, TOPE_TABLA_MS), TOPE_TABLA_MS);
      if (error) { fallo = error; break; }
      const pagina = Array.isArray(data) ? (data as FilaFicha[]) : [];
      filas.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    if (!fallo) return filas;
    if (columnas.includes("estado") && faltaAlguna(fallo, ["estado"])) {
      columnas = ["id"];
      continue;
    }
    throw new Error(`${tabla}: ${fallo.message ?? "no se pudo leer"}`);
  }
  throw new Error(`${tabla}: no se pudo leer ni sin la columna estado`);
}

/**
 * Las unidades que siguen en la flota (`unidadVigente`: solo `inactivo` las saca; sin estado,
 * vigentes), propias y tercerizadas, ordenadas por clave. LANZA si una tabla no se puede leer: una
 * lista vacía por error se leería como «no hay flota» y el mapa quedaría en blanco sin decir por qué.
 */
export async function unidadesVigentes(admin: ClienteMonitoreo): Promise<UnidadMonitoreo[]> {
  const [propias, terceros] = await Promise.all([leerFlota(admin, "vehiculos"), leerFlota(admin, "vehiculos_tercero")]);
  const out: UnidadMonitoreo[] = [];
  const vistas = new Set<string>();
  const sumar = (tabla: TablaUnidad, filas: FilaFicha[]) => {
    for (const f of filas) {
      if (!unidadVigente(f?.estado)) continue;
      const clave = tabla === "vehiculos" ? claveUnidad(f?.id, null) : claveUnidad(null, f?.id);
      if (!clave || vistas.has(clave)) continue;
      vistas.add(clave);
      out.push({ clave, tabla, id: Number(f.id) });
    }
  };
  sumar("vehiculos", propias);
  sumar("vehiculos_tercero", terceros);
  return out.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
}

// ══ LA ÚLTIMA POSICIÓN DE CADA UNIDAD ═════════════════════════════════════════════════════

export type OpcionesLectura = {
  /** El instante del cálculo: fija la ventana de DIAS_ULTIMA_POSICION y la edad en el motor. */
  ahoraMs: number;
  concurrencia?: number;
  topeConsultaMs?: number;
  presupuestoMs?: number;
  /** Reloj para medir el presupuesto (la matriz lo simula). Por defecto, Date.now. */
  reloj?: () => number;
};

export type LecturaPosiciones = {
  /** Solo las unidades que SÍ se leyeron: null = se leyó y no tiene posición válida en la ventana. */
  posiciones: Map<string, PosicionUnidad | null>;
  /** Las que fallaron, vencieron o no alcanzaron a lanzarse. Disjunto de `posiciones`. */
  sinLeer: string[];
  /** Columnas accesorias que esta base no tiene (se soltaron). */
  columnasFaltantes: string[];
  /** Se agotó el presupuesto antes de leerlas todas. */
  parcial: boolean;
};

/** Columnas accesorias que cada cliente ya demostró no tener. Por cliente y no global: en la ruta el
 *  cliente es uno por instancia, y la matriz usa uno distinto por caso. Si alguien corre la
 *  migración, la instancia las vuelve a pedir cuando se recicle. */
const faltantesPorCliente = new WeakMap<object, Set<ColOpcionalGps>>();
function faltantesDe(admin: ClienteMonitoreo): Set<ColOpcionalGps> {
  let s = faltantesPorCliente.get(admin);
  if (!s) { s = new Set(); faltantesPorCliente.set(admin, s); }
  return s;
}

/** Lo que el cálculo ya sabe que falta (para la respuesta). */
export function columnasFaltantesDe(admin: ClienteMonitoreo): string[] {
  return [...faltantesDe(admin)].sort();
}

type ResultadoUnidad =
  | { ok: true; posicion: PosicionUnidad | null }
  | { ok: false; motivo: "error" | "presupuesto" };

/**
 * Lee las últimas FILAS_POR_UNIDAD filas de cada unidad (no simuladas, con lat, de los últimos
 * DIAS_ULTIMA_POSICION días) con concurrencia acotada, y de ellas la posición la elige
 * `ultimaPosicion`. Lo que falla o no alcanza a leerse va a `sinLeer` (nunca a «sin posición»).
 */
export async function leerUltimasPosiciones(
  admin: ClienteMonitoreo,
  unidades: UnidadMonitoreo[],
  o: OpcionesLectura,
): Promise<LecturaPosiciones> {
  const ahoraMs = o.ahoraMs;
  const concurrencia = Math.max(1, Math.floor(Number(o.concurrencia ?? CONCURRENCIA_DEFECTO)) || 1);
  const topeMs = Math.max(1, Number(o.topeConsultaMs ?? TOPE_CONSULTA_MS) || TOPE_CONSULTA_MS);
  const presupuestoMs = Math.max(0, Number(o.presupuestoMs ?? PRESUPUESTO_MS));
  const reloj = o.reloj ?? Date.now;
  const desdeIso = new Date(ahoraMs - DIAS_ULTIMA_POSICION * DIA_MS).toISOString();
  const faltan = faltantesDe(admin);
  const inicio = reloj();
  const quedaPresupuesto = () => reloj() - inicio < presupuestoMs;

  async function leerUna(u: UnidadMonitoreo): Promise<ResultadoUnidad> {
    // Una vuelta por cada columna que se pueda soltar, más la buena: nunca un bucle sin fin.
    for (let intento = 0; intento <= COLS_OPCIONALES_GPS.length; intento++) {
      if (intento > 0 && !quedaPresupuesto()) return { ok: false, motivo: "presupuesto" };
      const columnas = COLS_GPS.filter((c) => !ES_OPCIONAL.has(c) || !faltan.has(c as ColOpcionalGps));
      let q = admin.from("ubicaciones_gps").select(columnas.join(", "))
        .eq(u.tabla === "vehiculos" ? "vehiculo_id" : "vehiculo_tercero_id", u.id);
      if (u.tabla === "vehiculos") q = q.is("vehiculo_tercero_id", null);
      q = q.gte("created_at", desdeIso).not("lat", "is", null);
      if (!faltan.has("simulado")) q = q.or("simulado.is.null,simulado.eq.false");
      q = q.order("created_at", { ascending: false }).limit(FILAS_POR_UNIDAD);
      const { data, error } = await ejecutar(conAbort(q, topeMs), topeMs);
      if (error) {
        // Solo se reintenta si el error nombra una columna accesoria que ESTA consulta pidió (otra
        // consulta en paralelo pudo haberla soltado ya: entonces basta con repetir sin ella).
        // Cualquier otro error —otra columna, la red, un permiso, el tope— no se reintenta a ciegas.
        const col = faltaAlguna(error, COLS_OPCIONALES_GPS);
        if (col && (columnas as readonly string[]).includes(col)) { faltan.add(col); continue; }
        return { ok: false, motivo: "error" };
      }
      const filas = (Array.isArray(data) ? (data as FilaGpsMonitoreo[]) : [])
        .filter((f) => unidadDeFila(f) === u.clave);
      return { ok: true, posicion: ultimaPosicion(filas, ahoraMs) };
    }
    return { ok: false, motivo: "error" };
  }

  const posiciones = new Map<string, PosicionUnidad | null>();
  const sinLeer = new Set<string>();
  let parcial = false;
  let siguiente = 0;

  async function trabajador(): Promise<void> {
    for (;;) {
      if (siguiente >= unidades.length) return;
      if (!quedaPresupuesto()) return;                 // las que quedan se cuentan abajo
      const u = unidades[siguiente++];
      let r: ResultadoUnidad;
      try {
        r = await leerUna(u);
      } catch {
        r = { ok: false, motivo: "error" };
      }
      if (r.ok) posiciones.set(u.clave, r.posicion);
      else {
        sinLeer.add(u.clave);
        if (r.motivo === "presupuesto") parcial = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrencia, Math.max(1, unidades.length)) }, () => trabajador()));
  for (const u of unidades) {
    if (posiciones.has(u.clave) || sinLeer.has(u.clave)) continue;
    sinLeer.add(u.clave);
    parcial = true;
  }
  return {
    posiciones,
    sinLeer: [...sinLeer].sort(),
    columnasFaltantes: columnasFaltantesDe(admin),
    parcial,
  };
}

// ══ EL UMBRAL DEL «NO INICIÓ» ═════════════════════════════════════════════════════════════

export type UmbralNoInicio = { min: number; fuente: "config" | "defecto" };

/**
 * `alerta_config.umbral` de la clave `no_inicio` (el mismo que usa el tick: `cfg.umbral ??
 * UMBRAL_DEFECTO.no_inicio`). Sin fila, sin valor, con un valor que no es un número ≥ 0, o si la
 * lectura falla: NO_INICIO_MIN_DEFECTO con fuente «defecto». No mira `activo`: el mapa marca el
 * servicio sin iniciar aunque el WhatsApp de esa tarjeta esté apagado.
 */
export async function umbralNoInicio(admin: ClienteMonitoreo, topeMs = TOPE_CONSULTA_MS): Promise<UmbralNoInicio> {
  const defecto: UmbralNoInicio = { min: NO_INICIO_MIN_DEFECTO, fuente: "defecto" };
  try {
    const q = conAbort(admin.from("alerta_config").select("umbral").eq("clave", "no_inicio"), topeMs).maybeSingle();
    const { data, error } = await ejecutar(q, topeMs);
    if (error || !data || typeof data !== "object") return defecto;
    const crudo = (data as { umbral?: unknown }).umbral;
    if (crudo == null || crudo === "" || typeof crudo === "boolean") return defecto;
    const n = Number(crudo);
    return Number.isFinite(n) && n >= 0 ? { min: n, fuente: "config" } : defecto;
  } catch {
    return defecto;
  }
}

// ══ LA RESPUESTA DE /api/monitoreo/flota ══════════════════════════════════════════════════

/** Copia EXACTA de un punto: si el motor gana un campo, tsc obliga a decidir aquí si viaja. */
function proyectarPunto(p: PuntoMonitoreo): PuntoMonitoreo {
  return {
    lat: p.lat, lng: p.lng,
    posicionTs: p.posicionTs, puntoTs: p.puntoTs, enlaceTs: p.enlaceTs,
    estado: p.estado, reservaId: p.reservaId, conductor: p.conductor,
    velocidadKmh: p.velocidadKmh, precisionM: p.precisionM,
    orden: p.orden,
  };
}

/** Copia EXACTA de una posición: nada que no esté en el contrato sale al navegador. */
export function proyectarPosicion(p: PosicionUnidad): PosicionUnidad {
  return {
    unidad: p.unidad,
    lat: p.lat, lng: p.lng,
    posicionTs: p.posicionTs, enlaceTs: p.enlaceTs,
    estado: p.estado, reservaId: p.reservaId, conductor: p.conductor,
    velocidadKmh: p.velocidadKmh, precisionM: p.precisionM,
    aproximada: p.aproximada,
    cierreTs: p.cierreTs,
    ultimo: proyectarPunto(p.ultimo),
    respaldo: p.respaldo ? proyectarPunto(p.respaldo) : null,
  };
}

/** Arma la respuesta con EXACTAMENTE las claves de `RespuestaFlotaMonitoreo`. */
export function armarRespuestaFlota(e: {
  ahoraMs: number; noInicio: UmbralNoInicio; lectura: LecturaPosiciones;
}): RespuestaFlotaMonitoreo {
  const posiciones = [...e.lectura.posiciones.values()]
    .filter((p): p is PosicionUnidad => p != null)
    .map(proyectarPosicion)
    .sort((a, b) => (a.unidad < b.unidad ? -1 : a.unidad > b.unidad ? 1 : 0));
  return {
    generado_en: new Date(e.ahoraMs).toISOString(),
    hoy: fechaLima(e.ahoraMs),
    ventana_dias: DIAS_ULTIMA_POSICION,
    no_inicio_min: e.noInicio.min,
    fuente_no_inicio: e.noInicio.fuente,
    posiciones,
    sin_leer: [...e.lectura.sinLeer].sort(),
    parcial: e.lectura.parcial === true,
    columnas_faltantes: [...e.lectura.columnasFaltantes].sort(),
  };
}

/**
 * El cálculo entero de /api/monitoreo/flota. LANZA si no se puede leer la flota (la ruta responde
 * 500); un fallo de GPS de una unidad, o del umbral, no lanza.
 */
export async function flotaMonitoreo(
  admin: ClienteMonitoreo,
  o: Omit<OpcionesLectura, "ahoraMs"> & { ahoraMs?: number },
): Promise<RespuestaFlotaMonitoreo> {
  const ahoraMs = o.ahoraMs ?? Date.now();
  const [unidades, noInicio] = await Promise.all([unidadesVigentes(admin), umbralNoInicio(admin)]);
  const lectura = await leerUltimasPosiciones(admin, unidades, { ...o, ahoraMs });
  return armarRespuestaFlota({ ahoraMs, noInicio, lectura });
}
