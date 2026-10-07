// ──────────────────────────────────────────────────────────────────────────────
// lib/paradas-materializar.ts — Motor PURO: cómo un `paradas_json` se vuelve filas de `paradas`,
// y qué servicios de HOY hay que materializar antes de que alguien los abra.
//
// EL CASO (06-10): los pasajeros rotan y eligen su servicio en «Elige tu ruta de hoy», que solo
// ofrece servicios CON filas en `paradas` (ofrecibleEnAutoseleccion). Un programa fijo nace con
// la semilla `paradas_json` y sus filas se crean recién cuando alguien abre el servicio en
// Programación, abre el Manifiesto o el conductor pulsa «Iniciar». Un servicio que nadie abrió
// no se le ofrecía al pasajero.
//
// LA DECISIÓN (del dueño): se materializa AL EMPEZAR SU DÍA, no al generar el programa.
// Materializar meses de servicios de una vez arrastra efectos que hoy solo existen en los pocos
// servicios que alguien abre (lecturas sin paginar, Propagar borrando filas con pasajeros, miles
// de eventos de realtime). El cron `/api/paradas/materializar` hace, cada 10 minutos, lo mismo
// que haría alguien abriendo cada servicio de hoy.
//
// LAS REGLAS SON LAS DEL «INICIAR», EXTRAÍDAS, NO REESCRITAS: `semillaDeServicio` es la cascada
// de resolverParadasJSON (app/programacion) y de app/api/conductor-paradas, `ordenarTramo` su
// sortLeg y `filasDeSemilla` su mapeo. La matriz los compara contra los originales copiados
// literal. Una sola excepción, y es del dueño:
//
// UN RETORNO NO SE DEDUCE DE LA IDA. Si la cotización no tiene `paradas_retorno_json`, el
// generador le pone al retorno la lista de la ida (sin invertir, con las horas de la mañana).
// «No se puede suponer que el retorno y la ida comparten paraderos y ubicaciones: Puente Santa
// Anita hacia el norte es otro paradero que hacia el sur, hay un muro entre las pistas. Lo mismo
// con la hora.» Por eso el cron solo materializa un retorno de cotización cuando PRUEBA que sus
// paraderos son de retorno (`estadoRetorno`): la cotización tiene lista de retorno y la semilla
// del servicio es esa lista (o está vacía y la cascada la toma). Si no, no hay paraderos válidos
// que ofrecer, y creados así el semáforo mediría la salida desde el primer paradero de la ida con
// el bus esperando en la planta. Se arregla dándole a la cotización su lista de retorno y
// propagándola.
// ──────────────────────────────────────────────────────────────────────────────

/** Un paradero tal como viaja en `paradas_json` (cotización o reserva). */
export type ParadaSemilla = {
  tipo?: string | null;
  nombre?: string | null;
  direccion?: string | null;
  lat?: string | number | null;
  lng?: string | number | null;
  hora?: string | null;
  [k: string]: unknown;
};

/** Una fila nueva de `paradas`, con las mismas columnas que escriben el «Iniciar» y Programación. */
export type FilaParada = {
  reserva_id: number;
  orden: number;
  nombre: string | null | undefined;
  direccion: string | null;
  lat: number | null;
  lng: number | null;
  hora_estimada: string | null;
  estado: "pendiente";
};

/** Lo que el motor necesita de una reserva. */
export type ServicioSemilla = {
  id: number;
  fecha_servicio?: string | null;
  estado?: string | null;
  cliente_id?: number | null;
  permite_autoseleccion?: boolean | null;
  cotizacion_id?: number | null;
  direccion_servicio?: string | null;
  paradas_json?: unknown;
};

/** Lo que el motor necesita de una cotización. */
export type CotizacionSemilla = {
  id?: number;
  paradas_json?: unknown;
  paradas_retorno_json?: unknown;
};

