// lib/gps-diagnostico-api.ts — Motor PURO: el CONTRATO de GET /api/seguimiento/rastreo/diagnostico
// (lo que recibe el modal de diagnóstico del rastreo) y las reglas puras del lector que lo arma
// (lib/gps-diagnostico-datos.ts, solo servidor). Sin React, sin fetch, sin Supabase.
//
// ── POR QUÉ UN ARCHIVO APARTE ──────────────────────────────────────────────────────────
// El lector crea un cliente con la service-role al cargarse. Si el modal importara sus tipos desde
// ahí, bastaría con que alguien escribiera `import { … }` en vez de `import type { … }` para meter
// ese módulo en el bundle del navegador. Los tipos de la respuesta viven aquí, y aquí también las
// tres decisiones del lector que se pueden probar sin base (scripts/prueba-gps-diagnostico-api.mts):
//   · QUIÉN es el conductor del teléfono (`conductorDeLaTraza`, `conductorDeReserva`);
//   · QUÉ ventana se mira en sus reportes cuando no hay medición (`ventanaDelServicio`);
//   · QUÉ servicios entran a su historial (`anteriorA`, `ordenServicio`).
//
// ── LO QUE NO SALE A LA PANTALLA ──────────────────────────────────────────────────────
// El estado del teléfono viaja SIN los identificadores de aparato (`dispositivos`): la pantalla
// solo necesita CUÁNTOS reportaron (`aparatos`). Ni tokens, ni PIN, ni nombres, ni teléfonos: la
// cabecera del modal la arma /seguimiento con lo que ya tiene.

import type { MedicionCobertura, VeredictoRastreo, FilaGpsDiag, ContextoServicio } from "./gps-cobertura";
import type { DiagnosticoRastreo, patronDelConductor } from "./gps-diagnostico";
import type { EstadoEquipo } from "./gps-equipo";

/** La migración que crea `gps_equipo_reportes` y `ubicaciones_gps.recibido_en`. El deploy NO la corre. */
export const SQL_EQUIPO = "supabase/gps-equipo-01.sql" as const;

/** Días hacia atrás que mira el historial del conductor, y cuántos servicios enseña. NO MEDIDOS. */
export const DIAS_HISTORIAL = 14;
export const MAX_HISTORIAL = 5;

export type TablaConductorDiag = "conductores" | "conductores_tercero";

/** El conductor cuyo teléfono se diagnostica. `por`: de dónde salió (ver `conductorDeLaTraza`). */
export type ConductorDiagnostico = { tabla: TablaConductorDiag; id: number; por: "traza" | "reserva" };

/** El estado del teléfono, tal como sale a la pantalla: sin los identificadores de aparato. */
export type EstadoEquipoPantalla = Omit<EstadoEquipo, "dispositivos">;

/** Respuesta de `GET /api/seguimiento/rastreo/diagnostico?reserva=<id>` (status 200). */
export type RespuestaDiagnosticoRastreo = {
  reserva_id: number;
  /** fecha_servicio "YYYY-MM-DD" (null solo si el cálculo falló antes de leer la reserva) */
  fecha: string | null;
  /** ISO: cuándo se calculó (la caché lo conserva: 30 s si es de hoy, 10 min si es de otro día) */
  medido_en: string;
  enCurso: boolean;
  /** EL MISMO veredicto que la celda RASTREO de /seguimiento (contextoServicio + veredictoDeServicio) */
  veredicto: VeredictoRastreo;
  /** la medición de la que sale el %, con sus tramos (null si no hay ≥ 2 posiciones útiles) */
  medicion: MedicionCobertura | null;
  diagnostico: DiagnosticoRastreo;
  equipo: {
    /** el estado del teléfono DURANTE la ventana del servicio (fusionado si hubo varios reportes) */
    durante: EstadoEquipoPantalla | null;
    /** el de antes del servicio (hasta 24 h antes) */
    anterior: EstadoEquipoPantalla | null;
    /** el último reporte conocido del conductor, sea de cuando sea */
    ultimo: EstadoEquipoPantalla | null;
    conductor: ConductorDiagnostico | null;
  };
  migraciones: {
    sql: typeof SQL_EQUIPO;
    /** no existe `gps_equipo_reportes`: «Su teléfono» sale vacío por eso, no porque no haya reportado */
    faltaTabla: boolean;
    /** no existe `ubicaciones_gps.recibido_en`: «Llegaron tarde» no se puede medir */
    faltaRecibido: boolean;
  };
  /** SOLO cuando el cálculo falló: el diagnóstico sale `sin_medir` y esto dice por qué (en español) */
  error?: string;
};

