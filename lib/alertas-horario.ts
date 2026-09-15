// lib/alertas-horario.ts — EL HORARIO EN QUE SE LE PUEDE ESCRIBIR A UN CONDUCTOR.
// Módulo PURO: no lee la base, no envía nada y no mira el reloj por su cuenta — el
// instante entra por parámetro. Igual que lib/costeo-propio.ts o lib/retrasos.ts.
//
// EL CASO QUE LO MOTIVÓ (reportado por el dueño, set-2026): los avisos de "vehículo
// asignado" le llegaban al conductor a las 00:00. Tres días seguidos, reservas #18368,
// #18369 y #18370, todas a las 12:00 a. m.
//
// Y las 00:00 no eran una hora elegida: eran el minuto en que el motor VE la reserva por
// primera vez. `/api/alertas-flota/tick` consulta `fecha_servicio in (hoy, mañana)`, así
// que un programa fijo creado con semanas de antelación entra a esa ventana justo cuando
// su fecha pasa a ser "mañana" —o sea, a medianoche— y el diff por reserva lo lee como
// "recién asignado". El aviso no llegaba tarde: llegaba lo antes posible, y lo antes
// posible era mientras el conductor dormía.
//
// POR ESO LO QUE SE ARREGLA NO ES LA DETECCIÓN, ES EL ENVÍO. Adelantar la detección
// (mirar más días) mandaría el aviso un mes antes, cuando todavía no sirve de nada y
// además cambiaría siete veces antes de la fecha. Lo que se cambia es hasta cuándo se
// RETIENE lo ya detectado: hasta que abra la ventana en la que hay alguien despierto
// para leerlo. La retención no pierde nada porque el motor reintenta cada ~10 min y el
// baseline (`avisos_conductor_estado`) solo avanza cuando el envío SALE — el mismo
// "PRINCIPIO ANTI-PÉRDIDA" que ya gobierna el tick.
//
// LA REGLA QUE NO SE PUEDE AFLOJAR, y es la que ordena todas las demás:
//   **SE RETIENE MIENTRAS EL HORARIO TODAVÍA LLEGUE A TIEMPO. Si no llega, es URGENTE
//   y sale al instante.**
// Un aviso a deshora molesta y se perdona; uno que llega encima de la hora de salida es
// un bus sin conductor. Misma asimetría de `montoDe` con el falso flete: siempre el lado
// del error reversible.
//
// ESTA REGLA SE ESCRIBIÓ TRES VECES, Y LAS DOS PRIMERAS LAS ROMPIÓ EL DUEÑO CON UN CASO
// REAL. Vale la pena tenerlas escritas, porque las dos parecían correctas:
//
//  (1) «No se retiene más allá de la HORA del servicio». Demasiado literal: con la
//      ventana 11:59–21:00, un servicio del 15 a las 12:00 programado el 14 a las 21:01
//      se retenía hasta las 11:59 — técnicamente «antes del servicio», y UN MINUTO de
//      aviso. Las 12:00 pasaban el filtro por un minuto; las 14:00, por dos horas.
//
//  (2) «Solo se retiene lo que se entregue la VÍSPERA», o sea por DÍA en vez de por hora.
//      Cerraba (1) sin inventar ningún umbral, y por eso se eligió — pero sobre-corregía:
//      programar a las 23:00 del 14 un servicio del 15 a las 15:00 pasaba a despertar al
//      conductor a las 23:00, cuando el horario abría a las 11:59 con tres horas de
//      sobra. Justo lo que el módulo existe para evitar.
//
//  (3) La formulación del dueño —«romper la regla solo si el servicio cae dentro del
//      horario de no molestar»— TAMPOCO sirve, y es la trampa más fina de las tres: un
//      servicio de pasado mañana a las 06:00 también cae en horas de silencio, así que
//      volvería a avisarse a las 00:05. **Lo que hace urgente a un aviso no es la hora
//      del servicio: es que la próxima apertura del horario ya no llegue a tiempo.**
//
// De ahí la regla actual, que es (3) bien planteada: se compara la próxima apertura
// contra la hora del servicio y se exige un MARGEN mínimo de antelación. Ese margen es el
// único número del módulo, es editable por tipo, y su valor por defecto se HEREDA de
// `proximo_inicio` (90 min): es lo que este ERP ya declara como «esto está por empezar».

/** Minutos de un día completo. */
const MIN_DIA = 1440;
const DIA_MS = 86_400_000;
/** Perú es UTC-5 fijo, sin horario de verano. Mismo supuesto que el resto del ERP. */
const LIMA_OFFSET_MS = 5 * 3_600_000;

