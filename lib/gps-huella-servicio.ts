// lib/gps-huella-servicio.ts — QUÉ POSICIONES SON DE UN SERVICIO (motor PURO: sin base, sin red).
//
// Es la regla con la que `/api/cliente/gps` (modo huella) arma la estela del modal GPS, EXTRAÍDA tal
// cual de la ruta —no reescrita— para que la traza ajustada a la vía que se guarda para siempre
// (lib/gps-traza-ajustada*.ts) se calcule sobre EXACTAMENTE las filas que el modal recibe. Si quien
// calcula y quien lee armaran la huella cada uno a su manera, la firma de lo guardado no casaría
// nunca con la de lo leído: *escribir con una identidad y leer con otra*, el patrón que este repo ya
// pagó varias veces. El lector (`lib/gps-huella-servicio-datos.ts`) hace las consultas; aquí solo se
// decide.
//
// Lo que vivía en app/api/cliente/gps/route.ts y se mudó aquí: `tMs`, `limaMs`, `tramoDelServicio`,
// `HUECO_VIAJE_MS`, `MARGEN_PREVIO_MS`, `DURACION_MAX_MS` y el cálculo de la ventana y de `desdeTs`.
// Los comentarios largos de cada decisión se conservan junto a su código. La matriz
// (scripts/prueba-traza-ajustada.mts §6) lo compara contra el bloque original copiado literal.

import { PRECISION_MAX_HUELLA_M } from "./huella";

/* eslint-disable @typescript-eslint/no-explicit-any -- filas crudas de PostgREST, como en la ruta */

/**
 * created_at es la columna fiable (la setea el insert del conductor); timestamp puede no venir. Se
 * ordena/dedupea por la más reciente de ambas. (La usa también el modo lote de la ruta.)
 */
export const tMs = (g: any) => {
  const a = g?.created_at ? new Date(g.created_at).getTime() : 0;
  const b = g?.timestamp ? new Date(g.timestamp).getTime() : 0;
  return Math.max(a || 0, b || 0);
};

// Corte por tramos contiguos: un hueco > gapMs = la app dejó de transmitir = otro viaje (dentro
// de un servicio el conductor late cada ~25 s aun detenido). Sin él, la huella dibuja una recta
// larga uniendo el fin del viaje A con el inicio del viaje B. Ver tramoDelServicio, abajo.
export const HUECO_VIAJE_MS = 30 * 60 * 1000; // 30 min: separa servicios sin cortar paradas/cortes de señal

// Cuánto ANTES de la hora programada puede empezar a contar el GPS, y solo con el inicio ya
// confirmado: es el traslado cochera → primer paradero, que sí pertenece al servicio.
export const MARGEN_PREVIO_MS = 45 * 60 * 1000;
// Techo de duración de la ventana. 26 h y no 12: hay tours full day de hasta 24 h y una ventana
// más corta que el propio servicio le cortaría la huella por la mitad al final del viaje.
export const DURACION_MAX_MS = 26 * 60 * 60 * 1000;
// Sin fecha/hora programada (dato incompleto) la rama por vehículo cae al comportamiento histórico.
export const RESPALDO_SIN_PROGRAMA_MS = 12 * 60 * 60 * 1000;

