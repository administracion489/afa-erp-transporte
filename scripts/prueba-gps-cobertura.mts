// Pruebas del RASTREO GPS por servicio: lib/gps-cobertura.ts (motor PURO). NO tocan la base.
// Uso:  npx tsx scripts/prueba-gps-cobertura.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. LA EXTRACCIÓN: la medición vivía dentro de app/api/gps-salud/route.ts. Se copia aquí el
//      original LITERAL y se exige resultado idéntico sobre trazas aleatorias cuando no se pasan
//      las extensiones de /seguimiento. Una divergencia DECLARADA: una parada final sin
//      coordenadas ya no borra el destino (el original la leía como (0, 0) por Number(null)), y
//      por la misma razón una fila con lat/lng nulos ya no entra a la traza como punto (0, 0).
//   2. EL CASO REAL (reserva #6166, VFC-962): GPS de 4:08 a 4:11 en una ruta de ~55 min que el
//      conductor terminó marcando todas las paradas. Sale «Incompleto», nunca 100 %.
//   3. Los veredictos de la torre, uno por uno, y el lado que no se puede aflojar: un fallo de
//      LECTURA nunca acusa (`sin_medir`), y lo urgente solo existe con el servicio en curso.
//   4. EL CIERRE DEL CONDUCTOR (reserva #29811, CWQ400): GPS vivo de 07:13 a 07:39, el conductor
//      cerró a las 07:39 sin pasar por los últimos paraderos, llegada prevista 08:05. Salía 50 %
//      («el servicio siguió 25 min más sin rastreo»); con el punto 'finalizado' sale 100 %. Y el
//      lado que no se afloja: un corte real sigue saliendo aunque el conductor cierre después.
//   9. LOS TRAMOS DEL MODAL DE DIAGNÓSTICO salen del MISMO bucle que el %: con y sin extensiones,
//      cubierto + tramos + (cabeza y cola de ≤ 60 s) = la ventana; los tramos en movimiento son los
//      `cortes`, sus metros son `kmACiegas` y el mayor es `peorHuecoMin`. Y NINGUNA cifra que ya
//      existía cambió: se compara contra el `medirCobertura` anterior copiado literal. Las filas de
//      diagnóstico (`acc.filas`) solo existen si se piden, y no cambian la traza.
//  10. LA EXTRACCIÓN DEL VEREDICTO: el `medir` interno de rastreoDelDia (lib/gps-cobertura-datos.ts),
//      copiado literal, contra `contextoServicio` + `veredictoDeServicio` sobre reservas, paradas y
//      trazas al azar: veredicto idéntico. Es lo que garantiza que el modal y la celda digan lo mismo.
import {
  medirCobertura, finYDestino, acumularFilasGps, trazaVacia, veredictoRastreo, resumenRastreo,
  trazaInmovil, bandaCobertura, metros as metrosMod, limaMs as limaMsMod,
  contextoServicio, veredictoDeServicio,
  type PuntoCobertura, type TrazaSaneada, type FinVentana, type VeredictoRastreo,
} from "../lib/gps-cobertura";
import { derivarTiempos } from "../lib/servicio-tiempos";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ══ El ORIGINAL de app/api/gps-salud/route.ts, copiado literal ═══════════════════════
const HUECO_MIN_S = 60, AVANCE_CAIDO_M = 500, AVANCE_MAX_M = 50000;
function metros(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function limaMs(fecha: string, hora: string | null): number | null {
  if (!fecha || !hora) return null;
  const t = Date.parse(`${fecha}T${String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8)}-05:00`);
  return Number.isFinite(t) ? t : null;
}
function finYDestinoViejo(paradas: any[], fecha: string, horaServicio: string | null) {
  let ultima: string | undefined; let destino: { lat: number; lng: number } | undefined;
  for (const p of paradas) {
    if (p.hora_estimada) ultima = p.hora_estimada;
    const la = Number(p.lat), ln = Number(p.lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) destino = { lat: la, lng: ln };
  }
  let fin = limaMs(fecha, ultima ?? null);
  const ini = limaMs(fecha, horaServicio);
  if (fin !== null && ini !== null && fin < ini) fin += 86400e3;
  return { fin, destino };
}
function medirViejo(t: PuntoCobertura[], dest: { lat: number; lng: number } | undefined, finPrev: number | undefined) {
  const ini = t[0].ts;
  const ultimo = t[t.length - 1];
  const llego = dest ? metros(ultimo.lat, ultimo.lng, dest.lat, dest.lng) <= AVANCE_CAIDO_M : false;
  const fin = llego ? ultimo.ts : Math.max(ultimo.ts, finPrev ?? 0);
  const ventanaS = Math.max(1, (fin - ini) / 1000);
  let cubiertoS = 0, cortes = 0, peorS = 0, metrosCiegos = 0;
  for (let i = 1; i < t.length; i++) {
    const gapS = (t[i].ts - t[i - 1].ts) / 1000;
    if (gapS <= HUECO_MIN_S) { cubiertoS += gapS; continue; }
    if (gapS > peorS) peorS = gapS;
    const avance = metros(t[i - 1].lat, t[i - 1].lng, t[i].lat, t[i].lng);
    if (avance >= AVANCE_CAIDO_M && avance <= AVANCE_MAX_M) { cortes++; metrosCiegos += avance; }
  }
  const colaS = (fin - ultimo.ts) / 1000;
  if (colaS > HUECO_MIN_S && peorS < colaS) peorS = colaS;
  return {
    durMin: Math.round(ventanaS / 60),
    cobertura: Math.max(0, Math.min(100, Math.round((cubiertoS / ventanaS) * 100))),
    cortes, peorHuecoMin: Math.round(peorS / 60), kmACiegas: Math.round(metrosCiegos / 100) / 10,
  };
}

// ── Generador determinista ─────────────────────────────────────────────────────────
let semilla = 12345;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const LAT0 = -12.05, LNG0 = -77.05, M = 111_320;
const T0 = Date.parse("2026-10-09T09:08:00Z");   // 04:08 Lima
function trazaAzar(): PuntoCobertura[] {
  const n = 2 + Math.floor(rnd() * 80);
  const pts: PuntoCobertura[] = [];
  let ts = T0, lat = LAT0, lng = LNG0;
  for (let i = 0; i < n; i++) {
    pts.push({ ts, lat, lng });
    const hueco = rnd() < 0.1;
    ts += hueco ? Math.floor(60_000 + rnd() * 1_800_000) : Math.floor(2_000 + rnd() * 40_000);
    const paso = hueco ? rnd() * 4000 : rnd() * 200;
    lat += paso / M; lng += (rnd() - 0.5) * paso / M;
  }
  return pts;
}

// ══ 1. La extracción ═════════════════════════════════════════════════════════════════
console.log("\n1. medirCobertura sin extensiones = el original de /gps-salud");
{
  let iguales = 0, total = 0;
  for (let k = 0; k < 3000; k++) {
    const t = trazaAzar();
    const conDest = rnd() < 0.7;
    const ult = t[t.length - 1];
    const dest = conDest ? (rnd() < 0.5 ? { lat: ult.lat + 100 / M, lng: ult.lng } : { lat: LAT0 + 20_000 / M, lng: LNG0 }) : undefined;
    const finPrev = rnd() < 0.6 ? ult.ts + Math.floor((rnd() - 0.3) * 3_600_000) : undefined;
    const v = medirViejo(t, dest, finPrev);
    const n = medirCobertura({ pts: t, destino: dest ?? null, finPrevistoTs: finPrev ?? null })!;
    total++;
    if (v.durMin === n.durMin && v.cobertura === n.cobertura && v.cortes === n.cortes && v.peorHuecoMin === n.peorHuecoMin && v.kmACiegas === n.kmACiegas) iguales++;
  }
  chk(`${iguales}/${total} trazas idénticas`, iguales === total);
  chk("metros y limaMs son los mismos", metros(LAT0, LNG0, -12.06, -77.04) === metrosMod(LAT0, LNG0, -12.06, -77.04)
    && limaMs("2026-10-09", "04:08") === limaMsMod("2026-10-09", "04:08"));

  let igualesFD = 0, totalFD = 0, divergenciasDeclaradas = 0;
  for (let k = 0; k < 500; k++) {
    const n = 1 + Math.floor(rnd() * 6);
    const ps = Array.from({ length: n }, (_, i) => ({
      hora_estimada: rnd() < 0.7 ? `0${4 + i}:${rnd() < 0.5 ? "10" : "40"}` : null,
      lat: rnd() < 0.8 ? LAT0 + i * 0.01 : null, lng: rnd() < 0.8 ? LNG0 : null,
    }));
    const hs = rnd() < 0.5 ? "04:00" : "23:30";
    const v = finYDestinoViejo(ps, "2026-10-09", hs);
    const nn = finYDestino(ps, "2026-10-09", hs);
    totalFD++;
    const mismoFin = v.fin === nn.finPrevistoTs;
    const mismoDest = JSON.stringify(v.destino ?? null) === JSON.stringify(nn.destino);
    const ultimaSinCoords = ps[ps.length - 1].lat == null || ps[ps.length - 1].lng == null;
    if (mismoFin && mismoDest) igualesFD++;
    else if (mismoFin && ultimaSinCoords) divergenciasDeclaradas++;
  }
  chk(`finYDestino: ${igualesFD} idénticos + ${divergenciasDeclaradas} divergencias declaradas = ${totalFD}`, igualesFD + divergenciasDeclaradas === totalFD);
}

// ══ 2. El caso #6166 ═════════════════════════════════════════════════════════════════
console.log("\n2. Reserva #6166: GPS de 4:08 a 4:11, ruta hasta las 5:03, todas las paradas marcadas");
const traza6166: PuntoCobertura[] = Array.from({ length: 37 }, (_, i) => ({ ts: T0 + i * 5_000, lat: LAT0 + (i * 11) / M, lng: LNG0 }));
const destino6166 = { lat: LAT0 + 18_000 / M, lng: LNG0 + 0.05 };
const fin6166 = Date.parse("2026-10-09T10:03:00Z");   // 05:03 Lima
{
  const conPrevista = medirCobertura({ pts: traza6166, destino: destino6166, finPrevistoTs: fin6166 })!;
  chk("con hora prevista de llegada: cobertura baja", conPrevista.cobertura <= 6, `${conPrevista.cobertura} %`);
  const soloLlegadaMarcada = medirCobertura({ pts: traza6166, destino: destino6166, finPrevistoTs: null, finTs: fin6166 })!;
  chk("sin hora prevista, la llegada marcada por el conductor alcanza", soloLlegadaMarcada.cobertura <= 6, `${soloLlegadaMarcada.cobertura} %`);
  const ciego = medirCobertura({ pts: traza6166, destino: destino6166, finPrevistoTs: null })!;
  chk("límite declarado: sin hora prevista NI llegada marcada no hay con qué medir la cola", ciego.cobertura === 100);
  const v = veredictoRastreo({ aplica: true, enCurso: false, traza: { ...trazaVacia(), pts: traza6166, totalCrudo: 37 }, medicion: conPrevista, avanzo: true, inmovil: false, inicioTs: null, ahoraMs: fin6166 + 3_600_000 });
  chk("veredicto: Incompleto, problema incompleto", v.codigo === "incompleto" && v.problema === "incompleto", `${v.codigo} · ${v.celda}`);
  chk("el detalle nombra la hora del corte", /04:11/.test(v.detalle), v.detalle);
}

// ══ 3. Extensiones de /seguimiento ══════════════════════════════════════════════════
console.log("\n3. inicio marcado por el conductor y servicio en curso");
{
  const pts: PuntoCobertura[] = Array.from({ length: 121 }, (_, i) => ({ ts: T0 + i * 10_000, lat: LAT0 + i * 20 / M, lng: LNG0 }));
  const base = medirCobertura({ pts })!;
  const conInicio = medirCobertura({ pts, inicioTs: T0 - 20 * 60_000 })!;
  chk("sin extensiones, una traza continua es 100 %", base.cobertura === 100);
  chk("un GPS que arrancó 20 min tarde en un servicio de 40 cuenta la mitad", conInicio.cobertura === 50, `${conInicio.cobertura} %`);
  const enVivo = medirCobertura({ pts, hastaTs: pts[pts.length - 1].ts + 20_000 })!;
  chk("en curso con señal al día: sigue Completo (≥ 95 %)", enVivo.cobertura >= 95, `${enVivo.cobertura} %`);
  const llegoYCerro = medirCobertura({ pts, destino: { lat: pts[120].lat, lng: LNG0 }, finTs: pts[120].ts + 3_600_000 })!;
  chk("traza que acaba junto al destino: el cierre tardío no la penaliza", llegoYCerro.cobertura === 100);
  // monotonía: las extensiones solo pueden BAJAR la cobertura (alargan la ventana), nunca subirla
  let ok = true;
  for (let k = 0; k < 1500; k++) {
    const t = trazaAzar();
    const sin = medirCobertura({ pts: t })!;
    const con = medirCobertura({ pts: t, inicioTs: t[0].ts - Math.floor(rnd() * 3_600_000), finTs: t[t.length - 1].ts + Math.floor(rnd() * 3_600_000) })!;
    if (con.cobertura > sin.cobertura) ok = false;
  }
  chk("barrido: inicio/fin del conductor nunca suben la cobertura", ok);
}

// ══ 4. Veredictos ════════════════════════════════════════════════════════════════════
console.log("\n4. Veredictos de la torre");
const AHORA = T0 + 60 * 60_000;
const traza = (pts: PuntoCobertura[], crudo = pts.length, antena = 0): TrazaSaneada => ({ pts, totalCrudo: crudo, porAntena: antena, simulados: 0 });
{
  const continua: PuntoCobertura[] = Array.from({ length: 300 }, (_, i) => ({ ts: T0 + i * 10_000, lat: LAT0 + i * 15 / M, lng: LNG0 }));
  const m = medirCobertura({ pts: continua })!;
  const v = (o: Partial<Parameters<typeof veredictoRastreo>[0]>) => veredictoRastreo({
    aplica: true, enCurso: false, traza: traza(continua), medicion: m, avanzo: true, inmovil: false, inicioTs: T0, ahoraMs: AHORA, ...o,
  });
  chk("completo", v({}).codigo === "completo" && v({}).problema === null && v({}).celda === "100 %");
  chk("no aplica (no salió)", v({ aplica: false }).codigo === "no_aplica" && v({ aplica: false }).problema === null);
  chk("no se pudo leer → sin_medir, y NO acusa", v({ traza: null }).codigo === "sin_medir" && v({ traza: null }).problema === null);
  chk("terminado sin ninguna posición → sin señal", v({ traza: traza([], 0), medicion: null }).codigo === "sin_senal" && v({ traza: traza([], 0), medicion: null }).problema === "incompleto");
  chk("todas por antena → solo_antena", v({ traza: traza([continua[0]], 50, 49), medicion: null }).codigo === "solo_antena");
  chk("inmóvil", v({ inmovil: true }).codigo === "gps_inmovil" && v({ inmovil: true }).problema === "incompleto");
  chk("inmóvil sin que el recorrido avance no acusa", v({ inmovil: true, avanzo: false }).codigo === "completo");
  // en curso
  const ult = continua[continua.length - 1].ts;   // T0 + 49:50
  const enCurso = (o: Partial<Parameters<typeof veredictoRastreo>[0]>) => v({ enCurso: true, ...o });
  chk("en curso con señal reciente: no es urgente", enCurso({ ahoraMs: ult + 60_000 }).problema !== "urgente");
  const perdida = enCurso({ ahoraMs: ult + 12 * 60_000 });
  chk("en curso y 12 min sin posición → señal perdida, URGENTE", perdida.codigo === "senal_perdida" && perdida.problema === "urgente", perdida.detalle);
  chk("en curso recién iniciado y sin posiciones: aún no se mide", enCurso({ traza: traza([], 0), medicion: null, inicioTs: AHORA - 2 * 60_000 }).codigo === "recien_iniciado");
  chk("en curso 20 min sin ninguna posición → urgente", enCurso({ traza: traza([], 0), medicion: null, inicioTs: AHORA - 20 * 60_000 }).problema === "urgente");
  chk("terminado con 12 min sin señal al final NO es urgente", v({ ahoraMs: ult + 12 * 60_000 }).problema !== "urgente");
}

// ══ 5. Bandas ════════════════════════════════════════════════════════════════════════
console.log("\n5. Bandas (las mismas de /gps-salud)");
chk("95 → Completo, 94 → Aceptable", bandaCobertura(95).label === "Completo" && bandaCobertura(94).label === "Aceptable");
chk("90 → Aceptable, 89 → Con cortes", bandaCobertura(90).label === "Aceptable" && bandaCobertura(89).label === "Con cortes");
chk("70 → Con cortes, 69 → Incompleto", bandaCobertura(70).label === "Con cortes" && bandaCobertura(69).label === "Incompleto");
chk("null → Sin datos", bandaCobertura(null).label === "Sin datos");

// ══ 6. Invariantes por barrido ══════════════════════════════════════════════════════
console.log("\n6. Invariantes");
{
  let ok = true, urgentes = 0, incompletos = 0;
  for (let k = 0; k < 2000; k++) {
    const t = trazaAzar();
    const enCurso = rnd() < 0.4, aplica = rnd() < 0.9, leida = rnd() < 0.9;
    const m = medirCobertura({ pts: t, hastaTs: enCurso ? t[t.length - 1].ts + Math.floor(rnd() * 1_800_000) : null });
    const v = veredictoRastreo({ aplica, enCurso, traza: leida ? traza(t) : null, medicion: m, avanzo: rnd() < 0.5, inmovil: rnd() < 0.1, inicioTs: t[0].ts, ahoraMs: t[t.length - 1].ts + Math.floor(rnd() * 1_800_000) });
    if (v.pct != null && (v.pct < 0 || v.pct > 100)) ok = false;
    if (v.problema === "urgente" && !enCurso) ok = false;                       // urgente solo en curso
    if (!leida && aplica && v.codigo !== "sin_medir") ok = false;               // fallo de lectura → sin_medir
    if (v.codigo === "sin_medir" && v.problema !== null) ok = false;            // …y nunca acusa
    if (!aplica && v.codigo !== "no_aplica") ok = false;
    if (v.problema === "urgente") urgentes++;
    if (v.problema === "incompleto") incompletos++;
  }
  chk("pct en [0,100] · urgente solo en curso · un fallo de lectura nunca acusa", ok);
  chk("corolario: el motor sí detecta problemas (no es uno que nunca grita)", urgentes > 0 && incompletos > 0, `${urgentes} urgentes, ${incompletos} incompletos`);
}

// ══ 7. Saneo, inmóvil y resumen ═════════════════════════════════════════════════════
console.log("\n7. Saneo de filas, GPS inmóvil y resumen del aviso");
{
  const acc = trazaVacia();
  acumularFilasGps(acc, [
    { created_at: "2026-10-09T09:08:00Z", lat: LAT0, lng: LNG0, precision_m: 10 },
    { created_at: "2026-10-09T09:08:05Z", lat: LAT0, lng: LNG0, precision_m: 400 },   // antena
    { created_at: "2026-10-09T09:08:10Z", lat: null, lng: LNG0, precision_m: 10 },     // sin coordenada
    { created_at: "nada", lat: LAT0, lng: LNG0 },                                      // sin fecha
    { created_at: "2026-10-09T09:08:15Z", lat: LAT0, lng: LNG0, simulado: true },
  ], true);
  chk("descarta antena, coordenadas y fechas rotas; cuenta simulados", acc.pts.length === 2 && acc.totalCrudo === 3 && acc.porAntena === 1 && acc.simulados === 1,
    `pts=${acc.pts.length} crudo=${acc.totalCrudo} antena=${acc.porAntena} sim=${acc.simulados}`);

  const quieto: PuntoCobertura[] = Array.from({ length: 50 }, (_, i) => ({ ts: T0 + i * 30_000, lat: LAT0 + (i % 3) * 20 / M, lng: LNG0 }));
  const paradasLejos = [{ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 8_000 / M, lng: LNG0 }];
  chk("traza quieta con paradas a 8 km → inmóvil", trazaInmovil(quieto, paradasLejos));
  chk("paradas a 1 km → no se afirma", !trazaInmovil(quieto, [{ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 1_000 / M, lng: LNG0 }]));
  chk("paradas sin coordenadas → no se afirma", !trazaInmovil(quieto, [{ lat: null, lng: null }, { lat: null, lng: null }]));

  const mk = (codigo: any, problema: any) => ({ codigo, problema, pct: 10, celda: "", color: "", bg: "", detalle: "", ultimaSenalTs: null, enCurso: false });
  const r = resumenRastreo([
    { reservaId: 1, placa: "VFC-962", conductor: "A", v: mk("incompleto", "incompleto") },
    { reservaId: 2, placa: "VFC-962", conductor: "A", v: mk("sin_senal", "incompleto") },
    { reservaId: 3, placa: "ABC-123", conductor: "B", v: mk("senal_perdida", "urgente") },
    { reservaId: 4, placa: "XYZ-999", conductor: "C", v: mk("con_cortes", "cortes") },
    { reservaId: 5, placa: "OK-0001", conductor: "D", v: mk("completo", null) },
  ]);
  chk("cuenta UNIDADES distintas con problema (2 viajes de la misma placa = 1)", r.unidadesConProblema === 2, String(r.unidadesConProblema));
  chk("separa urgentes, incompletos y con cortes", r.urgentes.length === 1 && r.incompletos.length === 2 && r.conCortes.length === 1);
}

// ══ 8. El cierre del conductor ══════════════════════════════════════════════════════
console.log("\n8. Reserva #29811: el conductor cerró antes de la llegada prevista, con el GPS vivo");
{
  const T7 = Date.parse("2026-10-10T12:13:00Z");                  // 07:13 Lima
  const C739 = T7 + 26 * 60_000;                                    // 07:39 Lima
  const P805 = Date.parse("2026-10-10T13:05:00Z");                  // 08:05 Lima (llegada prevista)
  const vivo: PuntoCobertura[] = Array.from({ length: 157 }, (_, i) => ({ ts: T7 + i * 10_000, lat: LAT0 + i * 15 / M, lng: LNG0 }));
  const lejos = { lat: LAT0 + 12_000 / M, lng: LNG0 + 0.05 };      // el último paradero, sin pasar por él
  const tr = (pts: PuntoCobertura[], cierreTs: number | null = null): TrazaSaneada => ({ pts, totalCrudo: pts.length, porAntena: 0, simulados: 0, cierreTs });
  const ver = (m: any, t: TrazaSaneada) => veredictoRastreo({ aplica: true, enCurso: false, traza: t, medicion: m, avanzo: true, inmovil: false, inicioTs: T7, ahoraMs: P805 + 2 * 3_600_000 });

  const sinCierre = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805 })!;
  chk("el defecto se reproduce SIN el cierre: 50 % hasta la llegada prevista", sinCierre.cobertura === 50 && sinCierre.finPor === "previsto", `${sinCierre.cobertura} % · ${sinCierre.finPor}`);
  const vSin = ver(sinCierre, tr(vivo));
  chk("…y sin cierre el texto ya no afirma que «el servicio siguió»", !/siguió/.test(vSin.detalle) && /prevista a las 08:05/.test(vSin.detalle), vSin.detalle);

  const conCierre = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805, cierreTs: C739 })!;
  chk("con el punto 'finalizado' a las 07:39: 100 %, la ventana termina en el cierre", conCierre.cobertura === 100 && conCierre.ventanaFinTs === C739 && conCierre.finPor === "cierre", `${conCierre.cobertura} %`);
  const vCon = ver(conCierre, tr(vivo, C739));
  chk("veredicto Completo, sin problema", vCon.codigo === "completo" && vCon.problema === null, `${vCon.codigo} · ${vCon.celda}`);
  chk("el detalle dice que la ventana acaba en el cierre del conductor", /07:39, cuando el conductor cerró el servicio/.test(vCon.detalle), vCon.detalle);

  const imprecisoDespues = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805, cierreTs: C739 + 20_000 })!;
  chk("punto 'finalizado' por antena (fuera de la traza) 20 s después: sigue ≥ 98 %", imprecisoDespues.cobertura >= 98, `${imprecisoDespues.cobertura} %`);

  // ── Lo que NO se afloja ──
  // App muerta a las 07:39; el conductor la reabrió lejos y cerró a las 08:05. El punto
  // 'finalizado' lleva la hora del CLIC, así que el hueco cuenta igual.
  const reabierta = [...vivo, { ts: P805, lat: LAT0 + 9_000 / M, lng: LNG0 + 0.03 }];
  const mReab = medirCobertura({ pts: reabierta, destino: lejos, finPrevistoTs: P805, cierreTs: P805 })!;
  chk("app muerta y cierre a las 08:05: sigue 50 %, con el corte contado", mReab.cobertura === 50 && mReab.cortes === 1, `${mReab.cobertura} % · ${mReab.cortes} corte(s)`);
  const mReabAntena = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805, cierreTs: P805 })!;
  chk("…igual si el punto del cierre era impreciso (no entra a la traza)", mReabAntena.cobertura === 50 && mReabAntena.finPor === "cierre", `${mReabAntena.cobertura} %`);
  const vReab = ver(mReabAntena, tr(vivo, P805));
  chk("…y el texto nombra el cierre tardío, no una hora prevista", /cerró el servicio a las 08:05: 26 min sin rastreo/.test(vReab.detalle), vReab.detalle);

  const marcasDespues = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805, cierreTs: C739, finTs: P805 })!;
  chk("cerró 07:39 pero marcó paraderos hasta 08:05: 50 %, por las marcas", marcasDespues.cobertura === 50 && marcasDespues.finPor === "marcas", `${marcasDespues.cobertura} % · ${marcasDespues.finPor}`);
  chk("…y el texto dice que siguió marcando paraderos", /siguió marcando paraderos hasta las 08:05/.test(ver(marcasDespues, tr(vivo, C739)).detalle));

  const cierreViejo = medirCobertura({ pts: vivo, destino: lejos, finPrevistoTs: P805, cierreTs: T7 + 5 * 60_000 })!;
  chk("un cierre seguido de más posiciones (se reanudó) NO es el fin: regla de siempre", cierreViejo.cobertura === sinCierre.cobertura && cierreViejo.finPor === "previsto");

  const m6166 = medirCobertura({ pts: traza6166, destino: destino6166, finPrevistoTs: fin6166, cierreTs: fin6166 })!;
  chk("#6166 con el cierre a la hora real (05:03): sigue Incompleto", m6166.cobertura <= 6, `${m6166.cobertura} %`);

  // Barrido: con un cierre válido la ventana es EXACTAMENTE max(última, cierre, marcas); nunca
  // supera la cobertura de la traza sola (no inventa señal), y con un cierre anterior a la traza
  // el resultado es idéntico al de sin cierre.
  let exacto = true, noInventa = true, igualSinCierre = true, subio = 0;
  for (let k = 0; k < 3000; k++) {
    const t = trazaAzar();
    const ult = t[t.length - 1].ts;
    const dest = rnd() < 0.5 ? { lat: LAT0 + 30_000 / M, lng: LNG0 } : null;
    const finPrev = rnd() < 0.7 ? ult + Math.floor((rnd() - 0.2) * 3_600_000) : null;
    const finTs = rnd() < 0.4 ? ult + Math.floor((rnd() - 0.5) * 3_600_000) : null;
    const cierreTs = ult + Math.floor((rnd() - 0.1) * 3_600_000);
    const sinC = medirCobertura({ pts: t, destino: dest, finPrevistoTs: finPrev, finTs })!;
    const conC = medirCobertura({ pts: t, destino: dest, finPrevistoTs: finPrev, finTs, cierreTs })!;
    const base = medirCobertura({ pts: t })!;
    if (conC.cobertura > base.cobertura) noInventa = false;
    if (cierreTs >= ult - 60_000) {
      if (conC.ventanaFinTs !== Math.max(ult, cierreTs, finTs ?? 0)) exacto = false;
      if (conC.cobertura > sinC.cobertura) subio++;
    } else if (conC.cobertura !== sinC.cobertura || conC.ventanaFinTs !== sinC.ventanaFinTs) igualSinCierre = false;
  }
  chk("barrido: con cierre, la ventana acaba en max(última señal, cierre, marcas)", exacto);
  chk("barrido: el cierre nunca da más cobertura que la traza sola", noInventa);
  chk("barrido: un cierre anterior a la traza no cambia nada", igualSinCierre);
  chk("corolario: el cierre sí corrige casos (no es una extensión muerta)", subio > 0, `${subio} casos suben`);

  const acc = trazaVacia();
  acumularFilasGps(acc, [
    { created_at: "2026-10-10T12:13:00Z", lat: LAT0, lng: LNG0, precision_m: 10, estado: "en_ruta" },
    { created_at: "2026-10-10T12:39:00Z", lat: LAT0, lng: LNG0, precision_m: 900, estado: "finalizado" },   // por antena
    { created_at: "2026-10-10T12:20:00Z", lat: LAT0, lng: LNG0, precision_m: 10, estado: "finalizado" },    // un cierre anterior
  ], true);
  chk("el saneo toma el ÚLTIMO 'finalizado', aunque sea impreciso, y no lo mete como posición",
    acc.cierreTs === Date.parse("2026-10-10T12:39:00Z") && acc.pts.length === 2 && acc.porAntena === 1, `cierre=${acc.cierreTs}`);
}

