"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { animarMarcador } from "@/lib/anim-marker";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

type UbicacionGPS = {
  id: number; vehiculo_id: number | null; conductor_id: number | null;
  conductor_tercero_id: number | null; vehiculo_tercero_id: number | null;
  reserva_id: number | null;
  lat: number; lng: number; velocidad: number; rumbo: number;
  estado: string; timestamp: string;
};
type AlertaSOS = {
  id: number; conductor_id: number | null; vehiculo_id: number | null;
  lat: number; lng: number; mensaje: string; atendido: boolean; created_at: string;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; };
type Conductor = { id: number; nombre: string; telefono: string | null; };
type VehiculoTercero  = { id: number; placa: string | null; };
type ConductorTercero = { id: number; nombre: string | null; telefono: string | null; };
type ReservaHoy = {
  id: number; vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  tipo_servicio_detalle: string | null;
};

function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}
function estadoColor(min: number): string {
  if (min <= 2)  return "#16a34a";
  if (min <= 10) return "#d97706";
  return "#dc2626";
}
function estadoLabel(min: number): string {
  if (min <= 2)  return "En linea";
  if (min <= 10) return "Hace " + min + "m";
  return "Sin senal";
}

// Llave compuesta NO ambigua para asociar puntos GPS a un movil/conductor en vivo.
// Prioriza la IDENTIDAD ESTABLE del móvil (conductor -> vehículo); reserva_id va al FINAL.
// Por qué NO reserva_id primero: con "Conectarse" (estilo Uber) un mismo conductor alterna
// reserva_id=null (conectado-libre, "disponible") y reserva_id=X (en servicio, "en_ruta") en
// una sola sesión. Si la clave fuera reserva_id, el MISMO móvil se partía en 2 marcadores
// (uno "en línea" y otro "rancio") y descuadraba los contadores. Por conductor/vehículo, colapsa
// a UN solo marcador aunque su reserva cambie.
// Importante: los IDs se solapan entre tablas AFA y _tercero, por eso el prefijo distingue el origen.
function keyGps(u: { reserva_id?: number | null; conductor_tercero_id?: number | null; conductor_id?: number | null; vehiculo_tercero_id?: number | null; vehiculo_id?: number | null; id?: number }): string {
  if (u.conductor_tercero_id != null) return `ct${u.conductor_tercero_id}`;
  if (u.conductor_id != null) return `c${u.conductor_id}`;
  if (u.vehiculo_tercero_id != null) return `vt${u.vehiculo_tercero_id}`;
  if (u.vehiculo_id != null) return `v${u.vehiculo_id}`;
  if (u.reserva_id != null) return `r${u.reserva_id}`;
  return `id${u.id}`;
}

function esVehiculoEventual(vehiculoId: number, reservasHoy: ReservaHoy[]): boolean | null {
  const res = reservasHoy.find(r => r.vehiculo_id === vehiculoId || r.vehiculo_tercero_id === vehiculoId);
  if (!res) return null;
  return res.tipo_servicio_detalle !== "transporte_personal";
}

