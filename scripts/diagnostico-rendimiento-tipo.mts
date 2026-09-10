// Qué va a PROPONER la columna «Medido» de /configuracion/costos con los datos reales de esta
// flota. Solo LEE: no escribe nada, no aplica nada, no toca la base.
//
// POR QUÉ EXISTE, Y CUÁNDO HAY QUE CORRERLO
//
// El número que sale de aquí no se queda en una pantalla: en cuanto alguien pulse «Aplicar»,
// `parametros_costos.rendimiento_1` cambia y con él el costo por kilómetro de esa categoría en
// el Cotizador, en /cotizaciones y en el tarifario. Y como el margen se calcula sobre el
// PRECIO (`costo / (1 − margen)`, lib/costeo-propio.ts), un rendimiento más alto ABARATA el
// precio ofertado. Una propuesta equivocada no se descubre revisando código: se descubre
// cuando el servicio ya se prestó.
//
// Correrlo es la condición para APLICAR la primera propuesta, no para fusionar la pantalla:
// mientras nadie pulse el botón, esto no mueve ningún número. Lo que hay que buscar en la
// sección 3 no es que no haya cambios —el sentido de todo esto es que los haya— sino que cada
// uno sea explicable: una placa que mide lo que uno esperaría de esa unidad, con tramos
// suficientes, y un salto de S/km que se pueda defender delante de un cliente.
//
// USO
//     npx tsx scripts/diagnostico-rendimiento-tipo.mts
//
// LO QUE CONTESTA
//   1 · Qué mide cada tipo hoy, con su código y su motivo.
//   2 · Las propuestas: parámetro → medido, y cuánto mueve el S/km y el S/ por 100 km.
//   3 · EL VEREDICTO: cuánto se movería el costo si se aplicara todo, y qué mirar una por una.
//   4 · El puente roto: placas que apuntan a un tipo que no existe en `parametros_costos`.
//   5 · Las unidades propias SIN categoría de costeo: miden, y su medición no le sirve a nadie.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const FLOTA = requerir("../lib/costos/rendimiento-flota") as typeof import("../lib/costos/rendimiento-flota");
const TIPO = requerir("../lib/costos/rendimiento-tipo") as typeof import("../lib/costos/rendimiento-tipo");
const PAR = requerir("../lib/costos/parametros") as typeof import("../lib/costos/parametros");
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");

const { cargarPlacasMedidas } = FLOTA;
const { agregarPorTipo, etiquetaAgregado } = TIPO;
const { cargarProcedencias } = PAR;
const { costoKmDeParametro, componentesCostoKm } = CKM;

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function traerRango(ruta: string, desde: number, hasta: number): Promise<any[]> {
  const r = await fetch(`${URL}/rest/v1/${ruta}`, {
    headers: { ...H, Range: `${desde}-${hasta}`, "Range-Unit": "items" },
  });
  if (!r.ok) throw new Error(`${ruta} → ${r.status} ${await r.text()}`);
  return (await r.json()) as any[];
}
const traer = (ruta: string) => traerRango(ruta, 0, 999);

/**
 * Un cliente de mentira con la forma que usa el cargador, sobre REST plano.
 *
 * SE EJERCITA EL CARGADOR DE VERDAD, no una copia de su lógica: si esto midiera por su
 * cuenta, el diagnóstico diría una cosa y la pantalla otra — y el diagnóstico es justo lo que
 * se mira para decidir si la pantalla se puede fusionar.
 */
function consulta(tabla: string) {
  const q = { select: "*", filtros: [] as string[], orden: [] as string[], desde: 0, hasta: 999 };
  const ruta = () => {
    const p = [`select=${q.select}`, ...q.filtros];
    if (q.orden.length) p.push(`order=${q.orden.join(",")}`);
    return `${tabla}?${p.join("&")}`;
  };
  const api: any = {
    select(c: string) { q.select = c; return api; },
    eq(col: string, v: any) { q.filtros.push(`${col}=eq.${v}`); return api; },
    not(col: string, op: string, v: any) { q.filtros.push(`${col}=not.${op}.${v === null ? "null" : v}`); return api; },
    in(col: string, vs: any[]) { q.filtros.push(`${col}=in.(${vs.map((v) => `"${v}"`).join(",")})`); return api; },
    order(col: string, o?: { ascending?: boolean }) { q.orden.push(`${col}.${o?.ascending === false ? "desc" : "asc"}`); return api; },
    range(d: number, h: number) { q.desde = d; q.hasta = h; return api; },
    then(res: any, rej: any) {
      return traerRango(ruta(), q.desde, q.hasta).then((data) => res({ data, error: null }), rej);
    },
  };
  return api;
}
const sb = { from: (t: string) => consulta(t) };

