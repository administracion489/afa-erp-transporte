// Prueba de EXTRACCIÓN del motor de costeo. No toca la base.
// Uso:  npx tsx scripts/prueba-costeo.mts   (sale con código 1 si algo falla)
//
// Qué demuestra: que `lib/costeo-propio.ts` devuelve EXACTAMENTE los mismos números que
// la función `calcular()` que vivía dentro de app/cotizador/page.tsx. Esa es la única
// prueba que importa en una extracción — si los números cambian, no se extrajo, se
// reescribió, y todas las cotizaciones emitidas dejan de ser reproducibles.
//
// La referencia de abajo es una copia LITERAL de la función original, tal como estaba
// antes del cambio. No se toca ni se "mejora": está aquí para discrepar.

import { aplicarPisoHora, escenariosPrecio as escP,
  calcularCostoUnidad, escenariosPrecio, consumoPorKm, RECORRIDO_CARRETERA,
  type ParametrosUnidad, type PreciosCombustible,
} from "../lib/costeo-propio";
import { preciosParaCosteo, calcularPresupuesto, type ContextoCosteo } from "../lib/costeo-servicio";
import { decidirRendimiento, type MedicionPlaca } from "../lib/costos/rendimiento-aplica";

// ── REFERENCIA: la función original, copiada tal cual ─────────────────────────
const IGV = 0.18, OVERHEAD = 0.10, RESERVA = 0.05;

function calcularOriginal(p: any, pr: Record<string, number>, km: number, dias: number,
                          peajes: number, otros: number, pernocte: number, viaticos: number) {
  if (!p || km <= 0) return null;
  const pc1 = pr[p.tipo_combustible_1] || 0;
  const combKm = (pc1 / p.rendimiento_1) * p.pct_uso_1 + (p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2 ? ((pr[p.tipo_combustible_2] || 0) / p.rendimiento_2) * p.pct_uso_2 : 0);
  const ureaRate = p.usa_urea && p.tipo_combustible_1 === "Diésel" ? (1 / p.rendimiento_1) * 3.785 * (p.consumo_urea_pct || 0.04) * (pr["UREA"] || 0) : 0;
  const costoCombustible = (combKm + ureaRate) * km; const costoUrea = ureaRate * km;
  const costoNeumaticos = ((p.n_neumaticos * p.costo_neumatico) / p.vida_neumatico_km) * km;
  const costoMantenimiento = p.mantenimiento_km * km;
  const costoDeprec = ((p.valor_compra * (1 - p.residual_pct)) / (p.vida_util_anios * p.km_anio)) * km;
  const costoFijosKm = ((p.seguro_anual + p.soat_anual + p.revision_semestral * 2 + p.permisos_anual + p.otros_fijos_mensual * 12) / p.km_anio) * km;
  const sub = costoCombustible + costoNeumaticos + costoMantenimiento + costoDeprec + costoFijosKm;
  const reserva = sub * RESERVA; const costoVehiculo = sub + reserva;
  const costoConductor = p.conductor_dia * dias;
  const costoDirectos = peajes + otros;
  const costoDirectoTotal = costoVehiculo + costoConductor + costoDirectos;
  const overhead = costoDirectoTotal * OVERHEAD;
  const baseCosto = costoDirectoTotal + overhead + pernocte + viaticos;
  const costoKm = costoDirectoTotal / Math.max(km, 1);
  const pF = (m: number) => baseCosto / (1 - m); const fF = (m: number) => pF(m) * (1 + IGV);
  return {
    costoCombustible, costoNeumaticos, costoMantenimiento, costoDeprec, costoFijosKm, costoUrea,
    reserva, costoVehiculo, costoConductor, costoDirectos, costoDirectoTotal, overhead, baseCosto, costoKm,
    totalMin15: fF(0.15), totalEst20: fF(0.20), totalAlto25: fF(0.25),
    sinIGV15: pF(0.15), sinIGV20: pF(0.20), sinIGV25: pF(0.25),
    precioPax20: fF(0.20) / (p.capacidad || 1),
  };
}

