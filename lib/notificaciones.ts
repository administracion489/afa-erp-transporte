// lib/notificaciones.ts
// Lógica central: Resend (email) + Meta Cloud API (WhatsApp por plantilla)

import { createClient } from "@supabase/supabase-js";
import { enviarWhatsAppPlantilla } from "@/lib/crm-meta";
import { enviarPushAPasajeros, payloadsViaje } from "@/lib/push";
import { telefonoContingencia } from "@/lib/alertas";

// Admin client para escribir logs sin RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── TIPOS ────────────────────────────────────────────────────────────────────

export type TipoCanal   = "email" | "whatsapp" | "sms" | "push";
export type TipoTrigger = "manual" | "cron_recordatorio" | "proximidad_llego" | "asignacion" | "cambio";

export type DatosNotificacion = {
  pasajeroNombre:   string;
  fecha:            string;
  hora:             string;
  paradaNombre:     string;
  paradaDireccion?: string;
  conductorNombre?: string;
  vehiculoPlaca?:   string;
  vehiculoColor?:   string;
  empresa:          string;
  empresaCliente?:  string;
};

export type ResultadoPasajero = {
  pasajeroId:   number;
  nombre:       string;
  email?:       string;
  telefono?:    string;
  canales:      { tipo: TipoCanal; estado: "enviado" | "error" | "sin_canal"; detalle?: string }[];
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Nombre + primer apellido (nunca el nombre completo), p.ej. "Carlos Alberto Ramírez Gonzáles" → "Carlos Ramírez". */
function nombreCorto(nombre: string): string {
  return nombre.trim().split(/\s+/).slice(0, 2).join(" ");
}

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

// ─── WHATSAPP (META CLOUD API — número de pasajeros) ──────────────────────────
// Los avisos a pasajeros se envían por PLANTILLA aprobada (HSM) desde el número
// dedicado META_PHONE_NUMBER_ID_PASAJEROS (distinto del de clientes/Afita).
// La plantilla `recordatorio_servicio` se crea y aprueba en el WhatsApp Manager
// de Meta. Sus variables de cuerpo, EN ESTE ORDEN, son:
//   {{1}} nombre del pasajero
//   {{2}} fecha del servicio
//   {{3}} hora de recojo
//   {{4}} paradero
//   {{5}} dirección del paradero (fallback "No especificada" si falta)
//   {{6}} conductor (fallback "Por asignar")
//   {{7}} vehículo: "PLACA (Color)" (fallback "Por asignar")
// Botones (URL): #0 "Descargar App" es ESTÁTICO (fijo en la plantilla, sin variable).
// #1 "Ver ubicación" es DINÁMICO — su {{1}} se rellena con lat,lng del paradero
// (o la dirección/nombre como respaldo si no hay coordenadas).
const PLANTILLA_RECORDATORIO = "recordatorio_servicio";
const PLANTILLA_IDIOMA       = "es";

// Plantilla del CONDUCTOR (utility). Variables del cuerpo, EN ESTE ORDEN:
//   {{1}} nombre del conductor
//   {{2}} fecha del servicio
//   {{3}} hora de salida
//   {{4}} punto de ORIGEN
//   {{5}} punto de DESTINO
//   {{6}} placa del vehículo (fallback "Por asignar")
//   {{7}} teléfono de contingencia (del directorio, es_contingencia=true)
// Botón URL DINÁMICO #0 "Ver punto de partida": {{1}} = lat,lng del primer paradero
// (fallback: dirección/origen como texto de búsqueda). Misma estructura para la
// plantilla `conductor_cambio_servicio` (solo cambia el texto fijo).
const PLANTILLA_CONDUCTOR = "recordatorio_conductor";

// Plantilla de LLEGADA (utility). Se dispara desde el motor de proximidad
// (lib/proximidad.ts) cuando el bus llega a un paradero — reutiliza esa misma
// detección (radio adaptativo + velocidad + dedupe), NO tiene lógica propia de
// GPS. Variables del cuerpo, EN ESTE ORDEN:
//   {{1}} primer nombre del pasajero (mensaje corto, se lee de un vistazo)
//   {{2}} nombre del paradero
const PLANTILLA_LLEGADA = "bus_llego_paradero";

/**
 * Phone Number ID del 2do número (avisos a pasajeros + conductores + campañas).
 * Un solo número para los 3 usos. Nombre canónico META_PHONE_NUMBER_ID_AVISOS,
 * con fallback al nombre histórico META_PHONE_NUMBER_ID_PASAJEROS.
 */
export function phoneAvisos(): string | undefined {
  return process.env.META_PHONE_NUMBER_ID_AVISOS ?? process.env.META_PHONE_NUMBER_ID_PASAJEROS;
}

/**
 * Envío de bajo nivel para el motor de alertas operativas: manda una plantilla al
 * teléfono dado desde el 2do número (avisos). Normaliza el teléfono, no lanza.
 * El dedupe/logging lo maneja el motor (lib/alertas.ts); esto solo envía.
 */
export async function enviarAvisoWhatsApp(
  telefonoRaw: string,
  plantilla: string,
  parametros: string[],
): Promise<{ ok: boolean; error?: string }> {
  const phone = phoneAvisos();
  if (!phone) return { ok: false, error: "META_PHONE_NUMBER_ID_AVISOS no configurado" };
  if (!telefonoRaw?.trim()) return { ok: false, error: "sin teléfono" };
  try {
    await enviarWhatsAppPlantilla(normalizarTelefono(telefonoRaw), plantilla, PLANTILLA_IDIOMA, parametros, phone);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com";

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

export function htmlEmailSincronizacion(d: DatosNotificacion): string {
  const row = (emoji: string, label: string, value: string) =>
    `<p style="margin:0 0 10px;font-size:13px;color:#374151;">${emoji} <span style="color:#64748b;">${label}:</span> <strong>${value}</strong></p>`;

  const empresaHeader = d.empresaCliente
    ? `<p style="color:#93c5fd;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin:0 0 8px;">${d.empresaCliente}</p>`
    : "";
  const empresaIntro = d.empresaCliente
    ? ` contratado por <strong>${d.empresaCliente}</strong>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#eef2f7;margin:0;padding:24px 16px;">
<div style="max-width:560px;margin:0 auto;">

  <div style="background:#0b315f;border-radius:16px 16px 0 0;padding:28px 24px;text-align:center;">
    <img src="${APP_URL}/logoafacotizacion-removebg-preview.png"
         alt="AFA Transportes" style="height:56px;width:auto;margin-bottom:14px;" />
    ${empresaHeader}
    <h1 style="color:white;margin:0;font-size:20px;font-weight:700;">Confirmación de Servicio</h1>
  </div>

  <div style="background:white;padding:28px 24px;">
    <p style="color:#1e293b;font-size:15px;margin:0 0 8px;">Hola <strong>${d.pasajeroNombre}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 22px;">
      Tu servicio de transporte corporativo${empresaIntro} ha sido confirmado de manera exitosa. A continuación te compartimos todos los detalles de tu viaje:
    </p>

    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:20px;margin-bottom:20px;">
      <p style="color:#0b315f;font-size:13px;font-weight:700;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #e2e8f0;">📋 Detalles del Servicio</p>
      ${d.empresaCliente ? row("🏢", "Empresa", d.empresaCliente) : ""}
      ${row("📅", "Fecha", d.fecha)}
      ${row("⏰", "Hora de recojo", d.hora)}
      ${row("📍", "Tu parada", d.paradaNombre)}
      ${d.paradaDireccion ? `<p style="margin:-4px 0 10px;font-size:12px;color:#64748b;padding-left:20px;">${d.paradaDireccion}</p>` : ""}
      ${d.conductorNombre ? row("👤", "Conductor", d.conductorNombre) : ""}
      ${d.vehiculoPlaca   ? row("🚍", "Placa del vehículo", d.vehiculoPlaca) : ""}
      ${d.vehiculoColor   ? row("🎨", "Color del vehículo", d.vehiculoColor) : ""}
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:20px;">
      <p style="color:#1e40af;font-size:13px;font-weight:700;margin:0 0 10px;">📲 ¡Monitorea tu viaje en tiempo real!</p>
      <p style="color:#374151;font-size:13px;line-height:1.6;margin:0 0 16px;">
        Descarga nuestra <strong>App Pasajero</strong> para ver la ubicación en vivo de tu unidad, recibir notificaciones de llegada y gestionar tus próximos viajes:
      </p>
      <div style="text-align:center;margin-bottom:12px;">
        <a href="https://play.google.com/store/apps/details?id=com.transportesafa.pasajero"
           style="display:inline-block;background:#0b315f;color:white;text-decoration:none;font-size:13px;font-weight:600;padding:12px 28px;border-radius:8px;line-height:1;">
          <img src="${APP_URL}/logo_android-removebg-preview.png" alt="" style="width:20px;height:20px;vertical-align:middle;margin-right:8px;" />Descargar para Android
        </a>
      </div>
      <p style="color:#64748b;font-size:11px;text-align:center;margin:0 0 16px;">🍏 Próximamente disponible en App Store (iPhone)</p>
      <div style="background:white;border-radius:8px;padding:12px 16px;border:1px solid #bfdbfe;">
        <p style="color:#1e40af;font-size:12px;font-weight:700;margin:0 0 8px;">🔑 Datos de acceso a la App:</p>
        <p style="color:#374151;font-size:12px;margin:0 0 4px;">• <strong>Usuario:</strong> Tu número de DNI</p>
        <p style="color:#374151;font-size:12px;margin:0;">• <strong>Contraseña:</strong> Los últimos 4 dígitos de tu DNI</p>
      </div>
    </div>

    <div style="background:#fefce8;border-left:4px solid #eab308;border-radius:8px;padding:14px 16px;">
      <p style="color:#854d0e;font-size:13px;font-weight:700;margin:0 0 4px;">⚠️ Nota importante</p>
      <p style="color:#713f12;font-size:13px;margin:0;line-height:1.5;">
        Por favor, <strong>espera en tu punto de abordaje 5 minutos antes</strong> de la hora indicada para evitar contratiempos. Nuestro conductor te estará esperando.
      </p>
    </div>
  </div>

  <div style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">Mensaje automático de ${d.empresa} · No responder</p>
  </div>

</div>
</body>
</html>`;
}

export function htmlEmailRecordatorio(d: DatosNotificacion): string {
  const row = (emoji: string, label: string, value: string) =>
    `<p style="margin:0 0 10px;font-size:13px;color:#374151;">${emoji} <span style="color:#64748b;">${label}:</span> <strong>${value}</strong></p>`;

  const empresaHeader = d.empresaCliente
    ? `<p style="color:#fde68a;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin:0 0 8px;">${d.empresaCliente}</p>`
    : "";
  const empresaIntro = d.empresaCliente ? ` con <strong>${d.empresaCliente}</strong>` : "";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#eef2f7;margin:0;padding:24px 16px;">
<div style="max-width:560px;margin:0 auto;">

  <div style="background:#92400e;border-radius:16px 16px 0 0;padding:28px 24px;text-align:center;">
    <img src="${APP_URL}/logoafacotizacion-removebg-preview.png"
         alt="AFA Transportes" style="height:56px;width:auto;margin-bottom:14px;" />
    ${empresaHeader}
    <h1 style="color:white;margin:0;font-size:20px;font-weight:700;">⏰ Recordatorio para Mañana</h1>
  </div>

  <div style="background:white;padding:28px 24px;">
    <p style="color:#1e293b;font-size:15px;margin:0 0 8px;">Hola <strong>${d.pasajeroNombre}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 22px;">
      Te recordamos que mañana tienes servicio de transporte${empresaIntro}. Aquí están los detalles para que te prepares:
    </p>

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:20px;margin-bottom:20px;">
      <p style="color:#92400e;font-size:13px;font-weight:700;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #fde68a;">📋 Detalles del Servicio</p>
      ${d.empresaCliente ? row("🏢", "Empresa", d.empresaCliente) : ""}
      ${row("📅", "Fecha", d.fecha)}
      ${row("⏰", "Hora de recojo", d.hora)}
      ${row("📍", "Tu parada", d.paradaNombre)}
      ${d.paradaDireccion ? `<p style="margin:-4px 0 10px;font-size:12px;color:#64748b;padding-left:20px;">${d.paradaDireccion}</p>` : ""}
      ${d.conductorNombre ? row("👤", "Conductor", d.conductorNombre) : ""}
      ${d.vehiculoPlaca   ? row("🚍", "Placa del vehículo", d.vehiculoPlaca) : ""}
      ${d.vehiculoColor   ? row("🎨", "Color del vehículo", d.vehiculoColor) : ""}
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:20px;">
      <p style="color:#1e40af;font-size:13px;font-weight:700;margin:0 0 10px;">📲 Sigue tu unidad en tiempo real</p>
      <p style="color:#374151;font-size:13px;line-height:1.6;margin:0 0 16px;">
        Si aún no tienes nuestra <strong>App Pasajero</strong>, descárgala para monitorear la ubicación de tu unidad:
      </p>
      <div style="text-align:center;margin-bottom:12px;">
        <a href="https://play.google.com/store/apps/details?id=com.transportesafa.pasajero"
           style="display:inline-block;background:#0b315f;color:white;text-decoration:none;font-size:13px;font-weight:600;padding:12px 28px;border-radius:8px;line-height:1;">
          <img src="${APP_URL}/logo_android-removebg-preview.png" alt="" style="width:20px;height:20px;vertical-align:middle;margin-right:8px;" />Descargar para Android
        </a>
      </div>
      <p style="color:#64748b;font-size:11px;text-align:center;margin:0 0 16px;">🍏 Próximamente disponible en App Store (iPhone)</p>
      <div style="background:white;border-radius:8px;padding:12px 16px;border:1px solid #bfdbfe;">
        <p style="color:#1e40af;font-size:12px;font-weight:700;margin:0 0 8px;">🔑 Datos de acceso a la App:</p>
        <p style="color:#374151;font-size:12px;margin:0 0 4px;">• <strong>Usuario:</strong> Tu número de DNI</p>
        <p style="color:#374151;font-size:12px;margin:0;">• <strong>Contraseña:</strong> Los últimos 4 dígitos de tu DNI</p>
      </div>
    </div>

    <div style="background:#fefce8;border-left:4px solid #eab308;border-radius:8px;padding:14px 16px;">
      <p style="color:#854d0e;font-size:13px;font-weight:700;margin:0 0 4px;">⚠️ Recuerda</p>
      <p style="color:#713f12;font-size:13px;margin:0;line-height:1.5;">
        <strong>Espera en tu punto de abordaje 5 minutos antes</strong> de la hora indicada. ¡Te esperamos puntual!
      </p>
    </div>
  </div>

  <div style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">Mensaje automático de ${d.empresa} · No responder</p>
  </div>

</div>
</body>
</html>`;
}

export function textoWhatsApp(d: DatosNotificacion, esRecordatorio = false): string {
  const etiqueta = d.empresaCliente || d.empresa;
  const header   = esRecordatorio
    ? `⏰ *Recordatorio - ${etiqueta}*\n\nHola *${d.pasajeroNombre}*, mañana tienes transporte:`
    : `✅ *Servicio Confirmado - ${etiqueta}*\n\nHola *${d.pasajeroNombre}*, tu transporte está confirmado:`;

  return `${header}

${d.empresaCliente ? `🏢 Empresa: *${d.empresaCliente}*\n` : ""}📅 *${d.fecha}*
⏰ Hora de recojo: *${d.hora}*
📍 Tu parada: *${d.paradaNombre}*${d.paradaDireccion ? `\n   _${d.paradaDireccion}_` : ""}${d.conductorNombre ? `\n👤 Conductor: *${d.conductorNombre}*` : ""}${d.vehiculoPlaca ? `\n🚍 Placa: *${d.vehiculoPlaca}*` : ""}${d.vehiculoColor ? `\n🎨 Color: *${d.vehiculoColor}*` : ""}

📲 *App Pasajero (Android):*
https://play.google.com/store/apps/details?id=com.transportesafa.pasajero
🔑 Usuario: tu DNI | Contraseña: últimos 4 dígitos

Por favor espera 5 minutos antes en tu parada 🙏`;
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────

/**
 * Notifica a todos los pasajeros de una reserva.
 * Canales:
 *   1. Email (si tiene email y RESEND configurado)
 *   2. WhatsApp por plantilla Meta (si tiene teléfono y META_PHONE_NUMBER_ID_PASAJEROS configurado)
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
      vehiculo_tercero_id, tipo_asignacion,
      cliente_id, cliente:clientes(nombre,empresa)
    `)
    .eq("id", reservaId)
    .single();

  if (!reserva) throw new Error(`Reserva ${reservaId} no encontrada`);

  // 2. Conductor y vehículo
  let conductorNombre: string | undefined;
  let vehiculoPlaca:   string | undefined;
  let vehiculoColor:   string | undefined;

  if (reserva.tipo_asignacion === "propio") {
    if (reserva.conductor_id) {
      const { data: c } = await supabaseAdmin.from("conductores").select("nombre").eq("id", reserva.conductor_id).single();
      conductorNombre = c?.nombre ? nombreCorto(c.nombre) : undefined;
    }
    if (reserva.vehiculo_id) {
      const { data: v } = await supabaseAdmin.from("vehiculos").select("placa, color").eq("id", reserva.vehiculo_id).single();
      vehiculoPlaca = v?.placa;
      vehiculoColor = v?.color;
    }
  } else if (reserva.vehiculo_tercero_id) {
    const { data: v } = await supabaseAdmin.from("vehiculos_tercero").select("placa, color").eq("id", reserva.vehiculo_tercero_id).single();
    vehiculoPlaca = v?.placa;
    vehiculoColor = v?.color;
  }

  // 3. Paradas de esta reserva
  const { data: paradas } = await supabaseAdmin
    .from("paradas")
    .select("id, nombre, direccion, hora_estimada, lat, lng")
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

  // Config de canales (anti-spam) + quiénes YA tienen la app (suscripción push activa).
  // Si la tabla aún no existe (migración sin correr), los defaults dejan el comportamiento
  // previo (los 3 canales a todos, sin filtrar por app).
  const { data: cfgCanalRow } = await supabaseAdmin.from("config_canales").select("*").eq("id", 1).maybeSingle();
  const canal = {
    push_activo:            cfgCanalRow?.push_activo            ?? true,
    email_activo:           cfgCanalRow?.email_activo           ?? true,
    email_solo_sin_app:     cfgCanalRow?.email_solo_sin_app     ?? false,
    whatsapp_activo:        cfgCanalRow?.whatsapp_activo        ?? true,
    whatsapp_solo_sin_app:  cfgCanalRow?.whatsapp_solo_sin_app  ?? false,
  };

  // Mapa pasajero_id → parada
  const pasajeroParada: Record<number, number> = {};
  for (const a of asignaciones) {
    if (!pasajeroParada[a.pasajero_id]) pasajeroParada[a.pasajero_id] = a.parada_id;
  }

  const empresa        = process.env.EMPRESA_NOMBRE ?? "AFA Transporte";
  const clienteJoin: any = Array.isArray(reserva.cliente) ? reserva.cliente[0] : reserva.cliente;
  const empresaCliente = clienteJoin?.empresa || clienteJoin?.nombre || undefined;
  const fechaTexto     = reserva.fecha_servicio ? formatFecha(reserva.fecha_servicio) : "-";
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
      vehiculoColor,
      empresa,
      empresaCliente,
    };

    // Canal 1: Push nativo PRIMERO — así "solo si no tiene app" se decide por la ENTREGA
    // real del push, no por la mera existencia de una suscripción (que puede estar muerta
    // sin podar). Si el push NO se entrega, email/WhatsApp SÍ salen como respaldo.
    let pushEntregado = false;
    if (canal.push_activo) try {
      const payloadPush = esRecordatorio
        ? payloadsViaje.recordatorio(reservaId, datosN.fecha, datosN.hora, datosN.paradaNombre)
        : payloadsViaje.confirmacion(reservaId, datosN.fecha, datosN.hora, datosN.paradaNombre);
      const rPush = await enviarPushAPasajeros([pas.id], payloadPush, { ttl: 43200 });
      if (rPush.enviados > 0) {
        pushEntregado = true;
        resultado.canales.push({ tipo: "push", estado: "enviado" });
        enviados++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "push", estado: "enviado", destinatario: "push", trigger });
      } else if (rPush.fallidos > 0) {
        resultado.canales.push({ tipo: "push", estado: "error", detalle: "entrega push falló" });
        errores++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "push", estado: "error", destinatario: "push", trigger, error: "entrega push falló" });
      }
    } catch (e: any) {
      console.warn("[notificaciones] canal push:", e?.message);
    }

    // Canal 2: Email (respeta config; "solo si no tiene app" = solo si NO recibió push)
    if (pas.email && process.env.RESEND_API_KEY && canal.email_activo && (!canal.email_solo_sin_app || !pushEntregado)) {
      try {
        const html    = esRecordatorio ? htmlEmailRecordatorio(datosN) : htmlEmailSincronizacion(datosN);
        const prefijo = datosN.empresaCliente ? `${datosN.empresaCliente} · ` : "";
        const subject = esRecordatorio
          ? `⏰ ${prefijo}Recordatorio mañana — ${datosN.fecha}`
          : `🚌 ${prefijo}Confirmación de servicio — AFA Transportes`;
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

    // Canal 3: WhatsApp por plantilla Meta (config; "solo si no tiene app" = solo si NO recibió push)
    if (pas.telefono && phoneAvisos() && canal.whatsapp_activo && (!canal.whatsapp_solo_sin_app || !pushEntregado)) {
      const tel = normalizarTelefono(pas.telefono);
      try {
        const vehiculoTexto = datosN.vehiculoPlaca
          ? `${datosN.vehiculoPlaca}${datosN.vehiculoColor ? ` (${datosN.vehiculoColor})` : ""}`
          : "Por asignar";
        // Botón "Ver ubicación": coordenadas del paradero si existen, si no cae a la
        // dirección/nombre como texto de búsqueda (el botón sigue siendo útil).
        const ubicacionQuery = (parada?.lat != null && parada?.lng != null)
          ? `${parada.lat},${parada.lng}`
          : (parada?.direccion || parada?.nombre || datosN.paradaNombre);
        await enviarWhatsAppPlantilla(
          tel,
          PLANTILLA_RECORDATORIO,
          PLANTILLA_IDIOMA,
          [
            datosN.pasajeroNombre,
            datosN.fecha,
            datosN.hora,
            datosN.paradaNombre,
            datosN.paradaDireccion ?? "No especificada",
            datosN.conductorNombre ?? "Por asignar",
            vehiculoTexto,
          ],
          phoneAvisos(),
          [{ index: 1, texto: encodeURIComponent(ubicacionQuery) }],
        );
        resultado.canales.push({ tipo: "whatsapp", estado: "enviado" });
        enviados++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "enviado", destinatario: tel, trigger });
      } catch (e: any) {
        resultado.canales.push({ tipo: "whatsapp", estado: "error", detalle: e.message });
        errores++;
        await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "error", destinatario: tel, trigger, error: e.message });
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

