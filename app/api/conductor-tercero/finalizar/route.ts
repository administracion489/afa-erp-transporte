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
    .select("id, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  if (lat != null && lng != null) {
    await supabase.from("ubicaciones_gps").insert({
      vehiculo_id:          reserva.vehiculo_tercero_id != null ? null : (reserva.vehiculo_id ?? null),
      vehiculo_tercero_id:  reserva.vehiculo_tercero_id ?? null,
      conductor_id:         reserva.conductor_tercero_id != null ? null : (reserva.conductor_id ?? null),
      conductor_tercero_id: reserva.conductor_tercero_id ?? null,
      reserva_id: reserva.id,
      lat, lng, velocidad: 0, rumbo: 0, precision_m: 0,
      estado: "finalizado",
      created_at: new Date().toISOString(),
      fix_ts: new Date().toISOString(), // posición capturada AHORA = fix fresco (coherencia con el stream)
    });
  }

  await supabase.from("reservas").update({ estado: "finalizada" }).eq("id", reserva.id);

  return NextResponse.json({ ok: true });
}
