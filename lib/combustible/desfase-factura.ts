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
//
// LO QUE MOSTRARON LAS 35 FACTURAS DE COESTI DEL 23/07 AL 04/10, una por una con su constancia
// de SUNAT (la CDR que viene en el mismo correo):
//   • 32 se generaron la MISMA madrugada de su fecha de emisión (casi todas entre 03:16 y 05:27):
//     un lote nocturno que factura lo despachado el día anterior. De ahí el «1 día después».
//   • 3 llevan la fecha del ÚLTIMO día del mes (31/07, 31/08, 30/09) y se generaron el día 1 del
//     mes siguiente: el cierre de mes las fecha hacia atrás, y pueden juntar varios días. Una
//     factura así (`generadaDespues`: su correo llegó un día POSTERIOR a su fecha) no vota en la
//     medición y su fecha NO se corre: el desfase del lote nocturno no la describe.
//   • 10 traen 2 o 3 cargas (CONSOLIDADAS) y ninguna línea trae su fecha. Antes quedaban todas en
//     «revisar · sin fecha»; ahora se fechan solas cuando su PROPIA medición dice que cada factura
//     junta UN solo día (`decidirConsolidadas`). Si no, se confirman a mano, como antes.
//
// LA MEDICIÓN ES UN CRUCE INDEPENDIENTE (`muestrasDesfase`): cada línea de factura contra los
// vouchers que leyó el Radar —misma placa, mismo importe, de MAX_DESFASE días antes de la emisión
// al día siguiente—, y solo cuenta el cruce ÚNICO. Antes se medía sobre los enlaces que dejó la
// conciliación, que buscaba ±1 día alrededor de la emisión: un desfase de 2 no podía aparecer
// nunca, y las consolidadas, que no tenían fecha con qué buscar, no daban ninguna muestra.
// ──────────────────────────────────────────────────────────────────────────────

import { MARCA_CARGA_DE_FACTURA, TOLERANCIA_CANTIDAD, TOLERANCIA_MONTO, normPlaca, esCargaFusionada } from "@/lib/combustible/factura-lineas";

/** Más de esto no es un desfase de facturación: es otra carga. No medido, declarado. */
export const MAX_DESFASE = 3;
/** Con menos muestras no se decide nada solo. No medido, declarado. */
export const MIN_MUESTRAS_DESFASE = 8;
/** Parte de las muestras que tiene que reunir el desfase dominante. No medido, declarado. */
export const MIN_ACUERDO_DESFASE = 0.8;

/**
 * De dónde salió la fecha de una línea de factura. `consolidada` es la que se deduce para una línea
 * de una factura de VARIAS cargas (decidirConsolidadas): se distingue de `emision` porque la mueve
 * otra medición, y «Moverlas a la fecha del despacho» (cargasPorMover) solo corrige las `emision`.
 */
export type OrigenFecha = "linea" | "emision" | "manual" | "consolidada";

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
  if (l.fecha_origen === "linea" || l.fecha_origen === "emision" || l.fecha_origen === "manual" || l.fecha_origen === "consolidada") return l.fecha_origen;
  return lineasDeCombustible === 1 && !!fechaEmision && l.fecha === fechaEmision ? "emision" : "linea";
}

/** El día (Lima, UTC−5) de un instante ISO. */
export function diaLima(iso: string | null | undefined): string | null {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? new Date(t - 5 * 3600_000).toISOString().slice(0, 10) : null;
}

/**
 * ¿La factura se generó DESPUÉS de su propia fecha? Su correo llegó un día (Lima) posterior a la
 * fecha de emisión. Es el cierre de mes de COESTI: F882-0130996 dice 30/09 y SUNAT la recibió el
 * 01/10 a las 16:47 (lo mismo el 31/07 y el 31/08). Una factura así no es del lote nocturno: no
 * vota en la medición, su fecha no se corre y, si junta varias cargas, no se fecha sola —puede
 * juntar varios días—. Un correo que llega tarde por otra razón cae del mismo lado: la fecha de
 * emisión, que es lo que el ERP hacía siempre. Sin dato, no se afirma nada (false).
 */
export function generadaDespues(fechaEmision: string | null | undefined, recibidoEn: string | null | undefined): boolean {
  const dia = diaLima(recibidoEn);
  return !!fechaEmision && !!dia && dia > String(fechaEmision).slice(0, 10);
}

// ── 0) El cruce: cada línea de factura contra los vouchers del Radar ─────────

/** Un despacho que leyó el RADAR: su fecha es la impresa en el voucher. */
export type VoucherRadar = { placa: string | null; fecha: string | null; total: number | null; cantidad?: number | null };

export type FacturaParaMedir = {
  fecha_emision: string | null;
  recibido_en?: string | null;
  lineas: {
    n: number; placa?: string | null; total?: number | null; cantidad?: number | null;
    tipo_combustible?: string | null; fecha?: string | null; fecha_origen?: OrigenFecha | null;
  }[];
};

