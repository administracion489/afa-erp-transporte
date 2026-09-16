// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/plan.ts — El MOTOR de la publicación diaria. Módulo PURO: recibe la
// publicación, las cuentas conectadas y el reloj, y devuelve qué sale en cada red y
// POR QUÉ no sale en las demás. No lee la base, no llama a ninguna API, no importa
// nada del ERP.
//
// POR QUÉ EXISTE SEPARADO DEL DESPACHADOR
// El mismo veredicto lo necesitan DOS consumidores que corren en momentos distintos:
// la pantalla de aprobación (que tiene que decir "esto va a salir en tres de cinco, y
// en Instagram no porque el texto pasa de 2200") y el cron que publica de madrugada.
// Con la regla repartida, la pantalla enseña una cosa y el cron hace otra — que es
// exactamente el bug del semáforo de puntualidad de este repo, donde las dos mitades
// del tablero se contradecían en la misma pantalla. Hay UN motor y los dos lo importan.
//
// LA DECISIÓN DE ORDEN QUE SOSTIENE TODO EL MÓDULO
// Los controles de CONTENIDO (texto largo, falta video, duración) van ANTES de los de
// MOMENTO (sin aprobar, fuera de horario, cuota). Parece cosmético y no lo es: si
// `sin_aprobar` ganara, la pantalla de revisión diría "esperando tu aprobación" en las
// cinco filas y jamás enseñaría que el caption de Instagram no cabe. El operador
// aprueba, se va, y el fallo aparece de madrugada en un log que nadie lee. Se avisa
// ANTES de guardar, que es la misma conclusión que la ventana invertida del horario
// del conductor y el `hora_fija` inerte: lo que se puede arreglar mirándolo, se dice
// mientras se está mirando.
// ──────────────────────────────────────────────────────────────────────────────

import {
  CAPACIDADES,
  REDES,
  contarHashtags,
  largoTexto,
  motivoEsProblema,
  type ModoVideo,
  type MotivoDestino,
  type Red,
  type TipoMedia,
} from "./tipos";

// ── Entrada ───────────────────────────────────────────────────────────────────

/**
 * Una pieza de contenido ya subida al bucket.
 *
 * `publica` NO es decoración y NO se puede deducir aquí: Facebook e Instagram no
 * reciben el archivo, reciben una URL y la descargan desde sus servidores. Una signed
 * URL de Supabase caduca, y un bucket privado devuelve 400 sin decir por qué. Quién
 * sabe si el bucket es público es la capa de datos, así que lo DECLARA y el motor lo
 * cree. Un motor que intentara comprobarlo dejaría de ser puro y tardaría un segundo
 * por red en una función que la pantalla llama en cada tecla.
 */
export type Media = {
  tipo: "imagen" | "video";
  url: string;
  /** ¿La URL se puede abrir sin credenciales desde fuera? */
  publica: boolean;
  /** Solo en video. Segundos. `null` si todavía no se ha medido. */
  duracion_seg?: number | null;
};

export type CuentaConectada = {
  red: Red;
  /** `false` cuando el token caducó o lo revocaron desde la plataforma. */
  vigente: boolean;
  /** Cuántas publicaciones lleva hoy esta cuenta. Alimenta `cuota_agotada`. */
  publicadas_hoy?: number;
};

export type PublicacionEnPlan = {
  /** Texto del día. Es el mismo para todas las redes; cada una lo mide con su tope. */
  texto: string;
  /** La pieza gráfica del día. `null` si la publicación es de solo texto. */
  imagen: Media | null;
  /**
   * El video, cuando existe. Con `modo_video = "generado"` lo deja aquí el armador
   * (lib/redes/video.ts); con `"propio"` lo sube el operador.
   */
  video: Media | null;
  modo_video: ModoVideo;
  /** Redes que el operador dejó encendidas para ESTA publicación. */
  redes: Red[];
  /** ¿Ya la aprobó una persona? Sin esto no sale nada: es el trato de este módulo. */
  aprobada: boolean;
  /** Minuto del día (0–1439, hora de Lima) a partir del cual puede salir. */
  hora_programada_min: number;
  /** Redes en las que YA salió. El freno de idempotencia de los reintentos. */
  ya_publicadas: Red[];
};

