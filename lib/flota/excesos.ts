// ──────────────────────────────────────────────────────────────────────────────
// lib/flota/excesos.ts — Motor PURO: los EXCESOS DE VELOCIDAD sostenidos y corroborados.
//
// Responde «¿quién manejó por encima del umbral, cuánto tiempo y dónde?» con lo que ya llega al
// servidor: `ubicaciones_gps.velocidad` (la del sensor del teléfono, en km/h) y las posiciones. No lee
// la base ni hace fetch: recibe puntos y devuelve decisiones con su CÓDIGO declarado. Quien lee es
// lib/flota/excesos-datos.ts (y, para la estadística por servicio, la traza de la torre).
//
// POR QUÉ NO BASTA CON `velocidad >= 90`: el proveedor FUSED de Android reporta velocidad FANTASMA
// (> 0) con el bus DETENIDO, justo en los saltos del jitter (lib/huella.ts, `limpiarHuella`), y un
// pico suelto de un fix es ruido. Un número así acusaría a un conductor parado en un paradero. Por eso
// un exceso es una RACHA y se corrobora con la geometría:
//
// ─── QUÉ ES UN EPISODIO ─────────────────────────────────────────────────────
// Una racha de muestras del MISMO conductor (y del mismo servicio) con `velocidad >= umbral` y sin
// pausas mayores a GAP_EPISODIO_S entre ellas. La clave del conductor lleva la tabla (`p:ID` / `t:ID`):
// los ids de `conductores` y `conductores_tercero` se SOLAPAN. Las muestras por debajo del umbral se
// IGNORAN — no rompen ni alargan la racha—, y esa es la propiedad que lo hace correcto («LOCALIDAD»):
// detectar sobre la traza entera y detectar sobre solo los puntos rápidos da EXACTAMENTE lo mismo. Así
// coinciden /seguridad-vial (que lee solo los rápidos con un índice, fn_gps_puntos_rapidos) y la
// estadística por servicio (que lee la traza entera de cada servicio).
//
// ─── EL VEREDICTO, DE LA EVIDENCIA AL JUICIO (gana el primero que aplique) ───
//   1 simulado        alguna posición viene de un GPS simulado                         no cuenta
//   2 imposible       el sensor o la geometría pasan de 130 km/h (no es un bus)        no cuenta
//   3 breve           menos de 30 s o menos de 3 muestras                              no cuenta
//   4 impreciso       precisión mediana desconocida o peor que 20 m                    no cuenta
//   5 sin_corroborar  la geometría da menos del 90 % del umbral (la firma del fantasma) no cuenta
//   6 exceso          ninguna de las anteriores                                        CUENTA
// La velocidad geométrica es la suma de cuerdas entre muestras consecutivas sobre la duración: una
// COTA INFERIOR de lo recorrido (una curva siempre es más larga que su cuerda), así que corroborar con
// ella nunca acusa de más.
//
// ─── TRI-ESTADO ─────────────────────────────────────────────────────────────
// Un conductor cuyo teléfono no reporta la velocidad del sensor (siempre 0: muchos tercerizados por
// navegador) NO sale como «0 excesos»: sale como «no se puede juzgar» (`velocimetroDe`). Un exceso
// fuera de servicio (punto sin `reserva_id`: la app abierta sin servicio) no prueba que el teléfono
// iba en el bus: se lista APARTE y no suma al ranking.
//
// Matriz: npx tsx scripts/prueba-excesos.mts
// Medición sobre datos reales (solo lee): npx tsx scripts/diagnostico-excesos.mts <desde> <hasta>
// ──────────────────────────────────────────────────────────────────────────────

import { distM, ACC_CONFIABLE_M } from "../huella";
import { fechaLima, limaAUtcMs } from "../alertas-horario";
import type { IdentidadRuta } from "../ruta-identidad";

// ══ CONSTANTES, CON SU PROCEDENCIA ════════════════════════════════════════════════════════

/** Umbral por defecto. VALOR POR DEFECTO ELEGIBLE, no medido: 90 km/h es el límite habitual para buses
 *  de pasajeros en carretera según el Reglamento Nacional de Tránsito. Una transcripción secundaria
 *  del TUO (D.S. 016-2009-MTC) lo ubica en el art. 162, b).2 («vehículos del servicio público de
 *  transporte de pasajeros»), pero no se cotejó contra el texto oficial vigente: por eso NINGÚN texto
 *  que se imprime cita el artículo. Un solo umbral para toda vía: en la ciudad los límites son menores,
 *  y la pantalla deja bajarlo. */
export const UMBRAL_DEFECTO_KMH = 90;
/** ESTRUCTURAL: el piso del índice parcial `idx_gps_rapidos` (`WHERE velocidad >= 60`) y del literal de
 *  `fn_gps_puntos_rapidos`. Un umbral menor afirmaría en silencio que no hubo puntos entre él y 60. Si se
 *  cambia, se cambia en los TRES sitios (la matriz coteja el SQL). */
export const UMBRAL_MIN_KMH = 60;
/** HEREDADO: `VMAX_BUS_KMH` de lib/huella.ts (130), el mismo techo con que la huella descarta un salto
 *  imposible. Allí no se exporta; la matriz comprueba que el literal siga siendo este. */
export const UMBRAL_MAX_KMH = 130;
/** PEDIDO DEL DUEÑO, NO MEDIDO: un exceso «sostenido» dura al menos esto. Lado seguro: SUBIRLO. */
export const DURACION_MIN_S = 30;
/** PEDIDO DEL DUEÑO, NO MEDIDO: y tiene al menos estas muestras. Lado seguro: SUBIRLO. */
export const PUNTOS_MIN = 3;
/** NO MEDIDO: la pausa máxima entre dos muestras de la misma racha, ≈ 3 muestras a la cadencia de
 *  carretera de la app (3 s). No tiene un lado seguro: subirlo UNE rachas (dos picos breves pueden
 *  sumar un exceso); bajarlo PARTE una en dos (y el conteo sube). Se mide con el diagnóstico. */
export const GAP_EPISODIO_S = 10;
/** NO MEDIDO: la geometría tiene que dar al menos este factor del umbral para corroborar al sensor.
 *  Lado seguro: SUBIRLO. */
export const FACTOR_CORROBORA = 0.9;
/** HEREDADO: `ACC_CONFIABLE_M` de lib/huella.ts — el MISMO corte que separa el chip satelital de la
 *  ubicación por red, no uno parecido. Por encima, la posición no corrobora nada. */
export const PRECISION_CORROBORA_M = ACC_CONFIABLE_M;
/** ESTRUCTURAL: colchón con que se leen los bordes de un rango. Tiene que ser ≥ GAP_EPISODIO_S: es lo
 *  que garantiza que una racha que se ve empezar dentro del rango empieza ahí de verdad. */
export const COLCHON_S = 60;
/** ESTRUCTURAL: cuando una racha sigue viva al final de la lectura, se lee de a este tramo más. */
export const EXTENSION_MS = 2 * 3_600_000;
/** ESTRUCTURAL: como mucho estas extensiones (12 h). Si aun así sigue viva, el episodio sale `cortado`. */
export const MAX_EXTENSIONES = 6;
/** Rango máximo de una consulta a /api/flota/excesos (la pantalla pide un mes en tandas de 7 días). */
export const MAX_DIAS_CONSULTA = 7;
/** OPERATIVO (contrato de la API): el umbral de /api/flota/excesos y /api/flota/servicios solo se
 *  acepta de este paso en este paso (60, 65, 70… 130: 15 valores). No es una regla del motor —
 *  `detectarExcesos` juzga con cualquier número—: es un tope contra el abuso. El umbral entra en la
 *  clave de la caché de las dos rutas, y con cualquier entero entre 60 y 130 bastaba con variarlo para
 *  esquivarla y obligar a leer la traza de toda la flota otra vez. Las pantallas ofrecen este mismo paso. */
export const PASO_UMBRAL_KMH = 5;
/** HEREDADO: `DIAS_RASTREO` de lib/gps-cobertura-datos.ts (90), el mismo límite de la torre y de
 *  /api/flota/servicios. `desde` no puede ser anterior a hoy − esto. No se importa de allí porque ese
 *  módulo crea el cliente service-role al cargarse y este se usa en el navegador; la ruta le pasa
 *  `DIAS_RASTREO` a `validarConsultaExcesos` y la matriz coteja que los dos literales sigan iguales. */
export const DIAS_ATRAS_MAX_EXCESOS = 90;
/** Decimales con que sale el PICO de un exceso FUERA de servicio (~1 km). Sin servicio no hay nada que
 *  pruebe que el teléfono iba en el bus: es la app abierta en el auto de alguien, y la posición exacta
 *  (su casa, su barrio) no le sirve a la seguridad vial de la flota. Los de servicio salen exactos. */
