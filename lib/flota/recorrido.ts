// lib/flota/recorrido.ts — MOTOR PURO. Lo que dibuja el mapa «Ver recorrido» de un servicio
// (/seguimiento/gps/[id]): EL MODAL GPS DE /seguimiento SIN LLAMADAS PAGADAS, y encima, en rojo, los
// tramos donde hubo exceso de velocidad.
//
// EL DEFECTO QUE CIERRA (lo reportó el dueño). La primera versión pintaba toda la traza de un solo
// azul y marcaba «22 tramos sin señal» como rectas grises que cruzaban manzanas. Dos fallos a la vez:
//   · el «sin señal» se definía SOLO por DISTANCIA (más de MAX_SEG_M = 300 m entre dos puntos),
//     mientras la celda RASTREO de /seguimiento lo define por TIEMPO (más de HUECO_MIN_S = 60 s sin
//     posición; corte si además el bus avanzó ≥ 500 m, lib/gps-cobertura.ts). A 100 km/h, 12 s sin
//     punto ya pasan de 300 m: el mapa acusaba «sin señal» donde la celda decía 100 %;
//   · el hueco se dibujaba como una RECTA entre sus dos extremos, o sea un recorrido que el bus no hizo.
// El modal GPS ya lo mostraba bien. Esto es el modal, armado en el servidor con las MISMAS funciones
// (extraídas a lib/huella.ts, lib/ruta-firma.ts y lib/servicio-tiempos.ts, sin reescribirlas):
//
//   · `medido`: la huella del modal (`huellaDeFilas` → `segmentosHuella`, la base de
//     `huellaCrudaFeatures`), coloreada por velocidad con su regla (el color de un segmento es el
//     promedio de sus dos vértices). SIN Map Matching (es una llamada pagada a Mapbox). Se corta
//     donde salta más de MAX_SEG_M y —DIVERGENCIA DECLARADA (a)— también donde hay un tramo «sin
//     señal» de la celda RASTREO, aunque sea de menos de 300 m: sin eso se dibujaría como «medido»
//     un tramo en el que no llegó señal. DIVERGENCIA DECLARADA (b): una cuerda que el suavizado
//     estiró por encima de MAX_SEG_M no se dibuja (el modal la dibujaría; casi nunca ocurre).
//   · `sinSenal`: EXACTAMENTE `medicion.tramos` (cabeza, huecos y cola) de `medirServicio`, la misma
//     llamada de la celda RASTREO: el número coincide por construcción. NUNCA se dibuja una recta en
//     un hueco: o lo cubre un tramo ESTIMADO validado (`estimado: true`), o solo se marcan sus dos
//     extremos (las posiciones de la traza en `desdeTs`/`hastaTs`).
//   · `estimados`: la FASE 1 de los puentes del modal (por la ruta prevista) más los puentes que el
//     modal ya pagó y guardó. Los dos se leen SOLO de `rutas_cache` (lo que el modal guardó, con
//     vigencia de 30 días): si no están, no hay tramo estimado y se dice (`rutaPrevista`). Solo
//     entran los que `validarPuente` aprobó.
//   · `puntos`: los puntitos de telemetría del modal (`puntosTelemetria`): hora, velocidad real o
//     aproximada, dirección y precisión. Sin dirección escrita: eso es geocodificación pagada.
//
// LOS EPISODIOS NO CAMBIAN. Son los de la columna «Excesos» de /uso-flota → Servicios
// (`episodiosDeTraza`, lib/flota/servicio-estadistica.ts) y por la localidad del motor los mismos que
// /seguridad-vial lista para esa reserva. Lo único nuevo es una ETIQUETA informativa (`contexto`):
// «antes del paradero 1 · sin pasajeros», etc. El dueño decidió que un exceso camino al paradero 1 se
// cuenta igual («podría traer multas»): la etiqueta no lo descuenta, solo lo ubica. Es tri-estado:
// sin el hecho que la respalda, `sin_dato`.
//
// LO QUE NO AFIRMA: sin velocímetro no hay rojo y no es «sin excesos» (`excesos.codigo` lo dice);
// un servicio que no salió no tiene traza (`no_aplica`); una traza que no se pudo leer tampoco
// (`sin_medir`). Sin medición de cobertura, los conteos de «sin señal» van en null, nunca en 0.
//
// NINGUNA LLAMADA A TERCEROS: este archivo ni su lector piden rutas, ajustes a la vía, vías cercanas
// ni direcciones a nadie (scripts/prueba-recorrido.mts, sección 5). La única llamada pagada que queda
// es la carga del mapa de Mapbox en la pantalla.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados: las filas de ubicaciones_gps, reservas y paradas y los payloads de rutas_cache llegan como `any` */
import {
  huellaDeFilas, segmentosHuella, calcularPuentes, fixesDelHueco, puentesPorRutaPrevista, MAX_PUENTES,
  puenteDeDirections, puenteEstimadoDeDirections, puntosTelemetria, distM, MAX_SEG_M,
  type HuellaPt, type PuenteHueco,
} from "../huella";
import { clavePuente, firmaRuta, paradasParaFirma, type SinRutaFirma } from "../ruta-firma";
import { hechosDeParadas, hhmmLima, type ReservaTiempos, type ParadaTiempos, type AbordajeTiempos } from "../servicio-tiempos";
import type { MedicionCobertura, PuntoCobertura, TramoSinRastreo, VeredictoRastreo } from "../gps-cobertura";
import { claveRacha, type Episodio, type PuntoVel } from "./excesos";
import { episodiosDeTraza, excesosDelServicio, type ExcesosServicio } from "./servicio-estadistica";

/** [lng, lat], como todo el ERP una vez que sale hacia Mapbox. */
export type Coord = [number, number];

// ── TOPES (operativos, NO medidos) ─────────────────────────────────────────────────────
// Ninguno sale de una medición: acotan el peso de la respuesta (scripts/prueba-recorrido.mts,
// sección 12, fija el peor caso) y lo que se omite se CUENTA, nunca desaparece en silencio.

/** Vértices del trazo medido. La huella de un servicio de dos horas son cientos de puntos; esto solo
 *  evita mandar decenas de miles si una reserva quedó abierta un día entero. Se decima conservando
 *  la velocidad de cada vértice que queda y los extremos de cada tramo. En el trazo medido cada tramo
 *  cuenta UN vértice más (`COSTO_TRAMO_MEDIDO`): su envoltura pesa lo que un vértice, y sin contarla
 *  una huella partida en miles de tramos de dos vértices pesaba un 40 % más que una continua. */
