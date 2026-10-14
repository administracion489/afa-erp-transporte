// lib/tramos-historicos.ts — ¿CUÁNTO TARDA DE VERDAD el bus entre dos paraderos?
// Motor PURO: sin React, sin fetch, sin Supabase. Recibe filas, devuelve veredictos.
//
// ── EL PROBLEMA ───────────────────────────────────────────────────────────────────────
// El panel «Ruta · Google Maps» del modal GPS (components/seguimiento/ModalGps.tsx) pedía la
// ruta a Google AL ABRIR, y el ETA bus → próxima parada CON tráfico (SKU Advanced, sin caché)
// cada 3 minutos mientras el modal siguiera abierto. Lo reportó el dueño (13-10-2026): «esto me
// está generando mucho dinero de la API de Google, y el cliente y el operador muchas veces no lo
// usan». Y además los minutos de Google son los de un auto cualquiera, no los de ESE bus en ESA
// ruta: no saben de la espera de embarque ni del desvío que hace el conductor de siempre.
//
// ── LO QUE HACE ESTE MÓDULO ───────────────────────────────────────────────────────────
// Mide cada tramo con lo que el ERP YA tiene y no cuesta nada: la hora de llegada que el
// conductor marcó en cada paradero (`paradas.hora_llegada`) en los servicios FINALIZADOS de los
// últimos `DIAS_HISTORIAL` días. Un tramo A → B es la diferencia entre la llegada a B y la
// llegada a A en un servicio que tuvo esos dos paraderos SEGUIDOS. Es llegada-a-llegada, así que
// INCLUYE la espera de embarque en A — que es justo lo que hay que sumar para saber a qué hora
// llega el bus a B.
//
// ── LAS DECISIONES ────────────────────────────────────────────────────────────────────
//  1. MEDIANA, NO MEDIA. El conductor a veces marca dos paraderos de golpe al final (duración
//     ~0) o se olvida y marca horas después: una media se la llevan esos dos. La pantalla la
//     llama «promedio real» porque es lo que el operador entiende; el detalle dice «mediana».
//  2. EL TRAMO SE RECONOCE POR DÓNDE ESTÁ, NO POR CÓMO SE LLAMA. Los nombres de paradero son
//     texto libre (y a veces un plus code); dos paraderos son el mismo si están a menos de
//     `RADIO_MATCH_M` (150 m, el radio de detención de lib/gps-detencion.ts y el umbral de
//     paradero de la app del conductor). Y tienen que ser CONSECUTIVOS en el servicio histórico:
//     con un paradero intermedio, la diferencia sumaría una espera que esta ruta no tiene.
//  3. LO IMPOSIBLE SE DESCARTA Y SE CUENTA. Una duración por debajo de la línea recta a
//     `VEL_MAX_KMH` (90 km/h) es un marcado en lote, no un viaje; por encima de `DUR_MAX_MIN`
//     (3 h) es una marca olvidada. Ninguna de las dos es una medición — `descartadas` lo dice.
//  4. LA HORA DEL DÍA IMPORTA. El mismo tramo a las 06:00 y a las 18:00 no tarda lo mismo. Se
//     prefieren las muestras a ±`FRANJA_MIN` (90 min) de la hora prevista en A; si no llegan a
//     `MIN_MUESTRAS`, se usa el día entero y SE DICE (`todo_el_dia`). Con menos de
//     `MIN_MUESTRAS` en total no hay número (`pocos_datos`): una sola observación no es un
//     promedio, es una anécdota.
//  5. NADA SE INVENTA. Sin coordenadas en un extremo no se busca nada (`sin_coordenadas`), y el
//     total solo se publica COMPLETO si todos los tramos tienen número; si no, se publica la
//     parte medida y cuántos tramos le faltan.
//  Los umbrales 3 (muestras), 90 min (franja), 90 km/h y 3 h NO están medidos y se declaran.
//  El lado seguro de MIN_MUESTRAS es subirlo. RADIO_MATCH_M es heredado.
//
// Matriz: npx tsx scripts/prueba-tramos-historicos.mts

import { distM } from "./huella";

export const DIAS_HISTORIAL = 30;
export const RADIO_MATCH_M = 150;
export const MIN_MUESTRAS = 3;
export const FRANJA_MIN = 90;
export const VEL_MAX_KMH = 90;
export const DUR_MIN_S = 30;
export const DUR_MAX_MIN = 180;

