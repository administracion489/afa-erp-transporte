// Pruebas de la JORNADA DE CONDUCCIÓN (lib/alertas-flota.ts: ventanaConduccion, evaluarJornada,
// detectarSolapesJornada). NO toca la base: todo en memoria.
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
//   · el SOLAPE no cambió (sección 7, contra el algoritmo anterior copiado literal).

import {
  CONDUCCION_ACUMULADA_MAX_H, CONTINUA_DIURNA_MAX_MIN, CONTINUA_NOCTURNA_MAX_MIN, DESCANSO_CORTO_MIN, DESCANSO_MIN,
  detectarSolapesJornada, evaluarJornada, itinerarioDe, ventanaConduccion,
  type ReservaFlota, type VentanaConduccion,
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
// ── El SOLAPE anterior, copiado literal (no debe cambiar) ──
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

// ── 7. El solape no cambió ────────────────────────────────────────────────────
{
  console.log("\n— Solape: idéntico al algoritmo anterior —");
  const HORAS = ["05:00", "05:50", "07:00", "09:30", "13:00", "17:50", "19:00", "22:00", null];
  const FINES = [null, "06:00", "07:30", "11:00", "01:30", "05:40", "20:10"];
  let dif = 0, n = 0;
  for (let k = 0; k < 600; k++) {
    const rs: ReservaFlota[] = [];
    for (let i = 0; i < 4; i++) {
      const x = (k * 7 + i * 13) % HORAS.length, y = (k * 3 + i * 5) % FINES.length;
      rs.push({ id: i + 1, conductor_id: 1 + ((k + i) % 2), estado: (k + i) % 9 === 0 ? "cancelada" : "programada", hora_servicio: HORAS[x], hora_real_fin: FINES[y] });
    }
    n++;
    const a = solapeViejo(rs), b = detectarSolapesJornada(rs, { acumuladaMaxH: 10 }).solape;
    if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) dif++;
  }
  chk(`${n} días: el solape coincide con el algoritmo anterior`, dif === 0, `${dif} distintos`);
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
