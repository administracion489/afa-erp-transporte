// Cuánto costaría GUARDAR la traza ajustada a la vía de los servicios finalizados, sobre los datos
// REALES. Solo LEE: no llama a Mapbox, no escribe nada, no toca la base.
//
// POR QUÉ EXISTE
//
// La traza ajustada de un servicio finalizado se calcula UNA vez en el servidor y se guarda para
// siempre (lib/gps-traza-ajustada*.ts). Dos decisiones dependen de números que no están medidos:
//   • cuántos días atrás precalcular con el cron (`gps_traza_config.precalcular_dias`, nace en 0), y los
//     presupuestos de consultas a Map Matching (`presupuesto_hora`, `presupuesto_mes`);
//   • cuánto crece el almacenamiento «para siempre».
// Este script es esa medición, antes de encender nada.
//
// USO
//     npx tsx scripts/diagnostico-traza-ajustada.mts            (los últimos 30 días)
//     npx tsx scripts/diagnostico-traza-ajustada.mts 7          (los últimos 7)
//
// Necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (del entorno o de .env.local).
//
// LO QUE CONTESTA, por día (Lima) y en total
//   · cuántos servicios finalizados hay;
//   · la distribución de posiciones por servicio (las MISMAS filas que recibe el modal: se leen con
//     `huellaDelServicio`, el lector de /api/cliente/gps) y de puntos limpios (`huellaDeFilas`);
//   · las llamadas estimadas a Map Matching: `ceil(n/99)+1` por servicio sobre los puntos limpios. Es un
//     PISO: una ventana que no pega limpia hace ~6-7 llamadas más (la búsqueda del prefijo limpio), y un
//     429 se reintenta;
//   · los bytes estimados: la huella limpia codificada con el MISMO códec que se guarda. Es una
//     aproximación: la geometría de Mapbox no tiene los mismos vértices que la huella (suele tener más
//     en curvas y menos en rectas).
//   · cuántas lecturas salieron incompletas (una página que falló) y cuántos servicios pasan del tope
//     de puntos que el servidor acepta ajustar (MAX_FILAS_AJUSTE).

/* eslint-disable @typescript-eslint/no-explicit-any -- filas crudas de PostgREST */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { huellaDeFilas, enParalelo } from "../lib/huella";
import { huellaDelServicio } from "../lib/gps-huella-servicio-datos";
import { codificarTraza, llamadasEstimadas, MAX_FILAS_AJUSTE } from "../lib/gps-traza-ajustada";

// ── Credenciales ──────────────────────────────────────────────────────────────
function variable(k: string): string {
  if (process.env[k]) return String(process.env[k]).trim();
  const archivo = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(archivo)) return "";
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(fs.readFileSync(archivo, "utf8"));
  return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
