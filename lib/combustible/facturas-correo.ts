// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/facturas-correo.ts — SOLO SERVIDOR. Trae las facturas de combustible del
// Gmail conectado en /crm, las lee y las concilia LÍNEA POR LÍNEA contra `combustible`.
//
//   correo → adjunto XML (SUNAT, preferido) o PDF (visión, respaldo) → radar_facturas
//          → documentos_compra (una vez, por la llave fiscal)
//          → por línea: planDeLinea (lib/combustible/factura-lineas.ts, puro)
//              ya_registrada      → se ENLAZA la carga a la factura (UPDATE, nunca INSERT)
//              registrar          → se INSERTA la carga que el Radar no registró
//              en_radar_pendiente → se avisa: se aprueba en /radar-ia
//              revisar/en_espera  → queda en la bandeja; la próxima sincronización la re-mira
//
// documentos_compra NO entra a v_egresos (la vista lo declara: «se suma aparte»), así que
// crear el comprobante fiscal no duplica el gasto; el gasto es la fila de `combustible`.
// ──────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { getAccessToken } from "@/lib/crm-gmail";
import { parseUblFactura, MODELO_VISION, type FacturaExtraida } from "@/lib/contabilidad/factura-ia";
import { normalizarTipoCombustible } from "@/lib/combustible-tipos";
import {
  lineasUbl, completarConDocumento, planDeLinea, placasEnTexto, notasEnTexto, fechasEnTexto, normPlaca,
  type LineaFactura, type PlanLinea, type CargaExistente,
} from "@/lib/combustible/factura-lineas";
import type { FilaCuenta } from "@/lib/combustible/saldo-datos";
import { sumarDiasISO } from "@/lib/combustible/saldo-cuenta";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// ── Gmail ────────────────────────────────────────────────────────────────────

type Adjunto = { nombre: string; mime: string; data: Buffer };

