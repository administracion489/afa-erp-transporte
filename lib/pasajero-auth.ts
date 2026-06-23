// lib/pasajero-auth.ts
// Sesión del pasajero SIN estado en BD: token HMAC firmado en el servidor.
//
// El pasajero se autentica por DNI+PIN (no usa sesión Supabase). Antes, tras el
// login el cliente guardaba su `id` y lo reenviaba como `pid` en cada acción; el
// API confiaba ciegamente en ese `pid` (corre con service_role, saltea RLS) → IDOR:
// cualquiera enumeraba ids ajenos y leía/mutaba datos de otros pasajeros.
//
// Ahora el login emite este token y CADA acción deriva el pasajero_id DEL TOKEN
// (ver `pidDeToken`), ignorando el `pid` del body. El secreto NUNCA llega al cliente.
//
// Zero-config: si no se define AFA_PASAJERO_SESSION_SECRET, derivamos el secreto del
// SUPABASE_SERVICE_ROLE_KEY (siempre presente en el servidor, nunca en el bundle).
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET =
  process.env.AFA_PASAJERO_SESSION_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 h (igual que la sesión vieja de localStorage)

function firma(payloadB64: string): string {
  return createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}

/** Firma un token de sesión ligado a un pasajero. Formato: `<payloadB64>.<hmac>`. */
export function firmarTokenPasajero(pid: number, ttlMs = TTL_MS): string {
  const payloadB64 = Buffer.from(JSON.stringify({ pid, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payloadB64}.${firma(payloadB64)}`;
}

/** Devuelve el pasajero_id si el token es válido y no expiró; `null` en cualquier otro caso. */
export function pidDeToken(token: unknown): number | null {
  if (!SECRET || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(firma(payloadB64));
  // Comparación en tiempo constante (timingSafeEqual exige misma longitud).
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { pid, exp } = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (typeof pid !== "number" || typeof exp !== "number" || Date.now() > exp) return null;
    return pid;
  } catch {
    return null;
  }
}

// ── Rate limit en memoria (best-effort) para el login ────────────────────────
// No es distribuido: en serverless cada instancia tiene el suyo y se resetea en
// cold start. Aun así añade fricción real al brute-force/enumeración sin requerir
// infra extra. Para protección robusta en producción, mover a Upstash/Redis.
const intentos = new Map<string, { n: number; reset: number }>();
const VENTANA_MS = 10 * 60 * 1000; // 10 min
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
