// Matriz del HORARIO EFECTIVO de RRHH (lib/rrhh/horario.ts).
// Uso:  npx tsx scripts/prueba-horario-rrhh.mts   (sale con código 1 si algo falla)
//
// Es todo NET-NEW: no hay "algoritmo viejo copiado literal" contra el cual comparar. Lo que
// se fija son la INVARIANTE del módulo y su COROLARIO anti-trivial, de modo que un motor
// degenerado falle la matriz:
//   · el que IGNORA el override (devuelve siempre el global) ⇒ falla el corolario (§2/§3).
//   · el que IGNORA el global (devuelve solo el override) ⇒ falla la invariante (§1).
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · INVARIANTE (degradación byte a byte): un override con los 4 campos en NULL —y también
//     `null`/`undefined` enteros, y `{}`— ⇒ el efectivo es IDÉNTICO al global campo a campo,
//     y las 4 fuentes son "global". Barrido sobre globales aleatorios. Incluye el caso de un
//     global cuya hora trae segundos ("08:00:00"): el heredado lo conserva VERBATIM, no lo
//     normaliza (prueba de que el global se pasa tal cual).
//
// 2 · COROLARIO anti-trivial (un campo): poner UN solo campo a un valor DISTINTO del global ⇒
//     ESE campo cambia (y queda en el valor normalizado esperado), los otros 3 + los 4 campos
//     de sede siguen === global, la fuente de ese campo es "empleado" y las otras 3 "global".
//     Barrido por campo. Incluye el borde `tolerancia_min: 0`, que es no-null y debe GANAR.
//
// 3 · COMBINADO: subconjuntos aleatorios de campos puestos / dejados en null. Cada campo puesto
//     sale del override (normalizado) con fuente "empleado"; cada campo en null sale del global
//     con fuente "global"; la sede siempre del global. Se comprueba además que el barrido
//     ejercita, para cada campo, los dos lados (puesto y en null): si no, sería trivial.
//
// 4 · NORMALIZACIÓN del override: "HH:MM:SS" ⇒ "HH:MM", "HH:MM" intacto, microsegundos
//     recortados. Y `horarioEfectivo(...)` ≡ `horarioEfectivoConFuente(...).cfg`.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const H = requerir("../lib/rrhh/horario") as typeof import("../lib/rrhh/horario");
const { CAMPOS_HORARIO, horarioEfectivo, horarioEfectivoConFuente } = H;

type ConfigRrhh = import("../lib/rrhh/tipos").ConfigRrhh;
type OverrideHorario = import("../lib/rrhh/horario").OverrideHorario;
type CampoHorario = import("../lib/rrhh/horario").CampoHorario;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// PRNG determinista (mulberry32): la matriz no depende de la suerte.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Todos los campos de ConfigRrhh (declarados UNA vez), para comparar campo a campo.
const CAMPOS_CFG = [
  "sede_lat", "sede_lng", "sede_radio_m",
  "hora_entrada", "hora_salida", "tolerancia_min", "almuerzo_min",
  "geocerca_bloquea",
] as const;

const val = (c: ConfigRrhh, k: string): unknown => (c as Record<string, unknown>)[k];
/** Los campos de ConfigRrhh en que `a` y `b` difieren (comparación === campo a campo). */
function difieren(a: ConfigRrhh, b: ConfigRrhh): string[] {
  return CAMPOS_CFG.filter((k) => val(a, k) !== val(b, k));
}

function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function hhmmss(min: number, sec: number): string {
  return `${hhmm(min)}:${String(((sec % 60) + 60) % 60).padStart(2, "0")}`;
}

function globalAleatorio(rnd: () => number): ConfigRrhh {
  return {
    sede_lat: rnd() * 180 - 90,
    sede_lng: rnd() * 360 - 180,
    sede_radio_m: Math.floor(rnd() * 500) + 50,
    hora_entrada: hhmm(Math.floor(rnd() * 1440)),
    hora_salida: hhmm(Math.floor(rnd() * 1440)),
    tolerancia_min: Math.floor(rnd() * 60),
    almuerzo_min: Math.floor(rnd() * 120),
    geocerca_bloquea: rnd() < 0.5,
  };
}

const esHora = (c: CampoHorario) => c === "hora_entrada" || c === "hora_salida";

// ── 1 · INVARIANTE: todo-NULL ⇒ idéntico al global, byte a byte, fuentes "global" ──────────
console.log("\n1 · INVARIANTE: override todo-NULL ⇒ efectivo IDÉNTICO al global (byte a byte)\n");

const overridesVacios: Array<OverrideHorario | null | undefined> = [
  null,
  undefined,
  {},
  { hora_entrada: null, hora_salida: null, tolerancia_min: null, almuerzo_min: null },
  { hora_entrada: undefined, tolerancia_min: null }, // mezcla de null/undefined/ausente
];

