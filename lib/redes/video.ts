// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/video.ts — El Reel/Short del modo «generado». CORRE EN EL NAVEGADOR.
//
// POR QUÉ EN EL NAVEGADOR Y NO EN EL SERVIDOR, que es lo primero que uno intentaría:
// montar un video es ffmpeg, y **en Vercel no hay ffmpeg**. Las salidas serverless son
// meter un binario de ~80 MB en la función (no cabe en el límite del bundle), pagar un
// servicio de render por video, o levantar un worker propio como el del Radar. Las tres
// son infraestructura nueva para producir un vertical de imagen fija con texto.
//
// El navegador YA sabe hacerlo: `canvas` pinta los cuadros y `MediaRecorder` los graba.
// Y el operador está delante —acaba de revisar el texto—, así que no hay ninguna espera
// que no esté ya ocurriendo. Cero dependencias nuevas, cero infraestructura.
//
// LO QUE ESTO NO ES, Y LA PANTALLA LO DICE: no es edición de video. Es una imagen fija
// con el texto encima y un movimiento lento de zoom, 1080×1920. Sirve para sostener la
// frecuencia del canal; no sustituye a grabar. Por eso el modo «propio» existe y por eso
// el dueño pidió los tres.
//
// EL LÍMITE HONESTO: `MediaRecorder` no produce MP4/H.264 en todos los navegadores.
// Chrome y Edge sí; Firefox graba WebM (que TikTok y YouTube aceptan, e Instagram NO) y
// Safari es irregular. Por eso `formatoDisponible()` se consulta ANTES de ofrecer el
// botón y la pantalla nombra el navegador que hace falta, en vez de dejar que el
// operador descubra a los 20 s que el archivo no sirve.
// ──────────────────────────────────────────────────────────────────────────────

/** 9:16, el vertical que piden Reels, Shorts y TikTok. */
export const ANCHO = 1080;
export const ALTO = 1920;

/** Segundos del video. 8 s entra en el mínimo de las tres (3 s) y no cansa. */
export const DURACION_SEG = 8;

const FORMATOS = [
  // El orden es el de preferencia real: Instagram solo acepta MP4/MOV, así que un WebM
  // sirve para dos de las tres redes. Se intenta MP4 primero SIEMPRE.
  { mime: "video/mp4;codecs=h264,aac", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export type FormatoVideo = { mime: string; ext: string };

/**
 * Qué puede grabar ESTE navegador. `null` = ninguno, y entonces no se ofrece el botón.
 *
 * Se pregunta en vez de suponer: `MediaRecorder.isTypeSupported` es la única forma de
 * saberlo, y suponer MP4 produce un archivo que Instagram rechaza al final del proceso,
 * cuando ya se gastaron veinte segundos y una subida.
 */
export function formatoDisponible(): FormatoVideo | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const f of FORMATOS) {
    try {
      if (MediaRecorder.isTypeSupported(f.mime)) return f;
    } catch {
      /* algunos navegadores lanzan en vez de devolver false */
    }
  }
  return null;
}

/** ¿El formato que graba este navegador sirve para Instagram? */
export function sirveParaInstagram(f: FormatoVideo | null): boolean {
  return f?.ext === "mp4";
}

/**
 * Parte el texto en líneas que quepan, midiendo de verdad sobre el canvas.
 *
 * Partir por número de caracteres es lo que produce la línea suelta de dos palabras
 * bajo un bloque justificado: una tipografía proporcional no mide igual «Illimani» que
 * «WAWAWA». Se mide con `measureText`, que es lo que va a pintar.
 */
function partirLineas(ctx: CanvasRenderingContext2D, texto: string, maxAncho: number): string[] {
  const out: string[] = [];
  for (const parrafo of texto.split("\n")) {
    if (!parrafo.trim()) {
      out.push("");
      continue;
    }
    let linea = "";
    for (const palabra of parrafo.split(/\s+/)) {
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (ctx.measureText(prueba).width > maxAncho && linea) {
        out.push(linea);
        linea = palabra;
      } else {
        linea = prueba;
      }
    }
    if (linea) out.push(linea);
  }
  return out;
}

export type OpcionesVideo = {
  imagenUrl: string;
  texto: string;
  /** Se pinta pequeño abajo. Normalmente el nombre de la empresa. */
  pie?: string;
  duracionSeg?: number;
  /** Para pintar la barra de progreso mientras se graba. */
  onProgreso?: (pct: number) => void;
};

export type ResultadoVideo = {
  ok: boolean;
  blob?: Blob;
  ext?: string;
  duracionSeg?: number;
  error?: string;
};

/**
 * Monta el vertical y lo devuelve como Blob. NO lo sube: eso lo hace la pantalla, que
 * es la que tiene la sesión de Supabase.
 */
