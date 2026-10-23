// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-ia.ts — Lo que el agente IA del CRM ve de la RESERVA de un traslado: sus
// cuatro herramientas, lo que cada una le devuelve (lista blanca), el bloque del prompt y el texto
// final del turno. Motor PURO: lo usan lib/crm-ia.ts y su orquestador del servidor.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. EL MODELO NO PONE DINERO NI CUENTAS. Ningún esquema tiene monto, moneda, teléfono ni
//     destinatario; las respuestas al modelo no llevan importes, porcentajes, cuentas ni plazos
//     (`CLAVES_RESPUESTA_RESERVA`): si no los tiene, no los puede escribir.
//  2. LO QUE LE LLEGA AL CLIENTE LO ESCRIBE EL CÓDIGO (`textoFinalReserva`): los mensajes de las
//     herramientas de reserva (T1–T11 de lib/traslados/reserva-pago.ts), en orden. Sin mensaje, el
//     texto del modelo pasa SOLO si no habla de dinero ni trae un número largo (una cuenta, un
//     teléfono) cuando hay una cotización de traslado en el chat: si no, la guarda T10.
//  3. NUNCA «PAGO CONFIRMADO»: el pago lo verifica una persona en el banco, y la unidad la confirma
//     un ejecutivo. El bloque del prompt lo dice y ninguna instrucción lo contradice.
//  4. CON LA RESERVA APAGADA NO CAMBIA NADA: si `estadoReservaIA` no la deja activa, quien arma el
//     prompt no añade este bloque ni estas herramientas, y el prompt es byte a byte el de antes.
// Matriz: ANTHROPIC_API_KEY=x npx tsx scripts/prueba-reserva-ia.mts
// ──────────────────────────────────────────────────────────────────────────────

import { mencionaDinero, motivosLineaIA, textoLibreSospechoso } from "./texto-libre";
import { mensajeGuardaReserva, type ConfigReserva } from "./reserva-pago";
import type { EstiloMensajes } from "../crm-ia-ajustes";

// ── 1. Las herramientas ──────────────────────────────────────────────────────

const PROP_NUMERO = {
  numero_cotizacion: {
    type: "string",
    description: "El N° de la cotización de traslado, SOLO si en este chat hay más de una y el cliente dijo cuál. Cópialo tal cual de la cotización.",
  },
};

export const HERRAMIENTA_RESERVAR_TRASLADO = {
  name: "reservar_traslado" as const,
  description:
    "Úsala cuando el cliente ACEPTA una cotización de traslado que ya se le envió por este chat, o pregunta cómo pagar o cómo reservar. " +
    "El sistema decide si se le pide el adelanto ahora o si primero un ejecutivo confirma la unidad, y le escribe al cliente el mensaje con el monto, las cuentas y el plazo: " +
    "tú NO escribes importes, porcentajes, cuentas bancarias ni plazos, y nunca confirmas la reserva ni la disponibilidad de la unidad.",
  input_schema: {
    type: "object",
    properties: {
      ...PROP_NUMERO,
      nombre_pasajero: { type: "string", description: "Nombre de quien viaja, SOLO si el cliente lo dio en este chat." },
      vuelo: { type: "string", description: "El número de vuelo, SOLO si el cliente lo dio (letras y números, tal como lo escribió)." },
    },
  },
};

export const HERRAMIENTA_REPORTAR_PAGO = {
  name: "reportar_pago_traslado" as const,
  description:
    "Úsala cuando el cliente manda (o dice que mandó) la FOTO o captura del comprobante de pago de su traslado, o dice que ya pagó. " +
    "El sistema lee el comprobante y le responde al cliente. Tú NUNCA digas que el pago está confirmado, validado o recibido, ni repitas montos: lo verifica una persona en el banco.",
  input_schema: { type: "object", properties: { ...PROP_NUMERO } },
};

