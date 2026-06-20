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

// requestAnimationFrame en curso por marcador (para cancelar el anterior al llegar
// un punto nuevo). WeakMap → se limpia solo cuando el marcador se recolecta.
const rafPorMarcador = new WeakMap<object, number>();
// Momento del último update por marcador → estima la duración del tween para que
// el deslizamiento dure ~lo que tarda en llegar el siguiente punto (glide continuo).
const ultimoUpdate = new WeakMap<object, number>();

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
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
