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

import { seriesRendimiento, normalizarCantidad } from "@/lib/rendimiento";
import { familiaCombustible, configCombustible } from "@/lib/combustible-tipos";
import { tsEfectivoLectura, isoHoraVisible } from "@/lib/odometro-tiempo";

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
  created_at: string;            // timestamptz — hora de INSERCIÓN en el servidor
  capturado_en?: string | null;  // timestamptz — hora en que se TOMÓ la lectura (manda sobre created_at)
  momento?: string | null;       // checkin | checkout | null
  foto_url?: string | null;
};

/**
 * Hora efectiva de una lectura: cuándo se tomó (capturado_en); si no, cuándo se insertó, pero
 * SOLO si fue el mismo día de su `fecha` — si no, el final de su día (lib/odometro-tiempo.ts).
 */
function tsEfectivo(l: LecturaCruda): number {
  return tsEfectivoLectura(l);
}

/** Lectura ya saneada y anclada a su vehículo lógico (propia o tercero). */
export type LecturaSana = LecturaCruda & { key: string; esReinicio: boolean };

export type MotivoDescarte =
  | "no_aceptada"
  | "rechazada"
  | "invalida"
  | "absurda"
  | "retrocede"
  /**
   * Aceptada, pero MÁS ALTA que las lecturas que vinieron después: casi siempre una lectura
   * equivocada (dígito de más, foto de otra unidad). Queda fuera del recorrido para no borrar
   * todas las jornadas siguientes, y se NOMBRA: mientras siga aceptada infla el km vigente.
   */
  | "no_encaja"
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
  /**
   * ¿La hora sale de `capturado_en` (cuándo se TOMÓ) o de `created_at` (cuándo ENTRÓ al ERP)?
   * Sin la marca, una hora de inserción —que puede ir minutos u horas por detrás del momento
   * real— se lee como si fuera la hora del tablero, y con ella se juzgan retrocesos y jornadas.
   */
  primeraHoraExacta: boolean;
  ultimaHoraExacta: boolean;
  minutosOperacion: number | null;
  nLecturas: number;
  pendiente: boolean;            // true = solo 1 lectura → no se puede calcular
  reinicio: boolean;             // hubo un cambio de tablero ese día
  anomalias: Anomalia[];
  lecturas: LecturaSana[];       // lecturas saneadas de la jornada (para ver foto / corregir)
  /**
   * La lectura que CIERRA el salto imposible de la jornada (más km entre dos lecturas
   * consecutivas que los que la unidad puede hacer en un día). Sin esto la fila decía
   * "6,726 km · Revisar" y no señalaba cuál de las cinco lecturas era la mala: el operador
   * tenía que adivinarla, y si su foto quedaba fuera de las miniaturas ni siquiera la veía.
   */
  sospechosaId: string | null;
  /**
   * Lecturas ACEPTADAS de ese día que quedaron fuera del recorrido porque son más altas que las
   * posteriores (`no_encaja`). Viajan aparte de `lecturas` —no cuentan para primera/última ni
   * para `nLecturas`— pero se enseñan en la fila para poder corregirlas.
   */
  fueraDeSecuencia: LecturaCruda[];
};

