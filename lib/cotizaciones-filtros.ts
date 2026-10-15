// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizaciones-filtros.ts — Motor PURO de la lista de /cotizaciones (no lee la base).
//
// /cotizaciones pedía `select("*")` de TODAS las cotizaciones —con sus jsonb pesados— y PostgREST
// corta en 1000 filas en silencio: pasadas las mil, las más viejas no existían para la pantalla.
// La lista pasa a pedirse LIVIANA (solo escalares, `COLS_LISTA`) y acotada por un PERIODO en el
// servidor; el filtro de texto, estado y modo sigue siendo en memoria y con el MISMO predicado de
// antes (`textoBuscable` + `filtrarLista`, extraídos literal de la página); el detalle completo
// (jsonb incluidos) se pide bajo demanda con `leerCotizacion` (lib/cotizaciones-datos.ts).
//
// Fechas: Perú es UTC-5. Todo se calcula sobre cadenas ISO «YYYY-MM-DD» con Date en UTC, nunca
// con la hora local del servidor. Los rangos son de final EXCLUSIVO (`hastaExcl`).
// ──────────────────────────────────────────────────────────────────────────────

import { coincideBusqueda } from "@/lib/busqueda-texto";
import { fechaLima } from "@/lib/alertas-horario";

export type Periodo = "hoy" | "7d" | "30d" | "este_mes" | "mes_anterior" | "90d" | "este_anio" | "rango" | "todo";
export type EjeFecha = "emision" | "servicio";

export const PERIODO_DEFECTO: Periodo = "90d";
export const EJE_DEFECTO: EjeFecha = "emision";

export const PERIODOS: readonly Periodo[] = ["hoy", "7d", "30d", "este_mes", "mes_anterior", "90d", "este_anio", "rango", "todo"];

export const ETIQUETA_PERIODO: Record<Periodo, string> = {
  hoy: "Hoy",
  "7d": "Últimos 7 días",
  "30d": "Últimos 30 días",
  este_mes: "Este mes",
  mes_anterior: "Mes anterior",
  "90d": "Últimos 90 días",
  este_anio: "Este año",
  rango: "Rango de fechas",
  todo: "Todo",
};

export const ETIQUETA_EJE: Record<EjeFecha, string> = {
  emision: "Fecha de emisión",
  servicio: "Fecha del servicio",
};

/** «Hoy» en Lima (UTC-5) como YYYY-MM-DD. Delega en el mismo desplazamiento de lib/alertas-horario. */
export function hoyLimaISO(ahora: Date = new Date()): string {
  return fechaLima(ahora.getTime());
}

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Suma días a una fecha ISO (aritmética en UTC, sin hora local). */
export function sumarDias(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Primer día del mes de `iso` desplazado `deltaMeses` meses. */
function primeroDeMes(iso: string, deltaMeses = 0): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + deltaMeses, 1)).toISOString().slice(0, 10);
}

export type CodigoRango = "ok" | "rango_incompleto" | "rango_invertido";
export type RangoPeriodo = { desde: string | null; hastaExcl: string | null; codigo: CodigoRango };

/**
 * Límites de días [desde, hastaExcl) del periodo, con `hoy` = fecha de Lima.
 * Los relativos terminan en hoy+1 (hoy incluido). "7d" son 7 días contando hoy.
 * "mes_anterior" es el mes calendario completo anterior. "todo" no tiene límites.
 * "rango" sin alguna de sus dos fechas (o con una que no es ISO) → `rango_incompleto`; con
 * desde > hasta → `rango_invertido`; en los dos casos SIN límites (la pantalla dice por qué).
 */
