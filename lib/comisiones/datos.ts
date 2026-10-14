// ══════════════════════════════════════════════════════════════════════════════
// lib/comisiones/datos.ts
// La FRONTERA del módulo de comisiones: el que LEE y ESCRIBE. El motor de `lib/comisiones/*`
// es PURO y no toca la base; acá se juntan las piezas que necesita, se arma `EntradaMotor`,
// se corre el motor y se persiste el resultado. Mismo reparto que `lib/ocupacion/datos.ts`
// y `lib/retrasos-datos.ts`: nada se MIDE ni se DECIDE aquí.
//
// LA UTILIDAD SALE SOLO DE `v_utilidad_servicio` (utilidad_antes_impuestos). No se recalcula
// —sería el bug del semáforo: un segundo motor de costeo discrepando con `lib/costeo-servicio`—.
// Si `sin_presupuesto = true`, se pasa `tienePresupuesto: false` y el motor RETIENE (emite
// `retenido_falta_costear`, monto null): se avisa, no se paga de más.
//
// UN MOTOR POR VENDEDOR. `calcularComisiones` recibe UN `vendedorId` y el tramo del eventual
// (1–30 al 20 %, 31+ al 12 %) cuenta por vendedor/mes. Así que se agrupan los servicios del
// mes por vendedor y se corre el motor una vez por cada uno. El FONDO es de periodo (no de
// vendedor): se calcula aparte, una sola vez, sobre todos los eventuales nuevos del mes.
//
// EL ANCLA DE LA VENTANA ES GLOBAL POR CLIENTE. El primer servicio cobrado de un cliente puede
// haberlo vendido OTRO vendedor; si cada corrida por vendedor dedujera el ancla solo de SUS
// servicios, saldría mal. Por eso `ContextoCliente.primerServicioCobradoFecha` se calcula sobre
// TODO el historial del cliente y se pasa explícito: cada corrida usa el ancla correcta.
//
// SNAPSHOT DE PARÁMETROS. Cada línea guarda `parametros_id` (la versión vigente a su fecha de
// cobro). Un mes `cerrado` NO se recalcula (fase 04). Degrada si falta una migración accesoria.
// ══════════════════════════════════════════════════════════════════════════════

import {
  calcularComisiones,
  type EntradaBonoAtencion,
  type EntradaMotor,
} from "./motor";
import { mesDe } from "./calendario";
import type { Indicador, Reclamo, Cancelacion } from "./bono-atencion";
import type { ContextoCliente } from "./cliente-nuevo";
import type {
  ContratoFijo,
  LineaComision,
  MesFijo,
  ParametroComision,
  Regla,
  ServicioEventual,
} from "./tipos";
import { faltaColumna, tablaFaltante } from "@/lib/columna-faltante";

// ─── Tipos de la base, mapeados al vocabulario del motor ──────────────────────

/** Una fila de `comisiones_parametros`, tal como la devuelve Supabase. */
export type FilaParametros = {
  id: number;
  vigente_desde: string;
  pct_eventual_tramo1: number;
  pct_eventual_tramo2: number;
  tramo_eventual_hasta: number;
  pct_fijo: number;
  pct_bono_arranque: number;
  arranque_split: number[] | null;
  arranque_mes_2da_parte: number;
  ventana_fijo_meses: number;
  ventana_cliente_nuevo_meses: number;
  tope_bono_atencion: number;
  indicadores_json: Record<string, number> | null;
  fondo_admin_por_eventual: number;
};

/**
 * Mapea una fila de `comisiones_parametros` al `ParametroComision` del motor.
 *
 * EL MOTOR TOMA UNA SOLA VENTANA (`ventanaMeses`), y la base tiene DOS (`ventana_fijo_meses`
 * y `ventana_cliente_nuevo_meses`). Ambas nacen en 12 y coinciden; se mapea desde
 * `ventana_fijo_meses` —la que gobierna el pago— y se asume `ventana_cliente_nuevo_meses`
 * igual. Si gerencia necesita que difieran, el motor tendría que crecer a dos ventanas
 * (fuera de este alcance). SUPUESTO declarado.
 */
export function mapParametro(f: FilaParametros): ParametroComision {
  const split = Array.isArray(f.arranque_split) && f.arranque_split.length
    ? f.arranque_split
    : [0.5, 0.5];
  const mesSegunda = Number(f.arranque_mes_2da_parte ?? 3);
  // Las mitades: la 1ª cae con el cobro del mes 1; la 2ª con el del `arranque_mes_2da_parte`.
  const mitades = split.map((fraccion, i) => ({
    mes: i === 0 ? 1 : mesSegunda,
    fraccion: Number(fraccion),
  }));
  return {
    vigente_desde: String(f.vigente_desde),
    tramosEventual: [
      { hasta: Number(f.tramo_eventual_hasta ?? 30), tasa: Number(f.pct_eventual_tramo1 ?? 0.2) },
      { hasta: null, tasa: Number(f.pct_eventual_tramo2 ?? 0.12) },
    ],
    tasaFijo: Number(f.pct_fijo ?? 0.1),
    tasaBonoArranque: Number(f.pct_bono_arranque ?? 0.3),
    mitadesBonoArranque: mitades,
    ventanaMeses: Number(f.ventana_fijo_meses ?? 12),
    montoFondoPorEventual: Number(f.fondo_admin_por_eventual ?? 4),
    topeBonoAtencion: Number(f.tope_bono_atencion ?? 150),
    toleranciaRapidez: Number(f.indicadores_json?.tolerancia_rapidez ?? 0.9),
  };
}

