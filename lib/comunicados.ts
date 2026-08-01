// lib/comunicados.ts — SOLO SERVIDOR.
// Motor de COMUNICADOS: envíos masivos (WhatsApp + Correo) a los pasajeros de una
// empresa cliente. Calcado del motor de Campañas del CRM (lib/campanas.ts) pero con
// tablas propias (comunicados / comunicados_envios) para no mezclar avisos operativos
// a pasajeros con el marketing del CRM.
//
// NÚMERO DE SALIDA WhatsApp = el de AVISOS (META_PHONE_NUMBER_ID_AVISOS), el mismo por
// el que ya salen recordatorios a pasajeros. NO usa el número del CRM.
//
// WhatsApp usa una PLANTILLA con encabezado de DOCUMENTO (un PDF con los cuadros). El
// PDF se arma a partir de las imágenes adjuntas (construirPdfDesdeImagenes) y se guarda
// en el bucket público comunicados-media.
//
// Flujo: (opcional) construirPdfDesdeImagenes → sembrarEnvios() crea filas
// comunicados_envios (idempotente por canal+destinatario) → procesarComunicado()
// RECLAMA lotes atómicos (RPC reclamar_comunicados, FOR UPDATE SKIP LOCKED) y los
// procesa con throttling. El reclamo atómico evita el doble envío entre cron y botón.

import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { enviarWhatsAppPlantilla } from "@/lib/crm-meta";
import { enviarEmail, phoneAvisos } from "@/lib/notificaciones";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THROTTLE_MS = 250;              // ~4 msg/s
const LOTE = 40;                       // cabe en maxDuration=60s
const BUCKET = "comunicados-media";
// Plantilla por defecto (encabezado documento). Se puede sobreescribir por comunicado
// (comunicados.wa_plantilla) o por env (META_TEMPLATE_COMUNICADO).
const PLANTILLA_DEFECTO = process.env.META_TEMPLATE_COMUNICADO ?? "comunicado_afa";

export type Comunicado = {
  id: string;
  titulo: string;
  cliente_id: number | null;
  canales: ("whatsapp" | "email")[];
  asunto: string | null;
  cuerpo_html: string | null;
  mensaje_wa: string | null;
  wa_plantilla: string | null;
  wa_idioma: string | null;
  adjuntos: { url: string; nombre?: string; tipo?: string; esImagen?: boolean }[] | null;
  wa_pdf_url: string | null;
  solo_nomina_fija: boolean | null;
  estado: string;
};

type Pasajero = { id: number; nombre: string | null; telefono: string | null; email: string | null };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Normaliza teléfono peruano a E.164: 987654321 → +51987654321 (igual que notificaciones.ts). */
function normalizarTelefono(tel: string): string {
  const limpio = tel.replace(/\D/g, "");
  if (limpio.startsWith("51") && limpio.length === 11) return "+" + limpio;
  if (limpio.length === 9) return "+51" + limpio;
  return "+" + limpio;
}

