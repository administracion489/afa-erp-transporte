// lib/flota/recorrido-url.ts — PURO y sin dependencias (lo importan pantallas de cliente). La URL del
// mapa «Ver recorrido» (/seguimiento/gps/[id]) se compone y se lee AQUÍ, en un solo sitio: quien
// enlaza y quien lee derivan los parámetros por el mismo camino.
//
//   ?umbral=<km/h>   el umbral con que se pintan los excesos (el de la pantalla que enlaza)
//   ?inicio=<ms>     el episodio que se pide enfocar (el «Ver recorrido» de una fila de exceso)

/** La URL del mapa del recorrido de un servicio. */
export function urlRecorrido(reservaId: number, o: { umbral?: number | null; inicioTs?: number | null } = {}): string {
  const qs = new URLSearchParams();
  if (o.umbral != null && Number.isFinite(o.umbral)) qs.set("umbral", String(o.umbral));
  if (o.inicioTs != null && Number.isSafeInteger(o.inicioTs) && o.inicioTs > 0) qs.set("inicio", String(o.inicioTs));
  const q = qs.toString();
  return `/seguimiento/gps/${reservaId}${q ? `?${q}` : ""}`;
}

/** Lee `?inicio=`: milisegundos epoch enteros y positivos, o null. */
export function leerInicio(texto: string | null | undefined): number | null {
  if (!texto || !/^\d{10,15}$/.test(texto)) return null;
  const n = Number(texto);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** El episodio que se pidió enfocar: el que empieza en ese instante, con un segundo de holgura.
 *  null si no está (con otro umbral, el episodio puede no existir o empezar en otro punto). */
export function episodioEnfocado<T extends { inicioTs: number }>(eps: readonly T[], inicioTs: number | null): T | null {
  if (inicioTs == null || !Number.isFinite(inicioTs)) return null;
  return eps.find((x) => Math.abs(x.inicioTs - inicioTs) <= 1000) ?? null;
}
