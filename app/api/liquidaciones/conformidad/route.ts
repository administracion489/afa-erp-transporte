// /api/liquidaciones/conformidad — la puerta PÚBLICA por la que el cliente aprueba.
//
//   GET  ?token=…  → devuelve el documento armado (resumen + HTML) y marca "vista"
//   POST           → registra la conformidad o la observación
//
// No exige sesión a propósito: el cliente recibe el enlace por correo o WhatsApp y
// aprueba sin crear usuario. La autorización ES el token — largo, aleatorio y único
// por liquidación (lo genera la BD, ver supabase/liquidaciones-v2.sql). Por eso todo
// pasa por service-role aquí y NUNCA se expone la tabla al navegador.
//
// El token no permite ver otra liquidación ni listar nada: solo la suya.

import { createClient } from "@supabase/supabase-js";
import { cargarDocumentoLiquidacion } from "@/lib/liquidacion-datos";
import { buildLiquidacionHtml } from "@/lib/liquidacion-doc";
import { registrarConformidad, marcarVista, type Lado } from "@/lib/liquidaciones";

export const dynamic = "force-dynamic";

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const BASE = () =>
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
  process.env.APP_URL?.replace(/\/$/, "") ||
  "https://afatoursperu.com";

/** IP del solicitante (queda como evidencia de quién aprobó y desde dónde). */
function ipDe(req: Request): string | null {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  return (xff ? xff.split(",")[0].trim() : h.get("x-real-ip")) || null;
}

/** Busca el token en las dos tablas: el enlace no dice de qué lado es. */
async function resolverLado(sb: any, token: string): Promise<{ lado: Lado; fila: any } | null> {
  const { data: c } = await sb.from("liquidacion_cliente").select("id,estado,conformidad_estado,cliente_id").eq("token", token).maybeSingle();
  if (c) return { lado: "cliente", fila: c };
  const { data: p } = await sb.from("liquidacion_proveedor").select("id,estado,conformidad_estado,empresa_tercerizada_id").eq("token", token).maybeSingle();
  if (p) return { lado: "proveedor", fila: p };
  return null;
}

export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    if (!token || token.length < 16) return Response.json({ error: "Enlace inválido" }, { status: 400 });

    const sb = admin();
    const encontrado = await resolverLado(sb, token);
    if (!encontrado) return Response.json({ error: "Este enlace no corresponde a ninguna liquidación." }, { status: 404 });
    const { lado } = encontrado;

    const doc = await cargarDocumentoLiquidacion(sb, lado, { token }, {
      urlPublica: `${BASE()}/conformidad/${token}`,
      firmaUrl: `${BASE()}/firmaJLCA.png`,
    });
    if (!doc) return Response.json({ error: "No se pudo cargar la liquidación." }, { status: 404 });

    // Un borrador nunca debió salir; si alguien tiene el enlace, no ve nada.
    if (doc.estadoLabel === "BORRADOR")
      return Response.json({ error: "Esta liquidación todavía no ha sido emitida." }, { status: 409 });
    if (doc.estadoLabel === "ANULADA")
      return Response.json({ error: "Esta liquidación fue anulada." }, { status: 410 });

    await marcarVista(sb, lado, token, ipDe(req));

    return Response.json({
      ok: true,
      lado,
      resumen: {
        codigo: doc.codigo,
        titulo: doc.control.titulo,
        contraparte: doc.contraparte.nombre,
        area: doc.contraparte.area,
        usuario: doc.contraparte.usuario,
        cargo: doc.contraparte.cargo,
        periodo: doc.servicio.periodo,
        moneda: doc.servicio.moneda,
        servicios: doc.anexo1.length,
        subtotal: doc.totales.subtotal,
        igv: doc.totales.igv,
        total: doc.totales.total,
        lineas: doc.lineas.map((l) => ({
          descripcion: l.descripcion, cantidad: l.cantidad,
          precio: l.precio_unitario, total: l.total_linea, tipo: l.tipo,
        })),
        conformidad: doc.conformidad,
        empresa: doc.empresa.nombre,
      },
      html: buildLiquidacionHtml(doc),
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token = String(body.token ?? "");
    const decision = body.decision === "observada" ? "observada" : "conforme";
    const por = String(body.por ?? "").trim();
    const cargo = body.cargo ? String(body.cargo).trim() : null;
    const comentario = body.comentario ? String(body.comentario).trim() : null;
    const canal = ["correo", "whatsapp", "portal"].includes(body.canal) ? body.canal : "correo";

    if (!token) return Response.json({ error: "Enlace inválido" }, { status: 400 });
    if (!por) return Response.json({ error: "Escribe tu nombre para registrar la conformidad." }, { status: 400 });

    const sb = admin();
    const encontrado = await resolverLado(sb, token);
    if (!encontrado) return Response.json({ error: "Este enlace no corresponde a ninguna liquidación." }, { status: 404 });

    const r = await registrarConformidad(sb, encontrado.lado, token, {
      decision, por, cargo, comentario, canal, ip: ipDe(req),
    });
    if (!r.ok) return Response.json({ error: r.error }, { status: 409 });

    return Response.json({ ok: true, codigo: r.codigo, decision });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
