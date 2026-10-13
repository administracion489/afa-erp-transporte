/**
 * Buscador de unidades de flota (propias y tercerizadas) — módulo PURO: no lee la base.
 *
 * Reemplaza a los dos `<select>` de «Unidad de flota → fotos en PDF» de /cotizaciones, que
 * listaban 3 propias y ~90 tercerizadas por placa y obligaban a desplazarse. Mismo modelo que
 * `lib/clientes-buscador.ts` (y la misma regla de texto, `lib/busqueda-texto.ts`).
 *
 * Reglas:
 *  - LA PLACA SE ENCUENTRA COMO SE TECLEE: «BVI124», «bvi-124», «BVI 124» y el «124» suelto
 *    encuentran «BVI-124» (`normalizarPlaca` quita mayúsculas, guiones y espacios).
 *  - Se busca sobre placa (con y sin guion), categoría, marca, modelo, año, capacidad («50»,
 *    «50p», «50 pax»), nivel rotulado (Full Equipo / Estándar), ficha de costeo y —en
 *    terceros— la empresa.
 *  - EL NIVEL SALE DE `nivelDeEquipamiento`, la conversión única de lib/costos/nivel-servicio.ts:
 *    `equipamiento` null es FULL EQUIPO (default de la columna). `undefined` = la tabla no tiene
 *    la columna (`vehiculos_tercero`), y ahí NO se afirma ningún nivel.
 *  - Orden: placa exacta → placa que EMPIEZA por la consulta → coincide con el vehículo de
 *    tarifa → más usada en cotizaciones → placa (es) → id (orden total).
 *  - Consulta vacía: secciones «Coinciden con la tarifa (…)», «Recientes» y el resto por
 *    placa — disjuntas y exhaustivas: toda unidad sale UNA vez.
 *  - Un estado que no es «disponible/activo» (p. ej. «ocupado») se ENSEÑA en gris y se puede
 *    elegir: este buscador no inventa bloqueos (los inactivos ya vienen filtrados).
 */
import { coincideBusqueda, normalizarBusqueda, terminosBusqueda } from "./busqueda-texto";
import { recientesDe, usoPorCliente, type UsoCliente } from "./clientes-buscador";
import { NIVEL_CFG, nivelDeEquipamiento, type NivelServicio } from "./costos/nivel-servicio";

export type VehiculoBuscable = {
  id: number;
  placa: string;
  categoria?: string | null;
  marca?: string | null;
  modelo?: string | null;
  anio?: number | null;
  /** Propios. */
  capacidad_pasajeros?: number | null;
  /** Terceros. */
  capacidad?: number | null;
  /** Solo propios; `undefined` = la tabla no tiene la columna. */
  equipamiento?: string | null;
  tipo_vehiculo_costeo?: string | null;
  empresa_nombre?: string | null;
  estado?: string | null;
  foto_externa_url?: string | null;
  foto_interna_url?: string | null;
};

export type UsoVehiculo = UsoCliente;
export type CampoVehiculoCot = "vehiculo_flota_id" | "vehiculo_tercero_id";
type CotizacionMin = { vehiculo_flota_id?: number | null; vehiculo_tercero_id?: number | null; created_at: string };

/* ─────────────────────────── Datos de la unidad ─────────────────────────── */

/** Placa para comparar: sin mayúsculas, guiones ni espacios. NUNCA se persiste. */
export const normalizarPlaca = (s: string | null | undefined) => normalizarBusqueda(s).replace(/ /g, "");

