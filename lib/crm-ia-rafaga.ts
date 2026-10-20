/**
 * Ráfaga de mensajes del cliente · qué mensajes VIO la última respuesta de la IA.
 *
 * El caso (20-10-2026, 09:36-09:37): el cliente escribió «cotízame un bus 50 de Barranco al
 * aeropuerto», a los 28 s «Del hotel casa andina. Con maletas» y a los 25 s «Fecha 25 diciembre
 * hora 3:00 pm». La IA contestó 5 s después del tercero pidiéndole fecha, hora y maletas, y el
 * tercero no lo contestó nadie. Dos fallas encadenadas:
 *
 *   1. La corrida del SEGUNDO mensaje comprobaba «¿el cliente siguió escribiendo?» y DESPUÉS
 *      esperaba `delay_segundos` (5) antes de enviar. El tercero llegó dentro de esa espera y la
 *      respuesta salió vieja. (Arreglado en lib/crm-ia.ts: la comprobación va tras la espera.)
 *   2. La corrida del TERCERO, al tomar el turno, vio que el último mensaje era nuestro y se
 *      retiró («El último mensaje ya es nuestro»), aunque esa respuesta se había escrito sin verlo.
 *      Y como el último mensaje era nuestro, la bandeja tampoco decía por qué la IA calló.
 *
 * La segunda no se puede contestar mirando solo el orden de los mensajes: entre la última
 * comprobación y el registro del envío siempre queda una ventana (la llamada a Meta), y un
 * mensaje que entra ahí queda ANTES de nuestra respuesta sin que ella lo haya leído. Por eso la
 * corrida que envía deja escrita su MARCA en `crm_conversaciones.ia_ultima_decision.marca`:
 * hasta qué mensaje del cliente leyó y hasta cuándo estuvo enviando. Sin migración: esa columna ya
 * existe (crm-ia-decision.sql) y, sin ella, todo se comporta como antes.
 *
 * Módulo PURO: no lee la base. Matriz: `npx tsx scripts/prueba-crm-ia-rafaga.mts`.
 */

/** Lo que deja escrito la corrida que ENVIÓ una respuesta. */
export type MarcaRespuesta = {
  /** El último mensaje del cliente que leyó esa respuesta. */
  visto_id: string;
  visto_at: string;
  /** Cuándo terminó de enviar (texto y, si hubo, el PDF): todo lo suyo quedó registrado antes. */
  hasta: string;
};

/**
 * Margen para el reloj de Postgres contra el de la función: `created_at` lo pone la base y
 * `hasta` el servidor. Ninguna otra respuesta de la IA puede caer dentro: la siguiente corrida
 * toma el turno después de que esta escribe la marca, y redactar le lleva más que esto.
 */
export const MARGEN_RELOJ_MS = 2_000;

const ms = (s: unknown): number => (typeof s === "string" ? Date.parse(s) : NaN);

/** Lee la marca de `ia_ultima_decision`; cualquier cosa que no tenga su forma exacta es null. */
export function leerMarca(decision: unknown): MarcaRespuesta | null {
  const m = (decision as any)?.marca;
  if (!m || typeof m !== "object") return null;
  const { visto_id, visto_at, hasta } = m as Record<string, unknown>;
  if (typeof visto_id !== "string" || !visto_id) return null;
  if (!Number.isFinite(ms(visto_at)) || !Number.isFinite(ms(hasta))) return null;
  if (ms(hasta) < ms(visto_at)) return null;
  return { visto_id, visto_at: visto_at as string, hasta: hasta as string };
}

/**
 * La marca que sobrevive a una decisión nueva: la de esta corrida si envió, y si no, la anterior.
 * Una corrida que no envió (pausada, copiloto, un error) no cambia qué leyó la última respuesta.
 */
export function marcaVigente(nueva: MarcaRespuesta | null | undefined, decisionAnterior: unknown): MarcaRespuesta | null {
  return nueva ?? leerMarca(decisionAnterior);
}

export type MensajeRafaga = {
  id: string;
  direccion: string;
  created_at: string;
  generado_por_ia?: boolean | null;
};

