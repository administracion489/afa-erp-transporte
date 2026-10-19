// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/enviar-cotizacion-datos.ts — Arma el PDF de una cotización de traslado desde SU
// FILA y lo envía por WhatsApp a quien la pidió. SOLO SERVIDOR (service-role). No crea clientes
// al importarse: el cliente de Supabase llega por parámetro.
//
// LO ENVÍAN DOS: la IA del CRM, justo después de su mensaje (`por: "automatico"`), y un ejecutivo
// desde la tarjeta del inbox (`por: "ejecutivo"`). Los dos pasan por aquí y por el MISMO reclamo:
//  · RECLAMO CONDICIONAL. La acción pasa de `pendiente` a `enviando` con un UPDATE que exige el
//    estado (y el plazo) que se acaba de leer: dos envíos a la vez no pueden ganar los dos, y el
//    cliente no recibe el PDF dos veces. `resuelta_at` guarda el plazo del reclamo (5 min): un
//    envío que muere a mitad se puede reintentar pasado ese plazo.
//  · SOLO AL `wa_id` DE LA CONVERSACIÓN. Nunca a `contacto.telefono`, que el modelo puede escribir
//    con `actualizar_contacto`.
//  · QUIEN LLAMA DICE DE QUÉ CONVERSACIÓN Y DE QUÉ COTIZACIÓN ES (`esperado`): la IA pasa las de su
//    turno y la tarjeta del inbox la conversación que tiene abierta. Si la acción es de otra, no se
//    reclama ni se toca (`cotizacion_ajena`): un id de acción equivocado no puede mandar el PDF de
//    otro cliente.
//  · LA URL QUE SE LE PASA A META ES FIRMADA, y si no se puede firmar NO se envía: `firmarUrl`
//    devuelve la original cuando falla, y en un bucket privado esa no se puede descargar.
//  · SI FALLA, LA ACCIÓN VUELVE A `pendiente` con el error escrito y una nota interna: el
//    ejecutivo la ve en la tarjeta y puede reintentar. Nada se da por enviado sin `meta_message_id`.
//  · EL PDF SE DERIVA DE LA FILA CADA VEZ: si un ejecutivo la corrigió en /cotizaciones, sale
//    corregida. La copia enviada queda en `crm-media` como constancia, referenciada por el mensaje.
// ──────────────────────────────────────────────────────────────────────────────

import { BUCKET_CRM_MEDIA, asegurarBucket as asegurarBucketCrm } from "../crm-media";
import { enviarWhatsAppMedia, explicarErrorEnvioWhatsApp } from "../crm-meta";
import { phonePara as phoneParaUso } from "../whatsapp-numeros";
import { faltaColumna } from "../columna-faltante";
import { empresaConDefectos, type EmpresaResuelta, type PerfilEmpresa } from "../empresa-perfil";
import { numeroCotizacion } from "../cotizacion-pdf";
import { fechaLima } from "../alertas-horario";
import {
  captionDocumento, contenidoPdfTraslado, nombreArchivoPdf, rutaPdf, type FilaCotizacionLeida,
} from "./cotizacion-traslado";
import { dibujarPdfTraslado } from "./pdf-traslado";
import { accionReclamable, planAccionTraslado, plazoEnvio, type PlanAccion } from "./envio-ia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** Las columnas de la cotización que necesitan el PDF y el envío. */
export const COLS_COTIZACION_TRASLADO =
  "id, numero_cotizacion, created_at, estado, origen, destino, fecha_servicio, hora_ida, fecha_retorno, hora_retorno, " +
  "tipo_servicio, tipo_vehiculo, items_json, incluye_igv, precio_cliente, moneda, tipo_cambio, atencion, consideraciones_json, " +
  "crm_conversacion_id, traslado_json";

/** Lo que vale el enlace firmado que descarga Meta (s). Meta lo baja al momento; una hora sobra. */
const TTL_URL_META = 3600;

// ── 1. El perfil y el logo ───────────────────────────────────────────────────

export type PerfilPdf = { perfil: PerfilEmpresa | null; color: string | null };

