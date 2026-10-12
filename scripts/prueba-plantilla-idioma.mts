// Pruebas del IDIOMA de las plantillas de WhatsApp (lib/plantilla-idioma.ts) y de las plantillas que
// el ERP ofrece crear en Meta (lib/plantillas-sugeridas.ts). NO toca la base ni envía nada.
// Uso:  npx tsx scripts/prueba-plantilla-idioma.mts   (sale con código 1 si algo falla)
//
// EL CASO (11-10-2026): «🧪 Probar los avisos» dio «(#132001) Template name does not exist in the
// translation» en los 8 WhatsApp. En la cuenta de avisos tres plantillas no existían y una
// (conductor_proximo_inicio) estaba registrada en INGLÉS con el texto en español.
//
// LO QUE NO SE PUEDE AFLOJAR:
//   · el camino normal no cambia: una plantilla en «es» sale en UN envío, sin consultar nada;
//   · solo se reintenta con una traducción APROBADA, y una sola vez;
//   · sin poder consultar la lista, queda el error ORIGINAL de Meta (no se afirma lo que no se sabe);
//   · un error que no es 132001 pasa tal cual;
//   · cada plantilla sugerida tiene tantas variables como parámetros le manda el motor.

import {
  IDIOMA_POR_DEFECTO, TTL_IDIOMA_MS, decidirIdioma, enviarConIdiomaCorrecto, esFaltaDePlantilla, motivoPlantilla,
  type IdiomaEnMeta, type MemoIdiomas,
} from "../lib/plantilla-idioma";
import {
  SUGERIDAS_ESCALERA, SUGERIDA_COORDINADOR_ALERTA, SUGERIDA_NO_INICIO, SUGERIDA_RECUERDA_INICIAR,
  problemasDePlantilla, variablesDe, type PlantillaSugerida,
} from "../lib/plantillas-sugeridas";
import { datosDeMuestra, planDeMuestra, type CfgMuestra } from "../lib/escalera-muestra";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const ERROR_META = "(#132001) Template name does not exist in the translation";

// ── 1. Reconocer el error ────────────────────────────────────────────────────────────────
console.log("\n1. ¿Es el 132001?");
chk("el mensaje real de Meta", esFaltaDePlantilla(ERROR_META));
chk("sin almohadilla", esFaltaDePlantilla("error 132001: template"));
chk("otro código no", !esFaltaDePlantilla("(#131026) Message undeliverable"));
chk("un número que lo contiene no", !esFaltaDePlantilla("(#1320015) otra cosa"));
chk("no-texto no", !esFaltaDePlantilla(undefined) && !esFaltaDePlantilla(132001));

// ── 2. Qué idioma usar ───────────────────────────────────────────────────────────────────
console.log("\n2. decidirIdioma");
const A = (codigo: string, estado = "APPROVED"): IdiomaEnMeta => ({ codigo, estado });
{
  const d = decidirIdioma([A("en")]);
  chk("caso real: conductor_proximo_inicio solo en inglés → usar «en»", d.tipo === "usar" && d.codigo === "en", JSON.stringify(d));
}
chk("lista vacía → no_existe", decidirIdioma([]).tipo === "no_existe");
chk("entradas sin código → no_existe", decidirIdioma([{ codigo: "", estado: "APPROVED" }]).tipo === "no_existe");
{
  const d = decidirIdioma([A("es", "PENDING"), A("en", "rejected")]);
  chk("ninguna aprobada → no_aprobada con sus estados", d.tipo === "no_aprobada" && JSON.stringify(d.estados) === '["PENDING","REJECTED"]', JSON.stringify(d));
}
chk("es + en → es", (() => { const d = decidirIdioma([A("en"), A("es")]); return d.tipo === "usar" && d.codigo === "es"; })());
chk("es_MX gana a en", (() => { const d = decidirIdioma([A("en"), A("es_MX")]); return d.tipo === "usar" && d.codigo === "es_MX"; })());
chk("es en revisión + en aprobada → en", (() => { const d = decidirIdioma([A("es", "PENDING"), A("en")]); return d.tipo === "usar" && d.codigo === "en"; })());
{
  // El orden en que Meta devuelve la lista no decide.
  const a = decidirIdioma([A("pt_BR"), A("en"), A("fr")]);
  const b = decidirIdioma([A("fr"), A("pt_BR"), A("en")]);
  chk("el orden de la lista no decide", JSON.stringify(a) === JSON.stringify(b) && a.tipo === "usar" && a.codigo === "en", JSON.stringify([a, b]));
}
chk("el estado se lee sin importar mayúsculas", (() => { const d = decidirIdioma([A("en", "approved")]); return d.tipo === "usar" && d.codigo === "en"; })());

