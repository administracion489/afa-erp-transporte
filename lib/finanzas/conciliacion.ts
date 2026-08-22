// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/conciliacion.ts — Conciliación bancaria y "Regla Cero Fugas".
//
// El problema que resuelve: hoy nadie sabe si un cargo del BCP corresponde a algo
// registrado en el ERP. Este módulo importa el extracto y lo CASA contra lo que el
// ERP sí conoce (pagos, facturas de compra, gastos generales, lotes de pago).
//
// Estrategia de casado, de más fuerte a más débil — cada nivel se marca con su
// CONFIANZA para que la UI no presente una coincidencia dudosa como si fuera exacta:
//
//   1. Nº de operación exacto  → confianza 1.00  (el banco y el ERP citan el mismo nº)
//   2. Monto + fecha exacta    → confianza 0.85  (único candidato con ese importe)
//   3. Monto + fecha ±3 días   → confianza 0.65  (el banco asienta con desfase)
//   4. Nada                    → NO_IDENTIFICADO = fuga potencial
//
// Solo el nivel 1 se auto-concilia. Los niveles 2 y 3 se PROPONEN y un humano
// confirma: dar por bueno un match por importe puede cerrar la factura equivocada
// cuando hay dos servicios del mismo precio el mismo día — que en transporte es la
// norma, no la excepción.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear } from "@/lib/finanzas/dinero";
import type { FilaExtracto } from "@/lib/importador/perfiles-finanzas";

export type EstadoConciliacionBancaria = "conciliado" | "no_identificado" | "observado" | "ignorado";

export type MovimientoExtracto = {
  id: number;
  extracto_id: number | null;
  cuenta_tesoreria_id: number | null;
  fecha_movimiento: string;
  fecha_valuta: string | null;
  nro_operacion: string | null;
  descripcion_banco: string | null;
  monto_cargo: number;
  monto_abono: number;
  saldo: number | null;
  moneda: string;
  estado_conciliacion: EstadoConciliacionBancaria;
  documento_tipo: string | null;
  documento_id: number | null;
  pago_id: number | null;
  conciliado_por: string | null;
  fecha_conciliacion: string | null;
  observaciones: string | null;
  hash_fila: string;
};

export type ConfigEstadoBanco = { label: string; descripcion: string; bg: string; color: string };

export const ESTADOS_BANCO: Record<EstadoConciliacionBancaria, ConfigEstadoBanco> = {
  conciliado:      { label: "Conciliado",      descripcion: "Casa con un registro del ERP",       bg: "#dcfce7", color: "#166534" },
  no_identificado: { label: "No identificado", descripcion: "Salida sin respaldo en el ERP",      bg: "#fee2e2", color: "#991b1b" },
  observado:       { label: "Observado",       descripcion: "Coincidencia dudosa, revisar",       bg: "#fef9c3", color: "#854d0e" },
  ignorado:        { label: "Ignorado",        descripcion: "Comisión/ITF que no requiere cruce", bg: "#f3f4f6", color: "#4b5563" },
};

// ── Hash de fila (idempotencia de la importación) ─────────────────────────────

/**
 * Identidad de un movimiento bancario. Se usa como clave única para que re-subir el
 * mismo extracto (o un rango solapado, que es lo normal cuando se descarga "último
 * mes" cada semana) NO duplique filas.
 *
 * Se incluye la cuenta porque el mismo nº de operación puede repetirse entre cuentas.
 * Es un hash síncrono y determinista (djb2 en hex): no necesita WebCrypto, así que
 * funciona igual en el navegador y en el servidor.
 */
