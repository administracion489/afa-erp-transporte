// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/preliminar/route.ts
// CRON de Vercel. Corre a DIARIO pero actúa SOLO el último día del mes (patrón `tocaHoy`):
// deja el cálculo PRELIMINAR del mes listo para que el dueño lo cierre entre el día 1 y 5.
// Protegido por CRON_SECRET en modo FAIL-CLOSED (`esCronAutorizado`): sin el secreto, nadie.
//
// Solo despierta y decide la fecha con `hoyLima`/`esUltimoDiaDelMes`; el cálculo y la
// idempotencia (un mes cerrado no se recalcula) viven en `calcularPeriodo`. Un día que no
// es fin de mes responde sin tocar nada.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado } from "@/lib/api-auth";
import { hoyLima, esUltimoDiaDelMes } from "@/lib/ocupacion/cadencia";
import { calcularPeriodo } from "@/lib/comisiones/datos";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const hoy = hoyLima();
    if (!esUltimoDiaDelMes(hoy)) {
      return NextResponse.json({ ok: true, motivo: "hoy_no_es_fin_de_mes", hoy });
    }
    const anioMes = hoy.slice(0, 7);
    const r = await calcularPeriodo(admin, anioMes);
    // `periodo_cerrado` no es un error del cron (alguien ya cerró): se informa y ya.
    return NextResponse.json({ ok: r.ok, anioMes, resultado: r });
  } catch (e: any) {
    console.error("[comisiones/preliminar cron]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
