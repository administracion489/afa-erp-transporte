// POST /api/portal/confirmar-reset
// Valida el código recibido por email y actualiza la contraseña del usuario del portal.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const { token, nueva_password } = await req.json();

    if (!token?.trim()) {
      return NextResponse.json({ error: "Ingresa el código recibido por email" }, { status: 400 });
    }
    if (!nueva_password?.trim() || nueva_password.trim().length < 6) {
      return NextResponse.json({ error: "La nueva contraseña debe tener al menos 6 caracteres" }, { status: 400 });
    }

    const tokenNorm = token.trim().toUpperCase();

    // Buscar usuario con ese token
    const { data: usuario, error } = await supabaseAdmin
      .from("portal_usuarios")
      .select("id, nombre, reset_expires_at")
      .eq("reset_token", tokenNorm)
      .single();

    if (error || !usuario) {
      return NextResponse.json({ error: "Código inválido o ya utilizado. Solicita uno nuevo." }, { status: 400 });
    }

    // Verificar expiración
    if (!usuario.reset_expires_at || new Date(usuario.reset_expires_at) < new Date()) {
      // Limpiar token expirado
      await supabaseAdmin
        .from("portal_usuarios")
        .update({ reset_token: null, reset_expires_at: null })
        .eq("id", usuario.id);
      return NextResponse.json({ error: "El código ha expirado. Solicita uno nuevo." }, { status: 400 });
    }

    // Actualizar contraseña y limpiar token
    await supabaseAdmin
      .from("portal_usuarios")
      .update({
        codigo_acceso:    nueva_password.trim(),
        reset_token:      null,
        reset_expires_at: null,
      })
      .eq("id", usuario.id);

    return NextResponse.json({ ok: true, nombre: usuario.nombre });

  } catch (err: any) {
    console.error("confirmar-reset error:", err);
    return NextResponse.json({ error: "Error interno. Intenta de nuevo." }, { status: 500 });
  }
}
