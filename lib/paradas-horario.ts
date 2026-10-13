// lib/paradas-horario.ts — LA HORA DE CADA PARADERO, CALCULADA DESDE LA RUTA.
// Módulo PURO: no lee la base, no llama a Google y no mira el reloj por su cuenta (el instante
// entra por parámetro). Lo importan la pantalla de /cotizaciones (botón «⏱ Calcular horas») y
// /api/cotizaciones/horas-paraderos, y los DOS encadenan con la MISMA `pasoCadena`: la ruta
// pide el tráfico de cada tramo a la hora en que el bus SALE de ese paradero, y esa hora sale
// de esta función. Si la pantalla encadenara a su manera, las horas publicadas se calcularían
// con un tráfico consultado a otra hora.
//
// LO QUE SE PUBLICA ES LA HORA DE LLEGADA (best_guess), NUNCA LA PESIMISTA. La asimetría es la
// de siempre en este ERP, aplicada al pasajero: si la hora publicada queda ANTES de que el bus
// llegue, el pasajero espera unos minutos; si queda DESPUÉS, el bus ya pasó y lo pierde. Una
// estimación pesimista es exactamente lo segundo. Por eso la «llegada en hora punta» se
// ENSEÑA aparte y no mueve ninguna hora.
//
// POR QUÉ CON TRÁFICO SE PIDE UN TRAMO POR CONSULTA: Google Directions (legacy) no devuelve
// `duration_in_traffic` por tramo cuando la ruta lleva paradas intermedias (solo con `via:`, y
// entonces devuelve un único tramo total). `scripts/diagnostico-trafico-paraderos.mts` lo
// comprueba contra la API real.

import { limaAUtcMs, fechaLima, hhmmAMinutos, minutosAHhmm } from "./alertas-horario";
import { firmaRuta } from "./ruta-firma";

export type ModoHoras = "sin_trafico" | "trafico";

/** La marca que deja el cálculo en un paradero: con qué se calculó y para qué paraderos. */
export type HoraCalc = {
  /** La hora que escribió el cálculo. Si hoy el paradero dice otra, alguien la editó. */
  hora: string;
  modo: ModoHoras;
  /** Fecha cuyo tráfico se consultó (solo con tráfico). */
  fecha_ref?: string;
  /** `firmaParaderos` de TODA la lista al calcular. Si cambia, la hora quedó vieja. */
  firma: string;
  espera_min: number;
  /** 1 = la llegada cae al día siguiente de la salida (cruzó la medianoche). */
  dia?: 0 | 1;
};

export type ParadaHorario = {
  id: string;
  tipo: "inicio" | "intermedia" | "destino";
  nombre: string;
  lat: string;
  lng: string;
  hora: string;
  hora_calc?: HoraCalc;
};

/**
 * Minutos que el bus se detiene en cada paradero INTERMEDIO (subir/bajar gente). NO MEDIDO:
 * es un valor de arranque declarado como tal y editable en la pantalla. El primero (sale) y el
 * último (termina) no esperan. El lado seguro es BAJARLO: una espera de más corre todas las
 * horas siguientes hacia después, y el pasajero llega cuando el bus ya pasó.
 */
export const ESPERA_DEFECTO_MIN = 1;

/** Tope de paraderos para el cálculo con tráfico: cada tramo es una consulta Advanced. */
export const MAX_PARADEROS_TRAFICO = 20;

/**
 * Precio por consulta a Google Directions, en USD (ver la cabecera de app/api/ruta/route.ts):
 * sin `departure_time` cae en «Directions» (Essentials, $5 por 1 000); con él, en «Directions
 * Advanced» ($10 por 1 000). Es la tarifa de lista, sin descontar la cuota gratuita mensual.
 */
export const PRECIO_USD = { essentials: 0.005, advanced: 0.01 } as const;

/** Margen mínimo entre ahora y la salida que se le pide a Google (no admite el pasado). */
export const MARGEN_SALIDA_MIN = 5;
/** Lo más lejos que se consulta el tráfico previsto. Más allá es una predicción sin sentido. */
export const MAX_DIAS_ADELANTE = 90;

