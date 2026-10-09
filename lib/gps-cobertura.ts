// lib/gps-cobertura.ts — ¿QUÉ PARTE DEL SERVICIO QUEDÓ RASTREADA? Motor PURO: sin React, sin
// fetch, sin Supabase. Lo usan /api/gps-salud (por conductor, varios días) y
// /api/seguimiento/rastreo (por servicio, la columna RASTREO y el aviso de la torre).
//
// ── UN SOLO NÚMERO EN TODO EL ERP ─────────────────────────────────────────────────────
// La medición vivía DENTRO de app/api/gps-salud/route.ts. Cuando /seguimiento pidió una columna
// de rastreo, la tentación era escribir otra; dos motores que contestan «¿cuánto del servicio
// tuvo GPS?» terminan contestando distinto, y el mismo servicio saldría 6 % en una pantalla y
// 100 % en la otra — que es exactamente el reclamo que abrió esto (reserva #6166: «Rastreo 100%»
// con 3 minutos de señal en una ruta de 55). Por eso se EXTRAJO, no se reescribió:
// scripts/prueba-gps-cobertura.mts corre el algoritmo original copiado literal y exige resultado
// idéntico cuando no se pasan las extensiones de /seguimiento.
//
// ── LA MÉTRICA (heredada, no inventada aquí) ──────────────────────────────────────────
// cobertura = % de la VENTANA DEL SERVICIO con GPS llegando. El denominador NO puede ser la
// propia traza: el modo de fallo dominante —el sistema mata la app y no rearranca— deja una
// traza CORTA, no una con huecos, y mediría 100 %. Por eso la ventana llega hasta la llegada
// prevista (última parada) cuando la traza termina lejos del destino. Un hueco > 60 s no cuenta
// como cubierto; si además el bus avanzó ≥ 500 m durante el hueco, es un CORTE (km a ciegas).
//
// ── LO QUE /seguimiento AGREGA, Y SOLO CON SUS CAMPOS ────────────────────────────────
//   · `inicioTs`: el inicio que dejó el conductor (primera parada marcada, inicio sellado). Si
//     el GPS arrancó tarde, ese tramo sin señal también cuenta. /gps-salud no lo pasa.
//   · `finTs`: la llegada al último paradero marcada por el conductor. Con el GPS muerto a mitad
//     de ruta, es la prueba de hasta dónde siguió el servicio aunque la parada no tenga hora
//     estimada. No aplica si la traza termina junto al destino (el bus llegó).
//   · `hastaTs`: servicio EN CURSO → la ventana llega hasta ahora.
// Sin esos tres campos el resultado es byte a byte el de /gps-salud.

import { hhmmLima } from "./servicio-tiempos";

export const HUECO_MIN_S = 60;       // por debajo de esto es cadencia normal, no un corte
export const AVANCE_CAIDO_M = 500;   // si el bus avanzó esto durante el hueco, el rastreo estaba muerto
export const AVANCE_MAX_M = 50000;   // tope de sanidad: un salto mayor es basura, no un tramo real
export const PRECISION_MAX_M = 150;  // mismo umbral que lib/gps-desplazamiento.ts: descarta fixes de red

