// app/api/mantenimiento/leer-odometro/route.ts
// Recibe la foto del odómetro y devuelve el km leído (para pre-llenar el form).

import { NextRequest, NextResponse } from "next/server";
import { extraerOdometro, type Adjunto } from "@/lib/vision-ia";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { adjunto } = await req.json();
    if (!adjunto?.data) {
      return NextResponse.json({ ok: false, error: "Falta la foto del odómetro" }, { status: 400 });
    }
    const r = await extraerOdometro(adjunto as Adjunto);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    console.error("[mantenimiento/leer-odometro]", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error al leer el odómetro" }, { status: 500 });
  }
}