const MIN_DIA = 1440;
const DIA_MS = 86_400_000;

// ──────────────────────────────────────────────────────────────────────────────────────
// Modo y fecha de referencia
// ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Qué modo se ofrece marcado. Un contrato FIJO es transporte de personal durante meses, en
 * hora punta, donde el tráfico cambia la hora real en decenas de minutos: ahí vale la pena la
 * consulta cara. Un EVENTUAL es un viaje suelto, y el cálculo barato (sin tráfico, cacheado)
 * basta como primera aproximación. Lo decide una persona; esto solo propone.
 */
export function modoRecomendado(modoServicio: string): { modo: ModoHoras; razon: string } {
  if (String(modoServicio || "").toLowerCase() === "fijo") {
    return {
      modo: "trafico",
      razon: "Servicio fijo: el bus sale todos los días en hora punta durante meses, y el tráfico mueve la hora de cada paradero.",
    };
  }
  return {
    modo: "sin_trafico",
    razon: "Servicio eventual: el cálculo sin tráfico es gratis si la ruta ya se consultó, y basta como primera aproximación.",
  };
}

const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** Día de la semana (0 = domingo) de una fecha ISO, sin depender de la zona del servidor. */
function diaSemana(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

/** Suma días a una fecha ISO (aritmética sobre la cadena, no sobre «ahora»). */
function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return new Date(d.getTime() + n * DIA_MS).toISOString().slice(0, 10);
}

function esFechaIso(f?: string | null): f is string {
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  return !Number.isNaN(new Date(`${f}T12:00:00Z`).getTime()) && new Date(`${f}T12:00:00Z`).toISOString().slice(0, 10) === f;
}

function primerHabilDesde(fecha: string): string {
  let f = fecha;
  while (diaSemana(f) === 0 || diaSemana(f) === 6) f = sumarDias(f, 1);
  return f;
}

function etiquetaFecha(fecha: string): string {
  const [y, m, d] = fecha.split("-");
  return `${DIAS_CORTOS[diaSemana(fecha)]} ${d}/${m}/${y}`;
}

/**
 * La fecha cuyo tráfico se le pide a Google. Hora Lima (UTC-5): a las 23:30 de Lima en UTC ya
 * es el día siguiente, y por eso «mañana» sale de `fechaLima`, no de `toISOString`.
 *
 *  · FIJO: un día hábil típico — el primer lunes-viernes desde max(fecha del servicio, mañana).
 *    Un sábado o un domingo tiene otro tráfico y no describe el contrato.
 *  · EVENTUAL: su fecha, si todavía se puede consultar; si ya pasó (o está a más de 90 días),
 *    el mismo día de la semana de la próxima semana (`supuesta`). Sin fecha, el próximo hábil.
 *  · RETORNO: la misma fecha de la ida; si sale ANTES que la ida (un nocturno que vuelve de
 *    madrugada), el día siguiente.
 *
 * `supuesta` = la fecha no es la que dice el servicio; la pantalla lo dice en la etiqueta.
 */
