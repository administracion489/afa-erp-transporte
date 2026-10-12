// Pruebas de los EXCESOS DE VELOCIDAD (lib/flota/excesos.ts, puro, y lib/flota/excesos-datos.ts, el
// lector, contra una base falsa en memoria). NO tocan la base.
// Uso:  npx tsx scripts/prueba-excesos.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   0. Las constantes dicen lo mismo que sus fuentes: VMAX_BUS_KMH de lib/huella.ts, ACC_CONFIABLE_M, el
//      piso y el techo del SQL (supabase/gps-analitica-01-excesos.sql), su tope de puntos y de horas,
//      DIAS_RASTREO; y la API acepta exactamente 15 umbrales (de PASO_UMBRAL_KMH en PASO_UMBRAL_KMH).
//   1. Los casos de libro: el fantasma FUSED (bus parado a «95 km/h») → sin_corroborar; el pico suelto →
//      breve; la precisión nula → impreciso; > 130 → imposible; GPS simulado → simulado; p:5 y t:5 nunca
//      se juntan; un hueco > 10 s parte el episodio (10 s justos no); un teléfono sin Doppler → ningún
//      episodio y «sin_velocimetro».
//   2. Barrido sintético (miles de puntos, varios conductores, paradas, picos, saltos, red, simulados):
//      · LOCALIDAD: detectar sobre todo ≡ detectar sobre los puntos ≥ umbral, para diez umbrales;
//      · todo `exceso` cumple las cinco condiciones, recalculadas desde SUS puntos;
//      · cada punto rápido atribuible cae en UN episodio; el código es el del veredicto;
//      · contados, descartados y fuera de servicio son disjuntos y exhaustivos;
//      · lo de fuera de servicio NO suma al ranking; tasa ≤ 1; tri-estado del conductor.
//   3. PARTICIÓN: detectar por tandas con colchón (cortes arbitrarios, ventanas de distinto tamaño) y unir
//      con asignarPorInicio es IDÉNTICO a detectar el todo — también con excesos que cruzan medianoche y
//      duran horas. Sin extensiones, el episodio sale `cortado`, nunca acortado en silencio.
//   4. puntosDeRpc ≡ puntosDeCrudas sobre las mismas filas, y los excesos de un servicio leídos de SU
//      traza son los episodios del todo restringidos a su reserva (lo que usa la estadística por servicio).
//   5. El lector: sin la migración → `sin_migracion` y ningún episodio, sin leer nada más; otro error →
//      lanza un mensaje para una persona (nunca un «0»); el resultado completo cuadra con el motor; unir
//      dos tandas ≡ medir el rango entero; validación de la consulta y tandas de la pantalla.
//      PRIVACIDAD FUERA DE SERVICIO: (a) ningún exceso fuera de servicio sale con más de 2 decimales en el
//      pico (los de servicio, exactos); (b) con fuera=0 el directorio (`conductores`, `unidades`) no nombra
//      a nadie sin servicio ni exceso en servicio en la respuesta — con un caso a mano donde SÍ hay a quién
//      recortar (si no, la invariante se cumpliría de forma trivial).
//   6. Corolario: un bus a 100 km/h durante 60 s, con buena precisión, se detecta para todo umbral ≤ 95
//      y toda cadencia de 1 a 10 s (un motor que nunca detectara nada pasaría todo lo de arriba).
//   7. La ruta, de punta a punta con el supabase-js de verdad contra un Supabase falso por HTTP: 401/403,
//      400 de validación (umbral que no es de 5 en 5, `desde` anterior a hoy − DIAS_RASTREO), `sin_migracion`
//      ante el 404 PGRST202 de PostgREST (sin leer nada más ni cachearlo), ante otro error 200 con `error` y
//      total null, y el TTL decidido por el «hoy» del CÁLCULO con el reloj simulado.

/* eslint-disable @typescript-eslint/no-explicit-any -- la base falsa imita al cliente sin tipos de Supabase */
import fs from "node:fs";
import path from "node:path";

const X = await import("../lib/flota/excesos");
const D = await import("../lib/flota/excesos-datos");
const { distM, ACC_CONFIABLE_M } = await import("../lib/huella");
const { funcionQueFalta } = await import("../lib/columna-faltante");
type PuntoVel = import("../lib/flota/excesos").PuntoVel;
type Episodio = import("../lib/flota/excesos").Episodio;
type RespuestaExcesos = import("../lib/flota/excesos").RespuestaExcesos;
type Velocimetro = import("../lib/flota/excesos").Velocimetro;
type ServicioExpuesto = import("../lib/flota/excesos").ServicioExpuesto;

let fallos = 0, oks = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  if (!ok || process.env.VERBOSO) console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (ok) oks++; else fallos++;
};
const seccion = (t: string) => console.log(`\n── ${t}`);
let semilla = 20261012;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const J = (x: unknown) => JSON.stringify(x);
const T0 = Date.parse("2026-10-05T05:00:00Z");        // 00:00 del lunes 05-10 en Lima
const DIA = 86_400_000;
const PRECISOS = 8;

/** Avanza `m` metros con rumbo `deg` (equirectangular; las distancias se miden con distM). */
function mover(lat: number, lng: number, deg: number, m: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [lat + (m * Math.cos(r)) / 111_320, lng + (m * Math.sin(r)) / (111_320 * Math.cos((lat * Math.PI) / 180))];
}
type OpcTramo = {
  conductor?: string | null; reservaId?: number | null; vehiculo?: string | null; t0?: number; n: number; dtS?: number;
  kmh: number | ((i: number) => number); sensor?: (i: number, kmh: number) => number; precision?: number | null | ((i: number) => number | null);
  simulado?: boolean | null | ((i: number) => boolean | null); jitterM?: number; lat?: number; lng?: number; rumbo?: number;
};
/** Un tramo recto a velocidad dada (la geometría coincide con la velocidad real). */
function tramo(o: OpcTramo): PuntoVel[] {
  let lat = o.lat ?? -12.1, lng = o.lng ?? -76.9, t = o.t0 ?? T0 + 10 * 3_600_000;
  const out: PuntoVel[] = [];
  for (let i = 0; i < o.n; i++) {
    const v = typeof o.kmh === "function" ? o.kmh(i) : o.kmh;
    if (i > 0) [lat, lng] = mover(lat, lng, o.rumbo ?? 30, (v / 3.6) * (o.dtS ?? 3));
    const j = o.jitterM ?? 0;
    const [la, lo] = j ? mover(lat, lng, rnd() * 360, rnd() * j) : [lat, lng];
    out.push({
      ts: t, lat: la, lng: lo, velocidad: o.sensor ? o.sensor(i, v) : v,
      precisionM: typeof o.precision === "function" ? o.precision(i) : o.precision === undefined ? PRECISOS : o.precision,
      reservaId: o.reservaId === undefined ? 100 : o.reservaId,
      conductor: o.conductor === undefined ? "p:1" : o.conductor,
      vehiculo: o.vehiculo === undefined ? "p:10" : o.vehiculo,
      simulado: typeof o.simulado === "function" ? o.simulado(i) : o.simulado === undefined ? false : o.simulado,
    });
    t += (o.dtS ?? 3) * 1000;
  }
  return out;
}
const codigos = (eps: Episodio[]) => eps.map((e) => e.codigo).join(",");

// ══ 0) Las constantes contra sus fuentes ════════════════════════════════════════════════════
seccion("0 · constantes");
{
  const huella = fs.readFileSync(path.join(process.cwd(), "lib/huella.ts"), "utf8");
  const vmax = /const VMAX_BUS_KMH = (\d+)/.exec(huella)?.[1];
  chk("UMBRAL_MAX_KMH = VMAX_BUS_KMH de lib/huella.ts", Number(vmax) === X.UMBRAL_MAX_KMH, `huella dice ${vmax}`);
  chk("PRECISION_CORROBORA_M = ACC_CONFIABLE_M", X.PRECISION_CORROBORA_M === ACC_CONFIABLE_M && ACC_CONFIABLE_M === 20);
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase/gps-analitica-01-excesos.sql"), "utf8");
  chk("el SQL lee con el literal del piso", sql.includes(`g.velocidad >= ${X.UMBRAL_MIN_KMH} `) && sql.includes(`where velocidad >= ${X.UMBRAL_MIN_KMH};`));
  chk("el SQL valida el mismo rango de umbral", sql.includes(`p_umbral < ${X.UMBRAL_MIN_KMH} or p_umbral > ${X.UMBRAL_MAX_KMH}`));
  chk("el SQL tiene el mismo tope de puntos", sql.includes(`c_tope      constant integer := ${X.TOPE_PUNTOS_LLAMADA};`));
  chk("una ventana de un día con su colchón cabe en las 26 h del SQL", sql.includes("interval '26 hours'") && DIA + 2 * X.COLCHON_S * 1000 <= 26 * 3_600_000);
  chk("una extensión cabe en las 26 h", X.EXTENSION_MS <= 26 * 3_600_000);
  chk("el rango de 7 días cabe en los 8 de fn_gps_velocimetro", sql.includes("interval '8 days'") && X.MAX_DIAS_CONSULTA <= 8);
  chk("COLCHON ≥ GAP (si no, la partición no es exacta)", X.COLCHON_S >= X.GAP_EPISODIO_S);
  const porClave = new Map(X.CONSTANTES_EXCESOS.map((c) => [c.clave, c.valor]));
  const exp: Record<string, number> = { UMBRAL_DEFECTO_KMH: X.UMBRAL_DEFECTO_KMH, UMBRAL_MIN_KMH: X.UMBRAL_MIN_KMH, UMBRAL_MAX_KMH: X.UMBRAL_MAX_KMH,
    DURACION_MIN_S: X.DURACION_MIN_S, PUNTOS_MIN: X.PUNTOS_MIN, GAP_EPISODIO_S: X.GAP_EPISODIO_S, FACTOR_CORROBORA: X.FACTOR_CORROBORA, PRECISION_CORROBORA_M: X.PRECISION_CORROBORA_M };
  chk("CONSTANTES_EXCESOS publica los valores con que mide el motor", Object.entries(exp).every(([k, v]) => porClave.get(k) === v) && porClave.size === Object.keys(exp).length);
  chk("ninguna constante impresa cita un artículo sin verificar", X.CONSTANTES_EXCESOS.every((c) => !/art[íi]culo|art\.\s*\d/i.test(c.nota)));
  chk("el umbral por defecto es 90 y se declara elegible", X.UMBRAL_DEFECTO_KMH === 90 && X.CONSTANTES_EXCESOS[0].procedencia === "valor_por_defecto");
  chk("TEXTO_EPISODIO: solo `exceso` cuenta", X.CODIGOS_EPISODIO.every((c) => X.TEXTO_EPISODIO[c].cuenta === (c === "exceso")));
  chk("CODIGOS_DESCARTE = CODIGOS_EPISODIO sin exceso, en el mismo orden", J(X.CODIGOS_DESCARTE) === J(X.CODIGOS_EPISODIO.filter((c) => c !== "exceso")));
  // Los topes contra el abuso de la API (la caché no se esquiva variando el umbral ni yendo atrás).
  const cob = fs.readFileSync(path.join(process.cwd(), "lib/gps-cobertura-datos.ts"), "utf8");
  const diasRastreo = /export const DIAS_RASTREO = (\d+);/.exec(cob)?.[1];
  chk("DIAS_ATRAS_MAX_EXCESOS = DIAS_RASTREO de lib/gps-cobertura-datos.ts", Number(diasRastreo) === X.DIAS_ATRAS_MAX_EXCESOS, `gps-cobertura-datos dice ${diasRastreo}`);
  const ruta = fs.readFileSync(path.join(process.cwd(), "app/api/flota/excesos/route.ts"), "utf8");
  chk("la ruta valida con DIAS_RASTREO y su cola es de 6", ruta.includes("}, hoy, DIAS_RASTREO);") && ruta.includes("crearTurno(2, 6)") && !/crearTurno\(2, 20\)/.test(ruta));
  chk("15 umbrales aceptados, de 5 en 5, del piso al techo, con el defecto dentro",
    X.PASO_UMBRAL_KMH === 5 && X.UMBRALES_ACEPTADOS.length === 15 && X.UMBRALES_ACEPTADOS[0] === X.UMBRAL_MIN_KMH
    && X.UMBRALES_ACEPTADOS[X.UMBRALES_ACEPTADOS.length - 1] === X.UMBRAL_MAX_KMH
    && X.UMBRALES_ACEPTADOS.every((u, i) => u % X.PASO_UMBRAL_KMH === 0 && (i === 0 || u - X.UMBRALES_ACEPTADOS[i - 1] === X.PASO_UMBRAL_KMH))
    && X.UMBRALES_ACEPTADOS.includes(X.UMBRAL_DEFECTO_KMH));
  let soloEsos = true;
  for (let n = 0; n <= 999; n++) {
    const l = X.leerUmbral(String(n));
    if (l.ok !== X.UMBRALES_ACEPTADOS.includes(n) || (l.ok && l.umbral !== n)) { soloEsos = false; console.log(`   leerUmbral("${n}") → ${J(l)}`); }
  }
  chk("leerUmbral acepta exactamente esos 15 (barrido de 0 a 999)", soloEsos);
}

