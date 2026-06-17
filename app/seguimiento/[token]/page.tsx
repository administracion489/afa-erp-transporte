"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import "mapbox-gl/dist/mapbox-gl.css";

// ─── TIPOS ────────────────────────────────────────────────────────────────────
type Parada = {
  id: number; orden: number; nombre: string; direccion: string | null;
  lat: number | null; lng: number | null; hora_estimada: string | null; estado: string;
};
type UbicacionGPS = { lat: number; lng: number; velocidad: number; rumbo: number; estado: string; created_at: string };
type ReservaInfo = {
  id: number; estado: string; fecha_servicio: string; hora_servicio: string;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  conductor_id: number | null; conductor_tercero_id: number | null;
  empresa_tercerizada_id: number | null;
  vehiculo?: { placa: string; marca: string; modelo: string; color: string; categoria: string } | null;
  conductor?: { nombre: string; telefono: string } | null;
  empresa?: { razon_social: string; telefono: string } | null;
};
type RutaData = {
  coordenadas: [number, number][];
  tramos: any[];
  total_km: number;
  total_min: number;
  advertencia: string | null;
};

// ─── COLORES IDENTIDAD AFA TOURS PERÚ ──────────────────────────────────────────
const AFA = {
  azulOscuro:  "#0b315f",   // Primary
  azulMedio:   "#1d4ed8",
  azulClaro:   "#3b82f6",
  grisOscuro:  "#374151",
  grisMedio:   "#6b7280",
  grisClaro:   "#e5e7eb",
  verde:       "#16a34a",
  ambar:       "#f59e0b",
  rojo:        "#dc2626",
};

// Etiquetas canónicas (ver lib/estados). Colores propios de la marca AFA para el pasajero.
const ESTADOS: Record<string, { label: string; color: string }> = {
  pendiente:   { label: "Pendiente",   color: AFA.grisMedio },
  programada:  { label: "Programada",  color: AFA.azulClaro },
  confirmada:  { label: "Confirmada",  color: AFA.azulMedio },
  en_curso:    { label: "En curso",    color: AFA.azulOscuro },
  finalizada:  { label: "Finalizada",  color: AFA.verde },
  cancelada:   { label: "Cancelada",   color: AFA.rojo },
};

