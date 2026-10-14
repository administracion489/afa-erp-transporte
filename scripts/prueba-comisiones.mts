// Matriz del MOTOR DE COMISIONES. No toca la base ni mira el reloj: funciones puras en
// memoria. Uso:  npx tsx scripts/prueba-comisiones.mts   (sale con código 1 si algo falla)
//
// Dos partes:
//   A) Los 14 CASOS de la especificación del dueño, transcritos LITERALES con su resultado
//      esperado exacto.
//   B) Invariantes por BARRIDO: la frontera 30→31, el reinicio mensual del contador, el
//      orden por fecha de cobro y luego id, el bono de arranque cancelado, la lista firmada,
//      el tope del bono de atención, y la clasificación del reclamo.
//
// EL LADO QUE NO SE PUEDE AFLOJAR: una comisión legítima nunca desaparece. Un motor que
// devolviera [] pasaría cualquier invariante de forma trivial, así que la sección final
// exige que el motor SÍ produzca montos — y lo exige con un corolario explícito.

import { parametrosVigentes } from "../lib/comisiones/parametros";
import { tasaDeTramo, comisionarEventuales } from "../lib/comisiones/eventual";
import { comisionarFijo } from "../lib/comisiones/fijo";
import { comisionarBonoArranque } from "../lib/comisiones/bono-arranque";
import { comisionarBonoAtencion, cumpleIndicador, type Indicador } from "../lib/comisiones/bono-atencion";
import { comisionarFondo } from "../lib/comisiones/fondo-admin";
import { esClienteNuevo, dentroDeVentana, finVentana } from "../lib/comisiones/cliente-nuevo";
import { calcularComisiones, type EntradaMotor } from "../lib/comisiones/motor";
import type {
  ContratoFijo,
  LineaComision,
  MesFijo,
  ParametroComision,
  ServicioEventual,
} from "../lib/comisiones/tipos";
import { sumarMeses } from "../lib/comisiones/calendario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Parámetro inicial (los % del dueño), vigente desde antes de todas las fechas ──
const PARAM: ParametroComision = {
  vigente_desde: "2020-01-01",
  tramosEventual: [
    { hasta: 30, tasa: 0.2 },
    { hasta: null, tasa: 0.12 },
  ],
  tasaFijo: 0.1,
  tasaBonoArranque: 0.3,
  mitadesBonoArranque: [
    { mes: 1, fraccion: 0.5 },
    { mes: 3, fraccion: 0.5 },
  ],
  ventanaMeses: 12,
  montoFondoPorEventual: 4,
  topeBonoAtencion: 150,
  toleranciaRapidez: 0.9,
};
const PARAMS = [PARAM];

// Helpers para fabricar servicios/meses de prueba.
const evt = (id: number, utilidad: number, dia: number, extra: Partial<ServicioEventual> = {}): ServicioEventual => ({
  id,
  clienteId: `c${id}`,
  fechaCobro: `2027-05-${String(dia).padStart(2, "0")}`,
  fechaServicio: `2027-05-${String(dia).padStart(2, "0")}`,
  utilidad,
  tienePresupuesto: true,
  cobrado: true,
  ...extra,
});
const sumaPagos = (ls: LineaComision[]) =>
  ls.reduce((a, l) => a + (l.codigo === "pagar" && l.monto ? l.monto : 0), 0);

console.log("\n════ A) LOS 14 CASOS DE LA ESPECIFICACIÓN ════\n");

// ── CASO 1: 30 eventuales nuevos, utilidad 125 c/u, cobrados → comisión 750; fondo 120. ──
{
  const servicios: ServicioEventual[] = [];
  for (let i = 1; i <= 30; i++)
    servicios.push({ id: i, clienteId: `cli${i}`, fechaCobro: "2027-05-10", fechaServicio: "2027-05-10", utilidad: 125, tienePresupuesto: true, cobrado: true });
  const r = calcularComisiones({ parametros: PARAMS, eventuales: servicios, operadoresCorroborados: ["op1"] });
  chk("Caso 1 · comisión = S/750 (30×25)", r.totales.comisiones === 750, `${r.totales.comisiones}`);
  chk("Caso 1 · fondo = S/120 (30×4)", r.totales.fondo === 120, `${r.totales.fondo}`);
}

