import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarWhatsApp, enviarMessenger, enviarInstagram } from "@/lib/crm-meta";
import { enviarEmail } from "@/lib/crm-gmail";
import { phonePara } from "@/lib/whatsapp-numeros";

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export async function POST(req: NextRequest) {
  try {
    const { conversacion_id, texto, usuario_id } = await req.json();
    if (!conversacion_id || !texto?.trim()) {
      return NextResponse.json({ error: "Faltan datos" }, { status: 400 });
    }

    const supabase = db();

    // Obtener conversación + contacto. phone_number_id: por cuál de nuestros números
    // entró, para contestar por el mismo y no desde otro (ver más abajo).
    const { data: conv } = await supabase
      .from("crm_conversaciones")
      .select("id, canal, gmail_thread_id, asunto, contacto_id, phone_number_id, crm_contactos(wa_id, fb_psid, ig_id, gmail_email)")
      .eq("id", conversacion_id)
      .single();

    if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });

    const contacto = (conv as any).crm_contactos;
    let metaId: string | null = null;
    let gmailMsgId: string | null = null;
    let errorMsg: string | null = null;

    try {
      if (conv.canal === "whatsapp" && contacto?.wa_id) {
        // Se responde POR EL MISMO NÚMERO por el que escribió el cliente. Sin esto cae
        // al número por defecto, así que quien escribía a Avisos recibía la respuesta
        // desde Ventas. Las conversaciones anteriores a ago-2026 no tienen
        // phone_number_id guardado: para ésas se usa el número del CRM.
        const phoneId = (conv as any).phone_number_id ?? (await phonePara("crm"));
        metaId = await enviarWhatsApp(contacto.wa_id, texto, phoneId);
      } else if (conv.canal === "messenger" && contacto?.fb_psid) {
        metaId = await enviarMessenger(contacto.fb_psid, texto);
      } else if (conv.canal === "instagram" && contacto?.ig_id) {
        metaId = await enviarInstagram(contacto.ig_id, texto);
      } else if (conv.canal === "gmail" && contacto?.gmail_email) {
        const result = await enviarEmail(
          contacto.gmail_email,
          conv.asunto ?? "Re: Consulta",
          texto.replace(/\n/g, "<br>"),
          (conv as any).gmail_thread_id ?? undefined
        );
        gmailMsgId = result.messageId;
      } else {
        errorMsg = "Canal no soportado o contacto sin datos de canal";
      }
    } catch (e: any) {
      // WhatsApp solo permite texto libre dentro de las 24 h desde el último mensaje
      // del cliente; fuera de esa ventana exige una plantilla aprobada. Meta lo
      // devuelve como 131047 / "re-engagement message", ilegible para quien atiende.
      const bruto = String(e?.message ?? e);
      errorMsg = /131047|re-engagement|24 hours/i.test(bruto)
        ? "Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp ya no permite texto libre. Hay que reabrir la conversación con una plantilla aprobada (Campañas → plantillas)."
        : bruto;
    }

    // Guardar mensaje en DB siempre (incluso si falló)
    const { data: msg } = await supabase
      .from("crm_mensajes")
      .insert({
        conversacion_id,
        direccion: "saliente",
        tipo: "texto",
        contenido: texto,
        meta_message_id: metaId,
        gmail_message_id: gmailMsgId,
        enviado_por: usuario_id ?? null,
        error: errorMsg,
      })
      .select()
      .single();

    // Actualizar último mensaje
    await supabase
      .from("crm_conversaciones")
      .update({ ultimo_mensaje_at: new Date().toISOString(), estado: "en_progreso" })
      .eq("id", conversacion_id);

    if (errorMsg) {
      return NextResponse.json({ ok: false, error: errorMsg, msg }, { status: 207 });
    }

    return NextResponse.json({ ok: true, msg });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}