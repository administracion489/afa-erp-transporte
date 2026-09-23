// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-dinero.ts — CORREGIR EL DINERO DEL PERIODO DESDE EL CIERRE.
//
// `/liquidaciones` es la única pantalla que ve el dinero del mes entero, y era la
// única que no lo podía tocar salvo para RELLENAR lo que faltaba. Los dos modales
// masivos —`ModalCostos` y `ModalPrecios`— se abrían con `sinCosto.length > 0` /
// `sinPrecio.length > 0`, así que:
//
//   · un costo YA cargado y equivocado (S/ 664.41 donde se pactó S/ 480) no tenía
//     ningún camino en lote: había que abrir el detalle servicio por servicio;
//   · y en cuanto no faltaba ninguno el botón DESAPARECÍA, o sea que la pantalla
//     que sabe cuánto se le paga a cada proveedor en el mes no ofrecía cambiarlo.
//
// Renegociar una tarifa a mitad de mes se hacía, entonces, desde Programación y de a
// uno. Este módulo es lo que faltaba para hacerlo desde donde se ve.
//
// ─── LA REGLA QUE NO SE PUEDE AFLOJAR ───────────────────────────────────────────
//
//   EL IMPORTE ES DEL DÍA Y SE ESCRIBE EN UN SOLO TRAMO.
//
// AFA cobra (y paga) UNA tarifa por la ida y el retorno: el importe va en un tramo y
// el otro queda en S/ 0.00 a propósito, y la liquidación lee dos importes como DOS
// servicios. Es el error más caro de este ERP, y este módulo es justo el sitio donde
// más fácil se comete: un modal que aplica un importe a «22 servicios de la RUTA A»
// con un solo clic.
//
// ─── LO QUE ROMPÍA AL ABRIR EL MODAL A LOS IMPORTES YA CARGADOS ─────────────────
//
// Los dos modales elegían la cabeza del par con la misma regla escrita dos veces
// (`tramoQuePaga` en ModalCostos, `tramoQueCobra` en ModalPrecios): el tramo que se
// prestó; a igualdad, la ida. Es correcta, y era SUFICIENTE mientras el modal solo
// viera días con los dos tramos en S/ 0.00 — que es lo que garantizaba el filtro
// `sin_costo` / `sin_precio`.
//
// En cuanto el modal ve importes YA cargados deja de serlo, y de la peor forma: un
// día cuya tarifa vive en el RETORNO —porque la ida se canceló y el retorno sí
// corrió, que es un caso normal y documentado— recibiría el importe nuevo en la IDA.
// Los dos tramos con importe: el cobro doble, escrito por el ERP, en lote y sin que
// nadie lo pidiera.
//
// Por eso `tramoQueLlevaElImporte` va de la EVIDENCIA al juicio, igual que
// `tramoDelImporte` en lib/reservas-masivo.ts:
//
//   1. Los DOS ya llevan importe → no se toca. El día está duplicado desde antes y
//      el cierre ya lo denuncia; escribir encima lo TAPARÍA.
//   2. Lo lleva UNO → ese, aunque sea el retorno. «Qué tramo lleva el importe no es
//      siempre la ida»: es el que se prestó.
//   3. No lo lleva ninguno → la regla de los dos modales, extraída literal.
//   4. Todos cancelados → ninguno. Escribirle un importe a un tramo cancelado es
//      exactamente el huérfano que lib/reservas-cancelacion.ts existe para no crear.
//
// El paso 3 es el ÚNICO camino que el modal recorría hasta hoy, así que la sección 1
// de la matriz corre los dos originales copiados literales sobre la rejilla entera y
// exige resultado idéntico: si eso cambiara, la carga de costos faltantes de todos
// los cierres habría cambiado sin que nadie lo pidiera.
//
// ─── EL JUICIO ES SOBRE EL DÍA, LA ESCRITURA SOBRE EL TRAMO ─────────────────────
//
// El modal ya deduplica sus filas a una por día, pero la fila que enseña NO tiene por
// qué ser la que recibe el importe (paso 2). Por eso `planDeImportes` recibe el
// CONTEXTO —todos los tramos a la vista— y resuelve el día por su cuenta: el id que
// teclea la pantalla identifica el DÍA, no al destinatario.
//
// ─── PISAR UN IMPORTE NO ES LO MISMO QUE PONERLO ────────────────────────────────
//
// Rellenar un S/ 0.00 es completar un dato que falta. Cambiar S/ 664.41 por S/ 480 es
// mover plata que ya estaba pactada, y el acta es la única constancia de por qué. Por
// eso `requiereMotivo` se levanta SOLO cuando alguna escritura pisa un importe > 0 —
// mismo candado que `falso_flete_motivo`, `adicional_motivo` y el masivo del
// contrato— y la pantalla bloquea el botón con él. El caso de siempre (cargar lo que
// falta) sigue sin pedir nada: un peaje que sale siempre se vuelve paisaje.
//
// Matriz: npx tsx scripts/prueba-liquidacion-dinero.mts
// ──────────────────────────────────────────────────────────────────────────────

