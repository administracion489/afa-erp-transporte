// Matriz del TANQUE DE LA UNIDAD: cómo se resuelve la capacidad contra la que se juzga una
// carga, y el cotejo entre la ficha de costeo de una placa y lo que esa placa puede cargar.
// Uso:  npx tsx scripts/prueba-tanque.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · LOS TRES DEFECTOS QUE HABÍA, CONSERVADOS COMO REGRESIÓN. El algoritmo viejo está copiado
//     LITERAL aquí abajo —tal como estaba en app/combustible/page.tsx y, palabra por palabra,
//     en lib/radar/acciones.ts— y la prueba comprueba que reproduce cada uno. Si algún día deja
//     de reproducirlos, el escenario dejó de ser el que se rompió y la prueba ya no vale.
//       (a) `capacidad_tanque` se ESCRIBE por familia y se LEÍA por tipo, así que una carga de
//           `gasolina_regular`/`gasolina_premium` NUNCA encontraba la capacidad configurada.
//       (b) al no encontrar la clave, la heurística remataba en `v.diesel`: una carga de
//           gasolina en un bus se comparaba contra el tanque de DIÉSEL (100 gal, no 80).
//       (c) `"MINIBUS".includes("BUS")` es true y BUS iba primero en la tabla, así que TODO
//           minibús se juzgaba con el tanque de un bus y 70 gal en un minibús no levantaban nada.
//
// 2 · EL LADO QUE NO SE PUEDE AFLOJAR. Diésel, GLP, GNV y urea se escriben igual como tipo y
//     como familia, así que para ellos el comportamiento tiene que ser IDÉNTICO al de antes —si
//     cambiara, este arreglo habría movido el control de tanque de toda la flota sin que nadie
//     lo pidiera. La sección 4 compara viejo contra nuevo sobre una rejilla completa.
//
// 3 · QUE UN TANQUE SE PUEDA VACIAR. `parseCapacidadTanque({}) === null` es lo que permite
//     BORRAR una capacidad mal tecleada; con el guard viejo (`...(capT ? {…} : {})`) ese null
//     no viajaba y el número equivocado se quedaba escrito para siempre.
//
// 4 · EL COTEJO FICHA ↔ TANQUE no inventa nada: sin tanques declarados NO dice que discrepe.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const CT = requerir("../lib/combustible-tipos") as typeof import("../lib/combustible-tipos");
const TIPO = requerir("../lib/costos/rendimiento-tipo") as typeof import("../lib/costos/rendimiento-tipo");

const {
  capacidadTanqueDe, capacidadDeclarada, FAMILIAS_TANQUE, CAPACIDAD_TANQUE_CATEGORIA,
  parseCapacidadTanque, capacidadTanqueAForm, faltaColumnaTanque, COMBUSTIBLES, familiaCombustible,
} = CT;
const { cotejarFichaConTanques } = TIPO;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── EL ALGORITMO VIEJO, COPIADO LITERAL ───────────────────────────────────────
// No se toca. Si hay que cambiarlo para que la prueba pase, dejó de ser el que se rompió.
const CAP_VIEJA: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};
/** app/combustible/page.tsx, antes del cambio (idéntica a la de lib/radar/acciones.ts). */
function getCapacidad_ORIGINAL(vehOCat: any, tipo: string): number {
  if (vehOCat && typeof vehOCat === "object") {
    const edit = vehOCat.capacidad_tanque?.[tipo];
    if (edit != null && Number(edit) > 0) return Number(edit);
  }
  const categoria = typeof vehOCat === "string" ? vehOCat : vehOCat?.categoria ?? undefined;
  if (!categoria) return CAP_VIEJA.DEFAULT[tipo] || 80;
  const cat = categoria.toUpperCase();
  for (const [k, v] of Object.entries(CAP_VIEJA)) {
    if (cat.includes(k)) return v[tipo] || v.diesel || 80;
  }
  return CAP_VIEJA.DEFAULT[tipo] || 80;
}

