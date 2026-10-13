// Pruebas del MAPA DE /monitoreo: lib/monitoreo-estado.ts (motor PURO). NO tocan la base.
// Uso:  npx tsx scripts/prueba-monitoreo-estado.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. EL ALGORITMO VIEJO de app/monitoreo/page.tsx, copiado literal (ventana de 30 min, limit 500,
//      keyGps por conductor, `find`, colores 2/10), y sus cuatro defectos: la unidad DESAPARECE al
//      minuto 31; un cierre de servicio sale ROJO a los 11 min; con 20 buses cada 10 s la consulta
//      solo cubre ~4 min y una unidad parada hace 5 min se pierde; un relevo son DOS marcadores y,
//      tras un INSERT del realtime, `find` devuelve la fila VIEJA. Y el motor nuevo arregla los cuatro.
//   2. Un caso por código y las fronteras exactas: 2 min vs 2 min + 1 s, 5 min vs 5 min + 1 s,
//      hora + umbral ± 1 s y el tope de la ventana del «no inició».
//   3. EL BARRIDO (edad × estado del punto × precisión × servicio del punto × servicios × SOS ×
//      lectura × GPS congelado) contra un ORÁCULO escrito aparte, con las invariantes: atender ⟹
//      (sos ∨ en curso ∨ no inició); sin nada de eso, NUNCA rojo ni ámbar; dibujar ⟺ posición ∧
//      lectura; una lectura fallida nunca es «sin posición»; edad ≥ 0. Y el corolario: el rojo SÍ
//      aparece con un servicio en curso y la posición vieja (un motor que nunca alarmara cumpliría
//      lo demás de forma trivial).
//   4. `ultimaPosicion`: descarta lo inválido, aplica la edad (fix_ts / recibido_en / ahora) y la
//      regla del cierre impreciso. Una precisión ≤ 0 o no numérica es DESCONOCIDA (la app del
//      tercerizado escribe 0 cuando no la sabe, y siempre en el cierre): mismo trato que null. CICLO: plegar `fusionarPosicion` en CUALQUIER orden de llegada
//      (y pasando por JSON entre fila y fila, como viaja de la API al navegador) da lo mismo.
//   5. Los ids se solapan: la unidad 12 propia y la 12 tercerizada son dos claves.
//   6. `resumenFlota` es disjunto y exhaustivo.
//   7. Los rótulos de tiempo alrededor de la medianoche de LIMA (no de UTC).
import {
  EN_LINEA_MIN, DIAS_ULTIMA_POSICION, FILAS_POR_UNIDAD, VENTANA_NO_INICIO_MIN,
  SENAL_PERDIDA_MIN as SENAL_RE, PRECISION_MAX_M as PRECISION_RE, NO_INICIO_MIN_DEFECTO as NO_INICIO_RE,
  CODIGOS_MONITOREO, CLASES_MONITOREO, TEXTO_CODIGO, COLOR_CLASE,
  unidadDeFila, unidadVigente, ultimaPosicion, fusionarPosicion, inicioServicioMs,
  juzgarUnidad, resumenFlota, rotuloEdad, rotuloMomento,
  type FilaGpsMonitoreo, type PosicionUnidad, type ServicioUnidad, type CodigoMonitoreo, type VeredictoUnidad,
} from "../lib/monitoreo-estado";
import { SENAL_PERDIDA_MIN, PRECISION_MAX_M } from "../lib/gps-cobertura";
import { NO_INICIO_MIN_DEFECTO } from "../lib/escalera-inicio";
import { claveUnidad } from "../lib/flota/excesos";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const MIN = 60_000, H = 3_600_000, DIA = 86_400_000;
/** 2026-10-13 12:00 en Lima (17:00 UTC). */
const T = Date.UTC(2026, 9, 13, 17, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const LAT = -12.0464, LNG = -77.0428;

let semilla = 20261013;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const elegir = <X,>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
function barajar<X>(xs: X[]): X[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Una fila sana de la unidad p:5: creada hace `edad`, recibida medio segundo después, fix = creada. */
function fila(edadMs: number, o: Partial<FilaGpsMonitoreo> = {}): FilaGpsMonitoreo {
  const c = T - edadMs;
  return {
    lat: LAT + edadMs / 1e9, lng: LNG, created_at: iso(c), fix_ts: iso(c), recibido_en: iso(c + 500),
    simulado: false, precision_m: 10, estado: "en_ruta", reserva_id: 50, velocidad: 30,
    vehiculo_id: 5, vehiculo_tercero_id: null, conductor_id: 1, conductor_tercero_id: null,
    ...o,
  };
}
const posDe = (edadMs: number, o: Partial<FilaGpsMonitoreo> = {}) => ultimaPosicion([fila(edadMs, o)], T)!;
const juzgar = (posicion: PosicionUnidad | null, servicios: ServicioUnidad[] = [], o: { sos?: boolean; lecturaOk?: boolean; umbral?: number; ahora?: number } = {}) =>
  juzgarUnidad({ posicion, servicios, lecturaOk: o.lecturaOk ?? true, sosPendiente: o.sos ?? false, ahoraMs: o.ahora ?? T, noInicioMin: o.umbral ?? 10 });
const svc = (reservaId: number, estado: string, inicioMs: number | null): ServicioUnidad => ({ reservaId, estado, inicioMs });

// ══ 0. CONSTANTES Y REUTILIZACIÓN ═════════════════════════════════════════════════════════
console.log("\n0. Constantes");
chk("EN_LINEA_MIN 2 · DIAS_ULTIMA_POSICION 30 · FILAS_POR_UNIDAD 5 · VENTANA_NO_INICIO_MIN 120",
  EN_LINEA_MIN === 2 && DIAS_ULTIMA_POSICION === 30 && FILAS_POR_UNIDAD === 5 && VENTANA_NO_INICIO_MIN === 120);
chk("SENAL_PERDIDA_MIN es el de lib/gps-cobertura.ts (5), no una copia", SENAL_RE === SENAL_PERDIDA_MIN && SENAL_RE === 5);
chk("PRECISION_MAX_M es el de lib/gps-cobertura.ts (150)", PRECISION_RE === PRECISION_MAX_M && PRECISION_RE === 150);
chk("NO_INICIO_MIN_DEFECTO es el de lib/escalera-inicio.ts (10)", NO_INICIO_RE === NO_INICIO_MIN_DEFECTO && NO_INICIO_RE === 10);
chk("los colores del plan", COLOR_CLASE.atender === "#dc2626" && COLOR_CLASE.vivo === "#16a34a" && COLOR_CLASE.demora === "#d97706"
  && COLOR_CLASE.reposo === "#64748b" && COLOR_CLASE.sin_dato === "#94a3b8");
chk("TEXTO_CODIGO cubre los 9 códigos y su color es el de su clase",
  CODIGOS_MONITOREO.length === 9 && CODIGOS_MONITOREO.every((c) => TEXTO_CODIGO[c] && TEXTO_CODIGO[c].color === COLOR_CLASE[TEXTO_CODIGO[c].clase] && TEXTO_CODIGO[c].etiqueta));

// ══ 1. EL ALGORITMO VIEJO (app/monitoreo/page.tsx), copiado literal ═══════════════════════
// Lo único adaptado: la consulta a Supabase se simula sobre un array con la misma semántica
// (`.gte("created_at", hace30min).order("timestamp", desc).limit(500)`), y el reloj (`Date.now`) se
// fija por la duración de cada llamada. Las funciones están tal cual.
type UbicacionGPS = {
  id: number; vehiculo_id: number | null; conductor_id: number | null;
  conductor_tercero_id: number | null; vehiculo_tercero_id: number | null;
  reserva_id: number | null;
  lat: number; lng: number; velocidad: number; rumbo: number;
  estado: string; timestamp: string;
  created_at: string;            // (la consulta filtra por ella; el tipo de la página no la declaraba)
};
function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}
function estadoColor(min: number): string {
  if (min <= 2)  return "#16a34a";
  if (min <= 10) return "#d97706";
  return "#dc2626";
}
function estadoLabel(min: number): string {
  if (min <= 2)  return "En línea";
  if (min <= 10) return "Hace " + min + "m";
  return "Sin señal";
}
function keyGps(u: { reserva_id?: number | null; conductor_tercero_id?: number | null; conductor_id?: number | null; vehiculo_tercero_id?: number | null; vehiculo_id?: number | null; id?: number }): string {
  if (u.conductor_tercero_id != null) return `ct${u.conductor_tercero_id}`;
  if (u.conductor_id != null) return `c${u.conductor_id}`;
  if (u.vehiculo_tercero_id != null) return `vt${u.vehiculo_tercero_id}`;
  if (u.vehiculo_id != null) return `v${u.vehiculo_id}`;
  if (u.reserva_id != null) return `r${u.reserva_id}`;
  return `id${u.id}`;
}
const DateNowReal = Date.now;
function conReloj<X>(t: number, fn: () => X): X {
  Date.now = () => t;
  try { return fn(); } finally { Date.now = DateNowReal; }
}
/** supabase.from("ubicaciones_gps").select("*").gte("created_at", hace30min).order("timestamp", { ascending: false }).limit(500) */
function consultaVieja(tabla: UbicacionGPS[]): UbicacionGPS[] {
  const hace30min = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  return tabla
    .filter((u) => Date.parse(u.created_at) >= Date.parse(hace30min))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 500);
}
/** `actualizarUbicaciones`, literal salvo la consulta. Devuelve lo que se ponía en el estado. */
function actualizarUbicacionesViejo(tabla: UbicacionGPS[]): UbicacionGPS[] {
  const data = consultaVieja(tabla);
  const latest: Record<string, UbicacionGPS> = {};
  data.forEach((u: UbicacionGPS) => {
    const key = keyGps(u);
    if (!latest[key] || new Date(u.timestamp) > new Date(latest[key].timestamp)) {
      latest[key] = u;
    }
  });
  return Object.values(latest);
}
/** El canal realtime: `setUbicaciones(prev => { const sin = prev.filter(...); return [...sin, nueva]; })`. */
function insertRealtimeViejo(prev: UbicacionGPS[], nueva: UbicacionGPS): UbicacionGPS[] {
  const keyNueva = keyGps(nueva);
  const sin = prev.filter((u) => keyGps(u) !== keyNueva);
  return [...sin, nueva];
}
/** Los marcadores: uno por keyGps; los que no vienen se BORRAN. */
const marcadoresViejos = (ubic: UbicacionGPS[]) => new Set(ubic.map((u) => keyGps(u)));
/** `ubicDeMovil`, literal. */
const ubicDeMovilViejo = (ubicaciones: UbicacionGPS[], m: { id: number; esTercero: boolean }): UbicacionGPS | undefined =>
  ubicaciones.find((u) => (m.esTercero ? u.vehiculo_tercero_id === m.id : u.vehiculo_id === m.id));