// ══ 1) Casos de libro ══════════════════════════════════════════════════════════════════════
seccion("1 · casos de libro");
const U = 90;
{
  // Fantasma FUSED: bus PARADO, jitter de ±5 m, el sensor dice 95 durante un minuto.
  const fantasma = tramo({ n: 21, kmh: 0, sensor: () => 95, jitterM: 5 });
  const e = X.detectarExcesos(fantasma, U);
  chk("fantasma FUSED → sin_corroborar", codigos(e) === "sin_corroborar", `${codigos(e)} · geom ${e[0]?.velGeom?.toFixed(1)}`);
  chk("…y su detalle nombra la velocidad fantasma", /fantasma/.test(e[0]?.detalle ?? ""));
  // El mismo minuto, pero moviéndose de verdad a 95: exceso.
  chk("el mismo minuto moviéndose a 95 → exceso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 95 }), U)) === "exceso");

  // Pico suelto: un fix a 120 entre fixes a 60.
  const pico = tramo({ n: 30, kmh: (i) => (i === 14 ? 120 : 60) });
  chk("pico suelto → breve", codigos(X.detectarExcesos(pico, U)) === "breve");
  chk("dos muestras en 5 s → breve", codigos(X.detectarExcesos(tramo({ n: 2, dtS: 5, kmh: 100 }), U)) === "breve");
  chk("9 muestras en 24 s → breve (menos de 30 s)", codigos(X.detectarExcesos(tramo({ n: 9, dtS: 3, kmh: 100 }), U)) === "breve");
  chk("4 muestras en 30 s justos (cada 10 s) → exceso", codigos(X.detectarExcesos(tramo({ n: 4, dtS: 10, kmh: 100 }), U)) === "exceso");
  chk("11 muestras en 30 s justos (cada 3 s) → exceso", codigos(X.detectarExcesos(tramo({ n: 11, dtS: 3, kmh: 100 }), U)) === "exceso");
  chk("2 muestras en 10 s → breve (menos de 3 muestras)", codigos(X.detectarExcesos(tramo({ n: 2, dtS: 10, kmh: 100 }), U)) === "breve");

  // Precisión.
  chk("precisión nula → impreciso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: null }), U)) === "impreciso");
  chk("precisión 35 m → impreciso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: 35 }), U)) === "impreciso");
  chk("precisión 0 (sin dato) → impreciso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: 0 }), U)) === "impreciso");
  chk("precisión 20 m justos → exceso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: 20 }), U)) === "exceso");
  chk("mayoría sin precisión → impreciso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: (i) => (i % 3 ? null : 5) }), U)) === "impreciso");
  chk("minoría sin precisión → exceso", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, precision: (i) => (i % 3 === 0 ? null : 5) }), U)) === "exceso");

  // Imposible.
  chk("un fix a 140 → imposible", codigos(X.detectarExcesos(tramo({ n: 21, kmh: (i) => (i === 10 ? 140 : 100) }), U)) === "imposible");
  chk("130 justos no es imposible", codigos(X.detectarExcesos(tramo({ n: 21, kmh: (i) => (i === 10 ? 130 : 100) }), U)) === "exceso");
  const salto = tramo({ n: 21, kmh: 240, sensor: () => 95 });   // posiciones a 240, sensor 95
  chk("posiciones a 240 km/h → imposible (geométrico)", codigos(X.detectarExcesos(salto, U)) === "imposible");
  chk("…y su detalle lo dice por la geometría", /posiciones implican/.test(X.detectarExcesos(salto, U)[0].detalle));
  chk("imposible gana a breve y a impreciso (orden)", codigos(X.detectarExcesos(tramo({ n: 2, kmh: 150, precision: null }), U)) === "imposible");

  // Simulado.
  chk("un punto simulado → simulado", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, simulado: (i) => i === 3 }), U)) === "simulado");
  chk("simulado gana a imposible (orden)", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 150, simulado: true }), U)) === "simulado");
  chk("simulado null (no se pudo comprobar) no veta", codigos(X.detectarExcesos(tramo({ n: 21, kmh: 100, simulado: null }), U)) === "exceso");

  // p:5 y t:5, a la misma hora y en sitios distintos.
  const p5 = tramo({ conductor: "p:5", reservaId: 1, n: 21, kmh: 100, lat: -12.1 });
  const t5 = tramo({ conductor: "t:5", reservaId: 1, n: 21, kmh: 100, lat: -11.5 });
  const ambos = X.detectarExcesos([...p5, ...t5], U);
  chk("p:5 y t:5 son dos episodios (aunque compartan reserva)", ambos.length === 2 && J(ambos.map((e) => e.conductor).sort()) === J(["p:5", "t:5"]));
  chk("…y cada uno es exceso (juntarlos daría velocidades imposibles)", codigos(ambos) === "exceso,exceso");
  // Las dos columnas o ninguna: no dice de quién es.
  chk("claveConductor con las dos columnas → null", X.claveConductor(5, 5) === null && X.claveConductor(null, null) === null);
  chk("claveConductor p/t", X.claveConductor(5, null) === "p:5" && X.claveConductor(null, 5) === "t:5" && X.claveConductor("0", 7) === "t:7");
  chk("claveUnidad: el tercero primero (como claveVehiculo)", X.claveUnidad(3, 4) === "t:4" && X.claveUnidad(3, null) === "p:3" && X.claveUnidad(null, null) === null);

  // Huecos.
  const conHueco = (gap: number) => [...tramo({ n: 15, kmh: 100 }), ...tramo({ n: 15, kmh: 100, t0: T0 + 10 * 3_600_000 + 14 * 3000 + gap * 1000, lat: -12.0 })];
  chk("hueco de 12 s → dos episodios", X.detectarExcesos(conHueco(12), U).length === 2);
  chk("hueco de 10 s justos → uno", X.detectarExcesos(conHueco(10), U).length === 1);
  chk("hueco de 10.001 s → dos", X.detectarExcesos(conHueco(10.001), U).length === 2);
  // Muestras lentas en medio NO cortan (se ignoran).
  const conLentas = tramo({ n: 25, kmh: 100, sensor: (i, v) => (i === 8 || i === 16 ? 70 : v) });
  chk("una muestra lenta suelta en medio no parte el episodio", X.detectarExcesos(conLentas, U).length === 1);

  // Sin Doppler: se mueve a 100 y el sensor dice 0.
  const sinDoppler = tramo({ n: 200, kmh: 100, sensor: () => 0 });
  chk("teléfono sin Doppler → ningún episodio", X.detectarExcesos(sinDoppler, 60).length === 0);
  chk("velocimetroDe(true, false) = sin_velocimetro", X.velocimetroDe(true, false) === "sin_velocimetro");
  chk("velocimetroDe: tabla completa", X.velocimetroDe(true, true) === "con_velocimetro" && X.velocimetroDe(false, null) === "sin_gps"
    && X.velocimetroDe(false, false) === "sin_gps" && X.velocimetroDe(null, true) === "no_se_sabe" && X.velocimetroDe(true, null) === "no_se_sabe");
  chk("solo con_velocimetro es juzgable", X.VELOCIMETROS.every((v) => X.TEXTO_VELOCIMETRO[v].juzgable === (v === "con_velocimetro")));
  const VS = X.VELOCIMETROS;
  let combOk = true;
  for (const a of VS) for (const b of VS) {
    const c = X.combinarVelocimetro(a, b);
    if (c !== X.combinarVelocimetro(b, a)) combOk = false;
    if ((a === "con_velocimetro" || b === "con_velocimetro") !== (c === "con_velocimetro")) combOk = false;
    if (a === b && c !== a) combOk = false;
  }
  chk("combinarVelocimetro: conmutativo, idempotente, la evidencia de velocidad gana", combOk);

  // Fuera de servicio.
  const fuera = X.detectarExcesos(tramo({ n: 21, kmh: 100, reservaId: null }), U);
  chk("sin reserva → fueraDeServicio", fuera.length === 1 && fuera[0].fueraDeServicio && fuera[0].reservaId === null);
  // Sin identidad: no forma episodio, y se cuenta.
  const det = X.crearDetectorExcesos(U);
  for (const p of tramo({ n: 21, kmh: 100, conductor: null, reservaId: null, vehiculo: null })) det.agregar(p);
  chk("sin conductor, servicio ni vehículo → sin episodio, contado", det.cerrar().length === 0 && det.sinIdentidad() === 21);
  // Sin conductor pero con servicio: forma episodio (identidad = el servicio).
  const sinCond = X.detectarExcesos(tramo({ n: 21, kmh: 100, conductor: null, reservaId: 77 }), U);
  chk("sin conductor con servicio → episodio con conductor null", sinCond.length === 1 && sinCond[0].conductor === null && sinCond[0].reservaId === 77);
  // Fuera de orden en el detector por flujo: lanza.
  const d2 = X.crearDetectorExcesos(U);
  const tr = tramo({ n: 3, kmh: 100 });
  d2.agregar(tr[2]);
  let lanza = false;
  try { d2.agregar(tr[0]); } catch { lanza = true; }
  chk("el detector por flujo rechaza un punto fuera de orden", lanza);
  // Textos.
  chk("textoDuracion", X.textoDuracion(45) === "45 s" && X.textoDuracion(80) === "1 min 20 s" && X.textoDuracion(720) === "12 min");
}