// ── Unidades de prueba ────────────────────────────────────────────────────────
const BUS: ParametrosUnidad = {
  tipo_vehiculo: "bus50", nombre: "Bus 50 pax", capacidad: 50,
  usa_urea: true, consumo_urea_pct: 0.04,
  tipo_combustible_1: "Diésel", rendimiento_1: 8, pct_uso_1: 1,
  tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null,
  n_neumaticos: 6, costo_neumatico: 1400, vida_neumatico_km: 70000,
  mantenimiento_km: 0.35, valor_compra: 320000, residual_pct: 0.2,
  vida_util_anios: 10, km_anio: 60000,
  seguro_anual: 4800, soat_anual: 900, revision_semestral: 180,
  permisos_anual: 1200, otros_fijos_mensual: 250, conductor_dia: 90,
};

// Bimodal GLP/gasolina y sin urea: ejercita las dos ramas que el bus no toca.
const VAN: ParametrosUnidad = {
  tipo_vehiculo: "van11", nombre: "Van 11 pax", capacidad: 11,
  usa_urea: false, consumo_urea_pct: null,
  tipo_combustible_1: "GLP", rendimiento_1: 22, pct_uso_1: 0.7,
  tipo_combustible_2: "Gasolina", rendimiento_2: 30, pct_uso_2: 0.3,
  n_neumaticos: 4, costo_neumatico: 380, vida_neumatico_km: 45000,
  mantenimiento_km: 0.18, valor_compra: 98000, residual_pct: 0.25,
  vida_util_anios: 8, km_anio: 40000,
  seguro_anual: 2100, soat_anual: 420, revision_semestral: 120,
  permisos_anual: 600, otros_fijos_mensual: 90, conductor_dia: 75,
};

const PRECIOS: PreciosCombustible = { "Diésel": 16.4, "Gasolina": 18.2, "GLP": 7.65, "UREA": 12.0 };

const CASOS = [
  { etq: "Bus · vuelta corta",          p: BUS, km: 64,   dias: 1, peajes: 24, otros: 0,   pernocte: 0,   viaticos: 0 },
  { etq: "Bus · multi-día con pernocte", p: BUS, km: 980,  dias: 3, peajes: 96, otros: 150, pernocte: 240, viaticos: 180 },
  { etq: "Van · bimodal GLP/gasolina",   p: VAN, km: 180,  dias: 1, peajes: 12, otros: 0,   pernocte: 0,   viaticos: 25 },
  { etq: "Van · recorrido largo",        p: VAN, km: 1240, dias: 2, peajes: 60, otros: 40,  pernocte: 120, viaticos: 90 },
];

let fallos = 0;
const CENTAVO = 0.000001;   // la extracción tiene que ser idéntica, no parecida

function comparar(etq: string, campo: string, a: number, b: number) {
  const ok = Math.abs(a - b) < CENTAVO;
  if (!ok) {
    console.log(`  ❌ ${etq} · ${campo}: original ${a.toFixed(6)} ≠ extraído ${b.toFixed(6)}`);
    fallos++;
  }
  return ok;
}

