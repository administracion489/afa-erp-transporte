// app/api/cotizaciones/horas-paraderos/route.ts
// La duración de cada tramo de una ruta con el TRÁFICO PREVISTO a la hora en que el bus sale
// de cada paradero. Lo usa el botón «⏱ Calcular horas» de /cotizaciones en su modo con
// tráfico; el modo sin tráfico va por /api/ruta (cacheado, Essentials).
//
// POR QUÉ UNA CONSULTA POR TRAMO, EN SECUENCIA: Google Directions (legacy) no devuelve
// `duration_in_traffic` por tramo cuando la ruta lleva paradas intermedias. Así que cada
// tramo se pide solo (origen → destino, sin intermedios) con `departure_time` = la salida
// prevista de ESE tramo, y esa salida depende de cuánto tardó el anterior: por eso van en
// orden y no en paralelo. La cadena la arma `pasoCadena` (lib/paradas-horario.ts), la MISMA
// función con la que la pantalla calcula las horas que publica — si cada lado encadenara a
// su manera, las horas saldrían de un tráfico consultado a otra hora.
//
// LO CARO, Y CÓMO SE CONTIENE: cada tramo es una consulta «Directions Advanced» ($10 por
// 1 000). (1) Caché por tramo en `rutas_cache` durante 7 días, por día de la semana y franja
// de 15 min: el tráfico de un lunes a las 07:15 sirve para cualquier lunes a esa hora, y
// recalcular el mismo contrato no vuelve a Google. (2) Dos topes POR USUARIO (abajo): de
// cálculos y de CONSULTAS, porque un cálculo puede costar de 1 a 20 consultas y el primero
// solo no acota el gasto. (3) Solo usuarios del ERP con el módulo Cotizaciones. (4) Cada
// consulta tiene tope de tiempo (lib/google-directions.ts) y la cadena entera, un presupuesto
// de tiempo: un Google lento no deja la función colgada hasta el corte de Vercel. Sin la tabla
// `rutas_cache`, funciona sin caché (lib/rutas-cache.ts falla en silencio).
//
// La consulta `pessimistic` (opcional) es UNA sola, origen → destino con los intermedios como
// `via:` (así sí trae `duration_in_traffic`). Sirve para enseñar la llegada en hora punta y
// NO mueve ninguna hora: publicar la pesimista haría que el pasajero llegue cuando el bus ya
// pasó.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { leerRutaCache, guardarRutaCache } from "@/lib/rutas-cache";
import { firmaRuta } from "@/lib/ruta-firma";
import { claveGoogleDirections, consultarDirections, esErrorDirections } from "@/lib/google-directions";
import { fechaLima, hhmmAMinutos, minutosAHhmm, minutoDelDiaLima } from "@/lib/alertas-horario";
import {
  MARGEN_SALIDA_MIN, MAX_DIAS_ADELANTE, MAX_PARADEROS_TRAFICO, pasoCadena, validarSalida, type PuntoCadena,
} from "@/lib/paradas-horario";

// Hasta 19 consultas en secuencia (~0.3-1 s cada una).
export const maxDuration = 60;

/**
 * Cálculos con tráfico que puede pedir un usuario cada 10 min. NO MEDIDO: cubre recalcular
 * varias veces una cotización mientras se ajustan paraderos, y corta un bucle. Solo cuentan
 * los cálculos que de verdad llegan a Google (todo en caché no consume cupo). Contador en
 * memoria POR INSTANCIA: el techo real es este × instancias vivas.
 */
const TOPE_CALCULOS = 6;
const VENTANA_TOPE_MS = 10 * 60_000;
/**
 * Consultas «Directions Advanced» REALES (las de caché no cuentan) que puede gastar un usuario
 * cada 10 min, sumando todos sus cálculos. NO MEDIDO: 6 cálculos × hasta 20 consultas serían
 * 120; 60 deja recalcular tres rutas largas enteras y corta el resto. Mismo contador en memoria
 * POR INSTANCIA que el tope de cálculos. Si se agota a mitad de cadena se responde 429 con el
 * tramo: lo ya consultado quedó en caché y al reintentar no se vuelve a cobrar.
 */
const TOPE_CONSULTAS = 60;
/**
 * Presupuesto de tiempo de la cadena. Antes de cada consulta se mira: con 45 s gastados no se
 * empieza otra (cada una puede tardar hasta TIMEOUT_GOOGLE_MS = 8 s), así la respuesta sale
 * como JSON dentro del `maxDuration` de 60 s en vez de un corte de la plataforma.
 */
const PRESUPUESTO_MS = 45_000;
/** Vigencia del tráfico previsto en caché. El patrón semanal cambia más rápido que una geometría. */
const TTL_TRAFICO_MS = 7 * 24 * 60 * 60_000;
/** Franja con la que se agrupa la hora de salida en la clave de caché. */
const FRANJA_S = 15 * 60;
const ESPERA_MAX_MIN = 60;

