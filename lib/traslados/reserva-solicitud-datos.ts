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
// Matriz de punta a punta: ANTHROPIC_API_KEY=x npx tsx scripts/prueba-reserva-ia.mts
// ══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { faltaColumna, tablaFaltante } from "../columna-faltante";
import { fechaLima, limaAUtcMs } from "../alertas-horario";
import { normalizarAjustes, estiloDe, type EstiloMensajes } from "../crm-ia-ajustes";
import { atencionDe, atencionEnUso, type Atencion } from "../crm-ia-atencion";
import { leerPlantillasYReglas } from "../cotizacion-plantillas-datos";
import { plantillaParaUso, SEGMENTOS } from "../cotizacion-plantillas";
import { normalizarMoneda, type Moneda } from "../cotizacion-moneda";
import { numeroCotizacion } from "../cotizacion-corporativo";
import type { PlantillaPdfCfg } from "../cotizacion-pdf";
import type { PerfilEmpresa } from "../empresa-perfil";
import { objetoPrivadoDe } from "../storage-privado";
import { BUCKET_CRM_MEDIA, asegurarBucket as asegurarBucketCrm } from "../crm-media";
import { enviarWhatsAppMedia, explicarErrorEnvioWhatsApp } from "../crm-meta";
import { phonePara as phoneParaUso } from "../whatsapp-numeros";
import { enviarTextoCRM, type ResultadoEnvioTexto } from "../crm-enviar-texto";
import { ejecutarConversion, leerCotParaReserva } from "../cotizacion-a-reserva-datos";
import {
  emitirVersion, enlazarCobrosAReserva, leerEntrada, leerVersiones, pdfDeVersion, registrarAdelanto, registrarDevolucion,
  validarCobro, SQL_PAGOS_SOLICITUD,
} from "../confirmacion-reserva-datos";
import { esCredito, juzgarConfirmacion, normalizarIdioma, type ExtrasConf } from "../confirmacion-reserva";
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
  adelantoDe, cargoRetenido, cuentasEnMensaje, devolucionDecidida, dineroDeSolicitud, esEstadoTerminal, filaFacturaCargo,
  firmaImportes, marcaCargoReserva, mensajeCanceladaSinPago, mensajeCancelacionRegistrada, mensajeCancelacionResuelta,
  mensajeComprobanteRecibido, mensajeDisponibilidadPrimero, mensajeHayUnidad, mensajePagoNoEncontrado, mensajePedirPago,
  mensajePoliticas, mensajeSinUnidad, politicaContradiceConfig, puedePasar, queFalta,
  type Adelanto, type BloquePago, type ConfigReserva, type CuentasMensaje, type EstadoSolicitud, type PagoEnHayUnidad,
  type PagoSolicitud, type Pendiente,
} from "./reserva-pago";
import { TEXTO_COTEJO, cotejarComprobante, normalizarOperacion, type Cotejo, type LecturaComprobante } from "./comprobante-pago";
import { leerComprobantePago, type ResultadoLector } from "./comprobante-pago-ia";
import {
  decidirTopeReserva, elegirCotizacion, entradaReserva, estadoReservaIA, mensajePedirComprobante, respuestaReservaParaModelo,
  type AccionReserva, type CotizacionCandidata, type ResultadoReservaIA,
} from "./reserva-ia";
import { correoReserva, destinatariosReserva, type DatosCorreoReserva } from "./reserva-correo";
import { inicioServicioMs } from "./reserva-alertas";
import { leerConfigIA, SQL_RESERVA_TRASLADOS } from "./datos";
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
/** El tipo de la tarjeta del inbox. */
export const TIPO_ACCION_RESERVA = "reserva_traslado";

/** Los estados de una solicitud viva (los del índice único `uq_reserva_solicitudes_viva`). */
export const ESTADOS_VIVOS: readonly EstadoSolicitud[] = ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada"];
const ESTADOS_ABIERTOS_SIN_UNIDAD: readonly EstadoSolicitud[] = ["esperando_pago", "por_confirmar", "pago_reportado"];