// ── CASO 2: 100 eventuales nuevos → 30×25 + 70×15 = 1800; fondo 400. ──
{
  const servicios: ServicioEventual[] = [];
  for (let i = 1; i <= 100; i++)
    servicios.push({ id: i, clienteId: `cli${i}`, fechaCobro: "2027-05-10", fechaServicio: "2027-05-10", utilidad: 125, tienePresupuesto: true, cobrado: true });
  const r = calcularComisiones({ parametros: PARAMS, eventuales: servicios, operadoresCorroborados: ["op1"] });
  chk("Caso 2 · comisión = S/1,800 (30×25 + 70×15)", r.totales.comisiones === 1800, `${r.totales.comisiones}`);
  chk("Caso 2 · fondo = S/400 (100×4)", r.totales.fondo === 400, `${r.totales.fondo}`);
}

// ── CASO 3: 150 eventuales → 30×25 + 120×15 = 2550; fondo 600 (S/200 por persona con 3). ──
{
  const servicios: ServicioEventual[] = [];
  for (let i = 1; i <= 150; i++)
    servicios.push({ id: i, clienteId: `cli${i}`, fechaCobro: "2027-05-10", fechaServicio: "2027-05-10", utilidad: 125, tienePresupuesto: true, cobrado: true });
  const r = calcularComisiones({ parametros: PARAMS, eventuales: servicios, operadoresCorroborados: ["op1", "op2", "op3"] });
  chk("Caso 3 · comisión = S/2,550 (30×25 + 120×15)", r.totales.comisiones === 2550, `${r.totales.comisiones}`);
  chk("Caso 3 · fondo total = S/600 (150×4)", r.totales.fondo === 600, `${r.totales.fondo}`);
  const fondoLineas = r.lineas.filter((l) => l.regla === "fondo_admin");
  chk("Caso 3 · S/200 por persona con 3 operadores", fondoLineas.length === 3 && fondoLineas.every((l) => l.monto === 200), fondoLineas.map((l) => l.monto).join(","));
}

// ── CASO 4: precio 400, chofer 120, combustible 80, peajes 25 → utilidad 175;
//    comisión 35 en tramo 1, 21 en el servicio 31+. (La utilidad se RECIBE calculada.) ──
{
  const utilidad = 400 - 120 - 80 - 25;
  chk("Caso 4 · utilidad calculada aguas arriba = 175", utilidad === 175, `${utilidad}`);
  const tasa1 = tasaDeTramo(PARAM.tramosEventual, 1);
  const tasa31 = tasaDeTramo(PARAM.tramosEventual, 31);
  chk("Caso 4 · tramo 1 → S/35 (20% de 175)", Math.round(utilidad * tasa1 * 100) / 100 === 35, `${utilidad * tasa1}`);
  chk("Caso 4 · servicio 31+ → S/21 (12% de 175)", Math.round(utilidad * tasa31 * 100) / 100 === 21, `${utilidad * tasa31}`);
}

// ── CASO 5: eventual de cliente existente (en lista firmada) → S/0, no cuenta para tramo ni fondo. ──
{
  const r = calcularComisiones({
    parametros: PARAMS,
    eventuales: [{ id: 1, clienteId: "existente", fechaCobro: "2027-05-10", fechaServicio: "2027-05-10", utilidad: 500, tienePresupuesto: true, cobrado: true }],
    operadoresCorroborados: ["op1"],
    clientes: { existente: { enListaFirmada: true, fechasServicioPrevias: [], fechaCotizacion: "2027-04-01" } },
  });
  chk("Caso 5 · comisión S/0 (cliente en lista firmada)", r.totales.comisiones === 0, `${r.totales.comisiones}`);
  chk("Caso 5 · fondo S/0 (no cuenta)", r.totales.fondo === 0, `${r.totales.fondo}`);
  chk("Caso 5 · la línea lo dice (cliente_existente)", r.lineas.some((l) => l.codigo === "cliente_existente"));
  chk("Caso 5 · no ocupa posición de tramo", !r.lineas.some((l) => l.codigo === "pagar" || l.codigo === "retenido_falta_costear"));
}

