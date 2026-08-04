// lib/avance-paradas.ts — ¿por dónde va REALMENTE el bus? (motor direccional, PURO)
//
// PROBLEMA. Hasta ahora "la próxima parada" se respondía con
// `paradas.find(p => p.estado !== "completada")`. Eso no es un hecho físico: es el registro
// de que un humano tocó un botón. Cuando el conductor no marca —lo habitual— el bus deja
// atrás paraderos que el sistema sigue creyendo pendientes, y todo lo que cuelga de ahí
// miente: se le pide a Google la ruta HACIA ATRÁS (vuelta en U), la "hora de llegada" es
// una hora inventada y salta en cada refresco.
//
// Es el MISMO bug que app/pasajero/page.tsx:906-975 ya corrigió para "mi paradero"
// (commit db0ef14). Aquí se porta esa máquina —mismos umbrales, misma filosofía— y se
// generaliza de "mi paradero" a "cada parada de la ruta".
//
// PROPIEDAD DE SEGURIDAD (lo que hace esto desplegable): el marcado del conductor sigue
// siendo la AUTORIDAD MÁXIMA. El GPS solo añade un PISO inferido:
//
//     piso = max(pisoConductor, pisoGps)
//
// Si el conductor marca bien, la salida es IDÉNTICA a la de hoy. Si no marca, el GPS
// empuja. Con la huella vacía o el endpoint caído, `pisoGps = 0` y se cae solo al
// comportamiento actual: el fallback no hay que escribirlo, sale del max().
//
// PURO A PROPÓSITO: sin React, sin DOM, sin fetch, sin Mapbox. Único import: distM de
// ./huella (misma convención relativa que lib/km-servicio.ts). Así mañana lib/proximidad.ts
// —que es server-side— puede derivar avance sin duplicar nada, que es el camino que ya
// recorrió lib/huella.ts. Doctrina de la casa: ver la cabecera de lib/huella.ts:1-5.
//
// LO QUE ESTA LIB NO HACE, DELIBERADAMENTE: no escribe en la base, no marca paradas, no
// llama a emitirLlego() ni manda push/WhatsApp. app/conductor/page.tsx:277-284 fijó que el
// geofence "nunca marca en silencio (una marca falsa avisa a pasajeros y ensucia el
// registro)". Inferir para PINTAR es otra cosa que inferir para ESCRIBIR. Si alguien
// propone "ya que lo detectamos, marquémoslo", eso es OTRA decisión con otro análisis de
// riesgo — no el siguiente paso obvio.

import { distM } from "./huella";

// ── CONSTANTES PORTADAS VERBATIM de app/pasajero/page.tsx:926-971 ────────────────────
// No se re-justifican aquí: se citan. Cambiarlas es cambiar una máquina ya validada en
// producción, y hoy NO hay test runner en el repo (`npm run lint` y nada más).
const SALTO_GLITCH_M = 400;   // salto mínimo para sospechar teletransporte (línea 926)
const VEL_GLITCH_MS  = 34;    // ~122 km/h: techo físico de un bus urbano (líneas 923-925)
const GAP_ALEJA_M    = 60;    // gap > 60 → cuenta como alejarse (línea 935)
const GAP_CERCA_M    = 25;    // gap < 25 → sigue en su mínimo (línea 936)
const BAJANDO_M      = 40;    // se acercó ≥40 m vs. la muestra previa (línea 934)
const RACHA_ALEJA    = 3;     // ~3 muestras seguidas alejándose (línea 952)
const RACHA_REGRESO  = 2;     // (línea 962)
const REGRESO_M      = 400;   // volvió a <400 m = retorno real, no una curva de la vía (963-966)
const MIN_CERCA_M    = 450;   // "se acercó de verdad" (línea 951)
const GAP_ATRAS_M    = 600;   // "+600 m, más que un retorno típico de avenida con separador" (947-948)

// ── CONSTANTES NUEVAS — todas ancladas a un valor que YA existe en el repo ────────────
// Inventar calibración nueva en un repo sin tests es la forma más rápida de que la máquina
// se degrade sin que nadie se entere.

// Cadencia mínima entre muestras aceptadas. El pasajero pollea cada 5 s (page.tsx:1087), así
// que en vivo esta puerta nunca se dispara. En la SIEMBRA sí: el conductor envía cada ~3 s en
// marcha (app/conductor/page.tsx:249-264), y replicar 3000 fixes a 3 s haría que RACHA_ALEJA=3
// significara 9 s de alejamiento en vez de los 15-30 s que significa en vivo — el algoritmo
// dispararía 3× antes con 3× menos evidencia física, sin que ni una línea de código cambiara.
// Escrita como `ts > lastTs + MS_MUESTRA_MIN` (estrictamente creciente) sustituye al
// `ts !== s.lastTs` de la línea 919 y de paso mata la respuesta FUERA DE ORDEN (carrera entre
// el poll de 5 s y el de 30 s), que hoy entra con dt negativo, nunca es glitch y envenena minDist.
const MS_MUESTRA_MIN = 4_000;