/** Un servicio del historial del conductor (los chips del modal). */
export type ServicioHistorialRastreo = {
  reserva_id: number;
  fecha: string;
  /** "HH:MM" programada, o null */
  hora: string | null;
  placa: string | null;
  veredicto: Pick<VeredictoRastreo, "codigo" | "pct" | "celda" | "color" | "bg">;
};

export type PatronConductor = ReturnType<typeof patronDelConductor>;

/** Respuesta de `GET /api/seguimiento/rastreo/diagnostico?reserva=<id>&historial=1` (status 200). */
export type RespuestaHistorialRastreo = {
  reserva_id: number;
  conductor: ConductorDiagnostico | null;
  /** de más reciente a más antiguo; solo servicios que se hicieron (no cancelados, que corrieron) */
  servicios: ServicioHistorialRastreo[];
  /** null solo si el historial no se pudo leer (entonces `error` dice por qué) */
  patron: PatronConductor | null;
  /** había más servicios medibles en la ventana de los que se enseñan */
  recortado: boolean;
  error?: string;
};

/** Cuerpo de los status 400 / 401 / 403 / 404 / 503. `reintentar` solo en el 503 (instancia ocupada). */
export type RespuestaErrorDiagnostico = { error: string; reintentar?: boolean };

// ══ Quién es el conductor del teléfono ════════════════════════════════════════════════════

/**
 * El conductor que GENERÓ la traza: la identidad mayoritaria de sus filas. El servidor la fuerza con
 * el TOKEN en cada punto (acción `ubicacion` de /api/conductor), así que es quien de verdad llevaba el
 * teléfono — no quien figura en la reserva, que puede haberse reasignado. Una fila con las dos
 * columnas o con ninguna no vota (no dice de quién es). Empate: la identidad de la fila más reciente.
 * Los ids de las dos tablas SE SOLAPAN: la clave lleva la tabla.
 */
export function conductorDeLaTraza(filas: FilaGpsDiag[] | null | undefined): { tabla: TablaConductorDiag; id: number } | null {
  const votos = new Map<string, { tabla: TablaConductorDiag; id: number; n: number; ultimoTs: number }>();
  for (const f of filas || []) {
    const propio = f.conductorId != null && Number.isFinite(f.conductorId) && f.conductorId > 0 ? f.conductorId : null;
    const tercero = f.conductorTerceroId != null && Number.isFinite(f.conductorTerceroId) && f.conductorTerceroId > 0 ? f.conductorTerceroId : null;
    if ((propio == null) === (tercero == null)) continue;
    const tabla: TablaConductorDiag = propio != null ? "conductores" : "conductores_tercero";
    const id = (propio ?? tercero) as number;
    const clave = `${tabla}:${id}`;
    const v = votos.get(clave) ?? { tabla, id, n: 0, ultimoTs: -Infinity };
    v.n++;
    if (f.ts > v.ultimoTs) v.ultimoTs = f.ts;
    votos.set(clave, v);
  }
  let mejor: { tabla: TablaConductorDiag; id: number; n: number; ultimoTs: number } | null = null;
  for (const v of votos.values()) {
    if (!mejor || v.n > mejor.n || (v.n === mejor.n && v.ultimoTs > mejor.ultimoTs)) mejor = v;
  }
  return mejor ? { tabla: mejor.tabla, id: mejor.id } : null;
}

/** Respaldo: el conductor que figura en la reserva (propio primero, como /api/seguimiento). */
export function conductorDeReserva(r: { conductor_id?: unknown; conductor_tercero_id?: unknown }): { tabla: TablaConductorDiag; id: number } | null {
  const n = (x: unknown) => {
    if (x == null || x === "") return null;
    const v = Number(x);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  };
  const propio = n(r.conductor_id);
  if (propio != null) return { tabla: "conductores", id: propio };
  const tercero = n(r.conductor_tercero_id);
  if (tercero != null) return { tabla: "conductores_tercero", id: tercero };
  return null;
}

