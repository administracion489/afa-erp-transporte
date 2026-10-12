// lib/flota/excesos-datos.ts — SOLO SERVIDOR. Lee lo que mide lib/flota/excesos.ts (puro).
//
// LOS PUNTOS SE LEEN CON UN ÍNDICE, NUNCA RECORRIENDO LA TABLA: `fn_gps_puntos_rapidos`
// (supabase/gps-analitica-01-excesos.sql) devuelve los puntos con velocidad ≥ umbral de UN día en un solo
// valor JSON —esquiva el corte de 1000 filas de PostgREST— sobre el índice parcial `idx_gps_rapidos`.
// Si la función FALTA (`funcionQueFalta`), se responde `sin_migracion` y NO se cae a leer la tabla entera:
// sería un recorrido completo de la tabla más grande del ERP, compitiendo con la torre.
//
// Un día por llamada, de a 2 en paralelo, con un colchón de ±60 s en los bordes del rango y extensiones
// al final si un exceso seguía vivo: `detectarEnRango` (puro, con la lectura inyectada) lo hace exacto.
//
// LA EXPOSICIÓN («servicios con exceso / servicios prestados») sale de las reservas del rango finalizadas
// o en curso. Un error al leerlas LANZA: un ranking sin denominador mentiría. Los nombres, placas y
// clientes son un extra: si fallan, se avisa y se sigue.
//
// EL VELOCÍMETRO (tri-estado) sale de `fn_gps_velocimetro` para los conductores asignados y los que
// aparecen en los puntos. Si no se puede leer, cada uno queda «no se sabe» y se avisa: nunca un «0».
//
// No devuelve teléfonos.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados: las filas llegan como `any` */
import { createClient } from "@supabase/supabase-js";
import { funcionQueFalta, type ErrorSupabase } from "../columna-faltante";
import { identidadRuta } from "../ruta-identidad";
import {
  armarRespuestaExcesos, claveConductor, claveUnidad, completarConServicios, detectarEnRango, diaLima, diasEntre,
  fechaValida, puntosDeRpc, rangoLimaMs, respuestaVacia, velocimetroDe,
  COLCHON_S, MAX_DIAS_CONSULTA, MIGRACION_EXCESOS, RPC_PUNTOS_RAPIDOS, RPC_VELOCIMETRO, UMBRAL_MAX_KMH, UMBRAL_MIN_KMH,
  type ConductorExcesos, type DiaRecortado, type Episodio, type LecturaPuntos, type RespuestaExcesos,
  type ServicioExpuesto, type UnidadExcesos, type Velocimetro,
} from "./excesos";

/** Lo mínimo de un cliente de Supabase que usa el lector (la matriz le pasa uno falso). */
export type ClienteExcesos = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: ErrorSupabase }>;
  from: (tabla: string) => any;
};

let adminCache: ClienteExcesos | null = null;
/** El cliente service-role, creado al primer uso (la matriz importa este módulo sin credenciales). */
function admin(): ClienteExcesos {
  adminCache ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ) as unknown as ClienteExcesos;
  return adminCache;
}

/** Falta la migración: se responde `sin_migracion`, sin leer nada más. */
class FaltaMigracion extends Error {
  constructor(public funcion: string) { super(`falta la función ${funcion || "(sin nombre)"}`); this.name = "FaltaMigracion"; }
}

/** Un fallo de lectura con un mensaje para una persona (`message`) y el detalle crudo para el log. */
export class ErrorLecturaExcesos extends Error {
  constructor(mensaje: string, public detalle: string) { super(mensaje); this.name = "ErrorLecturaExcesos"; }
}

/** Estados de una reserva que cuentan como PRESTADA (la exposición). Un servicio que corrió y nadie
 *  cerró no entra al denominador; si tuvo un exceso, entra igual por el episodio. */
export const ESTADOS_PRESTADOS = ["finalizada", "en_curso"] as const;
const COLS_RESERVA = "id, codigo, fecha_servicio, hora_servicio, estado, cliente_id, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, ruta_nombre, origen, destino";
const LOTE_IN = 200;
const LOTE_VELOCIMETRO = 300;   // el tope de ids por arreglo de fn_gps_velocimetro
const PAUSA_REINTENTO_MS = 400;

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const partes = <T>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Una RPC que falló por otra cosa que la migración (el detalle crudo, para el log). */
class FalloRpc extends Error {
  constructor(public detalle: string) { super(detalle); this.name = "FalloRpc"; }
}