export function fechaReferencia(a: {
  modoServicio: string;
  fechaServicio?: string | null;
  horaSalida: string;
  sentido: "ida" | "retorno";
  horaSalidaIda?: string | null;
  ahoraMs: number;
}): { ok: true; fecha: string; supuesta: boolean; etiqueta: string } | { ok: false; codigo: "sin_hora_salida" } {
  const minSalida = hhmmAMinutos(a.horaSalida);
  if (minSalida == null) return { ok: false, codigo: "sin_hora_salida" };

  const esRetorno = a.sentido === "retorno";
  const minIda = esRetorno ? hhmmAMinutos(a.horaSalidaIda ?? null) : null;
  // La fecha se elige para la IDA (con su hora) y el retorno la hereda.
  const horaBase = esRetorno && minIda != null ? minutosAHhmm(minIda) : minutosAHhmm(minSalida);
  const cruza = esRetorno && minIda != null && minSalida < minIda;

  const hoy = fechaLima(a.ahoraMs);
  const manana = sumarDias(hoy, 1);
  const fServ = esFechaIso(a.fechaServicio) ? a.fechaServicio : null;

  // ¿Se puede consultar esa fecha a esa hora? (la del tramo que de verdad se pide)
  const consultable = (f: string): boolean => {
    const fecha = cruza ? sumarDias(f, 1) : f;
    const hora = esRetorno ? minutosAHhmm(minSalida) : horaBase;
    return validarSalida(fecha, hora, a.ahoraMs).ok;
  };

  let fecha: string;
  let motivo = "";
  if (String(a.modoServicio || "").toLowerCase() === "fijo") {
    // El primer hábil desde el inicio del contrato, si todavía se puede consultar; si no (a
    // más de 90 días), el primer hábil desde mañana.
    const desdeServicio = fServ && fServ > manana ? primerHabilDesde(fServ) : null;
    fecha = desdeServicio && consultable(desdeServicio) ? desdeServicio : primerHabilDesde(manana);
    // A las 23:58 una salida de las 00:01 de mañana ya no admite el margen: el siguiente hábil.
    for (let k = 0; k < 7 && !consultable(fecha); k++) fecha = primerHabilDesde(sumarDias(fecha, 1));
    motivo = "día hábil típico del contrato";
  } else if (fServ && consultable(fServ)) {
    fecha = fServ;
  } else if (fServ) {
    const dow = diaSemana(fServ);
    fecha = manana;
    while (diaSemana(fecha) !== dow) fecha = sumarDias(fecha, 1);
    if (!consultable(fecha)) fecha = sumarDias(fecha, 7);
    motivo = `el ${etiquetaFecha(fServ)} ya no se puede consultar: mismo día de la semana`;
  } else {
    fecha = primerHabilDesde(manana);
    for (let k = 0; k < 7 && !consultable(fecha); k++) fecha = primerHabilDesde(sumarDias(fecha, 1));
    motivo = "sin fecha de servicio: próximo día hábil";
  }

  if (cruza) fecha = sumarDias(fecha, 1);
  const supuesta = fecha !== (fServ ? (cruza ? sumarDias(fServ, 1) : fServ) : null);
  const etiqueta = supuesta
    ? `${etiquetaFecha(fecha)} (supuesta: ${motivo || "fecha del servicio no consultable"}${cruza ? "; el retorno sale al día siguiente de la ida" : ""})`
    : `${etiquetaFecha(fecha)}${cruza ? " (el retorno sale al día siguiente de la ida)" : ""}`;
  return { ok: true, fecha, supuesta, etiqueta };
}

/**
 * ¿Se le puede pedir a Google el tráfico previsto de esta salida? Google rechaza el pasado, y
 * a más de `MAX_DIAS_ADELANTE` días la predicción es solo el promedio histórico.
 */
export function validarSalida(
  fecha: string,
  hora: string,
  ahoraMs: number,
): { ok: true; epochS: number } | { ok: false; codigo: "salida_pasada" | "salida_lejana" | "invalida" } {
  if (!esFechaIso(fecha) || hhmmAMinutos(hora) == null) return { ok: false, codigo: "invalida" };
  const ms = limaAUtcMs(fecha, minutosAHhmm(hhmmAMinutos(hora)!));
  if (ms == null || !Number.isFinite(ms)) return { ok: false, codigo: "invalida" };
  if (ms < ahoraMs + MARGEN_SALIDA_MIN * 60_000) return { ok: false, codigo: "salida_pasada" };
  if (ms > ahoraMs + MAX_DIAS_ADELANTE * DIA_MS) return { ok: false, codigo: "salida_lejana" };
  return { ok: true, epochS: Math.floor(ms / 1000) };
}

// ──────────────────────────────────────────────────────────────────────────────────────
// La cadena
// ──────────────────────────────────────────────────────────────────────────────────────

