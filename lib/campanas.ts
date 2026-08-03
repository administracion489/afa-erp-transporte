// lib/campanas.ts — SOLO SERVIDOR.
// Motor de campañas (WhatsApp marketing por plantilla / Email por Resend) sobre
// los contactos del CRM.
//
// NÚMERO DE SALIDA = el del CRM (+51 966707225, META_PHONE_NUMBER_ID), el mismo por el
// que el contacto ya conversa con atención al cliente. NO se usa el número de avisos
// (905438216), que queda reservado a notificaciones de pasajeros/conductores.
//
// Reglas de consentimiento incorporadas:
//   • WhatsApp: SOLO contactos con opt-in (wa_opt_in = quien ya te escribió) y sin
//     baja (wa_baja). NUNCA outreach en frío por WhatsApp (política de Meta → baneo).
//   • Email: permitido a cualquier contacto con correo que no se haya dado de baja
//     (email_baja), incluyendo prospectos en frío.
//
// Flujo: sembrarEnvios() crea filas campanas_envios (idempotente por destinatario)
// → procesarCampana() RECLAMA lotes de forma atómica (RPC reclamar_envios con FOR
// UPDATE SKIP LOCKED) y los procesa con throttling. El reclamo atómico evita el
// doble envío cuando el cron y el botón "Continuar" corren a la vez.

import { createClient } from "@supabase/supabase-js";
import { enviarWhatsAppPlantilla } from "@/lib/crm-meta";
import { phonePara } from "@/lib/whatsapp-numeros";
import { enviarEmail } from "@/lib/notificaciones";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Espaciado entre envíos (número nuevo → arrancar conservador, ~4 msg/s).
const THROTTLE_MS = 250;
// Lote pequeño para caber holgado en maxDuration=60s (40×250ms=10s + red ≈ 30s).
const LOTE = 40;

type Contacto = {
  id: string;
  nombre: string | null;
  empresa: string | null;
  wa_id: string | null;
  email: string | null;
  gmail_email: string | null;
  cliente_id: number | null;
  wa_opt_in: boolean | null;
  wa_baja: boolean | null;
  email_baja: boolean | null;
};

export type Campana = {
  id: string;
  nombre: string;
  canal: "whatsapp" | "email";
  plantilla: string | null;
  idioma: string | null;
  parametros: string[] | null;   // p.ej. ["{{nombre}}"] → personalizado por contacto
  asunto: string | null;
  cuerpo: string | null;
  audiencia: { segmento?: "todos" | "clientes" | "prospectos" } | null;
  estado: string;
};

/** Destinatario canónico por canal (email en minúsculas para deduplicar bien). */
function destinatarioDe(c: Contacto, canal: "whatsapp" | "email"): string {
  if (canal === "whatsapp") return (c.wa_id ?? "").trim();
  return (c.email || c.gmail_email || "").trim().toLowerCase();
}

// ─── AUDIENCIA ─────────────────────────────────────────────────────────────

/** Resuelve la lista de contactos elegibles según canal + consentimiento + segmento. */
export async function resolverAudiencia(c: Campana): Promise<Contacto[]> {
  let q = db
    .from("crm_contactos")
    .select("id, nombre, empresa, wa_id, email, gmail_email, cliente_id, wa_opt_in, wa_baja, email_baja");

  const seg = c.audiencia?.segmento ?? "todos";
  if (seg === "clientes")   q = q.not("cliente_id", "is", null);
  if (seg === "prospectos") q = q.is("cliente_id", null);

  const { data, error } = await q;
  if (error) throw new Error(`Audiencia: ${error.message}`);
  const contactos = (data ?? []) as Contacto[];

  if (c.canal === "whatsapp") {
    // Cumplimiento: solo opt-in y sin baja. Prospectos en frío quedan fuera.
    return contactos.filter((x) => x.wa_id && x.wa_opt_in && !x.wa_baja);
  }
  // Email: cualquiera con correo que no se haya dado de baja.
  return contactos.filter((x) => (x.email || x.gmail_email) && !x.email_baja);
}

// ─── SEMBRAR ENVÍOS ─────────────────────────────────────────────────────────

