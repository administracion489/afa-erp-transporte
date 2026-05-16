// lib/notificaciones.ts
// Lógica central: Resend (email) + Twilio (WhatsApp / SMS)

import { createClient } from "@supabase/supabase-js";

// Admin client para escribir logs sin RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── TIPOS ────────────────────────────────────────────────────────────────────

export type TipoCanal   = "email" | "whatsapp" | "sms";
export type TipoTrigger = "manual" | "cron_recordatorio";

export type DatosNotificacion = {
  pasajeroNombre:   string;
  fecha:            string;
  hora:             string;
  paradaNombre:     string;
  paradaDireccion?: string;
  conductorNombre?: string;
  vehiculoPlaca?:   string;
  empresa:          string;
};

export type ResultadoPasajero = {
  pasajeroId:   number;
  nombre:       string;
  email?:       string;
  telefono?:    string;
  canales:      { tipo: TipoCanal; estado: "enviado" | "error" | "sin_canal"; detalle?: string }[];
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Normaliza teléfono peruano a E.164: 987654321 → +51987654321 */
function normalizarTelefono(tel: string): string {
  const limpio = tel.replace(/\D/g, "");
  if (limpio.startsWith("51") && limpio.length === 11) return "+" + limpio;
  if (limpio.length === 9) return "+51" + limpio;
  return "+" + limpio; // best effort
}

function formatFecha(fechaISO: string): string {
  return new Date(fechaISO + "T00:00:00").toLocaleDateString("es-PE", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
}

// ─── EMAIL (RESEND) ───────────────────────────────────────────────────────────

export async function enviarEmail({
  to, subject, html,
}: { to: string; subject: string; html: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY no configurada");

  const from = process.env.RESEND_FROM ?? "AFA Transporte <onboarding@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend: ${err}`);
  }
}

// ─── WHATSAPP (TWILIO) ────────────────────────────────────────────────────────

function twilioAuthHeader(): string {
  const sid   = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

export async function enviarWhatsApp({
  to, body,
}: { to: string; body: string }): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID) throw new Error("TWILIO no configurado");

  const sid  = process.env.TWILIO_ACCOUNT_SID;
  // Usar número de sandbox o número de producción aprobado
  const from = process.env.TWILIO_WHATSAPP_FROM ?? "+14155238886";

  const params = new URLSearchParams({
    From: `whatsapp:${from}`,
    To:   `whatsapp:${to}`,
    Body: body,
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  "POST",
      headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body:    params.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio WhatsApp: ${err}`);
  }
}

export async function enviarSMS({
  to, body,
}: { to: string; body: string }): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID) throw new Error("TWILIO no configurado");

  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_SMS_FROM!;
  if (!from) throw new Error("TWILIO_SMS_FROM no configurada");

  const params = new URLSearchParams({ From: from, To: to, Body: body });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  "POST",
      headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body:    params.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio SMS: ${err}`);
  }
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

export function htmlEmailSincronizacion(d: DatosNotificacion): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:20px;">
  <div style="max-width:500px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
    <div style="background:#0b315f;padding:24px;text-align:center;">
      <img src="https://qakhcezrmpksxgiwzmvd.supabase.co/storage/v1/object/public/assets/logoafacotizacion.jpg" alt="AFA Transportes" style="height:60px;width:auto;margin-bottom:10px;border-radius:6px;" />
      <h1 style="color:white;margin:0;font-size:20px;">Confirmación de Servicio</h1>
    </div>
    <div style="padding:24px;">
      <p style="color:#374151;font-size:15px;">Hola <strong>${d.pasajeroNombre}</strong>,</p>
      <p style="color:#6b7280;font-size:14px;">Tu servicio de transporte ha sido confirmado:</p>
      <div style="background:#f0f9ff;border-left:4px solid #0b315f;border-radius:8px;padding:16px;margin:16px 0;">
        <p style="margin:0 0 8px;font-size:13px;">📅 Fecha: <strong>${d.fecha}</strong></p>
        <p style="margin:0 0 8px;font-size:13px;">🕐 Hora: <strong>${d.hora}</strong></p>
        <p style="margin:0 0 8px;font-size:13px;">📍 Tu parada: <strong>${d.paradaNombre}</strong></p>
        ${d.paradaDireccion ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${d.paradaDireccion}</p>` : ""}
        ${d.conductorNombre ? `<p style="margin:0 0 8px;font-size:13px;">👤 Conductor: <strong>${d.conductorNombre}</strong></p>` : ""}
        ${d.vehiculoPlaca   ? `<p style="margin:0;font-size:13px;">🚌 Vehículo: <strong>${d.vehiculoPlaca}</strong></p>` : ""}
      </div>
      <p style="color:#6b7280;font-size:13px;">Por favor esté en su punto de abordaje <strong>5 minutos antes</strong> de la hora indicada.</p>
    </div>
    <div style="background:#f8fafc;padding:16px;text-align:center;">
      <p style="color:#9ca3af;font-size:11px;margin:0;">Mensaje automático de ${d.empresa} · No responder</p>
    </div>
  </div>
</body>
</html>`;
}

export function htmlEmailRecordatorio(d: DatosNotificacion): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:20px;">
  <div style="max-width:500px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
    <div style="background:#d97706;padding:24px;text-align:center;">
      <img src="https://qakhcezrmpksxgiwzmvd.supabase.co/storage/v1/object/public/assets/logoafacotizacion.jpg" alt="AFA Transportes" style="height:60px;width:auto;margin-bottom:10px;border-radius:6px;" />
      <h1 style="color:white;margin:0;font-size:20px;">⏰ Recordatorio de Mañana</h1>
    </div>
    <div style="padding:24px;">
      <p style="color:#374151;font-size:15px;">Hola <strong>${d.pasajeroNombre}</strong>,</p>
      <p style="color:#6b7280;font-size:14px;">Te recordamos que mañana tienes servicio de transporte:</p>
      <div style="background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;padding:16px;margin:16px 0;">
        <p style="margin:0 0 8px;font-size:13px;">📅 Fecha: <strong>${d.fecha}</strong></p>
        <p style="margin:0 0 8px;font-size:13px;">🕐 Hora: <strong>${d.hora}</strong></p>
        <p style="margin:0 0 8px;font-size:13px;">📍 Tu parada: <strong>${d.paradaNombre}</strong></p>
        ${d.paradaDireccion ? `<p style="margin:0;font-size:13px;color:#6b7280;">${d.paradaDireccion}</p>` : ""}
      </div>
      <p style="color:#6b7280;font-size:13px;">¡Te esperamos puntual! 🚌</p>
    </div>
    <div style="background:#f8fafc;padding:16px;text-align:center;">
      <p style="color:#9ca3af;font-size:11px;margin:0;">Mensaje automático de ${d.empresa} · No responder</p>
    </div>
  </div>
</body>
</html>`;
}

export function textoWhatsApp(d: DatosNotificacion, esRecordatorio = false): string {
  const header = esRecordatorio
    ? `⏰ *Recordatorio - ${d.empresa}*\n\nHola *${d.pasajeroNombre}*, mañana tienes transporte:`
    : `✅ *Servicio Confirmado - ${d.empresa}*\n\nHola *${d.pasajeroNombre}*, tu transporte está confirmado:`;

  return `${header}

📅 *${d.fecha}*
🕐 Hora: *${d.hora}*
📍 Tu parada: *${d.paradaNombre}*${d.paradaDireccion ? `\n   _${d.paradaDireccion}_` : ""}${d.conductorNombre ? `\n👤 Conductor: *${d.conductorNombre}*` : ""}${d.vehiculoPlaca ? `\n🚌 Vehículo: *${d.vehiculoPlaca}*` : ""}

Por favor esté 5 minutos antes en su parada 🙏`;
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────

/**
 * Notifica a todos los pasajeros de una reserva.
 * Canales por prioridad:
 *   1. Email (si tiene email y RESEND configurado)
 *   2. WhatsApp (si tiene teléfono y TWILIO configurado)
 *   3. SMS fallback (si WhatsApp falla y no tiene email)
 */
export async function notificarReserva(
  reservaId: number,
  trigger: TipoTrigger = "manual"
): Promise<{
  ok: boolean;
  resumen: { enviados: number; errores: number; sinCanal: number; total: number };
  detalle: ResultadoPasajero[];
}> {
  // 1. Cargar datos de la reserva
  const { data: reserva } = await supabaseAdmin
    .from("reservas")
    .select(`
      id, fecha_servicio, hora_servicio,
      conductor_id, vehiculo_id, empresa_tercerizada_id,
      vehiculo_tercero_id, tipo_asignacion
    `)
    .eq("id", reservaId)
    .single();

  if (!reserva) throw new Error(`Reserva ${reservaId} no encontrada`);

  // 2. Conductor y vehículo
  let conductorNombre: string | undefined;
  let vehiculoPlaca: string | undefined;

  if (reserva.tipo_asignacion === "propio") {
    if (reserva.conductor_id) {
      const { data: c } = await supabaseAdmin.from("conductores").select("nombre").eq("id", reserva.conductor_id).single();
      conductorNombre = c?.nombre;
    }
    if (reserva.vehiculo_id) {
      const { data: v } = await supabaseAdmin.from("vehiculos").select("placa").eq("id", reserva.vehiculo_id).single();
      vehiculoPlaca = v?.placa;
    }
  } else if (reserva.vehiculo_tercero_id) {
    const { data: v } = await supabaseAdmin.from("vehiculos_tercero").select("placa").eq("id", reserva.vehiculo_tercero_id).single();
    vehiculoPlaca = v?.placa;
  }

  // 3. Paradas de esta reserva
  const { data: paradas } = await supabaseAdmin
    .from("paradas")
    .select("id, nombre, direccion, hora_estimada")
    .eq("reserva_id", reservaId);

  const paradasMap = Object.fromEntries((paradas || []).map(p => [p.id, p]));

  // 4. Pasajeros con sus paradas asignadas
  const { data: asignaciones } = await supabaseAdmin
    .from("pasajeros_parada")
    .select("pasajero_id, parada_id")
    .in("parada_id", (paradas || []).map(p => p.id));

  if (!asignaciones || asignaciones.length === 0) {
    return {
      ok: true,
      resumen: { enviados: 0, errores: 0, sinCanal: 0, total: 0 },
      detalle: [],
    };
  }

  const pasajeroIds = [...new Set(asignaciones.map(a => a.pasajero_id))];

  const { data: pasajeros } = await supabaseAdmin
    .from("pasajeros")
    .select("id, nombre, email, telefono")
    .in("id", pasajeroIds);

  // Mapa pasajero_id → parada
  const pasajeroParada: Record<number, number> = {};
  for (const a of asignaciones) {
    if (!pasajeroParada[a.pasajero_id]) pasajeroParada[a.pasajero_id] = a.parada_id;
  }

  const empresa    = process.env.EMPRESA_NOMBRE ?? "AFA Transporte";
  const fechaTexto = reserva.fecha_servicio ? formatFecha(reserva.fecha_servicio) : "-";
  const horaTexto  = reserva.hora_servicio?.slice(0, 5) ?? "-";
  const esRecordatorio = trigger === "cron_recordatorio";

  const detalle: ResultadoPasajero[] = [];
  let enviados = 0, errores = 0, sinCanal = 0;

  // 5. Iterar pasajeros
  for (const pas of (pasajeros || [])) {
    const paradaId = pasajeroParada[pas.id];
    const parada   = paradasMap[paradaId];
    const resultado: ResultadoPasajero = {
      pasajeroId: pas.id,
      nombre:     pas.nombre,
      email:      pas.email || undefined,
      telefono:   pas.telefono || undefined,
      canales:    [],
    };

    const datosN: DatosNotificacion = {
      pasajeroNombre:  pas.nombre,
      fecha:           fechaTexto,
      hora:            parada?.hora_estimada ?? horaTexto,
      paradaNombre:    parada?.nombre ?? "Por confirmar",
      paradaDireccion: parada?.direccion ?? undefined,
      conductorNombre,
      vehiculoPlaca,
      empresa,
    };

    let envioPorWhatsApp = false;

    // Canal 1: Email
    if (pas.email && process.env.RESEND_API_KEY) {
      try {
        const html    = esRecordatorio ? htmlEmailRecordatorio(datosN) : htmlEmailSincronizacion(datosN);
        const subject = esRecordatorio
          ? `⏰ Recordatorio mañana – ${datosN.fecha}`
          : `✅ Servicio confirmado – ${datosN.fecha}`;
        await enviarEmail({ to: pas.email, subject, html });
        resultado.canales.push({ tipo: "email", estado: "enviado" });
        enviados++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "email", estado: "enviado", destinatario: pas.email, trigger });
      } catch (e: any) {
        resultado.canales.push({ tipo: "email", estado: "error", detalle: e.message });
        errores++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "email", estado: "error", destinatario: pas.email, trigger, error: e.message });
      }
    }

    // Canal 2: WhatsApp
    if (pas.telefono && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const tel  = normalizarTelefono(pas.telefono);
        const body = textoWhatsApp(datosN, esRecordatorio);
        await enviarWhatsApp({ to: tel, body });
        resultado.canales.push({ tipo: "whatsapp", estado: "enviado" });
        envioPorWhatsApp = true;
        enviados++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "enviado", destinatario: tel, trigger });
      } catch (e: any) {
        resultado.canales.push({ tipo: "whatsapp", estado: "error", detalle: e.message });
        errores++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "error", destinatario: pas.telefono, trigger, error: e.message });

        // Fallback SMS si no tiene email y WhatsApp falló
        if (!pas.email && process.env.TWILIO_SMS_FROM) {
          try {
            const tel  = normalizarTelefono(pas.telefono);
            const body = `${empresa}: Servicio el ${datosN.fecha} a las ${datosN.hora}. Parada: ${datosN.paradaNombre}.`;
            await enviarSMS({ to: tel, body });
            resultado.canales.push({ tipo: "sms", estado: "enviado" });
            enviados++;
            await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "sms", estado: "enviado", destinatario: tel, trigger });
          } catch (e2: any) {
            resultado.canales.push({ tipo: "sms", estado: "error", detalle: e2.message });
            errores++;
          }
        }
      }
    }

    // Sin canal disponible
    if (resultado.canales.length === 0) {
      sinCanal++;
      await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "email", estado: "sin_canal", trigger });
    }

    detalle.push(resultado);
  }

  return {
    ok: true,
    resumen: { enviados, errores, sinCanal, total: pasajeros?.length ?? 0 },
    detalle,
  };
}

// ─── LOG ─────────────────────────────────────────────────────────────────────

async function logNotificacion({
  reservaId, pasajeroId, tipo, estado, destinatario, trigger, error,
}: {
  reservaId:    number;
  pasajeroId:   number;
  tipo:         TipoCanal;
  estado:       string;
  trigger:      TipoTrigger;
  destinatario?: string;
  error?:       string;
}) {
  await supabaseAdmin.from("notificaciones_enviadas").insert({
    reserva_id:     reservaId,
    pasajero_id:    pasajeroId,
    tipo,
    estado,
    destinatario:   destinatario ?? null,
    trigger_origen: trigger,
    error_detalle:  error ?? null,
  });
}