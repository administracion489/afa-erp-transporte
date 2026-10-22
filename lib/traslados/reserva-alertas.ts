// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-alertas.ts — Qué solicitudes de reserva de traslado (las que toma la IA del
// CRM, reservas-09a) tienen que AVISAR a los contactos del directorio, cuáles se CIERRAN SOLAS, y el
// texto de cada aviso. Motor PURO: no lee la base, no envía nada y no mira el reloj (`ahoraMs` y
// `hoy` entran por parámetro). Lo usa el tick (/api/alertas-flota/tick) con su lector,
// lib/traslados/reserva-alertas-datos.ts.
//
// LAS TRES DECISIONES, Y LO QUE NO SE AFLOJA EN CADA UNA:
//  1. `reserva_sin_confirmar`: una solicitud «por confirmar» o con «pago reportado» que llegó a su
//     plazo para confirmar (`confirmar_antes_de` + el umbral de su tarjeta, en minutos) sin que un
//     ejecutivo la resuelva, o que nació `urgente`. Y un escalón más, UNA vez, si el servicio queda a
//     menos de la mitad del margen de reserva (`reserva_margen_min / 2`) sin resolverse — también la
//     que no tiene plazo (sin horario de atención declarado), que es justo la que nadie vigila.
//     · EL PRIMER AVISO SE ATA A SU PLAZO (`sol:<id>:aviso:<plazo>`): si la solicitud vuelve a
//       «esperando pago» («Pedir otro comprobante») y el segundo comprobante trae un plazo nuevo,
//       ese plazo vencido es un hecho nuevo y vuelve a avisar. El escalón del margen es uno por
//       solicitud (`sol:<id>:margen`) y, cuando sale, se reclama también el primero: dos WhatsApp
//       en el mismo tick (el tick estuvo caído) o un «venció hace…» DESPUÉS de «faltan 20 min»
//       serían ruido.
//  2. `devolucion_pendiente`: se acordó devolver (no hubo unidad → el 100 %, o se canceló con
//     `devolucion_pct > 0`) y lo DEVUELTO (pagos `sentido = 'pago'` de la solicitud) sigue por
//     debajo de lo acordado pasadas `umbral` HORAS desde que se acordó (`cerrada_en`). La cuenta es
//     la de `queFalta` (lib/traslados/reserva-pago.ts): `dineroDeSolicitud` + `devolucionDecidida`
//     con la MISMA tolerancia de medio céntimo — dos cuentas de la misma plata terminan diciendo
//     cifras distintas. Sin poder leer los pagos NO se afirma nada (ni «saldada» ni «pendiente»).
//  3. EL AUTO-VENCIMIENTO: una solicitud «esperando pago» SIN DINERO EN JUEGO (ningún pago ni
//     comprobante registrado, y sin reserva creada) cuya cotización venció (`traslado_json.
//     validez_hasta` < hoy, la regla de `elegibilidadDeReserva`) o cuyo servicio ya pasó se cierra
//     como `cancelada` con `cierre_motivo = 'vencida'`. Sin poder leer pagos o comprobantes no se
//     cierra: una lista vacía por un error no es «no pagó». No le escribe al cliente.
//
// LOS TEXTOS VAN COMO PARÁMETROS DE `coordinador_alerta` ({{1}} título · {{2}} cliente · {{3}}
// referencia · {{4}} detalle): una línea cada uno, nunca vacíos (`paramMeta`), sin un dato de la
// empresa escrito aquí. El nombre del cliente lo escribió él en su perfil: se recorta y va en una
// línea, y el texto es para el equipo, no para el cliente.
//
// Umbrales: el de la tarjeta (minutos u horas) y el margen M de Ajustes de traslados. Los únicos
// números de este módulo son `DIAS_DEVOLUCION_LEIDOS` y los topes de longitud, NO MEDIDOS.
// Matriz: npx tsx scripts/prueba-reserva-alertas.mts
// ──────────────────────────────────────────────────────────────────────────────

