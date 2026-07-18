// ──────────────────────────────────────────────────────────────────────────────
// lib/contabilidad/factura-ia.ts — Lectura y conciliación de facturas de proveedor.
//
// SOLO servidor (usa ANTHROPIC_API_KEY). Dos caminos de extracción:
//   1) XML UBL 2.1 de SUNAT (el CPE legalmente válido) → parseUblFactura(). Sin
//      dependencias externas: extracción por regex sobre las etiquetas cbc/cac
//      estándar. Es la fuente PREFERIDA cuando el correo trae el .xml.
//   2) Visión Claude sobre el PDF (representación impresa) → extraerFacturaPdf().
//      Respaldo cuando solo llega el PDF. Reutiliza el patrón de lib/vision-ia.ts.
//
// Conciliación (enriquecer, NO duplicar): conciliarFactura() busca un documento_compra
// por la llave fiscal (ruc+tipo+serie+numero); si no existe, intenta casar contra una
// carga ya capturada por el Radar (radar_combustible) y hace UPDATE de la cadena
// existente (radar_combustible → combustible → documentos_compra). Jamás un INSERT que
// duplique el gasto.
// ──────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY en el servidor (Vercel → Environment Variables).");
  }
  return (_anthropic ??= new Anthropic());
}
const MODELO_VISION = "claude-opus-4-8";

export type FacturaExtraida = {
  ruc_emisor: string | null;
  razon_social: string | null;
  tipo_comprobante: string | null;  // factura|boleta|nota_credito…
  serie: string | null;
  numero: string | null;
  fecha_emision: string | null;     // YYYY-MM-DD
  moneda: string | null;
  subtotal: number | null;
  igv: number | null;
  total: number | null;
  detraccion_monto: number | null;
  placa_detectada: string | null;
  fuente: "xml_ubl" | "vision_pdf";
  confianza: number;                // 0..1
};

// ── 1) Parser XML UBL 2.1 (sin dependencias) ─────────────────────────────────

