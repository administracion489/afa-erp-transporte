// lib/nomina-envio.ts — PURO. ¿A quién de la nómina le llega un envío masivo?
//
// Nació del 18-10-2026: «💬 Enviar por WhatsApp (70)» le escribía a TODA la nómina, y cada
// plantilla (la invitación quedó como Marketing) se cobra. Lo normal es invitar solo a los que
// se dieron de alta hace poco, así que el envío masivo se acota por la FECHA DE ALTA del pasajero
// (`pasajeros.created_at`) en hora de Lima — el servidor y la base van en UTC, y un alta de las
// 20:00 de Lima ya es «mañana» en UTC.

export type PeriodoAlta = "7d" | "30d" | "mes" | "rango" | "todos";

export const PERIODOS_ALTA: { id: PeriodoAlta; etiqueta: string }[] = [
  { id: "7d", etiqueta: "Últimos 7 días" },
  { id: "30d", etiqueta: "Últimos 30 días" },
  { id: "mes", etiqueta: "Este mes" },
  { id: "rango", etiqueta: "Rango de fechas" },
  { id: "todos", etiqueta: "Todos" },
];

const LIMA_MS = 5 * 3600 * 1000;

/** Fecha (YYYY-MM-DD) en Lima de un instante. */
export function fechaLimaDeTs(ts: string | number | Date): string | null {
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - LIMA_MS).toISOString().slice(0, 10);
}

function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Rango [desde, hasta] (inclusive, fechas de Lima) del periodo; null en un extremo = sin límite.
 *  Un rango incompleto o al revés devuelve `invalido` y no selecciona a nadie: un rango mal
 *  escrito NO puede caer en «todos», que es justo el envío caro que esto existe para evitar. */
export function rangoDePeriodo(
  periodo: PeriodoAlta, hoy: string, desde?: string, hasta?: string,
): { desde: string | null; hasta: string | null } | { invalido: string } {
  switch (periodo) {
    case "todos": return { desde: null, hasta: null };
    case "7d": return { desde: restarDias(hoy, 6), hasta: hoy };
    case "30d": return { desde: restarDias(hoy, 29), hasta: hoy };
    case "mes": return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy };
    case "rango": {
      if (!desde || !hasta) return { invalido: "Elige las dos fechas del rango." };
      if (desde > hasta) return { invalido: "La fecha «desde» es posterior a «hasta»." };
      return { desde, hasta };
    }
  }
}

/** Pasajeros de la nómina dados de alta dentro del periodo. Sin fecha de alta conocida solo
 *  entran con «todos»: no se puede afirmar que sean recientes. */
export function filtrarPorAlta<T extends { created_at?: string | null }>(
  nomina: T[], rango: { desde: string | null; hasta: string | null },
): T[] {
  if (rango.desde == null && rango.hasta == null) return nomina;
  return nomina.filter(p => {
    const f = p.created_at ? fechaLimaDeTs(p.created_at) : null;
    if (!f) return false;
    if (rango.desde && f < rango.desde) return false;
    if (rango.hasta && f > rango.hasta) return false;
    return true;
  });
}
