// npx tsx scripts/prueba-reserva-pago.mts
// El adelanto, las cuentas, el dinero de la solicitud, lo que le falta, el cargo retenido y los
// textos T1–T11 (lib/traslados/reserva-pago.ts). Fija:
//  · el adelanto cuadra al céntimo con el PDF (PEN y USD) y adelanto + saldo = total;
//  · la firma es estable; las transiciones son las de la tabla;
//  · estado abierto ⇒ ≥ 1 pendiente con dueño; completada ⇒ ninguno; cancelada / sin unidad: ninguno
//    solo cuando el dinero y la reserva quedaron saldados;
//  · una devolución nunca suma al adelanto; `cargoRetenido` = cobrado − devuelto y nunca negativo;
//  · la fila de `facturas` del cargo (sin `total`, IGV 0, la observación de contabilidad);
//  · los textos: sin literales de la empresa, usted nunca tutea y tú nunca dice «usted»;
//  · `politicaContradiceConfig` encuentra 40 % vs 50 % y no salta con «50 % de adelanto» y pct 50.
import {
  ESTADOS_SOLICITUD, ESTADOS_TERMINALES, OBSERVACION_IGV_CARGO, TRANSICIONES, adelantoDe, bloquePago, cargoRetenido,
  cuentasEnMensaje, devolucionDecidida, dineroDeSolicitud, esEstadoTerminal, filaFacturaCargo, firmaImportes,
  horasDeAnticipacion, marcaCargoReserva, mensajeAdelantoIncompleto, mensajeCanceladaSinPago, mensajeCancelacionRegistrada,
  mensajeCancelacionResuelta, mensajeComprobanteRecibido, mensajeDisponibilidadPrimero, mensajeGuardaReserva,
  mensajeHayUnidad, mensajePagoNoEncontrado, mensajePedirPago, mensajePoliticas, mensajeSinUnidad, normalizarConfigReserva,
  politicaContradiceConfig, puedePasar, queFalta, textoPlazoMinutos,
  type EstadoSolicitud, type PagoSolicitud, type SolicitudVista,
} from "../lib/traslados/reserva-pago";
import { cifrasDeFila, entradaCorporativaTraslado, type FilaCotizacionLeida } from "../lib/traslados/cotizacion-traslado";
import { docCorporativo, cuentasCorporativo, cuentasDoc } from "../lib/cotizacion-corporativo";
import { limaAUtcMs } from "../lib/alertas-horario";
import type { EstiloMensajes } from "../lib/crm-ia-ajustes";
import type { PerfilEmpresa } from "../lib/empresa-perfil";
import { correoReserva, destinatariosReserva, enlaceConversacion } from "../lib/traslados/reserva-correo";
import { cotejarComprobante, leerRespuestaComprobante } from "../lib/traslados/comprobante-pago";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(n); } };
const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const cent = (x: number) => Math.round(x * 100);

const USTED: EstiloMensajes = { tratamiento: "usted", preguntas: "todo_junto" };
const TU: EstiloMensajes = { tratamiento: "tu", preguntas: "todo_junto" };

const fila = (precio: number, cantidad: number, moneda: "PEN" | "USD", tc: number | null, igv = true, dscto = 0): FilaCotizacionLeida => ({
  id: 736, numero_cotizacion: null, created_at: "2026-10-20T15:00:00Z", estado: "enviado",
  origen: "Aeropuerto", destino: "Miraflores", fecha_servicio: "2026-10-25", hora_ida: "10:00", fecha_retorno: null, hora_retorno: null,
  tipo_servicio: cantidad === 2 ? "ida_retorno" : "solo_ida",
  items_json: [{ descripcion: "TRASLADO", dias: 1, cantidad, precio_unit: precio, descuento_pct: dscto, pax_contratado: null }],
  incluye_igv: igv, precio_cliente: null, moneda, tipo_cambio: tc, atencion: "Ana", consideraciones_json: null, traslado_json: null,
});
const empresa: PerfilEmpresa = {
  nombre: "Transportes Ejemplo", ruc: "20100066603", email: "reservas@ejemplo.pe",
  cuentas_bancarias: [
    { banco: "BCP", cuenta: "191-1111111-0-11", cci: "002-191-001111111011-11", moneda: "PEN" },
    { banco: "BBVA", cuenta: "0011-0222-0200333333", cci: "011-222-000200333333-22", moneda: "USD" },
    { banco: "Interbank", cuenta: "200-3000444444", cci: "003-200-003000444444-33" },
  ],
};