// = PRECISION_MAX_M de lib/proximidad.ts:39 ("precisión peor → sin decisiones"). CRÍTICO y no
// negociable: el endpoint de la huella acepta fixes de hasta 1500 m (app/api/cliente/gps:106) y
// el modal ya avisa "GPS débil" cuando la mediana reciente llega a 60 m. Con ±200 m de ruido las
// puertas de 25/60 m del gap están DENTRO del error: las rachas se llenan solas y un tercero con
// GPS de red declararía "ya pasó" en cualquier punto de la ruta. Se aplica IGUAL en la siembra
// histórica y en vivo — si solo se aplicara en vivo, la siembra metería la basura por la puerta de atrás.
const ACC_MAX_M = 150;

// Desplazamiento mínimo para que una muestra APORTE información direccional.
// Sin esto, el GPS CONGELADO (el backstop re-envía la MISMA coord con created_at fresco —
// ModalGps lo detecta como `congeladoMin`) rompe la máquina en las dos direcciones a la vez:
//   • si el fix quedó clavado EN su mínimo → gap = 0 → cae en `gap < GAP_CERCA_M` → apprStreak
//     sube en cada muestra → a las 2 dispara la rama de regreso y BORRA un "ya pasó" legítimo;
//   • si quedó clavado lejos del mínimo → gap grande → recStreak sube solo → declara "se aleja"
//     de un bus que ni siquiera se está moviendo.
// Un bus detenido (semáforo, embarque) tampoco aporta dirección, así que congelar las rachas es
// lo correcto en ambos casos. El reloj SÍ avanza: si no, dt crecería sin límite y desactivaría
// el filtro de glitch. 12 m ≈ el jitter típico de un GPS satelital sano parado (lib/huella.ts
// documenta ~10-12 m), así que no come movimiento real.
//
// SE MIDE CONTRA EL ÚLTIMO PUNTO DONDE HUBO MOVIMIENTO REAL, no contra la muestra previa. Medirlo
// contra la muestra previa reintroduce el bug que este mismo umbral existe para NO repetir: un bus
// que avanza de a poco (<12 m por muestra, típico a ~6 s de cadencia y tráfico denso) nunca
// acumula desplazamiento porque cada paso individual es "quieto" — el ancla se reinicia en cada
// muestra y el bus puede recorrer cientos de metros sin que la máquina lo note. Con un ancla que
// solo avanza cuando SÍ hay movimiento, diez pasos de 10 m suman 100 m y sí se detectan.
const MOV_MIN_M = 12;

// = VENTANA_PARADAS de lib/proximidad.ts:44. Solo las N paradas siguientes al piso se evalúan.
// POR QUÉ: en un servicio de RETORNO la parada 8 puede estar a 30 m de la parada 2. Sin ventana,
// la máquina de la 8 acumula minDist≈0 mientras el bus atiende la 2, y al continuar dispara
// "dejó atrás" → declararía pasada la 8 en el minuto 10 y el piso saltaría al final de la ruta.
const VENTANA_PARADAS = 3;

// = MAX_SEG_M de lib/huella.ts. Umbral canónico del repo para "por debajo de esto la geometría
// es una sola cosa continua". Dos paraderos a menos de esto son indistinguibles para un GPS de red.
const SEPARACION_MIN_M = 300;

// Hueco de señal tras el cual el estado describe un mundo que ya no existe. Exigir ADEMÁS un
// salto real (>1 km) evita que una parada larga —donde el bus quieto deja huecos de muestras—
// borre el estado por nada.
const HUECO_SALTO_M  = 1_000;

// Separación máxima entre muestras para que el test de velocidad SIGNIFIQUE algo.
// Por encima de esto no se puede distinguir un teletransporte de un tramo de carretera, así que
// el filtro de glitch NO se aplica: si se aplicara, sería un ESTADO ABSORBENTE. El motivo es
// sutil y costó encontrarlo: al rechazar una muestra NO se mueve el ancla, así que la siguiente
// está aún más lejos del ancla viejo; con el divisor acotado, la velocidad implícita solo puede
// CRECER y ninguna muestra posterior vuelve a pasar jamás — el motor queda muerto para el resto
// del servicio, y como la siembra es determinista, el bloqueo se reproduce en cada reapertura.
// Por encima de este umbral la muestra se ACEPTA y lo que se descarta es la geometría acumulada
// (re-siembra): es lo honesto, porque durante el corte el bus pudo ir a cualquier parte.
const GLITCH_MAX_DT_S = 60;

// Proximidad previa exigida para creer en la señal A ("está más cerca del paradero siguiente").
// Cierra una ASIMETRÍA del original: `dejoAtrasClaro` exige haberse acercado (<450 m) pero
// `masCercaDelSiguiente` no exige NADA, así que un bus que hace el tramo inicial en sentido
// contrario podía declarar "YA PASÓ" sin haber venido nunca. 900 m ≈ 2×MIN_CERCA_M y queda por
// debajo del DIST_AVISO_M=1500 de proximidad.ts: solo excluye el caso en que el bus jamás
// estuvo a un kilómetro del paradero.
const MIN_CERCA_A_M = 900;

