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

// Trae TODAS las filas de una consulta paginando con .range() en ventanas de 1000.
// PostgREST recorta CUALQUIER respuesta al tope max-rows del servidor (Supabase: 1000):
// .limit(5000) NO lo salta — la huella quedaba CONGELADA en el punto 1000 (~1h20 de viaje,
// verificado con la reserva #801: 1245 filas en BD, 1000 devueltas) mientras el bus seguía
// en vivo, y todo lo posterior se pintaba como "tramo estimado". Mismo tope que ya truncó
// reservas en /programacion. `armarQuery` debe devolver una consulta NUEVA en cada llamada,
// con orden ESTABLE (created_at + id) para que las páginas no se solapen ni salten filas.
export async function paginarFilas(
  armarQuery: () => { range: (desde: number, hasta: number) => PromiseLike<{ data: any[] | null; error: any }> },
  // Techo de sanidad, NO un límite operativo: 35 000 ≈ 29 h continuas a 3 s/fix (la cadencia
  // más densa). Los full day tours de 24 h generan ~25-29 k puntos en el peor caso (carretera
  // + paradas largas pegadas a un paradero, que también envían a 3 s) → entran completos.
  maxFilas = 35000,
): Promise<any[]> {
  const PAG = 1000; // = max-rows de Supabase: cada página llega completa
  const todas: any[] = [];
  for (let desde = 0; desde < maxFilas; desde += PAG) {
    const { data, error } = await armarQuery().range(desde, desde + PAG - 1);
    if (error) break;                      // conservar lo acumulado: huella parcial > vacía
    todas.push(...(data || []));
    if (!data || data.length < PAG) break; // página corta = no hay más filas
  }
  return todas;
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
// consumidor los pasa a puentePorRuta (candado de desvío 70 m + rodeo>8× vía decidirPuente). Se rutea
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

// Velocidad MEDIA sostenida creíble para un bus urbano sobre la longitud RUTEADA de un tramo estimado
// (es un promedio multi-minuto: incluye semáforos, giros, tráfico), por eso está MUY por debajo del pico
// instantáneo VMAX_BUS_KMH (130, que detecta teleport en recta). Un estimado cuya longitud/dt supere esto
// describe un rodeo que el bus no pudo recorrer en el tiempo del hueco. 85 deja pasar vías expresas de Lima.
const V_RUTA_MAX_KMH = 85;

// COHERENCIA del tramo estimado con la EVIDENCIA GPS real (regla del usuario, jul-2026: el estimado NUNCA
// debe contradecir por dónde estuvo el bus). El bug: puentePorRuta seguía el ITINERARIO planificado sin mirar
// los fixes → cuando el plan da un lazo pero el bus fue directo, dibujaba el lazo (7.8 km) por donde el bus
// NO pasó, y como se aceptaba PRIMERO nunca caía al fallback. Esta función valida CUALQUIER geometría
// candidata (ruta prevista O Google) antes de dibujarla y la RECHAZA si es incoherente. Tres candados, de más
// robusto a más fino:
//   1. RODEO ABSURDO vs recta: geoM/dRecta > rodeoMax(8) → un extremo quedó al otro lado de un río (misma red
//      exterior de decidirPuente, ahora aplicada TAMBIÉN a puentePorRuta, que no tenía ninguna).
//   2. VELOCIDAD sobre la longitud ruteada (solo con dt fiable > 0): geoM/dt > V_RUTA_MAX → el bus no pudo
//      recorrer esa longitud en el tiempo del hueco (mata el lazo aun sin buenos fixes). Sin dt se omite.
//   3. LONGITUD vs CAMINO REAL (con ≥2 fixes del intervalo): realPath = largo(A→fixes→B) = lo que el bus
//      recorrió de verdad; si geoM > max(absM, factor·realPath) el candidato es mucho más largo que la
//      evidencia = lazo/rodeo inventado → rechazar. Robusto al jitter porque promedia sobre el recorrido
//      (no mide fix-a-fix). Sin fixes (hueco de señal puro) se omite → ahí mandan los candados 1 y 2.
// Pura y determinista sobre inputs de un tramo YA consolidado (los candidatos excluyen la punta viva) → mismo
// trazo, mismo veredicto en cada re-fetch (sin parpadeo). Para flota con chip no hay corridas crudas y los
// huecos reales no traen fixes → solo aplica el candado 1 (como hoy) → dibujo idéntico. `geo` en [lng,lat].
export function validarPuente(
  geo: [number, number][],
  A: { lat: number; lng: number }, B: { lat: number; lng: number },
  fixes: { lat: number; lng: number }[],
  dt: number, dRecta: number,
  opts?: { rodeoMax?: number; vRutaMaxKmh?: number; factor?: number; absM?: number; minFixes?: number },
): boolean {
  if (!geo || geo.length < 2) return false;
  const rodeoMax = opts?.rodeoMax ?? 8;
  const vRutaMax = (opts?.vRutaMaxKmh ?? V_RUTA_MAX_KMH) / 3.6;   // m/s
  const factor   = opts?.factor ?? 2.0;
  const absM     = opts?.absM ?? 300;                             // huecos cortos: no castigar la curvatura de la vía
  const minFixes = opts?.minFixes ?? 2;
  let geoM = 0;
  for (let i = 1; i < geo.length; i++) geoM += distM(geo[i - 1][1], geo[i - 1][0], geo[i][1], geo[i][0]);
  if (geoM <= 0) return false;
  if (dRecta > 0 && geoM / dRecta > rodeoMax) return false;       // 1. rodeo absurdo vs recta
  if (dt > 0 && geoM / dt > vRutaMax) return false;               // 2. velocidad sobre la longitud ruteada
  if (fixes && fixes.length >= minFixes) {                        // 3. longitud vs camino real de los fixes
    let realPath = distM(A.lat, A.lng, fixes[0].lat, fixes[0].lng);
    for (let i = 1; i < fixes.length; i++) realPath += distM(fixes[i - 1].lat, fixes[i - 1].lng, fixes[i].lat, fixes[i].lng);
    realPath += distM(fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lng, B.lat, B.lng);
    if (geoM > Math.max(absM, factor * realPath)) return false;
  }
  return true;
}

// Conector recto máximo que se permite dibujar entre un fix crudo (A/B) y la geometría de VÍA del
// tramo estimado. Un fix impreciso de red puede caer a 50-190 m de la vía; unirlo con una recta a la
// calzada era EXACTAMENTE lo que hacía que el verde petróleo "cruzara casas/ríos" (reclamo del usuario,
// jul-2026: la huella estimada saltaba por techos). Regla: el tramo estimado va SIEMPRE por la vía; el
// único trazo recto tolerado es un empalme ≤ este valor (≈ ancho de calle) para cerrar la costura sin
// hueco visible. Si el fix está más lejos, NO se dibuja recta — el estimado arranca sobre la vía y la
// unión con lo medido queda con un micro-hueco honesto (preferible a una recta sobre manzanas).
const CONECTOR_MAX_M = 25;

// Rellena un hueco (A→B) SIGUIENDO LA RUTA PLANIFICADA en vez de una ruta fresca de Google (decisión del
// usuario, jul-2026): el tramo estimado queda EXACTAMENTE sobre la vía prevista (misma pista, nunca cruza
// el río, sin rodeos raros), reutilizando la ruta que ya tenemos. Devuelve geometría 100% DE VÍA:
//   • Proyecta A y B PERPENDICULARMENTE sobre los segmentos de la ruta (no al vértice más cercano) → el
//     "pie" cae SOBRE la calzada, no en el vértice más próximo que puede quedar cruzando en diagonal.
//   • El tramo devuelto va del pie de A al pie de B por la ruta: pieA → vértices intermedios → pieB.
//   • Los extremos crudos A/B se PREPENDEN/APPENDEN solo si su desvío perpendicular es ≤ CONECTOR_MAX_M
//     (empalme corto para la costura). Si A/B están más lejos, NO se añade la recta cruda → el estimado
//     arranca sobre la vía (la recta A→vía de hasta 190 m que cruzaba casas YA NO se dibuja).
// Devuelve null si no hay ruta o si A/B caen a más de maxDesvioM de ella (el bus se DESVIÓ de lo
// planificado → el consumidor cae al puente por Google, que rutea el A→B REAL). `ruta` en [lng, lat].
export function puentePorRuta(
  A: { lat: number; lng: number }, B: { lat: number; lng: number },
  ruta: [number, number][], maxDesvioM = 70,   // 70 m: bus dentro de ~2·error-GPS de la ruta = va por ella; más lejos → Google
): [number, number][] | null {
  if (!ruta || ruta.length < 2) return null;
  // Distancia acumulada a lo largo de la ruta (para medir "hacia adelante" y acotar el tramo).
  const cum = [0];
  for (let i = 1; i < ruta.length; i++) cum[i] = cum[i - 1] + distM(ruta[i - 1][1], ruta[i - 1][0], ruta[i][1], ruta[i][0]);
  // Proyecta un punto sobre TODOS los segmentos de la ruta (desde `desde`, sin pasar `maxAlong`):
  // devuelve el pie SOBRE la calzada, el índice de segmento, el avance acumulado y el desvío perpendicular.
  const proyectar = (p: { lat: number; lng: number }, desde = 0, maxAlong = Infinity) => {
    let best: { foot: { lat: number; lng: number }; seg: number; along: number; perp: number } | null = null;
    for (let i = desde; i < ruta.length - 1; i++) {
      const Aa = { lat: ruta[i][1], lng: ruta[i][0] }, Bb = { lat: ruta[i + 1][1], lng: ruta[i + 1][0] };
      const q = proyectarEnSegmento(p.lat, p.lng, Aa, Bb);
      const along = cum[i] + distM(Aa.lat, Aa.lng, q.lat, q.lng);
      if (along > maxAlong) break;
      if (!best || q.dist < best.perp) best = { foot: { lat: q.lat, lng: q.lng }, seg: i, along, perp: q.dist };
    }
    return best;
  };
  const pa = proyectar(A);
  if (!pa || pa.perp > maxDesvioM) return null;
  // B: proyectar SOLO hacia ADELANTE del pie de A (evita el pase de VUELTA en rutas ida-y-vuelta que
  // tomaría un lazo gigante) y dentro de una longitud PLAUSIBLE (~3× la recta del hueco + 1 km).
  const dRecta = distM(A.lat, A.lng, B.lat, B.lng);
  const pb = proyectar(B, pa.seg, pa.along + Math.max(dRecta * 3, dRecta + 1000));
  if (!pb || pb.perp > maxDesvioM || pb.along < pa.along) return null;   // B no cae adelante/cerca → Google
  // Sub-tramo de VÍA: pie de A → vértices intermedios de la ruta → pie de B (todo sobre la calzada).
  const mid = ruta.slice(pa.seg + 1, pb.seg + 1);
  const via: [number, number][] = [[pa.foot.lng, pa.foot.lat], ...mid, [pb.foot.lng, pb.foot.lat]];
  // Empalme corto a los extremos crudos SOLO si están pegados a la vía (≤ CONECTOR_MAX_M); si no, se omite
  // la recta (el estimado arranca/termina sobre la vía). Este es el candado del "nunca cruzar casas".
  const conA = pa.perp <= CONECTOR_MAX_M ? [[A.lng, A.lat] as [number, number]] : [];
  const conB = pb.perp <= CONECTOR_MAX_M ? [[B.lng, B.lat] as [number, number]] : [];
  const seg = [...conA, ...via, ...conB];
  // Dedup de vértices consecutivos idénticos (pie que coincide con un vértice / empalme nulo).
  const out: [number, number][] = [];
  for (const c of seg) { const l = out[out.length - 1]; if (!l || l[0] !== c[0] || l[1] !== c[1]) out.push(c); }
  return out.length >= 2 ? out : null;
}

// ── ÍCONO DEL BUS PEGADO A LA VÍA ────────────────────────────────────────────
// El marcador en vivo se dibujaba en el fix CRUDO: con GPS de red (±35-100 m) el bus "caminaba"
// sobre techos y saltaba entre pistas sin conexión (regla del usuario: el ícono SIEMPRE sobre
// una vía). Aquí la posición se PROYECTA sobre la geometría de vía disponible, con dos candados
// de honestidad:
//   1. La corrección NUNCA excede la imprecisión del propio fix (tol = 1.5·acc, acotada
//      35–100 m): no se fabrica posición — solo se elige el punto de vía más plausible DENTRO
//      del círculo de error del GPS. Un bus legítimamente fuera de pista (cochera, patio de
//      maniobras, con chip preciso) se queda en su posición cruda.
//   2. CONTINUIDAD: se prefiere el candidato a ≤80 m del snap anterior y, sobre la ruta, la
//      ventana de progreso hacia adelante — el ícono no brinca entre vías paralelas ni se pega
//      al pase opuesto de una ruta ida-vuelta.
// Candidatos (un solo ranking por distancia): RUTA PLANIFICADA (con progreso), TRAZO MATCHEADO
// (solo vértices de vía; se rechaza el clamp exacto en la PUNTA para no congelar el ícono cuando
// el bus avanza más allá de lo matcheado) y PUNTOS DE VÍA de Tilequery (`puntosVia` — el punto
// más cercano de cada calle del entorno; fallback cuando el bus va lejos de la ruta y el matching
// no pegó, ver viasCercanasTilequery). Pura: el consumidor guarda prev/prevS entre ciclos.
// Polilíneas en [lng, lat] (convención Mapbox).
export type SnapIcono = { lat: number; lng: number; snapped: boolean; s: number | null; dist: number };
export function pegarIconoAVia(
  lat: number, lng: number, acc: number,
  opts: {
    ruta?: [number, number][];          // ruta planificada
    trail?: [number, number][];         // geometría ajustada a la vía (Map Matching)
    trailEsCrudo?: boolean[];           // por vértice del trail (leerEsCrudo) — los crudos NO son vía
    puntosVia?: { lat: number; lng: number }[];   // puntos de calle cercanos (Tilequery)
    prev?: { lat: number; lng: number } | null;   // snap anterior (continuidad)
    prevS?: number | null;              // progreso anterior sobre la ruta (metros acumulados)
  } = {},
): SnapIcono {
  // Tolerancia por FIABILIDAD: con chip (acc ≤ 20) el fix ya es la verdad — solo se admite el
  // retoque fino a la vía (≤1.5·acc, piso 12 m); un chip a 25-30 m de la calle es un bus REALMENTE
  // fuera de pista (cochera/patio) y se queda crudo. Con red (acc > 20 o desconocida) el círculo
  // de error es grande y se admite hasta 1.5·acc (35–100 m).
  const a = acc > 0 ? acc : 25;
  const tol = a <= ACC_CONFIABLE_M ? Math.max(12, a * 1.5) : Math.min(100, Math.max(35, a * 1.5));
  type Cand = { lat: number; lng: number; dist: number; s: number | null };
  const cands: Cand[] = [];

  const ruta = opts.ruta;
  if (ruta && ruta.length >= 2) {
    const cum = [0];
    for (let i = 1; i < ruta.length; i++) cum[i] = cum[i - 1] + distM(ruta[i - 1][1], ruta[i - 1][0], ruta[i][1], ruta[i][0]);
    let bestVent: Cand | null = null, bestGlob: Cand | null = null;
    for (let i = 0; i < ruta.length - 1; i++) {
      const A = { lat: ruta[i][1], lng: ruta[i][0] }, B = { lat: ruta[i + 1][1], lng: ruta[i + 1][0] };
      const q = proyectarEnSegmento(lat, lng, A, B);
      const s = cum[i] + distM(A.lat, A.lng, q.lat, q.lng);
      const c: Cand = { lat: q.lat, lng: q.lng, dist: q.dist, s };
      if (!bestGlob || c.dist < bestGlob.dist) bestGlob = c;
      if (opts.prevS != null && s >= opts.prevS - 300 && s <= opts.prevS + 2500 && (!bestVent || c.dist < bestVent.dist)) bestVent = c;
    }
    // La ventana de progreso manda (evita el pase opuesto de la ida-vuelta); si el bus ya no
    // está cerca de ese tramo (desvío / re-arranque) cae al mejor global.
    const el = bestVent && bestVent.dist <= tol ? bestVent : bestGlob;
    if (el && el.dist <= tol) cands.push(el);
  }

  const trail = opts.trail;
  if (trail && trail.length >= 2) {
    const desde = Math.max(0, trail.length - 40);   // solo la región de la punta (donde está el bus)
    // Último vértice DE VÍA de la región (con cola cruda, el "fin de lo matcheado" no es el último
    // vértice del array): un candidato que clampea EXACTO ahí significa que el bus avanzó más allá
    // de lo matcheado → se rechaza para no congelar el ícono en esa esquina (ruta/Tilequery cubren).
    let ultimoVia = -1;
    for (let i = trail.length - 1; i >= desde; i--) { if (!opts.trailEsCrudo || !opts.trailEsCrudo[i]) { ultimoVia = i; break; } }
    let best: Cand | null = null;
    for (let i = desde; i < trail.length - 1; i++) {
      if (opts.trailEsCrudo && (opts.trailEsCrudo[i] || opts.trailEsCrudo[i + 1])) continue;   // crudo ≠ vía
      const A = { lat: trail[i][1], lng: trail[i][0] }, B = { lat: trail[i + 1][1], lng: trail[i + 1][0] };
      const q = proyectarEnSegmento(lat, lng, A, B);
      if (ultimoVia >= 0 && distM(q.lat, q.lng, trail[ultimoVia][1], trail[ultimoVia][0]) < 2) continue;   // clamp en la punta de vía → fuera
      if (q.dist <= tol && (!best || q.dist < best.dist)) best = { lat: q.lat, lng: q.lng, dist: q.dist, s: null };
    }
    if (best) cands.push(best);
  }

  for (const p of opts.puntosVia || []) {
    const d = distM(lat, lng, p.lat, p.lng);
    if (d <= tol) cands.push({ lat: p.lat, lng: p.lng, dist: d, s: null });
  }

  if (!cands.length) return { lat, lng, snapped: false, s: opts.prevS ?? null, dist: 0 };
  // Continuidad ACOTADA: con snap previo se prefiere el candidato que NO brinca (≤80 m del
  // anterior), pero SOLO si no es claramente peor que el mejor global (≤25 m de diferencia).
  // Sin ese tope, un snap que cayó una vez en la vía paralela equivocada se quedaba "pegado" a
  // ella ciclo tras ciclo aunque la calle correcta estuviera mucho más cerca del fix.
  let glob = cands[0];
  for (const c of cands) if (c.dist < glob.dist) glob = c;
  let win = glob;
  if (opts.prev) {
    const cerca = cands.filter((c) => distM(c.lat, c.lng, opts.prev!.lat, opts.prev!.lng) <= 80);
    if (cerca.length) {
      let nb = cerca[0];
      for (const c of cerca) if (c.dist < nb.dist) nb = c;
      if (nb.dist <= glob.dist + 25) win = nb;
    }
  }
  return { lat: win.lat, lng: win.lng, snapped: true, s: win.s ?? opts.prevS ?? null, dist: win.dist };
}

// ── CAMINO DE VÍA ENTRE DOS SNAPS DEL ÍCONO (tween por la pista) ─────────────
// El marcador se ANIMA entre fix y fix, y una recta entre dos snaps corta la esquina y cruza la
// manzana aunque AMBOS extremos estén sobre la pista (cadencia 3-15 s = 30-200 m por tween: en
// cualquier giro el bus se veía "volar" en diagonal sobre las casas — reclamo del usuario,
// ago-2026: el ícono debe seguir la vía igual que la huella). Devuelve la polilínea DE VÍA entre
// el snap anterior (A) y el nuevo (B) para deslizar el bus por la calle, reutilizando
// puentePorRuta (proyección perpendicular sobre la ruta prevista + candado de avance hacia
// adelante). Candados de honestidad (nunca fabricar recorrido):
//   • Solo si ambos snaps están pegados a la ruta (desvío perpendicular ≤ CONECTOR_MAX_M = 25 m,
//     el MISMO umbral con el que puentePorRuta empalma los extremos reales: así el camino
//     SIEMPRE arranca y termina EXACTO en los snaps. Con 40 m —el primer intento— el camino
//     terminaba en el pie sobre la ruta, hasta 40 m lejos del bus: ícono despegado de la cola
//     viva, o deslizándose por la calzada central cuando el bus va por la auxiliar. Review
//     ago-2026). El cinturón de abajo lo garantiza aunque cambien los umbrales internos.
//   • El camino no puede ser un rodeo: largo ≤ max(2.5·recta, recta+150 m). Si la proyección
//     tomó un lazo o el pase opuesto de una ida-vuelta, se descarta.
// null = sin camino fiable → el consumidor conserva el tween recto de siempre (jamás peor que
// el comportamiento actual). Pura; `ruta` en [lng, lat].
export function caminoEntreSnaps(
  A: { lat: number; lng: number }, B: { lat: number; lng: number },
  ruta?: [number, number][],
): [number, number][] | null {
  if (!ruta || ruta.length < 2) return null;
  const dRecta = distM(A.lat, A.lng, B.lat, B.lng);
  if (!(dRecta > 0)) return null;
  const cam = puentePorRuta(A, B, ruta, CONECTOR_MAX_M);
  if (!cam || cam.length < 2) return null;
  // Cinturón: el tween DEBE aterrizar donde está el bus (el snap), no "cerca". Si el camino no
  // empieza/termina exacto en A/B (p. ej. dedup interno), recta de siempre.
  if (distM(cam[0][1], cam[0][0], A.lat, A.lng) > 1) return null;
  if (distM(cam[cam.length - 1][1], cam[cam.length - 1][0], B.lat, B.lng) > 1) return null;
  let m = 0;
  for (let i = 1; i < cam.length; i++) m += distM(cam[i - 1][1], cam[i - 1][0], cam[i][1], cam[i][0]);
  if (m > Math.max(2.5 * dRecta, dRecta + 150)) return null;   // lazo/pase opuesto → recta de siempre
  return cam;
}

// Ejecuta tareas asíncronas con TOPE de concurrencia (pool). Para los fetch de puentes: 30
// huecos con caché fría tardaban hasta ~30 s en despacharse UNO POR UNO en la primera apertura
// del modal ("la huella tarda en crearse"); en paralelo acotado bajan a unos pocos segundos sin
// ametrallar la API. El ORDEN de los resultados lo maneja el llamador (cada tarea escribe en su
// propio slot por índice) — esta función solo limita cuántas corren a la vez. El patrón
// `i++` compartido es seguro: JS es mono-hilo y solo intercala en los await.
export async function enParalelo<T>(items: T[], limite: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

// PUNTOS de vía VEHICULAR cercanos a una posición (Mapbox Tilequery, tileset mapbox-streets-v8,
// capa `road`). La API devuelve, por cada feature del entorno, un Point = el punto de ESA vía más
// cercano al consultado (verificado con datos reales — no devuelve la polilínea). Es el fallback
// del snap del ícono cuando el bus circula LEJOS de la ruta planificada y el Map Matching no pegó
// (GPS de red, el caso #962). Se excluyen las clases donde un bus NO puede estar: peatonales,
// ferrovías (la capa road también trae rieles — pegar el bus al tren sería el mismo bug), vías en
// obra, teleféricos y ferry. `limit=50` (el máximo, mismo costo): el filtro corre DESPUÉS en el
// cliente y con limit chico una zona peatonal densa dejaba fuera la calzada real.
// Devuelve null en ERROR (red/HTTP — el consumidor puede reintentar con throttle) y [] cuando
// GENUINAMENTE no hay vía vehicular cerca (cacheable). Esta función no guarda estado.
const CLASES_NO_VEHICULARES = new Set([
  "path", "steps", "pedestrian", "sidewalk", "crossing", "footway", "corridor", "golf",
  "ferry", "major_rail", "minor_rail", "service_rail", "aerialway", "construction",
]);
export async function viasCercanasTilequery(lat: number, lng: number, radioM: number, token: string): Promise<{ lat: number; lng: number }[] | null> {
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json` +
      `?radius=${Math.round(radioM)}&limit=50&layers=road&geometry=linestring&access_token=${token}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const out: { lat: number; lng: number }[] = [];
    for (const f of json?.features || []) {
      if (CLASES_NO_VEHICULARES.has(String(f?.properties?.class || ""))) continue;
      const c = f?.geometry?.type === "Point" ? f.geometry.coordinates : null;
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) out.push({ lat: c[1], lng: c[0] });
    }
    return out;
  } catch { return null; }
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
    const url =
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
      `?geometries=geojson&overview=full&tidy=true&radiuses=${radii}&access_token=${token}`;
    // 429 (cuota por ráfaga — alcanzable con el lote paralelo del ajustador en backlogs de
    // full-day o varios visores a la vez): REINTENTAR con backoff en vez de devolver null.
    // Un null aquí se vuelve "no pegó" → la ventana se congela CRUDA para TODA la sesión del
    // modal (el congelado es inmutable por diseño) — un rate-limit transitorio no debe hornear
    // geometría degradada permanente (review ago-2026).
    let res: Response | null = null;
    for (let intento = 0; intento < 3; intento++) {
      res = await fetch(url);
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1200 * (intento + 1)));
    }
    if (!res || !res.ok) return null;
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

