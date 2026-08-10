// app/api/tercerizadas/notificar-rechazo/route.ts
// Aviso al proveedor cuando un operador RECHAZA el documento que subió desde
// /proveedor/[token] (ver cola de revisión en /tercerizadas). Ruta chica y aparte porque
// enviarEmail() necesita RESEND_API_KEY (secreto de servidor) — no se puede llamar desde el
// componente "use client" de /tercerizadas.

import { NextRequest, NextResponse } from "next/server";
import { enviarEmail } from "@/lib/notificaciones";
import { linkProveedor, tokenVigentePara } from "@/lib/proveedor-documentos";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = String(body.email ?? "").trim();
    const empresaId = Number(body.empresaId);
    const empresaNombre = String(body.empresaNombre ?? "");
    const tipo = String(body.tipo ?? "");
    const motivo = String(body.motivo ?? "").trim();
    if (!email || !empresaId || !tipo) {
      return NextResponse.json({ error: "Faltan datos" }, { status: 400 });
    }

    const token = await tokenVigentePara(admin, empresaId);
    const link = linkProveedor(token);
    const empresaNombreCorto = process.env.EMPRESA_NOMBRE ?? "AFA Transportes";

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#eef2f7;margin:0;padding:24px 16px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;">
  <div style="background:#991b1b;padding:20px 24px;">
    <h1 style="color:white;margin:0;font-size:18px;">📄 Documento observado</h1>
  </div>
  <div style="padding:24px;">
    <p style="color:#374151;font-size:14px;">El documento <b>${tipo}</b> que subió${empresaNombre ? ` para <b>${empresaNombre}</b>` : ""} no pudo aprobarse:</p>
    <div style="background:#fef2f2;border-left:3px solid #991b1b;padding:12px 16px;border-radius:8px;color:#991b1b;font-size:14px;margin:12px 0;">${motivo || "No se indicó un motivo específico."}</div>
    <p style="color:#374151;font-size:14px;">Por favor súbalo nuevamente corregido desde el mismo enlace:</p>
    <div style="text-align:center;margin:20px 0 8px;">
      <a href="${link}" style="background:#0b315f;color:white;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;display:inline-block;">Subir documento corregido</a>
    </div>
    <p style="color:#94a3b8;font-size:11px;margin:18px 0 0;">Mensaje automático de ${empresaNombreCorto} · No responder</p>
  </div>
</div></body></html>`;

    await enviarEmail({ to: email, subject: `📄 Documento observado — ${tipo}`, html });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