// Por debajo de esta distancia se da por hecho que el bus estuvo EN el paradero, y salir de ahí
// es pasarlo — sin exigir la prueba de cruce (ver `cruzo`). Por encima, la dirección paradero→bus
// sí es significativa. 120 m ≈ el radio de llegada mínimo de lib/proximidad.ts (clamp 120…250 m
// según precisión), o sea el mismo criterio con el que el servidor ya declara "llegó".
const CRUCE_EXENTO_M = 120;

// Veto geométrico (ver `prepararRuta`): corredor perpendicular dentro del cual se considera que
// un punto "va sobre la ruta", y margen de avance exigido sobre la polilínea.
const PERP_CORREDOR_M = 70;
const VETO_MARGEN_M   = 80;
// Reevaluar el veto como mucho cada 20 s de tiempo-de-fix por parada: proyectar sobre la
// polilínea es O(vértices) y durante una siembra completa se llamaría por cada muestra.
const VETO_THROTTLE_MS = 20_000;

// ── Tipos ────────────────────────────────────────────────────────────────────────────

export type ParadaAvance = {
  lat: number | null;
  lng: number | null;
  /** paradas.estado === "completada" — autoridad máxima, nunca se contradice. */
  completada: boolean;
};

export type FixAvance = {
  lat: number; lng: number;
  ts: number;   // ms epoch (created_at; filasAPuntos ya lo normaliza)
  acc: number;  // precision_m (25 por defecto, igual que filasAPuntos)
};

export type OpcionesAvance = {
  /** Índice SIEMPRE activo, ignora la ventana (el pasajero rastrea su paradero desde el fix 1). */
  foco?: number | null;
  ventana?: number;
  /** 0 = paridad exacta con app/pasajero (dedupe por ts distinto, sin diezmado). */
  gateMs?: number;
  /** Infinity = paridad exacta con app/pasajero (que no tiene puerta de precisión). */
  accMaxM?: number;
  /** false = paridad exacta con app/pasajero. */
  resembrarPorHueco?: boolean;
  /** false = paridad exacta con app/pasajero (que NO exige proximidad previa para la señal A). */
  endurecerSenalA?: boolean;
  /** Ignorar fixes anteriores a este instante (rama por-vehículo de terceros: 12 h que pueden
   *  arrastrar el viaje ANTERIOR si la separación fue <30 min — app/api/cliente/gps:85-99). */
  desdeTs?: number;
  /** Ruta preparada con prepararRuta(): habilita el VETO geométrico. Opcional. */
  ruta?: RutaProyeccion | null;
};

export type EstadoParada = {
  minDist: number;        // Infinity si nunca se alimentó
  // Dónde estaba el BUS cuando alcanzó ese mínimo. Es lo que permite distinguir "cruzó el
  // paradero y siguió" de "se acercó y volvió por donde vino": ambas cosas producen la misma
  // distancia creciente, y sin esto la segunda se leía como un "ya pasó" que nunca ocurrió.
  minLat: number | null;
  minLng: number | null;
  lastD: number | null;
  recStreak: number;
  apprStreak: number;
  pasada: boolean;        // veredicto FUERTE  (≡ busPasoMiParada del pasajero)
  alejando: boolean;      // veredicto BLANDO histórico — usar `Avance.seAleja` para leer el
                           // estado VIGENTE (ver leerAvance): este campo puede quedar pegajoso.
  vetoTs: number;         // último instante en que se evaluó el veto geométrico
  vetoActivo: boolean;    // resultado cacheado de ese veto
};

export type EstadoAvance = {
  porParada: EstadoParada[];   // 1:1 con el array de paradas, POR ÍNDICE (jamás por id)
  lastTs: number;
  lastLat: number | null;
  lastLng: number | null;
  // Última posición donde se registró movimiento REAL (≥ MOV_MIN_M desde la anterior). Distinta
  // de lastLat/lastLng (que es la última muestra ACEPTADA, se use o no para medir dirección):
  // el filtro de glitch necesita comparar contra la muestra inmediatamente anterior; la puerta
  // "quieto" necesita comparar contra el último punto de movimiento, o un bus que avanza a pasos
  // menores de MOV_MIN_M nunca acumula desplazamiento (ver el comentario de MOV_MIN_M).
  lastMovLat: number | null;
  lastMovLng: number | null;
  muestras: number;            // aceptadas; 0 = sin evidencia GPS
  accReciente: number[];       // últimas 25 precisiones → confianza "degradada"
  resiembras: number;
};

export type MotivoPaso = "conductor" | "gps" | "arrastre" | null;

export type Avance = {
  proximaIdx: number | null;   // null = el bus ya pasó la última parada
  pasadas: boolean[];
  motivo: MotivoPaso[];
  seAleja: boolean;            // el bus se aleja de proximaIdx (veredicto BLANDO)
  confianza: "sin_evidencia" | "conductor" | "gps" | "degradada";
  muestras: number;
  ultimaMuestraTs: number;
  pisoConductor: number;
  pisoGps: number;
};

