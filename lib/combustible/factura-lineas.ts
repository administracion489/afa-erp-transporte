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

/** Fechas dd/mm/yyyy o yyyy-mm-dd dentro de un texto. */
export function fechasEnTexto(texto: string): string[] {
  const out = new Set<string>();
  const t = String(texto ?? "");
  for (const m of t.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g)) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.add(`${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
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
  return lineas.map((l) => ({
    ...l,
    placa: l.placa ?? (placasDoc.length === 1 ? placasDoc[0] : null),
    nota_despacho: l.nota_despacho ?? (unaSola && notasDoc.length === 1 ? notasDoc[0] : null),
    fecha: l.fecha ?? (unaSola ? fechaEmision : null),
  }));
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
  | "sin_placa" | "placa_ambigua" | "sin_fecha" | "sin_cantidad" | "no_cuadra" | "ambigua" | "nota_credito" | "auto_apagado" | "lectura_no_oficial" | "eliminada";

export type PlanLinea = {
  n: number;
  codigo: CodigoLinea;
  motivo?: MotivoRevisar;
  detalle: string;
  /** La carga del ERP con la que casa (ya_registrada / en_radar_pendiente). */
  casa_con?: string | number;
  por?: "nota" | "placa_fecha_monto" | "placa_fecha_cantidad";
  /** Payload sugerido para `combustible` (registrar/revisar con placa). */
  propuesta?: {
    placa: string;
    fecha: string;
    galones: number;
    precio_galon: number;
    tipo_combustible: string;
    unidad: string;
  } | null;
};

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
  if (!l.placa || !l.fecha) return null;
  const cerca = libres.filter((f) => normPlaca(f.placa) === l.placa && difDias(f.fecha, l.fecha!) <= DIAS_VENTANA);
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
      detalle: `Ya está registrada (carga #${yaReg.fila.id}, por ${yaReg.por === "nota" ? "nota de despacho" : yaReg.por === "placa_fecha_monto" ? "placa + fecha + importe" : "placa + fecha + cantidad"}).`,
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
  if (!args.autoRegistrar) {
    return { n: l.n, codigo: "revisar", motivo: "auto_apagado", detalle: "Falta registrarla. El registro automático está apagado: confírmala con un clic.", propuesta: prop(l.placa, l.fecha) };
  }
  return {
    n: l.n, codigo: "registrar",
    detalle: `No está en el ERP: se registra desde la factura (${l.placa}, ${l.fecha}, ${l.cantidad} × S/ ${l.precio_unitario}).`,
    propuesta: prop(l.placa, l.fecha),
  };
}

export const ETIQUETA_LINEA: Record<CodigoLinea, { texto: string; color: string }> = {
  ya_registrada:      { texto: "Ya registrada",          color: "#15803d" },
  en_radar_pendiente: { texto: "En revisión del Radar",  color: "#b45309" },
  registrar:          { texto: "Registrada por factura", color: "#1d4ed8" },
  revisar:            { texto: "Revisar",                color: "#b91c1c" },
  en_espera:          { texto: "Esperando al Radar",     color: "#6b7280" },
  no_es_combustible:  { texto: "No es combustible",      color: "#9ca3af" },
};
