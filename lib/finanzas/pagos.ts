// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/pagos.ts — Registro de cobros/pagos con aplicación a comprobantes.
//
// La primitiva que hoy no existe. Un pago (cobro o pago) se registra UNA vez y se
// APLICA a 1..N comprobantes. El saldo del comprobante = total − Σ aplicado; el
// estado ("cobrada"/"pagada") se DERIVA de ese saldo, nunca se teclea. Esto cierra
// las "dos verdades" facturas.estado ↔ reservas.estado_admin.
//
// Un pago sin aplicar (o aplicado de menos) es un ANTICIPO (queda saldo a favor).
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, saldo as calcSaldo } from "@/lib/finanzas/dinero";
import { estadoAdminDerivado, estadoProveedorDerivado } from "@/lib/estados";
import type { DocumentoTipo, SentidoPago } from "@/lib/finanzas/tipos";

type Aplicacion = { documento_tipo: DocumentoTipo; documento_id: number; monto_aplicado: number };

export type RegistrarPagoArgs = {
  sentido: SentidoPago;                 // 'cobro' (cliente) | 'pago' (proveedor/tercero)
  cuenta_tesoreria_id?: number | null;
  fecha?: string;                       // YYYY-MM-DD Lima; default hoy
  monto: number;
  moneda?: string;
  tipo_cambio?: number | null;
  metodo?: string | null;
  contraparte_tipo?: "cliente" | "proveedor" | "tercero" | "otro" | null;
  contraparte_id?: number | null;
  referencia?: string | null;
  observaciones?: string | null;
  creado_por?: string | null;
  aplicaciones?: Aplicacion[];          // vacío = anticipo puro
};

function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Suma lo ya aplicado a un comprobante (para derivar su saldo). EXCLUYE los pagos
 * anulados (soft-delete): un cobro/pago anulado no debe seguir reduciendo el saldo.
 * Como TODO el saldo del ERP se deriva de aquí, este filtro protege la "única verdad"
 * aunque la anulación se haga directo en la BD.
 */
export async function totalAplicado(sb: any, tipo: DocumentoTipo, documentoId: number): Promise<number> {
  const { data } = await sb
    .from("pagos_aplicacion")
    .select("monto_aplicado, pagos!inner(anulado)")
    .eq("documento_tipo", tipo)
    .eq("documento_id", documentoId)
    .eq("pagos.anulado", false);
  return redondear(((data as any[]) ?? []).reduce((a, r) => a + Number(r.monto_aplicado || 0), 0));
}

/**
 * Registra un pago y sus aplicaciones; genera el movimiento de tesorería y
 * sincroniza el estado derivado de cada comprobante afectado. Atómico a nivel de
 * lógica de negocio (si algo falla después del insert del pago, devuelve error con el
 * pago_id creado para que el llamador decida; en producción conviene una RPC/tx).
 */
