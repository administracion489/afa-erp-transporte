// lib/gps-diagnostico-datos.ts — SOLO SERVIDOR (service-role). Lee lo que juzga lib/gps-diagnostico.ts
// (puro) para el modal de diagnóstico del rastreo de /seguimiento: ¿es su teléfono, o le falta
// configurar algo?
//
// ── EL MISMO NÚMERO QUE LA CELDA ───────────────────────────────────────────────────────
// El modal se abre al hacer clic en el % de la celda RASTREO, así que tiene que enseñar ESE %. Por eso
// no mide nada por su cuenta: lee la reserva (`*`), las paradas por `paradasDeReservas` y la traza por
// `trazaDe` —los mismos lectores de `rastreoDelDia`— y juzga con `contextoServicio` +
// `veredictoDeServicio`, las mismas dos funciones. Dos reglas de la torre que se repiten aquí para
// que el número coincida también en los bordes: una reserva CANCELADA no se mide (la torre ni la
// lee), y una que `rastreoDelDia` dejó fuera de su techo diario sale `sin_medir`, como su celda.
// La única diferencia es que aquí la traza se pide CON SUS FILAS (`conFilas`): la hora de recepción,
// el fix real y el conductor de cada punto, que son la evidencia del PORQUÉ. La medición sigue
// saliendo solo de los puntos útiles, así que el % no cambia por pedirlas.
//
// ── DE QUIÉN ES EL TELÉFONO ───────────────────────────────────────────────────────────
// Del conductor que generó la traza (identidad mayoritaria de sus filas, que el servidor fuerza con
// el token); si no hay traza, del que figura en la reserva. Sus reportes de `gps_equipo_reportes` se
// leen por la reserva Y por la ventana del servicio (más las 24 h previas), y se quedan solo los de
// ese conductor: el teléfono de otro chofer no explica el corte de este.
//
// ── SIN LA MIGRACIÓN, NADA SE CAE ────────────────────────────────────────────────────
// Sin `gps_equipo_reportes` (supabase/gps-equipo-01.sql sin correr) el diagnóstico sale igual, sin
// estado del teléfono y con `migraciones.faltaTabla`; sin `recibido_en`, sin llegadas tardías y con
// `migraciones.faltaRecibido`. Cualquier OTRO error lanza: una lectura que falla no es una lista
// vacía, y «el teléfono no reportó» dicho por un fallo de red acusaría sin evidencia.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados: las filas de reservas llegan como `any` */
import { createClient } from "@supabase/supabase-js";
import {
  contextoServicio, veredictoDeServicio,
  type ContextoServicio, type MedicionCobertura, type TrazaSaneada, type VeredictoRastreo,
} from "./gps-cobertura";
import {
  trazaDe, todas, paradasDeReservas, fueraDelTecho, veredictoFueraDelTecho, type TrazaLeida,
} from "./gps-cobertura-datos";
import { diagnosticarRastreo, patronDelConductor } from "./gps-diagnostico";
import { estadoDuranteVentana, ultimoEstado, REPORTE_ANTERIOR_MS, type FilaEquipo } from "./gps-equipo";
import { tablaFaltante } from "./columna-faltante";
import {
  SQL_EQUIPO, DIAS_HISTORIAL, MAX_HISTORIAL,
  conductorDelDiagnostico, ventanaDelServicio, anteriorA, ordenServicio, equipoParaPantalla, horaCorta,
  type RespuestaDiagnosticoRastreo, type RespuestaHistorialRastreo, type ServicioHistorialRastreo,
  type TablaConductorDiag,
} from "./gps-diagnostico-api";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** NO MEDIDO: la ventana se juzga en hora del TELÉFONO y la consulta filtra en hora del SERVIDOR; un
 *  reloj desfasado corre una contra otra. Se lee de más por cada lado (la fina la hace
 *  `estadoDuranteVentana` en hora del teléfono). El lado seguro es subirlo: solo cuesta filas. */
const MARGEN_CONSULTA_MS = 12 * 3600_000;
/** Techo de sanidad de reportes leídos por consulta (un conductor genera pocos por día: el latido
 *  solo estira la fila). */
const MAX_REPORTES = 5000;