// ─── AVISO AL CONDUCTOR ────────────────────────────────────────────────────────

/**
 * Notifica al CONDUCTOR asignado a una reserva por WhatsApp (2do número). Por defecto
 * usa la plantilla `recordatorio_conductor`; el motor de alertas puede pasar otra con
 * la MISMA estructura (7 variables + botón de mapa), p.ej. `conductor_cambio_servicio`.
 * Solo aplica a asignación "propio" (los terceros gestionan su flota). No hace nada si
 * falta el 2do número o si el conductor no tiene teléfono.
 */
export async function notificarConductor(
  reservaId: number,
  trigger: TipoTrigger = "manual",
  plantilla?: string,
): Promise<{ ok: boolean; estado: "enviado" | "error" | "sin_canal"; detalle?: string }> {
  if (!phoneAvisos()) return { ok: true, estado: "sin_canal", detalle: "sin 2do número" };

  const { data: reserva } = await supabaseAdmin
    .from("reservas")
    .select(`
      id, fecha_servicio, hora_servicio, tipo_asignacion,
      conductor_id, vehiculo_id, origen, destino,
      cliente:clientes(nombre,empresa)
    `)
    .eq("id", reservaId)
    .single();

  if (!reserva) throw new Error(`Reserva ${reservaId} no encontrada`);
  if (reserva.tipo_asignacion !== "propio" || !reserva.conductor_id) {
    return { ok: true, estado: "sin_canal", detalle: "no aplica (tercero o sin conductor)" };
  }

  const { data: cond } = await supabaseAdmin
    .from("conductores")
    .select("nombre, telefono")
    .eq("id", reserva.conductor_id)
    .single();

  if (!cond?.telefono) {
    await logNotificacion({ reservaId, conductorId: reserva.conductor_id, tipo: "whatsapp", estado: "sin_canal", trigger });
    return { ok: true, estado: "sin_canal", detalle: "conductor sin teléfono" };
  }

  // Vehículo + paraderos (primer paradero = punto de partida del conductor).
  const [vR, pR] = await Promise.all([
    reserva.vehiculo_id
      ? supabaseAdmin.from("vehiculos").select("placa").eq("id", reserva.vehiculo_id).single()
      : Promise.resolve({ data: null } as any),
    supabaseAdmin.from("paradas").select("nombre, direccion, lat, lng, orden").eq("reserva_id", reservaId).order("orden"),
  ]);
  const placa = vR.data?.placa as string | undefined;
  const paradas = (pR.data ?? []) as any[];
  const primera = paradas[0];
  const ultima  = paradas[paradas.length - 1];

  const clienteJoin: any = Array.isArray(reserva.cliente) ? reserva.cliente[0] : reserva.cliente;
  const origen  = reserva.origen  || primera?.nombre || clienteJoin?.empresa || clienteJoin?.nombre || "Por confirmar";
  const destino = reserva.destino || (ultima && ultima !== primera ? ultima.nombre : null) || "Por confirmar";
  // Botón "Ver punto de partida": coordenadas reales del primer paradero; si no hay,
  // la dirección/origen como búsqueda de texto en Google Maps.
  const ubicacionQuery = (primera?.lat != null && primera?.lng != null)
    ? `${primera.lat},${primera.lng}`
    : (primera?.direccion || reserva.origen || origen);

  const fechaTexto = reserva.fecha_servicio ? formatFecha(reserva.fecha_servicio) : "-";
  const horaTexto  = reserva.hora_servicio?.slice(0, 5) ?? "-";
  const tel        = normalizarTelefono(cond.telefono);
  const telConting = await telefonoContingencia();

  try {
    await enviarWhatsAppPlantilla(
      tel,
      plantilla || PLANTILLA_CONDUCTOR,
      PLANTILLA_IDIOMA,
      [
        nombreCorto(cond.nombre),
        fechaTexto,
        horaTexto,
        origen,
        destino,
        placa ?? "Por asignar",
        telConting,
      ],
      phoneAvisos(),
      [{ index: 0, texto: encodeURIComponent(ubicacionQuery) }],
    );
    await logNotificacion({ reservaId, conductorId: reserva.conductor_id, tipo: "whatsapp", estado: "enviado", destinatario: tel, trigger });
    return { ok: true, estado: "enviado" };
  } catch (e: any) {
    await logNotificacion({ reservaId, conductorId: reserva.conductor_id, tipo: "whatsapp", estado: "error", destinatario: tel, trigger, error: e.message });
    return { ok: false, estado: "error", detalle: e.message };
  }
}

