// Pruebas del TIPO DE COMBUSTIBLE del catálogo compartido (lib/combustibles.ts). NO tocan
// la base: son datos en memoria contra el módulo puro.
// Uso:  npx tsx scripts/prueba-combustible-tipo.mts   (sale con código 1 si algo falla)
//
// Cubren lo que sostiene la cascada del Radar IA (procesarCombustible en
// lib/radar/acciones.ts) y que no se ve a simple vista:
//   · que un voucher peruano se entienda tal como está impreso ("PETROLEO D2", "GASOHOL
//     90", "GLP-G", "GAS NATURAL VEHICULAR") y no solo la palabra canónica;
//   · que "no se sabe" devuelva null y NUNCA diésel — el default silencioso era lo que
//     metía las cargas de GLP al ERP como diésel sin que nadie lo viera;
//   · que la grafía de `precios_combustible` ("Diésel", "UREA") sea puente al canónico,
//     porque las referencias de precio se leen de esa tabla;
//   · que la deducción por precio distinga GLP de diésel (S/ 7.55 vs S/ 16.5, el caso real
//     de la CWQ-400) y se abstenga cuando el precio no decide.
import {
  COMBUSTIBLES,
  candidatosPorPrecio,
  desvioDePrecio,
  etiquetaCombustible,
  getCapacidad,
  normalizarTipoCombustible,
  referenciasDePrecio,
} from "../lib/combustibles";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. Lo que está impreso en un voucher peruano ────────────────────────────
{
  const casos: [string, string][] = [
    ["diesel", "diesel"], ["Diésel", "diesel"], ["DIESEL B5", "diesel"],
    ["PETROLEO", "diesel"], ["PETRÓLEO D2", "diesel"], ["D-2", "diesel"], ["DB5 S-50", "diesel"],
    ["gasolina", "gasolina"], ["GASOHOL 90 PLUS", "gasolina"], ["G-95", "gasolina"], ["90", "gasolina"],
    ["glp", "glp"], ["GLP-G", "glp"], ["Gas Licuado de Petróleo", "glp"], ["AUTOGAS", "glp"],
    ["gnv", "gnv"], ["GAS NATURAL VEHICULAR", "gnv"], ["CNG", "gnv"],
    ["urea", "urea"], ["AdBlue", "urea"], ["AD BLUE", "urea"],
    ["biodiesel", "biodiesel"], ["Biodiésel", "biodiesel"],
  ];
  for (const [crudo, esperado] of casos) {
    const got = normalizarTipoCombustible(crudo);
    chk(`"${crudo}" → ${esperado}`, got === esperado, got === esperado ? "" : `dio ${got}`);
  }
}

// ── 2. Lo que NO se sabe es null, nunca diésel ──────────────────────────────
// Es la regla completa: el default silencioso "|| diesel" es justo lo que hacía que una
// carga de GLP entrara al ERP como diésel y ensuciara el km/gal de la unidad.
{
  for (const crudo of [null, undefined, "", "   ", "gas", "combustible", "lleno", "premium", "-"]) {
    const got = normalizarTipoCombustible(crudo);
    chk(`${JSON.stringify(crudo)} no resuelve a nada`, got === null, got === null ? "" : `dio ${got}`);
  }
}

// ── 3. Puente con la grafía de `precios_combustible` ────────────────────────
{
  for (const [oficial, canonico] of [["Diésel", "diesel"], ["Gasolina", "gasolina"], ["GLP", "glp"], ["GNV", "gnv"], ["UREA", "urea"], ["Biodiésel", "biodiesel"]] as const) {
    chk(`precios_combustible "${oficial}" → ${canonico}`, normalizarTipoCombustible(oficial) === canonico);
  }
  chk("etiquetaCombustible devuelve el nombre legible", etiquetaCombustible("glp") === "GLP" && etiquetaCombustible("diesel") === "Diésel");
  chk("etiquetaCombustible sin dato no inventa un tipo", etiquetaCombustible(null) === "—");
}

// ── 4. Referencias de precio: la tabla manda, el catálogo rellena ───────────
{
  const refs = referenciasDePrecio([{ tipo: "Diésel", precio: 16.2 }, { tipo: "GLP", precio: 7.4 }]);
  chk("la fila de la tabla pisa el referencial del catálogo", refs.diesel === 16.2 && refs.glp === 7.4);
  chk("los tipos sin fila caen al referencial del catálogo", refs.gnv === COMBUSTIBLES.gnv.precioRef);
  const vacias = referenciasDePrecio(null);
  chk("sin tabla, las seis referencias siguen existiendo", Object.keys(vacias).length === 6 && vacias.diesel > 0);
  const basura = referenciasDePrecio([{ tipo: "Diésel", precio: 0 }, { tipo: "Marciano", precio: 9 }]);
  chk("un precio en cero o un tipo desconocido no rompen la referencia", basura.diesel === COMBUSTIBLES.diesel.precioRef);
}

