// app/api/radar/reprocesar/route.ts — re-analiza mensajes desde el dashboard.
// Auth: usuario del ERP con permiso del módulo radar-ia (Bearer del cliente Supabase).
//
//   { mensaje_id }                      → UNO, con su ráfaga (las fotos que se fundieron en él).
//   { fallidos: true, desde?, despues_de? } → EN LOTE, los que fallaron (FILTRO_FALLIDOS), del más
//                                          viejo al más nuevo, por tandas de ~2.5 min: la pantalla
//                                          vuelve a llamar con `despues_de` mientras `quedan > 0`.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { reprocesarMensaje, reprocesarFallidos } from "@/lib/radar/motor";

export const maxDuration = 300;

/** Por defecto, lo que falló en los últimos 60 días: cubre las tres semanas sin guardar (14/09→06/10). */
const DIAS_FALLIDOS = 60;

const fechaValida = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
const tsValido = (v: unknown): string | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "radar-ia");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
    }
    const body = await req.json();

    if (body?.fallidos === true) {
      const desde =
        fechaValida(body?.desde) ??
        new Date(Date.now() - 5 * 3600 * 1000 - DIAS_FALLIDOS * 86_400_000).toISOString().slice(0, 10);
      const r = await reprocesarFallidos({ desde, despuesDe: tsValido(body?.despues_de) });
      return NextResponse.json({ ok: true, desde, ...r });
    }

    const mensajeId = String(body?.mensaje_id ?? "");
    if (!mensajeId) return NextResponse.json({ error: "Falta mensaje_id" }, { status: 400 });
    const resumen = await reprocesarMensaje(mensajeId);
    return NextResponse.json({ ok: true, ...resumen });
  } catch (error: any) {
    console.error("[radar/reprocesar]", error);
    return NextResponse.json({ error: error?.message ?? "Error interno" }, { status: 500 });
  }
}