function tag(xml: string, name: string): string | null {
  // Captura <ns:name ...>valor</ns:name> ignorando prefijo de namespace.
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}
function num(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const TIPO_CPE: Record<string, string> = {
  "01": "factura", "03": "boleta", "07": "nota_credito", "08": "nota_debito", "12": "ticket",
};

/** Extrae los campos fiscales del XML UBL de una factura/boleta electrónica SUNAT. */
export function parseUblFactura(xml: string): FacturaExtraida {
  // cbc:ID a nivel documento = "F001-123" (serie-correlativo).
  const idDoc = tag(xml, "ID");
  let serie: string | null = null, numero: string | null = null;
  if (idDoc && /-/.test(idDoc)) {
    const [s, n] = idDoc.split("-");
    serie = s?.trim() || null;
    numero = n?.trim() || null;
  }

  // RUC del emisor: primer PartyIdentification/ID dentro de AccountingSupplierParty.
  let ruc: string | null = null, razon: string | null = null;
  const supBlock = /<(?:\w+:)?AccountingSupplierParty>([\s\S]*?)<\/(?:\w+:)?AccountingSupplierParty>/i.exec(xml)?.[1] ?? "";
  if (supBlock) {
    ruc = tag(supBlock, "ID");
    razon = tag(supBlock, "RegistrationName") ?? tag(supBlock, "Name");
  }

  const tipoCod = tag(xml, "InvoiceTypeCode") ?? tag(xml, "DocumentTypeCode");
  const tipo = tipoCod ? (TIPO_CPE[tipoCod] ?? tipoCod) : (/<(?:\w+:)?CreditNote\b/i.test(xml) ? "nota_credito" : "factura");

  const fecha = tag(xml, "IssueDate");
  const moneda = tag(xml, "DocumentCurrencyCode");

  // Montos: TaxAmount (IGV total), LineExtensionAmount (base), PayableAmount (total).
  const igvBlock = /<(?:\w+:)?TaxTotal>([\s\S]*?)<\/(?:\w+:)?TaxTotal>/i.exec(xml)?.[1] ?? "";
  const igv = num(tag(igvBlock, "TaxAmount"));
  const monetary = /<(?:\w+:)?LegalMonetaryTotal>([\s\S]*?)<\/(?:\w+:)?LegalMonetaryTotal>/i.exec(xml)?.[1] ?? "";
  const total = num(tag(monetary, "PayableAmount")) ?? num(tag(monetary, "TaxInclusiveAmount"));
  const subtotal = num(tag(monetary, "LineExtensionAmount"));

  return {
    ruc_emisor: ruc, razon_social: razon, tipo_comprobante: tipo,
    serie, numero, fecha_emision: fecha, moneda,
    subtotal, igv, total, detraccion_monto: null, placa_detectada: null,
    fuente: "xml_ubl",
    confianza: ruc && serie && numero && total != null ? 0.95 : 0.5,
  };
}

// ── 2) Visión Claude sobre el PDF (respaldo) ─────────────────────────────────

export type AdjuntoFactura = { media_type: string; data: string /* base64 sin prefijo */; tipo: "pdf" | "image" };

const PROMPT_FACTURA = `Te paso una FACTURA o BOLETA de un proveedor (Perú). Extrae SOLO un JSON:
{
 "ruc_emisor": string|null, "razon_social": string|null,
 "tipo_comprobante": "factura"|"boleta"|"nota_credito"|null,
 "serie": string|null, "numero": string|null,
 "fecha_emision": "YYYY-MM-DD"|null, "moneda": "PEN"|"USD"|null,
 "subtotal": number|null, "igv": number|null, "total": number|null,
 "detraccion_monto": number|null, "placa_detectada": string|null
}
La "placa_detectada" es la placa del vehículo si el detalle menciona una (típico en vales de grifo). Si un dato no está, null. No inventes. Responde únicamente el JSON.`;

function extraerJSON(texto: string): any {
  const limpio = texto.replace(/```json/gi, "").replace(/```/g, "").trim();
  const i = limpio.indexOf("{"), f = limpio.lastIndexOf("}");
  if (i === -1 || f === -1) throw new Error("La IA no devolvió JSON reconocible");
  return JSON.parse(limpio.slice(i, f + 1));
}

export async function extraerFacturaPdf(adj: AdjuntoFactura): Promise<FacturaExtraida> {
  const bloque =
    adj.tipo === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: adj.data } }
      : { type: "image", source: { type: "base64", media_type: adj.media_type || "image/jpeg", data: adj.data } };
  const resp: any = await getAnthropic().messages.create({
    model: MODELO_VISION,
    max_tokens: 700,
    messages: [{ role: "user", content: [{ type: "text", text: PROMPT_FACTURA }, bloque as any] }],
  } as any);
  const texto = (resp?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const r = extraerJSON(texto);
  return {
    ruc_emisor: r.ruc_emisor ?? null, razon_social: r.razon_social ?? null,
    tipo_comprobante: r.tipo_comprobante ?? null, serie: r.serie ?? null, numero: r.numero ?? null,
    fecha_emision: r.fecha_emision ?? null, moneda: r.moneda ?? null,
    subtotal: r.subtotal ?? null, igv: r.igv ?? null, total: r.total ?? null,
    detraccion_monto: r.detraccion_monto ?? null, placa_detectada: r.placa_detectada ?? null,
    fuente: "vision_pdf",
    confianza: r.ruc_emisor && r.serie && r.total != null ? 0.85 : 0.5,
  };
}

// ── 3) Conciliación (enriquecer, no duplicar) ────────────────────────────────

