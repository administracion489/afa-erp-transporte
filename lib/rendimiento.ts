// lib/rendimiento.ts — El rendimiento de una unidad (km/gal, km/m³), en UN solo sitio.
// Módulo PURO (no toca la base ni secretos), mismo criterio que lib/costeo-propio.ts y
// lib/radar/coherencia-voucher.ts: recibe las cargas y devuelve tramos con su veredicto.
// Lo prueba scripts/prueba-rendimiento.mts y lo mide scripts/diagnostico-rendimiento.mts.
//
// POR QUÉ EXISTE. La misma fórmula estaba escrita CINCO veces, con tres umbrales distintos
// y dos criterios de promedio: app/combustible/page.tsx, lib/radar/acciones.ts,
// lib/odometro-analitica.ts, lib/elia/herramientas.ts y lib/costeo-servicio.ts. La única
// que descartaba lo absurdo y usaba mediana era la última — la que decide el MARGEN de los
// servicios. Las otras cuatro publicaban el disparate.
//
// EL CASO QUE LO MOTIVÓ (datos reales, placa CWZ-371, diésel, 10 cargas). Entre el 16/07 y
// el 05/08/2026 no hay ninguna carga registrada. La carga del 05/08 se comió los 1 592 km
// acumulados del hueco y los dividió entre sus 9.77 galones:
//
//     1 592 km ÷ 9.77 gal = 162.9 km/gal
//
// Eso no es un rendimiento, es un hueco de registro. Y como el color solo miraba hacia
// ABAJO (`rend < promedio * 0.7`), la fila salió VERDE con ✓. Después entró en la media,
// la subió de 28.61 a 43.53 y colocó el umbral de alarma en 30.47 — justo por encima del
// rendimiento real del vehículo (27.2 a 30.6 km/gal). Resultado: SIETE de nueve filas
// sanas marcadas 🚨 y la única rota absuelta. Un panel así enseña a ignorar los rojos.
//
// LAS DECISIONES QUE NO SE PUEDEN AFLOJAR
//
// 1. LA CADENA VA POR FECHA, NO POR KILOMETRAJE. Ordenar por el valor que se está midiendo
//    es circular: el km malo se ACOMODA en vez de delatarse. Con el dígito de más que este
//    ERP ya conoce (RATIO_DIGITO_DE_MAS = 8, lib/odometro.ts), un 1754450 tecleado por
//    175445 se va al final de la cadena y re-enlaza TODAS las cargas posteriores con el
//    predecesor equivocado: una fila mala contamina N tramos y los N salen con pinta
//    razonable. Por fecha se rompen exactamente DOS, y se rompen en la fila donde está el
//    error — que es donde alguien lo puede arreglar.
//
// 2. HAY DOS TECHOS Y HACEN TRABAJOS DISTINTOS. El de FAMILIA (constante) descalifica: lo
//    que lo supera no es una medición. El DERIVADO de la propia unidad (3 × mediana) solo
//    juzga: es una medición rara. El constante es lo único que funciona con dos cargas y
//    ningún historial —cuando la mediana de un solo valor ES el outlier— y lo único que
//    puede bloquear al Radar sin bloquear por "raro".
//
// 3. EL MOTIVO SE DECLARA, NO SE OLFATEA. Un solo "—" colapsaba cinco casos distintos
//    (aditivo, primera carga, sin odómetro aquí, sin odómetro antes, sin cantidad). Cada
//    uno se arregla en otro lado, así que cada uno tiene su código y la pantalla enruta por
//    él — la misma regla que los bloqueos de /liquidaciones.
//
// 4. UN ESLABÓN SALTADO BLOQUEA EL NÚMERO. Una carga con kilometraje 0 dentro del tramo
//    significa que esos km se hicieron con combustible que NO está en el denominador: el
//    resultado sale inflado POR CONSTRUCCIÓN, no "quizás". Y es detectable exacto. Donde el
//    ERP puede saber, no adivina. No publicarlo no es callarse: se dice cuántas cargas y
//    cuántos galones quedaron fuera, que convierte un "—" muerto en una tarea de diez
//    segundos.
//
// 5. LOS DOS HALLAZGOS SON DOS NEGOCIOS DISTINTOS. `rendimiento_bajo` es plata que SE FUE
//    (fuga, sifoneo, ruta pesada). `rendimiento_alto` es plata que FALTA EN LOS LIBROS: una
//    carga que nadie registró, comprada y consumida, que no está en v_egresos — así que el
//    costo de esa unidad está subvaluado y el margen de sus servicios, inflado. Mezclarlos
//    en un solo cubo es lo que hacía que el ERP se felicitara por un agujero en su propio
//    registro.

import { COMBUSTIBLES, configCombustible, familiaCombustible, LITROS_POR_GALON } from "@/lib/combustible-tipos";

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

