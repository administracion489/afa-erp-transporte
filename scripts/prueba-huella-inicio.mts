// scripts/prueba-huella-inicio.mts — el inicio del servicio en el modal GPS (reserva #1459, CWQ400,
// 14-10-2026). Correr: npx tsx scripts/prueba-huella-inicio.mts
//
// Tres defectos que se veían EN VIVO al empezar y uno al terminar:
//   1. La PUNTA de la huella: mientras el bus esperaba en la cochera, cada ~10 s llegaba un fix de RED
//      (±200 m) clavado en el mismo sitio a 214 m; cuando era el último recibido, el trazo dibujaba una
//      línea hasta él (anclarImprecisos no tenía ancla posterior en la cola).
//   2. El ÍCONO: el filtro del fix en vivo aceptaba ese fantasma (110 km/h, «plausible») y desde ahí
//      rechazaba los fixes de chip: el ícono quedó estacionado en el fantasma seis minutos.
//   3. El COLOR de la salida: el centroide de la parada (promedio de 6 min) recibía una velocidad
//      derivada de 62 km/h → verde «Rápido» donde el bus salía a 7 km/h.
//   4. Tras «Finalizar», el tiempo real aceptaba cualquier fila de la UNIDAD y el ícono saltaba a donde
//      estaba el bus ahora (filaEnVivoDelServicio).
// Lo que NO puede cambiar se fija contra las versiones anteriores copiadas literal (§0).

/* eslint-disable @typescript-eslint/no-explicit-any -- filas sintéticas con la forma de las de Supabase */
import * as H from "../lib/huella";
import { filaEnVivoDelServicio, type ContextoFilaVivo } from "../lib/gps-huella-servicio";

