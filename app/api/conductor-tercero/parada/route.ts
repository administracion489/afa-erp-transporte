import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function POST(req: NextRequest) {
  const { token, paradaId } = await req.json() as { token: string; paradaId: number };
  if (!token || !paradaId) return NextResponse.json({ error: "Faltan datos" }, { status: 400 });

  const supabase = adminClient();

  const { data: reserva } = await supabase
    .from("reservas")
    .select("id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  // Verificar que la parada pertenece a esta reserva
  const { data: parada } = await supabase
    .from("paradas")
    .select("id")
    .eq("id", paradaId)
    .eq("reserva_id", reserva.id)
    .single();

  if (!parada) return NextResponse.json({ error: "Parada no pertenece a esta reserva" }, { status: 403 });

  await supabase.from("paradas").update({ estado: "completada" }).eq("id", paradaId);

  return NextResponse.json({ ok: true });
}
