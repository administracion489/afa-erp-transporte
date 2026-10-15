// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/vacaciones.ts — MOTOR PURO: saldo de vacaciones por antigüedad y gozados.
//
// El régimen se RECIBE como parámetro (sus `vacaciones_dias`); nunca se lee de la base.
// Los días gozados salen de las ausencias ya registradas, no se re-cuentan de fechas:
// cuántos días dura una ausencia lo decide quien la crea, con el calendario laboral
// que corresponda (otro módulo). Aquí solo se SUMA lo aprobado y se resta de lo ganado.
//
// LA REGLA DURA: un DOBLE DESCUENTO nunca baja el saldo. Pasar la misma ausencia dos
// veces (mismo id) descuenta una sola vez. Un saldo negativo legítimo (vacaciones
// adelantadas) SÍ se muestra —es una deuda real—; lo único que no puede ocurrir es que
// lo empuje a negativo una ausencia contada por duplicado.
// ──────────────────────────────────────────────────────────────────────────────

import type { Ausencia, RegimenVacaciones, SaldoVacaciones } from "./tipos";

/** "YYYY-MM-DD" → {y,m,day}, o null si no es una fecha ISO. */
function parseISO(d: string | null | undefined): { y: number; m: number; day: number } | null {
  const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  if (!mm) return null;
  const y = +mm[1], m = +mm[2], day = +mm[3];
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  return { y, m, day };
}

/**
 * Años de servicio COMPLETOS (antigüedad trunca). El derecho a vacaciones vesta al
 * cumplir cada año de servicio: antes del primer aniversario, 0 años ganados. La
 * aritmética va sobre la cadena ISO (sin Date ni husos): año = diferencia de años
 * menos uno si aún no llegó el aniversario de este año. Ingreso futuro → 0.
 */
export function aniosCompletos(fechaIngreso: string, hoy: string): number {
  const a = parseISO(fechaIngreso), b = parseISO(hoy);
  if (!a || !b) return 0;
  let anios = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.day < a.day)) anios--;
  return Math.max(0, anios);
}

/**
 * Saldo de vacaciones: días ganados (por antigüedad × días del régimen) menos gozados
 * (ausencias tipo 'vacaciones' APROBADAS, deduplicadas por id).
 */
export function saldoVacaciones(
  regimen: RegimenVacaciones,
  fechaIngreso: string,
  ausencias: ReadonlyArray<Ausencia> | null | undefined,
  hoy: string,
): SaldoVacaciones {
  const vacDias = Math.max(0, Number(regimen?.vacaciones_dias ?? 0) || 0);
  const anios = aniosCompletos(fechaIngreso, hoy);
  const ganados = anios * vacDias;

  const vistos = new Set<string>();
  let gozados = 0;
  for (const au of ausencias ?? []) {
    if (au?.tipo !== "vacaciones") continue;
    if (au?.estado !== "aprobada") continue;
    const dias = Math.max(0, Number(au?.dias ?? 0) || 0);
    if (dias === 0) continue;
    if (au?.id != null) {
      const k = String(au.id);
      if (vistos.has(k)) continue; // misma ausencia: no se descuenta dos veces
      vistos.add(k);
    }
    gozados += dias;
  }

  return {
    anios_completos: anios,
    dias_ganados: ganados,
    dias_gozados: gozados,
    saldo: ganados - gozados,
  };
}