/** Los tipos de mensaje que pueden ser un comprobante (los que lee el agente). */
const TIPOS_ARCHIVO = ["image", "document", "imagen"];
/** Sin solicitud ni cotización: cuánto atrás se busca la foto del comprobante. NO medido. */
const VENTANA_SIN_COTIZACION_MS = 48 * 3_600_000;
/** El adjunto del correo, hasta (Resend acepta 40 MB por correo; un comprobante pesa mucho menos). NO medido. */
const MAX_ADJUNTO_BYTES = 5 * 1024 * 1024;
/** El enlace firmado del PDF que baja Meta (s). */
const TTL_URL_META = 3600;
/** El enlace firmado para que el ejecutivo vea un comprobante (s). */
const TTL_URL_VER = 3600;

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
const atencionDeAgente = (agente: unknown): Atencion => atencionDe(normalizarAjustes((agente as { comportamiento?: unknown } | null)?.comportamiento));
const appUrlDe = (deps: DepsReserva) => (deps.appUrl !== undefined ? deps.appUrl : process.env.NEXT_PUBLIC_APP_URL ?? null);
const lineaCorta = (s: unknown, max = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

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

async function bajarArchivoPorDefecto(sb: Sb, url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const obj = objetoPrivadoDe(url);
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
  const [{ perfil }, pl] = await Promise.all([leerPerfilPdf(sb), plantillaYReferenciaCuentas(sb, fila.plantilla_pdf)]);
  const cuentas = cuentasEnMensaje(pl.usada, perfil, moneda);
  const frente = cuentasFrenteACorporativo({ plantilla: pl.usada, referencia: pl.referencia, empresa: perfil, moneda });
  const politica = (Array.isArray(fila.consideraciones_json?.reserva) ? fila.consideraciones_json!.reserva! : []).map((l) => String(l ?? "").trim()).filter(Boolean);
  const politicaSospechosa = condicionesSospechosas({ reserva: politica }).length > 0;
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
    let r = await sb.from("clientes").select("id, nombre, empresa, ruc, condicion_pago").eq("id", cliId).maybeSingle();
    if (r.error && faltaColumna(r.error, "condicion_pago")) r = await sb.from("clientes").select("id, nombre, empresa, ruc").eq("id", cliId).maybeSingle();
    if (r.error) throw new Error(`No se pudo leer el cliente de la cotización: ${r.error.message}`);
    if (r.data) {
      cliente = { id: Number(r.data.id), nombre: String(r.data.empresa || r.data.nombre || "").trim() || `Cliente ${r.data.id}`, ruc: r.data.ruc ?? null };
      credito = esCredito(r.data.condicion_pago);
    }
  }
  return {
    fila, numero: numeroCotizacion(fila), moneda, inicioMs: inicioServicioMs(fila), perfil, usada: pl.usada, referencia: pl.referencia,
    cuentas, frente, politica, politicaSospechosa, zonaEnvio, credito, cliente,
  };
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

async function contarLecturasHoy(sb: Sb, convId: string, hoy: string): Promise<{ conv: number | null; dia: number | null }> {
  const n = (r: { count?: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  const [a, b] = await Promise.all([
    sb.from("alerta_enviada").select("ref", { count: "exact", head: true }).eq("clave", CLAVE_LECTURA_COMPROBANTE).eq("fecha", hoy).like("ref", `conv:${convId}:%`),
    sb.from("alerta_enviada").select("ref", { count: "exact", head: true }).eq("clave", CLAVE_LECTURA_COMPROBANTE).eq("fecha", hoy),
  ]);
  return { conv: n(a), dia: n(b) };
}

// ── 4. El correo interno ─────────────────────────────────────────────────────

type EnvioCorreo = { enviado: boolean; error: string | null; destinatarios: string[] };

/** Manda el correo a los destinatarios de la reserva. Nunca lanza: el fallo vuelve en `error`. */
async function mandarCorreo(datos: DatosCorreoReserva, x: { correoConfig: string | null; emailEmpresa: string | null; adjunto?: { bytes: Uint8Array; mime: string; nombre: string } | null }, deps: DepsReserva): Promise<EnvioCorreo> {
  const dest = destinatariosReserva({ correoConfig: x.correoConfig, emailEmpresa: x.emailEmpresa });
  if (!dest.correos.length) return { enviado: false, error: "No hay a quién mandar el correo: escribe el correo de reservas en /tarifario → Zonas y traslados → Ajustes o en /configuracion/perfil.", destinatarios: [] };
  const c = correoReserva(datos);
  const attachments = x.adjunto && x.adjunto.bytes.length <= MAX_ADJUNTO_BYTES
    ? [{ filename: x.adjunto.nombre, content: Buffer.from(x.adjunto.bytes).toString("base64") }] : undefined;
  const errores: string[] = [];
  for (const to of dest.correos) {
    try { await (deps.enviarCorreo ?? enviarCorreoPorDefecto)({ to, subject: c.asunto, html: c.html, attachments }); }
    catch (e) { errores.push(`${to}: ${msg(e)}`); }
  }
  return { enviado: errores.length < dest.correos.length, error: errores.length ? errores.join(" · ").slice(0, 1900) : null, destinatarios: dest.correos };
}

const extDe = (mime: string) => (mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");

// ── 5. Crear la solicitud ────────────────────────────────────────────────────

export type CtxReservaIA = {
  sb: Sb;
  conv: ConvR;
  contacto: ContactoR;
  /** Copiado ANTES del bucle del agente: el canal y el wa_id del hilo. */
  remitente: { canal: string; waId: string | null };
  agente: { modelo?: unknown; comportamiento?: unknown } | null;
  /** El mismo `modoAuto` con que el agente decide si envía. */
  modoAuto: boolean;
  /** La configuración de la reserva (`leerConfigIA(...).reserva`), leída antes del bucle. */
  cfg: ConfigReserva;
  /** Herramientas de reserva usadas en ESTE turno. */
  turno: { n: number };
};

type Creada = { s: FilaSolicitud; cc: ContextoCotizacion; orden: OrdenReserva; adel: Adelanto; pct: number | null; accionId: string | null };

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
  catch (e) { return { ok: false, motivo: "No se pudo leer la cotización a reservar", nota: msg(e) }; }
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
  const accion = orden.accion === "pedir_pago" && (adel.adelanto == null || !cc.cuentas.lineas.length) ? "confirmar_disponibilidad" : orden.accion;
  const motivos = [...new Set([...orden.motivos, ...(x.extraMotivos ?? [])])].filter((m) => /^[a-z_]{2,40}$/.test(m));
  const fila = {
    cotizacion_id: cc.fila.id, crm_conversacion_id: ctx.conv.id,
    estado: accion === "pedir_pago" ? "esperando_pago" : "por_confirmar", orden: ordenDeSolicitud(accion), motivos_orden: motivos,
    adelanto_pct: pct, firma_importes: firmaImportes(cc.fila, pct), confirmar_antes_de: isoDe(orden.confirmarAntesMs), urgente: orden.urgente,
    nombre_pasajero: x.pasajero ?? null, vuelo: x.vuelo ?? null, cliente_acepto_en: x.aceptoEn, acepto_mensaje_id: x.aceptoMensajeId,
  };
  const ins = await sb.from(TABLA_SOLICITUDES).insert(fila).select(COLS_SOLICITUD).single();
  if (ins.error || !ins.data) {
    if (ins.error?.code === "23505") {
      // Otra corrida la creó a la vez: es la viva de esta cotización.
      const { data } = await sb.from(TABLA_SOLICITUDES).select(COLS_SOLICITUD).eq("cotizacion_id", cc.fila.id).in("estado", [...ESTADOS_VIVOS]).limit(1);
      return { ok: false, ya: ((data ?? [])[0] ?? null) as FilaSolicitud | null, motivo: "La solicitud ya existía", nota: "" };
    }
    const falta = ins.error && tablaFaltante(ins.error, TABLA_SOLICITUDES);
    return { ok: false, motivo: "No se pudo registrar la solicitud de reserva", nota: falta ? `Falta correr ${SQL_RESERVA_TRASLADOS.solicitudes}.` : msg(ins.error) };
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
    if (error || !acc) throw new Error(msg(error));
    accionId = String(acc.id);
    await sb.from(TABLA_SOLICITUDES).update({ crm_accion_id: accionId }).eq("id", s.id);
    s.crm_accion_id = accionId;
  } catch (e) {
    await nota(sb, ctx.conv.id, `📅 Se registró la solicitud de reserva #${s.id} (cotización N° ${cc.numero}) pero no su tarjeta en la bandeja: ${msg(e)}. Ábrela desde /tesoreria?tab=adelantos.`);
  }
  return { ok: true, c: { s, cc, orden: { ...orden, accion }, adel, pct, accionId } };
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
    correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? "sin destinatarios"}.`,
  ];
  await nota(ctx.sb, ctx.conv.id, lineas.join("\n"), "Asistente IA");
}

/** El texto que se le manda al cliente al crear (o al volver a pedir) una solicitud: T1 o T2. */
function mensajeDeSolicitud(s: FilaSolicitud, cc: ContextoCotizacion, ahora: number, x: { cfg: ConfigReserva; agente: CtxReservaIA["agente"] }): string | null {
  const estilo = estiloDeAgente(x.agente);
  const pct = pctDe(s);
  const adel = adelantoDe(cc.fila, pct);
  if (s.estado === "esperando_pago") {
    if (!adel || adel.adelanto == null || adel.saldo == null || pct == null || !cc.cuentas.lineas.length) return null;
    return mensajePedirPago({
      numero: cc.numero, moneda: adel.moneda, pct, adelanto: adel.adelanto, saldo: adel.saldo, cuentas: cc.cuentas.lineas,
      plazoMin: x.cfg.plazoConfirmacionMin, atencion: atencionDeAgente(x.agente), estilo,
    });
  }
  if (s.estado === "por_confirmar") {
    return mensajeDisponibilidadPrimero({
      fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, frasePlazo: frasePlazo(msDe(s.confirmar_antes_de), ahora),
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
  catch (err) { return derivaIA("No se pudieron leer las cotizaciones de traslado del chat", pedido, msg(err)); }
  const elec = elegirCotizacion(cands.map((c) => c.cand), e.numeroCotizacion);
  if (elec.accion === "sin_cotizacion") return solo("sin_cotizacion");
  if (elec.accion === "elegir_cotizacion") return solo("elegir_cotizacion", null, elec.opciones);
  if (elec.accion === "recotizar") return solo("recotizar", elec.cotizacion.numero);
  const cand = cands.find((c) => c.cand.id === elec.cotizacion.id)!;
  if (elec.accion === "ya_solicitada") return yaSolicitada(ctx, cand.viva!, ahora, pedido);

  const conteo = await contarSolicitudesHoy(ctx.sb, ctx.conv.id, hoy);
  const tope = decidirTopeReserva(conteo, "solicitud");
  if (!tope.ok) return derivaIA("Tope de solicitudes de reserva", pedido, tope.motivo ?? "", cand.cand.numero);
  let ult: { id: string; created_at: string } | null = null;
  try { ult = await ultimoEntrante(ctx.sb, ctx.conv.id); } catch { ult = null; }
  const r = await crearSolicitud(ctx, cand, { ahora, hoy, aceptoEn: ult?.created_at ?? isoDe(ahora), aceptoMensajeId: ult?.id ?? null, pasajero: e.nombrePasajero, vuelo: e.vuelo });
  if (!r.ok) {
    if (r.ya) return yaSolicitada(ctx, r.ya, ahora, pedido);
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
  const mensaje = mensajeDeSolicitud(c.s, c.cc, ahora, ctx);
  return solo(c.orden.accion, c.cc.numero, undefined, mensaje);
}

async function yaSolicitada(ctx: CtxReservaIA, s: FilaSolicitud, ahora: number, pedido: string): Promise<ResultadoReservaIA> {
  let cc: ContextoCotizacion;
  try { cc = await contextoCotizacion(ctx.sb, s.cotizacion_id); }
  catch (e) { return derivaIA("No se pudo leer la cotización de la reserva", pedido, msg(e)); }
  if (s.estado === "esperando_pago" && s.firma_importes && firmaImportes(cc.fila, pctDe(s)) !== s.firma_importes) {
    return derivaIA("La cotización cambió desde que se le pidió el pago", pedido,
      `Solicitud #${s.id}: los importes de la cotización N° ${cc.numero} ya no son los que se le comunicaron al cliente. Revísala antes de volver a pedirle el pago.`, cc.numero);
  }
  const mensaje = s.estado === "esperando_pago" || s.estado === "por_confirmar" ? mensajeDeSolicitud(s, cc, ahora, ctx) : null;
  return solo("ya_solicitada", cc.numero, undefined, mensaje);
}

/** La foto o el PDF que puede ser el comprobante: el último entrante desde `desde`, sin usar en ninguna solicitud. LANZA. */
async function archivoCandidato(sb: Sb, convId: string, desdeIso: string | null): Promise<{ nuevo: { id: string; media_url: string; created_at: string; tipo: string } | null; usado: boolean }> {
  let q = sb.from("crm_mensajes").select("id, media_url, created_at, tipo").eq("conversacion_id", convId).eq("direccion", "entrante")
    .not("media_url", "is", null).order("created_at", { ascending: false }).limit(20);
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
  x: { conv: ConvR; contacto: ContactoR; waId: string | null; agente: CtxReservaIA["agente"]; cfg: ConfigReserva; desdeIso: string | null; autor: string },
  deps: DepsReserva,
): Promise<ResultadoComprobante> {
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const estilo = estiloDeAgente(x.agente);
  let cand: Awaited<ReturnType<typeof archivoCandidato>>;
  try { cand = await archivoCandidato(sb, x.conv.id, x.desdeIso); }
  catch (e) { return { codigo: "error", mensaje: null, detalle: msg(e) }; }
  if (!cand.nuevo) return cand.usado
    ? { codigo: "ya_registrado", mensaje: null, detalle: "El último comprobante del chat ya está registrado." }
    : { codigo: "sin_imagen", mensaje: mensajePedirComprobante(estilo), detalle: "No hay una foto o un PDF nuevo del comprobante en el chat." };
  const archivo = cand.nuevo;

  // El freno: un conteo que no se pudo leer bloquea; la lectura se RECLAMA antes de hacerla.
  const conteo = await contarLecturasHoy(sb, x.conv.id, hoy);
  const tope = decidirTopeReserva(conteo, "lectura");
  if (!tope.ok) return { codigo: "tope", mensaje: null, detalle: tope.motivo ?? "Tope de lecturas de comprobantes." };
  const reg = await sb.from("alerta_enviada").insert({ clave: CLAVE_LECTURA_COMPROBANTE, ref: `conv:${x.conv.id}:${ahora}-${azarDe(deps)}`, fecha: hoy });
  if (reg.error) return { codigo: "tope", mensaje: null, detalle: `No se pudo registrar la lectura del comprobante: ${reg.error.message}` };

  let cc: ContextoCotizacion;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); }
  catch (e) { return { codigo: "error", mensaje: null, detalle: msg(e) }; }
  const lector = await (deps.leerComprobante ?? leerComprobantePago)(sb, archivo.media_url, { modelo: x.agente?.modelo });
  const lectura = lector.ok ? lector.lectura : null;
  const pct = pctDe(s);
  const adel = adelantoDe(cc.fila, pct);
  let operacionesPrevias: string[] = [];
  const op = normalizarOperacion(lectura?.numero_operacion);
  if (op) {
    const { data, error } = await sb.from(TABLA_COMPROBANTES).select("id").eq("operacion_norm", op).limit(1);
    if (error) return { codigo: "error", mensaje: null, detalle: `No se pudo comprobar si la operación ya se usó: ${error.message}` };
    if ((data ?? []).length) operacionesPrevias = [op];
  }
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
    return { codigo: "error", mensaje: null, detalle: tablaFaltante(ins.error, TABLA_COMPROBANTES) ? `Falta correr ${SQL_RESERVA_TRASLADOS.comprobantes}.` : `No se pudo registrar el comprobante: ${msg(ins.error)}` };
  }
  const compId = Number(ins.data.id);

  // Una imagen que el lector LEYÓ y que no es un comprobante no mueve la solicitud ni avisa a nadie.
  const noEs = lector.ok && lectura != null && lectura.es_comprobante !== true;
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
      adjunto: !!bajado && bajado.bytes.length <= MAX_ADJUNTO_BYTES, convId: x.conv.id, appUrl: appUrlDe(deps),
    }, {
      correoConfig: x.cfg.correo, emailEmpresa: cc.perfil?.email ?? null,
      adjunto: bajado ? { ...bajado, nombre: `comprobante-cotizacion-${cc.numero}.${extDe(bajado.mime)}` } : null,
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
      correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? "sin destinatarios"}.`,
    ].join("\n"), x.autor);
  }
  const mensaje = mensajeComprobanteRecibido({
    cotejo, esperado: adel?.adelanto ?? null, moneda: cc.moneda, frasePlazo: frasePlazo(plazoMs, ahora),
    unidadConfirmada: estado === "confirmada", estilo,
  });
  return { codigo: "registrado", mensaje, cotejo, estado, detalle: noEs ? "La imagen no parece un comprobante: se le pidió otra." : "Comprobante registrado." };
}

/**
 * `reportar_pago_traslado`. Con una solicitud viva en el chat, registra el comprobante. Sin ella, si
 * hay UNA cotización enviada que se pueda reservar, crea la solicitud (pagó sin aceptar: la hora de
 * aceptación es la del comprobante) y lo registra. Con ninguna o varias, lo lee igual (cuenta en el
 * tope), avisa por correo y deriva: no hay a qué atar ese pago.
 */
export async function reportarPagoIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente dice que ya pagó su traslado (o mandó el comprobante).";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las reservas de traslado del chat", pedido, msg(err)); }
  let vivas = cands.filter((c) => c.viva);
  if (e.numeroCotizacion) {
    const elec = elegirCotizacion(vivas.map((c) => ({ ...c.cand, solicitudViva: false })), e.numeroCotizacion);
    if (elec.accion === "crear") vivas = vivas.filter((c) => c.cand.id === elec.cotizacion.id);
  }
  const base = { conv: ctx.conv, contacto: ctx.contacto, waId: ctx.remitente.waId, agente: ctx.agente, cfg: ctx.cfg, autor: "Asistente IA" };
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
    catch (err) { return derivaIA("No se pudieron leer los archivos del chat", pedido, msg(err), c.cand.numero); }
    if (!archivo.nuevo) return archivo.usado ? solo("ya_registrado", c.cand.numero) : solo("pedir_comprobante", c.cand.numero, undefined, mensajePedirComprobante(estiloDeAgente(ctx.agente)));
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

  // Ninguna o varias cotizaciones que reservar: se lee el comprobante (si hay), se avisa y se deriva.
  let archivo: Awaited<ReturnType<typeof archivoCandidato>>;
  try { archivo = await archivoCandidato(ctx.sb, ctx.conv.id, new Date(ahora - VENTANA_SIN_COTIZACION_MS).toISOString()); }
  catch (err) { return derivaIA("No se pudieron leer los archivos del chat", pedido, msg(err)); }
  const motivo = elegibles.length > 1 ? "Pago reportado con varias cotizaciones de traslado en el chat" : "Pago reportado sin una cotización de traslado que reservar";
  if (!archivo.nuevo) return derivaIA(motivo, pedido, "El cliente dice que pagó y no hay un comprobante nuevo en el chat ni una sola cotización a la que atarlo.");
  const conteo = await contarLecturasHoy(ctx.sb, ctx.conv.id, hoy);
  const tope = decidirTopeReserva(conteo, "lectura");
  let lectura: LecturaComprobante | null = null;
  if (tope.ok) {
    const reg = await ctx.sb.from("alerta_enviada").insert({ clave: CLAVE_LECTURA_COMPROBANTE, ref: `conv:${ctx.conv.id}:${ahora}-${azarDe(deps)}`, fecha: hoy });
    if (!reg.error) {
      const l = await (deps.leerComprobante ?? leerComprobantePago)(ctx.sb, archivo.nuevo.media_url, { modelo: ctx.agente?.modelo });
      lectura = l.ok ? l.lectura : null;
    }
  }
  let perfil: PerfilEmpresa | null = null;
  try { perfil = (await leerPerfilPdf(ctx.sb)).perfil; } catch { perfil = null; }
  const bajado = await (deps.bajarArchivo ?? bajarArchivoPorDefecto)(ctx.sb, archivo.nuevo.media_url).catch(() => null);
  const correo = await mandarCorreo({
    tipo: "pago_sin_cotizacion", cliente: { nombre: ctx.contacto?.nombre ?? null, waId: ctx.remitente.waId }, cotizacion: null,
    moneda: "PEN", total: null, adelanto: null, pct: null, lectura, ahoraMs: ahora, adjunto: !!bajado && bajado.bytes.length <= MAX_ADJUNTO_BYTES,
    convId: ctx.conv.id, appUrl: appUrlDe(deps),
  }, { correoConfig: ctx.cfg.correo, emailEmpresa: perfil?.email ?? null, adjunto: bajado ? { ...bajado, nombre: `comprobante.${extDe(bajado.mime)}` } : null }, deps);
  return derivaIA(motivo, pedido,
    `El cliente mandó un comprobante y no hay UNA cotización de traslado enviada a la que atarlo (${elegibles.length === 0 ? "ninguna" : "varias"}). No registres ningún adelanto hasta ver el dinero en la cuenta. ${correo.enviado ? `Correo enviado a ${correo.destinatarios.join(", ")}.` : `El correo no salió: ${correo.error ?? ""}`}`);
}

/** `politicas_reserva`: las políticas de la cotización, al pie de la letra (T8). */
export async function politicasIA(ctx: CtxReservaIA, input: unknown, deps: DepsReserva = {}): Promise<ResultadoReservaIA> {
  const pedido = "El cliente pregunta por las políticas de reserva, cambios o cancelación.";
  const freno = frenoDelTurno(ctx, pedido);
  if (freno) return freno;
  const ahora = ahoraDe(deps), hoy = fechaLima(ahora);
  const e = entradaReserva(input);
  let cands: Candidata[];
  try { cands = await candidatasDeConversacion(ctx.sb, ctx.conv.id, ahora, hoy); }
  catch (err) { return derivaIA("No se pudieron leer las cotizaciones de traslado del chat", pedido, msg(err)); }
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
    const m = mensajePoliticas({ numero: cc.numero, lineas: cc.politica, email: cc.perfil?.email ?? null, estilo: estiloDeAgente(ctx.agente) });
    if (!m) return derivaIA("La cotización no tiene políticas de reserva", pedido, `La cotización N° ${cc.numero} no tiene políticas de reserva y cancelación (/cotizaciones/plantillas).`, cc.numero);
    return solo("enviar_politicas", cc.numero, undefined, m);
  } catch (err) {
    return derivaIA("No se pudieron leer las políticas de reserva", pedido, msg(err), elegida.cand.numero);
  }
}

/**
 * `cancelar_reserva_traslado`. Sin pago, sin comprobante y sin la unidad confirmada, la solicitud se
 * cierra sola (`cancelada`, motivo cliente). Si no, se guarda la hora del MENSAJE del cliente (desde
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
  catch (err) { return derivaIA("No se pudieron leer las reservas de traslado del chat", pedido, msg(err)); }
  let vivas = cands.filter((c) => c.viva);
  if (e.numeroCotizacion && vivas.length > 1) {
    const elec = elegirCotizacion(vivas.map((c) => ({ ...c.cand, solicitudViva: false })), e.numeroCotizacion);
    if (elec.accion === "crear") vivas = vivas.filter((c) => c.cand.id === elec.cotizacion.id);
  }
  if (!vivas.length) return solo("sin_reserva");
  if (vivas.length > 1) return derivaIA("Pedido de cancelación con varias reservas en curso", pedido, "El cliente pidió cancelar y hay más de una solicitud de reserva viva: revisa cuál.");
  const c = vivas[0], s = c.viva!;
  const estilo = estiloDeAgente(ctx.agente);
  try {
    const tramos = await tramosDeCotizacion(ctx.sb, s.cotizacion_id);
    const pagos = await pagosDeSolicitud(ctx.sb, s, tramos.map((t) => t.id));
    const comps = await comprobantesDe(ctx.sb, s.id);
    const cc = await contextoCotizacion(ctx.sb, s.cotizacion_id);
    const { cobrado } = dineroDeSolicitud(pagos, cc.moneda);
    if (cobrado <= 0 && comps.length === 0 && s.estado !== "confirmada") {
      const { data } = await ctx.sb.from(TABLA_SOLICITUDES)
        .update({ estado: "cancelada", cierre_motivo: "cliente", cerrada_en: new Date(ahora).toISOString() })
        .eq("id", s.id).eq("estado", s.estado).select("id");
      if (!(data ?? []).length) return derivaIA("La reserva cambió mientras se cancelaba", pedido, `Solicitud #${s.id}: otra acción la movió; revisa la tarjeta.`, c.cand.numero);
      await cerrarAccionSiCorresponde(ctx.sb, s.id, deps);
      await nota(ctx.sb, ctx.conv.id, `📅 El cliente anuló su pedido de reserva (cotización N° ${cc.numero}, solicitud #${s.id}): no había pago ni comprobante. La solicitud quedó cancelada.`, "Asistente IA");
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
    return derivaIA("No se pudo registrar el pedido de cancelación", pedido, `Solicitud #${s.id}: ${msg(err)}`, c.cand.numero);
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
  catch (e) { return { ok: false, codigo: (e as { sinMigracion?: boolean }).sinMigracion ? "sin_migracion" : "error", detalle: msg(e) }; }
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
  catch (e) { return { ok: false, codigo: "error", detalle: msg(e) }; }
  if (pideCadena) {
    if (!accion || accion.tipo !== TIPO_ACCION_RESERVA) return ajena("La tarjeta no es una reserva de traslado.");
    if (accion.conversacion_id !== s.crm_conversacion_id) return ajena("La tarjeta no es de esta conversación.");
    const p = (accion.payload ?? {}) as { solicitud_id?: unknown; cotizacion_id?: unknown };
    if (Number(p.solicitud_id ?? accion.resultado_id) !== s.id) return ajena("La tarjeta no es la de esta solicitud.");
    if (p.cotizacion_id != null && Number(p.cotizacion_id) !== Number(s.cotizacion_id)) return ajena("La tarjeta no es de esta cotización.");
  }
  // La cotización tiene que ser de la conversación de la solicitud.
  const { data: cot, error: eCot } = await sb.from("cotizaciones").select("id, crm_conversacion_id").eq("id", s.cotizacion_id).maybeSingle();
  if (eCot) return { ok: false, codigo: "error", detalle: `No se pudo leer la cotización: ${eCot.message}` };
  if (!cot) return { ok: false, codigo: "no_existe", detalle: "La cotización de la solicitud ya no existe." };
  if (s.crm_conversacion_id && cot.crm_conversacion_id && cot.crm_conversacion_id !== s.crm_conversacion_id) return ajena("La cotización no es de esta conversación.");
  let conv: Cadena["conv"] = null, contacto: Cadena["contacto"] = null;
  if (s.crm_conversacion_id) {
    const { data: c, error: eConv } = await sb.from("crm_conversaciones")
      .select("id, canal, phone_number_id, contacto_id, crm_contactos(id, nombre, wa_id, telefono, cliente_id, fb_psid, ig_id, gmail_email)")
      .eq("id", s.crm_conversacion_id).maybeSingle();
    if (eConv) return { ok: false, codigo: "error", detalle: `No se pudo leer la conversación: ${eConv.message}` };
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
  cargo: { id: number; serie: string | null; numero: string | null; total: number | null; estado: string | null } | null;
  versiones: { id: number; version: number; codigo: string }[];
  avisos: string[];
};