console.log("\n── La extracción devuelve los mismos números ──");
for (const c of CASOS) {
  const orig = calcularOriginal(c.p, PRECIOS, c.km, c.dias, c.peajes, c.otros, c.pernocte, c.viaticos)!;
  const nuevo = calcularCostoUnidad(c.p, PRECIOS, {
    km: c.km, dias: c.dias, peajes: c.peajes, otros: c.otros, pernocte: c.pernocte, viaticos: c.viaticos,
  })!;
  const esc = escenariosPrecio(nuevo.baseCosto, c.p.capacidad);

  let bien = true;
  for (const k of ["costoCombustible", "costoUrea", "costoNeumaticos", "costoMantenimiento",
                   "costoDeprec", "costoFijosKm", "reserva", "costoVehiculo", "costoConductor",
                   "costoDirectos", "costoDirectoTotal", "overhead", "baseCosto", "costoKm"] as const) {
    bien = comparar(c.etq, k, (orig as any)[k], (nuevo as any)[k]) && bien;
  }
  bien = comparar(c.etq, "sinIGV15",   orig.sinIGV15,   esc.sinIgv.min)  && bien;
  bien = comparar(c.etq, "sinIGV20",   orig.sinIGV20,   esc.sinIgv.est)  && bien;
  bien = comparar(c.etq, "sinIGV25",   orig.sinIGV25,   esc.sinIgv.alto) && bien;
  bien = comparar(c.etq, "totalMin15", orig.totalMin15, esc.conIgv.min)  && bien;
  bien = comparar(c.etq, "totalEst20", orig.totalEst20, esc.conIgv.est)  && bien;
  bien = comparar(c.etq, "totalAlto25",orig.totalAlto25,esc.conIgv.alto) && bien;
  bien = comparar(c.etq, "precioPax20",orig.precioPax20,esc.precioPax)   && bien;

  console.log(`  ${bien ? "✅" : "❌"} ${c.etq}  ·  base S/ ${nuevo.baseCosto.toFixed(2)} · S/ ${nuevo.costoKm.toFixed(3)}/km`);
}

