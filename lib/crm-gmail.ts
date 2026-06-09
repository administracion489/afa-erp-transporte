// Gmail API — OAuth2 + envío + recepción
// Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Token de refresh se guarda en tabla crm_config (clave: gmail_refresh_token)

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// ── OAuth helpers ─────────────────────────────────────────────────────────

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string): Promise<void> {
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
  if (!res.ok || !data.refresh_token) throw new Error(data.error_description ?? "OAuth error");

  await supabaseAdmin()
    .from("crm_config")
    .upsert({ clave: "gmail_refresh_token", valor: data.refresh_token, updated_at: new Date().toISOString() });
}

export async function getAccessToken(): Promise<string> {
  const db = supabaseAdmin();
  const { data } = await db.from("crm_config").select("valor").eq("clave", "gmail_refresh_token").maybeSingle();
  if (!data?.valor) throw new Error("Gmail no autorizado — visita /api/crm/gmail/auth");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: data.valor,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const token = await res.json();
  if (!res.ok) throw new Error(token.error_description ?? "Error renovando token Gmail");
  return token.access_token;
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