// ══ Generador del barrido ══════════════════════════════════════════════════════════════════
type Sesion = { conductor: string | null; reservaId: number | null; vehiculo: string | null; sinDoppler: boolean; pobre?: boolean };
/** Un viaje: rumbo que deriva, tramos a velocidades distintas, paradas con fantasma, picos, red,
 *  huecos, simulados; a veces cruza la medianoche de Lima y dura horas. */
function viaje(s: Sesion, t0: number, minutos: number): PuntoVel[] {
  const out: PuntoVel[] = [];
  let lat = -12 + rnd() * 2, lng = -77 + rnd() * 1.5, rumbo = rnd() * 360, t = t0;
  const fin = t0 + minutos * 60_000;
  let objetivo = 60, cambio = 0, parado = 0;
  const simuladoSesion = rnd() < 0.04;
  while (t < fin) {
    const dt = rnd() < 0.02 ? 11 + rnd() * 40 : rnd() < 0.1 ? 1 + rnd() * 2 : 3;     // huecos y ráfagas
    t += Math.round(dt * 1000);
    if (t >= cambio) { objetivo = rnd() < 0.15 ? 0 : 40 + rnd() * 85; cambio = t + (30 + rnd() * 240) * 1000; }
    let v = objetivo;
    if (parado > 0) { v = 0; parado--; } else if (rnd() < 0.01) parado = 10 + Math.floor(rnd() * 30);
    v = Math.max(0, v + (rnd() - 0.5) * 8);
    rumbo += (rnd() - 0.5) * 10;
    const salto = rnd() < 0.005 ? 400 : 0;                                        // un teletransporte
    [lat, lng] = mover(lat, lng, rumbo, (v / 3.6) * dt + salto);
    const red = rnd() < 0.08;
    const prec = rnd() < 0.03 ? null : red ? 40 + rnd() * 300 : s.pobre ? 15 + rnd() * 40 : 3 + rnd() * 12;
    const j = (prec ?? 25) / 3;
    const [la, lo] = mover(lat, lng, rnd() * 360, rnd() * j);
    let sensor = s.sinDoppler ? 0 : Math.round(v + (rnd() - 0.5) * 4);
    if (!s.sinDoppler && v === 0 && rnd() < 0.3) sensor = Math.round(60 + rnd() * 60);  // fantasma FUSED
    if (!s.sinDoppler && rnd() < 0.003) sensor = 135 + Math.round(rnd() * 60);         // > 130
    out.push({
      ts: t, lat: la, lng: lo, velocidad: Math.max(0, sensor), precisionM: prec,
      reservaId: s.reservaId, conductor: s.conductor, vehiculo: s.vehiculo,
      simulado: simuladoSesion ? true : rnd() < 0.001 ? true : rnd() < 0.2 ? null : false,
    });
  }
  return out;
}
const CONDUCTORES: { c: string | null; sinDoppler: boolean; veh: string; pobre?: boolean }[] = [
  { c: "p:1", sinDoppler: false, veh: "p:10" }, { c: "p:2", sinDoppler: false, veh: "p:11" },
  { c: "p:5", sinDoppler: false, veh: "p:12" }, { c: "t:5", sinDoppler: false, veh: "t:12" },
  { c: "t:7", sinDoppler: false, veh: "t:13" }, { c: "p:9", sinDoppler: true, veh: "p:14" },
  { c: "t:8", sinDoppler: false, veh: "t:13", pobre: true },
  { c: null, sinDoppler: false, veh: "p:15" },
];
let reservaSig = 500;
/** `dias` días desde T0, con viajes al azar y otros forzados a cruzar la medianoche de Lima. */
function flota(dias: number, viajes: number): { puntos: PuntoVel[]; sesiones: (Sesion & { t0: number; dia: number })[] } {
  const puntos: PuntoVel[] = [], sesiones: (Sesion & { t0: number; dia: number })[] = [];
  for (let k = 0; k < viajes; k++) {
    const cd = CONDUCTORES[Math.floor(rnd() * CONDUCTORES.length)];
    const fuera = rnd() < 0.2;
    const s: Sesion = { conductor: cd.c, reservaId: fuera ? (cd.c ? null : reservaSig++) : reservaSig++, vehiculo: cd.veh, sinDoppler: cd.sinDoppler, pobre: cd.pobre };
    const cruza = rnd() < 0.3;
    const dia = Math.floor(rnd() * dias);
    const t0 = cruza ? T0 + (dia + 1) * DIA - Math.floor(rnd() * 3 * 3_600_000) : T0 + dia * DIA + Math.floor(rnd() * DIA * 0.8);
    const minutos = cruza ? 60 + rnd() * 240 : 10 + rnd() * 120;
    puntos.push(...viaje(s, t0, minutos));
    sesiones.push({ ...s, t0, dia });
  }
  return { puntos, sesiones };
}

