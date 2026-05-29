import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

function generarToken() {
  return randomBytes(24).toString("base64url");
}

function expiraEn24h() {
  const d = new Date();
  d.setHours(d.getHours() + 24);
  return d.toISOString();
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerToken = authHeader.replace("Bearer ", "");

  const supabase = adminClient();

  // Verificar sesión del llamante
  const { data: { user }, error: authErr } = await supabase.auth.getUser(bearerToken);
  if (authErr || !user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { data: usuario } = await supabase
    .from("usuarios")
    .select("rol")
    .eq("id", user.id)
    .single();

  if (!usuario || usuario.rol !== "admin") {
    return NextResponse.json({ error: "Se requiere rol admin" }, { status: 403 });
  }

  const { reservaId, tipo } = await req.json() as { reservaId: number; tipo: "seguimiento" | "conductor_tercero" | "ambos" };
  if (!reservaId || !tipo) return NextResponse.json({ error: "Faltan parámetros" }, { status: 400 });

  const update: Record<string, string> = { token_expira_at: expiraEn24h() };
  if (tipo === "seguimiento" || tipo === "ambos") update.token_seguimiento = generarToken();
  if (tipo === "conductor_tercero" || tipo === "ambos") update.token_conductor_tercero = generarToken();

  const { data, error } = await supabase
    .from("reservas")
    .update(update)
    .eq("id", reservaId)
    .select("token_seguimiento, token_conductor_tercero, token_expira_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
