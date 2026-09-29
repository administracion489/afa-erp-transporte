import { NextRequest, NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/crm-gmail";
import { esCronAutorizado, verificarUsuarioApi } from "@/lib/api-auth";

async function sincronizar() {
  try {
    const saved = await syncGmailInbox();
    return NextResponse.json({ ok: true, nuevos: saved });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// GET /api/crm/gmail/sync — Vercel cron. FAIL-CLOSED: sin CRON_SECRET no pasa nadie (antes,
// con la variable ausente, cualquiera podía disparar la sincronización).
export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  return sincronizar();
}

// POST /api/crm/gmail/sync — botón «📧↻» del inbox. Con sesión del ERP y módulo CRM.
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return sincronizar();
}
