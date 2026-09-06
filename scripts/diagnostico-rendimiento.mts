// Qué le pasa al RENDIMIENTO (km/gal) de esta flota con los datos reales. Solo LEE: no
// escribe nada, no propone nada, no toca la base.
//
// POR QUÉ EXISTE
//
// lib/rendimiento.ts trae dos constantes que deciden qué se publica y qué se descarta:
// TECHO_FAMILIA (40 km/gal, 12 km/m³) y KM_DIA_MAX (1500). El 40 no se eligió —es el
// literal que lib/costeo-servicio.ts lleva en producción decidiendo el margen—, pero el de
// GNV sí es una estimación por equivalencia energética, y este repo mide sus umbrales antes
// de fijarlos (los 200 m de la agrupación de rutas están medidos, no elegidos).
//
// Y hay una segunda pregunta, más cara: `rendimientoMedido` (lib/costeo-servicio.ts) pasa a
// derivar del módulo compartido. Su número entra al presupuesto de cada servicio, así que
// antes de fusionar hay que ver PLACA POR PLACA si se movió y por qué. Eso es lo que
// imprime la sección 5, y revisarla es la condición de merge.
//
// USO
//     npx tsx scripts/diagnostico-rendimiento.mts
//     npx tsx scripts/diagnostico-rendimiento.mts 2026-01-01     (desde esa fecha)
//
// LO QUE CONTESTA
//
//   1 · Cómo rinde de verdad cada familia (p50, p90, p99, max) — para ver si el techo cae
//       donde tiene que caer o está recortando operación normal.
//   2 · Qué descartaría cada techo candidato, CON las filas nombradas, para poder abrir cada
//       una y decidir mirando el dato y no el percentil.
//   3 · Cuántas cargas no tienen odómetro y de qué unidades: son los eslabones saltados, y
//       son exactos. Es la lista de trabajo que convierte "—" en tramos medibles.
//   4 · Cuántas filas guardan LITROS en la columna `galones` (el inflado ×3.785).
//   5 · El diff de `rendimientoMedido`, viejo contra nuevo, con la causa de cada divergencia.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Mismo motivo que en diagnostico-agrupacion.mts: con `require` los símbolos se comprueban
// abajo y el script explica qué falta, en vez de morir con un SyntaxError de importación que
// manda a buscar el problema al sitio equivocado.
const requerir = createRequire(import.meta.url);
const REND = requerir("../lib/rendimiento") as typeof import("../lib/rendimiento");
const TIPOS = requerir("../lib/combustible-tipos") as typeof import("../lib/combustible-tipos");

const REQUERIDOS = ["serieRendimiento", "seriesRendimiento", "normalizarCantidad", "mediana"] as const;
const faltantes = REQUERIDOS.filter((n) => typeof (REND as any)[n] !== "function");
if (faltantes.length) {
  console.error(
    `\n  Tu copia de lib/rendimiento.ts no tiene: ${faltantes.join(", ")}.\n\n` +
    `  El script es más nuevo que el resto del árbol de trabajo. Pasa cuando se baja el\n` +
    `  script suelto con "git checkout <rama> -- scripts/…": eso trae UN archivo y deja\n` +
    `  lib/ como estaba.\n\n` +
    `  Cámbiate a la rama completa y vuelve a correrlo:\n\n` +
    `      git checkout claude/rendimiento-mejoras-5vgtle\n\n` +
    `  (si git se queja de cambios sin guardar, primero: git stash)\n`
  );
  process.exit(1);
}

const { serieRendimiento, seriesRendimiento, normalizarCantidad, mediana, TECHO_FAMILIA, KM_DIA_MAX } = REND;
const { familiaCombustible, COMBUSTIBLES } = TIPOS;

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const DESDE = process.argv[2] ?? "2000-01-01";

