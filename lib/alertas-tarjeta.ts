// lib/alertas-tarjeta.ts — QUÉ DICE Y QUÉ OFRECE CADA TARJETA DE /configuracion/operaciones,
// DERIVADO DE LO QUE EL MOTOR HACE DE VERDAD. Módulo PURO: no lee la base ni envía nada. Lo
// importa la pantalla (un componente de cliente), así que solo puede importar módulos puros.
//
// EL CASO QUE LO MOTIVÓ (13-10-2026): cada tarjeta enseñaba `alerta_config.descripcion` —un texto
// sembrado UNA vez por SQL— y los mismos controles (Conductor, Pasajero, «Incluir tercerizados»,
// horario, umbral) en los veintiséis tipos. El motor cambió y las tarjetas se quedaron mintiendo:
//
//  · «No inició a tiempo» decía «El conductor no marcó inicio pasada la hora» con «Conductor» ✓,
//    y el tick NO le escribe al conductor cuando «Ya debió iniciar» ya le mandó el mismo texto
//    (`noInicioRepiteDebio`): ese aviso va solo a los contactos.
//  · «Conductor» se ofrecía en todas y solo lo leen ocho bloques; en los avisos pre-inicio, el ciclo
//    de vida, el recordatorio y los documentos le escribe al conductor PROPIO SIEMPRE.
//  · «Pasajero» no lo lee nadie: a quién le llega un aviso al pasajero lo deciden sus canales.
//  · El horario de envío solo lo lee el bloque de ciclo de vida (asignación, cambio, cancelación,
//    desasignación), y se ofrecía en todas.
//  · «Alerta previa al coordinador» lee «Incluir tercerizados» y la pantalla solo lo enseñaba con
//    «Conductor» marcado — que en esa tarjeta nace desmarcado: una casilla inalcanzable.
//  · El umbral se leía en cuatro bloques sin campo para editarlo, y se enseñaba `umbral ?? 0`
//    donde el motor usa otro número.
//
// LA REGLA: la descripción la COMPONE este módulo con los números de la fila (interpolados, nunca
// escritos en el texto) y los controles salen de la ficha de cada clave, que es un espejo del
// código. Es la misma doctrina que `leeElModo` y `LEE_DIRECTORIO`: un control que el sistema no
// lee es peor que no ofrecerlo, y una pantalla que describe al revés lo que hace el sistema no
// falla, no avisa y deja a alguien esperando un comportamiento que nunca llega.
//
// Una clave que este módulo no conoce conserva la descripción de la base y los controles de
// siempre: el lado seguro es no esconder lo que no se pudo juzgar.

import {
  ANTICIPACION_DEFECTO_MIN, HORA_FIJA_DEFECTO_MIN, VIA_DE_ALERTA, hhmmAMinLaxo, leeElDirectorio,
} from "@/lib/alertas-modo-tiempo";
import {
  CLAVE_DEBIO_INICIAR, CLAVE_INICIA_AHORA, DEBIO_INICIAR_MIN_DEFECTO, INICIA_AHORA_MIN_DEFECTO,
  NO_INICIO_MIN_DEFECTO, VENTANA_DEBIO_MIN, minutosDebioIniciar, minutosIniciaAhora, noInicioRepiteDebio,
} from "@/lib/escalera-inicio";
import {
  CLAVE_LLAMADA, LLAMADA_MIN_DEFECTO, REINTENTO_MIN, minutosLlamada, type Opcion,
} from "@/lib/llamadas-central";
import { ESCALAR_TRAS_RECORDATORIOS, cadenciaEfectiva } from "@/lib/alertas-checkout";
import { MAX_SERVICIOS_JORNADA } from "@/lib/alertas-flota";
import { minutosAHhmm, textoDuracion } from "@/lib/alertas-horario";

// ─── TIPOS ─────────────────────────────────────────────────────────────────────

/** Lo que la tarjeta necesita de cada fila de `alerta_config`. */
export type CfgTarjeta = {
  clave: string;
  activo: boolean;
  descripcion?: string | null;
  modo_tiempo?: string | null;
  min_anticipacion?: number | null;
  hora_fija?: string | null;
  umbral?: number | null;
  notifica_conductor?: boolean | null;
  notifica_conductor_tercero?: boolean | null;
  plantilla?: string | null;
  plantilla_directorio?: string | null;
  usa_directorio?: boolean | null;
  // Canales (supabase/canales-por-tipo.sql). Opcionales: sin ellos se leen como el motor lee
  // una fila sin la migración (conductor solo WhatsApp; pasajero, los tres).
  canal_conductor_whatsapp?: boolean | null;
  canal_conductor_email?: boolean | null;
  canal_conductor_push?: boolean | null;
  canal_pasajero_push?: boolean | null;
  canal_pasajero_email?: boolean | null;
  canal_pasajero_whatsapp?: boolean | null;
};

/** Lo que no está en la fila y la tarjeta necesita para describirse. */
export type CtxTarjeta = {
  /**
   * Contactos del directorio que de verdad recibirían el aviso de esa clave: activos, con
   * teléfono y marcados en su tarjeta (lo mismo que cuenta `directorioDe` en el tick).
   */
  contactos: (clave: string) => number;
  /** `retraso_config.persistencia_punto_min`: cuándo «En el punto, sin iniciar» escala. */
  persistenciaPuntoMin?: number | null;
  /** `jornada_config.recordar_checkout_cada_min`: cada cuánto se repite el recordatorio de check-out. */
  cadenciaCheckoutMin?: number | null;
};

