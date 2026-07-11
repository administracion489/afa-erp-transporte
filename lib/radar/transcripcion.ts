// lib/radar/transcripcion.ts — Transcripción opcional de notas de voz del Radar IA (SOLO servidor).
//
// Usa la API de OpenAI (whisper-1) SOLO si OPENAI_API_KEY está configurada; si no,
// devuelve null y el motor descarta la nota de voz como "sin_transcripcion".
// Nunca lanza: cualquier error se loguea con console.warn y devuelve null, para que
// una nota de voz corrupta jamás tumbe el pipeline.

/** Mapea el mime de WhatsApp a una extensión de archivo que Whisper reconozca. */
function extensionDe(mime: string | null): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg"; // las notas de voz de WhatsApp son audio/ogg; codecs=opus
}

/**
 * Descarga la nota de voz desde su URL pública (bucket radar-media) y la transcribe
 * con whisper-1 en español. Devuelve el texto, o null si no hay proveedor configurado
 * o si algo falla.
 */
export async function transcribirAudio(mediaUrl: string, mime: string | null): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!mediaUrl) return null;

  try {
    // 1) Bajar los bytes del audio desde el bucket público
    const audio = await fetch(mediaUrl);
    if (!audio.ok) {
      console.warn("[radar/transcripcion] No se pudo descargar el audio:", audio.status, mediaUrl);
      return null;
    }
    const bytes = await audio.arrayBuffer();
    if (!bytes.byteLength) {
      console.warn("[radar/transcripcion] Audio vacío:", mediaUrl);
      return null;
    }

    // 2) Enviar a la API de transcripciones (multipart/form-data con fetch nativo)
    const tipo = mime || "audio/ogg";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: tipo }), `nota-de-voz.${extensionDe(mime)}`);
    form.append("model", "whisper-1");
    form.append("language", "es");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!resp.ok) {
      const detalle = await resp.text().catch(() => "");
      console.warn("[radar/transcripcion] Whisper respondió", resp.status, detalle.slice(0, 300));
      return null;
    }

    const json: any = await resp.json();
    const texto = String(json?.text ?? "").trim();
    return texto || null;
  } catch (e: any) {
    console.warn("[radar/transcripcion] Error transcribiendo:", e?.message ?? e);
    return null;
  }
}
