// Gmail API — OAuth2 + envío + recepción
// Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Token de refresh se guarda en tabla crm_config (clave: gmail_refresh_token)

import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

const supabaseAdmin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// ── OAuth helpers ─────────────────────────────────────────────────────────

// ── `state` firmado del flujo OAuth ────────────────────────────────────────
// Antes el flujo no llevaba `state`: cualquiera podía abrir /api/crm/gmail/auth, o mandarle
// a un admin un enlace al callback con SU propio `code`, y el ERP quedaba leyendo y enviando
// correo desde la cuenta del atacante (CSRF de login OAuth). Ahora el inicio exige sesión del
// ERP y el callback solo acepta un `state` firmado por el servidor y con 10 min de vida.
const SECRETO_STATE = createHash("sha256")
  .update("crm-gmail-state-v1:" + (process.env.GMAIL_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ""))
  .digest();
const TTL_STATE_MS = 10 * 60 * 1000;

// ── Para QUÉ buzón es la conexión ─────────────────────────────────────────
// El ERP conecta DOS buzones con el MISMO cliente OAuth y el MISMO callback (el único
// `GOOGLE_REDIRECT_URI` registrado en Google Cloud): el del CRM, que lee y envía, y el de las
// facturas de proveedor (/combustible → Facturas), que solo lee. El destino viaja DENTRO del
// `state` firmado: como parámetro suelto, cualquiera podría convertir una conexión del CRM en la
// del correo de facturas —o al revés— cambiando la URL.
export type DestinoGmail = "crm" | "facturas";