// ── CASO 6: servicio anulado antes del cobro, cliente nuevo → S/0, no cuenta para tramo. ──
{
  const r = calcularComisiones({
    parametros: PARAMS,
    eventuales: [{ id: 1, clienteId: "nuevo", fechaCobro: "2027-05-10", fechaServicio: "2027-05-10", utilidad: 500, tienePresupuesto: true, cobrado: false }],
    operadoresCorroborados: ["op1"],
    clientes: { nuevo: { enListaFirmada: false, fechasServicioPrevias: [], fechaCotizacion: "2027-04-01" } },
  });
  chk("Caso 6 · comisión S/0 (anulado, no cobrado)", r.totales.comisiones === 0, `${r.totales.comisiones}`);
  chk("Caso 6 · fondo S/0 (no cuenta para tramo)", r.totales.fondo === 0, `${r.totales.fondo}`);
  chk("Caso 6 · la línea lo dice (no_cobrado)", r.lineas.some((l) => l.codigo === "no_cobrado"));
}

// ── CASO 7: fijo propio, 1 año, utilidad 2100/mes →
//    Mes1 525, Mes2 210, Mes3 525, Mes4-12 210, Mes13 0. Total año 3150. ──
{
  const ancla = "2027-01-15";
  const meses: MesFijo[] = [];
  for (let i = 1; i <= 13; i++) {
    meses.push({
      mes: i,
      fechaCobro: sumarMeses(ancla, i - 1),
      fechaServicio: sumarMeses(ancla, i - 1),
      utilidad: 2100,
      cobrado: true,
      tienePresupuesto: true,
    });
  }
  const contrato: ContratoFijo = { id: "F7", clienteId: "cfijo", meses, canceladoEnMes: null };
  const lineas = comisionarFijo(contrato, PARAMS);
  const porMes = (mes: number) =>
    lineas.filter((l) => l.fechaCobro === sumarMeses(ancla, mes - 1) && l.codigo === "pagar").reduce((a, l) => a + (l.monto ?? 0), 0);
  chk("Caso 7 · Mes1 = 525 (210 + 315)", porMes(1) === 525, `${porMes(1)}`);
  chk("Caso 7 · Mes2 = 210", porMes(2) === 210, `${porMes(2)}`);
  chk("Caso 7 · Mes3 = 525 (210 + 315 segunda mitad del bono)", porMes(3) === 525, `${porMes(3)}`);
  chk("Caso 7 · Mes4..12 = 210 c/u", [4, 5, 6, 7, 8, 9, 10, 11, 12].every((m) => porMes(m) === 210));
  chk("Caso 7 · Mes13 = 0 (fuera de la ventana de 12 meses)", porMes(13) === 0, `${porMes(13)}`);
  const total = sumaPagos(lineas);
  chk("Caso 7 · total del año = S/3,150", total === 3150, `${total}`);
}

// ── CASO 8: fijo cancelado en mes 2, cobrados meses 1 y 2 → Mes1 525, Mes2 210, sin 2ª
//    parte del bono. Total 735. ──
{
  const ancla = "2027-01-15";
  const meses: MesFijo[] = [
    { mes: 1, fechaCobro: sumarMeses(ancla, 0), fechaServicio: sumarMeses(ancla, 0), utilidad: 2100, cobrado: true, tienePresupuesto: true },
    { mes: 2, fechaCobro: sumarMeses(ancla, 1), fechaServicio: sumarMeses(ancla, 1), utilidad: 2100, cobrado: true, tienePresupuesto: true },
  ];
  const contrato: ContratoFijo = { id: "F8", clienteId: "cfijo", meses, canceladoEnMes: 2 };
  const lineas = comisionarFijo(contrato, PARAMS);
  const porMes = (mes: number) =>
    lineas.filter((l) => l.fechaCobro === sumarMeses(ancla, mes - 1) && l.codigo === "pagar").reduce((a, l) => a + (l.monto ?? 0), 0);
  chk("Caso 8 · Mes1 = 525", porMes(1) === 525, `${porMes(1)}`);
  chk("Caso 8 · Mes2 = 210", porMes(2) === 210, `${porMes(2)}`);
  chk("Caso 8 · sin 2ª parte del bono (cancelado en mes 2)", lineas.some((l) => l.regla === "bono_arranque" && l.codigo === "bono_arranque_cancelado"));
  chk("Caso 8 · total = S/735", sumaPagos(lineas) === 735, `${sumaPagos(lineas)}`);
}

