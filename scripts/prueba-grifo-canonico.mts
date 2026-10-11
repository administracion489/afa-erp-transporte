// Pruebas de la IDENTIDAD DEL GRIFO: una empresa, un nombre. NO tocan la base: datos en memoria
// contra el módulo puro lib/combustible/grifo-canonico.ts.
// Uso:  npx tsx scripts/prueba-grifo-canonico.mts   (sale con código 1 si algo falla)
//
// El caso (11/10/2026): la nota de la CWZ-371 tenía «COESTI S.A. - RUC: 20127765279» legible y la
// carga quedó sin grifo; y la misma empresa venía entrando como «COESTI», «COESTI S.A.» y
// «CORATI SA COESTI», tres filas distintas en «Por grifo». Lo que la matriz fija y no se puede aflojar:
//   · el RUC manda, y el nombre es la razón social de la factura SUNAT;
//   · el nombre se reconoce por palabras completas, nunca «contiene» a secas ni por una palabra genérica;
//   · la MARCA de la estación (Primax) no es la empresa;
//   · un RUC leído que contradice al nombre no se pisa con el nombre.
import {
  rucValido,
  claveDistintiva,
  construirCatalogoGrifos,
  grifoPorRuc,
  grifoPorNombre,
  resolverGrifo,
  claveAgrupacionGrifo,
  CATALOGO_VACIO,
} from "../lib/combustible/grifo-canonico";
import { normEmpresa } from "../lib/radar/identidad-voucher";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

/** Completa un RUC de 10 cifras con su dígito verificador (para inventar RUC válidos de prueba). */
function conVerificador(diez: string): string {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(diez[i]), 0);
  const r = 11 - (suma % 11);
  return diez + String(r === 10 ? 0 : r === 11 ? 1 : r);
}

const COESTI = "20127765279";
const OTRO = conVerificador("2050384012"); // un vendedor distinto, válido
const DESCONOCIDO = conVerificador("2060000001");

// ── 1. El RUC peruano ────────────────────────────────────────────────────────
{
  chk("el RUC de COESTI es válido", rucValido(COESTI) === COESTI);
  chk("con texto alrededor también", rucValido("RUC: 20127765279") === COESTI);
  chk("una cifra cambiada no pasa el dígito verificador", rucValido("20127765278") === null && rucValido("20127765179") === null);
  chk("10 cifras no es un RUC", rucValido("2012776527") === null);
  chk("un prefijo que no es de contribuyente tampoco", rucValido(conVerificador("3012776527")) === null);
  chk("el generador de prueba da RUC válidos", rucValido(OTRO) === OTRO && rucValido(DESCONOCIDO) === DESCONOCIDO);
  chk("vacío → null", rucValido(null) === null && rucValido("") === null);
}

// ── 2. El catálogo sale de los datos ─────────────────────────────────────────
const CAT = construirCatalogoGrifos({
  // Tres XML de SUNAT y un PDF leído por IA que escribió mal la razón social: manda la mayoría.
  facturas: [
    { ruc_emisor: COESTI, razon_social: "COESTI S.A." },
    { ruc_emisor: COESTI, razon_social: "COESTI S.A." },
    { ruc_emisor: COESTI, razon_social: "COESTI S.A." },
    { ruc_emisor: COESTI, razon_social: "CORATI SA COESTI" },
    { ruc_emisor: OTRO, razon_social: "REPSOL COMERCIAL S.A.C." },
    { ruc_emisor: "123", razon_social: "BASURA" },
  ],
  cuentas: [{ rucs: [COESTI] }],
  cargas: [{ ruc_proveedor: conVerificador("2010012821"), grifo: "GRIFO SERVICENTRO S.A.C." }],
});
{
  chk("el nombre de COESTI es el de sus facturas", grifoPorRuc(CAT, COESTI) === "COESTI S.A.", String(grifoPorRuc(CAT, COESTI)));
  chk("el de otro vendedor, el suyo", grifoPorRuc(CAT, OTRO) === "REPSOL COMERCIAL S.A.C.");
  chk("un RUC inválido no entra al catálogo", !CAT.porRuc.has("123"));
  chk("un RUC desconocido no tiene nombre", grifoPorRuc(CAT, DESCONOCIDO) === null);
  chk("un RUC que solo está en la cuenta entra sin nombre",
    construirCatalogoGrifos({ cuentas: [{ rucs: [COESTI] }] }).porRuc.get(COESTI)?.nombre === null);
  chk("sin facturas, el nombre sale de las cargas con ese RUC",
    grifoPorRuc(construirCatalogoGrifos({ cargas: [{ ruc_proveedor: COESTI, grifo: "COESTI S.A." }, { ruc_proveedor: COESTI, grifo: "COESTI S.A." }, { ruc_proveedor: COESTI, grifo: "Coesti" }] }), COESTI) === "COESTI S.A.");
}