export const DECIMALES_PICO_FUERA = 2;
/** Tope de puntos por llamada de `fn_gps_puntos_rapidos` (si se alcanza, el día sale `recortado`). */
export const TOPE_PUNTOS_LLAMADA = 60_000;
/** La migración que crea las dos funciones. La pantalla la nombra cuando falta. */
export const MIGRACION_EXCESOS = "supabase/gps-analitica-01-excesos.sql";
export const RPC_PUNTOS_RAPIDOS = "fn_gps_puntos_rapidos";
export const RPC_VELOCIMETRO = "fn_gps_velocimetro";

const DIA_MS = 86_400_000;
const GAP_MS = GAP_EPISODIO_S * 1000;

export type ProcedenciaConstante = "valor_por_defecto" | "estructural" | "heredada" | "pedido_del_dueno" | "no_medida";
export type ConstanteExcesos = {
  clave: string;
  valor: number;
  unidad: string;
  procedencia: ProcedenciaConstante;
  /** Hacia dónde moverla sin acusar de más; null cuando no hay un lado seguro (se dice por qué). */
  ladoSeguro: "subir" | "bajar" | null;
  nota: string;
};

/** Lo que la pantalla enseña en «Cómo se mide», tal cual lo usa el motor. */
export const CONSTANTES_EXCESOS: readonly ConstanteExcesos[] = [
  { clave: "UMBRAL_DEFECTO_KMH", valor: UMBRAL_DEFECTO_KMH, unidad: "km/h", procedencia: "valor_por_defecto", ladoSeguro: null,
    nota: "90 km/h, el límite habitual para buses de pasajeros en carretera según el Reglamento Nacional de Tránsito. Es un valor por defecto elegible: un solo umbral para toda vía, y en la ciudad los límites son menores." },
  { clave: "UMBRAL_MIN_KMH", valor: UMBRAL_MIN_KMH, unidad: "km/h", procedencia: "estructural", ladoSeguro: null,
    nota: "El piso del índice de la base que lee solo los puntos rápidos: por debajo no se puede medir con esta lectura." },
  { clave: "UMBRAL_MAX_KMH", valor: UMBRAL_MAX_KMH, unidad: "km/h", procedencia: "heredada", ladoSeguro: null,
    nota: "Por encima no es un bus: es un error del GPS. El mismo techo con que la huella del recorrido descarta un salto imposible." },
  { clave: "DURACION_MIN_S", valor: DURACION_MIN_S, unidad: "s", procedencia: "pedido_del_dueno", ladoSeguro: "subir",
    nota: "Un exceso sostenido dura al menos esto. No está medido." },
  { clave: "PUNTOS_MIN", valor: PUNTOS_MIN, unidad: "muestras", procedencia: "pedido_del_dueno", ladoSeguro: "subir",
    nota: "Y tiene al menos estas muestras. No está medido." },
  { clave: "GAP_EPISODIO_S", valor: GAP_EPISODIO_S, unidad: "s", procedencia: "no_medida", ladoSeguro: null,
    nota: "La pausa máxima entre dos muestras del mismo exceso (unas 3 muestras en carretera). Subirla une rachas; bajarla parte una en dos: no tiene un lado seguro." },
  { clave: "FACTOR_CORROBORA", valor: FACTOR_CORROBORA, unidad: "× umbral", procedencia: "no_medida", ladoSeguro: "subir",
    nota: "Las posiciones tienen que confirmar al menos este factor del umbral; si no, es la velocidad fantasma del GPS con el bus detenido." },
  { clave: "PRECISION_CORROBORA_M", valor: PRECISION_CORROBORA_M, unidad: "m", procedencia: "heredada", ladoSeguro: "bajar",
    nota: "Con una precisión mediana peor que esto la posición no corrobora la velocidad. El mismo corte que separa el chip satelital de la ubicación por red." },
];

// ══ PUNTOS ═══════════════════════════════════════════════════════════════════════════════