export const MAX_VERTICES_TRAZA = 5000;
/** Lo que cuenta la envoltura de cada tramo medido contra MAX_VERTICES_TRAZA (ver arriba). */
export const COSTO_TRAMO_MEDIDO = 1;
/** Vértices de los tramos estimados (a lo sumo MAX_PUENTES tramos, cada uno un pedazo de vía). */
export const MAX_VERTICES_ESTIMADO = 3000;
/** Puntitos de telemetría (uno cada ~100 m de recorrido): se muestrean con el primero y el último. */
export const MAX_PUNTOS_DATO = 1000;
/** Tramos «sin señal» que viajan (se quedan los más LARGOS por duración). Una traza sana tiene pocos;
 *  cientos solo salen de un teléfono que se apaga a cada rato, y dibujarlos todos no dice nada que no
 *  diga el conteo (`sinSenalTotal` es el total, con o sin tope). */
export const MAX_HUECOS = 500;
/** Posiciones por episodio (se muestrea conservando los extremos). A una posición cada pocos
 *  segundos, 300 son más de diez minutos seguidos sobre el umbral. */
export const MAX_COORDS_EPISODIO = 300;
/** Posiciones de TODOS los episodios juntos. Operativo, no medido. La LISTA de episodios no se topa
 *  (es la de la columna «Excesos»): lo que se recorta es su dibujo. Si se pasa, cada episodio se
 *  muestrea en proporción a su largo conservando sus dos extremos (`toparCoordsEpisodios`). Con más de
 *  MAX_COORDS_EPISODIOS_TOTAL / 2 episodios el total queda en 2 por episodio. */
export const MAX_COORDS_EPISODIOS_TOTAL = 3000;
/** Holgura entre relojes al ubicar un exceso respecto de un paradero. El exceso lleva la hora del
 *  TELÉFONO; la llegada al paradero y el abordaje, la del SERVIDOR. NO medido: el lado seguro es
 *  subirlo (más excesos quedan `sin_dato`, ninguno con una etiqueta falsa). */
export const MARGEN_RELOJ_ETIQUETA_MS = 2 * 60_000;
/** Decimales de las coordenadas que salen (~1 m, la misma precisión de la firma de rutas_cache).
 *  Las de los episodios NO se redondean: son las posiciones crudas que juzgó el motor. */
const DECIMALES_COORD = 5;

// ── CONTRATO ───────────────────────────────────────────────────────────────────────────

/** Un tramo continuo de la huella medida. `vel[i]` es la velocidad (km/h, entera) del vértice
 *  `coords[i]`; el color de un segmento es el promedio de sus dos vértices (`huellaCrudaFeatures`). */
export type TramoMedido = { coords: Coord[]; vel: number[] };

export type FuenteEstimado = "ruta_prevista" | "puente_guardado";

/** Un tramo ESTIMADO ya validado contra la evidencia GPS (`validarPuente`). `sinSenal`: cae (al menos
 *  en parte) sobre un tramo «sin señal» de RASTREO; si es false, rellena un salto de la huella que la
 *  celda no cuenta como corte (menos de 60 s sin posición). */
export type TramoEstimado = { coords: Coord[]; km: number; min: number; sinSenal: boolean; fuente: FuenteEstimado };

/** Un tramo de la ventana del servicio SIN posición útil: el MISMO de la celda RASTREO
 *  (`TramoSinRastreo`: tipo, horas, duración y si fue en movimiento, tal cual; `avanceM` en metros
 *  enteros), con las posiciones de la traza en sus dos bordes (null donde no hay posición: el inicio
 *  de la cabeza y el fin de la cola) y si un tramo estimado lo cubre entero. */
export type TramoSinSenal = TramoSinRastreo & { desde: Coord | null; hasta: Coord | null; estimado: boolean };

/** Un puntito de telemetría (`puntosTelemetria` del modal). `velReal`/`rumboReal` = vino del equipo;
 *  si no, es aproximado. Nunca se interpola una posición: cada puntito es una muestra real. */
export type PuntoDato = { c: Coord; ts: number; vel: number; velReal: boolean; rumbo: number; rumboReal: boolean; acc: number };

/** ¿Hay ruta prevista guardada para este servicio? Seis códigos, cada uno con su arreglo:
 *  `guardada` · `no_guardada` (nadie abrió el modal GPS en 30 días, o la ruta no tiene geometría) ·
 *  `mismo_punto` (primer y último paradero en el mismo sitio: el modal no pide ruta, y abrirlo no la guarda) ·
 *  `sin_paraderos` · `paraderos_sin_coordenadas` · `no_se_pudo_leer` (la consulta falló: nunca se
 *  lee como «no guardada»). */
export type CodigoRutaPrevista = "guardada" | "no_guardada" | "mismo_punto" | "sin_paraderos" | "paraderos_sin_coordenadas" | "no_se_pudo_leer";
export type EstadoRutaPrevista = { codigo: CodigoRutaPrevista; detalle: string };

/** Dónde ocurrió un exceso respecto del servicio. Informativo: no cambia el conteo. */
export type CodigoContexto = "antes_paradero_1" | "en_servicio_con_pasajeros" | "en_servicio" | "despues_ultimo_paradero" | "sin_dato";
export type ContextoExceso = { codigo: CodigoContexto; texto: string | null; motivo: string };

export const TEXTO_CONTEXTO: Record<Exclude<CodigoContexto, "sin_dato">, string> = {
  antes_paradero_1: "antes del paradero 1 · sin pasajeros",
  en_servicio_con_pasajeros: "en servicio · con pasajeros",
  en_servicio: "en servicio · después del paradero 1",
  despues_ultimo_paradero: "después del último paradero · sin pasajeros",
};

export type EpisodioMapa = {
  codigo: Episodio["codigo"];
  /** solo `exceso` cuenta; los demás se dibujan aparte y con su motivo */
  cuenta: boolean;
  inicioTs: number;
  finTs: number;
  durS: number;
  puntos: number;
  velMaxSensor: number;
  velMediaSensor: number;
  velGeom: number | null;
  precisionMediana: number | null;
  latPico: number;
  lngPico: number;
  cortado: boolean;
  detalle: string;
  /** las posiciones crudas de la racha, en orden; vacío si ninguna tiene coordenadas */
  coords: Coord[];
  /** dónde ocurrió respecto del servicio (informativo; no cambia el conteo) */
  contexto: ContextoExceso;
};