function adjuntosDe(payload: any): { nombre: string; mime: string; attachmentId?: string; data?: string }[] {
  const out: any[] = [];
  const recorrer = (p: any) => {
    if (!p) return;
    if (p.filename) out.push({ nombre: p.filename, mime: p.mimeType ?? "", attachmentId: p.body?.attachmentId, data: p.body?.data });
    for (const h of p.parts ?? []) recorrer(h);
  };
  recorrer(payload);
  return out;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const header = (hs: any[], n: string) => hs?.find((h: any) => h.name?.toLowerCase() === n)?.value ?? "";

async function gget(token: string, ruta: string): Promise<any> {
  const r = await fetch(`${GMAIL}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? `Gmail ${r.status}`);
  return j;
}

/** Los XML de SUNAT suelen venir ZIPeados. SheetJS trae un lector de ZIP (CFB) — no hace
 *  falta otra dependencia. Best-effort: si falla, se sigue con lo que haya. */
function desempacarZip(buf: Buffer): Adjunto[] {
  try {
    const cfb: any = (XLSX as any).CFB.read(buf, { type: "buffer" });
    const out: Adjunto[] = [];
    (cfb.FileIndex ?? []).forEach((f: any, i: number) => {
      const nombre = String(cfb.FullPaths?.[i] ?? f.name ?? "");
      if (f.type !== 2 || !f.content) return;
      if (/\.xml$/i.test(nombre) || /\.pdf$/i.test(nombre)) {
        out.push({ nombre: nombre.split("/").pop()!, mime: /\.pdf$/i.test(nombre) ? "application/pdf" : "text/xml", data: Buffer.from(f.content) });
      }
    });
    return out;
  } catch { return []; }
}

async function descargarAdjuntos(token: string, msgId: string, payload: any): Promise<Adjunto[]> {
  const out: Adjunto[] = [];
  for (const a of adjuntosDe(payload)) {
    if (!/\.(xml|pdf|zip)$/i.test(a.nombre)) continue;
    let data: Buffer | null = null;
    if (a.data) data = b64url(a.data);
    else if (a.attachmentId) {
      const j = await gget(token, `/messages/${msgId}/attachments/${a.attachmentId}`);
      if (j?.data) data = b64url(j.data);
    }
    if (!data) continue;
    if (/\.zip$/i.test(a.nombre)) out.push(...desempacarZip(data));
    else out.push({ nombre: a.nombre, mime: a.mime, data });
  }
  return out;
}

// ── Lectura del PDF por visión (respaldo, cuando no llegó el XML) ────────────

const PROMPT_LINEAS = `Te paso una FACTURA de combustible de un grifo en Perú (Primax, COESTI, Repsol, Petroperú…). Extrae SOLO un JSON:
{
 "ruc_emisor": string|null, "razon_social": string|null,
 "tipo_comprobante": "factura"|"boleta"|"nota_credito"|null,
 "serie": string|null, "numero": string|null, "fecha_emision": "YYYY-MM-DD"|null,
 "subtotal": number|null, "igv": number|null, "total": number|null,
 "lineas": [ { "descripcion": string, "cantidad": number|null, "unidad": "GLL"|"LTR"|"MTQ"|null,
               "precio_unitario": number|null, "total": number|null,
               "placa": string|null, "fecha": "YYYY-MM-DD"|null, "nota_despacho": string|null } ]
}
Reglas: "precio_unitario" y "total" de cada línea CON impuestos (lo que marca el surtidor; si la factura los da sin IGV, súmale el IGV de esa línea). "placa" y "fecha" de la línea solo si la factura los IMPRIME para ese despacho (en el detalle, en observaciones o en una nota de despacho como V72S-00023776); si no, null. No inventes. La empresa que COMPRA (transporte) no es el emisor: el emisor es el grifo. Responde únicamente el JSON.`;

let _anthropic: Anthropic | null = null;
async function leerPdf(pdf: Buffer): Promise<{ cab: FacturaExtraida; lineas: LineaFactura[]; costo: { in: number; out: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");
  const resp: any = await (_anthropic ??= new Anthropic()).messages.create({
    model: MODELO_VISION,
    max_tokens: 2500,
    messages: [{ role: "user", content: [
      { type: "text", text: PROMPT_LINEAS },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } } as any,
    ] }],
  } as any);
  const texto = (resp?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const limpio = texto.replace(/```json/gi, "").replace(/```/g, "");
  const r = JSON.parse(limpio.slice(limpio.indexOf("{"), limpio.lastIndexOf("}") + 1));
  const cab: FacturaExtraida = {
    ruc_emisor: r.ruc_emisor ?? null, razon_social: r.razon_social ?? null,
    tipo_comprobante: r.tipo_comprobante ?? "factura", serie: r.serie ?? null, numero: r.numero ?? null,
    fecha_emision: r.fecha_emision ?? null, moneda: "PEN",
    subtotal: r.subtotal ?? null, igv: r.igv ?? null, total: r.total ?? null,
    detraccion_monto: null, placa_detectada: null, fuente: "vision_pdf",
    confianza: r.ruc_emisor && r.serie && r.total != null ? 0.85 : 0.5,
  };
  const lineas: LineaFactura[] = (Array.isArray(r.lineas) ? r.lineas : []).map((l: any, i: number) => ({
    n: i + 1,
    descripcion: String(l.descripcion ?? ""),
    cantidad: l.cantidad == null ? null : Number(l.cantidad),
    unidad_codigo: l.unidad ?? null,
    precio_unitario: l.precio_unitario == null ? null : Number(l.precio_unitario),
    total: l.total == null ? null : Number(l.total),
    tipo_combustible: normalizarTipoCombustible(l.descripcion),
    placa: l.placa ? normPlaca(l.placa) : null,
    fecha: l.fecha ?? null,
    nota_despacho: l.nota_despacho ?? null,
  }));
  return { cab, lineas, costo: { in: resp?.usage?.input_tokens ?? 0, out: resp?.usage?.output_tokens ?? 0 } };
}

// ── La flota (placas conocidas → id) ─────────────────────────────────────────

type Flota = { propias: Map<string, number>; terceros: Map<string, number>; placas: string[] };

async function cargarFlota(sb: any): Promise<Flota> {
  const [{ data: v }, { data: t }] = await Promise.all([
    sb.from("vehiculos").select("id, placa"),
    sb.from("vehiculos_tercero").select("id, placa"),
  ]);
  const propias = new Map<string, number>(), terceros = new Map<string, number>();
  for (const r of (v as any[]) ?? []) if (r.placa) propias.set(normPlaca(r.placa), Number(r.id));
  for (const r of (t as any[]) ?? []) if (r.placa) terceros.set(normPlaca(r.placa), Number(r.id));
  return { propias, terceros, placas: [...propias.keys(), ...terceros.keys()] };
}

// ── Conciliación de UNA factura ya leída ─────────────────────────────────────

export type ResultadoFactura = {
  factura_id: number;
  estado: string;
  plan: (PlanLinea & { combustible_id?: number | string })[];
  error?: string;
};

async function asegurarDocumento(sb: any, cab: FacturaExtraida, conciliado: boolean): Promise<number | null> {
  if (!cab.ruc_emisor || !cab.serie || !cab.numero) return null;
  const tipo = cab.tipo_comprobante ?? "factura";
  const { data: prev } = await sb.from("documentos_compra").select("id")
    .eq("ruc_emisor", cab.ruc_emisor).eq("tipo_comprobante", tipo)
    .eq("serie", cab.serie).eq("numero", cab.numero).limit(1);
  if (((prev as any[]) ?? []).length) {
    const id = Number((prev as any[])[0].id);
    if (conciliado) await sb.from("documentos_compra").update({ estado_conciliacion: "conciliado" }).eq("id", id).eq("estado_conciliacion", "pendiente");
    return id;
  }
  const { data, error } = await sb.from("documentos_compra").insert({
    ruc_emisor: cab.ruc_emisor, razon_social: cab.razon_social, tipo_comprobante: tipo,
    serie: cab.serie, numero: cab.numero,
    fecha_emision: cab.fecha_emision ?? new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10),
    moneda: cab.moneda ?? "PEN", subtotal: cab.subtotal ?? 0, igv: cab.igv ?? 0, total: cab.total ?? 0,
    detraccion_monto: 0, categoria: "combustible",
    estado_conciliacion: conciliado ? "conciliado" : "pendiente", origen: "correo_ia",
  }).select("id").single();
  if (error) { console.warn("[facturas-correo] documentos_compra:", error.message); return null; }
  return Number((data as any).id);
}

/**
 * Concilia una fila de radar_facturas (con `lineas` ya leídas). Idempotente: se puede volver a
 * correr sobre la misma factura —es lo que hace cada sincronización con las «parciales»—.
 * `manual` permite a una persona confirmar una línea con placa/fecha elegidas a mano.
 */
export async function conciliarFacturaGuardada(
  sb: any,
  fila: any,
  cuenta: FilaCuenta | null,
  hoy: string,
  manual?: { n: number; placa?: string | null; fecha?: string | null },
): Promise<ResultadoFactura> {
  // CANDADO: dos conciliaciones a la vez (el cron y el botón «Leer correo ahora») verían la
  // misma línea como faltante y la registrarían dos veces. Se reclama la factura con un UPDATE
  // condicional; quien no la consigue no toca nada.
  const ahora = new Date().toISOString();
  const libreDesde = new Date(Date.now() - 60_000).toISOString();
  const { data: reclamo } = await sb.from("radar_facturas").update({ procesada_en: ahora })
    .eq("id", fila.id).or(`procesada_en.is.null,procesada_en.lt.${libreDesde}`).select("id");
  if (!((reclamo as any[]) ?? []).length) {
    return {
      factura_id: Number(fila.id), estado: fila.estado, plan: Array.isArray(fila.conciliacion) ? fila.conciliacion : [],
      error: "Otra conciliación de esta factura está en curso: reintenta en un minuto.",
    };
  }

  const flota = await cargarFlota(sb);
  const cab: FacturaExtraida = {
    ruc_emisor: fila.ruc_emisor, razon_social: fila.razon_social, tipo_comprobante: fila.tipo_comprobante,
    serie: fila.serie, numero: fila.numero, fecha_emision: fila.fecha_emision, moneda: fila.moneda ?? "PEN",
    subtotal: fila.subtotal, igv: fila.igv, total: fila.total, detraccion_monto: null, placa_detectada: null,
    fuente: fila.fuente_extraccion === "xml_ubl" ? "xml_ubl" : "vision_pdf", confianza: Number(fila.confianza ?? 0),
  };
  let lineas: LineaFactura[] = Array.isArray(fila.lineas) ? fila.lineas : [];
  if (manual) {
    lineas = lineas.map((l) => l.n === manual.n
      ? { ...l, placa: manual.placa ? normPlaca(manual.placa) : l.placa, fecha: manual.fecha || l.fecha }
      : l);
  }

  // Candidatos: cargas en la ventana de fechas de la factura (±3 días).
  const fechas = lineas.map((l) => l.fecha).filter(Boolean) as string[];
  const base = fechas.length ? fechas.sort() : [cab.fecha_emision ?? hoy];
  const desde = sumarDiasISO(base[0], -35); // una factura consolidada del mes puede traer cargas sin fecha
  const hasta = sumarDiasISO(base[base.length - 1], 3);
  const placaDeId = new Map<string, string>();
  for (const [p, id] of flota.propias) placaDeId.set(`p${id}`, p);
  for (const [p, id] of flota.terceros) placaDeId.set(`t${id}`, p);

  // SI NO SE PUEDEN LEER LOS CANDIDATOS, NO SE CONCILIA NADA. Una lista vacía por error de
  // consulta haría ver «faltante» cada línea y la registraría: el gasto entero dos veces.
  const { data: regs, error: eRegs } = await sb.from("combustible")
    .select("id, fecha, total, galones, vehiculo_id, vehiculo_tercero_id, observaciones, comprobante_serie, comprobante_numero, documento_compra_id")
    .gte("fecha", desde).lte("fecha", hasta).order("id").limit(1000);
  if (eRegs) throw new Error(`No se pudieron leer las cargas para conciliar: ${eRegs.message}`);
  const { data: rad, error: eRad } = await sb.from("radar_combustible")
    .select("id, fecha, monto_total, galones, litros, placa, comprobante, combustible_id, estado")
    .gte("fecha", desde).lte("fecha", hasta).order("created_at").limit(1000);
  if (eRad) throw new Error(`No se pudieron leer las cargas del Radar para conciliar: ${eRad.message}`);
  // Lo que ESTA factura ya registró en una pasada anterior (para no re-registrar lo que una
  // persona borró a propósito de /combustible).
  const previo = new Map<number, any>(((Array.isArray(fila.conciliacion) ? fila.conciliacion : []) as any[]).map((c) => [Number(c.n), c]));

  const registradas: CargaExistente[] = ((regs as any[]) ?? []).map((r) => ({
    id: Number(r.id),
    placa: r.vehiculo_id != null ? placaDeId.get(`p${r.vehiculo_id}`) ?? null : r.vehiculo_tercero_id != null ? placaDeId.get(`t${r.vehiculo_tercero_id}`) ?? null : null,
    fecha: String(r.fecha).slice(0, 10), total: r.total == null ? null : Number(r.total),
    cantidad: r.galones == null ? null : Number(r.galones),
    referencia: [r.observaciones, r.comprobante_serie && r.comprobante_numero ? `${r.comprobante_serie}-${r.comprobante_numero}` : ""].join(" "),
    documento_compra_id: r.documento_compra_id ?? null,
  }));
  // El comprobante que capturó el Radar también identifica a la carga ya registrada.
  for (const r of (rad as any[]) ?? []) {
    if (r.combustible_id && r.comprobante) {
      const c = registradas.find((x) => x.id === Number(r.combustible_id));
      if (c) c.referencia = `${c.referencia ?? ""} ${r.comprobante}`;
    }
  }
  const radarPendientes: CargaExistente[] = ((rad as any[]) ?? [])
    .filter((r) => r.estado === "pendiente_revision" && !r.combustible_id && r.fecha)
    .map((r) => ({
      id: r.id, placa: normPlaca(r.placa) || null, fecha: String(r.fecha).slice(0, 10),
      total: r.monto_total == null ? null : Number(r.monto_total),
      cantidad: r.galones != null ? Number(r.galones) : r.litros != null ? Number(r.litros) : null,
      referencia: r.comprobante ?? "",
    }));

  let docId: number | null = fila.documento_compra_id ?? null;
  const usados = new Set<string>();
  const plan: ResultadoFactura["plan"] = [];
  const grifo = cab.razon_social || cuenta?.nombre || "Grifo";

  for (const l of lineas) {
    const p = planDeLinea({
      linea: l,
      registradas: registradas.filter((r) => !usados.has(String(r.id))),
      radarPendientes: radarPendientes.filter((r) => !usados.has(String(r.id))),
      tipoComprobante: cab.tipo_comprobante,
      documentoId: docId,
      fuente: cab.fuente,
      hoy,
      // Una persona que confirma la línea ya decidió: sin espera, sin exigir el XML.
      graciaDias: manual?.n === l.n ? 0 : cuenta?.facturas_gracia_dias ?? 1,
      autoRegistrar: manual?.n === l.n ? true : cuenta?.facturas_auto_registrar ?? true,
    });
    // El candado del PDF no se salta solo por confirmar: confirmar ES leer la factura.
    const confirmada = manual?.n === l.n && p.codigo === "revisar" && p.motivo === "lectura_no_oficial";
    const final: PlanLinea & { combustible_id?: number | string } = confirmada ? { ...p, codigo: "registrar", motivo: undefined } : { ...p };
    const antes = previo.get(l.n);
    if (final.codigo === "registrar" && manual?.n !== l.n && antes?.codigo === "registrar" && antes?.combustible_id != null) {
      // La registró esta misma factura y ya no está: alguien la borró. Volver a crearla sola
      // sería pelearse con esa persona cada 3 horas.
      final.codigo = "revisar"; final.motivo = "eliminada";
      final.detalle = `La carga #${antes.combustible_id} que se registró desde esta factura ya no existe (¿se borró a mano?). Si falta de verdad, confírmala otra vez.`;
    }
    if (final.casa_con != null) usados.add(String(final.casa_con));

    if (final.codigo === "registrar" && final.propuesta) {
      // El comprobante fiscal existe ANTES de la carga: la carga nace enlazada a él.
      if (docId == null) docId = await asegurarDocumento(sb, cab, false);
      const pr = final.propuesta;
      const vehId = flota.propias.get(pr.placa) ?? null;
      const tercId = vehId == null ? flota.terceros.get(pr.placa) ?? null : null;
      if (vehId == null && tercId == null) {
        final.codigo = "revisar"; final.motivo = "sin_placa";
        final.detalle = `La placa ${pr.placa} no está en la flota.`;
      } else {
        const ref = `${cab.serie ?? ""}-${cab.numero ?? ""}`;
        const payload: Record<string, unknown> = {
          vehiculo_id: vehId, vehiculo_tercero_id: tercId,
          fecha: pr.fecha, kilometraje: 0,
          galones: pr.galones, precio_galon: pr.precio_galon,
          grifo, conductor: null, tipo_combustible: pr.tipo_combustible, unidad: pr.unidad,
          observaciones: `📧 Registrada desde la factura ${ref} (respaldo del Radar)${l.nota_despacho ? ` · Nota ${l.nota_despacho}` : ""} · sin odómetro`,
          comprobante_serie: cab.serie, comprobante_numero: cab.numero, ruc_proveedor: cab.ruc_emisor,
          documento_compra_id: docId,
        };
        let { data: ins, error } = await sb.from("combustible").insert(payload).select("id").single();
        if (error && /column .* does not exist|could not find .* column/i.test(error.message)) {
          // Columnas fiscales de una migración accesoria (finanzas-02): la carga entra igual.
          for (const k of ["comprobante_serie", "comprobante_numero", "ruc_proveedor", "documento_compra_id"]) delete payload[k];
          ({ data: ins, error } = await sb.from("combustible").insert(payload).select("id").single());
        }
        if (error) { final.codigo = "revisar"; final.detalle = `No se pudo registrar: ${error.message}`; }
        else {
          final.combustible_id = Number((ins as any).id);
          usados.add(String(final.combustible_id));
          registradas.push({ id: final.combustible_id, placa: pr.placa, fecha: pr.fecha, total: l.total, cantidad: pr.galones, documento_compra_id: docId });
        }
      }
    }
    plan.push(final);
  }

  const resueltas = (c: string) => ["ya_registrada", "registrar", "no_es_combustible"].includes(c);
  const todo = plan.length > 0 && plan.every((p) => resueltas(p.codigo));
  if (docId == null && plan.some((p) => p.codigo === "ya_registrada" || p.codigo === "registrar")) {
    docId = await asegurarDocumento(sb, cab, todo);
  } else if (docId != null && todo) {
    await asegurarDocumento(sb, cab, true);
  }

  // Enlazar las ya registradas (UPDATE de la cadena existente, nunca un INSERT).
  if (docId != null) {
    for (const p of plan) {
      if (p.codigo === "ya_registrada" && p.casa_con != null) {
        p.combustible_id = p.casa_con;
        await sb.from("combustible")
          .update({ documento_compra_id: docId, comprobante_serie: cab.serie, comprobante_numero: cab.numero, ruc_proveedor: cab.ruc_emisor })
          .eq("id", p.casa_con).is("documento_compra_id", null);
      }
      if (p.codigo === "en_radar_pendiente" && p.casa_con != null) {
        await sb.from("radar_combustible").update({ documento_compra_id: docId }).eq("id", p.casa_con).is("documento_compra_id", null);
      }
    }
  }

  const estado = !plan.length ? "con_diferencia" : todo ? "conciliada" : "parcial";
  await sb.from("radar_facturas").update({
    estado, conciliacion: plan, documento_compra_id: docId, cuenta_id: cuenta?.id ?? null,
    procesada_en: new Date().toISOString(),
    diferencia_detalle: !plan.length ? "La factura no trae líneas legibles." : null,
  }).eq("id", fila.id);
  return { factura_id: Number(fila.id), estado, plan };
}

