// Matriz del RENDIMIENTO MEDIDO POR TIPO DE VEHÍCULO: qué mide la flota para un tipo de
// `parametros_costos`, y si eso se puede proponer como parámetro.
// Uso:  npx tsx scripts/prueba-rendimiento-tipo.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · LAS DOS INVARIANTES DEL AGREGADO. `proponible === (codigo === "medido")` y "hay número
//     exactamente en los cinco códigos que lo tienen". Son lo que permite que la pantalla
//     enrute por CÓDIGO en vez de olfatear el texto: un código nuevo sin número, o un
//     `proponible` que se cuele en otro código, pone un botón que escribe dinero donde no
//     debería. Se comprueban por barrido sobre todas las combinaciones, no caso por caso.
//
// 2 · QUE `aportan` Y `observadas` SEAN DISJUNTAS Y EXHAUSTIVAS. Una placa que se ve en la
//     flota y no aparece en ninguna de las dos listas es una unidad que la pantalla no explica
//     en ningún sitio: el operador la busca y no está.
//
// 3 · EL CASO QUE LO MOTIVÓ (CWZ-371) VA DENTRO, con sus cargas reales pasadas por el motor de
//     verdad (`seriesRendimiento`), no con una mediana inventada. Incluye el tramo de 162.9
//     km/gal que ya dio un susto en producción: tiene que quedar FUERA de la mediana y, sobre
//     todo, NO contar como "faltan cargas" — si contara, el tipo quedaría bloqueado para
//     siempre en `revisar_cargas` y esta funcionalidad no serviría justo para el caso que la
//     motivó.
//
// 4 · LA ASIMETRÍA DEL GATE. `rendimiento_alto` (no físico) BLOQUEA la propuesta y
//     `rendimiento_bajo` NO. No es simetría rota por descuido: el alto es plata que falta en
//     los libros e infla la mediana; el bajo es costo real y excluirlo sesgaría la mediana
//     hacia arriba, o sea hacia el error que no vuelve.
//
// 5 · EL LADO QUE NO SE PUEDE AFLOJAR (última sección). Todo lo de arriba RESTRINGE cuándo se
//     propone, así que el riesgo es apagar la funcionalidad sin que nadie lo note. La última
//     sección fija que una medición buena sigue proponiéndose.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const TIPO = requerir("../lib/costos/rendimiento-tipo") as typeof import("../lib/costos/rendimiento-tipo");
const FLOTA = requerir("../lib/costos/rendimiento-flota") as typeof import("../lib/costos/rendimiento-flota");
const REND = requerir("../lib/rendimiento") as typeof import("../lib/rendimiento");

const {
  agregarRendimientoTipo, agregarPorTipo, familiaDeParametro, procedenciaDeHistorial,
  etiquetaAgregado, motivoHistorial, PASO_RENDIMIENTO, CAMPO_DESCARTE, SIN_PROCEDENCIA,
} = TIPO;
const { placaMedida } = FLOTA;
const { seriesRendimiento, MIN_TRAMOS_CONFIABLE } = REND;

type PlacaMedida = import("../lib/costos/rendimiento-tipo").PlacaMedida;
type CodigoAgregado = import("../lib/costos/rendimiento-tipo").CodigoAgregado;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── FIXTURES ──────────────────────────────────────────────────────────────────

let seq = 0;
function placa(o: Partial<PlacaMedida> = {}): PlacaMedida {
  const n = ++seq;
  return {
    uid: `p${n}`, vehiculoId: n, placa: `AAA-${String(n).padStart(3, "0")}`,
    flota: "propia", tipoCosteo: "SPRINTER_17_DIESEL",
    familia: "diesel", label: "km/gal",
    mediana: 28.5, tramos: 8, confiable: true,
    medianaReciente: null, tramosReciente: 0,
    tramosAltos: 0, tramosBajos: 0, cargasSinOdometro: 0,
    descartes: [], desde: "2026-01-01", hasta: "2026-09-01",
    ...o,
  };
}

