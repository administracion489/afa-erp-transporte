// Pruebas de «EL VEHÍCULO SE ALEJA DE…» del modal GPS. NO tocan la base: datos en memoria
// contra el motor puro lib/avance-paradas.ts.
// Uso:  npx tsx scripts/prueba-se-aleja.mts   (sale con código 1 si algo falla)
//
// EL CASO (reserva #30204, PIERIPLAST, 09-10-2026): el bus llegó al PRIMER paradero y esperó
// ahí, quieto. El modal decía «El vehículo se aleja de [paradero 2] · Se está alejando · a 6.1 km
// en línea recta» y el header de la misma pantalla «Unidad sin movimiento · hace 16 min».
//
// La racha de alejamiento del paradero 2 se acumuló mientras el bus iba HACIA el paradero 1 (ese
// tramo lo alejaba del 2), y con el bus detenido no se borra nunca. Lo que fija esta matriz:
//   1. el algoritmo VIEJO (la línea de `leerAvance` copiada literal) reproduce el defecto;
//   2. el nuevo no afirma «se aleja» de un bus detenido, ni de uno que se acerca despacio;
//   3. EL LADO QUE NO SE PUEDE AFLOJAR: un bus que de verdad se aleja lo sigue diciendo;
//   4. el cambio es SUSTRACTIVO: por barrido, nuevo ⇒ viejo en cada muestra.
import {
  avanzarAvance, estadoAvanceVacio, leerAvance,
  type EstadoAvance, type FixAvance, type ParadaAvance,
} from "../lib/avance-paradas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── El algoritmo VIEJO, copiado literal de leerAvance (antes del cambio) ─────────────
// `seAleja = !!sProx?.alejando && sProx.recStreak >= (estado.rachaAlejaVigente || RACHA_ALEJA)`
const RACHA_ALEJA_VIEJA = 3;
function seAlejaViejo(estado: EstadoAvance, paradas: ParadaAvance[]): boolean {
  const proximaIdx = leerAvance(estado, paradas).proximaIdx;
  const sProx = proximaIdx != null ? estado.porParada[proximaIdx] : null;
  return !!sProx?.alejando && sProx.recStreak >= (estado.rachaAlejaVigente || RACHA_ALEJA_VIEJA);
}

// ── Geometría local en metros (x este, y norte) ──────────────────────────────────────
const LAT0 = -12.03, LNG0 = -76.95;
const K_LAT = 111_320, K_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const aGeo = (x: number, y: number) => ({ lat: LAT0 + y / K_LAT, lng: LNG0 + x / K_LNG });

// PRNG con semilla: la matriz tiene que dar lo mismo en cada corrida.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paraderos: el 1 en el origen, el 2 a 6.1 km al sur (la distancia del caso real), el 3 más allá. */
const paradas = (completadas: boolean[] = [true, false, false]): ParadaAvance[] =>
  [aGeo(0, 0), aGeo(0, -6100), aGeo(0, -9000)].map((p, i) => ({ ...p, completada: !!completadas[i] }));

const T0 = Date.parse("2026-10-09T11:00:00Z");

/** Aplica una serie de fixes y devuelve el estado final; `cada` se llama tras cada muestra. */
function correr(e: EstadoAvance, fixes: FixAvance[], pa: ParadaAvance[], cada?: (e: EstadoAvance, f: FixAvance) => void) {
  for (const f of fixes) { e = avanzarAvance(e, f, pa); cada?.(e, f); }
  return e;
}

/** Recorrido en línea recta de A a B a `v` m/s, una muestra cada `paso` s. */
function tramo(x0: number, y0: number, x1: number, y1: number, v: number, t0: number, paso = 5, acc = 3): FixAvance[] {
  const largo = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(largo / v / paso));
  const out: FixAvance[] = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    out.push({ ...aGeo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f), ts: t0 + k * paso * 1000, acc });
  }
  return out;
}

/** Bus detenido en (x, y) con jitter de hasta `jitter` m, una muestra cada `paso` s. */
function detenido(x: number, y: number, t0: number, minutos: number, rnd: () => number, jitter = 15, paso = 10, acc = 3): FixAvance[] {
  const out: FixAvance[] = [];
  for (let s = paso; s <= minutos * 60; s += paso) {
    const r = jitter * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI;
    out.push({ ...aGeo(x + r * Math.cos(a), y + r * Math.sin(a)), ts: t0 + s * 1000, acc });
  }
  return out;
}

const ultimoTs = (fx: FixAvance[]) => fx[fx.length - 1].ts;

