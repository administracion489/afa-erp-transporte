import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const tel9 = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-9);

// Empareja el contacto del CRM con un cliente del ERP (por cliente_id, teléfono o correo)
async function clienteIdDeContacto(sb: ReturnType<typeof db>, contacto: any): Promise<number | null> {
  if (!contacto) return null;
  if (contacto.cliente_id) return contacto.cliente_id;
  const tel = tel9(contacto.telefono || contacto.wa_id);
  if (tel) {
    const { data } = await sb.from("clientes").select("id, telefono").not("telefono", "is", null);
    for (const c of data ?? []) if (tel9(c.telefono) === tel) return c.id;
  }
  if (contacto.email) {
    const { data } = await sb.from("clientes").select("id").ilike("email", contacto.email).limit(1).maybeSingle();
    if (data) return data.id;
  }
  return null;
}

// Aprueba (crea el registro real) o rechaza una propuesta de la IA.
export async function POST(req: NextRequest) {
  try {
    const { accion_id, decision, usuario_id } = await req.json();
    if (!accion_id || !["aprobar", "rechazar"].includes(decision))
      return NextResponse.json({ ok: false, error: "Datos inválidos" }, { status: 400 });

    const sb = db();
    const { data: accion } = await sb
      .from("crm_acciones_ia")
      .select("*, crm_contactos(*)")
      .eq("id", accion_id)
      .single();
    if (!accion) return NextResponse.json({ ok: false, error: "Acción no encontrada" }, { status: 404 });
    if (accion.estado !== "pendiente")
      return NextResponse.json({ ok: false, error: `La acción ya fue ${accion.estado}` }, { status: 409 });

    if (decision === "rechazar") {
      await sb
        .from("crm_acciones_ia")
        .update({ estado: "rechazada", resuelta_at: new Date().toISOString(), resuelta_por: usuario_id ?? null })
        .eq("id", accion_id);
      return NextResponse.json({ ok: true, estado: "rechazada" });
    }

    // Aprobar → crear el registro real (en estado borrador/programada para que el equipo lo complete)
    const p = accion.payload ?? {};
    const contacto = (accion as any).crm_contactos;
    const clienteId = await clienteIdDeContacto(sb, contacto);
    let resultadoTipo: string | null = null;
    let resultadoId: number | null = null;

    if (accion.tipo === "cotizacion") {
      const fila: any = {
        cliente_id: clienteId,
        estado: "borrador",
        origen: p.origen ?? null,
        destino: p.destino ?? null,
        fecha_servicio: p.fecha_servicio || null,
        hora_ida: p.hora_ida || null,
        tipo_vehiculo: p.tipo_vehiculo ?? null,
        tipo_servicio: p.tipo_servicio ?? null,
        precio_cliente: p.precio_cliente ?? null,
        atencion: contacto?.nombre ?? null,
        asunto: p.observaciones ?? `Solicitud vía CRM (${contacto?.nombre ?? "contacto"})`,
        medio_envio: "crm_ia",
        incluye_igv: false,
      };
      const { data, error } = await sb.from("cotizaciones").insert(fila).select("id").single();
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      resultadoTipo = "cotizaciones";
      resultadoId = data!.id;
    } else if (accion.tipo === "reserva") {
      const fila: any = {
        cliente_id: clienteId,
        estado: "programada",
        origen: p.origen ?? null,
        destino: p.destino ?? null,
        fecha_servicio: p.fecha_servicio || null,
        hora_servicio: p.hora_servicio || null,
        tipo: p.tipo ?? null,
        precio_cliente: p.precio_cliente ?? null,
        observaciones: `Creada por Agente IA (CRM)${p.observaciones ? ` — ${p.observaciones}` : ""}`,
      };
      const { data, error } = await sb.from("reservas").insert(fila).select("id").single();
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      resultadoTipo = "reservas";
      resultadoId = data!.id;
    }

    await sb
      .from("crm_acciones_ia")
      .update({
        estado: "aprobada",
        resultado_tipo: resultadoTipo,
        resultado_id: resultadoId,
        resuelta_at: new Date().toISOString(),
        resuelta_por: usuario_id ?? null,
      })
      .eq("id", accion_id);

    return NextResponse.json({ ok: true, estado: "aprobada", resultado_tipo: resultadoTipo, resultado_id: resultadoId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
