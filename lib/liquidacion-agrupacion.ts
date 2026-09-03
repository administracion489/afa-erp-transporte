// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-agrupacion.ts — De servicios sueltos a las líneas del formato.
//
// El "Formato de Liquidación y Conformidad del Servicio" (AFA-FL-07) NO lista un
// renglón por viaje: lista una línea por RUTA CONTRATADA (su par ida+retorno) a una
// tarifa, con la CANTIDAD de servicios del periodo. Eso es lo que este módulo calcula,
// para que nadie vuelva a contar "26.00" a mano:
//
//   TRANSPORTE DE PERSONAL CD CALLAO · 50 PAX · DEL 15-06-2026 AL 14-07-2026
//   IDA · RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA
//   RETORNO · RUTA B/ RETORNO 15:00/ BSF→CHILCA (incluido en la misma tarifa)
//                                         SERV.  26.00  ×  S/ 790.00
//
// TODO lo que se imprime es un dato que alguien escribió. La versión anterior componía
// la descripción con "RUTA B / TURNO DÍA / MÓVIL 1", donde el turno se deducía de la
// hora, el móvil era un índice calculado y el "N PAX" era la capacidad del bus que
// tocó ese día. Ninguno de los tres existía como dato, y el del pax además mentía: con
// una ruta contratada para 15, mandar un bus de 20 hacía que el formato declarara 20.
//
// Es CÓDIGO PURO (sin Supabase, sin React): recibe las reservas ya leídas y devuelve
// las líneas. Así se puede probar de verdad y reusar desde la página, la API y el
// script de muestra del PDF.
//
// Dos números distintos por línea, a propósito:
//   cantidad_programada → cuántos servicios había en el periodo (cualquier estado)
//   cantidad_ejecutada  → cuántos se finalizaron de verdad
// La cantidad que se cobra arranca en la ejecutada y el operador puede cambiarla
// dejando constancia (decisión del negocio: "ejecutados, pero editable").
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, desdeTotal } from "@/lib/finanzas/dinero";

// ── Entrada ─────────────────────────────────────────────────────────────────

/** Proyección de `reservas` que necesita la agrupación. Nada más: el resto no se lee. */
export type ReservaLiq = {
  id: number;
  codigo?: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  estado: string | null;
  estado_admin?: string | null;
  estado_proveedor?: string | null;
  cliente_id: number | null;
  cliente_sede_id?: number | null;
  ruta_nombre?: string | null;
  direccion_servicio?: string | null;   // 'ida' | 'retorno'
  /** Enlaza la ida con su retorno: los dos tramos que cubre UNA sola tarifa. */
  reserva_vinculada_id?: number | null;
  origen?: string | null;
  destino?: string | null;
  precio_cliente?: number | null;
  costo_proveedor?: number | null;
  tipo_asignacion?: string | null;
  vehiculo_id?: number | null;
  vehiculo_tercero_id?: number | null;
  conductor_id?: number | null;
  conductor_tercero_id?: number | null;
  empresa_tercerizada_id?: number | null;
  pasajeros_abordados?: number | null;
  hora_real_inicio?: string | null;
  hora_real_fin?: string | null;
  tipo_servicio_detalle?: string | null;
  liquidacion_cliente_id?: number | null;
  liquidacion_proveedor_id?: number | null;
  /** Cotización de la que nació el servicio: una de las fuentes del pax contratado. */
  cotizacion_id?: number | null;
  /**
   * Asientos CONTRATADOS, NO la capacidad del bus asignado. Ver `paxContratadoDe`:
   * mandar un bus de 20 a una ruta contratada para 15 no cambia lo que se factura.
   */
  capacidad_contratada?: number | null;
  /**
   * contrato | adicional | contingencia. Lo que el cliente pidió POR ENCIMA del
   * contrato no puede fundirse con lo contratado: entra en la clave de agrupación y
   * la línea sale marcada como adicional, con su propio subtotal en el formato.
   * Ausente (migración sin correr) se lee como 'contrato', el default de la base.
   */
  origen_contractual?: string | null;
  /**
   * Snapshot de los paraderos del tramo, con `tipo: inicio | intermedia | destino` y
   * coordenadas. Es de donde `lib/nombre-ruta.ts` sacó el TEXTO del nombre, así que aquí
   * está el hecho del que ese texto es solo una redacción: dos servicios que arrancan y
   * terminan en el mismo punto son la misma ruta aunque se llamen distinto.
   *
   * Opcional a propósito: sin él la agrupación se apoya solo en el nombre, que es
   * exactamente como se comportaba antes.
   */
  paradas_json?: unknown;
};

/** 'contrato' cuando la columna no existe o viene vacía. */
export const origenContractual = (r: ReservaLiq | null | undefined): string =>
  String(r?.origen_contractual || "contrato");

/**
 * El origen del SERVICIO lo declara EL TRAMO QUE LLEVA EL IMPORTE.
 *
 * Es la regla de oro del proyecto aplicada al origen: el monto tiene una fila
 * autoritativa y el resto la DERIVA. La cabeza es, por construcción de
 * `analizarServicios`, el tramo que lleva la tarifa del día (con los dos en 0 el par
 * ni siquiera llega aquí: queda bloqueado). Así que quien cobra, clasifica.
 *
 * Antes esto CONTAGIABA: bastaba con que un tramo estuviera marcado para que el día
 * entero se cobrara como adicional. La intención era no cobrar como contratado un día
 * pedido aparte, pero el precio era alto y salía a la luz en cuanto alguien quería
 * marcar un tramo suelto —el retorno que cubrió otra unidad por una contingencia—:
 * la marca movía la tarifa completa de subtotal sin que nadie lo pidiera, y la
 * pantalla seguía diciendo "Contrato" sobre la ida. Un día no cambia de bolsillo
 * porque se anote algo en el tramo que va en S/ 0.00.
 *
 * Marcar el tramo que SÍ lleva el importe sigue moviendo el día entero, que es lo
 * correcto y lo que hace por defecto Programación (arrastra al hermano). Y cuando los
 * dos tramos difieren, `analizarServicios` levanta un aviso: la marca del tramo mudo
 * no se pierde en silencio.
 */
export function origenDelPar(p: ParServicio): string {
  return origenContractual(p.cabeza);
}

/**
 * El origen de un CONJUNTO de tramos —una línea entera del documento— con la misma
 * regla que `origenDelPar`: mandan los tramos que LLEVAN EL IMPORTE.
 *
 * `agruparServicios` arma cada línea con pares que ya comparten origen, así que por el
 * camino normal todos los portadores dicen lo mismo. Esto existe para el camino que NO
 * pasa por la agrupación: `recalcularDescripciones`, que reescribe el texto de una
 * línea YA creada y solo tiene las reservas del puente, sin pares. Ahí se miraban
 * TODOS los tramos y se tomaba el primero distinto de 'contrato' — el contagio, que
 * `origenDelPar` ya había derogado. Con un solo retorno marcado (y el retorno va en
 * S/ 0.00 a propósito) el renglón de 26 días contratados salía rotulado "SERVICIO
 * ADICIONAL" mientras `tipo` seguía diciendo "servicio" y el importe sumaba bajo
 * Servicios del periodo: dos textos distintos para la misma línea según se creara o se
 * recalculara. Y esa descripción es un snapshot que se imprime en el AFA-FL-07 y se
 * copia a correos y órdenes de compra.
 *
 * Si los portadores discrepan entre sí —alguien remarcó servicios después de emitir el
 * borrador— gana el más repetido: desde aquí la línea ya no se puede partir, así que
 * el texto tiene que describir a la mayoría de sus días. El empate lo decide el primer
 * portador, para que el resultado no baile entre recargas.
 */
export function origenDeTramos(filas: ReservaLiq[], lado: LadoLiquidacion): string {
  const portadores = filas.filter((r) => montoDe(r, lado) > 0);
  const votan = portadores.length ? portadores : filas;
  const cuenta = new Map<string, number>();
  for (const r of votan) {
    const o = origenContractual(r);
    cuenta.set(o, (cuenta.get(o) ?? 0) + 1);
  }
  let ganador = "contrato";
  let max = 0;
  for (const [o, n] of cuenta) if (n > max) { ganador = o; max = n; }
  return ganador;
}

/** Datos de apoyo que la página resuelve una sola vez (placas, capacidades, nombres). */
export type CatalogoLiq = {
  placaDe: (r: ReservaLiq) => string;
  /** Capacidad del VEHÍCULO asignado. Sirve para detectar unidades por debajo de lo contratado — nunca para el "N PAX" del formato. */
  capacidadDe: (r: ReservaLiq) => number | null;
  conductorDe: (r: ReservaLiq) => string;
  sedeNombre?: string | null;
  /**
   * Asientos contratados del servicio, resuelto en cascada por quien tenga acceso a
   * la base (lib/liquidacion-rutas.ts). Devuelve null cuando ninguna fuente lo sabe,
   * y entonces el formato sale SIN el "N PAX": entre un dato de menos y un dato
   * falso, el que se puede defender frente al cliente es el de menos.
   */
  paxContratadoDe?: (par: ParServicio) => number | null;
};

export type LadoLiquidacion = "cliente" | "proveedor";

// ── Sentido y nombre de ruta ────────────────────────────────────────────────

/** 'IDA' | 'RETORNO'. Prioriza el campo canónico; cae al nombre de ruta. */
export function sentidoDeReserva(r: ReservaLiq): "IDA" | "RETORNO" {
  const d = String(r.direccion_servicio ?? "").toLowerCase();
  if (d === "retorno") return "RETORNO";
  if (d === "ida") return "IDA";
  return /RETORNO|SALIDA/i.test(String(r.ruta_nombre ?? "")) ? "RETORNO" : "IDA";
}

/**
 * De dónde salió el rótulo de la ruta. Importa porque solo `nombre` produce el texto
 * que el cliente reconoce: con `tramo` o `ninguna` el servicio SÍ se liquida, pero
 * sale rotulado de otra forma y en otro lugar de la lista (que se ordena
 * alfabéticamente) — el operador lo lee como "esa ruta no salió".
 */
