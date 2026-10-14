// lib/ruta-propia-datos.ts — SOLO SERVIDOR. Lee y arma `rutas_propias` (migración
// supabase/rutas-propias-01.sql): la línea de la ruta planificada armada con el GPS real de un
// servicio anterior (motor puro: lib/ruta-propia.ts).
//
// No llama a Google ni a nada pagado. Armarla son lecturas a la base (los servicios del mismo
// cliente con los mismos paraderos y su GPS), y se hace en `after()`: nunca retrasa al modal.
//
// LA CLAVE es `firmaRuta` de los paraderos, la MISMA con que /api/ruta guarda la de Google en
// `rutas_cache`: el que escribe y el que lee la derivan por el mismo camino.
//
// Sin la migración nada se cae: leer devuelve null y armar no guarda nada (el modal sigue con Google).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { huellaDeFilas } from "./huella";
import { firmaRuta } from "./ruta-firma";
import { tablaFaltante } from "./columna-faltante";
import {
  DIAS_CANDIDATOS, MAX_CANDIDATOS, MOTIVO_TRAZO, mismosParaderos, elegirRecorrido, payloadDeRecorrido,
  debeReconstruir, type Candidato, type CodigoTrazo, type FilaRutaPropia, type Punto,
} from "./ruta-propia";

const PAG = 1000;
const LOTE_IDS = 150;
const MAX_RESERVAS_LEIDAS = 300;
/** Un servicio con más posiciones que esto no se usa como candidato (operativo, no medido). */
const MAX_FILAS_GPS = 20_000;
/** Entre dos intentos de armar la misma clave en esta instancia (no medido). */
const ESPERA_INTENTO_MS = 10 * 60_000;

const admin = (): SupabaseClient => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Resp<T> = { data: T[] | null; error: { message?: string; code?: string } | null };
type Consulta<T> = { range: (desde: number, hasta: number) => PromiseLike<Resp<T>> };

/** Todas las páginas, o LANZA: una traza leída a medias se juzgaría como otra ruta. */
async function todas<T>(armar: () => Consulta<T>, max = Infinity): Promise<T[] | null> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    if (desde >= max) return null;   // más filas que el tope: no se usa (null)
    const { data, error } = await armar().range(desde, desde + PAG - 1);
    if (error) throw new Error(error.message || "consulta fallida");
    out.push(...(data || []));
    if (!data || data.length < PAG) return out;
  }
}
/** Igual que `todas`, sin tope. */
async function todasSinTope<T>(armar: () => Consulta<T>): Promise<T[]> {
  return (await todas(armar)) as T[];
}

function sinTabla(error: { message?: string; code?: string } | null): boolean {
  return tablaFaltante(error, "rutas_propias");
}

/** La fila de (clave, cliente), o null (no existe, o la tabla todavía no se creó). Lanza ante otro error. */
async function leerFila(clave: string, clienteId: number, db: SupabaseClient): Promise<FilaRutaPropia | null> {
  const { data, error } = await db.from("rutas_propias").select("payload, revisada_en")
    .eq("clave", clave).eq("cliente_id", clienteId).maybeSingle();
  if (error) {
    if (sinTabla(error)) return null;
    throw new Error(error.message || "no se pudo leer rutas_propias");
  }
  return (data as FilaRutaPropia | null) ?? null;
}

async function clienteDe(reservaId: number, db: SupabaseClient): Promise<number | null> {
  const { data, error } = await db.from("reservas").select("cliente_id").eq("id", reservaId).maybeSingle();
  if (error) throw new Error(error.message || "no se pudo leer la reserva");
  return data?.cliente_id != null ? Number(data.cliente_id) : null;
}

/**
 * La ruta propia de `clave` para el servicio `reservaId`: la del CLIENTE de esa reserva (dos
 * clientes con exactamente los mismos paraderos no se ven el recorrido). `null` = no hay, o la
 * reserva no tiene cliente.
 */
export async function rutaPropiaParaReserva(clave: string, reservaId: number, db: SupabaseClient = admin()): Promise<FilaRutaPropia | null> {
  const cliente = await clienteDe(reservaId, db);
  if (cliente == null) return null;
  return leerFila(clave, cliente, db);
}

