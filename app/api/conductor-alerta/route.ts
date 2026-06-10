// app/api/conductor-alerta/route.ts
// Registra alertas de retraso y SOS desde la app conductor.
// Usa service_role para bypasear RLS (anon no tiene permiso INSERT en alertas_sos).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { reserva_id, lat, lng, motivo, estado = "pendiente" } = body;

    if (!motivo) {
      return NextResponse.json({ error: "motivo requerido" }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("alertas_sos").insert({
      reserva_id: reserva_id ?? null,
      lat:        lat        ?? null,
      lng:        lng        ?? null,
      motivo,
      estado,
    });

    if (error) {
      console.error("[conductor-alerta] Error insertando alerta:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[conductor-alerta] Exception:", e.message);
    return NextResponse.json({ error: "Error interno: " + e.message }, { status: 500 });
  }
}
