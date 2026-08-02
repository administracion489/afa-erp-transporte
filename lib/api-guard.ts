// lib/api-guard.ts
// Defensa de gasto para los endpoints que consumen cuota FACTURABLE de Google Maps:
// /api/ruta, /api/ruta-puente, /api/geocodificar, /api/geocodificar-inverso.
//
// Estos endpoints también los llaman páginas públicas sin sesión (/pasajero, /cliente,
// /seguimiento/[token], /conductor-tercero/[token]), así que no se pueden cerrar con la
// cookie de Supabase. Las dos capas que sí aplican en todos los casos:
//
//   1. same-origin — el navegador siempre manda `Origin` en un POST cross-origin, así que un
//      fetch desde otro sitio queda fuera. NO detiene a curl (Origin es falsificable); es la
//      capa barata que quita el scraping casual y el hotlinking.
//   2. rate limit por IP — ventana deslizante en memoria del proceso. En serverless el
//      contador es POR INSTANCIA, así que el techo real es `limite × instancias vivas`.
//      Sirve para cortar el bucle de un script, no a un atacante distribuido.
//
// El backstop real contra el gasto NO es este archivo: es la caché (una petición repetida no
// llega a Google) y la cuota diaria configurada en Google Cloud Console, que es el único tope
// que de verdad detiene la facturación.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

type Cubeta = { conteo: number; reinicioEn: number };

const cubetas = new Map<string, Cubeta>();
const LIMPIEZA_CADA_MS = 5 * 60_000;
let ultimaLimpieza = 0;

function ipDe(req: NextRequest): string {
  // Vercel y la mayoría de proxies ponen la IP real del cliente al inicio de x-forwarded-for.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "desconocida";
}

/**
 * `Origin` ausente = llamada servidor-a-servidor (cron, worker, app nativa). El navegador
 * SIEMPRE lo manda en un POST cross-origin, así que su ausencia no es el caso que interesa
 * bloquear aquí; para eso están el rate limit y los gates propios de cada handler.
 */
export function mismoOrigen(req: NextRequest): boolean {
  const origen = req.headers.get("origin");
  if (!origen) return true;
  try {
    const host = new URL(origen).host;
    // Detrás de un proxy, nextUrl.host puede ser el host interno: se acepta cualquiera de los dos.
    const propios = [req.nextUrl.host, req.headers.get("x-forwarded-host")].filter(Boolean);
    return propios.includes(host);
  } catch {
    return false;
  }
}

function purgar(ahora: number) {
  if (ahora - ultimaLimpieza < LIMPIEZA_CADA_MS) return;
  ultimaLimpieza = ahora;
  for (const [clave, cubeta] of cubetas) {
    if (cubeta.reinicioEn <= ahora) cubetas.delete(clave);
  }
}

/** true = pasa; false = excedió el límite en la ventana. */
export function limitarTasa(clave: string, limite: number, ventanaMs: number): boolean {
  const ahora = Date.now();
  purgar(ahora);

  const cubeta = cubetas.get(clave);
  if (!cubeta || cubeta.reinicioEn <= ahora) {
    cubetas.set(clave, { conteo: 1, reinicioEn: ahora + ventanaMs });
    return true;
  }
  if (cubeta.conteo >= limite) return false;
  cubeta.conteo++;
  return true;
}

/**
 * Chequeo BARATO, sin estado: se aplica a toda petición, incluidas las que se van a servir
 * desde caché. Devuelve una respuesta de error o `null` si puede seguir.
 *
 *   const bloqueo = guardarGasto(req, { etiqueta: "ruta" });
 *   if (bloqueo) return bloqueo;
 */
export function guardarGasto(
  req: NextRequest,
  _opciones: { etiqueta: string }
): NextResponse | null {
  if (!mismoOrigen(req)) {
    return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
  }
  return null;
}

/**
 * Rate limit del GASTO REAL. Se llama JUSTO ANTES de pegarle a Google, nunca antes de mirar la
 * caché.
 *
 * La distinción importa: si se limitara la petición en vez de la llamada facturable, un acierto
 * de caché consumiría cupo igual que una llamada nueva. Y como toda la oficina sale por una sola
 * IP (NAT), el bucle de puentes —que puede pedir 30 tramos en su primer ciclo— agotaría el cupo
 * y dejaría a operadores legítimos sin estela en vivo, sin haber gastado un centavo. Limitando
 * solo los fallos de caché, el usuario normal no toca nunca el límite y el bucle desbocado sí.
 *
 * Recordatorio: en serverless el contador es POR INSTANCIA, así que el techo real es
 * `limite × instancias vivas`. El único tope que de verdad detiene la facturación es la cuota
 * diaria configurada en Google Cloud Console.
 */
export function limitarGasto(
  req: NextRequest,
  opciones: { etiqueta: string; limite?: number; ventanaMs?: number }
): NextResponse | null {
  const limite = opciones.limite ?? 60;
  const ventanaMs = opciones.ventanaMs ?? 60_000;

  if (!limitarTasa(`${opciones.etiqueta}:${ipDe(req)}`, limite, ventanaMs)) {
    console.warn(`[api-guard] Rate limit alcanzado en "${opciones.etiqueta}" para ${ipDe(req)}`);
    return NextResponse.json(
      { error: "Demasiadas solicitudes — reintenta en un minuto" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ventanaMs / 1000)) } }
    );
  }

  return null;
}
