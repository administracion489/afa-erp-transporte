// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-hermanos.ts — "¿cuál es el OTRO tramo de este día?", en UN solo sitio.
//
// AFA cobra UNA tarifa por la ida y el retorno: el importe va en un tramo y el otro
// queda en S/ 0.00 a propósito. Todo el módulo de liquidaciones depende de poder
// contestar esa pregunta, y hasta ahora cada pantalla la contestaba por su cuenta
// siguiendo `reservas.reserva_vinculada_id` HACIA ADELANTE:
//
//     const par = r.reserva_vinculada_id ? porId.get(r.reserva_vinculada_id) : null;
//
// Eso da la respuesta correcta solo cuando el enlace está escrito en el lado que se está
// mirando. Y el enlace se escribe en DOS pasos (ModalGenerarPrograma: primero se insertan
// las idas, después los retornos apuntando a su ida, y recién al final se actualizan las
// idas apuntando a su retorno), así que basta con que el segundo paso falle —o con que
// alguien borre y regenere un tramo, que deja el enlace del superviviente en NULL
// (app/programacion/page.tsx, al eliminar)— para que quede escrito en un solo lado.
//
// Con el enlace a medias el ERP partía el día en dos:
//   · el retorno en S/ 0.00 salía del cierre como "Sin precio de venta" — pidiendo que
//     se cobre otra vez un día que su ida YA cobra: el error más caro de este módulo;
//   · el modal de servicios no mostraba "incluido en OS-…", así que quien lo abría a
//     arreglarlo veía un cero sin explicación e iba a escribirle una tarifa;
//   · y la ida quedaba contada como un servicio de un solo tramo.
//
// Este módulo resuelve el hermano por los DOS sentidos del enlace, y —solo para AVISAR y
// para ofrecer la REPARACIÓN, nunca para cobrar— deduce el par que perdió el enlace por
// completo. La deducción es la que ya vivía dentro de ModalPrecios, hoisted acá para que
// exista una sola definición de "estos dos tramos son el mismo día": la regla de oro del
// proyecto dice que un dato tiene UNA fila autoritativa, y la de este dato es
// `reserva_vinculada_id`. Por eso lo que se ofrece es REPARAR esa columna, no un flag
// nuevo de "va incluido" — sería un segundo sitio donde vive lo mismo, y el problema es
// justamente que al primero le faltan filas.
//
// La deducción NUNCA adivina: si en un día hay dos idas y dos retornos de la misma ruta
// (dos móviles), no hay forma de saber cuál va con cuál y no se empareja nada.
// ──────────────────────────────────────────────────────────────────────────────

import {
  etiquetaRutaDetalle, sentidoDeReserva,
  type LadoLiquidacion, type ReservaLiq,
} from "@/lib/liquidacion-agrupacion";

/**
 * De dónde salió el hermano. Importa: `enlace` es un dato escrito, `deducido` es una
 * conjetura que solo sirve para avisar y para ofrecer el arreglo.
 */
export type ProcedenciaHermano =
  /** `reserva_vinculada_id` escrito en los dos lados: el caso normal. */
  | "enlace"
  /** Escrito en un solo lado. El par es real, pero la base quedó a medias y hay que repararla. */
  | "enlace_a_medias"
  /** Sin enlace por ningún lado. Se dedujo, y solo porque ese día esa ruta salió UNA vez. */
  | "deducido";

export type Hermano = {
  tramo: ReservaLiq;
  procedencia: ProcedenciaHermano;
};

/**
 * Los otros tramos de la misma ruta, el mismo día y del mismo cliente. Es el CONTEXTO sin
 * el cual no se puede verificar una propuesta.
 *
 * Existe por un falso positivo real: el 22-08 la RUTA B salió con DOS móviles, y como dos
 * de los cuatro tramos ya tenían enlace, los otros dos quedaban como los únicos sueltos y
 * el ERP los proponía como par. Se veían perfectos —mismo cliente, mismo día, misma ruta,
 * sentidos contrarios, extremos invertidos— y eran de móviles distintos. Contar los que
 * SOBRAN no dice nada; hay que contar los del DÍA.
 */
