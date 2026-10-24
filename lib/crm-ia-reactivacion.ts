// ──────────────────────────────────────────────────────────────────────────────
// lib/crm-ia-reactivacion.ts — Motor PURO: qué cuenta después de que una persona REACTIVA la IA.
//
// EL CASO (20-10-2026): en un chat del 966 707 225 se pulsaba «🤖 IA pausada» → «IA activa» y la IA
// seguía sin contestar. Dos reglas del motor miraban la HISTORIA del hilo sin saber que alguien acababa
// de decidir otra cosa:
//   1. «Una persona respondió en las últimas N h (12 por defecto) → la IA no interviene»: el mensaje
//      que la persona mandó ANTES de reactivar la seguía apartando hasta 12 h.
//   2. «Límite de turnos automáticos»: contaba todos los mensajes de IA del hilo, así que una
//      conversación que ya lo había alcanzado se volvía a pausar sola en el siguiente mensaje.
// Las dos reglas son buenas mientras nadie decide; pulsar el botón ES la decisión, y desde ese
// momento las dos cuentan solo lo que pasó DESPUÉS (`ia_reactivada_at`, supabase/crm-ia-reactivacion.sql).
// Una persona que responde después de reactivar vuelve a apartar a la IA, como siempre.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Cuánto puede adelantarse una reactivación respecto de «ahora» y seguir contando (el desfase entre el
 * reloj del servidor que la escribió y el que la lee). NO medido: un margen holgado para un reloj.
 * Una reactivación más en el futuro que esto no es una reactivación: la escribe el servidor con su
 * `now()` (/api/crm/ia/reactivar), así que una fecha de 2099 solo pudo ponerla alguien a mano para que
 * la pausa por respuesta humana dejara de contar (supabase/crm-ia-reactivacion-02-solo-servidor.sql
 * cierra la puerta; esto es el respaldo del código). Se ignora: como si no hubiera reactivación.
 */
export const MARGEN_RELOJ_REACTIVACION_MS = 5 * 60_000;

/** La reactivación en ms, o null si no hay, no se entiende o está más en el futuro que el margen. */
export function reactivacionValida(reactivadaAt: string | null | undefined, ahoraMs: number): number | null {
  const r = reactivadaAt ? Date.parse(reactivadaAt) : NaN;
  if (!Number.isFinite(r)) return null;
  if (Number.isFinite(ahoraMs) && r > ahoraMs + MARGEN_RELOJ_REACTIVACION_MS) return null;
  return r;
}

/**
 * ISO desde el que se buscan respuestas humanas: el más reciente entre «hace N horas» y la reactivación.
 * Una reactivación más en el futuro que `MARGEN_RELOJ_REACTIVACION_MS` se ignora (la ventana de siempre).
 */
export function inicioVentanaHumano(ahoraMs: number, horas: number, reactivadaAt?: string | null): string {
  const ventana = ahoraMs - horas * 3600_000;
  const r = reactivacionValida(reactivadaAt, ahoraMs);
  return new Date(r != null && r > ventana ? r : ventana).toISOString();
}

/**
 * ISO desde el que se cuentan los turnos de IA (null = toda la conversación). Con `ahoraMs`, una
 * reactivación más en el futuro que el margen se ignora (si no, ningún turno contaría y el límite no
 * pausaría nunca); sin él, la lectura de siempre.
 */
export function inicioConteoTurnos(reactivadaAt?: string | null, ahoraMs?: number): string | null {
  if (typeof ahoraMs === "number") {
    const r = reactivacionValida(reactivadaAt, ahoraMs);
    return r != null ? new Date(r).toISOString() : null;
  }
  return reactivadaAt && Number.isFinite(Date.parse(reactivadaAt)) ? new Date(Date.parse(reactivadaAt)).toISOString() : null;
}

/** ¿Al reactivar hay un mensaje del cliente esperando respuesta? Solo si el ÚLTIMO del hilo es suyo. */
export function hayClienteEsperando(ultimo: { direccion?: string | null } | null | undefined): boolean {
  return ultimo?.direccion === "entrante";
}

/** Las horas que la IA se aparta tras la actividad de una persona cuando el agente no dice un número. */
export const HORAS_PAUSA_DEFECTO = 12;

/**
 * Horas que la IA se aparta cuando actúa una persona del equipo (`crm_agentes_ia.pausa_humano_horas`):
 * la MISMA lectura con que el motor decide si contesta (lib/crm-ia.ts, que la reexporta), con que el
 * prompt lo dice y con que la reserva de traslados juzga una cotización corregida
 * (lib/traslados/cotizacion-corregida.ts). 12 si no hay un número; 0 (o menos) apaga la pausa. Un
 * `null` es 0, como siempre (`Number(null)`): lo fija la matriz del prompt.
 */
export function horasPausaHumano(agente: { pausa_humano_horas?: unknown } | null | undefined): number {
  return Number.isFinite(Number(agente?.pausa_humano_horas)) ? Number(agente?.pausa_humano_horas) : HORAS_PAUSA_DEFECTO;
}
