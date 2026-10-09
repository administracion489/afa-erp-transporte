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
import {
  medirCobertura, finYDestino, acumularFilasGps, trazaVacia, veredictoRastreo, resumenRastreo,
  trazaInmovil, bandaCobertura, metros as metrosMod, limaMs as limaMsMod,
  type PuntoCobertura, type TrazaSaneada,
} from "../lib/gps-cobertura";

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

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
