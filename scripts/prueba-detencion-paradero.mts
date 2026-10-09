// Pruebas de «¿DÓNDE está detenida la unidad?» del header del modal GPS. NO tocan la base: datos
// en memoria contra el motor puro lib/gps-detencion.ts.
// Uso:  npx tsx scripts/prueba-detencion-paradero.mts   (sale con código 1 si algo falla)
//
// EL CASO (reserva #30204, PIERIPLAST, 09-10-2026): el bus llegó al PRIMER paradero y esperó la
// hora de salida. El header decía «⚠ Unidad sin movimiento · hace 16 min — GPS pegado o teléfono
// fuera del bus», en ámbar. Esa alarma nació de #951 (el motor de ubicación del teléfono se colgó
// y sirvió el MISMO punto 75 min, ±100, con el bus en ruta), y no se puede perder. Lo que fija:
//   0. la quietud se EXTRAJO, no se reescribió: `medirQuietud().ms` ≡ el `sinMov` original de
//      ModalGps, copiado literal, salvo la divergencia declarada (filas sin coordenadas);
//   1. #30204 → `en_paradero`, sin alarma; #951 TAL CUAL OCURRIÓ (posición byte-idéntica JUNTO
//      al paradero 1, sin marcas, a ±100 y a ±10) → `posicion_clavada`, con el texto y el ámbar
//      de siempre byte a byte; y la variante con el conductor marcando → `marcadas_despues`;
//   2-5. el borde del radio, la precisión, las paradas sin coordenadas (que NO se cuelan como
//      (0, 0)), que gana el paradero más cercano, y el destino final con su propio motivo;
//   6. el cliente nunca recibe la imputación, ni una instrucción interna, ni un ámbar sin texto;
//   7. la estabilidad: el centro de la detención y su precisión salen de la VENTANA quieta, así
//      que el veredicto no salta con el jitter de un fix (borde del radio, precisión en el
//      umbral) ni al arrancar el bus (el lugar y los minutos salen del mismo cálculo);
//   8. por barrido: invariantes del motor y del rótulo, y su corolario (cada código aparece).
import {
  juzgarDetencion, medirQuietud, rotuloDetencion,
  RADIO_DETENCION_M, POS_CLAVADA_MS, CODIGOS_DETENCION,
  type FilaQuietud, type ParadaDetencion, type PosicionDetencion, type VeredictoDetencion,
} from "../lib/gps-detencion";
import { distM } from "../lib/huella";
import { PRECISION_MAX_M } from "../lib/gps-cobertura";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Lo VIEJO, copiado literal de components/seguimiento/ModalGps.tsx (antes de este cambio) ──
// Texto:  `⚠ Unidad sin movimiento · hace ${sinMovMin} min${debilM > 0 ? ` · ±${debilM}m` : ""} — GPS pegado o teléfono fuera del bus`
// Title:  "La unidad no se desplaza con el servicio en curso. Causas: …"
const textoViejo = (sinMovMin: number, debilM: number) =>
  `⚠ Unidad sin movimiento · hace ${sinMovMin} min${debilM > 0 ? ` · ±${debilM}m` : ""} — GPS pegado o teléfono fuera del bus`;
const TITLE_VIEJO = "La unidad no se desplaza con el servicio en curso. Causas: GPS del teléfono PEGADO (pídele apagar/encender la Ubicación; si sigue, reiniciar el celular — caso #951), teléfono fuera del vehículo, o unidad varada. El conductor ya ve esta alerta en su pantalla.";
// El detector de quietud, LITERAL (era una IIFE dentro del ciclo de huella; el `any` es el suyo).
const sinMovViejo = (arr: readonly FilaQuietud[]) => (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pts = (arr as any[])
    .map(r => ({ t: new Date(r.created_at || r.timestamp || 0).getTime(), lat: Number(r.lat), lng: Number(r.lng) }))
    .filter(p => p.t > 0 && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 3) return 0;
  const cur = pts[pts.length - 1];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (distM(pts[i].lat, pts[i].lng, cur.lat, cur.lng) > 150) return cur.t - pts[i].t; // último movimiento real
  }
  return cur.t - pts[0].t; // nunca se movió en toda la ventana
})();

// ── Geometría local en metros (x este, y norte) ──────────────────────────────────────
// La escala de latitud usa el MISMO radio terrestre que distM (6 371 000 m): a lo largo de un
// meridiano la distancia es exacta, y los casos de borde del radio caen donde dicen caer.
const LAT0 = -12.03, LNG0 = -76.95;
const R = 6_371_000;
const K_LAT = (R * Math.PI) / 180, K_LNG = K_LAT * Math.cos((LAT0 * Math.PI) / 180);
const aGeo = (x: number, y: number) => ({ lat: LAT0 + y / K_LAT, lng: LNG0 + x / K_LNG });

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** La ruta del caso #30204 (misma geometría que prueba-se-aleja.mts): el 1 en el origen, el 2 a
 *  6.1 km al sur, el 3 (la planta, destino final) más allá. */
const NOMBRES = ["Av. Los Frutales", "Puente Santa Anita", "Planta Pieriplast"];
const ruta = (completadas: boolean[] = [true, false, false]): ParadaDetencion[] =>
  [aGeo(0, 0), aGeo(0, -6100), aGeo(0, -9000)].map((p, i) => ({ ...p, completada: !!completadas[i], nombre: NOMBRES[i] }));
const en = (x: number, y: number, acc: number | null = 5): PosicionDetencion => ({ ...aGeo(x, y), accM: acc });

// Una fila de huella como la entrega /api/cliente/gps.
const T0 = Date.parse("2026-10-09T10:30:00Z");
const fila = (x: number, y: number, seg: number, acc: number | null = 8): FilaQuietud =>
  ({ ...aGeo(x, y), created_at: new Date(T0 + seg * 1000).toISOString(), precision_m: acc });