// ── 1. El adelanto cuadra al céntimo con el PDF ──────────────────────────────
{
  let casos = 0, buenos = 0;
  const precios = [50, 84.75, 99.99, 120, 135.5, 177, 250.4, 333.33, 1000.01];
  for (const moneda of ["PEN", "USD"] as const) for (const precio of precios) for (const cantidad of [1, 2]) for (const igv of [true, false]) for (const dscto of [0, 10]) for (const pct of [10, 30, 33.33, 50, 100]) {
    const tc = moneda === "USD" ? 3.75 : null;
    const pen = moneda === "USD" ? Math.round(precio * 3.75 * 10000) / 10000 : precio;
    const f = fila(pen, cantidad, moneda, tc, igv, dscto);
    const a = adelantoDe(f, pct);
    const c = cifrasDeFila(f)!;
    const doc = docCorporativo(entradaCorporativaTraslado(f, { empresa }));
    const pdf = Number(doc.totales.total.valor.replace(/[^\d.]/g, ""));
    casos++;
    // El PDF en soles imprime el total SIN redondear (fmtImporte, hasta 3 decimales: «S/ 90.005»):
    // el adelanto parte del total al céntimo (el mismo de `cifrasDeFila`) y queda a medio céntimo
    // como mucho de lo impreso.
    const bien = !!a && a.moneda === moneda && a.total === r2(c.figuras[c.figuras.length - 1]) && Math.abs(a.total - pdf) <= 0.005 + 1e-9
      && a.adelanto != null && a.saldo != null && cent(a.adelanto) + cent(a.saldo) === cent(a.total)
      && a.adelanto === r2((a.total * pct) / 100) && a.saldo >= 0;
    if (bien) buenos++; else if (fallas.length < 40) fallas.push(`adelanto ${moneda} ${precio}×${cantidad} igv${igv} d${dscto} ${pct}%: ${JSON.stringify(a)} pdf ${pdf}`);
  }
  t(`el adelanto cuadra al céntimo con el PDF (${buenos}/${casos})`, buenos === casos);
  t("crédito (pct null) → sin adelanto ni saldo", (() => { const a = adelantoDe(fila(100, 1, "PEN", null), null); return !!a && a.adelanto === null && a.saldo === null && a.total === 118; })());
  t("pct fuera de rango → sin adelanto", adelantoDe(fila(100, 1, "PEN", null), 0)?.adelanto === null && adelantoDe(fila(100, 1, "PEN", null), 150)?.adelanto === null);
  t("USD sin tipo de cambio → null", adelantoDe(fila(100, 1, "USD", null), 50) === null);
  t("sin ítems → null", adelantoDe({ ...fila(100, 1, "PEN", null), items_json: [] }, 50) === null);
}

// ── 2. La firma ──────────────────────────────────────────────────────────────
{
  const f = fila(150, 2, "PEN", null);
  const a = firmaImportes(f, 50), b = firmaImportes(JSON.parse(JSON.stringify(f)), 50);
  const reordenada = { ...f, items_json: [{ pax_contratado: null, descuento_pct: 0, precio_unit: 150, cantidad: 2, dias: 1, descripcion: "OTRA" }] };
  t("firma estable", a !== null && a === b && a === firmaImportes(reordenada, 50));
  t("firma cambia con el porcentaje y con el total", a !== firmaImportes(f, 40) && a !== firmaImportes(fila(160, 2, "PEN", null), 50));
  t("firma de crédito distinta", firmaImportes(f, null) !== a && firmaImportes(f, null)!.includes("credito"));
  t("firma null sin importes", firmaImportes({ ...f, items_json: [] }, 50) === null);
}

// ── 3. Transiciones ──────────────────────────────────────────────────────────
{
  t("los terminales no van a ningún lado", ESTADOS_TERMINALES.every((e) => TRANSICIONES[e].length === 0));
  t("ningún estado vuelve a sí mismo", ESTADOS_SOLICITUD.every((e) => !TRANSICIONES[e].includes(e)));
  // Todo estado abierto alcanza un terminal.
  const alcanza = (e: EstadoSolicitud, vistos = new Set<EstadoSolicitud>()): boolean => esEstadoTerminal(e) || (!vistos.has(e) && TRANSICIONES[e].some((x) => alcanza(x, new Set([...vistos, e]))));
  t("todo estado abierto alcanza un terminal", ESTADOS_SOLICITUD.every((e) => alcanza(e)));
  t("puedePasar ≡ la tabla", ESTADOS_SOLICITUD.every((a) => ESTADOS_SOLICITUD.every((b) => puedePasar(a, b) === TRANSICIONES[a].includes(b))));
  t("esperando_pago no salta a completada", !puedePasar("esperando_pago", "completada") && puedePasar("confirmada", "completada"));
  t("pedir otro comprobante: pago_reportado → esperando_pago", puedePasar("pago_reportado", "esperando_pago"));
  t("cancelada y sin_unidad son terminales", esEstadoTerminal("cancelada") && esEstadoTerminal("sin_unidad") && !esEstadoTerminal("confirmada"));
}

