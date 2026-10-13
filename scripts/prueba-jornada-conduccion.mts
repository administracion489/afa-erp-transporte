// Pruebas de la JORNADA DE CONDUCCIÓN y del SOLAPE (lib/alertas-flota.ts: ventanaConduccion,
// evaluarJornada, juzgarSolapes, detectarSolapesJornada). NO toca la base: todo en memoria.
// Uso:  npx tsx scripts/prueba-jornada-conduccion.mts   (sale con código 1 si algo falla)
//
// EL CASO (13-10-2026, torre de /seguimiento): los conductores de I.C. LOGÍSTICA (CWQ400,
// CWZ-371) salían con el chip JORNADA porque hacen ENTRADA de madrugada y RETORNO por la tarde, y
// entre los dos DESCANSAN — horario partido. La regla vieja medía «1ª salida → último fin > 13 h,
// o ≥ 4 servicios». La norma (RENAT, D.S. 017-2009-MTC, art. 30) mide CONDUCCIÓN:
//   · 30.7: jornada de conducción = tiempo conduciendo; la espera no cuenta;
//   · 30.2/30.9: ≤ 5 h continuas de día, ≤ 4 h de noche (30.3: 22:00–05:59), ≤ 10 h en 24 h;
//   · 30.5/30.9: descanso ≥ 1 h entre jornadas (≥ 30 min si la jornada fue < 2 h).
// LO QUE NO SE PUEDE AFLOJAR:
//   · el horario partido NO alarma (sección 1) y el algoritmo viejo SÍ lo hacía (regresión);
//   · conducir de más SÍ alarma, por las dos vías (secciones 2-4);
//   · alargar un descanso nunca crea una alerta (barrido, sección 6);
//   · el SOLAPE usa la misma ventana y el traslado entre servicios (sección 7): el algoritmo
//     anterior, copiado literal, reproduce el falso solape de la entrada y su retorno.

import {
  CONDUCCION_ACUMULADA_MAX_H, CONTINUA_DIURNA_MAX_MIN, CONTINUA_NOCTURNA_MAX_MIN, DESCANSO_CORTO_MIN, DESCANSO_MIN,
  FACTOR_RUTA, VEL_TRASLADO_KMH, detectarSolapesJornada, evaluarJornada, itinerarioDe, juzgarSolapes, solapeAfirmado,
  tituloSolape, trasladoMin, ventanaConduccion, type ReservaFlota, type VentanaConduccion,
} from "../lib/alertas-flota";
import { UMBRAL_DEFECTO, descripcionDe, notasHoy, type CfgTarjeta } from "../lib/alertas-tarjeta";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const V = (id: number, ini: string, fin: string, fuente: VentanaConduccion["fuente"] = "real"): VentanaConduccion => {
  const a = hm(ini); let b = hm(fin); if (b < a) b += 1440;
  return { reservaId: id, ini: a, fin: b, fuente };
};
const MAX10 = CONDUCCION_ACUMULADA_MAX_H * 60;

