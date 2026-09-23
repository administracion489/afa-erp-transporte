// ══════════════════════════════════════════════════════════════════════════════
// lib/ocupacion/semanal.ts
// CUÁNTO DEL BUS CONTRATADO SE USÓ, y si cabría en uno más chico. Módulo PURO.
//
// Lo pidió el dueño así: «cada sábado al finalizar el día, un reporte de los
// últimos 7 días con el detalle de pasajeros embarcados sobre la capacidad
// contratada, con una sugerencia de cambio de vehículo — pero si embarcaron 12 y
// el contratado es de 15 no se sugiere nada, porque el vehículo menor es de 10».
//
// ─── LAS CINCO DECISIONES QUE SOSTIENEN EL MÓDULO ───────────────────────────
//
// 1 · SE MIDE EL PICO, JAMÁS EL PROMEDIO. Con 12 de lunes a viernes y 28 el
//     sábado, el promedio son ~15 y una unidad de 20 "cabría" — y el sábado ocho
//     personas se quedan en el paradero. El promedio se PUBLICA (es útil para
//     leer la ocupación típica) pero no decide nada. La asimetría es la de
//     siempre: cobrar de menos se corrige con una nota de crédito; dejar gente
//     en tierra no se deshace.
//
// 2 · UN MANIFIESTO VACÍO NO ES UN CERO. `embarcados = 0` con el manifiesto sin
//     llenar significa «nadie lo registró», no «nadie viajó». Contarlo hundiría
//     el pico y el ERP propondría encoger un bus lleno. Los servicios sin
//     manifiesto quedan FUERA de la medición, se CUENTAN aparte, y si son
//     demasiados no se propone nada (`cobertura_baja`). Es el mismo cero que el
//     Anexo 1 tuvo que dejar de imprimir.
//
// 3 · LA ESCALERA SALE DE LA FLOTA, NO DE UNA LISTA EN EL CÓDIGO. Las capacidades
//     son las de `parametros_costos` (las categorías que AFA sabe cotizar y
//     asignar), así que dar de alta una unidad nueva cambia lo que el reporte
//     puede proponer sin tocar una línea. Sin escalera NO se propone nada — no se
//     inventa un vehículo que la empresa no tiene.
//
// 4 · SE PROPONE, NO SE APLICA. Nada de esto cambia un contrato, un precio ni una
//     reserva: es un correo con la evidencia al lado (el pico, el día en que
//     ocurrió, los asientos que sobrarían). Firma una persona, igual que la
//     columna «Medido» de /configuracion/costos.
//
// 5 · SE AGRUPA POR NOMBRE DE RUTA, Y PARTIR ES EL ERROR SEGURO. Se usa
//     `normalizarNombreRuta` —la MISMA definición de «esta ruta y esta son la
//     misma» que usa el catálogo `cliente_ruta` y su índice único— y NO la unión
//     por cercanía de `agruparPorRutaContratada`, que además junta por los
//     extremos en el mapa. Consecuencia declarada: una ruta escrita de dos formas
//     sale en DOS filas. Eso es visible y conservador (el operador ve los dos
//     picos y decide); fundir dos rutas distintas produciría un pico ajeno y una
//     sugerencia falsa, que es lo que no se puede permitir.
//
// El CONTRATADO entra en la clave por la misma razón que el pax entra en el cubo
// de `agruparPorRutaContratada`: una fila imprime UN «de N contratados», así que
// mezclar dos capacidades obliga a imprimir un número que nadie pactó.
//
// ─── 6 · LA UNIDAD MEDIDA ES EL DÍA (IDA + RETORNO), NO EL TRAMO ────────────
//
// Lo reportó el dueño sobre el correo real: *«debería decir 1 ruta con 17
// servicios; las rutas se analizan IDA Y RETORNO, juntos con sus hermanos es un
// solo servicio, es 1 sola ruta. Pero son rutas diferentes si son horarios
// diferentes sin ser hermanos»*. El módulo agrupaba por TRAMO, y como el nombre
// lleva la hora dentro (`RUTA C/ENTRADA 6:35` vs `RUTA C/RETORNO 17:00`) la ida y
// el retorno del mismo contrato caían en DOS filas.
//
// NO ERA SOLO UN CONTEO INFLADO: ERA UNA PROPUESTA PELIGROSA. El contrato es UN
// bus para el día, y el retorno casi siempre trae menos gente que la ida. Con las
// filas separadas, el retorno de una ruta de 50 asientos que movió 20 personas
// salía por su cuenta como «cabe en una unidad menor» — o sea, el ERP proponía
// encoger un bus que por la mañana va lleno. Ese es exactamente el daño que la
// decisión 1 existe para no hacer, entrando por la puerta de la agrupación.
//
// · SE EMPAREJA CON EL DATO ESCRITO, NO POR PARECIDO. El hermano es
//   `reserva_vinculada_id`, resuelto por los DOS sentidos y **solo cuando es
//   inequívoco** (`lib/ocupacion/datos.ts`). No se deduce por nombre ni por hora:
//   eso sería la unión por cercanía que la decisión 5 rechaza.
// · EL PICO DEL DÍA ES EL MÁXIMO DE SUS TRAMOS, JAMÁS LA SUMA. Son las mismas
//   personas yendo y volviendo sobre los MISMOS asientos contratados: sumar
//   34 + 30 publicaría 64 sobre 50 y pondría media cartera en «superó lo
//   contratado». El máximo es además el pico de verdad — el momento más lleno.
// · UN TRAMO SIN MANIFIESTO NO HUNDE AL DÍA. El día se mide con los tramos que SÍ
//   tienen manifiesto; solo es `sin_manifiesto` si no lo tiene ninguno. Es la
//   decisión 2 aplicada al día.
// · EL DÍA SE CANCELA SOLO SI SE CAYERON LOS DOS. Mismo `diaCaido` de la
//   liquidación: si un tramo corrió, el día se prestó.
// · LA IDENTIDAD ES EL CONJUNTO DE LOS DOS NOMBRES, no el sentido. Así dos
//   horarios distintos siguen siendo dos rutas —que es la otra mitad de lo que
//   pidió el dueño— y equivocarse al rotular cuál es la ida solo intercambia dos
//   etiquetas: nunca funde ni parte una ruta.
// · SIN `hermano_id` EL COMPORTAMIENTO ES BYTE A BYTE EL ANTERIOR (cada tramo es
//   su propio día), y la matriz lo fija.
//
// Matriz: npx tsx scripts/prueba-ocupacion-semanal.mts
// ══════════════════════════════════════════════════════════════════════════════

