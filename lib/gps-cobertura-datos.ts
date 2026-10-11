// lib/gps-cobertura-datos.ts — SOLO SERVIDOR. Lee lo que mide lib/gps-cobertura.ts (puro).
//
// `trazaDe` se MUDÓ aquí desde app/api/gps-salud/route.ts sin cambios: /gps-salud y la columna
// RASTREO de /seguimiento leen la traza por el MISMO camino, o el mismo servicio podría salir
// con dos coberturas distintas según la pantalla. El modal de diagnóstico del rastreo
// (lib/gps-diagnostico-datos.ts) también la lee por aquí, pidiendo además las FILAS (`conFilas`).
//
// `rastreoDelDia` arma el veredicto de cada servicio de un día para la torre. Usa la evidencia
// del conductor (lib/servicio-tiempos.ts, SIN pasarle el GPS: el fin del servicio no puede
// salir de la propia traza que se está juzgando, o un GPS que se calla a los 3 minutos volvería
// a medir 100 %). El cierre SÍ sale de la traza, pero no de una posición: es el punto que la app
// fuerza al pulsar «Finalizar» (`cierreTs`, ver lib/gps-cobertura.ts) y lleva la hora del clic.
// El veredicto lo dan `contextoServicio` + `veredictoDeServicio` (lib/gps-cobertura.ts): las MISMAS
// dos funciones que usa el modal de diagnóstico, para que el modal enseñe el número de la celda.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados: las filas de reservas/paradas llegan como `any` */
import { createClient } from "@supabase/supabase-js";
import {
  acumularFilasGps, trazaVacia, veredictoRastreo, contextoServicio, veredictoDeServicio,
  type TrazaSaneada, type VeredictoRastreo,
} from "./gps-cobertura";
import { faltaAlguna } from "./columna-faltante";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Hasta cuántos días atrás se mide el rastreo de un servicio (la torre y el modal de diagnóstico).
 *  Lo histórico por conductor vive en /gps-salud. Tope contra el abuso: cada medición lee la traza
 *  ENTERA del servicio. Vivía en app/api/seguimiento/rastreo/route.ts; se mudó para que las dos
 *  rutas usen el mismo número. */
export const DIAS_RASTREO = 90;

/** Una traza leída por `trazaDe`. `sinRecibido` existe SOLO si se pidieron las filas: `true` si la
 *  columna `recibido_en` no está (supabase/gps-equipo-01.sql sin correr) y hubo que soltarla. */
export type TrazaLeida = TrazaSaneada & { sinRecibido?: boolean };

// Columnas de migraciones accesorias que se pueden SOLTAR si el error las nombra: el rastreo se mide
// igual sin ellas. `simulado` (supabase/ubicaciones-gps-simulado.sql) es el antifraude; `fix_ts` y
// `recibido_en` (supabase/gps-equipo-01.sql) solo sirven al diagnóstico.
const COLS_OPCIONALES = ["simulado", "fix_ts", "recibido_en"] as const;
type ColOpcional = (typeof COLS_OPCIONALES)[number];

/**
 * Trae la traza de una reserva, YA SANEADA. PostgREST corta en 1000 → hay que paginar, con
 * orden estable (created_at + id) para que las páginas no se solapen ni salten filas.
 * Un error de lectura LANZA: una traza a medias mediría una cobertura falsa.
 *
 * `conFilas` pide además lo que hace falta para DIAGNOSTICAR un corte (`traza.filas`, con la hora de
 * recepción, el fix real y el conductor de cada fila). Sin él, las columnas y el resultado son
 * byte a byte los de siempre.
 *
 * Si falta una columna ACCESORIA, se suelta SOLO la que el error nombra (lib/columna-faltante.ts) y
 * se vuelve a leer desde cero con el acumulador nuevo (filas incluidas): mezclar páginas leídas con y
 * sin una columna mediría distinto la mitad de la traza. Antes era un regex `/simulado/` sobre el
 * mensaje, que cubría una sola columna y también se tragaba cualquier otro error que la mencionara.
 */
export async function trazaDe(reservaId: number, opciones?: { conFilas?: boolean }): Promise<TrazaLeida> {
  return leerTraza(admin as unknown as ClienteTraza, reservaId, opciones);
}

/** Lo mínimo de un cliente de Supabase que usa `leerTraza` (la matriz le pasa uno falso). */
export type ClienteTraza = { from: (tabla: string) => { select: (columnas: string) => any } };

/** El cuerpo de `trazaDe`, con el cliente inyectado: scripts/prueba-gps-diagnostico-api.mts lo corre
 *  contra una base falsa (las columnas que pide, el reintento al soltar una, el acumulador limpio). */