let sigId = 1;
function filaVieja(ts: number, o: Partial<UbicacionGPS> = {}): UbicacionGPS {
  return {
    id: sigId++, vehiculo_id: 5, conductor_id: 1, conductor_tercero_id: null, vehiculo_tercero_id: null, reserva_id: null,
    lat: LAT, lng: LNG, velocidad: 0, rumbo: 0, estado: "disponible", timestamp: iso(ts), created_at: iso(ts), ...o,
  };
}
/** La misma fila leída por el motor nuevo (recibido_en = created_at; sin precisión declarada). */
const aNueva = (u: UbicacionGPS): FilaGpsMonitoreo => ({
  lat: u.lat, lng: u.lng, created_at: u.created_at, recibido_en: u.created_at, estado: u.estado, reserva_id: u.reserva_id,
  velocidad: u.velocidad, vehiculo_id: u.vehiculo_id, vehiculo_tercero_id: u.vehiculo_tercero_id,
  conductor_id: u.conductor_id, conductor_tercero_id: u.conductor_tercero_id,
});

console.log("\n1. El algoritmo viejo reproduce sus defectos; el nuevo los arregla");
{
  // 1a · la unidad parada desaparece al minuto 31
  const tabla = [40, 35, 32, 31].map((m) => filaVieja(T - m * MIN, { vehiculo_id: 7, conductor_id: 3 }));
  const viejo = conReloj(T, () => marcadoresViejos(actualizarUbicacionesViejo(tabla)));
  chk("VIEJO: parada hace 31 min → sin marcador (desaparece del mapa)", !viejo.has("c3"), `${[...viejo]}`);
  const tabla29 = [40, 35, 29].map((m) => filaVieja(T - m * MIN, { vehiculo_id: 7, conductor_id: 3 }));
  const u29 = conReloj(T, () => actualizarUbicacionesViejo(tabla29))[0];
  const color29 = conReloj(T, () => estadoColor(minutosDesde(u29.timestamp)));
  chk("VIEJO: parada hace 29 min y sin servicio → ROJO «Sin señal»", color29 === "#dc2626" && conReloj(T, () => estadoLabel(minutosDesde(u29.timestamp))) === "Sin señal");
  const nueva = ultimaPosicion(tabla.map(aNueva), T);
  const v = juzgar(nueva);
  chk("NUEVO: sigue en el mapa, en GRIS, en su última posición", nueva != null && v.dibujar && v.codigo === "reposo" && v.color === "#64748b" && v.atenuado,
    `${v.codigo} · ${v.detalle}`);
  chk("NUEVO: y dice cuánto hace («hace 31 min»)", v.detalle === "Última posición hace 31 min", v.detalle);

  // 1b · un cierre de servicio sale rojo a los 11 min
  const cierre = filaVieja(T - 11 * MIN, { vehiculo_id: 8, conductor_id: 4, estado: "finalizado", reserva_id: 70 });
  const u = conReloj(T, () => actualizarUbicacionesViejo([cierre]))[0];
  chk("VIEJO: cierre de servicio hace 11 min → ROJO", conReloj(T, () => estadoColor(minutosDesde(u.timestamp))) === "#dc2626");
  const vc = juzgar(ultimaPosicion([aNueva(cierre)], T), [svc(70, "finalizada", T - 2 * H)]);
  chk("NUEVO: «Cerró servicio · 11:49», gris", vc.codigo === "finalizado" && vc.color === "#64748b" && vc.detalle.startsWith("Cerró servicio · 11:49"), vc.detalle);

  // 1c · 20 buses cada 10 s: la consulta de 500 filas cubre ~4 min
  const tabla20: UbicacionGPS[] = [];
  for (let b = 1; b <= 20; b++) for (let k = 0; k < 180; k++) {
    tabla20.push(filaVieja(T - k * 10_000, { vehiculo_id: 100 + b, conductor_id: 100 + b, estado: "en_ruta" }));
  }
  const conX = (edadMin: number) => {
    const filasX: UbicacionGPS[] = [];
    for (let t = T - 30 * MIN; t <= T - edadMin * MIN; t += 10_000) filasX.push(filaVieja(t, { vehiculo_id: 200, conductor_id: 200 }));
    return { tabla: [...tabla20, ...filasX], filasX };
  };
  const data = conReloj(T, () => consultaVieja(conX(5).tabla));
  const corteMin = (T - Math.min(...data.map((u) => Date.parse(u.timestamp)))) / MIN;
  chk("VIEJO: con 20 buses cada 10 s, las 500 filas cubren solo los últimos ~4 min", corteMin < 4.5, `${corteMin.toFixed(2)} min`);
  const c5 = conX(5);
  chk("VIEJO: una unidad parada hace 5 min (dentro de los 30) se pierde", !conReloj(T, () => marcadoresViejos(actualizarUbicacionesViejo(c5.tabla))).has("c200"));
  chk("VIEJO: la misma unidad parada hace 3 min sí sale (el corte es la cola de 500)", conReloj(T, () => marcadoresViejos(actualizarUbicacionesViejo(conX(3).tabla))).has("c200"));
  const ultimasX = c5.filasX.slice(-FILAS_POR_UNIDAD).map(aNueva);
  const px = ultimaPosicion(ultimasX, T);
  chk("NUEVO: leyendo POR UNIDAD (5 filas), la de hace 5 min sigue en el mapa", px != null && juzgar(px).dibujar && Math.round((T - px.posicionTs) / MIN) === 5);

  // 1d · el relevo: dos conductores en el mismo bus
  const relevo: UbicacionGPS[] = [];
  for (let t = T - 10 * MIN; t <= T - 4 * MIN; t += 30_000) relevo.push(filaVieja(t, { conductor_id: 1, estado: "en_ruta", reserva_id: 50 }));
  for (let t = T - 3 * MIN; t <= T - 30_000; t += 30_000) relevo.push(filaVieja(t, { conductor_id: 2, estado: "en_ruta", reserva_id: 50 }));
  const poll = conReloj(T, () => actualizarUbicacionesViejo(relevo));
  const marcas5 = [...marcadoresViejos(poll)].filter((k) => k === "c1" || k === "c2");
  chk("VIEJO: un relevo son DOS marcadores para un solo bus", marcas5.length === 2, marcas5.join(","));
  const insert = filaVieja(T, { conductor_id: 2, estado: "en_ruta", reserva_id: 50 });
  const tras = insertRealtimeViejo(poll, insert);
  const encontrada = ubicDeMovilViejo(tras, { id: 5, esTercero: false })!;
  chk("VIEJO: tras un INSERT, la lista toma la fila VIEJA (del conductor que ya bajó)", encontrada.conductor_id === 1
    && conReloj(T, () => estadoLabel(minutosDesde(encontrada.timestamp))) === "Hace 4m", `conductor ${encontrada.conductor_id}`);
  const pn = ultimaPosicion(relevo.map(aNueva), T)!;
  const pn2 = fusionarPosicion(pn, aNueva(insert), T)!;
  chk("NUEVO: una sola unidad (p:5) y la fila más reciente, del conductor que va", pn.unidad === "p:5" && pn.conductor === "p:2" && pn2.posicionTs === T && pn2.conductor === "p:2");
  chk("NUEVO: en línea y en servicio", juzgar(pn2, [svc(50, "en_curso", T - H)]).codigo === "en_linea");
}