/** Nombre + primer apellido (mensaje más natural que el nombre completo). */
function nombreCorto(nombre: string | null): string {
  return (nombre ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
}

function personalizar(valor: string, ctx: { nombre?: string; empresa?: string }): string {
  return valor
    .replace(/\{\{\s*nombre\s*\}\}/gi, ctx.nombre || "")
    .replace(/\{\{\s*empresa\s*\}\}/gi, ctx.empresa || "");
}

/** HTML final del correo: cuerpo del operador + los cuadros incrustados como imágenes. */
function htmlCorreo(com: Comunicado, ctx: { nombre?: string; empresa?: string }): string {
  const cuerpo = personalizar(com.cuerpo_html ?? "", ctx);
  const imgs = (com.adjuntos ?? [])
    .filter((a) => a.esImagen)
    .map((a) => `<div style="margin:14px 0"><img src="${a.url}" alt="${a.nombre ?? "adjunto"}" style="max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px" /></div>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">${cuerpo}${imgs}</div>`;
}

// ─── PDF (cuadros → un solo documento para WhatsApp + adjunto de correo) ───────

/**
 * Arma un PDF con una página por imagen (a tamaño de la propia imagen), lo sube al
 * bucket público comunicados-media y devuelve su URL pública. Usado por la ruta de
 * envío para preparar comunicados.wa_pdf_url cuando el canal WhatsApp está activo.
 */
export async function construirPdfDesdeImagenes(
  urls: string[],
  nombreArchivo = "Horarios.pdf",
): Promise<string | null> {
  const imgUrls = urls.filter(Boolean);
  if (!imgUrls.length) return null;

  const pdf = await PDFDocument.create();
  for (const url of imgUrls) {
    const resp = await fetch(url);
    if (!resp.ok) continue;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // Detección por magic bytes: PNG (0x89 0x50) vs JPEG (0xFF 0xD8).
    const esPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const img = esPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  if (pdf.getPageCount() === 0) return null;

  const out = await pdf.save();
  const path = `pdf/${Date.now()}-${nombreArchivo}`;
  const { error } = await db.storage.from(BUCKET).upload(path, out, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw new Error(`Subir PDF: ${error.message}`);
  return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl ?? null;
}

// ─── AUDIENCIA ─────────────────────────────────────────────────────────────

/** Pasajeros de la empresa cliente (nómina fija por defecto: reserva_id IS NULL). */
export async function resolverAudiencia(com: Comunicado): Promise<Pasajero[]> {
  if (!com.cliente_id) return [];
  let q = db
    .from("pasajeros")
    .select("id, nombre, telefono, email")
    .eq("cliente_id", com.cliente_id);
  if (com.solo_nomina_fija !== false) q = q.is("reserva_id", null);
  const { data, error } = await q;
  if (error) throw new Error(`Audiencia: ${error.message}`);
  return (data ?? []) as Pasajero[];
}

/** Conteo para la vista previa de la UI. */
export async function contarAudiencia(
  clienteId: number,
  soloNominaFija = true,
): Promise<{ total: number; conTelefono: number; conCorreo: number }> {
  let q = db.from("pasajeros").select("telefono, email").eq("cliente_id", clienteId);
  if (soloNominaFija) q = q.is("reserva_id", null);
  const { data } = await q;
  const rows = (data ?? []) as { telefono: string | null; email: string | null }[];
  const tel = new Set<string>();
  const mail = new Set<string>();
  for (const r of rows) {
    if (r.telefono?.trim()) tel.add(normalizarTelefono(r.telefono));
    if (r.email?.trim()) mail.add(r.email.trim().toLowerCase());
  }
  return { total: rows.length, conTelefono: tel.size, conCorreo: mail.size };
}

// ─── SEMBRAR ENVÍOS ─────────────────────────────────────────────────────────

/** Crea filas comunicados_envios (pendiente) por (pasajero × canal). Idempotente y
 *  sin duplicados por (canal, destinatario). */
export async function sembrarEnvios(comunicadoId: string): Promise<{ total: number }> {
  const { data: c } = await db.from("comunicados").select("*").eq("id", comunicadoId).single();
  if (!c) throw new Error("Comunicado no encontrado");
  const com = c as Comunicado;

  const pasajeros = await resolverAudiencia(com);
  const canales = com.canales ?? [];

  // Dedup por (canal + destinatario).
  const porClave = new Map<string, { comunicado_id: string; pasajero_id: number; nombre: string | null; canal: string; destinatario: string; estado: string }>();
  for (const p of pasajeros) {
    if (canales.includes("whatsapp") && p.telefono?.trim()) {
      const dest = normalizarTelefono(p.telefono);
      const k = `whatsapp|${dest}`;
      if (!porClave.has(k)) porClave.set(k, { comunicado_id: comunicadoId, pasajero_id: p.id, nombre: p.nombre, canal: "whatsapp", destinatario: dest, estado: "pendiente" });
    }
    if (canales.includes("email") && p.email?.trim()) {
      const dest = p.email.trim().toLowerCase();
      const k = `email|${dest}`;
      if (!porClave.has(k)) porClave.set(k, { comunicado_id: comunicadoId, pasajero_id: p.id, nombre: p.nombre, canal: "email", destinatario: dest, estado: "pendiente" });
    }
  }
  const filas = [...porClave.values()];

  if (filas.length) {
    const { error } = await db
      .from("comunicados_envios")
      .upsert(filas, { onConflict: "comunicado_id,canal,destinatario", ignoreDuplicates: true });
    if (error) throw new Error(`Sembrar envíos: ${error.message}`);
  }

  const { count } = await db
    .from("comunicados_envios")
    .select("id", { count: "exact", head: true })
    .eq("comunicado_id", comunicadoId);

  await db.from("comunicados").update({ total: count ?? filas.length, updated_at: new Date().toISOString() }).eq("id", comunicadoId);
  return { total: count ?? filas.length };
}

// ─── PROCESAR ────────────────────────────────────────────────────────────────

/** Reclama un lote atómico de pendientes y lo procesa con throttling. Reentrante:
 *  cron + botón "Continuar" no se pisan (RPC reclamar_comunicados entrega lotes disjuntos). */
export async function procesarComunicado(
  comunicadoId: string,
  opts: { max?: number } = {},
): Promise<{ ok: boolean; procesados: number; restantes: number; estado: string }> {
  const max = opts.max ?? LOTE;

  const { data: c } = await db.from("comunicados").select("*").eq("id", comunicadoId).single();
  if (!c) throw new Error("Comunicado no encontrado");
  const com = c as Comunicado;
  if (com.estado === "cancelada") return { ok: false, procesados: 0, restantes: 0, estado: "cancelada" };

  const clienteEmpresa = await empresaDe(com.cliente_id);

  // Recuperación: re-encolar filas 'procesando' colgadas (worker que murió a mitad).
  await db
    .from("comunicados_envios")
    .update({ estado: "pendiente", procesando_at: null })
    .eq("comunicado_id", comunicadoId)
    .eq("estado", "procesando")
    .lt("procesando_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  await db.from("comunicados").update({ estado: "enviando" }).eq("id", comunicadoId);

  const { data: reclamados, error: eRpc } = await db.rpc("reclamar_comunicados", { p_comunicado: comunicadoId, p_max: max });
  if (eRpc) throw new Error(`reclamar_comunicados: ${eRpc.message}`);
  const lote = (reclamados ?? []) as { id: string; canal: string; destinatario: string; nombre: string | null }[];

  const plantilla = com.wa_plantilla?.trim() || PLANTILLA_DEFECTO;
  const idioma = com.wa_idioma?.trim() || "es";
  const phoneWa = phoneAvisos();

  let procesados = 0;
  for (const envio of lote) {
    const nombre = nombreCorto(envio.nombre);
    try {
      let metaId: string | null = null;
      if (envio.canal === "whatsapp") {
        if (!phoneWa) throw new Error("META_PHONE_NUMBER_ID_AVISOS no configurado");
        if (!com.wa_pdf_url) throw new Error("Falta el documento (PDF) del comunicado para WhatsApp");
        metaId = await enviarWhatsAppPlantilla(
          envio.destinatario,
          plantilla,
          idioma,
          [nombre || "Estimado(a)", com.mensaje_wa ?? com.titulo],
          phoneWa,
          undefined,
          { tipo: "document", link: com.wa_pdf_url, filename: "Horarios.pdf" },
        );
      } else {
        const ctx = { nombre, empresa: clienteEmpresa };
        const asunto = personalizar(com.asunto ?? com.titulo, ctx);
        const html = htmlCorreo(com, ctx);
        const attachments = com.wa_pdf_url
          ? [{ filename: "Horarios.pdf", path: com.wa_pdf_url }]
          : undefined;
        await enviarEmail({ to: envio.destinatario, subject: asunto, html, attachments });
      }
      await db.from("comunicados_envios")
        .update({ estado: "enviado", meta_message_id: metaId, enviado_at: new Date().toISOString() })
        .eq("id", envio.id);
    } catch (e: any) {
      await db.from("comunicados_envios")
        .update({ estado: "error", error: e.message })
        .eq("id", envio.id);
    }
    procesados++;
    await sleep(THROTTLE_MS);
  }

  // Contadores agregados desde la tabla (fuente de verdad).
  const [rEnv, rErr, rOmi, rPend, rProc] = await Promise.all([
    db.from("comunicados_envios").select("id", { count: "exact", head: true }).eq("comunicado_id", comunicadoId).eq("estado", "enviado"),
    db.from("comunicados_envios").select("id", { count: "exact", head: true }).eq("comunicado_id", comunicadoId).eq("estado", "error"),
    db.from("comunicados_envios").select("id", { count: "exact", head: true }).eq("comunicado_id", comunicadoId).eq("estado", "omitido"),
    db.from("comunicados_envios").select("id", { count: "exact", head: true }).eq("comunicado_id", comunicadoId).eq("estado", "pendiente"),
    db.from("comunicados_envios").select("id", { count: "exact", head: true }).eq("comunicado_id", comunicadoId).eq("estado", "procesando"),
  ]);

  if (rPend.error || rProc.error) {
    return { ok: true, procesados, restantes: -1, estado: "enviando" };
  }

  const restantes = (rPend.count ?? 0) + (rProc.count ?? 0);
  const estadoFinal = restantes === 0 ? "enviada" : "enviando";
  const upd: any = { estado: estadoFinal, updated_at: new Date().toISOString() };
  if (!rEnv.error) upd.enviados = rEnv.count;
  if (!rErr.error) upd.errores = rErr.count;
  if (!rOmi.error) upd.omitidos = rOmi.count;
  await db.from("comunicados").update(upd).eq("id", comunicadoId);

  return { ok: true, procesados, restantes, estado: estadoFinal };
}

/** Razón social de la empresa cliente (para {{empresa}} en el correo). */
async function empresaDe(clienteId: number | null): Promise<string> {
  if (!clienteId) return "";
  const { data } = await db.from("clientes").select("empresa, nombre").eq("id", clienteId).maybeSingle();
  return (data?.empresa || data?.nombre || "") as string;
}

/**
 * Garantiza que el comunicado tenga wa_pdf_url (el documento con los cuadros): usa un
 * PDF adjunto si el operador lo subió, o arma uno a partir de las imágenes adjuntas.
 * Persiste el resultado. Devuelve la URL pública (o null si no hay adjuntos).
 */
export async function asegurarPdf(comunicadoId: string): Promise<string | null> {
  const { data: c } = await db.from("comunicados").select("id, wa_pdf_url, adjuntos").eq("id", comunicadoId).single();
  if (!c) throw new Error("Comunicado no encontrado");
  if (c.wa_pdf_url) return c.wa_pdf_url;

  const adjuntos = (c.adjuntos ?? []) as { url: string; nombre?: string; tipo?: string; esImagen?: boolean }[];
  const pdfAdj = adjuntos.find((a) => a && a.esImagen === false && /pdf/i.test(`${a.tipo ?? ""} ${a.nombre ?? ""}`));
  let url: string | null = pdfAdj?.url ?? null;
  if (!url) {
    const imgs = adjuntos.filter((a) => a.esImagen).map((a) => a.url).filter(Boolean);
    if (imgs.length) url = await construirPdfDesdeImagenes(imgs);
  }
  if (url) await db.from("comunicados").update({ wa_pdf_url: url }).eq("id", comunicadoId);
  return url;
}

/** Envío de PRUEBA a UN destinatario (número o correo del operador) antes del masivo. */
export async function enviarPrueba(
  comunicadoId: string,
  canal: "whatsapp" | "email",
  destino: string,
): Promise<{ ok: true; messageId: string | null }> {
  const { data: c } = await db.from("comunicados").select("*").eq("id", comunicadoId).single();
  if (!c) throw new Error("Comunicado no encontrado");
  const com = c as Comunicado;
  const empresa = await empresaDe(com.cliente_id);

  if (canal === "whatsapp") {
    const phoneWa = phoneAvisos();
    if (!phoneWa) throw new Error("META_PHONE_NUMBER_ID_AVISOS no configurado");
    const pdf = await asegurarPdf(comunicadoId);
    if (!pdf) throw new Error("Para WhatsApp adjunta al menos una imagen o un PDF (se envía como documento).");
    const messageId = await enviarWhatsAppPlantilla(
      normalizarTelefono(destino),
      com.wa_plantilla?.trim() || PLANTILLA_DEFECTO,
      com.wa_idioma?.trim() || "es",
      ["Prueba", com.mensaje_wa ?? com.titulo],
      phoneWa,
      undefined,
      { tipo: "document", link: pdf, filename: "Horarios.pdf" },
    );
    return { ok: true, messageId };
  }

  const pdf = await asegurarPdf(comunicadoId);
  const ctx = { nombre: "Prueba", empresa };
  const asunto = personalizar(com.asunto ?? com.titulo, ctx);
  const html = htmlCorreo(com, ctx);
  await enviarEmail({
    to: destino.trim().toLowerCase(),
    subject: `[PRUEBA] ${asunto}`,
    html,
    attachments: pdf ? [{ filename: "Horarios.pdf", path: pdf }] : undefined,
  });
  return { ok: true, messageId: null };
}
