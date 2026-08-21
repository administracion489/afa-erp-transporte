// lib/portal-auth.ts — SOLO SERVIDOR.
//
// Verificación del token de sesión del PORTAL DEL CLIENTE. Estaba dentro de
// app/api/cliente/route.ts y ahora vive aquí porque hace falta en más de un endpoint:
// /api/cliente/gps servía la traza GPS completa de cualquier servicio SIN pedir nada, así
// que bastaba con conocer (o adivinar) un reservaId para seguir a un bus ajeno.
//
// EL SECRETO Y EL FORMATO NO PUEDEN CAMBIAR: el salt "portal-cliente-v1:" y el layout del
// payload se copian TAL CUAL del original. Tocarlos invalidaría de golpe la sesión de todos
// los clientes conectados.

import { createHash, createHmac, timingSafeEqual } from "crypto";

const SECRETO = createHash("sha256")
  .update("portal-cliente-v1:" + (process.env.SUPABASE_SERVICE_ROLE_KEY || ""))
  .digest();

export type SesionPortal = { cid: number; uid: number };

/** Devuelve { cid, uid } si el token es válido y no expiró; null en cualquier otro caso. */
export function verificarTokenPortal(token: unknown): SesionPortal | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, firma] = token.split(".");
  try {
    const esperada = createHmac("sha256", SECRETO).update(payload).digest();
    const recibida = Buffer.from(firma, "base64url");
    // Comparación en tiempo constante (timingSafeEqual exige misma longitud).
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
    const { cid, uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof cid !== "number" || cid <= 0 || typeof exp !== "number" || Date.now() > exp) return null;
    return { cid, uid: Number(uid) || 0 };
  } catch { return null; }
}

/** ¿Esa reserva es de ese cliente? Cierra el IDOR: el cid sale del token, no del body. */
export async function reservaEsDelCliente(admin: any, reservaId: number, cid: number): Promise<boolean> {
  if (!Number.isFinite(reservaId) || reservaId <= 0) return false;
  const { data } = await admin.from("reservas").select("id,cliente_id").eq("id", reservaId).maybeSingle();
  return !!data && Number(data.cliente_id) === cid;
}

/**
 * ¿Esos vehículos aparecen en alguna reserva del cliente? Para el mapa "En vivo", que pide
 * por vehículo y no por reserva. Devuelve solo los ids que el cliente puede ver — filtrar es
 * mejor que rechazar: si cuela un id ajeno, se ignora y el resto sigue funcionando.
 */
export async function filtrarVehiculosDelCliente(
  admin: any, cid: number, vehiculoIds: number[], vehiculoTerceroIds: number[],
): Promise<{ vehiculoIds: number[]; vehiculoTerceroIds: number[] }> {
  const propios = (vehiculoIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  const terceros = (vehiculoTerceroIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (!propios.length && !terceros.length) return { vehiculoIds: [], vehiculoTerceroIds: [] };

  const [rp, rt] = await Promise.all([
    propios.length
      ? admin.from("reservas").select("vehiculo_id").eq("cliente_id", cid).in("vehiculo_id", propios)
      : Promise.resolve({ data: [] }),
    terceros.length
      ? admin.from("reservas").select("vehiculo_tercero_id").eq("cliente_id", cid).in("vehiculo_tercero_id", terceros)
      : Promise.resolve({ data: [] }),
  ]);
  const okP = new Set((rp?.data ?? []).map((r: any) => Number(r.vehiculo_id)));
  const okT = new Set((rt?.data ?? []).map((r: any) => Number(r.vehiculo_tercero_id)));
  return {
    vehiculoIds: propios.filter(id => okP.has(id)),
    vehiculoTerceroIds: terceros.filter(id => okT.has(id)),
  };
}