// ── Veto geométrico: proyección sobre la polilínea de la ruta ────────────────────────
//
// Los umbrales de la máquina son 100 % haversine (distancia en línea recta), y eso no
// distingue "pasó de largo" de "se desvió por una calle secundaria" ni de "está en el
// retorno de la avenida y vuelve a recoger". La polilínea sí.
//
// SE USA SOLO COMO VETO, NUNCA COMO DISPARADOR. Es una decisión deliberada: como señal
// POSITIVA, el avance sobre la polilínea produce el falso positivo cabecera de este bug —
// la ruta de Google incluye el propio retorno en U (las paradas van como waypoints en
// orden) y los dos sentidos de una avenida con separador distan 15-30 m, muy por debajo
// del corredor. Un bus EN PLENO RETORNO proyecta sobre el tramo de vuelta y "avanzaría"
// cientos de metros justo cuando está volviendo a recoger. Como VETO es puramente
// sustractivo: solo puede suprimir un "ya pasó", jamás inventarlo.
//
// NO se reusa la proyección de pegarIconoAVia/puentePorRuta a propósito: son las funciones
// más cicatrizadas del repo, deciden dónde se dibuja el bus en DOS páginas, y pegarIconoAVia
// arrastra `prevS` (progreso congelado sin señal) además de una ventana que engancha al pase
// opuesto en rutas de ida y vuelta. Esto son 30 líneas locales sin memoria.

export type RutaProyeccion = {
  pts: { lat: number; lng: number }[];
  cum: number[];   // metros acumulados hasta cada vértice
  total: number;
};

/** Prepara la polilínea de la ruta ([lng,lat], convención Mapbox) para proyectar sobre ella.
 *  Diezma a ~`maxPuntos` vértices: la geometría de Google trae miles y el veto solo necesita
 *  saber si el bus va antes o después de una parada, no dibujar. */
export function prepararRuta(coords: [number, number][] | null | undefined, maxPuntos = 600): RutaProyeccion | null {
  if (!coords || coords.length < 2) return null;
  const paso = Math.max(1, Math.ceil(coords.length / maxPuntos));
  const pts: { lat: number; lng: number }[] = [];
  for (let i = 0; i < coords.length; i += paso) {
    const c = coords[i];
    if (Number.isFinite(c?.[0]) && Number.isFinite(c?.[1])) pts.push({ lat: c[1], lng: c[0] });
  }
  const ultimo = coords[coords.length - 1];
  if (Number.isFinite(ultimo?.[0]) && Number.isFinite(ultimo?.[1])) pts.push({ lat: ultimo[1], lng: ultimo[0] });
  if (pts.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + distM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

/** Proyecta un punto sobre la polilínea. `along` = metros recorridos hasta el pie de la
 *  perpendicular; `perp` = cuán lejos de la ruta está el punto. */
function proyectar(r: RutaProyeccion, lat: number, lng: number): { along: number; perp: number } {
  let mejor = { along: 0, perp: Infinity };
  // Métrica local plana: a escala de una ruta urbana el error es despreciable y evita
  // 2×N haversines por proyección.
  const kLat = 111_320, kLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i];
    const ax = (a.lng - lng) * kLng, ay = (a.lat - lat) * kLat;
    const bx = (b.lng - lng) * kLng, by = (b.lat - lat) * kLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, py = ay + t * dy;
    const perp = Math.sqrt(px * px + py * py);
    if (perp < mejor.perp) {
      mejor = { perp, along: r.cum[i - 1] + t * (r.cum[i] - r.cum[i - 1]) };
    }
  }
  return mejor;
}

/** ¿La geometría CONTRADICE que el bus haya pasado esta parada? true = vetar el veredicto.
 *  Solo opina cuando bus y parada caen ambos sobre el corredor de la ruta; si alguno está
 *  fuera (desvío real, parada mal geocodificada) se abstiene y manda la cinemática. */
function vetaGeometria(r: RutaProyeccion, fix: FixAvance, pLat: number, pLng: number): boolean {
  const pb = proyectar(r, fix.lat, fix.lng);
  if (pb.perp > PERP_CORREDOR_M) return false;
  const pp = proyectar(r, pLat, pLng);
  if (pp.perp > PERP_CORREDOR_M) return false;
  // El bus todavía va AGUAS ARRIBA de la parada sobre la ruta → no la ha pasado, por más
  // que la distancia en línea recta haya crecido (curva, desvío, retorno).
  return pb.along < pp.along - VETO_MARGEN_M;
}

// ── Motor ────────────────────────────────────────────────────────────────────────────

export function estadoAvanceVacio(n: number): EstadoAvance {
  return {
    porParada: Array.from({ length: Math.max(0, n) }, () => ({
      minDist: Infinity, minLat: null, minLng: null, lastD: null, recStreak: 0, apprStreak: 0,
      pasada: false, alejando: false, vetoTs: 0, vetoActivo: false,
    })),
    lastTs: 0, lastLat: null, lastLng: null, lastMovLat: null, lastMovLng: null,
    muestras: 0, accReciente: [], resiembras: 0,
  };
}

const clonar = (e: EstadoAvance): EstadoAvance => ({
  ...e,
  porParada: e.porParada.map((s) => ({ ...s })),
  accReciente: e.accReciente.slice(),
});