/**
 * Techo de plausibilidad por FAMILIA. Por encima de esto el tramo no es una medición: es un
 * hueco de registro, un odómetro mal leído o un tanque llenado a medias. `null` = la familia
 * no tiene rendimiento (aditivo).
 *
 * El de galones es **heredado, no elegido**: es el literal que lib/costeo-servicio.ts lleva
 * en producción decidiendo el margen de los presupuestos. Cambiarlo movería números ya
 * emitidos, así que se conserva tal cual.
 *
 * El de GNV es el que demuestra que una constante única estaba mal: se mide en m³ y un galón
 * de diésel equivale a ~4 m³ de gas natural en energía, así que con el techo de 40 un tramo
 * de GNV tendría que estar CUATRO VECES equivocado para que alguien se enterara.
 *
 * Confirmar ambos con `npx tsx scripts/diagnostico-rendimiento.mts` antes de darlos por
 * buenos sobre esta flota: este repo mide sus umbrales, no los elige.
 */
export const TECHO_FAMILIA: Record<string, number | null> = {
  diesel: 40,
  biodiesel: 40,
  gasolina: 40,
  glp: 40,
  gnv: 12,
  urea: null, // aditivo: su métrica es lt/100km, que es consumo y no rendimiento
};

/** Techo derivado de la propia unidad: `FACTOR × mediana`. Solo juzga, nunca descalifica. */
export const FACTOR_TECHO_UNIDAD = 3;

/** Por debajo de `mediana × esto` el tramo es `rendimiento_bajo`. Es el umbral que ya usaba la pantalla. */
export const FACTOR_ALARMA_BAJO = 0.7;

/** Por encima de `mediana × esto` el tramo es `rendimiento_alto` (estadístico, no físico). */
export const FACTOR_ALARMA_ALTO = 1.4;

/** Con menos tramos que esto el patrón de la unidad no es fiable. Igual que `rangoEsperado`. */
export const MIN_TRAMOS_CONFIABLE = 5;

/**
 * Tope de km/día que separa **"faltan cargas por registrar"** de **"este kilometraje está mal"**.
 *
 * Un tramo por encima del techo de la familia puede ser dos cosas muy distintas, y el
 * rendimiento por sí solo NO las distingue:
 *
 *   · CWZ-371: 1 592 km en 20 días = 80 km/día. El odómetro está bien; lo que falta son las
 *     cargas de ese periodo. La lectura sirve como base del tramo siguiente.
 *   · Un 175445 tecleado 1754450: 1 579 450 km en 4 días = 394 862 km/día. Imposible. El
 *     odómetro está mal, y usarlo como base PROPAGA el error a todas las cargas posteriores
 *     — una fila mala rompiendo N tramos en vez de uno.
 *
 * Es el mismo 1500 que `registrarLectura` (lib/odometro.ts) y `config_mantenimiento.km_dia_max`
 * usan como default: no un umbral nuevo, el que el ERP ya declaró para esta misma pregunta.
 */
export const KM_DIA_MAX = 1500;

// ─── TIPOS ────────────────────────────────────────────────────────────────────

/**
 * Una carga, con la forma mínima que hace falta para medir.
 *
 * `unidad` es la CLAVE de la unidad y la arma quien llama: `/combustible` usa `p12`/`t3`
 * (los ids de vehiculos y vehiculos_tercero se solapan) y el Radar usa `String(vehiculo_id)`.
 * Aquí solo se compara consigo misma, así que basta con que sea estable.
 */
export type CargaRendimiento = {
  id: number;
  unidad: string;
  /** YYYY-MM-DD. Es el hecho: cuándo se cargó. */
  fecha: string;
  /** `combustible.kilometraje`. 0 y null son lo mismo: sin odómetro. */
  kilometraje: number | null;
  /** `combustible.galones`, lleve galones, litros o m³ (la columna se llama así por historia). */
  cantidad: number | null;
  /** `combustible.unidad`. Vacío = la de la familia (es lo que tienen las filas viejas). */
  unidadCantidad?: string | null;
  /** `combustible.tipo_combustible`. Vacío = diésel, como en el resto de la app. */
  tipo?: string | null;
  /** `combustible.total` — lo que costó. Solo hace falta para comparar ventanas. */
  gasto?: number | null;
};

/**
 * Por qué un tramo no tiene número. Cada uno se arregla en otro lado, así que la pantalla
 * enruta por CÓDIGO y no olfateando el texto.
 */
export type MotivoSinRendimiento =
  /** Urea y compañía: su métrica es lt/100km. No existe un km/gal que publicar. */
  | "aditivo"
  /** No hay carga anterior de esa unidad y esa familia. */
  | "primera_carga"
  /** Esta carga se guardó sin odómetro (el campo es opcional y cae en 0). */
  | "sin_odometro"
  /** La carga anterior se guardó sin odómetro. */
  | "sin_odometro_previo"
  /** Galones/litros/m³ en 0 o null: no hay denominador. */
  | "sin_cantidad"
  /** El odómetro de esta carga no supera al de la anterior. Un km está mal tecleado. */
  | "odometro_retrocede"
  /** La cantidad viene en una unidad que no se sabe convertir a la de la familia. */
  | "unidad_desconocida"
  /** Hay cargas SIN odómetro dentro del tramo: el denominador está incompleto por construcción. */
  | "eslabon_saltado"
  /** Supera el techo físico de su familia. No es un rendimiento, es un hueco de registro. */
  | "implausible";

