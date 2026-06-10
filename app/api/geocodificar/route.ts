// app/api/geocodificar/route.ts
// Geocodifica paradas por nombre usando Google Geocoding API (server-side)
// y guarda las coordenadas de vuelta en la tabla paradas de Supabase.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

type ParadaInput = { id: number; nombre: string };
type ParadaResult = ParadaInput & { lat: number | null; lng: number | null; geocodificada: boolean };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const paradas: ParadaInput[] = body?.paradas;

    if (!paradas || !Array.isArray(paradas) || paradas.length === 0) {
      return NextResponse.json({ error: "Se requiere un array de paradas" }, { status: 400 });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY no configurada" }, { status: 500 });
    }

    const resultados: ParadaResult[] = await Promise.all(
      paradas.map(async (p) => {
        try {
          const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(p.nombre)}&key=${key}&region=pe&language=es`;
          const res = await fetch(url);
          const data = await res.json();

          console.log(`[geocodificar] "${p.nombre}" → status: ${data.status}`);

          if (data.status !== "OK" || !data.results?.[0]) {
            if (data.status === "REQUEST_DENIED") {
              console.error("[geocodificar] REQUEST_DENIED — habilitar Geocoding API en Google Cloud Console");
            }
            return { ...p, lat: null, lng: null, geocodificada: false };
          }

          const loc = data.results[0].geometry.location;
          const lat = loc.lat as number;
          const lng = loc.lng as number;

          // Guardar en Supabase para que persistan
          await supabaseAdmin
            .from("paradas")
            .update({ lat, lng })
            .eq("id", p.id);

          return { ...p, lat, lng, geocodificada: true };
        } catch (e: any) {
          console.error(`[geocodificar] Error para "${p.nombre}":`, e.message);
          return { ...p, lat: null, lng: null, geocodificada: false };
        }
      })
    );

    const exitosas = resultados.filter((r) => r.geocodificada).length;
    console.log(`[geocodificar] ${exitosas}/${paradas.length} paradas geocodificadas`);

    return NextResponse.json({ paradas: resultados, exitosas, total: paradas.length });
  } catch (e: any) {
    console.error("[geocodificar] Exception:", e.message);
    return NextResponse.json({ error: "Error interno: " + e.message }, { status: 500 });
  }
}
