// Gmail API — OAuth2 + envío + recepción
// Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Token de refresh se guarda en tabla crm_config (clave: gmail_refresh_token)

import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  diasRecuperacion, marcadorVencido, remitenteDe, esRemitentePropio, esDeLaBandeja, explicarErrorGoogle,
  MAX_MENSAJES_POR_LECTURA,
} from "@/lib/crm-gmail-reglas";

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

export async function exchangeCode(code: string, db: any = supabaseAdmin()): Promise<void> {
  const data = await canjearCode(code);
  const email = await perfilGmail(data.access_token).catch(() => null);
  const ahora = new Date().toISOString();
  await db.from("crm_config").upsert([
    { clave: "gmail_refresh_token", valor: data.refresh_token, updated_at: ahora },
    { clave: "gmail_email", valor: email ?? "", updated_at: ahora },
    { clave: "gmail_ultimo_error", valor: "", updated_at: ahora },
  ]);
  // RECONECTAR EMPIEZA LIMPIO. El marcador viejo pertenece a la conexión anterior —quizá a otra
  // cuenta, o vencido después de días caída— y conservarlo era justo lo que dejaba la lectura en
  // 0 para siempre aunque se reconectara. Sin marcador, la próxima lectura trae la última semana.
  await db.from("crm_config").delete().in("clave", ["gmail_history_id", "gmail_ultima_sync"]);
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

export async function getAccessToken(db: any = supabaseAdmin()): Promise<string> {
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

export type ResultadoSyncGmail = {
  nuevos: number;
  revisados: number;
  email: string | null;
  /** historial = solo lo nuevo desde el marcador · inicial = primera conexión ·
   *  recuperacion = el marcador había vencido y se releyó el hueco por fecha. */
  modo: "historial" | "inicial" | "recuperacion";
  fallidos: number;
  /** Correos que quedaron para la próxima lectura (más de los que caben en una). */
  pendientes: number;
  /** Otra lectura estaba en curso: esta no hizo nada (no es un error). */
  ocupado?: boolean;
};

async function gmailGet(token: string, ruta: string): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${ruta}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function leerConfigCrm(db: any, claves: string[]): Promise<Map<string, string>> {
  const { data } = await db.from("crm_config").select("clave, valor").in("clave", claves);
  return new Map(((data as any[]) ?? []).map((r) => [String(r.clave), String(r.valor ?? "")]));
}

async function escribirConfigCrm(db: any, filas: Record<string, string>): Promise<void> {
  const ahora = new Date().toISOString();
  await db.from("crm_config").upsert(Object.entries(filas).map(([clave, valor]) => ({ clave, valor, updated_at: ahora })));
}

/** Cuánto se tiene una lectura por «en curso» antes de darla por muerta. */
const CANDADO_MS = 5 * 60_000;
/** Cuántos ids se listan como máximo para buscar los que faltan (se procesan de a 100). */
const LISTA_MAX = 500;
const CANDADO_LIBRE = "1970-01-01T00:00:00.000Z";

/**
 * Lee el INBOX del Gmail del CRM y lo vuelca a conversaciones. Reglas en lib/crm-gmail-reglas.ts.
 *
 * Lo que la versión anterior hacía mal y por lo que «el CRM no leía correos»:
 *  1. Con el marcador vencido (Gmail lo guarda ~una semana) se quedaba en 0 PARA SIEMPRE. Ahora
 *     un 404 relee por fecha el hueco desde la última lectura completa.
 *  2. Avanzaba el marcador ANTES de procesar: lo que fallaba a mitad no volvía a entrar nunca.
 *     Ahora el marcador nuevo se toma al EMPEZAR (del perfil) y se guarda solo si la lectura se
 *     COMPLETÓ (sin fallos y sin pendientes); si no, la próxima repite el mismo tramo y lo ya
 *     importado se descarta por id. Por eso «se reintenta solo» es cierto.
 *  3. Un error de Google no se veía en ningún sitio. Ahora queda escrito y el CRM lo enseña.
 *  4. Nada impedía que el cron y el botón 📧↻ leyeran a la vez: `crm_mensajes.gmail_message_id`
 *     no es UNIQUE, así que el mismo correo podía entrar dos veces. Un candado en crm_config.
 */
export async function syncGmailInbox(db: any = supabaseAdmin()): Promise<ResultadoSyncGmail> {
  const empezo = new Date().toISOString();

  // ── Candado: UPDATE condicional sobre una fila que existe siempre ──────────
  await db.from("crm_config").upsert(
    { clave: "gmail_sync_candado", valor: CANDADO_LIBRE, updated_at: empezo },
    { onConflict: "clave", ignoreDuplicates: true },
  );
  const { data: reclamo } = await db.from("crm_config")
    .update({ valor: empezo, updated_at: empezo })
    .eq("clave", "gmail_sync_candado")
    .lt("valor", new Date(Date.now() - CANDADO_MS).toISOString())
    .select("clave");
  if (!((reclamo as any[]) ?? []).length) {
    return { nuevos: 0, revisados: 0, email: null, modo: "historial", fallidos: 0, pendientes: 0, ocupado: true };
  }

  try {
    const token = await getAccessToken(db);

    // El perfil da la dirección del buzón y el marcador de AHORA, que es el que se guarda al final.
    const perfil = await gmailGet(token, "/profile");
    if (!perfil.ok) throw new Error(perfil.data?.error?.message ?? `Gmail respondió ${perfil.status}`);
    const email: string | null = perfil.data.emailAddress ?? null;
    const marcadorAhora = perfil.data.historyId ? String(perfil.data.historyId) : "";

    const cfg = await leerConfigCrm(db, ["gmail_history_id", "gmail_ultima_sync"]);
    const marcador = cfg.get("gmail_history_id") || "";
    let ids: string[] = [];
    let modo: ResultadoSyncGmail["modo"] = marcador ? "historial" : "inicial";

    if (marcador) {
      // El historial viene en orden de llegada (del más viejo al más nuevo).
      let pageToken: string | undefined;
      do {
        const r = await gmailGet(token,
          `/history?startHistoryId=${encodeURIComponent(marcador)}&historyTypes=messageAdded&labelId=INBOX&maxResults=100` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""));
        if (!r.ok) {
          if (marcadorVencido(r.status, r.data?.error?.message)) { modo = "recuperacion"; ids = []; break; }
          throw new Error(r.data?.error?.message ?? `Gmail respondió ${r.status}`);
        }
        for (const rec of r.data.history ?? []) {
          for (const ma of rec.messagesAdded ?? []) if (ma?.message?.id) ids.push(ma.message.id);
        }
        pageToken = r.data.nextPageToken;
      } while (pageToken && ids.length < LISTA_MAX);
    }

    if (modo !== "historial") {
      const dias = diasRecuperacion(cfg.get("gmail_ultima_sync"), Date.now());
      const lista: string[] = [];
      let pageToken: string | undefined;
      do {
        const r = await gmailGet(token,
          `/messages?labelIds=INBOX&maxResults=100&q=${encodeURIComponent(`newer_than:${dias}d`)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""));
        if (!r.ok) throw new Error(r.data?.error?.message ?? `Gmail respondió ${r.status}`);
        for (const m of r.data.messages ?? []) if (m?.id) lista.push(m.id);
        pageToken = r.data.nextPageToken;
      } while (pageToken && lista.length < LISTA_MAX);
      // La lista viene del más nuevo al más viejo: se da vuelta para procesar en orden de
      // llegada, que es el orden en que el hilo se escribió.
      ids = lista.reverse();
    }

    // Lo ya importado se descarta EN BLOQUE antes de cortar el lote. Cortar primero dejaba, con
    // más de 100 pendientes, los mismos 100 ya importados al frente de cada lectura: no avanzaba.
    const unicos = [...new Set(ids)];
    const yaImportados = new Set<string>();
    for (let k = 0; k < unicos.length; k += 100) {
      const { data } = await db.from("crm_mensajes").select("gmail_message_id").in("gmail_message_id", unicos.slice(k, k + 100));
      for (const r of (data as any[]) ?? []) if (r.gmail_message_id) yaImportados.add(String(r.gmail_message_id));
    }
    const faltan = unicos.filter((id) => !yaImportados.has(id));
    const lote = faltan.slice(0, MAX_MENSAJES_POR_LECTURA);
    const pendientes = faltan.length - lote.length;
    let nuevos = 0, fallidos = 0;

    for (const msgId of lote) {
      try {
        const r = await gmailGet(token, `/messages/${msgId}?format=full`);
        if (!r.ok) {
          // Borrado entre la lista y la lectura: no es un fallo de la lectura.
          if (r.status !== 404) fallidos++;
          continue;
        }
        const msg = r.data;
        if (!esDeLaBandeja(msg.labelIds)) continue;

        const headers = msg.payload?.headers ?? [];
        const { email: fromEmail, nombre: fromName } = remitenteDe(headerVal(headers, "from"));
        // Sin remitente no hay a quién atribuirlo: antes se creaba un contacto con el correo vacío.
        if (!fromEmail) continue;
        if (esRemitentePropio(fromEmail, email)) continue;

        const subject = headerVal(headers, "subject") || "(Sin asunto)";
        const threadId = msg.threadId;
        const body = extractBody(msg.payload ?? {});
        const fecha = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
        const noLeido = Array.isArray(msg.labelIds) && msg.labelIds.includes("UNREAD");

        let { data: contacto } = await db.from("crm_contactos").select("id").eq("gmail_email", fromEmail).limit(1).maybeSingle();
        if (!contacto) {
          const { data: nc, error: ec } = await db
            .from("crm_contactos")
            .insert({ nombre: fromName, gmail_email: fromEmail, canal_origen: "gmail" })
            .select("id")
            .single();
          if (ec) throw new Error(`crm_contactos: ${ec.message}`);
          contacto = nc;
        }

        let { data: conv } = await db
          .from("crm_conversaciones")
          .select("id, no_leidos, ultimo_mensaje_at")
          .eq("gmail_thread_id", threadId)
          .limit(1)
          .maybeSingle();
        if (!conv) {
          const { data: nc, error: ecv } = await db
            .from("crm_conversaciones")
            .insert({ contacto_id: contacto!.id, canal: "gmail", estado: "abierta", asunto: subject, gmail_thread_id: threadId })
            .select("id, no_leidos, ultimo_mensaje_at")
            .single();
          if (ecv) throw new Error(`crm_conversaciones: ${ecv.message}`);
          conv = nc;
        }

        const { error: em } = await db.from("crm_mensajes").insert({
          conversacion_id: conv!.id,
          direccion: "entrante",
          tipo: "texto",
          contenido: body || "(sin contenido)",
          gmail_message_id: msgId,
          // La fecha del CORREO, no la de la lectura: una recuperación de varios días no puede
          // dejar todo el hilo con la hora de hoy. Y lo que ya se leyó en Gmail entra leído.
          created_at: fecha,
          leido: !noLeido,
        });
        if (em) throw new Error(`crm_mensajes: ${em.message}`);

        // `ultimo_mensaje_at` solo AVANZA (misma regla que el historial de coexistencia): un correo
        // viejo recuperado no puede bajar una conversación activa al fondo de la bandeja.
        const previo = conv!.ultimo_mensaje_at ? Date.parse(conv!.ultimo_mensaje_at) : 0;
        await db
          .from("crm_conversaciones")
          .update({
            ultimo_mensaje_at: Date.parse(fecha) > previo ? fecha : conv!.ultimo_mensaje_at,
            no_leidos: (conv!.no_leidos ?? 0) + (noLeido ? 1 : 0),
          })
          .eq("id", conv!.id);

        nuevos++;
      } catch (e) {
        // Un correo que no entra no tumba la lectura de los demás.
        console.warn("[crm-gmail] mensaje", msgId, (e as Error)?.message);
        fallidos++;
      }
    }

    // El marcador AVANZA solo si la lectura se completó. Con fallos o pendientes se queda donde
    // estaba —y `gmail_ultima_sync` también, porque de ella sale la ventana de una recuperación—:
    // la próxima repite el mismo tramo y lo ya importado se descarta por id.
    const completa = fallidos === 0 && pendientes === 0;
    const avisos = [
      fallidos ? `${fallidos} correo(s) no se pudieron importar; se reintentan en la próxima lectura.` : "",
      pendientes ? `Quedan ${pendientes} correo(s) por traer: entran en las próximas lecturas (${MAX_MENSAJES_POR_LECTURA} por vez).` : "",
    ].filter(Boolean).join(" ");
    await escribirConfigCrm(db, {
      ...(completa && marcadorAhora ? { gmail_history_id: marcadorAhora } : {}),
      ...(completa ? { gmail_ultima_sync: empezo } : {}),
      gmail_ultima_lectura: empezo,
      // El ERROR es que la lectura entera no funcionó (y pide reconectar); un correo suelto que no
      // entró es un AVISO: se reintenta solo, y pintarlo de rojo mandaría a reconectar en vano.
      gmail_ultimo_error: "",
      gmail_ultimo_aviso: avisos,
      gmail_email: email ?? "",
    });
    return { nuevos, revisados: lote.length, email, modo, fallidos, pendientes };
  } catch (e: any) {
    const msg = explicarErrorGoogle(e?.message);
    await escribirConfigCrm(db, { gmail_ultimo_error: msg, gmail_ultimo_error_en: empezo }).catch(() => {});
    throw new Error(msg);
  } finally {
    await db.from("crm_config").update({ valor: CANDADO_LIBRE }).eq("clave", "gmail_sync_candado");
  }
}

/** Lo que la pantalla del CRM enseña del Gmail, sin llamar a Google. */
export async function estadoGmailCrm(db = supabaseAdmin()): Promise<{
  configurado: boolean;
  conectado: boolean;
  email: string | null;
  ultima_sync: string | null;
  ultimo_error: string | null;
  ultimo_error_en: string | null;
  ultimo_aviso: string | null;
  redirect_uri: string | null;
}> {
  const cfg = await leerConfigCrm(db, [
    "gmail_refresh_token", "gmail_email", "gmail_ultima_sync", "gmail_ultima_lectura", "gmail_ultimo_error", "gmail_ultimo_error_en", "gmail_ultimo_aviso",
  ]);
  return {
    configurado: googleOAuthConfigurado(),
    conectado: !!cfg.get("gmail_refresh_token"),
    email: cfg.get("gmail_email") || null,
    // Lo que se enseña es la última lectura que FUNCIONÓ, completa o no; `gmail_ultima_sync` es
    // otra cosa (la última COMPLETA, de la que sale la ventana de una recuperación).
    ultima_sync: cfg.get("gmail_ultima_lectura") || cfg.get("gmail_ultima_sync") || null,
    ultimo_error: cfg.get("gmail_ultimo_error") || null,
    ultimo_error_en: cfg.get("gmail_ultimo_error_en") || null,
    ultimo_aviso: cfg.get("gmail_ultimo_aviso") || null,
    // No es un secreto: es lo que hay que cotejar con «URI de redireccionamiento autorizados» en
    // Google Cloud cuando Google contesta redirect_uri_mismatch.
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? null,
  };
}
