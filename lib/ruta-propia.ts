// lib/ruta-propia.ts — la línea de la RUTA PLANIFICADA armada con el GPS REAL de un servicio
// anterior que hizo los mismos paraderos. Motor PURO: no lee la base ni llama a nadie.
// Matriz: npx tsx scripts/prueba-ruta-propia.mts.
//
// POR QUÉ EXISTE: la línea azul del modal GPS es una respuesta de Google Directions, y los
// términos de Google Maps Platform solo permiten guardarla de forma temporal (hasta 30 días,
// `TTL_MS` de lib/rutas-cache.ts). Al día 31 había que volver a pagarla. Un recorrido GPS de la
// propia flota es un dato NUESTRO: se guarda para siempre (`rutas_propias`) y a partir del día 31
// la sirve el ERP sin llamar a Google. Mientras la de Google siga vigente, manda la de Google.
//
// CÓMO SE ELIGE EL RECORRIDO (y por qué así):
//   1. EL SERVICIO TIENE QUE HABER PASADO POR CADA PARADERO, EN ORDEN, a ≤ RADIO_PARADERO_M. Un
//      recorrido que se salta uno no es esta ruta, es otra.
//   2. SIN HUECOS: ningún salto entre dos posiciones consecutivas de más de MAX_SALTO_M (el mismo
//      MAX_SEG_M con que la huella decide que hay un hueco). Una recta de 2 km cruzando manzanas
//      no es una calle — lo que la huella del modal tiene prohibido dibujar.
//   2b. SIN CUERDAS LARGAS: ninguna recta entre dos posiciones seguidas de más de MAX_CUERDA_M
//      (= MAX_SEG_CRUDO_M de lib/huella.ts, «por encima la cuerda cruza techos/manzanas en
//      diagonal»). La línea propia es GPS CRUDO, no ajustado a la vía: con posiciones cada 150-300 m
//      cada esquina se dibujaba en diagonal sobre las casas, y como esa línea también GUÍA el tramo
//      estimado del modal, el estimado cruzaba casas igual. Si no hay un servicio con posiciones
//      densas, no hay ruta propia y manda Google, como antes.
//   3. PRECISO: la precisión mediana del tramo ≤ ACC_CONFIABLE_M (el corte satélite/torre de la
//      huella). Una traza por red celular dibuja la ruta a 100 m de la vía.
//   4. ENTRE LOS VÁLIDOS, EL MÁS CORTO. Un desvío (un grifo, un desvío por obra, una vuelta
//      perdida) siempre ALARGA el recorrido, así que el más corto es el que menos desvíos lleva.
//      A igual largo, el más reciente.
//
// Los tiempos de cada tramo salen de las horas de ESE servicio (incluyen la espera de embarque).
// El modal no los enseña por defecto: manda el promedio real de 30 días (lib/tramos-historicos.ts).
//
// Umbrales: RADIO_PARADERO_M es el de lib/tramos-historicos.ts; MAX_SALTO_M y ACC_MEDIANA_MAX_M son
// los de lib/huella.ts — heredados, no elegidos. MIN_PUNTOS, TOLERANCIA_DP_M y MAX_VERTICES son
// operativos y NO están medidos.

import { distM, MAX_SEG_M, MAX_SEG_CRUDO_M, ACC_CONFIABLE_M, type HuellaPt } from "./huella";
import { RADIO_MATCH_M } from "./tramos-historicos";

export const RADIO_PARADERO_M = RADIO_MATCH_M;
export const MAX_SALTO_M = MAX_SEG_M;
export const ACC_MEDIANA_MAX_M = ACC_CONFIABLE_M;
export const MAX_CUERDA_M = MAX_SEG_CRUDO_M;
/** Versión de las reglas con que se armó el payload. Las de la 1 (con cuerdas de hasta 300 m) no se
 *  sirven y se vuelven a armar. */
export const VERSION_RUTA_PROPIA = 2;
export const MIN_PUNTOS = 10;
export const TOLERANCIA_DP_M = 4;
export const MAX_VERTICES = 3000;
/** Cuántos servicios recientes con los mismos paraderos se juzgan como candidatos. */
export const MAX_CANDIDATOS = 6;
/** Ventana de búsqueda de candidatos (días hacia atrás). */
export const DIAS_CANDIDATOS = 60;
/** Una ruta propia se vuelve a armar pasado este plazo (las vías cambian: obras, sentidos). */
export const DIAS_RENOVAR = 30;
/** Un intento que no encontró recorrido válido se reintenta pasado este plazo. */
export const HORAS_REINTENTO = 24;

