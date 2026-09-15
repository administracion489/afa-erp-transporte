// Matriz de lib/costos/nivel-servicio.ts — la palabra única (Full Equipo/Estándar) sobre las dos
// columnas que NO se funden.
//
//     npx tsx scripts/prueba-nivel-servicio.mts
//
// Lo que fija, y por qué cada cosa:
//   1 · Los VALORES guardados no se renombran nunca (rompería el índice único del tarifario).
//   2 · El filtro PARTICIONA: ninguna ficha activa se pierde entre los dos niveles.
//   3 · Cambiar de nivel no pierde el bus — y cuando no hay gemela, se dice cuál falta.
//   4 · La placa se coteja contra el nivel, y SIN DATO no se afirma nada.
import { createRequire } from "node:module";
const requerir = createRequire(import.meta.url);
const NS = requerir("../lib/costos/nivel-servicio") as typeof import("../lib/costos/nivel-servicio");

const {
  NIVEL_CFG, NIVELES, nivelDeEquipamiento, equipamientoDeNivel, nivelDeFicha,
  fichasDelNivel, fichaEquivalente, planDeNivel, cotejarUnidadConNivel, etiquetaNivel,
} = NS;

let fallos = 0;
const ok = (cond: boolean, etq: string, det = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${det ? "  → " + det : ""}`);
  if (!cond) fallos++;
};
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

/** La flota real de AFA: trece categorías con gemela, más dos casos que no la tienen. */
const F = (tipo: string, nombre: string) => ({ tipo_vehiculo: tipo, nombre });
const FLOTA = [
  F("SPRINTER_17", "Sprinter 17 pax Diésel · Full Equipo (<10 años)"),
  F("SPRINTER_17_ESTANDAR", "Sprinter 17 pax Diésel · Estándar (>10 años)"),
  F("BUS_50", "Bus 50 pax Diésel · Full Equipo (<10 años)"),
  F("BUS_50_ESTANDAR", "Bus 50 pax Diésel · Estándar (>10 años)"),
  F("MINIVAN_10", "Minivan 10 pax · Full Equipo (<10 años)"),   // sin gemela estándar
];
const CLAVES = FLOTA.map(f => f.tipo_vehiculo);

// ── 1 · Los valores guardados ────────────────────────────────────────────────

linea("1 · LOS VALORES DE LA BASE NO SE RENOMBRAN");
console.log("`full_equipo`/`basico` están escritos en vehiculos, cotizaciones y en el ÍNDICE ÚNICO");
console.log("del tarifario. Cambiarlos dejaría huérfana la lista de precios entera.\n");

ok(equipamientoDeNivel("full_equipo") === "full_equipo", "full_equipo → 'full_equipo' (coincide, y AUN ASÍ se convierte)");
ok(equipamientoDeNivel("estandar") === "basico", "estandar → 'basico'");
ok(nivelDeEquipamiento("full_equipo") === "full_equipo", "'full_equipo' → full_equipo");
ok(nivelDeEquipamiento("basico") === "estandar", "'basico' → estandar");
ok(
  NIVELES.every(n => nivelDeEquipamiento(equipamientoDeNivel(n)) === n),
  "la conversión es un ciclo cerrado en los dos sentidos",
);
ok(
  nivelDeEquipamiento(null) === "full_equipo" && nivelDeEquipamiento(undefined) === "full_equipo" &&
  nivelDeEquipamiento("") === "full_equipo",
  "sin valor → FULL EQUIPO, nunca estándar",
  "vehiculos.equipamiento nació con default full_equipo: media flota lo tiene implícito y " +
  "degradarla en el PDF del cliente sería afirmar algo que nadie marcó",
);
ok(
  nivelDeEquipamiento("cualquier_cosa") === "full_equipo",
  "un valor desconocido tampoco degrada",
);
ok(etiquetaNivel("basico") === "ESTÁNDAR" && etiquetaNivel(null) === "FULL EQUIPO",
   "la etiqueta de documento sale del mismo sitio", `${etiquetaNivel(null)} / ${etiquetaNivel("basico")}`);

// ── 2 · El filtro particiona ─────────────────────────────────────────────────

linea("2 · EL FILTRO PARTICIONA: NINGUNA FICHA SE PIERDE");

ok(nivelDeFicha("SPRINTER_17") === "full_equipo", "una ficha sin sufijo es full equipo");
ok(nivelDeFicha("SPRINTER_17_ESTANDAR") === "estandar", "el sufijo _ESTANDAR la hace estándar");
ok(nivelDeFicha(null) === "full_equipo", "sin ficha elegida no se inventa un nivel estándar");

const prem = fichasDelNivel(FLOTA, "full_equipo");
const est = fichasDelNivel(FLOTA, "estandar");
ok(prem.length + est.length === FLOTA.length, "las dos listas suman la flota entera",
   `${prem.length} + ${est.length} = ${FLOTA.length}`);
ok(
  !prem.some(p => est.some(e => e.tipo_vehiculo === p.tipo_vehiculo)),
  "son disjuntas: ninguna ficha sale en los dos niveles",
);
ok(
  FLOTA.every(f => prem.concat(est).filter(x => x.tipo_vehiculo === f.tipo_vehiculo).length === 1),
  "cada ficha aparece EXACTAMENTE una vez",
  "una ficha activa que ninguna pantalla lista se sigue cotizando y nadie la ve",
);

// ── 3 · Cambiar de nivel ─────────────────────────────────────────────────────

linea("3 · CAMBIAR DE NIVEL NO PIERDE EL BUS");

const p1 = planDeNivel("SPRINTER_17", "estandar", FLOTA);
ok(p1.codigo === "cambia" && p1.clave === "SPRINTER_17_ESTANDAR",
   "full equipo → estándar pasa a la GEMELA, no a vacío", `${p1.codigo} · ${p1.clave}`);

const p2 = planDeNivel("BUS_50_ESTANDAR", "full_equipo", FLOTA);
ok(p2.codigo === "cambia" && p2.clave === "BUS_50",
   "y al revés también", `${p2.codigo} · ${p2.clave}`);

const p3 = planDeNivel("BUS_50", "full_equipo", FLOTA);
ok(p3.codigo === "ya_en_nivel" && p3.clave === "BUS_50",
   "si ya está en el nivel no se toca nada");

const p4 = planDeNivel("", "estandar", FLOTA);
ok(p4.codigo === "sin_seleccion" && p4.clave === null, "sin selección previa no hay nada que mover");

const p5 = planDeNivel("MINIVAN_10", "estandar", FLOTA);
ok(p5.codigo === "sin_gemela" && p5.clave === null,
   "sin gemela la selección se SUELTA, no se queda la del otro nivel",
   "dejarla puesta costearía en silencio con una ficha de más de 10 años");
ok(/MINIVAN|Minivan/.test(p5.detalle) && p5.detalle.length > 20,
   "…y el detalle NOMBRA la categoría que falta", p5.detalle);

const p6 = planDeNivel("SPRINTER_17", "estandar", [F("SPRINTER_17", "Sprinter")]);
ok(p6.codigo === "nivel_vacio" && p6.clave === null,
   "un nivel sin ninguna ficha se declara, no se enseña una rejilla vacía");

// Invariante dura: un plan aplicable NUNCA deja puesta una ficha del otro nivel.
let cruces = 0;
for (const f of FLOTA) for (const n of NIVELES) {
  const pl = planDeNivel(f.tipo_vehiculo, n, FLOTA);
  if (pl.clave && nivelDeFicha(pl.clave) !== n) cruces++;
}
ok(cruces === 0, "INVARIANTE · ningún plan deja seleccionada una ficha del nivel contrario",
   `${FLOTA.length * NIVELES.length} combinaciones`);

// Y su corolario: la clave que devuelve siempre existe en la flota.
let fantasmas = 0;
for (const f of FLOTA) for (const n of NIVELES) {
  const pl = planDeNivel(f.tipo_vehiculo, n, FLOTA);
  if (pl.clave && !CLAVES.includes(pl.clave)) fantasmas++;
}
ok(fantasmas === 0, "INVARIANTE · nunca propone una clave que no está en la flota");

ok(fichaEquivalente("SPRINTER_17", "estandar", CLAVES) === "SPRINTER_17_ESTANDAR",
   "fichaEquivalente resuelve la gemela por la CLAVE, no por el nombre");
ok(fichaEquivalente("MINIVAN_10", "estandar", CLAVES) === null,
   "…y devuelve null en vez de una clave inventada");

// ── 4 · La placa contra el nivel ─────────────────────────────────────────────

linea("4 · LA PLACA CONTRA EL NIVEL DEL SERVICIO");

const c1 = cotejarUnidadConNivel("full_equipo", "full_equipo", true);
ok(c1.codigo === "coincide" && c1.detalle === "", "placa full equipo + servicio full equipo → silencio");

const c2 = cotejarUnidadConNivel("basico", "full_equipo", true);
ok(c2.codigo === "discrepa" && c2.detalle.length > 40,
   "placa básica + servicio full equipo → se DICE, con el daño concreto");
ok(/PDF|papel|ANEXO|imprime/i.test(c2.detalle),
   "…y el detalle nombra que eso llega al PDF del cliente", c2.detalle.slice(0, 90) + "…");

const c3 = cotejarUnidadConNivel(null, "estandar", false);
ok(c3.codigo === "sin_dato" && c3.detalle === "",
   "SIN DATO no se afirma nada",
   "vehiculos_tercero no tiene columna equipamiento: son 86 de 89 unidades",
);
ok(
  cotejarUnidadConNivel(null, "estandar", true).codigo === "discrepa",
  "con dato, un null SÍ se juzga (es full equipo por defecto) contra un servicio estándar",
);

// ── 5 · Lo que la pantalla necesita ──────────────────────────────────────────

linea("5 · LA CONFIGURACIÓN QUE COMPARTEN LAS CUATRO PANTALLAS");
ok(
  NIVEL_CFG.full_equipo.label === "Full Equipo" && NIVEL_CFG.estandar.label === "Estándar",
  "una sola palabra por nivel en todo el ERP",
);
ok(
  !/años|antigüedad|10/.test(NIVEL_CFG.full_equipo.sub + NIVEL_CFG.estandar.sub),
  "el subtítulo NO afirma la antigüedad",
  "el equipamiento no sabe la edad del bus: eso lo declara el nombre de la ficha",
);
ok(
  NIVELES.length === 2 && new Set(NIVELES.map(n => NIVEL_CFG[n].equipamiento)).size === 2,
  "cada nivel apunta a un valor distinto de la columna",
);

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
