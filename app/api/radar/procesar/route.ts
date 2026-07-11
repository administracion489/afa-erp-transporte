// app/api/radar/procesar/route.ts — procesa mensajes pendientes del Radar IA con ELIA.
// POST: lo dispara el worker (radar-worker/) apenas inserta mensajes nuevos.
//       Bearer RADAR_WORKER_SECRET (fail-closed: sin secreto configurado no procesa).
// GET:  cron de barrido (vercel.json) que recoge lo que el trigger no alcanzó
//       (worker caído, timeout, fuera de horario). Bearer CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { procesarPendientes } from "@/lib/radar/motor";

export const maxDuration = 300;

async function handler(req: NextRequest, limite: number, soloMensajeId?: string) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
    }
    const resumen = await procesarPendientes({ limite, soloMensajeId });
    return NextResponse.json({ ok: true, ...resumen });
  } catch (error: any) {
    console.error("[radar/procesar]", error);
    return NextResponse.json({ error: error?.message ?? "Error interno" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secreto = process.env.RADAR_WORKER_SECRET;
  if (!secreto) {
    return NextResponse.json({ error: "Falta configurar RADAR_WORKER_SECRET" }, { status: 500 });
  }
  if (auth !== `Bearer ${secreto}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  let limite = 20;
  try {
    const body = await req.json();
    if (Number.isFinite(Number(body?.limite))) limite = Math.min(50, Math.max(1, Number(body.limite)));
  } catch {
    // sin body: usar el límite por defecto
  }
  return handler(req, limite);
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  return handler(req, 30);
}
