// Qué dice el USO DE FLOTA (lib/flota/uso-flota.ts) sobre los datos REALES. Solo LEE: no escribe nada,
// no propone nada, no toca la base.
//
// POR QUÉ EXISTE
//
// El uso de flota publica el km de cada unidad y día con su FUENTE —el odómetro saneado o, si la
// jornada no está completa, el GPS de sus servicios como piso— y la herramienta `utilizacion_flota` de
// ELIA cambió a propósito su km (antes `max − min` de las lecturas aceptadas). Tres umbrales del módulo
// son operativos o no medidos (MAX_TRAZAS_RELLENO, DIAS_ANCLA_LECTURAS y el aviso de cobertura) y este
// repo mide antes de fijar: este script es esa medición.
//
// USO
//     npx tsx scripts/diagnostico-uso-flota.mts                         (los últimos 7 días)
//     npx tsx scripts/diagnostico-uso-flota.mts 2026-09-01 2026-09-30
//
// Necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (del entorno o de .env.local).
//
// LO QUE CONTESTA
//
//   1 · Por placa: cuántos días con servicio tienen jornada de odómetro COMPLETA. Es la cobertura que
//       decide cuánto del km semanal es medido y cuánto queda como piso del GPS (o sin dato).
//   2 · Cuántas trazas pediría el relleno por GPS en ese periodo (contra MAX_TRAZAS_RELLENO).
//   3 · Unidades tercerizadas con y sin `tipo_vehiculo_costeo` (sin él, su servicio no tiene
//       combustible ni CO₂ estimado).
//   4 · Unidades propias sin `tipo_vehiculo_costeo`.
//   5 · EL HALLAZGO DE `precioUltimaCarga` (lib/costeo-servicio.ts): cuántas unidades tienen como
//       última carga con precio una de OTRA familia que su parámetro, o en litros, o urea. El
//       presupuesto de su servicio costea el combustible a ese precio.
//   6 · El km de ELIA, viejo (`max − min` de las aceptadas) contra nuevo (jornadas saneadas), por placa,
//       con lo que explica la diferencia: lecturas que no encajan o retroceden, jornadas con salto
//       imposible y km entre jornadas (de noche, o en días sin lectura completa).

/* eslint-disable @typescript-eslint/no-explicit-any -- filas crudas de PostgREST */
import fs from "node:fs";
import path from "node:path";
import {
  jornadasUso, diasPorRellenarConGps, diasDelPeriodo, familiaEstrictaDeCarga, MAX_TRAZAS_RELLENO, DIAS_ANCLA_LECTURAS,
  type EntradaUso,
} from "../lib/flota/uso-flota";
import { sanearLecturas, recorridosDiarios, sumarDias, type LecturaCruda } from "../lib/odometro-analitica";
import { familiaDeParametro } from "../lib/costos/rendimiento-tipo";
import { COMBUSTIBLES } from "../lib/combustible-tipos";

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
    "      NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \\\n" +
    "      SUPABASE_SERVICE_ROLE_KEY=… \\\n" +
    "      npx tsx scripts/diagnostico-uso-flota.mts 2026-09-01 2026-09-30\n\n" +
    "  Hace falta la service-role (las tablas tienen RLS): el script solo LEE.\n",
  );
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── Periodo ───────────────────────────────────────────────────────────────────
const hoyLima = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
const esFecha = (f: string) => /^\d{4}-\d{2}-\d{2}$/.test(f) && new Date(`${f}T12:00:00Z`).toISOString().slice(0, 10) === f;
const HASTA = process.argv[3] ?? hoyLima;
const DESDE = process.argv[2] ?? sumarDias(HASTA, -6);
if (!esFecha(DESDE) || !esFecha(HASTA) || DESDE > HASTA) {
  console.error(`\n  Periodo inválido: «${DESDE}» a «${HASTA}». Uso: npx tsx scripts/diagnostico-uso-flota.mts AAAA-MM-DD AAAA-MM-DD\n`);
  process.exit(1);
}