/** Una llamada RPC con UN reintento ante un error que no sea «falta la función». */
async function rpc(cliente: ClienteExcesos, fn: string, args: Record<string, unknown>): Promise<unknown> {
  for (let intento = 0; ; intento++) {
    const { data, error } = await cliente.rpc(fn, args);
    if (!error) return data;
    const falta = funcionQueFalta(error);
    if (falta != null) throw new FaltaMigracion(falta);
    if (intento >= 1) throw new FalloRpc(`${fn}: ${error.code ?? ""} ${error.message ?? ""}`.trim());
    await espera(PAUSA_REINTENTO_MS);
  }
}

/** Todas las filas de una consulta, paginadas con su orden total, o LANZA (una lista cortada mentiría). */
async function todasLasFilas(armar: () => any, que: string): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; off < 200_000; off += 1000) {
    const { data, error } = await armar().range(off, off + 999);
    if (error) throw new ErrorLecturaExcesos(`No se pudieron leer ${que}.`, `${que}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Filas por id, en lotes; un error se AVISA (son datos accesorios) y devuelve lo leído. */
async function porIds(cliente: ClienteExcesos, tabla: string, cols: string, ids: readonly number[], avisos: string[], aviso: string): Promise<any[]> {
  const out: any[] = [];
  let fallo = false;
  for (const lote of partes([...new Set(ids)], LOTE_IN)) {
    const { data, error } = await cliente.from(tabla).select(cols).in("id", lote);
    if (error) { fallo = true; console.error(`[flota/excesos] ${tabla}:`, error.message); continue; }
    out.push(...(data ?? []));
  }
  if (fallo) avisos.push(aviso);
  return out;
}

const idDe = (clave: string) => Number(clave.slice(2));
const clavesDe = (claves: Iterable<string>, prefijo: "p:" | "t:") => [...new Set([...claves].filter((k) => k.startsWith(prefijo)).map(idDe))].sort((a, b) => a - b);

function servicioDe(r: any, prestado: boolean): ServicioExpuesto {
  return {
    reservaId: Number(r.id),
    fecha: r.fecha_servicio ?? null,
    hora: r.hora_servicio ? String(r.hora_servicio).slice(0, 5) : null,
    codigo: r.codigo != null ? String(r.codigo) : null,
    estado: r.estado ?? null,
    prestado,
    // El propio primero, como /api/seguimiento y `conductorDeReserva`.
    conductor: claveConductor(r.conductor_id, null) ?? claveConductor(null, r.conductor_tercero_id),
    vehiculo: claveUnidad(r.vehiculo_id, r.vehiculo_tercero_id),
    cliente: null,
    ruta: identidadRuta(r),
  };
}

/**
 * Los excesos de [desde, hasta] (días de Lima, como mucho MAX_DIAS_CONSULTA) con el umbral dado. Devuelve
 * la respuesta COMPLETA (con los de fuera de servicio; la ruta los recorta con `vistaRespuesta`).
 * Sin la migración: `sin_migracion` y ningún episodio. Un error de lectura LANZA `ErrorLecturaExcesos`.
 */
export async function excesosDelRango(
  o: { desde: string; hasta: string; umbral: number },
  cliente: ClienteExcesos = admin(),
): Promise<RespuestaExcesos> {
  const { desde, hasta, umbral } = o;
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta || diasEntre(desde, hasta) + 1 > MAX_DIAS_CONSULTA) {
    throw new ErrorLecturaExcesos(`Rango inválido: ${desde} a ${hasta} (como mucho ${MAX_DIAS_CONSULTA} días).`, "rango");
  }
  if (!Number.isInteger(umbral) || umbral < UMBRAL_MIN_KMH || umbral > UMBRAL_MAX_KMH) {
    throw new ErrorLecturaExcesos(`Umbral inválido: ${umbral} (entre ${UMBRAL_MIN_KMH} y ${UMBRAL_MAX_KMH} km/h).`, "umbral");
  }
  const { desdeTs, hastaTs } = rangoLimaMs(desde, hasta);
  const avisos: string[] = [];

  // ── 1) Los puntos rápidos, día por día, y los episodios ─────────────────────
  const leer = async (a: number, b: number): Promise<LecturaPuntos> => {
    let data: unknown;
    try {
      data = await rpc(cliente, RPC_PUNTOS_RAPIDOS, { p_desde: iso(a), p_hasta: iso(b), p_umbral: umbral });
    } catch (e) {
      if (e instanceof FalloRpc) {
        throw new ErrorLecturaExcesos(`No se pudieron leer las posiciones del ${diaLima(Math.max(a, desdeTs))}. Reintenta en unos minutos; si sigue, revisa que ${MIGRACION_EXCESOS} esté corrido completo.`, e.detalle);
      }
      throw e;
    }
    const d = data as { recortado?: unknown; puntos?: unknown } | null;
    if (!d || typeof d !== "object" || !Array.isArray(d.puntos)) {
      throw new ErrorLecturaExcesos(`La lectura de posiciones del ${diaLima(Math.max(a, desdeTs))} vino con otra forma: revisa que ${MIGRACION_EXCESOS} sea la versión de este despliegue.`, `${RPC_PUNTOS_RAPIDOS}: respuesta sin "puntos"`);
    }
    return { puntos: puntosDeRpc(d.puntos), recortado: d.recortado === true };
  };
  let det: Awaited<ReturnType<typeof detectarEnRango>>;
  try {
    det = await detectarEnRango(leer, { desdeTs, hastaTs, umbral, colchonMs: COLCHON_S * 1000, paralelo: 2 });
  } catch (e) {
    if (e instanceof FaltaMigracion) return respuestaVacia({ desde, hasta, umbral, sin_migracion: MIGRACION_EXCESOS });
    throw e;
  }
  const diasRecortados: DiaRecortado[] = det.ventanas.filter((w) => w.recortado)
    .map((w) => ({ fecha: diaLima(Math.min(Math.max(w.desdeTs, desdeTs), w.extension ? w.desdeTs : hastaTs - 1)), extension: w.extension }));
  if (det.sinIdentidad > 0) {
    avisos.push(`${det.sinIdentidad} posición(es) rápidas no dicen de qué conductor, servicio ni vehículo son: no forman ningún exceso.`);
  }

  // ── 2) La exposición: los servicios prestados del rango, y los que tocó un episodio ──
  const prestadas = await todasLasFilas(
    () => cliente.from("reservas").select(COLS_RESERVA)
      .gte("fecha_servicio", desde).lte("fecha_servicio", hasta).in("estado", [...ESTADOS_PRESTADOS])
      .order("fecha_servicio", { ascending: true }).order("id", { ascending: true }),
    "los servicios del periodo (reintenta en unos minutos)",
  );
  const servicios = new Map<number, ServicioExpuesto>();
  const reservaDe = new Map<number, any>();
  for (const r of prestadas) { servicios.set(Number(r.id), servicioDe(r, true)); reservaDe.set(Number(r.id), r); }
  const tocadas = [...new Set(det.episodios.map((e) => e.reservaId).filter((id): id is number => id != null && !servicios.has(id)))];
  if (tocadas.length) {
    for (const r of await porIds(cliente, "reservas", COLS_RESERVA, tocadas, avisos, "No se pudieron leer todos los servicios donde hubo un exceso: algunos salen sin su ruta ni su cliente.")) {
      servicios.set(Number(r.id), servicioDe(r, false));
      reservaDe.set(Number(r.id), r);
    }
  }
  const lista = [...servicios.values()];
  const episodios: Episodio[] = completarConServicios(det.episodios, lista);

  // ── 3) El velocímetro de cada conductor (tri-estado) ───────────────────────
  const claves = new Set<string>();
  for (const s of lista) if (s.prestado && s.conductor) claves.add(s.conductor);
  for (const e of episodios) if (e.conductor && e.codigo === "exceso") claves.add(e.conductor);
  const velocimetro = new Map<string, Velocimetro>();
  const propios = clavesDe(claves, "p:"), terceros = clavesDe(claves, "t:");
  try {
    const nLotes = Math.max(Math.ceil(propios.length / LOTE_VELOCIMETRO), Math.ceil(terceros.length / LOTE_VELOCIMETRO));
    for (let i = 0; i < nLotes; i++) {
      const data = await rpc(cliente, RPC_VELOCIMETRO, {
        p_desde: iso(desdeTs), p_hasta: iso(hastaTs),
        p_propios: propios.slice(i * LOTE_VELOCIMETRO, (i + 1) * LOTE_VELOCIMETRO),
        p_terceros: terceros.slice(i * LOTE_VELOCIMETRO, (i + 1) * LOTE_VELOCIMETRO),
      });
      for (const f of (Array.isArray(data) ? data : []) as any[]) {
        const k = f?.tabla === "conductores" ? claveConductor(f.conductor_id, null)
          : f?.tabla === "conductores_tercero" ? claveConductor(null, f.conductor_id) : null;
        if (k) velocimetro.set(k, velocimetroDe(f.hay_puntos ?? null, f.hay_velocidad ?? null));
      }
    }
  } catch (e) {
    console.error("[flota/excesos] velocímetro:", e instanceof FalloRpc ? e.detalle : e);
    avisos.push(e instanceof FaltaMigracion
      ? `Falta la función ${RPC_VELOCIMETRO} (${MIGRACION_EXCESOS}): no se puede comprobar qué teléfonos reportan la velocidad.`
      : "No se pudo comprobar qué teléfonos reportan la velocidad: esos conductores salen «no se sabe».");
    velocimetro.clear();
  }

  // ── 4) Nombres, placas y clientes (un extra: si fallan, se avisa) ──────────
  const [condP, condT, vehP, vehT, clientes] = await Promise.all([
    porIds(cliente, "conductores", "id, nombre", clavesDe(claves, "p:"), avisos, "No se pudieron leer todos los nombres de conductores."),
    porIds(cliente, "conductores_tercero", "id, nombre", clavesDe(claves, "t:"), avisos, "No se pudieron leer todos los nombres de conductores tercerizados."),
    porIds(cliente, "vehiculos", "id, placa", clavesDe(unidadesDe(lista, episodios), "p:"), avisos, "No se pudieron leer todas las placas."),
    porIds(cliente, "vehiculos_tercero", "id, placa", clavesDe(unidadesDe(lista, episodios), "t:"), avisos, "No se pudieron leer todas las placas de unidades tercerizadas."),
    porIds(cliente, "clientes", "id, nombre, empresa",
      [...new Set([...reservaDe.values()].map((r) => Number(r.cliente_id)).filter((x) => Number.isSafeInteger(x) && x > 0))],
      avisos, "No se pudieron leer todos los nombres de clientes."),
  ]);
  const nombre = new Map<string, string | null>([
    ...condP.map((c: any) => [`p:${c.id}`, c.nombre ?? null] as [string, string | null]),
    ...condT.map((c: any) => [`t:${c.id}`, c.nombre ?? null] as [string, string | null]),
  ]);
  const placa = new Map<string, string | null>([
    ...vehP.map((v: any) => [`p:${v.id}`, v.placa ?? null] as [string, string | null]),
    ...vehT.map((v: any) => [`t:${v.id}`, v.placa ?? null] as [string, string | null]),
  ]);
  const clienteNombre = new Map<number, string | null>(clientes.map((c: any) => [Number(c.id), c.empresa || c.nombre || null]));
  for (const s of lista) {
    const cid = Number(reservaDe.get(s.reservaId)?.cliente_id);
    s.cliente = clienteNombre.get(cid) ?? null;
  }
  const conductores: ConductorExcesos[] = [...claves].map((k) => ({
    clave: k, nombre: nombre.get(k) ?? null, tercero: k.startsWith("t:"), velocimetro: velocimetro.get(k) ?? "no_se_sabe",
  }));
  const unidades: UnidadExcesos[] = [...unidadesDe(lista, episodios)].map((k) => ({ clave: k, placa: placa.get(k) ?? null, tercero: k.startsWith("t:") }));

  return armarRespuestaExcesos({
    desde, hasta, umbral, medidoEn: new Date().toISOString(),
    episodios, servicios: lista, conductores, unidades,
    avisos, diasRecortados, cortados: det.cortados, puntosSinIdentidad: det.sinIdentidad,
  });
}

/** Las unidades que interesan: las de los servicios prestados y las de los excesos (dentro y fuera). */
function unidadesDe(servicios: readonly ServicioExpuesto[], eps: readonly Episodio[]): Set<string> {
  const out = new Set<string>();
  for (const s of servicios) if (s.prestado && s.vehiculo) out.add(s.vehiculo);
  for (const e of eps) if (e.codigo === "exceso" && e.vehiculo) out.add(e.vehiculo);
  return out;
}
