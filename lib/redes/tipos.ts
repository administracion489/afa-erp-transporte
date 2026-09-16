// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/tipos.ts — El CATÁLOGO de redes sociales. Módulo PURO: no lee la base,
// no llama a ninguna API, no importa nada del ERP.
//
// POR QUÉ ESTO ES UN CATÁLOGO Y NO UN `if` DENTRO DE CADA PUBLICADOR
// Las cinco salidas no aceptan lo mismo y confundirlo es el defecto entero de este
// módulo: Instagram RECHAZA un post sin imagen, YouTube RECHAZA cualquier cosa que no
// sea un video, y Facebook acepta las tres formas. Un publicador que descubre eso al
// recibir el 400 de Meta ya gastó la llamada, ya dejó la fila a medias y le dice al
// operador un mensaje de Meta en inglés. Lo que decide qué se puede mandar a cada red
// es un DATO declarado aquí, y el motor (lib/redes/plan.ts) lo lee antes de mover nada.
//
// Es la misma regla que `lib/combustible-tipos.ts`: lo que una carga puede ser lo dice
// el catálogo, no la pantalla que la registra ni el worker que la lee.
//
// LO QUE ESTE ARCHIVO NO HACE, Y ES DELIBERADO
// No sabe publicar. Los límites de aquí son los que las plataformas DECLARAN en su
// documentación, y una plataforma puede rechazar igual por algo que no está escrito
// en ningún sitio (una foto marcada por su clasificador, una canción con copyright).
// Por eso el publicador guarda SIEMPRE el error crudo de la API: este catálogo evita
// la llamada imposible, no promete que la posible vaya a salir.
// ──────────────────────────────────────────────────────────────────────────────

/** Las cinco salidas que pidió el dueño. El orden es el de la pantalla. */
export type Red = "facebook" | "instagram" | "tiktok" | "youtube" | "whatsapp_estado";

export const REDES: Red[] = ["facebook", "instagram", "tiktok", "youtube", "whatsapp_estado"];

/** Qué pieza de contenido lleva el post. */
export type TipoMedia = "ninguna" | "imagen" | "video";

/**
 * Cómo se resuelve el video del día. Las TRES opciones conviven y las elige el
 * operador por publicación — no hay una "buena" y dos de repuesto:
 *
 *   • `ninguno`  — hoy no hay video. Salen Facebook e Instagram con la imagen y las
 *                  redes de video se saltan DICIÉNDOLO (`falta_video`), en vez de
 *                  inventar un relleno. Es el modo por defecto.
 *   • `generado` — el agente monta un vertical 9:16 de VARIAS escenas sobre las fotos del
 *                  día: la IA las mira y escribe el guion (`lib/redes/guion.ts`) — qué se
 *                  ve en cada una, qué frase va encima, cuánto dura y cómo se mueve la
 *                  cámara— y `lib/redes/video.ts` lo pinta. Sale en las cuatro sin que
 *                  nadie grabe, y sigue siendo montaje sobre material que ya existía:
 *                  ningún modelo de Anthropic genera video.
 *   • `propio`   — alguien grabó y cargó el video. Es lo que de verdad rinde en TikTok
 *                  y en Shorts, y exige una persona con el celular.
 */
export type ModoVideo = "ninguno" | "generado" | "propio";

export const MODOS_VIDEO: ModoVideo[] = ["ninguno", "generado", "propio"];

export const ETIQUETA_MODO_VIDEO: Record<ModoVideo, string> = {
  ninguno: "Sin video hoy (solo imagen)",
  generado: "Que el agente dirija y arme el Reel/Short",
  propio: "Video propio (lo cargo yo)",
};

/**
 * Lo que cada red acepta. Todo lo de aquí sale de la documentación pública de la
 * plataforma; el comentario de cada campo dice de dónde y qué pasa si se ignora.
 */