export type TipoAnomalia =
  | "excesivo"
  | "bajo"
  | "retroceso"
  | "duplicada"
  | "no_encaja"
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
/** Tope km/día por defecto: el mismo 1500 de `evaluarLectura` y `config_mantenimiento.km_dia_max`. */
export const KM_DIA_MAX_DEFECTO = 1500;

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
 *   - retrocede (km por debajo de la secuencia y no es reinicio) → posible error/manipulación
 *   - no_encaja (km por ENCIMA de las lecturas posteriores) → casi siempre una lectura equivocada
 *
 * LA SECUENCIA ES LA CADENA COHERENTE MÁS LARGA, NO UN TRINQUETE. Antes se tomaba el km más alto
 * visto como base y se descartaba todo lo que viniera por debajo: UNA sola lectura alta equivocada
 * y aceptada —el 24,484 de la CWZ-371 del 12/09 (foto de otra unidad), o el que abrió la OT #6
 * «servicio de los 20 000 km»— borraba TODAS las jornadas siguientes como «retroceso», sin aviso:
 * «Sin jornadas en el filtro» con la unidad trabajando y leyendo odómetro cada día. Ahora se elige
 * la secuencia no decreciente con MÁS lecturas (y, entre las de igual largo, la que conserva las
 * más tempranas): la lectura aislada que contradice a todas las demás es la que sale.
 *
 * Cuando el trinquete ya daba la cadena más larga —todo historial sin una lectura alta suelta—,
 * el resultado es IDÉNTICO al de antes, lectura por lectura y con el mismo texto
 * (scripts/prueba-saneo-odometro.mts lo compara contra el algoritmo viejo copiado literal).
 */
export function sanearLecturas(
  lecturas: LecturaCruda[],
  opts: { kmTope?: number; soloAceptadas?: boolean } = {}
): { limpias: LecturaSana[]; descartadas: Descartada[] } {
  const kmTope = opts.kmTope && opts.kmTope > 0 ? opts.kmTope : KM_TOPE_ABSOLUTO;
  const soloAceptadas = opts.soloAceptadas !== false; // default true

  const ordenadas = [...(lecturas || [])].sort(ordenTemporal);
  const hoy = hoyLima();

  // Paso 1 · filtros por fila (no dependen de las demás). Lo que pasa es candidato a la secuencia.
  const veredicto: (Descartada | null)[] = new Array(ordenadas.length).fill(null);
  const candidatas: number[] = []; // índices en `ordenadas`
  ordenadas.forEach((l, i) => {
    const km = Number(l.km);
    if (l.estado === "rechazada" || l.estado === "anulada") {
      veredicto[i] = { lectura: l, motivo: "rechazada", detalle: l.estado === "anulada" ? "Lectura anulada" : "Lectura rechazada" };
    } else if (!Number.isFinite(km) || km <= 0) {
      veredicto[i] = { lectura: l, motivo: "invalida", detalle: "Kilometraje inválido o ≤ 0" };
    } else if (km > kmTope) {
      veredicto[i] = { lectura: l, motivo: "absurda", detalle: `Valor absurdo: ${km.toLocaleString("es-PE")} km` };
    } else if (l.fecha > hoy) {
      // Lectura del futuro (reloj adelantado): no debe mover el vigente ni la jornada.
      // (Solo se descartan las de fecha estrictamente posterior a hoy-Lima; el mismo día vale.)
      veredicto[i] = { lectura: l, motivo: "invalida", detalle: `Fecha futura (${l.fecha}) — revisar reloj del dispositivo` };
    } else if (l.estado !== "reinicio" && soloAceptadas && l.estado !== "aceptada") {
      veredicto[i] = { lectura: l, motivo: "no_aceptada", detalle: "Pendiente de revisión (no aceptada)" };
    } else {
      candidatas.push(i);
    }
  });

  // Paso 2 · la secuencia, por tramos. Un reinicio de tablero abre un tramo nuevo: se conserva
  // siempre y es el PISO de lo que sigue (aunque sea menor que lo anterior).
  const conserva = new Set<number>();
  const tramos: { piso: number; idx: number[] }[] = [{ piso: 0, idx: [] }];
  for (const i of candidatas) {
    if (ordenadas[i].estado === "reinicio") {
      conserva.add(i);
      tramos.push({ piso: Number(ordenadas[i].km), idx: [] });
    } else {
      tramos[tramos.length - 1].idx.push(i);
    }
  }
  for (const t of tramos) {
    const kms = t.idx.map((i) => Number(ordenadas[i].km));
    const sigue = cadenaMasLarga(kms, t.piso);
    t.idx.forEach((i, j) => { if (sigue[j]) conserva.add(i); });

    // Lo que no entró se clasifica contra la cadena: por debajo de lo ya conservado → retrocede
    // (mismo texto de siempre: el km frente a la base vigente en ese momento); por encima de lo
    // que vino después → no encaja. Una lectura que cabe entre sus vecinas nunca queda fuera:
    // la cadena es la más larga, así que la habría incluido.
    let base = t.piso;
    t.idx.forEach((i, j) => {
      const km = kms[j];
      if (sigue[j]) { if (km > base) base = km; return; }
      const l = ordenadas[i];
      if (km < base) {
        veredicto[i] = { lectura: l, motivo: "retrocede", detalle: `Retrocede: ${km.toLocaleString("es-PE")} < ${base.toLocaleString("es-PE")}` };
        return;
      }
      const posteriores = t.idx.slice(j + 1).filter((x, n) => sigue[j + 1 + n] && kms[j + 1 + n] < km);
      const sig = posteriores.length ? ordenadas[posteriores[0]] : null;
      veredicto[i] = {
        lectura: l,
        motivo: "no_encaja",
        detalle: sig
          ? `No encaja: ${km.toLocaleString("es-PE")} km es más que ${posteriores.length} lectura(s) posterior(es) — la siguiente, ${Number(sig.km).toLocaleString("es-PE")} km del ${sig.fecha.slice(8, 10)}/${sig.fecha.slice(5, 7)}/${sig.fecha.slice(0, 4)}. Probable lectura equivocada: anúlala o corrígela.`
          : `No encaja con la secuencia del odómetro (${km.toLocaleString("es-PE")} km). Probable lectura equivocada: anúlala o corrígela.`,
      };
    });
  }

  // Paso 3 · en orden temporal, como siempre.
  const limpias: LecturaSana[] = [];
  const descartadas: Descartada[] = [];
  ordenadas.forEach((l, i) => {
    // Los duplicados exactos (mismo km) se CONSERVAN: un bus parqueado con check-in y
    // check-out iguales es una jornada legítima de 0 km. La jornada los marca como anomalía
    // 'duplicada' en recorridosDiarios (no se descartan aquí para no romper ese caso).
    if (conserva.has(i)) limpias.push({ ...l, key: claveVehiculo(l), esReinicio: l.estado === "reinicio" });
    else if (veredicto[i]) descartadas.push(veredicto[i]!);
  });
  return { limpias, descartadas };
}

