// lib/geocode-cache.ts
// Geocodificación con caché por texto (tabla `geocode_cache`, ver supabase/geocode-cache.sql).
//
// Punto único de entrada para geocodificar en el servidor. Antes cada ruta API tenía su propia
// copia de la llamada a Google, sin caché y sin memoria de los fallos.
//
// Es OPCIONAL: si la tabla no existe o falta la service-role key, se degrada a llamar a Google
// cada vez (el comportamiento anterior). Nunca debe tumbar una petición por un fallo de caché.

import { createClient } from "@supabase/supabase-js";

/** Los ToS de Google permiten almacenar resultados de Geocoding hasta 30 días. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

/** `direccion` = formatted_address de Google; puede faltar en entradas cacheadas antiguas. */
export type Coordenadas = { lat: number; lng: number; direccion?: string | null };

/** Misma dirección escrita con otro espaciado o mayúsculas = misma entrada de caché. */
function normalizar(consulta: string): string {
  return consulta.trim().toLowerCase().replace(/\s+/g, " ");
}

// `texto` guarda la dirección resuelta por Google: el formatted_address en la geocodificación
// directa y la dirección corta legible en la inversa. Es la misma columna en las dos direcciones
// (ver supabase/geocode-cache.sql), porque las claves nunca chocan ("inv:..." vs. dirección).
type Entrada = {
  encontrado: boolean;
  lat: number | null;
  lng: number | null;
  texto?: string | null;
};

async function leerCache(clave: string): Promise<Entrada | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("geocode_cache")
      .select("lat, lng, texto, encontrado, creado_at")
      .eq("consulta", clave)
      .maybeSingle();

    if (error || !data) return null;
    if (Date.now() - new Date(data.creado_at).getTime() > TTL_MS) return null;

    return { encontrado: data.encontrado, lat: data.lat, lng: data.lng, texto: data.texto };
  } catch {
    return null;
  }
}

async function guardarCache(clave: string, entrada: Entrada): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from("geocode_cache").upsert(
      { consulta: clave, ...entrada, creado_at: new Date().toISOString() },
      { onConflict: "consulta" }
    );
  } catch {
    // Best-effort.
  }
}

/**
 * Geocodifica una dirección, consultando la caché primero.
 *
 * Devuelve `null` tanto si Google no la resuelve como si ya está memorizada como irresoluble.
 * Ese memo negativo es lo que impide que las direcciones malas se re-pidan para siempre.
 *
 * Junto a lat/lng devuelve `direccion` (el formatted_address normalizado por Google), que es lo
 * que se guarda en `paradas.direccion` en vez del texto crudo que tecleó el operador.
 */
export async function geocodificarConCache(consulta: string): Promise<Coordenadas | null> {
  const texto = (consulta || "").trim();
  if (!texto) return null;

  const clave = normalizar(texto);

  const cacheado = await leerCache(clave);
  if (cacheado) {
    // Incluye el caso encontrado=false: se devuelve null SIN llamar a Google.
    return cacheado.encontrado && cacheado.lat != null && cacheado.lng != null
      ? { lat: Number(cacheado.lat), lng: Number(cacheado.lng), direccion: cacheado.texto ?? null }
      : null;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(texto)}&key=${key}&region=pe&language=es`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.[0]) {
      if (data.status === "REQUEST_DENIED") {
        console.error("[geocode] REQUEST_DENIED — habilitar Geocoding API en Google Cloud Console");
      }
      // LISTA BLANCA a propósito: ZERO_RESULTS es el ÚNICO status que significa "esta
      // dirección no existe". Todo lo demás —OVER_DAILY_LIMIT (cuota diaria agotada o
      // facturación caída), OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST,
      // UNKNOWN_ERROR, o un cuerpo sin `status`— habla de NUESTRA cuenta, no de la
      // dirección. Memorizarlos envenenaría la caché: el negativo dura TTL_MS (30 días),
      // así que un solo día con la cuota agotada dejaría direcciones válidas sin
      // coordenadas durante un mes, y solo se purga borrando filas a mano.
      if (data.status !== "ZERO_RESULTS") {
        console.error(`[geocode] "${texto}" → ${data.status ?? "sin status"} (NO se memoriza)`);
        return null;
      }

      console.log(`[geocode] "${texto}" → ZERO_RESULTS (memorizado como irresoluble)`);
      await guardarCache(clave, { encontrado: false, lat: null, lng: null });
      return null;
    }

    const loc = data.results[0].geometry.location;
    const direccion: string | null = data.results[0].formatted_address || null;
    const coords: Coordenadas = { lat: loc.lat as number, lng: loc.lng as number, direccion };
    await guardarCache(clave, { encontrado: true, lat: coords.lat, lng: coords.lng, texto: direccion });
    return coords;
  } catch (e: any) {
    console.error(`[geocode] Error para "${texto}":`, e?.message);
    return null;
  }
}

/**
 * Geocodificación INVERSA (coordenadas → dirección corta legible), con caché.
 *
 * Redondea a 4 decimales (~11 m) para la clave: los puntitos de telemetría de un mismo tramo
 * de calle comparten entrada, que es justo el patrón de uso (un operador revisando una queja
 * clica muchos puntos seguidos del mismo recorrido).
 */
export async function geocodificarInversoConCache(lat: number, lng: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const clave = `inv:${lat.toFixed(4)},${lng.toFixed(4)}`;

  const cacheado = await leerCache(clave);
  if (cacheado) return cacheado.encontrado ? (cacheado.texto || null) : null;

  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?latlng=${lat},${lng}&key=${key}&region=pe&language=es`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.[0]) {
      // Misma lista blanca que la geocodificación directa: solo ZERO_RESULTS (mar, zona sin
      // datos) es un veredicto sobre estas coordenadas. Los demás status hablan de la cuenta.
      if (data.status === "ZERO_RESULTS") {
        await guardarCache(clave, { encontrado: false, lat: null, lng: null, texto: null });
      } else {
        console.error(`[geocode-inv] ${lat},${lng} → ${data.status ?? "sin status"} (NO se memoriza)`);
      }
      return null;
    }

    // Preferir la dirección de vía más específica (street_address/route) sobre la ciudad/país.
    const r = data.results as any[];
    const preferida =
      r.find((x) => x.types?.includes("street_address")) ||
      r.find((x) => x.types?.includes("route")) ||
      r[0];

    // Recortar a las 2 primeras partes ("Av. Los Álamos, San Juan de Miraflores") — legible y corto.
    const full: string = preferida.formatted_address || "";
    const corta = full.split(",").slice(0, 2).join(",").trim() || full;

    await guardarCache(clave, { encontrado: true, lat, lng, texto: corta });
    return corta;
  } catch (e: any) {
    console.error("[geocode-inverso] Error:", e?.message);
    return null;
  }
}
