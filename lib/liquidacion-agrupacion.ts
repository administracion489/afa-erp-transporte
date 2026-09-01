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
};

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
   * false = estaba programado pero no se prestó. Suma a la cantidad PROGRAMADA del
   * formato y no a la cobrada: así el cliente lee "26 / 25" y ve qué pasó, en vez de
   * un "25 / 25" que esconde el servicio caído.
   */
  ejecutado: boolean;
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

/** Importe de una reserva según el lado que se esté liquidando. */
function montoDe(r: ReservaLiq, lado: LadoLiquidacion): number {
  return Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
}

/** ¿Están enlazadas como ida/retorno del mismo servicio? */
function sonPar(a: ReservaLiq, b: ReservaLiq): boolean {
  return a.reserva_vinculada_id === b.id || b.reserva_vinculada_id === a.id;
}

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

export type AnalisisServicios = {
  /** Servicios facturables listos para valorizar. */
  pares: ParServicio[];
  /** Lo que no puede liquidarse todavía, con el motivo para mostrarlo en rojo. */
  bloqueadas: { r: ReservaLiq; motivos: string[] }[];
  /** Tramos incluidos que no se ejecutaron: no bloquean, pero hay que verlos. */
  avisos: { r: ReservaLiq; mensaje: string }[];
};

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
export function analizarServicios(reservas: ReservaLiq[], lado: LadoLiquidacion): AnalisisServicios {
  const porId = new Map<number, ReservaLiq>(reservas.map((r) => [r.id, r]));
  const usadas = new Set<number>();
  const res: AnalisisServicios = { pares: [], bloqueadas: [], avisos: [] };

  const hecho = (r: ReservaLiq) => r.estado === "finalizada";
  // "No finalizado" no es un bloqueo: es un servicio programado que no se prestó, y el
  // formato tiene que mostrarlo en la columna PROG./EJEC. El resto sí impide liquidar.
  const trabas = (r: ReservaLiq, cubiertaPor?: ReservaLiq | null) =>
    bloqueosDe(r, lado, cubiertaPor).filter((b) => b.codigo !== "no_finalizada").map((b) => b.mensaje);
  const bloquear = (r: ReservaLiq, motivos: string[]) => {
    if (motivos.length) res.bloqueadas.push({ r, motivos });
  };

  for (const r of reservas) {
    if (usadas.has(r.id)) continue;

    // El par solo cuenta si está en el mismo conjunto (mismo cliente y periodo).
    const posible = r.reserva_vinculada_id ? porId.get(r.reserva_vinculada_id) : undefined;
    const par = posible && !usadas.has(posible.id) && sonPar(r, posible) ? posible : null;

    if (!par) {
      usadas.add(r.id);
      // Sin precio y con un par que quedó fuera del periodo (típico del servicio
      // nocturno que retorna al día siguiente): decirlo explícitamente, porque
      // "sin precio de venta" mandaría a buscar un dato que no falta.
      if (montoDe(r, lado) <= 0 && r.reserva_vinculada_id) {
        bloquear(r, [`Su tarifa va en el servicio #${r.reserva_vinculada_id}, que no está en este periodo`]);
        continue;
      }
      const motivos = trabas(r);
      if (motivos.length) bloquear(r, motivos);
      else res.pares.push({ cabeza: r, adjuntas: [], ejecutado: hecho(r), sentido: sentidoDeReserva(r), ...tramosDelPar(r) });
      continue;
    }

    usadas.add(r.id);
    usadas.add(par.id);
    const mA = montoDe(r, lado);
    const mB = montoDe(par, lado);

    // Los dos cobran: dos servicios facturables distintos que además viajan juntos.
    if (mA > 0 && mB > 0) {
      for (const x of [r, par]) {
        const motivos = trabas(x);
        if (motivos.length) bloquear(x, motivos);
        else res.pares.push({ cabeza: x, adjuntas: [], ejecutado: hecho(x), sentido: sentidoDeReserva(x), ...tramosDelPar(x) });
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
      bloquear(adjunta, [`Va con el servicio ${cabeza.codigo ?? "#" + cabeza.id}, que está bloqueado`]);
      continue;
    }

    const motivosAdjunta = trabas(adjunta, cabeza);
    if (motivosAdjunta.length) {
      // El tramo incluido tiene su propio problema (p. ej. ya entró en otra
      // liquidación): la tarifa se cobra igual, pero queda el aviso.
      res.avisos.push({
        r: adjunta,
        mensaje: `${adjunta.direccion_servicio === "retorno" ? "Retorno" : "Tramo"} del ${adjunta.fecha_servicio ?? ""}: ${motivosAdjunta.join(" · ")}`,
      });
      res.pares.push({ cabeza, adjuntas: [], ejecutado: hecho(cabeza), sentido: "IDA Y RETORNO", ...tramosDelPar(cabeza, adjunta) });
      continue;
    }

    // Solo van al puente los tramos realmente prestados: marcar como liquidado algo
    // que no se ejecutó ensuciaría el ciclo del servicio.
    if (!hecho(adjunta) && hecho(cabeza)) {
      res.avisos.push({
        r: adjunta,
        mensaje: `El retorno del ${adjunta.fecha_servicio ?? ""} no se ejecutó, pero la tarifa del día se cobra completa`,
      });
      res.pares.push({ cabeza, adjuntas: [], ejecutado: true, sentido: "IDA Y RETORNO", ...tramosDelPar(cabeza, adjunta) });
      continue;
    }

    res.pares.push({
      cabeza,
      adjuntas: hecho(adjunta) ? [adjunta] : [],
      ejecutado: hecho(cabeza),
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
  tipo: "servicio";
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
    const clave = [norm(nombreIda ?? ""), norm(nombreRetorno ?? ""), precio.toFixed(2)].join("|");
    const b = buckets.get(clave)
      ?? { clave, ruta, fuenteRuta, nombreIda, nombreRetorno, sentido, precio, movil: 1, moviles: 1, filas: [] };
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
      tipo: "servicio",
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
      }),
      unidad_medida: "SERV.",
      cantidad_programada: b.filas.length,
      cantidad_ejecutada: ejecutados.length,
      cantidad,
      precio_unitario: b.precio,
      total_linea: redondear(cantidad * b.precio),
      // Al puente van AMBOS tramos del servicio prestado: los dos quedan liquidados y
      // los dos se ven en el Anexo 1 (el retorno, con importe incluido).
      reservas: ejecutados.flatMap((p) => [p.cabeza.id, ...p.adjuntas.map((a) => a.id)]),
      servicios: ejecutados.map((p) => p.cabeza.id),
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
}): string {
  const cabecera = [
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