// ─── Indicadores del bono de atención (PURO) ──────────────────────────────────

/** Un reclamo del vendedor en el mes, ya traído de `comisiones_reclamos`. */
export type FilaReclamo = { gravedad?: string | null; fundado?: boolean | null; atribuible_vendedor?: boolean | null };
/** Una cancelación del vendedor en el mes, de `comisiones_cancelaciones`. */
export type FilaCancelacion = { evitable?: boolean | null; constancia_escrita?: boolean | null };

/**
 * Los 7 indicadores del bono de atención para un vendedor, compuestos con los montos de
 * `indicadores_json` y las clasificaciones del mes.
 *
 * SE PAGA ANTE LA DUDA (regla del motor): los indicadores sin fuente de eventos
 * (`rapidez`, `seguimiento`, `registros`, `precios`, `documentacion`) salen CUMPLIDOS —el
 * mes sin eventos vale cumplido—. Lo único que puede ROMPER el bono hoy es un reclamo
 * `grave ∧ fundado ∧ atribuible` o una cancelación `evitable ∧ constancia`. Cuando el ERP
 * registre eventos de rapidez/registros por vendedor, se enganchan aquí sin tocar el motor.
 */
export function indicadoresDeVendedor(
  montos: Record<string, number> | null | undefined,
  reclamos: readonly FilaReclamo[],
  cancelaciones: readonly FilaCancelacion[],
): Indicador[] {
  const m = montos ?? {};
  const val = (k: string, def: number) => Number(m[k] ?? def);
  const reclamosMotor: Reclamo[] = reclamos.map((r) => ({
    grave: r.gravedad === "grave",
    fundado: r.fundado ?? null,
    atribuible: r.atribuible_vendedor ?? null,
  }));
  const cancelMotor: Cancelacion[] = cancelaciones.map((c) => ({
    evitable: c.evitable ?? null,
    constancia_escrita: c.constancia_escrita ?? null,
  }));
  return [
    { clave: "cero_quejas", valor: val("cero_quejas", 20), tipo: "reclamo", reclamos: reclamosMotor },
    { clave: "sin_cancelaciones", valor: val("sin_cancelaciones", 20), tipo: "cancelacion", cancelaciones: cancelMotor },
    { clave: "rapidez", valor: val("rapidez", 20), tipo: "rapidez", atendidos: 0, enPlazo: 0 },
    { clave: "seguimiento", valor: val("seguimiento", 25), tipo: "generico", eventos: 0 },
    { clave: "registros", valor: val("registros", 20), tipo: "generico", eventos: 0 },
    { clave: "precios", valor: val("precios", 15), tipo: "generico", eventos: 0 },
    { clave: "documentacion", valor: val("documentacion", 30), tipo: "generico", eventos: 0 },
  ];
}

// ─── Ensamblado PURO: agrupar por vendedor + armar el fondo ───────────────────

export type ServicioConVendedor = ServicioEventual & { vendedorId: string | null; cotizacionId: number | null };
export type ContratoConVendedor = ContratoFijo & { vendedorId: string | null };

export type DatosCargados = {
  parametros: ParametroComision[];
  /** Eventuales COBRADOS del mes. */
  eventuales: ServicioConVendedor[];
  /** Contratos fijos tocados en el mes, con su estructura mensual COMPLETA. */
  contratos: ContratoConVendedor[];
  /** Contexto por cliente (lista firmada, servicios previos, fecha cotización, ancla). */
  clientes: Record<string, ContextoCliente>;
  /** Operadores corroborados del periodo (personal_administrativo_id como string). */
  operadoresCorroborados: string[];
  /** Indicadores del bono de atención por vendedor (uuid → indicadores). */
  bonoPorVendedor: Record<string, EntradaBonoAtencion>;
};

/** La clave de agrupación de un vendedor sin identificar (líneas que solo ve el admin). */
export const SIN_VENDEDOR = "__sin_vendedor__";

export type EntradaDeVendedor = { vendedorId: string | null; entrada: EntradaMotor };

/**
 * Agrupa los servicios por vendedor y arma una `EntradaMotor` por cada uno, más la entrada
 * del FONDO (todos los eventuales del mes, con los operadores corroborados). PURO: no corre
 * el motor ni toca la base, para poder barrerlo en la matriz.
 */
export function armarEntradas(d: DatosCargados): {
  porVendedor: EntradaDeVendedor[];
  fondo: EntradaMotor;
} {
  const claves = new Set<string>();
  for (const e of d.eventuales) claves.add(e.vendedorId ?? SIN_VENDEDOR);
  for (const c of d.contratos) claves.add(c.vendedorId ?? SIN_VENDEDOR);

  const porVendedor: EntradaDeVendedor[] = [];
  for (const clave of claves) {
    const vendedorId = clave === SIN_VENDEDOR ? undefined : clave;
    const eventuales = d.eventuales.filter((e) => (e.vendedorId ?? SIN_VENDEDOR) === clave);
    const contratosFijos = d.contratos.filter((c) => (c.vendedorId ?? SIN_VENDEDOR) === clave);
    porVendedor.push({
      vendedorId: vendedorId ?? null,
      entrada: {
        parametros: d.parametros,
        vendedorId,
        eventuales,
        contratosFijos,
        // FONDO APAGADO en la corrida por vendedor: el fondo es de periodo y se calcula
        // aparte (una sola línea por operador, un solo redondeo). Pasarlo acá crearía una
        // línea de fondo por vendedor.
        operadoresCorroborados: [],
        bonoAtencion: vendedorId ? d.bonoPorVendedor[vendedorId] ?? null : null,
        clientes: d.clientes,
      },
    });
  }

  const fondo: EntradaMotor = {
    parametros: d.parametros,
    eventuales: d.eventuales,
    contratosFijos: d.contratos, // solo para el ancla; el fondo no suma meses de fijo
    operadoresCorroborados: d.operadoresCorroborados,
    clientes: d.clientes,
  };

  return { porVendedor, fondo };
}

