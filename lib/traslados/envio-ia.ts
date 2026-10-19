// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/envio-ia.ts — La IA del CRM cotiza un traslado: qué datos acepta del modelo, qué
// le devuelve, y si la cotización se ENVÍA sola o queda para que la revise un ejecutivo.
// Motor PURO: no lee la base, no llama a Google ni a Meta. Lo usan el agente (lib/crm-ia.ts), el
// orquestador del servidor y la pantalla de Ajustes de /tarifario.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. EL MODELO NO DECIDE NADA DE DINERO. El esquema de la herramienta no tiene teléfono, moneda,
//     precio ni destinatario: la moneda sale del número de WhatsApp del REMITENTE (lo pone el
//     webhook, no el modelo), el precio sale del tarifario, y el PDF va a quien escribió.
//     `actualizar_contacto` deja al modelo escribir el teléfono del contacto: por eso aquí no se
//     lee `contacto.telefono` jamás, solo el `wa_id` de la conversación.
//  2. LAS COORDENADAS NO SE INVENTAN. Un pin dentro de la geocerca del aeropuerto cambia la zona y
//     con ella el precio y el envío automático. Solo valen si aparecen TAL CUAL en el enlace
//     maps.google.com/?q=lat,lng que deja el webhook en un mensaje ENTRANTE (lib/crm-ingesta.ts).
//  3. NADA SALE SOLO SI NO LO DICE TODO A LA VEZ (`planEnvio`): resultado cotizable, el maestro
//     encendido, alguna de las dos zonas marcada, WhatsApp con remitente, agente autónomo, perfil
//     de la empresa configurado, importes que cuadran, PDF armado y sin palabras de pedido
//     complejo. Cualquier otro caso queda en REVISIÓN con sus motivos declarados.
//  4. AL MODELO SE LE DEVUELVE UNA LISTA BLANCA (`respuestaParaModelo`): ni la explicación del
//     motor (trae alias, el precio del distrito, la fuente del tipo de cambio), ni ids, ni el
//     nivel de la tarifa. En revisión, ningún importe: si el modelo no lo tiene, no lo puede
//     escribir. Y si aun así escribe uno que no es de la cotización, `textoContradicePrecio` lo
//     detecta y el mensaje lo reemplaza el código.
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, LugarEntrada } from "./api";
import {
  SENALES, claveNombre, monedaPorTelefono,
  type PrecioTraslado, type ResultadoTraslado, type Zona,
} from "./motor";
import { totalesEnMoneda, normalizarMoneda } from "../cotizacion-moneda";
import { fmtFechaDoc, fmtImporte } from "../cotizacion-idioma";
import { LINEA_DISPONIBILIDAD } from "./cotizacion-traslado";

// ── 1. La herramienta ────────────────────────────────────────────────────────

const CLAVES_SENALES = Object.keys(SENALES);

export const HERRAMIENTA_COTIZAR_TRASLADO = {
  name: "cotizar_traslado" as const,
  description:
    "Cotiza un TRASLADO SIMPLE: un punto de recojo → un destino, solo ida o ida y retorno, en una sola fecha y con un solo vehículo " +
    "(p. ej. aeropuerto ↔ hotel o domicilio). El PRECIO, el vehículo, la moneda y la validez los pone el sistema con el tarifario: " +
    "tú NO calculas ni escribes precios por tu cuenta; repite solo los que te devuelva esta herramienta. " +
    "Llámala en cuanto el cliente pida precio de un traslado, aunque falten datos: la respuesta te dice qué preguntar. " +
    "No la uses para licitaciones, TDR, eventos, tours, varias fechas o varios vehículos: marca esas señales y el sistema lo pasa a un ejecutivo. " +
    "Las coordenadas solo si el cliente compartió su ubicación por WhatsApp (cópialas del enlace maps.google.com/?q=lat,lng del chat).",
  input_schema: {
    type: "object",
    properties: {
      origen_texto: { type: "string", description: "Punto de recojo tal como lo dijo el cliente (dirección, hotel, «Aeropuerto Jorge Chávez»)." },
      origen_lat: { type: "number", description: "Latitud del recojo, SOLO si viene de una ubicación compartida en este chat." },
      origen_lng: { type: "number", description: "Longitud del recojo, SOLO si viene de una ubicación compartida en este chat." },
      destino_texto: { type: "string", description: "Destino tal como lo dijo el cliente." },
      destino_lat: { type: "number", description: "Latitud del destino, SOLO si viene de una ubicación compartida en este chat." },
      destino_lng: { type: "number", description: "Longitud del destino, SOLO si viene de una ubicación compartida en este chat." },
      fecha_servicio: { type: "string", description: "Fecha de la ida, YYYY-MM-DD." },
      hora_servicio: { type: "string", description: "Hora de recojo de la ida, HH:MM (24 h)." },
      sentido: { type: "string", enum: ["ida", "ida_retorno"], description: "Solo ida, o ida y retorno." },
      fecha_retorno: { type: "string", description: "Fecha del retorno, YYYY-MM-DD (solo con ida y retorno)." },
      hora_retorno: { type: "string", description: "Hora de recojo del retorno, HH:MM (solo con ida y retorno)." },
      pax: { type: "integer", description: "Número de pasajeros." },
      maletas: { type: "integer", description: "Maletas grandes (de 23 kg). 0 si no llevan. No lo supongas: pregúntalo." },
      paradas_intermedias: { type: "integer", description: "Paradas en el camino que pidió el cliente (0 si ninguna)." },
      fechas_adicionales: { type: "integer", description: "Otras fechas además de la del servicio (0 si es una sola)." },
      vehiculos_pedidos: { type: "integer", description: "Vehículos que pide a la vez (1 si es uno)." },
      senales: {
        type: "array",
        items: { type: "string", enum: CLAVES_SENALES },
        description: "Condiciones que hacen que el pedido NO sea simple y lo vea un ejecutivo.",
      },
    },
  },
};

