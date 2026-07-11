// app/api/radar/reprocesar/route.ts — re-analiza un mensaje puntual desde el dashboard.
// Auth: usuario del ERP con permiso del módulo radar-ia (Bearer del cliente Supabase).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { procesarPendientes } from "@/lib/radar/motor";

export const maxDuration = 120;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "radar-ia");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
    }
    const body = await req.json();
    const mensajeId = String(body?.mensaje_id ?? "");
    if (!mensajeId) return NextResponse.json({ error: "Falta mensaje_id" }, { status: 400 });

    // Volver a pendiente (permite reprocesar procesados, descartados y con error)
    const { error } = await supabaseAdmin
      .from("radar_mensajes")
      .update({ estado: "pendiente", error: null, accion: null })
      .eq("id", mensajeId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const resumen = await procesarPendientes({ limite: 1, soloMensajeId: mensajeId, forzar: true });
    return NextResponse.json({ ok: true, ...resumen });
  } catch (error: any) {
    console.error("[radar/reprocesar]", error);
    return NextResponse.json({ error: error?.message ?? "Error interno" }, { status: 500 });
  }
}
