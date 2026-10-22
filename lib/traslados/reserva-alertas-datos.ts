// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-alertas-datos.ts — El LECTOR de las alertas de la reserva de traslados: lee
// las solicitudes (reservas-09a), sus cotizaciones, sus pagos (reservas-09c) y sus comprobantes
// (reservas-09b) para el motor puro (lib/traslados/reserva-alertas.ts), y escribe el cierre
// automático de una solicitud vencida. Solo servidor: recibe el cliente service-role del tick.
//
// LAS REGLAS:
//  · SIN LA TABLA (la migración no se corrió) no hay nada que avisar ni cerrar: `sinTabla`, y el
//    tick sigue con sus bloques. Cualquier OTRO error de la lista de solicitudes lanza: el tick lo
//    atrapa y lo publica, nunca lo lee como «no hay ninguna».
//  · UNA LECTURA FALLIDA NO ES UNA LISTA VACÍA. Sin poder leer los pagos o los comprobantes, cada
//    solicitud los lleva en null y el motor no cierra ni afirma «saldada». Solo cuando lo que falta
//    es la COLUMNA `pagos.reserva_solicitud_id` (09c) o la TABLA de comprobantes (09b) la ausencia es
//    un hecho: sin ellas no puede haber ningún pago ni comprobante atado a una solicitud.
//  · PostgREST corta en 1000 filas: todo se pagina con orden total.
//  · El cierre es un UPDATE CONDICIONAL al estado (`esperando_pago`): si entre la lectura y la
//    escritura llegó un comprobante (la solicitud pasó a «pago reportado»), no se toca.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, faltaColumna, tablaFaltante } from "../columna-faltante";
import {
  DIAS_DEVOLUCION_LEIDOS, ESTADOS_DEVOLUCION, ESTADOS_SIN_CONFIRMAR,
  type CotizacionAlerta, type HechosSolicitud, type SolicitudAlerta,
} from "./reserva-alertas";
import type { PagoSolicitud } from "./reserva-pago";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

const TABLA = "reserva_solicitudes";
const COLS_SOLICITUD =
  "id, estado, cotizacion_id, crm_conversacion_id, crm_accion_id, confirmar_antes_de, urgente, devolucion_pct, " +
  "reserva_id, cancelacion_pedida_en, cerrada_en, actualizada_en, creada_en, nota";
const PAGINA = 1000;
const LOTE_IN = 200;

const trozos = <T,>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Todas las páginas de una consulta, con orden total. Lanza (con el error) si una página falla. */
async function todas<T>(armar: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null }>): Promise<{ filas: T[]; error: { code?: string; message?: string } | null }> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await armar(desde, desde + PAGINA - 1);
    if (error) return { filas, error };
    filas.push(...(data ?? []));
    if (!data || data.length < PAGINA) break;
  }
  return { filas, error: null };
}

export type LecturaAlertasReserva = {
  /** La migración reservas-09a no se corrió: no hay solicitudes. */
  sinTabla: boolean;
  hechos: HechosSolicitud[];
  /** Lo que no se pudo leer (para publicarlo en el tick). */
  avisos: string[];
};

/**
 * Las solicitudes que el motor juzga: las que esperan el pago (el auto-vencimiento corre siempre),
 * las que esperan a un ejecutivo (solo con «sin confirmar» encendida) y las cerradas sin unidad o
 * canceladas tocadas en los últimos `DIAS_DEVOLUCION_LEIDOS` días (solo con «devolución» encendida).
 */