/** El pipeline del modal: la huella → quietud → (si lleva > 10 min) veredicto con su ancla. */
function delModal(huella: FilaQuietud[], paradas: ParadaDetencion[]) {
  const q = medirQuietud(huella);
  if (!(q.ms > 10 * 60000)) return { q, v: null as VeredictoDetencion | null, min: 0 };
  const v = juzgarDetencion({ lat: q.ancla?.lat, lng: q.ancla?.lng, accM: q.accM }, paradas,
    { clavadaMs: q.clavada.ms, clavadaFixes: q.clavada.fixes });
  return { q, v, min: Math.floor(q.ms / 60000) };
}
/** Llegada desde 2 km al norte del paradero 1, un fix cada 20 s durante 5 min. */
const llegada = (acc = 8): FilaQuietud[] =>
  Array.from({ length: 15 }, (_, i) => fila(0, 2000 - i * 130, i * 20, acc));

// ── 0. LA EXTRACCIÓN ──────────────────────────────────────────────────────────────────
{
  const rnd = mulberry32(951);
  let distintas = 0, casos = 0;
  const notas: string[] = [];
  for (let k = 0; k < 3000; k++) {
    const n = Math.floor(rnd() * 40);
    const arr: FilaQuietud[] = [];
    let x = (rnd() - 0.5) * 2000, y = (rnd() - 0.5) * 2000;
    for (let i = 0; i < n; i++) {
      // Paseo: a veces quieto con jitter, a veces salta; horas desordenadas, repetidas, inválidas.
      const u = rnd();
      if (u < 0.5) { x += (rnd() - 0.5) * 20; y += (rnd() - 0.5) * 20; }
      else if (u < 0.8) { x += (rnd() - 0.5) * 400; y += (rnd() - 0.5) * 400; }
      const g = aGeo(x, y);
      const seg = Math.floor(rnd() * 5400);
      const v = rnd();
      const ts = new Date(T0 + seg * 1000).toISOString();
      arr.push(v < 0.04 ? { lat: g.lat, lng: g.lng, created_at: "no-es-fecha" }
        : v < 0.5 ? { lat: g.lat, lng: g.lng, created_at: ts, precision_m: rnd() * 200 }
        : v < 0.75 ? { lat: String(g.lat), lng: String(g.lng), timestamp: ts }
        : { lat: g.lat, lng: g.lng, created_at: null, timestamp: ts, precision_m: null });
      if (rnd() < 0.1 && arr.length) arr.push({ ...arr[arr.length - 1] }); // fila duplicada
    }
    casos++;
    const a = sinMovViejo(arr), b = medirQuietud(arr).ms;
    if (a !== b) { distintas++; if (notas.length < 3) notas.push(`${a} vs ${b}`); }
  }
  chk(`medirQuietud().ms ≡ el sinMov original en ${casos} huellas`, distintas === 0, notas.join(" · "));

  // LA DIVERGENCIA DECLARADA: una fila sin coordenadas utilizables ya no entra como (0, 0).
  const quieta = Array.from({ length: 40 }, (_, i) => fila(3, 3, i * 20));
  const conNula = [...quieta, { lat: null, lng: null, created_at: new Date(T0 + 40 * 20 * 1000).toISOString() } as FilaQuietud,
    fila(3, 3, 41 * 20)];
  chk("divergencia declarada: el original leía la fila nula como (0, 0) y reiniciaba la quietud",
    sinMovViejo(conNula) < 60_000, `${sinMovViejo(conNula)} ms`);
  chk("divergencia declarada: medirQuietud la ignora y la quietud sigue", medirQuietud(conNula).ms >= 13 * 60_000, `${medirQuietud(conNula).ms} ms`);
  chk("menos de 3 puntos → sin quietud, sin ancla", medirQuietud([fila(0, 0, 0), fila(0, 0, 900)]).ms === 0 && medirQuietud([fila(0, 0, 0)]).ancla === null);
  chk("huella null → sin quietud", medirQuietud(null).ms === 0);
}

