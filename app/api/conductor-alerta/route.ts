// app/api/conductor-alerta/route.ts
// Maneja dos acciones desde la app conductor (ambas requieren service_role para saltear RLS):
//   tipo = "alerta"   → INSERT en alertas_sos (retraso / SOS)
//   tipo = "embarque" → INSERT en pasajeros_parada (pasajero fuera de manifiesto)

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
    const { tipo = "alerta" } = body;

    // ── EMBARQUE fuera de manifiesto ────────────────────────────────────────
    if (tipo === "embarque") {
      const { parada_id, pasajero_id, reserva_id } = body;
      if (!parada_id || !pasajero_id) {
        return NextResponse.json({ error: "parada_id y pasajero_id requeridos" }, { status: 400 });
      }

      // Verificar si ya existe (evitar duplicado)
      const { data: existe } = await supabaseAdmin
        .from("pasajeros_parada")
        .select("id, estado")
        .eq("parada_id", parada_id)
        .eq("pasajero_id", pasajero_id)
        .maybeSingle();

      if (existe) {
        if (existe.estado === "embarcado") {
          return NextResponse.json({ ok: true, ya_embarcado: true, id: existe.id });
        }
        // Existe pero no embarcado → actualizar
        const { error: errUpd } = await supabaseAdmin
          .from("pasajeros_parada")
          .update({ estado: "embarcado" })
          .eq("id", existe.id);
        if (errUpd) return NextResponse.json({ error: errUpd.message }, { status: 500 });
        return NextResponse.json({ ok: true, id: existe.id });
      }

      // No existe → insertar. Intentar primero solo con columnas base (parada_id, pasajero_id, estado).
      // Agregar columnas opcionales una a una para evitar fallo por schema.
      const insertar = async (extra: Record<string, any> = {}) =>
        supabaseAdmin
          .from("pasajeros_parada")
          .insert({ parada_id, pasajero_id, estado: "embarcado", ...extra })
          .select("id")
          .single();

      // Intento 1: con reserva_id
      let { data: nuevo, error: errIns } = await insertar({ reserva_id: reserva_id ?? null });

      // Intento 2: sin reserva_id (columna puede no existir)
      if (errIns && errIns.message.includes("reserva_id")) {
        ({ data: nuevo, error: errIns } = await insertar());
      }

      if (errIns) {
        console.error("[conductor-alerta] Error insertando pasajero_parada:", errIns.message);
        return NextResponse.json({ error: errIns.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, id: nuevo?.id, creado: true });
    }

    // ── ALERTA (retraso / SOS) ──────────────────────────────────────────────
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
