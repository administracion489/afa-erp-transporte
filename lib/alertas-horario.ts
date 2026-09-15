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
//   **NUNCA se retiene un aviso más allá del servicio que anuncia.**
// Un aviso a deshora molesta y se perdona; un aviso que llega después de la hora de
// salida es un bus sin conductor. Es la misma asimetría de `montoDe` con el falso flete:
// se elige siempre el lado del error reversible.

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

/** Ventana de envío de un tipo de mensaje, ya resuelta a minutos del día. */
export type Horario = {
  /** ¿Este tipo de aviso acepta esperar? Los pre-inicio son urgentes por diseño y no. */
  respeta: boolean;
  /** Minuto del día en que ABRE la ventana (null = sin ventana declarada). */
  desdeMin: number | null;
  /** Minuto del día en que CIERRA (exclusivo). */
  hastaMin: number | null;
};

export type CodigoEnvio =
  /** El tipo de mensaje no difiere nunca (aviso urgente pre-inicio, o bandera apagada). */
  | "no_difiere"
  /** No hay ventana declarada, o es de longitud cero: no se inventa una. */
  | "sin_ventana"
  /** Estamos dentro del horario de envío. */
  | "en_ventana"
  /** El servicio es HOY: un cambio de hoy sobre un servicio de hoy se avisa al instante. */
  | "servicio_hoy"
  /** La ventana abriría DESPUÉS de la hora del servicio: esperar sería no avisar. */
  | "no_alcanza"
  /** Sin fecha/hora del servicio no se puede garantizar que la espera no lo tape. */
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
}): Horario {
  return {
    respeta: cfg.respeta_horario === true,
    desdeMin: hhmmAMinutos(cfg.horario_desde),
    hastaMin: hhmmAMinutos(cfg.horario_hasta),
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
 *  4. El servicio es HOY → sale, sea la hora que sea. Que alguien toque un servicio de
 *     hoy a las 03:00 es un hecho real y urgente, no el artefacto de medianoche.
 *  5. La ventana abre después de que el servicio empiece → sale. **La regla dura.**
 *  6. No se sabe QUÉ DÍA es el servicio → sale. Sin fecha no hay forma de comprobar (5),
 *     y ante la duda se envía: molestar es reversible, dejar un bus sin conductor no.
 *     Con fecha pero SIN HORA no se envía a ciegas: se sitúa el servicio a las 00:00 de
 *     su día, o sea en el inicio más temprano que puede tener. Es el lado seguro — un
 *     inicio supuesto más temprano solo puede hacer que (5) mande enviar antes, nunca
 *     que se retenga de más.
 *  7. Si no, ESPERA — y el plan dice hasta cuándo.
 */
export function planDeEnvioConductor(args: {
  /** Instante actual en ms UTC (Date.now() en producción; fijo en las pruebas). */
  ahoraMs: number;
  /** Fecha del servicio que anuncia el aviso ("YYYY-MM-DD"). */
  fechaServicio?: string | null;
  /** Hora pactada del servicio ("HH:MM" o "HH:MM:SS"). */
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
  if (fecha === fechaLima(ahoraMs)) return sale("servicio_hoy", "el servicio es hoy");

  const inicioMs = limaAUtcMs(fecha, String(args.horaServicio || "00:00").slice(0, 5));
  if (inicioMs == null) return sale("sin_fecha", "el aviso no dice a qué hora es el servicio");

  const abreMs = proximaAperturaMs(ahoraMs, desdeMin);
  if (abreMs >= inicioMs) {
    return sale("no_alcanza", `el horario abre a las ${minutosAHhmm(desdeMin)}, después del servicio`);
  }

  return {
    enviar: false,
    codigo: "fuera_de_horario",
    motivo: `fuera del horario de envío (${minutosAHhmm(desdeMin)}–${minutosAHhmm(hastaMin)})`,
    abreMs,
    abreTexto: `${fechaLima(abreMs)} ${minutosAHhmm(desdeMin)}`,
  };
}
