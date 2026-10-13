// lib/monitoreo-estado.ts — ¿DÓNDE ESTÁ CADA UNIDAD Y QUÉ HAY QUE HACER CON ELLA? Motor PURO del
// mapa de /monitoreo: no lee la base, no hace fetch y no mira el reloj por su cuenta (el instante
// entra por parámetro). Quien lee es /api/monitoreo/flota; la pantalla solo pinta lo que sale de aquí.
//
// ── EL DEFECTO QUE LO MOTIVÓ ───────────────────────────────────────────────────────────────
// La pantalla pedía `ubicaciones_gps` de los últimos 30 min, `order("timestamp").limit(500)`, y
// BORRABA el marcador de toda unidad que no viniera en la respuesta. Con la flota activa, 500 filas
// cubren 3-4 minutos: las unidades paradas parpadeaban y desaparecían; pasados 30 min desaparecían
// siempre. El dueño lo pidió así: «cuando un vehículo deja de transmitir debe seguir en el mapa, en
// GRIS, en su última posición». Además medía la edad con `timestamp` (que /api/conductor no manda),
// pintaba de ROJO un cierre de servicio a los 10 min, y dibujaba un marcador por CONDUCTOR mientras
// la lista era por VEHÍCULO (un relevo eran dos buses en el mapa). scripts/prueba-monitoreo-estado.mts
// conserva ese algoritmo copiado literal y exige que reproduzca los cuatro defectos.
//
// ── UNA SOLA IDENTIDAD: LA UNIDAD ──────────────────────────────────────────────────────────
// `claveUnidad` de lib/flota/excesos.ts («p:ID» / «t:ID»): los ids de `vehiculos` y
// `vehiculos_tercero` se SOLAPAN. Servidor, motor, lista, marcadores, KPI y «centrar» usan esta y
// ninguna otra. El conductor viaja como dato (`claveConductor`, mismo prefijo por la misma razón).
//
// ── LA EDAD DE UNA POSICIÓN (`timestamp` NO se usa) ─────────────────────────────────────────
//   posicionTs = min(fix_ts ?? created_at, recibido_en ?? ∞, ahora)
//   enlaceTs   = min(max(created_at, recibido_en), ahora)
// (con las horas del FUTURO ya tratadas: ver abajo — nunca se acotan a «ahora» más allá del margen)
// `created_at` lo pone el TELÉFONO; `fix_ts` es la hora del último fix REAL (solo avanza si el
// contenido del fix avanza: un GPS congelado que re-envía el mismo punto no rejuvenece);
// `recibido_en` lo pone la BASE (gps-equipo-01) y acota un reloj de teléfono adelantado. El enlace
// es otra pregunta: «¿el teléfono sigue hablando con el servidor?» — con el enlace fresco y la
// posición vieja, lo que falla es el GPS, no los datos.
//
// UNA HORA DEL FUTURO NO SE ACOTA A «AHORA»: SE DESCARTA O SE REEMPLAZA. `created_at` y `fix_ts` los
// manda el teléfono sin validar. Acotarlos a «ahora» (lo que se hacía) convertía un reloj adelantado
// unas horas —o un cliente malicioso— en una unidad «En línea» con edad 0 PARA SIEMPRE en esa
// posición: el rojo «Sin señal en ruta» no salía nunca y cada sondeo devolvía ese marcador aunque el
// realtime trajera el real. Hallazgo de seguridad-appsec, 13-10-2026. La regla, con
// MARGEN_RELOJ_FUTURO_MS (5 min) de tolerancia para un reloj que va un poco adelantado:
//   · `created_at` más allá de ahora + margen: si la fila trae `recibido_en` (hora del SERVIDOR), esa
//     es la hora de la posición y de su enlace (y su `fix_ts`, del mismo reloj, se ignora); si no lo
//     trae, la fila se DESCARTA y la unidad se ve con su última fila de hora creíble.
//   · `fix_ts` posterior a `created_at` + margen, o a ahora + margen: se ignora (manda `created_at`).
//   · `recibido_en` más allá de ahora + margen tampoco es creíble (lo pone la base; no debería pasar).
// Dentro del margen sí se acota a «ahora», y eso está acotado: la fila tiene una hora fija y a los
// pocos minutos envejece como cualquier otra. El lector (lib/monitoreo-datos.ts) además pide
// `created_at <= ahora + margen`, para que cinco filas del futuro no ocupen para siempre las
// FILAS_POR_UNIDAD de la consulta.
// Límite declarado: sin `recibido_en` (migración sin correr) un teléfono con el reloj ATRASADO se ve
// más viejo de lo que es; uno ADELANTADO más allá del margen no se ve (sus filas se descartan).
//
// ── EL ORDEN DE LAS FILAS Y LA FUSIÓN EN VIVO ──────────────────────────────────────────────
// La «última» fila es la de mayor (posicionTs, puntoTs, enlaceTs, contenido): un orden TOTAL. Eso
// es lo que permite que `fusionarPosicion` (un INSERT del realtime) dé EXACTAMENTE lo mismo que
// `ultimaPosicion` sobre todas las filas, lleguen en el orden que lleguen — la matriz lo barre. Una
// fila que llega tarde (cola offline) no tapa a una más nueva.
//
// ── EL CIERRE IMPRECISO ────────────────────────────────────────────────────────────────────
// Al pulsar «Finalizar» la app FUERZA un punto `finalizado` con la última posición que tenga, sin
// el filtro de precisión (app/conductor/page.tsx, `forzar`). Si ese punto es peor que
// PRECISION_MAX_M (o no declara precisión), la POSICIÓN sale del último fix preciso anterior DEL
// MISMO SERVICIO y el estado y la hora, del cierre (`aproximada`). Del mismo servicio, y no de
// cualquiera: el fix preciso anterior puede ser de antes de salir, a kilómetros.
// UNA PRECISIÓN ≤ 0 ES «DESCONOCIDA», igual que null: la app del conductor TERCERIZADO escribe
// `precision_m = 0` cuando no la conoce (y en el cierre, siempre). Leído como «0 m», ese cierre se
// dibujaba como exacto. Ningún GPS da una precisión de 0 m.
//
// ── EL VEREDICTO, DE LA EVIDENCIA AL JUICIO (gana el primero que se cumple) ────────────────
//   1 sos              alerta SOS pendiente de un servicio de la unidad            atender
//   2 no_inicio        nada en curso y un servicio sin iniciar pasada su hora+umbral atender
//                      (aunque transmita: está conectada y no pulsó «Iniciar»)
//   3 no_se_pudo_leer  falló la lectura de su GPS (NO es «sin posición»)          sin_dato
//   4 sin_posicion     ninguna posición válida en DIAS_ULTIMA_POSICION             sin_dato
//   5 en_linea         posición de ≤ EN_LINEA_MIN y el punto no es un cierre       vivo
//   6 senal_perdida    servicio en curso y posición de > SENAL_PERDIDA_MIN         atender
//   7 demora           servicio en curso y lo demás (2-5 min, o un cierre ajeno)   demora
//   8 finalizado       el último punto es un cierre de servicio                     reposo
//   9 reposo           todo lo demás                                                reposo
// Sin servicio en curso, sin SOS y sin `no_inicio`, NUNCA rojo ni ámbar: una unidad estacionada
// no es una alarma. Un servicio en curso cuyo propio teléfono ya mandó el cierre no cuenta como
// «en curso» (el estado de la reserva no se actualizó; el teléfono sí cerró).
//
// Matriz: npx tsx scripts/prueba-monitoreo-estado.mts