export type CapacidadRed = {
  red: Red;
  /** Cómo se llama de cara al operador. */
  etiqueta: string;
  /**
   * Formas de contenido que la red PUBLICA. Instagram y TikTok no tienen post de solo
   * texto; YouTube no tiene nada que no sea video.
   */
  acepta: TipoMedia[];
  /**
   * Tope de caracteres del texto (caption / descripción). Superarlo es un 400 de la
   * API, así que el motor lo mide ANTES y la pantalla lo dice mientras se escribe.
   */
  maxTexto: number;
  /** Tope de hashtags que la red cuenta como válidos. 0 = no lo limita. */
  maxHashtags: number;
  /**
   * La red DESCARGA el archivo desde una URL que tiene que ser pública (Meta e
   * Instagram lo hacen así: se les pasa `image_url` y su servidor la busca). Con una
   * signed URL de Supabase que caduca, o con un bucket privado, la publicación falla
   * con un error que no nombra la causa. Ver `media_no_publica` en plan.ts.
   */
  descargaElArchivo: boolean;
  /**
   * `false` significa que NO existe API de publicación y no la va a haber: el agente
   * prepara la pieza y la publica una persona. Hoy solo el estado de WhatsApp.
   */
  publicaPorApi: boolean;
  /**
   * Cuántas publicaciones al día tolera la cuenta. `null` = la red no lo limita de
   * forma que nos afecte publicando una vez al día.
   *
   *   • Instagram: 50 posts / 24 h por cuenta (Content Publishing API).
   *   • YouTube:   la cuota por defecto de la Data API es 10 000 unidades/día y cada
   *                `videos.insert` cuesta 1 600 → 6 subidas al día, no más.
   */
  maxPorDia: number | null;
  /** Segundos de video que la red admite. `null` en las que no publican video. */
  duracionVideoSeg: { min: number; max: number } | null;
  /**
   * Nota operativa que la pantalla muestra al conectar la cuenta. No es decoración:
   * son los tres sitios donde este módulo depende de un trámite con la plataforma y
   * no de código, y callarlos deja a alguien esperando una publicación que no puede
   * salir.
   */
  advertencia?: string;
};

export const CAPACIDADES: Record<Red, CapacidadRed> = {
  facebook: {
    red: "facebook",
    etiqueta: "Facebook (Página)",
    // La Página publica las tres formas: /{page}/feed (texto), /{page}/photos,
    // /{page}/videos. Es la única salida que no exige pieza gráfica.
    acepta: ["ninguna", "imagen", "video"],
    maxTexto: 63206,
    maxHashtags: 0,
    descargaElArchivo: true,
    publicaPorApi: true,
    maxPorDia: null,
    duracionVideoSeg: { min: 1, max: 14400 },
  },
  instagram: {
    red: "instagram",
    etiqueta: "Instagram",
    // SIN pieza no hay post: la Content Publishing API no tiene endpoint de solo texto.
    acepta: ["imagen", "video"],
    maxTexto: 2200,
    maxHashtags: 30,
    descargaElArchivo: true,
    publicaPorApi: true,
    maxPorDia: 50,
    // Reels: de 3 s a 15 min.
    duracionVideoSeg: { min: 3, max: 900 },
    advertencia:
      "Exige cuenta Profesional (Empresa o Creador) vinculada a la Página de Facebook. " +
      "Una cuenta personal no puede publicar por API por más permisos que se le den.",
  },
  tiktok: {
    red: "tiktok",
    etiqueta: "TikTok",
    acepta: ["video"],
    maxTexto: 2200,
    maxHashtags: 0,
    descargaElArchivo: false,
    publicaPorApi: true,
    maxPorDia: null,
    duracionVideoSeg: { min: 3, max: 600 },
    advertencia:
      "Hasta que TikTok audite la app, la Content Posting API solo deja dejar el video " +
      "en BORRADORES de la cuenta: llega al celular y alguien le da publicar desde la " +
      "app. La publicación directa se habilita sola cuando aprueban la auditoría — no " +
      "hay que tocar código.",
  },
  youtube: {
    red: "youtube",
    etiqueta: "YouTube",
    acepta: ["video"],
    // El TÍTULO son 100 caracteres; este tope es el de la DESCRIPCIÓN, que es donde va
    // el texto del día. El título se recorta aparte, en el publicador.
    maxTexto: 5000,
    maxHashtags: 15,
    descargaElArchivo: false,
    publicaPorApi: true,
    maxPorDia: 6,
    duracionVideoSeg: { min: 1, max: 43200 },
    advertencia:
      "Mientras la app de Google no pase la verificación OAuth, YouTube publica todo lo " +
      "que sube la API como PRIVADO y los refresh token caducan a los 7 días. Es una " +
      "revisión de Google, no un ajuste del ERP.",
  },
  whatsapp_estado: {
    red: "whatsapp_estado",
    etiqueta: "Estado de WhatsApp",
    acepta: ["imagen", "video"],
    // Un estado admite hasta 700 caracteres de texto superpuesto.
    maxTexto: 700,
    maxHashtags: 0,
    descargaElArchivo: false,
    // NO HAY API DE ESTADOS, Y NO ES UN PENDIENTE: la Cloud API de Meta no publica
    // estados y nunca ha tenido ese endpoint. Lo único que los publica es un cliente
    // no oficial tipo Baileys, y el CLAUDE.md de este repo prohíbe vincularlo a los
    // números que ya están en la Cloud API — el QR rompería la integración oficial.
    // Además un estado SOLO lo ven los contactos que tienen ese número guardado, así
    // que publicarlo desde el chip del Radar (que nadie tiene agendado) sería publicar
    // para nadie. Por eso el agente ARMA la pieza y la publica una persona desde el
    // +51 966 707 225, que es el número al que los clientes sí le escriben.
    publicaPorApi: false,
    maxPorDia: null,
    duracionVideoSeg: { min: 1, max: 60 },
    advertencia:
      "No existe API para publicar estados. El agente deja la pieza lista y te la manda " +
      "al celular; la publicas tú desde el número de atención al cliente.",
  },
};