/** Crea filas campanas_envios (pendiente) para la audiencia. Idempotente y sin
 *  duplicados por destinatario (dos contactos con el mismo correo → un solo envío). */
export async function sembrarEnvios(campanaId: string): Promise<{ total: number }> {
  const { data: c } = await db.from("campanas").select("*").eq("id", campanaId).single();
  if (!c) throw new Error("Campaña no encontrada");

  const campana = c as Campana;
  const audiencia = await resolverAudiencia(campana);

  // Deduplicar por destinatario ANTES de insertar (protege el caso email compartido).
  const porDestinatario = new Map<string, { campana_id: string; contacto_id: string; destinatario: string; estado: string }>();
  for (const x of audiencia) {
    const dest = destinatarioDe(x, campana.canal);
    if (!dest) continue;
    if (!porDestinatario.has(dest)) {
      porDestinatario.set(dest, { campana_id: campanaId, contacto_id: x.id, destinatario: dest, estado: "pendiente" });
    }
  }
  const filas = [...porDestinatario.values()];

  if (filas.length) {
    // onConflict por destinatario (índice único uq_campana_destinatario); ignoreDuplicates
    // no re-crea filas ya sembradas → seguro re-sembrar.
    const { error } = await db
      .from("campanas_envios")
      .upsert(filas, { onConflict: "campana_id,destinatario", ignoreDuplicates: true });
    if (error) throw new Error(`Sembrar envíos: ${error.message}`);
  }

  const { count } = await db
    .from("campanas_envios")
    .select("id", { count: "exact", head: true })
    .eq("campana_id", campanaId);

  await db.from("campanas").update({ total: count ?? filas.length, updated_at: new Date().toISOString() }).eq("id", campanaId);
  return { total: count ?? filas.length };
}

// ─── PROCESAR ────────────────────────────────────────────────────────────────

/** Sustituye {{campo}} por datos del contacto (nombre, empresa). */
function personalizar(valor: string, ctx: { nombre?: string; empresa?: string }): string {
  return valor
    .replace(/\{\{\s*nombre\s*\}\}/gi, ctx.nombre || "")
    .replace(/\{\{\s*empresa\s*\}\}/gi, ctx.empresa || "");
}

/**
 * Reclama un lote atómico de pendientes y lo procesa con throttling. Idempotente y
 * reentrante: se puede llamar en paralelo (cron + botón) sin doble envío, porque el
 * RPC reclamar_envios entrega lotes disjuntos (FOR UPDATE SKIP LOCKED).
 */
