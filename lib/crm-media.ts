// Media de WhatsApp (fotos, stickers, audios, documentos) para el CRM.
//
// La Cloud API NO manda la foto en el webhook: manda un id. Hay que pedir a Graph la URL
// (que caduca en minutos y exige el token) y bajar el archivo. Antes nadie lo hacía, así
// que el CRM pintaba «[sticker]» / «[image]» y la IA contestaba «no puedo ver las imágenes».
// Se guarda en el bucket PRIVADO `crm-media` y en la base queda el enlace público como
// IDENTIFICADOR (regla de lib/storage-privado.ts): quien lo muestra lo firma.
//
// Solo servidor (usa el token de WhatsApp y la service-role).
import type { SupabaseClient } from "@supabase/supabase-js";
import { tokenParaNumero } from "@/lib/meta-tokens";
import { objetoPrivadoDe } from "@/lib/storage-privado";

const GRAPH = "https://graph.facebook.com/v25.0";
export const BUCKET_CRM_MEDIA = "crm-media";
const MAX_BYTES = 16 * 1024 * 1024;
const TIPOS_CON_MEDIA = new Set(["image", "sticker", "audio", "video", "document", "voice"]);

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};

// A qué hosts se les puede mandar el token de WhatsApp: SOLO a Meta, por host EXACTO o subdominio.
// Antes se decidía con un regex sin anclar («contiene fbsbx.com»), así que una media_url como
// «https://otro-sitio.tld/?fbsbx.com» recibía el token de los números oficiales.
const HOSTS_MEDIA_META = ["fbsbx.com", "whatsapp.net"];
const HOSTS_CDN_META = ["fbcdn.net", "fbsbx.com", "whatsapp.net"];
function hostDe(url: string | null | undefined, dominios: string[]): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  return dominios.some((d) => h === d || h.endsWith(`.${d}`));
}
/** ¿Es un enlace de media de Meta (el único sitio al que va el token)? */
export const esUrlMediaMeta = (url: string | null | undefined) => hostDe(url, HOSTS_MEDIA_META);

/** Baja un archivo de Meta con el token. La redirección (si la hay) se sigue UNA vez, SIN el
 *  token y solo hacia Meta: el token no sale nunca hacia otro host. */
async function bajarDeMeta(url: string, token: string, ms: number): Promise<Response | null> {
  if (!esUrlMediaMeta(url)) return null;
  let res = await conTope(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" }, ms);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    let destino: string | null = null;
    try { destino = loc ? new URL(loc, url).toString() : null; } catch { destino = null; }
    if (!destino || !hostDe(destino, HOSTS_CDN_META)) return null;
    res = await conTope(destino, { redirect: "error" }, ms);
  }
  return res.ok ? res : null;
}

let bucketListo = false;
export async function asegurarBucket(sb: SupabaseClient) {
  if (bucketListo) return;
  const { error } = await sb.storage.createBucket(BUCKET_CRM_MEDIA, { public: false });
  if (error && !/exist/i.test(error.message)) console.error("[crm-media] bucket:", error.message);
  bucketListo = true;
}

async function conTope(url: string, init: RequestInit, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

/** Baja la media de un mensaje de WhatsApp y la guarda. null si no trae media o falla
 *  (nunca lanza: un webhook no puede perder el mensaje por una foto). */
export async function guardarMediaWhatsApp(
  sb: SupabaseClient,
  msg: any,
  phoneNumberId: string | null | undefined,
): Promise<{ url: string; mime: string } | null> {
  try {
    const tipo = String(msg?.type ?? "");
    if (!TIPOS_CON_MEDIA.has(tipo)) return null;
    const mediaId: string | undefined = msg?.[tipo]?.id;
    if (!mediaId) return null;
    const token = (await tokenParaNumero(phoneNumberId ?? undefined)) ?? process.env.META_WA_TOKEN;
    if (!token) return null;
    const auth = { Authorization: `Bearer ${token}` };

    const info = await conTope(`${GRAPH}/${mediaId}`, { headers: auth });
    if (!info.ok) { console.error("[crm-media] info", info.status); return null; }
    const meta: any = await info.json();
    if (!meta?.url || (meta.file_size && meta.file_size > MAX_BYTES)) return null;

    const bin = await bajarDeMeta(String(meta.url), token, 30000);
    if (!bin) { console.error("[crm-media] descarga: no se pudo bajar de Meta"); return null; }
    const buf = Buffer.from(await bin.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    const mime = String(meta.mime_type ?? msg?.[tipo]?.mime_type ?? "application/octet-stream").split(";")[0].trim();

    await asegurarBucket(sb);
    const ruta = `${new Date().toISOString().slice(0, 7)}/${mediaId}.${EXT[mime] ?? "bin"}`;
    const { error } = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, buf, { contentType: mime, upsert: true });
    if (error) { console.error("[crm-media] upload:", error.message); return null; }
    return { url: sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl, mime };
  } catch (e: any) {
    console.error("[crm-media]", e?.message ?? e);
    return null;
  }
}

const IMAGEN_IA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Bloque para Claude con la foto o el PDF guardado (base64). null si no se puede leer.
 * `opts.buckets`: solo esos buckets privados (por defecto, cualquiera de BUCKETS_PRIVADOS);
 * `opts.maxPdfBytes`: el tope de un PDF (por defecto 10 MB). Sin opciones, lo de siempre.
 */
export async function bloqueParaIA(
  sb: SupabaseClient, url: string | null | undefined, opts: { buckets?: readonly string[]; maxPdfBytes?: number } = {},
): Promise<any | null> {
  const obj = objetoPrivadoDe(url);
  if (!obj) return null;
  if (opts.buckets && !opts.buckets.includes(obj.bucket)) return null;
  try {
    const { data, error } = await sb.storage.from(obj.bucket).download(obj.ruta);
    if (error || !data) return null;
    const mime = (data.type || "").split(";")[0];
    const buf = Buffer.from(await data.arrayBuffer());
    if (IMAGEN_IA.has(mime) && buf.length <= 4.5 * 1024 * 1024)
      return { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } };
    if (mime === "application/pdf" && buf.length <= (opts.maxPdfBytes ?? 10 * 1024 * 1024))
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
    return null;
  } catch { return null; }
}

/** Un mensaje viejo guardó la URL de Meta (lookaside.fbsbx.com), que solo abre con el
 *  token: se baja una vez con él y queda en el bucket. null si ya no se puede. */
export async function rescatarUrlMeta(
  sb: SupabaseClient,
  url: string,
  phoneNumberId: string | null | undefined,
  clave: string,
): Promise<string | null> {
  try {
    if (!esUrlMediaMeta(url)) return null;
    const token = (await tokenParaNumero(phoneNumberId ?? undefined)) ?? process.env.META_WA_TOKEN;
    if (!token) return null;
    const res = await bajarDeMeta(url, token, 30000);
    if (!res) return null;
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    if (/text\/html|json/.test(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    await asegurarBucket(sb);
    const ruta = `rescate/${clave}.${EXT[mime] ?? "bin"}`;
    const { error } = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, buf, { contentType: mime, upsert: true });
    if (error) return null;
    return sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
  } catch { return null; }
}
