// LA DISPERSIÓN GALONES (o m³) VS KM · un punto por tramo, y el color lo decide el motor.
//
// Motor PURO: no lee la base ni hace fetch. Recibe las series que `seriesRendimiento`
// (lib/rendimiento.ts) ya armó —en /combustible es el `seriesRend` de la página— y devuelve los
// puntos del gráfico con su clase, más lo que NO tiene punto, contado por motivo.
// Matriz: `npx tsx scripts/prueba-dispersion.mts`.
//
// POR QUÉ EXISTE, Y ES LO ÚNICO QUE HAY QUE ENTENDER DE ESTE MÓDULO. Una dispersión km × cantidad
// es el rendimiento DIBUJADO: la pendiente de cada punto visto desde el origen es su km/gal. Si la
// pantalla decidiera por su cuenta qué punto es «raro», dibujaría un segundo juez del mismo número
// —el bug del semáforo de puntualidad: dos motores que contestan la misma pregunta terminan
// contestando distinto, y aquí el desacuerdo se vería en el mismo gráfico—. Por eso la clase de
// cada punto sale de `juzgarTramo` y de `MotivoSinRendimiento`, y de nada más.
//
// CINCO DECISIONES, todas con su porqué:
//
//   1. UNA SOLA FAMILIA POR GRÁFICO. Un km/gal y un km/m³ no son el mismo número: no se suman, no
//      se promedian y no comparten eje. Mezclar galones de diésel con m³ de GNV en el eje Y dibuja
//      una nube que no describe ningún consumo. Ningún punto de otra familia entra, jamás.
//
//   2. NADA SE PIERDE EN SILENCIO. Todo tramo de la familia que pasa el filtro sale UNA vez: como
//      punto, o contado en `sinPunto[motivo]`. Disjunto y exhaustivo — un tramo que no saliera en
//      ninguno sería uno que la pantalla no explica en ningún sitio. `tramos` es el total, para
//      poder decir «N de M».
//
//   3. UN PUNTO NECESITA UN KM DE FIAR. El km lo declara el propio motor con `Tramo.kmConfiable`
//      (el mismo `kmMalo` que decide si una lectura sirve de base para el tramo siguiente). Un
//      `implausible` por HUECO DE REGISTRO tiene un km bueno —el odómetro avanzó de verdad— y se
//      dibuja tachado con su crudo; un `implausible` por KM MAL TECLEADO (más de KM_DIA_MAX km/día)
//      tiene un km que el motor ya declaró falso, y dibujarlo pondría un punto a 1.5 millones de km
//      que aplasta el resto del gráfico contra el eje. Ese va a `sinPunto.implausible`, con un texto
//      que dice exactamente eso (`textoSinPunto`).
//
//   4. LA CANTIDAD DEL PUNTO ES LA DE MEDIR, no la de la boleta, cuando la unidad tiene un
//      combustible AUXILIAR (`Tramo.auxiliar`): `cantidadParaRendimiento` del motor, para que
//      `km / cantidad` sea EXACTAMENTE el rendimiento con el que se juzgó el punto. Con la cantidad
//      cargada, el punto de una bicombustible quedaría un 5-10 % corrido respecto de las líneas de
//      referencia: pintado «normal» encima de la banda de «bajo», la pantalla contradiciéndose. Lo
//      cargado de verdad viaja en `cantidadCargada`, y `auxiliar: true` lo declara.
//
//   5. LA REFERENCIA SOLO CON UNA UNIDAD, Y SOLO SI EL MOTOR JUZGA. Las líneas `y = x / mediana` y
//      sus bandas ×FACTOR_ALARMA_BAJO / ×FACTOR_ALARMA_ALTO son la mediana DE UNA UNIDAD: sin filtro,
//      una «mediana de la flota» sería un número que no existe en ningún sitio del ERP. Y con menos
//      de MIN_TRAMOS_CONFIABLE tramos `juzgarTramo` no levanta ni bajo ni alto, así que dibujar las
//      bandas pintaría como «normal» un punto que está fuera de ellas — una pantalla describiendo una
//      regla que el sistema no aplica. Cuando no hay referencia, `sinReferencia` dice por qué con su
//      código y su texto.

