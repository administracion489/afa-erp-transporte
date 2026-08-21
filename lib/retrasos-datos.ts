// lib/retrasos-datos.ts — SOLO SERVIDOR. Alimenta el motor puro (lib/retrasos.ts) con
// datos reales y devuelve el veredicto de puntualidad de cada servicio del día.
//
// Es el ÚNICO lugar donde se resuelve "¿dónde está este bus?" antes de que el servicio
// arranque, y ese matiz es lo que hace funcionar todo el módulo:
//
//   • Con el servicio EN CURSO los fixes llevan `reserva_id` → consulta directa.
//   • ANTES de iniciar NO hay `reserva_id`: la app del conductor emite con
//     `reserva_id = null` y `estado = "disponible"` mientras está "conectado"
//     (app/conductor/page.tsx:1257-1268). Por eso aquí se busca por CONDUCTOR y, en
//     segundo lugar, por VEHÍCULO — y NO se excluye "disponible", al revés que
//     /api/seguimiento:117, que sí lo excluye a propósito para no enseñarle al pasajero
//     un bus en modo libre. Son dos preguntas distintas sobre la misma tabla.
//   • Se busca por CONDUCTOR antes que por vehículo porque el teléfono lo lleva la
//     persona: con `unidad_reemplazo_placa` el vehiculo_id de la reserva puede mentir.
//   • Los fixes del servicio ANTERIOR del mismo bus SÍ cuentan aquí (el retraso de las
//     14:00 casi siempre es que el de las 09:00 no ha terminado). No se mezclan con la
//     huella del servicio —ese fue el bug 4e2cdf7—: aquí no se dibuja nada, solo se
//     pregunta dónde está la unidad AHORA.
//
// Coste: una consulta de fixes por servicio EN VENTANA (no por servicio del día), en
// paralelo y con `limit` corto. Fuera de la ventana el veredicto es "na" sin tocar GPS.

import { createClient } from "@supabase/supabase-js";
import {
  evaluarPuntualidad, CONFIG_RETRASO_DEFAULT, hhmmMin,
  type ConfigRetraso, type FixPuntual, type ParadaPuntual, type Veredicto,
} from "./retrasos";
import { etaHasta } from "./eta-trafico";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const FIXES_POR_SERVICIO = 15;   // = HIST_FIXES de lib/proximidad.ts (ventana de velocidad)
const VENTANA_GPS_MIN     = 25;  // > RANCIO_MS (20 min) de lib/retrasos.ts

export type ReservaCtx = {
  id: number; estado: string; fecha_servicio: string | null; hora_servicio: string | null;
  hora_real_inicio: string | null;
  conductor_id: number | null; conductor_tercero_id: number | null;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  empresa_tercerizada_id?: number | null;
  tipo_asignacion?: string | null;
  origen?: string | null; destino?: string | null;
};

export type VeredictoCtx = Veredicto & { reserva_id: number };

// ─── Fecha / hora de Lima (UTC-5, sin DST) ────────────────────────────────────
export function hoyLimaFecha(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().slice(0, 10);
}
export function ahoraLimaMinutos(): number {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Config editable (tabla `retraso_config`, fila única). Sin tabla → defaults. */
export async function cargarConfigRetraso(): Promise<ConfigRetraso> {
  try {
    const { data, error } = await admin.from("retraso_config").select("*").eq("id", 1).maybeSingle();
    if (error || !data) return CONFIG_RETRASO_DEFAULT;
    const n = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      anticipacionMin:      n(data.anticipacion_min,       CONFIG_RETRASO_DEFAULT.anticipacionMin),
      toleranciaMin:        n(data.tolerancia_min,         CONFIG_RETRASO_DEFAULT.toleranciaMin),
      riesgoMin:            n(data.riesgo_min,             CONFIG_RETRASO_DEFAULT.riesgoMin),
      riesgoLimpiaMin:      n(data.riesgo_limpia_min,      CONFIG_RETRASO_DEFAULT.riesgoLimpiaMin),
      persistenciaPuntoMin: n(data.persistencia_punto_min, CONFIG_RETRASO_DEFAULT.persistenciaPuntoMin),
      noRealizadoMin:       n(data.no_realizado_min,       CONFIG_RETRASO_DEFAULT.noRealizadoMin),
      ventanaPrevisionMin:  n(data.ventana_prevision_min,  CONFIG_RETRASO_DEFAULT.ventanaPrevisionMin),
      toleranciaRutaMin:    n(data.tolerancia_ruta_min,    CONFIG_RETRASO_DEFAULT.toleranciaRutaMin),
    };
  } catch {
    return CONFIG_RETRASO_DEFAULT;
  }
}

