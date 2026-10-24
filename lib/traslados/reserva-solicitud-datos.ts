// ══════════════════════════════════════════════════════════════════════════════
// lib/traslados/reserva-solicitud-datos.ts — LA RESERVA DE UN TRASLADO QUE COTIZÓ LA IA, contra la
// base. SOLO SERVIDOR (service-role): el cliente de Supabase llega por parámetro y no se crea ninguno
// al importarse. Conecta los motores puros (reserva-orden, reserva-pago, comprobante-pago,
// reserva-ia, reserva-correo, cotizacion-a-reserva) sin reescribir su lógica.
//
// QUIÉN LLAMA:
//  · el agente IA del CRM (lib/crm-ia.ts): `reservarTrasladoIA`, `reportarPagoIA`, `politicasIA`,
//    `cancelarIA` — devuelven `ResultadoReservaIA` (lista blanca para el modelo + el texto que el
//    CÓDIGO le manda al cliente);
//  · la tarjeta del inbox (app/api/crm/reservas-traslado): `confirmarDisponibilidad`, `sinUnidad`,
//    `pedirComprobante`, `registrarComprobanteTarjeta`, `verComprobante`, `resolverCancelacion`,
//    `cerrarSolicitud`, `vincularCliente`, `enviarConfirmacionReserva`, `marcarConfirmacionEnviada`;
//  · Tesorería (app/api/reservas/solicitudes, o la tarjeta con el módulo): `registrarAdelantoSolicitud`,
//    `marcarPagoNoEncontrado`, `registrarDevolucionSolicitud`, `listaParaTesoreria`.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. NINGÚN DINERO SE ESCRIBE AQUÍ QUE NO SEA UN `pagos`: el precio vive en `cotizaciones`, el
//     adelanto se deriva (`adelantoDe`), lo cobrado y lo devuelto se suman de `pagos` (cobro / pago,
//     siempre con `reserva_solicitud_id`). Un comprobante del chat es EVIDENCIA y nunca un cobro: el
//     adelanto lo registra una persona de Tesorería al ver el dinero en el banco.
//  2. TODO CAMBIO DE ESTADO ES UN UPDATE CONDICIONAL al estado que se leyó (dos clics a la vez no
//     hacen dos cosas), y respeta `TRANSICIONES`.
//  3. EL NÚMERO DEL CLIENTE Y LA CONVERSACIÓN LOS FIJA EL SERVIDOR: la tarjeta manda ids y aquí se
//     comprueba que conversación ↔ acción ↔ solicitud ↔ cotización coincidan (`cargarCadena`).
//  4. UNA LECTURA QUE FALLA NO ES «NO HAY»: un conteo que no se pudo leer bloquea (topes), una lista
//     de comprobantes que no se pudo leer no se toma por vacía, y lo que no se puede comprobar deriva.
//  5. FUERA DE LA VENTANA DE 24 H NO SE INTENTA ESCRIBIR: se hace lo del ERP y se devuelve el texto
//     con su enlace wa.me (`fuera_de_ventana`).
//  6. LOS DATOS DEL CLIENTE SOLO VAN AL CHAT DE UN CLIENTE VERIFICADO (la regla del PDF,
//     `clienteVerificadoEnChat`: vinculado al contacto o con su número completo como wa_id): la
//     Confirmación de Reserva por WhatsApp y el crédito. «Vincular cliente» ata el contacto solo si
//     el número coincide (`vinculoContactoReserva`).
//  7. EL COMPROBANTE ES UN ARCHIVO QUE LLEGÓ POR META (`meta_message_id`) Y VIVE EN `crm-media`: lo
//     demás no se lee, no se firma ni se adjunta; el adjunto del correo se reconoce por sus bytes.
//     «Cuenta como pago reportado» se decide en un solo sitio (`comprobanteCuenta`).
//  8. UN ERROR DE LA BASE NO SE ENSEÑA: va al log y el usuario del ERP recibe qué falló
//     (`seguro`/`crudo` sobre `mensajeSeguro`, lib/mensaje-seguro.ts).
//  9. EL IDIOMA DE LOS MENSAJES ES EL DE LA COTIZACIÓN (`idioma_pdf`, escrito al crearla por la IA):
//     T1–T11, los que manda una persona desde la tarjeta y el caption de la Confirmación lo leen de
//     ahí (`vozDe`); NADA vuelve a detectar el idioma en los mensajes del chat. La huella de las
//     cuentas sale SIEMPRE de las líneas en castellano (`lineasHuella`): con las de inglés («Acct:»)
//     cambiaría con el idioma y el reenvío del pedido de pago diría `cuentas_cambiaron`. Lo que
//     escribió una persona en castellano no se traduce: el resumen de la política no va en un T1/T4 en
//     inglés (queda el enlace) y las políticas en castellano (T8) a un cliente en inglés las ve un
//     ejecutivo.
// 10. UNA COTIZACIÓN QUE UNA PERSONA CORRIGIÓ SE USA SOLO TRAS LA PAUSA DEL EJECUTIVO (decisión del
//     dueño, 24-10-2026; lib/traslados/cotizacion-corregida.ts): el pedido del adelanto (T1, que pasa a
//     «disponibilidad primero» con `cotizacion_corregida`), su reenvío, las políticas (T8) y el adelanto
//     que nombra T3 salen de la fila; si su huella no es la de la IA y la última corrección de una
//     persona (`editada_at`) es de hace menos de `pausa_humano_horas` —sin una reactivación posterior—,
//     la IA no la manda: T12 y una nota, SIN derivar (derivar pausa la IA para siempre).
// Matriz de punta a punta: ANTHROPIC_API_KEY=x npx tsx scripts/prueba-reserva-ia.mts
// ══════════════════════════════════════════════════════════════════════════════

import { createHash, randomUUID } from "node:crypto";
import { faltaColumna, tablaFaltante } from "../columna-faltante";
import { fechaLima, limaAUtcMs } from "../alertas-horario";
import { normalizarAjustes, estiloDe, type EstiloMensajes } from "../crm-ia-ajustes";
import { atencionDe, atencionEnUso, type Atencion } from "../crm-ia-atencion";
import { leerPlantillasYReglas } from "../cotizacion-plantillas-datos";
import { CELDAS_TRASLADO, excesoCondiciones, plantillaParaUso, plantillaTrasladoIA, segmentoDeCliente, SEGMENTOS, type PlantillaFila } from "../cotizacion-plantillas";
import { mensajeSeguro } from "../mensaje-seguro";
import { normalizarMoneda, type Moneda } from "../cotizacion-moneda";
import { normalizarIdioma as idiomaDeFila, type Idioma } from "../cotizacion-idioma";
import { enlaceCondiciones, numeroCotizacion } from "../cotizacion-corporativo";
import type { PlantillaPdfCfg } from "../cotizacion-pdf";
import type { PerfilEmpresa } from "../empresa-perfil";
import { baseSupabase, objetoPrivadoDe } from "../storage-privado";
import { BUCKET_CRM_MEDIA, asegurarBucket as asegurarBucketCrm } from "../crm-media";
import { enviarWhatsAppMedia, explicarErrorEnvioWhatsApp } from "../crm-meta";
import { phonePara as phoneParaUso } from "../whatsapp-numeros";
import { enviarTextoCRM, type ResultadoEnvioTexto } from "../crm-enviar-texto";
import { ejecutarConversion, leerCotParaReserva } from "../cotizacion-a-reserva-datos";
import {
  emitirVersion, enlazarCobrosAReserva, leerEntrada, leerVersiones, pdfDeVersion, registrarAdelanto, registrarDevolucion,
  validarCobro, SQL_PAGOS_SOLICITUD,
} from "../confirmacion-reserva-datos";
import { captionConfirmacion, esCredito, juzgarConfirmacion, normalizarIdioma, type ExtrasConf } from "../confirmacion-reserva";
import {
  cuentasFrenteACorporativo, perfilConfigurado, type CuentasFrente, type FilaCotizacionLeida, type ReferenciaCuentas,
} from "./cotizacion-traslado";
import { leerCotizacionTraslado, leerPerfilPdf, plantillaYReferenciaCuentas } from "./enviar-cotizacion-datos";
import { zonaConEnvio, type ZonaEnvio } from "./envio-ia";
import { condicionesSospechosas } from "./texto-libre";
import {
  MOTIVO_ORDEN, elegibilidadDeReserva, frasePlazo, ordenDeReserva, ordenDeSolicitud, type MotivoOrden, type OrdenReserva,
} from "./reserva-orden";
import {
  adelantoDe, cargoEditable, cargoRetenido, clienteVerificadoEnChat, cuentasEnMensaje, juzgarCargo, mismaReferencia, patchCargoRecalculado, devolucionDecidida, dineroDeSolicitud, esEstadoTerminal,
  filaFacturaCargo, firmaConCuentas, firmaImportes, huellaDeFirma, importesDeFirma, juzgarReenvioPedirPago, marcaCargoReserva,
  mensajeCanceladaSinPago, mensajeCancelacionRegistrada, mensajeCancelacionResuelta, vinculoContactoReserva,
  mensajeComprobanteRecibido, mensajeCotizacionActualizada, mensajeDisponibilidadPrimero, mensajeHayUnidad, mensajePagoNoEncontrado, mensajePedirPago,
  mensajePoliticas, mensajeSinUnidad, politicaContradiceConfig, puedePasar, queFalta,
  type Adelanto, type BloquePago, type CondicionesMensaje, type ConfigReserva, type CuentasMensaje, type EstadoSolicitud, type PagoEnHayUnidad,
  type PagoSolicitud, type Pendiente, type CodigoCargo, type FacturaCargoActual,
} from "./reserva-pago";
import { TEXTO_COTEJO, comprobanteCuenta, cotejarComprobante, normalizarOperacion, type Cotejo, type LecturaComprobante } from "./comprobante-pago";
import { leerComprobantePago, type ResultadoLector } from "./comprobante-pago-ia";
import {
  RE_VUELO, decidirTopeReserva, elegirCotizacion, entradaReserva, estadoReservaIA, mensajePedirComprobante, respuestaReservaParaModelo,
  type AccionReserva, type CotizacionCandidata, type ResultadoReservaIA,
} from "./reserva-ia";
import { adjuntoDeComprobante, correoReserva, destinatariosReserva, type DatosCorreoReserva } from "./reserva-correo";
import { inicioServicioMs } from "./reserva-alertas";
import { leerConfigIA, SQL_RESERVA_TRASLADOS } from "./datos";
import { correccionDeCotizacion, type PausaEjecutivo } from "./cotizacion-corregida-datos";
import { notaEsperaCorreccion, notaSolicitudCorregida, notaUsoCorreccion, type JuicioCorreccion } from "./cotizacion-corregida";
import { horasPausaHumano } from "../crm-ia-reactivacion";
import {
  enlaceWaMe, ventana24h, type AccionDinero, type AccionTarjeta, type CodigoResultadoReserva, type ComprobanteVista,
  type FilaTesoreria, type MotivoCierre, type PagoVista, type ResultadoAccionReserva, type VistaSolicitud,
} from "./reserva-solicitud-tipos";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

// ── 0. Constantes, dependencias y utilidades ─────────────────────────────────

export const TABLA_SOLICITUDES = "reserva_solicitudes";
export const TABLA_COMPROBANTES = "reserva_solicitud_comprobantes";
/** La clave del freno de lecturas de comprobantes en `alerta_enviada` (índice único clave + ref + fecha). */
export const CLAVE_LECTURA_COMPROBANTE = "reserva_ia_comprobante";
/**
 * La clave del correo «comprobante sin cotización que reservar» en `alerta_enviada`: el tope diario
 * y el RECLAMO del archivo (ref `conv:<id>:msg:<mensaje>`): un archivo se avisa una sola vez.
 */
export const CLAVE_CORREO_SIN_COTIZACION = "reserva_ia_pago_sin_cotizacion";
/** El tipo de la tarjeta del inbox. */
export const TIPO_ACCION_RESERVA = "reserva_traslado";

/** Los estados de una solicitud viva (los del índice único `uq_reserva_solicitudes_viva`). */
export const ESTADOS_VIVOS: readonly EstadoSolicitud[] = ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada"];
const ESTADOS_ABIERTOS_SIN_UNIDAD: readonly EstadoSolicitud[] = ["esperando_pago", "por_confirmar", "pago_reportado"];

/** Los tipos de mensaje que pueden ser un comprobante (los que lee el agente). */
const TIPOS_ARCHIVO = ["image", "document", "imagen"];
/** Sin solicitud ni cotización: cuánto atrás se busca la foto del comprobante. NO medido. */
const VENTANA_SIN_COTIZACION_MS = 48 * 3_600_000;
/** El enlace firmado del PDF que baja Meta (s). */
const TTL_URL_META = 3600;
/** El enlace firmado para que el ejecutivo vea un comprobante (s): lo justo para abrirlo. */
const TTL_URL_VER = 600;

const COLS_SOLICITUD =
  "id, cotizacion_id, crm_conversacion_id, crm_accion_id, estado, orden, motivos_orden, adelanto_pct, firma_importes, " +
  "confirmar_antes_de, urgente, nombre_pasajero, vuelo, cliente_acepto_en, acepto_mensaje_id, disponibilidad_en, disponibilidad_por, " +
  "reserva_id, cancelacion_pedida_en, devolucion_pct, factura_cargo_id, cierre_motivo, cerrada_en, cerrada_por, nota, creada_en, actualizada_en";

export type FilaSolicitud = {
  id: number; cotizacion_id: number; crm_conversacion_id: string | null; crm_accion_id: string | null;
  estado: EstadoSolicitud; orden: "pago_primero" | "disponibilidad_primero"; motivos_orden: string[] | null;
  adelanto_pct: number | string | null; firma_importes: string | null; confirmar_antes_de: string | null; urgente: boolean | null;
  nombre_pasajero: string | null; vuelo: string | null; cliente_acepto_en: string | null; acepto_mensaje_id: string | null;
  disponibilidad_en: string | null; disponibilidad_por: string | null; reserva_id: number | null;
  cancelacion_pedida_en: string | null; devolucion_pct: number | string | null; factura_cargo_id: number | null;
  cierre_motivo: string | null; cerrada_en: string | null; cerrada_por: string | null; nota: string | null;
  creada_en: string; actualizada_en: string | null;
};

/** Lo que se reemplaza en la matriz para correr sin red. */
export type DepsReserva = {
  ahoraMs?: () => number;
  azar?: () => string;
  uuid?: () => string;
  leerComprobante?: (sb: Sb, url: string, x: { modelo?: unknown }) => Promise<ResultadoLector>;
  enviarCorreo?: (x: { to: string; subject: string; html: string; attachments?: { filename: string; content?: string }[] }) => Promise<void>;
  enviarTexto?: (sb: Sb, conv: ConvR, contacto: ContactoR, texto: string, opts: { waDestino?: string; generadoPorIa?: boolean; enviadoPor?: string | null }) => Promise<ResultadoEnvioTexto>;
  bajarArchivo?: (sb: Sb, url: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  conversion?: typeof ejecutarConversion;
  pdfConfirmacion?: typeof pdfDeVersion;
  enviarMedia?: typeof enviarWhatsAppMedia;
  asegurarBucket?: (sb: Sb) => Promise<void>;
  phonePara?: (uso: "crm") => Promise<string | undefined>;
  /** `NEXT_PUBLIC_APP_URL` (el enlace del correo). */
  appUrl?: string | null;
};

type ConvR = { id: string; canal: string; phone_number_id?: string | null };
/** El cliente como lo compara `clienteVerificadoEnChat` (solo su teléfono). */
type ClienteChat = { telefono?: string | null };
type ContactoR = { id?: string | null; nombre?: string | null; cliente_id?: number | null; wa_id?: string | null; telefono?: string | null } | null;

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const msDe = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const isoDe = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msg = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "error").slice(0, 300);
const inicioDiaLima = (hoy: string) => `${hoy}T05:00:00.000Z`;
const ahoraDe = (deps: DepsReserva) => deps.ahoraMs?.() ?? Date.now();
const azarDe = (deps: DepsReserva) => deps.azar?.() ?? Math.random().toString(36).slice(2, 10);
const estiloDeAgente = (agente: unknown): EstiloMensajes => estiloDe(normalizarAjustes((agente as { comportamiento?: unknown } | null)?.comportamiento));
/**
 * La voz de los textos de UNA cotización: el trato y el modo de preguntar del agente y el idioma de
 * la cotización (su `idioma_pdf`, ya leído: aquí no se vuelve a detectar nada). En castellano, el
 * estilo de siempre, sin la clave (byte a byte los textos de antes).
 */
const vozDe = (agente: unknown, cc: Pick<ContextoCotizacion, "idioma"> | Idioma | null | undefined): EstiloMensajes => {
  const idioma = typeof cc === "string" ? cc : cc?.idioma;
  const e = estiloDeAgente(agente);
  return idioma === "en" ? { ...e, idioma: "en" } : e;
};
const atencionDeAgente = (agente: unknown): Atencion => atencionDe(normalizarAjustes((agente as { comportamiento?: unknown } | null)?.comportamiento));
const appUrlDe = (deps: DepsReserva) => (deps.appUrl !== undefined ? deps.appUrl : process.env.NEXT_PUBLIC_APP_URL ?? null);
const lineaCorta = (s: unknown, max = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Los mensajes que escribe este módulo (y los que lanzan los lectores que llama) y que se pueden
 * enseñar. Un «No se pudo…: <detalle>» se enseña sin el detalle (`mensajeSeguro` con
 * `cortarDetalle`): el detalle es el texto crudo de la base, que va al log.
 */
const PROPIOS = /^(No se pudo|No se pudieron|Falta\b|La cotización\b|Ese cobro|Otra persona)/;

/**
 * Un error para el usuario del ERP (la tarjeta, Tesorería, una nota interna): lo crudo va al log.
 * `generico`: lo que se enseña si el error no es uno escrito por el módulo (por defecto, el genérico).
 */
function seguro(e: unknown, donde: string, generico?: string): string {
  console.error(`[reserva-traslado] ${donde}:`, (e as { message?: unknown } | null)?.message ?? e);
  return mensajeSeguro(e, { propios: PROPIOS, cortarDetalle: true, generico });
}

/** «contexto: <error de la base>» → «contexto. Vuelve a intentar en un momento.» (el error, al log). */
function crudo(contexto: string, error: unknown): string {
  console.error(`[reserva-traslado] ${contexto}:`, msg(error));
  return mensajeSeguro(`${contexto}: ${msg(error)}`, { propios: PROPIOS, cortarDetalle: true });
}

/**
 * La huella de las cuentas que se le mandan al cliente (las líneas EXACTAS del mensaje): sha256
 * corto. Se guarda en `firma_importes` (`firmaConCuentas`) para no reenviarle otras. null sin líneas.
 */
export function huellaCuentas(lineas: readonly string[] | null | undefined): string | null {
  const ls = (lineas ?? []).map((l) => String(l ?? "")).filter((l) => l.trim());
  return ls.length ? createHash("sha256").update(JSON.stringify(ls)).digest("hex").slice(0, 16) : null;
}

const res = (codigo: CodigoResultadoReserva, detalle: string, extra: Partial<ResultadoAccionReserva> = {}): ResultadoAccionReserva =>
  ({ ok: codigo === "ok" || codigo === "fuera_de_ventana", codigo, detalle, ...extra });

async function nota(sb: Sb, convId: string | null | undefined, texto: string, autor = "Sistema"): Promise<void> {
  if (!convId) return;
  try { await sb.from("crm_notas").insert({ conversacion_id: convId, texto: texto.slice(0, 3000), autor_nombre: autor }); } catch { /* sin crm_notas */ }
}

async function enviarCorreoPorDefecto(x: { to: string; subject: string; html: string; attachments?: { filename: string; content?: string }[] }): Promise<void> {
  // lib/notificaciones crea su cliente al importarse: se importa SOLO al enviar.
  const { enviarEmail } = await import("../notificaciones");
  await enviarEmail(x);
}

/** El objeto de `crm-media` (donde el webhook guarda lo que manda el cliente) al que apunta un enlace; null si es de otro sitio. */
const objetoCrmMedia = (url: unknown) => {
  const obj = objetoPrivadoDe(url, baseSupabase());
  return obj && obj.bucket === BUCKET_CRM_MEDIA ? obj : null;
};

async function bajarArchivoPorDefecto(sb: Sb, url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const obj = objetoCrmMedia(url);
  if (!obj) return null;
  try {
    const { data, error } = await sb.storage.from(obj.bucket).download(obj.ruta);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { bytes, mime: String(data.type || "application/octet-stream").split(";")[0] };
  } catch { return null; }
}

// ── 1. Lecturas ──────────────────────────────────────────────────────────────

/** La solicitud, o null si no existe. LANZA si no se puede leer (con `sinMigracion` si falta la tabla). */
export async function leerSolicitud(sb: Sb, id: number): Promise<FilaSolicitud | null> {
  const { data, error } = await sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).eq("id", id).maybeSingle();
  if (error) {
    if (tablaFaltante(error, TABLA_SOLICITUDES)) throw Object.assign(new Error(`Falta correr ${SQL_RESERVA_TRASLADOS.solicitudes}.`), { sinMigracion: true });
    throw new Error(`No se pudo leer la solicitud de reserva: ${error.message}`);
  }
  return (data ?? null) as FilaSolicitud | null;
}

/** El último mensaje del cliente en la conversación (id y hora), o null. LANZA si no se puede leer. */
async function ultimoEntrante(sb: Sb, convId: string): Promise<{ id: string; created_at: string } | null> {
  const { data, error } = await sb.from("crm_mensajes").select("id, created_at").eq("conversacion_id", convId)
    .eq("direccion", "entrante").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`No se pudo leer el último mensaje del cliente: ${error.message}`);
  return (data ?? null) as { id: string; created_at: string } | null;
}

/** Los pagos (cobros y devoluciones) de una solicitud: los que la llevan y los cobros de su reserva. LANZA. */
async function pagosDeSolicitud(sb: Sb, s: Pick<FilaSolicitud, "id">, tramos: number[]): Promise<(PagoSolicitud & PagoVista)[]> {
  const cols = "id, codigo, sentido, fecha, monto, moneda, metodo, referencia, anulado";
  const a = await sb.from("pagos").select(cols).eq("reserva_solicitud_id", s.id).order("id", { ascending: true }).limit(200);
  if (a.error && !faltaColumna(a.error, "reserva_solicitud_id")) throw new Error(`No se pudieron leer los pagos de la solicitud: ${a.error.message}`);
  const filas = new Map<number, Record<string, unknown>>();
  for (const p of (a.error ? [] : a.data ?? []) as Record<string, unknown>[]) filas.set(Number(p.id), p);
  if (tramos.length) {
    // Un cobro registrado por la Confirmación antes de que la solicitud tuviera reserva lleva solo `reserva_id`.
    const b = await sb.from("pagos").select(cols).in("reserva_id", tramos).eq("sentido", "cobro").order("id", { ascending: true }).limit(200);
    if (b.error && !faltaColumna(b.error, "reserva_id")) throw new Error(`No se pudieron leer los cobros de la reserva: ${b.error.message}`);
    for (const p of (b.error ? [] : b.data ?? []) as Record<string, unknown>[]) filas.set(Number(p.id), p);
  }
  return [...filas.values()].sort((x, y) => Number(x.id) - Number(y.id)).map((p) => ({
    id: Number(p.id), codigo: (p.codigo as string) ?? null, sentido: p.sentido === "pago" ? "pago" : "cobro",
    fecha: (p.fecha as string) ?? null, monto: Number(p.monto) || 0, moneda: String(p.moneda ?? "PEN"),
    metodo: (p.metodo as string) ?? null, referencia: (p.referencia as string) ?? null, anulado: p.anulado === true,
  }));
}