// ── 1. EL CASO: llegó al primer paradero y espera 16 min ────────────────────────────
// Viene desde la cochera (5 km al este, 3.5 km al sur) a 30 km/h: ese tramo lo ALEJA del
// paradero 2. El conductor marcó el 1 al llegar, así que el objetivo es el 2.
const PA = paradas();
const llegada = tramo(5000, -3500, 0, 0, 8.33, T0);
const espera  = detenido(0, 0, ultimoTs(llegada), 16, mulberry32(30204));
const enP1    = correr(estadoAvanceVacio(PA.length), llegada, PA);
const esperando = correr(enP1, espera, PA);
{
  const av = leerAvance(esperando, PA);
  chk("premisa: el objetivo es el paradero 2 (el conductor marcó el 1)", av.proximaIdx === 1, `proximaIdx=${av.proximaIdx}`);
  chk("(regresión) el algoritmo viejo dice «se aleja» con el bus quieto 16 min en el paradero 1",
    seAlejaViejo(esperando, PA));
  chk("el nuevo NO dice «se aleja» de un bus detenido", av.seAleja === false);
}

// Y no es cuestión de esperar 16 minutos: con el bus detenido, el presente lo cubre a partir del
// minuto. LÍMITE DECLARADO: en el primer minuto tras detenerse la ventana aún contiene el tramo en
// que se alejaba (es cierto que se alejó en el último minuto) — por eso no se fija ese instante.
{
  let primeroQuieto: number | null = null;
  let malDespues = 0;
  correr(enP1, espera.slice(0, 30), PA, (e, f) => {
    const a = leerAvance(e, PA).seAleja;
    if (!a && primeroQuieto == null) primeroQuieto = f.ts;
    if (primeroQuieto != null && a) malDespues++;
  });
  const seg = primeroQuieto != null ? (primeroQuieto - ultimoTs(llegada)) / 1000 : Infinity;
  chk("a más tardar al minuto y pico de detenerse deja de decir «se aleja»", seg <= 70, `a los ${seg} s`);
  chk("y no vuelve a decirlo mientras sigue detenido", malDespues === 0, `${malDespues} muestra(s)`);
}

// ── 2. EL LADO QUE NO SE PUEDE AFLOJAR: un bus que de verdad se aleja ────────────────
// Sale del paradero 1 hacia el NORTE (al revés del 2) a 30 km/h durante 3 min.
const alNorte = tramo(0, 0, 0, 1500, 8.33, ultimoTs(espera) + 5_000);
const yendose = correr(esperando, alNorte, PA);
{
  chk("un bus que se va en sentido contrario SÍ «se aleja» (nuevo)", leerAvance(yendose, PA).seAleja === true);
  chk("…y el viejo también lo decía", seAlejaViejo(yendose, PA));
  // Se detiene en un semáforo: 30 s sigue diciéndolo (se alejó en el último minuto)…
  const sem30 = correr(yendose, detenido(0, 1500, ultimoTs(alNorte), 0.5, mulberry32(7), 4, 10), PA);
  chk("30 s detenido en un semáforo: sigue «se aleja»", leerAvance(sem30, PA).seAleja === true);
  // …y a los 90 s detenido ya no afirma movimiento.
  const sem90 = correr(yendose, detenido(0, 1500, ultimoTs(alNorte), 1.5, mulberry32(7), 4, 10), PA);
  chk("90 s detenido: ya no afirma que se aleja", leerAvance(sem90, PA).seAleja === false);
}

// ── 3. SE ACERCA DESPACIO: la racha vieja decía «se aleja» con el bus viniendo ───────
// Tras la espera sale hacia el paradero 2 a 15 km/h (≈21 m por muestra: menos que los 40 m de
// `bajando`), con el mínimo del paradero 2 registrado antes, en el tramo desde la cochera.
{
  const hacia2 = tramo(0, 0, 0, -1500, 4.17, ultimoTs(espera) + 5_000);
  let viejoMintio = 0, nuevoMintio = 0;
  correr(esperando, hacia2, PA, (e) => {
    if (seAlejaViejo(e, PA)) viejoMintio++;
    if (leerAvance(e, PA).seAleja) nuevoMintio++;
  });
  chk("(regresión) el viejo decía «se aleja» con el bus acercándose", viejoMintio > 0, `${viejoMintio} muestra(s)`);
  chk("el nuevo no lo dice en ninguna muestra del acercamiento", nuevoMintio === 0, `${nuevoMintio} muestra(s)`);
}

