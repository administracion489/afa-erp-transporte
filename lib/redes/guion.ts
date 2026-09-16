// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/guion.ts — EL GUION DEL VIDEO. Módulo PURO: no lee la base, no llama a
// ninguna API, no toca el DOM. Lo importan el redactor (servidor), el montador
// (navegador) y la pantalla, y los tres tienen que entender lo mismo por «escena».
//
// POR QUÉ EXISTE, Y ES LA CORRECCIÓN DE UN DEFECTO CONCRETO
// La primera versión del modo «generado» pintaba UNA foto fija con el CAPTION ENTERO
// encima: ocho líneas de texto de publicación, con sus hashtags, sobre un zoom lento.
// Eso no es un video, es una foto con un párrafo, y se nota en la primera pasada.
//
// **EL TEXTO DE PANTALLA NO ES EL CAPTION, Y ESA ES LA DECISIÓN ENTERA.** El caption son
// 300 caracteres que alguien lee con el pulgar quieto; lo que va SOBRE el video son
// cuatro a siete palabras que se leen en dos segundos mientras la imagen se mueve. Son
// dos textos distintos con dos trabajos distintos, y volcar el primero en el segundo es
// lo que producía el muro de letras. Por eso una escena tiene su propio `titulo`, corto
// y acotado aquí, y el caption sigue viviendo en `redes_publicaciones.texto`.
//
// LA IA DIRIGE; EL MONTADOR OBEDECE. Ningún modelo de Anthropic genera video ni imagen —
// eso hay que decirlo en vez de aparentarlo—, pero sí puede escribir el guion: qué se ve
// en cada escena, qué frase va encima, cuánto dura, cómo se mueve la cámara y cómo entra
// la siguiente. El guion es un DATO (esta estructura) y `lib/redes/video.ts` no decide
// nada por su cuenta: lo pinta. Dos módulos que decidan cómo se ve el video terminan
// decidiendo distinto, que es el bug del semáforo de puntualidad.
//
// LO QUE ESTE MÓDULO NO HACE: no valida contra las redes. Cuánto puede durar un Reel lo
// dice `CAPACIDADES` en tipos.ts y lo juzga `plan.ts` sobre el archivo YA montado. Aquí
// solo se acota lo que hace falta para que el video se pueda ver: una escena de 0.2 s no
// se lee, y una de 40 s es una foto fija con otro nombre.
// ──────────────────────────────────────────────────────────────────────────────

/** Cómo se mueve la cámara sobre la imagen de una escena. */
export type Movimiento = "zoom_in" | "zoom_out" | "pan_izq" | "pan_der" | "estatico";

export const MOVIMIENTOS: Movimiento[] = ["zoom_in", "zoom_out", "pan_izq", "pan_der", "estatico"];

/** Cómo ENTRA una escena (la primera siempre entra en corte). */
export type Transicion = "corte" | "fundido" | "desliz";

export const TRANSICIONES: Transicion[] = ["corte", "fundido", "desliz"];

export type Escena = {
  /**
   * Índice dentro del array de imágenes de la publicación. `null` = tarjeta de color,
   * sin foto: es lo que hace posible el cierre y un remate de solo texto.
   */
  imagen: number | null;
  /** La frase grande. Cuatro a siete palabras: lo que se lee mientras la imagen se mueve. */
  titulo?: string;
  /** Línea secundaria, pequeña. Opcional — una escena puede ser solo imagen. */
  texto?: string;
  movimiento: Movimiento;
  duracion_seg: number;
  transicion: Transicion;
  /** Marca la tarjeta final. No es decoración: evita que se añada una segunda. */
  tipo?: "cierre";
};

export type Guion = {
  escenas: Escena[];
  /** El pie que se repite arriba en todas las escenas. Normalmente el nombre de la empresa. */
  marca?: string;
};

// ── Límites ───────────────────────────────────────────────────────────────────
//
// Los dos primeros están MEDIDOS contra lo que hace un ojo, no elegidos: por debajo de
// ~1.2 s no da tiempo a leer cinco palabras, y por encima de 6 s una foto fija con una
// frase ya es un póster. El resto se DERIVA de ellos.

export const MIN_ESCENA_SEG = 1.2;
export const MAX_ESCENA_SEG = 6;
export const ESCENA_SEG_DEFECTO = 3;
export const CIERRE_SEG = 2.2;

