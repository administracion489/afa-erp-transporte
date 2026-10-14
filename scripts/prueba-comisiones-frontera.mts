// Matriz de la FRONTERA de comisiones (lib/comisiones/datos.ts). No toca una base real:
// usa un cliente de Supabase FALSO en memoria (mini-PostgREST), como `lib/ocupacion/datos.ts`
// permite inyectar `db`. Uso:  npx tsx scripts/prueba-comisiones-frontera.mts
//
// Cubre:
//   A) tocaHoy / esUltimoDiaDelMes (lo que decide el cron preliminar).
//   B) mapParametro: la fila de `comisiones_parametros` → ParametroComision del motor.
//   C) indicadoresDeVendedor: el bono paga ante la duda; solo un reclamo grave+fundado+
//      atribuible lo rompe.
//   D) armarEntradas / calcularLineas: agrupar por vendedor, el fondo de periodo, el filtro
//      por mes (una línea de un mes pasado no se persiste este mes), el tramo por vendedor.
//   E) cargarDatosDelMes + calcularPeriodo de punta a punta contra el cliente falso.

import {
  mapParametro,
  indicadoresDeVendedor,
  armarEntradas,
  calcularLineas,
  cargarDatosDelMes,
  calcularPeriodo,
  type DatosCargados,
  type FilaParametros,
  SIN_VENDEDOR,
} from "../lib/comisiones/datos";
import { cumpleIndicador } from "../lib/comisiones/bono-atencion";
import { esUltimoDiaDelMes, tocaHoy } from "../lib/ocupacion/cadencia";
import type { ContextoCliente } from "../lib/comisiones/cliente-nuevo";
import type { ParametroComision } from "../lib/comisiones/tipos";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ══════════════════════════════════════════════════════════════════════════════
// Cliente Supabase FALSO (mini-PostgREST en memoria).
// ══════════════════════════════════════════════════════════════════════════════

type Fila = Record<string, any>;
class Tabla {
  rows: Fila[] = [];
  seq = 0;
}
class Query {
  private filtros: ((r: Fila) => boolean)[] = [];
  private orden: [string, boolean][] = [];
  private rango: [number, number] | null = null;
  private lim: number | null = null;
  private modo: "select" | "insert" | "update" | "delete" = "select";
  private payload: any = null;

  constructor(private tabla: Tabla) {}

  select() { return this; }
  insert(v: any) { this.modo = "insert"; this.payload = v; return this; }
  update(v: any) { this.modo = "update"; this.payload = v; return this; }
  delete() { this.modo = "delete"; return this; }

  eq(c: string, v: any) { this.filtros.push((r) => String(r[c]) === String(v)); return this; }
  in(c: string, vs: any[]) { const s = new Set(vs.map(String)); this.filtros.push((r) => s.has(String(r[c]))); return this; }
  gte(c: string, v: any) { this.filtros.push((r) => String(r[c]) >= String(v)); return this; }
  lt(c: string, v: any) { this.filtros.push((r) => String(r[c]) < String(v)); return this; }
  is(c: string, v: any) { if (v === null) this.filtros.push((r) => r[c] == null); return this; }
  not(c: string, op: string, v: any) { if (op === "is" && v === null) this.filtros.push((r) => r[c] != null); return this; }
  order(c: string, opt?: { ascending?: boolean }) { this.orden.push([c, opt?.ascending !== false]); return this; }
  range(a: number, b: number) { this.rango = [a, b]; return this; }
  limit(n: number) { this.lim = n; return this; }

  private matched(): Fila[] { return this.tabla.rows.filter((r) => this.filtros.every((f) => f(r))); }