/**
 * Cómo trata el motor la casilla «Conductor» de un tipo:
 *  · `lee_casilla`: el bloque la lee; desmarcada no le escribe.
 *  · `siempre`: le escribe al conductor PROPIO aunque la casilla esté desmarcada (no la lee).
 *  · `nunca`: el bloque no le escribe al conductor (solo a contactos o pasajeros).
 */
export type AlConductor = "lee_casilla" | "siempre" | "nunca";

/**
 * Qué alcanza el aviso entre los servicios de flota tercerizada:
 *  · `casilla_conductor`: «Incluir tercerizados» extiende el mensaje AL CONDUCTOR a los tercerizados.
 *  · `casilla_servicios`: «Incluir servicios tercerizados» extiende la tarjeta entera (la alerta a
 *    los contactos) a los servicios tercerizados; no tiene que ver con la casilla «Conductor».
 *  · `solo_propios`: el bloque solo mira la flota propia; no hay casilla.
 *  · `todos`: el bloque mira las dos flotas sin casilla (lo que le llega al conductor de cada una
 *    lo dicen `alConductor` y `destinatariosHoy`).
 */
export type Tercerizados = "casilla_conductor" | "casilla_servicios" | "solo_propios" | "todos";

export type FichaTarjeta = {
  alConductor: AlConductor;
  tercerizados: Tercerizados;
  /** Canales del pasajero que el motor LEE para este tipo (null: no le escribe al pasajero). */
  alPasajero: null | { push: boolean; email: boolean; whatsapp: boolean };
  /** El horario de envío al conductor: propio, o el de «Servicio asignado» mientras esté activo. */
  horario: null | "propio" | "el_de_asignacion";
  /** El bloque lee `umbral`: con qué etiqueta se ofrece. */
  umbral: null | { etiqueta: string };
  /** false: el interruptor «Activo» no lo apaga (lo dispara otra parte del ERP). */
  activoApaga: boolean;
  /** recordar_checkout: desmarcar «Conductor» apaga también el aviso a los contactos. */
  conductorApagaTodo?: boolean;
  /**
   * El mensaje al conductor exige plantilla: sin ella no sale por NINGÚN canal (el tick y el cron
   * de un minuto devuelven «sin canal» antes de mirar los canales). Los que no la exigen usan la
   * plantilla fija del código o una por defecto.
   */
  requierePlantilla: boolean;
  /** Los números de la fila que su descripción interpola. */
  usa: ("umbral" | "min_anticipacion" | "hora_fija")[];
  /** Texto que acompaña al interruptor «Activo» (o lo reemplaza, si no lo apaga). */
  textoActivo?: string;
  describir: (cfg: CfgTarjeta, ctx: CtxTarjeta) => string;
};

// ─── LOS NÚMEROS POR DEFECTO DEL MOTOR ────────────────────────────────────────

/**
 * El umbral que usa el motor cuando la fila no lo declara. El tick IMPORTA de aquí sus defaults
 * (`cfg.umbral ?? UMBRAL_DEFECTO.x`): con el número escrito en dos sitios, la tarjeta diría uno y
 * el motor usaría otro. Los de la escalera fina salen de sus módulos (`minutos*`).
 */
export const UMBRAL_DEFECTO = {
  no_inicio: NO_INICIO_MIN_DEFECTO,
  debio_iniciar: DEBIO_INICIAR_MIN_DEFECTO,
  llamada_inicio: LLAMADA_MIN_DEFECTO,
  riesgo_retraso: 8,
  retraso_en_ruta: 10,
  sin_rastreo_previo: 30,
  gps_silencio: 8,
  recordar_checkout: 60,
  doc_vence: 15,
  jornada: 13,
  servicio_abandonado: 30,
} as const satisfies Record<string, number>;

/** El default de una clave, o null si su bloque no lee el umbral. */
export function umbralDefecto(clave: string): number | null {
  return Object.prototype.hasOwnProperty.call(UMBRAL_DEFECTO, clave)
    ? (UMBRAL_DEFECTO as Record<string, number>)[clave] : null;
}

/** El umbral que el motor usa HOY con esta fila, leído como lo lee cada bloque. */
export function umbralEfectivo(cfg: CfgTarjeta): number | null {
  switch (cfg.clave) {
    case CLAVE_DEBIO_INICIAR: return minutosDebioIniciar(cfg);       // cron de 1 min
    case CLAVE_LLAMADA: return minutosLlamada(cfg);                  // cron de 1 min
    // planRecordarCheckout: Math.max(0, Math.round(Number(umbral ?? 60) || 0)).
    case "recordar_checkout":
      return Math.max(0, Math.round(Number(cfg.umbral ?? UMBRAL_DEFECTO.recordar_checkout) || 0));
    // El tick lee `activa("servicio_abandonado")?.umbral ?? 30`: con la tarjeta apagada el umbral
    // de la fila no se usa, y el cierre automático sigue a las 30 h.
    case "servicio_abandonado":
      return cfg.activo ? (cfg.umbral ?? UMBRAL_DEFECTO.servicio_abandonado) : UMBRAL_DEFECTO.servicio_abandonado;
  }
  const def = umbralDefecto(cfg.clave);
  return def == null ? null : (cfg.umbral ?? def);
}

/**
 * La tecla de la llamada que avisa al coordinador (`SIGNIFICADO_OPCION` de lib/llamadas-central.ts:
 * «pide hablar con el coordinador»). Tipada como `Opcion` para que no pueda quedar una tecla que
 * la central no entiende.
 */
const TECLA_COORDINADOR: Opcion = "2";

