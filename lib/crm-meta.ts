// Meta Cloud API — WhatsApp, Messenger, Instagram
// Env vars: META_WA_TOKEN (WhatsApp system user token), META_PAGE_TOKEN (Messenger/Instagram page token)
// Legacy: META_ACCESS_TOKEN se usa como fallback si los nuevos no están definidos

import { tokenParaNumero } from "@/lib/meta-tokens";

const GRAPH = "https://graph.facebook.com/v25.0";
const PAGE_TOKEN = () => process.env.META_PAGE_TOKEN!;

// Token de WhatsApp POR NÚMERO, no global.
//
// Todos los números de AFA cuelgan del mismo system user (META_WA_TOKEN) y para
// ellos esto devuelve exactamente lo de siempre. La diferencia aparece al VENDER
// el ERP: cada empresa que completa el Embedded Signup entrega su propio business
// token, que queda cifrado en `whatsapp_tokens` y se usa solo para sus números.
// Sin esto, un segundo cliente sería imposible: su WABA no está bajo el system
// user de AFA y Meta rechazaría cada envío con un 190/200.
async function waToken(phoneId: string): Promise<string> {
  const token = await tokenParaNumero(phoneId);
  if (!token) {
    throw new Error(
      "No hay token de WhatsApp para este número: ni propio (whatsapp_tokens) ni META_WA_TOKEN en el entorno.",
    );
  }
  return token;
}

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

  // Normalización a E.164 sin "+", igual que normalizarTelefono() de notificaciones.ts
  // y comunicados.ts y normalizar() de campanas/probar: un móvil peruano son 9 dígitos
  // y con prefijo país queda en 11.
  //
  // OJO — aquí vivía `if (startsWith("51") && length === 11) "519" + substring(2)`, que
  // insertaba un 9 de más: 51987654321 → 519987654321. Perú no tiene el prefijo extra de
  // móvil de México (521) ni Argentina (549), así que ese caso NUNCA era correcto; con
  // un wa_id bien formado (los del webhook siempre lo están) se cumplía SIEMPRE. El
  // propio número de la empresa, 51966707225, acababa como 519966707225.
  // Se añadió el 2026-07-08 13:28 (d8e5d65) y 54 min después (82d8a99) el Inbox se
  // desvió a la plantilla hello_world, la única ruta que lo esquivaba: de ahí venía que
  // los clientes recibieran "Hello World". Quitar esto es lo que arregla la causa.
  const d = to.replace(/\D/g, "");
  const limpioTo = d.length === 9 ? "51" + d : d;

  const res = await fetch(`${GRAPH}/${phone}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await waToken(phone)}` },
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
  botones?: { index: number; texto: string }[],
  // Encabezado media OPCIONAL (imagen o documento por URL pública). Solo tiene efecto
  // si la plantilla fue creada en Meta con un componente HEADER del mismo tipo.
  // `filename` solo aplica a documentos (nombre visible del PDF en el chat).
  header?: { tipo: "image" | "document"; link: string; filename?: string }
): Promise<string | null> {
  const phone = phoneId ?? process.env.META_PHONE_NUMBER_ID;
  if (!phone) throw new Error("META_PHONE_NUMBER_ID no configurado");

  const components = [
    ...(header
      ? [{
          type: "header",
          parameters: [{
            type: header.tipo,
            [header.tipo]: {
              link: header.link,
              ...(header.tipo === "document" && header.filename ? { filename: header.filename } : {}),
            },
          }],
        }]
      : []),
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await waToken(phone)}` },
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await waToken(phoneId)}` },
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await waToken(phoneId)}` },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  });
}