// ── El algoritmo VIEJO de la jornada, copiado literal de lib/alertas-flota.ts (antes del cambio) ──
function jornadaVieja(reservas: ReservaFlota[], opts: { jornadaMaxH: number; maxServicios: number }): Set<number> {
  const DUR_ESTIMADA_MIN = 240, DIA_MIN = 1440, DURACION_MAX_MIN = 26 * 60, DUR_MIN_FIABLE_MIN = 30;
  const aMin = (hhmm?: string | null) => { if (!hhmm) return null; const [h, m] = hhmm.split(":").map(Number); return Number.isNaN(h) ? null : h * 60 + (m || 0); };
  const duracionMin = (r: ReservaFlota, ini: number) => {
    const finCrudo = aMin(r.hora_real_fin);
    if (finCrudo == null) return DUR_ESTIMADA_MIN;
    const fin = finCrudo < ini ? finCrudo + DIA_MIN : finCrudo;
    const dur = fin - ini;
    if (dur > DURACION_MAX_MIN || dur < DUR_MIN_FIABLE_MIN) return DUR_ESTIMADA_MIN;
    return dur;
  };
  const intervalo = (r: ReservaFlota): [number, number] | null => { const ini = aMin(r.hora_servicio); if (ini == null) return null; return [ini, ini + duracionMin(r, ini)]; };
  const out = new Set<number>();
  const grupos = new Map<number, ReservaFlota[]>();
  for (const r of reservas) { if (r.estado === "cancelada" || !r.conductor_id) continue; (grupos.get(r.conductor_id) ?? grupos.set(r.conductor_id, []).get(r.conductor_id)!).push(r); }
  for (const g of grupos.values()) {
    const inicios = g.map(intervalo).filter((x): x is [number, number] => !!x).map((x) => x[0]);
    const fines = g.map(intervalo).filter((x): x is [number, number] => !!x).map((x) => x[1]);
    if (inicios.length && fines.length) {
      const spanH = (Math.max(...fines) - Math.min(...inicios)) / 60;
      if (spanH > opts.jornadaMaxH || g.length >= opts.maxServicios) for (const r of g) out.add(r.id);
    }
  }
  return out;
}
// ── El SOLAPE anterior, copiado literal (reproduce el falso positivo de la sección 7) ──
function solapeViejo(reservas: ReservaFlota[]): Map<number, number> {
  const DUR_ESTIMADA_MIN = 240, DIA_MIN = 1440, DURACION_MAX_MIN = 26 * 60, DUR_MIN_FIABLE_MIN = 30;
  const aMin = (hhmm?: string | null) => { if (!hhmm) return null; const [h, m] = hhmm.split(":").map(Number); return Number.isNaN(h) ? null : h * 60 + (m || 0); };
  const duracionMin = (r: ReservaFlota, ini: number) => {
    const finCrudo = aMin(r.hora_real_fin);
    if (finCrudo == null) return DUR_ESTIMADA_MIN;
    const fin = finCrudo < ini ? finCrudo + DIA_MIN : finCrudo;
    const dur = fin - ini;
    if (dur > DURACION_MAX_MIN || dur < DUR_MIN_FIABLE_MIN) return DUR_ESTIMADA_MIN;
    return dur;
  };
  const intervalo = (r: ReservaFlota): [number, number] | null => { const ini = aMin(r.hora_servicio); if (ini == null) return null; return [ini, ini + duracionMin(r, ini)]; };
  const solape = new Map<number, number>();
  const grupos = new Map<number, ReservaFlota[]>();
  for (const r of reservas) { if (r.estado === "cancelada" || !r.conductor_id) continue; (grupos.get(r.conductor_id) ?? grupos.set(r.conductor_id, []).get(r.conductor_id)!).push(r); }
  for (const [condId, g] of grupos) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const a = intervalo(g[i]), b = intervalo(g[j]);
    if (a && b && a[0] < b[1] && b[0] < a[1]) { solape.set(g[i].id, condId); solape.set(g[j].id, condId); }
  }
  return solape;
}

// ── 1. El caso real: horario partido de I.C. LOGÍSTICA ────────────────────────
{
  console.log("\n— Horario partido (I.C. LOGÍSTICA): entrada de madrugada, retorno de tarde, descanso en medio —");
  // CWZ-371 (Grover): 05:50 ENTRADA (salió 05:44), 07:00 RETORNO TURNO NOCHE (salió 06:42),
  // y la tarde: 17:50 ENTRADA TURNO NOCHE, 19:00 RETORNO TURNO DÍA. Cada uno ~1 h de itinerario.
  const dia: ReservaFlota[] = [
    { id: 1, estado: "finalizada", conductor_id: 7, hora_servicio: "05:50", hora_real_inicio: "05:44", hora_real_fin: "06:40", plan_inicio: "05:10", plan_fin: "05:50" },
    { id: 2, estado: "finalizada", conductor_id: 7, hora_servicio: "07:00", hora_real_inicio: "06:42", hora_real_fin: "07:45", plan_inicio: "07:00", plan_fin: "07:50" },
    { id: 3, estado: "programada", conductor_id: 7, hora_servicio: "17:50", plan_inicio: "17:10", plan_fin: "17:50" },
    { id: 4, estado: "programada", conductor_id: 7, hora_servicio: "19:00", plan_inicio: "19:00", plan_fin: "19:55" },
  ];
  const viejo = jornadaVieja(dia, { jornadaMaxH: 13, maxServicios: 4 });
  chk("regresión: el algoritmo VIEJO lo marcaba como jornada extensa", viejo.size === 4, [...viejo].join(","));
  const { jornada, veredictos } = detectarSolapesJornada(dia, { acumuladaMaxH: CONDUCCION_ACUMULADA_MAX_H });
  const v = veredictos.get(7)!;
  chk("el motor nuevo NO lo marca", jornada.size === 0 && !v.excede, v.motivo);
  chk("y publica la conducción real (≈ 3 h 20) en vez de la amplitud", v.conduccionMin > 150 && v.conduccionMin < 260, String(v.conduccionMin));
  chk("la amplitud (14 h) se publica como dato, no decide", v.amplitudMin > 13 * 60, String(v.amplitudMin));
  chk("el descanso del mediodía se ve como descanso", (v.descansoMayorMin ?? 0) > 8 * 60, String(v.descansoMayorMin));
  chk("nada estimado: todo salió del dato real o del itinerario", v.estimados === 0);
}