export function rangoDePeriodo(p: Periodo, hoy: string, rango?: { desde?: string; hasta?: string }): RangoPeriodo {
  const manana = sumarDias(hoy, 1);
  switch (p) {
    case "hoy": return { desde: hoy, hastaExcl: manana, codigo: "ok" };
    case "7d": return { desde: sumarDias(hoy, -6), hastaExcl: manana, codigo: "ok" };
    case "30d": return { desde: sumarDias(hoy, -29), hastaExcl: manana, codigo: "ok" };
    case "90d": return { desde: sumarDias(hoy, -89), hastaExcl: manana, codigo: "ok" };
    case "este_mes": return { desde: primeroDeMes(hoy), hastaExcl: manana, codigo: "ok" };
    case "mes_anterior": return { desde: primeroDeMes(hoy, -1), hastaExcl: primeroDeMes(hoy), codigo: "ok" };
    case "este_anio": return { desde: `${hoy.slice(0, 4)}-01-01`, hastaExcl: manana, codigo: "ok" };
    case "todo": return { desde: null, hastaExcl: null, codigo: "ok" };
    case "rango": {
      const d = (rango?.desde ?? "").trim();
      const h = (rango?.hasta ?? "").trim();
      if (!RE_ISO.test(d) || !RE_ISO.test(h) || sumarDias(d, 0) !== d || sumarDias(h, 0) !== h) return { desde: null, hastaExcl: null, codigo: "rango_incompleto" };
      if (d > h) return { desde: null, hastaExcl: null, codigo: "rango_invertido" };
      return { desde: d, hastaExcl: sumarDias(h, 1), codigo: "ok" };
    }
  }
}

export type LimitesConsulta = { columna: "created_at" | "fecha_servicio"; gte: string | null; lt: string | null };

/**
 * Cómo se filtra en la consulta. Emisión es `created_at` (timestamptz): el día se ancla a
 * medianoche de LIMA con `-05:00`, o una cotización emitida a las 20:00 caería al día siguiente.
 * Servicio es `fecha_servicio` (date): la fecha tal cual.
 */
export function limitesConsulta(eje: EjeFecha, r: Pick<RangoPeriodo, "desde" | "hastaExcl">): LimitesConsulta {
  if (eje === "emision") {
    return {
      columna: "created_at",
      gte: r.desde ? `${r.desde}T00:00:00-05:00` : null,
      lt: r.hastaExcl ? `${r.hastaExcl}T00:00:00-05:00` : null,
    };
  }
  return { columna: "fecha_servicio", gte: r.desde, lt: r.hastaExcl };
}

/**
 * Columnas de la lista: solo ESCALARES. Sale de todo lo que la lista (tarjetas y tabla),
 * PanelDecision, cambiarEstado, confirmarEnvio, confirmarAprob (escribe el tarifario con
 * origen/destino/tipo_vehiculo/equipamiento/tipo_servicio/modo/precio_dia/precio_cliente) y los
 * modales que reciben una fila leen. Fuera a propósito: los jsonb (items_json, paradas_json,
 * paradas_retorno_json, consideraciones_json, fechas_multidia_json, ficha_ruta_json,
 * ruta_coords_json) e itinerario_texto — se piden con el detalle (`leerCotizacion`).
 * `paradas_n` es de una migración accesoria: el lector la suelta si el error la nombra.
 */
export const COLS_LISTA = [
  "id", "cliente_id", "origen", "destino", "km", "precio_cliente", "costo_estimado", "margen_estimado",
  "estado", "numero_cotizacion", "atencion", "asunto", "punto_retorno",
  "fecha_servicio", "fecha_retorno", "hora_ida", "hora_retorno",
  "descuento_pct", "tipo_vehiculo", "tipo_servicio", "equipamiento",
  "vehiculo_flota_id", "vehiculo_tercero_id", "created_at", "modo_servicio",
  "dias_servicio", "horas_servicio", "pernocte_costo",
  "precio_dia", "precio_mes_estimado", "precio_tarifario", "precio_cotizador",
  "costo_cotizador", "margen_cotizador", "vehiculo_cotizador",
  "precio_sugerido", "modo_precio", "medio_envio", "plantilla_pdf", "enviado_automatico", "incluye_igv",
  "descuento_solicitado", "descuento_pct_solicitado", "descuento_autorizado", "hora_solicitud_descuento",
  "numero_aprobacion", "tipo_aprobacion",
  "paradas_n",
] as const;

export type ColLista = (typeof COLS_LISTA)[number];

/** Columna de migración accesoria: si el error la nombra, se suelta y se reintenta. */
export const COLS_OPCIONALES_LISTA: readonly ColLista[] = ["paradas_n"];

/** El string del `select`, sin las columnas indicadas. */
export function colsSelect(sin: readonly string[] = []): string {
  const fuera = new Set(sin.map((s) => s.toLowerCase()));
  return COLS_LISTA.filter((c) => !fuera.has(c)).join(",");
}