export type FuenteEtiqueta = "nombre" | "tramo" | "ninguna";

/**
 * El nombre COMPLETO de la ruta, tal como lo escribió la operación:
 *
 *     RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA
 *
 * Es lo que va al formato. Antes se imprimía solo el recorte "RUTA B" y con eso se
 * perdían la hora y los extremos, que es justo lo que distingue una ruta de otra:
 * dos rutas distintas de la misma letra salían como dos renglones de texto idéntico.
 *
 * Solo se normalizan los espacios. Ni mayúsculas ni acentos se tocan: este texto lo
 * lee el cliente y también el pasajero en su app, y tiene que decir lo mismo.
 */
export function nombreRutaDetalle(r: ReservaLiq | null | undefined): { nombre: string; fuente: FuenteEtiqueta } {
  const n = String(r?.ruta_nombre ?? "").trim().replace(/\s+/g, " ");
  if (n) return { nombre: n, fuente: "nombre" };
  const tramo = [r?.origen, r?.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { nombre: tramo, fuente: "tramo" } : { nombre: "SIN NOMBRE DE RUTA", fuente: "ninguna" };
}

/** Atajo cuando solo hace falta el texto. */
export const nombreRuta = (r: ReservaLiq | null | undefined) => nombreRutaDetalle(r).nombre;

/**
 * Separador entre "RUTA" y su letra. Con `\s+` a secas, "RUTA-A" y "RUTA:A" —que se
 * escriben a mano en tres pantallas distintas— no calzaban y el servicio salía rotulado
 * con su tramo. El `+` es deliberado: sin él "RUTAS" produciría "RUTA S".
 */
const RE_ETIQUETA_RUTA = /\bRUTA[\s:.\-–—]+([A-Z0-9]{1,3})\b/i;

/** Etiqueta + por qué es esa, para poder avisar cuando NO salió del nombre de la ruta. */
export function etiquetaRutaDetalle(r: ReservaLiq): { etiqueta: string; fuente: FuenteEtiqueta } {
  const m = RE_ETIQUETA_RUTA.exec(String(r.ruta_nombre ?? ""));
  if (m) return { etiqueta: `RUTA ${m[1].toUpperCase()}`, fuente: "nombre" };
  const tramo = [r.origen, r.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { etiqueta: tramo, fuente: "tramo" } : { etiqueta: "RUTA ÚNICA", fuente: "ninguna" };
}

/**
 * Etiqueta corta de la ruta para la descripción: "RUTA 1", "RUTA B"…
 * El nombre completo trae hora y extremos ("RUTA B/ ENTRADA 05:10/ CHILCA→…") y esos
 * ya se muestran aparte; aquí solo interesa el identificador que el cliente reconoce.
 */
export function etiquetaRuta(r: ReservaLiq): string {
  return etiquetaRutaDetalle(r).etiqueta;
}

// ── Servicio facturable: el par IDA + RETORNO ───────────────────────────────
//
// AFA cobra UNA tarifa por los dos tramos del día. Al generar los servicios en lote,
// el importe completo va en la IDA y el RETORNO queda en S/ 0.00 — los dos quedan
// unidos por `reserva_vinculada_id`. Verificado sobre los datos reales de 2026: los
// 210 retornos finalizados están en cero y los 414 vínculos son bidireccionales.
//
// Consecuencia para la liquidación: la unidad que se cobra NO es la reserva, es el
// PAR. Contar reservas facturaría 52 servicios donde el cliente pactó 26.

/** Un servicio facturable: la reserva que lleva la tarifa + los tramos que cubre. */
export type ParServicio = {
  /** La reserva que aporta el importe (normalmente la IDA). */
  cabeza: ReservaLiq;
  /** Tramos incluidos en esa misma tarifa (el RETORNO). Van al Anexo 1 en S/ 0.00. */
  adjuntas: ReservaLiq[];
  /**
   * false = estaba programado pero no se prestó NINGUNO de sus tramos. Suma a la
   * cantidad PROGRAMADA del formato y no a la cobrada: así el cliente lee "26 / 25" y
   * ve qué pasó, en vez de un "25 / 25" que esconde el servicio caído.
   *
   * Mira el PAR entero, no la cabeza. La cabeza es el tramo que lleva el importe, y
   * mirarla a ella daba una fuga de dinero real: si el cliente cancelaba la ida —que es
   * donde vive la tarifa— y el retorno sí se prestaba, el día quedaba como no ejecutado
   * y no se facturaba. Sin bloqueo y sin aviso: el servicio se daba y nadie lo cobraba.
   */
  ejecutado: boolean;
  /** Los tramos que realmente se prestaron. Vacío = el día entero se cayó. */
  ejecutados: ReservaLiq[];
  /**
   * Lo que CUBRE la tarifa, no lo que se prestó ese día. Se decide aquí, donde se sabe
   * si la reserva viaja enlazada, y no en la agrupación: allí solo se veía `adjuntas`,
   * que queda vacía cuando el retorno no se ejecutó, y el mismo servicio se partía en
   * dos líneas ("IDA" y "IDA Y RETORNO") a idéntica ruta y tarifa.
   */
  sentido: "IDA" | "RETORNO" | "IDA Y RETORNO";
  /**
   * Los dos tramos del servicio, identificados por su SENTIDO y no por cuál lleva el
   * importe. La distinción no es cosmética: la ida y el retorno tienen dos
   * `ruta_nombre` independientes (se teclean en dos campos distintos al generar el
   * programa), y como la tarifa va en uno solo, el formato terminaba rotulando la
   * línea con el nombre del tramo que cobraba. Si ese era el retorno, una RUTA A
   * podía salir impresa con el nombre de la RUTA B sin que nadie lo notara.
   */
  ida: ReservaLiq | null;
  retorno: ReservaLiq | null;
};

/** Reparte un par en (ida, retorno) por el sentido de cada tramo, no por quién cobra. */
function tramosDelPar(a: ReservaLiq, b?: ReservaLiq | null): { ida: ReservaLiq | null; retorno: ReservaLiq | null } {
  if (!b) return sentidoDeReserva(a) === "RETORNO" ? { ida: null, retorno: a } : { ida: a, retorno: null };
  const sa = sentidoDeReserva(a);
  const sb = sentidoDeReserva(b);
  if (sa === sb) return { ida: a, retorno: b };   // dato contradictorio: se respeta el orden recibido
  return sa === "IDA" ? { ida: a, retorno: b } : { ida: b, retorno: a };
}

/** Cómo se nombra un tramo en los avisos: "La ida del 03-08-2026". */
const rotuloTramo = (r: ReservaLiq) =>
  `${sentidoDeReserva(r) === "RETORNO" ? "El retorno" : "La ida"} del ${fechaFormato(r.fecha_servicio) || r.fecha_servicio || ""}`;

/** Importe de una reserva según el lado que se esté liquidando. */
function montoDe(r: ReservaLiq, lado: LadoLiquidacion): number {
  return Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
}

// El enlace ida↔retorno se lee por los DOS sentidos: ver `hermanoAqui` dentro de
// `analizarServicios` y lib/liquidacion-hermanos.ts. Seguirlo solo hacia adelante era lo
// que partía el día en dos cuando `reserva_vinculada_id` quedaba escrito en un solo lado.

// ── Bloqueos: qué NO se puede liquidar todavía ──────────────────────────────

export type Bloqueo = { codigo: string; mensaje: string };

/**
 * Motivos por los que un servicio no debería entrar a una liquidación. La pantalla los
 * muestra en rojo y no deja liquidar el grupo hasta resolverlos: una valorización mal
 * armada se descubre cuando el cliente la rechaza, semanas después.
 *
 * `cubiertaPor` es el par que ya lleva la tarifa: un RETORNO en S/ 0.00 enlazado a una
 * IDA con precio NO está incompleto, está incluido. Sin ese contexto marcaríamos como
 * error la mitad de la operación.
 */
export function bloqueosDe(
  r: ReservaLiq,
  lado: LadoLiquidacion,
  cubiertaPor?: ReservaLiq | null
): Bloqueo[] {
  const b: Bloqueo[] = [];
  if (r.estado !== "finalizada")
    b.push({ codigo: "no_finalizada", mensaje: "El servicio no está finalizado" });

  const cubierta = !!cubiertaPor && montoDe(cubiertaPor, lado) > 0;

  if (lado === "cliente") {
    if (!Number(r.precio_cliente ?? 0) && !cubierta)
      b.push({ codigo: "sin_precio", mensaje: "Sin precio de venta" });
    if (r.liquidacion_cliente_id)
      b.push({ codigo: "ya_liquidada", mensaje: `Ya está en la liquidación #${r.liquidacion_cliente_id}` });
    if (!r.cliente_id)
      b.push({ codigo: "sin_cliente", mensaje: "Sin cliente asignado" });
  } else {
    if (!Number(r.costo_proveedor ?? 0) && !cubierta)
      b.push({ codigo: "sin_costo", mensaje: "Sin costo de proveedor" });
    if (r.liquidacion_proveedor_id)
      b.push({ codigo: "ya_liquidada", mensaje: `Ya está en la liquidación #${r.liquidacion_proveedor_id}` });
    if (!r.empresa_tercerizada_id)
      b.push({ codigo: "sin_empresa", mensaje: "Sin empresa tercerizada" });
  }
  return b;
}

/** Una reserva que no entra al cierre, con el porqué en texto y en código. */
export type ReservaBloqueada = {
  r: ReservaLiq;
  motivos: string[];
  /**
   * Los mismos motivos como CÓDIGO. La pantalla decide con esto a qué modal mandar cada
   * fila; antes lo decidía olfateando el texto (`m.includes("Sin precio de venta")`), y
   * bastaba retocar una palabra del mensaje para que el botón de cargar precios dejara
   * de ver servicios sin que nadie se enterara.
   */
  codigos: string[];
};

export type AnalisisServicios = {
  /** Servicios facturables listos para valorizar. */
  pares: ParServicio[];
  /** Lo que no puede liquidarse todavía, con el motivo para mostrarlo en rojo. */
  bloqueadas: ReservaBloqueada[];
  /** Tramos incluidos que no se ejecutaron: no bloquean, pero hay que verlos. */
  avisos: { r: ReservaLiq; mensaje: string }[];
};

/**
 * Cómo encontrar el OTRO tramo del día cuando no está en el conjunto que se analiza.
 *
 * `analizarServicios` recibe las reservas de UN grupo (un cliente y su sede) ya filtradas
 * por "entra al cierre", y ahí el hermano puede faltar por dos motivos que no son el
 * mismo y que hasta ahora se contestaban igual —"Sin precio de venta"—, mandando a cargar
 * una tarifa para un día que ya está cobrado:
 *
 *   · quedó FUERA del cierre (ya liquidado en otro documento, o en otra sede);
 *   · o el enlace `reserva_vinculada_id` no existe y nadie sabe que son el mismo día.
 *
 * Los dos resolvedores los pone quien tiene el periodo entero delante (lib/liquidacion-
 * hermanos.ts). Sin ellos el análisis funciona igual que siempre, solo que sin poder
 * explicar esos dos casos.
 */
export type OpcionesAnalisis = {
  /** El hermano por el ENLACE ESCRITO, buscado en todo el periodo y en los dos sentidos. */
  hermanoDe?: (r: ReservaLiq) => ReservaLiq | null;
  /** El hermano DEDUCIDO cuando no hay enlace. Solo para explicar y ofrecer el arreglo. */
  hermanoProbableDe?: (r: ReservaLiq) => ReservaLiq | null;
  /**
   * Los posibles hermanos cuando ese día esa ruta salió con más de un móvil y NO se puede
   * elegir sin adivinar. Tampoco es "sin precio": el importe del día está en alguno de
   * ellos, así que cargarle una tarifa a este tramo lo cobraría dos veces.
   */
  candidatosAmbiguosDe?: (r: ReservaLiq) => ReservaLiq[] | null;
};

/**
 * El motivo REAL de un tramo que va en S/ 0.00 y no encontró a su hermano en el conjunto.
 *
 * Es el corazón del arreglo. "Sin precio de venta" es la respuesta correcta para un
 * servicio suelto al que nadie le cargó la tarifa, y la respuesta EQUIVOCADA —y cara—
 * para un retorno cuyo día ya se cobra en su ida: manda a cargar un importe que factura
 * el día dos veces. Los cuatro casos que se confundían en ese único mensaje:
 *
 *   · el enlace apunta a un tramo que ya se emparejó con un tercero (enlace cruzado);
 *   · el hermano existe pero quedó FUERA del cierre (ya liquidado, otra sede…);
 *   · el hermano quedó fuera del PERIODO (el nocturno que retorna al día siguiente);
 *   · no hay enlace, pero el par se deduce sin ambigüedad y falta escribirlo.
 *
 * Devuelve null cuando de verdad no hay nada que cubra este tramo: ahí sí falta el dato y
 * el bloqueo normal ("Sin precio de venta" / "Sin costo de proveedor") es el correcto.
 */
function tramoSinImporteCubierto(
  r: ReservaLiq,
  ctx: {
    lado: LadoLiquidacion;
    /** "tarifa" | "costo": el sustantivo, para decir "Su tarifa va en…". */
    plata: string;
    /** "la tarifa" | "el costo": con artículo, para el medio de la frase. */
    laPlata: string;
    ref: (x: ReservaLiq) => string;
    /** Hermano que está en el conjunto pero ya lo tomó otro par. */
    ocupado: ReservaLiq | null;
    /** Hermano por enlace escrito, buscado en todo el periodo. */
    fuera: ReservaLiq | null;
    /** Hermano deducido, cuando no hay enlace por ningún lado. */
    probable: ReservaLiq | null;
    /** Los posibles, cuando el día tuvo más de un móvil y no se puede elegir. */
    ambiguos: ReservaLiq[] | null;
    enElConjunto: (x: ReservaLiq) => boolean;
  }
): Bloqueo | null {
  const { lado, plata, laPlata, ref, ocupado, fuera, probable, ambiguos, enElConjunto } = ctx;
  const cuando = (x: ReservaLiq) => fechaFormato(x.fecha_servicio) || String(x.fecha_servicio ?? "");

  if (ocupado || (fuera && enElConjunto(fuera))) {
    const x = (ocupado ?? fuera)!;
    return {
      codigo: "enlace_cruzado",
      mensaje:
        `Su ${plata} va en ${ref(x)}, que ya quedó emparejado con otro tramo: ` +
        `el enlace ida↔retorno está cruzado y hay que arreglarlo en Programación`,
    };
  }

  if (fuera) {
    // El hermano existe en el periodo pero no entró a este cierre. Si lleva el importe,
    // este tramo NO necesita tarifa: necesita que se diga dónde quedó la suya.
    if (montoDe(fuera, lado) > 0) {
      const doc = Number((lado === "cliente" ? fuera.liquidacion_cliente_id : fuera.liquidacion_proveedor_id) ?? 0);
      return {
        codigo: "tarifa_fuera_del_cierre",
        mensaje:
          `Su ${plata} va en ${ref(fuera)} (${cuando(fuera)}), que no entra a este cierre` +
          (doc ? ` — ya está en la liquidación #${doc}` : "") +
          `. Este tramo va en S/ 0.00 a propósito: no le cargues un importe`,
      };
    }
    // Ninguno de los dos lleva importe: eso sí es un dato que falta, y el bloqueo normal
    // lo dice mejor. Se deja caer.
    return null;
  }

  // Sin precio y con un enlace que apunta fuera del periodo (típico del servicio nocturno
  // que retorna al día siguiente): decirlo explícitamente, porque "sin precio de venta"
  // mandaría a buscar un dato que no falta.
  if (r.reserva_vinculada_id)
    return {
      codigo: "tarifa_fuera_del_periodo",
      mensaje: `Su ${plata} va en el servicio #${r.reserva_vinculada_id}, que no está en este periodo`,
    };

  // No hay enlace por ningún lado, pero el par se deduce sin ambigüedad y el otro tramo
  // lleva el importe del día. El dato que falta NO es la tarifa: es el enlace.
  if (probable && montoDe(probable, lado) > 0)
    return {
      codigo: "falta_enlace",
      mensaje:
        `Le falta el enlace ida↔retorno con ${ref(probable)}, que lleva ${laPlata} del día ` +
        `(S/ ${montoDe(probable, lado).toFixed(2)}). No necesita importe propio: enlázalos`,
    };

  // Ese día esa ruta salió con más de un móvil: el hermano es UNO de varios y el ERP no
  // elige. Tampoco puede decir "sin precio": el importe del día está en alguno de esos
  // candidatos, así que cargarle una tarifa a este tramo cobraría el día dos veces. La
  // única salida honesta es nombrar a los candidatos y pedir que lo enlace un humano.
  //
  // Con la condición de que ALGUNO de esos candidatos lleve el importe: si ninguno lo
  // lleva, este tramo no está cubierto por nadie y lo que falta de verdad es el precio —
  // ahí el bloqueo normal es el correcto, y desviarlo dejaría al operador sin poder
  // cargarlo desde el modal de precios.
  const cubren = (ambiguos ?? []).filter((x) => montoDe(x, lado) > 0);
  if (cubren.length)
    return {
      codigo: "hermano_ambiguo",
      mensaje:
        `Ese día esa ruta salió con más de un móvil: su hermano es uno de ${ambiguos!.length} ` +
        `(${ambiguos!.map(ref).join(", ")}) y no se puede saber cuál sin adivinar. ` +
        `${laPlata} del día ya está en ${cubren.map(ref).join(" o ")}, así que NO le pongas ` +
        `importe: enlázalo a mano`,
    };

  return null;
}

/**
 * Separa un conjunto de servicios en unidades facturables y bloqueos.
 *
 * Criterio dentro de un par enlazado:
 *   · uno con importe y el otro en 0  → el primero es la cabeza, el otro va incluido
 *   · los dos con importe             → son dos servicios independientes
 *   · los dos en 0                    → falta el dato: ambos bloqueados
 *
 * Si la cabeza está bloqueada (ya liquidada, sin cliente…), su par también: no tiene
 * sentido cobrar medio servicio.
 */
export function analizarServicios(
  reservas: ReservaLiq[],
  lado: LadoLiquidacion,
  opts?: OpcionesAnalisis
): AnalisisServicios {
  const porId = new Map<number, ReservaLiq>(reservas.map((r) => [r.id, r]));
  const usadas = new Set<number>();
  const res: AnalisisServicios = { pares: [], bloqueadas: [], avisos: [] };

  // ── El enlace ida↔retorno se lee por los DOS sentidos ─────────────────────
  //
  // `reserva_vinculada_id` se escribe en los dos lados, pero en dos pasos, y cuando el
  // segundo no llega —o alguien borra y regenera un tramo— queda escrito en uno solo.
  // Siguiéndolo solo hacia adelante, el tramo que no lo lleva no encontraba a su hermano
  // y el retorno en S/ 0.00 salía del cierre como "Sin precio de venta": el ERP pedía
  // cobrar otra vez un día que su ida ya cobra. Este índice es la mitad que faltaba.
  const apuntanA = new Map<number, ReservaLiq[]>();
  for (const r of reservas) {
    const otro = Number(r.reserva_vinculada_id ?? 0);
    if (!otro) continue;
    const ya = apuntanA.get(otro);
    if (ya) ya.push(r);
    else apuntanA.set(otro, [r]);
  }
  /** El otro tramo DENTRO de este conjunto, por cualquiera de los dos sentidos del enlace. */
  const hermanoAqui = (r: ReservaLiq): ReservaLiq | null => {
    const adelante = r.reserva_vinculada_id ? porId.get(Number(r.reserva_vinculada_id)) : undefined;
    if (adelante) return adelante;
    // Hacia atrás solo si es inequívoco: con dos filas apuntando a la misma, el enlace
    // está roto de otra forma y elegir una sería adivinar.
    const quienes = apuntanA.get(r.id) ?? [];
    return quienes.length === 1 ? quienes[0] : null;
  };

  const hecho = (r: ReservaLiq) => r.estado === "finalizada";
  // "No finalizado" no es un bloqueo: es un servicio programado que no se prestó, y el
  // formato tiene que mostrarlo en la columna PROG./EJEC. El resto sí impide liquidar.
  const trabas = (r: ReservaLiq, cubiertaPor?: ReservaLiq | null) =>
    bloqueosDe(r, lado, cubiertaPor).filter((b) => b.codigo !== "no_finalizada");
  const bloquear = (r: ReservaLiq, motivos: Bloqueo[]) => {
    if (motivos.length)
      res.bloqueadas.push({ r, motivos: motivos.map((b) => b.mensaje), codigos: motivos.map((b) => b.codigo) });
  };
  const ref = (x: ReservaLiq) => x.codigo ?? `#${x.id}`;
  const plata = lado === "cliente" ? "tarifa" : "costo";
  const laPlata = lado === "cliente" ? "la tarifa" : "el costo";

  for (const r of reservas) {
    if (usadas.has(r.id)) continue;

    // El par solo cuenta si está en el mismo conjunto (mismo cliente y periodo).
    const posible = hermanoAqui(r);
    const par = posible && !usadas.has(posible.id) ? posible : null;

    if (!par) {
      usadas.add(r.id);
      // Un tramo en S/ 0.00 con hermano NO es un dato que falta: es el tramo incluido en
      // la tarifa del día. Antes eso solo se sabía si el hermano estaba en este mismo
      // conjunto y el enlace apuntaba hacia él; en cualquier otro caso salía "Sin precio
      // de venta", que manda a cobrar por segunda vez un día ya cobrado.
      if (montoDe(r, lado) <= 0) {
        const traba = tramoSinImporteCubierto(r, {
          lado, plata, laPlata, ref,
          // `posible` acá está tomado por otro par: el enlace apunta a algo que ya se
          // emparejó con un tercero.
          ocupado: posible ?? null,
          fuera: opts?.hermanoDe?.(r) ?? null,
          probable: opts?.hermanoProbableDe?.(r) ?? null,
          ambiguos: opts?.candidatosAmbiguosDe?.(r) ?? null,
          enElConjunto: (x) => porId.has(x.id),
        });
        if (traba) { bloquear(r, [traba]); continue; }
      }
      const motivos = trabas(r);
      if (motivos.length) bloquear(r, motivos);
      else res.pares.push({
        cabeza: r, adjuntas: [], ejecutado: hecho(r), ejecutados: hecho(r) ? [r] : [],
        sentido: sentidoDeReserva(r), ...tramosDelPar(r),
      });
      continue;
    }

    usadas.add(r.id);
    usadas.add(par.id);

    // El enlace quedó escrito en un solo lado. El par se arma igual —para eso se mira en
    // los dos sentidos—, pero el dato sigue roto, y el resto del ERP lo lee hacia
    // adelante: en Programación ese tramo se ve suelto y sus avisos vuelven a mentir. Se
    // dice acá porque es el único sitio donde la pareja se ve entera.
    const vinculoR = Number(r.reserva_vinculada_id ?? 0);
    const vinculoPar = Number(par.reserva_vinculada_id ?? 0);
    if (vinculoR !== par.id || vinculoPar !== r.id) {
      const suelto = vinculoR === par.id ? par : r;
      const apunta = suelto === r ? par : r;
      res.avisos.push({
        r: suelto,
        mensaje:
          `El enlace ida↔retorno está escrito en un solo lado: ${ref(apunta)} apunta a este tramo, ` +
          `pero ${ref(suelto)} no apunta de vuelta. El cierre los cobra como un solo día igual, ` +
          `pero en Programación se ve suelto — repáralo con "Enlazar ida↔retorno".`,
      });
    }

    const mA = montoDe(r, lado);
    const mB = montoDe(par, lado);

    // Los dos cobran: dos servicios facturables distintos que además viajan juntos.
    if (mA > 0 && mB > 0) {
      for (const x of [r, par]) {
        const motivos = trabas(x);
        if (motivos.length) bloquear(x, motivos);
        else res.pares.push({
          cabeza: x, adjuntas: [], ejecutado: hecho(x), ejecutados: hecho(x) ? [x] : [],
          sentido: sentidoDeReserva(x), ...tramosDelPar(x),
        });
      }
      continue;
    }

    // Ninguno cobra: el precio nunca se cargó. Los dos quedan fuera con su motivo.
    if (mA <= 0 && mB <= 0) {
      bloquear(r, trabas(r));
      bloquear(par, trabas(par));
      continue;
    }

    // El caso normal: uno lleva la tarifa de los dos tramos.
    const cabeza = mA > 0 ? r : par;
    const adjunta = mA > 0 ? par : r;

    const motivosCabeza = trabas(cabeza);
    if (motivosCabeza.length) {
      bloquear(cabeza, motivosCabeza);
      bloquear(adjunta, [{
        codigo: "cabeza_bloqueada",
        mensaje: `Va con el servicio ${ref(cabeza)}, que está bloqueado`,
      }]);
      continue;
    }

    // Un día se cobra si se prestó CUALQUIERA de sus dos tramos. Mirar solo la cabeza
    // —el tramo que lleva el importe— era una fuga de dinero: con la ida cancelada por
    // el cliente y el retorno prestado, el día se daba por no ejecutado y no se
    // facturaba, sin bloqueo y sin aviso.
    const ejecutados = [cabeza, adjunta].filter(hecho);
    const ejecutado = ejecutados.length > 0;

    // Los dos tramos declaran orígenes distintos. Manda el de la cabeza —quien lleva el
    // importe, clasifica—, pero la marca del otro tramo no se traga en silencio: o el
    // día entero iba aparte y falta marcar este lado, o es el registro de que solo ese
    // tramo cambió de manos. Lo primero mueve dinero; lo segundo, no. Quien emite tiene
    // que poder distinguirlo antes de firmar.
    const origenCabeza = origenContractual(cabeza);
    const origenAdjunta = origenContractual(adjunta);
    if (origenCabeza !== origenAdjunta)
      res.avisos.push({
        r: adjunta,
        mensaje:
          `${rotuloTramo(adjunta)} está marcado como ${origenAdjunta.toUpperCase()} y ` +
          `${rotuloTramo(cabeza).toLowerCase()} como ${origenCabeza.toUpperCase()}. El día se cobra ` +
          `como ${origenCabeza.toUpperCase()} porque el importe está en ${rotuloTramo(cabeza).toLowerCase()} ` +
          `— si el día entero iba aparte, marca los dos tramos.`,
      });

    const motivosAdjunta = trabas(adjunta, cabeza);
    if (motivosAdjunta.length) {
      // El tramo incluido tiene su propio problema (p. ej. ya entró en otra
      // liquidación): la tarifa se cobra igual, pero queda el aviso.
      res.avisos.push({
        r: adjunta,
        mensaje: `${rotuloTramo(adjunta)}: ${motivosAdjunta.map((b) => b.mensaje).join(" · ")}`,
      });
      res.pares.push({
        cabeza, adjuntas: [], ejecutado, ejecutados,
        sentido: "IDA Y RETORNO", ...tramosDelPar(cabeza, adjunta),
      });
      continue;
    }

    // Un tramo caído no invalida el día, pero hay que verlo antes de emitir. El texto
    // nombra el tramo REAL: antes decía siempre "el retorno", y con la ida cancelada
    // el aviso señalaba al tramo equivocado.
    const caidos = [cabeza, adjunta].filter((x) => !hecho(x));
    if (ejecutado && caidos.length) {
      for (const x of caidos)
        res.avisos.push({
          r: x,
          mensaje: `${rotuloTramo(x)} no se ejecutó (${x.estado ?? "sin estado"}), pero la tarifa del día se cobra completa`,
        });
    }

    // El importe vive en un tramo que NO se prestó mientras el otro sí: el día se cobra
    // igual, pero conviene revisar si corresponde cobrarlo completo o mover el importe.
    if (ejecutado && !hecho(cabeza))
      res.avisos.push({
        r: cabeza,
        mensaje: `El importe está en ${rotuloTramo(cabeza).toLowerCase()}, que no se prestó. Se cobra el día porque sí se prestó ${
          sentidoDeReserva(ejecutados[0]) === "RETORNO" ? "el retorno" : "la ida"
        } — revisa si el importe debe moverse o ajustarse.`,
      });

    res.pares.push({
      cabeza,
      // Al puente solo van los tramos realmente prestados: marcar como liquidado algo
      // que no se ejecutó ensuciaría el ciclo del servicio.
      adjuntas: hecho(adjunta) ? [adjunta] : [],
      ejecutado,
      ejecutados,
      sentido: "IDA Y RETORNO",
      ...tramosDelPar(cabeza, adjunta),
    });
  }

  return res;
}

/** Avisos que NO bloquean pero conviene ver antes de emitir (van al Anexo 1). */
export function avisosDe(r: ReservaLiq, catalogo: CatalogoLiq): string[] {
  const a: string[] = [];
  if (!catalogo.placaDe(r)) a.push("Sin unidad asignada");
  if (!catalogo.conductorDe(r)) a.push("Sin conductor asignado");
  if (!r.ruta_nombre) a.push("Sin nombre de ruta");
  return a;
}

// ── Precio unitario del formato ─────────────────────────────────────────────

/**
 * Precio que va a la columna "Precio unitario". El formato lista NETOS (el IGV se suma
 * abajo), así que si en el ERP el importe se cargó con IGV incluido hay que extraerlo.
 * La decisión viaja explícita en la liquidación (`precios_incluyen_igv`) porque adivinar
 * aquí desviaría el documento un 18%.
 */
export function precioUnitario(
  r: ReservaLiq,
  lado: LadoLiquidacion,
  opts: { preciosIncluyenIgv: boolean; igvPct: number }
): number {
  const bruto = Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
  if (!opts.preciosIncluyenIgv) return redondear(bruto);
  return redondear(desdeTotal(bruto, opts.igvPct).base);
}

// ── Agrupación ──────────────────────────────────────────────────────────────

export type LineaAgrupada = {
  clave: string;
  /**
   * 'adicional' cuando el servicio no venía en el contrato. No es cosmético: el
   * formato AFA-FL-07 pinta esas líneas aparte y las suma en su propio subtotal
   * ("Adicionales autorizados"), que hasta ahora solo se podía llenar escribiendo el
   * importe a mano en el editor.
   */
  tipo: "servicio" | "adicional";
  /** contrato | adicional | contingencia — el valor crudo, para poder rotularlo. */
  origen_contractual: string;
  descripcion: string;
  unidad_medida: string;
  cantidad_programada: number;
  cantidad_ejecutada: number;
  cantidad: number;
  precio_unitario: number;
  total_linea: number;
  /** ids de las reservas EJECUTADAS que sustentan la línea (van al Anexo 1). */
  reservas: number[];
  /**
   * ids de las reservas que ENCABEZAN cada servicio ejecutado — una por servicio, sin
   * los tramos incluidos. `reservas` trae ida y retorno, así que contar sobre ella
   * duplica: es lo que imprimía "19 / 38" en la columna PROG./EJEC.
   */
  servicios: number[];
  /** ids de todas las del periodo, ejecutadas o no (para el contraste programado/ejecutado). */
  reservas_periodo: number[];
  /** Etiqueta corta ("RUTA B") para las listas compactas de la app. NO es lo que se imprime. */
  ruta: string;
  /** Por qué la etiqueta es la que es: con `tramo`/`ninguna` el cliente no leerá "RUTA A". */
  fuente_ruta: FuenteEtiqueta;
  /** Nombre COMPLETO de cada tramo, tal como lo escribió la operación. Esto es lo que se imprime. */
  nombre_ida: string | null;
  nombre_retorno: string | null;
  sentido: string;
  /** Posición dentro del día cuando la ruta necesita más de una unidad a la misma hora. */
  movil: number;
  /** Cuántas unidades simultáneas tiene la ruta. 1 = no se imprime ningún "MÓVIL". */
  moviles: number;
  /** Todas las placas que cubrieron la ruta en el periodo. Van al detalle, nunca parten la línea. */
  placas: string[];
  /** Asientos CONTRATADOS. null = ninguna fuente lo sabe y el formato sale sin el "N PAX". */
  pax_contratado: number | null;
  /**
   * La capacidad más chica que se asignó en el periodo. No se imprime: sirve para avisar
   * en pantalla cuando se mandó una unidad por debajo de lo contratado, que es un
   * incumplimiento que hoy no se detecta porque no había contra qué compararlo.
   */
  capacidad_minima_asignada: number | null;
  referencia: string;
};

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

/** Fecha 'AAAA-MM-DD' → '15-06-2026' (como se escribe en el formato). */
export function fechaFormato(iso: string | null | undefined): string {
  const s = String(iso ?? "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** Letra de la serie del Anexo 1: 1→A, 2→B … 27→AA. */
function serieAnexo(n: number): string {
  let s = "";
  let i = n;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s || "A";
}

// ── Qué servicios son LA MISMA RUTA CONTRATADA ──────────────────────────────
//
// EL PROBLEMA, MEDIDO
//
// La LQC-2026-000004 salió con 30 ítems para 141 servicios de un cliente en un mes. No
// había 30 rutas: la clave era el NOMBRE de la ruta —texto libre tecleado en tres
// pantallas— y el mismo recorrido aparece escrito de varias formas. Medido sobre esos
// datos con scripts/diagnostico-agrupacion.mts:
//
//     nombre completo + tarifa (lo de antes) ....... 30 ítems
//     nombre sin la hora + tarifa .................. 21
//     extremos en el mapa ±200 m + tarifa .......... 13
//     techo (etiqueta RUTA + tarifa) ............... 12
//
// TRES CAUSAS, NINGUNA ES UNA RUTA DISTINTA
//
//   · la hora va DENTRO del nombre: 'ENTRADA 06:30' y 'ENTRADA 06:35' son la misma ruta
//     contratada saliendo dos días a horas ligeramente distintas;
//   · el nombre lo sugirió el sistema desde un paradero sin renombrar, y sale con la
//     dirección geocodificada: 'W2VG+39R, EL AGUSTINO 15022, PERÚ→M5JG+GFG…';
//   · el mismo extremo se rotuló con otro paradero de referencia: 'BSF→1RO DE MAYO' y
//     'BSF→ALIPIO'.
//
// EL MAPA NO SUSTITUYE AL NOMBRE: SE SUMAN
//
// Comparar los extremos parecía la respuesta completa, y no lo es. En SNACKS AMERICA
// LATINA el mapa SOLO dio 5 ítems donde el nombre daba 4: un 11 % de los servicios no
// tiene coordenadas en sus extremos y queda en cubos propios que no se juntan con nadie,
// aunque el nombre sea idéntico. Y al revés, el nombre no alcanza cuando alguien lo
// tecleó distinto. Los dos ejes fallan en sitios diferentes, así que se unen por
// CUALQUIERA de los dos y se resuelve con conjuntos disjuntos.
//
// LA TARIFA Y EL PAX CONTRATADO NUNCA ENTRAN EN LA UNIÓN
//
// Regla dura del negocio: dos ítems con precio unitario distinto no se unen jamás. El
// formato imprime CANT × P. UNITARIO = TOTAL, y promediar dos tarifas daría un unitario
// que nadie pactó. Aquí se sostiene POR CONSTRUCCIÓN y no por cuidado: la tarifa y el
// origen contractual son el cubo dentro del cual se busca, así que ninguna cadena de
// uniones puede cruzarlos. `agruparServicios` lo verifica igual antes de devolver.

/**
 * Cuánto puede separar a dos paraderos para seguir siendo "el mismo sitio".
 *
 * 200 m sale de medirlo, no de elegirlo: a 50 m el documento real daba 15 ítems y a 200
 * bajaba a 13, que es el techo alcanzable menos uno. A 500 m aparecía el primer caso de
 * sobre-unión —un cliente quedaba con MENOS ítems que su propio techo—, señal de que a esa
 * distancia ya se estaban juntando dos paraderos que la operación distingue.
 */
export const RADIO_MISMO_PARADERO_M = 200;

/**
 * El nombre de la ruta sin el reloj. 'RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF' pasa a
 * 'RUTA A ENTRADA SANTA ANITA→BSF'.
 *
 * Se conserva ENTRADA/RETORNO porque distingue el sentido, que sí importa. Lo que se borra
 * es la hora: la lleva cada servicio en el Anexo 1, donde el cliente la puede verificar
 * día por día, y en el ítem solo servía para partirlo.
 */
export function sinHoraRuta(s: string | null | undefined): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
    .replace(/[\/\s]+/g, " ")
    .trim();
}

type PuntoRuta = { nombre: string; lat: number | null; lng: number | null };

/** El paradero `inicio` o `destino` del snapshot. null cuando el tramo no lo trae. */
function extremoDe(paradas: unknown, tipo: "inicio" | "destino"): PuntoRuta | null {
  if (!Array.isArray(paradas)) return null;
  const p: any = paradas.find((x: any) => String(x?.tipo ?? "") === tipo);
  if (!p) return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  return {
    nombre: String(p.nombre ?? "").trim().toUpperCase().replace(/\s+/g, " "),
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}

/** Metros entre dos puntos (haversine). Sobra precisión para distinguir paraderos. */
function metrosEntre(a: PuntoRuta, b: PuntoRuta): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Reparte los extremos en "lugares" por cercanía, y devuelve con qué etiqueta se compara
 * cada uno. Greedy sobre una lista ORDENADA: la misma entrada da siempre el mismo reparto,
 * así que la agrupación no baila entre recargas ni entre el servidor y el navegador.
 *
 * Un punto sin coordenadas NO se acerca a nadie: cae en su propio lugar rotulado por su
 * nombre. Es deliberado — sin coordenadas no hay evidencia de que dos paraderos sean el
 * mismo, y para eso ya está el eje del nombre.
 */
function mapaDeLugares(puntos: PuntoRuta[], radio: number): Map<string, string> {
  const clave = (p: PuntoRuta) => `${p.nombre}|${p.lat ?? ""}|${p.lng ?? ""}`;
  const unicos = new Map<string, PuntoRuta>();
  for (const p of puntos) if (!unicos.has(clave(p))) unicos.set(clave(p), p);

  const centros: { punto: PuntoRuta; id: string }[] = [];
  const asignado = new Map<string, string>();
  for (const [k, p] of [...unicos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (p.lat == null || p.lng == null) { asignado.set(k, `sc:${p.nombre}`); continue; }
    const cerca = centros.find((c) => metrosEntre(c.punto, p) <= radio);
    if (cerca) { asignado.set(k, cerca.id); continue; }
    const id = `L${centros.length + 1}`;
    centros.push({ punto: p, id });
    asignado.set(k, id);
  }
  return asignado;
}

/** Las señas de un par por los dos ejes, ya separadas por tramo. */
type SenasRuta = {
  /** Tarifa + origen contractual: el cubo que ninguna unión puede cruzar. */
  dinero: string;
  idaNombre: string; retNombre: string;
  idaMapa: string; retMapa: string;
};

/**
 * Agrupa los pares en RUTAS CONTRATADAS: uno por ítem del formato.
 *
 * Une dos pares cuando coinciden por el NOMBRE sin la hora O por los EXTREMOS en el mapa,
 * siempre dentro de la misma tarifa y el mismo origen contractual.
 *
 * EL DÍA AL QUE LE FALTA UN TRAMO. Un día cuyo retorno se canceló —o cuyo enlace nunca se
 * escribió— llega con un solo tramo, así que su mitad de retorno va vacía y ninguna
 * comparación completa lo empareja: salía SIEMPRE en un ítem propio aunque su ida fuera
 * idéntica a la de los demás días. En el documento real son dos renglones de la RUTA B que
 * existen solo porque esos días no hubo retorno. Así que el tramo ausente se trata como
 * comodín — PERO solo cuando no hay ambigüedad: si dentro de la misma ida y la misma
 * tarifa conviven DOS retornos distintos, el día suelto podría ir con cualquiera y elegir
 * sería adivinar. Ahí se queda aparte, que es el mismo criterio que `analizarServicios`
 * aplica al hermano ambiguo.
 */
export function agruparPorRutaContratada(
  pares: ParServicio[],
  lado: LadoLiquidacion,
  opts: {
    preciosIncluyenIgv: boolean;
    igvPct: number;
    /**
     * Los asientos CONTRATADOS que se imprimirían para este servicio. Separa ítems igual
     * que la tarifa, y por el mismo motivo: el formato imprime UN "N PAX" por ítem, así
     * que reunir servicios contratados a 4 y a 10 asientos obliga a imprimir un número
     * que es falso para unos u otros. Y era peor que un empate: `agruparServicios` tomaba
     * el pax del PRIMER par del bucket, de modo que el número que salía en el papel
     * dependía del orden en que se hubieran leído las reservas.
     *
     * Sin esta función el eje no separa, que es como se comportaba antes.
     */
    paxDe?: (p: ParServicio) => number | null;
  }
): ParServicio[][] {
  if (pares.length < 2) return pares.map((p) => [p]);

  // Los lugares se calculan sobre los extremos de ESTE conjunto (un cliente y su periodo):
  // mezclar clientes solo agrandaría el radio de confusión.
  const puntos: PuntoRuta[] = [];
  for (const p of pares)
    for (const r of [p.ida, p.retorno])
      for (const t of ["inicio", "destino"] as const) {
        const e = r ? extremoDe(r.paradas_json, t) : null;
        if (e) puntos.push(e);
      }
  const lugares = mapaDeLugares(puntos, RADIO_MISMO_PARADERO_M);
  const lugarDe = (r: ReservaLiq | null, t: "inicio" | "destino") => {
    const e = r ? extremoDe(r.paradas_json, t) : null;
    if (!e) return "";
    return lugares.get(`${e.nombre}|${e.lat ?? ""}|${e.lng ?? ""}`) ?? `?${e.nombre}`;
  };
  const extremos = (r: ReservaLiq | null) => (r ? `${lugarDe(r, "inicio")}→${lugarDe(r, "destino")}` : "");

  const senas = new Map<ParServicio, SenasRuta>();
  for (const p of pares) {
    const precio = precioUnitario(p.cabeza, lado, opts).toFixed(2);
    const pax = opts.paxDe?.(p) ?? null;
    senas.set(p, {
      dinero: `${precio}|${origenDelPar(p)}|pax:${pax ?? ""}`,
      idaNombre: sinHoraRuta(p.ida ? nombreRuta(p.ida) : ""),
      retNombre: sinHoraRuta(p.retorno ? nombreRuta(p.retorno) : ""),
      idaMapa: extremos(p.ida),
      retMapa: extremos(p.retorno),
    });
  }

  // ── Conjuntos disjuntos ───────────────────────────────────────────────────
  const padre = new Map<ParServicio, ParServicio>(pares.map((p) => [p, p]));
  const raiz = (p: ParServicio): ParServicio => {
    let r = p;
    while (padre.get(r) !== r) r = padre.get(r)!;
    let q = p;                                    // compresión de camino
    while (padre.get(q) !== q) { const s = padre.get(q)!; padre.set(q, r); q = s; }
    return r;
  };
  const unir = (a: ParServicio, b: ParServicio) => {
    const ra = raiz(a), rb = raiz(b);
    if (ra !== rb) padre.set(ra, rb);
  };

  // Cubos por tarifa + origen contractual + PAX contratado. TODA la unión ocurre dentro
  // de un cubo, así que ninguna cadena puede cruzar ninguno de los tres: las dos reglas
  // duras —ni dos tarifas ni dos capacidades contratadas en el mismo ítem— son
  // estructurales, no algo que haya que recordar respetar.
  const cubos = new Map<string, ParServicio[]>();
  for (const p of pares) {
    const k = senas.get(p)!.dinero;
    const ya = cubos.get(k);
    if (ya) ya.push(p); else cubos.set(k, [p]);
  }

  /**
   * La firma del par por un eje. Se compara TRAMO CONTRA TRAMO y de forma simétrica: no
   * se privilegia la ida.
   *
   * La primera versión bucketizaba por la ida y sub-agrupaba por el retorno, y con eso los
   * servicios que son SOLO RETORNO —los adicionales del formato real, seis de sus treinta
   * ítems— quedaban fuera de la unión entera: sin ida, no entraban en ningún cubo. Dos
   * retornos de la misma ruta a distinta hora seguían saliendo como dos ítems.
   */
  const firma = (p: ParServicio, eje: "nombre" | "mapa") => {
    const s = senas.get(p)!;
    return eje === "nombre" ? { ida: s.idaNombre, ret: s.retNombre } : { ida: s.idaMapa, ret: s.retMapa };
  };

  /**
   * ¿Son el mismo ítem por este eje? Los tramos presentes tienen que coincidir, y al menos
   * uno tiene que coincidir DE VERDAD: dos pares a los que solo les consta el retorno no
   * son la misma ruta por el mero hecho de que a ambos les falte la ida.
   */
  const casan = (a: ParServicio, b: ParServicio, eje: "nombre" | "mapa") => {
    const x = firma(a, eje), y = firma(b, eje);
    const idaOk = !x.ida || !y.ida || x.ida === y.ida;
    const retOk = !x.ret || !y.ret || x.ret === y.ret;
    const algoReal = (!!x.ida && x.ida === y.ida) || (!!x.ret && x.ret === y.ret);
    return idaOk && retOk && algoReal;
  };

  for (const ps of cubos.values()) {
    // Paso 1 · firma EXACTA, empates incluidos. Agrupar por `ida|ret` tal cual —con los
    // huecos y todo— une lo que de verdad es idéntico por este eje, y de paso resuelve
    // solo el caso de la ruta contratada de un solo sentido: dos días que ambos son solo
    // ida comparten la firma `ida|` y caen juntos.
    //
    // La primera versión saltaba cualquier par al que le faltara un tramo y lo mandaba al
    // paso 2. Con una ruta de solo ida —o con solo retorno, que es como vienen los
    // adicionales del formato— eso significaba que NINGÚN par se unía en el paso 1, así
    // que todos llegaban al paso 2 siendo cada uno su propia raíz y se bloqueaban entre
    // ellos por "ambigüedad": 40 días de la misma ruta salían como 40 ítems.
    for (const eje of ["nombre", "mapa"] as const) {
      const porFirma = new Map<string, ParServicio[]>();
      for (const p of ps) {
        const f = firma(p, eje);
        if (!f.ida && !f.ret) continue;           // este eje no sabe nada de este par
        const k = `${f.ida}|${f.ret}`;
        const ya = porFirma.get(k);
        if (ya) ya.push(p); else porFirma.set(k, [p]);
      }
      for (const qs of porFirma.values())
        for (let i = 1; i < qs.length; i++) unir(qs[0], qs[i]);
    }

    // Paso 2 · los días a los que les falta un tramo QUE OTROS SÍ TIENEN. Se acoplan al
    // grupo con el que casan — pero SOLO si casan con uno. Con dos grupos posibles el día
    // suelto podría ir a cualquiera y elegir sería adivinar: se queda aparte, igual que
    // hace `analizarServicios` con el hermano ambiguo.
    const leFaltaAlgo = (p: ParServicio) => {
      for (const eje of ["nombre", "mapa"] as const) {
        const f = firma(p, eje);
        if (!f.ida && !f.ret) continue;
        // Le falta un tramo por este eje, y hay algún otro par del cubo que sí lo declara.
        if (!f.ida && ps.some((q) => q !== p && firma(q, eje).ida)) return true;
        if (!f.ret && ps.some((q) => q !== p && firma(q, eje).ret)) return true;
      }
      return false;
    };
    for (const s of ps.filter(leFaltaAlgo)) {
      const destinos = new Set<ParServicio>();
      for (const q of ps) {
        if (q === s || raiz(q) === raiz(s)) continue;
        if (casan(s, q, "nombre") || casan(s, q, "mapa")) destinos.add(raiz(q));
      }
      if (destinos.size === 1) unir([...destinos][0], s);
    }
  }

  const componentes = new Map<ParServicio, ParServicio[]>();
  for (const p of pares) {
    const r = raiz(p);
    const ya = componentes.get(r);
    if (ya) ya.push(p); else componentes.set(r, [p]);
  }
  return [...componentes.values()];
}

/**
 * El nombre que se IMPRIME cuando un ítem reúne varias redacciones de la misma ruta: el
 * más repetido entre sus tramos, con el alfabético como desempate para que no baile.
 *
 * Es la misma regla que `recalcularDescripciones` (lib/liquidaciones.ts) ya usaba para
 * reescribir la descripción de una línea existente, así que crear y recalcular siguen
 * dando el mismo texto. Y es un dato que alguien escribió —el que escribió más veces—,
 * no una redacción inventada por el ERP.
 */
function nombreDominante(filas: (ReservaLiq | null)[]): string | null {
  const cuenta = new Map<string, number>();
  for (const r of filas) {
    if (!r) continue;
    const n = nombreRuta(r);
    if (n && n !== "SIN NOMBRE DE RUTA") cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  }
  if (!cuenta.size) return null;
  return [...cuenta].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export type OpcionesAgrupacion = {
  lado: LadoLiquidacion;
  catalogo: CatalogoLiq;
  preciosIncluyenIgv: boolean;
  igvPct: number;
  /** Nombre de la sede/CD tal como debe leerse en la descripción ('CD CALLAO'). */
  sede?: string | null;
  /** Rango del periodo, para el texto "DEL … AL …". */
  desde?: string | null;
  hasta?: string | null;
  /** Encabezado del servicio; por defecto 'TRANSPORTE DE PERSONAL'. */
  concepto?: string;
};

/**
 * Agrupa los servicios facturables de UNA sede en las líneas del formato.
 *
 * Recibe PARES (ida+retorno = un servicio), no reservas sueltas: así la cantidad que
 * lee el cliente es la que pactó. Ver `analizarServicios`.
 *
 * CLAVE DE AGRUPACIÓN: nombre de la ida + nombre del retorno + tarifa. Es decir, la
 * identidad de la RUTA CONTRATADA, que es exactamente lo que se imprime. Antes la
 * clave era `letra + turno + sentido + tarifa`, con dos ejes —el turno y el sentido—
 * que NO se imprimían: cuatro rutas distintas de la letra B salían como cuatro
 * renglones con el texto idéntico "RUTA B", y el operador no tenía forma de saber
 * cuál era cuál. Agrupar por el nombre completo no pierde precisión, la gana: la hora
 * que el turno aplastaba ("ENTRADA 05:10" y "ENTRADA 06:35" eran los dos "TURNO DÍA")
 * ya viene dentro del nombre.
 *
 * LA PLACA NO ENTRA NUNCA. En 30 días de servicio pueden rotar cinco unidades por la
 * misma ruta, y el cliente contrató una ruta, no cinco. La versión anterior cortaba
 * por placa en cuanto detectaba un día con dos servicios, y ese único día partía el
 * mes entero en un renglón por unidad.
 */
export function agruparServicios(
  pares: ParServicio[],
  opts: OpcionesAgrupacion
): LineaAgrupada[] {
  const { catalogo, lado } = opts;

  type Bucket = {
    clave: string;
    ruta: string;
    fuenteRuta: FuenteEtiqueta;
    nombreIda: string | null;
    nombreRetorno: string | null;
    sentido: string;
    origen: string;
    precio: number;
    movil: number;
    moviles: number;
    filas: ParServicio[];
  };
  const buckets: Bucket[] = [];

  // Un bucket por RUTA CONTRATADA: ya no una por redacción del nombre. Ver
  // `agruparPorRutaContratada` — une por el nombre sin la hora O por los extremos en el
  // mapa, nunca cruzando tarifa ni origen contractual.
  for (const componente of agruparPorRutaContratada(pares, lado, {
    preciosIncluyenIgv: opts.preciosIncluyenIgv,
    igvPct: opts.igvPct,
    // El pax contratado separa ítems, igual que la tarifa: ver `agruparPorRutaContratada`.
    paxDe: (p) => catalogo.paxContratadoDe?.(p) ?? null,
  })) {
    const p = componente[0];
    const r = p.cabeza;
    const precio = precioUnitario(r, lado, {
      preciosIncluyenIgv: opts.preciosIncluyenIgv,
      igvPct: opts.igvPct,
    });
    // Los nombres salen de CADA TRAMO por su sentido, no de la cabeza: la cabeza es
    // el tramo que lleva el importe, y cuando la tarifa se cargó en el retorno la
    // línea terminaba rotulada con el nombre del retorno.
    //
    // Y salen de TODO el componente, no del primer par: el ítem reúne varias redacciones
    // de la misma ruta ('ENTRADA 06:30' y 'ENTRADA 06:35') y se imprime la más repetida.
    const nombreIda = nombreDominante(componente.map((x) => x.ida));
    const nombreRetorno = nombreDominante(componente.map((x) => x.retorno));
    const { etiqueta: ruta, fuente: fuenteRuta } = etiquetaRutaDetalle(p.ida ?? r);
    // El sentido del ítem lo da el componente entero: si algún día llevó los dos tramos,
    // la ruta contratada tiene ida y retorno aunque un día concreto se cayera.
    const sentido = componente.some((x) => x.ida) && componente.some((x) => x.retorno)
      ? "IDA Y RETORNO"
      : (p.sentido ?? (p.adjuntas.length ? "IDA Y RETORNO" : sentidoDeReserva(r)));
    // El ORIGEN entra en la clave. Sin él, una salida adicional de la RUTA A cobrada a
    // la misma tarifa del contrato se sumaba a la línea del contrato y dejaba de
    // existir como concepto: el cliente leía "23 servicios" donde había 22 contratados
    // y 1 pedido aparte, y el subtotal de adicionales del formato salía en cero.
    const origen = origenDelPar(p);
    // La clave conserva la forma de siempre —nombres, tarifa, origen— porque es lo que se
    // guarda en `agrupacion_clave` y lo que lee el editor. Lo que cambió es de dónde salen
    // los nombres: ahora son los del ítem entero, no los de una de sus redacciones.
    //
    // CADA COMPONENTE ES UN BUCKET, sin fusionar por clave. Antes esto era un Map y el
    // bucket se buscaba por su clave antes de crearlo, lo que DESHACÍA en silencio lo que
    // la unión había separado: dos ítems con el mismo nombre dominante y la misma tarifa
    // que `agruparPorRutaContratada` había dejado aparte —porque su PAX contratado no
    // coincidía— volvían a caer juntos al fusionarse por clave. Salió en producción: tres
    // adicionales de la RUTA C, uno contratado por 4 asientos y dos por 10, reunidos en un
    // renglón que solo puede imprimir un número. La unión ya decidió qué va junto; volver a
    // agrupar aquí solo puede estropearlo.
    const clave = [norm(nombreIda ?? ""), norm(nombreRetorno ?? ""), precio.toFixed(2), origen].join("|");
    buckets.push({ clave, ruta, fuenteRuta, nombreIda, nombreRetorno, sentido, origen, precio, movil: 1, moviles: 1, filas: [...componente] });
  }

  // Dos ítems distintos pueden llegar a la misma clave —mismo nombre dominante, misma
  // tarifa y mismo origen, separados por el PAX contratado—, y `agrupacion_clave` se guarda
  // en la base y se usa para reencontrar la línea. Se desempata con el dato que los separa,
  // y SOLO cuando de verdad chocan: así la clave de siempre no cambia de forma en el 99 %
  // de los casos, que es lo que leen los documentos ya emitidos.
  {
    const cuantos = new Map<string, number>();
    for (const b of buckets) cuantos.set(b.clave, (cuantos.get(b.clave) ?? 0) + 1);
    for (const b of buckets) {
      if ((cuantos.get(b.clave) ?? 0) < 2) continue;
      const pax = catalogo.paxContratadoDe?.(b.filas[0]) ?? null;
      b.clave = `${b.clave}|PAX${pax ?? "?"}`;
    }
  }

  // ── Móviles: solo cuando la ruta necesita DOS UNIDADES A LA MISMA HORA ──────
  //
  // La simultaneidad se mide por (fecha, HORA), no por fecha: dos vueltas del mismo
  // bus el mismo día —una de mañana y otra de tarde— no son dos móviles, y medirlo
  // solo por fecha las contaba como tales.
  //
  // El reparto es por POSICIÓN dentro de cada salida, no por placa: "móvil 1" es el
  // mismo puesto todos los días, lo cubra la unidad que lo cubra. Así una ruta de un
  // solo bus con cinco placas rotando queda en UN renglón, y una ruta que de verdad
  // sale con dos buses a las 05:10 queda en dos, que es como el cliente ya la firma.
  const finales: Bucket[] = [];
  for (const b of buckets) {
    const porSalida = new Map<string, ParServicio[]>();
    for (const p of b.filas) {
      const k = `${p.cabeza.fecha_servicio ?? ""}|${String(p.cabeza.hora_servicio ?? "").slice(0, 5)}`;
      (porSalida.get(k) ?? porSalida.set(k, []).get(k)!).push(p);
    }
    const moviles = Math.max(1, ...[...porSalida.values()].map((v) => v.length));
    if (moviles === 1) {
      finales.push(b);
      continue;
    }
    const porPosicion = new Map<number, ParServicio[]>();
    for (const salida of porSalida.values()) {
      // La unidad más grande es el móvil 1, como en los formatos que AFA ya emite.
      // El id desempata para que la numeración no baile entre recargas.
      const orden = [...salida].sort(
        (x, y) =>
          Number(catalogo.capacidadDe(y.cabeza) ?? 0) - Number(catalogo.capacidadDe(x.cabeza) ?? 0) ||
          x.cabeza.id - y.cabeza.id
      );
      orden.forEach((p, i) => {
        const pos = i + 1;
        (porPosicion.get(pos) ?? porPosicion.set(pos, []).get(pos)!).push(p);
      });
    }
    for (const [pos, filas] of [...porPosicion].sort((x, y) => x[0] - y[0]))
      finales.push({ ...b, clave: `${b.clave}|M${pos}`, filas, movil: pos, moviles });
  }

  const lineas: LineaAgrupada[] = [];
  const ordenados = [...finales].sort(
    (a, b) =>
      // Primero lo contratado y al final lo pedido aparte, como en el formato: los
      // adicionales se leen contra el bloque de servicios, no mezclados entre ellos.
      Number(a.origen !== "contrato") - Number(b.origen !== "contrato") ||
      String(a.nombreIda ?? a.ruta).localeCompare(String(b.nombreIda ?? b.ruta)) ||
      String(a.nombreRetorno ?? "").localeCompare(String(b.nombreRetorno ?? "")) ||
      a.precio - b.precio ||
      a.movil - b.movil
  );

  ordenados.forEach((b, idx) => {
    const ejecutados = b.filas.filter((p) => p.ejecutado);
    // Todas las reservas del bucket (cabezas + tramos incluidos): de aquí salen las
    // placas, los pasajeros y el detalle del Anexo 1.
    const todas = b.filas.flatMap((p) => [p.cabeza, ...p.adjuntas]);

    // El "N PAX" del formato es el personal que el cliente CONTRATÓ, y sale de la
    // cascada de `paxContratadoDe`. Antes salía del máximo embarcado o, si no había
    // manifiestos, de la capacidad del bus asignado: con una ruta contratada para 15,
    // mandar un bus de 20 hacía que el formato declarara 20 PAX. Si ninguna fuente lo
    // sabe queda en null y la descripción sale sin ese dato — nunca inventado.
    const pax = catalogo.paxContratadoDe?.(b.filas[0]) ?? null;
    // La capacidad asignada NO se imprime: solo sirve para avisar cuando se mandó una
    // unidad más chica que lo contratado.
    const capacidades = todas.map((r) => Number(catalogo.capacidadDe(r) ?? 0)).filter((n) => n > 0);
    const capacidadMinima = capacidades.length ? Math.min(...capacidades) : null;
    const placas = [...new Set(todas.map((r) => catalogo.placaDe(r)).filter(Boolean))];
    const serie = serieAnexo(idx + 1);
    const cantidad = ejecutados.length;

    lineas.push({
      clave: b.clave,
      tipo: b.origen === "contrato" ? "servicio" : "adicional",
      origen_contractual: b.origen,
      descripcion: descripcionLinea({
        concepto: opts.concepto,
        sede: opts.sede ?? catalogo.sedeNombre ?? null,
        pax,
        desde: opts.desde ?? null,
        hasta: opts.hasta ?? null,
        nombreIda: b.nombreIda,
        nombreRetorno: b.nombreRetorno,
        movil: b.movil,
        totalMoviles: b.moviles,
        origen: b.origen,
      }),
      unidad_medida: "SERV.",
      cantidad_programada: b.filas.length,
      cantidad_ejecutada: ejecutados.length,
      cantidad,
      precio_unitario: b.precio,
      total_linea: redondear(cantidad * b.precio),
      // Al puente van los tramos REALMENTE PRESTADOS del servicio: los dos del día
      // normal (los dos quedan liquidados y los dos se ven en el Anexo 1, el segundo
      // con importe incluido), y solo uno cuando el otro se canceló. Marcar como
      // liquidado un tramo que no se prestó ensuciaría el ciclo del servicio.
      reservas: ejecutados.flatMap((p) =>
        p.ejecutados?.length ? p.ejecutados.map((t) => t.id) : [p.cabeza.id, ...p.adjuntas.map((a) => a.id)]
      ),
      // Uno por servicio, y tiene que ser un id que SÍ esté en `reservas`: al crear la
      // liquidación se cuentan los que se lograron reclamar, y un id ausente restaría.
      servicios: ejecutados.map((p) => (p.ejecutados?.[0] ?? p.cabeza).id),
      reservas_periodo: todas.map((r) => r.id),
      ruta: b.ruta,
      fuente_ruta: b.fuenteRuta,
      nombre_ida: b.nombreIda,
      nombre_retorno: b.nombreRetorno,
      sentido: b.sentido,
      movil: b.movil,
      moviles: b.moviles,
      placas,
      pax_contratado: pax,
      capacidad_minima_asignada: capacidadMinima,
      referencia: cantidad
        ? `${serie}-01 a ${serie}-${String(cantidad).padStart(2, "0")}`
        : "—",
    });
  });

  // ── La regla dura, comprobada antes de devolver ───────────────────────────
  //
  // "Dos ítems con precio unitario distinto NO se unen jamás." Está garantizado por
  // construcción —la tarifa es el cubo dentro del cual se une, ver
  // `agruparPorRutaContratada`— pero se verifica igual, y ruidosamente. Un ítem que
  // mezclara tarifas se imprimiría como CANT × P. UNITARIO con un unitario que nadie
  // pactó, y el error viajaría hasta la factura sin que nada lo detenga. Prefiero que
  // el cierre se caiga aquí, donde todavía se puede arreglar.
  for (const b of ordenados) {
    const tarifas = new Set(
      b.filas.map((p) =>
        precioUnitario(p.cabeza, lado, {
          preciosIncluyenIgv: opts.preciosIncluyenIgv,
          igvPct: opts.igvPct,
        }).toFixed(2)
      )
    );
    if (tarifas.size > 1)
      throw new Error(
        `Agrupación inválida: el ítem "${b.nombreIda ?? b.ruta}" reuniría ${tarifas.size} tarifas ` +
        `distintas (${[...tarifas].join(", ")}). Dos servicios a distinto precio unitario nunca ` +
        `pueden compartir ítem. Es un fallo del ERP: repórtalo en vez de emitir el documento.`
      );

    // Y lo mismo con los asientos contratados. El formato imprime UN "N PAX" por ítem: si
    // el renglón reuniera servicios contratados a 4 y a 10, ese número sería falso para
    // unos u otros, y el cliente lo compara contra su contrato.
    const paxes = new Set(b.filas.map((p) => catalogo.paxContratadoDe?.(p) ?? null));
    if (paxes.size > 1)
      throw new Error(
        `Agrupación inválida: el ítem "${b.nombreIda ?? b.ruta}" reuniría ${paxes.size} capacidades ` +
        `contratadas distintas (${[...paxes].map((n) => n ?? "sin dato").join(", ")}). El formato ` +
        `imprime un solo "N PAX" por ítem. Es un fallo del ERP: repórtalo en vez de emitir el documento.`
      );
  }

  return lineas;
}

/**
 * La descripción del ítem. TODO lo que aparece aquí es un dato que alguien escribió:
 *
 *     TRANSPORTE DE PERSONAL CD CALLAO · 15 PAX · DEL 01-08-2026 AL 31-08-2026
 *     IDA · RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF PUNTA HERMOSA
 *     RETORNO · RUTA A/ RETORNO 17:00/ BSF PUNTA HERMOSA→SANTA ANITA (incluido en la misma tarifa)
 *     MÓVIL 1 DE 2
 *
 * Los dos nombres se imprimen aunque la tarifa vaya en uno solo: es la única forma de
 * que se vea a simple vista cuando la ida dice RUTA A y el retorno dice RUTA B, que
 * antes hacía que la línea entera se rotulara con la ruta equivocada.
 *
 * Se separa con saltos de línea, no con " / ": el nombre de ruta ya trae barras dentro
 * ("RUTA A/ ENTRADA 06:35/ …") y encadenarlo con más barras lo vuelve ilegible. El PDF
 * y el editor renderizan estos saltos (`white-space: pre-line`).
 */
export function descripcionLinea(p: {
  concepto?: string;
  sede?: string | null;
  pax?: number | null;
  desde?: string | null;
  hasta?: string | null;
  nombreIda?: string | null;
  nombreRetorno?: string | null;
  movil?: number;
  totalMoviles?: number;
  /** contrato | adicional | contingencia. Solo lo distinto del contrato se rotula. */
  origen?: string | null;
}): string {
  // El rótulo va ADELANTE del concepto y en la primera línea. El formato ya pinta la
  // fila de otro color y la suma aparte, pero eso se pierde en cuanto alguien copia la
  // descripción a un correo o a la orden de compra del cliente — que es exactamente lo
  // que pasa con un adicional, porque es el ítem que el cliente pregunta.
  const rotuloOrigen = p.origen && p.origen !== "contrato" ? `SERVICIO ${norm(p.origen)}` : null;
  const cabecera = [
    rotuloOrigen,
    `${p.concepto || "TRANSPORTE DE PERSONAL"}${p.sede ? " " + norm(p.sede) : ""}`,
    // Sin capacidad contratada NO se escribe nada: ver `paxContratadoDe`.
    p.pax ? `${p.pax} PAX` : null,
    p.desde && p.hasta ? `DEL ${fechaFormato(p.desde)} AL ${fechaFormato(p.hasta)}` : null,
  ].filter(Boolean).join(" · ");

  const filas = [cabecera];
  if (p.nombreIda) filas.push(`IDA · ${p.nombreIda}`);
  if (p.nombreRetorno)
    filas.push(`RETORNO · ${p.nombreRetorno}${p.nombreIda ? " (incluido en la misma tarifa)" : ""}`);
  // "MÓVIL 1 DE 2" solo cuando la ruta de verdad sale con más de una unidad a la vez.
  if ((p.totalMoviles ?? 1) > 1 && p.movil) filas.push(`MÓVIL ${p.movil} DE ${p.totalMoviles}`);
  return filas.join("\n");
}

// ── Totales de la valorización ──────────────────────────────────────────────

export type LineaMonto = {
  tipo: "servicio" | "adicional" | "penalidad" | "descuento";
  cantidad: number;
  precio_unitario: number;
};

/** ± del importe de una línea según su tipo (las penalidades y descuentos restan). */
export function totalLinea(l: LineaMonto): number {
  const bruto = redondear(Number(l.cantidad ?? 0) * Number(l.precio_unitario ?? 0));
  return l.tipo === "penalidad" || l.tipo === "descuento" ? -bruto : bruto;
}

export type TotalesValorizacion = {
  servicios: number;
  adicionales: number;
  descuentos: number;   // positivo: lo que se resta
  subtotal: number;     // neto sin IGV
  igv: number;
  total: number;
};

export function totalesValorizacion(lineas: LineaMonto[], igvPct: number): TotalesValorizacion {
  let servicios = 0, adicionales = 0, descuentos = 0;
  for (const l of lineas) {
    const m = totalLinea(l);
    if (l.tipo === "servicio") servicios += m;
    else if (l.tipo === "adicional") adicionales += m;
    else descuentos += Math.abs(m);
  }
  const subtotal = redondear(servicios + adicionales - descuentos);
  const igv = redondear(subtotal * (igvPct / 100));
  return {
    servicios: redondear(servicios),
    adicionales: redondear(adicionales),
    descuentos: redondear(descuentos),
    subtotal,
    igv,
    total: redondear(subtotal + igv),
  };
}
