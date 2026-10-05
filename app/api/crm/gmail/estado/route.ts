import { NextRequest, NextResponse } from "next/server";
import { estadoGmailCrm, origenPublico } from "@/lib/crm-gmail";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";

// GET /api/crm/gmail/estado — qué buzón está conectado al CRM, cuándo se leyó por última vez y
// qué falló, SIN llamar a Google (el cron cada 10 min mantiene fresco el último error). Es lo
// que faltaba para contestar «¿por qué no entran los correos?» sin mirar la base. Con la
// dirección desde la que se abrió la pantalla dice además el valor EXACTO de GOOGLE_REDIRECT_URI.
export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, ["crm", "configuracion"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json({ ok: true, ...(await estadoGmailCrm(undefined, { origen: origenPublico(req) })) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
