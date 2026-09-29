// app/api/notificaciones/sincronizar/route.ts
// Llamada desde el botón "Sincronizar" en la UI

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { notificarReserva } from "@/lib/notificaciones";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    // Dispara correos/WhatsApp facturables a los pasajeros de cualquier reserva: sin sesión
    // del ERP era una bocina abierta. Lo llaman el manifiesto y la re-notificación de hora.
    const auth = await verificarUsuarioApiAlguno(req, ["programacion", "seguimiento"]);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
      // `detalle` NO viaja: trae nombre, correo y teléfono de cada pasajero y ninguna
      // pantalla lo lee (solo `resumen`). Queda en notificaciones_enviadas para auditoría.
    });

  } catch (error: any) {
    console.error("[notificaciones/sincronizar]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}