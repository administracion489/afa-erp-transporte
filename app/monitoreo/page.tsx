"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = "pk.eyJ1IjoiYWZhdG91cnNwZXJ1IiwiYSI6ImNtb3J6aW5qbzAwemkyc29tOGt6NDh0NWgifQ.fMNK4OX1_V6KYEUq-PKO3A";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type UbicacionGPS = {
  id: number; vehiculo_id: number; conductor_id: number | null;
  lat: number; lng: number; velocidad: number; rumbo: number;
  estado: string; timestamp: string;
};
type AlertaSOS = {
  id: number; conductor_id: number | null; vehiculo_id: number | null;
  lat: number; lng: number; mensaje: string; atendido: boolean; created_at: string;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; };
type Conductor = { id: number; nombre: string; telefono: string | null; };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}
function estadoColor(min: number): string {
  if (min <= 2)  return "#16a34a";
  if (min <= 10) return "#d97706";
  return "#dc2626";
}
function estadoLabel(min: number): string {
  if (min <= 2)  return "En línea";
  if (min <= 10) return `Hace ${min}m`;
  return "Sin señal";
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function MonitoreoPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const markers      = useRef<Record<number, mapboxgl.Marker>>({});

  const [ubicaciones,  setUbicaciones]  = useState<UbicacionGPS[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [alertasSOS,   setAlertasSOS]   = useState<AlertaSOS[]>([]);
  const [mapListo,     setMapListo]     = useState(false);
  const [selVehiculo,  setSelVehiculo]  = useState<number | null>(null);
  const [ultimaAct,    setUltimaAct]    = useState<Date>(new Date());
  const [panelSOS,     setPanelSOS]     = useState(false);
  const sosMarkers     = useRef<mapboxgl.Marker[]>([]);

  // ── Inicializar mapa ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-77.0428, -12.0464],
      zoom: 11,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.current.addControl(new mapboxgl.FullscreenControl(), "top-right");
    map.current.on("load", () => setMapListo(true));
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  // ── Carga inicial ──────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    const [vRes, cRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria"),
      supabase.from("conductores").select("id,nombre,telefono"),
    ]);
    setVehiculos(vRes.data || []);
    setConductores(cRes.data || []);
    await actualizarUbicaciones();
  };

  const actualizarUbicaciones = async () => {
    // Traer las últimas 500 filas y filtrar la más reciente por vehículo
    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(500);

    if (!data) return;
    // Deduplicar: solo la más reciente por vehiculo_id
    const latest: Record<number, UbicacionGPS> = {};
    data.forEach(u => {
      if (!latest[u.vehiculo_id] || new Date(u.timestamp) > new Date(latest[u.vehiculo_id].timestamp)) {
        latest[u.vehiculo_id] = u;
      }
    });
    setUbicaciones(Object.values(latest));
    setUltimaAct(new Date());
  };

  const cargarSOS = async () => {
    const { data } = await supabase
      .from("alertas_sos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    setAlertasSOS(data || []);
  };

  useEffect(() => {
    cargarDatos();
    cargarSOS();
    const timer = setInterval(actualizarUbicaciones, 15000);
    return () => clearInterval(timer);
  }, []);

  // ── Realtime GPS ───────────────────────────────────────────────────────────

  useEffect(() => {
    const ch = supabase.channel("monitoreo-gps")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" },
        (payload) => {
          const nueva = payload.new as UbicacionGPS;
          setUbicaciones(prev => {
            const sin = prev.filter(u => u.vehiculo_id !== nueva.vehiculo_id);
            return [...sin, nueva];
          });
          setUltimaAct(new Date());
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // ── Realtime SOS ───────────────────────────────────────────────────────────

  useEffect(() => {
    const ch = supabase.channel("monitoreo-sos")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas_sos" },
        (payload) => {
          const nueva = payload.new as AlertaSOS;
          setAlertasSOS(prev => [nueva, ...prev]);
          setPanelSOS(true);
          // Sonido de alerta
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = "square";
            gain.gain.value = 0.3;
            osc.start(); osc.stop(ctx.currentTime + 0.5);
            setTimeout(() => { osc.frequency.value = 660; osc.start(); osc.stop(ctx.currentTime + 0.5); }, 600);
          } catch {}
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // ── Markers en el mapa ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current) return;

    ubicaciones.forEach(u => {
      const veh  = vehiculos.find(v => v.id === u.vehiculo_id);
      const cond = conductores.find(c => c.id === u.conductor_id);
      const min  = minutosDesde(u.timestamp);
      const color = estadoColor(min);
      const placa = veh?.placa || `#${u.vehiculo_id}`;
      const esSOS = u.estado === "sos";

      // Crear elemento del marker
      const el = document.createElement("div");
      el.style.cssText = `
        position:relative;
        width:${esSOS ? "52px" : "44px"};
        height:${esSOS ? "52px" : "44px"};
        border-radius:50%;
        background:${esSOS ? "#dc2626" : color};
        border:3px solid ${esSOS ? "#fca5a5" : "white"};
        box-shadow:0 2px 10px rgba(0,0,0,0.4)${esSOS ? ",0 0 20px rgba(220,38,38,0.8)" : ""};
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;font-size:${esSOS ? "22px" : "18px"};
        animation:${esSOS ? "pulse 1s infinite" : "none"};
      `;
      el.innerHTML = esSOS ? "🆘" : "🚌";

      const popup = new mapboxgl.Popup({ offset: 25, closeButton: true })
        .setHTML(`
          <div style="font-family:sans-serif;min-width:200px;padding:4px">
            <div style="font-weight:900;font-size:15px;color:#0b315f;margin-bottom:6px">${placa} ${esSOS ? "🆘 SOS" : ""}</div>
            <div style="font-size:12px;color:#374151;margin-bottom:4px">👤 ${cond?.nombre || "—"}</div>
            <div style="font-size:12px;color:#374151;margin-bottom:4px">🚀 ${u.velocidad || 0} km/h</div>
            <div style="font-size:11px;font-weight:700;color:${color};">${estadoLabel(min)}</div>
            ${cond?.telefono ? `<a href="tel:${cond.telefono}" style="display:block;margin-top:8px;background:#0b315f;color:white;text-align:center;padding:6px;border-radius:8px;font-size:11px;text-decoration:none;">📱 ${cond.telefono}</a>` : ""}
          </div>
        `);

      if (markers.current[u.vehiculo_id]) {
        markers.current[u.vehiculo_id].setLngLat([Number(u.lng), Number(u.lat)]);
        const existEl = markers.current[u.vehiculo_id].getElement();
        existEl.style.background = esSOS ? "#dc2626" : color;
      } else {
        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([Number(u.lng), Number(u.lat)])
          .setPopup(popup)
          .addTo(map.current!);
        markers.current[u.vehiculo_id] = marker;
      }
    });
  }, [ubicaciones, vehiculos, conductores, mapListo]);

  // ── Markers SOS en el mapa ─────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current) return;
    sosMarkers.current.forEach(m => m.remove());
    sosMarkers.current = [];
    alertasSOS.filter(a => !a.atendido).forEach(a => {
      const el = document.createElement("div");
      el.style.cssText = "width:36px;height:36px;border-radius:50%;background:#dc2626;border:3px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 0 20px rgba(220,38,38,0.8);animation:pulse 1s infinite;cursor:pointer;";
      el.innerHTML = "🆘";
      const m = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(a.lng), Number(a.lat)])
        .addTo(map.current!);
      sosMarkers.current.push(m);
    });
  }, [alertasSOS, mapListo]);

  // ── Centrar vehículo ──────────────────────────────────────────────────────

  const centrarVehiculo = (vid: number) => {
    const u = ubicaciones.find(u => u.vehiculo_id === vid);
    if (!u || !map.current) return;
    setSelVehiculo(vid);
    map.current.flyTo({ center: [Number(u.lng), Number(u.lat)], zoom: 15, duration: 1200 });
    markers.current[vid]?.togglePopup();
  };

  const atenderSOS = async (id: number) => {
    await supabase.from("alertas_sos").update({ atendido: true }).eq("id", id);
    setAlertasSOS(prev => prev.map(a => a.id === id ? { ...a, atendido: true } : a));
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const enLinea      = ubicaciones.filter(u => minutosDesde(u.timestamp) <= 2).length;
  const inactivo     = ubicaciones.filter(u => { const m = minutosDesde(u.timestamp); return m > 2 && m <= 10; }).length;
  const desconectado = ubicaciones.filter(u => minutosDesde(u.timestamp) > 10).length;
  const sinGPS       = vehiculos.length - ubicaciones.length;
  const sosPendientes = alertasSOS.filter(a => !a.atendido).length;

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="h-screen flex flex-col" style={{ background: "#0f172a" }}>

      {/* HEADER */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ background: "#0b315f", borderColor: "#1e3a5f" }}>
        <div className="flex items-center gap-3">
          <span className="text-xl">🗺️</span>
          <div>
            <h1 className="text-white font-black">Monitoreo GPS</h1>
            <p className="text-blue-200 text-xs">Última actualización: {ultimaAct.toLocaleTimeString("es-PE")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sosPendientes > 0 && (
            <button onClick={() => setPanelSOS(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-black text-xs animate-pulse"
              style={{ background: "#dc2626", color: "white" }}>
              🆘 {sosPendientes} SOS
            </button>
          )}
          <button onClick={cargarDatos} className="px-3 py-1.5 rounded-lg text-xs font-bold text-white border border-blue-400">🔄</button>
          <a href="/conductor" target="_blank" className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white">📱 App</a>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* PANEL IZQUIERDO */}
        <div className="w-72 flex flex-col border-r flex-shrink-0" style={{ background: "#0f172a", borderColor: "#1e293b" }}>

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-2 p-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
            {[
              { label: "En línea",     valor: enLinea,      color: "#16a34a", bg: "#052e16" },
              { label: "Inactivo",     valor: inactivo,     color: "#d97706", bg: "#1c1002" },
              { label: "Sin señal",    valor: desconectado, color: "#dc2626", bg: "#1c0202" },
              { label: "Sin GPS",      valor: sinGPS,       color: "#6b7280", bg: "#111827" },
            ].map(k => (
              <div key={k.label} className="rounded-xl p-2.5 text-center" style={{ background: k.bg }}>
                <p className="text-2xl font-black" style={{ color: k.color }}>{k.valor}</p>
                <p className="text-[10px] font-bold uppercase" style={{ color: k.color + "99" }}>{k.label}</p>
              </div>
            ))}
          </div>

          {/* Panel SOS */}
          {panelSOS && alertasSOS.length > 0 && (
            <div className="border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
              <div className="px-3 py-2 flex items-center justify-between" style={{ background: "#1c0202" }}>
                <p className="text-red-400 font-black text-xs uppercase tracking-widest">🆘 Alertas SOS</p>
                <button onClick={() => setPanelSOS(false)} className="text-gray-500 text-xs">✕</button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {alertasSOS.map(a => {
                  const cond = conductores.find(c => c.id === a.conductor_id);
                  const veh  = vehiculos.find(v => v.id === a.vehiculo_id);
                  return (
                    <div key={a.id} className="px-3 py-2.5 border-b" style={{ background: a.atendido ? "#111827" : "#1c0202", borderColor: "#1e293b" }}>
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <p className="text-xs font-black" style={{ color: a.atendido ? "#6b7280" : "#f87171" }}>
                            {a.atendido ? "✅ Atendido" : "🆘 PENDIENTE"}
                          </p>
                          <p className="text-[11px] text-gray-300 mt-0.5">{cond?.nombre || "—"}</p>
                          <p className="text-[10px] text-gray-500">{veh?.placa} · {new Date(a.created_at).toLocaleTimeString("es-PE")}</p>
                        </div>
                        {!a.atendido && (
                          <button onClick={() => atenderSOS(a.id)}
                            className="px-2 py-1 rounded-lg text-[10px] font-bold text-white flex-shrink-0"
                            style={{ background: "#166534" }}>
                            Atendido
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Lista vehículos */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-2 py-1">
              {vehiculos.length} vehículos · {ubicaciones.length} con señal
            </p>

            {vehiculos.map(v => {
              const u    = ubicaciones.find(u => u.vehiculo_id === v.id);
              const cond = conductores.find(c => c.id === u?.conductor_id);
              const min  = u ? minutosDesde(u.timestamp) : null;
              const color = min !== null ? estadoColor(min) : "#6b7280";
              const activo = selVehiculo === v.id;
              const esSOS = u?.estado === "sos";

              return (
                <div key={v.id}
                  onClick={() => u && centrarVehiculo(v.id)}
                  className="rounded-xl p-3 border transition-all"
                  style={{
                    background: esSOS ? "#1c0202" : activo ? "#1e3a5f" : "#1e293b",
                    borderColor: esSOS ? "#dc2626" : activo ? "#3b82f6" : "#334155",
                    cursor: u ? "pointer" : "default",
                  }}>
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-black text-white font-mono text-sm">{v.placa}</span>
                        <span className="text-[10px] font-bold" style={{ color: esSOS ? "#f87171" : color }}>
                          {esSOS ? "🆘 SOS" : min !== null ? estadoLabel(min) : "Sin GPS"}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-400 truncate">{v.categoria}{cond ? ` · ${cond.nombre.split(" ")[0]}` : ""}</p>
                      {u && <p className="text-[10px] text-gray-600 mt-0.5">🚀 {u.velocidad || 0} km/h</p>}
                    </div>
                  </div>
                </div>
              );
            })}

            {vehiculos.length === 0 && (
              <div className="text-center py-10 text-gray-600">
                <p className="text-3xl mb-2">🚌</p>
                <p className="text-xs">Sin vehículos</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-3 border-t flex-shrink-0 text-xs text-gray-600 text-center" style={{ borderColor: "#1e293b" }}>
            <div className="flex items-center justify-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Actualización en tiempo real
            </div>
          </div>
        </div>

        {/* MAPA */}
        <div className="flex-1 relative">
          <div ref={mapContainer} className="w-full h-full" />

          {/* Leyenda */}
          <div className="absolute bottom-6 left-4 rounded-xl px-3 py-2.5 text-xs space-y-1.5" style={{ background: "rgba(15,23,42,0.95)" }}>
            <p className="text-gray-400 font-bold uppercase tracking-wide text-[10px]">Estado GPS</p>
            {[
              { color: "#16a34a", label: "En línea (< 2 min)" },
              { color: "#d97706", label: "Inactivo (2-10 min)" },
              { color: "#dc2626", label: "Sin señal (> 10 min)" },
              { color: "#dc2626", label: "🆘 Alerta SOS" },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                <span className="text-gray-400">{s.label}</span>
              </div>
            ))}
          </div>

          {/* Sin ubicaciones */}
          {ubicaciones.length === 0 && mapListo && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-2xl px-6 py-5 text-center" style={{ background: "rgba(15,23,42,0.92)" }}>
                <p className="text-4xl mb-2">📍</p>
                <p className="text-white font-bold">Sin ubicaciones GPS activas</p>
                <p className="text-gray-400 text-sm mt-1">Los conductores deben iniciar servicio en la app</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.1); }
        }
      `}</style>
    </main>
  );
}