/** Ordena un `paradas_json` como resolverParadasJSON: inicio → intermedia → destino → el resto. */
export function ordenarTramo<T extends { tipo?: string | null }>(arr: T[]): T[] {
  return [
    ...arr.filter((p) => p.tipo === "inicio"),
    ...arr.filter((p) => p.tipo === "intermedia"),
    ...arr.filter((p) => p.tipo === "destino"),
    ...arr.filter((p) => !["inicio", "intermedia", "destino"].includes(String(p.tipo))),
  ];
}

const lista = (v: unknown): ParadaSemilla[] | null =>
  Array.isArray(v) ? (v as ParadaSemilla[]) : null;
const noVacia = (v: unknown): ParadaSemilla[] | null => {
  const l = lista(v);
  return l && l.length > 0 ? l : null;
};

export type FuenteSemilla = "reserva" | "cotizacion" | "ninguna";

/**
 * La semilla de un servicio, YA ORDENADA. La cascada de resolverParadasJSON y del «Iniciar»:
 * (1) el `paradas_json` propio de la reserva, (2) la cotización por sentido —el retorno toma
 * `paradas_retorno_json` y, si está vacío, `paradas_json`—, (3) nada.
 */
export function semillaDeServicio(
  r: Pick<ServicioSemilla, "paradas_json" | "direccion_servicio">,
  cot: CotizacionSemilla | null | undefined,
): { semilla: ParadaSemilla[]; fuente: FuenteSemilla } {
  const propia = noVacia(r.paradas_json);
  if (propia) return { semilla: ordenarTramo(propia), fuente: "reserva" };
  if (cot) {
    if (r.direccion_servicio === "retorno") {
      const ret = noVacia(cot.paradas_retorno_json) ?? lista(cot.paradas_json);
      if (ret) return { semilla: ordenarTramo(ret), fuente: ret.length ? "cotizacion" : "ninguna" };
    } else {
      const ida = lista(cot.paradas_json);
      if (ida) return { semilla: ordenarTramo(ida), fuente: ida.length ? "cotizacion" : "ninguna" };
    }
  }
  return { semilla: [], fuente: "ninguna" };
}

/** Las filas de `paradas` de una semilla ya ordenada: el mapeo del «Iniciar», campo por campo. */
export function filasDeSemilla(reservaId: number, semilla: ParadaSemilla[]): FilaParada[] {
  return semilla.map((p, i) => ({
    reserva_id: reservaId,
    orden: i + 1,
    nombre: p.nombre as string | null | undefined,
    direccion: (p.direccion as string) || null,
    lat: p.lat ? Number(p.lat) : null,
    lng: p.lng ? Number(p.lng) : null,
    hora_estimada: (p.hora as string) || null,
    estado: "pendiente",
  }));
}

/** ¿La cotización tiene su PROPIA lista de paraderos de retorno? */
export function tieneParaderosDeRetorno(cot: CotizacionSemilla | null | undefined): boolean {
  return !!noVacia(cot?.paradas_retorno_json);
}

const claveNombre = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** Firma por NOMBRES y en orden (sin coordenadas: en la semilla pueden venir vacías o como texto). */
export function firmaNombres(arr: ParadaSemilla[] | null | undefined): string {
  return ordenarTramo(arr ?? []).map((p) => claveNombre(p.nombre)).join(" › ");
}

export type EstadoRetorno =
  | "no_aplica"          // no es un retorno de una cotización
  | "sin_cotizacion"     // es de una cotización que no se pudo leer
  | "sin_lista"          // su cotización no tiene paraderos de retorno
  | "semilla_distinta"   // guarda una lista que NO es la de retorno de su cotización
  | "ok";                // sin semilla propia (toma la de retorno) o con la misma lista de retorno

/**
 * ¿Los paraderos que recibiría este retorno son DE RETORNO? Solo se afirma con evidencia: su
 * cotización tiene lista de retorno, y la semilla propia está vacía (la cascada toma esa lista) o
 * lleva los mismos nombres en el mismo orden. Cualquier otra semilla no se puede distinguir de la
 * ida: el generador le pone la de la ida cuando la cotización no tiene lista de retorno, y esa
 * semilla se queda ahí aunque después la ida se edite (Propagar no toca esos retornos) o la
 * cotización gane su lista sin propagarla. Comparar contra la ida ACTUAL no la reconoce en ninguno
 * de los dos casos; comparar contra la lista de retorno sí.
 */