import { esCancelada, sentidoDeReserva } from "@/lib/liquidacion-agrupacion";
import type { LadoDinero } from "@/lib/reservas-masivo";

export type { LadoDinero };

/**
 * Lo que este motor necesita de una reserva. Deliberadamente más estrecho que
 * `ReservaLiq`: los dos modales le pasan proyecciones distintas (ModalCostos no pide
 * `precio_cliente`, ModalPrecios no pide `costo_proveedor`) y exigirles la reserva
 * entera obligaría a inventar campos.
 */
export type ServicioDinero = {
  id: number;
  codigo?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  direccion_servicio?: string | null;
  /** `sentidoDeReserva` cae al nombre cuando `direccion_servicio` viene vacío. */
  ruta_nombre?: string | null;
  estado?: string | null;
  reserva_vinculada_id?: number | null;
  precio_cliente?: number | null;
  costo_proveedor?: number | null;
};

/**
 * Por qué un día no recibe el importe que se tecleó. Cada uno se arregla en otro
 * sitio, así que la pantalla enruta por CÓDIGO y no olfateando el texto — igual que
 * los bloqueos del cierre y los motivos del masivo.
 */
export type MotivoDinero =
  /** Nadie tecleó nada para ese día. No es un problema: es el estado normal. */
  | "sin_importe"
  /** Lo tecleado es lo que ya dice la fila. Contarlo como cambio inflaría el número que firma una persona. */
  | "sin_cambio"
  /** El día ya tiene importe en sus DOS tramos. Viene mal de antes; taparlo no lo arregla. */
  | "dia_ya_duplicado"
  /** Todos los tramos del día están cancelados: escribirles un importe crea el huérfano. */
  | "sin_tramo_vivo";

export const TEXTO_MOTIVO_DINERO: Record<MotivoDinero, string> = {
  sin_importe: "sin importe tecleado",
  sin_cambio: "ya dice ese importe",
  dia_ya_duplicado:
    "el día ya tiene importe en sus DOS tramos — arréglalo desde el detalle del servicio antes de tocarlo acá",
  sin_tramo_vivo:
    "todos los tramos del día están cancelados: un importe ahí queda huérfano y suma al margen sin poder cobrarse",
};

/** Céntimos. Comparar en flotante daría `sin_cambio` falsos por 0.004. */
const redondear = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** El importe CRUDO de la fila, valga o no. Para comparar contra lo tecleado y para decirlo. */
export const importeDe = (r: ServicioDinero, lado: LadoDinero): number =>
  Number((lado === "precio" ? r.precio_cliente : r.costo_proveedor) ?? 0);

/** La columna autoritativa de cada lado. Es lo único que este módulo escribe. */
export const campoDe = (lado: LadoDinero): "precio_cliente" | "costo_proveedor" =>
  lado === "precio" ? "precio_cliente" : "costo_proveedor";

const sePresto = (r?: ServicioDinero | null) =>
  String(r?.estado ?? "").toLowerCase() === "finalizada";