import { normalizarNombreRuta } from "@/lib/liquidacion-rutas";

// ─── Umbrales ────────────────────────────────────────────────────────────────
//
// NINGUNO DE LOS TRES ESTÁ MEDIDO NI SE HEREDA, y se declara como tal — misma
// honestidad que `MARGEN_SALTO_TANQUE`. En los tres, el lado seguro es SUBIRLOS:
// subir exige más evidencia antes de proponer encoger un bus.

/**
 * Asientos de holgura que la unidad propuesta debe dejar POR ENCIMA del pico.
 *
 * El defecto es **0** porque es literalmente la regla que dictó el dueño («si
 * embarcaron 12 y el menor es de 10, no se sugiere»), y con cualquier otro valor
 * sus dos ejemplos dejarían de reproducirse. No es un número prudente: con 0, un
 * pico de 23 puede proponer una unidad de 25 y quedan dos asientos. Por eso la
 * fila publica `asientos_holgura` y decide una persona.
 */
export const MARGEN_ASIENTOS = 0;

/**
 * Días DISTINTOS con manifiesto que hace falta para hablar de un «pico».
 * Con una sola observación no hay pico, hay un dato.
 */
export const MIN_DIAS_MEDIDOS = 2;

/** Fracción mínima de servicios prestados que tienen manifiesto. La mayoría. */
export const MIN_COBERTURA = 0.5;

// ─── Entrada ─────────────────────────────────────────────────────────────────

/** Un TRAMO del periodo (una fila de `reservas`), ya resuelto por quien leyó la base. */
export type ServicioOcupacion = {
  reserva_id: number;
  fecha: string | null;
  hora: string | null;
  /** El nombre tecleado. null cuando nadie lo escribió. */
  ruta_nombre: string | null;
  /** "ORIGEN → DESTINO", para poder nombrar una ruta sin nombre. */
  recorrido: string | null;
  /** Asientos pactados. null = ninguna fuente lo sabe (jamás la capacidad del bus). */
  contratado: number | null;
  /** Personas que de verdad subieron (`esAbordado` sobre `pasajeros_parada`). */
  embarcados: number;
  /** Personas en el manifiesto. 0 = NADIE lo llenó, que no es «no viajó nadie». */
  esperados: number;
  cancelado: boolean;
  placa: string | null;
  /**
   * El hermano ESCRITO (`reserva_vinculada_id`, resuelto por los DOS sentidos y solo
   * cuando es inequívoco — ver `lib/ocupacion/datos.ts`). Es lo único que empareja la
   * ida con su retorno: NUNCA se deduce por nombre ni por hora.
   *
   * Ausente o `null` → cada tramo es su propio día, que es byte a byte el
   * comportamiento anterior a la decisión 6.
   */
  hermano_id?: number | null;
  /** IDA / RETORNO. Solo ROTULA: no entra jamás en la identidad del grupo. */
  sentido?: "IDA" | "RETORNO" | null;
};

