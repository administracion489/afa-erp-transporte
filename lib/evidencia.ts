// lib/evidencia.ts — El RESPALDO de un registro tecleado a mano: la foto del tablero, el voucher del
// grifo o la constancia que lo sustenta. Módulo casi PURO: la única función que toca Storage recibe
// el cliente inyectado (igual que `registrarLectura`), así que la matriz la prueba con uno falso.
//
// POR QUÉ EXISTE. Una carga de combustible tecleada en /combustible no guardaba ningún papel, y el
// odómetro manual de /mantenimiento y de /tercerizadas aceptaba una foto que, si la subida fallaba,
// se perdía EN SILENCIO (`if (!up.error) fotoUrl = …`): la lectura quedaba registrada como si nunca
// hubiera tenido foto, y nadie se enteraba de que el respaldo no existía. Tres reglas:
//
//  1. ES OPCIONAL, PERO NO SE PIERDE CALLADO. Si un archivo no sube, quien registra decide si guarda
//     sin él —y sabe cuál falló—. Una evidencia que parece adjunta y no está es peor que ninguna: el
//     día que alguien la busca para resolver una discrepancia, no aparece.
//  2. EL TIPO SE JUZGA ANTES DE SUBIR, con el motivo escrito. Un .heic de iPhone o un Word no se
//     pueden ver en el ERP; subirlos y descubrirlo al abrirlos es haber perdido el respaldo.
//  3. VOUCHER Y CONSTANCIA VAN AL BUCKET PRIVADO `documentos`. Un voucher trae placa, grifo, importe
//     y RUC: el mismo criterio que puso `comprobantes` y `radar-media` en privado. Se guarda el enlace
//     público como IDENTIFICADOR del archivo (lib/storage-privado.ts) y la pantalla lo firma al
//     pintarlo con <ImgPrivada>/<EnlacePrivado>. La foto del tablero sigue en `vehiculos-fotos`,
//     que es donde viven todas las fotos de odómetro y lo que compara `registrarLectura` por URL.

/** Qué es el archivo para quien lo mira. No decide nada del dinero: solo cómo se rotula. */
export type ClaseEvidencia = "voucher" | "tablero" | "constancia";

/** Lo que se guarda por archivo (jsonb). La URL es el identificador; se firma al pintarla. */
export type Evidencia = {
  url: string;
  nombre: string;
  mime: string;
  clase: ClaseEvidencia;
};

export const ETIQUETA_CLASE: Record<ClaseEvidencia, string> = {
  voucher: "Voucher",
  tablero: "Tablero (odómetro)",
  constancia: "Constancia",
};

/** El mismo tope que ya aplicaban la lectura con IA y la jornada a mano. */
export const MAX_BYTES_EVIDENCIA = 20 * 1024 * 1024;
/** Cuántos archivos por registro. No está medido: es para que nadie suba el carrete entero. */
export const MAX_EVIDENCIAS = 5;

const IMAGENES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const PDF = "application/pdf";

export type ArchivoLike = { name: string; type: string; size: number };

export type Revision = { ok: true; esImagen: boolean } | { ok: false; motivo: string };

/** El tipo real del archivo: el navegador a veces no lo informa (Android con algunos gestores). */
export function mimeDe(a: ArchivoLike): string {
  const t = (a.type || "").toLowerCase();
  if (t) return t;
  const ext = (a.name.split(".").pop() || "").toLowerCase();
  return ext === "pdf" ? PDF
    : ext === "png" ? "image/png"
    : ext === "webp" ? "image/webp"
    : ext === "gif" ? "image/gif"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "heic" || ext === "heif" ? "image/heic"
    : "";
}

/**
 * ¿Se puede guardar como respaldo? `soloImagen` es para el odómetro: su foto se pinta como
 * miniatura en seis pantallas y un PDF ahí sería un recuadro roto.
 */
export function revisarArchivo(a: ArchivoLike, opts: { soloImagen?: boolean } = {}): Revision {
  if (!a || !(a.size > 0)) return { ok: false, motivo: "el archivo está vacío" };
  if (a.size > MAX_BYTES_EVIDENCIA) {
    return { ok: false, motivo: `pesa ${(a.size / 1024 / 1024).toFixed(1)} MB y el máximo es 20 MB` };
  }
  const m = mimeDe(a);
  if (IMAGENES.includes(m)) return { ok: true, esImagen: true };
  if (m === "image/heic" || m === "image/heif") {
    return { ok: false, motivo: "es HEIC (formato de iPhone) y el navegador no lo muestra: tómala en JPG o envíala por WhatsApp y descárgala" };
  }
  if (m === PDF) {
    return opts.soloImagen
      ? { ok: false, motivo: "aquí va una FOTO (JPG o PNG); si la constancia es un PDF, tómale una foto" }
      : { ok: true, esImagen: false };
  }
  return { ok: false, motivo: opts.soloImagen ? "no es una imagen (usa JPG, PNG o WEBP)" : "no es imagen ni PDF" };
}