export const HERRAMIENTA_POLITICAS_RESERVA = {
  name: "politicas_reserva" as const,
  description:
    "Úsala cuando el cliente pregunta por las políticas de reserva, cambios o cancelación de su traslado, o qué pasa si cancela o no se presenta. " +
    "El sistema le envía las políticas al pie de la letra: no las resumas, no las cambies y no agregues condiciones.",
  input_schema: { type: "object", properties: { ...PROP_NUMERO } },
};

export const HERRAMIENTA_CANCELAR_RESERVA = {
  name: "cancelar_reserva_traslado" as const,
  description:
    "Úsala cuando el cliente pide CANCELAR su reserva de traslado. El sistema registra el pedido con la hora de su mensaje y un ejecutivo le confirma lo que corresponde según las políticas. " +
    "No prometas devoluciones ni montos. Para CAMBIAR la fecha, la hora o el recorrido NO la uses: usa escalar_a_humano.",
  input_schema: { type: "object", properties: { ...PROP_NUMERO } },
};

export const HERRAMIENTAS_RESERVA = [
  HERRAMIENTA_RESERVAR_TRASLADO, HERRAMIENTA_REPORTAR_PAGO, HERRAMIENTA_POLITICAS_RESERVA, HERRAMIENTA_CANCELAR_RESERVA,
] as const;

export type HerramientaReserva = (typeof HERRAMIENTAS_RESERVA)[number]["name"];
export const NOMBRES_HERRAMIENTAS_RESERVA: readonly HerramientaReserva[] = HERRAMIENTAS_RESERVA.map((h) => h.name);

// ── 2. Lo que se acepta del modelo ───────────────────────────────────────────

const unaLinea = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * El código de un vuelo: la aerolínea (2 caracteres, con al menos una letra: «LA», «H2», «2I»), un
 * espacio o guion opcional, de 1 a 4 dígitos y una letra opcional («LA 2047», «LA2047», «H2-1234A»).
 * El vuelo se IMPRIME en la Confirmación de Reserva: con la regla anterior (letras, números y algún
 * dígito, hasta 20) pasaba un texto como «SALDO 0 PAGADO». Lo que no calce se descarta.
 */
export const RE_VUELO = /^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])[ -]?\d{1,4}[A-Z]?$/;

/**
 * La entrada de las herramientas, con lista blanca. El número de cotización solo con letras,
 * números y guiones (hasta 30); el nombre del pasajero hasta 80 caracteres y nunca algo sospechoso
 * (un enlace, un importe, palabras de pago, un número largo); el vuelo, un código de vuelo (`RE_VUELO`).
 */
export function entradaReserva(input: unknown): { numeroCotizacion: string | null; nombrePasajero: string | null; vuelo: string | null } {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const n = unaLinea(o.numero_cotizacion).replace(/^(?:N\s*[°º.]?\s*|NRO\.?\s*)/i, "");
  const numero = /^[A-Za-z0-9-]{1,30}$/.test(n) ? n : null;
  const nombreCrudo = unaLinea(o.nombre_pasajero);
  const nombre = nombreCrudo && !textoLibreSospechoso(nombreCrudo) && /\p{L}/u.test(nombreCrudo) ? Array.from(nombreCrudo).slice(0, 80).join("").trim() : null;
  const v = unaLinea(o.vuelo).toUpperCase();
  const vuelo = RE_VUELO.test(v) ? v : null;
  return { numeroCotizacion: numero, nombrePasajero: nombre || null, vuelo };
}

// ── 3. Qué cotización se reserva ─────────────────────────────────────────────

export type CotizacionCandidata = {
  id: number;
  /** El N° que ve el cliente (`numeroCotizacion`). */
  numero: string;
  /** La acción `cotizacion_traslado` de esta conversación quedó `aprobada` (se envió). */
  enviada: boolean;
  /** Ya venció (validez pasada) o el servicio ya pasó. */
  vencida: boolean;
  /** Tiene una solicitud de reserva viva. */
  solicitudViva: boolean;
};

export type EleccionCotizacion =
  | { accion: "crear"; cotizacion: CotizacionCandidata }
  | { accion: "ya_solicitada" | "recotizar"; cotizacion: CotizacionCandidata }
  | { accion: "elegir_cotizacion"; opciones: string[] }
  | { accion: "sin_cotizacion" };

