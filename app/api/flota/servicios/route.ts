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
//   · el umbral solo de PASO_UMBRAL_KMH en PASO_UMBRAL_KMH (60, 65… 130: 15 valores; otro → 400). Entra
//     en la clave de la caché: con cualquier entero bastaba con variarlo para esquivarla;
//   · a lo sumo 2 días midiéndose a la vez por instancia y 6 esperando (`crearTurno`): pasado eso,
//     503 con `reintentar` (una cola más larga no cabe en maxDuration = 60 s);
//   · peticiones simultáneas del mismo día y umbral comparten UN cálculo;
//   · la caché guarda a lo sumo MAX_CACHE combinaciones (60 s si se calculó como el día de HOY, 30 min
//     si no). Lo decide el «hoy» del CÁLCULO, no el de la lectura: un día medido a las 23:59 todavía
//     estaba en curso y no se sirve como día cerrado pasada la medianoche.
// Un error de cálculo responde 200 con `error` y la lista vacía: nunca un 500 ni un «0 servicios».

/* eslint-disable @typescript-eslint/no-explicit-any -- el payload de la caché es la respuesta ya armada */
import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { DIAS_RASTREO, MAX_RESERVAS } from "@/lib/gps-cobertura-datos";
import { estadisticaDelDia } from "@/lib/flota/servicio-estadistica-datos";
import { respuestaConError, validarUmbral, type RespuestaServicios } from "@/lib/flota/servicio-estadistica";
import { fechaLima } from "@/lib/alertas-horario";
import { crearTurno, ColaLlena } from "@/lib/turno-calculo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TTL_HOY_MS = 60_000;
const TTL_OTRO_DIA_MS = 30 * 60_000;
const MAX_CACHE = 40;
/** Un cálculo con el «hoy» de Lima con que se hizo: de él sale el TTL, no del momento de leerlo. */
type Calculo = { payload: RespuestaServicios; hoyCalculo: string };
const cache = new Map<string, { at: number; ttl: number; hoyCalculo: string; payload: RespuestaServicios }>();
const enVuelo = new Map<string, Promise<Calculo>>();
const turno = crearTurno(2, 6);

function guardar(clave: string, fecha: string, c: Calculo) {
  cache.delete(clave);
  cache.set(clave, { at: Date.now(), ttl: fecha === c.hoyCalculo ? TTL_HOY_MS : TTL_OTRO_DIA_MS, hoyCalculo: c.hoyCalculo, payload: c.payload });
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
  const vu = validarUmbral(params.get("umbral"));
  if (!vu.ok) return NextResponse.json({ error: vu.error }, { status: 400 });
  const umbral = vu.umbral;

  const clave = `${fecha}|${umbral}`;
  const cacheado = cache.get(clave);
  // Una entrada calculada con otro «hoy» (se cruzó la medianoche) no se sirve: se vuelve a medir.
  if (cacheado && Date.now() - cacheado.at < cacheado.ttl && cacheado.hoyCalculo === hoy) return NextResponse.json(cacheado.payload);

  // Peticiones simultáneas comparten UN cálculo (mismo patrón que /api/seguimiento/rastreo).
  let promesa = enVuelo.get(clave);
  if (!promesa) {
    // «Ahora» se toma al EMPEZAR el cálculo (puede haber esperado su turno), y «hoy» con él.
    promesa = turno(async (): Promise<Calculo> => {
      const ahora = Date.now();
      const hoyCalculo = fechaLima(ahora);
      return { payload: await estadisticaDelDia(fecha, hoyCalculo, ahora, umbral), hoyCalculo };
    }).finally(() => enVuelo.delete(clave));
    enVuelo.set(clave, promesa);
  }
  try {
    const c = await promesa;
    guardar(clave, fecha, c);
    return NextResponse.json(c.payload);
  } catch (e: any) {
    if (e instanceof ColaLlena) {
      return NextResponse.json({ error: e.message, reintentar: true }, { status: 503 });
    }
    console.error("[api/flota/servicios]", e?.message);
    // Nunca un «0 servicios»: la lista va vacía CON el motivo.
    return NextResponse.json(respuestaConError(fecha, umbral, "No se pudo medir la estadística de este día. Reintenta en unos minutos.", MAX_RESERVAS));
  }
}
