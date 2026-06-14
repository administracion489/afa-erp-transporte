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
  const { data: reserva, error: errRes } = await supabaseAdmin
    .from("reservas")
    .select("*")
    .eq("id", reservaId)
    .single();

  if (errRes) return NextResponse.json({ error: `Error al buscar reserva: ${errRes.message}` }, { status: 500 });
  if (!reserva) return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });

  // 2a. PREFERIR los paraderos completos del JSON, POR TRAMO (ida/retorno).
  // La programación masiva guarda paradas_json por tramo en cada reserva; si falta,
  // se reconstruye desde la cotización según direccion_servicio. Así el conductor
  // crea los paraderos completos (no solo origen/destino).
  const sortLeg = (arr: any[]) => [
    ...arr.filter((p: any) => p.tipo === "inicio"),
    ...arr.filter((p: any) => p.tipo === "intermedia"),
    ...arr.filter((p: any) => p.tipo === "destino"),
    ...arr.filter((p: any) => !["inicio", "intermedia", "destino"].includes(p.tipo)),
  ];
  let jsonParadas: any[] = [];
  if (Array.isArray(reserva.paradas_json) && reserva.paradas_json.length > 0) {
    jsonParadas = sortLeg(reserva.paradas_json);
  } else if (reserva.cotizacion_id) {
    const { data: cot } = await supabaseAdmin.from("cotizaciones")
      .select("paradas_json, paradas_retorno_json").eq("id", reserva.cotizacion_id).maybeSingle();
    if (reserva.direccion_servicio === "retorno") {
      const ret = Array.isArray(cot?.paradas_retorno_json) && cot.paradas_retorno_json.length > 0
        ? cot.paradas_retorno_json : cot?.paradas_json;
      if (Array.isArray(ret)) jsonParadas = sortLeg(ret);
    } else if (Array.isArray(cot?.paradas_json)) {
      jsonParadas = sortLeg(cot.paradas_json);
    }
  }

  if (jsonParadas.length > 0) {
    const { data: nuevasJ, error: errJ } = await supabaseAdmin.from("paradas").insert(
      jsonParadas.map((p: any, i: number) => ({
        reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null,
        lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
        hora_estimada: p.hora || null, estado: "pendiente",
      }))
    ).select();
    if (errJ) return NextResponse.json({ error: errJ.message }, { status: 500 });
    if (nuevasJ && nuevasJ.length > 0) {
      for (const parada of nuevasJ) {
        if (!parada.lat || !parada.lng) {
          const coords = await geocodificar(parada.nombre);
          if (coords) {
            await supabaseAdmin.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
            parada.lat = coords.lat; parada.lng = coords.lng;
          }
        }
      }
    }
    return NextResponse.json({ paradas: nuevasJ || [], creadas: true });
  }

  // 2b. Fallback: auto-crear desde origen/destino/punto_retorno de la reserva
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
