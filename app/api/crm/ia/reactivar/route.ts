import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { responderConIA } from "@/lib/crm-ia";
import { faltaColumna } from "@/lib/columna-faltante";
import { hayClienteEsperando } from "@/lib/crm-ia-reactivacion";

export const maxDuration = 60;

// El botón «🤖 IA pausada / IA activa» del inbox.
// Activar es una DECISIÓN de una persona: quita la pausa, anota `ia_reactivada_at` (desde ahí la
// pausa de 12 h por respuesta humana y el límite de turnos cuentan solo lo posterior) y, si el
// último mensaje es del cliente, la IA contesta YA en vez de esperar al próximo mensaje.
// La respuesta trae lo que decidió la IA, para que la pantalla diga por qué no contestó si no lo hizo
// (modo copiloto, fuera de horario, agente apagado…).
export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const { conversacion_id, activar } = await req.json();
    if (!conversacion_id || typeof activar !== "boolean")
      return NextResponse.json({ ok: false, error: "Faltan conversacion_id o activar" }, { status: 400 });

    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });

    if (!activar) {
      const { error } = await sb.from("crm_conversaciones").update({ ia_pausada: true }).eq("id", conversacion_id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, ia_pausada: true });
    }

    let sinMigracion = false;
    let r = await sb
      .from("crm_conversaciones")
      .update({ ia_pausada: false, ia_reactivada_at: new Date().toISOString() })
      .eq("id", conversacion_id)
      .select("id");
    if (r.error && faltaColumna(r.error, "ia_reactivada_at")) {
      sinMigracion = true;
      r = await sb.from("crm_conversaciones").update({ ia_pausada: false }).eq("id", conversacion_id).select("id");
    }
    if (r.error) return NextResponse.json({ ok: false, error: r.error.message }, { status: 500 });
    if (!r.data?.length) return NextResponse.json({ ok: false, error: "Conversación no encontrada." }, { status: 404 });

    const { data: ultimo } = await sb
      .from("crm_mensajes")
      .select("direccion")
      .eq("conversacion_id", conversacion_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let ia: { accion: string; motivo?: string | null; error?: string | null } | null = null;
    if (hayClienteEsperando(ultimo)) {
      const res = await responderConIA(conversacion_id);
      ia = { accion: res.accion, motivo: res.motivo ?? null, error: res.error ?? null };
    }
    return NextResponse.json({ ok: true, ia_pausada: false, sin_migracion: sinMigracion, cliente_esperando: !!ia, ia });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