/** Un instante de la cadena: minutos del día (con decimales: se lleva en segundos) + día. */
export type PuntoCadena = { min: number; dia: number };

const total = (p: PuntoCadena) => p.dia * MIN_DIA + p.min;
const desdeTotal = (t: number): PuntoCadena => {
  const dia = Math.floor(t / MIN_DIA);
  return { min: t - dia * MIN_DIA, dia };
};

/**
 * Un paso de la cadena: desde la SALIDA del paradero anterior, la llegada a este y su salida.
 *
 *  · `llegada` = salida anterior + duración del tramo (segundos; no se redondea aquí).
 *  · `salida` = llegada + espera, solo en un INTERMEDIO (el último no sale a ningún lado).
 *  · `fija` = una hora ya escrita que no se pisa: la cadena se RE-ANCLA en ella (llegada =
 *    la escrita). Se ubica en el día de la llegada, salvo que la diferencia supere 12 h (cruzó
 *    la medianoche). Si la escrita es ANTES de la llegada posible, se re-ancla igual —se
 *    conserva lo que escribió una persona— y se avisa: las horas siguientes saldrán antes de
 *    lo que el bus puede llegar.
 */
export function pasoCadena(
  prev: PuntoCadena,
  duracionS: number,
  esperaMin: number,
  esIntermedia: boolean,
  fija: string | null,
): { llegada: PuntoCadena; salida: PuntoCadena; reanclada: boolean; aviso?: "manual_antes_de_llegar" } {
  const espera = esIntermedia ? Math.max(0, Number(esperaMin) || 0) : 0;
  const dur = Math.max(0, Number(duracionS) || 0) / 60;
  const llegadaPosible = total(prev) + dur;

  const fMin = fija != null ? hhmmAMinutos(fija) : null;
  if (fMin == null) {
    return { llegada: desdeTotal(llegadaPosible), salida: desdeTotal(llegadaPosible + espera), reanclada: false };
  }

  const diaLlegada = Math.floor(llegadaPosible / MIN_DIA);
  let tFija = diaLlegada * MIN_DIA + fMin;
  if (tFija - llegadaPosible < -MIN_DIA / 2) tFija += MIN_DIA;
  else if (tFija - llegadaPosible > MIN_DIA / 2 && tFija - MIN_DIA >= 0) tFija -= MIN_DIA;

  // Medio minuto de tolerancia: la escrita es HH:MM y la posible lleva segundos.
  const antes = tFija < llegadaPosible - 0.5;
  return {
    llegada: desdeTotal(tFija),
    salida: desdeTotal(tFija + espera),
    reanclada: true,
    ...(antes ? { aviso: "manual_antes_de_llegar" as const } : {}),
  };
}

export type CodigoPlan = "ok" | "sin_hora_salida" | "sin_coordenadas" | "pocos_puntos" | "tramos_no_cuadran";

/**
 * Qué le pasó a cada paradero:
 *  · `salida`            — el primero: su hora es la salida y nunca se toca.
 *  · `calculada`         — estaba vacía (o, en «todas», tenía la misma hora) y se escribió.
 *  · `pisada`            — en «todas»: tenía otra hora y se reemplazó (cuenta en `pisaria`).
 *  · `conservada_manual` — en «vacias»: tenía hora escrita, se respetó y la cadena siguió desde ella.
 *  · `reanclada`         — en «vacias»: se respetó la hora escrita aunque es ANTERIOR a la
 *                          llegada posible; la cadena se re-ancló en ella y la fila lleva aviso.
 */
export type CodigoParada = "salida" | "calculada" | "conservada_manual" | "pisada" | "reanclada";

export type FilaPlan = {
  id: string;
  hora: string;
  codigo: CodigoParada;
  dia: 0 | 1;
  aviso?: string;
  /** La marca a guardar en el paradero cuando la hora la escribió el cálculo. */
  hora_calc?: HoraCalc;
};

const TEXTO_AVISO_MANUAL =
  "La hora escrita es anterior a la que el bus puede llegar según la ruta; se respetó y las horas siguientes se calcularon desde ella.";