/** Todo lo que se sabe de la solicitud. Lo que no se pudo leer va a `avisos` (y, si es dinero, LANZA). */
async function leerHechos(sb: Sb, s: FilaSolicitud): Promise<Hechos> {
  const avisos: string[] = [];
  let cc: ContextoCotizacion | null = null;
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); } catch (e) { avisos.push(msg(e)); }
  const tramos = await tramosDeCotizacion(sb, s.cotizacion_id);
  const pagos = await pagosDeSolicitud(sb, s, tramos.map((t) => t.id));
  const comprobantes = await comprobantesDe(sb, s.id);
  let cargo: Hechos["cargo"] = null;
  if (s.factura_cargo_id) {
    const { data, error } = await sb.from("facturas").select("id, serie, numero, total, estado").eq("id", s.factura_cargo_id).maybeSingle();
    if (error) avisos.push(`No se pudo leer el comprobante del cargo: ${error.message}`);
    else if (data) cargo = { id: Number(data.id), serie: data.serie ?? null, numero: data.numero ?? null, total: num(data.total), estado: data.estado ?? null };
  }
  let versiones: Hechos["versiones"] = [];
  const idDoc = tramos.length ? Math.min(...tramos.map((t) => t.id)) : null;
  if (idDoc) {
    try { versiones = ((await leerVersiones(sb, idDoc)) ?? []).map((v) => ({ id: v.id, version: v.version, codigo: v.codigo })); }
    catch (e) { avisos.push(msg(e)); }
  }
  return { cc, tramos, pagos, comprobantes, cargo, versiones, avisos };
}

