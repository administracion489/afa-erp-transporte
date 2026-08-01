// app/api/comunicados/enviar/route.ts
// Dispara un comunicado: prepara el PDF (encabezado WhatsApp + adjunto de correo),
// siembra los envíos desde la audiencia (pasajeros de la empresa) y procesa el primer
// lote. Los pendientes restantes se drenan con /api/comunicados/procesar (botón
// "Continuar" o cron). Requiere permiso del módulo "comunicados".

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sembrarEnvios, procesarComunicado, asegurarPdf } from "@/lib/comunicados";
import { verificarUsuarioApi } from "@/lib/api-auth";

export const maxDuration = 60;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "comunicados");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { comunicado_id } = await req.json();
    if (!comunicado_id) return NextResponse.json({ error: "comunicado_id requerido" }, { status: 400 });

    const { data: com } = await db.from("comunicados").select("canales").eq("id", comunicado_id).single();
    if (!com) return NextResponse.json({ error: "Comunicado no encontrado" }, { status: 404 });

    // Prepara el documento (idempotente): PDF adjunto o armado desde las imágenes.
    const pdf = await asegurarPdf(comunicado_id);
    if ((com.canales ?? []).includes("whatsapp") && !pdf) {
      return NextResponse.json(
        { error: "Para WhatsApp adjunta al menos una imagen o un PDF (se envía como documento)." },
        { status: 400 },
      );
    }

    const { total } = await sembrarEnvios(comunicado_id);
    if (total === 0) {
      return NextResponse.json({ ok: true, total: 0, mensaje: "La audiencia quedó vacía (ningún pasajero con teléfono/correo)." });
    }
    const prog = await procesarComunicado(comunicado_id);
    return NextResponse.json({ total, ...prog });
  } catch (e: any) {
    console.error("[comunicados/enviar]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
