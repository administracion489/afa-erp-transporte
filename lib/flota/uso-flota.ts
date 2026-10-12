// ──────────────────────────────────────────────────────────────────────────────
// lib/flota/uso-flota.ts — Motor PURO del USO DE FLOTA de un periodo (la pestaña Resumen de
// /uso-flota y la herramienta `utilizacion_flota` de ELIA). No lee la base ni hace fetch: recibe
// las filas y devuelve números con su procedencia. Lee lib/flota/uso-flota-datos.ts.
//
// SE EXTRAJO DE ELIA, NO SE REESCRIBIÓ. El uso de flota solo existía dentro de
// lib/elia/herramientas.ts (`utilizacion_flota`). `utilizacionParaElia` arma ahora esa respuesta
// desde este motor con las MISMAS claves y los mismos bloques, y scripts/prueba-uso-flota.mts corre
// el algoritmo viejo copiado literal: servicios, tercerizados, %, días activos y unidades sin uso
// salen IDÉNTICOS.
//
// LA DIVERGENCIA DECLARADA ES EL KM. ELIA sacaba el km de una unidad como `max − min` de sus
// lecturas aceptadas, así que UNA lectura alta aceptada por error —el 24,484 de la CWZ-371 del
// 12/09, foto de otra unidad— inflaba el km de todo el periodo. Aquí el km sale de las jornadas
// SANEADAS (`sanearLecturas` + `recorridosDiarios`, lib/odometro-analitica.ts, el mismo camino de
// /mantenimiento → Odómetro): la lectura que no encaja con las posteriores queda fuera y no infla
// nada. Una jornada con un «salto imposible» (más km que el máximo diario) tampoco cuenta como
// odómetro: una de sus dos lecturas está mal leída.
//
// EL KM DE CADA UNIDAD Y DÍA TIENE UNA FUENTE, Y SE DECLARA (`FuenteKmDia`):
//   · `odometro`    la jornada del odómetro está completa (primera y última lectura del día, saneadas);
//   · `gps`         no hay jornada, y TODOS sus servicios publican km por GPS (`kmPublicable`,
//                   lib/flota/km-gps.ts, la misma puerta del veredicto RASTREO);
//   · `gps_parcial` algunos sí y otros no;
//   · `sin_dato`    ninguno publica km (o no se intentó medir);
//   · `tope`        alguno no se midió porque la petición llegó a MAX_TRAZAS_RELLENO.
// EL ODÓMETRO SIEMPRE GANA AL GPS: mide el día entero de la unidad, incluidos los km en vacío; el
// GPS solo mide los servicios y por eso es un PISO. El total se marca «≥» (`esPiso`) en cuanto
// alguna jornada con servicio no salió del odómetro, y se publica la cobertura.
//
// LO QUE NO SE AFIRMA:
//   · un día o una métrica sin dato medido va en `null`, nunca en 0 (la pantalla lo pinta «sin dato
//     (no es cero)»); un día sin servicios con los datos completos sí es 0;
//   · una hora que nadie registró no se inventa: el servicio terminado sin duración cuenta en
//     `sinHora` y no suma nada;
//   · el CO₂ es de lo COMPRADO (cargas propias × el factor del catálogo); la urea, el biodiésel y
//     los tipos desconocidos quedan fuera y CONTADOS; las cargas de terceros no son de la flota;
//   · nunca se suman cantidades de distinta unidad: galones y m³ van por familia, cada una en la
//     suya; lo que sí se suma son soles y kilos.
//
// LA FLOTA ES LA DE HOY: las unidades propias cuyo estado de HOY no es `inactivo`. No hay historial
// de altas y bajas, así que una unidad dada de baja después del periodo no cuenta como «sin uso» en
// él. Se declara en la respuesta.
//
// EL COLOR NO ES «SUBE = MALO»: lo declara este motor por métrica (`SENTIDO_METRICA`). Más km, más
// servicios, más horas, más gasto y más CO₂ son más trabajo (neutros); más unidades sin uso es la
// anomalía.
// ──────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- las filas de reservas y paradas llegan sin tipos generados de Supabase */
import {
  sanearLecturas, recorridosDiarios, sumarDias, diasEntreFechas, KM_DIA_MAX_DEFECTO,
  type LecturaCruda, type DiaRecorrido,
} from "../odometro-analitica";
import {
  variacionPct, tonoVariacion, normalizarCantidad, type SentidoVariacion, type TonoVariacion,
} from "../rendimiento";
import { COMBUSTIBLES, normalizarTipoCombustible, unidadDeCarga, co2DeCantidad } from "../combustible-tipos";
import { contextoServicio } from "../gps-cobertura";
import { derivarTiempos } from "../servicio-tiempos";
import type { KmGps } from "./km-gps";
import type { BloqueUI } from "../elia/tipos";

// ─── CONSTANTES (con su procedencia) ──────────────────────────────────────────

/** Trazas de GPS que una petición lee, como mucho, para rellenar los días sin jornada de odómetro.
 *  OPERATIVO, no medido: cada traza son miles de filas. Lo que pasa del tope sale `tope`, nunca 0. */
export const MAX_TRAZAS_RELLENO = 40;
/** Días de lecturas ANTES (y después) del periodo que se le dan al saneo del odómetro, para que la
 *  primera lectura del periodo se juzgue contra las anteriores. OPERATIVO, no medido. */
export const DIAS_ANCLA_LECTURAS = 30;
/** Puntos de cobertura del odómetro entre un periodo y otro a partir de los que la comparación del km
 *  se AVISA (la variación puede ser de registro, no de trabajo). NO MEDIDO: el lado seguro es bajarlo. */
export const UMBRAL_CAMBIO_COBERTURA_PTS = 10;

export type ProcedenciaConstante = "operativo" | "heredado" | "no_medido";
export type ConstanteUso = { clave: string; valor: number; unidad: string; procedencia: ProcedenciaConstante; texto: string };

