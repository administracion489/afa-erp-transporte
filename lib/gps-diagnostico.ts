// lib/gps-diagnostico.ts — ¿POR QUÉ SE CORTÓ EL RASTREO? Motor PURO: sin React, sin fetch, sin
// Supabase. Lo usa el modal de diagnóstico que se abre desde la celda RASTREO de /seguimiento.
//
// ── DE DÓNDE SALE CADA NÚMERO ─────────────────────────────────────────────────────────
// El %, la banda y los tramos NO se miden aquí: salen del MISMO `medirCobertura` y del mismo
// veredicto que la celda (lib/gps-cobertura.ts). Este módulo solo responde lo que la celda no dice:
// el PORQUÉ de cada tramo sin posición, y qué del teléfono lo explica (lib/gps-equipo.ts). Un
// diagnóstico que recalculara el % mostraría en el modal un número distinto al de la celda en la que
// se hizo clic — el bug del semáforo de puntualidad.
//
// ── LA CAUSA DE CADA TRAMO, DE LA EVIDENCIA AL JUICIO (gana la primera) ───────────────
//   1. No se pudieron leer las filas → `desconocida`. No se adivina.
//   2. Las filas imprecisas dentro del tramo cubren al menos MITAD_ANTENA de él → `por_antena`: el
//      teléfono SÍ mandaba, pero sin satélite.
//   3. La primera posición útil que cierra el tramo llegó al servidor con un retraso EXTRA mayor que
//      SENAL_PERDIDA_MIN → `sin_datos`: lo que quedó en la cola del teléfono se perdió (cola
//      desbordada) o llegó tarde.
//   4. Hay prueba de que el servicio SEGUÍA → `app_detenida`: un hueco entre dos posiciones, una
//      cabeza (el inicio lo marcó el conductor) o una cola que termina en el cierre o en marcas del
//      conductor (la cola del teléfono es FIFO: si llegó el cierre, llegó todo lo anterior).
//   5. Si no (cola hasta la hora PREVISTA, o servicio en curso) → `desconocida`.
//
// ── DOS COSAS QUE NO DEJAN HUECO, Y POR ESO VAN APARTE ───────────────────────────────
//   · El GPS CONGELADO: llegan puntos idénticos cada pocos segundos, así que `medirCobertura` los
//     cuenta como cubiertos. Se listan aparte y NO cambian el %: el % mide si llegó GPS, no si el GPS
//     decía la verdad; cambiarlo aquí haría que el modal y la celda dijeran dos números.
//   · La FALTA DE DATOS MÓVILES casi nunca deja hueco: la cola del teléfono es persistente y FIFO, y
//     los puntos tomados sin señal llegan después con su hora original. Se ve como LLEGADAS TARDÍAS
//     (recibido_en − created_at). Solo deja hueco si la cola se desborda (regla 3).
//
// ── LAS FRASES LAS COMPONE ESTE MÓDULO, NUNCA EL TSX ─────────────────────────────────
// Una frase armada dentro del componente puede describir al revés lo que el sistema decide sin que
// nada falle (la ventana invertida del horario del conductor). Aquí viven todas, con los mismos
// números que usa el veredicto.

import {
  HUECO_MIN_S, AVANCE_CAIDO_M, AVANCE_MAX_M, SENAL_PERDIDA_MIN, BANDA_ACEPTABLE, metros,
  type TramoSinRastreo, type FilaGpsDiag, type MedicionCobertura, type TrazaSaneada,
  type VeredictoRastreo, type CodigoRastreo, type FinVentana,
} from "./gps-cobertura";
import { POS_CLAVADA_MS } from "./gps-detencion";
import { hhmmLima } from "./servicio-tiempos";
import {
  faltasDeConfiguracion, guiaDeFabricante, FABRICANTES_AGRESIVOS, CAMPOS_APP_DETENIDA, CAMPOS_POR_ANTENA,
  ETIQUETA_CAMPO, type EstadoEquipo, type FaltaConfig, type CampoEquipo, type PasoAjuste,
} from "./gps-equipo";

// ══ Constantes ═══════════════════════════════════════════════════════════════════════════

/** NO MEDIDO: fracción del tramo que tienen que cubrir las filas de antena para decir «mandaba,
 *  pero por antena». El lado seguro (no absolver a la app de haberse detenido) es subirlo. */