// ── 2. Conducción CONTINUA de día ─────────────────────────────────────────────
{
  console.log("\n— Más de 5 h seguidas de día sin descanso de 1 h —");
  const largas = evaluarJornada([V(1, "06:00", "08:30"), V(2, "08:45", "11:40")], { acumuladaMaxMin: MAX10 });
  chk("2 h 30 + pausa de 15 min + 2 h 55 = 5 h 25 seguidas → excede", largas.excede && largas.codigos.includes("continua"), largas.motivo);
  chk("el motivo nombra el tope de día y la norma", /5 h/.test(largas.motivo) && /RENAT/.test(largas.motivo) && !/\n/.test(largas.motivo), largas.motivo);
  const conDescanso = evaluarJornada([V(1, "06:00", "08:30"), V(2, "09:30", "12:25")], { acumuladaMaxMin: MAX10 });
  chk("la misma conducción con 1 h de descanso en medio → NO excede", !conDescanso.excede && conDescanso.bloques.length === 2, conDescanso.motivo);
  const justo = evaluarJornada([V(1, "06:00", "11:00")], { acumuladaMaxMin: MAX10 });
  chk("exactamente 5 h seguidas no pasa el tope (la norma dice «más de»)", !justo.excede);
  const unMin = evaluarJornada([V(1, "06:00", "11:01")], { acumuladaMaxMin: MAX10 });
  chk("5 h 01 sí", unMin.excede && unMin.codigos[0] === "continua");
}

// ── 3. De NOCHE el tope es 4 h; y la regla del descanso corto ─────────────────
{
  console.log("\n— Noche (22:00–05:59): 4 h; y 30 min bastan tras menos de 2 h —");
  const noche = evaluarJornada([V(1, "01:00", "05:30")], { acumuladaMaxMin: MAX10 });
  chk("4 h 30 de madrugada → excede (tope nocturno)", noche.excede && noche.bloques[0].nocturno && noche.bloques[0].limiteMin === CONTINUA_NOCTURNA_MAX_MIN, noche.motivo);
  chk("y el motivo dice «de noche»", /de noche/.test(noche.motivo));
  const madrugadaCorta = evaluarJornada([V(1, "04:35", "08:00")], { acumuladaMaxMin: MAX10 });
  chk("04:35–08:00 (mayoría de día) usa el tope de día y no excede", !madrugadaCorta.excede && !madrugadaCorta.bloques[0].nocturno);
  const cruza = evaluarJornada([V(1, "23:00", "03:30")], { acumuladaMaxMin: MAX10 });
  chk("un nocturno que cruza la medianoche se mide entero (4 h 30 → excede)", cruza.excede && cruza.conduccionMin === 270, String(cruza.conduccionMin));
  // Primer bloque de 1 h 30 (< 2 h): con 30 min de pausa ya descansó.
  const corto = evaluarJornada([V(1, "06:00", "07:30"), V(2, "08:00", "12:30")], { acumuladaMaxMin: MAX10 });
  chk("1 h 30 + 30 min + 4 h 30: el descanso corto basta, dos bloques, no excede", !corto.excede && corto.bloques.length === 2, JSON.stringify(corto.bloques.map((b) => b.conduccionMin)));
  // Primer bloque de 2 h 30: 40 min NO bastan → 2 h 30 + 4 h = 6 h 30 seguidas.
  const noBasta = evaluarJornada([V(1, "06:00", "08:30"), V(2, "09:10", "13:10")], { acumuladaMaxMin: MAX10 });
  chk("2 h 30 + 40 min + 4 h: tras ≥ 2 h hace falta 1 h → un bloque de 6 h 30 → excede", noBasta.excede && noBasta.bloques.length === 1 && noBasta.bloques[0].conduccionMin === 390);
  chk("las constantes son las de la norma", CONTINUA_DIURNA_MAX_MIN === 300 && CONTINUA_NOCTURNA_MAX_MIN === 240 && DESCANSO_MIN === 60 && DESCANSO_CORTO_MIN === 30);
}

// ── 4. Conducción ACUMULADA del día ───────────────────────────────────────────
{
  console.log("\n— El tope del día (10 h por norma, configurable) —");
  const tres = [V(1, "05:00", "09:00"), V(2, "10:00", "14:00"), V(3, "15:00", "17:30")]; // 10 h 30
  const v10 = evaluarJornada(tres, { acumuladaMaxMin: MAX10 });
  chk("10 h 30 al volante con descansos correctos → excede por acumulada (y solo por eso)", v10.excede && v10.codigos.join() === "acumulada", v10.motivo);
  const v12 = evaluarJornada(tres, { acumuladaMaxMin: 12 * 60 });
  chk("con el tope configurado en 12 h no excede", !v12.excede);
  const pisados = evaluarJornada([V(1, "06:00", "09:00"), V(2, "08:00", "10:00")], { acumuladaMaxMin: MAX10 });
  chk("dos servicios que se pisan no cuentan doble (unión: 4 h)", pisados.conduccionMin === 240);
  chk("UMBRAL_DEFECTO.jornada es el de la norma", UMBRAL_DEFECTO.jornada === CONDUCCION_ACUMULADA_MAX_H && CONDUCCION_ACUMULADA_MAX_H === 10);
}