/** Las constantes del módulo tal como se le enseñan a una persona («Cómo se mide»). */
export function constantesUso(kmDiaMax: number = KM_DIA_MAX_DEFECTO): ConstanteUso[] {
  return [
    { clave: "MAX_TRAZAS_RELLENO", valor: MAX_TRAZAS_RELLENO, unidad: "trazas por consulta", procedencia: "operativo",
      texto: "Cuántos servicios sin jornada de odómetro se miden por GPS en una consulta. Lo que pasa del tope sale «sin medir (tope)», nunca 0." },
    { clave: "DIAS_ANCLA_LECTURAS", valor: DIAS_ANCLA_LECTURAS, unidad: "días", procedencia: "operativo",
      texto: "Lecturas de odómetro de antes y después del periodo que se usan para descartar la lectura que no encaja." },
    { clave: "KM_DIA_MAX", valor: kmDiaMax, unidad: "km por día", procedencia: "heredado",
      texto: "Una jornada con un salto mayor que esto entre dos lecturas no cuenta como odómetro (config_mantenimiento.km_dia_max)." },
    { clave: "UMBRAL_CAMBIO_COBERTURA_PTS", valor: UMBRAL_CAMBIO_COBERTURA_PTS, unidad: "puntos de %", procedencia: "no_medido",
      texto: "Si la cobertura del odómetro cambia más que esto entre los dos periodos, la variación del km se avisa." },
  ];
}

// ─── ENTRADA ──────────────────────────────────────────────────────────────────

/** Una unidad propia, tal como está HOY en `vehiculos`. */
export type PropiaUso = { id: number; placa: string; estado: string | null; categoria: string | null };

/** Una carga de `combustible`. Solo cuentan las PROPIAS (`vehiculo_id` y sin `vehiculo_tercero_id`). */
export type CargaUso = {
  fecha: string;
  vehiculo_id: number | null;
  vehiculo_tercero_id?: number | null;
  tipo_combustible: string | null;
  galones: number | null;
  unidad: string | null;
  total: number | null;
};

export type EntradaUso = {
  desde: string;
  hasta: string;
  /** hoy en Lima (YYYY-MM-DD) */
  hoy: string;
  ahoraMs: number;
  /** TODAS las unidades propias (también las inactivas: tienen historia), en el orden de la base */
  propios: PropiaUso[];
  /** reservas NO canceladas (las que trae `.neq("estado","cancelada")`); se recortan al periodo aquí */
  reservas: any[];
  /** lecturas de odómetro propias, con DIAS_ANCLA_LECTURAS de contexto alrededor del periodo */
  lecturas: LecturaCruda[];
  /** paradas de cada reserva (para las horas); vacío = sin paradas */
  paradasPorReserva: Map<number, any[]>;
  /** km por GPS de las reservas que se midieron para el relleno */
  kmGpsPorReserva: Map<number, KmGps>;
  /** reservas que necesitaban relleno y NO se midieron por el tope (o el presupuesto de tiempo) */
  sinMedirPorTope?: Set<number>;
  /** cargas de combustible; null = no se pudieron leer (la sección sale sin dato, nunca en 0) */
  cargas: CargaUso[] | null;
  /** último servicio no cancelado hasta `hasta` de las unidades sin uso. Clave ausente = no se leyó;
   *  null = ninguno registrado. */
  ultimoServicio?: Map<number, string | null>;
  /** tope de km por día (config_mantenimiento.km_dia_max) */
  kmDiaMax?: number;
};

// ─── SALIDA ───────────────────────────────────────────────────────────────────

export type FuenteKmDia = "odometro" | "gps" | "gps_parcial" | "sin_dato" | "tope";
export const FUENTES_KM_DIA: readonly FuenteKmDia[] = ["odometro", "gps", "gps_parcial", "sin_dato", "tope"];

/** El km de UNA unidad en UN día. Existe si el día tuvo jornada de odómetro válida o algún servicio. */
export type JornadaUso = {
  vehiculoId: number;
  fecha: string;
  fuente: FuenteKmDia;
  /** null si no se sabe (sin_dato, o tope sin nada medido) */
  km: number | null;
  /** la unidad tuvo ese día algún servicio no cancelado que pudo correr (no los que aún no empiezan) */
  conServicio: boolean;
  /** ids de esos servicios */
  reservas: number[];
};

export type MotivoSinUso = "en_mantenimiento" | "sin_servicio";

export type SinUso = {
  vehiculoId: number;
  placa: string;
  estado: string | null;
  categoria: string | null;
  motivo: MotivoSinUso;
  /** fecha del último servicio no cancelado hasta el fin del periodo; null = ninguno registrado o no se leyó */
  ultimoServicio: string | null;
  /** false = no se pudo leer (no es «nunca tuvo servicio») */
  ultimoServicioLeido: boolean;
};

export type FamiliaUso = {
  familia: string;
  /** unidad canónica de la familia: galones o m³ (la urea, litros) */
  unidad: "galones" | "litros" | "m3";
  unidadLabel: string;
  /** cantidad en la unidad canónica; solo de las cargas cuya unidad se supo convertir */
  cantidad: number;
  cargasSinCantidad: number;
  gasto: number;
  /** null si la familia no tiene factor (urea, biodiésel) o no hubo cantidad estimable */
  co2Kg: number | null;
  cargas: number;
};

export type CombustibleUso = {
  /** false = las cargas no se pudieron leer: gasto y CO₂ van en null */
  leido: boolean;
  /** suma de `total` de las cargas propias (lo que cuadra con caja), urea incluida */
  gasto: number | null;
  /** CO₂ de lo COMPRADO; null si no se pudo estimar nada de lo que sí emite */
  co2Kg: number | null;
  cargas: number;
  cargasConCo2: number;
  /** cargas sin factor de CO₂: urea (aditivo), biodiésel o tipo desconocido. Incluye `cargasAditivo`. */
  cargasSinFactor: number;
  cargasAditivo: number;
  /** con factor, pero la cantidad no se pudo convertir a la unidad de su familia */
  cargasSinCantidad: number;
  /** sin importe utilizable: no suman al gasto */
  cargasSinImporte: number;
  porFamilia: FamiliaUso[];
  /** cargas de tipo desconocido: su gasto está en `gasto`, su cantidad no se puede sumar a ninguna familia */
  sinFamilia: { cargas: number; gasto: number };
};