// ─── EL «CUÁNDO» EN PALABRAS ──────────────────────────────────────────────────

const MIN_DIA = 1440;

/** Minutos de anticipación en palabras: «90 min», «12 h», «2 h 30 min». */
function antelacion(min: number): string {
  const m = Math.round(min);
  return m < 120 ? `${m} min` : textoDuracion(m);
}

/**
 * Cuándo sale un aviso de la vía «recordatorio», con la MISMA lectura que `enViaRecordatorio`
 * (y `juzgarIniciaAhora`, que le pasa `modo ?? "anticipacion"` y `minutosIniciaAhora`).
 */
export function cuandoRecordatorio(cfg: CfgTarjeta): string {
  const iniciaAhora = cfg.clave === CLAVE_INICIA_AHORA;
  const modo = iniciaAhora ? (cfg.modo_tiempo ?? "anticipacion") : cfg.modo_tiempo;
  if (modo === "anticipacion") {
    const min = iniciaAhora ? minutosIniciaAhora(cfg) : Number(cfg.min_anticipacion ?? ANTICIPACION_DEFECTO_MIN);
    // [inicio − min, inicio): con 0 o menos la ventana no existe.
    if (!Number.isFinite(min) || min <= 0) return "nunca: sin minutos de anticipación no hay momento de envío";
    return `${antelacion(min)} antes de la hora`;
  }
  if (modo === "hora_fija") {
    // Sin hora (o ilegible) el motor usa las 08:00; recuerda los servicios de MAÑANA.
    const hf = hhmmAMinLaxo(cfg.hora_fija) ?? HORA_FIJA_DEFECTO_MIN;
    if (hf < 0 || hf >= MIN_DIA) return `nunca: la hora «${cfg.hora_fija}» no existe`;
    return `a las ${minutosAHhmm(hf)} del día anterior`;
  }
  return "nunca (ver el aviso de «Cuándo»)";
}

const SIN_HORA_FIJA = "todos los días, sin hora fija: sale con el primer tick del día, de madrugada";

/** Cuándo sale un barrido diario, con la MISMA lectura que `enVentanaHoraFija`. */
export function cuandoBarrido(cfg: CfgTarjeta): string {
  if (cfg.modo_tiempo !== "hora_fija") return SIN_HORA_FIJA;
  const hf = hhmmAMinLaxo(cfg.hora_fija);
  if (hf == null) return SIN_HORA_FIJA;
  if (hf < 0 || hf >= MIN_DIA) return `con una hora que no existe («${cfg.hora_fija}»)`;
  return `todos los días a las ${minutosAHhmm(hf)}`;
}

/** Un número de la fila, tal como lo usa el motor (no se redondea lo que el motor no redondea). */
const n = (x: number | null) => String(x ?? "");

// ─── LAS FICHAS ───────────────────────────────────────────────────────────────

const PASAJERO_TODOS = { push: true, email: true, whatsapp: true } as const;
const VIA_RECORDATORIO: FichaTarjeta["usa"] = ["min_anticipacion", "hora_fija"];

/** Lo común de los avisos de ciclo de vida (bloque 1 del tick). */
const cicloVida = (describir: FichaTarjeta["describir"], extra: Partial<FichaTarjeta> = {}): FichaTarjeta => ({
  alConductor: "siempre", tercerizados: "casilla_conductor", alPasajero: null, horario: "propio",
  umbral: null, activoApaga: true, requierePlantilla: true, usa: [], describir, ...extra,
});

/** Un aviso que solo le llega a los contactos del directorio. */
const aContactos = (describir: FichaTarjeta["describir"], extra: Partial<FichaTarjeta> = {}): FichaTarjeta => ({
  alConductor: "nunca", tercerizados: "todos", alPasajero: null, horario: null,
  umbral: null, activoApaga: true, requierePlantilla: false, usa: [], describir, ...extra,
});

/**
 * Una ficha por clave de `VIA_DE_ALERTA`, espejo del código (los números de línea son del tick,
 * /api/alertas-flota/tick, salvo que se diga otro sitio). `scripts/prueba-alertas-tarjeta.mts`
 * fija la biyección y los controles contra un oráculo escrito aparte.
 */