// ── 1. LOS CASOS REALES ───────────────────────────────────────────────────────────────
{
  // #30204: llega al paradero 1 y espera 16 min a ~20 m, con el jitter de un GPS vivo (±6 m).
  const rnd = mulberry32(30204);
  const espera = Array.from({ length: 48 }, (_, i) => fila(12 + (rnd() - 0.5) * 12, -16 + (rnd() - 0.5) * 12, 300 + i * 20));
  const huella30204 = [...llegada(), ...espera];
  const { q, v, min } = delModal(huella30204, ruta([true, false, false]));
  chk("#30204: el detector lo declara quieto (> 10 min)", min >= 15, `${min} min`);
  chk("#30204: la posición NO está clavada (un GPS vivo jitterea)", q.clavada.ms < POS_CLAVADA_MS, `${q.clavada.ms} ms`);
  chk("#30204: detenida junto al paradero 1 (marcado) → en_paradero", v?.codigo === "en_paradero", v?.codigo);
  chk("#30204: nombra el paradero 1", v?.codigo === "en_paradero" && v.idx === 0 && v.nombre === NOMBRES[0]);
  chk("#30204: la distancia es la del centro de la espera (~20 m)", v?.codigo === "en_paradero" && Math.abs(v.distanciaM - 20) < 4, v?.codigo === "en_paradero" ? `${v.distanciaM.toFixed(1)} m` : "");
  const sinMarcar = delModal(huella30204, ruta([false, false, false])).v;
  chk("#30204 sin ninguna marca → en_paradero igual (el conductor no está obligado a marcar al llegar)", sinMarcar?.codigo === "en_paradero");
  const r = rotuloDetencion({ veredicto: v!, minutos: 16, modoCliente: false });
  chk("#30204: el header dice «Detenida en Av. Los Frutales · hace 16 min»", r.texto === "Detenida en Av. Los Frutales · hace 16 min", r.texto);
  chk("#30204: SIN alarma y SIN ámbar", r.alarma === false && r.ambar === false);
  chk("#30204: no imputa «GPS pegado» ni «teléfono fuera del bus»", !/pegado|fuera del (bus|vehículo)/i.test(r.texto + r.title));
  chk("#30204: el title explica la espera y cuándo confirmarla", /espera/.test(r.title) && /confírmalo con el conductor/.test(r.title), r.title);

  // #951 TAL CUAL OCURRIÓ: el motor de ubicación se cuelga al iniciar, JUNTO al paradero 1, y
  // sirve el MISMO punto con la hora al día durante 75 min mientras el bus hace la ruta. El
  // conductor no marca nada (lo habitual). Esta es la regresión que la primera versión no veía.
  for (const acc of [100, 10]) {
    const clavada = Array.from({ length: 151 }, (_, i) => fila(5, -5, 300 + i * 30, acc));
    const { q: q9, v: v9, min: m9 } = delModal([...llegada(acc), ...clavada], ruta([false, false, false]));
    chk(`#951 real (±${acc}): quieto 75 min`, m9 === 75, `${m9}`);
    chk(`#951 real (±${acc}): racha de ${q9.clavada.fixes} posiciones idénticas`, q9.clavada.fixes === 151 && q9.clavada.ms === 150 * 30_000);
    chk(`#951 real (±${acc}), a 7 m del paradero 1, sin marcas → posicion_clavada (NO en_paradero)`, v9?.codigo === "posicion_clavada", v9?.codigo);
    for (const debil of acc >= 60 ? [0, acc] : [0]) {
      const r9 = rotuloDetencion({ veredicto: v9!, minutos: m9, modoCliente: false, debilM: debil });
      chk(`#951 real (±${acc}, debilM ${debil}): el texto de SIEMPRE, byte a byte`, r9.texto === textoViejo(m9, debil), r9.texto);
      chk(`#951 real (±${acc}, debilM ${debil}): alarma y ámbar`, r9.alarma && r9.ambar);
      chk(`#951 real (±${acc}, debilM ${debil}): el title conserva el de siempre y dice POR QUÉ (posición idéntica, #951)`,
        r9.title.endsWith(TITLE_VIEJO) && /sin variar ni un metro/.test(r9.title) && /151 posiciones idénticas/.test(r9.title), r9.title.slice(0, 90));
    }
    // Con el conductor marcando, también alarma (la clavada va antes que la geometría).
    const conMarcas = delModal([...llegada(acc), ...clavada], ruta([true, true, false])).v;
    chk(`#951 real (±${acc}) con marcas → posicion_clavada`, conMarcas?.codigo === "posicion_clavada", conMarcas?.codigo);
  }

  // Ubicación de RED con el bus esperando de verdad: el centroide también se repite. No se puede
  // distinguir de #951 (que iba a ±100) → la alarma se queda: el lado conservador, declarado.
  const red = Array.from({ length: 40 }, (_, i) => fila(30, 10, 300 + i * 20, 90));
  chk("espera con ubicación de red y centroide repetido → posicion_clavada (ante la duda, la alarma se queda)",
    delModal([...llegada(90), ...red], ruta([false, false, false])).v?.codigo === "posicion_clavada");

  // El borde de la clavada: el MISMO número de la app del conductor (8 min).
  chk("POS_CLAVADA_MS es el de la app del conductor (8 min)", POS_CLAVADA_MS === 480_000);
  const casi = juzgarDetencion(en(12, -16), ruta([false, false, false]), { clavadaMs: POS_CLAVADA_MS - 1, clavadaFixes: 20 });
  chk("racha idéntica de 8 min − 1 ms → no es clavada (decide la geometría)", casi.codigo === "en_paradero", casi.codigo);
  const justo = juzgarDetencion(en(12, -16), ruta([false, false, false]), { clavadaMs: POS_CLAVADA_MS, clavadaFixes: 20 });
  chk("racha idéntica de 8 min → posicion_clavada", justo.codigo === "posicion_clavada" && justo.minutos === 8 && justo.fixes === 20);
  chk("evidencia ausente o null → no es clavada", juzgarDetencion(en(12, -16), ruta(), null).codigo === "en_paradero"
    && juzgarDetencion(en(12, -16), ruta(), { clavadaMs: null }).codigo === "en_paradero");
  // Un GPS que se colgó y SE RECUPERÓ en el mismo sitio: la racha final ya no es idéntica.
  const recuperado = [...llegada(), ...Array.from({ length: 40 }, (_, i) => fila(5, -5, 300 + i * 20)),
    ...Array.from({ length: 6 }, (_, i) => fila(5 + i, -5 - i, 1100 + i * 20))];
  const qr = medirQuietud(recuperado);
  chk("GPS colgado que se recupera en el sitio → la racha FINAL manda (no queda clavada para siempre)", qr.clavada.ms < POS_CLAVADA_MS, `${qr.clavada.ms}`);

  // El teléfono quedó lejos de todo (la otra lectura de #951).
  const c = juzgarDetencion(en(3000, 1500), ruta([true, true, false]));
  chk("teléfono quieto lejos de todo → lejos_de_paraderos", c.codigo === "lejos_de_paraderos", c.codigo);
  chk("lejos nombra el más cercano, fuera del radio", c.codigo === "lejos_de_paraderos" && c.idx === 0 && c.distanciaM > RADIO_DETENCION_M);
  const rc = rotuloDetencion({ veredicto: c, minutos: 75, modoCliente: false, debilM: 0 });
  chk("lejos: el texto de SIEMPRE, byte a byte", rc.texto === textoViejo(75, 0), rc.texto);
  chk("lejos: el title de SIEMPRE, byte a byte", rc.title === TITLE_VIEJO);
  chk("lejos: con alarma", rc.alarma === true && rc.ambar === true);

  // Junto al paradero 1 con el GPS vivo, y el conductor ya marcó el 2 y el 3: el servicio avanzó
  // y la unidad no.
  const m = juzgarDetencion(en(12, -16), ruta([true, true, true]));
  chk("junto al paradero 1 con el 2 y el 3 marcados → marcadas_despues", m.codigo === "marcadas_despues", m.codigo);
  chk("marcadas_despues nombra el paradero cercano y el marcado más avanzado",
    m.codigo === "marcadas_despues" && m.idx === 0 && m.marcadaIdx === 2 && m.marcadaNombre === NOMBRES[2]);
  const rm = rotuloDetencion({ veredicto: m, minutos: 40, modoCliente: false, debilM: 80 });
  chk("marcadas_despues: el texto de SIEMPRE (con ±m), byte a byte", rm.texto === textoViejo(40, 80), rm.texto);
  chk("marcadas_despues: con alarma", rm.alarma === true);
  chk("marcadas_despues: el title dice POR QUÉ alarma junto a un paradero, y conserva el de siempre",
    rm.title.endsWith(TITLE_VIEJO) && rm.title.includes(NOMBRES[0]) && rm.title.includes(NOMBRES[2]), rm.title);
  const solo2 = juzgarDetencion(en(12, -16), ruta([false, true, false]));
  chk("basta UNA marca posterior para que no absuelva", solo2.codigo === "marcadas_despues" && solo2.marcadaIdx === 1);
}