/** Las que el agente publica solo. El estado de WhatsApp queda fuera por definición. */
export const REDES_AUTOMATICAS: Red[] = REDES.filter((r) => CAPACIDADES[r].publicaPorApi);

export const ETIQUETA_RED: Record<Red, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  whatsapp_estado: "Estado WhatsApp",
};

// ── Motivos ───────────────────────────────────────────────────────────────────
//
// EL MOTIVO SE DECLARA, NO SE OLFATEA. Cada código dice qué pasó y —lo que importa—
// DÓNDE se arregla, que es distinto en cada uno: uno se arregla conectando una cuenta,
// otro cargando un video, otro esperando a mañana. Colapsarlos en "no se pudo publicar"
// manda al operador a buscar en el sitio equivocado, que es el defecto que este repo ya
// pagó en `sin_kilometraje` y en el semáforo de puntualidad.

export type MotivoDestino =
  /** Sale. Es el único código que publica. */
  | "listo"
  /** La red no está conectada. Se arregla en /redes → Cuentas. */
  | "sin_cuenta"
  /** Hubo cuenta y el token ya no sirve (caducó o lo revocaron). Se reconecta. */
  | "cuenta_caducada"
  /** El operador apagó esta red para ESTA publicación. No es un fallo. */
  | "red_apagada"
  /** Nadie la ha aprobado todavía. Se arregla con el botón de la pantalla. */
  | "sin_aprobar"
  /** La red exige pieza gráfica y la publicación no trae ninguna. */
  | "falta_media"
  /** La red exige VIDEO y hoy la publicación es de imagen (modo «sin video»). */
  | "falta_video"
  /**
   * La red exige video, el día SÍ iba a tener uno, y no está: el agente no llegó a
   * armarlo o falló, o el modo es «propio» y nadie cargó el archivo. Es un código
   * aparte de `falta_video` porque se arregla en otro sitio — ahí no falta una
   * decisión, falta el archivo.
   */
  | "video_no_armado"
  /** El texto pasa el tope de la red. Se recorta en el editor. */
  | "texto_largo"
  /** Demasiados hashtags para lo que la red cuenta como válido. */
  | "exceso_hashtags"
  /** El video dura menos del mínimo o más del máximo de esa red. */
  | "duracion_video"
  /** La red descarga el archivo y la URL no es pública o ya caducó. */
  | "media_no_publica"
  /** Se agotó lo que la cuenta admite hoy (IG 50, YouTube 6 por cuota de API). */
  | "cuota_agotada"
  /** Ya salió. Es el freno de la idempotencia: un reintento no vuelve a publicar. */
  | "ya_publicada"
  /** Aprobada, pero todavía no es su hora. */
  | "fuera_de_horario"
  /** No hay API: el agente prepara la pieza y publica una persona. */
  | "publicacion_manual";

/**
 * Qué significa cada motivo, dónde se arregla y si ALARMA. La pantalla enruta por
 * CÓDIGO y saca de aquí el texto — nunca redacta el suyo, que es como dos pantallas
 * terminan explicando distinto el mismo estado.
 *
 * `problema` se declara AQUÍ, pegado al texto de su motivo, y no en una lista aparte:
 * una lista negativa («todos menos estos seis») hay que acordarse de actualizarla el
 * día que se añade un motivo, y lo que pasa entonces es que el motivo nuevo hereda el
 * ámbar sin que nadie lo haya decidido.
 *
 * La regla para ponerlo en `true`: ¿hay alguien que tenga que HACER algo? Una red que
 * el operador apagó, una cuota agotada que se resuelve mañana sola y un estado de
 * WhatsApp que por definición publica una persona describen un sistema funcionando
 * bien. Pintarlos de ámbar enseñaría a ignorar el ámbar de la cuenta caducada, que es
 * el único que de verdad deja de publicar sin que nadie se entere.
 */
export const MOTIVO_TEXTO: Record<
  MotivoDestino,
  { titulo: string; arreglo: string; problema: boolean }