/** Ruta dentro del bucket: carpeta / marca de tiempo + azar / nombre limpio. Nunca pisa otra. */
export function rutaEvidencia(carpeta: string, nombre: string, ahoraMs: number, azar: string): string {
  const ext = (nombre.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const base = nombre.replace(/\.[^.]*$/, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "archivo";
  const dir = carpeta.replace(/^\/+|\/+$/g, "");
  return `${dir}/${ahoraMs}-${azar}-${base}.${ext}`;
}

/** Lee lo guardado en jsonb sin confiar en su forma: lo que no tiene URL no es una evidencia. */
export function normalizarEvidencias(v: unknown): Evidencia[] {
  if (!Array.isArray(v)) return [];
  const out: Evidencia[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!url) continue;
    const clase: ClaseEvidencia = o.clase === "tablero" || o.clase === "constancia" ? o.clase : "voucher";
    out.push({
      url,
      nombre: typeof o.nombre === "string" && o.nombre ? o.nombre : "archivo",
      mime: typeof o.mime === "string" ? o.mime : "",
      clase,
    });
  }
  return out;
}

export const esImagenEvidencia = (e: Pick<Evidencia, "mime" | "url">): boolean =>
  e.mime ? e.mime.startsWith("image/") : /\.(jpe?g|png|webp|gif)(\?|$)/i.test(e.url);

/** La foto del tablero de una carga, si la hay: es la que acompaña a su lectura de odómetro. */
export function fotoDeTablero(evs: readonly Evidencia[]): string | null {
  return evs.find((e) => e.clase === "tablero" && esImagenEvidencia(e))?.url ?? null;
}

// ── Subida (cliente inyectado) ───────────────────────────────────────────────────

/** Lo único de Storage que se usa: así la matriz lo prueba con un cliente falso. */
type BucketCliente = {
  upload: (ruta: string, archivo: unknown, opts?: Record<string, unknown>) => Promise<{ error: { message?: string } | null } | null | undefined>;
  getPublicUrl: (ruta: string) => { data?: { publicUrl?: string } } | null | undefined;
  remove?: (rutas: string[]) => Promise<unknown>;
};
export type StorageCliente = { storage: { from: (bucket: string) => BucketCliente } };

export type PorSubir = { archivo: ArchivoLike; clase: ClaseEvidencia };
export type ResultadoSubida = { subidas: Evidencia[]; fallidas: { nombre: string; motivo: string }[] };

/** Bucket por clase: el tablero con las demás fotos de odómetro; el resto, privado. */
export const bucketDe = (clase: ClaseEvidencia): string => (clase === "tablero" ? "vehiculos-fotos" : "documentos");

/**
 * Sube cada archivo y dice cuáles fallaron y por qué. No lanza: quien llama decide qué hacer con
 * los que no subieron (preguntar si guarda sin ellos). Un archivo que no pasa `revisarArchivo` no
 * se intenta.
 */
export async function subirEvidencias(
  client: StorageCliente,
  porSubir: readonly PorSubir[],
  carpeta: string,
  opts: { ahora?: () => number; azar?: () => string } = {},
): Promise<ResultadoSubida> {
  const ahora = opts.ahora ?? (() => Date.now());
  const azar = opts.azar ?? (() => Math.random().toString(36).slice(2, 8));
  const subidas: Evidencia[] = [];
  const fallidas: { nombre: string; motivo: string }[] = [];
  for (const { archivo, clase } of porSubir) {
    const nombre = archivo.name || "archivo";
    const rev = revisarArchivo(archivo, { soloImagen: clase === "tablero" });
    if (!rev.ok) { fallidas.push({ nombre, motivo: rev.motivo }); continue; }
    const bucket = bucketDe(clase);
    const ruta = rutaEvidencia(carpeta, nombre, ahora(), azar());
    const mime = mimeDe(archivo);
    try {
      const up = await client.storage.from(bucket).upload(ruta, archivo, { upsert: false, contentType: mime || undefined });
      if (up?.error) { fallidas.push({ nombre, motivo: up.error.message || "no se pudo subir" }); continue; }
      const url = client.storage.from(bucket).getPublicUrl(ruta)?.data?.publicUrl;
      if (!url) { fallidas.push({ nombre, motivo: "no se obtuvo su enlace" }); continue; }
      subidas.push({ url, nombre, mime, clase });
    } catch (e: unknown) {
      fallidas.push({ nombre, motivo: e instanceof Error ? e.message : "sin conexión" });
    }
  }
  return { subidas, fallidas };
}

/** Si quien registra decide NO guardar, lo ya subido se retira (best-effort): nadie lo enlazaría. */
export async function retirarSubidas(client: StorageCliente, subidas: readonly Evidencia[]): Promise<void> {
  const porBucket = new Map<string, string[]>();
  for (const e of subidas) {
    const m = e.url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const ruta = decodeURI(m[2]);
    porBucket.set(m[1], [...(porBucket.get(m[1]) ?? []), ruta]);
  }
  for (const [bucket, rutas] of porBucket) {
    try { await client.storage.from(bucket).remove?.(rutas); } catch { /* best-effort */ }
  }
}

/** La pregunta que se le hace a quien registra cuando algo no subió. Una sola redacción. */
export function preguntaSinRespaldo(fallidas: readonly { nombre: string; motivo: string }[], que: string): string {
  const lista = fallidas.map((f) => `• ${f.nombre}: ${f.motivo}`).join("\n");
  return `No se pudo adjuntar ${fallidas.length === 1 ? "este archivo" : `${fallidas.length} archivos`}:\n${lista}\n\n` +
    `¿Guardar ${que} SIN ${fallidas.length === 1 ? "él" : "ellos"}? (Cancelar = no guardar nada y volver a intentarlo)`;
}
