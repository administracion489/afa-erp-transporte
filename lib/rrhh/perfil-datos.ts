// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/perfil-datos.ts — LECTOR (service-role) del perfil: ficha derivada (conductor/
// administrativo), días de vacaciones del régimen vigente, y el saldo de vacaciones.
//
// Dos cosas que NO se inventan:
//  · La FECHA DE INGRESO. rrhh-01 no la declara y no está verificada en conductores /
//    personal_administrativo; por eso se PROBA entre varios nombres candidatos de la ficha y
//    se DECLARA cuál se usó (`fuente`). Sin ninguna → saldo null con su motivo, nunca un 0 que
//    se leería como "sin derecho a vacaciones".
//  · El SUELDO. La ficha derivada se publica por LISTA BLANCA de campos no sensibles: el perfil
//    jamás devuelve sueldo/honorario (su fuente única es conductores/personal_administrativo y
//    este endpoint es de autoservicio).
//
// Los días de vacaciones salen del régimen VIGENTE (config_laboral → config_laboral_regimen,
// la fila cuya vigencia ya empezó, más reciente), la misma fuente que v_conductor_planilla.
// ──────────────────────────────────────────────────────────────────────────────

import { fechaLima, limaAUtcMs } from "@/lib/alertas-horario";
import { faltaColumna, tablaFaltante } from "@/lib/columna-faltante";
import { saldoVacaciones } from "./vacaciones";
import { estadoConsentimientos } from "./consentimiento";
import type { Ausencia, SaldoVacaciones } from "./tipos";

type SB = { from: (t: string) => any };

export type ClaseFicha = "conductor" | "administrativo" | null;

// Campos de la ficha que SÍ se publican en el perfil (lista blanca, sin sueldo/honorario/PIN).
const CAMPOS_CONDUCTOR = [
  "id", "nombre", "dni", "telefono", "licencia", "categoria_licencia",
  "vencimiento_licencia", "sctr_salud_venc", "examen_medico_venc", "estado",
] as const;
const CAMPOS_ADMIN = [
  "id", "nombre", "dni", "telefono", "cargo", "departamento", "centro_costo", "estado",
] as const;

// Nombres candidatos de la fecha de ingreso (no verificada en el esquema): el primero presente gana.
const CAMPOS_INGRESO = ["fecha_ingreso", "fecha_contratacion", "fecha_alta", "fecha_inicio", "created_at"] as const;

function soloCampos(row: Record<string, unknown>, campos: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of campos) if (k in row && row[k] !== undefined) o[k] = row[k];
  return o;
}

/** La ficha laboral del usuario: conductor (por conductores.usuario_id) o administrativo
 *  (por personal_administrativo.usuario_id). `sinMigracion` si falta el puente de rrhh-01. */
export async function fichaDeUsuario(
  sb: SB,
  usuarioId: string,
): Promise<{ clase: ClaseFicha; ficha: Record<string, unknown> | null; ingreso: { fecha: string | null; fuente: string | null }; sinMigracion: boolean }> {
  // Conductor. `conductores.usuario_id` lo agrega rrhh-01: si falta, falta la migración.
  const cRes = await sb.from("conductores").select("*").eq("usuario_id", usuarioId).maybeSingle();
  if (cRes.error) {
    if (tablaFaltante(cRes.error, "conductores") || faltaColumna(cRes.error, "usuario_id")) {
      return { clase: null, ficha: null, ingreso: { fecha: null, fuente: null }, sinMigracion: true };
    }
    throw cRes.error;
  }
  if (cRes.data) {
    return { clase: "conductor", ficha: soloCampos(cRes.data, CAMPOS_CONDUCTOR), ingreso: ingresoDe(cRes.data), sinMigracion: false };
  }

  // Administrativo (personal_administrativo.usuario_id viene de comisiones-03).
  const aRes = await sb.from("personal_administrativo").select("*").eq("usuario_id", usuarioId).maybeSingle();
  if (aRes.error) {
    if (faltaColumna(aRes.error, "usuario_id") || tablaFaltante(aRes.error, "personal_administrativo")) {
      return { clase: null, ficha: null, ingreso: { fecha: null, fuente: null }, sinMigracion: false };
    }
    throw aRes.error;
  }
  if (aRes.data) {
    return { clase: "administrativo", ficha: soloCampos(aRes.data, CAMPOS_ADMIN), ingreso: ingresoDe(aRes.data), sinMigracion: false };
  }

  return { clase: null, ficha: null, ingreso: { fecha: null, fuente: null }, sinMigracion: false };
}