/** Metros entre dos coordenadas (haversine). Copiado literal de /api/gps-salud. */
export function metros(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** "HH:MM[:SS]" del día `fecha` (Lima, UTC-5) en ms epoch. */
export function limaMs(fecha: string, hora: string | null): number | null {
  if (!fecha || !hora) return null;
  const t = Date.parse(`${fecha}T${String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8)}-05:00`);
  return Number.isFinite(t) ? t : null;
}

export type PuntoCobertura = { ts: number; lat: number; lng: number };
export type TrazaSaneada = { pts: PuntoCobertura[]; totalCrudo: number; porAntena: number; simulados: number };

export function trazaVacia(): TrazaSaneada {
  return { pts: [], totalCrudo: 0, porAntena: 0, simulados: 0 };
}

/**
 * Suma una página de filas de ubicaciones_gps a la traza. Descarta lo que envenenaría la
 * medición: coordenadas o fechas no finitas (un lat null se convertiría en 0 y mediría
 * ~10.000 km hasta la isla nula) y los fixes de red imprecisos, que cuentan aparte como
 * diagnóstico — son la firma del teléfono que no enciende el GNSS.
 */
export function acumularFilasGps(acc: TrazaSaneada, filas: any[], contarSimulados: boolean): void {
  for (const f of filas || []) {
    const ts = Date.parse(f.created_at as any);
    const lat = Number(f.lat), lng = Number(f.lng);
    const prec = f.precision_m == null ? null : Number(f.precision_m);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    // `f.lat == null` explícito: Number(null) es 0, que ES finito — el original lo dejaba pasar
    // pese a su propio comentario y medía un punto en la isla nula (divergencia declarada).
    if (f.lat == null || f.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    acc.totalCrudo++;
    if (contarSimulados && f.simulado === true) acc.simulados++;   // fix inyectado por una app de GPS falso
    if (prec !== null && Number.isFinite(prec) && prec > PRECISION_MAX_M) { acc.porAntena++; continue; }
    acc.pts.push({ ts, lat, lng });
  }
}

/**
 * Hora PREVISTA de llegada (la `hora_estimada` no nula más tardía en el orden) y DESTINO (la
 * última parada con coordenadas), de las paradas de UNA reserva en orden ascendente. Es lo que
 * permite ver que una traza terminó antes de tiempo. Cruza medianoche si el fin queda antes del
 * inicio (servicio nocturno).
 */
export function finYDestino(
  paradasAsc: { hora_estimada?: string | null; lat?: any; lng?: any }[],
  fecha: string, horaServicio: string | null,
): { finPrevistoTs: number | null; destino: { lat: number; lng: number } | null } {
  let ultima: string | null = null;
  let destino: { lat: number; lng: number } | null = null;
  for (const p of paradasAsc || []) {
    if (p.hora_estimada) ultima = p.hora_estimada;
    const la = Number(p.lat), ln = Number(p.lng);
    if (Number.isFinite(la) && Number.isFinite(ln) && p.lat != null && p.lng != null) destino = { lat: la, lng: ln };
  }
  let fin = limaMs(fecha, ultima);
  const ini = limaMs(fecha, horaServicio);
  if (fin !== null && ini !== null && fin < ini) fin += 86400e3;  // nocturno que cruza medianoche
  return { finPrevistoTs: fin, destino };
}

export type MedicionCobertura = {
  ventanaIniTs: number; ventanaFinTs: number;
  durMin: number;
  cobertura: number;        // 0..100
  cortes: number;
  peorHuecoMin: number;
  kmACiegas: number;
  primeraTs: number; ultimaTs: number;
};

/** Mide la cobertura de una traza saneada. `pts` en orden ascendente; requiere ≥ 2 puntos. */
export function medirCobertura(e: {
  pts: PuntoCobertura[];
  destino?: { lat: number; lng: number } | null;
  finPrevistoTs?: number | null;
  inicioTs?: number | null;
  finTs?: number | null;
  hastaTs?: number | null;
}): MedicionCobertura | null {
  const t = e.pts;
  if (!t || t.length < 2) return null;
  const ini0 = t[0].ts;
  const ini = e.inicioTs != null && Number.isFinite(e.inicioTs) && e.inicioTs < ini0 ? e.inicioTs : ini0;
  const ultimo = t[t.length - 1];
  // ¿La traza acaba porque el bus LLEGÓ, o porque el rastreo se murió en ruta? Si el último
  // punto cae junto a la última parada, el conductor llegó y cerró — aunque fuera antes de la
  // hora prevista, y penalizarlo por puntual sería absurdo. Solo cuando el rastreo se apaga
  // LEJOS del destino la ventana se extiende hasta la hora prevista (o la llegada marcada).
  const dest = e.destino;
  const llego = dest ? metros(ultimo.lat, ultimo.lng, dest.lat, dest.lng) <= AVANCE_CAIDO_M : false;
  const fin = e.hastaTs != null && Number.isFinite(e.hastaTs)
    ? Math.max(ultimo.ts, e.hastaTs)
    : llego ? ultimo.ts : Math.max(ultimo.ts, e.finPrevistoTs ?? 0, e.finTs ?? 0);
  const ventanaS = Math.max(1, (fin - ini) / 1000);

  let cubiertoS = 0, cortes = 0, peorS = 0, metrosCiegos = 0;
  for (let i = 1; i < t.length; i++) {
    const gapS = (t[i].ts - t[i - 1].ts) / 1000;
    if (gapS <= HUECO_MIN_S) { cubiertoS += gapS; continue; }
    if (gapS > peorS) peorS = gapS;
    const avance = metros(t[i - 1].lat, t[i - 1].lng, t[i].lat, t[i].lng);
    if (avance >= AVANCE_CAIDO_M && avance <= AVANCE_MAX_M) { cortes++; metrosCiegos += avance; }
  }
  // La cola sin puntos (el rastreo murió y no volvió) queda fuera de `cubiertoS` por
  // construcción: es lo que hace que este caso ya no puntúe 100%. Igual la cabeza, si el GPS
  // arrancó después de que el conductor empezara el servicio.
  const colaS = (fin - ultimo.ts) / 1000;
  if (colaS > HUECO_MIN_S && peorS < colaS) peorS = colaS;
  const cabezaS = (ini0 - ini) / 1000;
  if (cabezaS > HUECO_MIN_S && peorS < cabezaS) peorS = cabezaS;

  return {
    ventanaIniTs: ini, ventanaFinTs: fin,
    durMin: Math.round(ventanaS / 60),
    cobertura: Math.max(0, Math.min(100, Math.round((cubiertoS / ventanaS) * 100))),
    cortes,
    peorHuecoMin: Math.round(peorS / 60),
    kmACiegas: Math.round(metrosCiegos / 100) / 10,
    primeraTs: ini0, ultimaTs: ultimo.ts,
  };
}

// ── BANDAS Y VOCABULARIO (los comparten /gps-salud y /seguimiento) ────────────────────
// Los cortes de la banda salen de la medición real de la flota: los equipos sanos dan 100 % y
// los que tienen el permiso mal puesto rondan el 35-40 %. Antes se llamaban Bien / Aceptable /
// Irregular / Mal; «Mal» no decía qué estaba mal, y el dueño pidió un término mejor.
export const BANDA_COMPLETO = 95;
export const BANDA_ACEPTABLE = 90;
export const BANDA_CON_CORTES = 70;

export type Banda = { label: string; color: string; bg: string };
export function bandaCobertura(c: number | null): Banda {
  return c === null ? { label: "Sin datos", color: "#6b7280", bg: "#f3f4f6" }
    : c >= BANDA_COMPLETO   ? { label: "Completo",   color: "#166534", bg: "#dcfce7" }
    : c >= BANDA_ACEPTABLE  ? { label: "Aceptable",  color: "#3f6212", bg: "#ecfccb" }
    : c >= BANDA_CON_CORTES ? { label: "Con cortes", color: "#92400e", bg: "#fef3c7" }
    :                         { label: "Incompleto", color: "#991b1b", bg: "#fee2e2" };
}

// ── VEREDICTO POR SERVICIO (/seguimiento) ─────────────────────────────────────────────
/** En curso y sin ninguna posición desde hace esto = la señal se perdió AHORA. No medido: con
 *  un equipo sano llega una posición cada pocos segundos, también parado. El lado seguro (no
 *  gritar de más) es subirlo. */
export const SENAL_PERDIDA_MIN = 5;
/** Para afirmar que el GPS no se movió mientras el servicio sí: el recorrido de las paradas
 *  tiene que abarcar al menos esto y la traza quedarse dentro de INMOVIL_RADIO_M. No medidos. */
export const INMOVIL_RECORRIDO_M = 3000;
export const INMOVIL_RADIO_M = 300;

export type CodigoRastreo =
  | "completo" | "aceptable" | "con_cortes" | "incompleto"   // medido, por banda
  | "sin_senal"        // el servicio corrió y NO llegó ninguna posición
  | "solo_antena"      // llegaron posiciones, todas imprecisas (antena): no sirven para medir
  | "gps_inmovil"      // llegaron posiciones, pero sin moverse mientras el recorrido avanzaba
  | "senal_perdida"    // EN CURSO y sin posición desde hace > SENAL_PERDIDA_MIN
  | "recien_iniciado"  // en curso hace muy poco: todavía no corresponde medir
  | "sin_medir"        // no se pudo leer el GPS: NO se afirma nada
  | "no_aplica";       // cancelado, o aún no sale

/** Qué hace la torre con él. `urgente` = hay que llamar ya; `incompleto` = el registro del
 *  servicio quedó sin rastreo útil; `cortes` = medido con huecos. */
export type ProblemaRastreo = "urgente" | "incompleto" | "cortes" | null;

export type VeredictoRastreo = {
  codigo: CodigoRastreo;
  pct: number | null;
  problema: ProblemaRastreo;
  /** texto corto de la celda: "98 %", "Sin señal", "—" */
  celda: string;
  color: string; bg: string;
  /** frase completa: tooltip de la celda, aviso y modal GPS */
  detalle: string;
  ultimaSenalTs: number | null;
  enCurso: boolean;
};

const ROJO = { color: "#991b1b", bg: "#fee2e2" };
const GRIS = { color: "#6b7280", bg: "#f3f4f6" };

/** ¿La traza se quedó quieta mientras el recorrido de las paradas abarca kilómetros? */
export function trazaInmovil(pts: PuntoCobertura[], paradas: { lat?: any; lng?: any }[]): boolean {
  const ps = (paradas || [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p, i) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && paradas[i].lat != null && paradas[i].lng != null);
  if (ps.length < 2 || !pts || pts.length < 2) return false;
  let recorrido = 0;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    recorrido = Math.max(recorrido, metros(ps[i].lat, ps[i].lng, ps[j].lat, ps[j].lng));
  }
  if (recorrido < INMOVIL_RECORRIDO_M) return false;
  const o = pts[0];
  return pts.every((p) => metros(o.lat, o.lng, p.lat, p.lng) <= INMOVIL_RADIO_M);
}

export function veredictoRastreo(e: {
  /** el servicio corrió o está corriendo (no cancelado, no «por salir») */
  aplica: boolean;
  enCurso: boolean;
  traza: TrazaSaneada | null;          // null = no se pudo leer
  medicion: MedicionCobertura | null;  // null si < 2 puntos útiles
  /** el recorrido avanzó según el conductor (terminado, o ≥ 2 paradas marcadas) */
  avanzo: boolean;
  inmovil: boolean;
  inicioTs: number | null;
  ahoraMs: number;
}): VeredictoRastreo {
  const hhmm = (ts: number | null) => (ts != null ? hhmmLima(ts) : "—");
  const base = { ultimaSenalTs: null as number | null, enCurso: e.enCurso };
  if (!e.aplica) return { ...base, codigo: "no_aplica", pct: null, problema: null, celda: "—", ...GRIS, detalle: "Aún no hay nada que medir: el servicio no ha salido." };
  if (!e.traza) return { ...base, codigo: "sin_medir", pct: null, problema: null, celda: "?", ...GRIS, detalle: "No se pudo leer el GPS de este servicio. No se afirma nada; se reintenta solo." };

  const pts = e.traza.pts;
  const ultimaSenalTs = e.traza.totalCrudo > 0 && pts.length ? pts[pts.length - 1].ts : null;
  const b = { ...base, ultimaSenalTs };
  const minDesde = (ts: number) => Math.max(0, Math.round((e.ahoraMs - ts) / 60000));

  if (e.enCurso) {
    if (ultimaSenalTs != null && e.ahoraMs - ultimaSenalTs > SENAL_PERDIDA_MIN * 60000) {
      return { ...b, codigo: "senal_perdida", pct: e.medicion?.cobertura ?? null, problema: "urgente", celda: "Sin señal", ...ROJO,
        detalle: `En ruta y sin señal GPS desde las ${hhmm(ultimaSenalTs)} (hace ${minDesde(ultimaSenalTs)} min). Llama al conductor: casi siempre es la app cerrada o el teléfono bloqueado.` };
    }
    if (e.traza.totalCrudo === 0) {
      if (e.inicioTs == null || e.ahoraMs - e.inicioTs <= SENAL_PERDIDA_MIN * 60000) {
        return { ...b, codigo: "recien_iniciado", pct: null, problema: null, celda: "—", ...GRIS, detalle: "Recién iniciado: todavía no corresponde medir el rastreo." };
      }
      return { ...b, codigo: "senal_perdida", pct: 0, problema: "urgente", celda: "Sin señal", ...ROJO,
        detalle: `En ruta desde las ${hhmm(e.inicioTs)} y no ha llegado ninguna posición GPS. Llama al conductor para que abra la app.` };
    }
  }

  if (e.traza.totalCrudo === 0) {
    return { ...b, codigo: "sin_senal", pct: 0, problema: "incompleto", celda: "Sin señal", ...ROJO,
      detalle: "El servicio se hizo y no llegó ninguna posición GPS: el viaje no tiene rastreo." };
  }
  if (!e.medicion) {
    return { ...b, codigo: "solo_antena", pct: 0, problema: "incompleto", celda: "0 %", ...ROJO,
      detalle: `Llegaron ${e.traza.totalCrudo} posición(es), pero imprecisas (por antena, no por satélite): no sirven para seguir el viaje. El teléfono no está usando el GPS de alta precisión.` };
  }
  if (e.avanzo && e.inmovil && e.medicion.durMin >= 20) {
    return { ...b, codigo: "gps_inmovil", pct: e.medicion.cobertura, problema: "incompleto", celda: "Inmóvil", ...ROJO,
      detalle: `Llegaron posiciones, pero todas en el mismo punto mientras el recorrido avanzaba: el teléfono no iba en el vehículo, o su GPS quedó pegado.` };
  }

  const m = e.medicion;
  const banda = bandaCobertura(m.cobertura);
  const codigo: CodigoRastreo = m.cobertura >= BANDA_COMPLETO ? "completo"
    : m.cobertura >= BANDA_ACEPTABLE ? "aceptable"
    : m.cobertura >= BANDA_CON_CORTES ? "con_cortes" : "incompleto";
  const problema: ProblemaRastreo = codigo === "incompleto" ? "incompleto" : codigo === "con_cortes" ? "cortes" : null;
  const partes: string[] = [`${m.cobertura} % del servicio con GPS (de ${hhmm(m.ventanaIniTs)} a ${e.enCurso ? "ahora" : hhmm(m.ventanaFinTs)}).`];
  const colaMin = Math.round((m.ventanaFinTs - m.ultimaTs) / 60000);
  if (!e.enCurso && colaMin > 1) partes.push(`La señal se cortó a las ${hhmm(m.ultimaTs)} y el servicio siguió ${colaMin} min más sin rastreo.`);
  const cabezaMin = Math.round((m.primeraTs - m.ventanaIniTs) / 60000);
  if (cabezaMin > 1) partes.push(`El GPS empezó ${cabezaMin} min después de iniciar el servicio.`);
  if (m.cortes > 0) partes.push(`${m.cortes} corte(s) en movimiento: ${m.kmACiegas} km sin señal.`);
  return { ...b, codigo, pct: m.cobertura, problema, celda: `${m.cobertura} %`, color: banda.color, bg: banda.bg, detalle: partes.join(" ") };
}

// ── RESUMEN PARA EL AVISO DE LA TORRE ─────────────────────────────────────────────────
export type ItemRastreo = { reservaId: number; placa: string; conductor: string; v: VeredictoRastreo };
export type ResumenRastreo = {
  urgentes: ItemRastreo[];      // en ruta sin señal ahora
  incompletos: ItemRastreo[];   // sin rastreo útil (incompleto, sin señal, solo antena, inmóvil)
  conCortes: ItemRastreo[];
  /** unidades DISTINTAS en urgentes ∪ incompletos — el «hoy hubo N vehículos» del aviso */
  unidadesConProblema: number;
  medidos: number;
};

export function resumenRastreo(items: ItemRastreo[]): ResumenRastreo {
  const urgentes = items.filter((i) => i.v.problema === "urgente");
  const incompletos = items.filter((i) => i.v.problema === "incompleto");
  const conCortes = items.filter((i) => i.v.problema === "cortes");
  const unidades = new Set([...urgentes, ...incompletos].map((i) => (i.placa && i.placa !== "—" ? i.placa : `#${i.reservaId}`)));
  const medidos = items.filter((i) => i.v.pct != null || i.v.codigo === "sin_senal").length;
  return { urgentes, incompletos, conCortes, unidadesConProblema: unidades.size, medidos };
}
