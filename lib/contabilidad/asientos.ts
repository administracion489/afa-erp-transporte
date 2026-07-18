// ──────────────────────────────────────────────────────────────────────────────
// lib/contabilidad/asientos.ts — Motor de POSTING (partida doble).
//
// Cada asiento se DERIVA de un documento fuente (factura, documento_compra, pago,
// depreciación). No se re-teclea: se genera balanceado y se apunta a su origen para
// trazabilidad. Los códigos de cuenta son del subconjunto PCGE sembrado en
// supabase/contabilidad-04-plan-asientos.sql; el contador puede re-mapearlos.
//
// El asiento se GUARDA en estado 'asentado' solo si cuadra (total_debe = total_haber);
// el CHECK de la BD (asiento_balanceado_chk) lo refuerza.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear } from "@/lib/finanzas/dinero";
import type { Asiento, AsientoDetalle, Moneda } from "@/lib/finanzas/tipos";

// Cuentas por defecto (mapeo editable). Deben existir en plan_cuentas.
export const CTA = {
  CAJA: "1011",
  BANCOS: "104",
  CXC_FACTURAS: "1212",
  CXC_BOLETAS: "1213",
  IGV: "40111",
  CXP: "4212",
  CXP_DIVERSAS: "4691",
  COMPRAS: "601",
  SERVICIOS_TERCEROS: "631",
  MANTENIMIENTO: "634",
  COMBUSTIBLE_CONSUMO: "656",
  VENTAS: "7041",
  DEPREC_GASTO: "6811",
  DEPREC_ACUM: "3913",
  ACTIVO_UNIDAD: "334",
} as const;

const nz = (n: unknown) => redondear(Number(n ?? 0));

function armar(
  origen_tipo: string,
  origen_id: number,
  fecha: string,
  glosa: string,
  lineas: AsientoDetalle[],
  moneda: Moneda = "PEN"
): Asiento {
  const limpias = lineas
    .map((l) => ({ ...l, debe: nz(l.debe), haber: nz(l.haber) }))
    .filter((l) => l.debe > 0 || l.haber > 0);
  const total_debe = redondear(limpias.reduce((a, l) => a + l.debe, 0));
  const total_haber = redondear(limpias.reduce((a, l) => a + l.haber, 0));
  return {
    fecha,
    glosa,
    origen_tipo,
    origen_id,
    moneda,
    total_debe,
    total_haber,
    estado: "borrador",
    lineas: limpias,
  };
}

/** ¿El asiento cuadra? (con tolerancia de céntimo). */
export function cuadra(a: Asiento): boolean {
  return Math.abs(a.total_debe - a.total_haber) <= 0.005 && a.total_debe > 0;
}

// ── Generadores por tipo de documento ───────────────────────────────────────

/** VENTA (emisión de comprobante): CxC a Ventas + IGV. */
export function asientoVenta(f: {
  id: number; fecha: string; subtotal: number; igv: number; total: number;
  tipo_comprobante?: string; cliente_id?: number | null; moneda?: Moneda;
}): Asiento {
  const cxc = (f.tipo_comprobante ?? "factura") === "boleta" ? CTA.CXC_BOLETAS : CTA.CXC_FACTURAS;
  return armar("factura", f.id, f.fecha, `Venta ${f.tipo_comprobante ?? "factura"} #${f.id}`, [
    { cuenta: cxc, debe: nz(f.total), haber: 0, cliente_id: f.cliente_id ?? null },
    { cuenta: CTA.VENTAS, debe: 0, haber: nz(f.subtotal) },
    { cuenta: CTA.IGV, debe: 0, haber: nz(f.igv) },
  ], f.moneda ?? "PEN");
}

