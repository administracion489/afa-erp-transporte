// POST /api/portal/cambiar-password
// Cambia la contraseña del usuario del portal cliente que ya está logueado.
// Exige la contraseña actual y la verifica en el servidor antes de escribir la
// nueva — mismo nivel de seguridad que el login del portal (codigo_acceso).
// Sin sesión server-side: quien envíe otro usuario_id igual necesita conocer su
// contraseña actual para que el cambio prospere. Usa service-role para saltar RLS.
//
// SOLO usuarios individuales (portal_usuarios, id>0). El código compartido de la
// empresa (clientes.codigo_acceso) NO se rota desde aquí: cambiarlo dejaría fuera
// al resto de empleados que lo usan. Esos clientes deben migrarse a portal_usuarios.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const { usuario_id, actual, nueva } = await req.json();

    if (!actual?.trim()) {
      return NextResponse.json({ error: "Ingresa tu contraseña actual" }, { status: 400 });
    }
    if (!nueva?.trim() || nueva.trim().length < 6) {
      return NextResponse.json({ error: "La nueva contraseña debe tener al menos 6 caracteres" }, { status: 400 });
    }
    if (nueva.trim() === actual.trim()) {
      return NextResponse.json({ error: "La nueva contraseña debe ser distinta de la actual" }, { status: 400 });
    }
    if (typeof usuario_id !== "number" || usuario_id <= 0) {
      return NextResponse.json({ error: "Tu acceso usa el código compartido de la empresa. Pide a AFA que te cree un usuario individual." }, { status: 400 });
    }

    const actualTrim = actual.trim();
    const nuevaTrim  = nueva.trim();

    const { data: usuario, error } = await supabaseAdmin
      .from("portal_usuarios")
      .select("id, codigo_acceso, activo")
      .eq("id", usuario_id)
      .single();

    if (error || !usuario || !usuario.activo) {
      return NextResponse.json({ error: "Usuario no encontrado o inactivo" }, { status: 404 });
    }
    if ((usuario.codigo_acceso || "") !== actualTrim) {
      return NextResponse.json({ error: "La contraseña actual no es correcta" }, { status: 400 });
    }

    await supabaseAdmin
      .from("portal_usuarios")
      .update({ codigo_acceso: nuevaTrim, reset_token: null, reset_expires_at: null })
      .eq("id", usuario.id);

    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error("cambiar-password error:", err);
    return NextResponse.json({ error: "Error interno. Intenta de nuevo." }, { status: 500 });
  }
}
