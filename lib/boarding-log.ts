// ──────────────────────────────────────────────────────────────────────────────
// lib/boarding-log.ts — La bitácora de abordaje (`boarding_log`), escrita en UN solo sitio.
//
// HASTA EL 06-10-2026 NO ENTRÓ NINGUNA FILA. Los dos escritores (app/api/conductor y
// app/api/conductor-alerta) tenían la misma función copiada, y las dos mandaban `created_at`, una
// columna que `boarding_log` no tiene: la suya es `"timestamp"`, con `default now()`. En un INSERT
// la columna desconocida la rechaza PostgREST (PGRST204, ver lib/columna-faltante.ts) y supabase-js
// NO LANZA: devuelve `{ error }`. El try/catch de alrededor no atrapaba nada y nadie leía el error,
// así que cada abordaje por QR se perdió en silencio — 0 filas en la tabla contra ~3 400 abordajes
// al mes en `pasajeros_parada`.
//
// LAS TRES REGLAS:
//  · Solo columnas que la tabla tiene (`COLUMNAS_BOARDING_LOG`). La hora la pone la base.
//  · Best-effort: nunca lanza ni bloquea el embarque. El abordaje AUTORITATIVO es
//    `pasajeros_parada` (`esAbordado`, lib/documentos-servicio.ts); esto es la bitácora del método.
//  · El `{ error }` SE LEE y se avisa en el log: un fallo callado es lo que la dejó vacía.
// ──────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

/** Columnas de `boarding_log` en producción (esquema de PostgREST leído el 06-10-2026). */
export const COLUMNAS_BOARDING_LOG = [
  "id", "reserva_id", "parada_id", "pasajero_id", "conductor_id", "metodo", "lat", "lng", "timestamp",
] as const;

/** Los tres caminos que escriben aquí vienen de un escaneo QR en la app del conductor (o el lector). */
export const METODO_QR_CONDUCTOR = "qr_conductor";

export type FilaBoardingLog = {
  pasajero_id: number;
  parada_id: number;
  reserva_id: number | null;
  metodo: string;
};

const idPositivo = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** La fila a insertar, o null si falta el pasajero o el paradero (sin ellos no describe nada). */
export function filaBoardingLog(pasajeroId: unknown, paradaId: unknown, reservaId: unknown): FilaBoardingLog | null {
  const pasajero_id = idPositivo(pasajeroId), parada_id = idPositivo(paradaId);
  if (!pasajero_id || !parada_id) return null;
  return { pasajero_id, parada_id, reserva_id: idPositivo(reservaId), metodo: METODO_QR_CONDUCTOR };
}

/**
 * Registra el abordaje en la bitácora. Devuelve si quedó escrito; jamás lanza.
 * `origen` solo etiqueta el aviso del log (qué ruta lo intentó).
 */
export async function registrarAbordaje(
  cliente: SupabaseClient, pasajeroId: unknown, paradaId: unknown, reservaId: unknown, origen: string,
): Promise<boolean> {
  const fila = filaBoardingLog(pasajeroId, paradaId, reservaId);
  if (!fila) return false;
  try {
    const { error } = await cliente.from("boarding_log").insert(fila);
    if (error) {
      console.warn(`[${origen}] boarding_log no registrado:`, [error.code, error.message].filter(Boolean).join(" · "));
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[${origen}] boarding_log no registrado:`, e?.message);
    return false;
  }
}
