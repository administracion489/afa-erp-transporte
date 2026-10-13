// lib/ruta-firma.ts — PURO (navegador y servidor).
// La FIRMA GEOGRÁFICA de una ruta: las coordenadas en orden, redondeadas a 5 decimales
// (~1 m). Vivía en lib/rutas-cache.ts, que crea un cliente de base con la service-role al
// cargarse — o sea, el navegador no podía importarla. La necesitan las dos mitades: el
// servidor para la clave de `rutas_cache` y la pantalla de /cotizaciones para saber si una
// hora calculada sigue describiendo los paraderos que hay hoy (lib/paradas-horario.ts).
// Una sola definición: si cada lado redondeara a su manera, la marca «calculada» se leería
// como desactualizada sin que nadie hubiera movido un paradero.
//
// Aquí viven también las otras dos claves de `rutas_cache` que se escriben en un sitio y se
// leen en otro: la lista de paradas con que el modal GPS pide la ruta prevista
// (`paradasParaFirma`) y la del puente de un hueco de GPS (`clavePuente`). «Ver recorrido» lee
// esas entradas SIN llamar a Google, así que la clave con la que lee tiene que derivarse por el
// MISMO camino con que se escribió (scripts/prueba-recorrido.mts, secciones 7 y 8, cierra los
// dos ciclos).

/**
 * Firma geográfica de una ruta: las coordenadas en orden, redondeadas a 5 decimales (~1 m).
 * Las coordenadas salen de la tabla `paradas` y son estables, así que dos peticiones de la
 * misma ruta producen exactamente la misma clave.
 */