const n2 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── Datos ───────────────────────────────────────────────────────────────────

const params = await traer("parametros_costos?select=*&activo=eq.true&order=grupo_vehiculo.asc");
const precios: Record<string, number> = {};
for (const c of await traer("precios_combustible?select=tipo,precio")) precios[c.tipo] = Number(c.precio);

const placas = await cargarPlacasMedidas(sb);
const procedencias = await cargarProcedencias(sb);
const agregados = agregarPorTipo(params as any, placas, procedencias);

console.log(`\nRENDIMIENTO MEDIDO POR TIPO · datos reales`);
console.log(`${params.length} tipo(s) activo(s) · ${placas.length} serie(s) de placa medidas · ${Object.keys(precios).length} precio(s) de combustible`);

// ── 1 · Qué mide cada tipo ──────────────────────────────────────────────────

linea("1 · QUÉ MIDE CADA TIPO HOY");
console.log("   El código es el que enruta la pantalla. Cada uno se arregla en otro sitio.\n");
for (const p of params) {
  const a = agregados.get(p.tipo_vehiculo);
  if (!a) continue;
  const num = a.medido !== null ? `${n2(a.medido)} ${a.label ?? ""}` : "—";
  console.log(
    `   ${String(p.tipo_vehiculo).padEnd(24)} tecleado ${String(n2(p.rendimiento_1)).padStart(7)}` +
    ` · medido ${num.padEnd(14)} · ${etiquetaAgregado(a.codigo).padEnd(24)}` +
    ` · vota(n) ${a.aportan.map((x) => x.placa).join(", ") || "nadie"}`
  );
  if (a.codigo !== "medido" && a.codigo !== "coincide") console.log(`      ↳ ${a.detalle}`);
}

// ── 2 · Las propuestas, en soles ────────────────────────────────────────────

linea("2 · LAS PROPUESTAS, EN SOLES");
const propuestas = params.filter((p: any) => agregados.get(p.tipo_vehiculo)?.proponible);
if (!propuestas.length) {
  console.log("   Ninguna. La pantalla no ofrecería ningún botón hoy.");
} else {
  console.log("   S/km calculado con la MISMA fórmula que la pantalla (lib/costos/costo-km-parametro.ts).\n");
  for (const p of propuestas) {
    const a = agregados.get(p.tipo_vehiculo)!;
    const antes = costoKmDeParametro(p, precios);
    const despues = costoKmDeParametro({ ...p, rendimiento_1: a.medido as number }, precios);
    const cA = componentesCostoKm(p, precios);
    const cD = componentesCostoKm({ ...p, rendimiento_1: a.medido as number }, precios);
    const pct = antes > 0 ? ((despues - antes) / antes) * 100 : 0;
    console.log(`   ${p.nombre}  (${p.tipo_vehiculo})`);
    console.log(`      rendimiento   ${n2(p.rendimiento_1)} → ${n2(a.medido as number)} ${a.label ?? ""}   (${a.desvio !== null ? (a.desvio > 0 ? "+" : "") + (a.desvio * 100).toFixed(1) : "?"} %)`);
    console.log(`      S/km comb.    ${n4(cA.combustible + cA.urea)} → ${n4(cD.combustible + cD.urea)}`);
    console.log(`      S/km total    ${n4(antes)} → ${n4(despues)}   (${pct > 0 ? "+" : ""}${pct.toFixed(1)} %)`);
    console.log(`      por 100 km    S/ ${n2(antes * 100)} → S/ ${n2(despues * 100)}`);
    console.log(`      evidencia     ${a.aportan.map((x) => `${x.placa} ${n2(x.mediana as number)} sobre ${x.tramos} tramos (${x.desde}→${x.hasta})`).join(" · ")}`);
    const desc = a.aportan.flatMap((x) => x.descartes);
    if (desc.length) console.log(`      descartado    ${desc.map((d) => `${d.fecha} ${d.crudo !== null ? d.crudo.toFixed(1) : "—"} ${d.codigo}`).join(" · ")}`);
    if (a.heredan.length) console.log(`      heredan       ${a.heredan.map((h) => h.placa).join(", ")}`);
    console.log("");
  }
}

