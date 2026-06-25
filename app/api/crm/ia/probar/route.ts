import { NextRequest, NextResponse } from "next/server";
import { probarAgente } from "@/lib/crm-ia";

export const maxDuration = 60;

// Prueba el agente con un mensaje suelto (no envía nada al cliente).
export async function POST(req: NextRequest) {
  try {
    const { mensaje } = await req.json();
    if (!mensaje?.trim()) return NextResponse.json({ ok: false, error: "Falta mensaje" }, { status: 400 });
    const r = await probarAgente(mensaje.trim());
    return NextResponse.json(r, { status: r.ok ? 200 : 207 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