const placaNorm = (s?: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export type ResultadoConciliacion = {
  accion: "documento_existente" | "enriquecio_radar" | "documento_creado" | "con_diferencia" | "sin_match";
  documento_compra_id?: number;
  radar_combustible_id?: string | null;
  detalle: string;
};

/**
 * Concilia una factura extraída contra la BD. Prioridad:
 *   (1) ya existe un documento_compra con la MISMA llave fiscal → no duplica.
 *   (2) hay una carga del Radar (radar_combustible) que casa por placa+fecha+monto→
 *       crea el documento_compra fiscal y ENLAZA la cadena existente (radar_combustible
 *       + combustible) a ese documento.
 *   (3) sin match → crea el documento_compra (para revisión/CxP) marcándolo pendiente.
 */
export async function conciliarFactura(sb: any, ex: FacturaExtraida): Promise<ResultadoConciliacion> {
  // (1) Dedupe fiscal — alineado con el índice único (ruc, tipo, serie, numero).
  //     Usa limit(1) (no maybeSingle) para tolerar >1 fila (p.ej. factura + NC con misma
  //     serie/número) sin lanzar y caer a insertar un duplicado.
  if (ex.ruc_emisor && ex.serie && ex.numero) {
    const { data: prev } = await sb
      .from("documentos_compra")
      .select("id")
      .eq("ruc_emisor", ex.ruc_emisor)
      .eq("tipo_comprobante", ex.tipo_comprobante ?? "factura")
      .eq("serie", ex.serie)
      .eq("numero", ex.numero)
      .limit(1);
    if (((prev as any[]) ?? []).length) {
      return { accion: "documento_existente", documento_compra_id: Number((prev as any[])[0].id), detalle: "La factura ya estaba registrada (llave fiscal existente)." };
    }
  }

  // (2) Casar contra una carga del Radar aún sin conciliar. Match por placa + monto (±1
  //     sol) Y (mismo comprobante serie-número O fecha dentro de ±45 días). La ventana
  //     cubre las facturas de tarjeta de flota, que se emiten a fin de mes con fecha
  //     distinta a la de cada carga. Sin fecha en la factura, se casa solo por placa+monto.
  let radarHit: any = null;
  if (ex.placa_detectada && ex.total != null) {
    const objetivo = placaNorm(ex.placa_detectada);
    const comp = [ex.serie, ex.numero].filter(Boolean).join("-").toUpperCase();
    const emision = ex.fecha_emision ? new Date(ex.fecha_emision + "T00:00:00-05:00").getTime() : null;
    const { data: rc } = await sb
      .from("radar_combustible")
      .select("id, placa, fecha, monto_total, comprobante, combustible_id, documento_compra_id")
      .is("documento_compra_id", null);
    radarHit = ((rc as any[]) ?? []).find((r) => {
      if (placaNorm(r.placa) !== objetivo) return false;
      if (r.monto_total == null || Math.abs(Number(r.monto_total) - Number(ex.total)) >= 1) return false;
      const mismoComp = comp && r.comprobante && String(r.comprobante).toUpperCase().includes(comp);
      const dentroVentana = emision != null && r.fecha
        ? Math.abs(new Date(r.fecha + "T00:00:00-05:00").getTime() - emision) <= 45 * 86400000
        : emision == null; // sin fecha en la factura: placa+monto basta
      return mismoComp || dentroVentana;
    }) ?? null;
  }

  // Crear el comprobante de compra fiscal (una sola vez).
  const { data: doc, error } = await sb
    .from("documentos_compra")
    .insert({
      ruc_emisor: ex.ruc_emisor,
      razon_social: ex.razon_social,
      tipo_comprobante: ex.tipo_comprobante ?? "factura",
      serie: ex.serie, numero: ex.numero,
      fecha_emision: ex.fecha_emision ?? new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10),
      moneda: ex.moneda ?? "PEN",
      subtotal: ex.subtotal ?? 0, igv: ex.igv ?? 0, total: ex.total ?? 0,
      detraccion_monto: ex.detraccion_monto ?? 0,
      categoria: radarHit ? "combustible" : "otro",
      estado_conciliacion: radarHit ? "conciliado" : "pendiente",
      origen: "correo_ia",
    })
    .select("id")
    .single();
  if (error) throw new Error(`documentos_compra: ${error.message}`);
  const docId = Number((doc as any).id);

  // (2b) Enlazar la cadena existente del Radar a ese documento (UPDATE, no INSERT).
  if (radarHit) {
    await sb.from("radar_combustible").update({ documento_compra_id: docId }).eq("id", radarHit.id);
    if (radarHit.combustible_id) {
      await sb.from("combustible").update({
        documento_compra_id: docId,
        comprobante_serie: ex.serie,
        comprobante_numero: ex.numero,
        ruc_proveedor: ex.ruc_emisor,
      }).eq("id", radarHit.combustible_id);
      await sb.from("documentos_compra_detalle").insert({
        documento_compra_id: docId,
        descripcion: `Abastecimiento ${radarHit.placa ?? ""}`.trim(),
        subtotal: ex.subtotal ?? 0,
        combustible_id: radarHit.combustible_id,
      });
    }
    return {
      accion: "enriquecio_radar",
      documento_compra_id: docId,
      radar_combustible_id: radarHit.id,
      detalle: `Factura conciliada con la carga del Radar de ${radarHit.placa ?? "la unidad"} (${ex.fecha_emision}) — se enriqueció el registro existente, sin duplicar.`,
    };
  }

  return {
    accion: "documento_creado",
    documento_compra_id: docId,
    detalle: "Factura registrada como comprobante de compra (sin carga previa que conciliar) — queda pendiente para revisión/CxP.",
  };
}