// ══ 9. Los tramos del diagnóstico ═══════════════════════════════════════════════════
console.log("\n9. Tramos sin rastreo: del mismo bucle que el %, y ninguna cifra existente cambia");
// El medirCobertura ANTERIOR a los tramos, copiado literal (con sus extensiones de /seguimiento).
function medirCoberturaAntes(e: {
  pts: PuntoCobertura[];
  destino?: { lat: number; lng: number } | null;
  finPrevistoTs?: number | null;
  inicioTs?: number | null;
  finTs?: number | null;
  hastaTs?: number | null;
  cierreTs?: number | null;
}) {
  const t = e.pts;
  if (!t || t.length < 2) return null;
  const ini0 = t[0].ts;
  const ini = e.inicioTs != null && Number.isFinite(e.inicioTs) && e.inicioTs < ini0 ? e.inicioTs : ini0;
  const ultimo = t[t.length - 1];
  const dest = e.destino;
  const llego = dest ? metros(ultimo.lat, ultimo.lng, dest.lat, dest.lng) <= AVANCE_CAIDO_M : false;
  const cierre = e.cierreTs != null && Number.isFinite(e.cierreTs) && e.cierreTs >= ultimo.ts - HUECO_MIN_S * 1000
    ? e.cierreTs : null;
  const marcas = e.finTs != null && Number.isFinite(e.finTs) ? e.finTs : null;
  let fin: number, finPor: FinVentana;
  if (e.hastaTs != null && Number.isFinite(e.hastaTs)) { fin = Math.max(ultimo.ts, e.hastaTs); finPor = "en_curso"; }
  else if (llego) { fin = ultimo.ts; finPor = "llegada"; }
  else if (cierre !== null) {
    fin = Math.max(ultimo.ts, cierre, marcas ?? 0);
    finPor = marcas !== null && marcas > Math.max(ultimo.ts, cierre) ? "marcas" : "cierre";
  } else {
    fin = Math.max(ultimo.ts, e.finPrevistoTs ?? 0, marcas ?? 0);
    finPor = fin === ultimo.ts ? "traza" : fin === marcas ? "marcas" : "previsto";
  }
  const ventanaS = Math.max(1, (fin - ini) / 1000);

  let cubiertoS = 0, cortes = 0, peorS = 0, metrosCiegos = 0;
  for (let i = 1; i < t.length; i++) {
    const gapS = (t[i].ts - t[i - 1].ts) / 1000;
    if (gapS <= HUECO_MIN_S) { cubiertoS += gapS; continue; }
    if (gapS > peorS) peorS = gapS;
    const avance = metros(t[i - 1].lat, t[i - 1].lng, t[i].lat, t[i].lng);
    if (avance >= AVANCE_CAIDO_M && avance <= AVANCE_MAX_M) { cortes++; metrosCiegos += avance; }
  }
  const colaS = (fin - ultimo.ts) / 1000;
  if (colaS > HUECO_MIN_S && peorS < colaS) peorS = colaS;
  const cabezaS = (ini0 - ini) / 1000;
  if (cabezaS > HUECO_MIN_S && peorS < cabezaS) peorS = cabezaS;

  return {
    ventanaIniTs: ini, ventanaFinTs: fin, finPor,
    durMin: Math.round(ventanaS / 60),
    cobertura: Math.max(0, Math.min(100, Math.round((cubiertoS / ventanaS) * 100))),
    cortes,
    peorHuecoMin: Math.round(peorS / 60),
    kmACiegas: Math.round(metrosCiegos / 100) / 10,
    primeraTs: ini0, ultimaTs: ultimo.ts,
  };
}
{
  let suma = true, movimiento = true, km = true, peor = true, orden = true, sinCambio = true, conTramos = 0, conCabeza = 0, conCola = 0;
  const CLAVES = ["ventanaIniTs", "ventanaFinTs", "finPor", "durMin", "cobertura", "cortes", "peorHuecoMin", "kmACiegas", "primeraTs", "ultimaTs"] as const;
  for (let k = 0; k < 3000; k++) {
    const t = trazaAzar();
    const ult = t[t.length - 1].ts;
    const conExt = k % 2 === 1;
    const args = {
      pts: t,
      destino: rnd() < 0.5 ? { lat: LAT0 + 30_000 / M, lng: LNG0 } : null,
      finPrevistoTs: rnd() < 0.6 ? ult + Math.floor((rnd() - 0.2) * 3_600_000) : null,
      ...(conExt ? {
        inicioTs: rnd() < 0.6 ? t[0].ts - Math.floor(rnd() * 1_800_000) : null,
        finTs: rnd() < 0.4 ? ult + Math.floor((rnd() - 0.5) * 3_600_000) : null,
        hastaTs: rnd() < 0.25 ? ult + Math.floor(rnd() * 1_800_000) : null,
        cierreTs: rnd() < 0.3 ? ult + Math.floor((rnd() - 0.1) * 3_600_000) : null,
      } : {}),
    };
    const m = medirCobertura(args)!;
    const a = medirCoberturaAntes(args)!;
    for (const c of CLAVES) if ((m as any)[c] !== (a as any)[c]) sinCambio = false;
    const ventanaS = (m.ventanaFinTs - m.ventanaIniTs) / 1000;
    const cabezaS = (m.primeraTs - m.ventanaIniTs) / 1000, colaS = (m.ventanaFinTs - m.ultimaTs) / 1000;
    const chicos = (cabezaS <= HUECO_MIN_S ? cabezaS : 0) + (colaS <= HUECO_MIN_S ? colaS : 0);
    const sumaTramos = m.tramos.reduce((x, tr) => x + tr.durS, 0);
    if (Math.abs(m.cubiertoS + sumaTramos + chicos - ventanaS) > 1e-6) suma = false;
    const enMov = m.tramos.filter((tr) => tr.enMovimiento);
    if (enMov.length !== m.cortes) movimiento = false;
    if (Math.round(enMov.reduce((x, tr) => x + (tr.avanceM ?? 0), 0) / 100) / 10 !== m.kmACiegas) km = false;
    const mayor = m.tramos.reduce((x, tr) => Math.max(x, tr.durS), 0);
    if (Math.round(mayor / 60) !== m.peorHuecoMin) peor = false;
    // cabeza primero, cola al final, huecos en orden; cabeza y cola solo si superan HUECO_MIN_S
    const tipos = m.tramos.map((tr) => tr.tipo);
    if (tipos.indexOf("cabeza") > 0 || (tipos.includes("cola") && tipos.lastIndexOf("cola") !== tipos.length - 1)) orden = false;
    if (m.tramos.some((tr) => tr.durS <= HUECO_MIN_S || tr.hastaTs < tr.desdeTs)) orden = false;
    if (m.tramos.some((tr) => tr.tipo !== "hueco" && (tr.enMovimiento || tr.avanceM !== null))) orden = false;
    if (m.tramos.length) conTramos++;
    if (tipos.includes("cabeza")) conCabeza++;
    if (tipos.includes("cola")) conCola++;
  }
  chk("barrido: cubierto + Σ tramos + cabeza/cola ≤ 60 s = la ventana", suma);
  chk("barrido: tramos en movimiento = cortes", movimiento);
  chk("barrido: Σ metros de los tramos en movimiento = kmACiegas", km);
  chk("barrido: el tramo más largo = peorHuecoMin", peor);
  chk("barrido: cabeza primero, cola al final, todos > 60 s, solo el hueco mide avance", orden);
  chk("barrido: ninguna cifra existente cambió (vs medirCobertura anterior, con y sin extensiones)", sinCambio);
  chk("corolario: hay tramos, cabezas y colas en el barrido (no es un motor que nunca los reporta)",
    conTramos > 500 && conCabeza > 50 && conCola > 100, `${conTramos} con tramos · ${conCabeza} cabezas · ${conCola} colas`);

  // El caso #6166: un solo tramo, la cola hasta la llegada marcada.
  const m6166 = medirCobertura({ pts: traza6166, destino: destino6166, finPrevistoTs: fin6166, finTs: fin6166 })!;
  chk("#6166: un solo tramo, la cola de 04:11 a 05:03, por marcas", m6166.tramos.length === 1 && m6166.tramos[0].tipo === "cola"
    && m6166.tramos[0].hastaTs === fin6166 && m6166.finPor === "marcas", JSON.stringify(m6166.tramos.map((t) => [t.tipo, Math.round(t.durS)])));

  // Las filas de diagnóstico: solo si se piden, con la misma clasificación, y sin tocar la traza.
  const filasCrudas = [
    { created_at: "2026-10-09T09:08:00Z", lat: LAT0, lng: LNG0, precision_m: 10, recibido_en: "2026-10-09T09:08:02Z", fix_ts: "2026-10-09T09:07:59Z", conductor_id: 7, conductor_tercero_id: null },
    { created_at: "2026-10-09T09:08:05Z", lat: LAT0, lng: LNG0, precision_m: 400, recibido_en: null, fix_ts: null, conductor_id: "7" },
    { created_at: "2026-10-09T09:08:10Z", lat: null, lng: LNG0, precision_m: 10 },
    { created_at: "nada", lat: LAT0, lng: LNG0 },
    { created_at: "2026-10-09T09:08:15Z", lat: LAT0, lng: LNG0, simulado: true, conductor_tercero_id: 3 },
  ];
  const sinFilas = trazaVacia();
  acumularFilasGps(sinFilas, filasCrudas, true);
  const conFilas = { ...trazaVacia(), filas: [] as any[] };
  acumularFilasGps(conFilas, filasCrudas, true);
  chk("trazaVacia() no trae filas, y sin pedirlas no aparecen", !("filas" in trazaVacia()) && sinFilas.filas === undefined);
  chk("con filas pedidas, la traza es idéntica", JSON.stringify({ ...conFilas, filas: undefined }) === JSON.stringify({ ...sinFilas, filas: undefined }));
  const f = conFilas.filas!;
  chk("filas: las 3 con coordenadas y fecha válidas, útil/antena con la misma regla", f.length === 3
    && f[0].util && !f[0].antena && !f[1].util && f[1].antena && f[2].util, JSON.stringify(f.map((x: any) => [x.util, x.antena])));
  chk("filas: recibido, fix y conductor leídos; ausentes → null (nunca 0)", f[0].recibidoTs === Date.parse("2026-10-09T09:08:02Z")
    && f[0].fixTs === Date.parse("2026-10-09T09:07:59Z") && f[0].conductorId === 7 && f[0].conductorTerceroId === null
    && f[1].recibidoTs === null && f[1].fixTs === null && f[1].conductorId === 7 && f[1].precisionM === 400
    && f[2].conductorTerceroId === 3 && f[2].precisionM === null);
}