// ── 5. La ventana de cada servicio: de la evidencia al supuesto ───────────────
{
  console.log("\n— ventanaConduccion: real > itinerario > bloque estimado —");
  const real = ventanaConduccion({ id: 1, hora_servicio: "05:50", hora_real_inicio: "05:29", hora_real_fin: "06:35", plan_inicio: "05:30", plan_fin: "05:50" })!;
  chk("con salida y fin reales manda lo real", real.fuente === "real" && real.ini === hm("05:29") && real.fin === hm("06:35"));
  const plan = ventanaConduccion({ id: 1, hora_servicio: "17:50", plan_inicio: "17:10", plan_fin: "17:50" })!;
  chk("sin datos reales, el itinerario (17:10–17:50)", plan.fuente === "plan" && plan.ini === hm("17:10") && plan.fin === hm("17:50"));
  const atrasado = ventanaConduccion({ id: 1, hora_servicio: "17:00", hora_real_inicio: "17:30", plan_inicio: "17:00", plan_fin: "18:00" })!;
  chk("salió tarde: la duración del itinerario se cuenta desde la salida real", atrasado.fuente === "plan" && atrasado.ini === hm("17:30") && atrasado.fin === hm("18:30"));
  const enCurso = ventanaConduccion({ id: 1, hora_servicio: "06:00", hora_real_inicio: "06:00", plan_inicio: "06:00", plan_fin: "07:00", en_curso_ahora: "08:20" })!;
  chk("en curso y atrasado: lleva al menos hasta ahora", enCurso.fin === hm("08:20"));
  const sinPlan = ventanaConduccion({ id: 1, hora_servicio: "08:00" })!;
  chk("sin nada más, el bloque de 4 h de siempre, DECLARADO estimado", sinPlan.fuente === "estimado" && sinPlan.fin - sinPlan.ini === 240);
  // El retorno con la semilla de la IDA (horas de la mañana): no es su itinerario.
  const retornoConIda = ventanaConduccion({ id: 1, hora_servicio: "17:00", plan_inicio: "05:30", plan_fin: "06:30" })!;
  chk("un itinerario a 11 h de la hora del servicio se descarta (retorno con la semilla de la ida)", retornoConIda.fuente === "estimado" && retornoConIda.ini === hm("17:00"));
  const nocturno = ventanaConduccion({ id: 1, hora_servicio: "22:00", hora_real_fin: "01:30" })!;
  chk("fin real tras la medianoche: 3 h 30, no 0", nocturno.fuente === "real" && nocturno.fin - nocturno.ini === 210);
  // ENTRADA cuya hora es la de LLEGADA a la planta, sin salida real ni itinerario: el fin real es
  // anterior a la hora del servicio. No es un viaje de 23 h.
  const entrada = ventanaConduccion({ id: 1, hora_servicio: "05:50", hora_real_fin: "05:40" })!;
  chk("fin real 10 min ANTES de la hora del servicio: no se suman 24 h", entrada.fin === hm("05:40") && entrada.fin - entrada.ini <= 240, JSON.stringify(entrada));
  const tour = ventanaConduccion({ id: 1, hora_servicio: "06:00", hora_real_fin: "21:00" })!;
  chk("un full day de 15 h sigue midiéndose entero", tour.fuente === "real" && tour.fin - tour.ini === 900);
  chk("sin ninguna hora no se ubica ni se inventa", ventanaConduccion({ id: 1 }) === null);
  // itinerarioDe: filas en orden, si no, la semilla.
  const it1 = itinerarioDe([{ orden: 2, hora_estimada: "06:10" }, { orden: 1, hora_estimada: "05:30" }, { orden: 3, hora_estimada: null }], null);
  chk("itinerarioDe ordena por `orden` y salta horas vacías", it1.inicio === "05:30" && it1.fin === "06:10");
  const it2 = itinerarioDe([], [{ tipo: "destino", hora: "07:00" }, { tipo: "inicio", hora: "06:00" }]);
  chk("sin filas, la semilla ordenada como el «Iniciar»", it2.inicio === "06:00" && it2.fin === "07:00");
  chk("con una sola hora no hay itinerario", itinerarioDe([{ orden: 1, hora_estimada: "06:00" }], null).inicio === null);
}

