// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/video.ts — El montador del Reel/Short. CORRE EN EL NAVEGADOR.
//
// POR QUÉ EN EL NAVEGADOR Y NO EN EL SERVIDOR, que es lo primero que uno intentaría:
// montar un video es ffmpeg, y **en Vercel no hay ffmpeg**. Las salidas serverless son
// meter un binario de ~80 MB en la función (no cabe en el límite del bundle), pagar un
// servicio de render por video, o levantar un worker propio como el del Radar. Las tres
// son infraestructura nueva. El navegador YA sabe hacerlo: `canvas` pinta los cuadros y
// `MediaRecorder` los graba, y el operador está delante porque acaba de revisar el texto.
//
// ESTE ARCHIVO NO DECIDE CÓMO SE VE EL VIDEO: LO PINTA.
// Qué se ve en cada escena, qué frase va encima, cuánto dura, cómo se mueve la cámara y
// cómo entra la siguiente es el GUION (`lib/redes/guion.ts`), que escribe la IA o compone
// el defecto. Aquí no hay ninguna rama que invente una escena ni que reparta un texto:
// dos módulos que decidan cómo se ve el video terminan decidiendo distinto — es el bug
// del semáforo de puntualidad, con el agravante de que aquí el desacuerdo se publica.
//
// LO QUE ESTO SIGUE SIN SER, Y LA PANTALLA LO DICE: no es material grabado. Ningún
// modelo de Anthropic genera video; lo que la IA aporta es la DIRECCIÓN sobre las fotos
// que ya existen. Sirve para sostener la frecuencia del canal y se nota que es montaje.
// Por eso el modo «propio» existe y por eso el dueño pidió los tres.
//
// EL LÍMITE HONESTO DEL FORMATO: `MediaRecorder` no produce MP4/H.264 en todos los
// navegadores. Chrome y Edge sí; Firefox graba WebM (que TikTok y YouTube aceptan, e
// Instagram NO) y Safari es irregular. Por eso `formatoDisponible()` se consulta ANTES de
// ofrecer el botón, en vez de dejar que el operador descubra a los veinte segundos que el
// archivo no sirve.
// ──────────────────────────────────────────────────────────────────────────────

import { duracionGuion, type Escena, type Guion, type Movimiento } from "./guion";

/** 9:16, el vertical que piden Reels, Shorts y TikTok. */
export const ANCHO = 1080;
export const ALTO = 1920;

// ── Zonas seguras ─────────────────────────────────────────────────────────────
//
// NO SON MÁRGENES DE GUSTO: son el sitio donde la plataforma pinta SU PROPIA interfaz
// encima del video. TikTok tapa la franja de arriba con su cabecera, la columna derecha
// con los botones de me gusta/comentar/compartir, y la banda de abajo con el usuario, el
// pie y la música; Reels hace lo mismo con algo más de alto abajo. Un título centrado en
// el canvas queda perfecto en el archivo y CORTADO en el teléfono, que es donde se ve.
//
// Por eso el bloque de texto termina bastante por encima del borde inferior: ese hueco
// vacío no es un fallo de maquetación, es donde va el caption de la app. En el
// reproductor de /redes se ve grande y raro; en el teléfono está tapado.
//
// LOS NÚMEROS NO SE ELIGIERON A OJO: son la zona segura que TikTok publica para 1080×1920
// (≈130 px arriba, ≈480 abajo, ≈128 a la derecha), redondeados hacia el lado conservador.
// Reels tapa aproximadamente lo mismo. Equivocarse hacia adentro cuesta un hueco feo en la
// vista previa; hacia afuera cuesta un título cortado en el único sitio donde se ve.
const MARGEN = 84;
const SAFE_TOP = 200;
const SAFE_BOTTOM = 470;
const SAFE_RIGHT = 130;

const ANCHO_TEXTO = ANCHO - MARGEN - SAFE_RIGHT;
/** Línea base del último renglón del bloque de texto. */
const BASE_TEXTO = ALTO - SAFE_BOTTOM;