const COLS_REPORTE =
  "id, conductor_id, conductor_tercero_id, reserva_id, dispositivo, motivo, plataforma, user_agent, modelo, " +
  "plugins, compartiendo, bateria_exenta, precision_ubicacion, todo_el_tiempo, ajustes_alta_precision, " +
  "servicio_fondo, gps_debil_m, gps_atascado, pendientes_cola, firma, reportado_en, visto_hasta, " +
  "reportado_cliente_en, visto_cliente_en";

/** Una fila de `reservas` tal como la devuelve PostgREST (`select("*")`, sin tipos generados). */
export type FilaReservaDiag = Record<string, any>;

/** La reserva entera (`*`, como `rastreoDelDia`), o null si no existe. Un error de lectura LANZA. */
export async function leerReservaDiag(id: number): Promise<FilaReservaDiag | null> {
  const { data, error } = await admin.from("reservas").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`reserva ${id}: ${error.message}`);
  return (data as FilaReservaDiag | null) ?? null;
}

/** Lee reportes paginados. Sin la tabla → `falta: true` y ninguno; otro error LANZA. */
async function leerReportes(armar: () => any, max = MAX_REPORTES): Promise<{ filas: FilaEquipo[]; falta: boolean }> {
  const out: FilaEquipo[] = [];
  for (let off = 0; off < max; off += 1000) {
    const { data, error } = await armar().range(off, Math.min(off + 999, max - 1));
    if (error) {
      if (tablaFaltante(error, "gps_equipo_reportes")) return { filas: [], falta: true };
      throw new Error(`reportes del teléfono: ${error.message}`);
    }
    out.push(...((data || []) as FilaEquipo[]));
    if (!data || data.length < 1000) break;
  }
  return { filas: out, falta: false };
}

/** Los reportes del teléfono que pueden explicar el servicio: los que nombran la reserva, los del
 *  conductor alrededor de la ventana (y 24 h antes), y sus últimos (para «último conocido»). */
async function reportesDelServicio(
  reservaId: number,
  conductor: { tabla: TablaConductorDiag; id: number } | null,
  ini: number, fin: number,
): Promise<{ filas: FilaEquipo[]; falta: boolean }> {
  const tabla = () => admin.from("gps_equipo_reportes").select(COLS_REPORTE);
  const porReserva = leerReportes(() => tabla().eq("reserva_id", reservaId)
    .order("reportado_en", { ascending: true }).order("id", { ascending: true }));
  if (!conductor) return porReserva;
  const col = conductor.tabla === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";
  const desde = new Date(ini - REPORTE_ANTERIOR_MS - MARGEN_CONSULTA_MS).toISOString();
  const hasta = new Date(fin + MARGEN_CONSULTA_MS).toISOString();
  const [a, b, c] = await Promise.all([
    porReserva,
    leerReportes(() => tabla().eq(col, conductor.id).gte("visto_hasta", desde).lte("reportado_en", hasta)
      .order("reportado_en", { ascending: true }).order("id", { ascending: true })),
    // Los últimos del conductor, de cualquier aparato: «último conocido» elige el que más tarde se vio.
    leerReportes(() => tabla().eq(col, conductor.id)
      .order("reportado_en", { ascending: false }).order("id", { ascending: false }), 10),
  ]);
  if (a.falta || b.falta || c.falta) return { filas: [], falta: true };
  const porId = new Map<string, FilaEquipo>();
  for (const f of [...a.filas, ...b.filas, ...c.filas]) porId.set(String(f.id ?? `${f.dispositivo}|${f.reportado_en}`), f);
  // Solo los de ESE conductor: un reporte con la reserva puede ser del chofer al que se la reasignaron.
  const filas = [...porId.values()].filter((f) =>
    conductor.tabla === "conductores_tercero"
      ? Number(f.conductor_tercero_id) === conductor.id
      : Number(f.conductor_id) === conductor.id);
  return { filas, falta: false };
}

/**
 * El diagnóstico completo de una reserva (el cuerpo del modal). `reserva` permite pasar la fila ya
 * leída (la ruta la lee antes para validar la fecha). null si la reserva no existe. LANZA ante un
 * error de lectura que no sea una migración sin correr: la ruta lo convierte en `sin_medir`.
 */
