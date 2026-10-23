// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-pago.ts — La RESERVA de un traslado que cotizó la IA del CRM: cuánto es el
// adelanto, a qué cuentas se paga, qué le falta a cada solicitud y quién lo tiene que hacer, el
// comprobante del cargo retenido y los TEXTOS que le manda el código al cliente (T1–T11). PURO: no
// lee la base, no manda nada.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. UN MONTO, UNA FILA AUTORITATIVA. El precio vive en `cotizaciones`; el adelanto se DERIVA con
//     la MISMA cuenta que imprime el PDF (`cifrasDeFila` → `totalesEnMoneda`), así el chat y el
//     documento dicen el mismo total al céntimo. Lo cobrado y lo devuelto viven en `pagos`
//     (`sentido` cobro / pago): se suman al leer y no se guardan. Una DEVOLUCIÓN nunca suma al
//     adelanto (`dineroDeSolicitud`).
//  2. LAS CUENTAS DEL CHAT SON LAS DEL PDF: `cuentasCorporativo` + `cuentasDoc`, la misma fuente y
//     el mismo filtro por moneda. Nunca un literal.
//  3. EL ERP NO EMITE ANTE SUNAT. El cargo de una cancelación tardía se arma como fila de `facturas`
//     SIN número (`filaFacturaCargo`): estado y sunat_estado «pendiente», serie y número los escribe
//     quien lo emite. El IGV de ese cargo NO se decide aquí: subtotal = total, IGV 0, y la
//     observación pide revisarlo con contabilidad. `total` es una columna GENERADA (subtotal + igv)
//     en producción: no va en la fila (insertarlo falla); se devuelve aparte.
//  4. LOS TEXTOS SON DE USTED Y DE TÚ, cada uno escrito entero (`estilo`, el mismo ajuste del agente),
//     sin un solo dato de la empresa escrito aquí: las cuentas y el correo salen de la configuración.
//  5. ANTES DE PAGAR, EL CLIENTE TIENE LAS CONDICIONES (cotizaciones-08). Con el enlace a las
//     condiciones completas de la cotización (`/condiciones/<token>`), T1 y el pedido de pago de T4
//     llevan el resumen de la política (o solo el enlace, si no hay resumen) en lugar de «Si desea, le
//     envío nuestras políticas…», y T8 manda el resumen con el enlace. Sin enlace, los textos de
//     siempre, byte a byte: sin el texto completo a mano, nunca se resume lo que mueve dinero.
// Matriz: npx tsx scripts/prueba-reserva-pago.mts
// ──────────────────────────────────────────────────────────────────────────────

import { cifrasDeFila, clienteParaPdf, type ClienteErp, type FilaCotizacionLeida } from "./cotizacion-traslado";
import { mismoTelefonoE164 } from "../crm-telefono";
import { normalizarMoneda, revisarTipoCambio, type Moneda } from "../cotizacion-moneda";
import { fmtImporte } from "../cotizacion-idioma";
import { cuentasCorporativo, cuentasDoc } from "../cotizacion-corporativo";
import type { AvisoPdf, PlantillaPdfCfg } from "../cotizacion-pdf";
import type { CuentaBancaria, PerfilEmpresa } from "../empresa-perfil";
import { rucValido } from "../combustible/grifo-canonico";
import { aLas, describirAtencion, type Atencion } from "../crm-ia-atencion";
import { minutoDelDiaLima, minutosAHhmm, fechaLima } from "../alertas-horario";
import type { EstiloMensajes } from "../crm-ia-ajustes";
import { MARGEN_DEFECTO_MIN, PLAZO_CONFIRMACION_DEFECTO_MIN } from "./reserva-orden";
import { correosDeTexto } from "../ocupacion/copia-interna";
import { esEnlaceCondiciones } from "../condiciones-publicas";

const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const txt = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const esTu = (e: EstiloMensajes | null | undefined) => e?.tratamiento === "tu";

// ── 1. Estados y configuración ───────────────────────────────────────────────

export type EstadoSolicitud = "esperando_pago" | "por_confirmar" | "pago_reportado" | "confirmada" | "sin_unidad" | "cancelada" | "completada";
export const ESTADOS_SOLICITUD: readonly EstadoSolicitud[] = ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada", "sin_unidad", "cancelada", "completada"];
/** Los que no se reabren (pueden tener aún dinero por devolver o un cargo por emitir: ver `queFalta`). */
export const ESTADOS_TERMINALES: readonly EstadoSolicitud[] = ["sin_unidad", "cancelada", "completada"];
export const esEstadoTerminal = (e: EstadoSolicitud) => ESTADOS_TERMINALES.includes(e);

/**
 * A dónde puede pasar cada estado. Sin entrada = terminal. Lo de la tarjeta del ejecutivo, del
 * cliente y del tick sale de aquí:
 *  · esperando_pago → pago_reportado (manda el comprobante) · confirmada («Hay unidad») ·
 *    sin_unidad («No hay unidad») · cancelada (desistió, duplicada, o el tick la da por vencida).
 *  · por_confirmar → pago_reportado (pagó igual) · confirmada · sin_unidad · cancelada.
 *  · pago_reportado → esperando_pago («Pedir otro comprobante», «No encontré el pago») · confirmada ·
 *    sin_unidad · cancelada.
 *  · confirmada → completada (Confirmación de Reserva enviada) · sin_unidad · cancelada.
 */
export const TRANSICIONES: Record<EstadoSolicitud, readonly EstadoSolicitud[]> = {
  esperando_pago: ["pago_reportado", "confirmada", "sin_unidad", "cancelada"],
  por_confirmar: ["pago_reportado", "confirmada", "sin_unidad", "cancelada"],
  pago_reportado: ["esperando_pago", "confirmada", "sin_unidad", "cancelada"],
  confirmada: ["completada", "sin_unidad", "cancelada"],
  sin_unidad: [],
  cancelada: [],
  completada: [],
};
export const puedePasar = (de: EstadoSolicitud, a: EstadoSolicitud): boolean => (TRANSICIONES[de] ?? []).includes(a);

export type ConfigReserva = {
  /** `traslados_config.reserva_ia`: la IA puede reservar. Sin la migración, false. */
  activa: boolean;
  /** % del total que se pide como adelanto (0 < pct ≤ 100). null = no configurado. */
  adelantoPct: number | null;
  /** A quién va el correo del pago reportado (texto: varias direcciones). null = el del perfil. */
  correo: string | null;
  /** P: minutos DE ATENCIÓN para confirmar (15..1440). */
  plazoConfirmacionMin: number;
  /** M: minutos reales entre la confirmación y el servicio (0..4320). */
  margenMin: number;
  /** Lo que se le promete para devolver (1..720 h). null = no se promete un plazo. */
  devolucionPlazoH: number | null;
};

export const CONFIG_RESERVA_DEFECTO: ConfigReserva = {
  activa: false, adelantoPct: null, correo: null,
  plazoConfirmacionMin: PLAZO_CONFIRMACION_DEFECTO_MIN, margenMin: MARGEN_DEFECTO_MIN, devolucionPlazoH: null,
};

const enRango = (v: unknown, min: number, max: number): number | null => {
  const n = num(v);
  return n != null && n >= min && n <= max ? n : null;
};

/**
 * La configuración desde la fila de `traslados_config` (columnas `reserva_*` de traslados-09). Sin
 * las columnas (undefined) o con un valor fuera del rango de la migración, el defecto: apagada, sin
 * porcentaje, P = 120, M = 360. Solo `true` enciende.
 */
export function normalizarConfigReserva(raw: Record<string, unknown> | null | undefined): ConfigReserva {
  const r = raw && typeof raw === "object" ? raw : {};
  const pct = num(r.reserva_adelanto_pct);
  const P = enRango(r.reserva_plazo_confirmacion_min, 15, 1440);
  const M = enRango(r.reserva_margen_min, 0, 4320);
  const h = enRango(r.reserva_devolucion_plazo_h, 1, 720);
  const correo = txt(r.reserva_correo);
  return {
    activa: r.reserva_ia === true,
    adelantoPct: pct != null && pct > 0 && pct <= 100 ? r2(pct) : null,
    correo: correo || null,
    plazoConfirmacionMin: P != null ? Math.round(P) : PLAZO_CONFIRMACION_DEFECTO_MIN,
    margenMin: M != null ? Math.round(M) : MARGEN_DEFECTO_MIN,
    devolucionPlazoH: h != null ? Math.round(h) : null,
  };
}

// ── 2. El adelanto: la MISMA cuenta del PDF ──────────────────────────────────

export type Adelanto = { moneda: Moneda; total: number; adelanto: number | null; saldo: number | null };

/**
 * El total que imprime el PDF de la cotización (`cifrasDeFila`, la última figura) y el adelanto del
 * `pct` %, en la moneda de la cotización y redondeados al céntimo: `adelanto + saldo = total` exacto.
 * `pct` null (crédito) o fuera de (0, 100] → sin adelanto ni saldo. null si los importes no se pueden
 * imprimir (sin ítems, dólares sin tipo de cambio).
 */