const claveNumero = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").replace(/^0+(?=.)/, "").toUpperCase();

/**
 * Cuál de las cotizaciones de traslado de ESTA conversación se reserva. Solo cuentan las ENVIADAS.
 * Con el número que dio el cliente, esa (si no es de este chat, a elegir). Sin número: la única
 * vigente y sin solicitud viva; si solo hay una enviada, esa (para decir que ya está solicitada o
 * que hay que recotizar); con varias, a elegir. Nunca adivina entre dos.
 */
export function elegirCotizacion(candidatas: readonly CotizacionCandidata[] | null | undefined, numeroPedido?: string | null): EleccionCotizacion {
  const enviadas = (candidatas ?? []).filter((c) => c && c.enviada === true);
  if (!enviadas.length) return { accion: "sin_cotizacion" };
  const decidir = (c: CotizacionCandidata): EleccionCotizacion =>
    c.solicitudViva ? { accion: "ya_solicitada", cotizacion: c } : c.vencida ? { accion: "recotizar", cotizacion: c } : { accion: "crear", cotizacion: c };
  const pedido = typeof numeroPedido === "string" && numeroPedido.trim() ? claveNumero(numeroPedido) : "";
  if (pedido) {
    const c = enviadas.find((x) => claveNumero(x.numero) === pedido);
    return c ? decidir(c) : { accion: "elegir_cotizacion", opciones: enviadas.map((x) => x.numero) };
  }
  const elegibles = enviadas.filter((c) => !c.vencida && !c.solicitudViva);
  if (elegibles.length === 1) return decidir(elegibles[0]);
  if (enviadas.length === 1) return decidir(enviadas[0]);
  return { accion: "elegir_cotizacion", opciones: enviadas.map((x) => x.numero) };
}

// ── 4. Lo que se le devuelve al modelo (lista blanca) ────────────────────────

export type AccionReservar = "pedir_pago" | "confirmar_disponibilidad" | "derivar" | "recotizar" | "elegir_cotizacion" | "sin_cotizacion" | "ya_solicitada";
export type AccionReportarPago = "comprobante_registrado" | "pedir_comprobante" | "ya_registrado" | "derivar";
export type AccionPoliticas = "enviar_politicas" | "derivar";
export type AccionCancelar = "cancelada_sin_pago" | "cancelacion_registrada" | "sin_reserva" | "derivar";
export type AccionReserva = AccionReservar | AccionReportarPago | AccionPoliticas | AccionCancelar;

export const ACCIONES_POR_HERRAMIENTA: Record<HerramientaReserva, readonly AccionReserva[]> = {
  reservar_traslado: ["pedir_pago", "confirmar_disponibilidad", "derivar", "recotizar", "elegir_cotizacion", "sin_cotizacion", "ya_solicitada"],
  reportar_pago_traslado: ["comprobante_registrado", "pedir_comprobante", "ya_registrado", "derivar"],
  politicas_reserva: ["enviar_politicas", "derivar"],
  cancelar_reserva_traslado: ["cancelada_sin_pago", "cancelacion_registrada", "sin_reserva", "derivar"],
};

/** Las claves que puede llevar una respuesta al modelo. La matriz lo comprueba. */
export const CLAVES_RESPUESTA_RESERVA = ["accion", "cotizacion", "opciones", "instruccion"] as const;
export const CLAVES_COTIZACION_RESERVA = ["numero"] as const;

const NO_ESCRIBAS = "No escribas importes, porcentajes, cuentas bancarias ni plazos.";

