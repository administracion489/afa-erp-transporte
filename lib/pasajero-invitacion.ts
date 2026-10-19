// lib/pasajero-invitacion.ts
// Envío automático de la "invitación" al pasajero cuando se da de alta (individual o masivo):
//   · Correo  → credenciales completas (DNI + PIN), vía lib/pasajero-email.ts
//   · WhatsApp → SOLO invitación a descargar la app + indicaciones, SIN contraseñas
//     (plantilla Meta aprobada — un contacto nuevo no puede recibir texto libre).
//
// Nombre de la plantilla en WhatsApp Manager: debe llamarse exactamente PLANTILLA_INVITACION,
// idioma "es", número AVISOS, con dos variables {{1}} nombre y {{2}} empresa (en ese orden) y
// un botón de enlace estático a la Play Store. Mientras la plantilla no esté APPROVED en Meta,
// enviarAvisoWhatsApp devuelve error y esos envíos simplemente se cuentan como error — no rompe
// el correo ni el resto del flujo.

import { createClient } from "@supabase/supabase-js";
import { enviarCredencialEmailPasajero } from "@/lib/pasajero-email";
import { enviarAvisoWhatsApp } from "@/lib/notificaciones";
import { esFaltaDePlantilla } from "@/lib/plantilla-idioma";

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const PLANTILLA_INVITACION = "invitacion_app_pasajero";

// La versión con imagen y emojis (pedida el 18-10-2026: la de solo texto se veía «fea»). Se crea a
// mano en WhatsApp Manager, categoría UTILIDAD, con un HEADER de tipo IMAGEN y las MISMAS dos
// variables; el texto sugerido está en lib/plantillas-sugeridas.ts (SUGERIDA_INVITACION_PASAJERO).
//
// TIENE QUE SER UTILIDAD: la primera (`invitacion_pasajero_imagen`) quedó aprobada como Marketing,
// y Meta no entrega una plantilla de Marketing a quien nunca le escribió al número de avisos — lo
// acepta en el envío y la descarta minutos después (18-10-2026: no llegó hasta que la pasajera
// escribió «hola»). Un pasajero nuevo nunca escribe primero, así que esa ya no se usa.
//
// Mientras Meta no tenga esta APROBADA, el envío contesta #132001 (no se cobra) y se cae a
// PLANTILLA_INVITACION (texto): subir este cambio no deja de mandar invitaciones.
export const PLANTILLA_INVITACION_IMAGEN = "invitacion_pasajero_registro";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com").replace(/\/$/, "");
export const IMAGEN_INVITACION = `${APP_URL}/whatsapp-invitacion-pasajero.jpg`;

function nombreCorto(nombre: string): string {
  return nombre.trim().split(/\s+/).slice(0, 2).join(" ");
}

export type CanalesInvitacion = { email: boolean; whatsapp: boolean };

export type ResultadoInvitacion = {
  emailEnviados: number; emailOmitidos: number; emailErrores: number;
  whatsappEnviados: number; whatsappOmitidos: number; whatsappErrores: number;
};

/** Envía la invitación (correo con credenciales + WhatsApp sin contraseña) a los pasajeros dados,
 *  respetando los canales que el operador haya habilitado. No lanza — cuenta éxitos/errores. */
export async function enviarInvitacionesPasajeros(
  pasajeroIds: number[],
  canales: CanalesInvitacion,
): Promise<ResultadoInvitacion> {
  const res: ResultadoInvitacion = {
    emailEnviados: 0, emailOmitidos: 0, emailErrores: 0,
    whatsappEnviados: 0, whatsappOmitidos: 0, whatsappErrores: 0,
  };
  if (!pasajeroIds.length || (!canales.email && !canales.whatsapp)) return res;

  const { data: pasajeros } = await supaAdmin
    .from("pasajeros")
    .select("id, nombre, dni, email, telefono, pin_acceso, empresa")
    .in("id", pasajeroIds);
  if (!pasajeros) return res;

  const empresaAfa = process.env.EMPRESA_NOMBRE ?? "AFA Transporte";

  for (const p of pasajeros) {
    if (canales.email) {
      if (!p.email) { res.emailOmitidos++; }
      else {
        try { await enviarCredencialEmailPasajero(p); res.emailEnviados++; }
        catch { res.emailErrores++; }
      }
    }
    if (canales.whatsapp) {
      if (!p.telefono) { res.whatsappOmitidos++; }
      else {
        const params = [nombreCorto(p.nombre), p.empresa || empresaAfa];
        let r = await enviarAvisoWhatsApp(p.telefono, PLANTILLA_INVITACION_IMAGEN, params, { tipo: "image", link: IMAGEN_INVITACION });
        // Respaldo de texto si la de imagen no existe o no está aprobada (#132001, no se cobra), o si
        // Meta la rechaza en el envío por el tope de mensajes de Marketing (#131049).
        if (!r.ok && (esFaltaDePlantilla(r.error) || /#?131049\b/.test(r.error ?? "")))
          r = await enviarAvisoWhatsApp(p.telefono, PLANTILLA_INVITACION, params);
        if (r.ok) res.whatsappEnviados++; else res.whatsappErrores++;
      }
    }
  }

  return res;
}