// ── 2. Lo que va al validador ────────────────────────────────────────────────

const coordenada = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

/** El enlace que escribe el webhook al recibir una ubicación (lib/crm-ingesta.ts). */
const ENLACE_MAPA = /https?:\/\/maps\.google\.com\/\?q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;

/** Tolerancia de la comparación: el modelo puede recortar decimales; 1e-6° son ~10 cm. */
const TOL_COORD = 1e-6;

/**
 * Las coordenadas que propone el modelo, SOLO si aparecen tal cual en un enlace de mapa de un
 * mensaje ENTRANTE. Se devuelven las del enlace (no las del modelo). Si no, null: se usa el texto.
 */
export function coordenadasVerificadas(lat: unknown, lng: unknown, textosEntrantes: string[]): { lat: number; lng: number } | null {
  const la = coordenada(lat), ln = coordenada(lng);
  if (la == null || ln == null) return null;
  for (const t of textosEntrantes ?? []) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(ENLACE_MAPA)) {
      const a = Number(m[1]), b = Number(m[2]);
      if (Math.abs(a - la) <= TOL_COORD && Math.abs(b - ln) <= TOL_COORD) return { lat: a, lng: b };
    }
  }
  return null;
}

const comoTexto = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * La entrada que se le pasa a `validarEntrada` (lib/traslados/api.ts), armada con lista blanca. El teléfono es el `wa_id`
 * del remitente de WhatsApp (en otro canal, null: sin moneda no se cotiza), JAMÁS algo del input.
 */
export function entradaDelAgente(
  input: unknown,
  remitente: { canal: string; waId: string | null },
  textosEntrantes: string[],
): unknown {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const lugar = (texto: unknown, lat: unknown, lng: unknown): LugarEntrada => {
    const t = comoTexto(texto).trim();
    const c = coordenadasVerificadas(lat, lng, textosEntrantes);
    return c ? { lat: c.lat, lng: c.lng, texto: t || undefined } : t;
  };
  const wa = remitente?.canal === "whatsapp" && typeof remitente.waId === "string" && remitente.waId.trim() ? remitente.waId.trim() : null;
  return {
    origen: lugar(o.origen_texto, o.origen_lat, o.origen_lng),
    destino: lugar(o.destino_texto, o.destino_lat, o.destino_lng),
    fecha_servicio: o.fecha_servicio, hora_servicio: o.hora_servicio,
    sentido: o.sentido, fecha_retorno: o.fecha_retorno, hora_retorno: o.hora_retorno,
    pax: o.pax, maletas: o.maletas,
    paradas_intermedias: o.paradas_intermedias, fechas_adicionales: o.fechas_adicionales,
    vehiculos_pedidos: o.vehiculos_pedidos, senales: o.senales,
    telefono: wa,
  };
}

// ── 3. La firma del pedido (idempotencia) ────────────────────────────────────