/** "HH:MM" → minutos del día (0..1439), o null si no es una hora. */
export function hhmmAMinutos(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  const mm = Number.isFinite(m) ? m : 0;
  if (mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

/** Minutos del día → "HH:MM". */
export function minutosAHhmm(min: number): string {
  const m = ((Math.round(min) % MIN_DIA) + MIN_DIA) % MIN_DIA;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Fecha local de Lima (YYYY-MM-DD) del instante dado. */
export function fechaLima(ms: number): string {
  return new Date(ms - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutos transcurridos del día en Lima (0..1439) para el instante dado. */
export function minutoDelDiaLima(ms: number): number {
  const d = new Date(ms - LIMA_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "YYYY-MM-DD" + "HH:MM" en hora Lima (UTC-5 fijo) → ms UTC absolutos. */
export function limaAUtcMs(fecha?: string | null, horaHHMM?: string | null): number | null {
  if (!fecha) return null;
  const [y, m, d] = String(fecha).slice(0, 10).split("-").map(Number);
  const [hh, mm] = String(horaHHMM || "00:00").split(":").map(Number);
  if (!y || !m || !d || !Number.isFinite(hh)) return null;
  return Date.UTC(y, m - 1, d, hh + 5, mm || 0);
}

/**
 * Antelación mínima con la que el aviso tiene que llegar para que valga la pena esperar.
 * Si al abrir el horario faltara menos que esto para el servicio, es URGENTE y sale ya.
 *
 * HEREDADO de `proximo_inicio` (90 min), que es lo que este ERP ya declara como «esto
 * está por empezar» — no es un umbral elegido para este módulo. Es editable por tipo
 * (`alerta_config.horario_margen_min`) porque es la definición de "urgente" de cada
 * operación, y esa la firma una persona, no el código.
 */
export const MARGEN_URGENTE_MIN = 90;

/** Ventana de envío de un tipo de mensaje, ya resuelta a minutos del día. */
export type Horario = {
  /** ¿Este tipo de aviso acepta esperar? Los pre-inicio son urgentes por diseño y no. */
  respeta: boolean;
  /** Minuto del día en que ABRE la ventana (null = sin ventana declarada). */
  desdeMin: number | null;
  /** Minuto del día en que CIERRA (exclusivo). */
  hastaMin: number | null;
  /** Minutos de antelación por debajo de los cuales el aviso se considera urgente. */
  margenMin: number;
};

export type CodigoEnvio =
  /** El tipo de mensaje no difiere nunca (aviso urgente pre-inicio, o bandera apagada). */
  | "no_difiere"
  /** No hay ventana declarada, o es de longitud cero: no se inventa una. */
  | "sin_ventana"
  /** Estamos dentro del horario de envío. */
  | "en_ventana"
  /** URGENTE: al abrir el horario ya faltaría menos del margen para el servicio (o el
   *  servicio ya habría empezado). Esperar sería avisar tarde, así que sale al instante
   *  aunque sea de madrugada. */
  | "urgente"
  /** Sin fecha del servicio no se puede garantizar que la espera no lo tape. */
  | "sin_fecha";

export type PlanEnvio =
  | { enviar: true; codigo: CodigoEnvio; motivo: string }
  | { enviar: false; codigo: "fuera_de_horario"; motivo: string; abreMs: number; abreTexto: string };

/**
 * Lee la ventana de una fila de `alerta_config`.
 *
 * REGLA DE ORO DE LOS DEFAULTS (la misma de `canalesConductor`): cuando falta el dato
 * —migración `supabase/alertas-horario-conductor.sql` sin correr, fila inexistente,
 * error de red— se devuelve EXACTAMENTE el comportamiento anterior, o sea `respeta:
 * false` = se envía al instante. Un despliegue sin migración no retiene ni un mensaje.
 */
export function horarioDe(cfg: {
  respeta_horario?: boolean | null;
  horario_desde?: string | null;
  horario_hasta?: string | null;
  horario_margen_min?: number | null;
}): Horario {
  // El margen es la ÚNICA excepción a "sin columna = comportamiento anterior", y es
  // deliberado: sin él la regla vuelve a retener un aviso hasta un minuto antes del
  // servicio, que es el defecto que este margen existe para cerrar. La columna solo lo
  // hace editable; que falte no puede reabrir el agujero. Un 0 explícito SÍ se respeta
  // («no consideres nada urgente»), por eso no se usa `||`.
  const margen = Number(cfg.horario_margen_min);
  return {
    respeta: cfg.respeta_horario === true,
    desdeMin: hhmmAMinutos(cfg.horario_desde),
    hastaMin: hhmmAMinutos(cfg.horario_hasta),
    margenMin: Number.isFinite(margen) && margen >= 0 ? margen : MARGEN_URGENTE_MIN,
  };
}

/**
 * ¿El minuto `min` cae dentro de [desde, hasta)?
 *
 * Soporta la ventana que CRUZA MEDIANOCHE (desde 22:00 hasta 06:00) porque nada impide
 * configurarla así desde el panel, y una ventana mal interpretada retendría mensajes
 * para siempre. `desde === hasta` es una ventana de longitud cero: la trata quien llama
 * (`planDeEnvioConductor`) como "sin ventana", nunca como "nunca se puede enviar".
 */
export function dentroDeVentana(min: number, desdeMin: number, hastaMin: number): boolean {
  if (desdeMin === hastaMin) return false;
  return desdeMin < hastaMin
    ? min >= desdeMin && min < hastaMin
    : min >= desdeMin || min < hastaMin;
}

/**
 * Franja que la pantalla llama "de madrugada" al advertir sobre una ventana mal puesta.
 * 00:00–05:00: la hora a la que el dueño reportó que llegaban los avisos.
 */
const MADRUGADA_DESDE = 0;
const MADRUGADA_HASTA = 5 * 60;

/**
 * ¿Esta ventana PERMITE escribir de madrugada?
 *
 * Existe por un error real, y el error fue de la etiqueta, no del motor: la casilla decía
 * «No escribir de madrugada DE 21:00 A 07:00» y esos dos campos son la ventana en la que
 * SÍ se envía, así que quedó configurado «escríbele solo de noche» — exactamente al revés
 * de lo que se quería, y con el mismo aviso saliendo a las 00:05 como si nada se hubiera
 * arreglado. Un rango invertido no es detectable por el motor (una ventana nocturna es
 * legítima: un tipo de aviso podría querer justo eso), así que lo único que se puede hacer
 * es DECIRLO en la pantalla antes de guardar.
 */
export function ventanaCubreMadrugada(desdeMin: number | null, hastaMin: number | null): boolean {
  if (desdeMin == null || hastaMin == null || desdeMin === hastaMin) return false;
  for (let m = MADRUGADA_DESDE; m <= MADRUGADA_HASTA; m++) {
    if (dentroDeVentana(m, desdeMin, hastaMin)) return true;
  }
  return false;
}

/**
 * La frase que la pantalla imprime debajo de los dos campos, derivada de los MISMOS
 * números que usa `planDeEnvioConductor`. Vive aquí y no en el TSX a propósito: la
 * confusión que costó el error fue de DIRECCIÓN (qué mitad del día es la que envía), y
 * una frase compuesta en la pantalla puede volver a describirla al revés sin que nada falle.
 */
export function describirHorario(
  desdeMin: number | null, hastaMin: number | null, margenMin?: number | null,
): string {
  if (desdeMin == null || hastaMin == null) {
    return "Horario incompleto: el aviso sale al instante, como si la casilla estuviera apagada.";
  }
  if (desdeMin === hastaMin) {
    return "La ventana no dura nada: el aviso sale al instante, como si la casilla estuviera apagada.";
  }
  const d = minutosAHhmm(desdeMin), h = minutosAHhmm(hastaMin);
  const m = Number.isFinite(Number(margenMin)) && Number(margenMin) >= 0
    ? Number(margenMin) : MARGEN_URGENTE_MIN;
  const urgencia = m === 0
    ? " Nada se considera urgente: todo lo detectado fuera del rango espera."
    : ` Salvo que al abrir ya falte menos de ${textoDuracion(m)} para el servicio: eso es urgente y sale al instante, sea la hora que sea.`;
  return `Se ENVÍA entre las ${d} y las ${h}. Detectado fuera de ese rango, el aviso espera a las ${d}.${urgencia}`;
}

/** "90 min" → "1 h 30 min". Solo para texto de pantalla. */
export function textoDuracion(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), resto = m % 60;
  return resto ? `${h} h ${resto} min` : `${h} h`;
}

/** Próximo instante (ms UTC) en que el reloj de Lima marca `desdeMin`. */
export function proximaAperturaMs(ahoraMs: number, desdeMin: number): number {
  const hoyApertura = limaAUtcMs(fechaLima(ahoraMs), minutosAHhmm(desdeMin));
  if (hoyApertura == null) return ahoraMs;          // imposible con desdeMin válido
  return hoyApertura > ahoraMs ? hoyApertura : hoyApertura + DIA_MS;
}

const sale = (codigo: CodigoEnvio, motivo: string): PlanEnvio => ({ enviar: true, codigo, motivo });

/**
 * ¿Sale ahora este aviso al conductor, o espera a que abra la ventana?
 *
 * El orden de las reglas ES la decisión, y cada una está aquí y no repartida por el tick
 * para que no aparezca una octava dentro de una pantalla:
 *
 *  1. El tipo no respeta horario → sale. (`proximo_inicio` a 90 min y `recuerda_iniciar`
 *     a 30 min son urgentes POR DISEÑO: retenerlos es exactamente el daño.)
 *  2. Sin ventana declarada → sale. No se inventa un horario, igual que `elegirOdometro`
 *     no inventa un techo cuando no hay historial.
 *  3. Dentro de la ventana → sale.
 *  4. No se sabe QUÉ DÍA es el servicio → sale. Sin fecha no hay forma de comprobar (5),
 *     y ante la duda se envía: molestar es reversible, dejar un bus sin conductor no.
 *  5. Al abrir el horario faltaría menos del MARGEN para el servicio → sale (`urgente`).
 *     **La regla dura**, y la que decide los tres casos que rompieron las versiones
 *     anteriores: el servicio de madrugada programado anoche (la apertura ya no llega),
 *     el del mediodía programado anoche (llegaría con un minuto) y el de la tarde
 *     programado anoche (llegaría con tres horas — ése SÍ espera).
 *  6. Si no, ESPERA — y el plan dice hasta cuándo.
 *
 * Ya no hay regla de «servicio de HOY»: era una excepción demasiado ancha que despertaba
 * al conductor a las 03:00 por un servicio de las 15:00 del mismo día. Un servicio de hoy
 * cuya hora está cerca cae en (5) por su cuenta, que es lo correcto.
 */
export function planDeEnvioConductor(args: {
  /** Instante actual en ms UTC (Date.now() en producción; fijo en las pruebas). */
  ahoraMs: number;
  /** Fecha del servicio que anuncia el aviso ("YYYY-MM-DD"). */
  fechaServicio?: string | null;
  /** Hora pactada del servicio ("HH:MM" o "HH:MM:SS"). Sin ella se supone el inicio más
   *  temprano posible (00:00 de su día), que es el lado seguro: solo puede adelantar el
   *  envío, nunca retenerlo de más. */
  horaServicio?: string | null;
  horario: Horario;
}): PlanEnvio {
  const { ahoraMs, horario } = args;

  if (!horario.respeta) return sale("no_difiere", "este tipo de aviso no espera horario");

  const { desdeMin, hastaMin } = horario;
  if (desdeMin == null || hastaMin == null || desdeMin === hastaMin) {
    return sale("sin_ventana", "sin horario de envío declarado");
  }

  const ahoraMin = minutoDelDiaLima(ahoraMs);
  if (dentroDeVentana(ahoraMin, desdeMin, hastaMin)) {
    return sale("en_ventana", `dentro del horario ${minutosAHhmm(desdeMin)}–${minutosAHhmm(hastaMin)}`);
  }

  const fecha = String(args.fechaServicio || "").slice(0, 10);
  if (!fecha) return sale("sin_fecha", "el aviso no dice de qué día es el servicio");
  const inicioMs = limaAUtcMs(fecha, String(args.horaServicio || "00:00").slice(0, 5));
  if (inicioMs == null) return sale("sin_fecha", "el aviso no dice cuándo es el servicio");

  const abreMs = proximaAperturaMs(ahoraMs, desdeMin);
  const antelacionMin = Math.floor((inicioMs - abreMs) / 60_000);
  if (antelacionMin < horario.margenMin) {
    return sale("urgente", antelacionMin <= 0
      ? `al abrir el horario el servicio ya habría empezado`
      : `al abrir el horario faltarían ${antelacionMin} min para el servicio`);
  }

  return {
    enviar: false,
    codigo: "fuera_de_horario",
    motivo: `fuera del horario de envío (${minutosAHhmm(desdeMin)}–${minutosAHhmm(hastaMin)})`,
    abreMs,
    abreTexto: `${fechaLima(abreMs)} ${minutosAHhmm(desdeMin)}`,
  };
}