/** El perfil de la empresa con su color (que `EmpresaResuelta` no lleva). LANZA si no se puede leer. */
export async function leerPerfilPdf(sb: Sb): Promise<PerfilPdf> {
  const base = "nombre, razon_social, ruc, logo_url, telefono, email, direccion, web";
  let r = await sb.from("empresa_perfil").select(`${base}, color_primario`).eq("id", 1).maybeSingle();
  if (r.error && faltaColumna(r.error, "color_primario")) r = await sb.from("empresa_perfil").select(base).eq("id", 1).maybeSingle();
  if (r.error) throw new Error(`No se pudo leer el perfil de la empresa: ${r.error.message}`);
  const p = (r.data ?? null) as (PerfilEmpresa & { color_primario?: string | null }) | null;
  return { perfil: p, color: p?.color_primario ?? null };
}

/** Topes del logo (no medidos: un logo de verdad pesa decenas de KB). */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TIMEOUT_MS = 4000;

/** PNG o JPG por su firma, no por la extensión ni por lo que diga el servidor. */
export function tipoImagen(b: Uint8Array): "png" | "jpg" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  return null;
}

export type LogoPdf = { bytes: Uint8Array; tipo: "png" | "jpg" };

/** Dónde puede estar el logo: el almacenamiento PÚBLICO del propio proyecto de Supabase. */
export const RUTA_LOGO_PERMITIDA = "/storage/v1/object/public/";

/**
 * El host del proyecto de Supabase (de `NEXT_PUBLIC_SUPABASE_URL`), o null si no está o no es
 * https. Sin él no se baja ningún logo.
 */
export function hostSupabase(base: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  try {
    const u = new URL(String(base ?? ""));
    return u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

/**
 * El logo del perfil, best-effort: SOLO del almacenamiento público del propio Supabase (el bucket
 * donde lo sube /configuracion/perfil), https, sin redirecciones, 4 s y 2 MB como mucho, y solo
 * PNG o JPG por sus bytes (no se convierte nada: otro formato es otro decodificador expuesto a lo
 * que alguien pegó en el campo del logo). Cualquier fallo devuelve null y el PDF sale sin logo
 * (nunca con el de otra empresa).
 */
export async function bajarLogo(url: string | null | undefined, f: typeof fetch = fetch, base?: string | null): Promise<LogoPdf | null> {
  let u: URL;
  try { u = new URL(String(url ?? "")); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = hostSupabase(base === undefined ? process.env.NEXT_PUBLIC_SUPABASE_URL : base);
  if (!host || u.host !== host || !u.pathname.startsWith(RUTA_LOGO_PERMITIDA) || u.pathname.includes("..")) return null;
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), LOGO_TIMEOUT_MS);
  try {
    const res = await f(u.toString(), { signal: ctrl.signal, redirect: "error" });
    if (!res.ok || !res.body) return null;
    const largo = Number(res.headers.get("content-length"));
    if (Number.isFinite(largo) && largo > LOGO_MAX_BYTES) return null;
    const lector = res.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) { ctrl.abort(); return null; }
      partes.push(value);
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of partes) { bytes.set(p, o); o += p.byteLength; }
    const tipo = tipoImagen(bytes);
    return tipo ? { bytes, tipo } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

// ── 2. El PDF ────────────────────────────────────────────────────────────────

export type PdfArmado = { bytes: Uint8Array; nombre: string; caption: string; empresa: EmpresaResuelta };

/**
 * El PDF de una fila (guardada, o armada en memoria para el ejemplo del simulador). LANZA si los
 * importes no se pueden imprimir o el perfil no se puede leer: el llamador lo trata como «PDF no
 * generado».
 */
export async function armarPdfDeFila(
  sb: Sb,
  fila: FilaCotizacionLeida,
  opts: { ejemplo?: boolean; perfil?: PerfilPdf | null; bajarLogo?: (url: string | null) => Promise<LogoPdf | null> } = {},
): Promise<PdfArmado> {
  const pp = opts.perfil ?? (await leerPerfilPdf(sb));
  const empresa = empresaConDefectos(pp.perfil);
  const logo = await (opts.bajarLogo ?? ((u: string | null) => bajarLogo(u)))(empresa.logo);
  const contenido = contenidoPdfTraslado(fila, empresa, { ejemplo: opts.ejemplo, colorPrimario: pp.color });
  const bytes = await dibujarPdfTraslado(contenido, logo);
  return { bytes, nombre: nombreArchivoPdf(contenido.numero), caption: captionDocumento(fila, empresa), empresa };
}

/** La fila de la cotización, o null si no existe. LANZA si no se puede leer. */
export async function leerCotizacionTraslado(sb: Sb, id: number): Promise<FilaCotizacionLeida | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const { data, error } = await sb.from("cotizaciones").select(COLS_COTIZACION_TRASLADO).eq("id", id).maybeSingle();
  if (error) throw new Error(`No se pudo leer la cotización ${id}: ${error.message}`);
  return (data ?? null) as FilaCotizacionLeida | null;
}