export const TARJETAS: Record<string, FichaTarjeta> = {
  // Bloque 2: `avisaA` (propio siempre, tercerizado con su casilla); plantilla FIJA del código
  // (recordatorio_conductor / _completo), así que `plantilla` de la fila no se lee.
  recordatorio_conductor: {
    alConductor: "siempre", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: false, usa: VIA_RECORDATORIO,
    describir: (c) => `Al conductor, ${cuandoRecordatorio(c)}: fecha, hora, unidad, origen y destino del servicio. ` +
      "Si ese día tiene ida y retorno con el mismo conductor, van en un solo mensaje.",
  },
  // Bloque 3. El cron de las 08:00 (/api/notificaciones/recordatorio) ya no manda nada mientras
  // exista esta fila: la tarjeta es la única que decide (13-10-2026).
  recordatorio_pasajero: {
    alConductor: "nunca", tercerizados: "todos", alPasajero: { ...PASAJERO_TODOS }, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: false, usa: VIA_RECORDATORIO,
    describir: (c) => `A cada pasajero del manifiesto, ${cuandoRecordatorio(c)}: su paradero, hora, conductor y unidad.`,
  },
  // Bloque 3b (avisoPreInicio): no lee «Conductor»; `aConductor` exige plantilla.
  proximo_inicio: {
    alConductor: "siempre", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: true, usa: VIA_RECORDATORIO,
    describir: (c) => `Al conductor, ${cuandoRecordatorio(c)}, si todavía no pulsó INICIAR RECORRIDO: ` +
      "que al salir de la cochera haga su CHECK-IN y pulse INICIAR RECORRIDO.",
  },
  recuerda_iniciar: {
    alConductor: "siempre", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: true, usa: VIA_RECORDATORIO,
    describir: (c) => `Al conductor, ${cuandoRecordatorio(c)}, si todavía no pulsó INICIAR RECORRIDO: que lo pulse.`,
  },
  // Cron de un minuto (/api/alertas-flota/inicio): `!notifica_conductor || !plantilla` → no sale.
  inicia_ahora: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: true, usa: VIA_RECORDATORIO,
    describir: (c) => `Al conductor, ${cuandoRecordatorio(c)}, si todavía no pulsó INICIAR RECORRIDO: su servicio empieza ya.`,
  },
  debio_iniciar: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: { etiqueta: "Min. después de la hora" }, activoApaga: true, requierePlantilla: true, usa: ["umbral"],
    describir: (c) => {
      const u = minutosDebioIniciar(c);
      return `Al conductor, ${u} min después de la hora (hasta los ${u + VENTANA_DEBIO_MIN}), ` +
        "si todavía no pulsó INICIAR RECORRIDO: que lo pulse ya o llame a operaciones.";
    },
  },
  // Bloque 4: solo los de hoy; al conductor si «Conductor» y `noInicioRepiteDebio` no lo calla;
  // a los contactos siempre, con la evidencia de lo que ya se le mandó.
  no_inicio: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: { etiqueta: "Min. de gracia tras la hora" }, activoApaga: true, requierePlantilla: true, usa: ["umbral"],
    describir: (c) => `${n(umbralEfectivo(c))} min después de la hora, si el servicio sigue sin INICIAR RECORRIDO: ` +
      "alerta a los contactos marcados con los avisos que ya se le mandaron al conductor y si le llegaron. " +
      "Al conductor solo le escribe si «Ya debió iniciar» no se lo dijo antes.",
  },
  // Bloque 3c: nunca al conductor; los tercerizados con SU casilla, que no depende de «Conductor».
  alerta_no_inicio_previa: aContactos(
    (c) => `A los contactos marcados, ${cuandoRecordatorio(c)}, si el conductor aún no pulsó INICIAR RECORRIDO: ` +
      "cuánto falta y qué avisos se le mandaron. No le escribe al conductor.",
    { tercerizados: "casilla_servicios", usa: VIA_RECORDATORIO },
  ),
  // Bloque 3b-2: solo flota propia; uno → plantilla personal; varios a la vez → una lista.
  llamar_conductor: aContactos(
    (c) => `A los contactos marcados, ${cuandoRecordatorio(c)}, por cada servicio de flota propia que aún no se inició, ` +
      "para que llamen al conductor. Los que coinciden en el mismo momento llegan en un solo mensaje.",
    { tercerizados: "solo_propios", usa: VIA_RECORDATORIO },
  ),
  // Cron de un minuto: `notifica_conductor !== false`, tercerizado con su casilla, umbral.
  llamada_inicio: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: { etiqueta: "Min. después de la hora" }, activoApaga: true, requierePlantilla: false, usa: ["umbral"],
    describir: (c) => `Llamada de la central propia al conductor ${minutosLlamada(c)} min después de la hora si todavía ` +
      `no pulsó INICIAR RECORRIDO (un reintento a los ${REINTENTO_MIN} min si no contesta). ` +
      `Si marca ${TECLA_COORDINADOR}, WhatsApp a los contactos marcados.`,
  },
  // Bloque 4b: su umbral NO se lee (la escalada la decide retraso_config.persistencia_punto_min).
  en_punto_sin_iniciar: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: null, activoApaga: true, requierePlantilla: true, usa: [],
    describir: (_c, ctx) => {
      const p = Number(ctx.persistenciaPuntoMin);
      const persiste = ctx.persistenciaPuntoMin != null && Number.isFinite(p) && p >= 0
        ? `si sigue así más de ${p} min pasada la hora` : "si persiste pasada la hora";
      return "Si el GPS ve al bus en el primer paradero a la hora de embarque y el conductor no pulsó INICIAR RECORRIDO: " +
        `un aviso al conductor; ${persiste}, alerta a los contactos marcados. ` +
        "En esos servicios reemplaza a «No inició a tiempo».";
    },
  },
  // Bloques 4c-4e: semáforo de puntualidad, las dos flotas, solo contactos.
  riesgo_retraso: aContactos(
    (c) => "A los contactos marcados, antes de la hora: por el GPS y el tráfico de ahora, el bus llegaría " +
      `${n(umbralEfectivo(c))}+ min tarde al primer paradero. Una vez por servicio.`,
    { umbral: { etiqueta: "Min. de retraso previsto" }, usa: ["umbral"] },
  ),
  retraso_en_ruta: aContactos(
    (c) => `A los contactos marcados, con el servicio ya iniciado: llegará ${n(umbralEfectivo(c))}+ min tarde ` +
      "al siguiente paradero. Una vez por servicio.",
    { umbral: { etiqueta: "Min. de retraso" }, usa: ["umbral"] },
  ),
  sin_rastreo_previo: aContactos(
    (c) => `A los contactos marcados, desde ${n(umbralEfectivo(c))} min antes de la hora, si no llega ninguna ` +
      "ubicación de la unidad (no afirma un retraso). Si es tercerizada, también a la empresa proveedora.",
    { umbral: { etiqueta: "Min. antes para exigir señal" }, usa: ["umbral"] },
  ),
  // Bloque 5: al conductor solo si «Conductor» y es flota propia (`r.conductor_id`).
  gps_silencio: {
    alConductor: "lee_casilla", tercerizados: "todos", alPasajero: null, horario: null,
    umbral: { etiqueta: "Min. sin señal" }, activoApaga: true, requierePlantilla: true, usa: ["umbral"],
    describir: (c) => `Servicio en curso con más de ${n(umbralEfectivo(c))} min sin enviar ubicación: a los contactos ` +
      "marcados y, si es flota propia, al conductor. Si recupera la señal y la vuelve a perder, avisa otra vez.",
  },
  // Bloque 5b: todo el bloque exige «Conductor» (tick: `cfg && cfg.notifica_conductor`).
  recordar_checkout: {
    alConductor: "lee_casilla", tercerizados: "casilla_conductor", alPasajero: null, horario: null,
    umbral: { etiqueta: "Min. de espera tras el último servicio" }, activoApaga: true, conductorApagaTodo: true,
    requierePlantilla: true, usa: ["umbral"],
    describir: (c, ctx) => {
      const cada = ctx.cadenciaCheckoutMin != null
        ? `cada ${cadenciaEfectiva(ctx.cadenciaCheckoutMin)} min`
        : "con la frecuencia de «Recordar cada (min)» de Auditoría de jornada";
      return `Al conductor, ${n(umbralEfectivo(c))} min después de cerrar su último servicio del día, si no hizo ` +
        `CHECK-OUT ni mandó la foto del tablero; se repite ${cada} hasta que cumpla (solo hoy). ` +
        `Tras ${ESCALAR_TRAS_RECORDATORIOS} recordatorios sin respuesta, avisa una vez a los contactos marcados.`;
    },
  },
  // Bloque 1: ciclo de vida (hoy o mañana); lee el horario; propio siempre.
  asignacion: cicloVida(
    () => "Al conductor, cuando se le asigna un servicio de hoy o de mañana (los de más adelante se avisan " +
      "cuando pasan a ser de mañana). Varios a la vez van en un solo mensaje.",
    // `notificarConductor` usa la plantilla por defecto si la fila no trae una.
    { requierePlantilla: false },
  ),
  desasignacion: cicloVida(
    () => "Al conductor que deja de cubrir un servicio de hoy o mañana porque se reasignó. " +
      "Sale junto con el aviso al nuevo conductor.",
    { horario: "el_de_asignacion" },
  ),
  cambio: cicloVida(
    () => "Al conductor, cuando cambia la hora o la unidad de flota propia de un servicio de hoy o mañana que ya se le avisó.",
    { requierePlantilla: false },
  ),
  cancelacion: cicloVida(
    () => "Al conductor, cuando se cancela un servicio de hoy o mañana que ya se le había avisado.",
  ),
  // Bloque 6: solo `conductores` (flota propia), exige plantilla, uno por documento y día.
  doc_vence: {
    alConductor: "siempre", tercerizados: "solo_propios", alPasajero: null, horario: null,
    umbral: { etiqueta: "Días de anticipación" }, activoApaga: true, requierePlantilla: true, usa: ["umbral", "hora_fija"],
    describir: (c) => `A cada conductor de flota propia, ${cuandoBarrido(c)}, desde ${n(umbralEfectivo(c))} días antes ` +
      "de que venza un documento hasta su vencimiento: un mensaje por documento.",
  },
  // Bloque 7: flota propia de hoy, solo contactos.
  solape: aContactos(
    (c) => `A los contactos marcados, ${cuandoBarrido(c)}: conductores de flota propia con servicios de hoy que se cruzan en horario.`,
    { tercerizados: "solo_propios", usa: ["hora_fija"] },
  ),
  jornada: aContactos(
    (c) => `A los contactos marcados, ${cuandoBarrido(c)}: conductores de flota propia cuya jornada de hoy pasa de ` +
      `${n(umbralEfectivo(c))} h o suma ${MAX_SERVICIOS_JORNADA} servicios o más.`,
    { tercerizados: "solo_propios", umbral: { etiqueta: "Horas máx. de jornada" }, usa: ["umbral", "hora_fija"] },
  ),
  // El cierre corre SIEMPRE; la tarjeta solo decide el aviso (y su umbral, si está activa).
  servicio_abandonado: aContactos(
    (c) => `Un servicio de un día anterior que sigue «en curso» ${n(umbralEfectivo(c))} h después de su hora se cierra ` +
      "solo como finalizado. Con esta tarjeta activa, además se avisa a los contactos marcados" +
      (c.activo ? "." : " (apagada, el umbral de abajo no se usa)."),
    {
      umbral: { etiqueta: "Horas en curso antes de cerrarlo" }, usa: ["umbral"],
      textoActivo: "Apagada sigue cerrando los servicios abandonados: solo deja de avisar.",
    },
  ),
  // lib/notificaciones.ts (notificarReserva): lo dispara el botón del manifiesto o ELIA; de la
  // fila solo lee los canales del pasajero.
  confirmacion_pasajero: {
    alConductor: "nunca", tercerizados: "todos", alPasajero: { ...PASAJERO_TODOS }, horario: null,
    umbral: null, activoApaga: false, requierePlantilla: false, usa: [],
    textoActivo: "Lo dispara el botón «Avisar a pasajeros…» del manifiesto (o ELIA): este interruptor no lo apaga.",
    describir: () => "A los pasajeros del servicio cuando alguien pulsa «Avisar a pasajeros…» en el manifiesto " +
      "(o se lo pide a ELIA). A quien ya lo recibió no se le repite, salvo un cambio de hora.",
  },
  // lib/proximidad.ts → avisarLlegadaWhatsApp: el push del app sale siempre; el WhatsApp según canal.
  llegada_pasajero: {
    alConductor: "nunca", tercerizados: "todos", alPasajero: { push: false, email: false, whatsapp: true }, horario: null,
    umbral: null, activoApaga: false, requierePlantilla: false, usa: [],
    textoActivo: "Lo dispara el GPS al llegar al paradero: este interruptor no lo apaga.",
    describir: () => "Al pasajero, cuando el bus llega a su paradero: la notificación del app sale siempre; " +
      "el WhatsApp, según el canal de abajo.",
  },
};