// ── 3. El motivo, en castellano ──────────────────────────────────────────────────────────
console.log("\n3. motivoPlantilla");
{
  const m = motivoPlantilla("coordinador_alerta", { tipo: "no_existe" }, "es");
  chk("no existe: nombra la plantilla y dónde se crea", m.includes("«coordinador_alerta»") && m.includes("Crear plantilla nueva") && m.includes("#132001"), m);
}
{
  const m = motivoPlantilla("x", { tipo: "no_aprobada", estados: ["PENDING"] }, "es");
  chk("no aprobada: dice «en revisión»", m.includes("en revisión") && m.includes("no aprobada"), m);
}
{
  const m = motivoPlantilla("x", { tipo: "usar", codigo: "es" }, "es");
  chk("aprobada en el mismo idioma: apunta al NÚMERO, no a la plantilla", m.includes("número") && !m.includes("Crear plantilla"), m);
}

// ── 4. El envío ──────────────────────────────────────────────────────────────────────────
console.log("\n4. enviarConIdiomaCorrecto");
type Llamadas = { envios: string[]; consultas: number };
function falsoMeta(aprobadoEn: string[] | null, opts: { consultaLanza?: boolean; error?: string } = {}) {
  const ll: Llamadas = { envios: [], consultas: 0 };
  const enviar = async (idioma: string) => {
    ll.envios.push(idioma);
    if (opts.error) throw new Error(opts.error);
    if (aprobadoEn && aprobadoEn.includes(idioma)) return `wamid.${idioma}`;
    throw new Error(ERROR_META);
  };
  const consultar = async () => {
    ll.consultas++;
    if (opts.consultaLanza) throw new Error("red caída");
    if (aprobadoEn === null) return null;
    return aprobadoEn.map((c) => A(c));
  };
  return { ll, enviar, consultar };
}
const T0 = 1_760_000_000_000;

