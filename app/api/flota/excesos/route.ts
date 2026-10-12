// app/api/flota/excesos/route.ts
// EXCESOS DE VELOCIDAD sostenidos y corroborados de la flota, para /seguridad-vial.
//
// GET ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&umbral=60..130&fuera=0|1
//   · como mucho 7 días por consulta (la pantalla pide un mes en tandas y las une con
//     `unirRespuestasExcesos`, lib/flota/excesos.ts), nada en el futuro y nada anterior a hoy −
//     DIAS_RASTREO (90): cada día lee las posiciones rápidas de TODA la flota;
//   · umbral entre 60 y 130 km/h de PASO_UMBRAL_KMH en PASO_UMBRAL_KMH (60, 65… 130; 90 por defecto;
//     otro → 400). Entra en la clave de la caché: con cualquier entero bastaba con variarlo para esquivarla;
//   · fuera=1 lista además los excesos FUERA de servicio (siempre se cuentan; nunca suman al ranking),
//     con el pico aproximado a ~1 km. Con fuera=0, el directorio no nombra a quien solo aparece por ellos.
//
// Responde `RespuestaExcesos` (lib/flota/excesos.ts). Sin la migración responde 200 con `sin_migracion`
// (la pantalla nombra el SQL). Un error de cálculo responde 200 con `error` y las listas vacías: NUNCA
// un «0 excesos». No devuelve teléfonos.
//
// Por qué en el servidor: las posiciones son de TODA la flota y solo las lee el service-role
// (fn_gps_puntos_rapidos no la puede ejecutar nadie más). Se calcula una vez por rango con caché, y el
// comportamiento al volante por conductor queda detrás del módulo `monitoreo`, como /gps-salud.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { fechaLima } from "@/lib/alertas-horario";
import { DIAS_RASTREO } from "@/lib/gps-cobertura-datos";
import { crearTurno, ColaLlena } from "@/lib/turno-calculo";
import { excesosDelRango, ErrorLecturaExcesos } from "@/lib/flota/excesos-datos";
import { respuestaVacia, validarConsultaExcesos, vistaRespuesta, type RespuestaExcesos } from "@/lib/flota/excesos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Un rango que incluye HOY cambia (hay servicios en ruta); uno cerrado ya no.
const TTL_CON_HOY_MS = 2 * 60_000;
const TTL_CERRADO_MS = 15 * 60_000;
const MAX_CACHE = 20;
/** Un cálculo con el «hoy» de Lima con que se hizo: de él sale el TTL, no del momento de leerlo. */
type Calculo = { payload: RespuestaExcesos; hoyCalculo: string };
const cache = new Map<string, { at: number; ttl: number; hoyCalculo: string; payload: RespuestaExcesos }>();
const enVuelo = new Map<string, Promise<Calculo>>();
// A lo sumo 2 rangos midiéndose a la vez por instancia; 6 esperando (una cola más larga no cabe en
// maxDuration = 60 s); más → 503 con `reintentar`.
const turno = crearTurno(2, 6);

function guardar(clave: string, hasta: string, c: Calculo) {
  cache.delete(clave);
  cache.set(clave, { at: Date.now(), ttl: hasta >= c.hoyCalculo ? TTL_CON_HOY_MS : TTL_CERRADO_MS, hoyCalculo: c.hoyCalculo, payload: c.payload });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "monitoreo");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const hoy = fechaLima(Date.now());
  const sp = new URL(req.url).searchParams;
  const v = validarConsultaExcesos({ desde: sp.get("desde"), hasta: sp.get("hasta"), umbral: sp.get("umbral"), fuera: sp.get("fuera") }, hoy, DIAS_RASTREO);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const { desde, hasta, umbral, incluirFueraDeServicio } = v.consulta;

  const clave = `${desde}|${hasta}|${umbral}`;
  const cacheado = cache.get(clave);
  // Una entrada calculada con otro «hoy» (se cruzó la medianoche) no se sirve: se vuelve a medir.
  if (cacheado && Date.now() - cacheado.at < cacheado.ttl && cacheado.hoyCalculo === hoy) {
    return NextResponse.json(vistaRespuesta(cacheado.payload, incluirFueraDeServicio));
  }

  // Peticiones simultáneas del mismo rango comparten UN cálculo.
  let promesa = enVuelo.get(clave);
  if (!promesa) {
    // «Hoy» se toma al EMPEZAR el cálculo (puede haber esperado su turno): decide si el rango estaba abierto.
    promesa = turno(async (): Promise<Calculo> => {
      const hoyCalculo = fechaLima(Date.now());
      return { payload: await excesosDelRango({ desde, hasta, umbral }), hoyCalculo };
    }).finally(() => enVuelo.delete(clave));
    enVuelo.set(clave, promesa);
  }
  try {
    const c = await promesa;
    const payload = c.payload;
    // Sin la migración no se cachea: en cuanto alguien la corra, la próxima consulta ya mide.
    if (!payload.sin_migracion) guardar(clave, hasta, c);
    return NextResponse.json(vistaRespuesta(payload, incluirFueraDeServicio));
  } catch (e) {
    if (e instanceof ColaLlena) {
      return NextResponse.json({ error: "Hay demasiadas mediciones en curso; reintenta en unos segundos.", reintentar: true }, { status: 503 });
    }
    // Nunca un 500 ni un «0 excesos»: la pantalla dice que no se pudo medir y por qué.
    console.error("[api/flota/excesos]", e instanceof ErrorLecturaExcesos ? e.detalle : e);
    const mensaje = e instanceof ErrorLecturaExcesos && e.message
      ? e.message
      : "No se pudieron medir los excesos de velocidad. Reintenta en unos minutos.";
    return NextResponse.json(respuestaVacia({ desde, hasta, umbral, error: mensaje }), { status: 200 });
  }
}