/** El `tipo` de `comisiones_linea` que corresponde a cada `Regla` del motor. */
export function tipoDeRegla(r: Regla): string {
  return r === "fijo_mensual" ? "fijo" : r;
}

/**
 * Corre el motor sobre cada entrada y devuelve las líneas que PERTENECEN al mes `anioMes`.
 *
 * El motor procesa el contrato fijo ENTERO (lo necesita para la ventana, el bono de arranque
 * y la cancelación), así que emite líneas de meses pasados y futuros. Se conservan SOLO las
 * de ESTE mes: una línea pertenece al periodo si su cobro cae en el mes, o si es el bono de
 * atención (uno por vendedor/mes, sin fecha de cobro). Así un evento de pago se persiste una
 * sola vez, en el periodo de su cobro, y no se guardan 0's de «pendiente» mes tras mes.
 */
export function calcularLineas(d: DatosCargados, anioMes: string): LineaComision[] {
  const { porVendedor, fondo } = armarEntradas(d);
  const perteneceAlMes = (l: LineaComision) =>
    l.regla === "bono_atencion" || (!!l.fechaCobro && mesDe(l.fechaCobro) === anioMes);

  const lineas: LineaComision[] = [];
  for (const { entrada } of porVendedor) {
    for (const l of calcularComisiones(entrada).lineas) {
      if (l.regla === "fondo_admin") continue; // el fondo va aparte
      if (perteneceAlMes(l)) lineas.push(l);
    }
  }
  // El fondo del periodo: solo las líneas de fondo de la corrida dedicada.
  for (const l of calcularComisiones(fondo).lineas) {
    if (l.regla === "fondo_admin") lineas.push(l);
  }
  return lineas;
}

// ══════════════════════════════════════════════════════════════════════════════
// A PARTIR DE AQUÍ: la parte que LEE/ESCRIBE la base (service-role). Recibe `db` inyectado,
// como `lib/ocupacion/datos.ts`, para poder correrse con un cliente falso en la matriz.
// ══════════════════════════════════════════════════════════════════════════════

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" en hora de Lima (UTC-5) de un timestamp ISO (o null). */
export function fechaLimaDe(ts: unknown): string | null {
  if (!ts) return null;
  const ms = typeof ts === "number" ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
}

/** Límites de un mes "AAAA-MM": [primer día, primer día del siguiente mes). */
export function limitesMes(anioMes: string): { inicio: string; finExcl: string } {
  const [a, m] = anioMes.split("-").map(Number);
  const inicio = `${a}-${pad(m)}-01`;
  const na = m === 12 ? a + 1 : a;
  const nm = m === 12 ? 1 : m + 1;
  return { inicio, finExcl: `${na}-${pad(nm)}-01` };
}

export type ResultadoCalculo =
  | { ok: false; motivo: string }
  | {
      ok: true;
      periodoId: number;
      anioMes: string;
      lineas: number;
      totales: { comisiones: number; fondo: number; retenidas: number };
    };

/** ¿El error dice que falta una tabla CORE del módulo? → responde `sin_migracion`. */
function faltaModulo(e: any): boolean {
  return (
    tablaFaltante(e, "comisiones_parametros") ||
    tablaFaltante(e, "comisiones_periodo") ||
    tablaFaltante(e, "comisiones_linea")
  );
}

/** Lee todas las páginas de una consulta (PostgREST corta en 1000). Orden total obligatorio. */
async function todasLasPaginas(construir: (desde: number, hasta: number) => any): Promise<any[]> {
  const PASO = 1000;
  const filas: any[] = [];
  for (let desde = 0; ; desde += PASO) {
    const { data, error } = await construir(desde, desde + PASO - 1);
    if (error) throw error;
    const lote = (data as any[]) ?? [];
    filas.push(...lote);
    if (lote.length < PASO) break;
  }
  return filas;
}

// ─── Parámetros ───────────────────────────────────────────────────────────────

export async function cargarParametros(
  db: any,
): Promise<{ parametros: ParametroComision[]; idPorDesde: Map<string, number> }> {
  const { data, error } = await db
    .from("comisiones_parametros")
    .select(
      "id,vigente_desde,pct_eventual_tramo1,pct_eventual_tramo2,tramo_eventual_hasta," +
        "pct_fijo,pct_bono_arranque,arranque_split,arranque_mes_2da_parte,ventana_fijo_meses," +
        "ventana_cliente_nuevo_meses,tope_bono_atencion,indicadores_json,fondo_admin_por_eventual",
    )
    .order("vigente_desde", { ascending: true });
  if (error) throw error;
  const filas = (data as FilaParametros[]) ?? [];
  const idPorDesde = new Map<string, number>();
  const parametros = filas.map((f) => {
    const p = mapParametro(f);
    idPorDesde.set(p.vigente_desde, Number(f.id));
    return p;
  });
  return { parametros, idPorDesde };
}

