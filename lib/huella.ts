// lib/huella.ts
// Fuente ÚNICA de la lógica de la huella GPS (limpieza de jitter + Map Matching a la vía).
// La usan el modal (components/seguimiento/ModalGps.tsx) y el mapa "En vivo" del portal
// cliente (app/cliente/page.tsx). Antes estaba duplicada y se desincronizaba: el modal se
// arreglaba y "En vivo" quedaba con la huella cruda en zigzag. Mantener AQUÍ.

export type MatchPt = { lat: number; lng: number; acc: number };
export type HuellaPt = { lat: number; lng: number; velocidad: number; acc: number; ts: number };

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

// Media móvil sobre lat/lng (ventana ±rad puntos) para reducir el zigzag por imprecisión GPS.
// rad=1 → 3 puntos (defecto, GPS bueno). rad=2 → 5 puntos: aplana más el ruido de GPS pobre
// en la huella cruda (fallback cuando Map Matching no logra pegar a la vía).
export function suavizarHuella<T extends { lat: number; lng: number }>(pts: T[], rad = 1): T[] {
  return pts.map((p, i) => {
    const s = Math.max(0, i - rad), e = Math.min(pts.length - 1, i + rad);
    const w = pts.slice(s, e + 1);
    return { ...p, lat: w.reduce((a, q) => a + q.lat, 0) / w.length, lng: w.reduce((a, q) => a + q.lng, 0) / w.length };
  });
}

// Suavizado adaptativo por DISTANCIA: cada punto se promedia con los vecinos que caen dentro de
// R metros (ventana de índices acotada a ±K). En tramos LENTOS/densos (muchos puntos juntos) hay
// varios vecinos dentro de R → aplana el jitter perpendicular (el "zigzag rojo" del bus lento o
// parado); en tramos RÁPIDOS los puntos quedan a >R entre sí → sin vecinos → se conservan TAL
// CUAL (no recorta curvas/esquinas reales). Es geométrico, independiente de la velocidad reportada
// (el GPS pobre la da en 0). A diferencia de la media móvil por índices (suavizarHuella ±N), que
// aplana poco el zigzag lento y SÍ recorta las curvas rápidas. Verificado sobre datos reales
// (#944/#942): desviación perpendicular en tramos lentos ~2.8-10.9 m → ~0.8 m; en rápidos sin cambio.
export function suavizarPorDistancia<T extends { lat: number; lng: number }>(pts: T[], R = 40, K = 8): T[] {
  return pts.map((p, i) => {
    let sLat = 0, sLng = 0, n = 0;
    const lo = Math.max(0, i - K), hi = Math.min(pts.length - 1, i + K);
    for (let j = lo; j <= hi; j++) {
      if (distM(pts[j].lat, pts[j].lng, p.lat, p.lng) <= R) { sLat += pts[j].lat; sLng += pts[j].lng; n++; }
    }
    return n ? { ...p, lat: sLat / n, lng: sLng / n } : p;
  });
}

