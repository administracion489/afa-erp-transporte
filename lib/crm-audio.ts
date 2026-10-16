// Notas de voz del CRM → texto (Whisper). Solo servidor.
//
// La transcripción se GUARDA en crm_mensajes.contenido con el prefijo «🎤 »: así el equipo la
// lee bajo el reproductor y la IA la recibe como texto, sin volver a pagar Whisper en cada
// respuesta. Sin OPENAI_API_KEY no se transcribe nada y el mensaje queda como estaba.
import type { SupabaseClient } from "@supabase/supabase-js";
import { objetoPrivadoDe } from "@/lib/storage-privado";
import { transcribirBytes } from "@/lib/radar/transcripcion";

export const PREFIJO_TRANSCRIPCION = "🎤 ";
const TIPOS_AUDIO = new Set(["audio", "voice"]);
const MAX_BYTES_WHISPER = 24 * 1024 * 1024; // Whisper acepta hasta 25 MB

export const esAudio = (tipo?: string | null) => TIPOS_AUDIO.has(String(tipo ?? ""));
export const esTranscripcion = (t?: string | null) => !!t && t.startsWith(PREFIJO_TRANSCRIPCION);
export const transcripcionDisponible = () => !!process.env.OPENAI_API_KEY;

/** Baja el audio del bucket privado y lo transcribe. null si no se puede. Nunca lanza. */
export async function transcribirAudioGuardado(sb: SupabaseClient, url: string | null | undefined): Promise<string | null> {
  if (!transcripcionDisponible()) return null;
  const obj = objetoPrivadoDe(url);
  if (!obj) return null;
  try {
    const { data, error } = await sb.storage.from(obj.bucket).download(obj.ruta);
    if (error || !data) return null;
    const buf = new Uint8Array(await data.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES_WHISPER) return null;
    return await transcribirBytes(buf, (data.type || "audio/ogg").split(";")[0]);
  } catch {
    return null;
  }
}

/** Transcribe y guarda en el mensaje. Si el audio traía texto propio (no un «[audio]»),
 *  no se pisa. Devuelve el contenido nuevo o null. */
export async function transcribirMensaje(
  sb: SupabaseClient,
  filtro: { id?: string; meta_message_id?: string },
  url: string | null | undefined,
  contenidoActual?: string | null,
): Promise<string | null> {
  if (contenidoActual && !/^\[[a-z_]+\]$/i.test(contenidoActual.trim())) return null;
  const texto = await transcribirAudioGuardado(sb, url);
  if (!texto) return null;
  const contenido = `${PREFIJO_TRANSCRIPCION}${texto}`;
  let q = sb.from("crm_mensajes").update({ contenido });
  if (filtro.id) q = q.eq("id", filtro.id);
  else if (filtro.meta_message_id) q = q.eq("meta_message_id", filtro.meta_message_id);
  else return contenido;
  const { error } = await q;
  if (error) console.warn("[crm-audio] no se guardó la transcripción:", error.message);
  return contenido;
}