export function estadoRetorno(
  r: Pick<ServicioSemilla, "paradas_json" | "direccion_servicio" | "cotizacion_id">,
  cot: CotizacionSemilla | null | undefined,
): EstadoRetorno {
  if (r.direccion_servicio !== "retorno" || r.cotizacion_id == null) return "no_aplica";
  if (!cot) return "sin_cotizacion";
  const ret = noVacia(cot.paradas_retorno_json);
  if (!ret) return "sin_lista";
  const propia = noVacia(r.paradas_json);
  if (propia && firmaNombres(propia) !== firmaNombres(ret)) return "semilla_distinta";
  return "ok";
}

// ── Qué servicios de hoy se materializan ─────────────────────────────────────

/** Los estados de un servicio de hoy que aún no empezó: los mismos que ofrece «Elige tu ruta de hoy». */
export const ESTADOS_SIN_INICIAR = ["pendiente", "programada", "confirmada"] as const;

/**
 * ¿Lo podría ofrecer «Elige tu ruta de hoy»? Mismo criterio que la rama «hoy» de
 * reservas_disponibles (app/api/pasajero): de hoy, sin iniciar, con la casilla encendida
 * (exige `true` explícito) y con cliente. Nada más se materializa: el resto de servicios sigue
 * creando sus paraderos cuando alguien los abre, como siempre.
 */
export function esCandidatoDeHoy(r: ServicioSemilla, hoy: string): boolean {
  return String(r.fecha_servicio ?? "").slice(0, 10) === hoy
    && (ESTADOS_SIN_INICIAR as readonly string[]).includes(String(r.estado ?? ""))
    && r.permite_autoseleccion === true
    && r.cliente_id != null;
}

export type CodigoMaterializar =
  | "crear"
  | "no_candidato"
  | "ya_tiene_paraderos"
  | "sin_semilla"
  | "semilla_sin_nombres"
  | "retorno_sin_lista"
  | "retorno_semilla_distinta"
  | "retorno_sin_cotizacion";

export const MOTIVO_MATERIALIZAR: Record<CodigoMaterializar, string> = {
  crear: "se crean sus paraderos desde su semilla",
  no_candidato: "no es un servicio de hoy que se ofrezca al pasajero",
  ya_tiene_paraderos: "ya tiene sus paraderos",
  sin_semilla: "no tiene paraderos en su semilla ni en su cotización (se crean al abrirlo)",
  semilla_sin_nombres: "su semilla tiene paraderos sin nombre (p. ej. el formato del Cotizador): no se ofrecen al pasajero",
  retorno_sin_lista: "es un retorno y su cotización no tiene paraderos de retorno: no se deducen de la ida",
  retorno_semilla_distinta: "es un retorno y guarda una lista que no es la de retorno de su cotización (la de la ida, o una vieja): falta propagar",
  retorno_sin_cotizacion: "es un retorno y no se encontró su cotización: no se puede comprobar que sus paraderos sean del retorno",
};

export type PlanServicio = {
  reserva_id: number;
  codigo: CodigoMaterializar;
  cotizacion_id: number | null;
  fuente: FuenteSemilla;
  filas: FilaParada[];
};

/**
 * El plan de UN servicio. `conParaderos` dice si ya tiene filas; `cot` es su cotización
 * (null/undefined = no tiene, o no se encontró).
 * Invariante: solo `crear` trae filas, y nunca para un servicio con paraderos.
 */
