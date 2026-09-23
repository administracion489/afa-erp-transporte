// ──────────────────────────────────────────────────────────────────────────────
// lib/ocupacion/copia-interna.ts — A quién de AFA le llega copia del reporte.
//
// EL PROBLEMA
//
// La copia interna es el correo que le sale a AFA por cada cliente al que se le
// manda el reporte, y es la ÚNICA que lleva las sugerencias completas aunque el
// cliente las tenga apagadas: la propuesta comercial la tiene que ver quien puede
// decidirla. Hasta ahora su destinatario vivía en `REPORTE_OCUPACION_CORREOS`, una
// variable de entorno de Vercel, con `empresa_perfil.email` de respaldo.
//
// O sea: un control que el sistema LEE y que nadie puede tocar desde una pantalla.
// Es el mismo defecto que `vehiculos_tercero.capacidad_tanque` sin formulario y que
// `multiples_recargas_en_cluster` declarado y sin emitir — no falla, no avisa, y
// deja a alguien esperando (o sin esperar) un correo que no puede gobernar. Lo
// reportó el dueño con esas palabras: «mejor que esté detallado, o un botón para
// activar o desactivar el envío al área de operaciones de AFA».
//
// ─── SE DECIDE UNA VEZ, NO POR CLIENTE ──────────────────────────────────────
//
// El interruptor del CLIENTE es por cliente porque enseñarle «te cabe una unidad
// más chica» es una decisión comercial sobre ESE cliente. La copia interna es al
// revés: es el buzón de AFA, y lo que AFA necesita es verlas TODAS. Por cliente
// sería una casilla que alguien tiene que acordarse de marcar, y el día que no la
// marque el área de operaciones deja de ver las sugerencias de ese cliente sin que
// nada lo diga. Una sola fila no puede desalinearse.
//
// ─── SOLO UN `false` EXPLÍCITO APAGA ────────────────────────────────────────
//
// `null` y `undefined` NO apagan. Es lo que hace segura la migración: sin la tabla
// —o con la fila recién creada— el comportamiento es byte a byte el de antes, la
// cascada de direcciones sigue cayendo a la variable de entorno y al perfil de la
// empresa, y correr un SQL accesorio no le apaga la copia a nadie. Misma regla que
// `tanque_lleno` y que `horarioDe`. La migración abre el control, no toma la
// decisión.
//
// ─── `sale` NO ES «LA CASILLA ESTÁ MARCADA» ─────────────────────────────────
//
// Es «va a salir de verdad». Con la casilla marcada y sin ninguna dirección en toda
// la cascada, la copia NO sale — y esa es justamente la combinación que una pantalla
// vuelve mentirosa: el operador ve el visto y no le llega nada. Por eso ese caso
// tiene su propio código y es el único que pinta ámbar: apagarla a propósito no
// alarma (lo acaba de hacer una persona, mirando la casilla), pero encenderla y que
// no salga sí, porque nada más lo dice.
// ──────────────────────────────────────────────────────────────────────────────

/** De dónde salieron las direcciones. Cada una se corrige en otro sitio. */
export type FuenteCopia = "configurada" | "variable_entorno" | "perfil_empresa";

export type CodigoCopia =
  /** Sale, y se sabe a quién. */
  | "activa"
  /** Alguien la apagó. No sale, y es lo que se pidió. */
  | "apagada"
  /** Encendida y sin ninguna dirección en toda la cascada: NO sale. */
  | "sin_destinatario";

export type CopiaInterna = {
  /** ¿Va a salir de verdad? NO es «la casilla está marcada» — ver la cabecera. */
  sale: boolean;
  correos: string[];
  fuente: FuenteCopia | null;
  codigo: CodigoCopia;
};

/** Fila única de `reporte_ocupacion_config`. `null`/`undefined` = sin migración. */
export type FilaCopia = {
  copia_afa_activa?: boolean | null;
  copia_afa_correos?: string | null;
};