/** Una muestra con velocidad. `conductor` y `vehiculo` llevan la tabla: "p:ID" (propio) | "t:ID" (tercero). */
export type PuntoVel = {
  ts: number;
  lat: number;
  lng: number;
  /** km/h, la del sensor del teléfono (0 si el equipo no tiene Doppler). */
  velocidad: number;
  /** null = desconocida (el motor NO la toma por buena). */
  precisionM: number | null;
  /** null = fuera de servicio (la app abierta sin servicio). */
  reservaId: number | null;
  /** null cuando la fila no dice de quién es (las dos columnas o ninguna, como `conductorDeLaTraza`). */
  conductor: string | null;
  vehiculo: string | null;
  /** tri-estado: true = GPS simulado; null = no se pudo comprobar. */
  simulado: boolean | null;
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
const tri = (x: unknown): boolean | null => (x === true ? true : x === false ? false : null);

/** "p:ID" | "t:ID", o null si la fila trae las dos columnas o ninguna (no dice de quién es). */
export function claveConductor(propio: unknown, tercero: unknown): string | null {
  const p = idPositivo(propio), t = idPositivo(tercero);
  if ((p == null) === (t == null)) return null;
  return p != null ? `p:${p}` : `t:${t}`;
}

/** "t:ID" | "p:ID" | null. Misma precedencia que `claveVehiculo` (lib/odometro-analitica.ts): el
 *  tercero primero. A diferencia de aquella, sin ninguno devuelve null (y no "p:null"). */
export function claveUnidad(propio: unknown, tercero: unknown): string | null {
  const t = idPositivo(tercero);
  if (t != null) return `t:${t}`;
  const p = idPositivo(propio);
  return p != null ? `p:${p}` : null;
}

function punto(ts: unknown, lat: unknown, lng: unknown, vel: unknown, prec: unknown, reserva: unknown,
  conductor: string | null, vehiculo: string | null, simulado: unknown): PuntoVel | null {
  const t = numero(ts), la = numero(lat), lo = numero(lng), v = numero(vel);
  if (t == null || la == null || lo == null || v == null) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  const p = numero(prec);
  return {
    ts: t, lat: la, lng: lo, velocidad: v,
    precisionM: p,
    reservaId: idPositivo(reserva),
    conductor, vehiculo,
    simulado: tri(simulado),
  };
}

/**
 * Los puntos de `fn_gps_puntos_rapidos` (`[[epoch_ms, lat, lng, velocidad, precision_m, reserva_id,
 * conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, simulado], …]`). Descarta lo que
 * no es una posición (lat/lng nulos — la función NO los filtra—, una velocidad nula o un registro mal
 * formado): una fila sin posición no puede ser parte de un episodio.
 */
export function puntosDeRpc(arr: readonly unknown[] | null | undefined): PuntoVel[] {
  const out: PuntoVel[] = [];
  for (const a of arr ?? []) {
    if (!Array.isArray(a) || a.length < 10) continue;
    const p = punto(a[0], a[1], a[2], a[3], a[4], a[5], claveConductor(a[6], a[7]), claveUnidad(a[8], a[9]), a[10]);
    if (p) out.push(p);
  }
  return out;
}

const tsDeFila = (f: Record<string, unknown>): number | null => {
  for (const k of ["created_at", "timestamp"] as const) {
    const v = f[k];
    if (v == null || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (Number.isFinite(t)) return t;
  }
  return null;
};

/**
 * Los puntos de filas CRUDAS de `ubicaciones_gps` (las de `leerTraza(…, { conHuella: true })`:
 * created_at, lat, lng, precision_m, simulado?, velocidad, conductor_id, conductor_tercero_id, …). El
 * instante es `created_at` —la hora del teléfono, la MISMA que usa `fn_gps_puntos_rapidos` (truncada a
 * milisegundos, igual que `Date.parse`)—, con `timestamp` de respaldo solo si falta.
 *
 * La traza de un servicio se lee por `reserva_id` y NO trae esa columna ni la del vehículo: quien la
 * conoce la pasa en `o.reservaId` / `o.vehiculo`, y se usan cuando la fila no trae la suya. Con las
 * dos, el resultado es el mismo que `puntosDeRpc` sobre las mismas filas (lo fija la matriz).
 */
export function puntosDeCrudas(filas: readonly unknown[] | null | undefined, o?: { reservaId?: number | null; vehiculo?: string | null }): PuntoVel[] {
  const out: PuntoVel[] = [];
  for (const x of filas ?? []) {
    if (!x || typeof x !== "object") continue;
    const f = x as Record<string, unknown>;
    const reserva = f.reserva_id !== undefined ? f.reserva_id : (o?.reservaId ?? null);
    const vehiculo = claveUnidad(f.vehiculo_id, f.vehiculo_tercero_id) ?? o?.vehiculo ?? null;
    const p = punto(tsDeFila(f), f.lat, f.lng, f.velocidad, f.precision_m, reserva,
      claveConductor(f.conductor_id, f.conductor_tercero_id), vehiculo, f.simulado);
    if (p) out.push(p);
  }
  return out;
}

/**
 * A qué racha pertenece un punto: el CONDUCTOR (con su tabla) y el SERVICIO. Sin conductor, la identidad
 * es el servicio y, sin él, el vehículo; sin ninguno, el punto no se puede atribuir y no forma episodio.
 * El servicio va en la clave para que los excesos de un servicio sean EXACTAMENTE los que salen de su
 * propia traza (la estadística por servicio lee solo esa). El vehículo NO va en la clave: lo declara el
 * teléfono, y la traza de un servicio no lo trae.
 */
export function claveRacha(p: PuntoVel): string | null {
  const ident = p.conductor ?? (p.reservaId != null ? `r:${p.reservaId}` : p.vehiculo != null ? `v:${p.vehiculo}` : null);
  return ident == null ? null : `${ident}|${p.reservaId ?? "-"}`;
}

// ══ EPISODIOS ════════════════════════════════════════════════════════════════════════════

/** En el orden del veredicto: gana el primero que aplique. Solo `exceso` cuenta. */
export type CodigoEpisodio = "simulado" | "imposible" | "breve" | "impreciso" | "sin_corroborar" | "exceso";
export const CODIGOS_EPISODIO: readonly CodigoEpisodio[] = ["simulado", "imposible", "breve", "impreciso", "sin_corroborar", "exceso"];
export type CodigoDescarte = Exclude<CodigoEpisodio, "exceso">;
export const CODIGOS_DESCARTE: readonly CodigoDescarte[] = ["simulado", "imposible", "breve", "impreciso", "sin_corroborar"];

/** Qué dice cada código. `cuenta` va pegado al código, no en una lista aparte. */
export const TEXTO_EPISODIO: Record<CodigoEpisodio, { titulo: string; cuenta: boolean; explicacion: string }> = {
  exceso: { titulo: "Exceso sostenido y corroborado", cuenta: true,
    explicacion: `El sensor marcó el umbral o más durante al menos ${DURACION_MIN_S} s y ${PUNTOS_MIN} muestras, con buena precisión, y las posiciones lo confirman.` },
  breve: { titulo: "Pico breve", cuenta: false,
    explicacion: `Duró menos de ${DURACION_MIN_S} s o tuvo menos de ${PUNTOS_MIN} muestras: no alcanza para afirmar un exceso sostenido.` },
  impreciso: { titulo: "GPS impreciso", cuenta: false,
    explicacion: `La precisión mediana fue peor que ${PRECISION_CORROBORA_M} m, o no se conoce: la posición no puede confirmar la velocidad.` },
  sin_corroborar: { titulo: "Las posiciones no lo confirman", cuenta: false,
    explicacion: `El sensor marcó la velocidad, pero entre las posiciones el vehículo avanzó a menos del ${Math.round(FACTOR_CORROBORA * 100)} % del umbral: es la velocidad fantasma del GPS con el vehículo detenido.` },
  imposible: { titulo: "Velocidad imposible", cuenta: false,
    explicacion: `El sensor o las posiciones pasan de ${UMBRAL_MAX_KMH} km/h: no es un bus, es un error del GPS.` },
  simulado: { titulo: "GPS simulado", cuenta: false,
    explicacion: "Alguna posición viene de un GPS simulado (ubicación falsa): no se juzga. Se revisa en Salud del GPS." },
};

export type Episodio = {
  codigo: CodigoEpisodio;
  /** "p:ID" | "t:ID" — quien llevaba el teléfono (lo fuerza el servidor con el token), no el asignado. */
  conductor: string | null;
  /** "p:ID" | "t:ID". En servicio, el de la reserva (lo completa el lector); si no, el que declaró el teléfono. */
  vehiculo: string | null;
  reservaId: number | null;
  /** sin reserva: no prueba que el teléfono iba en el bus; no suma al ranking. */
  fueraDeServicio: boolean;
  inicioTs: number;
  finTs: number;
  durS: number;
  puntos: number;
  /** pico del sensor (km/h) */
  velMaxSensor: number;
  /** media del sensor en la racha: la velocidad SOSTENIDA (km/h) */
  velMediaSensor: number;
  /** suma de cuerdas / duración (km/h): cota inferior de lo recorrido; null con duración 0 */
  velGeom: number | null;
  /** mediana de la precisión (m); null si es desconocida (la mayoría de las muestras sin precisión) */
  precisionMediana: number | null;
  /** dónde marcó el pico */
  latPico: number;
  lngPico: number;
  /** la racha seguía viva cuando se acabó de leer (después de MAX_EXTENSIONES): duró al menos esto */
  cortado: boolean;
  /** el porqué del código, con sus números; lo compone el motor, la pantalla no redacta */
  detalle: string;
};

/** Lo que el veredicto mira de una racha. */
export type MedidaRacha = {
  simulado: boolean;
  velMaxSensor: number;
  velGeom: number | null;
  durS: number;
  puntos: number;
  precisionMediana: number | null;
};

/** El veredicto de una racha, en el orden declarado (gana el primero que aplique). */
export function juzgarRacha(m: MedidaRacha, umbral: number): CodigoEpisodio {
  if (m.simulado) return "simulado";
  if (m.velMaxSensor > UMBRAL_MAX_KMH || (m.velGeom != null && m.velGeom > UMBRAL_MAX_KMH)) return "imposible";
  if (m.durS < DURACION_MIN_S || m.puntos < PUNTOS_MIN) return "breve";
  if (m.precisionMediana == null || m.precisionMediana > PRECISION_CORROBORA_M) return "impreciso";
  if (m.velGeom == null || m.velGeom < FACTOR_CORROBORA * umbral) return "sin_corroborar";
  return "exceso";
}

const kmh = (v: number | null) => (v == null ? "—" : `${Math.round(v)} km/h`);
/** "45 s" · "1 min 20 s" · "12 min" */
export function textoDuracion(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60), r = t % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** El porqué de UN episodio, con sus números. */
export function detalleEpisodio(e: Omit<Episodio, "detalle">, umbral: number): string {
  const dur = textoDuracion(e.durS);
  const muestras = `${e.puntos} muestra${e.puntos === 1 ? "" : "s"}`;
  const corte = e.cortado ? " Seguía por encima del umbral cuando se terminó de leer: duró al menos eso." : "";
  switch (e.codigo) {
    case "exceso":
      return `Sostuvo ${kmh(e.velMediaSensor)} durante ${dur} (${muestras}, pico ${kmh(e.velMaxSensor)}). Las posiciones lo confirman: ${kmh(e.velGeom)} en línea recta entre muestras, con precisión mediana de ${Math.round(e.precisionMediana ?? 0)} m.${corte}`;
    case "breve":
      return `Duró ${dur} con ${muestras} (pico ${kmh(e.velMaxSensor)}): para afirmar un exceso sostenido hacen falta ${DURACION_MIN_S} s y ${PUNTOS_MIN} muestras.`;
    case "impreciso":
      return e.precisionMediana == null
        ? `La precisión del GPS no se conoce en la mayoría de las ${muestras}: sin ella la posición no puede confirmar los ${kmh(e.velMediaSensor)} del sensor.`
        : `La precisión mediana fue de ${Math.round(e.precisionMediana)} m; con más de ${PRECISION_CORROBORA_M} m la posición no puede confirmar los ${kmh(e.velMediaSensor)} del sensor.`;
    case "sin_corroborar":
      return `El sensor marcó ${kmh(e.velMediaSensor)} de media (pico ${kmh(e.velMaxSensor)}) durante ${dur}, pero entre las posiciones el vehículo avanzó a ${kmh(e.velGeom)}, menos de ${kmh(FACTOR_CORROBORA * umbral)} (el ${Math.round(FACTOR_CORROBORA * 100)} % del umbral): la posición no confirma la velocidad. Es la firma de la velocidad fantasma del GPS con el vehículo detenido.`;
    case "imposible":
      return e.velMaxSensor > UMBRAL_MAX_KMH
        ? `El sensor marcó ${kmh(e.velMaxSensor)}, más de ${UMBRAL_MAX_KMH} km/h: no es un bus, es un error del GPS.`
        : `Las posiciones implican ${kmh(e.velGeom)}, más de ${UMBRAL_MAX_KMH} km/h: es un salto del GPS, no un movimiento real.`;
    case "simulado":
      return `Alguna de las ${muestras} viene de un GPS simulado (ubicación falsa): no se juzga. Se revisa en Salud del GPS.`;
  }
}

/** Arma el episodio de una racha (puntos del mismo grupo, en orden de tiempo). */
function armarEpisodio(pts: readonly PuntoVel[], umbral: number, cortado: boolean): Episodio {
  const n = pts.length;
  const inicioTs = pts[0].ts, finTs = pts[n - 1].ts;
  const durS = (finTs - inicioTs) / 1000;
  let velMax = -Infinity, iMax = 0, suma = 0, cuerdas = 0, simulado = false;
  const votos = new Map<string, { n: number; ultimo: number }>();
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.velocidad > velMax) { velMax = p.velocidad; iMax = i; }
    suma += p.velocidad;
    if (i > 0) cuerdas += distM(pts[i - 1].lat, pts[i - 1].lng, p.lat, p.lng);
    if (p.simulado === true) simulado = true;
    if (p.vehiculo != null) {
      const v = votos.get(p.vehiculo) ?? { n: 0, ultimo: -1 };
      v.n++; v.ultimo = i;
      votos.set(p.vehiculo, v);
    }
  }
  // Precisión desconocida (null, 0 o negativa) cuenta como la PEOR: no se toma por buena.
  const precs = pts.map((p) => (p.precisionM != null && p.precisionM > 0 ? p.precisionM : Infinity)).sort((a, b) => a - b);
  const med = n % 2 ? precs[(n - 1) / 2] : (precs[n / 2 - 1] + precs[n / 2]) / 2;
  const precisionMediana = Number.isFinite(med) ? med : null;
  const velGeom = durS > 0 ? (cuerdas / durS) * 3.6 : null;
  let vehiculo: string | null = null, mejor: { n: number; ultimo: number } | null = null;
  for (const [k, v] of votos) {
    if (!mejor || v.n > mejor.n || (v.n === mejor.n && v.ultimo > mejor.ultimo)) { mejor = v; vehiculo = k; }
  }
  const codigo = juzgarRacha({ simulado, velMaxSensor: velMax, velGeom, durS, puntos: n, precisionMediana }, umbral);
  const sin: Omit<Episodio, "detalle"> = {
    codigo,
    conductor: pts[0].conductor,
    vehiculo,
    reservaId: pts[0].reservaId,
    fueraDeServicio: pts[0].reservaId == null,
    inicioTs, finTs, durS,
    puntos: n,
    velMaxSensor: velMax,
    velMediaSensor: suma / n,
    velGeom,
    precisionMediana,
    latPico: pts[iMax].lat,
    lngPico: pts[iMax].lng,
    cortado,
  };
  return { ...sin, detalle: detalleEpisodio(sin, umbral) };
}

