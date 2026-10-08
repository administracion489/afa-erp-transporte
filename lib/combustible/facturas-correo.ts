// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/facturas-correo.ts — SOLO SERVIDOR. Trae las facturas de combustible del
// CORREO DE FACTURAS (lib/combustible/gmail-facturas.ts; si no hay uno, el Gmail del CRM), las
// lee y las concilia LÍNEA POR LÍNEA contra `combustible`.
//
//   correo → adjunto XML (SUNAT, preferido) o PDF del comprobante (visión, respaldo) → radar_facturas
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
import { conexionCorreoFacturas } from "@/lib/combustible/gmail-facturas";
import { describirConexion } from "@/lib/combustible/correo-conexion";
import { parseUblFactura, MODELO_VISION, type FacturaExtraida } from "@/lib/contabilidad/factura-ia";
import { normalizarTipoCombustible } from "@/lib/combustible-tipos";
import {
  lineasUbl, completarConDocumento, planDeLinea, placasEnTexto, notasEnTexto, fechasEnTexto, normPlaca,
  elegirXmlComprobante, esNombreComprobante, DIAS_REGISTRO_AUTOMATICO, FILTRO_HISTORICO,
  notaPrepago, esDeudaFalsaPrepago, observacionCargaDeFactura, lineasConDecision, esCargaFusionada,
  type LineaFactura, type PlanLinea, type CargaExistente,
} from "@/lib/combustible/factura-lineas";
import type { FilaCuenta } from "@/lib/combustible/saldo-datos";
import { sumarDiasISO } from "@/lib/combustible/saldo-cuenta";
import { elegirDocumentoFactura } from "@/lib/combustible/factura-de-carga";
import { pareceCombustible } from "@/lib/radar/cluster-remitente";
import {
  lineasAlDespacho, esCargaDelRadar, generadaDespues, muestrasDesfase, decidirDesfaseCuenta, diaLima,
  notaFechaDespacho, cargasPorMover, normalizarDesfaseConfig, MAX_DESFASE, sumarDias,
  type DesfaseCuenta, type MuestrasDesfase, type VoucherRadar, type FacturaParaMedir,
  type FacturaRegistrada, type CargaActual, type CargaPorMover,
} from "@/lib/combustible/desfase-factura";

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

/**
 * ¿Vale la pena reintentar? Gmail responde 429 y 5xx en ráfagas (límite por usuario, «backend
 * error», una página de error de su front en vez de JSON), y el fetch de Node a veces pierde el
 * socket: el correo no tiene nada malo y al rato sale. Un 404 (el correo ya no existe) o un
 * 401/403 de permiso NO cambian por esperar: reintentarlos solo gasta el tiempo de la corrida.
 * `status` null = no hubo respuesta (red).
 */
export function falloGmailTransitorio(status: number | null, mensaje: string): boolean {
  if (status == null) return true;
  if (status === 429 || status >= 500) return true;
  return status === 403 && /rate ?limit|quota|too many/i.test(mensaje);
}

export const ESPERAS_GMAIL_MS = [1_000, 3_000, 7_000];

/**
 * GET a la API de Gmail. Antes leía el cuerpo como JSON ANTES de mirar el estado, así que una
 * respuesta de error sin JSON se convertía en «Unexpected token…», y ningún fallo se reintentaba:
 * una ráfaga de Gmail dejaba en «Error» todos los correos que pillaba. Ahora lo pasajero se
 * reintenta con espera creciente (o la que pida `Retry-After`) y lo demás se dice tal cual.
 */
