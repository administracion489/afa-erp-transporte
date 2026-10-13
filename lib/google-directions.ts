// lib/google-directions.ts — SOLO SERVIDOR (lee la API key de Google; ningún archivo
// "use client" puede importarlo). El repo no tiene el paquete `server-only`, así que la
// regla se sostiene por convención y por esta cabecera.
//
// La llamada a Google Directions vivía dentro de app/api/ruta/route.ts. Se EXTRAJO —el
// fetch, la verificación del estado HTTP y del `status` de Google, y la traducción de los
// errores comunes— porque /api/cotizaciones/horas-paraderos necesita exactamente lo mismo
// por tramo, y dos copias de «qué significa OVER_QUERY_LIMIT» terminan diciendo cosas
// distintas sobre el mismo fallo.
//
// LA KEY NUNCA SALE DE AQUÍ: no va en la respuesta, ni en los mensajes de error, ni en los
// logs (se registra el `status` de Google, nunca la URL).
//
// Los errores se LANZAN como `{ estado, cuerpo }` — la forma que /api/ruta ya traducía a una
// respuesta HTTP en su `catch` — para que el comportamiento de esa ruta quede intacto.

/** La key de Directions del servidor, o null si no está configurada. */
export function claveGoogleDirections(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || null;
}

/** Error ya traducido para devolver tal cual: `NextResponse.json(e.cuerpo, { status: e.estado })`. */
export type ErrorDirections = { estado: number; cuerpo: { error: string; google_status?: string } };

export function esErrorDirections(e: unknown): e is ErrorDirections {
  return !!e && typeof e === "object" && "estado" in e && "cuerpo" in e;
}

/** Mensajes amigables para los `status` de Google más comunes. */
const MENSAJES: Record<string, string> = {
  REQUEST_DENIED:    "Directions API no habilitada en Google Cloud Console — actívala en APIs & Services",
  OVER_DAILY_LIMIT:  "Límite diario excedido — verificar facturación en Google Cloud",
  OVER_QUERY_LIMIT:  "Demasiadas consultas — esperar un momento",
  ZERO_RESULTS:      "No se encontró ruta entre las paradas — verificar coordenadas",
  NOT_FOUND:         "Una o más paradas no son accesibles por carretera",
  INVALID_REQUEST:   "Solicitud inválida — verificar coordenadas de paradas",
};

/**
 * Llama a Google Directions con los parámetros dados (la key la pone esta función) y devuelve
 * el JSON de Google ya comprobado: HTTP 2xx, `status === "OK"` y al menos una ruta. Lo que
 * cada llamador necesite además (polilínea, tramos) lo comprueba él.
 *
 * `etiqueta` solo prefija los logs (`[api/ruta]`, `[horas-paraderos]`).
 */
export async function consultarDirections(
  params: Record<string, string>,
  opciones: { key: string; etiqueta?: string },
): Promise<any> {
  const etq = opciones.etiqueta || "google-directions";
  const qs = new URLSearchParams({ ...params, key: opciones.key });
  const url = `https://maps.googleapis.com/maps/api/directions/json?${qs}`;

  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    console.error(`[${etq}] HTTP error:`, res.status, res.statusText);
    throw { estado: 502, cuerpo: { error: `Google HTTP ${res.status}: ${res.statusText}` } } satisfies ErrorDirections;
  }

  const data = await res.json();
  console.log(`[${etq}] Google status:`, data.status);

  if (data.status !== "OK") {
    const msg = data.error_message || data.status;
    console.error(`[${etq}] Google error:`, msg);
    throw { estado: 422, cuerpo: { error: MENSAJES[data.status] || msg, google_status: data.status } } satisfies ErrorDirections;
  }

  if (!data.routes || data.routes.length === 0) {
    throw { estado: 422, cuerpo: { error: "Google no devolvió rutas — verificar coordenadas" } } satisfies ErrorDirections;
  }

  return data;
}