/** "HH:MM[:SS]" del día `fecha` (Lima, UTC-5 sin DST) en ms epoch. Igual que api/gps-salud. */
export function limaMs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
  if (!fecha) return null;
  const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
  const t = Date.parse(`${fecha}T${h}-05:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parte la huella en tramos contiguos y devuelve EL DEL SERVICIO: el primer tramo que seguía
 * vivo a la hora de salida programada (`refTs`). La rama por-vehículo puede traer varios viajes
 * del mismo bus dentro de la ventana, y "quedarse con el último" —lo que hacía antes— solo
 * acierta cuando el servicio consultado es el que está ocurriendo AHORA: al abrir uno de ayer
 * devolvía el viaje de hoy.
 * LÍMITE CONOCIDO: si el bus hizo un traslado con hueco propio después de la hora de salida y el
 * servicio arrancó aún más tarde, gana el traslado. No se adivina más — el caso lo resuelve la
 * evidencia dura (puntos con reserva_id) y esta rama es el fallback.
 * `filas` viene ordenado por created_at asc.
 */
export function tramoDelServicio(filas: any[], gapMs: number, refTs: number | null): any[] {
  if (filas.length < 2) return filas;
  const tramos: any[][] = [];
  let inicio = 0;
  for (let i = 1; i < filas.length; i++) {
    if (tMs(filas[i]) - tMs(filas[i - 1]) > gapMs) { tramos.push(filas.slice(inicio, i)); inicio = i; }
  }
  tramos.push(filas.slice(inicio));
  const ultimo = tramos[tramos.length - 1];
  if (refTs == null) return ultimo;   // sin hora programada no hay con qué anclar → el más reciente
  return tramos.find(t => tMs(t[t.length - 1]) >= refTs) ?? ultimo;
}

/** Lo que la ventana necesita de la reserva (los tres campos que leía la ruta). */
export type ReservaVentana = { fecha_servicio?: string | null; hora_servicio?: string | null; estado?: string | null } | null;

export type VentanaServicio = {
  /** Hora programada (Lima) en ms, o null sin fecha. */
  progMs: number | null;
  /** Evidencia dura de inicio: puntos atados a la reserva, o estado en_curso/finalizada. */
  iniciado: boolean;
  /** Apertura y cierre de la ventana (null sin hora programada). */
  T0: number | null;
  T1: number | null;
  /** ¿Todavía no abre la ventana? (con el reloj del servidor). */
  antesDeLaVentana: boolean;
};

// ── VENTANA DEL SERVICIO ─────────────────────────────────────────────────
// Un punto GPS solo puede hablar de ESTE servicio si cae dentro de su ventana. La rama
// por-vehículo no tiene reserva_id y sin esta cota traía "las últimas 12 h del bus": el
// traslado desde cochera, el modo conectado-libre (enviarUbicacion manda reserva_id null
// mientras no hay recorrido iniciado) y hasta el servicio anterior si la separación fue <30 min.
// Esa huella ajena SEMBRABA el motor de avance (lib/avance-paradas.ts) y un servicio que aún no
// arrancaba aparecía con paraderos "detectados por GPS", el itinerario al 33 % y un ETA calculado
// desde una parada por la que el bus nunca pasó.
export function ventanaDelServicio(rsv: ReservaVentana, hayFilasDeReserva: boolean, ahoraMs: number): VentanaServicio {
  const progMs = limaMs(rsv?.fecha_servicio, rsv?.hora_servicio);
  // EVIDENCIA DURA DE INICIO, en este orden: puntos atados a la reserva (la app del conductor
  // ata cada fix al servicio al iniciar el recorrido) → estado puesto por una persona.
  const iniciado = hayFilasDeReserva || rsv?.estado === "en_curso" || rsv?.estado === "finalizada";
  // Con el inicio confirmado la ventana se abre antes: ese traslado al primer paradero SÍ es
  // parte del servicio. Sin confirmar, abre en la hora programada EXACTA — antes de esa hora
  // nadie puede afirmar que el bus se mueve por este servicio, y en una ruta de retorno pasa
  // cerca de paraderos posteriores camino al origen: justo el movimiento que producía los
  // falsos "ya pasó".
  const T0 = progMs != null ? progMs - (iniciado ? MARGEN_PREVIO_MS : 0) : null;
  const T1 = T0 != null ? T0 + DURACION_MAX_MS : null;
  const antesDeLaVentana = T0 != null && ahoraMs < T0;
  return { progMs, iniciado, T0, T1, antesDeLaVentana };
}

/**
 * ¿Se lee por VEHÍCULO? Solo si la rama por reserva no trajo nada, hay un vehículo y la ventana ya
 * abrió. (Tercero: sus puntos no llevan reserva_id.)
 */
export function usaRamaVehiculo(
  nFilasReserva: number, vehiculoId: unknown, vehiculoTerceroId: unknown, v: VentanaServicio,
): boolean {
  return nFilasReserva === 0 && (vehiculoTerceroId != null || vehiculoId != null) && !v.antesDeLaVentana;
}

/**
 * El rango de `created_at` de la rama por vehículo: la ventana del servicio; sin fecha/hora
 * programada (dato incompleto) se cae al comportamiento histórico de las últimas 12 h.
 */
export function rangoPorVehiculo(v: VentanaServicio, ahoraMs: number): { desde: string; hasta: string | null } {
  const desde = new Date(v.T0 ?? ahoraMs - RESPALDO_SIN_PROGRAMA_MS).toISOString();
  const hasta = v.T1 != null ? new Date(Math.min(v.T1, ahoraMs)).toISOString() : null;
  return { desde, hasta };
}

/**
 * Las filas que se DEVUELVEN (y sobre las que se firma y ajusta la traza):
 *  • Rama por-vehículo: la ventana del servicio todavía puede contener dos viajes del mismo bus (un
 *    full day de 24 h con relevo a media tarde) → `tramoDelServicio`. La rama por reserva_id ya está
 *    acotada a un único servicio, no se toca.
 *  • Coherencia escritura↔lectura: el conductor (enviarUbicacion) acepta fixes hasta 1500 m a
 *    propósito (tablets/FUSED por red sin chip GPS) y DELEGA el suavizado a la lectura. Si aquí
 *    cortáramos a 80 m, esos puntos (80–1500 m) se perderían → huella vacía o con huecos → rectas,
 *    justo en equipos posicionados por red. La imprecisión ya la absorben limpiarHuella + los radii de
 *    Map Matching (acc·1.5), así que basta descartar solo la basura de torre celular (el MISMO techo
 *    que la escritura).
 */
export function filasDelServicio(filas: any[], viaVehiculo: boolean, progMs: number | null): any[] {
  const base = viaVehiculo ? tramoDelServicio(filas, HUECO_VIAJE_MS, progMs) : filas;
  return base.filter((p: any) => p.precision_m == null || p.precision_m <= PRECISION_MAX_HUELLA_M);
}

/** El bloque `servicio` de la respuesta de /api/cliente/gps (modo huella), con sus claves en el MISMO orden. */
export type ServicioHuella = {
  iniciado: boolean;
  desdeTs: number | null;
  programadoTs: number | null;
  esperando: boolean;
  estado: string | null;
  via: "vehiculo" | "reserva" | "ninguna";
};

/**
 * `servicio` viaja con la huella para que el modal aplique la MISMA cota al fix EN VIVO (que no pasa
 * por aquí: llega por el modo individual) y no vuelva a envenenar el motor por la puerta de atrás.
 * `desdeTs` nunca recorta evidencia dura: si hay puntos atados a la reserva manda el primero de ellos
 * cuando es anterior a T0 — el bus pudo salir antes de lo programado y ese tramo es del servicio, lo
 * dice su propio reserva_id. El veredicto `esperando` lo emite el SERVIDOR — es el mismo que acaba de
 * dejar la huella vacía. Recalcularlo en el cliente con su propio reloj abre la puerta a que discrepen.
 */
export function servicioDeHuella(
  v: VentanaServicio, filasOk: any[], viaVehiculo: boolean, estado: string | null | undefined,
): ServicioHuella {
  const primeroReservaTs = !viaVehiculo && filasOk.length ? tMs(filasOk[0]) : null;
  const desdeTs = v.T0 == null ? null : primeroReservaTs ? Math.min(v.T0, primeroReservaTs) : v.T0;
  return {
    iniciado: v.iniciado, desdeTs, programadoTs: v.progMs,
    esperando: v.antesDeLaVentana && !v.iniciado,
    estado: estado ?? null,
    via: viaVehiculo ? "vehiculo" : filasOk.length ? "reserva" : "ninguna",
  };
}

// ── EL FIX EN VIVO DEL MODAL: ¿esta fila es del servicio que se está mirando? ─────────────────────
//
// El modal GPS recibe la posición por DOS caminos: la consulta cada 10 s (`/api/cliente/gps`, modo
// individual: la última fila de la reserva y, solo si la reserva no tiene ninguna, la última «en_ruta»
// de la unidad) y el tiempo real de `ubicaciones_gps`. El tiempo real aceptaba CUALQUIER fila de la
// unidad. Reserva #1459 (14-10-2026): el conductor pulsó «Finalizar» a las 16:46 y su teléfono siguió
// mandando posiciones de la CWQ400 —de otro servicio o conectado sin servicio—; cada una movía el ícono
// a donde estaba el bus AHORA y la cabecera pasaba a «GPS en vivo», y a los 10 s la consulta devolvía
// el último punto del servicio y volvía a «Servicio finalizado». El operador y el cliente veían el bus
// saltar entre dos sitios. Ahora el tiempo real contesta la MISMA pregunta que la consulta:
//   1. la fila de ESTA reserva es del servicio (salvo que sea más vieja que la que ya se muestra:
//      la cola offline del teléfono no puede hacer retroceder el ícono);
//   2. la de OTRA reserva no lo es nunca;
//   3. sin reserva en la fila, solo vale lo que valdría el respaldo de la consulta: la unidad del
//      servicio, en estado «en_ruta», mientras la reserva no tenga ninguna fila propia y no esté
//      cerrada. En cuanto llegó una fila del servicio —o el servicio terminó— una fila sin reserva es
//      la unidad haciendo otra cosa.
// Sin reserva (llamador sin servicio), la regla de antes: la unidad.
export type MotivoFilaVivo =
  | "del_servicio" | "por_unidad"                                            // se acepta
  | "anterior" | "otro_servicio" | "otra_unidad" | "servicio_cerrado"        // no se acepta
  | "fuera_del_servicio" | "sin_servicio";
export type ContextoFilaVivo = {
  reservaId: number | null;
  vehiculoId: number | null;
  vehiculoTerceroId: number | null;
  /** ¿Ya se mostró alguna fila de ESTA reserva? */
  vioFilaDelServicio: boolean;
  /** La reserva está finalizada/cancelada o su último punto es el de «Finalizar». */
  servicioCerrado: boolean;
  /** ts de la posición que se muestra (null = ninguna). */
  ultimoTs: number | null;
};
const idNum = (x: any): number | null => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
export function filaEnVivoDelServicio(fila: any, ctx: ContextoFilaVivo): { acepta: boolean; motivo: MotivoFilaVivo } {
  const no = (motivo: MotivoFilaVivo) => ({ acepta: false, motivo });
  const ts = tMs(fila);
  const rid = idNum(fila?.reserva_id), vid = idNum(fila?.vehiculo_id), vtid = idNum(fila?.vehiculo_tercero_id);
  const reserva = idNum(ctx.reservaId), veh = idNum(ctx.vehiculoId), vehT = idNum(ctx.vehiculoTerceroId);
  const masVieja = ctx.ultimoTs != null && ts > 0 && ts < ctx.ultimoTs;
  if (reserva != null && rid === reserva) return masVieja ? no("anterior") : { acepta: true, motivo: "del_servicio" };
  if (reserva != null && rid != null) return no("otro_servicio");
  const deLaUnidad = (vehT != null && vtid === vehT) || (vehT == null && veh != null && vid === veh);
  if (!deLaUnidad) return no("otra_unidad");
  if (reserva == null) return masVieja ? no("anterior") : { acepta: true, motivo: "por_unidad" };
  if (ctx.servicioCerrado) return no("servicio_cerrado");
  if (ctx.vioFilaDelServicio) return no("fuera_del_servicio");
  if (fila?.estado !== "en_ruta") return no("sin_servicio");
  return masVieja ? no("anterior") : { acepta: true, motivo: "por_unidad" };
}
