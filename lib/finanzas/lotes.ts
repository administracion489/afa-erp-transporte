// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/lotes.ts — Lotes de pago (la "aprobación masiva" del Plan Maestro).
//
// Un lote agrupa N obligaciones aprobadas en un solo archivo de abono para el banco.
// El ciclo:
//
//   borrador ──aprobar(gerencia)──▶ aprobado ──descargar archivo──▶ enviado_banco
//                                                                        │
//                                              confirmar con el extracto ▼
//                                                                     pagado
//
// Al confirmar el pago se emite UN `pago` por línea con su aplicación al comprobante
// correspondiente, de modo que el saldo de cada CxP se sigue derivando de
// pagos_aplicacion (regla de la fase 01) y no de un flag puesto a mano.
//
// Los datos bancarios se COPIAN al armar el lote: si el proveedor cambia de cuenta
// después, el lote conserva la cuenta con la que realmente se pagó.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear } from "@/lib/finanzas/dinero";
import { registrarPago } from "@/lib/finanzas/pagos";
import type { FilaAbono } from "@/lib/finanzas/exportar";

export type EstadoLote = "borrador" | "aprobado" | "enviado_banco" | "pagado" | "anulado";

export const ESTADOS_LOTE: Record<EstadoLote, { label: string; descripcion: string; bg: string; color: string }> = {
  borrador:      { label: "Borrador",      descripcion: "Armando la selección",              bg: "#f3f4f6", color: "#4b5563" },
  aprobado:      { label: "Aprobado",      descripcion: "Visado por gerencia",               bg: "#dbeafe", color: "#1d4ed8" },
  enviado_banco: { label: "En Telecrédito", descripcion: "Archivo cargado en el banco",      bg: "#fef9c3", color: "#854d0e" },
  pagado:        { label: "Pagado",        descripcion: "Confirmado contra el extracto",     bg: "#dcfce7", color: "#166534" },
  anulado:       { label: "Anulado",       descripcion: "Sin efecto",                        bg: "#fee2e2", color: "#991b1b" },
};

export type TipoDocumentoLote = "documento_compra" | "gasto_general" | "caja_chica_rendicion" | "detraccion" | "otro";

export type ItemLote = {
  id: number;
  lote_id: number;
  documento_tipo: TipoDocumentoLote;
  documento_id: number | null;
  beneficiario: string;
  documento_identidad: string | null;
  banco: string | null;
  cuenta_destino: string | null;
  cci_destino: string | null;
  monto: number;
  moneda: string;
  referencia: string | null;
  estado: "pendiente" | "pagado" | "rechazado";
  nro_operacion: string | null;
  fecha_pago: string | null;
  pago_id: number | null;
  motivo_rechazo: string | null;
};

export type Lote = {
  id: number;
  codigo: string | null;
  fecha: string;
  fecha_programada: string | null;
  cuenta_tesoreria_id: number | null;
  banco: string;
  moneda: string;
  estado: EstadoLote;
  total: number;
  items: number;
  archivo_url: string | null;
  aprobado_por: string | null;
  fecha_aprobacion: string | null;
  observaciones: string | null;
};

export type Resultado<T = void> = { ok: true; data: T } | { ok: false; error: string };

function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── Candidatos: qué se puede meter a un lote ──────────────────────────────────

export type Pagable = {
  documento_tipo: TipoDocumentoLote;
  documento_id: number;
  beneficiario: string;
  documento_identidad: string | null;
  banco: string | null;
  cuenta_destino: string | null;
  cci_destino: string | null;
  /** Lo que falta pagar (saldo), no el total del comprobante. */
  monto: number;
  moneda: string;
  referencia: string | null;
  fecha_vencimiento: string | null;
  /** Motivos por los que no se debería incluir todavía (cuenta faltante, etc.). */
  advertencias: string[];
};

/**
 * Lista lo que está listo para pagarse: CxP aprobadas con saldo, gastos generales
 * aprobados e impagos, y las detracciones pendientes de depósito.
 *
 * Solo entra lo APROBADO: un lote es la materialización de una decisión de gerencia,
 * no una lista de deseos.
 */
