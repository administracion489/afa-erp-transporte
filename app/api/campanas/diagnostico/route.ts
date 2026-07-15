// app/api/campanas/diagnostico/route.ts
// Diagnóstico de SOLO LECTURA del estado real del número en Meta: platform_type,
// verificación, calidad, tier de mensajería. Mismo método usado para diagnosticar
// el #133010 del número del CRM — evita adivinar a ciegas.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";

const GRAPH = "https://graph.facebook.com/v25.0";

const PHONE_ID: Record<string, string | undefined> = {
  crm:    process.env.META_PHONE_NUMBER_ID,
  avisos: process.env.META_PHONE_NUMBER_ID_AVISOS,
};

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const numero = req.nextUrl.searchParams.get("numero") === "crm" ? "crm" : "avisos";
  const phoneId = PHONE_ID[numero];
  const token = process.env.META_WA_TOKEN;
  if (!token) return NextResponse.json({ error: "META_WA_TOKEN no configurado" }, { status: 400 });
  if (!phoneId) return NextResponse.json({ error: `Falta el Phone Number ID de "${numero}"` }, { status: 400 });

  try {
    const res = await fetch(
      `${GRAPH}/${phoneId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type,code_verification_status,quality_rating,status,messaging_limit_tier,name_status`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data.error?.message ?? "Error Meta" }, { status: 500 });
    return NextResponse.json({ numero, phoneId, ...data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
