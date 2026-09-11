// ¿Se puede medir el consumo de una unidad BICOMBUSTIBLE con los datos que ya tiene este ERP?
// Solo LEE: no escribe nada, no propone nada, no toca la base.
//
// LA IDEA QUE VIENE A COMPROBAR
//
// El odómetro no sabe de qué tanque salieron los km, así que un km/gal por combustible no se
// puede medir en una unidad bicombustible — eso no tiene arreglo. Pero mirando la fórmula del
// ERP (lib/costeo-propio.ts:134-137):
//
//     S/km combustible = (precio₁ / rendimiento₁) × pct_uso₁ + (precio₂ / rendimiento₂) × pct_uso₂
//
// los dos parámetros NUNCA entran por separado: solo como el cociente `pct_uso_f / rendimiento_f`.
// Y ese cociente es, exactamente, GALONES DE ESE COMBUSTIBLE POR KILÓMETRO:
//
//     km con el combustible f = pct_uso_f × K        (definición de pct_uso)
//     galones de f            = km con f / rendimiento_f
//     galones de f por km     = pct_uso_f / rendimiento_f      ← el término de la fórmula
//
// Eso SÍ se mide: los galones de cada familia están registrados (el voucher trae el producto y
// el registro manual obliga a elegirlo) y los km están en el delta del odómetro. O sea: el ERP
// estaba pidiendo dos números que no puede medir para calcular uno que sí.
//
// Y tiene una segunda virtud que importa más en esta flota que la primera: **solo necesita
// odómetro en los DOS EXTREMOS de la ventana**. Una carga sin kilometraje en el medio cuenta
// sus galones igual y sus km están dentro del delta — mientras que el km/gal de hoy necesita
// odómetro en las dos cargas de CADA tramo, que es por lo que unidades enteras no miden nada.
//
// LA CONVENCIÓN, que es la misma de un tramo: la carga que CIERRA repone lo que se quemó, así
// que los galones de la ventana son los de las cargas en `(inicio, fin]`. Con una sola familia y
// una sola pareja de cargas, este número es exactamente el km/gal de siempre, invertido.
//
// USO
//     npx tsx scripts/diagnostico-consumo.mts
//     npx tsx scripts/diagnostico-consumo.mts 2026-01-01     (desde esa fecha)
//
// LO QUE CONTESTA
//   1 · SALUD DEL HISTÓRICO DE TIPOS. Es la precondición: si hay GLP guardado como diésel, el
//       reparto por familia nace contaminado y no hay que construir nada encima todavía.
//   2 · Qué unidades son BICOMBUSTIBLE de verdad, derivado de sus cargas.
//   3 · El consumo medido por (unidad, familia), con su cobertura y sus km.
//   4 · Contra el PARÁMETRO: consumo tecleado vs medido, y lo que mueve en soles.
//   5 · CUÁNTO SE RECUPERA: los tramos que el km/gal descarta hoy y que esta ventana sí usa.
//   6 · El veredicto: ¿se puede construir sobre esto, o primero hay que limpiar?
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const REND = requerir("../lib/rendimiento") as typeof import("../lib/rendimiento");
const CT = requerir("../lib/combustible-tipos") as typeof import("../lib/combustible-tipos");
const TIPO = requerir("../lib/costos/rendimiento-tipo") as typeof import("../lib/costos/rendimiento-tipo");

const { seriesRendimiento, normalizarCantidad, techoDeFamilia, labelDeFamilia, KM_DIA_MAX } = REND;
const { familiaCombustible, COMBUSTIBLES } = CT;
const { familiaDeParametro } = TIPO;

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const DESDE = process.argv[2] ?? "2000-01-01";