type FilaComprobante = {
  id: number; solicitud_id: number; mensaje_id: string | null; lectura: LecturaComprobante | null; cotejo: string[] | null;
  operacion_norm: string | null; correo_en: string | null; correo_error: string | null; leido_en: string | null; creado_en: string;
};

/** Los comprobantes de la solicitud, del más nuevo al más viejo. LANZA (una lista que falla no es «ninguno»). */
async function comprobantesDe(sb: Sb, solicitudId: number): Promise<FilaComprobante[]> {
  const { data, error } = await sb.from(TABLA_COMPROBANTES)
    .select("id, solicitud_id, mensaje_id, lectura, cotejo, operacion_norm, correo_en, correo_error, leido_en, creado_en")
    .eq("solicitud_id", solicitudId).order("creado_en", { ascending: false }).limit(50);
  if (error) throw new Error(`No se pudieron leer los comprobantes de la solicitud: ${error.message}`);
  return (data ?? []) as FilaComprobante[];
}

type ReservaTramo = { id: number; estado: string | null; cliente_id: number | null; reserva_vinculada_id: number | null };

/** Los tramos (reservas) de la cotización. LANZA. */
async function tramosDeCotizacion(sb: Sb, cotId: number): Promise<ReservaTramo[]> {
  const { data, error } = await sb.from("reservas").select("id, estado, cliente_id, reserva_vinculada_id").eq("cotizacion_id", cotId)
    .order("id", { ascending: true }).limit(20);
  if (error) throw new Error(`No se pudieron leer las reservas de la cotización: ${error.message}`);
  return (data ?? []) as ReservaTramo[];
}

/** La reserva de la solicitud como la lee `queFalta`: la ida, «cancelada» solo si TODOS sus tramos lo están. */
function reservaParaQueFalta(s: Pick<FilaSolicitud, "reserva_id">, tramos: ReservaTramo[]): { id: number; estado: string; cliente_id: number | null } | null {
  if (!tramos.length) return null;
  const vivos = tramos.filter((t) => t.estado !== "cancelada");
  const ida = tramos.find((t) => t.id === s.reserva_id) ?? tramos[0];
  const estado = vivos.length ? String((vivos.find((t) => t.id === ida.id) ?? vivos[0]).estado ?? "pendiente") : "cancelada";
  return { id: ida.id, estado, cliente_id: ida.cliente_id ?? vivos.find((t) => t.cliente_id != null)?.cliente_id ?? null };
}

type AccionFila = { id: string; tipo: string | null; estado: string | null; conversacion_id: string | null; resultado_id: number | null; payload: Record<string, unknown> | null };

async function leerAccion(sb: Sb, id: string | null | undefined): Promise<AccionFila | null> {
  if (!id) return null;
  const { data, error } = await sb.from("crm_acciones_ia").select("id, tipo, estado, conversacion_id, resultado_id, payload").eq("id", id).maybeSingle();
  if (error) throw new Error(`No se pudo leer la tarjeta de la reserva: ${error.message}`);
  return (data ?? null) as AccionFila | null;
}

/** El agente (su estilo, su horario y su modelo). LANZA si no se puede leer. */
export async function leerAgente(sb: Sb): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  if (error) throw new Error(`No se pudo leer el agente IA: ${error.message}`);
  return ((data ?? [])[0] ?? null) as Record<string, unknown> | null;
}

/** Lo que hace falta de la cotización para pedir el pago: importes, cuentas, política, zonas y crédito. */
export type ContextoCotizacion = {
  fila: FilaCotizacionLeida;
  numero: string;
  moneda: Moneda;
  inicioMs: number | null;
  perfil: PerfilEmpresa | null;
  usada: PlantillaPdfCfg | null;
  referencia: ReferenciaCuentas;
  cuentas: CuentasMensaje;
  frente: CuentasFrente;
  politica: string[];
  /** El resumen de la política (cotizaciones-08), limpio; vacío sin política o sin resumen. */
  resumen: string[];
  /** El idioma de la cotización (`idioma_pdf`; sin la columna, castellano): el de todos sus mensajes. */
  idioma: Idioma;
  /**
   * Las condiciones copiadas están en el idioma de la cotización: siempre en castellano; en inglés,
   * solo si se copiaron de una plantilla en inglés (`consideraciones_json.idioma === "en"`).
   */
  condicionesEnIdioma: boolean;
  /** Una línea de la política O de su resumen trae un enlace o un número de 6+ dígitos. */
  politicaSospechosa: boolean;
  zonaEnvio: boolean;
  credito: boolean;
  cliente: { id: number; nombre: string; ruc: string | null } | null;
};

/** El contexto de la cotización. LANZA si la cotización o el perfil no se pueden leer. */
export async function contextoCotizacion(sb: Sb, cotId: number): Promise<ContextoCotizacion> {
  const fila = await leerCotizacionTraslado(sb, cotId);
  if (!fila) throw new Error(`La cotización ${cotId} ya no existe.`);
  const moneda = normalizarMoneda(fila.moneda);
  const idioma = idiomaDeFila(fila.idioma_pdf);
  const condicionesEnIdioma = idioma !== "en" || (fila.consideraciones_json as { idioma?: unknown } | null | undefined)?.idioma === "en";
  const [{ perfil }, pl] = await Promise.all([leerPerfilPdf(sb), plantillaYReferenciaCuentas(sb, fila.plantilla_pdf)]);
  // Las líneas en el idioma de la cotización; la huella, de `lineasHuella` (siempre en castellano).
  const cuentas = cuentasEnMensaje(pl.usada, perfil, moneda, idioma);
  const frente = cuentasFrenteACorporativo({ plantilla: pl.usada, referencia: pl.referencia, empresa: perfil, moneda });
  const limpia = (l: unknown) => (Array.isArray(l) ? l : []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const politica = limpia(fila.consideraciones_json?.reserva);
  // El resumen solo existe con política (un resumen sin política no resume nada).
  const resumen = politica.length ? limpia(fila.consideraciones_json?.reserva_resumen) : [];
  const politicaSospechosa = condicionesSospechosas({ reserva: politica, reserva_resumen: resumen }).length > 0;
  // Las zonas del traslado: un fallo de lectura es «sin envío automático» (el lado seguro: primero se confirma la unidad).
  let zonaEnvio = false;
  try {
    const tj = fila.traslado_json ?? null;
    const ids = [tj?.zona_origen?.id, tj?.zona_destino?.id].map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) {
      const leer = async (xs: number[]) => {
        const { data, error } = await sb.from("zonas_traslado").select("id, nombre, tipo, padre_id, activo, envio_automatico").in("id", xs);
        if (error) throw error;
        return (data ?? []) as ZonaEnvio[];
      };
      const zonas = await leer(ids);
      const padres = [...new Set(zonas.map((z) => Number(z.padre_id)).filter((n) => Number.isInteger(n) && n > 0 && !ids.includes(n)))];
      const todas = padres.length ? [...zonas, ...(await leer(padres))] : zonas;
      zonaEnvio = zonas.some((z) => zonaConEnvio(z, todas));
    }
  } catch { zonaEnvio = false; }
  // El cliente del ERP de la cotización (crédito y RUC). Sin columna de crédito: no es crédito.
  let cliente: ContextoCotizacion["cliente"] = null;
  let credito = false;
  const cliId = num(fila.cliente_id);
  if (cliId) {
    let r = await sb.from("clientes").select("id, nombre, empresa, ruc, telefono, condicion_pago").eq("id", cliId).maybeSingle();
    if (r.error && faltaColumna(r.error, "condicion_pago")) r = await sb.from("clientes").select("id, nombre, empresa, ruc, telefono").eq("id", cliId).maybeSingle();
    if (r.error) throw new Error(`No se pudo leer el cliente de la cotización: ${r.error.message}`);
    if (r.data) {
      cliente = { id: Number(r.data.id), nombre: String(r.data.empresa || r.data.nombre || "").trim() || `Cliente ${r.data.id}`, ruc: r.data.ruc ?? null };
      credito = esCredito(r.data.condicion_pago);
      // En una cotización del CRM, el crédito se le reconoce solo a un cliente VERIFICADO para ese chat
      // (la regla del PDF: vinculado al contacto o con su número completo como wa_id). Si no, o si no
      // se puede comprobar, se le pide el adelanto: el lado seguro.
      if (credito && fila.crm_conversacion_id) credito = await clienteVerificadoDeConversacion(sb, fila.crm_conversacion_id, Number(r.data.id), r.data);
    }
  }
  return {
    fila, numero: numeroCotizacion(fila), moneda, inicioMs: inicioServicioMs(fila), perfil, usada: pl.usada, referencia: pl.referencia,
    cuentas, frente, politica, resumen, idioma, condicionesEnIdioma, politicaSospechosa, zonaEnvio, credito, cliente,
  };
}

/**
 * El idioma de una cotización (`idioma_pdf`, su fila autoritativa) para los textos que no leen su
 * contexto entero (pedir el comprobante, «no encontramos el pago»). Sin la columna o si no se puede
 * leer, castellano —lo de siempre—: el idioma de una cotización que ya existe no se vuelve a
 * detectar en el chat.
 */
async function idiomaDeCotizacion(sb: Sb, cotId: number): Promise<Idioma> {
  try {
    const { data, error } = await sb.from("cotizaciones").select("id, idioma_pdf").eq("id", cotId).maybeSingle();
    return error ? "es" : idiomaDeFila((data as { idioma_pdf?: unknown } | null)?.idioma_pdf);
  } catch { return "es"; }
}

/**
 * El resumen y el enlace a las condiciones completas de la cotización (`/condiciones/<token>`) que
 * acompañan un pedido de pago (T1, T4) y las políticas (T8). Sin política, con una línea sospechosa
 * (que no se manda), sin el dominio del ERP o sin el token (cotizaciones-08): ni resumen ni enlace, y
 * los textos son los de siempre. Un resumen que no cabe (`excesoCondiciones`) no se manda: queda el enlace.
 * En una cotización en inglés con las condiciones en castellano (`condicionesEnIdioma` false) el
 * resumen tampoco va (sus viñetas están en castellano, y nadie las tradujo): queda solo el enlace.
 */
export function condicionesDeContexto(
  cc: Pick<ContextoCotizacion, "fila" | "politica" | "resumen" | "politicaSospechosa"> & Partial<Pick<ContextoCotizacion, "idioma" | "condicionesEnIdioma">>,
  appUrl: string | null | undefined,
): CondicionesMensaje {
  if (!cc.politica.length || cc.politicaSospechosa) return { resumen: [], enlace: null };
  const enlace = enlaceCondiciones(appUrl, cc.fila.condiciones_token);
  if (!enlace) return { resumen: [], enlace: null };
  const cabe = excesoCondiciones({ reserva_resumen: cc.resumen }).length === 0;
  const enSuIdioma = cc.idioma !== "en" || cc.condicionesEnIdioma === true;
  return { resumen: cabe && enSuIdioma ? cc.resumen : [], enlace };
}

/**
 * ¿El cliente del ERP es quien escribe en esa conversación? (`clienteVerificadoEnChat`, la regla del
 * PDF). false si la conversación o su contacto no se pueden leer: nunca se afirma lo que no se sabe.
 */
async function clienteVerificadoDeConversacion(sb: Sb, convId: string, clienteId: number, cliente: { telefono?: string | null }): Promise<boolean> {
  try {
    const { data, error } = await sb.from("crm_conversaciones").select("id, crm_contactos(wa_id, cliente_id)").eq("id", convId).maybeSingle();
    if (error || !data) return false;
    const ct = Array.isArray(data.crm_contactos) ? data.crm_contactos[0] : data.crm_contactos;
    return clienteVerificadoEnChat(clienteId, cliente, { contactoClienteId: ct?.cliente_id ?? null, waId: ct?.wa_id ?? null });
  } catch { return false; }
}

/** El porcentaje de la solicitud (null = crédito o sin porcentaje). */
const pctDe = (s: Pick<FilaSolicitud, "adelanto_pct">): number | null => {
  const n = num(s.adelanto_pct);
  return n != null && n > 0 && n <= 100 ? n : null;
};
const esCreditoSol = (s: Pick<FilaSolicitud, "motivos_orden">) => (s.motivos_orden ?? []).includes("credito");

// ── 2. Candidatas de una conversación ────────────────────────────────────────

type Candidata = { cand: CotizacionCandidata; enviadaEn: string | null; creadaEn: string | null; viva: FilaSolicitud | null };

/** Las cotizaciones de traslado de la conversación, con si se enviaron y si tienen una solicitud viva. LANZA. */
async function candidatasDeConversacion(sb: Sb, convId: string, ahoraMs: number, hoy: string): Promise<Candidata[]> {
  const { data: cots, error: e1 } = await sb.from("cotizaciones").select("id, numero_cotizacion, estado, created_at, fecha_servicio, hora_ida, traslado_json")
    .eq("crm_conversacion_id", convId).not("traslado_json", "is", null).order("created_at", { ascending: false }).limit(20);
  if (e1) throw new Error(`No se pudieron leer las cotizaciones del chat: ${e1.message}`);
  const lista = ((cots ?? []) as Record<string, unknown>[]).filter((c) => !["rechazado", "rechazada", "anulado", "anulada"].includes(String(c.estado ?? "")));
  if (!lista.length) return [];
  const { data: accs, error: e2 } = await sb.from("crm_acciones_ia").select("id, estado, resultado_id, payload")
    .eq("conversacion_id", convId).eq("tipo", "cotizacion_traslado").eq("estado", "aprobada").limit(50);
  if (e2) throw new Error(`No se pudieron leer las cotizaciones enviadas: ${e2.message}`);
  const enviadas = new Map<number, string | null>();
  for (const a of (accs ?? []) as AccionFila[]) {
    const p = (a.payload ?? {}) as { cotizacion_id?: unknown; envio?: { at?: unknown } };
    const id = Number(a.resultado_id ?? p.cotizacion_id);
    if (Number.isInteger(id)) enviadas.set(id, typeof p.envio?.at === "string" ? p.envio.at : null);
  }
  const ids = lista.map((c) => Number(c.id));
  const { data: vivas, error: e3 } = await sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).in("cotizacion_id", ids).in("estado", [...ESTADOS_VIVOS]);
  if (e3) throw new Error(tablaFaltante(e3, TABLA_SOLICITUDES) ? `Falta correr ${SQL_RESERVA_TRASLADOS.solicitudes}.` : `No se pudieron leer las solicitudes de reserva: ${e3.message}`);
  return lista.map((c) => {
    const id = Number(c.id);
    const tj = (c.traslado_json ?? {}) as { validez_hasta?: unknown };
    const validez = typeof tj.validez_hasta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(tj.validez_hasta) ? tj.validez_hasta : null;
    const inicio = inicioServicioMs({ fecha_servicio: c.fecha_servicio as string | null, hora_ida: c.hora_ida as string | null });
    const vencida = (validez != null && validez < hoy) || (inicio != null && inicio <= ahoraMs) || c.estado === "vencido";
    const viva = ((vivas ?? []) as FilaSolicitud[]).find((s) => Number(s.cotizacion_id) === id) ?? null;
    return {
      cand: { id, numero: numeroCotizacion({ id, numero_cotizacion: c.numero_cotizacion as string | null }), enviada: enviadas.has(id), vencida, solicitudViva: !!viva },
      enviadaEn: enviadas.get(id) ?? null, creadaEn: (c.created_at as string) ?? null, viva,
    };
  });
}

// ── 3. Topes ─────────────────────────────────────────────────────────────────

