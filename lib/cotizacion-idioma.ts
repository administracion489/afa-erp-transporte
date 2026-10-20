// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-idioma.ts — El PDF de la cotización en español o en inglés. Motor PURO.
//
// LA REGLA: se traduce lo que escribe EL SISTEMA; lo que escribió una PERSONA se imprime tal cual.
// El diccionario cubre los textos fijos de las cuatro plantillas (rótulos, encabezados, totales,
// fechas). Un nombre de ruta, una nota, una consideración tecleada no se traducen: el ERP no puede
// saber qué quiso decir quien la escribió, y una traducción automática en un papel que el cliente
// firma es una afirmación que nadie hizo.
//
// Dos excepciones, y las dos POR IGUALDAD EXACTA con lo que el propio sistema compuso:
//  · las consideraciones que son, lista por lista, las de fábrica (`DEFAULT_CONSID_ES`) salen en
//    su versión inglesa — no las escribió nadie, las sembró el ERP;
//  · la descripción de un ítem que es EXACTAMENTE la que compone `descripcionServicio` se
//    recompone en inglés. Si alguien le cambió una letra, ya es suya y va tal cual.
//
// Con "es" todo es byte a byte lo de antes: cada valor del diccionario español es el literal que
// los generadores tenían escrito.
// ──────────────────────────────────────────────────────────────────────────────

import { etiquetaNivel, nivelDeEquipamiento, equipamientoDeNivel, nivelDeFicha } from "./costos/nivel-servicio";
import { normalizarMoneda, type Moneda } from "./cotizacion-moneda";

export type Idioma = "es" | "en";
export const IDIOMAS: Idioma[] = ["es", "en"];

/** Desconocido o ausente (sin la migración) → español, que es lo que el PDF siempre fue. */
export function normalizarIdioma(v: unknown): Idioma {
  return String(v ?? "").trim().toLowerCase() === "en" ? "en" : "es";
}

export const LOCALE: Record<Idioma, string> = { es: "es-PE", en: "en-US" };

