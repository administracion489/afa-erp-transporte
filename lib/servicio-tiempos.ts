// lib/servicio-tiempos.ts — ¿A QUÉ HORA salió y a qué hora terminó REALMENTE el servicio?
// Motor PURO: sin React, sin DOM, sin fetch, sin Supabase. Recibe filas, devuelve veredictos.
// Importable desde un cron de servidor igual que desde una pantalla.
//
// ── EL PROBLEMA ───────────────────────────────────────────────────────────────────────
// Hoy la hora real de un servicio se PIDE A MANO: app/seguimiento/page.tsx:520-541 tiene dos
// inputs (`hora_real_inicio`, `hora_real_fin`) que un operador debería teclear al cierre.
// No los teclea nadie. Medición sobre producción (30 días, corte 2026-08-20):
//
//     575 servicios operados
//       reservas.hora_real_inicio ...  1 de 575
//       reservas.hora_real_fin ......  0 de 575   ← CERO en un mes
//
// O sea: el campo del que cuelgan el reporte de servicio (app/seguimiento/page.tsx:1163-1170),
// la duración impresa y —cuando se enchufe— la liquidación, está VACÍO. Mientras tanto el
// conductor SÍ dejó evidencia por todos lados, y abundante:
//
//     4602 paradas completadas, de ellas 4132 CON hora_llegada .... 90 %
//     465 de 575 servicios con al menos una hora de parada ........ 81 %
//     2805 abordajes con hora (reloj de servidor)
//     493 de 575 servicios con puntos GPS ......................... 86 %
//
// La hora real no falta: falta DERIVARLA. Eso es todo lo que hace este módulo.
//
// ── PROCEDENCIA, NO SOLO UN NÚMERO ────────────────────────────────────────────────────
// Cada hora sale acompañada de DE DÓNDE salió y de cuánto vale esa evidencia. No es adorno:
// una hora tomada del primer punto GPS y una hora marcada por el conductor no son el mismo
// hecho y no pueden pintarse igual ni facturarse igual. `created_at` de ubicaciones_gps lo
// escribe el TELÉFONO del conductor (app/conductor/page.tsx:1279 → app/api/conductor/route.ts:417,
// el servidor lo acepta tal cual), y la memoria del proyecto ya documenta relojes desfasados en
// la flota; `pasajeros_parada.hora_abordaje` en cambio lo pone el SERVIDOR
// (app/api/conductor/route.ts:532-537). Por eso todo lo que venga de GPS sale con
// `estimado: true` y confianza baja, y la UI lo pinta en cursiva con "~".
//
// ── LO QUE ESTE MÓDULO NO HACE, DELIBERADAMENTE ───────────────────────────────────────
// No escribe en la base. Nunca. lib/avance-paradas.ts:30 fijó la doctrina de la casa —"inferir
// para PINTAR es otra cosa que inferir para ESCRIBIR"—: una hora inferida por GPS que se
// PERSISTA como hora_real_inicio deja de ser una estimación y pasa a ser un dato duro que
// alguien va a facturar. Aquí solo se DERIVA; quién guarda algo (y con qué evidencia) se
// decide fuera y queda marcado como manual.
//
// ── DOS FINES, NO UNO (decisión del dueño, 2026-08-20) ────────────────────────────────
// "Terminó el servicio" son dos hechos distintos y se exponen por separado:
//   • finParadero — llegada al ÚLTIMO paradero. Es la que va a la LIQUIDACIÓN.
//   • finCierre   — cuando el conductor pulsó finalizar / última señal. Es la OPERATIVA.
// Un bus que descarga al último pasajero 18:40 y recién cierra la app 19:25 en la cochera
// tiene las dos horas bien; cobrar la segunda es cobrar el retorno a cochera. Se devuelven
// ambas y `mostrarAmbosFines` avisa cuándo la diferencia amerita enseñarlas juntas.
//
// ── LA CORRECCIÓN HUMANA GANA SOBRE LA EVIDENCIA ESTIMADA ─────────────────────────────
// Promesa central del diseño: un valor de fuente "operador" NUNCA se descarta en silencio por
// una estimación. Un solo punto GPS suelto llegó a anular una `hora_real_fin` tecleada y a dejar
// la duración en 0 (defecto :498). Reglas, en este orden:
//   1. "parada" (llegada al último paradero) y "gps_finalizado" (el conductor PULSÓ finalizar)
//      son evidencia DURA del cierre y mandan sobre lo tecleado.
//   2. "operador" gana SIEMPRE a "gps_ultimo" (que solo dice "hasta aquí transmitió").
//   3. Si el operador tecleó un fin y además hay evidencia dura que lo contradice, se CONSERVAN
//      LOS DOS (`finOperador` + `finCierre`) y la discrepancia se enseña; no se tira ninguno.
//   4. Y si un valor del operador no gana por el motivo que sea, igual aparece en la línea de
//      tiempo con su nota. Nunca desaparece sin rastro.
//      ÚNICA EXCEPCIÓN, y es una limitación honesta, no un descuido: si la reserva no tiene
//      `fecha_servicio`, un "HH:MM" suelto no se puede anclar a ningún instante y no hay dónde
//      colocarlo en la línea. Se pierde. Anclarlo al reloj del servidor sería meter por la puerta
//      de atrás justo el error que este módulo evita.
//
// ── LA TRAMPA DE LA MEDIANOCHE ────────────────────────────────────────────────────────
// `reservas.hora_real_inicio` / `hora_real_fin` son "HH:MM:SS" DEL DÍA, sin fecha
// (app/seguimiento/page.tsx:1144-1148 lo documenta). Un servicio que sale 22:00 y cierra 01:30
// da −1230 minutos, y hoy eso se tapa con `Math.max(0, ...)` (app/seguimiento/page.tsx:1150):
// la duración sale 0 y nadie se entera. Aquí se compone la hora CON `fecha_servicio` en Lima y,
// si el fin cae antes del inicio, se asume cruce de medianoche (+1 día) SOLO si el resultado
// cabe en 26 h — el mismo techo que ya usa la ventana de la huella
// (app/api/cliente/gps/route.ts:56-58: "26 h y no 12: hay tours full day de hasta 24 h").
//
// ── CALIBRACIÓN CITADA, NO INVENTADA ──────────────────────────────────────────────────
// La gracia para declarar "no arrancó" es la MISMA que ya rige en el repo: `no_inicio` de
// alerta_config = 10 min, replicado en app/seguimiento/page.tsx:134 (GRACIA_FALLBACK_MIN) y en
// lib/retrasos.ts:125 (toleranciaMin). Se IMPORTA de ./retrasos en vez de re-escribirse: si
// mañana el operador la mueve, se mueve en un solo sitio. hhmmMin/minHhmm también vienen de ahí.

