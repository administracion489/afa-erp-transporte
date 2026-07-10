// lib/huella.ts
// Fuente ÚNICA de la lógica de la huella GPS (limpieza de jitter + Map Matching a la vía).
// La usan el modal (components/seguimiento/ModalGps.tsx) y el mapa "En vivo" del portal
// cliente (app/cliente/page.tsx). Antes estaba duplicada y se desincronizaba: el modal se
// arreglaba y "En vivo" quedaba con la huella cruda en zigzag. Mantener AQUÍ.

export type MatchPt = { lat: number; lng: number; acc: number };
// `rumbo` (0-360) = dirección REAL que reporta el equipo (columna ubicaciones_gps.rumbo). Solo
// llega con chip satelital/Doppler; con GPS de red viene 0 y se DERIVA por bearing al mostrarla.
// Opcional: la máquina de limpiarHuella crea puntos sin rumbo (lo recupera puntosTelemetria del crudo).
export type HuellaPt = { lat: number; lng: number; velocidad: number; acc: number; ts: number; rumbo?: number };

// Un puntito de telemetría REAL sobre la huella (Idea 2). `velReal`/`rumboReal` = el dato vino del
// equipo (Doppler); si false, se derivó (velocidad por desplazamiento / rumbo por bearing) → la UI
// lo etiqueta "aprox.". Nunca se interpola posición: cada puntito cae en una muestra real.
export type PuntoTelemetria = {
  lat: number; lng: number;
  velocidad: number; velReal: boolean;
  rumbo: number; rumboReal: boolean;
  acc: number; ts: number;
};

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
    rumbo: Number(d.rumbo) || 0,   // dirección real del equipo (0 si no hay Doppler → se deriva luego)
  }));
}

// Precisión (precision_m) por debajo de la cual un fix es CONFIABLE (chip satelital: la flota buena
// da ~3-8 m). Por encima es red/torre: la posición cruda puede estar a 50-700 m de la real. El
// usuario pidió "±10", pero el GPS satelital sano jitterea hasta ~10-12 m; 20 m separa limpio el
// satélite (≤8 m en los datos) del degradado (≥48 m) sin tocar el jitter normal.
const ACC_CONFIABLE_M = 20;
// Precisión mediana reciente por encima de la cual la cola se considera DEGRADADA (la que zigzaguea):
// activa el Map Matching rápido (12 s) y el umbral de movimiento consciente del jitter. Entre el
// confiable (20) y el aviso de "GPS débil" al operador (60).
const ACC_DEGRADADO_M = 30;

// Proyecta (lat,lng) sobre el segmento A-B en metros locales (equirectangular). Devuelve el punto
// del segmento más cercano y la distancia perpendicular (dist) — usada para decidir si anclar.
function proyectarEnSegmento(lat: number, lng: number, A: { lat: number; lng: number }, B: { lat: number; lng: number }): { lat: number; lng: number; dist: number } {
  const mLat = 111320, mLng = 111320 * Math.cos(lat * Math.PI / 180);
  const ax = A.lng * mLng, ay = A.lat * mLat, bx = B.lng * mLng, by = B.lat * mLat;
  const px = lng * mLng, py = lat * mLat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { lat: qy / mLat, lng: qx / mLng, dist: Math.hypot(px - qx, py - qy) };
}

// ANCLA los fixes IMPRECISOS a la trayectoria de los CONFIABLES (Idea del usuario, jul-2026): un fix
// de red de ±100 m dibujado en su posición cruda hace zigzags imposibles — cruza al carril de sentido
// contrario, por casas, por el río. Aquí, un fix con acc > ACC_CONFIABLE_M se PROYECTA sobre la cuerda
// entre su vecino confiable ANTES y el DESPUÉS — sobre el CARRIL correcto, porque el objetivo es la
// propia traza buena, no la vía más cercana (que podría ser la opuesta). DOS candados que impiden
// borrar geometría REAL (regla de la casa: nunca fabricar un recorrido):
//   1. Corredor CORTO: ambas anclas a ≤ maxGapM. Sin corredor confiable cerca (zona larga degradada)
//      no se ancla → ahí decide Map Matching.
//   2. Candado PERPENDICULAR: solo se ancla si el fix crudo está a una distancia de la cuerda
//      CONSISTENTE con su propia imprecisión (≤ max(70, 1.5·acc)). Si está mucho más lejos, NO es
//      ruido lateral: es un DESVÍO real por calle secundaria o el exterior de una CURVA → se deja
//      intacto (anclarlo dibujaría por la avenida donde el bus no fue, o cortaría la esquina).
// Ancla solo la POSICIÓN; deja acc/velocidad/rumbo/ts intactos (la precisión sigue honesta en el
// popup). NO agrega/quita puntos (out = pts.slice, solo muta lat/lng) → índices y congelado por
// índice de crearAjustadorHuella intactos. Estabilidad: un punto con SUS DOS anclas ya fijas es
// determinista entre re-fetch; los de la COLA sin ancla-posterior aún se dejan intactos y pueden
// re-anclar (asentarse) cuando llega un confiable después — mutación tardía normal de la cola viva.
export function anclarImprecisos(pts: HuellaPt[], umbral = ACC_CONFIABLE_M, maxGapM = 200): HuellaPt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const relB = new Array<number>(n).fill(-1), relA = new Array<number>(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) { relB[i] = last; if (pts[i].acc <= umbral) last = i; }
  last = -1;
  for (let i = n - 1; i >= 0; i--) { relA[i] = last; if (pts[i].acc <= umbral) last = i; }
  const out = pts.slice();
  for (let i = 0; i < n; i++) {
    if (pts[i].acc <= umbral) continue;                                          // confiable → intacto
    const jb = relB[i], ja = relA[i];
    if (jb < 0 || ja < 0) continue;                                              // extremo sin ancla de un lado
    if (distM(pts[jb].lat, pts[jb].lng, pts[ja].lat, pts[ja].lng) > maxGapM) continue; // corredor largo → no anclar
    const q = proyectarEnSegmento(pts[i].lat, pts[i].lng, pts[jb], pts[ja]);
    if (q.dist > Math.max(70, 1.5 * pts[i].acc)) continue;                       // lejos de la cuerda vs su precisión = desvío/curva real → dejar
    out[i] = { ...pts[i], lat: q.lat, lng: q.lng };                             // ruido lateral → anclar al corredor confiable
  }
  return out;
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

// ⚠️ SIN USO (revertido en commit posterior a 5423ec6): junto con puentearHuecos invitaba a
// dibujar rutas inventadas en GPS pobre de terceros (#786/#946: trazo por calles donde el bus no
// fue). Se conserva por si se retoma con un enfoque más conservador. NO re-cablear sin re-evaluar.
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