const SPRINTER = {
  tipo_vehiculo: "SPRINTER_17_DIESEL", nombre: "Sprinter 17 pax Diésel",
  rendimiento_1: 19, tipo_combustible_1: "Diésel",
};
const BIMODAL = {
  tipo_vehiculo: "VAN_GLP", nombre: "Van GLP + Gasolina",
  rendimiento_1: 22, tipo_combustible_1: "GLP",
  tipo_combustible_2: "Gasolina", pct_uso_2: 0.4,
};
const GNV = {
  tipo_vehiculo: "BUS_60_GNV", nombre: "Bus 60 GNV",
  rendimiento_1: 3, tipo_combustible_1: "GNV",
};

// ── 1 · LA FAMILIA DEL PARÁMETRO SALE DE UN MAPA EXPLÍCITO ────────────────────
// `familiaCombustible()` cae a diésel ante cualquier valor desconocido. Para leer es inocuo;
// aquí decide si una mediana de GLP puede sustituir el rendimiento de un tipo diésel.
console.log("\n1 · familiaDeParametro");
{
  chk('"Diésel" → diesel', familiaDeParametro("Diésel") === "diesel");
  chk('"Diesel" sin tilde → diesel', familiaDeParametro("Diesel") === "diesel");
  chk('"GNV" → gnv', familiaDeParametro("GNV") === "gnv");
  chk('"glp" en minúscula → glp', familiaDeParametro("glp") === "glp");
  chk('"Gasohol 90" (fila nueva del catálogo) → null, NO diesel', familiaDeParametro("Gasohol 90") === null);
  chk('"" → null', familiaDeParametro("") === null);
  chk("null → null", familiaDeParametro(null) === null);
}

// ── 2 · EL CASO CWZ-371, CON EL MOTOR DE VERDAD ───────────────────────────────
console.log("\n2 · CWZ-371: ocho tramos sanos y un 162.9 que no es de nadie");

/** Cargas de diésel a ~28.5 km/gal, más el hueco de registro que produjo el 162.9. */
function cargasCwz(): any[] {
  const base = [
    ["2026-06-01", 100000], ["2026-06-08", 100285], ["2026-06-15", 100570],
    ["2026-06-22", 100850], ["2026-06-29", 101140], ["2026-07-06", 101425],
    ["2026-07-13", 101710], ["2026-07-20", 101995], ["2026-07-27", 102280],
  ];
  const cs = base.map(([fecha, km], i) => ({
    id: i + 1, unidad: "p7", fecha, kilometraje: km as number,
    cantidad: 10, unidadCantidad: "galones", tipo: "diesel", gasto: 250,
  }));
  // El hueco: veinte días sin ninguna carga registrada, 1 620 km acumulados en 9.77 gal.
  cs.push({ id: 99, unidad: "p7", fecha: "2026-08-16", kilometraje: 103900,
    cantidad: 9.77, unidadCantidad: "galones", tipo: "diesel", gasto: 240 });
  return cs;
}

const serieCwz = [...seriesRendimiento(cargasCwz() as any).values()][0];
const cwz = placaMedida(serieCwz, { vehiculoId: 7, placa: "CWZ-371", flota: "propia", tipoCosteo: "SPRINTER_17_DIESEL" }, "2026-01-01");
{
  chk("mide 28.5 km/gal", cwz.mediana === 28.5, String(cwz.mediana));
  chk("ocho tramos buenos", cwz.tramos === 8, String(cwz.tramos));
  chk("es confiable", cwz.confiable);
  chk("el 162.9 NO cuenta como 'faltan cargas' (es físico, ya está fuera de la mediana)",
    cwz.tramosAltos === 0, `tramosAltos=${cwz.tramosAltos}`);
  const imp = cwz.descartes.find((d) => d.codigo === "implausible");
  chk("pero SÍ se enseña, con su número crudo, para poder tacharlo", !!imp && (imp!.crudo ?? 0) > 100,
    imp ? `crudo=${imp.crudo?.toFixed(1)}` : "no está");
  chk("la unidad la declara el motor, nunca un literal", cwz.label === "km/gal");

  const a = agregarRendimientoTipo(SPRINTER, [cwz]);
  chk("el tipo sale PROPONIBLE", a.codigo === "medido" && a.proponible, `${a.codigo}`);
  chk("propone 28.5 contra los 19 tecleados", a.medido === 28.5 && a.parametro === 19);
  chk("el desvío es +50 %", Math.abs((a.desvio ?? 0) - 0.5) < 0.001, String(a.desvio));
  chk("el detalle nombra la placa y los tramos", a.detalle.includes("CWZ-371") && a.detalle.includes("8 tramo"));
  chk("el motivo del acta empieza por 'Auto:' (es lo que lee procedenciaDeHistorial)",
    motivoHistorial(a).startsWith("Auto:"), motivoHistorial(a));
}