const firmaLugar = (l: LugarEntrada): string =>
  typeof l === "string"
    ? claveNombre(l)
    : `@${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;

/**
 * La cadena canónica de un pedido YA VALIDADO: dos llamadas con los mismos datos (aunque el modelo
 * cambie mayúsculas, tildes o el orden de los campos) dan la misma firma. La moneda entra porque
 * el mismo pedido desde otro número es otra cotización. Con «solo ida», el retorno no cuenta.
 */
export function firmaPedido(e: EntradaSimulador): string {
  const conRetorno = e.sentido === "ida_retorno";
  return [
    "v1",
    firmaLugar(e.origen), firmaLugar(e.destino),
    e.fecha_servicio ?? "", e.hora_servicio ?? "",
    e.sentido ?? "",
    conRetorno ? e.fecha_retorno ?? "" : "", conRetorno ? e.hora_retorno ?? "" : "",
    e.pax ?? "", e.maletas ?? "",
    monedaPorTelefono(e.telefono).moneda ?? "",
  ].join("|");
}

// ── 4. ¿La zona tiene envío automático? ──────────────────────────────────────

export type ZonaEnvio = Zona & { envio_automatico?: boolean | null };

/**
 * La zona (o, si es subzona, su distrito activo) tiene marcado el envío automático. Es la misma
 * escalera que `tarifaDelPar`: una subzona hereda de su distrito. Solo `true` cuenta: sin la
 * migración la columna llega `undefined` y eso es «no».
 */
export function zonaConEnvio(z: Zona | null | undefined, zonas: readonly ZonaEnvio[]): boolean {
  if (!z) return false;
  const actual = zonas.find((x) => x.id === z.id) ?? (z as ZonaEnvio);
  if (actual.activo === false) return false;
  if (actual.envio_automatico === true) return true;
  if (actual.tipo === "subzona" && actual.padre_id != null) {
    const padre = zonas.find((x) => x.id === actual.padre_id);
    return !!padre && padre.activo !== false && padre.tipo === "distrito" && padre.envio_automatico === true;
  }
  return false;
}

// ── 5. ¿Se envía sola o la revisa un ejecutivo? ──────────────────────────────

export type CodigoRevision =
  | "maestro_apagado" | "zona_sin_envio" | "modo_copiloto" | "sin_remitente"
  | "perfil_sin_configurar" | "importes_no_cuadran" | "pdf_no_generado" | "palabras_de_pedido_complejo";

export const MOTIVO_REVISION: Record<CodigoRevision, { texto: string; arreglo: string }> = {
  maestro_apagado: {
    texto: "El envío automático de cotizaciones está apagado.",
    arreglo: "Se enciende en /tarifario → Zonas y traslados → Ajustes.",
  },
  zona_sin_envio: {
    texto: "Ni el recojo ni el destino están en una zona con envío automático.",
    arreglo: "Se marca «Envío automático de la cotización» en la zona, en /tarifario → Zonas y traslados → Zonas.",
  },
  modo_copiloto: {
    texto: "El agente IA no está en modo autónomo para WhatsApp (o está fuera de su horario).",
    arreglo: "Se cambia en /crm/agente (canales autónomos y horario).",
  },
  sin_remitente: {
    texto: "La conversación no es de WhatsApp o no tiene el número del cliente.",
    arreglo: "La envía un ejecutivo desde el CRM.",
  },
  perfil_sin_configurar: {
    texto: "El perfil de la empresa no tiene nombre: el PDF saldría con «CONFIGURA EL PERFIL DE TU EMPRESA».",
    arreglo: "Se llena en /configuracion/perfil.",
  },
  importes_no_cuadran: {
    texto: "Los importes guardados no reproducen los del tarifario (un IGV distinto del 18 % o un redondeo).",
    arreglo: "Revisa el IGV en /tesoreria → Detracciones y la cotización en /cotizaciones antes de enviarla.",
  },
  pdf_no_generado: {
    texto: "No se pudo armar el PDF de la cotización.",
    arreglo: "Pulsa «Ver PDF» en la tarjeta del CRM; si sigue fallando, revisa el logo en /configuracion/perfil.",
  },
  palabras_de_pedido_complejo: {
    texto: "El cliente escribió palabras de un pedido complejo (TDR, licitación, evento, descuento…).",
    arreglo: "Un ejecutivo confirma que de verdad es un traslado simple antes de enviarla.",
  },
};

export type DecisionEnvio = "automatico" | "revision";

/**
 * Se envía sola SOLO si se cumple todo; si no, revisión con TODOS los motivos que aplican (no solo
 * el primero: el ejecutivo ve de una vez qué falta). Con un resultado que no es cotizable devuelve
 * revisión SIN motivos y no lanza: no hay cotización que enviar, y una excepción en el turno del
 * agente dejaría al cliente sin respuesta. El llamador no debería llegar aquí con eso.
 */
export function planEnvio(x: {
  resultado: ResultadoTraslado;
  envioMaestro: boolean;
  zonas: readonly ZonaEnvio[];
  canal: string;
  waId: string | null;
  modoAuto: boolean;
  perfilConfigurado: boolean;
  cuadra: boolean;
  pdfOk: boolean;
  palabras: string[];
}): { decision: DecisionEnvio; motivos: CodigoRevision[] } {
  const r = x.resultado;
  if (!r || r.codigo !== "cotizable" || !r.precio) return { decision: "revision", motivos: [] };
  const motivos: CodigoRevision[] = [];
  if (x.envioMaestro !== true) motivos.push("maestro_apagado");
  if (!zonaConEnvio(r.origen?.zona ?? null, x.zonas) && !zonaConEnvio(r.destino?.zona ?? null, x.zonas)) motivos.push("zona_sin_envio");
  if (x.modoAuto !== true) motivos.push("modo_copiloto");
  if (x.canal !== "whatsapp" || !(typeof x.waId === "string" && x.waId.trim())) motivos.push("sin_remitente");
  if (x.perfilConfigurado !== true) motivos.push("perfil_sin_configurar");
  if (x.cuadra !== true) motivos.push("importes_no_cuadran");
  if (x.pdfOk !== true) motivos.push("pdf_no_generado");
  if ((x.palabras ?? []).length > 0) motivos.push("palabras_de_pedido_complejo");
  return { decision: motivos.length === 0 ? "automatico" : "revision", motivos };
}

// ── 6. Palabras de un pedido complejo ────────────────────────────────────────

/** Texto comparable por PALABRA: sin tildes, minúsculas, todo lo que no es letra o número es espacio. */
const textoComparable = (s: string): string =>
  ` ${String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Lo que escribe el cliente y huele a pedido complejo. Por frase COMPLETA, nunca «contiene»:
 * «eventual» no es «evento», y «tours» a secas no se busca porque es parte del nombre de muchas
 * empresas de transporte. Solo baja de automático a revisión; no deriva nada.
 */
const PALABRAS_COMPLEJAS: { etiqueta: string; frases: string[] }[] = [
  { etiqueta: "TDR", frases: ["tdr", "tdrs"] },
  { etiqueta: "términos de referencia", frases: ["terminos de referencia", "termino de referencia"] },
  { etiqueta: "licitación", frases: ["licitacion", "licitaciones"] },
  { etiqueta: "bases", frases: ["bases"] },
  { etiqueta: "concurso", frases: ["concurso", "concursos"] },
  { etiqueta: "convocatoria", frases: ["convocatoria"] },
  { etiqueta: "evento", frases: ["evento", "eventos"] },
  { etiqueta: "full day", frases: ["full day", "fullday", "full days"] },
  { etiqueta: "city tour", frases: ["city tour", "citytour", "city tours"] },
  { etiqueta: "descuento", frases: ["descuento", "descuentos", "rebaja"] },
  { etiqueta: "contrato", frases: ["contrato", "contratos"] },
];

export function senalesEnTexto(textos: string[]): string[] {
  const t = (textos ?? []).filter((x) => typeof x === "string").map(textoComparable).join(" ");
  return PALABRAS_COMPLEJAS.filter((p) => p.frases.some((f) => t.includes(` ${f} `))).map((p) => p.etiqueta);
}

// ── 7. El modelo no pone números ─────────────────────────────────────────────

/** Las cifras que el texto del modelo PUEDE mencionar. En revisión, ninguna. */
export function figurasPermitidas(decision: DecisionEnvio, p: PrecioTraslado | null | undefined): number[] {
  if (decision !== "automatico" || !p) return [];
  return [p.precio_tramo, p.subtotal, p.igv, p.total].filter((n) => Number.isFinite(Number(n))).map(Number);
}

const SIMBOLO = String.raw`(?:S\/\.?|US\$|U\$S|USD|PEN|\$|soles?|d[oó]lares?)`;
const NUM = String.raw`(\d[\d.,]*)`;
const IMPORTE_PREFIJO = new RegExp(String.raw`(?:^|[^A-Za-z0-9])${SIMBOLO}\s*${NUM}`, "gi");
const IMPORTE_SUFIJO = new RegExp(String.raw`${NUM}\s*(?:soles?|d[oó]lares?|USD|PEN|S\/)(?![A-Za-z])`, "gi");

/**
 * Un importe escrito, con separadores de miles o decimales: «1,234.50» → 1234.5; «120,50» → 120.5;
 * «1.234.567» → 1234567. Un punto solo es decimal (así se escribe en Perú).
 */
export function leerImporte(s: string): number | null {
  let t = String(s ?? "").replace(/[.,]+$/, "");
  if (!t) return null;
  const tienePunto = t.includes("."), tieneComa = t.includes(",");
  if (tienePunto && tieneComa) {
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const miles = dec === "." ? "," : ".";
    t = t.split(miles).join("").replace(dec, ".");
  } else if (tieneComa) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (tienePunto && /^\d{1,3}(\.\d{3}){2,}$/.test(t)) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Los importes CON símbolo de moneda que aparecen en un texto. «4 pax», horas y fechas no cuentan. */
export function importesEnTexto(texto: string): number[] {
  const out: number[] = [];
  const s = String(texto ?? "");
  for (const re of [IMPORTE_PREFIJO, IMPORTE_SUFIJO]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const n = leerImporte(m[1]);
      if (n != null) out.push(n);
    }
  }
  return out;
}

/** El texto menciona un importe que no es ninguna de las cifras permitidas. */
export function textoContradicePrecio(texto: string, figuras: number[]): boolean {
  const ok = (figuras ?? []).map(Number).filter(Number.isFinite);
  return importesEnTexto(texto).some((n) => !ok.some((f) => Math.abs(f - n) < 0.005));
}

// ── 8. Los textos que escribe el código ──────────────────────────────────────

/** La misma línea fija del PDF: el chat y el documento dicen lo mismo. */
const LINEA_EJECUTIVO = LINEA_DISPONIBILIDAD;

/**
 * El mensaje que manda el CÓDIGO cuando el del modelo menciona un importe que no es de la
 * cotización (o en revisión). En revisión no lleva ningún importe.
 */
export function mensajeCotizacionCodigo(x: { nombre: string; numero: string; decision: DecisionEnvio; total?: string; validez?: string }): string {
  const nombre = String(x.nombre ?? "").trim().split(/\s+/)[0] ?? "";
  const hola = nombre ? `Hola ${nombre},` : "Hola,";
  if (x.decision === "automatico") {
    const total = x.total ? ` El total es ${x.total} (IGV incluido)` : "";
    const validez = x.validez ? `${total ? "," : " La cotización es"} válida hasta el ${x.validez}` : "";
    return `${hola} te envío la cotización N° ${x.numero} de tu traslado.${total}${validez}${total || validez ? "." : ""} ${LINEA_EJECUTIVO}`;
  }
  return `${hola} registré tu pedido de traslado con la cotización N° ${x.numero}. Un ejecutivo la revisa y te la envía por este chat en breve.`;
}

/** El código público que ve el modelo: no revela cómo se resolvió la zona ni la tarifa. */
export type CodigoPublico = "cotizado" | "falta_dato" | "fecha_pasada" | "requiere_ejecutivo";

const codigoPublico = (r: ResultadoTraslado): CodigoPublico =>
  r.codigo === "cotizable" ? "cotizado"
  : r.codigo === "falta_dato" ? "falta_dato"
  : r.codigo === "fecha_pasada" ? "fecha_pasada"
  : "requiere_ejecutivo";

/** Las claves que puede llevar la respuesta al modelo. La matriz lo comprueba. */
export const CLAVES_RESPUESTA_MODELO = ["accion", "codigo", "faltan", "vehiculo", "sentido", "tramos", "cotizacion", "instruccion"] as const;
export const CLAVES_COTIZACION_MODELO = ["numero", "envio", "total", "incluye_igv", "validez"] as const;

/**
 * Lo que la herramienta le devuelve al modelo, en JSON y con LISTA BLANCA. Nunca la explicación
 * del motor, el motivo interno, ids, alias, el nivel de la tarifa ni el tipo de cambio. En
 * revisión (o sin cotización creada), ningún importe.
 */
export function respuestaParaModelo(x: {
  resultado: ResultadoTraslado;
  cotizacion?: { numero: string; decision: DecisionEnvio } | null;
}): string {
  const r = x.resultado;
  const out: Record<string, unknown> = { accion: r.accion, codigo: codigoPublico(r) };
  if (r.accion === "preguntar") {
    const faltan = (r.faltan ?? []).map((f) => String(f).slice(0, 200));
    out.faltan = faltan;
    out.instruccion = `Pregúntale al cliente, en un solo mensaje: ${faltan.join("; ")}. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos.`;
  } else if (r.accion === "derivar") {
    out.instruccion = "Este pedido lo atiende un ejecutivo. Responde con el mensaje de derivación y no menciones precios.";
  } else {
    const cat = r.vehiculo?.categoria;
    if (cat) out.vehiculo = { nombre: cat.nombre, capacidad: cat.capacidad };
    if (r.precio) {
      out.tramos = r.precio.tramos;
      out.sentido = r.precio.tramos === 2 ? "ida y retorno" : "solo ida";
    }
    const c = x.cotizacion;
    if (c && c.decision === "automatico" && r.precio) {
      out.cotizacion = {
        numero: c.numero, envio: "automatico",
        total: fmtImporte(r.precio.total, r.precio.moneda, "es"), incluye_igv: true,
        validez: r.validez_hasta ? fmtFechaDoc(r.validez_hasta, "es", "corta") : null,
      };
      out.instruccion = `La cotización N° ${c.numero} se envía en PDF justo después de tu mensaje. Dile al cliente el total y la validez EXACTAMENTE como vienen aquí, que el IGV está incluido y que ${LINEA_EJECUTIVO.charAt(0).toLowerCase()}${LINEA_EJECUTIVO.slice(1)} No escribas ningún otro importe.`;
    } else if (c) {
      out.cotizacion = { numero: c.numero, envio: "revision" };
      out.instruccion = `La cotización N° ${c.numero} quedó registrada y la revisa un ejecutivo, que se la enviará por este chat. NO menciones precios ni importes.`;
    } else {
      out.instruccion = "La cotización no se pudo registrar: un ejecutivo atiende el pedido. NO menciones precios ni importes.";
    }
  }
  return JSON.stringify(out);
}

// ── 9. Topes ─────────────────────────────────────────────────────────────────

/**
 * Topes contra el abuso (quien dispara las consultas a Google es un desconocido que escribe por
 * WhatsApp). NO ESTÁN MEDIDOS: son un techo holgado para un cliente de verdad. El lado seguro es
 * bajarlos; superarlos deriva a un ejecutivo, no bloquea al cliente.
 */
export const TOPES = {
  MAX_CONSULTAS_POR_TURNO: 2,
  MAX_CONSULTAS_CONV_DIA: 10,
  MAX_CONSULTAS_DIA: 300,
  MAX_COTIZACIONES_CONV_DIA: 3,
  MAX_COTIZACIONES_DIA: 80,
  VENTANA_MISMO_PEDIDO_MIN: 120,
} as const;

/**
 * Los conteos son de lo YA hecho (antes de esta consulta). Un conteo que no se pudo leer (null)
 * BLOQUEA: «no sé cuántas van» no es «ninguna». Solo se miran los conteos de la fase: en la consulta
 * los de consultas (y el del turno, que se cuenta en memoria); en la cotización, los de cotizaciones.
 */
export function decidirTope(
  c: { consultasConv: number | null; consultasDia: number | null; cotizacionesConv: number | null; cotizacionesDia: number | null; consultasTurno?: number | null },
  fase: "consulta" | "cotizacion",
): { ok: boolean; motivo?: string } {
  const leido = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n);
  if (fase === "consulta") {
    if (c.consultasTurno != null && c.consultasTurno >= TOPES.MAX_CONSULTAS_POR_TURNO)
      return { ok: false, motivo: `Ya se consultaron ${TOPES.MAX_CONSULTAS_POR_TURNO} traslados en esta respuesta.` };
    if (!leido(c.consultasConv) || !leido(c.consultasDia))
      return { ok: false, motivo: "No se pudo contar las consultas de traslados de hoy." };
    if ((c.consultasConv as number) >= TOPES.MAX_CONSULTAS_CONV_DIA)
      return { ok: false, motivo: `Esta conversación ya hizo ${TOPES.MAX_CONSULTAS_CONV_DIA} consultas de traslado hoy.` };
    if ((c.consultasDia as number) >= TOPES.MAX_CONSULTAS_DIA)
      return { ok: false, motivo: `Se alcanzó el tope de ${TOPES.MAX_CONSULTAS_DIA} consultas de traslado del día.` };
    return { ok: true };
  }
  if (!leido(c.cotizacionesConv) || !leido(c.cotizacionesDia))
    return { ok: false, motivo: "No se pudo contar las cotizaciones de traslado de hoy." };
  if ((c.cotizacionesConv as number) >= TOPES.MAX_COTIZACIONES_CONV_DIA)
    return { ok: false, motivo: `Esta conversación ya tiene ${TOPES.MAX_COTIZACIONES_CONV_DIA} cotizaciones de traslado hoy.` };
  if ((c.cotizacionesDia as number) >= TOPES.MAX_COTIZACIONES_DIA)
    return { ok: false, motivo: `Se alcanzó el tope de ${TOPES.MAX_COTIZACIONES_DIA} cotizaciones de traslado del día.` };
  return { ok: true };
}

