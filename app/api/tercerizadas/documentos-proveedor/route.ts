// app/api/tercerizadas/documentos-proveedor/route.ts
// Puerta PÚBLICA por la que el proveedor (empresa tercerizada) sube sus documentos
// actualizados — igual espíritu que /api/liquidaciones/conformidad: sin sesión, la
// autorización ES el token (proveedor_tokens), largo y único por empresa.
//
//   GET  ?token=…  → documentos actuales del proveedor + lo que tiene pendiente de revisión
//   POST accion=subir → sube el archivo y lo deja en documentos_tercero_revisiones
//                        (estado "pendiente"). NO toca documentos_tercero — eso solo pasa
//                        cuando un operador aprueba desde /tercerizadas.
//
// El archivo va al bucket público "documentos" (el mismo de Mantenimiento > Planes), bajo
// `proveedores/<empresa_id>/…`. Nunca se sube desde el navegador del proveedor: siempre pasa
// por acá con service-role, así el token es la única puerta.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { estadoDoc, TIPOS_DOC_OBLIGATORIOS } from "@/lib/proveedor-documentos";
import { enviarEmail } from "@/lib/notificaciones";

export const dynamic = "force-dynamic";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const TIPOS_ARCHIVO_OK = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

async function empresaDeToken(token: string) {
  if (!token || token.length < 20) return null;
  const { data: t } = await admin
    .from("proveedor_tokens")
    .select("empresa_id, expira_en")
    .eq("token", token)
    .maybeSingle();
  if (!t) return null;
  if (new Date(t.expira_en).getTime() < Date.now()) return null;

  const { data: emp } = await admin
    .from("empresas_tercerizadas")
    .select("id, razon_social, ruc, estado")
    .eq("id", t.empresa_id)
    .maybeSingle();
  return emp || null;
}

export async function GET(req: NextRequest) {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const empresa = await empresaDeToken(token);
    if (!empresa) return NextResponse.json({ error: "Este enlace no es válido o ya expiró." }, { status: 404 });

    const [{ data: vehiculos }, { data: documentos }, { data: revisiones }] = await Promise.all([
      admin.from("vehiculos_tercero").select("id, placa").eq("empresa_id", empresa.id).order("placa"),
      admin.from("documentos_tercero").select("id, vehiculo_id, tipo, numero, fecha_vencimiento, entidad_emisora, archivo_url").eq("empresa_id", empresa.id),
      admin.from("documentos_tercero_revisiones").select("*").eq("empresa_id", empresa.id).order("creado_en", { ascending: false }).limit(30),
    ]);

    const docsConEstado = (documentos || []).map((d: any) => ({ ...d, estado: estadoDoc(d.fecha_vencimiento) }));

    return NextResponse.json({
      ok: true,
      empresa: { id: empresa.id, razon_social: empresa.razon_social, ruc: empresa.ruc },
      vehiculos: vehiculos || [],
      documentos: docsConEstado,
      revisiones: revisiones || [],
      tiposObligatorios: TIPOS_DOC_OBLIGATORIOS,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = String(body.token ?? "");
    const empresa = await empresaDeToken(token);
    if (!empresa) return NextResponse.json({ error: "Este enlace no es válido o ya expiró." }, { status: 404 });

    if (body.accion !== "subir") {
      return NextResponse.json({ error: "Acción no reconocida" }, { status: 400 });
    }

    const tipo = String(body.tipo ?? "").trim();
    if (!tipo) return NextResponse.json({ error: "Falta el tipo de documento." }, { status: 400 });

    const archivo = body.archivo;
    if (!archivo?.data) return NextResponse.json({ error: "Falta el archivo." }, { status: 400 });
    const mediaType = String(archivo.mediaType || "application/octet-stream");
    if (!TIPOS_ARCHIVO_OK.includes(mediaType)) {
      return NextResponse.json({ error: "Formato no admitido. Sube una foto (JPG/PNG) o un PDF." }, { status: 400 });
    }

    const buf = Buffer.from(String(archivo.data), "base64");
    if (buf.length > MAX_BYTES) {
      return NextResponse.json({ error: "El archivo pesa demasiado (máx. 10 MB)." }, { status: 400 });
    }

    const documentoId = body.documentoId ? Number(body.documentoId) : null;
    const vehiculoId = body.vehiculoId ? Number(body.vehiculoId) : null;

    let fechaActual: string | null = null;
    if (documentoId) {
      const { data: docActual } = await admin.from("documentos_tercero").select("fecha_vencimiento").eq("id", documentoId).eq("empresa_id", empresa.id).maybeSingle();
      fechaActual = docActual?.fecha_vencimiento ?? null;
    }

    const ext = mediaType === "application/pdf" ? "pdf" : mediaType.split("/")[1] || "jpg";
    const path = `proveedores/${empresa.id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await admin.storage.from("documentos").upload(path, buf, { contentType: mediaType, upsert: true });
    if (upErr) throw new Error("No se pudo subir el archivo: " + upErr.message);
    const archivoUrl = admin.storage.from("documentos").getPublicUrl(path).data.publicUrl;

    const { error: insErr } = await admin.from("documentos_tercero_revisiones").insert({
      empresa_id: empresa.id,
      documento_id: documentoId,
      vehiculo_id: vehiculoId,
      tipo,
      numero: body.numero ? String(body.numero).trim() : null,
      fecha_vencimiento_actual: fechaActual,
      fecha_vencimiento_propuesta: body.fechaVencimientoPropuesta || null,
      entidad_emisora: body.entidadEmisora ? String(body.entidadEmisora).trim() : null,
      archivo_url: archivoUrl,
      observaciones_proveedor: body.observaciones ? String(body.observaciones).trim() : null,
      estado: "pendiente",
    });
    if (insErr) throw insErr;

    // Aviso interno a operaciones — best-effort, nunca bloquea la subida del proveedor.
    try {
      const { data: cfg } = await admin.from("config_proveedores_docs").select("correos_alerta").eq("id", 1).maybeSingle();
      const correos = String(cfg?.correos_alerta || "").split(/[,;\s]+/).map((s: string) => s.trim()).filter(Boolean);
      if (correos.length && process.env.RESEND_API_KEY) {
        const html = `<div style="font-family:Arial,sans-serif;padding:16px;">
          <p><b>${empresa.razon_social}</b> subió un documento para revisión: <b>${tipo}</b>${vehiculoId ? " (unidad asociada)" : " (empresa)"}.</p>
          <p>Revísalo en <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/tercerizadas">/tercerizadas</a> antes de que el ERP deje de marcarlo como vencido/por vencer.</p>
        </div>`;
        for (const to of correos) {
          try { await enviarEmail({ to, subject: `📄 Documento por revisar — ${empresa.razon_social}`, html }); } catch {}
        }
      }
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