export type RecorridoServicio = {
  reservaId: number;
  umbral: number;
  /** la huella medida, en tramos continuos (cada uno con 2+ vértices), coloreable por velocidad */
  medido: TramoMedido[];
  /** los tramos estimados validados (ruta prevista o puente guardado) */
  estimados: TramoEstimado[];
  /** los tramos «sin señal» de la celda RASTREO (a lo sumo MAX_HUECOS, los más largos) */
  sinSenal: TramoSinSenal[];
  /** cuántos tramos «sin señal» tiene la medición (= medicion.tramos.length); null sin medición */
  sinSenalTotal: number | null;
  /** cortes con el bus en movimiento (= medicion.cortes); null sin medición */
  cortesEnMovimiento: number | null;
  /** km recorridos sin señal en esos cortes (= medicion.kmACiegas); null sin medición */
  kmACiegas: number | null;
  /** puntitos de telemetría (a lo sumo MAX_PUNTOS_DATO) */
  puntos: PuntoDato[];
  /** cuántos puntitos había antes del muestreo */
  puntosTotal: number;
  /** el veredicto de la celda RASTREO de este servicio, tal cual */
  rastreo: VeredictoRastreo;
  rutaPrevista: EstadoRutaPrevista;
  /** cuántas posiciones llegaron (crudas, con coordenadas) */
  posiciones: number;
  primeraTs: number | null;
  ultimaTs: number | null;
  /** se decimó el trazo medido para no pasar de MAX_VERTICES_TRAZA */
  medidoDecimado: boolean;
  /** tramos medidos que no caben ni con solo sus extremos (los más cortos): no se dibujan */
  medidoOmitidos: number;
  /** se decimaron los tramos estimados para no pasar de MAX_VERTICES_ESTIMADO */
  estimadosDecimados: boolean;
  /** tramos estimados que no caben ni con solo sus extremos (los más cortos): no se dibujan */
  estimadosOmitidos: number;
  /** tramos «sin señal» que pasan de MAX_HUECOS (los más cortos): no se dibujan, sí se cuentan */
  sinSenalOmitidos: number;
  /** las posiciones de los episodios se muestrearon para no pasar de MAX_COORDS_EPISODIOS_TOTAL
   *  (la lista, el conteo y los demás campos de cada episodio no cambian) */
  episodiosCoordsDecimadas: boolean;
  /** el resumen: el MISMO de la columna «Excesos» de /uso-flota → Servicios */
  excesos: ExcesosServicio;
  /** todos los episodios (los que cuentan y los descartados), por hora de inicio */
  episodios: EpisodioMapa[];
};

// ── UTILIDADES ─────────────────────────────────────────────────────────────────────────

const finito = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const coordValida = (lat: number, lng: number) =>
  finito(lat) && finito(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const POT = 10 ** DECIMALES_COORD;
const red = (x: number) => Math.round(x * POT) / POT;
/** [lng, lat] redondeado a DECIMALES_COORD. */
export const coordR = (lng: number, lat: number): Coord => [red(lng), red(lat)];

/** `n` elementos repartidos a lo largo de `xs`, con el primero y el último siempre dentro. */
export function muestrear<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  if (n <= 1) return xs.slice(0, Math.max(0, n));
  return Array.from({ length: n }, (_, k) => xs[Math.round((k * (xs.length - 1)) / (n - 1))]);
}

const largoM = (t: readonly Coord[]) => {
  let m = 0;
  for (let i = 1; i < t.length; i++) m += distM(t[i - 1][1], t[i - 1][0], t[i][1], t[i][0]);
  return m;
};

/**
 * El PLAN de decimado de varias líneas para no pasar de `max` vértices en total: para cada línea, los
 * índices que se quedan (null = la línea no se dibuja). Conserva los extremos de cada línea. Es un
 * TOPE DURO: si ni con solo los extremos caben (cientos de tramos cortos), se quedan las líneas más
 * LARGAS en metros, en su orden, y el resto se cuenta en `omitidos`. Sin pasar del tope, todo intacto.
 * Lo aplican la huella (que arrastra la velocidad de cada vértice) y los estimados. `costoLinea`: lo
 * que cuenta además cada línea (su envoltura); 0 = solo vértices, como `decimarTramos`.
 */
export function planDecimado(
  largos: readonly number[], metros: readonly number[], max: number, costoLinea = 0,
): { indices: (number[] | null)[]; decimada: boolean; omitidos: number } {
  const total = largos.reduce((a, n) => a + n + costoLinea, 0);
  const todos = (n: number) => Array.from({ length: n }, (_, i) => i);
  if (total <= max) return { indices: largos.map(todos), decimada: false, omitidos: 0 };
  const masLargo = largos.reduce((acc, n) => Math.max(acc, n), 0);
  const decimar = (paso: number) => largos.map((n) => todos(n).filter((i) => i === 0 || i === n - 1 || i % paso === 0));
  const contar = (xs: number[][]) => xs.reduce((a, t) => a + t.length + costoLinea, 0);
  let paso = Math.max(2, Math.ceil(total / max));
  let out = decimar(paso);
  // Los extremos no se deciman: con muchas líneas el primer paso no basta. Se agranda hasta que cada
  // línea quede en sus dos extremos.
  while (contar(out) > max && paso < masLargo) {
    paso += Math.max(1, Math.floor(paso / 4));
    out = decimar(paso);
  }
  if (contar(out) <= max) return { indices: out, decimada: true, omitidos: 0 };
  // Ni con solo los extremos: se quedan las líneas más largas, en su orden original.
  const orden = out.map((_, i) => ({ i, m: metros[i] ?? 0 })).sort((a, b) => b.m - a.m || a.i - b.i);
  const quedan = new Set<number>();
  let usados = 0;
  for (const { i } of orden) {
    if (usados + out[i].length + costoLinea > max) continue;
    quedan.add(i);
    usados += out[i].length + costoLinea;
  }
  return { indices: out.map((ix, i) => (quedan.has(i) ? ix : null)), decimada: true, omitidos: out.length - quedan.size };
}

/**
 * Decima tramos de coordenadas (el plan de `planDecimado` aplicado a cada uno). Sin pasar del tope
 * devuelve los mismos tramos, sin tocar.
 */
export function decimarTramos(tramos: Coord[][], max = MAX_VERTICES_TRAZA): { tramos: Coord[][]; decimada: boolean; omitidos: number } {
  const plan = planDecimado(tramos.map((t) => t.length), tramos.map(largoM), max);
  if (!plan.decimada) return { tramos, decimada: false, omitidos: 0 };
  const out: Coord[][] = [];
  plan.indices.forEach((ix, k) => { if (ix) out.push(ix.map((i) => tramos[k][i])); });
  return { tramos: out, decimada: true, omitidos: plan.omitidos };
}

/** La posición de la traza en el instante `ts` EXACTO (los bordes de un tramo «sin señal» son
 *  posiciones de la traza), o null si no hay ninguna en ese instante. `pts` en orden ascendente; con
 *  varias en el mismo instante, `cual` dice si se toma la primera o la última (el borde inicial de un
 *  hueco es la ÚLTIMA antes de él; el final, la PRIMERA después). */
export function posicionEnTs(pts: readonly PuntoCobertura[] | null | undefined, ts: number, cual: "primero" | "ultimo" = "primero"): Coord | null {
  if (!pts || !pts.length || !finito(ts)) return null;
  let lo = 0, hi = pts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].ts < ts) lo = m + 1; else hi = m; }
  if (lo >= pts.length || pts[lo].ts !== ts) return null;
  if (cual === "ultimo") while (lo + 1 < pts.length && pts[lo + 1].ts === ts) lo++;
  const p = pts[lo];
  return coordValida(p.lat, p.lng) ? coordR(p.lng, p.lat) : null;
}

