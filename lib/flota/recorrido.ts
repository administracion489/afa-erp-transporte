// lib/flota/recorrido.ts — MOTOR PURO. Lo que dibuja el mapa «Ver recorrido» de un servicio
// (/seguimiento/gps/[id]): la traza GPS REAL y, encima, en rojo, los tramos donde hubo exceso.
//
// EL DEFECTO QUE CIERRA. «Ver recorrido» abría una vista vieja que cargaba Google Maps y le pedía a
// Google la RUTA PLANEADA entre paraderos, con tráfico de AHORA. No dibujaba ni una posición GPS, así
// que no tenía dónde marcar un exceso, y sobre un servicio terminado decía «TERMINA EN 55 MIN · EN
// VIVO». Cada apertura costaba una carga de Maps JavaScript y una consulta de Directions con tráfico.
// Ahora el mapa es Mapbox (el de toda la operación) y no consulta ninguna ruta a nadie.
//
// LOS EPISODIOS SON LOS DE LA COLUMNA «EXCESOS» DE /uso-flota → Servicios: salen de
// `episodiosDeTraza` (lib/flota/servicio-estadistica.ts), la misma función que los cuenta ahí, sobre
// la misma traza (`trazaDe` con sus filas). Y por la localidad del motor (prueba-excesos.mts) son los
// mismos que /seguridad-vial lista para esa reserva. Un mapa que detectara por su cuenta enseñaría
// otro número.
//
// QUÉ SE DIBUJA, Y CON QUÉ PUNTOS:
//   · la traza, LIMPIA (`limpiarHuella`, la misma de /seguimiento: sin fixes de torre, sin picos
//     imposibles, cada detención colapsada a un punto) y CORTADA donde salta más de MAX_SEG_M (300 m):
//     unir dos posiciones separadas por un hueco de señal dibujaría una recta que el bus no hizo. El
//     hueco se dibuja aparte, punteado, para que se vea que ahí no hubo señal;
//   · cada episodio con las posiciones CRUDAS de su racha (las que juzgó el motor, no las limpias):
//     el rojo tiene que estar exactamente donde el sensor marcó la velocidad.
//
// LO QUE NO AFIRMA: sin velocímetro no hay rojo y no es «sin excesos» (`excesos.codigo` lo dice);
// un servicio que no salió no tiene traza (`no_aplica`); una traza que no se pudo leer tampoco
// (`sin_medir`). La pantalla enruta por `excesos.codigo`, igual que la columna de /uso-flota.

import { filasAPuntos, limpiarHuella, distM, MAX_SEG_M } from "../huella";
import { claveRacha, type Episodio, type PuntoVel } from "./excesos";
import { episodiosDeTraza, excesosDelServicio, type ExcesosServicio } from "./servicio-estadistica";
import type { VeredictoRastreo } from "../gps-cobertura";

/** [lng, lat], como todo el ERP una vez que sale hacia Mapbox. */
export type Coord = [number, number];

/** Tope de vértices de la traza que viaja a la pantalla. Operativo, no medido: la traza limpia de un
 *  servicio de dos horas son cientos de puntos; esto solo evita mandar decenas de miles si una
 *  reserva quedó abierta un día entero. Se decima conservando los extremos de cada tramo. */
export const MAX_VERTICES_TRAZA = 5000;
/** Tope de huecos que viajan (se quedan los más largos). Operativo, no medido: una traza sana tiene
 *  pocos; cientos solo salen de un teléfono que salta de posición en posición, y dibujarlos todos no
 *  dice nada que no diga el conteo. */
export const MAX_HUECOS = 500;
/** Tope de posiciones por episodio (se muestrea conservando los extremos). Operativo, no medido: a
 *  una posición cada pocos segundos, 300 son más de diez minutos seguidos sobre el umbral. */
export const MAX_COORDS_EPISODIO = 300;

export type EpisodioMapa = {
  codigo: Episodio["codigo"];
  /** solo `exceso` cuenta; los demás se dibujan aparte y con su motivo */
  cuenta: boolean;
  inicioTs: number;
  finTs: number;
  durS: number;
  puntos: number;
  velMaxSensor: number;
  velMediaSensor: number;
  velGeom: number | null;
  precisionMediana: number | null;
  latPico: number;
  lngPico: number;
  cortado: boolean;
  detalle: string;
  /** las posiciones crudas de la racha, en orden; vacío si ninguna tiene coordenadas */
  coords: Coord[];
};

export type HuecoMapa = { desde: Coord; hasta: Coord; segundos: number | null; metros: number };

