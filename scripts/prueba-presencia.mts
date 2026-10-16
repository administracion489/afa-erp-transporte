// Matriz del ESTADO DE PRESENCIA de RRHH: estadoPresencia (lib/rrhh/estado-presencia.ts).
// Motor PURO: todo en memoria, sin base, sin red; "ahora" se pasa como `ahoraMin`. Net-new
// (no hay algoritmo viejo que reproducir).
// Uso:  npx tsx scripts/prueba-presencia.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · Los TRECE códigos declarados, uno por uno, y que las ramas siguen la precedencia de
//     `debeFichar` (conductor > campo > administrativo) en la rama sin marca determinante.
// 2 · BARRIDO de los 16 subconjuntos de marcas × TODAS las permutaciones del orden de llegada:
//     el estado depende SOLO del CONJUNTO, nunca del orden del array. Se compara además contra
//     un oráculo independiente de las marcas.
// 3 · INVARIANTE dura: con `salida` en el conjunto → `salio` SIEMPRE, pase lo que pase con la
//     cfg, la clase, el campo o la hora. Las marcas son hechos y mandan.
// 4 · TRI-ESTADO: sin la cfg/clase que la rama necesita → `sin_dato` — y, a la vez, que una
//     marca (salida) gana sobre `sin_dato` (no hay conflicto entre 3 y 4).
// 5 · COROLARIO anti-trivial: el barrido produce `presente`, `en_almuerzo` y `salio` (un motor
//     constante fallaría). La tardanza y la rama por clase producen AMBOS lados.
// 6 · El estado SE DERIVA del código: todo resultado cumple `ESTADO_DE_CODIGO[codigo] === estado`.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const M = requerir("../lib/rrhh/estado-presencia") as typeof import("../lib/rrhh/estado-presencia");
const { estadoPresencia, ESTADO_DE_CODIGO } = M;
type MarcaPresencia = import("../lib/rrhh/estado-presencia").MarcaPresencia;
type EntradaPresencia = import("../lib/rrhh/estado-presencia").EntradaPresencia;
type ResultadoPresencia = import("../lib/rrhh/estado-presencia").ResultadoPresencia;
type EstadoPresencia = import("../lib/rrhh/estado-presencia").EstadoPresencia;
type CodigoPresencia = import("../lib/rrhh/estado-presencia").CodigoPresencia;
type TipoMarca = "entrada" | "salida_almuerzo" | "regreso_almuerzo" | "salida";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Toda llamada al motor pasa por aquí: además del resultado, fija el invariante estructural
// (6) codigo → estado y cuenta cuántos resultados se vieron.
let inconsistentes = 0;
let vistos = 0;
function run(e: EntradaPresencia): ResultadoPresencia {
  const r = estadoPresencia(e);
  vistos++;
  if (ESTADO_DE_CODIGO[r.codigo] !== r.estado) inconsistentes++;
  return r;
}
const eq = (r: ResultadoPresencia, estado: EstadoPresencia, codigo: CodigoPresencia, tarde = false) =>
  r.estado === estado && r.codigo === codigo && r.llego_tarde === tarde;

// cfg completa (el motor solo lee hora_entrada/tolerancia_min, pero ConfigRrhh pide todo).
const cfgDe = (hora_entrada: string, tolerancia_min: number) => ({
  sede_lat: -12.05, sede_lng: -77.04, sede_radio_m: 100,
  hora_entrada, hora_salida: "18:00", tolerancia_min, almuerzo_min: 60, geocerca_bloquea: true,
});
const CFG = cfgDe("09:00", 10); // corte de entrada = 09:10 = 550 min
// Instantes de cada marca (hora Lima, UTC-5). Solo la de ENTRADA afecta al estado (tardanza).
const EN_PUNTO = "2026-10-16T08:55:00-05:00"; // 535 < 550 → a tiempo
const TARDE = "2026-10-16T09:30:00-05:00";    // 570 > 550 → tarde
const TS: Record<TipoMarca, string> = {
  entrada: EN_PUNTO,
  salida_almuerzo: "2026-10-16T13:00:00-05:00",
  regreso_almuerzo: "2026-10-16T14:00:00-05:00",
  salida: "2026-10-16T18:30:00-05:00",
};
const base = (patch: Partial<EntradaPresencia> = {}): EntradaPresencia => ({
  marcasHoy: [], cfg: CFG, ahoraMin: 600 /* 10:00, pasada la gracia */,
  clase: "administrativo", campo_vigente: false, presenciaConductor: false, ...patch,
});

