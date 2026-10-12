// app/api/flota/uso/route.ts
// USO DE FLOTA de un periodo (la pestaña Resumen de /uso-flota): km por unidad y día con su fuente
// (odómetro saneado o, si no hay jornada, el GPS de sus servicios como PISO), servicios, horas, unidades
// sin uso, gasto de combustible y CO₂ de lo comprado, comparado con el periodo anterior del mismo largo.
//
// GET /api/flota/uso?desde=AAAA-MM-DD&hasta=AAAA-MM-DD   (por defecto, los últimos 7 días)
//   · módulo `vehiculos` (son métricas de la flota);
//   · 31 días como máximo y nada futuro: cada consulta puede leer hasta MAX_TRAZAS_RELLENO trazas;
//   · a lo sumo 2 cálculos a la vez por instancia y 20 esperando (lib/turno-calculo.ts); con más, 503;
//   · caché en memoria: 2 min si el periodo incluye hoy, 15 min si no; a lo sumo MAX_CACHE periodos.
// LEE, no escribe nada. El motor es lib/flota/uso-flota.ts (puro) y el lector lib/flota/uso-flota-datos.ts.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { fechaLima } from "@/lib/alertas-horario";
import { crearTurno, ColaLlena } from "@/lib/turno-calculo";
import { calcularUso, LecturaFallida } from "@/lib/flota/uso-flota-datos";
import { diasEntreFechas, sumarDias } from "@/lib/odometro-analitica";
import type { RespuestaUso, ErrorUso, CodigoErrorUso } from "@/lib/flota/uso-flota";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Días como máximo de un periodo. */
const MAX_DIAS = 31;
const TTL_CON_HOY_MS = 2 * 60_000;
const TTL_PASADO_MS = 15 * 60_000;
const MAX_CACHE = 30;

const cache = new Map<string, { at: number; ttl: number; payload: RespuestaUso }>();
const enVuelo = new Map<string, Promise<RespuestaUso>>();
const turno = crearTurno(2, 20);

function guardar(clave: string, ttl: number, payload: RespuestaUso) {
  cache.delete(clave);
  cache.set(clave, { at: Date.now(), ttl, payload });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

/** ¿Es una fecha AAAA-MM-DD que existe? (rechaza el 31/04 y el 30/02) */
function fechaValida(f: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === f && f >= "2000-01-01";
}

const error = (status: number, codigo: CodigoErrorUso, mensaje: string, extra: Partial<ErrorUso> = {}) =>
  NextResponse.json({ ok: false, codigo, error: mensaje, ...extra } satisfies ErrorUso, { status });

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "vehiculos");
  if (!auth.ok) {
    return error(auth.status, auth.status === 401 ? "sin_sesion" : "sin_permiso",
      auth.status === 401 ? "Tu sesión no es válida: vuelve a ingresar."
        : `${auth.error}. El uso de flota necesita un usuario activo con el permiso del módulo Vehículos (lo da un administrador en Usuarios).`);
  }

  const hoy = fechaLima(Date.now());
  const sp = new URL(req.url).searchParams;
  const hasta = sp.get("hasta") || hoy;
  // `hasta` se valida ANTES de derivar el `desde` por defecto (sumarDias lanza con una fecha inválida).
  const desde = sp.get("desde") || (fechaValida(hasta) ? sumarDias(hasta, -6) : "");
  if (!fechaValida(desde) || !fechaValida(hasta)) {
    return error(400, "fecha_invalida", "Fecha inválida: se espera AAAA-MM-DD (por ejemplo 2026-10-05).");
  }
  if (desde > hasta) return error(400, "rango_invertido", `El periodo empieza (${desde}) después de terminar (${hasta}).`);
  if (hasta > hoy) return error(400, "futuro", `El periodo no puede pasar de hoy (${hoy}): lo futuro no tiene uso que medir.`);
  if (diasEntreFechas(desde, hasta) + 1 > MAX_DIAS) {
    return error(400, "rango_largo", `El periodo puede tener ${MAX_DIAS} días como máximo; pediste ${diasEntreFechas(desde, hasta) + 1}.`);
  }

  const clave = `${desde}|${hasta}`;
  const ttl = hasta >= hoy ? TTL_CON_HOY_MS : TTL_PASADO_MS;
  const cacheado = cache.get(clave);
  if (cacheado && Date.now() - cacheado.at < cacheado.ttl && cacheado.payload.hoy === hoy) {
    return NextResponse.json(cacheado.payload);
  }

  // Peticiones simultáneas del mismo periodo comparten UN cálculo.
  let promesa = enVuelo.get(clave);
  if (!promesa) {
    // «Ahora» se toma al EMPEZAR el cálculo (puede haber esperado su turno), y «hoy» con él.
    promesa = turno(() => { const ahora = Date.now(); return calcularUso(desde, hasta, fechaLima(ahora), ahora); })
      .finally(() => enVuelo.delete(clave));
    enVuelo.set(clave, promesa);
  }
  try {
    const payload = await promesa;
    guardar(clave, ttl, payload);
    return NextResponse.json(payload);
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (e instanceof ColaLlena) {
      return error(503, "cola_llena", "Hay demasiados cálculos de uso de flota en curso; reintenta en unos segundos.", { reintentar: true });
    }
    // Un fallo de lectura NUNCA se responde como un periodo vacío: se dice qué no se pudo leer.
    console.error("[api/flota/uso]", e?.message);
    const tabla = e instanceof LecturaFallida ? e.tabla : null;
    return error(500, "lectura_fallida",
      tabla
        ? `No se pudo leer «${tabla}» de la base: no se muestra el uso de flota para no dar números a medias. Reintenta en unos segundos; si persiste, revisa los registros de /api/flota/uso.`
        : "No se pudo calcular el uso de flota: no se muestran números a medias. Reintenta en unos segundos; si persiste, revisa los registros de /api/flota/uso.",
      { reintentar: true });
  }
}
