// lib/odometro-revision.ts
// La bandeja «Lecturas por revisar» de /mantenimiento → Odómetro: QUÉ le pasa a cada lectura y
// cómo se filtra. Módulo PURO: no lee la base.
//
// Con 37 lecturas en una sola lista ordenada por inserción, revisar la CTV-370 era hacer scroll
// buscando la placa a ojo, y no había forma de ver «todo lo que ya quedó listo para aceptar» ni
// «todos los dígitos de más» de un vistazo. Tres decisiones:
//
//   1. EL TIPO DE PROBLEMA SALE DEL MOTIVO QUE ESCRIBIÓ EL PROPIO ERP. `lecturas_odometro` no
//      tiene una columna con el código —el motivo es texto— y agregarla dejaría sin tipo las
//      filas que ya están en la bandeja. Los textos los compone `evaluarLectura` (lib/odometro.ts)
//      y la matriz los PRODUCE con ese mismo motor y exige que ninguno caiga en «otro»: si alguien
//      cambia una frase allá, la prueba falla aquí. Lo que no se reconoce va a «otro», nunca se
//      esconde.
//   2. CADA DESPLEGABLE SE CUENTA CON LOS OTROS FILTROS PUESTOS Y SIN EL SUYO, igual que el cruce
//      de /liquidaciones: contado con el suyo, el desplegable se quedaría con la opción elegida y
//      no habría forma de cambiarla sin quitar antes el filtro.
//   3. «Listas para aceptar» es un tipo propio: una lectura cuya hora se corrigió a mano y que con
//      esa hora ya cuadra solo espera el clic. Mezclarla con los retrocesos la escondería.

export type TipoRevision =
  | "lista_para_aceptar"
  | "corregida_sistema"
  | "digito_de_mas"
  | "fecha_futura"
  | "duplicada"
  | "incoherente_posterior"
  | "retroceso"
  | "salto_improbable"
  | "gps"
  | "otro";

export const TIPOS_REVISION: { codigo: TipoRevision; etiqueta: string; ayuda: string }[] = [
  { codigo: "lista_para_aceptar", etiqueta: "✅ Listas para aceptar", ayuda: "Ya cuadran: se les corrigió la hora, o el km que corrigió el sistema coincide con otra lectura" },
  { codigo: "corregida_sistema", etiqueta: "🤖 Corregida por el sistema", ayuda: "La IA leyó una cifra dos veces y el sistema la quitó: compara el km con la foto y acepta" },
  { codigo: "digito_de_mas", etiqueta: "🔢 Dígito de más", ayuda: "El km es ~10× el anterior: casi siempre una cifra repetida" },
  { codigo: "incoherente_posterior", etiqueta: "⏱ Más km que una lectura posterior", ayuda: "Suele ser la HORA: corrígela con la del voucher o la foto" },
  { codigo: "retroceso", etiqueta: "↩ Retrocede", ayuda: "Menos km que la lectura anterior" },
  { codigo: "salto_improbable", etiqueta: "⤴ Salto improbable", ayuda: "Más km de los que la unidad hace en ese tiempo" },
  { codigo: "duplicada", etiqueta: "🖼 Foto duplicada", ayuda: "La misma imagen ya se registró" },
  { codigo: "fecha_futura", etiqueta: "📅 Fecha futura", ayuda: "El reloj del dispositivo va adelantado" },
  { codigo: "gps", etiqueta: "🛰 No cuadra con el GPS", ayuda: "El odómetro del día es menor que lo que recorrió el GPS" },
  { codigo: "otro", etiqueta: "Otros", ayuda: "Motivo que la bandeja no clasifica: léelo en la fila" },
];

export function etiquetaTipo(t: TipoRevision): string {
  return TIPOS_REVISION.find((x) => x.codigo === t)?.etiqueta ?? t;
}

/**
 * Tipo de problema de una lectura por revisar, a partir del motivo que escribió el ERP. El orden
 * importa: un motivo puede juntar varias notas con « · » (la del reloj, la de la IA, la del GPS)
 * y gana la más accionable.
 */
export function tipoDeRevision(motivo: string | null | undefined): TipoRevision {
  const m = String(motivo ?? "");
  if (/con esa hora cuadra/i.test(m)) return "lista_para_aceptar";
  // El dígito repetido que el sistema colapsó (`elegirOdometro`, en el Radar se antepone
  // «Corregido por el sistema:»). Si el propio evaluarLectura dijo además que coincide con la
  // lectura anterior —«Sin avance» o «Confirmada»—, la única razón de que esté aquí es que nadie
  // la había confirmado: son las que quedaron antes de que un testigo bastara (`testigoDe`, lib/
  // odometro-seleccion.ts), y solo esperan el clic. Esas dos frases solo salen cuando la lectura
  // quedó ACEPTADA, así que no pueden tapar un retroceso ni una foto duplicada.
  const repetido = /d[ií]gito REPETIDO/i.test(m);
  if (repetido && /Sin avance:|Confirmada: coincide/.test(m) && !/GPS:/.test(m)) return "lista_para_aceptar";
  if (/Salto ×\d+/.test(m) || /d[ií]gito de m[aá]s/i.test(m)) return "digito_de_mas";
  if (/Fecha\/hora futura/i.test(m)) return "fecha_futura";
  if (/Duplicada/i.test(m)) return "duplicada";
  if (/que es posterior/i.test(m)) return "incoherente_posterior";
  if (/Retroce(de|so)/i.test(m)) return "retroceso";
  if (/Salto improbable/i.test(m)) return "salto_improbable";
  if (/GPS:/.test(m)) return "gps";
  // Al final: un dígito repetido que además retrocede o es la misma foto se clasifica por ESO,
  // que es lo que hay que arreglar; aquí solo quedan los que esperan que alguien mire la foto.
  if (repetido) return "corregida_sistema";
  return "otro";
}