/** Lo que se le dice al modelo por cada acción. Sin cifras, sin cuentas, sin plazos. */
export const INSTRUCCION_RESERVA: Record<AccionReserva, string> = {
  pedir_pago: `El sistema le envía al cliente, en este turno, el mensaje con el adelanto, las cuentas y el plazo de confirmación: tu texto no se envía. ${NO_ESCRIBAS} Nunca digas que el pago o la reserva están confirmados.`,
  confirmar_disponibilidad: `El sistema le avisa al cliente que primero un ejecutivo confirma la unidad y que todavía no pague: tu texto no se envía. ${NO_ESCRIBAS}`,
  derivar: `Este pedido lo atiende un ejecutivo: responde con el mensaje de derivación. ${NO_ESCRIBAS}`,
  recotizar: `Esa cotización ya venció o su fecha ya pasó: dile al cliente que hay que volver a cotizar y llama a cotizar_traslado con los datos del viaje. ${NO_ESCRIBAS}`,
  elegir_cotizacion: `En este chat hay varias cotizaciones de traslado (ver «opciones»): pregúntale al cliente cuál desea reservar y vuelve a llamar a reservar_traslado con su numero_cotizacion. ${NO_ESCRIBAS}`,
  sin_cotizacion: `No hay una cotización de traslado enviada por este chat que se pueda reservar: si el cliente quiere reservar un traslado, primero cotízalo con cotizar_traslado. ${NO_ESCRIBAS}`,
  ya_solicitada: `Esa cotización ya tiene una reserva en curso: dile al cliente que está registrada y que un ejecutivo le escribe por este chat. ${NO_ESCRIBAS}`,
  comprobante_registrado: `El sistema le responde al cliente que recibió el comprobante y que lo verifica con el banco: tu texto no se envía. ${NO_ESCRIBAS} Nunca digas que el pago está confirmado o validado.`,
  pedir_comprobante: `No hay una foto o captura nueva del comprobante en el chat: el sistema le pide que la envíe. Tu texto no se envía. ${NO_ESCRIBAS}`,
  ya_registrado: `Ese comprobante ya se había registrado: dile al cliente que lo estamos verificando con el banco. ${NO_ESCRIBAS} Nunca digas que el pago está confirmado.`,
  enviar_politicas: "El sistema le envía las políticas al pie de la letra en este turno: tu texto no se envía. No las resumas ni las cambies.",
  cancelada_sin_pago: `El sistema le confirma al cliente que se anuló su pedido de reserva: tu texto no se envía. ${NO_ESCRIBAS}`,
  cancelacion_registrada: `El sistema le confirma al cliente que registró su pedido de cancelación y que un ejecutivo le dirá lo que corresponde: tu texto no se envía. No prometas devoluciones. ${NO_ESCRIBAS}`,
  sin_reserva: `No hay una reserva de traslado en curso en este chat. Si el cliente quiere cancelar otro servicio, usa escalar_a_humano. ${NO_ESCRIBAS}`,
};

/**
 * La respuesta de una herramienta de reserva para el modelo, en JSON y con lista blanca: la acción,
 * el número de la cotización (o las opciones), y la instrucción. Nada más.
 */
export function respuestaReservaParaModelo(accion: AccionReserva, x: { numero?: string | null; opciones?: readonly string[] | null } = {}): string {
  const out: Record<string, unknown> = { accion };
  const numero = typeof x.numero === "string" && x.numero.trim() ? x.numero.trim().slice(0, 30) : null;
  if (numero) out.cotizacion = { numero };
  if (accion === "elegir_cotizacion" && x.opciones?.length) out.opciones = x.opciones.map((o) => String(o).slice(0, 30)).slice(0, 10);
  out.instruccion = INSTRUCCION_RESERVA[accion] ?? INSTRUCCION_RESERVA.derivar;
  return JSON.stringify(out);
}

/** Lo que devuelve una herramienta de reserva en el turno. */
export type ResultadoReservaIA = {
  /** JSON con lista blanca para el modelo (`respuestaReservaParaModelo`). */
  respuestaModelo: string;
  /** El mensaje que el CÓDIGO le manda al cliente (T1–T11), o null si no hay. */
  mensaje: string | null;
  /** Lo atiende un ejecutivo: el agente deriva la conversación con esto (la nota es interna). */
  derivar?: { motivo: string; pedido: string; nota: string };
};

// ── 5. El texto del turno ────────────────────────────────────────────────────

