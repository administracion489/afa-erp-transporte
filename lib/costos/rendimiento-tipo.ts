// lib/costos/rendimiento-tipo.ts — Qué rendimiento MIDE la flota para un TIPO de vehículo, y
// si eso se puede proponer como parámetro. Módulo PURO: recibe las placas ya medidas y
// devuelve el veredicto con su motivo. No lee la base (el cargador es rendimiento-flota.ts).
//
// EL PROBLEMA QUE RESUELVE, Y ES EL ÚNICO QUE HAY QUE ENTENDER DE ESTE ARCHIVO:
// el rendimiento se MIDE por (placa, familia de combustible) sobre `combustible`, y se
// ESCRIBE por `parametros_costos.tipo_vehiculo`. Son dos identidades distintas, unidas por
// `vehiculos.tipo_vehiculo_costeo`, que es texto libre, nullable y sin FK. Convertir una en
// otra tiene siete reglas, y todas están declaradas aquí para que no haya una octava
// escondida en una pantalla.
//
// EL CASO QUE LO MOTIVÓ: el tipo SPRINTER_17 llevaba 19.00 km/gal tecleados mientras su única
// placa propia, CWZ-371, medía 28.61 sobre once tramos sanos (el implausible del hueco de
// registro ya queda fuera solo). El renglón de combustible de ese tipo estaba 50 % por encima
// del real en toda cotización nueva.
//
// Y el desenlace es el argumento entero: el dueño lo corrigió A MANO, yendo a /combustible a
// leer el número y volviendo a teclearlo aquí. El dato no faltaba; lo que faltaba era ponerlos
// en la misma pantalla. Un número que solo se alcanza copiándolo entre dos módulos se corrige
// el día que alguien se acuerda — y las categorías que nadie recuerda se quedan como nacieron.
//
// LO QUE ESTE MÓDULO NO HACE, A PROPÓSITO: escribir. Devuelve un número y un motivo; quién
// lo aplica es una persona, en /configuracion/costos, y la escritura pasa por
// `escribirParametro` (lib/costos/parametros.ts). Bajar el rendimiento de 19 a 28.5 abarata
// el precio ofertado ~20 % —el margen es sobre el PRECIO, `costo/0.8`— y eso lo firma el
// dueño, no un cron.
import { MIN_TRAMOS_CONFIABLE, labelDeFamilia, type MotivoSinRendimiento } from "@/lib/rendimiento";

/** El paso del campo `rendimiento_1` en la pantalla de costos (`CAMPOS_EDIT`, step 0.5).
 *  HEREDADO, no elegido: es la granularidad con la que el ERP ya declara que se teclea. */
export const PASO_RENDIMIENTO = 0.5;

/** Sub-ventana de recencia. Se propone la MENOR entre esta mediana y la histórica. */
export const DIAS_RECIENTE = 90;

export type Flota = "propia" | "tercero";

/**
 * La familia del combustible del PARÁMETRO, o null si no se reconoce.
 *
 * NUNCA `familiaCombustible()`: ese normaliza a minúsculas y **cae a diésel ante cualquier
 * valor desconocido**. Para leer es inocuo; aquí decide si una mediana de GLP puede
 * sustituir el rendimiento de un tipo diésel, o sea decide precios. El `<select>` de la
 * pantalla se llena de `precios_combustible.tipo`, así que basta con que alguien agregue una
 * fila `"Gasohol 90"` para que ese tipo reporte familia diésel y se le ofrezca la mediana de
 * otra unidad. Sin coincidencia explícita: null, y el tipo sale `familia_desconocida`.
 */
const FAMILIA_DE_TIPO: Record<string, string> = {
  "diésel": "diesel", "diesel": "diesel",
  "gasolina": "gasolina",
  "glp": "glp",
  "gnv": "gnv",
};

export function familiaDeParametro(tipo: string | null | undefined): string | null {
  const t = String(tipo ?? "").trim().toLowerCase();
  return t in FAMILIA_DE_TIPO ? FAMILIA_DE_TIPO[t] : null;
}