type Punto = { nombre: string; lat: number; lng: number };

/** Los textos de una salida inválida: los mismos para la de partida y para la de cada tramo. */
const TEXTOS_SALIDA = {
  invalida: "La fecha u hora de salida no es válida (se espera YYYY-MM-DD y HH:MM).",
  salida_pasada: `La salida ya pasó o está a menos de ${MARGEN_SALIDA_MIN} minutos: Google solo predice el tráfico de una hora futura.`,
  salida_lejana: `La salida está a más de ${MAX_DIAS_ADELANTE} días: elige una fecha más cercana para consultar el tráfico previsto.`,
} as const;

/**
 * La salida de un TRAMO juzgada con la misma ventana que `validarSalida` (y sus constantes):
 * con horas fijas la cadena puede re-anclarse antes de la partida, o cruzar el día 90.
 */
function juzgarSalidaTramo(epochS: number, ahoraMs: number): "salida_pasada" | "salida_lejana" | null {
  const ms = epochS * 1000;
  if (ms < ahoraMs + MARGEN_SALIDA_MIN * 60_000) return "salida_pasada";
  if (ms > ahoraMs + MAX_DIAS_ADELANTE * 86_400_000) return "salida_lejana";
  return null;
}

function malo(codigo: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ codigo, error, ...extra }, { status: 400 });
}

/** Día de la semana (Lima) y franja de 15 min de un instante, para la clave de caché. */
function franjaDe(epochS: number): { dow: number; hhmm: string } {
  const r = Math.round(epochS / FRANJA_S) * FRANJA_S * 1000;
  const fecha = fechaLima(r);
  return { dow: new Date(`${fecha}T12:00:00Z`).getUTCDay(), hhmm: minutosAHhmm(minutoDelDiaLima(r)) };
}