export async function procesarCampana(
  campanaId: string,
  opts: { max?: number } = {},
): Promise<{ ok: boolean; procesados: number; restantes: number; estado: string }> {
  const max = opts.max ?? LOTE;

  const { data: c } = await db.from("campanas").select("*").eq("id", campanaId).single();
  if (!c) throw new Error("Campaña no encontrada");
  const campana = c as Campana;
  if (campana.estado === "cancelada") return { ok: false, procesados: 0, restantes: 0, estado: "cancelada" };
  // Número de salida de las campañas: el marcado `usa_campanas` en whatsapp_numeros,
  // con respaldo a META_PHONE_NUMBER_ID. Se resuelve una vez por lote, no por envío.
  const phoneCampanas = campana.canal === "whatsapp" ? await phonePara("campanas") : undefined;
  if (campana.canal === "whatsapp" && !phoneCampanas) {
    throw new Error(
      "No hay número de WhatsApp para campañas: marca uno con `usa_campanas` en whatsapp_numeros " +
        "o configura META_PHONE_NUMBER_ID.",
    );
  }

  // Recuperación: re-encolar filas 'procesando' colgadas (worker que murió a mitad).
  await db
    .from("campanas_envios")
    .update({ estado: "pendiente", procesando_at: null })
    .eq("campana_id", campanaId)
    .eq("estado", "procesando")
    .lt("procesando_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  await db.from("campanas").update({ estado: "enviando" }).eq("id", campanaId);

  // Reclamo atómico del lote (marca 'procesando' y lo devuelve).
  const { data: reclamados, error: eRpc } = await db.rpc("reclamar_envios", { p_campana: campanaId, p_max: max });
  if (eRpc) throw new Error(`reclamar_envios: ${eRpc.message}`);
  const lote = (reclamados ?? []) as { id: string; destinatario: string; contacto_id: string | null }[];

  // Datos de contacto para personalizar + respetar bajas de último minuto.
  const ids = lote.map((r) => r.contacto_id).filter(Boolean) as string[];
  const contactosMap: Record<string, any> = {};
  if (ids.length) {
    const { data: cts } = await db
      .from("crm_contactos")
      .select("id, nombre, empresa, wa_baja, email_baja")
      .in("id", ids);
    for (const ct of cts ?? []) contactosMap[ct.id] = ct;
  }

  let procesados = 0;
  for (const envio of lote) {
    const ct = envio.contacto_id ? contactosMap[envio.contacto_id] : null;
    const nombre  = ct?.nombre ?? undefined;
    const empresa = ct?.empresa ?? undefined;

    const dioBaja = campana.canal === "whatsapp" ? ct?.wa_baja : ct?.email_baja;
    if (dioBaja) {
      await db.from("campanas_envios").update({ estado: "omitido", motivo: "baja" }).eq("id", envio.id);
      procesados++;
      continue;
    }

    try {
      let metaId: string | null = null;
      if (campana.canal === "whatsapp") {
        const params = (campana.parametros ?? []).map((p) => personalizar(p, { nombre, empresa }));
        metaId = await enviarWhatsAppPlantilla(
          envio.destinatario,
          campana.plantilla!,
          campana.idioma ?? "es",
          params,
          phoneCampanas,
        );
      } else {
        const asunto = personalizar(campana.asunto ?? "", { nombre, empresa });
        const html   = personalizar(campana.cuerpo ?? "", { nombre, empresa });
        await enviarEmail({ to: envio.destinatario, subject: asunto, html });
      }
      await db.from("campanas_envios")
        .update({ estado: "enviado", meta_message_id: metaId, enviado_at: new Date().toISOString() })
        .eq("id", envio.id);
    } catch (e: any) {
      await db.from("campanas_envios")
        .update({ estado: "error", error: e.message })
        .eq("id", envio.id);
    }
    procesados++;
    await sleep(THROTTLE_MS);
  }

  // Contadores agregados desde la tabla (fuente de verdad), con chequeo de error:
  // si el conteo de pendientes/procesando falla, NO marcar 'enviada' (dejar 'enviando'
  // para que el cron reintente) y no regresar contadores derivados de queries fallidas.
  const [rEnv, rErr, rOmi, rPend, rProc] = await Promise.all([
    db.from("campanas_envios").select("id", { count: "exact", head: true }).eq("campana_id", campanaId).eq("estado", "enviado"),
    db.from("campanas_envios").select("id", { count: "exact", head: true }).eq("campana_id", campanaId).eq("estado", "error"),
    db.from("campanas_envios").select("id", { count: "exact", head: true }).eq("campana_id", campanaId).eq("estado", "omitido"),
    db.from("campanas_envios").select("id", { count: "exact", head: true }).eq("campana_id", campanaId).eq("estado", "pendiente"),
    db.from("campanas_envios").select("id", { count: "exact", head: true }).eq("campana_id", campanaId).eq("estado", "procesando"),
  ]);

  if (rPend.error || rProc.error) {
    // No se pudo determinar lo restante: mantener 'enviando' para que el cron reintente.
    return { ok: true, procesados, restantes: -1, estado: "enviando" };
  }

  const restantes = (rPend.count ?? 0) + (rProc.count ?? 0);
  const estadoFinal = restantes === 0 ? "enviada" : "enviando";
  const upd: any = { estado: estadoFinal, updated_at: new Date().toISOString() };
  if (!rEnv.error) upd.enviados = rEnv.count;
  if (!rErr.error) upd.errores  = rErr.count;
  if (!rOmi.error) upd.omitidos = rOmi.count;
  await db.from("campanas").update(upd).eq("id", campanaId);

  return { ok: true, procesados, restantes, estado: estadoFinal };
}
