// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/publicadores/youtube.ts — Subida a YouTube (Data API v3).
//
// TRES COSAS QUE NO SE PARECEN AL RESTO DE PLATAFORMAS Y QUE HAY QUE TENER ESCRITAS:
//
// 1. EL TOKEN DE ACCESO DE GOOGLE DURA UNA HORA. Lo que se guarda y sirve es el
//    REFRESH token; el de acceso se pide antes de cada subida. Guardar el de acceso
//    «porque funcionó al conectar» produce un módulo que publica el primer día y falla
//    todos los demás con un 401 — el fallo más confuso posible, porque la cuenta figura
//    conectada y el operador ya vio que funcionaba.
//
// 2. LA SUBIDA ES EN DOS LLAMADAS (*resumable*). La primera manda los METADATOS y
//    devuelve una URL en la cabecera `Location`; la segunda manda los BYTES a esa URL.
//    No hay forma de mandar un `video_url` para que YouTube lo descargue, como hace
//    Meta: aquí el ERP tiene que bajar el archivo y volver a subirlo.
//
// 3. LA CUOTA. `videos.insert` cuesta 1 600 unidades y el proyecto trae 10 000 al día:
//    SEIS subidas diarias. El motor ya lo frena con `cuota_agotada` (`maxPorDia: 6` en
//    el catálogo) para no gastar la séptima llamada, pero el 403 `quotaExceeded` se
//    traduce igual aquí, porque la cuota la comparte todo el proyecto de Google y algo
//    fuera del ERP puede haberla consumido.
//
// Y UNA ADVERTENCIA QUE NO ES DE CÓDIGO: mientras la app de Google no pase la
// verificación OAuth, YouTube fuerza a PRIVADO todo lo que suba la API, y los refresh
// token de una app «en pruebas» caducan a los 7 días. Eso no se arregla programando.
// Por eso `privacyStatus` es configurable y la respuesta DICE en qué quedó.
// ──────────────────────────────────────────────────────────────────────────────

import { errorDe, leerRespuesta, type Publicador } from "./tipos";

const OAUTH = "https://oauth2.googleapis.com/token";
const SUBIDA = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Tope del título de YouTube. Pasarse es un 400. */
const MAX_TITULO = 100;

/**
 * Canjea el refresh token por uno de acceso.
 *
 * Reusa `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, las mismas que ya usa el Gmail del
 * CRM: es el mismo proyecto de Google Cloud y tener dos pares de credenciales para el
 * mismo proyecto es cómo se revoca el que no era.
 */
async function tokenDeAcceso(refresh: string): Promise<{ token?: string; error?: string }> {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return { error: "Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en el entorno." };

  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const { ok, json, texto } = await leerRespuesta(res);
  if (!ok) {
    // `invalid_grant` es el caso de los 7 días: el refresh caducó porque la app sigue
    // sin verificar. Se nombra explícitamente porque el mensaje de Google no lo explica
    // y `esCredencialMuerta` lo va a leer para marcar la cuenta.
    const detalle = json?.error === "invalid_grant"
      ? "invalid_grant — el refresh token caducó o fue revocado. Si la app de Google sigue " +
        "en modo de prueba, esto pasa cada 7 días: hay que volver a conectar YouTube."
      : errorDe(res, json, texto);
    return { error: detalle };
  }
  return { token: json?.access_token };
}

export const publicarYouTube: Publicador = async (cuenta, pieza) => {
  if (!cuenta.refresh) {
    return { ok: false, error: "La cuenta de YouTube no tiene refresh token guardado. Vuelve a conectarla." };
  }
  if (!pieza.media || pieza.media.tipo !== "video") {
    return { ok: false, error: "YouTube solo publica video." };
  }

  try {
    const { token, error } = await tokenDeAcceso(cuenta.refresh);
    if (!token) return { ok: false, error: error ?? "No se pudo obtener el token de acceso de Google." };

    // ── Bajar el archivo ──
    // YouTube no descarga desde una URL: hay que mandarle los bytes. Con un Reel de
    // pocos MB esto cabe de sobra en memoria; un video largo no, y por eso el tamaño se
    // mide y se dice, en vez de dejar que la función muera sin explicación.
    const resArchivo = await fetch(pieza.media.url);
    if (!resArchivo.ok) {
      return { ok: false, error: `No se pudo descargar el video del bucket (HTTP ${resArchivo.status}).` };
    }
    const bytes = new Uint8Array(await resArchivo.arrayBuffer());
    const tipoMime = resArchivo.headers.get("content-type") || "video/mp4";

    // ── Paso 1: metadatos ──
    const titulo = (pieza.titulo || primeraLinea(pieza.texto) || "AFA Transportes").slice(0, MAX_TITULO);
    const resInit = await fetch(`${SUBIDA}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": tipoMime,
        "X-Upload-Content-Length": String(bytes.byteLength),
      },
      body: JSON.stringify({
        snippet: {
          title: titulo,
          description: pieza.texto,
          // 22 = «People & Blogs». Es la categoría más neutra que acepta cualquier
          // canal; una categoría inválida es un 400 que no dice cuál usar.
          categoryId: "22",
        },
        status: {
          // `public` es lo que se pide; YouTube lo forzará a `private` si la app no
          // está verificada, y eso se comprueba abajo leyendo lo que DEVOLVIÓ.
          privacyStatus: process.env.YOUTUBE_PRIVACIDAD || "public",
          selfDeclaredMadeForKids: false,
        },
      }),
    });

    if (!resInit.ok) {
      const { json, texto } = await leerRespuesta(resInit);
      return { ok: false, error: errorDe(resInit, json, texto) };
    }

    const destino = resInit.headers.get("location");
    if (!destino) return { ok: false, error: "Google no devolvió la URL de subida (cabecera Location)." };

    // ── Paso 2: los bytes ──
    const resSubir = await fetch(destino, {
      method: "PUT",
      headers: { "Content-Type": tipoMime, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    const subir = await leerRespuesta(resSubir);
    if (!subir.ok) return { ok: false, error: errorDe(resSubir, subir.json, subir.texto) };

    const id = subir.json?.id;
    // NO se afirma que está público: se lee lo que YouTube dice que hizo. Afirmarlo
    // dejaría al operador esperando visitas en un video que nadie puede ver.
    const privacidad = subir.json?.status?.privacyStatus;
    const nota =
      privacidad && privacidad !== "public"
        ? `YouTube lo publicó como «${privacidad}», no público. Mientras la app de Google no ` +
          `pase la verificación OAuth, la API solo puede subir videos privados.`
        : undefined;

    return {
      ok: true,
      id_externo: id,
      url: id ? `https://youtu.be/${id}` : undefined,
      nota,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

/** El título sale de la primera línea del texto cuando nadie escribió uno. */
function primeraLinea(texto: string): string {
  return (texto.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}