export type RecorridoServicio = {
  reservaId: number;
  umbral: number;
  /** la traza limpia, en tramos continuos (cada uno con 2+ vértices) */
  tramos: Coord[][];
  /** los saltos de más de MAX_SEG_M entre dos tramos: sin señal en medio */
  huecos: HuecoMapa[];
  /** cuántas posiciones llegaron (crudas, con coordenadas) */
  posiciones: number;
  primeraTs: number | null;
  ultimaTs: number | null;
  /** se decimó la traza para no pasar de MAX_VERTICES_TRAZA */
  decimada: boolean;
  /** tramos que no caben ni con solo sus extremos (los más cortos): no se dibujan */
  tramosOmitidos: number;
  /** huecos que pasan de MAX_HUECOS (los más cortos): no se dibujan */
  huecosOmitidos: number;
  /** el resumen: el MISMO de la columna «Excesos» de /uso-flota → Servicios */
  excesos: ExcesosServicio;
  /** todos los episodios (los que cuentan y los descartados), por hora de inicio */
  episodios: EpisodioMapa[];
};

const finito = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const coordValida = (lat: number, lng: number) =>
  finito(lat) && finito(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** La clave de racha de un episodio: la misma que `claveRacha` le dio a sus puntos. */
function claveDeEpisodio(ep: Episodio): string | null {
  return claveRacha({
    ts: ep.inicioTs, lat: ep.latPico, lng: ep.lngPico, velocidad: ep.velMaxSensor, precisionM: ep.precisionMediana,
    reservaId: ep.reservaId, conductor: ep.conductor, vehiculo: ep.vehiculo, simulado: null,
  });
}

/** Las posiciones crudas de la racha de un episodio: misma clave de racha y dentro de [inicio, fin]. */
export function coordsDeEpisodio(puntos: readonly PuntoVel[], ep: Episodio): Coord[] {
  const clave = claveDeEpisodio(ep);
  return puntos
    .filter((p) => p.ts >= ep.inicioTs && p.ts <= ep.finTs && claveRacha(p) === clave && coordValida(p.lat, p.lng))
    .sort((a, b) => a.ts - b.ts)
    .map((p) => [p.lng, p.lat] as Coord);
}

/** Corta la traza limpia donde salta más de MAX_SEG_M: cada corte es un hueco de señal. */
export function tramosDeTraza(limpia: readonly { lat: number; lng: number; ts: number }[]): { tramos: Coord[][]; huecos: HuecoMapa[] } {
  const pts = limpia.filter((p) => coordValida(p.lat, p.lng));
  const tramos: Coord[][] = [];
  const huecos: HuecoMapa[] = [];
  let actual: Coord[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) {
      const a = pts[i - 1];
      const d = distM(a.lat, a.lng, p.lat, p.lng);
      if (d > MAX_SEG_M) {
        if (actual.length >= 2) tramos.push(actual);
        const dt = a.ts > 0 && p.ts > a.ts ? (p.ts - a.ts) / 1000 : null;
        huecos.push({ desde: [a.lng, a.lat], hasta: [p.lng, p.lat], segundos: dt, metros: Math.round(d) });
        actual = [];
      }
    }
    actual.push([p.lng, p.lat]);
  }
  if (actual.length >= 2) tramos.push(actual);
  return { tramos, huecos };
}

/** `n` elementos repartidos a lo largo de `xs`, con el primero y el último siempre dentro. */
export function muestrear<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  if (n <= 1) return xs.slice(0, Math.max(0, n));
  return Array.from({ length: n }, (_, k) => xs[Math.round((k * (xs.length - 1)) / (n - 1))]);
}

const contarVertices = (ts: readonly Coord[][]) => ts.reduce((acc, t) => acc + t.length, 0);
const largoM = (t: readonly Coord[]) => {
  let m = 0;
  for (let i = 1; i < t.length; i++) m += distM(t[i - 1][1], t[i - 1][0], t[i][1], t[i][0]);
  return m;
};

/**
 * Decima los tramos para no pasar de `max` vértices en total, conservando los extremos de cada uno.
 * Es un TOPE DURO: si con solo los extremos los tramos siguen sin caber (cientos de tramos cortos, un
 * teléfono que salta de posición en posición), se quedan los más LARGOS en metros y el resto se cuenta
 * en `omitidos`. Sin pasar del tope devuelve los mismos tramos, sin tocar.
 */
