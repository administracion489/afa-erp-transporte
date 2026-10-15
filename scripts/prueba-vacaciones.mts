// Matriz de VACACIONES de RRHH: saldoVacaciones (ganados por antigüedad − gozados).
// Uso:  npx tsx scripts/prueba-vacaciones.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · ANTIGÜEDAD TRUNCA: el derecho vesta al cumplir cada año. Un día antes del
//     aniversario, el año no cuenta.
// 2 · RÉGIMEN COMO PARÁMETRO: 30 vs 15 días/año cambian lo ganado; el motor no lee base.
// 3 · GOZADOS: solo ausencias tipo 'vacaciones' APROBADAS suman; permisos, faltas y
//     pendientes no.
// 4 · LA REGLA DURA: un DOBLE DESCUENTO no baja el saldo. La misma ausencia (mismo id)
//     dos veces descuenta una sola vez. Un saldo negativo legítimo (adelanto) SÍ se muestra.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const V = requerir("../lib/rrhh/vacaciones") as typeof import("../lib/rrhh/vacaciones");
const { saldoVacaciones, aniosCompletos } = V;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const R30 = { vacaciones_dias: 30 }; // general / pequeña (microempresa suele ser 15)
const R15 = { vacaciones_dias: 15 };

// ── 1 · ANTIGÜEDAD TRUNCA ───────────────────────────────────────────────────────
console.log("\n1 · Antigüedad trunca (vesta en el aniversario)\n");
chk("ingreso 2020-03-15, hoy 2026-03-14 ⇒ 5 años (aún no cumple el 6º)",
  aniosCompletos("2020-03-15", "2026-03-14") === 5, `${aniosCompletos("2020-03-15", "2026-03-14")}`);
chk("hoy 2026-03-15 (aniversario) ⇒ 6 años", aniosCompletos("2020-03-15", "2026-03-15") === 6);
chk("hoy 2026-03-16 ⇒ 6 años", aniosCompletos("2020-03-15", "2026-03-16") === 6);
chk("antes del primer aniversario ⇒ 0 años", aniosCompletos("2026-01-01", "2026-12-31") === 0);
chk("ingreso futuro ⇒ 0 años (nunca negativo)", aniosCompletos("2027-01-01", "2026-01-01") === 0);
chk("fecha basura ⇒ 0 años", aniosCompletos("ayer", "2026-01-01") === 0);

// ── 2 · RÉGIMEN COMO PARÁMETRO ──────────────────────────────────────────────────
console.log("\n2 · Días ganados = años × días del régimen\n");
const s30 = saldoVacaciones(R30, "2020-03-15", [], "2026-03-16"); // 6 años
const s15 = saldoVacaciones(R15, "2020-03-15", [], "2026-03-16");
chk("6 años × 30 = 180 ganados", s30.dias_ganados === 180 && s30.anios_completos === 6, `${s30.dias_ganados}`);
chk("6 años × 15 = 90 ganados", s15.dias_ganados === 90, `${s15.dias_ganados}`);
chk("sin gozar ⇒ saldo = ganados", s30.saldo === 180 && s30.dias_gozados === 0);

// ── 3 · GOZADOS ────────────────────────────────────────────────────────────────
console.log("\n3 · Gozados: solo 'vacaciones' aprobadas\n");
const ausencias = [
  { id: 1, tipo: "vacaciones", estado: "aprobada", dias: 15 },
  { id: 2, tipo: "vacaciones", estado: "pendiente", dias: 10 },  // no aprobada → no cuenta
  { id: 3, tipo: "permiso", estado: "aprobada", dias: 3 },       // no es vacaciones → no cuenta
  { id: 4, tipo: "falta", estado: "aprobada", dias: 2 },         // no cuenta
  { id: 5, tipo: "vacaciones", estado: "aprobada", dias: 7 },
  { id: 6, tipo: "vacaciones", estado: "rechazada", dias: 5 },   // no cuenta
];
const s = saldoVacaciones(R30, "2020-03-15", ausencias, "2026-03-16");
chk("gozados = 15 + 7 = 22 (solo vacaciones aprobadas)", s.dias_gozados === 22, `${s.dias_gozados}`);
chk("saldo = 180 − 22 = 158", s.saldo === 158, `${s.saldo}`);

// ── 4 · DOBLE DESCUENTO ────────────────────────────────────────────────────────
console.log("\n4 · Un doble descuento no baja el saldo\n");
const unaVez = [{ id: 10, tipo: "vacaciones", estado: "aprobada", dias: 30 }];
const dosVeces = [...unaVez, { id: 10, tipo: "vacaciones", estado: "aprobada", dias: 30 }]; // MISMA id
const sUna = saldoVacaciones(R30, "2020-03-15", unaVez, "2026-03-16");
const sDos = saldoVacaciones(R30, "2020-03-15", dosVeces, "2026-03-16");
chk("la misma ausencia dos veces (misma id) descuenta una sola vez",
  sDos.dias_gozados === 30 && sDos.saldo === sUna.saldo, `gozados=${sDos.dias_gozados}`);
// Y sin dedup el saldo bajaría mal: la prueba de que el dedup hace algo.
const sumaCruda = dosVeces.reduce((a, x) => a + x.dias, 0);
chk("sin dedup habría descontado 60 (demuestra que el dedup actúa)",
  sumaCruda === 60 && sDos.dias_gozados === 30);

// Un saldo negativo legítimo (adelanto) SÍ se muestra — no se oculta, no se clampa.
const adelanto = saldoVacaciones(
  R30, "2025-06-01", [{ id: 20, tipo: "vacaciones", estado: "aprobada", dias: 45 }], "2026-01-01",
); // 0 años ganados, 45 gozados
chk("adelanto de vacaciones (gozó más de lo ganado) ⇒ saldo negativo visible",
  adelanto.dias_ganados === 0 && adelanto.dias_gozados === 45 && adelanto.saldo === -45,
  `saldo=${adelanto.saldo}`);

// Ausencias sin id: se suman tal cual (responsabilidad del llamador); días 0 o basura se ignoran.
const sinId = saldoVacaciones(R30, "2020-03-15", [
  { tipo: "vacaciones", estado: "aprobada", dias: 5 },
  { tipo: "vacaciones", estado: "aprobada", dias: 0 },        // 0 días no suma
  { tipo: "vacaciones", estado: "aprobada", dias: NaN as any }, // basura no suma
], "2026-03-16");
chk("ausencias sin id: suma 5, ignora 0 y NaN", sinId.dias_gozados === 5, `${sinId.dias_gozados}`);

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