import { fechaLima, limaAUtcMs, minutoDelDiaLima, minutosAHhmm, textoDuracion } from "../alertas-horario";
import { paramMeta } from "../servicio-abandonado";
import { normalizarMoneda, type Moneda } from "../cotizacion-moneda";
import { dinero, dineroDeSolicitud, devolucionDecidida, fmtPct, type PagoSolicitud } from "./reserva-pago";
import { enlaceConversacion } from "./reserva-correo";

export const CLAVE_SIN_CONFIRMAR = "reserva_sin_confirmar";
export const CLAVE_DEVOLUCION = "devolucion_pendiente";

/** Los estados que esperan a un EJECUTIVO (confirmar la unidad / verificar el pago). */
export const ESTADOS_SIN_CONFIRMAR = ["por_confirmar", "pago_reportado"] as const;
/** Los estados que pueden deberle plata al cliente. */
export const ESTADOS_DEVOLUCION = ["sin_unidad", "cancelada"] as const;

/**
 * Cuántos días hacia atrás se leen las solicitudes ya cerradas para buscar devoluciones pendientes
 * (por `actualizada_en`). NO MEDIDO: el aviso sale una sola vez a las `umbral` horas (48 por
 * defecto), así que pasado un mes ya salió hace rato; solo acota lo que el tick relee cada 10 min.
 */
export const DIAS_DEVOLUCION_LEIDOS = 30;

const MIN_MS = 60_000;
const TOL = 0.005; // medio céntimo: la misma de `queFalta`

// ── Lo que el lector le entrega al motor ─────────────────────────────────────

export type SolicitudAlerta = {
  id: number;
  estado: string;
  cotizacion_id: number;
  crm_conversacion_id?: string | null;
  crm_accion_id?: string | null;
  confirmar_antes_de?: string | null;
  urgente?: boolean | null;
  devolucion_pct?: number | string | null;
  reserva_id?: number | null;
  cancelacion_pedida_en?: string | null;
  cerrada_en?: string | null;
  actualizada_en?: string | null;
  creada_en?: string | null;
  nota?: string | null;
};

export type CotizacionAlerta = {
  id: number;
  numero_cotizacion?: string | null;
  fecha_servicio?: string | null;
  hora_ida?: string | null;
  moneda?: string | null;
  /** `traslado_json.validez_hasta` (ISO), o null. */
  validez_hasta?: string | null;
  /** El nombre que se le enseña al equipo: el cliente del ERP, o la «atención» de la cotización. */
  cliente?: string | null;
};

export type HechosSolicitud = {
  solicitud: SolicitudAlerta;
  /** null = la cotización no se pudo leer (o ya no existe). */
  cotizacion: CotizacionAlerta | null;
  /** null = los pagos no se pudieron leer. [] = no tiene ninguno (o no existe la columna de 09c). */
  pagos: readonly (PagoSolicitud & { reserva_solicitud_id?: number | null })[] | null;
  /** null = no se pudieron leer. 0 = ninguno (o no existe la tabla de 09b). */
  comprobantes: number | null;
};

// ── Utilidades ───────────────────────────────────────────────────────────────

const msDe = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const esFechaIso = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && s.length >= 10;
const hora5 = (h: unknown): string | null => (/^\d{1,2}:\d{2}/.test(String(h ?? "")) ? String(h).slice(0, 5).padStart(5, "0") : null);
/** Recorta por caracteres completos (un emoji partido rompe el parámetro). */
const recortar = (s: string, max: number): string => { const a = Array.from(s); return a.length > max ? a.slice(0, max - 1).join("") + "…" : s; };
/** Un parámetro de Meta: una línea, sin 4 espacios seguidos, nunca vacío, con tope. */
const param = (s: string | null | undefined, max: number, vacio = "-"): string => recortar(paramMeta(s, vacio), max);

/** Inicio del servicio en ms UTC (fecha + hora de ida, hora de Lima). null sin fecha o sin hora. */
export function inicioServicioMs(c: Pick<CotizacionAlerta, "fecha_servicio" | "hora_ida"> | null | undefined): number | null {
  if (!c || !esFechaIso(c.fecha_servicio)) return null;
  const h = hora5(c.hora_ida);
  if (!h) return null;
  return limaAUtcMs(c.fecha_servicio!.slice(0, 10), h);
}

