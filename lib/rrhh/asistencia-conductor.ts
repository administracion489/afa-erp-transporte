// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/asistencia-conductor.ts — MOTOR PURO: presencia del conductor por servicios.
//
// El conductor no ficha en la sede (maneja en la calle), así que su asistencia se
// DERIVA de tener ≥1 servicio NO CANCELADO ese día. "No cancelado" usa la fuente única
// de estados del ERP (`normalizaEstado` de lib/estados.ts): una segunda definición de
// "cancelado" es cómo dos módulos terminan contando distinto.
//
// LÍMITE DECLARADO: esto es asistencia-por-asignación (tenía un servicio que no se
// canceló), NO "condujo de verdad" — eso lo confirmarían el GPS o el check-out en otro
// módulo. Un servicio `programada`/`confirmada`/`en_curso`/`finalizada` cuenta como
// presencia; solo `cancelada` no.
// ──────────────────────────────────────────────────────────────────────────────

import { normalizaEstado } from "@/lib/estados";
import type { PresenciaConductor } from "./tipos";

/** ¿El servicio cuenta para la presencia? Reusa la normalización única de estados. */
export function esServicioNoCancelado(estado: unknown): boolean {
  return normalizaEstado(estado as string) !== "cancelada";
}

/**
 * Presencia del conductor en un día a partir de sus reservas de ese día.
 * `presente` = al menos un servicio no cancelado. Un día con TODOS los servicios
 * cancelados NO es presencia (cancelados > 0, no_cancelados = 0, presente = false).
 */
export function presenciaDeServicios(
  reservasDelDia: ReadonlyArray<{ estado?: string | null }> | null | undefined,
): PresenciaConductor {
  const rs = reservasDelDia ?? [];
  let noCancelados = 0;
  let cancelados = 0;
  for (const r of rs) {
    if (esServicioNoCancelado(r?.estado)) noCancelados++;
    else cancelados++;
  }
  return {
    presente: noCancelados >= 1,
    no_cancelados: noCancelados,
    cancelados,
    total: rs.length,
  };
}