// Normaliza filas crudas de ubicaciones_gps a HuellaPt (acc por defecto 25 m si falta).
// `ts` (ms) del fix real (created_at, fallback timestamp) → lo usan el gate de velocidad y el
// puenteo de huecos. 0 si no hay fecha (entonces esas etapas se omiten, ver guardas).
export function filasAPuntos(filas: any[]): HuellaPt[] {
  return (filas || []).map((d: any) => ({
    lat: Number(d.lat), lng: Number(d.lng),
    velocidad: Number(d.velocidad) || 0,
    acc: d.precision_m != null ? Number(d.precision_m) : 25,
    ts: d.created_at ? new Date(d.created_at).getTime() : (d.timestamp ? new Date(d.timestamp).getTime() : 0),
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
//
// PRECISIÓN-CONSCIENTE: los radios FIJOS de 45/30 m se afinaron para GPS bueno (jitter ±26 m,
// flota propia con chip → precision_m ~8 m). Un tercero con GPS pobre (link web / equipo sin
// chip → precision_m 80-500 m) salta 60-95 m ESTANDO QUIETO; con radio fijo de 45 m esos
// saltos superan el umbral, la máquina los toma como "en marcha" y dibuja cada uno = zigzag.
// Solución: el radio de cada punto crece con SU incertidumbre `acc` (precision_m). Un fix con
// acc=500 m que cae a 120 m del centroide es, estadísticamente, el MISMO lugar → es jitter, no
// movimiento. Para acc≤30 m (GPS bueno) el radio queda en el piso 45/30 → comportamiento
// IDÉNTICO al anterior; solo se relaja para GPS pobre. Cap modesto (150/100 m) para no colapsar
// el avance real (puntos que MARCHAN en una dirección escapan igual tras ESCAPE_N muestras).
const R_STOP_M  = 45;  // piso del radio del cluster de parada (GPS bueno, jitter ±26 m)
const R_STOP_MAX = 150; // techo del radio de parada (no colapsar avance real)
const ESCAPE_N  = 3;   // muestras consecutivas alejándose para confirmar SALIDA
const DWELL_R_M = 30;  // piso del radio para detectar que el bus se volvió a parar
const DWELL_R_MAX = 100; // techo del radio de re-parada
const DWELL_N   = 3;   // muestras consecutivas asentadas para confirmar PARADA
// Radio efectivo de un punto = max(piso, min(techo, acc·1.5)). Escala con la precisión GPS.
const radioStop  = (acc: number) => Math.min(R_STOP_MAX, Math.max(R_STOP_M, (acc || 25) * 1.5));
const radioDwell = (acc: number) => Math.min(DWELL_R_MAX, Math.max(DWELL_R_M, (acc || 25)));
// Techo de incertidumbre para DIBUJAR el trazo: un fix con precision_m > esto es ubicación de
// torre/WiFi (no GPS) → demasiado incierto para la huella y suele venir con saltos imposibles
// (>1000 km/h). Se descarta SOLO de la huella; el punto en vivo y el envío no se tocan (un
// equipo sin chip puede reportar legítimamente >80 m, ver project_conectarse_gps).
const ACC_MAX_TRAIL = 300;

// Velocidad máxima creíble para un bus. Por encima de esto un "salto" es jitter/glitch de la red
// (la precisión reportada lo subestima), no movimiento real. La usan el gate (descartar el punto)
// y el puenteo (decidir si un hueco se rellena o se corta).
const VMAX_BUS_KMH = 130;

// Gate de velocidad: descarta los fixes que implican una velocidad IMPOSIBLE (>VMAX) desde el
// último fix BUENO — el glitch que "teletransporta" la posición y luego vuelve. Re-ancla tras N
// seguidos (una relocalización REAL tras pérdida de señal larga). Quitar el punto-glitch hace que
// sus vecinos queden contiguos → el trazo no se parte en ese punto. Requiere `ts` fiable; si no
// hay (ts=0 / no creciente), se omite (no filtra). Pura y testeable.
export function gateVelocidad(pts: HuellaPt[], vmaxKmh = VMAX_BUS_KMH, reanclaN = 4): HuellaPt[] {
  if (pts.length < 2 || !(pts[pts.length - 1].ts > pts[0].ts)) return pts;
  const vmax = vmaxKmh / 3.6;
  const out: HuellaPt[] = [pts[0]];
  let lejos: HuellaPt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], ref = out[out.length - 1];
    const dt = Math.max(1, (p.ts - ref.ts) / 1000);
    if (distM(ref.lat, ref.lng, p.lat, p.lng) / dt <= vmax) { out.push(p); lejos = []; }
    else { lejos.push(p); if (lejos.length >= reanclaN) { out.push(...lejos); lejos = []; } } // relocalización real
  }
  return out;
}

export function limpiarHuella(pts: HuellaPt[]): HuellaPt[] {
  // Pre-filtro: descarta fixes demasiado inciertos para el trazo (torre/WiFi, saltos imposibles).
  // PERO si eso dejaría el trazo casi vacío (equipo legítimo SIN chip, consistentemente >300 m),
  // se conservan los crudos finitos: una estela degradada es mejor que NINGUNA.
  const finitos = pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const precisos = finitos.filter((p) => p.acc <= ACC_MAX_TRAIL);
  // Gate de velocidad: quita los glitches de salto imposible (la precisión no siempre los delata).
  const base = gateVelocidad(precisos.length >= 2 ? precisos : finitos);

  const out: HuellaPt[] = [];
  const emitir = (lat: number, lng: number, velocidad: number, acc: number, ts: number) => {
    const last = out[out.length - 1];
    if (!last || distM(last.lat, last.lng, lat, lng) >= 8) out.push({ lat, lng, velocidad, acc, ts });
  };
  type Cl = { sumLat: number; sumLng: number; n: number; acc: number; ts: number };
  const nuevoCl = (p: HuellaPt): Cl => ({ sumLat: p.lat, sumLng: p.lng, n: 1, acc: p.acc, ts: p.ts });
  const cLat = (c: Cl) => c.sumLat / c.n;
  const cLng = (c: Cl) => c.sumLng / c.n;
  const fold = (c: Cl, p: HuellaPt) => { c.sumLat += p.lat; c.sumLng += p.lng; c.n++; c.acc = Math.min(c.acc, p.acc); c.ts = p.ts; };

  let modo: "stop" | "move" = "stop";
  let cl: Cl | null = null;   // stop: cluster de parada · move: cluster candidato de re-parada
  let pend: HuellaPt[] = [];  // stop: salidas pendientes de confirmar
  let dwell = 0;              // move: muestras seguidas asentadas

  for (const p of base) {
    if (modo === "stop") {
      if (!cl) { cl = nuevoCl(p); continue; }
      if (distM(cLat(cl), cLng(cl), p.lat, p.lng) < radioStop(p.acc)) {
        pend = []; fold(cl, p);                              // jitter / sigue parado
      } else {
        pend.push(p);
        if (pend.length >= ESCAPE_N) {                        // salida confirmada
          emitir(cLat(cl), cLng(cl), 0, cl.acc, cl.ts);       // el lugar de la parada
          for (const q of pend) emitir(q.lat, q.lng, q.velocidad, q.acc, q.ts);
          modo = "move"; cl = null; pend = []; dwell = 0;
        }
      }
    } else { // move
      emitir(p.lat, p.lng, p.velocidad, p.acc, p.ts);
      if (!cl) { cl = nuevoCl(p); dwell = 1; }
      else if (distM(cLat(cl), cLng(cl), p.lat, p.lng) < radioDwell(p.acc)) {
        fold(cl, p); dwell++;
        if (dwell >= DWELL_N) { modo = "stop"; pend = []; }   // se volvió a parar
      } else {
        cl = nuevoCl(p); dwell = 1;                           // sigue avanzando
      }
    }
  }
  if (modo === "stop" && cl) emitir(cLat(cl), cLng(cl), 0, cl.acc, cl.ts); // cola: parada final

  // FALLBACK: si el filtro colapsó todo a ≤1 punto pero había suficientes datos, el cluster
  // era demasiado grande para la velocidad del bus (GPS pobre + ciudad lenta). Devolver la
  // estela cruda suavizada por distancia — aplana el jitter lento, visible en vez de invisible.
  if (out.length <= 1 && base.length >= 5) return suavizarPorDistancia(base);

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
// confianza (típico en GPS pobre de terceros: la ventana se fragmenta), cae a la huella cruda
// suavizada por DISTANCIA: aplana el zigzag de los tramos lentos sin recortar las curvas rápidas.
export async function matchVentana(ventana: MatchPt[], token: string): Promise<[number, number][]> {
  const r = await mapMatchTrail(ventana, token);
  if (r && r.confidence >= 0.4 && r.coords.length >= 2) return r.coords;
  const suav = suavizarPorDistancia(ventana);
  return suav.length >= 2 ? suav.map(p => [p.lng, p.lat] as [number, number]) : [];
}

// Tramo máximo que se DIBUJA entre dos vértices consecutivos. Más largo que esto = teleport
// por pérdida de señal o fix basura → se deja un HUECO honesto en vez de una recta cruzando el
// mapa. Holgado (300 m) para no cortar avance real: la huella buena densa nunca lo alcanza
// (#1138, chip GPS a 4 s: máx ~138 m), solo lo superan los saltos imposibles del GPS pobre.
export const MAX_SEG_M = 300;

// Rellena los HUECOS de la huella (pérdida de señal en paradas/tráfico) con puntos interpolados,
// SOLO si la velocidad implícita del salto es plausible para un bus (≤VMAX_BUS_KMH). Así un tramo
// donde el GPS calló 15-70 s pero el bus avanzó 300 m-2 km a velocidad real se dibuja CONTINUO
// (recta densa) en vez de cortado; los saltos IMPOSIBLES (teleport/glitch que el gate no quitó) NO
// se rellenan → el corte por MAX_SEG_M downstream los deja como hueco honesto. La velocidad del
// puente = la implícita → el tramo se colorea como movimiento real (no "parado" rojo). Como deja
// segmentos ≤ MAX_SEG_M, NO hay que tocar colorearMatched/huellaCrudaFeatures: su corte por
// distancia ya solo alcanza los teleports. Requiere `ts`; sin él (0/no creciente) se omite. Pura.
// IMPORTANTE: correr DESPUÉS de limpiarHuella (sobre el prefijo estable) → no rompe el congelado.
// El umbral de PUENTE (120) es a propósito MENOR que el del gate (VMAX_BUS_KMH=130): un salto de
// 121-130 km/h pasa el gate (se conserva el punto) pero NO se puentea → cae al corte por MAX_SEG_M
// (hueco honesto). Solo se rellena lo CLARAMENTE plausible (≤120); la franja dudosa se corta.
export function puentearHuecos(pts: HuellaPt[], maxSegM = MAX_SEG_M, vmaxKmh = 120): HuellaPt[] {
  if (pts.length < 2 || !(pts[pts.length - 1].ts > pts[0].ts)) return pts;
  const vmax = vmaxKmh / 3.6;
  const out: HuellaPt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = distM(a.lat, a.lng, b.lat, b.lng);
    const dt = (b.ts - a.ts) / 1000;
    if (d > maxSegM && dt > 0 && d / dt <= vmax) {            // hueco real a velocidad plausible → rellenar
      const n = Math.ceil(d / (maxSegM * 0.5));               // segmentos ≤ ~150 m (nunca dispara el corte)
      const kmh = Math.round((d / dt) * 3.6);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, velocidad: kmh, acc: Math.max(a.acc, b.acc), ts: a.ts + (b.ts - a.ts) * f });
      }
    }
    out.push(b);
  }
  return out;
}

