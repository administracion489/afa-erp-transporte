// lib/storage-privado.ts — ¿Este enlace apunta a un bucket PRIVADO? Módulo PURO (no lee la base).
//
// `documentos`, `pasajeros-fotos` y `radar-media` nacieron públicos y el ERP guardó en la base el
// enlace público COMPLETO de cada archivo (`…/storage/v1/object/public/<bucket>/<ruta>`), en diez
// columnas (`lecturas_odometro.foto_url`, `radar_mensajes.media_url`, `pasajeros.foto_url`,
// `documentos_tercero.archivo_url`…). Pasaron a privados porque guardan SOAT y licencias, la cara
// de los pasajeros y los vouchers de los grupos de WhatsApp: con el bucket público bastaba tener el
// enlace para bajar el archivo, sin login.
//
// LO GUARDADO NO SE REESCRIBE, y es la decisión de diseño entera. El enlace público pasa a ser un
// IDENTIFICADOR del archivo —ya no sirve para abrirlo— y quien lo va a USAR lo firma en ese momento
// (lib/storage-firmado.ts). Reescribir las filas a rutas habría obligado a migrar diez columnas a la
// vez: esos valores se comparan por IGUALDAD para no registrar dos veces la misma foto
// (`registrarLectura`, `fotosDeLectura`, el reproceso del Radar), así que una tabla migrada y otra
// no duplicaría lecturas. Y el worker del Radar, que corre en otra máquina, sigue escribiendo el
// enlace público sin que haya que tocarlo.
//
// El caso que casi se cuela: una columna MEZCLA orígenes. `lecturas_odometro.foto_url` guarda
// fotos de `radar-media` y de `vehiculos-fotos` (que sigue público), y `pasajeros.foto_url` admite
// enlaces de Drive. Por eso esto contesta null a todo lo que no sea exactamente un objeto de un
// bucket privado DE ESTE proyecto, y quien llama deja pasar ese valor tal cual.

export const BUCKETS_PRIVADOS = ["documentos", "pasajeros-fotos", "radar-media"] as const;
export type BucketPrivado = (typeof BUCKETS_PRIVADOS)[number];
export type ObjetoPrivado = { bucket: BucketPrivado; ruta: string };

const esBucketPrivado = (b: string): b is BucketPrivado =>
  (BUCKETS_PRIVADOS as readonly string[]).includes(b);

/**
 * El objeto al que apunta un enlace de Storage de un bucket privado, o null si no lo es.
 *
 * - Acepta el enlace PÚBLICO que se guardó (`/object/public/…`) y uno ya FIRMADO
 *   (`/object/sign/…?token=…`), que se re-firma: un firmado guardado por error ya habrá vencido.
 * - `base` es la URL del proyecto de Supabase. Un enlace de OTRO proyecto con un bucket del mismo
 *   nombre no es nuestro: firmarlo con nuestro cliente devolvería NUESTRO archivo de esa ruta, o
 *   sea otro documento. Sin `base` no se compara el origen (solo en pruebas).
 * - La ruta se recupera con `decodeURI`, que es la inversa EXACTA del `encodeURI` con el que
 *   `getPublicUrl` compuso el enlace (storage-js). Lo que el enlace trae tras `?` o `#` no es parte
 *   de la ruta: el navegador tampoco lo pedía, así que un archivo con esos caracteres en el nombre
 *   ya era inalcanzable con su enlace público.
 */
export function objetoPrivadoDe(url: unknown, base?: string | null): ObjetoPrivado | null {
  if (typeof url !== "string") return null;
  const texto = url.trim();
  if (!/^https?:\/\//i.test(texto)) return null;

  let u: URL;
  try { u = new URL(texto); } catch { return null; }

  if (base) {
    let b: URL;
    try { b = new URL(base); } catch { return null; }
    if (u.origin !== b.origin) return null;
  }

  const m = u.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, bucket, rutaCodificada] = m;
  if (!esBucketPrivado(bucket)) return null;

  let ruta: string;
  try { ruta = decodeURI(rutaCodificada); } catch { return null; }
  ruta = ruta.replace(/^\/+/, "");
  return ruta ? { bucket, ruta } : null;
}

/** La URL del proyecto con la que se comparan los enlaces (la misma que usa el cliente). */
export function baseSupabase(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
}