/**
 * El corte EXTRA de la huella (DIVERGENCIA DECLARADA (a)): ¿el segmento a→b pasa por un tramo «sin
 * señal» de RASTREO? Sí si el intervalo abierto (a.ts, b.ts) se solapa con alguno. Sin hora fiable en
 * algún extremo no se puede saber y no se corta (queda el corte por distancia de siempre). Los tramos
 * de `medirCobertura` vienen en orden y sin solaparse: se busca por bisección.
 */
export function cortaPorSinSenal(tramos: readonly { desdeTs: number; hastaTs: number }[] | null | undefined) {
  const ts = [...(tramos || [])].filter((t) => finito(t.desdeTs) && finito(t.hastaTs)).sort((a, b) => a.desdeTs - b.desdeTs);
  return (a: { ts: number }, b: { ts: number }): boolean => {
    if (!ts.length || !(a.ts > 0) || !(b.ts > 0)) return false;
    const lo = Math.min(a.ts, b.ts), hi = Math.max(a.ts, b.ts);
    // el primer tramo que termina después de `lo`
    let i = 0, j = ts.length;
    while (i < j) { const m = (i + j) >> 1; if (ts[m].hastaTs <= lo) i = m + 1; else j = m; }
    return i < ts.length && ts[i].desdeTs < hi;
  };
}

// ── LA HUELLA MEDIDA ───────────────────────────────────────────────────────────────────

/** Un tramo medido con la hora de cada vértice (solo para la matriz: la respuesta no la lleva). */
export type TramoMedidoTs = TramoMedido & { ts: number[] };

/**
 * La huella medida del modal (`segmentosHuella` sobre la huella LIMPIA, omitiendo la cuerda cruda
 * larga como hace `huellaCrudaFeatures`), cortada además en cada tramo «sin señal», en tramos
 * continuos con la velocidad de cada vértice. Coordenadas redondeadas a DECIMALES_COORD.
 */
export function medidoDeHuella(limpio: readonly HuellaPt[], sinSenal: readonly { desdeTs: number; hastaTs: number }[] | null | undefined): TramoMedidoTs[] {
  const segs = segmentosHuella([...limpio], MAX_SEG_M, true, cortaPorSinSenal(sinSenal));
  const out: TramoMedidoTs[] = [];
  let actual: TramoMedidoTs | null = null;
  let ultimoB: unknown = null, ultimoTramo = -1;
  const cerrar = () => { if (actual && actual.coords.length >= 2) out.push(actual); actual = null; };
  for (const s of segs) {
    if (!coordValida(s.a.lat, s.a.lng) || !coordValida(s.b.lat, s.b.lng)) { cerrar(); ultimoB = null; continue; }
    const a = coordR(s.a.lng, s.a.lat), b = coordR(s.b.lng, s.b.lat);
    // DIVERGENCIA (b): una cuerda que el suavizado estiró por encima de MAX_SEG_M no se dibuja.
    if (distM(a[1], a[0], b[1], b[0]) > MAX_SEG_M) { cerrar(); ultimoB = null; continue; }
    if (!actual || s.tramo !== ultimoTramo || s.a !== ultimoB) {
      cerrar();
      actual = { coords: [a], vel: [Math.round(s.a.velocidad ?? 0)], ts: [s.a.ts] };
    }
    actual!.coords.push(b);
    actual!.vel.push(Math.round(s.b.velocidad ?? 0));
    actual!.ts.push(s.b.ts);
    ultimoB = s.b; ultimoTramo = s.tramo;
  }
  cerrar();
  return out;
}

// ── LOS TRAMOS ESTIMADOS ───────────────────────────────────────────────────────────────

/** Un estimado con su evidencia (para la matriz y para saber qué hueco cubre). `crudas`: la
 *  geometría tal cual la aprobó `validarPuente`, antes de redondear. */
export type EstimadoInterno = TramoEstimado & { desdeTs: number; hastaTs: number; crudas: Coord[]; cand: PuenteHueco; fixes: { lat: number; lng: number }[] };

/**
 * Los candidatos a puente de la huella limpia, como los arma el modal (`calcularPuentes`, hasta
 * MAX_PUENTES). El modal pone antes las corridas crudas del Map Matching; aquí no hay Map Matching,
 * así que solo hay huecos.
 */
export function candidatosPuente(limpio: readonly HuellaPt[]): PuenteHueco[] {
  return calcularPuentes([...limpio]).slice(0, MAX_PUENTES);
}

/** Las claves de `rutas_cache` de los puentes que el modal pudo haber guardado para esta huella. */
export function clavesPuentes(crudas: any[] | null | undefined): string[] {
  if (!crudas || !crudas.length) return [];
  const { limpio } = huellaDeFilas(crudas);
  return candidatosPuente(limpio).map((c) => clavePuente(c.aLat, c.aLng, c.bLat, c.bLng));
}

/**
 * Los tramos estimados: FASE 1 del modal (`puentesPorRutaPrevista`, por la ruta prevista guardada) y,
 * para los candidatos que el modal mandaba a Google, el puente que guardó en `rutas_cache` (si está):
 * `puenteDeDirections` + `puenteEstimadoDeDirections`, que solo lo aprueba si `validarPuente` lo
 * acepta. Sin ruta ni puentes guardados, ninguno: no se paga nada para inventarlos.
 */
export function estimadosDeHuella(
  h: { limpio: readonly HuellaPt[]; crudos: readonly HuellaPt[] },
  ruta: readonly [number, number][] | null | undefined,
  puentesGuardados: ReadonlyMap<string, any> | null | undefined,
): EstimadoInterno[] {
  const cands = candidatosPuente(h.limpio);
  if (!cands.length) return [];
  const fixes = cands.map((c) => fixesDelHueco(h.limpio, h.crudos, c));
  const fase1 = puentesPorRutaPrevista(cands, fixes, ruta ? ruta.map((c) => [c[0], c[1]] as [number, number]) : null);
  const out: EstimadoInterno[] = [];
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    let p = fase1.slots[ci];
    let fuente: FuenteEstimado = "ruta_prevista";
    if (!p && puentesGuardados) {
      const j = puentesGuardados.get(clavePuente(c.aLat, c.aLng, c.bLat, c.bLng));
      if (j != null) {
        p = puenteEstimadoDeDirections(puenteDeDirections(j, c), c, fixes[ci]);
        fuente = "puente_guardado";
      }
    }
    if (!p) continue;
    out.push({
      coords: [], km: p.km, min: p.min, sinSenal: false, fuente,
      desdeTs: h.limpio[c.iA]?.ts ?? 0, hastaTs: h.limpio[c.iB]?.ts ?? 0,
      crudas: p.coords.map((x) => [x[0], x[1]] as Coord), cand: c, fixes: fixes[ci],
    });
  }
  return out;
}