/** COMPRA (comprobante de compra recibido): gasto + IGV crédito fiscal a CxP. */
export function asientoCompra(d: {
  id: number; fecha: string; subtotal: number; igv: number; total: number;
  categoria?: string | null; proveedor_id?: number | null; moneda?: Moneda;
}): Asiento {
  const ctaGasto =
    d.categoria === "combustible" ? CTA.COMBUSTIBLE_CONSUMO :
    d.categoria === "tercero" || d.categoria === "servicio" ? CTA.SERVICIOS_TERCEROS :
    d.categoria === "mantenimiento" ? CTA.MANTENIMIENTO : CTA.COMPRAS;
  return armar("documento_compra", d.id, d.fecha, `Compra #${d.id} (${d.categoria ?? "general"})`, [
    { cuenta: ctaGasto, debe: nz(d.subtotal), haber: 0 },
    { cuenta: CTA.IGV, debe: nz(d.igv), haber: 0 },
    { cuenta: CTA.CXP, debe: 0, haber: nz(d.total) },
  ], d.moneda ?? "PEN");
}

/** COBRO: Banco/Caja a CxC. */
export function asientoCobro(p: { id: number; fecha: string; monto: number; enBanco?: boolean; moneda?: Moneda }): Asiento {
  return armar("pago", p.id, p.fecha, `Cobro #${p.id}`, [
    { cuenta: p.enBanco === false ? CTA.CAJA : CTA.BANCOS, debe: nz(p.monto), haber: 0 },
    { cuenta: CTA.CXC_FACTURAS, debe: 0, haber: nz(p.monto) },
  ], p.moneda ?? "PEN");
}

/** PAGO a proveedor: CxP a Banco/Caja. */
export function asientoPago(p: { id: number; fecha: string; monto: number; enBanco?: boolean; moneda?: Moneda }): Asiento {
  return armar("pago", p.id, p.fecha, `Pago #${p.id}`, [
    { cuenta: CTA.CXP, debe: nz(p.monto), haber: 0 },
    { cuenta: p.enBanco === false ? CTA.CAJA : CTA.BANCOS, debe: 0, haber: nz(p.monto) },
  ], p.moneda ?? "PEN");
}

/** DEPRECIACIÓN mensual: gasto a depreciación acumulada. */
export function asientoDepreciacion(x: { id: number; fecha: string; monto: number; vehiculo_id?: number | null }): Asiento {
  return armar("depreciacion", x.id, x.fecha, `Depreciación periodo #${x.id}`, [
    { cuenta: CTA.DEPREC_GASTO, debe: nz(x.monto), haber: 0, vehiculo_id: x.vehiculo_id ?? null },
    { cuenta: CTA.DEPREC_ACUM, debe: 0, haber: nz(x.monto) },
  ]);
}

// ── Persistencia ────────────────────────────────────────────────────────────

/**
 * Guarda un asiento (cabecera + detalle) si cuadra. Idempotente por documento origen:
 * si ya existe un asiento 'asentado' para (origen_tipo, origen_id), no duplica.
 */
export async function guardarAsiento(sb: any, a: Asiento): Promise<{ ok: boolean; id?: number; error?: string; yaExistia?: boolean }> {
  try {
    if (!cuadra(a)) throw new Error(`El asiento no cuadra: debe ${a.total_debe} ≠ haber ${a.total_haber}`);

    if (a.origen_tipo && a.origen_id) {
      const { data: prev } = await sb
        .from("asiento")
        .select("id")
        .eq("origen_tipo", a.origen_tipo)
        .eq("origen_id", a.origen_id)
        .neq("estado", "anulado")
        .maybeSingle();
      if (prev?.id) return { ok: true, id: Number(prev.id), yaExistia: true };
    }

    const { data: cab, error } = await sb
      .from("asiento")
      .insert({
        fecha: a.fecha,
        glosa: a.glosa,
        origen_tipo: a.origen_tipo,
        origen_id: a.origen_id,
        moneda: a.moneda,
        total_debe: a.total_debe,
        total_haber: a.total_haber,
        estado: "asentado",
      })
      .select("id")
      .single();
    if (error) throw new Error(`asiento: ${error.message}`);
    const id = Number((cab as any).id);

    const filas = a.lineas.map((l) => ({
      asiento_id: id,
      cuenta: l.cuenta,
      debe: l.debe,
      haber: l.haber,
      glosa: l.glosa ?? null,
      vehiculo_id: l.vehiculo_id ?? null,
      cliente_id: l.cliente_id ?? null,
      reserva_id: l.reserva_id ?? null,
    }));
    const { error: e2 } = await sb.from("asiento_detalle").insert(filas);
    if (e2) throw new Error(`asiento_detalle: ${e2.message}`);

    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