export type UnidadUso = {
  vehiculoId: number;
  placa: string;
  categoria: string | null;
  estado: string | null;
  /** está en la flota de HOY (estado ≠ inactivo y existe en `vehiculos`) */
  enFlota: boolean;
  servicios: number;
  prestados: number;
  diasActivos: number;
  km: number | null;
  kmPiso: boolean;
  /** días por fuente del km */
  kmFuentes: Record<FuenteKmDia, number>;
  horas: number;
  serviciosSinHora: number;
  gasto: number;
  co2Kg: number | null;
  cargas: number;
  porFamilia: { familia: string; unidadLabel: string; cantidad: number }[];
};

export type DiaSerieUso = {
  fecha: string;
  /** null = hubo jornadas con servicio y ninguna tiene km */
  km: number | null;
  /** el km del día es un mínimo (alguna jornada con servicio no salió del odómetro) */
  kmPiso: boolean;
  /** servicios no cancelados */
  servicios: number;
  /** null = hubo servicios terminados y ninguno con duración */
  horas: number | null;
  /** null = no se leyeron las cargas, o el día tiene cargas y ninguna con importe */
  gasto: number | null;
  /** null = no se leyeron las cargas, o el día tiene cargas que emiten y ninguna estimable */
  co2: number | null;
};

export type ResumenUso = {
  periodo: { desde: string; hasta: string; dias: number };
  km: {
    /** null = hubo jornadas con servicio y ninguna con km */
    total: number | null;
    odometro: number;
    gps: number;
    /** el total es un MÍNIMO (se pinta «≥»): alguna jornada con servicio no salió del odómetro */
    esPiso: boolean;
    cobertura: {
      jornadasConServicio: number;
      conOdometro: number;
      conGps: number;
      sinDato: number;
      tope: number;
      /** % de jornadas con servicio que tienen odómetro; null sin jornadas */
      pct: number | null;
    };
  };
  servicios: {
    /** la definición de ELIA: todo lo no cancelado del periodo */
    noCancelados: number;
    prestados: number;
    enCurso: number;
    /** de un día pasado y sin cerrar (programada, confirmada, pendiente, o en curso de otro día) */
    sinCerrar: number;
    /** de hoy o después, todavía sin empezar */
    programados: number;
    tercerizados: number;
    /** % de los no cancelados que fue a terceros; null sin servicios */
    pctTercerizado: number | null;
  };
  horas: {
    /** horas en servicio; null = hubo servicios terminados y ninguno con duración */
    total: number | null;
    totalMin: number;
    conHora: number;
    /** servicios terminados sin hora de inicio o fin: no suman nada */
    sinHora: number;
  };
  unidades: { flota: number; activas: number; activasIds: number[]; sinUso: SinUso[] };
  combustible: CombustibleUso;
  porUnidad: UnidadUso[];
  serie: DiaSerieUso[];
};

// ─── FECHAS ───────────────────────────────────────────────────────────────────

/** Los días de [desde, hasta], en orden. */
export function diasDelPeriodo(desde: string, hasta: string): string[] {
  const n = diasEntreFechas(desde, hasta) + 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sumarDias(desde, i));
  return out;
}

/** El periodo inmediatamente anterior, del MISMO largo y contiguo: termina el día antes de `desde`. */
export function periodoAnterior(desde: string, hasta: string): { desde: string; hasta: string } {
  const n = diasEntreFechas(desde, hasta) + 1;
  return { desde: sumarDias(desde, -n), hasta: sumarDias(desde, -1) };
}

// ─── REGLAS DE UN SERVICIO ───────────────────────────────────────────────────

const enRango = (f: unknown, desde: string, hasta: string) =>
  typeof f === "string" && f.length >= 10 && f.slice(0, 10) >= desde && f.slice(0, 10) <= hasta;
const fechaDe = (r: any): string => String(r?.fecha_servicio ?? "").slice(0, 10);
const idDe = (r: any): number => Number(r?.id);
const vehDe = (r: any): number | null => (r?.vehiculo_id == null || r.vehiculo_id === "" ? null : Number(r.vehiculo_id));

/** No cancelada: la definición de ELIA (y de la torre). */
const noCancelada = (r: any) => r?.estado !== "cancelada";
/** Tercerizado: la regla de ELIA, literal. */
const esTercerizado = (r: any) => r?.tipo_asignacion === "tercerizado" || !!r?.vehiculo_tercero_id;

type ClaseServicio = "prestado" | "en_curso" | "sin_cerrar" | "programado";
function claseServicio(r: any, hoy: string): ClaseServicio {
  if (r?.estado === "finalizada") return "prestado";
  const f = fechaDe(r);
  if (r?.estado === "en_curso" && f === hoy) return "en_curso";
  return f < hoy ? "sin_cerrar" : "programado";
}

/** Las reservas no canceladas del periodo, en el orden en que llegaron. */
function reservasDelPeriodo(e: EntradaUso): any[] {
  return (e.reservas ?? []).filter((r) => r && noCancelada(r) && enRango(r.fecha_servicio, e.desde, e.hasta));
}

// ─── ODÓMETRO ─────────────────────────────────────────────────────────────────

/** ¿Esta jornada del odómetro se puede publicar como km del día? Completa (dos lecturas o más), sin
 *  cambio de tablero y sin un salto imposible: si no, una de sus lecturas está mal leída. */
export function jornadaOdometroValida(d: DiaRecorrido, kmDiaMax: number = KM_DIA_MAX_DEFECTO): boolean {
  return !d.pendiente && !d.reinicio && d.recorrido != null && Number.isFinite(d.recorrido)
    && d.recorrido >= 0 && d.recorrido <= kmDiaMax && d.sospechosaId == null;
}

/** vehiculoId → fecha → km de la jornada VÁLIDA del odómetro (todas las fechas de las lecturas). */
function jornadasOdometro(lecturas: LecturaCruda[], kmDiaMax: number): Map<number, Map<string, number>> {
  const porVeh = new Map<number, LecturaCruda[]>();
  for (const l of lecturas ?? []) {
    if (!l || l.vehiculo_id == null || l.vehiculo_tercero_id != null) continue;
    const v = Number(l.vehiculo_id);
    if (!Number.isFinite(v)) continue;
    const arr = porVeh.get(v);
    if (arr) arr.push(l); else porVeh.set(v, [l]);
  }
  const out = new Map<number, Map<string, number>>();
  for (const [v, ls] of porVeh) {
    const { limpias } = sanearLecturas(ls);
    const m = new Map<string, number>();
    for (const d of recorridosDiarios(limpias, kmDiaMax)) {
      if (jornadaOdometroValida(d, kmDiaMax)) m.set(d.fecha, d.recorrido as number);
    }
    out.set(v, m);
  }
  return out;
}

