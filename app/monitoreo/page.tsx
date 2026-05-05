"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// ✅ TOKEN DESDE ENV (SEGURO)
mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

// ─── TIPOS ─────────────────────────────────────────────────────────

type UbicacionGPS = {
  id: number;
  vehiculo_id: number;
  conductor_id: number | null;
  reserva_id: number | null;
  lat: number; lng: number;
  velocidad: number; rumbo: number;
  estado: string;
  timestamp: string;
};

type Vehiculo = { id: number; placa: string; categoria: string | null; };
type Conductor = { id: number; nombre: string; telefono: string | null; };

// ─── HELPERS ───────────────────────────────────────────────────────

function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}

function estadoColor(min: number): string {
  if (min <= 2) return "#16a34a";
  if (min <= 10) return "#d97706";
  return "#dc2626";
}

function estadoLabel(min: number): string {
  if (min <= 2) return "En línea";
  if (min <= 10) return `Hace ${min}m`;
  return "Desconectado";
}

// ─── PAGE ─────────────────────────────────────────────────────────

export default function MonitoreoPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);

  const [mapListo, setMapListo] = useState(false);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-77.0428, -12.0464],
      zoom: 11,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.current.on("load", () => setMapListo(true));

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  return (
    <main className="h-screen flex flex-col bg-black">
      <div className="flex-1">
        <div ref={mapContainer} className="w-full h-full" />
      </div>
    </main>
  );
}