/**
 * La subsecuencia NO DECRECIENTE más larga de `kms` con todo ≥ `piso`; entre las de igual largo,
 * la lexicográficamente menor por posición (la que conserva las lecturas más tempranas). Esa
 * regla de desempate es la que hace que coincida con el trinquete de antes siempre que el
 * trinquete ya fuera óptimo: el trinquete toma, en cada paso, la lectura más temprana que no baja.
 * O(n log n): el largo de la mejor cadena que EMPIEZA en cada posición, con un árbol de Fenwick
 * de máximos sobre los km comprimidos, recorriendo de derecha a izquierda.
 */
function cadenaMasLarga(kms: number[], piso: number): boolean[] {
  const n = kms.length;
  const sigue = new Array<boolean>(n).fill(false);
  if (!n) return sigue;
  const valores = [...new Set(kms)].sort((a, b) => a - b);
  const m = valores.length;
  // Rango invertido: el km más alto va primero, así «km ≥ x» es un prefijo del árbol.
  const rango = (km: number) => m - lowerBound(valores, km); // 1..m
  const arbol = new Array<number>(m + 1).fill(0);
  const consultar = (r: number) => { let s = 0; for (; r > 0; r -= r & -r) s = Math.max(s, arbol[r]); return s; };
  const actualizar = (r: number, v: number) => { for (; r <= m; r += r & -r) arbol[r] = Math.max(arbol[r], v); };

  const largo = new Array<number>(n).fill(0); // mejor cadena que empieza en i
  for (let i = n - 1; i >= 0; i--) {
    if (kms[i] < piso) continue;
    const r = rango(kms[i]);
    largo[i] = 1 + consultar(r);
    actualizar(r, largo[i]);
  }
  let falta = Math.max(0, ...largo);
  let ultimo = piso;
  for (let i = 0; i < n && falta > 0; i++) {
    if (kms[i] >= ultimo && largo[i] === falta) {
      sigue[i] = true;
      ultimo = kms[i];
      falta--;
    }
  }
  return sigue;
}

