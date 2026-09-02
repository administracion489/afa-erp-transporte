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
    enElConjunto: (x: ReservaLiq) => boolean;
  }
): Bloqueo | null {
  const { lado, plata, laPlata, ref, ocupado, fuera, probable, enElConjunto } = ctx;
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
  const buckets = new Map<string, Bucket>();

  for (const p of pares) {
    const r = p.cabeza;
    const precio = precioUnitario(r, lado, {
      preciosIncluyenIgv: opts.preciosIncluyenIgv,
      igvPct: opts.igvPct,
    });
    // Los nombres salen de CADA TRAMO por su sentido, no de la cabeza: la cabeza es
    // el tramo que lleva el importe, y cuando la tarifa se cargó en el retorno la
    // línea terminaba rotulada con el nombre del retorno.
    const nombreIda = p.ida ? nombreRuta(p.ida) : null;
    const nombreRetorno = p.retorno ? nombreRuta(p.retorno) : null;
    const { etiqueta: ruta, fuente: fuenteRuta } = etiquetaRutaDetalle(p.ida ?? r);
    const sentido = p.sentido ?? (p.adjuntas.length ? "IDA Y RETORNO" : sentidoDeReserva(r));
    // El ORIGEN entra en la clave. Sin él, una salida adicional de la RUTA A cobrada a
    // la misma tarifa del contrato se sumaba a la línea del contrato y dejaba de
    // existir como concepto: el cliente leía "23 servicios" donde había 22 contratados
    // y 1 pedido aparte, y el subtotal de adicionales del formato salía en cero.
    const origen = origenDelPar(p);
    const clave = [norm(nombreIda ?? ""), norm(nombreRetorno ?? ""), precio.toFixed(2), origen].join("|");
    const b = buckets.get(clave)
      ?? { clave, ruta, fuenteRuta, nombreIda, nombreRetorno, sentido, origen, precio, movil: 1, moviles: 1, filas: [] };
    b.filas.push(p);
    buckets.set(clave, b);
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
  for (const b of buckets.values()) {
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