/**
 * El detector, por FLUJO: recibe los puntos en orden de tiempo (por grupo) y cierra cada racha en cuanto
 * llega una muestra de su grupo más allá de la pausa. Lo usa `detectarExcesos` (todo de una vez) y
 * `detectarEnRango` (día por día, sin juntar una semana de puntos en memoria): los dos dan lo mismo.
 */
export type DetectorExcesos = {
  /** Un punto, en orden de tiempo dentro de su grupo (fuera de orden LANZA: es un error de quien lee). */
  agregar(p: PuntoVel): void;
  /** ¿Alguna racha que empezó antes de `hastaTs` podría seguir con un punto en `finLecturaTs` o después? */
  puedeSeguir(finLecturaTs: number, hastaTs: number): boolean;
  /** Cierra todo. Con `finLecturaTs`, las rachas que podían seguir salen `cortado`. */
  cerrar(finLecturaTs?: number): Episodio[];
  /** Puntos rápidos que no se pudieron atribuir a nadie (sin conductor, servicio ni vehículo). */
  sinIdentidad(): number;
};

export function crearDetectorExcesos(umbral: number): DetectorExcesos {
  const abiertas = new Map<string, PuntoVel[]>();
  const cerrados: { clave: string; ep: Episodio }[] = [];
  let sinIdent = 0;
  return {
    agregar(p) {
      if (!(p.velocidad >= umbral)) return;          // LOCALIDAD: lo que no es rápido ni rompe ni alarga
      const k = claveRacha(p);
      if (k == null) { sinIdent++; return; }
      const r = abiertas.get(k);
      if (!r) { abiertas.set(k, [p]); return; }
      const ultimo = r[r.length - 1].ts;
      if (p.ts < ultimo) throw new Error(`excesos: puntos fuera de orden en ${k} (${p.ts} < ${ultimo})`);
      if (p.ts - ultimo > GAP_MS) {
        cerrados.push({ clave: k, ep: armarEpisodio(r, umbral, false) });
        abiertas.set(k, [p]);
      } else r.push(p);
    },
    puedeSeguir(finLecturaTs, hastaTs) {
      for (const r of abiertas.values()) {
        if (r[0].ts < hastaTs && r[r.length - 1].ts >= finLecturaTs - GAP_MS) return true;
      }
      return false;
    },
    cerrar(finLecturaTs) {
      for (const [k, r] of abiertas) {
        const cortado = finLecturaTs != null && r[r.length - 1].ts >= finLecturaTs - GAP_MS;
        cerrados.push({ clave: k, ep: armarEpisodio(r, umbral, cortado) });
      }
      abiertas.clear();
      cerrados.sort((a, b) => a.ep.inicioTs - b.ep.inicioTs || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
      const out = cerrados.map((c) => c.ep);
      cerrados.length = 0;
      return out;
    },
    sinIdentidad: () => sinIdent,
  };
}

/**
 * Los episodios de un conjunto de puntos en cualquier orden (la traza de un servicio, o todo). Solo
 * miran los puntos con `velocidad >= umbral`: detectar sobre la traza entera o sobre sus puntos rápidos
 * da lo mismo. Orden de salida: por inicio, y a igual inicio por grupo.
 */
export function detectarExcesos(puntos: readonly PuntoVel[], umbral: number): Episodio[] {
  const rapidos = puntos.map((p, i) => ({ p, i })).filter((x) => x.p.velocidad >= umbral);
  rapidos.sort((a, b) => a.p.ts - b.p.ts || a.i - b.i);
  const d = crearDetectorExcesos(umbral);
  for (const x of rapidos) d.agregar(x.p);
  return d.cerrar();
}

/** Los episodios que EMPIEZAN en [desdeTs, hastaTs). Así se unen tandas leídas con colchón: cada
 *  episodio pertenece a la tanda donde empieza, una sola vez. */
export function asignarPorInicio(eps: readonly Episodio[], desdeTs: number, hastaTs: number): Episodio[] {
  return eps.filter((e) => e.inicioTs >= desdeTs && e.inicioTs < hastaTs);
}

// ══ LEER UN RANGO POR VENTANAS (con la lectura inyectada) ═════════════════════════════════

export type Ventana = { desdeTs: number; hastaTs: number };
export type LecturaPuntos = { puntos: PuntoVel[]; recortado: boolean };
/** Quien lee los puntos rápidos de una ventana [desdeTs, hastaTs) en orden de tiempo (la RPC, o uno falso). */
export type LectorPuntos = (desdeTs: number, hastaTs: number) => Promise<LecturaPuntos>;

/**
 * Las ventanas con que se lee [desdeTs, hastaTs): cortes cada `trozoMs` desde `desdeTs` (con días de
 * Lima, un día por ventana) y el COLCHÓN en los dos bordes del rango. Contiguas y sin solaparse: ningún
 * punto se lee dos veces.
 */
export function ventanasDeLectura(desdeTs: number, hastaTs: number, trozoMs = DIA_MS, colchonMs = COLCHON_S * 1000): Ventana[] {
  const cortes: number[] = [desdeTs - colchonMs];
  for (let t = desdeTs + trozoMs; t < hastaTs; t += trozoMs) cortes.push(t);
  cortes.push(hastaTs + colchonMs);
  const out: Ventana[] = [];
  for (let i = 0; i + 1 < cortes.length; i++) out.push({ desdeTs: cortes[i], hastaTs: cortes[i + 1] });
  return out;
}

export type ResultadoRango = {
  /** los que EMPIEZAN en el rango, completos */
  episodios: Episodio[];
  /** ventanas leídas, en orden (las de extensión al final) */
  ventanas: (Ventana & { recortado: boolean; extension: boolean })[];
  /** episodios que seguían vivos tras MAX_EXTENSIONES */
  cortados: number;
  /** puntos rápidos sin conductor, servicio ni vehículo (no forman episodio) */
  sinIdentidad: number;
};

/**
 * Detecta los episodios que EMPIEZAN en [desdeTs, hastaTs) leyendo por ventanas, de a `paralelo` a la vez
 * y alimentando el detector en orden. Es EXACTO, no una aproximación (lo fija la matriz contra
 * `detectarExcesos` sobre todo):
 *   · al inicio, el colchón (≥ la pausa máxima) garantiza que una racha que se ve empezar en el rango
 *     empieza ahí de verdad;
 *   · al final, si alguna racha que empezó dentro podría seguir, se sigue leyendo de a EXTENSION_MS hasta
 *     que se cierre (como mucho MAX_EXTENSIONES; si no, el episodio sale `cortado` y se cuenta).
 * Un error de lectura LANZA: un día sin leer no puede contarse como «0 excesos».
 */
export async function detectarEnRango(leer: LectorPuntos, o: {
  desdeTs: number; hastaTs: number; umbral: number;
  trozoMs?: number; colchonMs?: number; extensionMs?: number; maxExtensiones?: number; paralelo?: number;
}): Promise<ResultadoRango> {
  const det = crearDetectorExcesos(o.umbral);
  const ventanas: ResultadoRango["ventanas"] = [];
  const plan = ventanasDeLectura(o.desdeTs, o.hastaTs, o.trozoMs ?? DIA_MS, o.colchonMs ?? COLCHON_S * 1000);
  const paralelo = Math.max(1, Math.floor(o.paralelo ?? 2));
  const alimentar = (w: Ventana, l: LecturaPuntos, extension: boolean) => {
    for (const p of l.puntos) det.agregar(p);
    ventanas.push({ ...w, recortado: l.recortado === true, extension });
  };
  for (let i = 0; i < plan.length; i += paralelo) {
    const tanda = plan.slice(i, i + paralelo);
    const lecturas = await Promise.all(tanda.map((w) => leer(w.desdeTs, w.hastaTs)));
    tanda.forEach((w, j) => alimentar(w, lecturas[j], false));
  }
  let fin = plan[plan.length - 1].hastaTs;
  const extMs = o.extensionMs ?? EXTENSION_MS;
  const maxExt = Math.max(0, Math.floor(o.maxExtensiones ?? MAX_EXTENSIONES));
  for (let k = 0; k < maxExt && det.puedeSeguir(fin, o.hastaTs); k++) {
    const w = { desdeTs: fin, hastaTs: fin + extMs };
    alimentar(w, await leer(w.desdeTs, w.hastaTs), true);
    fin = w.hastaTs;
  }
  const todos = det.cerrar(fin);
  const episodios = asignarPorInicio(todos, o.desdeTs, o.hastaTs);
  return { episodios, ventanas, cortados: episodios.filter((e) => e.cortado).length, sinIdentidad: det.sinIdentidad() };
}

// ══ VELOCÍMETRO (tri-estado por conductor) ═══════════════════════════════════════════════

export type Velocimetro = "con_velocimetro" | "sin_velocimetro" | "sin_gps" | "no_se_sabe";
export const VELOCIMETROS: readonly Velocimetro[] = ["con_velocimetro", "sin_velocimetro", "sin_gps", "no_se_sabe"];

export const TEXTO_VELOCIMETRO: Record<Velocimetro, { titulo: string; juzgable: boolean; detalle: string }> = {
  con_velocimetro: { titulo: "Con velocímetro", juzgable: true,
    detalle: "Su teléfono reporta la velocidad del sensor: sus excesos se pueden medir." },
  sin_velocimetro: { titulo: "Sin velocímetro: no se puede juzgar", juzgable: false,
    detalle: "Mandó posiciones, pero ninguna con la velocidad del sensor (siempre 0): su teléfono o el navegador no la reporta. Decir «0 excesos» sería afirmar algo que no se midió. Se revisa en Salud del GPS." },
  sin_gps: { titulo: "Sin GPS en el periodo", juzgable: false,
    detalle: "No mandó ninguna posición en el periodo: no hay nada que juzgar." },
  no_se_sabe: { titulo: "No se pudo comprobar", juzgable: false,
    detalle: "No se pudo consultar si su teléfono reporta la velocidad del sensor." },
};

/** De `fn_gps_velocimetro`: `hay_puntos` (null = no se pudo leer) y `hay_velocidad` (null sin puntos). */
export function velocimetroDe(hayPuntos: boolean | null, hayVelocidad: boolean | null): Velocimetro {
  if (hayPuntos == null) return "no_se_sabe";
  if (hayPuntos === false) return "sin_gps";
  if (hayVelocidad === true) return "con_velocimetro";
  if (hayVelocidad === false) return "sin_velocimetro";
  return "no_se_sabe";
}

/** Dos tandas del mismo conductor: la evidencia de velocidad gana; lo que no se pudo leer impide
 *  afirmar que no tiene; y sin velocímetro gana a sin GPS. */
export function combinarVelocimetro(a: Velocimetro, b: Velocimetro): Velocimetro {
  if (a === "con_velocimetro" || b === "con_velocimetro") return "con_velocimetro";
  if (a === "no_se_sabe" || b === "no_se_sabe") return "no_se_sabe";
  if (a === "sin_velocimetro" || b === "sin_velocimetro") return "sin_velocimetro";
  return "sin_gps";
}

// ══ RESUMEN (ranking con exposición) ══════════════════════════════════════════════════════

/** Un servicio del rango: los prestados (finalizados o en curso) son la EXPOSICIÓN; los demás están
 *  porque un episodio cayó en ellos (`prestado: false`). */
export type ServicioExpuesto = {
  reservaId: number;
  fecha: string | null;
  hora: string | null;
  codigo: string | null;
  estado: string | null;
  prestado: boolean;
  /** el ASIGNADO en la reserva ("p:ID" | "t:ID") */
  conductor: string | null;
  vehiculo: string | null;
  cliente: string | null;
  ruta: IdentidadRuta;
};

export type ConductorExcesos = { clave: string; nombre: string | null; tercero: boolean; velocimetro: Velocimetro };
export type UnidadExcesos = { clave: string; placa: string | null; tercero: boolean };

/** Los episodios repartidos: disjuntos y exhaustivos. */
export type ConteoEpisodios = {
  /** `exceso` con servicio: lo que cuenta */
  enServicio: Episodio[];
  /** `exceso` sin servicio (vacío si no se incluyen) */
  fueraDeServicio: Episodio[];
  /** cuántos `exceso` sin servicio hubo, se incluyan o no */
  fueraDeServicioTotal: number;
  /** con servicio, por motivo */
  descartados: Record<CodigoDescarte, number>;
  /** sin servicio, por motivo */
  descartadosFuera: Record<CodigoDescarte, number>;
};

const ceros = (): Record<CodigoDescarte, number> => ({ simulado: 0, imposible: 0, breve: 0, impreciso: 0, sin_corroborar: 0 });

export function clasificarEpisodios(eps: readonly Episodio[]): ConteoEpisodios {
  const out: ConteoEpisodios = { enServicio: [], fueraDeServicio: [], fueraDeServicioTotal: 0, descartados: ceros(), descartadosFuera: ceros() };
  for (const e of eps) {
    const fuera = e.reservaId == null;
    if (e.codigo === "exceso") {
      if (fuera) { out.fueraDeServicio.push(e); out.fueraDeServicioTotal++; } else out.enServicio.push(e);
    } else if (fuera) out.descartadosFuera[e.codigo]++;
    else out.descartados[e.codigo]++;
  }
  return out;
}

export type FilaConductorExcesos = {
  conductor: string;
  velocimetro: Velocimetro;
  /** null = no se puede juzgar (sin velocímetro, sin GPS o no se sabe) y no se le vio ninguno */
  excesos: number | null;
  segundos: number | null;
  /** pico del sensor (km/h) */
  velPico: number | null;
  /** la mayor velocidad SOSTENIDA (media de un episodio, km/h) */
  velSostenida: number | null;
  serviciosConExceso: number | null;
  /** asignados y prestados ∪ los servicios donde se le vio un exceso */
  serviciosPrestados: number;
  /** serviciosConExceso / serviciosPrestados */
  tasa: number | null;
};
export type FilaUnidadExcesos = {
  unidad: string;
  /** null = ninguno de sus conductores se pudo juzgar y no se le vio ninguno */
  excesos: number | null;
  segundos: number | null;
  velPico: number | null;
  velSostenida: number | null;
  serviciosConExceso: number | null;
  serviciosPrestados: number;
  tasa: number | null;
};
export type FilaServicioExcesos = {
  reservaId: number;
  conductor: string | null;
  vehiculo: string | null;
  excesos: number;
  segundos: number;
  velPico: number;
  velSostenida: number;
};

/** Por qué el total no es un número: no había servicios, no se pudo comprobar el velocímetro, o ningún
 *  conductor se podía juzgar. */
export type MotivoSinTotal = "sin_servicios" | "no_se_sabe" | "sin_juzgables";

export type ResumenExcesos = {
  porConductor: FilaConductorExcesos[];
  porUnidad: FilaUnidadExcesos[];
  porServicio: FilaServicioExcesos[];
  descartados: Record<CodigoDescarte, number>;
  descartadosFuera: Record<CodigoDescarte, number>;
  fueraDeServicio: Episodio[];
  fueraDeServicioTotal: number;
  porVelocimetro: Record<Velocimetro, number>;
  totales: {
    /** null (con su motivo) cuando no hay nada que se haya podido juzgar: nunca un «0» no medido */
    excesos: number | null;
    motivoSinTotal: MotivoSinTotal | null;
    segundos: number;
    conductoresConExceso: number;
    conductoresJuzgables: number;
    unidadesConExceso: number;
    serviciosConExceso: number;
    serviciosPrestados: number;
    velPico: number | null;
    velSostenida: number | null;
    /** excesos en servicio sin conductor identificable en sus posiciones (cuentan, sin fila de conductor) */
    sinConductor: number;
    /** excesos en servicio sin vehículo conocido (cuentan, sin fila de unidad) */
    sinUnidad: number;
  };
};

const cmpTexto = (a: string | null, b: string | null) => { const x = a ?? "", y = b ?? ""; return x < y ? -1 : x > y ? 1 : 0; };
/** Orden total y estable de una lista de episodios (por inicio; a igual inicio, por quién). */
export const ordenarEpisodios = (eps: readonly Episodio[]): Episodio[] =>
  [...eps].sort((a, b) => a.inicioTs - b.inicioTs || cmpTexto(a.conductor, b.conductor)
    || (a.reservaId ?? 0) - (b.reservaId ?? 0) || cmpTexto(a.vehiculo, b.vehiculo) || a.finTs - b.finTs);

type Acum = { n: number; seg: number; pico: number; sost: number; conExceso: Set<number>; prestados: Set<number> };
const acum = (): Acum => ({ n: 0, seg: 0, pico: -Infinity, sost: -Infinity, conExceso: new Set(), prestados: new Set() });
const sumar = (a: Acum, e: Episodio) => {
  a.n++; a.seg += e.durS;
  a.pico = Math.max(a.pico, e.velMaxSensor);
  a.sost = Math.max(a.sost, e.velMediaSensor);
  if (e.reservaId != null) { a.conExceso.add(e.reservaId); a.prestados.add(e.reservaId); }
};
const ordenFilas = <T extends { excesos: number | null; segundos: number | null }>(a: T, b: T, ka: string, kb: string) =>
  (b.excesos ?? -1) - (a.excesos ?? -1) || (b.segundos ?? -1) - (a.segundos ?? -1) || (ka < kb ? -1 : ka > kb ? 1 : 0);

/**
 * El ranking, con la EXPOSICIÓN como medida: «servicios con exceso / servicios prestados». Solo cuentan
 * los `exceso` con servicio; lo de fuera de servicio se cuenta y (si se pide) se lista aparte, y NO suma
 * a ninguna fila. Un conductor sin velocímetro y sin excesos vistos sale con `excesos: null`, no con 0.
 */
export function resumirConteo(
  c: ConteoEpisodios,
  ctx: { servicios: readonly ServicioExpuesto[]; velocimetro: ReadonlyMap<string, Velocimetro> },
  o: { incluirFueraDeServicio: boolean },
): ResumenExcesos {
  const velDe = (k: string): Velocimetro => ctx.velocimetro.get(k) ?? "no_se_sabe";
  const porC = new Map<string, Acum>(), porU = new Map<string, Acum>(), porS = new Map<number, Acum & { conductor: string | null; vehiculo: string | null }>();
  const de = <K>(m: Map<K, Acum>, k: K) => { let a = m.get(k); if (!a) { a = acum(); m.set(k, a); } return a; };
  // Exposición: lo asignado y prestado.
  const conductorDeServicio = new Map<number, string | null>();
  let prestados = 0;
  for (const s of ctx.servicios) {
    if (!s.prestado) continue;
    prestados++;
    conductorDeServicio.set(s.reservaId, s.conductor);
    if (s.conductor) de(porC, s.conductor).prestados.add(s.reservaId);
    if (s.vehiculo) de(porU, s.vehiculo).prestados.add(s.reservaId);
  }
  let sinConductor = 0, sinUnidad = 0, seg = 0, pico = -Infinity, sost = -Infinity;
  const serviciosConExceso = new Set<number>();
  for (const e of c.enServicio) {
    seg += e.durS; pico = Math.max(pico, e.velMaxSensor); sost = Math.max(sost, e.velMediaSensor);
    if (e.reservaId != null) serviciosConExceso.add(e.reservaId);
    if (e.conductor) sumar(de(porC, e.conductor), e); else sinConductor++;
    if (e.vehiculo) sumar(de(porU, e.vehiculo), e); else sinUnidad++;
    if (e.reservaId != null) {
      let s = porS.get(e.reservaId);
      if (!s) { s = { ...acum(), conductor: e.conductor, vehiculo: e.vehiculo }; porS.set(e.reservaId, s); }
      sumar(s, e);
    }
  }
  const fila = (a: Acum, juzgable: boolean) => {
    const visto = a.n > 0 || juzgable;
    return {
      excesos: visto ? a.n : null,
      segundos: visto ? a.seg : null,
      velPico: a.n ? a.pico : null,
      velSostenida: a.n ? a.sost : null,
      serviciosConExceso: visto ? a.conExceso.size : null,
      serviciosPrestados: a.prestados.size,
      tasa: visto && a.prestados.size > 0 ? a.conExceso.size / a.prestados.size : null,
    };
  };
  const porConductor: FilaConductorExcesos[] = [...porC.entries()]
    .map(([k, a]) => ({ conductor: k, velocimetro: velDe(k), ...fila(a, TEXTO_VELOCIMETRO[velDe(k)].juzgable) }))
    .sort((a, b) => ordenFilas(a, b, a.conductor, b.conductor));
  // Una unidad se puede juzgar si alguno de sus servicios prestados lo manejó alguien con velocímetro.
  const porUnidad: FilaUnidadExcesos[] = [...porU.entries()]
    .map(([k, a]) => {
      const juzgable = [...a.prestados].some((id) => { const cd = conductorDeServicio.get(id); return cd != null && velDe(cd) === "con_velocimetro"; });
      return { unidad: k, ...fila(a, juzgable) };
    })
    .sort((a, b) => ordenFilas(a, b, a.unidad, b.unidad));
  const porServicio: FilaServicioExcesos[] = [...porS.entries()]
    .map(([id, s]) => ({ reservaId: id, conductor: s.conductor, vehiculo: s.vehiculo, excesos: s.n, segundos: s.seg, velPico: s.pico, velSostenida: s.sost }))
    .sort((a, b) => b.excesos - a.excesos || b.segundos - a.segundos || a.reservaId - b.reservaId);
  const porVelocimetro: Record<Velocimetro, number> = { con_velocimetro: 0, sin_velocimetro: 0, sin_gps: 0, no_se_sabe: 0 };
  for (const f of porConductor) porVelocimetro[f.velocimetro]++;
  const juzgables = porVelocimetro.con_velocimetro;
  const n = c.enServicio.length;
  const motivoSinTotal: MotivoSinTotal | null = n > 0 || juzgables > 0 ? null
    : prestados === 0 ? "sin_servicios"
    : porVelocimetro.no_se_sabe > 0 ? "no_se_sabe"
    : "sin_juzgables";
  return {
    porConductor, porUnidad, porServicio,
    descartados: { ...c.descartados },
    descartadosFuera: { ...c.descartadosFuera },
    fueraDeServicio: o.incluirFueraDeServicio ? ordenarEpisodios(c.fueraDeServicio) : [],
    fueraDeServicioTotal: c.fueraDeServicioTotal,
    porVelocimetro,
    totales: {
      excesos: motivoSinTotal ? null : n,
      motivoSinTotal,
      segundos: seg,
      conductoresConExceso: porConductor.filter((f) => (f.excesos ?? 0) > 0).length,
      conductoresJuzgables: juzgables,
      unidadesConExceso: porUnidad.filter((f) => (f.excesos ?? 0) > 0).length,
      serviciosConExceso: serviciosConExceso.size,
      serviciosPrestados: prestados,
      velPico: n ? pico : null,
      velSostenida: n ? sost : null,
      sinConductor, sinUnidad,
    },
  };
}

/** `resumirConteo` sobre episodios sueltos. */
export function resumirExcesos(
  eps: readonly Episodio[],
  ctx: { servicios: readonly ServicioExpuesto[]; velocimetro: ReadonlyMap<string, Velocimetro> },
  o: { incluirFueraDeServicio: boolean },
): ResumenExcesos {
  return resumirConteo(clasificarEpisodios(eps), ctx, o);
}

export const TEXTO_SIN_TOTAL: Record<MotivoSinTotal, string> = {
  sin_servicios: "No hubo servicios prestados en el periodo: no hay excesos que medir.",
  no_se_sabe: "No se pudo comprobar si los teléfonos de los conductores reportan la velocidad del sensor: no se puede afirmar «0 excesos».",
  sin_juzgables: "Ningún conductor del periodo tiene un teléfono que reporte la velocidad del sensor: no se puede juzgar, y decir «0 excesos» sería afirmar algo que no se midió.",
};

/** En servicio, el vehículo es el de la RESERVA (el dato escrito); el del teléfono queda de respaldo. */
export function completarConServicios(eps: readonly Episodio[], servicios: readonly ServicioExpuesto[]): Episodio[] {
  const porId = new Map(servicios.map((s) => [s.reservaId, s]));
  return eps.map((e) => {
    const s = e.reservaId != null ? porId.get(e.reservaId) : undefined;
    return s?.vehiculo && s.vehiculo !== e.vehiculo ? { ...e, vehiculo: s.vehiculo } : e;
  });
}

// ══ LA RESPUESTA DE /api/flota/excesos ═══════════════════════════════════════════════════

/** Un día que se leyó incompleto (la función devolvió su tope de puntos). */
export type DiaRecortado = { fecha: string; extension: boolean };

export type RespuestaExcesos = {
  desde: string;
  hasta: string;
  umbral: number;
  medidoEn: string | null;
  /** la migración que falta (la pantalla la nombra en ámbar); null si está */
  sin_migracion: string | null;
  /** el cálculo no se pudo hacer: las listas vienen vacías y NO significan «0 excesos» */
  error: string | null;
  avisos: string[];
  /** días leídos incompletos: sus excesos pueden faltar */
  diasRecortados: DiaRecortado[];
  /** episodios que seguían vivos al terminar de leer */
  cortados: number;
  /** puntos rápidos que no se pudieron atribuir a nadie */
  puntosSinIdentidad: number;
  incluyeFueraDeServicio: boolean;
  /** los `exceso` CON servicio (los que cuentan), por inicio. Los de fuera van en `resumen.fueraDeServicio`. */
  episodios: Episodio[];
  servicios: ServicioExpuesto[];
  conductores: ConductorExcesos[];
  unidades: UnidadExcesos[];
  resumen: ResumenExcesos;
  constantes: readonly ConstanteExcesos[];
};

/** Arma la respuesta con TODO incluido (la ruta la recorta con `vistaRespuesta`). */
export function armarRespuestaExcesos(d: {
  desde: string; hasta: string; umbral: number; medidoEn: string | null;
  episodios: readonly Episodio[]; servicios: readonly ServicioExpuesto[];
  conductores: readonly ConductorExcesos[]; unidades: readonly UnidadExcesos[];
  avisos?: readonly string[]; diasRecortados?: readonly DiaRecortado[]; cortados?: number; puntosSinIdentidad?: number;
}): RespuestaExcesos {
  const conteo = clasificarEpisodios(d.episodios);
  return armarDesdeConteo({ ...d, conteo, incluyeFueraDeServicio: true });
}

/** El pico de un exceso FUERA de servicio, redondeado a DECIMALES_PICO_FUERA (~1 km); uno con
 *  servicio sale tal cual. Idempotente: redondear lo ya redondeado no lo mueve. */
export function conPicoAproximado(e: Episodio): Episodio {
  if (!e.fueraDeServicio && e.reservaId != null) return e;
  const f = 10 ** DECIMALES_PICO_FUERA;
  const r = (x: number) => Math.round(x * f) / f;
  return { ...e, latPico: r(e.latPico), lngPico: r(e.lngPico) };
}

function armarDesdeConteo(d: {
  desde: string; hasta: string; umbral: number; medidoEn: string | null; conteo: ConteoEpisodios; incluyeFueraDeServicio: boolean;
  servicios: readonly ServicioExpuesto[]; conductores: readonly ConductorExcesos[]; unidades: readonly UnidadExcesos[];
  avisos?: readonly string[]; diasRecortados?: readonly DiaRecortado[]; cortados?: number; puntosSinIdentidad?: number;
  sin_migracion?: string | null; error?: string | null;
}): RespuestaExcesos {
  const velocimetro = new Map(d.conductores.map((c) => [c.clave, c.velocimetro] as const));
  const servicios = [...d.servicios].sort((a, b) => a.reservaId - b.reservaId);
  // Toda respuesta pasa por aquí (la del lector, la vacía y la unión de tandas): el pico de un exceso
  // fuera de servicio sale aproximado SIEMPRE, se pidan o no, y aunque la pantalla los recorte después.
  const conteo: ConteoEpisodios = { ...d.conteo, fueraDeServicio: d.conteo.fueraDeServicio.map(conPicoAproximado) };
  const resumen = resumirConteo(conteo, { servicios, velocimetro }, { incluirFueraDeServicio: d.incluyeFueraDeServicio });
  return {
    desde: d.desde, hasta: d.hasta, umbral: d.umbral, medidoEn: d.medidoEn,
    sin_migracion: d.sin_migracion ?? null,
    error: d.error ?? null,
    avisos: [...(d.avisos ?? [])],
    diasRecortados: [...(d.diasRecortados ?? [])],
    cortados: d.cortados ?? 0,
    puntosSinIdentidad: d.puntosSinIdentidad ?? 0,
    incluyeFueraDeServicio: d.incluyeFueraDeServicio,
    episodios: ordenarEpisodios(d.conteo.enServicio),
    servicios,
    conductores: [...d.conductores].sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0)),
    unidades: [...d.unidades].sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0)),
    resumen,
    constantes: CONSTANTES_EXCESOS,
  };
}