  private run(): { data: any; error: any } {
    if (this.modo === "insert") {
      const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
      const creados = arr.map((row: Fila) => {
        const f = { ...row };
        if (f.id == null) f.id = ++this.tabla.seq;
        this.tabla.rows.push(f);
        return f;
      });
      return { data: creados, error: null };
    }
    if (this.modo === "delete") {
      const quitar = new Set(this.matched());
      this.tabla.rows = this.tabla.rows.filter((r) => !quitar.has(r));
      return { data: null, error: null };
    }
    if (this.modo === "update") {
      const m = this.matched();
      for (const r of m) Object.assign(r, this.payload);
      return { data: m, error: null };
    }
    let r = this.matched();
    for (const [c, asc] of this.orden) {
      r = [...r].sort((x, y) => (x[c] > y[c] ? 1 : x[c] < y[c] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this.rango) r = r.slice(this.rango[0], this.rango[1] + 1);
    if (this.lim != null) r = r.slice(0, this.lim);
    return { data: r, error: null };
  }

  then(res: (v: { data: any; error: any }) => void) { res(this.run()); }
  maybeSingle() { const { data } = this.run(); return Promise.resolve({ data: (data as Fila[])[0] ?? null, error: null }); }
  single() {
    const { data } = this.run();
    const first = this.modo === "insert" ? data[0] : (data as Fila[])[0];
    return Promise.resolve({ data: first ?? null, error: null });
  }
}
class DBFalsa {
  tablas = new Map<string, Tabla>();
  constructor(seed: Record<string, Fila[]>) {
    for (const [k, v] of Object.entries(seed)) {
      const t = new Tabla();
      t.rows = v.map((r) => ({ ...r }));
      t.seq = v.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
      this.tablas.set(k, t);
    }
  }
  tabla(n: string) { if (!this.tablas.has(n)) this.tablas.set(n, new Tabla()); return this.tablas.get(n)!; }
  from(n: string) { return new Query(this.tabla(n)); }
  storage = { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) };
}

// ══════════════════════════════════════════════════════════════════════════════
// A) tocaHoy / esUltimoDiaDelMes
// ══════════════════════════════════════════════════════════════════════════════

chk("esUltimoDiaDelMes 2026-10-31", esUltimoDiaDelMes("2026-10-31") === true);
chk("esUltimoDiaDelMes 2026-10-30 (no)", esUltimoDiaDelMes("2026-10-30") === false);
chk("esUltimoDiaDelMes feb bisiesto 2028-02-29", esUltimoDiaDelMes("2028-02-29") === true);
chk("esUltimoDiaDelMes feb 2026-02-28", esUltimoDiaDelMes("2026-02-28") === true);
chk("tocaHoy fin_de_mes = esUltimoDiaDelMes", tocaHoy("fin_de_mes", "2026-11-30") === true && tocaHoy("fin_de_mes", "2026-11-29") === false);

// ══════════════════════════════════════════════════════════════════════════════
// B) mapParametro
// ══════════════════════════════════════════════════════════════════════════════

const FILA_PARAM: FilaParametros = {
  id: 7,
  vigente_desde: "2026-01-01",
  pct_eventual_tramo1: 0.2,
  pct_eventual_tramo2: 0.12,
  tramo_eventual_hasta: 30,
  pct_fijo: 0.1,
  pct_bono_arranque: 0.3,
  arranque_split: [0.5, 0.5],
  arranque_mes_2da_parte: 3,
  ventana_fijo_meses: 12,
  ventana_cliente_nuevo_meses: 12,
  tope_bono_atencion: 150,
  indicadores_json: { rapidez: 20, tolerancia_rapidez: 0.9 },
  fondo_admin_por_eventual: 4,
};
const P = mapParametro(FILA_PARAM);
chk("mapParametro tramos", P.tramosEventual[0].hasta === 30 && P.tramosEventual[0].tasa === 0.2 && P.tramosEventual[1].hasta === null && P.tramosEventual[1].tasa === 0.12);
chk("mapParametro mitades desde arranque_split + mes_2da_parte",
  JSON.stringify(P.mitadesBonoArranque) === JSON.stringify([{ mes: 1, fraccion: 0.5 }, { mes: 3, fraccion: 0.5 }]));
chk("mapParametro tasaFijo / fondo / tope / tolerancia",
  P.tasaFijo === 0.1 && P.montoFondoPorEventual === 4 && P.topeBonoAtencion === 150 && P.toleranciaRapidez === 0.9);
chk("mapParametro ventana (del fijo)", P.ventanaMeses === 12);
// Split de tres tercios con 2da parte en mes 4.
const P3 = mapParametro({ ...FILA_PARAM, arranque_split: [0.4, 0.6], arranque_mes_2da_parte: 4 });
chk("mapParametro split 40/60 + mes 4",
  JSON.stringify(P3.mitadesBonoArranque) === JSON.stringify([{ mes: 1, fraccion: 0.4 }, { mes: 4, fraccion: 0.6 }]));

// ══════════════════════════════════════════════════════════════════════════════
// C) indicadoresDeVendedor
// ══════════════════════════════════════════════════════════════════════════════

const MONTOS = { rapidez: 20, cero_quejas: 20, sin_cancelaciones: 20, seguimiento: 25, registros: 20, precios: 15, documentacion: 30 };
const indSinNada = indicadoresDeVendedor(MONTOS, [], []);
chk("indicadores: 7 indicadores", indSinNada.length === 7);
chk("indicadores: sin eventos todos cumplidos", indSinNada.every((i) => cumpleIndicador(i, 0.9).cumplido));

// Un reclamo grave+fundado+atribuible ROMPE cero_quejas; uno no atribuible NO.
const rompe = indicadoresDeVendedor(MONTOS, [{ gravedad: "grave", fundado: true, atribuible_vendedor: true }], []);
const quejas = rompe.find((i) => i.clave === "cero_quejas")!;
chk("indicadores: reclamo grave+fundado+atribuible rompe cero_quejas", cumpleIndicador(quejas, 0.9).cumplido === false);

const noAtrib = indicadoresDeVendedor(MONTOS, [{ gravedad: "grave", fundado: true, atribuible_vendedor: false }], []);
chk("indicadores: reclamo no atribuible NO rompe (paga ante la duda)",
  cumpleIndicador(noAtrib.find((i) => i.clave === "cero_quejas")!, 0.9).cumplido === true);

// Una cancelación evitable con constancia rompe sin_cancelaciones.
const cancel = indicadoresDeVendedor(MONTOS, [], [{ evitable: true, constancia_escrita: true }]);
chk("indicadores: cancelación evitable+constancia rompe sin_cancelaciones",
  cumpleIndicador(cancel.find((i) => i.clave === "sin_cancelaciones")!, 0.9).cumplido === false);

// ══════════════════════════════════════════════════════════════════════════════
// D) armarEntradas / calcularLineas (puro)
// ══════════════════════════════════════════════════════════════════════════════

const PARAMS: ParametroComision[] = [P];
const ctx = (over: Partial<ContextoCliente> = {}): ContextoCliente => ({
  enListaFirmada: false,
  fechasServicioPrevias: [],
  fechaCotizacion: "2026-03-01",
  primerServicioCobradoFecha: "2026-03-05",
  ...over,
});

// Dos vendedores, cada uno con un eventual elegible del mismo cliente NUEVO.
const datos: DatosCargados = {
  parametros: PARAMS,
  eventuales: [
    { id: 101, clienteId: "C1", fechaCobro: "2026-03-10", fechaServicio: "2026-03-05", utilidad: 1000, tienePresupuesto: true, cobrado: true, vendedorId: "V1", cotizacionId: 1 },
    { id: 102, clienteId: "C1", fechaCobro: "2026-03-12", fechaServicio: "2026-03-06", utilidad: 500, tienePresupuesto: true, cobrado: true, vendedorId: "V2", cotizacionId: 2 },
    { id: 103, clienteId: "C1", fechaCobro: "2026-03-13", fechaServicio: "2026-03-07", utilidad: 800, tienePresupuesto: false, cobrado: true, vendedorId: "V1", cotizacionId: 1 },
  ],
  contratos: [],
  clientes: { C1: ctx() },
  operadoresCorroborados: ["OP9"],
  bonoPorVendedor: {},
};

const { porVendedor, fondo } = armarEntradas(datos);
chk("armarEntradas: una entrada por vendedor", porVendedor.length === 2 && porVendedor.every((e) => e.vendedorId === "V1" || e.vendedorId === "V2"));
chk("armarEntradas: entradas por vendedor NO llevan operadores (fondo apagado)",
  porVendedor.every((e) => (e.entrada.operadoresCorroborados ?? []).length === 0));
chk("armarEntradas: la entrada del fondo lleva todos los eventuales y los operadores",
  (fondo.eventuales ?? []).length === 3 && JSON.stringify(fondo.operadoresCorroborados) === JSON.stringify(["OP9"]));

const lineasMarzo = calcularLineas(datos, "2026-03");
const pagaV1 = lineasMarzo.find((l) => l.regla === "eventual" && l.servicioId === 101);
const retV1 = lineasMarzo.find((l) => l.regla === "eventual" && l.servicioId === 103);
const pagaV2 = lineasMarzo.find((l) => l.regla === "eventual" && l.servicioId === 102);
chk("calcularLineas: V1 #101 paga 20% de 1000 = 200", pagaV1?.monto === 200 && pagaV1?.codigo === "pagar");
chk("calcularLineas: V1 #103 RETENIDO (sin presupuesto, monto null)", retV1?.codigo === "retenido_falta_costear" && retV1?.monto === null);
chk("calcularLineas: V2 #102 paga 20% de 500 = 100 (tramo por vendedor, no global)", pagaV2?.monto === 100 && pagaV2?.posicion === 1);

// El FONDO: 3 eventuales nuevos × 4 = 12, entre 1 operador → una línea de 12 a OP9.
const fondoLineas = lineasMarzo.filter((l) => l.regla === "fondo_admin");
chk("calcularLineas: fondo 3×4=12 a un operador", fondoLineas.length === 1 && fondoLineas[0].monto === 12 && fondoLineas[0].operadorId === "OP9");
chk("calcularLineas: NO hay líneas de fondo duplicadas por vendedor", fondoLineas.length === 1);

// Filtro por mes: un contrato fijo cuyo mes 1 se cobró en FEBRERO no debe dar línea en marzo,
// pero su mes 2 cobrado en marzo sí. (Mes 1 fuera del periodo; mes 2 dentro.)
const datosFijo: DatosCargados = {
  parametros: PARAMS,
  eventuales: [],
  contratos: [{
    id: 55, clienteId: "C2", vendedorId: "V1", canceladoEnMes: null,
    meses: [
      { mes: 1, fechaCobro: "2026-02-10", fechaServicio: "2026-02-01", utilidad: 2100, cobrado: true, tienePresupuesto: true },
      { mes: 2, fechaCobro: "2026-03-10", fechaServicio: "2026-03-01", utilidad: 2000, cobrado: true, tienePresupuesto: true },
    ],
  }],
  clientes: { C2: ctx({ fechaCotizacion: "2026-01-15", primerServicioCobradoFecha: "2026-02-01" }) },
  operadoresCorroborados: [],
  bonoPorVendedor: {},
};
const lineasMar = calcularLineas(datosFijo, "2026-03");
const fijoFeb = lineasMar.find((l) => l.regla === "fijo_mensual" && l.fechaCobro === "2026-02-10");
const fijoMar = lineasMar.find((l) => l.regla === "fijo_mensual" && l.fechaCobro === "2026-03-10");
chk("calcularLineas: el fijo del mes 1 (cobro de FEBRERO) NO sale en marzo", fijoFeb === undefined);
chk("calcularLineas: el fijo del mes 2 (cobro de MARZO) sí, 10% de 2000 = 200", fijoMar?.monto === 200);
// El bono de arranque: 1ª mitad con cobro de feb (fuera de marzo), 2ª mitad dispara con mes 3
// (aún no cobrado) → pendiente, sin fecha → no se persiste en marzo.
const bonosMar = lineasMar.filter((l) => l.regla === "bono_arranque");
chk("calcularLineas: bono de arranque no persiste en marzo (1ª mitad fue feb, 2ª pendiente)", bonosMar.length === 0);

// ══════════════════════════════════════════════════════════════════════════════
// E) cargarDatosDelMes + calcularPeriodo de punta a punta (cliente falso)
// ══════════════════════════════════════════════════════════════════════════════

const db = new DBFalsa({
  comisiones_parametros: [FILA_PARAM],
  comisiones_periodo: [],
  comisiones_linea: [],
  comisiones_lista_clientes_existentes: [],
  comisiones_operacion_admin: [],
  comisiones_reclamos: [],
  comisiones_cancelaciones: [],
  clientes: [{ id: 1, nombre: "Cliente Nuevo SAC", ruc: "20111111111" }],
  cotizaciones: [
    { id: 1001, modo_servicio: "eventual", cliente_id: 1, created_at: "2026-03-01T12:00:00Z", vendedor_id: "VEND-A" },
    { id: 1002, modo_servicio: "eventual", cliente_id: 1, created_at: "2026-03-02T12:00:00Z", vendedor_id: "VEND-B" },
  ],
  reservas: [
    // Dos eventuales cobrados en marzo, cliente NUEVO (sin servicios previos).
    { id: 5001, cliente_id: 1, cotizacion_id: 1001, fecha_servicio: "2026-03-05", fecha_cobro: "2026-03-10T09:00:00Z", estado: "finalizada", estado_admin: "cobrada", tipo_servicio_detalle: "turismo" },
    { id: 5002, cliente_id: 1, cotizacion_id: 1002, fecha_servicio: "2026-03-06", fecha_cobro: "2026-03-12T09:00:00Z", estado: "finalizada", estado_admin: "cobrada", tipo_servicio_detalle: "turismo" },
    // Uno finalizado pero NO cobrado: no entra.
    { id: 5003, cliente_id: 1, cotizacion_id: 1001, fecha_servicio: "2026-03-20", fecha_cobro: null, estado: "finalizada", estado_admin: "por_liquidar", tipo_servicio_detalle: "turismo" },
  ],
  v_utilidad_servicio: [
    { reserva_id: 5001, utilidad_antes_impuestos: 1000, sin_presupuesto: false },
    { reserva_id: 5002, utilidad_antes_impuestos: 500, sin_presupuesto: false },
    { reserva_id: 5003, utilidad_antes_impuestos: 300, sin_presupuesto: false },
  ],
});

const run = async () => {
  const d = await cargarDatosDelMes(db as any, "2026-03", null);
  chk("cargarDatosDelMes: 2 eventuales cobrados (el no cobrado no entra)", d.eventuales.length === 2);
  chk("cargarDatosDelMes: vendedor resuelto desde la cotización", d.eventuales.some((e) => e.vendedorId === "VEND-A") && d.eventuales.some((e) => e.vendedorId === "VEND-B"));
  chk("cargarDatosDelMes: utilidad desde v_utilidad_servicio", (d.eventuales.find((e) => e.id === 5001)?.utilidad) === 1000);
  const ctxC = d.clientes["1"];
  chk("cargarDatosDelMes: contexto del cliente nuevo (no en lista, sin previas)", !!ctxC && ctxC.enListaFirmada === false && ctxC.fechasServicioPrevias.length === 0);
  chk("cargarDatosDelMes: ancla = primer servicio cobrado por fecha de servicio (2026-03-05)", ctxC.primerServicioCobradoFecha === "2026-03-05");
  chk("cargarDatosDelMes: sin operadores corroborados (periodo null)", d.operadoresCorroborados.length === 0);
  chk("cargarDatosDelMes: un bono por cada vendedor activo", Object.keys(d.bonoPorVendedor).length === 2);

  // calcularPeriodo persiste y es idempotente.
  const r1 = await calcularPeriodo(db as any, "2026-03");
  chk("calcularPeriodo: ok", r1.ok === true);
  if (r1.ok) {
    // 2 eventuales (20% de 1000 y 500) = 200 + 100 = 300; más 2 bonos de atención (150 c/u)
    // que se pagan ante la duda. comisiones = 300 + 300 = 600.
    chk("calcularPeriodo: comisiones = 600 (300 eventual + 300 bono)", r1.totales.comisiones === 600, `got ${r1.totales.comisiones}`);
    // El fondo PENDIENTE lleva el total (2 eventuales × 4 = 8) retenido hasta corroborar.
    chk("calcularPeriodo: fondo = 8 pendiente de reparto (sin operadores corroborados)", r1.totales.fondo === 8, `got ${r1.totales.fondo}`);
    const lineasBD = db.tabla("comisiones_linea").rows;
    chk("calcularPeriodo: líneas persistidas", lineasBD.length === r1.lineas && lineasBD.length > 0);
    chk("calcularPeriodo: hay una línea de fondo pendiente de corroboración",
      lineasBD.some((l) => l.tipo === "fondo_admin" && (l.traza_json?.codigo) === "fondo_pendiente_corroboracion"));
    chk("calcularPeriodo: cada línea guarda parametros_id (snapshot)",
      lineasBD.filter((l) => l.tipo !== "fondo_admin").every((l) => l.parametros_id === 7));
  }

  // Recalc: no duplica líneas.
  const antes = db.tabla("comisiones_linea").rows.length;
  const r2 = await calcularPeriodo(db as any, "2026-03");
  chk("calcularPeriodo: recalc idempotente (mismo número de líneas)", r2.ok && db.tabla("comisiones_linea").rows.length === antes);

  // Un periodo CERRADO no se recalcula.
  db.tabla("comisiones_periodo").rows[0].estado = "cerrado";
  const r3 = await calcularPeriodo(db as any, "2026-03");
  chk("calcularPeriodo: periodo cerrado no se recalcula", r3.ok === false && (r3 as any).motivo === "periodo_cerrado");

  console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
  process.exit(fallos === 0 ? 0 : 1);
};

run();
