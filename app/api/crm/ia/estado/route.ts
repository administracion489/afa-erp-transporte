import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { trasladosActivosIA, vistaPreviaInstrucciones } from "@/lib/crm-ia";

// Lo que /crm/agente no puede saber desde el navegador: si el servidor tiene la clave de
// transcripción, las instrucciones exactas que recibe la IA con lo guardado, y si la IA cotiza
// traslados (`traslados`: true / false, o null si no se pudo leer — el auditor de la pantalla solo
// afirma lo de traslados con true, lib/crm-ia-coherencia.ts).
export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const [instrucciones, traslados] = await Promise.all([
    vistaPreviaInstrucciones().catch(() => null), // sin agente
    trasladosActivosIA(),
  ]);
  return NextResponse.json({
    ok: true,
    transcripcion: !!process.env.OPENAI_API_KEY,
    ia: !!process.env.ANTHROPIC_API_KEY,
    instrucciones,
    traslados,
  });
}
