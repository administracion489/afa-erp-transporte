import { NextRequest, NextResponse } from "next/server";
import { enviarInvitacionesPasajeros } from "@/lib/pasajero-invitacion";

/** POST /api/pasajeros/invitacion
 *  body: { pasajeroIds: number[], canales: { email: boolean, whatsapp: boolean } }
 *  Envío automático al dar de alta un pasajero (individual o masivo): correo con
 *  credenciales + WhatsApp de invitación (sin contraseñas), según canales habilitados.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const pasajeroIds: number[] = Array.isArray(body.pasajeroIds) ? body.pasajeroIds : [];
  const canales = {
    email: !!body.canales?.email,
    whatsapp: !!body.canales?.whatsapp,
  };
  if (!pasajeroIds.length) return NextResponse.json({ error: "pasajeroIds requerido" }, { status: 400 });

  const resultado = await enviarInvitacionesPasajeros(pasajeroIds, canales);
  return NextResponse.json(resultado);
}