type FilaParada = { reserva_id: number; id: number; orden: number | null; lat: number | null; lng: number | null; nombre?: string | null };
type FilaReserva = { id: number; fecha_servicio: string | null };

function ordenadas<T extends { orden: number | null; id: number; lat: number | null; lng: number | null }>(filas: T[]): T[] {
  return [...filas]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id)
    .filter((p) => p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
}
function coordsDe(filas: { orden: number | null; id: number; lat: number | null; lng: number | null }[]): Punto[] {
  return ordenadas(filas).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
}

function fechaLimaMenos(dias: number, ahoraMs: number): string {
  return new Date(ahoraMs - 5 * 3600_000 - dias * 86_400_000).toISOString().slice(0, 10);
}

export type ResultadoArmado =
  | { codigo: "armada"; fuenteReservaId: number; candidatos: number }
  | { codigo: "sin_recorrido_valido"; candidatos: number; motivo: string }
  | { codigo: "no_es_de_la_reserva" | "sin_cliente" | "sin_migracion" | "en_curso" | "esperando" };

const enCurso = new Set<string>();
const ultimoIntento = new Map<string, number>();

/** ¿Se puede intentar armar ahora? (sin gastar cupo). Por clave Y por reserva. */
export function puedeIntentar(clave: string, reservaId: number, ahoraMs = Date.now()): boolean {
  if (enCurso.has(clave)) return false;
  for (const k of [clave, `r:${reservaId}`]) {
    const ult = ultimoIntento.get(k);
    if (ult != null && ahoraMs - ult < ESPERA_INTENTO_MS) return false;
  }
  return true;
}

/**
 * Arma (o renueva) la ruta propia de `clave` para el servicio `reservaId`. Los paraderos y sus
 * nombres se leen de la RESERVA (sus filas de `paradas`, o su `paradas_json`), nunca del cuerpo de
 * la petición, y su firma tiene que ser EXACTAMENTE `clave`: así nadie arma —ni lee— el recorrido
 * de los servicios de un cliente con una lista inventada o corrida unos metros, y la clave con que
 * se escribe es la misma con que el modal la lee.
 * Los candidatos son servicios FINALIZADOS del MISMO cliente, de los últimos DIAS_CANDIDATOS días,
 * con esos paraderos (≤ RADIO_PARADERO_M cada uno).
 */