export const MITAD_ANTENA = 0.5;
/** NO MEDIDO: percentil de los retrasos de entrega que se toma como el retraso NORMAL. Absorbe el
 *  desfase constante del reloj del teléfono (que puede ir adelantado o atrasado). */
export const PERCENTIL_BASE = 0.05;
/** NO MEDIDO: con menos posiciones con hora de recepción no se juzgan las llegadas tardías. */
export const MIN_FILAS_ENTREGA = 20;
/** DECLARADO = SENAL_PERDIDA_MIN: un reporte de reinicio de la app «explica» un tramo si cae a
 *  menos de esto del final del tramo (la app reabre y reporta en cuanto vuelve). */
export const TOL_REINICIO_MS = SENAL_PERDIDA_MIN * 60_000;
/** HEREDADO de ModalGps (`cong.ms > 180000`) y de `CONGELADO_MS` de la app del conductor: un fix_ts
 *  que no avanza en esto es un GPS que dejó de entregar posiciones nuevas. */
export const FIX_ESTANCADO_MS = 180_000;
/** NO MEDIDOS: patrón del conductor — servicios medidos mínimos y fracción con cortes. */
export const MIN_SERVICIOS_PATRON = 3;
export const FRACCION_PATRON = 0.5;

const RETRASO_TARDE_MS = SENAL_PERDIDA_MIN * 60_000;

// ══ Tipos ════════════════════════════════════════════════════════════════════════════════

export type CausaCorte = "app_detenida" | "por_antena" | "sin_datos" | "desconocida";

export type TramoDiagnosticado = TramoSinRastreo & {
  causa: CausaCorte;
  /** filas por antena dentro del tramo */
  filasAntena: number;
  precisionMedianaM: number | null;
  /** un reporte de reinicio de la app a ±TOL_REINICIO_MS del final del tramo (hora del teléfono) */
  reinicioApp: { clienteTs: number } | null;
  texto: string;
};

export type TramoCongelado = {
  desdeTs: number; hastaTs: number; durS: number;
  /** distancia a la que apareció la siguiente posición */
  saltoM: number;
  por: "posicion_identica" | "fix_estancado";
  texto: string;
};

export type LlegadaTardia = { desdeTs: number; hastaTs: number; puntos: number; retrasoMaxS: number; texto: string };

export type EstadoEntregas =
  | { medible: true; tardias: LlegadaTardia[]; baseS: number; texto: string }
  | { medible: false; motivo: "sin_columna" | "sin_filas" | "pocos_puntos"; texto: string };

export type CodigoDiagnostico =
  | "sin_problema" | "no_aplica" | "configuracion" | "ajustes_fabricante" | "equipo"
  | "red_movil" | "no_se_sabe" | "sin_medir";

export type DiagnosticoRastreo = {
  codigo: CodigoDiagnostico;
  titular: string;
  detalle: string;
  color: string; bg: string;
  causaDominante: CausaCorte | "congelado" | null;
  /** «N tramos sin rastreo · M min de T» (el total de la sección de tramos) */
  resumen: string;
  tramos: TramoDiagnosticado[];
  congelados: TramoCongelado[];
  entregas: EstadoEntregas;
  /** todas las faltas del teléfono; `explica` = la que explica la causa dominante (van primero) */
  faltas: (FaltaConfig & { explica: boolean })[];
  noComprobado: CampoEquipo[];
  /** de qué reporte salió el juicio sobre el teléfono */
  estadoUsado: "durante" | "anterior" | null;
  guia: { fabricante: string; marca: string; pasos: PasoAjuste[]; agresivo: boolean } | null;
};

const AMBAR = { color: "#92400e", bg: "#fef3c7" };
const GRIS = { color: "#6b7280", bg: "#f3f4f6" };
const AZUL = { color: "#1e40af", bg: "#dbeafe" };
const VERDE = { color: "#166534", bg: "#dcfce7" };
const COLOR: Record<CodigoDiagnostico, { color: string; bg: string }> = {
  sin_problema: VERDE, no_aplica: GRIS, configuracion: AMBAR, ajustes_fabricante: AMBAR, equipo: AMBAR,
  red_movil: AZUL, no_se_sabe: GRIS, sin_medir: GRIS,
};

// ══ Formato ══════════════════════════════════════════════════════════════════════════════

