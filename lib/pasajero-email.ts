// lib/pasajero-email.ts
// Correo "credenciales de acceso a la app" del pasajero (DNI + PIN). Compartido por
// /api/pasajeros/credenciales (reenvío manual) y /api/pasajeros/invitacion (envío automático al crear).

async function enviarEmailResend({ to, subject, html }: { to: string; subject: string; html: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY no configurada");
  const from = process.env.RESEND_FROM ?? "AFA Transporte <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error(await res.text());
}

function buildCredencialesHtml(p: {
  nombre: string;
  dni: string;
  empresa: string | null;
  pin: string;
  empresa_afa: string;
  baseUrl: string;
}): string {
  const { nombre, dni, empresa, pin, empresa_afa, baseUrl } = p;
  const playStore = "https://play.google.com/store/apps/details?id=com.transportesafa.pasajero";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Acceso a la App del Pasajero</title>
</head>
<body style="margin:0;padding:0;background:#dce6f5;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#dce6f5;">
  <tr>
    <td align="center" style="padding:32px 12px 48px;">

      <table width="580" cellpadding="0" cellspacing="0" border="0"
             style="max-width:580px;width:100%;border-radius:20px;overflow:hidden;
                    box-shadow:0 12px 56px rgba(7,31,61,.22);">

        <!-- ── 1. HEADER: logo sobre navy puro ── -->
        <tr>
          <td align="center"
              style="background:#071f3d;padding:30px 32px 24px;">
            <img src="${baseUrl}/Logoafapasajeros3.png"
                 alt="AFA Pasajero"
                 width="240" height="auto"
                 style="display:block;margin:0 auto;max-width:240px;" />
          </td>
        </tr>

        <!-- ── 2. BANDA DORADA separadora ── -->
        <tr>
          <td style="background:#f59e0b;height:4px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- ── 3. HERO: nombre + empresa, todo en blanco ── -->
        <tr>
          <td align="center"
              style="background:linear-gradient(180deg,#0b315f 0%,#1352a0 100%);
                     padding:40px 36px 36px;">
            <p style="margin:0 0 6px 0;color:#7dd3fc;font-size:10px;font-weight:700;
                       letter-spacing:3px;text-transform:uppercase;">
              BIENVENIDO AL SERVICIO
            </p>
            <h1 style="margin:0 0 4px 0;color:#ffffff;font-size:30px;font-weight:800;
                        line-height:1.15;">
              Hola, <span style="color:#fbbf24;">${nombre}</span>
            </h1>
            <!-- separador dorado -->
            <div style="width:48px;height:3px;background:#f59e0b;margin:18px auto 20px;
                        border-radius:2px;"></div>
            <p style="margin:0 0 10px 0;color:#ffffff;font-size:16px;font-weight:800;
                       line-height:1.3;">
              ${empresa || empresa_afa}
            </p>
            <p style="margin:0;color:#ffffff;font-size:14px;font-weight:400;line-height:1.7;">
              ha contratado el servicio de
              <strong style="color:#fbbf24;">transporte corporativo</strong>
              con ${empresa_afa} especialmente para ti.
            </p>
          </td>
        </tr>

        <!-- ── 4. BENEFICIOS ── -->
        <tr>
          <td style="background:#ffffff;padding:36px 24px 32px;">
            <p style="margin:0 0 24px 0;text-align:center;font-size:10px;font-weight:700;
                       color:#94a3b8;letter-spacing:2.5px;text-transform:uppercase;">
              ¿QUÉ PUEDES HACER CON LA APP?
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>

                <!-- Beneficio 1 -->
                <td width="33%" align="center" style="padding:0 5px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#eff6ff;border-radius:14px;padding:22px 10px;">
                        <div style="width:44px;height:44px;border-radius:12px;
                                    background:#0b315f;margin:0 auto 12px;
                                    font-size:22px;line-height:44px;text-align:center;">
                          &#128506;
                        </div>
                        <p style="margin:0 0 6px 0;font-size:12px;font-weight:800;
                                   color:#0b315f;line-height:1.3;">
                          Ruta en<br/>tiempo real
                        </p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.5;">
                          Sigue el bus en el mapa en vivo
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

                <!-- Beneficio 2 -->
                <td width="33%" align="center" style="padding:0 5px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#f0fdf4;border-radius:14px;padding:22px 10px;">
                        <div style="width:44px;height:44px;border-radius:12px;
                                    background:#166534;margin:0 auto 12px;
                                    font-size:22px;line-height:44px;text-align:center;">
                          &#9646;&#9646;
                        </div>
                        <p style="margin:0 0 6px 0;font-size:12px;font-weight:800;
                                   color:#166534;line-height:1.3;">
                          QR de<br/>abordaje
                        </p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.5;">
                          Tu pase digital sin papeles
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

                <!-- Beneficio 3 -->
                <td width="33%" align="center" style="padding:0 5px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#fff7ed;border-radius:14px;padding:22px 10px;">
                        <div style="width:44px;height:44px;border-radius:12px;
                                    background:#c2410c;margin:0 auto 12px;
                                    font-size:22px;line-height:44px;text-align:center;">
                          &#128205;
                        </div>
                        <p style="margin:0 0 6px 0;font-size:12px;font-weight:800;
                                   color:#9a3412;line-height:1.3;">
                          Tu parada<br/>y horario
                        </p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.5;">
                          Hora exacta en tu paradero
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

              </tr>
            </table>
          </td>
        </tr>

        <!-- ── 5. CTA DESCARGA ── -->
        <tr>
          <td align="center"
              style="background:#f8fafc;padding:32px 28px 28px;
                     border-top:1px solid #e2e8f0;">
            <img src="${baseUrl}/icon-afa-pasajero.png"
                 alt="AFA Pasajero App" width="68" height="68"
                 style="border-radius:16px;display:block;margin:0 auto 16px;
                        box-shadow:0 4px 18px rgba(11,49,95,.20);" />
            <p style="margin:0 0 16px;font-size:13px;color:#64748b;font-weight:600;">
              Descarga la app y activa tu acceso
            </p>
            <a href="${playStore}"
               style="display:inline-block;
                      background:#16a34a;
                      color:#ffffff;text-decoration:none;
                      padding:14px 38px;border-radius:50px;
                      font-size:15px;font-weight:800;letter-spacing:.3px;
                      box-shadow:0 6px 22px rgba(22,163,74,.38);">
              &#9654;&nbsp;&nbsp;Descargar en Play Store
            </a>
            <p style="margin:10px 0 0;font-size:11px;color:#94a3b8;">
              Disponible para Android
            </p>
          </td>
        </tr>

        <!-- ── 6. CREDENCIALES ── -->
        <tr>
          <td style="background:#f8fafc;padding:0 28px 36px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:linear-gradient(135deg,#071f3d 0%,#0b315f 50%,#1352a0 100%);
                            border-radius:16px;padding:28px 28px 24px;">

                  <p style="margin:0 0 20px 0;color:#7dd3fc;font-size:10px;font-weight:700;
                             letter-spacing:3px;text-transform:uppercase;text-align:center;">
                    TUS DATOS DE ACCESO
                  </p>

                  <!-- DNI -->
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:0 0 16px;border-bottom:1px solid rgba(255,255,255,.12);">
                        <p style="margin:0 0 6px;color:#93c5fd;font-size:11px;font-weight:700;
                                   letter-spacing:1.5px;text-transform:uppercase;">
                          DNI / Usuario
                        </p>
                        <p style="margin:0;color:#ffffff;font-family:'Courier New',monospace;
                                   font-size:28px;font-weight:800;letter-spacing:7px;">
                          ${dni}
                        </p>
                      </td>
                    </tr>
                    <!-- PIN -->
                    <tr>
                      <td style="padding:16px 0 0;">
                        <p style="margin:0 0 6px;color:#93c5fd;font-size:11px;font-weight:700;
                                   letter-spacing:1.5px;text-transform:uppercase;">
                          PIN de acceso
                        </p>
                        <p style="margin:0 0 8px;color:#fbbf24;
                                   font-family:'Courier New',monospace;
                                   font-size:48px;font-weight:900;letter-spacing:16px;
                                   line-height:1;">
                          ${pin}
                        </p>
                        <p style="margin:0;color:#7dd3fc;font-size:11px;line-height:1.5;">
                          Si no funciona, prueba con los &#250;ltimos 4 d&#237;gitos de tu DNI
                        </p>
                      </td>
                    </tr>
                  </table>

                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── 7. FOOTER ── -->
        <tr>
          <td style="background:#071f3d;padding:20px 24px 22px;text-align:center;">
            <img src="${baseUrl}/Logoafapasajeros3.png"
                 alt="AFA Transporte" width="110" height="auto"
                 style="display:block;margin:0 auto 10px;opacity:.4;" />
            <p style="margin:0 0 3px;color:#64748b;font-size:11px;">
              Servicio operado por <strong style="color:#94a3b8;">${empresa_afa}</strong>
            </p>
            <p style="margin:0;color:#334155;font-size:10px;">
              Correo generado autom&#225;ticamente &middot; No responder
            </p>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Envía el correo de credenciales (DNI + PIN) a un pasajero. Lanza si falla — el llamador decide cómo contar errores. */
export async function enviarCredencialEmailPasajero(p: {
  nombre: string;
  dni: string | null;
  email: string;
  pin_acceso: string | null;
  empresa: string | null;
}): Promise<void> {
  const empresa_afa = process.env.EMPRESA_NOMBRE ?? "AFA Transporte";
  const baseUrl     = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com";
  const pin = p.pin_acceso || String(p.dni ?? "").slice(-4) || "----";

  await enviarEmailResend({
    to: p.email,
    subject: `${empresa_afa} · Tus credenciales de acceso a la app`,
    html: buildCredencialesHtml({ nombre: p.nombre, dni: p.dni ?? "", empresa: p.empresa, pin, empresa_afa, baseUrl }),
  });
}
