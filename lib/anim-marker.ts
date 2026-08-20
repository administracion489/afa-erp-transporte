// lib/anim-marker.ts
// Animación suave (tween) de marcadores Mapbox entre puntos GPS, estilo Uber.
// Desacopla la FLUIDEZ visual del RITMO de envío: aunque el conductor envíe cada
// 3-5 s, el marcador se desliza de forma continua entre puntos en vez de "saltar".
// Esto permite además BAJAR el ritmo de envío (batería/datos/costo) sin que el mapa
// se vea entrecortado.
//
// Uso: en lugar de `marker.setLngLat([lng, lat])` en la ACTUALIZACIÓN del marcador,
// llamar `animarMarcador(marker, [lng, lat])`. La creación del marcador sigue igual.

import type mapboxgl from "mapbox-gl";
import { distM, calcBearing } from "./huella";

// requestAnimationFrame en curso por marcador (para cancelar el anterior al llegar
// un punto nuevo). WeakMap → se limpia solo cuando el marcador se recolecta.
const rafPorMarcador = new WeakMap<object, number>();
// Momento del último update por marcador → estima la duración del tween para que
// el deslizamiento dure ~lo que tarda en llegar el siguiente punto (glide continuo).
const ultimoUpdate = new WeakMap<object, number>();

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ¿Hay un tween (recto o por camino) EN VUELO para este marcador? Lo usan los consumidores para
// no cancelar una animación en curso cuando el efecto re-corre SIN fix nuevo (los polls rearman
// los arrays y React re-dispara con el mismo destino): cancelarla con una recta cortaba la
// esquina que el tween por camino estaba doblando (review ago-2026).
export function tweenEnVuelo(marker: mapboxgl.Marker): boolean {
  return rafPorMarcador.has(marker);
}

/**
 * Mueve `marker` de su posición actual a `destino` con un tween suave. Cancela el
 * tween previo del mismo marcador. Si el salto es enorme (>~3 km: primer fix, error
 * GPS, o reaparición) hace un salto directo para no "volar" por el mapa. La duración
 * se autoajusta al ritmo real de actualización (acotada a 800 ms–4 s).
 */
export function animarMarcador(
  marker: mapboxgl.Marker,
  destino: [number, number],
  duracionMs?: number,
): void {
  const prevRaf = rafPorMarcador.get(marker);
  if (prevRaf != null) cancelAnimationFrame(prevRaf);

  const ahora = performance.now();
  const prevT = ultimoUpdate.get(marker);
  ultimoUpdate.set(marker, ahora);
  const dur = duracionMs ?? (prevT != null ? Math.min(4000, Math.max(800, ahora - prevT)) : 1200);

  const actual = marker.getLngLat();
  const startLng = actual.lng, startLat = actual.lat;
  const [endLng, endLat] = destino;

  // Salto directo si el desplazamiento es grande (>~0.03° ≈ 3 km) o nulo.
  const dGrados = Math.hypot(endLng - startLng, endLat - startLat);
  if (dGrados > 0.03 || dGrados === 0) {
    marker.setLngLat(destino);
    rafPorMarcador.delete(marker);
    return;
  }

  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = easeInOutQuad(p);
    marker.setLngLat([startLng + (endLng - startLng) * e, startLat + (endLat - startLat) * e]);
    if (p < 1) {
      rafPorMarcador.set(marker, requestAnimationFrame(step));
    } else {
      rafPorMarcador.delete(marker);
    }
  };
  rafPorMarcador.set(marker, requestAnimationFrame(step));
}

/**
 * Como `animarMarcador`, pero deslizando el marcador A LO LARGO DE UN CAMINO de vía
 * ([lng,lat][], p. ej. el sub-tramo de la ruta prevista entre el snap anterior y el nuevo,
 * ver caminoEntreSnaps en lib/huella.ts). El tween recto cortaba la esquina y el bus "volaba"
 * en diagonal sobre la manzana aunque ambos extremos estuvieran sobre la pista; aquí el avance
 * es por LONGITUD ACUMULADA sobre la polilínea (mismo easing), así el ícono dobla la esquina
 * por la calle, igual que la huella. Rotación: sigue el rumbo del SEGMENTO actual (el bus
 * "mira" hacia donde va, también en la curva); al terminar, si `rumboFinal` viene (>0, rumbo
 * real del equipo), se asienta en ese valor. Comparte el registro de RAF con animarMarcador:
 * mezclar llamadas cancela siempre el tween anterior del mismo marcador.
 */
export function animarMarcadorPorCamino(
  marker: mapboxgl.Marker,
  camino: [number, number][],
  opts?: { duracionMs?: number; rumboFinal?: number },
): void {
  if (!camino || camino.length === 0) return;
  const destino = camino[camino.length - 1];
  if (camino.length < 2) {
    animarMarcador(marker, destino, opts?.duracionMs);
    if (opts?.rumboFinal != null) marker.setRotation(opts.rumboFinal);
    return;
  }

  const prevRaf = rafPorMarcador.get(marker);
  if (prevRaf != null) cancelAnimationFrame(prevRaf);

  const ahora = performance.now();
  const prevT = ultimoUpdate.get(marker);
  ultimoUpdate.set(marker, ahora);
  const dur = opts?.duracionMs ?? (prevT != null ? Math.min(4000, Math.max(800, ahora - prevT)) : 1200);

  const actual = marker.getLngLat();
  // Salto directo si el desplazamiento total es enorme (>~3 km: primer fix / reaparición),
  // mismo criterio que animarMarcador.
  if (Math.hypot(destino[0] - actual.lng, destino[1] - actual.lat) > 0.03) {
    marker.setLngLat(destino);
    if (opts?.rumboFinal != null) marker.setRotation(opts.rumboFinal);
    rafPorMarcador.delete(marker);
    return;
  }

  // Empalme con la posición REAL del marcador: si el fix llegó a mitad del tween anterior, el
  // marcador está entre dos snaps — se antepone su posición actual como primer vértice (tramito
  // corto sobre el camino previo) para que no haya salto seco al arrancar.
  const pts: [number, number][] = [];
  if (distM(actual.lat, actual.lng, camino[0][1], camino[0][0]) > 0.5) pts.push([actual.lng, actual.lat]);
  pts.push(...camino);

  // Longitud acumulada por vértice (metros): el avance del tween es sobre el CAMINO, no la recta.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + distM(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
  const total = cum[cum.length - 1];
  if (!(total > 0)) {
    marker.setLngLat(destino);
    if (opts?.rumboFinal != null) marker.setRotation(opts.rumboFinal);
    rafPorMarcador.delete(marker);
    return;
  }

  const t0 = performance.now();
  let seg = 1;   // avance monótono: d solo crece, el segmento nunca retrocede
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const d = easeInOutQuad(p) * total;
    while (seg < pts.length - 1 && cum[seg] < d) seg++;
    const a = pts[seg - 1], b = pts[seg];
    const L = cum[seg] - cum[seg - 1];
    const f = L > 0 ? Math.min(1, Math.max(0, (d - cum[seg - 1]) / L)) : 1;
    marker.setLngLat([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    // Rumbo del segmento actual (solo si el segmento mide algo — un micro-empalme no gira el bus).
    if (L > 2) marker.setRotation(calcBearing(a[1], a[0], b[1], b[0]));
    if (p < 1) {
      rafPorMarcador.set(marker, requestAnimationFrame(step));
    } else {
      if (opts?.rumboFinal != null) marker.setRotation(opts.rumboFinal);
      rafPorMarcador.delete(marker);
    }
  };
  rafPorMarcador.set(marker, requestAnimationFrame(step));
}
