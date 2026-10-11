// app/api/seguimiento/rastreo/diagnostico/route.ts
// EL DIAGNÓSTICO DEL RASTREO DE UN SERVICIO: el modal que se abre al hacer clic en el % de la celda
// RASTREO de /seguimiento. Contesta lo que la celda no dice: POR QUÉ se cortó (cada tramo con su
// causa), y si es su teléfono o le falta configurar algo (los reportes de la app del conductor).
//
//   GET ?reserva=<id>              → RespuestaDiagnosticoRastreo (lib/gps-diagnostico-api.ts)
//   GET ?reserva=<id>&historial=1  → RespuestaHistorialRastreo: SOLO los últimos servicios del
//                                    conductor, para que el modal los pida en paralelo.
//
// LEE, no escribe ni avisa nada. El % es el de la celda: mismo lector y mismas dos funciones que
// /api/seguimiento/rastreo (ver lib/gps-diagnostico-datos.ts).
//
// Autorización: la MISMA de /api/seguimiento/rastreo (módulo «seguimiento»). La service-role solo
// vive aquí y en el lector; `gps_equipo_reportes` no tiene ninguna política RLS.
//
// Respuestas:
//   400 · `reserva` no es un entero > 0, la reserva no tiene fecha, o es de hace más de DIAS_RASTREO días
//   404 · la reserva no existe
//   503 · la instancia tiene demasiados cálculos esperando (`reintentar: true`, con Retry-After)
//   200 · todo lo demás. Un error que NO es de validación también es 200: el diagnóstico sale
//         `sin_medir` y `error` dice por qué — el modal nunca se queda en blanco por un 500.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { DIAS_RASTREO } from "@/lib/gps-cobertura-datos";
import {
  leerReservaDiag, diagnosticoDeReserva, diagnosticoNoCalculado, historialDelConductor,
  type FilaReservaDiag,
} from "@/lib/gps-diagnostico-datos";
import {
  conductorDeReserva,
  type RespuestaDiagnosticoRastreo, type RespuestaHistorialRastreo, type RespuestaErrorDiagnostico,
} from "@/lib/gps-diagnostico-api";
import { hoyLimaFecha } from "@/lib/retrasos-datos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── CACHÉ ─────────────────────────────────────────────────────────────────────────────
// Un servicio de HOY puede seguir en ruta: 30 s. Uno de otro día ya no cambia: 10 min. El historial
// del conductor (sus servicios anteriores) tampoco: 10 min. Las dos cachés guardan a lo sumo MAX_CACHE
// entradas (se descarta la más vieja).
const TTL_HOY_MS = 30_000;
const TTL_OTRO_DIA_MS = 10 * 60_000;
const TTL_HISTORIAL_MS = 10 * 60_000;
const MAX_CACHE = 200;
type Entrada<T> = { at: number; ttl: number; payload: T };
const cacheDiag = new Map<number, Entrada<RespuestaDiagnosticoRastreo>>();
const cacheHist = new Map<string, Entrada<RespuestaHistorialRastreo>>();
const enVueloDiag = new Map<number, Promise<RespuestaDiagnosticoRastreo | null>>();
const enVueloHist = new Map<string, Promise<RespuestaHistorialRastreo>>();

function leer<K, T>(c: Map<K, Entrada<T>>, k: K): T | null {
  const e = c.get(k);
  return e && Date.now() - e.at < e.ttl ? e.payload : null;
}
function guardar<K, T>(c: Map<K, Entrada<T>>, k: K, payload: T, ttl: number) {
  c.delete(k);
  c.set(k, { at: Date.now(), ttl, payload });
  while (c.size > MAX_CACHE) c.delete(c.keys().next().value as K);
}

