// app/api/facturas/leer/route.ts
// Lee una factura de proveedor (XML UBL o PDF/imagen) y la devuelve estructurada para
// revisión humana. Espejo de mantenimiento/leer-odometro. Opcionalmente concilia contra
// la BD (enriquecer, no duplicar) si se pasa { conciliar: true } y hay service-role.
//
// Body:
//   { xml: "<Invoice>…" }                                  → parseo UBL (preferido)
//   { adjunto: { tipo: "pdf"|"image", media_type, data } } → visión Claude (respaldo)
//   { conciliar?: boolean }                                → además concilia en BD

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseUblFactura, extraerFacturaPdf, conciliarFactura, type AdjuntoFactura } from "@/lib/contabilidad/factura-ia";

export const maxDuration = 40;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let extraida;

    if (typeof body.xml === "string" && body.xml.includes("<")) {
      extraida = parseUblFactura(body.xml);
    } else if (body.adjunto?.data) {
      extraida = await extraerFacturaPdf(body.adjunto as AdjuntoFactura);
    } else {
      return NextResponse.json({ ok: false, error: "Envía { xml } o { adjunto:{tipo,media_type,data} }" }, { status: 400 });
    }

    let conciliacion = null;
    if (body.conciliar === true) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        return NextResponse.json({ ok: true, extraida, conciliacion: null, aviso: "Sin SUPABASE_SERVICE_ROLE_KEY: no se concilió (solo lectura)." });
      }
      const sb = createClient(url, key, { auth: { persistSession: false } });
      conciliacion = await conciliarFactura(sb, extraida);
    }

    return NextResponse.json({ ok: true, extraida, conciliacion });
  } catch (e: any) {
    console.error("[facturas/leer]", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error al leer la factura" }, { status: 500 });
  }
}
