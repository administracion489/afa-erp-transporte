// components/flota/excesos-vista.ts — PURO. Lo que /seguridad-vial necesita para PINTAR la
// respuesta de /api/flota/excesos sin decidir nada que ya decida el motor (lib/flota/excesos.ts).
//
// Qué hace y qué NO hace:
//   · El filtro de FLOTA no cuenta nada por su cuenta: recorta los episodios y los servicios y le
//     pide el ranking otra vez a `resumirConteo` (el mismo que arma la respuesta de la API). Así el
//     total con «Flota propia» y la fila de cada conductor salen del mismo motor que con «Todas».
//   · La flota de un servicio la dice su UNIDAD (el dato escrito en la reserva) y, sin unidad, su
//     conductor asignado. La de un episodio, la de su servicio; fuera de servicio, la unidad que
//     declaró el teléfono o el conductor. Las claves llevan la tabla: "p:" propia, "t:" tercero.
//   · Lo que el motor NO separa por flota (los descartados por motivo, y el conteo de los excesos
//     fuera de servicio cuando no se listan) se publica tal cual y se DECLARA que es de todas las
//     flotas: recortarlo aquí sería inventar un reparto.
//   · Los rangos de fechas, el umbral y el formato de la hora de Lima.

import {
  fechaValida, diasEntre, sumarDias, resumirConteo,
  MAX_DIAS_CONSULTA, UMBRAL_DEFECTO_KMH, UMBRAL_MIN_KMH, UMBRAL_MAX_KMH,
  type ConteoEpisodios, type Episodio, type RespuestaExcesos, type ResumenExcesos, type ServicioExpuesto,
} from "@/lib/flota/excesos";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "@/lib/alertas-horario";

// ── Rango y umbral ────────────────────────────────────────────────────────────

/** Lo más largo que la pantalla pide de una vez: un mes. La API mide como mucho
 *  MAX_DIAS_CONSULTA días por llamada, así que un mes son 5 tandas (`tandasDeRango`). */
export const MAX_DIAS_RANGO = 31;
/** Las opciones del selector: de 5 en 5 desde el piso del índice hasta 120. La API admite hasta
 *  UMBRAL_MAX_KMH; un umbral de la URL fuera de esta lista se agrega como opción. */
export const UMBRAL_TOPE_SELECTOR = 120;

export function opcionesUmbral(actual: number): number[] {
  const out: number[] = [];
  for (let u = UMBRAL_MIN_KMH; u <= UMBRAL_TOPE_SELECTOR; u += 5) out.push(u);
  if (umbralValido(actual) && !out.includes(actual)) out.push(actual);
  return out.sort((a, b) => a - b);
}

export const umbralValido = (u: number) => Number.isInteger(u) && u >= UMBRAL_MIN_KMH && u <= UMBRAL_MAX_KMH;

/** null si el rango se puede medir; si no, la frase que lo explica. */
export function problemaDeRango(desde: string, hasta: string, hoy: string): string | null {
  if (!fechaValida(desde) || !fechaValida(hasta)) return "Elige las dos fechas del rango.";
  if (desde > hasta) return "La fecha «desde» es posterior a «hasta».";
  if (hasta > hoy) return "El rango no puede terminar en el futuro.";
  const dias = diasEntre(desde, hasta) + 1;
  if (dias > MAX_DIAS_RANGO) return `Se mide como mucho ${MAX_DIAS_RANGO} días a la vez (elegiste ${dias}).`;
  return null;
}

export type ParametrosUrl = { desde: string; hasta: string; umbral: number; reserva: number | null; avisos: string[] };

/** ?desde&hasta&reserva&umbral. Lo inválido cae al defecto y se DICE (un enlace roto no puede
 *  medir en silencio otra cosa que la que pide). Por defecto: los últimos MAX_DIAS_CONSULTA días. */
export function leerParametros(search: string, hoy: string): ParametrosUrl {
  const sp = new URLSearchParams(search);
  const avisos: string[] = [];
  let hasta = sp.get("hasta") || hoy;
  if (!fechaValida(hasta) || hasta > hoy) {
    if (sp.get("hasta")) avisos.push(`La fecha «hasta» del enlace (${sp.get("hasta")}) no es válida: se mide hasta hoy.`);
    hasta = hoy;
  }
  let desde = sp.get("desde") || sumarDias(hasta, -(MAX_DIAS_CONSULTA - 1));
  if (!fechaValida(desde) || desde > hasta || diasEntre(desde, hasta) + 1 > MAX_DIAS_RANGO) {
    if (sp.get("desde")) avisos.push(`La fecha «desde» del enlace (${sp.get("desde")}) no es válida para este rango: se miden los últimos ${MAX_DIAS_CONSULTA} días.`);
    desde = sumarDias(hasta, -(MAX_DIAS_CONSULTA - 1));
  }
  let umbral = UMBRAL_DEFECTO_KMH;
  const u = sp.get("umbral");
  if (u != null && u !== "") {
    const n = Number(u);
    if (/^\d{1,3}$/.test(u) && umbralValido(n)) umbral = n;
    else avisos.push(`El umbral del enlace (${u}) no es válido: se usan ${UMBRAL_DEFECTO_KMH} km/h.`);
  }
  const r = sp.get("reserva");
  const rn = r != null && /^\d{1,12}$/.test(r) ? Number(r) : null;
  if (r && rn == null) avisos.push(`El servicio del enlace (${r}) no es un número de servicio.`);
  return { desde, hasta, umbral, reserva: rn != null && rn > 0 ? rn : null, avisos };
}