export type Tramo = {
  /** La carga que CIERRA el tramo: es la que aporta el denominador y la que se pinta. */
  cargaId: number;
  previaId: number | null;
  unidad: string;
  familia: string;
  fecha: string;
  km: number | null;
  /** Ya normalizada a la unidad de la familia (litros → galones cuando corresponde). */
  cantidad: number | null;
  /** El rendimiento publicable. XOR con `motivo`: nunca los dos, nunca ninguno. */
  rendimiento: number | null;
  motivo: MotivoSinRendimiento | null;
  /**
   * El número que se descalificó (162.9), para poder MOSTRARLO. Un dato que se esconde
   * obliga a ir a buscarlo a la base; uno que se enseña tachado explica el "—" solo.
   */
  crudo: number | null;
  /** Ids de las cargas sin odómetro que el tramo se tragó. */
  saltadas: number[];
  techo: number | null;
  detalle: string;
};

export type ResumenUnidad = {
  unidad: string;
  familia: string;
  /** "km/gal" | "km/m³" — de la familia, no del octanaje. */
  label: string;
  /** La referencia. Mediana, no media: un tanque a medio llenar mueve la media y no la mediana. */
  mediana: number | null;
  media: number | null;
  n: number;
  confiable: boolean;
  techoFamilia: number | null;
  techoEfectivo: number | null;
  /** Cobertura: con qué parte de las cargas se midió. Alimenta el CPK y los avisos. */
  kmMedido: number;
  cantidadMedida: number;
  cargasSinOdometro: number;
  tramosDescartados: number;
};

export type CodigoHallazgo = "rendimiento_bajo" | "rendimiento_alto";

export type Hallazgo = {
  codigo: CodigoHallazgo;
  /**
   * `true` solo cuando lo levantó el techo CONSTANTE (imposibilidad física), nunca la banda
   * estadística. Es lo que decide si el Radar puede bloquear el auto-registro: un bloqueo
   * por "raro" saldría en cada primera carga tras una parada legítima y se volvería paisaje.
   */
  fisico: boolean;
  rendimiento: number | null;
  referencia: number | null;
  detalle: string;
};

export type Serie = { tramos: Tramo[]; resumen: ResumenUnidad };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Mediana, no promedio: un tanque a medio llenar mueve la media y no la mediana. */
export function mediana(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function media(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n) && n > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** Días entre dos fechas YYYY-MM-DD. Sin husos: las dos son fechas de Perú ya resueltas. */
function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 1;
}

/** La clave de una serie: una unidad y una FAMILIA (no un tipo: el tanque es el mismo). */
export function claveSerie(unidad: string, familia: string): string {
  return `${unidad}|${familia}`;
}

export function techoDeFamilia(familia: string): number | null {
  return familia in TECHO_FAMILIA ? TECHO_FAMILIA[familia] : TECHO_FAMILIA.diesel;
}

/** Etiqueta de la familia ("km/gal", "km/m³"). Sale del catálogo, no se redacta aquí. */
function labelDeFamilia(familia: string): string {
  const tipo = Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === familia);
  return tipo ? COMBUSTIBLES[tipo].rendimientoLabel : "km/gal";
}

/**
 * La cantidad en la unidad de la FAMILIA, o null si no se sabe convertir.
 *
 * El Radar guarda litros en `combustible.galones` con `unidad: "litros"` y nadie lo miraba,
 * así que un diésel cargado en litros daba un rendimiento inflado ×3.785 rotulado "km/gal".
 * La plata de esas filas está bien (`total` = litros × precio/litro); lo único mal era esto.
 *
 * Una unidad vacía se asume la de la familia: es lo que tienen todas las filas anteriores a
 * la columna, y `cambiarTipo` en /combustible la fija desde el catálogo.
 */
export function normalizarCantidad(
  cantidad: number | null | undefined,
  unidadCantidad: string | null | undefined,
  familia: string
): number | null {
  const q = num(cantidad);
  if (q <= 0) return null;

  const destino = COMBUSTIBLES[Object.keys(COMBUSTIBLES).find((t) => COMBUSTIBLES[t].familia === familia) ?? "diesel"];
  const esperada = destino?.unidad ?? "galones";
  const dada = String(unidadCantidad ?? "").trim().toLowerCase();

  if (!dada || dada === esperada) return q;
  if (esperada === "galones" && dada === "litros") return q / LITROS_POR_GALON;
  if (esperada === "litros" && dada === "galones") return q * LITROS_POR_GALON;
  return null; // m³ sobre familia de galones y viceversa: no se adivina
}

// ─── LA SERIE ─────────────────────────────────────────────────────────────────

/**
 * Los tramos de UNA unidad y UNA familia, en orden cronológico.
 *
 * Las cargas de otras unidades o familias que lleguen se ignoran: la clave la decide la
 * primera fila. Para un lote mezclado, `seriesRendimiento`.
 */