// ── 3. EL CASO: el RUC leído nombra al grifo ─────────────────────────────────
{
  const r = resolverGrifo({ nombre: null, ruc: "20127765279" }, CAT);
  chk("sin nombre y con el RUC del encabezado → COESTI S.A.", r.nombre === "COESTI S.A." && r.por === "ruc" && r.cambio, `${r.nombre} ${r.por}`);
  const r2 = resolverGrifo({ nombre: "CORATI SA COESTI", ruc: "20127765279" }, CAT);
  chk("una redacción rara con el RUC → COESTI S.A.", r2.nombre === "COESTI S.A." && r2.por === "ruc");
  const r3 = resolverGrifo({ nombre: "COESTI S.A.", ruc: COESTI }, CAT);
  chk("el nombre ya canónico no cambia", r3.nombre === "COESTI S.A." && !r3.cambio);
}

// ── 4. Sin RUC, el nombre por palabras completas ─────────────────────────────
{
  for (const v of ["COESTI", "COESTI S.A.", "Coesti SA", "coesti s.a.", "CORATI SA COESTI", "COESTI S.A. - E/S MACARENA", "E/S COESTI ATE"]) {
    const r = resolverGrifo({ nombre: v }, CAT);
    chk(`«${v}» → COESTI S.A.`, r.nombre === "COESTI S.A." && r.por === "nombre" && r.ruc === COESTI, `${r.nombre} ${r.por}`);
  }
  chk("«COESTIX» no es COESTI (palabra completa)", resolverGrifo({ nombre: "COESTIX SAC" }, CAT).por === "leido");
  chk("«PRIMAX ATE» no se convierte en COESTI: la marca no es la empresa", resolverGrifo({ nombre: "PRIMAX ATE" }, CAT).nombre === "PRIMAX ATE");
  chk("«Repsol Comercial» → su razón social", resolverGrifo({ nombre: "Repsol Comercial SAC" }, CAT).nombre === "REPSOL COMERCIAL S.A.C.");
  chk("un nombre genérico solo no reconoce a nadie", claveDistintiva("GRIFO SERVICENTRO S.A.C.") === null);
  chk("…así que «SERVICENTRO SAN LUIS» no se come al servicentro del catálogo",
    resolverGrifo({ nombre: "SERVICENTRO SAN LUIS" }, CAT).nombre === "SERVICENTRO SAN LUIS");
  chk("un nombre desconocido se guarda limpio, sin inventar", resolverGrifo({ nombre: "  Grifo  Don  Lucho " }, CAT).nombre === "Grifo Don Lucho");
  chk("nada leído → vacío", resolverGrifo({ nombre: null, ruc: null }, CAT).por === "vacio");
}