// ── CASO 9: primer servicio cobrado 15/03/2027 → servicios con fecha < 15/03/2028
//    comisionan, los de esa fecha en adelante no. ──
{
  const ancla = "2027-03-15";
  chk("Caso 9 · fin de ventana = 2028-03-15", finVentana(ancla, 12) === "2028-03-15", finVentana(ancla, 12));
  chk("Caso 9 · servicio 2028-03-14 comisiona", dentroDeVentana("2028-03-14", ancla, 12));
  chk("Caso 9 · servicio 2028-03-15 NO comisiona", !dentroDeVentana("2028-03-15", ancla, 12));
  chk("Caso 9 · servicio 2028-04-01 NO comisiona", !dentroDeVentana("2028-04-01", ancla, 12));
}

// ── CASO 10: último servicio 10/05/2026, nueva cotización 20/06/2027 → cliente nuevo otra vez. ──
{
  const v = esClienteNuevo({ enListaFirmada: false, fechasServicioPrevias: ["2026-05-10"], fechaCotizacion: "2027-06-20" }, 12);
  chk("Caso 10 · cliente nuevo de nuevo (gap > 12 meses)", v.nuevo === true, `${v.nuevo}`);
}

// ── CASO 11: último servicio 10/08/2026, nueva cotización 20/06/2027 → NO es cliente nuevo. ──
{
  const v = esClienteNuevo({ enListaFirmada: false, fechasServicioPrevias: ["2026-08-10"], fechaCotizacion: "2027-06-20" }, 12);
  chk("Caso 11 · NO es cliente nuevo (gap < 12 meses)", v.nuevo === false && v.motivo === "servicio_reciente", `${v.nuevo}/${v.motivo}`);
}

// ── Los 7 indicadores del bono de atención (valores suman 150) ──
const INDICADORES = (over: Partial<Record<string, Indicador>> = {}): Indicador[] => {
  const base: Record<string, Indicador> = {
    documentacion: { clave: "documentacion", valor: 30, tipo: "generico", eventos: 0 },
    precios: { clave: "precios", valor: 15, tipo: "generico", eventos: 0 },
    rapidez: { clave: "rapidez", valor: 20, tipo: "rapidez", atendidos: 10, enPlazo: 10 },
    reclamos: { clave: "reclamos", valor: 25, tipo: "reclamo", reclamos: [] },
    cancelaciones: { clave: "cancelaciones", valor: 20, tipo: "cancelacion", cancelaciones: [] },
    registros: { clave: "registros", valor: 20, tipo: "generico", eventos: 0 },
    puntualidad: { clave: "puntualidad", valor: 20, tipo: "generico", eventos: 0 },
  };
  return Object.keys(base).map((k) => over[k] ?? base[k]);
};

// ── CASO 12: cumple los 7 → S/150. ──
{
  const r = comisionarBonoAtencion(INDICADORES(), 150, 0.9);
  chk("Caso 12 · bono de atención = S/150 (7 cumplidos)", r.monto === 150, `${r.monto}`);
}

// ── CASO 13: falla documentación (30) y precios (15) → S/105 (150−30−15). ──
{
  const r = comisionarBonoAtencion(
    INDICADORES({
      documentacion: { clave: "documentacion", valor: 30, tipo: "generico", eventos: 1 },
      precios: { clave: "precios", valor: 15, tipo: "generico", eventos: 2 },
    }),
    150,
    0.9,
  );
  chk("Caso 13 · falla documentación y precios → S/105", r.monto === 105, `${r.monto}`);
}

// ── CASO 14: falla solo rapidez (20) → S/130. ──
{
  const r = comisionarBonoAtencion(
    INDICADORES({ rapidez: { clave: "rapidez", valor: 20, tipo: "rapidez", atendidos: 10, enPlazo: 8 } }),
    150,
    0.9,
  );
  chk("Caso 14 · falla solo rapidez (8/10 < 0.90) → S/130", r.monto === 130, `${r.monto}`);
}