// ── 4. queFalta: abierto ⇒ ≥ 1 con dueño; cerrado ⇒ ninguno ───────────────────
{
  const QUIEN = new Set(["cliente", "crm", "tesoreria", "programacion", "facturacion"]);
  let abiertas = 0, abiertasOk = 0, cerradasSaldadas = 0, cerradasSaldadasOk = 0, cerradasPend = 0, cerradasPendOk = 0, completadasOk = 0, completadas = 0;
  for (const estado of ESTADOS_SOLICITUD) for (const pct of [null, 50]) for (const cobrado of [0, 30, 59, 100]) for (const devuelto of [0, 50, 100]) for (const reserva of [null, { id: 1, estado: "pendiente", cliente_id: null }, { id: 1, estado: "pendiente", cliente_id: 7 }, { id: 1, estado: "cancelada", cliente_id: 7 }])
    for (const confirmacionEnviada of [false, true]) for (const cargo of [null, { id: 3, numero: null }, { id: 3, numero: "B001-12" }]) for (const devolucion_pct of [null, 0, 90, 100]) for (const cancelacion of [null, "2026-10-21T10:00:00Z"]) for (const comprobantes of [0, 1]) {
      const s: SolicitudVista = { estado, adelanto_pct: pct, confirmar_antes_de: "2026-10-22T16:00:00Z", devolucion_pct, cancelacion_pedida_en: cancelacion, comprobantes };
      const adelanto = pct == null ? null : 59;
      const x = { cobrado, devuelto: Math.min(devuelto, cobrado), adelanto, reserva, confirmacionEnviada, cargo, moneda: "PEN" as const };
      const p = queFalta(s, x);
      const conDueno = p.every((q) => QUIEN.has(q.quien) && q.detalle.length > 5 && /^[a-z_]{2,40}$/.test(q.codigo));
      if (estado === "completada") { completadas++; if (p.length === 0) completadasOk++; continue; }
      if (!esEstadoTerminal(estado)) { abiertas++; if (p.length >= 1 && conDueno) abiertasOk++; else if (fallas.length < 40) fallas.push(`abierta sin pendiente ${JSON.stringify(s)} ${JSON.stringify(x)}`); continue; }
      // cancelada / sin_unidad: saldada ⟺ ninguna pendiente.
      const pctDev = estado === "sin_unidad" ? 100 : devolucion_pct;
      const reservaViva = !!reserva && reserva.estado !== "cancelada";
      const aDevolver = pctDev == null ? null : devolucionDecidida(cobrado, pctDev);
      const dineroSaldado = cobrado === 0 || (aDevolver != null && x.devuelto + 0.005 >= aDevolver && (cargoRetenido({ cobrado, devuelto: aDevolver }) === 0 || (cargo != null && !!cargo.numero)));
      if (!reservaViva && dineroSaldado) { cerradasSaldadas++; if (p.length === 0) cerradasSaldadasOk++; }
      else { cerradasPend++; if (p.length >= 1 && conDueno) cerradasPendOk++; }
    }
  t(`abierta ⇒ ≥ 1 pendiente con dueño (${abiertasOk}/${abiertas})`, abiertas > 0 && abiertasOk === abiertas);
  t(`completada ⇒ ninguna (${completadasOk}/${completadas})`, completadasOk === completadas);
  t(`cancelada/sin unidad saldada ⇒ ninguna (${cerradasSaldadasOk}/${cerradasSaldadas})`, cerradasSaldadas > 0 && cerradasSaldadasOk === cerradasSaldadas);
  t(`cancelada/sin unidad sin saldar ⇒ ≥ 1 con dueño (${cerradasPendOk}/${cerradasPend})`, cerradasPend > 0 && cerradasPendOk === cerradasPend);
  // Casos con nombre.
  const s0: SolicitudVista = { estado: "esperando_pago", adelanto_pct: 50, comprobantes: 0 };
  const sinRes = { reserva: null, confirmacionEnviada: false, cargo: null };
  t("esperando el pago → pagar (cliente)", queFalta(s0, { cobrado: 0, devuelto: 0, adelanto: 59, ...sinRes })[0]?.codigo === "pagar");
  t("pago reportado → verificar_pago (tesorería) + confirmar", (() => { const p = queFalta({ ...s0, estado: "pago_reportado", comprobantes: 1 }, { cobrado: 0, devuelto: 0, adelanto: 59, ...sinRes }); return p[0]?.codigo === "verificar_pago" && p[0].quien === "tesoreria" && p[1]?.codigo === "confirmar_disponibilidad"; })());
  t("cobro parcial → completar_adelanto", queFalta({ ...s0, estado: "pago_reportado" }, { cobrado: 30, devuelto: 0, adelanto: 59, ...sinRes })[0]?.codigo === "completar_adelanto");
  t("confirmada sin cliente → vincular_cliente", queFalta({ ...s0, estado: "confirmada" }, { cobrado: 59, devuelto: 0, adelanto: 59, reserva: { id: 1, estado: "programada", cliente_id: null }, confirmacionEnviada: false, cargo: null }).some((p) => p.codigo === "vincular_cliente"));
  t("confirmada y pagada → emitir_confirmacion", queFalta({ ...s0, estado: "confirmada" }, { cobrado: 59, devuelto: 0, adelanto: 59, reserva: { id: 1, estado: "programada", cliente_id: 7 }, confirmacionEnviada: false, cargo: null })[0]?.codigo === "emitir_confirmacion");
  t("emitida sin enviar → enviar_confirmacion", queFalta({ ...s0, estado: "confirmada" }, { cobrado: 59, devuelto: 0, adelanto: 59, reserva: { id: 1, estado: "programada", cliente_id: 7 }, confirmacionEnviada: false, confirmacionEmitida: true, cargo: null })[0]?.codigo === "enviar_confirmacion");
  t("por confirmar → vence en el plazo", queFalta({ ...s0, estado: "por_confirmar", confirmar_antes_de: "2026-10-22T16:00:00Z" }, { cobrado: 0, devuelto: 0, adelanto: 59, ...sinRes })[0]?.vence === "2026-10-22T16:00:00Z");
  t("cancelación pedida → resolver_cancelacion", queFalta({ ...s0, estado: "confirmada", cancelacion_pedida_en: "2026-10-21T10:00:00Z" }, { cobrado: 59, devuelto: 0, adelanto: 59, ...sinRes })[0]?.codigo === "resolver_cancelacion");
  t("cancelada con 90 % → registrar_devolucion + emitir_cargo", (() => { const p = queFalta({ estado: "cancelada", adelanto_pct: 50, devolucion_pct: 90 }, { cobrado: 100, devuelto: 0, adelanto: 100, reserva: null, confirmacionEnviada: false, cargo: { id: 9, numero: null } }); return p.some((q) => q.codigo === "registrar_devolucion" && q.quien === "tesoreria" && q.detalle.includes("S/ 90.00")) && p.some((q) => q.codigo === "emitir_cargo" && q.quien === "facturacion"); })());
  t("sin unidad con cobro → devolver el 100 %", queFalta({ estado: "sin_unidad", adelanto_pct: 50 }, { cobrado: 59, devuelto: 0, adelanto: 59, reserva: null, confirmacionEnviada: false, cargo: null }).some((q) => q.codigo === "registrar_devolucion" && q.detalle.includes("S/ 59.00")));
  t("reserva viva en una cancelada → cancelar_en_programacion", queFalta({ estado: "cancelada", adelanto_pct: 50 }, { cobrado: 0, devuelto: 0, adelanto: 59, reserva: { id: 1, estado: "programada", cliente_id: 7 }, confirmacionEnviada: false, cargo: null })[0]?.codigo === "cancelar_en_programacion");
}

