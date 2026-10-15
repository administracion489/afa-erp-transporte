// Matriz de la ASISTENCIA del conductor: presenciaDeServicios (≥1 servicio no cancelado).
// Uso:  npx tsx scripts/prueba-asistencia-conductor.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · PRESENTE = al menos un servicio NO cancelado ese día. La definición de "cancelado"
//     la da la fuente única de estados del ERP (lib/estados.ts), incluidas sus variantes
//     legadas (cancelado/CANCELADA): no hay una segunda definición en RRHH.
// 2 · TODO cancelado ⇒ NO presente. Vacío ⇒ NO presente.
// 3 · CONTEOS: no_cancelados + cancelados = total.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const A = requerir("../lib/rrhh/asistencia-conductor") as typeof import("../lib/rrhh/asistencia-conductor");
const E = requerir("../lib/estados") as typeof import("../lib/estados");
const { presenciaDeServicios, esServicioNoCancelado } = A;
const { normalizaEstado } = E;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const r = (estado: string | null) => ({ estado });

// ── 1 · PRESENTE con cualquier estado no cancelado ──────────────────────────────
console.log("\n1 · Un servicio no cancelado basta para estar presente\n");
for (const est of ["pendiente", "programada", "confirmada", "en_curso", "finalizada"]) {
  const p = presenciaDeServicios([r(est)]);
  chk(`estado '${est}' ⇒ presente`, p.presente === true && p.no_cancelados === 1 && p.cancelados === 0);
}

// Variantes legadas de "cancelada" NO cuentan como presencia.
console.log("\n2 · 'cancelada' y sus variantes legadas no son presencia\n");
for (const est of ["cancelada", "cancelado", "CANCELADA"]) {
  const p = presenciaDeServicios([r(est)]);
  chk(`estado '${est}' ⇒ no presente`, p.presente === false && p.cancelados === 1 && p.no_cancelados === 0);
  chk(`  …y esServicioNoCancelado('${est}') = false`, esServicioNoCancelado(est) === false);
}
// Coherencia con la fuente única: 'cancelado' normaliza a 'cancelada'.
chk("'cancelado' normaliza a 'cancelada' (fuente única)", normalizaEstado("cancelado") === "cancelada");

// ── 3 · Mezclas, vacío y conteos ────────────────────────────────────────────────
console.log("\n3 · Mezclas, día vacío y conteos\n");
const mezcla = presenciaDeServicios([r("cancelada"), r("finalizada"), r("cancelado"), r("programada")]);
chk("mezcla con ≥1 no cancelado ⇒ presente", mezcla.presente === true);
chk("conteos: 2 no cancelados, 2 cancelados, total 4",
  mezcla.no_cancelados === 2 && mezcla.cancelados === 2 && mezcla.total === 4,
  `${mezcla.no_cancelados}/${mezcla.cancelados}/${mezcla.total}`);

const todoCancelado = presenciaDeServicios([r("cancelada"), r("cancelado")]);
chk("día con TODO cancelado ⇒ no presente (no_cancelados 0)",
  todoCancelado.presente === false && todoCancelado.no_cancelados === 0 && todoCancelado.total === 2);

const vacio = presenciaDeServicios([]);
chk("día sin servicios ⇒ no presente, total 0", vacio.presente === false && vacio.total === 0);
chk("null/undefined ⇒ no presente", presenciaDeServicios(null).presente === false &&
  presenciaDeServicios(undefined).presente === false);

// Estado nulo/desconocido NO es 'cancelada' ⇒ cuenta como presencia (lado seguro: la
// normalización manda un valor desconocido a 'pendiente', no a 'cancelada').
const desconocido = presenciaDeServicios([r(null), r("vaya_a_saber")]);
chk("estado nulo/desconocido cuenta como no cancelado",
  desconocido.no_cancelados === 2 && desconocido.presente === true);

// Barrido: no_cancelados + cancelados = total, siempre.
let casos = 0, descuadre = 0;
const ESTADOS = ["pendiente", "programada", "confirmada", "en_curso", "finalizada", "cancelada", "cancelado", null, "x"];
for (let a = 0; a < ESTADOS.length; a++) for (let b = 0; b < ESTADOS.length; b++) {
  const p = presenciaDeServicios([r(ESTADOS[a]), r(ESTADOS[b])]);
  casos++;
  if (p.no_cancelados + p.cancelados !== p.total || p.total !== 2) descuadre++;
  if (p.presente !== p.no_cancelados >= 1) descuadre++;
}
chk(`${casos} pares · no_cancelados + cancelados = total y presente ⇔ no_cancelados≥1`,
  descuadre === 0, `${descuadre} descuadres`);

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