console.log("\n════ B) INVARIANTES POR BARRIDO ════\n");

// ── La fila 30→31 cambia 20%→12% ──
{
  chk("Barrido · posición 30 = 20%", tasaDeTramo(PARAM.tramosEventual, 30) === 0.2);
  chk("Barrido · posición 31 = 12%", tasaDeTramo(PARAM.tramosEventual, 31) === 0.12);
  // Sobre un año completo de posiciones: nunca hay una posición ≤30 al 12% ni >30 al 20%.
  let coherente = true;
  for (let p = 1; p <= 500; p++) {
    const t = tasaDeTramo(PARAM.tramosEventual, p);
    if (p <= 30 && t !== 0.2) coherente = false;
    if (p > 30 && t !== 0.12) coherente = false;
  }
  chk("Barrido · todo p≤30 → 20% y todo p>30 → 12%", coherente);
}

// ── El contador reinicia el día 1 del mes ──
{
  // 31 eventuales en mayo (el 31º al 12%) + 1 eventual en junio (vuelve a posición 1 → 20%).
  const servicios: ServicioEventual[] = [];
  for (let i = 1; i <= 31; i++) servicios.push(evt(i, 100, Math.min(i, 28)));
  servicios.push({ id: 999, clienteId: "cjun", fechaCobro: "2027-06-02", fechaServicio: "2027-06-02", utilidad: 100, tienePresupuesto: true, cobrado: true });
  const lineas = comisionarEventuales(servicios, PARAMS);
  const junio = lineas.find((l) => l.servicioId === 999)!;
  chk("Barrido · el contador reinicia el día 1 (junio #1 → 20%)", junio.posicion === 1 && junio.tasa === 0.2, `pos ${junio.posicion}, tasa ${junio.tasa}`);
  const mayo31 = lineas.filter((l) => (l.fechaCobro ?? "").startsWith("2027-05")).find((l) => l.posicion === 31)!;
  chk("Barrido · el 31º de mayo va al 12%", mayo31.tasa === 0.12);
}

// ── Orden por fecha de cobro y luego id ──
{
  // Mismo día, ids desordenados en la entrada → la posición sigue el id.
  const servicios: ServicioEventual[] = [
    { id: "b", clienteId: "x", fechaCobro: "2027-05-05", fechaServicio: "2027-05-05", utilidad: 100, tienePresupuesto: true, cobrado: true },
    { id: "a", clienteId: "x", fechaCobro: "2027-05-05", fechaServicio: "2027-05-05", utilidad: 100, tienePresupuesto: true, cobrado: true },
    { id: "z", clienteId: "x", fechaCobro: "2027-05-04", fechaServicio: "2027-05-04", utilidad: 100, tienePresupuesto: true, cobrado: true },
  ];
  const lineas = comisionarEventuales(servicios, PARAMS);
  const pos = (id: string) => lineas.find((l) => l.servicioId === id)!.posicion;
  chk("Barrido · fecha de cobro manda (z del día 4 → pos 1)", pos("z") === 1, `${pos("z")}`);
  chk("Barrido · a igualdad, id manda (a antes que b)", pos("a") === 2 && pos("b") === 3, `a=${pos("a")} b=${pos("b")}`);
}

// ── Cancelar en mes 2 anula exactamente la 2ª mitad del bono de arranque ──
{
  const mkMeses = (n: number): MesFijo[] =>
    Array.from({ length: n }, (_, i) => ({ mes: i + 1, fechaCobro: sumarMeses("2027-01-15", i), fechaServicio: sumarMeses("2027-01-15", i), utilidad: 2100, cobrado: true, tienePresupuesto: true }));
  const sinCancelar = comisionarBonoArranque({ id: "a", clienteId: "c", meses: mkMeses(3), canceladoEnMes: null }, PARAMS);
  const cancelado2 = comisionarBonoArranque({ id: "b", clienteId: "c", meses: mkMeses(2), canceladoEnMes: 2 }, PARAMS);
  const pagables = (ls: LineaComision[]) => ls.filter((l) => l.codigo === "pagar").reduce((a, l) => a + (l.monto ?? 0), 0);
  chk("Barrido · bono completo (mes 3 cobrado) = 630", pagables(sinCancelar) === 630, `${pagables(sinCancelar)}`);
  chk("Barrido · cancelado en mes 2 → solo 1ª mitad (315)", pagables(cancelado2) === 315, `${pagables(cancelado2)}`);
  chk("Barrido · la 2ª mitad sale marcada como cancelada, no como pagada", cancelado2.some((l) => l.codigo === "bono_arranque_cancelado") && !cancelado2.some((l) => l.codigo === "pagar" && (l.detalle.includes("mes 3"))));
}

