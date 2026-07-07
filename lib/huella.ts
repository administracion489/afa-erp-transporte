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

export function limpiarHuella(pts: HuellaPt[]): HuellaPt[] {
  // Pre-filtro: descarta fixes demasiado inciertos para el trazo (torre/WiFi, saltos imposibles).
  // PERO si eso dejaría el trazo casi vacío (equipo legítimo SIN chip, consistentemente >300 m),
  // se conservan los crudos finitos: una estela degradada es mejor que NINGUNA.
  const finitos = pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const precisos = finitos.filter((p) => p.acc <= ACC_MAX_TRAIL);
  const basePre = precisos.length >= 2 ? precisos : finitos;
  const base = quitarPicosV(basePre);

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
export type PuenteHueco = { aLat: number; aLng: number; bLat: number; bLng: number; dt: number; dRecta: number; iA: number; iB: number };

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
    out.push({ aLat: A.lat, aLng: A.lng, bLat: B.lat, bLng: B.lng, dt, dRecta, iA: i - 1, iB: i });
  }
  return out;
}

export type NivelPuente = "puente" | "aprox" | "ocultar";
// Decide, con la respuesta de Directions, cómo mostrar un hueco (degradación en 3 niveles):
//   • "puente"  → azul punteado pegado a la vía (ruta clara y plausible)
//   • "aprox"   → recta gris tenue "tramo sin señal" (ruta ambigua o rodeo moderado: no afirmamos la vía)
//   • "ocultar" → nada, hueco honesto (rodeo enorme / velocidad por carretera imposible / sin ruta)
// `roadM` = distancia por carretera de la ruta principal; `rutasM` = distancias de TODAS las rutas
// (para medir ambigüedad geométrica: 2+ caminos parecidos = no sabemos cuál tomó el bus).
export function decidirPuente(dRecta: number, dt: number, roadM: number, rutasM: number[]): NivelPuente {
  const vmax = VMAX_BUS_KMH / 3.6;
  if (!roadM || roadM <= 0) return "ocultar";
  if (roadM / dt > vmax) return "ocultar";              // por carretera habría necesitado >VMAX → fue por otro lado
  const detour = roadM / dRecta;                        // roadM = ruta PRINCIPAL (más rápida) de Google; detour y la geometría dibujada son coherentes entre sí
  if (detour > 2.5) return "ocultar";                   // rodeo enorme → ruta improbable
  // Ambigüedad sobre el par MÁS CORTO (a propósito): si Google ve 2 caminos casi iguales, no sabemos
  // cuál tomó el bus. (Asimetría intencional roadM-principal vs alts-más-cortas: sesga hacia "aprox".)
  const alts = (rutasM || []).filter((a) => a > 0).sort((a, b) => a - b);
  const ambiguo = alts.length >= 2 && (alts[1] - alts[0]) / alts[0] < 0.20;
  // "puente" AFIRMA la vía en azul → SOLO con evidencia fuerte: casi recto (detour ≤ 1.5), un único
  // camino plausible y hueco corto (≤ 150 s). "puente" NO garantiza la vía REAL, solo que es la MÁS
  // plausible; por eso todo lo demás degrada a "aprox" (recta gris tenue = "hubo hueco, camino incierto").
  // Regla de la casa: un hueco honesto supera una ruta afirmada en falso — con solo 2 extremos no se
  // puede distinguir "la ruta de Google" de "la del bus" si ambas son parecidas → se es conservador.
  if (detour <= 1.5 && !ambiguo && dt <= 150) return "puente";
  // "aprox" dibuja una RECTA A-B: si es MUY larga (>1500 m) cruzando la ciudad engaña más que un
  // hueco honesto → mejor ocultar. La recta corta gris+punteada+etiquetada comunica incertidumbre.
  if (dRecta > 1500) return "ocultar";
  return "aprox";
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
    if (!Array.isArray(m) || m.length === 0) return null;

    const tp = json?.tracepoints;
    if (!Array.isArray(tp) || tp.length !== sample.length) {
      // Sin tracepoints utilizables → conservador: solo aceptar el caso simple de 1 matching.
      if (m.length !== 1) return null;
      const c: [number, number][] = m[0]?.geometry?.coordinates || [];
      const conf = Number(m[0]?.confidence) || 0;
      return c.length >= 2 && conf > 0 ? { coords: c, confidence: conf } : null;
    }

    const CONF_FRAG = 0.4;
    const keep = m.map((x: any) => (Number(x?.confidence) || 0) >= CONF_FRAG);
    const emitidos = new Set<number>();   // cada fragmento se emite UNA vez (1ª aparición en orden)
    const via: [number, number][] = [];
    let cubiertos = 0;
    for (let k = 0; k < sample.length; k++) {
      const t: any = tp[k];
      const mi: number | null = t && t.matchings_index != null ? t.matchings_index : null;
      if (mi != null && keep[mi]) {
        cubiertos++;
        if (!emitidos.has(mi)) {
          emitidos.add(mi);
          const g = (m[mi]?.geometry?.coordinates as [number, number][]) || [];
          via.push(...g);
        }
      } else if (mi != null) {
        via.push([sample[k].lng, sample[k].lat]);   // fragmento dudoso → el fix REAL del bus
      }
      // mi == null: tidy lo descartó como outlier/redundante → omitir (rechazo de outliers gratis)
    }
    const confidence = cubiertos / sample.length;
    return via.length >= 2 ? { coords: via, confidence } : null;
  } catch { return null; }
}

// Ajusta UNA ventana (≤100 puntos densos) a la vía. `confidence` = fracción de la ventana pegada
// a fragmentos confiables; si ni el 40% se pudo pegar (GPS pobre / parado en red), cae a la huella
// cruda suavizada por DISTANCIA: aplana el zigzag lento sin recortar las curvas rápidas.
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

      // NUEVOS + 2 de margen (review): quitarPicosV puede re-juzgar los últimos ~2 puntos de la
      // cola en el ciclo siguiente (el último no tiene `next` aún). Sin margen, si el resto cae
      // exacto en 99 la ventana congelada incluiría un punto aún mutable → al eliminarse después,
      // los índices del prefijo se correrían y el pico quedaría horneado en la geometría congelada.
      while (limpio.length - congeladoHasta >= NUEVOS + 2) {
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