/** Redondea y quita los vértices repetidos seguidos que deja el redondeo. */
function redondearLinea(cs: readonly Coord[]): Coord[] {
  const out: Coord[] = [];
  for (const c of cs) {
    if (!finito(c[0]) || !finito(c[1])) continue;
    const r = coordR(c[0], c[1]);
    const l = out[out.length - 1];
    if (!l || l[0] !== r[0] || l[1] !== r[1]) out.push(r);
  }
  return out;
}

// ── LOS TRAMOS SIN SEÑAL ───────────────────────────────────────────────────────────────

/** Topa los tramos «sin señal» a `max`: se quedan los más LARGOS (duración), en su orden original. */
export function toparSinSenal<T extends { durS: number }>(tramos: readonly T[], max = MAX_HUECOS): { tramos: T[]; omitidos: number } {
  if (tramos.length <= max) return { tramos: [...tramos], omitidos: 0 };
  const quedan = new Set(
    tramos.map((t, i) => ({ i, d: t.durS })).sort((a, b) => b.d - a.d || a.i - b.i).slice(0, max).map((x) => x.i),
  );
  return { tramos: tramos.filter((_, i) => quedan.has(i)), omitidos: tramos.length - max };
}

const solapa = (a0: number, a1: number, b0: number, b1: number) => Math.max(a0, b0) < Math.min(a1, b1);

// ── LA RUTA PREVISTA GUARDADA ──────────────────────────────────────────────────────────

/** Una clave con que el modal pudo haber guardado la ruta prevista de este servicio. */
export type VarianteRuta = { firma: string; conParadasJson: boolean; sinCoordenadas: number };
export type ClavesRuta = { variantes: VarianteRuta[]; sinRuta: SinRutaFirma | null; sinCoordenadas: number };

/**
 * Las claves de `rutas_cache` con que el modal GPS guarda la ruta prevista de este servicio, por el
 * MISMO camino (`paradasParaFirma` → `firmaRuta`). `paradas` como las lee /seguimiento (por `orden`
 * y `id`) y `extremos` como se los pasa al modal (nombre de la primera y de la última parada, o el
 * origen/destino de la reserva). /seguimiento NO le pasa `paradas_json` al modal; otras pantallas sí:
 * si falta alguna coordenada se prueba también la variante rellenada desde `paradas_json`. Las
 * paradas sin coordenadas NO se geocodifican (es una llamada pagada): con faltantes, la clave es la
 * del modal solo si Google tampoco las encontró. Primero las variantes sin faltantes (clave segura).
 */
export function clavesRutaPrevista(
  paradas: readonly any[] | null | undefined,
  paradasJson: readonly any[] | null | undefined,
  extremos: { origen?: string | null; destino?: string | null } | null | undefined,
): ClavesRuta {
  const a = paradasParaFirma(paradas, null, extremos);
  const variantes: VarianteRuta[] = [];
  if (a.sinRuta === null) variantes.push({ firma: firmaRuta(a.lista), conParadasJson: false, sinCoordenadas: a.sinCoordenadas });
  let sinRuta: SinRutaFirma | null = a.sinRuta, sinCoordenadas = a.sinCoordenadas;
  if ((a.sinRuta !== null || a.sinCoordenadas > 0) && Array.isArray(paradasJson) && paradasJson.length > 0) {
    const b = paradasParaFirma(paradas, paradasJson, extremos);
    if (b.sinRuta === null) {
      const f = firmaRuta(b.lista);
      if (!variantes.some((v) => v.firma === f)) variantes.push({ firma: f, conParadasJson: true, sinCoordenadas: b.sinCoordenadas });
    }
    // El motivo más informativo: «sin paradas» solo si ninguna de las dos encontró paradas.
    if (sinRuta === "sin_paradas" || b.sinRuta === null) sinRuta = b.sinRuta ?? sinRuta;
    sinCoordenadas = Math.min(sinCoordenadas, b.sinCoordenadas);
  }
  variantes.sort((x, y) => x.sinCoordenadas - y.sinCoordenadas);
  return { variantes, sinRuta: variantes.length ? null : sinRuta, sinCoordenadas };
}

