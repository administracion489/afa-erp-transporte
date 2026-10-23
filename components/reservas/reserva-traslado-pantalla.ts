// components/reservas/reserva-traslado-pantalla.ts — SOLO NAVEGADOR (sin Supabase).
// Lo que comparten la tarjeta de la reserva de un traslado en el inbox del CRM
// (components/crm/TarjetaReservaTraslado.tsx) y la pestaña «Adelantos de reservas» de Tesorería
// (app/tesoreria/_tabs/AdelantosReservasTab.tsx): los rótulos de cada estado, dueño y acción, las
// llamadas a las dos rutas y las preguntas (`confirm`) que NOMBRAN el dinero o el mensaje.
//
// NO DECIDE NADA: qué acciones tienen sentido, qué le falta a cada solicitud y qué se le escribe al
// cliente lo decide el servidor (lib/traslados/reserva-solicitud-datos.ts, con los motores puros de
// lib/traslados/reserva-*.ts) y vuelve en la vista. Los textos al cliente los arma el servidor: aquí
// solo se DESCRIBE en una línea qué va a salir, para que quien pulsa sepa a qué dice que sí.
// El contrato de las rutas es lib/traslados/reserva-solicitud-tipos.ts.

import { cabecerasErp } from "@/lib/fetch-erp";
import { dinero as dineroMotor, devolucionDecidida, cargoRetenido } from "@/lib/traslados/reserva-pago";
import {
  TEXTO_CODIGO_RESERVA, type AccionDinero, type AccionTarjeta, type CodigoResultadoReserva, type CuerpoTarjeta, type CuerpoTesoreria,
  type EstadoSolicitud, type Pendiente, type RespuestaTesoreria, type ResultadoAccionReserva, type VistaSolicitud,
} from "@/lib/traslados/reserva-solicitud-tipos";

export { devolucionDecidida, cargoRetenido };

// ── Rótulos ───────────────────────────────────────────────────────────────────

/** El nombre de cada estado para quien mira (y su tono: rojo = hay que actuar, ámbar = espera a alguien, gris/verde = informativo). */
export const ESTADO_SOLICITUD: Record<EstadoSolicitud, { label: string; color: string; bg: string }> = {
  esperando_pago: { label: "Esperando el pago del cliente", color: "#92400e", bg: "#fef3c7" },
  por_confirmar: { label: "Por confirmar la unidad", color: "#9a3412", bg: "#ffedd5" },
  pago_reportado: { label: "Pago reportado · por verificar en el banco", color: "#1d4ed8", bg: "#dbeafe" },
  confirmada: { label: "Unidad confirmada", color: "#166534", bg: "#dcfce7" },
  sin_unidad: { label: "Cerrada: no había unidad", color: "#4b5563", bg: "#f3f4f6" },
  cancelada: { label: "Cancelada", color: "#4b5563", bg: "#f3f4f6" },
  completada: { label: "Completada (Confirmación enviada)", color: "#166534", bg: "#dcfce7" },
};

export const etiquetaEstado = (e: string): string =>
  Object.prototype.hasOwnProperty.call(ESTADO_SOLICITUD, e) ? ESTADO_SOLICITUD[e as EstadoSolicitud].label : e;

/** Quién tiene que hacer cada pendiente. */
export const QUIEN_PENDIENTE: Record<Pendiente["quien"], { label: string; color: string; bg: string }> = {
  cliente: { label: "Cliente", color: "#6b21a8", bg: "#f3e8ff" },
  crm: { label: "CRM", color: "#0b315f", bg: "#e0eaf5" },
  tesoreria: { label: "Tesorería", color: "#166534", bg: "#dcfce7" },
  programacion: { label: "Programación", color: "#9a3412", bg: "#ffedd5" },
  facturacion: { label: "Facturación", color: "#1d4ed8", bg: "#dbeafe" },
};

export const ORDEN_SOLICITUD: Record<VistaSolicitud["orden"], string> = {
  pago_primero: "Pago primero: se le pidió el adelanto y un ejecutivo confirma la unidad al recibirlo.",
  disponibilidad_primero: "Disponibilidad primero: un ejecutivo confirma la unidad y después se le pide el pago.",
};