// ── 5. El dinero de la solicitud: una devolución nunca suma al adelanto ───────
{
  let casos = 0, buenos = 0;
  let semilla = 7;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const pagos: PagoSolicitud[] = Array.from({ length: Math.floor(azar() * 5) }, () => ({
      sentido: azar() < 0.6 ? "cobro" : azar() < 0.8 ? "pago" : null, monto: r2(azar() * 300), moneda: azar() < 0.85 ? "PEN" : "USD", anulado: azar() < 0.1,
    }));
    const a = dineroDeSolicitud(pagos, "PEN");
    const devolucion: PagoSolicitud = { sentido: "pago", monto: r2(1 + azar() * 200), moneda: "PEN", anulado: false };
    const b = dineroDeSolicitud([...pagos, devolucion], "PEN");
    casos++;
    if (b.cobrado === a.cobrado && cent(b.devuelto) === cent(a.devuelto) + cent(Number(devolucion.monto)) && a.cobrado >= 0) buenos++;
  }
  t(`una devolución nunca suma al adelanto (${buenos}/${casos})`, buenos === casos);
  t("anulados, otra moneda y sin sentido no cuentan", (() => { const d = dineroDeSolicitud([{ sentido: "cobro", monto: 50, moneda: "PEN", anulado: true }, { sentido: "cobro", monto: 20, moneda: "USD" }, { sentido: null, monto: 30, moneda: "PEN" }, { sentido: "cobro", monto: "40.5", moneda: "PEN" }], "PEN"); return d.cobrado === 40.5 && d.devuelto === 0; })());
  // cargoRetenido = cobrado − devuelto, nunca negativo.
  let cargoOk = 0, cargoCasos = 0;
  for (let c = 0; c <= 300; c += 7.25) for (let d = 0; d <= 320; d += 11.5) {
    cargoCasos++;
    const k = cargoRetenido({ cobrado: c, devuelto: d });
    if (k >= 0 && (c >= d ? cent(k) === cent(c) - cent(d) : k === 0)) cargoOk++;
  }
  t(`cargoRetenido = cobrado − devuelto, nunca negativo (${cargoOk}/${cargoCasos})`, cargoOk === cargoCasos);
  t("cargoRetenido con basura → 0", cargoRetenido({ cobrado: NaN, devuelto: 10 }) === 0);
  t("devolucionDecidida 90 % de 100 = 90", devolucionDecidida(100, 90) === 90 && devolucionDecidida(100, 150) === 100 && devolucionDecidida(-5, 50) === 0);
}

