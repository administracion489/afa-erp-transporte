// lib/tramos-historicos-datos.ts — SOLO SERVIDOR. Lee los servicios finalizados de los últimos
// DIAS_HISTORIAL días con las llegadas que marcó el conductor, para lib/tramos-historicos.ts.
//
// No llama a Google ni a nada pagado: son dos consultas a la base, y el resultado se guarda en
// memoria TTL_MS por público (el ERP entero, o un cliente del portal) — abrir el modal de diez
// servicios seguidos no relee el mes diez veces.
//
// La hora de llegada se juzga con `hechosDeParadas` (lib/servicio-tiempos.ts): una hora fuera
// de la ventana de sanidad del día del servicio NO es una llegada, es un hueco. Es la misma
// definición de «llegada creíble» que usa el reporte del servicio.
//
// Una consulta que falla LANZA: un mes leído a medias daría un promedio con menos muestras y
// nadie lo sabría. El route lo convierte en «no se pudo leer el historial».

import type { SupabaseClient } from "@supabase/supabase-js";
import { hechosDeParadas } from "./servicio-tiempos";
import { DIAS_HISTORIAL, type ServicioHistorico } from "./tramos-historicos";

const TTL_MS = 10 * 60_000;
const LOTE_IDS = 150;
const PAG = 1000;

const cache = new Map<string, { hasta: number; datos: Promise<ServicioHistorico[]> }>();

function fechaLimaMenos(dias: number, ahoraMs: number): string {
  return new Date(ahoraMs - 5 * 3600_000 - dias * 86_400_000).toISOString().slice(0, 10);
}

type Consulta<T> = { range: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }> };
type FilaReserva = { id: number; fecha_servicio: string | null };
type FilaParada = {
  id: number; reserva_id: number; orden: number | null; estado: string | null;
  lat: number | null; lng: number | null; hora_llegada: string | null;
};

async function todas<T>(armar: () => Consulta<T>): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    const { data, error } = await armar().range(desde, desde + PAG - 1);
    if (error) throw new Error(error.message || "consulta fallida");
    out.push(...(data || []));
    if (!data || data.length < PAG) return out;
  }
}

async function leer(db: SupabaseClient, clienteId: number | null, ahoraMs: number): Promise<ServicioHistorico[]> {
  const desde = fechaLimaMenos(DIAS_HISTORIAL, ahoraMs);
  const reservas = await todas<FilaReserva>(() => {
    let q = db.from("reservas").select("id, fecha_servicio")
      .eq("estado", "finalizada").gte("fecha_servicio", desde)
      .order("fecha_servicio", { ascending: true }).order("id", { ascending: true });
    if (clienteId != null) q = q.eq("cliente_id", clienteId);
    return q;
  });
  if (!reservas.length) return [];
  const fecha = new Map<number, string | null>(reservas.map((r) => [Number(r.id), r.fecha_servicio]));
  const ids = [...fecha.keys()];
  const porReserva = new Map<number, FilaParada[]>();
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const lote = ids.slice(i, i + LOTE_IDS);
    const filas = await todas<FilaParada>(() => db.from("paradas")
      .select("id, reserva_id, orden, estado, lat, lng, hora_llegada")
      .in("reserva_id", lote)
      .order("reserva_id", { ascending: true }).order("id", { ascending: true }));
    for (const f of filas) {
      const k = Number(f.reserva_id);
      if (!porReserva.has(k)) porReserva.set(k, []);
      porReserva.get(k)!.push(f);
    }
  }
  const out: ServicioHistorico[] = [];
  for (const [rid, filas] of porReserva) {
    // Sin ninguna hora marcada no aporta nada: se ahorra la normalización.
    if (!filas.some((f) => f.hora_llegada)) continue;
    const coords = new Map<number, { lat: number | null; lng: number | null }>(filas.map((f) => [Number(f.id), { lat: f.lat, lng: f.lng }]));
    const { paradas } = hechosDeParadas({ reserva: { id: rid, fecha_servicio: fecha.get(rid) }, paradas: filas, ahoraMs });
    out.push({
      reservaId: rid,
      paradas: paradas.map((p) => ({ ...coords.get(Number(p.id))!, llegadaTs: p.llegadaTs })),
    });
  }
  return out;
}

/** Servicios históricos para el ERP (`clienteId` null) o solo los de un cliente del portal. */
export function serviciosHistoricos(db: SupabaseClient, clienteId: number | null, ahoraMs = Date.now()): Promise<ServicioHistorico[]> {
  const k = clienteId == null ? "erp" : `c:${clienteId}`;
  const hit = cache.get(k);
  if (hit && hit.hasta > ahoraMs) return hit.datos;
  const datos = leer(db, clienteId, ahoraMs);
  cache.set(k, { hasta: ahoraMs + TTL_MS, datos });
  // Un fallo no se queda en caché: el próximo pedido vuelve a intentar.
  datos.catch(() => { if (cache.get(k)?.datos === datos) cache.delete(k); });
  return datos;
}
