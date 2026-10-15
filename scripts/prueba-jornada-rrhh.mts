// Matriz de la JORNADA de RRHH: calcularJornada (horas, almuerzo, tardanza, estado).
// Uso:  npx tsx scripts/prueba-jornada-rrhh.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · EL DÍA NORMAL de 8 h, la tardanza con tolerancia y la salida temprana.
// 2 · ALMUERZO AUSENTE: falta el par ⇒ se descuenta el default declarado (almuerzo_estimado).
// 3 · MARCAS FALTANTES: sin entrada ⇒ incompleta; sin salida ⇒ en_curso; vacío ⇒ sin_marcas.
// 4 · CRUCE DE MEDIANOCHE: un turno 22:00→06:00 da sus horas por los TIMESTAMPS, sin caso
//     especial (medir con "HH:MM" sueltos sería el bug).
// 5 · INVARIANTES por barrido: horas_trabajadas ≥ 0 SIEMPRE, almuerzo/tardanza/salida ≥ 0,
//     biyección estado↔código, y el CORolario: una jornada normal SÍ devuelve horas > 0.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const J = requerir("../lib/rrhh/jornada") as typeof import("../lib/rrhh/jornada");
const { calcularJornada, CODIGO_JORNADA } = J;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const CFG = {
  sede_lat: -12.05, sede_lng: -77.04, sede_radio_m: 100,
  hora_entrada: "08:00", hora_salida: "17:00", tolerancia_min: 10, almuerzo_min: 60,
  geocerca_bloquea: true,
} as const;

// Las marcas llevan offset -05:00 explícito: el minuto del día Lima es la hora de pared
// que se escribe, sin ambigüedad de huso.
const marca = (tipo: string, hhmm: string, fecha = "2026-01-10") =>
  ({ tipo, marcado_en: `${fecha}T${hhmm}:00-05:00` });

// ── 1 · DÍA NORMAL ─────────────────────────────────────────────────────────────
console.log("\n1 · Día normal: 08:00 → 17:00 con almuerzo 13:00–14:00\n");
const normal = calcularJornada([
  marca("entrada", "08:00"),
  marca("salida_almuerzo", "13:00"),
  marca("regreso_almuerzo", "14:00"),
  marca("salida", "17:00"),
], CFG);
chk("9 h de span − 1 h de almuerzo = 8 h", normal.horas_trabajadas === 8, `${normal.horas_trabajadas}`);
chk("almuerzo real 1 h, no estimado", normal.horas_almuerzo === 1 && normal.almuerzo_estimado === false);
chk("sin tardanza ni salida temprana", normal.tardanza_min === 0 && normal.salida_temprana_min === 0);
chk("estado completa / código ok", normal.estado === "completa" && normal.codigo === "ok");

console.log("\n1b · Tardanza con tolerancia y salida temprana\n");
// entrada 08:20 con hora 08:00 y tolerancia 10 ⇒ 10 min de tardanza. salida 16:30 ⇒ 30 min antes.
const tarde = calcularJornada([
  marca("entrada", "08:20"),
  marca("salida_almuerzo", "13:00"),
  marca("regreso_almuerzo", "14:00"),
  marca("salida", "16:30"),
], CFG);
chk("tardanza = 20 − 10 tolerancia = 10 min", tarde.tardanza_min === 10, `${tarde.tardanza_min}`);
chk("salida temprana = 30 min", tarde.salida_temprana_min === 30, `${tarde.salida_temprana_min}`);
// Dentro de la tolerancia no hay tardanza.
const justo = calcularJornada([marca("entrada", "08:10"), marca("salida", "17:00")], CFG);
chk("entrada 08:10 con tolerancia 10 ⇒ sin tardanza", justo.tardanza_min === 0);

// ── 2 · ALMUERZO AUSENTE ───────────────────────────────────────────────────────
console.log("\n2 · Falta el par de almuerzo ⇒ descuento default\n");
const sinAlmuerzo = calcularJornada([marca("entrada", "08:00"), marca("salida", "17:00")], CFG);
chk("9 h − 60 min default = 8 h", sinAlmuerzo.horas_trabajadas === 8, `${sinAlmuerzo.horas_trabajadas}`);
chk("almuerzo estimado (1 h) y marcado como estimado",
  sinAlmuerzo.horas_almuerzo === 1 && sinAlmuerzo.almuerzo_estimado === true);
chk("estado completa", sinAlmuerzo.estado === "completa");
// Solo una de las dos marcas de almuerzo ⇒ también default (no hay par).
const medioAlmuerzo = calcularJornada([
  marca("entrada", "08:00"), marca("salida_almuerzo", "13:00"), marca("salida", "17:00"),
], CFG);
chk("solo salida_almuerzo (sin regreso) ⇒ default, estimado", medioAlmuerzo.almuerzo_estimado === true &&
  medioAlmuerzo.horas_almuerzo === 1);

// ── 3 · MARCAS FALTANTES ───────────────────────────────────────────────────────
console.log("\n3 · Marcas faltantes\n");
const sinSalida = calcularJornada([marca("entrada", "08:20")], CFG);
chk("sin salida ⇒ en_curso, horas 0, pero la tardanza ya se conoce",
  sinSalida.estado === "en_curso" && sinSalida.codigo === "en_curso" &&
  sinSalida.horas_trabajadas === 0 && sinSalida.tardanza_min === 10);
