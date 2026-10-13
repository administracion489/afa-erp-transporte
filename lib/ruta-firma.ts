// lib/ruta-firma.ts — PURO (navegador y servidor).
// La FIRMA GEOGRÁFICA de una ruta: las coordenadas en orden, redondeadas a 5 decimales
// (~1 m). Vivía en lib/rutas-cache.ts, que crea un cliente de base con la service-role al
// cargarse — o sea, el navegador no podía importarla. La necesitan las dos mitades: el
// servidor para la clave de `rutas_cache` y la pantalla de /cotizaciones para saber si una
// hora calculada sigue describiendo los paraderos que hay hoy (lib/paradas-horario.ts).
// Una sola definición: si cada lado redondeara a su manera, la marca «calculada» se leería
// como desactualizada sin que nadie hubiera movido un paradero.

/**
 * Firma geográfica de una ruta: las coordenadas en orden, redondeadas a 5 decimales (~1 m).
 * Las coordenadas salen de la tabla `paradas` y son estables, así que dos peticiones de la
 * misma ruta producen exactamente la misma clave.
 */
export function firmaRuta(paradas: { lat: number; lng: number }[]): string {
  return paradas.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}
