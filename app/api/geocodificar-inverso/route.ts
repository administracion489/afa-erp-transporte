// app/api/geocodificar-inverso/route.ts
// Reverse geocoding: coordenadas → dirección corta legible (Google Geocoding, server-side).
// Lo usa el popup de los puntitos de telemetría de la huella (lib/huella.ts puntosTelemetria).
// A diferencia de /api/geocodificar (forward, escribe en la tabla paradas), este es SOLO lectura:
// recibe lat/lng y devuelve el nombre de la vía. La key nunca llega al cliente.
//
// COSTO: puntosTelemetria coloca un puntito cada ~100 m, así que un servicio de 40 km ofrece
// ~400 puntos clicables y un operador revisando una queja puede generar decenas de llamadas
// por sesión. La caché de lib/geocode-cache.ts redondea a ~11 m, de modo que todos los puntos
// del mismo tramo de calle comparten una sola entrada.

import { NextRequest, NextResponse } from "next/server";
import { guardarGasto, limitarGasto } from "@/lib/api-guard";
import { geocodificarInversoConCache } from "@/lib/geocode-cache";

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "geocodificar-inverso" });
    if (bloqueo) return bloqueo;

    const body = await req.json();
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "lat/lng inválidos" }, { status: 400 });
    }

    // Clicar puntitos de telemetría es una acción humana, una por clic: un límite generoso
    // basta para cortar un bucle sin estorbar a nadie revisando una queja.
    const excedido = limitarGasto(req, { etiqueta: "geocodificar-inverso", limite: 60 });
    if (excedido) return excedido;

    const direccion = await geocodificarInversoConCache(lat, lng);

    // Sin resultado (mar, zona sin datos, cuota): devolver solo coordenadas, nunca error visible.
    return NextResponse.json({ direccion, status: direccion ? "OK" : "SIN_RESULTADO" });
  } catch (e: any) {
    return NextResponse.json({ direccion: null, error: e?.message || "error" });
  }
}