/** "HH:MM" normalizada de una hora escrita, o null si no es una hora. */
function horaEscrita(h?: string | null): string | null {
  const m = hhmmAMinutos(h ?? null);
  return m == null ? null : minutosAHhmm(m);
}

function coordValida(v: string | number | null | undefined): boolean {
  if (v === null || v === undefined || String(v).trim() === "") return false;
  return Number.isFinite(Number(v));
}

/**
 * Lo que hace falta ANTES de pedir ninguna ruta: dos puntos, coordenadas en todos y la hora
 * de salida del primero. La pantalla lo consulta antes de gastar una llamada a Google.
 */
export function requisitosHoras(paradas: { nombre: string; lat: string | number; lng: string | number; hora?: string | null }[]):
  { codigo: Exclude<CodigoPlan, "tramos_no_cuadran">; faltanCoords: string[] } {
  if (!Array.isArray(paradas) || paradas.length < 2) return { codigo: "pocos_puntos", faltanCoords: [] };
  // No se calcula a medias: un paradero sin coordenadas deja sin sentido a todos los siguientes.
  const faltan = paradas
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !coordValida(p.lat) || !coordValida(p.lng))
    .map(({ p, i }) => p.nombre?.trim() || `Paradero ${i + 1}`);
  if (faltan.length) return { codigo: "sin_coordenadas", faltanCoords: faltan };
  if (horaEscrita(paradas[0].hora) == null) return { codigo: "sin_hora_salida", faltanCoords: [] };
  return { codigo: "ok", faltanCoords: [] };
}

/**
 * El plan de horas: encadena los tramos desde la salida del primer paradero.
 *
 *  · `vacias` — solo llena las que no tienen hora; las escritas se respetan y la cadena se
 *               re-ancla en ellas (`conservada_manual` / `reanclada`). `pisaria` = 0 siempre.
 *  · `todas`  — reescribe todas salvo la salida; `pisaria` cuenta cuántas horas DISTINTAS
 *               se reemplazarían (para pedir confirmación antes).
 *
 * `tramosS[i]` es la duración en segundos de paradas[i] → paradas[i+1] (con tráfico, la que
 * la API consultó a la salida que da esta misma cadena). Nada se calcula a medias: con
 * cualquier requisito sin cumplir, `filas` sale vacía.
 */
export function planHoras(a: {
  paradas: ParadaHorario[];
  tramosS: number[];
  esperaMin: number;
  modo: "vacias" | "todas";
  calc: Omit<HoraCalc, "hora" | "dia">;
}): { codigo: CodigoPlan; faltanCoords: string[]; filas: FilaPlan[]; pisaria: number; llegada?: string } {
  const req = requisitosHoras(a.paradas);
  if (req.codigo !== "ok") return { codigo: req.codigo, faltanCoords: req.faltanCoords, filas: [], pisaria: 0 };

  const n = a.paradas.length;
  if (!Array.isArray(a.tramosS) || a.tramosS.length !== n - 1 || a.tramosS.some((s) => !Number.isFinite(s) || s < 0)) {
    return { codigo: "tramos_no_cuadran", faltanCoords: [], filas: [], pisaria: 0 };
  }

  const salidaHora = horaEscrita(a.paradas[0].hora)!;
  const filas: FilaPlan[] = [{ id: a.paradas[0].id, hora: salidaHora, codigo: "salida", dia: 0 }];
  let prev: PuntoCadena = { min: hhmmAMinutos(salidaHora)!, dia: 0 };
  let pisaria = 0;
  let ultima = "";

  for (let i = 1; i < n; i++) {
    const p = a.paradas[i];
    const escrita = horaEscrita(p.hora);
    const esIntermedia = i < n - 1;
    const fija = a.modo === "vacias" ? escrita : null;
    const paso = pasoCadena(prev, a.tramosS[i - 1], a.esperaMin, esIntermedia, fija);

    // Se redondea AL FINAL, sobre el total en minutos (la cadena va en segundos).
    const t = Math.round(total(paso.llegada));
    const diaN = Math.floor(t / MIN_DIA);
    const dia: 0 | 1 = diaN >= 1 ? 1 : 0;
    const hora = minutosAHhmm(t - diaN * MIN_DIA);

    if (fija != null) {
      filas.push({
        id: p.id,
        hora: escrita!,
        codigo: paso.aviso ? "reanclada" : "conservada_manual",
        dia,
        ...(paso.aviso ? { aviso: TEXTO_AVISO_MANUAL } : {}),
      });
      ultima = escrita!;
    } else {
      const pisa = a.modo === "todas" && escrita != null && escrita !== hora;
      if (pisa) pisaria++;
      filas.push({
        id: p.id,
        hora,
        codigo: pisa ? "pisada" : "calculada",
        dia,
        hora_calc: { ...a.calc, hora, dia },
      });
      ultima = hora;
    }
    prev = paso.salida;
  }

  return { codigo: "ok", faltanCoords: [], filas, pisaria, llegada: ultima };
}

