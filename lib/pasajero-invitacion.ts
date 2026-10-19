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

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const PLANTILLA_INVITACION = "invitacion_app_pasajero";

// La IMAGEN (pedida el 18-10-2026: solo texto se veía «fea») va en un HEADER que se le agrega a
// la MISMA plantilla editándola en WhatsApp Manager: ya está aprobada como UTILIDAD, que es lo que
// importa. Una plantilla de Marketing (`invitacion_pasajero_imagen`, ya no se usa) Meta no la
// entrega a quien nunca le escribió al número de avisos: la acepta y la descarta minutos después
// (18-10-2026: no llegó hasta que la pasajera escribió «hola»), y un pasajero nuevo no escribe primero.
//
// Mientras la edición no esté aprobada, la plantilla NO tiene header y Meta rechaza el envío que
// trae imagen (#132000 / #132012, no se cobra): se reintenta sin imagen. Así el código sirve antes y
// después de la edición, y si un día se le quita la imagen tampoco deja de invitar.
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com").replace(/\/$/, "");
export const IMAGEN_INVITACION = `${APP_URL}/whatsapp-invitacion-pasajero.jpg`;

/** Meta rechaza el envío porque los parámetros (aquí, la imagen) no calzan con la plantilla. */
export function esHeaderQueNoCalza(error: unknown): boolean {
  return typeof error === "string" && /#?13201[2-5]\b|#?132000\b/.test(error);
}

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
        let r = await enviarAvisoWhatsApp(p.telefono, PLANTILLA_INVITACION, params, { tipo: "image", link: IMAGEN_INVITACION });
        if (!r.ok && esHeaderQueNoCalza(r.error))
          r = await enviarAvisoWhatsApp(p.telefono, PLANTILLA_INVITACION, params);
        if (r.ok) res.whatsappEnviados++; else res.whatsappErrores++;
      }
    }
  }

  return res;
}