// PICOS-V (filtro Hampel): un vértice es un pico ida-y-vuelta cuando sus DOS vecinos concuerdan
// entre sí (prev-next chico) y discrepan de él (legs grandes) — el GPS "saltó" 200-1000 m y
// REGRESÓ en el siguiente fix (#1147: 9 picos, hasta 1080 m ida / 1016 m vuelta con prev-next a
// 64 m). Solo se borra si además su precisión es grado-RED (acc ≥ 50): en los datos reales los
// picos tienen acc mediana 82.5 vs 34.8 global, y así un ápice legítimo de curva/óvalo con chip
// GPS (acc < 20) queda protegido. Un giro real en U de bus a esta cadencia da legs de 20-40 m,
// nunca >120 m. NO inventa geometría: solo ELIMINA vértices demostrablemente falsos. Hasta 3
// pasadas (un pico doble se resuelve por capas). Determinista sobre el prefijo (el último punto
// no tiene `next` → se juzga recién en el siguiente ciclo, dentro de la cola no congelada).
function quitarPicosV(pts: HuellaPt[]): HuellaPt[] {
  // Guard TEMPORAL además del geométrico (hallazgo del review): la población acc≥50 es la de
  // terceros con cadencia espaciada (30-60 s), donde un RETORNO REAL de avenida da legs de
  // 300-1000 m a velocidad plausible — geométricamente indistinguible de un pico. Solo se borra
  // si al menos una pierna implica velocidad IMPOSIBLE (>VMAX_BUS_KMH): el pico de 1080 m en 7 s
  // (#1147) = 555 km/h → fuera; un retorno a 60 km/h → se conserva (regla de la casa: solo
  // eliminar lo DEMOSTRABLEMENTE falso). Sin ts fiable no se filtra (conservador, como gateVelocidad).
  if (pts.length < 3 || !(pts[pts.length - 1].ts > pts[0].ts)) return pts;
  const vmax = VMAX_BUS_KMH / 3.6;
  let cur = pts;
  for (let pasada = 0; pasada < 3; pasada++) {
    const out: HuellaPt[] = [];
    let removed = false;
    for (let i = 0; i < cur.length; i++) {
      if (i > 0 && i < cur.length - 1 && cur[i].acc >= 50) {
        const A = distM(cur[i - 1].lat, cur[i - 1].lng, cur[i].lat, cur[i].lng);
        const B = distM(cur[i].lat, cur[i].lng, cur[i + 1].lat, cur[i + 1].lng);
        const C = distM(cur[i - 1].lat, cur[i - 1].lng, cur[i + 1].lat, cur[i + 1].lng);
        const dtA = Math.max(1, (cur[i].ts - cur[i - 1].ts) / 1000);
        const dtB = Math.max(1, (cur[i + 1].ts - cur[i].ts) / 1000);
        const imposible = A / dtA > vmax || B / dtB > vmax;
        if (A > 120 && B > 120 && C < 0.5 * Math.min(A, B) && imposible) { removed = true; continue; } // pico: fuera
      }
      out.push(cur[i]);
    }
    cur = out;
    if (!removed) break;
  }
  return cur;
}

// Aceleración lateral máxima CREÍBLE para un bus de pasajeros (m/s²). Un giro cómodo va ~1.5-2; por
// encima de ~0.3 g el "giro" es físicamente implausible para un bus con pasajeros (derraparía/volcaría).
const ACC_LAT_MAX = 3.0;
// Radio del arco por 3 puntos = radio CIRCUNSCRITO EXACTO. Con lados A, B y flecha perp del punto
// medio a la cuerda: R = A·B / (2·perp). Se usa este exacto (no la aproximación de flecha C²/(8·perp))
// porque esa aproximación EXPLOTA cuando una pierna abarca gran parte del arco (rampa cerrada
// muestreada a cadencia lenta de un tercero) → daría aceleraciones de miles y borraría una rampa REAL
// (hallazgo del review). El exacto da la aceleración física verdadera en todo el rango.
const radioArco = (A: number, B: number, perp: number) => (perp > 0 ? (A * B) / (2 * perp) : Infinity);

// Quita OUTLIERS LATERALES de fixes IMPRECISOS (regla del usuario, jul-2026: un vehículo NO cruza un
// río ni salta al carril de sentido contrario; la huella solo se desvía donde hay una vía real). Un
// fix de red que se aleja de la línea entre sus vecinos —cruzando el río, O yéndose de lado aunque el
// bus progrese— implica un GIRO que a la velocidad del tramo sería FÍSICAMENTE IMPOSIBLE para un bus.
// Se borra el vértice si: (a) es impreciso (acc > ACC_CONFIABLE — un chip satelital ni se evalúa);
// (b) su distancia PERPENDICULAR a la cuerda prev-next supera su imprecisión (perp > max(60, 1.2·acc)
// → es un desvío real, no ruido chico); y (c) la ACELERACIÓN LATERAL implícita de pasar por ese
// vértice supera ACC_LAT_MAX. El arco por los 3 puntos tiene radio R ≈ C²/(8·perp) (C=cuerda, perp=
// flecha) y la aceleración lateral a = v²/R = 8·perp·v²/C². Un SOLO test físico que subsume el piso de
// velocidad (giro LENTO → a baja → se conserva, ej. U-turn de bus) y la cuerda (curva ANCHA real →
// R grande → a baja → se conserva); solo un desvío CERRADO y RÁPIDO (spike/cruce de río a 84 km/h con
// 107 m de flecha = ~0.5 g, imposible) se borra. Al quitar el vértice falso, los vecinos (sobre la
// vía) se unen → la huella se mantiene en la pista. Sin ts fiable no filtra. Hasta 5 pasadas
// (multi-punto por capas). Determinista sobre el prefijo (local: prev/punto/next), como quitarPicosV.
function quitarExcursiones(pts: HuellaPt[]): HuellaPt[] {
  if (pts.length < 3 || !(pts[pts.length - 1].ts > pts[0].ts)) return pts;
  let cur = pts;
  for (let pasada = 0; pasada < 5; pasada++) {
    const out: HuellaPt[] = [];
    let removed = false;
    for (let i = 0; i < cur.length; i++) {
      if (i > 0 && i < cur.length - 1 && cur[i].acc > ACC_CONFIABLE_M) {
        const perp = proyectarEnSegmento(cur[i].lat, cur[i].lng, cur[i - 1], cur[i + 1]).dist;
        const A = distM(cur[i - 1].lat, cur[i - 1].lng, cur[i].lat, cur[i].lng);
        const B = distM(cur[i].lat, cur[i].lng, cur[i + 1].lat, cur[i + 1].lng);
        const dtA = Math.max(1, (cur[i].ts - cur[i - 1].ts) / 1000);
        const dtB = Math.max(1, (cur[i + 1].ts - cur[i].ts) / 1000);
        const v = Math.max(A / dtA, B / dtB);                    // m/s (la pierna más rápida)
        const latA = (v * v) / radioArco(A, B, perp);            // aceleración lateral = v²/R (R exacto)
        if (perp > Math.max(60, 1.2 * cur[i].acc) && latA > ACC_LAT_MAX) { removed = true; continue; }
      }
      out.push(cur[i]);
    }
    cur = out;
    if (!removed) break;
  }
  return cur;
}

export function limpiarHuella(pts: HuellaPt[]): HuellaPt[] {
  // Pre-filtro: descarta fixes demasiado inciertos para el trazo (torre/WiFi, saltos imposibles).
  // PERO si eso dejaría el trazo casi vacío (equipo legítimo SIN chip, consistentemente >300 m),
  // se conservan los crudos finitos: una estela degradada es mejor que NINGUNA.
  const finitos = pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const precisos = finitos.filter((p) => p.acc <= ACC_MAX_TRAIL);
  const basePre = precisos.length >= 2 ? precisos : finitos;
  // quitarPicosV mata los picos a velocidad IMPOSIBLE; quitarExcursiones mata las excursiones
  // ida-y-vuelta de fixes IMPRECISOS a velocidad plausible (el salto que cruza el río y vuelve).
  const base = quitarExcursiones(quitarPicosV(basePre));

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
  // Umbral sobre el conteo PRE-picos (review): una traza minúscula (5-6 fixes) con un pico
  // borrado no debe perder el fallback — se devuelve la base ya despicada, pero la DECISIÓN de
  // mostrar "algo antes que nada" se toma sobre lo que llegó del equipo.
  if (out.length <= 1 && basePre.length >= 5 && base.length >= 2) return suavizarPorDistancia(base);

  return out;
}

