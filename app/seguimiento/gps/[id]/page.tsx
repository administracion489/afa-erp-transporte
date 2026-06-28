"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { idAfa } from "@/lib/folio";
import { etiquetaEstado, normalizaEstado } from "@/lib/estados";

declare global {
  interface Window { google: any; }
}

// ── TIPOS ──────────────────────────────────────────────────────────────────────

type Parada = {
  id: number; orden: number; nombre: string; direccion: string | null;
  lat: number | null; lng: number | null; hora_estimada: string | null; estado: string;
};

type DatosServicio = {
  id: number;
  codigo?: string | null;
  cliente_nombre: string;
  vehiculo_placa: string;
  vehiculo_tipo: string;
  conductor_nombre: string;
  conductor_tel: string;
  hora_servicio: string | null;
  fecha_servicio: string | null;
  origen: string | null;
  destino: string | null;
  estado: string;
  paradas: Parada[];
};

// ── HELPERS ────────────────────────────────────────────────────────────────────

// Etiqueta canónica única (lib/estados). Antes mapeaba a masculinos ("Finalizado",
// "Programado", "En ruta"); ahora coincide con el resto de la app ("Finalizada", etc.).
function fmtEstado(e: string) {
  return etiquetaEstado(normalizaEstado(e));
}

// ── COMPONENTE PRINCIPAL ───────────────────────────────────────────────────────