/** ¿Vale la pena mirar el GPS de este servicio ahora mismo? */
function enVentana(r: ReservaCtx, ahoraMin: number, cfg: ConfigRetraso): boolean {
  if (r.estado === "cancelada" || r.estado === "finalizada") return false;
  if (r.estado === "en_curso") return true;
  const h = hhmmMin(r.hora_servicio);
  if (h === null) return false;
  const d = ahoraMin - h;
  return d >= -cfg.ventanaPrevisionMin && d <= cfg.noRealizadoMin + 60;
}

/**
 * Últimos fixes utilizables de la unidad de UNA reserva. Devuelve [] cuando no hay nada
 * —que es un resultado legítimo, no un error: significa "no sé dónde está".
 */
async function fixesDe(r: ReservaCtx): Promise<FixPuntual[]> {
  const COLS = "lat, lng, velocidad, precision_m, fix_ts, created_at, simulado";
  const normaliza = (filas: any[]): FixPuntual[] =>
    (filas || [])
      .map((g) => {
        const ts = g.fix_ts ? Date.parse(g.fix_ts) : NaN;
        const ts2 = Number.isFinite(ts) ? ts : Date.parse(g.created_at);
        return {
          lat: Number(g.lat), lng: Number(g.lng), ts: ts2,
          acc: Number(g.precision_m ?? 999),
          vel: g.velocidad == null ? null : Number(g.velocidad),
          simulado: g.simulado ?? null,
        };
      })
      .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng) && Number.isFinite(f.ts))
      .sort((a, b) => a.ts - b.ts);

  // `simulado` es columna opcional (supabase/ubicaciones-gps-simulado.sql): si la BD aún
  // no la tiene, el select entero falla → se reintenta sin ella. El antifraude es un
  // extra; quedarse sin posición sería perder el módulo completo.
  const pedir = async (aplica: (q: any) => any) => {
    const r1 = await aplica(admin.from("ubicaciones_gps").select(COLS));
    let data = r1.data;
    if (r1.error && /simulado/i.test(r1.error.message || "")) {
      data = (await aplica(admin.from("ubicaciones_gps").select(COLS.replace(", simulado", "")))).data;
    }
    return normaliza(data || []);
  };

  if (r.estado === "en_curso") {
    const f = await pedir((q: any) =>
      q.eq("reserva_id", r.id).order("created_at", { ascending: false }).limit(FIXES_POR_SERVICIO));
    if (f.length) return f;
  }

  const desde = new Date(Date.now() - VENTANA_GPS_MIN * 60_000).toISOString();
  // 1º por CONDUCTOR (el teléfono lo lleva la persona), 2º por VEHÍCULO.
  const porConductor = r.conductor_tercero_id
    ? { col: "conductor_tercero_id", val: r.conductor_tercero_id }
    : r.conductor_id
    ? { col: "conductor_id", val: r.conductor_id }
    : null;
  const porVehiculo = r.vehiculo_tercero_id
    ? { col: "vehiculo_tercero_id", val: r.vehiculo_tercero_id }
    : r.vehiculo_id
    ? { col: "vehiculo_id", val: r.vehiculo_id }
    : null;

  for (const via of [porConductor, porVehiculo]) {
    if (!via) continue;
    const f = await pedir((q: any) =>
      q.eq(via.col, via.val).gte("created_at", desde)
        .order("created_at", { ascending: false }).limit(FIXES_POR_SERVICIO));
    if (f.length) return f;
  }
  return [];
}

export type OpcionesVeredicto = {
  fecha?: string;
  reservaIds?: number[];
  /** false = no gastar cuota de Google (la torre lee; el cron paga) */
  permitirPago?: boolean;
  /**
   * Veredicto previo por reserva, para la histéresis del chip de riesgo. Si no se pasa
   * se lee solo (una consulta); pasarlo sirve cuando el llamador ya lo tiene y además
   * lo necesita después para grabar el historial de cambios.
   */
  previos?: Map<number, string>;
};