/**
 * El texto que se le manda al cliente en un turno, mirando lo que hicieron las herramientas de
 * reserva. Devuelve null cuando NO decide (y quien llama sigue como siempre: `textoSinImportesAjenos`):
 *  1. si alguna herramienta de reserva trae `mensaje`, esos mensajes en orden (sin repetir el mismo
 *     dos veces seguidas): el texto del modelo no se envía;
 *  2. si alguna derivó y se pasa `derivacion`, el mensaje de derivación;
 *  3. si el turno cotizó un traslado (`cotizoEnElTurno`), null: manda el mensaje de la cotización;
 *  4. la GUARDA: con una cotización de traslado en el chat, un texto del modelo que habla de dinero
 *     (`mencionaDinero`) o trae un número de 6 o más dígitos (una cuenta, un teléfono) → T10;
 *  5. si no, null.
 * Lo que escribe el código va con el `estilo` del agente (y su `idioma`: en inglés, la guarda T10 en
 * inglés y `mencionaDinero` mirando también el vocabulario inglés, porque un cliente en inglés
 * recibe del modelo un texto en inglés: «the total would be 150» no se le escapa).
 */
export function textoFinalReserva(
  texto: string,
  turno: readonly (ResultadoReservaIA | null | undefined)[] | null | undefined,
  x: { estilo: EstiloMensajes; numeroCotizacion: string | null; hayCotizacionTraslado: boolean; derivacion?: string | null; cotizoEnElTurno?: boolean },
): string | null {
  const mensajes: string[] = [];
  for (const r of turno ?? []) {
    const m = typeof r?.mensaje === "string" ? r.mensaje.trim() : "";
    if (m && mensajes[mensajes.length - 1] !== m) mensajes.push(m);
  }
  if (mensajes.length) return mensajes.join("\n\n");
  if ((turno ?? []).some((r) => r?.derivar) && typeof x.derivacion === "string" && x.derivacion.trim()) return x.derivacion;
  if (x.cotizoEnElTurno) return null;
  const t = String(texto ?? "");
  if (x.hayCotizacionTraslado && t.trim() && (mencionaDinero(t, x.estilo?.idioma === "en" ? "en" : "es") || motivosLineaIA(t).includes("numero_largo"))) {
    return mensajeGuardaReserva(x.numeroCotizacion, x.estilo);
  }
  return null;
}

/** El texto con que el código pide la foto del comprobante (sin imagen nueva en el chat). */
export function mensajePedirComprobante(estilo: EstiloMensajes): string {
  if (estilo?.idioma === "en") return "To register your payment, please send us a photo or screenshot of the receipt in this chat, showing the amount, the date and the transaction number.";
  return estilo?.tratamiento === "tu"
    ? "Para registrar tu pago, envíanos por este chat la foto o captura del comprobante, donde se vean el monto, la fecha y el número de operación."
    : "Para registrar su pago, envíenos por este chat la foto o captura del comprobante, donde se vean el monto, la fecha y el número de operación.";
}

// ── 6. El bloque del prompt ──────────────────────────────────────────────────

/** El renglón de «## Traslados simples» que se reemplaza cuando la reserva está activa. */
export const FRASE_PROPONER_RESERVA_TRASLADOS = "Si el cliente acepta la cotización, usa proponer_reserva.";
/** Lo que va en su lugar. */
export const FRASE_RESERVAR_TRASLADO =
  "Si el cliente acepta la cotización de traslado o pregunta cómo pagar, usa reservar_traslado (no proponer_reserva).";

/**
 * «## Reserva y pago de traslados»: va SOLO con la reserva activa (si no, el prompt es el de antes,
 * byte a byte). Sin montos, porcentajes ni cuentas: los pone el sistema.
 */
