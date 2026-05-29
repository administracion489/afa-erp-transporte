import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Token requerido" }, { status: 400 });

  const supabase = adminClient();

  const { data: reserva, error } = await supabase
    .from("reservas")
    .select("id, estado, vehiculo_id, vehiculo_tercero_id, conductor_id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (error || !reserva)
    return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  if (reserva.token_expira_at && new Date(reserva.token_expira_at) < new Date())
    return NextResponse.json({ error: "Token expirado" }, { status: 410 });

  const { data: paradas } = await supabase
    .from("paradas")
    .select("id, orden, nombre, direccion, lat, lng, hora_estimada, estado")
    .eq("reserva_id", reserva.id)
    .order("orden");

  return NextResponse.json({
    reservaId: reserva.id,
    estado: reserva.estado,
    vehiculoId: reserva.vehiculo_tercero_id ?? reserva.vehiculo_id ?? null,
    paradas: paradas ?? [],
  });
}
