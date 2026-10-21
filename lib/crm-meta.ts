// Meta Cloud API — WhatsApp, Messenger, Instagram
// Env vars: META_WA_TOKEN (WhatsApp system user token), META_PAGE_TOKEN (Messenger/Instagram page token)
// Legacy: META_ACCESS_TOKEN se usa como fallback si los nuevos no están definidos

import { tokenPropio } from "@/lib/meta-tokens";
import { enviarConRespaldo, tokensEnOrden, VETO_TOKEN_PROPIO_MS } from "@/lib/meta-token-respaldo";
import { diagnosticarEnvio } from "@/lib/meta-salud-datos";
import { MARCA_META_DICE } from "@/lib/meta-salud";

const GRAPH = "https://graph.facebook.com/v25.0";
const PAGE_TOKEN = () => process.env.META_PAGE_TOKEN!;

// Token de WhatsApp POR NÚMERO, no global.
//
// Todos los números de AFA cuelgan del mismo system user (META_WA_TOKEN). La
// diferencia aparece al VENDER el ERP: cada empresa que completa el Embedded Signup
// entrega su propio business token, que queda cifrado en `whatsapp_tokens` y se usa
// solo para sus números. Sin esto, un segundo cliente sería imposible: su WABA no
// está bajo el system user de AFA y Meta rechazaría cada envío con un 190/200.
//
// Y si Meta rechaza el token propio POR PERMISOS, se reintenta una vez con el
// general (lib/meta-token-respaldo.ts): el 20-10-2026 el token propio del número
// del CRM perdió el permiso de envío y el número quedó mudo, aunque el system user
// de la empresa podía enviar por él. Un rechazo por permiso no envía ni cobra nada.
const tokenPropioVetadoHasta = new Map<string, number>();

async function postWA(phoneId: string, body: unknown, mensajePorDefecto: string): Promise<any> {
  const propio = await tokenPropio(phoneId);
  const general = process.env.META_WA_TOKEN;
  const vetado = (tokenPropioVetadoHasta.get(phoneId) ?? 0) > Date.now();
  const tokens = tokensEnOrden(propio, general, vetado);
  const r = await enviarConRespaldo(
    tokens,
    async (token) => {
      const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    },
    mensajePorDefecto,
  );
  if (!r.ok) {
    // Rechazado por permisos con TODOS los tokens: se le pregunta a Meta por qué
    // (lib/meta-salud.ts). Sin esto «Access denied» no distingue un permiso retirado
    // de una cuenta bloqueada o una deuda, y el operador no sabe dónde arreglarlo.
    if (r.porPermiso) {
      const v = await diagnosticarEnvio(phoneId, { propio, general });
      // El fbtrace_id va con el código de Meta: es lo que pide su soporte si el
      // diagnóstico no alcanza para explicar el rechazo.
      const traza = r.fbtrace ? ` [fbtrace_id ${r.fbtrace}]` : "";
      throw new Error(`${r.mensaje}${traza}${MARCA_META_DICE}${v.texto}`);
    }
    throw new Error(r.mensaje);
  }
  const propioLimpio = propio?.trim();
  if (propioLimpio && r.token !== propioLimpio) {
    if (!vetado) {
      console.warn(`[crm-meta] El token propio del número ${phoneId} fue rechazado por permisos; se envió con META_WA_TOKEN.`);
    }
    tokenPropioVetadoHasta.set(phoneId, Date.now() + VETO_TOKEN_PROPIO_MS);
  } else if (propioLimpio) {
    tokenPropioVetadoHasta.delete(phoneId);
  }
  return r.data;
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
  // Un cliente con «usuario» de WhatsApp y número oculto se identifica por su BSUID
  // («PE.1349…»): va tal cual, sin quitarle las letras.
  const esBsuid = /[A-Za-z]/.test(to);
  const d = to.replace(/\D/g, "");
  const limpioTo = esBsuid ? to.trim() : d.length === 9 ? "51" + d : d;

  const data = await postWA(
    phone,
    { messaging_product: "whatsapp", to: limpioTo, type: "text", text: { body: texto } },
    "Error WhatsApp",
  );
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

  const data = await postWA(
    phone,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: plantilla,
        language: { code: idioma },
        ...(components.length ? { components } : {}),
      },
    },
    "Error WhatsApp plantilla",
  );
  return data.messages?.[0]?.id ?? null;
}

