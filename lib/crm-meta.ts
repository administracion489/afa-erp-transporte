// Meta Cloud API — WhatsApp, Messenger, Instagram
// Env vars: META_WA_TOKEN (WhatsApp system user token), META_PAGE_TOKEN (Messenger/Instagram page token)
// Legacy: META_ACCESS_TOKEN se usa como fallback si los nuevos no están definidos

const GRAPH = "https://graph.facebook.com/v25.0";
const WA_TOKEN = () => process.env.META_WA_TOKEN!;
const PAGE_TOKEN = () => process.env.META_PAGE_TOKEN!;

// Los DOS números con API oficial de Meta:
//   • CRM       (+51 966707225) → atención al cliente + CAMPAÑAS  → META_PHONE_NUMBER_ID
//   • AVISOS    (+51 905438216) → notificaciones a pasajeros/conductores → phoneAvisos()
// (El +51 997683199 del Radar IA NO usa la API oficial — Baileys — y nunca debe pasar por aquí.)
export const phoneCrm = () => process.env.META_PHONE_NUMBER_ID;
// ── WhatsApp ──────────────────────────────────────────────────────────────

// phoneId opcional: por defecto el número de clientes (META_PHONE_NUMBER_ID).
// Para el número de pasajeros se pasa META_PHONE_NUMBER_ID_PASAJEROS.
export async function enviarWhatsApp(to: string, texto: string, phoneId?: string): Promise<string | null> {
  const phone = phoneId ?? process.env.META_PHONE_NUMBER_ID;
  if (!phone) throw new Error("META_PHONE_NUMBER_ID no configurado");

  // Limpieza y formateo del número para Perú
  let limpioTo = to.replace(/\D/g, ""); 

  if (limpioTo.startsWith("51") && limpioTo.length === 11) {
    limpioTo = "519" + limpioTo.substring(2);
  }

  const res = await fetch(`${GRAPH}/${phone}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN()}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: limpioTo, 
      type: "text",
      text: { body: texto },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error WhatsApp");
  return data.messages?.[0]?.id ?? null;
}

// Mensaje con PLANTILLA aprobada (HSM). Obligatorio para mensajes iniciados por
// la empresa fuera de la ventana de 24h (recordatorios, avisos a pasajeros).
// `parametros` rellena las variables {{1}}, {{2}}, … del cuerpo, en orden.
// `botones` rellena la variable {{1}} de botones URL DINÁMICOS (index = posición
// del botón en la plantilla, 0-based). Los botones URL estáticos (sin variable,
// p.ej. "Descargar App") NO necesitan entrada aquí — ya están fijos en la plantilla.
export async function enviarWhatsAppPlantilla(
  to: string,
  plantilla: string,
  idioma: string,
  parametros: string[] = [],
  phoneId?: string,
  botones?: { index: number; texto: string }[]
): Promise<string | null> {
  const phone = phoneId ?? process.env.META_PHONE_NUMBER_ID;
  if (!phone) throw new Error("META_PHONE_NUMBER_ID no configurado");

  const components = [
    ...(parametros.length
      ? [{ type: "body", parameters: parametros.map((text) => ({ type: "text", text })) }]
      : []),
    ...(botones ?? []).map((b) => ({
      type: "button",
      sub_type: "url",
      index: String(b.index),
      parameters: [{ type: "text", text: b.texto }],
    })),
  ];

  const res = await fetch(`${GRAPH}/${phone}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN()}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: plantilla,
        language: { code: idioma },
        ...(components.length ? { components } : {}),
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Error WhatsApp plantilla");
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