// ─── UTILIDADES ───────────────────────────────────────────────────────────────
function distanciaMetros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatearDistancia(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatearTiempo(min: number): string {
  if (min < 1) return "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}min`;
}

function formatearHoraLlegada(min: number): string {
  const llegada = new Date(Date.now() + min * 60 * 1000);
  return llegada.toLocaleTimeString("es-PE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Lima",
  });
}

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
export default function SeguimientoPage() {
  const { token } = useParams<{ token: string }>();

  // Refs
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const mapboxglRef = useRef<any>(null);
  const busMarkerRef = useRef<any>(null);
  const paradaMarkersRef = useRef<any[]>([]);
  const ubicacionRef = useRef<UbicacionGPS | null>(null);
  const mapDescentradoRef = useRef(false);

  // State
  const [reserva, setReserva] = useState<ReservaInfo | null>(null);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [ubicacion, setUbicacion] = useState<UbicacionGPS | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date | null>(null);
  const [ruta, setRuta] = useState<RutaData | null>(null);
  const [mapListo, setMapListo] = useState(false);
  const [mapboxListo, setMapboxListo] = useState(false);
  const [mapDescentrado, setMapDescentrado] = useState(false);
  // Sincronizar ref con estado (para uso en closures del mapa)
  useEffect(() => { mapDescentradoRef.current = mapDescentrado; }, [mapDescentrado]);

  // ETA en tiempo real (recalculado periódicamente)
  const [etaMin, setEtaMin] = useState<number | null>(null);
  const [etaKm, setEtaKm] = useState<number | null>(null);

  // SOS
  const [sosEstado, setSosEstado] = useState<"idle" | "presionando" | "enviando" | "enviado" | "error">("idle");
  const [sosProgreso, setSosProgreso] = useState(0);
  const sosTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ────────── 1. Cargar mapbox-gl ──────────
  useEffect(() => {
    let cancelled = false;
    import("mapbox-gl").then(({ default: mapboxgl }) => {
      if (cancelled) return;
      mapboxglRef.current = mapboxgl;
      setMapboxListo(true);
    });
    return () => { cancelled = true; };
  }, []);

  // ────────── 2. Cargar datos iniciales ──────────
  useEffect(() => {
    fetch(`/api/seguimiento?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setReserva(data.reserva);
        setParadas(data.paradas ?? []);
        if (data.ultimaUbicacion) {
          ubicacionRef.current = data.ultimaUbicacion;
          setUbicacion(data.ultimaUbicacion);
          setUltimaActualizacion(new Date(data.ultimaUbicacion.created_at));
        }
      })
      .catch(() => setError("Error al cargar el seguimiento"))
      .finally(() => setCargando(false));
  }, [token]);

  // ────────── 3. Inicializar mapa ──────────
  useEffect(() => {
    if (!mapRef.current || !reserva || cargando) return;
    if (!mapboxListo || !mapboxglRef.current) return;
    if (mapInstanceRef.current) return;

    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!mapboxToken) return;

    const mapboxgl = mapboxglRef.current;
    mapboxgl.accessToken = mapboxToken;
    const ub = ubicacionRef.current;

    const mapa = new mapboxgl.Map({
      container: mapRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: ub ? [Number(ub.lng), Number(ub.lat)] : [-77.0428, -12.0464],
      zoom: ub ? 14 : 12,
    });

    mapa.addControl(new mapboxgl.NavigationControl(), "top-right");

    mapa.on("load", () => {
      mapa.resize();
      setMapListo(true);
    });

    // Detectar cuando el usuario mueve el mapa manualmente
    mapa.on("dragstart", (e: any) => {
      if (e.originalEvent) setMapDescentrado(true);
    });

    mapInstanceRef.current = mapa;

    const container = mapRef.current;
    const resizeObserver = new ResizeObserver(() => {
      if (mapInstanceRef.current) mapInstanceRef.current.resize();
    });
    resizeObserver.observe(container);

    const t1 = setTimeout(() => mapa.resize(), 100);
    const t2 = setTimeout(() => mapa.resize(), 500);

    return () => {
      clearTimeout(t1); clearTimeout(t2);
      resizeObserver.disconnect();
      if (busMarkerRef.current) { try { busMarkerRef.current.remove(); } catch {} busMarkerRef.current = null; }
      paradaMarkersRef.current.forEach(m => { try { m.remove(); } catch {} });
      paradaMarkersRef.current = [];
      if (mapInstanceRef.current) { try { mapInstanceRef.current.remove(); } catch {} mapInstanceRef.current = null; }
    };
  }, [reserva, cargando, mapboxListo]);

  // ────────── 4. Marcadores de paradas ──────────
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current || !mapboxglRef.current) return;
    const mapboxgl = mapboxglRef.current;
    const map = mapInstanceRef.current;

    paradaMarkersRef.current.forEach(m => { try { m.remove(); } catch {} });
    paradaMarkersRef.current = [];

    paradas.forEach((p, i) => {
      if (!p.lat || !p.lng) return;
      const lat = Number(p.lat); const lng = Number(p.lng);
      if (isNaN(lat) || isNaN(lng)) return;

      const isFirst = i === 0;
      const isLast = i === paradas.length - 1;
      const completada = p.estado === "completada";
      const bg = completada ? AFA.verde : isFirst ? AFA.verde : isLast ? AFA.rojo : AFA.azulOscuro;

      const el = document.createElement("div");
      el.style.cssText = `width:30px;height:30px;border-radius:50%;background:${bg};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:900;cursor:pointer`;
      el.innerHTML = completada ? "✓" : String(i + 1);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([lng, lat])
        .setPopup(new mapboxgl.Popup({ offset: 16 }).setHTML(
          `<strong>${p.nombre}</strong>${p.direccion ? `<br/><small>${p.direccion}</small>` : ""}${p.hora_estimada ? `<br/><small>Est. ${p.hora_estimada}</small>` : ""}`
        ))
        .addTo(map);
      paradaMarkersRef.current.push(marker);
    });
  }, [mapListo, paradas]);

  // ────────── 5. Marcador del bus ──────────
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current || !mapboxglRef.current) return;
    if (!ubicacion) return;
    const mapboxgl = mapboxglRef.current;
    const map = mapInstanceRef.current;

    const lat = Number(ubicacion.lat); const lng = Number(ubicacion.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    const lngLat: [number, number] = [lng, lat];

    if (busMarkerRef.current) {
      busMarkerRef.current.setLngLat(lngLat);
      if (ubicacion.rumbo != null && !isNaN(Number(ubicacion.rumbo))) {
        busMarkerRef.current.setRotation(Number(ubicacion.rumbo));
      }
      if (!mapDescentradoRef.current) map.easeTo({ center: lngLat, duration: 1500 });
    } else {
      // Inyectar CSS de animación una sola vez
      if (!document.getElementById("afa-bus-css")) {
        const s = document.createElement("style");
        s.id = "afa-bus-css";
        s.textContent = `
          @keyframes afaBusPulse {
            0%   { transform:scale(1);   opacity:.5; }
            65%  { transform:scale(2.6); opacity:0;  }
            100% { transform:scale(2.6); opacity:0;  }
          }
          @keyframes afaBusPulse2 {
            0%   { transform:scale(1);   opacity:.3; }
            65%  { transform:scale(2.6); opacity:0;  }
            100% { transform:scale(2.6); opacity:0;  }
          }
          .afa-pulse1 { position:absolute; border-radius:50%; background:#3b82f6;
            animation:afaBusPulse  2s ease-out infinite; pointer-events:none; }
          .afa-pulse2 { position:absolute; border-radius:50%; background:#93c5fd;
            animation:afaBusPulse2 2s ease-out .7s infinite; pointer-events:none; }
        `;
        document.head.appendChild(s);
      }

      const el = document.createElement("div");
      el.style.cssText = "position:relative;width:48px;height:80px;cursor:pointer;";
      el.innerHTML = `
        <div style="position:absolute;top:50%;left:50%;width:46px;height:46px;margin:-23px 0 0 -23px;">
          <div class="afa-pulse1" style="inset:0;"></div>
          <div class="afa-pulse2" style="inset:0;"></div>
        </div>
        <img src="/bussinfondo3.png"
          style="position:relative;z-index:2;width:48px;height:80px;object-fit:contain;filter:drop-shadow(0 5px 14px rgba(6,14,40,.85));"
          alt="bus"/>
      `;

      busMarkerRef.current = new mapboxgl.Marker({
        element: el,
        rotation: Number(ubicacion.rumbo) || 0,
        rotationAlignment: "map",
        anchor: "center",
      })
        .setLngLat(lngLat)
        .addTo(map);
      map.flyTo({ center: lngLat, zoom: 15 });
    }
  }, [mapListo, ubicacion]);

  // ────────── 6. Cargar ruta inicial ──────────
  const cargarRuta = useCallback(async () => {
    if (!paradas || paradas.length < 2) return;
    const paradasConCoords = paradas.filter(p => p.lat !== null && p.lng !== null);
    if (paradasConCoords.length < 2) return;

    try {
      const res = await fetch("/api/ruta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paradas: paradasConCoords.map(p => ({
            lat: Number(p.lat), lng: Number(p.lng), nombre: p.nombre,
          })),
        }),
      });
      const data = await res.json();
      if (data.coordenadas && Array.isArray(data.coordenadas) && data.coordenadas.length > 0) {
        setRuta(data as RutaData);
      }
    } catch (e) {
      console.error("[Seguimiento] Error cargando ruta:", e);
    }
  }, [paradas]);

  useEffect(() => { cargarRuta(); }, [cargarRuta]);

  // ────────── 7. Dibujar ruta en mapa ──────────
  useEffect(() => {
    if (!ruta || !mapListo || !mapInstanceRef.current) return;
    if (!ruta.coordenadas || ruta.coordenadas.length === 0) return;
    const map = mapInstanceRef.current;

    try {
      ["ruta-sombra", "ruta-line"].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("ruta-google")) map.removeSource("ruta-google");

      map.addSource("ruta-google", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ruta.coordenadas } },
      });
      map.addLayer({
        id: "ruta-sombra", type: "line", source: "ruta-google",
        paint: { "line-color": AFA.azulOscuro, "line-width": 10, "line-opacity": 0.15, "line-blur": 5 },
      });
      map.addLayer({
        id: "ruta-line", type: "line", source: "ruta-google",
        paint: { "line-color": AFA.azulMedio, "line-width": 5, "line-opacity": 0.9 },
      });

      const mapboxgl = mapboxglRef.current;
      if (mapboxgl) {
        const bounds = ruta.coordenadas.reduce(
          (b: any, c: [number, number]) => b.extend(c),
          new mapboxgl.LngLatBounds(ruta.coordenadas[0], ruta.coordenadas[0])
        );
        map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 15 });
      }
    } catch (e) {
      console.error("[Seguimiento] Error dibujando ruta:", e);
    }
  }, [ruta, mapListo]);

  // ────────── 8. Realtime GPS ──────────
  useEffect(() => {
    if (cargando || error || !token || !reserva) return;
    const channel = supabase
      .channel("passenger-gps-" + reserva.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" }, (payload) => {
        const d = payload.new as any;
        if (d.reserva_id !== reserva.id) return;
        const nueva: UbicacionGPS = {
          lat: Number(d.lat), lng: Number(d.lng),
          velocidad: Number(d.velocidad) || 0, rumbo: Number(d.rumbo) || 0,
          estado: d.estado, created_at: d.created_at,
        };
        ubicacionRef.current = nueva;
        setUbicacion(nueva);
        setUltimaActualizacion(new Date(nueva.created_at));
      })
      .subscribe();

    const poll = async () => {
      try {
        const res = await fetch(`/api/seguimiento?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.error) return;
        if (data.ultimaUbicacion) {
          const nueva = data.ultimaUbicacion as UbicacionGPS;
          if (!ubicacionRef.current || ubicacionRef.current.created_at !== nueva.created_at) {
            ubicacionRef.current = nueva;
            setUbicacion(nueva);
            setUltimaActualizacion(new Date(nueva.created_at));
          }
        }
      } catch { /* silencioso */ }
    };
    const interval = setInterval(poll, 60000);
    return () => { supabase.removeChannel(channel); clearInterval(interval); };
  }, [token, cargando, error, reserva]);

  // ────────── 9. Recalcular ETA con Google Directions cada 60s ──────────
  const paradaPendiente = paradas.find(p => p.estado !== "completada");
  useEffect(() => {
    if (!ubicacion || !paradaPendiente?.lat || !paradaPendiente?.lng) {
      setEtaMin(null); setEtaKm(null);
      return;
    }

    let cancelled = false;
    const calcular = async () => {
      try {
        const res = await fetch("/api/ruta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paradas: [
              { lat: Number(ubicacion.lat), lng: Number(ubicacion.lng), nombre: "Bus" },
              { lat: Number(paradaPendiente.lat), lng: Number(paradaPendiente.lng), nombre: paradaPendiente.nombre },
            ],
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data?.total_min != null && data?.total_km != null) {
          setEtaMin(Number(data.total_min));
          setEtaKm(Number(data.total_km));
        }
      } catch { /* silencioso */ }
    };

    calcular();
    const interval = setInterval(calcular, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ubicacion, paradaPendiente?.id, paradaPendiente?.lat, paradaPendiente?.lng]);

  // ────────── 10. SOS — press-and-hold 3 segundos ──────────
  const cancelarSos = useCallback(() => {
    if (sosTimerRef.current) { clearInterval(sosTimerRef.current); sosTimerRef.current = null; }
    if (sosEstado === "presionando") {
      setSosEstado("idle");
      setSosProgreso(0);
    }
  }, [sosEstado]);

  const iniciarSos = useCallback(() => {
    if (sosEstado !== "idle") return;
    setSosEstado("presionando");
    setSosProgreso(0);
    const inicio = Date.now();
    sosTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - inicio;
      const pct = Math.min(100, (elapsed / 3000) * 100);
      setSosProgreso(pct);
      if (elapsed >= 3000) {
        if (sosTimerRef.current) { clearInterval(sosTimerRef.current); sosTimerRef.current = null; }
        ejecutarSos();
      }
    }, 50);
  }, [sosEstado]);

  const ejecutarSos = useCallback(async () => {
    setSosEstado("enviando");
    setSosProgreso(100);
    try {
      await fetch("/api/seguimiento/sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          lat: ubicacionRef.current?.lat ?? null,
          lng: ubicacionRef.current?.lng ?? null,
          motivo: "SOS activado por pasajero",
        }),
      });
      setSosEstado("enviado");
      // Iniciar llamada al 105
      window.location.href = "tel:105";
      // Reset después de 5s
      setTimeout(() => { setSosEstado("idle"); setSosProgreso(0); }, 5000);
    } catch {
      setSosEstado("error");
      setTimeout(() => { setSosEstado("idle"); setSosProgreso(0); }, 3000);
    }
  }, [token]);

  useEffect(() => () => {
    if (sosTimerRef.current) clearInterval(sosTimerRef.current);
  }, []);

  // ────────── Render: cargando / error ──────────
  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: AFA.grisClaro }}>
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-4" style={{ borderColor: AFA.azulOscuro, borderTopColor: "transparent" }} />
        <p className="font-medium" style={{ color: AFA.grisOscuro }}>Cargando seguimiento...</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: AFA.grisClaro }}>
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#fee2e2" }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={AFA.rojo} strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h2 className="text-xl font-bold mb-2" style={{ color: AFA.grisOscuro }}>Link no disponible</h2>
        <p style={{ color: AFA.grisMedio }}>{error}</p>
      </div>
    </div>
  );

  // ────────── Datos computados ──────────
  const vehiculo = (reserva as any)?.vehiculo;
  const conductor = (reserva as any)?.conductor;
  const estadoInfo = ESTADOS[reserva?.estado ?? ""] ?? { label: reserva?.estado, color: AFA.grisMedio };
  const completadas = paradas.filter(p => p.estado === "completada").length;
  const segsDesdeActualiz = ultimaActualizacion ? Math.round((Date.now() - ultimaActualizacion.getTime()) / 1000) : null;
  const gpsActivo = ubicacion && segsDesdeActualiz != null && segsDesdeActualiz < 60;

  // Distancia al próximo punto (Haversine sobre GPS actual)
  let distanciaMProxima: number | null = null;
  if (ubicacion && paradaPendiente?.lat && paradaPendiente?.lng) {
    distanciaMProxima = distanciaMetros(
      Number(ubicacion.lat), Number(ubicacion.lng),
      Number(paradaPendiente.lat), Number(paradaPendiente.lng),
    );
  }

  // Banner de proximidad
  let bannerProximidad: { texto: string; sub: string; color: string; pulse: boolean } | null = null;
  if (distanciaMProxima != null && paradaPendiente) {
    if (distanciaMProxima <= 30) {
      bannerProximidad = { texto: "¡Tu bus está aquí!", sub: paradaPendiente.nombre, color: AFA.verde, pulse: true };
    } else if (distanciaMProxima <= 200) {
      bannerProximidad = { texto: "Está llegando, prepárate", sub: `~${Math.round(distanciaMProxima)} m de ${paradaPendiente.nombre}`, color: AFA.ambar, pulse: true };
    } else if (distanciaMProxima <= 500) {
      bannerProximidad = { texto: "Tu bus está cerca", sub: `~${formatearDistancia(distanciaMProxima)} de ${paradaPendiente.nombre}`, color: AFA.azulMedio, pulse: false };
    }
  }

  // SOS botón texto
  const sosTextos = {
    idle:         { texto: "MANTENER PARA SOS",  sub: "3 segundos para confirmar" },
    presionando:  { texto: "MANTENGA PRESIONADO", sub: `${Math.round((3000 - (sosProgreso / 100) * 3000) / 100) / 10}s restantes` },
    enviando:     { texto: "ENVIANDO ALERTA...",  sub: "Llamando al 105" },
    enviado:      { texto: "✓ ALERTA ENVIADA",    sub: "Operadores notificados" },
    error:        { texto: "✗ ERROR",              sub: "Reintenta o llama al 105" },
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: AFA.grisClaro }}>
      {/* ────────── HEADER ────────── */}
      <header className="bg-white shadow-sm px-3 sm:px-5 py-2.5 flex items-center gap-3 border-b" style={{ borderColor: AFA.grisClaro }}>
        <img
          src="/logoafacotizacion-removebg-preview.png"
          alt="AFA Tours Perú"
          className="w-9 h-9 sm:w-10 sm:h-10 flex-shrink-0 object-contain"
        />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] sm:text-xs font-bold uppercase tracking-wider" style={{ color: AFA.azulOscuro }}>AFA Tours Perú</p>
          <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: AFA.grisMedio }}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${gpsActivo ? "animate-pulse" : ""}`} style={{ background: gpsActivo ? AFA.verde : AFA.rojo }} />
            GPS {gpsActivo ? "en vivo" : "sin señal"}
            {segsDesdeActualiz != null && <span className="hidden sm:inline">· hace {segsDesdeActualiz}s</span>}
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-bold text-white flex-shrink-0" style={{ background: estadoInfo.color }}>
          {estadoInfo.label}
        </span>
      </header>

      {/* ────────── BANNER PROXIMIDAD ────────── */}
      {bannerProximidad && (
        <div className={`px-4 py-2.5 text-white flex items-center gap-3 ${bannerProximidad.pulse ? "animate-pulse" : ""}`} style={{ background: bannerProximidad.color }}>
          <span className="text-2xl">{bannerProximidad.color === AFA.verde ? "🎉" : bannerProximidad.color === AFA.ambar ? "🔔" : "📍"}</span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-sm sm:text-base leading-tight">{bannerProximidad.texto}</p>
            <p className="text-xs opacity-90 truncate">{bannerProximidad.sub}</p>
          </div>
        </div>
      )}

      {/* ────────── LAYOUT: móvil vertical / desktop horizontal ────────── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
        {/* Mapa */}
        <div className="relative flex-1 min-h-[45vh] md:min-h-0">
          <div ref={mapRef} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />

          {/* Botón centrar mapa */}
          {mapDescentrado && ubicacion && (
            <button
              onClick={() => {
                if (mapInstanceRef.current && ubicacion) {
                  mapInstanceRef.current.easeTo({
                    center: [Number(ubicacion.lng), Number(ubicacion.lat)],
                    zoom: 15,
                    duration: 800,
                  });
                  setMapDescentrado(false);
                }
              }}
              className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-semibold shadow-lg"
              style={{ background: AFA.azulOscuro }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <line x1="12" y1="2" x2="12" y2="6"/>
                <line x1="12" y1="18" x2="12" y2="22"/>
                <line x1="2" y1="12" x2="6" y2="12"/>
                <line x1="18" y1="12" x2="22" y2="12"/>
              </svg>
              Centrar bus
            </button>
          )}

          {!ubicacion && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: "rgba(229,231,235,0.6)" }}>
              <div className="text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={AFA.grisMedio} strokeWidth="1.5" className="mx-auto mb-2">
                  <circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                </svg>
                <p className="text-sm font-medium" style={{ color: AFA.grisMedio }}>Esperando ubicación...</p>
              </div>
            </div>
          )}
        </div>

        {/* Panel info */}
        <div className="w-full md:w-96 bg-white md:border-l border-t md:border-t-0 overflow-y-auto" style={{ borderColor: AFA.grisClaro }}>
          <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">

            {/* ETA + Próxima parada — CARD DESTACADA */}
            {paradaPendiente && (
              <div className="rounded-xl p-4 text-white" style={{ background: `linear-gradient(135deg, ${AFA.azulOscuro} 0%, ${AFA.azulMedio} 100%)` }}>
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-80 mb-1">
                  {paradaPendiente.id === paradas[0]?.id
                    ? "VEHÍCULO EN CAMINO A"
                    : paradaPendiente.id === paradas[paradas.length - 1]?.id
                    ? "DESTINO FINAL"
                    : "PRÓXIMA PARADA"}
                </p>
                <p className="text-lg sm:text-xl font-bold leading-tight mb-2">{paradaPendiente.nombre}</p>
                {paradaPendiente.direccion && <p className="text-xs opacity-80 mb-3 line-clamp-2">{paradaPendiente.direccion}</p>}
                <div className="flex items-center gap-3 pt-2 border-t border-white/20">
                  {etaMin != null ? (
                    <>
                      <div className="flex-1">
                        <p className="text-[10px] uppercase opacity-70">Llega a las</p>
                        <p className="text-xl sm:text-2xl font-bold leading-tight">{formatearHoraLlegada(etaMin)}</p>
                        <p className="text-[11px] opacity-60 mt-0.5">en {formatearTiempo(etaMin)}</p>
                      </div>
                      {etaKm != null && (
                        <div className="text-right">
                          <p className="text-[10px] uppercase opacity-70">Distancia</p>
                          <p className="text-base font-bold">{etaKm < 1 ? formatearDistancia(etaKm * 1000) : `${etaKm.toFixed(1)} km`}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm opacity-80">Calculando tiempo estimado...</p>
                  )}
                </div>
              </div>
            )}

            {/* Progreso de paradas */}
            {paradas.length > 0 && (
              <div className="rounded-xl border p-3" style={{ borderColor: AFA.grisClaro }}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: AFA.grisMedio }}>Progreso</p>
                  <p className="text-xs font-bold" style={{ color: AFA.azulOscuro }}>{completadas}/{paradas.length}</p>
                </div>
                <div className="w-full rounded-full h-2 mb-3" style={{ background: AFA.grisClaro }}>
                  <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${paradas.length ? (completadas / paradas.length) * 100 : 0}%`, background: AFA.azulOscuro }} />
                </div>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {paradas.map((p, i) => (
                    <div key={p.id} className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 text-white" style={{ background: p.estado === "completada" ? AFA.verde : paradaPendiente?.id === p.id ? AFA.azulOscuro : AFA.grisMedio }}>
                        {p.estado === "completada" ? "✓" : i + 1}
                      </div>
                      <p className={`text-xs truncate flex-1 ${p.estado === "completada" ? "line-through" : "font-medium"}`} style={{ color: p.estado === "completada" ? AFA.grisMedio : paradaPendiente?.id === p.id ? AFA.azulOscuro : AFA.grisOscuro }}>{p.nombre}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vehículo, Conductor y Empresa — Card combinada */}
            <div className="rounded-xl border p-3 sm:p-4 space-y-3" style={{ borderColor: AFA.grisClaro }}>
              {/* Conductor */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0" style={{ background: conductor ? AFA.azulOscuro : AFA.grisMedio }}>
                  {conductor?.nombre ? conductor.nombre.charAt(0).toUpperCase() : "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold uppercase" style={{ color: AFA.grisMedio }}>Conductor</p>
                  <p className="text-sm font-bold truncate" style={{ color: AFA.grisOscuro }}>
                    {conductor?.nombre ?? "Sin asignar"}
                  </p>
                  {conductor?.telefono && <p className="text-[11px] font-mono" style={{ color: AFA.grisMedio }}>{conductor.telefono}</p>}
                </div>
              </div>

              {/* Vehículo */}
              <div className="flex items-center gap-3 pt-3 border-t" style={{ borderColor: AFA.grisClaro }}>
                <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: vehiculo ? AFA.azulOscuro : AFA.grisMedio }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M8 6v6M16 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold uppercase" style={{ color: AFA.grisMedio }}>Vehículo</p>
                  {vehiculo ? (
                    <>
                      <p className="text-sm font-bold font-mono" style={{ color: AFA.grisOscuro }}>{vehiculo.placa}</p>
                      <p className="text-[11px]" style={{ color: AFA.grisMedio }}>
                        {[vehiculo.marca, vehiculo.modelo, vehiculo.color].filter(Boolean).join(" · ")}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm font-medium" style={{ color: AFA.grisMedio }}>Sin asignar</p>
                  )}
                </div>
              </div>

              {/* Velocidad actual */}
              {ubicacion?.velocidad != null && Number(ubicacion.velocidad) > 0 && (
                <div className="flex items-center gap-3 pt-3 border-t" style={{ borderColor: AFA.grisClaro }}>
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: AFA.verde }}>
                    <span className="text-white text-sm font-bold">⚡</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold uppercase" style={{ color: AFA.grisMedio }}>Velocidad actual</p>
                    <p className="text-sm font-bold" style={{ color: AFA.grisOscuro }}>{Math.round(Number(ubicacion.velocidad))} km/h</p>
                  </div>
                </div>
              )}
            </div>

            {/* ────────── BOTONES DE ACCIÓN ────────── */}
            <div className="space-y-2 pt-2">
              {/* LLAMAR CONDUCTOR */}
              {conductor?.telefono && (
                <a
                  href={`tel:${conductor.telefono}`}
                  className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl font-bold text-white text-sm shadow-md transition-transform active:scale-95"
                  style={{ background: AFA.verde }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                  </svg>
                  LLAMAR AL CONDUCTOR
                </a>
              )}

              {/* SOS — Press & Hold 3s */}
              <button
                onPointerDown={iniciarSos}
                onPointerUp={cancelarSos}
                onPointerLeave={cancelarSos}
                onPointerCancel={cancelarSos}
                disabled={sosEstado === "enviando" || sosEstado === "enviado"}
                className="relative overflow-hidden flex items-center justify-center gap-2 w-full py-3.5 rounded-xl font-bold text-white text-sm shadow-md transition-transform active:scale-95 select-none touch-none"
                style={{ background: sosEstado === "enviado" ? AFA.verde : AFA.rojo }}
              >
                {/* Barra de progreso del press */}
                {sosEstado === "presionando" && (
                  <div className="absolute inset-y-0 left-0 bg-white/30 transition-none" style={{ width: `${sosProgreso}%` }} />
                )}
                <span className="relative flex items-center gap-2 z-10">
                  <span className="text-lg">{sosEstado === "enviado" ? "✓" : "🚨"}</span>
                  <span className="flex flex-col items-start leading-tight text-left">
                    <span className="font-extrabold tracking-wide text-[13px]">{sosTextos[sosEstado].texto}</span>
                    <span className="text-[10px] opacity-90 font-medium">{sosTextos[sosEstado].sub}</span>
                  </span>
                </span>
              </button>
            </div>

            {/* Footer info */}
            <div className="pt-2 text-center">
              <p className="text-[10px]" style={{ color: AFA.grisMedio }}>
                Reserva #{reserva?.id} · {reserva?.fecha_servicio} {reserva?.hora_servicio}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