// `p.lat != null` es obligatorio ANTES del isFinite: Number(null) es 0, así que sin este chequeo
// una parada sin geocodificar (lat/lng null — "habitual, no excepcional" según ModalGps) entraba
// a la máquina como si estuviera en (0,0) y envenenaba minDist/gap con una distancia de ~8800 km.
const tieneCoords = (p: ParadaAvance | undefined): boolean =>
  !!p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

/** Piso inferido por GPS: 1 + el índice más alto declarado "pasada". */
function pisoDeGps(e: EstadoAvance): number {
  let piso = 0;
  for (let i = 0; i < e.porParada.length; i++) if (e.porParada[i].pasada) piso = i + 1;
  return piso;
}

/** Piso del conductor: 1 + el índice más alto marcado "completada".
 *  Se toma el MÁXIMO y no el primer hueco a propósito: si el conductor marcó la 5 pero se
 *  saltó la 3, la 3 queda pasada por arrastre en vez de pintarse "pendiente" con la 6 como
 *  actual — que es la incoherencia silenciosa que hoy muestra app/cliente:2628. */
function pisoDeConductor(paradas: ParadaAvance[]): number {
  let piso = 0;
  for (let i = 0; i < paradas.length; i++) if (paradas[i]?.completada) piso = i + 1;
  return piso;
}

/**
 * Un paso de la máquina. Devuelve un estado NUEVO (no muta el recibido).
 * El orden de las puertas importa: una muestra descartada NO debe convertirse en la
 * referencia de la siguiente, o el descarte se propaga.
 */
