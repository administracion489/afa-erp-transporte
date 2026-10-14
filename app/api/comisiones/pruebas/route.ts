// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/pruebas/route.ts
// Listar las PRUEBAS DE COBRO de una reserva (`comisiones_cobro_prueba`). Devuelve
// `archivo_url` tal cual se guardó: la RUTA dentro del bucket PRIVADO `documentos`, NUNCA
// una URL pública. El front la muestra con <ImgPrivada>/<EnlacePrivado>, que la firman con
// createSignedUrl. Solo un rol aprobador (las pruebas traen datos comerciales).
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

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede ver las pruebas de cobro." }, { status: 403 });
  }

  try {
    const url = new URL(req.url);
    const reservaId = Number(url.searchParams.get("reservaId"));
    if (!Number.isFinite(reservaId) || reservaId <= 0) {
      return NextResponse.json({ error: "Falta la reserva (reservaId)." }, { status: 400 });
    }

    const { data, error } = await admin
      .from("comisiones_cobro_prueba")
      .select("id,tipo_prueba,archivo_url,registrado_por,registrado_en")
      .eq("reserva_id", reservaId)
      .order("tipo_prueba", { ascending: true });
    if (error) throw error;

    // `archivo_url` va tal cual (la RUTA en el bucket privado), no se compone una URL.
    return NextResponse.json({ pruebas: (data as any[]) ?? [] });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_cobro_prueba")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/pruebas]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