// ─── Lista firmada ──────────────────────────────────────────────────────────

type ListaFirmada = { ids: Set<string>; rucs: Set<string>; nombres: Set<string> };

async function cargarListaFirmada(db: any): Promise<ListaFirmada> {
  const pedir = async (cols: string) => {
    const { data, error } = await db.from("comisiones_lista_clientes_existentes").select(cols);
    if (error) throw error;
    return (data as any[]) ?? [];
  };
  let filas: any[] = [];
  try {
    filas = await pedir("cliente_id,ruc,nombre");
  } catch (e: any) {
    // `cliente_id` es una FK de migración accesoria: si falta, se lee sin ella.
    if (!faltaColumna(e, "cliente_id")) throw e;
    filas = await pedir("ruc,nombre");
  }
  const ids = new Set<string>();
  const rucs = new Set<string>();
  const nombres = new Set<string>();
  for (const f of filas) {
    if (f.cliente_id != null) ids.add(String(f.cliente_id));
    if (f.ruc) rucs.add(String(f.ruc).trim());
    if (f.nombre) nombres.add(String(f.nombre).trim().toLowerCase());
  }
  return { ids, rucs, nombres };
}

// ─── Operadores corroborados del periodo ──────────────────────────────────────

async function cargarOperadoresCorroborados(db: any, periodoId: number | null): Promise<string[]> {
  if (periodoId == null) return [];
  const { data, error } = await db
    .from("comisiones_operacion_admin")
    .select("personal_administrativo_id")
    .eq("periodo_id", periodoId)
    .not("corroborado_en", "is", null);
  if (error) throw error;
  const set = new Set<string>();
  for (const r of (data as any[]) ?? []) {
    if (r.personal_administrativo_id != null) set.add(String(r.personal_administrativo_id));
  }
  return [...set];
}

// ─── Utilidad por reserva (v_utilidad_servicio) ───────────────────────────────

type UtilidadInfo = { utilidad: number; sinPresupuesto: boolean };

async function cargarUtilidades(db: any, reservaIds: number[]): Promise<Map<number, UtilidadInfo>> {
  const mapa = new Map<number, UtilidadInfo>();
  if (!reservaIds.length) return mapa;
  // En bloques, por si la lista es grande; cada bloque < 1000 ids en el `.in`.
  for (let i = 0; i < reservaIds.length; i += 500) {
    const bloque = reservaIds.slice(i, i + 500);
    const { data, error } = await db
      .from("v_utilidad_servicio")
      .select("reserva_id,utilidad_antes_impuestos,sin_presupuesto")
      .in("reserva_id", bloque);
    if (error) throw error;
    for (const r of (data as any[]) ?? []) {
      mapa.set(Number(r.reserva_id), {
        utilidad: Number(r.utilidad_antes_impuestos ?? 0),
        sinPresupuesto: r.sin_presupuesto === true,
      });
    }
  }
  return mapa;
}

// ─── Cotizaciones (vendedor, modo, cliente, fecha) ────────────────────────────

type InfoCot = { vendedorId: string | null; modoFijo: boolean; clienteId: string | null; fecha: string | null };

async function cargarCotizaciones(db: any, cotIds: number[]): Promise<Map<number, InfoCot>> {
  const mapa = new Map<number, InfoCot>();
  if (!cotIds.length) return mapa;
  const base = "id,modo_servicio,cliente_id,created_at";
  const pedir = async (cols: string, ids: number[]) => {
    const { data, error } = await db.from("cotizaciones").select(cols).in("id", ids);
    if (error) throw error;
    return (data as any[]) ?? [];
  };
  for (let i = 0; i < cotIds.length; i += 500) {
    const bloque = cotIds.slice(i, i + 500);
    let filas: any[] = [];
    try {
      filas = await pedir(`${base},vendedor_id`, bloque);
    } catch (e: any) {
      // `vendedor_id` es de `comisiones-02`: si falta, se degrada a sin vendedor.
      if (!faltaColumna(e, "vendedor_id")) throw e;
      filas = await pedir(base, bloque);
    }
    for (const r of filas) {
      mapa.set(Number(r.id), {
        vendedorId: r.vendedor_id != null ? String(r.vendedor_id) : null,
        modoFijo: String(r.modo_servicio ?? "") === "fijo",
        clienteId: r.cliente_id != null ? String(r.cliente_id) : null,
        fecha: fechaLimaDe(r.created_at),
      });
    }
  }
  return mapa;
}

// ─── Historial de clientes (ctx: lista firmada, previas, ancla) ───────────────

const COLS_RESERVA = "id,cliente_id,cotizacion_id,fecha_servicio,fecha_cobro,estado,estado_admin,tipo_servicio_detalle";

/**
 * Para cada cliente, su `ContextoCliente`: si está en lista firmada, la fecha de su cotización
 * de captación (la más antigua), las fechas de servicio PREVIAS a ella y el ancla (primer
 * servicio COBRADO, por fecha de servicio, sobre todo el historial).
 */