// ── 1 · Los trece códigos declarados ──────────────────────────────────────────────
console.log("\n1 · Los trece códigos declarados\n");

chk("salida ⇒ salio/salio",
  eq(run(base({ marcasHoy: [{ tipo: "salida", marcado_en: TS.salida }, { tipo: "entrada", marcado_en: EN_PUNTO }] })), "salio", "salio"));
chk("salida_almuerzo sin regreso ⇒ en_almuerzo/en_almuerzo",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: EN_PUNTO }, { tipo: "salida_almuerzo", marcado_en: TS.salida_almuerzo }] })), "en_almuerzo", "en_almuerzo"));
chk("entrada en punto ⇒ presente/a_tiempo, llego_tarde=false",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: EN_PUNTO }] })), "presente", "a_tiempo", false));
chk("entrada tarde ⇒ presente/tarde, llego_tarde=true",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: TARDE }] })), "presente", "tarde", true));
chk("entrada sin hora usable ⇒ presente/sin_hora_entrada (límite declarado)",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: null }] })), "presente", "sin_hora_entrada", false));
chk("conductor en servicio ⇒ en_servicio/en_servicio",
  eq(run(base({ marcasHoy: [], clase: "conductor", presenciaConductor: true })), "en_servicio", "en_servicio"));
chk("conductor sin servicio ⇒ ausente/conductor_sin_servicio",
  eq(run(base({ marcasHoy: [], clase: "conductor", presenciaConductor: false })), "ausente", "conductor_sin_servicio"));
chk("campo vigente ⇒ en_campo/en_campo",
  eq(run(base({ marcasHoy: [], campo_vigente: true })), "en_campo", "en_campo"));
chk("administrativo dentro de la gracia ⇒ sin_marca_aun/sin_marca_aun",
  eq(run(base({ marcasHoy: [], ahoraMin: 540 /* 09:00 ≤ 09:10 */ })), "sin_marca_aun", "sin_marca_aun"));
chk("administrativo pasada la gracia ⇒ ausente/ausente_sin_marca",
  eq(run(base({ marcasHoy: [], ahoraMin: 600 /* 10:00 > 09:10 */ })), "ausente", "ausente_sin_marca"));
chk("administrativo sin cfg ⇒ sin_dato/sin_cfg",
  eq(run(base({ marcasHoy: [], cfg: null })), "sin_dato", "sin_cfg"));
chk("administrativo con ahoraMin no usable ⇒ sin_dato/sin_hora_actual",
  eq(run(base({ marcasHoy: [], ahoraMin: NaN })), "sin_dato", "sin_hora_actual"));
chk("clase null, sin campo ni conductor ⇒ sin_dato/sin_clase",
  eq(run(base({ marcasHoy: [], clase: null })), "sin_dato", "sin_clase"));

// ── 1b · La precedencia de la rama sin marca es la de debeFichar ───────────────────
console.log("\n1b · Precedencia de la rama sin marca (conductor > campo > administrativo)\n");

chk("conductor CON campo vigente ⇒ gana conductor (en_servicio)",
  eq(run(base({ marcasHoy: [], clase: "conductor", presenciaConductor: true, campo_vigente: true })), "en_servicio", "en_servicio"));
chk("administrativo CON campo vigente ⇒ gana campo (en_campo)",
  eq(run(base({ marcasHoy: [], clase: "administrativo", campo_vigente: true })), "en_campo", "en_campo"));
chk("clase null CON campo vigente ⇒ en_campo (el campo no depende de la clase)",
  eq(run(base({ marcasHoy: [], clase: null, campo_vigente: true })), "en_campo", "en_campo"));

// ── 2 · Barrido de los 16 subconjuntos × todas las permutaciones ───────────────────
console.log("\n2 · Barrido de los 16 subconjuntos × orden de llegada barajado\n");

const TIPOS: TipoMarca[] = ["entrada", "salida_almuerzo", "regreso_almuerzo", "salida"];