async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let d = 0; ; d += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${d}-${d + 999}`, "Range-Unit": "items" } });
    if (!r.ok) throw new Error(`${ruta} → ${r.status} ${await r.text()}`);
    const filas = (await r.json()) as any[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}

const n1 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const n0 = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
const dias = (a: string, b: string) =>
  Math.max(1, Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000));

// ── Datos ───────────────────────────────────────────────────────────────────

const cargas = await traer(
  `combustible?select=id,vehiculo_id,vehiculo_tercero_id,fecha,kilometraje,galones,precio_galon,total,tipo_combustible,unidad&fecha=gte.${DESDE}&order=fecha.asc`
);
const propios = await traer("vehiculos?select=id,placa,categoria,tipo_vehiculo_costeo");
const terceros = await traer("vehiculos_tercero?select=id,placa,categoria,tipo_vehiculo_costeo");
const params = await traer("parametros_costos?select=*&activo=eq.true");
const preciosRef: Record<string, number> = {};
for (const p of await traer("precios_combustible?select=tipo,precio")) preciosRef[p.tipo] = Number(p.precio);

type Uni = { placa: string; categoria: string | null; tipo: string | null; flota: "propia" | "tercero" };
const unidades = new Map<string, Uni>();
for (const v of propios) unidades.set(`p${v.id}`, { placa: v.placa, categoria: v.categoria, tipo: v.tipo_vehiculo_costeo, flota: "propia" });
for (const v of terceros) unidades.set(`t${v.id}`, { placa: v.placa, categoria: v.categoria, tipo: v.tipo_vehiculo_costeo, flota: "tercero" });

const uid = (r: any) => (r.vehiculo_tercero_id != null ? `t${r.vehiculo_tercero_id}` : r.vehiculo_id != null ? `p${r.vehiculo_id}` : "");
const placa = (u: string) => unidades.get(u)?.placa ?? u ?? "(sin unidad)";

console.log(`\nCONSUMO POR KILÓMETRO · ¿se puede medir una unidad bicombustible?`);
console.log(`${cargas.length} carga(s) desde ${DESDE} · ${unidades.size} unidad(es) · ${params.length} tipo(s) de costeo activo(s)`);

// ── 1 · SALUD DEL HISTÓRICO DE TIPOS ────────────────────────────────────────

linea("1 · SALUD DEL HISTÓRICO DE TIPOS  (la precondición)");
console.log("   Todo el reparto por familia descansa en que el tipo de cada carga sea el que se");
console.log("   despachó. `registrarCombustible` hacía `?? \"diesel\"` hasta hace poco, y en este ERP");
console.log("   ya apareció una carga de GLP de la CWQ400 guardada como DIÉSEL.\n");

let sinTipo = 0;
const sospechosas: { id: number; fecha: string; placa: string; tipo: string; precio: number; refSuya: number; mejor: string; refMejor: number }[] = [];
for (const c of cargas) {
  const t = String(c.tipo_combustible ?? "").trim();
  if (!t) { sinTipo++; continue; }
  const precio = Number(c.precio_galon) || 0;
  if (precio <= 0) continue;
  const fam = familiaCombustible(t);
  // El precio de referencia de CADA familia, con `precios_combustible` cuando está y el del
  // catálogo si no. Si el precio pagado se pega MUCHO más a otra familia que a la propia, el
  // tipo guardado es sospechoso. No decide nada: nombra la fila para que alguien la abra.
  const refDe = (f: string) => {
    const tipoCat = Object.keys(COMBUSTIBLES).find((k) => String(COMBUSTIBLES[k].familia) === f);
    const label = tipoCat ? COMBUSTIBLES[tipoCat].label : "";
    return preciosRef[label] ?? (tipoCat ? COMBUSTIBLES[tipoCat].precioRef : 0);
  };
  const familias = [...new Set(Object.values(COMBUSTIBLES).map((x) => String(x.familia)))].filter((f) => refDe(f) > 0);
  const dist = (f: string) => Math.abs(precio - refDe(f)) / refDe(f);
  const propia = familias.includes(fam) ? dist(fam) : 99;
  const mejor = familias.slice().sort((a, b) => dist(a) - dist(b))[0];
  // Umbral deliberadamente flojo: se está NOMBRANDO, no corrigiendo. Solo cuando la suya se va
  // más del 40 % y otra queda dentro del 10 % — la misma firma que usa `tipo_no_coincide_con_precio`.
  if (mejor !== fam && propia > 0.4 && dist(mejor) < 0.1) {
    sospechosas.push({ id: c.id, fecha: String(c.fecha).slice(0, 10), placa: placa(uid(c)), tipo: t, precio, refSuya: refDe(fam), mejor, refMejor: refDe(mejor) });
  }
}
console.log(`   Cargas sin tipo:                ${sinTipo}`);
console.log(`   Cargas con el precio de OTRA familia: ${sospechosas.length}`);
if (sospechosas.length) {
  console.log("");
  for (const s of sospechosas.slice(0, 25)) {
    console.log(`   #${String(s.id).padEnd(6)} ${s.fecha} ${s.placa.padEnd(10)} dice "${s.tipo}" a S/ ${n2(s.precio)}  ·  ${s.tipo} ref S/ ${n2(s.refSuya)} · ${s.mejor} ref S/ ${n2(s.refMejor)}`);
  }
  if (sospechosas.length > 25) console.log(`   … y ${sospechosas.length - 25} más`);
  console.log("\n   Se corrigen en /radar-ia?tab=combustible o en /combustible → Editar carga.");
}