async function cargarHistorialClientes(
  db: any,
  clienteIds: string[],
  lista: ListaFirmada,
  cotPorCliente: Map<string, { fecha: string | null; nombre: string | null; ruc: string | null }>,
): Promise<Record<string, ContextoCliente>> {
  const ctx: Record<string, ContextoCliente> = {};
  if (!clienteIds.length) return ctx;

  const idsNum = clienteIds.map(Number).filter((n) => Number.isFinite(n));
  // Todas las reservas de estos clientes (cualquier fecha): el ancla y las «previas» son
  // globales. Paginado con orden total.
  const reservas = idsNum.length
    ? await todasLasPaginas((desde, hasta) =>
        db
          .from("reservas")
          .select("id,cliente_id,fecha_servicio,estado,estado_admin")
          .in("cliente_id", idsNum)
          .order("fecha_servicio", { ascending: true })
          .order("id", { ascending: true })
          .range(desde, hasta),
      )
    : [];

  const porCliente = new Map<string, any[]>();
  for (const r of reservas) {
    const k = String(r.cliente_id);
    (porCliente.get(k) ?? porCliente.set(k, []).get(k)!).push(r);
  }

  // Fecha de cotización de captación: la más antigua de las cotizaciones del cliente.
  const fechaCaptacion = new Map<string, string>();
  for (const [cliente, info] of cotPorCliente) {
    if (info.fecha) fechaCaptacion.set(cliente, info.fecha);
  }

  for (const cliente of clienteIds) {
    const filas = porCliente.get(cliente) ?? [];
    const nombre = cotPorCliente.get(cliente)?.nombre?.trim().toLowerCase() ?? null;
    const ruc = cotPorCliente.get(cliente)?.ruc?.trim() ?? null;
    const enLista =
      lista.ids.has(cliente) ||
      (ruc != null && lista.rucs.has(ruc)) ||
      (nombre != null && lista.nombres.has(nombre));

    // La fecha de cotización de captación; si no hay, se usa el primer servicio como
    // referencia (un cliente sin cotización registrada no puede probar que es nuevo).
    const fechaServicios = filas.map((r) => String(r.fecha_servicio ?? "")).filter(Boolean).sort();
    const fechaCot =
      fechaCaptacion.get(cliente) ?? (fechaServicios.length ? fechaServicios[0] : "9999-12-31");

    const previas = fechaServicios.filter((f) => f < fechaCot);

    // Ancla: primer servicio COBRADO por fecha de servicio.
    const cobradas = filas
      .filter((r) => String(r.estado_admin ?? "") === "cobrada")
      .map((r) => String(r.fecha_servicio ?? ""))
      .filter(Boolean)
      .sort();
    const ancla = cobradas.length ? cobradas[0] : null;

    ctx[cliente] = {
      enListaFirmada: enLista,
      fechasServicioPrevias: previas,
      fechaCotizacion: fechaCot,
      primerServicioCobradoFecha: ancla,
    };
  }
  return ctx;
}

// ─── Clasificaciones (reclamos, cancelaciones) para el bono ───────────────────

async function cargarClasificaciones(
  db: any,
  reservaIds: number[],
): Promise<{ reclamos: Map<number, FilaReclamo[]>; cancelaciones: Map<number, FilaCancelacion[]> }> {
  const reclamos = new Map<number, FilaReclamo[]>();
  const cancelaciones = new Map<number, FilaCancelacion[]>();
  if (!reservaIds.length) return { reclamos, cancelaciones };

  for (let i = 0; i < reservaIds.length; i += 500) {
    const bloque = reservaIds.slice(i, i + 500);
    const [rc, cc] = await Promise.all([
      db.from("comisiones_reclamos").select("reserva_id,gravedad,fundado,atribuible_vendedor").in("reserva_id", bloque),
      db.from("comisiones_cancelaciones").select("reserva_id,evitable,constancia_escrita").in("reserva_id", bloque),
    ]);
    if (rc.error) throw rc.error;
    if (cc.error) throw cc.error;
    for (const r of (rc.data as any[]) ?? []) {
      const k = Number(r.reserva_id);
      (reclamos.get(k) ?? reclamos.set(k, []).get(k)!).push(r);
    }
    for (const c of (cc.data as any[]) ?? []) {
      const k = Number(c.reserva_id);
      (cancelaciones.get(k) ?? cancelaciones.set(k, []).get(k)!).push(c);
    }
  }
  return { reclamos, cancelaciones };
}

// ─── El cargador central: arma `DatosCargados` del mes ────────────────────────

/**
 * Junta todo lo que el motor necesita para el mes `anioMes`. No corre el motor ni escribe:
 * lo hace `calcularPeriodo`. Separado para poder inspeccionar la entrada.
 */
