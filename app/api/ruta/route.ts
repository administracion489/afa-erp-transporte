// app/api/ruta/route.ts
// Google Directions API server-side — ruta real, con tráfico OPCIONAL.
// Protegido contra: key faltante, routes vacío, polyline undefined.
//
// COSTO (por qué este archivo está escrito así):
//
//   `departure_time` es lo que decide el SKU que factura Google. Con él, la llamada cae en
//   "Directions Advanced": $10 por 1.000 y solo 5.000 gratis al mes. Sin él, cae en
//   "Directions": $5 por 1.000 y 10.000 gratis. O sea, pedir tráfico cuesta el doble Y
//   consume una cuota gratuita que es la mitad de grande.
//
//   La mayoría de las llamadas de este ERP solo quieren DIBUJAR la ruta planificada del
//   contrato, donde el tráfico es irrelevante. Por eso `conTrafico` es false por defecto:
//   solo el ETA en vivo (bus → próxima parada) lo pide explícitamente.
//
//   Y como una ruta sin tráfico es determinista, se cachea en Postgres por firma geográfica
//   (lib/rutas-cache.ts). Antes, dos personas viendo el mismo servicio pagaban dos veces la
//   misma línea; ahora la segunda no llega a Google.

import { NextRequest, NextResponse } from "next/server";
import { guardarGasto, limitarGasto } from "@/lib/api-guard";
import { firmaRuta, leerRutaCache, guardarRutaCache } from "@/lib/rutas-cache";
import { claveGoogleDirections, consultarDirections, esErrorDirections } from "@/lib/google-directions";

// Decodificar polilínea de Google
function decodePoly(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e5, lat / 1e5]); // [lng, lat] para Mapbox
  }
  return coords;
}