{
  const memo: MemoIdiomas = new Map();
  const f = falsoMeta(["es"]);
  const r = await enviarConIdiomaCorrecto({ plantilla: "p", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 });
  chk("en «es»: un solo envío y ninguna consulta", r === "wamid.es" && f.ll.envios.join() === "es" && f.ll.consultas === 0, JSON.stringify(f.ll));
  chk("en «es»: no se recuerda nada", memo.size === 0);
}
{
  const memo: MemoIdiomas = new Map();
  const f = falsoMeta(["en"]);
  const r = await enviarConIdiomaCorrecto({ plantilla: "conductor_proximo_inicio", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 });
  chk("solo en inglés: reintenta en «en» y sale", r === "wamid.en" && f.ll.envios.join() === "es,en" && f.ll.consultas === 1, JSON.stringify(f.ll));
  chk("lo recuerda con su vencimiento", memo.get("conductor_proximo_inicio")?.codigo === "en" && memo.get("conductor_proximo_inicio")?.hasta === T0 + TTL_IDIOMA_MS);
  // Segundo destinatario: directo en inglés, sin el intento fallido.
  const r2 = await enviarConIdiomaCorrecto({ plantilla: "conductor_proximo_inicio", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 + 60_000 });
  chk("el siguiente va directo en «en»", r2 === "wamid.en" && f.ll.envios.join() === "es,en,en" && f.ll.consultas === 1, JSON.stringify(f.ll));
  // Pasada la hora, vuelve a probar «es» primero.
  const r3 = await enviarConIdiomaCorrecto({ plantilla: "conductor_proximo_inicio", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 + TTL_IDIOMA_MS + 1 });
  chk("vencido el recuerdo, vuelve a probar «es»", r3 === "wamid.en" && f.ll.envios.join() === "es,en,en,es,en" && f.ll.consultas === 2, JSON.stringify(f.ll));
}
{
  // El recuerdo quedó viejo: alguien la cambió a español en Meta.
  const memo: MemoIdiomas = new Map([["p", { codigo: "en", hasta: T0 + TTL_IDIOMA_MS }]]);
  const f = falsoMeta(["es"]);
  const r = await enviarConIdiomaCorrecto({ plantilla: "p", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 });
  chk("recuerdo viejo (en → es): consulta y sale en «es»", r === "wamid.es" && f.ll.envios.join() === "en,es", JSON.stringify(f.ll));
  chk("y recuerda el nuevo", memo.get("p")?.codigo === "es");
}
{
  const memo: MemoIdiomas = new Map();
  const f = falsoMeta([]);
  let msg = "";
  try { await enviarConIdiomaCorrecto({ plantilla: "coordinador_alerta", enviar: f.enviar, consultar: f.consultar, memo, ahoraMs: T0 }); }
  catch (e) { msg = (e as Error).message; }
  chk("no existe: el error lo dice en castellano", msg.includes("no existe") && msg.includes("«coordinador_alerta»"), msg);
  chk("no existe: un solo intento de envío", f.ll.envios.join() === "es", JSON.stringify(f.ll));
}
for (const [nombre, f] of [
  ["consulta devuelve null", falsoMeta(null)],
  ["consulta lanza", falsoMeta(["en"], { consultaLanza: true })],
] as const) {
  let msg = "";
  try { await enviarConIdiomaCorrecto({ plantilla: "p", enviar: f.enviar, consultar: f.consultar, memo: new Map(), ahoraMs: T0 }); }
  catch (e) { msg = (e as Error).message; }
  chk(`${nombre}: queda el error ORIGINAL de Meta`, msg === ERROR_META, msg);
  chk(`${nombre}: no reintenta`, f.ll.envios.join() === "es", JSON.stringify(f.ll));
}
{
  const f = falsoMeta(["es"], { error: "(#131026) Message undeliverable" });
  let msg = "";
  try { await enviarConIdiomaCorrecto({ plantilla: "p", enviar: f.enviar, consultar: f.consultar, memo: new Map(), ahoraMs: T0 }); }
  catch (e) { msg = (e as Error).message; }
  chk("otro error pasa tal cual, sin consultar", msg === "(#131026) Message undeliverable" && f.ll.consultas === 0, msg);
}
{
  // Aprobada en «es» y aun así 132001: el número que envía no es de esa cuenta.
  const ll: Llamadas = { envios: [], consultas: 0 };
  let msg = "";
  try {
    await enviarConIdiomaCorrecto({
      plantilla: "p",
      enviar: async (i) => { ll.envios.push(i); throw new Error(ERROR_META); },
      consultar: async () => { ll.consultas++; return [A("es")]; },
      memo: new Map(), ahoraMs: T0,
    });
  } catch (e) { msg = (e as Error).message; }
  chk("aprobada en «es» pero falla: apunta al número, sin reintentar", msg.includes("número") && ll.envios.join() === "es", msg);
}
{
  // El reintento también falla: se propaga ese error y no se recuerda el idioma.
  const memo: MemoIdiomas = new Map();
  let msg = "";
  try {
    await enviarConIdiomaCorrecto({
      plantilla: "p",
      enviar: async (i) => { throw new Error(i === "en" ? "(#131047) Re-engagement message" : ERROR_META); },
      consultar: async () => [A("en")],
      memo, ahoraMs: T0,
    });
  } catch (e) { msg = (e as Error).message; }
  chk("si el reintento falla, no se recuerda el idioma", msg.includes("131047") && memo.size === 0, msg);
}
chk("el idioma por defecto es «es»", IDIOMA_POR_DEFECTO === "es");