import {
  cantidadParaRendimiento,
  claveSerie,
  FACTOR_ALARMA_ALTO,
  FACTOR_ALARMA_BAJO,
  juzgarTramo,
  KM_DIA_MAX,
  labelDeFamilia,
  MIN_TRAMOS_CONFIABLE,
  techoDeFamilia,
  textoMotivo,
  type Hallazgo,
  type MotivoSinRendimiento,
  type Serie,
  type Tramo,
} from "@/lib/rendimiento";
import { COMBUSTIBLES } from "@/lib/combustible-tipos";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

/**
 * Cómo se pinta un punto. Cada una sale del motor de rendimiento, ninguna se deduce aquí:
 *
 *   · `normal`                 — tramo medido sin hallazgo.
 *   · `bajo`                   — `juzgarTramo` → `rendimiento_bajo` (plata que SE FUE).
 *   · `alto`                   — `juzgarTramo` → `rendimiento_alto` estadístico (plata que FALTA en
 *                                los libros: casi siempre una carga sin registrar).
 *   · `implausible`            — `juzgarTramo` → `rendimiento_alto` FÍSICO: supera el techo de su
 *                                familia. Se pinta tachado, con `crudo`.
 *   · `denominador_incompleto` — `familia_cruzada` o `eslabon_saltado`: el km es de fiar pero en la
 *                                cantidad falta combustible que movió el bus. Se pinta hueco y en gris.
 */
export type ClasePunto = "normal" | "bajo" | "alto" | "implausible" | "denominador_incompleto";

export type PuntoDispersion = {
  /** La carga que CIERRA el tramo: es la fila del historial que se abre al pulsar el punto. */
  cargaId: number;
  /** La clave de la unidad tal como la armó quien construyó las series (`p12` / `t3` en /combustible). */
  unidad: string;
  /** YYYY-MM-DD de la carga que cierra el tramo. */
  fecha: string;
  /** Eje X: km del tramo. Siempre > 0 y de fiar (`Tramo.kmConfiable`). */
  km: number;
  /**
   * Eje Y: la cantidad CON LA QUE SE MIDE, en la unidad canónica de la familia (`unidadCantidad`).
   * Es la cargada, salvo en un tramo corregido por combustible auxiliar (`auxiliar: true`), donde
   * es la equivalente: así `km / cantidad === rendimiento` y el punto cae del lado correcto de las
   * líneas de referencia.
   */
  cantidad: number;
  /** Lo despachado de verdad en el tramo (esta carga + las absorbidas). Igual a `cantidad` sin auxiliar. */
  cantidadCargada: number;
  /** El rendimiento publicado. `null` en `implausible` y `denominador_incompleto`. */
  rendimiento: number | null;
  /** El número descalificado, para pintarlo tachado. Solo en `implausible` y `denominador_incompleto`. */
  crudo: number | null;
  clase: ClasePunto;
  /** El motivo del motor cuando el tramo no publica número. `null` en normal/bajo/alto. */
  motivo: MotivoSinRendimiento | null;
  /** El veredicto de `juzgarTramo`, tal cual. */
  hallazgo: Hallazgo | null;
  /** El rendimiento está corregido por un combustible auxiliar (unidad bicombustible). */
  auxiliar: boolean;
  /** Lo que se lee al pasar sobre el punto: el detalle del hallazgo, o `textoMotivo`, o el detalle del tramo. */
  texto: string;
};

/** La unidad del eje Y. Sale del catálogo (`ConfigCombustible.unidadLabel`), no se redacta aquí. */
export type UnidadCantidadDispersion = "gal" | "m³" | "lt";

