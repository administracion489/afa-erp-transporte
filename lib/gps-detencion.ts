// lib/gps-detencion.ts — ¿DÓNDE está detenida la unidad? (motor PURO)
//
// EL CASO (reserva #30204, PIERIPLAST, 09-10-2026): el bus llegó al PRIMER paradero y esperó ahí
// la hora de salida. El header del modal GPS decía, en ámbar y con pulso de alerta,
// «⚠ Unidad sin movimiento · hace 16 min — GPS pegado o teléfono fuera del bus»: le imputaba al
// conductor un fallo que no ocurrió, en la misma pantalla en la que el mapa enseñaba el bus
// estacionado sobre el paradero.
//
// DE DÓNDE VIENE ESA ALARMA, Y POR QUÉ NO SE BORRA. Nació del caso #951 (CNQ396, 4-jul): el motor
// de ubicación del teléfono se COLGÓ y siguió sirviendo la MISMA posición con la hora al día —151
// fixes byte-idénticos, ±100, 75 min— con el bus haciendo la ruta y el copiloto a bordo (la
// forense está en app/conductor/page.tsx, `registrarFix`). El punto quedó clavado donde se colgó,
// en el ORIGEN, mientras las paradas se completaban; y como `fix_ts` avanzaba, ni «GPS congelado»
// ni «sin señal» disparaban. El detector del modal (`medirQuietud`, abajo) mide solo QUIETUD:
// ninguna posición a más de RADIO_DETENCION_M de la actual durante más de 10 min. Y la quietud
// tiene dos explicaciones opuestas: el dato dejó de describir al bus (#951) o el bus espera
// (#30204). Este módulo separa las dos con la evidencia que hay y SOLO eso — no decide si la
// unidad está quieta (eso lo midió el detector) ni si va tarde (eso es el semáforo de
// puntualidad, lib/retrasos.ts, que ya mide la espera contra la hora).
//
// LO QUE NO SE AFLOJA: la alarma de #951 sigue saliendo idéntica en todo lo que no sea una espera
// demostrable en un paradero. Dos códigos existen para los casos que más se parecen a una espera
// y no lo son:
//   · `posicion_clavada` — la posición lleva POS_CLAVADA_MS sin variar ni un metro. Es la firma
//     de #951 tal cual ocurrió, y no depende de dónde esté el punto: el motor de ubicación se
//     cuelga al iniciar el servicio, o sea JUNTO al primer paradero, que es justo donde una espera
//     sería la lectura normal. Un GPS vivo, aun detenido, varía siempre.
//   · `marcadas_despues` — la unidad está junto al paradero k, pero el conductor ya marcó
//     completado uno POSTERIOR: el servicio avanzó y la unidad no («las paradas completándose»
//     con el GPS clavado). OJO: depende de que las marcas le lleguen FRESCAS al modal — si quien
//     lo abre le pasa una foto de las paradas tomada al abrirlo, una marca posterior no existe
//     para este motor. Por eso no es la única salvaguarda: `posicion_clavada` no mira marcas.
//
// LÍMITE DECLARADO: si el teléfono quedó junto a un paradero CON el GPS vivo (posiciones que
// jitterean: se cayó del bus en la parada, por ejemplo) y el conductor no marcó ninguno posterior,
// la detención se lee como espera. `paradas.hora_llegada` existe (supabase/paradas-hora-llegada.sql,
// la escriben los dos marcados del conductor) pero no cierra este hueco: solo hay hora en los
// paraderos MARCADOS, y el caso es precisamente el que no tiene marcas posteriores — el que sí las
// tiene ya cae en `marcadas_despues`, sin necesidad de saber cuándo se hicieron. Lo que delata el
// caso es el tiempo, y el header lo sigue mostrando («hace N min») con un title que pide
// confirmarlo con el conductor si la espera se prolonga.
//
// PURO A PROPÓSITO: sin React, sin DOM, sin fetch. Único cálculo geométrico: `distM` de ./huella.

import { distM } from "./huella";
import { PRECISION_MAX_M } from "./gps-cobertura";