export function planDeServicio(
  r: ServicioSemilla,
  hoy: string,
  conParaderos: boolean,
  cot: CotizacionSemilla | null | undefined,
): PlanServicio {
  const base = { reserva_id: r.id, cotizacion_id: r.cotizacion_id ?? null };
  const no = (codigo: CodigoMaterializar, fuente: FuenteSemilla = "ninguna"): PlanServicio =>
    ({ ...base, codigo, fuente, filas: [] });
  if (!esCandidatoDeHoy(r, hoy)) return no("no_candidato");
  if (conParaderos) return no("ya_tiene_paraderos");
  // Un retorno de cotización solo se materializa si se PRUEBA que sus paraderos son de retorno.
  const ret = estadoRetorno(r, cot);
  if (ret === "sin_cotizacion") return no("retorno_sin_cotizacion");
  if (ret === "sin_lista") return no("retorno_sin_lista");
  if (ret === "semilla_distinta") return no("retorno_semilla_distinta");
  const { semilla, fuente } = semillaDeServicio(r, cot);
  if (!semilla.length) return no("sin_semilla");
  if (!semillaConNombres(semilla)) return no("semilla_sin_nombres", fuente);
  return { ...base, codigo: "crear", fuente, filas: filasDeSemilla(r.id, semilla) };
}

/**
 * Después de insertar: si el servicio terminó con filas que NO son las nuestras, otro camino
 * (alguien abrió el servicio, el «Iniciar») las creó a la vez. No hay índice único en `paradas`,
 * así que se quitan las NUESTRAS: las otras pudieron recibir ya un pasajero. Devuelve los ids a
 * borrar; nunca uno que no hayamos insertado.
 */
export function sobrantesTrasCarrera(insertadas: number[], actuales: number[]): number[] {
  const nuestras = new Set(insertadas);
  const ajenas = actuales.filter((id) => !nuestras.has(id));
  return ajenas.length > 0 ? actuales.filter((id) => nuestras.has(id)) : [];
}

/**
 * ¿Todos los paraderos tienen nombre? El Cotizador guarda sus puntos como `{tipo:"parada", texto,
 * place}`, sin `nombre`; copiada tal cual a un servicio, esa semilla da filas sin nombre que el
 * pasajero vería como «—» y que no se pueden geocodificar. El «Iniciar» las crearía igual; el cron,
 * que nadie mira, no.
 */
export function semillaConNombres(semilla: ParadaSemilla[]): boolean {
  return semilla.every((p) => typeof p.nombre === "string" && p.nombre.trim() !== "");
}

/** ¿A esta fila le faltan coordenadas? (`!lat || !lng`, la misma prueba del «Iniciar»). */
export function faltanCoordenadas(f: { lat?: number | string | null; lng?: number | string | null }): boolean {
  return !f.lat || !f.lng;
}

// ── Lo que se le dice al operador ────────────────────────────────────────────
// Los textos viven aquí y no en cada pantalla: el chip de Programación, el generador y Propagar
// describen la MISMA regla, y compuestos en tres TSX terminan diciéndola de tres formas.

/**
 * Chip de Programación para un retorno que el cron NO materializa porque no puede probar que sus
 * paraderos sean de retorno. Se juzga con el MISMO `estadoRetorno` del cron: un chip con su propia
 * condición terminaría avisando donde el cron sí crea, o callando donde no crea. Null = nada que decir.
 */
export function avisoRetorno(
  estado: EstadoRetorno, numeroCotizacion: string | null,
): { chip: string; detalle: string } | null {
  const cot = numeroCotizacion ? `La cotización ${numeroCotizacion}` : "Su cotización";
  const cotMin = numeroCotizacion ? `la cotización ${numeroCotizacion}` : "su cotización";
  const regla = "El ERP no deduce los paraderos de un retorno de los de la ida —cada sentido puede tener " +
    "su paradero en otro lado de la pista, y su propia hora—, así que no le crea solo los paraderos a este " +
    "retorno: mientras no los tenga, sus pasajeros no lo verán en «Elige tu ruta de hoy».";
  if (estado === "sin_lista") return {
    chip: "SIN PARADEROS DE RETORNO",
    detalle: `${cot} no tiene paraderos de RETORNO. ${regla} Si alguien abre el servicio o el conductor ` +
      `lo inicia, recibe los de la ida. Agrega la lista de retorno en Cotizaciones (editar → Guardar → Propagar).`,
  };
  if (estado === "semilla_distinta") return {
    chip: "PARADEROS DE RETORNO SIN PROPAGAR",
    detalle: `Este retorno guarda una lista de paraderos que no es la de retorno de ${cotMin} (suele ser la ` +
      `de la ida, o una versión vieja). ${regla} Si alguien abre el servicio o el conductor lo inicia, recibe ` +
      `esa lista guardada. En Cotizaciones, abre la cotización, Guardar → Propagar.`,
  };
  return null;
}