/** Un escalón de la flota: una categoría que AFA sabe cotizar y asignar. */
export type EscalonFlota = {
  clave: string;
  nombre: string;
  capacidad: number;
};

export type ConfigOcupacion = {
  margenAsientos?: number;
  minDiasMedidos?: number;
  minCobertura?: number;
};

// ─── Salida ──────────────────────────────────────────────────────────────────

/**
 * El motivo se DECLARA, no se olfatea. Cada código se arregla en otro sitio y la
 * pantalla (y el correo) enrutan por él, igual que los bloqueos de /liquidaciones.
 */
export type CodigoOcupacion =
  /** Hay una unidad MENOR en la flota en la que el pico cabe. */
  | "sugiere_cambio"
  /** El pico SUPERÓ los asientos contratados: alguien viajó de pie o se quedó. */
  | "excede_contratado"
  /** Cabría en menos, pero la flota no tiene nada entre el pico y lo contratado. */
  | "no_hay_menor"
  /** Ya es la unidad más chica que AFA ofrece. */
  | "ya_es_la_menor"
  /** Nadie declaró los asientos contratados: no hay contra qué comparar. */
  | "sin_contratado"
  /** Ningún servicio del periodo tiene manifiesto: no se midió nada. */
  | "sin_manifiesto"
  /** Demasiados servicios sin manifiesto para que el pico signifique algo. */
  | "cobertura_baja"
  /** Un solo día medido: eso no es un pico. */
  | "pocos_dias"
  /** La flota no declara capacidades: no se inventa un vehículo. */
  | "sin_flota";

/** ¿Este código pide una acción de alguien? Decide el tono en el correo. */
export const CODIGO_ACCIONABLE: Record<CodigoOcupacion, boolean> = {
  sugiere_cambio: true,
  excede_contratado: true,
  no_hay_menor: false,
  ya_es_la_menor: false,
  sin_contratado: true,
  sin_manifiesto: true,
  cobertura_baja: true,
  pocos_dias: false,
  sin_flota: false,
};

/**
 * ¿El MOTIVO de este código le RECOMIENDA algo al cliente sobre su vehículo?
 *
 * Son los dos sentidos, no solo el de bajar: `sugiere_cambio` propone una unidad
 * menor y `excede_contratado` remata con «conviene revisar el contrato», que es
 * proponer una mayor. El dueño lo pidió con esas palabras — *«que el cliente
 * analice su flota y sus gastos y nosotros no le hagamos ninguna sugerencia»*—,
 * así que la casilla los calla a LOS DOS. Los NÚMEROS no se tocan nunca: el
 * cliente sigue viendo su pico sobre sus asientos contratados.
 *
 * Se declara pegado al código y no en una lista aparte que haya que acordarse de
 * actualizar — misma razón que `problema` en el catálogo de /redes.
 */
export const CODIGO_RECOMIENDA: Record<CodigoOcupacion, boolean> = {
  sugiere_cambio: true,      // "cabría en la Van 10" → bajar de unidad
  excede_contratado: true,   // "conviene revisar el contrato" → subir de unidad
  no_hay_menor: false,
  ya_es_la_menor: false,
  sin_contratado: false,
  sin_manifiesto: false,
  cobertura_baja: false,
  pocos_dias: false,
  sin_flota: false,
};

/**
 * ¿La ETIQUETA del chip también recomienda, o es un hecho?
 *
 * Hace falta aparte porque los dos códigos que recomiendan NO se comportan igual
 * en el rótulo: «Cabe en una unidad menor» ES la propuesta, mientras que «Superó
 * lo contratado» es un hecho medido que el cliente tiene derecho a leer — con o
 * sin sugerencias. Colapsar las dos tablas en una habría escondido que 32
 * personas viajaron sobre 30 asientos, que es justo lo que no se puede callar.
 */
export const ETIQUETA_RECOMIENDA: Record<CodigoOcupacion, boolean> = {
  sugiere_cambio: true,
  excede_contratado: false,
  no_hay_menor: false,
  ya_es_la_menor: false,
  sin_contratado: false,
  sin_manifiesto: false,
  cobertura_baja: false,
  pocos_dias: false,
  sin_flota: false,
};

/** Un TRAMO dentro de su día. Es lo que de verdad hay en `reservas`. */
export type TramoDia = {
  reserva_id: number;
  hora: string | null;
  /** El nombre tecleado de ESE tramo. */
  ruta_nombre: string | null;
  sentido: "IDA" | "RETORNO" | null;
  embarcados: number;
  esperados: number;
  cancelado: boolean;
  /** false = nadie llenó el manifiesto de ESE tramo. */
  medido: boolean;
  placa: string | null;
};

