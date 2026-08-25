import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { responderConIA } from "@/lib/crm-ia";
import { esNumeroDeAvisos } from "@/lib/whatsapp-numeros";
import { procesarEchos, procesarHistorial, procesarContactos } from "@/lib/crm-coexistencia";
import { resolverContacto, resolverConversacion } from "@/lib/crm-ingesta";

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// El agente IA (after) puede tardar varios segundos con herramientas; damos margen.
export const maxDuration = 60;

// GET — verificación del webhook por Meta
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (
    p.get("hub.mode") === "subscribe" &&
    p.get("hub.verify_token") === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// POST — mensajes entrantes (WhatsApp + Messenger + Instagram)
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: true }); }

  const { object, entry = [] } = body;
  const conversacionesNuevas = new Set<string>(); // hilos con mensaje entrante → atender con IA
  // Webhooks de coexistencia apartados para procesarlos después de responder 200.
  const coexistencia: { campo: string; value: any }[] = [];

  for (const e of entry) {
    // ── WhatsApp ──────────────────────────────────────────────────────────
    if (object === "whatsapp_business_account") {
      for (const change of e.changes ?? []) {
        // ── Webhooks propios de la COEXISTENCIA ──────────────────────────
        // Solo llegan cuando el número sigue usándose en la app del celular.
        // Ninguno dispara el agente IA: o los escribió una persona, o son
        // conversaciones viejas. Ver lib/crm-coexistencia.ts.
        //
        // Se APARTAN para procesarlos en `after()`, ya con el 200 entregado: un
        // chunk de `history` trae cientos de mensajes y Meta reintenta el webhook
        // si tarda en responder — sin esto, el mismo tramo de historial entraría
        // varias veces y cada reintento competiría con el anterior.
        if (change.field === "smb_message_echoes" || change.field === "history" || change.field === "smb_app_state_sync") {
          coexistencia.push({ campo: change.field, value: change.value });
          continue;
        }

        if (change.field !== "messages") continue;
        const val = change.value;
        // ¿A QUÉ número llegó? El webhook es a nivel de WABA y ahora hay 2 números:
        // el de clientes (CRM, lo atiende Afita) y el de AVISOS (recordatorios y
        // campañas). Un pasajero que responde a un recordatorio NO debe recibir al
        // bot de ventas: se registra el mensaje y el opt-in/baja, pero sin IA.
        const phoneId  = val.metadata?.phone_number_id;
        const esAvisos = await esNumeroDeAvisos(phoneId);

        for (const msg of val.messages ?? []) {
          const convId = await processarMensaje({
            canal: "whatsapp",
            senderId: msg.from,
            senderName: val.contacts?.[0]?.profile?.name ?? msg.from,
            idField: "wa_id",
            contenido: msg.text?.body ?? msg.caption ?? `[${msg.type}]`,
            tipo: msg.type === "text" ? "texto" : msg.type,
            mediaUrl: msg.image?.url ?? msg.audio?.url ?? msg.video?.url ?? msg.document?.url ?? null,
            metaMessageId: msg.id,
            phoneNumberId: phoneId ?? null,
            displayPhoneNumber: val.metadata?.display_phone_number ?? null,
          });
          if (convId && !esAvisos) conversacionesNuevas.add(convId);
        }
      }
    }

    // ── Messenger ─────────────────────────────────────────────────────────
    if (object === "page") {
      for (const ev of e.messaging ?? []) {
        if (!ev.message) continue;
        const convId = await processarMensaje({
          canal: "messenger",
          senderId: ev.sender.id,
          senderName: "",
          idField: "fb_psid",
          contenido: ev.message.text ?? `[adjunto]`,
          tipo: ev.message.text ? "texto" : "imagen",
          mediaUrl: ev.message.attachments?.[0]?.payload?.url ?? null,
          metaMessageId: ev.message.mid,
        });
        if (convId) conversacionesNuevas.add(convId);
      }
    }

    // ── Instagram ─────────────────────────────────────────────────────────
    if (object === "instagram") {
      for (const ev of e.messaging ?? []) {
        if (!ev.message) continue;
        const convId = await processarMensaje({
          canal: "instagram",
          senderId: ev.sender.id,
          senderName: "",
          idField: "ig_id",
          contenido: ev.message.text ?? `[adjunto]`,
          tipo: ev.message.text ? "texto" : "imagen",
          mediaUrl: ev.message.attachments?.[0]?.payload?.url ?? null,
          metaMessageId: ev.message.mid,
        });
        if (convId) conversacionesNuevas.add(convId);
      }
    }
  }

  // Todo lo pesado corre DESPUÉS de responderle 200 a Meta, en un ÚNICO after():
  // la coexistencia primero y la IA al final, en ese orden y de forma garantizada.
  // Importa: un echo (alguien contestó desde el celular) pausa el hilo, y esa
  // decisión tiene que estar tomada antes de que el agente se plantee responder,
  // o el cliente recibe dos respuestas al mismo mensaje. Con dos after() por
  // separado el orden no está garantizado.
  if (coexistencia.length > 0 || conversacionesNuevas.size > 0) {
    after(async () => {
      const sb = db();
      for (const { campo, value } of coexistencia) {
        try {
          if (campo === "smb_message_echoes") await procesarEchos(sb, value);
          else if (campo === "history") await procesarHistorial(sb, value);
          else if (campo === "smb_app_state_sync") await procesarContactos(sb, value);
        } catch (err) {
          // Un chunk malformado no debe impedir el siguiente ni el resto del webhook.
          console.error(`[webhook] ${campo}:`, err);
        }
      }

      // responderConIA decide solo si está activo, el canal aplica, el hilo no
      // está pausado, etc.
      for (const id of conversacionesNuevas) {
        try {
          await responderConIA(id);
        } catch {
          /* el motor ya maneja sus errores; no romper el resto */
        }
      }
    });
  }

  return NextResponse.json({ ok: true });
}