// ─── AVISO "BUS LLEGÓ AL PARADERO" ─────────────────────────────────────────────

/**
 * Avisa por WhatsApp a los pasajeros que esperan en un paradero que el bus YA
 * LLEGÓ. Se llama SOLO desde lib/proximidad.ts, justo cuando emitirEventoViaje
 * ("llego") acaba de emitirse por PRIMERA vez para ese paradero — el dedupe
 * (una vez por paradero por viaje) ya está resuelto ahí vía el índice único de
 * push_eventos_viaje; esta función no vuelve a chequear nada, confía en el llamador.
 * No lanza: un fallo de WhatsApp no debe afectar el push nativo (canal aditivo).
 */
export async function avisarLlegadaWhatsApp(
  reservaId: number,
  paradaNombre: string,
  pasajeroIds: number[],
): Promise<void> {
  if (!phoneAvisos() || pasajeroIds.length === 0) return;

  // Respeta la config de canales: si WhatsApp está apagado, no avisa; y con "solo sin app"
  // el aviso de llegada por WhatsApp solo va a quien NO tiene push (evita duplicar el push
  // de llegada que proximidad.ts ya envió).
  const { data: cfgCanalRow } = await supabaseAdmin.from("config_canales").select("whatsapp_activo, whatsapp_solo_sin_app").eq("id", 1).maybeSingle();
  const waActivo   = cfgCanalRow?.whatsapp_activo ?? true;
  const waSoloSin  = cfgCanalRow?.whatsapp_solo_sin_app ?? false;
  if (!waActivo) return;
  const { data: susc } = await supabaseAdmin
    .from("push_suscripciones").select("pasajero_id").in("pasajero_id", pasajeroIds).eq("activo", true);
  const tienePush = new Set<number>((susc || []).map((s: any) => Number(s.pasajero_id)));

  const { data: pasajeros } = await supabaseAdmin
    .from("pasajeros")
    .select("id, nombre, telefono")
    .in("id", pasajeroIds);

  for (const pas of pasajeros || []) {
    if (!pas.telefono) continue;
    if (waSoloSin && tienePush.has(pas.id)) continue; // tiene app → ya recibió el push de llegada
    const tel = normalizarTelefono(pas.telefono);
    const primerNombre = (pas.nombre || "").trim().split(/\s+/)[0] || "Hola";
    try {
      await enviarWhatsAppPlantilla(
        tel,
        PLANTILLA_LLEGADA,
        PLANTILLA_IDIOMA,
        [primerNombre, paradaNombre],
        phoneAvisos(),
      );
      await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "enviado", destinatario: tel, trigger: "proximidad_llego" });
    } catch (e: any) {
      await logNotificacion({ reservaId, pasajeroId: pas.id, tipo: "whatsapp", estado: "error", destinatario: tel, trigger: "proximidad_llego", error: e.message });
    }
  }
}