/**
 * ¿La hora de este paradero sigue siendo la que calculó el sistema?
 *  · `manual`         — nunca se calculó, o alguien la editó después (la hora ya no es la de la marca).
 *  · `desactualizada` — la calculó el sistema pero los paraderos cambiaron desde entonces.
 *  · `vigente`        — la calculó el sistema y describe los paraderos de hoy.
 */
export function estadoMarca(p: ParadaHorario, firmaActual: string): "manual" | "vigente" | "desactualizada" {
  const c = p.hora_calc;
  if (!c) return "manual";
  if (horaEscrita(c.hora) == null || horaEscrita(c.hora) !== horaEscrita(p.hora)) return "manual";
  if (c.firma !== firmaActual) return "desactualizada";
  return "vigente";
}

/**
 * Firma de una lista de paraderos: la misma de `rutas_cache` (lib/ruta-firma.ts), con `?` en
 * un paradero sin coordenadas para que la firma siga siendo estable y comparable.
 */
export function firmaParaderos(paradas: { lat: string | number; lng: string | number }[]): string {
  return paradas
    .map((p) => (coordValida(p.lat) && coordValida(p.lng) ? firmaRuta([{ lat: Number(p.lat), lng: Number(p.lng) }]) : "?"))
    .join("|");
}

/**
 * Segundos de un tramo de /api/ruta. Las respuestas que estaban en caché antes de que la ruta
 * publicara `duracion_s` solo traen minutos redondeados: se usan (×60) antes que no calcular.
 */
export function segundosDeTramoRuta(t: { duracion_s?: number | null; duracion_min?: number | null } | null | undefined): number | null {
  if (!t) return null;
  if (Number.isFinite(Number(t.duracion_s)) && t.duracion_s != null) return Number(t.duracion_s);
  if (Number.isFinite(Number(t.duracion_min)) && t.duracion_min != null) return Number(t.duracion_min) * 60;
  return null;
}

/** Cuántas consultas a Google y cuánto cuestan (tarifa de lista), para decirlo antes del clic. */
export function costoEstimado(nParaderos: number, modo: ModoHoras, pesimista = false): { consultas: number; usd: number } {
  if (nParaderos < 2) return { consultas: 0, usd: 0 };
  if (modo === "sin_trafico") return { consultas: 1, usd: PRECIO_USD.essentials };
  const consultas = nParaderos - 1 + (pesimista ? 1 : 0);
  return { consultas, usd: Math.round(consultas * PRECIO_USD.advanced * 1000) / 1000 };
}

// ──────────────────────────────────────────────────────────────────────────────────────
// Insertar un paradero donde se hizo clic en el mapa
// ──────────────────────────────────────────────────────────────────────────────────────

type XY = [number, number];

