// lib/coordenadas.ts
// Punto único para leer, mostrar y enlazar coordenadas SIN perder precisión.
//
// El bug que motiva este archivo: las coordenadas se GUARDAN completas —las columnas
// `lat`/`lng` son `numeric` de Postgres, precisión ilimitada, y ninguna escritura las
// recorta— pero cada pantalla las imprimía con `toFixed(4)`/`toFixed(5)`. El operador
// pega en el ERP el punto exacto que copió de Google Maps
// (-12.276661696156975, -76.86959687911232), lo ve de vuelta como "-12.2767, -76.8696",
// y al copiar ESO a Google Maps aterriza hasta ~11 m más allá: media cuadra, la vereda
// de enfrente, la puerta equivocada. El dato nunca se perdió; se perdía al mostrarlo.
//
// Cuánto vale un decimal en la latitud de Lima:
//   4 → ~11 m     5 → ~1,1 m     6 → ~11 cm     7 → ~1,1 cm
//
// REGLA: nada de lo que el operador ve, copia, exporta o enlaza puede venir de un
// `toFixed()`. Los `toFixed()` que quedan en el código son claves de caché, huellas de
// ruta y dedupe —ahí el redondeo es deliberado y está documentado en cada sitio—, más
// `encodePolyline`, cuyo formato Google fija en precisión 5.

/** Decimales del texto que se muestra: 7 ≈ 1,1 cm. Es la precisión que devuelve Google
 *  Places y está muy por debajo del error de cualquier GPS, así que el punto sigue
 *  siendo el mismo; solo evita imprimir los 15 dígitos de un pegado desde Google Maps. */
export const DECIMALES_VISIBLES = 7;

/** Convierte a número lo que venga de la BD (`numeric` llega como string), de un input
 *  de texto o de un JSON. Devuelve null en vez de NaN para que el llamador decida. */
export function aNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Texto de UNA coordenada para mostrar en pantalla o imprimir. `toFixed` rellena con
 *  ceros ("-12.0460000"); el `parseFloat` los quita y deja "-12.046". */
export function coordTexto(v: number | string | null | undefined): string {
  const n = aNum(v);
  return n === null ? "" : String(parseFloat(n.toFixed(DECIMALES_VISIBLES)));
}

/** "lat, lng" listo para mostrar, o `—` si al punto le falta alguna de las dos. */
export function fmtCoord(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined
): string {
  const a = coordTexto(lat), b = coordTexto(lng);
  return a && b ? `${a}, ${b}` : "—";
}

/** Coordenada para una URL (Google Maps, Mapbox) o un export: valor íntegro, sin
 *  redondear. Un enlace no tiene límite de dígitos, así que no hay motivo para recortar. */
export function coordUrl(v: number | string | null | undefined): string {
  const n = aNum(v);
  return n === null ? "" : String(n);
}

/** Enlace a Google Maps para un punto suelto, con la coordenada íntegra. */
export function urlMapsPunto(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined
): string {
  const a = coordUrl(lat), b = coordUrl(lng);
  return a && b ? `https://www.google.com/maps?q=${a},${b}` : "";
}

// El signo menos que copia Google (U+2212) y los guiones tipográficos no son el "-" de
// parseFloat: sin esto, un pegado directo del mapa se lee como coordenada inválida.
const normalizarSignos = (t: string) => t.replace(/[−–—]/g, "-").trim();

/** Si el texto no trae ningún punto decimal, las comas pegadas a un dígito SON el
 *  separador decimal (formato "−12,2766"). Si trae puntos, las comas solo separan. */
const normalizarDecimales = (t: string) => (t.includes(".") ? t : t.replace(/,(\d)/g, ".$1"));

const RANGOS_OK = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * Lee un PAR de coordenadas pegado como un solo texto.
 *
 * Existe porque el operador copia de Google Maps —o recibe por WhatsApp— el par entero
 * ("-12.276661696156975, -76.86959687911232") y lo pega en el campo de latitud. Antes
 * eso terminaba en "coordenadas inválidas" o, peor, en una latitud correcta con una
 * longitud vieja. Acepta coma, punto y coma, barra, espacios o salto de línea como
 * separador, y tolera prefijos tipo "lat/lng:".
 *
 * Devuelve null si no hay dos números o si se salen del rango terrestre.
 */
export function parsearParCoordenadas(texto: string): { lat: number; lng: number } | null {
  const t = normalizarDecimales(normalizarSignos(texto || ""));
  if (!t) return null;
  const nums = t.match(/-?\d{1,3}(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = parseFloat(nums[0]), lng = parseFloat(nums[1]);
  if (!RANGOS_OK(lat, lng)) return null;
  return { lat, lng };
}

/** Lee UNA coordenada de un input de texto, conservando todos sus decimales. */
export function parsearCoordenada(texto: string): number | null {
  const t = normalizarDecimales(normalizarSignos(texto || ""));
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
