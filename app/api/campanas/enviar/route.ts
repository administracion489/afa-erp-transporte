// app/api/campanas/enviar/route.ts
// Dispara una campaña: siembra los envíos desde la audiencia y procesa el primer
// lote. Los pendientes restantes se drenan con /api/campanas/procesar (botón
// "Continuar" o cron). Requiere permiso del módulo CRM.

import { NextRequest, NextResponse } from "next/server";
import { sembrarEnvios, procesarCampana } from "@/lib/campanas";
import { verificarUsuarioApi } from "@/lib/api-auth";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { campana_id } = await req.json();
    if (!campana_id) return NextResponse.json({ error: "campana_id requerido" }, { status: 400 });

    const { total } = await sembrarEnvios(campana_id);
    if (total === 0) {
      return NextResponse.json({ ok: true, total: 0, mensaje: "La audiencia quedó vacía (nadie con consentimiento/canal válido)" });
    }
    const prog = await procesarCampana(campana_id);
    return NextResponse.json({ total, ...prog });
  } catch (e: any) {
    console.error("[campanas/enviar]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