// ── 3 · EL GATE ES ASIMÉTRICO: EL ALTO BLOQUEA, EL BAJO NO ────────────────────
console.log("\n3 · el gate de hallazgos");

/** Una unidad que rinde 20 km/gal y tiene un tramo de 30: la firma de una carga sin registrar. */
function cargasConTramo(ultimoKm: number): any[] {
  const kms = [200000, 200200, 200400, 200600, 200800, 201000];
  const cs = kms.map((km, i) => ({
    id: 500 + i, unidad: "p8", fecha: `2026-07-0${i + 1}`, kilometraje: km,
    cantidad: 10, unidadCantidad: "galones", tipo: "diesel", gasto: 250,
  }));
  cs.push({ id: 599, unidad: "p8", fecha: "2026-07-09", kilometraje: ultimoKm,
    cantidad: 10, unidadCantidad: "galones", tipo: "diesel", gasto: 250 });
  return cs;
}
{
  const alta = placaMedida([...seriesRendimiento(cargasConTramo(201300) as any).values()][0],
    { vehiculoId: 8, placa: "BBB-111", flota: "propia", tipoCosteo: "SPRINTER_17_DIESEL" }, "2026-01-01");
  chk("un tramo de 30 sobre mediana 20 se cuenta como alto", alta.tramosAltos === 1, `altos=${alta.tramosAltos}`);
  const aA = agregarRendimientoTipo(SPRINTER, [alta]);
  chk("y BLOQUEA la propuesta (plata que falta en los libros)", aA.codigo === "revisar_cargas" && !aA.proponible);
  chk("pero el número se sigue enseñando, para poder juzgarlo", aA.medido !== null);
  chk("y el detalle dice cuántos tramos y en qué placa", aA.detalle.includes("BBB-111"));

  const baja = placaMedida([...seriesRendimiento(cargasConTramo(201130) as any).values()][0],
    { vehiculoId: 9, placa: "CCC-222", flota: "propia", tipoCosteo: "SPRINTER_17_DIESEL" }, "2026-01-01");
  chk("un tramo de 13 sobre mediana 20 se cuenta como bajo", baja.tramosBajos === 1, `bajos=${baja.tramosBajos}`);
  const aB = agregarRendimientoTipo(SPRINTER, [baja]);
  chk("y NO bloquea: es costo real, excluirlo sesgaría la mediana hacia arriba",
    aB.codigo === "medido" && aB.proponible, aB.codigo);
}