/** PostgREST corta en 1000 filas. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, {
      headers: { ...H, Range: `${desde}-${desde + 999}`, "Range-Unit": "items" },
    });
    if (!r.ok) throw new Error(`${ruta} → ${r.status} ${await r.text()}`);
    const filas = (await r.json()) as any[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}

const n1 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n0 = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });
const pctil = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];
};
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── Datos ───────────────────────────────────────────────────────────────────

const cargas = await traer(
  `combustible?select=id,vehiculo_id,vehiculo_tercero_id,fecha,kilometraje,galones,precio_galon,tipo_combustible,unidad,grifo,conductor&fecha=gte.${DESDE}&order=fecha.asc`
);
const propios = await traer("vehiculos?select=id,placa");
const terceros = await traer("vehiculos_tercero?select=id,placa");

const placa = new Map<string, string>();
for (const v of propios) placa.set(`p${v.id}`, v.placa);
for (const v of terceros) placa.set(`t${v.id}`, v.placa);

const uid = (r: any) =>
  r.vehiculo_tercero_id != null ? `t${r.vehiculo_tercero_id}` : r.vehiculo_id != null ? `p${r.vehiculo_id}` : "";
const nombre = (u: string) => placa.get(u) ?? u ?? "(sin unidad)";

console.log(`\nRENDIMIENTO · datos reales desde ${DESDE}`);
console.log(`${cargas.length} carga(s) de combustible · ${placa.size} unidad(es) en la flota`);
console.log(`Techos vigentes: ${JSON.stringify(TECHO_FAMILIA)} · KM_DIA_MAX = ${KM_DIA_MAX}`);

const entrada = cargas.map((c) => ({
  id: c.id,
  unidad: uid(c),
  fecha: String(c.fecha ?? "").slice(0, 10),
  kilometraje: c.kilometraje,
  cantidad: c.galones,
  unidadCantidad: c.unidad,
  tipo: c.tipo_combustible,
}));
const series = seriesRendimiento(entrada);
const porId = new Map(cargas.map((c) => [c.id, c]));

// ── 1 · Distribución por familia ────────────────────────────────────────────

linea("1 · CÓMO RINDE DE VERDAD CADA FAMILIA");
console.log("   El techo debería quedar MUY por encima del p99: si lo roza, está recortando");
console.log("   operación normal y hay que subirlo.\n");

const porFamilia = new Map<string, number[]>();
for (const s of series.values()) {
  const arr = porFamilia.get(s.resumen.familia) ?? [];
  for (const t of s.tramos) if (t.rendimiento !== null) arr.push(t.rendimiento);
  porFamilia.set(s.resumen.familia, arr);
}
// Los crudos descartados también interesan: son los que el techo dejó fuera.
const crudosPorFamilia = new Map<string, { v: number; id: number; unidad: string; fecha: string }[]>();
for (const s of series.values()) {
  const arr = crudosPorFamilia.get(s.resumen.familia) ?? [];
  for (const t of s.tramos) if (t.crudo !== null) arr.push({ v: t.crudo, id: t.cargaId, unidad: t.unidad, fecha: t.fecha });
  crudosPorFamilia.set(s.resumen.familia, arr);
}

console.log("   familia      n     p50     p90     p99     max   techo");
for (const [fam, xs] of [...porFamilia].sort()) {
  if (!xs.length && !(crudosPorFamilia.get(fam) ?? []).length) continue;
  const techo = TECHO_FAMILIA[fam];
  console.log(
    `   ${fam.padEnd(11)}${String(xs.length).padStart(3)}  ` +
    `${n1(pctil(xs, 0.5)).padStart(6)}  ${n1(pctil(xs, 0.9)).padStart(6)}  ` +
    `${n1(pctil(xs, 0.99)).padStart(6)}  ${n1(xs.length ? Math.max(...xs) : 0).padStart(6)}  ` +
    `${techo === null ? "  (aditivo)" : String(techo).padStart(6)}`
  );
  if (xs.length && techo !== null && Math.max(...xs) > techo * 0.9) {
    console.log(`      ⚠  el máximo publicado roza el techo: revisa si el techo está bajo`);
  }
}

// ── 2 · Qué descartaría cada techo candidato ────────────────────────────────

linea("2 · QUÉ DESCARTARÍA CADA TECHO CANDIDATO");
console.log("   Abre las filas nombradas y decide mirando el dato, no el percentil.\n");

const CANDIDATOS: Record<string, number[]> = { galones: [35, 40, 45, 60], m3: [8, 12, 15, 20] };
for (const [fam, crudos] of [...crudosPorFamilia].sort()) {
  if (TECHO_FAMILIA[fam] === null) continue;
  const tipoRef = Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === fam);
  const unid = tipoRef ? COMBUSTIBLES[tipoRef].unidad : "galones";
  const cands = CANDIDATOS[unid === "m3" ? "m3" : "galones"];
  const todos = [...(porFamilia.get(fam) ?? []), ...crudos.map((c) => c.v)];
  if (!todos.length) continue;
  console.log(`   ${fam} (${todos.length} tramos con número):`);
  for (const c of cands) {
    const fuera = todos.filter((v) => v > c).length;
    console.log(`      techo ${String(c).padStart(3)} → descarta ${String(fuera).padStart(3)} (${n1((fuera / todos.length) * 100)} %)${c === TECHO_FAMILIA[fam] ? "   ← el vigente" : ""}`);
  }
  const fueraDelVigente = crudos.filter((c) => c.v > (TECHO_FAMILIA[fam] as number)).sort((a, b) => b.v - a.v);
  if (fueraDelVigente.length) {
    console.log(`      las que descarta el vigente:`);
    for (const f of fueraDelVigente.slice(0, 25)) {
      const c = porId.get(f.id);
      console.log(`        ${f.fecha}  ${nombre(f.unidad).padEnd(10)} ${n1(f.v).padStart(9)}  km=${n0(Number(c?.kilometraje ?? 0)).padStart(9)}  ${n1(Number(c?.galones ?? 0))} ${c?.unidad ?? ""}  ${c?.grifo ?? ""}`);
    }
    if (fueraDelVigente.length > 25) console.log(`        … y ${fueraDelVigente.length - 25} más`);
  }
  console.log("");
}

// ── 3 · Cargas sin odómetro ─────────────────────────────────────────────────

linea("3 · CARGAS SIN ODÓMETRO (los eslabones saltados)");
console.log("   Cada una rompe el tramo que la contiene. Es una lista de trabajo: ponerles");
console.log("   el kilometraje convierte esos '—' en tramos medibles.\n");

const sinKm = cargas.filter((c) => !Number(c.kilometraje));
console.log(`   ${sinKm.length} de ${cargas.length} cargas (${n1((sinKm.length / Math.max(1, cargas.length)) * 100)} %)`);
if (sinKm.length) {
  const porUnidad = new Map<string, number>();
  for (const c of sinKm) porUnidad.set(uid(c), (porUnidad.get(uid(c)) ?? 0) + 1);
  for (const [u, n] of [...porUnidad].sort((a, b) => b[1] - a[1])) {
    const total = cargas.filter((c) => uid(c) === u).length;
    console.log(`      ${nombre(u).padEnd(10)} ${String(n).padStart(3)} de ${String(total).padStart(3)}`);
  }
  const soles = sinKm.reduce((s, c) => s + Number(c.galones || 0) * Number(c.precio_galon || 0), 0);
  console.log(`   Combustible que no entra a ninguna medición: S/ ${n1(soles)}`);
}

let tramosRotosPorHueco = 0;
for (const s of series.values()) tramosRotosPorHueco += s.tramos.filter((t) => t.motivo === "eslabon_saltado").length;
console.log(`   Tramos que quedan sin medir por ese motivo: ${tramosRotosPorHueco}`);

// ── 4 · Litros en la columna galones ────────────────────────────────────────

linea("4 · CANTIDADES EN OTRA UNIDAD");
console.log("   El Radar guarda litros en `combustible.galones` con unidad='litros'. Sin");
console.log("   normalizar, esas filas dan un km/gal inflado ×3.785 rotulado 'km/gal'.\n");

const raras = cargas.filter((c) => {
  const fam = familiaCombustible(c.tipo_combustible);
  const tipoRef = Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === fam);
  const esperada = tipoRef ? COMBUSTIBLES[tipoRef].unidad : "galones";
  const dada = String(c.unidad ?? "").trim().toLowerCase();
  return dada && dada !== esperada;
});
console.log(`   ${raras.length} carga(s) con unidad distinta a la de su familia`);
for (const c of raras.slice(0, 20)) {
  const fam = familiaCombustible(c.tipo_combustible);
  const conv = normalizarCantidad(c.galones, c.unidad, fam);
  console.log(
    `      ${String(c.fecha).slice(0, 10)}  ${nombre(uid(c)).padEnd(10)} ${c.tipo_combustible ?? "?"} · ` +
    `${n1(Number(c.galones))} ${c.unidad} → ${conv === null ? "NO CONVERTIBLE" : `${n1(conv)} (unidad de la familia)`}`
  );
}
if (raras.length > 20) console.log(`      … y ${raras.length - 20} más`);

// ── 5 · El diff de rendimientoMedido — LA CONDICIÓN DE MERGE ────────────────

linea("5 · rendimientoMedido · VIEJO vs NUEVO, placa por placa");
console.log("   Este número entra al presupuesto de cada servicio (lib/costeo-servicio.ts).");
console.log("   Revisar esta lista es la condición de merge del paso 6 del plan.\n");

/** El bucle de lib/costeo-servicio.ts:106-130, copiado LITERAL. No se reescribe. */
function rendimientoMedidoViejo(filasCrudas: any[], tope = 8): { kmGal: number; cargas: number } | null {
  const data = [...filasCrudas]
    .sort((a, b) => Number(b.kilometraje) - Number(a.kilometraje))
    .slice(0, tope + 1);
  const filas = data.filter((r) => Number(r.kilometraje) > 0 && Number(r.galones) > 0);
  if (filas.length < 2) return null;
  const rend: number[] = [];
  for (let i = 0; i < filas.length - 1; i++) {
    const km = Number(filas[i].kilometraje) - Number(filas[i + 1].kilometraje);
    const gal = Number(filas[i].galones);
    if (km > 0 && gal > 0 && km / gal < 40) rend.push(km / gal);
  }
  const m = mediana(rend);
  return m ? { kmGal: Math.round(m * 100) / 100, cargas: rend.length } : null;
}