/**
 * UN DÍA: la ida y su retorno juntos, que es la unidad que se mide (decisión 6).
 * Con un solo tramo —o sin `hermano_id`— es exactamente el tramo de siempre.
 */
export type DiaOcupacion = {
  fecha: string;
  /** La del primer tramo del día (la ida). */
  hora: string | null;
  /** El tramo que representa al día. Los demás viven en `tramos`. */
  reserva_id: number;
  /** MÁXIMO de los tramos medidos, JAMÁS la suma: son los mismos asientos. */
  embarcados: number;
  esperados: number;
  /** El día se cayó solo si se cayeron TODOS sus tramos. */
  cancelado: boolean;
  /** true si ALGÚN tramo tiene manifiesto. Uno vacío no hunde al día. */
  medido: boolean;
  placa: string | null;

  /** Los tramos que lo componen (1 o 2). Nunca vacío. */
  tramos: TramoDia[];
  /** Identidades normalizadas de sus tramos, sin repetir y ORDENADAS. Es la CLAVE. */
  identidad: string[];
  /** El nombre tecleado del primer tramo (la ida). */
  nombre_ida: string | null;
  /** El del segundo. null cuando el día tiene un solo tramo. */
  nombre_retorno: string | null;
  recorrido: string | null;
  /** Asientos pactados del DÍA: el primero que alguna fuente sepa. */
  contratado: number | null;
};

export type FilaOcupacion = {
  clave: string;
  /** El nombre tecleado de la IDA, o null. NUNCA se rellena con el recorrido. */
  ruta_nombre: string | null;
  /** El del RETORNO. null cuando la ruta no tiene retorno emparejado. */
  ruta_retorno: string | null;
  /** Para poder nombrar la fila cuando la ruta no tiene nombre. */
  recorrido: string | null;
  contratado: number | null;

  /** DÍAS del periodo. La ida y su retorno cuentan UNO. */
  servicios: number;
  /** Tramos que componen esos días. `tramos >= servicios` siempre. */
  tramos: number;
  cancelados: number;
  /** Servicios prestados CON manifiesto. Es la base de la medición. */
  medidos: number;
  /** Servicios prestados SIN manifiesto. El hueco que hay que cerrar. */
  sin_manifiesto: number;
  /** medidos / prestados. 0..1 */
  cobertura: number;
  dias_medidos: number;

  /** MAX de embarcados sobre los medidos. null si no se midió nada. */
  pico: number | null;
  dia_pico: string | null;
  /** Media de embarcados sobre los medidos. Se PUBLICA, no decide. */
  promedio: number | null;

  codigo: CodigoOcupacion;
  /** La unidad propuesta. Solo con `sugiere_cambio`. */
  propuesta: EscalonFlota | null;
  /** Asientos que sobrarían en la propuesta (`capacidad − pico`). */
  asientos_holgura: number | null;
  /** Asientos que se dejarían de contratar (`contratado − capacidad`). */
  asientos_liberados: number | null;

  dias: DiaOcupacion[];
};

// ─── El motor ────────────────────────────────────────────────────────────────

/**
 * La IDENTIDAD de un TRAMO: su nombre normalizado —la MISMA definición de «esta
 * ruta y esta son la misma» que usa el índice único de `cliente_ruta`— o, si nadie
 * lo escribió, su recorrido entre comillas para no confundirlo con un nombre.
 */
function identidadTramo(s: ServicioOcupacion): string {
  const n = normalizarNombreRuta(s.ruta_nombre);
  return n || `«${String(s.recorrido ?? "").trim().toUpperCase()}»`;
}

/** Clave de agrupación de un DÍA. Ver las decisiones 5 y 6 de la cabecera. */
function claveDe(d: DiaOcupacion): string {
  // El contratado entra en la clave: una fila imprime UN «de N contratados».
  return `${d.identidad.join(" ⇄ ")}|${d.contratado ?? "?"}`;
}

/** El texto que más veces escribieron, con el alfabético de desempate. */
function masRepetido(valores: (string | null | undefined)[]): string | null {
  const cuenta = new Map<string, number>();
  for (const v of valores) {
    const t = String(v ?? "").trim();
    if (t) cuenta.set(t, (cuenta.get(t) ?? 0) + 1);
  }
  if (!cuenta.size) return null;
  return [...cuenta.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )[0][0];
}