const rnd1 = prng(1);
let rompeInvariante = 0, fuenteNoGlobal = 0;
for (let k = 0; k < 2000; k++) {
  const g = globalAleatorio(rnd1);
  for (const ov of overridesVacios) {
    const { cfg, fuente } = horarioEfectivoConFuente(ov, g);
    if (difieren(cfg, g).length !== 0) rompeInvariante++;
    for (const c of CAMPOS_HORARIO) if (fuente[c] !== "global") fuenteNoGlobal++;
  }
}
chk("efectivo === global campo a campo en 2000 globales × 5 overrides vacíos", rompeInvariante === 0, `${rompeInvariante} difieren`);
chk("las 4 fuentes son 'global' cuando no hay override", fuenteNoGlobal === 0, `${fuenteNoGlobal} ≠ global`);

// Borde: un global con hora en "HH:MM:SS" se HEREDA verbatim (el global no se re-normaliza).
const gSeg: ConfigRrhh = { ...globalAleatorio(prng(77)), hora_entrada: "08:00:00", hora_salida: "18:30:00" };
const efSeg = horarioEfectivo({}, gSeg);
chk("global con segundos ⇒ heredado VERBATIM, no 'HH:MM'",
  efSeg.hora_entrada === "08:00:00" && efSeg.hora_salida === "18:30:00",
  `${efSeg.hora_entrada} / ${efSeg.hora_salida}`);

// ── 2 · COROLARIO: un campo puesto DISTINTO ⇒ ese cambia (al valor normalizado), los demás no ─
console.log("\n2 · COROLARIO anti-trivial: un campo puesto DISTINTO ⇒ ese cambia, los demás no\n");

const rnd2 = prng(42);
const cambios: Record<CampoHorario, number> = { hora_entrada: 0, hora_salida: 0, tolerancia_min: 0, almuerzo_min: 0 };
let corolarioMal = 0;
for (let k = 0; k < 4000; k++) {
  const g = globalAleatorio(rnd2);
  const campo = CAMPOS_HORARIO[k % CAMPOS_HORARIO.length];

  let override: OverrideHorario;
  let esperado: string | number;
  if (esHora(campo)) {
    const minG = ((): number => { const [h, m] = (val(g, campo) as string).split(":").map(Number); return h * 60 + m; })();
    let minO = Math.floor(rnd2() * 1440);
    if (minO === minG) minO = (minO + 1) % 1440; // garantizar DISTINTO tras normalizar
    override = { [campo]: hhmmss(minO, Math.floor(rnd2() * 60)) };
    esperado = hhmm(minO);
  } else {
    const vG = val(g, campo) as number;
    let vO = Math.floor(rnd2() * 120);
    if (vO === vG) vO = vO + 1; // garantizar DISTINTO
    override = { [campo]: vO };
    esperado = vO;
  }

  const { cfg, fuente } = horarioEfectivoConFuente(override, g);

  // (a) el campo CAMBIÓ y quedó en el valor esperado (normalizado para las horas).
  const campoCambio = val(cfg, campo) !== val(g, campo) && val(cfg, campo) === esperado;
  if (campoCambio) cambios[campo]++;
  // (b) todo lo DEMÁS (3 campos de horario + 4 de sede) sigue === global.
  const soloEseDifiere = difieren(cfg, g).length === 1 && difieren(cfg, g)[0] === campo;
  // (c) la fuente de ese campo es "empleado"; las otras 3, "global".
  let fuenteOk = fuente[campo] === "empleado";
  for (const c of CAMPOS_HORARIO) if (c !== campo && fuente[c] !== "global") fuenteOk = false;

  if (!(campoCambio && soloEseDifiere && fuenteOk)) corolarioMal++;
}
chk("un campo puesto ⇒ cambia ese y NADA más, fuente coherente, en 4000 casos", corolarioMal === 0, `${corolarioMal} fallos`);
chk("el barrido ejercitó los CUATRO campos (no es trivial)",
  CAMPOS_HORARIO.every((c) => cambios[c] > 0),
  CAMPOS_HORARIO.map((c) => `${c}:${cambios[c]}`).join(" "));

// Borde: tolerancia_min = 0 es NO-null y GANA sobre un global con gracia.
const g0: ConfigRrhh = { ...globalAleatorio(prng(5)), tolerancia_min: 10 };
const ef0 = horarioEfectivoConFuente({ tolerancia_min: 0 }, g0);
chk("tolerancia_min: 0 GANA sobre global=10 (0 es no-null, no 'ausente')",
  ef0.cfg.tolerancia_min === 0 && ef0.fuente.tolerancia_min === "empleado", `${ef0.cfg.tolerancia_min}`);
const gAlm0: ConfigRrhh = { ...globalAleatorio(prng(6)), almuerzo_min: 60 };
const efAlm0 = horarioEfectivoConFuente({ almuerzo_min: 0 }, gAlm0);
chk("almuerzo_min: 0 GANA sobre global=60", efAlm0.cfg.almuerzo_min === 0 && efAlm0.fuente.almuerzo_min === "empleado", `${efAlm0.cfg.almuerzo_min}`);

// ── 3 · COMBINADO: subconjuntos aleatorios de campos puestos / en null ──────────────────────
console.log("\n3 · COMBINADO: cada campo puesto sale del override; cada null, del global\n");

