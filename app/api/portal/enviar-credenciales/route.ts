// POST /api/portal/enviar-credenciales
// Envía las credenciales de acceso al portal cliente por email.
// Llamado desde el ERP (clientes/page.tsx) al crear o actualizar un usuario del portal.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function getLogoBase64(): string {
  try {
    const logoPath = path.join(process.cwd(), "public", "logoafa-removebg-preview.png");
    return `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  try {
    // Verificar que el llamador tiene sesión válida en el ERP
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (token) {
      const { error: authErr } = await supabaseAdmin.auth.getUser(token);
      if (authErr) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const { usuario_id, password, tipo_doc } = await req.json();
    if (!usuario_id || !password) {
      return NextResponse.json({ error: "Faltan datos" }, { status: 400 });
    }

    // Obtener datos del usuario del portal
    const { data: usuario, error: uErr } = await supabaseAdmin
      .from("portal_usuarios")
      .select("id, nombre, dni, email, cargo, rol, cliente_id")
      .eq("id", usuario_id)
      .single();

    if (uErr || !usuario) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }

    if (!usuario.email) {
      return NextResponse.json({ ok: true, skipped: true, reason: "sin_email" });
    }

    // Obtener datos del cliente (empresa)
    const { data: cliente } = await supabaseAdmin
      .from("clientes")
      .select("nombre, empresa, ruc")
      .eq("id", usuario.cliente_id)
      .single();

    const empresa      = process.env.EMPRESA_NOMBRE || "AFA Tours Peru S.A.C.";
    const fromAddr     = process.env.RESEND_FROM    || "noreply@afatoursperu.com";
    const apiKey       = process.env.RESEND_API_KEY || "";
    const nombreEmp    = cliente?.empresa || cliente?.nombre || empresa;
    const ruc          = cliente?.ruc ?? "";
    const logoSrc      = getLogoBase64();
    const tipoId       = tipo_doc || "Identificación";
    const portalUrl    = process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/cliente`
      : "https://app.afatoursperu.com/cliente";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Acceso al portal</title></head>
<body style="margin:0;padding:0;background:#F6F4EE;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <!-- Cabecera -->
        <tr>
          <td style="background:#0b315f;padding:28px 36px">
            ${logoSrc
              ? `<img src="${logoSrc}" alt="${empresa}" style="height:44px;object-fit:contain;display:block" />`
              : `<span style="font-size:20px;font-weight:900;color:white;letter-spacing:-0.5px">${empresa}</span>`}
          </td>
        </tr>

        <!-- Cuerpo -->
        <tr>
          <td style="padding:36px 36px 28px">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#9AA0AC;letter-spacing:0.1em;text-transform:uppercase">Portal Cliente · Bienvenido</p>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0A0E1A;line-height:1.25">Hola, ${usuario.nombre} 👋</h1>
            <p style="margin:0 0 28px;font-size:14.5px;color:#6B6F7C;line-height:1.65">
              Tu acceso al portal empresarial de <strong style="color:#0A0E1A">${nombreEmp}</strong> ha sido configurado.
              A continuación encontrarás tus credenciales de ingreso.
            </p>

            <!-- Credenciales -->
            <div style="background:#EAEFF6;border-radius:14px;padding:24px 28px;margin-bottom:28px">
              <p style="margin:0 0 16px;font-size:11px;font-weight:700;color:#6B6F7C;letter-spacing:0.1em;text-transform:uppercase">Tus credenciales de acceso</p>

              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #D5DDEA;width:40%">
                    <span style="font-size:12px;color:#9AA0AC;font-weight:600">RUC empresa</span>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #D5DDEA">
                    <span style="font-size:13px;color:#0A0E1A;font-weight:700;font-family:ui-monospace,monospace">${ruc || nombreEmp}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #D5DDEA">
                    <span style="font-size:12px;color:#9AA0AC;font-weight:600">${tipoId}</span>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #D5DDEA">
                    <span style="font-size:13px;color:#0A0E1A;font-weight:700;font-family:ui-monospace,monospace">${usuario.dni}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0">
                    <span style="font-size:12px;color:#9AA0AC;font-weight:600">Contraseña</span>
                  </td>
                  <td style="padding:8px 0">
                    <span style="font-size:13px;color:#0A0E1A;font-weight:700;font-family:ui-monospace,monospace">${password}</span>
                  </td>
                </tr>
              </table>
            </div>

            <!-- Botón acceso -->
            <div style="text-align:center;margin-bottom:28px">
              <a href="${portalUrl}" style="display:inline-block;padding:14px 32px;background:#0b315f;color:white;font-size:14px;font-weight:800;text-decoration:none;border-radius:12px;letter-spacing:0.02em">
                Ingresar al portal →
              </a>
              <p style="margin:10px 0 0;font-size:11px;color:#9AA0AC">${portalUrl}</p>
            </div>

            <p style="margin:0;font-size:12px;color:#9AA0AC;line-height:1.7;background:#F6F4EE;border-radius:10px;padding:14px 16px">
              🔒 Guarda estas credenciales en un lugar seguro. Si necesitas cambiar tu contraseña,
              usa la opción "¿Olvidaste tu contraseña?" en la pantalla de inicio.
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

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:    fromAddr,
        to:      usuario.email,
        subject: `Tus credenciales de acceso al portal — ${nombreEmp}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error("Resend error:", errBody);
      return NextResponse.json({ error: "Error al enviar email" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, email: usuario.email });

  } catch (err: any) {
    console.error("enviar-credenciales error:", err);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
