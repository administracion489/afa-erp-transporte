// app/api/seguimiento/recorrido/route.ts
// EL RECORRIDO DE UN SERVICIO, PARA EL MAPA «Ver recorrido» (/seguimiento/gps/[id]): la traza GPS
// real, sus huecos de señal y los episodios de velocidad con las posiciones donde ocurrieron
// (lib/flota/recorrido.ts). Los episodios son los de la columna «Excesos» de /uso-flota → Servicios:
// misma traza, mismo motor.
//
//   GET ?reserva=<id>&umbral=<km/h>   → RecorridoServicio
//
// LEE, no escribe nada, y no consulta ningún servicio de mapas: la pantalla dibuja con Mapbox.
//
// Autorización: cualquiera de los tres módulos que enlazan a este mapa (Seguimiento, Monitoreo
// —/seguridad-vial— y Vehículos —/uso-flota—). Los tres ya ven la velocidad de ese servicio en su
// propia pantalla. La service-role solo vive en el lector.
//
// Respuestas:
//   400 · `reserva` no es un entero > 0, el umbral no es uno de los aceptados, la reserva no tiene
//         fecha, o es de hace más de DIAS_RASTREO días
//   404 · la reserva no existe
//   503 · la instancia tiene demasiados cálculos esperando (`reintentar: true`, con Retry-After)
//   500 · no se pudo leer la reserva o sus paradas (el mapa lo dice y ofrece reintentar)

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { DIAS_RASTREO } from "@/lib/gps-cobertura-datos";
import { leerReservaDiag, type FilaReservaDiag } from "@/lib/gps-diagnostico-datos";
import { leerUmbral } from "@/lib/flota/excesos";
import { recorridoDeReserva } from "@/lib/flota/recorrido-datos";
import type { RecorridoServicio } from "@/lib/flota/recorrido";
import { hoyLimaFecha } from "@/lib/retrasos-datos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── CACHÉ ─────────────────────────────────────────────────────────────────────────────
// Un servicio de HOY puede seguir en ruta: 30 s. Uno de otro día ya no cambia: 10 min. La entrada
// guarda el «hoy» con que se calculó: un día leído a las 23:59 todavía estaba en curso y no se sirve
// como cerrado pasada la medianoche.
const TTL_HOY_MS = 30_000;
const TTL_OTRO_DIA_MS = 10 * 60_000;
const MAX_CACHE = 200;
type Entrada = { at: number; ttl: number; hoy: string; payload: RecorridoServicio };
const cache = new Map<string, Entrada>();
const enVuelo = new Map<string, Promise<RecorridoServicio | null>>();

function leerCache(k: string, hoy: string): RecorridoServicio | null {
  const e = cache.get(k);
  return e && e.hoy === hoy && Date.now() - e.at < e.ttl ? e.payload : null;
}
function guardarCache(k: string, hoy: string, payload: RecorridoServicio, ttl: number) {
  cache.delete(k);
  cache.set(k, { at: Date.now(), ttl, hoy, payload });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

// ── TOPE DE CÁLCULOS ──────────────────────────────────────────────────────────────────
// Cada recorrido lee la traza ENTERA de un servicio (miles de puntos). A lo sumo MAX_CALCULOS a la
// vez por instancia; los demás ESPERAN su turno, y con más de MAX_EN_COLA se responde 503: una
// persona abre un mapa con un clic, un script pide cientos.
const MAX_CALCULOS = 3;
const MAX_EN_COLA = 6;
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
const err = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  NextResponse.json({ error, ...extra }, { status, headers });

function restarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, ["seguimiento", "monitoreo", "vehiculos"]);
  if (!auth.ok) return err(auth.status, auth.error);

  const params = new URL(req.url).searchParams;
  const crudo = params.get("reserva") ?? "";
  const id = /^\d{1,15}$/.test(crudo) ? Number(crudo) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    return err(400, "Falta el servicio: se espera ?reserva=<id> con un número entero mayor que 0.");
  }
  const u = leerUmbral((params.get("umbral") ?? "").trim());
  if (!u.ok) return err(400, u.error);
  const umbral = u.umbral;

  const hoy = hoyLimaFecha();
  const clave = `${id}|${umbral}`;
  const cacheado = leerCache(clave, hoy);
  if (cacheado) return NextResponse.json(cacheado);

  // La reserva se lee primero: decide el 404 y la ventana de DIAS_RASTREO días.
  let reserva: FilaReservaDiag | null;
  try {
    reserva = await leerReservaDiag(id);
  } catch (e: unknown) {
    console.error("[api/seguimiento/recorrido] reserva", mensaje(e));
    return err(500, "No se pudo leer el servicio. Vuelve a intentarlo en unos minutos.");
  }
  if (!reserva) return err(404, `No existe el servicio #${id}.`);
  const fecha: string | null = typeof reserva.fecha_servicio === "string" ? reserva.fecha_servicio : null;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return err(400, `El servicio #${id} no tiene fecha: no hay recorrido que dibujar.`);
  }
  if (fecha < restarDias(hoy, DIAS_RASTREO)) {
    return err(400, `El servicio #${id} es del ${fecha}: el recorrido se dibuja solo de los últimos ${DIAS_RASTREO} días.`);
  }

  try {
    let promesa = enVuelo.get(clave);
    if (!promesa) {
      const r = reserva;
      promesa = turno(() => recorridoDeReserva(id, { hoy, ahoraMs: Date.now(), umbral, reserva: r }))
        .then((p) => {
          if (p) guardarCache(clave, hoy, p, fecha === hoy ? TTL_HOY_MS : TTL_OTRO_DIA_MS);
          return p;
        })
        .finally(() => enVuelo.delete(clave));
      enVuelo.set(clave, promesa);
    }
    const p = await promesa;
    if (!p) return err(404, `No existe el servicio #${id}.`);
    return NextResponse.json(p);
  } catch (e: unknown) {
    if (e instanceof Ocupado) {
      return err(503, "Hay muchos recorridos calculándose ahora mismo. Vuelve a intentarlo en unos segundos.",
        { reintentar: true }, { "Retry-After": "10" });
    }
    console.error("[api/seguimiento/recorrido]", mensaje(e));
    return err(500, "No se pudo leer el recorrido de este servicio. Vuelve a intentarlo en unos minutos.");
  }
}