// ── Estar en la lista firmada excluye aunque no haya historial ──
{
  const v = esClienteNuevo({ enListaFirmada: true, fechasServicioPrevias: [], fechaCotizacion: "2027-06-20" }, 12);
  chk("Barrido · lista firmada excluye aunque no haya historial", v.nuevo === false && v.motivo === "en_lista");
}

// ── Bono de atención topa en 150 (aunque los valores sumen más) ──
{
  const inflados: Indicador[] = INDICADORES().map((i) => ({ ...i, valor: 100 }));
  const r = comisionarBonoAtencion(inflados, 150, 0.9);
  chk("Barrido · el bono de atención topa en 150", r.monto === 150, `${r.monto}`);
}

// ── grave∧fundado∧atribuible rompe; grave∧fundado∧¬atribuible NO; sin clasificar NO ──
{
  const rompe = cumpleIndicador({ clave: "reclamos", valor: 25, tipo: "reclamo", reclamos: [{ grave: true, fundado: true, atribuible: true }] }, 0.9);
  const noAtrib = cumpleIndicador({ clave: "reclamos", valor: 25, tipo: "reclamo", reclamos: [{ grave: true, fundado: true, atribuible: false }] }, 0.9);
  const sinClasif = cumpleIndicador({ clave: "reclamos", valor: 25, tipo: "reclamo", reclamos: [{ grave: true, fundado: true, atribuible: null }] }, 0.9);
  chk("Barrido · grave∧fundado∧atribuible ROMPE el indicador", rompe.cumplido === false);
  chk("Barrido · grave∧fundado∧¬atribuible NO rompe", noAtrib.cumplido === true);
  chk("Barrido · reclamo sin clasificar NO rompe (se paga)", sinClasif.cumplido === true);
  const canc = cumpleIndicador({ clave: "cancelaciones", valor: 20, tipo: "cancelacion", cancelaciones: [{ evitable: true, constancia_escrita: true }] }, 0.9);
  const cancSinConst = cumpleIndicador({ clave: "cancelaciones", valor: 20, tipo: "cancelacion", cancelaciones: [{ evitable: true, constancia_escrita: null }] }, 0.9);
  chk("Barrido · cancelación evitable∧constancia ROMPE", canc.cumplido === false);
  chk("Barrido · cancelación sin constancia NO rompe (se paga)", cancSinConst.cumplido === true);
}

// ── Parámetros con vigencia por fecha ──
{
  const viejo: ParametroComision = { ...PARAM, vigente_desde: "2020-01-01", tramosEventual: [{ hasta: 30, tasa: 0.2 }, { hasta: null, tasa: 0.12 }] };
  const nuevo: ParametroComision = { ...PARAM, vigente_desde: "2027-07-01", tramosEventual: [{ hasta: 30, tasa: 0.18 }, { hasta: null, tasa: 0.1 }] };
  const lista = [viejo, nuevo];
  chk("Barrido · vigencia: cobro de junio usa el 20%", parametrosVigentes(lista, "2027-06-30")!.tramosEventual[0].tasa === 0.2);
  chk("Barrido · vigencia: cobro de julio usa el 18% nuevo", parametrosVigentes(lista, "2027-07-15")!.tramosEventual[0].tasa === 0.18);
  chk("Barrido · vigencia: sin ninguno vigente devuelve null", parametrosVigentes(lista, "2019-01-01") === null);
  // El mismo servicio paga distinto según su fecha de cobro.
  const sJun = comisionarEventuales([{ id: 1, clienteId: "x", fechaCobro: "2027-06-15", fechaServicio: "2027-06-15", utilidad: 100, tienePresupuesto: true, cobrado: true }], lista);
  const sJul = comisionarEventuales([{ id: 1, clienteId: "x", fechaCobro: "2027-07-15", fechaServicio: "2027-07-15", utilidad: 100, tienePresupuesto: true, cobrado: true }], lista);
  chk("Barrido · junio paga 20 y julio 18 (mismo servicio, otra fecha)", sJun[0].monto === 20 && sJul[0].monto === 18, `${sJun[0].monto}/${sJul[0].monto}`);
}