const totalMin = (p: PuntoCadena) => p.dia * 1440 + p.min;

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "horas-paraderos" });
    if (bloqueo) return bloqueo;

    const auth = await verificarUsuarioApi(req, "cotizaciones");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: any;
    try { body = await req.json(); } catch { return malo("cuerpo_invalido", "La solicitud no trae un JSON válido."); }

    // ── Validación ─────────────────────────────────────────────────────────────
    const crudas = body?.paradas;
    if (!Array.isArray(crudas) || crudas.length < 2 || crudas.length > MAX_PARADEROS_TRAFICO) {
      return malo("paradas_invalidas", `Se necesitan entre 2 y ${MAX_PARADEROS_TRAFICO} paraderos para calcular con tráfico.`);
    }
    const paradas: Punto[] = crudas.map((p: any, i: number) => ({
      nombre: String(p?.nombre || "").trim().slice(0, 120) || `Paradero ${i + 1}`,
      lat: Number(p?.lat),
      lng: Number(p?.lng),
    }));
    const sinCoords = paradas.filter((p) =>
      !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0));
    if (sinCoords.length) {
      return malo("sin_coordenadas", `Faltan coordenadas en: ${sinCoords.map((p) => p.nombre).join(", ")}. Elige cada paradero desde el buscador o el mapa.`,
        { faltan: sinCoords.map((p) => p.nombre) });
    }

    const fecha = String(body?.fecha || "");
    const hora = String(body?.hora || "");
    const ahoraMs = Date.now();
    const salida = validarSalida(fecha, hora, ahoraMs);
    if (!salida.ok) return malo(salida.codigo, TEXTOS_SALIDA[salida.codigo]);

    const esperaMin = Number(body?.esperaMin ?? 0);
    if (!Number.isFinite(esperaMin) || esperaMin < 0 || esperaMin > ESPERA_MAX_MIN) {
      return malo("espera_invalida", `La espera por paradero tiene que estar entre 0 y ${ESPERA_MAX_MIN} minutos.`);
    }

    const fijasRaw = body?.fijas;
    let fijas: (string | null)[] = paradas.map(() => null);
    if (fijasRaw != null) {
      if (!Array.isArray(fijasRaw) || fijasRaw.length !== paradas.length) {
        return malo("fijas_no_cuadran", "La lista de horas fijas no tiene un valor por paradero.");
      }
      fijas = fijasRaw.map((f: any) => {
        const m = typeof f === "string" ? hhmmAMinutos(f) : null;
        return m == null ? null : minutosAHhmm(m);
      });
    }
    const pesimista = body?.pesimista === true;

    // ── Cadena ─────────────────────────────────────────────────────────────────
    let key: string | null = null;
    let cupoTomado = false;
    let consultasGoogle = 0;
    let enCache = 0;

    /**
     * Antes de CADA llamada facturable (nunca antes de mirar la caché): la key, el cupo de
     * consultas y —en la primera— el de cálculos. `tramo` es lo que se estaba por consultar
     * (null = la consulta de hora punta), para decir hasta dónde llegó.
     */
    const prepararGasto = (tramo: number | null): NextResponse | null => {
      if (!key) {
        key = claveGoogleDirections();
        if (!key) {
          return NextResponse.json(
            { error: "Falta configurar GOOGLE_MAPS_API_KEY en el servidor (Vercel → Settings → Environment Variables)." },
            { status: 500 });
        }
      }
      // El de consultas va ANTES que el de cálculos: si se rechaza, no se quema un cálculo
      // (el cupo escaso) por algo que no llegó a Google.
      const claveConsultas = `horas-paraderos-consultas:${auth.userId}`;
      if (!limitarTasa(claveConsultas, TOPE_CONSULTAS, VENTANA_TOPE_MS)) {
        const s = segundosParaReintentar(claveConsultas) || Math.ceil(VENTANA_TOPE_MS / 1000);
        const donde = tramo == null
          ? "la llegada en hora punta"
          : `el tramo ${tramo} de ${paradas.length - 1}`;
        return NextResponse.json(
          { error: `Llegaste al tope de ${TOPE_CONSULTAS} consultas de tráfico a Google cada 10 minutos (se cortó en ${donde}). Vuelve a intentarlo en ${Math.ceil(s / 60)} min: los tramos ya consultados quedaron en caché y no se vuelven a cobrar.`,
            reintentar_en_s: s, tramo, consultas_google: consultasGoogle },
          { status: 429, headers: { "Retry-After": String(s) } });
      }
      if (!cupoTomado) {
        const clave = `horas-paraderos:${auth.userId}`;
        if (!limitarTasa(clave, TOPE_CALCULOS, VENTANA_TOPE_MS)) {
          const s = segundosParaReintentar(clave) || Math.ceil(VENTANA_TOPE_MS / 1000);
          return NextResponse.json(
            { error: `Llegaste al tope de ${TOPE_CALCULOS} cálculos con tráfico cada 10 minutos. Vuelve a intentarlo en ${Math.ceil(s / 60)} min (lo ya calculado queda en caché).`,
              reintentar_en_s: s, tramo, consultas_google: consultasGoogle },
            { status: 429, headers: { "Retry-After": String(s) } });
        }
        cupoTomado = true;
      }
      return null;
    };

    const inicioMin = hhmmAMinutos(hora)!;
    let prev: PuntoCadena = { min: inicioMin, dia: 0 };
    const tramos: { desde: string; hasta: string; duracion_s: number; duracion_trafico_s: number; salida_epoch: number; cache: boolean }[] = [];

    for (let i = 1; i < paradas.length; i++) {
      const a = paradas[i - 1], b = paradas[i];
      const salidaEpoch = salida.epochS + Math.floor((totalMin(prev) - inicioMin) * 60);

      // Se juzga SIEMPRE, esté o no en caché: la misma entrada tiene que dar la misma respuesta.
      const fueraDeVentana = juzgarSalidaTramo(salidaEpoch, ahoraMs);
      if (fueraDeVentana) {
        return malo(fueraDeVentana,
          `Tramo ${i} (${a.nombre} → ${b.nombre}): sale a las ${minutosAHhmm(minutoDelDiaLima(salidaEpoch * 1000))} del ${fechaLima(salidaEpoch * 1000)}. ${TEXTOS_SALIDA[fueraDeVentana]} Revisa las horas fijas de los paraderos.`,
          { tramo: i, consultas_google: consultasGoogle });
      }
      const { dow, hhmm } = franjaDe(salidaEpoch);
      const claveCache = `T1|best_guess|${dow}|${hhmm}|${firmaRuta([a, b])}`;

      let dur: { duracion_s: number; duracion_trafico_s: number } | null = null;
      let deCache = false;
      const cacheado = await leerRutaCache(claveCache, TTL_TRAFICO_MS);
      if (cacheado && Number.isFinite(cacheado.duracion_s) && Number.isFinite(cacheado.duracion_trafico_s)) {
        dur = { duracion_s: cacheado.duracion_s, duracion_trafico_s: cacheado.duracion_trafico_s };
        deCache = true;
        enCache++;
      } else {
        if (Date.now() - ahoraMs > PRESUPUESTO_MS) {
          return NextResponse.json(
            { error: `Google tardó demasiado: se calcularon ${i - 1} de ${paradas.length - 1} tramos y se cortó en el tramo ${i} (${a.nombre} → ${b.nombre}). Vuelve a intentarlo: lo ya calculado quedó en caché.`,
              tramo: i, tramos_calculados: i - 1, consultas_google: consultasGoogle },
            { status: 504 });
        }
        const corte = prepararGasto(i);
        if (corte) return corte;
        try {
          const data = await consultarDirections({
            origin: `${a.lat},${a.lng}`,
            destination: `${b.lat},${b.lng}`,
            mode: "driving",
            alternatives: "false",
            language: "es",
            region: "pe",
            departure_time: String(salidaEpoch),
            traffic_model: "best_guess",
          }, { key: key!, etiqueta: "horas-paraderos" });
          consultasGoogle++;
          const legs = data.routes[0]?.legs || [];
          if (!legs.length) throw { estado: 422, cuerpo: { error: "Google no devolvió el tramo — respuesta incompleta" } };
          const base = legs.reduce((s: number, l: any) => s + (l.duration?.value || 0), 0);
          const trafico = legs.reduce((s: number, l: any) => s + (l.duration_in_traffic?.value ?? l.duration?.value ?? 0), 0);
          dur = { duracion_s: base, duracion_trafico_s: trafico };
          await guardarRutaCache(claveCache, dur);
        } catch (e) {
          if (esErrorDirections(e)) {
            return NextResponse.json(
              { ...e.cuerpo, error: `Tramo ${i} (${a.nombre} → ${b.nombre}): ${e.cuerpo.error}`, tramo: i, consultas_google: consultasGoogle },
              { status: e.estado });
          }
          throw e;
        }
      }

      tramos.push({ desde: a.nombre, hasta: b.nombre, ...dur!, salida_epoch: salidaEpoch, cache: deCache });
      const paso = pasoCadena(prev, dur!.duracion_trafico_s, esperaMin, i < paradas.length - 1, fijas[i]);
      prev = paso.salida;
    }

    // ── Llegada en hora punta (opcional, no toca horas) ────────────────────────
    let llegadaPesimista: number | null = null;
    /** Por qué no salió la llegada en hora punta cuando se pidió (es un extra: no corta nada). */
    let pesimistaOmitida: "sin_tiempo" | "cupo_agotado" | "sin_clave" | null = null;
    if (pesimista) {
      const { dow, hhmm } = franjaDe(salida.epochS);
      const claveCache = `T1|pessimistic|${dow}|${hhmm}|${firmaRuta(paradas)}`;
      const cacheado = await leerRutaCache(claveCache, TTL_TRAFICO_MS);
      if (cacheado && Number.isFinite(cacheado.duracion_trafico_s)) {
        llegadaPesimista = cacheado.duracion_trafico_s;
        enCache++;
      } else if (Date.now() - ahoraMs > PRESUPUESTO_MS) {
        pesimistaOmitida = "sin_tiempo";
      } else if (prepararGasto(null)) {
        // Las horas ya están calculadas: se entregan y se dice por qué la hora punta no se
        // consultó (sin key, si todos los tramos venían de caché; o sin cupo).
        pesimistaOmitida = key ? "cupo_agotado" : "sin_clave";
      } else {
        try {
          const params: Record<string, string> = {
            origin: `${paradas[0].lat},${paradas[0].lng}`,
            destination: `${paradas[paradas.length - 1].lat},${paradas[paradas.length - 1].lng}`,
            mode: "driving",
            alternatives: "false",
            language: "es",
            region: "pe",
            departure_time: String(salida.epochS),
            traffic_model: "pessimistic",
          };
          // `via:` = pasar por ahí SIN detenerse: es lo único que deja a Google devolver
          // duration_in_traffic con paradas intermedias.
          if (paradas.length > 2) params.waypoints = paradas.slice(1, -1).map((p) => `via:${p.lat},${p.lng}`).join("|");
          const data = await consultarDirections(params, { key: key!, etiqueta: "horas-paraderos" });
          consultasGoogle++;
          const legs = data.routes[0]?.legs || [];
          const t = legs.reduce((s: number, l: any) => s + (l.duration_in_traffic?.value ?? l.duration?.value ?? 0), 0);
          if (legs.length && t > 0) {
            llegadaPesimista = t;
            await guardarRutaCache(claveCache, { duracion_trafico_s: t });
          }
        } catch (e) {
          // La llegada en hora punta es un extra: si falla, las horas siguen sirviendo.
          console.warn("[horas-paraderos] la consulta pesimista falló:", esErrorDirections(e) ? e.cuerpo.error : (e as any)?.message);
        }
      }
    }

    return NextResponse.json({
      tramos,
      llegada_pesimista_s: llegadaPesimista,
      pesimista_omitida: pesimistaOmitida,
      consultas_google: consultasGoogle,
      en_cache: enCache,
      modelo: "best_guess",
    });
  } catch (e: any) {
    if (esErrorDirections(e)) return NextResponse.json(e.cuerpo, { status: e.estado });
    console.error("[horas-paraderos] Exception:", e?.message);
    return NextResponse.json({ error: "No se pudo calcular el tráfico de los tramos: error interno del servidor. Vuelve a intentarlo." }, { status: 500 });
  }
}