// ── 6. La fila de `facturas` del cargo ───────────────────────────────────────
{
  const base = { solicitudId: 41, cotizacion: { id: 736, numero: "00736", moneda: "PEN", tipo_cambio: null }, reservaId: 29900, cobrado: 100, devuelto: 90, hoy: "2026-10-22", servicio: { fecha: "2026-10-25", hora: "10:00:00" } };
  const conRuc = filaFacturaCargo({ ...base, cliente: { id: 5, ruc: "20100066603" } })!;
  t("factura con RUC válido", conRuc.fila.tipo_comprobante === "factura" && conRuc.total === 10);
  t("sin columna total (generada) e IGV 0", !("total" in conRuc.fila) && conRuc.fila.igv === 0 && conRuc.fila.subtotal === 10);
  t("sin número ni serie, pendiente", conRuc.fila.numero === null && conRuc.fila.serie === null && conRuc.fila.estado === "pendiente" && conRuc.fila.sunat_estado === "pendiente");
  t("fecha_emision (NOT NULL) = hoy", conRuc.fila.fecha_emision === "2026-10-22");
  t("observación de contabilidad y marca de la solicitud", conRuc.fila.observaciones.includes(OBSERVACION_IGV_CARGO) && conRuc.fila.observaciones.includes(marcaCargoReserva(41)));
  t("ítem «Cargo por cancelación de la reserva …»", conRuc.fila.items_json.length === 1 && conRuc.fila.items_json[0].descripcion.startsWith("Cargo por cancelación de la reserva") && conRuc.fila.items_json[0].total === 10 && conRuc.fila.items_json[0].descripcion.includes("25/10/2026 a las 10:00"));
  t("los ids", conRuc.fila.cliente_id === 5 && conRuc.fila.cotizacion_id === 736 && conRuc.fila.reserva_id === 29900);
  const sinRuc = filaFacturaCargo({ ...base, cliente: { id: 5, ruc: "" } })!;
  t("boleta sin RUC", sinRuc.fila.tipo_comprobante === "boleta" && !sinRuc.fila.observaciones.includes("no es válido"));
  const rucMalo = filaFacturaCargo({ ...base, cliente: { id: 5, ruc: "20100066604" } })!;
  t("RUC inválido → boleta y se dice", rucMalo.fila.tipo_comprobante === "boleta" && rucMalo.fila.observaciones.includes("no es válido"));
  t("sin cargo → null", filaFacturaCargo({ ...base, cliente: null, devuelto: 100 }) === null && filaFacturaCargo({ ...base, cliente: null, devuelto: 130 }) === null);
  const usd = filaFacturaCargo({ ...base, cotizacion: { id: 1, numero: "1", moneda: "USD", tipo_cambio: "3.75" }, cliente: null })!;
  t("USD con su tipo de cambio; PEN con 1", usd.fila.moneda === "USD" && usd.fila.tipo_cambio === 3.75 && conRuc.fila.tipo_cambio === 1 && usd.fila.cliente_id === null);
}

// ── 7. Las cuentas del chat son las del PDF ──────────────────────────────────
{
  for (const m of ["PEN", "USD"] as const) {
    const c = cuentasEnMensaje(null, empresa, m);
    const pdf = cuentasDoc(cuentasCorporativo(null, empresa, m).cuentas)!;
    t(`cuentas ${m}: las mismas del PDF`, c.lineas.length === pdf.items.length && c.lineas.every((l, i) => l.startsWith(`• ${pdf.items[i].banco}`) && pdf.items[i].lineas.every((x) => l.includes(x))));
  }
  t("PEN no lleva la cuenta declarada en dólares", !cuentasEnMensaje(null, empresa, "PEN").lineas.some((l) => l.includes("BBVA")));
  t("mostrar_cuentas_bancarias false → ninguna", cuentasEnMensaje({ mostrar_cuentas_bancarias: false }, empresa, "PEN").lineas.length === 0);
}

// ── 8. La política contra la configuración ───────────────────────────────────
{
  const publicada = [
    "La reserva se confirma con el 50 % de adelanto; el 50 % restante se paga al iniciar el servicio.",
    "Cambios de fecha, hora o itinerario: sin costo, sujetos a disponibilidad.",
    "Cancelación con 24 horas o más de anticipación: sin costo, devolución del 100 % en un máximo de 48 horas.",
    "Con menos de 24 horas: reprogramar sin costo o cancelar con un cargo administrativo del 10 % del monto pagado; el saldo se devuelve en máx. 48 h.",
    "Con la unidad en el punto de recojo o si el pasajero no se presenta: se cobra el 50 % del total (el adelanto), sin devolución.",
  ];
  const cfg = { adelantoPct: 50, devolucionPlazoH: 48 };
  t("la política publicada no contradice 50 % y 48 h", politicaContradiceConfig(publicada, cfg).length === 0);
  t("«50 % de adelanto» con pct 50 → nada", politicaContradiceConfig(["Se reserva con 50 % de adelanto."], cfg).length === 0);
  const c40 = politicaContradiceConfig(["Se reserva con 40 % de adelanto."], cfg);
  t("encuentra 40 % vs 50 %", c40.length === 1 && c40[0].codigo === "adelanto_pct" && c40[0].leido === 40 && c40[0].config === 50);
  t("«adelanto del 30 %» también", politicaContradiceConfig(["Se pide un adelanto del 30 % del total."], cfg)[0]?.leido === 30);
  t("el 10 % de un cargo no es el adelanto", politicaContradiceConfig(["Cargo administrativo del 10 % del monto pagado."], cfg).length === 0);
  t("plazo de devolución 72 h vs 48 h", politicaContradiceConfig(["Devolución del 100 % en un máximo de 72 horas."], cfg).some((c) => c.codigo === "plazo_devolucion" && c.leido === 72));
  t("sin config no juzga", politicaContradiceConfig(["Se reserva con 40 % de adelanto."], { adelantoPct: null, devolucionPlazoH: null }).length === 0);
}