// ══ 2) Barrido ══════════════════════════════════════════════════════════════════════════════
seccion("2 · barrido");
const BARRIDO = flota(3, 45);
const UMBRALES = [60, 70, 80, 85, 90, 95, 100, 110, 120, 130];
{
  const todos = BARRIDO.puntos;
  chk("el barrido tiene volumen", todos.length > 20_000, `${todos.length} puntos`);
  let local = true, cinco = true, exhaustivo = true, veredicto = true, homog = true, conteo = true, hayExceso = 0;
  const hayDesc = new Set<string>();
  for (const u of UMBRALES) {
    const a = X.detectarExcesos(todos, u);
    const b = X.detectarExcesos(todos.filter((p) => p.velocidad >= u), u);
    if (J(a) !== J(b)) local = false;
    // Puntos de cada episodio, recalculados desde la entrada.
    const rapidos = todos.filter((p) => p.velocidad >= u && X.claveRacha(p) != null);
    const porClave = new Map<string, PuntoVel[]>();
    for (const p of rapidos) { const k = X.claveRacha(p)!; const l = porClave.get(k); if (l) l.push(p); else porClave.set(k, [p]); }
    for (const v of porClave.values()) v.sort((x, y) => x.ts - y.ts);
    let suma = 0;
    for (const e of a) {
      const k = e.conductor ?? (e.reservaId != null ? `r:${e.reservaId}` : `v:${e.vehiculo}`);
      const pts = (porClave.get(`${k}|${e.reservaId ?? "-"}`) ?? []).filter((p) => p.ts >= e.inicioTs && p.ts <= e.finTs);
      suma += e.puntos;
      if (pts.length !== e.puntos) { exhaustivo = false; continue; }
      if (pts.some((p) => p.conductor !== e.conductor || p.reservaId !== e.reservaId)) homog = false;
      let cuerdas = 0;
      for (let i = 1; i < pts.length; i++) cuerdas += distM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      const dur = (e.finTs - e.inicioTs) / 1000;
      const geom = dur > 0 ? (cuerdas / dur) * 3.6 : null;
      const precs = pts.map((p) => (p.precisionM != null && p.precisionM > 0 ? p.precisionM : Infinity)).sort((x, y) => x - y);
      const n = pts.length, med = n % 2 ? precs[(n - 1) / 2] : (precs[n / 2 - 1] + precs[n / 2]) / 2;
      const m = { simulado: pts.some((p) => p.simulado === true), velMaxSensor: Math.max(...pts.map((p) => p.velocidad)), velGeom: geom, durS: dur, puntos: n, precisionMediana: Number.isFinite(med) ? med : null };
      if (X.juzgarRacha(m, u) !== e.codigo) veredicto = false;
      if (e.codigo === "exceso") {
        hayExceso++;
        const ok = !m.simulado && m.velMaxSensor <= 130 && geom != null && geom <= 130 && dur >= 30 && n >= 3
          && m.precisionMediana != null && m.precisionMediana <= 20 && geom >= 0.9 * u
          && Math.abs(e.velGeom! - geom) < 1e-9 && e.precisionMediana === m.precisionMediana;
        if (!ok) cinco = false;
      } else hayDesc.add(e.codigo);
    }
    if (suma !== rapidos.length) conteo = false;
  }
  chk("LOCALIDAD: detectar todo ≡ detectar solo lo rápido (10 umbrales)", local);
  chk("todo `exceso` cumple las cinco condiciones (recalculadas desde sus puntos)", cinco, `${hayExceso} excesos`);
  chk("cada episodio tiene exactamente sus puntos, todos del mismo conductor y servicio", exhaustivo && homog);
  chk("el código de cada episodio es el del veredicto", veredicto);
  chk("cada punto rápido atribuible cae en exactamente un episodio", conteo);
  chk("el barrido produce excesos y los cinco descartes", hayExceso > 0 && X.CODIGOS_DESCARTE.every((c) => hayDesc.has(c)), [...hayDesc].join(","));

  // Clasificación y resumen.
  const eps = X.detectarExcesos(todos, U);
  const c = X.clasificarEpisodios(eps);
  const sumaD = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  chk("contados + fuera + descartados (dentro y fuera) = todos", c.enServicio.length + c.fueraDeServicioTotal + sumaD(c.descartados) + sumaD(c.descartadosFuera) === eps.length);
  chk("contados: todos `exceso` con servicio; fuera: todos `exceso` sin servicio",
    c.enServicio.every((e) => e.codigo === "exceso" && e.reservaId != null) && c.fueraDeServicio.every((e) => e.codigo === "exceso" && e.reservaId == null));
  chk("hay excesos fuera de servicio en el barrido", c.fueraDeServicioTotal > 0);
  const servicios: ServicioExpuesto[] = BARRIDO.sesiones.filter((s) => s.reservaId != null).map((s) => ({
    reservaId: s.reservaId!, fecha: null, hora: null, codigo: null, estado: "finalizada", prestado: true,
    conductor: s.conductor, vehiculo: s.vehiculo, cliente: null, ruta: { nombre: null, recorrido: null, origen: null, destino: null, fuente: "ninguna" },
  }));
  const vel = new Map<string, Velocimetro>(CONDUCTORES.filter((x) => x.c).map((x) => [x.c!, x.sinDoppler ? "sin_velocimetro" : "con_velocimetro"]));
  const r1 = X.resumirExcesos(eps, { servicios, velocimetro: vel }, { incluirFueraDeServicio: true });
  const r0 = X.resumirExcesos(eps.filter((e) => e.reservaId != null), { servicios, velocimetro: vel }, { incluirFueraDeServicio: true });
  const sinFuera = (r: typeof r1) => J({ ...r, fueraDeServicio: [], fueraDeServicioTotal: 0, descartadosFuera: null });
  chk("lo de fuera de servicio NO suma al ranking (quitarlo no cambia nada más)", sinFuera(r1) === sinFuera(r0));
  const sumaC = r1.porConductor.reduce((a, f) => a + (f.excesos ?? 0), 0);
  chk("Σ excesos por conductor + sin conductor = contados", sumaC + r1.totales.sinConductor === c.enServicio.length && r1.totales.excesos === c.enServicio.length);
  chk("Σ excesos por unidad + sin unidad = contados", r1.porUnidad.reduce((a, f) => a + (f.excesos ?? 0), 0) + r1.totales.sinUnidad === c.enServicio.length);
  chk("Σ excesos por servicio = contados", r1.porServicio.reduce((a, f) => a + f.excesos, 0) === c.enServicio.length);
  chk("tasa ≤ 1 y con exceso ≤ prestados en toda fila",
    [...r1.porConductor, ...r1.porUnidad].every((f) => f.tasa == null || (f.tasa <= 1 && (f.serviciosConExceso ?? 0) <= f.serviciosPrestados)));
  const p9 = r1.porConductor.find((f) => f.conductor === "p:9");
  chk("tri-estado: el conductor sin velocímetro sale con excesos null, no 0", !!p9 && p9.excesos === null && p9.velocimetro === "sin_velocimetro" && p9.tasa === null);
  chk("…y uno con velocímetro sin excesos saldría con 0", (() => {
    const rr = X.resumirExcesos([], { servicios: servicios.filter((s) => s.conductor === "p:1").slice(0, 2), velocimetro: vel }, { incluirFueraDeServicio: false });
    return rr.porConductor.length === 1 && rr.porConductor[0].excesos === 0 && rr.porConductor[0].tasa === 0 && rr.totales.excesos === 0;
  })());
  chk("sin servicios ni excesos → total null (sin_servicios)", X.resumirExcesos([], { servicios: [], velocimetro: new Map() }, { incluirFueraDeServicio: false }).totales.motivoSinTotal === "sin_servicios");
  chk("solo conductores sin velocímetro → total null (sin_juzgables)", (() => {
    const rr = X.resumirExcesos([], { servicios: servicios.filter((s) => s.conductor === "p:9"), velocimetro: vel }, { incluirFueraDeServicio: false });
    return rr.totales.excesos === null && rr.totales.motivoSinTotal === "sin_juzgables" && rr.porVelocimetro.sin_velocimetro === 1;
  })());
  chk("velocímetro no leído → total null (no_se_sabe)", X.resumirExcesos([], { servicios, velocimetro: new Map() }, { incluirFueraDeServicio: false }).totales.motivoSinTotal === "no_se_sabe");
  chk("con fuera=false la lista de fuera de servicio va vacía y el total se conserva", (() => {
    const rr = X.resumirExcesos(eps, { servicios, velocimetro: vel }, { incluirFueraDeServicio: false });
    return rr.fueraDeServicio.length === 0 && rr.fueraDeServicioTotal === c.fueraDeServicioTotal;
  })());
}

// ══ 3) Partición ═══════════════════════════════════════════════════════════════════════════
seccion("3 · partición por tandas");
const lectorDe = (pts: readonly PuntoVel[], u: number, registro?: { maxMs: number; llamadas: number }, tope = Infinity) => {
  const orden = pts.map((p, i) => ({ p, i })).filter((x) => x.p.velocidad >= u).sort((a, b) => a.p.ts - b.p.ts || a.i - b.i).map((x) => x.p);
  return async (a: number, b: number) => {
    if (registro) { registro.maxMs = Math.max(registro.maxMs, b - a); registro.llamadas++; }
    const sel = orden.filter((p) => p.ts >= a && p.ts < b);
    return { puntos: sel.slice(0, tope), recortado: sel.length > tope };
  };
};
// Viajes de carretera: horas seguidas por encima del umbral (con algún hueco), varios cruzando medianoche.
const CARRETERA: PuntoVel[] = [];
for (let k = 0; k < 10; k++) {
  const cruza = k < 4;
  const t0 = cruza ? T0 + (1 + (k % 2)) * DIA - Math.floor(rnd() * 2 * 3_600_000) : T0 + Math.floor(rnd() * 2.7 * DIA);
  const horas = 1 + rnd() * 4;
  let t = t0, lat = -13 + rnd(), lng = -76.5;
  const cd = ["p:1", "p:2", "t:5", "t:7"][k % 4];
  while (t < t0 + horas * 3_600_000) {
    const n = 20 + Math.floor(rnd() * 400);
    const tr = tramo({ n, dtS: 3, t0: t, lat, lng, kmh: (i) => 92 + 12 * Math.sin(i / 37) + (rnd() - 0.5) * 4, conductor: cd, reservaId: 7000 + k, vehiculo: "p:20", rumbo: 200 + k * 7 });
    CARRETERA.push(...tr);
    ({ lat, lng } = tr[tr.length - 1]);
    t += n * 3000 + (rnd() < 0.5 ? 4000 : 4000 + Math.floor(rnd() * 25_000));
  }
}
{
  const todos = [...BARRIDO.puntos, ...CARRETERA];
  const A = T0, B = T0 + 3 * DIA;
  let identico = true, casos = 0, cruzan = 0, cruzanCorte = 0;
  const reg = { maxMs: 0, llamadas: 0 };
  for (const u of [60, 75, 90, 100, 120]) {
    const entero = X.asignarPorInicio(X.detectarExcesos(todos, u), A, B);
    cruzan += entero.filter((e) => Math.floor((e.inicioTs - T0) / DIA) !== Math.floor((e.finTs - T0) / DIA) && e.finTs - (T0 + Math.ceil((e.inicioTs - T0) / DIA) * DIA) > 60_000).length;
    for (let rep = 0; rep < 6; rep++) {
      // Cortes: las medianoches de Lima (como el lector) o instantes al azar.
      const cortes = rep === 0 ? [A, A + DIA, A + 2 * DIA, B]
        : [A, ...Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => A + Math.floor(rnd() * (B - A))).sort((x, y) => x - y), B];
      const trozo = rep === 0 ? DIA : (2 + Math.floor(rnd() * 22)) * 3_600_000;
      for (const k of cortes.slice(1, -1)) cruzanCorte += entero.filter((e) => e.inicioTs < k && e.finTs > k + X.COLCHON_S * 1000).length;
      const unidos: Episodio[] = [];
      for (let i = 0; i + 1 < cortes.length; i++) {
        if (cortes[i + 1] <= cortes[i]) continue;
        const r = await X.detectarEnRango(lectorDe(todos, u, reg), { desdeTs: cortes[i], hastaTs: cortes[i + 1], umbral: u, trozoMs: trozo, paralelo: 1 + (rep % 3) });
        unidos.push(...r.episodios);
      }
      casos++;
      if (J(unidos) !== J(entero)) { identico = false; console.log(`   umbral ${u} rep ${rep}: ${unidos.length} vs ${entero.length}`); }
    }
  }
  chk("unir tandas con asignarPorInicio ≡ detectar el todo (5 umbrales × 6 cortes)", identico, `${casos} casos`);
  chk("…con excesos que cruzan un corte de tanda por más que el colchón", cruzanCorte >= 10, `${cruzanCorte} (${cruzan} en medianoche)`);
  const largos = X.detectarExcesos(CARRETERA, 75).filter((e) => e.codigo === "exceso" && e.durS > 1800).length;
  chk("…y los viajes de carretera dan excesos largos de verdad (no imposibles)", largos >= 3, `${largos} de más de 30 min`);
  chk("ninguna ventana pedida pasa de 26 h", reg.maxMs <= 26 * 3_600_000, `${(reg.maxMs / 3_600_000).toFixed(2)} h`);
  // La prueba tiene dientes: sin extensiones, o sin colchón, la unión YA NO es el todo.
  const porTandas = async (u: number, o: { colchonMs?: number; maxExtensiones?: number }) => {
    const out: Episodio[] = [];
    for (let d = 0; d < 3; d++) out.push(...(await X.detectarEnRango(lectorDe(todos, u), { desdeTs: A + d * DIA, hastaTs: A + (d + 1) * DIA, umbral: u, ...o })).episodios);
    return J(out);
  };
  const enteroU = J(X.asignarPorInicio(X.detectarExcesos(todos, 75), A, B));
  chk("sin extensiones la unión NO es el todo (la extensión hace falta)", (await porTandas(75, { maxExtensiones: 0 })) !== enteroU);
  chk("sin colchón la unión NO es el todo (el colchón hace falta)", (await porTandas(75, { colchonMs: 0 })) !== enteroU);
  chk("con los dos, sí", (await porTandas(75, {})) === enteroU);

  // Un exceso de 3 h que cruza la medianoche: con extensiones sale completo; sin ellas, `cortado`.
  const largo = tramo({ n: 3600, dtS: 3, kmh: 95, t0: T0 + DIA - 3_600_000, conductor: "p:3", reservaId: 900 });
  const completo = X.detectarExcesos(largo, U);
  const conExt = await X.detectarEnRango(lectorDe(largo, U), { desdeTs: T0, hastaTs: T0 + DIA, umbral: U });
  chk("exceso de 3 h cruzando medianoche: completo con extensiones", conExt.episodios.length === 1 && J(conExt.episodios) === J(completo) && !conExt.episodios[0].cortado,
    `${conExt.ventanas.filter((w) => w.extension).length} extensiones`);
  const sinExt = await X.detectarEnRango(lectorDe(largo, U), { desdeTs: T0, hastaTs: T0 + DIA, umbral: U, maxExtensiones: 0 });
  chk("…sin extensiones sale `cortado` (y lo dice), nunca acortado en silencio", sinExt.episodios.length === 1 && sinExt.episodios[0].cortado && sinExt.cortados === 1
    && /Seguía por encima/.test(sinExt.episodios[0].detalle));
  const otroDia = await X.detectarEnRango(lectorDe(largo, U), { desdeTs: T0 + DIA, hastaTs: T0 + 2 * DIA, umbral: U });
  chk("…y el día siguiente no lo cuenta otra vez (empezó antes)", otroDia.episodios.length === 0);
  // Recortado: la lectura avisa.
  const rec = await X.detectarEnRango(lectorDe(largo, U, undefined, 100), { desdeTs: T0, hastaTs: T0 + DIA, umbral: U });
  chk("una ventana que llegó a su tope sale `recortado`", rec.ventanas.some((w) => w.recortado));
  // Un error de lectura lanza (nunca un «0»).
  let lanzo = false;
  try { await X.detectarEnRango(async () => { throw new Error("red"); }, { desdeTs: T0, hastaTs: T0 + DIA, umbral: U }); } catch { lanzo = true; }
  chk("un error de lectura LANZA (no devuelve 0 episodios)", lanzo);
  chk("ventanasDeLectura: contiguas, sin solaparse, con colchón en los bordes", (() => {
    const w = X.ventanasDeLectura(T0, T0 + 7 * DIA);
    return w.length === 7 && w[0].desdeTs === T0 - 60_000 && w[6].hastaTs === T0 + 7 * DIA + 60_000 && w.every((x, i) => i === 0 || x.desdeTs === w[i - 1].hastaTs);
  })());
}