export async function candidatosPago(sb: any, opts?: { hasta?: string; incluirDetracciones?: boolean }): Promise<Pagable[]> {
  const hasta = opts?.hasta ?? null;
  const out: Pagable[] = [];

  // 1) Cuentas por pagar aprobadas con saldo pendiente.
  let q = sb
    .from("v_cuentas_por_pagar")
    .select("*")
    .in("estado_aprobacion", ["aprobado_gerencia"])
    .neq("estado_pago", "pagada");
  if (hasta) q = q.lte("fecha_vencimiento", hasta);
  const { data: cxp } = await q;

  for (const d of (cxp as any[]) ?? []) {
    const saldo = redondear(Number(d.monto_a_cancelar ?? 0) - Number(d.pagado ?? 0));
    if (saldo <= 0.01) continue;
    const adv: string[] = [];
    if (!d.cci && !d.numero_cuenta) adv.push("Sin cuenta ni CCI del beneficiario");
    if (!d.proveedor_ruc) adv.push("Sin RUC del proveedor");
    out.push({
      documento_tipo: "documento_compra",
      documento_id: Number(d.id),
      beneficiario: d.titular_cuenta || d.proveedor_razon_social || "—",
      documento_identidad: d.proveedor_ruc ?? null,
      banco: d.banco ?? null,
      cuenta_destino: d.numero_cuenta ?? null,
      cci_destino: d.cci ?? null,
      monto: saldo,
      moneda: d.moneda ?? "PEN",
      referencia: d.numero_factura || d.codigo_servicio || null,
      fecha_vencimiento: d.fecha_vencimiento ?? null,
      advertencias: adv,
    });
  }

  // 2) Planilla y gastos administrativos aprobados.
  let q2 = sb
    .from("gastos_generales")
    .select("id, beneficiario_nombre, documento_identidad, banco_destino, cuenta_destino, cci_destino, monto, moneda, concepto, fecha_vencimiento, codigo")
    .eq("estado_aprobacion", "aprobado")
    .neq("estado_pago", "pagada");
  if (hasta) q2 = q2.lte("fecha_vencimiento", hasta);
  const { data: gg } = await q2;

  for (const g of (gg as any[]) ?? []) {
    const adv: string[] = [];
    if (!g.cci_destino && !g.cuenta_destino) adv.push("Sin cuenta ni CCI del beneficiario");
    out.push({
      documento_tipo: "gasto_general",
      documento_id: Number(g.id),
      beneficiario: g.beneficiario_nombre,
      documento_identidad: g.documento_identidad ?? null,
      banco: g.banco_destino ?? null,
      cuenta_destino: g.cuenta_destino ?? null,
      cci_destino: g.cci_destino ?? null,
      monto: redondear(Number(g.monto ?? 0)),
      moneda: g.moneda ?? "PEN",
      referencia: g.concepto ?? g.codigo ?? null,
      fecha_vencimiento: g.fecha_vencimiento ?? null,
      advertencias: adv,
    });
  }

  // 3) Detracciones pendientes de depósito al Banco de la Nación.
  if (opts?.incluirDetracciones !== false) {
    const { data: det } = await sb
      .from("v_detracciones_pendientes")
      .select("*")
      .eq("lado", "compra");
    for (const d of (det as any[]) ?? []) {
      out.push({
        documento_tipo: "detraccion",
        documento_id: Number(d.origen_id),
        beneficiario: `Banco de la Nación · detracción ${d.contraparte ?? ""}`.trim(),
        documento_identidad: d.ruc ?? null,
        banco: "Banco de la Nación",
        cuenta_destino: null,
        cci_destino: null,
        monto: redondear(Number(d.detraccion_monto ?? 0)),
        moneda: "PEN",
        referencia: `${d.comprobante ?? ""} · cód. ${d.detraccion_codigo ?? "—"}`.trim(),
        fecha_vencimiento: null,
        advertencias: ["Se deposita en la cuenta de detracciones del proveedor en el BN"],
      });
    }
  }

  return out.filter((p) => p.monto > 0.01);
}

// ── Armado del lote ───────────────────────────────────────────────────────────