const confirmacionEnviadaDe = (s: FilaSolicitud, accion: AccionFila | null) =>
  s.estado === "completada" || !!(accion?.payload as { confirmacion_enviada?: unknown } | null)?.confirmacion_enviada;

function pendientesDe(s: FilaSolicitud, h: Hechos, accion: AccionFila | null): { pendientes: Pendiente[]; cobrado: number; devuelto: number; moneda: Moneda } {
  const moneda = h.cc?.moneda ?? "PEN";
  const { cobrado, devuelto } = dineroDeSolicitud(h.pagos, moneda);
  const adel = h.cc ? adelantoDe(h.cc.fila, pctDe(s)) : null;
  const pendientes = queFalta(
    { estado: s.estado, orden: s.orden, adelanto_pct: pctDe(s), confirmar_antes_de: s.confirmar_antes_de, cancelacion_pedida_en: s.cancelacion_pedida_en, devolucion_pct: num(s.devolucion_pct), comprobantes: h.comprobantes.length },
    {
      cobrado, devuelto, adelanto: adel?.adelanto ?? null, reserva: reservaParaQueFalta(s, h.tramos),
      confirmacionEnviada: confirmacionEnviadaDe(s, accion), confirmacionEmitida: h.versiones.length > 0,
      cargo: h.cargo ? { id: h.cargo.id, numero: h.cargo.numero } : null, moneda,
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

/** Las acciones que tienen sentido en este estado (la ruta las vuelve a comprobar todas). */
function accionesDe(s: FilaSolicitud, x: { cobrado: number; devuelto: number; total: number | null; comprobantes: number; aDevolver: number | null; emitida: boolean }): (AccionTarjeta | AccionDinero)[] {
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
  if (x.comprobantes > 0 && x.cobrado <= 0 && !esEstadoTerminal(s.estado)) out.push("pago_no_encontrado");
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
      importesVigentes: s.firma_importes ? firmaImportes(h.cc.fila, pct) === s.firma_importes : null, clienteId: num(h.cc.fila.cliente_id),
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
    acciones: accionesDe(s, { cobrado, devuelto, total: adel?.total ?? null, comprobantes: h.comprobantes.length, aDevolver, emitida: h.versiones.length > 0 }),
    politica: h.cc?.politica ?? [], devolucionPlazoH: cfg?.devolucionPlazoH ?? null, avisos: h.avisos,
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
  catch (e) { return res("error", msg(e)); }
  const { agente, cfg } = await agenteYConfig(sb);
  const credito = esCreditoSol(s);
  const pct = credito ? null : pctDe(s) ?? cfg.adelantoPct;
  if (!credito && pct == null) return res("sin_adelanto_config", "No hay un porcentaje de adelanto configurado: escríbelo en /tarifario → Zonas y traslados → Ajustes.");
  const adel = adelantoDe(cc.fila, pct);
  if (!adel || (!credito && adel.adelanto == null)) return res("error", `La cotización N° ${cc.numero} no tiene importes que se puedan calcular: revísala en /cotizaciones.`);
  if (s.firma_importes && s.orden === "pago_primero" && firmaImportes(cc.fila, pct) !== s.firma_importes) {
    return res("importes_cambiaron", `La cotización N° ${cc.numero} cambió desde que se le pidió el pago al cliente: revisa los importes antes de confirmar (o cierra esta solicitud y vuelve a cotizar).`);
  }
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const pago: PagoEnHayUnidad = credito ? "credito"
    : cobrado + 0.005 >= (adel.adelanto ?? 0) ? "verificado"
    : cobrado > 0 ? "incompleto"
    : h.comprobantes.length > 0 ? "reportado" : "pedir";
  let bloque: BloquePago | null = null;
  if (pago === "pedir" || pago === "incompleto") {
    if (!cc.cuentas.lineas.length) return res("sin_cuentas", "La cotización no tiene cuentas bancarias en su moneda para pedirle el pago: agrégalas en /configuracion/perfil.");
    if (cc.frente.codigo === "distintas" || cc.frente.codigo === "sin_comprobar") return res("cuentas_distintas", "Las cuentas de la plantilla de la cotización no son las de «corporativo» (o no se pudo comprobar): revísalas en /cotizaciones/plantillas antes de mandárselas al cliente.");
    bloque = { numero: cc.numero, moneda: adel.moneda, pct: pct!, adelanto: adel.adelanto!, saldo: adel.saldo!, cuentas: cc.cuentas.lineas };
  }

  // El reclamo: solo si sigue en el estado que se leyó.
  const patch: Record<string, unknown> = { estado: "confirmada", disponibilidad_en: ahoraIso, disponibilidad_por: quien.id };
  // Con «disponibilidad primero» el monto se le comunica AHORA (T4): la firma es la de hoy.
  if (!credito && (pctDe(s) == null || s.orden === "disponibilidad_primero")) { patch.adelanto_pct = pct; patch.firma_importes = firmaImportes(cc.fila, pct); }
  const { data: rec, error: eRec } = await sb.from(TABLA_SOLICITUDES).update(patch).eq("id", s.id).eq("estado", s.estado).is("cancelacion_pedida_en", null).select("id");
  if (eRec) return res("error", `No se pudo confirmar la solicitud: ${eRec.message}`);
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
    if (eUp || !(up ?? []).length) { await revertir(); return res("reserva_no_creada", `No se pudo aprobar la cotización N° ${cc.numero}${eUp ? `: ${eUp.message}` : " (otra persona la cambió)"}. La solicitud vuelve a su estado.`); }
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
    if (r.codigo === "creada" || r.codigo === "retorno_completado" || r.codigo === "parcial") {
      if (r.codigo !== "creada" || /⚠️/.test(r.mensaje)) avisos.push(r.mensaje);
    } else if (r.codigo !== "ya_convertida" && r.codigo !== "retorno_imposible") {
      await revertir(); await revertirCot();
      return res("reserva_no_creada", `No se pudo crear la reserva en Programación: ${r.mensaje || "error desconocido"}. La solicitud y la cotización vuelven a su estado.`);
    } else if (r.codigo === "retorno_imposible") avisos.push(r.mensaje);
    const tramos = await tramosDeCotizacion(sb, cc.fila.id);
    const vivos = tramos.filter((t) => t.estado !== "cancelada");
    reservaId = r.idas.length ? Math.min(...r.idas) : vivos.length ? Math.min(...vivos.map((t) => t.id)) : null;
  } catch (e) {
    await revertir(); await revertirCot();
    return res("reserva_no_creada", `No se pudo crear la reserva en Programación: ${msg(e)}. La solicitud y la cotización vuelven a su estado.`);
  }
  if (reservaId == null) { await revertir(); await revertirCot(); return res("reserva_no_creada", "La cotización no dejó ninguna reserva viva en Programación. La solicitud vuelve a su estado."); }
  await sb.from(TABLA_SOLICITUDES).update({ reserva_id: reservaId }).eq("id", s.id);
  try { await enlazarCobrosAReserva(sb, s.id, reservaId); } catch (e) { avisos.push(`Los cobros no se ataron a la reserva: ${msg(e)}`); }

  const estilo = estiloDeAgente(agente);
  const texto = mensajeHayUnidad({ fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, origen: cc.fila.origen, destino: cc.fila.destino, pago, moneda: adel.moneda, cobrado, bloque, estilo });
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
  } catch (e) { return res("error", msg(e)); }
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "sin_unidad", devolucion_pct: 100, cierre_motivo: "sin_unidad", cerrada_en: ahoraIso, cerrada_por: quien.id })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", `No se pudo cerrar la solicitud: ${error.message}`);
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  const { agente, cfg } = await agenteYConfig(sb);
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const texto = mensajeSinUnidad({ fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida, conPago: cobrado > 0 || h.comprobantes.length > 0, plazoH: cfg.devolucionPlazoH, estilo: estiloDeAgente(agente) });
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
  const estilo = estiloDeAgente(agente);
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

