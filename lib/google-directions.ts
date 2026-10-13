// lib/google-directions.ts — SOLO SERVIDOR (lee la API key de Google; ningún archivo
// "use client" puede importarlo). `import "server-only"` lo hace cumplir en el build: Next
// resuelve ese módulo con su copia interna (next/dist/compiled/server-only), así que no hace
// falta el paquete. Ningún scripts/*.mts importa este archivo; si alguno llegara a hacerlo con
// tsx, el import fallaría (ahí no existe el alias) — mover lo puro a otro módulo, no quitarlo.
import "server-only";
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

/**
 * Cuánto se espera a Google por consulta. NO MEDIDO: una Directions responde en 0.3-1 s; 8 s
 * es holgura de sobra y deja que una ruta de varios tramos quepa en el `maxDuration` de 60 s.
 * Sin tope, un Google colgado tenía la función abierta hasta que Vercel la mataba, y el
 * llamador recibía un corte sin JSON.
 */
export const TIMEOUT_GOOGLE_MS = 8_000;

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

  // El aborto por tiempo y el error de red se traducen a la MISMA forma `{ estado, cuerpo }`
  // que el resto: /api/ruta y horas-paraderos los devuelven tal cual (504) en vez de caer en
  // su 500 genérico. El mensaje nunca lleva la URL (lleva la key).
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_GOOGLE_MS) });
  } catch (e: any) {
    const porTiempo = e?.name === "TimeoutError" || e?.name === "AbortError";
    console.error(`[${etq}] ${porTiempo ? "Google no respondió en" : "error de red tras"} ${TIMEOUT_GOOGLE_MS} ms:`, e?.name);
    throw {
      estado: 504,
      cuerpo: { error: porTiempo ? "Google no respondió a tiempo" : "No se pudo conectar con Google (error de red). Vuelve a intentarlo." },
    } satisfies ErrorDirections;
  }

  if (!res.ok) {
    console.error(`[${etq}] HTTP error:`, res.status, res.statusText);
    throw { estado: 502, cuerpo: { error: `Google HTTP ${res.status}: ${res.statusText}` } } satisfies ErrorDirections;
  }

  let data: any;
  try {
    data = await res.json();
  } catch (e: any) {
    // El tope de tiempo también corre mientras se lee el cuerpo.
    const porTiempo = e?.name === "TimeoutError" || e?.name === "AbortError";
    console.error(`[${etq}] respuesta de Google ${porTiempo ? "cortada por tiempo" : "ilegible"}:`, e?.name);
    throw {
      estado: porTiempo ? 504 : 502,
      cuerpo: { error: porTiempo ? "Google no respondió a tiempo" : "Google devolvió una respuesta ilegible. Vuelve a intentarlo." },
    } satisfies ErrorDirections;
  }
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
