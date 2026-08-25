// lib/crm-coexistencia.ts — SOLO SERVIDOR.
//
// Los tres webhooks que Meta manda SOLO cuando un número está en coexistencia
// (sigue usándose en la app WhatsApp Business del celular y además está en la
// Cloud API). Ninguno existe en una integración de API pura, y por eso el webhook
// del ERP no los conocía:
//
//   smb_message_echoes  → lo que el dueño escribe DESDE EL CELULAR. Entra al hilo
//                         como mensaje SALIENTE. Es la mitad que faltaba: sin
//                         esto, el Inbox mostraba la pregunta del cliente y nunca
//                         la respuesta, porque se había dado por el teléfono.
//   history             → hasta 6 meses de conversaciones anteriores al conectar.
//   smb_app_state_sync  → los contactos de la agenda del celular.
//
// Los tres se procesan sin disparar el agente IA: son mensajes que ya escribió
// una persona, o conversaciones viejas. Contestarlos sería hablar solo.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolverContacto,
  resolverConversacion,
  soloDigitos,
  isoDeTimestamp,
  contenidoDeMensaje,
} from "@/lib/crm-ingesta";

type SB = SupabaseClient<any, any, any>;

/** Columnas que añade supabase/whatsapp-coexistencia.sql. */
type Extra = Record<string, unknown>;

/**
 * Inserta en crm_mensajes tolerando que la migración de coexistencia aún no se
 * haya corrido: si Postgres se queja de una columna inexistente, reintenta sin
 * las columnas nuevas. Mejor un mensaje guardado sin su etiqueta de origen que un
 * mensaje perdido — y el webhook nunca debe devolver error a Meta.
 */
async function insertarMensaje(sb: SB, fila: Record<string, unknown>, extra: Extra): Promise<boolean> {
  const { error } = await sb.from("crm_mensajes").insert({ ...fila, ...extra });
  if (!error) return true;

  // 23505 = ya existe ese meta_message_id. Es el dedupe funcionando: Meta reenvía
  // el mismo webhook ante cualquier duda, y el historial puede solaparse con lo
  // que ya llegó en vivo.
  if (error.code === "23505") return false;

  if (/column .* does not exist/i.test(error.message)) {
    const { error: err2 } = await sb.from("crm_mensajes").insert(fila);
    if (!err2) return true;
    if (err2.code === "23505") return false;
    console.error("[coexistencia] no se pudo guardar el mensaje:", err2.message);
    return false;
  }

  console.error("[coexistencia] no se pudo guardar el mensaje:", error.message);
  return false;
}

/** Actualiza la conversación tolerando columnas que aún no existan. */
async function actualizarConversacion(sb: SB, id: string, patch: Record<string, unknown>, extra: Extra) {
  const { error } = await sb.from("crm_conversaciones").update({ ...patch, ...extra }).eq("id", id);
  if (error && /column .* does not exist/i.test(error.message)) {
    await sb.from("crm_conversaciones").update(patch).eq("id", id);
  }
}

// ── 1) Echos: lo que se responde desde el celular ──────────────────────────

/**
 * `value.message_echoes[]` — cada uno con `from` = el número de la empresa y
 * `to` = el cliente. Son SIEMPRE salientes.
 *
 * Efecto lateral importante y deliberado: pausa el agente IA en ese hilo (si el
 * agente tiene `pausar_si_responde_humano`, que viene activado). Con coexistencia
 * una persona y la IA pueden estar contestando el mismo chat a la vez, y el
 * cliente recibiría dos respuestas distintas. Quien escribió desde el teléfono
 * se queda al mando; la IA se reanuda desde el Inbox cuando quieran.
 */
export async function procesarEchos(sb: SB, value: any): Promise<number> {
  const echos: any[] = value?.message_echoes ?? [];
  if (echos.length === 0) return 0;

  const phoneNumberId = value?.metadata?.phone_number_id ?? null;
  const displayPhone = value?.metadata?.display_phone_number
    ? soloDigitos(value.metadata.display_phone_number)
    : null;

  // Se consulta una vez por lote, no por mensaje.
  const pausarIA = await agentePausaConHumano(sb);

  let guardados = 0;
  for (const eco of echos) {
    const cliente = soloDigitos(eco?.to);
    const idMensaje = eco?.id ? String(eco.id) : null;
    if (!cliente || !idMensaje) continue;

    const contacto = await resolverContacto(sb, {
      campo: "wa_id",
      valor: cliente,
      canal: "whatsapp",
    });
    if (!contacto) continue;

    const conv = await resolverConversacion(sb, {
      contactoId: contacto.id,
      canal: "whatsapp",
      phoneNumberId,
      displayPhoneNumber: displayPhone,
    });
    if (!conv) continue;

    const { tipo, contenido, mediaUrl } = contenidoDeMensaje(eco);
    const cuando = isoDeTimestamp(eco?.timestamp);

    // created_at explícito: el Inbox ordena el hilo por esa columna, así que un
    // echo tiene que quedar en el minuto en que se escribió, no en el que llegó.
    const ok = await insertarMensaje(
      sb,
      {
        conversacion_id: conv.id,
        direccion: "saliente",
        tipo,
        contenido,
        media_url: mediaUrl,
        meta_message_id: idMensaje,
        created_at: cuando,
      },
      { origen: "app_movil", phone_number_id: phoneNumberId, display_phone_number: displayPhone },
    );
    if (!ok) continue;
    guardados++;

    await actualizarConversacion(
      sb,
      conv.id,
      {
        ultimo_mensaje_at: cuando,
        // Alguien la está atendiendo de verdad: que se vea así en el Inbox.
        estado: "en_progreso",
      },
      pausarIA ? { ia_pausada: true } : {},
    );
  }
  return guardados;
}