const kmDiaMaxDe = (e: EntradaUso) => (e.kmDiaMax && e.kmDiaMax > 0 ? e.kmDiaMax : KM_DIA_MAX_DEFECTO);

/** ¿Este servicio pudo haber movido la unidad? Todo lo no cancelado menos lo que TODAVÍA no empieza
 *  (de hoy o después, sin iniciar). Lo de un día pasado sin cerrar sí: no se sabe si salió. */
const pudoCorrer = (r: any, hoy: string) => claseServicio(r, hoy) !== "programado";

/** Servicios propios no cancelados del periodo que pudieron correr, agrupados por unidad y día. */
function serviciosPorUnidadDia(rs: any[], hoy: string): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const r of rs) {
    const v = vehDe(r);
    if (v == null || !Number.isFinite(v)) continue;
    if (!pudoCorrer(r, hoy)) continue;
    const f = fechaDe(r);
    const k = `${v}|${f}`;
    const arr = m.get(k);
    if (arr) arr.push(r); else m.set(k, [r]);
  }
  return m;
}

/**
 * El km de cada unidad y día del periodo, con su fuente. Una jornada existe si ese día hubo jornada
 * VÁLIDA de odómetro (con o sin servicio) o algún servicio propio no cancelado que pudo correr (lo de
 * hoy que todavía no empieza no abre una jornada: no hay km que esperar de él).
 * El odómetro gana siempre; si no hay, se suman los km por GPS publicables de sus servicios.
 */
export function jornadasUso(e: EntradaUso): JornadaUso[] {
  const odo = jornadasOdometro(e.lecturas, kmDiaMaxDe(e));
  const srv = serviciosPorUnidadDia(reservasDelPeriodo(e), e.hoy);
  const claves = new Set<string>(srv.keys());
  for (const [v, m] of odo) for (const f of m.keys()) if (f >= e.desde && f <= e.hasta) claves.add(`${v}|${f}`);

  const out: JornadaUso[] = [];
  for (const k of claves) {
    const i = k.indexOf("|");
    const vehiculoId = Number(k.slice(0, i));
    const fecha = k.slice(i + 1);
    const rs = srv.get(k) ?? [];
    const reservas = rs.map(idDe);
    const kmOdo = odo.get(vehiculoId)?.get(fecha);
    if (kmOdo != null) {
      out.push({ vehiculoId, fecha, fuente: "odometro", km: kmOdo, conServicio: rs.length > 0, reservas });
      continue;
    }
    let nPub = 0, nTope = 0, suma = 0;
    for (const id of reservas) {
      const g = e.kmGpsPorReserva?.get(id);
      if (g && g.km != null && Number.isFinite(g.km)) { nPub++; suma += g.km; }
      else if (e.sinMedirPorTope?.has(id)) nTope++;
    }
    const fuente: FuenteKmDia =
      nTope > 0 ? "tope" : nPub === 0 ? "sin_dato" : nPub === reservas.length ? "gps" : "gps_parcial";
    out.push({ vehiculoId, fecha, fuente, km: nPub > 0 ? suma : null, conServicio: true, reservas });
  }
  out.sort((a, b) => (a.fecha !== b.fecha ? (a.fecha < b.fecha ? -1 : 1) : a.vehiculoId - b.vehiculoId));
  return out;
}

/**
 * Los servicios cuyo día y unidad NO tienen jornada de odómetro válida: los que hay que medir por GPS
 * para rellenar el km. Propios, no cancelados, del periodo y que pudieron correr. Los más recientes primero.
 */
export function diasPorRellenarConGps(e: EntradaUso): number[] {
  const odo = jornadasOdometro(e.lecturas, kmDiaMaxDe(e));
  const rs = reservasDelPeriodo(e)
    .filter((r) => {
      const v = vehDe(r);
      const f = fechaDe(r);
      return v != null && Number.isFinite(v) && pudoCorrer(r, e.hoy) && !odo.get(v)?.has(f);
    })
    .sort((a, b) => {
      const fa = fechaDe(a), fb = fechaDe(b);
      return fa !== fb ? (fa < fb ? 1 : -1) : idDe(a) - idDe(b);
    });
  return rs.map(idDe);
}

/** Las unidades de la flota de HOY sin ningún servicio no cancelado en el periodo (en el orden de la base). */
export function vehiculosSinServicio(e: EntradaUso): number[] {
  const conServicio = new Set<number>();
  for (const r of reservasDelPeriodo(e)) { const v = vehDe(r); if (v != null) conServicio.add(v); }
  return flotaDeHoy(e.propios).filter((p) => !conServicio.has(Number(p.id))).map((p) => Number(p.id));
}

/** La flota de HOY: propias con estado distinto de `inactivo` (la regla de ELIA). */
function flotaDeHoy(propios: PropiaUso[]): PropiaUso[] {
  return (propios ?? []).filter((p) => p && p.estado !== "inactivo");
}

// ─── COMBUSTIBLE ──────────────────────────────────────────────────────────────

/** El tipo del catálogo de una carga, SIN caer al diésel: un tipo que no se reconoce es desconocido. */
function tipoEstricto(t: string | null | undefined): string | null {
  const s = String(t ?? "").trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(COMBUSTIBLES, s)) return s;
  const n = normalizarTipoCombustible(t);
  return n && Object.prototype.hasOwnProperty.call(COMBUSTIBLES, n) ? n : null;
}

/** La unidad canónica de una familia (la del primer tipo del catálogo con esa familia). */
function unidadDeFamilia(familia: string): { unidad: "galones" | "litros" | "m3"; label: string } {
  const t = Object.keys(COMBUSTIBLES).find((k) => COMBUSTIBLES[k].familia === familia);
  const c = t ? COMBUSTIBLES[t] : COMBUSTIBLES.diesel;
  return { unidad: c.unidad, label: c.unidadLabel };
}

