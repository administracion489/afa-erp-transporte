// Matriz del TRABAJO EN CAMPO de RRHH (Fase 2): ventanaCampoVigente / estadoAutorizacion
// (lib/rrhh/campo.ts). Motor PURO: todo en memoria, sin base, sin reloj.
// Uso:  npx tsx scripts/prueba-campo.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · estadoAutorizacion DERIVA el tiempo: una 'aprobada' cuya ventana ya pasó se lee
//     'vencida'; cuya ventana contiene `ahora`, 'vigente'; cuya ventana aún no abre,
//     'aprobada'. Solicitada y rechazada no dependen del reloj.
// 2 · Los MOTIVOS declarados de ventanaCampoVigente, uno por uno: sin_autorizacion,
//     fuera_de_ventana (aprobada antes de la ventana), vencida (aprobada después),
//     no_aprobada (solicitada/rechazada), vigente.
// 3 · VARIAS autorizaciones: gana la vigente aunque esté entre vencidas/solicitadas.
// 4 · REGLA DURA (barrido, bicondicional): ventanaCampoVigente reporta `vigente`
//     EXACTAMENTE cuando existe una autorización 'aprobada' cuya [desde, hasta] contiene
//     `ahora`. La mitad "⇒" es el invariante (nunca vigente sin tal autorización); la
//     mitad "⇐" es el corolario anti-trivial (sí vigente cuando corresponde) — un motor
//     que devolviera siempre `false` pasaría la primera y fallaría la segunda.
// 5 · Cuando `vigente` es true, `autorizacion` es un miembro que de verdad contiene `ahora`;
//     y `motivo === "vigente"` ⟺ `vigente`.

import {
  estadoAutorizacion,
  ventanaCampoVigente,
  type AutorizacionCampo,
} from "../lib/rrhh/campo";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// `ahora` fijo (epoch-ms) y cotas como ISO, que es como llegan de la base (timestamptz/date).
const AHORA = Date.parse("2026-10-15T12:00:00-05:00");
const DIA = 86_400_000;
const iso = (offDias: number) => new Date(AHORA + offDias * DIA).toISOString();

const A = (
  estado: AutorizacionCampo["estado"],
  desde: AutorizacionCampo["vigente_desde"],
  hasta: AutorizacionCampo["vigente_hasta"],
  id?: number,
): AutorizacionCampo => ({ id, estado, vigente_desde: desde, vigente_hasta: hasta });

// ── Oráculo INDEPENDIENTE de "esta autorización contiene ahora" ───────────────────
// Reimplementado aparte (no importa nada del motor) para que el barrido lo contraste.
const ms = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; }
  return null;
};
const contiene = (a: AutorizacionCampo, ahora: number): boolean => {
  if (String(a.estado).toLowerCase() !== "aprobada") return false;
  const d = ms(a.vigente_desde), h = ms(a.vigente_hasta);
  return d != null && h != null && ahora >= d && ahora <= h;
};

// ── 1 · estadoAutorizacion deriva el tiempo ───────────────────────────────────────
console.log("\n1 · estadoAutorizacion (estado efectivo en `ahora`)\n");
chk("aprobada con ventana que contiene ahora ⇒ 'vigente'",
  estadoAutorizacion(A("aprobada", iso(-2), iso(+2)), AHORA) === "vigente");
chk("aprobada cuya ventana ya pasó (hasta < ahora) ⇒ 'vencida'",
  estadoAutorizacion(A("aprobada", iso(-10), iso(-1)), AHORA) === "vencida");
chk("aprobada cuya ventana aún no abre (ahora < desde) ⇒ 'aprobada'",
  estadoAutorizacion(A("aprobada", iso(+1), iso(+5)), AHORA) === "aprobada");
chk("solicitada ⇒ 'solicitada' (no depende del reloj)",
  estadoAutorizacion(A("solicitada", iso(-2), iso(+2)), AHORA) === "solicitada");
chk("rechazada ⇒ 'rechazada' (aunque la ventana contenga ahora)",
  estadoAutorizacion(A("rechazada", iso(-2), iso(+2)), AHORA) === "rechazada");
chk("estado desconocido/legado ⇒ 'solicitada' (no aprobada)",
  estadoAutorizacion(A("en_revision", iso(-2), iso(+2)), AHORA) === "solicitada");
chk("aprobada sin cota de inicio (desde ausente) ⇒ no es vigente ('aprobada')",
  estadoAutorizacion(A("aprobada", null, iso(+2)), AHORA) === "aprobada");
chk("aprobada sin cota de fin pero hasta ausente ⇒ no se inventa vencida ('aprobada')",
  estadoAutorizacion(A("aprobada", iso(-2), null), AHORA) === "aprobada");