// ══ 4) Las dos lecturas, y el servicio contra el todo ══════════════════════════════════════
seccion("4 · puntosDeRpc ≡ puntosDeCrudas; el servicio ≡ el todo restringido");
{
  const filas = [
    { id: 1, created_at: "2026-10-09T11:00:00.123456+00:00", lat: -12.1, lng: -77, velocidad: 95, precision_m: 6, reserva_id: 5, conductor_id: 3, conductor_tercero_id: null, vehiculo_id: 8, vehiculo_tercero_id: null, simulado: false },
    { id: 2, created_at: "2026-10-09T11:00:03.999+00:00", lat: null, lng: -77, velocidad: 96, precision_m: 6, reserva_id: 5, conductor_id: 3, conductor_tercero_id: null, vehiculo_id: 8, vehiculo_tercero_id: null, simulado: null },
    { id: 3, created_at: "2026-10-09T11:00:06+00:00", lat: -12.1, lng: -77.0002, velocidad: 97, precision_m: null, reserva_id: null, conductor_id: null, conductor_tercero_id: 4, vehiculo_id: null, vehiculo_tercero_id: 9, simulado: true },
    { id: 4, created_at: "2026-10-09T11:00:09+00:00", lat: -12.1, lng: -77.0004, velocidad: 98, precision_m: 7, reserva_id: 6, conductor_id: 3, conductor_tercero_id: 4, vehiculo_id: 1, vehiculo_tercero_id: 2, simulado: null },
  ];
  const comoRpc = filas.map((f) => [Math.floor(Date.parse(f.created_at)), f.lat, f.lng, f.velocidad, f.precision_m, f.reserva_id, f.conductor_id, f.conductor_tercero_id, f.vehiculo_id, f.vehiculo_tercero_id, f.simulado]);
  const a = X.puntosDeRpc(comoRpc), b = X.puntosDeCrudas(filas);
  chk("las dos lecturas dan los mismos puntos", J(a) === J(b) && a.length === 3);
  chk("lat/lng nulos se descartan", !a.some((p) => p.velocidad === 96));
  chk("las dos columnas de conductor → sin conductor; el vehículo tercero primero", a[2].conductor === null && a[2].vehiculo === "t:2");
  chk("microsegundos truncados como el SQL", a[0].ts === Date.parse("2026-10-09T11:00:00.123Z"));
  chk("simulado tri-estado", a[0].simulado === false && a[1].simulado === true && a[2].simulado === null);
  chk("puntosDeRpc ignora basura", X.puntosDeRpc([null, "x", [1, 2], [Date.now(), "a", 1, 90]] as unknown[]).length === 0 && X.puntosDeRpc(null).length === 0);
  // La traza de un servicio viene sin reserva_id ni vehículo: se le pasan.
  const crudas = filas.map((f) => ({ created_at: f.created_at, lat: f.lat, lng: f.lng, velocidad: f.velocidad, precision_m: f.precision_m,
    conductor_id: f.conductor_id, conductor_tercero_id: f.conductor_tercero_id, simulado: f.simulado }));
  const c = X.puntosDeCrudas(crudas, { reservaId: 5, vehiculo: "p:8" });
  chk("sin columnas de reserva/vehículo se usan las que pasa quien lee", c.every((p) => p.reservaId === 5 && p.vehiculo === "p:8"));
  chk("`timestamp` de respaldo si falta created_at", X.puntosDeCrudas([{ timestamp: "2026-10-09T11:00:00Z", lat: 1, lng: 1, velocidad: 1 }])[0]?.ts === Date.parse("2026-10-09T11:00:00Z"));

  // Lo que usa la estadística por servicio: cada servicio leído de SU traza (filas crudas, sin reserva_id).
  let coinciden = true, servicios = 0;
  const todos = BARRIDO.puntos;
  for (const u of [60, 90]) {
    const global = X.detectarExcesos(todos, u);
    const ids = [...new Set(todos.map((p) => p.reservaId).filter((x): x is number => x != null))];
    for (const id of ids) {
      const deSuTraza = todos.filter((p) => p.reservaId === id).map((p) => {
        const [cid, tid] = p.conductor?.startsWith("p:") ? [Number(p.conductor.slice(2)), null] : p.conductor?.startsWith("t:") ? [null, Number(p.conductor.slice(2))] : [null, null];
        return { created_at: new Date(p.ts).toISOString(), lat: p.lat, lng: p.lng, velocidad: p.velocidad, precision_m: p.precisionM, simulado: p.simulado, conductor_id: cid, conductor_tercero_id: tid, rumbo: 0, timestamp: null, estado: "en_ruta" };
      });
      const veh = todos.find((p) => p.reservaId === id)?.vehiculo ?? null;
      const local = X.detectarExcesos(X.puntosDeCrudas(deSuTraza, { reservaId: id, vehiculo: veh }), u);
      if (J(local) !== J(global.filter((e) => e.reservaId === id))) coinciden = false;
      servicios++;
    }
  }
  chk("los excesos de un servicio leídos de su traza ≡ el todo restringido a su reserva", coinciden, `${servicios} servicios`);
}

// ══ 5) El lector, contra una base falsa ═════════════════════════════════════════════════════
seccion("5 · lector");
type Tablas = Record<string, any[]>;
/** Un cliente de Supabase en memoria: from().select().gte/lte/in/eq/order/range y rpc() con las dos
 *  funciones de la migración (validaciones incluidas) o un error forzado. */
function clienteFalso(t: Tablas, o: { errorRpc?: Record<string, { code: string; message: string }>; tope?: number; llamadas?: string[] } = {}) {
  const log = o.llamadas ?? [];
  const tsDe = (r: any) => Date.parse(r.created_at);
  return {
    rpc(fn: string, args: Record<string, any>) {
      log.push(`rpc:${fn}`);
      const err = o.errorRpc?.[fn];
      if (err) return Promise.resolve({ data: null, error: err });
      const desde = Date.parse(args.p_desde), hasta = Date.parse(args.p_hasta);
      if (fn === "fn_gps_puntos_rapidos") {
        if (args.p_umbral < 60 || args.p_umbral > 130 || hasta <= desde || hasta - desde > 26 * 3_600_000) return Promise.resolve({ data: null, error: { code: "22023", message: "fuera de rango" } });
        const sel = (t.ubicaciones_gps ?? []).filter((r) => r.velocidad != null && r.velocidad >= 60 && r.velocidad >= args.p_umbral && tsDe(r) >= desde && tsDe(r) < hasta)
          .sort((a, b) => tsDe(a) - tsDe(b) || a.id - b.id);
        const tope = o.tope ?? 60_000;
        return Promise.resolve({ data: { recortado: sel.length > tope, puntos: sel.slice(0, tope).map((r) => [tsDe(r), r.lat, r.lng, r.velocidad, r.precision_m, r.reserva_id, r.conductor_id, r.conductor_tercero_id, r.vehiculo_id, r.vehiculo_tercero_id, r.simulado ?? null]) }, error: null });
      }
      if (fn === "fn_gps_velocimetro") {
        if (hasta - desde > 8 * DIA || (args.p_propios ?? []).length > 300 || (args.p_terceros ?? []).length > 300) return Promise.resolve({ data: null, error: { code: "22023", message: "fuera de rango" } });
        const filas: any[] = [];
        for (const [tabla, col, ids] of [["conductores", "conductor_id", args.p_propios ?? []], ["conductores_tercero", "conductor_tercero_id", args.p_terceros ?? []]] as const) {
          for (const id of [...new Set(ids as number[])]) {
            const suyos = (t.ubicaciones_gps ?? []).filter((r) => r[col] === id && tsDe(r) >= desde && tsDe(r) < hasta);
            filas.push({ tabla, conductor_id: id, hay_puntos: suyos.length > 0, hay_velocidad: suyos.length ? suyos.some((r) => r.velocidad > 0) : null });
          }
        }
        return Promise.resolve({ data: filas, error: null });
      }
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } });
    },
    from(tabla: string) {
      log.push(`from:${tabla}`);
      const filtros: ((r: any) => boolean)[] = [];
      const ordenes: [string, boolean][] = [];
      let rango: [number, number] | null = null;
      const q: any = {
        select: () => q,
        gte: (c: string, v: any) => { filtros.push((r) => r[c] >= v); return q; },
        lte: (c: string, v: any) => { filtros.push((r) => r[c] <= v); return q; },
        eq: (c: string, v: any) => { filtros.push((r) => r[c] === v); return q; },
        in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(r[c])); return q; },
        order: (c: string, op?: { ascending?: boolean }) => { ordenes.push([c, op?.ascending !== false]); return q; },
        range: (a: number, b: number) => { rango = [a, b]; return q; },
        then: (ok: any, ko: any) => {
          let rows = (t[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
          rows = rows.sort((a, b) => { for (const [c, asc] of ordenes) { if (a[c] < b[c]) return asc ? -1 : 1; if (a[c] > b[c]) return asc ? 1 : -1; } return 0; });
          if (rango) rows = rows.slice(rango[0], rango[1] + 1);
          return Promise.resolve({ data: rows, error: null }).then(ok, ko);
        },
      };
      return q;
    },
  };
}
/** Una base falsa: reservas de varios días (algunas canceladas o programadas), la flota del barrido como
 *  filas de ubicaciones_gps, nombres, placas y clientes. */
