import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { responderConIA } from "@/lib/crm-ia";

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

  for (const e of entry) {
    // ── WhatsApp ──────────────────────────────────────────────────────────
    if (object === "whatsapp_business_account") {
      for (const change of e.changes ?? []) {
        if (change.field !== "messages") continue;
        const val = change.value;
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
          });
          if (convId) conversacionesNuevas.add(convId);
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

  // El agente IA corre DESPUÉS de responder 200 a Meta (no bloquea el webhook).
  // responderConIA decide solo si está activo, el canal aplica, el hilo no está pausado, etc.
  if (conversacionesNuevas.size > 0) {
    after(async () => {
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
  let { data: contacto } = await supabase
    .from("crm_contactos")
    .select("id")
    .eq(m.idField, m.senderId)
    .maybeSingle();

  if (!contacto) {
    const { data: nc } = await supabase
      .from("crm_contactos")
      .insert({ nombre: m.senderName || m.senderId, canal_origen: m.canal, [m.idField]: m.senderId })
      .select("id")
      .single();
    contacto = nc;
  }

  // Buscar o crear conversación abierta
  let { data: conv } = await supabase
    .from("crm_conversaciones")
    .select("id, no_leidos")
    .eq("contacto_id", contacto!.id)
    .eq("canal", m.canal)
    .neq("estado", "resuelta")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) {
    const { data: nc } = await supabase
      .from("crm_conversaciones")
      .insert({ contacto_id: contacto!.id, canal: m.canal, estado: "abierta" })
      .select("id, no_leidos")
      .single();
    conv = nc;
  }

  await supabase.from("crm_mensajes").insert({
    conversacion_id: conv!.id,
    direccion: "entrante",
    tipo: m.tipo,
    contenido: m.contenido,
    media_url: m.mediaUrl,
    meta_message_id: m.metaMessageId,
  });

  await supabase
    .from("crm_conversaciones")
    .update({ ultimo_mensaje_at: new Date().toISOString(), no_leidos: (conv!.no_leidos ?? 0) + 1 })
    .eq("id", conv!.id);

  return conv!.id as string;
}