export function fichaDe(clave: string): FichaTarjeta | null {
  return Object.prototype.hasOwnProperty.call(TARJETAS, clave) ? TARJETAS[clave] : null;
}

/** La descripción que enseña la tarjeta. Una clave desconocida conserva la de la base. */
export function descripcionDe(cfg: CfgTarjeta, ctx: CtxTarjeta): string {
  const f = fichaDe(cfg.clave);
  return f ? f.describir(cfg, ctx) : (cfg.descripcion ?? "");
}

// ─── LOS CONTROLES ────────────────────────────────────────────────────────────

export type ControlesTarjeta = {
  /** casilla: se ofrece «Conductor»; fijo: le escribe siempre (sin casilla); oculto: no le escribe. */
  conductor: "casilla" | "fijo" | "oculto";
  /** La casilla de tercerizados, o null. `independienteDeConductor`: se ve aunque «Conductor» esté desmarcado. */
  tercerizados: null | { etiqueta: string; independienteDeConductor: boolean };
  /** Los chips WhatsApp/Correo/Push del conductor. */
  canalesConductor: boolean;
  /** Los canales del pasajero que se leen (null: ninguno). Nunca hay casilla «Pasajero». */
  canalesPasajero: FichaTarjeta["alPasajero"];
  /** El bloque «Enviar solo dentro de un horario». */
  horario: boolean;
  /** El campo del umbral, con su etiqueta y el número que usa el motor sin dato. */
  umbral: null | { etiqueta: string; defecto: number };
  /** El número que usa el motor sin `min_anticipacion` (null: no lo lee). */
  minAnticipacionDefecto: number | null;
  activo: "interruptor" | "lo_dispara_otro";
  textoActivo?: string;
};