// ── 2. EL BORDE DEL RADIO ─────────────────────────────────────────────────────────────
{
  const dentro = juzgarDetencion(en(0, RADIO_DETENCION_M - 0.5), ruta([false, false, false]));
  chk(`a ${RADIO_DETENCION_M - 0.5} m → en_paradero`, dentro.codigo === "en_paradero", dentro.codigo);
  const fuera = juzgarDetencion(en(0, RADIO_DETENCION_M + 0.5), ruta([false, false, false]));
  chk(`a ${RADIO_DETENCION_M + 0.5} m → lejos_de_paraderos`, fuera.codigo === "lejos_de_paraderos", fuera.codigo);
  chk("el radio es el del detector de quietud (150 m, el literal que tenía ModalGps)", RADIO_DETENCION_M === 150);
}

// ── 3. LA PRECISIÓN ───────────────────────────────────────────────────────────────────
{
  const pa = ruta([false, false, false]);
  chk("precisión de red (> 150 m) → precision_insuficiente", juzgarDetencion(en(12, -16, 151), pa).codigo === "precision_insuficiente");
  chk("precisión en el umbral (150 m) → decide", juzgarDetencion(en(12, -16, PRECISION_MAX_M), pa).codigo === "en_paradero");
  const sinAcc = juzgarDetencion(en(12, -16, null), pa);
  chk("precisión DESCONOCIDA → precision_insuficiente (no se lee como 0 m)", sinAcc.codigo === "precision_insuficiente" && sinAcc.accM === null);
  chk("precisión como texto vacío → precision_insuficiente", juzgarDetencion({ ...aGeo(12, -16), accM: "" }, pa).codigo === "precision_insuficiente");
  chk("precisión como texto numérico → decide", juzgarDetencion({ ...aGeo(12, -16), accM: "8" }, pa).codigo === "en_paradero");
  chk("precisión negativa → precision_insuficiente", juzgarDetencion(en(12, -16, -3), pa).codigo === "precision_insuficiente");
  // La de la VENTANA: filas sin precision_m no cuentan como 0 m.
  const sinPrec = Array.from({ length: 40 }, (_, i) => fila(12 + (i % 3), -16, i * 20, null));
  chk("ventana sin ninguna precision_m → accM null (no 0)", medirQuietud(sinPrec).accM === null);
  chk("…y el modal no absuelve", delModal(sinPrec, pa).v?.codigo === "precision_insuficiente");
}

// ── 4. POSICIÓN Y PARADAS AUSENTES — la trampa de Number(null) === 0 ────────────────────
{
  const pa = ruta([false, false, false]);
  chk("sin posición → sin_posicion", juzgarDetencion(null, pa).codigo === "sin_posicion");
  chk("lat null → sin_posicion (no (0, lng))", juzgarDetencion({ lat: null, lng: LNG0, accM: 5 }, pa).codigo === "sin_posicion");
  chk("lat/lng undefined (ancla ausente) → sin_posicion", juzgarDetencion({ lat: undefined, lng: undefined, accM: 5 }, pa).codigo === "sin_posicion");
  chk("lat/lng vacíos → sin_posicion", juzgarDetencion({ lat: "", lng: "", accM: 5 }, pa).codigo === "sin_posicion");
  chk("posición (0, 0) exacta → sin_posicion", juzgarDetencion({ lat: 0, lng: 0, accM: 5 }, pa).codigo === "sin_posicion");
  chk("posición como texto → se lee", juzgarDetencion({ lat: String(LAT0), lng: String(LNG0), accM: 5 }, pa).codigo === "en_paradero");
  chk("sin paradas → sin_paradas", juzgarDetencion(en(0, 0), []).codigo === "sin_paradas");
  chk("paradas null → sin_paradas", juzgarDetencion(en(0, 0), null).codigo === "sin_paradas");
  const todasSinCoords: ParadaDetencion[] = [
    { lat: null, lng: null, completada: true, nombre: "A" },
    { lat: "", lng: "", completada: false, nombre: "B" },
    { lat: undefined, lng: undefined, completada: false, nombre: "C" },
  ];
  chk("todas sin coordenadas → sin_paradas", juzgarDetencion(en(0, 0), todasSinCoords).codigo === "sin_paradas");

  // EL CASO QUE DELATA LA TRAMPA: la unidad a 15 m de (0, 0) y una parada SIN coordenadas.
  // Con `Number(null)` sin cuidar, esa parada estaría en (0, 0) y saldría «en_paradero».
  const cercaDeCero: PosicionDetencion = { lat: 0.0001, lng: 0.0001, accM: 5 };
  const conNull: ParadaDetencion[] = [
    { lat: null, lng: null, completada: false, nombre: "Sin geocodificar" },
    { ...aGeo(0, 0), completada: false, nombre: "Lejana" },
  ];
  const v = juzgarDetencion(cercaDeCero, conNull);
  chk("una parada con lat/lng null NO se cuela como (0, 0)", v.codigo === "lejos_de_paraderos" && v.idx === 1, v.codigo);
  const conCero: ParadaDetencion[] = [
    { lat: 0, lng: 0, completada: false, nombre: "Centinela" },
    { ...aGeo(0, 0), completada: false, nombre: "Lejana" },
  ];
  chk("una parada en (0, 0) exacto se trata como sin coordenadas", juzgarDetencion(cercaDeCero, conCero).codigo === "lejos_de_paraderos");

  // Una parada POSTERIOR sin coordenadas pero MARCADA sigue probando que el servicio avanzó.
  const marcadaSinCoords: ParadaDetencion[] = [
    { ...aGeo(0, 0), completada: true, nombre: NOMBRES[0] },
    { lat: null, lng: null, completada: true, nombre: "Paradero sin geocodificar" },
    { ...aGeo(0, -9000), completada: false, nombre: NOMBRES[2] },
  ];
  const ms = juzgarDetencion(en(5, 5), marcadaSinCoords);
  chk("una marca posterior en un paradero SIN coordenadas también cuenta", ms.codigo === "marcadas_despues" && ms.marcadaIdx === 1, ms.codigo);
  // Nombre vacío → la posición en la ruta, nunca una cadena vacía en el header.
  const sinNombre = juzgarDetencion(en(5, 5), [{ ...aGeo(0, 0), completada: false, nombre: "  " }]);
  chk("paradero sin nombre → «paradero 1»", sinNombre.codigo === "en_paradero" && sinNombre.nombre === "paradero 1");
}