import { claveConductor, claveUnidad } from "./flota/excesos";
import { PRECISION_MAX_M, SENAL_PERDIDA_MIN } from "./gps-cobertura";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "./alertas-horario";
import { NO_INICIO_MIN_DEFECTO, inicioDe, minutosNoInicio, sinIniciar } from "./escalera-inicio";

export { PRECISION_MAX_M, SENAL_PERDIDA_MIN, NO_INICIO_MIN_DEFECTO };

// ══ CONSTANTES, CON SU PROCEDENCIA ════════════════════════════════════════════════════════

/** HEREDADO de la leyenda anterior de /monitoreo («En línea (menos 2 min)»). Con un equipo sano llega
 *  una posición cada pocos segundos, también parado. */
export const EN_LINEA_MIN = 2;
/** NO MEDIDO. Más allá de esto una posición ya no dice dónde está la unidad: no se dibuja. */
export const DIAS_ULTIMA_POSICION = 30;
/** OPERATIVO. Filas por unidad que pide el lector: la última más las previas para encontrar el fix
 *  preciso anterior a un cierre impreciso. */
export const FILAS_POR_UNIDAD = 5;
/** HEREDADO de `TOLERANCIA_RELOJ_MS` de lib/odometro.ts (5 min): el margen con el que el ERP ya
 *  acepta que un dispositivo diga que algo pasó DESPUÉS de llegar al servidor («nada puede haberse
 *  capturado después de llegar aquí», registrarLectura). Una hora del teléfono más allá de ahora +
 *  esto no es creíble: no se acota, se descarta o se reemplaza por `recibido_en`. El lector usa el
 *  mismo número en su `.lte("created_at", …)`. La matriz coteja los dos literales. */