/** Qué controles ofrece la tarjeta. Una clave desconocida: los de siempre (el lado seguro). */
export function controlesDe(cfg: CfgTarjeta): ControlesTarjeta {
  const f = fichaDe(cfg.clave);
  if (!f) {
    return {
      conductor: "casilla",
      tercerizados: { etiqueta: "Incluir tercerizados", independienteDeConductor: false },
      canalesConductor: true,
      canalesPasajero: { ...PASAJERO_TODOS },
      horario: true,
      umbral: { etiqueta: "Umbral", defecto: 0 },
      minAnticipacionDefecto: ANTICIPACION_DEFECTO_MIN,
      activo: "interruptor",
    };
  }
  const conductor = f.alConductor === "lee_casilla" ? "casilla" : f.alConductor === "siempre" ? "fijo" : "oculto";
  const tercerizados = f.tercerizados === "casilla_conductor"
    ? { etiqueta: "Incluir tercerizados", independienteDeConductor: conductor === "fijo" }
    : f.tercerizados === "casilla_servicios"
      ? { etiqueta: "Incluir servicios tercerizados", independienteDeConductor: true }
      : null;
  const via = VIA_DE_ALERTA[cfg.clave];
  return {
    conductor,
    tercerizados,
    // La llamada no es un mensaje: no tiene canales.
    canalesConductor: conductor !== "oculto" && cfg.clave !== CLAVE_LLAMADA,
    canalesPasajero: f.alPasajero ? { ...f.alPasajero } : null,
    horario: f.horario !== null,
    umbral: f.umbral ? { etiqueta: f.umbral.etiqueta, defecto: umbralDefecto(cfg.clave) ?? 0 } : null,
    minAnticipacionDefecto: via === "recordatorio"
      ? (cfg.clave === CLAVE_INICIA_AHORA ? INICIA_AHORA_MIN_DEFECTO : ANTICIPACION_DEFECTO_MIN)
      : null,
    activo: f.activoApaga ? "interruptor" : "lo_dispara_otro",
    ...(f.textoActivo ? { textoActivo: f.textoActivo } : {}),
  };
}

// ─── A QUIÉN LE LLEGA HOY ─────────────────────────────────────────────────────

/**
 * ¿El motor le escribe al conductor de este tipo, según la casilla «Conductor»? Cada bloque la lee
 * a su manera y aquí se copia tal cual: la llamada exige `!== false` (cron de 1 min); los demás que
 * la leen exigen un valor verdadero; los que no la leen escriben siempre o nunca.
 */
export function escribeAlConductor(clave: string, cfg: { notifica_conductor?: boolean | null }): boolean {
  const f = fichaDe(clave);
  if (!f) return !!cfg.notifica_conductor;
  if (f.alConductor === "siempre") return true;
  if (f.alConductor === "nunca") return false;
  return clave === CLAVE_LLAMADA ? cfg.notifica_conductor !== false : !!cfg.notifica_conductor;
}