export type CotLista = {
  id: number; cliente_id: number | null; origen: string; destino: string; km: number;
  precio_cliente: number; costo_estimado: number; margen_estimado: number;
  estado: string; numero_cotizacion: string | null; atencion: string | null; asunto: string | null;
  punto_retorno: string | null; fecha_servicio: string | null; fecha_retorno: string | null;
  hora_ida: string | null; hora_retorno: string | null; descuento_pct: number;
  tipo_vehiculo: string | null; tipo_servicio: string | null; equipamiento: string | null;
  vehiculo_flota_id: number | null; vehiculo_tercero_id: number | null; created_at: string;
  modo_servicio: string | null; dias_servicio: number | null; horas_servicio: number | null; pernocte_costo: number | null;
  precio_dia: number | null; precio_mes_estimado: number | null; precio_tarifario: number | null; precio_cotizador: number | null;
  costo_cotizador: number | null; margen_cotizador: number | null; vehiculo_cotizador: string | null;
  precio_sugerido: number | null; modo_precio: string | null; medio_envio: string | null; plantilla_pdf: string | null;
  enviado_automatico: boolean; incluye_igv: boolean | null;
  descuento_solicitado: boolean; descuento_pct_solicitado: number | null; descuento_autorizado: boolean;
  hora_solicitud_descuento: string | null; numero_aprobacion: string | null; tipo_aprobacion: string | null;
  /** Nº de paraderos de ida (columna accesoria). null/ausente = no se sabe. */
  paradas_n?: number | null;
};

type FilaBuscable = Pick<CotLista, "id" | "origen" | "destino" | "asunto" | "atencion" | "numero_cotizacion">;
type ClienteBuscableTxt = { empresa?: string | null; nombre?: string | null; ruc?: string | null } | null | undefined;

/** Texto contra el que se busca una cotización. EXTRAÍDO LITERAL de app/cotizaciones/page.tsx. */
export function textoBuscable(c: FilaBuscable, ncl?: ClienteBuscableTxt): string {
  return [ncl?.empresa, ncl?.nombre, ncl?.ruc, c.origen, c.destino, c.asunto, c.atencion, c.numero_cotizacion, String(c.id).padStart(5, "0")].filter(Boolean).join(" ");
}

export type CriterioLista = { terminos: string[]; estado: string; modo: string };

/**
 * Filtro en memoria, misma regla que la página: búsqueda permisiva sobre `textos` (id → texto de
 * `textoBuscable`), estado exacto salvo "todos", y modo exacto salvo "todos" — con "eventual"
 * incluyendo el modo vacío (las cotizaciones viejas no lo tienen escrito).
 */
export function filtrarLista<T extends Pick<CotLista, "id" | "estado" | "modo_servicio">>(
  filas: readonly T[], textos: Map<number, string>, crit: CriterioLista,
): T[] {
  return filas.filter((c) =>
    coincideBusqueda(textos.get(c.id) ?? "", crit.terminos)
    && (crit.estado === "todos" || c.estado === crit.estado)
    && (crit.modo === "todos" || c.modo_servicio === crit.modo || (crit.modo === "eventual" && !c.modo_servicio)),
  );
}

export type KpisCot = {
  total: number; eventuales: number; fijos: number; pendientes: number; enviadas: number;
  aprobadas: number; tasa: number; descPend: number;
};

/** KPIs de la cabecera, con las fórmulas de la página (tasa = aprobadas/total redondeada). */
export function kpisDe(filas: readonly Pick<CotLista, "estado" | "modo_servicio" | "descuento_solicitado" | "descuento_autorizado">[]): KpisCot {
  const total = filas.length;
  const aprobadas = filas.filter((c) => c.estado === "aprobado").length;
  return {
    total,
    eventuales: filas.filter((c) => !c.modo_servicio || c.modo_servicio === "eventual").length,
    fijos: filas.filter((c) => c.modo_servicio === "fijo").length,
    pendientes: filas.filter((c) => c.estado === "pendiente").length,
    enviadas: filas.filter((c) => c.estado === "enviado").length,
    aprobadas,
    tasa: total > 0 ? Math.round(aprobadas / total * 100) : 0,
    descPend: filas.filter((c) => c.descuento_solicitado && !c.descuento_autorizado).length,
  };
}