export async function leerHechosAlertasReserva(sb: Sb, x: { ahoraMs: number; sinConfirmar: boolean; devolucion: boolean }): Promise<LecturaAlertasReserva> {
  const avisos: string[] = [];
  const estadosAbiertos = ["esperando_pago", ...(x.sinConfirmar ? ESTADOS_SIN_CONFIRMAR : [])];
  const abiertas = await todas<SolicitudAlerta>((d, h) => sb.from(TABLA).select(COLS_SOLICITUD)
    .in("estado", estadosAbiertos).order("id").range(d, h));
  if (abiertas.error) {
    if (tablaFaltante(abiertas.error, TABLA)) return { sinTabla: true, hechos: [], avisos };
    throw new Error(`No se pudieron leer las solicitudes de reserva: ${abiertas.error.message ?? abiertas.error.code}`);
  }
  let cerradas: SolicitudAlerta[] = [];
  if (x.devolucion) {
    const desdeIso = new Date(x.ahoraMs - DIAS_DEVOLUCION_LEIDOS * 86_400_000).toISOString();
    const r = await todas<SolicitudAlerta>((d, h) => sb.from(TABLA).select(COLS_SOLICITUD)
      .in("estado", [...ESTADOS_DEVOLUCION]).gte("actualizada_en", desdeIso).order("id").range(d, h));
    if (r.error) throw new Error(`No se pudieron leer las solicitudes cerradas: ${r.error.message ?? r.error.code}`);
    cerradas = r.filas;
  }
  const solicitudes = [...abiertas.filas, ...cerradas];
  if (!solicitudes.length) return { sinTabla: false, hechos: [], avisos };

  // ── Cotizaciones (y el nombre del cliente) ──
  const cotIds = [...new Set(solicitudes.map((s) => Number(s.cotizacion_id)).filter(Number.isFinite))];
  const cots = new Map<number, CotizacionAlerta>();
  const clienteDe = new Map<number, number>();
  let cotsOk = true;
  for (const ids of trozos(cotIds, LOTE_IN)) {
    let cols = ["id", "numero_cotizacion", "fecha_servicio", "hora_ida", "moneda", "cliente_id", "atencion", "traslado_json"];
    const accesorias = ["moneda", "cliente_id", "atencion", "traslado_json"] as const;
    for (let intento = 0; ; intento++) {
      const { data, error } = await sb.from("cotizaciones").select(cols.join(", ")).in("id", ids);
      if (error) {
        const c = intento < accesorias.length ? faltaAlguna(error, accesorias) : null;
        if (c && cols.includes(c)) { cols = cols.filter((k) => k !== c); avisos.push(`cotizaciones sin la columna ${c}`); continue; }
        cotsOk = false; avisos.push(`cotizaciones: ${error.message ?? error.code}`); break;
      }
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const id = Number(r.id);
        const tj = r.traslado_json && typeof r.traslado_json === "object" ? (r.traslado_json as { validez_hasta?: unknown }) : null;
        cots.set(id, {
          id, numero_cotizacion: (r.numero_cotizacion as string) ?? null,
          fecha_servicio: (r.fecha_servicio as string) ?? null, hora_ida: (r.hora_ida as string) ?? null,
          moneda: (r.moneda as string) ?? null,
          validez_hasta: typeof tj?.validez_hasta === "string" ? tj.validez_hasta : null,
          cliente: typeof r.atencion === "string" && r.atencion.trim() ? r.atencion : null,
        });
        if (r.cliente_id != null && Number.isFinite(Number(r.cliente_id))) clienteDe.set(id, Number(r.cliente_id));
      }
      break;
    }
  }
  // El cliente del ERP manda sobre la «atención» (best-effort: sin él queda la atención).
  const cliIds = [...new Set(clienteDe.values())];
  for (const ids of trozos(cliIds, LOTE_IN)) {
    const { data, error } = await sb.from("clientes").select("id, nombre, empresa").in("id", ids);
    if (error) { avisos.push(`clientes: ${error.message ?? error.code}`); break; }
    const nom = new Map<number, string>();
    for (const c of (data ?? []) as { id: number; nombre: string | null; empresa: string | null }[]) {
      const n = String(c.empresa || c.nombre || "").trim();
      if (n) nom.set(Number(c.id), n);
    }
    for (const [cot, cli] of clienteDe) { const n = nom.get(cli); const c = cots.get(cot); if (n && c) c.cliente = n; }
  }

  // ── Pagos de cada solicitud (09c) ──
  const solIds = solicitudes.map((s) => Number(s.id));
  type FilaPago = PagoSolicitud & { reserva_solicitud_id: number | null };
  let pagos: Map<number, FilaPago[]> | null = new Map();
  for (const ids of trozos(solIds, LOTE_IN)) {
    const r = await todas<FilaPago>((d, h) => sb.from("pagos").select("id, reserva_solicitud_id, sentido, monto, moneda, anulado")
      .in("reserva_solicitud_id", ids).order("id").range(d, h));
    if (r.error) {
      // Sin la columna de 09c ningún pago puede estar atado a una solicitud: la ausencia es un hecho.
      if (faltaColumna(r.error, "reserva_solicitud_id")) { avisos.push("pagos sin la columna reserva_solicitud_id (reservas-09c)"); pagos = new Map(); break; }
      avisos.push(`pagos: ${r.error.message ?? r.error.code}`); pagos = null; break;
    }
    for (const p of r.filas) {
      const k = Number(p.reserva_solicitud_id);
      const l = pagos.get(k) ?? []; l.push(p); pagos.set(k, l);
    }
  }

  // ── Comprobantes reportados (09b) ──
  let comps: Map<number, number> | null = new Map();
  for (const ids of trozos(solIds, LOTE_IN)) {
    const r = await todas<{ solicitud_id: number }>((d, h) => sb.from("reserva_solicitud_comprobantes").select("id, solicitud_id")
      .in("solicitud_id", ids).order("id").range(d, h));
    if (r.error) {
      if (tablaFaltante(r.error, "reserva_solicitud_comprobantes")) { avisos.push("sin la tabla reserva_solicitud_comprobantes (reservas-09b)"); comps = new Map(); break; }
      avisos.push(`comprobantes: ${r.error.message ?? r.error.code}`); comps = null; break;
    }
    for (const c of r.filas) comps.set(Number(c.solicitud_id), (comps.get(Number(c.solicitud_id)) ?? 0) + 1);
  }

  const hechos: HechosSolicitud[] = solicitudes.map((s) => ({
    solicitud: s,
    cotizacion: cotsOk ? cots.get(Number(s.cotizacion_id)) ?? null : null,
    pagos: pagos ? pagos.get(Number(s.id)) ?? [] : null,
    comprobantes: comps ? comps.get(Number(s.id)) ?? 0 : null,
  }));
  return { sinTabla: false, hechos, avisos };
}