export type OrdenRevision = "llegada" | "fecha_desc" | "fecha_asc" | "placa" | "km_desc";

export const ORDENES_REVISION: { codigo: OrdenRevision; etiqueta: string }[] = [
  { codigo: "llegada", etiqueta: "Recién llegadas" },
  { codigo: "fecha_desc", etiqueta: "Fecha de la lectura ↓" },
  { codigo: "fecha_asc", etiqueta: "Fecha de la lectura ↑" },
  { codigo: "placa", etiqueta: "Placa" },
  { codigo: "km_desc", etiqueta: "Km ↓" },
];

export type FiltroRevision = {
  placa: string;                       // texto libre: «ctv», «CTV-370», «ctv 370»
  desde: string;                       // YYYY-MM-DD o ""
  hasta: string;                       // YYYY-MM-DD o ""
  tipo: TipoRevision | "todos";
  fuente: string;                      // "todas" o el código de fuente
  flota: "todas" | "propia" | "tercero";
  soloConFoto: boolean;
  orden: OrdenRevision;
};

export const FILTRO_REVISION_VACIO: FiltroRevision = {
  placa: "", desde: "", hasta: "", tipo: "todos", fuente: "todas", flota: "todas", soloConFoto: false, orden: "llegada",
};

/** ¿Hay algún filtro que recorte? (el orden no recorta). */
export function hayFiltro(f: FiltroRevision): boolean {
  return !!f.placa.trim() || !!f.desde || !!f.hasta || f.tipo !== "todos" || f.fuente !== "todas" || f.flota !== "todas" || f.soloConFoto;
}

export type FilaRevision = {
  id: string;
  km: number;
  fecha: string;
  fuente: string;
  motivo?: string | null;
  foto_url?: string | null;
  created_at: string;
  vehiculo_tercero_id?: number | null;
  /** Instante efectivo de la lectura (lib/odometro-tiempo.ts), para ordenar por fecha. */
  ts: number;
  placa: string;
};

/** Placa comparable: sin guion ni espacios, en mayúsculas. */
export function placaComparable(p: string): string {
  return String(p ?? "").toUpperCase().replace(/[\s\-_.]/g, "");
}

type Eje = "placa" | "tipo" | "fuente" | "resto";

function pasa(f: FilaRevision, filtro: FiltroRevision, salvo: Eje | null): boolean {
  if (salvo !== "placa") {
    const q = placaComparable(filtro.placa);
    if (q && !placaComparable(f.placa).includes(q)) return false;
  }
  if (salvo !== "tipo" && filtro.tipo !== "todos" && tipoDeRevision(f.motivo) !== filtro.tipo) return false;
  if (salvo !== "fuente" && filtro.fuente !== "todas" && f.fuente !== filtro.fuente) return false;
  if (filtro.desde && f.fecha < filtro.desde) return false;
  if (filtro.hasta && f.fecha > filtro.hasta) return false;
  if (filtro.flota !== "todas") {
    const esTercero = f.vehiculo_tercero_id != null;
    if (filtro.flota === "tercero" ? !esTercero : esTercero) return false;
  }
  if (filtro.soloConFoto && !f.foto_url) return false;
  return true;
}

function ordenar<T extends FilaRevision>(filas: T[], orden: OrdenRevision): T[] {
  const tsLlegada = (f: FilaRevision) => new Date(f.created_at).getTime() || 0;
  const desempate = (a: FilaRevision, b: FilaRevision) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cmp: Record<OrdenRevision, (a: T, b: T) => number> = {
    llegada: (a, b) => tsLlegada(b) - tsLlegada(a) || desempate(a, b),
    fecha_desc: (a, b) => b.ts - a.ts || desempate(a, b),
    fecha_asc: (a, b) => a.ts - b.ts || desempate(a, b),
    placa: (a, b) => a.placa.localeCompare(b.placa) || a.ts - b.ts || desempate(a, b),
    km_desc: (a, b) => Number(b.km) - Number(a.km) || desempate(a, b),
  };
  return [...filas].sort(cmp[orden]);
}

export type ResultadoRevision<T> = {
  filas: T[];
  total: number;
  /** Conteo por tipo con los OTROS filtros puestos (sin el de tipo). */
  porTipo: Record<TipoRevision, number>;
  /** Conteo por fuente con los otros filtros puestos (sin el de fuente). */
  porFuente: Record<string, number>;
  /** Placas con lecturas por revisar, de más a menos, con los otros filtros (sin el de placa). */
  porPlaca: { placa: string; n: number }[];
};

export function filtrarRevision<T extends FilaRevision>(todas: T[], filtro: FiltroRevision): ResultadoRevision<T> {
  const porTipo = Object.fromEntries(TIPOS_REVISION.map((t) => [t.codigo, 0])) as Record<TipoRevision, number>;
  const porFuente: Record<string, number> = {};
  const placas = new Map<string, number>();
  const filas: T[] = [];
  for (const f of todas) {
    if (pasa(f, filtro, "tipo")) porTipo[tipoDeRevision(f.motivo)]++;
    if (pasa(f, filtro, "fuente")) porFuente[f.fuente] = (porFuente[f.fuente] ?? 0) + 1;
    if (pasa(f, filtro, "placa")) placas.set(f.placa, (placas.get(f.placa) ?? 0) + 1);
    if (pasa(f, filtro, null)) filas.push(f);
  }
  const porPlaca = [...placas.entries()]
    .map(([placa, n]) => ({ placa, n }))
    .sort((a, b) => b.n - a.n || a.placa.localeCompare(b.placa));
  return { filas: ordenar(filas, filtro.orden), total: todas.length, porTipo, porFuente, porPlaca };
}