export type Punto = { lat: number; lng: number };

export type CodigoTrazo =
  | "ok"
  | "pocos_puntos"        // la traza no tiene con qué dibujar
  | "no_pasa_paradero"    // no pasó (en orden) por alguno de los paraderos
  | "con_huecos"          // un salto > MAX_SALTO_M dentro del recorrido
  | "espaciado"           // una recta > MAX_CUERDA_M (cortaría manzanas)
  | "impreciso";          // precisión mediana peor que ACC_MEDIANA_MAX_M

export const MOTIVO_TRAZO: Record<CodigoTrazo, string> = {
  ok:               "Recorrido válido",
  pocos_puntos:     "El servicio casi no tiene posiciones GPS",
  no_pasa_paradero: "El recorrido no pasó por todos los paraderos en orden",
  con_huecos:       "El recorrido tiene cortes de GPS (saltos sin posición)",
  espaciado:        "Las posiciones llegan demasiado espaciadas (más de 60 m entre dos seguidas): la línea cortaría manzanas",
  impreciso:        "El GPS de ese servicio era impreciso (por red, sin satélite)",
};

export type TrazoValido = {
  codigo: "ok";
  /** Índice (en la traza recibida) del punto más cercano a cada paradero. */
  indices: number[];
  /** Puntos del recorrido, del paradero 1 al último. */
  puntos: HuellaPt[];
  largoM: number;
  accMediana: number;
};
export type TrazoInvalido = { codigo: Exclude<CodigoTrazo, "ok">; paradero?: number; saltoM?: number; accMediana?: number };
export type ResultadoTrazo = TrazoValido | TrazoInvalido;

