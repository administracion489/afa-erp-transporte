// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/publicadores/meta.ts — Facebook (Página) e Instagram.
//
// Van juntos porque son la MISMA API (Graph) con el mismo token de Página, y porque
// una cuenta de Instagram profesional cuelga de una Página de Facebook: separarlos en
// dos archivos duplicaría la versión de la API, el manejo de errores y la URL base, y
// el día que Meta suba de versión uno de los dos se quedaría atrás.
//
// LA DIFERENCIA QUE IMPORTA ENTRE LOS DOS
// Facebook publica en UNA llamada. Instagram publica en DOS, y entre ellas hay una
// espera: se crea un «contenedor» con la pieza, Meta la descarga y la procesa, y solo
// cuando el contenedor está `FINISHED` se puede publicar. Con una imagen es casi
// instantáneo; con un Reel son decenas de segundos. Tratar Instagram como Facebook —
// publicar el contenedor recién creado— falla con un error que dice «Media ID is not
// available», que no se parece en nada a la causa.
//
// EL `v25.0` NO ES DECORACIÓN. Meta jubila versiones: una llamada sin versión usa la
// más antigua viva y deja de funcionar sin aviso. Se hereda de `lib/crm-meta.ts`, que
// ya habla con esta misma API — dos constantes de versión distintas en el mismo repo
// significan que un día la mitad del ERP habla una versión y la otra mitad otra.
// ──────────────────────────────────────────────────────────────────────────────

import { errorDe, esperar, leerRespuesta, type Publicador } from "./tipos";

const GRAPH = "https://graph.facebook.com/v25.0";
// Las subidas de video van a otro host. Mandarlas al normal devuelve un error genérico.
const GRAPH_VIDEO = "https://graph-video.facebook.com/v25.0";

// ── Facebook ──────────────────────────────────────────────────────────────────

export const publicarFacebook: Publicador = async (cuenta, pieza) => {
  const pageId = cuenta.cuenta_externa_id;
  const token = cuenta.token;
  if (!pageId || !token) return { ok: false, error: "La Página no tiene id o token guardados." };

  try {
    // Tres endpoints, uno por forma de contenido. Facebook es la única salida que
    // publica texto solo, y por eso es la única con la rama `/feed`.
    if (!pieza.media) {
      const res = await fetch(`${GRAPH}/${pageId}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: pieza.texto, access_token: token }),
      });
      const { ok, json, texto } = await leerRespuesta(res);
      if (!ok) return { ok: false, error: errorDe(res, json, texto) };
      return { ok: true, id_externo: json?.id, url: enlaceFb(json?.id) };
    }

    if (pieza.media.tipo === "imagen") {
      // `url` = Meta DESCARGA la imagen desde ahí. Por eso el bucket es público y por
      // eso el motor frena antes con `media_no_publica`.
      const res = await fetch(`${GRAPH}/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pieza.media.url, caption: pieza.texto, access_token: token }),
      });
      const { ok, json, texto } = await leerRespuesta(res);
      if (!ok) return { ok: false, error: errorDe(res, json, texto) };
      // `post_id` es el post del muro; `id` es la foto. Para enlazar sirve el primero.
      return { ok: true, id_externo: json?.post_id ?? json?.id, url: enlaceFb(json?.post_id ?? json?.id) };
    }

    const res = await fetch(`${GRAPH_VIDEO}/${pageId}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: pieza.media.url, description: pieza.texto, access_token: token }),
    });
    const { ok, json, texto } = await leerRespuesta(res);
    if (!ok) return { ok: false, error: errorDe(res, json, texto) };
    return {
      ok: true,
      id_externo: json?.id,
      // El video queda procesándose en Facebook: el id ya existe pero el post puede
      // tardar en verse. Decirlo evita que alguien lo dé por perdido y vuelva a subirlo.
      nota: "Facebook está procesando el video; puede tardar unos minutos en verse en la Página.",
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

function enlaceFb(id?: string): string | undefined {
  return id ? `https://www.facebook.com/${id}` : undefined;
}

// ── Instagram ─────────────────────────────────────────────────────────────────