// ── 1 · LOS TRES DEFECTOS, REPRODUCIDOS Y ARREGLADOS ──────────────────────────
console.log("\n1 · los tres defectos que había");
{
  // (a) La capacidad declarada por FAMILIA, consultada por TIPO.
  const bus = { categoria: "BUS", capacidad_tanque: { diesel: 100, gasolina: 75 } };
  chk("(a) el viejo NO encontraba la capacidad configurada de gasolina premium",
    getCapacidad_ORIGINAL(bus, "gasolina_premium") !== 75, `dio ${getCapacidad_ORIGINAL(bus, "gasolina_premium")}`);
  chk("(a) ahora sí la encuentra", capacidadTanqueDe(bus, "gasolina_premium") === 75,
    String(capacidadTanqueDe(bus, "gasolina_premium")));

  // (b) Sin capacidad declarada, el viejo remataba en el tanque de DIÉSEL.
  const busPelado = { categoria: "BUS", capacidad_tanque: null };
  chk("(b) el viejo daba el tanque de DIÉSEL a una carga de gasolina",
    getCapacidad_ORIGINAL(busPelado, "gasolina_regular") === 100, `dio ${getCapacidad_ORIGINAL(busPelado, "gasolina_regular")}`);
  chk("(b) ahora da el de gasolina", capacidadTanqueDe(busPelado, "gasolina_regular") === 80,
    String(capacidadTanqueDe(busPelado, "gasolina_regular")));

  // (c) "MINIBUS".includes("BUS").
  chk('(c) el viejo juzgaba un MINIBUS con el tanque de un BUS',
    getCapacidad_ORIGINAL("MINIBUS", "diesel") === 100, `dio ${getCapacidad_ORIGINAL("MINIBUS", "diesel")}`);
  chk("(c) ahora usa el suyo", capacidadTanqueDe("MINIBUS", "diesel") === 60,
    String(capacidadTanqueDe("MINIBUS", "diesel")));
  chk("(c) y un BUS de verdad no se movió", capacidadTanqueDe("BUS", "diesel") === 100);
}

// ── 2 · LA RESOLUCIÓN DE LA CLAVE ─────────────────────────────────────────────
console.log("\n2 · qué clave gana");
{
  chk("lo declarado gana sobre la heurística",
    capacidadTanqueDe({ categoria: "BUS", capacidad_tanque: { diesel: 55 } }, "diesel") === 55);
  chk("el TIPO exacto gana sobre la familia",
    capacidadTanqueDe({ categoria: "BUS", capacidad_tanque: { gasolina: 80, gasolina_premium: 40 } }, "gasolina_premium") === 40);
  chk("un 0 declarado no cuenta como declaración",
    capacidadTanqueDe({ categoria: "VAN", capacidad_tanque: { diesel: 0 } }, "diesel") === 20);
  chk("sin objeto, la categoría suelta sigue sirviendo", capacidadTanqueDe("VAN", "glp") === 25);
  chk("categoría desconocida → el estimado por defecto", capacidadTanqueDe("TRACTOR", "diesel") === 80);
  chk("sin categoría ni declaración → por defecto", capacidadTanqueDe(null, "diesel") === 80);
  chk("capacidadDeclarada devuelve null cuando no hay nada", capacidadDeclarada(null, "diesel") === null);
  chk("capacidadDeclarada resuelve por familia", capacidadDeclarada({ gasolina: 30 }, "gasolina_premium") === 30);
}

// ── 3 · EL CATÁLOGO DE FAMILIAS SE DERIVA ─────────────────────────────────────
console.log("\n3 · FAMILIAS_TANQUE deriva del catálogo");
{
  const familias = FAMILIAS_TANQUE.map((f) => f.familia);
  const delCatalogo = [...new Set(Object.values(COMBUSTIBLES).map((c) => c.familia))];
  chk("están todas las del catálogo y ninguna de más",
    familias.length === delCatalogo.length && delCatalogo.every((f) => familias.includes(f)),
    familias.join(", "));
  chk("sin repetidos (gasolina regular, premium y legado son UNA familia)",
    new Set(familias).size === familias.length);
  chk("cada una trae su etiqueta y su unidad",
    FAMILIAS_TANQUE.every((f) => !!f.label && !!f.unidadLabel));
  chk("el GNV declara m³, no galones",
    FAMILIAS_TANQUE.find((f) => f.familia === "gnv")?.unidadLabel === "m³");
  chk("toda familia es una clave de la tabla por categoría, o cae a diésel a propósito",
    familias.every((f) => f in CAPACIDAD_TANQUE_CATEGORIA.DEFAULT || f === "biodiesel"));
}

// ── 4 · EL LADO QUE NO SE PUEDE AFLOJAR ───────────────────────────────────────
console.log("\n4 · lo que NO debía cambiar");
{
  // Para los tipos cuyo nombre coincide con su familia, el resultado tiene que ser idéntico al
  // de antes en TODA la rejilla: si cambiara, este arreglo habría movido el control de tanque de
  // la flota entera de diésel sin que nadie lo pidiera.
  const iguales = ["diesel", "glp", "gnv", "urea"];
  const categorias = ["BUS", "VAN", "AUTO", "TRACTOR", "", "bus"];
  const declaradas = [null, { diesel: 90 }, { glp: 22 }, { diesel: 0 }];
  let distintos = 0, n = 0;
  for (const tipo of iguales) for (const categoria of categorias) for (const capacidad_tanque of declaradas) {
    const veh = { categoria, capacidad_tanque } as any;
    n++;
    if (capacidadTanqueDe(veh, tipo) !== getCapacidad_ORIGINAL(veh, tipo)) distintos++;
  }
  chk(`diésel, GLP, GNV y urea: idénticos al viejo en ${n} combinaciones`, distintos === 0, `${distintos} difieren`);
  chk("y el MINIBUS es la ÚNICA categoría que cambia a propósito",
    capacidadTanqueDe("MINIBUS", "diesel") !== getCapacidad_ORIGINAL("MINIBUS", "diesel"));
}

