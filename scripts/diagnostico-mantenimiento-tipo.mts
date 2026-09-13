// Qué va a PROPONER la columna «Medido» de la categoría 🔧 Mantenimiento con los datos reales
// de esta flota, y qué dice el año de fabricación de las unidades sobre las fichas que las
// deprecian. Solo LEE: no escribe nada, no aplica nada, no toca la base.
//
// POR QUÉ EXISTE, Y CUÁNDO HAY QUE CORRERLO
//
// El número que sale de aquí no se queda en una pantalla: en cuanto alguien pulse «Aplicar»,
// `parametros_costos.mantenimiento_km` cambia y con él el costo por kilómetro de esa categoría
// en el Cotizador, en /cotizaciones y en el tarifario. Y como el margen se calcula sobre el
// PRECIO (`costo / (1 − margen)`, lib/costeo-propio.ts), un mantenimiento más caro SUBE el
// precio ofertado — al revés que el rendimiento, que lo abarataba.
//
// Correrlo es la condición para APLICAR la primera propuesta, no para fusionar la pantalla:
// mientras nadie pulse el botón, esto no mueve ningún número. Lo que hay que buscar en la
// sección 3 es la COBERTURA: un S/km medido sobre dos órdenes de trabajo y 4 000 km no describe
// nada, y el módulo lo dice, pero conviene verlo con los números de esta flota delante.
//
// USO
//     npx tsx scripts/diagnostico-mantenimiento-tipo.mts
//
// LO QUE CONTESTA
//   1 · Qué mide cada tipo hoy, con su código y su motivo.
//   2 · Las propuestas: parámetro → medido, y cuánto mueve el S/km y el S/ por 100 km.
//   3 · La COBERTURA del registro: cuántas órdenes entraron, cuántas quedaron fuera y por qué.
//       Es lo que dice si el número se puede defender o si lo que falta es registrar.
//   4 · LA EDAD DE LA FLOTA contra la ficha que la deprecia: qué categorías mezclan unidades
//       nuevas y usadas, que es exactamente lo que se resuelve duplicando la categoría.
//   5 · El puente roto: placas que apuntan a un tipo que no existe en `parametros_costos`, y
//       propias sin categoría de costeo (miden, y su medición no le sirve a nadie).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const FLOTA = requerir("../lib/costos/mantenimiento-flota") as typeof import("../lib/costos/mantenimiento-flota");
const MANT = requerir("../lib/costos/mantenimiento-tipo") as typeof import("../lib/costos/mantenimiento-tipo");
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");
const PAR = requerir("../lib/costos/parametros") as typeof import("../lib/costos/parametros");

const { cargarPlacasMantenimiento } = FLOTA;
const { agregarMantenimientoPorTipo, cotejarAntiguedadPorTipo, etiquetaMant, etiquetaAntiguedad, MIN_TRAMOS_MANT } = MANT;
const { costoKmDeParametro } = CKM;
const { cargarProcedenciasCostos } = PAR;

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
 * Un cliente de mentira con la forma que usa el cargador, sobre REST plano. SE EJERCITA EL
 * CARGADOR DE VERDAD: si esto midiera por su cuenta, el diagnóstico diría una cosa y la pantalla
 * otra — y el diagnóstico es justo lo que se mira para decidir si se aplica una propuesta.
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

const placas = await cargarPlacasMantenimiento(sb);
const proc = await cargarProcedenciasCostos(sb);
const agregados = agregarMantenimientoPorTipo(params as any, placas, proc.mantenimiento);
const edades = cotejarAntiguedadPorTipo(params as any, placas, new Date().getFullYear());

// ── 1 · Qué mide cada tipo ──────────────────────────────────────────────────

linea("1 · QUÉ MIDE CADA TIPO HOY");
for (const p of params) {
  const a = agregados.get(p.tipo_vehiculo);
  if (!a) continue;
  const med = a.medido !== null ? `${n2(a.medido)} S/km` : "—";
  console.log(
    `${p.tipo_vehiculo.padEnd(22)} tecleado ${n2(p.mantenimiento_km).padStart(6)} · medido ${med.padStart(12)} ` +
    `· ${etiquetaMant(a.codigo)}`
  );
  if (a.medido !== null) {
    console.log(`  ${" ".repeat(20)} evidencia: S/ ${n2(a.soles)} en ${a.km.toLocaleString("es-PE")} km · ${a.tramos} tramo(s)`);
  }
  // El estimado por plan se imprime SIEMPRE que exista, también cuando hay medición: es el único
  // sitio donde se ve cuánto del mantenimiento de esa categoría es servicio programado y cuánto
  // no. Nunca se propone — va rotulado para que no se confunda con el medido.
  if (a.plan) {
    console.log(
      `  ${" ".repeat(20)} plan del fabricante: ${n2(a.plan.soleskm)} S/km SOLO PROGRAMADO ` +
      `(servicio cada ${a.plan.intervaloKm.toLocaleString("es-PE")} km · ${a.plan.ots} preventiva(s) a S/ ${n2(a.plan.costoServicio)}) — no proponible`
    );
  }
  console.log(`  ${" ".repeat(20)} ${a.detalle.replace(/\n+/g, " ")}`);
}

// ── 2 · Las propuestas ──────────────────────────────────────────────────────

