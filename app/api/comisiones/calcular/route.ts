// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/calcular/route.ts
// Calcular/RECALCULAR el periodo PRELIMINAR de un mes (admin/gerente). El cron
// (app/api/comisiones/preliminar) hace esto solo el último día del mes; este endpoint lo
// dispara a mano para ver el preliminar o reflejar un cambio (una corroboración, una
// clasificación, un cobro). Un mes `cerrado` NO se recalcula: `calcularPeriodo` responde
// `periodo_cerrado`.
//
// La utilidad sale SOLO de `v_utilidad_servicio`; acá no se recalcula nada (ver datos.ts).
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { calcularPeriodo } from "@/lib/comisiones/datos";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede calcular el periodo." }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const anioMes = String(body?.anioMes ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(anioMes)) {
      return NextResponse.json({ error: "Falta el mes en formato AAAA-MM." }, { status: 400 });
    }
    const r = await calcularPeriodo(admin, anioMes);
    if (!r.ok) {
      // `periodo_cerrado` es un 409 (conflicto de estado); `sin_migracion` un 422; el resto 400.
      const status = r.motivo === "periodo_cerrado" ? 409 : r.motivo.startsWith("sin_migracion") ? 422 : 400;
      return NextResponse.json({ error: r.motivo }, { status });
    }
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[comisiones/calcular]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
