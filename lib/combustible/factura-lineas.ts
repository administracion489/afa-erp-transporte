// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/factura-lineas.ts — Motor PURO: la factura de combustible que llega por
// correo, línea por línea, contra lo que el ERP ya tiene registrado. No lee la base.
//
// LA FACTURA ES EL RESPALDO OFICIAL DEL RADAR. El Radar lee fotos de WhatsApp: si el
// conductor no mandó la foto, o la lectura falló, la carga no existe en el ERP — y el
// gasto, el costo por km y el saldo de la cuenta salen mal sin que nadie lo note. La
// factura electrónica (el XML de SUNAT) sí llega siempre, y es el documento legal.
//
// Para cada línea se decide UNA cosa, con su código:
//
//   ya_registrada        → existe en `combustible`. Se enlaza a la factura, no se toca nada.
//   en_radar_pendiente   → el Radar la capturó y está en revisión. NO se registra otra:
//                          se duplicaría el día que alguien la apruebe. Se avisa.
//   registrar            → no está en ningún sitio y la línea trae todo lo necesario:
//                          se registra desde la factura (respaldo).
//   revisar              → falta algo para registrarla sin adivinar (placa, fecha, cuadre…).
//   en_espera            → es muy reciente: se le da tiempo al Radar (que trae el km) y se
//                          vuelve a mirar en la próxima sincronización.
//   no_es_combustible    → la línea no es un combustible (un servicio, un lubricante).
//
// LA ASIMETRÍA DE SIEMPRE: registrar de más es contar el mismo gasto DOS veces (y el saldo
// de la cuenta baja el doble); registrar de menos deja una fila en «revisar» con un botón.
// Por eso solo se registra solo con evidencia completa y sin ningún candidato que pueda
// ser la misma carga.
// ──────────────────────────────────────────────────────────────────────────────

import { normalizarTipoCombustible, unidadDeCarga } from "@/lib/combustible-tipos";
import type { OrigenFecha } from "@/lib/combustible/desfase-factura";

// ── 1) Líneas del XML UBL 2.1 ────────────────────────────────────────────────

export type LineaFactura = {
  n: number;
  descripcion: string;
  cantidad: number | null;
  unidad_codigo: string | null;     // GLL, LTR, MTQ…
  precio_unitario: number | null;   // CON impuestos (lo que marca el surtidor)
  total: number | null;             // CON impuestos
  tipo_combustible: string | null;
  placa: string | null;
  fecha: string | null;             // YYYY-MM-DD del despacho, si la línea la trae
  nota_despacho: string | null;     // V72S-00023776
  /**
   * De dónde salió `fecha`: la trae la línea, o se DEDUJO de la emisión (factura de una sola
   * línea). Solo la deducida se corre por el desfase de facturación (lib/combustible/desfase-factura.ts).
   * Las líneas leídas antes de este campo se infieren con `origenFechaLinea`.
   */
  fecha_origen?: OrigenFecha | null;
  /**
   * Otra fecha con la que la MISMA carga puede estar registrada: la de emisión, cuando `fecha` se
   * corrió al despacho. No se guarda; la pone la conciliación. El cruce busca alrededor de las DOS,
   * porque una carga que una factura registró antes con la fecha de emisión tiene que seguir
   * encontrándose —si no, se registraría otra vez—.
   */
  fecha_alterna?: string | null;
};