/** Canales del conductor como `canalesConductor` (lib/alertas.ts): sin dato, solo WhatsApp. */
function algunCanalConductor(cfg: CfgTarjeta): boolean {
  return (cfg.canal_conductor_whatsapp ?? true) || (cfg.canal_conductor_email ?? false) || (cfg.canal_conductor_push ?? false);
}

/**
 * ¿Le llega por algún canal que el tipo LEE? Como `cargarCanalesPasajero`: si la columna de push
 * de la fila está vacía, el motor cae al bloque global (que aquí no se ve) → se supone que sí.
 */
function algunCanalPasajero(cfg: CfgTarjeta, lee: NonNullable<FichaTarjeta["alPasajero"]>): boolean {
  if (cfg.canal_pasajero_push == null) return true;
  return (lee.push && cfg.canal_pasajero_push)
    || (lee.email && (cfg.canal_pasajero_email ?? true))
    || (lee.whatsapp && (cfg.canal_pasajero_whatsapp ?? true));
}

export type Destinatarios = {
  conductorPropio: boolean;
  conductorTercero: boolean;
  pasajero: boolean;
  /** Contactos del directorio que lo reciben (0 si el tipo no le escribe al directorio). */
  directorio: number;
  /** sin_rastreo_previo: la empresa proveedora de la unidad tercerizada. */
  proveedor: boolean;
};

const NADIE: Destinatarios = { conductorPropio: false, conductorTercero: false, pasajero: false, directorio: 0, proveedor: false };

/** ¿La tarjeta cuenta como encendida? La que no apaga su interruptor, siempre. */
function encendida(cfg: CfgTarjeta, f: FichaTarjeta): boolean {
  return f.activoApaga ? cfg.activo === true : true;
}

/**
 * A quién le llega hoy esta tarjeta, con la configuración de TODAS (no_inicio depende de
 * debio_iniciar). Se juzga como el motor: plantilla, canales, casillas y la tarjeta encendida.
 */
export function destinatariosHoy(clave: string, cfgs: Map<string, CfgTarjeta>, ctx: CtxTarjeta): Destinatarios {
  const cfg = cfgs.get(clave);
  if (!cfg) return { ...NADIE };
  const f = fichaDe(clave);
  if (!f) {
    // No se sabe qué hace su bloque: se informa lo que prometen sus casillas.
    if (!cfg.activo) return { ...NADIE };
    const c = !!cfg.notifica_conductor;
    return { ...NADIE, conductorPropio: c, conductorTercero: c && cfg.notifica_conductor_tercero === true, directorio: Math.max(0, ctx.contactos(clave)) };
  }
  const on = encendida(cfg, f);
  const llegaConductor = on && f.alConductor !== "nunca" && escribeAlConductor(clave, cfg)
    && (!f.requierePlantilla || !!cfg.plantilla)
    && (clave === CLAVE_LLAMADA || algunCanalConductor(cfg));
  let propio = llegaConductor;
  let tercero = llegaConductor && f.tercerizados === "casilla_conductor" && cfg.notifica_conductor_tercero === true;
  if (clave === "no_inicio") {
    const debio = cfgs.get(CLAVE_DEBIO_INICIAR);
    propio = propio && !noInicioRepiteDebio(debio, false);
    tercero = tercero && !noInicioRepiteDebio(debio, true);
  }
  // llegada_pasajero: la notificación del app sale siempre.
  const pasajero = !f.alPasajero ? false
    : clave === "llegada_pasajero" ? true
    : on && algunCanalPasajero(cfg, f.alPasajero);
  const alDirectorio = on && leeElDirectorio(clave) !== false
    && (clave !== "recordar_checkout" || !!cfg.notifica_conductor);
  return {
    conductorPropio: propio,
    conductorTercero: tercero,
    pasajero,
    directorio: alDirectorio ? Math.max(0, ctx.contactos(clave)) : 0,
    proveedor: clave === "sin_rastreo_previo" && on,
  };
}

// ─── LO QUE CAMBIA HOY POR LA CONFIGURACIÓN DE OTRAS TARJETAS ─────────────────

export type CodigoNota =
  /** «No inició» no le repite al conductor lo que ya le dijo «Ya debió iniciar». */
  | "repite_debio"
  /** A qué conductores sí (o no) les llega «No inició», y por qué. */
  | "llega_no_inicio"
  /** En «Ya debió iniciar»: mientras esté activo, calla el «No inició» al conductor. */
  | "silencia_no_inicio"
  /** En «No inició»: si el GPS ve al bus en el paradero, lo atiende «En el punto, sin iniciar». */
  | "lo_atiende_en_punto"
  /** En «En el punto, sin iniciar»: en esos servicios, «No inició» no sale. */
  | "reemplaza_no_inicio"
  /** En la desasignación: manda el horario de «Servicio asignado». */
  | "horario_de_asignacion"
  /** ÁMBAR: activa y hoy no le llega a nadie. */
  | "sin_destinatarios"
  /** ÁMBAR: recordar_checkout con «Conductor» desmarcado no sale, ni a los contactos. */
  | "conductor_apaga_todo";

export type NotaTarjeta = { codigo: CodigoNota; alarma: boolean; texto: string };

/** Solo estos dos pintan ámbar: cambian lo que hace el sistema y nada más lo dice. */
const ALARMA: Record<CodigoNota, boolean> = {
  repite_debio: false, llega_no_inicio: false, silencia_no_inicio: false, lo_atiende_en_punto: false,
  reemplaza_no_inicio: false, horario_de_asignacion: false,
  sin_destinatarios: true, conductor_apaga_todo: true,
};