// ── 5. El RUC que contradice al nombre NO se pisa ─────────────────────────────
{
  const r = resolverGrifo({ nombre: "COESTI S.A.", ruc: OTRO }, CAT);
  chk("nombre COESTI + RUC de Repsol → manda el RUC", r.nombre === "REPSOL COMERCIAL S.A.C." && r.por === "ruc");
  const r2 = resolverGrifo({ nombre: "COESTI S.A.", ruc: DESCONOCIDO }, CAT);
  chk("nombre COESTI + RUC válido desconocido → se conserva lo leído", r2.nombre === "COESTI S.A." && r2.ruc === DESCONOCIDO && r2.por === "leido");
  const r3 = resolverGrifo({ nombre: "CORATI SA COESTI", ruc: "20127765278" }, CAT);
  chk("un RUC inválido no frena el reconocimiento por nombre", r3.nombre === "COESTI S.A." && r3.ruc === COESTI);
}

// ── 6. Sin catálogo, el comportamiento de siempre ─────────────────────────────
{
  const r = resolverGrifo({ nombre: "CORATI SA COESTI", ruc: COESTI }, CATALOGO_VACIO);
  chk("catálogo vacío: se guarda lo leído", r.nombre === "CORATI SA COESTI" && r.ruc === COESTI && !r.cambio);
}

// ── 7. «Por grifo» agrupa por identidad ──────────────────────────────────────
{
  const claves = new Set([
    claveAgrupacionGrifo({ grifo: "COESTI" }, CAT),
    claveAgrupacionGrifo({ grifo: "COESTI S.A." }, CAT),
    claveAgrupacionGrifo({ grifo: "CORATI SA COESTI" }, CAT),
    claveAgrupacionGrifo({ grifo: null, ruc_proveedor: COESTI }, CAT),
    claveAgrupacionGrifo({ grifo: "Primax - Ate", ruc_proveedor: COESTI }, CAT),
  ]);
  chk("las cinco redacciones de COESTI caen en una fila", claves.size === 1, [...claves].join(" | "));
  chk("«Primax - Ate» sin RUC es otra fila", claveAgrupacionGrifo({ grifo: "Primax - Ate" }, CAT) !== [...claves][0]);
  chk("sin nada, sin clave", claveAgrupacionGrifo({ grifo: "  " }, CAT) === null);
}

// ── 8. BARRIDO: nunca se nombra por un parecido, y resolver es idempotente ────
{
  const piezas = ["COESTI", "COESTIX", "PRIMAX", "REPSOL", "COMERCIAL", "GRIFO", "SERVICENTRO", "SA", "S.A.", "ATE", "E/S", "CORATI", "DON", "LUCHO", ""];
  let casos = 0, malos = 0;
  const ejemplos: string[] = [];
  for (const a of piezas) for (const b of piezas) for (const c of piezas) {
    const nombre = [a, b, c].filter(Boolean).join(" ");
    if (!nombre) continue;
    casos++;
    const r = resolverGrifo({ nombre }, CAT);
    if (r.por === "nombre") {
      // Si se nombró por nombre, la parte distintiva de esa razón social está en lo leído, por palabras.
      const g = grifoPorNombre(CAT, nombre);
      // (sobre el nombre normalizado: la forma societaria «S.A.» no cuenta como palabra, esté donde esté)
      const tokens = ` ${normEmpresa(nombre)} `;
      const clave = claveDistintiva(g?.nombre);
      if (!g || !clave || !tokens.includes(` ${clave} `)) { malos++; ejemplos.push(nombre); }
    }
    // Idempotencia: resolver lo ya resuelto no cambia nada.
    const otra = resolverGrifo({ nombre: r.nombre, ruc: r.ruc }, CAT);
    if (otra.nombre !== r.nombre) { malos++; ejemplos.push(`no idempotente: ${nombre}`); }
  }
  chk(`ningún nombre se reconoce sin su razón social completa, y es idempotente (${casos} nombres)`, malos === 0, ejemplos.slice(0, 3).join(" | "));
  // El corolario: el barrido sí reconoce (un motor que nunca reconociera cumpliría lo anterior).
  chk("y de verdad reconoce las redacciones de COESTI", resolverGrifo({ nombre: "COESTI S.A." }, CAT).por === "nombre");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