// ── 2 · QUIÉN ES BICOMBUSTIBLE ──────────────────────────────────────────────

linea("2 · UNIDADES BICOMBUSTIBLE  (derivado de las cargas, no de ninguna ficha)");
const porUnidad = new Map<string, any[]>();
for (const c of cargas) {
  const u = uid(c);
  if (!u || !unidades.has(u)) continue;
  (porUnidad.get(u) ?? porUnidad.set(u, []).get(u)!).push(c);
}
type PorFam = { familia: string; n: number; gal: number; soles: number };
const familiasDe = (cs: any[]): PorFam[] => {
  const m = new Map<string, PorFam>();
  for (const c of cs) {
    const f = familiaCombustible(c.tipo_combustible);
    if (techoDeFamilia(f) === null) continue;          // aditivos: la urea no mueve el bus
    const q = normalizarCantidad(c.galones, c.unidad, f) ?? 0;
    const e = m.get(f) ?? { familia: f, n: 0, gal: 0, soles: 0 };
    e.n++; e.gal += q; e.soles += Number(c.total) || 0;
    m.set(f, e);
  }
  return [...m.values()].sort((a, b) => b.gal - a.gal);
};
const bicombustibles: string[] = [];
for (const [u, cs] of porUnidad) {
  const fams = familiasDe(cs).filter((f) => f.n > 0);
  if (fams.length < 2) continue;
  bicombustibles.push(u);
  const un = unidades.get(u)!;
  console.log(`   ${un.placa.padEnd(10)} (${un.flota}, ${un.categoria ?? "—"})  →  ${fams.map((f) => `${f.familia} ${f.n} carga(s) / ${n1(f.gal)}`).join("  ·  ")}`);
}
if (!bicombustibles.length) console.log("   Ninguna. Todas las unidades cargan una sola familia de combustible.");

// ── 3 · EL CONSUMO MEDIDO ───────────────────────────────────────────────────

type Ventana = {
  uid: string; desde: string; hasta: string; km: number; dias: number;
  porFamilia: PorFam[]; cargasDentro: number; sinOdometroDentro: number;
  anclas: number; descartadasPorKm: number;
};

/** La ventana más ancha que la unidad permite, saneando el odómetro por el camino. */
function ventanaDe(u: string, cs: any[]): Ventana | null {
  const ord = [...cs].sort(
    (a, b) => String(a.fecha).localeCompare(String(b.fecha)) || (Number(a.kilometraje) || 0) - (Number(b.kilometraje) || 0) || a.id - b.id
  );
  // ANCLAS: las cargas con odómetro utilizable. Se descarta la lectura que RETROCEDE o que
  // implica más de KM_DIA_MAX por día — el mismo criterio que ya usa el motor de rendimiento,
  // porque un km malo aquí falsea la ventana entera en vez de un solo tramo.
  const anclas: any[] = [];
  let descartadas = 0;
  for (const c of ord) {
    const km = Number(c.kilometraje) || 0;
    if (km <= 0) continue;
    const prev = anclas[anclas.length - 1];
    if (!prev) { anclas.push(c); continue; }
    const dk = km - (Number(prev.kilometraje) || 0);
    const dd = dias(String(prev.fecha).slice(0, 10), String(c.fecha).slice(0, 10));
    if (dk <= 0 || dk / dd > KM_DIA_MAX) { descartadas++; continue; }
    anclas.push(c);
  }
  if (anclas.length < 2) return null;
  const ini = anclas[0], fin = anclas[anclas.length - 1];
  const km = (Number(fin.kilometraje) || 0) - (Number(ini.kilometraje) || 0);
  if (km <= 0) return null;

  // Los galones de la ventana son los de las cargas en `(inicio, fin]`: la que cierra repone lo
  // que se quemó. Se recorre por POSICIÓN, no por km — así entran también las cargas sin
  // odómetro, que es justo lo que esta medición puede aprovechar y el km/gal no.
  const iIni = ord.indexOf(ini), iFin = ord.indexOf(fin);
  const dentro = ord.slice(iIni + 1, iFin + 1);
  return {
    uid: u,
    desde: String(ini.fecha).slice(0, 10), hasta: String(fin.fecha).slice(0, 10),
    km, dias: dias(String(ini.fecha).slice(0, 10), String(fin.fecha).slice(0, 10)),
    porFamilia: familiasDe(dentro),
    cargasDentro: dentro.length,
    sinOdometroDentro: dentro.filter((c) => !(Number(c.kilometraje) > 0)).length,
    anclas: anclas.length, descartadasPorKm: descartadas,
  };
}