/** Una respuesta sin datos: falta la migración, o el cálculo falló. Las listas vacías NO son un «0». */
export function respuestaVacia(d: { desde: string; hasta: string; umbral: number; sin_migracion?: string | null; error?: string | null; avisos?: readonly string[] }): RespuestaExcesos {
  return armarDesdeConteo({
    desde: d.desde, hasta: d.hasta, umbral: d.umbral, medidoEn: null,
    conteo: { enServicio: [], fueraDeServicio: [], fueraDeServicioTotal: 0, descartados: ceros(), descartadosFuera: ceros() },
    incluyeFueraDeServicio: false, servicios: [], conductores: [], unidades: [],
    avisos: d.avisos, sin_migracion: d.sin_migracion ?? null, error: d.error ?? null,
  });
}

/**
 * Lo que se le responde a quien NO pidió los excesos fuera de servicio: se cuentan, no se listan. Y el
 * directorio (`conductores`, `unidades`) se recorta a quien la respuesta nombra en SERVICIO —un servicio
 * del rango, un exceso con servicio o una fila del ranking—: alguien que solo aparece por un exceso fuera
 * de servicio no sale nombrado en una respuesta que no lista ese exceso.
 */
export function vistaRespuesta(r: RespuestaExcesos, incluirFueraDeServicio: boolean): RespuestaExcesos {
  if (incluirFueraDeServicio) return r;
  const resumen = r.resumen.fueraDeServicio.length ? { ...r.resumen, fueraDeServicio: [] } : r.resumen;
  const conductoresVistos = new Set<string>(), unidadesVistas = new Set<string>();
  const ver = (c: string | null, u: string | null) => { if (c) conductoresVistos.add(c); if (u) unidadesVistas.add(u); };
  for (const s of r.servicios) ver(s.conductor, s.vehiculo);
  for (const e of r.episodios) ver(e.conductor, e.vehiculo);
  for (const f of resumen.porServicio) ver(f.conductor, f.vehiculo);
  for (const f of resumen.porConductor) ver(f.conductor, null);
  for (const f of resumen.porUnidad) ver(null, f.unidad);
  const conductores = r.conductores.filter((c) => conductoresVistos.has(c.clave));
  const unidades = r.unidades.filter((u) => unidadesVistas.has(u.clave));
  if (!r.incluyeFueraDeServicio && resumen === r.resumen && conductores.length === r.conductores.length && unidades.length === r.unidades.length) return r;
  return { ...r, incluyeFueraDeServicio: false, resumen, conductores, unidades };
}