/** El PDF de una cotización guardada, leído de su fila. LANZA si no existe o no se puede imprimir. */
export async function pdfDeCotizacion(sb: Sb, cotId: number, opts: { bajarLogo?: (url: string | null) => Promise<LogoPdf | null> } = {}): Promise<PdfArmado> {
  const fila = await leerCotizacionTraslado(sb, cotId);
  if (!fila) throw new Error("La cotización ya no existe.");
  return armarPdfDeFila(sb, fila, opts);
}

// ── 3. El envío ──────────────────────────────────────────────────────────────

export type CodigoEnvio = PlanAccion | "reclamo_perdido" | "error_lectura" | "pdf_no_generado" | "sin_url" | "envio_fallido";

export type ResultadoEnvio = { ok: boolean; codigo: CodigoEnvio; detalle: string; metaId?: string | null };

/** Lo que el envío necesita de fuera; la matriz lo reemplaza para correr sin red. */
export type DepsEnvio = {
  enviarMedia?: typeof enviarWhatsAppMedia;
  phonePara?: (uso: "crm") => Promise<string | undefined>;
  asegurarBucket?: (sb: Sb) => Promise<void>;
  bajarLogo?: (url: string | null) => Promise<LogoPdf | null>;
  ahoraMs?: () => number;
  uuid?: () => string;
};

type AccionFila = {
  id: string; tipo: string | null; estado: string | null; conversacion_id: string | null; contacto_id: string | null;
  resuelta_at: string | null; resultado_id: number | null; payload: Record<string, unknown> | null;
};

const COLS_ACCION = "id, tipo, estado, conversacion_id, contacto_id, resuelta_at, resultado_id, payload";

/**
 * Por qué la acción NO es la que espera quien llama, o null si lo es (o si no espera nada). Una
 * conversación o cotización esperada que llega vacía o rara cuenta como «no coincide»: quien la
 * pasa es porque quiere comprobarla.
 */
export function accionAjena(
  acc: { conversacion_id?: string | null; resultado_id?: number | null; payload?: Record<string, unknown> | null },
  esperado: { conversacionId?: string; cotizacionId?: number } | null | undefined,
): string | null {
  if (!esperado) return null;
  if (esperado.conversacionId !== undefined) {
    const e = typeof esperado.conversacionId === "string" ? esperado.conversacionId.trim() : "";
    if (!e || !acc.conversacion_id || acc.conversacion_id !== e) return "La acción no es de esta conversación.";
  }
  if (esperado.cotizacionId !== undefined) {
    const e = Number(esperado.cotizacionId);
    const p = acc.payload && typeof acc.payload === "object" ? (acc.payload as { cotizacion_id?: unknown }).cotizacion_id : undefined;
    const propia = Number(acc.resultado_id ?? p);
    if (!Number.isInteger(e) || e <= 0 || !Number.isFinite(propia) || propia !== e) return "La acción no es de esta cotización.";
  }
  return null;
}