// Reparte la velocidad de la huella cruda sobre la geometría ajustada a la vía: a cada
// vértice ajustado le asigna la velocidad del punto GPS real más cercano (coloreado leyenda).
// Corta el trazo en saltos > MAX_SEG_M (costuras de ventanas fallidas / huecos).
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
    const [aLng, aLat] = coords[i], [bLng, bLat] = coords[i + 1];
    if (distM(aLat, aLng, bLat, bLng) > MAX_SEG_M) continue;   // hueco, no recta cruzando el mapa
    feats.push({
      type: "Feature",
      properties: { velocidad: velCercana(aLng, aLat) },
      geometry: { type: "LineString", coordinates: [coords[i], coords[i + 1]] },
    });
  }
  return feats;
}

// Features de la huella CRUDA (cuando Map Matching no logra pegar a la vía, p. ej. terceros con
// GPS de torre/WiFi). Parte el trazo en tramos contiguos (corta donde el salto > MAX_SEG_M: así
// el suavizado NO promedia a través de un teleport y no se dibuja una recta sobre el hueco),
// suaviza cada tramo por DISTANCIA (aplana el zigzag lento, conserva curvas rápidas) y emite un
// segmento por par, coloreado por velocidad. Fuente ÚNICA del fallback crudo del modal/cliente/cola.
export function huellaCrudaFeatures(
  huellaPts: { lat: number; lng: number; velocidad: number }[],
  maxSegM = MAX_SEG_M
): any[] {
  const tramos: typeof huellaPts[] = [];
  let cur: typeof huellaPts = [];
  for (let i = 0; i < huellaPts.length; i++) {
    if (i > 0 && distM(huellaPts[i - 1].lat, huellaPts[i - 1].lng, huellaPts[i].lat, huellaPts[i].lng) > maxSegM) {
      if (cur.length) tramos.push(cur);
      cur = [];
    }
    cur.push(huellaPts[i]);
  }
  if (cur.length) tramos.push(cur);

  const feats: any[] = [];
  for (const tramo of tramos) {
    const pts = suavizarPorDistancia(tramo);   // aplana jitter lento DENTRO del tramo (no cruza huecos)
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      feats.push({
        type: "Feature",
        properties: { velocidad: ((a.velocidad ?? 0) + (b.velocidad ?? 0)) / 2 },
        geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
      });
    }
  }
  return feats;
}