export async function registrarPago(sb: any, a: RegistrarPagoArgs): Promise<{ ok: boolean; pago_id?: number; error?: string; aviso?: string }> {
  try {
    if (!(a.monto > 0)) throw new Error("El monto debe ser mayor a 0");
    const fecha = a.fecha || hoyLima();

    const { data: pago, error } = await sb
      .from("pagos")
      .insert({
        sentido: a.sentido,
        cuenta_tesoreria_id: a.cuenta_tesoreria_id ?? null,
        fecha,
        monto: redondear(a.monto),
        moneda: a.moneda ?? "PEN",
        tipo_cambio: a.tipo_cambio ?? null,
        metodo: a.metodo ?? null,
        contraparte_tipo: a.contraparte_tipo ?? null,
        contraparte_id: a.contraparte_id ?? null,
        referencia: a.referencia ?? null,
        observaciones: a.observaciones ?? null,
        creado_por: a.creado_por ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`pagos: ${error.message}`);
    const pagoId = Number((pago as any).id);

    const aplic = (a.aplicaciones ?? []).filter((x) => x.monto_aplicado > 0);
    const sumaAplic = redondear(aplic.reduce((s, x) => s + x.monto_aplicado, 0));
    if (sumaAplic - 0.005 > redondear(a.monto)) {
      throw new Error(`Las aplicaciones (${sumaAplic}) exceden el monto del pago (${a.monto})`);
    }

    if (aplic.length) {
      const filas = aplic.map((x) => ({
        pago_id: pagoId,
        documento_tipo: x.documento_tipo,
        documento_id: x.documento_id,
        monto_aplicado: redondear(x.monto_aplicado),
      }));
      const { error: e2 } = await sb.from("pagos_aplicacion").insert(filas);
      if (e2) throw new Error(`pagos_aplicacion: ${e2.message}`);
    }

    // Movimiento de tesorería (si hay cuenta). Se captura el error para no descuadrar
    // el libro de caja/bancos en silencio: el pago ya existe, pero avisamos si el
    // movimiento no se pudo asentar (base de la conciliación bancaria).
    let aviso: string | undefined;
    if (a.cuenta_tesoreria_id) {
      const { error: eMov } = await sb.from("movimientos_tesoreria").insert({
        cuenta_tesoreria_id: a.cuenta_tesoreria_id,
        fecha,
        sentido: a.sentido === "cobro" ? "entrada" : "salida",
        monto: redondear(a.monto),
        moneda: a.moneda ?? "PEN",
        concepto: a.observaciones ?? (a.sentido === "cobro" ? "Cobro" : "Pago"),
        pago_id: pagoId,
        referencia: a.referencia ?? null,
      });
      if (eMov) aviso = `El pago se registró pero el movimiento de tesorería falló: ${eMov.message}`;
    }

    // Sincronizar el estado derivado de cada comprobante afectado.
    for (const x of aplic) {
      await sincronizarEstadoDocumento(sb, x.documento_tipo, x.documento_id);
    }

    return { ok: true, pago_id: pagoId, aviso };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Recalcula el estado derivado de un comprobante desde su saldo y propaga a las
 * reservas que dependen de él (dimensión B para venta, C para compra/tercero).
 */
export async function sincronizarEstadoDocumento(sb: any, tipo: DocumentoTipo, documentoId: number): Promise<void> {
  const pagado = await totalAplicado(sb, tipo, documentoId);

  if (tipo === "factura") {
    const { data: f } = await sb.from("facturas").select("id, total, reserva_id, estado").eq("id", documentoId).maybeSingle();
    if (!f) return;
    if (f.estado === "anulada") return; // no resucitar un comprobante anulado
    const total = Number(f.total ?? 0);
    const saldado = calcSaldo(total, pagado) <= 0.005 && total > 0;
    // Solo mover el estado cuando hay señal: saldado→cobrada; cobro parcial→enviada.
    // Sin pagos (pagado=0) NO se toca (no degradar una "emitida" recién creada).
    if (saldado) await sb.from("facturas").update({ estado: "cobrada" }).eq("id", documentoId);
    else if (pagado > 0 && f.estado !== "cobrada") await sb.from("facturas").update({ estado: "enviada" }).eq("id", documentoId);

    // Dimensión B derivada para las reservas cubiertas por esta factura.
    const nuevoAdmin = estadoAdminDerivado({ tieneFactura: true, total, pagado });
    const patch: any = { estado_admin: nuevoAdmin };
    if (saldado) patch.fecha_cobro = new Date().toISOString();

    // (a) factura de una sola reserva (reserva_id directo)
    if (f.reserva_id) await sb.from("reservas").update(patch).eq("id", f.reserva_id);

    // (b) factura de una liquidación consolidada (N reservas ligadas por liquidacion_cliente_id)
    const { data: liq } = await sb.from("liquidacion_cliente").select("id").eq("factura_id", documentoId).maybeSingle();
    if (liq?.id) await sb.from("reservas").update(patch).eq("liquidacion_cliente_id", liq.id);
    return;
  }

  if (tipo === "documento_compra") {
    const { data: d } = await sb.from("documentos_compra").select("id, total, liquidacion_proveedor_id").eq("id", documentoId).maybeSingle();
    if (!d) return;
    const total = Number(d.total ?? 0);
    const saldado = calcSaldo(total, pagado) <= 0.005 && total > 0;
    // Escribir el estado de PAGO en su propio eje (estado_pago), NUNCA en
    // estado_conciliacion (que modela la conciliación FISCAL factura↔carga real y lo
    // gobierna conciliarFactura). Son ejes ortogonales.
    const estadoPago = saldado ? "pagada" : pagado > 0 ? "parcial" : "impaga";
    await sb.from("documentos_compra").update({ estado_pago: estadoPago }).eq("id", documentoId);
    if (d.liquidacion_proveedor_id) {
      await sb.from("liquidacion_proveedor").update({ estado: saldado ? "pagada" : "por_pagar" }).eq("id", d.liquidacion_proveedor_id);
      const nuevoC = estadoProveedorDerivado({ liquidacionAprobada: true, total, pagado });
      const patch: any = { estado_proveedor: nuevoC };
      if (saldado) patch.fecha_pago_proveedor = new Date().toISOString();
      await sb.from("reservas").update(patch).eq("liquidacion_proveedor_id", d.liquidacion_proveedor_id);
    }
    return;
  }
}

/** Azúcar: registrar un cobro de cliente contra una factura. */
export function registrarCobroFactura(
  sb: any,
  args: { factura_id: number; monto: number; cuenta_tesoreria_id?: number | null; cliente_id?: number | null; metodo?: string | null; referencia?: string | null; fecha?: string }
) {
  return registrarPago(sb, {
    sentido: "cobro",
    cuenta_tesoreria_id: args.cuenta_tesoreria_id ?? null,
    monto: args.monto,
    metodo: args.metodo ?? null,
    contraparte_tipo: "cliente",
    contraparte_id: args.cliente_id ?? null,
    referencia: args.referencia ?? null,
    fecha: args.fecha,
    aplicaciones: [{ documento_tipo: "factura", documento_id: args.factura_id, monto_aplicado: args.monto }],
  });
}

/** Azúcar: registrar un pago a proveedor contra un documento de compra. */
export function registrarPagoCompra(
  sb: any,
  args: { documento_compra_id: number; monto: number; cuenta_tesoreria_id?: number | null; proveedor_id?: number | null; metodo?: string | null; referencia?: string | null; fecha?: string }
) {
  return registrarPago(sb, {
    sentido: "pago",
    cuenta_tesoreria_id: args.cuenta_tesoreria_id ?? null,
    monto: args.monto,
    metodo: args.metodo ?? null,
    contraparte_tipo: "proveedor",
    contraparte_id: args.proveedor_id ?? null,
    referencia: args.referencia ?? null,
    fecha: args.fecha,
    aplicaciones: [{ documento_tipo: "documento_compra", documento_id: args.documento_compra_id, monto_aplicado: args.monto }],
  });
}