function mediana(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * ¿Pasó por cada paradero, en orden? Para el paradero k se busca la PRIMERA vez (después del
 * paradero k−1) que la traza entra al radio, y dentro de esa pasada se toma el punto más cercano.
 * Devuelve los índices, o el primer paradero que no encontró.
 */
export function emparejarParaderos(puntos: Punto[], paraderos: Punto[]): { indices: number[] } | { falta: number } {
  const indices: number[] = [];
  let desde = 0;
  for (let k = 0; k < paraderos.length; k++) {
    const p = paraderos[k];
    let i = desde;
    while (i < puntos.length && distM(puntos[i].lat, puntos[i].lng, p.lat, p.lng) > RADIO_PARADERO_M) i++;
    if (i >= puntos.length) return { falta: k };
    let mejor = i;
    let mejorD = distM(puntos[i].lat, puntos[i].lng, p.lat, p.lng);
    for (let j = i + 1; j < puntos.length; j++) {
      const d = distM(puntos[j].lat, puntos[j].lng, p.lat, p.lng);
      if (d > RADIO_PARADERO_M) break;
      if (d < mejorD) { mejor = j; mejorD = d; }
    }
    indices.push(mejor);
    // El siguiente paradero puede estar dentro del mismo radio (paraderos a 100 m): se busca desde
    // el punto elegido, no desde el fin de la pasada.
    desde = mejor;
  }
  return { indices };
}

/** Juzga UN recorrido contra los paraderos de la ruta. `puntos` = la huella LIMPIA, en orden. */
export function juzgarTrazo(puntos: HuellaPt[], paraderos: Punto[]): ResultadoTrazo {
  if (paraderos.length < 2 || puntos.length < MIN_PUNTOS) return { codigo: "pocos_puntos" };
  const em = emparejarParaderos(puntos, paraderos);
  if ("falta" in em) return { codigo: "no_pasa_paradero", paradero: em.falta };
  const i0 = em.indices[0];
  const iN = em.indices[em.indices.length - 1];
  const tramo = puntos.slice(i0, iN + 1);
  if (tramo.length < 2) return { codigo: "pocos_puntos" };
  let largo = 0;
  for (let i = 1; i < tramo.length; i++) {
    const d = distM(tramo[i - 1].lat, tramo[i - 1].lng, tramo[i].lat, tramo[i].lng);
    if (d > MAX_SALTO_M) return { codigo: "con_huecos", saltoM: Math.round(d) };
    if (d > MAX_CUERDA_M) return { codigo: "espaciado", saltoM: Math.round(d) };
    largo += d;
  }
  const acc = mediana(tramo.map((p) => p.acc));
  if (!(acc <= ACC_MEDIANA_MAX_M)) return { codigo: "impreciso", accMediana: Math.round(acc) };
  return { codigo: "ok", indices: em.indices.map((i) => i - i0), puntos: tramo, largoM: largo, accMediana: acc };
}

export type Candidato = { reservaId: number; fecha: string | null; puntos: HuellaPt[] };
export type Eleccion =
  | { ok: true; reservaId: number; fecha: string | null; trazo: TrazoValido; juzgados: number; descartes: Partial<Record<CodigoTrazo, number>> }
  | { ok: false; juzgados: number; descartes: Partial<Record<CodigoTrazo, number>> };

/** Entre los candidatos, el recorrido válido MÁS CORTO (a igual largo, el más reciente). */
export function elegirRecorrido(candidatos: Candidato[], paraderos: Punto[]): Eleccion {
  const descartes: Partial<Record<CodigoTrazo, number>> = {};
  let mejor: { c: Candidato; t: TrazoValido } | null = null;
  for (const c of candidatos) {
    const t = juzgarTrazo(c.puntos, paraderos);
    if (t.codigo !== "ok") { descartes[t.codigo] = (descartes[t.codigo] ?? 0) + 1; continue; }
    if (!mejor
      || t.largoM < mejor.t.largoM - 0.5
      || (Math.abs(t.largoM - mejor.t.largoM) <= 0.5 && (c.fecha ?? "") > (mejor.c.fecha ?? ""))) {
      mejor = { c, t };
    }
  }
  if (!mejor) return { ok: false, juzgados: candidatos.length, descartes };
  return { ok: true, reservaId: mejor.c.reservaId, fecha: mejor.c.fecha, trazo: mejor.t, juzgados: candidatos.length, descartes };
}

/**
 * Douglas-Peucker en metros, CONSERVANDO los índices obligados (los paraderos: el corte de los
 * tramos). Si con la tolerancia queda por encima de `max`, la tolerancia se duplica hasta caber.
 * Devuelve los índices que sobreviven, en orden.
 */
export function simplificar(puntos: Punto[], obligados: number[], tolM = TOLERANCIA_DP_M, max = MAX_VERTICES): number[] {
  if (puntos.length <= 2) return puntos.map((_, i) => i);
  const lat0 = puntos[0].lat * Math.PI / 180;
  const kx = 111_320 * Math.cos(lat0), ky = 110_540;
  const xy = puntos.map((p) => [p.lng * kx, p.lat * ky] as const);
  const distSeg = (i: number, a: number, b: number) => {
    const [px, py] = xy[i], [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  };
  const fijos = [...new Set([0, puntos.length - 1, ...obligados.filter((i) => i >= 0 && i < puntos.length)])].sort((a, b) => a - b);
  for (let tol = tolM; ; tol *= 2) {
    const keep = new Uint8Array(puntos.length);
    for (const f of fijos) keep[f] = 1;
    for (let s = 0; s < fijos.length - 1; s++) {
      const pila: [number, number][] = [[fijos[s], fijos[s + 1]]];
      while (pila.length) {
        const [a, b] = pila.pop()!;
        let maxD = -1, idx = -1;
        for (let i = a + 1; i < b; i++) { const d = distSeg(i, a, b); if (d > maxD) { maxD = d; idx = i; } }
        if (idx >= 0 && maxD > tol) { keep[idx] = 1; pila.push([a, idx], [idx, b]); }
      }
    }
    const out: number[] = [];
    for (let i = 0; i < puntos.length; i++) if (keep[i]) out.push(i);
    if (out.length <= max || out.length <= fijos.length) return out;
  }
}

export type TramoRuta = {
  desde: string; hasta: string; distancia_km: number;
  duracion_min: number; duracion_trafico_min: number; duracion_texto: string;
  duracion_s: number; duracion_trafico_s: number;
};
export type PayloadRutaPropia = {
  coordenadas: [number, number][];
  tramos: TramoRuta[];
  total_km: number;
  total_min: number;
  advertencia: null;
  fuente: "propia";
  /** VERSION_RUTA_PROPIA con que se armó (ausente = 1). */
  version?: number;
  /** Fecha del servicio del que salió. El id de esa reserva NO viaja (se guarda aparte, en la fila). */
  fuente_fecha: string | null;
};

function textoMin(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * El payload con la MISMA forma que devuelve /api/ruta (coordenadas [lng, lat], tramos, totales),
 * para que el modal lo dibuje sin un camino aparte. `fuente: "propia"` dice de dónde salió.
 */
export function payloadDeRecorrido(e: Extract<Eleccion, { ok: true }>, nombres: string[]): PayloadRutaPropia {
  const { puntos, indices } = e.trazo;
  // Distancia acumulada sobre la traza COMPLETA (antes de simplificar): simplificar acorta curvas.
  const acum: number[] = [0];
  for (let i = 1; i < puntos.length; i++) acum.push(acum[i - 1] + distM(puntos[i - 1].lat, puntos[i - 1].lng, puntos[i].lat, puntos[i].lng));
  const tramos: TramoRuta[] = [];
  for (let k = 0; k < indices.length - 1; k++) {
    const a = indices[k], b = indices[k + 1];
    const km = Math.round((acum[b] - acum[a]) / 100) / 10;
    const ta = puntos[a].ts, tb = puntos[b].ts;
    const s = ta > 0 && tb > ta ? Math.round((tb - ta) / 1000) : 0;
    const min = Math.round(s / 60);
    tramos.push({
      desde: nombres[k] || `Punto ${k + 1}`,
      hasta: nombres[k + 1] || `Punto ${k + 2}`,
      distancia_km: km,
      duracion_min: min, duracion_trafico_min: min,
      duracion_texto: s > 0 ? textoMin(min) : "—",
      duracion_s: s, duracion_trafico_s: s,
    });
  }
  const quedan = simplificar(puntos, indices);
  const coordenadas = quedan.map((i) => [Math.round(puntos[i].lng * 1e6) / 1e6, Math.round(puntos[i].lat * 1e6) / 1e6] as [number, number]);
  return {
    coordenadas,
    tramos,
    total_km: Math.round(tramos.reduce((s, t) => s + t.distancia_km, 0) * 10) / 10,
    total_min: tramos.reduce((s, t) => s + t.duracion_min, 0),
    advertencia: null,
    fuente: "propia",
    version: VERSION_RUTA_PROPIA,
    fuente_fecha: e.fecha,
  };
}

/** ¿La lista de paraderos de la petición es la de esta reserva? (mismo largo, cada uno ≤ radio). */
export function mismosParaderos(a: Punto[], b: Punto[]): boolean {
  if (a.length !== b.length || a.length < 2) return false;
  return a.every((p, i) => distM(p.lat, p.lng, b[i].lat, b[i].lng) <= RADIO_PARADERO_M);
}

export type FilaRutaPropia = { payload: PayloadRutaPropia | null; revisada_en: string | null };

/** ¿Hay que (re)armar la ruta propia de esta clave? */
export function debeReconstruir(fila: FilaRutaPropia | null, ahoraMs: number): boolean {
  if (!fila) return true;
  // Un payload armado con reglas viejas no se sirve: se rearma sin esperar a la renovación.
  if (fila.payload && fila.payload.version !== VERSION_RUTA_PROPIA) return true;
  const rev = fila.revisada_en ? Date.parse(fila.revisada_en) : NaN;
  if (!Number.isFinite(rev)) return true;
  const plazo = fila.payload ? DIAS_RENOVAR * 86_400_000 : HORAS_REINTENTO * 3_600_000;
  return ahoraMs - rev >= plazo;
}

/** Una fila leída sirve para dibujar si trae coordenadas utilizables. */
export function payloadServible(fila: FilaRutaPropia | null): PayloadRutaPropia | null {
  const p = fila?.payload;
  if (!p || !Array.isArray(p.coordenadas) || p.coordenadas.length < 2 || !Array.isArray(p.tramos)) return null;
  if (p.version !== VERSION_RUTA_PROPIA) return null;   // reglas viejas: cuerdas de hasta 300 m
  return p;
}