export function adelantoDe(
  fila: Pick<FilaCotizacionLeida, "items_json" | "moneda" | "tipo_cambio" | "incluye_igv">,
  pct: number | null,
): Adelanto | null {
  const c = cifrasDeFila({ ...fila, traslado_json: null });
  if (!c || !c.figuras.length) return null;
  const total = r2(c.figuras[c.figuras.length - 1]);
  if (!(total > 0)) return null;
  const moneda = normalizarMoneda(fila.moneda);
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct > 100) return { moneda, total, adelanto: null, saldo: null };
  const adelanto = r2((total * pct) / 100);
  return { moneda, total, adelanto, saldo: r2(total - adelanto) };
}

/**
 * La firma de lo que se le COMUNICÓ al cliente (total, porcentaje, adelanto y saldo, en su moneda).
 * Se guarda en la solicitud: si alguien corrige la cotización después, la firma ya no coincide y se
 * sabe que el monto que tiene el cliente no es el de hoy. Estable: no depende del orden de los
 * campos ni del formato. null si no hay importes.
 */
export function firmaImportes(fila: Pick<FilaCotizacionLeida, "items_json" | "moneda" | "tipo_cambio" | "incluye_igv">, pct: number | null): string | null {
  const a = adelantoDe(fila, pct);
  if (!a) return null;
  return ["r1", a.moneda, a.total.toFixed(2), a.adelanto == null ? "credito" : r2(Number(pct)).toFixed(2), a.adelanto?.toFixed(2) ?? "", a.saldo?.toFixed(2) ?? ""].join("|");
}

// ── 2b. La huella de las cuentas que se le mandaron ──────────────────────────
//
// Al pedirle el pago (T1, o el bloque de pago de T4) el cliente recibe unas CUENTAS. Si la solicitud
// vuelve a pedir el pago más tarde (`reservar_traslado` con la solicitud ya viva), las cuentas de hoy
// tienen que ser las MISMAS que recibió: si alguien cambió la plantilla o el perfil entre medio, el
// cliente pagaría a una cuenta y la tarjeta esperaría el dinero en otra. La huella (un sha256 corto
// de las líneas, lo calcula el servidor) viaja DENTRO de `firma_importes`, detrás de los importes
// («…|cta:<hex>»): es la fila autoritativa de «lo que se le comunicó al cliente», la escribe el mismo
// INSERT que crea la solicitud y la tabla no tiene políticas (solo el servidor la lee y la escribe).
// Las firmas de antes (sin la huella) siguen comparando sus importes igual (`importesDeFirma`).

const SUFIJO_CUENTAS = "|cta:";
const RE_HUELLA = /^[0-9a-f]{8,64}$/;
const RE_FIRMA_CON_HUELLA = /\|cta:([0-9a-f]{8,64})$/;

/** La parte de importes de una firma (sin la huella de las cuentas). null si no hay firma. */
export function importesDeFirma(firma: string | null | undefined): string | null {
  if (typeof firma !== "string" || !firma) return null;
  return firma.replace(RE_FIRMA_CON_HUELLA, "");
}

/** La huella de las cuentas que guarda una firma, o null (una firma de antes, o sin cuentas mandadas). */
export function huellaDeFirma(firma: string | null | undefined): string | null {
  const m = String(firma ?? "").match(RE_FIRMA_CON_HUELLA);
  return m ? m[1] : null;
}

/** La firma con la huella de las cuentas que se le mandaron (o solo los importes, si no se mandó ninguna). */
export function firmaConCuentas(firma: string | null | undefined, huellaCuentas: string | null | undefined): string | null {
  const base = importesDeFirma(firma);
  if (!base) return null;
  return typeof huellaCuentas === "string" && RE_HUELLA.test(huellaCuentas) ? `${base}${SUFIJO_CUENTAS}${huellaCuentas}` : base;
}

export type CodigoReenvioPago =
  | "ok" | "cuentas_distintas" | "cuentas_sin_comprobar" | "perfil_sin_configurar" | "sin_cuentas" | "sin_huella" | "cuentas_cambiaron";

/** La nota interna de cada motivo (se deriva al ejecutivo con ella). */
export const NOTA_REENVIO_PAGO: Record<Exclude<CodigoReenvioPago, "ok">, string> = {
  cuentas_distintas: "Las cuentas de la plantilla de la cotización ya no son las de «corporativo»: revísalas en /cotizaciones/plantillas antes de volver a mandárselas al cliente.",
  cuentas_sin_comprobar: "No se pudo comprobar que las cuentas de la plantilla de la cotización sean las de «corporativo»: no se le volvieron a mandar.",
  perfil_sin_configurar: "El perfil de la empresa no tiene nombre (/configuracion/perfil): no se le volvieron a mandar las cuentas.",
  sin_cuentas: "La cotización ya no tiene cuentas bancarias en su moneda (/configuracion/perfil): no se le volvieron a mandar.",
  sin_huella: "No se puede comprobar que las cuentas de hoy sean las mismas que se le mandaron al pedirle el pago (la solicitud es anterior a ese control): si siguen siendo las mismas, mándaselas tú.",
  cuentas_cambiaron: "Las cuentas bancarias cambiaron desde que se le pidió el pago: revisa a cuál pagó (o va a pagar) antes de volver a mandárselas.",
};

/**
 * ¿Se le pueden volver a mandar las cuentas de pago (T1) a una solicitud que ya las recibió? Las
 * mismas condiciones con que se le mandaron la primera vez (`elegibilidadDeReserva`: cuentas de
 * «corporativo», perfil con nombre, cuentas en su moneda) y, además, que sean las MISMAS que recibió.
 * Sin la huella guardada (una solicitud de antes) no se puede saber: no se reenvía.
 */
export function juzgarReenvioPedirPago(x: {
  frente: string | null | undefined; perfilConfigurado: boolean; lineas: number;
  huellaEnviada: string | null | undefined; huellaActual: string | null | undefined;
}): { ok: boolean; codigo: CodigoReenvioPago; nota: string | null } {
  const no = (codigo: Exclude<CodigoReenvioPago, "ok">) => ({ ok: false, codigo, nota: NOTA_REENVIO_PAGO[codigo] });
  if (x.frente === "distintas") return no("cuentas_distintas");
  if (x.frente !== "iguales" && x.frente !== "misma_plantilla") return no("cuentas_sin_comprobar");
  if (x.perfilConfigurado !== true) return no("perfil_sin_configurar");
  if (!(x.lineas > 0) || !x.huellaActual) return no("sin_cuentas");
  if (!x.huellaEnviada) return no("sin_huella");
  if (x.huellaEnviada !== x.huellaActual) return no("cuentas_cambiaron");
  return { ok: true, codigo: "ok", nota: null };
}

// ── 2c. ¿El cliente del ERP es quien escribe por el chat? ────────────────────

/**
 * La regla del PDF (`clienteParaPdf`): el cliente está vinculado al contacto del CRM, o su teléfono
 * COMPLETO es el wa_id. Con ella se decide si al chat se le mandan los datos del cliente (la
 * Confirmación de Reserva) y si se le reconoce el crédito. false sin cliente.
 */
export function clienteVerificadoEnChat(
  clienteId: unknown, cliente: ClienteErp | null | undefined, ref: { contactoClienteId?: number | string | null; waId?: string | null },
): boolean {
  const v = clienteParaPdf(clienteId, cliente, ref).vinculo;
  return v === "contacto" || v === "telefono";
}

/**
 * Por qué «Vincular cliente» de la tarjeta ata (o no) el CONTACTO del CRM. La cotización y sus
 * reservas se atan siempre; el contacto solo si el número COMPLETO del cliente (su teléfono o el del
 * contacto operativo) es el wa_id del chat, o si ya estaba vinculado a ese cliente: atar el contacto
 * es lo que después deja mandarle al chat los datos del cliente (la Confirmación de Reserva).
 *  · `ya_vinculado`: el contacto ya era de ese cliente (nada que escribir);
 *  · `telefono` / `operativo`: el número coincide → se ata;
 *  · `otro_cliente`: el contacto ya es de otro cliente → no se toca;
 *  · `no_verificado`: ningún número coincide → no se ata;
 *  · `sin_contacto`: la conversación no tiene contacto.
 */
export type VinculoContacto = "ya_vinculado" | "telefono" | "operativo" | "otro_cliente" | "no_verificado" | "sin_contacto";

