// app/api/mantenimiento/leer-odometro/route.ts
// Recibe la foto del odómetro y devuelve el km leído (para pre-llenar el form).
// Antes de mirar la foto carga las correcciones que el equipo hizo sobre lecturas
// anteriores (odometro_correcciones) y se las pasa a la IA como ejemplos, para que
// no repita el mismo error de lectura. Si esa carga falla, se lee igual (sin lecciones).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { extraerOdometro, type Adjunto } from "@/lib/vision-ia";
import { leccionesOdometro } from "@/lib/odometro";

export const maxDuration = 30;

async function cargarLecciones(): Promise<string> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return "";
    const admin = createClient(url, key, { auth: { persistSession: false } });
    return await leccionesOdometro(admin);
  } catch (e) {
    console.warn("[leer-odometro] sin lecciones:", e);
    return "";
  }
}

export async function POST(req: NextRequest) {
  try {
    const { adjunto } = await req.json();
    if (!adjunto?.data) {
      return NextResponse.json({ ok: false, error: "Falta la foto del odómetro" }, { status: 400 });
    }
    const lecciones = await cargarLecciones();
    const r = await extraerOdometro(adjunto as Adjunto, lecciones);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    console.error("[mantenimiento/leer-odometro]", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error al leer el odómetro" }, { status: 500 });
  }
}
