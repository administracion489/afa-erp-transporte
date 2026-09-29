// lib/storage-firmado.ts — Convierte el enlace guardado de un bucket PRIVADO en uno que se pueda abrir.
//
// Sirve con CUALQUIER cliente de Supabase: el del navegador (usuario del ERP, que firma con su
// sesión gracias a la política `authenticated` de supabase/seguridad-02-buckets-privados.sql) y el
// de service-role del servidor (APIs de la app del conductor y del pasajero, el Radar IA). Por eso
// no importa ninguno: se lo pasa quien llama.
//
// Tres reglas que no se aflojan:
// 1. TODO LO QUE NO ES DE UN BUCKET PRIVADO PASA TAL CUAL (Drive, `vehiculos-fotos`, otro
//    proyecto). Las columnas mezclan orígenes — ver lib/storage-privado.ts.
// 2. SI FIRMAR FALLA, SE DEVUELVE EL ENLACE ORIGINAL, nunca null. Antes de correr el SQL el bucket
//    sigue público y ese enlace funciona; después, un fallo deja el mismo enlace roto que habría
//    sin esto. Devolver null escondería el archivo también en el primer caso.
// 3. EL FIRMADO NO SE GUARDA NUNCA en la base: caduca. Se usa para pintar, descargar o pasárselo
//    a quien lo va a bajar ahora (Anthropic, Whisper), y se tira.

import { objetoPrivadoDe, baseSupabase } from "@/lib/storage-privado";

/** 1 h: lo que dura una pantalla abierta o un reintento del Radar. */
export const TTL_FIRMA_SEG = 3600;

/** El endpoint de firma en lote acepta arreglos grandes, pero una petición por bucket sin tope
 *  con los ~miles de pasajeros de /pasajeros sería una sola llamada lenta: se parte. */
const LOTE = 100;

export type ClienteStorage = {
  storage: {
    from(bucket: string): {
      createSignedUrls(paths: string[], expiresIn: number): Promise<{
        data: Array<{ path: string | null; signedUrl: string | null; error: string | null }> | null;
        error: unknown;
      }>;
    };
  };
};

/**
 * Firma varios enlaces de una vez. Devuelve un Map `enlace original → enlace utilizable` con una
 * entrada por cada enlace no vacío recibido (los que no son de un bucket privado se mapean a sí
 * mismos). Una llamada por bucket y por lote de 100, no una por archivo.
 */
export async function firmarUrls(
  client: ClienteStorage,
  urls: ReadonlyArray<string | null | undefined>,
  ttlSeg: number = TTL_FIRMA_SEG,
): Promise<Map<string, string>> {
  const salida = new Map<string, string>();
  const porBucket = new Map<string, Map<string, string[]>>(); // bucket → ruta → enlaces originales
  const base = baseSupabase();

  for (const url of urls) {
    if (!url || salida.has(url)) continue;
    salida.set(url, url); // regla 2: por defecto, el original
    const obj = objetoPrivadoDe(url, base);
    if (!obj) continue;
    const rutas = porBucket.get(obj.bucket) ?? new Map<string, string[]>();
    rutas.set(obj.ruta, [...(rutas.get(obj.ruta) ?? []), url]);
    porBucket.set(obj.bucket, rutas);
  }

  for (const [bucket, rutas] of porBucket) {
    const todas = [...rutas.keys()];
    for (let i = 0; i < todas.length; i += LOTE) {
      const lote = todas.slice(i, i + LOTE);
      try {
        const { data, error } = await client.storage.from(bucket).createSignedUrls(lote, ttlSeg);
        if (error || !data) continue;
        data.forEach((d, j) => {
          if (!d?.signedUrl || d.error) return;
          // Se casa por la ruta que devuelve la API; si no la trae, por la posición (misma orden).
          const ruta = d.path && rutas.has(d.path) ? d.path : lote[j];
          for (const original of rutas.get(ruta) ?? []) salida.set(original, d.signedUrl);
        });
      } catch {
        // regla 2: se quedan los originales
      }
    }
  }
  return salida;
}

/** Un solo enlace. `null`/vacío vuelve igual. */
export async function firmarUrl(
  client: ClienteStorage,
  url: string | null | undefined,
  ttlSeg: number = TTL_FIRMA_SEG,
): Promise<string | null> {
  if (!url) return url ?? null;
  return (await firmarUrls(client, [url], ttlSeg)).get(url) ?? url;
}