async function contarSolicitudesHoy(sb: Sb, convId: string, hoy: string): Promise<{ conv: number | null; dia: number | null }> {
  const n = (r: { count?: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  const desde = inicioDiaLima(hoy);
  const [a, b] = await Promise.all([
    sb.from(TABLA_SOLICITUDES).select("id", { count: "exact", head: true }).eq("crm_conversacion_id", convId).gte("creada_en", desde),
    sb.from(TABLA_SOLICITUDES).select("id", { count: "exact", head: true }).gte("creada_en", desde),
  ]);
  return { conv: n(a), dia: n(b) };
}

/** Cuántas filas de `clave` (lecturas de comprobantes, o correos sin cotización) hay hoy, en la conversación y en total. */
async function contarLecturasHoy(sb: Sb, convId: string, hoy: string, clave: string = CLAVE_LECTURA_COMPROBANTE): Promise<{ conv: number | null; dia: number | null }> {
  const n = (r: { count?: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  const [a, b] = await Promise.all([
    sb.from("alerta_enviada").select("ref", { count: "exact", head: true }).eq("clave", clave).eq("fecha", hoy).like("ref", `conv:${convId}:%`),
    sb.from("alerta_enviada").select("ref", { count: "exact", head: true }).eq("clave", clave).eq("fecha", hoy),
  ]);
  return { conv: n(a), dia: n(b) };
}

// ── 4. El correo interno ─────────────────────────────────────────────────────

type EnvioCorreo = { enviado: boolean; error: string | null; destinatarios: string[] };

/**
 * Manda el correo a los destinatarios de la reserva. Nunca lanza: el fallo vuelve en `error`. El
 * comprobante (`x.adjunto`: los bytes que se bajaron, o null si no se pudo) va adjunto SOLO si
 * `adjuntoDeComprobante` lo reconoce por sus primeros bytes; si no, el correo sale sin él y dice por qué.
 */
async function mandarCorreo(datos: DatosCorreoReserva, x: { correoConfig: string | null; emailEmpresa: string | null; adjunto?: { bytes: Uint8Array | null; nombreBase: string } | null }, deps: DepsReserva): Promise<EnvioCorreo> {
  const dest = destinatariosReserva({ correoConfig: x.correoConfig, emailEmpresa: x.emailEmpresa });
  if (!dest.correos.length) return { enviado: false, error: "No hay a quién mandar el correo: escribe el correo de reservas en /tarifario → Zonas y traslados → Ajustes o en /configuracion/perfil.", destinatarios: [] };
  const adj = x.adjunto ? adjuntoDeComprobante(x.adjunto.bytes, x.adjunto.nombreBase) : null;
  const c = correoReserva({ ...datos, adjunto: adj?.ok === true, adjuntoMotivo: adj && !adj.ok ? adj.motivo : null });
  const attachments = adj?.ok && x.adjunto?.bytes
    ? [{ filename: adj.nombre, content: Buffer.from(x.adjunto.bytes).toString("base64") }] : undefined;
  const errores: string[] = [];
  for (const to of dest.correos) {
    try { await (deps.enviarCorreo ?? enviarCorreoPorDefecto)({ to, subject: c.asunto, html: c.html, attachments }); }
    catch (e) { errores.push(`${to}: ${msg(e)}`); }
  }
  return { enviado: errores.length < dest.correos.length, error: errores.length ? errores.join(" · ").slice(0, 1900) : null, destinatarios: dest.correos };
}

// ── 5. Crear la solicitud ────────────────────────────────────────────────────

export type CtxReservaIA = {
  sb: Sb;
  conv: ConvR;
  contacto: ContactoR;
  /** Copiado ANTES del bucle del agente: el canal y el wa_id del hilo. */
  remitente: { canal: string; waId: string | null };
  agente: { modelo?: unknown; comportamiento?: unknown; pausa_humano_horas?: unknown } | null;
  /** El mismo `modoAuto` con que el agente decide si envía. */
  modoAuto: boolean;
  /** La configuración de la reserva (`leerConfigIA(...).reserva`), leída antes del bucle. */
  cfg: ConfigReserva;
  /** Herramientas de reserva usadas en ESTE turno. */
  turno: { n: number };
  /**
   * La pausa tras la actividad de una persona y la reactivación del chat, calculadas por el agente una
   * vez por turno (lib/crm-ia.ts): con ellas se juzga una cotización que una persona CORRIGIÓ después de
   * que la IA la escribió (lib/traslados/cotizacion-corregida.ts). Sin ellas, las horas del agente y
   * sin reactivación.
   */
  pausa?: PausaEjecutivo | null;
};

/** La pausa con que se juzga una cotización corregida: la del turno, o la del agente sin reactivación. */
const pausaDe = (ctx: Pick<CtxReservaIA, "pausa" | "agente">): PausaEjecutivo => ctx.pausa ?? { horas: horasPausaHumano(ctx.agente), reactivadaAt: null };

/**
 * `correccion`: el juicio de la cotización corregida con que se decidió pedir el pago (null si no se
 * juzgó: el orden ya no era pedir el pago).
 */
type Creada = { s: FilaSolicitud; cc: ContextoCotizacion; orden: OrdenReserva; adel: Adelanto; pct: number | null; accionId: string | null; correccion: JuicioCorreccion | null };

/**
 * Crea la solicitud de una cotización enviada, decide el orden (`ordenDeReserva`) y la tarjeta del
 * inbox. `aceptoEn`: la hora del mensaje con que el cliente aceptó (o la del comprobante, si pagó sin
 * aceptar). Devuelve `ya` si otra corrida la creó a la vez (índice único de las vivas).
 */
async function crearSolicitud(
  ctx: CtxReservaIA, cand: Candidata, x: { ahora: number; hoy: string; aceptoEn: string | null; aceptoMensajeId: string | null; extraMotivos?: string[]; pasajero?: string | null; vuelo?: string | null },
): Promise<{ ok: true; c: Creada } | { ok: false; ya?: FilaSolicitud | null; motivo: string; nota: string }> {
  const { sb } = ctx;
  let cc: ContextoCotizacion;
  try { cc = await contextoCotizacion(sb, cand.cand.id); }
  catch (e) { return { ok: false, motivo: "No se pudo leer la cotización a reservar", nota: seguro(e, "crearSolicitud/contexto") }; }
  const pct = cc.credito ? null : ctx.cfg.adelantoPct;
  const adel = adelantoDe(cc.fila, pct);
  if (!adel) return { ok: false, motivo: `La cotización N° ${cc.numero} no tiene importes que se puedan calcular`, nota: "Revísala en /cotizaciones (ítems o tipo de cambio)." };
  const elegibilidad = elegibilidadDeReserva({
    zonaConEnvio: cc.zonaEnvio, cotizacionEnviada: cand.cand.enviada, validezHasta: (cc.fila.traslado_json?.validez_hasta as string | null) ?? null,
    hoy: x.hoy, inicioMs: cc.inicioMs, ahoraMs: x.ahora, adelantoPct: pct, credito: cc.credito, cuentas: cc.cuentas.cuentas.length,
    cuentasFrente: cc.frente.codigo, perfilConfigurado: perfilConfigurado(cc.perfil), politicaSospechosa: cc.politicaSospechosa,
  });
  const orden = ordenDeReserva({ ahoraMs: x.ahora, inicioMs: cc.inicioMs, atencion: atencionDeAgente(ctx.agente), cfg: ctx.cfg, elegibilidad });
  // Sin adelanto calculable no se puede pedir el pago (defensa: la elegibilidad ya lo impide).
  let accion = orden.accion === "pedir_pago" && (adel.adelanto == null || !cc.cuentas.lineas.length) ? "confirmar_disponibilidad" : orden.accion;
  // Pedir el pago manda los importes, las cuentas y la política DE LA FILA: si una persona la corrigió
  // y la pausa tras su actividad no ha pasado (o no se sabe cuándo la tocó), el adelanto lo pide el
  // ejecutivo desde la tarjeta («disponibilidad primero», motivo `cotizacion_corregida`).
  let correccion: JuicioCorreccion | null = null;
  if (accion === "pedir_pago") {
    correccion = await correccionDeCotizacion(sb, cc.fila, { convId: ctx.conv.id, pausa: pausaDe(ctx), ahoraMs: x.ahora });
    if (!correccion.usar) accion = "confirmar_disponibilidad";
  }
  const espera = correccion != null && !correccion.usar;
  const motivos = [...new Set([...orden.motivos, ...(espera ? ["cotizacion_corregida"] : []), ...(x.extraMotivos ?? [])])].filter((m) => /^[a-z_]{2,40}$/.test(m));
  const notaCorr = espera ? notaSolicitudCorregida(correccion!, x.ahora) : null;
  const fila = {
    cotizacion_id: cc.fila.id, crm_conversacion_id: ctx.conv.id,
    estado: accion === "pedir_pago" ? "esperando_pago" : "por_confirmar", orden: ordenDeSolicitud(accion), motivos_orden: motivos,
    // Con T1 se le mandan las cuentas: su huella va con los importes (para no reenviarle otras).
    adelanto_pct: pct, firma_importes: firmaConCuentas(firmaImportes(cc.fila, pct), accion === "pedir_pago" ? huellaCuentas(cc.cuentas.lineasHuella) : null),
    confirmar_antes_de: isoDe(orden.confirmarAntesMs), urgente: orden.urgente,
    nombre_pasajero: x.pasajero ?? null, vuelo: x.vuelo ?? null, cliente_acepto_en: x.aceptoEn, acepto_mensaje_id: x.aceptoMensajeId,
    ...(notaCorr ? { nota: notaCorr } : {}),
  };
  const ins = await sb.from(TABLA_SOLICITUDES).insert(fila).select(COLS_SOLICITUD).single();
  if (ins.error || !ins.data) {
    if (ins.error?.code === "23505") {
      // Otra corrida la creó a la vez: es la viva de esta cotización.
      const { data } = await sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).eq("cotizacion_id", cc.fila.id).in("estado", [...ESTADOS_VIVOS]).limit(1);
      return { ok: false, ya: ((data ?? [])[0] ?? null) as FilaSolicitud | null, motivo: "La solicitud ya existía", nota: "" };
    }
    const falta = ins.error && tablaFaltante(ins.error, TABLA_SOLICITUDES);
    return { ok: false, motivo: "No se pudo registrar la solicitud de reserva", nota: falta ? `Falta correr ${SQL_RESERVA_TRASLADOS.solicitudes}.` : crudo("No se pudo registrar la solicitud de reserva", ins.error) };
  }
  const s = { ...(ins.data as FilaSolicitud), orden: ordenDeSolicitud(accion) } as FilaSolicitud;
  // La tarjeta del inbox (queda `pendiente` mientras la solicitud esté abierta). Best-effort: sin ella la solicitud sigue viva.
  let accionId: string | null = null;
  try {
    const cuando = [cc.fila.fecha_servicio ? cc.fila.fecha_servicio.split("-").reverse().join("/") : "", (cc.fila.hora_ida ?? "").slice(0, 5)].filter(Boolean).join(" ");
    const { data: acc, error } = await sb.from("crm_acciones_ia").insert({
      conversacion_id: ctx.conv.id, contacto_id: ctx.contacto?.id ?? null, tipo: TIPO_ACCION_RESERVA,
      resumen: `Reserva de traslado · Cotización N° ${cc.numero}${cuando ? ` · ${cuando}` : ""}`.slice(0, 200),
      payload: { solicitud_id: s.id, cotizacion_id: cc.fila.id, numero: cc.numero, orden: accion },
      estado: "pendiente", resultado_tipo: TABLA_SOLICITUDES, resultado_id: s.id,
    }).select("id").single();
    if (error || !acc) throw new Error(crudo("No se pudo crear la tarjeta", error ?? "sin fila"));
    accionId = String(acc.id);
    await sb.from(TABLA_SOLICITUDES).update({ crm_accion_id: accionId }).eq("id", s.id);
    s.crm_accion_id = accionId;
  } catch (e) {
    seguro(e, "crearSolicitud/tarjeta");
    await nota(sb, ctx.conv.id, `📅 Se registró la solicitud de reserva #${s.id} (cotización N° ${cc.numero}) pero no su tarjeta en la bandeja. Ábrela desde /tesoreria?tab=adelantos.`);
  }
  return { ok: true, c: { s, cc, orden: { ...orden, accion }, adel, pct, accionId, correccion } };
}

/** El correo «por confirmar disponibilidad» y la nota interna de una solicitud que espera a un ejecutivo. */
async function avisarPorConfirmar(ctx: CtxReservaIA, c: Creada, ahora: number, deps: DepsReserva): Promise<void> {
  const motivos = (c.s.motivos_orden ?? []) as MotivoOrden[];
  const correo = await mandarCorreo({
    tipo: "por_confirmar", cliente: { nombre: c.cc.cliente?.nombre ?? ctx.contacto?.nombre ?? null, waId: ctx.remitente.waId },
    cotizacion: { numero: c.cc.numero, origen: c.cc.fila.origen, destino: c.cc.fila.destino, fecha: c.cc.fila.fecha_servicio, hora: c.cc.fila.hora_ida },
    moneda: c.cc.moneda, total: c.adel.total, adelanto: c.adel.adelanto, pct: c.pct, confirmarAntesMs: c.orden.confirmarAntesMs, ahoraMs: ahora,
    motivos, urgente: c.orden.urgente, convId: ctx.conv.id, appUrl: appUrlDe(deps),
  }, { correoConfig: ctx.cfg.correo, emailEmpresa: c.cc.perfil?.email ?? null }, deps);
  const lineas = [
    `📅 Reserva de traslado por CONFIRMAR (cotización N° ${c.cc.numero}, solicitud #${c.s.id})${c.orden.urgente ? " · ⚠ URGENTE" : ""}.`,
    "Todavía NO se le pidió el pago: confirma la unidad desde la tarjeta («Hay unidad» / «No hay unidad»).",
    ...motivos.map((m) => `• ${MOTIVO_ORDEN[m] ?? m}`),
    ...(c.correccion ? [notaEsperaCorreccion(c.correccion, { numero: c.cc.numero, que: "adelanto", ahoraMs: ahora })].filter((l): l is string => !!l) : []),
    correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? "sin destinatarios"}.`,
  ];
  await nota(ctx.sb, ctx.conv.id, lineas.join("\n"), "Asistente IA");
}

/** El texto que se le manda al cliente al crear (o al volver a pedir) una solicitud: T1 o T2. */
function mensajeDeSolicitud(s: FilaSolicitud, cc: ContextoCotizacion, ahora: number, x: { cfg: ConfigReserva; agente: CtxReservaIA["agente"] }, deps: DepsReserva): string | null {
  const estilo = vozDe(x.agente, cc);
  const pct = pctDe(s);
  const adel = adelantoDe(cc.fila, pct);
  if (s.estado === "esperando_pago") {
    if (!adel || adel.adelanto == null || adel.saldo == null || pct == null || !cc.cuentas.lineas.length) return null;
    return mensajePedirPago({
      numero: cc.numero, moneda: adel.moneda, pct, adelanto: adel.adelanto, saldo: adel.saldo, cuentas: cc.cuentas.lineas,
      plazoMin: x.cfg.plazoConfirmacionMin, atencion: atencionDeAgente(x.agente), estilo,
      condiciones: condicionesDeContexto(cc, appUrlDe(deps)),
    });
  }
  if (s.estado === "por_confirmar") {
    return mensajeDisponibilidadPrimero({
      fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, frasePlazo: frasePlazo(msDe(s.confirmar_antes_de), ahora, cc.idioma),
      pct, credito: esCreditoSol(s), estilo,
    });
  }
  return null;
}

// ── 6. Las herramientas del agente ───────────────────────────────────────────

const derivaIA = (motivo: string, pedido: string, notaTxt: string, numero?: string | null): ResultadoReservaIA => ({
  respuestaModelo: respuestaReservaParaModelo("derivar", { numero: numero ?? null }), mensaje: null,
  derivar: { motivo: motivo.slice(0, 300), pedido: pedido.slice(0, 500), nota: `📅 ${notaTxt}`.slice(0, 1500) },
});
const solo = (accion: AccionReserva, numero?: string | null, opciones?: string[], mensaje: string | null = null): ResultadoReservaIA =>
  ({ respuestaModelo: respuestaReservaParaModelo(accion, { numero: numero ?? null, opciones }), mensaje });

/** El freno por turno y la condición de siempre (autónomo, WhatsApp con remitente). null = puede seguir. */
function frenoDelTurno(ctx: CtxReservaIA, pedido: string): ResultadoReservaIA | null {
  const t = decidirTopeReserva({ conv: 0, dia: 0, turno: ctx.turno.n }, "solicitud");
  if (!t.ok) return derivaIA("Demasiadas herramientas de reserva en una respuesta", pedido, t.motivo ?? "");
  ctx.turno.n++;
  if (!ctx.modoAuto || ctx.remitente.canal !== "whatsapp" || !ctx.remitente.waId)
    return derivaIA("La reserva automática no está disponible en este chat", pedido, "El agente no está en modo autónomo por WhatsApp, o el chat no tiene número.");
  return null;
}

/**
 * `reservar_traslado`. Decide sobre UNA cotización enviada por este chat (`elegirCotizacion`) y, si
 * hay que crear la solicitud, pide el pago (T1), pide esperar la unidad (T2) o deriva. Con una
 * solicitud viva vuelve a mandar su T1/T2 (si la corrida anterior se cortó antes de enviarlo, el
 * cliente se quedaría sin las cuentas); si la cotización cambió desde que se le dio el monto, deriva.
 */
export async function reservarTrasladoIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente quiere reservar un traslado cotizado por la IA.";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las cotizaciones de traslado del chat", pedido, seguro(err, "reservarTrasladoIA/candidatas")); }
  const elec = elegirCotizacion(cands.map((c) => c.cand), e.numeroCotizacion);
  if (elec.accion === "sin_cotizacion") return solo("sin_cotizacion");
  if (elec.accion === "elegir_cotizacion") return solo("elegir_cotizacion", null, elec.opciones);
  if (elec.accion === "recotizar") return solo("recotizar", elec.cotizacion.numero);
  const cand = cands.find((c) => c.cand.id === elec.cotizacion.id)!;
  if (elec.accion === "ya_solicitada") return yaSolicitada(ctx, cand.viva!, ahora, pedido, deps);

  const conteo = await contarSolicitudesHoy(ctx.sb, ctx.conv.id, hoy);
  const tope = decidirTopeReserva(conteo, "solicitud");
  if (!tope.ok) return derivaIA("Tope de solicitudes de reserva", pedido, tope.motivo ?? "", cand.cand.numero);
  let ult: { id: string; created_at: string } | null = null;
  try { ult = await ultimoEntrante(ctx.sb, ctx.conv.id); } catch { ult = null; }
  const r = await crearSolicitud(ctx, cand, { ahora, hoy, aceptoEn: ult?.created_at ?? isoDe(ahora), aceptoMensajeId: ult?.id ?? null, pasajero: e.nombrePasajero, vuelo: e.vuelo });
  if (!r.ok) {
    if (r.ya) return yaSolicitada(ctx, r.ya, ahora, pedido, deps);
    return derivaIA(r.motivo, pedido, r.nota, cand.cand.numero);
  }
  const c = r.c;
  if (c.orden.accion === "derivar") {
    await avisarPorConfirmar(ctx, c, ahora, deps);
    return derivaIA(
      "Reserva de traslado: nadie del equipo alcanza a confirmar la unidad antes del servicio", pedido,
      `Solicitud #${c.s.id} (cotización N° ${c.cc.numero}) por confirmar YA: ${(c.s.motivos_orden ?? []).map((m) => MOTIVO_ORDEN[m as MotivoOrden] ?? m).join(" ")}`,
      c.cc.numero,
    );
  }
  if (c.orden.accion === "confirmar_disponibilidad") await avisarPorConfirmar(ctx, c, ahora, deps);
  const mensaje = mensajeDeSolicitud(c.s, c.cc, ahora, ctx, deps);
  // El pedido del adelanto salió con una cotización CORREGIDA (ya pasó la pausa, o se reactivó la IA):
  // una nota para el ejecutivo, una sola vez (al crear la solicitud).
  if (c.orden.accion === "pedir_pago" && mensaje && c.correccion) {
    const n = notaUsoCorreccion(c.correccion, { numero: c.cc.numero, ahoraMs: ahora });
    if (n) await nota(ctx.sb, ctx.conv.id, n, "Asistente IA");
  }
  return solo(c.orden.accion, c.cc.numero, undefined, mensaje);
}

/**
 * La solicitud ya existe: se le vuelve a mandar su T1/T2. Volver a mandar las CUENTAS (T1) exige lo
 * mismo que mandarlas la primera vez —cuentas de «corporativo», perfil configurado— y, además, que
 * sean las MISMAS que recibió (`juzgarReenvioPedirPago` sobre la huella de `firma_importes`). Si
 * no, o si los importes cambiaron, deriva al ejecutivo con su nota.
 */
async function yaSolicitada(ctx: CtxReservaIA, s: FilaSolicitud, ahora: number, pedido: string, deps: DepsReserva): Promise<ResultadoReservaIA> {
  let cc: ContextoCotizacion;
  try { cc = await contextoCotizacion(ctx.sb, s.cotizacion_id); }
  catch (e) { return derivaIA("No se pudo leer la cotización de la reserva", pedido, seguro(e, "yaSolicitada")); }
  // Volver a pedir el pago manda los importes y las cuentas de la fila: si una persona la corrigió y la
  // pausa tras su actividad no ha pasado, T12 y una nota; NO se deriva (la IA vuelve sola tras la pausa).
  if (s.estado === "esperando_pago") {
    const espera = await esperaPorCorreccion(ctx, cc, ahora, "adelanto");
    if (espera) return espera;
  }
  if (s.estado === "esperando_pago" && s.firma_importes && firmaImportes(cc.fila, pctDe(s)) !== importesDeFirma(s.firma_importes)) {
    return derivaIA("La cotización cambió desde que se le pidió el pago", pedido,
      `Solicitud #${s.id}: los importes de la cotización N° ${cc.numero} ya no son los que se le comunicaron al cliente. Revísala antes de volver a pedirle el pago.`, cc.numero);
  }
  if (s.estado === "esperando_pago") {
    const j = juzgarReenvioPedirPago({
      frente: cc.frente.codigo, perfilConfigurado: perfilConfigurado(cc.perfil), lineas: cc.cuentas.lineas.length,
      huellaEnviada: huellaDeFirma(s.firma_importes), huellaActual: huellaCuentas(cc.cuentas.lineasHuella),
    });
    if (!j.ok) return derivaIA("No se le volvieron a mandar las cuentas de pago", pedido, `Solicitud #${s.id} (cotización N° ${cc.numero}): ${j.nota}`, cc.numero);
  }
  const mensaje = s.estado === "esperando_pago" || s.estado === "por_confirmar" ? mensajeDeSolicitud(s, cc, ahora, ctx, deps) : null;
  return solo("ya_solicitada", cc.numero, undefined, mensaje);
}

/**
 * Si una persona CORRIGIÓ la cotización y la pausa tras su actividad no ha pasado (o no se sabe cuándo
 * la tocó): el aviso al cliente (T12, sin importes ni políticas), la nota para el ejecutivo y la
 * acción `cotizacion_corregida`. null si se puede usar la fila (y el paso sigue como siempre).
 */
async function esperaPorCorreccion(
  ctx: CtxReservaIA, cc: ContextoCotizacion, ahora: number, que: "adelanto" | "politicas",
): Promise<ResultadoReservaIA | null> {
  const j = await correccionDeCotizacion(ctx.sb, cc.fila, { convId: ctx.conv.id, pausa: pausaDe(ctx), ahoraMs: ahora });
  if (j.usar) return null;
  const n = notaEsperaCorreccion(j, { numero: cc.numero, que, ahoraMs: ahora });
  if (n) await nota(ctx.sb, ctx.conv.id, n, "Asistente IA");
  return solo("cotizacion_corregida", cc.numero, undefined, mensajeCotizacionActualizada(cc.numero, vozDe(ctx.agente, cc)));
}

/**
 * La foto o el PDF que puede ser el comprobante: el último ENTRANTE desde `desde` que llegó por Meta
 * (`meta_message_id`: lo escribió el webhook, no una sesión del ERP), sin usar en ninguna solicitud.
 * LANZA.
 */
async function archivoCandidato(sb: Sb, convId: string, desdeIso: string | null): Promise<{ nuevo: { id: string; media_url: string; created_at: string; tipo: string } | null; usado: boolean }> {
  let q = sb.from("crm_mensajes").select("id, media_url, created_at, tipo").eq("conversacion_id", convId).eq("direccion", "entrante")
    .not("media_url", "is", null).not("meta_message_id", "is", null).order("created_at", { ascending: false }).limit(20);
  if (desdeIso) q = q.gte("created_at", desdeIso);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer los archivos del chat: ${error.message}`);
  const archivos = ((data ?? []) as { id: string; media_url: string; created_at: string; tipo: string }[]).filter((m) => TIPOS_ARCHIVO.includes(String(m.tipo)) && m.media_url);
  if (!archivos.length) return { nuevo: null, usado: false };
  const { data: usados, error: e2 } = await sb.from(TABLA_COMPROBANTES).select("mensaje_id").in("mensaje_id", archivos.map((m) => m.id));
  if (e2) throw new Error(`No se pudo comprobar qué comprobantes ya se registraron: ${e2.message}`);
  const ya = new Set(((usados ?? []) as { mensaje_id: string }[]).map((u) => String(u.mensaje_id)));
  const nuevo = archivos.find((m) => !ya.has(String(m.id))) ?? null;
  return { nuevo, usado: !nuevo && archivos.length > 0 };
}

type ResultadoComprobante =
  | { codigo: "registrado"; mensaje: string; cotejo: Cotejo; estado: EstadoSolicitud; detalle: string }
  | { codigo: "sin_imagen" | "ya_registrado" | "tope" | "error"; mensaje: string | null; detalle: string };

/**
 * El núcleo de «el cliente mandó el comprobante»: toma el archivo, lo LEE con el extractor aparte
 * (solo la imagen: ni el monto esperado ni el chat), lo coteja, lo registra como evidencia, pasa la
 * solicitud a `pago_reportado` (con el plazo recalculado), manda el correo con el comprobante
 * adjunto, deja la nota y arma T3. Lo usan la IA y la tarjeta.
 */
async function registrarComprobante(
  sb: Sb, s: FilaSolicitud,
  x: {
    conv: ConvR; contacto: ContactoR; waId: string | null; agente: CtxReservaIA["agente"]; cfg: ConfigReserva; desdeIso: string | null; autor: string;
    /**
     * Solo la IA: con la pausa del turno, si una persona CORRIGIÓ la cotización hace poco el mensaje al
     * cliente no nombra el adelanto esperado (sale de la fila corregida). La tarjeta no lo pasa: ahí
     * actúa una persona.
     */
    pausa?: PausaEjecutivo | null;
  },
  deps: DepsReserva,
): Promise<ResultadoComprobante> {
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  let cand: Awaited<ReturnType<typeof archivoCandidato>>;
  try { cand = await archivoCandidato(sb, x.conv.id, x.desdeIso); }
  catch (e) { return { codigo: "error", mensaje: null, detalle: seguro(e, "registrarComprobante/archivo") }; }
  if (!cand.nuevo) return cand.usado
    ? { codigo: "ya_registrado", mensaje: null, detalle: "El último comprobante del chat ya está registrado." }
    : { codigo: "sin_imagen", mensaje: mensajePedirComprobante(vozDe(x.agente, await idiomaDeCotizacion(sb, s.cotizacion_id))), detalle: "No hay una foto o un PDF nuevo del comprobante en el chat." };
  const archivo = cand.nuevo;

  // El freno: un conteo que no se pudo leer bloquea; la lectura se RECLAMA antes de hacerla.
  const conteo = await contarLecturasHoy(sb, x.conv.id, hoy);
  const tope = decidirTopeReserva(conteo, "lectura");
  if (!tope.ok) return { codigo: "tope", mensaje: null, detalle: tope.motivo ?? "Tope de lecturas de comprobantes." };
  const reg = await sb.from("alerta_enviada").insert({ clave: CLAVE_LECTURA_COMPROBANTE, ref: `conv:${x.conv.id}:${ahora}-${azarDe(deps)}`, fecha: hoy });
  if (reg.error) return { codigo: "tope", mensaje: null, detalle: crudo("No se pudo registrar la lectura del comprobante", reg.error) };

  let cc: ContextoCotizacion;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); }
  catch (e) { return { codigo: "error", mensaje: null, detalle: seguro(e, "registrarComprobante/contexto") }; }
  const lector = await (deps.leerComprobante ?? leerComprobantePago)(sb, archivo.media_url, { modelo: x.agente?.modelo });
  const lectura = lector.ok ? lector.lectura : null;
  const pct = pctDe(s);
  const adel = adelantoDe(cc.fila, pct);
  let operacionesPrevias: string[] = [];
  const op = normalizarOperacion(lectura?.numero_operacion);
  if (op) {
    const { data, error } = await sb.from(TABLA_COMPROBANTES).select("id").eq("operacion_norm", op).limit(1);
    if (error) return { codigo: "error", mensaje: null, detalle: crudo("No se pudo comprobar si la operación ya se usó", error) };
    if ((data ?? []).length) operacionesPrevias = [op];
  }
  // El monto del adelanto que el mensaje le recuerda al cliente sale de la fila: con una corrección
  // reciente de una persona, el mensaje no lo nombra (el cotejo para el equipo sigue igual).
  const corr = x.pausa ? await correccionDeCotizacion(sb, cc.fila, { convId: x.conv.id, pausa: x.pausa, ahoraMs: ahora }) : null;
  const esperadoMensaje = corr && !corr.usar ? null : adel?.adelanto ?? null;
  const creadaMs = msDe(cc.fila.created_at ?? null);
  const cotejo = cotejarComprobante(lectura, {
    adelanto: adel?.adelanto ?? null, total: adel?.total ?? 0, moneda: cc.moneda, hoy,
    desde: creadaMs != null ? fechaLima(creadaMs) : "", operacionesPrevias, cuentas: cc.cuentas.cuentas,
  });
  const ins = await sb.from(TABLA_COMPROBANTES).insert({
    solicitud_id: s.id, mensaje_id: archivo.id, lectura: lectura ? { ...lectura } : null, cotejo: cotejo.codigos, operacion_norm: cotejo.operacion,
  }).select("id").single();
  if (ins.error || !ins.data) {
    if (ins.error?.code === "23505") return { codigo: "ya_registrado", mensaje: null, detalle: "Ese comprobante ya se registró (a la vez, por otra respuesta)." };
    return { codigo: "error", mensaje: null, detalle: tablaFaltante(ins.error, TABLA_COMPROBANTES) ? `Falta correr ${SQL_RESERVA_TRASLADOS.comprobantes}.` : crudo("No se pudo registrar el comprobante", ins.error) };
  }
  const compId = Number(ins.data.id);

  // Una imagen que el lector LEYÓ y que no es un comprobante no mueve la solicitud ni avisa a nadie
  // (la misma definición que frena la cancelación, el cierre y el vencimiento: `comprobanteCuenta`).
  const noEs = lector.ok && !comprobanteCuenta(lectura);
  let estado: EstadoSolicitud = s.estado;
  let plazoMs = msDe(s.confirmar_antes_de);
  if (!noEs && s.estado === "esperando_pago" && puedePasar("esperando_pago", "pago_reportado")) {
    const orden = ordenDeReserva({ ahoraMs: ahora, inicioMs: cc.inicioMs, atencion: atencionDeAgente(x.agente), cfg: x.cfg, elegibilidad: [] });
    const { data: up } = await sb.from(TABLA_SOLICITUDES)
      .update({ estado: "pago_reportado", confirmar_antes_de: isoDe(orden.confirmarAntesMs), urgente: orden.urgente })
      .eq("id", s.id).eq("estado", "esperando_pago").select("id");
    if ((up ?? []).length) { estado = "pago_reportado"; plazoMs = orden.confirmarAntesMs; }
  }
  if (!noEs) {
    const bajado = await (deps.bajarArchivo ?? bajarArchivoPorDefecto)(sb, archivo.media_url).catch(() => null);
    const correo = await mandarCorreo({
      tipo: "pago_reportado", cliente: { nombre: cc.cliente?.nombre ?? x.contacto?.nombre ?? null, waId: x.waId },
      cotizacion: { numero: cc.numero, origen: cc.fila.origen, destino: cc.fila.destino, fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida },
      moneda: cc.moneda, total: adel?.total ?? null, adelanto: adel?.adelanto ?? null, pct, lectura, cotejo,
      confirmarAntesMs: plazoMs, ahoraMs: ahora, motivos: (s.motivos_orden ?? []) as MotivoOrden[], urgente: s.urgente === true,
      convId: x.conv.id, appUrl: appUrlDe(deps),
    }, {
      correoConfig: x.cfg.correo, emailEmpresa: cc.perfil?.email ?? null,
      adjunto: { bytes: bajado?.bytes ?? null, nombreBase: `comprobante-cotizacion-${cc.numero}` },
    }, deps);
    try {
      await sb.from(TABLA_COMPROBANTES).update(correo.enviado ? { correo_en: new Date(ahora).toISOString(), correo_error: correo.error } : { correo_error: correo.error })
        .eq("id", compId);
    } catch { /* la constancia del correo es accesoria */ }
    const leido = lectura
      ? [lectura.texto_monto ? `monto ${lineaCorta(lectura.texto_monto, 40)}` : null, lectura.fecha ? `fecha ${lectura.fecha}` : null, lectura.numero_operacion ? `operación ${lineaCorta(lectura.numero_operacion, 40)}` : null].filter(Boolean).join(" · ")
      : "no se pudo leer";
    await nota(sb, x.conv.id, [
      `💳 El cliente REPORTÓ un pago (cotización N° ${cc.numero}, solicitud #${s.id}). PENDIENTE de verificar en el banco: no registres el adelanto hasta ver el dinero.`,
      `Lo que leyó la IA (puede equivocarse): ${leido}.`,
      ...cotejo.codigos.map((k) => `• ${TEXTO_COTEJO[k] ?? k}`),
      ...(corr ? [notaEsperaCorreccion(corr, { numero: cc.numero, que: "adelanto_esperado", ahoraMs: ahora })].filter((l): l is string => !!l) : []),
      correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? "sin destinatarios"}.`,
    ].join("\n"), x.autor);
  }
  const mensaje = mensajeComprobanteRecibido({
    cotejo, esperado: esperadoMensaje, moneda: cc.moneda, frasePlazo: frasePlazo(plazoMs, ahora, cc.idioma),
    unidadConfirmada: estado === "confirmada", estilo: vozDe(x.agente, cc),
  });
  return { codigo: "registrado", mensaje, cotejo, estado, detalle: noEs ? "La imagen no parece un comprobante: se le pidió otra." : "Comprobante registrado." };
}

/**
 * `reportar_pago_traslado`. Con una solicitud viva en el chat, registra el comprobante. Sin ella, si
 * hay UNA cotización enviada que se pueda reservar, crea la solicitud (pagó sin aceptar: la hora de
 * aceptación es la del comprobante) y lo registra. Con ninguna o varias NO se lee con IA (no hay con
 * qué cotejarlo): se avisa por correo con el archivo adjunto —una vez por archivo y con su tope
 * diario (`CLAVE_CORREO_SIN_COTIZACION`)— y se deriva: no hay a qué atar ese pago.
 */
export async function reportarPagoIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente dice que ya pagó su traslado (o mandó el comprobante).";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las reservas de traslado del chat", pedido, seguro(err, "reportarPagoIA/candidatas")); }
  let vivas = cands.filter((c) => c.viva);
  if (e.numeroCotizacion) {
    const elec = elegirCotizacion(vivas.map((c) => ({ ...c.cand, solicitudViva: false })), e.numeroCotizacion);
    if (elec.accion === "crear") vivas = vivas.filter((c) => c.cand.id === elec.cotizacion.id);
  }
  const base = { conv: ctx.conv, contacto: ctx.contacto, waId: ctx.remitente.waId, agente: ctx.agente, cfg: ctx.cfg, autor: "Asistente IA", pausa: pausaDe(ctx) };
  const desdeDe = (c: Candidata) => c.enviadaEn ?? c.creadaEn;

  const conSolicitud = async (s: FilaSolicitud, c: Candidata): Promise<ResultadoReservaIA> => {
    const r = await registrarComprobante(ctx.sb, s, { ...base, desdeIso: desdeDe(c) }, deps);
    if (r.codigo === "registrado") return solo("comprobante_registrado", c.cand.numero, undefined, r.mensaje);
    if (r.codigo === "ya_registrado") return solo("ya_registrado", c.cand.numero);
    if (r.codigo === "sin_imagen") return solo("pedir_comprobante", c.cand.numero, undefined, r.mensaje);
    return derivaIA("No se pudo registrar el comprobante de pago", pedido, `Solicitud #${s.id}: ${r.detalle}`, c.cand.numero);
  };

  if (vivas.length === 1) return conSolicitud(vivas[0].viva!, vivas[0]);
  if (vivas.length > 1) return derivaIA("Varias reservas de traslado en curso en el chat", pedido, "El cliente reportó un pago y hay más de una solicitud viva: revisa a cuál corresponde.");

  // Sin solicitud viva.
  const elegibles = cands.filter((c) => c.cand.enviada && !c.cand.vencida && !c.viva);
  if (elegibles.length === 1) {
    const c = elegibles[0];
    let archivo: Awaited<ReturnType<typeof archivoCandidato>>;
    try { archivo = await archivoCandidato(ctx.sb, ctx.conv.id, desdeDe(c)); }
    catch (err) { return derivaIA("No se pudieron leer los archivos del chat", pedido, seguro(err, "reportarPagoIA/archivo"), c.cand.numero); }
    if (!archivo.nuevo) return archivo.usado ? solo("ya_registrado", c.cand.numero) : solo("pedir_comprobante", c.cand.numero, undefined, mensajePedirComprobante(vozDe(ctx.agente, await idiomaDeCotizacion(ctx.sb, c.cand.id))));
    const conteo = await contarSolicitudesHoy(ctx.sb, ctx.conv.id, hoy);
    const tope = decidirTopeReserva(conteo, "solicitud");
    if (!tope.ok) return derivaIA("Tope de solicitudes de reserva", pedido, tope.motivo ?? "", c.cand.numero);
    const r = await crearSolicitud(ctx, c, { ahora, hoy, aceptoEn: archivo.nuevo.created_at, aceptoMensajeId: archivo.nuevo.id, extraMotivos: ["pago_sin_aceptar"] });
    if (!r.ok) {
      if (r.ya) return conSolicitud(r.ya, c);
      return derivaIA(r.motivo, pedido, r.nota, c.cand.numero);
    }
    if (r.c.orden.accion !== "pedir_pago") await avisarPorConfirmar(ctx, r.c, ahora, deps);
    return conSolicitud(r.c.s, c);
  }

  // Ninguna o varias cotizaciones que reservar: NO se lee con IA (no hay con qué cotejarlo). Se avisa
  // por correo con el archivo adjunto, una sola vez por archivo y con su tope diario, y se deriva.
  let archivo: Awaited<ReturnType<typeof archivoCandidato>>;
  try { archivo = await archivoCandidato(ctx.sb, ctx.conv.id, new Date(ahora - VENTANA_SIN_COTIZACION_MS).toISOString()); }
  catch (err) { return derivaIA("No se pudieron leer los archivos del chat", pedido, seguro(err, "reportarPagoIA/sin_cotizacion")); }
  const motivo = elegibles.length > 1 ? "Pago reportado con varias cotizaciones de traslado en el chat" : "Pago reportado sin una cotización de traslado que reservar";
  if (!archivo.nuevo) return derivaIA(motivo, pedido, "El cliente dice que pagó y no hay un comprobante nuevo en el chat ni una sola cotización a la que atarlo.");
  const notaBase = `El cliente mandó un comprobante y no hay UNA cotización de traslado enviada a la que atarlo (${elegibles.length === 0 ? "ninguna" : "varias"}). No registres ningún adelanto hasta ver el dinero en la cuenta.`;
  const aviso = await avisarComprobanteSinCotizacion(ctx, archivo.nuevo, { ahora, hoy }, deps);
  return derivaIA(motivo, pedido, `${notaBase} ${aviso}`);
}

