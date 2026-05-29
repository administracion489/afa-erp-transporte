import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function POST(req: NextRequest) {
  const { token, lat, lng } = await req.json() as { token: string; lat?: number; lng?: number };
  if (!token) return NextResponse.json({ error: "Token requerido" }, { status: 400 });

  const supabase = adminClient();

  const { data: reserva } = await supabase
    .from("reservas")
    .select("id, vehiculo_id, vehiculo_tercero_id, conductor_id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  const vehiculoId = reserva.vehiculo_tercero_id ?? reserva.vehiculo_id;
  if (lat != null && lng != null && vehiculoId) {
    await supabase.from("ubicaciones_gps").insert({
      vehiculo_id: vehiculoId,
      conductor_id: reserva.conductor_id,
      reserva_id: reserva.id,
      lat, lng, velocidad: 0, rumbo: 0, precision_m: 0,
      estado: "finalizado",
      created_at: new Date().toISOString(),
    });
  }

  await supabase.from("reservas").update({ estado: "finalizada" }).eq("id", reserva.id);

  return NextResponse.json({ ok: true });
}
