import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// La tabla alertas_sos tiene RLS que permite SELECT pero NO UPDATE al cliente anon,
// por eso marcar "atendido" desde el navegador afectaba 0 filas y el SOS reaparecía al
// recargar. Este endpoint usa el service-role (bypass RLS) para persistir el cambio,
// igual que los inserts de SOS (api/seguimiento/sos, api/conductor-alerta).

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabasePublic = createClient(supabaseUrl, anonKey);
const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const { data: authData } = await supabasePublic.auth.getUser(token);
    if (!authData.user) {
      return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
    }

    // Confirmar que es un usuario activo del ERP
    const { data: perfil } = await supabaseAdmin
      .from("usuarios")
      .select("activo")
      .eq("id", authData.user.id)
      .single();
    if (!perfil || perfil.activo === false) {
      return NextResponse.json({ error: "Usuario no autorizado" }, { status: 403 });
    }

    const body = (await request.json()) as { id?: number };
    const id = Number(body.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "id requerido" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("alertas_sos")
      .update({ estado: "atendida", atendida_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[atender-sos] Error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Alerta no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    console.error("[atender-sos] Exception:", e?.message);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
