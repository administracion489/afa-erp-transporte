// lib/alertas-modo-tiempo.ts — QUÉ BLOQUE DEL MOTOR LEE EL SELECTOR "CUÁNDO", Y QUÉ
// MODOS SABE EJECUTAR. Módulo PURO: no lee la base, no envía nada y no mira el reloj por
// su cuenta — el instante entra por parámetro. Igual que lib/alertas-horario.ts.
//
// EL CASO QUE LO MOTIVÓ, y es el mismo síntoma del horario por otra puerta: buscando por
// qué le llegaban avisos a las 00:00 aparecieron CUATRO alertas más saliendo a esa hora, y
// ninguna era un fallo del motor — las cuatro estaban mal configuradas desde el panel, y
// el panel no tenía forma de decirlo:
//
//   recordatorio_pasajero  anticipacion 90              → pasajeros avisados a las 03:30
//   doc_vence              anticipacion 90 + 08:00      → «tu licencia vence» a las 00:00
//   solape                 anticipacion 90 + 07:00      → al coordinador a las 00:00
//   jornada                evento       + 08:00         → al coordinador a las 00:00
//
// La causa no es el valor tecleado: es que **cada bloque solo entiende algunos modos, y la
// pantalla ofrece los tres a todos**. Cuando el modo elegido no es uno de los que su bloque
// sabe ejecutar, el aviso no falla ni avisa — hace otra cosa, en silencio:
//
//  · Vía RECORDATORIO (`enViaRecordatorio`): entiende `anticipacion` y `hora_fija`.
//    Con `evento` devuelve false SIEMPRE → la alerta queda **activa y MUDA**.
//  · Vía HORA FIJA (`enVentanaHoraFija`): entiende `hora_fija`. Con cualquier otro modo
//    devuelve true SIEMPRE → **se queda sin ventana** y sale en el primer tick del día,
//    o sea a las 00:0x. Que es, literalmente, el defecto que este ERP acaba de arreglar.
//
// Y basta con tocar el desplegable para caer en eso: `guardarCfg` CONSERVA el `hora_fija`
// viejo al cambiar de modo (y escribe `min_anticipacion: 90` al pasar a `anticipacion`), así
// que una fila queda con las 08:00 puestas, inertes, y sin ventana. Nada en la pantalla lo
// decía.
//
// POR QUÉ NO SE "ARREGLA" EN EL MOTOR, que es la pregunta obvia: un `hora_fija` relleno con
// el modo en `anticipacion` NO es una contradicción que el motor pueda resolver — es lo que
// queda al cambiar de idea, exactamente igual que un importe huérfano en una reserva
// cancelada. Hacer que el motor lo honre sería DEDUCIR una intención de un campo viejo, que
// es la decisión que `montoDe` rechaza con el falso flete. Lo único correcto es DECIRLO
// antes de guardar. Misma conclusión que la ventana invertida de `alertas-horario.ts`.
//
// Y LA OTRA MITAD: doce de los veintiún tipos NO leen el modo en absoluto (ciclo de vida,
// semáforo de puntualidad, GPS, checkout, abandono). Ofrecerles el selector es ofrecer un
// control que el sistema no lee — el mismo defecto que `multiples_recargas_en_cluster`
// declarado y sin emitir. `leeElModo()` lo DERIVA de esta tabla en vez de depender de que
// alguien mantenga a mano `alerta_config.tiempo_editable`: la columna sigue mandando cuando
// dice `false` (es un AND), pero ya no hace falta correr un SQL para que el control inerte
// desaparezca. Misma regla que el `area` de caja chica: se deriva, no se guarda.

/** Los tres modos que ofrece el desplegable "Cuándo" del panel. */
export type ModoTiempo = "evento" | "anticipacion" | "hora_fija";

/**
 * Minutos que dura la ventana de una alerta de hora fija. Generosa a propósito: tolera
 * ticks caídos sin perder el día, y el dedupe garantiza "una sola vez".
 * Es el `VENTANA_HORA_FIJA` del tick, movido aquí para que no queden dos números.
 */
export const VENTANA_HORA_FIJA_MIN = 120;

/** Minutos de anticipación por defecto cuando la fila no los declara (el del tick). */
const ANTICIPACION_DEFECTO_MIN = 90;
/** Hora fija por defecto cuando la fila no la declara: 08:00 (el del tick). */
const HORA_FIJA_DEFECTO_MIN = 480;

