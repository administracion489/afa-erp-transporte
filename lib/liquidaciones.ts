// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidaciones.ts — Dominio de LIQUIDACIONES (Cliente y Proveedor).
//
// Dos procesos independientes entre Operaciones y Finanzas (ver diseño):
//
//   Liquidación al CLIENTE   → confirma el importe DEFINITIVO a facturar y, al
//                              aprobarse, emite una `factura` (venta) y avanza la
//                              dimensión B de las reservas incluidas.
//   Liquidación al PROVEEDOR → solo tercerizados. Al aprobarse genera una Cuenta por
//                              Pagar (`documentos_compra`) y avanza la dimensión C.
//
// Regla anti-duplicación: los montos de las líneas se calculan aquí y se guardan como
// SNAPSHOT en las tablas de liquidación; la factura/CxP se DERIVA de ese snapshot. El
// dinero entra a contabilidad una sola vez (a nivel comprobante).
//
// `sb` es el cliente Supabase (browser anon o service-role); tipado `any` como en el
// resto del ERP. Estas funciones NO asumen sesión: el gate real es permisos_usuario.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, desdeNeto, desdeTotal, calcularDetraccion } from "@/lib/finanzas/dinero";
import type {
  LiquidacionClienteDetalle,
  LiquidacionProveedorDetalle,
} from "@/lib/finanzas/tipos";

// ── Cálculo puro de líneas y totales ────────────────────────────────────────

/** subtotal de una línea de liquidación al cliente. */
export function subtotalLineaCliente(l: Partial<LiquidacionClienteDetalle>): number {
  return redondear(
    Number(l.tarifa ?? 0) +
      Number(l.horas_adicionales ?? 0) +
      Number(l.espera ?? 0) +
      Number(l.km_adicionales ?? 0) +
      Number(l.peajes ?? 0) +
      Number(l.otros_adicionales ?? 0) -
      Number(l.descuento ?? 0)
  );
}

/** subtotal de una línea de liquidación al proveedor. */
export function subtotalLineaProveedor(l: Partial<LiquidacionProveedorDetalle>): number {
  return redondear(
    Number(l.tarifa_acordada ?? 0) +
      Number(l.adicionales ?? 0) -
      Number(l.penalidad ?? 0) -
      Number(l.descuento ?? 0)
  );
}

export type TotalesCliente = { subtotal: number; igv: number; total: number };

/** Totales de la liquidación al cliente. igvPct viene de config_tributaria. */
export function totalesCliente(
  lineas: Partial<LiquidacionClienteDetalle>[],
  igvPct: number
): TotalesCliente {
  const subtotal = redondear(lineas.reduce((a, l) => a + subtotalLineaCliente(l), 0));
  const d = desdeNeto(subtotal, igvPct);
  return { subtotal: d.base, igv: d.igv, total: d.total };
}

export type TotalesProveedor = {
  subtotal: number;
  igv: number;
  detraccion_monto: number;
  anticipos: number;
  total: number; // neto a pagar
};

/**
 * Totales de la liquidación al proveedor. La detracción se calcula sobre el total con
 * IGV usando el catálogo (cat_detraccion); los anticipos ya aplicados se restan.
 */
export function totalesProveedor(
  lineas: Partial<LiquidacionProveedorDetalle>[],
  opts: {
    igvPct: number;
    detraccion?: { porcentaje: number; umbral_min?: number; codigo?: string | null; activa?: boolean };
    anticipos?: number;
  }
): TotalesProveedor {
  const subtotal = redondear(lineas.reduce((a, l) => a + subtotalLineaProveedor(l), 0));
  const d = desdeNeto(subtotal, opts.igvPct);
  const det = opts.detraccion
    ? calcularDetraccion(d.total, opts.detraccion)
    : { monto: 0 };
  const anticipos = redondear(opts.anticipos ?? 0);
  const total = redondear(d.total - det.monto - anticipos);
  return {
    subtotal: d.base,
    igv: d.igv,
    detraccion_monto: det.monto,
    anticipos,
    total: Math.max(0, total),
  };
}