/** Primero la traza; si no dice nada, la reserva. Declara de dónde salió. */
export function conductorDelDiagnostico(
  filas: FilaGpsDiag[] | null | undefined,
  r: { conductor_id?: unknown; conductor_tercero_id?: unknown },
): ConductorDiagnostico | null {
  const t = conductorDeLaTraza(filas);
  if (t) return { ...t, por: "traza" };
  const rr = conductorDeReserva(r);
  return rr ? { ...rr, por: "reserva" } : null;
}

// ══ Qué ventana se mira en los reportes del teléfono ══════════════════════════════════════

/** "HH:MM[:SS]" del día `fecha` en Lima (UTC-5) → ms epoch. */
function limaTs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
  const t = Date.parse(`${fecha}T${h}-05:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * La ventana del servicio en hora del TELÉFONO (la de la traza), para cruzarla con sus reportes.
 * Con medición es exactamente la ventana del % (la que la celda midió). Sin medición —sin señal,
 * todo por antena, no aplica— se reconstruye de la evidencia del conductor, de la más dura a la más
 * blanda: inicio marcado → hora programada → inicio del día; fin: ahora (en curso) → llegada marcada
 * → llegada prevista → fin del día (o ahora, si el día no terminó). Ese último respaldo NO está
 * medido y es ancho a propósito: sin otra evidencia, el estado del teléfono de ESE día es lo único
 * que se puede mirar.
 */
export function ventanaDelServicio(
  r: { fecha_servicio?: string | null; hora_servicio?: string | null },
  ctx: Pick<ContextoServicio, "enCurso" | "inicioTs" | "finTs" | "finPrevistoTs">,
  medicion: Pick<MedicionCobertura, "ventanaIniTs" | "ventanaFinTs"> | null,
  ahoraMs: number,
): { ini: number; fin: number } {
  if (medicion) return { ini: medicion.ventanaIniTs, fin: Math.max(medicion.ventanaIniTs, medicion.ventanaFinTs) };
  const inicioDia = limaTs(r.fecha_servicio, "00:00");
  const ini = ctx.inicioTs ?? limaTs(r.fecha_servicio, r.hora_servicio ?? null) ?? inicioDia ?? ahoraMs;
  const finDia = inicioDia != null ? Math.min(ahoraMs, inicioDia + 86_400_000) : ahoraMs;
  const fin = ctx.enCurso ? ahoraMs : (ctx.finTs ?? ctx.finPrevistoTs ?? finDia);
  return { ini, fin: Number.isFinite(fin) && fin >= ini ? fin : ini };
}

// ══ Qué servicios entran al historial ═════════════════════════════════════════════════════

type ServicioOrden = { id: number; fecha_servicio?: string | null; hora_servicio?: string | null };

function horaOrden(h: string | null | undefined): string {
  if (!h) return "";
  return String(h).slice(0, 8).padEnd(8, ":00").slice(0, 8);
}

/** Orden de los servicios de un conductor: fecha, luego hora programada, luego id. Negativo = `a` antes. */
export function ordenServicio(a: ServicioOrden, b: ServicioOrden): number {
  const fa = a.fecha_servicio ?? "", fb = b.fecha_servicio ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ha = horaOrden(a.hora_servicio), hb = horaOrden(b.hora_servicio);
  if (ha !== hb) return ha < hb ? -1 : 1;
  return a.id - b.id;
}

/** ¿`a` es un servicio ANTERIOR a `ref`? (los del mismo día cuentan si salieron antes) */
export function anteriorA(a: ServicioOrden, ref: ServicioOrden): boolean {
  return a.id !== ref.id && ordenServicio(a, ref) < 0;
}

// ══ Lo que sale a la pantalla ═════════════════════════════════════════════════════════════

/** El estado del teléfono sin los identificadores de aparato. */
export function equipoParaPantalla(e: EstadoEquipo | null): EstadoEquipoPantalla | null {
  if (!e) return null;
  const { dispositivos: _omitido, ...resto } = e;
  void _omitido;
  return resto;
}

/** "HH:MM" de una hora "HH:MM[:SS]", o null. */
export function horaCorta(h: string | null | undefined): string | null {
  if (!h) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h));
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