export type Candidatura = {
  /** Todos los tramos de ese cliente, ese día y esa ruta — los enlazados incluidos. */
  delDia: ReservaLiq[];
  /** Los del sentido contrario: los únicos que pueden ser su hermano. */
  candidatos: ReservaLiq[];
  /**
   * El hermano que se puede proponer SIN adivinar: solo cuando ese día esa ruta tiene
   * exactamente una ida y un retorno, y los dos están sueltos. null = lo elige un humano.
   */
  seguro: ReservaLiq | null;
};

/** Un enlace que le falta a la base. `propuesto` en null = el operador tiene que elegirlo. */
export type EnlacePendiente = {
  tramo: ReservaLiq;
  propuesto: ReservaLiq | null;
  /** `ambiguo` = hay más de un móvil ese día y el ERP no elige por ti. */
  procedencia: Exclude<ProcedenciaHermano, "enlace"> | "ambiguo";
  candidatos: ReservaLiq[];
  delDia: ReservaLiq[];
};

export type IndiceHermanos = {
  /** El otro tramo por el ENLACE ESCRITO, mirando los DOS sentidos. null si no hay. */
  hermanoDe: (r: ReservaLiq) => ReservaLiq | null;
  /** El otro tramo DEDUCIDO, y solo cuando no hay nada que adivinar. */
  hermanoProbableDe: (r: ReservaLiq) => ReservaLiq | null;
  /** Suelto, con candidatos, pero con más de un móvil ese día: los devuelve para que elija un humano. */
  candidatosAmbiguosDe: (r: ReservaLiq) => ReservaLiq[] | null;
  /** El contexto del día para poder verificar una propuesta. */
  candidaturaDe: (r: ReservaLiq) => Candidatura;
  /** Cualquiera de los dos, diciendo de dónde salió. */
  de: (r: ReservaLiq) => Hermano | null;
  /** Lo que hay que enlazar para que la base deje de partir el día en dos. */
  pendientes: EnlacePendiente[];
};

/** El enlace escrito de esta fila, si lo tiene. */
const vinculo = (r: ReservaLiq): number => Number(r.reserva_vinculada_id ?? 0);

/**
 * Clave de la RUTA CONTRATADA para deducir el par: cliente + día + etiqueta de ruta.
 *
 * La hora NO entra (la ida y el retorno tienen horas distintas por definición) y el
 * nombre completo tampoco (son dos textos independientes: "RUTA B/ ENTRADA 05:10/…" y
 * "RUTA B/ RETORNO 17:00/…"). Queda la etiqueta, que es lo único que los dos tramos
 * comparten.
 *
 * Y se exige que la etiqueta venga del NOMBRE de la ruta: el respaldo de
 * `etiquetaRutaDetalle` compone "ORIGEN → DESTINO", que en la ida y el retorno está
 * invertido, así que emparejar por ahí sería emparejar por casualidad.
 */
function claveDeducible(r: ReservaLiq): string | null {
  if (!r.cliente_id) return null;
  const fecha = String(r.fecha_servicio ?? "").slice(0, 10);
  if (!fecha) return null;
  const { etiqueta, fuente } = etiquetaRutaDetalle(r);
  if (fuente !== "nombre") return null;
  return `${r.cliente_id}|${fecha}|${etiqueta}`;
}

/**
 * Arma el índice sobre un universo de reservas (normalmente, TODO el periodo del cierre).
 *
 * Lo que se le pase es lo que va a poder ver: si se le pasa solo el grupo de un cliente,
 * un hermano que quedó fuera del grupo seguirá siendo invisible. En /liquidaciones se le
 * pasa el periodo completo a propósito, porque el hermano puede estar fuera del cierre
 * (ya liquidado en otro documento, por ejemplo) y eso hay que poder DECIRLO en vez de
 * reclamar una tarifa.
 */