export function capacidadVehiculo(v: VehiculoBuscable): number | null {
  const n = Number(v.capacidad_pasajeros ?? v.capacidad);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Nivel de la unidad, o null si la tabla no tiene el dato (terceros). */
export function nivelVehiculo(v: VehiculoBuscable): NivelServicio | null {
  return v.equipamiento === undefined ? null : nivelDeEquipamiento(v.equipamiento);
}

export const tieneFotos = (v: VehiculoBuscable) => !!(v.foto_externa_url || v.foto_interna_url);

/** «BUS Mercedes O500 2019». */
export function descripcionVehiculo(v: VehiculoBuscable): string {
  return [v.categoria, v.marca, v.modelo, v.anio].map(x => String(x ?? "").trim()).filter(Boolean).join(" ");
}

/** Lo que enseña el campo cerrado: «BVI-124 — EMPRESA · BUS Mercedes (50p)». */
export function rotuloVehiculo(v: VehiculoBuscable): string {
  const cuerpo = [v.empresa_nombre, descripcionVehiculo(v)].map(x => String(x ?? "").trim()).filter(Boolean).join(" · ");
  const cap = capacidadVehiculo(v);
  return `${v.placa}${cuerpo ? ` — ${cuerpo}` : ""}${cap ? ` (${cap}p)` : ""}`;
}

const ESTADOS_OPERATIVOS = new Set(["", "activo", "disponible"]);

/** Rótulo del estado si NO es operativo («Ocupado»…); null si es disponible/activo o no hay. */
export function chipEstadoVehiculo(v: VehiculoBuscable): string | null {
  const e = String(v.estado ?? "").trim();
  if (ESTADOS_OPERATIVOS.has(e.toLowerCase())) return null;
  const t = e.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export const coincideTarifa = (v: VehiculoBuscable, tarifaTipo?: string | null) =>
  !!tarifaTipo && v.tipo_vehiculo_costeo === tarifaTipo;

/* ─────────────────────────── Uso y recientes ─────────────────────────── */

const comoCliente = (cot: CotizacionMin[], campo: CampoVehiculoCot) =>
  cot.map(c => ({ cliente_id: c[campo] ?? null, created_at: c.created_at }));

/** Cuántas cotizaciones usan cada unidad y cuándo fue la última (misma regla que clientes). */
export function usoPorVehiculo(cot: CotizacionMin[], campo: CampoVehiculoCot): Map<number, UsoVehiculo> {
  return usoPorCliente(comoCliente(cot, campo));
}

/** Las `n` unidades cotizadas más recientemente, distintas, la más reciente primero. */
export function recientesVehiculos(cot: CotizacionMin[], campo: CampoVehiculoCot, n: number): number[] {
  return recientesDe(comoCliente(cot, campo), n);
}

/* ─────────────────────────── Búsqueda ─────────────────────────── */

/** Todo el texto contra el que se busca una unidad. */
export function textoBuscableVehiculo(v: VehiculoBuscable): string {
  const cap = capacidadVehiculo(v);
  const nivel = nivelVehiculo(v);
  return [
    v.placa, normalizarPlaca(v.placa), v.categoria, v.marca, v.modelo, v.anio,
    ...(cap ? [`${cap}`, `${cap}p`, `${cap} pax`, `${cap}pax`] : []),
    nivel ? NIVEL_CFG[nivel].label : null,
    v.tipo_vehiculo_costeo, v.empresa_nombre,
  ].filter(x => x != null && String(x).trim() !== "").join(" ");
}

export function coincideVehiculo(v: VehiculoBuscable, terminos: string[]): boolean {
  return coincideBusqueda(textoBuscableVehiculo(v), terminos);
}

type Opciones = { uso?: Map<number, UsoVehiculo>; tarifaTipo?: string | null; limite?: number };

const cortar = <T,>(xs: T[], lim?: number) =>
  lim == null || !Number.isFinite(lim) ? xs : xs.slice(0, Math.max(0, Math.floor(lim)));

export function buscarVehiculos(vs: VehiculoBuscable[], q: string, o?: Opciones): { resultados: VehiculoBuscable[]; total: number } {
  const terminos = terminosBusqueda(q);
  const qPlaca = normalizarPlaca(q);
  const filas = vs.filter(v => coincideVehiculo(v, terminos)).map(v => {
    const p = normalizarPlaca(v.placa);
    return {
      v, exacta: !!qPlaca && p === qPlaca, prefijo: !!qPlaca && p.startsWith(qPlaca),
      tarifa: coincideTarifa(v, o?.tarifaTipo), usos: o?.uso?.get(v.id)?.cotizaciones ?? 0,
    };
  });
  filas.sort((a, b) =>
    (Number(b.exacta) - Number(a.exacta)) ||
    (Number(b.prefijo) - Number(a.prefijo)) ||
    (Number(b.tarifa) - Number(a.tarifa)) ||
    (b.usos - a.usos) ||
    String(a.v.placa ?? "").localeCompare(String(b.v.placa ?? ""), "es") ||
    (a.v.id - b.v.id));
  return { resultados: cortar(filas.map(f => f.v), o?.limite), total: filas.length };
}

export type SeccionVehiculos = { titulo: string; vehiculos: VehiculoBuscable[] };

/**
 * La lista con la consulta vacía, en secciones DISJUNTAS: tarifa → recientes (máx.
 * `maxRecientes`) → el resto por placa. Sin `limite` toda unidad sale exactamente una vez; con
 * él se corta en ese orden y `ocultos` dice cuántas quedaron fuera.
 */
export function seccionesVehiculos(
  vs: VehiculoBuscable[],
  o: { tarifaTipo?: string | null; tarifaNombre?: string | null; recientes?: number[]; uso?: Map<number, UsoVehiculo>; maxRecientes?: number; limite?: number },
): { secciones: SeccionVehiculos[]; total: number; ocultos: number } {
  const usados = new Set<number>();
  const secciones: SeccionVehiculos[] = [];
  const porPlaca = buscarVehiculos(vs, "", { uso: o.uso }).resultados; // uso → placa
  if (o.tarifaTipo) {
    const t = porPlaca.filter(v => coincideTarifa(v, o.tarifaTipo));
    t.forEach(v => usados.add(v.id));
    if (t.length) secciones.push({ titulo: `Coinciden con la tarifa (${o.tarifaNombre || o.tarifaTipo})`, vehiculos: t });
  }
  const porId = new Map(vs.map(v => [v.id, v]));
  const maxRec = Math.max(0, Math.floor(o.maxRecientes ?? 8));
  const rec: VehiculoBuscable[] = [];
  for (const id of o.recientes ?? []) {
    if (rec.length >= maxRec) break;
    const v = porId.get(id);
    if (v && !usados.has(v.id)) { rec.push(v); usados.add(v.id); }
  }
  if (rec.length) secciones.push({ titulo: "Recientes", vehiculos: rec });
  const resto = vs.filter(v => !usados.has(v.id))
    .sort((a, b) => String(a.placa ?? "").localeCompare(String(b.placa ?? ""), "es") || a.id - b.id);
  if (resto.length) secciones.push({ titulo: secciones.length ? "Resto por placa" : "Todas por placa", vehiculos: resto });

  const total = secciones.reduce((s, x) => s + x.vehiculos.length, 0);
  if (o.limite == null || !Number.isFinite(o.limite)) return { secciones, total, ocultos: 0 };
  let queda = Math.max(0, Math.floor(o.limite));
  const cortadas: SeccionVehiculos[] = [];
  for (const s of secciones) {
    if (!queda) break;
    const vsS = s.vehiculos.slice(0, queda);
    queda -= vsS.length;
    cortadas.push({ titulo: s.titulo, vehiculos: vsS });
  }
  const mostrados = cortadas.reduce((s, x) => s + x.vehiculos.length, 0);
  return { secciones: cortadas, total, ocultos: total - mostrados };
}