/** Proyección equirectangular local a metros, suficiente para comparar distancias en una ruta urbana. */
function aMetros(lng: number, lat: number, lat0: number): XY {
  const R = 6_371_000;
  return [((lng * Math.PI) / 180) * R * Math.cos((lat0 * Math.PI) / 180), ((lat * Math.PI) / 180) * R];
}

/** Distancia a lo largo de la polilínea del punto proyectado más cercano, buscando desde `desdeSeg`. */
function proyectar(polyM: XY[], acum: number[], punto: XY, desdeSeg: number): { s: number; seg: number } {
  let mejor = { d2: Infinity, s: acum[desdeSeg] ?? 0, seg: desdeSeg };
  for (let k = Math.max(0, desdeSeg); k < polyM.length - 1; k++) {
    const [ax, ay] = polyM[k], [bx, by] = polyM[k + 1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((punto[0] - ax) * dx + (punto[1] - ay) * dy) / L2)) : 0;
    const px = ax + u * dx, py = ay + u * dy;
    const d2 = (punto[0] - px) ** 2 + (punto[1] - py) ** 2;
    if (d2 < mejor.d2) mejor = { d2, s: acum[k] + u * Math.sqrt(L2), seg: k };
  }
  return { s: mejor.s, seg: mejor.seg };
}

/**
 * Dónde insertar un paradero nuevo marcado en el mapa: se proyecta el punto sobre la ruta
 * (`poli`, en [lng, lat] como todo el ERP tras /api/ruta) y se ubica entre los dos paraderos
 * que lo rodean A LO LARGO DEL RECORRIDO, no en línea recta (una ruta que vuelve por una
 * paralela pondría al paradero más cercano en el sentido equivocado). Los paraderos se
 * proyectan en orden y sin retroceder, para que una ruta que pasa dos veces cerca del mismo
 * punto no los desordene.
 *
 * Devuelve el índice para `splice(i, 0, nuevo)`: nunca 0 (antes del inicio) ni `n` (después
 * del destino). Sin polilínea útil, el tramo recto (paradero → paradero) más cercano.
 */
export function indiceDeInsercion(poli: [number, number][], paradas: { lat: number; lng: number }[], punto: [number, number]): number {
  const n = paradas.length;
  if (n < 2) return n;
  const clamp = (i: number) => Math.max(1, Math.min(n - 1, i));
  const lat0 = Number(punto[1]) || paradas[0].lat;
  const pM = aMetros(punto[0], punto[1], lat0);
  const parM = paradas.map((p) => aMetros(p.lng, p.lat, lat0));

  const poliValida = Array.isArray(poli) ? poli.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) : [];
  if (poliValida.length < 2) {
    // Sin ruta: el segmento recto entre paraderos consecutivos más cercano al punto.
    let mejor = { d2: Infinity, i: 1 };
    for (let k = 0; k < n - 1; k++) {
      const [ax, ay] = parM[k], [bx, by] = parM[k + 1];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const u = L2 > 0 ? Math.max(0, Math.min(1, ((pM[0] - ax) * dx + (pM[1] - ay) * dy) / L2)) : 0;
      const d2 = (pM[0] - (ax + u * dx)) ** 2 + (pM[1] - (ay + u * dy)) ** 2;
      if (d2 < mejor.d2) mejor = { d2, i: k + 1 };
    }
    return clamp(mejor.i);
  }

  const polyM = poliValida.map(([lng, lat]) => aMetros(lng, lat, lat0));
  const acum: number[] = [0];
  for (let k = 1; k < polyM.length; k++) {
    acum.push(acum[k - 1] + Math.hypot(polyM[k][0] - polyM[k - 1][0], polyM[k][1] - polyM[k - 1][1]));
  }

  // Paraderos en orden y sin retroceder.
  const sPar: number[] = [];
  let seg = 0;
  for (const m of parM) {
    const r = proyectar(polyM, acum, m, seg);
    sPar.push(r.s);
    seg = r.seg;
  }
  const sPunto = proyectar(polyM, acum, pM, 0).s;

  let i = 1;
  while (i < n - 1 && sPar[i] <= sPunto) i++;
  return clamp(i);
}
