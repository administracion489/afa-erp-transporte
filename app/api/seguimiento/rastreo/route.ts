// app/api/seguimiento/rastreo/route.ts
// RASTREO GPS de los servicios de un día, para la torre de control (/seguimiento): la columna
// RASTREO, el aviso «unidades con rastreo incompleto» y el porcentaje del modal GPS.
//
// Por qué en el servidor: medir la cobertura exige la traza ENTERA de cada servicio (miles de
// puntos por viaje). Calcularla en cada pestaña abierta multiplicaría esas lecturas por N; aquí
// se calcula una vez, con caché, y el navegador recibe un veredicto por servicio.
//
// La medición es la MISMA de /gps-salud (lib/gps-cobertura.ts): un servicio no puede salir con
// una cobertura en una pantalla y otra en la vecina. LEE, no avisa ni escribe nada.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { rastreoDelDia } from "@/lib/gps-cobertura-datos";
import { hoyLimaFecha } from "@/lib/retrasos-datos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// HOY se refresca a menudo (hay servicios en ruta); un día cerrado ya no cambia.
const TTL_HOY_MS = 45_000;
const TTL_OTRO_DIA_MS = 10 * 60_000;
const cache = new Map<string, { at: number; payload: any }>();
const enVuelo = new Map<string, Promise<any>>();

// Topes contra el abuso (auditoría AppSec): cada día medido lee la traza ENTERA de sus servicios.
//  · Solo los últimos DIAS_ATRAS días: la torre revisa el día y los recientes; lo histórico por
//    conductor vive en /gps-salud.
//  · A lo sumo MAX_CALCULOS días midiéndose a la vez entre TODAS las fechas: pedir 30 fechas en
//    paralelo no lanza 30 lecturas pesadas.
//  · La caché guarda a lo sumo MAX_CACHE fechas.
const DIAS_ATRAS = 90;
const MAX_CALCULOS = 2;
const MAX_CACHE = 40;
let calculando = 0;
const cola: (() => void)[] = [];
async function turno<T>(fn: () => Promise<T>): Promise<T> {
  // El cupo se TRASPASA al siguiente de la cola sin soltarlo: si se soltara primero, una petición
  // nueva podría colarse entre medias y pasar del tope.
  if (calculando >= MAX_CALCULOS) await new Promise<void>((ok) => cola.push(ok));
  else calculando++;
  try { return await fn(); }
  finally { const siguiente = cola.shift(); if (siguiente) siguiente(); else calculando--; }
}
function guardar(fecha: string, payload: any) {
  cache.delete(fecha);
  cache.set(fecha, { at: Date.now(), payload });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}
function restarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "seguimiento");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const hoy = hoyLimaFecha();
  const fecha = new URL(req.url).searchParams.get("fecha") || hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return NextResponse.json({ error: "Fecha inválida (se espera AAAA-MM-DD)" }, { status: 400 });
  }
  // Un día futuro no tiene nada que medir: se responde vacío sin leer GPS.
  if (fecha > hoy) return NextResponse.json({ fecha, rastreo: {} });
  if (fecha < restarDias(hoy, DIAS_ATRAS)) {
    return NextResponse.json({ error: `El rastreo se mide solo de los últimos ${DIAS_ATRAS} días. Para el historial por conductor, usa Salud del GPS.` }, { status: 400 });
  }

  const ttl = fecha === hoy ? TTL_HOY_MS : TTL_OTRO_DIA_MS;
  const cacheado = cache.get(fecha);
  if (cacheado && Date.now() - cacheado.at < ttl) return NextResponse.json(cacheado.payload);

  // Peticiones simultáneas comparten UN cálculo (mismo patrón que /api/seguimiento/retrasos).
  let promesa = enVuelo.get(fecha);
  if (!promesa) {
    promesa = turno(async () => ({ fecha, medido_en: new Date().toISOString(), rastreo: await rastreoDelDia(fecha, hoy, Date.now()) }))
      .finally(() => enVuelo.delete(fecha));
    enVuelo.set(fecha, promesa);
  }
  try {
    const payload = await promesa;
    guardar(fecha, payload);
    return NextResponse.json(payload);
  } catch (e: any) {
    // La torre nunca se cae por este módulo: sin veredictos, la columna dice que no pudo medir.
    console.error("[api/seguimiento/rastreo]", e?.message);
    return NextResponse.json({ fecha, rastreo: {}, error: "No se pudo medir el rastreo" }, { status: 200 });
  }
}
