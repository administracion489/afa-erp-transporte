// app/api/notificaciones/sincronizar/route.ts
// El aviso MANUAL a los pasajeros de un servicio: el manifiesto («Actualizar y avisar») y el
// re-aviso tras cambiar la hora. Quién recibe lo decide `planAvisoManual`
// (lib/notificaciones-manual.ts): nunca un servicio pasado, y nunca dos veces a quien ya
// recibió el aviso de este servicio (salvo el cambio de hora, que corrige el anterior).
//
// GET  ?reserva_id=N[&motivo=cambio_hora] → el plan, sin enviar nada (para el confirm()).
// POST { reserva_id, avisar?: boolean (default true), motivo?: "manifiesto"|"cambio_hora" }

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { notificarReserva } from "@/lib/notificaciones";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { hoyLima } from "@/lib/alertas";
import { planAvisoManual, textoPlanAvisoManual, type MotivoAvisoManual } from "@/lib/notificaciones-manual";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MODULOS = ["programacion", "seguimiento"];

async function calcularPlan(reservaId: number, motivo: MotivoAvisoManual) {
  const { data: reserva, error } = await supabaseAdmin
    .from("reservas").select("id, fecha_servicio").eq("id", reservaId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!reserva) return null;

  const { data: paradas, error: eP } = await supabaseAdmin
    .from("paradas").select("id").eq("reserva_id", reservaId);
  if (eP) throw new Error(eP.message);
  const idsParadas = (paradas ?? []).map((p: any) => p.id);
  let pasajeros: number[] = [];
  if (idsParadas.length) {
    const { data: asig, error: eA } = await supabaseAdmin
      .from("pasajeros_parada").select("pasajero_id").in("parada_id", idsParadas);
    if (eA) throw new Error(eA.message);
    pasajeros = (asig ?? []).map((a: any) => a.pasajero_id).filter((x: any) => x != null);
  }

  // Si no se puede leer el registro, se lanza: «nadie fue avisado» por un error volvería a
  // escribirles a todos, que es justo lo que este freno existe para impedir.
  const { data: previos, error: eN } = await supabaseAdmin
    .from("notificaciones_enviadas")
    .select("pasajero_id")
    .eq("reserva_id", reservaId)
    .eq("trigger_origen", "manual")
    .eq("estado", "enviado")
    .not("pasajero_id", "is", null)
    .limit(5000);
  if (eN) throw new Error(eN.message);

  const plan = planAvisoManual({
    fechaServicio: reserva.fecha_servicio,
    hoy: hoyLima(),
    motivo,
    pasajeros,
    avisadosAntes: (previos ?? []).map((n: any) => n.pasajero_id),
  });
  return { plan, texto: textoPlanAvisoManual(plan) };
}

function leerMotivo(v: unknown): MotivoAvisoManual {
  return v === "cambio_hora" ? "cambio_hora" : "manifiesto";
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, MODULOS);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const reservaId = Number(req.nextUrl.searchParams.get("reserva_id"));
  if (!Number.isInteger(reservaId) || reservaId <= 0) {
    return NextResponse.json({ error: "reserva_id requerido" }, { status: 400 });
  }
  try {
    const r = await calcularPlan(reservaId, leerMotivo(req.nextUrl.searchParams.get("motivo")));
    if (!r) return NextResponse.json({ error: "Servicio no encontrado" }, { status: 404 });
    return NextResponse.json({
      codigo: r.plan.codigo, avisar: r.plan.avisar.length, ya_avisados: r.plan.yaAvisados.length, texto: r.texto,
    });
  } catch (e: any) {
    console.error("[notificaciones/sincronizar GET]", e);
    return NextResponse.json({ error: "No se pudo consultar quién ya fue avisado." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Dispara correos/WhatsApp facturables a los pasajeros de cualquier reserva: sin sesión
    // del ERP era una bocina abierta.
    const auth = await verificarUsuarioApiAlguno(req, MODULOS);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json();
    const { reserva_id } = body as { reserva_id: number };
    if (!reserva_id || typeof reserva_id !== "number") {
      return NextResponse.json({ error: "reserva_id requerido" }, { status: 400 });
    }
    const avisar = body?.avisar !== false;
    const motivo = leerMotivo(body?.motivo);

    let resumen = { enviados: 0, errores: 0, sinCanal: 0, total: 0 };
    let codigo: string = "sin_aviso";
    let texto = "No se avisó a los pasajeros.";
    let yaAvisados = 0;

    if (avisar) {
      const r = await calcularPlan(reserva_id, motivo);
      if (!r) return NextResponse.json({ error: "Servicio no encontrado" }, { status: 404 });
      codigo = r.plan.codigo;
      texto = r.texto;
      yaAvisados = r.plan.yaAvisados.length;
      if (r.plan.codigo === "avisar") {
        const res = await notificarReserva(reserva_id, "manual", "confirmacion_pasajero", { soloPasajeros: r.plan.avisar });
        resumen = res.resumen;
      }
    }

    // Marcar reserva como sincronizada (la app del pasajero ya lee los datos al día).
    await supabaseAdmin
      .from("reservas")
      .update({ sincronizado_app: true, fecha_sincronizacion: new Date().toISOString() })
      .eq("id", reserva_id);

    const mensaje = codigo === "avisar"
      ? `${resumen.enviados} aviso(s) enviados a ${resumen.total} pasajero(s)` + (yaAvisados ? ` · ${yaAvisados} ya lo habían recibido` : "")
      : texto;

    return NextResponse.json({
      ok: true,
      codigo,
      mensaje,
      resumen,
      ya_avisados: yaAvisados,
      // `detalle` NO viaja: trae nombre, correo y teléfono de cada pasajero. Queda en
      // notificaciones_enviadas para auditoría.
    });
  } catch (error: any) {
    console.error("[notificaciones/sincronizar]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