/** Arma UN día con los tramos que ya se decidió que van juntos. */
function armarDia(lista: ServicioOcupacion[]): DiaOcupacion {
  // La ida primero. El sentido solo ORDENA para rotular; equivocarse aquí
  // intercambia dos etiquetas y no mueve ninguna medición.
  const orden = [...lista].sort((a, b) => {
    const sa = (a.sentido ?? "IDA") === "RETORNO" ? 1 : 0;
    const sb = (b.sentido ?? "IDA") === "RETORNO" ? 1 : 0;
    return sa - sb
      || String(a.hora ?? "").localeCompare(String(b.hora ?? ""))
      || Number(a.reserva_id) - Number(b.reserva_id);
  });

  const tramos: TramoDia[] = orden.map((s) => ({
    reserva_id: Number(s.reserva_id),
    hora: s.hora ?? null,
    ruta_nombre: s.ruta_nombre?.trim() || null,
    sentido: s.sentido ?? null,
    embarcados: Math.max(0, Math.round(Number(s.embarcados ?? 0))),
    esperados: Math.max(0, Math.round(Number(s.esperados ?? 0))),
    cancelado: !!s.cancelado,
    // Un tramo CANCELADO no se midió: no salió. Y uno sin manifiesto tampoco,
    // aunque sí haya salido.
    medido: !s.cancelado && Number(s.esperados ?? 0) > 0,
    placa: s.placa ?? null,
  }));

  const medidos = tramos.filter((t) => t.medido);
  const cupo = orden.map((s) => s.contratado).find((c) => c != null && Number(c) > 0) ?? null;

  return {
    // El día se ubica en la fecha de su PRIMER tramo: el nocturno que retorna de
    // madrugada no se parte, igual que en el Anexo 1 de la liquidación.
    fecha: orden.map((s) => String(s.fecha)).sort()[0],
    hora: orden[0].hora ?? null,
    reserva_id: Number(orden[0].reserva_id),
    // EL PICO DEL DÍA ES EL MÁXIMO, JAMÁS LA SUMA.
    embarcados: medidos.length ? Math.max(...medidos.map((t) => t.embarcados)) : 0,
    esperados: medidos.length ? Math.max(...medidos.map((t) => t.esperados)) : 0,
    cancelado: tramos.every((t) => t.cancelado),
    medido: medidos.length > 0,
    placa: orden.map((s) => s.placa).find((p) => !!p) ?? null,
    tramos,
    identidad: [...new Set(orden.map(identidadTramo))].sort(),
    nombre_ida: tramos[0].ruta_nombre,
    nombre_retorno: tramos[1]?.ruta_nombre ?? null,
    recorrido: orden.map((s) => s.recorrido?.trim()).find((r) => !!r) ?? null,
    contratado: cupo,
  };
}

/**
 * LA IDA Y SU RETORNO SON UN SOLO SERVICIO. Empareja únicamente lo que el dato
 * ESCRITO declara, y solo cuando los dos tramos se señalan MUTUAMENTE: con un
 * enlace de tres puntas (dos idas reclamando el mismo retorno) no se empareja
 * ninguna, porque elegir sería medir como un día lo que son dos.
 *
 * Sin `hermano_id` cada tramo es su propio día — el comportamiento anterior.
 */
export function emparejarDias(servicios: ServicioOcupacion[]): DiaOcupacion[] {
  const conFecha = servicios.filter((s) => !!s.fecha);   // sin fecha no entra a un periodo

  // LA IDENTIDAD DE TRABAJO ES LA POSICIÓN, NO EL `reserva_id`. En la base el id es
  // único, pero si alguna vez llegan dos filas con el mismo, deduplicar por id haría
  // DESAPARECER un servicio del reporte en silencio. El id solo sirve para BUSCAR al
  // hermano, y ahí manda la primera aparición.
  const indicePorId = new Map<number, number>();
  conFecha.forEach((s, i) => {
    const id = Number(s.reserva_id);
    if (!indicePorId.has(id)) indicePorId.set(id, i);
  });

  // Por id: quién «abre» el día no puede depender del orden en que llegaron.
  const orden = conFecha.map((_, i) => i)
    .sort((a, b) => Number(conFecha[a].reserva_id) - Number(conFecha[b].reserva_id) || a - b);

  const usado = new Set<number>();
  const dias: DiaOcupacion[] = [];

  for (const i of orden) {
    if (usado.has(i)) continue;
    usado.add(i);
    const s = conFecha[i];

    const h = Number(s.hermano_id ?? 0);
    const j = h > 0 ? indicePorId.get(h) ?? -1 : -1;
    const otro = j >= 0 && j !== i && !usado.has(j) ? conFecha[j] : null;
    const reciproco = !!otro && Number(otro.hermano_id ?? 0) === Number(s.reserva_id);

    if (otro && reciproco) {
      usado.add(j);
      dias.push(armarDia([s, otro]));
    } else {
      dias.push(armarDia([s]));
    }
  }
  return dias;
}