chk("borde: ahora == hasta ⇒ todavía 'vigente' (inclusivo)",
  estadoAutorizacion(A("aprobada", iso(-2), AHORA), AHORA) === "vigente");
chk("borde: ahora == desde ⇒ ya 'vigente' (inclusivo)",
  estadoAutorizacion(A("aprobada", AHORA, iso(+2)), AHORA) === "vigente");
chk("ventana invertida (desde > hasta) con aprobada ⇒ nunca 'vigente'",
  estadoAutorizacion(A("aprobada", iso(+2), iso(-2)), AHORA) !== "vigente");

// ── 2 · Los motivos declarados de ventanaCampoVigente ─────────────────────────────
console.log("\n2 · ventanaCampoVigente — un motivo por caso\n");
const vSin = ventanaCampoVigente([], AHORA);
chk("sin autorizaciones ⇒ { false, null, sin_autorizacion }",
  vSin.vigente === false && vSin.autorizacion === null && vSin.motivo === "sin_autorizacion");

const vSin2 = ventanaCampoVigente(null, AHORA);
chk("lista null ⇒ sin_autorizacion (null-safe)",
  vSin2.vigente === false && vSin2.motivo === "sin_autorizacion");

const vVig = ventanaCampoVigente([A("aprobada", iso(-1), iso(+1), 7)], AHORA);
chk("aprobada dentro de la ventana ⇒ vigente, y autorizacion es la misma (id 7)",
  vVig.vigente === true && vVig.motivo === "vigente" && vVig.autorizacion?.id === 7);

const vAntes = ventanaCampoVigente([A("aprobada", iso(+1), iso(+3))], AHORA);
chk("aprobada ANTES de la ventana ⇒ no vigente, motivo fuera_de_ventana",
  vAntes.vigente === false && vAntes.motivo === "fuera_de_ventana");

const vDesp = ventanaCampoVigente([A("aprobada", iso(-5), iso(-1))], AHORA);
chk("aprobada DESPUÉS de la ventana ⇒ no vigente, motivo vencida",
  vDesp.vigente === false && vDesp.motivo === "vencida");

const vSol = ventanaCampoVigente([A("solicitada", iso(-1), iso(+1))], AHORA);
chk("solicitada (aunque las fechas cubran hoy) ⇒ no vigente, motivo no_aprobada",
  vSol.vigente === false && vSol.motivo === "no_aprobada");

const vRec = ventanaCampoVigente([A("rechazada", iso(-1), iso(+1))], AHORA);
chk("rechazada ⇒ no vigente, motivo no_aprobada",
  vRec.vigente === false && vRec.motivo === "no_aprobada");

// ── 3 · Varias autorizaciones ─────────────────────────────────────────────────────
console.log("\n3 · Varias autorizaciones\n");
const vEntre = ventanaCampoVigente(
  [A("aprobada", iso(-10), iso(-5), 1), A("rechazada", iso(-1), iso(+1), 2),
   A("aprobada", iso(-1), iso(+1), 3), A("solicitada", iso(0), iso(+9), 4)],
  AHORA,
);
chk("una vigente entre vencida/rechazada/solicitada ⇒ gana la vigente (id 3)",
  vEntre.vigente === true && vEntre.motivo === "vigente" && vEntre.autorizacion?.id === 3);

const vNinguna = ventanaCampoVigente(
  [A("rechazada", iso(-1), iso(+1), 1), A("aprobada", iso(-9), iso(-4), 2)],
  AHORA,
);
chk("ninguna vigente: entre vencida y rechazada, la MÁS RELEVANTE es la vencida (id 2)",
  vNinguna.vigente === false && vNinguna.motivo === "vencida" && vNinguna.autorizacion?.id === 2);

const vFuturaGana = ventanaCampoVigente(
  [A("aprobada", iso(-9), iso(-4), 1), A("aprobada", iso(+2), iso(+6), 2)],
  AHORA,
);
chk("ninguna vigente: aprobada-futura es más relevante que una vencida (fuera_de_ventana, id 2)",
  vFuturaGana.vigente === false && vFuturaGana.motivo === "fuera_de_ventana" && vFuturaGana.autorizacion?.id === 2);

// Cotas como epoch-ms (no solo ISO): el motor acepta ambos.
const vMs = ventanaCampoVigente([A("aprobada", AHORA - DIA, AHORA + DIA, 5)], AHORA);
chk("cotas en epoch-ms ⇒ vigente igual que con ISO", vMs.vigente === true && vMs.autorizacion?.id === 5);

// ── 4 y 5 · BARRIDO: bicondicional dura + coherencia de la salida ─────────────────
console.log("\n4 · Barrido: vigente ⟺ existe aprobada cuya ventana contiene ahora\n");