export default function GpsServicioPage() {
  const params  = useParams();
  const reservaId = Number(params.id);
  const mapRef  = useRef<HTMLDivElement>(null);
  const mapInst = useRef<any>(null);
  const dirRend = useRef<any>(null);

  const [datos,            setDatos]            = useState<DatosServicio | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [etaDestino,       setEtaDestino]       = useState<number | null>(null);
  const [etaProxima,       setEtaProxima]       = useState<number | null>(null);
  const [distProxima,      setDistProxima]      = useState<string | null>(null);
  const [errorMapa,        setErrorMapa]        = useState(false);
  const [ultimaActualiz,   setUltimaActualiz]   = useState(new Date());

  // ── Carga de datos ─────────────────────────────────────────────────────────

  const cargarDatos = useCallback(async () => {
    const [rRes, parRes] = await Promise.all([
      supabase.from("reservas")
        .select("id,codigo,hora_servicio,fecha_servicio,estado,origen,destino,vehiculo_id,conductor_id,empresa_tercerizada_id,vehiculo_tercero_id,tipo,cliente_id")
        .eq("id", reservaId).single(),
      supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden"),
    ]);

    if (rRes.error || !rRes.data) { setLoading(false); return; }
    const r = rRes.data;
    const esTer = r.tipo === "tercerizada";

    const [clRes, vRes, cRes, etRes, vtRes] = await Promise.all([
      r.cliente_id            ? supabase.from("clientes").select("nombre,empresa").eq("id", r.cliente_id).single()                            : Promise.resolve({ data: null }),
      !esTer && r.vehiculo_id ? supabase.from("vehiculos").select("placa,categoria").eq("id", r.vehiculo_id).single()                         : Promise.resolve({ data: null }),
      !esTer && r.conductor_id? supabase.from("conductores").select("nombre,telefono").eq("id", r.conductor_id).single()                      : Promise.resolve({ data: null }),
      esTer && r.empresa_tercerizada_id ? supabase.from("empresas_tercerizadas").select("razon_social,telefono").eq("id", r.empresa_tercerizada_id).single() : Promise.resolve({ data: null }),
      esTer && r.vehiculo_tercero_id    ? supabase.from("vehiculos_tercero").select("placa,categoria").eq("id", r.vehiculo_tercero_id).single()             : Promise.resolve({ data: null }),
    ]);

    const cl = clRes.data as any;
    const v  = (esTer ? vtRes.data : vRes.data) as any;
    const c  = cRes.data as any;
    const et = etRes.data as any;

    setDatos({
      id:               r.id,
      codigo:           r.codigo,
      cliente_nombre:   cl?.empresa || cl?.nombre || "Sin cliente",
      vehiculo_placa:   v?.placa    || "—",
      vehiculo_tipo:    v?.categoria || "Bus",
      conductor_nombre: esTer ? (et?.razon_social || "Empresa tercera") : (c?.nombre || "—"),
      conductor_tel:    esTer ? (et?.telefono || "") : (c?.telefono || ""),
      hora_servicio:    r.hora_servicio,
      fecha_servicio:   r.fecha_servicio,
      origen:           r.origen,
      destino:          r.destino,
      estado:           r.estado,
      paradas:          (parRes.data as Parada[]) || [],
    });
    setLoading(false);
    setUltimaActualiz(new Date());
  }, [reservaId]);

  useEffect(() => { cargarDatos(); }, [cargarDatos]);

  // Auto-refresh cada 60 segundos
  useEffect(() => {
    const id = setInterval(() => cargarDatos(), 60000);
    return () => clearInterval(id);
  }, [cargarDatos]);

  // ── Google Maps ─────────────────────────────────────────────────────────────

  const calcularRuta = useCallback((map: any, renderer: any, paradas: Parada[], origen: string | null, destino: string | null) => {
    const con = paradas.filter(p => p.lat !== null && p.lng !== null);
    const ds  = new window.google.maps.DirectionsService();

    const onResult = (result: any, status: string) => {
      if (status !== "OK") return;
      renderer.setDirections(result);
      const legs = result.routes[0].legs;
      const totalSec = legs.reduce((s: number, l: any) => s + (l.duration_in_traffic?.value || l.duration?.value || 0), 0);
      setEtaDestino(Math.ceil(totalSec / 60));

      // Próxima parada no completada
      const idxProxima = paradas.findIndex(p => p.estado !== "completada");
      const legIdx     = idxProxima > 0 ? idxProxima - 1 : 0;
      if (legs[legIdx]) {
        const sec = legs[legIdx].duration_in_traffic?.value || legs[legIdx].duration?.value;
        setEtaProxima(Math.ceil(sec / 60));
        setDistProxima(legs[legIdx].distance?.text || null);
      }
    };

    const opts = {
      travelMode: window.google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: new Date(), trafficModel: window.google.maps.TrafficModel.BEST_GUESS },
    };

    if (con.length >= 2) {
      ds.route({
        ...opts,
        origin:      new window.google.maps.LatLng(con[0].lat!, con[0].lng!),
        destination: new window.google.maps.LatLng(con[con.length - 1].lat!, con[con.length - 1].lng!),
        waypoints:   con.slice(1, -1).map((p: Parada) => ({ location: new window.google.maps.LatLng(p.lat!, p.lng!), stopover: true })),
      }, onResult);
    } else if (origen && destino) {
      ds.route({ ...opts, origin: origen + ", Lima, Peru", destination: destino + ", Lima, Peru" }, onResult);
    }
  }, []);

  useEffect(() => {
    if (!datos || !mapRef.current) return;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) { setErrorMapa(true); return; }

    const initMap = () => {
      if (!mapRef.current || mapInst.current) return;
      try {
        const map = new window.google.maps.Map(mapRef.current, {
          center: { lat: -12.0464, lng: -77.0428 },
          zoom: 12,
          mapTypeControl: false,
          fullscreenControl: false,
          streetViewControl: false,
          mapId: "seguimiento_afa",
        });
        mapInst.current = map;

        new window.google.maps.TrafficLayer().setMap(map);

        const renderer = new window.google.maps.DirectionsRenderer({
          suppressMarkers: false,
          polylineOptions: { strokeColor: "#0b315f", strokeWeight: 6, strokeOpacity: 0.85 },
        });
        renderer.setMap(map);
        dirRend.current = renderer;

        calcularRuta(map, renderer, datos.paradas, datos.origen, datos.destino);
      } catch { setErrorMapa(true); }
    };

    if (window.google?.maps) { initMap(); return; }
    const existing = document.getElementById("gmaps-gps");
    if (!existing) {
      const s = document.createElement("script");
      s.id    = "gmaps-gps";
      s.src   = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      s.async = true;
      s.onload  = initMap;
      s.onerror = () => setErrorMapa(true);
      document.head.appendChild(s);
    } else {
      const t = setInterval(() => { if (window.google?.maps) { clearInterval(t); initMap(); } }, 100);
      setTimeout(() => clearInterval(t), 10000);
    }
  }, [datos, calcularRuta]);

  // ── RENDER ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="h-screen flex items-center justify-center bg-[#0b1a2e]">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-blue-800 border-t-blue-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-blue-300 font-bold">Cargando seguimiento GPS...</p>
      </div>
    </div>
  );

  if (!datos) return (
    <div className="h-screen flex items-center justify-center bg-[#0b1a2e]">
      <div className="text-center text-white">
        <p className="text-4xl mb-3">🔍</p>
        <p className="font-bold">Reserva #{reservaId} no encontrada</p>
        <Link href="/seguimiento" className="mt-4 inline-block text-blue-400 font-bold text-sm underline">← Volver a Seguimiento</Link>
      </div>
    </div>
  );

  const proximaParada  = datos.paradas.find(p => p.estado !== "completada");
  const paradasComp   = datos.paradas.filter(p => p.estado === "completada").length;
  const pct            = datos.paradas.length > 0 ? Math.round((paradasComp / datos.paradas.length) * 100) : 0;

  return (
    <div className="h-screen flex flex-col bg-[#0b1a2e] overflow-hidden">

      {/* ── HEADER ───────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-[#0b315f] px-4 py-3 shadow-lg">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/seguimiento"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </Link>
            <div>
              <p className="text-white font-black text-sm">{datos.cliente_nombre}</p>
              <p className="text-blue-200 text-[11px]">
                Reserva {idAfa(datos)} · {datos.fecha_servicio} {datos.hora_servicio?.slice(0,5)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {etaDestino !== null && (
              <div className="bg-green-600 px-4 py-1.5 rounded-xl text-center">
                <p className="text-white font-black text-sm">TERMINA EN {etaDestino} MIN</p>
                <p className="text-green-100 text-[10px]">Con tráfico actual</p>
              </div>
            )}
            <div className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-white text-[11px] font-bold">EN VIVO</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── CUERPO ───────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* MAPA */}
        <div className="flex-1 relative min-h-0">
          {errorMapa ? (
            <div className="w-full h-full flex items-center justify-center bg-gray-900">
              <div className="text-center text-white max-w-sm px-6">
                <p className="text-4xl mb-3">🗺️</p>
                <p className="font-bold mb-2">Google Maps no disponible</p>
                <p className="text-sm text-gray-300 mb-3">
                  Para activar el mapa necesitás habilitar facturación en Google Cloud Console
                  y activar <b>Maps JavaScript API</b> y <b>Directions API</b>.
                </p>
                <div className="bg-gray-800 rounded-xl px-4 py-3 text-left text-xs text-gray-400 font-mono">
                  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=tu_key_aqui
                </div>
              </div>
            </div>
          ) : (
            <div ref={mapRef} className="w-full h-full" />
          )}

          {/* Overlay itinerario sobre el mapa */}
          <div className="absolute bottom-4 left-4 w-72 hidden md:block">
            <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Itinerario</p>
                <p className="text-[10px] font-bold text-[#0b315f]">{paradasComp}/{datos.paradas.length} paradas</p>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
                <div className="h-full rounded-full bg-[#0b315f] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {datos.paradas.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0
                      ${p.estado === "completada" ? "bg-green-500 text-white"
                      : i === 0 ? "bg-[#0b315f] text-white"
                      : i === datos.paradas.length - 1 ? "bg-red-500 text-white"
                      : "bg-gray-100 text-gray-500"}`}>
                      {p.estado === "completada" ? "✓" : i + 1}
                    </div>
                    <span className={`flex-1 truncate font-medium
                      ${p.estado === "completada" ? "text-green-600 line-through" : "text-gray-700"}`}>
                      {p.nombre}
                    </span>
                    {p.hora_estimada && (
                      <span className="text-gray-400 font-mono text-[10px]">{p.hora_estimada.slice(0,5)}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[9px] text-gray-400 mt-2 text-right">
                Actualizado: {ultimaActualiz.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        </div>

        {/* PANEL DERECHO */}
        <div className="w-72 flex-shrink-0 bg-[#0d1f35] overflow-y-auto p-4 space-y-3">

          {/* Conductor */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Conductor</p>
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-xl bg-[#0b315f] flex items-center justify-center flex-shrink-0 text-white text-2xl font-black shadow-inner">
                {datos.conductor_nombre.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-white font-black text-sm leading-tight truncate">{datos.conductor_nombre}</p>
                {datos.conductor_tel ? (
                  <a href={`tel:${datos.conductor_tel}`} className="flex items-center gap-1.5 mt-2 group">
                    <div className="w-6 h-6 rounded-lg bg-green-600 group-hover:bg-green-500 flex items-center justify-center transition-colors">
                      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.95 5.95l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.72 16.92z"/>
                      </svg>
                    </div>
                    <span className="text-green-400 text-xs font-bold">{datos.conductor_tel}</span>
                  </a>
                ) : (
                  <p className="text-blue-400 text-xs mt-1">Sin teléfono</p>
                )}
              </div>
            </div>
          </div>

          {/* Vehículo */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Vehículo</p>
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-xl bg-[#0b315f] flex items-center justify-center flex-shrink-0">
                <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/>
                  <path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/>
                  <circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
                </svg>
              </div>
              <div>
                <p className="text-white font-black text-xl font-mono tracking-widest">{datos.vehiculo_placa}</p>
                <p className="text-blue-300 text-xs">{datos.vehiculo_tipo}</p>
              </div>
            </div>
          </div>

          {/* Próxima parada */}
          {proximaParada && (
            <div className="bg-[#1a2f4a] rounded-2xl p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Próxima Parada</p>
              <p className="text-white font-bold text-sm mb-1 leading-tight">{proximaParada.nombre}</p>
              {proximaParada.direccion && (
                <p className="text-blue-300 text-xs mb-2">{proximaParada.direccion}</p>
              )}
              {etaProxima !== null ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="bg-amber-500 px-3 py-1.5 rounded-xl">
                    <p className="text-white font-black text-sm">{etaProxima} MIN</p>
                  </div>
                  {distProxima && <p className="text-blue-300 text-xs">{distProxima}</p>}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-blue-400 text-xs">Calculando con tráfico...</p>
                </div>
              )}
              {proximaParada.hora_estimada && (
                <p className="text-blue-500 text-[10px] mt-2">Planificado: {proximaParada.hora_estimada.slice(0,5)}</p>
              )}
            </div>
          )}

          {/* Destino final */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Destino Final</p>
            <p className="text-white font-bold text-sm mb-2 leading-tight">
              {datos.destino || datos.paradas[datos.paradas.length - 1]?.nombre || "—"}
            </p>
            {etaDestino !== null ? (
              <div className="flex items-center gap-2 bg-green-700/40 border border-green-600 px-3 py-2 rounded-xl">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <p className="text-green-400 font-black text-sm">{etaDestino} min con tráfico real</p>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 border border-green-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-blue-400 text-xs">Calculando ETA...</p>
              </div>
            )}
          </div>

          {/* Velocidad (requiere GPS real) */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-2">Velocidad Actual</p>
            <div className="flex items-end gap-1">
              <p className="text-white font-black text-3xl">—</p>
              <p className="text-blue-300 text-sm mb-1">km/h</p>
            </div>
            <p className="text-blue-500 text-[10px] mt-1">Requiere dispositivo GPS en el vehículo</p>
          </div>

          {/* Info reserva */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Info Servicio</p>
            <div className="space-y-2 text-xs">
              {[
                { label: "Cliente",   val: datos.cliente_nombre },
                { label: "Hora",      val: datos.hora_servicio?.slice(0,5) || "—" },
                { label: "Origen",    val: datos.origen || datos.paradas[0]?.nombre || "—" },
                { label: "Destino",   val: datos.destino || datos.paradas[datos.paradas.length - 1]?.nombre || "—" },
                { label: "Estado",    val: fmtEstado(datos.estado) },
              ].map(d => (
                <div key={d.label} className="flex justify-between gap-2">
                  <span className="text-blue-400 flex-shrink-0">{d.label}</span>
                  <span className="text-white font-semibold text-right truncate">{d.val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Paradas (móvil) */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4 md:hidden">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">
              Itinerario · {paradasComp}/{datos.paradas.length}
            </p>
            <div className="h-1.5 bg-blue-900 rounded-full overflow-hidden mb-3">
              <div className="h-full rounded-full bg-blue-400" style={{ width: `${pct}%` }} />
            </div>
            <div className="space-y-2">
              {datos.paradas.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0
                    ${p.estado === "completada" ? "bg-green-500 text-white" : i === datos.paradas.length - 1 ? "bg-red-500 text-white" : "bg-blue-800 text-blue-300"}`}>
                    {p.estado === "completada" ? "✓" : i + 1}
                  </div>
                  <span className={`flex-1 truncate ${p.estado === "completada" ? "text-green-400 line-through" : "text-white"}`}>
                    {p.nombre}
                  </span>
                  {p.hora_estimada && <span className="text-blue-400 font-mono text-[10px]">{p.hora_estimada.slice(0,5)}</span>}
                </div>
              ))}
            </div>
          </div>

          <Link href="/seguimiento"
            className="block w-full bg-[#1a2f4a] hover:bg-[#243d5c] text-blue-300 text-xs font-bold py-3 rounded-xl text-center transition-colors">
            ← Volver a Seguimiento
          </Link>

          <p className="text-[10px] text-blue-600 text-center">
            Auto-actualiza cada 60s · {ultimaActualiz.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </p>
        </div>
      </div>
    </div>
  );
}