function tag(xml: string, name: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}
function tagAttr(xml: string, name: string, attr: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*\\b${attr}="([^"]*)"`, "i");
  return re.exec(xml)?.[1] ?? null;
}
function bloques(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const num = (s: string | null | undefined): number | null => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Todo el texto legible de un fragmento XML (sin etiquetas), para buscar placas/notas/fechas. */
export function textoPlano(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Placa, nota de despacho y fecha dentro de un texto ───────────────────────

export const normPlaca = (s?: string | null) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * La placa se busca CONTRA LA FLOTA, no con una expresión regular suelta: «S50», «B5» o un
 * código de artículo tienen forma de placa. Solo vale una placa que el ERP conoce, escrita
 * como palabra (con o sin guion, con o sin espacios: «CWZ-371», «CWZ 371», «CWZ371»).
 * Devuelve TODAS las que aparecen: con dos, la línea no se puede atribuir sola.
 */
export function placasEnTexto(texto: string, flota: string[]): string[] {
  const t = ` ${String(texto ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  const compacto = ` ${String(texto ?? "").toUpperCase().replace(/[^A-Z0-9 ]+/g, "").replace(/\s+/g, " ")} `;
  const out = new Set<string>();
  for (const p of flota) {
    const n = normPlaca(p);
    if (n.length < 5) continue;
    const partida = `${n.slice(0, 3)} ${n.slice(3)}`;
    if (t.includes(` ${n} `) || t.includes(` ${partida} `) || compacto.includes(` ${n} `)) out.add(n);
  }
  return [...out];
}

/** Número de nota de despacho del grifo (V72S-00023776, V97T-00001413). */
export function notasEnTexto(texto: string): string[] {
  const re = /\b([A-Z]\d{2}[A-Z])\s*-\s*(\d{5,8})\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const t = String(texto ?? "").toUpperCase();
  while ((m = re.exec(t))) out.add(`${m[1]}-${m[2]}`);
  return [...out];
}

export function normNota(s?: string | null): string {
  const m = /([A-Z]\d{2}[A-Z])\s*-?\s*0*(\d+)/.exec(String(s ?? "").toUpperCase());
  return m ? `${m[1]}-${m[2]}` : "";
}

/** ¿Existe ese día en el calendario? «31/04» pasa un filtro de rangos (día ≤ 31, mes ≤ 12) y no
 *  existe: como fecha de una carga, Postgres la rechaza y la factura entera queda en error. */
function fechaReal(y: number, mo: number, d: number): boolean {
  const f = new Date(Date.UTC(y, mo - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d;
}

/** Fechas dd/mm/yyyy o yyyy-mm-dd dentro de un texto (solo las que existen). */
export function fechasEnTexto(texto: string): string[] {
  const out = new Set<string>();
  const t = String(texto ?? "");
  for (const m of t.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g)) {
    const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
    if (fechaReal(y, mo, d)) out.add(`${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    if (fechaReal(Number(m[1]), Number(m[2]), Number(m[3]))) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return [...out];
}

/** Unidad UBL (catálogo 03 SUNAT) → la de `combustible.unidad`. */
export function unidadDeCodigo(cod?: string | null): "galones" | "litros" | "m3" | null {
  const c = String(cod ?? "").toUpperCase();
  if (c === "GLL" || c === "GLI" || c === "UGL") return "galones";
  if (c === "LTR") return "litros";
  if (c === "MTQ") return "m3";
  return null;
}

/**
 * Lee las líneas de una factura UBL. El total de la línea se reconstruye CON impuestos
 * (base + su TaxTotal, que en combustible trae IGV e ISC), porque `combustible.total` es lo
 * que marca el surtidor. Si el XML no trae el impuesto de la línea, se cae al precio con
 * impuestos (PricingReference) × cantidad.
 */
export function lineasUbl(xml: string, flota: string[] = []): { lineas: LineaFactura[]; textoDoc: string } {
  const sinLineas = xml.replace(/<(?:\w+:)?(InvoiceLine|CreditNoteLine)\b[\s\S]*?<\/(?:\w+:)?\1>/gi, " ");
  const textoDoc = textoPlano(sinLineas);
  const lineas: LineaFactura[] = [];
  const bls = [...bloques(xml, "InvoiceLine"), ...bloques(xml, "CreditNoteLine")];
  bls.forEach((b, i) => {
    const descripcion = textoPlano(
      bloques(b, "Description").join(" ") || tag(b, "Name") || ""
    );
    const cantidad = num(tag(b, "InvoicedQuantity") ?? tag(b, "CreditedQuantity"));
    const unidad_codigo =
      tagAttr(b, "InvoicedQuantity", "unitCode") ?? tagAttr(b, "CreditedQuantity", "unitCode");
    const base = num(tag(b, "LineExtensionAmount"));
    const taxBlock = bloques(b, "TaxTotal")[0] ?? "";
    const impuesto = num(tag(taxBlock, "TaxAmount"));
    const precioConImp = num(tag(bloques(b, "AlternativeConditionPrice")[0] ?? "", "PriceAmount"));
    let total: number | null = null;
    if (base != null && impuesto != null) total = r2(base + impuesto);
    else if (precioConImp != null && cantidad != null) total = r2(precioConImp * cantidad);
    else if (base != null) total = base;
    const precio_unitario =
      precioConImp ?? (total != null && cantidad ? Math.round((total / cantidad) * 1000) / 1000 : null);
    const textoLinea = textoPlano(b);
    const placas = placasEnTexto(textoLinea, flota);
    const notas = notasEnTexto(textoLinea);
    const fechas = fechasEnTexto(textoLinea);
    lineas.push({
      n: i + 1,
      descripcion,
      cantidad,
      unidad_codigo,
      precio_unitario,
      total,
      tipo_combustible: normalizarTipoCombustible(descripcion),
      placa: placas.length === 1 ? placas[0] : null,
      fecha: fechas.length === 1 ? fechas[0] : null,
      nota_despacho: notas.length === 1 ? notas[0] : null,
    });
  });
  return { lineas, textoDoc };
}

/**
 * Completa lo que la línea no trae con lo que dice el DOCUMENTO, solo cuando el documento
 * no deja lugar a duda: una sola placa en la cabecera/notas, una sola nota de despacho, y la
 * fecha de emisión solo si la factura tiene UNA línea (factura por despacho). Una factura
 * consolidada del mes con la fecha de emisión en cada carga pondría el despacho del día 3
 * el día 30 — se deja sin fecha y va a revisión.
 *
 * La fecha deducida de la emisión queda MARCADA (`fecha_origen: "emision"`): no es la del
 * despacho, y el desfase de facturación (lib/combustible/desfase-factura.ts) solo corre esa.
 */
export function completarConDocumento(
  lineas: LineaFactura[],
  textoDoc: string,
  flota: string[],
  fechaEmision: string | null
): LineaFactura[] {
  const placasDoc = placasEnTexto(textoDoc, flota);
  const notasDoc = notasEnTexto(textoDoc);
  const combustibles = lineas.filter((l) => l.tipo_combustible);
  const unaSola = combustibles.length === 1;
  return lineas.map((l) => {
    const deEmision = !l.fecha && unaSola && !!fechaEmision;
    return {
      ...l,
      placa: l.placa ?? (placasDoc.length === 1 ? placasDoc[0] : null),
      nota_despacho: l.nota_despacho ?? (unaSola && notasDoc.length === 1 ? notasDoc[0] : null),
      fecha: l.fecha ?? (unaSola ? fechaEmision : null),
      fecha_origen: l.fecha ? (l.fecha_origen ?? "linea") : deEmision ? "emision" : null,
    };
  });
}

/**
 * La decisión de una persona, GUARDADA en la línea. Confirmar una línea (placa y/o fecha elegidas a
 * mano) se aplicaba solo a ESA conciliación: `lineas` no se reescribía, así que la pasada siguiente
 * —el cron re-mira las parciales cada 3 h, y confirmar OTRA línea de la misma factura concilia la
 * factura entera— la veía otra vez sin fecha y la devolvía a «revisar». Una factura de varias cargas
 * no podía llegar nunca a «conciliada»: cada confirmación deshacía la anterior. Se guarda con
 * `fecha_origen: "manual"`, que el desfase no corre. Devuelve null si no cambia nada.
 */
export function lineasConDecision<L extends LineaFactura>(
  lineas: readonly L[],
  manual: { n: number; placa?: string | null; fecha?: string | null }
): L[] | null {
  const placa = manual.placa ? normPlaca(manual.placa) || null : null;
  const fecha = manual.fecha && /^\d{4}-\d{2}-\d{2}$/.test(manual.fecha) ? manual.fecha : null;
  let cambio = false;
  const out = (lineas ?? []).map((l) => {
    if (l.n !== manual.n) return l;
    const nueva: L = { ...l, ...(placa ? { placa } : {}), ...(fecha ? { fecha, fecha_origen: "manual" as const } : {}) };
    if (nueva.placa !== l.placa || nueva.fecha !== l.fecha || nueva.fecha_origen !== l.fecha_origen) cambio = true;
    return nueva;
  });
  return cambio ? out : null;
}

// ── 2) La decisión por línea ─────────────────────────────────────────────────

export type CargaExistente = {
  id: number | string;
  placa: string | null;
  fecha: string;
  total: number | null;
  cantidad: number | null;
  /** Texto donde puede estar la nota de despacho (observaciones, comprobante del Radar…). */
  referencia?: string | null;
  /** Ya enlazada a OTRA factura: no puede ser esta línea. */
  documento_compra_id?: number | null;
};

export type CodigoLinea =
  | "ya_registrada" | "en_radar_pendiente" | "registrar" | "revisar" | "en_espera" | "no_es_combustible";

export type MotivoRevisar =
  | "sin_placa" | "placa_ambigua" | "sin_fecha" | "sin_cantidad" | "no_cuadra" | "ambigua" | "nota_credito" | "auto_apagado" | "lectura_no_oficial" | "eliminada"
  | "historico";

/**
 * Cuánto mira atrás la lectura NORMAL del correo, y hasta dónde llega el registro AUTOMÁTICO.
 * Son el mismo número a propósito: lo que el ERP lee solo, lo registra solo; lo que se trae del
 * HISTORIAL («leer el último año») se compara igual, pero lo que falta queda en «revisar» con
 * motivo `historico` y lo registra una persona —de a una o todas juntas, viendo cuántas son y por
 * cuánto—. Un año de cargas metido de golpe son gastos de meses ya cerrados: si ese combustible
 * se había anotado por otro lado (un gasto, una caja chica), se contaría dos veces sin que nadie
 * lo viera.
 */
export const DIAS_REGISTRO_AUTOMATICO = 45;

export type PlanLinea = {
  n: number;
  codigo: CodigoLinea;
  motivo?: MotivoRevisar;
  detalle: string;
  /** La carga del ERP con la que casa (ya_registrada / en_radar_pendiente). */
  casa_con?: string | number;
  por?: "nota" | "documento" | "placa_fecha_monto" | "placa_fecha_cantidad";
  /** Payload sugerido para `combustible` (registrar/revisar con placa). */
  propuesta?: {
    placa: string;
    fecha: string;
    galones: number;
    precio_galon: number;
    tipo_combustible: string;
    unidad: string;
  } | null;
  /** De dónde salió la fecha con que se juzgó la línea (lo escribe la conciliación). */
  fecha_origen?: OrigenFecha | null;
  /** La fecha se corrió de la emisión al despacho: cuál era la emisión y cuántos días. */
  desfase?: { emision: string; dias: number } | null;
};

/**
 * Cómo queda marcada en `combustible.observaciones` una carga que registró la FACTURA. Lo escribe
 * `conciliarFacturaGuardada` y lo LEE el Radar para no duplicarla: la fecha de esa carga es la de la
 * factura, no la del voucher (que el Radar sí tiene), así que el Radar la busca con un día de margen.
 * Una sola frase para quien escribe y quien lee — si fueran dos, el día que una cambie el Radar
 * dejaría de reconocer las cargas de la factura y registraría la misma otra vez.
 */
export const MARCA_CARGA_DE_FACTURA = "Registrada desde la factura";

export function observacionCargaDeFactura(ref: string, nota: string | null, extra?: string | null): string {
  return `📧 ${MARCA_CARGA_DE_FACTURA} ${ref} (respaldo del Radar)${nota ? ` · Nota ${nota}` : ""}${extra ? ` · ${extra}` : ""} · sin odómetro`;
}

export const esCargaDeFactura = (observaciones?: string | null): boolean =>
  String(observaciones ?? "").includes(MARCA_CARGA_DE_FACTURA);

/**
 * Cómo queda marcada una carga de FACTURA que se FUSIONÓ con el voucher que leyó el Radar
 * (lib/radar/fusion-factura.ts): su fecha ya no es la de emisión sino la del despacho, impresa en el
 * voucher. La leen «Moverlas a la fecha del despacho» (cargasPorMover no la toca: su fecha ya es la
 * del papel) y la medición del desfase (que la cuenta como un voucher). Una sola frase para quien
 * escribe y quien lee, como MARCA_CARGA_DE_FACTURA.
 */
export const MARCA_FUSION_VOUCHER = "Fusionada con el voucher del Radar";

export const esCargaFusionada = (observaciones?: string | null): boolean =>
  String(observaciones ?? "").includes(MARCA_FUSION_VOUCHER);

export const TOLERANCIA_MONTO = 1;          // soles: mismo criterio que buscarDuplicado
export const TOLERANCIA_CANTIDAD = 0.05;    // galones
export const DIAS_VENTANA = 1;              // la nota de despacho puede salir con fecha del día siguiente

const difDias = (a: string, b: string) =>
  Math.round(Math.abs(new Date(a + "T12:00:00Z").getTime() - new Date(b + "T12:00:00Z").getTime()) / 86400000);

function casar(
  l: LineaFactura,
  filas: CargaExistente[],
  documentoId: number | null
): { fila: CargaExistente; por: PlanLinea["por"] } | "ambigua" | null {
  // Una carga enlazada a OTRA factura no puede ser esta línea. Enlazada a ESTA sí: es lo que
  // hace idempotente volver a procesar el mismo correo (si no, la carga que registró la
  // primera pasada no se reconocería y se registraría otra vez).
  const libres = filas.filter((f) => !f.documento_compra_id || (documentoId != null && Number(f.documento_compra_id) === documentoId));
  // (1) La nota de despacho es la identidad del despacho (misma regla que buscarDuplicado).
  const nota = normNota(l.nota_despacho);
  if (nota) {
    const porNota = libres.filter((f) => notasEnTexto(f.referencia ?? "").some((x) => normNota(x) === nota));
    if (porNota.length >= 1) return { fila: porNota[0], por: "nota" };
  }
  // (1b) Una carga YA ENLAZADA a esta misma factura, de la misma placa y el mismo importe, es esta
  // línea, tenga la fecha que tenga: la registró o la enlazó una pasada anterior —o una persona al
  // confirmarla con la fecha que eligió—. Sin esto, re-conciliar con otra fecha (la que trae ahora el
  // desfase) no la encontraría fuera de la ventana y la registraría OTRA VEZ. Con dos así, no decide.
  if (documentoId != null && l.placa && l.total != null) {
    const propias = libres.filter((f) => f.documento_compra_id != null && Number(f.documento_compra_id) === documentoId &&
      normPlaca(f.placa) === normPlaca(l.placa) && f.total != null && Math.abs(Number(f.total) - l.total!) < TOLERANCIA_MONTO);
    if (propias.length === 1) return { fila: propias[0], por: "documento" };
  }
  if (!l.placa || !l.fecha) return null;
  // Alrededor de la fecha de la línea Y de la alterna (la emisión, si la fecha se corrió al despacho):
  // la unión nunca encuentra MENOS que antes. Un candidato de más termina en «ambigua» → revisar;
  // uno de menos termina en «registrar» → la misma carga dos veces.
  const cerca = libres.filter((f) => normPlaca(f.placa) === l.placa && (
    difDias(f.fecha, l.fecha!) <= DIAS_VENTANA || (!!l.fecha_alterna && difDias(f.fecha, l.fecha_alterna) <= DIAS_VENTANA)
  ));
  // (2) Misma placa, fecha ±1 día, mismo importe.
  if (l.total != null) {
    const m = cerca.filter((f) => f.total != null && Math.abs(Number(f.total) - l.total!) < TOLERANCIA_MONTO);
    if (m.length > 1) return "ambigua";
    if (m.length === 1) return { fila: m[0], por: "placa_fecha_monto" };
  }
  // (3) Misma placa, fecha ±1 día, misma cantidad (el precio pudo redondearse distinto).
  if (l.cantidad != null) {
    const m = cerca.filter((f) => f.cantidad != null && Math.abs(Number(f.cantidad) - l.cantidad!) <= TOLERANCIA_CANTIDAD);
    if (m.length > 1) return "ambigua";
    if (m.length === 1) return { fila: m[0], por: "placa_fecha_cantidad" };
  }
  return null;
}

export function planDeLinea(args: {
  linea: LineaFactura;
  registradas: CargaExistente[];   // combustible
  radarPendientes: CargaExistente[]; // radar_combustible en revisión, sin carga
  tipoComprobante: string | null;
  /** documento_compra de esta factura, si ya existe (reproceso). */
  documentoId?: number | null;
  fuente: "xml_ubl" | "vision_pdf";
  hoy: string;                     // YYYY-MM-DD Lima
  graciaDias: number;              // días que se espera al Radar antes de registrar desde la factura
  autoRegistrar: boolean;
  /** Un despacho más viejo que esto no se registra solo (ver DIAS_REGISTRO_AUTOMATICO).
   *  null/undefined = sin límite: lo usa quien ya decidió (una persona que confirma). */
  diasAutoRegistro?: number | null;
}): PlanLinea {
  const l = args.linea;
  if (!l.tipo_combustible) {
    return { n: l.n, codigo: "no_es_combustible", detalle: `«${l.descripcion || "sin descripción"}» no es un combustible: no se concilia.` };
  }
  const yaReg = casar(l, args.registradas, args.documentoId ?? null);
  if (yaReg === "ambigua") {
    return { n: l.n, codigo: "revisar", motivo: "ambigua", detalle: "Dos cargas registradas de la misma unidad ese día podrían ser esta línea: elige cuál a mano." };
  }
  if (yaReg) {
    return {
      n: l.n, codigo: "ya_registrada", casa_con: yaReg.fila.id, por: yaReg.por,
      detalle: `Ya está registrada (carga #${yaReg.fila.id}, por ${yaReg.por === "nota" ? "nota de despacho" : yaReg.por === "documento" ? "estar ya enlazada a esta factura, misma placa e importe" : yaReg.por === "placa_fecha_monto" ? "placa + fecha + importe" : "placa + fecha + cantidad"}).`,
    };
  }
  const enRadar = casar(l, args.radarPendientes, args.documentoId ?? null);
  if (enRadar && enRadar !== "ambigua") {
    return {
      n: l.n, codigo: "en_radar_pendiente", casa_con: enRadar.fila.id, por: enRadar.por,
      detalle: "El Radar la capturó y está esperando revisión en Radar IA → Combustible. Apruébala ahí: registrarla también desde la factura la duplicaría.",
    };
  }

  // No está en ningún lado: ¿se puede registrar sin adivinar?
  if (/credito/i.test(args.tipoComprobante ?? "")) {
    return { n: l.n, codigo: "revisar", motivo: "nota_credito", detalle: "Es una nota de crédito: corrige una carga, no es una carga nueva." };
  }
  const prop = (placa: string, fecha: string) =>
    l.cantidad && l.cantidad > 0 && l.precio_unitario
      ? {
          placa, fecha,
          galones: l.cantidad,
          precio_galon: r2(l.precio_unitario),
          tipo_combustible: l.tipo_combustible!,
          unidad: unidadDeCarga(l.tipo_combustible, unidadDeCodigo(l.unidad_codigo)),
        }
      : null;

  if (!l.placa) {
    return { n: l.n, codigo: "revisar", motivo: "sin_placa", detalle: "La factura no dice a qué unidad se despachó (o nombra varias): elige la placa y regístrala.", propuesta: null };
  }
  if (!l.fecha) {
    return { n: l.n, codigo: "revisar", motivo: "sin_fecha", detalle: "La línea no trae la fecha del despacho y la factura agrupa varias cargas: poner la de emisión la movería de día.", propuesta: null };
  }
  if (!l.cantidad || !l.precio_unitario || l.total == null) {
    return { n: l.n, codigo: "revisar", motivo: "sin_cantidad", detalle: "Falta la cantidad o el precio de la línea.", propuesta: null };
  }
  // Se verifica a sí misma, como el voucher del Radar: cantidad × precio = total.
  if (Math.abs(l.cantidad * l.precio_unitario - l.total) >= TOLERANCIA_MONTO) {
    return {
      n: l.n, codigo: "revisar", motivo: "no_cuadra",
      detalle: `${l.cantidad} × ${l.precio_unitario} = ${r2(l.cantidad * l.precio_unitario)} y la línea dice ${l.total}: revisa antes de registrar.`,
      propuesta: prop(l.placa, l.fecha),
    };
  }
  if (difDias(args.hoy, l.fecha) < args.graciaDias && l.fecha <= args.hoy) {
    return {
      n: l.n, codigo: "en_espera",
      detalle: `Despacho del ${l.fecha}: se espera ${args.graciaDias} día(s) a que lo registre el Radar (que trae el kilometraje). Si no llega, se registra desde la factura.`,
      propuesta: prop(l.placa, l.fecha),
    };
  }
  if (args.fuente !== "xml_ubl") {
    return { n: l.n, codigo: "revisar", motivo: "lectura_no_oficial", detalle: "Solo llegó el PDF (leído por IA, no el XML de SUNAT): confírmala con un clic.", propuesta: prop(l.placa, l.fecha) };
  }
  if (args.diasAutoRegistro != null && l.fecha < args.hoy && difDias(args.hoy, l.fecha) > args.diasAutoRegistro) {
    return {
      n: l.n, codigo: "revisar", motivo: "historico",
      detalle: `Despacho del ${l.fecha}, de hace más de ${args.diasAutoRegistro} días, que no está en el ERP. No se registra solo: es un gasto de un mes pasado. Regístralo si de verdad falta (o todos los del historial juntos, arriba).`,
      propuesta: prop(l.placa, l.fecha),
    };
  }
  if (!args.autoRegistrar) {
    return { n: l.n, codigo: "revisar", motivo: "auto_apagado", detalle: "Falta registrarla. El registro automático está apagado: confírmala con un clic.", propuesta: prop(l.placa, l.fecha) };
  }
  return {
    n: l.n, codigo: "registrar",
    detalle: `No está en el ERP: se registra desde la factura (${l.placa}, ${l.fecha}, ${l.cantidad} × S/ ${l.precio_unitario}).`,
    propuesta: prop(l.placa, l.fecha),
  };
}

// ── 3) El adjunto que ES la factura ──────────────────────────────────────────

/**
 * El XML del COMPROBANTE entre los adjuntos. Junto a la factura suele venir la CDR de SUNAT
 * (`R-<ruc>-01-<serie>-<número>.xml`, una ApplicationResponse): es la constancia de que SUNAT la
 * recibió, no la factura, y no trae líneas. Se elige por el CONTENIDO —la raíz UBL—, no por el
 * orden en que vengan los adjuntos, que cada servicio de facturación pone a su manera.
 */
export function elegirXmlComprobante<T extends { nombre: string; texto: string }>(xmls: T[]): T | null {
  const cabeza = (x: T) => x.texto.slice(0, 6000);
  const esCdr = (x: T) => /ApplicationResponse/i.test(cabeza(x)) || /^R-/i.test(x.nombre);
  const esComprobante = (x: T) => /<(\w+:)?(Invoice|CreditNote|DebitNote)[\s>]/.test(cabeza(x));
  return xmls.find((x) => esComprobante(x) && !esCdr(x)) ?? xmls.find((x) => !esCdr(x)) ?? null;
}

/**
 * ¿El archivo tiene el nombre que SUNAT exige a un comprobante electrónico? `RUC-tipo-serie-número`
 * (`20127765279-01-F882-0132184.pdf`; tipo 01 factura, 03 boleta, 07/08 notas). La CDR lleva una
 * «R-» delante y NO lo es.
 *
 * DECIDE QUÉ PDF SE LEE CON IA. Al buzón de facturas también llegan PDFs que no son un comprobante
 * —la carta de Primax con la actualización de precios, un estado de cuenta—, y leídos como factura
 * la IA les inventa líneas. Peor que el costo: un estado de cuenta lista despachos que YA entraron
 * por su propio XML, y confirmar esas líneas los registraría dos veces. Lo que no tiene nombre de
 * comprobante no se lee: queda en la bandeja diciendo qué trae, con el enlace al correo.
 */
export function esNombreComprobante(nombre: string): boolean {
  return /(^|[\\/])\d{11}-(01|03|07|08)-[A-Z0-9]{4}-\d{1,8}\.(xml|pdf|zip)$/i.test(String(nombre ?? "").trim());
}

// ── 4) Lo que el historial dejó por registrar ────────────────────────────────

/**
 * Cómo se encuentran EN LA BASE las facturas con líneas del historial: el MISMO filtro para la
 * pantalla que las cuenta y para el botón que las registra. Si fueran dos, la pantalla podría
 * prometer N cargas y el botón registrar otras.
 *
 * `conciliacion` es jsonb y el filtro va como TEXTO JSON a propósito: supabase-js convierte un
 * array pasado tal cual en `cs.{[object Object]}`, que no encuentra nada —el botón diría «no
 * quedaba nada por registrar» con la lista llena—. Como texto viaja `cs.[{…}]`, que es la
 * contención de jsonb: «algún elemento del plan tiene estas claves».
 */
export const FILTRO_HISTORICO = {
  estados: ["parcial", "procesada"],
  conciliacion: JSON.stringify([{ codigo: "revisar", motivo: "historico" }]),
} as const;

export type ResumenHistorico = { lineas: number; facturas: number; total: number; desde: string | null; hasta: string | null };

/** Cuántas cargas del historial faltan en el ERP, por cuánto y de qué fechas: lo que una persona
 *  tiene que ver ANTES de registrarlas todas juntas. */
export function resumenHistorico(
  filas: { id: number | string; lineas?: LineaFactura[] | null; conciliacion?: PlanLinea[] | null }[],
): ResumenHistorico {
  let lineas = 0, total = 0, desde: string | null = null, hasta: string | null = null;
  const facturas = new Set<string>();
  for (const f of filas) {
    const ls = Array.isArray(f.lineas) ? f.lineas : [];
    for (const p of Array.isArray(f.conciliacion) ? f.conciliacion : []) {
      if (p.codigo !== "revisar" || p.motivo !== "historico") continue;
      const l = ls.find((x) => x.n === p.n);
      const fecha = l?.fecha ?? p.propuesta?.fecha ?? null;
      const monto = l?.total ?? (p.propuesta ? p.propuesta.galones * p.propuesta.precio_galon : 0);
      lineas++;
      total += Number(monto) || 0;
      facturas.add(String(f.id));
      if (fecha) {
        if (!desde || fecha < desde) desde = fecha;
        if (!hasta || fecha > hasta) hasta = fecha;
      }
    }
  }
  return { lineas, facturas: facturas.size, total: r2(total), desde, hasta };
}

// ── 5) La factura de una cuenta PREPAGO no es una deuda ──────────────────────

/** La razón que queda escrita en el comprobante: al crearlo, y al corregir uno que nació como
 *  deuda. Una sola frase para los dos caminos. */
export function notaPrepago(cuenta?: string | null): string {
  return `Pagada con el saldo prepago${cuenta ? ` de la cuenta ${cuenta}` : ""} (combustible): no es una deuda por pagar.`;
}

/**
 * ¿Este comprobante de una cuenta prepago figura como deuda SIN serlo? Solo si sigue «impaga», con
 * importe, sin anticipo anotado, sin ningún pago aplicado y fuera de todo lote de pago: con un
 * pago, un anticipo o un lote encima, una persona ya está decidiendo sobre él y no se toca.
 */
export function esDeudaFalsaPrepago(
  d: { id: number | string; estado_pago?: string | null; estado_aprobacion?: string | null; total?: number | null; adelanto_1?: number | null; adelanto_2?: number | null },
  conPago: ReadonlySet<number>,
  enLote: ReadonlySet<number>,
): boolean {
  return d.estado_pago === "impaga" && Number(d.total ?? 0) > 0
    && !Number(d.adelanto_1 ?? 0) && !Number(d.adelanto_2 ?? 0)
    && d.estado_aprobacion !== "incluido_lote"
    && !conPago.has(Number(d.id)) && !enLote.has(Number(d.id));
}

export const ETIQUETA_LINEA: Record<CodigoLinea, { texto: string; color: string }> = {
  ya_registrada:      { texto: "Ya registrada",          color: "#15803d" },
  en_radar_pendiente: { texto: "En revisión del Radar",  color: "#b45309" },
  registrar:          { texto: "Registrada por factura", color: "#1d4ed8" },
  revisar:            { texto: "Revisar",                color: "#b91c1c" },
  en_espera:          { texto: "Esperando al Radar",     color: "#6b7280" },
  no_es_combustible:  { texto: "No es combustible",      color: "#9ca3af" },
};