type MsgInput = {
  canal: string;
  senderId: string;
  senderName: string;
  idField: "wa_id" | "fb_psid" | "ig_id";
  contenido: string;
  tipo: string;
  mediaUrl: string | null;
  metaMessageId: string;
  // Sólo WhatsApp: número de la empresa por el que entró (CRM vs AVISOS).
  phoneNumberId?: string | null;
  displayPhoneNumber?: string | null;
};

async function processarMensaje(m: MsgInput): Promise<string | null> {
  const supabase = db();

  // Dedup
  const { data: dup } = await supabase
    .from("crm_mensajes")
    .select("id")
    .eq("meta_message_id", m.metaMessageId)
    .maybeSingle();
  if (dup) return null;

  // Buscar o crear contacto
  const contacto = await resolverContacto(supabase, {
    campo: m.idField,
    valor: m.senderId,
    nombre: m.senderName || null,
    canal: m.canal,
  });
  if (!contacto) return null;

  // Consentimiento WhatsApp: quien escribe por WhatsApp queda opt-in automático
  // (relación existente → habilitado para campañas de marketing). Si el texto es
  // una palabra de baja (BAJA/STOP/CANCELAR…), se marca wa_baja y deja de recibir.
  if (m.canal === "whatsapp" && contacto) {
    const t = (m.contenido || "").trim().toLowerCase();
    // Baja SOLO con intención clara, para no confundir un mensaje operativo normal
    // ("quiero cancelar mi reserva", "tarifa más baja", "servicio non-stop") con una
    // baja de marketing. Se acepta: (a) el mensaje ES el comando de baja; o (b) una
    // frase explícita de no-contactar. Si pide baja NO se reafirma el opt-in.
    const esBaja =
      /^(baja|stop|cancelar|unsubscribe|dar(me)? de baja)[.!]?$/.test(t) ||
      /\bdar(me)?\s+de\s+baja\b/.test(t) ||
      /\bno\s+me\s+(escriban|env[ií]en|manden|molesten|contacten)\b/.test(t) ||
      /\bno\s+(quiero|deseo)\s+(recibir|mensajes|m[aá]s\s+mensajes|que\s+me\s+(escriban|contacten))\b/.test(t) ||
      /\bdejar\s+de\s+recibir\b/.test(t) ||
      /\bquitar(me)?\s+de\s+la\s+lista\b/.test(t) ||
      /\bno\s+molestar\b/.test(t);
    const ahora = new Date().toISOString();
    await supabase
      .from("crm_contactos")
      .update(
        esBaja
          ? { wa_baja: true, wa_baja_at: ahora }
          : { wa_opt_in: true, wa_opt_in_at: ahora },
      )
      .eq("id", contacto.id);
  }

  // Buscar o crear conversación abierta
  const conv = await resolverConversacion(supabase, {
    contactoId: contacto.id,
    canal: m.canal,
    phoneNumberId: m.phoneNumberId ?? null,
    displayPhoneNumber: m.displayPhoneNumber ?? null,
  });
  if (!conv) return null;

  const fila = {
    conversacion_id: conv.id,
    direccion: "entrante",
    tipo: m.tipo,
    contenido: m.contenido,
    media_url: m.mediaUrl,
    meta_message_id: m.metaMessageId,
    phone_number_id: m.phoneNumberId ?? null,
    display_phone_number: m.displayPhoneNumber ?? null,
  };
  // `origen` lo añade supabase/whatsapp-coexistencia.sql. Si esa migración aún no
  // se corrió, el mensaje se guarda igual sin la etiqueta: un webhook nunca debe
  // perder un mensaje del cliente por una columna que falta.
  const { error: errMsg } = await supabase.from("crm_mensajes").insert({ ...fila, origen: "entrante" });
  if (errMsg && /column .* does not exist/i.test(errMsg.message)) {
    await supabase.from("crm_mensajes").insert(fila);
  }

  await supabase
    .from("crm_conversaciones")
    .update({
      ultimo_mensaje_at: new Date().toISOString(),
      no_leidos: (conv!.no_leidos ?? 0) + 1,
      // Conversaciones antiguas (o reabiertas) quedan etiquetadas al primer
      // mensaje que llegue tras esta migración.
      ...(m.phoneNumberId ? { phone_number_id: m.phoneNumberId } : {}),
      ...(m.displayPhoneNumber ? { display_phone_number: m.displayPhoneNumber } : {}),
    })
    .eq("id", conv!.id);

  return conv!.id as string;
}