export async function leerTraza(cliente: ClienteTraza, reservaId: number, opciones?: { conFilas?: boolean }): Promise<TrazaLeida> {
  const conFilas = opciones?.conFilas === true;
  const pedidas = new Set<ColOpcional>(conFilas ? COLS_OPCIONALES : ["simulado"]);
  const nueva = (): TrazaSaneada => {
    const acc = trazaVacia();
    if (conFilas) acc.filas = [];
    return acc;
  };
  let acc = nueva();
  // Una vuelta por cada columna que se pueda soltar, más la buena: nunca un bucle sin fin.
  for (let intento = 0; intento <= COLS_OPCIONALES.length; intento++) {
    const cols = ["created_at", "lat", "lng", "precision_m"];
    if (pedidas.has("simulado")) cols.push("simulado");
    cols.push("estado");
    if (conFilas) {
      if (pedidas.has("fix_ts")) cols.push("fix_ts");
      if (pedidas.has("recibido_en")) cols.push("recibido_en");
      cols.push("conductor_id", "conductor_tercero_id");
    }
    // Sin `conFilas` es exactamente el select de siempre: "created_at, lat, lng, precision_m, simulado, estado".
    const select = cols.join(", ");
    let soltada: ColOpcional | null = null;
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await cliente
        .from("ubicaciones_gps")
        .select(select)
        .eq("reserva_id", reservaId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(off, off + 999);
      if (error) {
        const col = faltaAlguna(error, [...pedidas]);
        if (col) { soltada = col; break; }
        throw new Error(`traza ${reservaId}: ${error.message}`);
      }
      if (!data?.length) break;
      acumularFilasGps(acc, data, pedidas.has("simulado"));
      if (data.length < 1000) break;
    }
    if (!soltada) {
      const out: TrazaLeida = { ...acc, pts: acc.pts.sort((a, b) => a.ts - b.ts) };
      if (conFilas) out.sinRecibido = !pedidas.has("recibido_en");
      return out;
    }
    // Reintento sin la columna que falta, desde cero.
    pedidas.delete(soltada);
    acc = nueva();
  }
  throw new Error(`traza ${reservaId}: no se pudo leer ni soltando las columnas opcionales`);
}

/** Lee TODAS las filas o lanza: una lista cortada por un error mediría de menos. */
export async function todas(armar: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; off < 200_000; off += 1000) {
    const { data, error } = await armar().range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Las paradas de cada reserva, en el orden con que las juzga el veredicto (orden + id). UNA lectura
 * para la torre, el modal y el historial del conductor: `finYDestino` toma la ÚLTIMA parada como
 * destino, así que leerlas en otro orden en otra pantalla movería el fin de la ventana.
 */
export async function paradasDeReservas(ids: number[]): Promise<Map<number, any[]>> {
  const paradas: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const sub = ids.slice(i, i + 200);
    paradas.push(...await todas(() => admin.from("paradas").select("*").in("reserva_id", sub)
      .order("reserva_id", { ascending: true }).order("orden", { ascending: true }).order("id", { ascending: true })));
  }
  const paradasDe = new Map<number, any[]>();
  for (const p of paradas) paradasDe.set(p.reserva_id, [...(paradasDe.get(p.reserva_id) ?? []), p]);
  return paradasDe;
}

const LOTE = 8;            // reservas en paralelo, como /api/gps-salud
/** Techo de trabajo por día (≈ 20-40 servicios reales): el resto sale `sin_medir`. */
export const MAX_RESERVAS = 150;

/**
 * Veredicto de rastreo de cada servicio de `fecha`. Solo lee el GPS de los que corrieron o
 * están corriendo; el resto sale `no_aplica` sin consulta. Una traza que no se pudo leer sale
 * `sin_medir` (nunca 0 %): un fallo de lectura no puede acusar a un conductor.
 */
export async function rastreoDelDia(fecha: string, hoy: string, ahoraMs: number): Promise<Record<number, VeredictoRastreo>> {
  const reservas = await todas(() => admin.from("reservas").select("*")
    .eq("fecha_servicio", fecha).neq("estado", "cancelada").order("id", { ascending: true }));
  const paradasDe = await paradasDeReservas(reservas.map((r) => r.id));

  const out: Record<number, VeredictoRastreo> = {};
  const medir = async (r: any) => {
    const ps = paradasDe.get(r.id) ?? [];
    const ctx = contextoServicio(r, ps, { hoy, ahoraMs });
    // Solo se lee el GPS de lo que corrió o está corriendo: `veredictoDeServicio` ignora la traza
    // de un servicio que no aplica.
    let traza: TrazaSaneada | null = null;
    if (ctx.aplica) { try { traza = await trazaDe(r.id); } catch { traza = null; } }
    out[r.id] = veredictoDeServicio(ctx, traza, ps, ahoraMs).veredicto;
  };
  const lote = reservas.slice(0, MAX_RESERVAS);
  for (let i = 0; i < lote.length; i += LOTE) await Promise.all(lote.slice(i, i + LOTE).map(medir));
  // Lo que pasa del techo NO se mide y lo dice: nunca un 0 % por no haberlo mirado.
  for (const r of reservas.slice(MAX_RESERVAS)) out[r.id] = veredictoFueraDelTecho(ahoraMs);
  return out;
}

/** El veredicto de un servicio que `rastreoDelDia` no midió por pasar del techo: `sin_medir`. */
export function veredictoFueraDelTecho(ahoraMs: number): VeredictoRastreo {
  return veredictoRastreo({ aplica: true, enCurso: false, traza: null, medicion: null, avanzo: false, inmovil: false, inicioTs: null, ahoraMs });
}

/**
 * ¿`rastreoDelDia` dejó a esta reserva fuera del techo? Es la MISMA regla de arriba (las primeras
 * MAX_RESERVAS por id de su día, sin canceladas), para que el modal de diagnóstico diga lo mismo que
 * la celda. Best-effort: si el conteo falla se mide (con 20-40 servicios al día nunca se llega).
 */
export async function fueraDelTecho(r: { id: number; fecha_servicio?: string | null }): Promise<boolean> {
  if (!r.fecha_servicio) return false;
  const { count, error } = await admin.from("reservas").select("id", { count: "exact", head: true })
    .eq("fecha_servicio", r.fecha_servicio).neq("estado", "cancelada").lt("id", r.id);
  if (error || count == null) return false;
  return count >= MAX_RESERVAS;
}