/**
 * Los dos tramos de un día, resueltos por los DOS sentidos del enlace y solo cuando es
 * inequívoco — la misma regla que `lib/liquidacion-hermanos.ts` y que `indiceDelDia`
 * del masivo. `reserva_vinculada_id` se escribe en dos pasos y borrar un tramo deja el
 * del superviviente en NULL, así que seguirlo solo hacia adelante parte el día en dos:
 * y un día partido es, aquí, un día que cobra dos veces.
 */
export function indiceDelDia(contexto: ServicioDinero[]) {
  const porId = new Map(contexto.map((t) => [Number(t.id), t]));
  const cuantos = new Map<number, number>();
  for (const t of contexto) {
    const v = Number(t.reserva_vinculada_id ?? 0);
    if (v) cuantos.set(v, (cuantos.get(v) ?? 0) + 1);
  }
  // Con dos filas apuntando a la misma, el enlace está roto de otra forma y elegir
  // una sería adivinar en qué tramo se escribe dinero.
  const haciaAtras = new Map<number, ServicioDinero>();
  for (const t of contexto) {
    const v = Number(t.reserva_vinculada_id ?? 0);
    if (v && cuantos.get(v) === 1) haciaAtras.set(v, t);
  }
  const hermano = (t: ServicioDinero): ServicioDinero | null => {
    const v = Number(t.reserva_vinculada_id ?? 0);
    const h = (v ? porId.get(v) : undefined) ?? haciaAtras.get(Number(t.id)) ?? null;
    return h && Number(h.id) !== Number(t.id) ? h : null;
  };
  /** Los tramos de ese día: este y su hermano. Nunca más de dos. */
  const delDia = (t: ServicioDinero): ServicioDinero[] => {
    const h = hermano(t);
    return h ? [t, h] : [t];
  };
  return { hermano, delDia };
}

/**
 * QUÉ TRAMO DEL DÍA RECIBE EL IMPORTE. Devuelve UNO o NINGUNO — jamás "los dos".
 *
 * Es la pieza que impide el cobro doble desde esta pantalla, y el orden de sus cuatro
 * ramas es todo el módulo. Ver la cabecera: evidencia primero, juicio después.
 *
 * El paso 3 —el desempate cuando nadie lleva el importe— es la regla que vivía
 * DUPLICADA dentro de `ModalCostos.tramoQuePaga` y `ModalPrecios.tramoQueCobra`, y
 * está EXTRAÍDA, no reescrita: la sección 1 de la matriz corre las dos originales
 * copiadas literales sobre la rejilla entera y exige resultado idéntico salvo en las
 * DOS divergencias declaradas abajo, que verifica una por una.
 *
 * DIVERGENCIA 1 · UN TRAMO CANCELADO NUNCA ES DESTINATARIO. Las dos originales solo
 * miraban `finalizada`, así que con la ida cancelada y el retorno todavía programado
 * —ninguno de los dos prestado— el desempate por sentido le escribía el importe a la
 * CANCELADA. Eso es el importe huérfano que `lib/reservas-cancelacion.ts` existe para
 * no crear, y que `v_costo_servicio` y `v_egresos` leen sin preguntar si el servicio
 * se prestó. Hoy ese caso casi no llegaba al modal (un día así sale del cierre como
 * `cancelado_sin_pago`, no como `sin_costo`); con el modo periodo llega siempre.
 *
 * DIVERGENCIA 2 · EL SENTIDO SE RESUELVE UNA SOLA VEZ, con `sentidoDeReserva`.
 * `ModalCostos` tenía su propio `esRetorno` mirando SOLO `direccion_servicio`, así que
 * un servicio con ese campo vacío y `RETORNO` dentro del nombre de la ruta le salía
 * IDA. `ModalPrecios` ya usaba el canónico. Dos definiciones de «este tramo es la
 * vuelta» es exactamente el patrón que este repo paga caro.
 *
 * DIVERGENCIA 3 · EL ORDEN NO DECIDE A QUIÉN SE LE ESCRIBE DINERO. Cuando NINGUNO de
 * los dos candidatos es la ida —un día degenerado cuyos dos tramos dicen `retorno`—
 * las originales devolvían «el segundo», o sea el que no estaba iterando la pantalla:
 * el destinatario dependía de por cuál de los dos tramos entrara el modal. Las dos
 * salidas son igual de arbitrarias sobre un dato roto y ninguna duplica el importe,
 * así que se elige la ESTABLE (la del id menor), que es lo que compra la invariante de
 * la sección 11. Es el mismo fallo que `analizarServicios` ya tuvo que arreglar con su
 * índice inverso, y aquí lo que bailaba era a qué fila se le escribe plata.
 */
