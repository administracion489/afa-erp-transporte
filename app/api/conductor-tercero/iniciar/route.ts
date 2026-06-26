import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function POST(req: NextRequest) {
  const { token, lat, lng } = await req.json() as { token: string; lat: number; lng: number };
  if (!token) return NextResponse.json({ error: "Token requerido" }, { status: 400 });

  const supabase = adminClient();

  // Solo columnas que existen en la tabla reservas
  const { data: reserva, error: errR } = await supabase
    .from("reservas")
    .select("id, estado, token_expira_at, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id")
    .eq("token_conductor_tercero", token)
    .single();

  if (errR || !reserva) {
    console.error("[conductor-tercero/iniciar] error:", errR?.message ?? "no encontrado");
    return NextResponse.json({ error: "Link inválido" }, { status: 404 });
  }

  if (reserva.token_expira_at && new Date(reserva.token_expira_at) < new Date()) {
    return NextResponse.json({ error: "Link expirado" }, { status: 410 });
  }

  if (reserva.estado === "finalizada" || reserva.estado === "cancelada") {
    return NextResponse.json({ error: "Servicio no disponible" }, { status: 409 });
  }

  // Marcar como en_curso
  await supabase.from("reservas").update({ estado: "en_curso" }).eq("id", reserva.id);

  // Registrar ubicación inicial (vehiculo_id puede ser null si no hay vehículo asignado aún)
  const vehiculoId = reserva.vehiculo_tercero_id ?? reserva.vehiculo_id ?? null;
  if (lat && lng) {
    const { error: gpsErr } = await supabase.from("ubicaciones_gps").insert({
      // Rutear a las columnas correctas: terceros NO van en vehiculo_id/conductor_id.
      vehiculo_id:          reserva.vehiculo_tercero_id != null ? null : (reserva.vehiculo_id ?? null),
      vehiculo_tercero_id:  reserva.vehiculo_tercero_id ?? null,
      conductor_id:         reserva.conductor_tercero_id != null ? null : (reserva.conductor_id ?? null),
      conductor_tercero_id: reserva.conductor_tercero_id ?? null,
      reserva_id: reserva.id,
      lat, lng, velocidad: 0, rumbo: 0, precision_m: 0,
      estado: "en_ruta",
      created_at: new Date().toISOString(),
      fix_ts: new Date().toISOString(), // posición capturada AHORA = fix fresco (coherencia con el stream)
    });
    if (gpsErr) console.error("[conductor-tercero/iniciar] GPS insert error:", gpsErr.message);
  }

  // Paradas del servicio
  const { data: paradas } = await supabase
    .from("paradas")
    .select("id, orden, nombre, direccion, lat, lng, hora_estimada, estado")
    .eq("reserva_id", reserva.id)
    .order("orden");

  return NextResponse.json({ ok: true, reservaId: reserva.id, vehiculoId, paradas: paradas ?? [] });
}