export const ETIQUETA_ACCION: Record<AccionTarjeta | AccionDinero, string> = {
  hay_unidad: "✅ Hay unidad",
  sin_unidad: "❌ No hay unidad",
  pedir_comprobante: "Pedir otro comprobante",
  registrar_comprobante: "Registrar el último comprobante",
  ver_comprobante: "Ver",
  cerrar: "Cerrar",
  resolver_cancelacion: "Resolver cancelación",
  vincular_cliente: "Vincular cliente",
  enviar_confirmacion: "Emitir y enviar Confirmación",
  marcar_confirmacion_enviada: "Marcar como enviada",
  registrar_adelanto: "Registrar adelanto",
  pago_no_encontrado: "No encontré el pago",
  registrar_devolucion: "Registrar devolución",
};

export const ACCIONES_DE_DINERO: readonly AccionDinero[] = ["registrar_adelanto", "pago_no_encontrado", "registrar_devolucion"];
export const esAccionDinero = (a: string): a is AccionDinero => (ACCIONES_DE_DINERO as readonly string[]).includes(a);

export const MOTIVO_CIERRE_TEXTO: Record<"duplicada" | "cliente" | "ejecutivo", string> = {
  duplicada: "Duplicada (hay otra solicitud de la misma reserva)",
  cliente: "El cliente desistió",
  ejecutivo: "Decisión del ejecutivo",
};

// ── Formatos ──────────────────────────────────────────────────────────────────

/** Un importe con el MISMO formato que los mensajes al cliente y el PDF (fmtImporte, al céntimo). */
export const dinero = (n: number | null | undefined, moneda: "PEN" | "USD"): string => (n == null || !Number.isFinite(Number(n)) ? "—" : dineroMotor(Number(n), moneda));

const conZona = { timeZone: "America/Lima" } as const;