// ─── LOG ─────────────────────────────────────────────────────────────────────

async function logNotificacion({
  reservaId, pasajeroId, conductorId, tipo, estado, destinatario, trigger, error,
}: {
  reservaId:    number;
  pasajeroId?:  number;
  conductorId?: number;
  tipo:         TipoCanal;
  estado:       string;
  trigger:      TipoTrigger;
  destinatario?: string;
  error?:       string;
}) {
  const { error: eLog } = await supabaseAdmin.from("notificaciones_enviadas").insert({
    reserva_id:     reservaId,
    pasajero_id:    pasajeroId ?? null,
    // Solo incluir conductor_id cuando aplica: si la migración aún no corrió, la
    // columna no existe y PostgREST rechazaría el insert; los logs de pasajero deben
    // seguir funcionando (si no, el dedupe del cron se rompe → duplicados masivos).
    ...(conductorId != null ? { conductor_id: conductorId } : {}),
    tipo,
    estado,
    destinatario:   destinatario ?? null,
    trigger_origen: trigger,
    error_detalle:  error ?? null,
  });
  // No tragar el error en silencio: si un CHECK de la tabla rechaza un tipo nuevo
  // (p.ej. 'push'), el dedupe diario del cron dejaría de ver la reserva sin ruido.
  if (eLog) console.warn("[notificaciones] log falló:", eLog.message);
}