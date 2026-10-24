// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/cotizacion-corregida-datos.ts — Lo que lee de la base el juicio de una cotización de
// traslado CORREGIDA (lib/traslados/cotizacion-corregida.ts): la huella que dejó la IA al crearla y la
// última actividad de una persona en la fila. SOLO SERVIDOR (el cliente de Supabase llega por
// parámetro; no se crea ninguno al importarse).
//
// LAS REGLAS:
//  · LA HUELLA es la de la acción `cotizacion_traslado` de la bandeja (`payload.huella`, que solo
//    escribe el servidor al crearla: lib/traslados/cotizar-ia-datos.ts), contra `canonImprimible` de la
//    fila de AHORA leída con `leerCotizacionTraslado` (la misma lectura con que se sacó). Sin acción,
//    o sin poder leerla, la fila cuenta como corregida: no se puede comprobar.
//  · `editada_at` (supabase/cotizaciones-10-actividad-ejecutivo.sql) se lee APARTE de la fila de la
//    cotización (no entra a `leerCotizacionTraslado` ni a la huella) y solo cuando la fila está
//    corregida y la pausa encendida. Si el error NOMBRA la columna (`faltaColumna`), o la lectura falla
//    por otra causa, es `undefined` («no se sabe»): el juicio espera. Una lectura que contestó trae la
//    clave (PostgREST siempre la devuelve); si no la trae, cuenta como null.
//  · NUNCA LANZA: lo que no se pudo leer cae del lado de esperar.
// ──────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { faltaColumna } from "../columna-faltante";
import { canonImprimible, type FilaCotizacionLeida } from "./cotizacion-traslado";
import { horasDePausa, juzgarCotizacionCorregida, type JuicioCorreccion } from "./cotizacion-corregida";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** Las horas de la pausa del agente y la reactivación del chat (lib/crm-ia.ts las calcula una vez por turno). */
export type PausaEjecutivo = { horas: number; reactivadaAt: string | null | undefined };

/** El sha256 (hex) de lo que imprime la fila (`canonImprimible`): la huella que queda en la acción al crearla. */
export function huellaImprimible(fila: FilaCotizacionLeida): string {
  return createHash("sha256").update(canonImprimible(fila)).digest("hex");
}

/**
 * ¿La fila ya no es la que escribió la IA? La huella guardada en la acción al CREARLA contra la de la
 * fila de ahora. Una acción sin huella (de antes de este cambio, o cuya fila no se pudo releer al
 * crearla) tampoco se puede comprobar: cuenta como editada. PURA salvo el hash.
 */
export function filaEditada(payload: Record<string, unknown> | null | undefined, fila: FilaCotizacionLeida): boolean {
  const guardada = payload && typeof payload === "object" ? (payload as { huella?: unknown }).huella : undefined;
  if (typeof guardada !== "string" || !/^[0-9a-f]{64}$/.test(guardada)) return true;
  return guardada !== huellaImprimible(fila);
}

/**
 * `cotizaciones.editada_at`: el texto ISO, null («ninguna persona la tocó desde que existe la
 * columna») o undefined (la columna no existe o la lectura falló: no se sabe). Nunca lanza.
 */
export async function leerEditadaAt(sb: Sb, cotId: number): Promise<string | null | undefined> {
  try {
    const { data, error } = await sb.from("cotizaciones").select("id, editada_at").eq("id", cotId).maybeSingle();
    if (error) {
      if (!faltaColumna(error, "editada_at")) console.error("[cotizacion-corregida] editada_at:", error?.message ?? error);
      return undefined;
    }
    if (!data) return undefined;
    const v = (data as { editada_at?: unknown }).editada_at;
    return typeof v === "string" ? v : v == null ? null : String(v);
  } catch (e) {
    console.error("[cotizacion-corregida] editada_at:", (e as { message?: unknown })?.message ?? e);
    return undefined;
  }
}

/**
 * Los payloads de las acciones `cotizacion_traslado` de una cotización: las de su conversación si hay
 * alguna (es la que la envió), si no todas. null si no se pudieron leer. Nunca lanza.
 */
export async function payloadsDeCotizacion(sb: Sb, cotId: number, convId: string | null | undefined): Promise<(Record<string, unknown> | null)[] | null> {
  try {
    const { data, error } = await sb.from("crm_acciones_ia").select("id, conversacion_id, payload")
      .eq("tipo", "cotizacion_traslado").eq("resultado_id", cotId).limit(20);
    if (error) return null;
    const filas = (data ?? []) as { conversacion_id: string | null; payload: Record<string, unknown> | null }[];
    const deLaConv = convId ? filas.filter((a) => a.conversacion_id === convId) : [];
    return (deLaConv.length ? deLaConv : filas).map((a) => a.payload ?? null);
  } catch { return null; }
}

/**
 * El juicio de una cotización tal como está ahora: ¿la corrigió alguien y, si sí, ya pasó la pausa?
 * `payloads`: las acciones ya leídas (al reusar se tiene la propia); si no vienen, se leen. Con
 * `pausa` ausente, las horas por defecto y sin reactivación. Nunca lanza.
 */
export async function correccionDeCotizacion(
  sb: Sb, fila: FilaCotizacionLeida,
  x: { convId?: string | null; pausa?: PausaEjecutivo | null; ahoraMs: number; payloads?: (Record<string, unknown> | null)[] | null },
): Promise<JuicioCorreccion> {
  const horas = horasDePausa(x.pausa?.horas);
  const reactivadaAt = x.pausa?.reactivadaAt ?? null;
  let editada = true;
  try {
    const payloads = x.payloads ?? (await payloadsDeCotizacion(sb, fila.id, x.convId ?? fila.crm_conversacion_id ?? null));
    editada = !payloads || !payloads.some((p) => !filaEditada(p, fila));
  } catch { editada = true; }
  if (!editada) return juzgarCotizacionCorregida({ editada: false, editadaAt: null, horasPausa: horas, reactivadaAt, ahoraMs: x.ahoraMs });
  const editadaAt = horas > 0 ? await leerEditadaAt(sb, fila.id) : undefined;
  return juzgarCotizacionCorregida({ editada: true, editadaAt, horasPausa: horas, reactivadaAt, ahoraMs: x.ahoraMs });
}
