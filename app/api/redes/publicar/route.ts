// app/api/redes/publicar/route.ts
// Despacha la publicación del día a las redes.
//   • GET  → cron de Vercel. Fail-closed con CRON_SECRET.
//   • POST → botón «Publicar ahora» de /redes (permiso del módulo).
//
// EL CRON CORRE VARIAS VECES, Y ESO ES PARTE DEL DISEÑO. El motor devuelve
// `fuera_de_horario` hasta que llega la hora y `ya_publicada` después, así que un tick
// de más no publica de más — y un tick de más es lo que recoge el día en que Instagram
// devolvió un 500 a las 08:00. Un cron de una sola pasada dejaría el post sin salir sin
// que nadie se enterara hasta el día siguiente.

import { NextRequest, NextResponse } from "next/server";
import { despacharFecha, despacharHoy } from "@/lib/redes/despachar";
import { leerConfig } from "@/lib/redes/ia";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { hoyLima } from "@/lib/alertas";

// Instagram sondea su contenedor de video hasta ~48 s, y pueden encadenarse dos redes.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({}));
    const r = await despacharFecha(body?.fecha || hoyLima(), {
      // «Publicar ahora» adelanta la HORA, nunca la aprobación: el motor sigue exigiendo
      // que una persona haya firmado. Sin eso este botón sería la puerta trasera que
      // deja sin efecto el trato del módulo.
      forzarHora: body?.ahora === true,
    });
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[redes/publicar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const cfg = await leerConfig();
    if (!cfg?.activo) {
      return NextResponse.json({ ok: true, omitido: "El agente de redes está apagado en /redes → Ajustes." });
    }
    const r = await despacharHoy();
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[redes/publicar cron]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
