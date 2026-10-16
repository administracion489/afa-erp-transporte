import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { enviarWhatsAppMedia } from "@/lib/crm-meta";
import { phonePara } from "@/lib/whatsapp-numeros";
import { BUCKET_CRM_MEDIA, asegurarBucket } from "@/lib/crm-media";

export const maxDuration = 60;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// Límites de WhatsApp Cloud API por tipo.
const LIMITE: Record<string, number> = { image: 5, video: 16, audio: 16, document: 100 };
const tipoDe = (mime: string) =>
  /^image\/(jpeg|png)$/.test(mime) ? "image" : /^video\/(mp4|3gpp)$/.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "document";
const limpiarNombre = (n: string) => n.replace(/[^\w.\-() áéíóúñÁÉÍÓÚÑ]/g, "_").slice(0, 120) || "archivo";
// La ruta en Storage solo admite ASCII: «COTIZACIÓN N° 00691.pdf» daba «Invalid key». El nombre
// con tildes se conserva para el chat y para WhatsApp; solo la RUTA va sin acentos ni símbolos.
const claveStorage = (n: string) =>
  n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 100) || "archivo";

// Enviar un archivo (cotización en PDF, Word, foto…) al cliente por WhatsApp, en dos pasos:
//   1) { accion: "subir", conversacion_id, nombre, mime, tamano } → URL firmada de SUBIDA:
//      el navegador sube directo al bucket privado (Vercel no acepta cuerpos de más de 4.5 MB).
//   2) { accion: "enviar", conversacion_id, ruta, nombre, mime, caption } → se manda por
//      WhatsApp con un enlace firmado que Meta descarga, y queda en el hilo.
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const body = await req.json().catch(() => ({}));
  const sb = db();

  const { data: conv } = await sb
    .from("crm_conversaciones")
    .select("id, canal, phone_number_id, crm_contactos(wa_id, telefono)")
    .eq("id", body.conversacion_id ?? "")
    .maybeSingle();
  if (!conv) return NextResponse.json({ ok: false, error: "Conversación no encontrada" }, { status: 404 });
  if (conv.canal !== "whatsapp")
    return NextResponse.json({ ok: false, error: "Por ahora los adjuntos solo se envían por WhatsApp." }, { status: 400 });

  const mime = String(body.mime || "application/octet-stream").split(";")[0];
  const tipo = tipoDe(mime);
  const nombre = limpiarNombre(String(body.nombre || "archivo"));

  if (body.accion === "subir") {
    const mb = Number(body.tamano) / 1024 / 1024;
    if (mb > LIMITE[tipo])
      return NextResponse.json({ ok: false, error: `WhatsApp acepta hasta ${LIMITE[tipo]} MB para este tipo de archivo (este pesa ${mb.toFixed(1)} MB).` }, { status: 400 });
    await asegurarBucket(sb);
    const ruta = `enviados/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${claveStorage(nombre)}`;
    const { data, error } = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUploadUrl(ruta);
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message ?? "No se pudo preparar la subida" }, { status: 500 });
    return NextResponse.json({ ok: true, ruta, token: data.token, bucket: BUCKET_CRM_MEDIA });
  }

  if (body.accion === "enviar") {
    const ruta = String(body.ruta ?? "");
    if (!ruta.startsWith("enviados/")) return NextResponse.json({ ok: false, error: "Ruta inválida" }, { status: 400 });
    const contacto = (conv as any).crm_contactos;
    const destino = contacto?.wa_id || (contacto?.telefono ? String(contacto.telefono).replace(/\D/g, "") : "");
    if (!destino) return NextResponse.json({ ok: false, error: "El contacto no tiene número de WhatsApp." }, { status: 400 });

    const { data: firmada } = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUrl(ruta, 3600);
    const caption = String(body.caption ?? "").trim();
    let metaId: string | null = null;
    let error: string | null = null;
    try {
      if (!firmada?.signedUrl) throw new Error("No se encontró el archivo subido");
      const phoneId = (conv as any).phone_number_id ?? (await phonePara("crm"));
      metaId = await enviarWhatsAppMedia(destino, tipo as any, firmada.signedUrl, caption || undefined, { phoneId, filename: nombre });
    } catch (e: any) {
      const bruto = String(e?.message ?? e);
      error = /131047|re-engagement|24 hours/i.test(bruto)
        ? "Pasaron más de 24 h desde el último mensaje del cliente: desde el CRM ya no se puede enviar. Envíalo desde el celular (WhatsApp Business) o con una plantilla."
        : bruto;
    }

    const media_url = sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
    const { data: msg } = await sb
      .from("crm_mensajes")
      .insert({
        conversacion_id: conv.id,
        direccion: "saliente",
        tipo,
        contenido: tipo === "document" ? (caption ? `${nombre}\n${caption}` : nombre) : caption || `[${tipo}]`,
        media_url,
        meta_message_id: metaId,
        error,
      })
      .select()
      .single();
    await sb.from("crm_conversaciones").update({ ultimo_mensaje_at: new Date().toISOString(), estado: "en_progreso" }).eq("id", conv.id);
    return NextResponse.json({ ok: !error, error, msg }, { status: error ? 207 : 200 });
  }

  return NextResponse.json({ ok: false, error: "Acción desconocida" }, { status: 400 });
}