/**
 * Une las respuestas de tandas CONTIGUAS y sin solaparse (la pantalla pide un mes en tandas de 7 días):
 * los episodios ya vienen asignados por inicio, así que se juntan sin duplicar, y el ranking se VUELVE A
 * CALCULAR con la exposición unida (un servicio prestado en una tanda y tocado en otra cuenta una vez).
 * Tandas con distinto umbral, o que se solapan, LANZAN: unirlas contaría distinto o dos veces.
 *
 * Límite declarado: el velocímetro de cada tanda se consulta para SUS conductores y SU rango, y se combina
 * con `combinarVelocimetro`. Un conductor que en una tanda no tuvo servicios ni excesos no se consultó
 * ahí: si su teléfono reportó velocidad SOLO en esa tanda, la unión puede decir «sin velocímetro» (en las
 * tandas donde trabajó, su teléfono no la reportó). Nunca dice «con velocímetro» de más.
 */
export function unirRespuestasExcesos(rs: readonly RespuestaExcesos[]): RespuestaExcesos {
  if (!rs.length) throw new Error("unirRespuestasExcesos: no hay tandas que unir");
  const orden = [...rs].sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0));
  for (let i = 1; i < orden.length; i++) {
    if (orden[i].umbral !== orden[0].umbral) throw new Error("unirRespuestasExcesos: las tandas tienen umbrales distintos");
    if (orden[i].desde <= orden[i - 1].hasta) throw new Error(`unirRespuestasExcesos: las tandas ${orden[i - 1].desde}…${orden[i - 1].hasta} y ${orden[i].desde}…${orden[i].hasta} se solapan`);
  }
  const conteo: ConteoEpisodios = { enServicio: [], fueraDeServicio: [], fueraDeServicioTotal: 0, descartados: ceros(), descartadosFuera: ceros() };
  const servicios = new Map<number, ServicioExpuesto>();
  const conductores = new Map<string, ConductorExcesos>();
  const unidades = new Map<string, UnidadExcesos>();
  const avisos = new Set<string>();
  const errores: string[] = [];
  let sinMigracion: string | null = null, cortados = 0, sinIdent = 0, medidoEn: string | null = null;
  const dias: DiaRecortado[] = [];
  for (const r of orden) {
    conteo.enServicio.push(...r.episodios);
    conteo.fueraDeServicio.push(...r.resumen.fueraDeServicio);
    conteo.fueraDeServicioTotal += r.resumen.fueraDeServicioTotal;
    for (const k of CODIGOS_DESCARTE) {
      conteo.descartados[k] += r.resumen.descartados[k];
      conteo.descartadosFuera[k] += r.resumen.descartadosFuera[k];
    }
    for (const s of r.servicios) {
      const v = servicios.get(s.reservaId);
      servicios.set(s.reservaId, v ? { ...v, prestado: v.prestado || s.prestado } : s);
    }
    for (const c of r.conductores) {
      const v = conductores.get(c.clave);
      conductores.set(c.clave, v ? { ...v, nombre: v.nombre ?? c.nombre, velocimetro: combinarVelocimetro(v.velocimetro, c.velocimetro) } : c);
    }
    for (const u of r.unidades) {
      const v = unidades.get(u.clave);
      unidades.set(u.clave, v ? { ...v, placa: v.placa ?? u.placa } : u);
    }
    for (const a of r.avisos) avisos.add(a);
    if (r.error) errores.push(`${r.desde} a ${r.hasta}: ${r.error}`);
    sinMigracion ??= r.sin_migracion;
    cortados += r.cortados;
    sinIdent += r.puntosSinIdentidad;
    dias.push(...r.diasRecortados);
    if (r.medidoEn && (!medidoEn || r.medidoEn < medidoEn)) medidoEn = r.medidoEn;
  }
  return armarDesdeConteo({
    desde: orden[0].desde, hasta: orden[orden.length - 1].hasta, umbral: orden[0].umbral, medidoEn,
    conteo, incluyeFueraDeServicio: orden.every((r) => r.incluyeFueraDeServicio),
    servicios: [...servicios.values()], conductores: [...conductores.values()], unidades: [...unidades.values()],
    avisos: [...avisos], diasRecortados: dias, cortados, puntosSinIdentidad: sinIdent,
    sin_migracion: sinMigracion, error: errores.length ? errores.join(" · ") : null,
  });
}