/**
 * El correo «comprobante sin cotización que reservar», con el archivo adjunto y SIN leerlo con IA.
 * Un archivo se avisa UNA vez: antes de enviar se busca y después se RECLAMA en `alerta_enviada`
 * (`CLAVE_CORREO_SIN_COTIZACION`, ref `conv:<id>:msg:<mensaje>`, índice único clave + ref + fecha),
 * así otra herramienta del mismo turno —u otro turno— no lo vuelve a mandar. El tope diario se cuenta
 * con esa misma clave; sin poder contarlo (o reclamarlo) no se envía. Devuelve la frase para la nota
 * interna. Nunca lanza.
 */
async function avisarComprobanteSinCotizacion(
  ctx: CtxReservaIA, archivo: { id: string; media_url: string }, x: { ahora: number; hoy: string }, deps: DepsReserva,
): Promise<string> {
  const ref = `conv:${ctx.conv.id}:msg:${archivo.id}`;
  try {
    const { data: previo, error: ePrev } = await ctx.sb.from("alerta_enviada").select("ref").eq("clave", CLAVE_CORREO_SIN_COTIZACION).eq("ref", ref).limit(1);
    if (ePrev) return `No se envió el correo con el comprobante: ${crudo("No se pudo comprobar si ya se había avisado", ePrev)}`;
    if ((previo ?? []).length) return "Ese comprobante ya se avisó por correo: no se volvió a enviar.";
    const tope = decidirTopeReserva(await contarLecturasHoy(ctx.sb, ctx.conv.id, x.hoy, CLAVE_CORREO_SIN_COTIZACION), "correo_sin_cotizacion");
    if (!tope.ok) return `No se envió el correo con el comprobante: ${tope.motivo ?? "tope del día"}`;
    const reg = await ctx.sb.from("alerta_enviada").insert({ clave: CLAVE_CORREO_SIN_COTIZACION, ref, fecha: x.hoy });
    if (reg.error?.code === "23505") return "Ese comprobante ya se avisó por correo: no se volvió a enviar.";
    if (reg.error) return `No se envió el correo con el comprobante: ${crudo("No se pudo registrar el aviso", reg.error)}`;
  } catch (e) {
    return `No se envió el correo con el comprobante: ${seguro(e, "avisarComprobanteSinCotizacion")}`;
  }
  let perfil: PerfilEmpresa | null = null;
  try { perfil = (await leerPerfilPdf(ctx.sb)).perfil; } catch { perfil = null; }
  const bajado = await (deps.bajarArchivo ?? bajarArchivoPorDefecto)(ctx.sb, archivo.media_url).catch(() => null);
  const correo = await mandarCorreo({
    tipo: "pago_sin_cotizacion", cliente: { nombre: ctx.contacto?.nombre ?? null, waId: ctx.remitente.waId }, cotizacion: null,
    moneda: "PEN", total: null, adelanto: null, pct: null, lectura: null, ahoraMs: x.ahora, convId: ctx.conv.id, appUrl: appUrlDe(deps),
  }, { correoConfig: ctx.cfg.correo, emailEmpresa: perfil?.email ?? null, adjunto: { bytes: bajado?.bytes ?? null, nombreBase: "comprobante" } }, deps);
  return correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? ""}`;
}

/**
 * `politicas_reserva`: las políticas de la cotización, al pie de la letra (T8), o su resumen con el
 * enlace a las condiciones completas (cotizaciones-08). Una política (o un resumen) con una línea
 * sospechosa (un enlace, un número largo: `condicionesSospechosas`) o que no cabe
 * (`excesoCondiciones`) NO se envía: la misma revisión que tiene la cotización antes de salir sola.
 */
export async function politicasIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente pregunta por las políticas de reserva, cambios o cancelación.";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las cotizaciones de traslado del chat", pedido, seguro(err, "politicasIA/candidatas")); }
  const viva = cands.filter((c) => c.viva);
  let elegida: Candidata | null = viva.length === 1 ? viva[0] : null;
  if (!elegida) {
    const elec = elegirCotizacion(cands.map((c) => c.cand), e.numeroCotizacion);
    if (elec.accion === "crear" || elec.accion === "ya_solicitada" || elec.accion === "recotizar") elegida = cands.find((c) => c.cand.id === elec.cotizacion.id) ?? null;
    else if (elec.accion === "elegir_cotizacion") elegida = cands.find((c) => c.cand.enviada) ?? null; // la más reciente enviada
  }
  if (!elegida) return derivaIA("Políticas de reserva sin cotización de traslado", pedido, "No hay una cotización de traslado enviada en el chat de la que leer las políticas.");
  try {
    const cc = await contextoCotizacion(ctx.sb, elegida.cand.id);
    // Las políticas salen de la fila: corregida hace poco por una persona → T12 y una nota, sin derivar.
    const espera = await esperaPorCorreccion(ctx, cc, ahora, "politicas");
    if (espera) return espera;
    const exceso = excesoCondiciones({ reserva: cc.politica, reserva_resumen: cc.resumen });
    if (cc.politicaSospechosa || exceso.length) {
      const por = [
        cc.politicaSospechosa ? "una línea trae un enlace o un número largo" : null,
        ...exceso.map((x) => (x.motivo === "demasiadas_lineas" ? `tiene ${x.n} líneas` : `una línea tiene ${x.n} caracteres`)),
      ].filter(Boolean).join("; ");
      return derivaIA("Las políticas de reserva de la cotización necesitan revisión", pedido,
        `Revisa las políticas de la cotización N° ${cc.numero} (${por}): no se le enviaron al cliente. Se corrigen en la cotización (/cotizaciones) o en su plantilla (/cotizaciones/plantillas).`, cc.numero);
    }
    // Una cotización en inglés con la política en castellano: no se traduce lo que escribió una
    // persona, ni se le manda en otro idioma; la ve un ejecutivo.
    if (cc.idioma === "en" && !cc.condicionesEnIdioma && cc.politica.length) {
      return derivaIA("Las políticas de esta cotización están en castellano", pedido,
        `La cotización N° ${cc.numero} va en inglés y sus políticas de reserva, cambios y cancelación están en castellano: no se le enviaron al cliente. Envíaselas tú, o asigna una plantilla en inglés a «Traslado de la IA · inglés» en /cotizaciones/plantillas.`, cc.numero);
    }
    const cond = condicionesDeContexto(cc, appUrlDe(deps));
    const m = mensajePoliticas({ numero: cc.numero, lineas: cc.politica, email: cc.perfil?.email ?? null, estilo: vozDe(ctx.agente, cc), resumen: cond.resumen, enlace: cond.enlace });
    if (!m) return derivaIA("La cotización no tiene políticas de reserva", pedido, `La cotización N° ${cc.numero} no tiene políticas de reserva y cancelación (/cotizaciones/plantillas).`, cc.numero);
    return solo("enviar_politicas", cc.numero, undefined, m);
  } catch (err) {
    return derivaIA("No se pudieron leer las políticas de reserva", pedido, seguro(err, "politicasIA"), elegida.cand.numero);
  }
}

/**
 * `cancelar_reserva_traslado`. Sin pago, sin un comprobante que cuente (`comprobanteCuenta`: una
 * imagen que el lector leyó y no es un comprobante no frena) y sin la unidad confirmada, la solicitud
 * se cierra sola (`cancelada`, motivo cliente). Si no, se guarda la hora del MENSAJE del cliente (desde
 * ahí se cuentan las horas de anticipación de la política), se deriva y se le dice que un ejecutivo
 * le confirma lo que corresponde (T6). Nunca promete devoluciones.
 */
export async function cancelarIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente pide cancelar su reserva de traslado.";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las reservas de traslado del chat", pedido, seguro(err, "cancelarIA/candidatas")); }
  let vivas = cands.filter((c) => c.viva);
  if (e.numeroCotizacion && vivas.length > 1) {
    const elec = elegirCotizacion(vivas.map((c) => ({ ...c.cand, solicitudViva: false })), e.numeroCotizacion);
    if (elec.accion === "crear") vivas = vivas.filter((c) => c.cand.id === elec.cotizacion.id);
  }
  if (!vivas.length) return solo("sin_reserva");
  if (vivas.length > 1) return derivaIA("Pedido de cancelación con varias reservas en curso", pedido, "El cliente pidió cancelar y hay más de una solicitud de reserva viva: revisa cuál.");
  const c = vivas[0], s = c.viva!;
  try {
    const tramos = await tramosDeCotizacion(ctx.sb, s.cotizacion_id);
    const pagos = await pagosDeSolicitud(ctx.sb, s, tramos.map((t) => t.id));
    const comps = await comprobantesDe(ctx.sb, s.id);
    const cc = await contextoCotizacion(ctx.sb, s.cotizacion_id);
    const estilo = vozDe(ctx.agente, cc);
    const { cobrado } = dineroDeSolicitud(pagos, cc.moneda);
    if (cobrado <= 0 && !comps.some((k) => comprobanteCuenta(k.lectura)) && s.estado !== "confirmada") {
      const { data } = await ctx.sb.from(TABLA_SOLICITUDES)
        .update({ estado: "cancelada", cierre_motivo: "cliente", cerrada_en: new Date(ahora).toISOString() })
        .eq("id", s.id).eq("estado", s.estado).select("id");
      if (!(data ?? []).length) return derivaIA("La reserva cambió mientras se cancelaba", pedido, `Solicitud #${s.id}: otra acción la movió; revisa la tarjeta.`, c.cand.numero);
      await cerrarAccionSiCorresponde(ctx.sb, s.id, deps);
      await nota(ctx.sb, ctx.conv.id, `📅 El cliente anuló su pedido de reserva (cotización N° ${cc.numero}, solicitud #${s.id}): no había pago ni comprobante${comps.length ? " (lo que mandó no era un comprobante)" : ""}. La solicitud quedó cancelada.`, "Asistente IA");
      return solo("cancelada_sin_pago", cc.numero, undefined, mensajeCanceladaSinPago({ numero: cc.numero, estilo }));
    }
    let ult: { id: string; created_at: string } | null = null;
    try { ult = await ultimoEntrante(ctx.sb, ctx.conv.id); } catch { ult = null; }
    const pedidaIso = s.cancelacion_pedida_en ?? ult?.created_at ?? new Date(ahora).toISOString();
    if (!s.cancelacion_pedida_en) {
      await ctx.sb.from(TABLA_SOLICITUDES).update({ cancelacion_pedida_en: pedidaIso }).eq("id", s.id).is("cancelacion_pedida_en", null);
    }
    const pedidaMs = msDe(pedidaIso) ?? ahora;
    const mensaje = mensajeCancelacionRegistrada({ fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, pedidaMs, inicioMs: cc.inicioMs, estilo });
    const horas = cc.inicioMs != null ? Math.floor((cc.inicioMs - pedidaMs) / 3_600_000) : null;
    return {
      respuestaModelo: respuestaReservaParaModelo("cancelacion_registrada", { numero: cc.numero }), mensaje,
      derivar: {
        motivo: "El cliente pidió cancelar su reserva de traslado", pedido,
        nota: `📅 Pedido de CANCELACIÓN (solicitud #${s.id}, cotización N° ${cc.numero}) recibido ${horas != null ? `${horas} h antes del inicio` : "sin hora de servicio"}. Cobrado: ${r2(cobrado)} ${cc.moneda}. Decide la devolución desde la tarjeta según las políticas${s.reserva_id ? " (primero cancela la reserva en /programacion)" : ""}.`,
      },
    };
  } catch (err) {
    return derivaIA("No se pudo registrar el pedido de cancelación", pedido, `Solicitud #${s.id}: ${seguro(err, "cancelarIA")}`, c.cand.numero);
  }
}

// ── 7. La cadena de la tarjeta y el aviso al cliente ─────────────────────────

export type Cadena = {
  s: FilaSolicitud;
  accion: AccionFila | null;
  conv: (ConvR & { contacto_id?: string | null }) | null;
  contacto: (NonNullable<ContactoR> & { fb_psid?: string | null; ig_id?: string | null; gmail_email?: string | null }) | null;
};