import { CONFIG_RETRASO_DEFAULT, hhmmMin, minHhmm } from "./retrasos";
import { normalizaEstado, type EstadoReserva } from "./estados";

// ══════════════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════════════

export type FuenteTiempo =
  | "parada"          // paradas.hora_llegada — el conductor marcó el paradero
  | "abordaje"        // pasajeros_parada.hora_abordaje — alguien subió (reloj de SERVIDOR)
  | "evento_salio"    // push_eventos_viaje.evento='salio' — se avisó a los pasajeros
  | "gps"             // primer punto de ubicaciones_gps del servicio
  | "gps_finalizado"  // punto GPS con estado='finalizado' (el conductor pulsó finalizar)
  | "gps_ultimo"      // última señal, sin cierre explícito
  | "operador";       // reservas.hora_real_inicio / hora_real_fin, tecleado a mano

export type Confianza = "alta" | "media" | "baja";

export type Instante = {
  /** epoch ms */
  ts: number;
  /** "HH:MM" en hora de LIMA (UTC-5, sin DST) */
  hhmm: string;
  fuente: FuenteTiempo;
  /** texto listo para pintar: "marcado por el conductor", "abordaje QR", "estimado por GPS" */
  etiqueta: string;
  confianza: Confianza;
  /** true = se pinta en cursiva, con "~", y JAMÁS se persiste */
  estimado: boolean;
};

export type NivelSalida =
  | "salio"              // hay hora de inicio
  | "operado_sin_hora"   // hubo servicio, pero ninguna evidencia trae hora → GRIS, nunca rojo
  | "no_arranco"         // es hoy, pasó la gracia y CERO evidencia de cualquier tipo
  | "por_salir"          // todavía no es la hora
  | "na";                // cancelada, u otro día sin nada que decir

export type VeredictoSalida = {
  nivel: NivelSalida;
  instante: Instante | null;
  motivo: string;
};

export type FilaLinea = {
  /** "inicio" · "parada:<id>" · "cierre" */
  clave: string;
  etiqueta: string;
  instante: Instante | null;
  /** hora planificada "HH:MM" (hora_servicio para el inicio, hora_estimada por parada) */
  previstaHhmm: string | null;
  /** real − prevista, en minutos. Positivo = tarde. null si falta alguna de las dos. */
  desviacionMin: number | null;
  nota: string | null;
};

export type TiemposServicio = {
  inicio: Instante | null;
  /** llegada al último paradero — LA QUE FACTURA */
  finParadero: Instante | null;
  /** cierre del conductor / última señal — la OPERATIVA */
  finCierre: Instante | null;
  /**
   * Lo que el operador tecleó en `reservas.hora_real_fin`, SIEMPRE que sea componible.
   * Se expone aparte (campo añadido por el defecto :498) porque un valor humano no puede
   * desaparecer: si `finCierre` no es este mismo objeto, hay evidencia dura que lo contradice
   * y las dos horas deben enseñarse juntas.
   */
  finOperador: Instante | null;
  /** el MÁS TARDÍO de los dos */
  fin: Instante | null;
  /** true si ambos existen y difieren más de `brechaFinesMin` */
  mostrarAmbosFines: boolean;
  /** minutos entre `inicio` y `fin`. null si falta alguno, si el par es incoherente o si la
   *  duración no cabe en el techo de 26 h que declara el módulo (defecto :521-525). */
  duracionMin: number | null;
  veredicto: VeredictoSalida;
  /** línea de tiempo ordenada, lista para pintar */
  linea: FilaLinea[];
};

// ── Entradas (nombres de columna verificados contra el código que las escribe) ─────────

export type ReservaTiempos = {
  id?: number | null;
  estado?: string | null;
  /** "YYYY-MM-DD" */
  fecha_servicio?: string | null;
  /** "HH:MM[:SS]" del día */
  hora_servicio?: string | null;
  /** "HH:MM:SS" del día, SIN fecha */
  hora_real_inicio?: string | null;
  /** "HH:MM:SS" del día, SIN fecha */
  hora_real_fin?: string | null;
};

export type ParadaTiempos = {
  id: number;
  orden?: number | null;
  nombre?: string | null;
  /** 'completada' = el conductor la marcó (app/api/conductor/route.ts:451-463) */
  estado?: string | null;
  /** "HH:MM" del día — planificada */
  hora_estimada?: string | null;
  /** timestamptz ISO — hora REAL de arribo (supabase/paradas-hora-llegada.sql) */
  hora_llegada?: string | null;
};

export type AbordajeTiempos = {
  parada_id?: number | null;
  pasajero_id?: number | null;
  /** timestamptz ISO puesto por el SERVIDOR (app/api/conductor/route.ts:532-537) */
  hora_abordaje?: string | null;
};

export type EventoViajeTiempos = {
  /** 'salio' | 'quedan_paradas' | 'aproximandose' | 'llego' | 'embarcado' */
  evento?: string | null;
  /** timestamptz ISO, default now() en BD (supabase/push-notificaciones.sql:64) */
  enviado_en?: string | null;
};

export type PuntoGpsTiempos = {
  /** epoch ms ya normalizado. Si falta, se parsea `created_at`. */
  ts?: number | null;
  /** timestamptz ISO — OJO: lo escribe el TELÉFONO del conductor, no el servidor */
  created_at?: string | null;
  /** 'en_ruta' | 'disponible' | 'finalizado' | 'sos' */
  estado?: string | null;
};

export type EntradaTiempos = {
  reserva: ReservaTiempos;
  /** paradas de ESTA reserva (cualquier orden; se ordenan aquí) */
  paradas?: ParadaTiempos[] | null;
  /** filas de pasajeros_parada de ESTA reserva */
  abordajes?: AbordajeTiempos[] | null;
  /** filas de push_eventos_viaje de ESTA reserva */
  eventos?: EventoViajeTiempos[] | null;
  /** puntos de ubicaciones_gps de ESTE servicio (ya acotados a su ventana por el llamador) */
  gps?: PuntoGpsTiempos[] | null;
  /** ahora, en epoch ms */
  ahoraMs: number;
  /** hoy en Lima, "YYYY-MM-DD". Si falta se deriva de `ahoraMs`. */
  hoy?: string | null;
  /** gracia para "no arrancó". Por defecto la de alerta_config (`no_inicio`). */
  graciaMin?: number;
  /** diferencia a partir de la cual se muestran los DOS fines. Por defecto 10 min. */
  brechaFinesMin?: number;
};