// ── Hora de Lima ──────────────────────────────────────────────────────────────

/** "12/10/2026" */
export function fechaCorta(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
/** "12/10/2026 14:32" en hora de Lima (UTC−5), de un instante en ms. */
export function fechaHoraLima(ms: number): string {
  return `${fechaCorta(fechaLima(ms))} ${minutosAHhmm(minutoDelDiaLima(ms))}`;
}
export const horaLima = (ms: number) => minutosAHhmm(minutoDelDiaLima(ms));

// ── Flota ─────────────────────────────────────────────────────────────────────

export type FiltroFlota = "todas" | "propia" | "tercero";
export const ETIQUETA_FLOTA: Record<FiltroFlota, string> = {
  todas: "Todas las flotas",
  propia: "Flota propia",
  tercero: "Tercerizada",
};

const flotaDeClave = (k: string | null | undefined): "propia" | "tercero" | null =>
  k?.startsWith("p:") ? "propia" : k?.startsWith("t:") ? "tercero" : null;

export const esTercero = (clave: string | null | undefined) => flotaDeClave(clave) === "tercero";

export function flotaDeServicio(s: ServicioExpuesto): "propia" | "tercero" | null {
  return flotaDeClave(s.vehiculo) ?? flotaDeClave(s.conductor);
}

export function flotaDeEpisodio(e: Episodio, servicios: ReadonlyMap<number, ServicioExpuesto>): "propia" | "tercero" | null {
  const s = e.reservaId != null ? servicios.get(e.reservaId) : undefined;
  return (s ? flotaDeServicio(s) : null) ?? flotaDeClave(e.vehiculo) ?? flotaDeClave(e.conductor);
}

export type VistaExcesos = {
  resumen: ResumenExcesos;
  /** los `exceso` con servicio (los que cuentan) de esta flota, por inicio */
  episodios: Episodio[];
  /** los descartados por motivo vienen de todas las flotas (el motor no los separa) */
  descartadosDeTodas: boolean;
  /** el conteo de excesos fuera de servicio viene de todas las flotas (no se listaron) */
  fueraDeTodas: boolean;
  /** servicios prestados y excesos que no dicen de qué flota son (sin unidad ni conductor) */
  sinFlota: number;
};

/** La respuesta (ya recortada con `vistaRespuesta`) vista para una flota. Con «todas», tal cual. */
export function vistaPorFlota(r: RespuestaExcesos, flota: FiltroFlota): VistaExcesos {
  if (flota === "todas") {
    return { resumen: r.resumen, episodios: r.episodios, descartadosDeTodas: false, fueraDeTodas: false, sinFlota: 0 };
  }
  const servicios = new Map(r.servicios.map((s) => [s.reservaId, s] as const));
  const pasa = (e: Episodio) => flotaDeEpisodio(e, servicios) === flota;
  const enServicio = r.episodios.filter(pasa);
  const fuera = r.resumen.fueraDeServicio.filter(pasa);
  const conteo: ConteoEpisodios = {
    enServicio,
    fueraDeServicio: fuera,
    fueraDeServicioTotal: r.incluyeFueraDeServicio ? fuera.length : r.resumen.fueraDeServicioTotal,
    descartados: { ...r.resumen.descartados },
    descartadosFuera: { ...r.resumen.descartadosFuera },
  };
  const velocimetro = new Map(r.conductores.map((c) => [c.clave, c.velocimetro] as const));
  const resumen = resumirConteo(
    conteo,
    { servicios: r.servicios.filter((s) => flotaDeServicio(s) === flota), velocimetro },
    { incluirFueraDeServicio: r.incluyeFueraDeServicio },
  );
  const sinFlota = r.servicios.filter((s) => s.prestado && flotaDeServicio(s) == null).length
    + r.episodios.filter((e) => flotaDeEpisodio(e, servicios) == null).length;
  return { resumen, episodios: enServicio, descartadosDeTodas: true, fueraDeTodas: !r.incluyeFueraDeServicio, sinFlota };
}

// ── Orden de las tablas ───────────────────────────────────────────────────────

export type Sentido = "asc" | "desc";
/** Compara dos valores con los VACÍOS SIEMPRE AL FINAL, en los dos sentidos: un «no se puede
 *  juzgar» no es el menor ni el mayor de una columna de excesos. */
export function compararConVacios(a: number | string | null | undefined, b: number | string | null | undefined, sentido: Sentido): number {
  const va = a == null || a === "", vb = b == null || b === "";
  if (va && vb) return 0;
  if (va) return 1;
  if (vb) return -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "es");
  return sentido === "asc" ? c : -c;
}

/** Ordena una copia con una clave; sin clave, el orden en que vino (el del motor). Estable. */
export function ordenarPor<T>(filas: readonly T[], clave: ((f: T) => number | string | null | undefined) | null, sentido: Sentido): T[] {
  if (!clave) return [...filas];
  return filas.map((f, i) => ({ f, i }))
    .sort((x, y) => compararConVacios(clave(x.f), clave(y.f), sentido) || x.i - y.i)
    .map((x) => x.f);
}
