// app/api/redes/proponer/route.ts
// Redacta la propuesta del día.
//   • GET  → cron de Vercel (06:00 Lima). Fail-closed con CRON_SECRET.
//   • POST → botón «Proponer» / «Proponer otro» de /redes (permiso del módulo).
//
// Se propone TEMPRANO y se publica más tarde a propósito: entre las dos horas está el
// rato en que una persona la lee. Proponer y publicar en el mismo tick convertiría la
// aprobación en un trámite imposible de cumplir, y la aprobación es el trato del módulo.

import { NextRequest, NextResponse } from "next/server";
import { proponerPublicacion, leerConfig } from "@/lib/redes/ia";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { lineasValidas } from "@/lib/redes/lineas";
import { hoyLima } from "@/lib/alertas";

// Redactar con thinking adaptativo puede pasar de los 10 s por defecto.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({}));
    const r = await proponerPublicacion({
      fecha: body?.fecha || hoyLima(),
      instruccion: body?.instruccion,
      // Si el operador eligió línea, manda sobre la rotación: la rotación existe para
      // cuando nadie decide, no para pisar a quien decidió.
      linea: lineasValidas([body?.linea])[0],
      // Desde el botón siempre se rehace: es justo para lo que existe.
      rehacer: body?.rehacer !== false,
    });
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e: any) {
    console.error("[redes/proponer]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Fail-closed: sin CRON_SECRET el endpoint —que gasta tokens de Claude— queda cerrado.
  // Mismo criterio que /api/comunicados/procesar.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const cfg = await leerConfig();
    // El interruptor general. Apagado, el cron no gasta ni un token — y lo DICE, en vez
    // de devolver un 200 vacío que parece que funcionó.
    if (!cfg?.activo) {
      return NextResponse.json({ ok: true, omitido: "El agente de redes está apagado en /redes → Ajustes." });
    }
    const r = await proponerPublicacion({ fecha: hoyLima() });
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[redes/proponer cron]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
