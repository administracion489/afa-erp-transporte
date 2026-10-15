// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/campo-datos.ts — LECTOR + ESCRITOR (service-role) del trabajo en CAMPO (Fase 2).
// NO es puro (lee y escribe la base); la DECISIÓN de si hay autorización vigente la hace el
// motor puro lib/rrhh/campo.ts, al que esto le entrega las filas. La identidad del empleado
// la pone SIEMPRE el endpoint (el token), nunca estos lectores ni el cuerpo del cliente.
//
// La migración supabase/rrhh-02-campo-gps.sql EL DEPLOY NO LA CORRE. Por eso:
//   · rrhh_autorizacion_campo puede faltar ENTERA (nadie corrió el SQL) → `sinMigracion`.
//   · ubicaciones_gps es la tabla NÚCLEO del rastreo (siempre existe), pero la columna
//     discriminadora `empleado_usuario_id` es de esta migración. Si falta, no hay posiciones
//     de campo que leer ni dónde escribirlas → `sinMigracion` (NO se suelta: una fila de campo
//     sin el discriminador quedaría con los 4 FK en NULL, indistinguible de basura y fuera de
//     toda lectura). Las columnas ACCESORIAS de ubicaciones_gps (p. ej. `fix_ts`, de otra
//     migración) sí se sueltan por nombre y se reintenta (lib/columna-faltante.ts).
//
// Una lectura que falla por OTRA cosa (red, permiso) LANZA: no es «no hay posiciones». Y un
// INSERT ante otro error NO se reintenta a ciegas (un INSERT reintentado duplica).
// ──────────────────────────────────────────────────────────────────────────────

import { tablaFaltante, columnaFaltante, faltaAlguna } from "@/lib/columna-faltante";
import { estadoAutorizacion, type AutorizacionCampo } from "./campo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = { from: (t: string) => any };

/** La migración que crea el discriminador y la tabla de autorización. */
export const SQL_CAMPO = "supabase/rrhh-02-campo-gps.sql";

const PAGINA = 1000;
const TOPE_PAGINAS = 60; // tope duro de barrido (60k filas por ventana)

/** La columna discriminadora de una posición de CAMPO. Su ausencia = falta la migración. */
export const COL_DISCRIMINADOR = "empleado_usuario_id";

/** Columnas accesorias de `ubicaciones_gps` que se sueltan por nombre si el error las nombra
 *  (son de migraciones que el deploy tampoco corre). El discriminador NO está aquí a propósito. */
const COLS_OPCIONALES_GPS = ["fix_ts"] as const;

/** Máximo de puntos de rastro reciente que se devuelven POR EMPLEADO (no medido, operativo). */
export const MAX_PUNTOS_RASTRO = 200;

// ══ AUTORIZACIONES ════════════════════════════════════════════════════════════════════════

/** Una fila de rrhh_autorizacion_campo. Compatible con `AutorizacionCampo` (que lee el motor)
 *  más los campos de exhibición. */
export type FilaAutorizacionCampo = AutorizacionCampo & {
  usuario_id?: string | null;
  motivo?: string | null;
  solicitado_en?: string | null;
  aprobado_por?: string | null;
  aprobado_en?: string | null;
  nota?: string | null;
  created_at?: string | null;
};

/** La misma fila con su estado EFECTIVO en `ahora` ya derivado por el motor. */
export type AutorizacionCampoConEstado = FilaAutorizacionCampo & {
  estado_efectivo: ReturnType<typeof estadoAutorizacion>;
};

/**
 * Lista autorizaciones de campo. Sin `usuarioId` lista TODAS (panel de RRHH); con él, las de ese
 * usuario. Paginado con orden TOTAL (created_at, id) para que ninguna se repita ni se pierda en
 * el corte de 1000 de PostgREST. Más recientes primero.
 */