/** Por qué no hay líneas de referencia. La pantalla enruta por código; el texto lo compone el módulo. */
export type MotivoSinReferencia =
  /** Sin filtro de unidad, con varias, o con ninguna: una «mediana de la flota» no existe. */
  | "varias_unidades"
  /** La unidad elegida no tiene ningún tramo medido de esta familia: no hay mediana. */
  | "sin_medicion"
  /** Tiene mediana, pero con menos de MIN_TRAMOS_CONFIABLE tramos: el motor no juzga con ella. */
  | "pocos_tramos";

export type ReferenciaDispersion = {
  /** La mediana de la unidad (km/gal o km/m³). Línea `y = x / mediana`. */
  mediana: number;
  /** `mediana × FACTOR_ALARMA_BAJO`. Línea `y = x / bajo`: un punto POR ENCIMA de ella es `bajo`. */
  bajo: number;
  /** `mediana × FACTOR_ALARMA_ALTO`. Línea `y = x / alto`: un punto POR DEBAJO de ella es `alto`. */
  alto: number;
  /** Sobre cuántos tramos medidos (de toda la historia, no del filtro de fechas) se calculó. */
  n: number;
};

export type FamiliaDisponible = {
  familia: string;
  /** Tramos de esa familia que pasan el filtro de unidades y fechas (puntos + sin punto). */
  tramos: number;
  /** De esos, cuántos se dibujan. */
  puntos: number;
};

export type FiltroDispersion = {
  familia: string;
  /** `undefined` = todas las unidades. Un Set VACÍO = ninguna: un filtro que no deja pasar nada no se convierte en «todas». */
  unidades?: Set<string>;
  /** YYYY-MM-DD, inclusivo, sobre la fecha de la carga que cierra el tramo. */
  desde?: string;
  /** YYYY-MM-DD, inclusivo. */
  hasta?: string;
};

export type Dispersion = {
  familia: string;
  unidadCantidad: UnidadCantidadDispersion;
  /** "km/gal" | "km/m³" — de la familia. */
  label: string;
  /** Ordenados por fecha, unidad y carga. */
  puntos: PuntoDispersion[];
  /** Los tramos sin punto, contados por motivo. Solo claves con conteo > 0. */
  sinPunto: Partial<Record<MotivoSinRendimiento, number>>;
  /** Total de tramos de la familia que pasan el filtro: `puntos.length + Σ sinPunto`. */
  tramos: number;
  referencia: ReferenciaDispersion | null;
  /** XOR con `referencia`: exactamente uno de los dos es null. */
  sinReferencia: { codigo: MotivoSinReferencia; texto: string } | null;
  /**
   * Las familias CON RENDIMIENTO presentes en lo filtrado (unidades y fechas, sin mirar la familia),
   * de la que más se dibuja a la que menos. La primera es `familiaPorDefecto`. Los aditivos (urea)
   * no aparecen: no tienen rendimiento, así que su gráfico estaría siempre vacío.
   */
  familiasDisponibles: FamiliaDisponible[];
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

const UNIDADES_VALIDAS: readonly UnidadCantidadDispersion[] = ["gal", "m³", "lt"];

/** La unidad canónica de la familia, del catálogo. Familia desconocida → "gal" (mismo respaldo que `labelDeFamilia`). */
export function unidadCantidadDeFamilia(familia: string): UnidadCantidadDispersion {
  const tipo = Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === familia);
  const u = tipo ? COMBUSTIBLES[tipo].unidadLabel : "gal";
  return (UNIDADES_VALIDAS as readonly string[]).includes(u) ? (u as UnidadCantidadDispersion) : "gal";
}

/** ¿La familia tiene rendimiento? Los aditivos no (`techoDeFamilia` → null). */
function tieneRendimiento(familia: string): boolean {
  return techoDeFamilia(familia) !== null;
}

