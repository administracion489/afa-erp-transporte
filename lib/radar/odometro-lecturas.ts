// lib/radar/odometro-lecturas.ts
// La tabla de /radar-ia → Odómetro: un filtro POR COLUMNA, y qué lectura está pendiente de una
// persona. Módulo PURO: no lee la base.
//
// Lo reportado por el dueño: «falta poder filtrar en cada columna, por ejemplo para filtrar las que
// están pendientes de revisar». La tabla era una lista plana de las 60 lecturas más recientes, con
// el motivo de cada una escondido detrás de un «ⓘ». Cuatro decisiones:
//
//   1. «PENDIENTE» SE DEFINE UNA VEZ (`esPendiente`): la pestaña lleva un contador, el chip
//      «Por revisar» otro y el filtro de estado un tercero. Si cada uno decidiera por su cuenta qué
//      cuenta como pendiente, la pestaña diría 5 y el chip 3. Pendiente = lo que espera a una
//      persona: `sospechosa` (aceptar o corregir) y `rechazada` (corregir).
//   2. EL PROBLEMA SE CLASIFICA CON `tipoDeRevision` (lib/odometro-revision.ts), el MISMO de la
//      bandeja de /mantenimiento → Odómetro. Dos clasificadores del mismo motivo terminan llamando
//      «retroceso» en una pantalla a lo que la otra llama «dígito de más».
//   3. CADA DESPLEGABLE SE CUENTA CON LOS OTROS FILTROS PUESTOS Y SIN EL SUYO, igual que el cruce de
//      /liquidaciones y la bandeja de /mantenimiento: contado con el suyo, el desplegable se quedaría
//      con la opción elegida y no habría forma de cambiarla sin limpiar antes.
//   4. UN FILTRO QUE NO SE PUEDE CUMPLIR SE DICE, NO DEVUELVE CERO EN SILENCIO (`avisos`): un «desde»
//      posterior al «hasta», o un km mínimo mayor que el máximo, dejan la tabla vacía, y una tabla
//      vacía se lee como «no hay lecturas».
//
// «Auto» en el estado: con lecturas pendientes la pestaña abre en ellas (es el trabajo); sin
// ninguna, en todas — la misma convención que la pestaña Combustible del Radar. Una vez que la
// persona elige, manda su elección.

import { TIPOS_REVISION, placaComparable, tipoDeRevision, type TipoRevision } from "@/lib/odometro-revision";

export type EstadoLecturaRadar = "aceptada" | "sospechosa" | "rechazada" | "reinicio" | "anulada";

export const ESTADOS_LECTURA: { codigo: EstadoLecturaRadar; etiqueta: string }[] = [
  { codigo: "sospechosa", etiqueta: "Por revisar" },
  { codigo: "rechazada", etiqueta: "Rechazada" },
  { codigo: "aceptada", etiqueta: "Registrada" },
  { codigo: "reinicio", etiqueta: "Reinicio" },
  { codigo: "anulada", etiqueta: "Anulada" },
];

/** ¿Espera a una persona? La única definición: la usan el contador de la pestaña, el chip y el filtro. */
export function esPendiente(estado: string | null | undefined): boolean {
  return estado === "sospechosa" || estado === "rechazada";
}

/** Tipo de problema de una lectura pendiente; null si no está pendiente (una registrada no tiene «problema»). */
export function problemaDe(l: { estado: string; motivo?: string | null }): TipoRevision | null {
  return esPendiente(l.estado) ? tipoDeRevision(l.motivo) : null;
}

export type FiltroEstado = "auto" | "todos" | "pendientes" | EstadoLecturaRadar;
export type ColumnaOrden = "llegada" | "fecha" | "unidad" | "km" | "estado";

export type FiltroLecturas = {
  desde: string;                          // YYYY-MM-DD o "" (fecha de la lectura)
  hasta: string;
  placa: string;                          // texto libre: «cwq», «CWQ-400», «cwq 400»
  flota: "todas" | "propia" | "tercero";
  kmMin: string;                          // texto tal cual se teclea: «23,980», «23.980», «23980»
  kmMax: string;
  foto: "todas" | "con" | "sin";
  estado: FiltroEstado;
  problema: TipoRevision | "todos";
  orden: ColumnaOrden;
  dir: "asc" | "desc";
};

export const FILTRO_LECTURAS_VACIO: FiltroLecturas = {
  desde: "", hasta: "", placa: "", flota: "todas", kmMin: "", kmMax: "", foto: "todas",
  estado: "auto", problema: "todos", orden: "llegada", dir: "desc",
};