export async function diagnosticoDeReserva(
  id: number,
  o: { hoy: string; ahoraMs: number; reserva?: FilaReservaDiag | null },
): Promise<RespuestaDiagnosticoRastreo | null> {
  const r = o.reserva ?? await leerReservaDiag(id);
  if (!r) return null;
  const ps = (await paradasDeReservas([id])).get(id) ?? [];

  let ctx: ContextoServicio = contextoServicio(r, ps, { hoy: o.hoy, ahoraMs: o.ahoraMs });
  // La torre no mide lo cancelado (rastreoDelDia lo excluye de la consulta): no hay celda que igualar.
  if (r.estado === "cancelada") ctx = { ...ctx, aplica: false };

  let traza: TrazaLeida | null = null;
  let veredicto: VeredictoRastreo;
  let medicion: MedicionCobertura | null = null;
  // rastreoDelDia da `sin_medir` a TODO lo que pasa de su techo diario, aplique o no: igual aquí.
  if (r.estado !== "cancelada" && await fueraDelTecho({ id, fecha_servicio: r.fecha_servicio })) {
    veredicto = veredictoFueraDelTecho(o.ahoraMs);
  } else {
    if (ctx.aplica) { try { traza = await trazaDe(id, { conFilas: true }); } catch { traza = null; } }
    ({ veredicto, medicion } = veredictoDeServicio(ctx, traza, ps, o.ahoraMs));
  }

  const filasGps = traza?.filas ?? null;
  const conductor = conductorDelDiagnostico(filasGps, r);
  const { ini, fin } = ventanaDelServicio(r, ctx, medicion, o.ahoraMs);
  const rep = await reportesDelServicio(id, conductor, ini, fin);
  const { durante, anterior, reinicios } = estadoDuranteVentana(rep.filas, ini, fin);
  const ultimo = ultimoEstado(rep.filas);

  const diagnostico = diagnosticarRastreo({
    veredicto, medicion, traza, filas: filasGps, enCurso: ctx.enCurso,
    equipo: { durante, anterior }, reinicios,
    // Si la traza no se pudo leer no se sabe si la columna existe: no se afirma que falte.
    recibidoMedible: traza?.sinRecibido !== true,
    // Sin la tabla, «el teléfono no reportó» sería falso: no PUDO reportar.
    sinTablaEquipo: rep.falta,
  });

  return {
    reserva_id: id,
    fecha: r.fecha_servicio ?? null,
    medido_en: new Date(o.ahoraMs).toISOString(),
    enCurso: ctx.enCurso,
    veredicto, medicion, diagnostico,
    equipo: {
      durante: equipoParaPantalla(durante),
      anterior: equipoParaPantalla(anterior),
      ultimo: equipoParaPantalla(ultimo),
      conductor,
    },
    migraciones: { sql: SQL_EQUIPO, faltaTabla: rep.falta, faltaRecibido: traza?.sinRecibido === true },
  };
}

/**
 * La respuesta cuando el cálculo falló por algo que no es una validación: el modal no se queda en
 * blanco ni enseña un 500. Las frases las compone el motor (con un veredicto `sin_medir`), no la ruta.
 */
export function diagnosticoNoCalculado(
  reservaId: number, fecha: string | null, ahoraMs: number, error: string,
): RespuestaDiagnosticoRastreo {
  const veredicto = veredictoFueraDelTecho(ahoraMs); // `sin_medir`: no se afirma nada
  return {
    reserva_id: reservaId, fecha, medido_en: new Date(ahoraMs).toISOString(), enCurso: false,
    veredicto, medicion: null,
    diagnostico: diagnosticarRastreo({
      veredicto, medicion: null, traza: null, filas: null, enCurso: false,
      equipo: { durante: null, anterior: null }, reinicios: [], recibidoMedible: true,
    }),
    equipo: { durante: null, anterior: null, ultimo: null, conductor: null },
    migraciones: { sql: SQL_EQUIPO, faltaTabla: false, faltaRecibido: false },
    error,
  };
}

function restarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Placas de un lote de reservas (best-effort: sin placa, el chip sale sin ella). Flota propia y
 *  tercerizada van por separado: sus ids se solapan. */