/** Una placa que apunta a un tipo de costeo, con su serie ya resuelta por el cargador. */
export type PlacaMedida = {
  /** La MISMA clave sintética que usa /combustible: los ids de las dos flotas se solapan. */
  uid: string;
  vehiculoId: number;
  placa: string;
  flota: Flota;
  /** El texto CRUDO de `tipo_vehiculo_costeo`. No se normaliza al leer: la clave se
   *  normaliza al CREAR el tipo y en ningún otro sitio; hacerlo aquí inventaría una tercera
   *  identidad, que es el patrón que este repo ya pagó tres veces en un solo día. */
  tipoCosteo: string | null;
  familia: string;
  /** "km/gal" | "km/m³", de `resumen.label`. Nunca un literal. */
  label: string;
  /** Mediana de TODO el historial de esa placa en esa familia. */
  mediana: number | null;
  /** TRAMOS medidos, no cargas: 10 cargas con un hueco dan 8 tramos. */
  tramos: number;
  confiable: boolean;
  medianaReciente: number | null;
  tramosReciente: number;
  /** `juzgarTramo` → `rendimiento_alto` no físico: la sospecha de que faltan cargas. */
  tramosAltos: number;
  tramosBajos: number;
  cargasSinOdometro: number;
  /** Lo que quedó fuera de la mediana, para poder enseñarlo TACHADO en vez de esconderlo. */
  descartes: { fecha: string; codigo: MotivoSinRendimiento; crudo: number | null }[];
  desde: string | null;
  hasta: string | null;
};

/** La última decisión humana sobre este tipo, DERIVADA de `historial_costos`. */
export type Procedencia = {
  origen: "manual" | "medido";
  fecha: string | null;
  por: string | null;
  /** El medido que alguien revisó y decidió NO adoptar. */
  descartado: number | null;
};

export const SIN_PROCEDENCIA: Procedencia = { origen: "manual", fecha: null, por: null, descartado: null };

export type CodigoAgregado =
  /** Hay número proponible. Es el ÚNICO código con botón. */
  | "medido"
  /** El tecleado ya está a menos de PASO_RENDIMIENTO del medido: no hay nada que aplicar. */
  | "coincide"
  /** Una persona revisó esta misma medición y decidió no adoptarla. */
  | "descartado"
  /** Alguna votante tiene tramos que rindieron de MÁS: la sospecha es que faltan cargas. */
  | "revisar_cargas"
  /** Dos o más placas lo miden: se enseñan las dos y decide una persona. */
  | "varias_placas"
  /** Ninguna unidad apunta a este tipo. */
  | "sin_placas"
  /** Hay placas, ninguna con mediana. */
  | "sin_medicion"
  /** Hay mediana, ninguna llega a MIN_TRAMOS_CONFIABLE tramos. */
  | "pocos_tramos"
  /** La única evidencia es de flota ajena. */
  | "solo_terceros"
  /** Lo medido no es del combustible del parámetro. */
  | "familia_distinta"
  /** `tipo_combustible_1` no está en el catálogo. */
  | "familia_desconocida"
  /** El tipo usa dos combustibles: `rendimiento_1` no explica todo el consumo. */
  | "tipo_bimodal";

export type ParametroTipo = {
  tipo_vehiculo: string;
  nombre: string;
  rendimiento_1: number;
  tipo_combustible_1: string;
  tipo_combustible_2?: string | null;
  pct_uso_2?: number | null;
};