// ── 4. UN FIX DESVIADO NO FABRICA UN ALEJAMIENTO ─────────────────────────────────────
{
  const base = ultimoTs(espera);
  // Al final de la ventana: un fix 120 m más lejos del paradero 2 (al norte).
  const alFinal = correr(esperando, [
    { ...aGeo(0, 3), ts: base + 10_000, acc: 3 },
    { ...aGeo(2, 0), ts: base + 20_000, acc: 3 },
    { ...aGeo(0, 120), ts: base + 30_000, acc: 25 },
  ], PA);
  chk("un fix desviado al FINAL de la ventana no dice «se aleja»", leerAvance(alFinal, PA).seAleja === false);
  // Al principio de la ventana: un fix 120 m más CERCA del paradero 2, luego quieto otra vez.
  const alInicio = correr(esperando, [
    { ...aGeo(0, -120), ts: base + 10_000, acc: 25 },
    { ...aGeo(1, 2), ts: base + 20_000, acc: 3 },
    { ...aGeo(-2, 1), ts: base + 30_000, acc: 3 },
    { ...aGeo(2, -1), ts: base + 40_000, acc: 3 },
  ], PA);
  chk("un fix desviado al PRINCIPIO de la ventana no dice «se aleja»", leerAvance(alInicio, PA).seAleja === false);
}

// ── 5. UN ESTADO DE UNA VERSIÓN ANTERIOR (sin `recientes`) no rompe nada ──────────────
{
  // Como lo construía la versión anterior del módulo: sin el campo.
  const viejo = Object.fromEntries(Object.entries(yendose).filter(([k]) => k !== "recientes")) as unknown as EstadoAvance;
  let ok = true, seAleja = true;
  try {
    seAleja = leerAvance(viejo, PA).seAleja;
    const sigue = avanzarAvance(viejo, { ...aGeo(0, 1600), ts: ultimoTs(alNorte) + 6_000, acc: 3 }, PA);
    ok = Array.isArray(sigue.recientes) && sigue.recientes.length === 1;
  } catch { ok = false; }
  chk("sin `recientes` no lanza y no afirma «se aleja» (lado seguro)", ok && seAleja === false);
}

// ── 6. BARRIDO: el cambio solo RESTA, y no resta todo ───────────────────────────────
// Recorridos al azar (marcha, giros, paradas, precisión variable, paraderos marcados o no).
// Invariante: nuevo ⇒ viejo en CADA muestra. Corolario: el nuevo sigue afirmando «se aleja» en
// algún caso (un motor que no lo dijera nunca cumpliría la invariante de forma trivial), y el
// cambio apaga casos que el viejo afirmaba (si no, no arreglaría nada).
{
  const rnd = mulberry32(2026);
  let muestras = 0, violaciones = 0, nuevoSi = 0, apagados = 0;
  for (let caso = 0; caso < 400; caso++) {
    const n = 3 + Math.floor(rnd() * 4);
    const marcadas = Math.floor(rnd() * n);
    const pa: ParadaAvance[] = Array.from({ length: n }, (_, i) => ({
      ...aGeo((rnd() - 0.5) * 8000, (rnd() - 0.5) * 8000),
      completada: i < marcadas,
    }));
    let e = estadoAvanceVacio(pa.length);
    let x = (rnd() - 0.5) * 8000, y = (rnd() - 0.5) * 8000, rumbo = rnd() * 2 * Math.PI;
    let t = T0;
    for (let k = 0; k < 250; k++) {
      const dt = 3 + Math.floor(rnd() * 10);
      t += dt * 1000;
      const parado = rnd() < 0.25;
      const v = parado ? 0 : rnd() * 14;
      if (rnd() < 0.08) rumbo += (rnd() - 0.5) * Math.PI;
      x += Math.cos(rumbo) * v * dt; y += Math.sin(rumbo) * v * dt;
      const j = rnd() * 12;
      e = avanzarAvance(e, { ...aGeo(x + (rnd() - 0.5) * j, y + (rnd() - 0.5) * j), ts: t, acc: 3 + rnd() * 50 }, pa);
      const nuevo = leerAvance(e, pa).seAleja, viejo = seAlejaViejo(e, pa);
      muestras++;
      if (nuevo && !viejo) violaciones++;
      if (nuevo) nuevoSi++;
      if (viejo && !nuevo) apagados++;
    }
  }
  chk(`nuevo ⇒ viejo en las ${muestras} muestras (el cambio solo resta)`, violaciones === 0, `${violaciones} violación(es)`);
  chk("el nuevo sigue afirmando «se aleja» cuando corresponde", nuevoSi > 0, `${nuevoSi} muestra(s)`);
  chk("y apaga casos que el viejo afirmaba", apagados > 0, `${apagados} muestra(s)`);
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
