// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/corroborar/route.ts
// El ADMIN corrobora, a fin de mes, qué marcas del fondo son ciertas. Solo lo corroborado
// (corroborado_en no null) entra al reparto del fondo (fondo-admin.ts). También ata la marca
// al periodo (periodo_id) para que el cálculo la encuentre.
//
// QUIÉN: SOLO admin. Es la última palabra sobre a quién se le paga el fondo.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
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
  if (auth.rol !== "admin") {
    return NextResponse.json({ error: "Solo un administrador puede corroborar el fondo." }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const ids = (Array.isArray(body?.ids) ? body.ids : body?.id != null ? [body.id] : [])
      .map((x: unknown) => Number(x))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
      return NextResponse.json({ error: "Indica qué marcas corroborar (id o ids)." }, { status: 400 });
    }
    // `corroborar: false` RETIRA la corroboración (vuelve a null) por si se marcó por error.
    const quitar = body?.corroborar === false;
    const anioMes = typeof body?.anioMes === "string" && /^\d{4}-\d{2}$/.test(body.anioMes) ? body.anioMes : null;

    // Si se pasa el mes, se ata la marca al periodo (si existe) para que el cálculo la vea.
    let periodoId: number | null = null;
    if (anioMes) {
      const { data: p } = await admin.from("comisiones_periodo").select("id").eq("anio_mes", anioMes).maybeSingle();
      periodoId = p?.id != null ? Number(p.id) : null;
    }

    const patch: Record<string, unknown> = quitar
      ? { corroborado_por: null, corroborado_en: null }
      : { corroborado_por: auth.userId, corroborado_en: new Date().toISOString() };
    if (periodoId != null && !quitar) patch.periodo_id = periodoId;

    const { data, error } = await admin
      .from("comisiones_operacion_admin")
      .update(patch)
      .in("id", ids)
      .select("id");
    if (error) throw error;
    return NextResponse.json({ ok: true, actualizadas: ((data as any[]) ?? []).length });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_operacion_admin")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/corroborar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