/** La polilínea de un payload de /api/ruta guardado, solo si es utilizable ([lng, lat] finitos, 2+). */
function coordenadasDe(payload: any): [number, number][] | null {
  const cs = payload?.coordenadas;
  if (!Array.isArray(cs)) return null;
  const ok = cs.filter((c: any) => Array.isArray(c) && finito(c[0]) && finito(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180)
    .map((c: any) => [c[0], c[1]] as [number, number]);
  return ok.length >= 2 ? ok : null;
}

/**
 * El estado de la ruta prevista a partir de sus claves y de lo leído de `rutas_cache` (`null` = la
 * consulta falló: `no_se_pudo_leer`, nunca «no guardada»). Devuelve también la polilínea para la
 * FASE 1 de los puentes. Los motivos que no dependen de la consulta (sin paraderos, sin coordenadas)
 * se dicen aunque la consulta haya fallado.
 */
export function resolverRutaPrevista(claves: ClavesRuta, mapa: ReadonlyMap<string, any> | null): { estado: EstadoRutaPrevista; ruta: [number, number][] | null } {
  const ninguna = (estado: EstadoRutaPrevista) => ({ estado, ruta: null });
  if (!claves.variantes.length) {
    if (claves.sinRuta === "sin_paradas") {
      return ninguna({ codigo: "sin_paraderos", detalle: "El servicio no tiene paraderos ni origen y destino: no hay ruta prevista. Los paraderos se agregan en Programación." });
    }
    if (claves.sinRuta === "mismo_punto") {
      return ninguna({ codigo: "mismo_punto", detalle: "El primer y el último paradero están en el mismo punto: el modal GPS no pide ruta prevista para este servicio. Se revisa en Programación." });
    }
    return ninguna({
      codigo: "paraderos_sin_coordenadas",
      detalle: `Menos de dos paraderos tienen coordenadas${claves.sinCoordenadas ? ` (${claves.sinCoordenadas} sin ubicar)` : ""}: no hay ruta prevista guardada que leer. Se completan en Programación.`,
    });
  }
  if (!mapa) {
    return ninguna({ codigo: "no_se_pudo_leer", detalle: "No se pudo leer la ruta prevista guardada (ni los tramos estimados): no se afirma que no exista. Vuelve a intentarlo en unos minutos." });
  }
  for (const v of claves.variantes) {
    if (!mapa.has(v.firma)) continue;
    const ruta = coordenadasDe(mapa.get(v.firma));
    if (!ruta) continue;
    return {
      estado: {
        codigo: "guardada",
        detalle: `Ruta prevista guardada por el modal GPS (${ruta.length} puntos)${v.conParadasJson ? ", con las coordenadas de la cotización" : ""}${v.sinCoordenadas ? `; ${v.sinCoordenadas} paradero(s) sin coordenadas quedaron fuera` : ""}.`,
      },
      ruta,
    };
  }
  const minFaltan = Math.min(...claves.variantes.map((v) => v.sinCoordenadas));
  if (minFaltan > 0) {
    return ninguna({
      codigo: "paraderos_sin_coordenadas",
      detalle: `${minFaltan} paradero(s) sin coordenadas: el modal GPS los ubica con Google al abrirse y la ruta que guardó no se puede encontrar sin repetir esa consulta. Se completan en Programación.`,
    });
  }
  return ninguna({
    codigo: "no_guardada",
    detalle: "No hay ruta prevista guardada: nadie abrió el modal GPS de este servicio en los últimos 30 días. Sin ella, los huecos sin señal solo se marcan en sus dos extremos.",
  });
}

// ── LA ETIQUETA DE CADA EXCESO ─────────────────────────────────────────────────────────

/** Los hechos del servicio con que se ubica un exceso. Tri-estado: null = no se sabe. */
export type HechosContexto = {
  /** llegada marcada al paradero de menor `orden`, dentro de la ventana de sanidad; null si no */
  paradero1: { ts: number; nombre: string | null } | null;
  /** por qué no hay paradero 1 */
  paradero1Falta: string | null;
  /** fin del servicio: llegada marcada al ÚLTIMO paradero, o el «Finalizar» del conductor */
  fin: { ts: number; por: "ultimo_paradero" | "cierre"; nombre: string | null } | null;
  /** horas de abordaje de ESTE servicio (regla de pertenencia de derivarTiempos), en orden;
   *  null = no se pudieron leer */
  abordajesTs: number[] | null;
};

/**
 * Los hechos de `hechosDeParadas` (lib/servicio-tiempos.ts, la misma ventana de sanidad y la misma
 * regla de pertenencia de los abordajes que `derivarTiempos`) que ubican un exceso. `abordajes` null
 * = no se pudieron leer (no es «sin abordajes»). `cierreTs`: el punto `finalizado` de la traza.
 */
export function hechosDelServicio(e: {
  reserva: ReservaTiempos;
  paradas: readonly ParadaTiempos[] | null | undefined;
  abordajes: readonly AbordajeTiempos[] | null;
  ahoraMs: number;
  cierreTs?: number | null;
}): HechosContexto {
  const h = hechosDeParadas({ reserva: e.reserva, paradas: [...(e.paradas || [])], abordajes: [...(e.abordajes || [])], ahoraMs: e.ahoraMs });
  const p1 = h.paradas[0];
  let paradero1: HechosContexto["paradero1"] = null, paradero1Falta: string | null = null;
  if (!p1) paradero1Falta = "el servicio no tiene paraderos";
  else if (!p1.completada) paradero1Falta = "el paradero 1 no está marcado como llegado";
  else if (p1.llegadaTs == null) paradero1Falta = "el paradero 1 no tiene una hora de llegada creíble";
  else paradero1 = { ts: p1.llegadaTs, nombre: p1.nombre ?? null };
  const ultimo = h.paradas[h.paradas.length - 1];
  let fin: HechosContexto["fin"] = null;
  if (ultimo && ultimo.completada && ultimo.llegadaTs != null) fin = { ts: ultimo.llegadaTs, por: "ultimo_paradero", nombre: ultimo.nombre ?? null };
  else if (finito(e.cierreTs) && e.cierreTs > 0) fin = { ts: e.cierreTs, por: "cierre", nombre: null };
  return { paradero1, paradero1Falta, fin, abordajesTs: e.abordajes == null ? null : [...h.abordajesTs] };
}

const conNombre = (n: string | null | undefined) => (n ? ` (${n})` : "");

/**
 * Dónde ocurrió un exceso respecto del servicio. TRI-ESTADO: ninguna afirmación sin su hecho.
 *   · `antes_paradero_1`: el exceso TERMINA antes de la llegada al paradero 1 (menos el margen) y no
 *     hay abordaje registrado hasta el fin del exceso.
 *   · `en_servicio_con_pasajeros` / `en_servicio`: cae entre el paradero 1 y el fin del servicio
 *     (con el margen a los dos lados); con o sin un abordaje registrado antes de que empiece.
 *   · `despues_ultimo_paradero`: EMPIEZA después del fin del servicio (más el margen).
 *   · `sin_dato`: falta un hecho, el exceso cae dentro del margen de un límite, los hechos se
 *     contradicen o un abordaje contradice la etiqueta.
 * El margen es MARGEN_RELOJ_ETIQUETA_MS: el exceso lleva la hora del teléfono.
 */
export function contextoDeExceso(ep: { inicioTs: number; finTs: number }, h: HechosContexto | null | undefined): ContextoExceso {
  const M = MARGEN_RELOJ_ETIQUETA_MS;
  const sinDato = (motivo: string): ContextoExceso => ({ codigo: "sin_dato", texto: null, motivo });
  if (!h) return sinDato("No se leyeron los hechos del servicio (paraderos y abordajes).");
  if (!finito(ep.inicioTs) || !finito(ep.finTs)) return sinDato("El exceso no tiene hora.");
  const hh = hhmmLima;
  const p1 = h.paradero1?.ts ?? null, fin = h.fin?.ts ?? null;
  const antes = p1 != null && ep.finTs < p1 - M;
  const despues = fin != null && ep.inicioTs > fin + M;
  const enServ = p1 != null && fin != null && ep.inicioTs > p1 + M && ep.finTs < fin - M;
  const n = (antes ? 1 : 0) + (despues ? 1 : 0) + (enServ ? 1 : 0);
  if (n > 1) return sinDato("Los hechos del servicio se contradicen (el fin es anterior a la llegada al paradero 1): no se ubica el exceso.");
  if (n === 0) {
    const partes: string[] = [];
    if (p1 == null) partes.push(`falta la llegada al paradero 1 (${h.paradero1Falta ?? "sin dato"})`);
    else if (ep.inicioTs <= p1 + M && ep.finTs >= p1 - M) partes.push(`el exceso cruza la llegada al paradero 1 (${hh(p1)}) o queda a menos de ${M / 60_000} min de ella`);
    if (fin == null) partes.push("falta el fin del servicio (llegada al último paradero o «Finalizar»)");
    else if (ep.inicioTs <= fin + M && ep.finTs >= fin - M) partes.push(`el exceso cruza el fin del servicio (${hh(fin)}) o queda a menos de ${M / 60_000} min de él`);
    return sinDato(`No se ubica el exceso: ${partes.length ? partes.join("; ") : "no hay hechos suficientes"}.`);
  }
  const ab = h.abordajesTs;
  if (antes) {
    if (ab == null) return sinDato("No se pudieron leer los abordajes: no se afirma que fuera sin pasajeros.");
    const contra = ab.find((a) => a <= ep.finTs + M);
    if (contra != null) return sinDato(`Hay un abordaje registrado a las ${hh(contra)}, antes de que terminara el exceso: no se afirma que fuera sin pasajeros.`);
    return {
      codigo: "antes_paradero_1", texto: TEXTO_CONTEXTO.antes_paradero_1,
      motivo: `Terminó a las ${hh(ep.finTs)}; llegó al paradero 1${conNombre(h.paradero1?.nombre)} a las ${hh(p1!)} y no hay abordajes registrados antes.`,
    };
  }
  if (despues) {
    const contra = ab?.find((a) => a > fin! + M);
    if (contra != null) return sinDato(`Hay un abordaje registrado a las ${hh(contra)}, después del fin del servicio: no se afirma que fuera sin pasajeros.`);
    const finTxt = h.fin!.por === "ultimo_paradero"
      ? `llegó al último paradero${conNombre(h.fin!.nombre)} a las ${hh(fin!)}`
      : `el conductor finalizó el servicio a las ${hh(fin!)}`;
    return { codigo: "despues_ultimo_paradero", texto: TEXTO_CONTEXTO.despues_ultimo_paradero, motivo: `Empezó a las ${hh(ep.inicioTs)}; ${finTxt}.` };
  }
  // en servicio
  if (ab == null) return sinDato("No se pudieron leer los abordajes: no se afirma si llevaba pasajeros.");
  const a0 = ab.length ? ab[0] : null;
  const base = `entre la llegada al paradero 1 (${hh(p1!)}) y el fin del servicio (${hh(fin!)})`;
  if (a0 != null && a0 < ep.inicioTs - M) {
    return { codigo: "en_servicio_con_pasajeros", texto: TEXTO_CONTEXTO.en_servicio_con_pasajeros, motivo: `Ocurrió ${base}; el primer abordaje se registró a las ${hh(a0)}.` };
  }
  if (a0 == null || a0 > ep.inicioTs + M) {
    return { codigo: "en_servicio", texto: TEXTO_CONTEXTO.en_servicio, motivo: `Ocurrió ${base}; no hay abordajes registrados antes de que empezara.` };
  }
  return sinDato(`El primer abordaje (${hh(a0)}) queda a menos de ${M / 60_000} min del inicio del exceso: no se afirma si llevaba pasajeros.`);
}

// ── EL RECORRIDO ───────────────────────────────────────────────────────────────────────

/** La clave de racha de un episodio: la misma que `claveRacha` le dio a sus puntos. */
function claveDeEpisodio(ep: Episodio): string | null {
  return claveRacha({
    ts: ep.inicioTs, lat: ep.latPico, lng: ep.lngPico, velocidad: ep.velMaxSensor, precisionM: ep.precisionMediana,
    reservaId: ep.reservaId, conductor: ep.conductor, vehiculo: ep.vehiculo, simulado: null,
  });
}

/** Las posiciones crudas de la racha de un episodio: misma clave de racha y dentro de [inicio, fin]. */
export function coordsDeEpisodio(puntos: readonly PuntoVel[], ep: Episodio): Coord[] {
  const clave = claveDeEpisodio(ep);
  return puntos
    .filter((p) => p.ts >= ep.inicioTs && p.ts <= ep.finTs && claveRacha(p) === clave && coordValida(p.lat, p.lng))
    .sort((a, b) => a.ts - b.ts)
    .map((p) => [p.lng, p.lat] as Coord);
}

/**
 * Topa las posiciones de TODOS los episodios a `max` sin tocar la lista ni ningún otro campo: cada uno
 * conserva sus dos extremos (o las que tenga, si son menos) y el resto del cupo se reparte en
 * proporción a lo que le sobra a cada uno, muestreado con `muestrear`. Total ≤ max(max, 2 × episodios).
 */
export function toparCoordsEpisodios<T extends { coords: Coord[] }>(eps: readonly T[], max = MAX_COORDS_EPISODIOS_TOTAL): { episodios: T[]; decimadas: boolean } {
  const total = eps.reduce((a, e) => a + e.coords.length, 0);
  if (total <= max) return { episodios: [...eps], decimadas: false };
  const base = eps.map((e) => Math.min(e.coords.length, 2));
  const resto = Math.max(0, max - base.reduce((a, b) => a + b, 0));
  const sobra = eps.reduce((a, e, i) => a + (e.coords.length - base[i]), 0);
  return {
    episodios: eps.map((e, i) => {
      const n = Math.min(e.coords.length, base[i] + (sobra > 0 ? Math.floor(((e.coords.length - base[i]) * resto) / sobra) : 0));
      return n === e.coords.length ? e : { ...e, coords: muestrear(e.coords, n) };
    }),
    decimadas: true,
  };
}

/** Lo que recibe `recorridoDeServicio`. Las seis últimas las arma el lector; sin ellas el recorrido
 *  sale sin «sin señal» (conteos en null), sin estimados y con los excesos `sin_dato`. */
export type EntradaRecorrido = {
  reservaId: number;
  crudas: any[] | null;
  aplica: boolean;
  trazaLeida: boolean;
  rastreo: VeredictoRastreo;
  umbral: number;
  vehiculo?: string | null;
  /** la medición de la celda RASTREO (`medirServicio`) */
  medicion?: MedicionCobertura | null;
  /** los puntos con que se midió (traza.pts, en orden): de ahí salen los bordes de cada hueco */
  ptsCobertura?: readonly PuntoCobertura[] | null;
  /** la polilínea de la ruta prevista guardada, en [lng, lat] */
  ruta?: readonly [number, number][] | null;
  estadoRuta?: EstadoRutaPrevista | null;
  /** lo leído de rutas_cache (clavePuente → payload); null = no se pudo leer */
  puentesGuardados?: ReadonlyMap<string, any> | null;
  hechos?: HechosContexto | null;
};

const SIN_ESTADO_RUTA: EstadoRutaPrevista = { codigo: "no_se_pudo_leer", detalle: "No se consultó la ruta prevista guardada." };

const vacio = (e: EntradaRecorrido, excesos: ExcesosServicio): RecorridoServicio => ({
  reservaId: e.reservaId, umbral: e.umbral, medido: [], estimados: [], sinSenal: [],
  sinSenalTotal: e.medicion ? e.medicion.tramos.length : null,
  cortesEnMovimiento: e.medicion ? e.medicion.cortes : null,
  kmACiegas: e.medicion ? e.medicion.kmACiegas : null,
  puntos: [], puntosTotal: 0, rastreo: e.rastreo, rutaPrevista: e.estadoRuta ?? SIN_ESTADO_RUTA,
  posiciones: 0, primeraTs: null, ultimaTs: null,
  medidoDecimado: false, medidoOmitidos: 0, estimadosDecimados: false, estimadosOmitidos: 0, sinSenalOmitidos: 0,
  episodiosCoordsDecimadas: false, excesos, episodios: [],
});

/**
 * El recorrido de un servicio a partir de su traza leída con sus filas (`medirServicio` con
 * `conHuella`), la medición de la celda RASTREO, lo leído de `rutas_cache` y los hechos del servicio.
 * PURA. Su resumen de excesos ES el de `excesosDelServicio`.
 */
export function recorridoDeServicio(e: EntradaRecorrido): RecorridoServicio {
  const excesos = excesosDelServicio(e);
  if (!e.aplica || !e.trazaLeida || !e.crudas) return vacio(e, excesos);

  // La huella del modal. Se dibuja aunque el teléfono no tenga velocímetro: el recorrido existe igual.
  const h = huellaDeFilas(e.crudas);
  const tramosRastreo = e.medicion?.tramos ?? [];

  // ── medido ──
  const medidoTs = medidoDeHuella(h.limpio, tramosRastreo);
  const planM = planDecimado(medidoTs.map((t) => t.coords.length), medidoTs.map((t) => largoM(t.coords)), MAX_VERTICES_TRAZA, COSTO_TRAMO_MEDIDO);
  const medido: TramoMedido[] = [];
  planM.indices.forEach((ix, k) => {
    if (!ix) return;
    const t = medidoTs[k];
    medido.push({ coords: ix.map((i) => t.coords[i]), vel: ix.map((i) => t.vel[i]) });
  });

  // ── estimados ──
  const internos = estimadosDeHuella(h, e.ruta, e.puentesGuardados);
  const lineasE = internos.map((x) => redondearLinea(x.crudas));
  const planE = planDecimado(lineasE.map((l) => l.length), lineasE.map(largoM), MAX_VERTICES_ESTIMADO);
  const dibujados: EstimadoInterno[] = [];
  const estimados: TramoEstimado[] = [];
  planE.indices.forEach((ix, k) => {
    if (!ix || lineasE[k].length < 2) return;
    const x = internos[k];
    dibujados.push(x);
    estimados.push({
      coords: ix.map((i) => lineasE[k][i]), km: x.km, min: x.min, fuente: x.fuente,
      // ¿cae (al menos en parte) sobre un tramo «sin señal» de RASTREO?
      sinSenal: tramosRastreo.some((t) => solapa(x.desdeTs, x.hastaTs, t.desdeTs, t.hastaTs)),
    });
  });

  // ── sin señal: EXACTAMENTE medicion.tramos ──
  const { tramos: quedan, omitidos: sinSenalOmitidos } = toparSinSenal(tramosRastreo, MAX_HUECOS);
  const sinSenal: TramoSinSenal[] = quedan.map((t) => ({
    ...t,
    // En metros enteros (la medición los trae con 15 decimales); lo demás, tal cual.
    avanceM: t.avanceM == null ? null : Math.round(t.avanceM),
    desde: posicionEnTs(e.ptsCobertura, t.desdeTs, "ultimo"),
    hasta: posicionEnTs(e.ptsCobertura, t.hastaTs, "primero"),
    // Lo cubre un estimado DIBUJADO que va de antes a después de él.
    estimado: dibujados.some((x) => x.desdeTs <= t.desdeTs && t.hastaTs <= x.hastaTs),
  }));

  // ── puntitos de telemetría ──
  const tele = puntosTelemetria(h.limpio, h.crudos).filter((p) => coordValida(p.lat, p.lng));
  const puntos: PuntoDato[] = muestrear(tele, MAX_PUNTOS_DATO).map((p) => ({
    c: coordR(p.lng, p.lat), ts: p.ts, vel: Math.round(p.velocidad), velReal: p.velReal,
    // `acc` en metros enteros, como lo lleva el puntito del modal.
    rumbo: Math.round(p.rumbo), rumboReal: p.rumboReal, acc: Math.round(p.acc),
  }));

  // ── los excesos (sin cambios) con su etiqueta ──
  const { puntos: ptsVel, episodios } = episodiosDeTraza({ reservaId: e.reservaId, crudas: e.crudas, umbral: e.umbral, vehiculo: e.vehiculo });
  const conCoord = ptsVel.filter((p) => coordValida(p.lat, p.lng));
  const tss = conCoord.map((p) => p.ts).filter((t) => t > 0);

  // Los episodios solo se publican cuando el resumen es `medido`: con otro código el resumen no
  // afirma ninguno, y el mapa no puede decir otra cosa que la columna.
  const todos: EpisodioMapa[] = excesos.codigo !== "medido" ? [] : episodios
    .map((ep) => ({
      codigo: ep.codigo,
      cuenta: ep.codigo === "exceso",
      inicioTs: ep.inicioTs,
      finTs: ep.finTs,
      durS: ep.durS,
      puntos: ep.puntos,
      velMaxSensor: ep.velMaxSensor,
      velMediaSensor: ep.velMediaSensor,
      velGeom: ep.velGeom,
      precisionMediana: ep.precisionMediana,
      latPico: ep.latPico,
      lngPico: ep.lngPico,
      cortado: ep.cortado,
      detalle: ep.detalle,
      coords: muestrear(coordsDeEpisodio(ptsVel, ep), MAX_COORDS_EPISODIO),
      contexto: contextoDeExceso(ep, e.hechos),
    }))
    .sort((a, b) => a.inicioTs - b.inicioTs);
  const { episodios: eps, decimadas: episodiosCoordsDecimadas } = toparCoordsEpisodios(todos);

  return {
    reservaId: e.reservaId,
    umbral: e.umbral,
    medido,
    estimados,
    sinSenal,
    sinSenalTotal: e.medicion ? e.medicion.tramos.length : null,
    cortesEnMovimiento: e.medicion ? e.medicion.cortes : null,
    kmACiegas: e.medicion ? e.medicion.kmACiegas : null,
    puntos,
    puntosTotal: tele.length,
    rastreo: e.rastreo,
    rutaPrevista: e.estadoRuta ?? SIN_ESTADO_RUTA,
    posiciones: conCoord.length,
    primeraTs: tss.length ? tss.reduce((a, b) => Math.min(a, b)) : null,
    ultimaTs: tss.length ? tss.reduce((a, b) => Math.max(a, b)) : null,
    medidoDecimado: planM.decimada,
    medidoOmitidos: planM.omitidos,
    estimadosDecimados: planE.decimada,
    estimadosOmitidos: planE.omitidos,
    sinSenalOmitidos,
    episodiosCoordsDecimadas,
    excesos,
    episodios: eps,
  };
}