/**
 * Parte una lista de correos escrita a mano. Admite coma, punto y coma y CUALQUIER
 * espacio en blanco (saltos de línea incluidos), igual que el campo por cliente y
 * que `config_mantenimiento.correos_alerta`.
 *
 * ES EL `correosDe` DEL ROUTE, MUDADO ACÁ, NO UNA SEGUNDA VERSIÓN. El route lo
 * importa y ya no define el suyo: dos formas de partir la misma lista es cómo una
 * pantalla enseña dos destinatarios donde el cron ve uno — y con el separador
 * cambiado, una lista pegada con espacios se leería como una sola dirección
 * inexistente, que es un correo que no sale y nadie sabe por qué.
 */
export function correosDeTexto(txt: unknown): string[] {
  return String(txt ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

/**
 * Resuelve si la copia interna sale y a quién, con su procedencia.
 *
 * Lo usan el cron y la pantalla. Que sea el MISMO motor es el punto: una pantalla
 * con su propia cuenta de «a quién le va a llegar» terminaría enseñando una lista y
 * el cron mandando a otra — el bug del semáforo de puntualidad, con el agravante de
 * que acá el desacuerdo se manda por correo.
 */
export function resolverCopiaInterna(entrada: {
  fila?: FilaCopia | null;
  /** `REPORTE_OCUPACION_CORREOS`. Sigue valiendo: no se rompe lo ya configurado. */
  env?: string | null;
  /** `empresa_perfil.email`, el último escalón. */
  emailEmpresa?: string | null;
}): CopiaInterna {
  // Solo un `false` explícito apaga. Ver la cabecera.
  if (entrada.fila?.copia_afa_activa === false) {
    return { sale: false, correos: [], fuente: null, codigo: "apagada" };
  }

  // Lo más específico gana, y cada escalón declara su nombre porque cada uno se
  // corrige en otro sitio: la pantalla, Vercel, o /configuracion/perfil.
  const cascada: { correos: string[]; fuente: FuenteCopia }[] = [
    { correos: correosDeTexto(entrada.fila?.copia_afa_correos), fuente: "configurada" },
    { correos: correosDeTexto(entrada.env), fuente: "variable_entorno" },
    { correos: correosDeTexto(entrada.emailEmpresa), fuente: "perfil_empresa" },
  ];
  const elegido = cascada.find((x) => x.correos.length);

  if (!elegido) return { sale: false, correos: [], fuente: null, codigo: "sin_destinatario" };

  // Sin duplicados: la misma dirección dos veces en el campo mandaría dos correos.
  return {
    sale: true,
    correos: [...new Set(elegido.correos)],
    fuente: elegido.fuente,
    codigo: "activa",
  };
}

/** Dónde se corrige cada procedencia. La pantalla no lo redacta. */
export const FUENTE_COPIA: Record<FuenteCopia, string> = {
  configurada: "escritos acá",
  variable_entorno: "de la variable REPORTE_OCUPACION_CORREOS (Vercel)",
  perfil_empresa: "del correo de la empresa, en /configuracion/perfil",
};

/**
 * La frase de la pantalla, compuesta con los MISMOS valores que usa el cron.
 * Dentro del TSX, una pantalla puede describir al revés lo que el sistema hace sin
 * que nada falle — que es lo que pasó con la etiqueta del horario del conductor.
 */
export function describirCopiaInterna(c: CopiaInterna): string {
  if (c.codigo === "apagada") {
    return "Apagada: operaciones NO recibe copia. El cliente sigue recibiendo su reporte; "
      + "lo que se pierde es que AFA vea las sugerencias y los casos en que se superó "
      + "lo contratado, que es lo que se decide desde adentro.";
  }
  if (c.codigo === "sin_destinatario") {
    return "Encendida, pero no hay ninguna dirección: la copia NO va a salir. "
      + "Escribe abajo a quién le llega.";
  }
  return `Sale a ${c.correos.join(", ")} (${FUENTE_COPIA[c.fuente!]}), `
    + "un correo por cada cliente al que se le mande el reporte, SIEMPRE con las "
    + "sugerencias completas aunque el cliente las tenga apagadas.";
}

/**
 * Solo alarma lo que CAMBIA lo que hace el sistema sin que nadie lo haya pedido.
 * Apagarla a propósito no es una alarma: lo acaba de hacer una persona mirando la
 * casilla. Un aviso que sale siempre se vuelve paisaje.
 */
export const alarmaCopiaInterna = (c: CopiaInterna): boolean => c.codigo === "sin_destinatario";

// ──────────────────────────────────────────────────────────────────────────────
// QUIÉN RECIBE ESTE ENVÍO · el envío de verdad y la PRUEBA
//
// Lo pidió el dueño: «quiero enviar solo a un cliente y solo a AFA para probar,
// no hay esa opción». Y no la había: el botón de /reportes dispara el tick entero
// y el de la ficha del cliente manda a UNO pero TAMBIÉN al cliente. O sea, no
// había forma de ver el reporte de un cliente sin que a ese cliente le llegara —
// que es justo lo que se quiere antes de encenderle el envío.
//
// ─── LO QUE SEPARA UNA PRUEBA DE UN ENVÍO NO ES EL DESTINATARIO: ES EL CANDADO ─
//
// Una prueba se manda a los MISMOS correos que la copia interna, así que por ese
// lado no se distingue de la copia del sábado. Lo que la hace una prueba es que
// **NO CONSUME EL ENVÍO PROGRAMADO**. El candado del correo doble es
// `(cliente_id, destino, periodo_fin)`, así que si la prueba se registrara como
// `afa` quemaría la copia real de ese periodo: el cliente recibiría la suya el
// sábado y operaciones no, sin que nada lo dijera. Por eso su destino es
// `prueba_afa` — otro valor, otra fila, y el candado de `afa` intacto.
//
// ─── UNA PRUEBA NO SE CAE AL CLIENTE, NUNCA ─────────────────────────────────
//
// Si la copia interna está apagada o no tiene a dónde ir, la prueba NO manda
// nada y DICE por qué. La tentación sería «si no hay a quién, mándaselo al
// cliente», y eso es exactamente el correo que no se puede des-enviar.
// ──────────────────────────────────────────────────────────────────────────────

export type DestinoEnvio = "cliente" | "afa" | "prueba_afa";

/** Por qué una prueba no sale. Las dos se arreglan en el mismo bloque de /reportes. */
export type MotivoSinPrueba = "copia_apagada" | "copia_sin_destinatario";

export type PlanEnvio = {
  /** A quién se le intenta mandar, en orden. */
  destinos: DestinoEnvio[];
  /** Cuáles de esos BLOQUEAN el envío programado de ese periodo. */
  consumen: DestinoEnvio[];
  /** Solo cuando una prueba no puede salir. */
  motivo?: MotivoSinPrueba;
};

/**
 * Decide quién recibe esta corrida. Lo usan el cron y el botón de prueba, y la
 * pantalla lo describe con el MISMO resultado: una pantalla que dijera «solo a
 * ti» mientras el sistema le manda también al cliente es el error caro de este
 * módulo, y es un correo que no se des-envía.
 */
export function planDeEnvio(entrada: { prueba?: boolean; copia: CopiaInterna }): PlanEnvio {
  if (!entrada.prueba) {
    // El envío de siempre: el cliente y, si sale, la copia interna. Los dos
    // consumen el candado, que es lo que impide mandarlos dos veces.
    const destinos: DestinoEnvio[] = ["cliente", ...(entrada.copia.sale ? ["afa" as const] : [])];
    return { destinos, consumen: destinos };
  }

  // Una prueba sin destinatario interno no se convierte en un correo al cliente.
  if (!entrada.copia.sale) {
    return {
      destinos: [],
      consumen: [],
      motivo: entrada.copia.codigo === "apagada" ? "copia_apagada" : "copia_sin_destinatario",
    };
  }

  return { destinos: ["prueba_afa"], consumen: [] };
}

/** Qué contestarle a quien pidió una prueba que no pudo salir. */
export const MOTIVO_SIN_PRUEBA: Record<MotivoSinPrueba, string> = {
  copia_apagada:
    "La copia interna está apagada, así que la prueba no tiene a dónde ir. "
    + "Enciéndela arriba y vuelve a intentarlo.",
  copia_sin_destinatario:
    "La copia interna está encendida pero no hay ninguna dirección en toda la cascada: "
    + "escribe arriba a quién le llega y vuelve a intentarlo.",
};
