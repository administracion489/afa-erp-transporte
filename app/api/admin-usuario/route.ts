import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabasePublic = createClient(supabaseUrl, anonKey);
const supabaseAdmin  = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function verificarAdmin(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await supabasePublic.auth.getUser(token);
  if (!user) return null;
  const { data: perfil } = await supabaseAdmin
    .from("usuarios")
    .select("rol, activo, id")
    .eq("id", user.id)
    .single();
  if (!perfil || perfil.rol !== "admin" || perfil.activo === false) return null;
  return perfil as { rol: string; activo: boolean; id: string };
}

// DELETE /api/admin-usuario  — eliminar usuario
export async function DELETE(request: Request) {
  try {
    const admin = await verificarAdmin(request);
    if (!admin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

    const { userId } = await request.json();
    if (!userId) return NextResponse.json({ error: "userId requerido" }, { status: 400 });
    if (userId === admin.id) return NextResponse.json({ error: "No puedes eliminarte a ti mismo" }, { status: 400 });

    await supabaseAdmin.from("permisos_usuario").delete().eq("usuario_id", userId);
    await supabaseAdmin.from("usuarios").delete().eq("id", userId);
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Error interno" }, { status: 500 });
  }
}

// PATCH /api/admin-usuario  — cambiar contraseña de otro usuario
export async function PATCH(request: Request) {
  try {
    const admin = await verificarAdmin(request);
    if (!admin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

    const { userId, newPassword } = await request.json();
    if (!userId || !newPassword) return NextResponse.json({ error: "userId y newPassword requeridos" }, { status: 400 });
    if (newPassword.length < 6) return NextResponse.json({ error: "La contraseña debe tener mínimo 6 caracteres" }, { status: 400 });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Error interno" }, { status: 500 });
  }
}
