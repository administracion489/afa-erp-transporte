import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { insertarServicioNuevo } from "@/lib/reservas-autoseleccion";
import { enviarCotizacionTraslado, type CodigoEnvio } from "@/lib/traslados/enviar-cotizacion-datos";
import { accionReclamable } from "@/lib/traslados/envio-ia";

// Enviar la cotización de traslado arma el PDF, lo sube y lo manda por WhatsApp: más que los 10 s
// por defecto en un mal día de Meta o de Storage.
export const maxDuration = 60;

/** El estado HTTP de cada código del envío de una cotización de traslado. */
const STATUS_ENVIO: Record<CodigoEnvio, number> = {
  ok: 200, no_pendiente: 409, reclamo_perdido: 409, cotizacion_no_existe: 404,
  cotizacion_ajena: 422, canal_no_whatsapp: 422, sin_remitente: 422, sin_precio: 422,
  error_lectura: 500, pdf_no_generado: 502, sin_url: 502, envio_fallido: 502,
};

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
    // Aprobar CREA cotizaciones y reservas con service-role: sin sesión cualquiera podía
    // fabricarlas. Y quién aprobó sale del TOKEN, no del body: un `usuario_id` del cliente
    // permitía firmar la aprobación a nombre de otra persona.
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
    const usuario_id = auth.userId;

    const { accion_id, decision, conversacion_id } = await req.json();
    if (!accion_id || !["aprobar", "rechazar"].includes(decision))
      return NextResponse.json({ ok: false, error: "Datos inválidos" }, { status: 400 });
    // La conversación que tiene abierta quien pulsa: si viene, la acción tiene que ser de ella.
    const convEsperada = typeof conversacion_id === "string" ? conversacion_id.trim() : "";

    const sb = db();
    const { data: accion } = await sb
      .from("crm_acciones_ia")
      .select("*, crm_contactos(*)")
      .eq("id", accion_id)
      .single();
    if (!accion) return NextResponse.json({ ok: false, error: "Acción no encontrada" }, { status: 404 });
    if (convEsperada && accion.conversacion_id !== convEsperada)
      return NextResponse.json({ ok: false, error: "La acción no es de esta conversación: recarga la bandeja." }, { status: 409 });

    // Cotización de traslado de la IA: «aprobar» es ENVIARLA al cliente (el PDF se arma de la fila,
    // así que sale con lo que se haya corregido en /cotizaciones); «rechazar» no toca la cotización.
    if (accion.tipo === "cotizacion_traslado") {
      // Enviar un PDF a un cliente exige saber de qué conversación es: sin ella no se hace nada.
      if (!convEsperada)
        return NextResponse.json({ ok: false, error: "Falta la conversación de la cotización (conversacion_id): recarga la bandeja." }, { status: 400 });
      if (decision === "rechazar") {
        if (!accionReclamable(accion, Date.now()))
          return NextResponse.json({ ok: false, estado: accion.estado, error: `La acción ya está ${accion.estado}.` }, { status: 409 });
        let q = sb.from("crm_acciones_ia")
          .update({ estado: "rechazada", resuelta_at: new Date().toISOString(), resuelta_por: usuario_id })
          .eq("id", accion_id).eq("estado", accion.estado);
        if (accion.estado === "enviando") q = accion.resuelta_at ? q.eq("resuelta_at", accion.resuelta_at) : q.is("resuelta_at", null);
        const { data: upd, error } = await q.select("id");
        if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
        if (!upd?.length) return NextResponse.json({ ok: false, error: "Otro usuario la está enviando o ya la resolvió." }, { status: 409 });
        return NextResponse.json({ ok: true, estado: "rechazada" });
      }
      const r = await enviarCotizacionTraslado(sb, {
        accionId: accion_id, por: "ejecutivo", usuarioId: usuario_id, esperado: { conversacionId: convEsperada },
      });
      const estado = r.ok ? "aprobada"
        : r.codigo === "no_pendiente" || r.codigo === "reclamo_perdido" || r.codigo === "cotizacion_no_existe" ? accion.estado : "pendiente";
      return NextResponse.json(
        { ok: r.ok, estado, codigo: r.codigo, detalle: r.detalle, ...(r.ok ? {} : { error: r.detalle }) },
        { status: STATUS_ENVIO[r.codigo] ?? 500 },
      );
    }

    if (accion.estado !== "pendiente")
      return NextResponse.json({ ok: false, error: `La acción ya fue ${accion.estado}` }, { status: 409 });

    if (decision === "rechazar") {
      await sb
        .from("crm_acciones_ia")
        .update({ estado: "rechazada", resuelta_at: new Date().toISOString(), resuelta_por: usuario_id })
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
      // Nace con «Permitir autoselección» (lib/reservas-autoseleccion.ts).
      const { data, error } = await insertarServicioNuevo(
        (f) => sb.from("reservas").insert(f).select("id").single(), fila,
      );
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
        resuelta_por: usuario_id,
      })
      .eq("id", accion_id);

    return NextResponse.json({ ok: true, estado: "aprobada", resultado_tipo: resultadoTipo, resultado_id: resultadoId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