export function decimarTramos(tramos: Coord[][], max = MAX_VERTICES_TRAZA): { tramos: Coord[][]; decimada: boolean; omitidos: number } {
  const total = contarVertices(tramos);
  if (total <= max) return { tramos, decimada: false, omitidos: 0 };
  const masLargo = tramos.reduce((acc, t) => Math.max(acc, t.length), 0);
  const decimar = (paso: number) => tramos.map((t) => t.filter((_, i) => i === 0 || i === t.length - 1 || i % paso === 0));
  let paso = Math.max(2, Math.ceil(total / max));
  let out = decimar(paso);
  // Los extremos no se deciman: con muchos tramos el primer paso no basta. Se agranda hasta que cada
  // tramo quede en sus dos extremos.
  while (contarVertices(out) > max && paso < masLargo) {
    paso += Math.max(1, Math.floor(paso / 4));
    out = decimar(paso);
  }
  if (contarVertices(out) <= max) return { tramos: out, decimada: true, omitidos: 0 };
  // Ni con solo los extremos: se quedan los tramos más largos, en su orden original.
  const orden = out.map((t, i) => ({ i, m: largoM(tramos[i]) })).sort((a, b) => b.m - a.m || a.i - b.i);
  const quedan = new Set<number>();
  let usados = 0;
  for (const { i } of orden) {
    if (usados + out[i].length > max) continue;
    quedan.add(i);
    usados += out[i].length;
  }
  return { tramos: out.filter((_, i) => quedan.has(i)), decimada: true, omitidos: out.length - quedan.size };
}

/** Topa los huecos a `max`: se quedan los más LARGOS, en su orden original. */
export function toparHuecos(huecos: HuecoMapa[], max = MAX_HUECOS): { huecos: HuecoMapa[]; omitidos: number } {
  if (huecos.length <= max) return { huecos, omitidos: 0 };
  const quedan = new Set(
    huecos.map((h, i) => ({ i, m: h.metros })).sort((a, b) => b.m - a.m || a.i - b.i).slice(0, max).map((x) => x.i),
  );
  return { huecos: huecos.filter((_, i) => quedan.has(i)), omitidos: huecos.length - max };
}

const vacio = (reservaId: number, umbral: number, excesos: ExcesosServicio): RecorridoServicio => ({
  reservaId, umbral, tramos: [], huecos: [], posiciones: 0, primeraTs: null, ultimaTs: null, decimada: false,
  tramosOmitidos: 0, huecosOmitidos: 0, excesos, episodios: [],
});

/**
 * El recorrido de un servicio a partir de su traza leída con sus filas (`trazaDe(…, { conHuella: true })`).
 * Recibe lo mismo que `excesosDelServicio` y su resumen ES el de esa función.
 */
export function recorridoDeServicio(e: {
  reservaId: number;
  crudas: any[] | null;
  aplica: boolean;
  trazaLeida: boolean;
  rastreo: VeredictoRastreo;
  umbral: number;
  vehiculo?: string | null;
}): RecorridoServicio {
  const excesos = excesosDelServicio(e);
  if (!e.aplica || !e.trazaLeida || !e.crudas) return vacio(e.reservaId, e.umbral, excesos);

  // La traza se dibuja aunque el teléfono no tenga velocímetro: el recorrido existe igual.
  const limpia = limpiarHuella(filasAPuntos(e.crudas).filter((p) => coordValida(p.lat, p.lng)).sort((a, b) => a.ts - b.ts));
  const cortada = tramosDeTraza(limpia);
  const { tramos, decimada, omitidos: tramosOmitidos } = decimarTramos(cortada.tramos);
  const { huecos, omitidos: huecosOmitidos } = toparHuecos(cortada.huecos);

  const { puntos, episodios } = episodiosDeTraza({ reservaId: e.reservaId, crudas: e.crudas, umbral: e.umbral, vehiculo: e.vehiculo });
  const conCoord = puntos.filter((p) => coordValida(p.lat, p.lng));
  const tss = conCoord.map((p) => p.ts).filter((t) => t > 0);

  // Los episodios solo se publican cuando el resumen es `medido`: con otro código el resumen no
  // afirma ninguno, y el mapa no puede decir otra cosa que la columna.
  const eps: EpisodioMapa[] = excesos.codigo !== "medido" ? [] : episodios
    .map((ep) => ({
      codigo: ep.codigo,
      cuenta: ep.codigo === "exceso",
      inicioTs: ep.inicioTs,
      finTs: ep.finTs,
      durS: ep.durS,
      puntos: ep.puntos,
      velMaxSensor: ep.velMaxSensor,
      velMediaSensor: ep.velMediaSensor,
      velGeom: ep.velGeom,
      precisionMediana: ep.precisionMediana,
      latPico: ep.latPico,
      lngPico: ep.lngPico,
      cortado: ep.cortado,
      detalle: ep.detalle,
      coords: muestrear(coordsDeEpisodio(puntos, ep), MAX_COORDS_EPISODIO),
    }))
    .sort((a, b) => a.inicioTs - b.inicioTs);

  return {
    reservaId: e.reservaId,
    umbral: e.umbral,
    tramos,
    huecos,
    posiciones: conCoord.length,
    primeraTs: tss.length ? tss.reduce((a, b) => Math.min(a, b)) : null,
    ultimaTs: tss.length ? tss.reduce((a, b) => Math.max(a, b)) : null,
    decimada,
    tramosOmitidos,
    huecosOmitidos,
    excesos,
    episodios: eps,
  };
}
