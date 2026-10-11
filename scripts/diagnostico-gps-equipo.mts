// ¿Es su teléfono o le falta configurar algo? — el diagnóstico del rastreo, sobre los datos REALES,
// para todos los servicios de UNA placa en un rango de fechas.
//
// Imprime, por servicio: la cobertura (el MISMO % de la celda RASTREO de /seguimiento), cada tramo
// sin rastreo con su causa, los tramos con el GPS pegado (no restan del %), las posiciones que
// llegaron tarde (falta de datos móviles) y lo que reportó el teléfono del conductor durante, antes
// y por última vez. No mide nada por su cuenta: llama a `diagnosticoDeReserva`
// (lib/gps-diagnostico-datos.ts), el mismo lector del modal — un diagnóstico de consola que midiera
// distinto sería otro motor contestando la misma pregunta.
//
// Uso:  npx tsx scripts/diagnostico-gps-equipo.mts <desde> <hasta> <placa>
//   ej: npx tsx scripts/diagnostico-gps-equipo.mts 2026-10-01 2026-10-10 VFC-962
//
// Solo LEE (service-role). Sirve de antes y después: córrelo, corre supabase/gps-equipo-01.sql,
// espera a que la app del conductor reporte, y vuelve a correrlo.
/* eslint-disable @typescript-eslint/no-explicit-any -- lee filas crudas de PostgREST, sin tipos generados */
import fs from "node:fs";
import path from "node:path";
import { hhmmLima } from "../lib/servicio-tiempos";