export default function MonitoreoPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const markers      = useRef<Record<string, mapboxgl.Marker>>({});

  const [ubicaciones,  setUbicaciones]  = useState<UbicacionGPS[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [vehiculosTercero,  setVehiculosTercero]  = useState<VehiculoTercero[]>([]);
  const [conductoresTercero, setConductoresTercero] = useState<ConductorTercero[]>([]);
  const [alertasSOS,   setAlertasSOS]   = useState<AlertaSOS[]>([]);
  const [reservasHoy,  setReservasHoy]  = useState<ReservaHoy[]>([]);
  const [mapListo,     setMapListo]     = useState(false);
  const [selVehiculo,  setSelVehiculo]  = useState<number | null>(null);
  const [ultimaAct,    setUltimaAct]    = useState<Date>(new Date());
  const [panelSOS,     setPanelSOS]     = useState(false);
  const [filtroServicio, setFiltroServicio] = useState<"todos" | "fijo" | "eventual">("todos");
  const sosMarkers = useRef<mapboxgl.Marker[]>([]);

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

  const actualizarUbicaciones = async () => {
    const hace30min = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("*")
      .gte("created_at", hace30min)
      .order("timestamp", { ascending: false })
      .limit(500);
    if (!data) return;
    // Clave compuesta NO ambigua por móvil (ct/c/vt/v -> reserva_id). Ver keyGps().
    const latest: Record<string, UbicacionGPS> = {};
    data.forEach(u => {
      const key = keyGps(u);
      if (!latest[key] || new Date(u.timestamp) > new Date(latest[key].timestamp)) {
        latest[key] = u;
      }
    });
    setUbicaciones(Object.values(latest));
    setUltimaAct(new Date());
  };

  const cargarDatos = async () => {
    const hoy = new Date().toISOString().split("T")[0];
    const [vRes, cRes, rRes, vtRes, ctRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria"),
      supabase.from("conductores").select("id,nombre,telefono"),
      supabase.from("reservas").select("id,vehiculo_id,vehiculo_tercero_id,tipo_servicio_detalle").eq("fecha_servicio", hoy).in("estado", ["programada", "confirmada", "en_curso"]),
      supabase.from("vehiculos_tercero").select("id,placa"),
      supabase.from("conductores_tercero").select("id,nombre,telefono"),
    ]);
    setVehiculos(vRes.data || []);
    setConductores(cRes.data || []);
    setReservasHoy(rRes.data || []);
    setVehiculosTercero(vtRes.data || []);
    setConductoresTercero(ctRes.data || []);
    await actualizarUbicaciones();
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

  useEffect(() => {
    const ch = supabase.channel("monitoreo-gps")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" },
        (payload) => {
          const nueva = payload.new as UbicacionGPS;
          // Dedup por llave compuesta (NO por vehiculo_id: con null colisiona todo).
          const keyNueva = keyGps(nueva);
          setUbicaciones(prev => {
            const sin = prev.filter(u => keyGps(u) !== keyNueva);
            return [...sin, nueva];
          });
          setUltimaAct(new Date());
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  useEffect(() => {
    const ch = supabase.channel("monitoreo-sos")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas_sos" },
        (payload) => {
          const nueva = payload.new as AlertaSOS;
          setAlertasSOS(prev => [nueva, ...prev]);
          setPanelSOS(true);
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = 880; osc.type = "square"; gain.gain.value = 0.3;
            osc.start(); osc.stop(ctx.currentTime + 0.5);
            setTimeout(() => { osc.frequency.value = 660; osc.start(); osc.stop(ctx.currentTime + 0.5); }, 600);
          } catch {}
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  useEffect(() => {
    if (!mapListo || !map.current) return;
    // Quitar marcadores de entidades que ya no aparecen en el resultado (desconectadas)
    const keysActuales = new Set(ubicaciones.map(u => keyGps(u)));
    Object.keys(markers.current).forEach(key => {
      if (!keysActuales.has(key)) {
        markers.current[key].remove();
        delete markers.current[key];
      }
    });
    ubicaciones.forEach(u => {
      // Resolver placa/nombre/telefono priorizando tablas _tercero cuando el punto es de un tercero.
      // Los IDs AFA y _tercero se solapan, por eso NO se busca en vehiculos/conductores AFA con un id de tercero.
      const vehT     = u.vehiculo_tercero_id != null ? vehiculosTercero.find(v => v.id === u.vehiculo_tercero_id) : null;
      const condT    = u.conductor_tercero_id != null ? conductoresTercero.find(c => c.id === u.conductor_tercero_id) : null;
      const vehAfa   = u.vehiculo_id != null ? vehiculos.find(v => v.id === u.vehiculo_id) : null;
      const condAfa  = u.conductor_id != null ? conductores.find(c => c.id === u.conductor_id) : null;
      const placa    = vehT?.placa || vehAfa?.placa || null;
      const nombre   = condT?.nombre || condAfa?.nombre || null;
      const telefono = condT?.telefono || condAfa?.telefono || null;
      const min      = minutosDesde(u.timestamp);
      const color    = estadoColor(min);
      const esSOS    = u.estado === "sos";
      const sinVeh   = u.vehiculo_id == null && u.vehiculo_tercero_id == null;
      // Clave compuesta NO ambigua por móvil (ct/c/vt/v -> reserva_id). Ver keyGps().
      const key = keyGps(u);

      // Crear elemento del marcador
      const el = document.createElement("div");
      if (sinVeh) {
        // Conductor sin vehículo → ícono persona
        el.style.cssText = "width:36px;height:36px;border-radius:50%;background:" + color + ";border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;";
        el.innerHTML = "🧑";
      } else {
        el.style.cssText = "position:relative;width:" + (esSOS ? "52px" : "44px") + ";height:" + (esSOS ? "52px" : "44px") + ";border-radius:50%;background:" + (esSOS ? "#dc2626" : color) + ";border:3px solid " + (esSOS ? "#fca5a5" : "white") + ";box-shadow:0 2px 10px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;";
        el.innerHTML = esSOS ? "S" : "B";
      }

      const popupHtml = sinVeh
        ? "<div style='font-family:sans-serif;min-width:160px;padding:4px'><div style='font-weight:900;font-size:14px;color:#0b315f;margin-bottom:4px'>" + (nombre || "Conductor") + "</div><div style='font-size:11px;color:#9ca3af;margin-bottom:4px'>Sin vehículo asignado</div><div style='font-size:11px;font-weight:700;color:" + color + ";'>" + estadoLabel(min) + "</div>" + (telefono ? "<a href='tel:" + telefono + "' style='display:block;margin-top:8px;background:#0b315f;color:white;text-align:center;padding:6px;border-radius:8px;font-size:11px;text-decoration:none;'>" + telefono + "</a>" : "") + "</div>"
        : "<div style='font-family:sans-serif;min-width:180px;padding:4px'><div style='font-weight:900;font-size:14px;color:#0b315f;margin-bottom:4px'>" + (placa || "#" + (u.vehiculo_tercero_id ?? u.vehiculo_id)) + (esSOS ? " ⚠ SOS" : "") + "</div><div style='font-size:12px;color:#374151;margin-bottom:4px'>" + (nombre || "-") + "</div><div style='font-size:12px;color:#374151;margin-bottom:4px'>" + (u.velocidad || 0) + " km/h</div><div style='font-size:11px;font-weight:700;color:" + color + ";'>" + estadoLabel(min) + "</div>" + (telefono ? "<a href='tel:" + telefono + "' style='display:block;margin-top:8px;background:#0b315f;color:white;text-align:center;padding:6px;border-radius:8px;font-size:11px;text-decoration:none;'>" + telefono + "</a>" : "") + "</div>";

      if (markers.current[key]) {
        animarMarcador(markers.current[key], [Number(u.lng), Number(u.lat)]);
      } else {
        const popup = new mapboxgl.Popup({ offset: 25, closeButton: true }).setHTML(popupHtml);
        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([Number(u.lng), Number(u.lat)])
          .setPopup(popup)
          .addTo(map.current!);
        markers.current[key] = marker;
      }
    });
  }, [ubicaciones, vehiculos, conductores, vehiculosTercero, conductoresTercero, mapListo]);

  useEffect(() => {
    if (!mapListo || !map.current) return;
    sosMarkers.current.forEach(m => m.remove());
    sosMarkers.current = [];
    alertasSOS.filter(a => !a.atendido).forEach(a => {
      const el = document.createElement("div");
      el.style.cssText = "width:36px;height:36px;border-radius:50%;background:#dc2626;border:3px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 0 20px rgba(220,38,38,0.8);cursor:pointer;color:white;font-weight:900;";
      el.innerHTML = "S";
      const m = new mapboxgl.Marker({ element: el }).setLngLat([Number(a.lng), Number(a.lat)]).addTo(map.current!);
      sosMarkers.current.push(m);
    });
  }, [alertasSOS, mapListo]);

  const centrarVehiculo = (vid: number) => {
    const u = ubicaciones.find(u => u.vehiculo_id === vid);
    if (!u || !map.current) return;
    setSelVehiculo(vid);
    map.current.flyTo({ center: [Number(u.lng), Number(u.lat)], zoom: 15, duration: 1200 });
    const key = keyGps(u);
    markers.current[key]?.togglePopup();
  };

  const atenderSOS = async (id: number) => {
    await supabase.from("alertas_sos").update({ atendido: true }).eq("id", id);
    setAlertasSOS(prev => prev.map(a => a.id === id ? { ...a, atendido: true } : a));
  };

  const enLinea      = ubicaciones.filter(u => minutosDesde(u.timestamp) <= 2).length;
  const inactivo     = ubicaciones.filter(u => { const m = minutosDesde(u.timestamp); return m > 2 && m <= 10; }).length;
  const desconectado = ubicaciones.filter(u => minutosDesde(u.timestamp) > 10).length;
  const sinGPS       = vehiculos.length - ubicaciones.length;
  const sosPendientes = alertasSOS.filter(a => !a.atendido).length;

  // Vehiculos filtrados por tipo de servicio
  const vehiculosFiltrados = vehiculos.filter(v => {
    if (filtroServicio === "todos") return true;
    const eventual = esVehiculoEventual(v.id, reservasHoy);
    if (eventual === null) return false;
    if (filtroServicio === "fijo") return !eventual;
    if (filtroServicio === "eventual") return eventual;
    return true;
  });

  return (
    <main className="h-screen flex flex-col" style={{ background: "#0f172a" }}>

      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ background: "#0b315f", borderColor: "#1e3a5f" }}>
        <div className="flex items-center gap-3">
          <span className="text-xl">M</span>
          <div>
            <h1 className="text-white font-black">Monitoreo GPS</h1>
            <p className="text-blue-200 text-xs">Ultima actualizacion: {ultimaAct.toLocaleTimeString("es-PE")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sosPendientes > 0 && (
            <button onClick={() => setPanelSOS(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-black text-xs" style={{ background: "#dc2626", color: "white" }}>
              SOS {sosPendientes}
            </button>
          )}
          <button onClick={cargarDatos} className="px-3 py-1.5 rounded-lg text-xs font-bold text-white border border-blue-400">R</button>
          <a href="/conductor" target="_blank" className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white">App</a>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        <div className="w-72 flex flex-col border-r flex-shrink-0" style={{ background: "#0f172a", borderColor: "#1e293b" }}>

          <div className="grid grid-cols-2 gap-2 p-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
            {[
              { label: "En linea",  valor: enLinea,      color: "#16a34a", bg: "#052e16" },
              { label: "Inactivo",  valor: inactivo,     color: "#d97706", bg: "#1c1002" },
              { label: "Sin senal", valor: desconectado, color: "#dc2626", bg: "#1c0202" },
              { label: "Sin GPS",   valor: sinGPS,       color: "#6b7280", bg: "#111827" },
            ].map(k => (
              <div key={k.label} className="rounded-xl p-2.5 text-center" style={{ background: k.bg }}>
                <p className="text-2xl font-black" style={{ color: k.color }}>{k.valor}</p>
                <p className="text-[10px] font-bold uppercase" style={{ color: k.color + "99" }}>{k.label}</p>
              </div>
            ))}
          </div>

          {/* FILTRO FIJOS / EVENTUALES */}
          <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">Tipo de servicio</p>
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "#1e293b" }}>
              {(["todos", "fijo", "eventual"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setFiltroServicio(t)}
                  className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all"
                  style={{
                    background: filtroServicio === t ? "#0b315f" : "transparent",
                    color: filtroServicio === t ? "white" : "#6b7280",
                  }}
                >
                  {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Eventuales"}
                </button>
              ))}
            </div>
            {filtroServicio !== "todos" && (
              <p className="text-[9px] text-gray-600 mt-1">
                {vehiculosFiltrados.length} vehiculo(s) con servicio {filtroServicio === "fijo" ? "fijo" : "eventual"} hoy
              </p>
            )}
          </div>

          {panelSOS && alertasSOS.length > 0 && (
            <div className="border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
              <div className="px-3 py-2 flex items-center justify-between" style={{ background: "#1c0202" }}>
                <p className="text-red-400 font-black text-xs uppercase tracking-widest">Alertas SOS</p>
                <button onClick={() => setPanelSOS(false)} className="text-gray-500 text-xs">X</button>
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
                            {a.atendido ? "Atendido" : "PENDIENTE"}
                          </p>
                          <p className="text-[11px] text-gray-300 mt-0.5">{cond?.nombre || "-"}</p>
                          <p className="text-[10px] text-gray-500">{veh?.placa} · {new Date(a.created_at).toLocaleTimeString("es-PE")}</p>
                        </div>
                        {!a.atendido && (
                          <button onClick={() => atenderSOS(a.id)} className="px-2 py-1 rounded-lg text-[10px] font-bold text-white flex-shrink-0" style={{ background: "#166534" }}>
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

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-2 py-1">
              {vehiculosFiltrados.length} vehiculos · {ubicaciones.length} con senal
            </p>

            {vehiculosFiltrados.map(v => {
              const u    = ubicaciones.find(u => u.vehiculo_id === v.id);
              const cond = conductores.find(c => c.id === u?.conductor_id);
              const min  = u ? minutosDesde(u.timestamp) : null;
              const color = min !== null ? estadoColor(min) : "#6b7280";
              const activo = selVehiculo === v.id;
              const esSOS = u?.estado === "sos";
              const tipoServicio = esVehiculoEventual(v.id, reservasHoy);

              return (
                <div
                  key={v.id}
                  onClick={() => u && centrarVehiculo(v.id)}
                  className="rounded-xl p-3 border transition-all"
                  style={{
                    background: esSOS ? "#1c0202" : activo ? "#1e3a5f" : "#1e293b",
                    borderColor: esSOS ? "#dc2626" : activo ? "#3b82f6" : "#334155",
                    cursor: u ? "pointer" : "default",
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-black text-white font-mono text-sm">{v.placa}</span>
                        <span className="text-[10px] font-bold" style={{ color: esSOS ? "#f87171" : color }}>
                          {esSOS ? "SOS" : min !== null ? estadoLabel(min) : "Sin GPS"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-[11px] text-gray-400 truncate">{v.categoria}{cond ? " · " + cond.nombre.split(" ")[0] : ""}</p>
                        {tipoServicio !== null && (
                          <span
                            className="text-[9px] font-black px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{
                              background: tipoServicio ? "#1e1b4b" : "#0c1a2e",
                              color: tipoServicio ? "#818cf8" : "#60a5fa",
                            }}
                          >
                            {tipoServicio ? "Eventual" : "Fijo"}
                          </span>
                        )}
                      </div>
                      {u && <p className="text-[10px] text-gray-600 mt-0.5">{u.velocidad || 0} km/h</p>}
                    </div>
                  </div>
                </div>
              );
            })}

            {vehiculosFiltrados.length === 0 && (
              <div className="text-center py-10 text-gray-600">
                <p className="text-3xl mb-2">B</p>
                <p className="text-xs">
                  {filtroServicio === "todos" ? "Sin vehiculos" : "Sin vehiculos con servicio " + (filtroServicio === "fijo" ? "fijo" : "eventual") + " hoy"}
                </p>
              </div>
            )}
          </div>

          <div className="p-3 border-t flex-shrink-0 text-xs text-gray-600 text-center" style={{ borderColor: "#1e293b" }}>
            <div className="flex items-center justify-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Actualizacion en tiempo real
            </div>
          </div>
        </div>

        <div className="flex-1 relative">
          <div ref={mapContainer} className="w-full h-full" />

          <div className="absolute bottom-6 left-4 rounded-xl px-3 py-2.5 text-xs space-y-1.5" style={{ background: "rgba(15,23,42,0.95)" }}>
            <p className="text-gray-400 font-bold uppercase tracking-wide text-[10px]">Estado GPS</p>
            {[
              { color: "#16a34a", label: "En linea (menos 2 min)" },
              { color: "#d97706", label: "Inactivo (2-10 min)" },
              { color: "#dc2626", label: "Sin senal (mas 10 min)" },
              { color: "#dc2626", label: "Alerta SOS" },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                <span className="text-gray-400">{s.label}</span>
              </div>
            ))}
          </div>

          {ubicaciones.length === 0 && mapListo && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-2xl px-6 py-5 text-center" style={{ background: "rgba(15,23,42,0.92)" }}>
                <p className="text-white font-bold">Sin ubicaciones GPS activas</p>
                <p className="text-gray-400 text-sm mt-1">Los conductores deben iniciar servicio en la app</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}