// ── EL RADIO ─────────────────────────────────────────────────────────────────────────
// 150 m es la resolución con la que el detector YA decidía que la unidad está quieta («ninguna
// posición a más de 150 m de la actual»; antes vivía como literal en ModalGps): la detención
// ocupa un disco de 150 m. Preguntar si esa detención es EN un paradero es preguntar si el
// paradero cae a esa misma distancia del centro de la detención — con otro radio se afirmaría
// «está en el paradero» sobre uno que queda fuera de la zona donde se midió la quietud (radio
// mayor), o se negaría sobre uno que está dentro de ella (radio menor).
//
// SE ELIGIÓ ESTE Y NO EL RADIO DE LLEGADA de lib/proximidad.ts (clamp(120, 1.5·acc, 250) m) por
// dos razones. (1) Contesta otra pregunta: aquel decide el instante de «tu bus ya llegó» con el
// bus EN MARCHA (por eso se adapta a la precisión y exige ≤ 20 km/h); aquí la unidad ya está
// quieta y lo único que hay que saber es si el paradero está en la zona de la quietud. (2) No se
// puede importar: proximidad.ts es SOLO SERVIDOR (crea el cliente service-role al cargarse).
// Copiarlo sería una segunda definición del mismo número. 150 m cae DENTRO de la banda 120-250 de
// aquel radio, así que un paradero al que el servidor ya le declaró «llegó» (y se lo avisó a los
// pasajeros) con GPS de hasta ±100 m —donde su radio no pasa de 150— también es «en paradero»
// aquí. Con GPS muy bueno este es algo más ancho (150 contra 120), y es deliberado: no decide el
// instante de llegar, decide si la detención ocurre en la zona del paradero, y esa zona es el
// mismo disco con el que se midió la quietud.
//
// SE EXPORTA porque es el MISMO número que usa el detector (`medirQuietud`): si alguien afina la
// quietud, la zona del paradero se mueve con ella.
export const RADIO_DETENCION_M = 150;

// ── LA POSICIÓN CLAVADA ──────────────────────────────────────────────────────────────
// 8 min es el MISMO número con el que la app del conductor le muestra «GPS atascado» al propio
// conductor (POS_CLAVADA_MS en app/conductor/page.tsx, `chequearCongelado`). Si el ERP absolviera
// lo que la app ya le está acusando, las dos pantallas contestarían distinto sobre el mismo
// teléfono. No se importa porque allí vive dentro de un efecto del componente: si se afina uno,
// se afina el otro (lo correcto sería que la app lo importe de aquí).
//
// DIFERENCIA DECLARADA CON LA APP: allí se exige además precisión de RED (mediana ≥ 12 m) para no
// molestar al conductor con un falso atascado. Aquí la pregunta es la contraria —si se puede
// RETIRAR una alarma— y una posición idéntica 8 min no es evidencia de espera con NINGUNA
// precisión: un chip satelital sano nunca repite el punto, y con ubicación de red el centroide se
// repite igual esté el bus esperando o con el motor colgado (#951 iba a ±100). Ante la duda, la
// alarma se queda.
export const POS_CLAVADA_MS = 8 * 60_000;

// ── LA PRECISIÓN ─────────────────────────────────────────────────────────────────────
// Con la precisión peor que PRECISION_MAX_M (150 m, el umbral del repo para «esto es triangulación
// de red, no se decide nada con ese fix»: lib/proximidad.ts, lib/avance-paradas.ts,
// lib/gps-cobertura.ts) el error del punto es del tamaño del propio radio, y el paradero «a 80 m»
// puede estar a 300. Una precisión DESCONOCIDA tampoco absuelve: es la regla de lib/proximidad.ts
// (`precision_m ?? 999` → sin decisión) y no la del motor direccional (25 por defecto), porque esta
// afirmación RETIRA una alarma y ante la duda la alarma se queda.
//
// SE JUZGA LA MEDIANA DE LA VENTANA QUIETA, NO EL ÚLTIMO FIX: la quietud se midió sobre diez o más
// minutos de huella, y un solo fix de red que oscila alrededor del umbral (140, 160, 140…) hacía
// saltar el veredicto en cada actualización — retirando y volviendo a poner la alarma con el ruido
// de un punto. No se baja al GEO_ACC_MAX = 80 de la app del conductor: aquel decide un MARCADO
// automático (escribe un dato y avisa a los pasajeros); este, como el «llegó» del servidor, solo
// describe dónde está la unidad, y con la posición clavada ya fuera de juego (arriba) el caso que
// lo motivaba (#951 a ±100) no llega hasta aquí.