export function vinculoContactoReserva(x: {
  clienteId: number;
  cliente: { telefono?: string | null; operativo_celular?: string | null } | null | undefined;
  contacto: { id?: string | null; cliente_id?: number | string | null; wa_id?: string | null } | null | undefined;
}): { codigo: VinculoContacto; ata: boolean } {
  const c = x.contacto;
  if (!c || !String(c.id ?? "").trim()) return { codigo: "sin_contacto", ata: false };
  const actual = c.cliente_id == null || String(c.cliente_id).trim() === "" ? null : Number(c.cliente_id);
  if (actual === x.clienteId) return { codigo: "ya_vinculado", ata: false };
  if (actual != null) return { codigo: "otro_cliente", ata: false };
  if (mismoTelefonoE164(x.cliente?.telefono, c.wa_id)) return { codigo: "telefono", ata: true };
  if (mismoTelefonoE164(x.cliente?.operativo_celular, c.wa_id)) return { codigo: "operativo", ata: true };
  return { codigo: "no_verificado", ata: false };
}

/** Un importe para el cliente: el mismo formato del PDF, al céntimo. */
export const dinero = (n: number, moneda: Moneda): string => fmtImporte(r2(n), moneda, "es");

/** «50» o «12.5»: el porcentaje sin ceros de sobra. */
export const fmtPct = (p: number): string => String(r2(p));

// ── 3. Las cuentas del chat: las del PDF ─────────────────────────────────────

export type CuentasMensaje = { cuentas: CuentaBancaria[]; lineas: string[]; aviso: AvisoPdf | null };

/**
 * Las cuentas que se le mandan al cliente, en la moneda de la cotización: EXACTAMENTE las que
 * imprime el bloque de cuentas del PDF (`cuentasCorporativo` con la plantilla de la cotización y el
 * perfil, y `cuentasDoc` para el texto). Una línea por cuenta: «• BCP · S/ · Cta: … · CCI: …».
 * `cfg` tiene que ser la MISMA que recibe el PDF: la `usada` de `plantillaYReferenciaCuentas`
 * (lib/traslados/enviar-cotizacion-datos.ts), y la elegibilidad exige además que esas cuentas sean
 * las de «corporativo» (`cuentasFrenteACorporativo` → `cuentas_distintas`).
 */
export function cuentasEnMensaje(cfg: PlantillaPdfCfg | null | undefined, empresa: PerfilEmpresa | null | undefined, moneda: Moneda): CuentasMensaje {
  const r = cuentasCorporativo(cfg, empresa, normalizarMoneda(moneda));
  const doc = cuentasDoc(r.cuentas, "es");
  const lineas = (doc?.items ?? []).map((c) => `• ${[c.banco, ...c.lineas].map(txt).filter(Boolean).join(" · ")}`);
  return { cuentas: r.cuentas, lineas, aviso: r.aviso };
}

// ── 4. El dinero de una solicitud ────────────────────────────────────────────

export type PagoSolicitud = { sentido?: string | null; monto?: number | string | null; moneda?: string | null; anulado?: boolean | null };

/**
 * Lo cobrado (sentido «cobro») y lo devuelto (sentido «pago») en la moneda de la reserva, sin
 * anulados. Un movimiento sin sentido no cuenta para ninguno de los dos: una devolución que suma
 * como adelanto es plata que se le pide dos veces al cliente.
 */
export function dineroDeSolicitud(pagos: readonly PagoSolicitud[] | null | undefined, moneda: Moneda): { cobrado: number; devuelto: number } {
  let cobrado = 0, devuelto = 0;
  for (const p of pagos ?? []) {
    if (!p || p.anulado === true) continue;
    const m = num(p.monto);
    if (m == null || !(m > 0) || normalizarMoneda(p.moneda) !== normalizarMoneda(moneda)) continue;
    if (p.sentido === "cobro") cobrado += m;
    else if (p.sentido === "pago") devuelto += m;
  }
  return { cobrado: r2(cobrado), devuelto: r2(devuelto) };
}

/** Lo que se devuelve con un porcentaje decidido sobre lo cobrado. */
export function devolucionDecidida(cobrado: number, pct: number): number {
  const c = Math.max(0, Number(cobrado) || 0);
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  return r2((c * p) / 100);
}

/**
 * Lo que la empresa RETIENE de lo cobrado: cobrado − devuelto (lo devuelto o lo que se decidió
 * devolver), nunca negativo. Es el total del comprobante del cargo.
 */
export function cargoRetenido(x: { cobrado: number; devuelto: number }): number {
  const c = Number(x.cobrado), d = Number(x.devuelto);
  if (!Number.isFinite(c) || !Number.isFinite(d)) return 0;
  return Math.max(0, r2(c - d));
}

// ── 5. Qué le falta a una solicitud, y quién lo hace ─────────────────────────

export type CodigoPendiente =
  | "pagar" | "confirmar_disponibilidad" | "verificar_pago" | "completar_adelanto" | "vincular_cliente"
  | "emitir_confirmacion" | "enviar_confirmacion" | "cancelar_en_programacion" | "registrar_devolucion"
  | "emitir_cargo" | "ajustar_cargo" | "resolver_cancelacion" | "crear_reserva";

export type QuienPendiente = "cliente" | "crm" | "tesoreria" | "programacion" | "facturacion";

export type Pendiente = { codigo: CodigoPendiente; quien: QuienPendiente; detalle: string; vence?: string | null };

export type SolicitudVista = {
  estado: EstadoSolicitud;
  orden?: "pago_primero" | "disponibilidad_primero" | null;
  /** null = crédito (no se pide adelanto). */
  adelanto_pct: number | null;
  confirmar_antes_de?: string | null;
  /** El cliente pidió cancelar y la solicitud sigue abierta: lo resuelve un ejecutivo. */
  cancelacion_pedida_en?: string | null;
  devolucion_pct?: number | null;
  /** Comprobantes que el cliente mandó por el chat (registrados en la solicitud). */
  comprobantes?: number | null;
};

/** El comprobante del cargo como lo ve `queFalta`. */
export type CargoParaQueFalta = {
  id: number; numero: string | null; serie?: string | null;
  total?: number | null; estado?: string | null; sunat_estado?: string | null;
  /** La suma de las notas de crédito vivas que ya lo referencian. */
  notasCredito?: number | null;
};

/** Lo pendiente del comprobante del cargo con lo retenido de hoy (Facturación). */
function pendientesDelCargo(retenido: number, cargo: CargoParaQueFalta | null, mon: Moneda): Pendiente[] {
  if (!cargo) {
    return retenido > 0 ? [{ codigo: "emitir_cargo", quien: "facturacion", detalle: "Falta el comprobante del cargo retenido: no se llegó a crear. Créalo en /facturacion." }] : [];
  }
  const sinNumero: Pendiente = { codigo: "emitir_cargo", quien: "facturacion", detalle: "El comprobante del cargo retenido está creado sin número: emítelo ante SUNAT y escribe su serie y número en /facturacion." };
  if (cargo.total === undefined) return retenido > 0 && !txt(cargo.numero) ? [sinNumero] : [];
  const j = juzgarCargo({ retenido, actual: { id: cargo.id, serie: cargo.serie, numero: cargo.numero, total: cargo.total, estado: cargo.estado, sunat_estado: cargo.sunat_estado }, notasCredito: cargo.notasCredito, moneda: mon });
  switch (j.codigo) {
    case "al_dia": return cargoEditable({ numero: cargo.numero, estado: cargo.estado, sunat_estado: cargo.sunat_estado }) && retenido > 0 ? [sinNumero] : [];
    case "actualizar": return [{ codigo: "emitir_cargo", quien: "facturacion", detalle: `${j.detalle} El ERP lo recalcula solo (al registrar un cobro o una devolución, y en la revisión de cada 10 minutos); después, emítelo ante SUNAT y escribe su serie y número en /facturacion.` }];
    case "retirar": return [{ codigo: "ajustar_cargo", quien: "facturacion", detalle: `${j.detalle} El ERP lo deja anulado solo (en la próxima acción o en la revisión de cada 10 minutos): no lo emitas.` }];
    case "ajustar_emitido": return [{ codigo: "ajustar_cargo", quien: "facturacion", detalle: j.detalle }];
    default: return [];
  }
}

const SIN_TC_DETALLE = "El adelanto no se puede calcular (la cotización en dólares no tiene un tipo de cambio válido): corrígela en /cotizaciones.";

/**
 * Lo que le falta a la solicitud, en orden, cada cosa con su dueño. Una solicitud ABIERTA tiene
 * siempre al menos una; una COMPLETADA, ninguna; una CANCELADA o SIN UNIDAD, solo lo que queda de
 * dinero (devolver, emitir el cargo) y de la reserva en Programación — saldado eso, ninguna.
 * `x.adelanto` es el monto (de `adelantoDe` con `s.adelanto_pct`); `x.devuelto` lo REGISTRADO.
 */
