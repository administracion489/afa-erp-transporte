// Excesos de velocidad sobre los datos REALES: ¿qué dirían los umbrales no medidos del motor?
//
// Toma hasta 60 servicios FINALIZADOS del rango, lee la traza de cada uno POR RESERVA (el mismo
// `trazaDe(…, { conHuella: true })` de la torre: NO necesita supabase/gps-analitica-01-excesos.sql) y
// corre `detectarExcesos` (lib/flota/excesos.ts) con umbral 80, 90 y 100. Imprime:
//   · la distribución de códigos (exceso / breve / impreciso / sin_corroborar / imposible / simulado);
//   · la razón velocidad geométrica / velocidad del sensor por código (¿el fantasma FUSED se separa del
//     exceso de verdad con el FACTOR_CORROBORA de 0.9?);
//   · lo que pasaría con los episodios en el BORDE de cada umbral no medido: breves de 20-30 s, rachas
//     partidas por huecos de 10-20 s, sin_corroborar entre 0.8 y 0.9 del umbral;
//   · el % de puntos rápidos con precisión nula o peor que 20 m;
//   · los conductores cuyo teléfono no reporta la velocidad del sensor en sus servicios (sin velocímetro).
// No mide nada por su cuenta: llama al MISMO motor que /seguridad-vial y la estadística por servicio.
//
// Uso:  npx tsx scripts/diagnostico-excesos.mts <desde> <hasta>
//   ej: npx tsx scripts/diagnostico-excesos.mts 2026-10-01 2026-10-10
//
// Solo LEE (service-role). Es la condición para mover un umbral no medido (DURACION_MIN_S, PUNTOS_MIN,
// GAP_EPISODIO_S, FACTOR_CORROBORA): córrelo, mira los bordes y decide con los números delante.
/* eslint-disable @typescript-eslint/no-explicit-any -- lee filas crudas de PostgREST, sin tipos generados */
import fs from "node:fs";
import path from "node:path";

const [DESDE, HASTA] = process.argv.slice(2);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
if (!DESDE || !HASTA || !FECHA.test(DESDE) || !FECHA.test(HASTA) || DESDE > HASTA) {
  console.error(
    "\n❌ Uso: npx tsx scripts/diagnostico-excesos.mts <desde> <hasta>" +
    "\n   ej: npx tsx scripts/diagnostico-excesos.mts 2026-10-01 2026-10-10" +
    "\n   (fechas AAAA-MM-DD, desde ≤ hasta)\n",
  );
  process.exit(1);
}

// Credenciales: las del entorno si ya están; si no, las de .env.local. Sin ellas, un mensaje claro y
// no un stack de supabase-js («supabaseUrl is required») que no dice qué falta.
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
    ` (en el entorno o en ${RUTA_ENV}).` +
    `\n   Córrelo desde la máquina donde tienes el .env.local. Solo lee.\n`,
  );
  process.exit(1);
}
// Importación DINÁMICA: el lector crea su cliente al cargarse, y tiene que hacerlo con las
// credenciales ya puestas.
const { createClient } = await import("@supabase/supabase-js");
const { trazaDe } = await import("../lib/gps-cobertura-datos");
const X = await import("../lib/flota/excesos");
type Episodio = import("../lib/flota/excesos").Episodio;
type PuntoVel = import("../lib/flota/excesos").PuntoVel;

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MAX_SERVICIOS = 60;
const PARALELO = 4;
const UMBRALES = [80, 90, 100];

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : "—");
function cuantiles(xs: number[]): string {
  if (!xs.length) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return `p10 ${q(0.1).toFixed(2)} · p50 ${q(0.5).toFixed(2)} · p90 ${q(0.9).toFixed(2)} (n=${s.length})`;
}