const rnd3 = prng(314);
const puesto: Record<CampoHorario, number> = { hora_entrada: 0, hora_salida: 0, tolerancia_min: 0, almuerzo_min: 0 };
const dejado: Record<CampoHorario, number> = { hora_entrada: 0, hora_salida: 0, tolerancia_min: 0, almuerzo_min: 0 };
let combinadoMal = 0, sedeMovida = 0, consistenciaMal = 0;
for (let k = 0; k < 4000; k++) {
  const g = globalAleatorio(rnd3);
  const override: OverrideHorario = {};
  const esperadoDe: Partial<Record<CampoHorario, string | number>> = {};

  for (const campo of CAMPOS_HORARIO) {
    if (rnd3() < 0.5) {
      // dejar en null (mezclar null explícito y ausencia al azar).
      if (rnd3() < 0.5) (override as Record<string, unknown>)[campo] = null;
      dejado[campo]++;
    } else {
      if (esHora(campo)) {
        const minO = Math.floor(rnd3() * 1440);
        (override as Record<string, unknown>)[campo] = hhmmss(minO, Math.floor(rnd3() * 60));
        esperadoDe[campo] = hhmm(minO);
      } else {
        const vO = Math.floor(rnd3() * 120);
        (override as Record<string, unknown>)[campo] = vO;
        esperadoDe[campo] = vO;
      }
      puesto[campo]++;
    }
  }

  const { cfg, fuente } = horarioEfectivoConFuente(override, g);

  for (const campo of CAMPOS_HORARIO) {
    const estaPuesto = campo in esperadoDe;
    const valorOk = estaPuesto ? val(cfg, campo) === esperadoDe[campo] : val(cfg, campo) === val(g, campo);
    const fuenteOk = fuente[campo] === (estaPuesto ? "empleado" : "global");
    if (!(valorOk && fuenteOk)) combinadoMal++;
  }
  // La sede NUNCA se mueve, se ponga lo que se ponga en el override.
  for (const k2 of ["sede_lat", "sede_lng", "sede_radio_m", "geocerca_bloquea"]) {
    if (val(cfg, k2) !== val(g, k2)) sedeMovida++;
  }
  // `horarioEfectivo` ≡ `horarioEfectivoConFuente(...).cfg`.
  if (difieren(horarioEfectivo(override, g), cfg).length !== 0) consistenciaMal++;
}
chk("cada campo puesto⇒override normalizado, cada null⇒global, fuente coherente (4000)", combinadoMal === 0, `${combinadoMal} fallos`);
chk("la sede (lat/lng/radio/geocerca) nunca se mueve", sedeMovida === 0, `${sedeMovida} movidas`);
chk("horarioEfectivo(...) ≡ horarioEfectivoConFuente(...).cfg", consistenciaMal === 0, `${consistenciaMal} difieren`);
chk("el barrido ejercitó, por campo, PUESTO y EN-NULL (no trivial)",
  CAMPOS_HORARIO.every((c) => puesto[c] > 0 && dejado[c] > 0),
  CAMPOS_HORARIO.map((c) => `${c}:+${puesto[c]}/-${dejado[c]}`).join(" "));

// ── 4 · NORMALIZACIÓN del override y consistencia de las dos puertas ────────────────────────
console.log("\n4 · NORMALIZACIÓN del override: 'HH:MM:SS' ⇒ 'HH:MM'\n");

const gN: ConfigRrhh = { ...globalAleatorio(prng(2026)), hora_entrada: "08:00", hora_salida: "18:00" };
chk("override '07:30:00' ⇒ efectivo '07:30'", horarioEfectivo({ hora_entrada: "07:30:00" }, gN).hora_entrada === "07:30");
chk("override '19:45' (ya HH:MM) ⇒ intacto '19:45'", horarioEfectivo({ hora_salida: "19:45" }, gN).hora_salida === "19:45");
chk("override con microsegundos '06:15:00.123456' ⇒ '06:15'", horarioEfectivo({ hora_entrada: "06:15:00.123456" }, gN).hora_entrada === "06:15");

// Escenario realista: un empleado que solo adelanta su entrada; lo demás hereda la sede.
const gReal: ConfigRrhh = {
  sede_lat: -12.05, sede_lng: -77.04, sede_radio_m: 150,
  hora_entrada: "08:00", hora_salida: "18:00", tolerancia_min: 10, almuerzo_min: 60,
  geocerca_bloquea: true,
};
const efReal = horarioEfectivoConFuente({ hora_entrada: "07:00:00" }, gReal);
chk("empleado que solo adelanta su entrada: 07:00 propia, resto heredado", (() => {
  const { cfg, fuente } = efReal;
  return cfg.hora_entrada === "07:00" && fuente.hora_entrada === "empleado"
    && cfg.hora_salida === "18:00" && fuente.hora_salida === "global"
    && cfg.tolerancia_min === 10 && fuente.tolerancia_min === "global"
    && cfg.almuerzo_min === 60 && fuente.almuerzo_min === "global"
    && cfg.sede_radio_m === 150 && cfg.geocerca_bloquea === true;
})());

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
