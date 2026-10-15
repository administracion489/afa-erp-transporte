// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/server.ts — SOLO SERVIDOR. Cliente service-role + subida/firma del bucket PRIVADO
// `rrhh`. La foto de marcación y los documentos de ausencia traen rostro, ubicación y datos
// de salud: nunca un bucket público, nunca getPublicUrl. Se guarda la RUTA en la base y se
// firma al pintar (createSignedUrl), como manda lib/storage-privado.ts.
// ──────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { firmarUrl } from "@/lib/storage-firmado";

export const BUCKET_RRHH = "rrhh";

/** Cliente con privilegios. La service-role NUNCA llega al bundle del cliente. */
export function adminRrhh(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** base64 o dataURL (`data:<mt>;base64,<...>`) → {buf, mediaType}, o null si no es legible. */
export function leerAdjunto(adjunto: unknown): { buf: Buffer; mediaType: string } | null {
  if (typeof adjunto !== "string" || !adjunto) return null;
  let b64 = adjunto;
  let mediaType = "image/jpeg";
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(adjunto);
  if (m) { mediaType = m[1]; b64 = m[2]; }
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length ? { buf, mediaType } : null;
  } catch {
    return null;
  }
}

/** Extensión del archivo a partir del media type (para componer el path del documento). */
export function extDeMedia(mediaType: string): string {
  const mt = (mediaType || "").toLowerCase();
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("png")) return "png";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("heic") || mt.includes("heif")) return "heic";
  return "jpg";
}

/** Sube un adjunto al bucket privado `rrhh` en `path` y devuelve el path. Lanza si falla →
 *  el llamador decide si aborta o guarda la fila sin la foto (según el caso). */
export async function subirArrhh(admin: SupabaseClient, path: string, adjunto: unknown): Promise<string> {
  const img = leerAdjunto(adjunto);
  if (!img) throw new Error("adjunto inválido o vacío");
  const { error } = await admin.storage.from(BUCKET_RRHH).upload(path, img.buf, {
    contentType: img.mediaType,
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
