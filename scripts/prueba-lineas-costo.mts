// Matriz de lib/mantenimiento/lineas-costo.ts — una orden de trabajo la pagan VARIOS bolsillos,
// y uno de ellos no es un bolsillo.
//
//     npx tsx scripts/prueba-lineas-costo.mts
//
// Lo que fija:
//   1 · LA INVARIANTE DURA: ninguna línea `propio` puede llegar al desembolso, o sea a v_egresos.
//   2 · Sin líneas, el reparto es BYTE A BYTE el de antes (aditivo: omitirlas no cambia nada).
//   3 · Una línea anclada a un ítem lo SUSTITUYE; un ítem sin línea NO se pierde.
//   4 · La hora de casa se valoriza por cascada, con su fuente declarada — y sin datos, nada.
//   5 · Con dos facturas, NINGUNA representa a la orden en el libro.
import { createRequire } from "node:module";
const requerir = createRequire(import.meta.url);
const M = requerir("../lib/mantenimiento/lineas-costo") as typeof import("../lib/mantenimiento/lineas-costo");
const C = requerir("../lib/mantenimiento/costo-ot") as typeof import("../lib/mantenimiento/costo-ot");

const { repartoDeOT, valorizarManoObraPropia, tarifaHoraMecanico, facturasDeOT, HORAS_MES_DEFECTO } = M;
const { totalDeOT } = C;

type Linea = import("../lib/mantenimiento/lineas-costo").LineaCosto;
type Insumos = import("../lib/mantenimiento/lineas-costo").InsumosManoObra;

