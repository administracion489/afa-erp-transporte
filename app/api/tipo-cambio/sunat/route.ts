// app/api/tipo-cambio/sunat/route.ts
// Trae el tipo de cambio del día de SUNAT y lo guarda en `tipo_cambio` (lib/tipo-cambio-sunat.ts).
//   GET  — cron diario (vercel.json), con CRON_SECRET.
//   POST — botón «Actualizar ahora» de /tarifario → Zonas y traslados → Ajustes (usuario del ERP).
// Idempotente: una segunda lectura del mismo día reescribe la misma fila (fecha, moneda).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado, verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { limitarTasa } from "@/lib/api-guard";
import { obtenerTipoCambioSunat } from "@/lib/tipo-cambio-sunat";

export const dynamic = "force-dynamic";

async function actualizar() {
  const r = await obtenerTipoCambioSunat();
  if (!r.ok) {
    console.error("[tipo-cambio/sunat]", r.detalle);
    return NextResponse.json({ ok: false, detalle: `No se pudo leer el tipo de cambio: ${r.detalle}` }, { status: 502 });
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await sb.from("tipo_cambio").upsert(
    { fecha: r.tc.fecha, moneda: "USD", compra: r.tc.compra, venta: r.tc.venta, fuente: r.tc.fuente },
    { onConflict: "fecha,moneda" },
  );
  if (error) {
    console.error("[tipo-cambio/sunat] guardar:", error.message);
    return NextResponse.json({ ok: false, detalle: "Se leyó el tipo de cambio pero no se pudo guardar." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...r.tc });
}

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ ok: false, detalle: "No autorizado" }, { status: 401 });
  return actualizar();
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, ["tarifas", "cotizaciones"]);
  if (!auth.ok) return NextResponse.json({ ok: false, detalle: auth.error }, { status: auth.status });
  // Un botón: tres por minuto por persona bastan, y no se le martilla la página a SUNAT.
  if (!limitarTasa(`tc-sunat:${auth.userId}`, 3, 60_000)) {
    return NextResponse.json({ ok: false, detalle: "Espera un minuto antes de volver a actualizar." }, { status: 429 });
  }
  return actualizar();
}