/** Una carga propia, ya juzgada: cuánto se gastó, cuánto en la unidad de su familia y cuánto CO₂. */
type CargaJuzgada = {
  fecha: string;
  vehiculoId: number;
  familia: string | null;
  aditivo: boolean;
  gasto: number | null;
  cantidad: number | null;
  co2: "estimado" | "sin_factor" | "sin_cantidad";
  kg: number | null;
};

const esPropia = (c: CargaUso) =>
  !!c && c.vehiculo_id != null && (c.vehiculo_tercero_id == null) && Number.isFinite(Number(c.vehiculo_id));

function juzgarCarga(c: CargaUso): CargaJuzgada {
  const tipo = tipoEstricto(c.tipo_combustible);
  const cfg = tipo ? COMBUSTIBLES[tipo] : null;
  const familia = cfg ? cfg.familia : null;
  const total = c.total == null || (c.total as unknown) === "" ? NaN : Number(c.total);
  const gasto = Number.isFinite(total) ? total : null;
  let cantidad: number | null = null;
  if (tipo && familia) {
    // Un gas se vende por m³ pase lo que pase (`unidadDeCarga`): una carga de GNV rotulada en galones
    // —el defecto viejo del Radar— son m³. Lo demás se convierte con la unidad declarada.
    const unidadFila = unidadDeCarga(tipo, c.unidad) === "m3" ? "m3" : c.unidad;
    cantidad = normalizarCantidad(c.galones, unidadFila, familia);
  }
  const co2 = familia ? co2DeCantidad(familia, cantidad) : { kg: null, codigo: "sin_factor" as const };
  return {
    fecha: String(c.fecha ?? "").slice(0, 10),
    vehiculoId: Number(c.vehiculo_id),
    familia,
    aditivo: !!cfg?.esAditivo,
    gasto,
    cantidad,
    co2: co2.codigo,
    kg: co2.kg,
  };
}

// ─── EL NÚCLEO ────────────────────────────────────────────────────────────────

type AcumUnidad = {
  servicios: number; prestados: number; dias: Set<string>;
  km: number; kmConocido: boolean; kmPiso: boolean; kmFuentes: Record<FuenteKmDia, number>;
  horasMin: number; sinHora: number;
  gasto: number; co2: number; co2Conocido: boolean; cargas: number;
  porFamilia: Map<string, number>;
};
const acumVacio = (): AcumUnidad => ({
  servicios: 0, prestados: 0, dias: new Set(),
  km: 0, kmConocido: false, kmPiso: false, kmFuentes: { odometro: 0, gps: 0, gps_parcial: 0, sin_dato: 0, tope: 0 },
  horasMin: 0, sinHora: 0,
  gasto: 0, co2: 0, co2Conocido: false, cargas: 0, porFamilia: new Map(),
});