// ══ FECHAS Y VALIDACIÓN DE LA CONSULTA ═══════════════════════════════════════════════════

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** ¿"AAAA-MM-DD" y un día que existe? */
export function fechaValida(f: string | null | undefined): f is string {
  if (!f || !RE_FECHA.test(f)) return false;
  const [y, m, d] = f.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** Aritmética de días sobre la cadena ISO (sin zona horaria de por medio). */
export function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
}
/** El día d de Lima es [d 05:00Z, d+1 05:00Z). */
export function rangoLimaMs(desde: string, hasta: string): { desdeTs: number; hastaTs: number } {
  return { desdeTs: limaAUtcMs(desde, "00:00")!, hastaTs: limaAUtcMs(sumarDias(hasta, 1), "00:00")! };
}
/** El día de Lima de un instante (para rotular). */
export const diaLima = (ms: number) => fechaLima(ms);

/** Parte [desde, hasta] en tandas contiguas de como mucho `maxDias` (la pantalla pide un mes así). */
export function tandasDeRango(desde: string, hasta: string, maxDias = MAX_DIAS_CONSULTA): { desde: string; hasta: string }[] {
  const out: { desde: string; hasta: string }[] = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, maxDias)) {
    const fin = sumarDias(d, maxDias - 1);
    out.push({ desde: d, hasta: fin < hasta ? fin : hasta });
  }
  return out;
}