linea("3 · EL CONSUMO MEDIDO  (galones por km, por familia)");
console.log("   `gal/km` es el número que la fórmula de costeo usa de verdad. Entre paréntesis, su");
console.log("   inverso, que es el km/gal APARENTE de esa familia: en una unidad de un solo");
console.log("   combustible es el rendimiento real; en una bicombustible NO lo es, porque el");
console.log("   odómetro incluye los km hechos con el otro tanque.\n");

const ventanas = new Map<string, Ventana>();
for (const [u, cs] of porUnidad) {
  const v = ventanaDe(u, cs);
  if (!v) continue;
  ventanas.set(u, v);
  const un = unidades.get(u)!;
  const bi = bicombustibles.includes(u);
  console.log(`   ${un.placa.padEnd(10)} ${bi ? "BICOMB." : "       "} ${v.desde} → ${v.hasta}  ${n0(v.km)} km en ${v.dias} d  ·  ${v.anclas} ancla(s)${v.descartadasPorKm ? ` · ${v.descartadasPorKm} km descartado(s)` : ""}`);
  for (const f of v.porFamilia) {
    const galKm = f.gal / v.km;
    console.log(`      ${f.familia.padEnd(10)} ${n4(galKm)} gal/km  (${n1(1 / galKm)} ${labelDeFamilia(f.familia)} aparente)  ·  ${n1(f.gal)} en ${f.n} carga(s)  ·  S/ ${n2(f.soles)}`);
  }
  const soles = v.porFamilia.reduce((s, f) => s + f.soles, 0);
  console.log(`      ${"TOTAL".padEnd(10)} S/ ${n4(soles / v.km)} por km de combustible${v.sinOdometroDentro ? `  ·  ${v.sinOdometroDentro} carga(s) sin odómetro DENTRO (entran igual)` : ""}`);
}
if (!ventanas.size) console.log("   Ninguna unidad tiene dos cargas con odómetro utilizable. No hay nada que medir todavía.");

// ── 4 · CONTRA EL PARÁMETRO ─────────────────────────────────────────────────

linea("4 · CONTRA EL PARÁMETRO TECLEADO");
console.log("   El parámetro codifica `pct_uso_f / rendimiento_f`, que ES gal/km. Se comparan");
console.log("   directamente, sin precios de por medio — así un combustible más caro no se lee");
console.log("   como si la unidad consumiera más.\n");

const porTipo = new Map<string, string[]>();
for (const [u, un] of unidades) {
  const t = String(un.tipo ?? "").trim();
  if (t && ventanas.has(u) && un.flota === "propia") (porTipo.get(t) ?? porTipo.set(t, []).get(t)!).push(u);
}
let tiposComparados = 0;
for (const p of params) {
  const us = porTipo.get(p.tipo_vehiculo);
  if (!us?.length) continue;
  tiposComparados++;
  const f1 = familiaDeParametro(p.tipo_combustible_1);
  const f2 = familiaDeParametro(p.tipo_combustible_2);
  const galKmParam1 = Number(p.rendimiento_1) > 0 ? Number(p.pct_uso_1 ?? 1) / Number(p.rendimiento_1) : null;
  const galKmParam2 = f2 && Number(p.rendimiento_2) > 0 ? Number(p.pct_uso_2 ?? 0) / Number(p.rendimiento_2) : null;
  console.log(`   ${p.nombre}  (${p.tipo_vehiculo})${p.tipo_combustible_2 ? "  · BIMODAL en la ficha" : ""}`);
  console.log(`      tecleado   ${f1 ?? "?"} ${galKmParam1 !== null ? `${n4(galKmParam1)} gal/km  (rend ${n2(Number(p.rendimiento_1))} × pct ${n2(Number(p.pct_uso_1 ?? 1))})` : "—"}` +
    (galKmParam2 !== null ? `   +   ${f2} ${n4(galKmParam2)} gal/km  (rend ${n2(Number(p.rendimiento_2))} × pct ${n2(Number(p.pct_uso_2))})` : ""));
  for (const u of us) {
    const v = ventanas.get(u)!;
    const medido = v.porFamilia.map((f) => `${f.familia} ${n4(f.gal / v.km)}`).join("  +  ");
    console.log(`      medido     ${placa(u).padEnd(10)} ${medido}   sobre ${n0(v.km)} km`);
    // El S/km con los precios de HOY, para las dos formas. Es la traducción a dinero.
    const solesParam =
      (galKmParam1 ?? 0) * (preciosRef[p.tipo_combustible_1] ?? 0) +
      (galKmParam2 ?? 0) * (preciosRef[p.tipo_combustible_2 ?? ""] ?? 0);
    const solesMedido = v.porFamilia.reduce((s, f) => {
      const tipoCat = Object.keys(COMBUSTIBLES).find((k) => COMBUSTIBLES[k].familia === f.familia);
      const label = tipoCat ? COMBUSTIBLES[tipoCat].label : "";
      return s + (f.gal / v.km) * (preciosRef[label] ?? (tipoCat ? COMBUSTIBLES[tipoCat].precioRef : 0));
    }, 0);
    const pct = solesParam > 0 ? ((solesMedido - solesParam) / solesParam) * 100 : 0;
    console.log(`      S/km comb. tecleado ${n4(solesParam)}  →  medido ${n4(solesMedido)}   (${pct > 0 ? "+" : ""}${pct.toFixed(1)} %, a precios de hoy)`);
  }
  console.log("");
}
if (!tiposComparados) console.log("   Ningún tipo de costeo tiene una unidad propia con ventana medible.");