export type EntradaPlan = {
  publicacion: PublicacionEnPlan;
  cuentas: CuentaConectada[];
  /** Minuto del día actual, hora de Lima. */
  ahora_min: number;
};

// ── Salida ────────────────────────────────────────────────────────────────────

export type DestinoPlaneado = {
  red: Red;
  /** `true` solo con motivo `listo`. La matriz lo fija como invariante. */
  publica: boolean;
  motivo: MotivoDestino;
  /**
   * El detalle con los NÚMEROS del caso concreto ("sobran 340 caracteres", "el video
   * dura 2 s y el mínimo son 3"). El texto genérico del motivo vive en el catálogo;
   * esto es lo que no se puede escribir de antemano.
   */
  detalle?: string;
  /** Qué se le manda a la red, ya resuelto. Sirve para que la pantalla lo muestre. */
  lleva: TipoMedia;
};

export type PlanPublicacion = {
  destinos: DestinoPlaneado[];
  /** Las que salen. Disjunta y exhaustiva con `retenidos` sobre `destinos`. */
  publican: Red[];
  /** Las que no salen, por el motivo que sea. */
  retenidos: Red[];
  /**
   * Las que no salen POR ALGO QUE ALGUIEN TIENE QUE ATENDER. Subconjunto de
   * `retenidos`: deja fuera las apagadas a propósito, la cuota agotada y el estado de
   * WhatsApp, que no son fallos. Es lo que la pantalla pinta en ámbar.
   */
  con_problema: Red[];
};

// ── El motor ──────────────────────────────────────────────────────────────────

/**
 * Qué pieza le toca a esta red, resuelta con el modo de video del día.
 *
 * Aquí es donde conviven las tres opciones que pidió el dueño: una red de video recibe
 * el video venga de donde venga (`generado` o `propio`) y una red de imagen prefiere
 * SIEMPRE la imagen aunque haya video — un Reel automático en el feed de Facebook rinde
 * peor que la foto, y el operador eligió la foto al subirla.
 */
function piezaPara(red: Red, p: PublicacionEnPlan): Media | null {
  const cap = CAPACIDADES[red];
  const aceptaImagen = cap.acepta.includes("imagen");
  const aceptaVideo = cap.acepta.includes("video");

  if (!aceptaImagen && aceptaVideo) return p.video;
  if (aceptaImagen && p.imagen) return p.imagen;
  if (aceptaVideo && p.video) return p.video;
  return null;
}