function permutaciones<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutaciones(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

// Oráculo INDEPENDIENTE de la parte dirigida por marcas (estructura distinta: cascada sobre el
// Set, no los ifs del motor). Devuelve null cuando no hay marca determinante (lo resuelve la clase).
function oraculoMarcas(s: Set<string>): EstadoPresencia | null {
  if (s.has("salida")) return "salio";
  if (s.has("salida_almuerzo") && !s.has("regreso_almuerzo")) return "en_almuerzo";
  if (s.has("entrada")) return "presente";
  return null;
}

let subsets = 0;
let permsProbadas = 0;
let dependeDelOrden = 0;
let discrepaOraculo = 0;
let conSalidaNoSalio = 0;
const estadosVistos = new Set<EstadoPresencia>();

// Contexto FIJO: solo varían el conjunto de marcas y su orden. Administrativo pasada la gracia,
// así que los subconjuntos SIN marca determinante dan `ausente` (determinado).
const CTX = { cfg: CFG, ahoraMin: 600, clase: "administrativo" as const, campo_vigente: false, presenciaConductor: false };

for (let mask = 0; mask < 16; mask++) {
  subsets++;
  const tiposDelSubset = TIPOS.filter((_, i) => mask & (1 << i));
  const marcas: MarcaPresencia[] = tiposDelSubset.map((t) => ({ tipo: t, marcado_en: TS[t] }));
  const set = new Set<string>(tiposDelSubset);

  let primero: ResultadoPresencia | null = null;
  for (const perm of permutaciones(marcas)) {
    permsProbadas++;
    const r = run({ ...CTX, marcasHoy: perm });
    estadosVistos.add(r.estado);
    if (primero == null) {
      primero = r;
      // El estado dirigido por marcas coincide con el oráculo; si no hay marca determinante,
      // con el contexto (administrativo pasada la gracia) es `ausente`.
      const esperado = oraculoMarcas(set) ?? "ausente";
      if (r.estado !== esperado) discrepaOraculo++;
      if (set.has("salida") && r.estado !== "salio") conSalidaNoSalio++;
    } else if (r.estado !== primero.estado || r.codigo !== primero.codigo || r.llego_tarde !== primero.llego_tarde) {
      dependeDelOrden++;
    }
  }
}

chk(`barrió los ${subsets} subconjuntos`, subsets === 16, `fueron ${subsets}`);
// 1 (vacío) + 4·1! + 6·2! + 4·3! + 1·4! = 1 + 4 + 12 + 24 + 24 = 65.
chk(`probó ${permsProbadas} permutaciones (incluye todos los órdenes de cada subconjunto)`, permsProbadas === 65, `fueron ${permsProbadas}`);
chk("el estado NO depende del orden de llegada (todas las permutaciones coinciden)", dependeDelOrden === 0, `${dependeDelOrden} dependencias del orden`);
chk("el estado coincide con el oráculo de marcas en todo el barrido", discrepaOraculo === 0, `${discrepaOraculo} discrepancias`);

// ── 3 · Invariante dura: salida ⇒ salio SIEMPRE ────────────────────────────────────
console.log("\n3 · Invariante: con salida presente ⇒ salio, pase lo que pase\n");

chk("en el barrido, ningún subconjunto con salida dejó de dar salio", conSalidaNoSalio === 0, `${conSalidaNoSalio} violaciones`);

// Y gana incluso sin cfg y sin clase (las marcas mandan sobre sin_dato).
const CLASES: Array<"conductor" | "administrativo" | null> = ["conductor", "administrativo", null];
let salioViola = 0;
for (const clase of CLASES)
  for (const cfg of [CFG, null])
    for (const campo of [true, false])
      for (const ahora of [0, 540, 600, NaN]) {
        const r = run({ marcasHoy: [{ tipo: "salida", marcado_en: TS.salida }], cfg, ahoraMin: ahora, clase, campo_vigente: campo, presenciaConductor: false });
        if (!(r.estado === "salio" && r.codigo === "salio")) salioViola++;
      }
chk("salida ⇒ salio aunque falten cfg y clase (marca gana sobre sin_dato)", salioViola === 0, `${salioViola} violaciones`);

// ── 4 · Tri-estado: sin cfg/clase ⇒ sin_dato, pero solo sin marca determinante ─────
console.log("\n4 · Tri-estado (no afirmes lo que no sabes)\n");

chk("sin cfg + administrativo + sin marca ⇒ sin_dato/sin_cfg",
  eq(run(base({ marcasHoy: [], cfg: null, clase: "administrativo" })), "sin_dato", "sin_cfg"));
chk("clase null + sin campo + sin marca ⇒ sin_dato/sin_clase",
  eq(run(base({ marcasHoy: [], cfg: CFG, clase: null })), "sin_dato", "sin_clase"));
// La cfg NO se exige donde no hace falta: conductor y campo resuelven sin ella.
chk("sin cfg + conductor en servicio ⇒ en_servicio (no sin_dato: no necesita cfg)",
  eq(run(base({ marcasHoy: [], cfg: null, clase: "conductor", presenciaConductor: true })), "en_servicio", "en_servicio"));
chk("sin cfg + campo vigente ⇒ en_campo (no sin_dato: no necesita cfg)",
  eq(run(base({ marcasHoy: [], cfg: null, clase: null, campo_vigente: true })), "en_campo", "en_campo"));
// Y una marca gana sobre sin_dato aunque falten cfg y clase.
chk("entrada + sin cfg + clase null ⇒ presente/sin_hora_entrada (no sin_dato)",
  eq(run({ marcasHoy: [{ tipo: "entrada", marcado_en: EN_PUNTO }], cfg: null, ahoraMin: 600, clase: null, campo_vigente: false }), "presente", "sin_hora_entrada", false));

// ── 5 · Corolario anti-trivial ─────────────────────────────────────────────────────
console.log("\n5 · Corolario anti-trivial (el motor no es constante)\n");

chk("el barrido produjo presente, en_almuerzo y salio",
  estadosVistos.has("presente") && estadosVistos.has("en_almuerzo") && estadosVistos.has("salio"),
  `vistos: ${[...estadosVistos].join(", ")}`);
chk(`el barrido produjo varios estados distintos (${estadosVistos.size})`, estadosVistos.size >= 3);
// La tardanza produce AMBOS lados, y la rama por clase también.
chk("tardanza produce a_tiempo Y tarde según la hora de la entrada",
  run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: EN_PUNTO }] })).codigo === "a_tiempo" &&
  run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: TARDE }] })).codigo === "tarde");

