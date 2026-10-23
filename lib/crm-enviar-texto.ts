// ──────────────────────────────────────────────────────────────────────────────
// lib/crm-enviar-texto.ts — Manda un TEXTO por el canal de una conversación del CRM y lo deja en el
// hilo (`crm_mensajes`), también si falló (el error se ve donde se mira). SOLO SERVIDOR: el cliente
// de Supabase (service-role) llega por parámetro; no crea ninguno al importarse.
//
// Es `enviarPorCanal` de lib/crm-ia.ts EXTRAÍDA, no reescrita: la IA la sigue llamando por ahí (con
// los mismos valores por defecto: `generado_por_ia: true`, sin `enviado_por`), y la usan además las
// acciones de la tarjeta de la reserva de traslados (lib/traslados/reserva-solicitud-datos.ts), que
// mandan los textos que arma el código (T4, T5, T7, T9…).
//
// LO QUE NO SE AFLOJA:
//  · EL NÚMERO DE DESTINO LO FIJA QUIEN LLAMA ANTES (`waDestino`): `actualizar_contacto` deja al
//    modelo reescribir `contacto.telefono` en el mismo turno. Sin `waDestino`, el wa_id del hilo o,
//    sin él, el teléfono del contacto (lo de siempre).
//  · POR EL MISMO NÚMERO por el que escribió el cliente (`conv.phone_number_id`), y si no, el del CRM.
//  · El mensaje se guarda SIEMPRE, con su `error` si no salió: un envío fallido no desaparece.
// ──────────────────────────────────────────────────────────────────────────────

import { enviarWhatsApp, enviarMessenger, enviarInstagram, explicarErrorEnvioWhatsApp } from "@/lib/crm-meta";
import { phonePara } from "@/lib/whatsapp-numeros";
import { enviarEmail } from "@/lib/crm-gmail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type ConvEnvio = { id: string; canal?: string | null; phone_number_id?: string | null; asunto?: string | null; gmail_thread_id?: string | null };
export type ContactoEnvio = { wa_id?: unknown; telefono?: unknown; fb_psid?: string | null; ig_id?: string | null; gmail_email?: string | null } | null | undefined;

/** Lo que se reemplaza en la matriz para correr sin red. */
export type DepsEnvioTexto = {
  enviarWhatsApp?: typeof enviarWhatsApp;
  enviarMessenger?: typeof enviarMessenger;
  enviarInstagram?: typeof enviarInstagram;
  enviarEmail?: (to: string, asunto: string, html: string, hilo?: string) => Promise<{ messageId: string | null }>;
  phonePara?: (uso: "crm") => Promise<string | undefined>;
  ahoraMs?: () => number;
};

export type ResultadoEnvioTexto = { error: string | null; metaId: string | null };

/** El número de WhatsApp al que se responde: el wa_id del hilo o, sin él, el teléfono del contacto. */
export function waDestinoDe(contacto: { wa_id?: unknown; telefono?: unknown } | null | undefined): string {
  if (contacto?.wa_id) return String(contacto.wa_id);
  return contacto?.telefono ? String(contacto.telefono).replace(/\D/g, "") : "";
}

/**
 * Envía `texto` por el canal de `conv` y lo registra en el hilo. Nunca lanza por el envío: el error
 * vuelve en `error` (ya explicado para el operador) y queda escrito en el mensaje.
 *  · `waDestino`: el número copiado ANTES (ver la cabecera). `undefined` = el del contacto.
 *  · `generadoPorIa`: por defecto true (la IA). Las acciones de la tarjeta lo pasan también en true:
 *    el texto lo escribió el código, no una persona, y marcarlo como humano apartaría a la IA del
 *    hilo `pausa_humano_horas` (no leería el comprobante que el cliente manda después).
 *  · `enviadoPor`: el usuario del ERP que pulsó (solo se escribe si viene).
 */
export async function enviarTextoCRM(
  sb: Sb,
  conv: ConvEnvio,
  contacto: ContactoEnvio,
  texto: string,
  opts: { waDestino?: string; generadoPorIa?: boolean; enviadoPor?: string | null } = {},
  deps: DepsEnvioTexto = {},
): Promise<ResultadoEnvioTexto> {
  let metaId: string | null = null;
  let gmailMsgId: string | null = null;
  let error: string | null = null;
  try {
    // Por el mismo número que usó el cliente (ver app/api/crm/mensajes/enviar).
    // Sin wa_id (contacto creado a mano, o por el historial) se usa su teléfono.
    const waDestino = opts.waDestino !== undefined ? opts.waDestino : waDestinoDe(contacto);
    if (conv.canal === "whatsapp" && waDestino)
      metaId = await (deps.enviarWhatsApp ?? enviarWhatsApp)(waDestino, texto, conv.phone_number_id ?? (await (deps.phonePara ?? phonePara)("crm")));
    else if (conv.canal === "messenger" && contacto?.fb_psid) metaId = await (deps.enviarMessenger ?? enviarMessenger)(contacto.fb_psid, texto);
    else if (conv.canal === "instagram" && contacto?.ig_id) metaId = await (deps.enviarInstagram ?? enviarInstagram)(contacto.ig_id, texto);
    else if (conv.canal === "gmail" && contacto?.gmail_email) {
      const r = await (deps.enviarEmail ?? enviarEmail)(contacto.gmail_email, conv.asunto ?? "Re: Consulta", texto.replace(/\n/g, "<br>"), conv.gmail_thread_id ?? undefined);
      gmailMsgId = r.messageId;
    } else error = "Canal sin datos para enviar";
  } catch (e) {
    error = explicarErrorEnvioWhatsApp(String((e as Error)?.message ?? "Error de envío"));
  }
  const fila: Record<string, unknown> = {
    conversacion_id: conv.id,
    direccion: "saliente",
    tipo: "texto",
    contenido: texto,
    meta_message_id: metaId,
    gmail_message_id: gmailMsgId,
    generado_por_ia: opts.generadoPorIa !== false,
    error,
  };
  if (opts.enviadoPor) fila.enviado_por = opts.enviadoPor;
  await sb.from("crm_mensajes").insert(fila);
  await sb.from("crm_conversaciones").update({ ultimo_mensaje_at: new Date(deps.ahoraMs?.() ?? Date.now()).toISOString() }).eq("id", conv.id);
  return { error, metaId };
}