// ── 4 · LA VENTANA RECIENTE SE FILTRA, NO SE RE-SERIALIZA ─────────────────────
console.log("\n4 · la ventana reciente");
{
  // Corte a mitad de la cadena de la CWZ-371: los tramos del 06-22 en adelante.
  const recorte = placaMedida(serieCwz, { vehiculoId: 7, placa: "CWZ-371", flota: "propia", tipoCosteo: "X" }, "2026-06-22");
  const buenosEnVentana = serieCwz.tramos.filter((t) => t.rendimiento !== null && t.fecha >= "2026-06-22").length;
  chk("cuenta los tramos buenos dentro de la ventana", recorte.tramosReciente === buenosEnVentana,
    `${recorte.tramosReciente} vs ${buenosEnVentana}`);
  chk("y NO pierde el que abre la ventana (re-serializar lo volvería 'primera_carga')",
    recorte.tramosReciente === 6, String(recorte.tramosReciente));
  chk("la mediana histórica no cambia por mirar un trozo del calendario", recorte.mediana === 28.5);

  // Se propone la MENOR de las dos ventanas: un motor que se degradó no puede colarse.
  const p1 = placa({ mediana: 28.5, medianaReciente: 24, tramosReciente: MIN_TRAMOS_CONFIABLE });
  const a1 = agregarRendimientoTipo(SPRINTER, [p1]);
  chk("con la reciente PEOR, se propone la reciente", a1.medido === 24 && a1.ventanaElegida === "reciente");

  const p2 = placa({ mediana: 28.5, medianaReciente: 31, tramosReciente: MIN_TRAMOS_CONFIABLE });
  const a2 = agregarRendimientoTipo(SPRINTER, [p2]);
  chk("con la reciente MEJOR, se conserva la histórica", a2.medido === 28.5 && a2.ventanaElegida === "historico");

  const p3 = placa({ mediana: 28.5, medianaReciente: 12, tramosReciente: MIN_TRAMOS_CONFIABLE - 1 });
  const a3 = agregarRendimientoTipo(SPRINTER, [p3]);
  chk("una ventana reciente con pocos tramos NO manda", a3.medido === 28.5 && a3.ventanaElegida === "historico");
}

// ── 5 · POR QUÉ UN TIPO NO TIENE NÚMERO: UN CÓDIGO POR CAUSA ──────────────────
console.log("\n5 · los motivos, uno por causa");
{
  const casos: [string, any, PlacaMedida[], CodigoAgregado][] = [
    ["bimodal, aunque la medición sea perfecta", BIMODAL, [placa({ familia: "glp", tipoCosteo: "VAN_GLP" })], "tipo_bimodal"],
    ["combustible fuera del catálogo", { ...SPRINTER, tipo_combustible_1: "Gasohol 90" }, [placa()], "familia_desconocida"],
    ["ninguna unidad apunta al tipo", SPRINTER, [], "sin_placas"],
    ["solo unidades de tercero", SPRINTER, [placa({ flota: "tercero" })], "solo_terceros"],
    ["la unidad mide otro combustible", SPRINTER, [placa({ familia: "glp" })], "familia_distinta"],
    ["sin ningún tramo medido", SPRINTER, [placa({ mediana: null, tramos: 0, confiable: false })], "sin_medicion"],
    ["pocos tramos", SPRINTER, [placa({ tramos: MIN_TRAMOS_CONFIABLE - 1, confiable: false })], "pocos_tramos"],
  ];
  for (const [nombre, par, ps, esperado] of casos) {
    const a = agregarRendimientoTipo(par, ps);
    chk(nombre, a.codigo === esperado && !a.proponible, `${a.codigo} · "${etiquetaAgregado(a.codigo)}"`);
  }

  // LA FRONTERA EXACTA de MIN_TRAMOS_CONFIABLE, medida en los dos lados.
  const justo = agregarRendimientoTipo(SPRINTER, [placa({ tramos: MIN_TRAMOS_CONFIABLE, confiable: true })]);
  chk(`justo en ${MIN_TRAMOS_CONFIABLE} tramos ya vota`, justo.codigo === "medido");
  const uno = agregarRendimientoTipo(SPRINTER, [placa({ tramos: 1, confiable: false })]);
  chk("con un solo tramo no (una mediana de un valor ES ese valor)", uno.codigo === "pocos_tramos");

  // El bimodal gana sobre TODO lo demás: nunca le va a servir una medición.
  const bimSinPlacas = agregarRendimientoTipo(BIMODAL, []);
  chk("el bimodal se declara aunque no haya ninguna placa", bimSinPlacas.codigo === "tipo_bimodal");

  // El motivo del tipo es el de la placa que estuvo MÁS CERCA de votar.
  const mezcla = agregarRendimientoTipo(SPRINTER, [
    placa({ flota: "tercero" }), placa({ familia: "glp" }),
    placa({ tramos: 2, confiable: false }),
  ]);
  chk("con varias observadas, gana el motivo más cercano al arreglo", mezcla.codigo === "pocos_tramos", mezcla.codigo);
}