// ── 5. GANA EL MÁS CERCANO · EL DESTINO FINAL ─────────────────────────────────────────
{
  const dos: ParadaDetencion[] = [
    { ...aGeo(0, 100), completada: false, nombre: "A 100 m" },
    { ...aGeo(0, -40), completada: false, nombre: "A 40 m" },
    { ...aGeo(0, -5000), completada: false, nombre: "Destino" },
  ];
  const v = juzgarDetencion(en(0, 0), dos);
  chk("dos dentro del radio → gana el más cercano", v.codigo === "en_paradero" && v.idx === 1 && v.nombre === "A 40 m");
  // Empate exacto: gana el de MENOR índice (el conservador, más fácil de tener marcas detrás).
  const empate: ParadaDetencion[] = [
    { ...aGeo(0, 60), completada: false, nombre: "Ida" },
    { ...aGeo(0, 60), completada: false, nombre: "Retorno" },
  ];
  const e = juzgarDetencion(en(0, 0), empate);
  chk("empate → el de menor índice (aunque el otro sea el último)", e.codigo === "en_paradero" && e.idx === 0);
  // Ruta con lazo: la unidad está entre el paradero 2 (ida) y el 6 (retorno), el 2 más cerca y
  // el conductor marcó hasta el 4. NO se elige «el que absuelve» (el 6): alarma.
  const lazo: ParadaDetencion[] = [0, 1, 2, 3, 4, 5].map(i => ({
    ...(i === 1 ? aGeo(0, 30) : i === 5 ? aGeo(0, -50) : aGeo(2000 * (i + 1), 0)),
    completada: i <= 3, nombre: `P${i + 1}`,
  }));
  const l = juzgarDetencion(en(0, 0), lazo);
  chk("ruta con lazo: el más cercano tiene marcas detrás → marcadas_despues (no se elige el que absuelve)",
    l.codigo === "marcadas_despues" && l.idx === 1, l.codigo);
  const casi = juzgarDetencion(en(0, 0), [{ ...aGeo(0, 160), completada: false, nombre: "Casi" }]);
  chk("a 160 m → lejos_de_paraderos (nunca «en paradero» fuera del radio)", casi.codigo === "lejos_de_paraderos");

  // EL DESTINO FINAL: llegó a la planta y nadie cerró el servicio. No es una espera de embarque.
  for (const marcas of [[true, true, true], [false, false, false]]) {
    const d = juzgarDetencion(en(8, -9008), ruta(marcas));
    chk(`junto al último paradero (marcas ${marcas.map(Number).join("")}) → en_destino`, d.codigo === "en_destino" && d.idx === 2 && d.nombre === NOMBRES[2], d.codigo);
    const rd = rotuloDetencion({ veredicto: d, minutos: 95, modoCliente: false });
    chk("en_destino: alarma y ámbar, con SU motivo (servicio sin cerrar)", rd.alarma && rd.ambar && /servicio sin cerrar/.test(rd.texto), rd.texto);
    chk("en_destino: no habla de embarque ni de hora de salida, ni culpa al GPS en el texto",
      !/embarque|hora de salida/.test(rd.title) && !/pegado/.test(rd.texto), rd.title);
    chk("en_destino: el title pide cerrarlo", /cierre en su app/.test(rd.title));
  }
  const solo = juzgarDetencion(en(5, 5), [{ ...aGeo(0, 0), completada: false, nombre: "Único" }]);
  chk("con UN solo paradero no se afirma destino (es también el primero)", solo.codigo === "en_paradero");
  // El último paradero sin coordenadas: el más cercano con coordenadas no es el destino.
  const destinoSinCoords = ruta([false, false, false]).map((p, i) => (i === 2 ? { ...p, lat: null, lng: null } : p));
  chk("si el último no tiene coordenadas, el penúltimo NO pasa a ser destino",
    juzgarDetencion(en(5, -6100), destinoSinCoords).codigo === "en_paradero");
}