// Cuerda máxima que se dibuja como VELOCIDAD ("medido") cuando alguno de sus extremos es CRUDO de red
// (acc > ACC_CONFIABLE_M, o vértice esCrudo del matching). 60 m ≈ media cuadra limeña: por debajo la
// cuerda sigue la calle; por encima cruza techos/manzanas en diagonal. Antes esas cuerdas >60 m con
// extremo crudo salían GRIS PUNTEADAS ("aprox"); el usuario pidió eliminar ese gris (jul-2026) — ahora
// se OMITEN del trazo medido (no se dibujan) y la vía de ese tramo la cubre el estimado por ruta (verde
// petróleo) donde se pudo rutear. Con chip (acc ≤ 20 / esCrudo=false) NO aplica → flota propia idéntica.
export const MAX_SEG_CRUDO_M = 60;
// ¿Este `acc` marca el punto como crudo de red para el DIBUJO? Tres casos deliberados:
//  • acc == null (llamador legacy sin acc) → NO crudo: comportamiento idéntico al anterior, y en
//    un par mixto el extremo sin dato no fuerza el aprox del vecino chip.
//  • acc <= 0 → crudo: 0 significa "precisión NO medida" (el conductor tercero escribe
//    precision_m: 0, app/api/conductor-tercero/*) — desconocida ≠ confiable.
//  • acc > ACC_CONFIABLE_M (20) → crudo: red/torre. filasAPuntos ya convierte NULL de BD en 25 →
//    las filas sin precision_m también cuentan como crudas (desconocida ≠ confiable).
// Exportada: los consumidores la usan también para decidir si el ícono necesita el fallback de
// Tilequery (solo con fix crudo — un chip preciso ya está sobre la pista).
export const esAccCruda = (acc: number | undefined) => acc != null && (acc <= 0 || acc > ACC_CONFIABLE_M);