export function avanzarAvance(
  estado: EstadoAvance,
  fix: FixAvance,
  paradas: ParadaAvance[],
  opts: OpcionesAvance = {},
): EstadoAvance {
  const gateMs   = opts.gateMs   ?? MS_MUESTRA_MIN;
  const accMaxM  = opts.accMaxM  ?? ACC_MAX_M;
  const ventana  = opts.ventana  ?? VENTANA_PARADAS;
  const endurecer = opts.endurecerSenalA ?? true;
  const resembrarHueco = opts.resembrarPorHueco ?? true;

  // 0. GPS congelado: las filas repiten un fix viejo con created_at fresco. No dice nada del
  //    presente y, procesado, dispara rachas fantasma en ambos sentidos.
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lng) || !(fix.ts > 0)) return estado;
  if (opts.desdeTs != null && fix.ts < opts.desdeTs) return estado;

  // 1. PUERTA TEMPORAL — cubre a la vez la fila repetida del polling, la respuesta fuera de
  //    orden (dt negativo) y el diezmado de la siembra.
  if (gateMs > 0 ? !(fix.ts > estado.lastTs + gateMs) : fix.ts === estado.lastTs) return estado;

  // 2. PUERTA DE PRECISIÓN — sin tocar lastTs/lastLat: la muestra mala no es referencia.
  const acc = Number.isFinite(fix.acc) ? fix.acc : 25;
  if (acc > accMaxM) return estado;

  const dt    = estado.lastTs ? (fix.ts - estado.lastTs) / 1000 : 0;
  const salto = estado.lastLat != null ? distM(estado.lastLat, estado.lastLng!, fix.lat, fix.lng) : 0;

  // 3. GLITCH — un bus urbano no supera ~120 km/h. Sin este filtro una lectura errónea que
  //    caiga cerca de una parada envenena su minDist (mínimo monótono, nunca decae) y dispara
  //    un falso "ya pasó" con el bus todavía viniendo.
  //    El divisor va ACOTADO a 60 s: el original divide por dt entero, así que tras un hueco de
  //    10 min un teletransporte de 20 km da 33 m/s y pasa el filtro justo cuando más falta hace.
  //    Con dt ≤ 60 s el resultado es idéntico al del pasajero.
  //    Solo se aplica con seguimiento CONTINUO (dt ≤ GLITCH_MAX_DT_S). Ver esa constante: por
  //    encima, aplicarlo crea un estado absorbente que mata el motor para el resto del servicio.
  const esHueco = dt > GLITCH_MAX_DT_S;
  if (estado.lastLat != null && dt > 0 && !esHueco &&
      salto > SALTO_GLITCH_M && salto / dt > VEL_GLITCH_MS) {
    return estado;
  }

  const e = clonar(estado);
  e.muestras++;
  e.accReciente.push(acc);
  if (e.accReciente.length > 25) e.accReciente.shift();

  // 4. HUECO REAL — tras un corte de señal CON desplazamiento de más de 1 km, minDist y las
  //    rachas describen un mundo que ya no existe (el bus pudo ir a cualquier parte mientras no
  //    reportaba). Se re-siembra la geometría, pero NO los veredictos: "ya pasó" es una
  //    conclusión sobre el pasado y sigue siendo cierta.
  //    Es también la contrapartida de no aplicar el filtro de glitch aquí: la muestra rara entra,
  //    pero no puede envenenar un mínimo monótono porque ese mínimo se reinicia.
  const resembrar = resembrarHueco && esHueco && salto > HUECO_SALTO_M;
  if (resembrar) e.resiembras++;

  // 5. ¿La muestra aporta información DIRECCIONAL? Un bus detenido —o un GPS congelado— no la
  //    aporta. Se avanza el reloj (si no, dt crecería sin límite y desactivaría el filtro de
  //    glitch) pero no se tocan rachas ni veredictos.
  //    Se mide contra el último punto CON MOVIMIENTO, no contra la muestra previa: si no, un bus
  //    lento en tráfico (pasos de <12 m) nunca acumularía desplazamiento — justo el caso que la
  //    máquina original fue escrita para atrapar.
  const desdeMov = e.lastMovLat != null ? distM(e.lastMovLat, e.lastMovLng!, fix.lat, fix.lng) : Infinity;
  const quieto   = estado.lastLat != null && !resembrar && desdeMov < MOV_MIN_M;
  if (!quieto) { e.lastMovLat = fix.lat; e.lastMovLng = fix.lng; }

  const piso = Math.max(pisoDeConductor(paradas), pisoDeGps(e));
  let avanzoAlguna = false;   // máximo UN ascenso de piso por muestra (ver más abajo)

  for (let i = 0; i < paradas.length; i++) {
    const enVentana = i >= piso && i <= piso + ventana;
    const esFoco    = opts.foco != null && opts.foco === i;
    // La parada inmediatamente anterior al piso GPS se sigue alimentando aunque quede fuera de
    // la ventana. Sin esto la rama de regreso es INALCANZABLE para una parada ya declarada
    // pasada: un falso positivo duraría toda la sesión y —al ser la siembra determinista— se
    // reproduciría idéntico en cada reapertura del modal. Es la única vía de recuperación.
    const esUltimaPasada = i === piso - 1 && e.porParada[i]?.pasada;
    if (!enVentana && !esFoco && !esUltimaPasada) continue;
    if (!tieneCoords(paradas[i])) continue;

    const s = e.porParada[i];
    if (!s) continue;   // estado construido con menos paradas que el array actual (API pública)
    const d = distM(fix.lat, fix.lng, Number(paradas[i].lat), Number(paradas[i].lng));

    // Tras un hueco se descarta la TENDENCIA (a dónde iba el bus hace media hora no dice nada),
    // pero NO el mínimo: "lo más cerca que este bus llegó a estar de esta parada" es un hecho
    // sobre el pasado y sigue siendo cierto al otro lado del corte. Reiniciarlo a la distancia
    // post-hueco borraba justo la evidencia que necesitan las dos señales fuertes, y un bus que
    // pasó por el paradero antes de perder señal ya no podía declararse pasado nunca más.
    if (resembrar) { s.recStreak = 0; s.apprStreak = 0; s.lastD = null; }
    if (d < s.minDist) { s.minDist = d; s.minLat = fix.lat; s.minLng = fix.lng; }   // mínimo monótono
    if (quieto) continue;

    const gap     = d - s.minDist;
    const bajando = s.lastD != null && d < s.lastD - BAJANDO_M;
    // `bajando` se evalúa PRIMERO. El original mira el gap antes, y entonces un bus que vuelve
    // al paradero seguía contando como "alejándose" mientras su distancia superara el mínimo por
    // más de 60 m — es decir, durante casi todo el regreso. Con el mínimo re-sembrado por el
    // trinquete eso pasaba desapercibido; sin él, el aviso de "ya pasó" no llegaba a limpiarse
    // aunque el bus estuviera volviendo a recoger. Acercarse de verdad (>40 m menos que la
    // muestra anterior) es inequívoco y no puede leerse como alejamiento.
    if (bajando)                   { s.apprStreak++; s.recStreak  = 0; }
    else if (gap > GAP_ALEJA_M)    { s.recStreak++;  s.apprStreak = 0; }
    else if (gap < GAP_CERCA_M)    { s.apprStreak++; s.recStreak  = 0; }
    // zona intermedia (25-60 m sin acercarse): conservar ambas rachas (pasajero, línea 937)
    s.lastD = d;

    // Paradero SIGUIENTE con coords. Se saltan las sin geocodificar porque la geocodificación
    // usa `parada.nombre` y nunca `direccion` — quedarse sin coords es habitual, no excepcional.
    let sig: ParadaAvance | null = null;
    for (let j = i + 1; j < paradas.length; j++) if (tieneCoords(paradas[j])) { sig = paradas[j]; break; }

    // Dos paraderos a menos de 300 m: "estoy más cerca del siguiente" es ruido de GPS, no
    // avance. Se desactiva la señal A para ese par y queda solo la B (450/600 m), que exige
    // haberse alejado 600 m del mínimo y es inequívoca. El de atrás se recupera por arrastre.
    const juntas = sig != null &&
      distM(Number(paradas[i].lat), Number(paradas[i].lng), Number(sig.lat), Number(sig.lng)) < SEPARACION_MIN_M;

    const masCercaDelSiguiente = sig != null && !juntas &&
      distM(fix.lat, fix.lng, Number(sig.lat), Number(sig.lng)) < d &&
      (!endurecer || s.minDist < MIN_CERCA_A_M);
    // ¿El bus CRUZÓ el paradero, o se acercó y volvió por donde vino? Las dos cosas producen
    // exactamente la misma señal de "distancia creciente", y sin distinguirlas un bus que se
    // aproximó a 300 m y retrocedió quedaba declarado "ya pasó" sin haber llegado nunca.
    // Se compara la dirección paradero→bus en el punto MÁS CERCANO contra la de ahora: si el bus
    // siguió de largo, quedó al otro lado y el producto escalar es negativo; si volvió sobre sus
    // pasos, sigue del mismo lado y es positivo.
    // Con el bus prácticamente EN el paradero (<120 m) esa dirección es puro ruido de GPS y no
    // hace falta: estar ahí y salir ES pasar.
    const cruzo = (() => {
      if (s.minDist < CRUCE_EXENTO_M) return true;
      if (s.minLat == null) return true;
      const pLat = Number(paradas[i].lat), pLng = Number(paradas[i].lng);
      const kLng = Math.cos((pLat * Math.PI) / 180);
      const v1x = (s.minLng! - pLng) * kLng, v1y = s.minLat - pLat;
      const v2x = (fix.lng - pLng) * kLng,   v2y = fix.lat - pLat;
      return v1x * v2x + v1y * v2y < 0;
    })();
    const dejoAtrasClaro = s.minDist < MIN_CERCA_M && gap > GAP_ATRAS_M && cruzo;
    const sostenido      = s.recStreak >= RACHA_ALEJA;

    if (sostenido && (masCercaDelSiguiente || dejoAtrasClaro)) {
      s.alejando = true;                       // BLANDO: se afirma siempre
      if (!s.pasada) {
        // FUERTE. DOS candados sobre el piso, no uno:
        //  (a) el piso sube DE A UNA parada real. Como el piso es `1 + índice más alto pasado`
        //      y leerAvance marca todo lo anterior por arrastre, permitir que dispare una parada
        //      del extremo de la ventana haría saltar el piso hasta 4 posiciones de golpe,
        //      marcando 3 recojos como hechos sin ninguna evidencia. Solo se salta por encima de
        //      paradas IMPOSIBLES de evaluar (sin coords): ésas nunca podrían disparar, y sin
        //      esta vía de escape una sola parada mal geocodificada atascaría el piso el resto
        //      del servicio. Las paradas más adelantadas siguen acumulando rachas —no se pierde
        //      evidencia— pero esperan su turno.
        //  (b) un solo ascenso por muestra.
        let hayRealAntes = false;
        for (let k = piso; k < i; k++) if (tieneCoords(paradas[k])) { hayRealAntes = true; break; }
        if (hayRealAntes) continue;
        if (avanzoAlguna) continue;
        if (opts.ruta) {
          if (fix.ts - s.vetoTs >= VETO_THROTTLE_MS) {
            s.vetoTs = fix.ts;
            s.vetoActivo = vetaGeometria(opts.ruta, fix, Number(paradas[i].lat), Number(paradas[i].lng));
          }
          if (s.vetoActivo) continue;          // el bus sigue aguas arriba sobre la ruta
        }
        s.pasada = true;
        avanzoAlguna = true;
      }
    } else if (sostenido) {
      s.alejando = true;                       // BLANDO sin confirmación locacional
    } else if (s.apprStreak >= RACHA_REGRESO && d < REGRESO_M) {
      // El bus REGRESÓ y está cerca otra vez (fue al retorno / dio la vuelta a recoger).
      // Exigir cercanía (<400 m) distingue un retorno real de una curva de la vía que solo
      // acorta la distancia en recta mientras el bus se va de verdad.
      //
      // EL MÍNIMO SOLO SE RE-SIEMBRA SI HAY UN VEREDICTO QUE DESHACER. Ésta es una divergencia
      // deliberada respecto del original (app/pasajero:962-971), que lo re-sembraba siempre.
      // Motivo: re-sembrarlo incondicionalmente crea un TRINQUETE. Al salir de un paradero el
      // bus todavía está a <400 m y su gap es pequeño, así que cae aquí; al asignar minDist = d
      // el gap vuelve a 0, la muestra siguiente vuelve a caer aquí, y minDist va SUBIENDO
      // pegado a la distancia real (medido: 0 → 400 m mientras el bus se alejaba). Como
      // `dejoAtrasClaro` exige gap > 600 m, el veredicto "ya pasó" se retrasaba unos 400 m —
      // y si REGRESO_M llegara a igualar MIN_CERCA_M (450) se volvería inalcanzable.
      // Re-sembrar SÍ tiene sentido cuando se está revirtiendo un "ya pasó"/"se aleja": ahí le
      // da al bus una oportunidad limpia en vez de re-disparar el aviso de inmediato. Cuando no
      // hay nada que revertir, el mínimo monótono de más arriba ya hace lo correcto solo.
      if (s.pasada || s.alejando) { s.minDist = d; s.vetoTs = 0; s.vetoActivo = false; }
      s.alejando = false; s.pasada = false; s.recStreak = 0;
    }
  }

  // 6. COMMIT ATÓMICO — solo si la muestra superó las puertas 1-3.
  e.lastTs = fix.ts; e.lastLat = fix.lat; e.lastLng = fix.lng;
  return e;
}

