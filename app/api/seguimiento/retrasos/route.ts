// app/api/seguimiento/retrasos/route.ts
// Veredicto de PUNTUALIDAD de los servicios de un día, para la torre de control.
//
// Por qué existe un endpoint en vez de calcularlo en el navegador:
//   1. La posición previa al inicio vive en fixes SIN reserva_id (modo "conectado"),
//      que hay que buscar por conductor/vehículo — una consulta por servicio. Hacerlo
//      desde N pestañas abiertas multiplicaría esa carga por N.
//   2. El ETA con tráfico se paga (SKU Advanced). Un solo pagador —el servidor, con
//      caché y techo— en vez de un pagador por pestaña.
//   3. El mismo veredicto lo consume el motor de avisos, así que el cálculo debe estar
//      en un único sitio o la pantalla y el WhatsApp acabarán contradiciéndose (que es
//      justo lo que pasaba con la gracia de 15 min en la torre y 10 min en el cron).
//
// LEE, no avisa: este endpoint nunca manda nada ni marca nada. Los avisos los emite
// /api/alertas-flota/tick, con su dedupe y sus destinatarios configurables.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { veredictosDelDia, hoyLimaFecha, ahoraLimaMinutos } from "@/lib/retrasos-datos";
import { esAlertaViva } from "@/lib/retrasos";
import { gastoEtaHoy } from "@/lib/eta-trafico";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Caché de proceso: varios operadores mirando la torre a la vez comparten un cálculo.
// 20 s es el compromiso entre "en vivo" y no repetir N consultas de GPS por refresco.
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; payload: any }>();
const enVuelo = new Map<string, Promise<any>>();

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "seguimiento");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const fecha = new URL(req.url).searchParams.get("fecha") || hoyLimaFecha();
  const hoy = hoyLimaFecha();

  // Días distintos de HOY no tienen veredicto vivo: la puntualidad es una pregunta del
  // presente. Se responde vacío en vez de recorrer GPS de un día cerrado.
  if (fecha !== hoy) {
    return NextResponse.json({ fecha, hoy: false, veredictos: {}, resumen: vacio() });
  }

  const cacheado = cache.get(fecha);
  if (cacheado && Date.now() - cacheado.at < TTL_MS) return NextResponse.json(cacheado.payload);

  // Peticiones simultáneas comparten UN cálculo (mismo patrón que /api/ruta:41).
  let promesa = enVuelo.get(fecha);
  if (!promesa) {
    promesa = calcular(fecha).finally(() => enVuelo.delete(fecha));
    enVuelo.set(fecha, promesa);
  }
  try {
    const payload = await promesa;
    cache.set(fecha, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e: any) {
    // Nunca tumbar la torre por este módulo: sin veredictos la pantalla cae al
    // comportamiento anterior (hora vs. estado) y sigue siendo usable.
    console.error("[api/seguimiento/retrasos]", e?.message);
    return NextResponse.json({ fecha, hoy: true, veredictos: {}, resumen: vacio(), error: e?.message }, { status: 200 });
  }
}

function vacio() {
  return { retraso: 0, riesgo: 0, en_punto_sin_iniciar: 0, retraso_en_ruta: 0,
           sin_rastreo: 0, no_realizado: 0, inicio_tarde: 0, vivas: 0 };
}

async function calcular(fecha: string) {
  // La torre NO paga ETA: el que paga es el cron (tick), que además deja el resultado en
  // eta_trafico_cache — así la pantalla ve el ETA real sin haber gastado un centavo.
  const { veredictos } = await veredictosDelDia({ fecha, permitirPago: false });

  const resumen = vacio();
  const salida: Record<string, any> = {};
  for (const [id, v] of veredictos) {
    if (v.nivel === "na") continue;
    salida[id] = {
      nivel: v.nivel, minutos: v.minutos, causa: v.causa, evidencia: v.evidencia,
      escala: v.escala, posicion: v.posicion.estado, distancia_m: v.posicion.distanciaM,
      gps_hace_min: v.posicion.hace, confianza: v.posicion.confianza,
    };
    if (v.nivel in resumen) (resumen as any)[v.nivel]++;
    if (esAlertaViva(v)) resumen.vivas++;
  }

  return {
    fecha, hoy: true,
    ahora_min: ahoraLimaMinutos(),
    veredictos: salida,
    resumen,
    eta: await gastoEtaHoy(),
  };
}