export function firmarStateGmail(usuarioId: string, destino: DestinoGmail = "crm"): string {
  const payload = Buffer.from(JSON.stringify({
    uid: usuarioId, exp: Date.now() + TTL_STATE_MS, n: randomBytes(8).toString("hex"), d: destino,
  })).toString("base64url");
  const firma = createHmac("sha256", SECRETO_STATE).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

/** Quién inició el flujo y para qué buzón, si el `state` es auténtico y vigente; null si no.
 *  Un `state` sin destino (firmado antes de que existiera) es del CRM: era el único que había. */
export function leerStateGmail(state: unknown): { uid: string; destino: DestinoGmail } | null {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [payload, firma] = state.split(".");
  try {
    const esperada = createHmac("sha256", SECRETO_STATE).update(payload).digest();
    const recibida = Buffer.from(firma, "base64url");
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
    const { uid, exp, d } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof uid !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    return { uid, destino: d === "facturas" ? "facturas" : "crm" };
  } catch { return null; }
}

/** Devuelve el usuario que inició el flujo si el `state` es auténtico y vigente; null si no. */
export function verificarStateGmail(state: unknown): string | null {
  return leerStateGmail(state)?.uid ?? null;
}

/** ¿Están las tres variables del cliente OAuth? Sin ellas Google contesta un error que no las nombra. */
export function googleOAuthConfigurado(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

export const SCOPES_CRM = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";
/** El correo de facturas solo se LEE: ni envía, ni borra, ni marca. El permiso mínimo. */
export const SCOPE_SOLO_LECTURA = "https://www.googleapis.com/auth/gmail.readonly";

export function getAuthUrl(state: string, opts: { scope?: string; elegirCuenta?: boolean } = {}): string {
  const params = new URLSearchParams({
    state,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: opts.scope ?? SCOPES_CRM,
    access_type: "offline",
    // Con varias cuentas de Google abiertas en el navegador, Google puede elegir sola la que
    // tenga a mano —la del CRM—, y el correo de facturas acabaría conectado al buzón equivocado.
    prompt: opts.elegirCuenta ? "select_account consent" : "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Canjea el `code` del callback. Sin `refresh_token` no hay conexión duradera: se dice. */
export async function canjearCode(code: string): Promise<{ refresh_token: string; access_token: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error(data.error_description ?? data.error ?? "OAuth error");
  return { refresh_token: data.refresh_token, access_token: data.access_token };
}

export async function exchangeCode(code: string): Promise<void> {
  const data = await canjearCode(code);
  await supabaseAdmin()
    .from("crm_config")
    .upsert({ clave: "gmail_refresh_token", valor: data.refresh_token, updated_at: new Date().toISOString() });
}

/** refresh_token → access_token de una hora. */
export async function refrescarToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const token = await res.json();
  if (!res.ok) throw new Error(token.error_description ?? token.error ?? "Error renovando token Gmail");
  return token.access_token;
}

/** La dirección del buzón al que pertenece un token (para decir QUÉ correo se está leyendo). */
export async function perfilGmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await res.json().catch(() => ({}));
  return res.ok && typeof j.emailAddress === "string" ? j.emailAddress : null;
}

/** ¿Hay un Gmail conectado al CRM? (sin gastar una llamada a Google). */
export async function crmGmailConectado(): Promise<boolean> {
  const { data } = await supabaseAdmin().from("crm_config").select("valor").eq("clave", "gmail_refresh_token").maybeSingle();
  return !!data?.valor;
}

export async function getAccessToken(): Promise<string> {
  const db = supabaseAdmin();
  const { data } = await db.from("crm_config").select("valor").eq("clave", "gmail_refresh_token").maybeSingle();
  if (!data?.valor) throw new Error("Gmail no autorizado — conéctalo desde /crm (botón «Conectar Gmail»)");
  return refrescarToken(data.valor);
}

// ── Enviar email ──────────────────────────────────────────────────────────

function buildRaw(to: string, subject: string, body: string, threadId?: string): string {
  const msg = [
    `From: transporte@afatoursperu.com`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(body).toString("base64"),
  ].join("\r\n");
  return Buffer.from(msg).toString("base64url");
}

export async function enviarEmail(
  to: string,
  subject: string,
  htmlBody: string,
  gmailThreadId?: string
): Promise<{ messageId: string; threadId: string }> {
  const token = await getAccessToken();
  const raw = buildRaw(to, subject, htmlBody);

  const payload: any = { raw };
  if (gmailThreadId) payload.threadId = gmailThreadId;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error enviando email");
  return { messageId: data.id, threadId: data.threadId };
}

// ── Sincronizar inbox (polling) ───────────────────────────────────────────

type GmailMsg = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  date: string;
};

function decodeBase64(s: string): string {
  try { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"); }
  catch { return ""; }
}

function extractBody(payload: any): string {
  if (payload.body?.data) return decodeBase64(payload.body.data);
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/html" || part.mimeType === "text/plain") {
      if (part.body?.data) return decodeBase64(part.body.data);
    }
    if (part.parts) {
      const inner = extractBody(part);
      if (inner) return inner;
    }
  }
  return "";
}

function headerVal(headers: any[], name: string): string {
  return headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function syncGmailInbox(db = supabaseAdmin()): Promise<number> {
  const token = await getAccessToken();

  // Obtener historyId guardado para sólo traer mensajes nuevos
  const { data: hist } = await db.from("crm_config").select("valor").eq("clave", "gmail_history_id").maybeSingle();
  const historyId = hist?.valor;

  let messageIds: string[] = [];

  if (historyId) {
    const hRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded&labelId=INBOX`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const hData = await hRes.json();
    for (const record of hData.history ?? []) {
      for (const ma of record.messagesAdded ?? []) {
        if (!messageIds.includes(ma.message.id)) messageIds.push(ma.message.id);
      }
    }
    // Guardar nuevo historyId
    if (hData.historyId) {
      await db.from("crm_config").upsert({ clave: "gmail_history_id", valor: String(hData.historyId) });
    }
  } else {
    // Primera vez: últimos 50 mensajes no leídos de INBOX
    const lRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=is:unread&maxResults=50",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const lData = await lRes.json();
    messageIds = (lData.messages ?? []).map((m: any) => m.id);

    // Guardar historyId inicial
    const pRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pData = await pRes.json();
    if (pData.historyId) {
      await db.from("crm_config").upsert({ clave: "gmail_history_id", valor: String(pData.historyId) });
    }
  }

  let saved = 0;

  for (const msgId of messageIds) {
    // Dedup
    const { data: existing } = await db
      .from("crm_mensajes")
      .select("id")
      .eq("gmail_message_id", msgId)
      .maybeSingle();
    if (existing) continue;

    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const msg = await mRes.json();

    const headers = msg.payload?.headers ?? [];
    const from = headerVal(headers, "from");
    const subject = headerVal(headers, "subject") || "(Sin asunto)";
    const threadId = msg.threadId;
    const body = extractBody(msg.payload);

    // Extraer email del remitente
    const emailMatch = from.match(/<(.+?)>/) ?? from.match(/(\S+@\S+)/);
    const fromEmail = emailMatch?.[1] ?? from;
    const fromName = from.replace(/<.+>/, "").trim() || fromEmail;

    // Ignorar emails enviados por nosotros mismos
    if (fromEmail.toLowerCase().includes("afatoursperu.com")) continue;

    // Buscar o crear contacto
    let { data: contacto } = await db
      .from("crm_contactos")
      .select("id")
      .eq("gmail_email", fromEmail)
      .maybeSingle();

    if (!contacto) {
      const { data: nc } = await db
        .from("crm_contactos")
        .insert({ nombre: fromName, gmail_email: fromEmail, canal_origen: "gmail" })
        .select("id")
        .single();
      contacto = nc;
    }

    // Buscar conversación existente por gmail_thread_id
    let { data: conv } = await db
      .from("crm_conversaciones")
      .select("id, no_leidos")
      .eq("gmail_thread_id", threadId)
      .maybeSingle();

    if (!conv) {
      const { data: nc } = await db
        .from("crm_conversaciones")
        .insert({ contacto_id: contacto!.id, canal: "gmail", estado: "abierta", asunto: subject, gmail_thread_id: threadId })
        .select("id, no_leidos")
        .single();
      conv = nc;
    }

    await db.from("crm_mensajes").insert({
      conversacion_id: conv!.id,
      direccion: "entrante",
      tipo: "texto",
      contenido: body || "(sin contenido)",
      gmail_message_id: msgId,
    });

    await db
      .from("crm_conversaciones")
      .update({ ultimo_mensaje_at: new Date().toISOString(), no_leidos: (conv!.no_leidos ?? 0) + 1 })
      .eq("id", conv!.id);

    saved++;
  }

  return saved;
}