let fallos = 0;
const chk = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "  ok  " : "FALLA "} ${n}${extra ? " — " + extra : ""}`); if (!ok) fallos++; };
const seccion = (t: string) => console.log(`\n── ${t}`);
const { distM } = H;
type Pt = H.HuellaPt;

// ── 0. Las versiones ANTERIORES, copiadas literal de lib/huella.ts ───────────────────────────────
function proyectarEnSegmento(lat: number, lng: number, A: { lat: number; lng: number }, B: { lat: number; lng: number }): { lat: number; lng: number; dist: number } {
  const mLat = 111320, mLng = 111320 * Math.cos(lat * Math.PI / 180);
  const ax = A.lng * mLng, ay = A.lat * mLat, bx = B.lng * mLng, by = B.lat * mLat;
  const px = lng * mLng, py = lat * mLat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { lat: qy / mLat, lng: qx / mLng, dist: Math.hypot(px - qx, py - qy) };
}
function anclarViejo(pts: Pt[], umbral = 20, maxGapM = 200): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const relB = new Array<number>(n).fill(-1), relA = new Array<number>(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) { relB[i] = last; if (pts[i].acc <= umbral) last = i; }
  last = -1;
  for (let i = n - 1; i >= 0; i--) { relA[i] = last; if (pts[i].acc <= umbral) last = i; }
  const out = pts.slice();
  for (let i = 0; i < n; i++) {
    if (pts[i].acc <= umbral) continue;
    const jb = relB[i], ja = relA[i];
    if (jb < 0 || ja < 0) continue;
    if (distM(pts[jb].lat, pts[jb].lng, pts[ja].lat, pts[ja].lng) > maxGapM) continue;
    const q = proyectarEnSegmento(pts[i].lat, pts[i].lng, pts[jb], pts[ja]);
    if (q.dist > Math.max(70, 1.5 * pts[i].acc)) continue;
    out[i] = { ...pts[i], lat: q.lat, lng: q.lng };
  }
  return out;
}
function colorViejo(pts: Pt[], ventanaMs = 6000, maxKmh = 130): Pt[] {
  const tsFiable = pts.length >= 2 && pts[pts.length - 1].ts > pts[0].ts;
  return pts.map((p, i) => {
    if (p.velocidad > 0 && p.velocidad <= maxKmh) return p;
    if (!tsFiable) return p;
    let a = Math.max(0, i - 1), b = Math.min(pts.length - 1, i + 1);
    while (a > 0 && p.ts - pts[a - 1].ts < ventanaMs) a--;
    while (b < pts.length - 1 && pts[b + 1].ts - p.ts < ventanaMs) b++;
    const dt = (pts[b].ts - pts[a].ts) / 1000;
    if (dt <= 0) return p;
    const kmh = (distM(pts[a].lat, pts[a].lng, pts[b].lat, pts[b].lng) / dt) * 3.6;
    return kmh > maxKmh ? p : { ...p, velocidad: Math.round(kmh) };
  });
}
function filtroViejo(vmaxKmh = 130, reanclaN = 2) {
  type P = { lat: number; lng: number; ts: number };
  let ultimo: P | null = null;
  let pendientes: P[] = [];
  const vmax = vmaxKmh / 3.6;
  const plausible = (a: P, b: P) => distM(a.lat, a.lng, b.lat, b.lng) / Math.max(1, (b.ts - a.ts) / 1000) <= vmax;
  return (lat: number, lng: number, ts: number): boolean => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (!Number.isFinite(ts)) return true;
    const cand: P = { lat, lng, ts };
    if (!ultimo || !(ts > ultimo.ts)) { ultimo = cand; pendientes = []; return true; }
    const ultimoPendiente = pendientes[pendientes.length - 1];
    if (ultimoPendiente && ultimoPendiente.ts === ts) return false;
    if (plausible(ultimo, cand)) { ultimo = cand; pendientes = []; return true; }
    if (ultimoPendiente && !plausible(ultimoPendiente, cand)) pendientes = [];
    pendientes.push(cand);
    if (pendientes.length >= reanclaN) { ultimo = cand; pendientes = []; return true; }
    return false;
  };
}

// ── Los datos reales: reserva #1459, 16:09:24 → 16:16:35 (hora, lat, lng, precisión, velocidad) ──
const CRUDO = `16:09:24,-8.141583,-79.015492,100.0,0.0;16:09:38,-8.140012,-79.014884,200.0,0.0;16:09:42,-8.141774,-79.015677,7.0,1.0;16:09:48,-8.140012,-79.014884,200.0,0.0;16:09:52,-8.141760,-79.015694,6.0,0.0;16:09:59,-8.140012,-79.014884,200.0,0.0;16:10:02,-8.141765,-79.015700,5.5,0.0;16:10:10,-8.140012,-79.014884,200.0,0.0;16:10:14,-8.141754,-79.015684,4.5,2.0;16:10:21,-8.140012,-79.014884,200.0,0.0;16:10:24,-8.141762,-79.015692,4.0,0.0;16:10:31,-8.140012,-79.014884,200.0,0.0;16:10:34,-8.141762,-79.015692,4.0,0.0;16:10:42,-8.140012,-79.014884,200.0,0.0;16:10:46,-8.141762,-79.015717,3.5,0.0;16:10:53,-8.140012,-79.014884,200.0,0.0;16:10:56,-8.141759,-79.015714,3.8,1.0;16:11:04,-8.140012,-79.014884,200.0,0.0;16:11:07,-8.141745,-79.015710,3.4,0.0;16:11:14,-8.140012,-79.014884,200.0,0.0;16:11:17,-8.141737,-79.015698,3.1,0.0;16:11:25,-8.140012,-79.014884,200.0,0.0;16:11:28,-8.141737,-79.015689,3.0,0.0;16:11:36,-8.140012,-79.014884,200.0,0.0;16:11:39,-8.141732,-79.015692,3.0,0.0;16:11:46,-8.140012,-79.014884,200.0,0.0;16:11:50,-8.141741,-79.015708,2.0,0.0;16:11:57,-8.140012,-79.014884,200.0,0.0;16:12:00,-8.141720,-79.015725,2.5,0.0;16:12:08,-8.140012,-79.014884,200.0,0.0;16:12:11,-8.141724,-79.015714,3.0,0.0;16:12:19,-8.140012,-79.014884,200.0,0.0;16:12:22,-8.141718,-79.015733,2.0,0.0;16:12:29,-8.140012,-79.014884,200.0,0.0;16:12:33,-8.141719,-79.015727,3.0,0.0;16:12:40,-8.140012,-79.014884,200.0,0.0;16:12:43,-8.141719,-79.015730,3.0,0.0;16:12:50,-8.140012,-79.014884,200.0,0.0;16:12:54,-8.141754,-79.015753,2.0,0.0;16:13:01,-8.140012,-79.014884,200.0,0.0;16:13:04,-8.141760,-79.015753,2.5,0.0;16:13:18,-8.141749,-79.015742,2.5,0.0;16:13:21,-8.141752,-79.015740,3.6,0.0;16:13:37,-8.141754,-79.015738,3.3,0.0;16:13:48,-8.140012,-79.014884,200.0,0.0;16:13:51,-8.141752,-79.015737,3.0,0.0;16:13:58,-8.140012,-79.014884,200.0,0.0;16:14:02,-8.141749,-79.015742,2.5,0.0;16:14:15,-8.140012,-79.014884,200.0,0.0;16:14:18,-8.141749,-79.015742,2.0,0.0;16:14:31,-8.140012,-79.014884,200.0,0.0;16:14:35,-8.141744,-79.015742,3.3,0.0;16:14:42,-8.140012,-79.014884,200.0,0.0;16:14:45,-8.141746,-79.015746,3.2,0.0;16:14:49,-8.141745,-79.015748,3.4,7.0;16:14:53,-8.141726,-79.015675,7.3,6.0;16:14:56,-8.141766,-79.015624,2.5,8.0;16:14:59,-8.141807,-79.015571,7.1,4.0;16:15:03,-8.141846,-79.015551,6.6,5.0;16:15:06,-8.140012,-79.014884,200.0,0.0;16:15:09,-8.141739,-79.015298,50.4,0.0;16:15:12,-8.142029,-79.015456,2.5,13.0;16:15:15,-8.142133,-79.015423,5.5,13.0;16:15:19,-8.142245,-79.015405,3.9,10.0;16:15:23,-8.142291,-79.015325,2.7,10.0;16:15:27,-8.142258,-79.015215,3.0,15.0;16:15:31,-8.142220,-79.015069,4.1,16.0;16:15:35,-8.142163,-79.014922,7.1,14.0;16:15:39,-8.142093,-79.014747,4.6,17.0;16:15:41,-8.140012,-79.014884,200.0,0.0;16:15:45,-8.141972,-79.014521,6.5,8.0;16:15:49,-8.141936,-79.014480,4.4,1.0;16:15:52,-8.141938,-79.014477,4.5,1.0;16:15:56,-8.141940,-79.014439,4.5,5.0;16:15:59,-8.141925,-79.014366,4.5,15.0;16:16:03,-8.141841,-79.014150,4.9,20.0;16:16:07,-8.141780,-79.013978,4.3,10.0;16:16:11,-8.141753,-79.013907,3.5,4.0;16:16:15,-8.141732,-79.013881,3.6,2.0;16:16:19,-8.141707,-79.013833,3.6,9.0;16:16:23,-8.141648,-79.013739,3.5,11.0;16:16:27,-8.141607,-79.013641,3.8,10.0;16:16:31,-8.141598,-79.013527,3.5,11.0;16:16:35,-8.141606,-79.013473,3.3,1.0`;
const FILAS = CRUDO.split(";").map((l, i) => {
  const [hora, lat, lng, prec, vel] = l.split(",");
  return { id: i + 1, hora, created_at: new Date(`2026-10-14T${hora}-05:00`).toISOString(), lat: +lat, lng: +lng,
    precision_m: +prec, velocidad: +vel, rumbo: 0, estado: "en_ruta", simulado: false };
});
const FANTASMA = { lat: -8.140012, lng: -79.014884 };
const SALE = Date.parse("2026-10-14T16:14:49-05:00");          // el bus empieza a moverse
const ultimoPrecisoAntes = (n: number) => { for (let k = n - 1; k >= 0; k--) if (FILAS[k].precision_m <= 20) return FILAS[k]; return null; };

seccion("1 · la punta de la huella en vivo (anclarImprecisos en la cola)");
{
  let peor = 0, n0 = 0;
  let peorViejo = 0;
  for (let n = 3; n <= FILAS.length; n++) {
    const pre = FILAS.slice(0, n), pr = ultimoPrecisoAntes(n);
    if (!pr) continue;
    const L = H.huellaDeFilas(pre).limpio.at(-1)!;
    peor = Math.max(peor, distM(L.lat, L.lng, pr.lat, pr.lng) * (Date.parse(pre[n - 1].created_at) < SALE ? 1 : 0));
    // El mismo prefijo con el ancla vieja: el trazo terminaba en el fantasma.
    const brutos = H.filasAPuntos(pre);
    const Lv = H.limpiarHuella(anclarViejo(brutos)).at(-1)!;
    if (Date.parse(pre[n - 1].created_at) < SALE) { n0++; peorViejo = Math.max(peorViejo, distM(Lv.lat, Lv.lng, pr.lat, pr.lng)); }
  }
  chk("1a REGRESIÓN: con el ancla vieja, en la cochera la punta llegaba al fantasma (>200 m)", peorViejo > 200, `${Math.round(peorViejo)} m`);
  chk(`1b ahora, en los ${n0} prefijos de la espera, la punta queda a <50 m del bus`, peor < 50, `${Math.round(peor)} m`);
  // Reglas sueltas.
  const p = (lat: number, lng: number, acc: number, s: number): Pt => ({ lat, lng, acc, ts: SALE + s * 1000, velocidad: 0 });
  const base = [p(-8.14175, -79.01570, 3, 0), p(-8.14175, -79.01569, 3, 4)];
  const fant = (s: number, acc = 200) => p(FANTASMA.lat, FANTASMA.lng, acc, s);
  const a1 = H.anclarImprecisos([...base, fant(10)]);
  chk("1c un impreciso en la cola, dentro de su error y a 6 s del último preciso → en el preciso",
    a1[2].lat === base[1].lat && a1[2].lng === base[1].lng && a1[2].acc === 200 && a1[2].ts === base[1].ts + 6000);
  const a2 = H.anclarImprecisos([...base, fant(4 + H.VIGENCIA_ANCLA_COLA_MS / 1000 + 1)]);
  chk("1d pasada la vigencia (el chip se perdió de verdad) → intacto", a2[2].lat === FANTASMA.lat);
  const a3 = H.anclarImprecisos([...base, fant(10, 100)]);
  chk("1e fuera de su propio radio (214 m > 1.5·100) → intacto", a3[2].lat === FANTASMA.lat);
  const a4 = H.anclarImprecisos([base[0], fant(10)]);
  chk("1f con dos puntos también se ancla (antes n<3 no hacía nada)", a4[1].lat === base[0].lat);
  chk("1g la cabeza sin ancla previa sigue intacta", H.anclarImprecisos([fant(0), ...base.map((q) => ({ ...q, ts: q.ts + 10000 }))])[0].lat === FANTASMA.lat);
  chk("1h radioAncla es el de siempre: max(70, 1.5·acc)", H.radioAncla(10) === 70 && H.radioAncla(200) === 300);
}

seccion("1i-1k · lo que NO cambia: todo punto con un confiable después, y la traza terminada");
{
  let rnd = 12345;
  const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let iguales = 0, total = 0, colaOk = true, terminadasIguales = 0, terminadas = 0, anclasCola = 0;
  for (let caso = 0; caso < 3000; caso++) {
    const n = 2 + Math.floor(r() * 18);
    const pts: Pt[] = [];
    let lat = -12, lng = -77, ts = 1e12;
    for (let i = 0; i < n; i++) {
      lat += (r() - 0.5) * 0.002; lng += (r() - 0.5) * 0.002; ts += 1000 + Math.floor(r() * 12000);
      pts.push({ lat, lng, ts, velocidad: 0, acc: r() < 0.4 ? 30 + Math.floor(r() * 300) : 2 + Math.floor(r() * 18) });
    }
    const nuevo = H.anclarImprecisos(pts), viejo = anclarViejo(pts);
    let ultPreciso = -1;
    for (let i = 0; i < n; i++) if (pts[i].acc <= 20) ultPreciso = i;
    for (let i = 0; i < n; i++) {
      if (i < ultPreciso) { total++; if (JSON.stringify(nuevo[i]) === JSON.stringify(viejo[i])) iguales++; }
      else if (JSON.stringify(nuevo[i]) !== JSON.stringify(viejo[i])) {
        anclasCola++;
        const ok = pts[ultPreciso] && nuevo[i].lat === pts[ultPreciso].lat && nuevo[i].lng === pts[ultPreciso].lng
          && pts[i].ts - pts[ultPreciso].ts <= H.VIGENCIA_ANCLA_COLA_MS
          && distM(pts[ultPreciso].lat, pts[ultPreciso].lng, pts[i].lat, pts[i].lng) <= H.radioAncla(pts[i].acc);
        if (!ok) colaOk = false;
      }
    }
    if (pts[n - 1].acc <= 20) { terminadas++; if (JSON.stringify(nuevo) === JSON.stringify(viejo)) terminadasIguales++; }
  }
  chk(`1i todo punto con un confiable después: idéntico al ancla vieja (${total} puntos)`, iguales === total, `${total - iguales} distintos`);
  chk(`1j una traza que termina en un confiable: idéntica entera (${terminadas} trazas)`, terminadasIguales === terminadas);
  chk("1k en la cola solo cambia lo que la regla declara, y el barrido sí lo ejerce", colaOk && anclasCola > 0, `${anclasCola} anclados`);
}

seccion("2 · el color de la salida: el centroide de la parada no se deriva");
{
  const salida = FILAS.filter((f) => Date.parse(f.created_at) <= Date.parse("2026-10-14T16:15:35-05:00"));
  const { limpio } = H.huellaDeFilas(salida);
  const c = limpio[0];
  chk("2a el primer vértice es el centroide de la espera y se marca `parada`", c.parada === true && c.velocidad === 0);
  const crudos = H.anclarImprecisos(H.filasAPuntos(salida));
  const viejo = colorViejo(H.limpiarHuella(crudos).map((q) => { const c = { ...q }; delete c.parada; return c; }));
  chk("2b REGRESIÓN: con el color viejo salía «Rápido» (≥55 km/h) en la cochera", viejo[0].velocidad >= 55, `${viejo[0].velocidad} km/h`);
  chk("2c ahora sale Parado (0 km/h)", c.velocidad === 0);
  // Equipo SIN Doppler (velocidad siempre 0): el primer fix en marcha no se deriva desde el centroide.
  const sinDoppler = H.huellaDeFilas(salida.map((f) => ({ ...f, velocidad: 0 }))).limpio;
  const v1 = sinDoppler[1].velocidad;
  chk("2d sin Doppler, el primer fix en marcha no hereda la velocidad fantasma del centroide", v1 < 30, `${v1} km/h`);
  // Sin paradas, conVelocidadColor es el de siempre.
  let rnd = 777, iguales = 0;
  const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let caso = 0; caso < 1500; caso++) {
    const pts: Pt[] = []; let lat = -12, ts = 1e12;
    const n = 1 + Math.floor(r() * 15);
    for (let i = 0; i < n; i++) { lat += r() * 0.001; ts += Math.floor(r() * 9000); pts.push({ lat, lng: -77, ts, acc: 5, velocidad: r() < 0.5 ? 0 : Math.floor(r() * 150) }); }
    if (JSON.stringify(H.conVelocidadColor(pts)) === JSON.stringify(colorViejo(pts))) iguales++;
  }
  chk("2e sin centroides, conVelocidadColor idéntico al de antes (1500 trazas)", iguales === 1500, `${1500 - iguales} distintas`);
  const conParadas = H.limpiarHuella(H.anclarImprecisos(H.filasAPuntos(FILAS)));
  chk("2f el flag solo lo llevan vértices en 0 km/h", conParadas.every((q) => !q.parada || q.velocidad === 0) && conParadas.some((q) => q.parada));
}

seccion("3 · el ícono en vivo (crearFiltroFixVivo con la precisión)");
{
  const recorrer = (conAcc: boolean) => {
    const f = H.crearFiltroFixVivo();
    let icono: any = null, peor = 0;
    for (let k = 0; k < FILAS.length; k++) {
      const q = FILAS[k], ts = Date.parse(q.created_at);
      if (f(q.lat, q.lng, ts, conAcc ? q.precision_m : undefined)) icono = q;
      const pr = ultimoPrecisoAntes(k + 1);
      if (icono && pr && ts - Date.parse(pr.created_at) < 15000 && k >= 3) peor = Math.max(peor, distM(icono.lat, icono.lng, pr.lat, pr.lng));
    }
    return peor;
  };
  chk("3a REGRESIÓN: sin la precisión el ícono quedaba en el fantasma (>200 m del bus)", recorrer(false) > 200, `${Math.round(recorrer(false))} m`);
  chk("3b con la precisión, el ícono nunca se aleja más de 80 m del bus", recorrer(true) < 80, `${Math.round(recorrer(true))} m`);
  // Sin precisión, decisión a decisión, el filtro de siempre.
  let rnd = 4242, iguales = 0, total = 0;
  const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let caso = 0; caso < 800; caso++) {
    const a = H.crearFiltroFixVivo(), b = filtroViejo();
    let lat = -12, ts = 1e12;
    for (let i = 0; i < 25; i++) {
      lat += (r() - 0.45) * (r() < 0.15 ? 0.02 : 0.0008); ts += r() < 0.05 ? -3000 : Math.floor(r() * 8000);
      const tsx = r() < 0.03 ? NaN : ts;
      total++; if (a(lat, -77, tsx) === b(lat, -77, tsx)) iguales++;
    }
  }
  chk(`3c sin precisión: las mismas ${total} decisiones que el filtro anterior`, iguales === total, `${total - iguales} distintas`);
  // El glitch de #24742 sigue fuera: ±300 m, 300 m en 3 s, entre fixes de chip.
  const f = H.crearFiltroFixVivo(), T = 1e12, M = 1 / 111_320;
  f(-12, -77, T, 4); f(-12 + 10 * M, -77, T + 3000, 4);
  chk("3d el glitch de #24742 (±300 m, 300 m en 3 s) sigue rechazado", f(-12 + 310 * M, -77, T + 6000, 300) === false);
  chk("3e y el siguiente fix de chip se acepta", f(-12 + 20 * M, -77, T + 9000, 4) === true);
  // Pérdida real del chip: pasada la vigencia, la red se juzga como siempre.
  const g = H.crearFiltroFixVivo();
  g(-12, -77, T, 4);
  chk("3f un impreciso fuera de la vigencia que avanza a velocidad plausible SÍ mueve el ícono", g(-12 + 250 * M, -77, T + 20000, 150) === true);
  // Regla 2: un fix de chip que contradice a un último impreciso lo reemplaza.
  const h = H.crearFiltroFixVivo();
  h(-12, -77, T, 200);
  chk("3g un fix de chip a 214 m de un último ±200 m en 4 s se acepta (el impreciso era el otro)", h(-12 + 214 * M, -77, T + 4000, 3) === true);
  const h2 = H.crearFiltroFixVivo();
  h2(-12, -77, T, 200);
  chk("3h …pero un impreciso a 214 m en 2 s desde otro impreciso no (la regla 2 no afloja a los imprecisos)", h2(-12 + 214 * M, -77, T + 2000, 150) === false);
}

seccion("4 · tras «Finalizar»: qué fila del tiempo real es del servicio (filaEnVivoDelServicio)");
{
  const ctx = (c: Partial<ContextoFilaVivo>): ContextoFilaVivo => ({ reservaId: 1459, vehiculoId: 7, vehiculoTerceroId: null, vioFilaDelServicio: true, servicioCerrado: false, ultimoTs: null, ...c });
  const fila = (f: any) => ({ lat: -8.1, lng: -79, estado: "en_ruta", created_at: "2026-10-14T21:50:00Z", vehiculo_id: 7, vehiculo_tercero_id: null, reserva_id: 1459, ...f });
  const v = (f: any, c: Partial<ContextoFilaVivo>) => filaEnVivoDelServicio(fila(f), ctx(c));
  chk("4a una fila de esta reserva es del servicio", v({}, {}).motivo === "del_servicio" && v({}, {}).acepta);
  chk("4b una más vieja que la que se muestra no (la cola offline no hace retroceder el ícono)", v({}, { ultimoTs: Date.parse("2026-10-14T21:51:00Z") }).motivo === "anterior");
  chk("4c la de OTRA reserva de la misma unidad, nunca", v({ reserva_id: 1500 }, {}).motivo === "otro_servicio" && v({ reserva_id: 1500 }, { vioFilaDelServicio: false }).acepta === false);
  chk("4d sin reserva, con el servicio cerrado: no", v({ reserva_id: null }, { servicioCerrado: true }).motivo === "servicio_cerrado");
  chk("4e sin reserva, cuando ya llegó una fila del servicio: no", v({ reserva_id: null }, {}).motivo === "fuera_del_servicio");
  chk("4f sin reserva, antes de la primera fila del servicio y en_ruta: sí (el respaldo de la consulta)", v({ reserva_id: null }, { vioFilaDelServicio: false }).acepta);
  chk("4g …pero «disponible» (conectado sin servicio) no", v({ reserva_id: null, estado: "disponible" }, { vioFilaDelServicio: false }).motivo === "sin_servicio");
  chk("4h otra unidad: no", v({ reserva_id: null, vehiculo_id: 8 }, { vioFilaDelServicio: false }).motivo === "otra_unidad");
  chk("4i tercerizado: manda la unidad de tercero (los ids se solapan)",
    !filaEnVivoDelServicio(fila({ reserva_id: null, vehiculo_id: 3, vehiculo_tercero_id: null }), ctx({ vehiculoId: null, vehiculoTerceroId: 3, vioFilaDelServicio: false })).acepta
    && filaEnVivoDelServicio(fila({ reserva_id: null, vehiculo_id: null, vehiculo_tercero_id: 3 }), ctx({ vehiculoId: null, vehiculoTerceroId: 3, vioFilaDelServicio: false })).acepta);
  chk("4j sin reserva en el modal: la regla de antes, la unidad", filaEnVivoDelServicio(fila({ reserva_id: 99 }), ctx({ reservaId: null })).acepta);
  chk("4k una fila de esta reserva de OTRA unidad (reasignada) sí es del servicio", v({ vehiculo_id: 9 }, {}).acepta);
  // La línea de tiempo de #1459: el servicio cierra a las 16:46:08 y la unidad sigue transmitiendo.
  const fin = fila({ estado: "finalizado", created_at: "2026-10-14T21:46:08Z" });
  let cerrado = false, vio = false, ultimoTs: number | null = null, saltos = 0;
  const mostrar = (f: any) => { ultimoTs = Date.parse(f.created_at); if (Number(f.reserva_id) === 1459) { vio = true; if (f.estado === "finalizado") cerrado = true; } };
  mostrar(fin);
  for (let s = 0; s < 600; s += 4) {
    const despues = fila({ reserva_id: s % 3 === 0 ? null : 1501, created_at: new Date(Date.parse("2026-10-14T21:47:00Z") + s * 1000).toISOString() });
    const r1 = filaEnVivoDelServicio(despues, ctx({ vioFilaDelServicio: vio, servicioCerrado: cerrado, ultimoTs }));
    if (r1.acepta) { saltos++; mostrar(despues); }
  }
  chk("4l después de «Finalizar», 10 min de la unidad transmitiendo no mueven el ícono", saltos === 0, `${saltos} saltos`);
  // REGRESIÓN: la regla vieja del tiempo real solo miraba la unidad → aceptaba todas.
  const matchViejo = (d: any) => (d.vehiculo_id === 7) || (d.reserva_id === 1459);
  let saltosViejo = 0;
  for (let s = 0; s < 600; s += 4) if (matchViejo(fila({ reserva_id: s % 3 === 0 ? null : 1501 }))) saltosViejo++;
  chk("4m REGRESIÓN: con la regla vieja (solo la unidad) cada fila movía el ícono", saltosViejo === 150, `${saltosViejo}`);
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