export function serieRendimiento(cargas: CargaRendimiento[]): Serie {
  const primera = cargas[0];
  const familia = familiaCombustible(primera?.tipo);
  const unidad = primera?.unidad ?? "";
  const techoFamilia = techoDeFamilia(familia);
  const label = labelDeFamilia(familia);

  const vacio: ResumenUnidad = {
    unidad, familia, label,
    mediana: null, media: null, n: 0, confiable: false,
    techoFamilia, techoEfectivo: techoFamilia,
    kmMedido: 0, cantidadMedida: 0, cargasSinOdometro: 0, tramosDescartados: 0,
  };

  if (!cargas.length) return { tramos: [], resumen: vacio };

  // Los aditivos no tienen rendimiento: se declara y se sale. Publicar un km/lt disfrazado
  // de km/gal sería inventar una métrica que nadie pidió.
  if (techoFamilia === null) {
    return {
      tramos: cargas.map((c) => tramoSin(c, unidad, familia, "aditivo", null, [])),
      resumen: vacio,
    };
  }

  // ORDEN CRONOLÓGICO. El desempate intradía es por kilometraje (dos cargas del mismo día sí
  // van en odómetro creciente, y su alcance es un solo día). Nunca por `created_at`: eso es
  // hora de INSERCIÓN, no del hecho — una carga del 5 tecleada el 20 se colocaría al final.
  const ord = [...cargas].sort(
    (a, b) =>
      String(a.fecha ?? "").localeCompare(String(b.fecha ?? "")) ||
      num(a.kilometraje) - num(b.kilometraje) ||
      a.id - b.id
  );

  const tramos: Tramo[] = [];
  let previa: CargaRendimiento | null = null;
  let saltadasPendientes: number[] = [];
  let cargasSinOdometro = 0;

  for (const c of ord) {
    const km = num(c.kilometraje);
    const cantidad = normalizarCantidad(c.cantidad, c.unidadCantidad, familia);

    // Sin odómetro esta carga no puede cerrar un tramo NI abrir el siguiente: sus galones
    // movieron el bus y nadie sabe cuánto. Queda anotada como eslabón saltado para que el
    // tramo que finalmente cierre declare que su denominador está incompleto.
    if (km <= 0) {
      cargasSinOdometro++;
      tramos.push(tramoSin(c, unidad, familia, "sin_odometro", previa?.id ?? null, []));
      saltadasPendientes.push(c.id);
      continue;
    }

    if (!previa) {
      tramos.push(tramoSin(c, unidad, familia, "primera_carga", null, saltadasPendientes));
      previa = c;
      saltadasPendientes = [];
      continue;
    }

    const kmPrev = num(previa.kilometraje);
    const delta = km - kmPrev;
    const saltadas = saltadasPendientes;
    saltadasPendientes = [];

    const base = {
      cargaId: c.id, previaId: previa.id, unidad, familia, fecha: c.fecha,
      km: delta, cantidad, crudo: null as number | null, saltadas,
      techo: techoFamilia,
    };

    // El orden de los descartes importa: primero lo que impide medir, después lo que hace la
    // medición inválida. Un tramo sin cantidad no puede ser "implausible": no hay división.
    if (cantidad === null) {
      const motivo: MotivoSinRendimiento =
        num(c.cantidad) > 0 ? "unidad_desconocida" : "sin_cantidad";
      tramos.push({ ...base, rendimiento: null, motivo, detalle: detalleDe(motivo, base) });
      previa = c;
      continue;
    }

    if (delta <= 0) {
      tramos.push({
        ...base, rendimiento: null, motivo: "odometro_retrocede",
        detalle: detalleDe("odometro_retrocede", { ...base, kmPrev }),
      });
      // El km malo NO se convierte en la base del siguiente tramo: eso propagaría el error.
      // Se conserva la última lectura buena, que es lo que hace `sanearLecturas`.
      continue;
    }

    const valor = delta / cantidad;

    if (saltadas.length) {
      tramos.push({
        ...base, rendimiento: null, motivo: "eslabon_saltado", crudo: valor,
        detalle: detalleDe("eslabon_saltado", { ...base, crudo: valor }),
      });
      previa = c;
      continue;
    }

    if (valor > techoFamilia) {
      // El rendimiento por sí solo no dice si faltan cargas o si el km está mal. El km/DÍA sí.
      const dias = Math.max(1, diasEntre(previa.fecha, c.fecha));
      const kmMalo = delta / dias > KM_DIA_MAX;
      tramos.push({
        ...base, rendimiento: null, motivo: "implausible", crudo: valor,
        detalle: detalleDe("implausible", { ...base, crudo: valor, kmMalo, dias }),
      });
      // Una lectura imposible NO se convierte en la base del tramo siguiente: eso propagaría
      // el error a todas las cargas posteriores. Se anota como saltada —su km no sirve— y la
      // base se queda en la última lectura buena, igual que hace `sanearLecturas`.
      if (kmMalo) saltadasPendientes.push(c.id);
      else previa = c;
      continue;
    }

    tramos.push({ ...base, rendimiento: valor, motivo: null, detalle: "" });
    previa = c;
  }

  // Un tramo sin odómetro previo se distingue del "primera_carga": el primero es un dato que
  // falta en OTRA fila, y se arregla ahí.
  for (let i = 1; i < tramos.length; i++) {
    if (tramos[i].motivo === "primera_carga" && tramos.slice(0, i).some((t) => t.motivo === "sin_odometro")) {
      tramos[i] = { ...tramos[i], motivo: "sin_odometro_previo", detalle: detalleDe("sin_odometro_previo", tramos[i]) };
    }
  }

  const buenos = tramos.filter((t) => t.rendimiento !== null);
  const valores = buenos.map((t) => t.rendimiento as number);
  const med = mediana(valores);

  return {
    tramos,
    resumen: {
      unidad, familia, label,
      mediana: med,
      media: media(valores),
      n: valores.length,
      confiable: valores.length >= MIN_TRAMOS_CONFIABLE,
      techoFamilia,
      techoEfectivo:
        med !== null && valores.length >= MIN_TRAMOS_CONFIABLE
          ? Math.min(techoFamilia, med * FACTOR_TECHO_UNIDAD)
          : techoFamilia,
      kmMedido: buenos.reduce((s, t) => s + num(t.km), 0),
      cantidadMedida: buenos.reduce((s, t) => s + num(t.cantidad), 0),
      cargasSinOdometro,
      tramosDescartados: tramos.filter(
        (t) => t.motivo === "implausible" || t.motivo === "eslabon_saltado" || t.motivo === "odometro_retrocede"
      ).length,
    },
  };
}