function pasaUnidadYFecha(t: Tramo, f: Omit<FiltroDispersion, "familia">): boolean {
  if (f.unidades && !f.unidades.has(t.unidad)) return false;
  const fecha = String(t.fecha ?? "");
  if (f.desde && fecha < f.desde) return false;
  if (f.hasta && fecha > f.hasta) return false;
  return true;
}

/**
 * El punto de un tramo, o `null` si no tiene dónde ir en el gráfico. TOTAL: todo tramo con
 * `motivo === null` es punto (el motor garantiza km > 0 y cantidad > 0 al publicar), y todo tramo
 * que no es punto tiene motivo — así `sinPunto[motivo]` siempre tiene clave.
 */
function puntoDe(t: Tramo, s: Serie): PuntoDispersion | null {
  const km = num(t.km);
  const cantidad = cantidadParaRendimiento(t);

  if (t.motivo === null) {
    const hallazgo = juzgarTramo(t, s.resumen);
    const clase: ClasePunto =
      hallazgo?.codigo === "rendimiento_bajo" ? "bajo" :
      hallazgo?.codigo === "rendimiento_alto" ? "alto" :
      "normal";
    return {
      cargaId: t.cargaId, unidad: t.unidad, fecha: t.fecha,
      km, cantidad, cantidadCargada: num(t.cantidad),
      rendimiento: t.rendimiento, crudo: t.crudo,
      clase, motivo: null, hallazgo,
      auxiliar: !!t.auxiliar,
      texto: hallazgo?.detalle ?? t.detalle ?? "",
    };
  }

  // Solo tres motivos tienen un km y una cantidad que se pueden dibujar, y solo si el km es de fiar.
  const dibujable = t.kmConfiable && km > 0 && cantidad > 0;
  if (!dibujable) return null;

  if (t.motivo === "implausible") {
    const hallazgo = juzgarTramo(t, s.resumen); // físico, siempre
    return {
      cargaId: t.cargaId, unidad: t.unidad, fecha: t.fecha,
      km, cantidad, cantidadCargada: num(t.cantidad),
      rendimiento: null, crudo: t.crudo,
      clase: "implausible", motivo: t.motivo, hallazgo,
      auxiliar: !!t.auxiliar,
      texto: hallazgo?.detalle ?? textoMotivo(t.motivo, t),
    };
  }

  if (t.motivo === "familia_cruzada" || t.motivo === "eslabon_saltado") {
    return {
      cargaId: t.cargaId, unidad: t.unidad, fecha: t.fecha,
      km, cantidad, cantidadCargada: num(t.cantidad),
      rendimiento: null, crudo: t.crudo,
      clase: "denominador_incompleto", motivo: t.motivo,
      // `juzgarTramo` no juzga un tramo sin rendimiento publicado: se le pregunta igual, para que
      // la clase y el hallazgo salgan del MISMO sitio aunque hoy conteste null.
      hallazgo: juzgarTramo(t, s.resumen),
      auxiliar: !!t.auxiliar,
      texto: textoMotivo(t.motivo, t),
    };
  }

  return null;
}

type Recorrido = { puntos: PuntoDispersion[]; sinPunto: Partial<Record<MotivoSinRendimiento, number>>; tramos: number };

/** Recorre las series una vez y reparte los tramos de la familia entre puntos y `sinPunto`. */
function recorrer(series: Map<string, Serie>, f: FiltroDispersion): Recorrido {
  const puntos: PuntoDispersion[] = [];
  const sinPunto: Partial<Record<MotivoSinRendimiento, number>> = {};
  let tramos = 0;

  for (const s of series.values()) {
    for (const t of s.tramos) {
      if (t.familia !== f.familia) continue;
      if (!pasaUnidadYFecha(t, f)) continue;
      tramos++;
      const p = puntoDe(t, s);
      if (p) {
        puntos.push(p);
      } else {
        // `puntoDe` es total: sin punto implica motivo no nulo. El `??` solo existe para el tipo.
        const m = (t.motivo ?? "sin_cantidad") as MotivoSinRendimiento;
        sinPunto[m] = (sinPunto[m] ?? 0) + 1;
      }
    }
  }

  puntos.sort(
    (a, b) =>
      String(a.fecha).localeCompare(String(b.fecha)) ||
      String(a.unidad).localeCompare(String(b.unidad)) ||
      a.cargaId - b.cargaId
  );
  return { puntos, sinPunto, tramos };
}