export type PuntoRuta = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** "HH:MM[:SS]" prevista en este paradero (paradas.hora_estimada), si existe. */
  hora?: string | null;
};

export type ParadaHistorica = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** Llegada CREÍBLE en epoch ms (la de `hechosDeParadas`), o null. */
  llegadaTs: number | null;
};

/** Un servicio histórico: sus paradas YA ORDENADAS por `orden`. */
export type ServicioHistorico = { reservaId: number; paradas: ParadaHistorica[] };

export type CodigoTramo = "franja" | "todo_el_dia" | "pocos_datos" | "sin_coordenadas";

export type TramoHistorico = {
  codigo: CodigoTramo;
  /** Mediana en minutos (con un decimal), o null. */
  minutos: number | null;
  /** Muestras con las que se calculó `minutos` (0 si no hay número). */
  muestras: number;
  /** Muestras válidas a cualquier hora. */
  muestrasDia: number;
  /** Mediciones encontradas pero imposibles (marcado en lote, marca olvidada). */
  descartadas: number;
  /** Distancia en línea recta entre los dos paraderos, en metros (null sin coordenadas). */
  rectaM: number | null;
  /** Frase lista para un `title`, sin cifras inventadas. */
  detalle: string;
};

export type TiemposHistoricos = {
  tramos: TramoHistorico[];
  /** Suma de las medianas de los tramos con número. */
  totalMin: number | null;
  /** ¿Todos los tramos tienen número? Solo entonces `totalMin` es la ruta entera. */
  completo: boolean;
  conNumero: number;
  /** Servicios distintos que aportaron al menos una muestra. */
  servicios: number;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const coord = (p: { lat?: unknown; lng?: unknown } | null | undefined) => {
  const lat = num(p?.lat), lng = num(p?.lng);
  // (0, 0) no es un paradero: es una fila sin coordenadas que se coló como número.
  if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
};

/** "HH:MM[:SS]" → minuto del día, o null. */
export function horaAMin(h: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? "").trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Minuto del día en Lima (UTC-5, sin horario de verano) de un instante. */
export function minutoLima(ts: number): number {
  const m = Math.floor((ts - 5 * 3600_000) / 60_000);
  return ((m % 1440) + 1440) % 1440;
}

/** Distancia circular entre dos minutos del día (23:50 y 00:10 están a 20 min). */
export function difMinutosDia(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

export function mediana(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

type Muestra = { durS: number; minDia: number; reservaId: number };

/**
 * Todas las mediciones del tramo A → B en los servicios históricos: una por servicio como
 * máximo (el primer par consecutivo que calce), separadas en válidas y descartadas.
 */
export function muestrasDeTramo(
  a: { lat: number; lng: number }, b: { lat: number; lng: number },
  servicios: readonly ServicioHistorico[],
): { validas: Muestra[]; descartadas: number } {
  const rectaM = distM(a.lat, a.lng, b.lat, b.lng);
  const durMin = Math.max(DUR_MIN_S, rectaM / (VEL_MAX_KMH / 3.6));
  const validas: Muestra[] = [];
  let descartadas = 0;
  for (const s of servicios || []) {
    const ps = s?.paradas || [];
    for (let j = 0; j + 1 < ps.length; j++) {
      const qa = coord(ps[j]), qb = coord(ps[j + 1]);
      if (!qa || !qb) continue;
      if (distM(qa.lat, qa.lng, a.lat, a.lng) > RADIO_MATCH_M) continue;
      if (distM(qb.lat, qb.lng, b.lat, b.lng) > RADIO_MATCH_M) continue;
      const ta = ps[j].llegadaTs, tb = ps[j + 1].llegadaTs;
      // Calzó el tramo pero sin las dos horas: no hay medición. No se busca otro par en el mismo
      // servicio — sería contar dos veces el mismo viaje si la ruta repite el tramo.
      if (ta != null && tb != null && Number.isFinite(ta) && Number.isFinite(tb)) {
        const durS = (tb - ta) / 1000;
        if (durS >= durMin && durS <= DUR_MAX_MIN * 60) validas.push({ durS, minDia: minutoLima(ta), reservaId: s.reservaId });
        else descartadas++;
      }
      break;
    }
  }
  return { validas, descartadas };
}

const redondear1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Tiempo típico de cada tramo de `ruta` (los paraderos de ESTE servicio, en orden) según los
 * servicios históricos. `horaServicio` es el respaldo de la hora prevista cuando el paradero A
 * no trae la suya. Pura y determinista.
 */
export function tiemposPorTramo(
  ruta: readonly PuntoRuta[],
  servicios: readonly ServicioHistorico[],
  opts: { horaServicio?: string | null } = {},
): TiemposHistoricos {
  const tramos: TramoHistorico[] = [];
  const aportan = new Set<number>();
  for (let i = 0; i + 1 < (ruta || []).length; i++) {
    const a = coord(ruta[i]), b = coord(ruta[i + 1]);
    if (!a || !b) {
      tramos.push({
        codigo: "sin_coordenadas", minutos: null, muestras: 0, muestrasDia: 0, descartadas: 0, rectaM: null,
        detalle: "Un paradero de este tramo no tiene coordenadas: no se puede buscar en el historial.",
      });
      continue;
    }
    const rectaM = distM(a.lat, a.lng, b.lat, b.lng);
    const { validas, descartadas } = muestrasDeTramo(a, b, servicios);
    const ref = horaAMin(ruta[i].hora) ?? horaAMin(opts.horaServicio);
    const enFranja = ref == null ? [] : validas.filter((m) => difMinutosDia(m.minDia, ref) <= FRANJA_MIN);
    const notaDesc = descartadas > 0 ? ` ${descartadas} medición(es) imposible(s) se descartaron (marcado en lote u olvidado).` : "";
    let usadas: Muestra[] | null = null;
    let codigo: CodigoTramo;
    if (enFranja.length >= MIN_MUESTRAS) { usadas = enFranja; codigo = "franja"; }
    else if (validas.length >= MIN_MUESTRAS) { usadas = validas; codigo = "todo_el_dia"; }
    else codigo = "pocos_datos";
    if (!usadas) {
      tramos.push({
        codigo, minutos: null, muestras: 0, muestrasDia: validas.length, descartadas, rectaM,
        detalle: validas.length === 0
          ? `Sin servicios finalizados con este tramo marcado en los últimos ${DIAS_HISTORIAL} días.${notaDesc}`
          : `Solo ${validas.length} medición(es) en ${DIAS_HISTORIAL} días: hacen falta ${MIN_MUESTRAS} para un promedio.${notaDesc}`,
      });
      continue;
    }
    for (const m of usadas) aportan.add(m.reservaId);
    const min = redondear1(mediana(usadas.map((m) => m.durS))! / 60);
    tramos.push({
      codigo, minutos: min, muestras: usadas.length, muestrasDia: validas.length, descartadas, rectaM,
      detalle: codigo === "franja"
        ? `Mediana de ${usadas.length} servicio(s) a ±${FRANJA_MIN} min de esta hora, últimos ${DIAS_HISTORIAL} días (llegada a llegada, incluye la espera de embarque).${notaDesc}`
        : `Mediana de ${usadas.length} servicio(s) a cualquier hora (no hay ${MIN_MUESTRAS} a esta hora), últimos ${DIAS_HISTORIAL} días.${notaDesc}`,
    });
  }
  const conNumero = tramos.filter((t) => t.minutos != null).length;
  const totalMin = conNumero ? redondear1(tramos.reduce((s, t) => s + (t.minutos ?? 0), 0)) : null;
  return { tramos, totalMin, completo: tramos.length > 0 && conNumero === tramos.length, conNumero, servicios: aportan.size };
}

/**
 * Minutos que le faltan al bus para la próxima parada SIN pedirle nada a Google: la fracción de
 * la línea recta del tramo que todavía queda, por la duración típica del tramo. Es una
 * aproximación y se presenta como tal; con la distancia restante mayor que el tramo (el bus aún
 * viene hacia el inicio del tramo) se toma el tramo entero, nunca más.
 */
export function minutosRestantes(minTramo: number | null, restanteM: number | null, rectaTramoM: number | null): number | null {
  if (minTramo == null || restanteM == null || !Number.isFinite(minTramo) || !Number.isFinite(restanteM)) return null;
  if (rectaTramoM == null || !(rectaTramoM > 0)) return null;
  const f = Math.min(1, Math.max(0, restanteM / rectaTramoM));
  return redondear1(minTramo * f);
}
