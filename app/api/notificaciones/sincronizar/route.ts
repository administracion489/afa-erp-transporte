// app/api/notificaciones/sincronizar/route.ts
// Llamada desde el botón "Sincronizar" en la UI

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { notificarReserva } from "@/lib/notificaciones";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { reserva_id } = body as { reserva_id: number };

    if (!reserva_id || typeof reserva_id !== "number") {
      return NextResponse.json({ error: "reserva_id requerido" }, { status: 400 });
    }

    // Enviar notificaciones
    const resultado = await notificarReserva(reserva_id, "manual", "confirmacion_pasajero");

    // Marcar reserva como sincronizada
    await supabaseAdmin
      .from("reservas")
      .update({
        sincronizado_app:    true,
        fecha_sincronizacion: new Date().toISOString(),
      })
      .eq("id", reserva_id);

    return NextResponse.json({
      ok:      true,
      mensaje: `${resultado.resumen.enviados} notificación(es) enviadas de ${resultado.resumen.total} pasajeros`,
      resumen: resultado.resumen,
      detalle: resultado.detalle,
    });

  } catch (error: any) {
    console.error("[notificaciones/sincronizar]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}