/**
 * La solicitud con su tarjeta, su conversación y su contacto, comprobando que sean de la misma
 * cadena. Con `conversacionId` y `accionId` (la tarjeta del inbox), los dos tienen que coincidir con
 * los de la solicitud, la acción tiene que ser de tipo `reserva_traslado` y apuntar a ESA solicitud,
 * y la cotización tiene que ser de esa conversación. Sin ellos (Tesorería), solo se lee.
 */
export async function cargarCadena(
  sb: Sb, x: { solicitudId: number; conversacionId?: string; accionId?: string },
): Promise<{ ok: true; c: Cadena } | { ok: false; codigo: CodigoResultadoReserva; detalle: string }> {
  let s: FilaSolicitud | null;
  try { s = await leerSolicitud(sb, x.solicitudId); }
  catch (e) { return { ok: false, codigo: (e as { sinMigracion?: boolean }).sinMigracion ? "sin_migracion" : "error", detalle: seguro(e, "cargarCadena/solicitud") }; }
  if (!s) return { ok: false, codigo: "no_existe", detalle: "Esa solicitud de reserva no existe." };
  const ajena = (d: string) => ({ ok: false as const, codigo: "ajena" as const, detalle: d });
  const pideCadena = x.conversacionId !== undefined || x.accionId !== undefined;
  if (pideCadena) {
    const conv = String(x.conversacionId ?? "").trim(), accId = String(x.accionId ?? "").trim();
    if (!conv || !accId) return ajena("Faltan la conversación o la tarjeta de la reserva: recarga la bandeja.");
    if (s.crm_conversacion_id !== conv) return ajena("La solicitud no es de esta conversación: recarga la bandeja.");
    if (s.crm_accion_id && s.crm_accion_id !== accId) return ajena("La tarjeta no es la de esta solicitud: recarga la bandeja.");
  }
  let accion: AccionFila | null = null;
  try { accion = await leerAccion(sb, pideCadena ? String(x.accionId) : s.crm_accion_id); }
  catch (e) { return { ok: false, codigo: "error", detalle: seguro(e, "cargarCadena/tarjeta") }; }
  if (pideCadena) {
    if (!accion || accion.tipo !== TIPO_ACCION_RESERVA) return ajena("La tarjeta no es una reserva de traslado.");
    if (accion.conversacion_id !== s.crm_conversacion_id) return ajena("La tarjeta no es de esta conversación.");
    const p = (accion.payload ?? {}) as { solicitud_id?: unknown; cotizacion_id?: unknown };
    if (Number(p.solicitud_id ?? accion.resultado_id) !== s.id) return ajena("La tarjeta no es la de esta solicitud.");
    if (p.cotizacion_id != null && Number(p.cotizacion_id) !== Number(s.cotizacion_id)) return ajena("La tarjeta no es de esta cotización.");
  }
  // La cotización tiene que ser de la conversación de la solicitud.
  const { data: cot, error: eCot } = await sb.from("cotizaciones").select("id, crm_conversacion_id").eq("id", s.cotizacion_id).maybeSingle();
  if (eCot) return { ok: false, codigo: "error", detalle: crudo("No se pudo leer la cotización", eCot) };
  if (!cot) return { ok: false, codigo: "no_existe", detalle: "La cotización de la solicitud ya no existe." };
  if (s.crm_conversacion_id && cot.crm_conversacion_id && cot.crm_conversacion_id !== s.crm_conversacion_id) return ajena("La cotización no es de esta conversación.");
  let conv: Cadena["conv"] = null, contacto: Cadena["contacto"] = null;
  if (s.crm_conversacion_id) {
    const { data: c, error: eConv } = await sb.from("crm_conversaciones")
      .select("id, canal, phone_number_id, contacto_id, crm_contactos(id, nombre, wa_id, telefono, cliente_id, fb_psid, ig_id, gmail_email)")
      .eq("id", s.crm_conversacion_id).maybeSingle();
    if (eConv) return { ok: false, codigo: "error", detalle: crudo("No se pudo leer la conversación", eConv) };
    if (c) {
      conv = { id: c.id, canal: String(c.canal ?? ""), phone_number_id: c.phone_number_id ?? null, contacto_id: c.contacto_id ?? null };
      const ct = Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos;
      contacto = ct ?? null;
    }
  }
  return { ok: true, c: { s, accion, conv, contacto } };
}

/**
 * Le escribe al cliente un texto del código (T4, T5, T7, T9…). Solo por WhatsApp y dentro de la
 * ventana de 24 h; fuera, no se intenta: vuelve el texto y su enlace wa.me. Al número del hilo,
 * nunca a uno del cuerpo de la petición.
 */
async function avisarCliente(sb: Sb, c: Cadena, texto: string | null, x: { usuarioId: string | null }, deps: DepsReserva):
  Promise<{ codigo: "ok" | "fuera_de_ventana" | "envio_fallido" | "sin_mensaje"; enviado: boolean; fueraDeVentana?: ResultadoAccionReserva["fueraDeVentana"]; error?: string | null }> {
  if (!texto) return { codigo: "sin_mensaje", enviado: false };
  const waId = c.contacto?.wa_id ? String(c.contacto.wa_id) : null;
  const fuera = (cerro: string | null) => ({ codigo: "fuera_de_ventana" as const, enviado: false, fueraDeVentana: { texto, waMe: enlaceWaMe(waId, texto), cerroEn: cerro } });
  if (!c.conv || c.conv.canal !== "whatsapp" || !waId) return fuera(null);
  let ult: { created_at: string } | null = null;
  try { ult = await ultimoEntrante(sb, c.conv.id); } catch { return fuera(null); }
  const v = ventana24h(ult?.created_at ?? null, ahoraDe(deps));
  if (!v.abierta) return fuera(v.cierraEn);
  const r = await (deps.enviarTexto ?? enviarTextoCRM)(sb, c.conv, c.contacto, texto, { waDestino: waId, generadoPorIa: true, enviadoPor: x.usuarioId });
  return r.error ? { codigo: "envio_fallido", enviado: false, error: r.error } : { codigo: "ok", enviado: true };
}

/** El resultado de una acción que además le escribió (o no pudo escribirle) al cliente. */
function conAviso(base: string, a: Awaited<ReturnType<typeof avisarCliente>>, extra: Partial<ResultadoAccionReserva>): ResultadoAccionReserva {
  if (a.codigo === "fuera_de_ventana") return res("fuera_de_ventana", `${base} Pasaron más de 24 h desde el último mensaje del cliente: envíale el mensaje desde el celular (wa.me).`, { ...extra, enviado: false, fueraDeVentana: a.fueraDeVentana });
  if (a.codigo === "envio_fallido") return { ...res("envio_fallido", `${base} El mensaje al cliente no salió: ${a.error ?? "error"}`, extra), ok: false, enviado: false };
  return res("ok", base, { ...extra, enviado: a.enviado });
}

// ── 8. Hechos de una solicitud y su tarjeta ──────────────────────────────────

type Hechos = {
  cc: ContextoCotizacion | null;
  tramos: ReservaTramo[];
  pagos: (PagoSolicitud & PagoVista)[];
  comprobantes: FilaComprobante[];
  cargo: { id: number; serie: string | null; numero: string | null; total: number | null; estado: string | null; sunat_estado: string | null; notasCredito: number } | null;
  versiones: { id: number; version: number; codigo: string }[];
  avisos: string[];
};

/** Todo lo que se sabe de la solicitud. Lo que no se pudo leer va a `avisos` (y, si es dinero, LANZA). */
async function leerHechos(sb: Sb, s: FilaSolicitud): Promise<Hechos> {
  const avisos: string[] = [];
  let cc: ContextoCotizacion | null = null;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); } catch (e) { avisos.push(seguro(e, "leerHechos/contexto")); }
  const tramos = await tramosDeCotizacion(sb, s.cotizacion_id);
  const pagos = await pagosDeSolicitud(sb, s, tramos.map((t) => t.id));
  const comprobantes = await comprobantesDe(sb, s.id);
  let cargo: Hechos["cargo"] = null;
  if (s.factura_cargo_id) {
    const { data, error } = await sb.from("facturas").select("id, serie, numero, total, estado, sunat_estado, cliente_id, moneda").eq("id", s.factura_cargo_id).maybeSingle();
    if (error) avisos.push(crudo("No se pudo leer el comprobante del cargo", error));
    else if (data) {
      const base = { id: Number(data.id), serie: data.serie ?? null, numero: data.numero ?? null, total: num(data.total), estado: data.estado ?? null, sunat_estado: data.sunat_estado ?? null };
      cargo = { ...base, notasCredito: cargoEditable(base) ? 0 : await notasCreditoDe(sb, { ...base, cliente_id: data.cliente_id, moneda: data.moneda }) };
    }
  }
  let versiones: Hechos["versiones"] = [];
  const idDoc = tramos.length ? Math.min(...tramos.map((t) => t.id)) : null;
  if (idDoc) {
    try { versiones = ((await leerVersiones(sb, idDoc)) ?? []).map((v) => ({ id: v.id, version: v.version, codigo: v.codigo })); }
    catch (e) { avisos.push(seguro(e, "leerHechos/versiones")); }
  }
  return { cc, tramos, pagos, comprobantes, cargo, versiones, avisos };
}

/** Los comprobantes que cuentan como un pago reportado (`comprobanteCuenta`). */
const comprobantesQueCuentan = (h: Pick<Hechos, "comprobantes">): number => h.comprobantes.filter((k) => comprobanteCuenta(k.lectura)).length;

const confirmacionEnviadaDe = (s: FilaSolicitud, accion: AccionFila | null) =>
  s.estado === "completada" || !!(accion?.payload as { confirmacion_enviada?: unknown } | null)?.confirmacion_enviada;

function pendientesDe(s: FilaSolicitud, h: Hechos, accion: AccionFila | null): { pendientes: Pendiente[]; cobrado: number; devuelto: number; moneda: Moneda } {
  const moneda = h.cc?.moneda ?? "PEN";
  const { cobrado, devuelto } = dineroDeSolicitud(h.pagos, moneda);
  const adel = h.cc ? adelantoDe(h.cc.fila, pctDe(s)) : null;
  const pendientes = queFalta(
    { estado: s.estado, orden: s.orden, adelanto_pct: pctDe(s), confirmar_antes_de: s.confirmar_antes_de, cancelacion_pedida_en: s.cancelacion_pedida_en, devolucion_pct: num(s.devolucion_pct), comprobantes: comprobantesQueCuentan(h) },
    {
      cobrado, devuelto, adelanto: adel?.adelanto ?? null, reserva: reservaParaQueFalta(s, h.tramos),
      confirmacionEnviada: confirmacionEnviadaDe(s, accion), confirmacionEmitida: h.versiones.length > 0,
      cargo: h.cargo ? { id: h.cargo.id, numero: h.cargo.numero, serie: h.cargo.serie, total: h.cargo.total, estado: h.cargo.estado, sunat_estado: h.cargo.sunat_estado, notasCredito: h.cargo.notasCredito } : null, moneda,
    },
  );
  return { pendientes, cobrado, devuelto, moneda };
}

/**
 * Cierra la tarjeta cuando la solicitud terminó y no le queda nada: completada → `aprobada`;
 * cancelada / sin unidad → `rechazada`. Solo si sigue `pendiente` (mientras falte algo, por ejemplo
 * una devolución, queda abierta en la bandeja). Best-effort: nunca lanza.
 */
export async function cerrarAccionSiCorresponde(sb: Sb, solicitudId: number, deps: DepsReserva = {}): Promise<boolean> {
  try {
    const s = await leerSolicitud(sb, solicitudId);
    if (!s || !esEstadoTerminal(s.estado) || !s.crm_accion_id) return false;
    const accion = await leerAccion(sb, s.crm_accion_id);
    if (!accion || accion.estado !== "pendiente") return false;
    const h = await leerHechos(sb, s);
    if (pendientesDe(s, h, accion).pendientes.length) return false;
    const at = new Date(ahoraDe(deps)).toISOString();
    const { data } = await sb.from("crm_acciones_ia")
      .update({ estado: s.estado === "completada" ? "aprobada" : "rechazada", resuelta_at: at, payload: { ...(accion.payload ?? {}), cierre: { motivo: s.cierre_motivo ?? s.estado, at, por: "sistema" } } })
      .eq("id", accion.id).eq("estado", "pendiente").select("id");
    return (data ?? []).length > 0;
  } catch { return false; }
}

/**
 * Las acciones que tienen sentido en este estado (la ruta las vuelve a comprobar todas).
 * `comprobantes`: todos los registrados (se pueden ver); `reportados`: los que cuentan como un pago.
 */
function accionesDe(s: FilaSolicitud, x: { cobrado: number; devuelto: number; total: number | null; comprobantes: number; reportados: number; aDevolver: number | null; emitida: boolean }): (AccionTarjeta | AccionDinero)[] {
  const out: (AccionTarjeta | AccionDinero)[] = [];
  const cancelacion = !!s.cancelacion_pedida_en;
  if (x.comprobantes > 0) out.push("ver_comprobante");
  if (ESTADOS_ABIERTOS_SIN_UNIDAD.includes(s.estado)) {
    if (!cancelacion) out.push("hay_unidad", "sin_unidad");
    out.push("pedir_comprobante", "registrar_comprobante", "vincular_cliente");
  }
  if (s.estado === "confirmada") {
    out.push("enviar_confirmacion", "vincular_cliente", "pedir_comprobante", "registrar_comprobante", "sin_unidad");
    if (x.emitida) out.push("marcar_confirmacion_enviada");
  }
  if (cancelacion && !esEstadoTerminal(s.estado)) out.push("resolver_cancelacion");
  if (!esEstadoTerminal(s.estado) && x.cobrado <= 0) out.push("cerrar");
  if (s.estado !== "completada" && (x.total == null || x.cobrado + 0.005 < x.total)) out.push("registrar_adelanto");
  if (x.reportados > 0 && x.cobrado <= 0 && !esEstadoTerminal(s.estado)) out.push("pago_no_encontrado");
  if (x.aDevolver != null && x.devuelto + 0.005 < x.aDevolver) out.push("registrar_devolucion");
  return [...new Set(out)];
}

/** La vista de la tarjeta (y del detalle de Tesorería). LANZA si la solicitud o su dinero no se pueden leer. */
export async function vistaSolicitud(sb: Sb, c: Cadena, deps: DepsReserva = {}): Promise<VistaSolicitud> {
  const s = c.s;
  const ahora = ahoraDe(deps);
  const h = await leerHechos(sb, s);
  const { pendientes, cobrado, devuelto, moneda } = pendientesDe(s, h, c.accion);
  const pct = pctDe(s);
  const adel = h.cc ? adelantoDe(h.cc.fila, pct) : null;
  const pctDev = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
  const aDevolver = pctDev != null && (s.estado === "sin_unidad" || s.estado === "cancelada") ? devolucionDecidida(cobrado, pctDev) : null;
  let cfg: ConfigReserva | null = null;
  try { cfg = (await leerConfigIA(sb)).reserva; } catch { cfg = null; }
  let ventana = ventana24h(null, ahora);
  if (c.conv) { try { ventana = ventana24h((await ultimoEntrante(sb, c.conv.id))?.created_at ?? null, ahora); } catch { h.avisos.push("No se pudo leer el último mensaje del cliente (la ventana de 24 h)."); } }
  const res0 = reservaParaQueFalta(s, h.tramos);
  const pagoNo = (c.accion?.payload as { pago_no_encontrado?: { at?: string; por?: string } } | null)?.pago_no_encontrado;
  const comprobantes: ComprobanteVista[] = h.comprobantes.map((k) => {
    const l = k.lectura as LecturaComprobante | null;
    const cot = (k.cotejo ?? []).map((cd) => ({ codigo: cd, texto: (TEXTO_COTEJO as Record<string, string>)[cd] ?? cd }));
    return {
      id: Number(k.id), mensajeId: k.mensaje_id, creadoEn: k.creado_en,
      lectura: l ? { monto: l.monto ?? null, textoMonto: l.texto_monto ?? null, moneda: l.moneda ?? null, fecha: l.fecha ?? null, hora: l.hora ?? null, operacion: l.numero_operacion ?? null, medio: l.medio ?? null, bancoDestino: l.banco_destino ?? null, cuentaDestino: l.cuenta_destino ?? null, confianza: l.confianza ?? null } : null,
      cotejo: cot, seguro: cot.length === 1 && (cot[0].codigo === "coincide" || cot[0].codigo === "pago_total"),
      correoEn: k.correo_en, correoError: k.correo_error, leidoEn: k.leido_en,
    };
  });
  const inicio = h.cc?.inicioMs ?? null;
  const pedida = msDe(s.cancelacion_pedida_en);
  return {
    id: s.id, estado: s.estado, orden: s.orden,
    motivos: (s.motivos_orden ?? []).map((m) => ({ codigo: m, texto: MOTIVO_ORDEN[m as MotivoOrden] ?? (m === "pago_sin_aceptar" ? "El cliente pagó sin aceptar antes la cotización por el chat." : m) })),
    urgente: s.urgente === true, confirmarAntesDe: s.confirmar_antes_de, creadaEn: s.creada_en, clienteAceptoEn: s.cliente_acepto_en,
    nombrePasajero: s.nombre_pasajero, vuelo: s.vuelo, nota: s.nota, cierreMotivo: s.cierre_motivo, cerradaEn: s.cerrada_en,
    cotizacion: h.cc ? {
      id: h.cc.fila.id, numero: h.cc.numero, origen: h.cc.fila.origen, destino: h.cc.fila.destino,
      fecha: h.cc.fila.fecha_servicio, hora: h.cc.fila.hora_ida, fechaRetorno: h.cc.fila.fecha_retorno, horaRetorno: h.cc.fila.hora_retorno,
      moneda: h.cc.moneda, total: adel?.total ?? null, adelanto: adel?.adelanto ?? null, saldo: adel?.saldo ?? null, pct,
      importesVigentes: s.firma_importes ? firmaImportes(h.cc.fila, pct) === importesDeFirma(s.firma_importes) : null, clienteId: num(h.cc.fila.cliente_id),
    } : null,
    cliente: h.cc?.cliente ? { id: h.cc.cliente.id, nombre: h.cc.cliente.nombre } : null,
    contacto: { nombre: c.contacto?.nombre ?? null, waId: c.contacto?.wa_id ? String(c.contacto.wa_id) : null },
    reserva: res0 ? { id: res0.id, estado: res0.estado, clienteId: res0.cliente_id, tramos: h.tramos.length } : null,
    dinero: { moneda, cobrado, devuelto, aDevolver, retenido: aDevolver != null ? cargoRetenido({ cobrado, devuelto: aDevolver }) : 0 },
    pagos: h.pagos.map(({ id, codigo, sentido, fecha, monto, moneda: m, metodo, referencia, anulado }) => ({ id, codigo, sentido, fecha, monto, moneda: m, metodo, referencia, anulado })),
    comprobantes,
    pagoNoEncontrado: pagoNo?.at ? { at: pagoNo.at, por: pagoNo.por ?? null } : null,
    cancelacion: s.cancelacion_pedida_en ? { pedidaEn: s.cancelacion_pedida_en, horasAntes: pedida != null && inicio != null ? Math.floor((inicio - pedida) / 3_600_000) : null, devolucionPct: num(s.devolucion_pct) } : null,
    cargo: h.cargo,
    confirmacion: { emitida: h.versiones.length > 0, enviada: confirmacionEnviadaDe(s, c.accion), ultima: h.versiones[0] ?? null },
    ventana, pendientes,
    acciones: accionesDe(s, { cobrado, devuelto, total: adel?.total ?? null, comprobantes: h.comprobantes.length, reportados: comprobantesQueCuentan(h), aDevolver, emitida: h.versiones.length > 0 }),
    politica: h.cc?.politica ?? [], devolucionPlazoH: cfg?.devolucionPlazoH ?? null, avisos: h.avisos,
    idioma: h.cc?.idioma ?? "es",
  };
}

// ── 9. Las acciones de la tarjeta ────────────────────────────────────────────

type Quien = { id: string; nombre: string | null };

/** El agente y la configuración que leen los textos del código (el estilo, el horario, P y M). */
async function agenteYConfig(sb: Sb): Promise<{ agente: Record<string, unknown> | null; cfg: ConfigReserva }> {
  let agente: Record<string, unknown> | null = null;
  try { agente = await leerAgente(sb); } catch { agente = null; }
  return { agente, cfg: (await leerConfigIA(sb)).reserva };
}

/**
 * «✅ Hay unidad». Confirma la solicitud (reclamo condicional), pasa la cotización a `aprobado`,
 * crea ida y retorno con el ejecutor de «→ Res.», ata los cobros a la reserva y le escribe al cliente
 * T4: con el adelanto verificado, el reportado, o —si primero se confirmó la unidad— el bloque de
 * pago con las cuentas. Si la reserva no se pudo crear, la solicitud y la cotización vuelven a su
 * estado y no se le escribe nada.
 */