/** ¿El agente está configurado para cederle el hilo a quien contesta desde el celular? */
async function agentePausaConHumano(sb: SB): Promise<boolean> {
  const { data, error } = await sb
    .from("crm_agentes_ia")
    .select("pausar_si_responde_humano")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  // Sin migración corrida o sin agente: el comportamiento seguro es pausar.
  if (error || !data) return true;
  return data.pausar_si_responde_humano !== false;
}

// ── 2) Historial: hasta 6 meses de conversaciones previas ──────────────────

/**
 * `value.history[].threads[].messages[]`. La dirección se deduce comparando
 * `from` con el número de la empresa (`metadata.display_phone_number`).
 *
 * Nunca incrementa `no_leidos` ni dispara la IA: son conversaciones que ya
 * ocurrieron, muchas cerradas hace meses. Marcar 500 hilos como no leídos al
 * conectar el número haría inservible el Inbox el primer día.
 */
export async function procesarHistorial(sb: SB, value: any): Promise<number> {
  const bloques: any[] = value?.history ?? [];
  if (bloques.length === 0) return 0;

  const phoneNumberId = value?.metadata?.phone_number_id ?? null;
  const empresa = soloDigitos(value?.metadata?.display_phone_number);

  let guardados = 0;
  for (const bloque of bloques) {
    for (const hilo of bloque?.threads ?? []) {
      const mensajes: any[] = hilo?.messages ?? [];
      if (mensajes.length === 0) continue;

      // El id del hilo ES el número del cliente. Si falta (algún chunk viene sin
      // él), se deduce del primer mensaje que tenga las dos puntas.
      let cliente = soloDigitos(hilo?.id);
      if (!cliente) {
        for (const m of mensajes) {
          const de = soloDigitos(m?.from);
          const para = soloDigitos(m?.to);
          if (!de && !para) continue;
          cliente = empresa && de === empresa ? para : de;
          if (cliente) break;
        }
      }
      if (!cliente) continue;

      // Contacto y conversación se resuelven UNA VEZ POR HILO, no por mensaje.
      // Un backfill de seis meses son miles de mensajes: resolverlos uno a uno
      // eran dos consultas por mensaje y el webhook no alcanzaba a responderle a
      // Meta antes de que reintentara.
      const contacto = await resolverContacto(sb, { campo: "wa_id", valor: cliente, canal: "whatsapp" });
      if (!contacto) continue;

      const conv = await resolverConversacion(sb, {
        contactoId: contacto.id,
        canal: "whatsapp",
        phoneNumberId,
        displayPhoneNumber: empresa || null,
      });
      if (!conv) continue;

      let masReciente = conv.ultimo_mensaje_at ? Date.parse(conv.ultimo_mensaje_at) : 0;

      for (const m of mensajes) {
        const idMensaje = m?.id ? String(m.id) : null;
        if (!idMensaje) continue;

        const esSaliente = !!empresa && soloDigitos(m?.from) === empresa;
        const { tipo, contenido, mediaUrl } = contenidoDeMensaje(m);
        const cuando = isoDeTimestamp(m?.timestamp);

        const ok = await insertarMensaje(
          sb,
          {
            conversacion_id: conv.id,
            direccion: esSaliente ? "saliente" : "entrante",
            tipo,
            contenido,
            media_url: mediaUrl,
            meta_message_id: idMensaje,
            created_at: cuando,
          },
          { origen: "historial", phone_number_id: phoneNumberId, display_phone_number: empresa || null },
        );
        if (!ok) continue;
        guardados++;
        masReciente = Math.max(masReciente, Date.parse(cuando) || 0);
      }

      // Una sola actualización por hilo, y `ultimo_mensaje_at` solo AVANZA: el
      // historial llega en trozos y sin orden garantizado, así que dejar que un
      // mensaje de hace cinco meses pise la fecha del último mensaje real
      // desordenaría toda la bandeja.
      const actual = conv.ultimo_mensaje_at ? Date.parse(conv.ultimo_mensaje_at) : 0;
      await actualizarConversacion(
        sb,
        conv.id,
        masReciente > actual ? { ultimo_mensaje_at: new Date(masReciente).toISOString() } : {},
        { historial_importado: true },
      );
    }
  }
  return guardados;
}

// ── 3) Contactos de la agenda del celular ──────────────────────────────────

/**
 * `value.state_sync[]` con `type: "contact"`. Trae el nombre con el que la empresa
 * tiene guardado a cada cliente en el teléfono, que casi siempre es mejor que el
 * nombre del perfil de WhatsApp ("Sr. Ramírez · Pepsico" vs "Junior").
 *
 * `action: "remove"` se ignora a propósito: que alguien borre un contacto del
 * celular no es motivo para perder su ficha y su historial en el CRM.
 */
export async function procesarContactos(sb: SB, value: any): Promise<number> {
  const eventos: any[] = value?.state_sync ?? [];
  if (eventos.length === 0) return 0;

  let procesados = 0;
  for (const ev of eventos) {
    if (ev?.type !== "contact") continue;
    if (ev?.action && String(ev.action).toLowerCase() === "remove") continue;

    const telefono = soloDigitos(ev?.contact?.phone_number);
    if (!telefono) continue;

    const nombre: string | null =
      ev?.contact?.full_name?.trim() || ev?.contact?.first_name?.trim() || null;

    const contacto = await resolverContacto(sb, {
      campo: "wa_id",
      valor: telefono,
      nombre,
      canal: "whatsapp",
    });
    if (contacto) procesados++;
  }
  return procesados;
}