export function firmaRuta(paradas: { lat: number; lng: number }[]): string {
  return paradas.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

/**
 * Clave de `rutas_cache` del puente de un hueco de GPS (A = último fix bueno, B = primero tras el
 * hueco). La escribe app/api/ruta-puente/route.ts y la lee quien quiera ese puente sin pagarlo.
 */
export function clavePuente(aLat: number, aLng: number, bLat: number, bLng: number): string {
  return `puente:${aLat.toFixed(5)},${aLng.toFixed(5)}>${bLat.toFixed(5)},${bLng.toFixed(5)}`;
}

/** Una parada tal como la manda el modal a /api/ruta y la lee el servidor (lat/lng ya números). */
export type ParadaFirma = { nombre: string; lat: number; lng: number };

/**
 * Por qué el modal NO pediría la ruta con esta lista (y por tanto no hay entrada que leer):
 *   • `sin_paradas`: ni paradas, ni paradas_json, ni origen/destino.
 *   • `menos_de_dos`: menos de dos paradas con coordenadas.
 *   • `mismo_punto`: la primera y la última están en el mismo sitio.
 *   • `coordenada_invalida`: /api/ruta la rechazaría con 400 (no guarda nada).
 */
export type SinRutaFirma = "sin_paradas" | "menos_de_dos" | "mismo_punto" | "coordenada_invalida";

/**
 * Las paradas con que el modal GPS (components/seguimiento/ModalGps.tsx, `cargarRuta`) pide la ruta
 * prevista a /api/ruta, ya convertidas como las lee el servidor: `firmaRuta(lista)` es la clave con
 * la que /api/ruta la guarda en `rutas_cache`. Reproduce, en este orden:
 *   1. el orden por `orden` (sort ESTABLE: a igual `orden` decide el orden de entrada, así que quien
 *      lea tiene que pasar las paradas como se las pasa /seguimiento al modal: `orden`, `id`);
 *   2. el relleno de coordenadas faltantes desde `paradas_json` por nombre (sin tildes no: solo
 *      minúsculas y trim), o la lista entera desde `paradas_json` si no hay paradas;
 *   3. el respaldo origen → destino de la reserva (sin coordenadas: el modal los geocodifica);
 *   4. lo que el JSON y /api/ruta hacen con cada coordenada: texto → parseFloat, NaN → null → 0.
 * NO geocodifica (es una llamada pagada). `sinCoordenadas` cuenta las paradas que el modal mandaría
 * a geocodificar (`!lat || !lng`: una coordenada 0 cuenta como faltante); `lista` deja fuera esas
 * paradas, que es lo que el modal manda cuando la geocodificación no resuelve ninguna. Por eso la
 * clave está GARANTIZADA solo con `sinCoordenadas === 0` y `sinRuta === null`; con faltantes es la
 * del modal solo si Google tampoco las encontró.
 */
export function paradasParaFirma(
  paradas: readonly any[] | null | undefined,
  paradasJson?: readonly any[] | null,
  extremos?: { origen?: string | null; destino?: string | null } | null,
): { lista: ParadaFirma[]; sinCoordenadas: number; sinRuta: SinRutaFirma | null } {
  // ── 1-3: el armado de `listaParadas` del modal, línea a línea ──────────────────────────
  let listaParadas: any[] = [...(paradas || [])].sort((a: any, b: any) => a.orden - b.orden);

  if (paradasJson && paradasJson.length > 0) {
    const byNombre = new Map<string, { lat: number; lng: number }>();
    paradasJson.forEach((p: any) => {
      if (p.lat && p.lng) byNombre.set(String(p.nombre || "").trim().toLowerCase(), { lat: Number(p.lat), lng: Number(p.lng) });
    });
    if (listaParadas.length > 0) {
      listaParadas = listaParadas.map((p: any) => {
        if (!p.lat || !p.lng) {
          const coords = byNombre.get(String(p.nombre || "").trim().toLowerCase());
          if (coords) return { ...p, lat: coords.lat, lng: coords.lng };
        }
        return p;
      });
    } else {
      listaParadas = (paradasJson as any[])
        .filter((p: any) => p.nombre)
        .map((p: any, i: number) => ({
          id: -(i + 1), nombre: p.nombre,
          lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
          hora_estimada: p.hora || null, estado: "pendiente", orden: i + 1,
        }));
    }
  }

  if (listaParadas.length === 0) {
    const origen = extremos?.origen, destino = extremos?.destino;
    if (!(origen && destino)) return { lista: [], sinCoordenadas: 0, sinRuta: "sin_paradas" };
    listaParadas = [
      { id: -1, nombre: origen,  lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 1 },
      { id: -2, nombre: destino, lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 2 },
    ];
  }

  // Lo que el modal mandaría a geocodificar. Sin geocodificar, quedan fuera: es lo que pasa en el
  // modal cuando /api/geocodificar no resuelve una parada (le pone lat/lng null y el filtro
  // `!== null` la saca).
  const sinCoordenadas = listaParadas.filter((p: any) => !p.lat || !p.lng).length;
  const paradasConCoords = listaParadas.filter((p: any) => p.lat && p.lng);

  if (paradasConCoords.length < 2) return { lista: [], sinCoordenadas, sinRuta: "menos_de_dos" };
  const orig = paradasConCoords[0];
  const dest = paradasConCoords[paradasConCoords.length - 1];
  if (orig.lat === dest.lat && orig.lng === dest.lng) return { lista: [], sinCoordenadas, sinRuta: "mismo_punto" };

  // ── 4: el cuerpo que manda el modal, por JSON, y la conversión de /api/ruta ────────────
  // El JSON no es un detalle: un NaN viaja como null y el servidor lo lee como 0.
  const cuerpo = JSON.parse(JSON.stringify({
    paradas: paradasConCoords.map((p: any) => ({
      lat:    typeof p.lat === "string" ? parseFloat(p.lat) : p.lat,
      lng:    typeof p.lng === "string" ? parseFloat(p.lng) : p.lng,
      nombre: p.nombre,
    })),
  }));
  const lista: ParadaFirma[] = (cuerpo.paradas as any[]).map((p: any) => ({
    nombre: p.nombre || "Parada",
    lat:    typeof p.lat === "string" ? parseFloat(p.lat) : Number(p.lat),
    lng:    typeof p.lng === "string" ? parseFloat(p.lng) : Number(p.lng),
  }));
  if (lista.some((p) => isNaN(p.lat) || isNaN(p.lng))) return { lista: [], sinCoordenadas, sinRuta: "coordenada_invalida" };
  return { lista, sinCoordenadas, sinRuta: null };
}