/** El uso de flota del periodo. */
export function resumenUso(e: EntradaUso): ResumenUso {
  const dias = diasDelPeriodo(e.desde, e.hasta);
  const rs = reservasDelPeriodo(e);
  const porUnidad = new Map<number, AcumUnidad>();
  const acum = (v: number) => { let a = porUnidad.get(v); if (!a) { a = acumVacio(); porUnidad.set(v, a); } return a; };

  type AcumDia = {
    km: number; kmConocido: boolean; jornadas: number; kmPiso: boolean;
    servicios: number; horasMin: number; conHora: number; sinHora: number;
    gasto: number; conImporte: number; sinImporte: number;
    co2: number; conCo2: number; co2Falta: number;
  };
  const porDia = new Map<string, AcumDia>(dias.map((d) => [d, {
    km: 0, kmConocido: false, jornadas: 0, kmPiso: false,
    servicios: 0, horasMin: 0, conHora: 0, sinHora: 0,
    gasto: 0, conImporte: 0, sinImporte: 0, co2: 0, conCo2: 0, co2Falta: 0,
  }]));

  // ── Servicios y horas ──
  let prestados = 0, enCurso = 0, sinCerrar = 0, programados = 0, tercerizados = 0;
  let horasMin = 0, conHora = 0, sinHora = 0;
  for (const r of rs) {
    const f = fechaDe(r);
    const d = porDia.get(f);
    if (d) d.servicios++;
    const clase = claseServicio(r, e.hoy);
    if (clase === "prestado") prestados++;
    else if (clase === "en_curso") enCurso++;
    else if (clase === "sin_cerrar") sinCerrar++;
    else programados++;
    if (esTercerizado(r)) tercerizados++;

    const ps = e.paradasPorReserva?.get(idDe(r)) ?? [];
    const t = derivarTiempos({ reserva: r, paradas: ps, ahoraMs: e.ahoraMs, hoy: e.hoy });
    const v = vehDe(r);
    const a = v != null && Number.isFinite(v) ? acum(v) : null;
    if (a) {
      a.servicios++;
      if (clase === "prestado") a.prestados++;
      a.dias.add(f);
    }
    if (t.duracionMin != null && Number.isFinite(t.duracionMin)) {
      conHora++; horasMin += t.duracionMin;
      if (d) { d.conHora++; d.horasMin += t.duracionMin; }
      if (a) a.horasMin += t.duracionMin;
    } else if (contextoServicio(r, ps, { hoy: e.hoy, ahoraMs: e.ahoraMs }).terminado) {
      // Terminado y sin duración: se CUENTA, no se inventa.
      sinHora++;
      if (d) d.sinHora++;
      if (a) a.sinHora++;
    }
  }

  // ── Km ──
  const jornadas = jornadasUso(e);
  let kmOdo = 0, kmGps = 0, kmConocido = false;
  let jcs = 0, conOdo = 0, conGps = 0, sinDato = 0, tope = 0;
  for (const j of jornadas) {
    const a = acum(j.vehiculoId);
    const d = porDia.get(j.fecha);
    a.kmFuentes[j.fuente]++;
    if (j.km != null) {
      a.km += j.km; a.kmConocido = true;
      kmConocido = true;
      if (j.fuente === "odometro") kmOdo += j.km; else kmGps += j.km;
      if (d) { d.km += j.km; d.kmConocido = true; }
    }
    if (d) d.jornadas++;
    if (j.conServicio) {
      jcs++;
      if (j.fuente === "odometro") conOdo++;
      else {
        if (j.fuente === "gps" || j.fuente === "gps_parcial") conGps++;
        else if (j.fuente === "sin_dato") sinDato++;
        else tope++;
        a.kmPiso = true;
        if (d) d.kmPiso = true;
      }
    }
  }
  const esPiso = conGps + sinDato + tope > 0;

  // ── Combustible ──
  const comb: CombustibleUso = {
    leido: e.cargas != null, gasto: null, co2Kg: null,
    cargas: 0, cargasConCo2: 0, cargasSinFactor: 0, cargasAditivo: 0, cargasSinCantidad: 0, cargasSinImporte: 0,
    porFamilia: [], sinFamilia: { cargas: 0, gasto: 0 },
  };
  if (e.cargas != null) {
    let gasto = 0, co2 = 0, co2Falta = 0;
    const fam = new Map<string, FamiliaUso & { co2Conocido: boolean }>();
    for (const c of e.cargas) {
      if (!esPropia(c) || !enRango(c.fecha, e.desde, e.hasta)) continue;
      const j = juzgarCarga(c);
      const d = porDia.get(j.fecha);
      const a = acum(j.vehiculoId);
      comb.cargas++; a.cargas++;
      if (j.gasto != null) {
        gasto += j.gasto; a.gasto += j.gasto;
        if (d) { d.gasto += j.gasto; d.conImporte++; }
      } else {
        comb.cargasSinImporte++;
        if (d) d.sinImporte++;
      }
      if (j.co2 === "estimado" && j.kg != null) {
        comb.cargasConCo2++; co2 += j.kg; a.co2 += j.kg; a.co2Conocido = true;
        if (d) { d.co2 += j.kg; d.conCo2++; }
      } else if (j.co2 === "sin_factor") {
        comb.cargasSinFactor++;
        if (j.aditivo) comb.cargasAditivo++;
        // La urea no se quema: no deja el CO₂ del día «sin dato». Un tipo desconocido o el biodiésel sí.
        else { co2Falta++; if (d) d.co2Falta++; }
      } else {
        comb.cargasSinCantidad++;
        co2Falta++;
        if (d) d.co2Falta++;
      }
      if (j.familia) {
        let fu = fam.get(j.familia);
        if (!fu) {
          const u = unidadDeFamilia(j.familia);
          fu = { familia: j.familia, unidad: u.unidad, unidadLabel: u.label, cantidad: 0, cargasSinCantidad: 0, gasto: 0, co2Kg: null, cargas: 0, co2Conocido: false };
          fam.set(j.familia, fu);
        }
        fu.cargas++;
        if (j.gasto != null) fu.gasto += j.gasto;
        if (j.cantidad != null) {
          fu.cantidad += j.cantidad;
          a.porFamilia.set(j.familia, (a.porFamilia.get(j.familia) ?? 0) + j.cantidad);
        } else fu.cargasSinCantidad++;
        if (j.co2 === "estimado" && j.kg != null) { fu.co2Kg = (fu.co2Kg ?? 0) + j.kg; fu.co2Conocido = true; }
      } else {
        comb.sinFamilia.cargas++;
        if (j.gasto != null) comb.sinFamilia.gasto += j.gasto;
      }
    }
    comb.gasto = comb.cargas > 0 && comb.cargasSinImporte === comb.cargas ? null : gasto;
    comb.co2Kg = comb.cargasConCo2 === 0 && co2Falta > 0 ? null : co2;
    comb.porFamilia = [...fam.values()]
      .sort((x, y) => y.gasto - x.gasto || (x.familia < y.familia ? -1 : 1))
      .map(({ co2Conocido: _c, ...f }) => { void _c; return f; });
  }

  // ── Unidades ──
  const flota = flotaDeHoy(e.propios);
  const enFlota = new Set(flota.map((p) => Number(p.id)));
  const activas = flota.filter((p) => (porUnidad.get(Number(p.id))?.servicios ?? 0) > 0);
  const sinUso: SinUso[] = flota
    .filter((p) => (porUnidad.get(Number(p.id))?.servicios ?? 0) === 0)
    .map((p) => {
      const leido = !!e.ultimoServicio && e.ultimoServicio.has(Number(p.id));
      return {
        vehiculoId: Number(p.id),
        placa: p.placa,
        estado: p.estado ?? null,
        categoria: p.categoria ?? null,
        motivo: p.estado === "mantenimiento" ? "en_mantenimiento" : "sin_servicio",
        ultimoServicio: leido ? (e.ultimoServicio!.get(Number(p.id)) ?? null) : null,
        ultimoServicioLeido: leido,
      };
    });

  // ── Por unidad: la flota de hoy, y cualquier otra propia con actividad en el periodo ──
  const fichas = new Map<number, PropiaUso>((e.propios ?? []).map((p) => [Number(p.id), p]));
  const idsUnidad: number[] = [];
  for (const p of e.propios ?? []) {
    const id = Number(p.id);
    if (enFlota.has(id) || porUnidad.has(id)) idsUnidad.push(id);
  }
  for (const id of porUnidad.keys()) if (!fichas.has(id)) idsUnidad.push(id);
  const unidadesUso: UnidadUso[] = idsUnidad.map((id) => {
    const a = porUnidad.get(id) ?? acumVacio();
    const p = fichas.get(id);
    return {
      vehiculoId: id,
      placa: p?.placa ?? `#${id}`,
      categoria: p?.categoria ?? null,
      estado: p?.estado ?? null,
      enFlota: enFlota.has(id),
      servicios: a.servicios,
      prestados: a.prestados,
      diasActivos: a.dias.size,
      km: a.kmConocido ? a.km : null,
      kmPiso: a.kmPiso,
      kmFuentes: { ...a.kmFuentes },
      horas: a.horasMin / 60,
      serviciosSinHora: a.sinHora,
      gasto: a.gasto,
      co2Kg: a.co2Conocido ? a.co2 : null,
      cargas: a.cargas,
      porFamilia: [...a.porFamilia.entries()].map(([familia, cantidad]) => ({ familia, unidadLabel: unidadDeFamilia(familia).label, cantidad })),
    };
  });

  // ── Serie diaria ──
  const serie: DiaSerieUso[] = dias.map((fecha) => {
    const d = porDia.get(fecha)!;
    return {
      fecha,
      km: d.jornadas > 0 && !d.kmConocido ? null : d.km,
      kmPiso: d.kmPiso,
      servicios: d.servicios,
      horas: d.sinHora > 0 && d.conHora === 0 ? null : d.horasMin / 60,
      gasto: e.cargas == null ? null : d.sinImporte > 0 && d.conImporte === 0 ? null : d.gasto,
      co2: e.cargas == null ? null : d.co2Falta > 0 && d.conCo2 === 0 ? null : d.co2,
    };
  });

  const noCancelados = rs.length;
  return {
    periodo: { desde: e.desde, hasta: e.hasta, dias: dias.length },
    km: {
      total: jcs > 0 && !kmConocido ? null : kmOdo + kmGps,
      odometro: kmOdo,
      gps: kmGps,
      esPiso,
      cobertura: { jornadasConServicio: jcs, conOdometro: conOdo, conGps, sinDato, tope, pct: jcs > 0 ? (conOdo / jcs) * 100 : null },
    },
    servicios: {
      noCancelados, prestados, enCurso, sinCerrar, programados, tercerizados,
      pctTercerizado: noCancelados > 0 ? (tercerizados / noCancelados) * 100 : null,
    },
    horas: { total: sinHora > 0 && conHora === 0 ? null : horasMin / 60, totalMin: horasMin, conHora, sinHora },
    unidades: { flota: flota.length, activas: activas.length, activasIds: activas.map((p) => Number(p.id)), sinUso },
    combustible: comb,
    porUnidad: unidadesUso,
    serie,
  };
}