export async function listarAutorizaciones(
  sb: SB,
  filtro: { usuarioId?: string } = {},
): Promise<{ autorizaciones: FilaAutorizacionCampo[]; sinMigracion: boolean }> {
  const filas: FilaAutorizacionCampo[] = [];
  for (let desde = 0; desde < TOPE_PAGINAS * PAGINA; desde += PAGINA) {
    let q = sb
      .from("rrhh_autorizacion_campo")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(desde, desde + PAGINA - 1);
    if (filtro.usuarioId) q = q.eq("usuario_id", filtro.usuarioId);
    const { data, error } = await q;
    if (error) {
      if (tablaFaltante(error, "rrhh_autorizacion_campo")) return { autorizaciones: [], sinMigracion: true };
      throw error; // otra cosa (red, permiso): no es «sin autorizaciones»
    }
    const pagina = (data ?? []) as FilaAutorizacionCampo[];
    filas.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return { autorizaciones: filas, sinMigracion: false };
}

/** Las autorizaciones de UN usuario (para que el endpoint evalúe `ventanaCampoVigente`). */
export async function autorizacionesDeUsuario(
  sb: SB,
  usuarioId: string,
): Promise<{ autorizaciones: FilaAutorizacionCampo[]; sinMigracion: boolean }> {
  return listarAutorizaciones(sb, { usuarioId });
}

/** Una autorización por id (para el guard de aprobar/rechazar: existe + estado). */
export async function autorizacionPorId(
  sb: SB,
  id: number,
): Promise<{ fila: { id: number; estado: string } | null; sinMigracion: boolean }> {
  const { data, error } = await sb
    .from("rrhh_autorizacion_campo")
    .select("id, estado")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (tablaFaltante(error, "rrhh_autorizacion_campo")) return { fila: null, sinMigracion: true };
    throw error;
  }
  return { fila: (data as { id: number; estado: string } | null) ?? null, sinMigracion: false };
}

// ══ POSICIONES DE CAMPO ═══════════════════════════════════════════════════════════════════

export type PuntoCampo = {
  lat: number;
  lng: number;
  velocidad: number | null;
  rumbo: number | null;
  precision_m: number | null;
  fix_ts: string | null;
  created_at: string | null;
};

export type EmpleadoCampoPosicion = {
  usuario_id: string;
  nombre: string | null;
  /** La posición más reciente de la ventana (encabeza el rastro). */
  ultima: PuntoCampo;
  /** Rastro reciente (más nuevo → más viejo), topado a MAX_PUNTOS_RASTRO. */
  rastro: PuntoCampo[];
  /** Cuántas posiciones de la ventana tenía (antes de topar el rastro). */
  puntos: number;
};

const COLS_GPS = [
  "id", "created_at", "lat", "lng", "velocidad", "rumbo", "precision_m", "fix_ts", "empleado_usuario_id",
] as const;

type FilaGps = Record<string, unknown>;

const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Lee las posiciones de CAMPO (empleado_usuario_id NO NULO) en la ventana [desde, hasta), las
 * agrupa por empleado (última + rastro reciente) y resuelve el nombre desde `usuarios`. Paginado
 * con orden total (created_at desc, id desc). Degrada:
 *   · falta `empleado_usuario_id` → `sinMigracion` (no hay campo que leer).
 *   · falta una columna accesoria (`fix_ts`) → se suelta por nombre y se reintenta.
 *   · otro error → LANZA (no es «no hay posiciones»).
 */
