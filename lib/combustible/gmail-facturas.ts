// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/gmail-facturas.ts — SOLO SERVIDOR. La conexión del CORREO DE FACTURAS.
//
// Es un buzón aparte del Gmail del CRM (ver lib/combustible/correo-conexion.ts): se conecta
// desde /combustible → Facturas con el MISMO cliente OAuth y el MISMO callback que el CRM
// (`/api/crm/gmail/callback`, el único redirect registrado en Google Cloud), y el `state`
// firmado dice a cuál de los dos va.
//
// DÓNDE SE GUARDA, y por qué CIFRADO: en `crm_config` (clave/valor), que después de
// seguridad-01-rls.sql la lee cualquier usuario del ERP. Un refresh token de lectura del buzón de
// administración no puede quedar ahí en texto plano, así que se cifra con `cifrar` de
// lib/meta-tokens.ts (AES-256-GCM, TOKEN_ENCRYPTION_KEY) — el mismo formato de los tokens de
// WhatsApp y de redes: dos formatos para credenciales es cómo el día de la rotación uno no puede
// leer lo del otro. Sin la clave NO se guarda nada, y la pantalla lo dice ANTES de mandar a
// Google, no después del consentimiento.
//
// DESCONECTAR NO REVOCA EN GOOGLE, a propósito: si el correo de facturas y el del CRM son la
// misma cuenta, revocar el permiso de este cliente OAuth le cortaría también el acceso al CRM.
// Se borra la credencial del ERP; quitar el permiso en la cuenta de Google es un paso aparte.
// ──────────────────────────────────────────────────────────────────────────────

import { canjearCode, refrescarToken, perfilGmail, crmGmailConectado, getAccessToken, googleOAuthConfigurado } from "@/lib/crm-gmail";
import { cifrar, descifrar, cifradoDisponible } from "@/lib/meta-tokens";
import { elegirConexion, type EstadoConexion } from "@/lib/combustible/correo-conexion";

export const CLAVE_TOKEN = "gmail_facturas_refresh_token";
export const CLAVE_EMAIL = "gmail_facturas_email";
export const CLAVE_DESDE = "gmail_facturas_conectado_en";

async function leerClaves(sb: any): Promise<Map<string, string>> {
  const { data, error } = await sb.from("crm_config").select("clave, valor").in("clave", [CLAVE_TOKEN, CLAVE_EMAIL, CLAVE_DESDE]);
  if (error) throw new Error(`crm_config: ${error.message}`);
  return new Map(((data as any[]) ?? []).map((r) => [String(r.clave), String(r.valor ?? "")]));
}

/** Lo que la pantalla necesita saber ANTES de mandar a Google. */
export function requisitosConexion(): { google: boolean; cifrado: boolean } {
  return { google: googleOAuthConfigurado(), cifrado: cifradoDisponible() };
}

/** Canjea el code del callback y guarda la conexión cifrada. Devuelve el correo conectado. */
export async function guardarConexionFacturas(sb: any, code: string): Promise<{ email: string | null }> {
  if (!cifradoDisponible()) {
    throw new Error("Falta TOKEN_ENCRYPTION_KEY en Vercel: sin ella el ERP no guarda credenciales de correo.");
  }
  const t = await canjearCode(code);
  const email = await perfilGmail(t.access_token).catch(() => null);
  const ahora = new Date().toISOString();
  const { error } = await sb.from("crm_config").upsert([
    { clave: CLAVE_TOKEN, valor: cifrar(t.refresh_token), updated_at: ahora },
    { clave: CLAVE_EMAIL, valor: email ?? "", updated_at: ahora },
    { clave: CLAVE_DESDE, valor: ahora, updated_at: ahora },
  ]);
  if (error) throw new Error(`No se pudo guardar la conexión: ${error.message}`);
  return { email };
}

export async function desconectarCorreoFacturas(sb: any): Promise<void> {
  const { error } = await sb.from("crm_config").delete().in("clave", [CLAVE_TOKEN, CLAVE_EMAIL, CLAVE_DESDE]);
  if (error) throw new Error(error.message);
}

export type ConexionResuelta = EstadoConexion & {
  /** Solo cuando se puede leer. Nunca sale del servidor. */
  token: string | null;
  fuente: "facturas" | "crm" | null;
  conectado_en: string | null;
};

/**
 * Resuelve qué buzón se lee y, si se puede, su access token. La decisión la toma
 * `elegirConexion` (puro); aquí solo se averigua si cada conexión existe y funciona.
 * `conToken: false` evita refrescar el del CRM cuando solo se quiere el estado.
 */
export async function conexionCorreoFacturas(sb: any, opts: { conToken?: boolean } = {}): Promise<ConexionResuelta> {
  const claves = await leerClaves(sb);
  const guardado = claves.get(CLAVE_TOKEN) || "";
  const email = claves.get(CLAVE_EMAIL) || null;
  const conectado_en = claves.get(CLAVE_DESDE) || null;

  let token: string | null = null;
  let error: string | null = null;
  if (guardado) {
    const refresh = descifrar(guardado);
    if (!refresh) {
      error = cifradoDisponible()
        ? "La credencial guardada no se puede descifrar (¿cambió TOKEN_ENCRYPTION_KEY?)."
        : "Falta TOKEN_ENCRYPTION_KEY en Vercel para leer la credencial guardada.";
    } else {
      try { token = await refrescarToken(refresh); }
      catch (e: any) {
        // invalid_grant = Google ya no acepta ese permiso (se quitó en la cuenta, se cambió la
        // contraseña, o caducó). No hay arreglo desde el ERP salvo volver a conectar.
        error = /invalid_grant/i.test(e?.message ?? "")
          ? "Google ya no acepta este permiso (se quitó el acceso o caducó)."
          : `Google respondió: ${e?.message ?? "error"}.`;
      }
    }
  }

  const crmGuardado = guardado ? false : await crmGmailConectado().catch(() => false);
  const estado = elegirConexion({
    facturas: { guardada: !!guardado, utilizable: !!token, email, error },
    crm: { guardada: crmGuardado },
  });

  if (estado.codigo === "facturas") return { ...estado, token, fuente: "facturas", conectado_en };
  if (estado.codigo === "crm") {
    if (opts.conToken === false) return { ...estado, token: null, fuente: "crm", conectado_en: null };
    try {
      const t = await getAccessToken();
      const mail = await perfilGmail(t).catch(() => null);
      return { ...estado, email: mail, token: t, fuente: "crm", conectado_en: null };
    } catch (e: any) {
      return { codigo: "rota", de: "crm", email: null, detalle: `Google respondió: ${e?.message ?? "error"}.`, token: null, fuente: null, conectado_en: null };
    }
  }
  return { ...estado, token: null, fuente: null, conectado_en };
}