// ─── COMPARACIÓN ──────────────────────────────────────────────────────────────

export type MetricaUso =
  | "km" | "servicios" | "horas" | "unidadesActivas" | "unidadesSinUso" | "gastoCombustible" | "co2" | "pctTercerizado";

export const METRICAS_USO: readonly MetricaUso[] = [
  "km", "servicios", "horas", "unidadesActivas", "unidadesSinUso", "gastoCombustible", "co2", "pctTercerizado",
];

/**
 * Qué significa que cada métrica SUBA. Más km, servicios, horas, gasto y CO₂ es más TRABAJO: neutro
 * (pintarlo de rojo castigaría una semana con más demanda). Más unidades sin uso es la anomalía; y
 * menos unidades activas es la misma anomalía vista desde el otro lado (las dos cuentan la misma flota
 * de hoy). El % tercerizado es una decisión comercial, no un error: neutro.
 */
export const SENTIDO_METRICA: Record<MetricaUso, SentidoVariacion> = {
  km: "neutro",
  servicios: "neutro",
  horas: "neutro",
  unidadesActivas: "bajar_malo",
  unidadesSinUso: "subir_malo",
  gastoCombustible: "neutro",
  co2: "neutro",
  pctTercerizado: "neutro",
};

/** El valor de una métrica en un resumen (null = sin dato). */
export function valorMetrica(r: ResumenUso, m: MetricaUso): number | null {
  switch (m) {
    case "km": return r.km.total;
    case "servicios": return r.servicios.noCancelados;
    case "horas": return r.horas.total;
    case "unidadesActivas": return r.unidades.activas;
    case "unidadesSinUso": return r.unidades.sinUso.length;
    case "gastoCombustible": return r.combustible.gasto;
    case "co2": return r.combustible.co2Kg;
    case "pctTercerizado": return r.servicios.pctTercerizado;
  }
}

/** ¿El valor de la métrica es un mínimo en ese resumen? (el km con alguna jornada sin odómetro) */
function esPisoMetrica(r: ResumenUso, m: MetricaUso): boolean {
  return m === "km" ? r.km.esPiso : false;
}

export type VariacionUso = {
  actual: number | null;
  previa: number | null;
  /** `variacionPct` de lib/rendimiento.ts: null sin base (previa 0 o sin dato) */
  pct: number | null;
  /** actual − previa (en la unidad de la métrica; en % tercerizado, puntos) */
  diferencia: number | null;
  sentido: SentidoVariacion;
  tono: TonoVariacion;
  /** alguno de los dos valores es un mínimo («≥») */
  piso: boolean;
};

export type CodigoAvisoUso =
  | "sin_actividad_previa"
  | "cobertura_odometro_cambio"
  | "km_es_piso"
  | "combustible_no_leido";

export type AvisoUso = { codigo: CodigoAvisoUso; texto: string };

export type ComparacionUso = {
  variaciones: Record<MetricaUso, VariacionUso>;
  /** false = el periodo anterior no tiene ninguna actividad con que comparar */
  comparable: boolean;
  /** los avisos en una frase (null si no hay) */
  motivo: string | null;
  avisos: AvisoUso[];
};

const fmtPct = (n: number) => `${Math.round(n)} %`;

/** Compara un periodo con el anterior, métrica por métrica, y avisa de lo que hace engañosa la variación. */
export function compararUso(a: ResumenUso, p: ResumenUso): ComparacionUso {
  const variaciones = {} as Record<MetricaUso, VariacionUso>;
  for (const m of METRICAS_USO) {
    const actual = valorMetrica(a, m);
    const previa = valorMetrica(p, m);
    const pct = variacionPct(actual, previa);
    variaciones[m] = {
      actual, previa, pct,
      diferencia: actual != null && previa != null ? actual - previa : null,
      sentido: SENTIDO_METRICA[m],
      tono: tonoVariacion(pct, SENTIDO_METRICA[m]),
      piso: esPisoMetrica(a, m) || esPisoMetrica(p, m),
    };
  }

  const avisos: AvisoUso[] = [];
  const sinActividad = (r: ResumenUso) =>
    r.servicios.noCancelados === 0 && (r.km.total ?? 0) === 0 && r.km.cobertura.jornadasConServicio === 0
    && (r.combustible.cargas ?? 0) === 0;
  const comparable = !sinActividad(p);
  if (!comparable) {
    avisos.push({ codigo: "sin_actividad_previa", texto: `El periodo anterior (${p.periodo.desde} al ${p.periodo.hasta}) no tiene servicios, km ni cargas: no hay con qué comparar.` });
  }
  const ca = a.km.cobertura.pct, cp = p.km.cobertura.pct;
  if (ca != null && cp != null && Math.abs(ca - cp) >= UMBRAL_CAMBIO_COBERTURA_PTS) {
    avisos.push({
      codigo: "cobertura_odometro_cambio",
      texto: `La cobertura del odómetro pasó de ${fmtPct(cp)} a ${fmtPct(ca)} de las jornadas con servicio: la variación del km puede ser de registro, no de trabajo.`,
    });
  }
  if (a.km.esPiso || p.km.esPiso) {
    avisos.push({ codigo: "km_es_piso", texto: "El km de al menos un periodo es un mínimo (días sin jornada de odómetro): compara pisos, no totales." });
  }
  if (!a.combustible.leido || !p.combustible.leido) {
    avisos.push({ codigo: "combustible_no_leido", texto: "No se pudieron leer las cargas de combustible: el gasto y el CO₂ no se comparan." });
  }
  return { variaciones, comparable, motivo: avisos.length ? avisos.map((x) => x.texto).join(" ") : null, avisos };
}