// ── 6. Barrido: invariantes ───────────────────────────────────────────────────
{
  console.log("\n— Barrido —");
  let casos = 0, alarmas = 0, horarioPartidoSinAlarma = 0;
  const malos: string[] = [];
  const DUR = [30, 60, 90, 150, 200, 280, 320];
  const PAUSA = [10, 25, 35, 55, 65, 120, 480];
  const INI = [hm("04:00"), hm("05:30"), hm("13:00"), hm("21:30")];
  for (const ini of INI) for (const d1 of DUR) for (const p1 of PAUSA) for (const d2 of DUR) for (const p2 of PAUSA) for (const d3 of [0, ...DUR]) {
    casos++;
    const vs: VentanaConduccion[] = [{ reservaId: 1, ini, fin: ini + d1, fuente: "real" }];
    const i2 = ini + d1 + p1; vs.push({ reservaId: 2, ini: i2, fin: i2 + d2, fuente: "real" });
    if (d3) { const i3 = i2 + d2 + p2; vs.push({ reservaId: 3, ini: i3, fin: i3 + d3, fuente: "real" }); }
    const v = evaluarJornada(vs, { acumuladaMaxMin: MAX10 });
    if (v.excede) alarmas++;
    // a) alarma ⟺ algún bloque pasa su tope ∨ la acumulada pasa el del día
    const oraculo = v.bloques.some((b) => b.conduccionMin > b.limiteMin) || v.conduccionMin > MAX10;
    if (v.excede !== oraculo) malos.push(`oráculo ${JSON.stringify(vs)}`);
    // b) la conducción es la suma de las duraciones (no se pisan)
    if (v.conduccionMin !== d1 + d2 + d3) malos.push(`suma ${JSON.stringify(vs)}`);
    // c) alargar el ÚLTIMO descanso nunca alarga un bloque ni la conducción del día. Lo único
    //    que puede crear una alerta es que el servicio corrido caiga DE NOCHE (tope de 4 h): el
    //    barrido lo encontró (17:45–22:25 corrido a 19:45–00:25) y es la norma, no un defecto.
    const mas = vs.map((x, k) => (k === vs.length - 1 ? { ...x, ini: x.ini + 120, fin: x.fin + 120 } : x));
    const v2 = evaluarJornada(mas, { acumuladaMaxMin: MAX10 });
    const maxB = (x: typeof v) => Math.max(...x.bloques.map((b) => b.conduccionMin));
    if (maxB(v2) > maxB(v) || v2.conduccionMin !== v.conduccionMin) malos.push(`descanso más largo alarga ${JSON.stringify(vs)}`);
    if (v2.excede && !v.excede && !v2.bloques.some((b) => b.excede && b.nocturno)) malos.push(`descanso más largo crea alerta ${JSON.stringify(vs)}`);
    // d) todo servicio corto con descansos de ≥ 1 h: jamás alarma, sea cual sea la amplitud
    if (d1 <= 200 && d2 <= 200 && d3 <= 200 && p1 >= 60 && (d3 === 0 || p2 >= 60) && d1 + d2 + d3 <= MAX10 && ini !== hm("21:30") && ini !== hm("04:00")) {
      if (v.excede) malos.push(`horario partido alarma ${JSON.stringify(vs)}`); else horarioPartidoSinAlarma++;
    }
    // e) el motivo es UNA línea (va como parámetro de plantilla de WhatsApp)
    if (/[\n\t]| {4}/.test(v.motivo) || !v.motivo.trim()) malos.push(`motivo ${JSON.stringify(v.motivo)}`);
  }
  chk(`${casos} combinaciones: alarma ⟺ un tope pasado; conducción = suma; un descanso más largo nunca alarga un bloque (solo la noche cambia el tope); motivo en una línea`, malos.length === 0, malos.slice(0, 3).join(" | "));
  chk("el horario partido con descansos de ≥ 1 h nunca alarma", horarioPartidoSinAlarma > 0);
  chk("corolario: el barrido SÍ produce alarmas (un motor que no alarmara nunca cumpliría todo)", alarmas > 0 && alarmas < casos, `${alarmas}/${casos}`);
}