// ── Paleta ────────────────────────────────────────────────────────────────────
const AZUL = "#0b315f";
const AZUL_OSCURO = "#06182f";
const ACENTO = "#f5b52a";

// ── Tiempos de animación ──────────────────────────────────────────────────────
/** Lo que tarda una escena en entrar sobre la anterior. */
const TRANSICION_SEG = 0.45;
/** Lo que tarda una línea en aparecer, y el desfase entre líneas consecutivas. */
const ENTRADA_LINEA_SEG = 0.42;
const DESFASE_LINEA_SEG = 0.09;
const RETARDO_TEXTO_SEG = 0.18;
/** Lo que tarda el texto en irse al final de su escena. */
const SALIDA_TEXTO_SEG = 0.32;

const FORMATOS = [
  // El orden es el de preferencia real: Instagram solo acepta MP4/MOV, así que un WebM
  // sirve para dos de las tres redes de video. Se intenta MP4 primero SIEMPRE.
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

// ── Texto ─────────────────────────────────────────────────────────────────────

/**
 * Parte el texto en líneas que quepan, midiendo de verdad sobre el canvas.
 *
 * Partir por número de caracteres es lo que produce la línea suelta de dos palabras bajo
 * un bloque justificado: una tipografía proporcional no mide igual «Illimani» que
 * «WAWAWA». Se mide con `measureText`, que es lo que va a pintar.
 */
export function partirLineas(ctx: CanvasRenderingContext2D, texto: string, maxAncho: number): string[] {
  const out: string[] = [];
  for (const parrafo of texto.split("\n")) {
    if (!parrafo.trim()) continue;
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

const FUENTE = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const fTitulo = `800 78px ${FUENTE}`;
const fSubtexto = `500 40px ${FUENTE}`;
const fMarca = `700 30px ${FUENTE}`;

/** Suavizado de entrada. Un movimiento lineal se lee como una animación de sistema. */
function suave(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return 1 - Math.pow(1 - x, 3);
}

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type OpcionesVideo = {
  guion: Guion;
  /** Las fotos de la publicación, en el orden al que apuntan los índices del guion. */
  imagenes: string[];
  /** Para pintar la barra de progreso mientras se graba. */
  onProgreso?: (pct: number) => void;
};

export type ResultadoVideo = {
  ok: boolean;
  blob?: Blob;
  ext?: string;
  duracionSeg?: number;
  error?: string;
  /**
   * El video se montó pero hay algo que decir (una foto que no cargó, la pestaña que se
   * quedó en segundo plano). Se devuelve el archivo igual: un aviso no es un fallo, y
   * tirar un video por una foto de tres que no bajó sería perder el trabajo entero.
   */
  aviso?: string;
};

// ── Montaje ───────────────────────────────────────────────────────────────────

type Plano = { escena: Escena; img: HTMLImageElement | null; inicio: number; fin: number };

/**
 * Monta el vertical y lo devuelve como Blob. NO lo sube: eso lo hace la pantalla, que es
 * la que tiene la sesión de Supabase.
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

  const escenas = opts.guion.escenas ?? [];
  if (!escenas.length) return { ok: false, error: "El guion no tiene ninguna escena." };

  // Las imágenes se cargan con CORS y TODAS a la vez: sin `crossOrigin` el canvas queda
  // «tainted» y `captureStream` lanza un SecurityError al grabar — un fallo que ocurre al
  // final y cuyo mensaje no menciona la imagen. El bucket es público, así que el CORS
  // pasa. Una foto que no cargue NO tumba el montaje: su escena sale como tarjeta de
  // color y se DICE cuántas fueron.
  const imgs = await Promise.all(opts.imagenes.map((u) => cargarImagen(u).catch(() => null)));
  const fallidas = imgs.filter((i) => !i).length;

  const necesitaFoto = escenas.some((e) => e.imagen !== null);
  if (necesitaFoto && !imgs.some(Boolean)) {
    return {
      ok: false,
      error: "No se pudo cargar ninguna de las imágenes (revisa que el bucket sea público).",
    };
  }

  // Los tramos se calculan UNA vez: el bucle de cuadros corre 30 veces por segundo y
  // recalcular ahí los límites de cada escena es trabajo repetido que baja los fps.
  const planos: Plano[] = [];
  let acc = 0;
  for (const e of escenas) {
    planos.push({
      escena: e,
      img: e.imagen === null ? null : (imgs[e.imagen] ?? null),
      inicio: acc,
      fin: acc + e.duracion_seg,
    });
    acc += e.duracion_seg;
  }
  const duracion = duracionGuion(opts.guion);

  const canvas = document.createElement("canvas");
  canvas.width = ANCHO;
  canvas.height = ALTO;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "El navegador no dio contexto 2D para el canvas." };

  // Las líneas se miden UNA vez por escena, fuera del bucle: `measureText` sobre 500
  // cuadros deja el video a tirones.
  const lineas = planos.map((p) => ({
    titulo: medir(ctx, p.escena.titulo, fTitulo),
    texto: medir(ctx, p.escena.texto, fSubtexto),
  }));

  const stream = canvas.captureStream(30);
  const chunks: BlobPart[] = [];
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: formato.mime, videoBitsPerSecond: 8_000_000 });
  } catch (e: any) {
    return { ok: false, error: `No se pudo iniciar la grabación: ${String(e?.message ?? e)}` };
  }
  rec.ondataavailable = (ev) => {
    if (ev.data?.size) chunks.push(ev.data);
  };
  const terminado = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: formato.mime }));
  });

  // UNA PESTAÑA EN SEGUNDO PLANO NO PINTA. El navegador congela `requestAnimationFrame`
  // en cuanto la pestaña deja de verse, así que el canvas se queda en el último cuadro
  // mientras la grabación sigue corriendo: sale un video con varios segundos clavados.
  // No se puede impedir, así que se hacen las dos únicas cosas honestas — un temporizador
  // de respaldo para que el bucle TERMINE en vez de colgarse (si no, el botón se queda en
  // «Armando… 40 %» para siempre), y decirlo al final para que se pueda rehacer.
  let seEscondio = typeof document !== "undefined" && document.hidden;
  const alEsconder = () => {
    if (document.hidden) seEscondio = true;
  };
  document.addEventListener("visibilitychange", alEsconder);

  rec.start(250);
  const t0 = performance.now();

  await new Promise<void>((resolve) => {
    function cuadro() {
      const t = (performance.now() - t0) / 1000;
      const pct = Math.min(1, t / duracion);

      const i = indiceEn(planos, Math.min(t, duracion - 0.001));
      const plano = planos[i];
      const tl = t - plano.inicio;

      ctx!.globalAlpha = 1;
      ctx!.fillStyle = AZUL_OSCURO;
      ctx!.fillRect(0, 0, ANCHO, ALTO);

      // ── La escena, con su transición de entrada ──
      const trans = plano.escena.transicion;
      const enTransicion = i > 0 && trans !== "corte" && tl < TRANSICION_SEG;
      if (enTransicion) {
        const p = suave(tl / TRANSICION_SEG);
        const prev = planos[i - 1];
        const tlPrev = prev.fin - prev.inicio;
        if (trans === "fundido") {
          pintarEscena(ctx!, prev, lineas[i - 1], tlPrev, 0, planos.length, i - 1);
          // La opacidad va como PARÁMETRO, no como `ctx.globalAlpha` ambiente: el pintado
          // del texto lo devuelve a 1 varias veces por cuadro, así que el fundido se
          // aplicaría a la foto y no a la frase que va encima — la escena entrante
          // aparecería con su texto ya opaco sobre la anterior.
          pintarEscena(ctx!, plano, lineas[i], tl, 0, planos.length, i, p);
        } else {
          // Desliz: la anterior se va por la izquierda y la nueva entra por la derecha.
          pintarEscena(ctx!, prev, lineas[i - 1], tlPrev, -ANCHO * p, planos.length, i - 1);
          pintarEscena(ctx!, plano, lineas[i], tl, ANCHO * (1 - p), planos.length, i);
        }
      } else {
        pintarEscena(ctx!, plano, lineas[i], tl, 0, planos.length, i);
      }

      // ── Cabecera: progreso por escena y marca ──
      // La barra segmentada es la del formato Historias, y hace dos cosas a la vez: dice
      // cuánto queda —que es lo que sostiene la atención— y delata que el video tiene
      // varias escenas antes de que cambie la primera.
      pintarProgreso(ctx!, planos, t);
      if (opts.guion.marca) pintarMarca(ctx!, opts.guion.marca);

      opts.onProgreso?.(pct);

      if (t >= duracion) {
        resolve();
        return;
      }
      siguienteCuadro(cuadro);
    }
    siguienteCuadro(cuadro);
  });

  document.removeEventListener("visibilitychange", alEsconder);
  rec.stop();
  stream.getTracks().forEach((tr) => tr.stop());
  const blob = await terminado;

  if (!blob.size) return { ok: false, error: "La grabación salió vacía." };

  const avisos = [
    fallidas ? `${fallidas} imagen(es) no se pudieron cargar y salieron como tarjeta de color.` : "",
    seEscondio
      ? "La pestaña estuvo en segundo plano mientras se grababa: puede haber tramos congelados. " +
        "Míralo antes de aprobar y, si salió mal, rehazlo dejando esta pestaña a la vista."
      : "",
  ].filter(Boolean);

  return {
    ok: true,
    blob,
    ext: formato.ext,
    duracionSeg: duracion,
    aviso: avisos.length ? avisos.join(" ") : undefined,
  };
}

/**
 * Pide el siguiente cuadro por rAF **y** por temporizador, y gana el primero que llegue.
 *
 * El rAF solo no vale: en una pestaña oculta no se llama nunca y el bucle se cuelga sin
 * resolver la promesa. El temporizador solo tampoco: da menos cuadros y peor reparto.
 * Con los dos, en primer plano manda el rAF (60 fps reales) y en segundo plano el
 * temporizador garantiza que el montaje TERMINA, aunque salga a tirones — que es lo que
 * el aviso de arriba avisa.
 */
function siguienteCuadro(fn: () => void) {
  let hecho = false;
  const una = () => {
    if (hecho) return;
    hecho = true;
    fn();
  };
  requestAnimationFrame(una);
  setTimeout(una, 80);
}

function indiceEn(planos: Plano[], t: number): number {
  for (let i = 0; i < planos.length; i++) if (t < planos[i].fin) return i;
  return planos.length - 1;
}

type Medido = { lineas: string[]; alto: number };

function medir(ctx: CanvasRenderingContext2D, texto: string | undefined, fuente: string): Medido {
  if (!texto) return { lineas: [], alto: 0 };
  ctx.font = fuente;
  const max = fuente === fTitulo ? 3 : 2;
  const lineas = partirLineas(ctx, texto, ANCHO_TEXTO).slice(0, max);
  const alto = fuente === fTitulo ? lineas.length * 92 : lineas.length * 52;
  return { lineas, alto };
}

// ── Pintado de una escena ─────────────────────────────────────────────────────

function pintarEscena(
  ctx: CanvasRenderingContext2D,
  plano: Plano,
  med: { titulo: Medido; texto: Medido },
  tl: number,
  dx: number,
  total: number,
  indice: number,
  alpha = 1,
) {
  const dur = plano.fin - plano.inicio;
  const prog = Math.min(1, Math.max(0, tl / dur));

  // CADA ESCENA SE PINTA DENTRO DE SU FRANJA, Y ESTO NO ES UN DETALLE.
  // La foto se dibuja SIEMPRE más ancha que el canvas (sobreescala, para que el paneo no
  // enseñe el borde) y centrada en `dx`, así que se sale por los dos lados. Sin recortar,
  // durante un `desliz` la foto que ENTRA se derrama por encima de la que sale y el
  // empuje se ve como una imagen que tapa a la otra en vez de dos que se relevan. Con
  // `dx = 0` —que es el 95 % de los cuadros— el recorte no cambia nada.
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, 0, ANCHO, ALTO);
  ctx.clip();
  ctx.globalAlpha = alpha;

  // ── Fondo ──
  if (plano.img) {
    pintarKenBurns(ctx, plano.img, plano.escena.movimiento, prog, dx);
    // Velo: sin él, un texto blanco sobre una foto clara desaparece. El degradado empieza
    // a media altura para no apagar la foto entera.
    const velo = ctx.createLinearGradient(0, ALTO * 0.3, 0, ALTO);
    velo.addColorStop(0, "rgba(6,18,36,0)");
    velo.addColorStop(0.5, "rgba(6,18,36,0.62)");
    velo.addColorStop(1, "rgba(6,18,36,0.93)");
    ctx.fillStyle = velo;
    ctx.fillRect(dx, ALTO * 0.3, ANCHO, ALTO * 0.7);
    // Un poco de sombra arriba para que la barra de progreso y la marca se lean sobre
    // cualquier foto.
    const alto = ctx.createLinearGradient(0, 0, 0, ALTO * 0.28);
    alto.addColorStop(0, "rgba(6,18,36,0.7)");
    alto.addColorStop(1, "rgba(6,18,36,0)");
    ctx.fillStyle = alto;
    ctx.fillRect(dx, 0, ANCHO, ALTO * 0.28);
  } else {
    pintarTarjeta(ctx, dx, prog);
  }

  // ── Texto ──
  const salida =
    indice === total - 1 || dur <= SALIDA_TEXTO_SEG
      ? 0 // La última escena no se desvanece: el video termina en su remate, no en negro.
      : 1 - suave((tl - (dur - SALIDA_TEXTO_SEG)) / SALIDA_TEXTO_SEG);
  const alphaSalida = tl > dur - SALIDA_TEXTO_SEG && indice !== total - 1 ? Math.max(0, salida) : 1;

  const yBase = BASE_TEXTO;
  const altoSub = med.texto.alto;
  const yTitulo = yBase - altoSub - (altoSub ? 24 : 0);

  // La barra de acento crece con la primera línea. Es lo que convierte un bloque de texto
  // en una composición: sin ella el título flota sobre la foto.
  const altoBloque = med.titulo.alto + (altoSub ? altoSub + 24 : 0);
  if (altoBloque > 0) {
    const pBarra = suave((tl - RETARDO_TEXTO_SEG) / ENTRADA_LINEA_SEG);
    ctx.globalAlpha = alpha * alphaSalida * Math.min(1, Math.max(0, pBarra));
    ctx.fillStyle = ACENTO;
    const hBarra = altoBloque * Math.min(1, Math.max(0, pBarra));
    ctx.fillRect(dx + MARGEN - 34, yBase - hBarra + 8, 8, hBarra);
    ctx.globalAlpha = alpha;
  }

  ctx.textBaseline = "alphabetic";
  pintarLineas(ctx, med.titulo.lineas, fTitulo, 92, dx + MARGEN, yTitulo, tl, 0, alpha * alphaSalida, "#ffffff");
  if (altoSub) {
    pintarLineas(
      ctx,
      med.texto.lineas,
      fSubtexto,
      52,
      dx + MARGEN,
      yBase,
      tl,
      med.titulo.lineas.length,
      alpha * alphaSalida,
      "rgba(255,255,255,0.82)",
    );
  }

  ctx.restore();
}

/**
 * Pinta un bloque de líneas con entrada escalonada.
 *
 * Que las líneas entren una detrás de otra —y no el bloque de golpe— es lo que hace que
 * el ojo LEA en vez de abarcar: es el mismo recurso de cualquier pieza de Historias, y
 * cuesta dos líneas de matemática.
 */
function pintarLineas(
  ctx: CanvasRenderingContext2D,
  lineas: string[],
  fuente: string,
  alturaLinea: number,
  x: number,
  yUltima: number,
  tl: number,
  desfaseIndice: number,
  alphaSalida: number,
  color: string,
) {
  if (!lineas.length) return;
  ctx.font = fuente;
  ctx.fillStyle = color;
  // Sombra: el texto tiene que leerse también sobre la parte clara de una foto.
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 2;

  for (let i = 0; i < lineas.length; i++) {
    const inicio = RETARDO_TEXTO_SEG + (desfaseIndice + i) * DESFASE_LINEA_SEG;
    const p = suave((tl - inicio) / ENTRADA_LINEA_SEG);
    if (p <= 0) continue;
    const y = yUltima - (lineas.length - 1 - i) * alturaLinea + (1 - p) * 36;
    ctx.globalAlpha = Math.min(1, p) * alphaSalida;
    ctx.fillText(lineas[i], x, y);
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * La imagen a pantalla completa con su movimiento.
 *
 * Todos los movimientos llevan sobreescala (nunca menos de 1.04): sin ella, un paneo
 * dejaría ver el borde de la foto y un cuadro de fondo liso a un lado.
 */
function pintarKenBurns(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  mov: Movimiento,
  prog: number,
  dx: number,
) {
  const cubrir = Math.max(ANCHO / img.width, ALTO / img.height);
  let escala = 1.08;
  let panX = 0;
  switch (mov) {
    case "zoom_in":
      escala = 1.06 + 0.16 * prog;
      break;
    case "zoom_out":
      escala = 1.22 - 0.16 * prog;
      break;
    case "pan_izq":
    case "pan_der": {
      escala = 1.2;
      const w = img.width * cubrir * escala;
      const margen = Math.max(0, (w - ANCHO) / 2);
      const dir = mov === "pan_izq" ? -1 : 1;
      panX = dir * (prog - 0.5) * 2 * margen;
      break;
    }
    case "estatico":
      escala = 1.04;
      break;
  }
  const w = img.width * cubrir * escala;
  const h = img.height * cubrir * escala;
  ctx.drawImage(img, dx + (ANCHO - w) / 2 - panX, (ALTO - h) / 2, w, h);
}

/** La tarjeta sin foto: el fondo de marca. Es lo que usa el cierre. */
function pintarTarjeta(ctx: CanvasRenderingContext2D, dx: number, prog: number) {
  const g = ctx.createLinearGradient(dx, 0, dx + ANCHO, ALTO);
  g.addColorStop(0, AZUL);
  g.addColorStop(1, AZUL_OSCURO);
  ctx.fillStyle = g;
  ctx.fillRect(dx, 0, ANCHO, ALTO);

  // Un halo que respira, para que la tarjeta no sea un rectángulo muerto entre dos fotos.
  const r = ANCHO * (0.55 + 0.12 * prog);
  const halo = ctx.createRadialGradient(dx + ANCHO * 0.72, ALTO * 0.24, 0, dx + ANCHO * 0.72, ALTO * 0.24, r);
  halo.addColorStop(0, "rgba(245,181,42,0.18)");
  halo.addColorStop(1, "rgba(245,181,42,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(dx, 0, ANCHO, ALTO);
}

function pintarProgreso(ctx: CanvasRenderingContext2D, planos: Plano[], t: number) {
  const n = planos.length;
  const hueco = 10;
  const ancho = (ANCHO - MARGEN * 2 - hueco * (n - 1)) / n;
  const y = SAFE_TOP - 70;
  for (let i = 0; i < n; i++) {
    const x = MARGEN + i * (ancho + hueco);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(x, y, ancho, 6);
    const dur = planos[i].fin - planos[i].inicio;
    const p = Math.min(1, Math.max(0, (t - planos[i].inicio) / dur));
    if (p > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, ancho * p, 6);
    }
  }
}

function pintarMarca(ctx: CanvasRenderingContext2D, marca: string) {
  ctx.font = fMarca;
  ctx.textBaseline = "alphabetic";
  const w = ctx.measureText(marca).width;
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  redondeado(ctx, MARGEN, SAFE_TOP - 42, w + 40, 52, 26);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText(marca, MARGEN + 20, SAFE_TOP - 6);
}

function redondeado(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