/**
 * Siembra desde la huella histórica. NO es un algoritmo distinto: es el MISMO reduce sobre el
 * historial. Ese invariante es lo único que impide que "sembrado" y "en vivo" diverjan —
 * exactamente el error que documenta la cabecera de lib/huella.ts.
 *
 * Es determinista: sembrar el mismo prefijo dos veces da el mismo resultado, así que se puede
 * re-sembrar entero en cada ciclo sin el parpadeo de "el número salta hacia atrás entre refrescos".
 *
 * OJO CON QUÉ SET SE LE PASA. Debe alimentarse con `filasAPuntos(filas)` CRUDO:
 *   • `anclarImprecisos(...)` PUEDE mover lat/lng de puntos ya consumidos cuando llega un vecino
 *     confiable posterior (lib/huella.ts) → el prefijo deja de ser estable y el veredicto puede
 *     parpadear entre ciclos. La puerta de precisión (acc ≤ 150 m) ya rechaza los fixes de red
 *     que el anclaje pretendía corregir.
 *   • `limpiarHuella(...)` colapsa cada detención a UN centroide y dedupea a 8 m → destruye la
 *     CADENCIA sobre la que están calibradas las rachas. Con eso, RACHA_ALEJA=3 deja de
 *     significar lo mismo y la máquina cambia sin que cambie una línea de código.
 */