/**
 * Veredicto de puntualidad de los servicios de un día. Dos pasadas: la primera decide
 * gratis y marca quién está en la "franja de duda"; la segunda solo paga el ETA con
 * tráfico de esos pocos (ver lib/eta-trafico.ts).
 */
export async function veredictosDelDia(
  opts: OpcionesVeredicto = {},
): Promise<{
  veredictos: Map<number, VeredictoCtx>;
  reservas: Map<number, ReservaCtx>;
  cfg: ConfigRetraso;
  previos: Map<number, string>;
}> {
  const cfg = await cargarConfigRetraso();
  const fecha = opts.fecha || hoyLimaFecha();
  const ahoraMin = ahoraLimaMinutos();
  const ahoraMs = Date.now();

  let q = admin
    .from("reservas")
    .select("id, estado, fecha_servicio, hora_servicio, hora_real_inicio, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, empresa_tercerizada_id, tipo_asignacion, origen, destino")
    .eq("fecha_servicio", fecha);
  if (opts.reservaIds?.length) q = q.in("id", opts.reservaIds);
  const { data: rows } = await q;
  const reservas = new Map<number, ReservaCtx>();
  for (const r of (rows || []) as ReservaCtx[]) reservas.set(r.id, r);

  // Nivel previo: lo pide el llamador o se lee aquí (una consulta). Nunca se recalcula
  // dos veces el día entero solo para tenerlo — eso duplicaría todas las consultas GPS.
  const previos = opts.previos ?? await nivelesPrevios([...reservas.keys()]);

  const veredictos = new Map<number, VeredictoCtx>();
  const enFoco = [...reservas.values()].filter((r) => enVentana(r, ahoraMin, cfg));

  // Servicios fuera de ventana: veredicto trivial, sin tocar GPS ni paradas.
  for (const r of reservas.values()) {
    if (enFoco.includes(r)) continue;
    veredictos.set(r.id, {
      reserva_id: r.id,
      ...evaluarPuntualidad({
        reserva: r, paradas: [], fixes: [], ahoraMs, ahoraMin, hoy: fecha, cfg,
      }),
    });
  }
  if (!enFoco.length) return { veredictos, reservas, cfg, previos };

  const { data: parRows } = await admin
    .from("paradas")
    .select("id, reserva_id, orden, nombre, lat, lng, hora_estimada, estado, hora_llegada")
    .in("reserva_id", enFoco.map((r) => r.id))
    .order("orden");
  const paradasPor = new Map<number, ParadaPuntual[]>();
  for (const p of (parRows || []) as any[]) {
    const l = paradasPor.get(p.reserva_id) || [];
    l.push(p); paradasPor.set(p.reserva_id, l);
  }

  const fixesPor = new Map<number, FixPuntual[]>();
  await Promise.all(enFoco.map(async (r) => { fixesPor.set(r.id, await fixesDe(r)); }));

  const esTercero = (r: ReservaCtx) => !!(r.empresa_tercerizada_id || r.vehiculo_tercero_id || r.conductor_tercero_id);

  // ── Pasada 1: gratis ────────────────────────────────────────────────────────
  const dudosos: ReservaCtx[] = [];
  for (const r of enFoco) {
    const v = evaluarPuntualidad({
      reserva: r, paradas: paradasPor.get(r.id) || [], fixes: fixesPor.get(r.id) || [],
      ahoraMs, ahoraMin, hoy: fecha, cfg, esTercero: esTercero(r),
    });
    veredictos.set(r.id, { reserva_id: r.id, ...v });
    // Entra en la 2ª pasada aunque no haya permiso de pago: la caché de ETA se lee
    // igual (gratis) y así la torre aprovecha el ETA real que ya pagó el cron.
    if (v.requiereEta) dudosos.push(r);
  }

  // ── Pasada 2: solo la franja de duda mira el ETA con tráfico ───────────────
  await Promise.all(dudosos.map(async (r) => {
    const v = veredictos.get(r.id);
    const fixes = fixesPor.get(r.id) || [];
    const paradas = paradasPor.get(r.id) || [];
    const destino = paradas.find((p) => p.id === v?.paradaRefId);
    const ultimo = fixes[fixes.length - 1];
    if (!v || !destino || !ultimo) return;
    const dLat = Number(destino.lat), dLng = Number(destino.lng);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) return;

    const eta = await etaHasta(
      { lat: ultimo.lat, lng: ultimo.lng },
      { lat: dLat, lng: dLng },
      { distanciaRectaM: v.posicion.distanciaM ?? undefined, permitirPago: opts.permitirPago !== false },
    );
    veredictos.set(r.id, {
      reserva_id: r.id,
      ...evaluarPuntualidad({
        reserva: r, paradas, fixes, ahoraMs, ahoraMin, hoy: fecha, cfg,
        esTercero: esTercero(r), eta,
      }),
    });
  }));

  // ── Histéresis del chip de riesgo ───────────────────────────────────────────
  // El ETA con tráfico oscila. Sin esto, el chip ámbar parpadea cada refresco y deja
  // de leerse. Se declara con `riesgoMin` y solo se limpia por debajo de `riesgoLimpiaMin`.
  for (const [id, v] of veredictos) {
    if (v.nivel !== "en_hora") continue;
    if (previos.get(id) !== "riesgo") continue;
    if (v.minutos === null) continue;
    // `minutos` = llegada prevista vs. la hora pactada; el riesgo se declara al pasar
    // `toleranciaMin`. Se limpia solo cuando baja `riesgoLimpiaMin` por DEBAJO de ese
    // umbral: si no, un ETA que oscila un minuto enciende y apaga el chip en cada tick.
    if (v.minutos >= cfg.toleranciaMin - cfg.riesgoLimpiaMin) {
      veredictos.set(id, { ...v, nivel: "riesgo", escala: true, causa: "riesgo de retraso (sostenido)" });
    }
  }

  return { veredictos, reservas, cfg, previos };
}