export async function confirmarDisponibilidad(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (!puedePasar(s.estado, "confirmada") || s.estado === "confirmada") return res("transicion_invalida", `La solicitud está «${s.estado}»: no se puede confirmar la unidad.`);
  if (s.cancelacion_pedida_en) return res("transicion_invalida", "El cliente pidió cancelar: resuelve primero la cancelación.");
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora), ahoraIso = new Date(ahora).toISOString();
  let cc: ContextoCotizacion, h: Hechos;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s); }
  catch (e) { return res("error", seguro(e, "confirmarDisponibilidad/leer")); }
  const { agente, cfg } = await agenteYConfig(sb);
  const credito = esCreditoSol(s);
  const pct = credito ? null : pctDe(s) ?? cfg.adelantoPct;
  if (!credito && pct == null) return res("sin_adelanto_config", "No hay un porcentaje de adelanto configurado: escríbelo en /tarifario → Zonas y traslados → Ajustes.");
  const adel = adelantoDe(cc.fila, pct);
  if (!adel || (!credito && adel.adelanto == null)) return res("error", `La cotización N° ${cc.numero} no tiene importes que se puedan calcular: revísala en /cotizaciones.`);
  if (s.firma_importes && s.orden === "pago_primero" && firmaImportes(cc.fila, pct) !== importesDeFirma(s.firma_importes)) {
    return res("importes_cambiaron", `La cotización N° ${cc.numero} cambió desde que se le pidió el pago al cliente: revisa los importes antes de confirmar (o cierra esta solicitud y vuelve a cotizar).`);
  }
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const pago: PagoEnHayUnidad = credito ? "credito"
    : cobrado + 0.005 >= (adel.adelanto ?? 0) ? "verificado"
    : cobrado > 0 ? "incompleto"
    : comprobantesQueCuentan(h) > 0 ? "reportado" : "pedir";
  let bloque: BloquePago | null = null;
  if (pago === "pedir" || pago === "incompleto") {
    if (!cc.cuentas.lineas.length) return res("sin_cuentas", "La cotización no tiene cuentas bancarias en su moneda para pedirle el pago: agrégalas en /configuracion/perfil.");
    if (cc.frente.codigo === "distintas" || cc.frente.codigo === "sin_comprobar") return res("cuentas_distintas", "Las cuentas de la plantilla de la cotización no son las de «corporativo» (o no se pudo comprobar): revísalas en /cotizaciones/plantillas antes de mandárselas al cliente.");
    if (!perfilConfigurado(cc.perfil)) return res("sin_cuentas", "El perfil de la empresa no tiene nombre: complétalo en /configuracion/perfil antes de mandarle las cuentas al cliente.");
    bloque = { numero: cc.numero, moneda: adel.moneda, pct: pct!, adelanto: adel.adelanto!, saldo: adel.saldo!, cuentas: cc.cuentas.lineas };
  }

  // El reclamo: solo si sigue en el estado que se leyó.
  const patch: Record<string, unknown> = { estado: "confirmada", disponibilidad_en: ahoraIso, disponibilidad_por: quien.id };
  // Con «disponibilidad primero» el monto se le comunica AHORA (T4): la firma es la de hoy, con la
  // huella de las cuentas si van en el mensaje.
  if (!credito && (pctDe(s) == null || s.orden === "disponibilidad_primero")) {
    patch.adelanto_pct = pct;
    patch.firma_importes = firmaConCuentas(firmaImportes(cc.fila, pct), bloque ? huellaCuentas(cc.cuentas.lineasHuella) : null);
  }
  const { data: rec, error: eRec } = await sb.from(TABLA_SOLICITUDES).update(patch).eq("id", s.id).eq("estado", s.estado).is("cancelacion_pedida_en", null).select("id");
  if (eRec) return res("error", crudo("No se pudo confirmar la solicitud", eRec));
  if (!(rec ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  const revertir = async () => {
    const back: Record<string, unknown> = { estado: s.estado, disponibilidad_en: s.disponibilidad_en, disponibilidad_por: s.disponibilidad_por };
    if ("adelanto_pct" in patch) { back.adelanto_pct = s.adelanto_pct; back.firma_importes = s.firma_importes; }
    try { await sb.from(TABLA_SOLICITUDES).update(back).eq("id", s.id).eq("estado", "confirmada").eq("disponibilidad_en", ahoraIso); } catch { /* queda confirmada sin reserva: la tarjeta lo dice («crear_reserva») */ }
  };

  // La cotización pasa a «aprobado» (lo que exige «→ Res.»).
  const estadoCot = String(cc.fila.estado ?? "");
  let cotCambiada = false;
  if (estadoCot !== "aprobado") {
    const { data: up, error: eUp } = await sb.from("cotizaciones").update({ estado: "aprobado" }).eq("id", cc.fila.id).eq("estado", estadoCot).select("id");
    if (eUp || !(up ?? []).length) {
      if (eUp) seguro(eUp, "confirmarDisponibilidad/aprobar");
      await revertir();
      return res("reserva_no_creada", `No se pudo aprobar la cotización N° ${cc.numero}${eUp ? "" : " (otra persona la cambió)"}. La solicitud vuelve a su estado.`);
    }
    cotCambiada = true;
  }
  const revertirCot = async () => {
    if (!cotCambiada) return;
    try { await sb.from("cotizaciones").update({ estado: estadoCot }).eq("id", cc.fila.id).eq("estado", "aprobado"); } catch { /* se corrige en /cotizaciones */ }
  };

  // Ida y retorno, con la MISMA lógica de «→ Res.».
  const avisos: string[] = [];
  let reservaId: number | null = null;
  try {
    const cot = await leerCotParaReserva(sb, cc.fila.id);
    if (!cot) throw new Error("La cotización ya no existe.");
    const r = await (deps.conversion ?? ejecutarConversion)(sb, cot, { hoy, confirmar: () => true });
    if (r.aviso) avisos.push(r.aviso);
    if (r.codigo === "ocupada" || r.codigo === "cambio") {
      // «→ Res.» de /cotizaciones está creando (o acaba de cambiar) las reservas de esta misma cotización.
      await revertir(); await revertirCot();
      return res("reclamo_perdido", `Alguien está creando la reserva de la cotización N° ${cc.numero} desde /cotizaciones («→ Res.») en este mismo momento. La solicitud vuelve a su estado: espera unos segundos y vuelve a pulsar «Hay unidad» (si ya quedó creada, la toma).`);
    }
    if (r.codigo === "creada" || r.codigo === "retorno_completado" || r.codigo === "parcial") {
      if (r.codigo !== "creada" || /⚠️/.test(r.mensaje)) avisos.push(r.mensaje);
    } else if (r.codigo !== "ya_convertida" && r.codigo !== "retorno_imposible") {
      seguro(r.mensaje || r.codigo, "confirmarDisponibilidad/conversion");
      await revertir(); await revertirCot();
      return res("reserva_no_creada", "No se pudo crear la reserva en Programación. La solicitud y la cotización vuelven a su estado: vuelve a intentar en un momento.");
    } else if (r.codigo === "retorno_imposible") avisos.push(r.mensaje);
    const tramos = await tramosDeCotizacion(sb, cc.fila.id);
    const vivos = tramos.filter((t) => t.estado !== "cancelada");
    reservaId = r.idas.length ? Math.min(...r.idas) : vivos.length ? Math.min(...vivos.map((t) => t.id)) : null;
  } catch (e) {
    seguro(e, "confirmarDisponibilidad/conversion");
    await revertir(); await revertirCot();
    return res("reserva_no_creada", "No se pudo crear la reserva en Programación. La solicitud y la cotización vuelven a su estado: vuelve a intentar en un momento.");
  }
  if (reservaId == null) { await revertir(); await revertirCot(); return res("reserva_no_creada", "La cotización no dejó ninguna reserva viva en Programación. La solicitud vuelve a su estado."); }
  await sb.from(TABLA_SOLICITUDES).update({ reserva_id: reservaId }).eq("id", s.id);
  try { await enlazarCobrosAReserva(sb, s.id, reservaId); } catch (e) {
    const causa = seguro(e, "confirmarDisponibilidad/enlazar", "");
    avisos.push(`Los cobros no se ataron a la reserva${causa ? ` (${causa})` : ""}. No los vuelvas a registrar: ya están en la solicitud.`);
  }

  const estilo = vozDe(agente, cc);
  const texto = mensajeHayUnidad({
    fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, origen: cc.fila.origen, destino: cc.fila.destino, pago, moneda: adel.moneda, cobrado, bloque, estilo,
    condiciones: bloque ? condicionesDeContexto(cc, appUrlDe(deps)) : null,
  });
  const a = await avisarCliente(sb, c, texto, { usuarioId: quien.id }, deps);
  await nota(sb, c.conv?.id, `✅ ${quien.nombre ?? "Un ejecutivo"} confirmó la unidad (solicitud #${s.id}, cotización N° ${cc.numero}). Reserva #${reservaId} creada en Programación.${avisos.length ? `\n${avisos.join("\n")}` : ""}`);
  return conAviso(`Unidad confirmada: reserva #${reservaId} creada en Programación.`, a, { estado: "confirmada", mensaje: texto, avisos });
}

/** ¿Algún tramo de la cotización sigue vivo en Programación? LANZA. */
async function reservaViva(sb: Sb, cotId: number): Promise<boolean> {
  return (await tramosDeCotizacion(sb, cotId)).some((t) => t.estado !== "cancelada");
}

/** «❌ No hay unidad»: sin unidad, devolución del 100 % de lo cobrado, T5. */
export async function sinUnidad(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (!puedePasar(s.estado, "sin_unidad")) return res("transicion_invalida", `La solicitud está «${s.estado}»: ya no se puede marcar sin unidad.`);
  const ahora = ahoraDe(deps), ahoraIso = new Date(ahora).toISOString();
  let cc: ContextoCotizacion, h: Hechos;
  try {
    if (await reservaViva(sb, s.cotizacion_id)) return res("cancelar_en_programacion", "La reserva sigue viva en Programación: cancélala ahí primero (ahí se decide qué pasa con su importe).");
    cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s);
  } catch (e) { return res("error", seguro(e, "sinUnidad/leer")); }
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "sin_unidad", devolucion_pct: 100, cierre_motivo: "sin_unidad", cerrada_en: ahoraIso, cerrada_por: quien.id })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", crudo("No se pudo cerrar la solicitud", error));
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  const { agente, cfg } = await agenteYConfig(sb);
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const texto = mensajeSinUnidad({ fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, conPago: cobrado > 0 || comprobantesQueCuentan(h) > 0, plazoH: cfg.devolucionPlazoH, estilo: vozDe(agente, cc) });
  const a = await avisarCliente(sb, c, texto, { usuarioId: quien.id }, deps);
  await nota(sb, c.conv?.id, `❌ ${quien.nombre ?? "Un ejecutivo"} marcó SIN UNIDAD la solicitud #${s.id} (cotización N° ${cc.numero}).${cobrado > 0 ? ` Hay que devolver el 100 % de lo cobrado (${r2(cobrado)} ${cc.moneda}): lo registra Tesorería.` : ""}`);
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return conAviso("Solicitud cerrada sin unidad.", a, { estado: "sin_unidad", mensaje: texto });
}

/** «Pedir otro comprobante» («otro») o «No encontramos el pago» («no_encontrado», T9). */
export async function pedirComprobante(sb: Sb, c: Cadena, quien: Quien, motivo: "otro" | "no_encontrado", deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (esEstadoTerminal(s.estado)) return res("transicion_invalida", `La solicitud está «${s.estado}».`);
  const { agente } = await agenteYConfig(sb);
  const estilo = vozDe(agente, await idiomaDeCotizacion(sb, s.cotizacion_id));
  let estado = s.estado;
  if (s.estado === "pago_reportado" && puedePasar("pago_reportado", "esperando_pago")) {
    const { data } = await sb.from(TABLA_SOLICITUDES).update({ estado: "esperando_pago" }).eq("id", s.id).eq("estado", "pago_reportado").select("id");
    if ((data ?? []).length) estado = "esperando_pago";
  }
  const texto = motivo === "no_encontrado" ? mensajePagoNoEncontrado(estilo) : mensajePedirComprobante(estilo);
  const a = await avisarCliente(sb, c, texto, { usuarioId: quien.id }, deps);
  return conAviso(motivo === "no_encontrado" ? "Se le pidió al cliente que confirme su pago." : "Se le pidió al cliente otro comprobante.", a, { estado, mensaje: texto });
}

/** Registra (y lee) el último comprobante del chat que la IA no registró; le responde T3. */
export async function registrarComprobanteTarjeta(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (esEstadoTerminal(s.estado)) return res("transicion_invalida", `La solicitud está «${s.estado}».`);
  if (!c.conv) return res("error", "La solicitud no tiene conversación.");
  const { agente, cfg } = await agenteYConfig(sb);
  // Desde que se ENVIÓ la cotización (si no se sabe, desde que se creó).
  let desde: string | null = null;
  try {
    const { data } = await sb.from("crm_acciones_ia").select("payload, resultado_id").eq("conversacion_id", c.conv.id).eq("tipo", "cotizacion_traslado").eq("estado", "aprobada").limit(50);
    const acc = ((data ?? []) as AccionFila[]).find((x) => Number(x.resultado_id ?? (x.payload as { cotizacion_id?: unknown } | null)?.cotizacion_id) === Number(s.cotizacion_id));
    desde = ((acc?.payload as { envio?: { at?: string } } | null)?.envio?.at) ?? null;
  } catch { desde = null; }
  if (!desde) { const { data } = await sb.from("cotizaciones").select("created_at").eq("id", s.cotizacion_id).maybeSingle(); desde = data?.created_at ?? null; }
  const r = await registrarComprobante(sb, s, { conv: c.conv, contacto: c.contacto, waId: c.contacto?.wa_id ? String(c.contacto.wa_id) : null, agente, cfg, desdeIso: desde, autor: quien.nombre ?? "Sistema" }, deps);
  if (r.codigo !== "registrado") {
    if (r.codigo === "ya_registrado") return res("sin_comprobante", "El último comprobante del chat ya está registrado.");
    if (r.codigo === "sin_imagen") return res("sin_comprobante", "No hay una foto o un PDF nuevo del comprobante en el chat (desde que se envió la cotización).");
    return res(r.codigo === "tope" ? "tope" : "error", r.detalle);
  }
  const a = await avisarCliente(sb, c, r.mensaje, { usuarioId: quien.id }, deps);
  return conAviso(r.detalle, a, { estado: r.estado, mensaje: r.mensaje });
}

/**
 * «Ver el comprobante»: lo marca leído (`leido_en`, `leido_por`) y devuelve un enlace firmado (corto)
 * para verlo. Lo usan la tarjeta del CRM y Tesorería, la misma función. Sin `comprobanteId`, el
 * último de la solicitud; con él, ESE —y tiene que ser de esta solicitud, o no se abre—. Solo un
 * archivo de `crm-media` (donde el webhook guarda lo que manda el cliente): un enlace a otro bucket
 * privado no se firma.
 */
export async function verComprobante(
  sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}, x: { comprobanteId?: number | null } = {},
): Promise<ResultadoAccionReserva> {
  let k: FilaComprobante | null;
  try {
    if (x.comprobanteId != null) {
      if (!Number.isInteger(x.comprobanteId) || x.comprobanteId <= 0) return res("datos_invalidos", "Elige el comprobante que quieres ver.");
      const { data, error } = await sb.from(TABLA_COMPROBANTES)
        .select("id, solicitud_id, mensaje_id, lectura, cotejo, operacion_norm, correo_en, correo_error, leido_en, creado_en")
        .eq("id", x.comprobanteId).eq("solicitud_id", c.s.id).maybeSingle();
      if (error) return res("error", crudo("No se pudo leer el comprobante", error));
      if (!data) return res("ajena", "Ese comprobante no es de esta solicitud: recarga el detalle.");
      k = data as FilaComprobante;
    } else k = (await comprobantesDe(sb, c.s.id))[0] ?? null;
  } catch (e) { return res("error", seguro(e, "verComprobante")); }
  if (!k?.mensaje_id) return res("sin_comprobante", "La solicitud no tiene un comprobante con archivo.");
  const { data: m, error } = await sb.from("crm_mensajes").select("media_url, conversacion_id").eq("id", k.mensaje_id).maybeSingle();
  if (error) return res("error", crudo("No se pudo leer el mensaje del comprobante", error));
  if (!m?.media_url || (c.s.crm_conversacion_id && m.conversacion_id !== c.s.crm_conversacion_id)) return res("sin_comprobante", "El archivo del comprobante ya no está.");
  const obj = objetoCrmMedia(m.media_url);
  if (!obj) return res("sin_comprobante", "El archivo del comprobante no está en el almacenamiento del CRM: ábrelo desde la conversación.");
  let url: string | null = null;
  if (obj) {
    const f = await sb.storage.from(obj.bucket).createSignedUrl(obj.ruta, TTL_URL_VER);
    url = f?.data?.signedUrl ?? null;
  }
  if (!url) return res("error", "No se pudo firmar el enlace del comprobante.");
  try { await sb.from(TABLA_COMPROBANTES).update({ leido_en: new Date(ahoraDe(deps)).toISOString(), leido_por: quien.id }).eq("id", k.id); } catch { /* accesorio */ }
  return res("ok", "Comprobante listo para ver.", { url });
}

/**
 * Resuelve el pedido de cancelación con el % de devolución que elige el ejecutivo viendo la política
 * y las horas. Si la reserva existe, primero se cancela en Programación (allí se decide qué pasa con
 * su importe). Un pago reportado que Tesorería no registró ni marcó «No encontré el pago» bloquea:
 * no se le puede decir al cliente cuánto se le devuelve sin saber cuánto pagó. T7 y, si se retiene
 * algo, el comprobante del cargo.
 */
export async function resolverCancelacion(sb: Sb, c: Cadena, quien: Quien, pctPedido: unknown, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  const pct = num(pctPedido);
  if (pct == null || pct < 0 || pct > 100) return res("datos_invalidos", "El porcentaje de devolución tiene que estar entre 0 y 100.");
  if (!s.cancelacion_pedida_en) return res("transicion_invalida", "El cliente no pidió cancelar esta reserva.");
  if (!puedePasar(s.estado, "cancelada")) return res("transicion_invalida", `La solicitud está «${s.estado}».`);
  const ahoraIso = new Date(ahoraDe(deps)).toISOString();
  let cc: ContextoCotizacion, h: Hechos;
  try {
    if (await reservaViva(sb, s.cotizacion_id)) return res("cancelar_en_programacion", "La reserva sigue viva en Programación: cancélala ahí primero (ahí se decide qué pasa con su importe).");
    cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s);
  } catch (e) { return res("error", seguro(e, "resolverCancelacion/leer")); }
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const noEncontrado = !!(c.accion?.payload as { pago_no_encontrado?: unknown } | null)?.pago_no_encontrado;
  if (comprobantesQueCuentan(h) > 0 && cobrado <= 0 && !noEncontrado) {
    return res("pago_sin_registrar", "El cliente reportó un pago que Tesorería todavía no registró: regístralo como adelanto o márcalo «No encontré el pago» antes de resolver la cancelación.");
  }
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "cancelada", devolucion_pct: pct, cierre_motivo: "cliente", cerrada_en: ahoraIso, cerrada_por: quien.id })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", crudo("No se pudo cerrar la solicitud", error));
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  const { agente, cfg } = await agenteYConfig(sb);
  const estilo = vozDe(agente, cc);
  const monto = devolucionDecidida(cobrado, pct);
  const texto = cobrado > 0
    ? mensajeCancelacionResuelta({ monto, pct, moneda: cc.moneda, plazoH: cfg.devolucionPlazoH, estilo })
    : mensajeCanceladaSinPago({ numero: cc.numero, estilo });
  const avisos: string[] = [];
  if (cobrado > 0) {
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (cargo.aviso) avisos.push(cargo.aviso);
  }
  const a = await avisarCliente(sb, c, texto, { usuarioId: quien.id }, deps);
  await nota(sb, c.conv?.id, `📅 ${quien.nombre ?? "Un ejecutivo"} resolvió la cancelación de la solicitud #${s.id}: se devuelve el ${pct} % de lo cobrado (${r2(monto)} ${cc.moneda}).${avisos.length ? `\n${avisos.join("\n")}` : ""}`);
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return conAviso("Cancelación resuelta.", a, { estado: "cancelada", mensaje: texto, avisos });
}

/** Las columnas del comprobante del cargo que se leen para juzgarlo. */
const COLS_CARGO = "id, cotizacion_id, cliente_id, moneda, serie, numero, subtotal, igv, total, estado, sunat_estado, observaciones, items_json";

/**
 * El comprobante del cargo de la solicitud, del dato más fuerte al más débil: el enlace de la
 * solicitud (`factura_cargo_id`) → la columna de la factura (`facturas.reserva_solicitud_id`,
 * reservas-09d, que solo escribe el servidor) → y SOLO sin esa columna (una base sin 09d), la marca
 * en las observaciones (no anulada). Uno de otra cotización no es suyo. LANZA si no se puede leer.
 */
async function cargoDeSolicitud(sb: Sb, s: FilaSolicitud, cotId: number): Promise<{ fila: FacturaCargoActual & { cotizacion_id?: number | null; cliente_id?: unknown; moneda?: unknown }; por: "enlace" | "columna" | "marca" } | { fila: null; conColumna: boolean }> {
  const deEstaCotizacion = (f: { cotizacion_id?: number | null } | null) => !!f && (f.cotizacion_id == null || Number(f.cotizacion_id) === Number(cotId));
  if (s.factura_cargo_id) {
    const { data, error } = await sb.from("facturas").select(COLS_CARGO).eq("id", s.factura_cargo_id).maybeSingle();
    if (error) throw new Error(`No se pudo leer el comprobante del cargo: ${error.message}`);
    if (data && deEstaCotizacion(data)) return { fila: data, por: "enlace" };
  }
  const col = await sb.from("facturas").select(COLS_CARGO).eq("reserva_solicitud_id", s.id).limit(2);
  if (col.error && !faltaColumna(col.error, "reserva_solicitud_id")) throw new Error(`No se pudo buscar el comprobante del cargo: ${col.error.message}`);
  const conColumna = !col.error;
  if (conColumna) {
    const f = ((col.data ?? []) as (FacturaCargoActual & { cotizacion_id?: number | null; cliente_id?: unknown; moneda?: unknown })[]).find(deEstaCotizacion);
    return f ? { fila: f, por: "columna" } : { fila: null, conColumna };
  }
  const marca = `${marcaCargoReserva(s.id)}:`;
  const { data: previa, error: ePrev } = await sb.from("facturas").select(COLS_CARGO).eq("cotizacion_id", cotId).ilike("observaciones", `%${marca}%`).neq("estado", "anulada").limit(1);
  if (ePrev) throw new Error(`No se pudo buscar el comprobante del cargo: ${ePrev.message}`);
  return (previa ?? []).length ? { fila: previa[0], por: "marca" } : { fila: null, conColumna };
}

/**
 * Lo que ya restan las notas de crédito que referencian este comprobante («F001-25»). Solo cuentan
 * las EMITIDAS de verdad: con número, aceptadas por SUNAT, no anuladas, del MISMO cliente y en la
 * MISMA moneda que el cargo (una pendiente, una que SUNAT rechazó, o una fila puesta a mano sin
 * número no apaga lo que falta: auditoría del 23-10-2026). Best-effort: 0 si no se pueden leer.
 */
async function notasCreditoDe(sb: Sb, f: Pick<FacturaCargoActual, "id" | "serie" | "numero"> & { cliente_id?: unknown; moneda?: unknown }): Promise<number> {
  const numero = String(f.numero ?? "").trim();
  if (!numero) return 0;
  try {
    const patron = `%${numero.replace(/^0+(?=\d)/, "").replace(/[%_\\]/g, "").slice(0, 20)}%`;
    const { data, error } = await sb.from("facturas").select("id, total, estado, sunat_estado, numero, cliente_id, moneda, nota_credito_ref")
      .eq("es_nota_credito", true).ilike("nota_credito_ref", patron).limit(50);
    if (error) return 0;
    const mon = normalizarMoneda(f.moneda as string | null | undefined);
    let suma = 0;
    for (const n of (data ?? []) as { id: number; total: unknown; estado: unknown; sunat_estado: unknown; numero: unknown; cliente_id: unknown; moneda: unknown; nota_credito_ref: unknown }[]) {
      if (Number(n.id) === Number(f.id)) continue;
      if (String(n.estado ?? "") === "anulada" || String(n.sunat_estado ?? "") !== "aceptada" || !String(n.numero ?? "").trim()) continue;
      if (String(n.cliente_id ?? "") !== String(f.cliente_id ?? "") || normalizarMoneda(n.moneda as string | null | undefined) !== mon) continue;
      if (!mismaReferencia(n.nota_credito_ref, f.serie, f.numero)) continue;
      suma += Math.abs(num(n.total) ?? 0);
    }
    return r2(suma);
  } catch { return 0; }
}