export function queFalta(
  s: SolicitudVista,
  x: {
    cobrado: number;
    devuelto: number;
    adelanto: number | null;
    reserva: { id: number; estado: string; cliente_id: number | null } | null;
    confirmacionEnviada: boolean;
    /** Ya se emitió (al menos una versión) la Confirmación de Reserva. Sin el dato, = `confirmacionEnviada`. */
    confirmacionEmitida?: boolean;
    /**
     * El comprobante del cargo. Con `total` (lo que lee el servidor) se juzga si sigue al día
     * (`juzgarCargo`); sin él, solo si tiene número (como antes).
     */
    cargo: CargoParaQueFalta | null;
    /** Para escribir los importes en el detalle. Sin ella, soles. */
    moneda?: Moneda;
  },
): Pendiente[] {
  const out: Pendiente[] = [];
  const mon = normalizarMoneda(x.moneda);
  const cobrado = Math.max(0, Number(x.cobrado) || 0);
  const devuelto = Math.max(0, Number(x.devuelto) || 0);
  if (s.estado === "completada") return out;

  if (s.estado === "cancelada" || s.estado === "sin_unidad") {
    if (x.reserva && x.reserva.estado !== "cancelada") {
      out.push({ codigo: "cancelar_en_programacion", quien: "programacion", detalle: "La reserva sigue viva en Programación: cancélala ahí (ahí se decide qué pasa con su importe)." });
    }
    if (cobrado > 0) {
      const pct = s.estado === "sin_unidad" ? 100 : s.devolucion_pct;
      if (pct == null || !Number.isFinite(Number(pct))) {
        out.push({ codigo: "resolver_cancelacion", quien: "tesoreria", detalle: `Hay ${dinero(cobrado, mon)} cobrados: elige cuánto se devuelve según las políticas de reserva y cancelación.` });
      } else {
        const aDevolver = devolucionDecidida(cobrado, Number(pct));
        if (devuelto + 0.005 < aDevolver) {
          out.push({ codigo: "registrar_devolucion", quien: "tesoreria", detalle: `Falta devolver ${dinero(aDevolver - devuelto, mon)} (de ${dinero(aDevolver, mon)}): transfiérelo y regístralo como devolución.` });
        }
        out.push(...pendientesDelCargo(cargoRetenido({ cobrado, devuelto: aDevolver }), x.cargo, mon));
      }
    } else if (x.cargo && x.cargo.total !== undefined) {
      // Sin cobros ya no se retiene nada: un comprobante que quedó de antes se retira o se ajusta.
      out.push(...pendientesDelCargo(0, x.cargo, mon));
    }
    return out;
  }

  // Abiertas.
  const vence = s.confirmar_antes_de ?? null;
  if (txt(s.cancelacion_pedida_en)) {
    out.push({ codigo: "resolver_cancelacion", quien: "tesoreria", detalle: "El cliente pidió cancelar: decide cuánto se devuelve según las políticas y las horas de anticipación." });
    return out;
  }
  const credito = s.adelanto_pct == null;
  const adelanto = x.adelanto;
  const pagado = credito || (adelanto != null && cobrado + 0.005 >= adelanto);
  const reportado = Number(s.comprobantes ?? 0) > 0;
  const pagoPendiente = (): Pendiente => {
    if (adelanto == null) return { codigo: "pagar", quien: "crm", detalle: SIN_TC_DETALLE };
    if (cobrado > 0) return { codigo: "completar_adelanto", quien: "cliente", detalle: `Pagó ${dinero(cobrado, mon)}; faltan ${dinero(adelanto - cobrado, mon)} para completar el adelanto.` };
    if (reportado) return { codigo: "verificar_pago", quien: "tesoreria", detalle: "El cliente reportó un pago: verifícalo en el banco y regístralo como adelanto. No lo registres sin ver el dinero en la cuenta." };
    return { codigo: "pagar", quien: "cliente", detalle: `Esperando el adelanto de ${dinero(adelanto, mon)}.` };
  };
  const confirmar: Pendiente = { codigo: "confirmar_disponibilidad", quien: "programacion", detalle: "Confirma si hay una unidad disponible («Hay unidad» / «No hay unidad»).", vence };

  if (s.estado === "esperando_pago") {
    out.push(pagado ? confirmar : pagoPendiente());
    return out;
  }
  if (s.estado === "por_confirmar") {
    out.push(confirmar);
    if (!pagado && reportado) out.push(pagoPendiente());
    return out;
  }
  if (s.estado === "pago_reportado") {
    if (!pagado) out.push(pagoPendiente());
    out.push(confirmar);
    return out;
  }
  // confirmada
  if (!x.reserva) out.push({ codigo: "crear_reserva", quien: "programacion", detalle: "La reserva no se llegó a crear en Programación: vuelve a pulsar «Hay unidad» o créala desde /cotizaciones (→ Res.)." });
  if (!pagado) out.push(pagoPendiente());
  if (x.reserva && x.reserva.cliente_id == null) out.push({ codigo: "vincular_cliente", quien: "crm", detalle: "La reserva no tiene cliente del ERP: vincúlalo al contacto (la Confirmación de Reserva lo exige)." });
  if (pagado && x.reserva && x.reserva.cliente_id != null) {
    const emitida = x.confirmacionEmitida ?? x.confirmacionEnviada;
    if (!emitida) out.push({ codigo: "emitir_confirmacion", quien: "crm", detalle: "Emite la Confirmación de Reserva." });
    else out.push({
      codigo: "enviar_confirmacion", quien: "crm",
      detalle: x.confirmacionEnviada
        ? "La Confirmación de Reserva ya se envió: cierra la solicitud desde la tarjeta."
        : "Envía la Confirmación de Reserva por WhatsApp (dentro de las 24 h de la conversación) o descárgala y envíala por wa.me.",
    });
  }
  return out;
}

// ── 6. ¿La política escrita contradice la configuración? ─────────────────────

export type ContradiccionPolitica = { linea: string; codigo: "adelanto_pct" | "plazo_devolucion"; leido: number; config: number };

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const PCT_ADELANTO = [
  /(\d+(?:[.,]\d+)?)\s*(?:%|por\s*ciento)\s+(?:[a-z]+\s+){0,3}?(?:de|del|como)\s+(?:adelanto|anticipo)\b/g,
  /\b(?:adelanto|anticipo)\s+(?:[a-z]+\s+){0,3}?(?:de|del)\s+(\d+(?:[.,]\d+)?)\s*(?:%|por\s*ciento)/g,
];
const PLAZO_DEVOLUCION = /\bm[aá]x(?:imo|\.)?\s*(?:de\s+)?(\d+)\s*(?:h|hrs?|horas?)\b/g;

/**
 * Las líneas de la política (la que se le envía al cliente al pie de la letra) que dicen OTRO
 * porcentaje de adelanto, u otro plazo máximo de devolución, que la configuración. Solo cuenta un
 * porcentaje pegado a «adelanto» / «anticipo» («50 % de adelanto», «adelanto del 50 %»): el 10 % de
 * un cargo o el 100 % de una devolución no son el adelanto.
 */
export function politicaContradiceConfig(
  lineas: readonly unknown[] | null | undefined,
  cfg: Pick<ConfigReserva, "adelantoPct" | "devolucionPlazoH">,
): ContradiccionPolitica[] {
  const out: ContradiccionPolitica[] = [];
  for (const l of lineas ?? []) {
    const linea = txt(l);
    if (!linea) continue;
    const t = sinTildes(linea);
    if (cfg.adelantoPct != null) {
      for (const re of PCT_ADELANTO) {
        re.lastIndex = 0;
        for (const m of t.matchAll(re)) {
          const n = Number(m[1].replace(",", "."));
          if (Number.isFinite(n) && Math.abs(n - cfg.adelantoPct) > 1e-9) out.push({ linea, codigo: "adelanto_pct", leido: n, config: cfg.adelantoPct });
        }
      }
    }
    if (cfg.devolucionPlazoH != null && /devol/.test(t)) {
      PLAZO_DEVOLUCION.lastIndex = 0;
      for (const m of t.matchAll(PLAZO_DEVOLUCION)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n !== cfg.devolucionPlazoH) out.push({ linea, codigo: "plazo_devolucion", leido: n, config: cfg.devolucionPlazoH });
      }
    }
  }
  return out;
}

// ── 7. El comprobante del cargo retenido (fila de `facturas`) ────────────────

export type ItemFacturaCargo = { descripcion: string; cantidad: 1; precio_unit: number; total: number };

/**
 * La fila de `facturas` del cargo retenido, SIN `total` (columna generada: subtotal + igv). Las
 * columnas verificadas contra producción (22-10-2026): `fecha_emision` es NOT NULL (va la fecha en
 * que el ERP lo arma; quien lo emite la corrige) y `serie` tiene defecto 'F001' (va null a propósito:
 * una boleta no es F001 y la serie la escribe quien lo emite).
 */
export type FilaFacturaCargo = {
  cliente_id: number | null;
  cotizacion_id: number;
  reserva_id: number | null;
  tipo_comprobante: "factura" | "boleta";
  serie: null;
  numero: null;
  fecha_emision: string;
  moneda: Moneda;
  tipo_cambio: number | null;
  subtotal: number;
  igv: 0;
  estado: "pendiente";
  sunat_estado: "pendiente";
  items_json: ItemFacturaCargo[];
  observaciones: string;
};

/** Lo que se escribe en las observaciones del cargo para encontrarlo después (idempotencia). */
export const marcaCargoReserva = (solicitudId: number | string): string => `Solicitud de reserva #${txt(solicitudId)}`;