// ── 10. Lo que dice Ajustes ──────────────────────────────────────────────────

export type CodigoCotizadorIA =
  | "apagado" | "sin_migracion" | "agente_inactivo" | "agente_no_autonomo"
  | "con_horario" | "envio_sin_zonas" | "solo_revision" | "activo";

const listaY = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;

/**
 * Qué está haciendo de verdad el cotizador de la IA, con UN código (el primero que aplica) y las
 * líneas de todo lo que aplica. Ámbar SOLO cuando la configuración contradice lo que parece:
 * falta la migración, la IA cotiza pero el agente no es autónomo (todo queda en revisión aunque
 * el envío esté encendido), o el envío está encendido sin ninguna zona marcada.
 */
export function estadoCotizadorIA(x: {
  iaCotiza: boolean;
  envioMaestro: boolean;
  zonasConEnvio: string[];
  agente: { activo?: boolean; canales?: string[]; canales_autonomos?: string[]; horario_activo?: boolean; hora_inicio?: string; hora_fin?: string } | null;
  sinMigracion: boolean;
}): { codigo: CodigoCotizadorIA; ambar: boolean; lineas: string[] } {
  if (x.sinMigracion) {
    return {
      codigo: "sin_migracion", ambar: true,
      lineas: ["Falta correr supabase/traslados-05-cotizacion-ia.sql: la IA del CRM no cotiza traslados hasta entonces."],
    };
  }
  if (!x.iaCotiza) {
    return { codigo: "apagado", ambar: false, lineas: ["La IA del CRM no cotiza traslados: está apagado."] };
  }
  const a = x.agente;
  const canales = Array.isArray(a?.canales) ? a!.canales! : [];
  const autonomos = Array.isArray(a?.canales_autonomos) ? a!.canales_autonomos! : [];
  if (!a || a.activo !== true || !canales.includes("whatsapp")) {
    return {
      codigo: "agente_inactivo", ambar: false,
      lineas: ["El agente IA no atiende WhatsApp (está apagado o sin ese canal): no cotiza nada. Se cambia en /crm/agente."],
    };
  }
  const lineas: string[] = [];
  const zonas = (x.zonasConEnvio ?? []).filter(Boolean);
  const horario = a.horario_activo === true
    ? `El agente solo responde de ${a.hora_inicio ?? "08:00"} a ${a.hora_fin ?? "20:00"}: fuera de ese horario no cotiza.`
    : null;
  if (!autonomos.includes("whatsapp")) {
    lineas.push("El agente está en modo copiloto para WhatsApp: cotiza, pero cada cotización queda en revisión aunque el envío automático esté encendido. Se cambia en /crm/agente.");
    if (horario) lineas.push(horario);
    return { codigo: "agente_no_autonomo", ambar: true, lineas };
  }
  let codigo: CodigoCotizadorIA;
  if (!x.envioMaestro) {
    codigo = "solo_revision";
    lineas.push("La IA cotiza y deja cada cotización para que la revise un ejecutivo: el envío automático está apagado.");
  } else if (zonas.length === 0) {
    codigo = "envio_sin_zonas";
    lineas.push("El envío automático está encendido pero ninguna zona lo tiene marcado: todo queda en revisión.");
  } else {
    codigo = horario ? "con_horario" : "activo";
    lineas.push(`La cotización se envía sola cuando el recojo o el destino es ${listaY(zonas)}; las demás quedan en revisión.`);
  }
  if (horario) lineas.push(horario);
  return { codigo, ambar: codigo === "envio_sin_zonas", lineas };
}