export async function ggetGmail(token: string, ruta: string, esperas: readonly number[] = ESPERAS_GMAIL_MS): Promise<any> {
  for (let intento = 0; ; intento++) {
    let status: number | null = null, mensaje = "", espera: number | null = null;
    try {
      const r = await fetch(`${GMAIL}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (r.ok && j) return j;
      status = r.ok ? null : r.status; // un 200 con el cuerpo ilegible se trata como un tropiezo de red
      mensaje = j?.error?.message ?? (r.ok ? "Gmail devolvió una respuesta ilegible" : `Gmail respondió ${r.status}`);
      const ra = Number(r.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) espera = Math.min(ra * 1000, 10_000);
    } catch (e: any) {
      mensaje = `Gmail no respondió (${e?.cause?.code ?? e?.message ?? "red"})`;
    }
    if (!falloGmailTransitorio(status, mensaje) || intento >= esperas.length) {
      throw new Error(intento ? `${mensaje} (tras ${intento + 1} intentos)` : mensaje);
    }
    await new Promise((ok) => setTimeout(ok, espera ?? esperas[intento]));
  }
}
const gget = (token: string, ruta: string) => ggetGmail(token, ruta);

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

/** Baja los adjuntos cuyo nombre acepta `acepta`. Se piden primero los XML/ZIP y el PDF solo si
 *  no llegó la factura en XML: leer un año de historial son cientos de PDFs que no hacen falta. */
async function descargarAdjuntos(
  token: string, msgId: string, payload: any,
  acepta: (nombre: string) => boolean = (n) => /\.(xml|pdf|zip)$/i.test(n),
): Promise<Adjunto[]> {
  const out: Adjunto[] = [];
  for (const a of adjuntosDe(payload)) {
    if (!acepta(a.nombre)) continue;
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

/**
 * El comprobante fiscal (CxP) de la factura, una sola vez por llave fiscal.
 *
 * LA FACTURA DE UNA CUENTA PREPAGO YA ESTÁ PAGADA: la pagó el saldo que se depositó antes. Nacía
 * con el `estado_pago` por defecto (`impaga`), y Tesorería cuenta como deuda todo lo que no está
 * pagado: cada despacho de Primax se habría sumado a «Total deuda pendiente» y podía entrar a un
 * lote de pago — el mismo combustible pagado dos veces, que es el error que no vuelve. Nace
 * pagada y cubierta por el anticipo (`adelanto_1` = total, así «a cancelar» es 0), con la razón
 * escrita. Si el comprobante YA existía (lo cargó Contabilidad), su estado de pago no se toca.
 */
async function asegurarDocumento(sb: any, cab: FacturaExtraida, conciliado: boolean, cuenta: FilaCuenta | null): Promise<number | null> {
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
  const fecha = cab.fecha_emision ?? new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const total = cab.total ?? 0;
  const fila: Record<string, unknown> = {
    ruc_emisor: cab.ruc_emisor, razon_social: cab.razon_social, tipo_comprobante: tipo,
    serie: cab.serie, numero: cab.numero, fecha_emision: fecha,
    moneda: cab.moneda ?? "PEN", subtotal: cab.subtotal ?? 0, igv: cab.igv ?? 0, total,
    detraccion_monto: 0, categoria: "combustible",
    estado_conciliacion: conciliado ? "conciliado" : "pendiente", origen: "correo_ia",
    estado_pago: "pagada", adelanto_1: total, fecha_pago: fecha,
    observaciones: notaPrepago(cuenta?.nombre),
  };
  let { data, error } = await sb.from("documentos_compra").insert(fila).select("id").single();
  if (error && /column .* does not exist|could not find .* column/i.test(error.message)) {
    // Columnas de la fase 06 (anticipo, fecha de pago, observaciones): sin ellas el comprobante
    // entra igual y PAGADO, que es lo que evita la deuda falsa.
    for (const k of ["adelanto_1", "fecha_pago", "observaciones"]) delete fila[k];
    ({ data, error } = await sb.from("documentos_compra").insert(fila).select("id").single());
  }
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
  /** `aceptarHistoricas`: una persona decidió registrar TODO lo que el historial dejó en
   *  «revisar» por viejo (botón «Registrar las del historial»). Solo levanta ese candado, y
   *  solo en las líneas que lo tenían. `desfase`: el de la cuenta, si quien llama ya lo tiene. */
  opts: { aceptarHistoricas?: boolean; desfase?: DesfaseCuenta } = {},
): Promise<ResultadoFactura> {
  // CANDADO: dos conciliaciones a la vez (el cron y el botón «Leer correo ahora») verían la
  // misma línea como faltante y la registrarían dos veces. Se reclama la factura con un UPDATE
  // condicional; quien no la consigue no toca nada.
  //
  // `procesada_en` es a la vez el candado y la hora de la última conciliación, así que el reclamo
  // escribe el VENCIMIENTO del candado (ahora + 60 s, por si la función muere a mitad) y el final
  // escribe la hora real, que ya quedó atrás: la factura se suelta EN CUANTO termina. Antes el
  // reclamo exigía «más de 60 s desde procesada_en» y el final escribía «ahora», así que cada
  // conciliación terminada dejaba la factura bloqueada otro minuto entero: registrar la segunda
  // línea de una factura de tres cargas decía «otra conciliación en curso» sin que hubiera ninguna.
  const ahora = new Date().toISOString();
  const vence = new Date(Date.now() + 60_000).toISOString();
  const { data: reclamo } = await sb.from("radar_facturas").update({ procesada_en: vence })
    .eq("id", fila.id).or(`procesada_en.is.null,procesada_en.lt.${ahora}`).select("id");
  if (!((reclamo as any[]) ?? []).length) {
    return {
      factura_id: Number(fila.id), estado: fila.estado, plan: Array.isArray(fila.conciliacion) ? fila.conciliacion : [],
      error: "Otra conciliación de esta factura está en curso: reintenta en unos segundos.",
    };
  }
  try {
    return await conciliarReclamada(sb, fila, cuenta, hoy, manual, opts);
  } catch (e) {
    // Si falla a mitad, se suelta igual: esperar el vencimiento sería otro minuto bloqueado.
    await sb.from("radar_facturas").update({ procesada_en: new Date().toISOString() }).eq("id", fila.id);
    throw e;
  }
}

async function conciliarReclamada(
  sb: Parameters<typeof conciliarFacturaGuardada>[0],
  fila: Parameters<typeof conciliarFacturaGuardada>[1],
  cuenta: FilaCuenta | null,
  hoy: string,
  manual: { n: number; placa?: string | null; fecha?: string | null } | undefined,
  opts: { aceptarHistoricas?: boolean; desfase?: DesfaseCuenta },
): Promise<ResultadoFactura> {

  const flota = await cargarFlota(sb);
  const cab: FacturaExtraida = {
    ruc_emisor: fila.ruc_emisor, razon_social: fila.razon_social, tipo_comprobante: fila.tipo_comprobante,
    serie: fila.serie, numero: fila.numero, fecha_emision: fila.fecha_emision, moneda: fila.moneda ?? "PEN",
    subtotal: fila.subtotal, igv: fila.igv, total: fila.total, detraccion_monto: null, placa_detectada: null,
    fuente: fila.fuente_extraccion === "xml_ubl" ? "xml_ubl" : "vision_pdf", confianza: Number(fila.confianza ?? 0),
  };
  // LA FACTURA NO TRAE LA FECHA DEL DESPACHO. La deducida de la emisión se corre al despacho por el
  // desfase de la cuenta —medido sobre las recargas del Radar que casaron con su factura, o el que
  // configuró una persona—; la que trae la línea o eligió una persona no se toca
  // (lib/combustible/desfase-factura.ts → lineasAlDespacho). Toda la conciliación —el cruce con lo
  // registrado, la espera al Radar, el corte del historial y la carga que se registra— juzga con la
  // fecha del DESPACHO, y el cruce busca también alrededor de la de emisión (`fecha_alterna`).
  const emision: string | null = fila.fecha_emision ? String(fila.fecha_emision).slice(0, 10) : null;
  const desfase = opts.desfase ?? (await desfaseDeCuenta(sb, cuenta));
  // El cierre de mes (generada después de su fecha) no es del lote nocturno: ni se corre ni se
  // fecha sola si junta varias cargas. Las consolidadas se fechan con SU medición, si es sólida.
  const tardia = generadaDespues(emision, fila.recibido_en);
  const consolidadas = desfase.consolidadas?.fechar ? desfase.consolidadas : null;
  const alDespacho = lineasAlDespacho<LineaFactura>(Array.isArray(fila.lineas) ? fila.lineas : [], emision, desfase.dias, manual, {
    consolidada: consolidadas ? consolidadas.dias : null, tardia,
  });
  const origenDe = alDespacho.origen;
  let lineas: LineaFactura[] = alDespacho.lineas;
  if (manual?.placa) {
    lineas = lineas.map((l) => (l.n === manual.n ? { ...l, placa: normPlaca(manual.placa) } : l));
  }
  const corrida = (n: number) => origenDe.get(n) === "emision" && desfase.dias > 0 && !!emision && !tardia;
  const deConsolidada = (n: number) => origenDe.get(n) === "consolidada" && !!consolidadas && !!emision;
  // Los días que se le restaron a la emisión para fechar esta línea (0: no se corrió).
  const diasCorridos = (n: number) => (corrida(n) ? desfase.dias : deConsolidada(n) ? consolidadas!.dias : 0);
  const fechaGenerada = diaLima(fila.recibido_en);

  // Candidatos: cargas en la ventana de fechas de la factura (±3 días), las alternas incluidas.
  const fechas = lineas.flatMap((l) => [l.fecha, l.fecha_alterna]).filter(Boolean) as string[];
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

  // LA ESPERA AL RADAR SE DECIDE POR LO QUE TIENE EN COLA, NO POR DÍAS FIJOS. El voucher llega
  // por WhatsApp antes que la factura (lote nocturno del grifo): si el Radar no tiene ningún
  // mensaje sin procesar desde el día del despacho y la carga no está, no va a llegar por ahí y
  // esperar solo deja el gasto y el saldo fuera del ERP. Se leen una vez los mensajes que pueden
  // ser un reporte de combustible (`pareceCombustible`, la misma regla del motor) y aún no se
  // procesaron. Si la consulta falla, null: se espera el tope, como antes.
  const fechasDespacho = lineas.map((l) => l.fecha).filter(Boolean).sort() as string[];
  let colaRadar: string[] | null = [];
  if (fechasDespacho.length) {
    const { data: enCola, error: eCola } = await sb.from("radar_mensajes")
      .select("recibido_en, tipo, texto")
      .in("estado", ["pendiente", "procesando"])
      .gte("recibido_en", `${fechasDespacho[0]}T05:00:00Z`)
      .limit(1000);
    colaRadar = eCola ? null
      : ((enCola as { recibido_en: string; tipo: string | null; texto: string | null }[] | null) ?? [])
        .filter(pareceCombustible).map((m) => String(m.recibido_en));
  }
  // Desde las 00:00 Lima del día del despacho (UTC-5).
  const enColaDesde = (fecha: string | null): number | null =>
    colaRadar == null ? null : !fecha ? 0 : colaRadar.filter((t) => Date.parse(t) >= Date.parse(`${fecha}T05:00:00Z`)).length;

  let docId: number | null = fila.documento_compra_id ?? null;
  const usados = new Set<string>();
  const plan: ResultadoFactura["plan"] = [];
  const grifo = cab.razon_social || cuenta?.nombre || "Grifo";

  for (const l of lineas) {
    const antes = previo.get(l.n);
    // «Registrar las del historial» levanta el candado SOLO de las líneas que la persona vio en
    // el resumen —las que quedaron en «revisar» por viejas—; el resto de la factura sigue sus
    // reglas. Y para esas la decisión ya está tomada: se registran aunque el registro automático
    // de la cuenta esté apagado, igual que una línea confirmada a mano.
    const aceptada = !!opts.aceptarHistoricas && antes?.codigo === "revisar" && antes?.motivo === "historico";
    const decidida = manual?.n === l.n || aceptada;
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
      radarEnCola: enColaDesde(l.fecha),
      autoRegistrar: decidida ? true : cuenta?.facturas_auto_registrar ?? true,
      // Lo del historial no se registra solo (lib/combustible/factura-lineas.ts).
      diasAutoRegistro: decidida ? null : DIAS_REGISTRO_AUTOMATICO,
    });
    // El candado del PDF no se salta solo por confirmar: confirmar ES leer la factura.
    const confirmada = manual?.n === l.n && p.codigo === "revisar" && p.motivo === "lectura_no_oficial";
    const final: PlanLinea & { combustible_id?: number | string } = confirmada ? { ...p, codigo: "registrar", motivo: undefined } : { ...p };
    if (final.codigo === "registrar" && manual?.n !== l.n && antes?.codigo === "registrar" && antes?.combustible_id != null) {
      // La registró esta misma factura y ya no está: alguien la borró. Volver a crearla sola
      // sería pelearse con esa persona cada 3 horas.
      final.codigo = "revisar"; final.motivo = "eliminada";
      final.detalle = `La carga #${antes.combustible_id} que se registró desde esta factura ya no existe (¿se borró a mano?). Si falta de verdad, confírmala otra vez.`;
    }
    if (final.casa_con != null) usados.add(String(final.casa_con));
    // Qué fecha se usó y por qué: la pantalla la enseña junto a la de emisión, y la corrección de
    // las cargas viejas (cargasPorMover) lee el origen de aquí antes que inferirlo.
    final.fecha_origen = origenDe.get(l.n) ?? null;
    const sinEnlace = final.codigo !== "ya_registrada" && final.codigo !== "en_radar_pendiente" && final.codigo !== "no_es_combustible";
    if (diasCorridos(l.n) > 0) {
      final.desfase = { emision: emision!, dias: diasCorridos(l.n) };
      if (sinEnlace) {
        final.detalle += corrida(l.n)
          ? ` Fecha del despacho ${l.fecha}: la factura se emitió el ${emision} (${desfase.codigo === "fijo" ? "desfase configurado" : "desfase medido"} de ${desfase.dias} día(s)).`
          : ` Fecha del despacho ${l.fecha}: la factura junta un solo día y se emitió el ${emision} (medido en las facturas de varias cargas: ${consolidadas!.dias} día(s) antes).`;
      }
    } else if (deConsolidada(l.n) && sinEnlace) {
      final.detalle += ` Fecha ${l.fecha}: la de emisión (medido: cada factura de varias cargas junta un solo día, el de su emisión).`;
    }
    // (La de varias cargas sin fecha de un cierre de mes lo dice la pantalla, junto a la línea.)
    if (tardia && fechaGenerada && sinEnlace && origenDe.get(l.n) === "emision" && desfase.dias > 0) {
      final.detalle += ` La factura se generó el ${fechaGenerada} aunque dice ${emision} (cierre de mes): se deja la fecha de emisión.`;
    }

    if (final.codigo === "registrar" && final.propuesta) {
      // El comprobante fiscal existe ANTES de la carga: la carga nace enlazada a él.
      if (docId == null) docId = await asegurarDocumento(sb, cab, false, cuenta);
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
          // Una carga fechada por el desfase dice por qué no lleva la fecha de su factura.
          observaciones: observacionCargaDeFactura(ref, l.nota_despacho, diasCorridos(l.n) > 0 ? notaFechaDespacho(emision!, diasCorridos(l.n)) : null),
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
    docId = await asegurarDocumento(sb, cab, todo, cuenta);
  } else if (docId != null && todo) {
    await asegurarDocumento(sb, cab, true, cuenta);
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

  // LA DECISIÓN DE LA PERSONA SE GUARDA EN LA LÍNEA (lineasConDecision), y solo si tomó efecto —la
  // línea quedó registrada o enlazada—: sin esto, la pasada siguiente la devolvía a «revisar» y una
  // factura de varias cargas no llegaba nunca a «conciliada».
  const pm = manual ? plan.find((p) => p.n === manual.n) : undefined;
  const tomo = !!pm && (pm.codigo === "ya_registrada" || (pm.codigo === "registrar" && pm.combustible_id != null));
  const lineasGuardar = tomo ? lineasConDecision(Array.isArray(fila.lineas) ? fila.lineas : [], manual!) : null;

  const estado = !plan.length ? "con_diferencia" : todo ? "conciliada" : "parcial";
  await sb.from("radar_facturas").update({
    estado, conciliacion: plan, documento_compra_id: docId, cuenta_id: cuenta?.id ?? null,
    procesada_en: new Date().toISOString(),
    diferencia_detalle: !plan.length ? "La factura no trae líneas legibles." : null,
    ...(lineasGuardar ? { lineas: lineasGuardar } : {}),
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
  /** De QUÉ buzón se leyó: sin esto, «0 correos» no dice si el filtro está mal o el buzón es otro. */
  correo?: { email: string | null; fuente: "facturas" | "crm" | null };
  /** Correos que coinciden y quedaron SIN leer en esta corrida (tope o tiempo): la próxima sigue. */
  pendientes: number;
  /** Líneas que faltan en el ERP pero son del historial: esperan a una persona (no se registran solas). */
  historicas: number;
  /** Facturas que solo llegaron en PDF y se leyeron con IA (lo único de esta lectura que cuesta). */
  con_ia: number;
};

/** La lectura del ÚLTIMO AÑO («Leer el último año»): más correos por corrida, sin el repaso de
 *  las parciales (eso lo hace el cron) y con un presupuesto de tiempo corto, para que la pantalla
 *  enseñe el avance tanda por tanda en vez de quedarse muda varios minutos. Leer un XML no gasta
 *  IA; un PDF con nombre de comprobante sí, y se cuenta en `con_ia`. */
export const LECTURA_HISTORIAL = { dias: 366, maxListar: 1000, tope: 50, presupuestoMs: 60_000, revisarParciales: false } as const;

/** El token del buzón que toca, o el motivo (con la misma frase que la pantalla) de por qué no. */
async function tokenDeLectura(sb: any): Promise<{ token: string; email: string | null; fuente: "facturas" | "crm" } | { error: string }> {
  const con = await conexionCorreoFacturas(sb);
  if (!con.token || !con.fuente) {
    const d = describirConexion(con);
    return { error: `${d.titulo}. ${d.detalle}` };
  }
  return { token: con.token, email: con.email, fuente: con.fuente };
}

/**
 * La consulta de Gmail que de verdad se corre: el filtro de la cuenta, MÁS los adjuntos que llevan
 * el RUC de la cuenta, + la ventana de días.
 *
 * EL RUC ES LO QUE ENCUENTRA LAS FACTURAS, NO EL REMITENTE. Las de COESTI no las manda Primax:
 * las manda el servicio de facturación electrónica (`factura.peru@cen.biz`), y el filtro por
 * remitente no encontró ni una en un año. Pero SUNAT exige nombrar el archivo de toda factura
 * electrónica con el RUC de quien la emite (`20127765279-01-F882-0132184.xml`), así que el RUC
 * que la cuenta ya declara las encuentra las mande quien las mande.
 */
export function consultaGmail(filtro: string | null | undefined, dias = DIAS_REGISTRO_AUTOMATICO, rucs: readonly string[] = []): string {
  const base = (filtro || "").trim() || "has:attachment";
  // Un RUC que el filtro ya nombra no se repite (la pantalla sugería escribirlo ahí a mano).
  const porRuc = [...new Set(rucs.map((r) => String(r).trim()).filter((r) => /^\d{11}$/.test(r) && !base.includes(r)))]
    .map((r) => `(${r} has:attachment)`);
  const q = porRuc.length ? `((${base}) OR ${porRuc.join(" OR ")})` : base;
  return `${q} newer_than:${dias}d`;
}

export type MuestraFiltro = {
  ok: boolean;
  error?: string;
  correo?: { email: string | null; fuente: "facturas" | "crm" | null };
  consulta: string;
  estimado: number;
  mensajes: { id: string; fecha: string | null; de: string; asunto: string; adjuntos: string[] }[];
};

/** «Probar filtro»: qué correos encontraría la sincronización, SIN procesar ninguno. */
export async function probarFiltro(sb: any, filtro: string | null | undefined, rucs: readonly string[] = [], max = 10): Promise<MuestraFiltro> {
  // La MISMA consulta que corre la sincronización: si la muestra usara otra, «0 correos» no
  // diría nada sobre lo que el ERP va a leer.
  const consulta = consultaGmail(filtro, DIAS_REGISTRO_AUTOMATICO, rucs);
  const t = await tokenDeLectura(sb);
  if ("error" in t) return { ok: false, error: t.error, consulta, estimado: 0, mensajes: [] };
  const j = await gget(t.token, `/messages?maxResults=${max}&q=${encodeURIComponent(consulta)}`);
  const mensajes: MuestraFiltro["mensajes"] = [];
  for (const m of (j.messages ?? []).slice(0, max)) {
    try {
      const msg = await gget(t.token, `/messages/${m.id}?format=full`);
      const hs = msg.payload?.headers;
      mensajes.push({
        id: m.id,
        fecha: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
        de: header(hs, "from"),
        asunto: header(hs, "subject") || "(sin asunto)",
        adjuntos: adjuntosDe(msg.payload).map((a) => a.nombre).filter(Boolean),
      });
    } catch { /* un correo que no se pudo abrir no tumba la muestra */ }
  }
  return {
    ok: true, consulta, mensajes,
    estimado: Number(j.resultSizeEstimate ?? mensajes.length),
    correo: { email: t.email, fuente: t.fuente },
  };
}

// ── El documento de una factura, para revisarlo (lib/combustible/factura-de-carga.ts) ──

export type DocumentoFactura =
  | { ok: true; nombre: string; tipo: "pdf" | "xml"; data: Buffer }
  | { ok: false; status: number; error: string };

/**
 * Baja del correo el documento de una factura ya leída —el PDF del comprobante; si no llegó, su
 * XML— con la MISMA credencial con que se leyó, para enseñarlo junto a la carga que respalda. Nada
 * se guarda en el ERP: el papel vive en el correo, y una copia sería un segundo original que puede
 * quedar distinto (y otro bucket más con datos fiscales). Lo que falla se dice con la etapa.
 */
export async function documentoDeFactura(sb: Parameters<typeof tokenDeLectura>[0], facturaId: number): Promise<DocumentoFactura> {
  const { data: f, error } = await sb.from("radar_facturas").select("id, gmail_message_id").eq("id", facturaId).maybeSingle();
  if (error) return { ok: false, status: 500, error: `No se pudo leer la factura: ${error.message}` };
  if (!f) return { ok: false, status: 404, error: "Esa factura ya no está en la bandeja del correo." };
  const id = String(f.gmail_message_id ?? "").trim();
  if (!id) return { ok: false, status: 409, error: "Esta factura no guarda de qué correo salió." };
  const t = await tokenDeLectura(sb);
  if ("error" in t) return { ok: false, status: 409, error: `No se puede abrir el correo: ${t.error}` };
  const motivo = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);
  let msg: { payload?: unknown };
  try {
    msg = await gget(t.token, `/messages/${encodeURIComponent(id)}?format=full`);
  } catch (e) {
    const m = motivo(e);
    return /not found|invalid id/i.test(m)
      ? { ok: false, status: 404, error: `El correo ya no está en ${t.email ?? "el buzón conectado"}: se borró, o esta factura se leyó desde otro buzón.` }
      : { ok: false, status: 502, error: `Gmail no lo entregó: ${m}` };
  }
  let adj: Adjunto[];
  try {
    adj = await descargarAdjuntos(t.token, id, msg.payload, (n) => /\.(pdf|xml|zip)$/i.test(n));
  } catch (e) {
    return { ok: false, status: 502, error: `No se pudieron bajar los adjuntos de Gmail: ${motivo(e)}` };
  }
  const elegido = elegirDocumentoFactura(adj.map((a) => ({
    nombre: a.nombre,
    texto: /\.xml$/i.test(a.nombre) ? a.data.toString("utf-8") : null,
    inicio: a.data.subarray(0, 5).toString("latin1"),
  })));
  if (!elegido) {
    const nombres = adjuntosDe(msg.payload).map((a) => a.nombre).filter(Boolean);
    return {
      ok: false, status: 404,
      error: nombres.length ? `El correo trae ${nombres.join(", ")}, y ninguno es el PDF ni el XML de la factura.` : "El correo no trae adjuntos.",
    };
  }
  const a = adj[elegido.indice];
  return { ok: true, nombre: a.nombre, tipo: elegido.tipo, data: a.data };
}

/** Qué buzón se lee hoy, para abrir sus correos en ESA cuenta de Gmail. Sin pedir el token del CRM. */
export async function buzonDeFacturas(sb: Parameters<typeof conexionCorreoFacturas>[0]): Promise<{ email: string | null; fuente: "facturas" | "crm" | null }> {
  const con = await conexionCorreoFacturas(sb, { conToken: false });
  return { email: con.email ?? null, fuente: con.fuente ?? null };
}

/**
 * Lee UN correo y concilia su factura. No lanza: lo que falla queda como fila `error` con la ETAPA
 * en que falló, que es lo que dice dónde mirar (Gmail, el XML, la base…). Antes la fila guardaba
 * solo el mensaje crudo, sin asunto ni fecha si el correo no llegó a abrirse, y la pantalla la
 * pintaba con la fecha del INTENTO: «Error · 5/10» sobre una factura de abril.
 */
export async function procesarCorreo(
  sb: any, token: string, id: string, cuenta: FilaCuenta, flota: Flota, hoy: string, res: ResumenSync,
): Promise<string> {
  let asunto = "", etapa = "abrir el correo en Gmail";
  const meta: Record<string, unknown> = {};
  try {
    const msg = await gget(token, `/messages/${id}?format=full`);
    asunto = header(msg.payload?.headers, "subject");
    const de = header(msg.payload?.headers, "from");
    const fecha = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
    meta.remitente_email = (de.match(/<(.+?)>/)?.[1] ?? de).slice(0, 200);
    meta.recibido_en = fecha;
    // Primero el XML: junto a la factura suele venir la CDR de SUNAT (otro XML), y la factura se
    // elige por su contenido. El PDF solo se baja si no llegó la factura en XML, y solo si tiene
    // nombre de comprobante electrónico (esNombreComprobante): una carta de precios o un estado
    // de cuenta leídos con IA como si fueran factura inventan cargas.
    etapa = "bajar los adjuntos de Gmail";
    const adj = await descargarAdjuntos(token, id, msg.payload, (n) => /\.(xml|zip)$/i.test(n));
    const xml = elegirXmlComprobante(
      adj.filter((a) => /\.xml$/i.test(a.nombre)).map((a) => ({ ...a, texto: a.data.toString("utf-8") })),
    );
    const pdfComprobante = (n: string) => /\.pdf$/i.test(n) && esNombreComprobante(n);
    const pdf = xml ? undefined
      : adj.find((a) => pdfComprobante(a.nombre)) ?? (await descargarAdjuntos(token, id, msg.payload, pdfComprobante))[0];
    const fila: Record<string, unknown> = { gmail_message_id: id, asunto, cuenta_id: cuenta.id, ...meta };
    if (!xml && !pdf) {
      // Se DICE qué trae: «sin factura» sobre un correo con tres adjuntos parece un error de lectura.
      const nombres = adjuntosDe(msg.payload).map((a) => a.nombre).filter(Boolean);
      const lista = nombres.slice(0, 3).join(", ") + (nombres.length > 3 ? ` y ${nombres.length - 3} más` : "");
      const detalle = !nombres.length
        ? "El correo no trae adjuntos (¿solo un enlace de descarga?): no hay factura que leer."
        : `Trae ${lista}, y ninguno es el comprobante electrónico (el XML de SUNAT, o un PDF con su nombre: RUC-tipo-serie-número). No se lee con IA: una carta de precios o un estado de cuenta leídos como factura inventan cargas.`;
      etapa = "guardar el correo";
      await sb.from("radar_facturas").upsert(
        { ...fila, estado: "sin_adjunto", error: null, diferencia_detalle: detalle },
        { onConflict: "gmail_message_id" },
      );
      res.detalle.push({ asunto, estado: "sin_adjunto" });
      return "sin_adjunto";
    }
    let cab: FacturaExtraida, lineas: LineaFactura[], costo = { in: 0, out: 0 };
    if (xml) {
      etapa = "leer el XML de SUNAT";
      const texto = xml.texto;
      cab = parseUblFactura(texto);
      const lu = lineasUbl(texto, flota.placas);
      lineas = completarConDocumento(lu.lineas, lu.textoDoc, flota.placas, cab.fecha_emision);
    } else {
      etapa = "leer el PDF con IA";
      const r = await leerPdf(pdf!.data);
      res.con_ia++;
      cab = r.cab; costo = r.costo;
      // La placa que la IA leyó se valida contra la flota igual que la del XML.
      lineas = r.lineas.map((l) => {
        const enFlota = l.placa && flota.placas.includes(l.placa) ? l.placa : null;
        return { ...l, placa: enFlota };
      });
      lineas = completarConDocumento(lineas, "", flota.placas, cab.fecha_emision);
    }
    etapa = "guardar la factura";
    const { data: ins, error } = await sb.from("radar_facturas").upsert({
      ...fila, estado: "procesada", error: null,
      ruc_emisor: cab.ruc_emisor, razon_social: cab.razon_social, tipo_comprobante: cab.tipo_comprobante,
      serie: cab.serie, numero: cab.numero, fecha_emision: cab.fecha_emision, moneda: cab.moneda,
      subtotal: cab.subtotal, igv: cab.igv, total: cab.total, confianza: cab.confianza,
      fuente_extraccion: cab.fuente, lineas, tokens_entrada: costo.in, tokens_salida: costo.out,
      placa_detectada: [...new Set(lineas.map((l) => l.placa).filter(Boolean))].join(", ") || null,
    }, { onConflict: "gmail_message_id" }).select("*").single();
    if (error) throw new Error(error.message);
    res.nuevas++;
    etapa = "compararla con las cargas registradas";
    const r = await conciliarFacturaGuardada(sb, ins, cuenta, hoy);
    res.registradas += r.plan.filter((p) => p.codigo === "registrar").length;
    res.por_revisar += r.plan.filter((p) => p.codigo === "revisar" || p.codigo === "en_radar_pendiente").length;
    res.historicas += r.plan.filter((p) => p.motivo === "historico").length;
    res.detalle.push({ asunto, estado: r.estado });
    return r.estado;
  } catch (e: any) {
    const texto = `No se pudo ${etapa}: ${e?.message ?? e}`.slice(0, 500);
    res.detalle.push({ asunto, estado: "error", error: texto });
    const filaError: Record<string, unknown> = { gmail_message_id: id, estado: "error", error: texto, cuenta_id: cuenta.id, ...meta };
    if (asunto) filaError.asunto = asunto;
    // ignoreDuplicates: un error de ESTA corrida no puede pisar la fila buena que dejó otra. Si la
    // fila ya era un error, se le pone el motivo de AHORA (el del intento anterior puede ser otro).
    await sb.from("radar_facturas").upsert(filaError, { onConflict: "gmail_message_id", ignoreDuplicates: true });
    await sb.from("radar_facturas").update(filaError).eq("gmail_message_id", id).eq("estado", "error");
    return "error";
  }
}

export async function sincronizarFacturas(
  sb: any, cuenta: FilaCuenta, hoy: string,
  opts: { dias?: number; maxListar?: number; tope?: number; presupuestoMs?: number; revisarParciales?: boolean } = {},
): Promise<ResumenSync> {
  const t0 = Date.now();
  const res: ResumenSync = {
    ok: true, correos_vistos: 0, nuevas: 0, reconciliadas: 0, registradas: 0, por_revisar: 0, detalle: [], pendientes: 0, historicas: 0, con_ia: 0,
  };
  const t = await tokenDeLectura(sb);
  if ("error" in t) return { ...res, ok: false, error: t.error };
  const token = t.token;
  res.correo = { email: t.email, fuente: t.fuente };

  const q = consultaGmail(cuenta.correo_filtro, opts.dias ?? DIAS_REGISTRO_AUTOMATICO, cuenta.rucs ?? []);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const j = await gget(token, `/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const m of j.messages ?? []) ids.push(m.id);
    pageToken = j.nextPageToken;
  } while (pageToken && ids.length < (opts.maxListar ?? 200));
  res.correos_vistos = ids.length;

  // Un correo que dio ERROR se vuelve a intentar (su fila se reemplaza); el resto, una vez. Los
  // que ya fallaron van AL FINAL de la cola: si no, un correo que falla siempre ocuparía el primer
  // puesto de cada corrida y la lectura del historial no avanzaría nunca.
  const yaVistas: any[] = [];
  for (let k = 0; k < ids.length; k += 200) {
    const { data } = await sb.from("radar_facturas").select("gmail_message_id, estado").in("gmail_message_id", ids.slice(k, k + 200));
    yaVistas.push(...((data as any[]) ?? []));
  }
  const vistas = new Set(yaVistas.filter((r) => r.estado !== "error").map((r) => r.gmail_message_id));
  const fallidas = new Set(yaVistas.filter((r) => r.estado === "error").map((r) => r.gmail_message_id));
  const porLeer = [...ids.filter((x) => !vistas.has(x) && !fallidas.has(x)), ...ids.filter((x) => fallidas.has(x))];
  const flota = await cargarFlota(sb);

  // Tope por corrida: la visión cuesta y la función tiene 300 s. Lo que quede, en la próxima.
  const tope = opts.tope ?? 15;
  let leidos = 0;
  for (const id of porLeer) {
    if (leidos >= tope || (opts.presupuestoMs != null && Date.now() - t0 > opts.presupuestoMs)) break;
    leidos++;
    await procesarCorreo(sb, token, id, cuenta, flota, hoy, res);
  }

  res.pendientes = porLeer.length - leidos;

  // Las parciales (y una «procesada» que quedó a medias) se vuelven a mirar: una línea «esperando al Radar» se registra cuando vence
  // su gracia, y una «ya registrada» puede aparecer porque alguien aprobó la del Radar.
  if (opts.revisarParciales === false) return res;
  const r = await reconciliarPendientes(sb, () => cuenta, hoy);
  res.reconciliadas += r.reconciliadas;
  res.registradas += r.registradas;
  for (const e of r.errores) res.detalle.push({ asunto: e.asunto, estado: "error", error: e.error });
  return res;
}

export type ResultadoReconciliar = {
  reconciliadas: number;
  /** Líneas que en esta pasada se registraron desde la factura (no lo estaban antes). */
  registradas: number;
  /** Líneas que en esta pasada se ENLAZARON con una carga ya registrada (a mano, o por el Radar). */
  enlazadas: number;
  /** Facturas que otra conciliación tenía tomadas: quedan para la próxima. */
  ocupadas: number;
  errores: { asunto: string; error: string }[];
};

/**
 * Vuelve a cruzar las facturas con líneas pendientes contra lo que HOY está registrado, sin leer
 * el correo. Lo hace el cron (dentro de la sincronización) y la pestaña Facturas al abrirse, y
 * después de registrar una carga a mano en /combustible: sin esto, una carga tecleada a mano que
 * ES una línea de la factura seguía apareciendo como «Esperando al Radar» hasta el próximo ciclo
 * del correo (3 h), con un botón que invita a registrarla otra vez. No inventa ninguna regla:
 * es `conciliarFacturaGuardada`, la misma de siempre, que enlaza lo que casa por nota de despacho
 * o placa + fecha + importe y solo registra lo que de verdad falta.
 */
export async function reconciliarPendientes(
  sb: Parameters<typeof conciliarFacturaGuardada>[0],
  cuentaDe: (factura: { cuenta_id?: number | string | null }) => FilaCuenta | null,
  hoy: string,
  opts: { presupuestoMs?: number } = {},
): Promise<ResultadoReconciliar> {
  const t0 = Date.now();
  const out: ResultadoReconciliar = { reconciliadas: 0, registradas: 0, enlazadas: 0, ocupadas: 0, errores: [] };
  const { data: parciales } = await sb.from("radar_facturas").select("*")
    .in("estado", ["parcial", "procesada"]).gte("recibido_en", new Date(Date.now() - 60 * 86400000).toISOString()).limit(40);
  for (const f of (parciales as any[]) ?? []) {
    if (!Array.isArray(f.lineas)) continue;
    if (opts.presupuestoMs != null && Date.now() - t0 > opts.presupuestoMs) break;
    try {
      const r = await conciliarFacturaGuardada(sb, f, cuentaDe(f), hoy);
      if (r.error) { out.ocupadas++; continue; } // la acaba de conciliar esta misma corrida (o otra en paralelo)
      out.reconciliadas++;
      const previo = new Map<number, string>(((f.conciliacion ?? []) as any[]).map((c) => [Number(c.n), String(c.codigo)]));
      out.registradas += r.plan.filter((p) => p.codigo === "registrar" && previo.get(p.n) !== "registrar").length;
      out.enlazadas += r.plan.filter((p) => p.codigo === "ya_registrada" && previo.get(p.n) !== "ya_registrada").length;
    } catch (e: unknown) {
      out.errores.push({ asunto: f.asunto ?? `#${f.id}`, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export type ResultadoHistoricas = {
  ok: boolean;
  error?: string;
  /** Facturas conciliadas en esta corrida, y cuántas cargas se registraron en ellas. */
  facturas: number;
  registradas: number;
  /** Facturas con líneas del historial que quedaron para la próxima corrida (tiempo) o porque
   *  otra conciliación las tenía tomadas en ese momento (`ocupadas`, se reintentan en un minuto). */
  quedan: number;
  ocupadas: number;
  errores: string[];
};

/**
 * «Registrar las del historial»: una persona vio cuántas cargas son y por cuánto, y decidió
 * registrarlas todas. Se re-concilia cada factura levantando SOLO el candado del historial: si una
 * carga apareció en el ERP mientras tanto, la línea casa y no se duplica (es la misma conciliación
 * de siempre, no un INSERT a ciegas desde la lista de la pantalla).
 */
export async function registrarHistoricas(
  sb: any, cuentas: FilaCuenta[], hoy: string, opts: { presupuestoMs?: number } = {},
): Promise<ResultadoHistoricas> {
  const t0 = Date.now();
  const res: ResultadoHistoricas = { ok: true, facturas: 0, registradas: 0, quedan: 0, ocupadas: 0, errores: [] };
  // El MISMO filtro con el que la pantalla contó las cargas (FILTRO_HISTORICO).
  const { data, error } = await sb.from("radar_facturas").select("*")
    .in("estado", [...FILTRO_HISTORICO.estados])
    .contains("conciliacion", FILTRO_HISTORICO.conciliacion)
    .order("recibido_en", { ascending: false }).limit(1000);
  if (error) return { ...res, ok: false, error: error.message };
  const filas = (data as any[]) ?? [];
  let i = 0;
  for (; i < filas.length; i++) {
    // Tandas cortas: la pantalla vuelve a llamar mientras `quedan`, y así enseña el avance.
    if (Date.now() - t0 > (opts.presupuestoMs ?? 60_000)) break;
    const f = filas[i];
    const cuenta = cuentas.find((c) => c.id === Number(f.cuenta_id)) ?? cuentas[0] ?? null;
    try {
      const antes = new Set(((f.conciliacion ?? []) as any[]).filter((c) => c.codigo === "registrar").map((c) => c.n));
      const r = await conciliarFacturaGuardada(sb, f, cuenta, hoy, undefined, { aceptarHistoricas: true });
      if (r.error) { res.ocupadas++; continue; }
      res.facturas++;
      res.registradas += r.plan.filter((p) => p.codigo === "registrar" && !antes.has(p.n)).length;
    } catch (e: any) {
      res.errores.push(`${f.serie ?? ""}-${f.numero ?? f.id}: ${e?.message ?? e}`);
    }
  }
  res.quedan = filas.length - i;
  return res;
}

export type ResultadoReintento = {
  ok: boolean;
  error?: string;
  reintentados: number;
  resueltos: number;
  siguen: number;
  /** Filas con error que quedaron para la próxima tanda (tiempo). La pantalla vuelve a llamar
   *  con `desde_id = ultimo_id` hasta que no quede ninguna. */
  quedan: number;
  ultimo_id: number | null;
  correo?: { email: string | null; fuente: "facturas" | "crm" | null };
  /** Los motivos de los que siguen fallando (la pantalla los enseña en cada fila). */
  motivos: string[];
};

/**
 * «Reintentar los que fallaron»: vuelve a leer, POR SU ID, los correos que quedaron en `error`.
 * No pasa por la consulta de Gmail a propósito: la lectura normal solo mira 45 días, así que un
 * correo de abril que falló en la lectura del año no volvería a pasar nunca. Cada fila se intenta
 * UNA vez por pulsación: la pantalla avanza con `desdeId` en vez de volver a empezar, o los que
 * fallan siempre ocuparían todas las tandas.
 */
export async function reintentarErrores(
  sb: any, cuentas: FilaCuenta[], hoy: string, opts: { desdeId?: number; presupuestoMs?: number } = {},
): Promise<ResultadoReintento> {
  const t0 = Date.now();
  const vacio: ResultadoReintento = { ok: true, reintentados: 0, resueltos: 0, siguen: 0, quedan: 0, ultimo_id: null, motivos: [] };
  const t = await tokenDeLectura(sb);
  if ("error" in t) return { ...vacio, ok: false, error: t.error };
  // Solo las de ESTE módulo (llevan cuenta): la bandeja de Contabilidad escribe en la misma tabla.
  const { data, error } = await sb.from("radar_facturas").select("id, gmail_message_id, cuenta_id")
    .eq("estado", "error").not("gmail_message_id", "is", null).not("cuenta_id", "is", null)
    .gt("id", opts.desdeId ?? 0).order("id").limit(500);
  if (error) return { ...vacio, ok: false, error: error.message };
  const filas = (data as any[]) ?? [];
  const res: ResumenSync = {
    ok: true, correos_vistos: 0, nuevas: 0, reconciliadas: 0, registradas: 0, por_revisar: 0, detalle: [], pendientes: 0, historicas: 0, con_ia: 0,
  };
  const flota = await cargarFlota(sb);
  const out: ResultadoReintento = { ...vacio, correo: { email: t.email, fuente: t.fuente } };
  let i = 0;
  for (; i < filas.length; i++) {
    if (Date.now() - t0 > (opts.presupuestoMs ?? 60_000)) break;
    const f = filas[i];
    const cuenta = cuentas.find((c) => c.id === Number(f.cuenta_id)) ?? cuentas.find((c) => c.activo) ?? cuentas[0];
    if (!cuenta) break;
    const estado = await procesarCorreo(sb, t.token, String(f.gmail_message_id), cuenta, flota, hoy, res);
    out.reintentados++;
    out.ultimo_id = Number(f.id);
    if (estado === "error") out.siguen++; else out.resueltos++;
  }
  out.quedan = filas.length - i;
  out.motivos = [...new Set(res.detalle.filter((d) => d.estado === "error").map((d) => d.error ?? ""))].filter(Boolean).slice(0, 5);
  return out;
}

// ── El desfase entre el despacho y la emisión de la factura ──────────────────

/**
 * Los despachos que leyó el RADAR entre dos fechas, con la fecha del VOUCHER. Una fila del Radar que
 * ya se registró toma lo que quedó en `combustible` (una persona pudo corregir la fecha al aprobarla);
 * las demás —en revisión, o frenadas por duplicadas de la factura— valen por lo que leyó el Radar: el
 * papel dice cuándo se despachó aunque la carga no se haya registrado desde ahí. Las descartadas no
 * cuentan. Ni las cargas que registró una factura (llevan la emisión) ni las tecleadas a mano son
 * evidencia: solo la fila del Radar.
 */
async function vouchersDelRadar(sb: any, desde: string, hasta: string): Promise<VoucherRadar[]> {
  const filas: any[] = [];
  for (let pag = 0; pag < 20; pag++) {
    const { data, error } = await sb.from("radar_combustible")
      .select("id, placa, fecha, monto_total, galones, litros, combustible_id, estado")
      .gte("fecha", desde).lte("fecha", hasta).neq("estado", "descartado")
      .order("id").range(pag * 1000, pag * 1000 + 999);
    if (error) throw new Error(`radar_combustible: ${error.message}`);
    filas.push(...((data as any[]) ?? []));
    if (((data as any[]) ?? []).length < 1000) break;
  }
  const ids = [...new Set(filas.map((r) => Number(r.combustible_id)).filter((n) => Number.isFinite(n) && n > 0))];
  const cargas = new Map<number, any>();
  for (let k = 0; k < ids.length; k += 200) {
    const { data: cs, error: e } = await sb.from("combustible")
      .select("id, fecha, total, galones, observaciones, vehiculo_id, vehiculo_tercero_id").in("id", ids.slice(k, k + 200));
    if (e) throw new Error(`combustible: ${e.message}`);
    for (const c of (cs as any[]) ?? []) cargas.set(Number(c.id), c);
  }
  const flota = ids.length ? await cargarFlota(sb) : null;
  const placaDe = new Map<string, string>();
  for (const [p, id] of flota?.propias ?? []) placaDe.set(`p${id}`, p);
  for (const [p, id] of flota?.terceros ?? []) placaDe.set(`t${id}`, p);
  const out: VoucherRadar[] = [];
  const vistos = new Set<string>();
  for (const r of filas) {
    const c = r.combustible_id ? cargas.get(Number(r.combustible_id)) : null;
    // La carga manda si la registró el Radar o si se FUSIONÓ con el voucher: en las dos, su fecha es la
    // del papel confirmada por una persona; la de la fila del Radar es la que leyó la IA.
    const v: VoucherRadar = c && (esCargaDelRadar(c.observaciones) || esCargaFusionada(c.observaciones))
      ? {
          placa: (c.vehiculo_id != null ? placaDe.get(`p${c.vehiculo_id}`) : c.vehiculo_tercero_id != null ? placaDe.get(`t${c.vehiculo_tercero_id}`) : null) ?? r.placa ?? null,
          fecha: c.fecha ? String(c.fecha).slice(0, 10) : null,
          total: c.total == null ? null : Number(c.total),
          cantidad: c.galones == null ? null : Number(c.galones),
        }
      : {
          placa: r.placa ?? null,
          fecha: r.fecha ? String(r.fecha).slice(0, 10) : null,
          total: r.monto_total == null ? null : Number(r.monto_total),
          cantidad: r.galones != null ? Number(r.galones) : r.litros != null ? Number(r.litros) : null,
        };
    // La misma recarga en dos filas del Radar es UN despacho: contarla dos veces la volvería ambigua.
    const k = `${normPlaca(v.placa)}|${v.fecha}|${v.total == null ? "" : Number(v.total).toFixed(2)}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Las muestras del desfase de la cuenta (lib/combustible/desfase-factura.ts → muestrasDesfase): cada
 * línea de sus facturas contra los vouchers que leyó el Radar, por placa e importe. Antes se medía
 * sobre los enlaces de la conciliación, que buscaba ±1 día alrededor de la emisión: un desfase de 2
 * no podía aparecer, y las facturas consolidadas —sin fecha con qué buscar— no daban ninguna muestra.
 */
export async function muestrasDeCuenta(sb: any, cuenta: FilaCuenta): Promise<MuestrasDesfase> {
  const { data, error } = await sb.from("radar_facturas").select("fecha_emision, recibido_en, lineas")
    .eq("cuenta_id", cuenta.id).in("estado", ["procesada", "conciliada", "parcial", "con_diferencia"])
    .order("recibido_en", { ascending: false }).limit(1000);
  if (error) throw new Error(`radar_facturas: ${error.message}`);
  const facturas: FacturaParaMedir[] = ((data as any[]) ?? [])
    .filter((f) => f.fecha_emision && Array.isArray(f.lineas))
    .map((f) => ({ fecha_emision: String(f.fecha_emision).slice(0, 10), recibido_en: f.recibido_en ?? null, lineas: f.lineas }));
  if (!facturas.length) return { una: [], consolidada: [], tardias: 0 };
  const fechas = facturas.map((f) => f.fecha_emision as string).sort();
  const vouchers = await vouchersDelRadar(sb, sumarDias(fechas[0], -MAX_DESFASE), sumarDias(fechas[fechas.length - 1], 1));
  return muestrasDesfase(facturas, vouchers);
}

// Una medición por cuenta cada 5 min: una sincronización concilia decenas de facturas seguidas.
const memoDesfase = new Map<number, { t: number; d: DesfaseCuenta }>();

/**
 * El desfase que se le aplica a la cuenta AHORA: el de las facturas de una línea y el de las
 * consolidadas. Si la medición no se puede leer, se decide con cero muestras —`pocos_datos`: la fecha
 * de emisión, y las consolidadas a mano, como siempre—: un fallo de lectura nunca corre fechas.
 */
export async function desfaseDeCuenta(sb: any, cuenta: FilaCuenta | null, opts: { fresco?: boolean } = {}): Promise<DesfaseCuenta> {
  const vacio: MuestrasDesfase = { una: [], consolidada: [], tardias: 0 };
  if (!cuenta) return decidirDesfaseCuenta(null, vacio);
  const configurado = normalizarDesfaseConfig(cuenta.facturas_desfase_dias);
  const m = memoDesfase.get(cuenta.id);
  if (!opts.fresco && m && Date.now() - m.t < 5 * 60_000 && m.d.configurado === configurado) return m.d;
  let muestras = vacio;
  try { muestras = await muestrasDeCuenta(sb, cuenta); }
  catch (e: any) { console.warn("[facturas-correo] desfase:", e?.message ?? e); }
  const d = decidirDesfaseCuenta(configurado, muestras);
  memoDesfase.set(cuenta.id, { t: Date.now(), d });
  return d;
}

/** Las cargas de la cuenta que una factura registró con la fecha de EMISIÓN y que el desfase movería. */
export async function cargasPorMoverDeCuenta(sb: any, cuenta: FilaCuenta, dias: number): Promise<CargaPorMover[]> {
  if (!(dias > 0)) return [];
  const { data, error } = await sb.from("radar_facturas").select("id, serie, numero, fecha_emision, recibido_en, lineas, conciliacion")
    .eq("cuenta_id", cuenta.id).not("conciliacion", "is", null)
    .order("recibido_en", { ascending: false }).limit(2000);
  if (error) throw new Error(`radar_facturas: ${error.message}`);
  const facturas: FacturaRegistrada[] = ((data as any[]) ?? []).map((f) => ({
    factura_id: Number(f.id), serie: f.serie ?? null, numero: f.numero ?? null,
    fecha_emision: f.fecha_emision ? String(f.fecha_emision).slice(0, 10) : null,
    recibido_en: f.recibido_en ?? null,
    lineas: Array.isArray(f.lineas) ? f.lineas : [],
    conciliacion: Array.isArray(f.conciliacion) ? f.conciliacion : [],
  }));
  const ids = [...new Set(facturas.flatMap((f) => f.conciliacion.map((c) =>
    Number(c.codigo === "registrar" ? c.combustible_id : c.codigo === "ya_registrada" ? c.casa_con : NaN))))].filter(Number.isFinite);
  const flota = await cargarFlota(sb);
  const placaDe = new Map<string, string>();
  for (const [p, id] of flota.propias) placaDe.set(`p${id}`, p);
  for (const [p, id] of flota.terceros) placaDe.set(`t${id}`, p);
  const cargas = new Map<number, CargaActual>();
  for (let k = 0; k < ids.length; k += 200) {
    const { data: cs, error: e } = await sb.from("combustible")
      .select("id, fecha, observaciones, total, vehiculo_id, vehiculo_tercero_id").in("id", ids.slice(k, k + 200));
    if (e) throw new Error(`combustible: ${e.message}`);
    for (const r of (cs as any[]) ?? []) {
      cargas.set(Number(r.id), {
        id: Number(r.id), fecha: String(r.fecha).slice(0, 10), observaciones: r.observaciones ?? null,
        total: r.total == null ? null : Number(r.total),
        placa: r.vehiculo_id != null ? placaDe.get(`p${r.vehiculo_id}`) ?? null : r.vehiculo_tercero_id != null ? placaDe.get(`t${r.vehiculo_tercero_id}`) ?? null : null,
      });
    }
  }
  return cargasPorMover(facturas, cargas, dias);
}

export type ResultadoMover = { ok: boolean; error?: string; movidas: number; total: number; cruzan_mes: number };

/**
 * «Moverlas a la fecha del despacho»: SOLO las que la persona vio (`ids`) y con el MISMO desfase que
 * vio (`dias`). La lista se recalcula aquí —no se confía en la del navegador— y si el desfase cambió
 * entre la pantalla y el clic, no se mueve nada: la persona aprobó otra cosa. Cada UPDATE exige que la
 * carga siga con la fecha de emisión: si alguien la cambió mientras tanto, esa persona decidió.
 */
export async function moverCargasADespacho(
  sb: any, cuentas: FilaCuenta[], ids: number[], dias: number,
): Promise<ResultadoMover> {
  const pedidos = new Set(ids.map(Number));
  const res: ResultadoMover = { ok: true, movidas: 0, total: 0, cruzan_mes: 0 };
  for (const cuenta of cuentas.filter((c) => c.activo)) {
    // La lista con el desfase que la persona VIO; si la cuenta tiene alguna de esas cargas y su
    // desfase ya no es ese, no se mueve nada: aprobó otra cosa.
    const lista = (await cargasPorMoverDeCuenta(sb, cuenta, dias)).filter((x) => pedidos.has(x.combustible_id));
    if (!lista.length) continue;
    const d = await desfaseDeCuenta(sb, cuenta, { fresco: true });
    if (d.dias !== dias) {
      return { ...res, ok: false, error: `El desfase de ${cuenta.nombre} cambió (ahora ${d.dias} día(s), en pantalla ${dias}): vuelve a cargar la pestaña antes de mover.` };
    }
    for (const x of lista) {
      const nota = notaFechaDespacho(x.fecha_emision, d.dias);
      const obs = String(x.observaciones ?? "");
      const { data, error } = await sb.from("combustible")
        .update({ fecha: x.hacia, observaciones: obs.includes(nota) ? obs : obs ? `${obs} · ${nota}` : nota })
        .eq("id", x.combustible_id).eq("fecha", x.desde).select("id");
      if (error) return { ...res, ok: false, error: error.message };
      if (((data as any[]) ?? []).length) {
        res.movidas++;
        res.total = r2(res.total + (Number(x.total) || 0));
        if (x.cruza_mes) res.cruzan_mes++;
      }
    }
  }
  return res;
}

// ── Comprobantes de una cuenta prepago que nacieron como deuda ───────────────

export type DeudaFalsa = {
  id: number; serie: string | null; numero: string | null; fecha_emision: string | null;
  total: number; cuenta_id: number | null; observaciones: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Los comprobantes de una cuenta de combustible que figuran como deuda en Tesorería sin serlo.
 * Hasta este arreglo asegurarDocumento los creaba con el `estado_pago` por defecto («impaga»), y
 * los de las facturas que ya se habían leído siguen así: sumando a «Total deuda pendiente» y a un
 * clic de entrar a un lote de pago. Solo los que cuelgan de una factura leída PARA UNA CUENTA
 * (`radar_facturas.cuenta_id`), y solo los que esDeudaFalsaPrepago deja pasar.
 *
 * SI ALGO NO SE PUEDE LEER, NO SE PROPONE NADA: un pago aplicado que no se pudo leer convertiría
 * en «pagado» un comprobante sobre el que alguien ya está actuando.
 */
export async function prepagoComoDeuda(sb: any): Promise<{ ok: boolean; error?: string; docs: DeudaFalsa[]; total: number }> {
  const fallo = (error: string) => ({ ok: false, error, docs: [] as DeudaFalsa[], total: 0 });
  const { data: fs, error: e1 } = await sb.from("radar_facturas").select("documento_compra_id, cuenta_id")
    .not("cuenta_id", "is", null).not("documento_compra_id", "is", null).limit(5000);
  if (e1) return fallo(e1.message);
  const cuentaDe = new Map<number, number>();
  for (const f of (fs as any[]) ?? []) cuentaDe.set(Number(f.documento_compra_id), Number(f.cuenta_id));
  const ids = [...cuentaDe.keys()].filter(Number.isFinite);
  const docs: any[] = [];
  const conPago = new Set<number>(), enLote = new Set<number>();
  for (let k = 0; k < ids.length; k += 200) {
    const tanda = ids.slice(k, k + 200);
    const { data, error } = await sb.from("documentos_compra").select("*").in("id", tanda).eq("estado_pago", "impaga");
    if (error) return fallo(error.message);
    docs.push(...((data as any[]) ?? []));
    const { data: ap, error: e2 } = await sb.from("pagos_aplicacion").select("documento_id")
      .eq("documento_tipo", "documento_compra").in("documento_id", tanda);
    if (e2) return fallo(e2.message);
    for (const a of (ap as any[]) ?? []) conPago.add(Number(a.documento_id));
    const { data: li, error: e3 } = await sb.from("lotes_pago_items").select("documento_id")
      .eq("documento_tipo", "documento_compra").in("documento_id", tanda);
    // Sin la tabla de lotes (fase 06 sin correr) no existe ningún lote: eso no es un fallo de lectura.
    if (e3 && !/does not exist|could not find/i.test(e3.message)) return fallo(e3.message);
    for (const x of (li as any[]) ?? []) enLote.add(Number(x.documento_id));
  }
  const out: DeudaFalsa[] = docs
    .filter((d) => esDeudaFalsaPrepago(d, conPago, enLote))
    .map((d) => ({
      id: Number(d.id), serie: d.serie ?? null, numero: d.numero ?? null, fecha_emision: d.fecha_emision ?? null,
      total: Number(d.total ?? 0), cuenta_id: cuentaDe.get(Number(d.id)) ?? null, observaciones: d.observaciones ?? null,
    }))
    .sort((a, b) => String(a.fecha_emision ?? "").localeCompare(String(b.fecha_emision ?? "")));
  return { ok: true, docs: out, total: r2(out.reduce((s, d) => s + d.total, 0)) };
}

/**
 * «Marcarlos como pagados»: SOLO los que la persona vio (`ids`) y que SIGUEN siendo deuda falsa
 * ahora — la lista se recalcula aquí y no se confía en la del navegador, que pudo quedarse vieja
 * mientras alguien les aplicaba un pago desde Tesorería. Quedan como los crea hoy asegurarDocumento:
 * pagados, cubiertos por el anticipo y con la razón escrita.
 */
export async function marcarPrepagoPagadas(
  sb: any, ids: number[], cuentas: FilaCuenta[],
): Promise<{ ok: boolean; error?: string; marcadas: number; total: number }> {
  const r = await prepagoComoDeuda(sb);
  if (!r.ok) return { ok: false, error: r.error, marcadas: 0, total: 0 };
  const pedidos = new Set(ids.map(Number));
  let marcadas = 0, total = 0;
  for (const d of r.docs.filter((x) => pedidos.has(x.id))) {
    const nota = notaPrepago(cuentas.find((c) => c.id === d.cuenta_id)?.nombre ?? null);
    const patch: Record<string, unknown> = {
      estado_pago: "pagada", adelanto_1: d.total, fecha_pago: d.fecha_emision,
      observaciones: d.observaciones ? `${d.observaciones} · ${nota}` : nota,
    };
    // `.eq("estado_pago","impaga")`: si entre la lista y el clic alguien lo movió, no se pisa.
    let { data, error } = await sb.from("documentos_compra").update(patch).eq("id", d.id).eq("estado_pago", "impaga").select("id");
    if (error && /column .* does not exist|could not find .* column/i.test(error.message)) {
      for (const k of ["adelanto_1", "fecha_pago", "observaciones"]) delete patch[k];
      ({ data, error } = await sb.from("documentos_compra").update(patch).eq("id", d.id).eq("estado_pago", "impaga").select("id"));
    }
    if (error) return { ok: false, error: error.message, marcadas, total: r2(total) };
    if (((data as any[]) ?? []).length) { marcadas++; total += d.total; }
  }
  return { ok: true, marcadas, total: r2(total) };
}

/** Para la pantalla: re-exporta los detectores (la pantalla los usa al elegir una placa). */
export { placasEnTexto, notasEnTexto, fechasEnTexto };
