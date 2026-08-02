// lib/rutas-cache.ts
// Caché de geometría de rutas planificadas de Google Directions (tabla `rutas_cache`,
// ver supabase/rutas-cache.sql).
//
// Es OPCIONAL, igual que distancias_ruta_cache: si la tabla no existe o falta la
// service-role key, todo falla en silencio y /api/ruta sigue funcionando llamando a Google
// cada vez. Nunca debe tumbar una petición por un problema de caché.
//
// Solo se cachea el caso DETERMINISTA (sin tráfico). Ver el comentario del .sql.

import { createClient } from "@supabase/supabase-js";

/** Los ToS de Google permiten almacenar resultados de Directions hasta 30 días. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

/**
 * Firma geográfica de una ruta: las coordenadas en orden, redondeadas a 5 decimales (~1 m).
 * Las coordenadas salen de la tabla `paradas` y son estables, así que dos peticiones de la
 * misma ruta producen exactamente la misma clave.
 */
export function firmaRuta(paradas: { lat: number; lng: number }[]): string {
  return paradas.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

export async function leerRutaCache(clave: string): Promise<any | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("rutas_cache")
      .select("payload, creado_at")
      .eq("clave", clave)
      .maybeSingle();

    if (error || !data) return null;
    if (Date.now() - new Date(data.creado_at).getTime() > TTL_MS) return null;

    return data.payload;
  } catch {
    // Tabla inexistente, red caída, etc. → miss silencioso.
    return null;
  }
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
