// ============================================================
// POST /api/elia/accion — Ejecuta una acción PROPUESTA por ELIA
// y CONFIRMADA por el usuario con el botón de la tarjeta.
// Las escrituras nunca ocurren dentro del chat: solo aquí, con
// permisos verificados de nuevo en el servidor.
// ============================================================
import { NextResponse } from "next/server";
import { autenticarElia } from "@/lib/elia/auth";
import { notificarReserva } from "@/lib/notificaciones";
import type { AccionPropuesta } from "@/lib/elia/tipos";

export const maxDuration = 60;

const MODULOS_ACCION = ["programacion", "despachador"];

export async function POST(request: Request) {
  const auth = await autenticarElia(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { usuario } = auth;

  const permitido =
    usuario.rol === "admin" || MODULOS_ACCION.some((m) => usuario.permisos.includes(m));
  if (!permitido)
    return NextResponse.json({ error: "No tienes permiso para ejecutar esta acción" }, { status: 403 });

  let accion: AccionPropuesta;
  try {
    accion = (await request.json()).accion;
    if (!accion?.tipo || !accion?.reserva_id) throw new Error();
  } catch {
    return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
  }

  try {
    if (accion.tipo === "recordatorio_reserva") {
      const r = await notificarReserva(Number(accion.reserva_id), "manual", "confirmacion_pasajero");
      const { enviados, errores, sinCanal, total } = r.resumen;
      let mensaje: string;
      if (total === 0) {
        mensaje = `El servicio #${accion.reserva_id} no tiene pasajeros asignados todavía, así que no había a quién avisar.`;
      } else if (enviados === total) {
        mensaje = `✅ Listo, envié el recordatorio a los ${total} pasajero(s) del servicio #${accion.reserva_id}.`;
      } else {
        mensaje = `Envié el recordatorio del servicio #${accion.reserva_id}: ${enviados} de ${total} llegaron bien${
          sinCanal ? `, ${sinCanal} sin canal de contacto` : ""
        }${errores ? ` y ${errores} con error` : ""}.`;
      }
      return NextResponse.json({ ok: true, mensaje });
    }

    if (accion.tipo === "confirmar_reserva") {
      const { data, error } = await usuario.sb
        .from("reservas")
        .update({ estado: "confirmada" })
        .eq("id", Number(accion.reserva_id))
        .in("estado", ["pendiente", "programada"])
        .select("id");
      if (error) throw error;
      if (!data || (data as any[]).length === 0)
        return NextResponse.json({
          ok: false,
          mensaje: `No pude confirmar el servicio #${accion.reserva_id}: es posible que ya haya cambiado de estado. Revísalo en Programación.`,
        });
      return NextResponse.json({
        ok: true,
        mensaje: `✅ Perfecto, el servicio #${accion.reserva_id} quedó confirmado.`,
      });
    }

    return NextResponse.json({ error: "Tipo de acción no soportado" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, mensaje: "No pude completar la acción: " + (e?.message ?? "error inesperado") },
      { status: 200 }
    );
  }
}
