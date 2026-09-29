// lib/conductor-auth.ts
// Sesión del conductor SIN estado en BD: token HMAC firmado en el servidor.
// Gemelo de lib/pasajero-auth.ts — misma construcción, mismo razonamiento.
//
// Antes: el login del APK consultaba `conductores` con la clave ANON, se traía
// `pin_acceso` y comparaba el PIN EN EL NAVEGADOR; la sesión de localStorage guardaba
// el conductor completo (PIN en claro incluido) y el API confiaba en el `cid` que
// llegaba en el body. Como el API corre con service_role (saltea RLS), eso es un IDOR:
// cambiando el `cid` se leían/mutaban datos de otro conductor.
//
// Ahora el login (que YA valida el PIN en el servidor) emite este token, y TODAS las acciones
// (salvo el propio login) derivan la identidad DEL TOKEN, ignorando el `cid` del body; las que
// reciben un servicio o un paradero comprueban además que sea del conductor (ver PERTENENCIA).
// El header `x-afa-key` NO es una credencial: su valor viaja en el bundle JS.
//
// OJO — IDENTIDAD COMPUESTA: el conductor vive en DOS tablas (`conductores` y
// `conductores_tercero`) cuyas secuencias de id SE SOLAPAN. El token lleva el PAR
// (cid, tabla); usar solo el id confundiría a dos personas distintas.
//
// Zero-config: si no se define AFA_CONDUCTOR_SESSION_SECRET, el secreto se deriva del
// SUPABASE_SERVICE_ROLE_KEY (siempre en el servidor, nunca en el bundle).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const SECRET =
  process.env.AFA_CONDUCTOR_SESSION_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días: el conductor no debe re-loguearse a diario

export type TablaConductor = "conductores" | "conductores_tercero";
export type SesionConductor = { cid: number; tabla: TablaConductor };

function firma(payloadB64: string): string {
  return createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}