export async function posicionesCampo(
  sb: SB,
  ventana: { desde: string; hasta: string; maxPuntosPorEmpleado?: number },
): Promise<{ empleados: EmpleadoCampoPosicion[]; sinMigracion: boolean; columnasFaltantes: string[] }> {
  const maxRastro = ventana.maxPuntosPorEmpleado ?? MAX_PUNTOS_RASTRO;
  let columnas = [...COLS_GPS] as string[];
  const omitidas: string[] = [];

  // Una pasada completa de la ventana con el juego de columnas actual. Devuelve las filas, o un
  // error para que el llamador decida soltar una columna y repetir desde cero.
  const leerTodo = async (): Promise<{ filas: FilaGps[]; error: unknown }> => {
    const filas: FilaGps[] = [];
    for (let desde = 0; desde < TOPE_PAGINAS * PAGINA; desde += PAGINA) {
      const { data, error } = await sb
        .from("ubicaciones_gps")
        .select(columnas.join(", "))
        .not(COL_DISCRIMINADOR, "is", null)
        .gte("created_at", ventana.desde)
        .lt("created_at", ventana.hasta)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(desde, desde + PAGINA - 1);
      if (error) return { filas: [], error };
      const pagina = (data ?? []) as FilaGps[];
      filas.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    return { filas, error: null };
  };

  let filas: FilaGps[] = [];
  for (let intento = 0; intento < COLS_OPCIONALES_GPS.length + 1; intento++) {
    const r = await leerTodo();
    if (!r.error) { filas = r.filas; break; }
    // El discriminador ausente = falta la migración (no es una columna que soltar).
    if (columnaFaltante(r.error) === COL_DISCRIMINADOR) {
      return { empleados: [], sinMigracion: true, columnasFaltantes: omitidas };
    }
    const col = faltaAlguna(r.error, COLS_OPCIONALES_GPS);
    if (col && columnas.includes(col)) {
      columnas = columnas.filter((c) => c !== col);
      omitidas.push(col);
      continue;
    }
    throw new Error(`campo/posiciones: ${(r.error as { message?: string })?.message ?? "no se pudo leer"}`);
  }

  // Agrupa por empleado. Como viene en orden descendente, el primero de cada empleado es la última.
  const porEmpleado = new Map<string, { ultima: PuntoCampo; rastro: PuntoCampo[]; puntos: number }>();
  for (const f of filas) {
    const uid = str(f[COL_DISCRIMINADOR]);
    if (!uid) continue;
    const lat = num(f.lat), lng = num(f.lng);
    if (lat == null || lng == null || (lat === 0 && lng === 0)) continue; // coords inválidas / (0,0)
    const punto: PuntoCampo = {
      lat, lng,
      velocidad: num(f.velocidad),
      rumbo: num(f.rumbo),
      precision_m: num(f.precision_m),
      fix_ts: str(f.fix_ts),
      created_at: str(f.created_at),
    };
    let g = porEmpleado.get(uid);
    if (!g) { g = { ultima: punto, rastro: [], puntos: 0 }; porEmpleado.set(uid, g); }
    g.puntos++;
    if (g.rastro.length < maxRastro) g.rastro.push(punto);
  }

  // Resuelve nombres (best-effort: si falla, quedan null; no se pierde la posición).
  const ids = [...porEmpleado.keys()];
  const nombres = new Map<string, string | null>();
  if (ids.length > 0) {
    try {
      const { data } = await sb.from("usuarios").select("id, nombre").in("id", ids);
      for (const u of (data ?? []) as { id: string; nombre: string | null }[]) {
        nombres.set(String(u.id), u.nombre ?? null);
      }
    } catch { /* nombres null */ }
  }

  const empleados: EmpleadoCampoPosicion[] = ids.map((uid) => {
    const g = porEmpleado.get(uid)!;
    return { usuario_id: uid, nombre: nombres.get(uid) ?? null, ultima: g.ultima, rastro: g.rastro, puntos: g.puntos };
  });
  // Orden estable: por nombre, y a falta de él por id.
  empleados.sort((a, b) =>
    (a.nombre ?? a.usuario_id).localeCompare(b.nombre ?? b.usuario_id, "es"));

  return { empleados, sinMigracion: false, columnasFaltantes: omitidas };
}

// ══ ESCRITURA DE POSICIONES DE CAMPO ══════════════════════════════════════════════════════

/**
 * Inserta posiciones de campo en `ubicaciones_gps` (1 fila o un lote de la cola offline). Cada
 * fila YA debe venir con `empleado_usuario_id` forzado (el token) y los 4 FK de flota en NULL;
 * esta función no toca la identidad, solo escribe y degrada columnas accesorias:
 *   · falta el discriminador → `sinMigracion` (NO se suelta: dejaría una fila huérfana).
 *   · falta una columna accesoria (`fix_ts`) → se suelta de TODAS las filas y se reintenta.
 *   · otro error → se devuelve (NO se reintenta a ciegas: un INSERT reintentado duplica).
 * El INSERT de un arreglo es una sola sentencia (atómico), así que reintentar sin una columna es
 * seguro: no deja filas a medias.
 */
export async function insertarPosicionesCampo(
  sb: SB,
  filas: Record<string, unknown>[],
): Promise<{ ok: boolean; insertados: number; sinMigracion: boolean; columnasOmitidas: string[]; error: string | null }> {
  if (filas.length === 0) {
    return { ok: true, insertados: 0, sinMigracion: false, columnasOmitidas: [], error: null };
  }
  const rows = filas.map((f) => ({ ...f }));
  const omitidas: string[] = [];
  for (let i = 0; i < 12; i++) {
    const { error } = await sb.from("ubicaciones_gps").insert(rows);
    if (!error) {
      return { ok: true, insertados: rows.length, sinMigracion: false, columnasOmitidas: omitidas, error: null };
    }
    if (columnaFaltante(error) === COL_DISCRIMINADOR) {
      return { ok: false, insertados: 0, sinMigracion: true, columnasOmitidas: omitidas, error: String((error as { message?: string })?.message ?? "") };
    }
    const col = faltaAlguna(error, COLS_OPCIONALES_GPS);
    if (col && col in rows[0]) {
      for (const r of rows) delete r[col];
      omitidas.push(col);
      continue;
    }
    return { ok: false, insertados: 0, sinMigracion: false, columnasOmitidas: omitidas, error: String((error as { message?: string })?.message ?? "") };
  }
  return { ok: false, insertados: 0, sinMigracion: false, columnasOmitidas: omitidas, error: "demasiados reintentos soltando columnas" };
}