// ── 9. Configuración ─────────────────────────────────────────────────────────
{
  const d = normalizarConfigReserva(undefined);
  t("sin migración: apagada, sin pct, P 120, M 360", !d.activa && d.adelantoPct === null && d.plazoConfirmacionMin === 120 && d.margenMin === 360 && d.devolucionPlazoH === null && d.correo === null);
  const c = normalizarConfigReserva({ reserva_ia: true, reserva_adelanto_pct: "50.00", reserva_correo: " transporte@ejemplo.pe ", reserva_plazo_confirmacion_min: 90, reserva_margen_min: 0, reserva_devolucion_plazo_h: 48 });
  t("con la fila", c.activa && c.adelantoPct === 50 && c.correo === "transporte@ejemplo.pe" && c.plazoConfirmacionMin === 90 && c.margenMin === 0 && c.devolucionPlazoH === 48);
  const fuera = normalizarConfigReserva({ reserva_ia: "true", reserva_adelanto_pct: 0, reserva_plazo_confirmacion_min: 5, reserva_margen_min: 99999, reserva_devolucion_plazo_h: 0 });
  t("fuera de rango → defectos; solo true enciende", !fuera.activa && fuera.adelantoPct === null && fuera.plazoConfirmacionMin === 120 && fuera.margenMin === 360 && fuera.devolucionPlazoH === null);
}

