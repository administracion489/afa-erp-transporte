import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function enviarEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
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

function buildHtml(p: {
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
<body style="margin:0;padding:0;background:#e8eef7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8eef7;min-height:100vh;">
  <tr>
    <td align="center" style="padding:28px 12px 40px;">

      <!-- ═══ WRAPPER ═══ -->
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;width:100%;border-radius:24px;overflow:hidden;
                    box-shadow:0 8px 48px rgba(11,49,95,.18);">

        <!-- ── 1. HEADER ── -->
        <tr>
          <td align="center"
              style="background:linear-gradient(150deg,#071f3d 0%,#0b315f 55%,#1352a0 100%);
                     padding:28px 32px 22px;">
            <img src="${baseUrl}/Logoafapasajeros3.png"
                 alt="AFA Transportes · App Pasajero"
                 width="260" height="auto"
                 style="display:block;margin:0 auto;max-width:260px;" />
          </td>
        </tr>

        <!-- ── 2. HERO ── -->
        <tr>
          <td style="background:linear-gradient(160deg,#0b315f 0%,#1352a0 70%,#1a6bbf 100%);
                     padding:0;overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:32px 0 24px 32px;vertical-align:middle;width:72%;">
                  <p style="margin:0 0 8px 0;color:#93c5fd;font-size:11px;font-weight:700;
                             letter-spacing:2.5px;text-transform:uppercase;">BIENVENIDO AL SERVICIO</p>
                  <h1 style="margin:0 0 14px 0;color:#ffffff;font-size:24px;font-weight:800;
                              line-height:1.25;">
                    Hola,<br/>
                    <span style="color:#fbbf24;font-size:22px;">${nombre}</span>
                  </h1>
                  <p style="margin:0;color:#bfdbfe;font-size:13.5px;line-height:1.65;">
                    <strong style="color:#ffffff;">${empresa || empresa_afa}</strong>
                    ha contratado el servicio de
                    <strong style="color:#ffffff;">transporte corporativo</strong>
                    con ${empresa_afa} especialmente para ti.
                  </p>
                </td>
                <td style="vertical-align:bottom;text-align:right;padding:0;width:28%;">
                  <img src="${baseUrl}/bussinfondo3.png"
                       alt="Bus AFA" width="110" height="auto"
                       style="display:block;margin-left:auto;opacity:.92;margin-right:-2px;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── 3. BENEFICIOS ── -->
        <tr>
          <td style="background:#ffffff;padding:32px 24px 28px;">
            <p style="margin:0 0 22px 0;text-align:center;font-size:11px;font-weight:700;
                       color:#64748b;letter-spacing:2px;text-transform:uppercase;">
              ¿QUÉ PUEDES HACER CON LA APP?
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>

                <!-- Beneficio 1 -->
                <td width="33%" align="center"
                    style="padding:0 6px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#eff6ff;border-radius:16px;padding:20px 12px;">
                        <div style="font-size:30px;line-height:1;margin-bottom:10px;">🗺️</div>
                        <p style="margin:0 0 7px 0;font-size:12px;font-weight:800;
                                   color:#0b315f;line-height:1.3;">Ruta en<br/>tiempo real</p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.45;">
                          Sigue el bus en el mapa y sabe exactamente cuándo llega a tu paradero
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

                <!-- Beneficio 2 -->
                <td width="33%" align="center"
                    style="padding:0 6px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#f0fdf4;border-radius:16px;padding:20px 12px;">
                        <div style="font-size:30px;line-height:1;margin-bottom:10px;">📱</div>
                        <p style="margin:0 0 7px 0;font-size:12px;font-weight:800;
                                   color:#166534;line-height:1.3;">QR de<br/>abordaje</p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.45;">
                          Tu pase digital para subir al bus sin papeles ni listas físicas
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

                <!-- Beneficio 3 -->
                <td width="33%" align="center"
                    style="padding:0 6px;vertical-align:top;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center"
                          style="background:#fefce8;border-radius:16px;padding:20px 12px;">
                        <div style="font-size:30px;line-height:1;margin-bottom:10px;">📍</div>
                        <p style="margin:0 0 7px 0;font-size:12px;font-weight:800;
                                   color:#854d0e;line-height:1.3;">Tu parada<br/>y horario</p>
                        <p style="margin:0;font-size:11px;color:#64748b;line-height:1.45;">
                          Consulta tu punto de recojo y la hora estimada de llegada
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>

              </tr>
            </table>
          </td>
        </tr>

        <!-- ── 4. DESCARGA + CREDENCIALES ── -->
        <tr>
          <td style="background:#f1f5f9;padding:28px 28px 32px;">

            <!-- App icon + botón -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding-bottom:22px;">
                  <img src="${baseUrl}/icon-afa-pasajero.png"
                       alt="AFA Pasajero App" width="72" height="72"
                       style="border-radius:18px;display:block;margin:0 auto 14px;
                              box-shadow:0 6px 20px rgba(11,49,95,.22);" />
                  <a href="${playStore}"
                     style="display:inline-block;background:linear-gradient(135deg,#16a34a,#15803d);
                            color:#ffffff;text-decoration:none;padding:15px 40px;
                            border-radius:50px;font-size:15px;font-weight:800;
                            letter-spacing:.4px;
                            box-shadow:0 6px 20px rgba(22,163,74,.40);">
                    &#9654;&nbsp; Descargar en Play Store
                  </a>
                  <p style="margin:10px 0 0;font-size:11px;color:#94a3b8;text-align:center;">
                    Android · AFA Transportes Pasajero
                  </p>
                </td>
              </tr>
            </table>

            <!-- Caja de credenciales -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:linear-gradient(135deg,#071f3d 0%,#0b315f 60%,#1352a0 100%);
                            border-radius:18px;padding:26px 28px;">
                  <p style="margin:0 0 18px 0;color:#93c5fd;font-size:11px;font-weight:700;
                             letter-spacing:2.5px;text-transform:uppercase;text-align:center;">
                    TUS DATOS DE ACCESO A LA APP
                  </p>

                  <!-- DNI -->
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:10px 0 10px;
                                  border-bottom:1px solid rgba(147,197,253,.2);">
                        <p style="margin:0 0 5px 0;color:#7dd3fc;font-size:11px;
                                   font-weight:700;letter-spacing:1.5px;
                                   text-transform:uppercase;">DNI / Usuario</p>
                        <p style="margin:0;color:#ffffff;font-family:monospace;
                                   font-size:26px;font-weight:800;letter-spacing:6px;">
                          ${dni}
                        </p>
                      </td>
                    </tr>
                    <!-- PIN -->
                    <tr>
                      <td style="padding:14px 0 4px;">
                        <p style="margin:0 0 5px 0;color:#7dd3fc;font-size:11px;
                                   font-weight:700;letter-spacing:1.5px;
                                   text-transform:uppercase;">PIN de acceso</p>
                        <p style="margin:0;color:#fbbf24;font-family:monospace;
                                   font-size:42px;font-weight:900;letter-spacing:14px;
                                   line-height:1;">
                          ${pin}
                        </p>
                        <p style="margin:6px 0 0;color:#7dd3fc;font-size:11px;">
                          (si no funciona, prueba con los últimos 4 dígitos de tu DNI)
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <!-- ── 5. FOOTER ── -->
        <tr>
          <td style="background:#0f172a;padding:18px 24px 20px;text-align:center;">
            <img src="${baseUrl}/Logoafapasajeros3.png"
                 alt="AFA Transporte" width="120" height="auto"
                 style="display:block;margin:0 auto 10px;opacity:.55;" />
            <p style="margin:0 0 4px;color:#475569;font-size:11px;line-height:1.5;">
              Servicio operado por <strong style="color:#64748b;">${empresa_afa}</strong>
            </p>
            <p style="margin:0;color:#1e293b;font-size:10px;">
              Este correo fue generado automáticamente · No responder
            </p>
          </td>
        </tr>

      </table>
      <!-- ═══ END WRAPPER ═══ -->

    </td>
  </tr>
</table>
</body>
</html>`;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const pasajeroIds: number[] = body.pasajeroIds ?? [];
  if (!pasajeroIds.length)
    return NextResponse.json({ error: "pasajeroIds requerido" }, { status: 400 });

  const { data: pasajeros, error } = await supaAdmin
    .from("pasajeros")
    .select("id, nombre, dni, email, pin_acceso, empresa")
    .in("id", pasajeroIds);

  if (error || !pasajeros)
    return NextResponse.json({ error: error?.message ?? "No encontrado" }, { status: 500 });

  const empresa_afa = process.env.EMPRESA_NOMBRE ?? "AFA Transporte";
  const baseUrl     = process.env.NEXT_PUBLIC_APP_URL ?? "https://erp.afatoursperu.com";

  let enviados = 0, sinEmail = 0, errores = 0;

  for (const p of pasajeros) {
    if (!p.email) { sinEmail++; continue; }
    const pin = p.pin_acceso || String(p.dni ?? "").slice(-4) || "----";
    try {
      await enviarEmail({
        to: p.email,
        subject: `${empresa_afa} · Tus credenciales de acceso a la app`,
        html: buildHtml({ nombre: p.nombre, dni: p.dni, empresa: p.empresa, pin, empresa_afa, baseUrl }),
      });
      enviados++;
    } catch {
      errores++;
    }
  }

  return NextResponse.json({ enviados, sinEmail, errores });
}