export function tramoQueLlevaElImporte(
  delDia: ServicioDinero[],
  lado: LadoDinero
): { tramo: ServicioDinero | null; motivo: MotivoDinero | null } {
  const conImporte = delDia.filter((t) => importeDe(t, lado) > 0);

  // 1. Duplicado de antes. El chip del cierre ya lo denuncia y escribir encima lo tapa.
  if (conImporte.length > 1) return { tramo: null, motivo: "dia_ya_duplicado" };

  // 2. Lo lleva uno: ese es, aunque sea el retorno y aunque esté cancelado — mover el
  //    importe de tramo NO es trabajo de este modal (eso es `ModalEnlaces` y el
  //    detalle del servicio), y escribirlo en el otro dejaría los dos con importe.
  if (conImporte.length === 1) return { tramo: conImporte[0], motivo: null };

  // 3. No lo lleva ninguno: la regla de los dos modales.
  const vivos = delDia.filter((t) => !esCancelada(t));
  if (!vivos.length) return { tramo: null, motivo: "sin_tramo_vivo" };
  if (vivos.length === 1) return { tramo: vivos[0], motivo: null };
  const prestados = vivos.filter(sePresto);
  if (prestados.length === 1) return { tramo: prestados[0], motivo: null };
  // Con los dos prestados (o ninguno), manda el sentido. El orden es ESTABLE y no
  // depende de por cuál de los dos tramos entró la pantalla: `analizarServicios` ya
  // tuvo que arreglar ese mismo fallo con su índice inverso, y aquí lo que baila con
  // el orden es a qué fila se le escribe dinero.
  const candidatos = (prestados.length ? prestados : vivos).slice().sort((x, y) => {
    const sx = sentidoDeReserva(x as any) === "RETORNO" ? 1 : 0;
    const sy = sentidoDeReserva(y as any) === "RETORNO" ? 1 : 0;
    return sx - sy || Number(x.id) - Number(y.id);
  });
  return { tramo: candidatos[0], motivo: null };
}

/** Un día al que el operador le puso un número: el id de CUALQUIERA de sus tramos. */
export type ImporteTecleado = { id: number; importe: number };

export type EntradaDinero = {
  lado: LadoDinero;
  /**
   * TODOS los tramos a la vista. El juicio del día se hace acá y no sobre las filas
   * tecleadas: la fila que el modal enseña puede no ser la que recibe el importe.
   */
  contexto: ServicioDinero[];
  tecleado: ImporteTecleado[];
};

export type EscrituraDinero = {
  /** El tramo que RECIBE el importe. No tiene por qué ser el id que se tecleó. */
  id: number;
  codigo?: string | null;
  fecha?: string | null;
  importe: number;
  antes: number;
  /** El id del día tal como lo enseña el modal, para poder señalar la fila. */
  idTecleado: number;
};

export type FueraDinero = {
  /** El id que se tecleó — que es el que la pantalla tiene que poder señalar. */
  id: number;
  codigo?: string | null;
  fecha?: string | null;
  motivo: MotivoDinero;
};

export type PlanDinero = {
  escribir: EscrituraDinero[];
  fuera: FueraDinero[];
  /** Alguna escritura PISA un importe > 0: entonces el motivo del acta es obligatorio. */
  requiereMotivo: boolean;
  /** Cuántas escrituras rellenan un S/ 0.00 y cuántas cambian un importe ya pactado. */
  nuevos: number;
  pisados: number;
  /** La plata, nombrada antes de autorizarla: de qué suma a qué suma. */
  totalAntes: number;
  totalDespues: number;
};