function planDeRed(red: Red, e: EntradaPlan): DestinoPlaneado {
  const p = e.publicacion;
  const cap = CAPACIDADES[red];
  const pieza = piezaPara(red, p);
  const lleva: TipoMedia = pieza?.tipo ?? "ninguna";
  const base = { red, publica: false, lleva };

  // 1 ── YA SALIÓ. Va primero y gana a todo, incluida la aprobación: un reintento del
  // cron, un doble clic en el botón o un reproceso NO pueden publicar dos veces. Es la
  // misma lección que `lib/radar/reproceso.ts`: lo comprometido no se repite.
  if (p.ya_publicadas.includes(red)) return { ...base, motivo: "ya_publicada" };

  // 2 ── EL OPERADOR LA APAGÓ. Antes que cualquier diagnóstico: decirle "conecta
  // Instagram" sobre una red que acaba de apagar a mano es ruido, y el ruido en este
  // panel se paga caro — es el mismo sitio donde avisa la cuenta caducada.
  if (!p.redes.includes(red)) return { ...base, motivo: "red_apagada" };

  // 3 ── LA CUENTA. Para el estado de WhatsApp la "cuenta" es a quién se le manda la
  // pieza al celular; sin eso el kit no tiene destinatario y tampoco se puede armar.
  const cuenta = e.cuentas.find((c) => c.red === red);
  if (!cuenta) return { ...base, motivo: "sin_cuenta" };
  if (!cuenta.vigente) return { ...base, motivo: "cuenta_caducada" };

  // 4 ── EL CONTENIDO. Todo lo que se arregla editando, y por eso va antes que la
  // aprobación: se dice mientras la persona lo tiene delante.

  if (!pieza && !cap.acepta.includes("ninguna")) {
    // Distinguir los dos vacíos importa porque se arreglan en sitios distintos: a una
    // red de video con la imagen cargada no le falta "una imagen", le falta un video.
    if (!cap.acepta.includes("imagen")) {
      if (p.modo_video === "ninguno") {
        return {
          ...base,
          motivo: "falta_video",
          detalle: "Hoy la publicación es solo de imagen (modo «sin video»).",
        };
      }
      return {
        ...base,
        motivo: "video_no_armado",
        detalle:
          p.modo_video === "generado"
            ? "El agente todavía no ha armado el Reel/Short, o falló al armarlo."
            : "El modo es «video propio» y no hay ningún archivo cargado.",
      };
    }
    return { ...base, motivo: "falta_media" };
  }

  if (pieza) {
    // La red DESCARGA el archivo: sin URL pública, el 400 de Meta no nombra la causa.
    if (cap.descargaElArchivo && !pieza.publica) {
      return { ...base, motivo: "media_no_publica" };
    }
    // Duración. `null` es "todavía no medida" y NO se juzga: afirmar que un video dura
    // mal sin haberlo medido es inventar, y el lado seguro es dejar que opine la red.
    if (pieza.tipo === "video" && cap.duracionVideoSeg && pieza.duracion_seg != null) {
      const { min, max } = cap.duracionVideoSeg;
      if (pieza.duracion_seg < min || pieza.duracion_seg > max) {
        return {
          ...base,
          motivo: "duracion_video",
          detalle: `El video dura ${pieza.duracion_seg} s y ${cap.etiqueta} admite de ${min} a ${max} s.`,
        };
      }
    }
  }

  const largo = largoTexto(p.texto);
  if (largo > cap.maxTexto) {
    return {
      ...base,
      motivo: "texto_largo",
      detalle: `Sobran ${largo - cap.maxTexto} caracteres (${largo} de ${cap.maxTexto}).`,
    };
  }

  if (cap.maxHashtags > 0) {
    const n = contarHashtags(p.texto);
    if (n > cap.maxHashtags) {
      return {
        ...base,
        motivo: "exceso_hashtags",
        detalle: `${n} hashtags y ${cap.etiqueta} cuenta ${cap.maxHashtags}: por encima del tope los ignora todos.`,
      };
    }
  }

  // 5 ── EL MOMENTO. Lo que no se arregla editando.

  if (!p.aprobada) return { ...base, motivo: "sin_aprobar" };

  if (e.ahora_min < p.hora_programada_min) {
    return {
      ...base,
      motivo: "fuera_de_horario",
      detalle: `Sale a las ${hhmm(p.hora_programada_min)}.`,
    };
  }

  const hechas = cuenta.publicadas_hoy ?? 0;
  if (cap.maxPorDia != null && hechas >= cap.maxPorDia) {
    return {
      ...base,
      motivo: "cuota_agotada",
      detalle: `Lleva ${hechas} de ${cap.maxPorDia} hoy.`,
    };
  }

  // 6 ── NO HAY API. Terminal para el estado de WhatsApp, y es lo último a propósito:
  // llegar hasta aquí significa que la pieza está completa y aprobada, o sea que el kit
  // se puede armar de verdad. Ponerlo arriba habría escondido que al estado le faltaba
  // la imagen, y el operador se habría enterado con el celular en la mano.
  if (!cap.publicaPorApi) return { ...base, motivo: "publicacion_manual" };

  return { ...base, publica: true, motivo: "listo" };
}

/** `830` → `"13:50"`. Minuto del día a hora de reloj. */
export function hhmm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = ((min % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * El plan completo. `destinos` trae SIEMPRE las cinco redes: una red que no apareciera
 * en la lista sería una red que la pantalla no explica en ningún sitio, que es el
 * defecto que este repo persigue con `aportan`/`observadas` disjuntas y exhaustivas.
 */
export function planDePublicacion(e: EntradaPlan): PlanPublicacion {
  const destinos = REDES.map((red) => planDeRed(red, e));
  return {
    destinos,
    publican: destinos.filter((d) => d.publica).map((d) => d.red),
    retenidos: destinos.filter((d) => !d.publica).map((d) => d.red),
    // El juicio de "esto es un problema" vive en el catálogo y se IMPORTA. Tenerlo aquí
    // otra vez sería la segunda definición de la misma pregunta, que es como una se
    // queda atrás el día que se añade un motivo.
    con_problema: destinos.filter((d) => !d.publica && motivoEsProblema(d.motivo)).map((d) => d.red),
  };
}