/** «Leer el último comprobante»: lo marca leído y devuelve un enlace firmado para verlo. */
export async function verComprobante(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  let comps: FilaComprobante[];
  try { comps = await comprobantesDe(sb, c.s.id); } catch (e) { return res("error", msg(e)); }
  const k = comps[0];
  if (!k?.mensaje_id) return res("sin_comprobante", "La solicitud no tiene un comprobante con archivo.");
  const { data: m, error } = await sb.from("crm_mensajes").select("media_url, conversacion_id").eq("id", k.mensaje_id).maybeSingle();
  if (error) return res("error", `No se pudo leer el mensaje del comprobante: ${error.message}`);
  if (!m?.media_url || (c.s.crm_conversacion_id && m.conversacion_id !== c.s.crm_conversacion_id)) return res("sin_comprobante", "El archivo del comprobante ya no está.");
  const obj = objetoPrivadoDe(m.media_url);
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
  } catch (e) { return res("error", msg(e)); }
  const { cobrado } = dineroDeSolicitud(h.pagos, cc.moneda);
  const noEncontrado = !!(c.accion?.payload as { pago_no_encontrado?: unknown } | null)?.pago_no_encontrado;
  if (h.comprobantes.length > 0 && cobrado <= 0 && !noEncontrado) {
    return res("pago_sin_registrar", "El cliente reportó un pago que Tesorería todavía no registró: regístralo como adelanto o márcalo «No encontré el pago» antes de resolver la cancelación.");
  }
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "cancelada", devolucion_pct: pct, cierre_motivo: "cliente", cerrada_en: ahoraIso, cerrada_por: quien.id })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", `No se pudo cerrar la solicitud: ${error.message}`);
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  const { agente, cfg } = await agenteYConfig(sb);
  const estilo = estiloDeAgente(agente);
  const monto = devolucionDecidida(cobrado, pct);
  const texto = cobrado > 0
    ? mensajeCancelacionResuelta({ monto, pct, moneda: cc.moneda, plazoH: cfg.devolucionPlazoH, estilo })
    : mensajeCanceladaSinPago({ numero: cc.numero, estilo });
  const avisos: string[] = [];
  if (cargoRetenido({ cobrado, devuelto: monto }) > 0) {
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (!cargo.ok) avisos.push(cargo.detalle);
  }
  const a = await avisarCliente(sb, c, texto, { usuarioId: quien.id }, deps);
  await nota(sb, c.conv?.id, `📅 ${quien.nombre ?? "Un ejecutivo"} resolvió la cancelación de la solicitud #${s.id}: se devuelve el ${pct} % de lo cobrado (${r2(monto)} ${cc.moneda}).${avisos.length ? `\n${avisos.join("\n")}` : ""}`);
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return conAviso("Cancelación resuelta.", a, { estado: "cancelada", mensaje: texto, avisos });
}

