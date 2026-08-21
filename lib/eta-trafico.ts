// lib/eta-trafico.ts — SOLO SERVIDOR. ETA bus → punto CON tráfico, con freno de gasto.
//
// POR QUÉ ESTE ARCHIVO EXISTE Y NO SE LLAMA A /api/ruta DIRECTO:
// `departure_time` es lo que decide el SKU que factura Google. Con él la llamada cae en
// "Directions Advanced": $10 por 1.000 y solo 5.000 gratis al mes (contra $5 y 10.000 sin
// tráfico). Ver la cabecera de app/api/ruta/route.ts:5-18. El semáforo de puntualidad
// evalúa servicios cada 10 min: sin freno, él solo se comería la cuota gratuita del ERP
// entero en dos semanas.
//
// TRES FRENOS, EN ESTE ORDEN:
//   1) FILTRO DE DUDA (lib/retrasos.ts::etaLibreMin) — el llamador solo pide un ETA real
//      cuando ni la cota optimista ni la pesimista deciden solas. Es el freno que más
//      ahorra: la mayoría de servicios se resuelven en 0 llamadas.
//   2) CACHÉ CORTA (tabla eta_trafico_cache, TTL 3 min) por origen redondeado a ~110 m y
//      destino a ~1 m. La torre, el drawer y el cron comparten la misma respuesta; un bus
//      parado en un semáforo no genera una llamada por refresco.
//   3) TECHO DIARIO (tabla eta_gasto_dia) — al agotarse, degrada a la estimación gratis y
//      lo dice (`fuente: "estimado"`). NUNCA rompe: un módulo de alertas que se cae por la
//      cuota de un mapa es peor que uno que estima.
//
// Todo lo de BD es best-effort: si las tablas no existen (SQL sin correr) el módulo sigue
// funcionando —sin caché y sin techo persistente— con el tope en memoria del proceso.
// Es el mismo trato que lib/rutas-cache.ts.

import { createClient } from "@supabase/supabase-js";
import { etaLibreMin, type EtaPuntual } from "./retrasos";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

const TTL_MS         = 3 * 60_000;  // el tráfico no cambia de forma útil en menos de 3 min
const TECHO_DIA      = 300;         // llamadas con tráfico/día para TODO el módulo (~9k/mes)
const TIMEOUT_MS     = 6_000;       // un ETA que tarda más ya no sirve para decidir
const REDONDEO_ORIGEN = 3;          // ~110 m: el bus se mueve, no hace falta precisión de metro

export type Punto = { lat: number; lng: number };

/** Tope en memoria del proceso: backstop si la tabla de gasto no existe. */
let gastoProceso = { dia: "", n: 0 };

function claveDia(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);   // día de Lima
  return d.toISOString().slice(0, 10);
}

function clave(origen: Punto, destino: Punto): string {
  return `${origen.lat.toFixed(REDONDEO_ORIGEN)},${origen.lng.toFixed(REDONDEO_ORIGEN)}` +
         `>${destino.lat.toFixed(5)},${destino.lng.toFixed(5)}`;
}

async function leerCache(k: string): Promise<number | null> {
  if (!admin) return null;
  try {
    const { data, error } = await admin
      .from("eta_trafico_cache").select("minutos, creado_at").eq("clave", k).maybeSingle();
    if (error || !data) return null;
    if (Date.now() - new Date(data.creado_at).getTime() > TTL_MS) return null;
    return Number(data.minutos);
  } catch { return null; }
}

async function guardarCache(k: string, minutos: number): Promise<void> {
  if (!admin) return;
  try {
    await admin.from("eta_trafico_cache")
      .upsert({ clave: k, minutos, creado_at: new Date().toISOString() }, { onConflict: "clave" });
  } catch { /* caché best-effort */ }
}

/**
 * Reserva UNA llamada del presupuesto del día. Devuelve false si ya no queda.
 * El contador de BD es el que manda entre instancias serverless; el de memoria es el
 * backstop cuando la tabla no existe.
 */
