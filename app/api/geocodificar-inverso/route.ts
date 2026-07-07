// app/api/geocodificar-inverso/route.ts
// Reverse geocoding: coordenadas → dirección corta legible (Google Geocoding, server-side).
// Lo usa el popup de los puntitos de telemetría de la huella (lib/huella.ts puntosTelemetria).
// A diferencia de /api/geocodificar (forward, escribe en la tabla paradas), este es SOLO lectura:
// recibe lat/lng y devuelve el nombre de la vía. La key nunca llega al cliente.

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "lat/lng inválidos" }, { status: 400 });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY no configurada" }, { status: 500 });
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&region=pe&language=es`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.[0]) {
      // Sin resultado (mar, zona sin datos, cuota): devolver solo coordenadas, nunca error visible.
      return NextResponse.json({ direccion: null, status: data.status });
    }

    // Preferir la dirección de vía más específica (route/street_address) sobre la ciudad/país.
    const r = data.results as any[];
    const preferida =
      r.find((x) => x.types?.includes("street_address")) ||
      r.find((x) => x.types?.includes("route")) ||
      r[0];

    // Recortar a las 2 primeras partes ("Av. Los Álamos, San Juan de Miraflores") — legible y corto.
    const full: string = preferida.formatted_address || "";
    const corta = full.split(",").slice(0, 2).join(",").trim() || full;

    return NextResponse.json({ direccion: corta, status: "OK" });
  } catch (e: any) {
    return NextResponse.json({ direccion: null, error: e?.message || "error" });
  }
}
