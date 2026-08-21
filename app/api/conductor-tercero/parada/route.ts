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

  // Cerrar el servicio AQUÍ MISMO si ya no quedan paradas pendientes, en vez de depender de
  // que el conductor pulse "Finalizar" (POST /conductor-tercero/finalizar) por separado. Ese
  // segundo paso es una acción aparte del conductor: si no la hace —red caída, cerró el link,
  // se le acabó la batería justo al llegar— la reserva queda "en_curso" con todas las paradas
  // completadas, a veces indefinidamente. Ver el mismo patrón en app/api/conductor/route.ts
  // (marcar_parada), caso real: reserva 11165.
  try {
    const { data: todas } = await supabase.from("paradas").select("estado").eq("reserva_id", reserva.id);
    const completas = (todas ?? []).length > 0 && (todas ?? []).every((p: any) => p.estado === "completada");
    if (completas) {
      await supabase.from("reservas").update({ estado: "finalizada" })
        .eq("id", reserva.id).eq("estado", "en_curso");
    }
  } catch (e: any) { console.warn("[conductor-tercero/parada] no se pudo auto-cerrar:", e?.message); }

  return NextResponse.json({ ok: true });
}