// ══ 2. UN CASO POR CÓDIGO Y LAS FRONTERAS ═════════════════════════════════════════════════
console.log("\n2. Códigos y fronteras");
{
  const enCurso = [svc(50, "en_curso", T - H)];
  chk("en_linea: posición de ahora", juzgar(posDe(0)).codigo === "en_linea");
  chk("en_linea: exactamente 2 min", juzgar(posDe(2 * MIN)).codigo === "en_linea");
  chk("2 min + 1 s sin servicio → reposo (nunca ámbar)", juzgar(posDe(2 * MIN + 1000)).codigo === "reposo");
  chk("2 min + 1 s en servicio → demora", juzgar(posDe(2 * MIN + 1000), enCurso).codigo === "demora");
  chk("exactamente 5 min en servicio → demora", juzgar(posDe(5 * MIN), enCurso).codigo === "demora");
  const sp = juzgar(posDe(5 * MIN + 1000), enCurso);
  chk("5 min + 1 s en servicio → senal_perdida, rojo", sp.codigo === "senal_perdida" && sp.color === "#dc2626" && sp.clase === "atender");
  const sp7 = juzgar(posDe(7 * MIN), enCurso);
  chk("detalle: «En servicio y sin posición nueva hace 7 min»", sp7.detalle === "En servicio y sin posición nueva hace 7 min", sp7.detalle);
  const congelado = ultimaPosicion([fila(10_000, { fix_ts: iso(T - 7 * MIN) })], T)!;
  const spc = juzgar(congelado, enCurso);
  chk("GPS congelado (fix de hace 7 min, fila de hace 10 s) → senal_perdida «el teléfono sigue conectado»",
    spc.codigo === "senal_perdida" && spc.detalle === "En servicio y sin posición nueva hace 7 min · el teléfono sigue conectado", spc.detalle);
  const ayer = juzgar(posDe(20 * H), enCurso);
  chk("sin posición desde ayer → «desde ayer 16:00»", ayer.detalle === "En servicio y sin posición nueva desde ayer 16:00", ayer.detalle);

  // no_inicio · umbral 10 min, ventana 120
  const prog = (inicio: number) => [svc(52, "programada", inicio)];
  const p0 = posDe(30 * MIN);
  chk("no_inicio: hora + umbral − 1 s → todavía no", juzgar(p0, prog(T - 10 * MIN + 1000)).codigo !== "no_inicio");
  const ni = juzgar(p0, prog(T - 10 * MIN));
  chk("no_inicio: hora + umbral exacta → no_inicio, rojo", ni.codigo === "no_inicio" && ni.color === "#dc2626", ni.detalle);
  chk("detalle: «Servicio de las 11:50 sin iniciar»", ni.detalle === "Servicio de las 11:50 sin iniciar", ni.detalle);
  chk("no_inicio: tope de la ventana − 1 s → sigue", juzgar(p0, prog(T - 130 * MIN + 1000)).codigo === "no_inicio");
  chk("no_inicio: tope de la ventana exacto → ya no (gris)", juzgar(p0, prog(T - 130 * MIN)).codigo === "reposo");
  const niVivo = juzgar(posDe(10_000, { estado: "disponible" }), [svc(52, "confirmada", T - 15 * MIN)]);
  chk("no_inicio aunque transmita (está conectada y no pulsó Iniciar)", niVivo.codigo === "no_inicio" && niVivo.detalle.endsWith("el teléfono está transmitiendo"), niVivo.detalle);
  chk("no_inicio no aplica si otro servicio de la unidad está en curso",
    juzgar(posDe(10_000), [svc(51, "en_curso", T - H), svc(52, "programada", T - 30 * MIN)]).codigo === "en_linea");
  chk("no_inicio sin ninguna posición GPS → no_inicio, sin dibujar",
    (() => { const v = juzgar(null, prog(T - 30 * MIN)); return v.codigo === "no_inicio" && !v.dibujar; })());
  chk("umbral inválido (NaN) → el de la escalera (10)", juzgar(p0, prog(T - 10 * MIN), { umbral: NaN }).codigo === "no_inicio"
    && juzgar(p0, prog(T - 10 * MIN + 1000), { umbral: NaN }).codigo !== "no_inicio");
  chk("umbral de la configuración (3 min) manda", juzgar(p0, prog(T - 3 * MIN), { umbral: 3 }).codigo === "no_inicio");
  chk("servicio sin hora → no hay a qué anclar el no_inicio", juzgar(p0, [svc(52, "programada", null)]).codigo === "reposo");
  const dos = juzgar(p0, [svc(52, "programada", T - 20 * MIN), svc(53, "confirmada", T - 40 * MIN)]);
  chk("dos sin iniciar → nombra el más antiguo «(y 1 más)»", dos.detalle === "Servicio de las 11:20 sin iniciar (y 1 más)", dos.detalle);

  const sos = juzgar(posDe(3 * H), [], { sos: true });
  chk("sos: con alerta pendiente, rojo y dibujada", sos.codigo === "sos" && sos.dibujar && sos.clase === "atender", sos.detalle);
  chk("sos gana a no_inicio", juzgar(p0, prog(T - 30 * MIN), { sos: true }).codigo === "sos");
  const sosSin = juzgar(posDe(0), [], { sos: true, lecturaOk: false });
  chk("sos con la lectura fallida → sos, sin dibujar", sosSin.codigo === "sos" && !sosSin.dibujar);
  const nl = juzgar(null, [], { lecturaOk: false });
  chk("no_se_pudo_leer: lectura fallida → sin_dato, no se dibuja", nl.codigo === "no_se_pudo_leer" && nl.clase === "sin_dato" && !nl.dibujar);
  chk("no_se_pudo_leer aunque haya una posición de antes", juzgar(posDe(0), [], { lecturaOk: false }).codigo === "no_se_pudo_leer");
  const sp0 = juzgar(null);
  chk("sin_posicion: nada en 30 días → sin_dato, solo en la lista", sp0.codigo === "sin_posicion" && !sp0.dibujar && sp0.edadMin === null);
  const fin = juzgar(posDe(30_000, { estado: "finalizado" }));
  chk("finalizado de hace 30 s → «Cerró servicio», no «En línea»", fin.codigo === "finalizado" && fin.detalle === "Cerró servicio · 11:59", fin.detalle);
  const rep = juzgar(posDe(3 * H, { estado: "disponible" }));
  chk("reposo: «Estacionada» · «Última posición hace 3 h»", rep.codigo === "reposo" && rep.etiqueta === "Estacionada" && rep.detalle === "Última posición hace 3 h", rep.detalle);
  chk("el servicio que su propio teléfono cerró no cuenta como en curso",
    juzgar(posDe(10 * MIN, { estado: "finalizado", reserva_id: 50 }), [svc(50, "en_curso", T - H)]).codigo === "finalizado");
  chk("…pero el cierre de OTRO servicio con uno en curso → demora (1 min) y sin señal (10 min)",
    juzgar(posDe(MIN, { estado: "finalizado", reserva_id: 60 }), enCurso).codigo === "demora"
    && juzgar(posDe(10 * MIN, { estado: "finalizado", reserva_id: 60 }), enCurso).codigo === "senal_perdida");
  chk("un estado escrito con mayúsculas se lee igual", juzgar(posDe(10 * MIN), [svc(50, " EN_CURSO ", T - H)]).codigo === "senal_perdida");

  // prioridad
  const pr = (v: VeredictoUnidad) => v.prioridad;
  chk("prioridad: atender > vivo > demora > reposo > sin_dato",
    pr(sp) > pr(juzgar(posDe(0))) && pr(juzgar(posDe(0))) > pr(juzgar(posDe(3 * MIN), enCurso))
    && pr(juzgar(posDe(3 * MIN), enCurso)) > pr(rep) && pr(rep) > pr(sp0));
  chk("prioridad: dentro de atender, SOS > no inició > sin señal", pr(sos) > pr(ni) && pr(ni) > pr(sp7));
  chk("prioridad: dentro de una clase, la más reciente primero", pr(juzgar(posDe(10 * MIN))) > pr(juzgar(posDe(3 * H))));
}