const ES = {
  // comunes
  cot_titulo_html: "Cotización N° {n}",
  valida_30: "Válida 30 días",
  no_incluye_igv: "No incluye IGV",
  igv_18: "IGV 18%",
  total: "TOTAL",
  fecha_a_coordinar: "Fecha a coordinar",
  vehiculos_n: " · {n} vehículos",
  tc_referencial: "Tipo de cambio referencial: S/ {tc} por US$",
  rotulo_ruc: "RUC",
  rotulo_dni: "DNI",
  // corporativo
  corp_titulo: "COTIZACIÓN N° {n} - {anio}",
  corp_sub: "Fecha: {fecha} · Válida 30 días",
  /** Cuando la validez NO es de 30 días (un traslado vence en la fecha del servicio si llega antes). */
  corp_sub_hasta: "Fecha: {fecha} · Válida hasta el {hasta}",
  corp_datos_cliente: "Datos del cliente",
  corp_cliente: "CLIENTE:",
  corp_direccion: "DIRECCIÓN:",
  corp_celular: "CELULAR:",
  corp_atencion: "ATENCIÓN:",
  corp_representante: "REPRESENTANTE:",
  corp_email: "EMAIL:",
  corp_telf: "TELF:",
  corp_detalle: "Detalle del servicio",
  corp_origen: "ORIGEN:",
  corp_destino: "DESTINO:",
  corp_retorno: "RETORNO:",
  corp_asunto: "ASUNTO:",
  corp_fecha_ida: "FECHA IDA:",
  corp_hora_ida: "HORA IDA:",
  corp_fecha_retorno: "FECHA RETORNO:",
  corp_hora_retorno: "HORA RETORNO:",
  corp_fecha: "FECHA:",
  corp_horario: "HORARIO:",
  corp_salida: "Salida:",
  corp_retorno_h: "Retorno:",
  corp_th_item: "ITEM",
  corp_th_desc: "DESCRIPCIÓN",
  corp_th_dias: "DÍAS",
  corp_th_cant: "CANT.",
  corp_th_punit: "P. UNIT {m} sin IGV",
  corp_th_dscto: "% DSCTO.",
  corp_th_total: "TOTAL {m}",
  corp_subtotal: "SUBTOTAL",
  corp_descuento: "DESCUENTO",
  corp_igv: "IGV (18%)",
  corp_total_neto: "TOTAL NETO",
  corp_unidad_cond: "Descripción de la unidad y condiciones",
  corp_caract: "Características de la unidad",
  corp_incluye: "✅ Servicio incluye",
  corp_no_incluye: "❌ No incluye",
  corp_generales: "📋 Consideraciones generales",
  cuentas_titulo: "Nuestras cuentas bancarias",
  cuentas_cta: "Cta:",
  cuentas_cci: "CCI:",
  // moderno
  mod_titulo: "PROPUESTA DE SERVICIO",
  mod_cliente: "Cliente",
  mod_servicio: "Servicio",
  mod_unidad: "Descripción de la unidad",
  mod_th_desc: "Descripción",
  mod_th_cant: "Cant.",
  mod_th_total: "Total",
  mod_subtotal: "Subtotal (sin IGV)",
  mod_incluye: "✅ Incluye",
  mod_no_incluye: "❌ No incluye",
  dias_x_cant: "{d}d × {c}",
  // turístico
  tur_titulo_html: "Cotización Turística N° {n}",
  tur_titulo: "COTIZACIÓN TURÍSTICA",
  tur_salida: "Salida: ",
  tur_paradas: "🗺️ Itinerario de paradas",
  tur_th_desc: "Descripción del servicio",
  tur_th_importe: "Importe",
  tur_dias_unid: "{d} día(s) × {c} unidad(es)",
  tur_subtotal: "Subtotal",
  tur_incluye: "✅ INCLUYE",
  tur_no_incluye: "❌ NO INCLUYE",
  // ejecutivo (en español ya era bilingüe: se conserva tal cual)
  eje_titulo_html: "Service Quotation N° {n}",
  eje_titulo: "SERVICE QUOTATION / COTIZACIÓN",
  eje_valida: "Valid 30 days",
  eje_cliente: "CLIENT / CLIENTE",
  eje_attn: "Attn: ",
  eje_repr: "Repr: ",
  eje_detalle: "SERVICE DETAILS / DETALLE DEL SERVICIO",
  eje_origen: "Origin / Origen",
  eje_destino: "Destination / Destino",
  eje_fecha: "Date / Fecha",
  eje_unidad: "UNIT / UNIDAD",
  eje_th_desc: "Description",
  eje_th_cant: "Qty",
  eje_th_monto: "Amount {cod}",
  eje_subtotal: "Subtotal (excl. tax)",
  eje_igv: "IGV/Tax 18%",
  eje_incluye: "Includes / Incluye",
  eje_no_incluye: "Not included / No incluye",
  // anexo y cronograma
  anexo_1: "ANEXO 1",
  anexo_programa: "PROGRAMA DETALLADO",
  cron_titulo: "📅 Cronograma del servicio — {n} días",
  cron_dia: "Día",
  cron_dia_mayus: "DÍA {n}",
  cron_fecha: "Fecha",
  cron_ruta: "Ruta del día",
  cron_salida: "H. Salida",
  cron_fin: "Fin del día",
  cron_retorno_final: "✅ Retorno final",
  cron_por_confirmar: "Por confirmar",
  cron_cochera: "🏠 Retorno cochera",
  cron_pernocte: "🏨 Pernocte",
} as const;

export type ClaveTexto = keyof typeof ES;

