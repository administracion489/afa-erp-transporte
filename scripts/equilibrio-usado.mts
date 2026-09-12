// El PUNTO DE EQUILIBRIO de cada categoría usada contra su gemela premium, con los datos reales
// de esta flota. Solo LEE: no escribe nada, no aplica nada. Imprime el SQL para que una persona
// lo revise y lo pegue.
//
// POR QUÉ IMPRIME SQL EN VEZ DE ESCRIBIR
//
// El número sale de `componentesCostoKm` (lib/costos/costo-km-parametro.ts), la ÚNICA fórmula
// del S/km de este ERP. Escribirla otra vez en SQL para que una migración la despejara sería la
// cuarta copia de la misma cuenta — la que ese módulo vino a matar. Así que se calcula en TS y
// se aplica con un UPDATE de literales, que además es lo que permite mirarlo antes de correrlo:
// sobre dinero decide una persona, como en todo el resto del ERP.
//
// USO
//     npx tsx scripts/equilibrio-usado.mts
//
// LO QUE CONTESTA
//   1 · Qué cuesta hoy cada par premium/usado y cuánto se separan.
//   2 · El punto de equilibrio de cada usada, y de qué lado está hoy.
//   3 · El SQL listo para pegar (UPDATE + acta en historial_costos).
//   4 · Las que no se pueden calcular, con su motivo.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const EQ = requerir("../lib/costos/equilibrio-usado") as typeof import("../lib/costos/equilibrio-usado");
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");

const { emparejarFlota, compararPar, mantenimientoDeEquilibrio, motivoEquilibrio } = EQ;
const { costoKmDeParametro } = CKM;

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function traer(ruta: string): Promise<any[]> {
  const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: H });
  if (!r.ok) throw new Error(`${ruta} → ${r.status} ${await r.text()}`);
  return (await r.json()) as any[];
}

const n2 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
/** Comillas simples duplicadas: el motivo lleva acentos y paréntesis, nunca comillas raras. */
const sql = (s: string) => s.replace(/'/g, "''");

const params = await traer("parametros_costos?select=*&activo=eq.true&order=grupo_vehiculo.asc,capacidad.asc");
const precios: Record<string, number> = {};
for (const c of await traer("precios_combustible?select=tipo,precio")) precios[c.tipo] = Number(c.precio);

const pares = emparejarFlota(params as any[]);

// ── 1 y 2 · El estado de cada par ───────────────────────────────────────────

linea("1 · CADA PAR HOY, Y SU PUNTO DE EQUILIBRIO");
console.log("El equilibrio es el mantenimiento al que la usada cuesta lo MISMO por km que su gemela.");
console.log("No es una medición: es el número que no afirma que una sea más barata que la otra.\n");

const aplicables: { usada: any; premium: any; eq: number; motivo: string }[] = [];
const problemas: { clave: string; codigo: string; detalle: string }[] = [];

for (const par of pares) {
  if (!par.usada) continue;
  const { premium, usada } = par;
  const c = compararPar(premium as any, usada as any, precios);
  const e = mantenimientoDeEquilibrio(premium as any, usada as any, precios);

  console.log(`${par.clave}`);
  console.log(
    `  S/km   premium ${n4(c.totalPremium)}   usada ${n4(c.totalUsada)}   ` +
    `Δ ${c.delta >= 0 ? "+" : ""}${n4(c.delta)}` +
    (c.deltaPct !== null ? ` (${c.deltaPct >= 0 ? "+" : ""}${(c.deltaPct * 100).toFixed(1)} %)` : "")
  );
  console.log(
    "  renglones " +
    c.filas.filter((f) => Math.abs(f.delta) > 0.00005)
      .map((f) => `${f.label} ${f.delta >= 0 ? "+" : ""}${n4(f.delta)}`).join(" · ")
  );

  if (e.codigo !== "equilibrio" || e.mantenimiento === null) {
    console.log(`  ⚠ ${e.codigo}: ${e.detalle}`);
    problemas.push({ clave: usada.tipo_vehiculo, codigo: e.codigo, detalle: e.detalle });
    continue;
  }
  const lado = (e.brecha as number) > 0 ? "por ENCIMA (hoy cuesta más)" : (e.brecha as number) < 0 ? "por debajo (hoy cuesta menos)" : "justo en el equilibrio";
  console.log(
    `  mantenimiento  tecleado ${n2(e.actual)}  →  equilibrio ${n2(e.mantenimiento)} S/km   ` +
    `· está ${lado}`
  );
  aplicables.push({ usada, premium, eq: e.mantenimiento, motivo: motivoEquilibrio(e, premium.nombre) });
}

// ── 3 · El SQL ──────────────────────────────────────────────────────────────

linea("2 · EL SQL — revísalo y pégalo en Supabase → SQL Editor");
if (!aplicables.length) {
  console.log("-- Nada que aplicar.");
} else {
  console.log("BEGIN;\n");
  for (const a of aplicables) {
    console.log(
      `UPDATE parametros_costos SET mantenimiento_km = ${a.eq.toFixed(2)}, ` +
      `updated_by = 'equilibrio-usado' WHERE tipo_vehiculo = '${sql(a.usada.tipo_vehiculo)}';`
    );
  }
  console.log("");
  console.log("INSERT INTO historial_costos (tabla_origen, tipo_vehiculo, campo_modificado, valor_anterior, valor_nuevo, motivo, cambiado_por) VALUES");
  console.log(
    aplicables.map((a) =>
      `  ('parametros_costos', '${sql(a.usada.tipo_vehiculo)}', 'mantenimiento_km', ` +
      `${Number(a.usada.mantenimiento_km).toFixed(4)}, ${a.eq.toFixed(2)}, '${sql(a.motivo)}', 'equilibrio-usado')`
    ).join(",\n") + ";"
  );
  console.log("\nCOMMIT;");
}

// ── 4 · Lo que no se pudo ───────────────────────────────────────────────────

if (problemas.length) {
  linea("3 · LAS QUE NO SE PUEDEN CALCULAR");
  for (const p of problemas) console.log(`${p.clave} · ${p.codigo}\n  ${p.detalle}`);
}

linea("DESPUÉS DE APLICARLO");
console.log(
  "Premium (<10 años) y Estándar (>10 años) van a costar lo MISMO por km, así que en el cotizador\n" +
  "saldrán al mismo precio con el mismo margen. Que el Premium se venda más caro es una decisión\n" +
  "de margen, no de costo.\n" +
  "El número real lo trae la columna «Medido» de 🔧 Mantenimiento en /configuracion/costos:\n" +
  "  npx tsx scripts/diagnostico-mantenimiento-tipo.mts"
);
