// lib/huella.ts
// Fuente ÚNICA de la lógica de la huella GPS (limpieza de jitter + Map Matching a la vía).
// La usan el modal (components/seguimiento/ModalGps.tsx) y el mapa "En vivo" del portal
// cliente (app/cliente/page.tsx). Antes estaba duplicada y se desincronizaba: el modal se
// arreglaba y "En vivo" quedaba con la huella cruda en zigzag. Mantener AQUÍ.

export type MatchPt = { lat: number; lng: number; acc: number };
export type HuellaPt = { lat: number; lng: number; velocidad: number; acc: number };

// Distancia en metros entre dos coordenadas (haversine).
export function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Bearing geodésico (0-360) entre dos puntos GPS. Usado cuando el GPS no reporta rumbo.
export function calcBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dL = (lng2 - lng1) * Math.PI / 180;
  const r1 = lat1 * Math.PI / 180, r2 = lat2 * Math.PI / 180;
  const y = Math.sin(dL) * Math.cos(r2);
  const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dL);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Media móvil de 3 puntos sobre lat/lng para reducir el zigzag por imprecisión GPS.
export function suavizarHuella<T extends { lat: number; lng: number }>(pts: T[]): T[] {
  return pts.map((p, i) => {
    const s = Math.max(0, i - 1), e = Math.min(pts.length - 1, i + 1);
    const w = pts.slice(s, e + 1);
    return { ...p, lat: w.reduce((a, q) => a + q.lat, 0) / w.length, lng: w.reduce((a, q) => a + q.lng, 0) / w.length };
  });
}

// Normaliza filas crudas de ubicaciones_gps a HuellaPt (acc por defecto 25 m si falta).
export function filasAPuntos(filas: any[]): HuellaPt[] {
  return (filas || []).map((d: any) => ({
    lat: Number(d.lat), lng: Number(d.lng),
    velocidad: Number(d.velocidad) || 0,
    acc: d.precision_m != null ? Number(d.precision_m) : 25,
  }));
}

// Colapsa los clusters estacionarios: descarta puntos a <minM del último conservado.
// Prefijo estable (append-only): los ya conservados no cambian al añadir puntos al final.
export function dedupCercanos(pts: MatchPt[], minM = 8): MatchPt[] {
  const out: MatchPt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || distM(last.lat, last.lng, p.lat, p.lng) >= minM) out.push(p);
  }
  return out;
}