export async function armarRutaPropia(clave: string, reservaId: number, ahoraMs = Date.now()): Promise<ResultadoArmado> {
  if (!puedeIntentar(clave, reservaId, ahoraMs)) return { codigo: "esperando" };
  enCurso.add(clave);
  ultimoIntento.set(clave, ahoraMs);
  ultimoIntento.set(`r:${reservaId}`, ahoraMs);
  try {
    const db = admin();
    // 1. Los paraderos de ESTA reserva, y su firma tiene que ser la clave pedida.
    const { data: rsv, error: eR } = await db.from("reservas").select("id, cliente_id, paradas_json").eq("id", reservaId).maybeSingle();
    if (eR) throw new Error(eR.message);
    if (!rsv?.cliente_id) return { codigo: "sin_cliente" };
    const actual = await leerFila(clave, Number(rsv.cliente_id), db);
    if (!debeReconstruir(actual, ahoraMs)) return { codigo: "esperando" };
    const propias = await todasSinTope<FilaParada>(() => db.from("paradas").select("reserva_id, id, orden, lat, lng, nombre")
      .eq("reserva_id", reservaId).order("orden", { ascending: true }).order("id", { ascending: true }));
    let suyas: (Punto & { nombre: string })[] = ordenadas(propias)
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), nombre: String(p.nombre ?? "") }));
    if (suyas.length < 2 && Array.isArray(rsv.paradas_json)) {
      suyas = (rsv.paradas_json as { lat?: unknown; lng?: unknown; nombre?: unknown }[])
        .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng), nombre: String(p?.nombre ?? "") }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
    }
    if (suyas.length < 2 || firmaRuta(suyas) !== clave) return { codigo: "no_es_de_la_reserva" };
    const paraderos: Punto[] = suyas.map(({ lat, lng }) => ({ lat, lng }));
    const nombres = suyas.map((p) => p.nombre.slice(0, 120));

    // 2. Servicios finalizados del mismo cliente con esos mismos paraderos (los más recientes).
    const { data: rs, error: eRs } = await db.from("reservas").select("id, fecha_servicio")
      .eq("estado", "finalizada").eq("cliente_id", rsv.cliente_id).neq("id", reservaId)
      .gte("fecha_servicio", fechaLimaMenos(DIAS_CANDIDATOS, ahoraMs))
      .order("fecha_servicio", { ascending: false }).order("id", { ascending: false })
      .range(0, MAX_RESERVAS_LEIDAS - 1);
    if (eRs) throw new Error(eRs.message);
    const recientes = (rs || []) as FilaReserva[];
    const elegidos: FilaReserva[] = [];
    for (let i = 0; i < recientes.length && elegidos.length < MAX_CANDIDATOS; i += LOTE_IDS) {
      const lote = recientes.slice(i, i + LOTE_IDS);
      const filas = await todasSinTope<FilaParada>(() => db.from("paradas").select("reserva_id, id, orden, lat, lng")
        .in("reserva_id", lote.map((r) => r.id))
        .order("reserva_id", { ascending: true }).order("id", { ascending: true }));
      const por = new Map<number, FilaParada[]>();
      for (const f of filas) {
        const k = Number(f.reserva_id);
        if (!por.has(k)) por.set(k, []);
        por.get(k)!.push(f);
      }
      for (const r of lote) {
        if (elegidos.length >= MAX_CANDIDATOS) break;
        if (mismosParaderos(coordsDe(por.get(Number(r.id)) ?? []), paraderos)) elegidos.push(r);
      }
    }

    // 3. Su GPS, juzgado por el motor.
    const candidatos: Candidato[] = [];
    for (const r of elegidos) {
      const filas = await todas<Record<string, unknown>>(() => db.from("ubicaciones_gps")
        .select("lat, lng, velocidad, precision_m, rumbo, created_at, timestamp")
        .eq("reserva_id", r.id)
        .order("created_at", { ascending: true }).order("id", { ascending: true }), MAX_FILAS_GPS);
      if (!filas) continue;
      candidatos.push({ reservaId: Number(r.id), fecha: r.fecha_servicio, puntos: huellaDeFilas(filas).limpio });
    }
    const e = elegirRecorrido(candidatos, paraderos);
    const ahoraIso = new Date(ahoraMs).toISOString();

    if (!e.ok) {
      const motivo = elegidos.length === 0
        ? `Ningún servicio finalizado de los últimos ${DIAS_CANDIDATOS} días tiene estos mismos paraderos`
        : Object.entries(e.descartes).map(([c, n]) => `${n} × ${MOTIVO_TRAZO[c as CodigoTrazo]}`).join(" · ");
      // Si ya había una ruta buena, se CONSERVA (solo se anota que se revisó): una vía que no se
      // pudo volver a medir no deja de existir. Si no había, se anota el intento fallido.
      const fila = actual?.payload
        ? { clave, revisada_en: ahoraIso }
        : { clave, cliente_id: rsv.cliente_id, payload: null, motivo, candidatos: e.juzgados, revisada_en: ahoraIso };
      const { error } = await db.from("rutas_propias").upsert(fila, { onConflict: "clave,cliente_id" });
      if (error && sinTabla(error)) return { codigo: "sin_migracion" };
      if (error) throw new Error(error.message);
      return { codigo: "sin_recorrido_valido", candidatos: e.juzgados, motivo };
    }

    const payload = payloadDeRecorrido(e, nombres);
    const { error } = await db.from("rutas_propias").upsert({
      clave, cliente_id: rsv.cliente_id, payload, motivo: null, candidatos: e.juzgados,
      fuente_reserva_id: e.reservaId, fuente_fecha: e.fecha,
      construida_en: ahoraIso, revisada_en: ahoraIso,
    }, { onConflict: "clave,cliente_id" });
    if (error && sinTabla(error)) return { codigo: "sin_migracion" };
    if (error) throw new Error(error.message);
    return { codigo: "armada", fuenteReservaId: e.reservaId, candidatos: e.juzgados };
  } finally {
    enCurso.delete(clave);
  }
}
