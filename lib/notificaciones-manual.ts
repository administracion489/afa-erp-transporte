// lib/notificaciones-manual.ts
// El aviso MANUAL a los pasajeros de un servicio (botón del manifiesto y re-aviso tras
// cambiar la hora). Motor PURO: decide a quién se le escribe; no lee ni envía nada.
//
// EL CASO (01–12/10/2026, cliente Patricia Mendieta): `recordatorio_servicio` gastó
// US$ 0.54 en 25 WhatsApp «manuales». El botón del manifiesto se llamaba «Sincronizar»
// —y «Sincronizar y Cerrar» al pie— sin decir que además le escribe a cada pasajero:
//   · la reserva 18394 se «sincronizó» tres veces en 4 minutos → los mismos 5 pasajeros
//     recibieron el mismo WhatsApp tres veces;
//   · se «sincronizaron» servicios del 22/08 y del 25/09 el 02/10 → «te recordamos tu
//     servicio» sobre un viaje que ya ocurrió.
//
// Las dos reglas que no se aflojan:
//   1. UN SERVICIO PASADO NO SE AVISA. No hay a qué llegar: el mensaje solo puede confundir.
//   2. A QUIEN YA SE LE AVISÓ ESTE SERVICIO NO SE LE REPITE. Volver a pulsar el botón avisa
//      solo a los pasajeros NUEVOS del manifiesto. La única excepción es el cambio de hora:
//      ahí el aviso anterior quedó con una hora falsa y repetirlo es corregirlo.

export type MotivoAvisoManual = "manifiesto" | "cambio_hora";

export type CodigoAvisoManual =
  /** Se le escribe a los pasajeros de `avisar`. */
  | "avisar"
  /** El servicio ya pasó: no se le escribe a nadie. */
  | "servicio_pasado"
  /** Todos los pasajeros ya recibieron el aviso de este servicio. */
  | "todos_avisados"
  /** El manifiesto no tiene pasajeros. */
  | "sin_pasajeros";

export type PlanAvisoManual = {
  codigo: CodigoAvisoManual;
  /** Pasajeros a los que SÍ se les escribe. */
  avisar: number[];
  /** Pasajeros que no se repiten porque ya recibieron el aviso. */
  yaAvisados: number[];
};

/** "YYYY-MM-DD" < "YYYY-MM-DD" funciona en texto. Sin fecha no se afirma que pasó. */
export function servicioPasado(fechaServicio: string | null | undefined, hoy: string): boolean {
  if (!fechaServicio || !/^\d{4}-\d{2}-\d{2}/.test(fechaServicio)) return false;
  return fechaServicio.slice(0, 10) < hoy;
}

export function planAvisoManual(args: {
  fechaServicio: string | null | undefined;
  /** Hoy en Lima ("YYYY-MM-DD"). */
  hoy: string;
  motivo: MotivoAvisoManual;
  /** Pasajeros del manifiesto. */
  pasajeros: number[];
  /** Pasajeros con un aviso manual ENVIADO de este servicio. */
  avisadosAntes: Iterable<number>;
}): PlanAvisoManual {
  const todos = [...new Set(args.pasajeros)];
  const antes = new Set(args.avisadosAntes);
  if (servicioPasado(args.fechaServicio, args.hoy)) {
    return { codigo: "servicio_pasado", avisar: [], yaAvisados: todos.filter((p) => antes.has(p)) };
  }
  if (todos.length === 0) return { codigo: "sin_pasajeros", avisar: [], yaAvisados: [] };
  if (args.motivo === "cambio_hora") {
    return { codigo: "avisar", avisar: todos, yaAvisados: [] };
  }
  const avisar = todos.filter((p) => !antes.has(p));
  const yaAvisados = todos.filter((p) => antes.has(p));
  return { codigo: avisar.length ? "avisar" : "todos_avisados", avisar, yaAvisados };
}

/** La frase para la pantalla, del mismo plan que usa el servidor. */
export function textoPlanAvisoManual(p: PlanAvisoManual): string {
  switch (p.codigo) {
    case "servicio_pasado":
      return "Este servicio ya pasó: no se avisa a los pasajeros.";
    case "sin_pasajeros":
      return "El manifiesto no tiene pasajeros: no hay a quién avisar.";
    case "todos_avisados":
      return `Los ${p.yaAvisados.length} pasajero(s) ya recibieron el aviso de este servicio: no se repite.`;
    case "avisar":
      return `Se avisará a ${p.avisar.length} pasajero(s)` +
        (p.yaAvisados.length ? ` (${p.yaAvisados.length} ya lo recibieron y no se repite)` : "") + ".";
  }
}
