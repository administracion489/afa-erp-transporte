// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/desfase-factura.ts — Motor PURO: cuántos días después del DESPACHO emite el
// grifo su factura, MEDIDO sobre lo ya conciliado, y qué fecha de despacho le toca a una línea
// que no la trae. No lee la base.
//
// LO REPORTADO: «las facturas de COESTI llegan 1 día después del despacho». La factura
// electrónica NO TRAE la fecha del despacho: el XML de COESTI solo lleva IssueDate e IssueTime
// (F882-0132184: emitida el 04/10 a las 03:18 por un despacho del 03/10 a las 21:55; la línea
// trae la placa y el producto, ninguna fecha). Así que una factura de UNA línea se registraba
// con la fecha de EMISIÓN (`completarConDocumento`): un día corrida en el historial, en el mes de
// v_egresos cuando el despacho fue el último día del mes, y en el orden de la cadena de
// rendimiento de la unidad.
//
// POR QUÉ SE MIDE Y NO SE SUPONE. COESTI no factura siempre a la misma hora: las de la madrugada
// (03:18, 03:21) juntan el día anterior, y hay otras emitidas a media tarde (16:45) que pueden
// ser del mismo día. Ni siquiera la hora del XML sirve sola: IssueTime viene en 12 horas y sin
// AM/PM («04:45:14» era las 4:45 PM). Un «menos un día» fijo acertaría en unas y movería mal las
// otras sin que nadie lo viera. La evidencia que el ERP SÍ tiene: las recargas que el RADAR leyó
// del voucher —con la fecha impresa en el papel— y que después casaron con su factura. Esa
// diferencia, contada, ES el patrón. Si COESTI cambia su forma de facturar, la medición cambia
// sola, que es lo que se pidió («que se autocambie si detecta ese cruce de información»).
//
// CUÁNDO SE APLICA, y no se puede aflojar:
//   • SOLO a una fecha DEDUCIDA de la emisión (la única línea de combustible de la factura, sin
//     fecha propia). La fecha que trae la línea y la que eligió una persona NO se tocan: el papel
//     y la persona mandan.
//   • AUTOMÁTICO si la medición es sólida —al menos MIN_MUESTRAS_DESFASE muestras y un desfase
//     que reúne MIN_ACUERDO_DESFASE de ellas—. Si no, no se mueve nada y se DICE por qué.
//   • FIJO si una persona lo configuró (`combustible_cuentas.facturas_desfase_dias`, migración
//     combustible-04; 0 = la fecha de emisión tal cual). Sin la migración, automático.
//
// LOS UMBRALES NO ESTÁN MEDIDOS Y SE DECLARAN (MIN_MUESTRAS_DESFASE, MIN_ACUERDO_DESFASE,
// MAX_DESFASE). El lado seguro es SUBIRLOS: más altos, el ERP simplemente deja la fecha de
// emisión, que es lo que hacía siempre.
// ──────────────────────────────────────────────────────────────────────────────

import { MARCA_CARGA_DE_FACTURA } from "@/lib/combustible/factura-lineas";

/** Más de esto no es un desfase de facturación: es otra carga. No medido, declarado. */
export const MAX_DESFASE = 3;
/** Con menos muestras no se decide nada solo. No medido, declarado. */
export const MIN_MUESTRAS_DESFASE = 8;
/** Parte de las muestras que tiene que reunir el desfase dominante. No medido, declarado. */
export const MIN_ACUERDO_DESFASE = 0.8;

/** De dónde salió la fecha de una línea de factura. */
export type OrigenFecha = "linea" | "emision" | "manual";

/**
 * ¿La registró el RADAR? Las dos puertas del Radar firman igual («Radar IA · grupo · remitente» en
 * el auto-registro, «Radar IA (manual…)» desde el panel de revisión), y su fecha es la que el Radar
 * leyó del VOUCHER: es la única evidencia independiente de cuándo fue el despacho. Una carga que
 * registró una factura lleva la emisión (mediría el desfase contra sí misma), y una tecleada a mano
 * pudo teclearse desde la factura.
 */
export const esCargaDelRadar = (observaciones?: string | null): boolean =>
  /^\s*Radar IA\b/.test(String(observaciones ?? ""));

const T = (f: string) => Date.parse(`${f.slice(0, 10)}T12:00:00Z`);

