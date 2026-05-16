// app/api/notificaciones/recordatorio/route.ts
// Ejecutada por Vercel Cron todos los días a las 8:00 AM Lima (hora Perú = UTC-5 = 13:00 UTC)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { notificarReserva } from "@/lib/notificaciones";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  // Verificar que viene de Vercel Cron (o llamada manual autorizada)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    // Fecha de mañana en zona Peru (UTC-5)
    const ahora    = new Date();
    const mañana   = new Date(ahora);
    mañana.setUTCHours(ahora.getUTCHours() + 5); // offset Lima
    mañana.setUTCDate(mañana.getUTCDate() + 1);
    const fechaMañana = mañana.toISOString().split("T")[0];

    // Reservas programadas o confirmadas para mañana
    const { data: reservas, error } = await supabaseAdmin
      .from("reservas")
      .select("id, fecha_servicio")
      .eq("fecha_servicio", fechaMañana)
      .in("estado", ["programada", "confirmada", "en_curso"]);

    if (error) throw error;
    if (!reservas || reservas.length === 0) {
      return NextResponse.json({
        ok: true,
        mensaje: `Sin reservas para mañana (${fechaMañana})`,
        procesadas: 0,
      });
    }

    // Filtrar las que ya recibieron recordatorio hoy
    const inicioHoy = new Date();
    inicioHoy.setUTCHours(0, 0, 0, 0);

    const { data: yaNotificadas } = await supabaseAdmin
      .from("notificaciones_enviadas")
      .select("reserva_id")
      .eq("trigger_origen", "cron_recordatorio")
      .gte("created_at", inicioHoy.toISOString());

    const idsYaNotificadas = new Set((yaNotificadas || []).map(n => n.reserva_id));
    const pendientes = reservas.filter(r => !idsYaNotificadas.has(r.id));

    if (pendientes.length === 0) {
      return NextResponse.json({
        ok: true,
        mensaje: "Todas las reservas de mañana ya fueron notificadas hoy",
        procesadas: 0,
      });
    }

    // Enviar recordatorios en paralelo (con límite de concurrencia)
    const resultados = [];
    for (const reserva of pendientes) {
      try {
        const res = await notificarReserva(reserva.id, "cron_recordatorio");
        resultados.push({ reservaId: reserva.id, ...res.resumen });
      } catch (e: any) {
        resultados.push({ reservaId: reserva.id, error: e.message });
      }
    }

    const totalEnviados = resultados.reduce((s, r) => s + (r.enviados ?? 0), 0);

    return NextResponse.json({
      ok:           true,
      fecha:        fechaMañana,
      procesadas:   pendientes.length,
      totalEnviados,
      detalle:      resultados,
    });

  } catch (error: any) {
    console.error("[notificaciones/recordatorio]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}