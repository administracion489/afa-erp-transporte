// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/opero/route.ts
// El fondo administrativo: el VENDEDOR marca que un administrativo lo AYUDÓ en una reserva.
// Queda como `comisiones_operacion_admin` con `marcado_por = su uid`, SIN corroborar. Solo
// lo que el ADMIN corrobore a fin de mes (otro endpoint) entra al reparto del fondo.
//
// QUIÉN marca: el vendedor de ESA reserva, o un aprobador. Así nadie acredita a operadores
// en servicios ajenos. El reparto en sí lo decide la corroboración, no esta marca.
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

  try {
    const body = await req.json().catch(() => ({}));
    const reservaId = body?.reservaId != null ? Number(body.reservaId) : null;
    const paId = body?.personalAdministrativoId != null ? Number(body.personalAdministrativoId) : null;
    if (!reservaId || !paId) {
      return NextResponse.json({ error: "Faltan la reserva y el administrativo que ayudó." }, { status: 400 });
    }

    // Solo el vendedor de la reserva (o un aprobador) puede acreditar.
    const esAprobador = ["admin", "gerente"].includes(auth.rol);
    if (!esAprobador) {
      const { data: r } = await admin.from("reservas").select("cotizacion_id").eq("id", reservaId).maybeSingle();
      let vend: string | null = null;
      if (r?.cotizacion_id != null) {
        try {
          const { data: c } = await admin.from("cotizaciones").select("vendedor_id").eq("id", Number(r.cotizacion_id)).maybeSingle();
          vend = c?.vendedor_id != null ? String(c.vendedor_id) : null;
        } catch { vend = null; }
      }
      if (vend !== auth.userId) {
        return NextResponse.json({ error: "Solo el vendedor de esta reserva puede marcar quién lo ayudó." }, { status: 403 });
      }
    }

    const fila: Record<string, unknown> = {
      reserva_id: reservaId,
      personal_administrativo_id: paId,
      marcado_por: auth.userId,
      marcado_en: new Date().toISOString(),
      nota: (body?.nota ?? "").toString().trim().slice(0, 1000) || null,
    };
    const { data, error } = await admin.from("comisiones_operacion_admin").insert(fila).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, id: Number(data.id) });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_operacion_admin")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/opero]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
