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
//
// Y una tercera, del mismo caso un día después: la OT #6 se ELIMINÓ antes de que existiera la
// regla 2, así que su fila («OT #6 — CWZ-371») se quedó en el libro, huérfana, y siguió anclando.
// Borrar la OT no podía arreglarla —ya no había OT que borrar—. Por eso:
//
//   3. UNA FILA QUE NOMBRA UNA OT QUE YA NO ESTÁ CERRADA NO ANCLA. Si la OT se eliminó, o existe
//      pero está abierta o cancelada, ese servicio no ocurrió. Se lee con `otEnDescripcion` (el
//      MISMO lector que usó la migración para adoptar las filas viejas) y con el estado real de
//      esas OT, que el llamador consulta. Sin poder consultarlas (`estadoOT` ausente) no se juzga:
//      una consulta fallida no puede convertir todo el libro en huérfano.
//   4. LO QUE TODAVÍA NO PASÓ NO ANCLA. Una fila con fecha posterior a hoy es un servicio
//      programado, no hecho: como «último servicio» corre el calendario por un trabajo futuro.

import { otEnDescripcion } from "./costo-ot";

export type FilaLibro = {
  vehiculo_id: number;
  fecha: string | null;
  kilometraje: number | null;
  tipo?: string | null;
  estado?: string | null;
  descripcion?: string | null;
};

/** Estado actual de las OT que nombra el libro, por id. Una OT que no está en el mapa NO EXISTE. */
export type EstadosOT = Map<number, string>;

export type OpcionesAncla = {
  /** Estado de las OT mencionadas. Ausente/null = no se pudo consultar → no se juzga por OT. */
  estadoOT?: EstadosOT | null;
  /** Hoy en Lima (YYYY-MM-DD). Ausente = no se juzga por fecha. */
  hoy?: string | null;
};

export type MotivoNoAncla =
  | "no_preventivo"
  | "cancelado"
  | "futuro"
  | "ot_eliminada"
  | "ot_no_cerrada";

export const TEXTO_NO_ANCLA: Record<MotivoNoAncla, string> = {
  no_preventivo: "no es preventivo",
  cancelado: "está cancelado",
  futuro: "tiene fecha futura: todavía no ocurrió",
  ot_eliminada: "su orden de trabajo ya no existe (se eliminó)",
  ot_no_cerrada: "su orden de trabajo ya no está cerrada",
};

/** El número de OT que nombra la descripción («OT #6 — CWZ-371»). Mismo lector que la migración 05. */
export const otDeFila = otEnDescripcion;

/** Los ids de OT que nombra el libro, para consultar su estado en lote. */
export function otsMencionadas(filas: FilaLibro[]): number[] {
  const s = new Set<number>();
  for (const f of filas) { const id = otDeFila(f.descripcion); if (id) s.add(id); }
  return [...s];
}

/** Por qué esta fila NO cuenta como servicio hecho; null si cuenta (ancla). */
export function porQueNoAncla(m: FilaLibro, opts: OpcionesAncla = {}): MotivoNoAncla | null {
  if (String(m.tipo ?? "preventivo").toLowerCase() !== "preventivo") return "no_preventivo";
  const est = String(m.estado ?? "").toLowerCase();
  if (est === "cancelado" || est === "cancelada" || est === "anulado" || est === "anulada") return "cancelado";
  if (opts.hoy && m.fecha && String(m.fecha).slice(0, 10) > opts.hoy) return "futuro";
  if (opts.estadoOT) {
    const ot = otDeFila(m.descripcion);
    if (ot != null) {
      const e = opts.estadoOT.get(ot);
      if (e == null) return "ot_eliminada";
      if (String(e).toLowerCase() !== "cerrada") return "ot_no_cerrada";
    }
  }
  return null;
}

/** ¿Esta fila del libro cuenta como un servicio preventivo HECHO? */
export function esServicioHecho(m: FilaLibro, opts: OpcionesAncla = {}): boolean {
  return porQueNoAncla(m, opts) === null;
}

/**
 * Último servicio preventivo hecho de cada unidad: el de fecha más reciente y, el mismo día, el de
 * más km. Las canceladas, las futuras y las de una OT eliminada o no cerrada no cuentan.
 */
export function ultimoServicioPorVehiculo<T extends FilaLibro>(filas: T[], opts: OpcionesAncla = {}): Record<number, T> {
  const out: Record<number, T> = {};
  for (const m of filas) {
    if (!esServicioHecho(m, opts)) continue;
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