export function indiceHermanos(universo: ReservaLiq[]): IndiceHermanos {
  const porId = new Map<number, ReservaLiq>(universo.map((r) => [r.id, r]));

  // ── Enlace escrito, en los dos sentidos ───────────────────────────────────
  /** id → las filas que LO apuntan. Es la mitad que faltaba. */
  const apuntanA = new Map<number, ReservaLiq[]>();
  for (const r of universo) {
    const otro = vinculo(r);
    if (!otro) continue;
    const ya = apuntanA.get(otro);
    if (ya) ya.push(r);
    else apuntanA.set(otro, [r]);
  }

  /** El hermano por el enlace hacia adelante. */
  const adelante = (r: ReservaLiq): ReservaLiq | null => {
    const otro = vinculo(r);
    return otro ? porId.get(otro) ?? null : null;
  };

  /**
   * El hermano por el enlace hacia atrás, y SOLO si es inequívoco: con dos filas
   * apuntando a la misma, el enlace está roto de otra forma y elegir una sería adivinar.
   */
  const atras = (r: ReservaLiq): ReservaLiq | null => {
    const quienes = apuntanA.get(r.id) ?? [];
    return quienes.length === 1 ? quienes[0] : null;
  };

  const hermanoDe = (r: ReservaLiq): ReservaLiq | null => adelante(r) ?? atras(r);

  /** El enlace está escrito solo en un lado: el par funciona, pero la base hay que arreglarla. */
  const aMedias = (r: ReservaLiq): boolean => {
    const h = hermanoDe(r);
    if (!h) return false;
    return vinculo(r) !== h.id || vinculo(h) !== r.id;
  };

  // ── Deducción: los pares que perdieron el enlace por completo ─────────────
  //
  // Solo entran las filas SIN enlace por ningún lado: una fila que ya apunta a alguien
  // (o a la que apuntan) tiene su par escrito, y reemplazarlo por una conjetura rompería
  // un dato bueno.
  const libre = (r: ReservaLiq) => !vinculo(r) && !(apuntanA.get(r.id) ?? []).length;

  // El grupo lleva TODOS los tramos de esa ruta ese día, enlazados incluidos. Contar solo
  // los sueltos era el falso positivo: con la ruta saliendo con dos móviles y dos de los
  // cuatro tramos ya enlazados, los otros dos parecían "los únicos" y se proponían como
  // par siendo de móviles distintos. Los que sobran no dicen cuántas veces salió la ruta.
  const porClave = new Map<string, ReservaLiq[]>();
  for (const r of universo) {
    const k = claveDeducible(r);
    if (!k) continue;
    const bolsa = porClave.get(k);
    if (bolsa) bolsa.push(r);
    else porClave.set(k, [r]);
  }
  const grupoDe = (r: ReservaLiq): ReservaLiq[] => {
    const k = claveDeducible(r);
    return (k && porClave.get(k)) || [];
  };

  const candidaturaDe = (r: ReservaLiq): Candidatura => {
    const delDia = grupoDe(r);
    const candidatos = delDia.filter((x) => x.id !== r.id && sentidoDeReserva(x) !== sentidoDeReserva(r));
    if (!libre(r) || !delDia.length) return { delDia, candidatos, seguro: null };

    // La regla dura: ese día esa ruta salió UNA vez —una ida y un retorno en total— y los
    // dos están sueltos. Cualquier otra cosa (dos móviles, un tramo de más, el candidato
    // ya enlazado a un tercero) es una elección entre varias, y elegir por el operador es
    // escribir dinero en el tramo equivocado.
    const idas = delDia.filter((x) => sentidoDeReserva(x) !== "RETORNO");
    const retornos = delDia.filter((x) => sentidoDeReserva(x) === "RETORNO");
    if (idas.length !== 1 || retornos.length !== 1) return { delDia, candidatos, seguro: null };
    const otro = candidatos[0];
    return { delDia, candidatos, seguro: otro && libre(otro) ? otro : null };
  };

  const hermanoProbableDe = (r: ReservaLiq): ReservaLiq | null => candidaturaDe(r).seguro;

  /** Suelto y con candidatos, pero el día tiene más de un móvil: lo elige un humano. */
  const candidatosAmbiguosDe = (r: ReservaLiq): ReservaLiq[] | null => {
    if (!libre(r)) return null;
    const { candidatos, seguro } = candidaturaDe(r);
    return !seguro && candidatos.length ? candidatos : null;
  };

  const de = (r: ReservaLiq): Hermano | null => {
    const escrito = hermanoDe(r);
    if (escrito) return { tramo: escrito, procedencia: aMedias(r) ? "enlace_a_medias" : "enlace" };
    const probable = hermanoProbableDe(r);
    return probable ? { tramo: probable, procedencia: "deducido" } : null;
  };

  // ── Lo que hay que enlazar ────────────────────────────────────────────────
  //
  // Un par conocido (enlace a medias o deducido sin adivinar) es UNA fila. Un tramo suelto
  // con varios candidatos es una fila POR TRAMO, porque cada uno necesita su elección.
  const pendientes: EnlacePendiente[] = [];
  const vistos = new Set<number>();
  for (const r of universo) {
    if (vistos.has(r.id)) continue;
    const { delDia, candidatos } = candidaturaDe(r);
    const h = de(r);
    if (h && h.procedencia !== "enlace") {
      vistos.add(r.id);
      vistos.add(h.tramo.id);
      pendientes.push({ tramo: r, propuesto: h.tramo, procedencia: h.procedencia, candidatos, delDia });
      continue;
    }
    if (h) continue;                       // enlazado por los dos lados: nada que hacer
    const ambiguos = candidatosAmbiguosDe(r);
    if (!ambiguos) continue;               // suelto sin ningún candidato: no es cosa del enlace
    vistos.add(r.id);
    pendientes.push({ tramo: r, propuesto: null, procedencia: "ambiguo", candidatos: ambiguos, delDia });
  }

  return { hermanoDe, hermanoProbableDe, candidatosAmbiguosDe, candidaturaDe, de, pendientes };
}