// ══ 10. La extracción del veredicto por servicio ════════════════════════════════════
console.log("\n10. contextoServicio + veredictoDeServicio = el `medir` de rastreoDelDia");
{
  // `medir` de lib/gps-cobertura-datos.ts (rastreoDelDia), copiado literal. Lo único que cambia es
  // el entorno de su clausura: `trazaDe` lee de un mapa (lanza para simular un fallo de lectura).
  const harness = async (r: any, fecha: string, hoy: string, ahoraMs: number, paradasDe: Map<number, any[]>, trazas: Map<number, TrazaSaneada | null>) => {
    const out: Record<number, VeredictoRastreo> = {};
    const trazaDe = async (id: number) => { const t = trazas.get(id); if (!t) throw new Error("no se pudo leer"); return t; };
    const medir = async (r: any) => {
      const ps = paradasDe.get(r.id) ?? [];
      const completadas = ps.filter((p) => p.estado === "completada").length;
      const terminado = r.estado === "finalizada" || (ps.length > 0 && completadas === ps.length);
      // Un servicio "en curso" de OTRO día que nadie cerró no está en ruta: medirlo hasta ahora lo
      // hundiría por horas que no son de servicio. Se juzga como terminado, con su evidencia.
      const enCurso = fecha === hoy && r.estado === "en_curso" && !terminado;
      const aplica = terminado || r.estado === "en_curso" || completadas > 0;
      const t = derivarTiempos({ reserva: r, paradas: ps, ahoraMs, hoy });
      const inicioTs = t.inicio && !t.inicio.estimado ? t.inicio.ts : null;
      const finTs = t.finParadero && !t.finParadero.estimado ? t.finParadero.ts : null;
      if (!aplica) {
        out[r.id] = veredictoRastreo({ aplica: false, enCurso, traza: trazaVacia(), medicion: null, avanzo: false, inmovil: false, inicioTs, ahoraMs });
        return;
      }
      let traza: TrazaSaneada | null = null;
      try { traza = await trazaDe(r.id); } catch { traza = null; }
      const { finPrevistoTs, destino } = finYDestino(ps, r.fecha_servicio, r.hora_servicio);
      const medicion = traza
        ? medirCobertura({ pts: traza.pts, destino, finPrevistoTs, inicioTs, finTs, hastaTs: enCurso ? ahoraMs : null, cierreTs: traza.cierreTs })
        : null;
      out[r.id] = veredictoRastreo({
        aplica: true, enCurso, traza, medicion,
        avanzo: terminado || completadas >= 2,
        inmovil: traza ? trazaInmovil(traza.pts, ps) : false,
        inicioTs, ahoraMs,
      });
    };
    await medir(r);
    return out[r.id];
  };

  const HOY = "2026-10-09", AYER = "2026-10-08";
  const ESTADOS = ["finalizada", "en_curso", "programada", "confirmada", "pendiente", "cancelada"];
  const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const iso = (fecha: string, min: number) => new Date(Date.parse(`${fecha}T00:00:00-05:00`) + min * 60_000).toISOString();
  let iguales = 0, total = 0, codigos = new Set<string>(), noLeidas = 0;
  for (let k = 0; k < 2500; k++) {
    const fecha = rnd() < 0.7 ? HOY : AYER;
    const horaMin = Math.floor(rnd() * 1440);
    const r: any = {
      id: k + 1,
      estado: ESTADOS[Math.floor(rnd() * ESTADOS.length)],
      fecha_servicio: fecha,
      hora_servicio: rnd() < 0.95 ? hhmm(horaMin) + (rnd() < 0.5 ? ":00" : "") : null,
      hora_real_inicio: rnd() < 0.3 ? hhmm(horaMin + Math.floor(rnd() * 20)) + ":00" : null,
      hora_real_fin: rnd() < 0.2 ? hhmm(horaMin + 60 + Math.floor(rnd() * 60)) + ":00" : null,
      inicio_real_ts: rnd() < 0.15 ? iso(fecha, horaMin + Math.floor(rnd() * 15)) : null,
      inicio_real_fuente: rnd() < 0.5 ? "parada" : "operador",
    };
    const n = Math.floor(rnd() * 7);
    const ps = Array.from({ length: n }, (_, i) => {
      const est = horaMin + i * 12;
      const completada = rnd() < 0.6;
      return {
        id: (k + 1) * 10 + i, reserva_id: k + 1, orden: i + 1,
        estado: completada ? "completada" : "pendiente",
        hora_estimada: rnd() < 0.85 ? hhmm(est) : null,
        hora_llegada: completada && rnd() < 0.8 ? iso(fecha, est + Math.floor((rnd() - 0.3) * 20)) : null,
        lat: rnd() < 0.85 ? LAT0 + i * 0.02 : null, lng: rnd() < 0.85 ? LNG0 + i * 0.01 : null,
      };
    });
    // Traza alrededor de la hora del servicio; a veces no se pudo leer, a veces vacía, a veces con cierre.
    const base = Date.parse(`${fecha}T00:00:00-05:00`) + horaMin * 60_000;
    let traza: TrazaSaneada | null = null;
    const u = rnd();
    if (u < 0.1) { traza = null; noLeidas++; }
    else if (u < 0.2) traza = trazaVacia();
    else {
      const desplazo = base - T0 + Math.floor((rnd() - 0.3) * 1_200_000);
      const pts = trazaAzar().map((p) => ({ ...p, ts: p.ts + desplazo }));
      traza = { pts, totalCrudo: pts.length + (rnd() < 0.2 ? 5 : 0), porAntena: 0, simulados: 0,
        cierreTs: rnd() < 0.3 ? pts[pts.length - 1].ts + Math.floor((rnd() - 0.1) * 1_800_000) : null };
      if (rnd() < 0.05) traza = { ...traza, pts: traza.pts.slice(0, 1) };   // < 2 puntos útiles
    }
    const ahoraMs = base + Math.floor((rnd() - 0.2) * 6 * 3_600_000);
    const trazas = new Map<number, TrazaSaneada | null>([[r.id, traza]]);
    const viejo = await harness(r, fecha, HOY, ahoraMs, new Map([[r.id, ps]]), trazas);
    const ctx = contextoServicio(r, ps, { hoy: HOY, ahoraMs });
    const nuevo = veredictoDeServicio(ctx, traza, ps, ahoraMs).veredicto;
    total++;
    if (JSON.stringify(viejo) === JSON.stringify(nuevo)) iguales++;
    codigos.add(nuevo.codigo);
  }
  chk(`${iguales}/${total} veredictos idénticos`, iguales === total);
  chk("corolario: el barrido cubre los veredictos de la torre (no solo uno)", codigos.size >= 7, [...codigos].sort().join(", "));
  chk("…incluidas trazas que no se pudieron leer", noLeidas > 50, `${noLeidas}`);

  // La medición que devuelve es la que juzgó el veredicto (el modal enseña ESA).
  const ps = [{ id: 1, estado: "completada", hora_estimada: "04:10", lat: LAT0, lng: LNG0 }, { id: 2, estado: "completada", hora_estimada: "05:03", lat: destino6166.lat, lng: destino6166.lng, hora_llegada: new Date(fin6166).toISOString() }];
  const ctx = contextoServicio({ id: 6166, estado: "finalizada", fecha_servicio: "2026-10-09", hora_servicio: "04:08" }, ps, { hoy: "2026-10-09", ahoraMs: fin6166 + 3_600_000 });
  const { veredicto, medicion } = veredictoDeServicio(ctx, { ...trazaVacia(), pts: traza6166, totalCrudo: 37 }, ps, fin6166 + 3_600_000);
  chk("#6166 por la ruta nueva: Incompleto, y la medición es la que juzgó (cobertura = pct)", veredicto.codigo === "incompleto" && medicion?.cobertura === veredicto.pct,
    `${veredicto.codigo} · ${veredicto.celda}`);
  const noSale = veredictoDeServicio(contextoServicio({ id: 1, estado: "programada", fecha_servicio: "2026-10-09", hora_servicio: "23:00" }, [], { hoy: "2026-10-09", ahoraMs: T0 }), null, [], T0);
  chk("un servicio que no salió es no_aplica aunque la traza no se pudiera leer (no se lee)", noSale.veredicto.codigo === "no_aplica" && noSale.medicion === null);
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
