// /cotizaciones sobre los datos REALES: ¿cuánto pesa la lista y cómo se reparte en el tiempo?
// Es la medición previa a la lista liviana (periodo + paginado + columnas acotadas):
//   1. filas totales y por AÑO de created_at (el eje de emisión, el filtro por defecto);
//   2. filas con fecha_servicio NULL por modo_servicio (las que el eje de SERVICIO dejaría
//      fuera de cualquier periodo — hay que saber cuántas son antes de ofrecer ese eje);
//   3. tamaño medio en bytes (JSON.stringify) de una muestra de 200 filas con select(*)
//      contra las columnas que pediría la lista liviana.
//
// Uso:  npx tsx scripts/diagnostico-cotizaciones.mts
//
// Solo LEE (service-role). Nunca escribe.
/* eslint-disable @typescript-eslint/no-explicit-any -- lee filas crudas de PostgREST, sin tipos generados */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// Credenciales: las del entorno si ya están; si no, las de .env.local.
const RUTA_ENV = path.join(process.cwd(), ".env.local");
if (fs.existsSync(RUTA_ENV)) {
  const env = fs.readFileSync(RUTA_ENV, "utf8");
  const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[k] && leer(k)) process.env[k] = leer(k);
  }
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    `\n❌ Faltan las credenciales de Supabase.\n\n   Necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY` +
    ` (en el entorno o en ${RUTA_ENV}).\n   Córrelo desde la máquina donde tienes el .env.local. Solo lee.\n`,
  );
  process.exit(1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const COLS_LISTA =
  "id,cliente_id,origen,destino,km,precio_cliente,costo_estimado,margen_estimado,estado,numero_cotizacion," +
  "atencion,asunto,fecha_servicio,hora_ida,descuento_pct,tipo_vehiculo,tipo_servicio,equipamiento," +
  "vehiculo_flota_id,vehiculo_tercero_id,created_at,modo_servicio,precio_dia";

const PAGINA = 1000;

/** Lee TODAS las filas con orden total (id): sin orden, las páginas se solapan y se pierden filas. */
async function todas(cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await sb.from("cotizaciones").select(cols)
      .order("id", { ascending: true }).range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`No se pudo leer cotizaciones (desde ${desde}): ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGINA) return out;
  }
}

const bytes = (filas: any[]) => filas.reduce((s, f) => s + Buffer.byteLength(JSON.stringify(f), "utf8"), 0);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  console.log(`\nCOTIZACIONES · peso de la lista\n${"═".repeat(56)}`);

  // 1 y 2: con solo las columnas que hacen falta (liviano aunque la tabla sea grande).
  const filas = await todas("id,created_at,fecha_servicio,modo_servicio");
  console.log(`\n1. Filas totales: ${filas.length}`);
  const porAnio = new Map<string, number>();
  for (const f of filas) {
    const anio = typeof f.created_at === "string" ? f.created_at.slice(0, 4) : "(sin created_at)";
    porAnio.set(anio, (porAnio.get(anio) ?? 0) + 1);
  }
  for (const [anio, n] of [...porAnio].sort()) console.log(`   ${anio}: ${n}`);

  console.log(`\n2. Sin fecha_servicio, por modo_servicio:`);
  const sinFecha = new Map<string, number>();
  for (const f of filas) {
    if (f.fecha_servicio != null) continue;
    const modo = f.modo_servicio ?? "(null)";
    sinFecha.set(modo, (sinFecha.get(modo) ?? 0) + 1);
  }
  if (sinFecha.size === 0) console.log("   ninguna");
  for (const [modo, n] of [...sinFecha].sort((a, b) => b[1] - a[1])) console.log(`   ${modo}: ${n}`);

  // 3: la MISMA muestra (las 200 más recientes por id) con las dos selecciones.
  const muestra = async (cols: string) => {
    const { data, error } = await sb.from("cotizaciones").select(cols)
      .order("id", { ascending: false }).range(0, 199);
    if (error) throw new Error(`Muestra (${cols === "*" ? "*" : "lista"}): ${error.message}`);
    return data ?? [];
  };
  const [completa, liviana] = await Promise.all([muestra("*"), muestra(COLS_LISTA)]);
  const bC = bytes(completa), bL = bytes(liviana);
  const n = Math.max(completa.length, 1);
  console.log(`\n3. Muestra de ${completa.length} filas (las más recientes):`);
  console.log(`   select(*)        total ${kb(bC)} · media ${(bC / n).toFixed(0)} B/fila`);
  console.log(`   columnas lista   total ${kb(bL)} · media ${(bL / Math.max(liviana.length, 1)).toFixed(0)} B/fila`);
  if (bC > 0) console.log(`   la lista liviana pesa el ${((bL / bC) * 100).toFixed(1)} % de select(*)`);
  if (filas.length > 0 && completa.length > 0) {
    console.log(`   proyección a ${filas.length} filas: * ≈ ${kb((bC / n) * filas.length)} · lista ≈ ${kb((bL / n) * filas.length)}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