/**
 * El comprobante del cargo retenido (decisión del dueño): cuando lo devuelto es menor que lo
 * cobrado, una fila de `facturas` ya armada y SIN número (`filaFacturaCargo`; `total` es una columna
 * generada y no se inserta). Idempotente: se busca por la marca en las observaciones antes de crear,
 * y la solicitud lo ata con un UPDATE condicional (`factura_cargo_id is null`); si otra llamada ganó,
 * se borra el propio. Nunca toca la reserva ni `planDeCancelacion`.
 */
export async function asegurarComprobanteCargo(sb: Sb, solicitudId: number, deps: DepsReserva = {}): Promise<{ ok: boolean; id: number | null; creado: boolean; detalle: string }> {
  try {
    const s = await leerSolicitud(sb, solicitudId);
    if (!s) return { ok: false, id: null, creado: false, detalle: "La solicitud no existe." };
    if (s.factura_cargo_id) return { ok: true, id: s.factura_cargo_id, creado: false, detalle: "El comprobante del cargo ya existía." };
    if (s.estado !== "cancelada" && s.estado !== "sin_unidad") return { ok: true, id: null, creado: false, detalle: "La solicitud no está cerrada." };
    const pct = s.estado === "sin_unidad" ? 100 : num(s.devolucion_pct);
    if (pct == null) return { ok: true, id: null, creado: false, detalle: "Todavía no se decidió la devolución." };
    const cc = await contextoCotizacion(sb, s.cotizacion_id);
    const tramos = await tramosDeCotizacion(sb, s.cotizacion_id);
    const pagos = await pagosDeSolicitud(sb, s, tramos.map((t) => t.id));
    const { cobrado } = dineroDeSolicitud(pagos, cc.moneda);
    const aDevolver = devolucionDecidida(cobrado, pct);
    const armado = filaFacturaCargo({
      solicitudId: s.id, cotizacion: { id: cc.fila.id, numero: cc.numero, moneda: cc.fila.moneda, tipo_cambio: cc.fila.tipo_cambio },
      cliente: cc.cliente ? { id: cc.cliente.id, ruc: cc.cliente.ruc } : null, reservaId: s.reserva_id ?? null,
      cobrado, devuelto: aDevolver, hoy: fechaLima(ahoraDe(deps)), servicio: { fecha: cc.fila.fecha_servicio, hora: cc.fila.hora_ida },
    });
    if (!armado) return { ok: true, id: null, creado: false, detalle: "No se retiene nada: no hace falta comprobante." };
    const marca = `${marcaCargoReserva(s.id)}:`;
    const { data: previa, error: ePrev } = await sb.from("facturas").select("id").eq("cotizacion_id", cc.fila.id).ilike("observaciones", `%${marca}%`).limit(1);
    if (ePrev) throw new Error(`No se pudo buscar el comprobante del cargo: ${ePrev.message}`);
    let id: number;
    let creado = false;
    if ((previa ?? []).length) id = Number(previa[0].id);
    else {
      const { data: ins, error: eIns } = await sb.from("facturas").insert(armado.fila).select("id").single();
      if (eIns || !ins) throw new Error(`No se pudo crear el comprobante del cargo: ${msg(eIns)}`);
      id = Number(ins.id); creado = true;
    }
    const { data: up, error: eUp } = await sb.from(TABLA_SOLICITUDES).update({ factura_cargo_id: id }).eq("id", s.id).is("factura_cargo_id", null).select("id");
    if (eUp && eUp.code !== "23505") throw new Error(`No se pudo atar el comprobante del cargo a la solicitud: ${eUp.message}`);
    if (!(up ?? []).length) {
      const otra = await leerSolicitud(sb, s.id);
      if (otra?.factura_cargo_id && otra.factura_cargo_id !== id) {
        if (creado) { try { await sb.from("facturas").delete().eq("id", id); } catch { /* queda una fila sin número: la marca la delata */ } }
        return { ok: true, id: otra.factura_cargo_id, creado: false, detalle: "Otra llamada creó el comprobante del cargo a la vez." };
      }
    }
    return { ok: true, id, creado, detalle: creado ? `Comprobante del cargo creado (sin número): retenido ${r2(armado.total)} ${cc.moneda}.` : "El comprobante del cargo ya existía." };
  } catch (e) {
    return { ok: false, id: null, creado: false, detalle: `El comprobante del cargo no se creó: ${msg(e)} Créalo en /facturacion.` };
  }
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
  } catch (e) { return res("error", msg(e)); }
  const { cobrado } = dineroDeSolicitud(h.pagos, h.cc?.moneda ?? "PEN");
  if (cobrado > 0) return res("con_cobros", "La solicitud tiene cobros registrados: no se cierra, se resuelve como cancelación (con su devolución).");
  const noEncontrado = !!(c.accion?.payload as { pago_no_encontrado?: unknown } | null)?.pago_no_encontrado;
  if (h.comprobantes.length > 0 && !noEncontrado) return res("pago_sin_registrar", "El cliente reportó un pago: que Tesorería lo registre o marque «No encontré el pago» antes de cerrar.");
  const n = lineaCorta(notaTxt, 500);
  const notaFinal = n ? [s.nota, `Cierre: ${n}`].filter(Boolean).join("\n").slice(0, 2000) : s.nota;
  const { data, error } = await sb.from(TABLA_SOLICITUDES)
    .update({ estado: "cancelada", cierre_motivo: m, cerrada_en: new Date(ahoraDe(deps)).toISOString(), cerrada_por: quien.id, nota: notaFinal })
    .eq("id", s.id).eq("estado", s.estado).select("id");
  if (error) return res("error", `No se pudo cerrar la solicitud: ${error.message}`);
  if (!(data ?? []).length) return res("reclamo_perdido", "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.");
  await cerrarAccionSiCorresponde(sb, s.id, deps);
  return res("ok", "Solicitud cerrada.", { estado: "cancelada" });
}