// (La capa gris punteada "aprox" fue ELIMINADA jul-2026 a pedido del usuario: la cuerda cruda larga
// ya no se pinta gris, se omite del medido y la cubre el estimado por ruta —verde petróleo—, que
// SIEMPRE va sobre la vía. colorearMatched/huellaCrudaFeatures ya no emiten `aprox:1`, así que los
// consumidores dibujan una sola capa de velocidad sin filtro.)

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
// Corta el trazo en saltos > MAX_SEG_M (costuras de ventanas fallidas / huecos). Con `esCrudo`
// (por vértice, alineado con coords — leerEsCrudo del ajustador): una cuerda con extremo crudo
// que supere MAX_SEG_CRUDO_M ya NO se dibuja sólida — sale con `aprox: 1` (gris punteada). Es la
// red de seguridad del "nunca cruzar techos" cuando la supresión/puentes fallan (puente con rodeo
// absurdo, corrida corta sin rutear, tope de puentes, estado desfasado): antes esas cuerdas de
// 61-300 m se pintaban como recorrido medido (#962).
export function colorearMatched(
  coords: [number, number][],
  huella: { lat: number; lng: number; velocidad: number }[],
  suprimir?: Array<[number, number]>,   // rangos de índice [s,e] a NO dibujar (crudo que se rellena por ruta estimada)
  esCrudo?: boolean[],                  // por vértice: true = fix crudo de red (no geometría de vía)
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
    const d = distM(aLat, aLng, bLat, bLng);
    if (d > MAX_SEG_M) continue;   // hueco, no recta cruzando el mapa
    // Cuerda con extremo CRUDO de red que cruza más de MAX_SEG_CRUDO_M: NO se dibuja como velocidad
    // (cruzaría casas) ni gris punteada — se OMITE. La vía de ese tramo la cubre el estimado por ruta
    // (verde petróleo). El usuario pidió eliminar el gris "aprox" (jul-2026); en régimen las corridas
    // crudas ya se rutean y esto es la red de seguridad (corrida sin rutear / tope de puentes / 1er render).
    if (!!esCrudo && (esCrudo[i] || esCrudo[i + 1]) && d > MAX_SEG_CRUDO_M) continue;
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
// Si los puntos traen `acc`, una cuerda con extremo crudo de red (acc > 20) que supere
// MAX_SEG_CRUDO_M se OMITE (antes salía gris punteada "aprox"; el usuario pidió eliminar ese gris,
// jul-2026): es el PRIMER RENDER del modal (mientras el ajustador hace sus llamadas a Mapbox) el que
// pintaba el zigzag de red entero —192 cuerdas >60 m en la #962— cruzando manzanas. Ahora esa cuerda
// no se dibuja; el estimado por ruta (verde petróleo) la cubre al terminar el Map Matching. Sin `acc`
// (llamadores legacy) se conserva TODO (comportamiento idéntico al anterior).
export function huellaCrudaFeatures(
  huellaPts: { lat: number; lng: number; velocidad: number; acc?: number }[],
  maxSegM = MAX_SEG_M,
  // Por defecto (true) omite la cuerda cruda de red >60 m (comportamiento actual: "nunca rectas sobre
  // casas"). En `false` dibuja TODO tramo ≤ maxSegM aunque sea crudo — se usa SOLO para la ESTELA
  // PROVISIONAL del modal, que necesita mostrar algo al instante (dashed/gris) mientras el Map Matching
  // pega el trazo a la vía, en vez de dejar el mapa en blanco 1-2 min en terceros con GPS de red.
  omitirCrudoLargo = true,
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
      const d = distM(a.lat, a.lng, b.lat, b.lng);
      // Cuerda cruda larga (extremo de red, cruza casas): se OMITE (antes gris "aprox"). Extremo sin
      // acc (legacy) NO se omite → idéntico al comportamiento previo. La cubre el estimado por ruta.
      // (La estela provisional pasa omitirCrudoLargo=false para dibujarla igual y no dejar el mapa vacío.)
      if (omitirCrudoLargo && (esAccCruda(a.acc) || esAccCruda(b.acc)) && d > MAX_SEG_CRUDO_M) continue;
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
  huella: { lat: number; lng: number; velocidad: number; acc?: number }[],
  live?: { lat: number; lng: number; velocidad?: number; acc?: number } | null,
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
  // Anclar al final REAL del trazo ajustado para no dejar hueco en la unión. SIN `acc`: el ancla es
  // geometría ya ajustada (no un fix) → esAccCruda la ignora y la cuerda de unión solo se marca
  // `aprox` si el OTRO extremo (el primer fix del tail) es crudo de red.
  const pts: { lat: number; lng: number; velocidad: number; acc?: number }[] = [
    { lat: endLat, lng: endLng, velocidad: tail[0]?.velocidad ?? huella[bestI]?.velocidad ?? 0 },
    ...tail,
  ];
  if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    const lastP = pts[pts.length - 1];
    if (!lastP || distM(lastP.lat, lastP.lng, live.lat, live.lng) > 3) {  // evita duplicar el vivo
      pts.push({ lat: live.lat, lng: live.lng, velocidad: live.velocidad ?? lastP?.velocidad ?? 0, acc: live.acc });
    }
  }
  // PUNTA VIVA DEGRADADA: si el Map Matching no logró pegar la cola (corte / GPS de red), en vez de
  // dibujar el zigzag crudo hasta el bus se SIGUE LA RUTA PREVISTA desde la frontera del trazo hasta la
  // posición en vivo (verde petróleo, `estimado:1`). Es determinista → sin parpadeo, y así la huella no
  // se rompe ni se corta. Si el bus se desvió de la ruta (o no hay ruta), cae al crudo → nunca inventa
  // camino fuera de la vía (puentePorRuta devuelve null con desvío >70 m).
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
  // Ventanas COMPLETAS matcheadas EN PARALELO al abrir con backlog (viaje largo ya andado). 4 es
  // seguro para la cuota de Map Matching (300 req/min): un backlog de 30 ventanas son 30 llamadas
  // en ~5-8 s, muy por debajo del tope, y recorta la primera huella de ~20-25 s a ~5-6 s.
  const PARALELO_VENTANAS = 4;
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
  let ultimoEsCrudo: boolean[] = [];        // esCrudo POR VÉRTICE del último `ajustar` (alineado 1:1 con las coords devueltas)

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
      let loteMax = PARALELO_VENTANAS;   // adaptativo: 1 tras ventana sucia, 4 tras limpia (ver abajo)
      while (limpio.length - congeladoHasta >= NUEVOS + 2) {
        // LOTE PARALELO (fix ago-2026 "la huella tarda en crearse"): al abrir el modal a mitad de
        // un viaje largo hay 10-30 ventanas completas pendientes y matchearlas UNA POR UNA (un
        // await por llamada a Mapbox) tardaba 10-25 s. Aquí se PRE-LANZAN hasta PARALELO ventanas
        // con límites OPTIMISTAS (cada una asume que la anterior avanza NUEVOS — el caso común:
        // ventana limpia congelada completa) y los resultados se procesan EN ORDEN con la MISMA
        // lógica que el camino secuencial. Si una ventana avanza distinto de NUEVOS (prefijo
        // limpio), los límites de las siguientes ya no valen → se DESCARTAN esos resultados (solo
        // se pierde la llamada; jamás se hornea geometría con límites corridos) y el while
        // exterior re-arma el lote desde el límite correcto. Con GPS bueno (todas snapped) la
        // geometría es BYTE-IDÉNTICA a la secuencial: mismas ventanas, mismos límites, mismo orden.
        // LOTE ADAPTATIVO (review ago-2026): en régimen DEGRADADO sostenido (cada ventana sale
        // mixta → avanza por prefijo limpio ≠ NUEVOS) el lote de 4 tiraba 3 resultados por vuelta
        // (~40% más llamadas que el secuencial, en ráfagas 4× más densas). Tras una ventana sucia
        // el lote baja a 1 (= secuencial, cero desperdicio) y vuelve a PARALELO_VENTANAS cuando
        // congela una limpia completa (loteMax se ajusta al procesar, abajo).
        const lote: { ini: number; ventana: MatchPt[]; res: ReturnType<typeof matchVentana> }[] = [];
        let H = congeladoHasta;
        while (lote.length < loteMax && limpio.length - H >= NUEVOS + 2) {
          const ini = Math.max(0, H - SOLAPE);
          const ventana = limpio.slice(ini, ini + MAX);   // ≤ MAX SIEMPRE → no se diezma
          lote.push({ ini: H, ventana, res: matchVentana(ventana, token) });
          H += NUEVOS;
        }
        for (const w of lote) {
          const rw = await w.res;
          if (cancelado?.()) return null;
          if (w.ini !== congeladoHasta) break;   // una previa avanzó ≠ NUEVOS → límites corridos → descartar el resto
          if (rw.snapped) {
            // Ventana LIMPIA → congelar completa (caso común; GPS bueno #1138 IDÉNTICO al legacy).
            congeladas.push(rw.coords);
            congeladasSnapped.push(true);
            congeladasEsCrudo.push(rw.esCrudo);
            congeladoHasta += NUEVOS;
            loteMax = PARALELO_VENTANAS;   // régimen limpio → vale la pena pre-lanzar
          } else {
            loteMax = 1;                   // régimen degradado → secuencial (no desperdiciar lote)
            // Ventana CRUDA: el re-match completo ARRUINA los puntos viejos-buenos que trae la ventana (bug
            // #795: [0,60] pega limpio solo, pero [0,100] con la cola degradada sale crudo y RE-DIBUJA crudos
            // esos 60 buenos = "edita 20 puntos antes"). En vez de hornear crudo sobre lo bueno, se congela
            // SOLO el PREFIJO LIMPIO más largo (INMUTABLE); el resto degradado queda para el siguiente ciclo
            // (lo cubre puentesCrudos por la ruta). Así lo ya dibujado NO se re-edita.
            const pref = await congelarPrefijoLimpio(w.ventana, token, cancelado);
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
      ultimoEsCrudo = esCrudoTodo;   // para colorearMatched: marcar `aprox` las cuerdas crudas largas que escapen a la supresión

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
    // esCrudo POR VÉRTICE (alineado con las coords del último `ajustar`) — para el corte/aprox de colorearMatched.
    leerEsCrudo: () => ultimoEsCrudo,
    // ¿El último match de la cola VIVA pegó a la vía? (false = punta degradada → colaViva sigue la ruta).
    leerColaSnapped: () => ultimaColaSnapped,
    // Último índice de VÍA limpia en las coords devueltas (frontera de colaViva; corta el crudo de la punta).
    leerColaClean: () => ultimoColaClean,
  };
}
