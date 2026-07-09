// app/api/notificaciones/conductor/route.ts
// Aviso manual al conductor asignado a una reserva (WhatsApp, 2do número).
// Se puede disparar al asignar el servicio o para reenviar desde Seguimiento.

import { NextRequest, NextResponse } from "next/server";
import { notificarConductor } from "@/lib/notificaciones";
import { verificarUsuarioApi } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "seguimiento");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { reserva_id } = await req.json();
    if (!reserva_id || typeof reserva_id !== "number") {
      return NextResponse.json({ error: "reserva_id requerido" }, { status: 400 });
    }

    const resultado = await notificarConductor(reserva_id, "manual");
    return NextResponse.json({ ok: resultado.ok, resultado });
  } catch (e: any) {
    console.error("[notificaciones/conductor]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