const EN: Record<ClaveTexto, string> = {
  cot_titulo_html: "Quotation No. {n}",
  valida_30: "Valid for 30 days",
  no_incluye_igv: "IGV (Peruvian VAT) not included",
  igv_18: "IGV (Peruvian VAT) 18%",
  total: "TOTAL",
  fecha_a_coordinar: "Date to be confirmed",
  vehiculos_n: " · {n} vehicles",
  tc_referencial: "Reference exchange rate: S/ {tc} per US$",
  rotulo_ruc: "RUC (Tax ID)",
  rotulo_dni: "ID",
  corp_titulo: "QUOTATION No. {n} - {anio}",
  corp_sub: "Date: {fecha} · Valid for 30 days",
  corp_sub_hasta: "Date: {fecha} · Valid until {hasta}",
  corp_datos_cliente: "Client details",
  corp_cliente: "CLIENT:",
  corp_direccion: "ADDRESS:",
  corp_celular: "MOBILE:",
  corp_atencion: "ATTN:",
  corp_representante: "REPRESENTATIVE:",
  corp_email: "EMAIL:",
  corp_telf: "PHONE:",
  corp_detalle: "Service details",
  corp_origen: "ORIGIN:",
  corp_destino: "DESTINATION:",
  corp_retorno: "RETURN:",
  corp_asunto: "SUBJECT:",
  corp_fecha_ida: "DEPARTURE DATE:",
  corp_hora_ida: "DEPARTURE TIME:",
  corp_fecha_retorno: "RETURN DATE:",
  corp_hora_retorno: "RETURN TIME:",
  corp_fecha: "DATE:",
  corp_horario: "SCHEDULE:",
  corp_salida: "Departure:",
  corp_retorno_h: "Return:",
  corp_th_item: "ITEM",
  corp_th_desc: "DESCRIPTION",
  corp_th_dias: "DAYS",
  corp_th_cant: "QTY",
  corp_th_punit: "UNIT PRICE {m} excl. IGV",
  corp_th_dscto: "% DISC.",
  corp_th_total: "TOTAL {m}",
  corp_subtotal: "SUBTOTAL",
  corp_descuento: "DISCOUNT",
  corp_igv: "IGV (Peruvian VAT) 18%",
  corp_total_neto: "NET TOTAL",
  corp_unidad_cond: "Vehicle description and terms",
  corp_caract: "Vehicle features",
  corp_incluye: "✅ Service includes",
  corp_no_incluye: "❌ Not included",
  corp_generales: "📋 General terms",
  cuentas_titulo: "Our bank accounts",
  cuentas_cta: "Acct:",
  cuentas_cci: "CCI (interbank):",
  mod_titulo: "SERVICE PROPOSAL",
  mod_cliente: "Client",
  mod_servicio: "Service",
  mod_unidad: "Vehicle description",
  mod_th_desc: "Description",
  mod_th_cant: "Qty",
  mod_th_total: "Total",
  mod_subtotal: "Subtotal (excl. IGV)",
  mod_incluye: "✅ Includes",
  mod_no_incluye: "❌ Not included",
  dias_x_cant: "{d}d × {c}",
  tur_titulo_html: "Tour Quotation No. {n}",
  tur_titulo: "TOUR QUOTATION",
  tur_salida: "Departure: ",
  tur_paradas: "🗺️ Stops itinerary",
  tur_th_desc: "Service description",
  tur_th_importe: "Amount",
  tur_dias_unid: "{d} day(s) × {c} unit(s)",
  tur_subtotal: "Subtotal",
  tur_incluye: "✅ INCLUDES",
  tur_no_incluye: "❌ NOT INCLUDED",
  eje_titulo_html: "Service Quotation No. {n}",
  eje_titulo: "SERVICE QUOTATION",
  eje_valida: "Valid for 30 days",
  eje_cliente: "CLIENT",
  eje_attn: "Attn: ",
  eje_repr: "Rep.: ",
  eje_detalle: "SERVICE DETAILS",
  eje_origen: "Origin",
  eje_destino: "Destination",
  eje_fecha: "Date",
  eje_unidad: "VEHICLE",
  eje_th_desc: "Description",
  eje_th_cant: "Qty",
  eje_th_monto: "Amount {cod}",
  eje_subtotal: "Subtotal (excl. tax)",
  eje_igv: "IGV (Peruvian VAT) 18%",
  eje_incluye: "Includes",
  eje_no_incluye: "Not included",
  anexo_1: "APPENDIX 1",
  anexo_programa: "DETAILED PROGRAM",
  cron_titulo: "📅 Service schedule — {n} days",
  cron_dia: "Day",
  cron_dia_mayus: "DAY {n}",
  cron_fecha: "Date",
  cron_ruta: "Route of the day",
  cron_salida: "Departure",
  cron_fin: "End of day",
  cron_retorno_final: "✅ Final return",
  cron_por_confirmar: "To be confirmed",
  cron_cochera: "🏠 Return to depot",
  cron_pernocte: "🏨 Overnight stay",
};

export const TEXTOS_PDF: Record<Idioma, Record<ClaveTexto, string>> = { es: ES, en: EN };

