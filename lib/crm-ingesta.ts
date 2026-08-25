// lib/crm-ingesta.ts — SOLO SERVIDOR.
//
// Resolución de contacto y conversación para todo lo que ENTRA al CRM. Estaba
// embebido en el webhook de Meta; se extrajo porque la coexistencia trae tres
// fuentes más que necesitan exactamente la misma lógica:
//
//   · mensajes entrantes del cliente        (webhook `messages`)
//   · echos de la app del celular           (webhook `smb_message_echoes`)
//   · historial de hasta 6 meses            (webhook `history`)
//
// Todas deben caer en el MISMO contacto y el MISMO hilo, o el Inbox mostraría
// tres conversaciones distintas con la misma persona.

import type { SupabaseClient } from "@supabase/supabase-js";

type SB = SupabaseClient<any, any, any>;

export type CampoId = "wa_id" | "fb_psid" | "ig_id";

/** Códigos de violación de UNIQUE en Postgres (23505) tal como los expone PostgREST. */
const DUPLICADO = "23505";

/**
 * Contacto por su id de canal, creándolo si no existe.
 *
 * Reintenta ante un choque de UNIQUE en vez de fallar: el backfill del historial
 * inserta cientos de mensajes casi a la vez y dos de ellos pueden intentar crear
 * el mismo contacto en paralelo. Con el patrón "select y luego insert" a secas,
 * uno de los dos moría con un 23505 y su mensaje se perdía.
 */
export async function resolverContacto(
  sb: SB,
  opts: { campo: CampoId; valor: string; nombre?: string | null; canal: string },
): Promise<{ id: string } | null> {
  const buscar = async () =>
    (await sb.from("crm_contactos").select("id, nombre").eq(opts.campo, opts.valor).maybeSingle()).data;

  const existente = await buscar();
  if (existente) {
    // Un nombre real (de los contactos del celular o del perfil de WhatsApp)
    // reemplaza al marcador que se puso cuando solo se conocía el número.
    // Nunca pisa un nombre que alguien escribió a mano en el CRM.
    if (opts.nombre && opts.nombre !== opts.valor && existente.nombre === opts.valor) {
      await sb.from("crm_contactos").update({ nombre: opts.nombre }).eq("id", existente.id);
    }
    return { id: existente.id };
  }

  const { data, error } = await sb
    .from("crm_contactos")
    .insert({
      nombre: opts.nombre || opts.valor,
      canal_origen: opts.canal,
      [opts.campo]: opts.valor,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === DUPLICADO) {
      const otro = await buscar();
      if (otro) return { id: otro.id };
    }
    console.error("[crm-ingesta] no se pudo crear el contacto:", error.message);
    return null;
  }
  return data as { id: string };
}

export type Conversacion = { id: string; no_leidos: number | null; ultimo_mensaje_at: string | null };

/** Conversación abierta del contacto en ese canal, creándola si no existe. */
export async function resolverConversacion(
  sb: SB,
  opts: {
    contactoId: string;
    canal: string;
    phoneNumberId?: string | null;
    displayPhoneNumber?: string | null;
  },
): Promise<Conversacion | null> {
  const buscar = async () =>
    (
      await sb
        .from("crm_conversaciones")
        .select("id, no_leidos, ultimo_mensaje_at")
        .eq("contacto_id", opts.contactoId)
        .eq("canal", opts.canal)
        .neq("estado", "resuelta")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ).data;

  const existente = await buscar();
  if (existente) return existente as Conversacion;

  const { data, error } = await sb
    .from("crm_conversaciones")
    .insert({
      contacto_id: opts.contactoId,
      canal: opts.canal,
      estado: "abierta",
      phone_number_id: opts.phoneNumberId ?? null,
      display_phone_number: opts.displayPhoneNumber ?? null,
    })
    .select("id, no_leidos, ultimo_mensaje_at")
    .single();

  if (error) {
    console.error("[crm-ingesta] no se pudo crear la conversación:", error.message);
    return null;
  }
  return data as Conversacion;
}

/** Solo dígitos, como manda Meta el wa_id ("51966707225"). */
export function soloDigitos(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** Unix en segundos (Meta lo manda como string) → ISO. */
export function isoDeTimestamp(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
}

/**
 * Texto y tipo de un mensaje de WhatsApp en el formato de la Cloud API.
 * Sirve igual para `messages`, `message_echoes` e `history`: los tres usan la
 * misma forma `{ type, <type>: { … } }`.
 */
export function contenidoDeMensaje(msg: any): { tipo: string; contenido: string; mediaUrl: string | null } {
  const tipo = String(msg?.type ?? "text");
  const texto =
    msg?.text?.body ??
    msg?.[tipo]?.caption ??
    msg?.caption ??
    msg?.button?.text ??
    msg?.interactive?.list_reply?.title ??
    msg?.interactive?.button_reply?.title ??
    null;

  return {
    tipo: tipo === "text" ? "texto" : tipo,
    contenido: texto ?? `[${tipo}]`,
    // En los webhooks la media viene por id (hay que descargarla con el token),
    // no por URL. Solo se guarda si Meta manda una directamente.
    mediaUrl: msg?.[tipo]?.url ?? msg?.image?.url ?? msg?.document?.url ?? null,
  };
}
