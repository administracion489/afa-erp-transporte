// Matriz del FICHADOR de RRHH: debeFichar (lib/rrhh/fichador.ts). Motor PURO: todo en memoria,
// sin base, sin red, sin reloj. Net-new (no hay algoritmo viejo que reproducir).
// Uso:  npx tsx scripts/prueba-fichador.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · Los CUATRO códigos declarados, uno por uno, y que el ORDEN manda: un conductor con el
//     opt-in activo por error NO ficha (regla 1 gana a 3); el personal de campo con ventana
//     vigente tampoco (regla 2 gana a 3).
// 2 · BARRIDO COMPLETO de {clase} × {marca_asistencia} × {campo_vigente} (3×2×2 = 12) contra un
//     oráculo INDEPENDIENTE escrito como tabla de prioridad (no como los ifs del motor), que
//     fija `ficha` Y `codigo` en cada combinación.
// 3 · INVARIANTES duras sobre el barrido: un CONDUCTOR nunca ficha, y una ventana de campo
//     vigente nunca ficha — pase lo que pase con el opt-in.
// 4 · COROLARIO anti-trivial: existe una combinación que SÍ ficha (administrativo con el opt-in
//     activo y sin ventana de campo). Un motor que devolviera siempre `false` pasaría las
//     invariantes y fallaría aquí.
// 5 · El nombre del evento de entrada es el contrato con el frontend y no cambia por descuido.

import {
  debeFichar,
  EVENTO_ENTRADA_MARCADA,
  type CodigoFichador,
  type VeredictoFichador,
} from "../lib/rrhh/fichador";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

type Clase = "conductor" | "administrativo" | null;
const eq = (a: VeredictoFichador, ficha: boolean, codigo: CodigoFichador) =>
  a.ficha === ficha && a.codigo === codigo;

// ── 1 · Los cuatro códigos y que el orden manda ───────────────────────────────────
console.log("\n1 · Los cuatro códigos declarados y el orden de las reglas\n");

chk("conductor (sin opt-in, sin campo) ⇒ NO ficha, conductor_por_servicios",
  eq(debeFichar({ clase: "conductor", marca_asistencia: false, campo_vigente: false }), false, "conductor_por_servicios"));
chk("conductor CON opt-in ⇒ igual NO ficha (regla 1 gana a 3)",
  eq(debeFichar({ clase: "conductor", marca_asistencia: true, campo_vigente: false }), false, "conductor_por_servicios"));
chk("conductor CON campo vigente ⇒ igual conductor_por_servicios (regla 1 gana a 2)",
  eq(debeFichar({ clase: "conductor", marca_asistencia: true, campo_vigente: true }), false, "conductor_por_servicios"));

chk("administrativo con campo vigente ⇒ NO ficha, campo",
  eq(debeFichar({ clase: "administrativo", marca_asistencia: false, campo_vigente: true }), false, "campo"));
chk("administrativo con campo vigente Y opt-in ⇒ campo (regla 2 gana a 3)",
  eq(debeFichar({ clase: "administrativo", marca_asistencia: true, campo_vigente: true }), false, "campo"));
chk("null (clase no derivable) con campo vigente ⇒ NO ficha, campo",
  eq(debeFichar({ clase: null, marca_asistencia: true, campo_vigente: true }), false, "campo"));

chk("administrativo con opt-in y SIN campo ⇒ SÍ ficha, ficha_en_sede",
  eq(debeFichar({ clase: "administrativo", marca_asistencia: true, campo_vigente: false }), true, "ficha_en_sede"));
chk("null con opt-in y sin campo ⇒ SÍ ficha, ficha_en_sede (el opt-in manda, no el rol)",
  eq(debeFichar({ clase: null, marca_asistencia: true, campo_vigente: false }), true, "ficha_en_sede"));

chk("administrativo sin opt-in y sin campo ⇒ NO ficha, no_marca",
  eq(debeFichar({ clase: "administrativo", marca_asistencia: false, campo_vigente: false }), false, "no_marca"));