/** Las familias con rendimiento presentes en el filtro de unidades y fechas, la que más dibuja primero. */
function familiasDe(series: Map<string, Serie>, f: Omit<FiltroDispersion, "familia">): FamiliaDisponible[] {
  const conteo = new Map<string, FamiliaDisponible>();
  for (const s of series.values()) {
    for (const t of s.tramos) {
      if (!tieneRendimiento(t.familia)) continue;
      if (!pasaUnidadYFecha(t, f)) continue;
      const c = conteo.get(t.familia) ?? { familia: t.familia, tramos: 0, puntos: 0 };
      c.tramos++;
      if (puntoDe(t, s)) c.puntos++;
      conteo.set(t.familia, c);
    }
  }
  return [...conteo.values()].sort(
    (a, b) => b.puntos - a.puntos || b.tramos - a.tramos || a.familia.localeCompare(b.familia)
  );
}

function referenciaDe(
  series: Map<string, Serie>,
  f: FiltroDispersion
): { referencia: ReferenciaDispersion | null; sinReferencia: Dispersion["sinReferencia"] } {
  if (!f.unidades || f.unidades.size !== 1) {
    return { referencia: null, sinReferencia: { codigo: "varias_unidades", texto: textoSinReferencia("varias_unidades") } };
  }
  const [unidad] = [...f.unidades];
  const r = series.get(claveSerie(unidad, f.familia))?.resumen;
  if (!r || r.mediana === null || !(r.mediana > 0)) {
    return { referencia: null, sinReferencia: { codigo: "sin_medicion", texto: textoSinReferencia("sin_medicion", r?.label ?? labelDeFamilia(f.familia)) } };
  }
  if (!r.confiable) {
    return { referencia: null, sinReferencia: { codigo: "pocos_tramos", texto: textoSinReferencia("pocos_tramos", r.label, r.n) } };
  }
  return {
    referencia: {
      mediana: r.mediana,
      bajo: r.mediana * FACTOR_ALARMA_BAJO,
      alto: r.mediana * FACTOR_ALARMA_ALTO,
      n: r.n,
    },
    sinReferencia: null,
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Los puntos de la dispersión de UNA familia, con el filtro de unidades y fechas de la pantalla.
 *
 * Las series se pasan ENTERAS (toda la historia): la clase de cada punto se juzga con la mediana
 * de toda la historia de su unidad —igual que en la tabla— y el filtro de fechas solo decide qué
 * puntos se ven. Recortar las series antes de llamar cambiaría el juicio con el mes elegido.
 */
export function dispersionDeTramos(series: Map<string, Serie>, f: FiltroDispersion): Dispersion {
  const { puntos, sinPunto, tramos } = recorrer(series, f);
  const { referencia, sinReferencia } = referenciaDe(series, f);
  return {
    familia: f.familia,
    unidadCantidad: unidadCantidadDeFamilia(f.familia),
    label: labelDeFamilia(f.familia),
    puntos,
    sinPunto,
    tramos,
    referencia,
    sinReferencia,
    familiasDisponibles: familiasDe(series, { unidades: f.unidades, desde: f.desde, hasta: f.hasta }),
  };
}

/**
 * La familia que se muestra si nadie eligió: la que más PUNTOS dibuja en lo filtrado (a igualdad,
 * la de más tramos; después, alfabética). `null` si no hay ningún tramo con rendimiento.
 *
 * Es siempre la primera de `Dispersion.familiasDisponibles` con el mismo filtro: las dos salen de
 * la misma función, así que el selector y el defecto no pueden discrepar.
 */
export function familiaPorDefecto(
  series: Map<string, Serie>,
  unidades?: Set<string>,
  rango?: { desde?: string; hasta?: string }
): string | null {
  return familiasDe(series, { unidades, desde: rango?.desde, hasta: rango?.hasta })[0]?.familia ?? null;
}

// ─── TEXTOS ───────────────────────────────────────────────────────────────────

/**
 * La frase de un motivo SIN punto, para el pie del gráfico. No reutiliza `textoMotivo` a propósito:
 * aquella describe UN tramo con sus números, y sin el tramo imprime «0 km ÷ 0,0»; esta describe un
 * conteo y dice por qué esos tramos no tienen dónde ir en el gráfico y dónde se arregla.
 */
export function textoSinPunto(motivo: MotivoSinRendimiento, n: number): string {
  const k = n.toLocaleString("es-PE");
  switch (motivo) {
    case "aditivo":
      return `${k} carga(s) de aditivo: su métrica es el consumo (lt/100km), no un rendimiento que dibujar.`;
    case "primera_carga":
      return `${k} primera(s) carga(s) de su unidad con este combustible: abren la serie, todavía no hay tramo.`;
    case "sin_odometro":
      return `${k} carga(s) sin kilometraje: sin odómetro no hay km que dibujar. Ponles el km en el historial.`;
    case "sin_odometro_previo":
      return `${k} tramo(s) cuya carga anterior no tiene kilometraje. Ponle el km a esa carga en el historial.`;
    case "sin_cantidad":
      return `${k} tramo(s) sin cantidad: no hay galones (o m³) que dibujar.`;
    case "odometro_retrocede":
      return `${k} tramo(s) donde el odómetro no avanza: uno de los dos kilometrajes está mal tecleado.`;
    case "unidad_desconocida":
      return `${k} tramo(s) con la cantidad en una unidad que no se sabe convertir a la de este combustible.`;
    case "tanque_parcial":
      return `${k} carga(s) que no llenaron el tanque: su combustible está dentro del punto del próximo tanque lleno. No se pierde.`;
    case "implausible":
      return (
        `${k} tramo(s) con un kilometraje imposible (más de ${KM_DIA_MAX.toLocaleString("es-PE")} km por día): ` +
        `el km está mal tecleado y no tiene dónde ir en el gráfico. Corrígelo en el historial y el tramo aparece.`
      );
    case "eslabon_saltado":
      return `${k} tramo(s) con cargas sin kilometraje dentro y sin un km dibujable.`;
    case "familia_cruzada":
      return `${k} tramo(s) de unidad bicombustible sin un km dibujable.`;
  }
}

/** La frase de por qué no hay líneas de referencia. */
export function textoSinReferencia(codigo: MotivoSinReferencia, label = "km/gal", n = 0): string {
  switch (codigo) {
    case "varias_unidades":
      return (
        "La línea de referencia (la mediana de la unidad y sus bandas de bajo y alto) aparece al elegir " +
        "UNA sola unidad: una «mediana de la flota» sería un número que no existe en ningún sitio."
      );
    case "sin_medicion":
      return `Esta unidad no tiene ningún tramo medido con este combustible: no hay mediana (${label}) con qué trazar la referencia.`;
    case "pocos_tramos":
      return (
        `Esta unidad tiene ${n} tramo(s) medido(s) y hacen falta ${MIN_TRAMOS_CONFIABLE} para que su patrón sea fiable. ` +
        `Hasta entonces el ERP no marca ningún tramo como bajo o alto, así que dibujar las bandas sería ` +
        `pintar una regla que todavía no se aplica.`
      );
  }
}
