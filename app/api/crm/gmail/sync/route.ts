import { NextRequest, NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/crm-gmail";
import { esCronAutorizado, verificarUsuarioApi } from "@/lib/api-auth";

// Una recuperación de varios días son hasta 100 correos con su lectura cada uno.
export const maxDuration = 120;

// La respuesta dice CUÁNTOS correos entraron, de QUÉ buzón y en qué modo se leyó; y el error,
// con su arreglo (lib/crm-gmail-reglas.ts → explicarErrorGoogle). Antes devolvía solo `nuevos`
// y la pantalla tiraba el mensaje del error: «Error al sincronizar Gmail» no dice si falta
// conectar, si caducó el permiso o si la API está apagada.
async function sincronizar() {
  try {
    const r = await syncGmailInbox();
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
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