// ── 6 · UNA PLACA, UN VOTO ────────────────────────────────────────────────────
console.log("\n6 · una placa, un voto");
{
  const a = agregarRendimientoTipo(SPRINTER, [placa({ mediana: 26 }), placa({ mediana: 30 })]);
  chk("dos votantes → decide una persona, no se propone", a.codigo === "varias_placas" && !a.proponible);
  chk("y se enseña la mediana de las dos", a.medido === 28, String(a.medido));
  chk("el detalle trae las dos placas con su número", (a.detalle.match(/AAA-/g) || []).length === 2);

  // MEDIANA DE MEDIANAS, no del pool de tramos: la unidad que reposta el triple no pesa el triple.
  const b = agregarRendimientoTipo(SPRINTER, [placa({ mediana: 20, tramos: 40 }), placa({ mediana: 30, tramos: 5 })]);
  chk("la que más carga no arrastra la mediana del tipo", b.medido === 25, String(b.medido));

  // BICOMBUSTIBLE: la misma placa llega con DOS series y tiene que colapsar a una.
  const glp = placa({ uid: "p50", placa: "CWQ-400", familia: "glp", mediana: 18, tramos: 12 });
  const gas = placa({ uid: "p50", placa: "CWQ-400", familia: "gasolina", mediana: 90, tramos: 2, confiable: false });
  const glpPar = { ...SPRINTER, tipo_vehiculo: "VAN_GLP_SOLO", tipo_combustible_1: "GLP", rendimiento_1: 14 };
  const c = agregarRendimientoTipo(glpPar, [glp, gas]);
  chk("una unidad bicombustible cuenta UNA vez", c.aportan.length + c.observadas.length === 1);
  chk("y con la serie de la familia del parámetro", c.codigo === "medido" && c.medido === 18, `${c.codigo} ${c.medido}`);
}

// ── 7 · YA REVISADO / YA COINCIDE ─────────────────────────────────────────────
console.log("\n7 · la memoria de la decisión");
{
  const desc = { origen: "manual" as const, fecha: "2026-09-01", por: "yo", descartado: 28.5 };
  const a = agregarRendimientoTipo(SPRINTER, [placa()], desc);
  chk("una medición ya revisada y no adoptada no se vuelve a proponer", a.codigo === "descartado" && !a.proponible);

  const b = agregarRendimientoTipo(SPRINTER, [placa({ mediana: 28.5 + PASO_RENDIMIENTO })], desc);
  chk("pero si lo medido se MUEVE un paso, vuelve", b.codigo === "medido" && b.proponible, String(b.medido));

  const c = agregarRendimientoTipo({ ...SPRINTER, rendimiento_1: 28.5 }, [placa()]);
  chk("si el tecleado ya coincide, no hay nada que aplicar", c.codigo === "coincide" && !c.proponible);

  const d = agregarRendimientoTipo({ ...SPRINTER, rendimiento_1: 28.4 }, [placa()]);
  chk("por debajo del paso del campo también coincide", d.codigo === "coincide", `${d.codigo} ${d.medido}`);
}

