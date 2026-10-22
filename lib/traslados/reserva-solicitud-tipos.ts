// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-solicitud-tipos.ts — EL CONTRATO de las rutas de la reserva de traslados
// (la tarjeta del CRM, `app/api/crm/reservas-traslado`, y la lista de Tesorería,
// `app/api/reservas/solicitudes`): qué se manda, qué vuelve y con qué códigos. Lo importa el
// navegador: solo tipos y funciones PURAS, ningún cliente de Supabase ni secreto.
//
// Lo que hace cada acción y por qué vive en lib/traslados/reserva-solicitud-datos.ts (servidor).
// ──────────────────────────────────────────────────────────────────────────────

import type { EstadoSolicitud, Pendiente } from "./reserva-pago";
import type { CodigoCotejo } from "./comprobante-pago";

export type { EstadoSolicitud, Pendiente };

// ── La ventana de 24 h de WhatsApp ───────────────────────────────────────────

/** Meta solo deja escribir texto libre hasta 24 h después del último mensaje del cliente. */
export const VENTANA_WHATSAPP_MS = 24 * 3_600_000;

export type Ventana24h = {
  /** Se le puede escribir texto libre (y el PDF) por la Cloud API. */
  abierta: boolean;
  /** El último mensaje del cliente (ISO), o null si no hay ninguno. */
  ultimoEntrante: string | null;
  /** Cuándo se cierra (ISO), o null sin mensajes del cliente. */
  cierraEn: string | null;
};

/** La ventana de 24 h desde el último mensaje del cliente. PURA. Sin mensajes, cerrada. */
export function ventana24h(ultimoEntranteIso: string | null | undefined, ahoraMs: number): Ventana24h {
  const t = typeof ultimoEntranteIso === "string" ? Date.parse(ultimoEntranteIso) : NaN;
  if (!Number.isFinite(t)) return { abierta: false, ultimoEntrante: null, cierraEn: null };
  const cierra = t + VENTANA_WHATSAPP_MS;
  return { abierta: ahoraMs < cierra, ultimoEntrante: new Date(t).toISOString(), cierraEn: new Date(cierra).toISOString() };
}