// ══ 3. EL BARRIDO CONTRA UN ORÁCULO ESCRITO APARTE ═══════════════════════════════════════
console.log("\n3. Barrido");
/** El orden del plan, con literales y sin mirar el motor. */
function oraculo(p: PosicionUnidad | null, servicios: ServicioUnidad[], sos: boolean, lecturaOk: boolean, umbral: number): { codigo: CodigoMonitoreo; enCurso: boolean } {
  const cierre = p != null && p.estado === "finalizado";
  const enCurso = servicios.some((s) => s.estado === "en_curso" && !(cierre && p!.reservaId != null && s.reservaId === p!.reservaId));
  const noIni = !enCurso && servicios.some((s) => (s.estado === "programada" || s.estado === "confirmada") && s.inicioMs != null
    && T >= s.inicioMs + umbral * 60000 && T < s.inicioMs + (umbral + 120) * 60000);
  const r = (codigo: CodigoMonitoreo) => ({ codigo, enCurso });
  if (sos) return r("sos");
  if (noIni) return r("no_inicio");
  if (!lecturaOk) return r("no_se_pudo_leer");
  if (!p) return r("sin_posicion");
  const edad = Math.max(0, T - p.posicionTs);
  if (edad <= 120000 && !cierre) return r("en_linea");
  if (enCurso && edad > 300000) return r("senal_perdida");
  if (enCurso) return r("demora");
  if (cierre) return r("finalizado");
  return r("reposo");
}
const veredictos: VeredictoUnidad[] = [];
{
  const EDADES = [-MIN, 0, 30_000, 2 * MIN, 2 * MIN + 1000, 4 * MIN, 5 * MIN, 5 * MIN + 1000, 20 * MIN, 3 * H, 26 * H, 29 * DIA];
  const ESTADOS = ["en_ruta", "disponible", "finalizado", "sos", null];
  const PRECS = [10, 400, null, 0];
  const RESERVAS = [50, 60, null];
  const SERVICIOS: ServicioUnidad[][] = [
    [],
    [svc(50, "en_curso", T - H)],
    [svc(51, "en_curso", T - H)],
    [svc(52, "programada", T - 30 * MIN)],
    [svc(52, "programada", T - 5 * MIN)],
    [svc(52, "confirmada", T - 200 * MIN)],
    [svc(52, "programada", null)],
    [svc(51, "en_curso", T - H), svc(52, "programada", T - 30 * MIN)],
    [svc(50, "finalizada", T - H)],
    [svc(50, "en_curso", T - H), svc(52, "confirmada", T - 11 * MIN)],
    [svc(52, "programada", T - 10 * MIN)],
    [svc(52, "programada", T - 130 * MIN)],
  ];
  let n = 0, distintos = 0, malColor = 0, malDibujar = 0, malLectura = 0, malEdad = 0, malAten = 0, malTexto = 0, malPrio = 0;
  let rojoEnCurso = 0, rojoTransmitiendo = 0, grisDibujado = 0, malAtender = 0, malSinNada = 0;
  const codigos = new Set<CodigoMonitoreo>();
  const casos: { p: PosicionUnidad | null; s: ServicioUnidad[] }[] = [];
  for (const e of EDADES) for (const est of ESTADOS) for (const pr of PRECS) for (const res of RESERVAS) for (const congelado of [false, true]) {
    const o: Partial<FilaGpsMonitoreo> = { estado: est, precision_m: pr, reserva_id: res };
    const p = congelado
      ? ultimaPosicion([fila(Math.min(e, 10_000), { ...o, fix_ts: iso(T - e) })], T)
      : ultimaPosicion([fila(e, o)], T);
    for (const s of SERVICIOS) casos.push({ p, s });
  }
  for (const s of SERVICIOS) casos.push({ p: null, s });
  for (const { p, s } of casos) for (const sos of [false, true]) for (const lecturaOk of [true, false]) {
    n++;
    const v = juzgarUnidad({ posicion: p, servicios: s, sosPendiente: sos, lecturaOk, ahoraMs: T, noInicioMin: 10 });
    veredictos.push(v);
    const o = oraculo(p, s, sos, lecturaOk, 10);
    codigos.add(v.codigo);
    if (v.codigo !== o.codigo) { if (distintos++ < 3) console.log("   ≠", v.codigo, o.codigo, JSON.stringify({ e: p && T - p.posicionTs, est: p?.estado, s, sos, lecturaOk })); }
    const t = TEXTO_CODIGO[v.codigo];
    if (v.clase !== t.clase || v.color !== t.color || v.etiqueta !== t.etiqueta) malColor++;
    if (v.clase === "atender" && !(sos || o.enCurso || v.codigo === "no_inicio")) malAtender++;
    if (!sos && !o.enCurso && v.codigo !== "no_inicio" && !["vivo", "reposo", "sin_dato"].includes(v.clase)) malSinNada++;
    if (v.dibujar !== (p != null && lecturaOk)) malDibujar++;
    if (!lecturaOk && v.codigo === "sin_posicion") malLectura++;
    if ((p == null) !== (v.edadMin == null) || (v.edadMin != null && (v.edadMin < 0 || !Number.isInteger(v.edadMin)))) malEdad++;
    if (v.atenuado !== (v.clase === "reposo")) malAten++;
    if (!v.detalle || !v.etiqueta || /undefined|NaN|null|Infinity/.test(v.detalle)) malTexto++;
    if (!Number.isSafeInteger(v.prioridad) || v.prioridad < 0 || v.prioridad >= 2 ** 31
      || Math.floor(v.prioridad / 10_000_000) !== { sin_dato: 0, reposo: 1, demora: 2, vivo: 3, atender: 4 }[v.clase]) malPrio++;
    if (v.codigo === "senal_perdida" && v.dibujar) rojoEnCurso++;
    if (v.codigo === "no_inicio" && p && T - p.posicionTs <= 2 * MIN) rojoTransmitiendo++;
    if (v.clase === "reposo" && v.dibujar) grisDibujado++;
  }
  chk(`el motor coincide con el oráculo en las ${n} combinaciones`, distintos === 0, `${distintos} distintas`);
  chk("clase, color y etiqueta salen de TEXTO_CODIGO", malColor === 0, `${malColor}`);
  chk("atender ⟹ (SOS ∨ servicio en curso ∨ no inició)", malAtender === 0, `${malAtender}`);
  chk("sin SOS, sin servicio en curso y sin no-inició: NUNCA rojo ni ámbar", malSinNada === 0, `${malSinNada}`);
  chk("dibujar ⟺ hay posición ∧ la lectura no falló", malDibujar === 0, `${malDibujar}`);
  chk("una lectura fallida nunca sale como «sin posición»", malLectura === 0, `${malLectura}`);
  chk("edadMin: entero ≥ 0 con posición (también una del futuro), null sin ella", malEdad === 0, `${malEdad}`);
  chk("atenuado ⟺ clase reposo", malAten === 0, `${malAten}`);
  chk("etiqueta y detalle compuestos, sin «undefined/NaN/null»", malTexto === 0, `${malTexto}`);
  chk("prioridad: entero válido de z-index y su millón dice la clase", malPrio === 0, `${malPrio}`);
  chk("corolario: el ROJO aparece con un servicio en curso y la posición vieja", rojoEnCurso > 100, `${rojoEnCurso}`);
  chk("corolario: el no-inició sale aunque la unidad transmita", rojoTransmitiendo > 10, `${rojoTransmitiendo}`);
  chk("corolario: lo viejo sin servicio se DIBUJA en gris (no desaparece)", grisDibujado > 100, `${grisDibujado}`);
  chk("el barrido cubre los 9 códigos", codigos.size === 9, [...codigos].join(", "));
}