function baseFalsa(dias: number): { tablas: Tablas; puntos: PuntoVel[] } {
  const { puntos, sesiones } = flota(dias, 40);
  // Un viaje de p:9 (sin Doppler) seguro, para el tri-estado.
  const extra = viaje({ conductor: "p:9", reservaId: 4999, vehiculo: "p:14", sinDoppler: true }, T0 + 9 * 3_600_000, 60);
  puntos.push(...extra);
  sesiones.push({ conductor: "p:9", reservaId: 4999, vehiculo: "p:14", sinDoppler: true, t0: T0 + 9 * 3_600_000, dia: 0 });
  // Un conductor asignado que nunca mandó GPS (sin_gps).
  const reservas: any[] = [{ id: 4998, codigo: "R-4998", fecha_servicio: "2026-10-05", hora_servicio: "08:00:00", estado: "finalizada", cliente_id: 1, conductor_id: 77, conductor_tercero_id: null, vehiculo_id: 16, vehiculo_tercero_id: null, ruta_nombre: "RUTA Z", origen: "A", destino: "B" }];
  const fecha = (ts: number) => new Date(ts - 5 * 3_600_000).toISOString().slice(0, 10);
  for (const s of sesiones) {
    if (s.reservaId == null) continue;
    const [cid, tid] = s.conductor?.startsWith("p:") ? [Number(s.conductor.slice(2)), null] : s.conductor?.startsWith("t:") ? [null, Number(s.conductor.slice(2))] : [null, null];
    const [vid, vtid] = s.vehiculo?.startsWith("p:") ? [Number(s.vehiculo.slice(2)), null] : [null, Number(s.vehiculo!.slice(2))];
    const r = rnd();
    reservas.push({ id: s.reservaId, codigo: `R-${s.reservaId}`, fecha_servicio: fecha(s.t0), hora_servicio: "06:30:00",
      estado: r < 0.1 ? "programada" : r < 0.15 ? "cancelada" : r < 0.25 ? "en_curso" : "finalizada", cliente_id: 1 + (s.reservaId % 3),
      conductor_id: cid, conductor_tercero_id: tid, vehiculo_id: vid, vehiculo_tercero_id: vtid,
      ruta_nombre: s.reservaId % 4 ? `RUTA ${s.reservaId % 4}` : null, origen: "SANTA ANITA", destino: "PUNTA HERMOSA" });
  }
  let id = 1;
  const ubic = puntos.map((p) => {
    const [cid, tid] = p.conductor?.startsWith("p:") ? [Number(p.conductor.slice(2)), null] : p.conductor?.startsWith("t:") ? [null, Number(p.conductor.slice(2))] : [null, null];
    const [vid, vtid] = p.vehiculo?.startsWith("p:") ? [Number(p.vehiculo.slice(2)), null] : p.vehiculo?.startsWith("t:") ? [null, Number(p.vehiculo.slice(2))] : [null, null];
    return { id: id++, created_at: new Date(p.ts).toISOString(), lat: p.lat, lng: p.lng, velocidad: p.velocidad, precision_m: p.precisionM, reserva_id: p.reservaId,
      conductor_id: cid, conductor_tercero_id: tid, vehiculo_id: vid, vehiculo_tercero_id: vtid, simulado: p.simulado };
  });
  return {
    puntos,
    tablas: {
      ubicaciones_gps: ubic, reservas,
      conductores: [1, 2, 5, 9, 77].map((i) => ({ id: i, nombre: `Conductor ${i}`, telefono: "999" })),
      conductores_tercero: [5, 7, 8].map((i) => ({ id: i, nombre: `Tercero ${i}`, telefono: "999" })),
      vehiculos: [10, 11, 12, 14, 15, 16].map((i) => ({ id: i, placa: `ABC-${i}` })),
      vehiculos_tercero: [12, 13].map((i) => ({ id: i, placa: `TER-${i}` })),
      clientes: [{ id: 1, nombre: "Uno", empresa: "EMPRESA UNO" }, { id: 2, nombre: "Dos", empresa: null }, { id: 3, nombre: "Tres", empresa: "TRES SAC" }],
    },
  };
}
const sinHora = (r: RespuestaExcesos) => J({ ...r, medidoEn: null });
{
  // Sin migración: PostgREST (PGRST202) y Postgres (42883).
  for (const err of [
    { code: "PGRST202", message: "Could not find the function public.fn_gps_puntos_rapidos(p_desde, p_hasta, p_umbral) in the schema cache" },
    { code: "42883", message: "function fn_gps_puntos_rapidos(timestamp with time zone, timestamp with time zone, integer) does not exist" },
  ]) {
    chk(`funcionQueFalta reconoce ${err.code}`, funcionQueFalta(err) === "fn_gps_puntos_rapidos");
    const llamadas: string[] = [];
    const r = await D.excesosDelRango({ desde: "2026-10-05", hasta: "2026-10-07", umbral: 90 }, clienteFalso(baseFalsa(3).tablas, { errorRpc: { fn_gps_puntos_rapidos: err }, llamadas }));
    chk(`sin migración (${err.code}) → sin_migracion y ningún episodio`, r.sin_migracion === X.MIGRACION_EXCESOS && r.episodios.length === 0 && r.resumen.porConductor.length === 0
      && r.resumen.totales.excesos === null && r.error === null);
    chk(`…sin leer ninguna tabla (no cae a un recorrido)`, llamadas.every((l) => l.startsWith("rpc:fn_gps_puntos_rapidos")), llamadas.join(","));
  }
  // Otro error: lanza un mensaje para una persona, con un reintento; nunca sin_migracion ni «0».
  const llamadas: string[] = [];
  let msg = "", esLectura = false;
  try {
    await D.excesosDelRango({ desde: "2026-10-05", hasta: "2026-10-05", umbral: 90 }, clienteFalso({}, { errorRpc: { fn_gps_puntos_rapidos: { code: "57014", message: "canceling statement due to statement timeout" } }, llamadas }));
  } catch (e: any) { msg = e.message; esLectura = e instanceof D.ErrorLecturaExcesos; }
  chk("otro error → ErrorLecturaExcesos con un mensaje en español (sin el texto crudo de Postgres)", esLectura && /No se pudieron leer las posiciones del 2026-10-05/.test(msg) && !/statement/.test(msg), msg);
  chk("…tras un reintento", llamadas.filter((l) => l === "rpc:fn_gps_puntos_rapidos").length === 2);
  chk("un error de columna no se lee como «falta la función»", funcionQueFalta({ code: "42703", message: 'column "velocidad" does not exist' }) === null);

  // El resultado completo, contra el motor.
  const { tablas, puntos } = baseFalsa(6);
  const desde = "2026-10-05", hasta = "2026-10-10";
  const r = await D.excesosDelRango({ desde, hasta, umbral: 90 }, clienteFalso(tablas));
  const { desdeTs, hastaTs } = X.rangoLimaMs(desde, hasta);
  const esperado = X.asignarPorInicio(X.detectarExcesos(puntos, 90), desdeTs, hastaTs);
  const esperadoEn = esperado.filter((e) => e.codigo === "exceso" && e.reservaId != null);
  chk("los excesos del lector son los del motor sobre todos los puntos", J(r.episodios.map((e) => [e.inicioTs, e.conductor, e.reservaId, e.puntos]))
    === J(X.ordenarEpisodios(esperadoEn).map((e) => [e.inicioTs, e.conductor, e.reservaId, e.puntos])), `${r.episodios.length} excesos`);
  chk("…y los descartes y los de fuera de servicio también", J(r.resumen.descartados) === J(X.clasificarEpisodios(esperado).descartados)
    && r.resumen.fueraDeServicioTotal === X.clasificarEpisodios(esperado).fueraDeServicioTotal);
  chk("el vehículo de un exceso en servicio es el de la reserva", r.episodios.every((e) => {
    const s = r.servicios.find((x) => x.reservaId === e.reservaId);
    return !s?.vehiculo || s.vehiculo === e.vehiculo;
  }));
  chk("solo los finalizados o en curso son exposición", r.servicios.filter((s) => s.prestado).every((s) => s.estado === "finalizada" || s.estado === "en_curso"));
  chk("los servicios tocados por un exceso están (aunque no estén prestados)", r.episodios.every((e) => r.servicios.some((s) => s.reservaId === e.reservaId)));
  chk("RUTA y ORIGEN → DESTINO por separado; sin nombre, nombre null (nunca el recorrido)", r.servicios.every((s) => s.ruta.recorrido === `${s.ruta.origen} → ${s.ruta.destino}`)
    && r.servicios.some((s) => s.ruta.nombre === null) && r.servicios.every((s) => s.ruta.nombre !== s.ruta.recorrido));
  chk("cliente: empresa, y si no, nombre", r.servicios.some((s) => s.cliente === "EMPRESA UNO") && r.servicios.some((s) => s.cliente === "Dos"));
  const vel = new Map(r.conductores.map((c) => [c.clave, c.velocimetro]));
  chk("velocímetro: p:9 sin velocímetro, p:77 sin GPS, p:1 con", vel.get("p:9") === "sin_velocimetro" && vel.get("p:77") === "sin_gps" && vel.get("p:1") === "con_velocimetro");
  chk("p:9 en el ranking: excesos null (no se puede juzgar)", r.resumen.porConductor.find((f) => f.conductor === "p:9")?.excesos === null);
  chk("no devuelve teléfonos", !/telefono/i.test(J(r)));
  chk("nombres y placas", r.conductores.some((c) => c.nombre === "Tercero 5" && c.tercero) && r.unidades.some((u) => u.placa === "TER-12"));
  chk("constantes en la respuesta", r.constantes.length === X.CONSTANTES_EXCESOS.length);

  // Unir dos tandas ≡ el rango entero.
  const a = await D.excesosDelRango({ desde: "2026-10-05", hasta: "2026-10-07", umbral: 90 }, clienteFalso(tablas));
  const b = await D.excesosDelRango({ desde: "2026-10-08", hasta: "2026-10-10", umbral: 90 }, clienteFalso(tablas));
  const unida = X.unirRespuestasExcesos([b, a]);
  chk("unir dos tandas ≡ medir el rango entero", sinHora(unida) === sinHora(r));
  let solapa = false;
  try { X.unirRespuestasExcesos([a, a]); } catch { solapa = true; }
  chk("unir tandas que se solapan lanza", solapa);
  // fuera=0: se cuentan, no se listan.
  const v0 = X.vistaRespuesta(r, false);
  chk("vistaRespuesta(fuera=0): sin la lista, con el total", v0.resumen.fueraDeServicio.length === 0 && v0.resumen.fueraDeServicioTotal === r.resumen.fueraDeServicioTotal
    && !v0.incluyeFueraDeServicio && r.resumen.fueraDeServicio.length === r.resumen.fueraDeServicioTotal);
  chk("vistaRespuesta(fuera=1) devuelve todo", X.vistaRespuesta(r, true) === r);
  chk("unir una vista fuera=0 con una fuera=1 no afirma la lista completa", !X.unirRespuestasExcesos([X.vistaRespuesta(a, false), b]).incluyeFueraDeServicio);

  // PRIVACIDAD FUERA DE SERVICIO.
  // (a) ningún exceso fuera de servicio sale con más de 2 decimales en el pico (~1 km); los de servicio, exactos.
  // (b) con fuera=0, el directorio no nombra a nadie sin servicio ni exceso en servicio en la respuesta.
  const dosDecimales = (x: number) => Math.round(x * 100) / 100 === x && Number(x.toFixed(2)) === x;
  const picoAproximado = (rr: RespuestaExcesos) => rr.resumen.fueraDeServicio.every((e) => dosDecimales(e.latPico) && dosDecimales(e.lngPico));
  const nombraSoloEnServicio = (rr: RespuestaExcesos) => {
    const c = new Set<string>(), u = new Set<string>();
    for (const s of rr.servicios) { if (s.conductor) c.add(s.conductor); if (s.vehiculo) u.add(s.vehiculo); }
    for (const e of rr.episodios) { if (e.conductor) c.add(e.conductor); if (e.vehiculo) u.add(e.vehiculo); }
    return rr.conductores.every((x) => c.has(x.clave)) && rr.unidades.every((x) => u.has(x.clave));
  };
  const vistas = [r, unida, a, b, X.unirRespuestasExcesos([X.vistaRespuesta(a, false), b])];
  chk("(a) el lector, las tandas y su unión: todo pico fuera de servicio con ≤ 2 decimales", vistas.every(picoAproximado) && r.resumen.fueraDeServicio.length > 0,
    `${r.resumen.fueraDeServicio.length} fuera de servicio`);
  chk("(a) …y los de servicio salen con su posición exacta (alguno con más de 2 decimales)", r.episodios.some((e) => !dosDecimales(e.latPico) || !dosDecimales(e.lngPico)));
  chk("(b) el lector, las tandas y su unión con fuera=0: el directorio solo nombra a quien está en servicio",
    vistas.every((x) => nombraSoloEnServicio(X.vistaRespuesta(x, false))));
  chk("(b) …sin perder a nadie que sí esté en servicio", vistas.every((x) => {
    const v = X.vistaRespuesta(x, false);
    const enServ = (k: string) => x.servicios.some((s) => s.conductor === k) || x.episodios.some((e) => e.conductor === k);
    return x.conductores.filter((c) => enServ(c.clave)).length === v.conductores.length;
  }));
  // El caso hecho a mano: p:3 SOLO aparece por un exceso fuera de servicio (en un sitio exacto).
  const epi = (o: Partial<Episodio>): Episodio => ({
    codigo: "exceso", conductor: "p:1", vehiculo: "p:10", reservaId: 10, fueraDeServicio: false, inicioTs: T0 + 3_600_000, finTs: T0 + 3_660_000,
    durS: 60, puntos: 21, velMaxSensor: 104, velMediaSensor: 100, velGeom: 99, precisionMediana: 6, latPico: -12.0461234, lngPico: -77.0312987,
    cortado: false, detalle: "x", ...o,
  });
  const serv = (id: number, c: string, v: string): ServicioExpuesto => ({ ...r.servicios[0], reservaId: id, prestado: true, estado: "finalizada", conductor: c, vehiculo: v });
  const manual = X.armarRespuestaExcesos({
    desde: "2026-10-05", hasta: "2026-10-05", umbral: 90, medidoEn: null,
    episodios: [epi({}), epi({ conductor: "p:3", vehiculo: "p:30", reservaId: null, fueraDeServicio: true, inicioTs: T0 + 7_200_000, finTs: T0 + 7_260_000 })],
    servicios: [serv(10, "p:1", "p:10"), serv(11, "p:2", "p:20")],
    conductores: ["p:1", "p:2", "p:3"].map((k) => ({ clave: k, nombre: `C ${k}`, tercero: false, velocimetro: "con_velocimetro" as Velocimetro })),
    unidades: ["p:10", "p:20", "p:30"].map((k) => ({ clave: k, placa: `PL ${k}`, tercero: false })),
  });
  const fueraManual = manual.resumen.fueraDeServicio[0];
  chk("(a) a mano: el pico fuera de servicio sale redondeado a ~1 km (-12.05, -77.03)", fueraManual?.latPico === -12.05 && fueraManual?.lngPico === -77.03, J(fueraManual && [fueraManual.latPico, fueraManual.lngPico]));
  chk("(a) a mano: el de servicio, exacto", manual.episodios[0].latPico === -12.0461234 && manual.episodios[0].lngPico === -77.0312987);
  chk("(a) redondear es idempotente", J(X.conPicoAproximado(fueraManual)) === J(fueraManual));
  const m0 = X.vistaRespuesta(manual, false), m1 = X.vistaRespuesta(manual, true);
  chk("(b) a mano, fuera=0: p:3 y su unidad p:30 no se nombran; p:1, p:2 y sus unidades sí",
    J(m0.conductores.map((c) => c.clave)) === J(["p:1", "p:2"]) && J(m0.unidades.map((u) => u.clave)) === J(["p:10", "p:20"]) && nombraSoloEnServicio(m0));
  chk("(b) …pero se sigue contando el exceso fuera de servicio", m0.resumen.fueraDeServicioTotal === 1 && m0.resumen.fueraDeServicio.length === 0);
  chk("(b) a mano, fuera=1: p:3 sí se nombra (es a quien se lista)", m1 === manual && m1.conductores.some((c) => c.clave === "p:3") && m1.resumen.fueraDeServicio.length === 1);
  chk("(b) recortar el directorio no mueve el ranking", J(m0.resumen.porConductor) === J(manual.resumen.porConductor) && J(m0.resumen.totales) === J(manual.resumen.totales));

  // Falta solo fn_gps_velocimetro: se mide igual, todos «no se sabe», con aviso.
  const sinVel = await D.excesosDelRango({ desde, hasta, umbral: 90 }, clienteFalso(tablas, { errorRpc: { fn_gps_velocimetro: { code: "PGRST202", message: "Could not find the function public.fn_gps_velocimetro in the schema cache" } } }));
  chk("sin fn_gps_velocimetro: se mide, todos «no se sabe», y se avisa nombrando el SQL",
    sinVel.episodios.length === r.episodios.length && sinVel.conductores.every((c) => c.velocimetro === "no_se_sabe") && sinVel.avisos.some((x) => x.includes(X.MIGRACION_EXCESOS)));
  // Un día recortado se dice.
  const recortado = await D.excesosDelRango({ desde: "2026-10-05", hasta: "2026-10-05", umbral: 60 }, clienteFalso(tablas, { tope: 50 }));
  chk("un día recortado se dice", recortado.diasRecortados.some((d) => d.fecha === "2026-10-05"));
  // Una lectura de reservas que falla lanza (el ranking sin denominador mentiría).
  const rotas = clienteFalso(tablas);
  const fromOrig = rotas.from.bind(rotas);
  rotas.from = (t: string) => {
    const q = fromOrig(t);
    if (t !== "reservas") return q;
    q.then = (ok: any, ko: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, ko);
    return q;
  };
  let lanzoRes = false;
  try { await D.excesosDelRango({ desde, hasta, umbral: 90 }, rotas); } catch (e) { lanzoRes = e instanceof D.ErrorLecturaExcesos; }
  chk("si no se pueden leer los servicios, lanza (nunca un ranking sin denominador)", lanzoRes);
  // La respuesta vacía no es un 0.
  const vacia = X.respuestaVacia({ desde, hasta, umbral: 90, error: "x" });
  chk("respuestaVacia: total null, listas vacías, error", vacia.resumen.totales.excesos === null && vacia.episodios.length === 0 && vacia.error === "x");
}
{
  // Validación de la consulta.
  const hoy = "2026-10-12";
  const v = (q: Record<string, string | null>) => X.validarConsultaExcesos(q, hoy);
  const ok = v({});
  chk("sin parámetros: los últimos 7 días, umbral 90, sin fuera", ok.ok && ok.consulta.desde === "2026-10-06" && ok.consulta.hasta === hoy && ok.consulta.umbral === 90 && !ok.consulta.incluirFueraDeServicio);
  chk("8 días → error", !v({ desde: "2026-10-01", hasta: "2026-10-08" }).ok);
  chk("7 días → ok", v({ desde: "2026-10-01", hasta: "2026-10-07" }).ok);
  chk("futuro → error", !v({ desde: "2026-10-12", hasta: "2026-10-13" }).ok);
  chk("desde > hasta → error", !v({ desde: "2026-10-10", hasta: "2026-10-09" }).ok);
  chk("fecha que no existe → error", !v({ desde: "2026-02-30", hasta: "2026-03-01" }).ok);
  chk("umbral 59 / 131 / 90.5 / abc → error", ["59", "131", "90.5", "abc", "-90"].every((u) => !v({ umbral: u }).ok));
  chk("umbral 60 y 130 → ok", v({ umbral: "60" }).ok && v({ umbral: "130" }).ok);
  chk("umbral 93 → error que dice el paso y propone 90 o 95 (esquivar la caché variando el umbral)", (() => {
    const x = v({ umbral: "93" }); return !x.ok && /de 5 en 5/.test(x.error) && /90 o 95/.test(x.error);
  })(), (() => { const x = v({ umbral: "93" }); return x.ok ? "" : x.error; })());
  chk("umbral 95 → ok", (() => { const x = v({ umbral: "95" }); return x.ok && x.consulta.umbral === 95; })());
  chk("desde anterior a hoy − 90 días → error que nombra el límite", (() => {
    const x = v({ desde: X.sumarDias(hoy, -91), hasta: X.sumarDias(hoy, -88) }); return !x.ok && /90 días/.test(x.error) && x.error.includes(X.sumarDias(hoy, -90));
  })());
  chk("desde = hoy − 90 días → ok", v({ desde: X.sumarDias(hoy, -90), hasta: X.sumarDias(hoy, -84) }).ok);
  chk("los días atrás los decide quien llama (la ruta pasa DIAS_RASTREO)", !X.validarConsultaExcesos({ desde: X.sumarDias(hoy, -10), hasta: X.sumarDias(hoy, -9) }, hoy, 7).ok
    && X.validarConsultaExcesos({ desde: X.sumarDias(hoy, -10), hasta: X.sumarDias(hoy, -9) }, hoy, 10).ok);
  chk("fuera 1 → incluye; fuera 2 → error", (() => { const x = v({ fuera: "1" }); return x.ok && x.consulta.incluirFueraDeServicio && !v({ fuera: "2" }).ok; })());
  chk("los mensajes de error están en español", (() => { const x = v({ desde: "x" }); return !x.ok && /inválidas/.test(x.error); })());
  const t = X.tandasDeRango("2026-09-01", "2026-09-30");
  chk("tandasDeRango: un mes en tandas de ≤ 7 días, contiguas", t.length === 5 && t[0].desde === "2026-09-01" && t[0].hasta === "2026-09-07" && t[4].hasta === "2026-09-30"
    && t.every((x, i) => i === 0 || x.desde === X.sumarDias(t[i - 1].hasta, 1)) && t.every((x) => X.diasEntre(x.desde, x.hasta) < 7));
  chk("rangoLimaMs: el día de Lima es [05:00Z, 05:00Z del siguiente)", J(X.rangoLimaMs("2026-10-05", "2026-10-05")) === J({ desdeTs: T0, hastaTs: T0 + DIA }));
}