/** `f` ± `n` días (YYYY-MM-DD). */
export function sumarDias(f: string, n: number): string {
  const t = T(f);
  return Number.isFinite(t) ? new Date(t + n * 86_400_000).toISOString().slice(0, 10) : f;
}

/** Días de `desde` a `hasta`, CON signo (hasta − desde). */
export function diasEntre(desde: string, hasta: string): number {
  const a = T(desde), b = T(hasta);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : Number.NaN;
}

/**
 * De dónde salió la fecha de una línea guardada. Las leídas antes de que existiera `fecha_origen`
 * se infieren con la MISMA condición con que `completarConDocumento` la pone: la única línea de
 * combustible de la factura, con la fecha de emisión. Escribir con una regla y leer con otra es el
 * error que este repo ya pagó varias veces.
 */
export function origenFechaLinea(
  l: { fecha?: string | null; fecha_origen?: OrigenFecha | null },
  fechaEmision: string | null | undefined,
  lineasDeCombustible: number
): OrigenFecha | null {
  if (!l.fecha) return null;
  if (l.fecha_origen === "linea" || l.fecha_origen === "emision" || l.fecha_origen === "manual") return l.fecha_origen;
  return lineasDeCombustible === 1 && !!fechaEmision && l.fecha === fechaEmision ? "emision" : "linea";
}

// ── 1) La medición ───────────────────────────────────────────────────────────

export type MedicionDesfase = {
  /** Muestras que votan: diferencias de 0 a MAX_DESFASE días. */
  muestras: number;
  /** Cuántas cayeron en cada desfase: histograma[k] = días de diferencia k. */
  histograma: number[];
  dominante: number | null;
  /** Parte de las muestras que reúne el dominante (0..1). */
  acuerdo: number | null;
  /** Diferencias imposibles (despacho DESPUÉS de la factura) o más lejos que MAX_DESFASE: no votan. */
  fuera: number;
};

/**
 * `diferencias` = emisión − despacho, en días, de cada carga del Radar que casó con su factura. El
 * dominante es el más frecuente; a igualdad, el MENOR (mueve menos: el lado seguro).
 */
export function medirDesfase(diferencias: readonly number[]): MedicionDesfase {
  const histograma = Array.from({ length: MAX_DESFASE + 1 }, () => 0);
  let fuera = 0;
  for (const d of diferencias ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > MAX_DESFASE) { fuera++; continue; }
    histograma[d]++;
  }
  const muestras = histograma.reduce((a, b) => a + b, 0);
  if (!muestras) return { muestras: 0, histograma, dominante: null, acuerdo: null, fuera };
  let dominante = 0;
  for (let k = 1; k <= MAX_DESFASE; k++) if (histograma[k] > histograma[dominante]) dominante = k;
  return { muestras, histograma, dominante, acuerdo: histograma[dominante] / muestras, fuera };
}

const diasTexto = (k: number) => (k === 0 ? "el mismo día" : k === 1 ? "1 día después" : `${k} días después`);

