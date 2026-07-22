// lib/odometro-analitica.ts
// ─────────────────────────────────────────────────────────────────────────────
// Analítica operativa del odómetro: convierte el historial crudo de
// `lecturas_odometro` en recorridos por jornada, indicadores por período,
// detección de anomalías y un "rango esperado" dinámico por vehículo
// (inteligencia operativa). TODO son funciones PURAS (sin red, sin DOM) para que
// puedan usarse desde componentes cliente, rutas API y pruebas.
//
// Filosofía (spec del operador):
//   - Cada jornada se mide con la PRIMERA y la ÚLTIMA lectura válida del día:
//         Recorrido del día = última − primera
//     Si solo hay una lectura → "Pendiente de completar jornada" (no se inventa).
//   - Se descartan automáticamente las lecturas basura (rechazadas, retrocesos,
//     valores absurdos/negativos, fuera de rango) ANTES de calcular.
//   - Las anomalías se derivan del PATRÓN histórico de cada vehículo, no de un
//     umbral fijo global: cada unidad aprende su propio comportamiento normal.
//
// Complemento: la ATRIBUCIÓN de km por conductor/cliente/ruta y el km en vacío
// (odómetro − GPS por servicio) vive en /api/mantenimiento/odometro-analitica
// (cruza reservas + lib/km-servicio.ts), porque requiere leer la huella GPS con
// service-role. Este archivo se queda con lo que se calcula solo con el odómetro
// y el combustible. Ver [[project_radar_combustible_multifoto]].
// ─────────────────────────────────────────────────────────────────────────────

// ─── TIPOS ───────────────────────────────────────────────────────────────────

/** Fila cruda de lecturas_odometro (los campos que consume la analítica). */
export type LecturaCruda = {
  id: string;
  vehiculo_id: number | null;
  vehiculo_tercero_id?: number | null;
  km: number;
  fuente: string;
  fecha: string;                 // YYYY-MM-DD (fecha Lima de la lectura)
  estado: string;                // aceptada | sospechosa | rechazada | reinicio
  motivo?: string | null;
  created_at: string;            // timestamptz — orden dentro del día
  momento?: string | null;       // checkin | checkout | null
  foto_url?: string | null;
};

/** Lectura ya saneada y anclada a su vehículo lógico (propia o tercero). */
export type LecturaSana = LecturaCruda & { key: string; esReinicio: boolean };

export type MotivoDescarte =
  | "no_aceptada"
  | "rechazada"
  | "invalida"
  | "absurda"
  | "retrocede"
  | "duplicada_exacta";

export type Descartada = { lectura: LecturaCruda; motivo: MotivoDescarte; detalle: string };

/** Recorrido de UNA jornada (un vehículo, un día). */
export type DiaRecorrido = {
  key: string;                   // clave del vehículo (p:ID | t:ID)
  fecha: string;                 // YYYY-MM-DD
  primeraKm: number;
  ultimaKm: number;
  recorrido: number | null;      // ultima − primera; null = jornada incompleta
  primeraHora: string | null;    // HH:MM (Lima)
  ultimaHora: string | null;     // HH:MM (Lima)
  minutosOperacion: number | null;
  nLecturas: number;
  pendiente: boolean;            // true = solo 1 lectura → no se puede calcular
  reinicio: boolean;             // hubo un cambio de tablero ese día
  anomalias: Anomalia[];
};

export type TipoAnomalia =
  | "excesivo"
  | "bajo"
  | "retroceso"
  | "duplicada"
  | "sin_recorrido";

export type Severidad = "info" | "advertencia" | "critico";

export type Anomalia = {
  tipo: TipoAnomalia;
  severidad: Severidad;
  mensaje: string;
};

/** Rango esperado dinámico (inteligencia operativa) de un vehículo. */
export type RangoEsperado = {
  media: number;
  mediana: number;
  desv: number;                  // desviación estándar de los recorridos
  min: number;                   // límite inferior esperado (no negativo)
  max: number;                   // límite superior esperado
  n: number;                     // días con dato usados para aprender el patrón
  confiable: boolean;            // n suficiente para alertar
};

/** Resumen agregado de un conjunto de jornadas en un período. */
export type ResumenPeriodo = {
  kmTotal: number;
  diasConDato: number;
  diasPendientes: number;
  promedioDiario: number | null; // kmTotal / diasConDato
  diaMax: { fecha: string; recorrido: number } | null;
  diaMin: { fecha: string; recorrido: number } | null;
};

