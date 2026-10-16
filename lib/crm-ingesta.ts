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
 *
 * `telefono` se pasa SOLO en WhatsApp, donde el id del canal (`wa_id`) es el
 * número del cliente en E.164 sin "+". Hay que copiarlo porque `wa_id` es la
 * clave técnica de Meta y las pantallas del ERP leen `telefono`: sin la copia el
 * operador veía el nombre del contacto y ningún número al que llamar. En
 * Messenger/Instagram el id es opaco (fb_psid/ig_id) y no debe copiarse.
 */
export async function resolverContacto(
  sb: SB,
  opts: { campo: CampoId; valor: string; nombre?: string | null; canal: string; telefono?: string | null },
): Promise<{ id: string } | null> {
  // Sin id no se busca ni se crea: `.eq(campo, undefined)` no encuentra nada y cada
  // mensaje terminaba en un contacto nuevo sin número.
  if (!opts.valor || !String(opts.valor).trim()) return null;
  const buscar = async () =>
    (await sb.from("crm_contactos").select("id, nombre, telefono").eq(opts.campo, opts.valor).maybeSingle()).data;

  const existente = await buscar();
  if (existente) {
    const patch: Record<string, unknown> = {};
    // Un nombre real (de los contactos del celular o del perfil de WhatsApp)
    // reemplaza al marcador que se puso cuando solo se conocía el número.
    // Nunca pisa un nombre que alguien escribió a mano en el CRM.
    if (opts.nombre && opts.nombre !== opts.valor && existente.nombre === opts.valor) {
      patch.nombre = opts.nombre;
    }
    // Relleno de una sola vez para contactos anteriores: `!existente.telefono` es
    // lo que impide pisar un número corregido a mano, y esto corre en CADA mensaje.
    if (opts.telefono && !existente.telefono) patch.telefono = opts.telefono;

    if (Object.keys(patch).length > 0) {
      await sb.from("crm_contactos").update(patch).eq("id", existente.id);
    }
    return { id: existente.id };
  }

  const { data, error } = await sb
    .from("crm_contactos")
    .insert({
      nombre: opts.nombre || opts.valor,
      canal_origen: opts.canal,
      [opts.campo]: opts.valor,
      ...(opts.telefono ? { telefono: opts.telefono } : {}),
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

/**
 * Quién escribe por WhatsApp. Desde 2026 un cliente puede usar un «usuario» de WhatsApp y
 * ocultar su número: entonces el webhook no trae `from` con el teléfono sino un id por
 * empresa (BSUID, p. ej. «PE.1349…»), en `from`, `from_user_id` o `contacts[].user_id`.
 * Antes se leía solo `msg.from`: sin él, cada mensaje creaba un contacto nuevo SIN número
 * (el «Charle Herrera» ×3, con «Canal sin datos para enviar»).
 * Devuelve el id con el que se identifica al contacto (`wa_id`) y el teléfono si se conoce.
 */
export function identidadWhatsApp(msg: any, contactos?: any[]): { id: string | null; telefono: string | null } {
  const c0 = Array.isArray(contactos) ? contactos.find((c) => c?.wa_id === msg?.from || c?.user_id === msg?.from) ?? contactos[0] : null;
  const esTelefono = (v: unknown) => typeof v === "string" && /^\+?\d{8,15}$/.test(v.trim());
  const telefono = esTelefono(msg?.from) ? soloDigitos(msg.from) : esTelefono(c0?.wa_id) ? soloDigitos(c0.wa_id) : null;
  const bsuid =
    [msg?.from_user_id, c0?.user_id, msg?.from].find((v) => typeof v === "string" && v.trim() && !esTelefono(v)) ?? null;
  return { id: telefono ?? (bsuid ? String(bsuid).trim() : null), telefono };
}

/**
 * Contacto de WhatsApp. Con id (teléfono o BSUID) es el de siempre. Sin ningún id —no
 * debería pasar, pero pasó— se agrupa por el nombre del perfil entre los contactos que
 * tampoco tienen id, en vez de crear uno nuevo con cada mensaje.
 */
export async function resolverContactoWhatsApp(
  sb: SB,
  opts: { id: string | null; telefono: string | null; nombre?: string | null },
): Promise<{ id: string } | null> {
  if (opts.id) {
    return resolverContacto(sb, { campo: "wa_id", valor: opts.id, nombre: opts.nombre, canal: "whatsapp", telefono: opts.telefono });
  }
  const nombre = (opts.nombre ?? "").trim();
  if (!nombre) return null;
  const { data } = await sb
    .from("crm_contactos").select("id").eq("nombre", nombre).is("wa_id", null).eq("canal_origen", "whatsapp")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (data) return { id: data.id };
  const { data: nuevo, error } = await sb
    .from("crm_contactos").insert({ nombre, canal_origen: "whatsapp" }).select("id").single();
  if (error) { console.error("[crm-ingesta] contacto sin id:", error.message); return null; }
  return nuevo as { id: string };
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
    // Dos mensajes a la vez: el otro webhook ya la creó (índice único uq_crm_conv_abierta).
    const otra = await buscar();
    if (otra) return otra as Conversacion;
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
    msg?.document?.filename ??
    (tipo === "reaction" ? msg?.reaction?.emoji || "👍" : null) ??
    msg?.button?.text ??
    msg?.interactive?.list_reply?.title ??
    msg?.interactive?.button_reply?.title ??
    textoContactoOUbicacion(msg) ??
    null;

  return {
    tipo: tipo === "text" ? "texto" : tipo,
    contenido: texto ?? `[${tipo}]`,
    // En los webhooks la media viene por id (hay que descargarla con el token),
    // no por URL. Solo se guarda si Meta manda una directamente.
    mediaUrl: msg?.[tipo]?.url ?? msg?.image?.url ?? msg?.document?.url ?? null,
  };
}

/** Contacto compartido (tarjeta de WhatsApp) o ubicación → texto legible. Antes quedaba como
 *  «[contacts]» / «[location]»: el equipo no veía el número y la IA tampoco. */
export function textoContactoOUbicacion(msg: any): string | null {
  const tipo = String(msg?.type ?? "");
  if (tipo === "contacts" && Array.isArray(msg?.contacts)) {
    const lineas = msg.contacts.slice(0, 10).map((c: any) => {
      const nombre = c?.name?.formatted_name || [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(" ") || "Sin nombre";
      const tels = (Array.isArray(c?.phones) ? c.phones : []).map((p: any) => p?.phone || p?.wa_id).filter(Boolean);
      const org = c?.org?.company ? ` (${c.org.company})` : "";
      return `👤 ${nombre}${org}${tels.length ? `: ${tels.join(" / ")}` : ""}`;
    });
    return lineas.length ? `Contacto compartido:\n${lineas.join("\n")}` : null;
  }
  if (tipo === "location" && msg?.location) {
    const l = msg.location;
    const partes = [l.name, l.address].filter(Boolean).join(" · ");
    const mapa = l.latitude != null && l.longitude != null ? `https://maps.google.com/?q=${l.latitude},${l.longitude}` : "";
    return `📍 Ubicación${partes ? `: ${partes}` : ""}${mapa ? `\n${mapa}` : ""}`;
  }
  return null;
}
