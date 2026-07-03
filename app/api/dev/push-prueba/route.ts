// app/api/dev/push-prueba/route.ts — Arnés de verificación del push del pasajero
// (mismo espíritu que /api/dev/gps-replay). Envía una notificación de prueba a
// TODAS las suscripciones activas de un pasajero:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<host>/api/dev/push-prueba?pasajero=<id>"
//
// Gate por header Bearer (NUNCA por query string: las URLs quedan en historial
// del navegador y logs de acceso, y este secreto también protege los crons).
// Sin CRON_SECRET configurado, el endpoint queda apagado.

import { NextRequest, NextResponse } from "next/server";
import { enviarPushAPasajeros } from "@/lib/push";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const q = req.nextUrl.searchParams;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const pasajero = Number(q.get("pasajero"));
  if (!Number.isFinite(pasajero) || pasajero <= 0) {
    return NextResponse.json({ error: "?pasajero=<id> requerido" }, { status: 400 });
  }
  const r = await enviarPushAPasajeros(
    [pasajero],
    {
      title: "🔔 Prueba de avisos AFA",
      body: "Si ves esto con la pantalla bloqueada, las notificaciones de tu bus funcionan.",
      tag: "afa-prueba",
      url: "/pasajero",
    },
    { ttl: 300, urgencia: "high" },
  );
  return NextResponse.json(r);
}