// ── 6. EL CLIENTE NUNCA RECIBE LA IMPUTACIÓN NI UN ÁMBAR SIN EXPLICAR ──────────────────
{
  const PROHIBIDO = /pegado|teléfono|telefono|celular|conductor|pídele|pidele|reiniciar|#951|⚠|débil|debil/i;
  const casos: VeredictoDetencion[] = [
    juzgarDetencion(en(12, -16), ruta([true, false, false])),
    juzgarDetencion(en(8, -9008), ruta([true, true, true])),
    juzgarDetencion(en(3000, 1500), ruta()),
    juzgarDetencion(en(12, -16), ruta([true, true, true])),
    juzgarDetencion(en(12, -16), ruta(), { clavadaMs: 75 * 60_000, clavadaFixes: 151 }),
    juzgarDetencion(en(12, -16, 400), ruta()),
    juzgarDetencion(null, ruta()),
    juzgarDetencion(en(0, 0), []),
  ];
  for (const v of casos) {
    const r = rotuloDetencion({ veredicto: v, minutos: 25, modoCliente: true, debilM: 90 });
    chk(`cliente · ${v.codigo}: sin alarma y SIN ámbar aunque el GPS sea débil`, r.alarma === false && r.ambar === false);
    chk(`cliente · ${v.codigo}: sin imputación ni instrucción interna`, !PROHIBIDO.test(r.texto + " " + r.title), `${r.texto} | ${r.title}`);
    if (v.codigo === "en_paradero" || v.codigo === "en_destino")
      chk(`cliente · ${v.codigo}: «Detenida en … · hace 25 min»`, r.texto === `Detenida en ${v.nombre} · hace 25 min`, r.texto);
    else chk(`cliente · ${v.codigo}: «Ubicación sin cambios · hace 25 min» (describe el dato, no el vehículo)`, r.texto === "Ubicación sin cambios · hace 25 min", r.texto);
  }
  // Operación, en paradero con GPS débil: la ESPERA no alarma; el ámbar es del GPS débil, y la
  // línea lo NOMBRA (si no, sería un ámbar sin explicación, el defecto del cliente).
  const op = rotuloDetencion({ veredicto: casos[0], minutos: 16, modoCliente: false, debilM: 70 });
  chk("operación · en_paradero con GPS débil: la espera no alarma, el ámbar es del GPS débil y el texto lo nombra",
    op.alarma === false && op.ambar === true && op.texto === "Detenida en Av. Los Frutales · hace 16 min · ⚠ GPS débil ±70m" && /Alta precisión/.test(op.title), op.texto);
}

// ── 7. LA ESTABILIDAD: el lugar y la precisión salen de la ventana quieta ───────────────
{
  const pa = ruta([false, false, false]);
  // (a) Bus estacionado a ~146 m del punto geocodificado del paradero, con jitter de ±8 m. El
  // veredicto ciclo a ciclo (un fix nuevo cada vez) con el ÚLTIMO PUNTO —lo que hacía el modal con
  // `ubic`— salta en el borde; con el ancla de la ventana, no.
  {
    const rnd = mulberry32(146);
    const huella: FilaQuietud[] = [...llegada()];
    let saltosViejo = 0, saltosNuevo = 0, prevV = "", prevN = "", ciclos = 0;
    for (let i = 0; i < 90; i++) {
      huella.push(fila((rnd() - 0.5) * 16, 146 + (rnd() - 0.5) * 16, 300 + i * 20));
      const ult = huella[huella.length - 1];
      const viejo = juzgarDetencion({ lat: ult.lat as number, lng: ult.lng as number, accM: 8 }, pa).codigo;
      const { v } = delModal(huella, pa);
      if (!v) continue;
      ciclos++;
      if (prevV && viejo !== prevV) saltosViejo++;
      if (prevN && v.codigo !== prevN) saltosNuevo++;
      prevV = viejo; prevN = v.codigo;
    }
    chk("borde del radio: con el último fix el veredicto SALTA (reproduce el defecto)", saltosViejo > 3, `${saltosViejo} saltos en ${ciclos} ciclos`);
    chk("borde del radio: con el ancla de la ventana no salta nunca", saltosNuevo === 0, `${saltosNuevo} saltos (${prevN})`);
  }
  // (b) Precisión de red alrededor del umbral: mayoría a ±140 con algún ±160 suelto, y al revés.
  // Con el fix suelto, cada ±160 retiraba la absolución (o cada ±140 la daba); con la mediana de
  // la ventana decide la mayoría.
  for (const [mayoria, suelto, esperado] of [[140, 160, "en_paradero"], [160, 140, "precision_insuficiente"]] as const) {
    const rnd = mulberry32(mayoria);
    const huella: FilaQuietud[] = [...llegada(mayoria)];
    let saltosViejo = 0, prevV = "", distintosNuevo = 0, ciclos = 0;
    for (let i = 0; i < 60; i++) {
      const acc = i % 4 === 3 ? suelto : mayoria;
      huella.push(fila(10 + (rnd() - 0.5) * 30, 30 + (rnd() - 0.5) * 30, 300 + i * 20, acc));
      const viejo = juzgarDetencion({ lat: huella[huella.length - 1].lat as number, lng: huella[huella.length - 1].lng as number, accM: acc }, pa).codigo;
      const { v } = delModal(huella, pa);
      if (!v) continue;
      ciclos++;
      if (prevV && viejo !== prevV) saltosViejo++;
      prevV = viejo;
      if (v.codigo !== esperado) distintosNuevo++;
    }
    chk(`precisión mayoría ±${mayoria}, suelto ±${suelto}: con el fix suelto salta (reproduce el defecto)`, saltosViejo > 3, `${saltosViejo} saltos`);
    chk(`precisión mayoría ±${mayoria}, suelto ±${suelto}: con la ventana, siempre ${esperado}`, distintosNuevo === 0, `${distintosNuevo} de ${ciclos}`);
  }
  // (c) EL ARRANQUE. Espera de 16 min junto al paradero 1 y el bus sale hacia el sur. Mientras la
  // huella todavía no trae un punto fuera del disco, el lugar sigue siendo el de la espera
  // (nunca «lejos» con los minutos de la espera); en cuanto lo trae, la quietud se apaga en el
  // MISMO cálculo. No hay ningún ciclo con la alarma de «GPS pegado».
  {
    const rnd = mulberry32(7);
    const huella: FilaQuietud[] = [...llegada(), ...Array.from({ length: 48 }, (_, i) =>
      fila(12 + (rnd() - 0.5) * 12, -16 + (rnd() - 0.5) * 12, 300 + i * 20))];
    const vistos: string[] = [];
    let alarmas = 0, alarmasViejo = 0;
    for (let i = 1; i <= 12; i++) {
      // Lo VIEJO: la quietud de la huella del ciclo anterior (llega cada 15 s) y el lugar del fix
      // en vivo, que ya va un paso por delante.
      const qPrevia = medirQuietud(huella);
      huella.push(fila(12, -16 - i * 25, 300 + 48 * 20 + i * 5));          // 25 m cada 5 s (18 km/h)
      if (qPrevia.ms > 10 * 60000) {
        const ult = huella[huella.length - 1];
        const viejo = juzgarDetencion({ lat: ult.lat as number, lng: ult.lng as number, accM: 8 }, pa);
        if (rotuloDetencion({ veredicto: viejo, minutos: Math.floor(qPrevia.ms / 60000), modoCliente: false }).alarma) alarmasViejo++;
      }
      const { v, min } = delModal(huella, pa);
      vistos.push(v ? v.codigo : "sin_quietud");
      if (v && rotuloDetencion({ veredicto: v, minutos: min, modoCliente: false }).alarma) alarmas++;
    }
    chk("arranque: con dos relojes (quietud de la huella, lugar del fix en vivo) salía la alarma (reproduce el defecto)",
      alarmasViejo > 0, `${alarmasViejo} ciclo(s)`);
    chk("arranque: ningún ciclo pinta la alarma «GPS pegado»", alarmas === 0, vistos.join(","));
    chk("arranque: la quietud se apaga en cuanto la huella sale del disco", vistos[vistos.length - 1] === "sin_quietud", vistos.join(","));
    chk("arranque: antes de eso, sigue siendo la espera en el paradero", vistos[0] === "en_paradero");
  }
}

