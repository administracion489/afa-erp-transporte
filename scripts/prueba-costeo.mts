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

import {
  calcularCostoUnidad, escenariosPrecio,
  type ParametrosUnidad, type PreciosCombustible,
} from "../lib/costeo-propio";

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

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