/** Último nivel grabado por reserva (para la histéresis). Sin tabla → mapa vacío. */
export async function nivelesPrevios(reservaIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!reservaIds.length) return out;
  try {
    const { data } = await admin.from("retraso_estado").select("reserva_id, nivel").in("reserva_id", reservaIds);
    for (const f of (data || []) as any[]) out.set(Number(f.reserva_id), String(f.nivel));
  } catch { /* tabla ausente → sin histéresis, no es fatal */ }
  return out;
}

/**
 * Graba el veredicto vigente y, si el nivel CAMBIÓ, un evento en el historial.
 *
 * El upsert de `retraso_estado` se sobrescribe: si un tercero abre el link tarde, su
 * "sin rastreo" desaparece y el incumplimiento queda sin rastro. `retraso_evento` es
 * append-only y solo se escribe en el cambio → conserva lo que de verdad pasó sin
 * inflar la tabla en cada tick. De ahí sale el reporte mensual por proveedor.
 * Todo best-effort: sin las tablas, el módulo sigue vivo (solo pierde historial).
 */
export async function guardarVeredictos(
  veredictos: Iterable<VeredictoCtx>,
  previos?: Map<number, string>,
): Promise<void> {
  const vivos = [...veredictos].filter((v) => v.nivel !== "na");
  if (!vivos.length) return;
  const ahora = new Date().toISOString();

  try {
    await admin.from("retraso_estado").upsert(
      vivos.map((v) => ({
        reserva_id: v.reserva_id,
        nivel: v.nivel,
        minutos: v.minutos,
        causa: v.causa,
        evidencia: v.evidencia,
        posicion: v.posicion.estado,
        distancia_m: v.posicion.distanciaM,
        evaluado_at: ahora,
      })),
      { onConflict: "reserva_id" },
    );
  } catch { /* tabla ausente */ }

  const cambios = vivos
    .filter((v) => (previos?.get(v.reserva_id) ?? null) !== v.nivel)
    .map((v) => ({
      reserva_id: v.reserva_id,
      nivel: v.nivel,
      nivel_prev: previos?.get(v.reserva_id) ?? null,
      minutos: v.minutos,
      evidencia: v.evidencia,
      creado_at: ahora,
    }));
  if (!cambios.length) return;
  try {
    await admin.from("retraso_evento").insert(cambios);
  } catch { /* tabla ausente */ }
}
