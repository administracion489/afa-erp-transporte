// app/api/notificaciones/proveedores-documentos/route.ts
// Vercel Cron diario: avisa a cada proveedor (empresa tercerizada) cuando alguno de sus
// documentos obligatorios está por vencer o ya venció, con el link de autoservicio para
// subirlo (ver lib/proveedor-documentos.ts). No actualiza nada en documentos_tercero — eso
// solo pasa cuando un operador aprueba lo que el proveedor suba, desde /tercerizadas.
//
// Auth: Bearer CRON_SECRET. ?force=1 ignora la regla de "día gatillo" (para pruebas).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { documentosPorVencerDeEmpresa, esDiaGatillo, enviarAvisoProveedor } from "@/lib/proveedor-documentos";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function GET(req: NextRequest) { return handler(req); }
export async function POST(req: NextRequest) { return handler(req); }

async function handler(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const { data: cfg } = await admin.from("config_proveedores_docs").select("*").eq("id", 1).maybeSingle();
    if (cfg && cfg.activo === false) {
      return NextResponse.json({ ok: true, mensaje: "Módulo desactivado" });
    }

    const { data: empresas } = await admin
      .from("empresas_tercerizadas")
      .select("id, razon_social, email, telefono, contacto_nombre, contacto_telefono, venc_autorizacion, estado")
      .neq("estado", "inactivo");

    if (!empresas || empresas.length === 0) {
      return NextResponse.json({ ok: true, empresas: 0, mensaje: "Sin proveedores activos" });
    }

    const inicioHoy = new Date();
    inicioHoy.setUTCHours(0, 0, 0, 0);

    const resultados: any[] = [];
    let avisados = 0;

    for (const emp of empresas) {
      const items = await documentosPorVencerDeEmpresa(admin, emp);
      if (!items.length) continue;

      const enGatillo = force ? items : items.filter(it => esDiaGatillo(it.dias));
      if (!enGatillo.length) continue;

      // Dedupe: ya se avisó HOY alguno de estos claveDoc para esta empresa.
      const claves = enGatillo.map(it => it.claveDoc);
      const { data: yaAvisados } = await admin
        .from("documentos_tercero_avisos")
        .select("clave_doc")
        .eq("empresa_id", emp.id)
        .in("clave_doc", claves)
        .gte("creado_en", inicioHoy.toISOString());
      const clavesAvisadasHoy = new Set((yaAvisados || []).map((a: any) => a.clave_doc));
      const pendientes = force ? enGatillo : enGatillo.filter(it => !clavesAvisadasHoy.has(it.claveDoc));
      if (!pendientes.length) continue;

      if (!emp.email?.trim() && !emp.contacto_telefono?.trim() && !emp.telefono?.trim()) {
        resultados.push({ empresa: emp.razon_social, items: pendientes.length, canal: "sin_canal" });
        continue;
      }

      const res = await enviarAvisoProveedor(admin, emp, pendientes);
      avisados++;
      resultados.push({ empresa: emp.razon_social, items: pendientes.length, ...res });
    }

    return NextResponse.json({ ok: true, empresas: empresas.length, avisados, detalle: resultados });
  } catch (error: any) {
    console.error("[notificaciones/proveedores-documentos]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