function tramoSin(
  c: CargaRendimiento,
  unidad: string,
  familia: string,
  motivo: MotivoSinRendimiento,
  previaId: number | null,
  saltadas: number[]
): Tramo {
  const t: Tramo = {
    cargaId: c.id, previaId, unidad, familia, fecha: c.fecha,
    km: null, cantidad: null, rendimiento: null, motivo, crudo: null,
    saltadas, techo: techoDeFamilia(familia), detalle: "",
  };
  return { ...t, detalle: detalleDe(motivo, t) };
}

/** Todas las series de un lote mezclado, indexadas por `claveSerie(unidad, familia)`. */
export function seriesRendimiento(cargas: CargaRendimiento[]): Map<string, Serie> {
  const cubos = new Map<string, CargaRendimiento[]>();
  for (const c of cargas) {
    const k = claveSerie(c.unidad, familiaCombustible(c.tipo));
    const arr = cubos.get(k);
    if (arr) arr.push(c);
    else cubos.set(k, [c]);
  }
  const out = new Map<string, Serie>();
  for (const [k, arr] of cubos) out.set(k, serieRendimiento(arr));
  return out;
}

/** Índice carga → su tramo y el resumen de su serie. Es lo que pinta una fila de tabla. */
export function tramosPorCarga(series: Map<string, Serie>): Record<number, { tramo: Tramo; resumen: ResumenUnidad }> {
  const out: Record<number, { tramo: Tramo; resumen: ResumenUnidad }> = {};
  for (const s of series.values()) {
    for (const t of s.tramos) out[t.cargaId] = { tramo: t, resumen: s.resumen };
  }
  return out;
}

// ─── EL JUICIO ────────────────────────────────────────────────────────────────

/**
 * El veredicto de un tramo contra el patrón de su propia unidad. Nunca contra otras: un bus
 * viejo con 8 km/gal no tiene por qué compararse con una van.
 *
 * Los dos hallazgos son dos negocios distintos y por eso llevan códigos distintos. Ver la
 * cabecera del módulo.
 */
export function juzgarTramo(t: Tramo, r: ResumenUnidad): Hallazgo | null {
  // Imposibilidad física: no necesita historial, y es el único que puede bloquear.
  if (t.motivo === "implausible") {
    return {
      codigo: "rendimiento_alto",
      fisico: true,
      rendimiento: t.crudo,
      referencia: t.techo,
      detalle: t.detalle,
    };
  }

  if (t.rendimiento === null || r.mediana === null || !r.confiable) return null;

  if (t.rendimiento < r.mediana * FACTOR_ALARMA_BAJO) {
    return {
      codigo: "rendimiento_bajo",
      fisico: false,
      rendimiento: t.rendimiento,
      referencia: r.mediana,
      detalle:
        `Rindió ${fmt(t.rendimiento)} ${r.label} contra ${fmt(r.mediana)} habituales de esta unidad ` +
        `(${pct(r.mediana, t.rendimiento)} menos). Causas honestas: tráfico, ruta con más pendiente, ` +
        `o que el tanque no se llenó completo en la carga anterior.`,
    };
  }

  if (t.rendimiento > r.mediana * FACTOR_ALARMA_ALTO) {
    return {
      codigo: "rendimiento_alto",
      fisico: false,
      rendimiento: t.rendimiento,
      referencia: r.mediana,
      detalle:
        `Rindió ${fmt(t.rendimiento)} ${r.label} contra ${fmt(r.mediana)} habituales de esta unidad. ` +
        `Un rendimiento muy por encima del propio patrón suele ser una CARGA QUE FALTA POR REGISTRAR, ` +
        `no un buen manejo: el combustible se compró y se consumió, pero no está en el libro.`,
    };
  }

  return null;
}