/** PostgREST corta en 1000 filas; la ruta trae su propio orden total. Un error LANZA. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL_SB}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}`, "Range-Unit": "items" } });
    if (!r.ok) throw new Error(`${ruta.split("?")[0]} → ${r.status} ${await r.text()}`);
    const filas = (await r.json()) as any[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
const n0 = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");

// ── Datos ─────────────────────────────────────────────────────────────────────
const lecDesde = sumarDias(DESDE, -DIAS_ANCLA_LECTURAS);
const lecHasta = [sumarDias(HASTA, DIAS_ANCLA_LECTURAS), hoyLima].sort()[0];
const [propios, terceros, params, reservas, lecturasTodas, cargas] = await Promise.all([
  traer("vehiculos?select=id,placa,categoria,estado,tipo_vehiculo_costeo&order=id.asc"),
  traer("vehiculos_tercero?select=id,placa,estado,tipo_vehiculo_costeo&order=id.asc"),
  traer("parametros_costos?select=tipo_vehiculo,tipo_combustible_1,activo&order=tipo_vehiculo.asc"),
  traer(`reservas?select=id,fecha_servicio,hora_servicio,estado,vehiculo_id,vehiculo_tercero_id,tipo_asignacion,hora_real_inicio,hora_real_fin&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}&estado=neq.cancelada&order=fecha_servicio.asc,id.asc`),
  traer(`lecturas_odometro?select=id,vehiculo_id,vehiculo_tercero_id,km,fuente,fecha,estado,motivo,created_at,capturado_en,momento&vehiculo_id=not.is.null&fecha=gte.${lecDesde}&fecha=lte.${lecHasta}&order=fecha.asc,id.asc`),
  traer("combustible?select=id,vehiculo_id,fecha,precio_galon,tipo_combustible,unidad&vehiculo_id=not.is.null&precio_galon=gt.0&order=fecha.desc,id.desc"),
]);
const lecturas: LecturaCruda[] = lecturasTodas
  .filter((l: any) => l.vehiculo_tercero_id == null)
  .map((l: any) => ({ ...l, id: String(l.id), km: Number(l.km) }));
const placa = new Map<number, string>(propios.map((v: any) => [Number(v.id), String(v.placa)]));

console.log(`\nUSO DE FLOTA · datos reales del ${DESDE} al ${HASTA} (hoy ${hoyLima})`);
console.log(`${propios.length} unidad(es) propia(s) · ${terceros.length} tercerizada(s) · ${reservas.length} servicio(s) no cancelado(s) · ${lecturas.length} lectura(s) propias con contexto`);

const e: EntradaUso = {
  desde: DESDE, hasta: HASTA, hoy: hoyLima, ahoraMs: Date.now(),
  propios: propios.map((v: any) => ({ id: Number(v.id), placa: String(v.placa), estado: v.estado ?? null, categoria: v.categoria ?? null })),
  reservas, lecturas, paradasPorReserva: new Map(), kmGpsPorReserva: new Map(), sinMedirPorTope: new Set(), cargas: [],
};

// ── 1 · Cobertura del odómetro por placa ──────────────────────────────────────
linea("1 · DÍAS CON SERVICIO QUE TIENEN JORNADA DE ODÓMETRO COMPLETA, POR PLACA");
console.log("   Lo que no la tiene se rellena con el GPS de sus servicios (un piso) o queda sin dato.\n");
const js = jornadasUso(e).filter((j) => j.conServicio);
const porPlaca = new Map<number, { total: number; odo: number }>();
for (const j of js) {
  const a = porPlaca.get(j.vehiculoId) ?? { total: 0, odo: 0 };
  a.total++; if (j.fuente === "odometro") a.odo++;
  porPlaca.set(j.vehiculoId, a);
}
const filas1 = [...porPlaca].sort((x, y) => x[1].odo / x[1].total - y[1].odo / y[1].total);
for (const [v, a] of filas1) console.log(`   ${(placa.get(v) ?? `#${v}`).padEnd(10)} ${String(a.odo).padStart(3)} de ${String(a.total).padStart(3)} días con servicio  (${pct(a.odo, a.total)})`);
const tot = filas1.reduce((s, [, a]) => ({ total: s.total + a.total, odo: s.odo + a.odo }), { total: 0, odo: 0 });
console.log(`\n   FLOTA: ${tot.odo} de ${tot.total} jornadas con servicio tienen odómetro (${pct(tot.odo, tot.total)}).`);

// ── 2 · Relleno por GPS ───────────────────────────────────────────────────────
linea("2 · CUÁNTAS TRAZAS PEDIRÍA EL RELLENO POR GPS");
const cand = diasPorRellenarConGps(e);
console.log(`   ${cand.length} servicio(s) sin jornada de odómetro en el periodo (más los del periodo anterior, que la`);
console.log(`   pantalla también pide). Tope por consulta: MAX_TRAZAS_RELLENO = ${MAX_TRAZAS_RELLENO}.`);
console.log(cand.length > MAX_TRAZAS_RELLENO
  ? `   → ${cand.length - MAX_TRAZAS_RELLENO} quedarían «sin medir (tope)» solo en este periodo: subir el tope cuesta lecturas de GPS por consulta.`
  : "   → cabe entero en el tope (sin contar los que no corrieron, que no gastan cupo).");

// ── 3 · Terceros con tipo de costeo ──────────────────────────────────────────
linea("3 · UNIDADES TERCERIZADAS Y SU TIPO DE COSTEO");
const conTipoT = terceros.filter((t: any) => String(t.tipo_vehiculo_costeo ?? "").trim());
console.log(`   ${conTipoT.length} de ${terceros.length} tienen tipo_vehiculo_costeo (${pct(conTipoT.length, terceros.length)}).`);
console.log("   Sin él, su servicio no tiene combustible ni CO₂ estimado (se le paga factura, pero el CO₂ sí es de la flota que opera).");
const sinTipoT = terceros.filter((t: any) => !String(t.tipo_vehiculo_costeo ?? "").trim() && t.estado !== "inactivo");
if (sinTipoT.length) console.log(`   Activas sin tipo: ${sinTipoT.slice(0, 30).map((t: any) => t.placa).join(", ")}${sinTipoT.length > 30 ? ` y ${sinTipoT.length - 30} más` : ""}`);

// ── 4 · Propias sin tipo ──────────────────────────────────────────────────────
linea("4 · UNIDADES PROPIAS SIN TIPO DE COSTEO");
const sinTipoP = propios.filter((v: any) => !String(v.tipo_vehiculo_costeo ?? "").trim() && v.estado !== "inactivo");
console.log(sinTipoP.length
  ? `   ${sinTipoP.length} propia(s) activa(s) sin tipo_vehiculo_costeo: ${sinTipoP.map((v: any) => v.placa).join(", ")}`
  : "   Todas las propias activas tienen tipo de costeo.");

// ── 5 · El hallazgo de precioUltimaCarga ─────────────────────────────────────
linea("5 · ÚLTIMA CARGA CON PRECIO DE OTRA FAMILIA O EN LITROS (precioUltimaCarga)");
console.log("   `precioUltimaCarga` toma la última carga con precio de CUALQUIER combustible y unidad: si fue de otra");
console.log("   familia, urea o en litros, el presupuesto del servicio costea el combustible a ese precio.\n");
const famParam = new Map<string, string | null>(params.map((p: any) => [String(p.tipo_vehiculo), familiaDeParametro(p.tipo_combustible_1)]));
const ultima = new Map<number, any>();
for (const c of cargas) { const v = Number(c.vehiculo_id); if (!ultima.has(v)) ultima.set(v, c); }   // ya viene por fecha desc
let afectadas = 0, revisadas = 0;
for (const v of propios) {
  if (v.estado === "inactivo") continue;
  const c = ultima.get(Number(v.id));
  if (!c) continue;
  revisadas++;
  const famP = famParam.get(String(v.tipo_vehiculo_costeo ?? "")) ?? null;
  const famC = familiaEstrictaDeCarga(c.tipo_combustible);
  const canon = famC ? Object.values(COMBUSTIBLES).find((x) => x.familia === famC)?.unidad : null;
  const unidad = String(c.unidad ?? "").trim().toLowerCase();
  const motivos: string[] = [];
  if (famC === "urea") motivos.push("es urea");
  else if (famP && famC && famP !== famC) motivos.push(`es ${famC} y el parámetro costea ${famP}`);
  else if (!famC) motivos.push(`tipo «${c.tipo_combustible ?? "—"}» desconocido`);
  if (unidad && canon && unidad !== canon && !(canon === "m3")) motivos.push(`en ${unidad} (la familia va en ${canon})`);
  if (motivos.length) {
    afectadas++;
    console.log(`   ${String(v.placa).padEnd(10)} ${c.fecha} · S/ ${Number(c.precio_galon).toFixed(3)} · ${motivos.join("; ")}`);
  }
}
console.log(`\n   ${afectadas} de ${revisadas} unidad(es) con cargas tienen la última carga con precio fuera de su familia o unidad.`);

// ── 6 · km de ELIA, viejo contra nuevo ───────────────────────────────────────
linea("6 · KM DE ELIA: VIEJO (max − min de las aceptadas) CONTRA NUEVO (jornadas saneadas)");
console.log("   El nuevo nunca cuenta una lectura que no encaja o retrocede, una jornada con salto imposible ni los km entre");
console.log("   jornadas (de noche, o días sin lectura completa). La diferencia se explica por esas tres cosas.\n");
const kmNuevo = new Map<number, number>();
for (const j of jornadasUso(e)) if (j.fuente === "odometro" && j.km != null) kmNuevo.set(j.vehiculoId, (kmNuevo.get(j.vehiculoId) ?? 0) + j.km);
const enRango = lecturas.filter((l) => l.fecha >= DESDE && l.fecha <= HASTA);
for (const v of propios) {
  const id = Number(v.id);
  const acept = enRango.filter((l) => Number(l.vehiculo_id) === id && l.estado === "aceptada").map((l) => Number(l.km));
  const viejo = acept.length ? Math.max(0, Math.max(...acept) - Math.min(...acept)) : null;
  const nuevo = kmNuevo.get(id) ?? null;
  if (viejo == null && nuevo == null) continue;
  const propias = lecturas.filter((l) => Number(l.vehiculo_id) === id);
  const { limpias, descartadas } = sanearLecturas(propias);
  const enPeriodo = (d: { lectura: LecturaCruda }) => d.lectura.fecha >= DESDE && d.lectura.fecha <= HASTA;
  const noEncajan = descartadas.filter((d) => d.motivo === "no_encaja" && enPeriodo(d)).length;
  const retroceden = descartadas.filter((d) => d.motivo === "retrocede" && enPeriodo(d)).length;
  const saltos = recorridosDiarios(limpias).filter((d) => d.fecha >= DESDE && d.fecha <= HASTA && d.sospechosaId != null).length;
  const dif = viejo != null && nuevo != null ? viejo - nuevo : null;
  const causas = [
    noEncajan ? `${noEncajan} lectura(s) que no encajan` : "",
    retroceden ? `${retroceden} lectura(s) que retroceden` : "",
    saltos ? `${saltos} jornada(s) con salto imposible` : "",
  ].filter(Boolean).join(" · ");
  console.log(`   ${String(v.placa).padEnd(10)} viejo ${viejo == null ? "—" : n0(viejo).padStart(7)} · nuevo ${nuevo == null ? "—" : n0(nuevo).padStart(7)}${dif != null && dif !== 0 ? ` · Δ ${n0(dif)}` : ""}${causas ? ` · ${causas}` : ""}`);
}
console.log(`\n   Días del periodo: ${diasDelPeriodo(DESDE, HASTA).length}. Solo se leyó; no se escribió nada.\n`);
