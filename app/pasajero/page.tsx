"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = "pk.eyJ1IjoiYWZhdG91cnNwZXJ1IiwiYSI6ImNtb3J6aW5qbzAwemkyc29tOGt6NDh0NWgifQ.fMNK4OX1_V6KYEUq-PKO3A";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Pasajero = {
  id: number; nombre: string; dni: string | null; empresa: string | null;
  telefono: string | null; qr_code: string | null; foto_url: string | null;
};
type PasajeroParada = {
  id: number; parada_id: number; estado: string;
  parada: Parada & { reserva: Reserva };
};
type Parada = {
  id: number; reserva_id: number; orden: number; nombre: string;
  direccion: string | null; lat: number | null; lng: number | null;
  hora_estimada: string | null; estado: string;
};
type Reserva = {
  id: number; origen: string; destino: string;
  fecha_servicio: string | null; hora_servicio: string | null;
  vehiculo_id: number | null;
};
type UbicacionBus = {
  vehiculo_id: number; lat: number; lng: number;
  velocidad: number; estado: string; timestamp: string;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; };
type Conductor = { id: number; nombre: string; telefono: string | null; };

type Tab = "ruta" | "qr" | "perfil";

// ─── COLORES ─────────────────────────────────────────────────────────────────

const C = {
  navy:  "#0b315f", navy2: "#1e40af",
  white: "#FFFFFF", gray50: "#F8FAFC",
  gray100: "#F1F5F9", gray200: "#E2E8F0",
  gray400: "#94A3B8", gray600: "#475569", gray800: "#1E293B",
  green: "#16a34a", red: "#dc2626", amber: "#d97706",
};

// ─── SESSION ──────────────────────────────────────────────────────────────────

const SK = "afa_pasajero_v1";
function saveSession(p: Pasajero) {
  localStorage.setItem(SK, JSON.stringify({ p, exp: Date.now() + 24 * 3600000 }));
}
function loadSession(): Pasajero | null {
  try {
    const r = localStorage.getItem(SK);
    if (!r) return null;
    const { p, exp } = JSON.parse(r);
    if (Date.now() > exp) { localStorage.removeItem(SK); return null; }
    return p;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SK); }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Distancia en metros entre dos coordenadas (Haversine)
function distanciaMetros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ETA en minutos (velocidad promedio Lima: 25 km/h urbano)
function calcETA(distM: number, velocidadKmh: number): number {
  const vel = velocidadKmh > 5 ? velocidadKmh : 25;
  return Math.ceil((distM / 1000) / vel * 60);
}

function fmtETA(min: number): string {
  if (min <= 0) return "¡Llegando!";
  if (min === 1) return "1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min/60)}h ${min%60}m`;
}

// ─── COMPONENTES ─────────────────────────────────────────────────────────────

function Pill({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 20, color, background: bg }}>{children}</span>;
}