export const OBSERVACION_IGV_CARGO = "Revisar con contabilidad el tratamiento del IGV de este cargo.";

const fechaDdMmAaaa = (iso: string | null | undefined): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null;
const horaHhMm = (h: string | null | undefined): string | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(txt(h));
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

/**
 * El comprobante del cargo de una cancelación con devolución menor al 100 % (decisión del dueño):
 * total = lo retenido (`cargoRetenido`), en la moneda y al tipo de cambio de la cotización; factura
 * si el cliente tiene un RUC válido, si no boleta. null si no se retiene nada. No toca la reserva
 * ni `planDeCancelacion`: es un documento aparte.
 */
export function filaFacturaCargo(x: {
  solicitudId: number | string;
  cotizacion: { id: number; numero: string; moneda?: string | null; tipo_cambio?: number | string | null };
  cliente: { id: number; ruc?: string | null } | null;
  reservaId: number | null;
  cobrado: number;
  /** Lo devuelto o lo que se decidió devolver. */
  devuelto: number;
  hoy: string;
  servicio?: { fecha?: string | null; hora?: string | null } | null;
}): { fila: FilaFacturaCargo; total: number } | null {
  const total = cargoRetenido({ cobrado: x.cobrado, devuelto: x.devuelto });
  if (!(total > 0)) return null;
  const moneda = normalizarMoneda(x.cotizacion.moneda);
  const rucTxt = txt(x.cliente?.ruc);
  const ruc = rucValido(rucTxt);
  const f = fechaDdMmAaaa(x.servicio?.fecha), h = horaHhMm(x.servicio?.hora);
  const servicio = f ? ` (servicio del ${f}${h ? ` a las ${h}` : ""})` : "";
  const descripcion = `Cargo por cancelación de la reserva de traslado de la cotización N° ${txt(x.cotizacion.numero)}${servicio}`;
  const notas = [
    OBSERVACION_IGV_CARGO,
    `${marcaCargoReserva(x.solicitudId)}: cobrado ${dinero(x.cobrado, moneda)}, devuelto ${dinero(x.devuelto, moneda)}, retenido ${dinero(total, moneda)}.`,
    "Lo armó el ERP sin número: la serie, el número y el envío a SUNAT los hace quien lo emite.",
  ];
  if (rucTxt && !ruc) notas.push(`El RUC del cliente («${rucTxt.slice(0, 20)}») no es válido: se armó como boleta. Corrige el RUC en /clientes y cambia el tipo si corresponde.`);
  return {
    total,
    fila: {
      cliente_id: x.cliente?.id ?? null,
      cotizacion_id: x.cotizacion.id,
      reserva_id: x.reservaId ?? null,
      tipo_comprobante: ruc ? "factura" : "boleta",
      serie: null,
      numero: null,
      fecha_emision: x.hoy,
      moneda,
      tipo_cambio: moneda === "USD" ? revisarTipoCambio(x.cotizacion.tipo_cambio).tc : 1,
      subtotal: total,
      igv: 0,
      estado: "pendiente",
      sunat_estado: "pendiente",
      items_json: [{ descripcion, cantidad: 1, precio_unit: total, total }],
      observaciones: notas.join(" "),
    },
  };
}

// ── 7b. El cargo se RECALCULA mientras no tenga número ───────────────────────
//
// Antes el comprobante del cargo se creaba UNA vez y quedaba con el importe de ese momento: un cobro
// registrado después (o uno anulado en Finanzas) lo dejaba diciendo otra cosa que el dinero. Ahora:
//   · SIN número (un borrador que armó el ERP): se recalcula; si ya no se retiene nada, se retira
//     (queda «anulada» y se desata de la solicitud);
//   · CON número (emitido ante SUNAT) o en otro estado que «pendiente»: NO se toca nunca. Si el
//     importe ya no corresponde, lo que falta es una nota de crédito (o un comprobante por la
//     diferencia si sube), y eso lo hace Facturación;
//   · «anulada» por una persona: el ERP no la recrea ni la juzga.
// Las notas de crédito que ya la referencian («F001-25») se descuentan antes de comparar.

/** El comprobante del cargo como lo lee el servidor (`facturas`). */
export type FacturaCargoActual = {
  id: number;
  serie?: string | null;
  numero?: string | null;
  subtotal?: number | string | null;
  igv?: number | string | null;
  total?: number | string | null;
  estado?: string | null;
  sunat_estado?: string | null;
  observaciones?: string | null;
  items_json?: unknown;
};

/** ¿Es un borrador del ERP (sin número, «pendiente» y sin enviar a SUNAT)? Solo esos se recalculan. */
export function cargoEditable(f: Pick<FacturaCargoActual, "numero" | "estado" | "sunat_estado"> | null | undefined): boolean {
  if (!f) return false;
  if (txt(f.numero)) return false;
  if (txt(f.estado || "pendiente") !== "pendiente") return false;
  const sunat = txt(f.sunat_estado || "pendiente");
  return sunat === "pendiente";
}

/** «F001-25» desde serie y número (sin espacios, en mayúsculas, el número sin ceros a la izquierda). null sin número. */
export function referenciaComprobante(serie: unknown, numero: unknown): string | null {
  const n = txt(numero).replace(/\s+/g, "").toUpperCase().replace(/^0+(?=\d)/, "");
  if (!n) return null;
  const s = txt(serie).replace(/\s+/g, "").toUpperCase();
  return s ? `${s}-${n}` : n;
}

/** ¿La referencia que escribió Facturación en una nota de crédito es este comprobante? */
/** Más largo que esto no es una referencia «F001-00025»: no se evalúa (texto que cualquier sesión escribe). */
const MAX_REF = 40;

export function mismaReferencia(ref: unknown, serie: unknown, numero: unknown): boolean {
  const esta = referenciaComprobante(serie, numero);
  if (!esta) return false;
  const crudo = String(ref ?? "");
  if (crudo.length > MAX_REF * 2) return false;
  const r = crudo.replace(/\s+/g, "").toUpperCase();
  if (!r || r.length > MAX_REF) return false;
  const m = /^([A-Z0-9]+)-(\d+)$/.exec(r);
  const otra = m ? `${m[1]}-${m[2].replace(/^0+(?=\d)/, "")}` : r.replace(/^0+(?=\d)/, "");
  return otra === esta;
}

export type CodigoCargo =
  /** No se retiene nada y no hay comprobante. */
  | "nada"
  /** Se retiene algo y no hay comprobante: se crea. */
  | "crear"
  /** El comprobante (o lo que queda tras sus notas de crédito) dice lo que corresponde. */
  | "al_dia"
  /** Una persona lo anuló en Facturación: el ERP no lo recrea. */
  | "anulado"
  /** Borrador con otro importe: se recalcula. */
  | "actualizar"
  /** Borrador y ya no se retiene nada: se retira. */
  | "retirar"
  /** Emitido con otro importe: hace falta una nota de crédito (baja) o un comprobante por la diferencia (sube). */
  | "ajustar_emitido";

export type JuicioCargo = { codigo: CodigoCargo; antes: number | null; ahora: number; diferencia: number; detalle: string };

/**
 * Qué pasa con el comprobante del cargo, con lo retenido de HOY. `notasCredito`: la suma de las notas
 * de crédito vivas que ya lo referencian (solo cuenta en uno emitido).
 */
export function juzgarCargo(x: { retenido: number; actual: FacturaCargoActual | null; notasCredito?: number | null; moneda?: Moneda }): JuicioCargo {
  const mon = normalizarMoneda(x.moneda);
  const ahora = Math.max(0, r2(Number(x.retenido) || 0));
  const a = x.actual;
  if (!a) {
    return ahora > 0
      ? { codigo: "crear", antes: null, ahora, diferencia: ahora, detalle: `Se retienen ${dinero(ahora, mon)}: falta su comprobante.` }
      : { codigo: "nada", antes: null, ahora, diferencia: 0, detalle: "No se retiene nada: no hace falta comprobante." };
  }
  if (txt(a.estado) === "anulada") return { codigo: "anulado", antes: null, ahora, diferencia: 0, detalle: "El comprobante del cargo está anulado en Facturación: el ERP no lo recrea." };
  const total = num(a.total) ?? r2((num(a.subtotal) ?? 0) + (num(a.igv) ?? 0));
  const editable = cargoEditable(a);
  const neto = editable ? total : r2(total - Math.max(0, Number(x.notasCredito) || 0));
  const diferencia = r2(ahora - neto);
  if (Math.abs(diferencia) < 0.005) return { codigo: "al_dia", antes: neto, ahora, diferencia: 0, detalle: `El comprobante del cargo dice ${dinero(ahora, mon)}, lo que corresponde.` };
  if (editable) {
    return ahora > 0
      ? { codigo: "actualizar", antes: total, ahora, diferencia, detalle: `El borrador del cargo decía ${dinero(total, mon)} y ahora corresponde ${dinero(ahora, mon)}: se recalcula.` }
      : { codigo: "retirar", antes: total, ahora, diferencia, detalle: `Ya no se retiene nada: el borrador del cargo de ${dinero(total, mon)} se retira.` };
  }
  const ref = referenciaComprobante(a.serie, a.numero) ?? `#${a.id}`;
  const detalle = diferencia < 0
    ? `El comprobante del cargo ${ref} ya está emitido por ${dinero(neto, mon)} y ahora corresponde ${dinero(ahora, mon)}: emite una nota de crédito por ${dinero(-diferencia, mon)} en /facturacion (con la referencia ${ref}).`
    : `El comprobante del cargo ${ref} ya está emitido por ${dinero(neto, mon)} y ahora corresponde ${dinero(ahora, mon)}: emite un comprobante por la diferencia de ${dinero(diferencia, mon)} en /facturacion.`;
  return { codigo: "ajustar_emitido", antes: neto, ahora, diferencia, detalle };
}