async function reservarLlamada(): Promise<boolean> {
  const dia = claveDia();
  if (gastoProceso.dia !== dia) gastoProceso = { dia, n: 0 };
  if (gastoProceso.n >= TECHO_DIA) return false;
  gastoProceso.n++;

  if (!admin) return true;
  try {
    // Incremento atómico vía RPC si existe; si no, upsert+select (suficiente: el techo es
    // una barrera de gasto, no un semáforo de exclusión mutua).
    const { data, error } = await admin.rpc("eta_gasto_incrementar", { p_fecha: dia });
    if (!error && typeof data === "number") return data <= TECHO_DIA;
  } catch { /* sin RPC → cae al camino de abajo */ }
  try {
    const { data } = await admin.from("eta_gasto_dia").select("llamadas").eq("fecha", dia).maybeSingle();
    const n = Number(data?.llamadas ?? 0) + 1;
    await admin.from("eta_gasto_dia").upsert({ fecha: dia, llamadas: n }, { onConflict: "fecha" });
    return n <= TECHO_DIA;
  } catch { return true; }
}

/** Cuántas llamadas con tráfico se han gastado hoy (para el panel; 0 si no hay tabla). */
export async function gastoEtaHoy(): Promise<{ usadas: number; techo: number }> {
  const dia = claveDia();
  if (!admin) return { usadas: gastoProceso.dia === dia ? gastoProceso.n : 0, techo: TECHO_DIA };
  try {
    const { data } = await admin.from("eta_gasto_dia").select("llamadas").eq("fecha", dia).maybeSingle();
    return { usadas: Number(data?.llamadas ?? 0), techo: TECHO_DIA };
  } catch { return { usadas: gastoProceso.dia === dia ? gastoProceso.n : 0, techo: TECHO_DIA }; }
}

/**
 * Minutos de viaje reales bus → punto, con tráfico. Devuelve SIEMPRE algo utilizable:
 * si no puede pagar (techo agotado, sin key, Google caído) degrada a la estimación
 * gratis y lo declara en `fuente`. Quien consume nunca tiene que manejar el null.
 */
export async function etaHasta(
  origen: Punto,
  destino: Punto,
  opts?: { distanciaRectaM?: number; permitirPago?: boolean },
): Promise<EtaPuntual> {
  const recta = opts?.distanciaRectaM;
  const libre = etaLibreMin(recta ?? distanciaRecta(origen, destino));
  const estimado: EtaPuntual = { minutos: libre.optimista, fuente: "estimado", calculadoTs: Date.now() };

  // La CACHÉ se consulta siempre, incluso sin permiso de pago: es una lectura gratis y
  // es lo que permite que la torre vea el ETA real que ya pagó el cron. Solo la llamada
  // a Google queda detrás de `permitirPago`.
  const k = clave(origen, destino);
  const cacheado = await leerCache(k);
  if (cacheado !== null) return { minutos: cacheado, fuente: "google", calculadoTs: Date.now() };

  if (opts?.permitirPago === false) return estimado;

  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return estimado;

  if (!(await reservarLlamada())) return estimado;

  try {
    const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
    u.searchParams.set("origin", `${origen.lat},${origen.lng}`);
    u.searchParams.set("destination", `${destino.lat},${destino.lng}`);
    u.searchParams.set("departure_time", "now");
    u.searchParams.set("traffic_model", "best_guess");
    u.searchParams.set("mode", "driving");
    u.searchParams.set("key", key);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const resp = await fetch(u.toString(), { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) return estimado;

    const json: any = await resp.json();
    const leg = json?.routes?.[0]?.legs?.[0];
    const seg = leg?.duration_in_traffic?.value ?? leg?.duration?.value;
    if (!Number.isFinite(seg)) return estimado;

    const minutos = Math.max(1, Math.round(Number(seg) / 60));
    await guardarCache(k, minutos);
    return { minutos, fuente: "google", calculadoTs: Date.now() };
  } catch {
    return estimado;   // red, timeout, cuota: se estima y se sigue
  }
}

/** Haversine local (evita importar la lib de huella solo por esto en el camino servidor). */
function distanciaRecta(a: Punto, b: Punto): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
