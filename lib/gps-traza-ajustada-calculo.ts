// lib/gps-traza-ajustada-calculo.ts — EL ÚNICO módulo de servidor que ajusta una traza a la vía.
//
// Con la red INYECTADA: no lee la base ni conoce el token de nadie; recibe la huella limpia, el token y
// el `fetch`, y devuelve la salida del ajustador más lo que hace falta para decidir si se puede GUARDAR.
// Lo que decide cuándo se llama y qué se guarda es lib/gps-traza-ajustada-datos.ts. El `fetch` real del
// servidor (con plazo por consulta) también vive aquí, `fetchMapboxServidor`: así el lector no toca la
// red y este es el único módulo de servidor que habla con Mapbox.
//
// UNA SOLA PASADA con un ajustador NUEVO (`crearAjustadorHuella` de lib/huella.ts, el MISMO del modal):
// sin throttle de por medio (es nuevo) y sin cola viva que esperar (el servicio terminó), una llamada a
// `ajustar` recorre todas las ventanas y la cola. Así la geometría guardada es la que el modal habría
// dibujado al abrir el servicio terminado.
//
// LO QUE SE CUENTA, envolviendo el `fetch`:
//   • `llamadas`: cada petición a Mapbox (incluidos los reintentos ante 429 de `mapMatchTrail`).
//   • `transitorios`: consultas cuyo ÚLTIMO intento fue un fallo pasajero —429, 5xx o error de red—.
//     Un `null` de `mapMatchTrail` no distingue «no pegó» de «Mapbox no contestó», y en el segundo caso
//     la ventana queda en crudo: esa geometría degradada NO se puede guardar para siempre. Un 429 que se
//     reintentó y luego contestó 200 NO cuenta (la geometría salió de la respuesta buena). Otro 4xx es
//     definitivo (la consulta no tiene arreglo reintentándola) y no cuenta.
//   • `abortado`: al llegar al tope de llamadas (o al plazo `hastaMs`, `porTiempo`) se deja de llamar (la siguiente petición lanza, que
//     `mapMatchTrail` lee como `null`) y el ajustador se cancela. Una traza a medias no se guarda.

import { crearAjustadorHuella, type FetchMapbox, type MatchPt } from "./huella";
import { MAX_LLAMADAS_SERVICIO } from "./gps-traza-ajustada";

export type AjusteServicio = {
  coords: [number, number][];
  esCrudo: boolean[];
  colaSnapped: boolean;
  llamadas: number;
  transitorios: number;
  abortado: boolean;
  /** Abortó por el PLAZO (no por el tope de llamadas): la función del servidor no alcanzaba. */
  porTiempo: boolean;
};

/** Plazo por consulta a Mapbox del `fetch` de servidor. Operativo, NO medido. */
export const PLAZO_CONSULTA_MS = 10_000;

/**
 * El `fetch` que usa el SERVIDOR para Map Matching: el global, con un plazo por consulta (una consulta
 * colgada no puede comerse la función entera). Vencido el plazo, el `fetch` lanza → cuenta como fallo
 * pasajero y la traza no se guarda. Es el ÚNICO uso del `fetch` global en este módulo.
 */
export function fetchMapboxServidor(plazoMs: number = PLAZO_CONSULTA_MS): FetchMapbox {
  return (url) => fetch(url, { signal: AbortSignal.timeout(plazoMs) });
}

/** ¿Es un fallo pasajero? 429 (cuota por ráfaga) o 5xx. */
export const esStatusTransitorio = (status: number) => status === 429 || status >= 500;

export async function ajustarServicioCompleto(
  limpio: MatchPt[],
  token: string,
  f: FetchMapbox,
  tope: number = MAX_LLAMADAS_SERVICIO,
  opts?: {
    /** Instante (epoch ms) a partir del cual no se hace ninguna llamada más y se aborta. */
    hastaMs?: number;
    reloj?: () => number;
  },
): Promise<AjusteServicio> {
  let llamadas = 0;
  let abortado = false;
  let porTiempo = false;
  const reloj = opts?.reloj ?? Date.now;
  // Último resultado por consulta (la URL ES la consulta: mismos puntos, mismos radios). Un reintento
  // ante 429 repite la URL y pisa el resultado anterior.
  const ultimo = new Map<string, boolean>();   // url → ¿el último intento fue transitorio?
  const contada: FetchMapbox = async (url) => {
    if (!abortado && opts?.hastaMs != null && reloj() >= opts.hastaMs) { abortado = true; porTiempo = true; }
    if (abortado || llamadas >= tope) {
      abortado = true;
      throw new Error("tope de consultas a Map Matching alcanzado");
    }
    llamadas++;
    try {
      const res = await f(url);
      ultimo.set(url, esStatusTransitorio(res.status));
      return res;
    } catch (e) {
      ultimo.set(url, true);   // error de red: pasajero
      throw e;
    }
  };

  const ajustador = crearAjustadorHuella({ fetch: contada });
  let coords: [number, number][] = [];
  let esCrudo: boolean[] = [];
  let colaSnapped = true;
  const r = await ajustador.ajustar(limpio, token, () => abortado);
  if (r && !abortado) {
    coords = r;
    esCrudo = ajustador.leerEsCrudo();
    colaSnapped = ajustador.leerColaSnapped();
  }
  let transitorios = 0;
  for (const t of ultimo.values()) if (t) transitorios++;
  return { coords, esCrudo, colaSnapped, llamadas, transitorios, abortado, porTiempo };
}
