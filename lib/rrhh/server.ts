// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/server.ts — SOLO SERVIDOR. Cliente service-role + subida/firma del bucket PRIVADO
// `rrhh`. La foto de marcación y los documentos de ausencia traen rostro, ubicación y datos
// de salud: nunca un bucket público, nunca getPublicUrl. Se guarda la RUTA en la base y se
// firma al pintar (createSignedUrl), como manda lib/storage-privado.ts.
//
// TODA IMAGEN SE RE-ENCODEA EN EL SERVIDOR DESCARTANDO METADATOS antes de guardarse (Ley 29733):
// una foto de celular trae GPS/EXIF, y un rostro o un documento de salud no deben llevar la
// ubicación de quien los subió. El re-encode lo hace `sharp` (en la lista de paquetes externos
// de Next, así que corre con `require` nativo); si no estuviera disponible, un stripper puro por
// formato quita los segmentos/chunks de metadatos como defensa en profundidad. El TIPO guardado
// se DERIVA del contenido (magic bytes), no del `mediaType` que afirma el cliente — así un
// HTML/SVG disfrazado de imagen/documento no llega a Storage.
// ──────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { firmarUrl } from "@/lib/storage-firmado";

export const BUCKET_RRHH = "rrhh";

/** Tope del adjunto decodificado. Una foto de rostro o un documento de respaldo caben de sobra
 *  en 5 MB; por encima casi siempre es un archivo equivocado. */
export const MAX_ADJUNTO_BYTES = 5 * 1024 * 1024;

/** Para qué se sube: una FOTO solo admite imágenes; un DOCUMENTO de respaldo, además PDF. */
export type TipoAdjunto = "foto" | "documento";

/** El adjunto no se puede guardar por una razón del propio archivo (tipo, tamaño, contenido):
 *  el llamador la traduce a 400. Se distingue de un fallo de Storage (que NO pierde la marca). */
export class AdjuntoInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjuntoInvalido";
  }
}

/** Cliente con privilegios. La service-role NUNCA llega al bundle del cliente. */
export function adminRrhh(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** base64 o dataURL (`data:<mt>;base64,<...>`) → Buffer, o null si no es legible. Lanza
 *  `AdjuntoInvalido` si el binario supera `MAX_ADJUNTO_BYTES` (un rechazo deliberado, no un
 *  «no se pudo leer»). El `mediaType` del cliente se IGNORA: el tipo real se sniff-ea del buffer. */
export function leerAdjunto(adjunto: unknown): Buffer | null {
  if (typeof adjunto !== "string" || !adjunto) return null;
  let b64 = adjunto;
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(adjunto);
  if (m) b64 = m[1];
  if (!b64) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (!buf.length) return null;
  if (buf.length > MAX_ADJUNTO_BYTES) {
    throw new AdjuntoInvalido(`El archivo pesa más de ${Math.round(MAX_ADJUNTO_BYTES / (1024 * 1024))} MB. Reduce su tamaño y vuelve a intentarlo.`);
  }
  return buf;
}

type Formato = "jpeg" | "png" | "webp" | "pdf" | "otro";

/** El tipo REAL del archivo, por sus bytes de cabecera — nunca por lo que afirma el cliente. */
function sniff(buf: Buffer): Formato {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  return "otro";
}

const CT: Record<"jpeg" | "png" | "webp", string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const EXT: Record<"jpeg" | "png" | "webp", string> = { jpeg: "jpg", png: "png", webp: "webp" };

/**
 * Valida el adjunto contra la lista blanca del destino y lo deja listo para guardar:
 *  · PDF (solo en documentos) → pasa tal cual, con contentType forzado `application/pdf`.
 *  · imagen raster → se RE-ENCODEA descartando metadatos (GPS/EXIF/XMP).
 *  · cualquier otra cosa (HTML/SVG/…) → `AdjuntoInvalido` 400.
 * Devuelve el buffer saneado, el contentType y la extensión DERIVADOS, nunca los del cliente.
 */
async function sanearAdjunto(buf: Buffer, tipo: TipoAdjunto): Promise<{ buf: Buffer; contentType: string; ext: string }> {
  const fmt = sniff(buf);

  if (fmt === "pdf") {
    if (tipo !== "documento") {
      throw new AdjuntoInvalido("Para una foto solo se aceptan imágenes JPG, PNG o WEBP.");
    }
    return { buf, contentType: "application/pdf", ext: "pdf" };
  }

  if (fmt === "jpeg" || fmt === "png" || fmt === "webp") {
    const out = await reencodearImagen(buf, fmt);
    return { buf: out.buf, contentType: CT[out.formato], ext: EXT[out.formato] };
  }

  const permitidos = tipo === "documento" ? "PDF, JPG, PNG o WEBP" : "JPG, PNG o WEBP";
  throw new AdjuntoInvalido(`Tipo de archivo no permitido. Solo se aceptan: ${permitidos}.`);
}

/** Re-encodea una imagen descartando TODO metadato. Primario: `sharp` (re-encodea a JPEG y, con
 *  `.rotate()`, hornea la orientación EXIF y la descarta; sharp no conserva metadatos salvo que
 *  se pida). Defensa en profundidad si sharp no está o falla: stripper puro por formato. */
async function reencodearImagen(
  buf: Buffer,
  fmt: "jpeg" | "png" | "webp",
): Promise<{ buf: Buffer; formato: "jpeg" | "png" | "webp" }> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf, { failOn: "none" }).rotate().jpeg({ quality: 82 }).toBuffer();
    if (out.length) return { buf: out, formato: "jpeg" };
  } catch {
    // cae al stripper puro
  }
  try {
    if (fmt === "jpeg") return { buf: stripJpeg(buf), formato: "jpeg" };
    if (fmt === "png") return { buf: stripPng(buf), formato: "png" };
    return { buf: stripWebp(buf), formato: "webp" };
  } catch {
    throw new AdjuntoInvalido("No se pudo procesar la imagen. Prueba con otra foto.");
  }
}