/**
 * Las observaciones del borrador con la línea de la marca puesta al día (la que escribe
 * `filaFacturaCargo`); lo demás que tenga, una persona incluida, se conserva. Sin la línea, se agrega.
 */
export function observacionesConMarca(actual: unknown, x: { solicitudId: number | string; cobrado: number; devuelto: number; retenido: number; moneda: Moneda }): string {
  const linea = `${marcaCargoReserva(x.solicitudId)}: cobrado ${dinero(x.cobrado, x.moneda)}, devuelto ${dinero(x.devuelto, x.moneda)}, retenido ${dinero(x.retenido, x.moneda)}.`;
  const obs = String(actual ?? "").trim();
  // Sin expresiones regulares: las observaciones las puede escribir cualquier sesión, y una regex con
  // varios `.*?` sobre un texto armado a propósito tarda segundos (auditoría del 23-10-2026). Se busca
  // el inicio de la línea y su primer punto seguido de un espacio (o del fin): los importes llevan su
  // punto decimal seguido de una cifra, así que no lo cortan.
  if (obs.length > MAX_OBS_REESCRIBIR) return `${obs} ${linea}`;
  const ini = obs.indexOf(`${marcaCargoReserva(x.solicitudId)}: cobrado `);
  if (ini < 0) return obs ? `${obs} ${linea}` : linea;
  let fin = -1;
  for (let i = ini; i < obs.length; i++) {
    if (obs[i] === "." && (i + 1 === obs.length || /\s/.test(obs[i + 1]))) { fin = i + 1; break; }
  }
  if (fin < 0) return `${obs} ${linea}`;
  return `${obs.slice(0, ini)}${linea}${obs.slice(fin)}`;
}

/** Más largo que esto no se reescribe por dentro: se agrega la línea al final (operativo, NO medido). */
const MAX_OBS_REESCRIBIR = 4000;

/**
 * El patch de un borrador que se recalcula. Si Facturación ya repartió el total en base e IGV, el
 * reparto se conserva en la misma proporción; si no, todo va en la base (como lo arma el ERP).
 */
export function patchCargoRecalculado(actual: FacturaCargoActual, x: { solicitudId: number | string; cobrado: number; devuelto: number; retenido: number; moneda: Moneda }): Record<string, unknown> {
  const total = Math.max(0, r2(Number(x.retenido) || 0));
  const igvAntes = num(actual.igv) ?? 0;
  const totalAntes = num(actual.total) ?? r2((num(actual.subtotal) ?? 0) + igvAntes);
  const igv = igvAntes !== 0 && totalAntes > 0 ? r2((total * igvAntes) / totalAntes) : 0;
  const items = Array.isArray(actual.items_json) ? (actual.items_json as Record<string, unknown>[]) : [];
  const base = items[0] && typeof items[0] === "object" ? items[0] : { descripcion: "Cargo por cancelación de la reserva de traslado", cantidad: 1 };
  return {
    subtotal: r2(total - igv),
    igv,
    items_json: [{ ...base, cantidad: 1, precio_unit: total, total }],
    observaciones: observacionesConMarca(actual.observaciones, x),
  };
}

// ── 8. Los textos que le manda el código al cliente (T1–T11) ─────────────────
// Cada uno de usted Y de tú, escritos enteros. Ningún dato de la empresa: las cuentas y el correo
// llegan de la configuración. El código los arma; el modelo nunca escribe un importe ni una cuenta.

/** «2 horas», «1 hora y 30 minutos», «45 minutos». */
export function textoPlazoMinutos(min: number): string {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60), r = m % 60;
  const hs = h === 1 ? "1 hora" : `${h} horas`;
  const ms = r === 1 ? "1 minuto" : `${r} minutos`;
  if (h === 0) return ms;
  return r ? `${hs} y ${ms}` : hs;
}
const textoHoras = (h: number) => (h === 1 ? "1 hora" : `${h} horas`);

/** « del 25/12/2026 a las 15:00» (o solo la fecha, o nada). */
function delCuando(fecha: string | null | undefined, hora: string | null | undefined): string {
  const f = fechaDdMmAaaa(fecha), h = horaHhMm(hora);
  if (!f) return "";
  return h ? ` del ${f} a ${aLas(h)}` : ` del ${f}`;
}

export type BloquePago = { numero: string; moneda: Moneda; pct: number; adelanto: number; saldo: number; cuentas: readonly string[] };

/** La primera parte de T1 (también va en T4 cuando primero se confirmó la unidad). */
export function bloquePago(b: BloquePago, estilo: EstiloMensajes): string {
  const tu = esTu(estilo);
  // La misma idea que la política publicada («el 50 % restante se paga al iniciar el servicio»):
  // el mensaje no puede contradecir la política que la IA envía.
  const saldo = b.saldo > 0.004 ? ` El saldo, ${dinero(b.saldo, b.moneda)}, se paga al iniciar el servicio, cuando la unidad se presente en el punto de recojo.` : "";
  const cuentas = b.cuentas.map(txt).filter(Boolean).join("\n");
  return tu
    ? `Para reservar tu traslado de la cotización N° ${b.numero} se abona el ${fmtPct(b.pct)} % del total como adelanto: *${dinero(b.adelanto, b.moneda)}*.${saldo}\nPuedes pagar a cualquiera de estas cuentas:\n${cuentas}`
    : `Para reservar su traslado de la cotización N° ${b.numero} se abona el ${fmtPct(b.pct)} % del total como adelanto: *${dinero(b.adelanto, b.moneda)}*.${saldo}\nPuede pagar a cualquiera de estas cuentas:\n${cuentas}`;
}

/**
 * Las condiciones que acompañan un pedido de pago (T1, T4) y las políticas (T8): el resumen de la
 * política de la cotización (`consideraciones_json.reserva_resumen`) y el enlace a sus condiciones
 * completas (`enlaceCondiciones`, lib/condiciones-publicas.ts). Sin enlace válido no cambian nada.
 */
export type CondicionesMensaje = { resumen?: readonly unknown[] | null; enlace?: string | null };

/** Las líneas del resumen, en una línea cada una y sin las vacías. */
const lineasResumen = (c: CondicionesMensaje | null | undefined): string[] => (Array.isArray(c?.resumen) ? c!.resumen!.map(txt).filter(Boolean) : []);

/**
 * El bloque «Antes de pagar…» de T1 y T4: con resumen, sus puntos y el enlace; con solo el enlace, una
 * línea con él; sin un enlace válido (`esEnlaceCondiciones`), null (el texto de siempre).
 */
export function bloqueCondicionesAntesDePagar(c: CondicionesMensaje | null | undefined, estilo: EstiloMensajes): string | null {
  if (!c || !esEnlaceCondiciones(c.enlace)) return null;
  const resumen = lineasResumen(c);
  if (resumen.length) return `Antes de pagar, lo principal de nuestras condiciones:\n${resumen.map((l) => `• ${l}`).join("\n")}\nCondiciones completas: ${c.enlace}`;
  return esTu(estilo)
    ? `Antes de pagar, revisa nuestras condiciones de reserva, cambios y cancelación: ${c.enlace}`
    : `Antes de pagar, revise nuestras condiciones de reserva, cambios y cancelación: ${c.enlace}`;
}

/** T1 — pedir el pago (pago primero). Con `condiciones` (y su enlace), el bloque «Antes de pagar…» en lugar de ofrecer las políticas. */
export function mensajePedirPago(x: BloquePago & { plazoMin: number; atencion: Atencion; estilo: EstiloMensajes; condiciones?: CondicionesMensaje | null }): string {
  const plazo = textoPlazoMinutos(x.plazoMin);
  const horario = describirAtencion(x.atencion);
  const cond = bloqueCondicionesAntesDePagar(x.condiciones, x.estilo);
  return esTu(x.estilo)
    ? `${bloquePago(x, x.estilo)}\nCuando hayas pagado, envíanos por este chat la foto o captura del comprobante. Lo verificamos con el banco y te confirmamos la disponibilidad de la unidad en un máximo de ${plazo} dentro de nuestro horario de atención (${horario}). Si no hubiera una unidad disponible, te devolvemos el 100 % de lo pagado.${cond ? `\n${cond}` : " Si deseas, te envío nuestras políticas de reserva, cambios y cancelación."}`
    : `${bloquePago(x, x.estilo)}\nCuando haya pagado, envíenos por este chat la foto o captura del comprobante. Lo verificamos con el banco y le confirmamos la disponibilidad de la unidad en un máximo de ${plazo} dentro de nuestro horario de atención (${horario}). Si no hubiera una unidad disponible, le devolvemos el 100 % de lo pagado.${cond ? `\n${cond}` : " Si desea, le envío nuestras políticas de reserva, cambios y cancelación."}`;
}

