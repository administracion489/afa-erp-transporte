// app/api/notificaciones/recordatorio/route.ts
// Ejecutada por Vercel Cron todos los días a las 8:00 AM Lima (hora Perú = UTC-5 = 13:00 UTC)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { notificarReserva, notificarConductor } from "@/lib/notificaciones";
import { reclamarEnvio, liberarEnvio } from "@/lib/alertas";

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

    // Filtrar las que ya recibieron recordatorio hoy. Dedupe INDEPENDIENTE para
    // pasajeros y conductor (una corrida que muere entre ambos no debe suprimir el
    // aviso al conductor). Se pagina con .range() porque .in() acota QUÉ reservas se
    // miran, pero NO cuántas filas devuelve PostgREST (tope ~1000) — sin paginar, un
    // día de alto volumen truncaría el dedupe y re-notificaría (duplicados).
    const inicioHoy = new Date();
    inicioHoy.setUTCHours(0, 0, 0, 0);
    const reservaIds = reservas.map(r => r.id);

    // Trae todas las filas de dedupe paginando. `cols` puede incluir conductor_id o no
    // (la columna es nueva: si la migración aún no corrió, se cae a solo pasajero).
    async function traerDedupe(cols: string): Promise<{ data?: any[]; error?: any }> {
      const filas: any[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await supabaseAdmin
          .from("notificaciones_enviadas")
          .select(cols)
          .eq("trigger_origen", "cron_recordatorio")
          .gte("created_at", inicioHoy.toISOString())
          .in("reserva_id", reservaIds)
          .order("created_at", { ascending: true })
          .range(from, from + page - 1);
        if (error) return { error };
        filas.push(...(data || []));
        if (!data || data.length < page) break;
      }
      return { data: filas };
    }

    let conductorDisponible = true;
    let dedupe = await traerDedupe("reserva_id, pasajero_id, conductor_id");
    if (dedupe.error) {
      // conductor_id no existe todavía (migración pendiente): dedupe resiliente sin ella.
      conductorDisponible = false;
      dedupe = await traerDedupe("reserva_id, pasajero_id");
    }

    const conPasajero  = new Set<number>();
    const conConductor = new Set<number>();
    for (const n of dedupe.data || []) {
      if (n.pasajero_id  != null) conPasajero.add(n.reserva_id);
      if (conductorDisponible && n.conductor_id != null) conConductor.add(n.reserva_id);
    }

    const pendientesPasajero  = reservas.filter(r => !conPasajero.has(r.id));
    // Si la columna conductor_id no existe aún, el aviso al conductor no puede loguear
    // ni deduplicar → se pospone hasta correr la migración (evita duplicados sin dedupe).
    const pendientesConductor = conductorDisponible
      ? reservas.filter(r => !conConductor.has(r.id))
      : [];

    if (pendientesPasajero.length === 0 && pendientesConductor.length === 0) {
      return NextResponse.json({
        ok: true,
        mensaje: "Todas las reservas de mañana ya fueron notificadas hoy",
        procesadas: 0,
      });
    }

    const resultados: any[] = [];
    // Pasajeros. reclamarEnvio = candado insert-once COMPARTIDO con el motor de alertas
    // (/api/alertas-flota/tick): si ese motor ya reclamó la reserva, aquí se salta y no
    // hay doble envío aunque ambos corran a la misma hora (TOCTOU resuelto atómicamente).
    for (const reserva of pendientesPasajero) {
      if (!(await reclamarEnvio("recordatorio_pasajero", reserva.id))) continue;
      try {
        const res = await notificarReserva(reserva.id, "cron_recordatorio");
        // Nada entregado y todo falló (transitorio) → liberar para que un tick reintente.
        if (res.resumen.enviados === 0 && res.resumen.errores > 0) await liberarEnvio("recordatorio_pasajero", reserva.id);
        resultados.push({ reservaId: reserva.id, tipo: "pasajeros", ...res.resumen });
      } catch (e: any) {
        await liberarEnvio("recordatorio_pasajero", reserva.id);
        resultados.push({ reservaId: reserva.id, tipo: "pasajeros", error: e.message });
      }
    }
    // Conductor
    for (const reserva of pendientesConductor) {
      if (!(await reclamarEnvio("recordatorio_conductor", reserva.id))) continue;
      try {
        const rc = await notificarConductor(reserva.id, "cron_recordatorio");
        if (rc.estado === "error") await liberarEnvio("recordatorio_conductor", reserva.id); // transitorio → reintentar
        resultados.push({ reservaId: reserva.id, tipo: "conductor", conductor: rc.estado });
      } catch (e: any) {
        await liberarEnvio("recordatorio_conductor", reserva.id);
        resultados.push({ reservaId: reserva.id, tipo: "conductor", error: e.message });
      }
    }

    const totalEnviados = resultados.reduce((s, r) => s + ("enviados" in r ? r.enviados : 0), 0);

    return NextResponse.json({
      ok:           true,
      fecha:        fechaMañana,
      procesadas:   pendientesPasajero.length + pendientesConductor.length,
      totalEnviados,
      detalle:      resultados,
    });

  } catch (error: any) {
    console.error("[notificaciones/recordatorio]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}