export const MARGEN_RELOJ_FUTURO_MS = 5 * 60_000;
/** NO MEDIDO. Cuánto tiempo, después de hora + umbral, sigue en rojo un servicio que no se inició.
 *  Pasado eso, el servicio probablemente se hizo sin el app o se reprogramó: gritarlo todo el día
 *  enseña a ignorar el rojo. El lado seguro es subirlo. */
export const VENTANA_NO_INICIO_MIN = 120;

const MIN_MS = 60_000;
const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

// ══ LA FILA Y LA POSICIÓN ═════════════════════════════════════════════════════════════════

type NumLike = number | string | null;

/** Lo que el lector pide de `ubicaciones_gps` (y lo que trae un INSERT del realtime). */
export type FilaGpsMonitoreo = {
  lat: unknown; lng: unknown;
  created_at: string | null;
  fix_ts?: string | null;
  recibido_en?: string | null;
  simulado?: boolean | null;
  precision_m?: NumLike;
  estado?: string | null;
  reserva_id?: NumLike;
  velocidad?: NumLike;
  vehiculo_id?: NumLike;
  vehiculo_tercero_id?: NumLike;
  conductor_id?: NumLike;
  conductor_tercero_id?: NumLike;
};

/** Un punto ya leído y saneado. `orden` es la clave del orden total (solo para fusionar). */
export type PuntoMonitoreo = {
  lat: number; lng: number;
  /** Edad de la posición: min(fix_ts ?? created_at, recibido_en, ahora). */
  posicionTs: number;
  /** Cuándo lo generó el teléfono: min(created_at, recibido_en, ahora). Para un cierre, el clic. */
  puntoTs: number;
  /** Cuándo llegó: min(max(created_at, recibido_en), ahora). */
  enlaceTs: number;
  estado: string | null;
  reservaId: number | null;
  /** «p:ID» / «t:ID» (los ids de conductores y conductores_tercero se solapan). */
  conductor: string | null;
  velocidadKmh: number | null;
  precisionM: number | null;
  orden: string;
};

/** La última posición conocida de UNA unidad, lista para dibujar. */
export type PosicionUnidad = {
  unidad: string;
  lat: number; lng: number;
  /** Edad de lo que se DIBUJA (en un cierre impreciso, la del fix preciso que lo reemplaza). */
  posicionTs: number;
  /** Último contacto del teléfono: la fila que llegó más tarde. */
  enlaceTs: number;
  estado: string | null;
  reservaId: number | null;
  conductor: string | null;
  velocidadKmh: number | null;
  precisionM: number | null;
  /** La posición dibujada no viene de un fix preciso de este instante. */
  aproximada: boolean;
  /** Si la última fila es un cierre: el instante del «Finalizar» (created_at del punto). */
  cierreTs: number | null;
  /** La fila más reciente (manda estado, servicio, conductor y cierre). */
  ultimo: PuntoMonitoreo;
  /** El fix PRECISO más reciente anterior a `ultimo`; solo se guarda si `ultimo` no es preciso. */
  respaldo: PuntoMonitoreo | null;
};

const numero = (x: unknown): number | null => {
  if (x == null || x === "" || typeof x === "boolean") return null;
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) ? v : null;
};
const idPositivo = (x: unknown): number | null => {
  const v = numero(x);
  return v != null && Number.isSafeInteger(v) && v > 0 ? v : null;
};

