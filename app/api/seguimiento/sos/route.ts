import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarEmail } from "@/lib/notificaciones";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    token: string;
    lat?: number;
    lng?: number;
    motivo?: string;
  };

  if (!body.token) {
    return NextResponse.json({ error: "Token requerido" }, { status: 400 });
  }

  const supabase = adminClient();

  // 1. Validar token y obtener datos de la reserva
  const { data: reserva, error: errR } = await supabase
    .from("reservas")
    .select("id, estado, fecha_servicio, hora_servicio, vehiculo_id, vehiculo_tercero_id, conductor_id, token_expira_at")
    .eq("token_seguimiento", body.token)
    .single();

  if (errR || !reserva) {
    return NextResponse.json({ error: "Token inválido" }, { status: 404 });
  }

  // 2. Datos del conductor y vehículo (para el correo)
  let conductorNombre = "—";
  let vehiculoPlaca = "—";

  if (reserva.conductor_id) {
    const { data: c } = await supabase.from("conductores").select("nombre").eq("id", reserva.conductor_id).maybeSingle();
    if (c) conductorNombre = (c as any).nombre ?? "—";
  }
  if (reserva.vehiculo_id) {
    const { data: v } = await supabase.from("vehiculos").select("placa").eq("id", reserva.vehiculo_id).maybeSingle();
    if (v) vehiculoPlaca = (v as any).placa ?? "—";
  } else if (reserva.vehiculo_tercero_id) {
    const { data: v } = await supabase.from("vehiculos_tercero").select("placa").eq("id", reserva.vehiculo_tercero_id).maybeSingle();
    if (v) vehiculoPlaca = (v as any).placa ?? "—";
  }

  // 3. Registrar alerta SOS
  const { error: errSos } = await supabase.from("alertas_sos").insert({
    reserva_id: reserva.id,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    motivo: body.motivo ?? "SOS desde link de seguimiento",
    estado: "pendiente",
    created_at: new Date().toISOString(),
  });

  if (errSos) {
    console.error("[sos] Error registrando alerta:", errSos.message);
    // No fallar: seguimos con los correos aunque la inserción falle
  }

  // 4. Buscar destinatarios: admins y operadores activos con email
  const { data: operadores } = await supabase
    .from("usuarios")
    .select("nombre, email, rol")
    .in("rol", ["admin", "operador"])
    .eq("activo", true);

  const destinatarios = (operadores ?? [])
    .map(u => (u as any).email as string)
    .filter(Boolean);

  // Fallback si no hay operadores configurados
  if (destinatarios.length === 0 && process.env.SOS_FALLBACK_EMAIL) {
    destinatarios.push(process.env.SOS_FALLBACK_EMAIL);
  }

  // 5. Enviar correo a cada operador
  const ubicacionStr = body.lat && body.lng
    ? `<a href="https://maps.google.com/?q=${body.lat},${body.lng}">Ver en Google Maps</a>`
    : "Sin ubicación GPS";

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #dc2626; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">🚨 ALERTA SOS - PASAJERO</h1>
      </div>
      <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; margin-top: 0;"><strong>Un pasajero ha activado el botón SOS en su link de seguimiento.</strong></p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px; color: #6b7280;">Reserva #:</td><td style="padding: 8px; font-weight: bold;">${reserva.id}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Fecha servicio:</td><td style="padding: 8px;">${reserva.fecha_servicio} ${reserva.hora_servicio}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Vehículo:</td><td style="padding: 8px; font-weight: bold;">${vehiculoPlaca}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Conductor:</td><td style="padding: 8px;">${conductorNombre}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Ubicación SOS:</td><td style="padding: 8px;">${ubicacionStr}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Motivo:</td><td style="padding: 8px;">${body.motivo ?? "—"}</td></tr>
          <tr><td style="padding: 8px; color: #6b7280;">Hora alerta:</td><td style="padding: 8px;">${new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })}</td></tr>
        </table>
        <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px; margin: 20px 0;">
          <p style="margin: 0; color: #7f1d1d;"><strong>Acción requerida:</strong> Contactar al conductor inmediatamente y al pasajero para verificar la situación.</p>
        </div>
      </div>
    </div>
  `;

  const resultados = await Promise.allSettled(
    destinatarios.map(to =>
      enviarEmail({ to, subject: `🚨 SOS — Reserva #${reserva.id} (Placa ${vehiculoPlaca})`, html })
    )
  );

  const enviados = resultados.filter(r => r.status === "fulfilled").length;
  const fallidos = resultados.filter(r => r.status === "rejected").length;

  return NextResponse.json({
    ok: true,
    sos_registrado: !errSos,
    correos_enviados: enviados,
    correos_fallidos: fallidos,
    destinatarios: destinatarios.length,
  });
}
