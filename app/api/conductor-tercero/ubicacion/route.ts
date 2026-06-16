import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function POST(req: NextRequest) {
  const { token, lat, lng, velocidad, rumbo, precision } = await req.json() as {
    token: string; lat: number; lng: number;
    velocidad?: number; rumbo?: number; precision?: number;
  };
  if (!token || lat == null || lng == null) {
    return NextResponse.json({ error: "Faltan datos" }, { status: 400 });
  }

  const supabase = adminClient();

  const { data: reserva } = await supabase
    .from("reservas")
    .select("id, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });
  if (reserva.token_expira_at && new Date(reserva.token_expira_at) < new Date()) {
    return NextResponse.json({ error: "Token expirado" }, { status: 410 });
  }

  const { error: gpsErr } = await supabase.from("ubicaciones_gps").insert({
    vehiculo_id:          reserva.vehiculo_tercero_id != null ? null : (reserva.vehiculo_id ?? null),
    vehiculo_tercero_id:  reserva.vehiculo_tercero_id ?? null,
    conductor_id:         reserva.conductor_tercero_id != null ? null : (reserva.conductor_id ?? null),
    conductor_tercero_id: reserva.conductor_tercero_id ?? null,
    reserva_id: reserva.id,
    lat, lng,
    velocidad: velocidad ?? 0,
    rumbo: rumbo ?? 0,
    precision_m: precision ?? 0,
    estado: "en_ruta",
    created_at: new Date().toISOString(),
  });
  if (gpsErr) {
    console.error("[conductor-tercero/ubicacion] GPS insert error:", gpsErr.message);
    return NextResponse.json({ error: gpsErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
