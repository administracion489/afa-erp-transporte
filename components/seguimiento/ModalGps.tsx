"use client";

// ModalGps.tsx — Mapbox base + Google Directions ruta real + tráfico
// Protegido contra: coordenadas string, respuestas vacías, campos undefined

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

declare global { interface Window { mapboxgl: any; } }

type UbicGps = {
  lat: number; lng: number; velocidad: number; rumbo: number;
  precision_m: number; estado: string;
  created_at: string | null; timestamp: string | null;
};

type Parada = {
  id: number; nombre: string; lat: number | null; lng: number | null;
  hora_estimada: string | null; estado: string; orden: number;
};

type Tramo = {
  desde: string; hasta: string; distancia_km: number;
  duracion_min: number; duracion_trafico_min: number; duracion_texto: string;
};

type RutaData = {
  coordenadas: [number, number][];
  tramos: Tramo[];
  total_km: number; total_min: number; advertencia: string | null;
};

type Props = {
  reservaId: number; vehiculoId: number | null;
  vehiculoPlaca: string; conductorNombre: string;
  conductorTel: string; clienteNombre: string;
  paradas: Parada[]; onClose: () => void;
};

export default function ModalGps({
  reservaId, vehiculoId, vehiculoPlaca, conductorNombre,
  conductorTel, clienteNombre, paradas, onClose,
}: Props) {
  const mapRef    = useRef<HTMLDivElement>(null);
  const mapInst   = useRef<any>(null);
  const markerRef = useRef<any>(null);

  const [ubic,           setUbic]           = useState<UbicGps | null>(null);
  const [errorMapa,      setErrorMapa]      = useState(false);
  const [ultimaActualiz, setUltimaActualiz] = useState<Date | null>(null);
  const [sinSenal,       setSinSenal]       = useState(false);
  const [mapListo,       setMapListo]       = useState(false);
  const [ruta,           setRuta]           = useState<RutaData | null>(null);
  const [cargandoRuta,   setCargandoRuta]   = useState(false);
  const [errorRuta,      setErrorRuta]      = useState<string | null>(null);

  // ── Ruta real de Google via /api/ruta ──────────────────────────────────────

  const cargarRuta = useCallback(async () => {
    const paradasConCoords = paradas
      .filter(p => p.lat !== null && p.lng !== null)
      .sort((a, b) => a.orden - b.orden);

    if (paradasConCoords.length < 2) {
      setErrorRuta("Las paradas no tienen coordenadas — agregalas en Programación");
      return;
    }

    setCargandoRuta(true);
    setErrorRuta(null);

    try {
      const res = await fetch("/api/ruta", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paradas: paradasConCoords.map(p => ({
            lat:    typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat,
            lng:    typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng,
            nombre: p.nombre,
          })),
        }),
      });

      const text = await res.text();
      if (!text || text.trim() === "") {
        setErrorRuta("API /api/ruta no encontrada — verificar app/api/ruta/route.ts");
        return;
      }

      let data: any;
      try { data = JSON.parse(text); }
      catch { setErrorRuta("Respuesta inválida de /api/ruta"); return; }

      console.log("[ModalGps] Respuesta /api/ruta:", data);

      if (!res.ok) {
        setErrorRuta(data.error || `Error ${res.status}`);
        return;
      }

      if (!data.coordenadas || !Array.isArray(data.coordenadas) || data.coordenadas.length === 0) {
        setErrorRuta("Google no devolvió coordenadas de ruta");
        return;
      }

      if (!data.tramos || !Array.isArray(data.tramos)) {
        data.tramos = [];
      }

      setRuta(data as RutaData);
    } catch (e: any) {
      console.error("[ModalGps] Error fetch:", e);
      setErrorRuta("No se pudo conectar con /api/ruta: " + e.message);
    } finally {
      setCargandoRuta(false);
    }
  }, [paradas]);

  useEffect(() => { cargarRuta(); }, [cargarRuta]);

  // ── Dibujar ruta en Mapbox ────────────────────────────────────────────────

  useEffect(() => {
    if (!ruta || !mapListo || !mapInst.current) return;
    if (!ruta.coordenadas || ruta.coordenadas.length === 0) return;
    const map = mapInst.current;

    try {
      ["ruta-sombra", "ruta-line"].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("ruta-google")) map.removeSource("ruta-google");

      map.addSource("ruta-google", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ruta.coordenadas } },
      });
      map.addLayer({
        id: "ruta-sombra", type: "line", source: "ruta-google",
        paint: { "line-color": "#0b315f", "line-width": 10, "line-opacity": 0.1, "line-blur": 5 },
      });
      map.addLayer({
        id: "ruta-line", type: "line", source: "ruta-google",
        paint: { "line-color": "#1d4ed8", "line-width": 5, "line-opacity": 0.9 },
      });

      const bounds = ruta.coordenadas.reduce(
        (b, c) => b.extend(c as [number, number]),
        new window.mapboxgl.LngLatBounds(ruta.coordenadas[0], ruta.coordenadas[0])
      );
      map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 280 }, maxZoom: 15 });
    } catch (e) {
      console.error("[ModalGps] Error dibujando ruta:", e);
    }
  }, [ruta, mapListo]);

  // ── GPS: última posición ──────────────────────────────────────────────────

  const cargarUbicacion = useCallback(async () => {
    let q = supabase
      .from("ubicaciones_gps")
      .select("lat,lng,velocidad,rumbo,precision_m,estado,created_at,timestamp")
      .order("created_at", { ascending: false })
      .limit(1);
    if (reservaId)       q = q.eq("reserva_id",  reservaId);
    else if (vehiculoId) q = q.eq("vehiculo_id",  vehiculoId);

    const { data } = await q;
    if (data && data[0]) {
      const d = data[0] as UbicGps;
      setUbic(d); setUltimaActualiz(new Date());
      const fechaRef = d.created_at || d.timestamp;
      setSinSenal(!fechaRef || (Date.now() - new Date(fechaRef).getTime()) / 1000 > 60);
    } else { setSinSenal(true); }
  }, [reservaId, vehiculoId]);

  useEffect(() => { cargarUbicacion(); }, [cargarUbicacion]);
  useEffect(() => { const id = setInterval(cargarUbicacion, 10000); return () => clearInterval(id); }, [cargarUbicacion]);

  // Realtime
  useEffect(() => {
    const ch = supabase.channel("modal-gps-" + reservaId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" }, (payload) => {
        const d = payload.new as any;
        if (d.reserva_id !== reservaId && d.vehiculo_id !== vehiculoId) return;
        setUbic({
          lat: d.lat, lng: d.lng, velocidad: d.velocidad, rumbo: d.rumbo,
          precision_m: d.precision_m, estado: d.estado,
          created_at: d.created_at ?? null, timestamp: d.timestamp ?? null,
        });
        setUltimaActualiz(new Date()); setSinSenal(false);
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [reservaId, vehiculoId]);

  // ── Marcador del bus ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!ubic || !mapListo || !mapInst.current) return;
    const lngLat: [number, number] = [ubic.lng, ubic.lat];
    if (markerRef.current) {
      markerRef.current.setLngLat(lngLat);
      if (ubic.rumbo !== undefined) markerRef.current.setRotation(ubic.rumbo);
    } else if (window.mapboxgl) {
      const el = document.createElement("div");
      el.style.cssText = "width:44px;height:44px;border-radius:50%;background:#0b315f;border:3px solid white;box-shadow:0 3px 14px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer";
      el.innerHTML = "🚌";
      markerRef.current = new window.mapboxgl.Marker({ element: el, rotation: ubic.rumbo || 0 })
        .setLngLat(lngLat)
        .setPopup(new window.mapboxgl.Popup({ offset: 28 }).setHTML(
          `<div style="font-family:system-ui;padding:4px">
            <p style="font-weight:900;margin:0;color:#0b315f;font-size:15px">${vehiculoPlaca}</p>
            <p style="margin:4px 0 0;color:#475569;font-size:12px">${conductorNombre}</p>
            <p style="margin:6px 0 0;color:#16a34a;font-weight:700;font-size:16px">${ubic.velocidad} km/h</p>
          </div>`
        )).addTo(mapInst.current);
    }
    mapInst.current.easeTo({ center: lngLat, duration: 1500 });
  }, [ubic, mapListo, vehiculoPlaca, conductorNombre]);

  // ── Init Mapbox ───────────────────────────────────────────────────────────

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) { setErrorMapa(true); return; }
    if (!mapRef.current) return;

    const initMap = () => {
      if (mapInst.current || !mapRef.current) return;
      try {
        window.mapboxgl.accessToken = token;
        const map = new window.mapboxgl.Map({
          container: mapRef.current, style: "mapbox://styles/mapbox/streets-v12",
          center: [-77.0428, -12.0464], zoom: 12,
        });
        map.addControl(new window.mapboxgl.NavigationControl(), "top-right");
        mapInst.current = map;

        map.on("load", () => {
          // Tráfico
          map.addSource("mapbox-traffic", { type: "vector", url: "mapbox://mapbox.mapbox-traffic-v1" });
          map.addLayer({
            id: "traffic-flow", type: "line", source: "mapbox-traffic", "source-layer": "traffic",
            paint: {
              "line-width": 3,
              "line-color": ["match", ["get", "congestion"], "low", "#4ade80", "moderate", "#fbbf24", "heavy", "#f97316", "severe", "#ef4444", "#94a3b8"],
              "line-opacity": 0.7,
            },
          });

          // Marcadores paradas
          const pcc = paradas.filter(p => p.lat !== null && p.lng !== null);
          pcc.forEach((p, i) => {
            const isFirst = i === 0, isLast = i === pcc.length - 1;
            const completada = p.estado === "completada";
            const bg = completada ? "#16a34a" : isFirst ? "#16a34a" : isLast ? "#dc2626" : "#0b315f";
            const el = document.createElement("div");
            el.style.cssText = `width:30px;height:30px;border-radius:50%;background:${bg};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:900`;
            el.innerHTML = completada ? "✓" : String(i + 1);
            const lat = typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat!;
            const lng = typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng!;
            new window.mapboxgl.Marker({ element: el })
              .setLngLat([lng, lat])
              .setPopup(new window.mapboxgl.Popup({ offset: 26 }).setHTML(
                `<div style="font-family:system-ui"><p style="font-weight:900;margin:0;color:#0b315f">${p.nombre}</p>
                ${p.hora_estimada ? `<p style="margin:4px 0 0;color:#64748b;font-size:12px">⏰ ${p.hora_estimada.slice(0,5)}</p>` : ""}
                ${completada ? `<p style="margin:4px 0 0;color:#16a34a;font-weight:700;font-size:12px">✓ Completada</p>` : ""}</div>`
              )).addTo(map);
          });
          setMapListo(true);
        });
      } catch (e) { console.error("[ModalGps]", e); setErrorMapa(true); }
    };

    if (window.mapboxgl) { initMap(); return; }
    if (!document.getElementById("mapboxgl-css")) {
      const link = document.createElement("link"); link.id = "mapboxgl-css"; link.rel = "stylesheet";
      link.href = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css"; document.head.appendChild(link);
    }
    if (!document.getElementById("mapboxgl-js")) {
      const s = document.createElement("script"); s.id = "mapboxgl-js";
      s.src = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js";
      s.onload = initMap; s.onerror = () => setErrorMapa(true); document.head.appendChild(s);
    } else {
      const t = setInterval(() => { if (window.mapboxgl) { clearInterval(t); initMap(); } }, 100);
      setTimeout(() => clearInterval(t), 10000);
    }
    return () => { if (mapInst.current) { mapInst.current.remove(); mapInst.current = null; } markerRef.current = null; };
  }, []); // eslint-disable-line

  // ── Derivados ─────────────────────────────────────────────────────────────

  const proximaParada = paradas.find(p => p.estado !== "completada");
  const paradasComp   = paradas.filter(p => p.estado === "completada").length;
  const pct           = paradas.length > 0 ? Math.round((paradasComp / paradas.length) * 100) : 0;
  const segsDesdeUlt  = ultimaActualiz ? Math.floor((Date.now() - ultimaActualiz.getTime()) / 1000) : null;
  const hayTrafico    = ruta?.tramos?.some(t => t.duracion_trafico_min > t.duracion_min + 2) ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 md:p-4" style={{ background: "rgba(15,23,42,0.65)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden" style={{ height: "90vh" }}>

        {/* HEADER */}
        <div className="flex-shrink-0 px-5 py-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: "#0b315f" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-lg">🗺️</div>
            <div>
              <p className="text-white font-black text-sm">{clienteNombre} · Reserva #{reservaId}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sinSenal ? "bg-red-400" : "bg-green-400 animate-pulse"}`} />
                <p className="text-blue-200 text-[11px]">
                  {sinSenal ? "Sin señal GPS" : ultimaActualiz ? `GPS en vivo · hace ${segsDesdeUlt}s` : "Conectando..."}
                </p>
                {ruta && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${hayTrafico ? "bg-orange-500 text-white" : "bg-green-600 text-white"}`}>
                    {hayTrafico ? `⚠ Tráfico · ${ruta.total_min} min` : `✓ Ruta libre · ${ruta.total_min} min`}
                  </span>
                )}
                {cargandoRuta && <span className="text-[10px] text-blue-300">Calculando ruta...</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-4 py-1.5 rounded-xl text-center min-w-[56px] ${!ubic || ubic.velocidad === 0 ? "bg-white/10" : ubic.velocidad > 80 ? "bg-red-500" : "bg-green-600"}`}>
              <p className="text-white font-black text-xl leading-none">{ubic?.velocidad ?? "—"}</p>
              <p className="text-white/60 text-[9px] font-bold">km/h</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white text-xl transition-colors">✕</button>
          </div>
        </div>

        {/* CONTENIDO */}
        <div className="flex-1 flex overflow-hidden">

          {/* MAPA */}
          <div className="flex-1 relative min-h-0">
            {errorMapa ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-100">
                <div className="text-center px-6">
                  <p className="text-5xl mb-3">🗺️</p>
                  <p className="font-bold text-gray-700 mb-2">Mapa no disponible</p>
                  <p className="text-sm text-gray-500">Verificar NEXT_PUBLIC_MAPBOX_TOKEN</p>
                </div>
              </div>
            ) : (
              <div ref={mapRef} className="w-full h-full" />
            )}

            {ubic && !errorMapa && (
              <div className="absolute top-3 left-3 bg-[#0b315f]/90 backdrop-blur-sm rounded-2xl px-4 py-3 shadow-xl text-center pointer-events-none">
                <p className="text-white font-black text-4xl leading-none">{ubic.velocidad}</p>
                <p className="text-blue-200 text-[10px] font-bold mt-0.5">km/h</p>
                {ubic.precision_m && <p className="text-blue-300 text-[9px] mt-1">±{Math.round(ubic.precision_m)}m</p>}
              </div>
            )}

            {errorRuta && !errorMapa && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-500/90 backdrop-blur-sm rounded-xl px-4 py-2 shadow-lg max-w-md text-center">
                <p className="text-white text-xs font-bold">⚠ {errorRuta}</p>
              </div>
            )}

            {sinSenal && !errorMapa && !errorRuta && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-red-600/90 backdrop-blur-sm rounded-xl px-3 py-2 shadow-lg pointer-events-none">
                <p className="text-white text-xs font-bold">📡 Sin señal GPS del conductor</p>
              </div>
            )}

            {!errorMapa && (
              <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2">
                <p className="text-[8px] font-bold text-gray-400 uppercase mb-1">Tráfico en vivo</p>
                <div className="flex items-center gap-2 text-[9px] font-bold text-gray-600">
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-green-400 inline-block"/>Libre</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-yellow-400 inline-block"/>Moderado</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-orange-500 inline-block"/>Pesado</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-red-500 inline-block"/>Severo</span>
                </div>
              </div>
            )}
          </div>

          {/* PANEL DERECHO */}
          <div className="w-64 flex-shrink-0 overflow-y-auto p-3 space-y-3" style={{ background: "#f8fafc", borderLeft: "1px solid #e2e8f0" }}>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Conductor</p>
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-[#0b315f] flex items-center justify-center text-white font-black text-lg flex-shrink-0">
                  {conductorNombre.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-gray-900 font-bold text-sm truncate">{conductorNombre}</p>
                  {conductorTel
                    ? <a href={`tel:${conductorTel}`} className="text-green-600 text-[11px] font-bold">{conductorTel}</a>
                    : <p className="text-gray-400 text-[10px]">Sin teléfono</p>}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Vehículo</p>
              <p className="text-[#0b315f] font-black text-2xl font-mono tracking-widest">{vehiculoPlaca}</p>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Velocidad real</p>
              <div className="flex items-end gap-1">
                <p className="font-black text-3xl leading-none" style={{ color: !ubic ? "#94a3b8" : ubic.velocidad > 80 ? "#dc2626" : ubic.velocidad > 0 ? "#16a34a" : "#0b315f" }}>
                  {ubic?.velocidad ?? "—"}
                </p>
                <p className="text-gray-400 text-sm mb-0.5">km/h</p>
              </div>
              <p className="text-[9px] text-gray-400 mt-1">GPS real del conductor</p>
            </div>

            {ruta && (
              <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Ruta · Google Maps</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                    <p className="text-[#0b315f] font-black text-lg leading-none">{ruta.total_km}</p>
                    <p className="text-gray-400 text-[9px] font-bold">km totales</p>
                  </div>
                  <div className={`rounded-lg px-2 py-1.5 text-center ${hayTrafico ? "bg-orange-50" : "bg-green-50"}`}>
                    <p className={`font-black text-lg leading-none ${hayTrafico ? "text-orange-600" : "text-green-600"}`}>{ruta.total_min}</p>
                    <p className={`text-[9px] font-bold ${hayTrafico ? "text-orange-400" : "text-green-400"}`}>min c/tráfico</p>
                  </div>
                </div>
                {ruta.advertencia && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg px-2 py-1.5 mb-2">
                    <p className="text-orange-600 text-[10px] font-bold">{ruta.advertencia}</p>
                  </div>
                )}
                {ruta.tramos && ruta.tramos.length > 0 && (
                  <div className="space-y-2">
                    {ruta.tramos.map((t, i) => {
                      const conTrafico = t.duracion_trafico_min > t.duracion_min + 2;
                      return (
                        <div key={i} className="border-t pt-2 first:border-t-0 first:pt-0">
                          <div className="flex justify-between items-start gap-1 mb-0.5">
                            <p className="text-[10px] text-gray-600 font-medium leading-tight flex-1 truncate">{t.desde} → {t.hasta}</p>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ml-1 ${conTrafico ? "bg-orange-100 text-orange-600" : "bg-green-100 text-green-600"}`}>
                              {t.duracion_texto}
                            </span>
                          </div>
                          <p className="text-[9px] text-gray-400">{t.distancia_km} km</p>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button onClick={cargarRuta} disabled={cargandoRuta}
                  className="w-full mt-3 py-1.5 rounded-lg text-[10px] font-bold text-[#0b315f] bg-blue-50 hover:bg-blue-100 transition-colors disabled:opacity-50">
                  {cargandoRuta ? "Actualizando..." : "🔄 Recalcular con tráfico actual"}
                </button>
              </div>
            )}

            {proximaParada && (
              <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Próxima Parada</p>
                <p className="text-gray-900 font-bold text-sm leading-tight">{proximaParada.nombre}</p>
                {proximaParada.hora_estimada && <p className="text-gray-400 text-xs mt-1">⏰ {proximaParada.hora_estimada.slice(0,5)}</p>}
              </div>
            )}

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <div className="flex justify-between mb-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Itinerario</p>
                <p className="text-[9px] font-bold text-[#0b315f]">{paradasComp}/{paradas.length} · {pct}%</p>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
                <div className="h-full rounded-full bg-[#0b315f] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="space-y-1.5">
                {paradas.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-1.5">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0 text-white ${p.estado === "completada" ? "bg-green-500" : i === 0 ? "bg-green-600" : i === paradas.length - 1 ? "bg-red-500" : "bg-[#0b315f]"}`}>
                      {p.estado === "completada" ? "✓" : i + 1}
                    </div>
                    <span className={`flex-1 truncate text-xs ${p.estado === "completada" ? "text-green-600 line-through" : "text-gray-700 font-medium"}`}>{p.nombre}</span>
                    {p.hora_estimada && <span className="text-gray-400 font-mono text-[9px] flex-shrink-0">{p.hora_estimada.slice(0,5)}</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Señal GPS</p>
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-2 ${sinSenal ? "bg-red-50" : "bg-green-50"}`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sinSenal ? "bg-red-500" : "bg-green-500 animate-pulse"}`} />
                <p className={`text-xs font-bold ${sinSenal ? "text-red-600" : "text-green-700"}`}>{sinSenal ? "Sin señal" : "En vivo"}</p>
              </div>
              {ultimaActualiz && <p className="text-[9px] text-gray-400">Última señal: {ultimaActualiz.toLocaleTimeString("es-PE")}</p>}
              <p className="text-[9px] text-gray-400 mt-1">Actualiza cada 10 segundos</p>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}