/**
 * "HH:MM" → minutos del día, con la MISMA laxitud que `hhmmAMin` (lib/alertas.ts), que es
 * la que usa el tick hoy: no valida rangos. Se replica aquí en vez de importarse porque
 * `lib/alertas.ts` habla con Supabase y este módulo es puro — y en vez de usar el
 * `hhmmAMinutos` de `alertas-horario.ts` (que sí valida) porque la extracción tiene que
 * comportarse byte a byte como el original, incluso ante un valor imposible.
 */
function hhmmAMinLaxo(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

/** Por qué BLOQUE del tick se despacha cada aviso. */
export type ViaDespacho =
  /** `enViaRecordatorio`: recordatorios y avisos pre-inicio, por reserva. */
  | "recordatorio"
  /** `enVentanaHoraFija`: barridos diarios (documentos, solape, jornada). */
  | "hora_fija"
  /** Bloques con su propio disparador: NO leen `modo_tiempo` ni `min_anticipacion`. */
  | "ignora_modo";

/**
 * Qué bloque atiende cada clave. Es un espejo del tick y por eso el tick IMPORTA de aquí
 * sus dos predicados: dos motores que contestan la misma pregunta terminan contestando
 * distinto — es literalmente el bug del semáforo de puntualidad.
 *
 * Una clave que no esté aquí no se juzga (`sin_via`): no se afirma nada de un aviso que
 * este módulo no conoce, y su selector se sigue ofreciendo.
 */
export const VIA_DE_ALERTA: Record<string, ViaDespacho> = {
  // ── Bloques 2/3/3b/3b-2/3c: pasan por `enViaRecordatorio` ──
  recordatorio_conductor: "recordatorio",
  recordatorio_pasajero: "recordatorio",
  proximo_inicio: "recordatorio",
  recuerda_iniciar: "recordatorio",
  llamar_conductor: "recordatorio",
  alerta_no_inicio_previa: "recordatorio",
  // ── Bloques 6/7: pasan por `enVentanaHoraFija` ──
  doc_vence: "hora_fija",
  solape: "hora_fija",
  jornada: "hora_fija",
  // ── Bloque 1: ciclo de vida. Dispara al DETECTAR el diff por reserva; su hora de envío
  //    la decide el horario de `alertas-horario.ts`, no este selector. ──
  asignacion: "ignora_modo",
  desasignacion: "ignora_modo",
  cambio: "ignora_modo",
  cancelacion: "ignora_modo",
  // ── Semáforo de puntualidad (lib/retrasos.ts): el veredicto es el disparador. ──
  riesgo_retraso: "ignora_modo",
  en_punto_sin_iniciar: "ignora_modo",
  retraso_en_ruta: "ignora_modo",
  sin_rastreo_previo: "ignora_modo",
  // ── Bloques con su propio reloj: la hora del servicio, el silencio del GPS, la cadencia
  //    horaria del checkout, el techo de duración del abandono. ──
  no_inicio: "ignora_modo",
  gps_silencio: "ignora_modo",
  recordar_checkout: "ignora_modo",
  servicio_abandonado: "ignora_modo",
};

/** La vía de una clave, o null si este módulo no la conoce. */
export function viaDeAlerta(clave: string): ViaDespacho | null {
  return VIA_DE_ALERTA[clave] ?? null;
}

/**
 * ¿El bloque de esta clave LEE el selector "Cuándo"?
 *
 * Una clave desconocida devuelve `true`: no se esconde un control que no se pudo juzgar.
 * El lado seguro es el contrario al de esconder — un control de más se ve y se pregunta;
 * uno escondido de menos deja un aviso sin poder configurarse.
 */
export function leeElModo(clave: string): boolean {
  const via = viaDeAlerta(clave);
  return via === null || via !== "ignora_modo";
}

/** Los modos que cada vía sabe ejecutar. La vía `ignora_modo` no ejecuta ninguno. */
export const MODOS_QUE_APLICAN: Record<ViaDespacho, ModoTiempo[]> = {
  recordatorio: ["anticipacion", "hora_fija"],
  hora_fija: ["hora_fija"],
  ignora_modo: [],
};

export type CodigoModo =
  /** El modo elegido es uno de los que su bloque sabe ejecutar. */
  | "ok"
  /** Clave que este módulo no conoce: no se afirma nada. */
  | "sin_via"
  /** Su bloque no lee el modo: el control no cambia nada. Línea gris, no alarma. */
  | "modo_inerte"
  /** Vía recordatorio + `evento`: el bloque devuelve false SIEMPRE → activa y MUDA. */
  | "evento_mudo"
  /** Vía hora fija + modo ≠ `hora_fija`: se queda SIN ventana → sale a las 00:0x. */
  | "sin_ventana";

export type CotejoModo = {
  codigo: CodigoModo;
  /** ¿Esto merece ámbar? Solo lo que CAMBIA lo que hace el sistema. */
  alarma: boolean;
  /** Qué está pasando de verdad, en una frase. Vacío cuando no hay nada que decir. */
  detalle: string;
  /** Qué hacer. Vacío cuando no hay nada que hacer. */
  arreglo: string;
};

const SIN_NADA = (codigo: CodigoModo): CotejoModo => ({ codigo, alarma: false, detalle: "", arreglo: "" });

/**
 * ¿El modo elegido para esta alerta es uno que su bloque sabe ejecutar?
 *
 * Se juzga SIN mirar `activo`: una alerta apagada con el modo equivocado es la misma
 * trampa, y muerde el día que alguien la enciende. Lo que sí decide el ruido es `alarma`:
 * solo pintan ámbar los dos códigos que CAMBIAN lo que hace el sistema (`evento_mudo` y
 * `sin_ventana`); `modo_inerte` es una línea gris y `ok`/`sin_via` no dicen nada. Mismo
 * criterio que `cotejarFichaConTanques`: un aviso que sale siempre se vuelve paisaje.
 */
export function cotejarModoTiempo(cfg: {
  clave: string;
  modo_tiempo?: ModoTiempo | string | null;
  hora_fija?: string | null;
  min_anticipacion?: number | null;
}): CotejoModo {
  const via = viaDeAlerta(cfg.clave);
  if (via === null) return SIN_NADA("sin_via");

  if (via === "ignora_modo") {
    return {
      codigo: "modo_inerte",
      alarma: false,
      detalle: "Este aviso no usa el selector «Cuándo»: sale cuando el motor detecta el hecho que lo dispara.",
      arreglo: "",
    };
  }

  const modo = String(cfg.modo_tiempo ?? "");
  if ((MODOS_QUE_APLICAN[via] as string[]).includes(modo)) return SIN_NADA("ok");

  if (via === "recordatorio") {
    // `enViaRecordatorio` termina en `return false` para cualquier modo que no sea
    // `anticipacion` ni `hora_fija`. No es que llegue tarde: no llega nunca.
    return {
      codigo: "evento_mudo",
      alarma: true,
      detalle:
        "Con «Al ocurrir (evento)» este aviso NO se envía nunca: su bloque solo sabe disparar " +
        "«Antes del servicio» o «A una hora fija». La alerta figura activa y está muda.",
      arreglo: "Elige «Antes del servicio» (y sus minutos) o «A una hora fija» (y su hora).",
    };
  }

  // via === "hora_fija": `enVentanaHoraFija` devuelve true para cualquier otro modo, o sea
  // NINGUNA ventana — y el tick corre cada ~10 min desde medianoche.
  const hf = hhmmAMinLaxo(cfg.hora_fija);
  const teniaHora = hf != null;
  return {
    codigo: "sin_ventana",
    alarma: true,
    detalle:
      "Este aviso es un barrido diario y solo respeta un horario con «A una hora fija». " +
      `Con «${etiquetaModo(modo)}» se queda sin ventana y sale en el primer tick del día, o sea alrededor de las 00:00.` +
      (teniaHora ? ` La hora ${cfg.hora_fija} que tiene guardada no se está leyendo.` : ""),
    arreglo: teniaHora
      ? `Vuelve a «A una hora fija» para que se respeten las ${cfg.hora_fija}.`
      : "Elige «A una hora fija» y pon la hora a la que quieres que salga.",
  };
}

/** El texto que el desplegable muestra para cada modo. Para poder citarlo en el aviso. */
export function etiquetaModo(modo?: string | null): string {
  if (modo === "evento") return "Al ocurrir (evento)";
  if (modo === "anticipacion") return "Antes del servicio";
  if (modo === "hora_fija") return "A una hora fija";
  return String(modo ?? "sin modo");
}

// ─── LOS DOS PREDICADOS DEL TICK ──────────────────────────────────────────────
// Extraídos, no reescritos: `scripts/prueba-modo-tiempo.mts` corre la versión original
// (copiada literal del route) contra estas sobre un barrido completo y exige resultados
// idénticos. Mismo contrato que `scripts/prueba-costeo.mts` con `lib/costeo-propio.ts`.
//
// Viven aquí y no en el route para que la pantalla y el motor deriven de LA MISMA tabla:
// un guard que mirara su propia copia de "qué modo aplica a qué alerta" sería el bug del
// semáforo de puntualidad —las dos mitades del tablero contradiciéndose— con la agravante
// de que el que miente sería justo el que existe para no mentir.

/**
 * ¿Estamos en la ventana de disparo de un recordatorio / aviso pre-inicio?
 * Piso amplio + dedupe = "una vez, sin perder".
 *
 * `evento` devuelve false: ese modo no lo ejecuta este bloque (ver `cotejarModoTiempo`).
 */
export function enViaRecordatorio(args: {
  modo_tiempo?: ModoTiempo | string | null;
  hora_fija?: string | null;
  min_anticipacion?: number | null;
  /** Fecha del servicio de la reserva ("YYYY-MM-DD"). */
  fechaServicio?: string | null;
  /** Hora del servicio ("HH:MM" o "HH:MM:SS"). */
  horaServicio?: string | null;
  /** Fecha de hoy en Lima, y la de mañana. */
  hoy: string;
  manana: string;
  /** Minuto del día en Lima (0..1439). */
  ahoraMin: number;
  /** Instante actual en ms UTC (Date.now() en producción; fijo en las pruebas). */
  ahoraMs: number;
  /** ?force=1: ignora las ventanas horarias (pruebas). */
  force?: boolean;
}): boolean {
  if (args.force) return true;
  if (args.modo_tiempo === "hora_fija") {
    if (args.fechaServicio !== args.manana) return false; // hora fija → recuerda los de MAÑANA
    const hf = hhmmAMinLaxo(args.hora_fija) ?? HORA_FIJA_DEFECTO_MIN;
    return args.ahoraMin >= hf && args.ahoraMin < hf + VENTANA_HORA_FIJA_MIN;
  }
  if (args.modo_tiempo === "anticipacion") {
    // Fecha absoluta (no solo "minutos del día de hoy"): una anticipación de varias horas
    // sobre un servicio de MAÑANA temprano dispara HOY en la noche — cruza la medianoche, y
    // comparar solo fechaServicio===hoy lo perdía por completo.
    if (args.fechaServicio !== args.hoy && args.fechaServicio !== args.manana) return false;
    const inicioMs = limaAUtcMsLocal(args.fechaServicio, args.horaServicio);
    if (inicioMs == null) return false;
    const disparoMs = inicioMs - (args.min_anticipacion ?? ANTICIPACION_DEFECTO_MIN) * 60_000;
    return args.ahoraMs >= disparoMs && args.ahoraMs < inicioMs; // desde X min antes hasta el inicio
  }
  return false;
}

/**
 * Ventana de las alertas de barrido diario (documentos, solape, jornada).
 *
 * Con un modo que no es `hora_fija` devuelve true SIEMPRE: eso NO es "siempre permitido a
 * propósito", es la alerta quedándose sin ventana — y por eso `cotejarModoTiempo` lo
 * denuncia en la pantalla. Aquí se conserva tal cual porque cambiarlo haría que el motor
 * honrara un `hora_fija` que quedó de una configuración anterior.
 */
export function enVentanaHoraFija(args: {
  modo_tiempo?: ModoTiempo | string | null;
  hora_fija?: string | null;
  /** Minuto del día en Lima (0..1439). */
  ahoraMin: number;
  force?: boolean;
}): boolean {
  if (args.force) return true;
  if (args.modo_tiempo !== "hora_fija") return true;
  const hf = hhmmAMinLaxo(args.hora_fija);
  if (hf == null) return true;
  return args.ahoraMin >= hf && args.ahoraMin < hf + VENTANA_HORA_FIJA_MIN;
}

/**
 * "YYYY-MM-DD" + "HH:MM(:SS)" en hora Lima (UTC-5 fijo) → ms UTC.
 * Copia local del `limaAUtcMs` de `alertas-horario.ts` para no cruzar módulos puros por un
 * helper de cuatro líneas; el barrido de la matriz comprueba que dan lo mismo.
 */
function limaAUtcMsLocal(fecha?: string | null, horaHHMM?: string | null): number | null {
  if (!fecha) return null;
  const [y, m, d] = String(fecha).slice(0, 10).split("-").map(Number);
  const [hh, mm] = String(horaHHMM || "00:00").split(":").map(Number);
  if (!y || !m || !d || !Number.isFinite(hh)) return null;
  return Date.UTC(y, m - 1, d, hh + 5, mm || 0);
}