/** JPEG: copia la cabecera y suelta todos los segmentos APPn (0xE0–0xEF) y COM (0xFE), que son los
 *  que llevan EXIF/JFIF/XMP/ICC/comentarios; al llegar a SOS (0xDA) copia el resto tal cual. */
function stripJpeg(buf: Buffer): Buffer {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("jpeg");
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) throw new Error("jpeg marcador");
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.subarray(i)); break; } // SOS → datos comprimidos hasta EOI
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); break; } // EOI
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2 || i + 2 + len > buf.length) throw new Error("jpeg longitud");
    const esMeta = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!esMeta) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return Buffer.concat(out);
}

const PNG_META = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/** PNG: conserva la firma y los chunks de imagen; suelta los chunks de metadatos (EXIF/texto/fecha). */
function stripPng(buf: Buffer): Buffer {
  if (buf.length < 8) throw new Error("png");
  const out: Buffer[] = [buf.subarray(0, 8)]; // firma
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const tipo = buf.toString("latin1", i + 4, i + 8);
    const fin = i + 12 + len; // len + tipo(4) + datos + crc(4)
    if (len < 0 || fin > buf.length) throw new Error("png chunk");
    if (!PNG_META.has(tipo)) out.push(buf.subarray(i, fin));
    i = fin;
    if (tipo === "IEND") break;
  }
  return Buffer.concat(out);
}

/** WEBP (RIFF): suelta los chunks EXIF y XMP, recalcula el tamaño RIFF y apaga las banderas
 *  EXIF/XMP del chunk VP8X si existe. Conserva los chunks de imagen (VP8/VP8L/VP8X/ALPH/ANIM/ANMF). */
function stripWebp(buf: Buffer): Buffer {
  if (buf.length < 12) throw new Error("webp");
  const cuerpo: Buffer[] = [];
  let i = 12; // "RIFF" + size(4) + "WEBP"
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const conPad = len + (len & 1); // los chunks RIFF se alinean a par
    const fin = i + 8 + conPad;
    if (len < 0 || fin > buf.length) throw new Error("webp chunk");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      const trozo = Buffer.from(buf.subarray(i, fin));
      if (fourcc === "VP8X" && trozo.length >= 9) trozo[8] &= ~0b00001100; // apaga EXIF (0x08) y XMP (0x04)
      cuerpo.push(trozo);
    }
    i = fin;
  }
  const datos = Buffer.concat(cuerpo);
  const cab = Buffer.from(buf.subarray(0, 12));
  cab.writeUInt32LE(4 + datos.length, 4); // tamaño RIFF = "WEBP" + chunks
  return Buffer.concat([cab, datos]);
}

/** Sube un adjunto SANEADO al bucket privado `rrhh`. `pathSinExt` es la ruta sin extensión: la
 *  extensión y el contentType los pone el saneo (derivados del contenido). Devuelve el path final.
 *  Lanza `AdjuntoInvalido` si el archivo no pasa la lista blanca / el tope de tamaño (→ 400 arriba),
 *  o un Error genérico si falla Storage (el llamador decide si guarda la fila sin el archivo). */
export async function subirArrhh(
  admin: SupabaseClient,
  pathSinExt: string,
  adjunto: unknown,
  tipo: TipoAdjunto,
): Promise<string> {
  const buf = leerAdjunto(adjunto);
  if (!buf) throw new AdjuntoInvalido("Adjunto inválido o vacío.");
  const limpio = await sanearAdjunto(buf, tipo);
  const path = `${pathSinExt}.${limpio.ext}`;
  const { error } = await admin.storage.from(BUCKET_RRHH).upload(path, limpio.buf, {
    contentType: limpio.contentType,
    upsert: true,
  });
  if (error) throw new Error("subir_rrhh: " + error.message);
  return path;
}

/** Firma un valor guardado en la base: una RUTA desnuda del bucket `rrhh`, o un enlace completo
 *  (que se re-firma con lib/storage-firmado). null/vacío → null. Si firmar falla, devuelve el
 *  valor tal cual (nunca esconde el archivo), salvo que ni siquiera se pueda firmar la ruta. */
export async function firmarRutaRrhh(admin: SupabaseClient, valor: unknown): Promise<string | null> {
  if (typeof valor !== "string" || !valor) return null;
  if (/^https?:\/\//i.test(valor)) return firmarUrl(admin, valor);
  try {
    const { data } = await admin.storage.from(BUCKET_RRHH).createSignedUrl(valor, 3600);
    return data?.signedUrl ?? valor;
  } catch {
    return valor;
  }
}