export type AgregadoTipo = {
  tipoVehiculo: string;
  nombre: string;
  codigo: CodigoAgregado;
  /** INVARIANTE 1: `proponible === (codigo === "medido")`. La matriz la fija. */
  proponible: boolean;
  parametro: number;
  familiaParametro: string | null;
  /** La unidad del PARÁMETRO, que es en la que se costea. Nunca un literal. */
  label: string | null;
  /** INVARIANTE 2: no es null exactamente para los cinco códigos que tienen número
   *  (medido · coincide · descartado · revisar_cargas · varias_placas). */
  medido: number | null;
  medidoHistorico: number | null;
  medidoReciente: number | null;
  /** Cuál de las dos ventanas ganó por ser la MENOR. */
  ventanaElegida: "historico" | "reciente" | null;
  /** `(medido − parametro) / parametro`. null si `parametro <= 0` — jamás Infinity. */
  desvio: number | null;
  /** Las que votaron. */
  aportan: PlacaMedida[];
  /** Las que se ven y NO votan, con su motivo. Disjunta de `aportan` y exhaustiva con ella. */
  observadas: { placa: PlacaMedida; motivo: CodigoAgregado }[];
  /** Quién hereda este número sin medirlo: propias sin cargas y TODAS las de tercero. */
  heredan: { placa: string; flota: Flota; motivo: string }[];
  procedencia: Procedencia;
  /** De dónde salió, y si no salió, DÓNDE se arregla. Ninguna pantalla lo redacta. */
  detalle: string;
};

// ─── LA MEDIANA ───────────────────────────────────────────────────────────────