// ── 5 · VACIAR UN TANQUE TIENE QUE PODERSE ────────────────────────────────────
console.log("\n5 · el formulario, ida y vuelta");
{
  chk("todo vacío → null (es lo que permite BORRAR la capacidad)", parseCapacidadTanque({}) === null);
  chk("campos en blanco → null", parseCapacidadTanque({ diesel: "", glp: "" }) === null);
  chk("un 0 tecleado no se guarda", parseCapacidadTanque({ diesel: "0" }) === null);
  chk("texto basura no se guarda", parseCapacidadTanque({ diesel: "abc" }) === null);
  const ida = parseCapacidadTanque({ diesel: "100", glp: "25", gnv: "" });
  chk("solo lo que tiene número", JSON.stringify(ida) === '{"diesel":100,"glp":25}', JSON.stringify(ida));
  chk("y la vuelta lo reconstruye", JSON.stringify(capacidadTanqueAForm(ida)) === '{"diesel":"100","glp":"25"}');
  chk("la vuelta de null es un formulario vacío", JSON.stringify(capacidadTanqueAForm(null)) === "{}");
  chk("el error de columna ausente se reconoce",
    faltaColumnaTanque({ message: 'column "capacidad_tanque" does not exist' }));
  chk("y no se confunde con cualquier otro error",
    !faltaColumnaTanque({ message: "duplicate key value violates unique constraint" }));
}

// ── 6 · EL COTEJO FICHA ↔ TANQUE ──────────────────────────────────────────────
console.log("\n6 · la ficha de costeo contra los tanques de la placa");
{
  const casos: [string, string | null, string[], string][] = [
    ["la placa no tiene ficha", "", ["glp"], "sin_ficha"],
    ["ficha sin combustible reconocido", "Gasohol 90", ["gasolina"], "familia_desconocida"],
    ["la placa no declara tanques", "Diésel", [], "sin_tanques"],
    ["calza", "Diésel", ["diesel"], "coincide"],
    ["calza siendo bicombustible", "GLP", ["glp", "gasolina"], "coincide"],
    ["el caso que lo motivó: ficha diésel, unidad de GLP", "Diésel", ["glp", "gasolina"], "discrepa"],
    ["ficha GNV sobre una unidad diésel", "GNV", ["diesel"], "discrepa"],
  ];
  for (const [nombre, ficha, familias, esperado] of casos) {
    const c = cotejarFichaConTanques(ficha, familias);
    chk(nombre, c.codigo === esperado, c.codigo);
  }

  // INVARIANTES por barrido.
  const fichas = [null, "", "Diésel", "GLP", "GNV", "Gasolina", "Gasohol 90"];
  const juegos = [[], ["diesel"], ["glp"], ["glp", "gasolina"], ["", "  "], ["DIESEL"], ["diesel", "diesel"]];
  let malDetalle = 0, malFamilia = 0, malDup = 0, n = 0;
  for (const f of fichas) for (const j of juegos) {
    const c = cotejarFichaConTanques(f, j);
    n++;
    if (c.codigo !== "coincide" && !c.detalle.trim()) malDetalle++;
    if ((c.codigo === "discrepa" || c.codigo === "coincide" || c.codigo === "sin_tanques") && !c.familiaFicha) malFamilia++;
    if (new Set(c.familiasUnidad).size !== c.familiasUnidad.length) malDup++;
  }
  chk(`todo código que no es "coincide" trae detalle · ${n} combinaciones`, malDetalle === 0, `${malDetalle} sin detalle`);
  chk("los códigos con familia resuelta siempre la declaran", malFamilia === 0);
  chk("las familias de la unidad salen sin repetidos ni vacíos", malDup === 0);
  chk("una familia en MAYÚSCULAS sigue calzando",
    cotejarFichaConTanques("Diésel", ["DIESEL"]).codigo === "coincide");
  chk("la familia de la ficha la declara el mismo mapa del módulo de costos",
    cotejarFichaConTanques("GLP", ["glp"]).familiaFicha === familiaCombustible("glp"));
}

console.log(`\n${fallos ? `❌ ${fallos} fallo(s)` : "✅ todo en verde"}\n`);
process.exit(fallos ? 1 : 0);