export type CodigoDetencion =
  /** La unidad está detenida a ≤ RADIO_DETENCION_M de un paradero que NO es el último, y el
   *  conductor no marcó ninguno posterior: espera de embarque u hora de salida. NO alarma. */
  | "en_paradero"
  /** Detenida junto al ÚLTIMO paradero (el destino) con el servicio todavía en curso: llegó y
   *  nadie lo finalizó. Alarma, pero con SU motivo — no es el GPS ni el teléfono. */
  | "en_destino"
  /** Está junto a un paradero, pero el conductor ya marcó completado uno POSTERIOR: el servicio
   *  avanzó y la unidad no. → la alarma de siempre. */
  | "marcadas_despues"
  /** La posición lleva POS_CLAVADA_MS sin variar ni un metro: firma de #951 (motor de ubicación
   *  colgado). → la alarma de siempre, esté donde esté el punto. */
  | "posicion_clavada"
  /** Ningún paradero con coordenadas dentro del radio → la alarma de siempre. */
  | "lejos_de_paraderos"
  /** La posición existe pero su precisión no permite afirmar a qué distancia está. */
  | "precision_insuficiente"
  /** Sin posición válida de la unidad. */
  | "sin_posicion"
  /** Ningún paradero tiene coordenadas con qué comparar. */
  | "sin_paradas";

export const CODIGOS_DETENCION: readonly CodigoDetencion[] = [
  "en_paradero", "en_destino", "marcadas_despues", "posicion_clavada", "lejos_de_paraderos",
  "precision_insuficiente", "sin_posicion", "sin_paradas",
];

export type VeredictoDetencion =
  | { codigo: "en_paradero"; idx: number; nombre: string; distanciaM: number }
  | { codigo: "en_destino"; idx: number; nombre: string; distanciaM: number }
  | { codigo: "marcadas_despues"; idx: number; nombre: string; distanciaM: number;
      /** Índice del paradero posterior MÁS AVANZADO que el conductor ya marcó. */
      marcadaIdx: number; marcadaNombre: string }
  | { codigo: "posicion_clavada";
      /** Minutos y cantidad de fixes de la racha final de posiciones idénticas. */
      minutos: number; fixes: number }
  | { codigo: "lejos_de_paraderos";
      /** El paradero con coordenadas más cercano, para el detalle. Nunca está dentro del radio. */
      idx: number; nombre: string; distanciaM: number }
  | { codigo: "precision_insuficiente"; accM: number | null }
  | { codigo: "sin_posicion" }
  | { codigo: "sin_paradas" };

/** Una parada en el ORDEN del servicio. `completada` es la marca del conductor. */
export type ParadaDetencion = {
  lat: number | string | null | undefined;
  lng: number | string | null | undefined;
  completada: boolean;
  nombre?: string | null;
};

/** Dónde está detenida la unidad y con qué precisión (la de la ventana quieta, ver arriba). */
export type PosicionDetencion = {
  lat: number | string | null | undefined;
  lng: number | string | null | undefined;
  accM: number | string | null | undefined;
};

/** Evidencia de que el dato sigue vivo: la racha final de posiciones byte-idénticas. */
export type EvidenciaDetencion = {
  clavadaMs?: number | null;
  clavadaFixes?: number | null;
};

/**
 * Número o null. LA TRAMPA QUE EVITA: `Number(null) === 0` y `Number("") === 0`, así que un
 * `Number.isFinite(Number(x))` a secas da por buena una coordenada AUSENTE como si fuera 0 — y
 * una parada sin geocodificar pasaría a estar en (0, 0). Se comprueba la ausencia ANTES de
 * convertir.
 */
