// Qué aviso automático le llegó a un contacto ANTES de que escribiera — para responder
// "¿por qué me está escribiendo?" cuando la conversación la abrió una respuesta a un
// recordatorio, no un mensaje espontáneo.
//
// El sistema manda recordatorios de reserva, avisos de llegada, etc. por WhatsApp
// (lib/notificaciones.ts) totalmente fuera del CRM: nunca se insertan en
// crm_mensajes/crm_conversaciones, sólo quedan logueados en `notificaciones_enviadas`
// (tabla pensada para el dedupe del cron, no para mostrarse). Sin este cruce, el
// operador ve el mensaje del cliente sin ningún rastro de qué lo provocó.
//
// Se filtra por ANTES de que empezara la conversación: mostrar avisos posteriores no
// explica nada — son cosas que pasaron después, no lo que la activó — y sólo confunden.
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
  cron_recordatorio: "Recordatorio de reserva",
  proximidad_llego: "Aviso de llegada del vehículo",
  asignacion: "Aviso de vehículo asignado",
  cambio: "Aviso de cambio en la reserva",
  manual: "Envío manual desde el ERP",
};

export const etiquetaAviso = (a: Pick<AvisoAutomatico, "trigger_origen">) =>
  ETIQUETA_TRIGGER[a.trigger_origen] ?? a.trigger_origen;

/**
 * Avisos por WhatsApp/SMS mandados a un teléfono ANTES de `antesDe` (ISO), lo más
 * recientes primero. Sin `antesDe` no filtra por fecha — úsalo sólo para depurar; en el
 * Inbox siempre se pasa el momento en que arrancó la conversación.
 *
 * Se matchea por los últimos 9 dígitos (mismo criterio que el resto del CRM, ver
 * lib/crm-telefono.ts) porque `notificaciones_enviadas.destinatario` guarda E.164 con
 * "+" y no siempre con el mismo prefijo que trae `wa_id`.
 *
 * Un mismo aviso puede haberse logueado dos veces (WhatsApp y su fallback SMS): se
 * deduplica por reserva_id + trigger_origen, quedándose con el más reciente de cada uno.
 */
export async function avisosAutomaticosDeTelefono(
  sb: SupabaseClient,
  telefonoDigits: string,
  antesDe?: string | null,
  limite = 15,
): Promise<AvisoAutomatico[]> {
  const nueve = telefonoDigits.replace(/\D/g, "").slice(-9);
  if (nueve.length < 9) return [];

  let q = sb
    .from("notificaciones_enviadas")
    .select("id, tipo, trigger_origen, reserva_id, created_at, destinatario, estado")
    .in("tipo", ["whatsapp", "sms"])
    .eq("estado", "enviado")
    .ilike("destinatario", `%${nueve}`)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (antesDe) q = q.lt("created_at", antesDe);

  const { data, error } = await q;
  if (error || !data) return [];

  const vistos = new Set<string>();
  const avisos: AvisoAutomatico[] = [];
  for (const r of data) {
    const clave = `${r.reserva_id ?? "sin-reserva"}:${r.trigger_origen}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    avisos.push({
      id: r.id, tipo: r.tipo, trigger_origen: r.trigger_origen,
      reserva_id: r.reserva_id ?? null, created_at: r.created_at,
    });
  }
  return avisos;
}