// ─── TEXTOS ───────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt0 = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });
const pct = (base: number, v: number) => `${Math.round(Math.abs((base - v) / base) * 100)} %`;
/** Soles, para los motivos que nombran plata. */
const fmtS = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function detalleDe(
  motivo: MotivoSinRendimiento,
  t: Partial<Tramo> & { kmPrev?: number; kmMalo?: boolean; dias?: number }
): string {
  switch (motivo) {
    case "aditivo":
      return "Aditivo: su métrica es el consumo (lt/100km), no el rendimiento.";
    case "primera_carga":
      return "Primera carga de esta unidad con este combustible: no hay tramo que medir todavía.";
    case "sin_odometro":
      return "Esta carga se guardó sin kilometraje. Edítala y ponle el odómetro para poder medir el tramo.";
    case "sin_odometro_previo":
      return "La carga anterior de esta unidad se guardó sin kilometraje. Edítala y ponle el odómetro.";
    case "sin_cantidad":
      return "La carga no tiene cantidad: no hay entre qué dividir.";
    case "odometro_retrocede":
      return (
        `El odómetro no avanzó (${fmt0(num(t.kmPrev))} → ${fmt0(num(t.kmPrev) + num(t.km))}). ` +
        `Uno de los dos kilometrajes está mal tecleado.`
      );
    case "unidad_desconocida":
      return "La cantidad está en una unidad que no se sabe convertir a la de este combustible.";
    case "eslabon_saltado":
      return (
        `${t.saltadas?.length ?? 0} carga(s) de esta unidad dentro del tramo no tienen kilometraje, ` +
        `así que su combustible no está en la cuenta` +
        (t.crudo ? ` (saldría ${fmt(t.crudo)}, inflado)` : "") +
        `. Ponles el odómetro y este tramo se puede medir.`
      );
    case "implausible":
      return (
        `${fmt0(num(t.km))} km ÷ ${fmt(num(t.cantidad))} = ${fmt(num(t.crudo))} — descartado: supera el ` +
        `techo de ${t.techo} para este combustible. ` +
        (t.kmMalo
          ? `Son ${fmt0(num(t.km) / Math.max(1, num(t.dias)))} km/día en ${num(t.dias)} día(s), que es ` +
            `imposible: el kilometraje de esta carga está mal tecleado. Corrígelo y el tramo se puede medir.`
          : `El kilometraje es plausible (${fmt0(num(t.km) / Math.max(1, num(t.dias)))} km/día), así que ` +
            `lo que falta son cargas de ese periodo sin registrar: ese combustible se compró y se consumió, ` +
            `pero no está en el libro.`)
      );
  }
}

/** El texto de un motivo, para que ninguna pantalla redacte el suyo. */
export function textoMotivo(motivo: MotivoSinRendimiento, t?: Tramo): string {
  return t?.detalle || detalleDe(motivo, t ?? {});
}

/** La etiqueta corta que va en la celda cuando no hay número. */
export function etiquetaMotivo(motivo: MotivoSinRendimiento): string {
  switch (motivo) {
    case "aditivo": return "aditivo";
    case "primera_carga": return "1ª carga";
    case "sin_odometro": return "sin km";
    case "sin_odometro_previo": return "sin km antes";
    case "sin_cantidad": return "sin cantidad";
    case "odometro_retrocede": return "km no avanza";
    case "unidad_desconocida": return "unidad ?";
    case "eslabon_saltado": return "tramo incompleto";
    case "implausible": return "implausible";
  }
}

// ─── COMPARAR DOS VENTANAS ────────────────────────────────────────────────────
//
// POR QUÉ, Y ES LO ÚNICO QUE HAY QUE ENTENDER DE ESTA PARTE. Cuando el gasto de
// combustible sube hay TRES causas posibles, y se gestionan de forma opuesta:
//
//   · recorrió más km        → no es anomalía, es más trabajo (y más facturación)
//   · rinde menos km/gal     → SÍ es anomalía: mecánica, manejo, o una fuga
//   · el combustible subió   → es del mercado, no de la flota
//
// En los datos reales de esta flota el diésel pasó de S/ 24.70 (14/08) a S/ 25.74
// (03/09): +4.2 % de gasto sin que nadie haya hecho nada mal. Una comparación que
// solo diga "gastaste más" hace leer ese 4.2 % como problema operativo — y un aviso
// que salta por algo que nadie puede arreglar se vuelve paisaje, que es exactamente
// lo que este módulo existe para no repetir.
//
// Por eso la diferencia de gasto se DESCOMPONE en esas tres causas, cada una en
// soles, y suman exacto.