/**
 * El plan completo: a qué tramo se le escribe qué, y qué queda fuera con su porqué.
 *
 * `escribir` y `fuera` son DISJUNTOS y EXHAUSTIVOS sobre lo tecleado (la matriz lo
 * fija): un día que no saliera en ninguno de los dos sería un día que la pantalla no
 * explica en ningún sitio, y el operador se quedaría buscando en la base por qué su
 * importe no entró.
 */
export function planDeImportes(e: EntradaDinero): PlanDinero {
  const { delDia } = indiceDelDia(e.contexto);
  const porId = new Map(e.contexto.map((t) => [Number(t.id), t]));

  const escribir: EscrituraDinero[] = [];
  const fuera: FueraDinero[] = [];
  /** Un mismo día puede llegar dos veces (los dos tramos tecleados): se resuelve una. */
  const diasVistos = new Set<number>();

  for (const t of e.tecleado) {
    const fila = porId.get(Number(t.id));
    const ficha = { id: Number(t.id), codigo: fila?.codigo ?? null, fecha: fila?.fecha_servicio ?? null };

    const importe = Number(t.importe);
    if (!fila || !Number.isFinite(importe) || importe <= 0) {
      fuera.push({ ...ficha, motivo: "sin_importe" });
      continue;
    }

    const tramos = delDia(fila);
    // El día ya se resolvió por su otro tramo: no se juzga dos veces ni se escribe dos
    // veces. Sin esto, teclear los dos tramos del mismo día (posible en el modo
    // periodo, que los lista todos) produciría DOS escrituras sobre el mismo día.
    const clave = Math.min(...tramos.map((x) => Number(x.id)));
    if (diasVistos.has(clave)) { fuera.push({ ...ficha, motivo: "sin_cambio" }); continue; }

    const { tramo, motivo } = tramoQueLlevaElImporte(tramos, e.lado);
    if (!tramo) { fuera.push({ ...ficha, motivo: motivo ?? "sin_tramo_vivo" }); continue; }

    const antes = importeDe(tramo, e.lado);
    if (redondear(antes) === redondear(importe)) {
      fuera.push({ ...ficha, motivo: "sin_cambio" });
      continue;
    }

    diasVistos.add(clave);
    escribir.push({
      id: Number(tramo.id),
      codigo: tramo.codigo ?? null,
      fecha: tramo.fecha_servicio ?? null,
      importe: redondear(importe),
      antes: redondear(antes),
      idTecleado: Number(t.id),
    });
  }

  const pisados = escribir.filter((x) => x.antes > 0).length;
  return {
    escribir,
    fuera,
    requiereMotivo: pisados > 0,
    nuevos: escribir.length - pisados,
    pisados,
    totalAntes: redondear(escribir.reduce((a, x) => a + x.antes, 0)),
    totalDespues: redondear(escribir.reduce((a, x) => a + x.importe, 0)),
  };
}

/**
 * Los lotes que hay que mandar a `guardarReservas`: un UPDATE por importe distinto.
 *
 * Los servicios de una ruta comparten tarifa, así que un mes son dos o tres llamadas
 * y no 22 — que es lo que ya hacían los dos modales por su cuenta, conservado acá para
 * que la agrupación viva en el mismo sitio que la decisión.
 */
export function lotesDeEscritura(
  plan: PlanDinero,
  lado: LadoDinero,
  extra?: Record<string, any>
): { patch: Record<string, any>; ids: number[] }[] {
  const campo = campoDe(lado);
  const m = new Map<string, { patch: Record<string, any>; ids: number[] }>();
  for (const x of plan.escribir) {
    const patch = { [campo]: x.importe, ...(extra ?? {}) };
    const k = JSON.stringify(patch);
    const lote = m.get(k) ?? { patch, ids: [] };
    lote.ids.push(x.id);
    m.set(k, lote);
  }
  return [...m.values()];
}
