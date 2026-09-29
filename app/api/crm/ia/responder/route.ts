import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { responderConIA } from "@/lib/crm-ia";

export const maxDuration = 60;

// Genera una respuesta de la IA para una conversación.
// Lo usa el botón "Pedir respuesta a IA" del inbox (forzar_borrador=true)
// y también el webhook de Meta (vía import directo, no por aquí).
export async function POST(req: NextRequest) {
  try {
    // Gasta tokens de Claude y puede ENVIAR la respuesta al cliente por WhatsApp: solo el equipo del CRM.
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const { conversacion_id, forzar_borrador } = await req.json();
    if (!conversacion_id) return NextResponse.json({ ok: false, error: "Falta conversacion_id" }, { status: 400 });
    const r = await responderConIA(conversacion_id, { forzarBorrador: !!forzar_borrador });
    return NextResponse.json(r, { status: r.ok ? 200 : 207 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
