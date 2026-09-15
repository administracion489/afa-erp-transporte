// lib/meta-tokens.ts — SOLO SERVIDOR.
//
// Guarda y recupera los **business integration system user access tokens** que Meta
// devuelve cuando una empresa completa el Embedded Signup. Cada token permite
// mandar mensajes en nombre de esa empresa y leer sus conversaciones: es una
// credencial de primer orden, así que nunca se guarda en claro ni viaja al
// navegador.
//
// POR QUÉ ESTO EXISTE AHORA
// Hasta hoy todo el WhatsApp del ERP colgaba de un único META_WA_TOKEN: el system
// user de AFA, que cubre los números de AFA y nada más. Eso alcanza mientras el
// ERP sea de una sola empresa. Al VENDERLO, cada cliente que complete el Embedded
// Signup devuelve su propio token, y hay que guardarlo por número. De ahí la tabla
// `whatsapp_tokens` (supabase/whatsapp-coexistencia.sql) y este módulo.
//
// El fallback a META_WA_TOKEN se mantiene siempre: si un número no tiene token
// propio (los de AFA hoy), se usa el de siempre y nada deja de funcionar.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ALGORITMO = "aes-256-gcm";
/** Prefijo de versión del formato, para poder rotar el cifrado sin adivinar. */
const VERSION = "v1";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Clave de 32 bytes derivada de TOKEN_ENCRYPTION_KEY.
 *
 * Se acepta cualquier cadena y no solo 64 hex: si el valor son 64 caracteres hex
 * se usan esos bytes tal cual; si no, se le aplica SHA-256. Así una frase larga
 * puesta a mano en Vercel funciona igual, en vez de fallar con un "key length"
 * que nadie sabe interpretar. Lo que NO se hace es inventar una clave por
 * defecto: sin variable configurada no se cifra ni se guarda nada.
 */
function claveMaestra(): Buffer | null {
  const bruto = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!bruto) return null;
  if (/^[0-9a-fA-F]{64}$/.test(bruto)) return Buffer.from(bruto, "hex");
  return crypto.createHash("sha256").update(bruto, "utf8").digest();
}

/** ¿Se pueden guardar tokens propios en este entorno? */
export function cifradoDisponible(): boolean {
  return claveMaestra() !== null;
}

// ── Cifrado ────────────────────────────────────────────────────────────────

export function cifrar(textoPlano: string): string {
  const clave = claveMaestra();
  if (!clave) throw new Error("Falta TOKEN_ENCRYPTION_KEY para cifrar el token.");
  const iv = crypto.randomBytes(12); // 96 bits, el tamaño recomendado para GCM
  const cipher = crypto.createCipheriv(ALGORITMO, clave, iv);
  const datos = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), datos.toString("base64")].join(".");
}

export function descifrar(cifrado: string): string | null {
  const clave = claveMaestra();
  if (!clave) return null;
  try {
    const [version, ivB64, tagB64, datosB64] = cifrado.split(".");
    if (version !== VERSION || !ivB64 || !tagB64 || !datosB64) return null;
    const decipher = crypto.createDecipheriv(ALGORITMO, clave, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(datosB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Tag inválido = la clave cambió o el dato se corrompió. Devolver null hace
    // que el llamador caiga a META_WA_TOKEN en vez de romper el envío.
    return null;
  }
}

// ── Persistencia ───────────────────────────────────────────────────────────

export type ResultadoGuardado = { ok: boolean; aviso?: string };

/**
 * Guarda (o reemplaza) el token de un número. Si el entorno no tiene clave de
 * cifrado NO guarda nada y lo dice: prefiero que el ERP siga andando con
 * META_WA_TOKEN y avise, antes que escribir un token en texto plano.
 */
export async function guardarToken(opts: {
  phoneNumberId: string;
  wabaId?: string | null;
  token: string;
  expiresIn?: number | null;
  tenant?: string;
}): Promise<ResultadoGuardado> {
  if (!cifradoDisponible()) {
    return {
      ok: false,
      aviso:
        "No se guardó el token propio del número porque falta TOKEN_ENCRYPTION_KEY en el entorno. " +
        "El número funciona igual con META_WA_TOKEN; la variable hace falta para conectar cuentas de OTRAS empresas.",
    };
  }
  const supabase = db();
  if (!supabase) return { ok: false, aviso: "Sin conexión a Supabase para guardar el token." };

  const fila = {
    phone_number_id: String(opts.phoneNumberId),
    waba_id: opts.wabaId ? String(opts.wabaId) : null,
    tenant: opts.tenant ?? "afa",
    token_cifrado: cifrar(opts.token),
    expira_en:
      opts.expiresIn && Number.isFinite(opts.expiresIn) && opts.expiresIn > 0
        ? new Date(Date.now() + Number(opts.expiresIn) * 1000).toISOString()
        : null,
    actualizado_en: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("whatsapp_tokens")
    .upsert(fila, { onConflict: "phone_number_id" });

  if (error) {
    return {
      ok: false,
      aviso: `No se pudo guardar el token: ${error.message}. ¿Corriste supabase/whatsapp-coexistencia.sql?`,
    };
  }
  invalidarCacheTokens();
  return { ok: true };
}

// Caché en memoria: el token se lee en cada envío y cambia casi nunca.
// El resultado NEGATIVO también se cachea (ventana corta) para que una campaña de
// 200 mensajes por un número sin token propio no dispare 200 consultas fallidas.
let cache: Map<string, { token: string | null; hasta: number }> = new Map();
const TTL_MS = 5 * 60 * 1000;
const TTL_FALLO_MS = 60 * 1000;

export function invalidarCacheTokens() {
  cache = new Map();
}

/** Token propio de un número, ya descifrado. undefined si no tiene o no se pudo leer. */
export async function tokenPropio(phoneNumberId: string | undefined): Promise<string | undefined> {
  if (!phoneNumberId) return undefined;

  const enCache = cache.get(phoneNumberId);
  if (enCache && Date.now() < enCache.hasta) return enCache.token ?? undefined;

  const supabase = db();
  if (!supabase) return undefined;

  const { data, error } = await supabase
    .from("whatsapp_tokens")
    .select("token_cifrado")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();

  // Tabla inexistente (migración sin correr) o sin fila: se degrada a META_WA_TOKEN.
  if (error || !data?.token_cifrado) {
    cache.set(phoneNumberId, { token: null, hasta: Date.now() + TTL_FALLO_MS });
    return undefined;
  }

  const token = descifrar(data.token_cifrado);
  cache.set(phoneNumberId, {
    token,
    hasta: Date.now() + (token ? TTL_MS : TTL_FALLO_MS),
  });
  return token ?? undefined;
}

/**
 * Token con el que hablarle a Meta por un número: el propio si existe, si no el
 * system user de AFA. Es el único punto que deben usar los envíos.
 */
export async function tokenParaNumero(phoneNumberId: string | undefined): Promise<string | undefined> {
  return (await tokenPropio(phoneNumberId)) ?? process.env.META_WA_TOKEN;
}

/** Borra el token de un número (al desconectarlo o si Meta lo revocó). */
export async function borrarToken(phoneNumberId: string): Promise<void> {
  const supabase = db();
  if (!supabase) return;
  await supabase.from("whatsapp_tokens").delete().eq("phone_number_id", phoneNumberId);
  invalidarCacheTokens();
}