const hh = (ts: number) => hhmmLima(ts);
function minTxt(s: number): string { return `${Math.max(1, Math.round(s / 60))} min`; }
function distTxt(m: number): string { return m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${Math.round(m)} m`; }
function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// ══ Llegadas tardías ═════════════════════════════════════════════════════════════════════

/**
 * Retraso de cada posición = recibido_en − created_at (los dos relojes: el del servidor y el del
 * teléfono). El retraso NORMAL es el percentil PERCENTIL_BASE: absorbe el desfase de reloj, que es
 * constante. Llega tarde lo que supera ese normal en más de SENAL_PERDIDA_MIN. Las tardías seguidas
 * forman un bloque (lo que la cola mandó de una vez al volver la señal).
 */
export function medirEntregas(filas: FilaGpsDiag[] | null, recibidoMedible: boolean): EstadoEntregas {
  return entregasConBase(filas, recibidoMedible).estado;
}

function entregasConBase(filas: FilaGpsDiag[] | null, recibidoMedible: boolean): { estado: EstadoEntregas; baseMs: number | null } {
  if (!recibidoMedible) {
    return { baseMs: null, estado: { medible: false, motivo: "sin_columna",
      texto: "No se puede saber si algo llegó tarde: falta correr supabase/gps-equipo-01.sql, que guarda la hora a la que llega cada posición." } };
  }
  if (!filas || !filas.length) {
    return { baseMs: null, estado: { medible: false, motivo: "sin_filas", texto: "No hay posiciones con las que revisar si algo llegó tarde." } };
  }
  const con = filas.filter((f) => f.recibidoTs != null).sort((a, b) => a.ts - b.ts);
  if (con.length < MIN_FILAS_ENTREGA) {
    return { baseMs: null, estado: { medible: false, motivo: "pocos_puntos",
      texto: `Solo ${con.length} posición(es) traen la hora de recepción (las anteriores a supabase/gps-equipo-01.sql no la tienen): muy pocas para juzgar si algo llegó tarde.` } };
  }
  const retrasos = con.map((f) => (f.recibidoTs as number) - f.ts);
  const orden = [...retrasos].sort((a, b) => a - b);
  const baseMs = orden[Math.floor(PERCENTIL_BASE * (orden.length - 1))];
  const tardias: LlegadaTardia[] = [];
  let bloque: { desde: number; hasta: number; puntos: number; max: number } | null = null;
  const cerrar = () => {
    if (!bloque) return;
    const retrasoMaxS = Math.round(bloque.max / 1000);
    tardias.push({
      desdeTs: bloque.desde, hastaTs: bloque.hasta, puntos: bloque.puntos, retrasoMaxS,
      texto: bloque.desde === bloque.hasta
        ? `A las ${hh(bloque.desde)}: 1 posición llegó ${minTxt(retrasoMaxS)} tarde.`
        : `De ${hh(bloque.desde)} a ${hh(bloque.hasta)}: ${bloque.puntos} posiciones llegaron hasta ${minTxt(retrasoMaxS)} tarde.`,
    });
    bloque = null;
  };
  for (let i = 0; i < con.length; i++) {
    const extra = retrasos[i] - baseMs;
    if (extra > RETRASO_TARDE_MS) {
      if (!bloque) bloque = { desde: con[i].ts, hasta: con[i].ts, puntos: 0, max: 0 };
      bloque.hasta = con[i].ts; bloque.puntos++; bloque.max = Math.max(bloque.max, extra);
    } else cerrar();
  }
  cerrar();
  const puntos = tardias.reduce((s, t) => s + t.puntos, 0);
  return {
    baseMs,
    estado: {
      medible: true, tardias, baseS: Math.round(baseMs / 1000),
      texto: tardias.length
        ? `${tardias.length} tramo(s) llegaron tarde (${puntos} posiciones): el teléfono se quedó sin datos móviles, las guardó y las mandó al recuperar señal. No es un hueco: esas posiciones están en el registro.`
        : "Nada llegó tarde: las posiciones llegaron al servidor a tiempo.",
    },
  };
}

// ══ GPS congelado ════════════════════════════════════════════════════════════════════════

/**
 * Rachas de posiciones útiles que no describen al bus:
 *   · `posicion_identica`: la MISMA coordenada (exacta) durante POS_CLAVADA_MS o más.
 *   · `fix_estancado`: el MISMO fix_ts (no nulo) durante FIX_ESTANCADO_MS o más.
 * Y además la siguiente posición llega en ≤ HUECO_MIN_S y a una distancia de corte (entre
 * AVANCE_CAIDO_M y AVANCE_MAX_M): el bus estaba en otro lado. Una racha se corta en un hueco (> HUECO_MIN_S),
 * y si lo que sigue a la racha es un hueco, NO es congelado: ese hueco ya cuenta el movimiento y
 * contarlo dos veces sería acusar dos veces por el mismo tramo.
 */
export function detectarCongelados(filas: FilaGpsDiag[] | null): TramoCongelado[] {
  if (!filas) return [];
  const u = filas.filter((f) => f.util).sort((a, b) => a.ts - b.ts);
  const out: TramoCongelado[] = [];
  const buscar = (igual: (a: FilaGpsDiag, b: FilaGpsDiag) => boolean, minMs: number, por: TramoCongelado["por"]) => {
    let i = 0;
    while (i < u.length) {
      let j = i;
      while (j + 1 < u.length && igual(u[i], u[j + 1]) && (u[j + 1].ts - u[j].ts) / 1000 <= HUECO_MIN_S) j++;
      const sig = u[j + 1];
      if (j > i && u[j].ts - u[i].ts >= minMs && sig && (sig.ts - u[j].ts) / 1000 <= HUECO_MIN_S) {
        const salto = metros(u[j].lat, u[j].lng, sig.lat, sig.lng);
        const desde = u[i].ts, hasta = sig.ts;
        const solapa = out.some((c) => c.desdeTs < hasta && desde < c.hastaTs);
        if (salto >= AVANCE_CAIDO_M && salto <= AVANCE_MAX_M && !solapa) {
          const durS = (hasta - desde) / 1000;
          out.push({
            desdeTs: desde, hastaTs: hasta, durS, saltoM: salto, por,
            texto: por === "posicion_identica"
              ? `De ${hh(desde)} a ${hh(hasta)} llegaron posiciones idénticas (${minTxt(durS)}) y después el bus apareció ${distTxt(salto)} más allá: el GPS del teléfono se quedó pegado. Ese tiempo cuenta como rastreado en el %, pero el recorrido real no quedó registrado.`
              : `De ${hh(desde)} a ${hh(hasta)} la app repitió el mismo fix del GPS (${minTxt(durS)}) y después el bus apareció ${distTxt(salto)} más allá: el GPS del teléfono dejó de entregar posiciones nuevas. Cuenta como rastreado en el %, pero no lo estuvo.`,
          });
        }
      }
      i = j + 1;
    }
  };
  buscar((a, b) => a.lat === b.lat && a.lng === b.lng, POS_CLAVADA_MS, "posicion_identica");
  buscar((a, b) => a.fixTs != null && a.fixTs === b.fixTs, FIX_ESTANCADO_MS, "fix_estancado");
  return out.sort((a, b) => a.desdeTs - b.desdeTs);
}

// ══ La causa de cada tramo ═══════════════════════════════════════════════════════════════

/** Clasifica los tramos de la medición. `baseMs` = el retraso normal de entrega (null si no se pudo
 *  medir: entonces no se afirma `sin_datos`). Los reinicios van en hora del teléfono. */
export function clasificarTramos(
  medicion: MedicionCobertura,
  filas: FilaGpsDiag[] | null,
  baseMs: number | null,
  reinicios: number[],
): TramoDiagnosticado[] {
  const ord = filas ? [...filas].sort((a, b) => a.ts - b.ts) : null;
  const antena = ord ? ord.filter((f) => f.antena) : [];
  const utiles = ord ? ord.filter((f) => f.util) : [];
  return (medicion.tramos || []).map((t) => clasificarTramo(t, medicion.finPor, ord, antena, utiles, baseMs, reinicios));
}

function clasificarTramo(
  t: TramoSinRastreo, finPor: FinVentana, filas: FilaGpsDiag[] | null,
  antena: FilaGpsDiag[], utiles: FilaGpsDiag[], baseMs: number | null, reinicios: number[],
): TramoDiagnosticado {
  const base = { ...t, filasAntena: 0, precisionMedianaM: null as number | null, reinicioApp: null as { clienteTs: number } | null };
  if (!filas) {
    return { ...base, causa: "desconocida", texto: "No se pudo leer el detalle de las posiciones: no se sabe por qué se cortó." };
  }
  // 2 · ¿Mandaba por antena? Solo cuentan como borde las posiciones REALES (la cabeza empieza en el
  // inicio marcado y la cola termina en un fin que no es una posición).
  const dentro = antena.filter((f) => f.ts >= t.desdeTs && f.ts <= t.hastaTs);
  const precisionMedianaM = mediana(dentro.map((f) => f.precisionM).filter((p): p is number => p != null));
  const filasAntena = dentro.length;
  if (filasAntena > 0) {
    const seq = [
      ...(t.tipo !== "cabeza" ? [t.desdeTs] : []),
      ...dentro.map((f) => f.ts),
      ...(t.tipo !== "cola" ? [t.hastaTs] : []),
    ].sort((a, b) => a - b);
    let cubiertoS = 0;
    for (let i = 1; i < seq.length; i++) {
      const g = (seq[i] - seq[i - 1]) / 1000;
      if (g <= HUECO_MIN_S) cubiertoS += g;
    }
    if (cubiertoS >= MITAD_ANTENA * t.durS) {
      return { ...base, filasAntena, precisionMedianaM, causa: "por_antena",
        texto: `El teléfono siguió enviando (${filasAntena} posición(es)), pero por antena${precisionMedianaM != null ? ` (±${Math.round(precisionMedianaM)} m)` : ""}: sin satélite no sirven para seguir el viaje.` };
    }
  }
  const conAntena = { ...base, filasAntena, precisionMedianaM };
  // 3 · ¿La posición que cierra el tramo llegó tarde? (cola desbordada / app sin datos al volver)
  if (t.tipo !== "cola" && baseMs != null) {
    const cierre = utiles.find((f) => f.ts >= t.hastaTs);
    if (cierre && cierre.recibidoTs != null) {
      const extra = cierre.recibidoTs - cierre.ts - baseMs;
      if (extra > RETRASO_TARDE_MS) {
        return { ...conAntena, causa: "sin_datos",
          texto: `La primera posición después del corte llegó ${minTxt(extra / 1000)} tarde al servidor: el teléfono estuvo sin datos móviles y las posiciones de este tramo no llegaron.` };
      }
    }
  }
  // 4 · ¿Hay prueba de que el servicio seguía?
  const prueba = t.tipo === "hueco" || t.tipo === "cabeza" || (t.tipo === "cola" && (finPor === "cierre" || finPor === "marcas"));
  if (prueba) {
    let reinicio: number | null = null;
    for (const r of reinicios || []) {
      if (Math.abs(r - t.hastaTs) <= TOL_REINICIO_MS && (reinicio == null || Math.abs(r - t.hastaTs) < Math.abs(reinicio - t.hastaTs))) reinicio = r;
    }
    const txtReinicio = reinicio != null ? ` La app se volvió a abrir a las ${hh(reinicio)}: el sistema la había cerrado.` : "";
    // Un hueco con el bus QUIETO se dice: sin eso se lee como un corte en carretera (reserva #27107,
    // 7 min esperando la hora de salida). Sigue restando del %, a propósito y por decisión del dueño
    // (13-10-2026): esos minutos nadie veía el bus, y es el mismo fallo que en ruta pierde km.
    const quieto = !t.enMovimiento && t.avanceM != null && t.avanceM < AVANCE_CAIDO_M;
    const texto = t.tipo === "hueco"
      ? quieto
        ? `La app no envió ninguna posición en ${minTxt(t.durS)} con el bus detenido (se movió ${distTxt(t.avanceM as number)}): la app se detuvo y volvió a enviar a las ${hh(t.hastaTs)}. No se perdió recorrido, pero resta del % igual: en esos minutos ni la torre ni los pasajeros veían el bus.`
        : `La app no envió ninguna posición en ${minTxt(t.durS)}${t.enMovimiento && t.avanceM != null ? ` mientras el bus avanzó ${distTxt(t.avanceM)}` : ""}: se detuvo y volvió a enviar a las ${hh(t.hastaTs)}.`
      : t.tipo === "cabeza"
        ? `El conductor inició el servicio a las ${hh(t.desdeTs)} y la primera posición llegó a las ${hh(t.hastaTs)}: la app no estaba enviando.`
        : finPor === "cierre"
          ? `La última posición fue a las ${hh(t.desdeTs)} y el conductor cerró el servicio a las ${hh(t.hastaTs)}: la app dejó de enviar.`
          : `La última posición fue a las ${hh(t.desdeTs)} y el conductor siguió marcando paraderos hasta las ${hh(t.hastaTs)}: la app dejó de enviar.`;
    return { ...conAntena, causa: "app_detenida", reinicioApp: reinicio != null ? { clienteTs: reinicio } : null, texto: texto + txtReinicio };
  }
  // 5 · Sin prueba: la cola hasta la hora PREVISTA, o el servicio en curso.
  return { ...conAntena, causa: "desconocida",
    texto: finPor === "en_curso"
      ? `Sin posiciones desde las ${hh(t.desdeTs)}. En curso: si es falta de datos móviles, las posiciones guardadas en el teléfono todavía pueden llegar.`
      : `La señal se cortó a las ${hh(t.desdeTs)} y no volvió; sin marcas ni cierre del conductor después, no se sabe si el servicio seguía.` };
}

// ══ El veredicto ═════════════════════════════════════════════════════════════════════════

const ORDEN_DOMINANTE: (CausaCorte | "congelado")[] = ["app_detenida", "por_antena", "sin_datos", "congelado", "desconocida"];

export function diagnosticarRastreo(e: {
  veredicto: VeredictoRastreo;
  medicion: MedicionCobertura | null;
  traza: TrazaSaneada | null;
  filas: FilaGpsDiag[] | null;
  enCurso: boolean;
  equipo: { durante: EstadoEquipo | null; anterior: EstadoEquipo | null };
  /** reportes de reinicio de la app, en hora del teléfono */
  reinicios: number[];
  /** existe ubicaciones_gps.recibido_en (supabase/gps-equipo-01.sql corrida) */
  recibidoMedible: boolean;
  /** OPCIONAL: no existe `gps_equipo_reportes` (supabase/gps-equipo-01.sql sin correr). Sin estado del
   *  teléfono, el detalle no puede decir «no reportó»: no PUDO reportar. Omitido = como antes. */
  sinTablaEquipo?: boolean;
}): DiagnosticoRastreo {
  const filas = e.filas ? [...e.filas].sort((a, b) => a.ts - b.ts) : null;
  const { estado: entregas, baseMs } = entregasConBase(filas, e.recibidoMedible);
  const tramos = e.medicion ? clasificarTramos(e.medicion, filas, baseMs, e.reinicios || []) : [];
  const congelados = detectarCongelados(filas);

  const estado = e.equipo.durante ?? e.equipo.anterior;
  const estadoUsado: DiagnosticoRastreo["estadoUsado"] = e.equipo.durante ? "durante" : e.equipo.anterior ? "anterior" : null;
  const { faltas: todas, noComprobado } = faltasDeConfiguracion(estado);
  const guia = estado ? (() => {
    const g = guiaDeFabricante(estado.fabricante);
    return { fabricante: estado.fabricante, marca: g.marca, pasos: g.pasos, agresivo: FABRICANTES_AGRESIVOS.includes(estado.fabricante) };
  })() : null;

  const totalS = tramos.reduce((s, t) => s + t.durS, 0);
  const resumen = !e.medicion
    ? (e.veredicto.codigo === "sin_senal" ? "Ninguna posición en todo el servicio."
      : e.veredicto.codigo === "solo_antena" ? `${e.traza?.totalCrudo ?? 0} posición(es), todas por antena.`
      : "Sin medición.")
    : tramos.length
      ? `${tramos.length} tramo(s) sin rastreo · ${minTxt(totalS)} de ${e.medicion.durMin} min${congelados.length ? ` · ${congelados.length} con el GPS pegado` : ""}`
      : `Sin tramos sin rastreo en ${e.medicion.durMin} min${congelados.length ? ` · ${congelados.length} con el GPS pegado` : ""}`;

  const armar = (codigo: CodigoDiagnostico, causaDominante: DiagnosticoRastreo["causaDominante"], titular: string, detalle: string): DiagnosticoRastreo => {
    const explicaA = causaDominante === "app_detenida" || causaDominante === "por_antena" ? causaDominante : null;
    const faltas = todas.map((f) => ({ ...f, explica: explicaA != null && f.afecta === explicaA }));
    faltas.sort((a, b) => Number(b.explica) - Number(a.explica));
    return { codigo, titular, detalle, ...COLOR[codigo], causaDominante, resumen, tramos, congelados, entregas, faltas, noComprobado, estadoUsado, guia };
  };

  const v: CodigoRastreo = e.veredicto.codigo;
  if (v === "no_aplica" || v === "recien_iniciado") {
    return armar("no_aplica", null,
      v === "recien_iniciado" ? "Recién iniciado: todavía no hay nada que diagnosticar" : "Todavía no hay nada que diagnosticar",
      `${e.veredicto.detalle} Abajo está el último estado conocido del teléfono.`);
  }
  if (v === "sin_medir") {
    return armar("sin_medir", null, "No se pudo leer el GPS de este servicio",
      "No se afirma nada sobre el conductor ni sobre el teléfono. Vuelve a abrir el diagnóstico en unos minutos.");
  }

  const minPegado = congelados.reduce((s, c) => s + c.durS, 0);
  const txtPegado = `Durante ${minTxt(minPegado)} llegaron posiciones repetidas y después el bus apareció más allá. Ese tiempo cuenta como rastreado en el %, pero el recorrido real no quedó registrado. Se arregla apagando y encendiendo la ubicación del teléfono; si se repite, es el teléfono.`;

  if (v === "gps_inmovil") {
    if (congelados.length) return armar("equipo", "congelado", "El GPS del teléfono se quedó pegado", txtPegado);
    return armar("no_se_sabe", "desconocida", "Las posiciones no se movieron con el bus",
      "Llegaron posiciones, pero todas en el mismo lugar mientras el recorrido avanzaba. Dos explicaciones: el teléfono no iba en el vehículo, o su GPS quedó pegado. Pregúntale al conductor.");
  }

  // La causa dominante: la de más duración (los congelados suman como causa).
  let dominante: CausaCorte | "congelado" | null = null;
  let causaS = 0;
  if (v === "sin_senal") dominante = "app_detenida";
  else if (v === "solo_antena") dominante = "por_antena";
  else if (v === "senal_perdida" && !e.medicion) dominante = "desconocida";
  else {
    const dur: Record<string, number> = {};
    for (const t of tramos) dur[t.causa] = (dur[t.causa] ?? 0) + t.durS;
    if (congelados.length) dur.congelado = minPegado;
    let mejor = 0;
    for (const c of ORDEN_DOMINANTE) if ((dur[c] ?? 0) > mejor) { mejor = dur[c]; dominante = c; }
    causaS = mejor;
  }

  if (dominante === null) {
    if (entregas.medible && entregas.tardias.length) {
      return armar("red_movil", null, "Se quedó sin datos móviles, pero no se perdió nada",
        `${entregas.tardias.length} tramo(s) llegaron tarde: el teléfono guardó las posiciones y las mandó al recuperar señal. El registro del servicio está completo.`);
    }
    return armar("sin_problema", null, "El rastreo no tuvo cortes",
      `${e.veredicto.pct ?? e.medicion?.cobertura ?? 100} % del servicio con GPS: ningún tramo sin posición y ningún GPS pegado.`);
  }
  if (dominante === "congelado") return armar("equipo", "congelado", "El GPS del teléfono se quedó pegado", txtPegado);
  if (dominante === "sin_datos") {
    return armar("red_movil", "sin_datos", "El teléfono se quedó sin datos móviles",
      `${minTxt(causaS)} sin rastreo: las posiciones se guardaron en el teléfono, llegaron tarde y parte se perdió. Revisa el saldo o la cobertura del plan de datos del conductor.`);
  }
  if (dominante === "desconocida") {
    if (v === "senal_perdida" && !e.medicion) {
      return armar("no_se_sabe", "desconocida", "En ruta y sin ninguna posición",
        "Si la app está cerrada, hay que abrirla; si es falta de datos móviles, las posiciones guardadas en el teléfono todavía pueden llegar. Llama al conductor.");
    }
    const primero = tramos.find((t) => t.causa === "desconocida");
    return armar("no_se_sabe", "desconocida", "No se sabe por qué se cortó el rastreo",
      `${resumen}. ${primero ? primero.texto : ""}`.trim());
  }

  // app_detenida / por_antena: lo decide el estado del teléfono.
  const causaTxt = dominante === "app_detenida"
    ? (v === "sin_senal" ? "No llegó ninguna posición en todo el servicio" : `${minTxt(causaS)} sin rastreo porque la app dejó de enviar`)
    : (v === "solo_antena" ? "Todas las posiciones llegaron por antena, sin satélite" : `${minTxt(causaS)} con posiciones por antena, sin satélite`);
  const relevantes = dominante === "app_detenida" ? CAMPOS_APP_DETENIDA : CAMPOS_POR_ANTENA;
  if (!estado) {
    if (e.sinTablaEquipo) {
      return armar("no_se_sabe", dominante, "No se puede consultar la configuración del teléfono",
        `${causaTxt}. Falta correr supabase/gps-equipo-01.sql: sin esa tabla el ERP no recibe cómo está configurado el teléfono del conductor, y no se puede decir si es la configuración o el teléfono.`);
    }
    return armar("no_se_sabe", dominante, "El teléfono no reportó su configuración",
      `${causaTxt}. La app del conductor no ha enviado cómo está configurado su teléfono (versión anterior de la app, o la usa desde otro aparato): no se puede decir si es la configuración o el teléfono.`);
  }
  const fuente = estadoUsado === "anterior"
    ? ` (Es lo que reportó el teléfono antes del servicio, a las ${hh(estado.hastaTs)}.)`
    : estado.aparatos > 1 ? ` Reportaron ${estado.aparatos} teléfonos distintos durante el servicio.` : "";
  const explican = todas.filter((f) => f.afecta === dominante);
  if (explican.length) {
    return armar("configuracion", dominante, "Le falta configurar el teléfono",
      `${causaTxt}. ${explican.map((f) => f.titulo).join(". ")}.${fuente}`);
  }
  const sinComprobar = noComprobado.filter((c) => relevantes.includes(c));
  if (sinComprobar.length) {
    return armar("no_se_sabe", dominante, "No se pudo comprobar la configuración del teléfono",
      `${causaTxt}. No se pudo comprobar: ${sinComprobar.map((c) => ETIQUETA_CAMPO[c].toLowerCase()).join(", ")}. ${estado.nivelApk.texto}${fuente}`);
  }
  if (dominante === "app_detenida") {
    const reabrio = tramos.filter((t) => t.reinicioApp).length;
    return armar("ajustes_fabricante", dominante, "La app se detuvo con el teléfono bien configurado",
      `${causaTxt}, y la batería, la ubicación «todo el tiempo» y el rastreo en segundo plano estaban bien. Lo que queda son ajustes de ${estado.fabricante === "generico" ? "este teléfono" : estado.marca} que la app no puede leer —inicio automático, bloquear la app en Recientes— o que el conductor cerró la app.${reabrio ? ` La app se volvió a abrir después de ${reabrio} corte(s): el sistema la había cerrado.` : ""}${fuente}`);
  }
  return armar("equipo", dominante, "El GPS del teléfono no entrega satélite",
    `${causaTxt}, con el permiso de ubicación precisa y la alta precisión bien puestos. Es el teléfono: su GPS es débil, o va donde no ve el cielo (guantera, bolsillo, bajo el tablero).${fuente}`);
}

// ══ Patrón del conductor (sus últimos servicios) ═════════════════════════════════════════

const NO_MEDIDOS: CodigoRastreo[] = ["no_aplica", "sin_medir", "recien_iniciado"];
const FALLAN_SIEMPRE: CodigoRastreo[] = ["sin_senal", "solo_antena", "gps_inmovil", "senal_perdida"];

/** ¿El corte es de este servicio o le pasa siempre? Un servicio «falla» si su rastreo queda por
 *  debajo de BANDA_ACEPTABLE (o no tuvo rastreo útil). Umbrales NO medidos (MIN_SERVICIOS_PATRON,
 *  FRACCION_PATRON). */
export function patronDelConductor(items: { pct: number | null; codigo: CodigoRastreo }[]): {
  codigo: "patron" | "aislado" | "irregular" | "sin_historial"; texto: string;
} {
  const medidos = (items || []).filter((i) => !NO_MEDIDOS.includes(i.codigo));
  const n = medidos.length;
  const fallan = medidos.filter((i) => FALLAN_SIEMPRE.includes(i.codigo) || (i.pct != null && i.pct < BANDA_ACEPTABLE)).length;
  if (n === 0) return { codigo: "sin_historial", texto: "No hay servicios anteriores medidos con los que comparar." };
  if (fallan === 0) return { codigo: "aislado", texto: `Sus ${n} servicio(s) anteriores tuvieron el rastreo bien: este corte parece un caso aislado.` };
  if (n >= MIN_SERVICIOS_PATRON && fallan >= FRACCION_PATRON * n) {
    return { codigo: "patron", texto: `Le pasa seguido: ${fallan} de sus ${n} servicios anteriores tuvieron cortes de rastreo. Es su teléfono o su configuración, no un caso aislado.` };
  }
  return { codigo: "irregular", texto: `${fallan} de sus ${n} servicio(s) anteriores tuvieron cortes de rastreo.` };
}