export type FilaLectura = {
  id: string;
  km: number;
  fecha: string | null;
  estado: string;
  motivo?: string | null;
  foto_url?: string | null;
  created_at: string;
  vehiculo_tercero_id?: number | null;
  /** La placa ya resuelta contra la flota ("" si no se encontró la unidad). */
  placa: string;
};

/**
 * Un km tecleado en el filtro. Un odómetro no tiene decimales, así que la coma y el punto son
 * separadores de miles: «23,980» y «23.980» son 23980. null si no hay ningún dígito.
 */
export function kmDeTexto(s: string | null | undefined): number | null {
  const d = String(s ?? "").replace(/[^\d]/g, "");
  if (!d) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

/** ¿Hay algo que recorte? El estado «auto» no cuenta: es la vista por defecto, no un filtro puesto a mano. */
export function hayFiltroLecturas(f: FiltroLecturas): boolean {
  return !!f.desde || !!f.hasta || !!f.placa.trim() || f.flota !== "todas" || kmDeTexto(f.kmMin) != null ||
    kmDeTexto(f.kmMax) != null || f.foto !== "todas" || (f.estado !== "auto" && f.estado !== "todos") || f.problema !== "todos";
}

type Eje = "estado" | "problema" | "foto" | "flota" | "placa";

function pasaEstado(estado: string, filtro: Exclude<FiltroEstado, "auto">): boolean {
  if (filtro === "todos") return true;
  if (filtro === "pendientes") return esPendiente(estado);
  return estado === filtro;
}

function pasa(l: FilaLectura, f: FiltroLecturas, estado: Exclude<FiltroEstado, "auto">, salvo: Eje | null): boolean {
  if (salvo !== "estado" && !pasaEstado(l.estado, estado)) return false;
  // Elegir un problema deja solo las pendientes de ese tipo: una lectura registrada no tiene problema.
  if (salvo !== "problema" && f.problema !== "todos" && problemaDe(l) !== f.problema) return false;
  if (salvo !== "placa") {
    const q = placaComparable(f.placa);
    if (q && !placaComparable(l.placa).includes(q)) return false;
  }
  if (salvo !== "flota" && f.flota !== "todas") {
    const esTercero = l.vehiculo_tercero_id != null;
    if (f.flota === "tercero" ? !esTercero : esTercero) return false;
  }
  if (salvo !== "foto" && f.foto !== "todas" && (f.foto === "con") !== !!l.foto_url) return false;
  // Sin fecha no se puede afirmar que caiga dentro del rango: con un rango puesto, queda fuera.
  const fecha = l.fecha ? l.fecha.slice(0, 10) : null;
  if (f.desde && (!fecha || fecha < f.desde)) return false;
  if (f.hasta && (!fecha || fecha > f.hasta)) return false;
  const min = kmDeTexto(f.kmMin);
  const max = kmDeTexto(f.kmMax);
  if (min != null && Number(l.km) < min) return false;
  if (max != null && Number(l.km) > max) return false;
  return true;
}

const tsLlegada = (l: FilaLectura) => new Date(l.created_at).getTime() || 0;
const desempate = (a: FilaLectura, b: FilaLectura) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Pendientes primero, después en el orden de ESTADOS_LECTURA.
const rangoEstado = (e: string) => {
  const i = ESTADOS_LECTURA.findIndex((x) => x.codigo === e);
  return i < 0 ? ESTADOS_LECTURA.length : i;
};

/** Orden de las filas. «llegada» es el de siempre (la más reciente primero) y no tiene dirección. */
export function ordenarLecturas<T extends FilaLectura>(filas: T[], orden: ColumnaOrden, dir: "asc" | "desc"): T[] {
  const s = dir === "asc" ? 1 : -1;
  const porLlegada = (a: T, b: T) => tsLlegada(b) - tsLlegada(a) || desempate(a, b);
  const cmp: Record<ColumnaOrden, (a: T, b: T) => number> = {
    llegada: porLlegada,
    // Sin fecha va al final en las dos direcciones: no es «la más antigua» ni «la más nueva». La
    // fecha se compara en binario, no con localeCompare (que ignora la puntuación de una fecha ISO).
    fecha: (a, b) => {
      if (!a.fecha !== !b.fecha) return a.fecha ? -1 : 1;
      const fa = String(a.fecha ?? "").slice(0, 10);
      const fb = String(b.fecha ?? "").slice(0, 10);
      return s * (fa < fb ? -1 : fa > fb ? 1 : 0) || s * (tsLlegada(a) - tsLlegada(b)) || desempate(a, b);
    },
    unidad: (a, b) => {
      if (!a.placa !== !b.placa) return a.placa ? -1 : 1;
      return s * a.placa.localeCompare(b.placa) || porLlegada(a, b);
    },
    km: (a, b) => s * (Number(a.km) - Number(b.km)) || porLlegada(a, b),
    estado: (a, b) => s * (rangoEstado(a.estado) - rangoEstado(b.estado)) || porLlegada(a, b),
  };
  return [...filas].sort(cmp[orden]);
}

/** Dirección con la que arranca una columna al pulsarla: lo útil primero (lo más nuevo, el km más alto, A→Z, pendientes primero). */
export function dirInicial(col: ColumnaOrden): "asc" | "desc" {
  return col === "unidad" || col === "estado" ? "asc" : "desc";
}

export type AvisoFiltro = { codigo: "rango_fechas_invertido" | "rango_km_invertido"; texto: string };

export type ResultadoLecturas<T> = {
  filas: T[];
  total: number;
  /** El estado que de verdad se aplicó («auto» ya resuelto). */
  estadoAplicado: Exclude<FiltroEstado, "auto">;
  /** Pendientes en TODA la lista, sin ningún filtro: el contador de la pestaña. */
  pendientesTotal: number;
  /** Conteo por estado con los otros filtros puestos (sin el de estado). */
  porEstado: Record<EstadoLecturaRadar, number> & { pendientes: number; todos: number };
  /** Conteo por problema (solo pendientes) con los otros filtros puestos (sin el de problema). */
  porProblema: Record<TipoRevision, number>;
  porFoto: { con: number; sin: number };
  porFlota: { propia: number; tercero: number };
  /** Placas con lecturas que pasan los otros filtros (sin el de placa), de más a menos. */
  porPlaca: { placa: string; n: number }[];
  avisos: AvisoFiltro[];
};

export function filtrarLecturas<T extends FilaLectura>(todas: T[], filtro: FiltroLecturas): ResultadoLecturas<T> {
  const pendientesTotal = todas.filter((l) => esPendiente(l.estado)).length;
  const estadoAplicado: Exclude<FiltroEstado, "auto"> =
    filtro.estado === "auto" ? (pendientesTotal > 0 ? "pendientes" : "todos") : filtro.estado;

  const porEstado = { aceptada: 0, sospechosa: 0, rechazada: 0, reinicio: 0, anulada: 0, pendientes: 0, todos: 0 };
  const porProblema = Object.fromEntries(TIPOS_REVISION.map((t) => [t.codigo, 0])) as Record<TipoRevision, number>;
  const porFoto = { con: 0, sin: 0 };
  const porFlota = { propia: 0, tercero: 0 };
  const placas = new Map<string, number>();
  const filas: T[] = [];

  for (const l of todas) {
    if (pasa(l, filtro, estadoAplicado, "estado")) {
      porEstado.todos++;
      if (l.estado in porEstado) porEstado[l.estado as EstadoLecturaRadar]++;
      if (esPendiente(l.estado)) porEstado.pendientes++;
    }
    if (pasa(l, filtro, estadoAplicado, "problema")) {
      const p = problemaDe(l);
      if (p) porProblema[p]++;
    }
    if (pasa(l, filtro, estadoAplicado, "foto")) porFoto[l.foto_url ? "con" : "sin"]++;
    if (pasa(l, filtro, estadoAplicado, "flota")) porFlota[l.vehiculo_tercero_id != null ? "tercero" : "propia"]++;
    if (l.placa && pasa(l, filtro, estadoAplicado, "placa")) placas.set(l.placa, (placas.get(l.placa) ?? 0) + 1);
    if (pasa(l, filtro, estadoAplicado, null)) filas.push(l);
  }

  const avisos: AvisoFiltro[] = [];
  if (filtro.desde && filtro.hasta && filtro.desde > filtro.hasta) {
    avisos.push({ codigo: "rango_fechas_invertido", texto: "La fecha «desde» es posterior a «hasta»: ninguna lectura puede cumplir las dos." });
  }
  const min = kmDeTexto(filtro.kmMin);
  const max = kmDeTexto(filtro.kmMax);
  if (min != null && max != null && min > max) {
    avisos.push({ codigo: "rango_km_invertido", texto: "El km mínimo es mayor que el máximo: ninguna lectura puede cumplir los dos." });
  }

  const porPlaca = [...placas.entries()]
    .map(([placa, n]) => ({ placa, n }))
    .sort((a, b) => b.n - a.n || a.placa.localeCompare(b.placa));

  return {
    filas: ordenarLecturas(filas, filtro.orden, filtro.dir),
    total: todas.length,
    estadoAplicado,
    pendientesTotal,
    porEstado,
    porProblema,
    porFoto,
    porFlota,
    porPlaca,
    avisos,
  };
}