/** El enlace wa.me con el texto ya escrito (para mandarlo desde el celular fuera de la ventana). */
export function enlaceWaMe(waId: string | null | undefined, texto: string): string | null {
  const n = String(waId ?? "").replace(/\D/g, "");
  if (n.length < 8 || n.length > 15) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(texto)}`;
}

// ── Las acciones ─────────────────────────────────────────────────────────────

/** Las acciones de la tarjeta del CRM (módulo `crm`). */
export type AccionTarjeta =
  /** «✅ Hay unidad»: crea ida y retorno desde la cotización y le escribe al cliente (T4). */
  | "hay_unidad"
  /** «❌ No hay unidad»: cierra sin unidad (devolución del 100 %) y le escribe (T5). */
  | "sin_unidad"
  /** «Pedir otro comprobante» (`motivo`: «otro» → que lo reenvíe; «no_encontrado» → T9). */
  | "pedir_comprobante"
  /** Registra el último comprobante del chat que la IA no registró (lo lee el extractor). */
  | "registrar_comprobante"
  /** «Leer el último comprobante»: lo marca leído y devuelve un enlace firmado para verlo. */
  | "ver_comprobante"
  /** «Cerrar» (duplicada / desistió / decisión del ejecutivo). Sin dinero ni reserva viva. */
  | "cerrar"
  /** Decide el % de devolución de una cancelación pedida por el cliente (T7, y el cargo si se retiene). */
  | "resolver_cancelacion"
  /** Ata un cliente del ERP a la cotización, sus reservas y el contacto. */
  | "vincular_cliente"
  /** «Emitir y enviar Confirmación»: emite la versión y la manda por WhatsApp (solo dentro de 24 h). Exige además `programacion`. */
  | "enviar_confirmacion"
  /** La Confirmación se mandó por wa.me (fuera de la ventana): cierra la solicitud como completada. */
  | "marcar_confirmacion_enviada";

/** Las acciones de dinero (Tesorería / Finanzas). Van por las dos rutas, siempre con ese módulo. */
export type AccionDinero = "registrar_adelanto" | "pago_no_encontrado" | "registrar_devolucion";

export const ACCIONES_TARJETA: readonly AccionTarjeta[] = [
  "hay_unidad", "sin_unidad", "pedir_comprobante", "registrar_comprobante", "ver_comprobante", "cerrar",
  "resolver_cancelacion", "vincular_cliente", "enviar_confirmacion", "marcar_confirmacion_enviada",
];
export const ACCIONES_DINERO: readonly AccionDinero[] = ["registrar_adelanto", "pago_no_encontrado", "registrar_devolucion"];

export type MotivoCierre = "duplicada" | "cliente" | "ejecutivo";
export const MOTIVOS_CIERRE: readonly MotivoCierre[] = ["duplicada", "cliente", "ejecutivo"];

/**
 * El cuerpo de POST /api/crm/reservas-traslado. `conversacion_id`, `accion_id` y `solicitud_id`
 * son los de la tarjeta que se pulsó: el servidor comprueba que conversación ↔ acción ↔ solicitud
 * ↔ cotización coincidan antes de hacer nada (y el número del cliente lo lee él).
 */
export type CuerpoTarjeta = {
  accion: AccionTarjeta | AccionDinero;
  solicitud_id: number;
  conversacion_id: string;
  accion_id: string;
  /** pedir_comprobante: «otro» (por defecto) | «no_encontrado». */
  motivo?: "otro" | "no_encontrado" | MotivoCierre;
  /** resolver_cancelacion: el % de lo cobrado que se devuelve (0..100). */
  devolucion_pct?: number;
  /** vincular_cliente. */
  cliente_id?: number;
  /** cerrar: una nota para la solicitud (≤ 500). */
  nota?: string;
  /** enviar_confirmacion. */
  idioma?: "es" | "en";
  extras?: { vuelo?: string | null; punto_encuentro?: string | null; nota?: string | null; incluir_telefono_conductor?: boolean };
  /** registrar_adelanto / registrar_devolucion: como en la Confirmación de Reserva. */
  monto?: number;
  fecha?: string;
  metodo?: string;
  referencia?: string;
};

/** El cuerpo de POST /api/reservas/solicitudes (Tesorería / Finanzas). */
export type CuerpoTesoreria = {
  accion: AccionDinero;
  solicitud_id: number;
  monto?: number;
  fecha?: string;
  metodo?: string;
  referencia?: string;
};

/** Los códigos de resultado de las acciones (la pantalla enruta por código, nunca por el texto). */
export type CodigoResultadoReserva =
  | "ok"
  /** Hecho en el ERP, pero el mensaje al cliente no se pudo mandar por la ventana de 24 h: va en `fueraDeVentana`. */
  | "fuera_de_ventana"
  /** La acción se hizo y el mensaje al cliente falló al enviarse (va en `mensaje` y en el hilo con su error). */
  | "envio_fallido"
  | "datos_invalidos"
  /** Sin sesión (o vencida). */
  | "no_autorizado"
  | "no_existe"
  /** La solicitud no es de esa conversación, acción o cotización. */
  | "ajena"
  | "sin_permiso"
  | "sin_migracion"
  /** El estado de la solicitud no admite esa acción. */
  | "transicion_invalida"
  /** Otra persona la movió a la vez. */
  | "reclamo_perdido"
  /** La reserva sigue viva en Programación: hay que cancelarla ahí primero. */
  | "cancelar_en_programacion"
  /** El cliente reportó un pago que Tesorería no registró ni marcó «No encontré el pago». */
  | "pago_sin_registrar"
  /** Tiene cobros: se resuelve como cancelación (con devolución), no se cierra. */
  | "con_cobros"
  /** La cotización cambió desde que se le comunicó el adelanto al cliente. */
  | "importes_cambiaron"
  | "sin_adelanto_config"
  | "sin_cuentas"
  | "cuentas_distintas"
  /** La reserva no se pudo crear en Programación (la solicitud vuelve a su estado). */
  | "reserva_no_creada"
  /** La Confirmación de Reserva todavía no se puede emitir (`bloqueos`). */
  | "bloqueada"
  | "sin_comprobante"
  | "tope"
  | "error";

/** Lo que vuelve de cualquier acción (tarjeta o Tesorería). */
export type ResultadoAccionReserva = {
  ok: boolean;
  codigo: CodigoResultadoReserva;
  /** Qué pasó (o qué falló y dónde se arregla), en castellano. */
  detalle: string;
  /** El estado de la solicitud después de la acción. */
  estado?: EstadoSolicitud;
  /** El texto que se le mandó (o se le tenía que mandar) al cliente. */
  mensaje?: string | null;
  /** El mensaje salió por WhatsApp. */
  enviado?: boolean;
  /** Fuera de la ventana de 24 h: el texto y el enlace wa.me para mandarlo desde el celular. */
  fueraDeVentana?: { texto: string; waMe: string | null; cerroEn: string | null } | null;
  /** enviar_confirmacion: la versión emitida (fuera de la ventana, para descargarla). */
  version?: { id: number; version: number; codigo: string; pdf: string } | null;
  /** La Confirmación todavía no se puede emitir. */
  bloqueos?: { codigo: string; detalle: string }[];
  /** ver_comprobante: el enlace firmado (vale una hora). */
  url?: string | null;
  /** Avisos que no impiden la acción (reserva creada a medias, cargo no creado…). */
  avisos?: string[];
  /** La vista de la solicitud después de la acción (para repintar la tarjeta). */
  vista?: VistaSolicitud | null;
};

// ── La vista de una solicitud ────────────────────────────────────────────────

export type PagoVista = {
  id: number; codigo: string | null; sentido: "cobro" | "pago"; fecha: string | null; monto: number; moneda: string;
  metodo: string | null; referencia: string | null; anulado: boolean;
};

export type ComprobanteVista = {
  id: number;
  mensajeId: string | null;
  creadoEn: string;
  /** Lo que leyó la IA (puede equivocarse). null = no se pudo leer. */
  lectura: { monto: number | null; textoMonto: string | null; moneda: string | null; fecha: string | null; hora: string | null; operacion: string | null; medio: string | null; bancoDestino: string | null; cuentaDestino: string | null; confianza: string | null } | null;
  cotejo: { codigo: CodigoCotejo | string; texto: string }[];
  /** El cotejo dio el monto por bueno (cubre el adelanto sin pasar del total). */
  seguro: boolean;
  correoEn: string | null;
  correoError: string | null;
  leidoEn: string | null;
};

export type VistaSolicitud = {
  id: number;
  estado: EstadoSolicitud;
  orden: "pago_primero" | "disponibilidad_primero";
  /** Por qué no se pidió el pago primero (o por qué es urgente), dicho para el ejecutivo. */
  motivos: { codigo: string; texto: string }[];
  urgente: boolean;
  confirmarAntesDe: string | null;
  creadaEn: string;
  clienteAceptoEn: string | null;
  nombrePasajero: string | null;
  vuelo: string | null;
  nota: string | null;
  cierreMotivo: string | null;
  cerradaEn: string | null;
  cotizacion: {
    id: number; numero: string; origen: string; destino: string;
    fecha: string | null; hora: string | null; fechaRetorno: string | null; horaRetorno: string | null;
    moneda: "PEN" | "USD"; total: number | null; adelanto: number | null; saldo: number | null; pct: number | null;
    /** La firma de lo comunicado sigue coincidiendo con la cotización de hoy (null si no se comunicó importe). */
    importesVigentes: boolean | null;
    clienteId: number | null;
  } | null;
  cliente: { id: number; nombre: string } | null;
  contacto: { nombre: string | null; waId: string | null };
  /** La reserva de Programación (la ida) y su estado. */
  reserva: { id: number; estado: string; clienteId: number | null; tramos: number } | null;
  dinero: {
    moneda: "PEN" | "USD";
    cobrado: number;
    devuelto: number;
    /** Lo que se decidió devolver (null sin decisión). */
    aDevolver: number | null;
    /** Lo que la empresa retiene (va en el comprobante del cargo). */
    retenido: number;
  };
  pagos: PagoVista[];
  comprobantes: ComprobanteVista[];
  /** Tesorería marcó que no encontró el pago reportado. */
  pagoNoEncontrado: { at: string; por: string | null } | null;
  cancelacion: { pedidaEn: string; horasAntes: number | null; devolucionPct: number | null } | null;
  /** El comprobante del cargo retenido (fila de `facturas`, sin número hasta que se emita). */
  cargo: { id: number; serie: string | null; numero: string | null; total: number | null; estado: string | null } | null;
  confirmacion: { emitida: boolean; enviada: boolean; ultima: { id: number; version: number; codigo: string } | null };
  ventana: Ventana24h;
  /** Lo que le falta, en orden, cada cosa con su dueño (`queFalta`). */
  pendientes: Pendiente[];
  /** Las acciones que tienen sentido en este estado (el servidor las vuelve a comprobar). */
  acciones: (AccionTarjeta | AccionDinero)[];
  politica: string[];
  devolucionPlazoH: number | null;
  /** Lo que no se pudo leer (la vista sale igual, con menos datos). */
  avisos: string[];
};

/** GET /api/crm/reservas-traslado?solicitud_id=…&conversacion_id=…&accion_id=… */
export type RespuestaVista =
  | {
    ok: true; solicitud: VistaSolicitud;
    /** Lo que puede hacer quien mira (el servidor lo vuelve a comprobar en cada acción): el dinero exige Tesorería o Finanzas; la Confirmación, Programación. */
    permisos?: { dinero: boolean; programacion: boolean };
  }
  | { ok: false; codigo: CodigoResultadoReserva; detalle: string };

// ── La lista de Tesorería ────────────────────────────────────────────────────

export type FilaTesoreria = {
  solicitudId: number;
  estado: EstadoSolicitud;
  numero: string | null;
  cliente: string | null;
  servicio: { fecha: string | null; hora: string | null; origen: string | null; destino: string | null };
  moneda: "PEN" | "USD";
  total: number | null;
  adelanto: number | null;
  cobrado: number;
  devuelto: number;
  aDevolver: number | null;
  comprobantes: number;
  /** El monto del último comprobante si el cotejo lo dio por bueno (si no, null: hay que mirarlo). */
  ultimoMontoSeguro: number | null;
  pagoNoEncontrado: boolean;
  /** Lo que le toca a Tesorería (verificar el pago, registrar la devolución). */
  pendientesTesoreria: Pendiente[];
  creadaEn: string;
  convId: string | null;
};

/** GET /api/reservas/solicitudes?filtro=pendientes|todas */
export type RespuestaTesoreria =
  | { ok: true; filas: FilaTesoreria[]; sinMigracion: boolean; avisos: string[] }
  | { ok: false; codigo: CodigoResultadoReserva; detalle: string };

/** Los textos de los códigos de error comunes (la pantalla puede usar el `detalle` del servidor). */
export const TEXTO_CODIGO_RESERVA: Partial<Record<CodigoResultadoReserva, string>> = {
  ajena: "La solicitud no es de esta conversación: recarga la bandeja.",
  sin_permiso: "No tienes el módulo necesario para esta acción.",
  sin_migracion: "Falta correr las migraciones de la reserva de traslados (reservas-09a/b/c y traslados-09).",
  reclamo_perdido: "Otra persona acaba de cambiar esta solicitud: recarga la tarjeta.",
};

/** El estado HTTP de cada código (las dos rutas lo usan igual). */
export const STATUS_RESULTADO_RESERVA: Record<CodigoResultadoReserva, number> = {
  ok: 200, fuera_de_ventana: 200, envio_fallido: 502,
  datos_invalidos: 400, no_autorizado: 401, no_existe: 404, sin_comprobante: 404, sin_permiso: 403, ajena: 409, sin_migracion: 409,
  transicion_invalida: 409, reclamo_perdido: 409, cancelar_en_programacion: 409, pago_sin_registrar: 409, con_cobros: 409,
  importes_cambiaron: 409, sin_adelanto_config: 409, sin_cuentas: 409, cuentas_distintas: 409, bloqueada: 409,
  tope: 429, reserva_no_creada: 500, error: 500,
};