async function placasDe(reservas: Record<string, any>[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const propias = [...new Set(reservas.map((r) => Number(r.vehiculo_id)).filter((x) => Number.isSafeInteger(x) && x > 0))];
  const terceras = [...new Set(reservas.map((r) => Number(r.vehiculo_tercero_id)).filter((x) => Number.isSafeInteger(x) && x > 0))];
  try {
    const [p, t] = await Promise.all([
      propias.length ? admin.from("vehiculos").select("id, placa").in("id", propias) : Promise.resolve({ data: [] as any[] }),
      terceras.length ? admin.from("vehiculos_tercero").select("id, placa").in("id", terceras) : Promise.resolve({ data: [] as any[] }),
    ]);
    const placaP = new Map(((p.data || []) as any[]).map((v) => [Number(v.id), String(v.placa ?? "")]));
    const placaT = new Map(((t.data || []) as any[]).map((v) => [Number(v.id), String(v.placa ?? "")]));
    for (const r of reservas) {
      const placa = r.vehiculo_id != null ? placaP.get(Number(r.vehiculo_id))
        : r.vehiculo_tercero_id != null ? placaT.get(Number(r.vehiculo_tercero_id)) : undefined;
      if (placa) out.set(Number(r.id), placa);
    }
  } catch { /* best-effort */ }
  return out;
}

const LOTE_HISTORIAL = 3;

/**
 * Los últimos MAX_HISTORIAL servicios de ese conductor, de los DIAS_HISTORIAL días anteriores al
 * servicio `ref` (los del mismo día cuentan si salieron antes), que SÍ se hicieron: no cancelados y
 * que corrieron (`contextoServicio(...).aplica`). Cada uno se mide con las MISMAS dos funciones que la
 * celda. Contesta si el corte es de este servicio o le pasa siempre (`patronDelConductor`). LANZA si
 * no se puede leer la lista; una traza que falla sale `sin_medir`, como en la torre.
 */
export async function historialDelConductor(
  conductor: { tabla: TablaConductorDiag; id: number },
  ref: { id: number; fecha_servicio: string; hora_servicio?: string | null },
  o: { hoy: string; ahoraMs: number },
): Promise<Omit<RespuestaHistorialRastreo, "reserva_id" | "conductor">> {
  const col = conductor.tabla === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";
  const desde = restarDias(ref.fecha_servicio, DIAS_HISTORIAL);
  const reservas = (await todas(() => admin.from("reservas").select("*")
    .eq(col, conductor.id).gte("fecha_servicio", desde).lte("fecha_servicio", ref.fecha_servicio)
    .neq("estado", "cancelada").order("fecha_servicio", { ascending: false }).order("id", { ascending: false })))
    .filter((r) => anteriorA(r, ref))
    .sort((a, b) => ordenServicio(b, a));
  const paradasDe = await paradasDeReservas(reservas.map((r) => r.id));
  const aplican = reservas
    .map((r) => ({ r, ps: paradasDe.get(r.id) ?? [] }))
    .map((x) => ({ ...x, ctx: contextoServicio(x.r, x.ps, { hoy: o.hoy, ahoraMs: o.ahoraMs }) }))
    .filter((x) => x.ctx.aplica);
  const elegidos = aplican.slice(0, MAX_HISTORIAL);
  const placas = await placasDe(elegidos.map((x) => x.r));

  const servicios: ServicioHistorialRastreo[] = new Array(elegidos.length);
  const medir = async (x: (typeof elegidos)[number], i: number) => {
    let traza: TrazaSaneada | null = null;
    try { traza = await trazaDe(x.r.id); } catch { traza = null; }
    const { veredicto: v } = veredictoDeServicio(x.ctx, traza, x.ps, o.ahoraMs);
    servicios[i] = {
      reserva_id: x.r.id,
      fecha: x.r.fecha_servicio,
      hora: horaCorta(x.r.hora_servicio),
      placa: placas.get(Number(x.r.id)) ?? null,
      veredicto: { codigo: v.codigo, pct: v.pct, celda: v.celda, color: v.color, bg: v.bg },
    };
  };
  for (let i = 0; i < elegidos.length; i += LOTE_HISTORIAL) {
    await Promise.all(elegidos.slice(i, i + LOTE_HISTORIAL).map((x, k) => medir(x, i + k)));
  }
  return {
    servicios,
    patron: patronDelConductor(servicios.map((s) => ({ pct: s.veredicto.pct, codigo: s.veredicto.codigo }))),
    recortado: aplican.length > MAX_HISTORIAL,
  };
}