/** La evidencia en una frase: cuántas, y cómo se reparten. */
export function textoMedicion(m: MedicionDesfase): string {
  if (!m.muestras) {
    return `todavía no hay recargas del Radar conciliadas con su factura${m.fuera ? ` (${m.fuera} fuera de rango)` : ""}`;
  }
  const cuando = (k: number) => (k === 0 ? "el mismo día" : k === 1 ? "al día siguiente" : `${k} días después`);
  const partes = m.histograma
    .map((n, k) => ({ n, k }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.k - b.k)
    .map((x) => `${x.n} se ${x.n === 1 ? "facturó" : "facturaron"} ${cuando(x.k)}`);
  return `medido en ${m.muestras} recarga(s) del Radar conciliadas con su factura: ${partes.join(", ")}` +
    (m.fuera ? ` (${m.fuera} fuera de rango, no cuentan)` : "");
}

// ── 2) La decisión ───────────────────────────────────────────────────────────

/** Los cinco motivos, cada uno con su arreglo en otro sitio: la pantalla enruta por código. */
export type CodigoDesfase =
  | "fijo"                // una persona lo configuró
  | "medido"              // automático, con un desfase sólido > 0
  | "medido_sin_desfase"  // automático: la factura sale el mismo día
  | "pocos_datos"         // automático, sin evidencia suficiente → la emisión, como siempre
  | "disperso";           // automático, el desfase no es constante → la emisión, como siempre

export type DecisionDesfase = {
  /** Días que se le restan a una fecha deducida de la emisión. */
  dias: number;
  codigo: CodigoDesfase;
  /** Lo configurado (null = automático). */
  configurado: number | null;
  medicion: MedicionDesfase;
  /** Frase para la pantalla: qué se hace y con qué evidencia. */
  detalle: string;
};

/** Un valor desconocido cae a AUTOMÁTICO, nunca a un desfase inventado. */
export function normalizarDesfaseConfig(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DESFASE ? n : null;
}

export function decidirDesfase(configurado: unknown, m: MedicionDesfase): DecisionDesfase {
  const conf = normalizarDesfaseConfig(configurado);
  const evidencia = textoMedicion(m);
  if (conf != null) {
    return {
      dias: conf, codigo: "fijo", configurado: conf, medicion: m,
      detalle: conf === 0
        ? `Configurado: la carga lleva la fecha de EMISIÓN de la factura. (${evidencia}.)`
        : `Configurado: el despacho es ${conf} día(s) antes de la emisión. (${evidencia}.)`,
    };
  }
  const base = { configurado: null, medicion: m };
  if (m.muestras < MIN_MUESTRAS_DESFASE) {
    return {
      ...base, dias: 0, codigo: "pocos_datos",
      detalle: `Automático, todavía sin decidir: ${evidencia} (hacen falta ${MIN_MUESTRAS_DESFASE}). Mientras tanto la carga lleva la fecha de emisión.`,
    };
  }
  if ((m.acuerdo ?? 0) < MIN_ACUERDO_DESFASE) {
    return {
      ...base, dias: 0, codigo: "disperso",
      detalle: `Automático: el desfase NO es constante (${evidencia}). Correr todas las fechas movería mal a las demás, así que la carga lleva la fecha de emisión.`,
    };
  }
  if (m.dominante === 0) {
    return { ...base, dias: 0, codigo: "medido_sin_desfase", detalle: `Automático: la factura sale el mismo día del despacho (${evidencia}).` };
  }
  return {
    ...base, dias: m.dominante!, codigo: "medido",
    detalle: `Automático: la factura sale ${diasTexto(m.dominante!)} del despacho (${evidencia}). Una carga registrada desde una factura de una sola línea lleva la emisión − ${m.dominante} día(s).`,
  };
}

/** La fecha de DESPACHO: la de emisión menos el desfase, y SOLO si la fecha salió de la emisión. */
export function fechaDeDespacho(fecha: string | null | undefined, origen: OrigenFecha | null, dias: number): string | null {
  if (!fecha) return null;
  if (origen !== "emision" || !Number.isInteger(dias) || dias <= 0) return fecha;
  return sumarDias(fecha, -dias);
}

type LineaConFecha = { n: number; fecha?: string | null; fecha_origen?: OrigenFecha | null; tipo_combustible?: string | null };

/**
 * Las líneas de una factura con la fecha con que se JUZGAN: la del despacho. Es el único sitio donde
 * se decide (lo usa la conciliación, lib/combustible/facturas-correo.ts, y lo prueba la matriz):
 *   • el origen se mira en la línea TAL COMO SE LEYÓ, antes de cualquier cambio;
 *   • la fecha que una persona eligió al confirmar (`manual.fecha`) es `manual` y no se corre;
 *   • `fecha_alterna` lleva la fecha de antes de correrla: el cruce la busca también.
 */
export function lineasAlDespacho<L extends LineaConFecha>(
  lineas: readonly L[],
  fechaEmision: string | null,
  dias: number,
  manual?: { n: number; fecha?: string | null } | null
): { lineas: (L & { fecha: string | null; fecha_alterna: string | null })[]; origen: Map<number, OrigenFecha | null> } {
  const nComb = lineas.filter((l) => l.tipo_combustible).length;
  const origen = new Map<number, OrigenFecha | null>();
  const out = lineas.map((l) => {
    const esManual = !!manual && manual.n === l.n && !!manual.fecha;
    const o: OrigenFecha | null = esManual ? "manual" : origenFechaLinea(l, fechaEmision, nComb);
    origen.set(l.n, o);
    const base = esManual ? manual!.fecha! : (l.fecha ?? null);
    const fecha = fechaDeDespacho(base, o, dias);
    return { ...l, fecha, fecha_alterna: fecha !== base ? base : null };
  });
  return { lineas: out, origen };
}

/** Lo que se le agrega a `observaciones` de una carga fechada por el desfase: por qué no es la de la factura. */
export function notaFechaDespacho(fechaEmision: string, dias: number): string {
  return `Fecha del despacho: emitida el ${fechaEmision.split("-").reverse().join("/")}, ${dias} día(s) antes`;
}

// ── 3) Las cargas que ya se registraron con la fecha de EMISIÓN ──────────────

export type FacturaRegistrada = {
  factura_id: number;
  serie: string | null;
  numero: string | null;
  fecha_emision: string | null;
  lineas: { n: number; fecha?: string | null; fecha_origen?: OrigenFecha | null; tipo_combustible?: string | null }[];
  conciliacion: { n: number; codigo?: string; combustible_id?: number | string | null; casa_con?: number | string | null; fecha_origen?: OrigenFecha | null }[];
};

export type CargaActual = { id: number; fecha: string; observaciones: string | null; total: number | null; placa: string | null };

export type CargaPorMover = {
  combustible_id: number;
  factura_id: number;
  comprobante: string;
  fecha_emision: string;
  /** La fecha que tiene hoy (= la de emisión). */
  desde: string;
  /** La del despacho. */
  hacia: string;
  total: number | null;
  placa: string | null;
  /** Pasa a otro mes: cambia el mes del gasto en Finanzas. */
  cruza_mes: boolean;
  /** Las de hoy, para agregarles por qué cambió la fecha. */
  observaciones: string | null;
};

/**
 * Las cargas que registró una factura con la fecha de EMISIÓN y que, con el desfase decidido,
 * tendrían que llevar la del despacho. Las cuatro condiciones, y hacen falta las cuatro:
 *   1. la registró ESA factura —su `observaciones` dice «Registrada desde la factura <serie-número>»—;
 *   2. su fecha salió de la emisión (no la traía la línea ni la eligió una persona);
 *   3. hoy lleva EXACTAMENTE la fecha de emisión: si alguien ya la cambió, esa persona decidió;
 *   4. el desfase decidido es mayor que cero.
 * Una carga que se borró no está en `cargas` y no se propone.
 */
export function cargasPorMover(
  facturas: readonly FacturaRegistrada[],
  cargas: ReadonlyMap<number, CargaActual>,
  dias: number
): CargaPorMover[] {
  if (!Number.isInteger(dias) || dias <= 0) return [];
  const out: CargaPorMover[] = [];
  const vistas = new Set<number>();
  for (const f of facturas ?? []) {
    if (!f.fecha_emision) continue;
    const lineas = Array.isArray(f.lineas) ? f.lineas : [];
    const conc = Array.isArray(f.conciliacion) ? f.conciliacion : [];
    const nComb = lineas.filter((l) => l.tipo_combustible).length;
    const comprobante = `${f.serie ?? ""}-${f.numero ?? ""}`;
    const marca = `${MARCA_CARGA_DE_FACTURA} ${comprobante}`;
    for (const c of conc) {
      const id = Number(c.codigo === "registrar" ? c.combustible_id : c.codigo === "ya_registrada" ? c.casa_con : NaN);
      if (!Number.isFinite(id) || vistas.has(id)) continue;
      const l = lineas.find((x) => x.n === c.n);
      if (!l) continue;
      const origen = c.fecha_origen ?? origenFechaLinea(l, f.fecha_emision, nComb);
      if (origen !== "emision") continue;
      const carga = cargas.get(id);
      if (!carga || !String(carga.observaciones ?? "").includes(marca)) continue;
      if (carga.fecha !== f.fecha_emision) continue;
      const hacia = sumarDias(f.fecha_emision, -dias);
      vistas.add(id);
      out.push({
        combustible_id: id, factura_id: f.factura_id, comprobante, fecha_emision: f.fecha_emision,
        desde: carga.fecha, hacia, total: carga.total, placa: carga.placa,
        cruza_mes: hacia.slice(0, 7) !== carga.fecha.slice(0, 7),
        observaciones: carga.observaciones,
      });
    }
  }
  return out.sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : a.combustible_id - b.combustible_id));
}

export type ResumenMover = { cargas: number; total: number; desde: string | null; hasta: string | null; cruzan_mes: number };

export function resumenMover(xs: readonly CargaPorMover[]): ResumenMover {
  const total = Math.round(xs.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100;
  const fechas = xs.map((x) => x.desde).sort();
  return { cargas: xs.length, total, desde: fechas[0] ?? null, hasta: fechas[fechas.length - 1] ?? null, cruzan_mes: xs.filter((x) => x.cruza_mes).length };
}