// Velocidad para COLOREAR la huella (leyenda Parado/Lento/Moderado/Rápido). Muchos equipos de
// terceros NO reportan velocidad por Doppler → mandan `velocidad`=0 SIEMPRE, y la huella salía
// TODA ROJA aunque el bus fuera a 70 km/h (la flota propia sí trae Doppler y se ve bien). Aquí: si
// el campo `velocidad` no es fiable (0 o absurdo), se DERIVA del desplazamiento sobre una ventana
// de tiempo (~±6 s, robusta al jitter; punto-a-punto daría velocidades fantasma), mismo criterio
// que velocidadPorVentana del recuadro en vivo. Si el equipo SÍ da Doppler, se respeta. Requiere
// `ts`; sin él (0/no creciente) no toca nada. Solo cambia el COLOR, no la geometría.
export function conVelocidadColor(pts: HuellaPt[], ventanaMs = 6000, maxKmh = 130): HuellaPt[] {
  const tsFiable = pts.length >= 2 && pts[pts.length - 1].ts > pts[0].ts;
  return pts.map((p, i) => {
    if (p.velocidad > 0 && p.velocidad <= maxKmh) return p;   // Doppler fiable (flota propia) → respetar
    if (!tsFiable) return p;
    // Incluir SIEMPRE los vecinos inmediatos (i-1, i+1) y extender hasta ventanaMs. Sin esto, si la
    // cadencia es espaciada (el throttle cree "parado" porque el equipo da velocidad 0), los vecinos
    // quedan a >ventanaMs → la ventana colapsaba a 1 punto (dt=0) → no derivaba → seguía rojo.
    let a = Math.max(0, i - 1), b = Math.min(pts.length - 1, i + 1);
    while (a > 0 && p.ts - pts[a - 1].ts < ventanaMs) a--;
    while (b < pts.length - 1 && pts[b + 1].ts - p.ts < ventanaMs) b++;
    const dt = (pts[b].ts - pts[a].ts) / 1000;
    if (dt <= 0) return p;
    const kmh = (distM(pts[a].lat, pts[a].lng, pts[b].lat, pts[b].lng) / dt) * 3.6;
    return kmh > maxKmh ? p : { ...p, velocidad: Math.round(kmh) };   // absurdo → conservar; si no, derivada
  });
}