const [DESDE, HASTA, PLACA] = process.argv.slice(2);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
if (!DESDE || !HASTA || !PLACA || !FECHA.test(DESDE) || !FECHA.test(HASTA) || DESDE > HASTA) {
  console.error(
    "\n❌ Uso: npx tsx scripts/diagnostico-gps-equipo.mts <desde> <hasta> <placa>" +
    "\n   ej: npx tsx scripts/diagnostico-gps-equipo.mts 2026-10-01 2026-10-10 VFC-962" +
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
const { diagnosticoDeReserva } = await import("../lib/gps-diagnostico-datos");
type Respuesta = import("../lib/gps-diagnostico-api").RespuestaDiagnosticoRastreo;
type EstadoPantalla = import("../lib/gps-diagnostico-api").EstadoEquipoPantalla;

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Lee todas las páginas o lanza (PostgREST corta en 1000). */
async function todas(armar: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; off < 100_000; off += 1000) {
    const { data, error } = await armar().range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const normPlaca = (p: unknown) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hh = (ts: number | null | undefined) => (ts != null ? hhmmLima(ts) : "—");
const min = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
const tri = (v: boolean | null | undefined) => (v === true ? "✓" : v === false ? "✗" : "— no se pudo comprobar");

function equipoTxt(nombre: string, e: EstadoPantalla | null): string[] {
  if (!e) return [`   ${nombre}: sin reporte`];
  return [
    `   ${nombre}: ${hh(e.desdeTs)}–${hh(e.hastaTs)} (${new Date(e.hastaTs - 5 * 3600_000).toISOString().slice(0, 10)})` +
      ` · ${e.reportes} reporte(s) · ${e.aparatos} aparato(s)`,
    `      ${e.plataforma ?? "?"} · ${e.marca}${e.modelo ? ` · ${e.modelo}` : ""}${e.android ? ` · Android ${e.android}` : ""} · ${e.nivelApk.codigo}`,
    `      batería sin restricciones ${tri(e.bateria_exenta)} · todo el tiempo ${tri(e.todo_el_tiempo)} · fondo ${tri(e.servicio_fondo)}`,
    `      ubicación precisa ${e.precision_ubicacion == null ? "— no se pudo comprobar" : e.precision_ubicacion === "precisa" ? "✓" : "✗ aproximada"}` +
      ` · alta precisión ${tri(e.ajustes_alta_precision)} · GPS ${e.gps_debil_m == null ? "sin muestras" : `±${e.gps_debil_m} m`}` +
      ` · atascado ${e.gps_atascado == null ? "?" : e.gps_atascado ? "sí" : "no"} · cola ${e.pendientes_cola ?? "?"}`,
  ];
}

function imprimir(r: Record<string, any>, d: Respuesta) {
  const v = d.veredicto, m = d.medicion, dg = d.diagnostico;
  console.log(`\n#${r.id} · ${r.fecha_servicio} ${String(r.hora_servicio ?? "").slice(0, 5)} · ${r.estado}` +
    (d.equipo.conductor ? ` · ${d.equipo.conductor.tabla}:${d.equipo.conductor.id} (por la ${d.equipo.conductor.por})` : " · sin conductor"));
  console.log(`   RASTREO ${v.celda} [${v.codigo}] — ${v.detalle}`);
  if (m) console.log(`   ventana ${hh(m.ventanaIniTs)}–${hh(m.ventanaFinTs)} (${m.durMin} min, fin por ${m.finPor}) · ${m.cortes} corte(s) en movimiento · ${m.kmACiegas} km a ciegas`);
  console.log(`   DIAGNÓSTICO [${dg.codigo}] ${dg.titular}`);
  console.log(`      ${dg.detalle}`);
  console.log(`   ${dg.resumen}`);
  for (const t of dg.tramos) {
    console.log(`     · ${t.tipo.padEnd(6)} ${hh(t.desdeTs)}–${hh(t.hastaTs)} · ${min(t.durS)}` +
      `${t.enMovimiento && t.avanceM != null ? ` · ${(t.avanceM / 1000).toFixed(1)} km` : ""} · ${t.causa}` +
      `${t.filasAntena ? ` · ${t.filasAntena} por antena` : ""}${t.reinicioApp ? ` · reabrió ${hh(t.reinicioApp.clienteTs)}` : ""}`);
    console.log(`       ${t.texto}`);
  }
  for (const c of dg.congelados) console.log(`     · CONGELADO (${c.por}) ${c.texto}`);
  console.log(`   Llegadas: ${dg.entregas.texto}`);
  if (dg.entregas.medible) for (const t of dg.entregas.tardias) console.log(`     · ${t.texto}`);
  console.log("   Teléfono:");
  for (const l of equipoTxt("durante", d.equipo.durante)) console.log(l);
  for (const l of equipoTxt("antes", d.equipo.anterior)) console.log(l);
  for (const l of equipoTxt("último", d.equipo.ultimo)) console.log(l);
  for (const f of dg.faltas) console.log(`     ${f.explica ? "!" : "·"} ${f.titulo} → ${f.arreglo}`);
  if (dg.noComprobado.length) console.log(`     sin comprobar: ${dg.noComprobado.join(", ")}`);
}

async function main() {
  console.log(`\nDIAGNÓSTICO DEL RASTREO · ${PLACA} · ${DESDE} al ${HASTA}\n${"═".repeat(64)}`);
  const buscada = normPlaca(PLACA);
  const [propios, terceros] = await Promise.all([
    todas(() => admin.from("vehiculos").select("id, placa").order("id", { ascending: true })),
    todas(() => admin.from("vehiculos_tercero").select("id, placa").order("id", { ascending: true })),
  ]);
  const idsP = propios.filter((x) => normPlaca(x.placa) === buscada).map((x) => Number(x.id));
  const idsT = terceros.filter((x) => normPlaca(x.placa) === buscada).map((x) => Number(x.id));
  if (!idsP.length && !idsT.length) {
    console.log(`\nNo hay ninguna unidad con la placa ${PLACA} (ni propia ni tercerizada).\n`);
    return;
  }
  // Flota propia y tercerizada por separado: sus ids se solapan.
  const reservas = [
    ...(idsP.length ? await todas(() => admin.from("reservas").select("*").in("vehiculo_id", idsP)
      .gte("fecha_servicio", DESDE).lte("fecha_servicio", HASTA).order("id", { ascending: true })) : []),
    ...(idsT.length ? await todas(() => admin.from("reservas").select("*").in("vehiculo_tercero_id", idsT)
      .gte("fecha_servicio", DESDE).lte("fecha_servicio", HASTA).order("id", { ascending: true })) : []),
  ].sort((a, b) => String(a.fecha_servicio).localeCompare(String(b.fecha_servicio))
    || String(a.hora_servicio ?? "").localeCompare(String(b.hora_servicio ?? "")) || a.id - b.id);
  console.log(`${reservas.length} servicio(s) de ${PLACA} en el rango (propia: ${idsP.length ? "sí" : "no"} · tercerizada: ${idsT.length ? "sí" : "no"}).`);

  // «Hoy» en Lima (UTC-5), la misma cuenta que hoyLimaFecha (lib/retrasos-datos.ts) de la ruta.
  const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
  const cuenta: Record<string, number> = {};
  let faltaTabla = false, faltaRecibido = false;
  for (const r of reservas) {
    try {
      const d = await diagnosticoDeReserva(r.id, { hoy, ahoraMs: Date.now(), reserva: r });
      if (!d) continue;
      imprimir(r, d);
      cuenta[d.diagnostico.codigo] = (cuenta[d.diagnostico.codigo] ?? 0) + 1;
      faltaTabla ||= d.migraciones.faltaTabla;
      faltaRecibido ||= d.migraciones.faltaRecibido;
    } catch (e: any) {
      console.log(`\n#${r.id} · ${r.fecha_servicio} · NO SE PUDO DIAGNOSTICAR: ${e?.message ?? e}`);
    }
  }
  console.log(`\n${"═".repeat(64)}\nResumen por diagnóstico: ${Object.entries(cuenta).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
  if (faltaTabla) console.log("⚠ Falta la tabla gps_equipo_reportes: corre supabase/gps-equipo-01.sql (no la corre el deploy).");
  if (faltaRecibido) console.log("⚠ Falta ubicaciones_gps.recibido_en: las llegadas tardías no se pueden medir hasta correr supabase/gps-equipo-01.sql.");
  console.log("");
}

main().catch((e) => { console.error(`\n❌ ${e?.message ?? e}\n`); process.exit(1); });