export async function cargarDatosDelMes(
  db: any,
  anioMes: string,
  periodoId: number | null,
): Promise<DatosCargados> {
  const { inicio, finExcl } = limitesMes(anioMes);

  const { parametros } = await cargarParametros(db);

  // 1) Reservas COBRADAS con fecha_cobro dentro del mes (eventuales + tramos de fijo).
  const cobradasMes = await todasLasPaginas((desde, hasta) =>
    db
      .from("reservas")
      .select(COLS_RESERVA)
      .eq("estado_admin", "cobrada")
      .gte("fecha_cobro", inicio)
      .lt("fecha_cobro", finExcl)
      .order("fecha_cobro", { ascending: true })
      .order("id", { ascending: true })
      .range(desde, hasta),
  );

  // 2) Cotizaciones involucradas (para vendedor/modo/cliente/fecha).
  const cotIds = [...new Set(cobradasMes.map((r) => Number(r.cotizacion_id ?? 0)).filter(Boolean))];
  const cotInfo = await cargarCotizaciones(db, cotIds);

  // 3) Separar eventuales de contratos fijos. Un servicio es FIJO si su tipo lo dice o su
  //    cotización es `modo_servicio='fijo'` (la marca explícita del tipo gana, como en
  //    lib/liquidacion-clases.ts).
  const esFijo = (r: any): boolean => {
    const tipo = String(r.tipo_servicio_detalle ?? "");
    if (TIPOS_FIJO.has(tipo)) return true;
    const info = cotInfo.get(Number(r.cotizacion_id ?? 0));
    return info?.modoFijo === true;
  };

  const reservasEventuales = cobradasMes.filter((r) => !esFijo(r));
  const reservasFijoMes = cobradasMes.filter((r) => esFijo(r));

  // 4) Contratos fijos: su estructura mensual COMPLETA (todas las reservas del contrato,
  //    cualquier fecha) para la ventana, el bono de arranque y la cancelación.
  const contratoIds = [...new Set(reservasFijoMes.map((r) => Number(r.cotizacion_id ?? 0)).filter(Boolean))];
  const reservasContratos = contratoIds.length
    ? await todasLasPaginas((desde, hasta) =>
        db
          .from("reservas")
          .select(COLS_RESERVA)
          .in("cotizacion_id", contratoIds)
          .order("fecha_servicio", { ascending: true })
          .order("id", { ascending: true })
          .range(desde, hasta),
      )
    : [];

  // 5) Utilidad de TODAS las reservas que entran al cálculo (eventuales + las de contratos).
  const reservaIds = [
    ...new Set([
      ...reservasEventuales.map((r) => Number(r.id)),
      ...reservasContratos.map((r) => Number(r.id)),
    ]),
  ];
  const utilidades = await cargarUtilidades(db, reservaIds);

  // 6) Clientes involucrados + contexto (lista firmada, previas, ancla).
  const lista = await cargarListaFirmada(db);
  const clienteIds = [
    ...new Set(
      [...reservasEventuales, ...reservasContratos]
        .map((r) => (r.cliente_id != null ? String(r.cliente_id) : null))
        .filter((x): x is string => x != null),
    ),
  ];
  // La cotización de captación por cliente: la más antigua. (Nombre/ruc del cliente para
  // casar la lista firmada se traen de `clientes` aparte, best-effort.)
  const cotPorCliente = new Map<string, { fecha: string | null; nombre: string | null; ruc: string | null }>();
  for (const [, info] of cotInfo) {
    if (!info.clienteId) continue;
    const prev = cotPorCliente.get(info.clienteId);
    if (!prev || (info.fecha && (!prev.fecha || info.fecha < prev.fecha))) {
      cotPorCliente.set(info.clienteId, { fecha: info.fecha, nombre: prev?.nombre ?? null, ruc: prev?.ruc ?? null });
    }
  }
  await anotarNombreRuc(db, clienteIds, cotPorCliente);
  const clientes = await cargarHistorialClientes(db, clienteIds, lista, cotPorCliente);

  // 7) Eventuales del mes → ServicioEventual con vendedor.
  const eventuales: ServicioConVendedor[] = reservasEventuales.map((r) => {
    const cot = cotInfo.get(Number(r.cotizacion_id ?? 0));
    const u = utilidades.get(Number(r.id)) ?? { utilidad: 0, sinPresupuesto: true };
    return {
      id: Number(r.id),
      clienteId: String(r.cliente_id ?? ""),
      fechaCobro: fechaLimaDe(r.fecha_cobro) ?? inicio,
      fechaServicio: String(r.fecha_servicio ?? inicio),
      utilidad: u.utilidad,
      tienePresupuesto: !u.sinPresupuesto,
      cobrado: true,
      vendedorId: cot?.vendedorId ?? null,
      cotizacionId: Number(r.cotizacion_id ?? 0) || null,
    };
  });

  // 8) Contratos fijos → ContratoFijo con meses agregados desde v_utilidad_servicio.
  const contratos = armarContratosFijos(reservasContratos, cotInfo, utilidades, inicio);

  // 9) Bono de atención por vendedor: reclamos/cancelaciones de las reservas del mes.
  const idsEventualesMes = reservasEventuales.map((r) => Number(r.id));
  const idsFijoMes = reservasFijoMes.map((r) => Number(r.id));
  const { reclamos, cancelaciones } = await cargarClasificaciones(db, [...idsEventualesMes, ...idsFijoMes]);
  const montosInd = parametros.length ? (await traerIndicadoresJson(db)) : null;

  // Agrupar clasificaciones por vendedor (vía la cotización de la reserva).
  const vendedorDeReserva = new Map<number, string | null>();
  for (const r of [...reservasEventuales, ...reservasFijoMes]) {
    vendedorDeReserva.set(Number(r.id), cotInfo.get(Number(r.cotizacion_id ?? 0))?.vendedorId ?? null);
  }
  const reclamosVend = new Map<string, FilaReclamo[]>();
  const cancelVend = new Map<string, FilaCancelacion[]>();
  for (const [rid, rs] of reclamos) {
    const v = vendedorDeReserva.get(rid);
    if (v) (reclamosVend.get(v) ?? reclamosVend.set(v, []).get(v)!).push(...rs);
  }
  for (const [rid, cs] of cancelaciones) {
    const v = vendedorDeReserva.get(rid);
    if (v) (cancelVend.get(v) ?? cancelVend.set(v, []).get(v)!).push(...cs);
  }

  // Un bono por vendedor ACTIVO este mes (tuvo algún servicio cobrado).
  const vendedoresActivos = new Set<string>();
  for (const e of eventuales) if (e.vendedorId) vendedoresActivos.add(e.vendedorId);
  for (const c of contratos) if (c.vendedorId) vendedoresActivos.add(c.vendedorId);
  const bonoPorVendedor: Record<string, EntradaBonoAtencion> = {};
  for (const v of vendedoresActivos) {
    bonoPorVendedor[v] = {
      indicadores: indicadoresDeVendedor(montosInd, reclamosVend.get(v) ?? [], cancelVend.get(v) ?? []),
      fecha: `${anioMes}-${pad(ultimoDiaDelMes(anioMes))}`,
    };
  }

  const operadoresCorroborados = await cargarOperadoresCorroborados(db, periodoId);

  return { parametros, eventuales, contratos, clientes, operadoresCorroborados, bonoPorVendedor };
}

