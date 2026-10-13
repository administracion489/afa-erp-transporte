// lib/rutas-cache.ts
// Caché de geometría de rutas planificadas de Google Directions (tabla `rutas_cache`,
// ver supabase/rutas-cache.sql).
//
// Es OPCIONAL, igual que distancias_ruta_cache: si la tabla no existe o falta la
// service-role key, todo falla en silencio y /api/ruta sigue funcionando llamando a Google
// cada vez. Nunca debe tumbar una petición por un problema de caché.
// Excepción DELIBERADA: `leerRutasCache` (la lectura en lote de «Ver recorrido», que nunca llama a
// Google) LANZA ante un error — ver su comentario.
//
// Solo se cachea el caso DETERMINISTA (sin tráfico). Ver el comentario del .sql.

import { createClient } from "@supabase/supabase-js";

/** Los ToS de Google permiten almacenar resultados de Directions hasta 30 días. */
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

// La firma se mudó a lib/ruta-firma.ts (pura) para que el navegador pueda usarla sin
// arrastrar este cliente de base; se re-exporta para no cambiar a ningún importador.
export { firmaRuta, clavePuente } from "./ruta-firma";

/**
 * ¿Sigue vigente una entrada creada en `creadoAt`? La regla de siempre de `leerRutaCache`, extraída
 * para que la lectura en lote diga lo mismo: vence cuando `ahora − creado > ttl`. Ojo, a propósito
 * idéntica a la original: una fecha que no parsea (NaN) NO vence.
 */
export function entradaVigente(creadoAt: string | null | undefined, ttlMs: number, ahoraMs: number): boolean {
  return !(ahoraMs - new Date(creadoAt as any).getTime() > ttlMs);
}

/** Largo máximo (en caracteres ya codificados para la URL) de las claves de una sola consulta `.in`. */
export const MAX_CHARS_CONSULTA_CACHE = 6000;

/**
 * Parte las claves en lotes cuyo `in.(…)` quepa en una URL. Con lo que lee «Ver recorrido» (una
 * ruta y hasta MAX_PUENTES = 30 puentes, ~3 KB) es SIEMPRE un solo lote: partir solo protege de
 * una firma de ruta con cientos de paradas. Conserva el orden y no pierde ni repite claves.
 */
export function lotesDeClaves(claves: readonly string[], maxChars = MAX_CHARS_CONSULTA_CACHE): string[][] {
  const lotes: string[][] = [];
  let actual: string[] = [], largo = 0;
  for (const c of claves) {
    // Comillas y separador del `in.(…)` de PostgREST (las claves llevan comas y van entre comillas).
    const n = encodeURIComponent(`"${c}",`).length;
    if (actual.length && largo + n > maxChars) { lotes.push(actual); actual = []; largo = 0; }
    actual.push(c); largo += n;
  }
  if (actual.length) lotes.push(actual);
  return lotes;
}

/**
 * `ttlMs` permite a un llamador pedir una vigencia MÁS CORTA que la del almacén (una duración
 * con tráfico previsto envejece antes que una geometría). Por defecto, la de siempre.
 */
export async function leerRutaCache(clave: string, ttlMs: number = TTL_MS): Promise<any | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("rutas_cache")
      .select("payload, creado_at")
      .eq("clave", clave)
      .maybeSingle();

    if (error || !data) return null;
    if (!entradaVigente(data.creado_at, ttlMs, Date.now())) return null;

    return data.payload;
  } catch {
    // Tabla inexistente, red caída, etc. → miss silencioso.
    return null;
  }
}

/**
 * Lectura EN LOTE de `rutas_cache`: una sola consulta `.in` (por lote de URL, ver `lotesDeClaves`)
 * con la MISMA vigencia y el MISMO valor que `leerRutaCache` (el `payload` tal cual se guardó).
 * Devuelve solo las claves vigentes que existen; claves vacías o repetidas no se piden. SOLO LEE.
 *
 * ANTE UN ERROR, LANZA — y es la diferencia deliberada con `leerRutaCache`. Aquella alimenta a
 * quien PUEDE pagar la llamada (/api/ruta, /api/ruta-puente), así que un fallo es solo un miss que
 * termina en Google. Esta la usa «Ver recorrido», que NUNCA llama a Google: si un fallo se leyera
 * como «no hay nada en caché», la pantalla diría «sin ruta prevista» o dejaría un hueco sin su
 * tramo estimado en un servicio que sí los tiene guardados. Lanza también sin la service-role
 * (no se pudo leer ≠ no hay nada); el llamador lo declara como «no se pudo leer». `cliente` es
 * inyectable solo para la matriz.
 */
export async function leerRutasCache(
  claves: readonly string[],
  ttlMs: number = TTL_MS,
  cliente: any = supabaseAdmin,
): Promise<Map<string, any>> {
  const salida = new Map<string, any>();
  const unicas = [...new Set((claves || []).filter((c) => typeof c === "string" && c.length > 0))];
  if (unicas.length === 0) return salida;
  if (!cliente) throw new Error("No se pudo leer rutas_cache: falta SUPABASE_SERVICE_ROLE_KEY en el servidor.");
  const ahora = Date.now();
  for (const lote of lotesDeClaves(unicas)) {
    const { data, error } = await cliente
      .from("rutas_cache")
      .select("clave, payload, creado_at")
      .in("clave", lote);
    if (error) throw new Error(`No se pudo leer rutas_cache: ${error.message || error}`);
    for (const f of (data || []) as any[]) {
      if (f && typeof f.clave === "string" && entradaVigente(f.creado_at, ttlMs, ahora)) salida.set(f.clave, f.payload);
    }
  }
  return salida;
}

export async function guardarRutaCache(clave: string, payload: any): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin
      .from("rutas_cache")
      .upsert({ clave, payload, creado_at: new Date().toISOString() }, { onConflict: "clave" });
  } catch {
    // Escritura de caché best-effort: nunca debe romper la respuesta al cliente.
  }
}