function lowerBound(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Orden temporal estable: por fecha (día) y luego por hora efectiva de captura. */
function ordenTemporal(a: LecturaCruda, b: LecturaCruda): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  return tsEfectivo(a) - tsEfectivo(b);
}

// ─── RECORRIDO POR JORNADA ───────────────────────────────────────────────────

/**
 * Agrupa las lecturas saneadas de UN vehículo por día y calcula el recorrido de
 * cada jornada (última − primera). Detecta duplicados exactos consecutivos y
 * retrocesos internos residuales. NO decide "excesivo/bajo": eso depende del
 * histórico y se resuelve en `anotarAnomalias`.
 */
export function recorridosDiarios(limpias: LecturaSana[], kmDiaMax = KM_DIA_MAX_DEFECTO): DiaRecorrido[] {
  const porDia = new Map<string, LecturaSana[]>();
  for (const l of limpias) {
    (porDia.get(l.fecha) ?? porDia.set(l.fecha, []).get(l.fecha)!).push(l);
  }

  const dias: DiaRecorrido[] = [];
  for (const [fecha, lects] of porDia) {
    const orden = [...lects].sort(ordenTemporal);
    const anomalias: Anomalia[] = [];

    // La secuencia ya viene saneada y es monótona en km, así que la primera/última por HORA
    // coinciden con el km menor/mayor del día: primera = orden[0], última = orden[último].
    // (No se re-ancla por 'momento' para no colapsar la jornada cuando falta el check-out).
    const primera = orden[0];
    const ultima = orden[orden.length - 1];
    const hayReinicio = orden.some((l) => l.esReinicio);
    // Los roles solo se usan para etiquetar la hora y para detectar horas incoherentes.
    const checkin = orden.find((l) => l.momento === "checkin");
    const checkouts = orden.filter((l) => l.momento === "checkout");
    const checkout = checkouts.length ? checkouts[checkouts.length - 1] : undefined;

    // Check-out con hora de CAPTURA anterior al check-in → reloj o carga desordenada. Solo se
    // avisa cuando AMBOS traen capturado_en (comparar created_at de inserción daría falsos).
    if (checkin && checkout && checkin.capturado_en && checkout.capturado_en && tsEfectivo(checkout) < tsEfectivo(checkin)) {
      anomalias.push({
        tipo: "retroceso",
        severidad: "critico",
        mensaje: "El check-out quedó registrado antes que el check-in — revisar horas",
      });
    }

    // Duplicados exactos consecutivos (mismo km) → verificar (no se descarta).
    for (let i = 1; i < orden.length; i++) {
      if (Number(orden[i].km) === Number(orden[i - 1].km)) {
        const mismaFoto = !!orden[i].foto_url && orden[i].foto_url === orden[i - 1].foto_url;
        anomalias.push({
          tipo: "duplicada",
          severidad: mismaFoto ? "advertencia" : "info",
          mensaje: mismaFoto
            ? `Lecturas iguales con la MISMA foto (${Number(orden[i].km).toLocaleString("es-PE")} km) — probable duplicado/reenvío`
            : `Lecturas iguales (${Number(orden[i].km).toLocaleString("es-PE")} km) — ¿unidad detenida o duplicado?`,
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

    // Salto imposible DENTRO de la jornada. No depende del patrón histórico (que `anotarAnomalias`
    // solo usa con muestra suficiente): más km entre dos lecturas del mismo día que el tope
    // diario es físicamente imposible, así que una de las dos está mal leída. Se señala la que
    // CIERRA el salto —la que lo introduce en la cadena— y el mensaje nombra las dos, porque
    // el error también puede estar en la primera: decide quien mira las dos fotos.
    let sospechosaId: string | null = null;
    if (!hayReinicio) {
      let peor = 0, iPeor = -1;
      for (let i = 1; i < orden.length; i++) {
        const salto = Number(orden[i].km) - Number(orden[i - 1].km);
        if (salto > peor) { peor = salto; iPeor = i; }
      }
      if (iPeor > 0 && peor > kmDiaMax) {
        const a = orden[iPeor - 1], b = orden[iPeor];
        const h = (l: LecturaSana) => horaLima(isoHoraVisible(l)) ?? "sin hora";
        sospechosaId = b.id;
        anomalias.push({
          tipo: "excesivo",
          severidad: "critico",
          mensaje: `Salto imposible: de ${Number(a.km).toLocaleString("es-PE")} km (${h(a)}) a ${Number(b.km).toLocaleString("es-PE")} km (${h(b)}) = +${peor.toLocaleString("es-PE")} km, más que el máximo diario (${kmDiaMax.toLocaleString("es-PE")} km). Una de las dos lecturas está mal: revisa su foto y corrígela.`,
        });
      }
    }

    // Hora: se prefiere el rol (check-in/check-out) para etiquetar; si no, la primera/última.
    const horaIni = checkin ?? primera;
    const horaFin = checkout ?? ultima;
    const primeraHora = horaLima(isoHoraVisible(horaIni));
    const ultimaHora = horaLima(isoHoraVisible(horaFin));
    const minutosOperacion =
      orden.length >= 2
        ? Math.max(0, Math.round((tsEfectivo(ultima) - tsEfectivo(primera)) / 60000))
        : null;

    dias.push({
      key: primera.key,
      fecha,
      primeraKm: Number(primera.km),
      ultimaKm: Number(ultima.km),
      recorrido,
      primeraHora,
      ultimaHora,
      primeraHoraExacta: !!horaIni.capturado_en,
      ultimaHoraExacta: !!horaFin.capturado_en,
      minutosOperacion,
      nLecturas: orden.length,
      pendiente,
      reinicio: hayReinicio,
      anomalias,
      lecturas: orden,
      sospechosaId,
      fueraDeSecuencia: [],
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
    // El salto imposible ya se anotó con la lectura que lo causa: repetirlo como "fuera del
    // patrón" serían dos rojos para el mismo hecho, y el genérico no nombra a nadie.
    if (d.sospechosaId) continue;

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
  rendimientoKmGal: number | null; // MEDIANA de los tramos de la familia principal (lib/rendimiento.ts)
  rendimientoLabel: string;        // "km/gal" | "km/m³" — una unidad de GNV no rinde en galones
  rendimientoFamilia: string | null;
  rendimientoTramos: number;       // sobre cuántos tramos se midió: 2 tramos no son un patrón
  costoTotal: number;
  costoPorKm: number | null;       // costo combustible / km recorridos (odómetro)
  costoPromedioDia: number | null;
  /**
   * Cantidad cargada POR FAMILIA, cada una en SU unidad. Era un `galonesTotal: number` que
   * sumaba `galones` a secas: en una unidad de GNV eso son metros cúbicos, y en una fila del
   * Radar pueden ser litros — tres magnitudes distintas apiladas y publicadas como "gal".
   * Lo único agregable entre combustibles es `costoTotal`.
   */
  cantidadPorFamilia: { familia: string; cantidad: number; unidadLabel: string }[];
  nRegistros: number;
};

/**
 * Indicadores económicos de un vehículo en [desde, hasta].
 *
 * El rendimiento sale de lib/rendimiento.ts, la regla ÚNICA del ERP. El bucle que vivía aquí
 * era la tercera copia de la fórmula y arrastraba dos defectos: usaba la media (que un tanque
 * a medio llenar mueve) y **no segmentaba por tipo de combustible**, así que una carga de
 * diésel seguida de una de urea producía un tramo falso con los LITROS DE UREA como
 * denominador de los km de diésel.
 *
 * El costo/km NO se toca: ya usa el km recorrido REAL del odómetro en el período, que es más
 * honesto que el delta de kilometraje del propio combustible, y es la definición única del ERP.
 */
export function indicadoresEconomicos(
  combustible: RegistroCombustible[],
  kmRecorridoPeriodo: number | null,
  desde: string,
  hasta: string
): IndicadoresEconomicos {
  const regs = combustible
    .filter((c) => c.fecha >= desde && c.fecha <= hasta)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  const costoTotal = regs.reduce((s, c) => s + Number(c.total || 0), 0);
  // Por familia y normalizada a su unidad: la que no se sabe convertir no se suma a ninguna.
  const porFamilia = new Map<string, number>();
  for (const c of regs) {
    const fam = familiaCombustible(c.tipo_combustible);
    const q = normalizarCantidad(c.galones, (c as any).unidad, fam);
    if (q != null) porFamilia.set(fam, (porFamilia.get(fam) ?? 0) + q);
  }

  // La familia con más cargas manda: un bimodal tiene DOS rendimientos y promediarlos daría
  // un número que no es de ninguno de los dos.
  const series = seriesRendimiento(
    regs.map((c, i) => ({
      id: i + 1,
      unidad: String(c.vehiculo_id ?? "u"),
      fecha: String(c.fecha).slice(0, 10),
      kilometraje: c.kilometraje,
      cantidad: c.galones,
      unidadCantidad: (c as any).unidad ?? null,
      tipo: c.tipo_combustible,
    }))
  );
  const principal = [...series.values()]
    .filter((s) => s.resumen.n > 0)
    .sort((a, b) => b.resumen.n - a.resumen.n)[0] ?? null;

  const nDias = Math.max(1, diasEntreFechas(desde, hasta) + 1);

  return {
    rendimientoKmGal: principal?.resumen.mediana ?? null,
    rendimientoLabel: principal?.resumen.label ?? "km/gal",
    rendimientoFamilia: principal?.resumen.familia ?? null,
    rendimientoTramos: principal?.resumen.n ?? 0,
    costoTotal: Math.round(costoTotal * 100) / 100,
    costoPorKm: kmRecorridoPeriodo && kmRecorridoPeriodo > 0 ? Math.round((costoTotal / kmRecorridoPeriodo) * 100) / 100 : null,
    costoPromedioDia: Math.round((costoTotal / nDias) * 100) / 100,
    cantidadPorFamilia: [...porFamilia.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([familia, cantidad]) => ({
        familia,
        cantidad: Math.round(cantidad * 100) / 100,
        unidadLabel: configCombustible(familia).unidadLabel,
      })),
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
  opts: { kmTope?: number; kmDiaMax?: number } = {}
): { dias: DiaRecorrido[]; descartadas: Descartada[]; rango: RangoEsperado } {
  const { limpias, descartadas } = sanearLecturas(lecturas, opts);
  const dias = recorridosDiarios(limpias, opts.kmDiaMax && opts.kmDiaMax > 0 ? opts.kmDiaMax : KM_DIA_MAX_DEFECTO);
  const rango = rangoEsperado(dias);
  anotarAnomalias(dias, rango);
  // La lectura que no encaja se cuelga de SU jornada: quedó fuera del recorrido, pero la fila
  // tiene que enseñarla para poder corregirla. (Si ese día no le queda ninguna otra lectura, no
  // hay jornada que la lleve: la pantalla la lista aparte, desde `descartadas`.)
  const porFecha = new Map(dias.map((d) => [d.fecha, d]));
  for (const x of descartadas) {
    if (x.motivo !== "no_encaja") continue;
    const d = porFecha.get(x.lectura.fecha);
    if (!d) continue;
    d.fueraDeSecuencia.push(x.lectura);
    d.anomalias.push({ tipo: "no_encaja", severidad: "critico", mensaje: x.detalle });
  }
  return { dias, descartadas, rango };
}
