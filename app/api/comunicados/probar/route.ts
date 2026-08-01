// app/api/comunicados/probar/route.ts
// Envío de PRUEBA a UN destinatario (número o correo del operador) antes del masivo,
// usando el contenido real del comunicado. Requiere permiso del módulo "comunicados".

import { NextRequest, NextResponse } from "next/server";
import { enviarPrueba } from "@/lib/comunicados";
import { verificarUsuarioApi } from "@/lib/api-auth";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "comunicados");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { comunicado_id, canal, destino } = await req.json();
    if (!comunicado_id || !canal || !destino?.trim()) {
      return NextResponse.json({ error: "comunicado_id, canal y destino requeridos" }, { status: 400 });
    }
    if (canal !== "whatsapp" && canal !== "email") {
      return NextResponse.json({ error: "canal inválido" }, { status: 400 });
    }

    const r = await enviarPrueba(comunicado_id, canal, destino.trim());
    return NextResponse.json({ ok: true, messageId: r.messageId });
  } catch (e: any) {
    console.error("[comunicados/probar]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