const TIPOS_FIJO: ReadonlySet<string> = new Set([
  "transporte_personal",
  "fijo_solo_ida",
  "fijo_multiparada",
  "fijo_reten",
]);

function ultimoDiaDelMes(anioMes: string): number {
  const [a, m] = anioMes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/** Los montos de los 7 indicadores (indicadores_json de la fila vigente más reciente). */
async function traerIndicadoresJson(db: any): Promise<Record<string, number> | null> {
  const { data } = await db
    .from("comisiones_parametros")
    .select("indicadores_json")
    .order("vigente_desde", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.indicadores_json as Record<string, number> | undefined) ?? null;
}

/** Completa nombre/ruc del cliente (para casar la lista firmada). Best-effort. */
async function anotarNombreRuc(
  db: any,
  clienteIds: string[],
  destino: Map<string, { fecha: string | null; nombre: string | null; ruc: string | null }>,
): Promise<void> {
  if (!clienteIds.length) return;
  try {
    const idsNum = clienteIds.map(Number).filter((n) => Number.isFinite(n));
    if (!idsNum.length) return;
    const { data } = await db.from("clientes").select("id,nombre,ruc").in("id", idsNum);
    for (const c of (data as any[]) ?? []) {
      const k = String(c.id);
      const prev = destino.get(k) ?? { fecha: null, nombre: null, ruc: null };
      destino.set(k, { fecha: prev.fecha, nombre: c.nombre ?? null, ruc: c.ruc ?? null });
    }
  } catch {
    // Sin nombre/ruc solo se pierde el casado por texto de la lista firmada (queda el id).
  }
}

/**
 * Agrupa las reservas de cada contrato fijo por MES de servicio y arma los `MesFijo`.
 *
 * LA UTILIDAD DEL MES ES LA SUMA de `utilidad_antes_impuestos` de sus reservas cobradas
 * —no se recalcula nada—. Un mes es `cobrado` cuando toda reserva no cancelada del mes está
 * en `estado_admin='cobrada'`; así el 10 % no se devenga hasta que el mes se cobró completo.
 * `tienePresupuesto` = ninguna de sus cobradas `sin_presupuesto`. `canceladoEnMes` queda
 * null (la base no marca la cancelación del CONTRATO; SUPUESTO declarado).
 */
export function armarContratosFijos(
  reservas: any[],
  cotInfo: Map<number, InfoCot>,
  utilidades: Map<number, UtilidadInfo>,
  inicioMes: string,
): ContratoConVendedor[] {
  const porContrato = new Map<number, any[]>();
  for (const r of reservas) {
    const k = Number(r.cotizacion_id ?? 0);
    if (!k) continue;
    (porContrato.get(k) ?? porContrato.set(k, []).get(k)!).push(r);
  }

  const contratos: ContratoConVendedor[] = [];
  for (const [contratoId, filas] of porContrato) {
    const info = cotInfo.get(contratoId);
    // Agrupar por "AAAA-MM" de servicio.
    const porMes = new Map<string, any[]>();
    for (const r of filas) {
      const ym = String(r.fecha_servicio ?? "").slice(0, 7);
      if (!ym) continue;
      (porMes.get(ym) ?? porMes.set(ym, []).get(ym)!).push(r);
    }
    const ymsOrdenados = [...porMes.keys()].sort();
    const meses: MesFijo[] = ymsOrdenados.map((ym, i) => {
      const grupo = porMes.get(ym)!;
      const noCanceladas = grupo.filter((r) => String(r.estado ?? "") !== "cancelada");
      const cobradas = noCanceladas.filter((r) => String(r.estado_admin ?? "") === "cobrada");
      const cobrado = noCanceladas.length > 0 && cobradas.length === noCanceladas.length;
      const utilidad = cobradas.reduce((a, r) => a + (utilidades.get(Number(r.id))?.utilidad ?? 0), 0);
      const sinPresup = cobradas.some((r) => utilidades.get(Number(r.id))?.sinPresupuesto === true);
      const fechasCobro = cobradas
        .map((r) => fechaLimaDe(r.fecha_cobro))
        .filter((x): x is string => x != null)
        .sort();
      const fechaServicio = grupo
        .map((r) => String(r.fecha_servicio ?? ""))
        .filter(Boolean)
        .sort()[0] ?? `${ym}-01`;
      return {
        mes: i + 1,
        fechaCobro: fechasCobro[0] ?? `${ym}-01`,
        fechaServicio,
        utilidad: Math.round(utilidad * 100) / 100,
        cobrado,
        tienePresupuesto: cobradas.length > 0 && !sinPresup,
      };
    });
    contratos.push({
      id: contratoId,
      clienteId: info?.clienteId ?? String(filas[0]?.cliente_id ?? ""),
      meses,
      canceladoEnMes: null,
      vendedorId: info?.vendedorId ?? null,
    });
  }
  return contratos;
}

// ─── El orquestador: calcular y persistir ─────────────────────────────────────

/**
 * Calcula (o recalcula) el periodo PRELIMINAR del mes y lo persiste en `comisiones_periodo`
 * + `comisiones_linea`. Un mes `cerrado` NO se recalcula. Degrada con `sin_migracion` si
 * falta una tabla core del módulo.
 */
export async function calcularPeriodo(db: any, anioMes: string): Promise<ResultadoCalculo> {
  if (!/^\d{4}-\d{2}$/.test(anioMes)) return { ok: false, motivo: "anio_mes_invalido" };

  try {
    // 1) El periodo. Si existe y está CERRADO, no se toca.
    const { data: existente, error: eSel } = await db
      .from("comisiones_periodo")
      .select("id,estado")
      .eq("anio_mes", anioMes)
      .maybeSingle();
    if (eSel) throw eSel;
    if (existente?.estado === "cerrado") {
      return { ok: false, motivo: "periodo_cerrado" };
    }

    let periodoId: number;
    if (existente?.id) {
      periodoId = Number(existente.id);
    } else {
      const { data: creado, error: eIns } = await db
        .from("comisiones_periodo")
        .insert({ anio_mes: anioMes, estado: "preliminar" })
        .select("id")
        .single();
      if (eIns) throw eIns;
      periodoId = Number(creado.id);
    }

    // 2) Cargar y calcular.
    const { parametros, idPorDesde } = await cargarParametros(db);
    const datos = await cargarDatosDelMes(db, anioMes, periodoId);
    datos.parametros = parametros;
    const lineas = calcularLineas(datos, anioMes);

    // 3) Reemplazar las líneas preliminares del periodo (recalc idempotente).
    const { error: eDel } = await db.from("comisiones_linea").delete().eq("periodo_id", periodoId);
    if (eDel) throw eDel;

    // 4) Insertar las nuevas.
    const filas = lineas.map((l) => filaDeLinea(l, periodoId, idPorDesde));
    let insertadas = 0;
    for (let i = 0; i < filas.length; i += 200) {
      const lote = filas.slice(i, i + 200);
      const { error } = await db.from("comisiones_linea").insert(lote);
      if (error) throw error;
      insertadas += lote.length;
    }

    // 5) Sellar el periodo como calculado.
    const { error: eUpd } = await db
      .from("comisiones_periodo")
      .update({ calculado_en: new Date().toISOString() })
      .eq("id", periodoId);
    if (eUpd) throw eUpd;

    // Totales (sumados de las líneas, no de un segundo motor).
    let comisiones = 0;
    let fondo = 0;
    let retenidas = 0;
    for (const l of lineas) {
      if (l.regla === "fondo_admin") {
        if (l.monto) fondo += l.monto;
      } else if (l.codigo === "pagar" && l.monto) {
        comisiones += l.monto;
      } else if (l.codigo === "retenido_falta_costear" && l.tasa != null) {
        retenidas += l.base * l.tasa;
      }
    }

    return {
      ok: true,
      periodoId,
      anioMes,
      lineas: insertadas,
      totales: {
        comisiones: Math.round(comisiones * 100) / 100,
        fondo: Math.round(fondo * 100) / 100,
        retenidas: Math.round(retenidas * 100) / 100,
      },
    };
  } catch (e: any) {
    if (faltaModulo(e)) {
      return { ok: false, motivo: "sin_migracion: falta correr supabase/comisiones-01..04.sql" };
    }
    throw e;
  }
}

/** Una `LineaComision` del motor → una fila de `comisiones_linea`. */
function filaDeLinea(l: LineaComision, periodoId: number, idPorDesde: Map<string, number>): Record<string, unknown> {
  const esFondo = l.regla === "fondo_admin";
  return {
    periodo_id: periodoId,
    vendedor_id: l.vendedorId ?? null,
    tipo: tipoDeRegla(l.regla),
    reserva_id: l.servicioId != null ? Number(l.servicioId) : null,
    cliente_id: l.clienteId != null && l.clienteId !== "" ? Number(l.clienteId) : null,
    cotizacion_id: l.contratoId != null ? Number(l.contratoId) : null,
    personal_administrativo_id: esFondo && l.operadorId != null ? Number(l.operadorId) : null,
    base_utilidad: esFondo ? null : l.base,
    pct_aplicado: l.tasa ?? null,
    // monto null (retenido/sin_parametros) → 0 en la columna; el `codigo` de la traza lo dice.
    monto: l.monto ?? 0,
    fecha_cobro_origen: l.fechaCobro ?? null,
    orden_eventual: l.posicion ?? null,
    parametros_id: l.parametroDesde ? idPorDesde.get(l.parametroDesde) ?? null : null,
    traza_json: {
      codigo: l.codigo,
      regla: l.regla,
      base: l.base,
      tasa: l.tasa,
      monto: l.monto,
      detalle: l.detalle,
    },
    estado: "preliminar",
  };
}