/** Firma un token ligado a un conductor. Formato: `<payloadB64>.<hmac>`. */
export function firmarTokenConductor(cid: number, tabla: TablaConductor, ttlMs = TTL_MS): string {
  const payloadB64 = Buffer.from(JSON.stringify({ cid, tabla, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payloadB64}.${firma(payloadB64)}`;
}

/** Devuelve {cid, tabla} si el token es válido y no expiró; `null` en cualquier otro caso. */
export function sesionDeToken(token: unknown): SesionConductor | null {
  if (!SECRET || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(firma(payloadB64));
  // Comparación en tiempo constante (timingSafeEqual exige misma longitud).
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { cid, tabla, exp } = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (typeof cid !== "number" || typeof exp !== "number" || Date.now() > exp) return null;
    if (tabla !== "conductores" && tabla !== "conductores_tercero") return null;
    return { cid, tabla };
  } catch {
    return null;
  }
}

/** Token de la petición: `body.token` (lo que ya mandaban las acciones de caja chica y push) o el
 *  header `x-afa-token` (el único camino en un GET, p. ej. /api/conductor-paradas). */
export function sesionDeRequest(req: Request, body?: { token?: unknown } | null): SesionConductor | null {
  return sesionDeToken(body?.token ?? req.headers.get("x-afa-token"));
}

/**
 * TRANSICIÓN del despliegue que empezó a exigir el token en TODA la API del conductor.
 * La APK y las tablets del lector cargan la web y se quedan abiertas el turno entero: con
 * el JavaScript viejo en memoria no mandan token, y sin esto dejarían de enviar el GPS y
 * el SOS de servicios en curso hasta que alguien recargue. Solo para esas dos cosas, solo
 * cuando la petición NO trae ningún token (uno inválido sigue siendo 401) y solo hasta
 * `FIN_TRANSICION`: pasada la fecha esta función devuelve null y no hace nada.
 * BORRAR esta función y sus dos llamadas después de esa fecha.
 */
const FIN_TRANSICION = Date.parse("2026-10-06T23:59:59-05:00");
export function sesionLegada(
  req: Request, body: { token?: unknown } | null | undefined,
  identidad: { conductor_id?: unknown; conductor_tercero_id?: unknown } | null | undefined,
): SesionConductor | null {
  if (Date.now() > FIN_TRANSICION) return null;
  if (body?.token != null || req.headers.get("x-afa-token")) return null;
  const ct = Number(identidad?.conductor_tercero_id);
  if (Number.isFinite(ct) && ct > 0) return { cid: ct, tabla: "conductores_tercero" };
  const c = Number(identidad?.conductor_id);
  if (Number.isFinite(c) && c > 0) return { cid: c, tabla: "conductores" };
  return null;
}

/** Respuesta 401 de sesión inválida. `sesionInvalida` es lo que la app lee para volver a la
 *  pantalla del PIN: un 401 SIN esa marca (el gate de x-afa-key mal configurado) no debe
 *  desloguear, porque re-loguear no lo arregla y el conductor entraría en un bucle. */
export const CUERPO_SESION_INVALIDA = {
  error: "Sesión vencida. Vuelve a iniciar sesión.",
  sesionInvalida: true,
} as const;

// ── PERTENENCIA: ¿este servicio / paradero es DEL conductor del token? ────────
// El token dice QUIÉN es; esto dice sobre QUÉ puede actuar. Sin esta segunda mitad, un token
// válido de cualquier conductor bastaría para marcar paradas, leer manifiestos o cerrar servicios
// ajenos pasando otro `reservaId`. La columna depende de la tabla (identidad compuesta, ver arriba):
// un conductor tercerizado va en `reservas.conductor_tercero_id`, nunca en `conductor_id`.
type ClienteAdmin = SupabaseClient;

export function campoConductor(ses: SesionConductor): "conductor_id" | "conductor_tercero_id" {
  return ses.tabla === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";
}

function idsValidos(ids: unknown[]): number[] {
  return [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

/** Subconjunto de `reservaIds` asignado al conductor del token. */
export async function reservasDelConductor(
  admin: ClienteAdmin, ses: SesionConductor, reservaIds: unknown[],
): Promise<Set<number>> {
  const ids = idsValidos(reservaIds);
  if (ids.length === 0) return new Set();
  const { data } = await admin.from("reservas").select("id")
    .in("id", ids).eq(campoConductor(ses), ses.cid);
  return new Set(((data ?? []) as { id: number }[]).map((r) => Number(r.id)));
}

export async function reservaEsDelConductor(
  admin: ClienteAdmin, ses: SesionConductor, reservaId: unknown,
): Promise<boolean> {
  return (await reservasDelConductor(admin, ses, [reservaId])).size === 1;
}

/** Paraderos de `paradaIds` que cuelgan de un servicio del conductor → Map(parada → reserva).
 *  Los ajenos simplemente no aparecen: quien llama decide si eso es 403 o un filtro. */
export async function paradasDelConductor(
  admin: ClienteAdmin, ses: SesionConductor, paradaIds: unknown[],
): Promise<Map<number, number>> {
  const ids = idsValidos(paradaIds);
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const { data } = await admin.from("paradas").select("id, reserva_id").in("id", ids);
  const filas = (data ?? []) as { id: number; reserva_id: number | null }[];
  const mias = await reservasDelConductor(admin, ses, filas.map((p) => p.reserva_id));
  for (const p of filas) {
    const rid = Number(p.reserva_id);
    if (mias.has(rid)) out.set(Number(p.id), rid);
  }
  return out;
}

// ── Rate limit en memoria (best-effort) para el login ────────────────────────
// No es distribuido: en serverless cada instancia tiene el suyo y se resetea en cold
// start. Aun así añade fricción real al brute-force de PINs de 4 dígitos sin infra extra.
const intentos = new Map<string, { n: number; reset: number }>();
const VENTANA_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 10;

export function loginBloqueado(clave: string): boolean {
  const e = intentos.get(clave);
  if (!e) return false;
  if (Date.now() > e.reset) { intentos.delete(clave); return false; }
  return e.n >= MAX_INTENTOS;
}

export function registrarIntentoFallido(clave: string): void {
  const ahora = Date.now();
  const e = intentos.get(clave);
  if (!e || ahora > e.reset) intentos.set(clave, { n: 1, reset: ahora + VENTANA_MS });
  else e.n++;
}

export function limpiarIntentos(clave: string): void {
  intentos.delete(clave);
}