// ── 11. La tarjeta del CRM: ¿se puede enviar esta cotización? ────────────────

/** Lo que dura el reclamo de un envío (estado `enviando`): pasado esto, se puede reintentar. */
export const PLAZO_ENVIO_MS = 5 * 60_000;

/** El plazo que se escribe en `resuelta_at` al reclamar el envío. */
export const plazoEnvio = (ahoraMs: number): string => new Date(ahoraMs + PLAZO_ENVIO_MS).toISOString();

export type PlanAccion = "ok" | "no_pendiente" | "cotizacion_ajena" | "cotizacion_no_existe" | "canal_no_whatsapp" | "sin_remitente" | "sin_precio";

type ItemSuelto = { dias?: unknown; cantidad?: unknown; precio_unit?: unknown; descuento_pct?: unknown };

/** Los ítems con números de verdad, o null si alguno no lo es. */
export function itemsMonto(v: unknown): { dias: number; cantidad: number; precio_unit: number; descuento_pct: number }[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const it of v as ItemSuelto[]) {
    if (!it || typeof it !== "object") return null;
    const dias = Number(it.dias ?? 1), cantidad = Number(it.cantidad), precio_unit = Number(it.precio_unit), descuento_pct = Number(it.descuento_pct ?? 0);
    if (![dias, cantidad, precio_unit, descuento_pct].every(Number.isFinite)) return null;
    out.push({ dias, cantidad, precio_unit, descuento_pct });
  }
  return out;
}