// ── Retenido: sin presupuesto no emite monto, pero OCUPA posición y cuenta para el fondo ──
{
  const servicios: ServicioEventual[] = [
    evt(1, 100, 1, { tienePresupuesto: false }),
    evt(2, 100, 2, { tienePresupuesto: true }),
  ];
  const r = calcularComisiones({ parametros: PARAMS, eventuales: servicios, operadoresCorroborados: ["op1"] });
  const l1 = r.lineas.find((l) => l.servicioId === 1)!;
  const l2 = r.lineas.find((l) => l.servicioId === 2)!;
  chk("Barrido · sin presupuesto → retenido (monto null, NO cero)", l1.codigo === "retenido_falta_costear" && l1.monto === null);
  chk("Barrido · el retenido ocupa posición 1", l1.posicion === 1);
  chk("Barrido · el siguiente NO sube de tramo por el retenido (pos 2)", l2.posicion === 2);
  chk("Barrido · el retenido cuenta para el fondo (2×4 = 8)", r.totales.fondo === 8, `${r.totales.fondo}`);
}

// ── Fondo sin operadores corroborados → no se reparte, queda pendiente ──
{
  const r = comisionarFondo([{ servicioId: 1, montoPorEventual: 4 }, { servicioId: 2, montoPorEventual: 4 }], []);
  chk("Barrido · fondo sin corroborados → línea pendiente con el total", r.lineas.length === 1 && r.lineas[0].codigo === "fondo_pendiente_corroboracion" && r.lineas[0].monto === 8);
}

console.log("\n════ C) EL LADO QUE NO SE PUEDE AFLOJAR ════\n");

// Una comisión legítima nunca desaparece. Un motor que devolviera [] (o puros ceros)
// pasaría todas las invariantes de exclusión de forma trivial; aquí se exige lo contrario.
{
  const entradaRica: EntradaMotor = {
    parametros: PARAMS,
    vendedorId: "V1",
    eventuales: [
      evt(1, 125, 1),
      evt(2, 200, 2),
    ],
    contratosFijos: [
      {
        id: "F",
        clienteId: "cf",
        meses: [{ mes: 1, fechaCobro: "2027-05-01", fechaServicio: "2027-05-01", utilidad: 2100, cobrado: true, tienePresupuesto: true }],
        canceladoEnMes: null,
      },
    ],
    bonoAtencion: { indicadores: INDICADORES(), fecha: "2027-05-31" },
    operadoresCorroborados: ["op1", "op2"],
  };
  const r = calcularComisiones(entradaRica);
  chk("Corolario · el motor SÍ produce comisiones (no [])", r.totales.comisiones > 0, `${r.totales.comisiones}`);
  chk("Corolario · hay líneas 'pagar' de eventual", r.lineas.some((l) => l.regla === "eventual" && l.codigo === "pagar"));
  chk("Corolario · hay 10% mensual del fijo", r.lineas.some((l) => l.regla === "fijo_mensual" && l.codigo === "pagar" && l.monto === 210));
  chk("Corolario · hay 1ª mitad del bono de arranque (315)", r.lineas.some((l) => l.regla === "bono_arranque" && l.codigo === "pagar" && l.monto === 315));
  chk("Corolario · hay bono de atención (150)", r.lineas.some((l) => l.regla === "bono_atencion" && l.monto === 150));
  chk("Corolario · hay fondo repartido (op1, op2)", r.totales.fondo > 0 && r.lineas.filter((l) => l.regla === "fondo_admin").length === 2);
  // Toda línea de pago lleva traza: regla, código y detalle.
  const pagos = r.lineas.filter((l) => l.codigo === "pagar");
  chk("Corolario · toda línea pagable es trazable (regla + detalle)", pagos.length > 0 && pagos.every((l) => l.regla && l.detalle.length > 0));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