async function main() {
  console.log(`\nEXCESOS DE VELOCIDAD · ${DESDE} al ${HASTA}\n${"═".repeat(64)}`);
  const { data: reservas, error } = await admin.from("reservas")
    .select("id, fecha_servicio, hora_servicio, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id")
    .gte("fecha_servicio", DESDE).lte("fecha_servicio", HASTA).eq("estado", "finalizada")
    .order("fecha_servicio", { ascending: false }).order("id", { ascending: false })
    .limit(MAX_SERVICIOS);
  if (error) { console.error(`❌ No se pudieron leer los servicios: ${error.message}`); process.exit(1); }
  const lote = reservas ?? [];
  console.log(`${lote.length} servicio(s) finalizado(s) (como mucho ${MAX_SERVICIOS}, los más recientes).`);

  // Las trazas, por reserva (no necesita la migración).
  const puntosDe = new Map<number, PuntoVel[]>();
  let fallidas = 0;
  for (let i = 0; i < lote.length; i += PARALELO) {
    await Promise.all(lote.slice(i, i + PARALELO).map(async (r: any) => {
      try {
        const t = await trazaDe(r.id, { conHuella: true });
        puntosDe.set(r.id, X.puntosDeCrudas(t.crudas ?? [], { reservaId: r.id, vehiculo: X.claveUnidad(r.vehiculo_id, r.vehiculo_tercero_id) }));
      } catch (e: any) {
        fallidas++;
        console.log(`   ! #${r.id}: no se pudo leer la traza (${e?.message ?? e})`);
      }
    }));
  }
  const todos = [...puntosDe.values()].flat();
  console.log(`${puntosDe.size} traza(s) leída(s), ${fallidas} fallida(s), ${todos.length} puntos con posición.`);

  // ── Velocímetro por conductor (de sus trazas) ──
  const conVel = new Map<string, { puntos: number; conVelocidad: number }>();
  for (const p of todos) {
    const k = p.conductor ?? "(sin conductor en la fila)";
    const v = conVel.get(k) ?? { puntos: 0, conVelocidad: 0 };
    v.puntos++; if (p.velocidad > 0) v.conVelocidad++;
    conVel.set(k, v);
  }
  const sinVel = [...conVel.entries()].filter(([, v]) => v.conVelocidad === 0);
  console.log(`\nVELOCÍMETRO: ${conVel.size} conductor(es) con puntos; ${sinVel.length} SIN velocímetro (ningún punto con velocidad > 0):`);
  for (const [k, v] of sinVel) console.log(`   · ${k}: ${v.puntos} puntos, todos con velocidad 0 → no se puede juzgar`);

  for (const u of UMBRALES) {
    console.log(`\n── UMBRAL ${u} km/h ${"─".repeat(48)}`);
    const rapidos = todos.filter((p) => p.velocidad >= u);
    const precNula = rapidos.filter((p) => p.precisionM == null || p.precisionM <= 0).length;
    const precMala = rapidos.filter((p) => p.precisionM != null && p.precisionM > X.PRECISION_CORROBORA_M).length;
    console.log(`Puntos ≥ ${u}: ${rapidos.length} · precisión nula ${pct(precNula, rapidos.length)} · peor que ${X.PRECISION_CORROBORA_M} m ${pct(precMala, rapidos.length)}`);
    const eps: Episodio[] = [];
    for (const [, pts] of puntosDe) eps.push(...X.detectarExcesos(pts, u));
    const porCod = new Map<string, Episodio[]>();
    for (const e of eps) porCod.set(e.codigo, [...(porCod.get(e.codigo) ?? []), e]);
    console.log(`Episodios: ${eps.length}`);
    for (const c of X.CODIGOS_EPISODIO) {
      const l = porCod.get(c) ?? [];
      const razon = l.filter((e) => e.velGeom != null && e.velMediaSensor > 0).map((e) => e.velGeom! / e.velMediaSensor);
      console.log(`   ${c.padEnd(15)} ${String(l.length).padStart(5)}  (${pct(l.length, eps.length)})  geom/sensor ${cuantiles(razon)}`);
    }
    const fueraServ = eps.filter((e) => e.fueraDeServicio).length;
    if (fueraServ) console.log(`   (${fueraServ} sin reserva en la fila: en la traza de un servicio no debería pasar)`);

    // Los bordes de los umbrales no medidos.
    const breves = porCod.get("breve") ?? [];
    const casi = breves.filter((e) => e.durS >= 20 && e.durS < X.DURACION_MIN_S && e.puntos >= X.PUNTOS_MIN).length;
    console.log(`Bordes:`);
    console.log(`   breves de 20 a ${X.DURACION_MIN_S} s con ${X.PUNTOS_MIN}+ muestras: ${casi} (pasarían a juzgarse si DURACION_MIN_S bajara a 20)`);
    const sc = porCod.get("sin_corroborar") ?? [];
    const casiSc = sc.filter((e) => e.velGeom != null && e.velGeom >= 0.8 * u).length;
    console.log(`   sin_corroborar con geometría entre 0.8 y ${X.FACTOR_CORROBORA} del umbral: ${casiSc} de ${sc.length} (pasarían a exceso si FACTOR_CORROBORA bajara a 0.8)`);
    const ex = porCod.get("exceso") ?? [];
    const justos = ex.filter((e) => e.velGeom != null && e.velGeom < 0.95 * u).length;
    console.log(`   excesos con geometría bajo 0.95 del umbral: ${justos} de ${ex.length} (dejarían de contar si FACTOR_CORROBORA subiera a 0.95)`);
    // ¿Cuántas rachas se partieron por un hueco de 10 a 20 s? (pares de episodios del mismo grupo)
    let partidas = 0;
    const ordenados = [...eps].sort((a, b) => String(a.conductor).localeCompare(String(b.conductor)) || (a.reservaId ?? 0) - (b.reservaId ?? 0) || a.inicioTs - b.inicioTs);
    for (let i = 1; i < ordenados.length; i++) {
      const a = ordenados[i - 1], b = ordenados[i];
      if (a.conductor === b.conductor && a.reservaId === b.reservaId) {
        const h = (b.inicioTs - a.finTs) / 1000;
        if (h > X.GAP_EPISODIO_S && h <= 20) partidas++;
      }
    }
    console.log(`   rachas partidas por un hueco de ${X.GAP_EPISODIO_S} a 20 s: ${partidas} (se unirían si GAP_EPISODIO_S subiera a 20)`);
    if (ex.length) {
      console.log(`Los 5 excesos más largos:`);
      for (const e of [...ex].sort((a, b) => b.durS - a.durS).slice(0, 5)) {
        console.log(`   · #${e.reservaId} ${e.conductor ?? "?"} ${new Date(e.inicioTs - 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} — ${e.detalle}`);
      }
    }
  }
  console.log("");
}

main().catch((e) => { console.error(`\n❌ ${e?.message ?? e}\n`); process.exit(1); });