export async function armarVideo(opts: OpcionesVideo): Promise<ResultadoVideo> {
  const formato = formatoDisponible();
  if (!formato) {
    return {
      ok: false,
      error:
        "Este navegador no puede grabar video (no tiene MediaRecorder). Usa Chrome o Edge, " +
        "o elige el modo «video propio» y carga el archivo.",
    };
  }

  const duracion = opts.duracionSeg ?? DURACION_SEG;

  // La imagen se carga con CORS: sin `crossOrigin` el canvas queda «tainted» y
  // `captureStream` lanza un SecurityError al grabar — un fallo que ocurre al final y
  // cuyo mensaje no menciona la imagen. El bucket es público, así que el CORS pasa.
  const cargada = await cargarImagen(opts.imagenUrl).catch(() => null);
  if (!cargada) {
    return { ok: false, error: "No se pudo cargar la imagen para el video (revisa que el bucket sea público)." };
  }
  // Se re-liga a un `const` ya estrechado: dentro del callback de `requestAnimationFrame`
  // TypeScript pierde el estrechamiento de la variable original y obligaría a un `!` por
  // cada uso — y un `!` de más es el que sobrevive el día que alguien mueva el guard.
  const img = cargada;

  const canvas = document.createElement("canvas");
  canvas.width = ANCHO;
  canvas.height = ALTO;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "El navegador no dio contexto 2D para el canvas." };

  const stream = canvas.captureStream(30);
  const chunks: BlobPart[] = [];
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: formato.mime, videoBitsPerSecond: 6_000_000 });
  } catch (e: any) {
    return { ok: false, error: `No se pudo iniciar la grabación: ${String(e?.message ?? e)}` };
  }
  rec.ondataavailable = (ev) => {
    if (ev.data?.size) chunks.push(ev.data);
  };

  const terminado = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: formato.mime }));
  });

  // El texto se mide UNA vez, fuera del bucle de cuadros: `measureText` sobre 240
  // cuadros es trabajo repetido que hace caer los fps y deja el video a tirones.
  ctx.font = "600 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const margen = 80;
  const lineas = partirLineas(ctx, opts.texto.trim(), ANCHO - margen * 2).slice(0, 8);

  rec.start();
  const t0 = performance.now();

  await new Promise<void>((resolve) => {
    function cuadro() {
      const t = (performance.now() - t0) / 1000;
      const pct = Math.min(1, t / duracion);

      // ── Fondo: la imagen con un zoom lento (Ken Burns) ──
      // Sin movimiento el resultado se ve como una foto con texto y las plataformas lo
      // tratan peor que a un video; un zoom del 8 % es suficiente y no marea.
      const escala = 1.08 + 0.08 * pct;
      const escalaCubrir = Math.max(ANCHO / img.width, ALTO / img.height) * escala;
      const w = img.width * escalaCubrir;
      const h = img.height * escalaCubrir;
      ctx!.fillStyle = "#0b1220";
      ctx!.fillRect(0, 0, ANCHO, ALTO);
      ctx!.drawImage(img, (ANCHO - w) / 2, (ALTO - h) / 2, w, h);

      // ── Velo inferior, para que el texto se lea sobre cualquier foto ──
      const velo = ctx!.createLinearGradient(0, ALTO * 0.35, 0, ALTO);
      velo.addColorStop(0, "rgba(6,12,24,0)");
      velo.addColorStop(0.55, "rgba(6,12,24,0.78)");
      velo.addColorStop(1, "rgba(6,12,24,0.94)");
      ctx!.fillStyle = velo;
      ctx!.fillRect(0, ALTO * 0.35, ANCHO, ALTO * 0.65);

      // ── Texto, de abajo hacia arriba ──
      ctx!.font = "600 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx!.fillStyle = "#ffffff";
      ctx!.textBaseline = "alphabetic";
      const alturaLinea = 74;
      const pieAlto = opts.pie ? 90 : 40;
      let y = ALTO - pieAlto - 60;
      for (let i = lineas.length - 1; i >= 0; i--) {
        ctx!.fillText(lineas[i], margen, y);
        y -= alturaLinea;
      }

      if (opts.pie) {
        ctx!.font = "500 34px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx!.fillStyle = "rgba(255,255,255,0.72)";
        ctx!.fillText(opts.pie, margen, ALTO - 56);
      }

      opts.onProgreso?.(pct);

      if (pct >= 1) {
        resolve();
        return;
      }
      requestAnimationFrame(cuadro);
    }
    requestAnimationFrame(cuadro);
  });

  rec.stop();
  stream.getTracks().forEach((t) => t.stop());
  const blob = await terminado;

  if (!blob.size) return { ok: false, error: "La grabación salió vacía." };
  return { ok: true, blob, ext: formato.ext, duracionSeg: duracion };
}

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar la imagen"));
    img.src = url;
  });
}