// ── Persistencia: crear una liquidación en borrador ─────────────────────────

/** Lee el IGV vigente de config_tributaria (fallback 18). */
export async function igvVigente(sb: any): Promise<number> {
  try {
    const { data } = await sb.from("config_tributaria").select("igv_pct").eq("id", 1).maybeSingle();
    const v = Number(data?.igv_pct);
    return Number.isFinite(v) && v > 0 ? v : 18;
  } catch {
    return 18;
  }
}

/**
 * Crea una liquidación al cliente (borrador) a partir de reservas "por_liquidar".
 * Precarga cada línea con la tarifa = reservas.precio_cliente; los adicionales/
 * esperas/descuentos los ajusta el operador antes de aprobar.
 */
export async function crearLiquidacionCliente(
  sb: any,
  args: { cliente_id: number | null; periodo?: string | null; reservas: { id: number; precio_cliente?: number | null }[] }
): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const igvPct = await igvVigente(sb);
    // CONVENCIÓN DEL ERP: reservas.precio_cliente es BRUTO (incluye IGV) — igual que
    // app/facturacion (precio_cliente / 1.18). Sembramos la línea con la BASE neta para
    // que totalesCliente reconstruya el MISMO total que /facturacion (sin inflar un IGV).
    const lineas: Partial<LiquidacionClienteDetalle>[] = args.reservas.map((r) => {
      const tarifaNeta = desdeTotal(Number(r.precio_cliente ?? 0), igvPct).base;
      return {
        reserva_id: r.id,
        tarifa: tarifaNeta,
        horas_adicionales: 0, espera: 0, km_adicionales: 0, peajes: 0, otros_adicionales: 0, descuento: 0,
        subtotal_linea: redondear(tarifaNeta),
        concepto: null,
      };
    });
    const tot = totalesCliente(lineas, igvPct);

    const { data: cab, error } = await sb
      .from("liquidacion_cliente")
      .insert({
        cliente_id: args.cliente_id,
        periodo: args.periodo ?? null,
        estado: "borrador",
        subtotal: tot.subtotal, igv: tot.igv, total: tot.total,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = Number((cab as any).id);

    const filas = lineas.map((l) => ({ ...l, liquidacion_id: id, subtotal_linea: subtotalLineaCliente(l) }));
    const { error: e2 } = await sb.from("liquidacion_cliente_detalle").insert(filas);
    if (e2) throw new Error(e2.message);

    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Crea una liquidación al proveedor (borrador) a partir de reservas tercerizadas. */
export async function crearLiquidacionProveedor(
  sb: any,
  args: {
    empresa_tercerizada_id: number | null;
    proveedor_id?: number | null;
    periodo?: string | null;
    reservas: { id: number; costo_proveedor?: number | null }[];
    detraccion?: { porcentaje: number; umbral_min?: number; codigo?: string | null; activa?: boolean };
  }
): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const igvPct = await igvVigente(sb);
    // Se asume que reservas.costo_proveedor es BRUTO (con IGV), simétrico a precio_cliente.
    // ⚠️ CONFIRMAR la convención de costo_proveedor en /programacion y /tercerizadas: si
    // resultara NETO, quitar el desdeTotal y usar el valor directo.
    const lineas: Partial<LiquidacionProveedorDetalle>[] = args.reservas.map((r) => {
      const tarifaNeta = desdeTotal(Number(r.costo_proveedor ?? 0), igvPct).base;
      return {
        reserva_id: r.id,
        oc_id: null,
        tarifa_acordada: tarifaNeta,
        adicionales: 0, penalidad: 0, descuento: 0,
        subtotal_linea: redondear(tarifaNeta),
        concepto: null,
      };
    });
    const tot = totalesProveedor(lineas, { igvPct, detraccion: args.detraccion, anticipos: 0 });

    const { data: cab, error } = await sb
      .from("liquidacion_proveedor")
      .insert({
        empresa_tercerizada_id: args.empresa_tercerizada_id,
        proveedor_id: args.proveedor_id ?? null,
        periodo: args.periodo ?? null,
        estado: "borrador",
        subtotal: tot.subtotal, igv: tot.igv,
        detraccion_pct: args.detraccion?.porcentaje ?? null,
        detraccion_monto: tot.detraccion_monto,
        anticipos: tot.anticipos, total: tot.total,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = Number((cab as any).id);

    const filas = lineas.map((l) => ({ ...l, liquidacion_id: id, subtotal_linea: subtotalLineaProveedor(l) }));
    const { error: e2 } = await sb.from("liquidacion_proveedor_detalle").insert(filas);
    if (e2) throw new Error(e2.message);

    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Aprobación (dispara la emisión aguas abajo) ─────────────────────────────

/**
 * Aprueba la liquidación al cliente → emite una `factura` con el total consolidado y
 * marca las reservas incluidas como estado_admin='facturada'. Devuelve el factura_id.
 * NOTA: no fija serie/número aquí (eso lo hace fn_siguiente_comprobante al emitir el
 * comprobante formal); crea la factura en estado 'emitida' lista para numerar/enviar.
 */
export async function aprobarLiquidacionCliente(
  sb: any,
  liquidacionId: number,
  usuario?: string
): Promise<{ ok: boolean; factura_id?: number; error?: string }> {
  try {
    // CLAIM ATÓMICO: un único UPDATE condicional serializa a nivel de fila — solo una de
    // N ejecuciones concurrentes (doble clic, retry, dos operadores) gana la transición;
    // las demás no matchean y abortan SIN emitir un segundo comprobante ("el dinero entra
    // una sola vez"). Marca el estado ANTES de emitir; si el insert falla, la liquidación
    // queda "facturada" sin factura_id (recuperable, NO duplica dinero — lado seguro).
    const { data: liq, error } = await sb
      .from("liquidacion_cliente")
      .update({ estado: "facturada", aprobada_por: usuario ?? null, fecha_aprobacion: new Date().toISOString() })
      .eq("id", liquidacionId)
      .in("estado", ["borrador", "aprobada"])
      .select("id, cliente_id, moneda, subtotal, igv, total")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!liq) throw new Error("La liquidación ya fue facturada o no está en un estado facturable.");

    const { data: det } = await sb
      .from("liquidacion_cliente_detalle")
      .select("reserva_id, subtotal_linea, concepto")
      .eq("liquidacion_id", liquidacionId);
    const lineas = (det as any[]) ?? [];
    const reservaIds = lineas.map((l) => l.reserva_id).filter((x) => x != null);

    // items_json espejo del formato que ya usa app/facturacion (descripcion/cantidad/precio_unit/total)
    const itemsJson = lineas.map((l) => ({
      descripcion: l.concepto ?? `Servicio ${l.reserva_id ?? ""}`.trim(),
      cantidad: 1,
      precio_unit: Number(l.subtotal_linea ?? 0),
      total: Number(l.subtotal_linea ?? 0),
    }));

    const { data: fac, error: eFac } = await sb
      .from("facturas")
      .insert({
        cliente_id: liq.cliente_id,
        reserva_id: reservaIds.length === 1 ? reservaIds[0] : null, // consolidada: sin reserva única
        tipo_comprobante: "factura",
        fecha_emision: new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10),
        moneda: liq.moneda ?? "PEN",
        subtotal: Number(liq.subtotal ?? 0),
        igv: Number(liq.igv ?? 0),
        estado: "emitida",
        items_json: itemsJson,
        observaciones: `Liquidación consolidada #${liquidacionId}`,
      })
      .select("id")
      .single();
    if (eFac) throw new Error(`facturas: ${eFac.message}`);
    const facturaId = Number((fac as any).id);

    // El estado y la auditoría ya se fijaron en el claim; aquí solo se enlaza el comprobante.
    await sb.from("liquidacion_cliente").update({ factura_id: facturaId }).eq("id", liquidacionId);

    // Avanzar la dimensión B de las reservas incluidas (facturada + auditoría).
    if (reservaIds.length) {
      await sb
        .from("reservas")
        .update({ estado_admin: "facturada", liquidacion_cliente_id: liquidacionId, fecha_facturacion: new Date().toISOString() })
        .in("id", reservaIds);
    }

    return { ok: true, factura_id: facturaId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Aprueba la liquidación al proveedor → genera una Cuenta por Pagar (documentos_compra)
 * por el total, la enlaza a la liquidación y avanza la dimensión C de las reservas.
 */
export async function aprobarLiquidacionProveedor(
  sb: any,
  liquidacionId: number,
  usuario?: string
): Promise<{ ok: boolean; documento_compra_id?: number; error?: string }> {
  try {
    // CLAIM ATÓMICO (ver aprobarLiquidacionCliente): evita generar dos CxP para la misma
    // liquidación bajo concurrencia. Marca por_pagar antes de emitir el documento_compra.
    const { data: liq, error } = await sb
      .from("liquidacion_proveedor")
      .update({ estado: "por_pagar", aprobada_por: usuario ?? null, fecha_aprobacion: new Date().toISOString() })
      .eq("id", liquidacionId)
      .in("estado", ["borrador", "aprobada"])
      .select("id, empresa_tercerizada_id, proveedor_id, moneda, subtotal, igv, detraccion_pct, detraccion_monto, total")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!liq) throw new Error("La liquidación ya fue aprobada o no está en un estado aprobable.");

    const { data: det } = await sb
      .from("liquidacion_proveedor_detalle")
      .select("reserva_id")
      .eq("liquidacion_id", liquidacionId);
    const reservaIds = ((det as any[]) ?? []).map((l) => l.reserva_id).filter((x) => x != null);

    // Cuenta por Pagar (comprobante de compra pendiente de la factura real del tercero).
    const { data: doc, error: eDoc } = await sb
      .from("documentos_compra")
      .insert({
        proveedor_id: liq.proveedor_id ?? null,
        tipo_comprobante: "liquidacion",
        categoria: "tercero",
        moneda: liq.moneda ?? "PEN",
        subtotal: Number(liq.subtotal ?? 0),
        igv: Number(liq.igv ?? 0),
        detraccion_pct: liq.detraccion_pct,
        detraccion_monto: Number(liq.detraccion_monto ?? 0),
        // documentos_compra.total es el BRUTO del comprobante (subtotal + IGV), NO el neto
        // a pagar. Así el asiento cuadra (debe subtotal+IGV = haber total) y el Registro de
        // Compras/IGV no queda subvaluado. La detracción y los anticipos se manejan como
        // mecanismos de PAGO (pagos_aplicacion), no restándolos del total del comprobante.
        total: redondear(Number(liq.subtotal ?? 0) + Number(liq.igv ?? 0)),
        estado_conciliacion: "pendiente",
        origen: "liquidacion",
        liquidacion_proveedor_id: liquidacionId,
        empresa_tercerizada_id: liq.empresa_tercerizada_id,
        observaciones: `Cuenta por pagar de la liquidación al proveedor #${liquidacionId}`,
      })
      .select("id")
      .single();
    if (eDoc) throw new Error(`documentos_compra: ${eDoc.message}`);
    const docId = Number((doc as any).id);

    // Estado/auditoría ya fijados en el claim; solo se enlaza la CxP generada.
    await sb.from("liquidacion_proveedor").update({ documento_compra_id: docId }).eq("id", liquidacionId);

    if (reservaIds.length) {
      await sb
        .from("reservas")
        .update({ estado_proveedor: "por_pagar", liquidacion_proveedor_id: liquidacionId })
        .in("id", reservaIds);
    }

    return { ok: true, documento_compra_id: docId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
