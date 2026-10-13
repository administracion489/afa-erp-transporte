// lib/flota/recorrido-datos.ts — SOLO SERVIDOR. Lee lo que dibuja lib/flota/recorrido.ts (puro): la
// traza de UN servicio, con sus filas, por el MISMO camino que la estadística por servicio de
// /uso-flota y la torre (`medirServicio` con `conHuella`, lib/gps-cobertura-datos.ts). Así el rojo del
// mapa sale de la misma traza y del mismo motor que la columna «Excesos».
//
// No devuelve teléfonos, identificadores de aparato ni las filas crudas: solo coordenadas, horas y
// las velocidades de los episodios.

import { medirServicio, paradasDeReservas } from "../gps-cobertura-datos";
import { leerReservaDiag, type FilaReservaDiag } from "../gps-diagnostico-datos";
import { vehiculoDeReserva } from "./servicio-estadistica";
import { recorridoDeServicio, type RecorridoServicio } from "./recorrido";
import type { VeredictoRastreo } from "../gps-cobertura";

/** El veredicto de un servicio cancelado: no se midió y no hay nada que juzgar. */
const CANCELADO: VeredictoRastreo = {
  codigo: "no_aplica", pct: null, problema: null, celda: "—", color: "#6b7280", bg: "#f3f4f6",
  detalle: "El servicio se canceló: no hay recorrido que medir.", ultimaSenalTs: null, enCurso: false,
};

/**
 * El recorrido de la reserva `id` con el umbral ya validado. `reserva` se pasa si ya se leyó (la ruta
 * la lee primero para decidir el 404 y la ventana de días). null si la reserva no existe. LANZA si no
 * se pudo leer la reserva o sus paradas; la traza que no se puede leer sale `sin_medir`, no lanza.
 */
export async function recorridoDeReserva(
  id: number,
  o: { hoy: string; ahoraMs: number; umbral: number; reserva?: FilaReservaDiag | null },
): Promise<RecorridoServicio | null> {
  const r = o.reserva ?? await leerReservaDiag(id);
  if (!r) return null;
  const ps = (await paradasDeReservas([id])).get(id) ?? [];
  // Un servicio cancelado no se mide (la torre ni lo consulta): no hay recorrido que dibujar.
  const cancelado = r.estado === "cancelada";
  const m = cancelado ? null : await medirServicio(r, ps, { hoy: o.hoy, ahoraMs: o.ahoraMs, conHuella: true });
  return recorridoDeServicio({
    reservaId: id,
    crudas: m?.traza && Array.isArray(m.traza.crudas) ? m.traza.crudas : null,
    aplica: !cancelado && !!m?.ctx.aplica,
    trazaLeida: !!m?.traza,
    rastreo: m ? m.veredicto : CANCELADO,
    umbral: o.umbral,
    vehiculo: vehiculoDeReserva(r)?.clave ?? null,
  });
}