/**
 * Cierra una solicitud «esperando pago» vencida: `cancelada`, `cierre_motivo = 'vencida'`, la nota
 * del cierre agregada a la suya. UPDATE condicional al estado. Después, best-effort: su tarjeta del
 * CRM (`crm_acciones_ia`) pasa a `rechazada` con la nota en el payload (solo si seguía pendiente), y
 * una nota interna en la conversación. NO le escribe al cliente. true si la cerró ESTA llamada.
 */
export async function cerrarSolicitudVencida(sb: Sb, x: {
  solicitud: SolicitudAlerta; nota: string; notaSolicitud: string; ahoraIso: string;
}): Promise<boolean> {
  const s = x.solicitud;
  const { data, error } = await sb.from(TABLA)
    .update({ estado: "cancelada", cierre_motivo: "vencida", cerrada_en: x.ahoraIso, nota: x.notaSolicitud })
    .eq("id", s.id).eq("estado", "esperando_pago").select("id");
  if (error) throw new Error(`No se pudo cerrar la solicitud de reserva #${s.id}: ${error.message ?? error.code}`);
  if (!(data ?? []).length) return false;   // otro la movió entre la lectura y el cierre

  if (s.crm_accion_id) {
    try {
      const { data: acc } = await sb.from("crm_acciones_ia").select("id, estado, payload").eq("id", s.crm_accion_id).maybeSingle();
      if (acc && acc.estado === "pendiente") {
        const payload = acc.payload && typeof acc.payload === "object" ? acc.payload : {};
        await sb.from("crm_acciones_ia")
          .update({ estado: "rechazada", resuelta_at: x.ahoraIso, payload: { ...payload, cierre: { motivo: "vencida", nota: x.nota, at: x.ahoraIso, por: "sistema" } } })
          .eq("id", acc.id).eq("estado", "pendiente");
      }
    } catch { /* la solicitud ya quedó cerrada: la tarjeta lo leerá de ahí */ }
  }
  if (s.crm_conversacion_id) {
    try {
      await sb.from("crm_notas").insert({ conversacion_id: s.crm_conversacion_id, texto: x.nota, autor_nombre: "Sistema" });
    } catch { /* sin crm_notas, el cierre queda en la solicitud */ }
  }
  return true;
}