/**
 * UN DÍA AL QUE LE FALTA UN TRAMO NO ES OTRA RUTA. Un día que llega solo —su
 * hermano se borró, o nadie escribió el enlace— se suma al grupo de ida+retorno
 * que lleva su nombre, **solo cuando hay exactamente uno**: con dos candidatos,
 * elegir sería meterle a una ruta el pico de otra. Es el mismo criterio del
 * comodín de `agruparPorRutaContratada`.
 *
 * El cupo contratado tiene que coincidir, porque sigue siendo la clave: una fila
 * imprime UN «de N contratados».
 */
function absorberSueltos(grupos: Map<string, DiaOcupacion[]>): Map<string, DiaOcupacion[]> {
  const claves = [...grupos.keys()];
  // Los candidatos salen del mapa ORIGINAL: absorber no puede crear candidatos
  // nuevos a mitad del recorrido, o el resultado dependería del orden.
  const pares = claves.filter((k) => grupos.get(k)![0].identidad.length >= 2);
  if (!pares.length) return grupos;

  const salida = new Map(grupos);
  for (const k of claves) {
    const dias = salida.get(k);
    if (!dias || dias[0].identidad.length !== 1) continue;
    const nombre = dias[0].identidad[0];
    const cupo = dias[0].contratado ?? null;
    const destinos = pares.filter((p) => {
      const d0 = grupos.get(p)![0];
      return (d0.contratado ?? null) === cupo && d0.identidad.includes(nombre);
    });
    if (destinos.length !== 1) continue;        // ambiguo (o ninguno) → se queda aparte
    salida.set(destinos[0], [...(salida.get(destinos[0]) ?? []), ...dias]);
    salida.delete(k);
  }
  return salida;
}

/**
 * La escalera, ordenada y sin repetidos. Dos categorías de la misma capacidad
 * (una Full Equipo y su gemela Estándar) son UN escalón para esta pregunta: lo
 * que decide si el pico cabe son los asientos, no la ficha de costeo. Se conserva
 * la de nombre alfabéticamente menor solo para poder nombrarla.
 */
export function escaleraDeFlota(escalones: EscalonFlota[]): EscalonFlota[] {
  const porCapacidad = new Map<number, EscalonFlota>();
  for (const e of escalones) {
    const cap = Math.round(Number(e.capacidad ?? 0));
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const previo = porCapacidad.get(cap);
    if (!previo || String(e.nombre ?? "") < String(previo.nombre ?? "")) {
      porCapacidad.set(cap, { ...e, capacidad: cap });
    }
  }
  return [...porCapacidad.values()].sort((a, b) => a.capacidad - b.capacidad);
}

