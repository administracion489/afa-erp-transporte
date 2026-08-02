// app/api/ruta-puente/route.ts
// Puente de un HUECO de GPS: camino de carretera entre A (último fix bueno) y B (primer fix tras el
// hueco), vía Google Directions. A diferencia de /api/ruta (que devuelve solo la ruta principal),
// este pide alternatives=true para que el consumidor mida AMBIGÜEDAD (varios caminos parecidos = no
// sabemos cuál tomó el bus → degradar). Devuelve la geometría de la ruta principal + las distancias
// de TODAS las rutas. Solo lectura; key server-only. Ver lib/huella.ts decidirPuente().

// COSTO: un servicio con GPS entrecortado puede tener 5-15 huecos, y el bucle que los puentea
// corre cada 12-15 s. La única caché que había vivía en un useRef del componente, así que se
// perdía en cada F5 y no se compartía entre usuarios: reabrir el modal del mismo servicio
// volvía a pagar los mismos 30 puentes. Un puente A→B es geometría pura y determinista (no
// pide tráfico), así que se cachea en Postgres igual que las rutas planificadas.

import { NextRequest, NextResponse } from "next/server";
import { guardarGasto, limitarGasto } from "@/lib/api-guard";
import { leerRutaCache, guardarRutaCache } from "@/lib/rutas-cache";

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

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "ruta-puente" });
    if (bloqueo) return bloqueo;

    const body = await req.json();
    const aLat = Number(body?.aLat), aLng = Number(body?.aLng);
    const bLat = Number(body?.bLat), bLng = Number(body?.bLng);
    if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) {
      return NextResponse.json({ error: "Coordenadas A/B inválidas" }, { status: 400 });
    }

    // Mismo hueco de GPS = mismas coordenadas = misma clave, entre sesiones y entre usuarios.
    const clave = `puente:${aLat.toFixed(5)},${aLng.toFixed(5)}>${bLat.toFixed(5)},${bLng.toFixed(5)}`;
    const cacheado = await leerRutaCache(clave);
    if (cacheado) return NextResponse.json(cacheado);

    // Solo los fallos de caché gastan. El límite es holgado a propósito: el primer ciclo de un
    // servicio con GPS entrecortado puede pedir legítimamente ~30 puentes de golpe, y toda la
    // oficina comparte una IP.
    const excedido = limitarGasto(req, { etiqueta: "ruta-puente", limite: 90 });
    if (excedido) return excedido;

    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY no configurada" }, { status: 500 });

    const params = new URLSearchParams({
      origin:       `${aLat},${aLng}`,
      destination:  `${bLat},${bLng}`,
      key,
      mode:         "driving",
      avoid:        "ferries",   // el puente NUNCA debe incluir un leg de transbordador (línea sobre agua) → siempre por puente carretero, o sin ruta
      language:     "es",
      region:       "pe",
    });
    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ ocultar: true, status: `HTTP ${res.status}` });

    const data = await res.json();
    if (data.status !== "OK" || !data.routes?.length) {
      // Sin ruta (puntos no ruteables / lados opuestos de un río sin puente / cuota): no puentear,
      // NUNCA error visible — el hueco se deja cortado, que es el default seguro.
      return NextResponse.json({ ocultar: true, status: data.status || "SIN_RUTA" });
    }

    // Distancia por carretera de cada ruta (metros), sumando los legs.
    const rutasM: number[] = data.routes.map((r: any) =>
      (r.legs || []).reduce((s: number, l: any) => s + (l.distance?.value || 0), 0)
    );
    const principal = data.routes[0];
    // Geometría DETALLADA por `steps` (no el overview_polyline simplificado que corta esquinas): el
    // tramo estimado también va SIEMPRE dentro de la calle. Fallback al overview si no hay steps.
    const coords: [number, number][] = [];
    for (const leg of (principal?.legs || [])) {
      for (const step of (leg.steps || [])) {
        if (!step.polyline?.points) continue;
        for (const c of decodePoly(step.polyline.points)) {
          const last = coords[coords.length - 1];
          if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
        }
      }
    }
    const coordsFinal = coords.length >= 2 ? coords
      : (principal?.overview_polyline?.points ? decodePoly(principal.overview_polyline.points) : []);
    if (coordsFinal.length < 2) return NextResponse.json({ ocultar: true, status: "SIN_GEOMETRIA" });

    const payload = { coords: coordsFinal, roadM: rutasM[0] || 0, rutasM, status: "OK" };
    // Solo se cachea el resultado bueno: los `ocultar: true` son estados transitorios (cuota
    // agotada, error de red) y memorizarlos dejaría huecos sin puentear durante 30 días.
    await guardarRutaCache(clave, payload);
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ ocultar: true, status: e?.message || "error" });
  }
}
