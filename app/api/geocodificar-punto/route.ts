// app/api/geocodificar-punto/route.ts
// Geocodificación directa (dirección → lat/lng) de PROPÓSITO GENERAL, solo lectura: a
// diferencia de /api/geocodificar (acoplado a la tabla `paradas`, escribe de vuelta ahí),
// este no persiste nada — el llamador decide dónde guardar el resultado. Mismo patrón de
// solo-lectura que /api/geocodificar-inverso, pero en la dirección contraria.
//
// Usa la misma caché por texto (lib/geocode-cache.ts) que ya usan paradas y la huella, así
// que reintentar la misma dirección de cochera de un proveedor no cuesta una llamada nueva.

import { NextRequest, NextResponse } from "next/server";
import { guardarGasto, limitarGasto } from "@/lib/api-guard";
import { geocodificarConCache } from "@/lib/geocode-cache";

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "geocodificar-punto" });
    if (bloqueo) return bloqueo;

    const body = await req.json();
    const direccion = String(body?.direccion || "").trim();
    if (!direccion) return NextResponse.json({ error: "Falta la dirección" }, { status: 400 });

    // Acción humana desde un formulario, una por clic: mismo tope generoso que el inverso.
    const excedido = limitarGasto(req, { etiqueta: "geocodificar-punto", limite: 60 });
    if (excedido) return excedido;

    const coords = await geocodificarConCache(direccion);

    if (!coords) return NextResponse.json({ lat: null, lng: null, direccion: null, status: "SIN_RESULTADO" });
    return NextResponse.json({ lat: coords.lat, lng: coords.lng, direccion: coords.direccion ?? null, status: "OK" });
  } catch (e: any) {
    return NextResponse.json({ lat: null, lng: null, error: e?.message || "error" });
  }
}