// ── 10. Los textos ───────────────────────────────────────────────────────────
{
  const cuentas = cuentasEnMensaje(null, empresa, "PEN").lineas;
  const at = { activa: true, dias: [1, 2, 3, 4, 5, 6], desde: "09:00", hasta: "18:00" };
  const bloque = { numero: "00736", moneda: "PEN" as const, pct: 50, adelanto: 88.5, saldo: 88.5, cuentas };
  const pedida = limaAUtcMs("2026-10-24", "22:05")!, inicio = limaAUtcMs("2026-10-25", "10:00")!;
  const cotejoSeguro = { codigos: ["coincide"], seguro: true, monto: 88.5, operacion: "123456" };
  const textos = (e: EstiloMensajes): Record<string, string> => ({
    T1: mensajePedirPago({ ...bloque, plazoMin: 120, atencion: at, estilo: e }),
    T2: mensajeDisponibilidadPrimero({ fecha: "2026-10-25", hora: "10:00", frasePlazo: "hoy antes de las 15:30", pct: 50, credito: false, estilo: e }),
    T2c: mensajeDisponibilidadPrimero({ fecha: "2026-10-25", hora: "10:00", frasePlazo: null, pct: null, credito: true, estilo: e }),
    T3: mensajeComprobanteRecibido({ cotejo: cotejoSeguro, esperado: 88.5, moneda: "PEN", frasePlazo: "mañana martes antes de las 11:00", estilo: e }),
    T3m: mensajeComprobanteRecibido({ cotejo: { codigos: ["monto_menor"], seguro: false, monto: 50, operacion: "1" }, esperado: 88.5, moneda: "PEN", frasePlazo: null, estilo: e }),
    T3i: mensajeComprobanteRecibido({ cotejo: { codigos: ["ilegible"], seguro: false, monto: null, operacion: null }, esperado: 88.5, moneda: "PEN", frasePlazo: null, estilo: e }),
    T3n: mensajeComprobanteRecibido({ cotejo: { codigos: ["coincide", "sin_operacion"], seguro: false, monto: 88.5, operacion: null }, esperado: 88.5, moneda: "PEN", frasePlazo: "hoy antes de las 15:30", estilo: e }),
    T3u: mensajeComprobanteRecibido({ cotejo: cotejoSeguro, esperado: 88.5, moneda: "PEN", frasePlazo: "hoy antes de las 15:30", unidadConfirmada: true, estilo: e }),
    T4v: mensajeHayUnidad({ fecha: "2026-10-25", hora: "10:00", origen: "Aeropuerto", destino: "Miraflores", pago: "verificado", moneda: "PEN", cobrado: 88.5, estilo: e }),
    T4r: mensajeHayUnidad({ fecha: "2026-10-25", hora: "10:00", origen: "Aeropuerto", destino: "Miraflores", pago: "reportado", moneda: "PEN", estilo: e }),
    T4p: mensajeHayUnidad({ fecha: "2026-10-25", hora: "10:00", origen: "Aeropuerto", destino: "Miraflores", pago: "pedir", moneda: "PEN", bloque, estilo: e }),
    T4c: mensajeHayUnidad({ fecha: "2026-10-25", hora: "10:00", origen: "Aeropuerto", destino: "Miraflores", pago: "credito", moneda: "PEN", estilo: e }),
    T4i: mensajeHayUnidad({ fecha: "2026-10-25", hora: "10:00", origen: "Aeropuerto", destino: "Miraflores", pago: "incompleto", moneda: "PEN", cobrado: 50, bloque, estilo: e }),
    T5p: mensajeSinUnidad({ fecha: "2026-10-25", hora: "10:00", conPago: true, plazoH: 48, estilo: e }),
    T5s: mensajeSinUnidad({ fecha: "2026-10-25", hora: "10:00", conPago: false, plazoH: null, estilo: e }),
    T6: mensajeCancelacionRegistrada({ fecha: "2026-10-25", hora: "10:00", pedidaMs: pedida, inicioMs: inicio, estilo: e }),
    T6s: mensajeCanceladaSinPago({ numero: "00736", estilo: e }),
    T7d: mensajeCancelacionResuelta({ monto: 79.65, pct: 90, moneda: "PEN", plazoH: 48, estilo: e }),
    T7n: mensajeCancelacionResuelta({ monto: 0, pct: 0, moneda: "PEN", plazoH: 48, estilo: e }),
    T8: mensajePoliticas({ numero: "00736", lineas: ["Línea uno.", "Línea dos."], email: null, estilo: e })!,
    T9: mensajePagoNoEncontrado(e),
    T10: mensajeGuardaReserva("00736", e),
    T11: mensajeAdelantoIncompleto({ cobrado: 50, falta: 38.5, moneda: "PEN", estilo: e }),
  });
  const u = textos(USTED), tu = textos(TU);
  const LITERALES = /\bafa\b|afatours|transportesafa|966\s?707|905\s?438|997\s?683|@afa/i;
  t("sin literales de la empresa", Object.values(u).concat(Object.values(tu)).every((x) => !LITERALES.test(x)));
  // Palabras completas con letras acentuadas (\b de JS no entiende «tú»).
  const palabra = (xs: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${xs.join("|")})(?![\\p{L}\\p{N}])`, "iu");
  const DE_TU = palabra(["tú", "tu", "tus", "te", "ti", "contigo", "puedes", "deseas", "hayas", "envíanos", "escríbenos", "no realices", "confirmas", "envías", "informarte", "pedirte"]);
  const DE_USTED = palabra(["usted", "su", "sus", "le", "les", "puede", "desea", "haya", "envíenos", "escríbanos", "no realice", "informarle", "pedirle"]);
  for (const k of Object.keys(u)) {
    t(`${k} de usted no tutea`, !DE_TU.test(u[k]));
    t(`${k} de tú no dice usted`, !DE_USTED.test(tu[k]));
    t(`${k}: las dos variantes están escritas (difieren)`, u[k] !== tu[k]);
  }
  t("T1 lleva el adelanto, el saldo al iniciar el servicio, las cuentas, el plazo y el horario", u.T1.includes("*S/ 88.50*") && u.T1.includes("El saldo, S/ 88.50, se paga al iniciar el servicio, cuando la unidad se presente en el punto de recojo.") && cuentas.every((c) => u.T1.includes(c)) && u.T1.includes("2 horas") && u.T1.includes("de lunes a sábado, de 09:00 a 18:00"));
  t("T1 de tú también dice el saldo al iniciar el servicio", tu.T1.includes("se paga al iniciar el servicio, cuando la unidad se presente en el punto de recojo."));
  t("T1 al 100 % no nombra un saldo de cero", !bloquePago({ ...bloque, pct: 100, adelanto: 177, saldo: 0 }, USTED).includes("saldo"));
  t("T2 dice no pague todavía y el plazo", u.T2.includes("no realice ningún pago todavía") && u.T2.includes(", hoy antes de las 15:30.") && u.T2.includes("(50 % del total)"));
  t("T2 crédito sin adelanto, «a la brevedad» sin plazo", u.T2c.includes("condición de crédito") && !u.T2c.includes("adelanto") && u.T2c.includes("a la brevedad"));
  t("T3 seguro nombra monto y operación", u.T3.includes("de S/ 88.50 (operación N° 123456)") && u.T3.includes("mañana martes antes de las 11:00"));
  t("T3 no seguro NO nombra el monto", !u.T3n.includes("88.50") && u.T3n.startsWith("Recibimos su comprobante."));
  t("T3 monto menor nombra lo leído y lo esperado", u.T3m.includes("S/ 50.00") && u.T3m.includes("S/ 88.50"));
  t("T3 ilegible pide otra foto", u.T3i.startsWith("No pudimos leer el comprobante."));
  t("T3 con la unidad ya confirmada promete la Confirmación", u.T3u.includes("Confirmación de Reserva") && !u.T3u.includes("100 %"));
  t("T4 pedir lleva el bloque de pago", u.T4p.includes("*S/ 88.50*") && u.T4p.startsWith("Confirmamos que hay una unidad disponible para su traslado del 25/10/2026 a las 10:00 (Aeropuerto → Miraflores)."));
  t("T4 incompleto lleva T11 y las cuentas", u.T4i.includes("faltan S/ 38.50") && cuentas.every((c) => u.T4i.includes(c)));
  t("T5 con pago devuelve el 100 % en 48 horas", u.T5p.includes("100 % de lo pagado en un máximo de 48 horas"));
  t("T6 dice la hora del mensaje y las horas de anticipación", u.T6.includes("recibido el 24/10 a las 22:05") && u.T6.includes("11 horas antes del inicio del servicio"));
  t("horasDeAnticipacion", horasDeAnticipacion(pedida, inicio) === 11 && horasDeAnticipacion(pedida, null) === null);
  t("T6 después del inicio", mensajeCancelacionRegistrada({ fecha: null, hora: null, pedidaMs: inicio + 60_000, inicioMs: inicio, estilo: USTED }).includes("después de la hora de inicio"));
  t("T7 con devolución", u.T7d === "Su reserva quedó cancelada. Le devolvemos S/ 79.65 (90 % de lo pagado) en un máximo de 48 horas.");
  t("T7 sin devolución", u.T7n.includes("no corresponde devolución"));
  t("T8 lista las líneas tal cual y el correo solo si es una dirección", u.T8.includes("• Línea uno.\n• Línea dos.") && !u.T8.includes("correo") && mensajePoliticas({ numero: "1", lineas: ["x"], email: "reservas@ejemplo.pe", estilo: USTED })!.includes("o al correo reservas@ejemplo.pe") && !mensajePoliticas({ numero: "1", lineas: ["x"], email: "no es correo", estilo: USTED })!.includes("o al correo"));
  t("T8 sin políticas → null", mensajePoliticas({ numero: "1", lineas: [" ", ""], email: null, estilo: USTED }) === null);
  t("T10 con y sin número", u.T10.endsWith("cotización N° 00736?") && mensajeGuardaReserva(null, USTED).endsWith("¿Desea reservar su traslado?"));
  t("textoPlazoMinutos", textoPlazoMinutos(120) === "2 horas" && textoPlazoMinutos(90) === "1 hora y 30 minutos" && textoPlazoMinutos(45) === "45 minutos" && textoPlazoMinutos(61) === "1 hora y 1 minuto");
}

// ── 11. El correo interno ────────────────────────────────────────────────────
{
  const d = destinatariosReserva({ correoConfig: "a@x.pe; b@x.pe a@x.pe", emailEmpresa: "c@x.pe" });
  t("destinatarios de la configuración, sin repetir", d.fuente === "configurada" && d.correos.join() === "a@x.pe,b@x.pe");
  t("sin configuración → el del perfil", destinatariosReserva({ correoConfig: " ", emailEmpresa: "c@x.pe" }).fuente === "perfil_empresa");
  t("sin ninguno → no se envía", destinatariosReserva({}).fuente === null && destinatariosReserva({}).correos.length === 0);
  const lectura = leerRespuestaComprobante('{"es_comprobante":true,"texto_monto":"S/ 50.00","monto":50,"moneda":"PEN","fecha":"2026-10-21","numero_operacion":"<b>123456</b>"}');
  const cotejo = cotejarComprobante(lectura, { adelanto: 88.5, total: 177, moneda: "PEN", hoy: "2026-10-22", desde: "2026-10-20", operacionesPrevias: [], cuentas: [] });
  const ahora = limaAUtcMs("2026-10-21", "22:00")!;
  const c = correoReserva({
    tipo: "pago_reportado", cliente: { nombre: "<script>alert(1)</script>\nBcc: x@y.z", waId: "51987654321" },
    cotizacion: { numero: "00736", origen: "Aeropuerto", destino: "Miraflores <img src=x>", fecha: "2026-10-25", hora: "10:00:00" },
    moneda: "PEN", total: 177, adelanto: 88.5, pct: 50, lectura, cotejo, confirmarAntesMs: limaAUtcMs("2026-10-22", "11:00"), ahoraMs: ahora,
    adjunto: true, convId: "6f1c2a9e-0b4d-4c1a-9c61-2f7c0e1b5a33", appUrl: "https://erp.ejemplo.pe/",
  });
  t("el asunto dice NO CUADRA y va en una línea", c.asunto.startsWith("⚠ NO CUADRA · Pago REPORTADO (sin verificar) · Cotización N° 00736") && !/[\r\n]/.test(c.asunto));
  t("el cuerpo dice REPORTADO, PENDIENTE y que no se registre", c.html.includes("Pago REPORTADO por el cliente, PENDIENTE de verificar en el banco: no registres el adelanto hasta ver el dinero en la cuenta.") && c.texto.includes("PENDIENTE de verificar"));
  t("lo que leyó la IA va rotulado «puede equivocarse»", c.html.includes("(puede equivocarse)") && c.texto.includes("(puede equivocarse)"));
  t("todo dato del cliente va escapado", !c.html.includes("<script>") && !c.html.includes("<img") && !c.html.includes("<b>123456") && c.html.includes("&lt;script&gt;"));
  t("el cotejo y el plazo van en el correo", c.texto.includes("MENOR que el adelanto") && c.texto.includes("mañana jueves antes de las 11:00 (22/10/2026 11:00)"));
  t("el enlace a la conversación", c.html.includes('href="https://erp.ejemplo.pe/crm?conv=6f1c2a9e-0b4d-4c1a-9c61-2f7c0e1b5a33"'));
  t("sin URL http(s) no hay enlace", enlaceConversacion("javascript:alert(1)", "x") === null && enlaceConversacion("https://a.pe", "id con espacios") === null);
  const p = correoReserva({ tipo: "por_confirmar", cliente: { nombre: "Ana", waId: null }, cotizacion: { numero: "1" }, moneda: "PEN", total: 177, adelanto: null, pct: null, ahoraMs: ahora, urgente: true, motivos: ["zona_sin_envio"] });
  t("por confirmar: urgente, motivos y sin plazo dicho como tal", p.asunto.startsWith("⚠ URGENTE · Reserva por confirmar disponibilidad") && p.texto.includes("Ni el recojo ni el destino") && p.texto.includes("sin plazo calculado"));
  t("el correo no lleva literales de la empresa", !/\bafa\b|afatours/i.test(c.html + c.texto + p.html + p.texto));
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0) process.exit(1);
console.log("Todo OK");
