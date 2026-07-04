// ============================================================
// GET /api/elia/radar — Avisos proactivos de ELIA.
// El panel lo consulta al abrir para el saludo y el punto de alerta
// del botón flotante. Respeta los permisos del usuario.
// ============================================================
import { NextResponse } from "next/server";
import { autenticarElia } from "@/lib/elia/auth";
import { calcularRadar } from "@/lib/elia/herramientas";

export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await autenticarElia(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const items = await calcularRadar(auth.usuario.sb, auth.usuario.permisos, auth.usuario.rol);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, items: [], error: e?.message }, { status: 200 });
  }
}