/** Línea del generador cuando va a crear retornos de una cotización sin lista de retorno. */
export const AVISO_GENERADOR_SIN_RETORNO =
  "⚠ RETORNO: la cotización no tiene paraderos de retorno. El ERP no los deduce de la ida (cada sentido " +
  "puede tener su paradero en otro lado de la pista, y su propia hora): estos retornos no aparecerán en " +
  "«Elige tu ruta de hoy» hasta que la cotización tenga su lista de retorno.";

// ── «Propagar» de Cotizaciones: a qué servicios futuros se les rehacen los paraderos ──────────
// Propagar BORRA los paraderos de cada servicio y los vuelve a crear. Desde que los servicios de
// hoy nacen con paraderos de madrugada, un servicio de hoy puede tener ya pasajeros que eligieron
// su paradero: borrarle las filas los dejaría sin paradero (o, según la clave foránea, fallaría el
// borrado y el itinerario quedaría duplicado). Y un retorno sin lista propia recibía la de la ida.

export type MotivoNoPropaga =
  | "con_actividad"          // ya tiene paradas escaneadas: se está prestando
  | "con_pasajeros"          // tiene pasajeros asignados a sus paraderos
  | "retorno_sin_lista"      // la cotización no tiene paraderos de retorno: no se deducen de la ida
  | "ida_sin_lista";         // la cotización no tiene paraderos de ida: borrarle los suyos lo dejaría sin nada

export const MOTIVO_NO_PROPAGA: Record<MotivoNoPropaga, string> = {
  con_actividad: "ya tienen paradas escaneadas",
  con_pasajeros: "tienen pasajeros asignados (cámbialos desde el Manifiesto)",
  retorno_sin_lista: "son retornos y la cotización no tiene paraderos de retorno (no se deducen de la ida)",
  ida_sin_lista: "son idas y la cotización no tiene paraderos de ida",
};

export type PlanPropagacion = {
  ida: number[];
  retorno: number[];
  fuera: { id: number; motivo: MotivoNoPropaga }[];
};

/**
 * Qué servicios se tocan. `ida` + `retorno` + `fuera` son DISJUNTOS y cubren todos los
 * candidatos: un servicio que no sale en ninguno sería uno que la pantalla no explica.
 */
export function planDePropagacion(
  reservas: { id: number; direccion_servicio: string | null }[],
  listas: { ida: unknown[]; retorno: unknown[] },
  conActividad: ReadonlySet<number>,
  conPasajeros: ReadonlySet<number>,
): PlanPropagacion {
  const plan: PlanPropagacion = { ida: [], retorno: [], fuera: [] };
  for (const r of reservas) {
    const esRet = r.direccion_servicio === "retorno";
    if (conActividad.has(r.id)) plan.fuera.push({ id: r.id, motivo: "con_actividad" });
    else if (conPasajeros.has(r.id)) plan.fuera.push({ id: r.id, motivo: "con_pasajeros" });
    else if (esRet && listas.retorno.length === 0) plan.fuera.push({ id: r.id, motivo: "retorno_sin_lista" });
    else if (!esRet && listas.ida.length === 0) plan.fuera.push({ id: r.id, motivo: "ida_sin_lista" });
    else (esRet ? plan.retorno : plan.ida).push(r.id);
  }
  return plan;
}