linea("2 · LAS PROPUESTAS (lo que el botón escribiría)");
const proponibles = params.filter((p: any) => agregados.get(p.tipo_vehiculo)?.proponible);
if (!proponibles.length) {
  console.log("Ninguna. Nada que aplicar hoy.");
} else {
  for (const p of proponibles) {
    const a = agregados.get(p.tipo_vehiculo)!;
    const antes = costoKmDeParametro(p as any, precios);
    const despues = costoKmDeParametro({ ...(p as any), mantenimiento_km: a.medido }, precios);
    console.log(
      `${p.tipo_vehiculo.padEnd(22)} ${n2(p.mantenimiento_km)} → ${n2(a.medido as number)} S/km ` +
      `(${a.desvio !== null ? `${a.desvio > 0 ? "+" : ""}${(a.desvio * 100).toFixed(0)} %` : "—"})`
    );
    console.log(
      `  ${" ".repeat(20)} costo total: S/ ${n4(antes)} → S/ ${n4(despues)} por km · ` +
      `S/ ${n2(antes * 100)} → S/ ${n2(despues * 100)} por cada 100 km`
    );
    console.log(`  ${" ".repeat(20)} mide: ${a.aportan.map((x) => x.placa).join(", ")}`);
  }
}

// ── 3 · La cobertura del registro ───────────────────────────────────────────

linea("3 · COBERTURA DEL REGISTRO DE MANTENIMIENTO (¿el número se puede defender?)");
console.log(`Mínimo para que una placa vote: ${MIN_TRAMOS_MANT} tramos (= ${MIN_TRAMOS_MANT + 1} órdenes con kilometraje).\n`);
const propias = placas.filter((p) => p.flota === "propia");
let otsTot = 0, otsDentro = 0, solesDentro = 0, solesFuera = 0;
for (const p of propias) {
  const r = p.serie.resumen;
  otsTot += p.otsTotales;
  otsDentro += r.ots;
  solesDentro += r.costo;
  solesFuera += r.costoFuera;
  const fueraPorMotivo = new Map<string, number>();
  for (const f of p.serie.fuera) fueraPorMotivo.set(f.motivo, (fueraPorMotivo.get(f.motivo) ?? 0) + f.costo);
  console.log(
    `${p.placa.padEnd(10)} ${String(p.otsTotales).padStart(3)} OT · ${String(r.tramos).padStart(2)} tramo(s) · ` +
    `${r.km.toLocaleString("es-PE").padStart(9)} km · S/ ${n2(r.costo).padStart(10)} · ` +
    `${r.soleskm !== null ? `${n2(r.soleskm)} S/km` : "sin medir"}${r.confiable ? "" : "  (no vota)"}`
  );
  if (fueraPorMotivo.size) {
    console.log(`  ${" ".repeat(8)} fuera: ${[...fueraPorMotivo].map(([m, s]) => `${m} S/ ${n2(s)}`).join(" · ")}`);
  }
  if (r.neumaticosOts) {
    console.log(`  ${" ".repeat(8)} ⚠ ${r.neumaticosOts} orden(es) por S/ ${n2(r.neumaticosCosto)} parecen compra de llantas`);
  }
}
console.log(
  `\nTOTAL propias: ${otsTot} órdenes · ${otsDentro} dentro de un tramo · ` +
  `S/ ${n2(solesDentro)} medidos · S/ ${n2(solesFuera)} fuera`
);
console.log(
  "Lo que hay que mirar: si «fuera» pesa tanto como «medidos», el S/km publicado es un piso muy bajo\n" +
  "y lo que toca no es aplicarlo — es completar el kilometraje de esas órdenes en /mantenimiento."
);

// ── 4 · La edad de la flota contra su ficha ─────────────────────────────────

linea("4 · LA EDAD DE LA FLOTA CONTRA LA FICHA QUE LA DEPRECIA");
for (const p of params) {
  const e = edades.get(p.tipo_vehiculo);
  if (!e || e.codigo === "sin_placas") continue;
  const rango = e.minAnio === null ? "sin año" : e.maxAnio !== e.minAnio ? `${e.minAnio}–${e.maxAnio}` : String(e.minAnio);
  const marca = e.codigo === "mezcla" || e.codigo === "supera_vida" ? "⚠ " : "  ";
  console.log(`${marca}${p.tipo_vehiculo.padEnd(22)} vida útil ${String(e.vidaUtil).padStart(2)} años · flota ${rango.padEnd(11)} · ${etiquetaAntiguedad(e.codigo)}`);
  if (e.codigo === "mezcla" || e.codigo === "supera_vida") {
    console.log(`  ${" ".repeat(20)} ${e.detalle}`);
    console.log(`  ${" ".repeat(20)} unidades: ${e.unidades.map((u) => `${u.placa}${u.anio ? ` (${u.anio})` : " (sin año)"}`).join(", ")}`);
  }
}

// ── 5 · El puente roto ──────────────────────────────────────────────────────

linea("5 · EL PUENTE `tipo_vehiculo_costeo` (texto libre, sin FK)");
const claves = new Set(params.map((p: any) => p.tipo_vehiculo));
const huerfanas = placas.filter((p) => p.tipoCosteo && !claves.has(p.tipoCosteo.trim()));
if (huerfanas.length) {
  console.log("Placas que apuntan a un tipo que NO existe (se costean con lo que alguien teclee a mano):");
  for (const p of huerfanas) console.log(`  ${p.placa} → "${p.tipoCosteo}"`);
} else {
  console.log("Ninguna placa apunta a un tipo inexistente.");
}
const sinCategoria = await traer("vehiculos?select=placa,anio&tipo_vehiculo_costeo=is.null");
if (sinCategoria.length) {
  console.log(`\nUnidades propias SIN categoría de costeo (${sinCategoria.length}): su mantenimiento no le sirve a ningún tipo.`);
  for (const v of sinCategoria) console.log(`  ${v.placa}${v.anio ? ` (${v.anio})` : ""}`);
}