// ─── HELPERS DE FECHA/HORA (Lima, UTC-5) ─────────────────────────────────────

const LIMA_OFFSET_MIN = -5 * 60;

/** Convierte un timestamptz a HH:MM en hora Lima. */
export function horaLima(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + LIMA_OFFSET_MIN * 60000);
  return d.toISOString().slice(11, 16);
}

/** Fecha de hoy en Lima (YYYY-MM-DD). */
export function hoyLima(): string {
  const d = new Date();
  d.setUTCMinutes(d.getUTCMinutes() + LIMA_OFFSET_MIN);
  return d.toISOString().slice(0, 10);
}

/** Suma (o resta) días a una fecha YYYY-MM-DD. */
export function sumarDias(fechaISO: string, dias: number): string {
  const d = new Date(fechaISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Diferencia en días entre dos fechas YYYY-MM-DD (b − a). */
export function diasEntreFechas(a: string, b: string): number {
  const ta = new Date(a + "T00:00:00Z").getTime();
  const tb = new Date(b + "T00:00:00Z").getTime();
  return Math.round((tb - ta) / 86400000);
}

/** Clave lógica del vehículo de una lectura (propia XOR tercero). */
export function claveVehiculo(l: { vehiculo_id: number | null; vehiculo_tercero_id?: number | null }): string {
  return l.vehiculo_tercero_id != null ? `t:${l.vehiculo_tercero_id}` : `p:${l.vehiculo_id}`;
}

// ─── SANEAMIENTO ─────────────────────────────────────────────────────────────

/**
 * Tope absoluto de plausibilidad del odómetro. Valores como 40 306 985 o
 * 99 999 999 (OCR disparatado) quedan fuera. 3 millones de km cubre de sobra la
 * vida útil real de un bus. Configurable por si algún día hay un caso extremo.
 */
export const KM_TOPE_ABSOLUTO = 3_000_000;

/**
 * Sanea las lecturas de UN vehículo: ordena por fecha+hora y devuelve la
 * secuencia monótona (no decreciente) de lecturas confiables, más el detalle de
 * lo descartado y por qué. Los reinicios de tablero re-anclan la base sin
 * contar como retroceso.
 *
 * Reglas de descarte automático (spec del operador):
 *   - no aceptada (sospechosa / por revisar)
 *   - rechazada
 *   - inválida (no numérica, ≤ 0)
 *   - absurda (> tope absoluto)
 *   - retrocede (km < base vigente y no es reinicio) → posible error/manipulación
 */
export function sanearLecturas(
  lecturas: LecturaCruda[],
  opts: { kmTope?: number; soloAceptadas?: boolean } = {}
): { limpias: LecturaSana[]; descartadas: Descartada[] } {
  const kmTope = opts.kmTope && opts.kmTope > 0 ? opts.kmTope : KM_TOPE_ABSOLUTO;
  const soloAceptadas = opts.soloAceptadas !== false; // default true

  const ordenadas = [...(lecturas || [])].sort(ordenTemporal);

  const limpias: LecturaSana[] = [];
  const descartadas: Descartada[] = [];
  let base = 0; // km vigente de la secuencia saneada

  for (const l of ordenadas) {
    const km = Number(l.km);
    const key = claveVehiculo(l);

    if (l.estado === "rechazada" || l.estado === "anulada") {
      descartadas.push({ lectura: l, motivo: "rechazada", detalle: l.estado === "anulada" ? "Lectura anulada" : "Lectura rechazada" });
      continue;
    }
    if (!Number.isFinite(km) || km <= 0) {
      descartadas.push({ lectura: l, motivo: "invalida", detalle: "Kilometraje inválido o ≤ 0" });
      continue;
    }
    if (km > kmTope) {
      descartadas.push({ lectura: l, motivo: "absurda", detalle: `Valor absurdo: ${km.toLocaleString("es-PE")} km` });
      continue;
    }

    // Reinicio de tablero: re-ancla la base (aunque sea menor) y se conserva.
    if (l.estado === "reinicio") {
      base = km;
      limpias.push({ ...l, key, esReinicio: true });
      continue;
    }

    if (soloAceptadas && l.estado !== "aceptada") {
      descartadas.push({ lectura: l, motivo: "no_aceptada", detalle: "Pendiente de revisión (no aceptada)" });
      continue;
    }

    if (base > 0 && km < base) {
      descartadas.push({
        lectura: l,
        motivo: "retrocede",
        detalle: `Retrocede: ${km.toLocaleString("es-PE")} < ${base.toLocaleString("es-PE")}`,
      });
      continue;
    }

    limpias.push({ ...l, key, esReinicio: false });
    if (km > base) base = km;
  }

  return { limpias, descartadas };
}

/** Orden temporal estable: por fecha (día) y luego por created_at. */
function ordenTemporal(a: LecturaCruda, b: LecturaCruda): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  const ta = new Date(a.created_at).getTime() || 0;
  const tb = new Date(b.created_at).getTime() || 0;
  return ta - tb;
}

// ─── RECORRIDO POR JORNADA ───────────────────────────────────────────────────

/**
 * Agrupa las lecturas saneadas de UN vehículo por día y calcula el recorrido de
 * cada jornada (última − primera). Detecta duplicados exactos consecutivos y
 * retrocesos internos residuales. NO decide "excesivo/bajo": eso depende del
 * histórico y se resuelve en `anotarAnomalias`.
 */
export function recorridosDiarios(limpias: LecturaSana[]): DiaRecorrido[] {
  const porDia = new Map<string, LecturaSana[]>();
  for (const l of limpias) {
    (porDia.get(l.fecha) ?? porDia.set(l.fecha, []).get(l.fecha)!).push(l);
  }

  const dias: DiaRecorrido[] = [];
  for (const [fecha, lects] of porDia) {
    const orden = [...lects].sort(ordenTemporal);
    const primera = orden[0];
    const ultima = orden[orden.length - 1];
    const hayReinicio = orden.some((l) => l.esReinicio);
    const anomalias: Anomalia[] = [];

    // Duplicados exactos consecutivos (mismo km) → verificar (no se descarta).
    for (let i = 1; i < orden.length; i++) {
      if (Number(orden[i].km) === Number(orden[i - 1].km)) {
        anomalias.push({
          tipo: "duplicada",
          severidad: "info",
          mensaje: `Lecturas iguales (${Number(orden[i].km).toLocaleString("es-PE")} km) — ¿unidad detenida o duplicado?`,
        });
        break;
      }
    }

    let recorrido: number | null = null;
    let pendiente = false;

    if (orden.length < 2) {
      pendiente = true;
      anomalias.push({ tipo: "sin_recorrido", severidad: "info", mensaje: "Pendiente de completar jornada" });
    } else if (hayReinicio) {
      // Con cambio de tablero el (última − primera) no representa km reales.
      recorrido = null;
      anomalias.push({ tipo: "sin_recorrido", severidad: "info", mensaje: "Reinicio de tablero en la jornada" });
    } else {
      const dif = Number(ultima.km) - Number(primera.km);
      recorrido = dif >= 0 ? dif : null;
      if (dif < 0) {
        anomalias.push({
          tipo: "retroceso",
          severidad: "critico",
          mensaje: "El odómetro disminuyó en la jornada — posible error o manipulación",
        });
      }
    }

    const primeraHora = horaLima(primera.created_at);
    const ultimaHora = horaLima(ultima.created_at);
    const minutosOperacion =
      orden.length >= 2 && primera.created_at && ultima.created_at
        ? Math.max(0, Math.round((new Date(ultima.created_at).getTime() - new Date(primera.created_at).getTime()) / 60000))
        : null;

    dias.push({
      key: primera.key,
      fecha,
      primeraKm: Number(primera.km),
      ultimaKm: Number(ultima.km),
      recorrido,
      primeraHora,
      ultimaHora,
      minutosOperacion,
      nLecturas: orden.length,
      pendiente,
      reinicio: hayReinicio,
      anomalias,
    });
  }

  return dias.sort((a, b) => (a.fecha < b.fecha ? 1 : -1)); // recientes primero
}

// ─── ESTADÍSTICA ROBUSTA ─────────────────────────────────────────────────────

export function media(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function mediana(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function desviacion(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = media(nums);
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

/** Recorridos válidos (con dato, no pendientes, no reinicio) de una lista de días. */
export function recorridosValidos(dias: DiaRecorrido[]): number[] {
  return dias
    .filter((d) => !d.pendiente && !d.reinicio && d.recorrido != null && d.recorrido >= 0)
    .map((d) => d.recorrido as number);
}

// ─── INTELIGENCIA OPERATIVA: RANGO ESPERADO ──────────────────────────────────

/**
 * Aprende el rango normal de recorrido diario de un vehículo a partir de su
 * histórico. Usa media ± k·desviación acotado por percentiles suaves, ignorando
 * los días de 0 km (parqueados) para no aplastar la media.
 */
export function rangoEsperado(dias: DiaRecorrido[], k = 2): RangoEsperado {
  const todos = recorridosValidos(dias);
  const activos = todos.filter((r) => r > 0); // días con operación real
  const base = activos.length >= 3 ? activos : todos;

  const m = media(base);
  const med = mediana(base);
  const dv = desviacion(base);
  const min = Math.max(0, Math.round(m - k * dv));
  const max = Math.round(m + k * dv);

  return {
    media: Math.round(m),
    mediana: Math.round(med),
    desv: Math.round(dv),
    min,
    max,
    n: base.length,
    confiable: base.length >= 5, // con < 5 jornadas el patrón aún no es fiable
  };
}

// ─── DETECCIÓN DE ANOMALÍAS (vs patrón histórico) ────────────────────────────

/**
 * Anota cada jornada con anomalías de recorrido comparando contra el rango
 * esperado del propio vehículo. Muta y devuelve la misma lista (conveniencia).
 *   - excesivo: recorrido muy por encima del patrón (uso no autorizado / servicio
 *     extraordinario / error de lectura).
 *   - bajo: recorrido operativo muy por debajo del patrón.
 * Los retrocesos y duplicados ya vienen anotados desde `recorridosDiarios`.
 */
export function anotarAnomalias(dias: DiaRecorrido[], rango?: RangoEsperado): DiaRecorrido[] {
  const r = rango ?? rangoEsperado(dias);
  if (!r.confiable) return dias; // sin patrón fiable no se acusa

  for (const d of dias) {
    if (d.pendiente || d.reinicio || d.recorrido == null) continue;
    const rec = d.recorrido;

    if (rec > r.max && rec > r.media * 1.5) {
      d.anomalias.push({
        tipo: "excesivo",
        severidad: rec > r.media * 3 ? "critico" : "advertencia",
        mensaje: `Recorrido fuera del patrón histórico (${rec.toLocaleString("es-PE")} km vs ~${r.media.toLocaleString("es-PE")} km promedio)`,
      });
    } else if (rec > 0 && rec < r.min && rec < r.media * 0.4) {
      d.anomalias.push({
        tipo: "bajo",
        severidad: "advertencia",
        mensaje: `Recorrido inusualmente bajo (${rec.toLocaleString("es-PE")} km vs ~${r.media.toLocaleString("es-PE")} km promedio)`,
      });
    }
  }
  return dias;
}

// ─── RESÚMENES POR PERÍODO ───────────────────────────────────────────────────

/** Resume las jornadas cuyo `fecha` cae en [desde, hasta] (inclusive). */
export function resumenPeriodo(dias: DiaRecorrido[], desde: string, hasta: string): ResumenPeriodo {
  const enRango = dias.filter((d) => d.fecha >= desde && d.fecha <= hasta);
  const conDato = enRango.filter((d) => !d.pendiente && !d.reinicio && d.recorrido != null && d.recorrido >= 0);
  const kmTotal = conDato.reduce((s, d) => s + (d.recorrido as number), 0);

  let diaMax: ResumenPeriodo["diaMax"] = null;
  let diaMin: ResumenPeriodo["diaMin"] = null;
  for (const d of conDato) {
    const rec = d.recorrido as number;
    if (rec <= 0) continue; // el "día con menor recorrido" ignora parqueados
    if (!diaMax || rec > diaMax.recorrido) diaMax = { fecha: d.fecha, recorrido: rec };
    if (!diaMin || rec < diaMin.recorrido) diaMin = { fecha: d.fecha, recorrido: rec };
  }

  return {
    kmTotal: Math.round(kmTotal),
    diasConDato: conDato.length,
    diasPendientes: enRango.filter((d) => d.pendiente).length,
    promedioDiario: conDato.length ? Math.round(kmTotal / conDato.length) : null,
    diaMax,
    diaMin,
  };
}

/** Promedio diario real (km/día) de los últimos `n` días con dato desde una fecha. */
export function promedioUltimosDias(dias: DiaRecorrido[], hasta: string, n: number): number | null {
  const desde = sumarDias(hasta, -(n - 1));
  const r = resumenPeriodo(dias, desde, hasta);
  return r.promedioDiario;
}

export type EstadisticasVehiculo = {
  hoy: DiaRecorrido | null;
  semana: ResumenPeriodo;
  mes: ResumenPeriodo;
  historicos: {
    prom7: number | null;
    prom30: number | null;
    prom90: number | null;
    promAnual: number | null;
  };
  rango: RangoEsperado;
  kmAcumulado: number | null; // km vigente del vehículo (mayor lectura sana)
};

/** Empaqueta los indicadores del dashboard por vehículo. */
export function estadisticasVehiculo(dias: DiaRecorrido[], hoy: string = hoyLima()): EstadisticasVehiculo {
  const inicioSemana = sumarDias(hoy, -6);
  const inicioMes = hoy.slice(0, 8) + "01";
  const rango = rangoEsperado(dias);
  const kmAcumulado = dias.length ? Math.max(...dias.map((d) => d.ultimaKm)) : null;

  return {
    hoy: dias.find((d) => d.fecha === hoy) ?? null,
    semana: resumenPeriodo(dias, inicioSemana, hoy),
    mes: resumenPeriodo(dias, inicioMes, hoy),
    historicos: {
      prom7: promedioUltimosDias(dias, hoy, 7),
      prom30: promedioUltimosDias(dias, hoy, 30),
      prom90: promedioUltimosDias(dias, hoy, 90),
      promAnual: promedioUltimosDias(dias, hoy, 365),
    },
    rango,
    kmAcumulado,
  };
}

// ─── INDICADORES ECONÓMICOS (combustible × odómetro) ─────────────────────────

export type RegistroCombustible = {
  vehiculo_id: number | null;
  fecha: string;
  kilometraje: number;
  galones: number;
  precio_galon: number;
  total: number;
  tipo_combustible?: string | null;
};

export type IndicadoresEconomicos = {
  rendimientoKmGal: number | null; // km por galón (promedio de tramos consecutivos)
  costoTotal: number;
  costoPorKm: number | null;       // costo combustible / km recorridos (odómetro)
  costoPromedioDia: number | null;
  galonesTotal: number;
  nRegistros: number;
};

/**
 * Indicadores económicos de un vehículo en [desde, hasta]. El rendimiento km/gal
 * se calcula por tramos entre recargas consecutivas (igual criterio que
 * app/combustible). El costo/km usa el km recorrido REAL del odómetro en el
 * período (más honesto que el delta de kilometraje del propio combustible).
 */
export function indicadoresEconomicos(
  combustible: RegistroCombustible[],
  kmRecorridoPeriodo: number | null,
  desde: string,
  hasta: string
): IndicadoresEconomicos {
  const regs = combustible
    .filter((c) => c.fecha >= desde && c.fecha <= hasta)
    .sort((a, b) => Number(a.kilometraje) - Number(b.kilometraje));

  const costoTotal = regs.reduce((s, c) => s + Number(c.total || 0), 0);
  const galonesTotal = regs.reduce((s, c) => s + Number(c.galones || 0), 0);

  const rends: number[] = [];
  for (let i = 1; i < regs.length; i++) {
    const km = Number(regs[i].kilometraje) - Number(regs[i - 1].kilometraje);
    const gal = Number(regs[i].galones);
    if (km > 0 && gal > 0) rends.push(km / gal);
  }

  const nDias = Math.max(1, diasEntreFechas(desde, hasta) + 1);

  return {
    rendimientoKmGal: rends.length ? media(rends) : null,
    costoTotal: Math.round(costoTotal * 100) / 100,
    costoPorKm: kmRecorridoPeriodo && kmRecorridoPeriodo > 0 ? Math.round((costoTotal / kmRecorridoPeriodo) * 100) / 100 : null,
    costoPromedioDia: Math.round((costoTotal / nDias) * 100) / 100,
    galonesTotal: Math.round(galonesTotal * 100) / 100,
    nRegistros: regs.length,
  };
}

// ─── PIPELINE DE CONVENIENCIA ────────────────────────────────────────────────

/**
 * De lecturas crudas de UN vehículo a jornadas con anomalías anotadas, en un
 * solo paso. Devuelve también lo descartado (para el panel de auditoría).
 */
export function analizarVehiculo(
  lecturas: LecturaCruda[],
  opts: { kmTope?: number } = {}
): { dias: DiaRecorrido[]; descartadas: Descartada[]; rango: RangoEsperado } {
  const { limpias, descartadas } = sanearLecturas(lecturas, opts);
  const dias = recorridosDiarios(limpias);
  const rango = rangoEsperado(dias);
  anotarAnomalias(dias, rango);
  return { dias, descartadas, rango };
}