// ══ 6) Corolario ═══════════════════════════════════════════════════════════════════════════
seccion("6 · corolario");
{
  let detectado = true, casos = 0;
  for (let u = X.UMBRAL_MIN_KMH; u <= 95; u++) {
    for (const dtS of [1, 2, 3, 5, 10]) {
      const n = Math.round(60 / dtS) + 1;
      const eps = X.detectarExcesos(tramo({ n, dtS, kmh: 100, precision: 6, rumbo: rnd() * 360 }), u);
      casos++;
      if (eps.length !== 1 || eps[0].codigo !== "exceso" || Math.abs(eps[0].durS - 60) > 1e-9) { detectado = false; console.log(`   umbral ${u}, cada ${dtS} s: ${codigos(eps)}`); }
    }
  }
  chk("un bus a 100 km/h durante 60 s se detecta para todo umbral ≤ 95 y cadencia de 1 a 10 s", detectado, `${casos} casos`);
  chk("…y con el umbral por encima de su velocidad no hay episodio", X.detectarExcesos(tramo({ n: 21, kmh: 100 }), 101).length === 0);
}

// ══ 7) La ruta, de punta a punta, contra un Supabase falso por HTTP ═════════════════════════
// Usa el supabase-js DE VERDAD (así se prueba también que un 404 PGRST202 de PostgREST llega como
// «falta la función»): permiso del módulo, validación, `sin_migracion` y el error que NUNCA es un «0».
seccion("7 · la ruta /api/flota/excesos");
{
  const http = await import("node:http");
  let modoRpc: "falta" | "error" | "vacio" = "falta";
  const pedidas: string[] = [];
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      pedidas.push(`${req.method} ${req.url?.split("?")[0]}`);
      const json = (st: number, o: unknown) => { res.writeHead(st, { "content-type": "application/json" }); res.end(J(o)); };
      const auth = req.headers.authorization;
      if (req.url?.startsWith("/auth/v1/user")) {
        if (auth === "Bearer admin" || auth === "Bearer operador") return json(200, { id: auth === "Bearer admin" ? "u-admin" : "u-op", aud: "authenticated", role: "authenticated" });
        return json(401, { code: 401, msg: "invalid JWT" });
      }
      if (req.url?.startsWith("/rest/v1/usuarios")) {
        const o = { rol: req.url.includes("u-admin") ? "admin" : "operador", activo: true };
        return json(200, String(req.headers.accept).includes("pgrst.object") ? o : [o]);
      }
      if (req.url?.startsWith("/rest/v1/permisos_usuario")) return json(200, []);
      if (req.url?.startsWith("/rest/v1/rpc/fn_gps_puntos_rapidos")) {
        if (modoRpc === "vacio") return json(200, { puntos: [], recortado: false });
        return modoRpc === "falta"
          ? json(404, { code: "PGRST202", details: "Searched for the function public.fn_gps_puntos_rapidos", hint: null, message: "Could not find the function public.fn_gps_puntos_rapidos(p_desde, p_hasta, p_umbral) in the schema cache" })
          : json(500, { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" });
      }
      if (req.url?.startsWith("/rest/v1/reservas")) return json(200, []);
      json(404, { code: "PGRST205", message: "?" });
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const puerto = (srv.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${puerto}`;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  const { GET } = await import("../app/api/flota/excesos/route");
  const { NextRequest } = await import("next/server");
  const pedir = async (q: string, quien?: string) => {
    const r = await GET(new NextRequest(`http://localhost/api/flota/excesos${q}`, { headers: quien ? { authorization: `Bearer ${quien}` } : {} }));
    return { status: r.status, body: await r.json() as any };
  };
  // Las fechas van relativas a HOY: la ruta no acepta nada anterior a hoy − DIAS_RASTREO.
  const HOY = X.diaLima(Date.now());
  const dia = (n: number) => X.sumarDias(HOY, n);
  const R = `?desde=${dia(-7)}&hasta=${dia(-6)}`;
  const reloj = Date.now;
  try {
    chk("sin sesión → 401", (await pedir(R)).status === 401);
    const sinPermiso = await pedir(R, "operador");
    chk("sin el módulo monitoreo → 403", sinPermiso.status === 403 && /monitoreo/.test(sinPermiso.body.error));
    chk("más de 7 días → 400 con el motivo", (await pedir(`?desde=${dia(-11)}&hasta=${dia(-3)}`, "admin")).status === 400);
    chk("umbral fuera de 60..130 → 400", (await pedir(`${R}&umbral=50`, "admin")).status === 400);
    const u93 = await pedir(`${R}&umbral=93`, "admin");
    chk("umbral que no es múltiplo de 5 → 400 que dice el paso (la caché no se esquiva variando el umbral)", u93.status === 400 && /de 5 en 5/.test(u93.body.error), u93.body.error);
    const viejo = await pedir(`?desde=${dia(-91)}&hasta=${dia(-89)}`, "admin");
    chk("desde anterior a hoy − DIAS_RASTREO → 400 que nombra el límite", viejo.status === 400 && /90 días/.test(viejo.body.error), viejo.body.error);
    chk("en el futuro → 400", (await pedir("?desde=2099-01-01&hasta=2099-01-02", "admin")).status === 400);
    chk("…sin leer nada para rechazarlo", pedidas.every((x) => !x.includes("/rest/v1/rpc/")));
    const m = await pedir(`${R}&umbral=90`, "admin");
    chk("falta la función (404 PGRST202 de PostgREST) → 200 con sin_migracion, sin episodios",
      m.status === 200 && m.body.sin_migracion === X.MIGRACION_EXCESOS && m.body.episodios.length === 0 && m.body.resumen.totales.excesos === null && m.body.error === null);
    chk("…sin leer reservas ni nada más", pedidas.every((x) => !x.includes("/rest/v1/reservas")));
    modoRpc = "error";
    const e = await pedir(`${R}&umbral=90`, "admin");
    chk("sin migración NO se cachea: corrida la migración, la siguiente consulta ya mide", e.body.sin_migracion === null);
    chk("otro error → 200 con `error` en español, listas vacías y total null (nunca «0 excesos»)",
      e.status === 200 && /No se pudieron leer las posiciones/.test(e.body.error) && !/statement/.test(e.body.error)
      && e.body.episodios.length === 0 && e.body.resumen.totales.excesos === null, e.body.error);

    // El TTL lo decide el «hoy» del CÁLCULO: un rango que incluía hoy, medido a las 23:59, no se sirve
    // como cerrado pasada la medianoche (todavía le faltaba el final del día). Reloj simulado.
    modoRpc = "vacio";
    const medianoche = Date.parse(`${dia(1)}T05:00:00Z`);          // 00:00 de mañana en Lima
    let ahora = medianoche - 30_000;                               // 23:59:30 de hoy
    Date.now = () => ahora;
    const rpcs = () => pedidas.filter((x) => x.includes("/rpc/fn_gps_puntos_rapidos")).length;
    const RH = `?desde=${dia(-1)}&hasta=${dia(0)}&umbral=95`;
    const n0 = rpcs();
    const h1 = await pedir(RH, "admin");
    const n1 = rpcs();
    chk("medido a las 23:59:30 (el rango incluye hoy) → 200 y mide", h1.status === 200 && h1.body.error === null && n1 > n0, `${n1 - n0} lecturas`);
    await pedir(RH, "admin");
    chk("…al instante sale de la caché", rpcs() === n1);
    ahora = medianoche + 30_000;                                   // 00:00:30 de mañana
    const h2 = await pedir(RH, "admin");
    const n2 = rpcs();
    chk("pasada la medianoche NO se sirve lo medido como «hoy»: se vuelve a medir", h2.status === 200 && n2 > n1);
    ahora += 10 * 60_000;
    await pedir(RH, "admin");
    chk("medido ya cerrado → caché larga (10 min después sigue sirviéndose)", rpcs() === n2);
    ahora += 10 * 60_000;
    await pedir(RH, "admin");
    chk("…y vence a los 15 min", rpcs() > n2);
  } finally {
    Date.now = reloj;
    srv.close();
  }
}

console.log(`\n${fallos ? "❌" : "✅"} prueba-excesos: ${oks} ok, ${fallos} fallas`);
process.exit(fallos ? 1 : 0);