// ── Lo que el módulo agrega y la función original no tenía ────────────────────
console.log("\n── Las dos fuentes que mandan sobre el parámetro ──");
const ok = (cond: boolean, etq: string, det = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${det ? "  → " + det : ""}`);
  if (!cond) fallos++;
};

{
  const base = { km: 100, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 };
  const conParam = calcularCostoUnidad(BUS, PRECIOS, base)!;
  const conReal  = calcularCostoUnidad(BUS, PRECIOS, { ...base, costoConductorDia: 82.33 })!;
  ok(conParam.costoConductor === 90, "sin costo real usa conductor_dia del parámetro", String(conParam.costoConductor));
  ok(conReal.costoConductor === 82.33, "con costo empresa real, manda el real", String(conReal.costoConductor));
  ok(conParam.fuentes.conductor === "parametro" && conReal.fuentes.conductor === "real",
     "la fuente se declara, para poder mostrarla");

  const conDeprec = calcularCostoUnidad(BUS, PRECIOS, { ...base, deprecKm: 1.2 })!;
  ok(conDeprec.costoDeprec === 120, "la depreciación contable manda sobre la del parámetro", String(conDeprec.costoDeprec));
  ok(conDeprec.fuentes.depreciacion === "contable", "y también declara su fuente");

  // Un cero explícito NO es "no hay dato": una unidad ya depreciada del todo aporta 0.
  const cero = calcularCostoUnidad(BUS, PRECIOS, { ...base, deprecKm: 0 })!;
  ok(cero.costoDeprec === 0 && cero.fuentes.depreciacion === "contable",
     "deprecKm = 0 es un dato, no la ausencia de uno");
}

console.log("\n── Bordes que hacían dividir por cero ──");
{
  const roto: ParametrosUnidad = { ...BUS, rendimiento_1: 0, vida_neumatico_km: 0, km_anio: 0, vida_util_anios: 0 };
  const r = calcularCostoUnidad(roto, PRECIOS, { km: 50, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 });
  ok(!!r && Number.isFinite(r.baseCosto), "un parámetro sin llenar no produce Infinity ni NaN",
     r ? `base S/ ${r.baseCosto.toFixed(2)}` : "null");
  ok(calcularCostoUnidad(BUS, PRECIOS, { km: 0, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 }) === null,
     "sin kilómetros devuelve null, no un cero que se lea como gratis");
}

console.log("\n── Recorrido urbano / carretera ──");
{
  const v = { km: 624, dias: 1, peajes: 24, otros: 0, pernocte: 0, viaticos: 0 };
  const sin = calcularCostoUnidad(BUS, PRECIOS, v)!;
  const urb = calcularCostoUnidad(BUS, PRECIOS, { ...v, recorrido: "urbano" })!;
  ok(JSON.stringify(sin) === JSON.stringify(urb), "sin el campo es exactamente urbano");
  const car = calcularCostoUnidad(BUS, PRECIOS, { ...v, recorrido: "carretera" })!;
  ok(Math.abs(car.costoCombustible - sin.costoCombustible / 1.25) < 1e-9, "en carretera el combustible baja por el factor de rendimiento");
  ok(car.costoMantenimiento === sin.costoMantenimiento && car.costoNeumaticos === sin.costoNeumaticos,
     "el desgaste por km no cambia");
  const car2 = calcularCostoUnidad(BUS, PRECIOS, { ...v, recorrido: "carretera", dias: 2 })!;
  ok(Math.abs(car2.costoFijosKm - 2 * car.costoFijosKm) < 1e-9, "los fijos en carretera escalan con los días, no con los km");
  const cont = calcularCostoUnidad(BUS, PRECIOS, { ...v, recorrido: "carretera", deprecKm: 0.5 })!;
  ok(cont.costoDeprec === 312, "la depreciación contable sigue por km en carretera");
  ok(car.baseCosto < sin.baseCosto, "un día largo en carretera cuesta menos que costeado como urbano",
     `${car.baseCosto.toFixed(2)} vs ${sin.baseCosto.toFixed(2)}`);
}

console.log("\n── Piso por hora ──");
{
  const e = escP(1000, 50);
  const p = aplicarPisoHora(e, 50, 8, 180);
  ok(p.sinIgv.min === 1440 && p.sinIgv.est === 1440 && Math.abs(p.sinIgv.alto - 1440) < 1e-9 && p.pisoAplica.est, "8 h × 180 levanta los precios bajos a 1 440");
  ok(Math.abs(p.conIgv.est - 1440 * 1.18) < 1e-9, "el con IGV se rehace desde el piso");
  const alto = aplicarPisoHora(escP(5000, 50), 50, 8, 180);
  ok(alto.sinIgv.est === escP(5000, 50).sinIgv.est && !alto.pisoAplica.est, "el piso nunca baja un precio");
  ok(JSON.stringify(aplicarPisoHora(e, 50, 0, 180).sinIgv) === JSON.stringify(e.sinIgv), "sin horas no hay piso");
  ok(JSON.stringify(aplicarPisoHora(e, 50, 8, null).sinIgv) === JSON.stringify(e.sinIgv), "sin tarifa no hay piso");
}

// ── consumoPorKm (aditivo): el VOLUMEN que, a los precios del motor, cuesta lo que costea ──
// La estadística por servicio necesita galones (o m³) por km, no soles. `consumoPorKm` repite las
// ramas de `combustiblePorKm` sin los precios; si alguna rama divergiera, multiplicar el volumen por
// el precio dejaría de dar el renglón de combustible. Se barre una rejilla de parámetros (bimodales,
// rendimientos en cero, segundo combustible a medias, con y sin urea), de precios (con y sin el del
// tipo, con y sin urea) y de recorrido, y se exige
//     Σ(cantidadPorKm × precio[tipo]) + costoUrea / km  =  costoCombustible / km   (± 1e-9)
console.log("\n── consumoPorKm: volumen × precio + urea = costoCombustible / km ──");
{
  const variantes: ParametrosUnidad[] = [];
  for (const base of [BUS, VAN]) {
    for (const r1 of [base.rendimiento_1, 0, 3.7]) {
      for (const dos of [
        { tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null },
        { tipo_combustible_2: "Gasolina", rendimiento_2: 30, pct_uso_2: 0.3 },
        { tipo_combustible_2: "Gasolina", rendimiento_2: 0, pct_uso_2: 0.3 },
        { tipo_combustible_2: "Gasolina", rendimiento_2: 25, pct_uso_2: 0 },
        { tipo_combustible_2: "", rendimiento_2: 25, pct_uso_2: 0.4 },
        { tipo_combustible_2: "GLP", rendimiento_2: null, pct_uso_2: 0.2 },
      ]) {
        for (const urea of [
          { usa_urea: true, consumo_urea_pct: 0.04, tipo_combustible_1: "Diésel" },
          { usa_urea: true, consumo_urea_pct: null, tipo_combustible_1: "Diésel" },
          { usa_urea: true, consumo_urea_pct: 0.04, tipo_combustible_1: base.tipo_combustible_1 },
          { usa_urea: false, consumo_urea_pct: null, tipo_combustible_1: base.tipo_combustible_1 },
        ]) {
          for (const pct1 of [base.pct_uso_1, 1, 0.55]) {
            variantes.push({ ...base, rendimiento_1: r1, pct_uso_1: pct1, ...dos, ...urea } as ParametrosUnidad);
          }
        }
      }
    }
  }
  const preciosVar: PreciosCombustible[] = [
    PRECIOS,
    { "Diésel": 16.4, "Gasolina": 18.2, "GLP": 7.65 },     // sin urea
    { "Gasolina": 18.2, "UREA": 12.0 },                     // sin el diésel ni el GLP: precio 0
    {},
  ];
  let casos = 0, iguales = 0, sinUrea = true, peor = 0;
  for (const p of variantes) for (const pr of preciosVar) for (const recorrido of ["urbano", "carretera"] as const) for (const km of [37, 624]) {
    const c = calcularCostoUnidad(p, pr, { km, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0, recorrido });
    if (!c) continue;
    const factor = recorrido === "carretera" ? RECORRIDO_CARRETERA.factorRendimiento : 1;
    const vol = consumoPorKm(p, factor);
    if (vol.some((v) => v.tipo === "UREA" && p.tipo_combustible_1 !== "UREA" && p.tipo_combustible_2 !== "UREA")) sinUrea = false;
    const soles = vol.reduce((s, v) => s + v.cantidadPorKm * (pr[v.tipo] || 0), 0) + c.costoUrea / km;
    const dif = Math.abs(soles - c.costoCombustible / km);
    peor = Math.max(peor, dif);
    casos++;
    if (dif < 1e-9) iguales++;
  }
  ok(iguales === casos && casos > 1000, `Σ vol × precio + urea = costoCombustible/km en toda la rejilla`, `${iguales}/${casos} · peor ${peor.toExponential(2)}`);
  ok(sinUrea, "consumoPorKm no devuelve la urea (es un aditivo: su costo sale solo del motor)");

  const bus = consumoPorKm(BUS);
  ok(bus.length === 1 && bus[0].tipo === "Diésel" && Math.abs(bus[0].cantidadPorKm - 1 / 8) < 1e-12, "bus diésel a 8 km/gal: 0.125 gal/km, un solo tipo", JSON.stringify(bus));
  const van = consumoPorKm(VAN);
  ok(van.length === 2 && Math.abs(van[0].cantidadPorKm - 0.7 / 22) < 1e-12 && Math.abs(van[1].cantidadPorKm - 0.3 / 30) < 1e-12,
     "bimodal GLP/gasolina: dos tipos por separado, cada uno con su parte", JSON.stringify(van));
  const car = consumoPorKm(BUS, RECORRIDO_CARRETERA.factorRendimiento);
  ok(Math.abs(car[0].cantidadPorKm - bus[0].cantidadPorKm / RECORRIDO_CARRETERA.factorRendimiento) < 1e-12, "en carretera el volumen baja por el mismo factor del rendimiento");
  const cero = consumoPorKm({ ...BUS, rendimiento_1: 0 });
  ok(cero[0].cantidadPorKm === 0 && Number.isFinite(cero[0].cantidadPorKm), "rendimiento en 0 = no consume (no Infinity), igual que el motor");
  ok(JSON.stringify(consumoPorKm(BUS)) === JSON.stringify(consumoPorKm(BUS, 1)), "factor 1 por defecto");
  // El motor congelado no se movió: el renglón de combustible del bus sigue saliendo igual.
  const ref = calcularCostoUnidad(BUS, PRECIOS, { km: 100, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 })!;
  ok(Math.abs(ref.costoCombustible - (100 / 8) * 16.4 - ref.costoUrea) < 1e-9, "calcularCostoUnidad no cambió al agregar consumoPorKm");
}

// ── preciosParaCosteo (extraído de calcularPresupuesto): ningún número cambia ──────
// La regla «el precio de la última carga manda sobre el de referencia» vivía como dos líneas dentro
// de `calcularPresupuesto`. Se extrajo para que la estadística por servicio costee con los MISMOS
// precios. Abajo, esas dos líneas copiadas literal, y el ciclo: el renglón de combustible del
// presupuesto sale de `calcularCostoUnidad` con los precios viejos.
console.log("\n── preciosParaCosteo = la regla de calcularPresupuesto, copiada literal ──");
{
  // REFERENCIA, tal cual estaba en calcularPresupuesto (lib/costeo-servicio.ts):
  //   const precios: PreciosCombustible = { ...ctx.precios };
  //   if (params && ctx.precioUltimaCarga) precios[params.tipo_combustible_1] = ctx.precioUltimaCarga.precio;
  const preciosViejos = (ctxPrecios: PreciosCombustible, params: ParametrosUnidad | null, ultima: { precio: number; fecha: string } | null) => {
    const precios: PreciosCombustible = { ...ctxPrecios };
    if (params && ultima) precios[params.tipo_combustible_1] = ultima.precio;
    return precios;
  };
  const medidas: (MedicionPlaca | null)[] = [
    null,
    { kmGal: 9.4, tramos: 7, familia: "diesel", label: "km/gal", confiable: true },
    { kmGal: 9.4, tramos: 2, familia: "diesel", label: "km/gal", confiable: false },
    { kmGal: 31, tramos: 9, familia: "glp", label: "km/gal", confiable: true },
  ];
  const ultimas = [null, { precio: 22.5, fecha: "2026-10-01" }, { precio: 5.5, fecha: "2026-10-02" }];
  const preciosVar: PreciosCombustible[] = [PRECIOS, {}, { "Gasolina": 18.2 }];
  let casos = 0, iguales = 0, ciclo = 0, cicloOk = 0, inmutable = true;
  for (const params of [null, BUS, VAN]) for (const ultima of ultimas) for (const pr of preciosVar) {
    const copia = JSON.stringify(pr);
    const viejo = preciosViejos(pr, params, ultima);
    const nuevo = preciosParaCosteo(pr, params, ultima);
    if (JSON.stringify(pr) !== copia) inmutable = false;
    casos++;
    if (JSON.stringify(viejo) === JSON.stringify(nuevo)) iguales++;
    if (!params) continue;
    for (const med of medidas) for (const km of [0, 48, 612]) {
      const ctx: ContextoCosteo = {
        parametros: params, precios: pr, rendimientoMedido: med, precioUltimaCarga: ultima,
        deprecKm: null, conductor: null, diasConServicio: 0, serviciosDelDia: 1, diasLaborablesMes: 26,
        kmSugerido: null, placa: "ABC-123",
      };
      const pres = calcularPresupuesto(ctx, { km, kmFuente: "gps", dias: 1, peajes: 0, viaticos: 0, estacionamiento: 0, pernocte: 0, otros: 0 });
      const linea = pres.lineas.find((l) => l.concepto === "combustible");
      const dec = decidirRendimiento(params, med);
      const c = calcularCostoUnidad({ ...params, rendimiento_1: dec.valor }, preciosViejos(pr, params, ultima),
        { km, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 });
      ciclo++;
      const esperado = c ? Math.round(c.costoCombustible * 100) / 100 : null;
      if ((linea?.monto ?? null) === esperado) cicloOk++;
    }
  }
  ok(iguales === casos, "mismos precios que la regla vieja en toda la rejilla", `${iguales}/${casos}`);
  ok(inmutable, "no muta los precios de referencia que recibe");
  ok(cicloOk === ciclo && ciclo > 50, "el renglón de combustible del presupuesto = calcularCostoUnidad con los precios de siempre", `${cicloOk}/${ciclo}`);
  ok(preciosParaCosteo(PRECIOS, BUS, { precio: 22.5 })["Diésel"] === 22.5, "con última carga, manda el precio pagado (corolario: la regla sí hace algo)");
  ok(preciosParaCosteo(PRECIOS, null, { precio: 22.5 })["Diésel"] === 16.4, "sin parámetros no se toca nada");
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