let movidas = 0;
let iguales = 0;
for (const v of propios) {
  const suyas = cargas.filter((c) => c.vehiculo_id === v.id);
  if (suyas.length < 2) continue;

  const viejo = rendimientoMedidoViejo(suyas);
  // El nuevo: una sola familia (la mayoritaria de esa placa) y orden cronológico.
  const fams = new Map<string, number>();
  for (const c of suyas) {
    const f = familiaCombustible(c.tipo_combustible);
    if (TECHO_FAMILIA[f] !== null) fams.set(f, (fams.get(f) ?? 0) + 1);
  }
  const famPrincipal = [...fams].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!famPrincipal) continue;
  const deLaFamilia = suyas
    .filter((c) => familiaCombustible(c.tipo_combustible) === famPrincipal)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
    .slice(0, 9);
  const s = serieRendimiento(
    deLaFamilia.map((c) => ({
      id: c.id, unidad: `p${v.id}`, fecha: String(c.fecha).slice(0, 10),
      kilometraje: c.kilometraje, cantidad: c.galones, unidadCantidad: c.unidad, tipo: c.tipo_combustible,
    }))
  );
  const nuevo = s.resumen.mediana === null ? null : { kmGal: Math.round(s.resumen.mediana * 100) / 100, cargas: s.resumen.n };

  const a = viejo?.kmGal ?? null;
  const b = nuevo?.kmGal ?? null;
  if (a === b) { iguales++; continue; }
  movidas++;

  // Las cinco causas posibles, cada una nombrada.
  const causas: string[] = [];
  const familiasDistintas = new Set(suyas.slice(0, 9).map((c) => familiaCombustible(c.tipo_combustible)));
  if (familiasDistintas.size > 1) causas.push(`mezclaba ${[...familiasDistintas].join("+")}`);
  if (deLaFamilia.some((c) => { const f = familiaCombustible(c.tipo_combustible); const tr = Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === f); const esp = tr ? COMBUSTIBLES[tr].unidad : "galones"; const d = String(c.unidad ?? "").toLowerCase(); return d && d !== esp; })) causas.push("hay cantidades en otra unidad");
  if (s.resumen.cargasSinOdometro) causas.push(`${s.resumen.cargasSinOdometro} carga(s) sin odómetro`);
  if (s.tramos.some((t) => t.motivo === "eslabon_saltado")) causas.push("tramo(s) con eslabón saltado");
  if (s.tramos.some((t) => t.motivo === "odometro_retrocede")) causas.push("el odómetro retrocede en algún punto");
  if (s.tramos.some((t) => t.motivo === "implausible")) causas.push("tramo(s) implausibles descartados");
  const ordenViejo = [...suyas].sort((x, y) => Number(y.kilometraje) - Number(x.kilometraje)).slice(0, 9).map((c) => c.id).join();
  const ordenNuevo = deLaFamilia.map((c) => c.id).join();
  if (ordenViejo !== ordenNuevo && !causas.length) causas.push("la ventana de 9 cargas cambia al ordenar por fecha");

  console.log(
    `   ${v.placa.padEnd(10)} ${(a === null ? "—" : n1(a)).padStart(7)} → ${(b === null ? "—" : n1(b)).padStart(7)} km/gal` +
    `   (${viejo?.cargas ?? 0} → ${nuevo?.cargas ?? 0} tramos)`
  );
  console.log(`      ${causas.length ? causas.join(" · ") : "SIN CAUSA IDENTIFICADA — revisar a mano antes de fusionar"}`);
}

console.log(`\n   ${iguales} placa(s) con el mismo número · ${movidas} movida(s)`);
if (movidas) {
  console.log(`\n   ⚠  Antes de fusionar el paso 6 (lib/costeo-servicio.ts): abrir cada placa movida`);
  console.log(`      y confirmar que el número nuevo es el correcto. Cada causa de arriba es un`);
  console.log(`      arreglo, pero el margen de los presupuestos nuevos se mueve con ella.`);
} else {
  console.log(`\n   Ninguna placa se mueve: el paso 6 es seguro tal cual.`);
}

console.log("");
