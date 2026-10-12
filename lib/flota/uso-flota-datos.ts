// lib/flota/uso-flota-datos.ts — SOLO SERVIDOR. Lee lo que mide lib/flota/uso-flota.ts (puro).
//
// Dos clientes: `/api/flota/uso` (dos periodos contiguos, con relleno por GPS y horas) y la
// herramienta `utilizacion_flota` de ELIA (un periodo de hasta 12 meses, sin GPS ni horas: no las
// publica). Los dos arman la entrada por AQUÍ, para que el uso de flota de la pantalla y el de ELIA
// salgan del mismo motor con las mismas filas.
//
// REGLAS DE LECTURA (las del ERP):
//   · PostgREST corta en 1000 filas: todo se pide paginado con ORDEN TOTAL (fecha + id).
//   · Una lectura que falla LANZA: una lista cortada mediría de menos y se leería como «no hubo».
//     La única excepción son las cargas de combustible, que degradan a «no se pudieron leer»
//     (`cargas: null`): el gasto y el CO₂ salen sin dato, el resto del uso sigue sirviendo.
//   · Una columna de una migración accesoria se SUELTA solo si el error la nombra
//     (lib/columna-faltante.ts) y se relee desde cero; ante otro error no se reintenta.
//   · El relleno por GPS reutiliza la medición de la torre (`medirServicio` con `conHuella`,
//     lib/gps-cobertura-datos.ts) + `resumenDeFilas` + `kmPublicable`: el km de un servicio es el
//     mismo número que la Auditoría de km y la estadística por servicio.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados */
import { createClient } from "@supabase/supabase-js";
import { faltaAlguna } from "../columna-faltante";
import { paradasDeReservas, medirServicio } from "../gps-cobertura-datos";
import { contextoServicio } from "../gps-cobertura";
import { resumenDeFilas } from "../huella";
import { sumarDias } from "../odometro-analitica";
import { kmPublicable, type KmGps } from "./km-gps";
import {
  resumenUso, compararUso, periodoAnterior, diasPorRellenarConGps, vehiculosSinServicio, constantesUso,
  MAX_TRAZAS_RELLENO, DIAS_ANCLA_LECTURAS, NOTAS_USO,
  type EntradaUso, type PropiaUso, type CargaUso, type RespuestaUso, type RellenoUso,
} from "./uso-flota";
import type { LecturaCruda } from "../odometro-analitica";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Presupuesto de tiempo del relleno por GPS dentro de una petición. OPERATIVO, no medido: lo que no
 *  alcanza a medirse sale `tope`, nunca 0 (la ruta tiene maxDuration 60). */
export const PRESUPUESTO_RELLENO_MS = 30_000;
/** Trazas leídas en paralelo (el mismo LOTE que la torre). */
const LOTE_TRAZAS = 8;
/** Techo de sanidad de filas por consulta (no operativo). */
const MAX_FILAS = 200_000;

/** Un error de lectura con el nombre de la tabla, para el mensaje de la ruta. */
export class LecturaFallida extends Error {
  constructor(public tabla: string, detalle: string) {
    super(`${tabla}: ${detalle}`);
    this.name = "LecturaFallida";
  }
}

/**
 * Lee TODAS las filas de una consulta, paginando con el orden que trae `armar`. Si el error nombra una
 * de las columnas `opcionales`, la suelta y relee desde cero; ante cualquier otro error, LANZA.
 */
