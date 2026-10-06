// lib/mantenimiento/proximo-servicio.ts
// CUÁNDO TOCA el próximo servicio preventivo de una unidad. Módulo PURO: no lee la base.
//
// Vivía DOS veces —en /mantenimiento → Próximos (ProgramaTab) y en el cron que abre las OT
// automáticas (/api/mantenimiento/alertas)— con un comentario en cada una diciendo «debe coincidir
// con la otra». Dos copias que tienen que coincidir terminan no coincidiendo; ahora las dos llaman
// a esto.
//
// El caso que lo abrió (CWZ-371, 05/10/2026): una lectura de odómetro equivocada hizo creer al
// cron que la unidad ya llegaba a los 20 000 km y abrió la OT #6. Se cerró, y el cierre escribió
// en el libro de mantenimiento un servicio preventivo a 19 484 km. La unidad va por 19 725: el
// servicio de los 20 000 todavía no se hizo, pero «Próximo km» decía 29 484 y no había forma de
// deshacerlo — reabrir, cancelar o eliminar la OT dejaba su fila del libro intacta, y esa fila es
// el ANCLA del cálculo. Dos reglas salen de ahí:
//
//   1. UN SERVICIO CANCELADO NO ANCLA. Una fila del libro en `cancelado` no ocurrió; contarla
//      como «último servicio» corre el calendario por un trabajo que nadie hizo.
//   2. LA FILA QUE ESCRIBIÓ UN CIERRE ES DE ESE CIERRE. Si la OT deja de estar cerrada (se reabre,
//      se cancela o se elimina), su fila se retira (`planAlSalirDeCierre`); si se vuelve a cerrar,
//      el cierre la escribe de nuevo con el km real. Así el libro siempre dice lo que dicen las
//      órdenes cerradas, que es la regla de oro: la OT manda y el libro lo DERIVA.

export type FilaLibro = {
  vehiculo_id: number;
  fecha: string | null;
  kilometraje: number | null;
  tipo?: string | null;
  estado?: string | null;
};

/** ¿Esta fila del libro cuenta como un servicio preventivo HECHO? */
export function esServicioHecho(m: FilaLibro): boolean {
  if (String(m.tipo ?? "preventivo").toLowerCase() !== "preventivo") return false;
  const est = String(m.estado ?? "").toLowerCase();
  return est !== "cancelado" && est !== "cancelada" && est !== "anulado" && est !== "anulada";
}

/**
 * Último servicio preventivo hecho de cada unidad: el de fecha más reciente y, el mismo día, el de
 * más km. Las canceladas no cuentan.
 */
export function ultimoServicioPorVehiculo<T extends FilaLibro>(filas: T[]): Record<number, T> {
  const out: Record<number, T> = {};
  for (const m of filas) {
    if (!esServicioHecho(m)) continue;
    const prev = out[m.vehiculo_id];
    if (!prev) { out[m.vehiculo_id] = m; continue; }
    const f = String(m.fecha ?? ""), fp = String(prev.fecha ?? "");
    if (f > fp || (f === fp && Number(m.kilometraje ?? 0) > Number(prev.kilometraje ?? 0))) out[m.vehiculo_id] = m;
  }
  return out;
}

/**
 * Próximo servicio por KM. El plan del fabricante es por odómetro ABSOLUTO (5k, 10k, 15k…): con
 * un servicio registrado el calendario se re-ancla a él (próximo = servicio + intervalo, puede
 * quedar vencido); sin ninguno, el siguiente hito de la rejilla MAYOR al km actual (una unidad con
 * 7 217 km y plan de 5 000 → próximo 10 000, no 12 217).
 */
export function proximoPorKm(opts: {
  kmActual: number;
  intervaloKm: number | null | undefined;
  ultimoServicioKm: number | null | undefined;
}): { dueKm: number; faltanKm: number; ancla: "servicio" | "rejilla" } | null {
  const inter = Number(opts.intervaloKm || 0);
  if (!(inter > 0)) return null;
  const kmActual = Number(opts.kmActual || 0);
  const ult = opts.ultimoServicioKm;
  const hayServicio = ult != null && Number.isFinite(Number(ult)) && Number(ult) > 0;
  const dueKm = hayServicio ? Number(ult) + inter : (Math.floor(kmActual / inter) + 1) * inter;
  return { dueKm, faltanKm: dueKm - kmActual, ancla: hayServicio ? "servicio" : "rejilla" };
}

export type PlanSalidaCierre =
  | { accion: "nada"; motivo: "sigue_cerrada" | "nunca_cerro" | "sin_ancla" }
  | { accion: "retirar"; mantenimientoId: number; motivo: "reabierta" | "cancelada" | "eliminada" };

/**
 * Qué hacer con la fila del libro cuando una OT cambia de estado o se elimina.
 *
 * Solo se retira la fila que la OT ANCLÓ (`mantenimiento_id`): una OT cerrada antes de que existiera
 * el ancla no sabe cuál es la suya, y borrar «la que parece» podría llevarse el servicio de otra
 * orden. Ese caso se NOMBRA (`sin_ancla`) y se corrige a mano en Historial.
 */
export function planAlSalirDeCierre(
  ot: { estado: string | null; mantenimiento_id: number | null },
  estadoNuevo: string | "eliminada",
): PlanSalidaCierre {
  const antes = String(ot.estado ?? "").toLowerCase();
  const despues = String(estadoNuevo ?? "").toLowerCase();
  if (despues === "cerrada") return { accion: "nada", motivo: "sigue_cerrada" };
  if (antes !== "cerrada" && !ot.mantenimiento_id) return { accion: "nada", motivo: "nunca_cerro" };
  if (!ot.mantenimiento_id) return { accion: "nada", motivo: "sin_ancla" };
  const motivo = despues === "eliminada" ? "eliminada" : despues === "cancelada" ? "cancelada" : "reabierta";
  return { accion: "retirar", mantenimientoId: Number(ot.mantenimiento_id), motivo };
}
