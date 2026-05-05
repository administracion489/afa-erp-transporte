"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// ✅ TOKEN SEGURO DESDE ENV
mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

type UbicacionGPS = {
  id: number;
  vehiculo_id: number;
  conductor_id: number | null;
  reserva_id: number | null;
  lat: number;
  lng: number;
  velocidad: number;
  rumbo: number;
  estado: string;
  timestamp: string;
};

function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}

export default function SeguimientoPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const marker = useRef<mapboxgl.Marker | null>(null);

  const [vehiculoId, setVehiculoId] = useState<number | null>(null);
  const [vehiculos, setVehiculos] = useState<any[]>([]);
  const [ubicacion, setUbicacion] = useState<UbicacionGPS | null>(null);
  const [mapListo, setMapListo] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [codigoInput, setCodigoInput] = useState("");

  useEffect(() => {
    supabase
      .from("vehiculos")
      .select("id,placa,categoria")
      .order("placa")
      .then(({ data }) => setVehiculos(data || []));
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-77.0428, -12.0464],
      zoom: 12,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.current.on("load", () => setMapListo(true));

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  const cargarUbicacion = async (vId: number) => {
    setBuscando(true);

    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("*")
      .eq("vehiculo_id", vId)
      .order("timestamp", { ascending: false })
      .limit(1)
      .single();

    setUbicacion(data || null);
    setBuscando(false);
  };

  useEffect(() => {
    if (!vehiculoId) return;

    cargarUbicacion(vehiculoId);

    const channel = supabase
      .channel(`gps-${vehiculoId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ubicaciones_gps",
          filter: `vehiculo_id=eq.${vehiculoId}`,
        },
        (payload) => {
          setUbicacion(payload.new as UbicacionGPS);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [vehiculoId]);

  useEffect(() => {
    if (!mapListo || !map.current || !ubicacion) return;

    const lat = Number(ubicacion.lat);
    const lng = Number(ubicacion.lng);

    if (marker.current) {
      marker.current.setLngLat([lng, lat]);
    } else {
      marker.current = new mapboxgl.Marker()
        .setLngLat([lng, lat])
        .addTo(map.current);
    }

    map.current.flyTo({
      center: [lng, lat],
      zoom: 15,
      duration: 1000,
    });
  }, [ubicacion, mapListo]);

  return (
    <main className="h-screen">
      <div ref={mapContainer} className="w-full h-full" />
    </main>
  );
}