export type ResultadoCargo = {
  ok: boolean;
  id: number | null;
  creado: boolean;
  codigo: CodigoCargo | null;
  detalle: string;
  /** Lo que hay que decirle a quien pulsó (null = nada): un fallo, o un comprobante emitido que ya no corresponde. */
  aviso: string | null;
};

/**
 * El comprobante del cargo retenido (decisión del dueño), AL DÍA con el dinero de hoy: cuando lo
 * devuelto es menor que lo cobrado, una fila de `facturas` SIN número (`filaFacturaCargo`; `total`
 * es una columna generada y no se inserta), atada a la solicitud por los dos lados. Mientras no
 * tenga número se RECALCULA (`juzgarCargo`: un cobro registrado o anulado después cambia lo
 * retenido) y, si ya no se retiene nada, se retira (queda «anulada» y se desata). Uno emitido no se
 * toca: `aviso` pide la nota de crédito o el comprobante por la diferencia. Idempotente; dos
 * llamadas a la vez no crean dos (índice único de reservas-09d, o el UPDATE condicional de la
 * solicitud). Nunca toca la reserva ni `planDeCancelacion`. Nunca lanza.
 */
export async function asegurarComprobanteCargo(sb: Sb, solicitudId: number, deps: DepsReserva = {}): Promise<ResultadoCargo> {
  const fin = (r: Partial<ResultadoCargo> & { detalle: string }): ResultadoCargo => ({ ok: true, id: null, creado: false, codigo: null, aviso: null, ...r });
  try {
    const s = await leerSolicitud(sb, solicitudId);
    if (!s) return fin({ ok: false, detalle: "La solicitud no existe.", aviso: "La solicitud no existe." });
    if (s.estado !== "cancelada" && s.estado !== "sin_unidad") return fin({ detalle: "La solicitud no está cerrada." });
    const pct = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
    if (pct == null) return fin({ detalle: "Todavía no se decidió la devolución." });
    const cc = await contextoCotizacion(sb, s.cotizacion_id);
    const tramos = await tramosDeCotizacion(sb, s.cotizacion_id);
    const pagos = await pagosDeSolicitud(sb, s, tramos.map((t) => t.id));
    const { cobrado } = dineroDeSolicitud(pagos, cc.moneda);
    const aDevolver = devolucionDecidida(cobrado, pct);
    const retenido = cargoRetenido({ cobrado, devuelto: aDevolver });
    const actual = await cargoDeSolicitud(sb, s, cc.fila.id);
    const fila = actual.fila;
    const notas = fila && !cargoEditable(fila) ? await notasCreditoDe(sb, fila) : 0;
    const j = juzgarCargo({ retenido, actual: fila, notasCredito: notas, moneda: cc.moneda });
    // Sin reservas-09d el comprobante se encontró por un TEXTO de sus observaciones, que cualquier
    // sesión puede escribir: sirve para no crear otro, pero el servidor no lo reescribe, ni lo anula,
    // ni lo ata (sería tocar la factura que eligió otra persona).
    if ("por" in actual && actual.por === "marca") {
      const aviso = `Hay un comprobante del cargo en Facturación (#${fila!.id}), pero sin supabase/reservas-09d-cargo-solicitud.sql el ERP no lo recalcula ni lo ata: corre ese SQL o revísalo a mano en /facturacion.`;
      return fin({ id: fila!.id, codigo: j.codigo === "al_dia" ? "al_dia" : j.codigo, detalle: aviso, aviso: j.codigo === "al_dia" ? null : aviso });
    }
    const datosMarca = { solicitudId: s.id, cobrado, devuelto: aDevolver, retenido, moneda: cc.moneda };

    /** Ata el comprobante a la solicitud si todavía no lo está (UPDATE condicional). */
    const atar = async (id: number): Promise<number> => {
      if (Number(s.factura_cargo_id) === id) return id;
      const { data: up, error: eUp } = await sb.from(TABLA_SOLICITUDES).update({ factura_cargo_id: id }).eq("id", s.id).is("factura_cargo_id", null).select("id");
      if (eUp && eUp.code !== "23505") throw new Error(`No se pudo atar el comprobante del cargo a la solicitud: ${eUp.message}`);
      if ((up ?? []).length) return id;
      const otra = await leerSolicitud(sb, s.id);
      return otra?.factura_cargo_id ? Number(otra.factura_cargo_id) : id;
    };

    switch (j.codigo) {
      case "nada":
        return fin({ codigo: j.codigo, detalle: j.detalle });
      case "al_dia":
      case "anulado":
        return fin({ id: await atar(fila!.id), codigo: j.codigo, detalle: j.detalle });
      case "ajustar_emitido":
        return fin({ id: await atar(fila!.id), codigo: j.codigo, detalle: j.detalle, aviso: j.detalle });
      case "actualizar": {
        const patch = patchCargoRecalculado(fila!, datosMarca);
        const { data: up, error } = await sb.from("facturas").update(patch).eq("id", fila!.id).is("numero", null).eq("estado", "pendiente").select("id");
        if (error) throw new Error(`No se pudo recalcular el comprobante del cargo: ${error.message}`);
        const id = await atar(fila!.id);
        if (!(up ?? []).length) {
          const aviso = "El comprobante del cargo se emitió (o cambió) mientras se recalculaba: revísalo en /facturacion.";
          return fin({ id, codigo: j.codigo, detalle: aviso, aviso });
        }
        return fin({ id, codigo: j.codigo, detalle: `${j.detalle} Quedó en ${r2(retenido)} ${cc.moneda}.` });
      }
      case "retirar": {
        const obs = `${String(fila!.observaciones ?? "").trim()} Retirado por el ERP: ya no se retiene nada de la solicitud #${s.id}.`.trim();
        let patch: Record<string, unknown> = { estado: "anulada", observaciones: obs, reserva_solicitud_id: null };
        let r = await sb.from("facturas").update(patch).eq("id", fila!.id).is("numero", null).eq("estado", "pendiente").select("id");
        if (r.error && faltaColumna(r.error, "reserva_solicitud_id")) {
          const { reserva_solicitud_id: _q, ...sin } = patch; void _q; patch = sin;
          r = await sb.from("facturas").update(patch).eq("id", fila!.id).is("numero", null).eq("estado", "pendiente").select("id");
        }
        if (r.error) throw new Error(`No se pudo retirar el comprobante del cargo: ${r.error.message}`);
        if (!(r.data ?? []).length) {
          const aviso = "El comprobante del cargo se emitió (o cambió) mientras se retiraba: revísalo en /facturacion.";
          return fin({ id: fila!.id, codigo: j.codigo, detalle: aviso, aviso });
        }
        await sb.from(TABLA_SOLICITUDES).update({ factura_cargo_id: null }).eq("id", s.id).eq("factura_cargo_id", fila!.id);
        return fin({ id: null, codigo: j.codigo, detalle: j.detalle });
      }
      case "crear": {
        const armado = filaFacturaCargo({
          solicitudId: s.id, cotizacion: { id: cc.fila.id, numero: cc.numero, moneda: cc.fila.moneda, tipo_cambio: cc.fila.tipo_cambio },
          cliente: cc.cliente ? { id: cc.cliente.id, ruc: cc.cliente.ruc } : null, reservaId: s.reserva_id ?? null,
          cobrado, devuelto: aDevolver, hoy: fechaLima(ahoraDe(deps)), servicio: { fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida },
        });
        if (!armado) return fin({ codigo: "nada", detalle: "No se retiene nada: no hace falta comprobante." });
        const conCol = !("conColumna" in actual) || actual.conColumna;
        let ins = await sb.from("facturas").insert(conCol ? { ...armado.fila, reserva_solicitud_id: s.id } : armado.fila).select("id").single();
        if (ins.error && conCol && faltaColumna(ins.error, "reserva_solicitud_id")) ins = await sb.from("facturas").insert(armado.fila).select("id").single();
        if (ins.error && ins.error.code === "23505") {
          // Otra llamada lo creó a la vez (índice único de reservas-09d): se toma el suyo.
          const ganador = await cargoDeSolicitud(sb, s, cc.fila.id);
          if (ganador.fila) return fin({ id: await atar(ganador.fila.id), codigo: "al_dia", detalle: "Otra llamada creó el comprobante del cargo a la vez." });
        }
        if (ins.error || !ins.data) throw new Error(`No se pudo crear el comprobante del cargo: ${msg(ins.error)}`);
        const id = Number(ins.data.id);
        const atado = await atar(id);
        if (atado !== id) {
          // Sin el índice (base sin reservas-09d) dos llamadas pueden crear dos: se borra el propio.
          try { await sb.from("facturas").delete().eq("id", id); } catch { /* queda una fila sin número: la marca la delata */ }
          return fin({ id: atado, codigo: "al_dia", detalle: "Otra llamada creó el comprobante del cargo a la vez." });
        }
        return fin({ id, creado: true, codigo: j.codigo, detalle: `Comprobante del cargo creado (sin número): retenido ${r2(armado.total)} ${cc.moneda}.` });
      }
    }
  } catch (e) {
    const causa = seguro(e, "asegurarComprobanteCargo", "");
    const aviso = `El comprobante del cargo no se pudo poner al día: revísalo en /facturacion.${causa ? ` (${causa})` : ""}`;
    return { ok: false, id: null, creado: false, codigo: null, detalle: aviso, aviso };
  }
}

/** Las cancelaciones cerradas que se miran en el tick (por si su cargo quedó viejo). NO medido. */
const DIAS_CARGOS_TICK = 60;
const MAX_CARGOS_TICK = 40;

/**
 * El tick (cada 10 min): pone al día el comprobante del cargo de las cancelaciones con devolución
 * parcial de estos días — un cobro anulado en Finanzas no pasa por la tarjeta, y su cargo quedaría
 * con el importe viejo. Best-effort: nunca lanza; devuelve cuántas miró y cuántas cambió.
 */
export async function sincronizarCargosDeCancelaciones(sb: Sb, deps: DepsReserva = {}): Promise<{ miradas: number; cambiadas: number; avisos: string[] }> {
  const out = { miradas: 0, cambiadas: 0, avisos: [] as string[] };
  try {
    const desde = new Date(ahoraDe(deps) - DIAS_CARGOS_TICK * 86_400_000).toISOString();
    const { data, error } = await sb.from(TABLA_SOLICITUDES).select("id").eq("estado", "cancelada").lt("devolucion_pct", 100).gte("cerrada_en", desde).order("cerrada_en", { ascending: false }).order("id", { ascending: false }).limit(MAX_CARGOS_TICK);
    if (error) { out.avisos.push(`No se pudieron leer las cancelaciones: ${error.message}`); return out; }
    for (const f of (data ?? []) as { id: number }[]) {
      out.miradas++;
      const r = await asegurarComprobanteCargo(sb, Number(f.id), deps);
      if (r.creado || r.codigo === "actualizar" || r.codigo === "retirar") out.cambiadas++;
      if (!r.ok && r.aviso) out.avisos.push(`#${f.id}: ${r.aviso}`);
    }
  } catch (e) { out.avisos.push(seguro(e, "sincronizarCargosDeCancelaciones")); }
  return out;
}

/** «Cerrar» (duplicada, el cliente desistió, decisión del ejecutivo). Sin cobros, sin reserva viva y sin un pago reportado sin resolver. */
export async function cerrarSolicitud(sb: Sb, c: Cadena, quien: Quien, motivo: unknown, notaTxt: unknown, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  const m = (["duplicada", "cliente", "ejecutivo"] as MotivoCierre[]).includes(motivo as MotivoCierre) ? (motivo as MotivoCierre) : null;
  if (!m) return res("datos_invalidos", "Elige el motivo del cierre: duplicada, el cliente desistió o decisión del ejecutivo.");
  if (!puedePasar(s.estado, "cancelada")) return res("transicion_invalida", `La solicitud está «${s.estado}».`);
  let h: Hechos;
  try {
    if (await reservaViva(sb, s.cotizacion_id)) return res("cancelar_en_programacion", "La reserva sigue viva en Programación: cancélala ahí primero.");
    h = await leerHechos(sb, s);
  } catch (e) { return res("error", seguro(e, "cerrarSolicitud/leer")); }
  const { cobrado } = dineroDeSolicitud(h.pagos, h.cc?.moneda ?? "PEN");
  if (cobrado > 0) return res("con_cobros", "La solicitud tiene cobros registrados: no se cierra, se resuelve como cancelación (con su devolución).");
  const noEncontrado = !!(c.accion?.payload as { pago_no_encontrado?: unknown } | null)?.pago_no_encontrado;
  if (comprobantesQueCuentan(h) > 0 && !noEncontrado) return res("pago_sin_registrar", "El cliente reportó un pago: que Tesorería lo registre o marque «No encontré el pago» antes de cerrar.");
  const n = lineaCorta(notaTxt, 500);
  const notaFinal = n ? [s.nota, `Cierre: ${n}`].filter(Boolean).join("\n").slice(0, 2000) : s.nota;
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "cancelada", cierre_motivo: m, cerrada_en: new Date(ahoraDe(deps)).toISOString(), cerrada_por: quien.id, nota: notaFinal })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", crudo("No se pudo cerrar la solicitud", error));
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return res("ok", "Solicitud cerrada.", { estado: "cancelada" });
}

/**
 * Ata un cliente del ERP a la cotización y a sus reservas (solo donde no hay otro) y, SOLO si su
 * número completo (teléfono u operativo) es el wa_id del chat, también al contacto del CRM
 * (`vinculoContactoReserva`). Atar el contacto es lo que después deja mandarle al chat los datos del
 * cliente (la Confirmación de Reserva) y reconocerle el crédito: un cliente elegido a mano cuyo
 * número no es el del chat queda en la cotización, y la respuesta dice que el contacto quedó sin
 * vincular (se vincula a mano desde el panel del cliente del CRM, si es el mismo).
 */
export async function vincularCliente(sb: Sb, c: Cadena, clienteIdPedido: unknown): Promise<ResultadoAccionReserva> {
  const clienteId = num(clienteIdPedido);
  if (!clienteId || !Number.isInteger(clienteId)) return res("datos_invalidos", "Elige un cliente del ERP.");
  if (esEstadoTerminal(c.s.estado) && c.s.estado !== "completada") return res("transicion_invalida", `La solicitud está «${c.s.estado}».`);
  let cli = await sb.from("clientes").select("id, telefono, operativo_celular").eq("id", clienteId).maybeSingle();
  if (cli.error && faltaColumna(cli.error, "operativo_celular")) cli = await sb.from("clientes").select("id, telefono").eq("id", clienteId).maybeSingle();
  if (cli.error) return res("error", crudo("No se pudo leer el cliente", cli.error));
  if (!cli.data) return res("no_existe", "Ese cliente no existe.");
  const { data: cot, error: e2 } = await sb.from("cotizaciones").select("id, cliente_id").eq("id", c.s.cotizacion_id).maybeSingle();
  if (e2) return res("error", crudo("No se pudo leer la cotización", e2));
  if (!cot) return res("no_existe", "La cotización de la solicitud ya no existe.");
  if (cot.cliente_id != null && Number(cot.cliente_id) !== clienteId) return res("datos_invalidos", "La cotización ya tiene otro cliente: corrígelo en /cotizaciones.");
  const vinc = vinculoContactoReserva({ clienteId, cliente: cli.data, contacto: c.contacto });
  const fallos: string[] = [];
  const u1 = await sb.from("cotizaciones").update({ cliente_id: clienteId }).eq("id", c.s.cotizacion_id).is("cliente_id", null);
  if (u1.error) { seguro(u1.error, "vincularCliente/cotizacion"); fallos.push("la cotización"); }
  const u2 = await sb.from("reservas").update({ cliente_id: clienteId }).eq("cotizacion_id", c.s.cotizacion_id).is("cliente_id", null);
  if (u2.error) { seguro(u2.error, "vincularCliente/reservas"); fallos.push("sus reservas"); }
  if (vinc.ata && c.contacto?.id) {
    const u3 = await sb.from("crm_contactos").update({ cliente_id: clienteId }).eq("id", c.contacto.id).is("cliente_id", null);
    if (u3.error) { seguro(u3.error, "vincularCliente/contacto"); fallos.push("el contacto del CRM"); }
  }
  if (fallos.length) return res("error", `El cliente no se ató en todos lados (falló: ${fallos.join(", ")}). Vuelve a intentar en un momento.`);
  const contacto = vinc.codigo === "telefono" || vinc.codigo === "operativo" ? " y al contacto del CRM (su número es el de este chat)"
    : vinc.codigo === "ya_vinculado" ? " (el contacto del CRM ya era de este cliente)"
      : vinc.codigo === "otro_cliente" ? ". El contacto del CRM es de OTRO cliente y no se tocó: la Confirmación de Reserva no se le enviará por el chat"
        : vinc.codigo === "sin_contacto" ? ". La conversación no tiene contacto del CRM"
          : ". El contacto del CRM quedó SIN vincular: el número del cliente no es el de este chat, así que la Confirmación de Reserva (con sus datos) no se le enviará por WhatsApp. Si es el mismo cliente, vincúlalo en el panel del cliente del CRM";
  return res("ok", `Cliente vinculado a la cotización y sus reservas${contacto}.`);
}

/**
 * «Emitir y enviar Confirmación»: emite la versión vigente (la misma de /api/reservas/confirmacion)
 * y, SOLO dentro de la ventana de 24 h y SOLO si el cliente de la reserva está VERIFICADO para el
 * wa_id del chat (`clienteVerificadoEnChat`, la regla del PDF: vinculado al contacto o con su número
 * completo), manda su PDF por WhatsApp (copia en `crm-media`, enlace firmado): el documento lleva los
 * datos del cliente. Enviada, la solicitud pasa a `completada` y la tarjeta a `aprobada`. Fuera de
 * la ventana, o sin verificar, devuelve la versión para descargarla y mandarla por wa.me (sin
 * verificar, con el bloqueo `cliente_no_verificado` y su motivo).
 */
export async function enviarConfirmacionReserva(
  sb: Sb, c: Cadena, quien: Quien, x: { idioma?: unknown; extras?: Partial<ExtrasConf> | null }, deps: DepsReserva = {},
): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (s.estado !== "confirmada") return res("transicion_invalida", `La solicitud está «${s.estado}»: la Confirmación se envía con la unidad confirmada.`);
  if (!s.reserva_id) return res("transicion_invalida", "La reserva no se llegó a crear en Programación: vuelve a pulsar «Hay unidad».");
  const ahora = ahoraDe(deps);
  const sx = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  const extras: ExtrasConf = {
    // El vuelo que dio la IA solo si es un código de vuelo (`RE_VUELO`): una solicitud de antes pudo
    // guardar otro texto, y la Confirmación lo imprime.
    vuelo: sx(x.extras?.vuelo, 40) ?? (s.vuelo && RE_VUELO.test(s.vuelo) ? s.vuelo : null), punto_encuentro: sx(x.extras?.punto_encuentro, 120), nota: sx(x.extras?.nota, 300),
    incluir_telefono_conductor: x.extras?.incluir_telefono_conductor === true,
  };
  let version: { id: number; version: number; codigo: string };
  let verificado = false;
  const waId = c.contacto?.wa_id ? String(c.contacto.wa_id) : null;
  try {
    const { entrada, sinMigracion } = await leerEntrada(sb, s.reserva_id, extras);
    if (sinMigracion) return res("sin_migracion", "Falta correr supabase/reservas-08-confirmacion-reserva.sql.");
    const juicio = juzgarConfirmacion(entrada);
    if (!juicio.ok || !juicio.datos || !juicio.idDocumento) return res("bloqueada", "La Confirmación de Reserva todavía no se puede emitir.", { bloqueos: juicio.bloqueos.map((b) => ({ codigo: String(b.codigo), detalle: b.detalle })) });
    const v = await emitirVersion(sb, juicio.idDocumento, juicio.datos, quien);
    version = { id: v.id, version: v.version, codigo: v.codigo };
    // El cliente de la reserva (el del primer tramo, el que imprime la Confirmación).
    verificado = clienteVerificadoEnChat(entrada.tramos[0]?.cliente_id, entrada.cliente as ClienteChat | null, { contactoClienteId: c.contacto?.cliente_id ?? null, waId });
  } catch (e) { return res("error", seguro(e, "enviarConfirmacionReserva/emitir", "No se pudo emitir la Confirmación de Reserva. Vuelve a intentar en un momento.")); }
  // El idioma: el que eligió quien envía y, si no eligió, el de la cotización (su `idioma_pdf`).
  const idioma = x.idioma != null && String(x.idioma).trim() !== "" ? normalizarIdioma(x.idioma) : await idiomaDeCotizacion(sb, s.cotizacion_id);
  const caption = captionConfirmacion(idioma, version.codigo);
  const pdfUrl = `/api/reservas/confirmacion?version_id=${version.id}&idioma=${idioma}&pdf=1`;
  const verRes = { ...version, pdf: pdfUrl };
  if (!c.conv || c.conv.canal !== "whatsapp" || !waId) return res("fuera_de_ventana", "La conversación no es de WhatsApp: descarga la Confirmación y envíala.", { version: verRes, enviado: false, fueraDeVentana: { texto: version.codigo, waMe: null, cerroEn: null } });
  if (!verificado) {
    const texto = caption;
    const motivo = "El cliente de la reserva no está vinculado a este contacto del CRM y su teléfono no es el número de este chat: la Confirmación lleva sus datos y no se envía sola por WhatsApp. Comprueba que sea el mismo cliente, descárgala y mándala por wa.me (o vincúlalo en el panel del cliente del CRM).";
    return res("fuera_de_ventana", `Confirmación ${version.codigo} emitida, pero no se envió por el chat. ${motivo}`, {
      version: verRes, enviado: false, fueraDeVentana: { texto, waMe: enlaceWaMe(waId, texto), cerroEn: null },
      bloqueos: [{ codigo: "cliente_no_verificado", detalle: motivo }],
    });
  }
  let ult: { created_at: string } | null = null;
  try { ult = await ultimoEntrante(sb, c.conv.id); } catch { ult = null; }
  const v24 = ventana24h(ult?.created_at ?? null, ahora);
  if (!v24.abierta) {
    const texto = caption;
    return res("fuera_de_ventana", "Pasaron más de 24 h desde el último mensaje del cliente: descarga la Confirmación y envíala por wa.me.", { version: verRes, enviado: false, fueraDeVentana: { texto, waMe: enlaceWaMe(waId, texto), cerroEn: v24.cierraEn } });
  }
  let metaId: string | null = null, errorEnvio: string | null = null, mediaUrl: string | null = null, nombre = "";
  try {
    const pdf = await (deps.pdfConfirmacion ?? pdfDeVersion)(sb, { ...(await versionCompleta(sb, version.id)) }, idioma);
    nombre = pdf.nombre;
    await (deps.asegurarBucket ?? asegurarBucketCrm)(sb);
    const ruta = `confirmaciones/${s.reserva_id}/${version.codigo.replace(/[^A-Za-z0-9-]/g, "")}-${(deps.uuid ?? randomUUID)()}.pdf`;
    const up = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, pdf.bytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw new Error(crudo("No se pudo guardar el PDF de la Confirmación", up.error));
    mediaUrl = sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
    const firmada = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUrl(ruta, TTL_URL_META);
    const url = firmada?.data?.signedUrl as string | undefined;
    if (!url) throw new Error("No se pudo firmar el enlace del PDF.");
    const phoneId = c.conv.phone_number_id ?? (await (deps.phonePara ?? phoneParaUso)("crm"));
    metaId = await (deps.enviarMedia ?? enviarWhatsAppMedia)(waId, "document", url, caption, { phoneId, filename: nombre });
    if (!metaId) errorEnvio = "Meta no devolvió el id del mensaje.";
  } catch (e) {
    errorEnvio = explicarErrorEnvioWhatsApp(msg(e));
  }
  try {
    await sb.from("crm_mensajes").insert({
      conversacion_id: c.conv.id, direccion: "saliente", tipo: "document", contenido: nombre || caption,
      media_url: mediaUrl, meta_message_id: metaId, generado_por_ia: true, enviado_por: quien.id, error: errorEnvio,
    });
    await sb.from("crm_conversaciones").update({ ultimo_mensaje_at: new Date(ahora).toISOString() }).eq("id", c.conv.id);
  } catch { /* el mensaje del hilo es constancia */ }
  if (errorEnvio) return { ...res("envio_fallido", `La Confirmación ${version.codigo} se emitió pero no salió por WhatsApp: ${errorEnvio}`, { version: verRes, enviado: false }), ok: false };
  const at = new Date(ahora).toISOString();
  await sb.from(TABLA_SOLICITUDES).update({ estado: "completada", cerrada_en: at, cerrada_por: quien.id }).eq("id", s.id).eq("estado", "confirmada");
  if (c.accion) {
    await sb.from("crm_acciones_ia").update({
      estado: "aprobada", resuelta_at: at, resuelta_por: quien.id,
      payload: { ...(c.accion.payload ?? {}), confirmacion_enviada: { version: version.version, codigo: version.codigo, at, por: quien.id, meta_message_id: metaId } },
    }).eq("id", c.accion.id).eq("estado", "pendiente");
  }
  return res("ok", `Confirmación ${version.codigo} enviada al cliente.`, { estado: "completada", version: verRes, enviado: true });
}