// ── 3 · La condición de merge ───────────────────────────────────────────────

linea("3 · EL VEREDICTO · QUÉ REVISAR ANTES DE APLICAR");
{
  let sube = 0, baja = 0, peor = { tipo: "", pct: 0 };
  for (const p of propuestas) {
    const a = agregados.get(p.tipo_vehiculo)!;
    const antes = costoKmDeParametro(p, precios);
    const despues = costoKmDeParametro({ ...p, rendimiento_1: a.medido as number }, precios);
    const pct = antes > 0 ? ((despues - antes) / antes) * 100 : 0;
    if (pct > 0) sube++; else if (pct < 0) baja++;
    if (Math.abs(pct) > Math.abs(peor.pct)) peor = { tipo: p.tipo_vehiculo, pct };
  }
  const conNumero = [...agregados.values()].filter((a) => a.medido !== null).length;
  console.log(`   ${params.length} tipo(s) · ${conNumero} con número medido · ${propuestas.length} con propuesta aplicable`);
  console.log(`   Si se aplicaran TODAS: ${baja} tipo(s) abaratarían su S/km y ${sube} lo encarecerían.`);
  if (peor.tipo) console.log(`   El que más se movería: ${peor.tipo}, ${peor.pct > 0 ? "+" : ""}${peor.pct.toFixed(1)} % de S/km.`);
  console.log("");
  console.log("   NADA DE ESTO SE APLICA SOLO. La pantalla propone y una persona firma. Lo que hay");
  console.log("   que revisar aquí es que cada propuesta sea DEFENDIBLE: la placa que la sostiene,");
  console.log("   sus tramos y su ventana. Una propuesta que abarata el precio ofertado un 20 % con");
  console.log("   cinco tramos de una sola unidad es exactamente lo que no se puede fusionar a ciegas.");
  const flojas = propuestas.filter((p: any) => {
    const a = agregados.get(p.tipo_vehiculo)!;
    return a.aportan.some((x) => x.tramos < 8) || Math.abs(a.desvio ?? 0) > 0.35;
  });
  if (flojas.length) {
    console.log("");
    console.log("   ⚠ MIRAR UNA POR UNA (pocos tramos, o un desvío de más del 35 %):");
    for (const p of flojas) {
      const a = agregados.get(p.tipo_vehiculo)!;
      console.log(`      ${p.tipo_vehiculo}: ${a.aportan.map((x) => `${x.placa} ${x.tramos} tramos`).join(", ")} · desvío ${((a.desvio ?? 0) * 100).toFixed(0)} %`);
    }
  }
}

// ── 4 · El puente roto ──────────────────────────────────────────────────────

linea("4 · PLACAS QUE APUNTAN A UN TIPO QUE NO EXISTE");
{
  const claves = new Set(params.map((p: any) => p.tipo_vehiculo));
  const rotas = placas.filter((p) => p.tipoCosteo && !claves.has(p.tipoCosteo.trim()));
  if (!rotas.length) console.log("   Ninguna. El puente placa → tipo está entero.");
  else {
    console.log("   `tipo_vehiculo_costeo` es texto libre y sin FK. Estas unidades miden para nadie:\n");
    for (const p of rotas) console.log(`   ${p.placa.padEnd(10)} (${p.flota}) → "${p.tipoCosteo}"`);
    console.log("\n   Se arregla en la ficha de la unidad (/vehiculos o /tercerizadas → Categoría de costeo).");
  }
}

// ── 5 · Las propias sin categoría ───────────────────────────────────────────

linea("5 · UNIDADES PROPIAS SIN CATEGORÍA DE COSTEO");
{
  const todas = await traer("vehiculos?select=id,placa,tipo_vehiculo_costeo");
  const sinTipo = todas.filter((v: any) => !String(v.tipo_vehiculo_costeo ?? "").trim());
  if (!sinTipo.length) console.log("   Ninguna. Toda la flota propia apunta a un tipo.");
  else {
    console.log(`   ${sinTipo.length} unidad(es). Su rendimiento no alimenta ningún parámetro:\n`);
    for (const v of sinTipo) console.log(`   ${String(v.placa).padEnd(10)} (id ${v.id})`);
  }
}

console.log("");
