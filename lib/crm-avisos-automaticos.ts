// Qué aviso automático le llegó a un contacto antes de que escribiera.
//
// El sistema manda recordatorios de reserva, avisos de llegada, etc. por WhatsApp
// (lib/notificaciones.ts) totalmente fuera del CRM: nunca se insertan en
// crm_mensajes/crm_conversaciones, sólo quedan logueados en `notificaciones_enviadas`
// (tabla pensada para el dedupe del cron, no para mostrarse). Resultado: alguien
// responde a un recordatorio, entra al Inbox por el webhook, y el operador ve el
// mensaje del cliente sin ningún rastro de qué lo provocó — parece que escribió por
// su cuenta. Esto reconstruye ese rastro para pintarlo en el Inbox.
//
// No hay texto guardado del mensaje enviado (esa tabla no lo loguea, sólo tipo/estado/
// trigger/fecha), así que esto NUNCA finge mostrar "lo que se le mandó" literal — sólo
// que se le mandó algo, qué lo disparó y cuándo.

import type { SupabaseClient } from "@supabase/supabase-js";

export type AvisoAutomatico = {
  id: number;
  tipo: "email" | "whatsapp" | "sms" | "push";
  trigger_origen: string;
  reserva_id: number | null;
  created_at: string;
};

const ETIQUETA_TRIGGER: Record<string, string> = {
  cron_recordatorio: "Recordatorio de reserva (automático, 8am)",
  proximidad_llego: "Aviso de llegada del vehículo",
  asignacion: "Aviso de conductor/vehículo asignado",
  cambio: "Aviso de cambio en la reserva",
  manual: "Envío manual desde el ERP",
};

export const etiquetaAviso = (a: Pick<AvisoAutomatico, "trigger_origen">) =>
  ETIQUETA_TRIGGER[a.trigger_origen] ?? a.trigger_origen;

/**
 * Últimos avisos por WhatsApp/SMS mandados a un teléfono. Se matchea por los últimos 9
 * dígitos (mismo criterio que el resto del CRM, ver lib/crm-telefono.ts) porque
 * `notificaciones_enviadas.destinatario` guarda E.164 con "+" y no siempre con el mismo
 * prefijo que trae `wa_id`.
 */
export async function avisosAutomaticosDeTelefono(
  sb: SupabaseClient,
  telefonoDigits: string,
  limite = 5,
): Promise<AvisoAutomatico[]> {
  const nueve = telefonoDigits.replace(/\D/g, "").slice(-9);
  if (nueve.length < 9) return [];

  const { data, error } = await sb
    .from("notificaciones_enviadas")
    .select("id, tipo, trigger_origen, reserva_id, created_at, destinatario, estado")
    .in("tipo", ["whatsapp", "sms"])
    .eq("estado", "enviado")
    .ilike("destinatario", `%${nueve}`)
    .order("created_at", { ascending: false })
    .limit(limite);

  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id, tipo: r.tipo, trigger_origen: r.trigger_origen,
    reserva_id: r.reserva_id ?? null, created_at: r.created_at,
  })) as AvisoAutomatico[];
}