/** «22/10/2026 15:30» en hora de Lima. «—» sin dato. */
export function fechaHoraLima(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-PE", { ...conZona, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** «2026-10-22» → «22/10/2026». */
export const fechaDdMm = (f: string | null | undefined): string => (f && /^\d{4}-\d{2}-\d{2}/.test(f) ? f.slice(0, 10).split("-").reverse().join("/") : "—");

/** «08:30:00» → «08:30». */
export const horaCorta = (h: string | null | undefined): string => (h ? String(h).slice(0, 5) : "");

/** Cuánto falta (o desde cuándo venció) para un plazo. null sin plazo. */
export function cuentaRegresiva(iso: string | null | undefined, ahoraMs: number): { texto: string; vencido: boolean; minutos: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.round((t - ahoraMs) / 60_000);
  const abs = Math.abs(min);
  const dur = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${Math.floor(abs / 1440)} días`;
  return min >= 0 ? { texto: `faltan ${dur}`, vencido: false, minutos: min } : { texto: `venció hace ${dur}`, vencido: true, minutos: min };
}

/** El servicio en una línea: «22/10/2026 08:30 · Aeropuerto → Miraflores». */
export function lineaServicio(c: VistaSolicitud["cotizacion"]): string {
  if (!c) return "—";
  const cuando = [fechaDdMm(c.fecha), horaCorta(c.hora)].filter((x) => x && x !== "—").join(" ");
  return `${cuando || "sin fecha"} · ${c.origen || "—"} → ${c.destino || "—"}`;
}

/** El número de WhatsApp para leer (con +). */
export const telLegible = (wa: string | null | undefined): string => {
  const d = String(wa ?? "").replace(/\D/g, "");
  return d ? `+${d}` : "(sin número)";
};

// ── Llamadas ──────────────────────────────────────────────────────────────────

export type Lectura<T> = { ok: true; datos: T } | { ok: false; codigo: CodigoResultadoReserva | "red"; detalle: string };

/** Lo que se dice cuando el servidor no contestó con el contrato (sin JSON). */
function sinContrato(status: number, permiso: string): string {
  if (status === 401) return "Tu sesión venció o no se pudo verificar: vuelve a ingresar.";
  if (status === 403) return `Te falta ${permiso} (lo da un administrador en Usuarios).`;
  if (status === 404) return "Esta función todavía no está desplegada en el servidor.";
  return `El servidor respondió ${status} sin decir por qué.`;
}

/** El texto de un fallo del contrato: el `detalle` del servidor manda (dice el motivo); si no, el del código. */
export function textoFallo(codigo: CodigoResultadoReserva | "red" | string, detalle: string | null | undefined): string {
  const d = String(detalle ?? "").trim();
  if (d) return d;
  return TEXTO_CODIGO_RESERVA[codigo as CodigoResultadoReserva] ?? `No se pudo completar (${codigo}).`;
}

async function pedirJson<T>(url: string, init: RequestInit): Promise<{ status: number; json: T | null } | { red: string }> {
  try {
    const res = await fetch(url, init);
    const json = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, json };
  } catch (e) {
    return { red: `No se pudo llamar al servidor: ${(e as Error)?.message ?? "sin conexión"}.` };
  }
}

export type VistaTarjeta = { vista: VistaSolicitud; permisos: { dinero: boolean; programacion: boolean } | null };

/** GET /api/crm/reservas-traslado (la tarjeta del inbox, módulo CRM). */
export async function leerVistaTarjeta(x: { solicitudId: number; conversacionId: string; accionId: string }): Promise<Lectura<VistaTarjeta>> {
  const q = new URLSearchParams({ solicitud_id: String(x.solicitudId), conversacion_id: x.conversacionId, accion_id: x.accionId });
  const r = await pedirJson<{ ok?: boolean; solicitud?: VistaSolicitud; permisos?: { dinero: boolean; programacion: boolean }; codigo?: CodigoResultadoReserva; detalle?: string }>(
    `/api/crm/reservas-traslado?${q}`, { headers: await cabecerasErp() });
  if ("red" in r) return { ok: false, codigo: "red", detalle: r.red };
  const j = r.json;
  if (j?.ok && j.solicitud) return { ok: true, datos: { vista: j.solicitud, permisos: j.permisos ?? null } };
  if (j && j.ok === false) return { ok: false, codigo: j.codigo ?? "error", detalle: textoFallo(j.codigo ?? "error", j.detalle) };
  return { ok: false, codigo: "error", detalle: sinContrato(r.status, "el permiso del módulo CRM") };
}

/** Lo que vuelve de una acción, siempre con el contrato (un fallo de red o sin JSON se convierte en `ok: false`). */
async function postAccion(url: string, cuerpo: CuerpoTarjeta | CuerpoTesoreria, permiso: string): Promise<ResultadoAccionReserva> {
  const r = await pedirJson<ResultadoAccionReserva>(url, { method: "POST", headers: await cabecerasErp({ "Content-Type": "application/json" }), body: JSON.stringify(cuerpo) });
  if ("red" in r) return { ok: false, codigo: "error", detalle: `${r.red} Revisa en la tarjeta si la acción se hizo antes de reintentar.` };
  const j = r.json;
  if (j && typeof j === "object" && typeof j.codigo === "string") return { ...j, detalle: textoFallo(j.codigo, j.detalle) };
  return { ok: false, codigo: r.status === 401 ? "no_autorizado" : r.status === 403 ? "sin_permiso" : "error", detalle: sinContrato(r.status, permiso) };
}

/** POST /api/crm/reservas-traslado. */
export const accionTarjeta = (cuerpo: CuerpoTarjeta) =>
  postAccion("/api/crm/reservas-traslado", cuerpo, esAccionDinero(cuerpo.accion)
    ? "el módulo Finanzas o Cuentas por Pagar (Tesorería)"
    : cuerpo.accion === "enviar_confirmacion" ? "el módulo Programación (además de CRM)" : "el permiso del módulo CRM");

/** GET /api/reservas/solicitudes (Tesorería). */
export async function leerListaTesoreria(filtro: "pendientes" | "todas"): Promise<Lectura<Extract<RespuestaTesoreria, { ok: true }>>> {
  const r = await pedirJson<RespuestaTesoreria>(`/api/reservas/solicitudes?filtro=${filtro}`, { headers: await cabecerasErp() });
  if ("red" in r) return { ok: false, codigo: "red", detalle: r.red };
  const j = r.json;
  if (j && j.ok) return { ok: true, datos: j };
  if (j && j.ok === false) return { ok: false, codigo: j.codigo, detalle: textoFallo(j.codigo, j.detalle) };
  return { ok: false, codigo: "error", detalle: sinContrato(r.status, "el módulo Finanzas o Cuentas por Pagar (Tesorería)") };
}

/** GET /api/reservas/solicitudes?solicitud_id=N (Tesorería). */
export async function leerVistaTesoreria(solicitudId: number): Promise<Lectura<VistaSolicitud>> {
  const r = await pedirJson<{ ok?: boolean; solicitud?: VistaSolicitud; codigo?: CodigoResultadoReserva; detalle?: string }>(
    `/api/reservas/solicitudes?solicitud_id=${solicitudId}`, { headers: await cabecerasErp() });
  if ("red" in r) return { ok: false, codigo: "red", detalle: r.red };
  const j = r.json;
  if (j?.ok && j.solicitud) return { ok: true, datos: j.solicitud };
  if (j && j.ok === false) return { ok: false, codigo: j.codigo ?? "error", detalle: textoFallo(j.codigo ?? "error", j.detalle) };
  return { ok: false, codigo: "error", detalle: sinContrato(r.status, "el módulo Finanzas o Cuentas por Pagar (Tesorería)") };
}

/** POST /api/reservas/solicitudes (Tesorería). */
export const accionTesoreria = (cuerpo: CuerpoTesoreria) =>
  postAccion("/api/reservas/solicitudes", cuerpo, "el módulo Finanzas o Cuentas por Pagar (Tesorería)");

// ── Las preguntas antes de pulsar ─────────────────────────────────────────────
// Nombran el dinero y DESCRIBEN el mensaje que va a salir (el texto lo arma el servidor). Fuera de
// la ventana de 24 h se dice que no sale nada por el CRM y que se dará el enlace wa.me.

export type DatosMovimiento = { monto: number; fecha: string; metodo: string; referencia: string };

const pie = (v: VistaSolicitud) => (v.ventana.abierta
  ? `Sale por WhatsApp al ${telLegible(v.contacto.waId)}${v.contacto.nombre ? ` (${v.contacto.nombre})` : ""}, como mensaje del equipo.`
  : "Pasaron más de 24 h desde el último mensaje del cliente: por el CRM no sale nada. Te damos el texto y el enlace wa.me para enviárselo desde el celular.");

const cot = (v: VistaSolicitud) => (v.cotizacion ? `N° ${v.cotizacion.numero}` : `de la solicitud #${v.id}`);
const esCredito = (v: VistaSolicitud) => v.motivos.some((m) => m.codigo === "credito");

/** «Hay unidad»: qué se crea y qué se le dice, según lo que dice HOY la solicitud. */
export function preguntaHayUnidad(v: VistaSolicitud): string {
  const c = v.cotizacion;
  const m = v.dinero.moneda;
  const pago = esCredito(v) ? "que hay unidad (su pago se coordina según la condición de crédito)"
    : c?.adelanto != null && v.dinero.cobrado + 0.005 >= c.adelanto ? `que hay unidad y que recibimos su adelanto de ${dinero(v.dinero.cobrado, m)}`
      : v.dinero.cobrado > 0 ? `que hay unidad, que recibimos ${dinero(v.dinero.cobrado, m)} y cuánto falta del adelanto${c?.adelanto != null ? ` (${dinero(c.adelanto - v.dinero.cobrado, m)})` : ""}, con las cuentas para pagarlo`
        : v.comprobantes.length > 0 ? "que hay unidad y que su reserva queda confirmada cuando validemos su pago con el banco"
          : `que hay unidad y el adelanto que tiene que pagar${c?.adelanto != null ? ` (${dinero(c.adelanto, m)}, el ${c.pct} % de ${dinero(c.total, m)})` : " (el % configurado del total)"}, con las cuentas para pagarlo`;
  return `¿Confirmar que HAY UNIDAD para el traslado de la cotización ${cot(v)} (${lineaServicio(c)})?\n\n`
    + `Se crea la reserva en Programación (ida${c?.fechaRetorno || c?.horaRetorno ? " y retorno" : ""}) y se le escribe al cliente ${pago}.\n\n${pie(v)}`;
}

export function preguntaSinUnidad(v: VistaSolicitud): string {
  const m = v.dinero.moneda;
  const pagoTxt = v.dinero.cobrado > 0 ? ` y que se le devuelve el 100 % de lo pagado (${dinero(v.dinero.cobrado, m)}${v.devolucionPlazoH ? `, en un máximo de ${v.devolucionPlazoH} h` : ""}); la devolución la registra Tesorería al transferirla`
    : v.comprobantes.length > 0 ? " y que se le devuelve el 100 % de lo pagado (reportó un pago que Tesorería todavía no registró)"
      : " y que no realice ningún pago por esta cotización";
  return `¿Marcar que NO HAY UNIDAD para el traslado de la cotización ${cot(v)} (${lineaServicio(v.cotizacion)})?\n\n`
    + `La solicitud se cierra y se le escribe al cliente que no tenemos una unidad disponible${pagoTxt}.\n\n${pie(v)}`;
}

export function preguntaPedirComprobante(v: VistaSolicitud, motivo: "otro" | "no_encontrado"): string {
  const que = motivo === "no_encontrado"
    ? "que todavía no encontramos su pago en el banco, y se le pide la fecha, el banco y el número de operación, u otra captura"
    : "otra foto o captura del comprobante donde se vean el monto, la fecha y el número de operación";
  const vuelve = v.estado === "pago_reportado" ? "\nLa solicitud vuelve a «Esperando el pago del cliente»." : "";
  return `¿Pedirle al cliente ${que}?${vuelve}\n\n${pie(v)}`;
}

export function preguntaRegistrarComprobante(v: VistaSolicitud): string {
  return "¿Registrar el último comprobante del chat?\n\n"
    + "La IA lee la última foto o PDF que mandó el cliente (desde que se le envió la cotización), lo registra como comprobante de esta solicitud y se le responde que lo recibimos y lo verificamos con el banco.\n"
    + "NO registra ningún cobro: el adelanto lo registra Tesorería cuando ve el dinero en la cuenta.\n\n" + pie(v);
}

export function preguntaCerrar(v: VistaSolicitud, motivo: keyof typeof MOTIVO_CIERRE_TEXTO): string {
  return `¿Cerrar la solicitud #${v.id} (cotización ${cot(v)}) como «${MOTIVO_CIERRE_TEXTO[motivo]}»?\n\nNo se le escribe nada al cliente. No tiene cobros registrados.`;
}

/** «Resolver cancelación»: cuánto se devuelve y cuánto se retiene, con la MISMA cuenta del servidor. */
export function preguntaResolverCancelacion(v: VistaSolicitud, pct: number): string {
  const m = v.dinero.moneda;
  const cobrado = v.dinero.cobrado;
  const monto = devolucionDecidida(cobrado, pct);
  const retenido = cargoRetenido({ cobrado, devuelto: monto });
  const dineroTxt = cobrado > 0
    ? `Se devuelve el ${pct} % de lo cobrado: ${dinero(monto, m)} de ${dinero(cobrado, m)}${v.devolucionPlazoH ? ` (en un máximo de ${v.devolucionPlazoH} h)` : ""}.${retenido > 0 ? `\nSe retienen ${dinero(retenido, m)} y se crea el comprobante del cargo SIN número, para que Facturación lo emita.` : ""}\nLa devolución la registra Tesorería cuando hace la transferencia.`
    : "No hay cobros registrados: no se devuelve nada.";
  const msj = cobrado > 0
    ? (monto > 0 ? `que su reserva quedó cancelada y que le devolvemos ${dinero(monto, m)}` : "que su reserva quedó cancelada y que, según nuestras políticas, en este caso no corresponde devolución")
    : "que su reserva quedó cancelada";
  return `¿Resolver la cancelación de la solicitud #${v.id} (cotización ${cot(v)})?\n\n${dineroTxt}\n\nSe le escribe al cliente ${msj}.\n\n${pie(v)}`;
}

export function preguntaVincular(v: VistaSolicitud, cliente: { nombre: string; telefono?: string | null }): string {
  return `¿Vincular al cliente «${cliente.nombre}»${cliente.telefono ? ` (tel. ${cliente.telefono})` : ""} con la cotización ${cot(v)}, sus reservas y el contacto de WhatsApp ${telLegible(v.contacto.waId)}?\n\n`
    + "Solo donde no hay otro cliente puesto. Los datos de ese cliente salen en la Confirmación de Reserva que se le envía a ese número: comprueba que sea la misma persona.";
}

export function preguntaEnviarConfirmacion(v: VistaSolicitud, x: { idioma: "es" | "en"; telefonoConductor: boolean }): string {
  const m = v.dinero.moneda;
  const total = v.cotizacion?.total ?? null;
  const saldo = total != null ? Math.max(0, total - v.dinero.cobrado) : null;
  const salida = v.ventana.abierta
    ? `y se envía su PDF (${x.idioma === "en" ? "en inglés" : "en español"}) por WhatsApp al ${telLegible(v.contacto.waId)}. Enviada, la solicitud queda completada.`
    : "Pasaron más de 24 h desde el último mensaje del cliente: se emite y te damos el PDF para descargarlo y enviarlo por wa.me (por el CRM no sale nada).";
  return `¿Emitir la Confirmación de Reserva de la cotización ${cot(v)} (${lineaServicio(v.cotizacion)})?\n\n`
    + `Lleva el total ${dinero(total, m)}, lo cobrado ${dinero(v.dinero.cobrado, m)} y el saldo ${dinero(saldo, m)}${x.telefonoConductor ? ", y el teléfono del conductor" : ""}.\n`
    + `Se emite la versión vigente (si nada cambió, la misma) ${salida}`;
}

export function preguntaMarcarEnviada(v: VistaSolicitud): string {
  const cod = v.confirmacion.ultima?.codigo ?? "emitida";
  return `¿Ya le enviaste al cliente la Confirmación de Reserva ${cod} por wa.me (desde el celular)?\n\nLa solicitud queda completada. El ERP no puede comprobar el envío: lo afirmas tú.`;
}

export function preguntaAdelanto(v: VistaSolicitud, d: DatosMovimiento): string {
  const m = v.dinero.moneda;
  return `¿Registrar un cobro de ${dinero(d.monto, m)} del ${fechaDdMm(d.fecha)} (${d.metodo}${d.referencia.trim() ? `, op. ${d.referencia.trim()}` : ""}) como adelanto de la solicitud #${v.id} (cotización ${cot(v)})?\n\n`
    + `${v.cotizacion?.adelanto != null ? `Adelanto pedido: ${dinero(v.cotizacion.adelanto, m)} · ya cobrado: ${dinero(v.dinero.cobrado, m)}.\n` : ""}`
    + "Solo regístralo si el dinero ya está en la cuenta (validado contra el banco o recibido en efectivo). La foto del cliente no es un cobro.";
}

export function preguntaDevolucion(v: VistaSolicitud, d: DatosMovimiento): string {
  const m = v.dinero.moneda;
  return `¿Registrar una DEVOLUCIÓN de ${dinero(d.monto, m)} al cliente del ${fechaDdMm(d.fecha)} (${d.metodo}${d.referencia.trim() ? `, op. ${d.referencia.trim()}` : ""}) de la solicitud #${v.id} (cotización ${cot(v)})?\n\n`
    + `Corresponde devolver ${dinero(v.dinero.aDevolver, m)} · ya devuelto: ${dinero(v.dinero.devuelto, m)}.\n`
    + "Solo regístrala cuando la transferencia ya salió de la cuenta.";
}

export function preguntaPagoNoEncontrado(v: VistaSolicitud): string {
  return `¿Marcar que NO encontraste en el banco el pago que reportó el cliente (solicitud #${v.id}, cotización ${cot(v)})?\n\n`
    + "No se le escribe al cliente: queda en la tarjeta del CRM y en una nota del chat, y el ejecutivo le pide que lo confirme («No encontramos el pago»).";
}