async function versionCompleta(sb: Sb, id: number) {
  const { data, error } = await sb.from("reserva_confirmaciones").select("id, version, codigo, generado_en, datos").eq("id", id).maybeSingle();
  if (error || !data) throw new Error(`No se pudo leer la Confirmación emitida: ${error?.message ?? "no existe"}`);
  return data as { version: number; codigo: string; generado_en: string; datos: Parameters<typeof pdfDeVersion>[1]["datos"] };
}

/** La Confirmación se mandó por wa.me (fuera de la ventana): la solicitud pasa a `completada`. */
export async function marcarConfirmacionEnviada(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (s.estado !== "confirmada") return res("transicion_invalida", `La solicitud está «${s.estado}».`);
  let h: Hechos;
  try { h = await leerHechos(sb, s); } catch (e) { return res("error", seguro(e, "marcarConfirmacionEnviada")); }
  if (!h.versiones.length) return res("transicion_invalida", "Todavía no se emitió ninguna Confirmación de Reserva.");
  const at = new Date(ahoraDe(deps)).toISOString();
  const { data } = await sb.from(TABLA_SOLICITUDES).update({ estado: "completada", cerrada_en: at, cerrada_por: quien.id }).eq("id", s.id).eq("estado", "confirmada").select("id");
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  if (c.accion) {
    await sb.from("crm_acciones_ia").update({
      estado: "aprobada", resuelta_at: at, resuelta_por: quien.id,
      payload: { ...(c.accion.payload ?? {}), confirmacion_enviada: { version: h.versiones[0].version, codigo: h.versiones[0].codigo, at, por: quien.id, manual: true } },
    }).eq("id", c.accion.id).eq("estado", "pendiente");
  }
  return res("ok", "Solicitud completada.", { estado: "completada" });
}

// ── 10. Dinero (Tesorería / Finanzas) ────────────────────────────────────────

/** El comprobante que mandó el cliente (identificador del archivo), el más reciente. null si no hay. */
async function comprobanteUrlDe(sb: Sb, solicitudId: number): Promise<string | null> {
  try {
    const comps = await comprobantesDe(sb, solicitudId);
    const id = comps.find((k) => k.mensaje_id)?.mensaje_id;
    if (!id) return null;
    const { data } = await sb.from("crm_mensajes").select("media_url").eq("id", id).maybeSingle();
    return (data?.media_url as string) ?? null;
  } catch { return null; }
}

/**
 * Registra el ADELANTO de una solicitud (Tesorería, al ver el dinero en el banco): un `pagos` cobro
 * con `reserva_solicitud_id` (y `reserva_id` si la reserva ya existe), con las MISMAS validaciones
 * del route de la Confirmación (`validarCobro`). Tope: el total de la cotización menos lo cobrado;
 * dos registros a la vez se releen y, si juntos se pasan, se anula el propio. Si la solicitud ya
 * estaba cancelada o sin unidad, se asegura el comprobante del cargo (si ahora se retiene algo).
 */
export async function registrarAdelantoSolicitud(sb: Sb, c: Cadena, cuerpo: Record<string, unknown>, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (s.estado === "completada") return res("transicion_invalida", "La solicitud ya está completada: un cobro nuevo se registra en la Confirmación de Reserva.");
  let cc: ContextoCotizacion, h: Hechos;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s); } catch (e) { return res("error", seguro(e, "registrarAdelantoSolicitud/leer")); }
  const total = adelantoDe(cc.fila, null)?.total ?? null;
  if (total == null || !(total > 0)) return res("error", `La cotización N° ${cc.numero} no tiene un total en su moneda: no se puede registrar un adelanto contra él.`);
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const v = validarCobro(cuerpo, {
    hoyMs: ahoraDe(deps), tope: total - cobrado,
    textoTope: `Con este cobro se pasaría del total de la cotización (${cc.moneda} ${total.toFixed(2)}; ya cobrado ${cobrado.toFixed(2)}).`,
  });
  if (!v.ok) return res("datos_invalidos", v.detalle);
  const reservaId = s.reserva_id ?? null;
  const tramos = h.tramos.map((t) => t.id);
  let r: { id: number; codigo: string | null };
  try {
    r = await registrarAdelanto(sb, reservaId, cc.cliente?.id ?? null, { monto: v.monto, moneda: cc.moneda, fecha: v.fecha, metodo: v.metodo, referencia: v.referencia },
      quien.nombre ?? quien.id, { reservaSolicitudId: s.id, tramos, comprobanteUrl: await comprobanteUrlDe(sb, s.id) });
  } catch (e) {
    const m = seguro(e, "registrarAdelantoSolicitud");
    return res(/^Falta correr/.test(m) ? "sin_migracion" : "error", /^(Falta|No se pudo registrar)/.test(m) ? m : "No se pudo registrar el cobro. Vuelve a intentar en un momento.");
  }
  // Releer: dos registros a la vez pueden pasar los dos el tope.
  try {
    const despues = await pagosDeSolicitud(sb, s, tramos);
    if (dineroDeSolicitud(despues, cc.moneda).cobrado > total + 0.005) {
      await sb.from("pagos").update({ anulado: true }).eq("id", r.id);
      return res("reclamo_perdido", "Otro cobro se registró a la vez y juntos superan el total: este no se guardó. Revisa los cobros y vuelve a intentar.");
    }
  } catch { /* el cobro quedó; el control de tope lo vuelve a hacer el siguiente registro */ }
  const avisos: string[] = [];
  if (s.estado === "cancelada" || s.estado === "sin_unidad") {
    // Un cobro que entra después de la cancelación cambia lo retenido: el cargo se pone al día.
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (cargo.aviso) avisos.push(cargo.aviso);
  }
  await nota(sb, s.crm_conversacion_id, `🏦 ${quien.nombre ?? "Tesorería"} registró el adelanto ${r.codigo ?? `#${r.id}`}: ${v.monto.toFixed(2)} ${cc.moneda} (${v.metodo ?? "sin medio"}${v.referencia ? ` · op. ${v.referencia}` : ""}) de la solicitud #${s.id}.`);
  return res("ok", `Adelanto registrado (${r.codigo ?? `#${r.id}`}).`, { estado: s.estado, avisos });
}

/**
 * «No encontré el pago» (Tesorería): queda en la tarjeta (ámbar) y en una nota; el ejecutivo le manda
 * T9. El payload se relee JUSTO antes de escribir y se mezcla sobre lo recién leído (no sobre la
 * tarjeta que se leyó al empezar la petición), con UPDATE condicional a que siga `pendiente`: así no
 * se pisa lo que otra acción escribió entre medio ni se toca una tarjeta ya cerrada.
 */
export async function marcarPagoNoEncontrado(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  if (esEstadoTerminal(c.s.estado)) return res("transicion_invalida", `La solicitud está «${c.s.estado}».`);
  if (!c.accion) return res("error", "La solicitud no tiene tarjeta en la bandeja.");
  let fresca: AccionFila | null;
  try { fresca = await leerAccion(sb, c.accion.id); } catch (e) { return res("error", seguro(e, "marcarPagoNoEncontrado/leer")); }
  if (!fresca || fresca.estado !== "pendiente") return res("reclamo_perdido", "La tarjeta ya no está pendiente: recárgala.");
  const at = new Date(ahoraDe(deps)).toISOString();
  const { data, error } = await sb.from("crm_acciones_ia")
    .update({ payload: { ...(fresca.payload ?? {}), pago_no_encontrado: { at, por: quien.nombre ?? quien.id } } })
    .eq("id", fresca.id).eq("estado", "pendiente").select("id");
  if (error) return res("error", crudo("No se pudo marcar el pago como no encontrado", error));
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta tarjeta: recárgala.");
  await nota(sb, c.s.crm_conversacion_id, `🏦 ${quien.nombre ?? "Tesorería"} NO encontró en el banco el pago reportado de la solicitud #${c.s.id}. Pídele al cliente que lo confirme desde la tarjeta («No encontramos el pago»).`);
  return res("ok", "Marcado: no se encontró el pago.", { estado: c.s.estado });
}

/**
 * Registra la DEVOLUCIÓN (Tesorería, al hacer la transferencia): un `pagos` con `sentido = 'pago'` y
 * `reserva_solicitud_id`. Solo con la solicitud cerrada (sin unidad o cancelada) y la devolución
 * decidida, y nunca por más de lo que falta devolver.
 */
export async function registrarDevolucionSolicitud(sb: Sb, c: Cadena, cuerpo: Record<string, unknown>, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  const s = c.s;
  if (s.estado !== "cancelada" && s.estado !== "sin_unidad") return res("transicion_invalida", "Una devolución se registra con la solicitud cerrada (sin unidad o cancelada).");
  const pct = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
  if (pct == null) return res("transicion_invalida", "Todavía no se decidió cuánto se devuelve (lo resuelve el ejecutivo en la tarjeta).");
  let cc: ContextoCotizacion, h: Hechos;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s); } catch (e) { return res("error", seguro(e, "registrarDevolucionSolicitud/leer")); }
  const { cobrado, devuelto } = dineroDeSolicitud(h.pagos, cc.moneda);
  const aDevolver = devolucionDecidida(cobrado, pct);
  const v = validarCobro(cuerpo, {
    hoyMs: ahoraDe(deps), tope: aDevolver - devuelto,
    textoTope: `Con esta devolución se pasaría de lo que corresponde devolver (${cc.moneda} ${aDevolver.toFixed(2)}; ya devuelto ${devuelto.toFixed(2)}).`,
  });
  if (!v.ok) return res("datos_invalidos", v.detalle);
  let r: { id: number; codigo: string | null };
  try {
    r = await registrarDevolucion(sb, { solicitudId: s.id, clienteId: cc.cliente?.id ?? null, monto: v.monto, moneda: cc.moneda, fecha: v.fecha, metodo: v.metodo, referencia: v.referencia, quien: quien.nombre ?? quien.id });
  } catch (e) {
    const m = seguro(e, "registrarDevolucionSolicitud");
    return res(/^Falta correr/.test(m) ? "sin_migracion" : "error", /^(Falta|No se pudo registrar)/.test(m) ? m : "No se pudo registrar la devolución. Vuelve a intentar en un momento.");
  }
  try {
    const despues = await pagosDeSolicitud(sb, s, h.tramos.map((t) => t.id));
    if (dineroDeSolicitud(despues, cc.moneda).devuelto > aDevolver + 0.005) {
      await sb.from("pagos").update({ anulado: true }).eq("id", r.id);
      return res("reclamo_perdido", "Otra devolución se registró a la vez y juntas superan lo que corresponde: esta no se guardó.");
    }
  } catch { /* la devolución quedó */ }
  const avisos: string[] = [];
  {
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (cargo.aviso) avisos.push(cargo.aviso);
  }
  await nota(sb, s.crm_conversacion_id, `🏦 ${quien.nombre ?? "Tesorería"} registró la devolución ${r.codigo ?? `#${r.id}`}: ${v.monto.toFixed(2)} ${cc.moneda} de la solicitud #${s.id}.`);
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return res("ok", `Devolución registrada (${r.codigo ?? `#${r.id}`}).`, { estado: s.estado, avisos });
}

/** Las solicitudes cerradas que se miran (por si les falta una devolución): las tocadas en estos días. NO medido. */
const DIAS_CERRADAS_TESORERIA = 60;

/**
 * La lista de Tesorería: cada solicitud con su dinero y lo que le toca a Tesorería. `pendientes`:
 * solo las que tienen algo para Tesorería (verificar un pago reportado, registrar una devolución) o
 * un pago reportado; `todas`: las 200 más recientes. Paginado con orden total; LANZA si no se puede leer.
 */
export async function listaParaTesoreria(sb: Sb, x: { filtro: "pendientes" | "todas"; ahoraMs?: number }): Promise<{ filas: FilaTesoreria[]; avisos: string[] }> {
  const ahora = x.ahoraMs ?? Date.now();
  const sols: FilaSolicitud[] = [];
  if (x.filtro === "todas") {
    const { data, error } = await sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).order("creada_en", { ascending: false }).order("id", { ascending: false }).limit(200);
    if (error) throw new Error(`No se pudieron leer las solicitudes: ${error.message}`);
    sols.push(...((data ?? []) as FilaSolicitud[]));
  } else {
    const desde = new Date(ahora - DIAS_CERRADAS_TESORERIA * 86_400_000).toISOString();
    for (const [estados, conFecha] of [[ESTADOS_VIVOS, false], [["cancelada", "sin_unidad"], true]] as const) {
      for (let d = 0; ; d += 1000) {
        let q = sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).in("estado", [...estados]);
        if (conFecha) q = q.gte("actualizada_en", desde);
        const { data, error } = await q.order("id", { ascending: true }).range(d, d + 999);
        if (error) throw new Error(`No se pudieron leer las solicitudes: ${error.message}`);
        sols.push(...((data ?? []) as FilaSolicitud[]));
        if (!data || data.length < 1000) break;
      }
    }
  }
  const avisos: string[] = [];
  const filas: FilaTesoreria[] = [];
  for (const s of sols) {
    try {
      const h = await leerHechos(sb, s);
      let accion: AccionFila | null = null;
      try { accion = await leerAccion(sb, s.crm_accion_id); } catch { accion = null; }
      const { pendientes, cobrado, devuelto, moneda } = pendientesDe(s, h, accion);
      const adel = h.cc ? adelantoDe(h.cc.fila, pctDe(s)) : null;
      const pct = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
      const aDevolver = pct != null && (s.estado === "sin_unidad" || s.estado === "cancelada") ? devolucionDecidida(cobrado, pct) : null;
      const deTesoreria = pendientes.filter((p) => p.quien === "tesoreria");
      const pagoNo = !!(accion?.payload as { pago_no_encontrado?: unknown } | null)?.pago_no_encontrado;
      if (x.filtro === "pendientes" && !deTesoreria.length) continue;
      const ult = h.comprobantes[0];
      const cot = (ult?.cotejo ?? []);
      const lecturaSegura = cot.length === 1 && (cot[0] === "coincide" || cot[0] === "pago_total");
      filas.push({
        solicitudId: s.id, estado: s.estado, numero: h.cc?.numero ?? null, cliente: h.cc?.cliente?.nombre ?? null,
        servicio: { fecha: h.cc?.fila.fecha_servicio ?? null, hora: h.cc?.fila.hora_ida ?? null, origen: h.cc?.fila.origen ?? null, destino: h.cc?.fila.destino ?? null },
        moneda, total: adel?.total ?? null, adelanto: adel?.adelanto ?? null, cobrado, devuelto, aDevolver,
        comprobantes: h.comprobantes.length, ultimoMontoSeguro: lecturaSegura ? (ult?.lectura as LecturaComprobante | null)?.monto ?? null : null,
        pagoNoEncontrado: pagoNo, pendientesTesoreria: deTesoreria, creadaEn: s.creada_en, convId: s.crm_conversacion_id,
      });
    } catch (e) {
      avisos.push(`Solicitud #${s.id}: ${seguro(e, "listaParaTesoreria")}`);
    }
  }
  return { filas, avisos };
}

/**
 * La cotización de traslado más reciente de la conversación (para la guarda T10 del texto final), con
 * su idioma (`idioma_pdf`; sin la columna, castellano). null si no hay o si no se pudo leer (sin dato,
 * la guarda no salta: el texto sigue por `textoSinImportesAjenos`, que ya quita los importes ajenos).
 */
export async function cotizacionTrasladoDelChat(sb: Sb, convId: string): Promise<{ id: number; numero: string; idioma: Idioma } | null> {
  try {
    const leer = (cols: string) => sb.from("cotizaciones").select(cols).eq("crm_conversacion_id", convId)
      .not("traslado_json", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    let r = await leer("id, numero_cotizacion, idioma_pdf");
    if (r.error && faltaColumna(r.error, "idioma_pdf")) r = await leer("id, numero_cotizacion");
    const { data, error } = r;
    if (error || !data) return null;
    return {
      id: Number(data.id), numero: numeroCotizacion({ id: Number(data.id), numero_cotizacion: data.numero_cotizacion ?? null }),
      idioma: idiomaDeFila((data as { idioma_pdf?: unknown }).idioma_pdf),
    };
  } catch { return null; }
}

// ── 11. Lo que dice /crm/agente de la reserva ────────────────────────────────

/**
 * Para /api/crm/ia/estado: ¿la IA reserva de verdad (`estadoReservaIA(...).activa`)? y las líneas
 * distintas de la política de reserva de las plantillas que usa la IA. null si no se pudo leer.
 * Nunca lanza.
 */
export async function reservaEstadoIA(sb: Sb): Promise<{ reserva: boolean | null; politica_reserva: string[] | null; lineas: string[] | null; ambar: boolean | null }> {
  const nada = { reserva: null, politica_reserva: null, lineas: null, ambar: null };
  try {
    const cfgIA = await leerConfigIA(sb);
    // No se pudo leer la configuración (no es «falta la migración»): no se afirma nada.
    if (cfgIA.detalle && !cfgIA.sinMigracion) return nada;
    const agente = await leerAgente(sb);
    const autonomos: string[] = Array.isArray(agente?.canales_autonomos) ? (agente!.canales_autonomos as string[]) : [];
    const lp = await leerPlantillasYReglas(sb);
    let politica: string[] | null = null;
    // El resumen de la política (cotizaciones-08): el auditor y el cotejo con la configuración lo
    // miran junto a la política (lo manda la IA igual); no cuenta como «hay política».
    let resumen: string[] = [];
    let plantillaSoles: string | null = null;
    if (lp.ok) {
      const set = new Set<string>(), setRes = new Set<string>();
      // Las plantillas que usa la IA: con la regla idioma × moneda (cotizaciones-09), las de las dos
      // celdas en castellano (la política en inglés no la mira el auditor, que lee castellano); sin
      // ella, las de los tres segmentos, como antes.
      const usadas: { p: PlantillaFila | null; soles: boolean }[] = lp.reglasTraslado !== null
        ? CELDAS_TRASLADO.filter((c) => c.idioma === "es").map((c) => ({
          p: plantillaTrasladoIA(c, lp.plantillas, lp.reglasTraslado, { reglas: lp.reglas, segmento: segmentoDeCliente({ moneda: c.moneda }) }).plantilla,
          soles: c.moneda === "PEN",
        }))
        : SEGMENTOS.map((segmento) => ({ p: plantillaParaUso({ servicio: "traslado_ia", segmento }, lp.plantillas, lp.reglas).plantilla, soles: segmento === "particular" }));
      for (const { p, soles } of usadas) {
        if (soles) plantillaSoles = p?.id ?? null;
        const pp = p as { condiciones_reserva?: unknown; condiciones_reserva_resumen?: unknown } | null;
        const lineas = pp?.condiciones_reserva;
        let tiene = false;
        for (const l of Array.isArray(lineas) ? lineas : []) { const t = String(l ?? "").trim(); if (t) { set.add(t); tiene = true; } }
        const res = tiene ? pp?.condiciones_reserva_resumen : null;
        for (const l of Array.isArray(res) ? res : []) { const t = String(l ?? "").trim(); if (t && !set.has(t)) setRes.add(t); }
      }
      politica = [...set];
      resumen = [...setRes].filter((t) => !set.has(t));
    }
    const { perfil } = await leerPerfilPdf(sb);
    // Las cuentas en soles que imprimiría el PDF de un traslado (la plantilla de «particular»).
    const { usada } = await plantillaYReferenciaCuentas(sb, plantillaSoles);
    const cuentas = cuentasEnMensaje(usada, perfil, "PEN").cuentas.length;
    const correos = destinatariosReserva({ correoConfig: cfgIA.reserva.correo, emailEmpresa: perfil?.email ?? null }).correos;
    const est = estadoReservaIA({
      sinMigracion: cfgIA.reservaSinMigracion, cfg: cfgIA.reserva, iaCotiza: cfgIA.iaCotiza, agenteAutonomo: autonomos.includes("whatsapp"),
      atencionEnUso: atencionEnUso(atencionDeAgente(agente)), cuentas, correos, politicaLineas: politica?.length ?? 0,
      contradicciones: politicaContradiceConfig([...(politica ?? []), ...resumen], cfgIA.reserva).length,
    });
    // Encendida pero sin poder comprobar las tablas de reservas-09: no se afirma que esté activa.
    const reserva = cfgIA.reserva.activa && cfgIA.reservaDetalle && !cfgIA.reservaSinMigracion ? null : est.activa;
    return { reserva, politica_reserva: politica ? [...politica, ...resumen] : null, lineas: est.lineas, ambar: est.ambar };
  } catch {
    return nada;
  }
}

// Lo que reexporta el contrato del servidor para las rutas.
export { SQL_PAGOS_SOLICITUD };
export type { AccionTarjeta, AccionDinero };
