// app/api/crm/ia/cotizacion-traslado/route.ts
// GET ?accion_id=<uuid> — El PDF de la cotización de traslado que preparó la IA del CRM, armado
// EN ESE MOMENTO desde su fila de `cotizaciones` (si un ejecutivo la corrigió en /cotizaciones,
// sale corregida). Es lo que ve el ejecutivo en la tarjeta «Cotización de traslado para revisar»
// antes de pulsar «Enviar al cliente». No escribe nada.
//
// Solo usuarios del ERP con el módulo «crm». Se puede ver una ya enviada (no exige que esté
// pendiente), pero la cotización tiene que ser DE la conversación de la acción.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { armarPdfDeFila, leerCotizacionTraslado } from "@/lib/traslados/enviar-cotizacion-datos";
import { planAccionTraslado } from "@/lib/traslados/envio-ia";

export const maxDuration = 60;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const error = (msg: string, status: number) => NextResponse.json({ ok: false, error: msg }, { status });

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return error(auth.error, auth.status);
  const accionId = req.nextUrl.searchParams.get("accion_id") ?? "";
  if (!UUID.test(accionId)) return error("Falta el id de la acción.", 400);

  const sb = db();
  try {
    const { data: accion, error: eAcc } = await sb.from("crm_acciones_ia")
      .select("id, tipo, estado, conversacion_id, resuelta_at, resultado_id, payload").eq("id", accionId).maybeSingle();
    if (eAcc) return error(`No se pudo leer la acción: ${eAcc.message}`, 500);
    if (!accion || accion.tipo !== "cotizacion_traslado") return error("La acción no es una cotización de traslado.", 404);
    const cotId = Number(accion.resultado_id ?? (accion.payload as { cotizacion_id?: unknown } | null)?.cotizacion_id);
    const cot = await leerCotizacionTraslado(sb, cotId);
    const { data: c } = await sb.from("crm_conversaciones")
      .select("id, canal, crm_contactos(wa_id)").eq("id", accion.conversacion_id ?? "").maybeSingle();
    const contacto = c ? (Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos) as { wa_id?: string | null } | null : null;
    const conv = c ? { id: c.id as string, canal: c.canal as string | null, wa_id: contacto?.wa_id ?? null } : null;
    // Para VER no hace falta que siga pendiente ni que se pueda enviar por WhatsApp: se mira como
    // si estuviera pendiente y se aceptan los dos códigos que solo importan al enviar.
    const plan = planAccionTraslado({ ...accion, estado: "pendiente", resuelta_at: null }, cot, conv);
    if (!["ok", "canal_no_whatsapp", "sin_remitente"].includes(plan.codigo)) {
      return error(plan.detalle, plan.codigo === "cotizacion_no_existe" ? 404 : 422);
    }
    // El CELULAR que se imprime es el wa_id de esta conversación (el mismo que usará el envío).
    const pdf = await armarPdfDeFila(sb, cot!, { celular: conv?.wa_id ?? null });
    return new Response(Buffer.from(pdf.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename="${pdf.nombre}"`,
        // Lo que el PDF no pudo poner (sin foto, sin cuenta en la moneda…): solo los códigos.
        "X-Avisos-Pdf": pdf.avisos.map((a) => a.codigo).join(","),
      },
    });
  } catch (e) {
    console.error("[crm/ia/cotizacion-traslado]", (e as Error)?.message);
    return error(`No se pudo armar el PDF: ${(e as Error)?.message ?? "error"}`, 500);
  }
}