// ── 5 · CUÁNTO SE RECUPERA ──────────────────────────────────────────────────

linea("5 · CUÁNTO SE RECUPERA FRENTE AL km/gal DE HOY");
console.log("   El motor actual descarta un tramo cuando cruza el otro combustible, cuando le falta");
console.log("   un odómetro o cuando el número sale imposible. Esta ventana usa todas esas cargas.\n");

const entrada = cargas
  .filter((c) => unidades.has(uid(c)))
  .map((c) => ({
    id: c.id, unidad: uid(c), fecha: String(c.fecha ?? "").slice(0, 10),
    kilometraje: c.kilometraje, cantidad: c.galones, unidadCantidad: c.unidad, tipo: c.tipo_combustible, gasto: c.total,
  }));
const series = seriesRendimiento(entrada as any);
const motivos = new Map<string, number>();
let tramosBuenos = 0, tramosTotal = 0;
for (const s of series.values()) {
  for (const t of s.tramos) {
    tramosTotal++;
    if (t.rendimiento !== null) { tramosBuenos++; continue; }
    motivos.set(t.motivo ?? "?", (motivos.get(t.motivo ?? "?") ?? 0) + 1);
  }
}
console.log(`   Tramos con número hoy: ${tramosBuenos} de ${tramosTotal}`);
for (const [m, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${m.padEnd(22)} ${n}`);
const conVentana = [...ventanas.keys()];
const conSerieConfiable = [...series.values()].filter((s) => s.resumen.confiable).map((s) => s.resumen.unidad);
const ganadas = conVentana.filter((u) => !conSerieConfiable.includes(u));
console.log(`\n   Unidades con medición CONFIABLE hoy (km/gal): ${new Set(conSerieConfiable).size}`);
console.log(`   Unidades con ventana medible (gal/km):        ${conVentana.length}`);
if (ganadas.length) console.log(`   Unidades que hoy NO miden y con esto sí: ${ganadas.map(placa).join(", ")}`);

// ── 6 · EL VEREDICTO ────────────────────────────────────────────────────────

linea("6 · EL VEREDICTO");
const bloqueo = sinTipo > 0 || sospechosas.length > 0;
console.log(`   Unidades bicombustible: ${bicombustibles.length}`);
console.log(`   Unidades con ventana medible: ${ventanas.size} de ${porUnidad.size} con cargas`);
console.log(`   Tipos de costeo comparables: ${tiposComparados}`);
console.log("");
if (bloqueo) {
  console.log("   ⚠ PRIMERO HAY QUE LIMPIAR. Hay cargas sin tipo o con el precio de otra familia, y");
  console.log("     el reparto por familia descansa entero en ese campo. Medir ahora daría un número");
  console.log("     con pinta de bueno construido sobre un tipo equivocado — que es peor que no medir.");
} else {
  console.log("   ✓ El histórico de tipos está limpio: se puede construir el motor sobre esto.");
}
if (!bicombustibles.length) {
  console.log("");
  console.log("   Y ojo: sin ninguna unidad bicombustible, la propuesta para tipos BIMODALES no tiene");
  console.log("   a quién servir todavía. Lo que sí rinde igual es la robustez — medir unidades que");
  console.log("   hoy se quedan sin número por un odómetro que falta en medio de la cadena.");
}
console.log("");