// ── 7. El SOLAPE: ¿la unidad (o el conductor) llega de un servicio al otro? ───
// EL CASO (13-10-2026): «Posible solape de unidad» en una ENTRADA de las 05:50 y su RETORNO de las
// 07:00 de la misma planta. El dueño lo revisó: «el tiempo y la distancia sí le alcanzan, incluso
// con tráfico». La regla vieja suponía 4 h a todo servicio sin hora de fin real y no miraba dónde
// termina uno y empieza el otro.
const BASE = { lat: -12.05, lng: -77.05 };
const aKm = (km: number) => ({ lat: BASE.lat + km / 111.2, lng: BASE.lng });
const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const porUnidad = (r: ReservaFlota) => (r.vehiculo_id ? `v${r.vehiculo_id}` : r.vehiculo_tercero_id ? `vt${r.vehiculo_tercero_id}` : null);
const unaLinea = (t: string) => !!t.trim() && !/[\n\t]| {4}/.test(t) && !/undefined|NaN/.test(t);
{
  console.log("\n— Solape: el caso reportado (entrada 05:50 y retorno 07:00 desde la misma planta) —");
  const planta = aKm(0);
  const dia: ReservaFlota[] = [
    { id: 1, estado: "programada", vehiculo_id: 5, conductor_id: 7, hora_servicio: "05:50", plan_inicio: "05:10", plan_fin: "05:50", plan_origen: aKm(14), plan_destino: planta, rotulo: "OS-2026-000001" },
    { id: 2, estado: "programada", vehiculo_id: 5, conductor_id: 7, hora_servicio: "07:00", plan_inicio: "07:00", plan_fin: "07:50", plan_origen: planta, plan_destino: aKm(14), rotulo: "OS-2026-000002" },
  ];
  const viejo = solapeViejo(dia);
  chk("regresión: el algoritmo VIEJO los marcaba como solape (4 h supuestas a cada uno)", viejo.size === 2, [...viejo.keys()].join(","));
  const u = juzgarSolapes(dia, porUnidad);
  chk("el motor nuevo NO marca la unidad: 05:10–05:50 y 07:00–07:50, misma planta", u.size === 0, JSON.stringify([...u]));
  chk("ni al conductor (detectarSolapesJornada)", detectarSolapesJornada(dia, { acumuladaMaxH: 10 }).solapes.size === 0);
  // Y con el retorno saliendo de otra planta a 12 km (≈ 37 min estimados):
  const lejos = dia.map((r) => (r.id === 2 ? { ...r, plan_origen: aKm(12) } : r));
  chk("a 12 km con 70 min libres sigue alcanzando", juzgarSolapes(lejos, porUnidad).size === 0, `traslado ${trasladoMin(planta, aKm(12))} min`);
  const justo = lejos.map((r) => (r.id === 2 ? { ...r, hora_servicio: "06:20", plan_inicio: "06:20", plan_fin: "07:10" } : r));
  const j = juzgarSolapes(justo, porUnidad);
  chk("a 12 km con 30 min libres → traslado_justo, en los DOS servicios", j.get(1)?.nivel === "traslado_justo" && j.get(2)?.nivel === "traslado_justo", JSON.stringify([...j]));
  chk("el detalle nombra al otro servicio, las horas y el traslado estimado, en una línea",
    /OS-2026-000001 termina a las 05:50 y este sale a las 06:20/.test(j.get(2)!.detalle[0]) && /estima/.test(j.get(2)!.detalle[0]) && unaLinea(j.get(2)!.detalle[0]), j.get(2)?.detalle[0]);
  chk("trasladoMin: 10 km en línea recta ≈ 31 min; sin coordenadas, null",
    trasladoMin(aKm(0), aKm(10)) === Math.round(10 * FACTOR_RUTA / VEL_TRASLADO_KMH * 60) && trasladoMin(null, aKm(1)) === null && trasladoMin(aKm(0), undefined) === null);
}
{
  console.log("\n— Solape: los tres niveles —");
  // cruce: el primero terminó (real) DESPUÉS de que el segundo debía salir.
  const cruce = juzgarSolapes([
    { id: 1, vehiculo_id: 1, hora_servicio: "06:00", hora_real_inicio: "06:00", hora_real_fin: "08:10" },
    { id: 2, vehiculo_id: 1, hora_servicio: "08:00", plan_inicio: "08:00", plan_fin: "09:00" },
  ], porUnidad);
  chk("fin real 08:10 contra salida 08:00 → cruce de 10 min", cruce.get(1)?.nivel === "cruce" && cruce.get(2)?.nivel === "cruce" && /se pisan 10 min/.test(cruce.get(2)!.detalle[0]), cruce.get(2)?.detalle[0]);
  // cruce sin datos: salen con 20 min de diferencia, ninguna duración salva eso.
  const juntos = juzgarSolapes([{ id: 1, vehiculo_id: 1, hora_servicio: "06:00" }, { id: 2, vehiculo_id: 1, hora_servicio: "06:20" }], porUnidad);
  chk("sin itinerario pero 20 min entre salidas → cruce (no hace falta suponer duración)", juntos.get(2)?.nivel === "cruce" && /20 min después/.test(juntos.get(2)!.detalle[0]), juntos.get(2)?.detalle[0]);
  // posible: el primero no tiene itinerario ni fin; solo con las 4 h supuestas se pisaría.
  const dudoso: ReservaFlota[] = [
    { id: 1, vehiculo_id: 1, conductor_id: 3, hora_servicio: "06:00" },
    { id: 2, vehiculo_id: 1, conductor_id: 3, hora_servicio: "08:00", plan_inicio: "08:00", plan_fin: "09:00" },
  ];
  const p = juzgarSolapes(dudoso, porUnidad);
  chk("sin itinerario y 2 h después → posible (no se afirma)", p.get(1)?.nivel === "posible" && p.get(2)?.nivel === "posible" && !solapeAfirmado(p.get(1)) && /se le supusieron/.test(p.get(2)!.detalle[0]));
  const dj = detectarSolapesJornada(dudoso, { acumuladaMaxH: 10 });
  chk("el «posible» NO va al WhatsApp (solape) pero SÍ a la pantalla (solapes)", dj.solape.size === 0 && dj.solapes.get(1)?.nivel === "posible");
  chk("un choque afirmado SÍ va al WhatsApp", detectarSolapesJornada([
    { id: 1, conductor_id: 3, hora_servicio: "06:00", hora_real_inicio: "06:00", hora_real_fin: "08:10" },
    { id: 2, conductor_id: 3, hora_servicio: "08:00", plan_inicio: "08:00", plan_fin: "09:00" },
  ], { acumuladaMaxH: 10 }).solape.get(2) === 3);
  // Sin coordenadas el traslado no se juzga: 5 min libres no acusan a nadie.
  const sinGeo = juzgarSolapes([
    { id: 1, vehiculo_id: 1, hora_servicio: "06:00", plan_inicio: "06:00", plan_fin: "07:00" },
    { id: 2, vehiculo_id: 1, hora_servicio: "07:05", plan_inicio: "07:05", plan_fin: "08:00" },
  ], porUnidad);
  chk("sin coordenadas no se acusa un traslado (no se afirma por falta de un dato)", sinGeo.size === 0);
  // En curso y atrasado: el texto no inventa una hora de término.
  const curso = juzgarSolapes([
    { id: 1, vehiculo_id: 1, estado: "en_curso", hora_servicio: "06:00", hora_real_inicio: "06:00", plan_inicio: "06:00", plan_fin: "07:00", en_curso_ahora: "07:20", rotulo: "A" },
    { id: 2, vehiculo_id: 1, hora_servicio: "07:10", plan_inicio: "07:10", plan_fin: "08:00" },
  ], porUnidad);
  chk("en curso a las 07:20 con el siguiente a las 07:10 → cruce, «sigue en curso» (no «termina»)",
    curso.get(2)?.nivel === "cruce" && /sigue en curso a las 07:20/.test(curso.get(2)!.detalle[0]) && !/termina/.test(curso.get(2)!.detalle[0]), curso.get(2)?.detalle[0]);
  // Canceladas fuera; y la unidad propia 1 no es la tercerizada 1.
  chk("una cancelada no choca con nada", juzgarSolapes([
    { id: 1, vehiculo_id: 1, estado: "cancelada", hora_servicio: "06:00" }, { id: 2, vehiculo_id: 1, hora_servicio: "06:10" },
  ], porUnidad).size === 0);
  chk("vehiculo_id 1 y vehiculo_tercero_id 1 son unidades distintas", juzgarSolapes([
    { id: 1, vehiculo_id: 1, hora_servicio: "06:00" }, { id: 2, vehiculo_tercero_id: 1, hora_servicio: "06:10" },
  ], porUnidad).size === 0);
  // El peor nivel manda: un servicio con un «posible» y un «cruce» se pinta como cruce.
  const mezcla = juzgarSolapes([
    { id: 1, vehiculo_id: 1, hora_servicio: "06:00" },
    { id: 2, vehiculo_id: 1, hora_servicio: "08:00", hora_real_inicio: "08:00", hora_real_fin: "10:00" },
    { id: 3, vehiculo_id: 1, hora_servicio: "09:30", plan_inicio: "09:30", plan_fin: "10:30" },
  ], porUnidad);
  chk("con varios choques manda el peor, y se listan todos", mezcla.get(2)?.nivel === "cruce" && mezcla.get(2)!.con.length === 2 && mezcla.get(2)!.detalle.length === 2, JSON.stringify(mezcla.get(2)));
  chk("y el texto del peor va PRIMERO (es el que viaja en el WhatsApp)", /se pisan/.test(mezcla.get(2)!.detalle[0]) && /se le supusieron/.test(mezcla.get(2)!.detalle[1]), JSON.stringify(mezcla.get(2)?.detalle));
  chk("los titulares no confunden los niveles", tituloSolape("cruce", "unidad") !== tituloSolape("posible", "unidad")
    && /sin confirmar/.test(tituloSolape("posible", "conductor")) && !/sin confirmar/.test(tituloSolape("cruce", "conductor") + tituloSolape("traslado_justo", "unidad")));
}
{
  console.log("\n— Solape: barrido —");
  // Dos servicios de la misma unidad. El oráculo se escribe aparte, desde la ventana de cada uno.
  const PESO = { posible: 1, traslado_justo: 2, cruce: 3 } as const;
  const peor = (m: Map<number, { nivel: keyof typeof PESO }>) => Math.max(0, ...[...m.values()].map((x) => PESO[x.nivel]));
  let casos = 0; const malos: string[] = []; const vistos = new Set<string>();
  const A_DUR = [null, 40, 90, 200], A_REAL = [false, true], B_OFF = [10, 25, 45, 70, 120, 200, 260, 330], B_DUR = [null, 50];
  const GEO: (number | null)[] = [null, 0, 5, 15, 30];
  for (const aIni of [hm("05:50"), hm("13:00")]) for (const aDur of A_DUR) for (const aReal of A_REAL) for (const off of B_OFF) for (const bDur of B_DUR) for (const km of GEO) {
    casos++;
    const mk = (bOff: number): ReservaFlota[] => [
      { id: 1, vehiculo_id: 9, hora_servicio: hhmm(aIni),
        ...(aDur != null ? { plan_inicio: hhmm(aIni), plan_fin: hhmm(aIni + aDur) } : {}),
        ...(aReal ? { hora_real_inicio: hhmm(aIni), hora_real_fin: hhmm(aIni + 75) } : {}),
        plan_destino: km == null ? null : aKm(0) },
      { id: 2, vehiculo_id: 9, hora_servicio: hhmm(aIni + bOff),
        ...(bDur != null ? { plan_inicio: hhmm(aIni + bOff), plan_fin: hhmm(aIni + bOff + bDur) } : {}),
        plan_origen: km == null ? null : aKm(km) },
    ];
    const rs = mk(off);
    const out = juzgarSolapes(rs, porUnidad);
    // Oráculo: desde las ventanas, ordenadas por salida.
    const [x, y] = rs.map((r) => ventanaConduccion(r)!).sort((p, q) => p.ini - q.ini || p.fin - q.fin);
    const rx = rs.find((r) => r.id === x.reservaId)!, ry = rs.find((r) => r.id === y.reservaId)!;
    let esperado: string | null = null;
    if (y.ini < x.fin) esperado = x.fuente !== "estimado" || y.ini - x.ini < 30 ? "cruce" : "posible";
    else if (x.fuente !== "estimado") { const t = trasladoMin(rx.plan_destino, ry.plan_origen); if (t != null && y.ini - x.fin < t) esperado = "traslado_justo"; }
    const n1 = out.get(1)?.nivel ?? null, n2 = out.get(2)?.nivel ?? null;
    if (n1 !== esperado || n2 !== esperado) malos.push(`oráculo esperaba ${esperado}, dio ${n1}/${n2}: ${JSON.stringify(rs)}`);
    vistos.add(String(esperado));
    // simetría: si 1 choca con 2, 2 choca con 1
    if (!!out.get(1)?.con.includes(2) !== !!out.get(2)?.con.includes(1)) malos.push(`asimétrico ${JSON.stringify(rs)}`);
    // sin coordenadas no hay traslado_justo; sin nada estimado no hay posible
    if (km == null && (n1 === "traslado_justo")) malos.push(`traslado sin coordenadas ${JSON.stringify(rs)}`);
    if (x.fuente !== "estimado" && y.fuente !== "estimado" && n1 === "posible") malos.push(`posible sin supuesto ${JSON.stringify(rs)}`);
    // nada afirmado sale SOLO de suponer 4 h: si el primero es estimado y salen con ≥ 30 min, no se afirma
    if (x.fuente === "estimado" && y.ini - x.ini >= 30 && solapeAfirmado(out.get(1))) malos.push(`afirmado por supuesto ${JSON.stringify(rs)}`);
    // separar más al segundo nunca empeora el nivel
    if (peor(juzgarSolapes(mk(off + 30), porUnidad)) > peor(out)) malos.push(`separar empeora ${JSON.stringify(rs)}`);
    for (const v of out.values()) for (const t of v.detalle) if (!unaLinea(t)) malos.push(`detalle ${JSON.stringify(t)}`);
  }
  chk(`${casos} combinaciones: coincide con el oráculo; simétrico; sin coordenadas no hay traslado; nada se afirma por un supuesto; separar nunca empeora; detalle en una línea`, malos.length === 0, malos.slice(0, 2).join(" | "));
  chk("corolario: el barrido produce los tres niveles y también días sin solape", ["cruce", "traslado_justo", "posible", "null"].every((k) => vistos.has(k)), [...vistos].join(","));
}