/** «25/12/2026 15:00», «25/12/2026» o «sin fecha». */
export function fechaHoraServicio(c: Pick<CotizacionAlerta, "fecha_servicio" | "hora_ida"> | null | undefined): string {
  if (!c || !esFechaIso(c.fecha_servicio)) return "sin fecha";
  const f = c.fecha_servicio!.slice(0, 10);
  const d = `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
  const h = hora5(c.hora_ida);
  return h ? `${d} ${h}` : d;
}

const instanteCorto = (ms: number) => { const f = fechaLima(ms); return `${f.slice(8, 10)}/${f.slice(5, 7)} ${minutosAHhmm(minutoDelDiaLima(ms))}`; };

/** Una duración para el equipo: «35 min», «2 h 10 min», «3 días y 4 h». */
export function duracionLarga(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 1440) return textoDuracion(m);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  const dias = d === 1 ? "1 día" : `${d} días`;
  return h ? `${dias} y ${h} h` : dias;
}

/**
 * La fecha con que se RECLAMA el envío en `alerta_enviada` (cuya unicidad es clave + ref + fecha):
 * la del día en que nació la solicitud, fija. Con la de hoy (el defecto de `reclamarEnvio`) el mismo
 * aviso volvería a salir cada día mientras la solicitud siga igual.
 */
export function fechaReclamo(s: Pick<SolicitudAlerta, "creada_en">, hoy: string): string {
  const t = msDe(s.creada_en);
  return t == null ? hoy : fechaLima(t);
}

/** «202610221530»: el plazo en hora de Lima, al minuto (para la ref del primer aviso). */
const sello = (ms: number) => `${fechaLima(ms).replace(/-/g, "")}${minutosAHhmm(minutoDelDiaLima(ms)).replace(":", "")}`;

const referencia = (c: CotizacionAlerta | null, cotizacionId: number) => {
  const n = String(c?.numero_cotizacion ?? "").replace(/\s+/g, " ").trim();
  return `Cotización ${n ? `N° ${n}` : `id ${cotizacionId}`} · servicio ${fechaHoraServicio(c)}`;
};
const nombreCliente = (c: CotizacionAlerta | null) => c?.cliente ?? null;

// ── 1. Sin confirmar ─────────────────────────────────────────────────────────

export type CodigoSinConfirmar =
  /** No espera a un ejecutivo (otro estado). */
  | "no_aplica"
  /** Tiene plazo y todavía no vence (ni es urgente ni el servicio está cerca). */
  | "en_plazo"
  /** Sin plazo, sin urgencia y con el servicio lejos (o sin hora): no hay con qué juzgar. */
  | "sin_plazo"
  /** El primer aviso: venció el plazo (+ umbral) o nació urgente. */
  | "aviso"
  /** El escalón: el servicio queda a menos de la mitad del margen (o ya empezó). */
  | "margen";

export type DecisionSinConfirmar = {
  codigo: CodigoSinConfirmar;
  /** La ref que se reclama primero; si ya estaba reclamada, ese aviso ya salió. null si no avisa. */
  ref: string | null;
  /** Refs que se reclaman además (el primer aviso, cuando sale el escalón). */
  refsExtra: string[];
  vencida: boolean;
  urgente: boolean;
  plazoMs: number | null;
  inicioMs: number | null;
};

export function juzgarSinConfirmar(h: HechosSolicitud, x: { ahoraMs: number; umbralMin: number; margenMin: number }): DecisionSinConfirmar {
  const s = h.solicitud;
  const plazoMs = msDe(s.confirmar_antes_de);
  const inicioMs = inicioServicioMs(h.cotizacion);
  const urgente = s.urgente === true;
  const base = { refsExtra: [] as string[], urgente, plazoMs, inicioMs };
  if (!(ESTADOS_SIN_CONFIRMAR as readonly string[]).includes(s.estado)) return { codigo: "no_aplica", ref: null, vencida: false, ...base };
  const umbral = Math.max(0, Number.isFinite(x.umbralMin) ? x.umbralMin : 0);
  const vencida = plazoMs != null && x.ahoraMs >= plazoMs + umbral * MIN_MS;
  const refAviso = `sol:${s.id}:aviso:${plazoMs != null ? sello(plazoMs) : "sin_plazo"}`;
  const M = Math.max(0, Number.isFinite(x.margenMin) ? x.margenMin : 0);
  const cerca = inicioMs != null && inicioMs - x.ahoraMs < (M / 2) * MIN_MS;
  if (cerca) {
    return { codigo: "margen", ref: `sol:${s.id}:margen`, vencida, ...base, refsExtra: vencida || urgente ? [refAviso] : [] };
  }
  if (vencida || urgente) return { codigo: "aviso", ref: refAviso, vencida, ...base };
  return { codigo: plazoMs != null ? "en_plazo" : "sin_plazo", ref: null, vencida, ...base };
}

/** Los cuatro parámetros de `coordinador_alerta` del aviso «sin confirmar». */
export function paramsSinConfirmar(h: HechosSolicitud, d: DecisionSinConfirmar, x: { ahoraMs: number; appUrl?: string | null }): string[] {
  const s = h.solicitud;
  const yaEmpezo = d.inicioMs != null && d.inicioMs <= x.ahoraMs;
  const titulo = d.codigo === "margen"
    ? (yaEmpezo ? "Reserva sin confirmar: la hora del servicio ya pasó" : "Reserva sin confirmar a poco del servicio")
    : d.vencida ? "Reserva de traslado sin confirmar" : "Reserva de traslado urgente";

  const partes: string[] = [];
  if (String(s.cancelacion_pedida_en ?? "").trim()) partes.push("El cliente pidió cancelar: falta resolver cuánto se le devuelve");
  else if (s.estado === "pago_reportado") partes.push("El cliente reportó su pago, pendiente de verificar en el banco; falta confirmar la unidad");
  else partes.push("Falta confirmar si hay una unidad disponible");

  if (d.vencida && d.plazoMs != null) partes.push(`El plazo para confirmar venció hace ${duracionLarga((x.ahoraMs - d.plazoMs) / MIN_MS)} (${instanteCorto(d.plazoMs)})`);
  else if (d.urgente) partes.push(d.plazoMs != null ? `Urgente: confirmar antes de ${instanteCorto(d.plazoMs)}` : "Urgente: no alcanza el plazo normal de confirmación");
  else if (d.plazoMs != null) partes.push(`Plazo para confirmar: ${instanteCorto(d.plazoMs)}`);
  else partes.push("Sin plazo de confirmación (no hay horario de atención declarado)");

  if (d.inicioMs != null) {
    partes.push(yaEmpezo
      ? `La hora del servicio pasó hace ${duracionLarga((x.ahoraMs - d.inicioMs) / MIN_MS)}`
      : `Faltan ${duracionLarga((d.inicioMs - x.ahoraMs) / MIN_MS)} para el servicio`);
  }
  const enlace = enlaceConversacion(x.appUrl, s.crm_conversacion_id);
  partes.push(enlace ? `Atiéndela en ${enlace}` : "Atiéndela en el CRM (tarjeta de la reserva)");
  return [
    param(titulo, 70),
    param(nombreCliente(h.cotizacion), 60, "Cliente sin nombre"),
    param(referencia(h.cotizacion, s.cotizacion_id), 90),
    param(`${partes.join(". ")}.`, 520),
  ];
}

// ── 2. Devolución pendiente ──────────────────────────────────────────────────

export type CodigoDevolucion =
  | "no_aplica"
  /** Cancelada sin un % decidido: falta resolverla (es de la tarjeta del CRM, no de Tesorería). */
  | "sin_decidir"
  /** No hay nada que devolver (0 % o nada cobrado). */
  | "sin_devolucion"
  /** No se pudo leer la cotización o los pagos: no se afirma nada. */
  | "sin_lectura"
  | "saldada"
  /** Falta devolver, pero todavía no pasan las horas del umbral. */
  | "en_espera"
  | "pendiente";

export type DecisionDevolucion = {
  codigo: CodigoDevolucion;
  ref: string | null;
  moneda: Moneda;
  pct: number | null;
  cobrado: number;
  devuelto: number;
  aDevolver: number;
  falta: number;
  /** Desde cuándo está acordada (cerrada_en, o actualizada_en / creada_en de respaldo). */
  desdeMs: number | null;
};

export function juzgarDevolucion(h: HechosSolicitud, x: { ahoraMs: number; umbralH: number }): DecisionDevolucion {
  const s = h.solicitud;
  const moneda = normalizarMoneda(h.cotizacion?.moneda);
  const vacio = { moneda, cobrado: 0, devuelto: 0, aDevolver: 0, falta: 0, desdeMs: null as number | null };
  if (!(ESTADOS_DEVOLUCION as readonly string[]).includes(s.estado)) return { codigo: "no_aplica", ref: null, pct: null, ...vacio };
  // La MISMA lectura del porcentaje que `queFalta`: sin unidad es el 100 %, siempre.
  const pct = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
  if (pct == null) return { codigo: "sin_decidir", ref: null, pct: null, ...vacio };
  if (!(pct > 0)) return { codigo: "sin_devolucion", ref: null, pct, ...vacio };
  if (!h.cotizacion || h.pagos == null) return { codigo: "sin_lectura", ref: null, pct, ...vacio };
  const { cobrado, devuelto } = dineroDeSolicitud(h.pagos, moneda);
  const aDevolver = devolucionDecidida(cobrado, pct);
  const falta = Math.max(0, Math.round((aDevolver - devuelto) * 100) / 100);
  const desdeMs = msDe(s.cerrada_en) ?? msDe(s.actualizada_en) ?? msDe(s.creada_en);
  const datos = { moneda, pct, cobrado, devuelto, aDevolver, falta, desdeMs };
  if (!(aDevolver > 0)) return { codigo: "sin_devolucion", ref: null, ...datos };
  if (devuelto + TOL >= aDevolver) return { codigo: "saldada", ref: null, ...datos };
  const umbral = Math.max(0, Number.isFinite(x.umbralH) ? x.umbralH : 0);
  // Sin ninguna fecha (no debería pasar: actualizada_en es NOT NULL) se avisa: es plata del cliente.
  if (desdeMs != null && x.ahoraMs < desdeMs + umbral * 60 * MIN_MS) return { codigo: "en_espera", ref: null, ...datos };
  return { codigo: "pendiente", ref: `sol:${s.id}:devolucion`, ...datos };
}

/** El enlace a Tesorería (pestaña de adelantos de reservas), con la misma validación del de /crm. */
export function enlaceTesoreria(appUrl: string | null | undefined): string | null {
  const base = String(appUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s"'<>]+$/i.test(base) ? `${base}/tesoreria?tab=adelantos` : null;
}

export function paramsDevolucion(h: HechosSolicitud, d: DecisionDevolucion, x: { ahoraMs: number; appUrl?: string | null }): string[] {
  const s = h.solicitud;
  const partes: string[] = [];
  partes.push(s.estado === "sin_unidad"
    ? `No hubo unidad: se acordó devolver el ${fmtPct(d.pct ?? 100)} % de lo cobrado (${dinero(d.aDevolver, d.moneda)})`
    : `Reserva cancelada: se acordó devolver el ${fmtPct(d.pct ?? 0)} % de lo cobrado (${dinero(d.aDevolver, d.moneda)})`);
  partes.push(`Devuelto: ${dinero(d.devuelto, d.moneda)}; falta ${dinero(d.falta, d.moneda)}`);
  if (d.desdeMs != null) partes.push(`Se acordó hace ${duracionLarga((x.ahoraMs - d.desdeMs) / MIN_MS)} (${instanteCorto(d.desdeMs)})`);
  const enlace = enlaceTesoreria(x.appUrl);
  partes.push(enlace ? `Transfiérela y regístrala como devolución en ${enlace}` : "Transfiérela y regístrala como devolución en Tesorería");
  return [
    param("Devolución de reserva pendiente", 70),
    param(nombreCliente(h.cotizacion), 60, "Cliente sin nombre"),
    param(referencia(h.cotizacion, s.cotizacion_id), 90),
    param(`${partes.join(". ")}.`, 520),
  ];
}

// ── 3. El auto-vencimiento ───────────────────────────────────────────────────

export type MotivoVencida = "cotizacion_vencida" | "servicio_pasado";

export type CodigoVencimiento =
  | "no_aplica"
  /** Ni venció la cotización ni pasó el servicio. */
  | "vigente"
  /** No se pudo leer la cotización, los pagos o los comprobantes: no se cierra. */
  | "sin_lectura"
  /** Hay un pago o un comprobante registrado: lo resuelve una persona, nunca el tick. */
  | "con_dinero"
  /** Ya tiene una reserva en Programación (no debería, en «esperando pago»): no se toca. */
  | "con_reserva"
  | "vencer";

export type DecisionVencimiento = { codigo: CodigoVencimiento; motivos: MotivoVencida[] };

export function juzgarVencimiento(h: HechosSolicitud, x: { ahoraMs: number; hoy: string }): DecisionVencimiento {
  const s = h.solicitud;
  if (s.estado !== "esperando_pago") return { codigo: "no_aplica", motivos: [] };
  const c = h.cotizacion;
  if (!c) return { codigo: "sin_lectura", motivos: [] };
  const motivos: MotivoVencida[] = [];
  if (esFechaIso(c.validez_hasta) && c.validez_hasta!.slice(0, 10) < x.hoy) motivos.push("cotizacion_vencida");
  const inicio = inicioServicioMs(c);
  const fecha = esFechaIso(c.fecha_servicio) ? c.fecha_servicio!.slice(0, 10) : null;
  // Sin hora, solo se da por pasado el servicio de un día ANTERIOR (el lado seguro: no se cierra de más).
  if ((inicio != null && inicio <= x.ahoraMs) || (inicio == null && fecha != null && fecha < x.hoy)) motivos.push("servicio_pasado");
  if (!motivos.length) return { codigo: "vigente", motivos };
  if (h.pagos == null || h.comprobantes == null) return { codigo: "sin_lectura", motivos };
  if (h.pagos.some((p) => p && p.anulado !== true) || h.comprobantes > 0) return { codigo: "con_dinero", motivos };
  if (s.reserva_id != null) return { codigo: "con_reserva", motivos };
  return { codigo: "vencer", motivos };
}

/** La nota del cierre automático: para la solicitud, la tarjeta del CRM y la nota interna del chat. */
export function notaVencida(h: HechosSolicitud, motivos: readonly MotivoVencida[]): string {
  const c = h.cotizacion;
  const n = String(c?.numero_cotizacion ?? "").replace(/\s+/g, " ").trim();
  const cot = n ? `la cotización N° ${n}` : "la cotización";
  const porque: string[] = [];
  if (motivos.includes("cotizacion_vencida") && esFechaIso(c?.validez_hasta)) {
    const v = c!.validez_hasta!.slice(0, 10);
    porque.push(`${cot} venció el ${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`);
  } else if (motivos.includes("cotizacion_vencida")) porque.push(`${cot} venció`);
  if (motivos.includes("servicio_pasado")) porque.push(`la hora del servicio (${fechaHoraServicio(c)}) ya pasó`);
  return `⏰ Solicitud de reserva cerrada sola (vencida): ${porque.join(" y ")}. Esperaba el adelanto del cliente y no hubo ningún pago ni comprobante. No se le escribió al cliente.`;
}

/** La nota de la solicitud con la del cierre agregada, sin pasar los 2000 caracteres del CHECK. */
export function notaConCierre(previa: string | null | undefined, cierre: string): string {
  const p = String(previa ?? "").trim();
  const t = p ? `${p}\n${cierre}` : cierre;
  return Array.from(t).slice(-2000).join("");
}