// ══ 4. ultimaPosicion Y LA FUSIÓN ═════════════════════════════════════════════════════════
console.log("\n4. ultimaPosicion y fusión");
{
  const nula = (o: Partial<FilaGpsMonitoreo>) => ultimaPosicion([fila(MIN, o)], T) === null;
  chk("descarta un punto simulado", nula({ simulado: true }));
  chk("descarta lat o lng nulos", nula({ lat: null }) && nula({ lng: null }));
  chk("descarta lat/lng no numéricos", nula({ lat: "abc" }) && nula({ lng: {} as unknown }) && nula({ lat: true as unknown }));
  chk("descarta (0,0)", nula({ lat: 0, lng: 0 }) && nula({ lat: "0", lng: "0" }));
  chk("descarta coordenadas fuera de rango", nula({ lat: 91 }) && nula({ lng: -181 }));
  chk("descarta la fila sin vehículo (un conductor sin unidad no es una unidad)", nula({ vehiculo_id: null }));
  chk("descarta la fila sin ninguna hora", nula({ created_at: null, fix_ts: null, recibido_en: null }));
  chk("acepta lat/lng como texto", !nula({ lat: "-12.05", lng: "-77.03" }));
  chk("simulado null o false sí cuenta", !nula({ simulado: null }) && !nula({ simulado: false }));
  chk("30 días − 1 s se dibuja; 30 días + 1 s no", ultimaPosicion([fila(30 * DIA - 1000)], T) !== null && ultimaPosicion([fila(30 * DIA + 1000)], T) === null);

  const p1 = ultimaPosicion([fila(0, { created_at: iso(T - 10_000), fix_ts: iso(T - 7 * MIN), recibido_en: iso(T - 9_000) })], T)!;
  chk("posicionTs = fix_ts cuando es anterior (GPS congelado)", p1.posicionTs === T - 7 * MIN);
  chk("enlaceTs = la llegada (max(created_at, recibido_en))", p1.enlaceTs === T - 9_000);
  const p2 = ultimaPosicion([fila(0, { created_at: iso(T + H), fix_ts: null, recibido_en: iso(T - 20_000) })], T)!;
  chk("reloj del teléfono adelantado: recibido_en acota la edad", p2.posicionTs === T - 20_000);
  chk("…y el enlace no queda en el futuro (acotado a ahora)", p2.enlaceTs === T);
  const p3 = ultimaPosicion([fila(0, { created_at: iso(T + H), fix_ts: null, recibido_en: null })], T)!;
  chk("sin recibido_en, una hora del futuro se acota a ahora", p3.posicionTs === T && juzgar(p3).edadMin === 0);
  const p4 = ultimaPosicion([fila(0, { created_at: null, fix_ts: null, recibido_en: iso(T - 4 * MIN) })], T)!;
  chk("sin created_at ni fix_ts, la edad sale de recibido_en", p4.posicionTs === T - 4 * MIN);
  const p5 = ultimaPosicion([fila(0, { created_at: "2026-10-13 16:55:00+00", fix_ts: null, recibido_en: null })], T)!;
  chk("lee la forma de Postgres «2026-10-13 16:55:00+00»", p5.posicionTs === T - 5 * MIN);
  const conTs = { ...fila(3 * MIN), timestamp: iso(T + 5 * DIA) } as FilaGpsMonitoreo;
  chk("la columna `timestamp` no se usa", JSON.stringify(ultimaPosicion([conTs], T)) === JSON.stringify(ultimaPosicion([fila(3 * MIN)], T)));

  const orden = ultimaPosicion([fila(3 * MIN), fila(MIN), fila(5 * MIN)], T)!;
  chk("toma la más reciente aunque llegue en medio", orden.posicionTs === T - MIN);
  const tarde = fusionarPosicion(ultimaPosicion([fila(MIN)], T), fila(10 * MIN, { conductor_id: 9 }), T)!;
  chk("una fila vieja que llega tarde (cola offline) no tapa a la nueva", tarde.posicionTs === T - MIN && tarde.conductor === "p:1");

  // El cierre impreciso
  const previa = fila(4 * MIN, { lat: -12.1, lng: -77.1, precision_m: 8, reserva_id: 50 });
  const cierre = fila(2 * MIN, { lat: -12.3, lng: -77.3, precision_m: 900, estado: "finalizado", reserva_id: 50, fix_ts: iso(T - 4 * MIN) });
  const ci = ultimaPosicion([previa, cierre], T)!;
  chk("cierre impreciso: la posición sale del fix preciso anterior del MISMO servicio", ci.lat === -12.1 && ci.lng === -77.1 && ci.precisionM === 8);
  chk("…el estado y la hora, del cierre; aproximada", ci.estado === "finalizado" && ci.cierreTs === T - 2 * MIN && ci.aproximada);
  const vci = juzgar(ci);
  chk("…«Cerró servicio · 11:58 · posición aproximada»", vci.codigo === "finalizado" && vci.detalle === "Cerró servicio · 11:58 · posición aproximada", vci.detalle);
  const otra = ultimaPosicion([{ ...previa, reserva_id: 49 }, cierre], T)!;
  chk("el fix preciso de OTRO servicio no reemplaza: posición propia, aproximada", otra.lat === -12.3 && otra.aproximada);
  const sinPrec = ultimaPosicion([previa, { ...cierre, precision_m: null }], T)!;
  chk("un cierre SIN precisión declarada cuenta como impreciso", sinPrec.lat === -12.1 && sinPrec.aproximada);
  const finoCierre = ultimaPosicion([previa, { ...cierre, precision_m: 12 }], T)!;
  chk("un cierre preciso usa su propia posición, no aproximada", finoCierre.lat === -12.3 && !finoCierre.aproximada && finoCierre.respaldo === null);
  chk("un punto normal impreciso (400 m) es aproximado; uno sin precisión declarada, no",
    posDe(0, { precision_m: 400 }).aproximada && !posDe(0, { precision_m: null }).aproximada && !posDe(0).aproximada);
  // precision_m = 0 (la app del TERCERIZADO cuando no la conoce, y siempre al finalizar) = desconocida.
  const ter = { vehiculo_id: null, vehiculo_tercero_id: 12, conductor_id: null, conductor_tercero_id: 12 };
  const previaTer = fila(4 * MIN, { ...ter, lat: -12.1, lng: -77.1, precision_m: 8, reserva_id: 50 });
  const cierreTer = fila(2 * MIN, { ...ter, lat: -12.3, lng: -77.3, precision_m: 0, estado: "finalizado", reserva_id: 50 });
  const ct = ultimaPosicion([previaTer, cierreTer], T)!;
  chk("cierre del TERCERIZADO con precision_m 0: posición del fix preciso del MISMO servicio, aproximada",
    ct.unidad === "t:12" && ct.lat === -12.1 && ct.lng === -77.1 && ct.precisionM === 8 && ct.aproximada && ct.estado === "finalizado");
  chk("…igual que un cierre con precisión null", JSON.stringify(ct) === JSON.stringify(ultimaPosicion([previaTer, { ...cierreTer, precision_m: null }], T)));
  const ctOtro = ultimaPosicion([{ ...previaTer, reserva_id: 49 }, cierreTer], T)!;
  chk("…sin fix preciso de ESE servicio: su propia posición, aproximada (no «exacta»)", ctOtro.lat === -12.3 && ctOtro.aproximada && ctOtro.precisionM === null);
  chk("…y el veredicto lo dice: «· posición aproximada»", juzgar(ct).detalle.endsWith("posición aproximada"), juzgar(ct).detalle);
  chk("cierre con precisión negativa o no numérica: también desconocida",
    ultimaPosicion([previa, { ...cierre, precision_m: -5 }], T)!.lat === -12.1 && ultimaPosicion([previa, { ...cierre, precision_m: "abc" }], T)!.lat === -12.1);
  const cero = posDe(0, { precision_m: 0 });
  chk("punto normal con precision_m 0: precisión desconocida (null) y NO aproximada, igual que null",
    cero.precisionM === null && !cero.aproximada && JSON.stringify(cero) === JSON.stringify(posDe(0, { precision_m: null })));
  chk("«0» en texto (como lo devuelve PostgREST) también es desconocida", posDe(0, { precision_m: "0" }).precisionM === null);
  chk("un fix con precisión 0 NO sirve de respaldo de un cierre impreciso",
    ultimaPosicion([{ ...previa, precision_m: 0 }, cierre], T)!.lat === -12.3);
  chk("una precisión real y chica (0.5 m) sí es precisa", posDe(0, { precision_m: 0.5 }).precisionM === 0.5);
  const soloCierre = ultimaPosicion([cierre], T)!;
  chk("cierre impreciso sin fix preciso anterior: su posición, aproximada", soloCierre.lat === -12.3 && soloCierre.aproximada);
  const llega = fusionarPosicion(soloCierre, previa, T)!;
  chk("…y si el fix preciso llega DESPUÉS por el realtime, lo toma", JSON.stringify(llega) === JSON.stringify(ci));

  // CICLO
  let ciclos = 0, rotos = 0, conSustitucion = 0;
  const T10 = (k: number) => k * 10_000;
  for (let caso = 0; caso < 1500; caso++) {
    const filas: FilaGpsMonitoreo[] = [];
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const creado = T10(Math.floor(rnd() * 40));            // grilla gruesa: fuerza empates
      const o: Partial<FilaGpsMonitoreo> = {
        estado: elegir(["en_ruta", "finalizado", "disponible", "finalizado"]),
        precision_m: elegir([8, 30, 400, null, 0, 0]),
        reserva_id: elegir([50, 51, null]),
        conductor_id: elegir([1, 2]),
        lat: elegir([-12.1, -12.2, -12.3]), lng: elegir([-77.1, -77.2]),
        fix_ts: rnd() < 0.3 ? null : iso(T - creado - T10(Math.floor(rnd() * 3))),
        recibido_en: rnd() < 0.2 ? null : iso(T - creado + T10(Math.floor(rnd() * 3)) - 30_000),
      };
      filas.push(fila(creado, o));
      if (rnd() < 0.15) filas.push({ ...filas[filas.length - 1] });                     // duplicado (poll + realtime)
      if (rnd() < 0.1) filas.push(fila(creado, { ...o, simulado: true }));              // basura que se ignora
      if (rnd() < 0.1) filas.push(fila(creado, { ...o, lat: null }));
      if (rnd() < 0.05) filas.push(fila(creado, { ...o, vehiculo_id: null }));
    }
    const lote = ultimaPosicion(filas, T);
    if (lote && lote.estado === "finalizado" && lote.aproximada && lote.respaldo && lote.lat === lote.respaldo.lat && lote.posicionTs === lote.respaldo.posicionTs) conSustitucion++;
    const esperado = JSON.stringify(lote);
    for (const orden of [filas, filas.slice().reverse(), barajar(filas), barajar(filas)]) {
      ciclos++;
      let acc: PosicionUnidad | null = null;
      for (const f of orden) acc = fusionarPosicion(acc ? JSON.parse(JSON.stringify(acc)) : null, f, T);
      if (JSON.stringify(acc) !== esperado) { if (rotos++ < 3) console.log("   ciclo ≠\n   ", esperado, "\n   ", JSON.stringify(acc)); }
    }
  }
  chk(`CICLO: plegar fusionarPosicion en cualquier orden ≡ ultimaPosicion (${ciclos} plegados, con duplicados, basura y JSON)`, rotos === 0, `${rotos} distintos`);
  chk("…y el barrido ejercita la sustitución del cierre impreciso", conSustitucion > 20, `${conSustitucion}`);
  const p12 = posDe(MIN);
  chk("una fila de OTRA unidad no mueve la posición", fusionarPosicion(p12, fila(0, { vehiculo_id: 9 }), T) === p12);
  chk("una fila inválida no mueve la posición", fusionarPosicion(p12, fila(0, { simulado: true }), T) === p12);
  chk("con filas de dos unidades, manda la de la fila más reciente",
    ultimaPosicion([fila(MIN, { vehiculo_id: 9 }), fila(5 * MIN)], T)!.unidad === "p:9");
}

