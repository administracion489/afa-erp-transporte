import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { vistaPreviaInstrucciones } from "@/lib/crm-ia";

// Lo que /crm/agente no puede saber desde el navegador: si el servidor tiene la clave de
// transcripción, y las instrucciones exactas que recibe la IA con lo guardado.
export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  let instrucciones: string | null = null;
  try { instrucciones = await vistaPreviaInstrucciones(); } catch { /* sin agente */ }
  return NextResponse.json({
    ok: true,
    transcripcion: !!process.env.OPENAI_API_KEY,
    ia: !!process.env.ANTHROPIC_API_KEY,
    instrucciones,
  });
}