// Peticiones idénticas que llegan a la vez comparten UNA sola llamada a Google. Sin esto,
// N visores abriendo el mismo servicio en el mismo segundo generaban N llamadas iguales.
const enVuelo = new Map<string, Promise<any>>();

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "ruta" });
    if (bloqueo) return bloqueo;

    const body = await req.json();
    const paradasRaw = body?.paradas;
    // Default false = SKU barato. Solo el ETA en vivo manda true.
    const conTrafico = body?.conTrafico === true;

    if (!paradasRaw || !Array.isArray(paradasRaw) || paradasRaw.length < 2) {
      return NextResponse.json({ error: "Se necesitan al menos 2 paradas con coordenadas" }, { status: 400 });
    }

    const key = claveGoogleDirections();
    if (!key) {
      return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY no configurada en .env.local" }, { status: 500 });
    }

    // Convertir a número por si vienen como string (Supabase numeric → string en JSON)
    const paradas = paradasRaw.map((p: any) => ({
      nombre: p.nombre || "Parada",
      lat:    typeof p.lat === "string" ? parseFloat(p.lat) : Number(p.lat),
      lng:    typeof p.lng === "string" ? parseFloat(p.lng) : Number(p.lng),
    }));

    // Validar que las coordenadas sean números válidos
    const invalidas = paradas.filter(p => isNaN(p.lat) || isNaN(p.lng));
    if (invalidas.length > 0) {
      return NextResponse.json({ error: `Coordenadas inválidas en: ${invalidas.map(p => p.nombre).join(", ")}` }, { status: 400 });
    }

    const firma = firmaRuta(paradas);

    // Solo la ruta sin tráfico es cacheable: su respuesta no depende de la hora.
    if (!conTrafico) {
      const cacheado = await leerRutaCache(firma);
      if (cacheado) {
        console.log("[api/ruta] cache HIT —", cacheado.coordenadas?.length, "puntos (0 llamadas a Google)");
        return NextResponse.json(cacheado);
      }
    }

    // Clave de dedupe: la firma + si pide tráfico. Los nombres de parada no entran porque no
    // afectan a lo que devuelve Google, solo a las etiquetas de los tramos.
    const claveVuelo = `${conTrafico ? "T" : "P"}:${firma}`;
    const yaEnVuelo = enVuelo.get(claveVuelo);
    if (yaEnVuelo) {
      console.log("[api/ruta] dedupe — se engancha a una llamada ya en vuelo");
      return NextResponse.json(await yaEnVuelo);
    }

    // A partir de aquí sí se le va a pegar a Google, así que aquí es donde cuenta el rate
    // limit: los aciertos de caché y los enganches a una llamada en vuelo (arriba) no gastan
    // y por eso no consumen cupo.
    const excedido = limitarGasto(req, { etiqueta: "ruta", limite: 60 });
    if (excedido) return excedido;

    const tarea = (async () => {
      const params: Record<string, string> = {
        origin:       `${paradas[0].lat},${paradas[0].lng}`,
        destination:  `${paradas[paradas.length - 1].lat},${paradas[paradas.length - 1].lng}`,
        mode:         "driving",
        alternatives: "false",
        language:     "es",
        region:       "pe",
      };
      // Estos dos parámetros son los que suben el SKU a Advanced. Solo se mandan si de verdad
      // se quiere el ETA con tráfico en vivo.
      if (conTrafico) {
        params.departure_time = "now";
        params.traffic_model = "best_guess";
      }
      const waypoints = paradas.length > 2
        ? paradas.slice(1, -1).map(p => `${p.lat},${p.lng}`).join("|")
        : "";
      if (waypoints) params.waypoints = waypoints;

      console.log(`[api/ruta] Llamando a Google Directions (${conTrafico ? "Advanced/tráfico" : "Essentials"})...`);

      // El fetch, el status de Google y sus mensajes viven en lib/google-directions.ts
      // (compartido con /api/cotizaciones/horas-paraderos). Lanza { estado, cuerpo }.
      const data = await consultarDirections(params, { key: key!, etiqueta: "api/ruta" });

      const route = data.routes[0];

      if (!route || !route.overview_polyline || !route.overview_polyline.points) {
        throw { estado: 422, cuerpo: { error: "Ruta sin polilínea — respuesta incompleta de Google" } };
      }

      if (!route.legs || route.legs.length === 0) {
        throw { estado: 422, cuerpo: { error: "Ruta sin tramos — respuesta incompleta de Google" } };
      }

      const legs = route.legs;

      // Geometría DETALLADA por `steps` en vez de `overview_polyline` (esta última es una versión
      // SIMPLIFICADA/diezmada que corta esquinas y se sale de la calle en curvas). Cada step trae su
      // polilínea de alta resolución pegada a la vía; se concatenan y se deduplican los puntos repetidos
      // en las uniones de step. Así la ruta planificada va SIEMPRE dentro de la pista.
      const detallada: [number, number][] = [];
      for (const leg of legs) {
        for (const step of (leg.steps || [])) {
          if (!step.polyline?.points) continue;
          for (const c of decodePoly(step.polyline.points)) {
            const last = detallada[detallada.length - 1];
            if (!last || last[0] !== c[0] || last[1] !== c[1]) detallada.push(c);
          }
        }
      }
      // Fallback al overview solo si (raro) no vinieron steps.
      const coordenadas = detallada.length >= 2 ? detallada : decodePoly(route.overview_polyline.points);

      const tramos = legs.map((leg: any, i: number) => ({
        desde:                paradas[i]?.nombre || `Punto ${i + 1}`,
        hasta:                paradas[i + 1]?.nombre || `Punto ${i + 2}`,
        distancia_km:         Math.round((leg.distance?.value || 0) / 100) / 10,
        duracion_min:         Math.round((leg.duration?.value || 0) / 60),
        // Sin tráfico, duration_in_traffic no viene y el ETA cae a la duración base.
        duracion_trafico_min: leg.duration_in_traffic
          ? Math.round(leg.duration_in_traffic.value / 60)
          : Math.round((leg.duration?.value || 0) / 60),
        duracion_texto:       leg.duration_in_traffic?.text || leg.duration?.text || "—",
        // En SEGUNDOS, sin redondear: el cálculo de horas de paraderos encadena tramos y
        // redondear cada uno a minutos acumulaba el error en el último paradero.
        duracion_s:           leg.duration?.value || 0,
        duracion_trafico_s:   leg.duration_in_traffic?.value ?? (leg.duration?.value || 0),
      }));

      const totalMin = tramos.reduce((s: number, t: any) => s + t.duracion_trafico_min, 0);
      const totalKm  = tramos.reduce((s: number, t: any) => s + t.distancia_km, 0);

      console.log("[api/ruta] OK:", coordenadas.length, "puntos,", totalKm, "km,", totalMin, "min");

      const payload = {
        coordenadas,
        tramos,
        total_km:    Math.round(totalKm * 10) / 10,
        total_min:   totalMin,
        advertencia: totalMin > tramos.reduce((s: number, t: any) => s + t.duracion_min, 0) + 5
          ? "⚠️ Tráfico detectado en la ruta"
          : null,
      };

      // Guardar solo lo determinista. Se espera el upsert para que dos visores casi simultáneos
      // no acaben ambos llamando a Google.
      if (!conTrafico) await guardarRutaCache(firma, payload);

      return payload;
    })();

    enVuelo.set(claveVuelo, tarea);
    try {
      return NextResponse.json(await tarea);
    } finally {
      enVuelo.delete(claveVuelo);
    }

  } catch (e: any) {
    // Errores de Google ya traducidos arriba (llevan estado/cuerpo propios).
    if (esErrorDirections(e)) {
      return NextResponse.json(e.cuerpo, { status: e.estado });
    }
    console.error("[api/ruta] Exception:", e?.message, e?.stack);
    return NextResponse.json({ error: "Error interno: " + e?.message }, { status: 500 });
  }
}