export function bloqueReservaTraslados(): string {
  return [
    "## Reserva y pago de traslados",
    "- Si el cliente acepta una cotización de traslado que ya se le envió por este chat, o pregunta cómo pagar o cómo reservar, usa reservar_traslado. El sistema decide si se le pide el adelanto ahora o si primero un ejecutivo confirma la unidad, y le escribe el mensaje con el monto, las cuentas y el plazo.",
    "- Tú NUNCA escribes importes, porcentajes de adelanto, números de cuenta ni plazos de confirmación: los pone el sistema.",
    "- Nunca digas que un pago está confirmado, validado o recibido: lo verifica una persona del equipo con el banco. Tampoco confirmes la disponibilidad de la unidad: la confirma un ejecutivo.",
    "- Cuando el cliente manda la foto o captura del comprobante, o dice que ya pagó, usa reportar_pago_traslado.",
    "- Si pregunta por las políticas de reserva, cambios o cancelación, usa politicas_reserva: el sistema se las envía tal cual; no las resumas ni las cambies.",
    "- Si pide cancelar su reserva, usa cancelar_reserva_traslado. Para cambiar la fecha, la hora o el recorrido, usa escalar_a_humano: un ejecutivo informa el nuevo precio antes de confirmar.",
    "",
  ].join("\n");
}

// ── 7. Lo que dice Ajustes ───────────────────────────────────────────────────

export type CodigoReservaIA =
  | "sin_migracion" | "apagado" | "sin_traslados" | "agente_no_autonomo" | "sin_adelanto" | "sin_cuentas"
  | "sin_politica" | "activo";

/**
 * Qué hace de verdad la reserva de la IA, con UN código (el primero que aplica) y las líneas de todo
 * lo que aplica. `activa` ⟺ se ofrecen las herramientas. Ámbar solo cuando la configuración
 * contradice lo que parece: falta la migración, o está encendida y algo la deja sin efecto o la
 * política escrita dice otro porcentaje.
 */
export function estadoReservaIA(x: {
  sinMigracion: boolean;
  cfg: ConfigReserva;
  /** La IA cotiza traslados (`traslados_config.ia_cotiza`). */
  iaCotiza: boolean;
  /** El agente es autónomo en WhatsApp. */
  agenteAutonomo: boolean;
  /** El horario de atención del equipo está en uso (sin él, todo va «disponibilidad primero»). */
  atencionEnUso: boolean;
  /** Cuántas cuentas hay en soles (las del PDF). */
  cuentas: number;
  /** A quién iría el correo del pago reportado. */
  correos: readonly string[];
  /** Líneas de la política de reserva de la plantilla del traslado. */
  politicaLineas: number;
  /** Cuántas líneas de la política contradicen la configuración. */
  contradicciones: number;
}): { codigo: CodigoReservaIA; activa: boolean; ambar: boolean; lineas: string[] } {
  if (x.sinMigracion) {
    return { codigo: "sin_migracion", activa: false, ambar: true, lineas: ["Falta correr supabase/traslados-09-reserva-ia.sql (y las de reservas-09): la IA no reserva traslados hasta entonces."] };
  }
  if (x.cfg.activa !== true) return { codigo: "apagado", activa: false, ambar: false, lineas: ["La IA no reserva traslados: está apagado."] };
  if (!x.iaCotiza) return { codigo: "sin_traslados", activa: false, ambar: true, lineas: ["La reserva está encendida pero la IA no cotiza traslados: sin cotización no hay nada que reservar."] };
  if (!x.agenteAutonomo) return { codigo: "agente_no_autonomo", activa: false, ambar: true, lineas: ["El agente está en modo copiloto para WhatsApp: no reserva sola. Se cambia en /crm/agente."] };
  const lineas: string[] = [];
  let codigo: CodigoReservaIA = "activo";
  let ambar = false;
  if (x.cfg.adelantoPct == null) {
    codigo = "sin_adelanto"; ambar = true;
    lineas.push("No hay porcentaje de adelanto: cada reserva va «disponibilidad primero» y el ejecutivo pide el pago.");
  } else {
    lineas.push(`Se pide un adelanto del ${x.cfg.adelantoPct} % del total.`);
  }
  if (!(x.cuentas > 0)) {
    if (codigo === "activo") codigo = "sin_cuentas";
    ambar = true;
    lineas.push("No hay cuentas bancarias en soles en el PDF de la cotización (Configuración → Perfil de la empresa): no se le puede pedir el pago al cliente.");
  }
  if (!(x.politicaLineas > 0)) {
    if (codigo === "activo") codigo = "sin_politica";
    ambar = true;
    lineas.push("La plantilla de traslados no tiene políticas de reserva y cancelación: el agente no las puede enviar (/cotizaciones/plantillas).");
  }
  if (x.contradicciones > 0) {
    ambar = true;
    lineas.push(`${x.contradicciones === 1 ? "Una línea" : `${x.contradicciones} líneas`} de la política dice${x.contradicciones === 1 ? "" : "n"} otro porcentaje de adelanto u otro plazo de devolución que la configuración: corrígela en /cotizaciones/plantillas.`);
  }
  if (!x.atencionEnUso) {
    ambar = true;
    lineas.push("El horario de atención del equipo no está declarado (/crm/agente → Ajustes): ningún pago se pide antes de que un ejecutivo confirme la unidad.");
  }
  if (!(x.correos?.length > 0)) {
    ambar = true;
    lineas.push("No hay a quién mandar el correo del pago reportado: escribe el correo en Ajustes de traslados o en /configuracion/perfil.");
  }
  return { codigo, activa: true, ambar, lineas };
}