const URL_SB = variable("NEXT_PUBLIC_SUPABASE_URL");
const KEY = variable("SUPABASE_SERVICE_ROLE_KEY");
if (!URL_SB || !KEY) {
  console.error(
    "\n  Faltan las credenciales de la base: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.\n\n" +
    "  Ponlas en el entorno o en .env.local (en la raíz del repo) y vuelve a correrlo:\n\n" +
    "      npx tsx scripts/diagnostico-traza-ajustada.mts 30\n\n" +
    "  Hace falta la service-role (las tablas tienen RLS): el script solo LEE.\n",
  );
  process.exit(1);
}
const admin = createClient(URL_SB, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ── Periodo (Lima, aritmética sobre la cadena ISO) ────────────────────────────
const DIAS = Number(process.argv[2] ?? 30);
if (!Number.isInteger(DIAS) || DIAS < 1 || DIAS > 90) {
  console.error("\n  Días inválidos (1 a 90). Uso: npx tsx scripts/diagnostico-traza-ajustada.mts 30\n");
  process.exit(1);
}
const hoyLima = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
const sumarDias = (f: string, d: number) => new Date(Date.parse(`${f}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const DESDE = sumarDias(hoyLima, -DIAS);

// ── Reservas finalizadas (paginado con orden total; un error LANZA) ───────────
async function finalizadas(): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await admin.from("reservas")
      .select("id,fecha_servicio,vehiculo_id,vehiculo_tercero_id")
      .eq("estado", "finalizada").gte("fecha_servicio", DESDE).lte("fecha_servicio", hoyLima)
      .order("fecha_servicio", { ascending: true }).order("id", { ascending: true })
      .range(desde, desde + 999);
    if (error) throw new Error(`No se pudieron leer las reservas: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
type Med = { filas: number; limpios: number; llamadas: number; bytes: number; incompleta: boolean };

const reservas = await finalizadas();
console.log(`\nServicios finalizados del ${DESDE} al ${hoyLima}: ${reservas.length}. Leyendo sus huellas…`);
const porReserva = new Map<number, Med>();
await enParalelo(reservas, 4, async (r: any) => {
  try {
    const h = await huellaDelServicio(admin, { reservaId: r.id, vehiculoId: r.vehiculo_id ?? null, vehiculoTerceroId: r.vehiculo_tercero_id ?? null }, Date.now());
    const limpio = huellaDeFilas(h.filasOk).limpio;
    const cod = limpio.length >= 2
      ? codificarTraza({ coords: limpio.map((p) => [p.lng, p.lat] as [number, number]), esCrudo: limpio.map(() => false), colaSnapped: true })
      : null;
    porReserva.set(r.id, {
      filas: h.filasOk.length, limpios: limpio.length, llamadas: llamadasEstimadas(limpio.length),
      bytes: cod && cod.ok ? cod.bytes : 0, incompleta: !h.completa,
    });
  } catch (e: any) {
    console.error(`  reserva ${r.id}: ${e?.message ?? e}`);
    porReserva.set(r.id, { filas: 0, limpios: 0, llamadas: 0, bytes: 0, incompleta: true });
  }
});

const dias = new Map<string, number[]>();
for (const r of reservas) {
  const l = dias.get(r.fecha_servicio) ?? [];
  l.push(r.id);
  dias.set(r.fecha_servicio, l);
}
const fila = (etiqueta: string, ids: number[]) => {
  const ms = ids.map((id) => porReserva.get(id)).filter(Boolean) as Med[];
  const filas = ms.map((m) => m.filas), limp = ms.map((m) => m.limpios);
  const llamadas = ms.reduce((a, m) => a + m.llamadas, 0), bytes = ms.reduce((a, m) => a + m.bytes, 0);
  const inc = ms.filter((m) => m.incompleta).length, topados = ms.filter((m) => m.limpios > MAX_FILAS_AJUSTE).length;
  const sinPos = ms.filter((m) => m.limpios < 2).length;
  console.log(
    `${etiqueta.padEnd(10)} ${String(ids.length).padStart(5)} serv · posiciones p50 ${String(pct(filas, 0.5)).padStart(5)} p90 ${String(pct(filas, 0.9)).padStart(5)} máx ${String(Math.max(0, ...filas)).padStart(6)}` +
    ` · limpios p50 ${String(pct(limp, 0.5)).padStart(5)} · ${String(llamadas).padStart(6)} llamadas (piso) · ${(bytes / 1024).toFixed(0).padStart(6)} KB` +
    `${sinPos ? ` · ${sinPos} sin posiciones` : ""}${inc ? ` · ${inc} lecturas incompletas` : ""}${topados ? ` · ${topados} > ${MAX_FILAS_AJUSTE} pts` : ""}`,
  );
  return { llamadas, bytes };
};
console.log("");
for (const [d, ids] of [...dias.entries()].sort()) fila(d, ids);
console.log("");
const t = fila("TOTAL", reservas.map((r) => r.id));
const nDias = Math.max(1, dias.size);
console.log(
  `\nPromedio por día con servicios: ${(t.llamadas / nDias).toFixed(0)} llamadas (piso) · ${(t.bytes / nDias / 1024).toFixed(0)} KB.` +
  `\nProyección a un año al mismo ritmo: ${((t.bytes / nDias) * 365 / 1024 / 1024).toFixed(1)} MB si se guardaran TODOS (solo se guardan los que alguien abre, salvo que se encienda el cron).\n`,
);