/** Tope de escenas. Ocho × 6 s = 48 s, que es el techo REAL del video. */
export const MAX_ESCENAS = 8;

/**
 * Piso del total. Instagram y TikTok rechazan por debajo de 3 s; se pide 5 para no
 * quedar pegado al límite cuando el contenedor redondea la duración hacia abajo.
 *
 * NO hay techo de duración total declarado aparte, y es deliberado: sale de multiplicar
 * los dos límites de arriba. Un tercer número habría que mantenerlo sincronizado con
 * ellos, y el día que no lo esté mentiría sobre lo que el módulo puede producir.
 */
export const MIN_TOTAL_SEG = 5;

/** Lo que cabe en pantalla sin que el texto se coma la imagen. */
export const MAX_TITULO = 48;
export const MAX_SUBTEXTO = 90;
export const MAX_MARCA = 40;

// ── Avisos ────────────────────────────────────────────────────────────────────
//
// EL MOTIVO SE DECLARA, NO SE OLFATEA. `normalizarGuion` ARREGLA lo que viene mal en vez
// de rechazarlo —perder el guion es perder el video del día, y un modelo que escribe una
// escena de 40 s no ha entendido mal el encargo, se ha pasado con un número— pero cada
// arreglo deja su código para que la pantalla pueda decirlo. Un guion que se corrige en
// silencio es un guion que nadie sabe que se corrigió.

export type CodigoGuion =
  /** No llegó ninguna escena utilizable; se usó el guion por defecto. */
  | "sin_escenas"
  /** Venían más de `MAX_ESCENAS`; se quedaron las primeras. */
  | "escenas_recortadas"
  /** Alguna duración estaba fuera de banda y se acotó. */
  | "duracion_ajustada"
  /** El total no llegaba al mínimo; se alargó la última escena. */
  | "total_alargado"
  /** Un índice de imagen apuntaba fuera del array; se dio la vuelta. */
  | "imagen_fuera_de_rango"
  /** Un título o una línea secundaria pasaba el tope y se recortó por palabra. */
  | "texto_recortado"
  /** Un movimiento o una transición no estaban en la lista; se usó el de defecto. */
  | "valor_desconocido"
  /** Venía un hashtag en el texto de PANTALLA y se le quitó la almohadilla. */
  | "hashtag_quitado"
  /** No hay ninguna imagen: el video saldría solo con tarjetas de color. */
  | "sin_imagenes";

export const AVISO_GUION: Record<CodigoGuion, string> = {
  sin_escenas: "El guion venía vacío. Se armó uno repartiendo el texto por frases.",
  escenas_recortadas: `El guion traía más de ${MAX_ESCENAS} escenas; se dejaron las primeras.`,
  duracion_ajustada: `Alguna escena duraba fuera de la banda ${MIN_ESCENA_SEG}–${MAX_ESCENA_SEG} s y se acotó.`,
  total_alargado: `El video no llegaba a ${MIN_TOTAL_SEG} s (mínimo de Reels y TikTok) y se alargó la última escena.`,
  imagen_fuera_de_rango:
    "Alguna escena pedía una imagen que no existe; se reutilizó una de las cargadas.",
  texto_recortado: "Algún texto de pantalla era demasiado largo y se recortó por palabra.",
  valor_desconocido: "Algún movimiento o transición no se reconoció y se usó el de defecto.",
  hashtag_quitado:
    "Algún texto de pantalla traía un hashtag y se le quitó la almohadilla: los hashtags son del caption, no del video.",
  sin_imagenes:
    "No hay ninguna imagen cargada: el video saldría solo con tarjetas de texto. Sube al menos una foto.",
};

// ── Utilidades ────────────────────────────────────────────────────────────────

function acotar(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Recorta por PALABRA y remata con «…».
 *
 * Cortar por carácter parte «transporte» en «transp», que en pantalla se lee como un
 * fallo del sistema y no como un texto largo. Si la primera palabra ya no cabe, ahí sí
 * se corta duro: es preferible a devolver una línea que se sale del canvas.
 */
export function recortarPalabras(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= max) return limpio;
  const palabras = limpio.split(" ");
  let out = "";
  for (const p of palabras) {
    const prueba = out ? `${out} ${p}` : p;
    if (prueba.length > max - 1) break;
    out = prueba;
  }
  return (out || limpio.slice(0, max - 1)).trimEnd() + "…";
}