/** Cuánto se espera a que Meta termine de procesar un contenedor de video. */
const INTENTOS_CONTENEDOR = 12;
const ESPERA_CONTENEDOR_MS = 4000; // 12 × 4 s ≈ 48 s, dentro del maxDuration de la ruta

export const publicarInstagram: Publicador = async (cuenta, pieza) => {
  const igId = cuenta.cuenta_externa_id;
  const token = cuenta.token;
  if (!igId || !token) return { ok: false, error: "La cuenta de Instagram no tiene id o token guardados." };
  // El motor ya lo garantiza (`falta_media`); esto es el cinturón por si alguien llama
  // al publicador directamente desde otra puerta.
  if (!pieza.media) return { ok: false, error: "Instagram no publica sin imagen ni video." };

  try {
    // ── Paso 1: crear el contenedor ──
    const cuerpo: Record<string, string> =
      pieza.media.tipo === "imagen"
        ? { image_url: pieza.media.url, caption: pieza.texto, access_token: token }
        : {
            // Un video en el feed de Instagram ES un Reel desde 2022: no existe ya el
            // tipo VIDEO a secas, y mandarlo devuelve un error sobre un media_type
            // inválido que no dice cuál es el bueno.
            media_type: "REELS",
            video_url: pieza.media.url,
            caption: pieza.texto,
            access_token: token,
          };

    const resCrear = await fetch(`${GRAPH}/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const crear = await leerRespuesta(resCrear);
    if (!crear.ok) return { ok: false, error: errorDe(resCrear, crear.json, crear.texto) };

    const contenedor = crear.json?.id;
    if (!contenedor) return { ok: false, error: "Meta no devolvió el id del contenedor." };

    // ── Paso 2: esperar a que Meta lo procese ──
    //
    // Se sondea SIEMPRE, también con imagen. Una imagen suele estar lista al primer
    // intento, pero cuando Meta tarda —y tarda, si la descarga del bucket va lenta—
    // publicar de inmediato falla con «Media ID is not available». Un sondeo que casi
    // siempre acaba en una llamada no cuesta nada; no sondear cuesta el post del día.
    let estado = "";
    let detalleError = "";
    for (let i = 0; i < INTENTOS_CONTENEDOR; i++) {
      const resEstado = await fetch(
        `${GRAPH}/${contenedor}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
      );
      const st = await leerRespuesta(resEstado);
      estado = st.json?.status_code ?? "";
      if (estado === "FINISHED") break;
      if (estado === "ERROR") {
        detalleError = st.json?.status ?? "";
        break;
      }
      await esperar(ESPERA_CONTENEDOR_MS);
    }

    if (estado === "ERROR") {
      return { ok: false, error: `Instagram rechazó la pieza al procesarla. ${detalleError}`.trim() };
    }
    if (estado !== "FINISHED") {
      // NO se publica un contenedor que no terminó: publicarlo falla, y peor, a veces
      // funciona a medias. Se declara qué pasó para que el próximo tick lo reintente.
      return {
        ok: false,
        error:
          `Instagram seguía procesando la pieza después de ${Math.round(
            (INTENTOS_CONTENEDOR * ESPERA_CONTENEDOR_MS) / 1000,
          )} s (estado «${estado || "desconocido"}»). No se publicó; se reintenta en el próximo ciclo.`,
      };
    }

    // ── Paso 3: publicar ──
    const resPub = await fetch(`${GRAPH}/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: contenedor, access_token: token }),
    });
    const pub = await leerRespuesta(resPub);
    if (!pub.ok) return { ok: false, error: errorDe(resPub, pub.json, pub.texto) };

    return { ok: true, id_externo: pub.json?.id, url: await enlaceIg(pub.json?.id, token) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

/**
 * El permalink de Instagram no se puede componer con el id: hay que pedirlo.
 * Es un extra, así que si falla se devuelve `undefined` y la publicación sigue siendo
 * un éxito — perder el enlace no es perder el post.
 */
async function enlaceIg(id: string | undefined, token: string): Promise<string | undefined> {
  if (!id) return undefined;
  try {
    const res = await fetch(`${GRAPH}/${id}?fields=permalink&access_token=${encodeURIComponent(token)}`);
    const { json } = await leerRespuesta(res);
    return json?.permalink ?? undefined;
  } catch {
    return undefined;
  }
}