/** Un texto fijo del PDF en su idioma, con `{x}` reemplazado por `vars.x`. */
export function t(idioma: Idioma, clave: ClaveTexto, vars?: Record<string, string | number>): string {
  let s = TEXTOS_PDF[normalizarIdioma(idioma)][clave];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type EstiloFecha =
  /** `16 DE OCTUBRE DE 2026` / `OCTOBER 16, 2026` */
  | "larga_mayus"
  /** `16/10/2026` / `10/16/2026` */
  | "corta"
  /** `VIE., 16 OCT. 2026` / `FRI, OCT 16, 2026` */
  | "cronograma"
  /** Formato por defecto del navegador para ese idioma (la fecha de emisión del documento). */
  | "simple";

/**
 * Una fecha del documento. Una fecha SIN hora (`2026-10-16`) se ancla a medianoche LOCAL —como
 * siempre hicieron los generadores— para que no retroceda un día al pasar a UTC.
 */
export function fmtFechaDoc(valor: string | Date, idioma: Idioma, estilo: EstiloFecha): string {
  const d = valor instanceof Date ? valor : new Date(/^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor + "T00:00:00" : valor);
  const loc = LOCALE[normalizarIdioma(idioma)];
  switch (estilo) {
    case "larga_mayus": return d.toLocaleDateString(loc, { day: "numeric", month: "long", year: "numeric" }).toUpperCase();
    case "corta": return d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" });
    case "cronograma": return d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase();
    default: return d.toLocaleDateString(loc);
  }
}

/**
 * Un importe con su símbolo. PEN reproduce EXACTO lo que imprimían los generadores
 * (`toLocaleString("es-PE",{minimumFractionDigits:2})`, sin tope de decimales). USD siempre a dos
 * decimales: sus importes ya vienen redondeados a céntimos.
 */
export function fmtImporte(n: number, m: Moneda, idioma: Idioma = "es"): string {
  const loc = LOCALE[normalizarIdioma(idioma)];
  n = Number(n);
  if (normalizarMoneda(m) === "PEN") return `S/ ${n.toLocaleString(loc, { minimumFractionDigits: 2 })}`;
  return `US$ ${n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** El tipo de cambio para imprimir: 2 a 4 decimales. */
export function fmtTipoCambio(tc: number, idioma: Idioma): string {
  return tc.toLocaleString(LOCALE[normalizarIdioma(idioma)], { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** El rótulo del nivel en documentos (`etiquetaNivel` en español). */
export function etiquetaNivelIdioma(equip: string | null | undefined, idioma: Idioma): string {
  if (normalizarIdioma(idioma) === "es") return etiquetaNivel(equip);
  return nivelDeEquipamiento(equip) === "full_equipo" ? "FULL EQUIPMENT" : "STANDARD";
}

export type ConsidCot = { incluye: string[]; no_incluye: string[]; generales: string[] };

/** Las consideraciones de fábrica. Mudadas de app/cotizaciones/page.tsx (`DEFAULT_CONSID`). */
export const DEFAULT_CONSID_ES: ConsidCot = {
  incluye: ["Traslado de origen a destino", "Conductor profesional certificado", "Combustible durante todo el recorrido", "GPS en tiempo real", "Seguro de viaje SOAT vigente"],
  no_incluye: ["Alimentación y bebidas", "Guía turístico", "Entradas a atractivos turísticos"],
  generales: ["Precios según fechas y horarios coordinados.", "Tolerancia máxima de espera: 30 minutos.", "No se permite consumo de alcohol ni tabaco a bordo.", "Cambios en ruta u horario pueden generar costos adicionales.", "Servicio eventual: adelanto del 50% para confirmar.", "Recomendamos reservar con 7 días de anticipación mínimo."],
};

/** La misma lista, en inglés y en el mismo orden (se traduce por posición, lista por lista). */
export const DEFAULT_CONSID_EN: ConsidCot = {
  incluye: ["Transfer from origin to destination", "Certified professional driver", "Fuel for the entire route", "Real-time GPS tracking", "Valid SOAT travel insurance"],
  no_incluye: ["Food and beverages", "Tour guide", "Admission to tourist attractions"],
  generales: ["Prices based on the agreed dates and times.", "Maximum waiting time: 30 minutes.", "Alcohol and smoking are not allowed on board.", "Changes to the route or schedule may incur additional costs.", "One-off service: 50% deposit required to confirm.", "We recommend booking at least 7 days in advance."],
};

const mismaLista = (a: readonly string[] | null | undefined, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

type CfgConsid = { condiciones_incluye?: string[] | null; condiciones_no_incluye?: string[] | null; condiciones_generales?: string[] | null } | null | undefined;

export type ConsidPdf = ConsidCot & {
  /** Listas que se imprimen tal cual las escribió una persona (en inglés, quedan en su idioma). */
  escritasTalCual: (keyof ConsidCot)[];
};

/**
 * Las consideraciones que imprime el PDF.
 *
 * ES: EXACTAMENTE la regla de siempre — `cfg?.condiciones_x || consid.x` (una lista vacía en la
 * plantilla también gana, porque `[]` es verdadero).
 *
 * EN: las de la plantilla NO se imprimen (son texto libre en español y la plantilla no tiene
 * versión inglesa); se usan las de la cotización, y la lista que es idéntica a la de fábrica se
 * cambia por su versión inglesa.
 */
export function considParaPdf(cfg: CfgConsid, consid: ConsidCot, idioma: Idioma): ConsidPdf {
  if (normalizarIdioma(idioma) === "es") {
    return {
      incluye: cfg?.condiciones_incluye || consid.incluye,
      no_incluye: cfg?.condiciones_no_incluye || consid.no_incluye,
      generales: cfg?.condiciones_generales || consid.generales,
      escritasTalCual: [],
    };
  }
  const out: ConsidPdf = { incluye: [], no_incluye: [], generales: [], escritasTalCual: [] };
  for (const k of ["incluye", "no_incluye", "generales"] as const) {
    const lista = consid?.[k] ?? [];
    if (mismaLista(lista, DEFAULT_CONSID_ES[k])) out[k] = [...DEFAULT_CONSID_EN[k]];
    else { out[k] = lista; if (lista.some(x => String(x ?? "").trim())) out.escritasTalCual.push(k); }
  }
  return out;
}

export type CtxDescripcion = {
  modo_servicio: string | null | undefined;
  /** La clave de la ficha de costeo (`tipo_vehiculo`). */
  tipo_vehiculo: string | null | undefined;
  /** El nombre de esa ficha (`parametros_costos.nombre`). */
  tipoNombre: string | null | undefined;
};

/**
 * La descripción automática del primer ítem. Extraída del efecto «Auto-construir descripción» de
 * app/cotizaciones/page.tsx; en español produce EXACTAMENTE lo mismo. El nombre de la ficha es
 * dato y va tal cual en los dos idiomas.
 */
export function descripcionServicio(ctx: CtxDescripcion, idioma: Idioma): string {
  const en = normalizarIdioma(idioma) === "en";
  const servLbl = ctx.modo_servicio === "fijo"
    ? (en ? "PERSONNEL TRANSPORTATION SERVICE" : "SERVICIO DE TRANSPORTE DE PERSONAL")
    : (en ? "TOURIST TRANSPORTATION SERVICE" : "SERVICIO DE TRANSPORTE TURÍSTICO");
  const tipoNom = ctx.tipoNombre || "";
  // El nivel lo declara la FICHA (sufijo _ESTANDAR), no el equipamiento de la placa.
  const equipLbl = etiquetaNivelIdioma(equipamientoDeNivel(nivelDeFicha(ctx.tipo_vehiculo)), idioma);
  const yaLoDice = /full\s*equipo|est[aá]ndar/i.test(tipoNom);
  return tipoNom ? `${servLbl} - ${tipoNom}${equipLbl && !yaLoDice ? " " + equipLbl : ""}` : servLbl;
}

/**
 * La descripción de un ítem en el PDF. Solo se recompone en inglés si es IDÉNTICA a la que el
 * sistema compuso en español con ese mismo contexto; cualquier otra va tal cual.
 */
export function descripcionParaPdf(descripcion: string, ctx: CtxDescripcion | null | undefined, idioma: Idioma): { texto: string; recompuesta: boolean } {
  if (normalizarIdioma(idioma) === "es" || !ctx) return { texto: descripcion, recompuesta: false };
  if (descripcion === descripcionServicio(ctx, "es")) return { texto: descripcionServicio(ctx, "en"), recompuesta: true };
  return { texto: descripcion, recompuesta: false };
}