export async function crearLote(
  sb: any,
  args: { seleccion: Pagable[]; fecha?: string; fecha_programada?: string | null; cuenta_tesoreria_id?: number | null; banco?: string; observaciones?: string | null; creado_por?: string | null }
): Promise<Resultado<{ id: number; codigo: string | null; total: number }>> {
  try {
    const sel = args.seleccion.filter((p) => p.monto > 0.01);
    if (!sel.length) return { ok: false, error: "No hay nada seleccionado para el lote." };

    const monedas = new Set(sel.map((p) => p.moneda));
    if (monedas.size > 1) {
      return { ok: false, error: "Un lote no puede mezclar monedas. Arma un lote por moneda." };
    }

    const { data: lote, error } = await sb
      .from("lotes_pago")
      .insert({
        fecha: args.fecha || hoyLima(),
        fecha_programada: args.fecha_programada ?? null,
        cuenta_tesoreria_id: args.cuenta_tesoreria_id ?? null,
        banco: args.banco ?? "BCP",
        moneda: sel[0].moneda,
        estado: "borrador",
        observaciones: args.observaciones ?? null,
        creado_por: args.creado_por ?? null,
      })
      .select("id, codigo")
      .single();
    if (error) return { ok: false, error: error.message };

    const filas = sel.map((p) => ({
      lote_id: lote.id,
      documento_tipo: p.documento_tipo,
      documento_id: p.documento_id,
      beneficiario: p.beneficiario,
      documento_identidad: p.documento_identidad,
      banco: p.banco,
      cuenta_destino: p.cuenta_destino,
      cci_destino: p.cci_destino,
      monto: redondear(p.monto),
      moneda: p.moneda,
      referencia: p.referencia,
      estado: "pendiente",
    }));

    const { error: e2 } = await sb.from("lotes_pago_items").insert(filas);
    if (e2) {
      await sb.from("lotes_pago").delete().eq("id", lote.id);
      if (/uq_lote_items_doc/.test(e2.message ?? "")) {
        return { ok: false, error: "Hay documentos repetidos en la selección." };
      }
      return { ok: false, error: e2.message };
    }

    // Marcar las CxP como incluidas en lote, para que no entren a otro lote a la vez.
    const idsCompra = sel.filter((p) => p.documento_tipo === "documento_compra").map((p) => p.documento_id);
    if (idsCompra.length) {
      await sb.from("documentos_compra").update({ estado_aprobacion: "incluido_lote" }).in("id", idsCompra);
    }

    const total = redondear(sel.reduce((s, p) => s + p.monto, 0));
    return { ok: true, data: { id: Number(lote.id), codigo: lote.codigo ?? null, total } };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Visto bueno de gerencia. A partir de aquí el lote ya no se edita. */
export async function aprobarLote(sb: any, loteId: number, aprobadoPor: string): Promise<Resultado> {
  const { data: l } = await sb.from("lotes_pago").select("id, estado, items").eq("id", loteId).maybeSingle();
  if (!l) return { ok: false, error: "El lote no existe." };
  if (l.estado !== "borrador") return { ok: false, error: `El lote ya está en estado "${ESTADOS_LOTE[l.estado as EstadoLote]?.label ?? l.estado}".` };
  if (!Number(l.items)) return { ok: false, error: "El lote no tiene líneas." };

  const { error } = await sb
    .from("lotes_pago")
    .update({ estado: "aprobado", aprobado_por: aprobadoPor, fecha_aprobacion: new Date().toISOString() })
    .eq("id", loteId);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

/** Convierte las líneas del lote en el formato de abono del banco. */
export function itemsAAbonos(items: ItemLote[]): FilaAbono[] {
  return items
    .filter((i) => i.estado !== "rechazado")
    .map((i) => ({
      beneficiario: i.beneficiario,
      documento_identidad: i.documento_identidad,
      banco: i.banco,
      cuenta_destino: i.cuenta_destino,
      cci_destino: i.cci_destino,
      monto: redondear(Number(i.monto)),
      moneda: i.moneda,
      referencia: i.referencia,
    }));
}

/** Marca que el archivo ya se cargó en Telecrédito (queda a la espera del extracto). */
export async function marcarEnviadoAlBanco(sb: any, loteId: number, archivoUrl?: string | null): Promise<Resultado> {
  const { error } = await sb
    .from("lotes_pago")
    .update({ estado: "enviado_banco", archivo_url: archivoUrl ?? null })
    .eq("id", loteId)
    .in("estado", ["aprobado", "enviado_banco"]);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

export type ConfirmarPagoLoteArgs = {
  lote_id: number;
  fecha_pago?: string;
  /** Nº de operación del cargo único que el banco hizo por el total del lote. */
  nro_operacion?: string | null;
  cuenta_tesoreria_id?: number | null;
  creado_por?: string | null;
  /** Ítems que el banco rechazó (cuenta inválida, etc.): no generan pago. */
  rechazados?: { item_id: number; motivo: string }[];
};

/**
 * Confirma que el banco ejecutó el lote. Emite UN pago por línea con su aplicación
 * al comprobante, de modo que el saldo de cada CxP se sigue derivando de
 * pagos_aplicacion — no se toca `estado_pago` a mano en ningún lado.
 */
export async function confirmarPagoLote(sb: any, a: ConfirmarPagoLoteArgs): Promise<Resultado<{ pagados: number; rechazados: number; errores: string[] }>> {
  try {
    const { data: lote } = await sb.from("lotes_pago").select("*").eq("id", a.lote_id).maybeSingle();
    if (!lote) return { ok: false, error: "El lote no existe." };
    if (lote.estado === "pagado") return { ok: false, error: "El lote ya está confirmado." };
    if (lote.estado === "anulado") return { ok: false, error: "El lote está anulado." };

    const fecha = a.fecha_pago || hoyLima();
    const cuenta = a.cuenta_tesoreria_id ?? lote.cuenta_tesoreria_id ?? null;
    const rechazadosMap = new Map((a.rechazados ?? []).map((r) => [r.item_id, r.motivo]));

    const { data: items } = await sb.from("lotes_pago_items").select("*").eq("lote_id", a.lote_id);
    const errores: string[] = [];
    let pagados = 0;
    let rechazados = 0;

    for (const it of (items as ItemLote[]) ?? []) {
      if (it.estado === "pagado") continue;

      if (rechazadosMap.has(it.id)) {
        await sb.from("lotes_pago_items")
          .update({ estado: "rechazado", motivo_rechazo: rechazadosMap.get(it.id) })
          .eq("id", it.id);
        rechazados++;
        continue;
      }

      // Solo `documento_compra` tiene aplicación de pago; los demás orígenes llevan
      // su propio estado y se marcan abajo.
      const aplicaciones =
        it.documento_tipo === "documento_compra" && it.documento_id
          ? [{ documento_tipo: "documento_compra" as const, documento_id: it.documento_id, monto_aplicado: redondear(Number(it.monto)) }]
          : [];

      const res = await registrarPago(sb, {
        sentido: "pago",
        cuenta_tesoreria_id: cuenta,
        fecha,
        monto: redondear(Number(it.monto)),
        moneda: it.moneda,
        metodo: it.documento_tipo === "detraccion" ? "detraccion" : "transferencia",
        contraparte_tipo: "proveedor",
        contraparte_id: null,
        referencia: it.nro_operacion ?? a.nro_operacion ?? lote.codigo ?? null,
        observaciones: `Lote ${lote.codigo ?? a.lote_id} · ${it.beneficiario}`,
        creado_por: a.creado_por ?? null,
        aplicaciones,
      });

      if (!res.ok) {
        errores.push(`${it.beneficiario}: ${res.error}`);
        continue;
      }

      await sb.from("lotes_pago_items")
        .update({ estado: "pagado", pago_id: res.pago_id, fecha_pago: fecha, nro_operacion: it.nro_operacion ?? a.nro_operacion ?? null })
        .eq("id", it.id);

      // Reflejo en el origen que no pasa por pagos_aplicacion.
      if (it.documento_tipo === "gasto_general" && it.documento_id) {
        await sb.from("gastos_generales")
          .update({ estado_pago: "pagada", fecha_pago: fecha, nro_operacion_bancaria: it.nro_operacion ?? a.nro_operacion ?? null })
          .eq("id", it.documento_id);
      }
      if (it.documento_tipo === "detraccion" && it.documento_id) {
        await sb.from("documentos_compra")
          .update({ estado_detraccion: "pagada", detraccion_fecha_pago: fecha, detraccion_constancia: it.nro_operacion ?? a.nro_operacion ?? null })
          .eq("id", it.documento_id);
      }
      if (it.documento_tipo === "documento_compra" && it.documento_id) {
        await sb.from("documentos_compra")
          .update({ nro_operacion_bancaria: it.nro_operacion ?? a.nro_operacion ?? null, fecha_pago: fecha })
          .eq("id", it.documento_id);
      }
      pagados++;
    }

    await sb.from("lotes_pago").update({ estado: "pagado" }).eq("id", a.lote_id);
    return { ok: true, data: { pagados, rechazados, errores } };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Devuelve las CxP del lote a "aprobado_gerencia" y anula el lote. */
export async function anularLote(sb: any, loteId: number): Promise<Resultado> {
  const { data: lote } = await sb.from("lotes_pago").select("estado").eq("id", loteId).maybeSingle();
  if (!lote) return { ok: false, error: "El lote no existe." };
  if (lote.estado === "pagado") return { ok: false, error: "No se puede anular un lote ya pagado." };

  const { data: items } = await sb
    .from("lotes_pago_items")
    .select("documento_tipo, documento_id")
    .eq("lote_id", loteId)
    .eq("documento_tipo", "documento_compra");

  const ids = ((items as any[]) ?? []).map((i) => i.documento_id).filter(Boolean);
  if (ids.length) {
    await sb.from("documentos_compra").update({ estado_aprobacion: "aprobado_gerencia" }).in("id", ids);
  }

  const { error } = await sb.from("lotes_pago").update({ estado: "anulado" }).eq("id", loteId);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}
