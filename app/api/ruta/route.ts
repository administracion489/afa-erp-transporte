// app/api/ruta/route.ts
// Google Directions API server-side — ruta real con tráfico
// Protegido contra: key faltante, routes vacío, polyline undefined

import { NextRequest, NextResponse } from "next/server";

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const paradasRaw = body?.paradas;

    if (!paradasRaw || !Array.isArray(paradasRaw) || paradasRaw.length < 2) {
      return NextResponse.json({ error: "Se necesitan al menos 2 paradas con coordenadas" }, { status: 400 });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
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

    const origin      = `${paradas[0].lat},${paradas[0].lng}`;
    const destination = `${paradas[paradas.length - 1].lat},${paradas[paradas.length - 1].lng}`;
    const waypoints   = paradas.length > 2
      ? paradas.slice(1, -1).map(p => `${p.lat},${p.lng}`).join("|")
      : "";

    const params = new URLSearchParams({
      origin,
      destination,
      key,
      mode:           "driving",
      departure_time: "now",
      traffic_model:  "best_guess",
      alternatives:   "false",
      language:       "es",
      region:         "pe",
    });
    if (waypoints) params.set("waypoints", waypoints);

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;

    console.log("[api/ruta] Llamando a Google Directions...");
    console.log("[api/ruta] Origin:", origin, "Destination:", destination);

    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
      console.error("[api/ruta] HTTP error:", res.status, res.statusText);
      return NextResponse.json({ error: `Google HTTP ${res.status}: ${res.statusText}` }, { status: 502 });
    }

    const data = await res.json();

    console.log("[api/ruta] Google status:", data.status);

    if (data.status !== "OK") {
      const msg = data.error_message || data.status;
      console.error("[api/ruta] Google error:", msg);

      // Mensajes amigables para errores comunes
      const mensajes: Record<string, string> = {
        REQUEST_DENIED:    "Directions API no habilitada en Google Cloud Console — actívala en APIs & Services",
        OVER_DAILY_LIMIT:  "Límite diario excedido — verificar facturación en Google Cloud",
        OVER_QUERY_LIMIT:  "Demasiadas consultas — esperar un momento",
        ZERO_RESULTS:      "No se encontró ruta entre las paradas — verificar coordenadas",
        NOT_FOUND:         "Una o más paradas no son accesibles por carretera",
        INVALID_REQUEST:   "Solicitud inválida — verificar coordenadas de paradas",
      };

      return NextResponse.json({
        error: mensajes[data.status] || msg,
        google_status: data.status,
      }, { status: 422 });
    }

    // Verificar que hay rutas
    if (!data.routes || data.routes.length === 0) {
      return NextResponse.json({ error: "Google no devolvió rutas — verificar coordenadas" }, { status: 422 });
    }

    const route = data.routes[0];

    if (!route || !route.overview_polyline || !route.overview_polyline.points) {
      return NextResponse.json({ error: "Ruta sin polilínea — respuesta incompleta de Google" }, { status: 422 });
    }

    if (!route.legs || route.legs.length === 0) {
      return NextResponse.json({ error: "Ruta sin tramos — respuesta incompleta de Google" }, { status: 422 });
    }

    const coordenadas = decodePoly(route.overview_polyline.points);
    const legs = route.legs;

    const tramos = legs.map((leg: any, i: number) => ({
      desde:                paradas[i]?.nombre || `Punto ${i + 1}`,
      hasta:                paradas[i + 1]?.nombre || `Punto ${i + 2}`,
      distancia_km:         Math.round((leg.distance?.value || 0) / 100) / 10,
      duracion_min:         Math.round((leg.duration?.value || 0) / 60),
      duracion_trafico_min: leg.duration_in_traffic
        ? Math.round(leg.duration_in_traffic.value / 60)
        : Math.round((leg.duration?.value || 0) / 60),
      duracion_texto:       leg.duration_in_traffic?.text || leg.duration?.text || "—",
    }));

    const totalMin = tramos.reduce((s: number, t: any) => s + t.duracion_trafico_min, 0);
    const totalKm  = tramos.reduce((s: number, t: any) => s + t.distancia_km, 0);

    console.log("[api/ruta] OK:", coordenadas.length, "puntos,", totalKm, "km,", totalMin, "min");

    return NextResponse.json({
      coordenadas,
      tramos,
      total_km:    Math.round(totalKm * 10) / 10,
      total_min:   totalMin,
      advertencia: totalMin > tramos.reduce((s: number, t: any) => s + t.duracion_min, 0) + 5
        ? "⚠️ Tráfico detectado en la ruta"
        : null,
    });

  } catch (e: any) {
    console.error("[api/ruta] Exception:", e.message, e.stack);
    return NextResponse.json({ error: "Error interno: " + e.message }, { status: 500 });
  }
}