// ══════════════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════════════

/** Perú es UTC-5 sin horario de verano. Misma convención que app/api/cliente/gps/route.ts:63. */
const LIMA_OFFSET_MS = -5 * 3_600_000;

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

// Techo de duración. 26 h y no 12: hay tours full day de hasta 24 h — verbatim de
// app/api/cliente/gps/route.ts:56-58 (DURACION_MAX_MS). NO es solo para promover el día al cruzar
// la medianoche: también INVALIDA (defecto :521-525 — se midieron duraciones de 54 h publicadas
// como dato bueno porque el techo nunca se aplicaba al resultado).
const DURACION_MAX_MS = 26 * 3_600_000;

// Diferencia a partir de la cual finParadero y finCierre dejan de ser "la misma hora" y hay que
// enseñar las dos. 10 min ≈ lo que tarda un bus en salir del paradero y estacionar; por debajo,
// mostrar dos horas casi idénticas es ruido.
const BRECHA_FINES_MIN = 10;

// Ninguna evidencia puede venir del futuro. Se tolera desfase de reloj del dispositivo antes de
// descartarla: mismo criterio y mismo número que lib/odometro.ts:124-125
// (HORAS_FUTURO_TOLERANCIA = 6), que existe exactamente por los teléfonos de esta flota.
const FUTURO_TOLERANCIA_MS = 6 * 3_600_000;

// Ventana de sanidad alrededor del día del servicio. Un timestamp fuera de esto no es una hora
// tardía: es un reloj roto o un JOIN equivocado, y si entra envenena toda la línea de tiempo.
// Hacia atrás 6 h (traslado de cochera de madrugada + desfase de reloj); hacia adelante 50 h
// (un servicio que arranca 23:00 y dura 24 h cierra 47 h después de la medianoche del día).
const VENTANA_ANTES_MS  = 6 * 3_600_000;
const VENTANA_DESPUES_MS = 50 * 3_600_000;

// Media vuelta de reloj. Sirve para decidir a qué lado de la medianoche cae una hora "HH:MM"
// suelta comparada con otra: se elige SIEMPRE la interpretación más cercana.
const MEDIO_DIA_MIN = 720;

/** Texto por fuente. Una sola redacción para toda la app (torre, drawer, reporte, cron). */
const ETIQUETA_FUENTE: Record<FuenteTiempo, string> = {
  parada:         "marcado por el conductor",
  abordaje:       "abordaje QR",
  evento_salio:   "aviso de salida a los pasajeros",
  gps:            "estimado por GPS",
  gps_finalizado: "cierre del conductor",
  gps_ultimo:     "última señal GPS",
  operador:       "registrado por operación",
};

/**
 * Cuánto vale cada evidencia.
 *  • parada / abordaje / evento_salio → ALTA: son actos humanos registrados, y en los dos
 *    últimos el timestamp lo pone el SERVIDOR.
 *  • gps / gps_ultimo → BAJA: `created_at` es el reloj del CELULAR y el primer/último punto
 *    puede ser el traslado de cochera, no el servicio.
 *  • gps_finalizado → MEDIA: el punto existe porque el conductor PULSÓ finalizar
 *    (app/conductor/page.tsx:1819,1905 y app/api/conductor-tercero/finalizar/route.ts:33), así
 *    que el HECHO es firme; lo que sigue siendo dudoso es la hora, por el mismo reloj.
 *  • operador → MEDIA: es un humano tecleando, a veces días después y de memoria.
 */
const CONFIANZA_FUENTE: Record<FuenteTiempo, Confianza> = {
  parada: "alta", abordaje: "alta", evento_salio: "alta",
  gps: "baja", gps_finalizado: "media", gps_ultimo: "baja",
  operador: "media",
};

/** Todo lo que sale del GPS es una ESTIMACIÓN y jamás se persiste (ver cabecera). */
const FUENTES_ESTIMADAS: FuenteTiempo[] = ["gps", "gps_finalizado", "gps_ultimo"];

/**
 * Estados CRUDOS (tal como vienen en la fila, antes de normalizar) que significan "todavía no
 * arrancó". Existe por el defecto :408: `normalizaEstado()` devuelve "pendiente" para CUALQUIER
 * cadena que no conozca (lib/estados.ts:92 `default`), así que un servicio con estado 'terminada'
 * —que la lista blanca no contempla— se leía como "pendiente" y el módulo lo acusaba de
 * "no_arranco". Ejecutado: estado='terminada', hoy, hora 05:00, ahora 23:00 → "NO SALIÓ" en rojo.
 * La acusación exige estado RECONOCIDO como no-iniciado; ante uno desconocido el módulo degrada.
 * Se enumeran las variantes crudas que `normalizaEstado` mapea a pendiente/programada/confirmada.
 */
const ESTADOS_CRUDOS_NO_INICIADOS = new Set([
  "pendiente", "programada", "por_confirmar", "confirmada", "confirmado",
]);

/** true solo si la cadena cruda está en la lista blanca de "no iniciado". "" y null → false. */
function esEstadoCrudoNoIniciado(e: string | null | undefined): boolean {
  return ESTADOS_CRUDOS_NO_INICIADOS.has(String(e ?? "").trim().toLowerCase());
}

// ══════════════════════════════════════════════════════════════════════════════════════
// HELPERS DE TIEMPO — Lima siempre, el reloj del equipo nunca
// ══════════════════════════════════════════════════════════════════════════════════════

/** "HH:MM[:SS]" del día `fecha` en hora de Lima → epoch ms. Igual que app/api/cliente/gps:60-65. */
export function limaMs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
  if (!fecha) return null;
  const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
  const t = Date.parse(`${fecha}T${h}-05:00`);
  return Number.isFinite(t) ? t : null;
}

