// app/api/combustible/facturas/documento/route.ts — El DOCUMENTO de una factura del correo, para
// revisarlo sin salir de la pantalla (lib/combustible/factura-de-carga.ts).
//
//   GET ?id=<radar_facturas.id> → el PDF del comprobante (o su XML, como texto), bajado del correo con
//        la credencial del ERP. No se guarda nada.
//   GET ?buzon=1                → qué buzón se lee hoy, para abrir sus correos en ESA cuenta de Gmail.
//
// Lo piden /radar-ia (el recuadro de fusión y la recarga que una factura espera) y /combustible
// (Facturas y Cargas por completar): pasa con el permiso de cualquiera de los dos. Un enlace no lleva
// la sesión, así que la pantalla lo pide con fetch + Bearer y lo enseña desde un blob.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { buzonDeFacturas, documentoDeFactura } from "@/lib/combustible/facturas-correo";
import { tipoParaMostrar } from "@/lib/combustible/factura-de-carga";

export const maxDuration = 60;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, ["combustible", "radar-ia"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const sb = admin();
  try {
    if (url.searchParams.get("buzon")) return NextResponse.json({ ok: true, ...(await buzonDeFacturas(sb)) });
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "Falta la factura." }, { status: 400 });
    const d = await documentoDeFactura(sb, id);
    if (!d.ok) return NextResponse.json({ ok: false, error: d.error }, { status: d.status });
    return new NextResponse(new Uint8Array(d.data), {
      status: 200,
      headers: {
        // Un XML va como TEXTO (tipoParaMostrar): abierto como documento correría lo que traiga dentro.
        "Content-Type": tipoParaMostrar(d.tipo),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(d.nombre)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "X-Documento-Tipo": d.tipo,
        "X-Documento-Nombre": encodeURIComponent(d.nombre),
      },
    });
  } catch (e) {
    console.error("[combustible/facturas/documento]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string } | null)?.message ?? String(e) }, { status: 500 });
  }
}
