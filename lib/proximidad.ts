// lib/proximidad.ts — SOLO SERVIDOR. Motor de proximidad del push del pasajero.
//
// Problema que resuelve: "tu bus llega en ~5 min" y "TU BUS YA LLEGÓ" se calculaban
// SOLO en el cliente (app/pasajero/page.tsx), y ese cálculo muere con la pantalla
// bloqueada (document.hidden). Aquí se evalúa EN EL SERVIDOR, enganchado al heartbeat
// GPS del conductor (case "ubicacion" de /api/conductor, cada 2.5–25 s por bus).
//
// Coste bajo garantizado: el camino caliente es UN SOLO UPDATE condicional (claim
// atómico en push_eval_estado) — la evaluación completa corre máx. 1 vez cada
// THROTTLE_MS por reserva, gane quien gane entre lambdas concurrentes. La memoria
// de módulo NO sirve de throttle en serverless (no sobrevive entre invocaciones).
//
// Anti-falsos-positivos (GPS de red ±150 m, bus que pasa de largo, rutas con lazos):
//   • precision_m > PRECISION_MAX → no se decide nada con ese fix;
//   • radio de llegada adaptativo a la precisión: clamp(120, 1.5·acc, 250) m;
//   • "llegó" exige velocidad ≤ VEL_MAX_LLEGADA (a 60 km/h cerca de la parada va DE PASO);
//   • velocidad robusta con velocidadPorVentana (lib/huella.ts, jitter-proof);
//   • 'aproximandose' solo mira las próximas VENTANA_PARADAS pendientes por orden
//     (una ruta que pasa geográficamente cerca de una parada lejana no dispara);
//   • 'llego' sí evalúa TODAS las pendientes (el conductor pudo saltarse paradas);
//   • lotes de cola offline: si el fix más nuevo es viejo (> FRESCURA_MAX_MS) no se evalúa.
//
// El dedupe (un push por evento/parada) es el INSERT único de push_eventos_viaje
// (emitirEventoViaje). Bus que retrocede: insert-once → ni des-aviso ni re-aviso.

import { createClient } from "@supabase/supabase-js";
import { distM, velocidadPorVentana, type FixVel } from "@/lib/huella";
import { emitirEventoViaje, pasajerosEsperandoDeParada, payloadsViaje } from "@/lib/push";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const THROTTLE_MS      = 12_000;  // claim en BD; heartbeats llegan cada 2.5–25 s
const FRESCURA_MAX_MS  = 90_000;  // fix más nuevo más viejo que esto → lote de cola offline
const PRECISION_MAX_M  = 150;     // precisión peor → sin decisiones
const VEL_MAX_LLEGADA  = 20;      // km/h; más rápido cerca de la parada = va de paso
const ETA_AVISO_MIN    = 5;       // "llega en ~5 min"
const DIST_AVISO_M     = 1500;    // o a ≤1.5 km, lo que ocurra primero
const VEL_FALLBACK_KMH = 20;      // ETA cuando no hay velocidad confiable
const VENTANA_PARADAS  = 3;       // 'aproximandose' solo para las próximas N pendientes
const HIST_FIXES       = 15;      // puntos para velocidadPorVentana

function radioLlegadaM(acc: number): number {
  return Math.min(250, Math.max(120, 1.5 * acc));
}

// Hora del fix: PREFERIR fix_ts (hora del último fix REAL — no avanza en el
// backstop que re-envía la misma posición con created_at fresco). Un max() con
// created_at anularía el gate de frescura: GPS congelado pasaría como vivo y
// podríamos declarar "llegó" con una posición donde el bus ESTUVO. Fallback a
// created_at solo para APKs viejos que no mandan fix_ts.
function tsDeFix(g: { fix_ts?: string | null; created_at?: string | null }): number {
  const a = g.fix_ts ? Date.parse(g.fix_ts) : NaN;
  if (Number.isFinite(a)) return a;
  const b = g.created_at ? Date.parse(g.created_at) : NaN;
  return Number.isFinite(b) ? b : 0;
}

/**
 * Evalúa proximidad del bus de una reserva a sus paradas pendientes y emite los
 * push 'aproximandose' / 'llego'. Pensada para correr en after() del heartbeat:
 * nunca lanza, y si pierde el claim del throttle retorna de inmediato.
 */
