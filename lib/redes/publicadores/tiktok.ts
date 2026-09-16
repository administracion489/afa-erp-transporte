// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/publicadores/tiktok.ts — Content Posting API de TikTok.
//
// LA DECISIÓN QUE GOBIERNA ESTE ARCHIVO: SE SUBE A BORRADORES, NO SE PUBLICA DIRECTO,
// HASTA QUE TIKTOK AUDITE LA APP.
//
// TikTok tiene dos endpoints y dos permisos distintos:
//   • `/v2/post/publish/inbox/video/init/` (scope `video.upload`) deja el video en la
//     bandeja de BORRADORES de la cuenta. Llega una notificación al celular y una
//     persona le da publicar desde la app.
//   • `/v2/post/publish/video/init/` (scope `video.publish`) publica directo, y ese
//     scope **solo se activa cuando TikTok audita la app**.
//
// Una app sin auditar que llame al segundo recibe un error de permisos, o —peor— solo
// puede publicar en modo `SELF_ONLY`, o sea visible únicamente para el dueño de la
// cuenta: una publicación que parece que salió y que no ve nadie. Por eso el modo por
// defecto es el borrador, que SÍ funciona desde el día uno, y la publicación directa
// se enciende sola con una variable de entorno el día que aprueben la auditoría — sin
// tocar código. La `advertencia` del catálogo (lib/redes/tipos.ts) lo dice en pantalla.
//
// Y LA SEGUNDA DECISIÓN: SE MANDAN LOS BYTES (`FILE_UPLOAD`), NO LA URL.
// `PULL_FROM_URL` haría que TikTok descargara del bucket, que es más barato — pero
// exige tener el dominio VERIFICADO en el portal de TikTok, y el dominio de un bucket
// de Supabase no es de AFA y no se puede verificar. Con `FILE_UPLOAD` funciona sin
// ningún trámite de dominio.
// ──────────────────────────────────────────────────────────────────────────────

import { errorDe, leerRespuesta, type Publicador } from "./tipos";

const API = "https://open.tiktokapis.com/v2";

/** El caption de TikTok. Pasarse no es un error: lo recorta y se pierde el final. */
const MAX_CAPTION = 2200;

async function tokenDeAcceso(refresh: string): Promise<{ token?: string; error?: string }> {
  const key = process.env.TIKTOK_CLIENT_KEY;
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!key || !secret) return { error: "Faltan TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET en el entorno." };

  const res = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: key,
      client_secret: secret,
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });
  const { ok, json, texto } = await leerRespuesta(res);
  if (!ok || json?.error) return { error: errorDe(res, json, texto) };
  return { token: json?.access_token };
}

export const publicarTikTok: Publicador = async (cuenta, pieza) => {
  if (!cuenta.refresh) {
    return { ok: false, error: "La cuenta de TikTok no tiene refresh token guardado. Vuelve a conectarla." };
  }
  if (!pieza.media || pieza.media.tipo !== "video") {
    return { ok: false, error: "TikTok solo publica video." };
  }

  // Se enciende solo el día de la auditoría, sin desplegar nada.
  const directo = process.env.TIKTOK_PUBLICACION_DIRECTA === "1";

  try {
    const { token, error } = await tokenDeAcceso(cuenta.refresh);
    if (!token) return { ok: false, error: error ?? "No se pudo obtener el token de acceso de TikTok." };

    const resArchivo = await fetch(pieza.media.url);
    if (!resArchivo.ok) {
      return { ok: false, error: `No se pudo descargar el video del bucket (HTTP ${resArchivo.status}).` };
    }
    const bytes = new Uint8Array(await resArchivo.arrayBuffer());
    const total = bytes.byteLength;

    // ── Paso 1: init ──
    //
    // `chunk_size === total` + `total_chunk_count: 1` sube el archivo de una sola vez.
    // TikTok admite trocear, y no hace falta para un vertical de pocos MB: trocear
    // añadiría un bucle con estado que solo puede fallar de formas nuevas.
    const cuerpo: Record<string, unknown> = {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: total,
        chunk_size: total,
        total_chunk_count: 1,
      },
    };
    if (directo) {
      cuerpo.post_info = {
        title: pieza.texto.slice(0, MAX_CAPTION),
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      };
    }

    const ruta = directo ? `${API}/post/publish/video/init/` : `${API}/post/publish/inbox/video/init/`;
    const resInit = await fetch(ruta, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(cuerpo),
    });
    const init = await leerRespuesta(resInit);
    // TikTok devuelve HTTP 200 con el fallo DENTRO del cuerpo (`error.code !== "ok"`),
    // así que mirar solo `res.ok` daría por buena una subida que nunca ocurrió.
    if (!init.ok || (init.json?.error?.code && init.json.error.code !== "ok")) {
      return { ok: false, error: errorDe(resInit, init.json, init.texto) };
    }

    const subidaUrl = init.json?.data?.upload_url;
    const publishId = init.json?.data?.publish_id;
    if (!subidaUrl) return { ok: false, error: "TikTok no devolvió la URL de subida." };

    // ── Paso 2: los bytes ──
    // `Content-Range` es OBLIGATORIO aunque sea un solo trozo; sin él TikTok responde
    // un 400 que habla de rangos y no de lo que falta.
    const resSubir = await fetch(subidaUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(total),
        "Content-Range": `bytes 0-${total - 1}/${total}`,
      },
      body: bytes,
    });
    if (!resSubir.ok) {
      const { json, texto } = await leerRespuesta(resSubir);
      return { ok: false, error: errorDe(resSubir, json, texto) };
    }

    return {
      ok: true,
      id_externo: publishId,
      // NO se afirma que está publicado cuando fue a borradores: es la diferencia entre
      // «ya salió» y «alguien tiene que abrir la app». Callarlo dejaría el video sin
      // publicar y al operador creyendo que el canal se alimenta solo.
      nota: directo
        ? undefined
        : "Quedó en BORRADORES de TikTok: abre la app, revísalo y publícalo desde ahí. " +
          "La publicación directa se habilita cuando TikTok apruebe la auditoría de la app.",
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};