/** ISO de Postgres o de PostgREST → epoch ms, o null. Tolera «2026-10-13 11:30:00+00». */
function tsDe(x: unknown): number | null {
  if (x == null || x === "") return null;
  let s = String(x).trim();
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  if (/[+-]\d{2}$/.test(s)) s += ":00";
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

const normEstado = (x: unknown): string | null => {
  if (x == null) return null;
  const s = String(x).trim().toLowerCase();
  return s || null;
};

/** ¿El punto es un fix preciso? Una precisión desconocida (null, ≤ 0 o no numérica) NO es precisa. */
const preciso = (p: PuntoMonitoreo): boolean => p.precisionM != null && p.precisionM <= PRECISION_MAX_M;
const esCierre = (estado: string | null): boolean => estado === "finalizado";

const pad = (n: number) => String(Math.round(n)).padStart(15, "0");

/** La unidad de la fila (`claveUnidad`), o null si no trae vehículo. */
export function unidadDeFila(f: FilaGpsMonitoreo): string | null {
  return claveUnidad(f?.vehiculo_id, f?.vehiculo_tercero_id);
}

/** ¿La ficha sigue en la flota? Solo `inactivo` la saca; sin estado, vigente. Misma lectura que
 *  `esVigente` de lib/combustible/saldo-cuenta.ts. */
export function unidadVigente(estado: unknown): boolean {
  return String(estado ?? "").trim().toLowerCase() !== "inactivo";
}

type Leida = PuntoMonitoreo & { unidad: string };

/** Lee y sanea una fila; null si no es una posición de una unidad que se pueda dibujar. */
function leerFila(f: FilaGpsMonitoreo, ahoraMs: number): Leida | null {
  if (!f || f.simulado === true) return null;
  const unidad = unidadDeFila(f);
  if (!unidad) return null;
  if (f.lat == null || f.lng == null) return null;
  const lat = numero(f.lat), lng = numero(f.lng);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;                   // la «isla nula»: un GPS sin dato
  // Una hora del FUTURO no se acota a «ahora»: se descarta o se reemplaza (cabecera, «LA EDAD…»).
  const limite = ahoraMs + MARGEN_RELOJ_FUTURO_MS;
  const creible = (t: number | null): number | null => (t != null && t <= limite ? t : null);
  const recibido = creible(tsDe(f.recibido_en));
  const creadoTel = tsDe(f.created_at);
  const creadoFuturo = creadoTel != null && creadoTel > limite;
  if (creadoFuturo && recibido == null) return null;          // reloj adelantado y sin hora del servidor
  const creado = creadoFuturo ? recibido : creadoTel;          // la del servidor en lugar de la del teléfono
  // fix_ts es del mismo reloj: con created_at del futuro no vale, y nunca después de created_at + margen.
  let fix = creadoFuturo ? null : creible(tsDe(f.fix_ts));
  if (fix != null && creado != null && fix > creado + MARGEN_RELOJ_FUTURO_MS) fix = null;
  const base = fix ?? creado;
  if (base == null && recibido == null) return null;
  const posicionTs = Math.min(base ?? Infinity, recibido ?? Infinity, ahoraMs);
  if (posicionTs < ahoraMs - DIAS_ULTIMA_POSICION * DIA_MS) return null;
  const puntoTs = Math.min(creado ?? recibido ?? Infinity, recibido ?? Infinity, ahoraMs);
  const enlaceTs = Math.min(Math.max(creado ?? -Infinity, recibido ?? -Infinity), ahoraMs);
  const prec = numero(f.precision_m);
  // ≤ 0 = desconocida (la app del tercerizado escribe 0 cuando no la sabe): mismo trato que null.
  const precisionM = prec != null && prec > 0 ? prec : null;
  const vel = numero(f.velocidad);
  const velocidadKmh = vel != null && vel >= 0 ? vel : null;
  const estado = normEstado(f.estado);
  const reservaId = idPositivo(f.reserva_id);
  const conductor = claveConductor(f.conductor_id, f.conductor_tercero_id);
  const contenido = JSON.stringify([estado, lat, lng, reservaId, conductor, velocidadKmh, precisionM]);
  return {
    unidad, lat, lng, posicionTs, puntoTs, enlaceTs, estado, reservaId, conductor, velocidadKmh, precisionM,
    orden: `${pad(posicionTs)}|${pad(puntoTs)}|${pad(enlaceTs)}|${contenido}`,
  };
}

const sinUnidad = (l: Leida): PuntoMonitoreo => {
  const { unidad: _u, ...p } = l;
  void _u;
  return p;
};

/** Arma la posición dibujable a partir de la última fila, su respaldo preciso y el último enlace. */
function armar(unidad: string, ultimo: PuntoMonitoreo, respaldo: PuntoMonitoreo | null, enlaceTs: number): PosicionUnidad {
  const cierre = esCierre(ultimo.estado);
  const sustituye = cierre && !preciso(ultimo) && respaldo != null
    && ultimo.reservaId != null && respaldo.reservaId === ultimo.reservaId;
  const fuente = sustituye ? respaldo! : ultimo;
  const aproximada = sustituye
    || (cierre ? !preciso(ultimo) : ultimo.precisionM != null && ultimo.precisionM > PRECISION_MAX_M);
  return {
    unidad,
    lat: fuente.lat, lng: fuente.lng,
    posicionTs: fuente.posicionTs,
    enlaceTs,
    estado: ultimo.estado,
    reservaId: ultimo.reservaId,
    conductor: ultimo.conductor,
    velocidadKmh: ultimo.velocidadKmh,
    precisionM: fuente.precisionM,
    aproximada,
    cierreTs: cierre ? ultimo.puntoTs : null,
    ultimo,
    respaldo: preciso(ultimo) ? null : respaldo,
  };
}

/**
 * La última posición de UNA unidad a partir de sus filas (las que pide el lector, en cualquier
 * orden). Descarta simulados, lat/lng nulos o no numéricos, (0,0), filas sin vehículo, posiciones
 * de más de DIAS_ULTIMA_POSICION y filas con `created_at` del futuro sin `recibido_en`. Si llegaran filas de varias unidades, manda la de la fila más
 * reciente y las otras se ignoran. null = ninguna posición válida.
 */
export function ultimaPosicion(filas: FilaGpsMonitoreo[], ahoraMs: number): PosicionUnidad | null {
  const leidas: Leida[] = [];
  for (const f of filas ?? []) {
    const l = leerFila(f, ahoraMs);
    if (l) leidas.push(l);
  }
  if (!leidas.length) return null;
  leidas.sort((a, b) => (a.orden < b.orden ? 1 : a.orden > b.orden ? -1 : 0));
  const unidad = leidas[0].unidad;
  const mias = leidas.filter((l) => l.unidad === unidad);
  const ultimo = sinUnidad(mias[0]);
  const enlace = Math.max(...mias.map((l) => l.enlaceTs));
  let respaldo: PuntoMonitoreo | null = null;
  if (!preciso(ultimo)) {
    const r = mias.slice(1).find((l) => preciso(l));
    respaldo = r ? sinUnidad(r) : null;
  }
  return armar(unidad, ultimo, respaldo, enlace);
}

/**
 * Suma UNA fila (un INSERT del realtime) a la posición que ya se tenía. Plegar esta función sobre
 * las filas, en CUALQUIER orden de llegada, da exactamente `ultimaPosicion` de todas ellas. Una fila
 * inválida o de otra unidad deja la posición como estaba.
 */
export function fusionarPosicion(actual: PosicionUnidad | null, fila: FilaGpsMonitoreo, ahoraMs: number): PosicionUnidad | null {
  const l = leerFila(fila, ahoraMs);
  if (!l) return actual;
  const p = sinUnidad(l);
  if (!actual) return armar(l.unidad, p, null, p.enlaceTs);
  if (l.unidad !== actual.unidad) return actual;
  const enlace = Math.max(actual.enlaceTs, p.enlaceTs);
  const H = actual.ultimo, R = actual.respaldo;
  if (p.orden > H.orden) {
    // Fila nueva: la anterior pasa a ser candidata a respaldo si era precisa.
    return armar(actual.unidad, p, preciso(p) ? null : preciso(H) ? H : R, enlace);
  }
  if (p.orden === H.orden) return enlace === actual.enlaceTs ? actual : armar(actual.unidad, H, R, enlace);
  // Fila anterior a la última: solo puede mejorar el respaldo.
  const R2 = !preciso(H) && preciso(p) && (R == null || p.orden > R.orden) ? p : R;
  if (R2 === R && enlace === actual.enlaceTs) return actual;
  return armar(actual.unidad, H, R2, enlace);
}

// ══ LOS SERVICIOS DE LA UNIDAD ════════════════════════════════════════════════════════════

/** inicioMs = fecha + hora del servicio en Lima (null sin fecha o sin hora). */
export type ServicioUnidad = { reservaId: number; estado: string; inicioMs: number | null };

/** "2026-10-13" + "06:30[:00]" en hora Lima → epoch ms. La MISMA lectura de la escalera de inicio
 *  (`inicioDe`): sin hora no hay a qué anclar el «no inició». */
export function inicioServicioMs(fecha: string | null, hora: string | null): number | null {
  return inicioDe({ fecha_servicio: fecha, hora_servicio: hora });
}

// ══ EL VEREDICTO ══════════════════════════════════════════════════════════════════════════

export type CodigoMonitoreo =
  | "sos" | "no_inicio" | "no_se_pudo_leer" | "sin_posicion" | "en_linea"
  | "senal_perdida" | "demora" | "finalizado" | "reposo";
export type ClaseMonitoreo = "atender" | "vivo" | "demora" | "reposo" | "sin_dato";

/** Los códigos en el orden en que se juzgan (gana el primero). */
export const CODIGOS_MONITOREO: readonly CodigoMonitoreo[] = [
  "sos", "no_inicio", "no_se_pudo_leer", "sin_posicion", "en_linea",
  "senal_perdida", "demora", "finalizado", "reposo",
];
/** Las clases en el orden de la lista y de los chips. */
export const CLASES_MONITOREO: readonly ClaseMonitoreo[] = ["atender", "vivo", "demora", "reposo", "sin_dato"];

export const COLOR_CLASE: Record<ClaseMonitoreo, string> = {
  atender: "#dc2626", vivo: "#16a34a", demora: "#d97706", reposo: "#64748b", sin_dato: "#94a3b8",
};
/** Rótulo de cada clase para los chips/filtros. `sin_dato` junta «sin posición» y «no se pudo leer»:
 *  llamarlo «Sin posición» afirmaría de una lectura fallida algo que no se sabe. */
export const ETIQUETA_CLASE: Record<ClaseMonitoreo, string> = {
  atender: "Atender", vivo: "En línea", demora: "Demora", reposo: "Estacionadas", sin_dato: "Sin dato",
};

export const TEXTO_CODIGO: Record<CodigoMonitoreo, { clase: ClaseMonitoreo; color: string; etiqueta: string }> = {
  sos:             { clase: "atender",  color: COLOR_CLASE.atender,  etiqueta: "SOS" },
  no_inicio:       { clase: "atender",  color: COLOR_CLASE.atender,  etiqueta: "No inició" },
  no_se_pudo_leer: { clase: "sin_dato", color: COLOR_CLASE.sin_dato, etiqueta: "No se pudo leer" },
  sin_posicion:    { clase: "sin_dato", color: COLOR_CLASE.sin_dato, etiqueta: "Sin posición" },
  en_linea:        { clase: "vivo",     color: COLOR_CLASE.vivo,     etiqueta: "En línea" },
  senal_perdida:   { clase: "atender",  color: COLOR_CLASE.atender,  etiqueta: "Sin señal en ruta" },
  demora:          { clase: "demora",   color: COLOR_CLASE.demora,   etiqueta: "Señal demorada" },
  finalizado:      { clase: "reposo",   color: COLOR_CLASE.reposo,   etiqueta: "Cerró servicio" },
  reposo:          { clase: "reposo",   color: COLOR_CLASE.reposo,   etiqueta: "Estacionada" },
};

export type VeredictoUnidad = {
  codigo: CodigoMonitoreo;
  clase: ClaseMonitoreo;
  color: string;
  etiqueta: string;
  detalle: string;
  /** Minutos desde la posición dibujada (≥ 0), o null sin posición. */
  edadMin: number | null;
  /** ⟺ hay posición válida y la lectura no falló. */
  dibujar: boolean;
  /** ⟺ clase `reposo`: marcador gris y atenuado. */
  atenuado: boolean;
  /** MAYOR = más arriba en la lista y encima en el mapa (sirve tal cual de z-index). Clase
   *  (atender > vivo > demora > reposo > sin_dato), dentro de atender SOS > no inició > sin señal,
   *  y después la posición más reciente primero. */
  prioridad: number;
};

const RANGO_CLASE: Record<ClaseMonitoreo, number> = { atender: 4, vivo: 3, demora: 2, reposo: 1, sin_dato: 0 };
const RANGO_CODIGO: Partial<Record<CodigoMonitoreo, number>> = { sos: 2, no_inicio: 1 };

// ── Rótulos de tiempo (hora de Lima, UTC-5 fijo) ────────────────────────────

const hhmmDe = (ms: number) => minutosAHhmm(minutoDelDiaLima(ms));
function diaAnterior(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DIA_MS).toISOString().slice(0, 10);
}
/** "12/09" (o "12/09/2025" si es de otro año que `hoy`). */
function diaCorto(dia: string, hoy: string): string {
  const [y, m, d] = dia.split("-");
  return y === hoy.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** Cuánto hace: "hace menos de 1 min" · "hace 3 min" · "hace 2 h" (mismo día) · "ayer 18:40" ·
 *  "12/09 18:40". Un instante en el futuro cuenta como ahora. */
export function rotuloEdad(ts: number, ahoraMs: number): string {
  const d = Math.max(0, ahoraMs - ts);
  if (d < MIN_MS) return "hace menos de 1 min";
  if (d < HORA_MS) return `hace ${Math.floor(d / MIN_MS)} min`;
  const dia = fechaLima(ts), hoy = fechaLima(ahoraMs);
  if (dia === hoy) return `hace ${Math.floor(d / HORA_MS)} h`;
  if (dia === diaAnterior(hoy)) return `ayer ${hhmmDe(ts)}`;
  return `${diaCorto(dia, hoy)} ${hhmmDe(ts)}`;
}

/** A qué hora: "18:40" (hoy) · "ayer 18:40" · "12/09 18:40". */
export function rotuloMomento(ts: number, ahoraMs: number): string {
  const dia = fechaLima(ts), hoy = fechaLima(ahoraMs);
  if (dia === hoy) return hhmmDe(ts);
  if (dia === diaAnterior(hoy)) return `ayer ${hhmmDe(ts)}`;
  return `${diaCorto(dia, hoy)} ${hhmmDe(ts)}`;
}

/** "hace 7 min" se lee solo; "ayer 18:40" necesita un «desde». */
const desde = (ts: number, ahoraMs: number) => {
  const r = rotuloEdad(ts, ahoraMs);
  return r.startsWith("hace") ? r : `desde ${r}`;
};

/**
 * El veredicto de UNA unidad. `servicios` son los suyos que importan hoy (los del día sin cerrar y
 * los de ayer que siguen en curso); `sosPendiente`, si alguno tiene una alerta SOS sin atender;
 * `noInicioMin`, el umbral de `alerta_config.no_inicio` (inválido → NO_INICIO_MIN_DEFECTO).
 */
export function juzgarUnidad(e: {
  posicion: PosicionUnidad | null; lecturaOk: boolean; servicios: ServicioUnidad[];
  sosPendiente: boolean; ahoraMs: number; noInicioMin: number;
}): VeredictoUnidad {
  const { posicion, ahoraMs } = e;
  const lecturaOk = e.lecturaOk === true;
  const umbral = minutosNoInicio({ activo: true, umbral: e.noInicioMin });
  const edadMs = posicion ? Math.max(0, ahoraMs - posicion.posicionTs) : null;
  const edadMin = edadMs == null ? null : Math.floor(edadMs / MIN_MS);
  const enlaceFresco = posicion != null && ahoraMs - posicion.enlaceTs <= EN_LINEA_MIN * MIN_MS;
  const cierre = posicion != null && esCierre(posicion.estado);

  const servicios = (e.servicios ?? []).map((s) => ({ ...s, estado: normEstado(s.estado) ?? "" }));
  // Un servicio que su propio teléfono ya cerró no está «en curso» para el mapa.
  const enCurso = servicios.filter((s) => s.estado === "en_curso"
    && !(cierre && posicion!.reservaId != null && s.reservaId === posicion!.reservaId));
  const pendientes = enCurso.length ? [] : servicios
    .filter((s) => sinIniciar(s.estado) && s.inicioMs != null && Number.isFinite(s.inicioMs))
    .filter((s) => {
      const desdeMs = s.inicioMs! + umbral * MIN_MS;
      return ahoraMs >= desdeMs && ahoraMs < desdeMs + VENTANA_NO_INICIO_MIN * MIN_MS;
    })
    .sort((a, b) => a.inicioMs! - b.inicioMs!);

  const ultimaPos = posicion ? `última posición ${rotuloEdad(posicion.posicionTs, ahoraMs)}` : "sin posición GPS";
  const conectado = enlaceFresco ? " · el teléfono sigue conectado" : "";

  let codigo: CodigoMonitoreo;
  let detalle: string;
  if (e.sosPendiente === true) {
    codigo = "sos";
    detalle = `Alerta SOS sin atender · ${ultimaPos}`;
  } else if (pendientes.length) {
    codigo = "no_inicio";
    const otros = pendientes.length - 1;
    const transmite = posicion && edadMs! <= EN_LINEA_MIN * MIN_MS ? " · el teléfono está transmitiendo" : "";
    detalle = `Servicio de las ${hhmmDe(pendientes[0].inicioMs!)} sin iniciar`
      + (otros ? ` (y ${otros} más)` : "") + transmite;
  } else if (!lecturaOk) {
    codigo = "no_se_pudo_leer";
    detalle = "No se pudo leer su GPS en esta actualización; no significa que no tenga posición";
  } else if (!posicion) {
    codigo = "sin_posicion";
    detalle = `Sin posiciones GPS en los últimos ${DIAS_ULTIMA_POSICION} días`;
  } else if (edadMs! <= EN_LINEA_MIN * MIN_MS && !cierre) {
    codigo = "en_linea";
    const vel = posicion.velocidadKmh != null && posicion.velocidadKmh > 0 ? ` · ${Math.round(posicion.velocidadKmh)} km/h` : "";
    detalle = (enCurso.length ? "En servicio · última posición " : "Última posición ")
      + rotuloEdad(posicion.posicionTs, ahoraMs) + vel;
  } else if (enCurso.length && edadMs! > SENAL_PERDIDA_MIN * MIN_MS) {
    codigo = "senal_perdida";
    detalle = `En servicio y sin posición nueva ${desde(posicion.posicionTs, ahoraMs)}${conectado}`;
  } else if (enCurso.length) {
    codigo = "demora";
    detalle = cierre
      ? `En servicio · su último punto es el cierre de otro servicio, ${rotuloEdad(posicion.posicionTs, ahoraMs)}`
      : `En servicio · última posición ${rotuloEdad(posicion.posicionTs, ahoraMs)}${conectado}`;
  } else if (cierre) {
    codigo = "finalizado";
    detalle = `Cerró servicio · ${rotuloMomento(posicion.cierreTs ?? posicion.posicionTs, ahoraMs)}`
      + (posicion.aproximada ? " · posición aproximada" : "");
  } else {
    codigo = "reposo";
    detalle = `Última posición ${rotuloEdad(posicion.posicionTs, ahoraMs)}${conectado}`;
  }

  const t = TEXTO_CODIGO[codigo];
  const frescura = edadMin == null ? 0 : Math.max(0, 999_999 - edadMin);
  return {
    codigo, clase: t.clase, color: t.color, etiqueta: t.etiqueta, detalle,
    edadMin,
    dibujar: posicion != null && lecturaOk,
    atenuado: t.clase === "reposo",
    prioridad: RANGO_CLASE[t.clase] * 10_000_000 + (RANGO_CODIGO[codigo] ?? 0) * 1_000_000 + frescura,
  };
}

/** Cuántas unidades hay en cada clase. Disjunto y exhaustivo: la suma de las clases es `total`. */
export function resumenFlota(v: VeredictoUnidad[]): Record<ClaseMonitoreo, number> & { total: number } {
  const r = { atender: 0, vivo: 0, demora: 0, reposo: 0, sin_dato: 0, total: 0 };
  for (const x of v ?? []) {
    r[x.clase]++;
    r.total++;
  }
  return r;
}

// ══ LA RESPUESTA DE /api/monitoreo/flota ══════════════════════════════════════════════════

export type RespuestaFlotaMonitoreo = {
  generado_en: string;
  /** Fecha de Lima del cálculo (`fechaLima`). */
  hoy: string;
  ventana_dias: number;
  no_inicio_min: number;
  fuente_no_inicio: "config" | "defecto";
  /** Las unidades que el servidor consideró VIGENTES y quiso leer («p:ID» / «t:ID»). Contiene a
   *  `posiciones[].unidad` y a `sin_leer`, que son disjuntas; una de aquí que no está en ninguna de
   *  las dos se LEYÓ y no tiene posición válida en la ventana. Una unidad que la pantalla conoce y
   *  no está aquí NO se leyó (alta reciente, caché): no es «sin posición». */
  unidades: string[];
  posiciones: PosicionUnidad[];
  /** Unidades cuya lectura falló: `no_se_pudo_leer`, NUNCA «sin posición». */
  sin_leer: string[];
  /** Se agotó el presupuesto de tiempo antes de leerlas todas. */
  parcial: boolean;
  /** Columnas de migraciones accesorias que esta base no tiene: las de `ubicaciones_gps` por su
   *  nombre («fix_ts») y el `estado` de la flota calificado («vehiculos.estado»: sin ella, todas
   *  esas unidades cuentan como vigentes). */
  columnas_faltantes: string[];
};