/**
 * Quita de un texto de PANTALLA lo que pertenece al caption.
 *
 * Hoy es solo la almohadilla, y se quita la almohadilla en vez de la palabra entera:
 * «Transporte seguro #AFA» sigue diciendo lo mismo sin el símbolo, mientras que borrar el
 * token dejaría frases cojas. Un `#` sobre el video es exactamente el artefacto de
 * caption que este módulo vino a quitar — el prompt ya lo prohíbe, pero un prompt no es
 * un guard: es la misma regla que `esMarcaKitGLP` o el cuadre del voucher, donde el ERP
 * comprueba por su cuenta lo que le pidió al modelo.
 */
export function limpiarTextoPantalla(texto: string): string {
  return texto.replace(/(^|\s)#(?=[\p{L}\p{N}_])/gu, "$1").replace(/\s+/g, " ").trim();
}

/**
 * Las frases utilizables de un caption, para el guion por defecto.
 *
 * Se quitan los hashtags y las líneas de solo emojis: en el caption rematan el texto, y
 * en pantalla serían una escena que no dice nada. Es la misma idea que separar el texto
 * de pantalla del caption — aquí se aplica al derivarlo.
 */
export function frasesDe(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, " "))
    .join("\n")
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((f) => f.replace(/\s+/g, " ").trim())
    .map((f) => f.replace(/[.\s]+$/u, ""))
    .filter((f) => f.length >= 3 && /\p{L}/u.test(f));
}

/** Los segundos que dura el guion. Es la suma, sin más: no hay duración escondida. */
export function duracionGuion(g: Guion): number {
  return Math.round(g.escenas.reduce((s, e) => s + e.duracion_seg, 0) * 10) / 10;
}

/**
 * El movimiento de la escena `i` cuando nadie lo declaró.
 *
 * Se ALTERNA en vez de repetir uno: cuatro escenas con el mismo zoom se leen como una
 * sola toma larga, que es justo la sensación que este módulo existe para quitar. El
 * `estatico` queda fuera de la rotación a propósito — es una elección válida si alguien
 * la pide, pero de defecto sería volver al póster.
 */
export function movimientoPorPosicion(i: number): Movimiento {
  const ciclo: Movimiento[] = ["zoom_in", "pan_der", "zoom_out", "pan_izq"];
  return ciclo[i % ciclo.length];
}

// ── El guion por defecto ──────────────────────────────────────────────────────

export type OpcionesDefecto = {
  texto: string;
  imagenes: string[];
  marca?: string;
  /** La frase de la tarjeta final. Sin ella el cierre lleva solo la marca. */
  cierre?: string;
};

/**
 * Arma un guion a partir de lo que ya hay: las imágenes cargadas y el caption.
 *
 * NO ES UN MODO DEGRADADO QUE NADIE VE. Es lo que se monta cuando el operador pulsa
 * «Armar video» sin haber pedido guion, y la pantalla lo DICE con esas palabras. Sale
 * mucho mejor que la versión de una foto con el caption encima —reparte el texto por
 * frases, cambia de imagen y mueve la cámara distinto en cada escena— y sigue estando por
 * debajo de un guion escrito, que es el que sabe qué se ve en cada foto.
 */
export function guionPorDefecto(opts: OpcionesDefecto): Guion {
  const { imagenes, marca } = opts;
  const frases = frasesDe(opts.texto ?? "");

  // Tantas escenas como haga falta para enseñar todas las imágenes, sin pasar del tope y
  // sin quedarse corto cuando hay una sola foto y varias frases que contar.
  const cuantas = acotar(Math.max(imagenes.length, Math.min(frases.length, 4)) || 1, 1, MAX_ESCENAS - 1);

  const escenas: Escena[] = [];
  for (let i = 0; i < cuantas; i++) {
    const frase = frases[i];
    escenas.push({
      // Round-robin: con una sola imagen se repite, que es exactamente lo que ya pasaba
      // y no empeora nada; con varias, cada escena estrena.
      imagen: imagenes.length ? i % imagenes.length : null,
      titulo: frase ? recortarPalabras(frase, MAX_TITULO) : undefined,
      movimiento: movimientoPorPosicion(i),
      duracion_seg: ESCENA_SEG_DEFECTO,
      transicion: i === 0 ? "corte" : i % 2 === 0 ? "desliz" : "fundido",
    });
  }

  // El cierre solo si hay algo que poner en él. Sin marca ni frase sería una tarjeta en
  // blanco de dos segundos al final, que se ve como un fallo del montaje. Y va con la
  // MISMA condición que en `normalizarGuion`: dos reglas distintas para «¿lleva cierre?»
  // harían que un guion por defecto normalizado no fuese igual a sí mismo.
  if (opts.cierre || marca) {
    escenas.push({
      imagen: null,
      titulo: opts.cierre ? recortarPalabras(opts.cierre, MAX_TITULO) : recortarPalabras(marca!, MAX_TITULO),
      texto: opts.cierre && marca ? recortarPalabras(marca, MAX_SUBTEXTO) : undefined,
      movimiento: "estatico",
      duracion_seg: CIERRE_SEG,
      transicion: "fundido",
      tipo: "cierre",
    });
  }

  // El piso del total también aquí: una sola frase corta daría un video de 3 s que
  // Instagram y TikTok rechazan, y el defecto no puede producir algo impublicable.
  const total = escenas.reduce((s, e) => s + e.duracion_seg, 0);
  if (total < MIN_TOTAL_SEG && escenas.length) {
    const ultima = escenas[escenas.length - 1];
    ultima.duracion_seg = Math.round((ultima.duracion_seg + (MIN_TOTAL_SEG - total)) * 10) / 10;
  }

  return { escenas, marca: marca ? recortarPalabras(marca, MAX_MARCA) : undefined };
}