export function analizarOcupacion(
  servicios: ServicioOcupacion[],
  escalones: EscalonFlota[],
  cfg: ConfigOcupacion = {},
): FilaOcupacion[] {
  const margen = Number.isFinite(cfg.margenAsientos) ? Number(cfg.margenAsientos) : MARGEN_ASIENTOS;
  const minDias = Number.isFinite(cfg.minDiasMedidos) ? Number(cfg.minDiasMedidos) : MIN_DIAS_MEDIDOS;
  const minCob = Number.isFinite(cfg.minCobertura) ? Number(cfg.minCobertura) : MIN_COBERTURA;
  const escalera = escaleraDeFlota(escalones);

  // LA UNIDAD MEDIDA ES EL DÍA, NO EL TRAMO (decisión 6).
  const porClave = new Map<string, DiaOcupacion[]>();
  for (const d of emparejarDias(servicios)) {
    const k = claveDe(d);
    porClave.set(k, [...(porClave.get(k) ?? []), d]);
  }
  const grupos = absorberSueltos(porClave);

  const filas: FilaOcupacion[] = [];

  for (const [clave, lista] of grupos) {
    const dias: DiaOcupacion[] = [...lista].sort((a, b) =>
      a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.hora ?? "") < (b.hora ?? "") ? -1 : 1);

    const cancelados = dias.filter((d) => d.cancelado).length;
    const prestados = dias.length - cancelados;
    const medidosArr = dias.filter((d) => d.medido);
    const medidos = medidosArr.length;
    const cobertura = prestados > 0 ? medidos / prestados : 0;
    const diasMedidos = new Set(medidosArr.map((d) => d.fecha)).size;

    const pico = medidos > 0 ? Math.max(...medidosArr.map((d) => d.embarcados)) : null;
    const diaPico = pico === null ? null : (medidosArr.find((d) => d.embarcados === pico)?.fecha ?? null);
    const promedio = medidos > 0
      ? Math.round((medidosArr.reduce((a, d) => a + d.embarcados, 0) / medidos) * 10) / 10
      : null;

    const primero = dias[0];
    const contratado = Number.isFinite(Number(primero.contratado)) && Number(primero.contratado) > 0
      ? Math.round(Number(primero.contratado))
      : null;

    // ── El veredicto, en orden: evidencia primero, juicio después ────────────
    let codigo: CodigoOcupacion;
    let propuesta: EscalonFlota | null = null;
    let holgura: number | null = null;
    let liberados: number | null = null;

    if (medidos === 0) {
      // Nada que medir. Va primero: sin esto no hay ni pico que enseñar.
      codigo = "sin_manifiesto";
    } else if (cobertura < minCob) {
      codigo = "cobertura_baja";
    } else if (diasMedidos < minDias) {
      codigo = "pocos_dias";
    } else if (contratado === null) {
      // Se midió bien, pero no hay contra qué comparar. El pico SÍ se publica.
      codigo = "sin_contratado";
    } else if (pico! > contratado) {
      // El hallazgo que el dueño no pidió y es el más caro de los dos: alguien
      // viajó de pie o se quedó en el paradero, y además se está prestando un
      // servicio mayor que el pactado.
      codigo = "excede_contratado";
    } else if (escalera.length === 0) {
      codigo = "sin_flota";
    } else {
      const necesario = pico! + margen;
      const menores = escalera.filter((e) => e.capacidad < contratado);
      const caben = menores.filter((e) => e.capacidad >= necesario);
      if (caben.length > 0) {
        propuesta = caben[0];                       // la MÁS CHICA que cabe
        holgura = propuesta.capacidad - pico!;
        liberados = contratado - propuesta.capacidad;
        codigo = "sugiere_cambio";
      } else if (menores.length === 0) {
        codigo = "ya_es_la_menor";
      } else {
        // Los dos ejemplos del dueño caen aquí: cabría en menos, pero entre el
        // pico y lo contratado la flota no tiene nada.
        codigo = "no_hay_menor";
      }
    }

    // El nombre de cada lado sale de los días COMPLETOS cuando los hay: un día al
    // que le falta un tramo pone su único nombre en el lado de la ida, y absorbido
    // en un grupo de ida+retorno ensuciaría esa columna con el nombre del retorno.
    const conLosDos = dias.filter((d) => d.tramos.length >= 2);
    const rotulan = conLosDos.length ? conLosDos : dias;

    filas.push({
      clave,
      // El nombre que se imprime es el más repetido de cada lado por separado, con
      // el alfabético de desempate: es la misma regla de `recalcularDescripciones`,
      // y sigue siendo un dato que alguien escribió — el que escribió más veces.
      ruta_nombre: masRepetido(rotulan.map((d) => d.nombre_ida)),
      ruta_retorno: masRepetido(rotulan.map((d) => d.nombre_retorno)),
      recorrido: primero.recorrido?.trim() || null,
      contratado,
      servicios: dias.length,
      tramos: dias.reduce((a, d) => a + d.tramos.length, 0),
      cancelados,
      medidos,
      sin_manifiesto: prestados - medidos,
      cobertura: Math.round(cobertura * 100) / 100,
      dias_medidos: diasMedidos,
      pico,
      dia_pico: diaPico,
      promedio,
      codigo,
      propuesta,
      asientos_holgura: holgura,
      asientos_liberados: liberados,
      dias,
    });
  }

  // Lo accionable primero, y dentro de eso lo que más asientos libera. Un reporte
  // que empieza por lo que no hay que hacer se deja de leer en la tercera semana.
  const ORDEN: CodigoOcupacion[] = [
    "excede_contratado", "sugiere_cambio", "sin_contratado", "cobertura_baja",
    "sin_manifiesto", "no_hay_menor", "pocos_dias", "ya_es_la_menor", "sin_flota",
  ];
  return filas.sort((a, b) =>
    ORDEN.indexOf(a.codigo) - ORDEN.indexOf(b.codigo) ||
    (b.asientos_liberados ?? 0) - (a.asientos_liberados ?? 0) ||
    String(a.ruta_nombre ?? a.recorrido ?? "").localeCompare(String(b.ruta_nombre ?? b.recorrido ?? ""))
  );
}

// ─── Textos (uno por código, en un solo sitio) ───────────────────────────────