/** Ata un cliente del ERP a la cotización, a sus reservas y al contacto (solo donde no hay otro). */
export async function vincularCliente(sb: Sb, c: Cadena, clienteIdPedido: unknown): Promise<ResultadoAccionReserva> {
  const clienteId = num(clienteIdPedido);
  if (!clienteId || !Number.isInteger(clienteId)) return res("datos_invalidos", "Elige un cliente del ERP.");
  if (esEstadoTerminal(c.s.estado) && c.s.estado !== "completada") return res("transicion_invalida", `La solicitud está «${c.s.estado}».`);
  const { data: cli, error } = await sb.from("clientes").select("id").eq("id", clienteId).maybeSingle();
  if (error) return res("error", `No se pudo leer el cliente: ${error.message}`);
  if (!cli) return res("no_existe", "Ese cliente no existe.");
  const { data: cot, error: e2 } = await sb.from("cotizaciones").select("id, cliente_id").eq("id", c.s.cotizacion_id).maybeSingle();
  if (e2 || !cot) return res("error", `No se pudo leer la cotización: ${e2?.message ?? "no existe"}`);
  if (cot.cliente_id != null && Number(cot.cliente_id) !== clienteId) return res("datos_invalidos", "La cotización ya tiene otro cliente: corrígelo en /cotizaciones.");
  const fallos: string[] = [];
  const u1 = await sb.from("cotizaciones").update({ cliente_id: clienteId }).eq("id", c.s.cotizacion_id).is("cliente_id", null);
  if (u1.error) fallos.push(`cotización: ${u1.error.message}`);
  const u2 = await sb.from("reservas").update({ cliente_id: clienteId }).eq("cotizacion_id", c.s.cotizacion_id).is("cliente_id", null);
  if (u2.error) fallos.push(`reservas: ${u2.error.message}`);
  if (c.contacto?.id) {
    const u3 = await sb.from("crm_contactos").update({ cliente_id: clienteId }).eq("id", c.contacto.id).is("cliente_id", null);
    if (u3.error) fallos.push(`contacto: ${u3.error.message}`);
  }
  return fallos.length ? res("error", `El cliente no se ató en todos lados (${fallos.join(" · ")}).`) : res("ok", "Cliente vinculado a la cotización, sus reservas y el contacto.");
}