export async function evaluarProximidad(reservaId: number): Promise<void> {
  try {
    if (!Number.isFinite(reservaId) || reservaId <= 0) return;

    // 1) Claim atómico del throttle: gana el UPDATE cuya condición last_eval_at
    //    vieja siga cumpliéndose. Los heartbeats no-ganadores terminan aquí.
    const ahoraIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - THROTTLE_MS).toISOString();
    const { data: claimed, error: eClaim } = await admin
      .from("push_eval_estado")
      .update({ last_eval_at: ahoraIso })
      .eq("reserva_id", reservaId)
      .lt("last_eval_at", cutoff)
      .select("reserva_id");
    if (eClaim) return; // tabla ausente / error transitorio → no evaluar
    if (!claimed?.length) {
      // ¿Fila aún no sembrada (reserva iniciada antes del deploy)? Sembrarla y evaluar.
      const { data: fila } = await admin
        .from("push_eval_estado").select("reserva_id").eq("reserva_id", reservaId).maybeSingle();
      if (fila) return; // throttled: otro heartbeat evaluó hace <THROTTLE_MS
      const { error: eIns } = await admin
        .from("push_eval_estado").insert({ reserva_id: reservaId, last_eval_at: ahoraIso });
      if (eIns) return; // 23505: otra lambda la sembró en paralelo → que evalúe ella
    }

    // 2) Contexto (en paralelo)
    const [rR, pR, gR] = await Promise.all([
      admin.from("reservas").select("estado").eq("id", reservaId).maybeSingle(),
      admin.from("paradas").select("id, nombre, orden, lat, lng, estado").eq("reserva_id", reservaId).order("orden"),
      admin.from("ubicaciones_gps")
        .select("lat, lng, velocidad, precision_m, fix_ts, created_at")
        .eq("reserva_id", reservaId)
        .order("created_at", { ascending: false })
        .limit(HIST_FIXES),
    ]);
    if (rR.data?.estado !== "en_curso") return;

    const gps = (gR.data || []).slice().reverse(); // cronológico
    const ultimo: any = gps[gps.length - 1];
    if (!ultimo || ultimo.lat == null || ultimo.lng == null) return;

    // Frescura: drenado de cola offline manda posiciones VIEJAS — no decidir con ellas.
    if (Date.now() - tsDeFix(ultimo) > FRESCURA_MAX_MS) return;

    const acc = Number(ultimo.precision_m ?? 999);
    if (!Number.isFinite(acc) || acc > PRECISION_MAX_M) return;

    // 3) Velocidad robusta (jitter-proof). null = implausible/sin ventana →
    //    conservador: sin 'llego' y ETA con velocidad de fallback.
    const hist: FixVel[] = gps
      .filter((g: any) => g.lat != null && g.lng != null)
      .map((g: any) => ({
        lat: Number(g.lat), lng: Number(g.lng),
        ts: tsDeFix(g), acc: Number(g.precision_m ?? 50),
      }));
    const vKmh = velocidadPorVentana(hist, Number(ultimo.velocidad ?? 0));
    const vEta = Math.min(90, Math.max(8, vKmh ?? VEL_FALLBACK_KMH));

    const pendientes = (pR.data || []).filter((p: any) =>
      p.estado !== "completada" &&
      Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    );
    if (pendientes.length === 0) return;

    const radio = radioLlegadaM(acc);

    // 4) LLEGÓ — todas las pendientes (paradas fuera de orden: pudo saltarse varias).
    for (const p of pendientes) {
      const d = distM(Number(ultimo.lat), Number(ultimo.lng), Number(p.lat), Number(p.lng));
      if (d <= radio && vKmh !== null && vKmh <= VEL_MAX_LLEGADA) {
        const dest = await pasajerosEsperandoDeParada(p.id);
        const emitido = await emitirEventoViaje({
          reservaId, evento: "llego", paradaId: p.id, destinatarios: dest,
          payload: payloadsViaje.llego(p.id, p.nombre || "tu paradero"),
          ttl: 300, urgencia: "high",
        });
        if (emitido) {
          // Consumir 'aproximandose' de esta parada: que NUNCA llegue "está
          // llegando" DESPUÉS de "ya llegó" (registro sin envío).
          await emitirEventoViaje({
            reservaId, evento: "aproximandose", paradaId: p.id, destinatarios: [], payload: null,
          });
        }
      }
    }

    // 5) APROXIMÁNDOSE — solo las próximas VENTANA_PARADAS por orden.
    for (const p of pendientes.slice(0, VENTANA_PARADAS)) {
      const d = distM(Number(ultimo.lat), Number(ultimo.lng), Number(p.lat), Number(p.lng));
      if (d <= radio) continue; // dentro del radio lo maneja el bloque 4
      const etaMin = Math.ceil((d / 1000) / vEta * 60);
      if (etaMin <= ETA_AVISO_MIN || d <= DIST_AVISO_M) {
        const dest = await pasajerosEsperandoDeParada(p.id);
        await emitirEventoViaje({
          reservaId, evento: "aproximandose", paradaId: p.id, destinatarios: dest,
          payload: payloadsViaje.aproximandose(p.id, p.nombre || "tu paradero", Math.max(1, Math.min(etaMin, ETA_AVISO_MIN))),
          ttl: 600, urgencia: "high",
        });
      }
    }
  } catch (e: any) {
    console.warn("[proximidad] evaluación falló:", e?.message);
  }
}