> = {
  listo: { titulo: "Listo para publicar", arreglo: "", problema: false },
  sin_cuenta: {
    titulo: "Cuenta no conectada",
    arreglo: "Conéctala en /redes → Cuentas.",
    problema: true,
  },
  cuenta_caducada: {
    titulo: "La conexión caducó",
    arreglo: "Vuelve a conectar la cuenta en /redes → Cuentas. No se pierde nada de lo publicado.",
    // El ámbar más importante del panel: la cuenta sigue figurando como conectada y
    // deja de publicar en silencio.
    problema: true,
  },
  red_apagada: {
    titulo: "Apagada para esta publicación",
    arreglo: "Enciéndela en el selector de redes de esta publicación.",
    problema: false,
  },
  sin_aprobar: {
    titulo: "Esperando tu aprobación",
    arreglo: "Revisa el texto y pulsa «Aprobar y publicar».",
    // Es el estado normal de TODA propuesta recién nacida. En ámbar saldría cada
    // mañana en las cinco filas.
    problema: false,
  },
  falta_media: {
    titulo: "Esta red no publica solo texto",
    arreglo: "Sube una imagen o un video a la publicación.",
    problema: true,
  },
  falta_video: {
    titulo: "Esta red solo publica video",
    arreglo:
      "Elige «Que el agente arme el Reel/Short» o carga tu propio video en el modo de video del día.",
    // NO alarma, y es la distinción que justifica que exista `video_no_armado` aparte.
    // «Sin video hoy» es el modo por DEFECTO: pintar ámbar aquí sacaría dos avisos cada
    // día de cada publicación de solo imagen, o sea casi todas, y en un mes nadie mira
    // ya el color de esta pantalla. Que YouTube y TikTok no salgan no es un fallo del
    // sistema: es lo que el operador pidió.
    problema: false,
  },
  video_no_armado: {
    titulo: "Falta el archivo de video",
    arreglo:
      "Pulsa «Armar video» para que el agente lo monte, o carga el tuyo. Si el armado ya " +
      "falló, el error concreto sale en el detalle de la publicación.",
    // Aquí SÍ: el operador pidió video y no está. La expectativa quedó rota.
    problema: true,
  },
  texto_largo: {
    titulo: "El texto pasa el límite de la red",
    arreglo: "Recórtalo en el editor; la pantalla te dice cuántos caracteres sobran.",
    problema: true,
  },
  exceso_hashtags: {
    titulo: "Demasiados hashtags",
    arreglo: "Quita los que sobren; por encima del tope la red los ignora todos.",
    problema: true,
  },
  duracion_video: {
    titulo: "El video no dura lo que pide la red",
    arreglo: "Recorta o alarga el video, o desactiva esta red para esta publicación.",
    problema: true,
  },
  media_no_publica: {
    titulo: "La red no puede descargar el archivo",
    arreglo:
      "Facebook e Instagram bajan la pieza desde una URL pública. Revisa que el bucket " +
      "de publicaciones sea público en Supabase → Storage.",
    problema: true,
  },
  cuota_agotada: {
    titulo: "Se agotó la cuota de hoy",
    arreglo: "Se publica mañana. No hay nada que arreglar.",
    problema: false,
  },
  ya_publicada: {
    titulo: "Ya se publicó",
    arreglo: "",
    problema: false,
  },
  fuera_de_horario: {
    titulo: "Todavía no es su hora",
    arreglo: "Sale a la hora programada. Puedes adelantarla con «Publicar ahora».",
    problema: false,
  },
  publicacion_manual: {
    titulo: "La publicas tú",
    arreglo:
      "No existe API para estados de WhatsApp. El agente te manda la pieza al celular y " +
      "la publicas desde el número de atención al cliente.",
    // No es un fallo: es cómo funciona esta salida y cómo va a seguir funcionando.
    problema: false,
  },
};

/**
 * ¿Este motivo es un PROBLEMA que alguien tiene que atender, o el sistema haciendo lo
 * correcto? La pantalla pinta en ámbar solo los primeros.
 *
 * NO tiene lista propia: lee la bandera que cada motivo DECLARA junto a su texto. Una
 * segunda lista aquí sería la misma pregunta contestada en dos sitios, y el día que se
 * añada un motivo una de las dos se queda atrás — el patrón que este repo ya pagó con
 * el semáforo de puntualidad.
 */
export function motivoEsProblema(motivo: MotivoDestino): boolean {
  return MOTIVO_TEXTO[motivo].problema;
}

// ── Utilidades de texto ───────────────────────────────────────────────────────

/**
 * Cuenta hashtags como los cuenta una red social: `#palabra` precedido de espacio o
 * de inicio de línea. Un `#` suelto o un `a#b` no son hashtags, y contarlos haría
 * saltar `exceso_hashtags` sobre un texto correcto.
 */
export function contarHashtags(texto: string): number {
  return (texto.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/**
 * Los caracteres que la red va a contar. Se normaliza a NFC porque una tilde escrita
 * como letra + diacrítico ocupa dos posiciones y la cuenta saldría distinta de la de
 * la plataforma justo en castellano, que es todo lo que se publica aquí.
 */
export function largoTexto(texto: string): number {
  return [...texto.normalize("NFC")].length;
}
