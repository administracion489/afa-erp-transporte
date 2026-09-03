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
  /** Sin enlace por ningún lado. Se dedujo por cliente + fecha + ruta + sentido contrario. */
  | "deducido";

export type Hermano = {
  tramo: ReservaLiq;
  procedencia: ProcedenciaHermano;
};

/** Un enlace que le falta a la base, con el UPDATE que lo arregla. */
export type EnlaceReparable = {
  tramo: ReservaLiq;
  hermano: ReservaLiq;
  procedencia: Exclude<ProcedenciaHermano, "enlace">;
};

export type IndiceHermanos = {
  /** El otro tramo por el ENLACE ESCRITO, mirando los DOS sentidos. null si no hay. */
  hermanoDe: (r: ReservaLiq) => ReservaLiq | null;
  /** El otro tramo DEDUCIDO, solo cuando no hay enlace escrito por ningún lado. */
  hermanoProbableDe: (r: ReservaLiq) => ReservaLiq | null;
  /** Cualquiera de los dos, diciendo de dónde salió. */
  de: (r: ReservaLiq) => Hermano | null;
  /** Los enlaces que hay que escribir para que la base deje de partir el día en dos. */
  reparables: EnlaceReparable[];
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
  const sueltas = universo.filter((r) => !vinculo(r) && !(apuntanA.get(r.id) ?? []).length);

  const porClave = new Map<string, { idas: ReservaLiq[]; retornos: ReservaLiq[] }>();
  for (const r of sueltas) {
    const k = claveDeducible(r);
    if (!k) continue;
    const bolsa = porClave.get(k) ?? { idas: [], retornos: [] };
    (sentidoDeReserva(r) === "RETORNO" ? bolsa.retornos : bolsa.idas).push(r);
    porClave.set(k, bolsa);
  }

  const deducidos = new Map<number, ReservaLiq>();
  for (const { idas, retornos } of porClave.values()) {
    // Una ida y un retorno: no hay nada que adivinar. Con dos móviles la misma ruta el
    // mismo día hay dos de cada uno y CUALQUIER emparejamiento sería inventado — se deja
    // para que un humano lo enlace desde Programación, que es donde se ve la unidad.
    if (idas.length !== 1 || retornos.length !== 1) continue;
    deducidos.set(idas[0].id, retornos[0]);
    deducidos.set(retornos[0].id, idas[0]);
  }

  const hermanoProbableDe = (r: ReservaLiq): ReservaLiq | null => deducidos.get(r.id) ?? null;

  const de = (r: ReservaLiq): Hermano | null => {
    const escrito = hermanoDe(r);
    if (escrito) return { tramo: escrito, procedencia: aMedias(r) ? "enlace_a_medias" : "enlace" };
    const probable = hermanoProbableDe(r);
    return probable ? { tramo: probable, procedencia: "deducido" } : null;
  };

  // ── Lo que hay que escribir para que la base deje de partir el día ────────
  const reparables: EnlaceReparable[] = [];
  const vistos = new Set<number>();
  for (const r of universo) {
    if (vistos.has(r.id)) continue;
    const h = de(r);
    if (!h || h.procedencia === "enlace") continue;
    vistos.add(r.id);
    vistos.add(h.tramo.id);
    reparables.push({ tramo: r, hermano: h.tramo, procedencia: h.procedencia });
  }

  return { hermanoDe, hermanoProbableDe, de, reparables };
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