// ── 6 · El estado se deriva del código ─────────────────────────────────────────────
console.log("\n6 · El estado se deriva del código, una sola fuente\n");

chk(`todo resultado cumple ESTADO_DE_CODIGO[codigo] === estado (${vistos} resultados)`, inconsistentes === 0, `${inconsistentes} inconsistencias`);
chk("ESTADO_DE_CODIGO cubre los 13 códigos declarados", Object.keys(ESTADO_DE_CODIGO).length === 13, `${Object.keys(ESTADO_DE_CODIGO).length} códigos`);

// ── 7 · Determinismo con marcas DUPLICADAS: la tardanza usa la entrada más temprana ─
console.log("\n7 · Entradas duplicadas: gana la más temprana, sin importar el orden del array\n");

const dupA: MarcaPresencia[] = [{ tipo: "entrada", marcado_en: TARDE }, { tipo: "entrada", marcado_en: EN_PUNTO }];
const dupB: MarcaPresencia[] = [{ tipo: "entrada", marcado_en: EN_PUNTO }, { tipo: "entrada", marcado_en: TARDE }];
const rDupA = run(base({ marcasHoy: dupA }));
const rDupB = run(base({ marcasHoy: dupB }));
chk("dos entradas (una tarde, una en punto) ⇒ a_tiempo (gana la más temprana)", eq(rDupA, "presente", "a_tiempo", false));
chk("el orden de las dos entradas no cambia el veredicto", rDupA.codigo === rDupB.codigo && rDupA.llego_tarde === rDupB.llego_tarde);

// ── 8 · Frontera del corte (gracia inclusiva, igual que la tardanza de jornada) ─────
console.log("\n8 · Fronteras: el corte de entrada y la gracia del administrativo\n");

// hora_entrada 09:00 (540), tol 10 → corte 550. En el minuto 550 todavía NO es tarde (jornada
// usa `> hora+tol` para la tardanza; aquí es el mismo límite).
const corte550 = "2026-10-16T09:10:00-05:00"; // 550 exacto
const corte551 = "2026-10-16T09:11:00-05:00"; // 551
chk("entrada en el minuto del corte (550) ⇒ a_tiempo (borde inclusivo)",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: corte550 }] })), "presente", "a_tiempo", false));
chk("entrada un minuto después del corte (551) ⇒ tarde",
  eq(run(base({ marcasHoy: [{ tipo: "entrada", marcado_en: corte551 }] })), "presente", "tarde", true));
chk("administrativo con ahoraMin == corte (550) ⇒ sin_marca_aun (aún dentro de la gracia)",
  eq(run(base({ marcasHoy: [], ahoraMin: 550 })), "sin_marca_aun", "sin_marca_aun"));
chk("administrativo con ahoraMin == corte+1 (551) ⇒ ausente_sin_marca",
  eq(run(base({ marcasHoy: [], ahoraMin: 551 })), "ausente", "ausente_sin_marca"));

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