// Cola VIVA: extiende el trazo AJUSTADO hasta el vehículo. El Map Matching se recalcula con
// throttle (60 s), así que su último vértice queda hasta 60 s atrás del bus (≈800 m a 48 km/h)
// → la huella "no alcanza" al vehículo. Esto añade, DESPUÉS del final del trazo ajustado, los
// puntos CRUDOS aún no matcheados (densos: no se descartan por MAX_SEG_M) y, si se da, la
// posición EN VIVO. Sin coste extra de Map Matching. Devuelve features coloreados por velocidad.
export function colaViva(
  matched: [number, number][],
  huella: { lat: number; lng: number; velocidad: number }[],
  live?: { lat: number; lng: number; velocidad?: number } | null,
): any[] {
  if (!matched.length) return [];
  const [endLng, endLat] = matched[matched.length - 1];
  // Punto crudo más cercano al final del trazo ajustado = frontera de lo ya matcheado.
  let bestI = -1, bd = Infinity;
  for (let i = 0; i < huella.length; i++) {
    const d = distM(endLat, endLng, huella[i].lat, huella[i].lng);
    if (d < bd) { bd = d; bestI = i; }
  }
  const tail = bestI >= 0 ? huella.slice(bestI + 1) : [];   // puntos POSTERIORES (no matcheados)
  // Anclar al final REAL del trazo ajustado para no dejar hueco en la unión.
  const pts: { lat: number; lng: number; velocidad: number }[] = [
    { lat: endLat, lng: endLng, velocidad: tail[0]?.velocidad ?? huella[bestI]?.velocidad ?? 0 },
    ...tail,
  ];
  if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    const lastP = pts[pts.length - 1];
    if (!lastP || distM(lastP.lat, lastP.lng, live.lat, live.lng) > 3) {  // evita duplicar el vivo
      pts.push({ lat: live.lat, lng: live.lng, velocidad: live.velocidad ?? lastP?.velocidad ?? 0 });
    }
  }
  return pts.length >= 2 ? huellaCrudaFeatures(pts) : [];
}