/**
 * ¿Se puede ENVIAR (desde la tarjeta o en automático) la cotización de esta acción? Exige que la
 * acción sea una cotización de traslado y siga pendiente (o en `enviando` con el plazo VENCIDO:
 * el envío anterior murió; `resuelta_at` guarda ese plazo mientras se envía, y sin plazo escrito
 * también se da por vencido para que no quede atascada), que la cotización sea DE ESTA
 * conversación y tenga `traslado_json`, que la conversación sea de WhatsApp con remitente, y que
 * los importes se puedan imprimir.
 */
export function planAccionTraslado(
  accion: { tipo?: string | null; estado?: string | null; conversacion_id?: string | null; resuelta_at?: string | null; resultado_id?: number | null } | null,
  cotizacion: { id: number; crm_conversacion_id?: string | null; traslado_json?: unknown; items_json?: unknown; moneda?: string | null; tipo_cambio?: unknown; incluye_igv?: boolean | null; precio_cliente?: unknown } | null,
  conv: { id?: string | null; canal?: string | null; wa_id?: string | null } | null,
  ahoraMs: number = Date.now(),
): { codigo: PlanAccion; detalle: string } {
  if (!accion || accion.tipo !== "cotizacion_traslado")
    return { codigo: "cotizacion_no_existe", detalle: "La acción no es una cotización de traslado." };
  const vencida = accion.estado === "enviando" && (!accion.resuelta_at || !(Date.parse(accion.resuelta_at) > ahoraMs));
  if (accion.estado !== "pendiente" && !vencida) {
    return {
      codigo: "no_pendiente",
      detalle: accion.estado === "enviando" ? "Se está enviando en este momento: espera unos minutos." : `La cotización ya fue ${accion.estado ?? "resuelta"}.`,
    };
  }
  if (!cotizacion) return { codigo: "cotizacion_no_existe", detalle: "La cotización ya no existe (se borró en /cotizaciones)." };
  if (!accion.conversacion_id || cotizacion.crm_conversacion_id !== accion.conversacion_id
    || (accion.resultado_id != null && Number(accion.resultado_id) !== Number(cotizacion.id))) {
    return { codigo: "cotizacion_ajena", detalle: "La cotización no es de esta conversación." };
  }
  if (cotizacion.traslado_json == null || typeof cotizacion.traslado_json !== "object") {
    return { codigo: "cotizacion_ajena", detalle: "La cotización no es un traslado cotizado por la IA." };
  }
  if (!conv || (conv.id != null && conv.id !== accion.conversacion_id) || conv.canal !== "whatsapp")
    return { codigo: "canal_no_whatsapp", detalle: "La conversación no es de WhatsApp: el PDF se envía solo por WhatsApp." };
  if (!(typeof conv.wa_id === "string" && conv.wa_id.trim()))
    return { codigo: "sin_remitente", detalle: "La conversación no tiene el número de WhatsApp del cliente." };
  const items = itemsMonto(cotizacion.items_json);
  const tot = items ? totalesEnMoneda(items, normalizarMoneda(cotizacion.moneda), cotizacion.tipo_cambio, cotizacion.incluye_igv !== false) : null;
  if (!tot || !(tot.total > 0))
    return { codigo: "sin_precio", detalle: "La cotización no tiene un importe que se pueda imprimir: corrígela en /cotizaciones." };
  return { codigo: "ok", detalle: "" };
}