export function sembrarAvance(
  paradas: ParadaAvance[],
  huella: FixAvance[],
  opts: OpcionesAvance = {},
): EstadoAvance {
  let e = estadoAvanceVacio(paradas.length);
  if (!Array.isArray(huella)) return e;
  for (const fix of huella) e = avanzarAvance(e, fix, paradas, opts);
  return e;
}

/** Lectura para "¿cuál es la próxima parada?" — lo que consume el modal del operador. */
export function leerAvance(estado: EstadoAvance, paradas: ParadaAvance[]): Avance {
  const n = paradas.length;
  const pisoConductor = pisoDeConductor(paradas);
  const pisoGps       = pisoDeGps(estado);
  const piso          = Math.max(pisoConductor, pisoGps);
  const proximaIdx    = piso < n ? piso : null;

  const pasadas: boolean[] = [];
  const motivo: MotivoPaso[] = [];
  for (let i = 0; i < n; i++) {
    pasadas[i] = i < piso;
    motivo[i]  = paradas[i]?.completada ? "conductor"
      : estado.porParada[i]?.pasada     ? "gps"
      : i < piso                        ? "arrastre"
      : null;
  }

  const accs = estado.accReciente.slice().sort((a, b) => a - b);
  const medAcc = accs.length ? accs[Math.floor(accs.length / 2)] : 0;
  const confianza: Avance["confianza"] =
    estado.muestras === 0 ? "sin_evidencia"
    // Mismo umbral que ya alimenta `precDebilM` en el modal: con ±60 m de mediana las puertas
    // de 25/60 m del gap están dentro del ruido y no se puede AFIRMAR nada.
    : medAcc >= 60 ? "degradada"
    : pisoConductor >= pisoGps && pisoConductor > 0 ? "conductor"
    : "gps";

  // `alejando` es un flag HISTÓRICO: se enciende para cualquier parada de la ventana activa y solo
  // se apaga si el bus vuelve a menos de REGRESO_M. Una parada del fondo de la ventana puede
  // haberlo encendido hace 20 minutos (el bus se alejaba de ella mientras atendía otras) y, al
  // llegar su turno como objetivo, la UI diría "el vehículo se aleja" con el bus yendo derecho
  // hacia ella — y borraría su hora de llegada justo cuando más se necesita. Para AFIRMARLO en
  // presente se exige que la racha de alejamiento siga VIGENTE en la última muestra procesada.
  const sProx = proximaIdx != null ? estado.porParada[proximaIdx] : null;
  const seAleja = !!sProx?.alejando && sProx.recStreak >= RACHA_ALEJA;

  return {
    proximaIdx, pasadas, motivo,
    seAleja,
    confianza,
    muestras: estado.muestras,
    ultimaMuestraTs: estado.lastTs,
    pisoConductor, pisoGps,
  };
}

/** Lectura para "¿pasó MI paradero?" — la pregunta del app pasajero. Misma máquina, otra
 *  lectura. Existe para que la futura migración de app/pasajero no necesite un motor propio. */
export function leerParada(
  estado: EstadoAvance,
  paradas: ParadaAvance[],
  idx: number,
): { pasada: boolean; alejando: boolean; motivo: MotivoPaso; minDistM: number | null } {
  const s = estado.porParada[idx];
  const piso = Math.max(pisoDeConductor(paradas), pisoDeGps(estado));
  return {
    pasada:   !!s?.pasada || idx < piso,
    alejando: !!s?.alejando,
    motivo:   paradas[idx]?.completada ? "conductor" : s?.pasada ? "gps" : idx < piso ? "arrastre" : null,
    minDistM: s && Number.isFinite(s.minDist) ? s.minDist : null,
  };
}
