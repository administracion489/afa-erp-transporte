// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/cerrar/route.ts
// CERRAR el periodo: lo vuelve INMUTABLE. Antes de cerrar se RECALCULA una última vez (para
// congelar lo que haya tras las corroboraciones y clasificaciones), se marcan las líneas
// como `confirmada` y el periodo como `cerrado`, con quién y cuándo. Un `cerrado` ya no se
// recalcula (calcularPeriodo responde `periodo_cerrado`) ni se vuelve a cerrar.
//
// QUIÉN: un rol aprobador (admin/gerente).
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { calcularPeriodo } from "@/lib/comisiones/datos";
import { tablaFaltante } from "@/lib/columna-faltante";

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
    return NextResponse.json({ error: "Solo un administrador o gerente puede cerrar el periodo." }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const anioMes = String(body?.anioMes ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(anioMes)) {
      return NextResponse.json({ error: "Falta el mes en formato AAAA-MM." }, { status: 400 });
    }

    // Recálculo final (salvo que ya esté cerrado). Si no se pudo calcular, no se cierra:
    // cerrar sobre un cálculo roto congelaría números malos.
    const r = await calcularPeriodo(admin, anioMes);
    if (!r.ok) {
      if (r.motivo === "periodo_cerrado") {
        return NextResponse.json({ error: "El periodo ya está cerrado." }, { status: 409 });
      }
      const status = r.motivo.startsWith("sin_migracion") ? 422 : 400;
      return NextResponse.json({ error: r.motivo }, { status });
    }

    // Congelar: líneas confirmadas, periodo cerrado.
    const { error: eLin } = await admin
      .from("comisiones_linea")
      .update({ estado: "confirmada" })
      .eq("periodo_id", r.periodoId);
    if (eLin) throw eLin;

    const { error: ePer } = await admin
      .from("comisiones_periodo")
      .update({ estado: "cerrado", cerrado_por: auth.userId, cerrado_en: new Date().toISOString() })
      .eq("id", r.periodoId)
      .eq("estado", "preliminar"); // candado: no re-cerrar
    if (ePer) throw ePer;

    return NextResponse.json({ ok: true, periodoId: r.periodoId, anioMes, lineas: r.lineas, totales: r.totales });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_periodo") || tablaFaltante(e, "comisiones_linea")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-04-lineas-y-periodos.sql" }, { status: 422 });
    }
    console.error("[comisiones/cerrar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
