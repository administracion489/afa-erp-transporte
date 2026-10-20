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

/** ISO desde el que se buscan respuestas humanas: el más reciente entre «hace N horas» y la reactivación. */
export function inicioVentanaHumano(ahoraMs: number, horas: number, reactivadaAt?: string | null): string {
  const ventana = ahoraMs - horas * 3600_000;
  const r = reactivadaAt ? Date.parse(reactivadaAt) : NaN;
  return new Date(Number.isFinite(r) && r > ventana ? r : ventana).toISOString();
}

/** ISO desde el que se cuentan los turnos de IA (null = toda la conversación). */
export function inicioConteoTurnos(reactivadaAt?: string | null): string | null {
  return reactivadaAt && Number.isFinite(Date.parse(reactivadaAt)) ? new Date(Date.parse(reactivadaAt)).toISOString() : null;
}

/** ¿Al reactivar hay un mensaje del cliente esperando respuesta? Solo si el ÚLTIMO del hilo es suyo. */
export function hayClienteEsperando(ultimo: { direccion?: string | null } | null | undefined): boolean {
  return ultimo?.direccion === "entrante";
}
