// app/api/campanas/procesar/route.ts
// Drena los envíos pendientes de una campaña.
//   • POST { campana_id }  → botón "Continuar" en la UI (permiso módulo CRM).
//   • GET                  → cron: drena TODAS las campañas en estado 'enviando'.
//     Fail-closed: si CRON_SECRET no está configurado, el endpoint se apaga.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { procesarCampana } from "@/lib/campanas";
import { verificarUsuarioApi } from "@/lib/api-auth";

export const maxDuration = 60;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { campana_id } = await req.json();
    if (!campana_id) return NextResponse.json({ error: "campana_id requerido" }, { status: 400 });

    const prog = await procesarCampana(campana_id);
    return NextResponse.json({ ...prog });
  } catch (e: any) {
    console.error("[campanas/procesar]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Fail-closed: sin CRON_SECRET el endpoint (que gasta dinero) queda cerrado.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const { data: activas } = await supabaseAdmin
      .from("campanas").select("id").eq("estado", "enviando").limit(20);

    const resultados = [];
    for (const c of activas ?? []) {
      try {
        const prog = await procesarCampana(c.id);
        resultados.push({ campana_id: c.id, ...prog });
      } catch (e: any) {
        resultados.push({ campana_id: c.id, error: e.message });
      }
    }
    return NextResponse.json({ ok: true, procesadas: resultados.length, detalle: resultados });
  } catch (e: any) {
    console.error("[campanas/procesar cron]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
