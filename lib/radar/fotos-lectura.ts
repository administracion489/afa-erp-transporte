// lib/radar/fotos-lectura.ts — QUÉ FOTOS LEYÓ LA IA, resuelto en UN solo sitio.
//
// La pregunta parece un campo y es una cascada. `radar_combustible.fotos` (jsonb
// `[{url, mime, nombre}]`) trae TODAS las del cluster —nota, surtidor, tablero— y es la buena;
// las filas anteriores a `supabase/radar-ia-combustible-revision.sql` la tienen vacía y de esas
// solo se puede recuperar la media del mensaje que las originó (`radar_mensajes.media_url`),
// que es UNA. Dos copias de esa cascada se desincronizan en la primera fila vieja, que es
// justo la que se va a auditar.
//
// Lo piden dos pantallas por motivos distintos:
//   · `/radar-ia?tab=combustible` para revisar antes de registrar;
//   · `/combustible` para CORREGIR una carga ya registrada contra el papel — sin la foto,
//     editar es teclear de memoria, y el número que se está arreglando salió de esa foto.
//
// **El puente es `radar_combustible.combustible_id`, y se lee al revés**: la tabla
// `combustible` no guarda absolutamente nada del Radar (ni el id, ni la foto, ni el
// comprobante), así que la única forma de saber qué foto originó una carga es preguntarle al
// Radar cuál carga escribió.

/** Una foto (o adjunto) que la IA procesó. */
export type FotoLeida = { url: string; nombre: string | null; mime: string | null };

/** Lo que hace falta de una fila de `radar_combustible` para resolver sus fotos. */
export type FilaConFotos = {
  combustible_id?: number | string | null;
  mensaje_id?: string | null;
  fotos?: ({ url?: string | null; mime?: string | null; nombre?: string | null } | null)[] | null;
};

/** Lo que hace falta de `radar_mensajes` para el respaldo de las filas viejas. */
export type MediaDeMensaje = {
  media_url?: string | null;
  media_mime?: string | null;
  media_nombre?: string | null;
};

function sinRepetir(fotos: FotoLeida[]): FotoLeida[] {
  const vistas = new Set<string>();
  return fotos.filter((f) => (vistas.has(f.url) ? false : (vistas.add(f.url), true)));
}

/**
 * Las fotos que la IA procesó para una fila del Radar: las guardadas en la fila y, solo si no
 * hay ninguna, la media del mensaje de origen.
 */
export function fotosDeLectura(fila?: FilaConFotos | null, mensaje?: MediaDeMensaje | null): FotoLeida[] {
  const propias = (fila?.fotos ?? [])
    .filter((f) => !!f?.url)
    .map((f) => ({ url: String(f!.url), nombre: f!.nombre ?? null, mime: f!.mime ?? null }));
  if (propias.length) return sinRepetir(propias);
  return mensaje?.media_url
    ? [{ url: mensaje.media_url, nombre: mensaje.media_nombre ?? null, mime: mensaje.media_mime ?? null }]
    : [];
}

/**
 * Índice `combustible.id` → fotos que la IA leyó, para la pantalla que parte de la CARGA y no
 * de la lectura. Una carga puede tener más de una fila del Radar apuntándola (un reproceso que
 * volvió a proponerla, un álbum con dos despachos): se suman todas y se quitan las repetidas,
 * porque lo que se busca es "con qué papel se comparó esta carga", no cuál fila lo escribió.
 */
export function fotosPorCarga(
  filas: FilaConFotos[],
  media: Record<string, MediaDeMensaje | undefined> = {},
): Record<number, FotoLeida[]> {
  const mapa: Record<number, FotoLeida[]> = {};
  for (const fila of filas) {
    const id = Number(fila?.combustible_id);
    if (!Number.isFinite(id) || fila?.combustible_id == null) continue;
    const fotos = fotosDeLectura(fila, fila.mensaje_id ? media[fila.mensaje_id] : null);
    if (!fotos.length) continue;
    mapa[id] = sinRepetir([...(mapa[id] ?? []), ...fotos]);
  }
  return mapa;
}

const EXT_IMAGEN = /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif)(\?|#|$)/i;
const EXT_DOC = /\.(pdf|ogg|opus|mp3|m4a|mp4|3gp|webm)(\?|#|$)/i;

/**
 * Si se puede pintar con `<img>`. El bucket `radar-media` guarda también PDFs y audios: un
 * voucher que llegó como PDF en un `<img>` es un ícono roto, que en una pantalla cuyo trabajo
 * es "mira la foto y confirma el número" se lee como *no hay foto*.
 *
 * Sin mime declarado se decide por la extensión y, a falta de las dos, se asume foto: es lo que
 * son casi todas, y equivocarse hacia el `<img>` es lo que ya hacía el panel del Radar.
 */
export function esImagenLeida(f: FotoLeida): boolean {
  const mime = (f.mime ?? "").toLowerCase().trim();
  if (mime.startsWith("image/")) return true;
  if (mime) return false;
  if (EXT_IMAGEN.test(f.url)) return true;
  if (EXT_DOC.test(f.url)) return false;
  return true;
}