/** T2 — primero se confirma la unidad («no pague todavía»). Con crédito, sin adelanto. */
export function mensajeDisponibilidadPrimero(x: {
  fecha: string | null; hora: string | null; frasePlazo: string | null; pct: number | null; credito: boolean; estilo: EstiloMensajes;
}): string {
  const cuando = delCuando(x.fecha, x.hora);
  const plazo = x.frasePlazo || "a la brevedad";
  const pct = x.pct != null && Number.isFinite(x.pct) ? ` (${fmtPct(x.pct)} % del total)` : "";
  if (esTu(x.estilo)) {
    return x.credito
      ? `Un ejecutivo confirma la disponibilidad de la unidad para tu traslado${cuando}, ${plazo}. En cuanto la confirme, te escribimos por este chat; tu pago se coordina según la condición de crédito acordada.`
      : `Antes de pedirte el pago, un ejecutivo confirma la disponibilidad de la unidad para tu traslado${cuando}, ${plazo}. En cuanto la confirme, te enviamos por este chat el monto del adelanto${pct} y las cuentas. Por favor, no realices ningún pago todavía.`;
  }
  return x.credito
    ? `Un ejecutivo confirma la disponibilidad de la unidad para su traslado${cuando}, ${plazo}. En cuanto la confirme, le escribimos por este chat; su pago se coordina según la condición de crédito acordada.`
    : `Antes de pedirle el pago, un ejecutivo confirma la disponibilidad de la unidad para su traslado${cuando}, ${plazo}. En cuanto la confirme, le enviamos por este chat el monto del adelanto${pct} y las cuentas. Por favor, no realice ningún pago todavía.`;
}

/** Lo que T3 necesita del cotejo (lib/traslados/comprobante-pago.ts). */
export type CotejoParaMensaje = {
  codigos: readonly string[];
  seguro: boolean;
  /** Lo leído, YA normalizado (monto en número y operación sin símbolos). */
  monto: number | null;
  operacion: string | null;
};

/** T3 — comprobante recibido. Nombra el monto SOLO si la lectura es segura. */
export function mensajeComprobanteRecibido(x: {
  cotejo: CotejoParaMensaje;
  /** El adelanto esperado (null con crédito). */
  esperado: number | null;
  moneda: Moneda;
  frasePlazo: string | null;
  /** La unidad ya está confirmada: lo que falta es verificar el pago y mandar la Confirmación. */
  unidadConfirmada?: boolean;
  estilo: EstiloMensajes;
}): string {
  const tu = esTu(x.estilo);
  const c = x.cotejo;
  const plazo = x.frasePlazo || "a la brevedad";
  const tiene = (k: string) => c.codigos.includes(k);
  if (tiene("ilegible") || tiene("no_es_comprobante") || tiene("sin_lectura") || (c.monto == null && !c.seguro)) {
    return tu
      ? "No pudimos leer el comprobante. ¿Nos envías una foto o captura donde se vean el monto, la fecha y el número de operación?"
      : "No pudimos leer el comprobante. ¿Nos envía una foto o captura donde se vean el monto, la fecha y el número de operación?";
  }
  const duro = ["otra_moneda", "operacion_repetida", "fecha_futura"].some(tiene);
  if (tiene("monto_menor") && !duro && c.monto != null && x.esperado != null) {
    return tu
      ? `Recibimos tu comprobante. En él leemos ${dinero(c.monto, x.moneda)} y el adelanto de tu reserva es ${dinero(x.esperado, x.moneda)}: un ejecutivo lo revisa con el banco y te escribe por este chat.`
      : `Recibimos su comprobante. En él leemos ${dinero(c.monto, x.moneda)} y el adelanto de su reserva es ${dinero(x.esperado, x.moneda)}: un ejecutivo lo revisa con el banco y le escribe por este chat.`;
  }
  const de = c.seguro && c.monto != null ? ` de ${dinero(c.monto, x.moneda)}${c.operacion ? ` (operación N° ${c.operacion})` : ""}` : "";
  if (x.unidadConfirmada) {
    return tu
      ? `Recibimos tu comprobante${de}. Lo verificamos con el banco y te enviamos la Confirmación de Reserva ${plazo}.`
      : `Recibimos su comprobante${de}. Lo verificamos con el banco y le enviamos la Confirmación de Reserva ${plazo}.`;
  }
  return tu
    ? `Recibimos tu comprobante${de}. Lo verificamos con el banco y te confirmamos la disponibilidad de la unidad ${plazo}. Si no hubiera una unidad disponible, te devolvemos el 100 % de lo pagado.`
    : `Recibimos su comprobante${de}. Lo verificamos con el banco y le confirmamos la disponibilidad de la unidad ${plazo}. Si no hubiera una unidad disponible, le devolvemos el 100 % de lo pagado.`;
}

/** T11 — adelanto incompleto. */
export function mensajeAdelantoIncompleto(x: { cobrado: number; falta: number; moneda: Moneda; estilo: EstiloMensajes }): string {
  return esTu(x.estilo)
    ? `Recibimos ${dinero(x.cobrado, x.moneda)}; para completar el adelanto de tu reserva faltan ${dinero(x.falta, x.moneda)}.`
    : `Recibimos ${dinero(x.cobrado, x.moneda)}; para completar el adelanto de su reserva faltan ${dinero(x.falta, x.moneda)}.`;
}

export type PagoEnHayUnidad = "verificado" | "reportado" | "pedir" | "credito" | "incompleto";

/**
 * T4 — hay unidad. `pago` dice qué se le cuenta del pago; con «pedir» e «incompleto» va el bloque de
 * pago y, con `condiciones` (y su enlace), al final el bloque «Antes de pagar…».
 */
export function mensajeHayUnidad(x: {
  fecha: string | null; hora: string | null; origen: string; destino: string;
  pago: PagoEnHayUnidad;
  moneda: Moneda;
  cobrado?: number;
  /** Para «pedir» (el bloque de T1) e «incompleto» (las cuentas y lo que falta). */
  bloque?: BloquePago | null;
  /** El resumen y el enlace a las condiciones completas: solo los usan «pedir» e «incompleto». */
  condiciones?: CondicionesMensaje | null;
  estilo: EstiloMensajes;
}): string {
  const tu = esTu(x.estilo);
  const condPago = () => { const c = bloqueCondicionesAntesDePagar(x.condiciones, x.estilo); return c ? `\n${c}` : ""; };
  const ruta = [txt(x.origen), txt(x.destino)].filter(Boolean).join(" → ");
  const base = tu
    ? `Confirmamos que hay una unidad disponible para tu traslado${delCuando(x.fecha, x.hora)}${ruta ? ` (${ruta})` : ""}.`
    : `Confirmamos que hay una unidad disponible para su traslado${delCuando(x.fecha, x.hora)}${ruta ? ` (${ruta})` : ""}.`;
  const cobrado = Math.max(0, Number(x.cobrado) || 0);
  switch (x.pago) {
    case "verificado":
      return tu
        ? `${base} Recibimos tu adelanto de ${dinero(cobrado, x.moneda)}. En breve te enviamos la Confirmación de Reserva.`
        : `${base} Recibimos su adelanto de ${dinero(cobrado, x.moneda)}. En breve le enviamos la Confirmación de Reserva.`;
    case "reportado":
      return tu
        ? `${base} Tu reserva queda confirmada en cuanto validemos tu pago con el banco; entonces te enviamos la Confirmación de Reserva.`
        : `${base} Su reserva queda confirmada en cuanto validemos su pago con el banco; entonces le enviamos la Confirmación de Reserva.`;
    case "credito":
      return tu ? `${base} En breve te enviamos la Confirmación de Reserva.` : `${base} En breve le enviamos la Confirmación de Reserva.`;
    case "incompleto": {
      const b = x.bloque;
      const falta = b ? Math.max(0, r2(b.adelanto - cobrado)) : 0;
      const t11 = mensajeAdelantoIncompleto({ cobrado, falta, moneda: x.moneda, estilo: x.estilo });
      const cuentas = (b?.cuentas ?? []).map(txt).filter(Boolean).join("\n");
      return tu
        ? `${base} ${t11}\nPuedes completarlo en cualquiera de estas cuentas:\n${cuentas}\nCuando hayas pagado, envíanos por este chat la foto o captura del comprobante.${condPago()}`
        : `${base} ${t11}\nPuede completarlo en cualquiera de estas cuentas:\n${cuentas}\nCuando haya pagado, envíenos por este chat la foto o captura del comprobante.${condPago()}`;
    }
    case "pedir":
    default: {
      const bloque = x.bloque ? bloquePago(x.bloque, x.estilo) : "";
      return tu
        ? `${base}\n${bloque}\nCuando hayas pagado, envíanos por este chat la foto o captura del comprobante; lo verificamos con el banco y te enviamos la Confirmación de Reserva.${condPago()}`
        : `${base}\n${bloque}\nCuando haya pagado, envíenos por este chat la foto o captura del comprobante; lo verificamos con el banco y le enviamos la Confirmación de Reserva.${condPago()}`;
    }
  }
}