// ── Sincronización completa ──────────────────────────────────────────────────

export type ResumenSync = {
  ok: boolean;
  error?: string;
  correos_vistos: number;
  nuevas: number;
  reconciliadas: number;
  registradas: number;
  por_revisar: number;
  detalle: { asunto: string; estado: string; error?: string }[];
};

export async function sincronizarFacturas(
  sb: any, cuenta: FilaCuenta, hoy: string, opts: { dias?: number; max?: number } = {},
): Promise<ResumenSync> {
  const res: ResumenSync = { ok: true, correos_vistos: 0, nuevas: 0, reconciliadas: 0, registradas: 0, por_revisar: 0, detalle: [] };
  let token: string;
  try { token = await getAccessToken(); }
  catch (e: any) { return { ...res, ok: false, error: `Gmail: ${e.message}` }; }

  const dias = opts.dias ?? 45;
  const q = `${cuenta.correo_filtro || "has:attachment"} newer_than:${dias}d`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const j = await gget(token, `/messages?maxResults=50&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const m of j.messages ?? []) ids.push(m.id);
    pageToken = j.nextPageToken;
  } while (pageToken && ids.length < (opts.max ?? 200));
  res.correos_vistos = ids.length;

  // Un correo que dio ERROR se vuelve a intentar (su fila se reemplaza); el resto, una vez.
  const { data: yaVistas } = ids.length
    ? await sb.from("radar_facturas").select("gmail_message_id, estado").in("gmail_message_id", ids)
    : { data: [] };
  const vistas = new Set(((yaVistas as any[]) ?? []).filter((r) => r.estado !== "error").map((r) => r.gmail_message_id));
  const flota = await cargarFlota(sb);

  // Tope por corrida: la visión cuesta y la función tiene 300 s. Lo que quede, en la próxima.
  for (const id of ids.filter((x) => !vistas.has(x)).slice(0, 15)) {
    let asunto = "";
    try {
      const msg = await gget(token, `/messages/${id}?format=full`);
      asunto = header(msg.payload?.headers, "subject");
      const de = header(msg.payload?.headers, "from");
      const fecha = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      const adj = await descargarAdjuntos(token, id, msg.payload);
      const xml = adj.find((a) => /\.xml$/i.test(a.nombre));
      const pdf = adj.find((a) => /\.pdf$/i.test(a.nombre));
      const fila: Record<string, unknown> = {
        gmail_message_id: id, remitente_email: (de.match(/<(.+?)>/)?.[1] ?? de).slice(0, 200), asunto, recibido_en: fecha,
        cuenta_id: cuenta.id,
      };
      if (!xml && !pdf) {
        await sb.from("radar_facturas").upsert(
          { ...fila, estado: "sin_adjunto", error: null, diferencia_detalle: "El correo no trae XML ni PDF (¿solo un enlace de descarga?)." },
          { onConflict: "gmail_message_id" },
        );
        res.detalle.push({ asunto, estado: "sin_adjunto" });
        continue;
      }
      let cab: FacturaExtraida, lineas: LineaFactura[], costo = { in: 0, out: 0 };
      if (xml) {
        const texto = xml.data.toString("utf-8");
        cab = parseUblFactura(texto);
        const lu = lineasUbl(texto, flota.placas);
        lineas = completarConDocumento(lu.lineas, lu.textoDoc, flota.placas, cab.fecha_emision);
      } else {
        const r = await leerPdf(pdf!.data);
        cab = r.cab; costo = r.costo;
        // La placa que la IA leyó se valida contra la flota igual que la del XML.
        lineas = r.lineas.map((l) => {
          const enFlota = l.placa && flota.placas.includes(l.placa) ? l.placa : null;
          return { ...l, placa: enFlota };
        });
        lineas = completarConDocumento(lineas, "", flota.placas, cab.fecha_emision);
      }
      const { data: ins, error } = await sb.from("radar_facturas").upsert({
        ...fila, estado: "procesada", error: null,
        ruc_emisor: cab.ruc_emisor, razon_social: cab.razon_social, tipo_comprobante: cab.tipo_comprobante,
        serie: cab.serie, numero: cab.numero, fecha_emision: cab.fecha_emision, moneda: cab.moneda,
        subtotal: cab.subtotal, igv: cab.igv, total: cab.total, confianza: cab.confianza,
        fuente_extraccion: cab.fuente, lineas, tokens_entrada: costo.in, tokens_salida: costo.out,
        placa_detectada: [...new Set(lineas.map((l) => l.placa).filter(Boolean))].join(", ") || null,
      }, { onConflict: "gmail_message_id" }).select("*").single();
      if (error) throw new Error(`radar_facturas: ${error.message}`);
      res.nuevas++;
      const r = await conciliarFacturaGuardada(sb, ins, cuenta, hoy);
      res.registradas += r.plan.filter((p) => p.codigo === "registrar").length;
      res.por_revisar += r.plan.filter((p) => p.codigo === "revisar" || p.codigo === "en_radar_pendiente").length;
      res.detalle.push({ asunto, estado: r.estado });
    } catch (e: any) {
      res.detalle.push({ asunto, estado: "error", error: e.message });
      // ignoreDuplicates: un error de ESTA corrida no puede pisar la fila buena que dejó otra.
      await sb.from("radar_facturas").upsert(
        { gmail_message_id: id, asunto, estado: "error", error: String(e.message).slice(0, 500), cuenta_id: cuenta.id },
        { onConflict: "gmail_message_id", ignoreDuplicates: true },
      );
    }
  }

  // Las parciales (y una «procesada» que quedó a medias) se vuelven a mirar: una línea «esperando al Radar» se registra cuando vence
  // su gracia, y una «ya registrada» puede aparecer porque alguien aprobó la del Radar.
  const { data: parciales } = await sb.from("radar_facturas").select("*")
    .in("estado", ["parcial", "procesada"]).gte("recibido_en", new Date(Date.now() - 60 * 86400000).toISOString()).limit(40);
  for (const f of (parciales as any[]) ?? []) {
    if (!Array.isArray(f.lineas)) continue;
    try {
      const r = await conciliarFacturaGuardada(sb, f, cuenta, hoy);
      if (r.error) continue; // la acaba de conciliar esta misma corrida (o otra en paralelo)
      res.reconciliadas++;
      const antes = new Set(((f.conciliacion ?? []) as any[]).filter((c) => c.codigo === "registrar").map((c) => c.n));
      res.registradas += r.plan.filter((p) => p.codigo === "registrar" && !antes.has(p.n)).length;
    } catch (e: any) {
      res.detalle.push({ asunto: f.asunto ?? `#${f.id}`, estado: "error", error: e.message });
    }
  }
  return res;
}

/** Para la pantalla: re-exporta los detectores (la pantalla los usa al elegir una placa). */
export { placasEnTexto, notasEnTexto, fechasEnTexto };