// Estima la velocidad (km/h) de un historial de fixes, ROBUSTA al jitter del GPS de red.
// Punto-a-punto NO sirve: con ±37 m de precisión, dos fixes a 1 s "saltan" 80 m → 288 km/h.
//   1) si el equipo entrega una velocidad PLAUSIBLE (0 < v ≤ maxKmh) se usa tal cual;
//   2) si no, se mide el DESPLAZAMIENTO sobre la ventana más larga disponible de ≥ minVentanaMs:
//      el jitter se promedia y, restando el piso de ruido (incertidumbre combinada), un bus
//      quieto da 0 y uno en marcha da su velocidad real.
// Devuelve `null` cuando el resultado es IMPLAUSIBLE o aún no hay ventana → el llamador
// CONSERVA el último valor bueno (nunca pinta una cifra absurda). Pura y testeable.
export type FixVel = { lat: number; lng: number; ts: number; acc: number };
export function velocidadPorVentana(
  hist: FixVel[],
  devVelKmh: number,
  opts?: { maxKmh?: number; minVentanaMs?: number; ruidoMaxM?: number },
): number | null {
  const maxKmh = opts?.maxKmh ?? 130;
  const minMs  = opts?.minVentanaMs ?? 10_000;
  const ruidoMax = opts?.ruidoMaxM ?? 150;
  if (devVelKmh > 0 && devVelKmh <= maxKmh) return devVelKmh;   // velocidad del equipo, si es real
  if (hist.length < 2) return null;
  const ahora = hist[hist.length - 1];
  let ancla: FixVel | null = null;
  for (const h of hist) { if (ahora.ts - h.ts >= minMs) { ancla = h; break; } } // ventana más larga ≥ minMs
  if (!ancla) return null;
  const dt = (ahora.ts - ancla.ts) / 1000;
  if (dt <= 0) return null;
  const disp = distM(ancla.lat, ancla.lng, ahora.lat, ahora.lng);
  const ruido = Math.min(ruidoMax, ancla.acc + ahora.acc);
  if (disp <= ruido) return 0;                                   // dentro del ruido = quieto
  const kmh = Math.round((disp / dt) * 3.6);
  return kmh > maxKmh ? null : kmh;                              // implausible → conservar valor previo
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