// Puntitos de telemetría REAL a lo largo de la huella (Idea 2). Ancla un puntito a la muestra más
// cercana a cada hito de ~pasoM metros de recorrido — NUNCA interpola una posición/velocidad que
// no existió. Si un intervalo de 2 s cubrió 200 m, salen puntitos solo donde hubo muestra real (el
// espaciado ancho ES la señal honesta de poca telemetría), no puntos inventados a los 100 m.
//
// `limpia` (limpiarHuella + conVelocidadColor) da la POSICIÓN sobre el trazo dibujado y la velocidad
// de color. `crudos` (filasAPuntos, con rumbo) aporta la TELEMETRÍA REAL del equipo: se busca la
// muestra cruda más cercana a cada puntito y de ahí sale la velocidad Doppler y el rumbo reales.
// Cuando el equipo no da Doppler (velocidad/rumbo = 0) se deriva (color / bearing) y se marca
// real=false. Función PURA y determinista sobre el prefijo append-only (mismo trazo → mismos puntos).
export function puntosTelemetria(limpia: HuellaPt[], crudos: HuellaPt[], pasoM = 100): PuntoTelemetria[] {
  if (!limpia || limpia.length === 0) return [];
  const crudosOk = (crudos || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  // Cada punto de limpiarHuella conserva el `ts` de SU fix crudo (los "en marcha" son el fix mismo;
  // los centroides de parada llevan el ts del último fix agrupado). Así el crudo fuente se recupera
  // por IDENTIDAD de ts (Map O(1)) — no por cercanía geométrica, que en una ruta que se cruza
  // consigo misma (ida y vuelta por la misma avenida) tomaría el rumbo del pase OPUESTO (~180°
  // invertido). El barrido espacial queda solo de respaldo (ts=0 / sin match), rara vez usado.
  const porTs = new Map<number, HuellaPt>();
  for (const c of crudosOk) { if (c.ts > 0 && !porTs.has(c.ts)) porTs.set(c.ts, c); }
  const crudoEspacial = (lat: number, lng: number): HuellaPt | null => {
    let best: HuellaPt | null = null, bd = Infinity;
    for (const c of crudosOk) { const d = distM(lat, lng, c.lat, c.lng); if (d < bd) { bd = d; best = c; } }
    return best;
  };
  const out: PuntoTelemetria[] = [];
  const empujar = (i: number) => {
    const p = limpia[i];
    const c = (p.ts > 0 && porTs.get(p.ts)) || crudoEspacial(p.lat, p.lng);
    const velReal = !!c && c.velocidad > 0;                       // velocidad Doppler del equipo
    const velocidad = velReal ? c!.velocidad : (p.velocidad || 0); // si no, la derivada de color
    const rumboReal = !!c && (c.rumbo || 0) > 0;                  // rumbo Doppler del equipo
    let rumbo: number;
    if (rumboReal) rumbo = c!.rumbo || 0;
    else if (i + 1 < limpia.length) rumbo = calcBearing(p.lat, p.lng, limpia[i + 1].lat, limpia[i + 1].lng);
    else if (i > 0) rumbo = calcBearing(limpia[i - 1].lat, limpia[i - 1].lng, p.lat, p.lng);
    else rumbo = 0;
    out.push({
      lat: p.lat, lng: p.lng,
      velocidad: Math.round(velocidad), velReal,
      rumbo: Math.round(rumbo), rumboReal,
      acc: c ? c.acc : p.acc, ts: p.ts,
    });
  };
  empujar(0);                                    // el primer punto siempre
  let acc = 0;
  for (let i = 1; i < limpia.length; i++) {
    acc += distM(limpia[i - 1].lat, limpia[i - 1].lng, limpia[i].lat, limpia[i].lng);
    if (acc >= pasoM) { empujar(i); acc = 0; }
  }
  const last = limpia.length - 1;                 // cerrar con el último si no cayó justo en un hito
  if (last > 0 && out[out.length - 1].ts !== limpia[last].ts) empujar(last);
  return out;
}

// Resumen del viaje derivado de datos REALES (Idea/mejora extra 3). Solo agrega/cuenta lo medido —
// no infiere posición. `limpia` (huella dibujada) da km y velocidad máx; `crudos` (todos los fixes,
// con sus ts) dan el tiempo, el detenido y las paradas (la limpia colapsa cada parada a 1 vértice y
// pierde su duración). El badge `medidoPct` = fracción del recorrido efectivamente rastreada frente
// a los huecos (> MAX_SEG_M, tramos donde se perdió señal) → "Rastreo X% medido".
export type ResumenViaje = {
  kmRecorridos: number; tiempoTotalMin: number; tiempoMovimientoMin: number; tiempoDetenidoMin: number;
  velMaxKmh: number; paradas: number;
  horaSalida: number; horaLlegada: number;            // ms epoch (la UI formatea en hora Perú)
  medidoPct: number; precisionMedianaM: number; puntosTotales: number;
};
export function resumenViaje(limpia: HuellaPt[], crudos: HuellaPt[]): ResumenViaje | null {
  const cru = (crudos || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.ts > 0).sort((a, b) => a.ts - b.ts);
  if (cru.length < 2 || !limpia || limpia.length < 2) return null;

  // km recorridos + calidad, sobre la huella limpia (cortando huecos > MAX_SEG_M = tramos perdidos).
  let distMedida = 0, distHuecos = 0;
  for (let i = 1; i < limpia.length; i++) {
    const d = distM(limpia[i - 1].lat, limpia[i - 1].lng, limpia[i].lat, limpia[i].lng);
    if (d > MAX_SEG_M) distHuecos += d; else distMedida += d;
  }
  // velMax ROBUSTO: p95 de las velocidades creíbles, con tope de bus realista (110, NO el VMAX de
  // imposibilidad 130). El p95 ignora un pico aislado — el proveedor FUSED reporta velocidad
  // FANTASMA en el jitter de un bus parado y conVelocidadColor puede derivar picos por saltos de
  // GPS pobre; un único glitch NO debe volverse el "Vel. máx" que ve el cliente. Prefiere Doppler
  // real (crudos.velocidad>0) si el equipo lo trae; si no, la derivada de la huella coloreada.
  const VMAX_DISPLAY = 110;
  const dopplers = cru.map((c) => c.velocidad).filter((v) => v > 0 && v <= VMAX_BUS_KMH);
  const velsCreibles = (dopplers.length >= 3 ? dopplers : limpia.map((p) => p.velocidad))
    .filter((v) => v > 0 && v <= VMAX_DISPLAY).sort((a, b) => a - b);
  const velMax = velsCreibles.length ? velsCreibles[Math.floor((velsCreibles.length - 1) * 0.95)] : 0;

  // Tiempo, detenido y detenciones desde los crudos (retienen todos los timestamps). "Detenido" =
  // desplazamiento dentro de la precisión (jitter, no movimiento), CON TECHO de 60 m: con GPS de
  // red (acc 100-500 m) un umbral = acc se tragaría la marcha lenta urbana (40-90 m/fix) y la
  // contaría como detenida. Los huecos de señal (> 5 min) no cuentan ni marcha ni detenido.
  const GAP_MAX_S = 300, MIN_PARADA_S = 90, JITTER_MAX_M = 60;
  let tMovS = 0, tDetS = 0, paradas = 0, rachaDetS = 0;
  for (let i = 1; i < cru.length; i++) {
    const dt = (cru[i].ts - cru[i - 1].ts) / 1000;
    if (dt <= 0 || dt > GAP_MAX_S) { if (rachaDetS >= MIN_PARADA_S) paradas++; rachaDetS = 0; continue; }
    const d = distM(cru[i - 1].lat, cru[i - 1].lng, cru[i].lat, cru[i].lng);
    const detenido = d < Math.min(JITTER_MAX_M, Math.max(25, cru[i - 1].acc || 25, cru[i].acc || 25));
    if (detenido) { tDetS += dt; rachaDetS += dt; }
    else { tMovS += dt; if (rachaDetS >= MIN_PARADA_S) paradas++; rachaDetS = 0; }
  }
  if (rachaDetS >= MIN_PARADA_S) paradas++;

  const accs = cru.map((c) => c.acc || 25).sort((a, b) => a - b);
  const total = distMedida + distHuecos;
  return {
    kmRecorridos: Math.round(distMedida / 100) / 10,
    tiempoTotalMin: Math.round((cru[cru.length - 1].ts - cru[0].ts) / 60000),
    tiempoMovimientoMin: Math.round(tMovS / 60),
    tiempoDetenidoMin: Math.round(tDetS / 60),
    velMaxKmh: Math.round(velMax),
    paradas,
    horaSalida: cru[0].ts, horaLlegada: cru[cru.length - 1].ts,
    medidoPct: total > 0 ? Math.round((distMedida / total) * 100) : 100,
    precisionMedianaM: Math.round(accs[Math.floor(accs.length / 2)]),
    puntosTotales: cru.length,
  };
}

// ── PUENTE AZUL DE HUECOS (Idea 1) ──────────────────────────────────────────
// Cuando la huella se CORTA por falta de GPS (túnel / zona muerta), en vez de dejar el hueco o —lo
// PROHIBIDO— dibujar una recta que cruza casas, se rellena con el camino de CARRETERA real entre el
// último fix bueno y el primero tras el hueco (Google Directions, en el consumidor), pintado azul
// punteado y ETIQUETADO como estimado. NUNCA se mezcla con la huella medida ni entra a limpiarHuella/
// crearAjustadorHuella: es un overlay aparte, inmune al congelado por índice.
export type PuenteHueco = { aLat: number; aLng: number; bLat: number; bLng: number; dt: number; dRecta: number; iA: number; iB: number; origen?: "hueco" | "crudo" };

// Detecta los HUECOS candidatos a puentear en la huella limpia (gates GEOMÉTRICOS y TEMPORALES; los
// de carretera/ambigüedad se aplican en el consumidor con la respuesta de Directions). Un hueco
// califica si: (1) el salto recto > MAX_SEG_M (300 m) — lo que hoy se dibuja cortado; (2) el tiempo
// del hueco está entre 20 s y 5 min (menos casi nunca deja hueco; MÁS = celular apagado / bus
// estacionado largo → no sabemos qué pasó, NO puentear); (3) la velocidad implícita RECTA es posible
// (≤ VMAX) — si no, es teleport/glitch, no hueco de bus. Requiere ts fiable (si no, no puentea).
export function calcularPuentes(limpia: HuellaPt[]): PuenteHueco[] {
  const DT_MIN_S = 20, DT_MAX_S = 300;
  const vmax = VMAX_BUS_KMH / 3.6; // m/s
  const out: PuenteHueco[] = [];
  for (let i = 1; i < limpia.length; i++) {
    if (i === limpia.length - 1) continue;             // no puentear el ÚLTIMO par (cola viva mutable): B aún puede moverse → evita que el puente parpadee/salte hasta que B se consolide
    const A = limpia[i - 1], B = limpia[i];
    if (!(A.ts > 0 && B.ts > A.ts)) continue;
    const dRecta = distM(A.lat, A.lng, B.lat, B.lng);
    if (dRecta <= MAX_SEG_M) continue;                 // no es un hueco cortado
    const dt = (B.ts - A.ts) / 1000;
    if (dt < DT_MIN_S || dt > DT_MAX_S) continue;      // muy corto / celular apagado
    if (dRecta / dt > vmax) continue;                  // velocidad recta imposible = teleport, no hueco
    out.push({ aLat: A.lat, aLng: A.lng, bLat: B.lat, bLng: B.lng, dt, dRecta, iA: i - 1, iB: i, origen: "hueco" });
  }
  return out;
}

// Corridas de CRUDO CONGELADO (ventanas que Map Matching NO pudo pegar a la vía → snapped=false, el
// fallo dominante del GPS de red de terceros: el zigzag/"rectas que cruzan techos") como candidatas a
// RELLENARSE con la ruta (planificada→Google), igual que los huecos de señal. Cada rango [s,e] viene
// del ajustador en el espacio de las coords devueltas y EXCLUYE la cola viva → el tramo estimado nunca
// parpadea en la punta. Ancla A = último vértice PEGADO antes del crudo, B = primer pegado después; el
// consumidor los pasa a puentePorRuta (candado de desvío 200 m + rodeo>8× vía decidirPuente). Se rutea
// solo si la recta A→B ≥ minRectaM (una corrida corta ya hugea la pista → no vale la pena, evita confeti).
export function puentesCrudos(
  coords: [number, number][],
  crudoRanges: Array<[number, number]>,
  minRectaM = 40,   // rutea también corridas cortas (una corrida <40m ya hugea la misma calle; menos residual de rectas)
): PuenteHueco[] {
  const out: PuenteHueco[] = [];
  for (const [s, e] of crudoRanges) {
    if (e + 1 >= coords.length) continue;   // toca la punta viva (la cubre colaViva) → no rutear aquí
    const iA = s > 0 ? s - 1 : 0;           // s=0 (el viaje ARRANCA crudo): ancla al primer punto (se proyecta sobre la ruta)
    const A = coords[iA], B = coords[e + 1];
    const dRecta = distM(A[1], A[0], B[1], B[0]);
    if (dRecta < minRectaM) continue;
    out.push({ aLat: A[1], aLng: A[0], bLat: B[1], bLng: B[0], dt: 0, dRecta, iA, iB: e + 1, origen: "crudo" });
  }
  return out;
}

export type NivelPuente = "puente" | "ocultar";
// UNIR TODO (decisión del usuario, jul-2026): todo hueco REAL —ya filtrado por calcularPuentes:
// salto > 300 m, hueco 20-300 s, velocidad recta plausible (< 130) → NO es un teleport/glitch ni un
// celular apagado— se rellena con el camino de CARRETERA de Google (`roadM`/`coords`). Al ir SIEMPRE
// por calles (nunca una recta A-B), el puente JAMÁS cruza el río: Google rodea por el puente real.
// Se aceptó el RODEO GRANDE a cambio de una huella continua (por eso NO hay tope de detour "normal").
// ÚNICO corte: (a) Google no devuelve ruta (roadM ≤ 0), o (b) el detour es ABSURDO (> 8× la recta):
// eso ya no es un rodeo real sino que un extremo del hueco quedó al otro lado de un río/barrera (GPS
// residual) → unir ahí dibujaría un lazo de kms cruzando el río a un punto equivocado (contradice
// "nunca cruzar el río"). El filtro de excursiones ya limpia casi todos esos extremos; esto es la red.
export function decidirPuente(roadM: number, dRecta: number): NivelPuente {
  if (roadM <= 0) return "ocultar";
  if (dRecta > 0 && roadM / dRecta > 8) return "ocultar";   // rodeo absurdo = extremo al otro lado del río
  return "puente";
}

// Rellena un hueco (A→B) SIGUIENDO LA RUTA PLANIFICADA (la línea discontinua azul) en vez de una ruta
// fresca de Google (decisión del usuario, jul-2026): el tramo estimado queda EXACTAMENTE sobre la vía
// prevista (misma pista, nunca cruza el río, sin rodeos raros), reutilizando la ruta que ya tenemos.
// Proyecta A y B al vértice más cercano de la polilínea de la ruta y devuelve el sub-tramo entre ambas
// proyecciones, con A y B como extremos (para cerrar la unión con la huella medida). Devuelve null si
// no hay ruta o si A/B caen demasiado lejos de ella (el bus se DESVIÓ de lo planificado → el consumidor
// cae al puente por Google). `ruta` viene en [lng, lat] (convención Mapbox).
export function puentePorRuta(
  A: { lat: number; lng: number }, B: { lat: number; lng: number },
  ruta: [number, number][], maxDesvioM = 200,   // 200 m: los conectores rectos A→ruta y ruta→B quedan cortos (el resto cae a Google)
): [number, number][] | null {
  if (!ruta || ruta.length < 2) return null;
  // Distancia acumulada a lo largo de la ruta (para medir "hacia adelante" y longitud del tramo).
  const cum = [0];
  for (let i = 1; i < ruta.length; i++) cum[i] = cum[i - 1] + distM(ruta[i - 1][1], ruta[i - 1][0], ruta[i][1], ruta[i][0]);
  // A: vértice más cercano en TODA la ruta.
  let ia = -1, da = Infinity;
  for (let i = 0; i < ruta.length; i++) { const d = distM(A.lat, A.lng, ruta[i][1], ruta[i][0]); if (d < da) { da = d; ia = i; } }
  if (ia < 0 || da > maxDesvioM) return null;
  // B: vértice más cercano pero SOLO hacia ADELANTE de A y dentro de una longitud PLAUSIBLE del tramo.
  // Esto evita el pase equivocado cuando la ruta se cruza consigo misma (que tomaría un lazo gigante).
  // El tramo de ruta entre A y B no debe exceder ~3× la recta del hueco (+1 km de holgura para huecos
  // cortos): la ruta planificada entre dos puntos consecutivos del bus nunca da una vuelta enorme.
  const dRecta = distM(A.lat, A.lng, B.lat, B.lng);
  const maxSegM = Math.max(dRecta * 3, dRecta + 1000);
  let ib = -1, db = Infinity;
  for (let i = ia; i < ruta.length; i++) {
    const along = cum[i] - cum[ia];
    if (along > maxSegM) break;                                   // pasado el rango plausible → parar
    const d = distM(B.lat, B.lng, ruta[i][1], ruta[i][0]);
    if (d < db) { db = d; ib = i; }
  }
  if (ib < 0 || db > maxDesvioM) return null;                     // B no cae cerca hacia adelante → fallback a Google
  const seg = ruta.slice(ia, ib + 1);
  if (seg.length < 2) return null;
  return [[A.lng, A.lat], ...seg, [B.lng, B.lat]];
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

// Ajusta la huella GPS a la red vial usando Mapbox Map Matching API — HÍBRIDO POR FRAGMENTO.
//
// Mapbox parte el trace en varias `matchings` cuando duda, y era común que m[0] fuera un stub
// basura (conf 0.00, el arranque parado) mientras el fragmento GRANDE tenía conf 0.87-0.98 (#948:
// f0=0.00/48pts + f1=0.87/52pts; #947 W3: 0.97 + basura + 0.98). Los enfoques todo-o-nada
// fallaban en ambos sentidos: exigir 1 matching (o gate por m[0]) tiraba media ventana BUENA a
// crudo-zigzag; concatenar todo dibujaba conectores rectos de 173-285 m cruzando manzanas (la
// "X" reportada en #947/#948).
//
// AQUÍ: `tracepoints` dice qué punto del sample pertenece a qué fragmento. Se recorren los puntos
// EN ORDEN: los tramos cuyos fragmentos son CONFIABLES (conf ≥ 0.4) emiten su geometría pegada a
// la vía; los tramos de fragmentos dudosos emiten el PUNTO GPS REAL (crudo). Así el hueco entre
// fragmentos buenos se rellena con los puntos reales del bus — NUNCA con un conector inventado.
// Cada coordenada del resultado es o geometría de vía de Mapbox o un fix real → no inventa rutas.
// `confidence` devuelta = FRACCIÓN de puntos cubiertos por fragmentos confiables (0..1); el gate
// de matchVentana (≥0.4 = al menos 40% pegado) decide si vale frente al crudo suavizado.
// El radio de búsqueda por punto se deriva de la precisión GPS (acc·1.5, acotado 5–50 m).
export async function mapMatchTrail(
  pts: MatchPt[],
  token: string
): Promise<{ coords: [number, number][]; confidence: number; crudeFrac: number; maxCrudoChordM: number; esCrudo: boolean[] } | null> {
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
    if (!Array.isArray(m) || m.length === 0) return null;

    const tp = json?.tracepoints;
    if (!Array.isArray(tp) || tp.length !== sample.length) {
      // Sin tracepoints utilizables → conservador: solo aceptar el caso simple de 1 matching.
      if (m.length !== 1) return null;
      const c: [number, number][] = m[0]?.geometry?.coordinates || [];
      const conf = Number(m[0]?.confidence) || 0;
      // 1 matching nativo = geometría de vía PURA (sin rama de fix crudo) → 0 sucio por construcción.
      return c.length >= 2 && conf > 0 ? { coords: c, confidence: conf, crudeFrac: 0, maxCrudoChordM: 0, esCrudo: c.map(() => false) } : null;
    }

    const CONF_FRAG = 0.4;
    const keep = m.map((x: any) => (Number(x?.confidence) || 0) >= CONF_FRAG);
    const emitidos = new Set<number>();   // cada fragmento se emite UNA vez (1ª aparición en orden)
    const via: [number, number][] = [];
    // esCrudo POR VÉRTICE (alineado 1:1 con via): true = fix crudo de RED (acc>ACC_CONFIABLE_M) → se
    // ruteará por la ruta prevista (nunca recta sobre casas); false = geometría de vía Mapbox O crudo de
    // CHIP (acc≤20, que hugea la pista → se dibuja medido, como el legacy). Base del "no dibujar rectas".
    const esCrudo: boolean[] = [];
    let cubiertos = 0;
    // Métricas de SUCIEDAD del match (para la stickiness monótona del ajustador). NO tocan la
    // geometría; solo cuantifican cuánto de la traza es fix crudo (recta) vs vía real:
    //  • crudeFrac      = fixes crudos emitidos / vértices totales (0 = vía pura como #1138).
    //  • maxCrudoChordM = la cuerda más larga con un extremo crudo (road↔crudo o crudo↔crudo) =
    //    la "recta que cruza techos" medida directamente. Las cuerdas road→road interiores de un
    //    fragmento NO cuentan (son cortas y siguen la vía).
    let crudos = 0;
    let lastPt: [number, number] | null = null;   // última coord emitida
    let lastCrude = false;                         // ¿la última coord emitida fue un fix crudo?
    let maxCC = 0;
    for (let k = 0; k < sample.length; k++) {
      const t: any = tp[k];
      const mi: number | null = t && t.matchings_index != null ? t.matchings_index : null;
      if (mi != null && keep[mi]) {
        cubiertos++;
        if (!emitidos.has(mi)) {
          emitidos.add(mi);
          const g = (m[mi]?.geometry?.coordinates as [number, number][]) || [];
          if (g.length) {
            // Junta con lo previo: solo la mido si el lado previo era crudo (road↔crudo).
            if (lastPt && lastCrude) maxCC = Math.max(maxCC, distM(lastPt[1], lastPt[0], g[0][1], g[0][0]));
            via.push(...g);
            for (let j = 0; j < g.length; j++) esCrudo.push(false);   // geometría de vía Mapbox
            lastPt = g[g.length - 1];
            lastCrude = false;
          }
        }
      } else if (mi != null) {
        const p: [number, number] = [sample[k].lng, sample[k].lat];   // fragmento dudoso → el fix REAL del bus
        if (lastPt) maxCC = Math.max(maxCC, distM(lastPt[1], lastPt[0], p[1], p[0]));
        via.push(p);
        esCrudo.push((sample[k].acc || 25) > ACC_CONFIABLE_M);   // crudo de RED → rutear; crudo de CHIP (≤20m) → medido
        crudos++;
        lastPt = p;
        lastCrude = true;
      }
      // mi == null: tidy lo descartó como outlier/redundante → omitir (rechazo de outliers gratis)
    }
    const confidence = cubiertos / sample.length;
    const crudeFrac = via.length ? crudos / via.length : 1;
    return via.length >= 2 ? { coords: via, confidence, crudeFrac, maxCrudoChordM: maxCC, esCrudo } : null;
  } catch { return null; }
}

// Ajusta UNA ventana (≤100 puntos densos) a la vía. `confidence` = fracción de la ventana pegada
// a fragmentos confiables; si ni el 40% se pudo pegar (GPS pobre / parado en red), cae a la huella
// cruda suavizada por DISTANCIA: aplana el zigzag lento sin recortar las curvas rápidas.
// `snapped` = si logró pegar a la vía (confianza ≥ 0.4) o cayó al crudo → el ajustador lo usa para
// NO revertir a zigzag un tramo ya pegado (stickiness: con GPS de red la confianza baila y sin esto
// la cola parpadea entre pegada y cruda cada ciclo).
export async function matchVentana(ventana: MatchPt[], token: string): Promise<{ coords: [number, number][]; snapped: boolean; crudeFrac: number; maxCrudoChordM: number; esCrudo: boolean[] }> {
  const r = await mapMatchTrail(ventana, token);
  if (r && r.confidence >= 0.4 && r.coords.length >= 2) return { coords: r.coords, snapped: true, crudeFrac: r.crudeFrac, maxCrudoChordM: r.maxCrudoChordM, esCrudo: r.esCrudo };
  const suav = suavizarPorDistancia(ventana);   // fallback: crudo suavizado por distancia (no pegó a vía)
  const coords = suav.length >= 2 ? suav.map(p => [p.lng, p.lat] as [number, number]) : [];
  // Por vértice: crudo de RED (acc>20) se ruteará; un fallback de CHIP (acc≤20) queda medido → protege el oro.
  return { coords, snapped: false, crudeFrac: 1, maxCrudoChordM: 0, esCrudo: coords.map((_, i) => (suav[i]?.acc || 25) > ACC_CONFIABLE_M) };
}

// Tramo máximo que se DIBUJA entre dos vértices consecutivos. Más largo que esto = teleport
// por pérdida de señal o fix basura → se deja un HUECO honesto en vez de una recta cruzando el
// mapa. Holgado (300 m) para no cortar avance real: la huella buena densa nunca lo alcanza
// (#1138, chip GPS a 4 s: máx ~138 m), solo lo superan los saltos imposibles del GPS pobre.
export const MAX_SEG_M = 300;

// ⚠️ SIN USO (revertido): el puente con línea recta INVENTABA recorridos por donde el bus no fue
// (GPS pobre de terceros — la recta cruzaba calles que la unidad no tomó). El "se corta" honesto
// (hueco) resultó preferible a una ruta inventada. Se conserva para una posible v2 más conservadora.
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
  huella: { lat: number; lng: number; velocidad: number }[],
  suprimir?: Array<[number, number]>,   // rangos de índice [s,e] a NO dibujar (crudo que se rellena por ruta estimada)
): any[] {
  const velCercana = (lng: number, lat: number): number => {
    let best = 0, bd = Infinity;
    for (const h of huella) {
      const d = (h.lng - lng) ** 2 + (h.lat - lat) ** 2;
      if (d < bd) { bd = d; best = h.velocidad ?? 0; }
    }
    return best;
  };
  const supr = (j: number) => !!suprimir && suprimir.some(([s, e]) => j >= s && j <= e);
  const feats: any[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    if (supr(i) || supr(i + 1)) continue;   // tramo crudo: lo cubre la ruta estimada (petróleo), no se dibuja como medido
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
  ruta?: [number, number][],        // ruta planificada (para pegar la punta viva a la vía cuando el GPS está degradado)
  degradado?: boolean,              // el Map Matching NO logró pegar la cola (GPS de red/corte) → seguir la ruta, no el zigzag
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
  // PUNTA VIVA DEGRADADA: si el Map Matching no logró pegar la cola (corte / GPS de red), en vez de
  // dibujar el zigzag crudo hasta el bus se SIGUE LA RUTA PREVISTA desde la frontera del trazo hasta la
  // posición en vivo (verde petróleo, `estimado:1`). Es determinista → sin parpadeo, y así la huella no
  // se rompe ni se corta. Si el bus se desvió de la ruta (o no hay ruta), cae al crudo → nunca inventa
  // camino fuera de la vía (puentePorRuta devuelve null con desvío >200 m).
  if (degradado && ruta && ruta.length >= 2 && live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    const bridge = puentePorRuta({ lat: endLat, lng: endLng }, { lat: live.lat, lng: live.lng }, ruta);
    if (bridge && bridge.length >= 2) {
      return [{ type: "Feature", properties: { estimado: 1 }, geometry: { type: "LineString", coordinates: bridge } }];
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

// Busca el PREFIJO LIMPIO más largo de una ventana que salió cruda al matchear completa. Clave del
// fix "no re-editar lo ya dibujado" (#795): una ventana [0,100] puede salir CRUDA porque su cola trae
// puntos degradados, aunque su prefijo [0,60] pegue LIMPIO por sí solo. Congelar la ventana completa
// re-dibujaría crudos esos 60 puntos viejos-buenos. En vez de eso se congela solo el prefijo limpio.
// Búsqueda binaria (monótona en la práctica: agregar cola degradada solo puede ensuciar) → ~6-7 llamadas
// solo cuando una ventana sale cruda (GPS bueno nunca entra aquí). Piso 40: un prefijo más corto no vale
// la fragmentación (la corrupción de <40 puntos es menor y rara). Exige crudeFrac≤0.1 (limpio de verdad).
async function congelarPrefijoLimpio(
  ventana: MatchPt[], token: string, cancelado?: () => boolean,
): Promise<{ len: number; coords: [number, number][]; esCrudo: boolean[] } | null> {
  const MIN = 40;
  let lo = MIN, hi = ventana.length - 2, bestLen = 0, bestCoords: [number, number][] | null = null, bestEsCrudo: boolean[] | null = null;
  while (lo <= hi) {
    if (cancelado?.()) break;
    const mid = (lo + hi) >> 1;
    const r = await matchVentana(ventana.slice(0, mid), token);
    if (r.snapped && r.crudeFrac <= 0.1) { bestLen = mid; bestCoords = r.coords; bestEsCrudo = r.esCrudo; lo = mid + 1; }
    else hi = mid - 1;
  }
  return bestLen >= MIN && bestCoords ? { len: bestLen, coords: bestCoords, esCrudo: bestEsCrudo || [] } : null;
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
  // Umbrales ABSOLUTOS del gate de contenido-crudo (stickiness monótona). Una cola nueva solo puede
  // desplazar a "conservar la limpia" si supera este piso de suciedad. Para GPS bueno (#1138) el match
  // no tiene fixes crudos → crudeFrac=0 y maxCrudoChordM=0 → nunca "sucio" → el gate colapsa EXACTO al
  // legacy (sobrescribe siempre) → huella byte-idéntica. Calibrables (ver medición #954/#946/#1138).
  const CRUDE_SUCIO = 0.30;   // fracción de fixes crudos que marca la cola como "sucia" (rectas)
  const EMPALME_MAX = 120;    // m: cuerda con extremo crudo más larga tolerada antes de marcar "sucia"
  const congeladas: [number, number][][] = [];
  let congeladoHasta = 0;
  let lastMatchMs = 0;
  let lastTail: { lat: number; lng: number } | null = null;
  let lastCola: [number, number][] = [];   // stickiness: última geometría de la COLA (para no revertir a crudo lo ya pegado)
  let lastColaSnapped = false;              // ¿la última cola conservada estaba pegada a la vía?
  let lastColaCrude = 1;                    // crudeFrac de la geometría RETENIDA (1 = nada limpio aún)
  const congeladasSnapped: boolean[] = [];  // (histórico; los rangos ahora se derivan de esCrudo POR VÉRTICE)
  const congeladasEsCrudo: boolean[][] = []; // esCrudo por vértice de cada ventana congelada (LOCKSTEP con congeladas)
  let lastColaEsCrudo: boolean[] = [];       // esCrudo por vértice de la cola retenida (LOCKSTEP con lastCola)
  let ultimoCrudoRanges: Array<[number, number]> = [];  // rangos [ini,fin] de crudo POR VÉRTICE (incl. mixtas) a rellenar por ruta; excluye la punta viva
  let ultimoColaClean = 0;                  // último índice de VÍA limpia en las coords devueltas (frontera de colaViva)
  let ultimaColaSnapped = true;             // ¿el ÚLTIMO match de la cola viva pegó a la vía? (false = punta degradada)

  return {
    async ajustar(
      limpio: MatchPt[],
      token: string,
      cancelado?: () => boolean
    ): Promise<[number, number][] | null> {
      if (!token || limpio.length < 2) return null;
      const cola = limpio[limpio.length - 1];
      // Cadencia ADAPTATIVA de Map Matching. El throttle fijo de 60 s hacía que la cola reciente se
      // dibujara CRUDA (zigzag off-road de fixes de red) hasta ~1 min, "arreglándose sola" al
      // siguiente ajuste. Ahora: si la precisión reciente es DEGRADADA (la que zigzaguea) se re-ajusta
      // casi cada fetch (12 s) → pegado a la vía casi al instante; con GPS bueno el crudo ya va sobre
      // la pista y basta 60 s (no dispara llamadas a Mapbox en el caso común).
      const rec = limpio.slice(-12);
      const accsR = rec.map((p) => p.acc).sort((a, b) => a - b);
      const accMedR = accsR.length ? accsR[Math.floor(accsR.length / 2)] : 25;
      const throttleMs = accMedR > ACC_DEGRADADO_M ? 12000 : 60000;
      if (Date.now() - lastMatchMs < throttleMs) return null;
      // "Se movió" con umbral CONSCIENTE de la precisión: un bus PARADO con GPS de red jitterea
      // decenas de metros; con umbral fijo de 8 m eso contaría como movimiento y gastaría un match
      // ocioso cada 12 s. En degradado el umbral sube a la precisión mediana → el jitter no cuenta,
      // solo el avance REAL (a 46 km/h son ~150 m/ciclo, muy por encima).
      const umbralMov = Math.max(8, accMedR);
      const seMovio = !lastTail || distM(lastTail.lat, lastTail.lng, cola.lat, cola.lng) >= umbralMov;
      if (!seMovio && congeladas.length) return null;
      lastMatchMs = Date.now();
      lastTail = { lat: cola.lat, lng: cola.lng };

      // NUEVOS + 2 de margen (review): quitarPicosV puede re-juzgar los últimos ~2 puntos de la
      // cola en el ciclo siguiente (el último no tiene `next` aún). Sin margen, si el resto cae
      // exacto en 99 la ventana congelada incluiría un punto aún mutable → al eliminarse después,
      // los índices del prefijo se correrían y el pico quedaría horneado en la geometría congelada.
      const congeladoAntes = congeladoHasta;
      while (limpio.length - congeladoHasta >= NUEVOS + 2) {
        const ini = Math.max(0, congeladoHasta - SOLAPE);
        const ventana = limpio.slice(ini, ini + MAX);   // ≤ MAX SIEMPRE → no se diezma
        const rw = await matchVentana(ventana, token);
        if (cancelado?.()) return null;
        if (rw.snapped) {
          // Ventana LIMPIA → congelar completa (caso común; GPS bueno #1138 IDÉNTICO al legacy).
          congeladas.push(rw.coords);
          congeladasSnapped.push(true);
          congeladasEsCrudo.push(rw.esCrudo);
          congeladoHasta += NUEVOS;
        } else {
          // Ventana CRUDA: el re-match completo ARRUINA los puntos viejos-buenos que trae la ventana (bug
          // #795: [0,60] pega limpio solo, pero [0,100] con la cola degradada sale crudo y RE-DIBUJA crudos
          // esos 60 buenos = "edita 20 puntos antes"). En vez de hornear crudo sobre lo bueno, se congela
          // SOLO el PREFIJO LIMPIO más largo (INMUTABLE); el resto degradado queda para el siguiente ciclo
          // (lo cubre puentesCrudos por la ruta). Así lo ya dibujado NO se re-edita.
          const pref = await congelarPrefijoLimpio(ventana, token, cancelado);
          if (cancelado?.()) return null;
          if (pref) {
            congeladas.push(pref.coords);
            congeladasSnapped.push(true);
            congeladasEsCrudo.push(pref.esCrudo);
            congeladoHasta += Math.max(1, pref.len - SOLAPE);
          } else {
            // Ni el prefijo pega (degradación temprana) → congelar crudo y avanzar normal (genuino).
            congeladas.push(rw.coords);
            congeladasSnapped.push(false);
            congeladasEsCrudo.push(rw.esCrudo);
            congeladoHasta += NUEVOS;
          }
        }
      }
      // Si congeló una ventana, la cola arranca de nuevo (otra región) → resetear la stickiness.
      if (congeladoHasta !== congeladoAntes) { lastCola = []; lastColaSnapped = false; lastColaCrude = 1; lastColaEsCrudo = []; }

      const colaVentana = limpio.slice(Math.max(0, congeladoHasta - SOLAPE));
      if (colaVentana.length >= 2) {
        const rc = await matchVentana(colaVentana, token);
        if (cancelado?.()) return null;
        ultimaColaSnapped = rc.snapped;   // señal para colaViva: si NO pegó, la punta viva sigue la ruta prevista
        // STICKINESS POR CONTENIDO-CRUDO: no revertir a rectas/crudo un tramo que ya se pegó a la vía.
        // El bug (#954): con GPS de red la cola puede PEGAR (snapped=true) pero MIXTA — trozos de vía
        // unidos por cuerdas crudas de 120-300 m (las "rectas que cruzan techos"), cobertura ~0.45. El
        // booleano `snapped` no la distinguía de una cola limpia (0.9) → la aceptaba y SOBRESCRIBÍA lo
        // ya bueno. Ahora se mide la SUCIEDAD del match (crudeFrac / cuerda cruda más larga) y solo se
        // sobrescribe con algo igual-o-más-limpio; si el match nuevo es MÁS sucio que lo retenido, se
        // CONSERVA la cola limpia y la punta la extiende colaViva con fixes reales. Dirección monótona:
        // lo pegado no se afea, solo se refina. (FASE 8 anti-parpadeo sigue viva vía `snapped`.)
        // Para #1138 (GPS bueno) crudeFrac/maxCrudoChordM son 0 → nuevoSucio nunca → idéntico al legacy.
        const nuevoSucio = rc.crudeFrac > CRUDE_SUCIO || rc.maxCrudoChordM > EMPALME_MAX;
        if (rc.snapped) {
          if (!(nuevoSucio && lastColaSnapped && rc.crudeFrac > lastColaCrude)) {
            lastCola = rc.coords; lastColaSnapped = true; lastColaCrude = rc.crudeFrac; lastColaEsCrudo = rc.esCrudo;
          }
        } else if (!lastColaSnapped) {
          lastCola = rc.coords; lastColaSnapped = false; lastColaCrude = 1; lastColaEsCrudo = rc.esCrudo;
        }
      }

      const todo = [...congeladas, lastCola].flat() as [number, number][];
      const esCrudoTodo = [...congeladasEsCrudo, lastColaEsCrudo].flat();   // alineado 1:1 con `todo`

      // Rangos de crudo POR VÉRTICE (esto SÍ incluye las ventanas MIXTAS: snapped=true con fixes crudos
      // de RED intercalados — el bug #875 de rectas naranjas sobre casas). Corridas contiguas de
      // esCrudoTodo=true sobre `todo`, fusionando las separadas por ≤1 vértice limpio (evita confeti).
      // Se EXCLUYE la corrida que toca el ÚLTIMO índice (punta viva → la cubre colaViva, no parpadea).
      const rangos: Array<[number, number]> = [];
      const n = Math.min(todo.length, esCrudoTodo.length);
      let idx = 0;
      while (idx < n) {
        if (esCrudoTodo[idx]) {
          let j = idx;
          while (j + 1 < n && (esCrudoTodo[j + 1] || (j + 2 < n && esCrudoTodo[j + 2]))) j++;   // fusiona ≤1 limpio
          rangos.push([idx, j]);
          idx = j + 1;
        } else idx++;
      }
      ultimoCrudoRanges = rangos.filter(([, e]) => e < n - 1);   // fuera la corrida de la punta viva (colaViva la cubre)

      // Frontera de la cola VIVA = último vértice de VÍA limpia. colaViva ancla ahí y el consumidor
      // NO dibuja el crudo de la punta como medido (lo rellena por la ruta). GPS bueno → n-1 → sin cambios.
      ultimoColaClean = n - 1;
      for (let k = n - 1; k >= 0; k--) { if (!esCrudoTodo[k]) { ultimoColaClean = k; break; } }

      return todo.length >= 2 ? todo : null;
    },
    // Rangos [ini,fin] de crudo POR VÉRTICE en las coords del último `ajustar` (para rutear como estimado).
    leerCrudoRanges: () => ultimoCrudoRanges,
    // ¿El último match de la cola VIVA pegó a la vía? (false = punta degradada → colaViva sigue la ruta).
    leerColaSnapped: () => ultimaColaSnapped,
    // Último índice de VÍA limpia en las coords devueltas (frontera de colaViva; corta el crudo de la punta).
    leerColaClean: () => ultimoColaClean,
  };
}