export function hashMovimiento(cuentaId: number | null, m: FilaExtracto): string {
  const base = [
    cuentaId ?? 0,
    m.fecha_movimiento,
    (m.nro_operacion ?? "").trim().toUpperCase(),
    redondear(m.monto_cargo).toFixed(2),
    redondear(m.monto_abono).toFixed(2),
    (m.descripcion_banco ?? "").trim().toUpperCase().slice(0, 80),
  ].join("|");

  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 31) ^ c;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${base.length.toString(16)}`;
}

// ── Candidatos de casado ──────────────────────────────────────────────────────

export type TipoDocumentoBanco = "documento_compra" | "gasto_general" | "caja_chica_rendicion" | "factura" | "lote_pago" | "otro";

export type Candidato = {
  documento_tipo: TipoDocumentoBanco;
  documento_id: number;
  pago_id: number | null;
  etiqueta: string;
  monto: number;
  fecha: string;
  nro_operacion: string | null;
  confianza: number;
  motivo: string;
};

/** Universo contra el que se concilia, cargado una sola vez por corrida. */
export type UniversoConciliacion = {
  pagos: { id: number; fecha: string; monto: number; referencia: string | null; sentido: string; observaciones: string | null }[];
  compras: { id: number; fecha_pago: string | null; fecha_emision: string; total: number; nro_operacion_bancaria: string | null; razon_social: string | null; serie: string | null; numero: string | null }[];
  generales: { id: number; fecha_pago: string | null; fecha: string; monto: number; nro_operacion_bancaria: string | null; beneficiario_nombre: string; concepto: string }[];
  lotes: { id: number; codigo: string | null; fecha: string; total: number }[];
};

const DIA = 86400000;

function difDias(a: string, b: string): number {
  const t1 = new Date(`${a}T00:00:00Z`).getTime();
  const t2 = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 9999;
  return Math.abs(Math.round((t1 - t2) / DIA));
}

function mismoNumero(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = String(a ?? "").replace(/\D/g, "");
  const nb = String(b ?? "").replace(/\D/g, "");
  // Se exige al menos 4 dígitos: un "1" contra un "1" no es una coincidencia.
  return na.length >= 4 && na === nb;
}

function mismoMonto(a: number, b: number): boolean {
  return Math.abs(redondear(a) - redondear(b)) < 0.01;
}

/**
 * Palabras que identifican movimientos que NO tienen contrapartida en el ERP y no
 * deben contarse como fuga: comisiones, ITF, portes y mantenimiento de cuenta.
 */
const PATRON_IGNORABLE =
  /\b(itf|comision|comisión|portes|mantenimiento de cuenta|manten\.?\s*cta|impuesto a las transacciones|cargo por servicio)\b/i;

export function esMovimientoIgnorable(descripcion: string | null | undefined): boolean {
  return PATRON_IGNORABLE.test(String(descripcion ?? ""));
}

/**
 * Propone candidatos para un cargo bancario, ordenados por confianza. No decide:
 * devuelve la lista para que `conciliarAutomatico` aplique la política y la UI
 * muestre el resto.
 */
export function proponerCandidatos(mov: Pick<MovimientoExtracto, "fecha_movimiento" | "nro_operacion" | "monto_cargo" | "monto_abono">, u: UniversoConciliacion): Candidato[] {
  const esCargo = Number(mov.monto_cargo) > 0;
  const monto = esCargo ? Number(mov.monto_cargo) : Number(mov.monto_abono);
  const out: Candidato[] = [];

  const empujar = (c: Omit<Candidato, "confianza" | "motivo">, nivel: 1 | 2 | 3) => {
    const conf = nivel === 1 ? 1 : nivel === 2 ? 0.85 : 0.65;
    const motivo =
      nivel === 1 ? "N° de operación idéntico"
      : nivel === 2 ? "Mismo importe y misma fecha"
      : "Mismo importe, fecha con hasta 3 días de diferencia";
    out.push({ ...c, confianza: conf, motivo });
  };

  // 1) Pagos ya registrados en el ERP (el caso más limpio: el pago existe y trae el nº).
  for (const p of u.pagos) {
    if (esCargo && p.sentido !== "pago") continue;
    if (!esCargo && p.sentido !== "cobro") continue;
    if (!mismoMonto(p.monto, monto)) continue;
    const etiqueta = `Pago #${p.id} · ${p.observaciones ?? p.referencia ?? ""}`.trim();
    const base = { documento_tipo: "otro" as TipoDocumentoBanco, documento_id: p.id, pago_id: p.id, etiqueta, monto: Number(p.monto), fecha: p.fecha, nro_operacion: p.referencia };
    if (mismoNumero(p.referencia, mov.nro_operacion)) empujar(base, 1);
    else if (difDias(p.fecha, mov.fecha_movimiento) === 0) empujar(base, 2);
    else if (difDias(p.fecha, mov.fecha_movimiento) <= 3) empujar(base, 3);
  }

  // 2) Facturas de compra marcadas como pagadas fuera del ERP.
  if (esCargo) {
    for (const d of u.compras) {
      if (!mismoMonto(d.total, monto)) continue;
      const fecha = d.fecha_pago ?? d.fecha_emision;
      const etiqueta = `Factura ${[d.serie, d.numero].filter(Boolean).join("-") || `#${d.id}`} · ${d.razon_social ?? ""}`.trim();
      const base = { documento_tipo: "documento_compra" as TipoDocumentoBanco, documento_id: d.id, pago_id: null, etiqueta, monto: Number(d.total), fecha, nro_operacion: d.nro_operacion_bancaria };
      if (mismoNumero(d.nro_operacion_bancaria, mov.nro_operacion)) empujar(base, 1);
      else if (difDias(fecha, mov.fecha_movimiento) === 0) empujar(base, 2);
      else if (difDias(fecha, mov.fecha_movimiento) <= 3) empujar(base, 3);
    }

    // 3) Gastos generales / planilla.
    for (const g of u.generales) {
      if (!mismoMonto(g.monto, monto)) continue;
      const fecha = g.fecha_pago ?? g.fecha;
      const etiqueta = `${g.beneficiario_nombre} · ${g.concepto}`;
      const base = { documento_tipo: "gasto_general" as TipoDocumentoBanco, documento_id: g.id, pago_id: null, etiqueta, monto: Number(g.monto), fecha, nro_operacion: g.nro_operacion_bancaria };
      if (mismoNumero(g.nro_operacion_bancaria, mov.nro_operacion)) empujar(base, 1);
      else if (difDias(fecha, mov.fecha_movimiento) === 0) empujar(base, 2);
      else if (difDias(fecha, mov.fecha_movimiento) <= 3) empujar(base, 3);
    }

    // 4) Lotes de pago: un abono masivo sale del banco como UN cargo por el total.
    for (const l of u.lotes) {
      if (!mismoMonto(l.total, monto)) continue;
      const base = { documento_tipo: "lote_pago" as TipoDocumentoBanco, documento_id: l.id, pago_id: null, etiqueta: `Lote ${l.codigo ?? `#${l.id}`}`, monto: Number(l.total), fecha: l.fecha, nro_operacion: null };
      if (difDias(l.fecha, mov.fecha_movimiento) === 0) empujar(base, 2);
      else if (difDias(l.fecha, mov.fecha_movimiento) <= 3) empujar(base, 3);
    }
  }

  return out.sort((a, b) => b.confianza - a.confianza);
}