function TabBtn({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ flex: 1, border: "none", background: "none", cursor: "pointer", padding: "10px 0 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, position: "relative" }}>
      {active && <div style={{ position: "absolute", top: 0, left: "20%", right: "20%", height: 3, background: C.navy, borderRadius: "0 0 3px 3px" }} />}
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: active ? C.navy : C.gray400 }}>{label}</span>
    </button>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function AppPasajero() {

  const [initing,    setIniting]    = useState(true);
  const [pasajero,   setPasajero]   = useState<Pasajero | null>(null);
  const [tab,        setTab]        = useState<Tab>("ruta");

  // ── Login ──────────────────────────────────────────────────────────────────
  const [dniInput,   setDniInput]   = useState("");
  const [loginErr,   setLoginErr]   = useState("");
  const [loginLoad,  setLoginLoad]  = useState(false);

  // ── Ruta del pasajero ──────────────────────────────────────────────────────
  const [miParada,   setMiParada]   = useState<(Parada & { reserva: Reserva }) | null>(null);
  const [vehiculo,   setVehiculo]   = useState<Vehiculo | null>(null);
  const [conductor,  setConductor]  = useState<Conductor | null>(null);
  const [busPosicion,setBusPosicion]= useState<UbicacionBus | null>(null);
  const [etaMin,     setEtaMin]     = useState<number | null>(null);
  const [distM,      setDistM]      = useState<number | null>(null);
  const [estadoBus,  setEstadoBus]  = useState<"no_iniciado" | "en_camino" | "retrasado" | "finalizado" | "sin_señal">("no_iniciado");
  const [miEstado,   setMiEstado]   = useState<string>("esperando");
  const [rutaParadas,setRutaParadas]= useState<Parada[]>([]);

  // ── Mapa ──────────────────────────────────────────────────────────────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const busMarker    = useRef<mapboxgl.Marker | null>(null);
  const paradaMarker = useRef<mapboxgl.Marker | null>(null);
  const [mapListo,   setMapListo]   = useState(false);

  // ─── Init ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setPasajero(saved); cargarMiRuta(saved.id); }
    setIniting(false);
  }, []);

  // ─── Mapa ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainer.current || map.current || !pasajero) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-77.0428, -12.0464],
      zoom: 13,
    });

    map.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.current.on("load", () => setMapListo(true));

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, [pasajero]);

  // ─── Marker del bus ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current) return;

    if (busPosicion) {
      const el = document.createElement("div");
      el.style.cssText = `
        width: 52px; height: 52px; border-radius: 50%;
        background: ${C.navy}; border: 3px solid white;
        box-shadow: 0 4px 16px rgba(11,49,95,0.5);
        display: flex; align-items: center; justify-content: center;
        font-size: 24px; cursor: pointer;
        animation: busMove 2s ease-in-out infinite alternate;
      `;
      el.innerHTML = "🚌";

      if (busMarker.current) {
        busMarker.current.setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)]);
      } else {
        busMarker.current = new mapboxgl.Marker({ element: el })
          .setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)])
          .setPopup(new mapboxgl.Popup({ offset: 30 }).setHTML(`
            <div style="font-family:sans-serif;padding:4px">
              <p style="font-weight:900;color:${C.navy};margin:0 0 4px">${vehiculo?.placa || "Bus AFA"}</p>
              <p style="color:#555;font-size:12px;margin:0">🚀 ${busPosicion.velocidad} km/h</p>
              ${conductor ? `<p style="color:#555;font-size:12px;margin:4px 0 0">👤 ${conductor.nombre}</p>` : ""}
            </div>
          `))
          .addTo(map.current!);
      }

      // Calcular ETA y distancia si tenemos parada
      if (miParada?.lat && miParada?.lng) {
        const d = distanciaMetros(Number(busPosicion.lat), Number(busPosicion.lng), Number(miParada.lat), Number(miParada.lng));
        setDistM(d);
        setEtaMin(calcETA(d, busPosicion.velocidad));

        // Estado del bus
        const minDesde = (Date.now() - new Date(busPosicion.timestamp).getTime()) / 60000;
        if (minDesde > 5) setEstadoBus("sin_señal");
        else if (busPosicion.estado === "finalizado") setEstadoBus("finalizado");
        else if (busPosicion.velocidad < 3) setEstadoBus("retrasado");
        else setEstadoBus("en_camino");

        // Auto-centrar entre bus y parada
        if (map.current) {
          const bounds = new mapboxgl.LngLatBounds();
          bounds.extend([Number(busPosicion.lng), Number(busPosicion.lat)]);
          bounds.extend([Number(miParada.lng), Number(miParada.lat)]);
          map.current.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
        }
      }
    }
  }, [busPosicion, mapListo, miParada, vehiculo, conductor]);

  // ─── Marker de mi parada ──────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current || !miParada?.lat) return;

    if (!paradaMarker.current) {
      const el = document.createElement("div");
      el.style.cssText = `
        width: 44px; height: 44px; border-radius: 50%;
        background: white; border: 3px solid ${C.navy};
        box-shadow: 0 4px 12px rgba(11,49,95,0.3);
        display: flex; align-items: center; justify-content: center; font-size: 22px;
      `;
      el.innerHTML = "📍";

      paradaMarker.current = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(miParada.lng), Number(miParada.lat)])
        .setPopup(new mapboxgl.Popup({ offset: 30 }).setHTML(`
          <div style="font-family:sans-serif;padding:4px">
            <p style="font-weight:900;color:${C.navy};margin:0 0 4px">Tu paradero</p>
            <p style="color:#555;font-size:12px;margin:0">${miParada.nombre}</p>
            ${miParada.hora_estimada ? `<p style="color:#555;font-size:11px;margin:4px 0 0">🕐 ${miParada.hora_estimada}</p>` : ""}
          </div>
        `))
        .addTo(map.current!);

      map.current.flyTo({ center: [Number(miParada.lng), Number(miParada.lat)], zoom: 14, duration: 1500 });
    }
  }, [miParada, mapListo]);

  // ─── Línea de ruta ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current || rutaParadas.length < 2) return;
    const coords = rutaParadas.filter(p => p.lat && p.lng).map(p => [Number(p.lng), Number(p.lat)]);
    if (coords.length < 2) return;

    if (map.current.getSource("ruta")) {
      (map.current.getSource("ruta") as mapboxgl.GeoJSONSource).setData({
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    } else {
      map.current.addSource("ruta", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
      });
      map.current.addLayer({
        id: "ruta-line",
        type: "line",
        source: "ruta",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": C.navy, "line-width": 3, "line-dasharray": [2, 2], "line-opacity": 0.6 },
      });
    }
  }, [rutaParadas, mapListo]);

  // ─── Realtime GPS bus ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!miParada?.reserva?.vehiculo_id) return;
    const vid = miParada.reserva.vehiculo_id;

    const ch = supabase.channel(`bus-${vid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps", filter: `vehiculo_id=eq.${vid}` },
        (payload) => {
          const u = payload.new as UbicacionBus;
          setBusPosicion(u);
        })
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [miParada]);

  // ─── Login ────────────────────────────────────────────────────────────────

  async function login() {
    if (dniInput.length < 7) { setLoginErr("Ingresa tu DNI completo"); return; }
    setLoginErr(""); setLoginLoad(true);

    const { data } = await supabase.from("pasajeros").select("*").eq("dni", dniInput.trim()).single();
    if (!data) {
      setLoginErr("DNI no registrado. Contacta a tu empresa o a AFA Tours.");
      setLoginLoad(false); return;
    }

    saveSession(data);
    setPasajero(data);
    await cargarMiRuta(data.id);
    setLoginLoad(false);
  }

  // ─── Cargar mi ruta ───────────────────────────────────────────────────────

  const cargarMiRuta = useCallback(async (pid: number) => {
    const hoy = new Date().toISOString().split("T")[0];

    // Buscar mis paradas asignadas hoy
    const { data: pp } = await supabase
      .from("pasajeros_parada")
      .select(`*, parada:paradas(*, reserva:reservas(*))`)
      .eq("pasajero_id", pid);

    if (!pp || pp.length === 0) return;

    // Filtrar las de hoy
    const hoyPP = pp.filter((x: any) => x.parada?.reserva?.fecha_servicio === hoy);
    if (hoyPP.length === 0) {
      // Si no hay hoy, mostrar la más próxima
      const sorted = pp.sort((a: any, b: any) =>
        new Date(a.parada?.reserva?.fecha_servicio || 0).getTime() - new Date(b.parada?.reserva?.fecha_servicio || 0).getTime()
      );
      const next = sorted[0] as any;
      if (next?.parada) setMiParada(next.parada);
      setMiEstado(next?.estado || "esperando");
      return;
    }

    const miPP = hoyPP[0] as any;
    setMiParada(miPP.parada);
    setMiEstado(miPP.estado || "esperando");

    const reservaId = miPP.parada?.reserva_id;
    if (!reservaId) return;

    // Cargar todas las paradas de la reserva (para línea de ruta)
    const { data: todasParadas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    setRutaParadas(todasParadas || []);

    // Vehículo y conductor
    const vehiculoId = miPP.parada?.reserva?.vehiculo_id;
    if (vehiculoId) {
      const [vR, uR] = await Promise.all([
        supabase.from("vehiculos").select("id,placa,categoria").eq("id", vehiculoId).single(),
        supabase.from("ubicaciones_gps").select("*").eq("vehiculo_id", vehiculoId).order("timestamp", { ascending: false }).limit(1),
      ]);
      if (vR.data) setVehiculo(vR.data);
      if (uR.data && uR.data.length > 0) setBusPosicion(uR.data[0]);

      // Buscar conductor activo
      const { data: uGPS } = await supabase.from("ubicaciones_gps").select("conductor_id").eq("vehiculo_id", vehiculoId).order("timestamp", { ascending: false }).limit(1);
      if (uGPS && uGPS[0]?.conductor_id) {
        const { data: cond } = await supabase.from("conductores").select("id,nombre,telefono").eq("id", uGPS[0].conductor_id).single();
        if (cond) setConductor(cond);
      }
    }
  }, []);

  const salir = () => { clearSession(); setPasajero(null); setMiParada(null); setBusPosicion(null); setTab("ruta"); };

  // ── Derivados ─────────────────────────────────────────────────────────────

  const estadoConfig = {
    no_iniciado: { color: C.gray600, bg: C.gray100, icon: "🕐", txt: "Servicio no iniciado" },
    en_camino:   { color: C.green,   bg: "#DCFCE7", icon: "🚌", txt: "En camino" },
    retrasado:   { color: C.amber,   bg: "#FEF3C7", icon: "⏰", txt: "Retrasado por tráfico" },
    finalizado:  { color: C.navy,    bg: C.gray100, icon: "✅", txt: "Servicio finalizado" },
    sin_señal:   { color: C.red,     bg: "#FEF2F2", icon: "📡", txt: "Sin señal GPS" },
  }[estadoBus];

  // ══════════════════════════════════════════════════════════════════════════════
  // LOADING
  // ══════════════════════════════════════════════════════════════════════════════

  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.navy }}>
      <div style={{ width: 40, height: 40, border: "4px solid rgba(255,255,255,0.3)", borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // LOGIN
  // ══════════════════════════════════════════════════════════════════════════════

  if (!pasajero) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.white, fontFamily: "system-ui,sans-serif" }}>

      {/* Hero */}
      <div style={{ background: C.navy, padding: "56px 24px 40px", textAlign: "center" }}>
        <div style={{ width: 80, height: 80, background: "rgba(255,255,255,0.12)", borderRadius: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto 16px" }}>🚌</div>
        <h1 style={{ color: "white", fontWeight: 900, fontSize: 24, margin: 0 }}>AFA Tours Peru</h1>
        <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 14, margin: "6px 0 0" }}>Seguimiento de Ruta — Portal del Pasajero</p>
      </div>

      <div style={{ flex: 1, padding: "32px 24px", maxWidth: 420, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
        <p style={{ color: C.gray600, fontSize: 14, textAlign: "center", marginBottom: 28 }}>Ingresa tu DNI para ver tu bus en tiempo real y tu código de embarque</p>

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Tu número de DNI</label>
        <input type="tel" inputMode="numeric" maxLength={8} value={dniInput}
          onChange={e => { setDniInput(e.target.value.replace(/\D/g,"").slice(0,8)); setLoginErr(""); }}
          onKeyDown={e => e.key === "Enter" && login()}
          placeholder="12345678"
          style={{ width: "100%", padding: "16px 20px", borderRadius: 18, border: `2px solid ${dniInput.length >= 7 ? C.navy : C.gray200}`, fontSize: 24, fontWeight: 900, textAlign: "center", letterSpacing: 5, outline: "none", boxSizing: "border-box", color: C.gray800, marginBottom: 16, transition: "border-color 0.2s" }} />

        {loginErr && (
          <div style={{ background: "#FEF2F2", border: `1px solid #FECACA`, borderRadius: 14, padding: "12px 16px", marginBottom: 16, textAlign: "center" }}>
            <p style={{ color: C.red, fontSize: 13, fontWeight: 700, margin: 0 }}>⚠️ {loginErr}</p>
          </div>
        )}

        <button onClick={login} disabled={loginLoad || dniInput.length < 7}
          style={{ width: "100%", padding: "16px 0", borderRadius: 18, border: "none", background: dniInput.length >= 7 ? C.navy : C.gray200, color: "white", fontSize: 16, fontWeight: 900, cursor: dniInput.length >= 7 ? "pointer" : "not-allowed", transition: "background 0.2s" }}>
          {loginLoad ? "Buscando..." : "Ver mi ruta →"}
        </button>

        {/* Info */}
        <div style={{ marginTop: 32, background: C.gray50, borderRadius: 16, padding: 20 }}>
          <p style={{ color: C.navy, fontWeight: 900, fontSize: 14, margin: "0 0 10px" }}>¿Qué puedo hacer aquí?</p>
          {[
            ["🗺️", "Ver el bus en tiempo real y su ETA a tu paradero"],
            ["🎫", "Mostrar tu código QR para abordar el bus"],
            ["📍", "Ver las paradas de tu ruta del día"],
          ].map(([icon, txt]) => (
            <div key={txt} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 16 }}>{icon}</span>
              <p style={{ color: C.gray600, fontSize: 13, margin: 0 }}>{txt}</p>
            </div>
          ))}
        </div>

        <p style={{ textAlign: "center", color: C.gray400, fontSize: 12, marginTop: 24 }}>
          ¿Problemas? Llama a AFA Tours: <a href="tel:966707225" style={{ color: C.navy, fontWeight: 700 }}>966 707 225</a>
        </p>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // APP PRINCIPAL
  // ══════════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.gray50, fontFamily: "system-ui,sans-serif", maxWidth: 500, margin: "0 auto", position: "relative" }}>

      {/* ── HEADER ── */}
      <div style={{ background: C.navy, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🚌</span>
          <div>
            <p style={{ color: "white", fontWeight: 900, fontSize: 14, margin: 0 }}>{pasajero.nombre.split(" ").slice(0,2).join(" ")}</p>
            <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, margin: 0 }}>{pasajero.empresa || "AFA Tours Peru"}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {miEstado === "embarcado" && <Pill color={C.green} bg="#DCFCE7">✅ A bordo</Pill>}
          <button onClick={salir} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "5px 12px", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Salir</button>
        </div>
      </div>

      {/* ── CONTENIDO ── */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 70 }}>

        {/* ════ MI RUTA ════ */}
        {tab === "ruta" && (
          <div>
            {/* MAPA */}
            <div style={{ position: "relative", height: 340 }}>
              <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />

              {/* Sin datos de parada */}
              {!miParada && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(248,250,252,0.95)" }}>
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 36, margin: "0 0 8px" }}>📋</p>
                    <p style={{ color: C.navy, fontWeight: 700, fontSize: 15 }}>Sin ruta asignada hoy</p>
                    <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>Tu empresa aún no registró tu paradero</p>
                  </div>
                </div>
              )}

              {/* Indicador cargando mapa */}
              {!mapListo && miParada && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: C.gray50 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ width: 32, height: 32, border: `3px solid ${C.gray200}`, borderTop: `3px solid ${C.navy}`, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 8px" }} />
                    <p style={{ color: C.gray400, fontSize: 12 }}>Cargando mapa...</p>
                  </div>
                </div>
              )}

              {/* Badge estado GPS */}
              {busPosicion && (
                <div style={{ position: "absolute", top: 12, left: 12, background: "white", borderRadius: 12, padding: "6px 12px", boxShadow: "0 2px 12px rgba(0,0,0,0.15)", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: estadoBus === "en_camino" ? C.green : estadoBus === "retrasado" ? C.amber : C.red, animation: "pulse 1.5s infinite" }} />
                  <span style={{ color: C.gray800, fontSize: 12, fontWeight: 700 }}>{estadoConfig.icon} {estadoConfig.txt}</span>
                </div>
              )}
            </div>

            {/* PANEL ETA */}
            {miParada && (
              <div style={{ margin: "0 12px", marginTop: -20, position: "relative", zIndex: 10 }}>
                <div style={{ background: C.white, borderRadius: 20, padding: 20, boxShadow: "0 4px 24px rgba(0,0,0,0.12)" }}>

                  {/* ETA principal */}
                  {busPosicion && etaMin !== null ? (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                      <div>
                        <p style={{ color: C.gray400, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>Tiempo estimado de llegada</p>
                        <p style={{ color: C.navy, fontWeight: 900, fontSize: 38, margin: "4px 0 0", lineHeight: 1 }}>{fmtETA(etaMin)}</p>
                        {distM !== null && <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>📏 {distM >= 1000 ? `${(distM/1000).toFixed(1)} km` : `${Math.round(distM)} m`} del bus a tu paradero</p>}
                      </div>
                      <div style={{ width: 64, height: 64, borderRadius: 20, background: estadoConfig.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>
                        {estadoConfig.icon}
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginBottom: 16 }}>
                      <p style={{ color: C.gray400, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 8px" }}>Estado del servicio</p>
                      <div style={{ background: C.gray50, borderRadius: 12, padding: "14px 16px" }}>
                        <p style={{ color: C.navy, fontWeight: 700, fontSize: 15, margin: 0 }}>🕐 Esperando inicio del recorrido</p>
                        <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>El conductor aún no ha iniciado la ruta</p>
                      </div>
                    </div>
                  )}

                  {/* Info bus y conductor */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                    <div style={{ background: C.gray50, borderRadius: 12, padding: "10px 14px" }}>
                      <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>🚌 Placa</p>
                      <p style={{ color: C.navy, fontWeight: 900, fontSize: 16, fontFamily: "monospace", margin: "4px 0 0" }}>{vehiculo?.placa || "—"}</p>
                    </div>
                    <div style={{ background: C.gray50, borderRadius: 12, padding: "10px 14px" }}>
                      <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>👤 Conductor</p>
                      <p style={{ color: C.navy, fontWeight: 700, fontSize: 12, margin: "4px 0 0" }}>{conductor?.nombre?.split(" ").slice(0,2).join(" ") || "—"}</p>
                    </div>
                    {busPosicion && (
                      <div style={{ background: C.gray50, borderRadius: 12, padding: "10px 14px" }}>
                        <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>🚀 Velocidad</p>
                        <p style={{ color: C.navy, fontWeight: 900, fontSize: 16, margin: "4px 0 0" }}>{busPosicion.velocidad} km/h</p>
                      </div>
                    )}
                    <div style={{ background: C.gray50, borderRadius: 12, padding: "10px 14px" }}>
                      <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>🎫 Mi estado</p>
                      <p style={{ color: miEstado === "embarcado" ? C.green : C.amber, fontWeight: 900, fontSize: 13, margin: "4px 0 0" }}>
                        {miEstado === "embarcado" ? "✅ A bordo" : "⏳ Esperando"}
                      </p>
                    </div>
                  </div>

                  {/* Mi paradero */}
                  <div style={{ background: "#EFF6FF", borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>📍</div>
                    <div>
                      <p style={{ color: C.navy, fontWeight: 900, fontSize: 14, margin: 0 }}>{miParada.nombre}</p>
                      {miParada.hora_estimada && <p style={{ color: "#1d4ed8", fontSize: 12, margin: "2px 0 0" }}>Hora estimada: {miParada.hora_estimada}</p>}
                      {miParada.direccion && <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>{miParada.direccion}</p>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* PARADAS DE LA RUTA */}
            {rutaParadas.length > 1 && (
              <div style={{ margin: "16px 12px 0" }}>
                <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>Paradas del recorrido ({rutaParadas.length})</p>
                <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  {rutaParadas.map((p, i) => {
                    const esMia = p.id === miParada?.id;
                    const completada = p.estado === "completada";
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < rutaParadas.length - 1 ? `1px solid ${C.gray100}` : "none", background: esMia ? "#EFF6FF" : "transparent" }}>
                        {/* Dot */}
                        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
                          <div style={{ width: 24, height: 24, borderRadius: "50%", background: completada ? C.navy : esMia ? "#1d4ed8" : C.gray200, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "white", fontWeight: 900 }}>
                            {completada ? "✓" : i + 1}
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ color: esMia ? C.navy : completada ? C.gray400 : C.gray800, fontWeight: esMia ? 900 : 600, fontSize: 13, margin: 0 }}>
                            {p.nombre}
                            {esMia && <span style={{ color: "#1d4ed8", fontSize: 11, fontWeight: 700, marginLeft: 8 }}>← Tu parada</span>}
                          </p>
                          {p.hora_estimada && <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>🕐 {p.hora_estimada}</p>}
                        </div>
                        <Pill color={completada ? C.navy : esMia ? "#1d4ed8" : C.gray400} bg={completada ? C.gray100 : esMia ? "#DBEAFE" : C.gray50}>
                          {completada ? "Completada" : esMia ? "Aquí" : "Próxima"}
                        </Pill>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Llamar a central */}
            {conductor?.telefono && (
              <div style={{ margin: "16px 12px 0" }}>
                <a href={`tel:${conductor.telefono}`}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 0", borderRadius: 14, background: C.white, border: `1px solid ${C.gray200}`, color: C.navy, fontWeight: 700, fontSize: 14, textDecoration: "none", boxShadow: "0 1px 6px rgba(0,0,0,0.05)" }}>
                  📱 Llamar al conductor: {conductor.telefono}
                </a>
              </div>
            )}
          </div>
        )}

        {/* ════ MI QR ════ */}
        {tab === "qr" && (
          <div style={{ padding: 16 }}>

            {/* Card principal con QR */}
            <div style={{ background: C.white, borderRadius: 24, overflow: "hidden", boxShadow: "0 8px 32px rgba(11,49,95,0.15)" }}>
              {/* Header de la card */}
              <div style={{ background: C.navy, padding: "20px 24px", textAlign: "center" }}>
                <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2, margin: "0 0 4px" }}>Identificación Digital</p>
                <p style={{ color: "white", fontWeight: 900, fontSize: 18, margin: 0 }}>AFA Tours Peru</p>
              </div>

              {/* QR */}
              <div style={{ padding: "28px 24px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                {pasajero.qr_code ? (
                  <>
                    <div style={{ padding: 12, background: C.white, borderRadius: 16, border: `3px solid ${C.navy}`, boxShadow: "0 4px 20px rgba(11,49,95,0.1)", marginBottom: 20 }}>
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(pasajero.qr_code)}&bgcolor=ffffff&color=0b315f&qzone=2&margin=0`}
                        alt="QR de embarque"
                        style={{ display: "block", width: 220, height: 220 }}
                      />
                    </div>
                    <p style={{ color: C.gray400, fontSize: 11, textAlign: "center", margin: "0 0 4px" }}>Muestra este código al conductor</p>
                    <p style={{ color: C.navy, fontSize: 12, fontWeight: 700, fontFamily: "monospace", textAlign: "center", letterSpacing: 2 }}>{pasajero.qr_code.slice(0, 16).toUpperCase()}</p>
                  </>
                ) : (
                  <div style={{ padding: 32, textAlign: "center" }}>
                    <p style={{ fontSize: 36, margin: "0 0 8px" }}>⏳</p>
                    <p style={{ color: C.navy, fontWeight: 700, fontSize: 15 }}>QR en proceso</p>
                    <p style={{ color: C.gray400, fontSize: 13 }}>Tu código será asignado pronto</p>
                  </div>
                )}
              </div>

              {/* Datos del pasajero */}
              <div style={{ margin: "0 20px 20px", background: C.gray50, borderRadius: 16, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {/* Foto o avatar */}
                  <div style={{ width: 56, height: 56, borderRadius: 16, background: pasajero.foto_url ? "transparent" : C.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                    {pasajero.foto_url
                      ? <img src={pasajero.foto_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <span style={{ color: "white", fontWeight: 900, fontSize: 22 }}>{pasajero.nombre.charAt(0)}</span>}
                  </div>
                  <div>
                    <p style={{ color: C.gray800, fontWeight: 900, fontSize: 17, margin: 0 }}>{pasajero.nombre}</p>
                    {pasajero.empresa && <p style={{ color: C.gray600, fontSize: 13, margin: "3px 0 0" }}>🏢 {pasajero.empresa}</p>}
                    {pasajero.dni && <p style={{ color: C.gray400, fontSize: 12, margin: "2px 0 0" }}>DNI: {pasajero.dni}</p>}
                  </div>
                </div>

                {/* Ruta asignada */}
                {miParada?.reserva && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.gray200}` }}>
                    <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 6px" }}>Ruta asignada</p>
                    <p style={{ color: C.navy, fontWeight: 800, fontSize: 13, margin: 0 }}>{miParada.reserva.origen} → {miParada.reserva.destino}</p>
                    <p style={{ color: C.gray600, fontSize: 12, margin: "3px 0 0" }}>📍 Paradero: {miParada.nombre}</p>
                    {miParada.hora_estimada && <p style={{ color: C.gray600, fontSize: 12, margin: "2px 0 0" }}>🕐 Hora estimada: {miParada.hora_estimada}</p>}
                    {miParada.reserva.fecha_servicio && <p style={{ color: C.gray400, fontSize: 11, margin: "4px 0 0" }}>📅 {new Date(miParada.reserva.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" })}</p>}
                  </div>
                )}
              </div>

              {/* Estado embarque */}
              <div style={{ margin: "0 20px 24px", padding: "12px 16px", borderRadius: 14, background: miEstado === "embarcado" ? "#DCFCE7" : "#FEF3C7", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>{miEstado === "embarcado" ? "✅" : "⏳"}</span>
                <div>
                  <p style={{ color: miEstado === "embarcado" ? C.green : C.amber, fontWeight: 900, fontSize: 14, margin: 0 }}>
                    {miEstado === "embarcado" ? "Embarque confirmado" : "Esperando embarque"}
                  </p>
                  <p style={{ color: miEstado === "embarcado" ? "#166534" : "#92400E", fontSize: 12, margin: "2px 0 0" }}>
                    {miEstado === "embarcado" ? "El conductor escaneó tu QR exitosamente" : "Muestra este QR cuando el bus llegue"}
                  </p>
                </div>
              </div>
            </div>

            {/* Instrucciones */}
            <div style={{ marginTop: 16, background: C.white, borderRadius: 16, padding: 20, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <p style={{ color: C.navy, fontWeight: 900, fontSize: 14, margin: "0 0 12px" }}>¿Cómo usar mi código QR?</p>
              {[
                ["1", "Espera tu bus en el paradero asignado"],
                ["2", "Cuando llegue, muestra esta pantalla al conductor"],
                ["3", "El conductor escanea tu código para confirmar tu embarque"],
                ["4", "Recibirás confirmación automática en la app"],
              ].map(([n, txt]) => (
                <div key={n} style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ color: "white", fontSize: 11, fontWeight: 900 }}>{n}</span>
                  </div>
                  <p style={{ color: C.gray600, fontSize: 13, margin: "2px 0 0" }}>{txt}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════ PERFIL ════ */}
        {tab === "perfil" && (
          <div style={{ padding: 16 }}>
            {/* Card principal */}
            <div style={{ background: C.navy, borderRadius: 20, padding: 24, marginBottom: 16, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 64, height: 64, borderRadius: 18, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 900, color: "white", flexShrink: 0, overflow: "hidden" }}>
                {pasajero.foto_url ? <img src={pasajero.foto_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : pasajero.nombre.charAt(0)}
              </div>
              <div>
                <p style={{ color: "white", fontWeight: 900, fontSize: 18, margin: 0 }}>{pasajero.nombre}</p>
                {pasajero.empresa && <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, margin: "3px 0 0" }}>{pasajero.empresa}</p>}
                {pasajero.dni && <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, margin: "2px 0 0" }}>DNI: {pasajero.dni}</p>}
              </div>
            </div>

            {/* Info de hoy */}
            {miParada && (
              <div style={{ background: C.white, borderRadius: 16, padding: 20, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 14px" }}>Mi servicio de hoy</p>
                {[
                  ["📍 Paradero", miParada.nombre],
                  ["🕐 Hora estimada", miParada.hora_estimada || "—"],
                  ["🚌 Placa del bus", vehiculo?.placa || "—"],
                  ["👤 Conductor", conductor?.nombre || "—"],
                  ["📅 Fecha", miParada.reserva?.fecha_servicio ? new Date(miParada.reserva.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { day: "numeric", month: "long" }) : "—"],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.gray100}` }}>
                    <span style={{ color: C.gray600, fontSize: 13 }}>{label}</span>
                    <span style={{ color: C.navy, fontWeight: 700, fontSize: 13 }}>{val}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Contacto AFA */}
            <div style={{ background: C.white, borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 14px" }}>Contacto AFA Tours Peru</p>
              {[
                { icon: "📞", label: "Central", val: "(01) 3453707", href: "tel:013453707" },
                { icon: "📱", label: "WhatsApp", val: "966 707 225", href: "https://wa.me/51966707225" },
                { icon: "✉️", label: "Email", val: "transporte@afatoursperu.com", href: "mailto:transporte@afatoursperu.com" },
              ].map(item => (
                <a key={item.label} href={item.href} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.gray100}`, textDecoration: "none" }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>{item.icon}</div>
                  <div>
                    <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>{item.label}</p>
                    <p style={{ color: C.navy, fontSize: 13, fontWeight: 700, margin: "2px 0 0" }}>{item.val}</p>
                  </div>
                  <span style={{ marginLeft: "auto", color: C.gray300, fontSize: 14 }}>→</span>
                </a>
              ))}
            </div>

            <button onClick={salir} style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: `2px solid #FECACA`, background: "#FEF2F2", color: C.red, fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
              Cerrar sesión
            </button>
          </div>
        )}
      </div>

      {/* ── NAV BAR ── */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 500, margin: "0 auto", background: C.white, borderTop: `1px solid ${C.gray200}`, display: "flex", zIndex: 20, boxShadow: "0 -2px 12px rgba(0,0,0,0.08)" }}>
        <TabBtn active={tab === "ruta"}   icon="🗺️" label="Mi Ruta"  onClick={() => setTab("ruta")} />
        <TabBtn active={tab === "qr"}     icon="🎫" label="Mi QR"    onClick={() => setTab("qr")} />
        <TabBtn active={tab === "perfil"} icon="👤" label="Perfil"   onClick={() => setTab("perfil")} />
      </div>

      <div style={{ height: 70 }} />

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes busMove { 0%{transform:translateY(0)} 100%{transform:translateY(-4px)} }
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
      `}</style>
    </div>
  );
}