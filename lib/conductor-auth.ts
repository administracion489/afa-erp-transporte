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
// Ahora el login (que YA valida el PIN en el servidor) emite este token, y las acciones
// sensibles derivan la identidad DEL TOKEN, ignorando el `cid` del body.
//
// OJO — IDENTIDAD COMPUESTA: el conductor vive en DOS tablas (`conductores` y
// `conductores_tercero`) cuyas secuencias de id SE SOLAPAN. El token lleva el PAR
// (cid, tabla); usar solo el id confundiría a dos personas distintas.
//
// Zero-config: si no se define AFA_CONDUCTOR_SESSION_SECRET, el secreto se deriva del
// SUPABASE_SERVICE_ROLE_KEY (siempre en el servidor, nunca en el bundle).
import { createHmac, timingSafeEqual } from "node:crypto";

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