const nota = (codigo: CodigoNota, texto: string): NotaTarjeta => ({ codigo, alarma: ALARMA[codigo], texto });

/** Por qué una tarjeta encendida no le llega a nadie, en una frase. */
function motivoNadie(clave: string, cfg: CfgTarjeta, f: FichaTarjeta, cfgs: Map<string, CfgTarjeta>): string {
  const partes: string[] = [];
  if (f.alConductor !== "nunca") {
    if (!escribeAlConductor(clave, cfg)) partes.push("«Conductor» está desmarcado");
    else if (f.requierePlantilla && !cfg.plantilla) partes.push("no tiene plantilla de WhatsApp, y sin ella al conductor no le sale por ningún canal");
    else if (clave !== CLAVE_LLAMADA && !algunCanalConductor(cfg)) partes.push("los canales del conductor están apagados");
    else if (clave === "no_inicio" && noInicioRepiteDebio(cfgs.get(CLAVE_DEBIO_INICIAR), false)) {
      partes.push("al conductor ya se lo dice «Ya debió iniciar»");
    }
  }
  if (leeElDirectorio(clave) !== false) partes.push("no tiene ningún contacto del directorio marcado (activo y con teléfono)");
  if (f.alPasajero) partes.push("los canales del pasajero están apagados");
  return partes.join("; ");
}

/**
 * Lo que la pantalla tiene que decir de esta tarjeta HOY, mirando todas. Todo en gris salvo
 * `sin_destinatarios` y `conductor_apaga_todo`; una tarjeta apagada nunca alarma.
 */
export function notasHoy(clave: string, cfgs: Map<string, CfgTarjeta>, ctx: CtxTarjeta): NotaTarjeta[] {
  const cfg = cfgs.get(clave);
  const f = fichaDe(clave);
  if (!cfg || !f) return [];
  const out: NotaTarjeta[] = [];
  const on = encendida(cfg, f);
  const debio = cfgs.get(CLAVE_DEBIO_INICIAR);
  const noInicio = cfgs.get("no_inicio");
  const enPunto = cfgs.get("en_punto_sin_iniciar");

  if (clave === "no_inicio") {
    if (cfg.notifica_conductor) {
      const dest = destinatariosHoy(clave, cfgs, ctx);
      const u = minutosDebioIniciar(debio);
      if (noInicioRepiteDebio(debio, false)) {
        out.push(nota("repite_debio",
          `Hoy a los conductores propios no les llega: «Ya debió iniciar» ya les manda este mismo mensaje ${u === 1 ? "al minuto" : `a los ${u} min`} de la hora. ` +
          "Va solo a los contactos marcados."));
      } else if (dest.conductorPropio) {
        out.push(nota("llega_no_inicio", "Al conductor propio sí le llega: es su primer aviso después de la hora."));
      }
      if (cfg.notifica_conductor_tercero !== true) {
        out.push(nota("llega_no_inicio", "A los conductores tercerizados no les llega: esta tarjeta no tiene marcado «Incluir tercerizados»."));
      } else if (noInicioRepiteDebio(debio, true)) {
        out.push(nota("repite_debio",
          "A los conductores tercerizados tampoco: «Ya debió iniciar» (con «Incluir tercerizados») ya les manda este mismo mensaje."));
      } else if (dest.conductorTercero) {
        out.push(nota("llega_no_inicio", "Al conductor tercerizado sí le llega: «Ya debió iniciar» no le escribe a él."));
      }
    }
    if (enPunto?.activo) {
      out.push(nota("lo_atiende_en_punto", "Si el GPS ve al bus en el paradero, lo atiende «En el punto, sin iniciar» y este no sale."));
    }
  }

  if (clave === CLAVE_DEBIO_INICIAR && noInicio?.activo && noInicio.notifica_conductor && noInicioRepiteDebio(cfg, false)) {
    const terceros = noInicio.notifica_conductor_tercero !== true ? ""
      : noInicioRepiteDebio(cfg, true) ? " Tampoco a los tercerizados."
      : " A los tercerizados sí se lo repite: aquí no está marcado «Incluir tercerizados».";
    out.push(nota("silencia_no_inicio",
      "Mientras esté activo, «No inició a tiempo» no le repite este mensaje al conductor: ese aviso va solo a los contactos." + terceros));
  }

  if (clave === "en_punto_sin_iniciar" && on && noInicio?.activo) {
    out.push(nota("reemplaza_no_inicio",
      "En los servicios en que el GPS ve al bus en el paradero, «No inició a tiempo» no sale (ni al conductor ni a los contactos): lo reemplaza este aviso."));
  }

  if (clave === "desasignacion" && cfgs.get("asignacion")?.activo) {
    out.push(nota("horario_de_asignacion",
      "Mientras «Servicio asignado» esté activo, manda el horario de esa tarjeta: este aviso sale junto con el del nuevo conductor."));
  }

  let apagaTodo = false;
  if (f.conductorApagaTodo && on && !cfg.notifica_conductor) {
    apagaTodo = true;
    out.push(nota("conductor_apaga_todo", "Con «Conductor» desmarcado este aviso no sale, tampoco a los contactos."));
  }

  if (on && !apagaTodo) {
    const d = destinatariosHoy(clave, cfgs, ctx);
    const nadie = !d.conductorPropio && !d.conductorTercero && !d.pasajero && d.directorio === 0 && !d.proveedor;
    if (nadie) out.push(nota("sin_destinatarios", `Activa pero hoy no le llega a nadie: ${motivoNadie(clave, cfg, f, cfgs)}.`));
  }
  return out;
}