// ── 5. Deducción por precio: el caso real de la CWQ-400 ─────────────────────
// Dos cargas de la MISMA unidad el mismo mes: S/ 7.55/gal y S/ 22.35/gal. La primera es
// GLP y solo el precio lo dice; con el default de diésel las dos entraban como diésel.
{
  const refs = referenciasDePrecio([{ tipo: "Diésel", precio: 16.5 }, { tipo: "GLP", precio: 7.65 }, { tipo: "GNV", precio: 1.78 }]);

  const glp = candidatosPorPrecio(7.55, refs);
  chk("S/ 7.55/gal deduce GLP y solo GLP", glp.length === 1 && glp[0].tipo === "glp", glp.map((c) => c.tipo).join(","));

  const gnv = candidatosPorPrecio(1.80, refs);
  chk("S/ 1.80/m³ deduce GNV y solo GNV", gnv.length === 1 && gnv[0].tipo === "gnv", gnv.map((c) => c.tipo).join(","));

  // El ALCANCE de la técnica, no un defecto: entre líquidos las referencias están muy
  // juntas (diésel 16.5, biodiésel 15.0, gasolina 18.0) y el precio no alcanza a decidir.
  // Devolver varios es lo correcto — quien llama cae al siguiente escalón (la ficha de la
  // unidad) en vez de elegir el primero de la lista.
  const liquidos = candidatosPorPrecio(16.4, refs);
  chk("S/ 16.40/gal NO decide entre los líquidos (se abstiene)", liquidos.length > 1, liquidos.map((c) => c.tipo).join(","));
  chk("…pero el más cercano sigue siendo el diésel", liquidos[0]?.tipo === "diesel");

  // Precio que no calza con nada: no se elige tipo (y el precio, en sí, ya es sospechoso).
  chk("S/ 22.35/gal no calza con ninguna referencia", candidatosPorPrecio(22.35, refs).length === 0);
  chk("sin precio no se deduce nada", candidatosPorPrecio(null, refs).length === 0 && candidatosPorPrecio(0, refs).length === 0);

  // Y la contradicción que manda a revisión: dice diésel, paga precio de GLP.
  const desvio = desvioDePrecio(7.55, "diesel", refs);
  const otros = candidatosPorPrecio(7.55, refs);
  chk("un 'diésel' pagado a precio de GLP se detecta",
      desvio != null && desvio > 0.25 && otros.length > 0 && !otros.some((c) => c.tipo === "diesel") && otros[0].tipo === "glp");

  // Y al revés, que era el que se escapaba con un candidato único: dice GLP, paga diésel.
  // Aquí hay TRES candidatos (los líquidos) y aun así el GLP queda desmentido.
  const alReves = candidatosPorPrecio(16.4, refs);
  chk("un 'GLP' pagado a precio de líquido también se detecta",
      (desvioDePrecio(16.4, "glp", refs) ?? 0) > 0.25 && alReves.length > 0 && !alReves.some((c) => c.tipo === "glp"));

  chk("un diésel pagado a precio de diésel no levanta nada", (desvioDePrecio(16.4, "diesel", refs) ?? 1) < 0.25);
  // Una referencia desactualizada NO basta para acusar al tipo: hace falta que el precio
  // aterrice sobre la referencia de OTRO combustible. Un diésel a S/ 21 con la tabla en
  // 16.5 se avisa como precio fuera de rango, que es lo que de verdad pasa.
  const encarecido = candidatosPorPrecio(21, refs);
  chk("una referencia vieja no acusa al tipo por sí sola", encarecido.length === 0);
  chk("sin referencia del tipo no se juzga el precio", desvioDePrecio(9, "inexistente", refs) === null);
}

// ── 6. Capacidad de tanque por tipo ─────────────────────────────────────────
// El tanque de GLP de una unidad convertida es un tercio del de diésel: asumir diésel
// aquí equivalía a declarar que "cabe" cualquier cantidad.
{
  chk("un bus a diésel y el mismo bus a GLP no tienen el mismo tanque", getCapacidad("BUS", "diesel") > getCapacidad("BUS", "glp"));
  chk("la capacidad editable del vehículo manda sobre la heurística",
      getCapacidad({ categoria: "BUS", capacidad_tanque: { glp: 25 } }, "glp") === 25);
  chk("sin capacidad editable cae a la heurística de su categoría",
      getCapacidad({ categoria: "BUS", capacidad_tanque: null }, "glp") === getCapacidad("BUS", "glp"));
  chk("sin categoría hay un valor por defecto, no un NaN", Number.isFinite(getCapacidad(null, "diesel")));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