const sinEntrada = calcularJornada([marca("salida", "17:00")], CFG);
chk("sin entrada ⇒ incompleta (día roto, no se juzga parcialmente)",
  sinEntrada.estado === "incompleta" && sinEntrada.codigo === "falta_entrada" &&
  sinEntrada.horas_trabajadas === 0 && sinEntrada.tardanza_min === 0);
const vacio = calcularJornada([], CFG);
chk("sin marcas ⇒ sin_marcas, todo en 0",
  vacio.estado === "sin_marcas" && vacio.codigo === "sin_marcas" &&
  vacio.horas_trabajadas === 0 && vacio.horas_almuerzo === 0);
const basura = calcularJornada([{ tipo: "cafe", marcado_en: "nope" } as any], CFG);
chk("marcas no utilizables ⇒ sin_marcas", basura.estado === "sin_marcas");

// ── 4 · CRUCE DE MEDIANOCHE ────────────────────────────────────────────────────
console.log("\n4 · Turno nocturno 22:00 → 06:00 (día siguiente)\n");
const noche = calcularJornada([
  marca("entrada", "22:00", "2026-01-10"),
  marca("salida_almuerzo", "02:00", "2026-01-11"),
  marca("regreso_almuerzo", "02:30", "2026-01-11"),
  marca("salida", "06:00", "2026-01-11"),
], CFG);
chk("8 h de span − 0.5 h de almuerzo = 7.5 h, por los timestamps (sin caso especial)",
  noche.horas_trabajadas === 7.5, `${noche.horas_trabajadas}`);
chk("estado completa", noche.estado === "completa");
// Nota declarada: tardanza/salida_temprana del turno nocturno NO se afirman aquí (son
// medidas de reloj-de-día contra una referencia de día, con límite declarado en el motor).

// Salida antes que entrada (corrupto) ⇒ horas 0, nunca negativo, estado completa.
const corrupto = calcularJornada([
  marca("entrada", "17:00"), marca("salida", "08:00"),
], CFG);
chk("salida antes que entrada ⇒ horas 0 (no negativo)", corrupto.horas_trabajadas === 0 &&
  corrupto.estado === "completa");

// ── 5 · INVARIANTES POR BARRIDO ────────────────────────────────────────────────
console.log("\n5 · Barrido de invariantes\n");

// Biyección estado ↔ código.
const estados = Object.keys(CODIGO_JORNADA);
const codigos = Object.values(CODIGO_JORNADA);
const inverso = new Map<string, string>();
for (const e of estados) inverso.set((CODIGO_JORNADA as any)[e], e);
chk("biyección estado↔código: 4 estados, 4 códigos distintos, invertible",
  estados.length === 4 && new Set(codigos).size === 4 && inverso.size === 4);

// Barrido: cada tipo presente/ausente × hora de salida variada. La entrada queda fija a
// las 08:00 para que una jornada completa tenga span real (salida < entrada stresa el
// clamp a 0). El almuerzo va 12:30–13:30 (1 h normal) cuando el par está presente.
const SALIDAS = ["06:00", "08:00", "13:00", "14:00", "17:00", "22:00"];
let casos = 0, negativa = 0, codigoMal = 0, estadoMal = 0, almNeg = 0, conHoras = 0;
const tipos = ["entrada", "salida_almuerzo", "regreso_almuerzo", "salida"];
const estadosValidos = new Set(["completa", "incompleta", "sin_marcas", "en_curso"]);
const tiempoDe = (t: string, hSalida: string) =>
  t === "entrada" ? "08:00" : t === "salida_almuerzo" ? "12:30"
  : t === "regreso_almuerzo" ? "13:30" : hSalida;

for (let mask = 0; mask < 16; mask++) {
  for (const hSalida of SALIDAS) {
    const marcas = tipos
      .filter((_, i) => mask & (1 << i))
      .map((t) => marca(t, tiempoDe(t, hSalida)));
    const r = calcularJornada(marcas, { ...CFG, almuerzo_min: 90 });
    casos++;
    if (r.horas_trabajadas < 0) negativa++;
    if (r.horas_almuerzo < 0) almNeg++;
    if (r.tardanza_min < 0 || r.salida_temprana_min < 0) negativa++;
    if (r.codigo !== (CODIGO_JORNADA as any)[r.estado]) codigoMal++;
    if (!estadosValidos.has(r.estado)) estadoMal++;
    if (r.horas_trabajadas > 0) conHoras++;
  }
}
chk(`${casos} casos · horas_trabajadas ≥ 0 SIEMPRE`, negativa === 0, `${negativa} negativas`);
chk(`${casos} casos · horas_almuerzo ≥ 0 SIEMPRE`, almNeg === 0);
chk(`${casos} casos · código = CODIGO_JORNADA[estado] SIEMPRE`, codigoMal === 0, `${codigoMal} desajustes`);
chk(`${casos} casos · estado siempre ∈ {completa, incompleta, sin_marcas, en_curso}`, estadoMal === 0);
// Corolario anti-trivial: hay jornadas con horas > 0 (si no, "≥ 0" sería trivial con todo 0).
chk("no es trivial: hay jornadas con horas > 0", conHoras > 0, `${conHoras} con horas`);

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
