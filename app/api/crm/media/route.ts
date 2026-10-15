import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { objetoPrivadoDe } from "@/lib/storage-privado";
import { rescatarUrlMeta } from "@/lib/crm-media";

export const maxDuration = 60;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

// POST { mensaje_ids: string[] } → { urls: { [id]: url firmada | null }, mimes }
// Firma la media de los mensajes del chat abierto (bucket privado crm-media) y, de paso,
// rescata la de los mensajes viejos que guardaron la URL de Meta (solo abre con token).
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const { mensaje_ids } = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(mensaje_ids) ? mensaje_ids.slice(0, 200).map(String) : [];
  if (!ids.length) return NextResponse.json({ ok: true, urls: {} });

  const sb = db();
  const { data, error } = await sb
    .from("crm_mensajes")
    .select("id, media_url, phone_number_id, conversacion_id, crm_conversaciones(phone_number_id)")
    .in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const urls: Record<string, string | null> = {};
  for (const m of (data ?? []) as any[]) {
    let ident: string | null = m.media_url ?? null;
    if (!ident) { urls[m.id] = null; continue; }
    if (!objetoPrivadoDe(ident)) {
      const phone = m.phone_number_id ?? m.crm_conversaciones?.phone_number_id ?? null;
      const nuevo = await rescatarUrlMeta(sb, ident, phone, m.id);
      if (nuevo) {
        await sb.from("crm_mensajes").update({ media_url: nuevo }).eq("id", m.id);
        ident = nuevo;
      } else if (/fbsbx\.com|whatsapp\.net/.test(ident)) { urls[m.id] = null; continue; }
    }
    const obj = objetoPrivadoDe(ident);
    if (!obj) { urls[m.id] = ident; continue; }
    const { data: f } = await sb.storage.from(obj.bucket).createSignedUrl(obj.ruta, 3600);
    urls[m.id] = f?.signedUrl ?? null;
  }
  return NextResponse.json({ ok: true, urls });
}