// ── 8 · LA PROCEDENCIA SE DERIVA DEL HISTORIAL, SIN COLUMNAS NUEVAS ───────────
console.log("\n8 · procedenciaDeHistorial");
{
  const f = (campo: string, en: string, motivo: string | null = null, valor: number | null = null) =>
    ({ campo_modificado: campo, valor_nuevo: valor, motivo, cambiado_por: "yo", cambiado_en: en });

  chk("sin filas: manual y sin descarte",
    JSON.stringify(procedenciaDeHistorial([])) === JSON.stringify(SIN_PROCEDENCIA));

  const auto = procedenciaDeHistorial([f("rendimiento_1", "2026-09-01", "Auto: medido 28.5 km/gal · 8 tramos · CWZ-371", 28.5)]);
  chk("un acta que empieza por 'Auto:' marca origen medido", auto.origen === "medido");

  const man = procedenciaDeHistorial([f("rendimiento_1", "2026-09-01", "Ajuste inflación", 21)]);
  chk("cualquier otro motivo es manual", man.origen === "manual");

  const caduca = procedenciaDeHistorial([
    f("rendimiento_1", "2026-09-01", "Auto: medido 28.5 km/gal", 28.5),
    f(CAMPO_DESCARTE, "2026-09-02", "revisada", 28.5),
    f("tipo_combustible_1", "2026-09-03", "Combustible → GLP"),
  ]);
  chk("cambiar el combustible del tipo CADUCA el sello y el descarte",
    caduca.origen === "manual" && caduca.descartado === null);

  const orden = procedenciaDeHistorial([
    f(CAMPO_DESCARTE, "2026-09-02", "revisada", 28.5),
    f("rendimiento_1", "2026-09-01", "Auto: medido 28.5", 28.5),
  ]);
  chk("las filas se ordenan por fecha, no por como llegan", orden.origen === "medido" && orden.descartado === 28.5);
}

// ── 9 · EL REPARTO POR TIPO ───────────────────────────────────────────────────
console.log("\n9 · agregarPorTipo");
{
  const ps = [
    placa({ tipoCosteo: "SPRINTER_17_DIESEL" }),
    placa({ tipoCosteo: "BUS_60_GNV", familia: "gnv", label: "km/m³", mediana: 4 }),
    placa({ tipoCosteo: null }),
    placa({ tipoCosteo: "  " }),
  ];
  const m = agregarPorTipo([SPRINTER, GNV], ps);
  chk("cada tipo recibe sus placas por el texto CRUDO", m.size === 2);
  chk("el Sprinter mide 28.5", m.get("SPRINTER_17_DIESEL")!.medido === 28.5);
  chk("el GNV publica su unidad, no un 'km/gal' literal", m.get("BUS_60_GNV")!.label === "km/m³");
  chk("una placa sin categoría de costeo no entra a ningún cubo (ni a uno fantasma)",
    !m.has("") && !m.has("  "));

  const sinTipo = agregarPorTipo([{ ...SPRINTER, tipo_vehiculo: "NO_EXISTE" }], ps);
  chk("un tipo sin placas se agrega igual, diciendo por qué", sinTipo.get("NO_EXISTE")!.codigo === "sin_placas");
}

