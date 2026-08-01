// app/api/comunicados/audiencia/route.ts
// Conteo de audiencia para la vista previa del composer: cuántos pasajeros de la
// empresa, cuántos con teléfono (WhatsApp) y cuántos con correo. Requiere permiso
// del módulo "comunicados". Se usa POST para no exponer el cliente_id en la URL.

import { NextRequest, NextResponse } from "next/server";
import { contarAudiencia } from "@/lib/comunicados";
import { verificarUsuarioApi } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "comunicados");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { cliente_id, solo_nomina_fija = true } = await req.json();
    if (!cliente_id) return NextResponse.json({ error: "cliente_id requerido" }, { status: 400 });

    const conteo = await contarAudiencia(Number(cliente_id), solo_nomina_fija !== false);
    return NextResponse.json(conteo);
  } catch (e: any) {
    console.error("[comunicados/audiencia]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