chk("null sin opt-in y sin campo ⇒ NO ficha, no_marca",
  eq(debeFichar({ clase: null, marca_asistencia: false, campo_vigente: false }), false, "no_marca"));

// ── 2 · Barrido completo contra un oráculo independiente ──────────────────────────
console.log("\n2 · Barrido 3×2×2 contra un oráculo independiente (tabla de prioridad)\n");

// Oráculo escrito como LISTA de reglas con guard — estructura distinta de los ifs del motor —;
// gana la PRIMERA cuyo guard se cumple. Reproduce el contrato, no la forma.
const REGLAS: { guard: (c: Clase, m: boolean, f: boolean) => boolean; r: VeredictoFichador }[] = [
  { guard: (c) => c === "conductor", r: { ficha: false, codigo: "conductor_por_servicios" } },
  { guard: (_c, _m, f) => f === true, r: { ficha: false, codigo: "campo" } },
  { guard: (_c, m) => m === true, r: { ficha: true, codigo: "ficha_en_sede" } },
  { guard: () => true, r: { ficha: false, codigo: "no_marca" } },
];
const oraculo = (c: Clase, m: boolean, f: boolean): VeredictoFichador =>
  REGLAS.find((rg) => rg.guard(c, m, f))!.r;

const CLASES: Clase[] = ["conductor", "administrativo", null];
const BOOLS = [true, false];

let sw = 0;
let malFicha = 0;
let malCodigo = 0;
let vistoFicha = 0;
let vistoNoFicha = 0;
let violaConductor = 0;
let violaCampo = 0;

for (const clase of CLASES)
  for (const marca_asistencia of BOOLS)
    for (const campo_vigente of BOOLS) {
      sw++;
      const got = debeFichar({ clase, marca_asistencia, campo_vigente });
      const esp = oraculo(clase, marca_asistencia, campo_vigente);
      if (got.ficha !== esp.ficha) malFicha++;
      if (got.codigo !== esp.codigo) malCodigo++;

      // (3) invariantes duras, sobre el resultado REAL del motor.
      if (clase === "conductor" && got.ficha) violaConductor++;
      if (campo_vigente === true && got.ficha) violaCampo++;

      if (got.ficha) vistoFicha++;
      else vistoNoFicha++;
    }

chk(`barrió las ${sw} combinaciones (3 clases × 2 opt-in × 2 campo)`, sw === 12, `fueron ${sw}`);
chk("`ficha` coincide con el oráculo en todo el barrido", malFicha === 0, `${malFicha} discrepancias`);
chk("`codigo` coincide con el oráculo en todo el barrido", malCodigo === 0, `${malCodigo} discrepancias`);

// ── 3 · Invariantes duras ─────────────────────────────────────────────────────────
console.log("\n3 · Invariantes duras\n");
chk("un CONDUCTOR nunca ficha (pase lo que pase con opt-in y campo)", violaConductor === 0, `${violaConductor} violaciones`);
chk("una ventana de CAMPO vigente nunca ficha", violaCampo === 0, `${violaCampo} violaciones`);

// ── 4 · Corolario anti-trivial ─────────────────────────────────────────────────────
console.log("\n4 · Corolario anti-trivial (el motor no es constante)\n");
chk("administrativo && marca_asistencia && !campo_vigente ⇒ SÍ ficha",
  debeFichar({ clase: "administrativo", marca_asistencia: true, campo_vigente: false }).ficha === true);
chk(`el barrido produjo AMBOS veredictos: ${vistoFicha} fichan, ${vistoNoFicha} no (ni todo true ni todo false)`,
  vistoFicha > 0 && vistoNoFicha > 0);

// ── 5 · El contrato del evento con el frontend ─────────────────────────────────────
console.log("\n5 · El evento de entrada no cambia por descuido\n");
chk("EVENTO_ENTRADA_MARCADA === 'afa:rrhh-entrada'", EVENTO_ENTRADA_MARCADA === "afa:rrhh-entrada");

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