// Limpia la huella ANTES de dibujar/ajustar, para matar el "zigzag en estrella" del bus
// DETENIDO con GPS impreciso (±26 m), que salta decenas de metros sobre el mismo punto.
// CLAVE: la clasificación detenido/en-marcha es GEOMÉTRICA, NO por velocidad. El proveedor
// FUSED reporta velocidad FANTASMA (>0) justo en esos saltos de jitter de un bus parado
// (coords.speed sin clampear, app/conductor/page.tsx), así que la velocidad NO es de fiar.
// Máquina de dos estados sobre la posición:
//   • DETENIDO: se acumulan los fixes en un cluster (centroide corrido). Un punto solo
//     "escapa" si se aleja > R_STOP del centroide en ESCAPE_N muestras CONSECUTIVAS — el
//     jitter vuelve al centro y reinicia el contador, así que no escapa. Al confirmar la
//     salida se emite UN vértice (el centroide = lugar de la parada) y se pasa a EN MARCHA.
//   • EN MARCHA: se conserva cada punto (dedup 8 m) → traza densa pegada a la pista, sirva
//     o no el dato de velocidad. Se vuelve a DETENIDO cuando DWELL_N puntos seguidos quedan
//     dentro de DWELL_R (el bus se asienta: paradero / fin de servicio).
// Colapsa el jitter parado (inicio, paraderos, fin) y preserva el trayecto real aunque el
// sensor de velocidad mienta o esté en cero. Es un fold izq→der: el prefijo ya emitido es
// estable salvo la cola pendiente → no afecta a las ventanas ya congeladas del Map Matching.
const R_STOP_M  = 45;  // radio del cluster de parada (cubre el jitter típico ±26 m)
const ESCAPE_N  = 3;   // muestras consecutivas alejándose para confirmar SALIDA
const DWELL_R_M = 30;  // radio para detectar que el bus se volvió a parar
const DWELL_N   = 3;   // muestras consecutivas asentadas para confirmar PARADA
export function limpiarHuella(pts: HuellaPt[]): HuellaPt[] {
  const out: HuellaPt[] = [];
  const emitir = (lat: number, lng: number, velocidad: number, acc: number) => {
    const last = out[out.length - 1];
    if (!last || distM(last.lat, last.lng, lat, lng) >= 8) out.push({ lat, lng, velocidad, acc });
  };
  type Cl = { sumLat: number; sumLng: number; n: number; acc: number };
  const nuevoCl = (p: HuellaPt): Cl => ({ sumLat: p.lat, sumLng: p.lng, n: 1, acc: p.acc });
  const cLat = (c: Cl) => c.sumLat / c.n;
  const cLng = (c: Cl) => c.sumLng / c.n;
  const fold = (c: Cl, p: HuellaPt) => { c.sumLat += p.lat; c.sumLng += p.lng; c.n++; c.acc = Math.min(c.acc, p.acc); };

  let modo: "stop" | "move" = "stop";
  let cl: Cl | null = null;   // stop: cluster de parada · move: cluster candidato de re-parada
  let pend: HuellaPt[] = [];  // stop: salidas pendientes de confirmar
  let dwell = 0;              // move: muestras seguidas asentadas

  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue; // fila corrupta
    if (modo === "stop") {
      if (!cl) { cl = nuevoCl(p); continue; }
      if (distM(cLat(cl), cLng(cl), p.lat, p.lng) < R_STOP_M) {
        pend = []; fold(cl, p);                              // jitter / sigue parado
      } else {
        pend.push(p);
        if (pend.length >= ESCAPE_N) {                        // salida confirmada
          emitir(cLat(cl), cLng(cl), 0, cl.acc);              // el lugar de la parada
          for (const q of pend) emitir(q.lat, q.lng, q.velocidad, q.acc);
          modo = "move"; cl = null; pend = []; dwell = 0;
        }
      }
    } else { // move
      emitir(p.lat, p.lng, p.velocidad, p.acc);
      if (!cl) { cl = nuevoCl(p); dwell = 1; }
      else if (distM(cLat(cl), cLng(cl), p.lat, p.lng) < DWELL_R_M) {
        fold(cl, p); dwell++;
        if (dwell >= DWELL_N) { modo = "stop"; pend = []; }   // se volvió a parar
      } else {
        cl = nuevoCl(p); dwell = 1;                           // sigue avanzando
      }
    }
  }
  if (modo === "stop" && cl) emitir(cLat(cl), cLng(cl), 0, cl.acc); // cola: parada final
  return out;
}

// Prepara una ventana para Map Matching: deduplica y limita a 100 (máximo de la API),
// conservando primero y último. Se llama por ventana, que ya viene ≤100.
export function prepararPuntos(pts: MatchPt[]): MatchPt[] {
  const dedup = dedupCercanos(pts);
  if (dedup.length <= 100) return dedup;
  const N = Math.ceil(dedup.length / 100);
  const out = dedup.filter((_, i) => i % N === 0);
  if (out[out.length - 1] !== dedup[dedup.length - 1]) out.push(dedup[dedup.length - 1]);
  return out;
}