// ── 8. Topes ─────────────────────────────────────────────────────────────────

/**
 * Topes contra el abuso (quien manda las fotos es un desconocido que escribe por WhatsApp y cada
 * lectura del comprobante es una llamada al modelo de visión). NO ESTÁN MEDIDOS: son un techo
 * holgado para un cliente de verdad. El lado seguro es bajarlos; superarlos deriva a un ejecutivo.
 */
export const TOPES_RESERVA = {
  MAX_SOLICITUDES_CONV_DIA: 3,
  MAX_SOLICITUDES_DIA: 60,
  MAX_LECTURAS_CONV_DIA: 6,
  MAX_LECTURAS_DIA: 150,
  MAX_HERRAMIENTAS_RESERVA_TURNO: 3,
  /** El correo «comprobante sin cotización que reservar» (un comprobante, una vez). NO medidos. */
  MAX_CORREOS_SIN_COTIZACION_CONV_DIA: 2,
  MAX_CORREOS_SIN_COTIZACION_DIA: 40,
} as const;

/** Los conteos son de lo YA hecho. Un conteo que no se pudo leer (null) BLOQUEA: «no sé» no es «cero». */
export function decidirTopeReserva(
  c: { conv: number | null; dia: number | null; turno?: number | null },
  fase: "solicitud" | "lectura" | "correo_sin_cotizacion",
): { ok: boolean; motivo?: string } {
  const leido = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n);
  if (c.turno != null && c.turno >= TOPES_RESERVA.MAX_HERRAMIENTAS_RESERVA_TURNO) {
    return { ok: false, motivo: `Ya se usaron ${TOPES_RESERVA.MAX_HERRAMIENTAS_RESERVA_TURNO} herramientas de reserva en esta respuesta.` };
  }
  if (!leido(c.conv) || !leido(c.dia)) return { ok: false, motivo: "No se pudo contar lo que ya se hizo hoy." };
  const [maxConv, maxDia, que] = fase === "solicitud"
    ? [TOPES_RESERVA.MAX_SOLICITUDES_CONV_DIA, TOPES_RESERVA.MAX_SOLICITUDES_DIA, "solicitudes de reserva"]
    : fase === "lectura"
      ? [TOPES_RESERVA.MAX_LECTURAS_CONV_DIA, TOPES_RESERVA.MAX_LECTURAS_DIA, "lecturas de comprobantes"]
      : [TOPES_RESERVA.MAX_CORREOS_SIN_COTIZACION_CONV_DIA, TOPES_RESERVA.MAX_CORREOS_SIN_COTIZACION_DIA, "correos de comprobantes sin cotización"];
  if ((c.conv as number) >= maxConv) return { ok: false, motivo: `Esta conversación ya tiene ${maxConv} ${que} hoy.` };
  if ((c.dia as number) >= maxDia) return { ok: false, motivo: `Se alcanzó el tope de ${maxDia} ${que} del día.` };
  return { ok: true };
}