export async function enviarCotizacionTraslado(
  sb: Sb,
  x: {
    accionId: string; por: "automatico" | "ejecutivo"; usuarioId?: string | null; bytes?: Uint8Array | null; nombre?: string; caption?: string;
    /** De qué conversación y cotización TIENE que ser la acción. Si no coincide, no se reclama ni se envía. */
    esperado?: { conversacionId?: string; cotizacionId?: number };
  },
  deps: DepsEnvio = {},
): Promise<ResultadoEnvio> {
  const ahora = deps.ahoraMs?.() ?? Date.now();

  // 1) La acción, antes de reclamarla.
  const { data: accData, error: eAcc } = await sb.from("crm_acciones_ia").select(COLS_ACCION).eq("id", x.accionId).maybeSingle();
  if (eAcc) return { ok: false, codigo: "error_lectura", detalle: `No se pudo leer la acción: ${eAcc.message}` };
  const acc = accData as AccionFila | null;
  if (!acc || acc.tipo !== "cotizacion_traslado") return { ok: false, codigo: "cotizacion_no_existe", detalle: "La acción no es una cotización de traslado." };
  // Antes de reclamar nada: la acción tiene que ser de la conversación y la cotización que dice quien llama.
  const ajena = accionAjena(acc, x.esperado);
  if (ajena) return { ok: false, codigo: "cotizacion_ajena", detalle: ajena };
  if (!accionReclamable(acc, ahora)) {
    return {
      ok: false, codigo: "no_pendiente",
      detalle: acc.estado === "enviando" ? "Se está enviando en este momento: espera unos minutos." : `La cotización ya fue ${acc.estado ?? "resuelta"}.`,
    };
  }

  // 2) El reclamo: un UPDATE que exige el estado (y el plazo) que se acaba de leer.
  const plazo = plazoEnvio(ahora);
  let q = sb.from("crm_acciones_ia").update({ estado: "enviando", resuelta_at: plazo }).eq("id", acc.id).eq("estado", acc.estado);
  if (acc.estado === "enviando") q = acc.resuelta_at ? q.eq("resuelta_at", acc.resuelta_at) : q.is("resuelta_at", null);
  const { data: rec, error: eRec } = await q.select("id");
  if (eRec) return { ok: false, codigo: "error_lectura", detalle: `No se pudo reclamar el envío: ${eRec.message}` };
  if (!rec || rec.length === 0) return { ok: false, codigo: "reclamo_perdido", detalle: "Otro envío de esta cotización está en curso." };

  const payload = (acc.payload && typeof acc.payload === "object" ? acc.payload : {}) as Record<string, unknown>;
  const cotId = Number(acc.resultado_id ?? payload.cotizacion_id);

  /** Suelta el reclamo: la acción vuelve a `pendiente` con el error escrito, y una nota interna. */
  const soltar = async (codigo: CodigoEnvio, detalle: string): Promise<ResultadoEnvio> => {
    try {
      await sb.from("crm_acciones_ia")
        // `ultimo_error` es TEXTO: es lo que pinta la tarjeta del inbox. Cuándo, quién y el código van aparte.
        .update({
          estado: "pendiente", resuelta_at: null,
          payload: { ...payload, ultimo_error: detalle.slice(0, 500), ultimo_error_codigo: codigo, ultimo_error_at: new Date(ahora).toISOString(), ultimo_error_por: x.por },
        })
        .eq("id", acc.id).eq("estado", "enviando").eq("resuelta_at", plazo);
    } catch { /* si ni esto se puede escribir, el plazo vence solo y se puede reintentar */ }
    try {
      if (acc.conversacion_id) {
        await sb.from("crm_notas").insert({
          conversacion_id: acc.conversacion_id,
          texto: `📄 No se pudo enviar la cotización de traslado${Number.isFinite(cotId) ? ` (id ${cotId})` : ""} por WhatsApp.\n${detalle.slice(0, 500)}`,
          autor_nombre: x.por === "automatico" ? "Asistente IA" : "Sistema",
        });
      }
    } catch { /* sin crm_notas: el error queda en la acción */ }
    return { ok: false, codigo, detalle };
  };

  // 3) La cotización y la conversación, y si esta acción se puede enviar (con el estado de ANTES del reclamo).
  let cot: FilaCotizacionLeida | null;
  let conv: { id: string; canal: string | null; phone_number_id?: string | null; wa_id: string | null } | null = null;
  try {
    cot = await leerCotizacionTraslado(sb, cotId);
    const { data: c, error: eConv } = await sb.from("crm_conversaciones")
      .select("id, canal, phone_number_id, crm_contactos(wa_id)").eq("id", acc.conversacion_id ?? "").maybeSingle();
    if (eConv) throw new Error(`No se pudo leer la conversación: ${eConv.message}`);
    if (c) {
      const contacto = Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos;
      conv = { id: c.id, canal: c.canal ?? null, phone_number_id: c.phone_number_id ?? null, wa_id: contacto?.wa_id ?? null };
    }
  } catch (e) {
    return soltar("error_lectura", (e as Error).message);
  }
  const plan = planAccionTraslado(acc, cot, conv, ahora);
  if (plan.codigo !== "ok") return soltar(plan.codigo, plan.detalle);
  const fila = cot!;
  const destino = conv!.wa_id!.trim();

  // 4) El PDF (el que ya armó la IA, o uno nuevo desde la fila).
  let bytes = x.bytes ?? null;
  let nombre = x.nombre ?? nombreArchivoPdf(numeroCotizacion(fila));
  let caption = x.caption ?? "";
  try {
    if (!bytes || !caption) {
      const pdf = await armarPdfDeFila(sb, fila, { bajarLogo: deps.bajarLogo });
      if (!bytes) { bytes = pdf.bytes; nombre = pdf.nombre; }
      if (!caption) caption = pdf.caption;
    }
  } catch (e) {
    return soltar("pdf_no_generado", `No se pudo armar el PDF: ${(e as Error).message}`);
  }

  // 5) La copia en el bucket privado y el enlace firmado para Meta (sin él, no se envía).
  let ruta: string;
  try {
    await (deps.asegurarBucket ?? asegurarBucketCrm)(sb);
    ruta = rutaPdf(fila.id, fechaLima(ahora).slice(0, 7), deps.uuid?.() ?? crypto.randomUUID());
    const up = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, bytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw new Error(`No se pudo guardar el PDF: ${up.error.message}`);
  } catch (e) {
    return soltar("pdf_no_generado", (e as Error).message);
  }
  const firmada = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUrl(ruta, TTL_URL_META);
  const url = firmada?.data?.signedUrl as string | undefined;
  if (!url) return soltar("sin_url", `No se pudo firmar el enlace del PDF${firmada?.error?.message ? `: ${firmada.error.message}` : ""}.`);

  // 6) WhatsApp, por el número del hilo, al wa_id de la conversación.
  let metaId: string | null = null;
  let errorEnvio: string | null = null;
  try {
    const phoneId = conv!.phone_number_id ?? (await (deps.phonePara ?? phoneParaUso)("crm"));
    metaId = await (deps.enviarMedia ?? enviarWhatsAppMedia)(destino, "document", url, caption || undefined, { phoneId, filename: nombre });
    if (!metaId) errorEnvio = "Meta no devolvió el id del mensaje.";
  } catch (e) {
    errorEnvio = explicarErrorEnvioWhatsApp(String((e as Error)?.message ?? e));
  }

  // 7) El mensaje en el hilo (también si falló: el error se ve donde se mira).
  const media_url = sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
  try {
    await sb.from("crm_mensajes").insert({
      conversacion_id: conv!.id,
      direccion: "saliente",
      tipo: "document",
      contenido: caption ? `${nombre}\n${caption}` : nombre,
      media_url,
      meta_message_id: metaId,
      generado_por_ia: x.por === "automatico",
      error: errorEnvio,
    });
    await sb.from("crm_conversaciones")
      .update(x.por === "ejecutivo" ? { ultimo_mensaje_at: new Date(ahora).toISOString(), estado: "en_progreso" } : { ultimo_mensaje_at: new Date(ahora).toISOString() })
      .eq("id", conv!.id);
  } catch { /* el mensaje del hilo es constancia; el envío ya ocurrió (o falló) */ }

  if (errorEnvio) return soltar("envio_fallido", errorEnvio);

  // 8) Enviada: la cotización pasa a «enviado» y la acción a «aprobada», con quién y cuándo.
  try {
    await sb.from("cotizaciones").update({ estado: "enviado", medio_envio: "WhatsApp" }).eq("id", fila.id).in("estado", ["borrador", "pendiente"]);
  } catch { /* la acción dice que se envió; el estado de la cotización se corrige en /cotizaciones */ }
  const at = new Date(ahora).toISOString();
  await sb.from("crm_acciones_ia")
    .update({
      estado: "aprobada", resuelta_at: at, resuelta_por: x.por === "ejecutivo" ? x.usuarioId ?? null : null,
      payload: { ...payload, ultimo_error: null, envio: { por: x.por, at, meta_message_id: metaId } },
    })
    .eq("id", acc.id).eq("estado", "enviando");
  return { ok: true, codigo: "ok", detalle: "", metaId };
}