// ── 10 · LAS INVARIANTES, POR BARRIDO ─────────────────────────────────────────
console.log("\n10 · invariantes sobre todas las combinaciones");
{
  const CON_NUMERO: CodigoAgregado[] = ["medido", "coincide", "descartado", "revisar_cargas", "varias_placas"];
  const params = [SPRINTER, BIMODAL, GNV, { ...SPRINTER, tipo_combustible_1: "Gasohol 90" }, { ...SPRINTER, rendimiento_1: 0 }];
  const conjuntos: PlacaMedida[][] = [
    [],
    [placa()],
    [placa({ flota: "tercero" })],
    [placa({ familia: "glp" })],
    [placa({ mediana: null, tramos: 0, confiable: false })],
    [placa({ tramos: 2, confiable: false })],
    [placa({ tramosAltos: 2 })],
    [placa({ tramosBajos: 3 })],
    [placa(), placa({ mediana: 31 })],
    [placa(), placa({ flota: "tercero" }), placa({ familia: "gnv" })],
    [placa({ medianaReciente: 21, tramosReciente: 9 })],
  ];
  const procs = [SIN_PROCEDENCIA, { origen: "manual" as const, fecha: null, por: null, descartado: 28.5 }];

  let malaInv1 = 0, malaInv2 = 0, malReparto = 0, malDetalle = 0, malDesvio = 0;
  let n = 0;
  for (const par of params) for (const ps of conjuntos) for (const pr of procs) {
    const a = agregarRendimientoTipo(par as any, ps, pr);
    n++;
    if (a.proponible !== (a.codigo === "medido")) malaInv1++;
    if ((a.medido !== null) !== CON_NUMERO.includes(a.codigo)) malaInv2++;
    // El reparto es exhaustivo y disjunto sobre las placas ya colapsadas por uid.
    const uids = new Set(ps.map((p) => p.uid));
    const vistas = [...a.aportan.map((p) => p.uid), ...a.observadas.map((o) => o.placa.uid)];
    const esperado = a.codigo === "tipo_bimodal" || a.codigo === "familia_desconocida" ? 0 : uids.size;
    if (vistas.length !== esperado || new Set(vistas).size !== vistas.length) malReparto++;
    if (!a.detalle.trim()) malDetalle++;
    if (a.desvio !== null && !Number.isFinite(a.desvio)) malDesvio++;
  }
  chk(`INVARIANTE 1: proponible === (codigo === "medido") · ${n} combinaciones`, malaInv1 === 0, `${malaInv1} fallan`);
  chk("INVARIANTE 2: hay número exactamente en los cinco códigos que lo tienen", malaInv2 === 0, `${malaInv2} fallan`);
  chk("aportan ∪ observadas cubre TODAS las placas, sin repetir", malReparto === 0, `${malReparto} fallan`);
  chk("ningún código sale sin detalle", malDetalle === 0);
  chk("el desvío nunca es Infinity (parámetro en 0)", malDesvio === 0);
}

// ── 11 · EL LADO QUE NO SE PUEDE AFLOJAR ──────────────────────────────────────
// Todo lo de arriba RESTRINGE. El riesgo es dejar la funcionalidad apagada sin que nadie lo
// note: la pantalla diría siempre "no se puede medir" y el parámetro se quedaría en 19 para
// siempre, que es exactamente el problema que esto vino a resolver.
console.log("\n11 · lo que tiene que seguir proponiéndose");
{
  const buenos: [string, any, PlacaMedida[]][] = [
    ["la CWZ-371 real, con su 162.9 dentro", SPRINTER, [cwz]],
    ["una placa con tramos de sobra", SPRINTER, [placa({ tramos: 40, mediana: 27 })]],
    ["justo en el mínimo de tramos", SPRINTER, [placa({ tramos: MIN_TRAMOS_CONFIABLE })]],
    ["con tramos bajos (costo real, no bloquea)", SPRINTER, [placa({ tramosBajos: 4 })]],
    ["con cargas sin odómetro (no es motivo de bloqueo)", SPRINTER, [placa({ cargasSinOdometro: 3 })]],
    ["un tipo GNV medido en km/m³", GNV, [placa({ familia: "gnv", label: "km/m³", mediana: 4.2, tipoCosteo: "BUS_60_GNV" })]],
    ["con unidades de tercero al lado, que se ven pero no votan", SPRINTER, [placa(), placa({ flota: "tercero" })]],
  ];
  for (const [nombre, par, ps] of buenos) {
    const a = agregarRendimientoTipo(par, ps);
    chk(`sigue proponiéndose: ${nombre}`, a.proponible && a.medido !== null, `${a.codigo} · ${a.medido}`);
  }
  const conTerceros = agregarRendimientoTipo(SPRINTER, [placa(), placa({ flota: "tercero" })]);
  chk("y el tercero queda nombrado como quien HEREDA el número", conTerceros.heredan.length === 1);
}

console.log(`\n${fallos ? `❌ ${fallos} fallo(s)` : "✅ todo en verde"}\n`);
process.exit(fallos ? 1 : 0);
