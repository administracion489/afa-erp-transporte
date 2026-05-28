// POST /api/portal/reset-password
// Genera un código de 6 caracteres y lo envía por email al usuario del portal cliente.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

// Logo embebido como base64 para que funcione en cualquier cliente de correo
function getLogoBase64(): string {
  try {
    const logoPath = path.join(process.cwd(), "public", "logoafa-removebg-preview.png");
    const buf = fs.readFileSync(logoPath);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function generarCodigo(): string {
  // 6 caracteres alfanuméricos sin ambigüedades (sin 0,O,1,I,L)
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function POST(req: NextRequest) {
  try {
    const { ruc, email } = await req.json();

    if (!ruc?.trim() || !email?.trim()) {
      return NextResponse.json({ error: "RUC y email son requeridos" }, { status: 400 });
    }

    const emailNorm = email.trim().toLowerCase();
    const rucNorm   = ruc.trim();

    // 1. Buscar el cliente por RUC
    const { data: cliente } = await supabaseAdmin
      .from("clientes")
      .select("id, empresa")
      .or(`ruc.eq.${rucNorm},empresa.ilike.%${rucNorm}%`)
      .limit(1)
      .single();

    // Respuesta genérica para no revelar si el cliente existe
    if (!cliente) {
      return NextResponse.json({ ok: true });
    }

    // 2. Buscar el usuario del portal con ese email
    const { data: usuario } = await supabaseAdmin
      .from("portal_usuarios")
      .select("id, nombre, email")
      .eq("cliente_id", cliente.id)
      .eq("email", emailNorm)
      .eq("activo", true)
      .single();

    if (!usuario) {
      return NextResponse.json({ ok: true });
    }

    // 3. Generar código y guardarlo con 30 min de expiración
    const token   = generarCodigo();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await supabaseAdmin
      .from("portal_usuarios")
      .update({ reset_token: token, reset_expires_at: expires })
      .eq("id", usuario.id);

    // 4. Enviar email via Resend
    const empresa    = process.env.EMPRESA_NOMBRE || "AFA Tours Peru S.A.C.";
    const fromAddr   = process.env.RESEND_FROM   || "noreply@afatoursperu.com";
    const apiKey     = process.env.RESEND_API_KEY || "";
    const nombreUser = usuario.nombre || "Usuario";
    const logoSrc    = getLogoBase64();

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Recupera tu acceso</title></head>
<body style="margin:0;padding:0;background:#F6F4EE;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <!-- Cabecera navy -->
        <tr>
          <td style="background:#0b315f;padding:28px 36px">
            ${logoSrc
              ? `<img src="${logoSrc}" alt="${empresa}" style="height:44px;object-fit:contain;display:block" />`
              : `<span style="font-size:20px;font-weight:900;color:white;letter-spacing:-0.5px">${empresa}</span>`
            }
          </td>
        </tr>

        <!-- Cuerpo -->
        <tr>
          <td style="padding:36px 36px 28px">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#9AA0AC;letter-spacing:0.1em;text-transform:uppercase">Portal Cliente · Recuperación de acceso</p>
            <h1 style="margin:0 0 20px;font-size:22px;font-weight:800;color:#0A0E1A;line-height:1.25">Hola, ${nombreUser} 👋</h1>
            <p style="margin:0 0 28px;font-size:14.5px;color:#6B6F7C;line-height:1.65">
              Recibimos una solicitud para restablecer la contraseña de tu cuenta en el portal de
              <strong style="color:#0A0E1A">${cliente.empresa || empresa}</strong>.
              Usa el código de abajo para crear una nueva contraseña.
            </p>

            <!-- Código destacado -->
            <div style="background:#EAEFF6;border-radius:14px;padding:28px 24px;text-align:center;margin-bottom:28px">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#6B6F7C;letter-spacing:0.12em;text-transform:uppercase">Tu código de recuperación</p>
              <p style="margin:0;font-size:44px;font-weight:900;letter-spacing:14px;color:#0b315f;font-family:ui-monospace,'JetBrains Mono',monospace">${token}</p>
              <p style="margin:10px 0 0;font-size:12px;color:#9AA0AC">⏱ Válido durante <strong>30 minutos</strong></p>
            </div>

            <p style="margin:0 0 6px;font-size:13px;color:#6B6F7C;line-height:1.6">
              Ingresa este código en la pantalla de recuperación del portal junto con tu nueva contraseña.
            </p>
            <p style="margin:0;font-size:12px;color:#9AA0AC;line-height:1.6">
              Si no solicitaste este cambio, ignora este mensaje. Tu contraseña actual seguirá siendo la misma.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#F6F4EE;padding:18px 36px;border-top:1px solid #E6E2D6">
            <p style="margin:0;font-size:11px;color:#9AA0AC">
              ${empresa} &nbsp;·&nbsp; Portal Empresarial &nbsp;·&nbsp;
              <a href="https://www.afatoursperu.com" style="color:#0b315f;text-decoration:none">afatoursperu.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:    fromAddr,
        to:      emailNorm,
        subject: `Recupera tu acceso al portal — ${empresa}`,
        html,
      }),
    });

    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error("reset-password error:", err);
    return NextResponse.json({ error: "Error interno. Intenta de nuevo." }, { status: 500 });
  }
}