function num(v: unknown): number | null {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coordenada utilizable. (0, 0) EXACTO se trata como ausente: es lo que deja aguas arriba un
 * `Number(null)` sin cuidar, y ningún paradero ni bus de esta operación está en el golfo de
 * Guinea. Sin esta guarda, el error de otro módulo se colaría aquí como un paradero real.
 */
function coord(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = num(lat), lo = num(lng);
  if (la == null || lo == null) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (la === 0 && lo === 0) return null;
  return { lat: la, lng: lo };
}

/** Mediana (la central superior con largo par, como la `medAccRec` del modal). */
function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── LA QUIETUD ───────────────────────────────────────────────────────────────────────
/** Una fila de la huella tal como la entrega /api/cliente/gps (modo huella). */
export type FilaQuietud = {
  lat?: unknown;
  lng?: unknown;
  created_at?: string | null;
  timestamp?: string | null;
  precision_m?: unknown;
};

export type Quietud = {
  /** ms desde el último desplazamiento de más de RADIO_DETENCION_M respecto del último punto
   *  (o desde el primer punto, si nunca se movió). 0 con menos de 3 puntos. */
  ms: number;
  /** Centro de la detención: mediana por coordenada de los puntos de la ventana quieta. */
  ancla: { lat: number; lng: number } | null;
  /** Precisión mediana (precision_m) de la ventana quieta; null si ninguno la trae. */
  accM: number | null;
  /** Racha FINAL de posiciones byte-idénticas: cuánto dura y cuántos fixes la forman. */
  clavada: { ms: number; fixes: number };
};

/**
 * Mide la quietud de la unidad sobre la huella del servicio. SE EXTRAJO, NO SE REESCRIBIÓ: `ms` es
 * el `sinMov` que ModalGps calculaba inline (la matriz corre el original copiado literal y exige el
 * mismo resultado), con UNA divergencia declarada — la de lib/gps-cobertura.ts: una fila sin
 * coordenadas utilizables (null, vacía, (0, 0) exacto, fuera de rango) ya no entra como punto. El
 * original la convertía en (0, 0) por `Number(null) === 0`, a miles de km de todo, y eso contaba
 * como «la unidad se movió».
 *
 * Lo que agrega es lo que el header necesita para juzgar la detención EN EL MISMO CÁLCULO que la
 * quietud — antes el lugar se juzgaba con el fix en vivo (`ubic`, cada pocos segundos) y la
 * quietud con la huella (cada 15 s): al arrancar el bus, el fix en vivo salía del radio antes de
 * que la huella pusiera la quietud en cero, y durante ese hueco el header pasaba de «Detenida en
 * X» a la alarma de «GPS pegado» justo cuando el bus empezaba a moverse.
 *   · `ancla`: la MEDIANA de la ventana quieta, no el último punto. Con el bus estacionado cerca
 *     del borde del radio, el último punto cruza el borde con el jitter de cada fix y el header
 *     parpadeaba entre «Detenida en X» y la alarma; la mediana de diez minutos no se mueve.
 *   · `accM`: por lo mismo, la precisión mediana de esa ventana (ver LA PRECISIÓN).
 *   · `clavada`: la racha final de posiciones byte-idénticas (ver LA POSICIÓN CLAVADA). Se mide
 *     sobre todos los puntos, no solo la ventana, pero una racha idéntica cae siempre dentro de
 *     ella: sus puntos están a 0 m del último.
 */
export function medirQuietud(filas: readonly FilaQuietud[] | null | undefined): Quietud {
  const vacia: Quietud = { ms: 0, ancla: null, accM: null, clavada: { ms: 0, fixes: 0 } };
  const pts: { t: number; lat: number; lng: number; acc: number | null }[] = [];
  for (const r of Array.isArray(filas) ? filas : []) {
    const c = coord(r?.lat, r?.lng);
    if (!c) continue;
    const t = new Date((r.created_at || r.timestamp || 0) as string | number).getTime();
    if (!(t > 0)) continue;                      // mismo filtro que el original (`p.t > 0`, NaN incluido)
    pts.push({ t, lat: c.lat, lng: c.lng, acc: num(r.precision_m) });
  }
  pts.sort((a, b) => a.t - b.t);                 // estable: a igual hora, el orden de llegada
  if (pts.length < 3) return vacia;

  const cur = pts[pts.length - 1];
  let k = -1;                                    // último punto FUERA del disco = el último desplazamiento real
  for (let i = pts.length - 1; i >= 0; i--) {
    if (distM(pts[i].lat, pts[i].lng, cur.lat, cur.lng) > RADIO_DETENCION_M) { k = i; break; }
  }
  const ms = cur.t - pts[k >= 0 ? k : 0].t;
  const ventana = pts.slice(k + 1);              // la detención: todos dentro del disco del último punto

  let j = pts.length - 1;
  while (j > 0 && pts[j - 1].lat === cur.lat && pts[j - 1].lng === cur.lng) j--;

  const la = mediana(ventana.map(p => p.lat)), lo = mediana(ventana.map(p => p.lng));
  return {
    ms,
    ancla: la != null && lo != null ? { lat: la, lng: lo } : null,
    accM: mediana(ventana.map(p => p.acc).filter((a): a is number => a != null)),
    clavada: { ms: cur.t - pts[j].t, fixes: pts.length - j },
  };
}

/** Nombre imprimible: el que alguien escribió, o la posición en la ruta si no hay. */
function nombreDe(paradas: readonly ParadaDetencion[], i: number): string {
  const n = (paradas[i]?.nombre ?? "").trim();
  return n || `paradero ${i + 1}`;
}

/**
 * ¿La unidad, que el detector ya declaró QUIETA, está detenida en un paradero?
 *
 * Va de la evidencia al juicio: posición → ¿el dato sigue vivo? → precisión → paradas con
 * coordenadas → distancia → marcas del conductor. La posición clavada va ANTES que la geometría
 * porque no es una afirmación sobre dónde está la unidad sino sobre si el punto la describe: con el
 * motor de ubicación colgado, «está a 7 m del paradero 1» es cierto del dato y falso del bus.
 *
 * Gana el paradero MÁS CERCANO de los que tienen coordenadas; a igual distancia, el de MENOR
 * índice. Ese desempate es el conservador: un índice menor tiene más paraderos detrás que pueden
 * estar marcados, así que es el que más fácil cae en `marcadas_despues`.
 *
 * SE DECIDE CON EL MÁS CERCANO Y NO «CON EL QUE ABSUELVE». En una ruta con lazo (un retorno que
 * pasa a 30 m de un paradero de la ida) la unidad puede estar dentro del radio de dos paraderos;
 * elegir el que no tiene marcas posteriores sería escoger la explicación que retira la alarma, y
 * esa coincidencia es justo la que no se puede distinguir de un teléfono olvidado. El costo del
 * error conservador es una llamada al conductor; el del otro, un servicio sin rastreo que nadie ve.
 *
 * EL ÚLTIMO PARADERO ES OTRA COSA (`en_destino`): ahí no se embarca ni hay hora de salida, y con
 * el servicio en curso lo normal es que llegó y nadie lo finalizó. Solo con 2+ paraderos: con uno
 * solo, el mismo índice es el primero y el último, y la lectura normal de una detención en el
 * único paradero es la del arranque.
 *
 * Las marcas posteriores se miran en TODAS las paradas, también en las que no tienen coordenadas:
 * un paradero sin geocodificar que el conductor marcó sigue siendo la prueba de que el servicio
 * avanzó.
 */
export function juzgarDetencion(
  pos: PosicionDetencion | null | undefined,
  paradas: readonly ParadaDetencion[] | null | undefined,
  evidencia?: EvidenciaDetencion | null,
): VeredictoDetencion {
  const p = pos ? coord(pos.lat, pos.lng) : null;
  if (!p) return { codigo: "sin_posicion" };

  const clavMs = num(evidencia?.clavadaMs);
  if (clavMs != null && clavMs >= POS_CLAVADA_MS) {
    const fx = num(evidencia?.clavadaFixes);
    return { codigo: "posicion_clavada", minutos: Math.floor(clavMs / 60_000), fixes: fx != null && fx > 0 ? Math.floor(fx) : 0 };
  }

  const acc = pos ? num(pos.accM) : null;
  if (acc == null || acc < 0 || acc > PRECISION_MAX_M) return { codigo: "precision_insuficiente", accM: acc };

  const lista = Array.isArray(paradas) ? paradas : [];
  let mejor = -1, mejorD = Infinity;
  for (let i = 0; i < lista.length; i++) {
    const c = coord(lista[i]?.lat, lista[i]?.lng);
    if (!c) continue;
    const d = distM(p.lat, p.lng, c.lat, c.lng);
    if (d < mejorD) { mejorD = d; mejor = i; }   // estricto: a igual distancia queda el de menor índice
  }
  if (mejor < 0) return { codigo: "sin_paradas" };

  if (!(mejorD <= RADIO_DETENCION_M)) {
    return { codigo: "lejos_de_paraderos", idx: mejor, nombre: nombreDe(lista, mejor), distanciaM: mejorD };
  }

  let marcada = -1;
  for (let j = lista.length - 1; j > mejor; j--) {
    if (lista[j]?.completada) { marcada = j; break; }
  }
  if (marcada >= 0) {
    return {
      codigo: "marcadas_despues", idx: mejor, nombre: nombreDe(lista, mejor), distanciaM: mejorD,
      marcadaIdx: marcada, marcadaNombre: nombreDe(lista, marcada),
    };
  }
  if (lista.length >= 2 && mejor === lista.length - 1) {
    return { codigo: "en_destino", idx: mejor, nombre: nombreDe(lista, mejor), distanciaM: mejorD };
  }
  return { codigo: "en_paradero", idx: mejor, nombre: nombreDe(lista, mejor), distanciaM: mejorD };
}

// ── EL RÓTULO DEL HEADER ─────────────────────────────────────────────────────────────
// Las frases viven aquí y no en el TSX por la lección de la ventana del horario del conductor:
// compuesta dentro de la pantalla, una frase puede volver a describir el sistema al revés sin que
// nada falle. Aquí la matriz las fija.

/** Texto de la alarma de siempre (#951), copiado LITERAL del header de ModalGps. */
const TITLE_ALARMA_QUIETO =
  "La unidad no se desplaza con el servicio en curso. Causas: GPS del teléfono PEGADO (pídele apagar/encender la Ubicación; si sigue, reiniciar el celular — caso #951), teléfono fuera del vehículo, o unidad varada. El conductor ya ve esta alerta en su pantalla.";
/** Title de GPS débil, copiado LITERAL del header de ModalGps. */
const TITLE_GPS_DEBIL =
  "GPS de baja precisión del equipo del conductor: pídele activar Alta precisión (GPS satelital) o usar la app nativa.";

export type RotuloDetencion = {
  texto: string;
  /** ¿La detención, por sí sola, es una alarma? */
  alarma: boolean;
  /** ¿La línea, TAL COMO SE PINTA, va en ámbar? Es `alarma` más el aviso de GPS débil del
   *  operador, que la línea nombra en su texto. El header lo usa tal cual: decidir el ámbar en el
   *  TSX con su propia condición es cómo el cliente terminó viendo un ámbar pulsante sobre un
   *  texto neutro que no lo explicaba. Invariante que fija la matriz: ámbar ⟺ el texto lleva ⚠. */
  ambar: boolean;
  title: string;
};

/**
 * Lo que el header del modal dice de una unidad QUIETA (el detector ya decidió que lo está).
 *
 *   · OPERACIÓN, en paradero → «Detenida en X · hace N min», SIN alarma: es una espera. Con GPS
 *     débil la línea lo NOMBRA (« · ⚠ GPS débil ±Nm») y va en ámbar por eso, no por la espera.
 *   · OPERACIÓN, en el destino → alarma con SU motivo: «servicio sin cerrar», sin culpar al GPS.
 *   · OPERACIÓN, el resto    → el texto, el title y el ámbar de siempre, byte a byte (la matriz
 *     los compara contra la expresión original copiada). Con `marcadas_despues` y
 *     `posicion_clavada` el title dice ADEMÁS por qué alarma: si no, el operador ve el bus sobre
 *     el paradero en el mapa y el aviso en ámbar, y concluye que la pantalla se equivoca.
 *   · CLIENTE → nunca alarma, nunca ámbar, nunca imputa. «GPS pegado o teléfono fuera del bus» y
 *     «GPS débil» son diagnósticos del equipo del conductor con una instrucción interna, la misma
 *     doctrina que deja el aviso de «paradas pasadas sin marcar» solo para operación. En paradero
 *     se le dice dónde está la unidad; en el resto, «Ubicación sin cambios», que describe el DATO
 *     y no el vehículo: en #951 el bus SÍ se movía, así que decirle al cliente «unidad detenida»
 *     sería afirmarle algo falso.
 *
 * `debilM` es la precisión mediana de red del equipo (±m; 0 = sana), que el header ya publica.
 */
export function rotuloDetencion(args: {
  veredicto: VeredictoDetencion;
  minutos: number;
  modoCliente: boolean;
  debilM?: number;
}): RotuloDetencion {
  const { veredicto: v, minutos, modoCliente } = args;
  const debilM = args.debilM && args.debilM > 0 ? args.debilM : 0;

  if (modoCliente) {
    if (v.codigo === "en_paradero" || v.codigo === "en_destino") {
      return {
        texto: `Detenida en ${v.nombre} · hace ${minutos} min`,
        alarma: false,
        ambar: false,
        title: `La unidad está detenida en el paradero «${v.nombre}».`,
      };
    }
    return {
      texto: `Ubicación sin cambios · hace ${minutos} min`,
      alarma: false,
      ambar: false,
      title: `La ubicación que reporta la unidad no cambia hace ${minutos} min.`,
    };
  }

  if (v.codigo === "en_paradero") {
    return {
      texto: `Detenida en ${v.nombre} · hace ${minutos} min${debilM > 0 ? ` · ⚠ GPS débil ±${debilM}m` : ""}`,
      alarma: false,
      ambar: debilM > 0,
      title:
        `La unidad lleva ${minutos} min detenida a ${Math.round(v.distanciaM)} m del paradero «${v.nombre}» ` +
        "con el servicio en curso: lo normal es una espera de embarque o de la hora de salida. " +
        "Si se prolonga más de lo previsto, confírmalo con el conductor." +
        (debilM > 0 ? ` ${TITLE_GPS_DEBIL}` : ""),
    };
  }

  if (v.codigo === "en_destino") {
    return {
      texto: `⚠ En el destino final (${v.nombre}) · hace ${minutos} min${debilM > 0 ? ` · ±${debilM}m` : ""} — servicio sin cerrar`,
      alarma: true,
      ambar: true,
      title:
        `La unidad lleva ${minutos} min detenida a ${Math.round(v.distanciaM)} m del destino final «${v.nombre}» ` +
        "y el servicio sigue en curso: lo normal es que llegó y nadie lo finalizó. Pídele al conductor " +
        "que lo cierre en su app; si te dice que ya salió de ahí, el que se quedó es el teléfono." +
        (debilM > 0 ? ` ${TITLE_GPS_DEBIL}` : ""),
    };
  }

  const porQue =
    v.codigo === "marcadas_despues"
      ? `Está junto al paradero «${v.nombre}», pero el conductor ya marcó «${v.marcadaNombre}», que viene después: el servicio avanzó y la unidad no. `
      : v.codigo === "posicion_clavada"
        ? `La posición lleva ${v.minutos} min sin variar ni un metro${v.fixes > 0 ? ` (${v.fixes} posiciones idénticas)` : ""}: ` +
          "un GPS vivo, aun detenido, varía siempre. Es la firma de #951 —el motor de ubicación del teléfono colgado, " +
          "que sigue mandando el mismo punto con la hora al día— aunque el punto caiga junto a un paradero. " +
          "Con ubicación de red el punto también puede repetirse estando quieto: si el conductor confirma que espera, es eso. "
        : "";
  return {
    texto: `⚠ Unidad sin movimiento · hace ${minutos} min${debilM > 0 ? ` · ±${debilM}m` : ""} — GPS pegado o teléfono fuera del bus`,
    alarma: true,
    ambar: true,
    title: porQue + TITLE_ALARMA_QUIETO,
  };
}
