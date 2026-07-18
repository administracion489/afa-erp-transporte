// app/api/registro/route.ts
// Recibe la ficha del formulario público /registro y la inserta en
// solicitudes_cliente con service_role: RLS bloquea el INSERT anónimo directo
// que hacía antes el navegador. Whitelist de columnas y estado forzado a
// "pendiente" para que el body no pueda escribir nada fuera de la ficha.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CAMPOS = [
  "tipo_doc", "num_doc", "razon_social", "nombre_comercial", "tipo_empresa",
  "rubro", "web", "direccion", "distrito", "provincia", "departamento",
  "email_facturacion", "contactos_administrativos", "contactos_operativos",
  "tipo_cliente", "condicion_pago", "moneda", "tipo_comprobante",
  "volumen_compra", "servicios_interes", "como_nos_conocio", "observaciones",
  "acepta_terminos", "acepta_comunicaciones",
] as const;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const ficha = body?.solicitud;
    if (!ficha || typeof ficha !== "object") {
      return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
    }
    if (!String(ficha.razon_social ?? "").trim() || !String(ficha.num_doc ?? "").trim()) {
      return NextResponse.json({ error: "Razón social y documento son obligatorios" }, { status: 400 });
    }
    const fila: Record<string, unknown> = { estado: "pendiente" };
    for (const k of CAMPOS) if (k in ficha) fila[k] = ficha[k];

    const { error } = await admin.from("solicitudes_cliente").insert(fila);
    if (error) {
      console.error("[api/registro]", error.message);
      return NextResponse.json({ error: "No se pudo registrar la solicitud" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[api/registro]", e?.message);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