// ─── ELIA ─────────────────────────────────────────────────────────────────────

/**
 * La respuesta de la herramienta `utilizacion_flota` de ELIA, desde este motor. MISMAS claves en
 * `paraModelo` y mismos bloques `ui` que la versión que vivía en lib/elia/herramientas.ts; lo único
 * que cambia a propósito es `km_recorridos`, que pasa de `max − min` de las lecturas aceptadas a la
 * suma de las jornadas saneadas (más las de GPS si se rellenó). `por_unidad` sigue listando TODAS las
 * propias (también las inactivas), en el orden de la base y por servicios.
 */
export function utilizacionParaElia(e: EntradaUso): { paraModelo: string; ui?: BloqueUI[] } {
  const r = resumenUso(e);
  const inicio = e.desde;
  const hoy = e.hasta;
  if (r.servicios.noCancelados === 0)
    return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios en el rango." }) };

  const filasLen = r.servicios.noCancelados;
  const tercerizados = r.servicios.tercerizados;
  const pctTerceros = Math.round((tercerizados / filasLen) * 100);
  const uso = new Map<number, UnidadUso>(r.porUnidad.map((u) => [u.vehiculoId, u]));

  const porUnidad = (e.propios ?? [])
    .map((v) => {
      const u = uso.get(Number(v.id));
      return {
        placa: v.placa,
        categoria: v.categoria,
        estado: v.estado,
        servicios: u?.servicios || 0,
        dias_activos: u?.diasActivos || 0,
        km_recorridos: u && u.km != null ? Math.round(u.km * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.servicios - a.servicios);
  const ociosas = porUnidad.filter((u) => u.servicios === 0 && u.estado !== "inactivo");

  return {
    paraModelo: JSON.stringify({
      desde: inicio,
      hasta: hoy,
      servicios_totales: filasLen,
      tercerizados,
      pct_tercerizado: pctTerceros,
      por_unidad: porUnidad,
      unidades_sin_uso: ociosas.map((u) => u.placa),
    }),
    ui: [
      {
        tipo: "kpis",
        items: [
          { label: "Servicios", valor: String(filasLen), sub: `desde ${inicio}`, intent: "info" },
          { label: "Tercerizados", valor: `${pctTerceros}%`, sub: `${tercerizados} servicios`, intent: pctTerceros > 40 ? "warn" : "ok" },
          { label: "Unidades sin uso", valor: String(ociosas.length), sub: ociosas.slice(0, 3).map((u) => u.placa).join(", ") || undefined, intent: ociosas.length ? "warn" : "ok" },
        ],
      },
      {
        tipo: "ranking",
        titulo: "Unidades más utilizadas",
        items: porUnidad.slice(0, 5).map((u, i) => ({
          puesto: i + 1,
          nombre: u.placa,
          valor: `${u.servicios} serv.`,
          sub: `${u.dias_activos} días activos${u.km_recorridos ? ` · ${u.km_recorridos.toLocaleString("es-PE")} km` : ""}`,
        })),
      },
    ],
  };
}

// ─── LA RESPUESTA DE /api/flota/uso ──────────────────────────────────────────

export type RellenoUso = {
  /** MAX_TRAZAS_RELLENO */
  maxTrazas: number;
  /** servicios sin jornada de odómetro (los dos periodos) */
  candidatos: number;
  /** trazas leídas */
  medidas: number;
  /** no se midieron por el tope o por el presupuesto de tiempo */
  sinMedirPorTope: number;
  /** se intentaron leer y la lectura falló (salen `sin_medir`, nunca 0) */
  noLeidas: number;
  /** el corte fue por tiempo, no por cantidad */
  porTiempo: boolean;
};

export type RespuestaUso = {
  ok: true;
  desde: string;
  hasta: string;
  hoy: string;
  /** el periodo con que se compara: mismo largo, contiguo */
  anteriorDesde: string;
  anteriorHasta: string;
  medidoEn: string;
  actual: ResumenUso;
  anterior: ResumenUso;
  comparacion: ComparacionUso;
  relleno: RellenoUso;
  constantes: ConstanteUso[];
  /** declaraciones fijas que la pantalla debe enseñar */
  notas: string[];
};

export type CodigoErrorUso =
  | "fecha_invalida" | "rango_invertido" | "rango_largo" | "futuro" | "cola_llena" | "lectura_fallida";

export type ErrorUso = { ok: false; codigo: CodigoErrorUso; error: string; reintentar?: boolean };

/** Las declaraciones que acompañan a toda respuesta. Viven aquí para no redactarlas en la pantalla. */
export const NOTAS_USO: readonly string[] = [
  "La flota es la de HOY: las unidades propias cuyo estado actual no es «inactivo». No hay historial de altas y bajas.",
  "El km sale del odómetro (jornadas completas y saneadas); donde no hay jornada, de los servicios medidos por GPS, que solo pueden quedarse cortos: por eso el total se marca «≥».",
  "El CO₂ es de lo COMPRADO (cargas propias de combustible × factor EPA, solo CO₂). No tiene por qué cuadrar con la suma del CO₂ estimado por servicio, que no cuenta el km en vacío.",
  "Las horas salen de la evidencia del conductor; un servicio terminado sin hora se cuenta aparte y no suma.",
];