/** La fecha de ingreso de una ficha: el primer campo candidato presente y con forma de fecha. */
function ingresoDe(row: Record<string, unknown>): { fecha: string | null; fuente: string | null } {
  for (const campo of CAMPOS_INGRESO) {
    const v = row[campo];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return { fecha: v.slice(0, 10), fuente: campo };
  }
  return { fecha: null, fuente: null };
}

/** Días de vacaciones del régimen vigente de la empresa, o null si no se puede resolver. */
export async function vacacionesDiasVigente(sb: SB): Promise<number | null> {
  const { data: cfg } = await sb.from("config_laboral").select("regimen").eq("id", 1).maybeSingle();
  const regimen = cfg?.regimen;
  if (!regimen) return null;
  const hoy = fechaLima(Date.now());
  const { data } = await sb
    .from("config_laboral_regimen")
    .select("vacaciones_dias,vigente_desde")
    .eq("regimen", regimen)
    .lte("vigente_desde", hoy)
    .order("vigente_desde", { ascending: false })
    .limit(1);
  const v = (data ?? [])[0]?.vacaciones_dias;
  return v != null ? Number(v) : null;
}

/** Días inclusivos entre dos fechas ISO (ambas en 00:00 Lima). 0 si cualquiera es inválida. */
function diasInclusive(desde: unknown, hasta: unknown): number {
  const a = limaAUtcMs(String(desde ?? ""), "00:00");
  const b = limaAUtcMs(String(hasta ?? ""), "00:00");
  if (a == null || b == null) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}

/** Las ausencias tipo 'vacaciones' APROBADAS del usuario, con los `dias` derivados del rango
 *  (día calendario inclusive — límite declarado: no descuenta festivos/domingos). */
export async function ausenciasVacaciones(sb: SB, usuarioId: string): Promise<{ ausencias: Ausencia[]; sinMigracion: boolean }> {
  const { data, error } = await sb
    .from("rrhh_ausencia")
    .select("*")
    .eq("usuario_id", usuarioId)
    .eq("tipo", "vacaciones")
    .eq("estado", "aprobada");
  if (error) {
    if (tablaFaltante(error, "rrhh_ausencia")) return { ausencias: [], sinMigracion: true };
    throw error;
  }
  const ausencias: Ausencia[] = (data ?? []).map((a: Record<string, unknown>) => ({
    id: (a.id as number) ?? null,
    tipo: "vacaciones",
    estado: "aprobada",
    dias: diasInclusive(a.desde, a.hasta),
  }));
  return { ausencias, sinMigracion: false };
}

export type SaldoResuelto =
  | { saldo: SaldoVacaciones; fuente_fecha_ingreso: string; fecha_ingreso: string }
  | { saldo: null; motivo: string };

/** Compone el saldo de vacaciones, o declara por qué no se pudo (sin fecha de ingreso, sin
 *  régimen). Nunca devuelve un 0 que se leería como "sin derecho". */
export async function saldoDeUsuario(
  sb: SB,
  usuarioId: string,
  ingreso: { fecha: string | null; fuente: string | null },
): Promise<SaldoResuelto> {
  if (!ingreso.fecha || !ingreso.fuente) {
    return { saldo: null, motivo: "No se pudo determinar la fecha de ingreso en la ficha del empleado." };
  }
  const vacDias = await vacacionesDiasVigente(sb);
  if (vacDias == null) {
    return { saldo: null, motivo: "No hay un régimen laboral vigente configurado (config_laboral / config_laboral_regimen)." };
  }
  const { ausencias, sinMigracion } = await ausenciasVacaciones(sb, usuarioId);
  if (sinMigracion) return { saldo: null, motivo: "Falta correr supabase/rrhh-01-perfil-asistencia.sql." };
  const saldo = saldoVacaciones({ vacaciones_dias: vacDias }, ingreso.fecha, ausencias, fechaLima(Date.now()));
  return { saldo, fuente_fecha_ingreso: ingreso.fuente, fecha_ingreso: ingreso.fecha };
}

/** Re-exporta por comodidad del route. */
export { estadoConsentimientos };