export type ResumenVentana = {
  desde: string;
  hasta: string;
  dias: number;
  /**
   * Solo de tramos MEDIDOS: numerador y denominador salen de las mismas filas.
   * Sumar los galones de una carga cuyo km no se pudo medir inflaría el denominador
   * y hundiría el rendimiento de la ventana sin decir por qué.
   */
  km: number;
  cantidad: number;
  gasto: number;
  /** `Σkm / Σcantidad`. AGREGADO, no el promedio de los tramos: promediar ratios da
   *  un número que no corresponde a ningún consumo real. */
  rendimiento: number | null;
  /** `Σgasto / Σcantidad` — ponderado por galón, que es lo que de verdad se pagó. */
  precioMedio: number | null;
  costoKm: number | null;
  cargas: number;
  cargasMedidas: number;
  /** TODAS las cargas de la ventana. Es lo que cuadra con caja, y por eso se publica
   *  aparte: si solo se enseñara `gasto`, no cuadraría con el KPI de la pantalla y el
   *  operador concluiría que uno de los dos miente. */
  gastoTotal: number;
  cargasSinOdometro: number;
  familias: string[];
  label: string;
};

/** Los tres efectos, en soles. Suman exactamente `total`. */
export type EfectoGasto = { km: number; rendimiento: number; precio: number; total: number };

export type Variaciones = {
  km: number | null;
  cantidad: number | null;
  gasto: number | null;
  gastoTotal: number | null;
  rendimiento: number | null;
  costoKm: number | null;
};

export type Comparacion = {
  actual: ResumenVentana;
  previa: ResumenVentana;
  efectos: EfectoGasto | null;
  variacion: Variaciones;
  comparable: boolean;
  /** Por qué no se puede comparar, o por qué el resultado es solo orientativo. */
  motivo: string | null;
};

/** Variación relativa, en puntos porcentuales. Sin base no se inventa un 100 %. */
export function variacionPct(actual: number | null, previa: number | null): number | null {
  if (actual == null || previa == null || !Number.isFinite(actual) || !Number.isFinite(previa)) return null;
  if (previa === 0) return null; // sin base no hay variación: un "+100 %" sería inventado
  return ((actual - previa) / Math.abs(previa)) * 100;
}

/**
 * Resume una ventana de fechas. `series` se calcula sobre TODO el historial (el km
 * entre dos cargas es un hecho del vehículo y no cambia porque se esté filtrando un
 * mes); aquí solo se recortan los tramos cuya carga cae dentro de [desde, hasta].
 */
export function resumirVentana(
  series: Map<string, Serie>,
  cargas: CargaRendimiento[],
  desde: string,
  hasta: string,
  label = ""
): ResumenVentana {
  const enRango = (f: string) => f >= desde && f <= hasta;
  const delRango = cargas.filter((c) => enRango(String(c.fecha ?? "").slice(0, 10)));
  const gastoDe = new Map(delRango.map((c) => [c.id, num(c.gasto)]));

  let km = 0, cantidad = 0, gasto = 0, medidas = 0, sinOdo = 0;
  const familias = new Set<string>();

  for (const s of series.values()) {
    for (const t of s.tramos) {
      if (!gastoDe.has(t.cargaId)) continue; // la carga que CIERRA el tramo manda
      if (t.motivo === "sin_odometro") sinOdo++;
      if (t.rendimiento === null || t.km == null || t.cantidad == null) continue;
      km += t.km;
      cantidad += t.cantidad;
      gasto += gastoDe.get(t.cargaId) ?? 0;
      medidas++;
      familias.add(s.resumen.familia);
    }
  }

  return {
    desde, hasta,
    dias: Math.max(0, diasEntre(desde, hasta) + 1),
    km, cantidad, gasto,
    rendimiento: cantidad > 0 ? km / cantidad : null,
    precioMedio: cantidad > 0 ? gasto / cantidad : null,
    costoKm: km > 0 ? gasto / km : null,
    cargas: delRango.length,
    cargasMedidas: medidas,
    gastoTotal: delRango.reduce((s, c) => s + num(c.gasto), 0),
    cargasSinOdometro: sinOdo,
    familias: [...familias].sort(),
    label,
  };
}

/**
 * Compara dos ventanas y reparte la diferencia de gasto entre sus tres causas.
 *
 * `gasto = km × (1/rendimiento) × precio`, y se varía UN factor por vez en orden
 * **volumen → eficiencia → precio**:
 *
 *     efecto_km      = (k₁ − k₀)/r₀ × p₀
 *     efecto_rend    = k₁ × (1/r₁ − 1/r₀) × p₀
 *     efecto_precio  = k₁/r₁ × (p₁ − p₀)
 *
 * Suman exactamente `g₁ − g₀`; la matriz lo fija al céntimo.
 *
 * ES UNA DESCOMPOSICIÓN SECUENCIAL, NO SIMÉTRICA: el residuo de interacción cae en
 * el ÚLTIMO factor. Por eso el orden está declarado y no se reordena por estética —
 * el precio va al final porque es el efecto típicamente menor y el más exógeno, así
 * que es donde menos daño hace que se le acumule el residuo.
 */