/**
 * «Emitir y enviar Confirmación»: emite la versión vigente (la misma de /api/reservas/confirmacion)
 * y, SOLO dentro de la ventana de 24 h, manda su PDF por WhatsApp (copia en `crm-media`, enlace
 * firmado). Enviada, la solicitud pasa a `completada` y la tarjeta a `aprobada`. Fuera de la
 * ventana devuelve la versión para descargarla y mandarla por wa.me.
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
    vuelo: sx(x.extras?.vuelo, 40) ?? s.vuelo ?? null, punto_encuentro: sx(x.extras?.punto_encuentro, 120), nota: sx(x.extras?.nota, 300),
    incluir_telefono_conductor: x.extras?.incluir_telefono_conductor === true,
  };
  let version: { id: number; version: number; codigo: string };
  try {
    const { entrada, sinMigracion } = await leerEntrada(sb, s.reserva_id, extras);
    if (sinMigracion) return res("sin_migracion", "Falta correr supabase/reservas-08-confirmacion-reserva.sql.");
    const juicio = juzgarConfirmacion(entrada);
    if (!juicio.ok || !juicio.datos || !juicio.idDocumento) return res("bloqueada", "La Confirmación de Reserva todavía no se puede emitir.", { bloqueos: juicio.bloqueos.map((b) => ({ codigo: String(b.codigo), detalle: b.detalle })) });
    const v = await emitirVersion(sb, juicio.idDocumento, juicio.datos, quien);
    version = { id: v.id, version: v.version, codigo: v.codigo };
  } catch (e) { return res("error", `No se pudo emitir la Confirmación: ${msg(e)}`); }
  const idioma = normalizarIdioma(x.idioma);
  const pdfUrl = `/api/reservas/confirmacion?version_id=${version.id}&idioma=${idioma}&pdf=1`;
  const verRes = { ...version, pdf: pdfUrl };
  const waId = c.contacto?.wa_id ? String(c.contacto.wa_id) : null;
  if (!c.conv || c.conv.canal !== "whatsapp" || !waId) return res("fuera_de_ventana", "La conversación no es de WhatsApp: descarga la Confirmación y envíala.", { version: verRes, enviado: false, fueraDeVentana: { texto: version.codigo, waMe: null, cerroEn: null } });
  let ult: { created_at: string } | null = null;
  try { ult = await ultimoEntrante(sb, c.conv.id); } catch { ult = null; }
  const v24 = ventana24h(ult?.created_at ?? null, ahora);
  if (!v24.abierta) {
    const texto = `Confirmación de Reserva ${version.codigo}`;
    return res("fuera_de_ventana", "Pasaron más de 24 h desde el último mensaje del cliente: descarga la Confirmación y envíala por wa.me.", { version: verRes, enviado: false, fueraDeVentana: { texto, waMe: enlaceWaMe(waId, texto), cerroEn: v24.cierraEn } });
  }
  let metaId: string | null = null, errorEnvio: string | null = null, mediaUrl: string | null = null, nombre = "";
  try {
    const pdf = await (deps.pdfConfirmacion ?? pdfDeVersion)(sb, { ...(await versionCompleta(sb, version.id)) }, idioma);
    nombre = pdf.nombre;
    await (deps.asegurarBucket ?? asegurarBucketCrm)(sb);
    const ruta = `confirmaciones/${s.reserva_id}/${version.codigo.replace(/[^A-Za-z0-9-]/g, "")}-${(deps.uuid ?? randomUUID)()}.pdf`;
    const up = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, pdf.bytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw new Error(`No se pudo guardar el PDF: ${up.error.message}`);
    mediaUrl = sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
    const firmada = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUrl(ruta, TTL_URL_META);
    const url = firmada?.data?.signedUrl as string | undefined;
    if (!url) throw new Error("No se pudo firmar el enlace del PDF.");
    const phoneId = c.conv.phone_number_id ?? (await (deps.phonePara ?? phoneParaUso)("crm"));
    metaId = await (deps.enviarMedia ?? enviarWhatsAppMedia)(waId, "document", url, `Confirmación de Reserva ${version.codigo}`, { phoneId, filename: nombre });
    if (!metaId) errorEnvio = "Meta no devolvió el id del mensaje.";
  } catch (e) {
    errorEnvio = explicarErrorEnvioWhatsApp(msg(e));
  }
  try {
    await sb.from("crm_mensajes").insert({
      conversacion_id: c.conv.id, direccion: "saliente", tipo: "document", contenido: nombre || `Confirmación de Reserva ${version.codigo}`,
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
  try { h = await leerHechos(sb, s); } catch (e) { return res("error", msg(e)); }
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
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s); } catch (e) { return res("error", msg(e)); }
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
    const m = msg(e);
    return res(/Falta correr/.test(m) ? "sin_migracion" : "error", /Falta correr|No se pudo registrar/.test(m) ? m : "No se pudo registrar el cobro.");
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
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (!cargo.ok) avisos.push(cargo.detalle);
  }
  await nota(sb, s.crm_conversacion_id, `🏦 ${quien.nombre ?? "Tesorería"} registró el adelanto ${r.codigo ?? `#${r.id}`}: ${v.monto.toFixed(2)} ${cc.moneda} (${v.metodo ?? "sin medio"}${v.referencia ? ` · op. ${v.referencia}` : ""}) de la solicitud #${s.id}.`);
  return res("ok", `Adelanto registrado (${r.codigo ?? `#${r.id}`}).`, { estado: s.estado, avisos });
}

/** «No encontré el pago» (Tesorería): queda en la tarjeta (ámbar) y en una nota; el ejecutivo le manda T9. */
export async function marcarPagoNoEncontrado(sb: Sb, c: Cadena, quien: Quien, deps: DepsReserva = {}): Promise<ResultadoAccionReserva> {
  if (esEstadoTerminal(c.s.estado)) return res("transicion_invalida", `La solicitud está «${c.s.estado}».`);
  if (!c.accion) return res("error", "La solicitud no tiene tarjeta en la bandeja.");
  const at = new Date(ahoraDe(deps)).toISOString();
  const { error } = await sb.from("crm_acciones_ia").update({ payload: { ...(c.accion.payload ?? {}), pago_no_encontrado: { at, por: quien.nombre ?? quien.id } } }).eq("id", c.accion.id);
  if (error) return res("error", `No se pudo marcar: ${error.message}`);
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
  try { cc = await contextoCotizacion(sb, s.cotizacion_id); h = await leerHechos(sb, s); } catch (e) { return res("error", msg(e)); }
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
    const m = msg(e);
    return res(/Falta correr/.test(m) ? "sin_migracion" : "error", /Falta correr|No se pudo registrar/.test(m) ? m : "No se pudo registrar la devolución.");
  }
  try {
    const despues = await pagosDeSolicitud(sb, s, h.tramos.map((t) => t.id));
    if (dineroDeSolicitud(despues, cc.moneda).devuelto > aDevolver + 0.005) {
      await sb.from("pagos").update({ anulado: true }).eq("id", r.id);
      return res("reclamo_perdido", "Otra devolución se registró a la vez y juntas superan lo que corresponde: esta no se guardó.");
    }
  } catch { /* la devolución quedó */ }
  const avisos: string[] = [];
  if (cargoRetenido({ cobrado, devuelto: aDevolver }) > 0) {
    const cargo = await asegurarComprobanteCargo(sb, s.id, deps);
    if (!cargo.ok) avisos.push(cargo.detalle);
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
      const seguro = cot.length === 1 && (cot[0] === "coincide" || cot[0] === "pago_total");
      filas.push({
        solicitudId: s.id, estado: s.estado, numero: h.cc?.numero ?? null, cliente: h.cc?.cliente?.nombre ?? null,
        servicio: { fecha: h.cc?.fila.fecha_servicio ?? null, hora: h.cc?.fila.hora_ida ?? null, origen: h.cc?.fila.origen ?? null, destino: h.cc?.fila.destino ?? null },
        moneda, total: adel?.total ?? null, adelanto: adel?.adelanto ?? null, cobrado, devuelto, aDevolver,
        comprobantes: h.comprobantes.length, ultimoMontoSeguro: seguro ? (ult?.lectura as LecturaComprobante | null)?.monto ?? null : null,
        pagoNoEncontrado: pagoNo, pendientesTesoreria: deTesoreria, creadaEn: s.creada_en, convId: s.crm_conversacion_id,
      });
    } catch (e) {
      avisos.push(`Solicitud #${s.id}: ${msg(e)}`);
    }
  }
  return { filas, avisos };
}

/**
 * La cotización de traslado más reciente de la conversación (para la guarda T10 del texto final).
 * null si no hay o si no se pudo leer (sin dato, la guarda no salta: el texto sigue por
 * `textoSinImportesAjenos`, que ya quita los importes ajenos).
 */
export async function cotizacionTrasladoDelChat(sb: Sb, convId: string): Promise<{ id: number; numero: string } | null> {
  try {
    const { data, error } = await sb.from("cotizaciones").select("id, numero_cotizacion").eq("crm_conversacion_id", convId)
      .not("traslado_json", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return { id: Number(data.id), numero: numeroCotizacion({ id: Number(data.id), numero_cotizacion: data.numero_cotizacion ?? null }) };
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
    let plantillaSoles: string | null = null;
    if (lp.ok) {
      const set = new Set<string>();
      for (const segmento of SEGMENTOS) {
        const p = plantillaParaUso({ servicio: "traslado_ia", segmento }, lp.plantillas, lp.reglas).plantilla;
        if (segmento === "particular") plantillaSoles = p?.id ?? null;
        const lineas = (p as { condiciones_reserva?: unknown } | null)?.condiciones_reserva;
        for (const l of Array.isArray(lineas) ? lineas : []) { const t = String(l ?? "").trim(); if (t) set.add(t); }
      }
      politica = [...set];
    }
    const { perfil } = await leerPerfilPdf(sb);
    // Las cuentas en soles que imprimiría el PDF de un traslado (la plantilla de «particular»).
    const { usada } = await plantillaYReferenciaCuentas(sb, plantillaSoles);
    const cuentas = cuentasEnMensaje(usada, perfil, "PEN").cuentas.length;
    const correos = destinatariosReserva({ correoConfig: cfgIA.reserva.correo, emailEmpresa: perfil?.email ?? null }).correos;
    const est = estadoReservaIA({
      sinMigracion: cfgIA.reservaSinMigracion, cfg: cfgIA.reserva, iaCotiza: cfgIA.iaCotiza, agenteAutonomo: autonomos.includes("whatsapp"),
      atencionEnUso: atencionEnUso(atencionDeAgente(agente)), cuentas, correos, politicaLineas: politica?.length ?? 0,
      contradicciones: politicaContradiceConfig(politica ?? [], cfgIA.reserva).length,
    });
    // Encendida pero sin poder comprobar las tablas de reservas-09: no se afirma que esté activa.
    const reserva = cfgIA.reserva.activa && cfgIA.reservaDetalle && !cfgIA.reservaSinMigracion ? null : est.activa;
    return { reserva, politica_reserva: politica, lineas: est.lineas, ambar: est.ambar };
  } catch {
    return nada;
  }
}

// Lo que reexporta el contrato del servidor para las rutas.
export { SQL_PAGOS_SOLICITUD };
export type { AccionTarjeta, AccionDinero };