// ── 8. BARRIDO ────────────────────────────────────────────────────────────────────────
// Rutas al azar (de 0 a 7 paradas, algunas sin coordenadas o con basura, marcas al azar),
// posiciones al azar (encima de un paradero, cerca del borde del radio, lejos, o ausentes) con
// precisiones de satélite, de red, en el umbral y desconocidas, y rachas clavadas al azar.
{
  const rnd = mulberry32(30204);
  const conteo: Record<string, number> = {};
  let violaciones = 0, rotuloRoto = 0, casos = 0;
  const notas: string[] = [];
  const falla = (msg: string) => { violaciones++; if (notas.length < 5) notas.push(msg); };
  const ACCS: (number | null | string)[] = [3, 8, 25, 60, 120, 150, 151, 400, null, "", "12"];
  for (let k = 0; k < 8000; k++) {
    const n = Math.floor(rnd() * 8);
    const pa: ParadaDetencion[] = Array.from({ length: n }, (_, i) => {
      const u = rnd();
      const base = u < 0.12 ? { lat: null, lng: null }
        : u < 0.16 ? { lat: "", lng: "" }
        : u < 0.18 ? { lat: 0, lng: 0 }
        : aGeo((rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000);
      return { ...base, completada: rnd() < 0.4, nombre: rnd() < 0.1 ? "" : `P${i + 1}` };
    });
    let pos: PosicionDetencion | null;
    const u = rnd();
    const acc = ACCS[Math.floor(rnd() * ACCS.length)];
    const conCoords = pa.map((p, i) => ({ p, i })).filter(({ p }) => p.lat != null && p.lat !== "" && !(p.lat === 0 && p.lng === 0));
    if (u < 0.06) pos = null;
    else if (u < 0.09) pos = { lat: null, lng: null, accM: acc };
    else if (u < 0.6 && conCoords.length) {
      const { p } = conCoords[Math.floor(rnd() * conCoords.length)];
      const r = rnd() * 300, a = rnd() * 2 * Math.PI;
      pos = { lat: Number(p.lat) + (r * Math.sin(a)) / K_LAT, lng: Number(p.lng) + (r * Math.cos(a)) / K_LNG, accM: acc };
    } else pos = { ...aGeo((rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000), accM: acc };
    const uc = rnd();
    const clavadaMs = uc < 0.7 ? 0 : uc < 0.8 ? null : Math.floor(rnd() * 2 * POS_CLAVADA_MS);
    const ev = { clavadaMs, clavadaFixes: 1 + Math.floor(rnd() * 200) };

    const v = juzgarDetencion(pos, pa, ev);
    casos++;
    conteo[v.codigo] = (conteo[v.codigo] ?? 0) + 1;

    if (!CODIGOS_DETENCION.includes(v.codigo)) falla(`código no declarado: ${v.codigo}`);

    const valida = (p: ParadaDetencion) => {
      if (p.lat == null || p.lng == null || p.lat === "" || p.lng === "") return null;
      const la = Number(p.lat), lo = Number(p.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
      return { lat: la, lng: lo };
    };
    const posOk = pos && pos.lat != null && pos.lng != null && pos.lat !== "" ? { lat: Number(pos.lat), lng: Number(pos.lng) } : null;
    const dists = pa.map(p => { const c = valida(p); return c && posOk ? distM(posOk.lat, posOk.lng, c.lat, c.lng) : null; });
    const minD = Math.min(...dists.filter((d): d is number => d != null));
    const accNum = acc == null || acc === "" ? null : Number(acc);
    const clavada = clavadaMs != null && clavadaMs >= POS_CLAVADA_MS;

    // La posición clavada NUNCA se absuelve, esté donde esté el punto.
    if (posOk && clavada && v.codigo !== "posicion_clavada") falla(`posición clavada ${clavadaMs} ms salió ${v.codigo}`);
    if (v.codigo === "posicion_clavada" && !clavada) falla(`posicion_clavada sin racha (${clavadaMs})`);

    if (v.codigo === "en_paradero" || v.codigo === "en_destino" || v.codigo === "marcadas_despues") {
      const d = dists[v.idx];
      if (d == null) falla(`${v.codigo} sobre una parada sin coordenadas (idx ${v.idx})`);
      else {
        if (!(v.distanciaM <= RADIO_DETENCION_M)) falla(`${v.codigo} fuera del radio: ${v.distanciaM}`);
        if (Math.abs(d - v.distanciaM) > 1e-6) falla(`${v.codigo}: distancia ${v.distanciaM} ≠ ${d}`);
        if (Math.abs(d - minD) > 1e-6) falla(`${v.codigo}: no eligió el más cercano (${d} vs ${minD})`);
        const primero = dists.findIndex(x => x != null && Math.abs(x - minD) <= 1e-9);
        if (primero !== v.idx) falla(`${v.codigo}: a igual distancia no ganó el menor índice`);
      }
      if (accNum == null || !(accNum <= PRECISION_MAX_M) || accNum < 0) falla(`${v.codigo} con precisión ${String(acc)}`);
      if (clavada) falla(`${v.codigo} con la posición clavada`);
      const marcadaDespues = pa.some((p, j) => j > v.idx && p.completada);
      if ((v.codigo === "en_paradero" || v.codigo === "en_destino") && marcadaDespues) falla(`${v.codigo} con una parada posterior marcada`);
      if (v.codigo === "en_destino" && !(pa.length >= 2 && v.idx === pa.length - 1)) falla(`en_destino en el índice ${v.idx} de ${pa.length}`);
      if (v.codigo === "en_paradero" && pa.length >= 2 && v.idx === pa.length - 1) falla("en_paradero en el último paradero");
      if (v.codigo === "marcadas_despues") {
        if (!marcadaDespues) falla("marcadas_despues sin ninguna marca posterior");
        const maxMarcada = pa.reduce((m, p, j) => (j > v.idx && p.completada ? j : m), -1);
        if (v.marcadaIdx !== maxMarcada) falla(`marcadas_despues: marcadaIdx ${v.marcadaIdx} ≠ ${maxMarcada}`);
      }
      if (!v.nombre.trim()) falla(`${v.codigo} con nombre vacío`);
    }
    if (v.codigo === "lejos_de_paraderos") {
      if (dists.some(d => d != null && d <= RADIO_DETENCION_M)) falla("lejos_de_paraderos con un paradero dentro del radio");
      if (!(v.distanciaM > RADIO_DETENCION_M)) falla(`lejos_de_paraderos con distancia ${v.distanciaM}`);
    }
    if (v.codigo === "en_paradero" && !(minD <= RADIO_DETENCION_M)) falla("en_paradero con todos los paraderos fuera del radio");
    if (posOk && !clavada && accNum != null && accNum >= 0 && accNum <= PRECISION_MAX_M && minD <= RADIO_DETENCION_M
        && !["en_paradero", "en_destino", "marcadas_despues"].includes(v.codigo))
      falla(`con un paradero dentro del radio y precisión buena salió ${v.codigo}`);

    // El rótulo, en operación: alarma ⟺ no es una espera en un paradero intermedio; fuera de la
    // espera y del destino, el texto es EXACTAMENTE el de siempre; el ámbar es la alarma o el GPS
    // débil, y SIEMPRE se explica (⚠ en el texto). En el cliente, nunca alarma, ámbar ni imputa.
    const min = 11 + Math.floor(rnd() * 80), debil = rnd() < 0.3 ? 60 + Math.floor(rnd() * 100) : 0;
    const op = rotuloDetencion({ veredicto: v, minutos: min, modoCliente: false, debilM: debil });
    const cli = rotuloDetencion({ veredicto: v, minutos: min, modoCliente: true, debilM: debil });
    if (op.alarma !== (v.codigo !== "en_paradero")) rotuloRoto++;
    if (op.ambar !== (op.alarma || debil > 0)) rotuloRoto++;
    if (op.ambar !== op.texto.includes("⚠")) rotuloRoto++;
    if (v.codigo !== "en_paradero" && v.codigo !== "en_destino" && op.texto !== textoViejo(min, debil)) rotuloRoto++;
    if (v.codigo !== "en_paradero" && v.codigo !== "en_destino" && !op.title.endsWith(TITLE_VIEJO)) rotuloRoto++;
    if (cli.alarma || cli.ambar || /pegado|teléfono|conductor|pídele|débil|⚠/i.test(cli.texto + cli.title)) rotuloRoto++;
  }
  chk(`invariantes del motor en ${casos} casos`, violaciones === 0, notas.join(" · ") || `${violaciones}`);
  chk("invariantes del rótulo (lo de siempre fuera de la espera; ámbar ⟺ ⚠; cliente sin ámbar ni imputación)", rotuloRoto === 0, `${rotuloRoto}`);
  // Corolario: cada código aparece. Un motor que nunca dijera «en_paradero» cumpliría todo lo
  // anterior de forma trivial; uno que nunca dijera «posicion_clavada», absolvería a #951.
  for (const c of CODIGOS_DETENCION) chk(`el barrido produce «${c}»`, (conteo[c] ?? 0) > 0, `${conteo[c] ?? 0}`);
}

// ── 9. LA QUIETUD, POR BARRIDO ────────────────────────────────────────────────────────
// El ancla de la detención nunca queda fuera del disco de la quietud (todos los puntos de la
// ventana están a ≤ RADIO del último), y la racha clavada nunca es más larga que la quietud.
{
  const rnd = mulberry32(2026);
  let malas = 0, casos = 0;
  const notas: string[] = [];
  for (let k = 0; k < 3000; k++) {
    const n = 3 + Math.floor(rnd() * 60);
    let x = 0, y = 0;
    const arr: FilaQuietud[] = [];
    for (let i = 0; i < n; i++) {
      const u = rnd();
      if (u < 0.15) { x += (rnd() - 0.5) * 600; y += (rnd() - 0.5) * 600; }
      else if (u < 0.85) { x += (rnd() - 0.5) * 30; y += (rnd() - 0.5) * 30; }
      // si no: repite la posición exacta (racha clavada)
      arr.push(fila(x, y, i * 20, rnd() < 0.2 ? null : Math.floor(rnd() * 200)));
    }
    const q = medirQuietud(arr);
    casos++;
    const ult = arr[arr.length - 1];
    if (q.ancla) {
      const d = distM(q.ancla.lat, q.ancla.lng, ult.lat as number, ult.lng as number);
      if (d > RADIO_DETENCION_M + 1e-6) { malas++; if (notas.length < 3) notas.push(`ancla a ${d.toFixed(1)} m`); }
    }
    if (q.clavada.ms > q.ms) { malas++; if (notas.length < 3) notas.push(`clavada ${q.clavada.ms} > quietud ${q.ms}`); }
    if (q.clavada.fixes < 1) { malas++; if (notas.length < 3) notas.push("racha sin fixes"); }
  }
  chk(`ancla dentro del disco y racha ⊆ quietud en ${casos} huellas`, malas === 0, notas.join(" · "));
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