export function compararVentanas(actual: ResumenVentana, previa: ResumenVentana): Comparacion {
  const variacion: Variaciones = {
    km: variacionPct(actual.km, previa.km),
    cantidad: variacionPct(actual.cantidad, previa.cantidad),
    gasto: variacionPct(actual.gasto, previa.gasto),
    gastoTotal: variacionPct(actual.gastoTotal, previa.gastoTotal),
    rendimiento: variacionPct(actual.rendimiento, previa.rendimiento),
    costoKm: variacionPct(actual.costoKm, previa.costoKm),
  };

  const base = { actual, previa, variacion };

  // Sin tramos medidos en alguna de las dos ventanas no hay nada que descomponer, y
  // decirlo es mejor que publicar un −100 % que nadie puede interpretar.
  //
  // El mensaje NOMBRA lo que sí hay. "No hay tramos medidos" sobre un periodo con dos
  // cargas y S/ 466 de gasto hace dudar de la pantalla: el operador ve cargas en la
  // tabla y lee que no hay nada. Lo que falta no son cargas, es el PAR con kilometraje
  // — y eso se puede arreglar en un minuto desde la propia fila.
  if (!previa.cargasMedidas || !actual.cargasMedidas) {
    const faltan = [
      !previa.cargasMedidas ? previa : null,
      !actual.cargasMedidas ? actual : null,
    ].filter(Boolean) as ResumenVentana[];

    const detalle = faltan
      .map((w) => {
        const cual = w === previa ? "el periodo anterior" : "este periodo";
        if (!w.cargas) return `${cual} no tiene ninguna carga registrada`;
        const plata = `${w.cargas} carga(s) por ${fmtS(w.gastoTotal)}`;
        if (w.cargas === 1) return `${cual} tiene ${plata}, y con una sola carga no hay tramo que medir`;
        if (w.cargasSinOdometro) return `${cual} tiene ${plata}, pero ${w.cargasSinOdometro} de ellas se guardaron SIN kilometraje`;
        return `${cual} tiene ${plata}, pero ninguna llega a formar un tramo medible`;
      })
      .join("; ");

    return {
      ...base, efectos: null, comparable: false,
      motivo:
        `No se puede comparar: ${detalle}. Un tramo se mide con dos cargas seguidas de la misma unidad que ` +
        `tengan kilometraje — poner el odómetro que falte en esas filas hace aparecer la comparación.`,
    };
  }

  const r0 = previa.rendimiento, r1 = actual.rendimiento;
  const p0 = previa.precioMedio, p1 = actual.precioMedio;
  if (!r0 || !r1 || p0 == null || p1 == null) {
    return { ...base, efectos: null, comparable: false, motivo: "No se puede comparar: falta el rendimiento o el precio de alguno de los dos periodos." };
  }

  const efKm = ((actual.km - previa.km) / r0) * p0;
  const efRend = actual.km * (1 / r1 - 1 / r0) * p0;
  const efPrecio = (actual.km / r1) * (p1 - p0);

  const efectos: EfectoGasto = {
    km: efKm, rendimiento: efRend, precio: efPrecio,
    // El total es la diferencia REAL, no la suma de los tres: así, si algún día la
    // aritmética se desviara, se vería en la pantalla en vez de cuadrar sola.
    total: actual.gasto - previa.gasto,
  };

  // Con pocos tramos el número existe pero no es un patrón. Se compara igual —
  // esconderlo sería peor— y se dice.
  const flojo = Math.min(actual.cargasMedidas, previa.cargasMedidas) < MIN_TRAMOS_CONFIABLE;
  const mezcla = actual.familias.length > 1 || previa.familias.length > 1;

  const avisos: string[] = [];
  if (flojo) {
    avisos.push(
      `Orientativo: ${Math.min(actual.cargasMedidas, previa.cargasMedidas)} tramo(s) medido(s) en el periodo más corto ` +
      `(hacen falta ${MIN_TRAMOS_CONFIABLE} para hablar de un patrón).`
    );
  }
  if (actual.cargasSinOdometro || previa.cargasSinOdometro) {
    avisos.push(
      `${actual.cargasSinOdometro + previa.cargasSinOdometro} carga(s) sin kilometraje quedaron fuera de la medición: ` +
      `ponérselo hace la comparación más exacta.`
    );
  }
  if (mezcla) {
    avisos.push("Hay más de un combustible en la comparación: el rendimiento agregado mezcla unidades distintas (gal y m³).");
  }
  if (Math.abs(actual.dias - previa.dias) > 2) {
    avisos.push(`Los periodos no duran lo mismo (${actual.dias} vs ${previa.dias} días): los totales no son comparables, los ratios sí.`);
  }

  return { ...base, efectos, comparable: true, motivo: avisos.length ? avisos.join(" ") : null };
}
