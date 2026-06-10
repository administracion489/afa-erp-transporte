// app/api/conductor-paradas/route.ts
// Auto-crea paradas desde origen/destino de una reserva si no existen,
// y geocodifica las coordenadas via Google Maps. Usado por la app conductor.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function geocodificar(nombre: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(nombre)}&key=${key}&region=pe&language=es`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.[0]) return null;
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const reservaId = Number(searchParams.get("reservaId"));
  if (!reservaId) return NextResponse.json({ error: "reservaId requerido" }, { status: 400 });

  // 1. Buscar paradas existentes
  const { data: existentes } = await supabaseAdmin
    .from("paradas")
    .select("*")
    .eq("reserva_id", reservaId)
    .order("orden");

  if (existentes && existentes.length > 0) {
    return NextResponse.json({ paradas: existentes, creadas: false });
  }

  // 2. No hay paradas → auto-crear desde origen/destino de la reserva
  const { data: reserva } = await supabaseAdmin
    .from("reservas")
    .select("id, origen, destino, punto_retorno")
    .eq("id", reservaId)
    .single();

  if (!reserva) return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });

  const esValido = (v: string | null | undefined) =>
    v && v.trim() && v.trim().toLowerCase() !== "sin especificar" && v.trim() !== "-";

  const filas: any[] = [];
  if (esValido(reserva.origen))        filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: reserva.origen,        estado: "pendiente" });
  if (esValido(reserva.destino))       filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: reserva.destino,       estado: "pendiente" });
  if (esValido(reserva.punto_retorno)) filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: reserva.punto_retorno, estado: "pendiente" });

  if (filas.length === 0) {
    return NextResponse.json({ error: "La reserva no tiene origen ni destino configurados" }, { status: 422 });
  }

  const { data: nuevas, error: errIns } = await supabaseAdmin
    .from("paradas")
    .insert(filas)
    .select();

  if (errIns) return NextResponse.json({ error: errIns.message }, { status: 500 });

  // 3. Geocodificar coordenadas en background
  if (nuevas && nuevas.length > 0) {
    for (const parada of nuevas) {
      if (!parada.lat || !parada.lng) {
        const coords = await geocodificar(parada.nombre);
        if (coords) {
          await supabaseAdmin.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
          parada.lat = coords.lat;
          parada.lng = coords.lng;
        }
      }
    }
  }

  return NextResponse.json({ paradas: nuevas || [], creadas: true });
}