// Ajusta la huella GPS a la red vial usando Mapbox Map Matching API.
// Devuelve { coords, confidence } o null. RECHAZA (null) cuando hay 0 ó >1 matchings.
// El radio de búsqueda por punto se deriva de la precisión GPS (acc·1.5, acotado 5–50 m).
export async function mapMatchTrail(
  pts: MatchPt[],
  token: string
): Promise<{ coords: [number, number][]; confidence: number } | null> {
  const sample = prepararPuntos(pts);
  if (sample.length < 2) return null;
  const coords = sample.map(p => `${p.lng},${p.lat}`).join(";");
  const radii  = sample.map(p => String(Math.min(50, Math.max(5, Math.ceil((p.acc || 25) * 1.5))))).join(";");
  try {
    const res = await fetch(
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
      `?geometries=geojson&overview=full&tidy=true&radiuses=${radii}&access_token=${token}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const m = json?.matchings;
    if (!Array.isArray(m) || m.length !== 1) return null;
    const c: [number, number][] = m[0]?.geometry?.coordinates;
    const confidence = Number(m[0]?.confidence) || 0;
    return c?.length >= 2 ? { coords: c, confidence } : null;
  } catch { return null; }
}

// Ajusta UNA ventana (≤100 puntos densos) a la vía. Si Map Matching falla o devuelve baja
// confianza, cae a la huella cruda suavizada (densa: sigue la pista sin inventar rectas).
export async function matchVentana(ventana: MatchPt[], token: string): Promise<[number, number][]> {
  const r = await mapMatchTrail(ventana, token);
  if (r && r.confidence >= 0.4 && r.coords.length >= 2) return r.coords;
  const suav = suavizarHuella(ventana);
  return suav.length >= 2 ? suav.map(p => [p.lng, p.lat] as [number, number]) : [];
}

// Reparte la velocidad de la huella cruda sobre la geometría ajustada a la vía: a cada
// vértice ajustado le asigna la velocidad del punto GPS real más cercano (coloreado leyenda).
export function colorearMatched(
  coords: [number, number][],
  huella: { lat: number; lng: number; velocidad: number }[]
): any[] {
  const velCercana = (lng: number, lat: number): number => {
    let best = 0, bd = Infinity;
    for (const h of huella) {
      const d = (h.lng - lng) ** 2 + (h.lat - lat) ** 2;
      if (d < bd) { bd = d; best = h.velocidad ?? 0; }
    }
    return best;
  };
  const feats: any[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    feats.push({
      type: "Feature",
      properties: { velocidad: velCercana(coords[i][0], coords[i][1]) },
      geometry: { type: "LineString", coordinates: [coords[i], coords[i + 1]] },
    });
  }
  return feats;
}

// ── Ajustador con estado: Map Matching por VENTANAS de ≤100 puntos, con congelado ─────────
// La API topa en 100 coords/llamada. Ajustar el viaje entero diezma la huella → rectas en
// servicios largos. En vez de eso troceamos en ventanas densas, ajustamos cada una y las
// unimos; las ventanas COMPLETAS se "congelan" (se ajustan una sola vez). Throttle 60 s y, si
// el bus no se movió >8 m desde el último match, se omite la llamada.
//   Uso: crear UN ajustador por traza (modal: por apertura; "En vivo": por servicio
//   seleccionado). Llamar `ajustar(limpio, token, cancelado?)` cada ciclo; devuelve las
//   coords unidas, o null si no hay nada nuevo (conservar la geometría previa).
export function crearAjustadorHuella() {
  // La API topa en MAX coords/llamada. Cada ventana se arma con MAX puntos COMO MÁXIMO
  // (solape INCLUIDO) para que prepararPuntos NUNCA la diezme. Antes la ventana medía
  // WIN+SOLAPE = 101 > 100 → prepararPuntos tomaba 1 de cada 2 → media densidad → Map
  // Matching de baja confianza → RECTAS en servicios largos (todas las ventanas menos la
  // 1ª). Reservar el solape dentro del presupuesto de 100 elimina ese diezmado.
  const MAX = 100;             // máximo de coords por llamada de Map Matching (cap de la API)
  const SOLAPE = 1;            // punto(s) compartido(s) entre ventanas contiguas para unirlas
  const NUEVOS = MAX - SOLAPE; // puntos NUEVOS que congela cada ventana (deja sitio al solape)
  const congeladas: [number, number][][] = [];
  let congeladoHasta = 0;
  let lastMatchMs = 0;
  let lastTail: { lat: number; lng: number } | null = null;

  return {
    async ajustar(
      limpio: MatchPt[],
      token: string,
      cancelado?: () => boolean
    ): Promise<[number, number][] | null> {
      if (!token || limpio.length < 2) return null;
      const cola = limpio[limpio.length - 1];
      const seMovio = !lastTail || distM(lastTail.lat, lastTail.lng, cola.lat, cola.lng) >= 8;
      if (Date.now() - lastMatchMs < 60000) return null;
      if (!seMovio && congeladas.length) return null;
      lastMatchMs = Date.now();
      lastTail = { lat: cola.lat, lng: cola.lng };

      while (limpio.length - congeladoHasta >= NUEVOS) {
        const ini = Math.max(0, congeladoHasta - SOLAPE);
        const ventana = limpio.slice(ini, ini + MAX);   // ≤ MAX SIEMPRE → no se diezma
        const coords = await matchVentana(ventana, token);
        if (cancelado?.()) return null;
        congeladas.push(coords);
        congeladoHasta += NUEVOS;
      }
      const colaVentana = limpio.slice(Math.max(0, congeladoHasta - SOLAPE));
      const coordsCola = colaVentana.length >= 2 ? await matchVentana(colaVentana, token) : [];
      if (cancelado?.()) return null;

      const todo = [...congeladas, coordsCola].flat() as [number, number][];
      return todo.length >= 2 ? todo : null;
    },
  };
}