// ── TOPE DE CÁLCULOS ──────────────────────────────────────────────────────────────────
// Cada diagnóstico lee la traza ENTERA de un servicio (miles de puntos) y el historial, la de cinco.
// A lo sumo MAX_CALCULOS a la vez por instancia; los demás ESPERAN su turno (mismo patrón que
// /api/seguimiento/rastreo: el cupo se traspasa al siguiente sin soltarlo, para que nadie se cuele).
// Se decidió ESPERAR y no rechazar: el modal lo abre una persona con un clic, y un rechazo al primer
// intento se leería como «el diagnóstico está roto». Pero la cola tiene techo (MAX_EN_COLA): pedir
// cientos de reservas distintas a la vez no puede encolar cientos de lecturas pesadas, y ahí sí se
// responde 503 con `reintentar` (un humano no llega nunca a ese número; un script, sí).
const MAX_CALCULOS = 3;
const MAX_EN_COLA = 20;
let calculando = 0;
const cola: (() => void)[] = [];
class Ocupado extends Error {}
async function turno<T>(fn: () => Promise<T>): Promise<T> {
  if (calculando >= MAX_CALCULOS) {
    if (cola.length >= MAX_EN_COLA) throw new Ocupado("ocupado");
    await new Promise<void>((ok) => cola.push(ok));
  } else calculando++;
  try { return await fn(); }
  finally { const siguiente = cola.shift(); if (siguiente) siguiente(); else calculando--; }
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

function restarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const err = (status: number, cuerpo: RespuestaErrorDiagnostico, headers?: Record<string, string>) =>
  NextResponse.json(cuerpo, { status, headers });
const ocupado = () => err(503,
  { error: "Hay muchos diagnósticos calculándose ahora mismo. Vuelve a intentarlo en unos segundos.", reintentar: true },
  { "Retry-After": "10" });

/** El diagnóstico de una reserva, compartido entre peticiones simultáneas y con caché. */
async function obtenerDiagnostico(id: number, reserva: FilaReservaDiag, hoy: string): Promise<RespuestaDiagnosticoRastreo | null> {
  const cacheado = leer(cacheDiag, id);
  if (cacheado) return cacheado;
  let promesa = enVueloDiag.get(id);
  if (!promesa) {
    promesa = turno(() => diagnosticoDeReserva(id, { hoy, ahoraMs: Date.now(), reserva }))
      .then((p) => {
        if (p) guardar(cacheDiag, id, p, p.fecha === hoy ? TTL_HOY_MS : TTL_OTRO_DIA_MS);
        return p;
      })
      .finally(() => enVueloDiag.delete(id));
    enVueloDiag.set(id, promesa);
  }
  return promesa;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "seguimiento");
  if (!auth.ok) return err(auth.status, { error: auth.error });

  const params = new URL(req.url).searchParams;
  const crudo = params.get("reserva") ?? "";
  const id = /^\d{1,15}$/.test(crudo) ? Number(crudo) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    return err(400, { error: "Falta el servicio: se espera ?reserva=<id> con un número entero mayor que 0." });
  }
  const conHistorial = params.get("historial") === "1";
  const hoy = hoyLimaFecha();
  // Un diagnóstico en caché ya pasó las validaciones: se devuelve sin volver a leer la reserva.
  if (!conHistorial) {
    const cacheado = leer(cacheDiag, id);
    if (cacheado) return NextResponse.json(cacheado);
  }

  // La reserva se lee primero: decide el 404 y la ventana de DIAS_RASTREO días.
  let reserva: FilaReservaDiag | null;
  try {
    reserva = await leerReservaDiag(id);
  } catch (e: unknown) {
    console.error("[api/seguimiento/rastreo/diagnostico] reserva", mensaje(e));
    if (conHistorial) {
      const vacio: RespuestaHistorialRastreo = { reserva_id: id, conductor: null, servicios: [], patron: null, recortado: false,
        error: "No se pudo leer el servicio. Vuelve a intentarlo en unos minutos." };
      return NextResponse.json(vacio);
    }
    return NextResponse.json(diagnosticoNoCalculado(id, null, Date.now(),
      "No se pudo leer el servicio. Vuelve a intentarlo en unos minutos."));
  }
  if (!reserva) return err(404, { error: `No existe el servicio #${id}.` });
  const fecha: string | null = typeof reserva.fecha_servicio === "string" ? reserva.fecha_servicio : null;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return err(400, { error: `El servicio #${id} no tiene fecha: no hay ventana que medir.` });
  }
  if (fecha < restarDias(hoy, DIAS_RASTREO)) {
    return err(400, { error: `El servicio #${id} es del ${fecha}: el rastreo se diagnostica solo de los últimos ${DIAS_RASTREO} días. Para el historial del conductor, usa Salud del GPS.` });
  }

  if (!conHistorial) {
    try {
      const p = await obtenerDiagnostico(id, reserva, hoy);
      if (!p) return err(404, { error: `No existe el servicio #${id}.` });
      return NextResponse.json(p);
    } catch (e: unknown) {
      if (e instanceof Ocupado) return ocupado();
      console.error("[api/seguimiento/rastreo/diagnostico]", mensaje(e));
      return NextResponse.json(diagnosticoNoCalculado(id, fecha, Date.now(),
        "No se pudo calcular el diagnóstico de este servicio. Vuelve a abrirlo en unos minutos."));
    }
  }

  // ── Historial del conductor ────────────────────────────────────────────────────────
  // El conductor es el MISMO del diagnóstico (el de la traza; si no, el de la reserva): el modal pide
  // las dos cosas a la vez, así que esto espera al cálculo en vuelo en vez de leer la traza otra vez.
  let conductor: RespuestaHistorialRastreo["conductor"] = null;
  try {
    conductor = (await obtenerDiagnostico(id, reserva, hoy))?.equipo.conductor ?? null;
  } catch (e: unknown) {
    if (e instanceof Ocupado) return ocupado();
    // Sin diagnóstico, el de la reserva: el historial no depende de que la traza se haya podido leer.
  }
  if (!conductor) {
    const c = conductorDeReserva(reserva);
    conductor = c ? { ...c, por: "reserva" } : null;
  }
  if (!conductor) {
    const sin: RespuestaHistorialRastreo = { reserva_id: id, conductor: null, servicios: [], patron: null, recortado: false,
      error: "El servicio no tiene conductor asignado ni posiciones GPS: no hay de quién buscar el historial." };
    return NextResponse.json(sin);
  }
  const c = conductor;
  const clave = `${c.tabla}:${c.id}:${id}`;
  try {
    const cacheado = leer(cacheHist, clave);
    if (cacheado) return NextResponse.json(cacheado);
    let promesa = enVueloHist.get(clave);
    if (!promesa) {
      promesa = turno(async () => ({
        reserva_id: id, conductor: c,
        ...await historialDelConductor(c, { id, fecha_servicio: fecha, hora_servicio: reserva.hora_servicio ?? null }, { hoy, ahoraMs: Date.now() }),
      }))
        .then((p) => { guardar(cacheHist, clave, p, TTL_HISTORIAL_MS); return p; })
        .finally(() => enVueloHist.delete(clave));
      enVueloHist.set(clave, promesa);
    }
    return NextResponse.json(await promesa);
  } catch (e: unknown) {
    if (e instanceof Ocupado) return ocupado();
    console.error("[api/seguimiento/rastreo/diagnostico] historial", mensaje(e));
    const fallo: RespuestaHistorialRastreo = { reserva_id: id, conductor: c, servicios: [], patron: null, recortado: false,
      error: "No se pudo leer el historial del conductor. Vuelve a abrir el diagnóstico en unos minutos." };
    return NextResponse.json(fallo);
  }
}