/** T5 — no hay unidad. */
export function mensajeSinUnidad(x: { fecha: string | null; hora: string | null; conPago: boolean; plazoH: number | null; estilo: EstiloMensajes }): string {
  const cuando = delCuando(x.fecha, x.hora);
  const plazo = x.plazoH != null && x.plazoH > 0 ? ` en un máximo de ${textoHoras(Math.round(x.plazoH))}` : "";
  if (esTu(x.estilo)) {
    return x.conPago
      ? `Lamentamos informarte que no tenemos una unidad disponible para tu traslado${cuando}. Te devolvemos el 100 % de lo pagado${plazo}; te confirmamos por este chat cuando se realice.`
      : `Lamentamos informarte que no tenemos una unidad disponible para tu traslado${cuando}. No realices ningún pago por esta cotización.`;
  }
  return x.conPago
    ? `Lamentamos informarle que no tenemos una unidad disponible para su traslado${cuando}. Le devolvemos el 100 % de lo pagado${plazo}; le confirmamos por este chat cuando se realice.`
    : `Lamentamos informarle que no tenemos una unidad disponible para su traslado${cuando}. No realice ningún pago por esta cotización.`;
}

/** Las horas ENTERAS de anticipación con que llegó el pedido de cancelación (negativas: después del inicio). */
export function horasDeAnticipacion(pedidaMs: number, inicioMs: number | null): number | null {
  if (!Number.isFinite(pedidaMs) || inicioMs == null || !Number.isFinite(inicioMs)) return null;
  return Math.floor((inicioMs - pedidaMs) / 3_600_000);
}

/** T6 — cancelación registrada (con pago o con la unidad confirmada). Sin pago: `mensajeCanceladaSinPago`. */
export function mensajeCancelacionRegistrada(x: { fecha: string | null; hora: string | null; pedidaMs: number; inicioMs: number | null; estilo: EstiloMensajes }): string {
  const cuando = delCuando(x.fecha, x.hora);
  const dia = fechaLima(x.pedidaMs);
  const recibido = `, recibido el ${dia.slice(8, 10)}/${dia.slice(5, 7)} a ${aLas(minutosAHhmm(minutoDelDiaLima(x.pedidaMs)))}`;
  let antes = "";
  if (x.inicioMs != null && Number.isFinite(x.inicioMs)) {
    const diffMs = x.inicioMs - x.pedidaMs;
    const n = Math.floor(diffMs / 3_600_000);
    antes = diffMs <= 0 ? ", después de la hora de inicio del servicio"
      : n < 1 ? ", menos de una hora antes del inicio del servicio"
      : `, ${textoHoras(n)} antes del inicio del servicio`;
  }
  return esTu(x.estilo)
    ? `Registré tu pedido de cancelación de la reserva de tu traslado${cuando}${recibido}${antes}. Un ejecutivo te confirma por este chat lo que corresponde según nuestras políticas de reserva y cancelación.`
    : `Registré su pedido de cancelación de la reserva de su traslado${cuando}${recibido}${antes}. Un ejecutivo le confirma por este chat lo que corresponde según nuestras políticas de reserva y cancelación.`;
}

/** T6, sin ningún pago ni comprobante: la solicitud se cierra sola. */
export function mensajeCanceladaSinPago(x: { numero: string; estilo: EstiloMensajes }): string {
  return esTu(x.estilo)
    ? `Listo, anulamos tu pedido de reserva de la cotización N° ${x.numero}. Si deseas volver a reservar, escríbenos por este chat.`
    : `Listo, anulamos su pedido de reserva de la cotización N° ${x.numero}. Si desea volver a reservar, escríbanos por este chat.`;
}

/** T7 — cancelación resuelta por el ejecutivo. `monto` es lo que se devuelve. */
export function mensajeCancelacionResuelta(x: { monto: number; pct: number; moneda: Moneda; plazoH: number | null; estilo: EstiloMensajes }): string {
  const tu = esTu(x.estilo);
  if (!(x.monto > 0.004) || !(x.pct > 0)) {
    return tu
      ? "Tu reserva quedó cancelada. Según nuestras políticas de cancelación, en este caso no corresponde devolución."
      : "Su reserva quedó cancelada. Según nuestras políticas de cancelación, en este caso no corresponde devolución.";
  }
  const plazo = x.plazoH != null && x.plazoH > 0 ? ` en un máximo de ${textoHoras(Math.round(x.plazoH))}` : "";
  return tu
    ? `Tu reserva quedó cancelada. Te devolvemos ${dinero(x.monto, x.moneda)} (${fmtPct(x.pct)} % de lo pagado)${plazo}.`
    : `Su reserva quedó cancelada. Le devolvemos ${dinero(x.monto, x.moneda)} (${fmtPct(x.pct)} % de lo pagado)${plazo}.`;
}

/**
 * T8 — las políticas, al pie de la letra (las de la cotización). El correo, solo si el del perfil es
 * una dirección. null sin políticas (no se manda una lista vacía). Con el resumen de la política Y el
 * enlace a las condiciones completas (`resumen`, `enlace`), el resumen y el enlace; si falta uno de los
 * dos, la política entera, como siempre.
 */
export function mensajePoliticas(x: { numero: string; lineas: readonly unknown[]; email: string | null; estilo: EstiloMensajes; resumen?: readonly unknown[] | null; enlace?: string | null }): string | null {
  const lineas = (x.lineas ?? []).map(txt).filter(Boolean);
  if (!lineas.length) return null;
  const correo = correosDeTexto(x.email)[0] ?? null;
  const resumen = lineasResumen({ resumen: x.resumen });
  if (resumen.length && esEnlaceCondiciones(x.enlace)) {
    const puntos = resumen.map((l) => `• ${l}`).join("\n");
    return esTu(x.estilo)
      ? `Lo principal de nuestras políticas de reserva, cambios y cancelación (las de tu cotización N° ${x.numero}):\n${puntos}\nLas condiciones completas de tu reserva están aquí: ${x.enlace}\nPara cancelar o cambiar tu reserva, escríbenos por este mismo chat${correo ? ` o al correo ${correo}` : ""}.`
      : `Lo principal de nuestras políticas de reserva, cambios y cancelación (las de su cotización N° ${x.numero}):\n${puntos}\nLas condiciones completas de su reserva están aquí: ${x.enlace}\nPara cancelar o cambiar su reserva, escríbanos por este mismo chat${correo ? ` o al correo ${correo}` : ""}.`;
  }
  const lista = lineas.map((l) => `• ${l}`).join("\n");
  return esTu(x.estilo)
    ? `Estas son nuestras políticas de reserva, cambios y cancelación (las mismas de tu cotización N° ${x.numero}):\n${lista}\nPara cancelar o cambiar tu reserva, escríbenos por este mismo chat${correo ? ` o al correo ${correo}` : ""}.`
    : `Estas son nuestras políticas de reserva, cambios y cancelación (las mismas de su cotización N° ${x.numero}):\n${lista}\nPara cancelar o cambiar su reserva, escríbanos por este mismo chat${correo ? ` o al correo ${correo}` : ""}.`;
}

/** T9 — el pago no aparece en el banco. */
export function mensajePagoNoEncontrado(estilo: EstiloMensajes): string {
  return esTu(estilo)
    ? "Todavía no encontramos tu pago en el banco. ¿Nos confirmas la fecha, el banco y el número de operación, o nos envías otra captura del comprobante?"
    : "Todavía no encontramos su pago en el banco. ¿Nos confirma la fecha, el banco y el número de operación, o nos envía otra captura del comprobante?";
}

/** T10 — la guarda: el texto del modelo habló de dinero con una cotización de traslado en el chat. */
export function mensajeGuardaReserva(numero: string | null | undefined, estilo: EstiloMensajes): string {
  const n = txt(numero);
  return esTu(estilo)
    ? `Para reservar, te envío por este chat el monto del adelanto y las cuentas de pago. ¿Deseas reservar tu traslado${n ? ` de la cotización N° ${n}` : ""}?`
    : `Para reservar, le envío por este chat el monto del adelanto y las cuentas de pago. ¿Desea reservar su traslado${n ? ` de la cotización N° ${n}` : ""}?`;
}
