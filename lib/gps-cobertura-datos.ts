// lib/gps-cobertura-datos.ts — SOLO SERVIDOR. Lee lo que mide lib/gps-cobertura.ts (puro).
//
// `trazaDe` se MUDÓ aquí desde app/api/gps-salud/route.ts sin cambios: /gps-salud y la columna
// RASTREO de /seguimiento leen la traza por el MISMO camino, o el mismo servicio podría salir
// con dos coberturas distintas según la pantalla.
//
// `rastreoDelDia` arma el veredicto de cada servicio de un día para la torre. Usa la evidencia
// del conductor (lib/servicio-tiempos.ts, SIN pasarle el GPS: el fin del servicio no puede
// salir de la propia traza que se está juzgando, o un GPS que se calla a los 3 minutos volvería
// a medir 100 %).

import { createClient } from "@supabase/supabase-js";
import {
  acumularFilasGps, trazaVacia, finYDestino, medirCobertura, trazaInmovil, veredictoRastreo,
  type TrazaSaneada, type VeredictoRastreo,
} from "./gps-cobertura";
import { derivarTiempos } from "./servicio-tiempos";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/**
 * Trae la traza de una reserva, YA SANEADA. PostgREST corta en 1000 → hay que paginar, con
 * orden estable (created_at + id) para que las páginas no se solapen ni salten filas.
 * Un error de lectura LANZA: una traza a medias mediría una cobertura falsa.
 */
export async function trazaDe(reservaId: number): Promise<TrazaSaneada> {
  const acc = trazaVacia();
  let sinColumnaSimulado = false;
  for (let off = 0; off < 20000; off += 1000) {
    const { data, error } = await admin
      .from("ubicaciones_gps")
      .select("created_at, lat, lng, precision_m, simulado")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) {
      // La columna `simulado` es opcional (supabase/ubicaciones-gps-simulado.sql). Sin ella el
      // panel debe seguir midiendo cobertura: el antifraude es un extra, no un requisito.
      if (/simulado/i.test(error.message || "")) { sinColumnaSimulado = true; break; }
      throw new Error(`traza ${reservaId}: ${error.message}`);
    }
    if (!data?.length) break;
    acumularFilasGps(acc, data, true);
    if (data.length < 1000) break;
  }
  // Reintento sin la columna nueva si la BD aún no la tiene.
  if (sinColumnaSimulado) {
    acc.pts.length = 0; acc.totalCrudo = 0; acc.porAntena = 0;
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await admin
        .from("ubicaciones_gps")
        .select("created_at, lat, lng, precision_m")
        .eq("reserva_id", reservaId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(`traza ${reservaId}: ${error.message}`);
      if (!data?.length) break;
      acumularFilasGps(acc, data, false);
      if (data.length < 1000) break;
    }
  }
  return { ...acc, pts: acc.pts.sort((a, b) => a.ts - b.ts) };
}

/** Lee TODAS las filas o lanza: una lista cortada por un error mediría de menos. */
async function todas(armar: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; off < 200_000; off += 1000) {
    const { data, error } = await armar().range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const LOTE = 8;            // reservas en paralelo, como /api/gps-salud
const MAX_RESERVAS = 150;  // techo de trabajo por día (≈ 20-40 servicios reales): el resto sale `sin_medir`

/**
 * Veredicto de rastreo de cada servicio de `fecha`. Solo lee el GPS de los que corrieron o
 * están corriendo; el resto sale `no_aplica` sin consulta. Una traza que no se pudo leer sale
 * `sin_medir` (nunca 0 %): un fallo de lectura no puede acusar a un conductor.
 */
export async function rastreoDelDia(fecha: string, hoy: string, ahoraMs: number): Promise<Record<number, VeredictoRastreo>> {
  const reservas = await todas(() => admin.from("reservas").select("*")
    .eq("fecha_servicio", fecha).neq("estado", "cancelada").order("id", { ascending: true }));
  const ids = reservas.map((r) => r.id);
  const paradas: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const sub = ids.slice(i, i + 200);
    paradas.push(...await todas(() => admin.from("paradas").select("*").in("reserva_id", sub)
      .order("reserva_id", { ascending: true }).order("orden", { ascending: true }).order("id", { ascending: true })));
  }
  const paradasDe = new Map<number, any[]>();
  for (const p of paradas) paradasDe.set(p.reserva_id, [...(paradasDe.get(p.reserva_id) ?? []), p]);

  const out: Record<number, VeredictoRastreo> = {};
  const medir = async (r: any) => {
    const ps = paradasDe.get(r.id) ?? [];
    const completadas = ps.filter((p) => p.estado === "completada").length;
    const terminado = r.estado === "finalizada" || (ps.length > 0 && completadas === ps.length);
    // Un servicio "en curso" de OTRO día que nadie cerró no está en ruta: medirlo hasta ahora lo
    // hundiría por horas que no son de servicio. Se juzga como terminado, con su evidencia.
    const enCurso = fecha === hoy && r.estado === "en_curso" && !terminado;
    const aplica = terminado || r.estado === "en_curso" || completadas > 0;
    const t = derivarTiempos({ reserva: r, paradas: ps, ahoraMs, hoy });
    const inicioTs = t.inicio && !t.inicio.estimado ? t.inicio.ts : null;
    const finTs = t.finParadero && !t.finParadero.estimado ? t.finParadero.ts : null;
    if (!aplica) {
      out[r.id] = veredictoRastreo({ aplica: false, enCurso, traza: trazaVacia(), medicion: null, avanzo: false, inmovil: false, inicioTs, ahoraMs });
      return;
    }
    let traza: TrazaSaneada | null = null;
    try { traza = await trazaDe(r.id); } catch { traza = null; }
    const { finPrevistoTs, destino } = finYDestino(ps, r.fecha_servicio, r.hora_servicio);
    const medicion = traza
      ? medirCobertura({ pts: traza.pts, destino, finPrevistoTs, inicioTs, finTs, hastaTs: enCurso ? ahoraMs : null })
      : null;
    out[r.id] = veredictoRastreo({
      aplica: true, enCurso, traza, medicion,
      avanzo: terminado || completadas >= 2,
      inmovil: traza ? trazaInmovil(traza.pts, ps) : false,
      inicioTs, ahoraMs,
    });
  };
  const lote = reservas.slice(0, MAX_RESERVAS);
  for (let i = 0; i < lote.length; i += LOTE) await Promise.all(lote.slice(i, i + LOTE).map(medir));
  // Lo que pasa del techo NO se mide y lo dice: nunca un 0 % por no haberlo mirado.
  for (const r of reservas.slice(MAX_RESERVAS)) {
    out[r.id] = veredictoRastreo({ aplica: true, enCurso: false, traza: null, medicion: null, avanzo: false, inmovil: false, inicioTs: null, ahoraMs });
  }
  return out;
}