/** ¿Este mensaje lo escribió la corrida que dejó la marca (o una respuesta anterior a ella)? */
function dentroDeLaMarca(m: MensajeRafaga, marca: MarcaRespuesta): boolean {
  const t = ms(m.created_at);
  return Number.isFinite(t) && t <= ms(marca.hasta) + MARGEN_RELOJ_MS;
}

/** ¿La respuesta de la marca leyó este mensaje del cliente? */
export function loVio(m: { id: string; created_at: string }, marca: MarcaRespuesta): boolean {
  if (m.id === marca.visto_id) return true;
  const t = ms(m.created_at);
  // Sin fecha legible no se puede afirmar que no lo vio: el lado seguro es el de antes.
  return !Number.isFinite(t) || t <= ms(marca.visto_at);
}

export type CodigoUltimo =
  /** El último mensaje es del cliente: se contesta. */
  | "cliente_espera"
  /** El último es de una persona del equipo (o no se sabe de quién): no se contesta. */
  | "respondio_persona"
  /** El último es de la IA y leyó este mensaje: ya está contestado. */
  | "ya_contestado"
  /** El último es de la IA pero se escribió SIN leer este mensaje: se contesta. */
  | "no_lo_vio";

export const CONTESTA: Record<CodigoUltimo, boolean> = {
  cliente_espera: true,
  respondio_persona: false,
  ya_contestado: false,
  no_lo_vio: true,
};

/**
 * La corrida de `propio` (el mensaje del cliente que la despertó) ya tiene el turno: ¿contesta?
 * Sin marca —sin la columna, o una respuesta anterior a este cambio— todo mensaje nuestro al
 * final cuenta como contestado, que es el comportamiento de antes.
 */
export function juzgarUltimo(
  ultimo: MensajeRafaga | null | undefined,
  propio: { id: string; created_at: string } | null | undefined,
  marca: MarcaRespuesta | null | undefined,
): CodigoUltimo {
  if (!ultimo || ultimo.direccion !== "saliente") return "cliente_espera";
  if (ultimo.generado_por_ia !== true) return "respondio_persona";
  if (!propio || !marca) return "ya_contestado";
  // Una respuesta de la IA posterior a la marca no es la que la marca describe.
  if (!dentroDeLaMarca(ultimo, marca)) return "ya_contestado";
  return loVio(propio, marca) ? "ya_contestado" : "no_lo_vio";
}

export const MOTIVO_ULTIMO: Record<Exclude<CodigoUltimo, "cliente_espera" | "no_lo_vio">, string> = {
  respondio_persona: "El último mensaje ya es nuestro: lo escribió una persona del equipo.",
  ya_contestado: "El último mensaje ya es nuestro: la IA ya contestó lo que escribió el cliente.",
};

/**
 * El historial que lee el modelo, con los mensajes del cliente que la última respuesta NO leyó
 * puestos DESPUÉS de ella: así el modelo ve «pedí la fecha → el cliente me dio la fecha», que es
 * lo que pasó, y no una respuesta suya que ignora lo que el cliente acababa de escribir. Nada se
 * quita ni se duplica; sin marca, o si no hay nada que mover, el orden es el de siempre.
 */
export function ordenarRafaga<T extends MensajeRafaga>(msgs: T[], marca: MarcaRespuesta | null | undefined): T[] {
  if (!marca) return msgs;
  // Lo que escribió la corrida de la marca: respuestas de la IA posteriores a lo que leyó y dentro de su envío.
  let ultimaSuya = -1;
  msgs.forEach((m, i) => {
    if (m.direccion !== "saliente" || m.generado_por_ia !== true) return;
    const t = ms(m.created_at);
    if (Number.isFinite(t) && t > ms(marca.visto_at) && dentroDeLaMarca(m, marca)) ultimaSuya = i;
  });
  if (ultimaSuya < 0) return msgs;
  const mover = new Set<number>();
  for (let i = 0; i < ultimaSuya; i++) {
    const m = msgs[i];
    if (m.direccion === "entrante" && !loVio(m, marca)) mover.add(i);
  }
  if (mover.size === 0) return msgs;
  const out: T[] = [];
  msgs.forEach((m, i) => {
    if (mover.has(i)) return;
    out.push(m);
    if (i === ultimaSuya) for (const j of [...mover].sort((a, b) => a - b)) out.push(msgs[j]);
  });
  return out;
}
