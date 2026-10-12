// app/api/flota/servicios/route.ts
// GET /api/flota/servicios?fecha=AAAA-MM-DD&umbral=90 — la estadística de cada servicio de UN día
// (km por GPS, marcha, excesos, combustible, costo y CO₂ ESTIMADOS) y su corte por cliente, para
// /uso-flota → Servicios. El cálculo es lib/flota/servicio-estadistica.ts (puro) y la lectura,
// lib/flota/servicio-estadistica-datos.ts. LEE: no avisa ni escribe nada.
//
// Por qué en el servidor y con caché: medir un día lee la traza ENTERA de cada servicio (como la
// columna RASTREO de la torre, con la que comparte el conjunto, el techo y el veredicto). La pantalla
// pide un día por llamada (una semana son siete llamadas seguidas).
//
// Topes contra el abuso, los de la torre:
//   · solo los últimos DIAS_RASTREO días, y nunca un día futuro;
//   · a lo sumo 2 días midiéndose a la vez por instancia y 20 esperando (`crearTurno`): pasado eso,
//     503 con `reintentar`;
//   · peticiones simultáneas del mismo día y umbral comparten UN cálculo;
//   · la caché guarda a lo sumo MAX_CACHE combinaciones (60 s si es hoy, 30 min si no).
// Un error de cálculo responde 200 con `error` y la lista vacía: nunca un 500 ni un «0 servicios».

/* eslint-disable @typescript-eslint/no-explicit-any -- el payload de la caché es la respuesta ya armada */
import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { DIAS_RASTREO, MAX_RESERVAS } from "@/lib/gps-cobertura-datos";
import { estadisticaDelDia } from "@/lib/flota/servicio-estadistica-datos";
import { normalizarUmbral, respuestaConError, UMBRAL_SERVICIO, type RespuestaServicios } from "@/lib/flota/servicio-estadistica";
import { fechaLima } from "@/lib/alertas-horario";
import { crearTurno, ColaLlena } from "@/lib/turno-calculo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TTL_HOY_MS = 60_000;
const TTL_OTRO_DIA_MS = 30 * 60_000;
const MAX_CACHE = 40;
const cache = new Map<string, { at: number; payload: RespuestaServicios }>();
const enVuelo = new Map<string, Promise<RespuestaServicios>>();
const turno = crearTurno(2, 20);

function guardar(clave: string, payload: RespuestaServicios) {
  cache.delete(clave);
  cache.set(clave, { at: Date.now(), payload });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

/** «AAAA-MM-DD» que además existe en el calendario (2026-02-30 no). */
function fechaValida(f: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function restarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "vehiculos");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const ahoraMs = Date.now();
  const hoy = fechaLima(ahoraMs);
  const params = new URL(req.url).searchParams;
  const fecha = params.get("fecha") || hoy;
  if (!fechaValida(fecha)) {
    return NextResponse.json({ error: "Fecha inválida: se espera AAAA-MM-DD." }, { status: 400 });
  }
  if (fecha > hoy) {
    return NextResponse.json({ error: "Ese día todavía no ocurrió: no hay servicios que medir." }, { status: 400 });
  }
  if (fecha < restarDias(hoy, DIAS_RASTREO)) {
    return NextResponse.json({ error: `La estadística por servicio se mide solo de los últimos ${DIAS_RASTREO} días (lee el GPS de cada servicio).` }, { status: 400 });
  }
  const umbral = normalizarUmbral(params.get("umbral"));
  if (umbral == null) {
    return NextResponse.json({ error: `Umbral inválido: un entero entre ${UMBRAL_SERVICIO.min} y ${UMBRAL_SERVICIO.max} km/h.` }, { status: 400 });
  }

  const clave = `${fecha}|${umbral}`;
  const ttl = fecha === hoy ? TTL_HOY_MS : TTL_OTRO_DIA_MS;
  const cacheado = cache.get(clave);
  if (cacheado && Date.now() - cacheado.at < ttl) return NextResponse.json(cacheado.payload);

  // Peticiones simultáneas comparten UN cálculo (mismo patrón que /api/seguimiento/rastreo).
  let promesa = enVuelo.get(clave);
  if (!promesa) {
    promesa = turno(() => estadisticaDelDia(fecha, hoy, Date.now(), umbral)).finally(() => enVuelo.delete(clave));
    enVuelo.set(clave, promesa);
  }
  try {
    const payload = await promesa;
    guardar(clave, payload);
    return NextResponse.json(payload);
  } catch (e: any) {
    if (e instanceof ColaLlena) {
      return NextResponse.json({ error: e.message, reintentar: true }, { status: 503 });
    }
    console.error("[api/flota/servicios]", e?.message);
    // Nunca un «0 servicios»: la lista va vacía CON el motivo.
    return NextResponse.json(respuestaConError(fecha, umbral, "No se pudo medir la estadística de este día. Reintenta en unos minutos.", MAX_RESERVAS));
  }
}