export type ResultadoConciliacion = {
  conciliados: number;
  observados: number;
  noIdentificados: number;
  ignorados: number;
  /** Movimientos con más de un candidato de igual confianza: nadie decide por el humano. */
  ambiguos: { movimiento_id: number; candidatos: Candidato[] }[];
};

/**
 * Aplica la política de casado sobre un conjunto de movimientos.
 *   · Un único candidato con confianza 1  → CONCILIADO automáticamente.
 *   · Candidatos de menor confianza, o empate → OBSERVADO (queda para el humano).
 *   · Comisiones/ITF                       → IGNORADO.
 *   · Ninguno                              → NO_IDENTIFICADO (fuga).
 */
export async function conciliarAutomatico(
  sb: any,
  movimientos: MovimientoExtracto[],
  universo: UniversoConciliacion,
  usuario?: string | null
): Promise<ResultadoConciliacion> {
  const res: ResultadoConciliacion = { conciliados: 0, observados: 0, noIdentificados: 0, ignorados: 0, ambiguos: [] };
  const ahora = new Date().toISOString();

  for (const m of movimientos) {
    if (m.estado_conciliacion === "conciliado" || m.estado_conciliacion === "ignorado") continue;

    if (Number(m.monto_cargo) > 0 && esMovimientoIgnorable(m.descripcion_banco)) {
      await sb.from("extractos_bancarios_movimientos")
        .update({ estado_conciliacion: "ignorado", observaciones: "Comisión/ITF: sin contrapartida en el ERP" })
        .eq("id", m.id);
      res.ignorados++;
      continue;
    }

    const candidatos = proponerCandidatos(m, universo);
    const exactos = candidatos.filter((c) => c.confianza >= 1);

    if (exactos.length === 1) {
      const c = exactos[0];
      await sb.from("extractos_bancarios_movimientos")
        .update({
          estado_conciliacion: "conciliado",
          documento_tipo: c.documento_tipo,
          documento_id: c.documento_id,
          pago_id: c.pago_id,
          conciliado_por: usuario ?? "automático",
          fecha_conciliacion: ahora,
          observaciones: c.motivo,
        })
        .eq("id", m.id);
      res.conciliados++;
      continue;
    }

    if (candidatos.length) {
      // Hay pista pero no certeza: se deja propuesto, nunca cerrado.
      const mejor = candidatos[0];
      const empate = candidatos.filter((c) => c.confianza === mejor.confianza);
      if (empate.length > 1) res.ambiguos.push({ movimiento_id: m.id, candidatos: empate.slice(0, 5) });
      await sb.from("extractos_bancarios_movimientos")
        .update({
          estado_conciliacion: "observado",
          documento_tipo: empate.length === 1 ? mejor.documento_tipo : null,
          documento_id: empate.length === 1 ? mejor.documento_id : null,
          observaciones:
            empate.length === 1
              ? `Propuesta (${Math.round(mejor.confianza * 100)}%): ${mejor.etiqueta} — ${mejor.motivo}`
              : `${empate.length} coincidencias posibles por el mismo importe. Requiere revisión manual.`,
        })
        .eq("id", m.id);
      res.observados++;
      continue;
    }

    if (m.estado_conciliacion !== "no_identificado") {
      await sb.from("extractos_bancarios_movimientos")
        .update({ estado_conciliacion: "no_identificado" })
        .eq("id", m.id);
    }
    res.noIdentificados++;
  }

  return res;
}