/** Qué pasó, y dónde se arregla. Lo imprimen el correo y la pantalla. */
export function motivoOcupacion(f: FilaOcupacion): string {
  switch (f.codigo) {
    case "sugiere_cambio":
      return `El día de más afluencia viajaron ${f.pico} personas sobre ${f.contratado} asientos contratados. `
        + `Cabría en ${f.propuesta!.nombre} (${f.propuesta!.capacidad} asientos), con ${f.asientos_holgura} de holgura.`;
    case "excede_contratado":
      return `El ${f.dia_pico} viajaron ${f.pico} personas sobre ${f.contratado} asientos contratados: `
        + `${f.pico! - f.contratado!} por encima de lo pactado. Conviene revisar el contrato de esta ruta.`;
    case "no_hay_menor":
      return `El día de más afluencia viajaron ${f.pico} sobre ${f.contratado} asientos, pero no hay ninguna `
        + `unidad entre ${f.pico} y ${f.contratado} asientos: se mantiene la actual.`;
    case "ya_es_la_menor":
      return `Ya es la unidad más pequeña disponible (${f.contratado} asientos).`;
    case "sin_contratado":
      return `No están declarados los asientos contratados de esta ruta, así que no hay contra qué comparar. `
        + `Se registra un pico de ${f.pico} pasajeros. Se completa en Programación o en la ficha de la ruta.`;
    case "sin_manifiesto":
      return `Ninguno de los ${f.servicios} servicios del periodo tiene manifiesto cargado, así que no se midió `
        + `cuánta gente viajó. Sin eso no se puede juzgar la ocupación.`;
    case "cobertura_baja":
      return `Solo ${f.medidos} de ${f.servicios - f.cancelados} servicios prestados tienen manifiesto `
        + `(${Math.round(f.cobertura * 100)} %). Con tantos huecos, el pico de ${f.pico} no describe la semana.`;
    case "pocos_dias":
      return `Solo se midió ${f.dias_medidos} día del periodo: hace falta más de uno para hablar de un pico.`;
    case "sin_flota":
      return `No hay capacidades declaradas en la flota, así que no se puede proponer ninguna unidad alternativa.`;
  }
}

/**
 * El mismo motivo SIN la recomendación, para el cliente que pidió que AFA no le
 * sugiera nada. Devuelve `null` en los códigos que no recomiendan: ahí no hay que
 * reescribir nada, y una segunda redacción de un texto que ya era neutro es una
 * copia que se queda atrás.
 *
 * **Los NÚMEROS no se tocan.** Lo que se calla es la conclusión («cabría en la Van
 * 10», «conviene revisar el contrato»), nunca el hecho medido — el cliente sigue
 * leyendo cuánta gente viajó sobre cuántos asientos contrató, que es el dato con
 * el que puede analizar su flota por su cuenta.
 */
export function motivoSinRecomendacion(f: FilaOcupacion): string | null {
  switch (f.codigo) {
    case "sugiere_cambio":
      return `El día de más afluencia viajaron ${f.pico} personas sobre ${f.contratado} asientos contratados.`;
    case "excede_contratado":
      return `El ${f.dia_pico} viajaron ${f.pico} personas sobre ${f.contratado} asientos contratados: `
        + `${f.pico! - f.contratado!} por encima de lo pactado.`;
    default:
      return null;
  }
}

/** Etiqueta corta del código, para el chip de una tabla. */
export const ETIQUETA_OCUPACION: Record<CodigoOcupacion, string> = {
  sugiere_cambio: "Cabe en una unidad menor",
  excede_contratado: "Superó lo contratado",
  no_hay_menor: "Sin unidad menor disponible",
  ya_es_la_menor: "Ya es la menor",
  sin_contratado: "Sin asientos contratados",
  sin_manifiesto: "Sin manifiesto",
  cobertura_baja: "Manifiestos incompletos",
  pocos_dias: "Pocos días medidos",
  sin_flota: "Sin flota declarada",
};

/**
 * El nombre con el que se imprime la fila. Sin nombre NO se inventa uno.
 *
 * Se imprimen los DOS nombres —ida y retorno— porque son un solo servicio y el
 * cliente reconoce los dos en su orden de compra; es la misma decisión que ya toma
 * `ParServicio.ida`/`.retorno` en la liquidación. Sin retorno emparejado el texto
 * es EXACTAMENTE el de antes.
 */
export function rotuloFila(f: FilaOcupacion): string {
  const base = f.ruta_nombre ?? (f.recorrido ? `Sin nombre · ${f.recorrido}` : "Sin nombre");
  return f.ruta_retorno ? `${base} ⇄ ${f.ruta_retorno}` : base;
}

// ─── La ventana y la hora de Perú ────────────────────────────────────────────
//
// Viven en `lib/ocupacion/cadencia.ts` desde que el reporte dejó de ser solo
// semanal: CADA CUÁNTO se manda y CUÁNTO abarca son dos ejes configurables por
// cliente. Se reexportan para no mover a ningún importador — misma fachada que
// `liquidacion-agrupacion` conserva sobre `ruta-identidad`.
export {
  hoyLima, esSabadoLima, ventanaSemanal, ventanaDe, tocaHoy,
  normalizarFrecuencia, normalizarVentana, describirCadencia, avisoCadencia,
  FRECUENCIAS, VENTANAS,
  type Frecuencia, type Ventana,
} from "@/lib/ocupacion/cadencia";