// ── Normalización ─────────────────────────────────────────────────────────────

export type GuionNormalizado = {
  guion: Guion;
  avisos: CodigoGuion[];
  /** `true` cuando no quedó nada del guion recibido y se cayó al de defecto. */
  usoDefecto: boolean;
};

/**
 * Convierte cualquier cosa (lo que devolvió el modelo, lo que hay guardado en jsonb, lo
 * que acaba de editar el operador) en un `Guion` que el montador puede pintar.
 *
 * ES IDEMPOTENTE: normalizar un guion ya normalizado devuelve el mismo guion y ningún
 * aviso. Hace falta porque se llama en tres sitios —al recibirlo del modelo, al leerlo de
 * la base y antes de montar— y si no lo fuera, la tarjeta de cierre se duplicaría en cada
 * pasada. Por eso el cierre se reconoce por `tipo`, no por ser el último.
 */
export function normalizarGuion(crudo: unknown, opts: OpcionesDefecto): GuionNormalizado {
  const avisos = new Set<CodigoGuion>();
  const nImg = opts.imagenes.length;
  if (!nImg) avisos.add("sin_imagenes");

  const escenasCrudas: any[] = Array.isArray((crudo as any)?.escenas)
    ? (crudo as any).escenas
    : Array.isArray(crudo)
      ? (crudo as any[])
      : [];

  if (!escenasCrudas.length) {
    const g = guionPorDefecto(opts);
    avisos.add("sin_escenas");
    return { guion: g, avisos: [...avisos], usoDefecto: true };
  }

  if (escenasCrudas.length > MAX_ESCENAS) avisos.add("escenas_recortadas");

  const escenas: Escena[] = [];
  escenasCrudas.slice(0, MAX_ESCENAS).forEach((e: any, i: number) => {
    // ── Imagen ──
    let imagen: number | null = null;
    const bruto = e?.imagen ?? e?.imagen_index ?? e?.indice_imagen;
    if (bruto !== null && bruto !== undefined && bruto !== "") {
      const n = Math.trunc(Number(bruto));
      if (Number.isFinite(n) && nImg > 0) {
        // Se da la vuelta en vez de descartar la escena: descartarla perdería su TEXTO,
        // que es lo único que el modelo aportó de verdad. Lo peor que puede pasar al
        // envolver es repetir una foto, que es lo que ya hace un guion de una imagen.
        if (n < 0 || n >= nImg) avisos.add("imagen_fuera_de_rango");
        imagen = ((n % nImg) + nImg) % nImg;
      }
    }

    // ── Movimiento y transición ──
    let movimiento = e?.movimiento as Movimiento;
    if (!MOVIMIENTOS.includes(movimiento)) {
      if (e?.movimiento) avisos.add("valor_desconocido");
      movimiento = movimientoPorPosicion(i);
    }
    let transicion = e?.transicion as Transicion;
    if (!TRANSICIONES.includes(transicion)) {
      if (e?.transicion) avisos.add("valor_desconocido");
      transicion = i === 0 ? "corte" : "fundido";
    }
    // La primera escena no entra de ninguna parte: no hay nada antes de ella con lo que
    // fundir ni desde donde deslizar, y forzarlo dejaría medio segundo de negro al abrir.
    if (i === 0) transicion = "corte";

    // ── Duración ──
    const brutoDur = Number(e?.duracion_seg ?? e?.duracion ?? ESCENA_SEG_DEFECTO);
    const dur = Number.isFinite(brutoDur) && brutoDur > 0 ? brutoDur : ESCENA_SEG_DEFECTO;
    const duracion = Math.round(acotar(dur, MIN_ESCENA_SEG, MAX_ESCENA_SEG) * 10) / 10;
    if (Math.abs(duracion - dur) > 0.05) avisos.add("duracion_ajustada");

    // ── Textos ──
    const tituloBruto = typeof e?.titulo === "string" ? e.titulo.trim() : "";
    const textoBruto = typeof e?.texto === "string" ? e.texto.trim() : "";
    const tituloLimpio = limpiarTextoPantalla(tituloBruto);
    const textoLimpio = limpiarTextoPantalla(textoBruto);
    if (tituloLimpio !== tituloBruto || textoLimpio !== textoBruto) avisos.add("hashtag_quitado");
    const titulo = tituloLimpio ? recortarPalabras(tituloLimpio, MAX_TITULO) : undefined;
    const texto = textoLimpio ? recortarPalabras(textoLimpio, MAX_SUBTEXTO) : undefined;
    if ((titulo && titulo !== tituloLimpio) || (texto && texto !== textoLimpio)) {
      avisos.add("texto_recortado");
    }

    escenas.push({
      imagen,
      titulo,
      texto,
      movimiento,
      duracion_seg: duracion,
      transicion,
      ...(e?.tipo === "cierre" ? { tipo: "cierre" as const } : {}),
    });
  });

  // ── Cierre ──
  // Solo si no vino ya uno. Es lo que hace idempotente la función: sin esta comprobación,
  // guardar y reabrir el guion tres veces dejaría tres tarjetas finales.
  const hayCierre = escenas.some((e) => e.tipo === "cierre");
  if (!hayCierre && escenas.length < MAX_ESCENAS && (opts.cierre || opts.marca)) {
    escenas.push({
      imagen: null,
      titulo: recortarPalabras(opts.cierre || opts.marca || "", MAX_TITULO),
      texto: opts.cierre && opts.marca ? recortarPalabras(opts.marca, MAX_SUBTEXTO) : undefined,
      movimiento: "estatico",
      duracion_seg: CIERRE_SEG,
      transicion: "fundido",
      tipo: "cierre",
    });
  }

  // ── Piso del total ──
  // Se alarga la ÚLTIMA escena, nunca se reparte entre todas: repartir movería el ritmo
  // que el guion declaró, y lo que hace falta es un segundo más de aire al final.
  const total = escenas.reduce((s, e) => s + e.duracion_seg, 0);
  if (total < MIN_TOTAL_SEG && escenas.length) {
    const ultima = escenas[escenas.length - 1];
    ultima.duracion_seg = Math.round((ultima.duracion_seg + (MIN_TOTAL_SEG - total)) * 10) / 10;
    avisos.add("total_alargado");
  }

  const marcaBruta = typeof (crudo as any)?.marca === "string" ? (crudo as any).marca.trim() : "";
  const marca = (marcaBruta || opts.marca || "").trim();

  return {
    guion: { escenas, marca: marca ? recortarPalabras(marca, MAX_MARCA) : undefined },
    avisos: [...avisos],
    usoDefecto: false,
  };
}

/**
 * Resumen de una línea por escena, para la pantalla y para el log.
 *
 * Vive aquí y no en el TSX por lo mismo que `describirHorario`: una frase compuesta
 * dentro de la pantalla puede describir al revés lo que hace el motor sin que nada falle.
 */
export function describirEscena(e: Escena, i: number): string {
  const que = e.tipo === "cierre" ? "cierre" : e.imagen === null ? "tarjeta" : `foto ${e.imagen + 1}`;
  const mov: Record<Movimiento, string> = {
    zoom_in: "acercándose",
    zoom_out: "alejándose",
    pan_izq: "paneo a la izquierda",
    pan_der: "paneo a la derecha",
    estatico: "fija",
  };
  return `${i + 1}. ${que} · ${e.duracion_seg} s · ${mov[e.movimiento]}${
    e.titulo ? ` · «${e.titulo}»` : " · sin texto"
  }`;
}