export type ConsultaExcesos = { desde: string; hasta: string; umbral: number; incluirFueraDeServicio: boolean };

/** Los umbrales que aceptan las APIs: de PASO_UMBRAL_KMH en PASO_UMBRAL_KMH entre el piso y el techo. */
export const UMBRALES_ACEPTADOS: readonly number[] = (() => {
  const out: number[] = [];
  for (let u = UMBRAL_MIN_KMH; u <= UMBRAL_MAX_KMH; u += PASO_UMBRAL_KMH) out.push(u);
  return out;
})();

/**
 * El umbral de una petición (texto del query): vacío → el defecto; un entero entre UMBRAL_MIN_KMH y
 * UMBRAL_MAX_KMH múltiplo de PASO_UMBRAL_KMH → ese; cualquier otra cosa → el motivo, para un 400. No se
 * «corrige» un umbral que alguien escribió mal: se dice cuáles valen. Lo usan /api/flota/excesos y
 * /api/flota/servicios (por `validarUmbral`, lib/flota/servicio-estadistica.ts), así que las dos aceptan lo mismo.
 */
export function leerUmbral(texto: string | null | undefined): { ok: true; umbral: number } | { ok: false; error: string } {
  if (texto == null || texto === "") return { ok: true, umbral: UMBRAL_DEFECTO_KMH };
  if (!/^\d{1,3}$/.test(texto)) return { ok: false, error: `El umbral es un entero en km/h, entre ${UMBRAL_MIN_KMH} y ${UMBRAL_MAX_KMH}.` };
  const umbral = Number(texto);
  if (umbral < UMBRAL_MIN_KMH || umbral > UMBRAL_MAX_KMH) {
    return { ok: false, error: `El umbral tiene que estar entre ${UMBRAL_MIN_KMH} y ${UMBRAL_MAX_KMH} km/h.` };
  }
  if (umbral % PASO_UMBRAL_KMH !== 0) {
    const abajo = umbral - (umbral % PASO_UMBRAL_KMH);
    return {
      ok: false,
      error: `El umbral va de ${PASO_UMBRAL_KMH} en ${PASO_UMBRAL_KMH} km/h (${UMBRAL_MIN_KMH}, ${UMBRAL_MIN_KMH + PASO_UMBRAL_KMH}, ${UMBRAL_MIN_KMH + 2 * PASO_UMBRAL_KMH}… ${UMBRAL_MAX_KMH}): ${umbral} no es uno de ellos. Elige ${abajo} o ${abajo + PASO_UMBRAL_KMH}.`,
    };
  }
  return { ok: true, umbral };
}

/**
 * Valida los parámetros de /api/flota/excesos. `hoy` es el día de Lima; `diasAtras` es hasta cuántos días
 * atrás puede empezar el rango (la ruta pasa DIAS_RASTREO; por defecto, DIAS_ATRAS_MAX_EXCESOS, su copia).
 * Mensajes para una persona.
 */
export function validarConsultaExcesos(
  q: { desde?: string | null; hasta?: string | null; umbral?: string | null; fuera?: string | null },
  hoy: string,
  diasAtras: number = DIAS_ATRAS_MAX_EXCESOS,
): { ok: true; consulta: ConsultaExcesos } | { ok: false; error: string } {
  const hasta = q.hasta || hoy;
  const desde = q.desde || sumarDias(hasta, -(MAX_DIAS_CONSULTA - 1));
  if (!fechaValida(desde) || !fechaValida(hasta)) return { ok: false, error: "Fechas inválidas (se espera AAAA-MM-DD)." };
  if (desde > hasta) return { ok: false, error: "El rango empieza después de terminar." };
  if (hasta > hoy) return { ok: false, error: "El rango no puede terminar en el futuro." };
  const minimo = sumarDias(hoy, -diasAtras);
  if (desde < minimo) {
    return { ok: false, error: `Los excesos se miden de los últimos ${diasAtras} días: el rango no puede empezar antes del ${minimo}.` };
  }
  if (diasEntre(desde, hasta) + 1 > MAX_DIAS_CONSULTA) {
    return { ok: false, error: `Se mide como mucho ${MAX_DIAS_CONSULTA} días por consulta; un rango mayor se pide en tandas.` };
  }
  const lu = leerUmbral(q.umbral);
  if (!lu.ok) return { ok: false, error: lu.error };
  const umbral = lu.umbral;
  const fuera = q.fuera ?? "0";
  if (fuera !== "0" && fuera !== "1") return { ok: false, error: "El parámetro «fuera» es 0 o 1." };
  return { ok: true, consulta: { desde, hasta, umbral, incluirFueraDeServicio: fuera === "1" } };
}