export type ResultadoReparacion = {
  /** Pares que quedaron enlazados por los dos lados. */
  reparados: number;
  /** Los que no, con el porqué. */
  errores: string[];
};

/**
 * Escribe el enlace que falta, en LOS DOS LADOS.
 *
 * Bidireccional a propósito: `reserva_vinculada_id` se lee hacia adelante en media
 * docena de sitios del ERP (Programación, las notificaciones, la descarga masiva), así
 * que dejarlo a medias arregla el cierre y deja el resto igual de roto. Escribir el lado
 * que ya está bien es un UPDATE de más y ningún riesgo.
 *
 * No hay transacción: si falla el segundo UPDATE el par queda como estaba —enlazado por
 * un lado, que es exactamente de donde venía—, y el error dice cuál fue.
 */
export async function repararEnlaces(
  sb: any,
  /** Lo mínimo para escribir el enlace y poder nombrar la fila que falle. */
  pares: { tramo: { id: number; codigo?: string | null }; hermano: { id: number; codigo?: string | null } }[]
): Promise<ResultadoReparacion> {
  let reparados = 0;
  const errores: string[] = [];
  for (const { tramo, hermano } of pares) {
    const ref = (x: { id: number; codigo?: string | null }) => x.codigo ?? `#${x.id}`;

    // Antes de escribir, se SUELTA a quien apuntaba a cualquiera de los dos. Corregir un
    // par mal enlazado (el caso de los dos móviles que se cruzaron) deja si no un tercero
    // apuntando a un tramo que ya tiene otro hermano: un enlace de tres puntas que las
    // pantallas leen distinto según por dónde entren.
    for (const [yo, mi] of [[tramo, hermano], [hermano, tramo]] as const) {
      const s = await sb.from("reservas")
        .update({ reserva_vinculada_id: null })
        .eq("reserva_vinculada_id", yo.id).neq("id", mi.id);
      if (s.error) { errores.push(`soltar los enlaces viejos de ${ref(yo)}: ${s.error.message}`); }
    }

    const a = await sb.from("reservas").update({ reserva_vinculada_id: hermano.id }).eq("id", tramo.id);
    if (a.error) { errores.push(`${ref(tramo)}: ${a.error.message}`); continue; }
    const b = await sb.from("reservas").update({ reserva_vinculada_id: tramo.id }).eq("id", hermano.id);
    if (b.error) { errores.push(`${ref(hermano)}: ${b.error.message}`); continue; }
    reparados += 1;
  }
  return { reparados, errores };
}

/** Importe de una reserva según el lado que se esté liquidando. */
export function montoDeTramo(r: ReservaLiq | null | undefined, lado: LadoLiquidacion): number {
  if (!r) return 0;
  return Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
}

/**
 * ¿Este tramo va en S/ 0.00 porque su hermano lleva la tarifa del día?
 *
 * Es la pregunta que decide si un cero es un dato que FALTA o un dato CORRECTO, y la que
 * el cierre contestaba mal cuando el enlace estaba a medias.
 */
export function loCubreSuHermano(
  r: ReservaLiq,
  hermano: ReservaLiq | null | undefined,
  lado: LadoLiquidacion
): boolean {
  return montoDeTramo(r, lado) <= 0 && montoDeTramo(hermano, lado) > 0;
}