let fallos = 0;
const ok = (cond: boolean, etq: string, det = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${det ? "  → " + det : ""}`);
  if (!cond) fallos++;
};
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const L = (p: Partial<Linea> & { id: number | string; monto: number }): Linea => ({
  concepto: "x", tipo: "material", origen: "comprado", ...p,
});

// Los factores reales de la pequeña empresa (config_laboral_regimen, semilla de costeo-01).
const REGIMEN = {
  regimen: "pequena_empresa" as const, nombre: "Pequeña empresa (150 a 1700 UIT)",
  essalud_pct: 0.09, usa_sis: false, sis_aporte_mensual: 0,
  gratificaciones_sueldos: 1, bonif_extraordinaria_pct: 0.09,
  cts_sueldos_anio: 0.5, vacaciones_dias: 15,
};
const MECANICO = {
  tipo_contrato: "planilla", sueldo_basico: 1800, tiene_asignacion: false,
  rmv: 1130, asignacion_familiar_pct: 0.10, sctr_mensual: 20,
};

// ── 1 · LA INVARIANTE DURA ───────────────────────────────────────────────────

linea("1 · NINGUNA LÍNEA `propio` LLEGA AL DESEMBOLSO (= a v_egresos)");

// El caso que abrió todo: repuesto comprado en un sitio, mano de obra en un taller tercero.
const mixta: Linea[] = [
  L({ id: 1, concepto: "Kit de embrague", tipo: "material", origen: "comprado", monto: 620, proveedor_id: 10, documento_compra_id: 100 }),
  L({ id: 2, concepto: "Cambio de embrague", tipo: "mano_obra", origen: "comprado", monto: 250, proveedor_id: 11, documento_compra_id: 101 }),
];
const r1 = repartoDeOT(mixta, [], null);
ok(r1.desembolsado === 870 && r1.imputado === 0 && r1.total === 870,
   "dos proveedores, una sola orden → todo es desembolso", `${r1.desembolsado} + ${r1.imputado}`);

// El futuro: el material se compra y la mano de obra la hace el mecánico de casa.
const conPropia: Linea[] = [
  L({ id: 1, concepto: "Kit de embrague", tipo: "material", origen: "comprado", monto: 620, documento_compra_id: 100 }),
  L({ id: 2, concepto: "6 h del mecánico", tipo: "mano_obra", origen: "propio", monto: 78.9, horas: 6, tarifa_hora: 13.15 }),
];
const r2 = repartoDeOT(conPropia, [], null);
ok(r2.desembolsado === 620, "la hora de casa NO entra al egreso: la planilla ya la pagó", `desembolsado ${r2.desembolsado}`);
ok(r2.imputado === 78.9, "…pero SÍ cuenta como costo del vehículo", `imputado ${r2.imputado}`);
ok(r2.total === 698.9, "…y el costo real de la orden es la suma de los dos", `total ${r2.total}`);
ok(/no es egreso nuevo/.test(r2.detalle), "…y la pantalla lo DICE, no lo deja adivinar");

// Barrido: con cualquier combinación, el desembolso es exactamente la suma de lo comprado.
{
  const tipos: Linea["tipo"][] = ["material", "mano_obra", "servicio"];
  const montos = [0, 12.35, 500, 1999.99];
  let malos = 0, casos = 0;
  for (const t of tipos) for (const m of montos) for (const otro of montos) {
    const ls = [L({ id: 1, tipo: t, origen: "propio", monto: m }), L({ id: 2, tipo: t, origen: "comprado", monto: otro })];
    const r = repartoDeOT(ls, [], 9999);
    casos++;
    if (r.desembolsado !== otro || r.imputado !== m || r.total !== Math.round((m + otro) * 100) / 100) malos++;
  }
  ok(malos === 0, `barrido de ${casos} combinaciones: el desembolso es SOLO lo comprado`, `${malos} fallos`);
}

// El repuesto sacado del almacén también está pagado: `origen` no pregunta QUÉ es, pregunta si
// salió plata por ESTA orden.
const almacen = repartoDeOT([L({ id: 1, tipo: "material", origen: "propio", monto: 300 })], [], null);
ok(almacen.desembolsado === 0 && almacen.imputado === 300,
   "un material de almacén es `propio` igual: ya se pagó cuando se compró");

// ── 2 · SIN LÍNEAS, EL COMPORTAMIENTO ANTERIOR INTACTO ───────────────────────

linea("2 · SIN LÍNEAS, EL REPARTO ES EL DE ANTES (ADITIVO)");

{
  const escenarios: { items: { id: number; costo: number | null }[]; tecleado: number | null }[] = [
    { items: [], tecleado: null },
    { items: [], tecleado: 450 },
    { items: [{ id: 1, costo: null }, { id: 2, costo: null }], tecleado: 450 },
    { items: [{ id: 1, costo: 120.5 }, { id: 2, costo: 80.25 }, { id: 3, costo: null }], tecleado: 999 },
    { items: [{ id: 1, costo: 0 }, { id: 2, costo: null }], tecleado: 300 },
  ];
  let malos = 0;
  for (const e of escenarios) {
    const viejo = totalDeOT(e.items, e.tecleado);
    const nuevo = repartoDeOT([], e.items, e.tecleado);
    if (nuevo.total !== viejo.total || nuevo.desembolsado !== viejo.total || nuevo.imputado !== 0) malos++;
    if (nuevo.detalle !== viejo.detalle) malos++;
  }
  ok(malos === 0, "el total, el detalle y el imputado coinciden con `totalDeOT` en los 5 escenarios", `${malos} fallos`);
}

// ── 3 · EL ÍTEM QUE UNA LÍNEA NO REPRESENTA NO SE PIERDE ─────────────────────

linea("3 · LA UNIÓN LÍNEAS ∪ ÍTEMS SUELTOS — LO QUE IMPIDE PERDER DINERO");

// El fallo que la unión evita: S/ 200 tecleados en un ítem y una línea de mano de obra después.
const items200 = [{ id: 7, costo: 200 }, { id: 8, costo: null }];
const conMano = repartoDeOT([L({ id: 1, tipo: "mano_obra", origen: "comprado", monto: 150 })], items200, null);
ok(conMano.desembolsado === 350,
   "un ítem con costo que ninguna línea representa SIGUE contando", `${conMano.desembolsado} (no 150)`);
ok(conMano.itemsSueltos === 1, "…y se dice cuántos son", `${conMano.itemsSueltos}`);

// Y la otra mitad: una línea anclada al ítem lo SUSTITUYE, no se suma dos veces.
const anclada = repartoDeOT(
  [L({ id: 1, tipo: "material", origen: "comprado", monto: 200, checklist_ot_id: 7 }),
   L({ id: 2, tipo: "mano_obra", origen: "comprado", monto: 150 })],
  items200, null);
ok(anclada.desembolsado === 350 && anclada.itemsSueltos === 0,
   "la línea anclada al ítem 7 lo REEMPLAZA: un solo importe autoritativo", `${anclada.desembolsado}`);

// El total tecleado solo manda cuando no hay itemización de ninguna clase.
const conLineasYTecleado = repartoDeOT([L({ id: 1, monto: 10 })], [], 9999);
ok(conLineasYTecleado.total === 10, "con líneas, el total tecleado NO manda", `${conLineasYTecleado.total}`);

// ── 4 · LA HORA DE CASA ──────────────────────────────────────────────────────

linea("4 · LA HORA DE CASA: CASCADA CON FUENTE DECLARADA");

const soloTarifa: Insumos = { tarifa_hora: 25, mecanico: null, regimen: null, horas_mes: null };
const t1 = tarifaHoraMecanico(soloTarifa);
ok(t1.fuente === "tarifa_configurada" && t1.tarifa === 25,
   "sin sueldo, manda la tarifa tecleada", `${t1.fuente} · ${t1.tarifa}`);

const conSueldo: Insumos = { tarifa_hora: 25, mecanico: MECANICO, regimen: REGIMEN, horas_mes: null };
const t2 = tarifaHoraMecanico(conSueldo);
ok(t2.fuente === "costo_empresa", "con el sueldo del mecánico, manda su COSTO EMPRESA real", t2.fuente);
// 1800 × 1.24 aprox: básico + 9 % EsSalud + 1/12 grati + 9 % de esa grati + 0.5/12 CTS + SCTR 20.
{
  const esperado = (1800 + 1800 * 0.09 + 1800 / 12 + (1800 / 12) * 0.09 + (1800 * 0.5) / 12 + 20) / HORAS_MES_DEFECTO;
  ok(Math.abs(t2.tarifa - esperado) < 1e-9,
     "…y el número es el de lib/costeo-conductor.ts ÷ horas del mes (una sola fórmula)",
     `S/ ${t2.tarifa.toFixed(4)}/h`);
}
ok(t2.tarifa !== 25, "…la tarifa tecleada queda de respaldo, no compite");
ok(/costo empresa/.test(t2.base), "…y la base se DECLARA, para poder imprimirla al lado");

const horasMenos: Insumos = { ...conSueldo, horas_mes: 104 };
ok(Math.abs(tarifaHoraMecanico(horasMenos).tarifa - t2.tarifa * 2) < 1e-9,
   "las horas del mes son el divisor, y se configuran");

const nada: Insumos = { tarifa_hora: null, mecanico: null, regimen: null, horas_mes: null };
const t3 = tarifaHoraMecanico(nada);
ok(t3.fuente === "sin_tarifa" && t3.tarifa === 0 && !!t3.falta,
   "SIN NINGUNA DE LAS DOS NO SE INVENTA UN S/HORA", t3.falta ?? "");
// Se comprueba que NOMBRA la pantalla, y con el rótulo que esa pantalla tiene de verdad: un
// mensaje que manda a una pestaña inexistente hace concluir que el ERP está roto.
ok(/\/mantenimiento → Próximos/.test(t3.falta ?? ""), "…y se NOMBRA dónde se arregla");

// Un sueldo en 0 no es un sueldo: cae a la tarifa en vez de valorizar la hora en cero.
const sueldoCero: Insumos = { tarifa_hora: 25, mecanico: { ...MECANICO, sueldo_basico: 0 }, regimen: REGIMEN, horas_mes: null };
ok(tarifaHoraMecanico(sueldoCero).fuente === "tarifa_configurada",
   "un sueldo en 0 no valoriza la hora en 0: cae al respaldo");

const v = valorizarManoObraPropia(6, conSueldo);
ok(v.monto === Math.round(6 * t2.tarifa * 100) / 100 && v.horas === 6,
   "valorizar son horas × tarifa, al céntimo, y se guardan LOS DOS factores", `S/ ${v.monto}`);
ok(valorizarManoObraPropia(6, nada).monto === 0,
   "sin tarifa, el monto es 0 y la línea queda sin valorizar — nunca un número inventado");

// ── 5 · LAS FACTURAS ─────────────────────────────────────────────────────────

linea("5 · CON DOS FACTURAS, NINGUNA REPRESENTA A LA ORDEN EN EL LIBRO");

const f0 = facturasDeOT(null, []);
ok(f0.ids.length === 0 && f0.principal === null, "sin comprobantes, nada que enlazar");

const f1 = facturasDeOT(500, []);
ok(f1.principal === 500, "una sola factura en la orden → esa es");

const f1b = facturasDeOT(null, [L({ id: 1, monto: 10, documento_compra_id: 700 })]);
ok(f1b.principal === 700, "una sola factura, y está en una línea → esa es");

const f2 = facturasDeOT(null, [
  L({ id: 1, monto: 620, documento_compra_id: 700 }),
  L({ id: 2, monto: 250, documento_compra_id: 701 }),
]);
ok(f2.ids.length === 2 && f2.principal === null,
   "DOS facturas → ninguna: la columna del libro es escalar y elegir una escondería la otra");
ok(/no guarda ninguno/.test(f2.detalle), "…y se explica por qué, no se calla", f2.detalle.slice(0, 60) + "…");

const repetida = facturasDeOT(700, [L({ id: 1, monto: 10, documento_compra_id: 700 })]);
ok(repetida.ids.length === 1 && repetida.principal === 700,
   "la misma factura en la orden y en su línea es UNA, no dos");

// ── Cierre ───────────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "✅ TODO VERDE" : `❌ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