async function leerTodas(
  tabla: string,
  base: string[],
  opcionales: string[],
  armar: (select: string) => any,
): Promise<any[]> {
  const pedidas = [...opcionales];
  for (let intento = 0; intento <= opcionales.length; intento++) {
    const select = [...base, ...pedidas].join(", ");
    const out: any[] = [];
    let soltada: string | null = null;
    for (let off = 0; off < MAX_FILAS; off += 1000) {
      const { data, error } = await armar(select).range(off, off + 999);
      if (error) {
        const col = faltaAlguna(error, pedidas);
        if (col) { soltada = col; break; }
        throw new LecturaFallida(tabla, String(error.message ?? error));
      }
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (!soltada) return out;
    pedidas.splice(pedidas.indexOf(soltada), 1);
  }
  throw new LecturaFallida(tabla, "no se pudo leer ni soltando las columnas opcionales");
}

// Columnas de las reservas que miden el servicio (lib/servicio-tiempos.ts y lib/gps-cobertura.ts).
// Las cuatro de supabase/servicio-horas-reales.sql son accesorias: sin ellas se recompone la hora.
const COLS_RESERVA = [
  "id", "fecha_servicio", "hora_servicio", "estado", "vehiculo_id", "vehiculo_tercero_id", "tipo_asignacion",
  "hora_real_inicio", "hora_real_fin",
];
const COLS_RESERVA_OPC = ["inicio_real_ts", "fin_real_ts", "inicio_real_fuente", "fin_real_fuente"];

/** Las unidades propias de HOY (también las inactivas: tienen historia), en el orden de la base. */
export async function leerPropias(): Promise<PropiaUso[]> {
  const filas = await leerTodas("vehiculos", ["id", "placa", "categoria", "estado"], [],
    (sel) => admin.from("vehiculos").select(sel).order("id", { ascending: true }));
  return filas.map((v) => ({ id: Number(v.id), placa: String(v.placa ?? `#${v.id}`), estado: v.estado ?? null, categoria: v.categoria ?? null }));
}

/** Las reservas NO canceladas de [desde, hasta] (la definición de ELIA y de la torre). */
export async function leerReservas(desde: string, hasta: string): Promise<any[]> {
  return leerTodas("reservas", COLS_RESERVA, COLS_RESERVA_OPC,
    (sel) => admin.from("reservas").select(sel)
      .gte("fecha_servicio", desde).lte("fecha_servicio", hasta).neq("estado", "cancelada")
      .order("fecha_servicio", { ascending: true }).order("id", { ascending: true }));
}

/**
 * Las lecturas de odómetro PROPIAS de [desde, hasta] que el saneo puede conservar (aceptadas y
 * reinicios de tablero: las demás las descarta `sanearLecturas` fila por fila, así que pedirlas no
 * cambia el resultado). Con las columnas que pide `sanearLecturas`; `capturado_en` es accesoria.
 */
export async function leerLecturasPropias(desde: string, hasta: string): Promise<LecturaCruda[]> {
  const filas = await leerTodas("lecturas_odometro",
    ["id", "vehiculo_id", "vehiculo_tercero_id", "km", "fuente", "fecha", "estado", "motivo", "created_at", "momento"],
    ["capturado_en"],
    (sel) => admin.from("lecturas_odometro").select(sel)
      .not("vehiculo_id", "is", null).in("estado", ["aceptada", "reinicio"])
      .gte("fecha", desde).lte("fecha", hasta)
      .order("fecha", { ascending: true }).order("id", { ascending: true }));
  return filas
    .filter((l) => l.vehiculo_tercero_id == null)
    .map((l) => ({ ...l, id: String(l.id), km: Number(l.km) }) as LecturaCruda);
}

/** Las cargas propias de [desde, hasta]; null si no se pudieron leer (la sección sale sin dato). */
export async function leerCargasPropias(desde: string, hasta: string): Promise<CargaUso[] | null> {
  try {
    const filas = await leerTodas("combustible",
      ["id", "fecha", "vehiculo_id", "tipo_combustible", "galones", "total"],
      ["vehiculo_tercero_id", "unidad"],
      (sel) => admin.from("combustible").select(sel)
        .not("vehiculo_id", "is", null).gte("fecha", desde).lte("fecha", hasta)
        .order("fecha", { ascending: true }).order("id", { ascending: true }));
    return filas.map((c) => ({
      fecha: String(c.fecha ?? "").slice(0, 10),
      vehiculo_id: c.vehiculo_id == null ? null : Number(c.vehiculo_id),
      vehiculo_tercero_id: c.vehiculo_tercero_id == null ? null : Number(c.vehiculo_tercero_id),
      tipo_combustible: c.tipo_combustible ?? null,
      galones: c.galones == null ? null : Number(c.galones),
      unidad: c.unidad ?? null,
      total: c.total == null ? null : Number(c.total),
    }));
  } catch (e: any) {
    console.error("[uso-flota] cargas de combustible:", e?.message);
    return null;
  }
}

/** El tope de km por día de la configuración; el defecto del motor si no se puede leer. */
export async function leerKmDiaMax(): Promise<number | undefined> {
  try {
    const { data, error } = await admin.from("config_mantenimiento").select("km_dia_max").eq("id", 1).maybeSingle();
    if (error) return undefined;
    const n = Number((data as any)?.km_dia_max);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/**
 * El último servicio no cancelado hasta `hasta` de cada unidad. Clave ausente = no se pudo leer (la
 * pantalla dice «no se pudo leer», no «nunca»); null = ninguno registrado.
 */
export async function ultimosServicios(ids: number[], hasta: string): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  await Promise.all(ids.map(async (id) => {
    const { data, error } = await admin.from("reservas").select("fecha_servicio")
      .eq("vehiculo_id", id).neq("estado", "cancelada").lte("fecha_servicio", hasta)
      .order("fecha_servicio", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (error) return;
    const f = (data as any[])?.[0]?.fecha_servicio;
    out.set(id, f ? String(f).slice(0, 10) : null);
  }));
  return out;
}

/**
 * Mide por GPS, en orden, los servicios `candidatos` hasta MAX_TRAZAS_RELLENO trazas o
 * PRESUPUESTO_RELLENO_MS. Un servicio que no corrió no gasta cupo (`medirServicio` no lee su traza).
 * Lo que no se alcanza a medir va a `sinMedirPorTope`: la jornada sale `tope`, nunca 0.
 */
async function rellenarConGps(
  candidatos: number[],
  reservaPorId: Map<number, any>,
  paradas: Map<number, any[]>,
  hoy: string,
  ahoraMs: number,
): Promise<{ km: Map<number, KmGps>; tope: Set<number>; relleno: RellenoUso }> {
  const km = new Map<number, KmGps>();
  const tope = new Set<number>();
  const relleno: RellenoUso = { maxTrazas: MAX_TRAZAS_RELLENO, candidatos: candidatos.length, medidas: 0, sinMedirPorTope: 0, noLeidas: 0, porTiempo: false };
  const t0 = Date.now();
  const aMedir: number[] = [];
  for (const id of candidatos) {
    const r = reservaPorId.get(id);
    if (!r) continue;
    const ps = paradas.get(id) ?? [];
    if (!contextoServicio(r, ps, { hoy, ahoraMs }).aplica) {
      // No corrió: su veredicto es `no_aplica` sin leer GPS, y no gasta cupo.
      const s = await medirServicio(r, ps, { hoy, ahoraMs });
      km.set(id, kmPublicable(s.veredicto, null, 0));
      continue;
    }
    if (aMedir.length >= MAX_TRAZAS_RELLENO) { tope.add(id); continue; }
    aMedir.push(id);
  }
  for (let i = 0; i < aMedir.length; i += LOTE_TRAZAS) {
    if (Date.now() - t0 > PRESUPUESTO_RELLENO_MS) {
      for (const id of aMedir.slice(i)) tope.add(id);
      relleno.porTiempo = true;
      break;
    }
    await Promise.all(aMedir.slice(i, i + LOTE_TRAZAS).map(async (id) => {
      const r = reservaPorId.get(id);
      const s = await medirServicio(r, paradas.get(id) ?? [], { hoy, ahoraMs, conHuella: true });
      // La traza se suelta aquí: solo queda el km.
      const resumen = s.traza?.crudas ? resumenDeFilas(s.traza.crudas) : null;
      km.set(id, kmPublicable(s.veredicto, resumen, s.traza?.simulados ?? 0));
      relleno.medidas++;
      if (!s.traza) relleno.noLeidas++;
    }));
  }
  relleno.sinMedirPorTope = tope.size;
  return { km, tope, relleno };
}

/** El uso de flota de [desde, hasta] y del periodo anterior del mismo largo, con su comparación. */
export async function calcularUso(desde: string, hasta: string, hoy: string, ahoraMs: number): Promise<RespuestaUso> {
  const ant = periodoAnterior(desde, hasta);
  // Lecturas con contexto alrededor de los dos periodos (nunca después de hoy).
  const lecDesde = sumarDias(ant.desde, -DIAS_ANCLA_LECTURAS);
  const lecHasta = [sumarDias(hasta, DIAS_ANCLA_LECTURAS), hoy].sort()[0];
  const [propios, reservas, lecturas, cargas, kmDiaMax] = await Promise.all([
    leerPropias(),
    leerReservas(ant.desde, hasta),
    leerLecturasPropias(lecDesde, lecHasta),
    leerCargasPropias(ant.desde, hasta),
    leerKmDiaMax(),
  ]);
  const reservaPorId = new Map<number, any>(reservas.map((r) => [Number(r.id), r]));
  // Paradas de lo que pudo correr (para las horas y el relleno); lo futuro no las necesita.
  const paradas = await paradasDeReservas(reservas.filter((r) => String(r.fecha_servicio).slice(0, 10) <= hoy).map((r) => Number(r.id)));

  const base = {
    hoy, ahoraMs, propios, reservas, lecturas, paradasPorReserva: paradas, cargas, kmDiaMax,
    kmGpsPorReserva: new Map<number, KmGps>(), sinMedirPorTope: new Set<number>(),
  };
  const eA: EntradaUso = { ...base, desde, hasta };
  const eP: EntradaUso = { ...base, desde: ant.desde, hasta: ant.hasta };

  // Relleno: primero el periodo pedido (los más recientes primero), después el anterior.
  const vistos = new Set<number>();
  const candidatos = [...diasPorRellenarConGps(eA), ...diasPorRellenarConGps(eP)].filter((id) => !vistos.has(id) && vistos.add(id));
  const gps = await rellenarConGps(candidatos, reservaPorId, paradas, hoy, ahoraMs);
  eA.kmGpsPorReserva = gps.km; eP.kmGpsPorReserva = gps.km;
  eA.sinMedirPorTope = gps.tope; eP.sinMedirPorTope = gps.tope;

  const [ultA, ultP] = await Promise.all([
    ultimosServicios(vehiculosSinServicio(eA), hasta),
    ultimosServicios(vehiculosSinServicio(eP), ant.hasta),
  ]);
  eA.ultimoServicio = ultA; eP.ultimoServicio = ultP;

  const actual = resumenUso(eA);
  const anterior = resumenUso(eP);
  return {
    ok: true,
    desde, hasta, hoy,
    anteriorDesde: ant.desde, anteriorHasta: ant.hasta,
    medidoEn: new Date(ahoraMs).toISOString(),
    actual, anterior,
    comparacion: compararUso(actual, anterior),
    relleno: gps.relleno,
    constantes: constantesUso(kmDiaMax),
    notas: [...NOTAS_USO],
  };
}

/**
 * La entrada de la herramienta `utilizacion_flota` de ELIA: [desde, hasta] sin relleno por GPS, sin
 * paradas y sin cargas (ELIA no publica horas ni combustible aquí). Las lecturas llevan
 * DIAS_ANCLA_LECTURAS de contexto antes del periodo.
 */
export async function entradaUsoParaElia(desde: string, hasta: string, hoy: string, ahoraMs: number): Promise<EntradaUso> {
  const [propios, reservas, lecturas, kmDiaMax] = await Promise.all([
    leerPropias(),
    leerReservas(desde, hasta),
    leerLecturasPropias(sumarDias(desde, -DIAS_ANCLA_LECTURAS), hoy),
    leerKmDiaMax(),
  ]);
  return {
    desde, hasta, hoy, ahoraMs, propios, reservas, lecturas, kmDiaMax,
    paradasPorReserva: new Map(), kmGpsPorReserva: new Map(), sinMedirPorTope: new Set(), cargas: null,
  };
}