const ESTADOS: AutorizacionCampo["estado"][] = ["solicitada", "aprobada", "rechazada", "en_revision"];
// Offsets de cota (días) relativos a ahora, más cotas desconocidas (null):
const OFFSETS: (number | null)[] = [-5, -1, 0, +1, +5, null];

// Catálogo de autorizaciones individuales: todos los estados × todas las (desde, hasta).
const CATALOGO: AutorizacionCampo[] = [];
for (const e of ESTADOS)
  for (const d of OFFSETS)
    for (const h of OFFSETS)
      CATALOGO.push(A(e, d == null ? null : iso(d), h == null ? null : iso(h)));

// Coherencia del estado efectivo con el oráculo: estadoAutorizacion === 'vigente' ⟺ contiene().
let swCat = 0, malEstado = 0;
for (const a of CATALOGO) {
  swCat++;
  const esVig = estadoAutorizacion(a, AHORA) === "vigente";
  if (esVig !== contiene(a, AHORA)) malEstado++;
}
chk(`estadoAutorizacion==='vigente' ⟺ oráculo contiene() en ${swCat} autorizaciones`, malEstado === 0,
  `${malEstado} discrepancias`);

// Listas de 0..3 autorizaciones tomadas de un subconjunto representativo del catálogo.
// Subconjunto: cubre vigente, vencida, futura, solicitada, rechazada, cota-faltante, invertida.
const SUB: AutorizacionCampo[] = [
  A("aprobada", iso(-1), iso(+1), 10),   // vigente
  A("aprobada", iso(-9), iso(-4), 11),   // vencida
  A("aprobada", iso(+2), iso(+6), 12),   // futura
  A("aprobada", iso(-2), null, 13),      // sin fin → aprobada (no vigente)
  A("aprobada", null, iso(+2), 14),      // sin inicio → aprobada (no vigente)
  A("aprobada", iso(+2), iso(-2), 15),   // invertida → nunca vigente
  A("solicitada", iso(-1), iso(+1), 16), // no_aprobada aunque cubra hoy
  A("rechazada", iso(-1), iso(+1), 17),  // no_aprobada
  A("en_revision", iso(-1), iso(+1), 18),// desconocido → no_aprobada
];

let swListas = 0, malBicond = 0, malMiembro = 0, malMotivo = 0, malVacio = 0;
let vistoVigente = 0, vistoNoVigente = 0;

const corre = (lista: AutorizacionCampo[]) => {
  swListas++;
  const r = ventanaCampoVigente(lista, AHORA);
  const oraculo = lista.some((a) => contiene(a, AHORA));

  // (4) bicondicional dura: vigente ⟺ existe aprobada que contiene ahora.
  if (r.vigente !== oraculo) malBicond++;

  // (5) coherencia de la salida.
  if (r.vigente !== (r.motivo === "vigente")) malMotivo++;        // motivo==='vigente' ⟺ vigente
  if (r.vigente) {
    vistoVigente++;
    if (!(r.autorizacion && contiene(r.autorizacion, AHORA))) malMiembro++; // la devuelta contiene de verdad
  } else {
    vistoNoVigente++;
    if (lista.length === 0 && !(r.autorizacion === null && r.motivo === "sin_autorizacion")) malVacio++;
    // No vigente con lista no vacía ⇒ motivo describe una carencia, no "vigente".
    if (lista.length > 0 && !["fuera_de_ventana", "vencida", "no_aprobada"].includes(r.motivo)) malMotivo++;
  }
};

// Lista vacía, singletons, pares y tríos del subconjunto.
corre([]);
for (let i = 0; i < SUB.length; i++) corre([SUB[i]]);
for (let i = 0; i < SUB.length; i++)
  for (let j = 0; j < SUB.length; j++) corre([SUB[i], SUB[j]]);
for (let i = 0; i < SUB.length; i++)
  for (let j = 0; j < SUB.length; j++)
    for (let k = 0; k < SUB.length; k++) corre([SUB[i], SUB[j], SUB[k]]);

chk(`bicondicional vigente⟺oráculo en ${swListas} listas`, malBicond === 0, `${malBicond} fallos`);
chk("motivo==='vigente' ⟺ vigente (en todo el barrido)", malMotivo === 0, `${malMotivo} fallos`);
chk("cuando vigente, la autorizacion devuelta contiene ahora de verdad", malMiembro === 0, `${malMiembro} fallos`);
chk("lista vacía ⇒ {null, sin_autorizacion} siempre", malVacio === 0, `${malVacio} fallos`);

// Corolario anti-trivial: el barrido produjo AMBOS veredictos (ni todo false ni todo true).
console.log("\n5 · Corolario anti-trivial (el motor no es constante)\n");
chk(`sí reporta vigente cuando corresponde (${vistoVigente} casos) y no cuando no (${vistoNoVigente} casos)`,
  vistoVigente > 0 && vistoNoVigente > 0);

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