// ══ 5. LOS IDS SE SOLAPAN ═════════════════════════════════════════════════════════════════
console.log("\n5. Claves");
{
  chk("unidad 12 propia «p:12» ≠ unidad 12 tercerizada «t:12»",
    unidadDeFila({ ...fila(0), vehiculo_id: 12 }) === "p:12" && unidadDeFila({ ...fila(0), vehiculo_id: null, vehiculo_tercero_id: 12 }) === "t:12");
  chk("la clave es la de lib/flota/excesos.ts", unidadDeFila({ ...fila(0), vehiculo_id: 12, vehiculo_tercero_id: 3 }) === claveUnidad(12, 3));
  const tp = ultimaPosicion([fila(0, { vehiculo_id: null, vehiculo_tercero_id: 12, conductor_id: null, conductor_tercero_id: 12 })], T)!;
  chk("conductor 12 tercerizado «t:12»", tp.unidad === "t:12" && tp.conductor === "t:12");
  chk("una fila de la 12 tercerizada no entra en la 12 propia", fusionarPosicion(posDe(MIN, { vehiculo_id: 12 }), fila(0, { vehiculo_id: null, vehiculo_tercero_id: 12 }), T)!.unidad === "p:12"
    && fusionarPosicion(posDe(MIN, { vehiculo_id: 12 }), fila(0, { vehiculo_id: null, vehiculo_tercero_id: 12 }), T)!.posicionTs === T - MIN);
  chk("unidadVigente: null, 'activo' y 'mantenimiento' sí; 'inactivo' (con espacios o mayúsculas) no",
    unidadVigente(null) && unidadVigente(undefined) && unidadVigente("activo") && unidadVigente("mantenimiento")
    && !unidadVigente("inactivo") && !unidadVigente(" INACTIVO "));
  chk("inicioServicioMs: «06:30» y «06:30:00» en Lima",
    inicioServicioMs("2026-10-13", "06:30") === Date.UTC(2026, 9, 13, 11, 30) && inicioServicioMs("2026-10-13", "06:30:00") === Date.UTC(2026, 9, 13, 11, 30));
  chk("inicioServicioMs: sin hora, sin fecha o con una hora imposible → null",
    inicioServicioMs("2026-10-13", null) === null && inicioServicioMs(null, "06:30") === null && inicioServicioMs("2026-10-13", "25:00") === null);
}

