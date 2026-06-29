// app/api/mantenimiento/leer-plan/route.ts
// Recibe la foto/PDF del plan del fabricante y devuelve el plan estructurado
// para que el operador lo revise/corrija antes de guardarlo.

import { NextRequest, NextResponse } from "next/server";
import { extraerPlanFabricante, type Adjunto } from "@/lib/vision-ia";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { adjuntos } = await req.json();
    if (!Array.isArray(adjuntos) || adjuntos.length === 0) {
      return NextResponse.json({ ok: false, error: "Falta el documento del plan" }, { status: 400 });
    }
    const plan = await extraerPlanFabricante(adjuntos as Adjunto[]);
    return NextResponse.json({ ok: true, plan });
  } catch (e: any) {
    console.error("[mantenimiento/leer-plan]", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error al leer el plan" }, { status: 500 });
  }
}