/** Carga el universo contra el que conciliar, acotado al rango del extracto ±7 días. */
export async function cargarUniverso(sb: any, desde: string, hasta: string): Promise<UniversoConciliacion> {
  const d = corrimiento(desde, -7);
  const h = corrimiento(hasta, 7);

  const [pagos, compras, generales, lotes] = await Promise.all([
    sb.from("pagos").select("id, fecha, monto, referencia, sentido, observaciones")
      .eq("anulado", false).gte("fecha", d).lte("fecha", h),
    sb.from("documentos_compra").select("id, fecha_pago, fecha_emision, total, nro_operacion_bancaria, razon_social, serie, numero")
      .gte("fecha_emision", corrimiento(desde, -120)).lte("fecha_emision", h),
    sb.from("gastos_generales").select("id, fecha_pago, fecha, monto, nro_operacion_bancaria, beneficiario_nombre, concepto")
      .gte("fecha", corrimiento(desde, -120)).lte("fecha", h),
    sb.from("lotes_pago").select("id, codigo, fecha, total").gte("fecha", d).lte("fecha", h),
  ]);

  return {
    pagos: pagos.data ?? [],
    compras: compras.data ?? [],
    generales: generales.data ?? [],
    lotes: lotes.data ?? [],
  };
}

function corrimiento(fecha: string, dias: number): string {
  const dt = new Date(`${fecha}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

/** Confirma manualmente un movimiento contra un documento elegido por el usuario. */
export async function conciliarManual(
  sb: any,
  movimientoId: number,
  c: { documento_tipo: TipoDocumentoBanco; documento_id: number | null; pago_id?: number | null },
  usuario?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sb
    .from("extractos_bancarios_movimientos")
    .update({
      estado_conciliacion: "conciliado",
      documento_tipo: c.documento_tipo,
      documento_id: c.documento_id,
      pago_id: c.pago_id ?? null,
      conciliado_por: usuario ?? null,
      fecha_conciliacion: new Date().toISOString(),
      observaciones: "Conciliado manualmente",
    })
    .eq("id", movimientoId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Resumen para las tarjetas KPI de la pantalla de conciliación. */
export function resumirConciliacion(movs: MovimientoExtracto[]) {
  const cargos = movs.filter((m) => Number(m.monto_cargo) > 0);
  const fugas = cargos.filter((m) => m.estado_conciliacion === "no_identificado");
  return {
    movimientos: movs.length,
    totalCargos: redondear(cargos.reduce((s, m) => s + Number(m.monto_cargo || 0), 0)),
    totalAbonos: redondear(movs.reduce((s, m) => s + Number(m.monto_abono || 0), 0)),
    conciliados: movs.filter((m) => m.estado_conciliacion === "conciliado").length,
    observados: movs.filter((m) => m.estado_conciliacion === "observado").length,
    fugas: fugas.length,
    montoFugas: redondear(fugas.reduce((s, m) => s + Number(m.monto_cargo || 0), 0)),
  };
}