export type MuestrasDesfase = {
  /** Diferencias emisión − despacho de las facturas de UNA línea de combustible. */
  una: number[];
  /** Las de las facturas de VARIAS (consolidadas). */
  consolidada: number[];
  /** Facturas que no votan por generarse después de su fecha (cierre de mes). */
  tardias: number;
};

/**
 * Las muestras del desfase. Una línea (con placa e importe, y sin fecha propia: el desfase es para
 * las que no la traen) cuenta solo si casa con UN voucher del Radar —misma placa, importe a menos de
 * TOLERANCIA_MONTO, fecha de emisión − MAX_DESFASE a emisión + 1—; con dos, desempata la cantidad, y
 * si sigue habiendo dos no cuenta. Un voucher que casa con dos líneas tampoco cuenta: no se sabe de
 * cuál es. Las facturas generadas después de su fecha no votan (`generadaDespues`).
 */
export function muestrasDesfase(facturas: readonly FacturaParaMedir[], vouchers: readonly VoucherRadar[]): MuestrasDesfase {
  const vs = (vouchers ?? [])
    .map((v) => ({ placa: normPlaca(v.placa), fecha: v.fecha ? String(v.fecha).slice(0, 10) : "", total: v.total == null ? NaN : Number(v.total), cantidad: v.cantidad == null ? NaN : Number(v.cantidad) }))
    .filter((v) => v.placa && v.fecha && Number.isFinite(v.total));
  const porPlaca = new Map<string, number[]>();
  vs.forEach((v, i) => porPlaca.set(v.placa, [...(porPlaca.get(v.placa) ?? []), i]));
  const pares: { tipo: "una" | "consolidada"; v: number; d: number }[] = [];
  let tardias = 0;
  for (const f of facturas ?? []) {
    const emision = f.fecha_emision ? String(f.fecha_emision).slice(0, 10) : null;
    if (!emision) continue;
    if (generadaDespues(emision, f.recibido_en)) { tardias++; continue; }
    const lineas = Array.isArray(f.lineas) ? f.lineas : [];
    const comb = lineas.filter((l) => l.tipo_combustible);
    const tipo = comb.length === 1 ? "una" : "consolidada";
    const desde = sumarDias(emision, -MAX_DESFASE), hasta = sumarDias(emision, 1);
    for (const l of comb) {
      if (origenFechaLinea(l, emision, comb.length) === "linea") continue;
      const placa = normPlaca(l.placa), total = l.total == null ? NaN : Number(l.total);
      if (!placa || !Number.isFinite(total)) continue;
      let cand = (porPlaca.get(placa) ?? []).filter((i) =>
        vs[i].fecha >= desde && vs[i].fecha <= hasta && Math.abs(vs[i].total - total) < TOLERANCIA_MONTO);
      if (cand.length > 1 && l.cantidad != null) {
        cand = cand.filter((i) => Number.isFinite(vs[i].cantidad) && Math.abs(vs[i].cantidad - Number(l.cantidad)) <= TOLERANCIA_CANTIDAD);
      }
      if (cand.length === 1) pares.push({ tipo, v: cand[0], d: diasEntre(vs[cand[0]].fecha, emision) });
    }
  }
  const usos = new Map<number, number>();
  for (const p of pares) usos.set(p.v, (usos.get(p.v) ?? 0) + 1);
  const unicos = pares.filter((p) => usos.get(p.v) === 1);
  return {
    una: unicos.filter((p) => p.tipo === "una").map((p) => p.d),
    consolidada: unicos.filter((p) => p.tipo === "consolidada").map((p) => p.d),
    tardias,
  };
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

/**
 * Las facturas de VARIAS cargas. No traen la fecha de ninguna, y fecharlas todas igual solo es
 * correcto si cada factura junta UN día —el lote nocturno de COESTI— y no un mes —la factura
 * consolidada de otros grifos, que pondría el despacho del día 3 el día 30—. Eso no se supone: se
 * mide con sus propias muestras (las de las consolidadas, no las de una línea), con los mismos
 * umbrales, y SOLO automático. El desfase que una persona FIJA dice cuántos días; no dice que cada
 * consolidada sea de un día, así que no las fecha. Sin evidencia, se confirman a mano, como antes.
 */
export type CodigoConsolidadas = "medido" | "pocos_datos" | "disperso";

export type DecisionConsolidadas = {
  /** ¿Se les pone fecha a las líneas de una factura de varias cargas? */
  fechar: boolean;
  /** Días que se le restan a la emisión cuando `fechar`. */
  dias: number;
  codigo: CodigoConsolidadas;
  medicion: MedicionDesfase;
  detalle: string;
};

export function decidirConsolidadas(m: MedicionDesfase): DecisionConsolidadas {
  const evidencia = textoMedicion(m);
  if (m.muestras < MIN_MUESTRAS_DESFASE) {
    return {
      fechar: false, dias: 0, codigo: "pocos_datos", medicion: m,
      detalle: `Las facturas de varias cargas no traen la fecha de cada despacho y todavía no hay con qué comprobar que cada una junta un solo día (${evidencia}; hacen falta ${MIN_MUESTRAS_DESFASE}). Mientras tanto se confirman a mano.`,
    };
  }
  if ((m.acuerdo ?? 0) < MIN_ACUERDO_DESFASE) {
    return {
      fechar: false, dias: 0, codigo: "disperso", medicion: m,
      detalle: `Las facturas de varias cargas NO juntan siempre el mismo día (${evidencia}): ponerles una fecha a todas movería mal a las demás, así que se confirman a mano.`,
    };
  }
  const d = m.dominante!;
  return {
    fechar: true, dias: d, codigo: "medido", medicion: m,
    detalle: d
      ? `Cada factura de varias cargas junta un solo día: el despacho fue ${d} día(s) antes de la emisión (${evidencia}). Sus líneas se fechan con la emisión − ${d} día(s) y se cruzan con el Radar como las de una sola línea.`
      : `Cada factura de varias cargas junta un solo día: el de su emisión (${evidencia}). Sus líneas se fechan con la fecha de emisión y se cruzan con el Radar como las de una sola línea.`,
  };
}

/** Lo que se le aplica a una cuenta: el desfase de las facturas de una línea y el de las consolidadas. */
export type DesfaseCuenta = DecisionDesfase & {
  consolidadas: DecisionConsolidadas;
  /** Facturas generadas después de su fecha (cierre de mes): no votan ni se corren. */
  tardias: number;
};

export function decidirDesfaseCuenta(configurado: unknown, muestras: MuestrasDesfase): DesfaseCuenta {
  return {
    ...decidirDesfase(configurado, medirDesfase(muestras.una)),
    consolidadas: decidirConsolidadas(medirDesfase(muestras.consolidada)),
    tardias: muestras.tardias,
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
 *   • `fecha_alterna` lleva la fecha de antes de correrla: el cruce la busca también;
 *   • una factura generada después de su fecha (`tardia`, el cierre de mes) no se corre;
 *   • una línea SIN fecha de una factura de varias cargas recibe la emisión − `consolidada` días
 *     (origen `consolidada`) solo si llega ese número —decidirConsolidadas lo da solo con
 *     evidencia— y la factura no es tardía; su alterna es la emisión, donde nada la buscaba antes.
 */
export function lineasAlDespacho<L extends LineaConFecha>(
  lineas: readonly L[],
  fechaEmision: string | null,
  dias: number,
  manual?: { n: number; fecha?: string | null } | null,
  opts: { consolidada?: number | null; tardia?: boolean } = {}
): { lineas: (L & { fecha: string | null; fecha_alterna: string | null })[]; origen: Map<number, OrigenFecha | null> } {
  const nComb = lineas.filter((l) => l.tipo_combustible).length;
  const origen = new Map<number, OrigenFecha | null>();
  const fechaConsolidada = !opts.tardia && !!fechaEmision && nComb > 1 && opts.consolidada != null &&
    Number.isInteger(opts.consolidada) && opts.consolidada >= 0 && opts.consolidada <= MAX_DESFASE
    ? sumarDias(fechaEmision, -opts.consolidada) : null;
  const out = lineas.map((l) => {
    const esManual = !!manual && manual.n === l.n && !!manual.fecha;
    let o: OrigenFecha | null = esManual ? "manual" : origenFechaLinea(l, fechaEmision, nComb);
    let base = esManual ? manual!.fecha! : (l.fecha ?? null);
    let fecha = fechaDeDespacho(base, o, opts.tardia ? 0 : dias);
    if (!base && o == null && fechaConsolidada && l.tipo_combustible) {
      o = "consolidada";
      base = fechaEmision;
      fecha = fechaConsolidada;
    }
    origen.set(l.n, o);
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
  /** Cuándo llegó su correo: una factura generada después de su fecha no se corre (generadaDespues). */
  recibido_en?: string | null;
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
 * Una carga que se borró no está en `cargas` y no se propone, y tampoco la de una factura generada
 * después de su fecha (el cierre de mes): esa fecha no es la del lote nocturno, y la conciliación
 * tampoco la corre.
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
    if (generadaDespues(f.fecha_emision, f.recibido_en)) continue;
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
      // Fusionada con su voucher: la fecha ya es la del despacho impresa en el papel, aunque coincida
      // con la emisión. Correrla sería deshacer lo que una persona confirmó contra la foto.
      if (esCargaFusionada(carga.observaciones)) continue;
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