// ── 5. Las plantillas sugeridas: Meta no las rechazaría ─────────────────────────────────
console.log("\n5. Plantillas sugeridas");
for (const p of SUGERIDAS_ESCALERA) {
  const probs = problemasDePlantilla(p);
  chk(`${p.name}: sin problemas para Meta`, probs.length === 0, probs.join("; "));
}
{
  const mala: PlantillaSugerida = { ...SUGERIDA_NO_INICIO, body: "{{1}} hola {{2}}{{3}} fin {{5}}", ejemplos: ["a", "b\nc"], botonUrl: "transportesafa.com", botonTexto: "" };
  const probs = problemasDePlantilla(mala);
  for (const esperado of ["empieza con una variable", "termina en una variable", "dos variables pegadas", "variables con salto", "ejemplo(s)", "salto de línea", "sin http", "botón a medias"]) {
    chk(`detecta «${esperado}»`, probs.some((x) => x.includes(esperado)), probs.join("; "));
  }
}
chk("variablesDe ordena y no repite", JSON.stringify(variablesDe("{{2}} a {{1}} b {{ 2 }}")) === "[1,2]");

// ── 6. Cada sugerida tiene tantas variables como parámetros le manda el motor ────────────
console.log("\n6. Variables = parámetros del motor");
const D = datosDeMuestra({ nombreUsuario: "Antonio Pérez", fecha: "2026-10-11", telContingencia: "+51 912 569 005" });
const cfgs: CfgMuestra[] = [
  { clave: "proximo_inicio", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 90, plantilla: "conductor_proximo_inicio", notifica_conductor: true, canal_conductor_whatsapp: true },
  { clave: "recuerda_iniciar", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 30, plantilla: "conductor_recuerda_iniciar", notifica_conductor: true, canal_conductor_whatsapp: true },
  { clave: "alerta_no_inicio_previa", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 25, plantilla: null, plantilla_directorio: null, notifica_conductor: false, contactos: 2, usa_directorio: true },
  { clave: "inicia_ahora", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 5, plantilla: "conductor_recuerda_iniciar", notifica_conductor: true, canal_conductor_whatsapp: true },
  { clave: "en_punto_sin_iniciar", activo: true, modo_tiempo: "evento", umbral: 10, plantilla: "conductor_recuerda_iniciar", plantilla_directorio: "coordinador_alerta", notifica_conductor: true, canal_conductor_whatsapp: true, contactos: 2 },
  { clave: "debio_iniciar", activo: true, modo_tiempo: "evento", umbral: 1, plantilla: "conductor_no_inicio", notifica_conductor: true, canal_conductor_whatsapp: true },
  { clave: "no_inicio", activo: true, modo_tiempo: "evento", umbral: 10, plantilla: "conductor_no_inicio", plantilla_directorio: "coordinador_alerta", notifica_conductor: true, canal_conductor_whatsapp: true, contactos: 2, usa_directorio: true },
];
const plan = planDeMuestra(cfgs, D);
const porNombre = new Map(SUGERIDAS_ESCALERA.map((p) => [p.name, p]));
let comparados = 0;
for (const m of plan) {
  if (!m.plantilla || !porNombre.has(m.plantilla)) continue;
  const sug = porNombre.get(m.plantilla)!;
  const vars = variablesDe(sug.body).length;
  comparados++;
  chk(`${m.id} → ${m.plantilla}: ${m.parametros.length} parámetro(s) = ${vars} variable(s)`, m.parametros.length === vars);
}
for (const p of [SUGERIDA_RECUERDA_INICIAR, SUGERIDA_NO_INICIO, SUGERIDA_COORDINADOR_ALERTA]) {
  chk(`la muestra usa ${p.name} al menos una vez`, plan.some((m) => m.plantilla === p.name));
}
chk("se compararon mensajes de verdad (no trivial)", comparados >= 5, String(comparados));

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodas las pruebas pasaron");
process.exit(fallos ? 1 : 0);