export async function enviarWhatsAppMedia(
  to: string,
  tipo: "image" | "document" | "audio" | "video",
  url: string,
  caption?: string,
  opts: { phoneId?: string | null; filename?: string } = {},
): Promise<string | null> {
  const phoneId = opts.phoneId ?? process.env.META_PHONE_NUMBER_ID;
  if (!phoneId) throw new Error("META_PHONE_NUMBER_ID no configurado");
  // Igual que enviarWhatsApp: 9 dígitos → +51; un BSUID («PE.…») va tal cual.
  const d = to.replace(/\D/g, "");
  const destino = /[A-Za-z]/.test(to) ? to.trim() : d.length === 9 ? "51" + d : d;
  const cuerpo: Record<string, unknown> = { link: url };
  if (caption && tipo !== "audio") cuerpo.caption = caption;
  if (tipo === "document" && opts.filename) cuerpo.filename = opts.filename;

  const data = await postWA(
    phoneId,
    { messaging_product: "whatsapp", to: destino, type: tipo, [tipo]: cuerpo },
    "Error WhatsApp media",
  );
  return data.messages?.[0]?.id ?? null;
}

/**
 * El error de un envío de WhatsApp, dicho para el operador. Meta rechaza con 131047 lo que se
 * manda fuera de la ventana de 24 h desde el último mensaje del cliente: eso no se arregla
 * reintentando, sino desde el celular o con una plantilla. Con 131005 el ERP no tiene permiso
 * de envío sobre el número. El resto se deja tal cual. Lo usan el texto y el adjunto del
 * inbox, la respuesta de la IA y el envío de la cotización de traslado.
 */
export function explicarErrorEnvioWhatsApp(bruto: string): string {
  if (/131047|re-engagement|24 hours/i.test(bruto))
    return "Pasaron más de 24 h desde el último mensaje del cliente: desde el CRM ya no se puede enviar. Envíalo desde el celular (WhatsApp Business) o con una plantilla.";
  // 131005: el token con que el ERP envía no tiene permiso de mensajería sobre el número
  // (ya se probó el token propio y el general, ver lib/meta-token-respaldo.ts). Se
  // conserva el texto de Meta: es lo único que dice cuál de los dos falló y por qué.
  if (/131005|access denied/i.test(bruto) && bruto.includes(MARCA_META_DICE)) {
    const [codigo, dice] = bruto.split(MARCA_META_DICE);
    return `Meta rechazó el envío por este número. ${dice} Desde el celular sí se puede. (${codigo})`;
  }
  if (/131005|access denied/i.test(bruto))
    return `Meta rechazó el envío por permisos: el ERP no tiene permiso para enviar por este número. Desde el celular sí se puede. Arreglo: volver a conectar el número en /crm → «Conectar WhatsApp», o revisar en Meta Business Suite que la app del ERP siga con acceso a esa cuenta de WhatsApp. (${bruto})`;
  return bruto;
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
  try {
    await postWA(phoneId, { messaging_product: "whatsapp", status: "read", message_id: messageId }, "Error al marcar leído");
  } catch {
    /* marcar leído es best-effort */
  }
}

/** Marca el mensaje del cliente como leído (✓✓ azules) y le muestra «escribiendo…»
 *  de nuestro lado. Meta lo apaga solo a los ~25 s o al llegar nuestra respuesta.
 *  Best-effort: si falla no pasa nada. */
export async function marcarLeidoYEscribiendo(messageId: string, phoneId?: string | null): Promise<void> {
  const phone = phoneId ?? process.env.META_PHONE_NUMBER_ID;
  if (!phone || !messageId) return;
  try {
    await postWA(
      phone,
      { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } },
      "Error al marcar leído",
    );
  } catch {
    /* sin «escribiendo…» la respuesta sale igual */
  }
}
