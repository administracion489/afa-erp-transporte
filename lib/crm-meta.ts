// Meta Cloud API — WhatsApp, Messenger, Instagram
// Env vars: META_WA_TOKEN (WhatsApp system user token), META_PAGE_TOKEN (Messenger/Instagram page token)
// Legacy: META_ACCESS_TOKEN se usa como fallback si los nuevos no están definidos

const GRAPH = "https://graph.facebook.com/v19.0";
const WA_TOKEN = () => process.env.META_WA_TOKEN ?? process.env.META_ACCESS_TOKEN!;
const PAGE_TOKEN = () => process.env.META_PAGE_TOKEN ?? process.env.META_ACCESS_TOKEN!;

// ── WhatsApp ──────────────────────────────────────────────────────────────

export async function enviarWhatsApp(to: string, texto: string): Promise<string | null> {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!phoneId) throw new Error("META_PHONE_NUMBER_ID no configurado");

  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN()}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: texto },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error WhatsApp");
  return data.messages?.[0]?.id ?? null;
}

export async function enviarWhatsAppMedia(
  to: string,
  tipo: "image" | "document" | "audio",
  url: string,
  caption?: string
): Promise<string | null> {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!phoneId) throw new Error("META_PHONE_NUMBER_ID no configurado");

  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN()}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: tipo,
      [tipo]: { link: url, ...(caption ? { caption } : {}) },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error WhatsApp media");
  return data.messages?.[0]?.id ?? null;
}

// ── Messenger ─────────────────────────────────────────────────────────────

export async function enviarMessenger(psid: string, texto: string): Promise<string | null> {
  const pageId = process.env.META_PAGE_ID;
  if (!pageId) throw new Error("META_PAGE_ID no configurado");

  const res = await fetch(`${GRAPH}/${pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PAGE_TOKEN()}` },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text: texto },
      messaging_type: "RESPONSE",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error Messenger");
  return data.message_id ?? null;
}

// ── Instagram ─────────────────────────────────────────────────────────────

export async function enviarInstagram(igScopedId: string, texto: string): Promise<string | null> {
  const igAccountId = process.env.META_IG_ACCOUNT_ID;
  if (!igAccountId) throw new Error("META_IG_ACCOUNT_ID no configurado");

  const res = await fetch(`${GRAPH}/${igAccountId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PAGE_TOKEN()}` },
    body: JSON.stringify({
      recipient: { id: igScopedId },
      message: { text: texto },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error Instagram");
  return data.message_id ?? null;
}

// ── Marcar como leído en WhatsApp ─────────────────────────────────────────

export async function marcarLeidoWA(messageId: string): Promise<void> {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!phoneId) return;
  await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN()}` },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  });
}