/** epoch ms → "HH:MM" en Lima. */
export function hhmmLima(ts: number): string {
  const d = new Date(ts + LIMA_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** epoch ms → minuto del día en Lima (0-1439). */
export function minutosLima(ts: number): number {
  const d = new Date(ts + LIMA_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** epoch ms → "YYYY-MM-DD" en Lima. */
export function fechaLima(ts: number): string {
  return new Date(ts + LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** timestamptz ISO → epoch ms, o null si no parsea. */
function tsIso(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Diferencia real − prevista en minutos del día, resuelta al lado MÁS CERCANO de la medianoche.
 * Una parada estimada 23:50 a la que se llega 00:05 son +15 min, no −1425.
 */
function desvioMin(realMin: number, previstaMin: number): number {
  let d = realMin - previstaMin;
  while (d > MEDIO_DIA_MIN) d -= 1440;
  while (d < -MEDIO_DIA_MIN) d += 1440;
  return d;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// CONSTRUCCIÓN DE INSTANTES
// ══════════════════════════════════════════════════════════════════════════════════════

function crearInstante(ts: number, fuente: FuenteTiempo, detalle?: string | null): Instante {
  const base = ETIQUETA_FUENTE[fuente];
  return {
    ts,
    hhmm: hhmmLima(ts),
    fuente,
    etiqueta: detalle ? `${base} · ${detalle}` : base,
    confianza: CONFIANZA_FUENTE[fuente],
    estimado: FUENTES_ESTIMADAS.indexOf(fuente) >= 0,
  };
}

type Ventana = { min: number; max: number };

/**
 * Ventana de sanidad del servicio. Sin `fecha_servicio` no hay contra qué anclar y solo queda el
 * clamp de futuro — es lo honesto: inventar una ventana sobre el reloj del servidor volvería a
 * meter por la puerta de atrás justo el error que este módulo evita.
 */
function ventanaDelDia(fecha: string | null | undefined, ahoraMs: number): Ventana {
  const medianoche = limaMs(fecha, "00:00:00");
  const techoFuturo = ahoraMs + FUTURO_TOLERANCIA_MS;
  if (medianoche === null) return { min: -Infinity, max: techoFuturo };
  return {
    min: medianoche - VENTANA_ANTES_MS,
    max: Math.min(medianoche + VENTANA_DESPUES_MS, techoFuturo),
  };
}

const dentro = (ts: number | null, v: Ventana): boolean =>
  ts !== null && Number.isFinite(ts) && ts >= v.min && ts <= v.max;

// ══════════════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN DE ENTRADAS
// ══════════════════════════════════════════════════════════════════════════════════════

type ParadaNorm = ParadaTiempos & { ordenN: number; completada: boolean; llegadaTs: number | null };

function normalizarParadas(paradas: ParadaTiempos[] | null | undefined, v: Ventana): ParadaNorm[] {
  return (paradas || [])
    .filter((p): p is ParadaTiempos => !!p && p.id != null)
    .map((p, i) => {
      const ts = tsIso(p.hora_llegada);
      return {
        ...p,
        ordenN: Number.isFinite(Number(p.orden)) ? Number(p.orden) : i,
        completada: p.estado === "completada",
        // Una hora_llegada fuera de la ventana no se "corrige": se descarta y la parada queda
        // como completada SIN hora. Preferible un hueco honesto a una hora falsa en el reporte.
        llegadaTs: dentro(ts, v) ? ts : null,
      };
    })
    .sort((a, b) => a.ordenN - b.ordenN || Number(a.id) - Number(b.id));
}

/** epoch ms de los puntos GPS, ordenados y dentro de la ventana. */
function normalizarGps(gps: PuntoGpsTiempos[] | null | undefined, v: Ventana): { ts: number; estado: string }[] {
  return (gps || [])
    .map((g) => {
      const ts = Number.isFinite(Number(g?.ts)) && Number(g?.ts) > 0 ? Number(g!.ts) : tsIso(g?.created_at);
      return { ts, estado: String(g?.estado ?? "") };
    })
    .filter((g): g is { ts: number; estado: string } => dentro(g.ts, v))
    .sort((a, b) => a.ts - b.ts);
}

// ══════════════════════════════════════════════════════════════════════════════════════
// MOTOR
// ══════════════════════════════════════════════════════════════════════════════════════

const SIN_TIEMPOS = (nivel: NivelSalida, motivo: string): TiemposServicio => ({
  inicio: null, finParadero: null, finCierre: null, finOperador: null, fin: null,
  mostrarAmbosFines: false, duracionMin: null,
  veredicto: { nivel, instante: null, motivo },
  linea: [],
});

/**
 * Deriva el horario real del servicio a partir de la evidencia que dejó el conductor.
 * Puro y determinista: mismas entradas, misma salida. No toca la base ni decide qué se guarda.
 */
export function derivarTiempos(e: EntradaTiempos): TiemposServicio {
  const r = e.reserva || {};
  const estado: EstadoReserva = normalizaEstado(r.estado);
  const ahoraMs = Number.isFinite(e.ahoraMs) ? e.ahoraMs : Date.now();
  const hoy = e.hoy || fechaLima(ahoraMs);
  const gracia = Number.isFinite(Number(e.graciaMin))
    ? Number(e.graciaMin)
    : CONFIG_RETRASO_DEFAULT.toleranciaMin;   // = `no_inicio` de alerta_config (10 min)
  const brechaFines = Number.isFinite(Number(e.brechaFinesMin)) ? Number(e.brechaFinesMin) : BRECHA_FINES_MIN;

  const v = ventanaDelDia(r.fecha_servicio, ahoraMs);
  const paradas = normalizarParadas(e.paradas, v);
  const gps = normalizarGps(e.gps, v);
  const servicioMin = hhmmMin(r.hora_servicio);

  // Los abordajes se aceptan como HORA solo si pertenecen a una parada de ESTA reserva.
  // `embarcar_qr` mueve pasajeros entre paradas y entre buses (app/api/conductor/route.ts:638-665):
  // una fila arrastrada de otro servicio metería una hora de otro viaje como "salida".
  //
  // Defecto :426 — la guarda traía `|| idsParada.size === 0`, o sea se autodesactivaba justo en el
  // escenario que decía cubrir: sin `paradas` se aceptaban TODOS los abordajes sin verificar nada
  // (ejecutado: sin paradas, abordaje con parada_id=9999 a las 18:00 → inicio 18:00/abordaje).
  // CONSECUENCIA ASUMIDA de quitarla: si el llamador no pasa `paradas`, o si la fila no trae
  // `parada_id`, la pertenencia NO se puede verificar y esta fuente NO se usa para la hora — la
  // cascada baja al siguiente escalón (evento 'salio' → GPS). Preferimos perder un escalón de
  // precisión antes que fechar un servicio con la hora de otro.
  const idsParada = new Set(paradas.map((p) => Number(p.id)));
  const abordajesConHora = (e.abordajes || [])
    .filter((a) => !!a)
    .map((a) => ({ paradaId: a.parada_id == null ? null : Number(a.parada_id), ts: tsIso(a.hora_abordaje) }))
    .filter((a): a is { paradaId: number | null; ts: number } => dentro(a.ts, v));

  // Abordajes que ocurrieron pero cuya hora NO es creíble (fuera de la ventana de sanidad).
  // Cuentan como prueba de que hubo servicio, no como hora. Ver el bloque de GPS más abajo.
  const abordajesFuera = (e.abordajes || [])
    .filter((a) => !!a && tsIso(a.hora_abordaje) !== null).length - abordajesConHora.length;

  const abordajesTs = abordajesConHora
    .filter((a) => a.paradaId !== null && idsParada.has(a.paradaId))
    .map((a) => a.ts)
    .sort((x, y) => x - y);

  // Para el VEREDICTO se cuentan todos: que no se pueda verificar la parada no borra el hecho de
  // que alguien subió a un bus, y degradar esa prueba convertiría un "operó sin hora" (gris) en un
  // "no arrancó" (rojo) — exactamente el falso positivo que este módulo existe para eliminar.
  // Y por el mismo motivo se suman los de hora increíble: la ventana juzga la HORA, no el hecho.
  const abordajesEvidencia = abordajesConHora.length + abordajesFuera;

  const salioTs = (e.eventos || [])
    .filter((x) => x && x.evento === "salio")
    .map((x) => tsIso(x.enviado_en))
    .filter((t): t is number => dentro(t, v))
    .sort((a, b) => a - b);

  const completadasConHora = paradas.filter((p) => p.completada && p.llegadaTs !== null);

  // ── Cancelada: no hay horario que derivar y forzarlo solo ensucia el reporte ─────────
  if (estado === "cancelada") return SIN_TIEMPOS("na", "servicio cancelado");

  // ────────────────────────────────────────────────────────────────────────────────────
  // CASCADA DE INICIO — gana la primera con valor. El orden NO es arbitrario: va de la
  // evidencia más ligada al hecho "el bus arrancó" a la más circunstancial.
  // ────────────────────────────────────────────────────────────────────────────────────
  let inicio: Instante | null = null;

  // 1. Parada de MENOR orden marcada completada con hora. Es el arranque tal como lo vivió el
  //    conductor: llegó al primer paradero y lo marcó. Cobertura medida: 81 % de los servicios.
  const primeraMarcada = completadasConHora[0];
  if (primeraMarcada) {
    inicio = crearInstante(primeraMarcada.llegadaTs as number, "parada", primeraMarcada.nombre || null);
  }

  // 2. Primer abordaje. Si alguien subió al bus, el bus estaba ahí — y el timestamp lo puso el
  //    SERVIDOR, así que no depende del reloj del teléfono.
  if (!inicio && abordajesTs.length) inicio = crearInstante(abordajesTs[0], "abordaje");

  // 3. El push "¡tu bus ya salió!" (app/api/conductor/route.ts:893-905). Solo se emite cuando el
  //    conductor pone la reserva en_curso, así que es prueba directa del toque de "Iniciar".
  if (!inicio && salioTs.length) inicio = crearInstante(salioTs[0], "evento_salio");

  // 4. Lo que alguien tecleó. Va DESPUÉS de la evidencia dura (parada/abordaje/aviso de salida)
  //    —si el conductor dejó el hecho del día, ese manda sobre lo que se escribió de memoria—
  //    pero ANTES del GPS: el primer fix es una ESTIMACIÓN de confianza baja (reloj del celular,
  //    y puede ser el traslado de cochera), y la corrección humana gana siempre a una estimación
  //    (misma doctrina que arregla el defecto :498 en la cascada de fin).
  //    Se compone SIEMPRE, gane o no, para poder dejar rastro de él en la línea de tiempo.
  let inicioOperador: Instante | null = null;
  if (r.hora_real_inicio) {
    let ts = limaMs(r.fecha_servicio, r.hora_real_inicio);
    // "HH:MM:SS" sin fecha: si queda más de medio día ANTES de la hora pactada, en realidad es
    // del día siguiente (servicio nocturno que arrancó pasada la medianoche).
    if (ts !== null && servicioMin !== null && minutosLima(ts) - servicioMin < -MEDIO_DIA_MIN) ts += DIA_MS;
    if (ts !== null) inicioOperador = crearInstante(ts, "operador");
  }
  if (!inicio && inicioOperador) inicio = inicioOperador;

  // 5. Primer punto GPS. Confianza BAJA a propósito: puede ser el traslado desde cochera, y la
  //    hora es la del celular. Sirve para PINTAR, nunca para cobrar.
  if (!inicio && gps.length) inicio = crearInstante(gps[0].ts, "gps");

  // ────────────────────────────────────────────────────────────────────────────────────
  // CASCADA DE FIN — DOS valores separados (decisión del dueño, ver cabecera)
  // ────────────────────────────────────────────────────────────────────────────────────

  // A. Llegada al ÚLTIMO paradero marcado. La que factura.
  const ultimaMarcada = completadasConHora.length ? completadasConHora[completadasConHora.length - 1] : null;
  let finParadero: Instante | null =
    ultimaMarcada ? crearInstante(ultimaMarcada.llegadaTs as number, "parada", ultimaMarcada.nombre || null) : null;

  // B. Cierre operativo. El punto con estado='finalizado' NO es un fix más: la app lo FUERZA al
  //    pulsar finalizar, saltándose el throttle (app/conductor/page.tsx:1212 "forzar"), así que su
  //    existencia prueba el cierre. Se toma el ÚLTIMO por si el conductor cerró, revirtió y volvió
  //    a cerrar. Sin él queda la última señal, que solo dice "hasta aquí transmitió".
  const finalizados = gps.filter((g) => g.estado === "finalizado");
  const finGpsFinalizado: Instante | null = finalizados.length
    ? crearInstante(finalizados[finalizados.length - 1].ts, "gps_finalizado")
    : null;
  const finGpsUltimo: Instante | null = gps.length
    ? crearInstante(gps[gps.length - 1].ts, "gps_ultimo")
    : null;

  // C. Lo tecleado por el operador. Se COMPONE SIEMPRE, gane o no gane el cierre: es un valor
  //    humano y no puede desaparecer sin rastro (si no gana, sale en la línea de tiempo con nota).
  let finOperador: Instante | null = null;
  if (r.hora_real_fin) {
    let ts = limaMs(r.fecha_servicio, r.hora_real_fin);
    if (ts !== null) {
      // AQUÍ vive el bug de la medianoche. `Math.max(0, fin − ini)` de
      // app/seguimiento/page.tsx:1150 convierte un servicio 22:00→01:30 en "0 min".
      if (inicio) {
        // Con inicio: se prueba el día siguiente y se acepta SOLO si la duración cabe en el techo
        // de 26 h; si no cabe, se deja tal cual y que la duración salga null antes que mentida.
        if (ts < inicio.ts && ts + DIA_MS - inicio.ts <= DURACION_MAX_MS) ts += DIA_MS;
      } else if (servicioMin !== null && minutosLima(ts) - servicioMin < -MEDIO_DIA_MIN) {
        // Defecto :498-508 — sin inicio derivable la promoción no se aplicaba y el cierre se
        // anclaba al día del servicio: hora_servicio 22:00 + hora_real_fin '01:30' quedaba 20 h
        // ANTES de la salida pactada. Sin inicio, el ancla es la HORA PACTADA, con el mismo
        // criterio de "el lado más cercano de la medianoche" que usa el inicio del operador.
        ts += DIA_MS;
      }
      finOperador = crearInstante(ts, "operador");
    }
  }

  // Resolución del CIERRE (defecto :498 — un solo punto GPS suelto anulaba la hora tecleada y la
  // duración salía 0; ejecutado: finalizada, inicio 05:00, fin 12:00, un punto GPS a 05:02).
  // Orden: evidencia DURA de cierre (el conductor pulsó finalizar) > corrección HUMANA >
  // "hasta aquí transmitió". `gps_ultimo` no puede ganarle nunca a un valor del operador.
  const finCierre: Instante | null = finGpsFinalizado || finOperador || finGpsUltimo;

  // El más tardío de los dos. No el "mejor": el más tardío, porque el servicio no terminó
  // mientras alguna de las dos evidencias siga viva.
  const fin: Instante | null =
    finParadero && finCierre ? (finCierre.ts >= finParadero.ts ? finCierre : finParadero)
    : finParadero || finCierre;

  // FIRMADO, no absoluto (defecto :516/:586-588): el cierre puede caer ANTES del último paradero
  // y el texto salía igual, diciendo "después". Positivo = el cierre es posterior al paradero.
  const brechaMin = finParadero && finCierre ? (finCierre.ts - finParadero.ts) / MIN_MS : 0;
  const mostrarAmbosFines = !!(finParadero && finCierre) && Math.abs(brechaMin) > brechaFines;

  // ¿El valor del operador quedó fuera del cierre por evidencia dura que lo contradice? Entonces
  // se conservan LOS DOS y se expone la discrepancia (nunca se tira uno).
  const finOperadorDescartado = !!finOperador && finCierre !== finOperador;

  // Duración. Un par incoherente (fin antes del inicio y sin cruce de medianoche que lo explique)
  // devuelve null, NO cero: cero es una duración; null es "no lo sé", que es la verdad.
  // Defecto :521-525 — DURACION_MAX_MS solo servía para promover el día y NUNCA invalidaba: se
  // midieron 54 h (inicio 19:00 por parada + GPS a +49 h → duracionMin 3240) presentadas como
  // dato bueno. Una duración que no cabe en el techo que el propio módulo declara es "no lo sé".
  const deltaMs = inicio && fin ? fin.ts - inicio.ts : null;
  let duracionMin: number | null = null;
  if (deltaMs !== null && deltaMs >= 0 && deltaMs <= DURACION_MAX_MS) {
    duracionMin = Math.round(deltaMs / MIN_MS);
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // VEREDICTO DE SALIDA
  // ────────────────────────────────────────────────────────────────────────────────────
  const veredicto = veredictoSalida({
    estado, inicio, hoy, ahoraMs, gracia, servicioMin,
    fechaServicio: r.fecha_servicio ?? null,
    completadas: paradas.filter((p) => p.completada).length,
    abordajes: abordajesEvidencia,
    // CRUDOS a propósito, no `gps.length`. "¿Qué hora fue?" y "¿hubo operación?" son dos
    // preguntas distintas y confundirlas devolvía el falso positivo que este módulo existe para
    // matar: la cobertura de GPS en segundo plano va de 36 % a 100 % SEGÚN EL CONDUCTOR y hay
    // relojes de celular desfasados (panel /gps-salud). Con 340 puntos reales fechados un año
    // adelante, `gps` queda vacío por la ventana de sanidad y un servicio que SÍ operó salía
    // "no arrancó · sin ninguna evidencia" en rojo. La ventana decide qué hora es creíble; no
    // decide si el bus se movió. Es la misma doctrina que ya se aplica a las paradas (una
    // `hora_llegada` corrupta deja la parada completada SIN hora, no borra la parada).
    puntosGps: (e.gps || []).filter((g) => !!g).length,
    avisosSalida: salioTs.length,
    // Corte propio, ANTES de confiar en la normalización (defecto :408): acusar "no arrancó"
    // exige que el estado CRUDO esté reconocido como no-iniciado.
    estadoCrudo: r.estado ?? null,
    estadoNoIniciado: esEstadoCrudoNoIniciado(r.estado),
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // LÍNEA DE TIEMPO
  // ────────────────────────────────────────────────────────────────────────────────────
  const linea: FilaLinea[] = [];

  linea.push(filaDe({
    clave: "inicio",
    etiqueta: "Inicio del servicio",
    instante: inicio,
    previstaHhmm: servicioMin !== null ? minHhmm(servicioMin) : null,
    notaVacia: veredicto.nivel === "operado_sin_hora"
      ? "operó, pero nadie dejó la hora"
      : "sin hora registrada",
  }));

  // Rastro del inicio tecleado que NO ganó: un valor humano nunca desaparece de la línea.
  if (inicioOperador && inicio !== inicioOperador) {
    linea.push(filaDe({
      clave: "inicio:operador",
      etiqueta: "Inicio registrado por operación",
      instante: inicioOperador,
      previstaHhmm: servicioMin !== null ? minHhmm(servicioMin) : null,
      notaVacia: "sin hora registrada",
      notaFija: inicio
        ? `no se usó: manda la evidencia del día (${ETIQUETA_FUENTE[inicio.fuente]} ${inicio.hhmm})`
        : "no se usó",
    }));
  }

  for (const p of paradas) {
    // Defecto :555 — se pintaba la hora de paradas NO completadas, mientras la cascada de inicio
    // (:437) sí exige `completada && llegadaTs`. Criterio unificado: una hora_llegada residual de
    // una parada revertida a 'pendiente' no es una llegada y no entra al reporte.
    const inst = p.completada && p.llegadaTs !== null ? crearInstante(p.llegadaTs, "parada") : null;
    linea.push(filaDe({
      clave: `parada:${p.id}`,
      etiqueta: p.nombre || `Paradero ${p.ordenN + 1}`,
      instante: inst,
      previstaHhmm: p.hora_estimada ? String(p.hora_estimada).slice(0, 5) : null,
      notaVacia: p.completada
        ? "marcada sin hora"
        : p.llegadaTs !== null
          ? `sin marcar (hora residual ${hhmmLima(p.llegadaTs)} descartada)`
          : "sin marcar",
    }));
  }

  const filaCierre = filaDe({
    clave: "cierre",
    etiqueta: "Cierre del servicio",
    instante: finCierre,
    previstaHhmm: null,
    notaVacia: "el conductor no cerró el servicio",
  });
  linea.push(filaCierre);

  // Notas que solo se pueden escribir con inicio y fin ya resueltos. Se acumulan en una lista:
  // antes eran un `else if` en cascada y la rama de la duración imposible quedaba INALCANZABLE
  // (defecto :580-582 — toda duración > 26 h obliga a que inicio y fin caigan en días distintos,
  // así que el `else if` de "cruzó la medianoche" se la comía SIEMPRE: 0 impactos en 1174 casos).
  const notasCierre: string[] = [];
  if (deltaMs !== null) {
    if (deltaMs < 0) {
      notasCierre.push("el cierre es anterior al inicio: revisar");
    } else if (deltaMs > DURACION_MAX_MS) {
      // Se evalúa ANTES que el cruce de medianoche, que es el caso benigno y el que la tapaba.
      notasCierre.push(
        `duración de ${Math.round(deltaMs / 3_600_000)} h: imposible (máx ${Math.round(DURACION_MAX_MS / 3_600_000)} h), revisar`,
      );
    } else if (fechaLima(fin!.ts) !== fechaLima(inicio!.ts)) {
      notasCierre.push("cruzó la medianoche");
    }
  }
  if (mostrarAmbosFines && finParadero) {
    // Defecto :516/:586-588 — el texto decía "después" incluso cuando el cierre era ANTERIOR
    // (ejecutado: paradas 06:00 y 12:00 + GPS 'finalizado' 09:00 → "180 min después"). Este texto
    // se imprime en el Reporte de Servicio: dice la verdad según el signo.
    // Este texto se imprime en el Reporte de Servicio, así que se lee en horas cuando los
    // minutos crudos dejan de decir nada ("3240 min" no le dice a nadie que son 54 h).
    const mins = Math.abs(Math.round(brechaMin));
    const brechaTexto = mins >= 120 ? formatoDuracion(mins) : `${mins} min`;
    notasCierre.push(`${brechaTexto} ${brechaMin >= 0 ? "después" : "antes"} del último paradero`);
  }
  if (notasCierre.length) {
    filaCierre.nota = filaCierre.nota ? `${filaCierre.nota} · ${notasCierre.join(" · ")}` : notasCierre.join(" · ");
  }

  // Rastro del fin tecleado que NO ganó el cierre: se conservan los DOS y se expone la
  // discrepancia, en vez de tirar el valor humano (defecto :498).
  if (finOperador && finOperadorDescartado) {
    const contra = finCierre
      ? `${ETIQUETA_FUENTE[finCierre.fuente]} ${finCierre.hhmm}`
      : "otra evidencia";
    const difMin = finCierre ? Math.round((finOperador.ts - finCierre.ts) / MIN_MS) : null;
    linea.push(filaDe({
      clave: "cierre:operador",
      etiqueta: "Cierre registrado por operación",
      instante: finOperador,
      previstaHhmm: null,
      notaVacia: "sin hora registrada",
      notaFija:
        difMin === null
          ? "no se usó como cierre"
          : `discrepa ${Math.abs(difMin)} min con ${contra}: revisar`,
    }));
  }

  return { inicio, finParadero, finCierre, finOperador, fin, mostrarAmbosFines, duracionMin, veredicto, linea };
}

function filaDe(a: {
  clave: string; etiqueta: string; instante: Instante | null;
  previstaHhmm: string | null; notaVacia: string;
  /** Nota que MANDA sobre la automática. Se usa para explicar por qué un valor no se usó
   *  (un dato del operador descartado tiene que quedar visible CON su motivo, defecto :498). */
  notaFija?: string | null;
}): FilaLinea {
  const prevMin = hhmmMin(a.previstaHhmm);
  const desviacionMin = a.instante && prevMin !== null ? Math.round(desvioMin(minutosLima(a.instante.ts), prevMin)) : null;
  return {
    clave: a.clave,
    etiqueta: a.etiqueta,
    instante: a.instante,
    previstaHhmm: a.previstaHhmm,
    desviacionMin,
    // La nota describe la AUSENCIA o la naturaleza del dato, nunca lo suple.
    nota: a.notaFija ?? (a.instante ? (a.instante.estimado ? "hora estimada, no registrada" : null) : a.notaVacia),
  };
}

/**
 * ¿Salió o no salió?
 *
 * La distinción que justifica esta función es "operado_sin_hora" vs "no_arranco". Son
 * situaciones OPUESTAS que el tablero de hoy pinta igual (rojo, "No iniciado" —
 * app/seguimiento/page.tsx:600): el servicio que se hizo y nadie registró, y el servicio que
 * de verdad no salió. Confundirlos es peor que no decir nada: enseña rojos falsos todos los
 * días hasta que el operador deja de mirarlos.
 *
 * REGLA INVIOLABLE: un servicio 'finalizada' NUNCA puede dar "no_arranco".
 *
 * Antes se apoyaba en `normalizaEstado()`, y eso NO bastaba (defecto :408): su `default`
 * devuelve "pendiente" para cualquier cadena fuera de su lista blanca de 12 valores
 * (lib/estados.ts:92), así que un estado 'terminada' —variante que la lista no contempla— se
 * leía como "pendiente" y el servicio salía acusado. Ejecutado: estado='terminada', hoy,
 * hora 05:00, ahora 23:00 → nivel 'no_arranco'. Ahora la acusación exige que el estado CRUDO
 * esté en la lista blanca de "no iniciado" (`estadoNoIniciado`). Ante un estado desconocido el
 * módulo NO acusa: degrada a "na". Callar es barato; un rojo falso destruye el tablero.
 */
function veredictoSalida(a: {
  estado: EstadoReserva;
  inicio: Instante | null;
  hoy: string;
  ahoraMs: number;
  gracia: number;
  servicioMin: number | null;
  fechaServicio: string | null;
  completadas: number;
  abordajes: number;
  puntosGps: number;
  avisosSalida: number;
  /** valor tal cual vino en la fila, sin normalizar */
  estadoCrudo: string | null;
  /** true solo si `estadoCrudo` está RECONOCIDO como no-iniciado */
  estadoNoIniciado: boolean;
}): VeredictoSalida {
  if (a.estado === "cancelada") return { nivel: "na", instante: null, motivo: "servicio cancelado" };

  if (a.inicio) {
    return { nivel: "salio", instante: a.inicio, motivo: `salida ${a.inicio.hhmm} · ${a.inicio.etiqueta}` };
  }

  // Evidencia de OPERACIÓN, sin hora utilizable. Cualquiera de estas prueba que el bus se movió.
  const operativo = a.estado === "en_curso" || a.estado === "finalizada";
  const pruebas: string[] = [];
  if (operativo) pruebas.push(a.estado === "finalizada" ? "servicio finalizado" : "servicio en curso");
  if (a.completadas > 0) pruebas.push(`${a.completadas} parada${a.completadas === 1 ? "" : "s"} marcada${a.completadas === 1 ? "" : "s"}`);
  if (a.abordajes > 0) pruebas.push(`${a.abordajes} abordaje${a.abordajes === 1 ? "" : "s"}`);
  if (a.puntosGps > 0) pruebas.push(`${a.puntosGps} punto${a.puntosGps === 1 ? "" : "s"} GPS`);
  if (a.avisosSalida > 0) pruebas.push("aviso de salida enviado");

  if (pruebas.length) {
    return {
      nivel: "operado_sin_hora",
      instante: null,
      // Se dice QUÉ evidencia hay: es lo que convierte un chip gris en algo accionable
      // ("hay 340 puntos GPS pero ninguna parada marcada" ≠ "no hay nada").
      motivo: `operó sin hora registrada · ${pruebas.join(" · ")}`,
    };
  }

  // Sin evidencia de ningún tipo. Solo el DÍA del servicio se puede afirmar algo: para un día
  // pasado ya no es una alerta viva sino un dato histórico (y probablemente un servicio que se
  // registró y nunca se operó), y para uno futuro no hay nada que decir todavía.
  if (a.fechaServicio !== a.hoy) {
    return { nivel: "na", instante: null, motivo: "otro día, sin evidencia" };
  }
  if (a.servicioMin === null) {
    return { nivel: "na", instante: null, motivo: "sin hora pactada" };
  }

  const desde = minutosLima(a.ahoraMs) - a.servicioMin;
  if (desde > a.gracia) {
    // EL CORTE PROPIO, justo antes de la ÚNICA acusación que emite el módulo. No se pinta de rojo
    // a nadie cuyo estado no se sepa leer: "no_arranco" exige lista blanca, no un `default`.
    if (!a.estadoNoIniciado) {
      return {
        nivel: "na",
        instante: null,
        motivo: a.estadoCrudo
          ? `estado "${a.estadoCrudo}" no reconocido como no-iniciado: no se afirma que no arrancó`
          : "sin estado: no se afirma que no arrancó",
      };
    }
    return {
      nivel: "no_arranco",
      instante: null,
      motivo: `${Math.round(desde)} min pasada la hora (${minHhmm(a.servicioMin)}) sin ninguna evidencia`,
    };
  }
  return {
    nivel: "por_salir",
    instante: null,
    motivo: desde >= 0 ? "es la hora, aún dentro de la gracia" : `faltan ${Math.abs(Math.round(desde))} min`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// PRESENTACIÓN — una sola redacción para torre, drawer, reporte y avisos
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * Texto corto de PROCEDENCIA, listo para pintar bajo la hora:
 *   "marcado por el conductor 05:12" · "abordaje QR 05:14" · "estimado por GPS ~05:16"
 * El "~" no es decoración: marca que la hora es inferida y que NO se debe facturar.
 */
export function procedencia(instante: Instante | null | undefined): string {
  if (!instante) return "Sin hora registrada";
  // `etiqueta` puede traer el nombre del paradero pegado ("… · Óvalo Higuereta"); para el texto
  // corto se usa solo la parte de la fuente.
  const base = ETIQUETA_FUENTE[instante.fuente];
  return `${base} ${instante.estimado ? "~" : ""}${instante.hhmm}`;
}

export const NIVEL_SALIDA: Record<NivelSalida, { label: string; corto: string; color: string; bg: string; orden: number }> = {
  // "operado_sin_hora" es GRIS y nunca rojo: el servicio se hizo, lo que falta es el registro.
  // Pintarlo de rojo es la confusión que este módulo existe para deshacer.
  no_arranco:       { label: "No arrancó",             corto: "NO SALIÓ",  color: "#dc2626", bg: "#fef2f2", orden: 1 },
  operado_sin_hora: { label: "Operó, sin hora",        corto: "SIN HORA",  color: "#475569", bg: "#f1f5f9", orden: 2 },
  por_salir:        { label: "Por salir",              corto: "POR SALIR", color: "#0369a1", bg: "#e0f2fe", orden: 3 },
  salio:            { label: "Salió",                  corto: "SALIÓ",     color: "#15803d", bg: "#f0fdf4", orden: 4 },
  na:               { label: "—",                      corto: "",          color: "#94a3b8", bg: "#f8fafc", orden: 5 },
};

/**
 * ¿Puede el operador registrar el inicio A MANO? (decisión del dueño, 2026-08-20)
 * Solo cuando NO hay ninguna evidencia de la que derivarlo. Si el sistema ya sabe la hora, un
 * campo editable al lado solo sirve para que alguien la contradiga; y lo que se teclee queda
 * marcado como manual (fuente "operador", confianza media).
 */
export function puedeRegistrarInicioManual(t: TiemposServicio): boolean {
  if (t.inicio !== null) return false;
  // Un servicio cancelado no admite registro, y es el ÚNICO caso que devuelve la línea de tiempo
  // vacía (SIN_TIEMPOS). El "na" NUEVO por estado no reconocido (defecto :408) sí debe admitirlo:
  // si el módulo no se atreve a opinar sobre el estado, con más razón hay que dejar teclear la
  // hora a mano en vez de bloquear al operador.
  if (t.linea.length === 0) return false;
  return t.veredicto.nivel !== "por_salir" && t.veredicto.nivel !== "salio";
}

/** "1 h 45 min" · "38 min" · "—". Formato único para la duración derivada. */
export function formatoDuracion(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min) || min < 0) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