// ══ 6. resumenFlota ═══════════════════════════════════════════════════════════════════════
console.log("\n6. resumenFlota");
{
  const r = resumenFlota(veredictos);
  const suma = CLASES_MONITOREO.reduce((a, c) => a + r[c], 0);
  chk("disjunto y exhaustivo: la suma de las clases es el total", suma === r.total && r.total === veredictos.length, `${suma}/${r.total}`);
  chk("cada clase cuenta exactamente sus veredictos", CLASES_MONITOREO.every((c) => r[c] === veredictos.filter((v) => v.clase === c).length));
  chk("vacío → todo en cero", JSON.stringify(resumenFlota([])) === JSON.stringify({ atender: 0, vivo: 0, demora: 0, reposo: 0, sin_dato: 0, total: 0 }));
}

// ══ 7. LOS RÓTULOS DE TIEMPO, EN HORA DE LIMA ═════════════════════════════════════════════
console.log("\n7. Rótulos de tiempo");
{
  const lima = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h + 5, mi);
  const a = lima(2026, 10, 14, 0, 5);
  chk("00:05 · un punto de las 23:58 de ayer → «hace 7 min» (no «ayer»)", rotuloEdad(lima(2026, 10, 13, 23, 58), a) === "hace 7 min");
  chk("00:05 · un punto de las 22:30 de ayer → «ayer 22:30»", rotuloEdad(lima(2026, 10, 13, 22, 30), a) === "ayer 22:30", rotuloEdad(lima(2026, 10, 13, 22, 30), a));
  chk("23:59 · un punto de las 00:01 de hoy → «hace 23 h»", rotuloEdad(lima(2026, 10, 13, 0, 1), lima(2026, 10, 13, 23, 59)) === "hace 23 h");
  chk("anteayer → «12/10 18:40»", rotuloEdad(lima(2026, 10, 12, 18, 40), a) === "12/10 18:40");
  const noche = lima(2026, 10, 13, 21, 30);       // 02:30 UTC del 14
  chk("21:30 Lima (ya es el 14 en UTC) · 19:10 → «hace 2 h», no «ayer»", rotuloEdad(lima(2026, 10, 13, 19, 10), noche) === "hace 2 h");
  chk("21:30 Lima · 18:50 (otro día en UTC) → «hace 2 h»", rotuloEdad(lima(2026, 10, 13, 18, 50), noche) === "hace 2 h");
  chk("otro año → «20/12/2026 10:00»", rotuloEdad(lima(2026, 12, 20, 10, 0), lima(2027, 1, 1, 8, 0)) === "20/12/2026 10:00");
  chk("menos de 1 min, y un instante del futuro → «hace menos de 1 min»", rotuloEdad(T - 59_000, T) === "hace menos de 1 min" && rotuloEdad(T + MIN, T) === "hace menos de 1 min");
  chk("59 min 59 s → «hace 59 min»; 60 min → «hace 1 h»", rotuloEdad(T - (H - 1000), T) === "hace 59 min" && rotuloEdad(T - H, T) === "hace 1 h");
  chk("rotuloMomento: hoy «18:40» · ayer «ayer 18:40» · antes «12/10 18:40»",
    rotuloMomento(lima(2026, 10, 14, 18, 40), lima(2026, 10, 14, 20, 0)) === "18:40"
    && rotuloMomento(lima(2026, 10, 13, 18, 40), lima(2026, 10, 14, 0, 5)) === "ayer 18:40"
    && rotuloMomento(lima(2026, 10, 12, 18, 40), a) === "12/10 18:40");
  chk("cierre de ayer: «Cerró servicio · ayer 18:40»",
    juzgarUnidad({ posicion: ultimaPosicion([fila(0, { created_at: iso(lima(2026, 10, 13, 18, 40)), fix_ts: null, recibido_en: null, estado: "finalizado", precision_m: 5 })], a),
      servicios: [], lecturaOk: true, sosPendiente: false, ahoraMs: a, noInicioMin: 10 }).detalle === "Cerró servicio · ayer 18:40");
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