// ── 8. La tarjeta dice lo que hace el motor ───────────────────────────────────
{
  console.log("\n— La tarjeta de /configuracion/operaciones —");
  const cfg = (x: Partial<CfgTarjeta> = {}): CfgTarjeta => ({
    clave: "jornada", activo: true, modo_tiempo: "hora_fija", min_anticipacion: null, hora_fija: "07:00", umbral: null,
    notifica_conductor: false, notifica_conductor_tercero: false, plantilla: "tpl", plantilla_directorio: "coordinador_alerta", ...x,
  });
  const ctx = { contactos: () => 2, persistenciaPuntoMin: 10, cadenciaCheckoutMin: 60 };
  const d = descripcionDe(cfg(), ctx);
  chk("habla de horas al volante y de horario partido, no de amplitud ni de servicios", /volante/.test(d) && /horario partido/.test(d) && !/servicios o más/.test(d), d);
  chk("con el umbral sembrado (13) avisa en ámbar que pasa la norma", notasHoy("jornada", new Map([["jornada", cfg({ umbral: 13 })]]), ctx).some((x) => x.codigo === "umbral_sobre_norma" && x.alarma));
  chk("con 10 (o sin umbral) no avisa", !notasHoy("jornada", new Map([["jornada", cfg({ umbral: 10 })]]), ctx).some((x) => x.alarma)
    && !notasHoy("jornada", new Map([["jornada", cfg()]]), ctx).some((x) => x.alarma));
  chk("apagada no alarma", !notasHoy("jornada", new Map([["jornada", cfg({ umbral: 13, activo: false })]]), ctx).some((x) => x.alarma));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