function medianaDe(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const red2 = (n: number) => Math.round(n * 100) / 100;

// ─── EL AGREGADO ──────────────────────────────────────────────────────────────

/**
 * Qué mide la flota para este tipo, y si se puede proponer.
 *
 * El orden de las comprobaciones va de lo ESTRUCTURAL a lo estadístico, igual que los
 * descartes de `serieRendimiento`: a un tipo bimodal no le va a servir una medición nunca,
 * así que decirlo gana sobre decir que hoy faltan cargas.
 */
export function agregarRendimientoTipo(
  parametro: ParametroTipo,
  placas: PlacaMedida[],
  procedencia: Procedencia = SIN_PROCEDENCIA
): AgregadoTipo {
  const familiaParam = familiaDeParametro(parametro.tipo_combustible_1);
  const base = {
    tipoVehiculo: parametro.tipo_vehiculo,
    nombre: parametro.nombre,
    parametro: parametro.rendimiento_1,
    familiaParametro: familiaParam,
    label: null as string | null,
    medido: null as number | null,
    medidoHistorico: null as number | null,
    medidoReciente: null as number | null,
    ventanaElegida: null as "historico" | "reciente" | null,
    desvio: null as number | null,
    aportan: [] as PlacaMedida[],
    observadas: [] as { placa: PlacaMedida; motivo: CodigoAgregado }[],
    heredan: [] as { placa: string; flota: Flota; motivo: string }[],
    procedencia,
  };
  const no = (codigo: CodigoAgregado, detalle: string, extra: Partial<AgregadoTipo> = {}): AgregadoTipo => ({
    ...base, codigo, proponible: false, detalle, ...extra,
  });

  // 1 · BIMODAL. La fórmula de lib/costeo-propio.ts es
  //     `(precio1/rend1)*pct_uso_1 + (precio2/rend2)*pct_uso_2`, así que `rendimiento_1`
  //     significa "km por galón del combustible 1 SOBRE LOS KM HECHOS CON EL COMBUSTIBLE 1".
  //     La mediana medida es Δodómetro ÷ galones de una familia, y el odómetro no sabe de qué
  //     tanque salieron los km: sale inflada ~1/pct_uso_1 y la fórmula la vuelve a multiplicar
  //     por pct_uso_1. Con un 60/40 eso costea el combustible a la mitad.
  if (parametro.tipo_combustible_2 && Number(parametro.pct_uso_2) > 0) {
    return no("tipo_bimodal",
      "Este tipo consume dos combustibles y su rendimiento tecleado solo describe el primero. " +
      "Una mediana medida no dice cuántos km hizo con cada uno, así que no se puede proponer.");
  }

  // 2 · FAMILIA DESCONOCIDA. Sin saber en qué unidad está el parámetro no hay con qué comparar.
  if (!familiaParam) {
    return no("familia_desconocida",
      `El combustible del tipo ("${parametro.tipo_combustible_1}") no está en el catálogo, así que ` +
      "el ERP no sabe en qué unidad se mide su rendimiento. Se corrige en el desplegable de Combustible.");
  }

  // La unidad que se publica es la del PARÁMETRO, que es en la que se costea. Se toma de una
  // placa que mida esa familia; sin ninguna, del catálogo — nunca un "km/gal" literal, que es
  // el bug que el PR anterior arregló en el renglón del presupuesto.
  const label = placas.find((p) => p.familia === familiaParam)?.label ?? labelDeFamilia(familiaParam);
  base.label = label;

  if (!placas.length) {
    return no("sin_placas",
      "Ninguna unidad de la flota tiene este tipo asignado como su categoría de costeo, así que " +
      "nadie lo mide. Se asigna en la ficha de la unidad (/vehiculos → Editar → Categoría de costeo).");
  }

  // 3 · EL REPARTO. `aportan` y `observadas` son disjuntas y cubren TODAS las placas: un
  //     filtro silencioso aquí sería una placa que se ve en la flota y no se explica en ningún
  //     sitio de la pantalla.
  const aportan: PlacaMedida[] = [];
  const observadas: { placa: PlacaMedida; motivo: CodigoAgregado }[] = [];
  const heredan: { placa: string; flota: Flota; motivo: string }[] = [];

  // Una placa BICOMBUSTIBLE llega con DOS series (la CWQ400: glp y gasolina), porque las
  // cadenas se arman por (unidad, familia). Aquí es UNA unidad: se queda con la serie de la
  // familia del parámetro si la tiene, y si no con la de más tramos, que es la que mejor
  // describe lo que esa unidad consume. Sin colapsar, la misma placa saldría dos veces en la
  // pantalla y contaría dos votos.
  const porUid = new Map<string, PlacaMedida[]>();
  for (const p of placas) {
    if (!porUid.has(p.uid)) porUid.set(p.uid, []);
    porUid.get(p.uid)!.push(p);
  }
  const unaPorPlaca = [...porUid.values()].map((ss) =>
    ss.find((s) => s.familia === familiaParam) ??
    [...ss].sort((a, b) => b.tramos - a.tramos)[0]
  );

  for (const p of unaPorPlaca) {
    // SOLO VOTAN LAS PROPIAS. `vehiculos_tercero.tipo_vehiculo_costeo` apunta a LAS MISMAS
    // filas de `parametros_costos` —no hay espacio de nombres— y un bus ajeno, con conductor
    // ajeno y mantenimiento ajeno, mide otra cosa. Además a un tercero se le paga por factura,
    // no por kilómetro. Se MUESTRAN, no mueven la mediana.
    if (p.flota === "tercero") {
      observadas.push({ placa: p, motivo: "solo_terceros" });
      heredan.push({ placa: p.placa, flota: "tercero", motivo: "unidad de tercero: usa este costo, no lo mide" });
      continue;
    }
    if (p.familia !== familiaParam) {
      observadas.push({ placa: p, motivo: "familia_distinta" });
      continue;
    }
    if (p.mediana === null) {
      observadas.push({ placa: p, motivo: "sin_medicion" });
      heredan.push({ placa: p.placa, flota: "propia", motivo: "sin tramos medidos todavía" });
      continue;
    }
    if (!p.confiable) {
      observadas.push({ placa: p, motivo: "pocos_tramos" });
      continue;
    }
    aportan.push(p);
  }

  base.aportan = aportan;
  base.observadas = observadas;
  base.heredan = heredan;

  if (!aportan.length) {
    // El motivo del TIPO es el de la placa que estuvo más cerca de votar: es el que nombra el
    // arreglo más próximo. Sin ninguna, el de la primera observada.
    const orden: CodigoAgregado[] = ["pocos_tramos", "sin_medicion", "familia_distinta", "solo_terceros"];
    const motivo = orden.find((m) => observadas.some((o) => o.motivo === m)) ?? "sin_medicion";
    const textos: Record<string, string> = {
      pocos_tramos:
        `Hay medición, pero ninguna unidad propia llega a ${MIN_TRAMOS_CONFIABLE} tramos medidos. ` +
        "Se cierra registrando cargas CON kilometraje en /combustible.",
      sin_medicion:
        "Las unidades propias de este tipo no tienen ningún tramo medido. Se cierra registrando " +
        "cargas con kilometraje: hacen falta dos cargas seguidas con odómetro para medir un tramo.",
      familia_distinta:
        "Lo que miden sus unidades es de OTRO combustible que el del tipo. O la unidad cambió de " +
        "combustible, o el tipo tiene mal el suyo — se corrige en el desplegable de Combustible.",
      solo_terceros:
        "Las únicas unidades con este tipo son de tercero. Su rendimiento no entra: a un proveedor " +
        "se le paga por factura, no por kilómetro, y su mantenimiento no es de AFA.",
    };
    return no(motivo, textos[motivo]);
  }

  // 4 · UNA PLACA, UN VOTO. Mediana de las MEDIANAS de placa, no del pool de tramos: agrupar
  //     tramos le daría triple peso a la unidad que reposta el triple de veces, y el tipo
  //     terminaría siendo "el rendimiento de la unidad que más carga".
  const historico = medianaDe(aportan.map((p) => p.mediana as number));
  const conReciente = aportan.filter((p) => p.medianaReciente !== null && p.tramosReciente >= MIN_TRAMOS_CONFIABLE);
  const reciente = conReciente.length ? medianaDe(conReciente.map((p) => p.medianaReciente as number)) : null;

  // 5 · SE PROPONE LA MENOR DE LAS DOS VENTANAS. Asimétrico del lado seguro y sin ningún
  //     umbral: un motor que se degradó hace seis meses no puede colarse con una mediana que
  //     la unidad ya no hace, que es el fallo de una ventana larga sola.
  const medido = reciente !== null && reciente < (historico as number) ? reciente : historico;
  const ventana: "historico" | "reciente" = medido === reciente && reciente !== null ? "reciente" : "historico";

  base.medido = medido === null ? null : red2(medido);
  base.medidoHistorico = historico === null ? null : red2(historico);
  base.medidoReciente = reciente === null ? null : red2(reciente);
  base.ventanaElegida = ventana;
  base.desvio = parametro.rendimiento_1 > 0 && medido !== null
    ? (medido - parametro.rendimiento_1) / parametro.rendimiento_1
    : null;

  const placasTxt = aportan.map((p) => p.placa).join(", ");
  const tramosTot = aportan.reduce((s, p) => s + p.tramos, 0);

  // 6 · EL GATE DE HALLAZGOS. `rendimiento_alto` significa "plata que FALTA EN LOS LIBROS":
  //     una carga comprada y consumida que nadie registró. Ese es exactamente el modo de fallo
  //     que INFLA la mediana sin dejar rastro —no deja `sin_odometro` ni `eslabon_saltado`,
  //     deja la cadena cerrada y el denominador corto—, y proponerlo bajaría el costo
  //     presupuestado por un agujero del propio registro. `rendimiento_bajo` NO bloquea: es
  //     costo real (mes pesado, ruta de cerro, sifoneo) y excluirlo sesgaría la mediana hacia
  //     arriba, o sea justo hacia el error que no vuelve.
  const altos = aportan.reduce((s, p) => s + p.tramosAltos, 0);
  if (altos > 0) {
    const conAltos = aportan.filter((p) => p.tramosAltos > 0).map((p) => `${p.placa} (${p.tramosAltos})`).join(", ");
    return no("revisar_cargas",
      `Se midió ${base.medido} ${label ?? ""} pero hay ${altos} tramo(s) que rindieron de MÁS — ${conAltos}. ` +
      "Eso no es buena noticia: significa que hay combustible comprado y consumido que no está " +
      "registrado, así que la mediana sale inflada. Revísalos en /combustible antes de usar este número.",
      { medido: base.medido, medidoHistorico: base.medidoHistorico, medidoReciente: base.medidoReciente,
        ventanaElegida: base.ventanaElegida, desvio: base.desvio, label });
  }

  // 7 · CON DOS O MÁS VOTANTES NO SE PROPONE: se enseñan y decide una persona. No hay umbral
  //     de dispersión, y es deliberado: con 3 placas propias no hay muestra con la que
  //     calibrarlo, y este repo mide sus umbrales o los hereda literales — elegir uno y
  //     llamarlo herencia sería inventarlo.
  if (aportan.length >= 2) {
    const detalle = aportan.map((p) => `${p.placa} ${red2(p.mediana as number)}`).join(" · ");
    return no("varias_placas",
      `Lo miden ${aportan.length} unidades y no dan lo mismo: ${detalle}. La mediana de las dos es ` +
      `${base.medido} ${label ?? ""}, pero cuál va al parámetro lo decides tú.`,
      { medido: base.medido, medidoHistorico: base.medidoHistorico, medidoReciente: base.medidoReciente,
        ventanaElegida: base.ventanaElegida, desvio: base.desvio, label });
  }

  // 8 · YA SE REVISÓ Y NO SE ADOPTÓ. Mientras el medido de hoy siga siendo el mismo, no se
  //     vuelve a proponer: un chip que reaparece cada mes con el número que ya se rechazó es
  //     paisaje. Si la medición se MUEVE más de un paso, vuelve — y debe volver.
  if (procedencia.descartado !== null && base.medido !== null &&
      Math.abs(procedencia.descartado - base.medido) < PASO_RENDIMIENTO) {
    return no("descartado",
      `Ya revisaste esta medición (${base.medido} ${label ?? ""}) y decidiste conservar el número tecleado. ` +
      "Vuelve a proponerse solo si lo medido se mueve.",
      { medido: base.medido, medidoHistorico: base.medidoHistorico, medidoReciente: base.medidoReciente,
        ventanaElegida: base.ventanaElegida, desvio: base.desvio, label });
  }

  // 9 · YA COINCIDEN. El paso es el del propio campo: por debajo de eso no hay nada que aplicar.
  if (base.medido !== null && Math.abs(base.medido - parametro.rendimiento_1) < PASO_RENDIMIENTO) {
    return no("coincide",
      `El número tecleado ya coincide con lo que mide ${placasTxt}.`,
      { medido: base.medido, medidoHistorico: base.medidoHistorico, medidoReciente: base.medidoReciente,
        ventanaElegida: base.ventanaElegida, desvio: base.desvio, label });
  }

  return {
    ...base,
    codigo: "medido",
    proponible: true,
    label,
    detalle:
      `${placasTxt} mide ${base.medido} ${label ?? ""} sobre ${tramosTot} tramo(s), contra los ` +
      `${parametro.rendimiento_1} tecleados.`,
  };
}

/** El agregado de cada tipo. Las placas se reparten por su `tipo_vehiculo_costeo` CRUDO. */
export function agregarPorTipo(
  parametros: ParametroTipo[],
  placas: PlacaMedida[],
  procedencias: Map<string, Procedencia> = new Map()
): Map<string, AgregadoTipo> {
  const porTipo = new Map<string, PlacaMedida[]>();
  for (const p of placas) {
    // Una placa sin categoría de costeo no entra a ningún cubo. NUNCA al cubo `null`: sería
    // un tipo fantasma que la pantalla tendría que aprender a esconder.
    const k = (p.tipoCosteo ?? "").trim();
    if (!k) continue;
    if (!porTipo.has(k)) porTipo.set(k, []);
    porTipo.get(k)!.push(p);
  }
  const out = new Map<string, AgregadoTipo>();
  for (const par of parametros) {
    out.set(par.tipo_vehiculo, agregarRendimientoTipo(
      par,
      porTipo.get(par.tipo_vehiculo) ?? [],
      procedencias.get(par.tipo_vehiculo) ?? SIN_PROCEDENCIA
    ));
  }
  return out;
}

// ─── TEXTOS ───────────────────────────────────────────────────────────────────

const ETIQUETAS: Record<CodigoAgregado, string> = {
  medido: "medido",
  coincide: "ya coincide",
  descartado: "revisado y no adoptado",
  revisar_cargas: "revisa las cargas",
  varias_placas: "lo miden varias unidades",
  sin_placas: "ninguna unidad lo mide",
  sin_medicion: "sin tramos medidos",
  pocos_tramos: "pocos tramos",
  solo_terceros: "solo unidades de tercero",
  familia_distinta: "mide otro combustible",
  familia_desconocida: "combustible no reconocido",
  tipo_bimodal: "usa dos combustibles",
};

/** Un código sin etiqueta imprime el código crudo — el bug de `multiples_recargas_en_cluster`. */
export function etiquetaAgregado(c: CodigoAgregado): string {
  return ETIQUETAS[c] ?? c;
}

/**
 * El motivo que va a `historial_costos`. El número DELANTE: esa columna se pinta truncada a
 * `max-w-[180px]`, así que lo que se corta tiene que ser lo prescindible.
 */
export function motivoHistorial(a: AgregadoTipo): string {
  const placas = a.aportan.map((p) => p.placa).join(", ");
  const tramos = a.aportan.reduce((s, p) => s + p.tramos, 0);
  return `Auto: medido ${a.medido} ${a.label ?? ""} · ${tramos} tramos · ${placas}`.replace(/\s+/g, " ").trim();
}

/** El `campo_modificado` de la fila que registra una medición REVISADA y no adoptada.
 *  No es una columna de `parametros_costos`: es un registro de decisión, no de cambio. */
export const CAMPO_DESCARTE = "rendimiento_1_medido";

/**
 * La procedencia, DERIVADA de `historial_costos`. No hay columnas nuevas: el hecho ya está
 * registrado una vez y copiarlo obligaría a mantener dos verdades y a explicar por qué
 * discrepan.
 *
 * Tres reglas, y la segunda arregla gratis un caso que con columnas habría que recordar:
 *  · la última fila de `rendimiento_1` cuyo motivo empieza por "Auto:" → origen medido;
 *  · si DESPUÉS de ella hay una de `tipo_combustible_1`, el sello CADUCA — `cambiarComb` no
 *    toca `rendimiento_1`, así que un tipo que pasó de diésel a GLP conservaría una marca de
 *    "medido" sobre un km/gal de diésel;
 *  · la última de `rendimiento_1_medido` es el descarte, y solo cuenta si es MÁS NUEVA que
 *    la última adopción.
 */
export function procedenciaDeHistorial(
  filas: {
    campo_modificado: string; valor_nuevo: number | null; motivo: string | null;
    cambiado_por: string | null; cambiado_en: string;
  }[]
): Procedencia {
  const orden = [...filas].sort((a, b) => String(a.cambiado_en).localeCompare(String(b.cambiado_en)));
  let out: Procedencia = { ...SIN_PROCEDENCIA };
  for (const f of orden) {
    if (f.campo_modificado === "rendimiento_1") {
      out = String(f.motivo ?? "").startsWith("Auto:")
        ? { origen: "medido", fecha: f.cambiado_en, por: f.cambiado_por, descartado: out.descartado }
        : { origen: "manual", fecha: f.cambiado_en, por: f.cambiado_por, descartado: out.descartado };
    } else if (f.campo_modificado === CAMPO_DESCARTE) {
      out = { ...out, descartado: f.valor_nuevo };
    } else if (f.campo_modificado === "tipo_combustible_1") {
      // El combustible del tipo cambió: ni la marca de "medido" ni el descarte describen ya
      // el mismo número. Los dos caducan.
      out = { origen: "manual", fecha: f.cambiado_en, por: f.cambiado_por, descartado: null };
    }
  }
  return out;
}

// ─── LA FICHA CONTRA LOS TANQUES DE LA UNIDAD ─────────────────────────────────
//
// POR QUÉ EXISTE. En `/vehiculos` y en `/tercerizadas` se elige la «Categoría de costeo» de
// una placa desde un desplegable que solo mostraba `nombre (clave)`. Con eso se le asignó
// MINIVAN_10 a una unidad que carga GLP sin que nada dijera que esa ficha costea en otro
// combustible — y el S/km de una categoría es `precio ÷ rendimiento`, así que con el
// combustible equivocado el renglón no está un 10 % desviado: está multiplicado por la razón
// entre dos precios que en esta flota se diferencian como 3 a 1.
//
// El dato para detectarlo ya estaba en el MISMO formulario: la capacidad de tanque que la
// unidad declara por familia. Por eso esto no lee la base ni mide nada — cruza dos campos que
// la persona tiene delante, que es la misma idea que la columna «Medido» de /configuracion/costos.
//
// NO DECIDE NADA NI ESCRIBE: devuelve un código. Una unidad bicombustible declara dos tanques
// y con cualquiera que calce la ficha está bien; y la ausencia de tanques declarados NO es una
// discrepancia —es que nadie los llenó todavía—, que es la misma regla de no afirmar un vacío
// mientras no hay evidencia.

export type CodigoCotejo =
  /** La familia de la ficha está entre los tanques que la unidad declara. */
  | "coincide"
  /** La unidad no declara ningún tanque de la familia con la que se le costea. */
  | "discrepa"
  /** La placa no tiene categoría de costeo asignada. */
  | "sin_ficha"
  /** La unidad no declaró ninguna capacidad de tanque: no hay con qué cotejar. */
  | "sin_tanques"
  /** El combustible de la ficha no está en el catálogo (mismo caso que `familia_desconocida`). */
  | "familia_desconocida";

export type CotejoFichaUnidad = {
  codigo: CodigoCotejo;
  /** La familia con la que COSTEA la ficha. */
  familiaFicha: string | null;
  /** Las familias que la unidad declara poder cargar. */
  familiasUnidad: string[];
  detalle: string;
};

/**
 * ¿El combustible de la ficha de costeo calza con lo que esa unidad puede cargar?
 *
 * @param tipoCombustibleFicha  `parametros_costos.tipo_combustible_1` — el texto del catálogo ("Diésel").
 * @param familiasDeclaradas    Las claves de `capacidad_tanque` con valor > 0.
 */
export function cotejarFichaConTanques(
  tipoCombustibleFicha: string | null | undefined,
  familiasDeclaradas: string[]
): CotejoFichaUnidad {
  const familias = [...new Set(familiasDeclaradas.map((f) => String(f ?? "").trim().toLowerCase()).filter(Boolean))];
  const crudo = String(tipoCombustibleFicha ?? "").trim();
  const base = { familiaFicha: null as string | null, familiasUnidad: familias };

  if (!crudo) {
    return { ...base, codigo: "sin_ficha", detalle: "Esta unidad no tiene categoría de costeo asignada, así que se cotiza con lo que se teclee a mano." };
  }
  const familia = familiaDeParametro(crudo);
  if (!familia) {
    return { ...base, codigo: "familia_desconocida",
      detalle: `El combustible de la ficha ("${crudo}") no está en el catálogo, así que no se puede cotejar con el tanque de la unidad.` };
  }
  if (!familias.length) {
    return { ...base, familiaFicha: familia, codigo: "sin_tanques",
      detalle: "La unidad no declara ninguna capacidad de tanque, así que no hay con qué comprobar que la ficha costee el combustible correcto." };
  }
  if (familias.includes(familia)) {
    return { ...base, familiaFicha: familia, codigo: "coincide", detalle: "" };
  }
  return { ...base, familiaFicha: familia, codigo: "discrepa",
    detalle:
      `Esta ficha costea en ${crudo}, pero la unidad declara tanque de ${familias.join(", ")}. ` +
      "El costo por km es precio ÷ rendimiento, así que con el combustible equivocado el renglón " +
      "sale mal por la diferencia entre dos precios, no por un porcentaje. Corrígelo en el " +
      "desplegable Combustible de /configuracion/costos, o revisa si esta unidad va en otra categoría.",
  };
}
