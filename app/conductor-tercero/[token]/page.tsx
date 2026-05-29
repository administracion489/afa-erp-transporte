"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import "mapbox-gl/dist/mapbox-gl.css";

// ─── TIPOS ────────────────────────────────────────────────────────────────────
type Parada = {
  id: number; orden: number; nombre: string; direccion: string | null;
  lat: number | null; lng: number | null; hora_estimada: string | null; estado: string;
};
type Fase = "inicio" | "en_ruta" | "finalizado" | "error";
type SesionLocal = {
  paradas: Parada[]; paradaIdx: number;
  reservaId: number; vehiculoId: number | null; startedAt: string;
  mapaAbierto?: boolean;
};

// ─── PALETA AFA CONDUCTOR ─────────────────────────────────────────────────────
const C = {
  azul:       "#1a48a8",
  azulOscuro: "#122f70",
  azulClaro:  "#2a5cc8",
  dorado:     "#f0c040",
  blanco:     "#ffffff",
  grisClaro:  "#f1f5f9",
  grisMedio:  "#64748b",
  grisOscuro: "#1e293b",
  verde:      "#16a34a",
  rojo:       "#dc2626",
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const RADIO_GEOFENCE_M  = 5;
const AUTO_FINALIZAR_MS = 10 * 60 * 1000;
const SESSION_TTL_MS    = 24 * 60 * 60 * 1000;
const VELOCIDAD_MIN_GPS_M_S = 0.8; // ~3 km/h: umbral para usar heading GPS vs brújula

// ─── HELPERS localStorage ─────────────────────────────────────────────────────
const sk = (t: string) => `afa_ct_${t}`;
function guardarSesion(token: string, d: SesionLocal) {
  try { localStorage.setItem(sk(token), JSON.stringify(d)); } catch {}
}
function leerSesion(token: string): SesionLocal | null {
  try {
    const raw = localStorage.getItem(sk(token)); if (!raw) return null;
    const s = JSON.parse(raw) as SesionLocal;
    if (!s.startedAt || Date.now() - new Date(s.startedAt).getTime() > SESSION_TTL_MS) {
      localStorage.removeItem(sk(token)); return null;
    }
    return s;
  } catch { return null; }
}
function borrarSesion(token: string) { try { localStorage.removeItem(sk(token)); } catch {} }

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function distanciaMetros(la1: number, ln1: number, la2: number, ln2: number): number {
  const R = 6371000, dLa = ((la2 - la1) * Math.PI) / 180, dLn = ((ln2 - ln1) * Math.PI) / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLn / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── ETIQUETA DE DIRECCIÓN ────────────────────────────────────────────────────
function getDireccionLabel(h: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round(((h % 360) + 360) % 360 / 45) % 8];
}

// ─── SUAVIZADO DE ÁNGULO (evita saltos en 0/360) ─────────────────────────────
function suavizarAngulo(actual: number, objetivo: number, factor = 0.25): number {
  let diff = objetivo - actual;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (actual + diff * factor + 360) % 360;
}

// ─── COMPONENTE ───────────────────────────────────────────────────────────────
export default function ConductorTerceroPage() {
  const { token } = useParams<{ token: string }>();

  // ── Estado UI ────────────────────────────────────────────────────────────────
  const [fase, setFase]                                 = useState<Fase>("inicio");
  const [paradas, setParadas]                           = useState<Parada[]>([]);
  const [paradaIdx, setParadaIdx]                       = useState(0);
  const [errorMsg, setErrorMsg]                         = useState<string | null>(null);
  const [cargando, setCargando]                         = useState(true);
  const [mostrarConfirmFinal, setMostrarConfirmFinal]   = useState(false);
  const [mostrarConfirmManual, setMostrarConfirmManual] = useState(false);
  const [cuentaRegresiva, setCuentaRegresiva]           = useState(AUTO_FINALIZAR_MS / 1000);

  // ── Estado mapa ──────────────────────────────────────────────────────────────
  const [mapaAbierto, setMapaAbierto]       = useState(false);
  const [mapboxListo, setMapboxListo]       = useState(false);
  const [mapListo, setMapListo]             = useState(false);
  const [mapDescentrado, setMapDescentrado] = useState(false);
  const [ubicacion, setUbicacion]           = useState<{ lat: number; lng: number } | null>(null);
  const [etaMin, setEtaMin]                 = useState<number | null>(null);
  const [etaKm, setEtaKm]                  = useState<number | null>(null);

  // ── Estado orientación / brújula ─────────────────────────────────────────────
  const [rumbo, setRumbo]                         = useState(0);       // 0-360, dirección actual del conductor
  const [modoNorteArriba, setModoNorteArriba]     = useState(false);   // false = heading-up (tipo Waze)
  const [orientacionActiva, setOrientacionActiva] = useState(false);   // permiso de brújula concedido

  // ── Refs GPS ─────────────────────────────────────────────────────────────────
  const watchIdRef            = useRef<number | null>(null);
  const posActualRef          = useRef<{ lat: number; lng: number } | null>(null);
  const intervaloUbicacionRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerAutoFinalRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervaloCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const paradaIdxRef          = useRef(0);
  const paradasRef            = useRef<Parada[]>([]);
  const reservaIdRef          = useRef<number | null>(null);
  const vehiculoIdRef         = useRef<number | null>(null);
  const startedAtRef          = useRef<string | null>(null);
  const wakeLockRef           = useRef<any>(null);
  const gpsRunningRef         = useRef(false);
  const faseRef               = useRef<Fase>("inicio");
  const mapaAbiertoRef        = useRef(false);
  const mapDescentradoRef     = useRef(false);

  // ── Refs mapa ────────────────────────────────────────────────────────────────
  const mapRef             = useRef<HTMLDivElement>(null);
  const mapInstanceRef     = useRef<any>(null);
  const mapboxglRef        = useRef<any>(null);
  const conductorMarkerRef = useRef<any>(null);
  const paradaMarkerRef    = useRef<any>(null);

  // ── Refs orientación ─────────────────────────────────────────────────────────
  const speedRef        = useRef<number>(0);           // velocidad actual m/s
  const rumboSuavRef    = useRef<number>(0);           // rumbo suavizado acumulado (no 0-360 bounded)
  const rumboRef        = useRef<number>(0);           // último rumbo para la brújula CSS

  // Sincronizar refs con state
  useEffect(() => { paradaIdxRef.current = paradaIdx; }, [paradaIdx]);
  useEffect(() => { paradasRef.current = paradas; }, [paradas]);
  useEffect(() => { faseRef.current = fase; }, [fase]);
  useEffect(() => { mapaAbiertoRef.current = mapaAbierto; }, [mapaAbierto]);
  useEffect(() => { mapDescentradoRef.current = mapDescentrado; }, [mapDescentrado]);
  useEffect(() => { rumboRef.current = rumbo; }, [rumbo]);

  // ── Wake Lock ────────────────────────────────────────────────────────────────
  const solicitarWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator) || wakeLockRef.current) return;
    try {
      wakeLockRef.current = await (navigator as any).wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => { wakeLockRef.current = null; });
    } catch {}
  }, []);

  const liberarWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return;
    try { await wakeLockRef.current.release(); } catch {}
    wakeLockRef.current = null;
  }, []);

  // ── Persistencia ─────────────────────────────────────────────────────────────
  const persistirSesion = useCallback(() => {
    if (!token || !startedAtRef.current || !reservaIdRef.current) return;
    guardarSesion(token, {
      paradas: paradasRef.current, paradaIdx: paradaIdxRef.current,
      reservaId: reservaIdRef.current, vehiculoId: vehiculoIdRef.current,
      startedAt: startedAtRef.current, mapaAbierto: mapaAbiertoRef.current,
    });
  }, [token]);

  // ── GPS ──────────────────────────────────────────────────────────────────────
  const enviarUbicacion = useCallback(async (pos: { lat: number; lng: number }) => {
    try {
      await fetch("/api/conductor-tercero/ubicacion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, lat: pos.lat, lng: pos.lng, velocidad: Math.round(speedRef.current * 3.6), rumbo: Math.round(rumboRef.current) }),
      });
    } catch {}
  }, [token]);

  const marcarParada = useCallback(async (paradaId: number) => {
    try {
      await fetch("/api/conductor-tercero/parada", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, paradaId }),
      });
      setParadas(prev => {
        const next = prev.map(p => p.id === paradaId ? { ...p, estado: "completada" } : p);
        paradasRef.current = next; return next;
      });
    } catch {}
  }, [token]);

  const detenerGPS = useCallback(() => {
    if (watchIdRef.current != null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
    if (intervaloUbicacionRef.current) { clearInterval(intervaloUbicacionRef.current); intervaloUbicacionRef.current = null; }
    gpsRunningRef.current = false;
  }, []);

  const ejecutarFinalizar = useCallback(async () => {
    setMostrarConfirmFinal(false); setMostrarConfirmManual(false);
    if (timerAutoFinalRef.current) clearTimeout(timerAutoFinalRef.current);
    if (intervaloCountdownRef.current) clearInterval(intervaloCountdownRef.current);
    detenerGPS(); liberarWakeLock(); borrarSesion(token);
    const pos = posActualRef.current;
    await fetch("/api/conductor-tercero/finalizar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, lat: pos?.lat, lng: pos?.lng }),
    }).catch(() => {});
    setFase("finalizado");
  }, [token, detenerGPS, liberarWakeLock]);

  const iniciarAutoFinalizar = useCallback(() => {
    setMostrarConfirmFinal(true); setCuentaRegresiva(AUTO_FINALIZAR_MS / 1000);
    intervaloCountdownRef.current = setInterval(() => {
      setCuentaRegresiva(prev => { if (prev <= 1) { if (intervaloCountdownRef.current) clearInterval(intervaloCountdownRef.current); return 0; } return prev - 1; });
    }, 1000);
    timerAutoFinalRef.current = setTimeout(() => {
      if (intervaloCountdownRef.current) clearInterval(intervaloCountdownRef.current);
      ejecutarFinalizar();
    }, AUTO_FINALIZAR_MS);
  }, [ejecutarFinalizar]);

  const verificarGeofence = useCallback((lat: number, lng: number) => {
    const idx = paradaIdxRef.current, lista = paradasRef.current;
    if (idx >= lista.length) return;
    const prox = lista[idx];
    if (!prox || prox.estado === "completada" || !prox.lat || !prox.lng) return;
    if (distanciaMetros(lat, lng, Number(prox.lat), Number(prox.lng)) <= RADIO_GEOFENCE_M) {
      marcarParada(prox.id);
      const ni = idx + 1; setParadaIdx(ni); paradaIdxRef.current = ni; persistirSesion();
      if (ni >= lista.length) iniciarAutoFinalizar();
    }
  }, [marcarParada, iniciarAutoFinalizar, persistirSesion]);

  const iniciarGPS = useCallback(() => {
    if (gpsRunningRef.current) return;
    if (!navigator.geolocation) { setErrorMsg("Tu dispositivo no soporta GPS."); return; }
    gpsRunningRef.current = true;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, heading: h, speed: s } = pos.coords;
        posActualRef.current = { lat, lng };
        speedRef.current = s ?? 0;
        setUbicacion({ lat, lng });

        // Heading desde GPS solo cuando hay velocidad real (>~3 km/h)
        if (h != null && !isNaN(h) && s != null && s >= VELOCIDAD_MIN_GPS_M_S) {
          // Suavizado para evitar saltos bruscos
          const suavizado = suavizarAngulo(rumboSuavRef.current, h);
          rumboSuavRef.current = suavizado;
          setRumbo(Math.round(suavizado));
        }
        verificarGeofence(lat, lng);
      },
      (err) => { console.warn("[GPS]", err.message); },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    intervaloUbicacionRef.current = setInterval(() => {
      if (posActualRef.current) enviarUbicacion(posActualRef.current);
    }, 10000);
  }, [enviarUbicacion, verificarGeofence]);

  // ── 1. Restaurar sesión ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = leerSesion(token);
    if (s) {
      setParadas(s.paradas); paradasRef.current = s.paradas;
      setParadaIdx(s.paradaIdx); paradaIdxRef.current = s.paradaIdx;
      reservaIdRef.current = s.reservaId; vehiculoIdRef.current = s.vehiculoId;
      startedAtRef.current = s.startedAt;
      if (s.mapaAbierto) setMapaAbierto(true);
      setFase("en_ruta");
    }
    setCargando(false);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. GPS + Wake Lock al entrar en en_ruta ──────────────────────────────────
  useEffect(() => { if (fase !== "en_ruta") return; iniciarGPS(); solicitarWakeLock(); }, [fase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Re-sincronizar al volver al primer plano ──────────────────────────────
  useEffect(() => {
    const handler = async () => {
      if (document.visibilityState !== "visible" || faseRef.current !== "en_ruta") return;
      solicitarWakeLock(); detenerGPS(); iniciarGPS();
      try {
        const res = await fetch(`/api/conductor-tercero/estado?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) return;
        if (data.estado === "finalizada" || data.estado === "cancelada") { borrarSesion(token); setFase("finalizado"); return; }
        if (Array.isArray(data.paradas)) {
          const ps = data.paradas as Parada[];
          setParadas(ps); paradasRef.current = ps;
          const idx = ps.findIndex(p => p.estado !== "completada");
          const ni = idx === -1 ? ps.length : idx; setParadaIdx(ni); paradaIdxRef.current = ni; persistirSesion();
        }
      } catch {}
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [token, solicitarWakeLock, detenerGPS, iniciarGPS, persistirSesion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Persistir cambios ──────────────────────────────────────────────────────
  useEffect(() => { if (fase === "en_ruta") persistirSesion(); }, [fase, paradas, paradaIdx, mapaAbierto, persistirSesion]);

  // ── 5. Brújula del dispositivo (fallback cuando está detenido) ───────────────
  useEffect(() => {
    if (!orientacionActiva || !mapaAbierto) return;

    const handler = (e: DeviceOrientationEvent) => {
      // Solo usar brújula cuando la velocidad GPS es baja (detenido o lento)
      if (speedRef.current >= VELOCIDAD_MIN_GPS_M_S) return;

      let heading: number | null = null;

      // iOS Safari: webkitCompassHeading ya viene calibrado desde Norte magnético
      const webkit = (e as any).webkitCompassHeading;
      if (webkit != null && !isNaN(webkit)) {
        heading = webkit;
      }
      // Android Chrome: necesita deviceorientationabsolute o alpha con e.absolute = true
      else if (e.alpha != null && (e as any).absolute === true) {
        heading = (360 - e.alpha + 360) % 360;
      }

      if (heading != null) {
        const suavizado = suavizarAngulo(rumboSuavRef.current, heading, 0.15);
        rumboSuavRef.current = suavizado;
        setRumbo(Math.round(suavizado));
      }
    };

    window.addEventListener("deviceorientation", handler);
    // Android: evento con orientación absoluta (más preciso)
    window.addEventListener("deviceorientationabsolute" as any, handler);

    return () => {
      window.removeEventListener("deviceorientation", handler);
      window.removeEventListener("deviceorientationabsolute" as any, handler);
    };
  }, [orientacionActiva, mapaAbierto]);

  // ── 6. Rotar mapa según rumbo (Heading-Up, tipo Waze) ────────────────────────
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current || modoNorteArriba || mapDescentradoRef.current) return;
    mapInstanceRef.current.easeTo({
      bearing: -rumbo,
      duration: 400,
      easing: (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t, // ease in-out quad
    });
  }, [mapListo, rumbo, modoNorteArriba]);

  // ── MAPA: cargar Mapbox lazily ───────────────────────────────────────────────
  useEffect(() => {
    if (!mapaAbierto || mapboxListo) return;
    let cancelled = false;
    import("mapbox-gl").then(({ default: mapboxgl }) => {
      if (cancelled) return;
      mapboxglRef.current = mapboxgl;
      setMapboxListo(true);
    });
    return () => { cancelled = true; };
  }, [mapaAbierto, mapboxListo]);

  // ── MAPA: inicializar instancia ──────────────────────────────────────────────
  useEffect(() => {
    if (!mapboxListo || !mapRef.current || mapInstanceRef.current) return;
    const mapboxgl = mapboxglRef.current;
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
    const pos = posActualRef.current;
    const mapa = new mapboxgl.Map({
      container: mapRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: pos ? [pos.lng, pos.lat] : [-77.0428, -12.0464],
      zoom: 16,
      bearing: -rumboRef.current, // orientar inmediatamente en la dirección actual
      pitch: 30,                  // ligera perspectiva 3D como en navegadores reales
    });
    // Solo control de zoom, sin brújula nativa (usamos la nuestra)
    mapa.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapa.on("load", () => { mapa.resize(); setMapListo(true); });
    mapa.on("dragstart", (e: any) => { if (e.originalEvent) setMapDescentrado(true); });
    mapInstanceRef.current = mapa;
    return () => {
      try { mapa.remove(); } catch {}
      mapInstanceRef.current = null;
      conductorMarkerRef.current = null;
      paradaMarkerRef.current = null;
      setMapListo(false);
    };
  }, [mapboxListo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── MAPA: resize al abrir/cerrar ────────────────────────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const t = setTimeout(() => mapInstanceRef.current?.resize(), 380);
    return () => clearTimeout(t);
  }, [mapaAbierto]);

  // ── MAPA: mover marcador del conductor ───────────────────────────────────────
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current || !mapboxglRef.current || !ubicacion) return;
    const mapboxgl = mapboxglRef.current;
    const lngLat: [number, number] = [ubicacion.lng, ubicacion.lat];
    if (conductorMarkerRef.current) {
      conductorMarkerRef.current.setLngLat(lngLat);
      conductorMarkerRef.current.setRotation(rumboRef.current || 0);
      if (!mapDescentradoRef.current) mapInstanceRef.current.easeTo({ center: lngLat, duration: 1000 });
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
      conductorMarkerRef.current = new mapboxgl.Marker({
        element: el,
        rotation: rumboRef.current || 0,
        rotationAlignment: "map",
        anchor: "center",
      })
        .setLngLat(lngLat)
        .addTo(mapInstanceRef.current);
      mapInstanceRef.current.flyTo({ center: lngLat, zoom: 16, pitch: 30 });
    }
  }, [mapListo, ubicacion]);

  // Actualizar rotación del marcador cuando cambia el rumbo (brújula / GPS)
  useEffect(() => {
    if (conductorMarkerRef.current) {
      conductorMarkerRef.current.setRotation(rumbo);
    }
  }, [rumbo]);

  // ── MAPA: marcador de próxima parada ─────────────────────────────────────────
  const proximaParadaId = (paradas.find(p => p.estado !== "completada") ?? null)?.id;
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current || !mapboxglRef.current) return;
    if (paradaMarkerRef.current) { paradaMarkerRef.current.remove(); paradaMarkerRef.current = null; }
    const prox = paradasRef.current.find(p => p.id === proximaParadaId);
    if (!prox?.lat || !prox?.lng) return;
    const mapboxgl = mapboxglRef.current;
    const el = document.createElement("div");
    el.style.cssText = `
      width: 40px; height: 40px; border-radius: 50%;
      background: ${C.dorado}; border: 3px solid ${C.azulOscuro};
      box-shadow: 0 2px 12px rgba(0,0,0,.4);
      display: flex; align-items: center; justify-content: center;
      color: ${C.azulOscuro}; font-size: 15px; font-weight: 900;
    `;
    el.innerHTML = String(prox.orden);
    paradaMarkerRef.current = new mapboxgl.Marker({ element: el })
      .setLngLat([Number(prox.lng), Number(prox.lat)])
      .setPopup(new mapboxgl.Popup({ offset: 20 }).setHTML(
        `<strong>${prox.nombre}</strong>${prox.direccion ? `<br/><small style="color:#64748b">${prox.direccion}</small>` : ""}`
      ))
      .addTo(mapInstanceRef.current);
  }, [mapListo, proximaParadaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── MAPA: dibujar ruta Google Directions ────────────────────────────────────
  useEffect(() => {
    if (!mapListo || !mapInstanceRef.current) return;
    let cancelled = false;
    const cargar = async () => {
      const map = mapInstanceRef.current;
      const pos = posActualRef.current;
      const prox = paradasRef.current.find(p => p.id === proximaParadaId);
      if (!pos || !prox?.lat || !prox?.lng) return;
      try {
        const res = await fetch("/api/ruta", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paradas: [
              { lat: pos.lat, lng: pos.lng, nombre: "Conductor" },
              { lat: Number(prox.lat), lng: Number(prox.lng), nombre: prox.nombre },
            ],
          }),
        });
        const data = await res.json();
        if (cancelled || !data.coordenadas?.length) return;
        setEtaMin(Math.round(Number(data.total_min)));
        setEtaKm(Number(data.total_km));
        try {
          ["ruta-cond-sombra", "ruta-cond"].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
          if (map.getSource("ruta-cond")) map.removeSource("ruta-cond");
        } catch {}
        map.addSource("ruta-cond", {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: data.coordenadas } },
        });
        map.addLayer({ id: "ruta-cond-sombra", type: "line", source: "ruta-cond",
          paint: { "line-color": C.azulOscuro, "line-width": 14, "line-opacity": 0.1 } });
        map.addLayer({ id: "ruta-cond", type: "line", source: "ruta-cond",
          paint: { "line-color": C.azul, "line-width": 6, "line-opacity": 0.9 } });
        // Ajustar vista
        const bounds = data.coordenadas.reduce(
          (b: any, c: [number, number]) => b.extend(c),
          new mapboxglRef.current.LngLatBounds(data.coordenadas[0], data.coordenadas[0])
        );
        map.fitBounds(bounds, { padding: { top: 120, bottom: 50, left: 50, right: 50 }, maxZoom: 17, duration: 900 });
      } catch {}
    };
    cargar();
    return () => { cancelled = true; };
  }, [mapListo, proximaParadaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup al desmontar ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (intervaloUbicacionRef.current) clearInterval(intervaloUbicacionRef.current);
      if (timerAutoFinalRef.current) clearTimeout(timerAutoFinalRef.current);
      if (intervaloCountdownRef.current) clearInterval(intervaloCountdownRef.current);
    };
  }, []);

  // ── Abrir mapa + solicitar permiso de orientación ───────────────────────────
  const handleAbrirMapa = useCallback(async () => {
    const abriendo = !mapaAbierto;
    setMapaAbierto(abriendo);
    if (abriendo && !orientacionActiva) {
      // iOS 13+: requiere permiso explícito del usuario (se debe llamar desde un gesto)
      const DOE = DeviceOrientationEvent as any;
      if (typeof DOE.requestPermission === "function") {
        try {
          const perm = await DOE.requestPermission();
          if (perm === "granted") setOrientacionActiva(true);
        } catch {}
      } else {
        // Android / Chrome / otros: no requieren permiso
        setOrientacionActiva(true);
      }
    }
  }, [mapaAbierto, orientacionActiva]);

  // ── Reiniciar North-Up → Heading-Up ────────────────────────────────────────
  const toggleModoNorte = useCallback(() => {
    const irANorte = !modoNorteArriba;
    setModoNorteArriba(irANorte);
    if (irANorte) {
      // Fijar mapa mirando al Norte
      mapInstanceRef.current?.easeTo({ bearing: 0, duration: 500 });
    } else {
      // Restaurar heading-up inmediatamente con el rumbo actual
      mapInstanceRef.current?.easeTo({ bearing: -rumboRef.current, duration: 500 });
    }
  }, [modoNorteArriba]);

  // ── INICIAR SERVICIO ──────────────────────────────────────────────────────────
  const handleIniciarServicio = async () => {
    setCargando(true);
    try {
      const posInicial = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      );
      const { latitude: lat, longitude: lng } = posInicial.coords;
      const res = await fetch("/api/conductor-tercero/iniciar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, lat, lng }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error ?? "Error al iniciar servicio"); return; }
      reservaIdRef.current = data.reservaId; vehiculoIdRef.current = data.vehiculoId ?? null;
      startedAtRef.current = new Date().toISOString();
      const ps = data.paradas as Parada[];
      const idx = ps.findIndex((p: Parada) => p.estado !== "completada");
      const idxF = idx === -1 ? ps.length : idx;
      setParadas(ps); paradasRef.current = ps; setParadaIdx(idxF); paradaIdxRef.current = idxF;
      setFase("en_ruta");
    } catch (e: unknown) {
      setErrorMsg(e instanceof GeolocationPositionError
        ? "No se pudo obtener tu ubicación GPS. Activa el GPS e intenta nuevamente."
        : "Error de red. Verifica tu conexión.");
    } finally { setCargando(false); }
  };

  // ── Datos computados ──────────────────────────────────────────────────────────
  const paradasPendientes = paradas.filter(p => p.estado !== "completada");
  const completadas       = paradas.filter(p => p.estado === "completada").length;
  const proximaParada     = paradasPendientes[0] ?? null;

  // Ángulo CSS del compás: la aguja roja siempre apunta al Norte real
  // Con el mapa rotado -rumbo, el Norte en pantalla está a +rumbo desde arriba
  // → rotate(rumbo) hace que la aguja apunte hacia donde está el Norte real
  const compassCssRotation = rumbo;

  // ─────────────────────────────── RENDERS ──────────────────────────────────────

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.azul }}>
      <div className="flex flex-col items-center gap-4">
        <img src="/icon-afa-conductor.png" alt="AFA" className="w-20 h-20 rounded-2xl shadow-xl" />
        <div className="w-8 h-8 rounded-full animate-spin" style={{ border: `3px solid ${C.dorado}`, borderTopColor: "transparent" }} />
      </div>
    </div>
  );

  if (fase === "error" || errorMsg) return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: C.grisClaro }}>
      <div className="text-center max-w-sm w-full">
        <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "#fee2e2" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.rojo} strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: C.grisOscuro }}>Problema</h2>
        <p className="mb-6" style={{ color: C.grisMedio }}>{errorMsg ?? "Link inválido o expirado"}</p>
        <p className="text-sm" style={{ color: C.grisMedio }}>Contacta a AFA Transportes para obtener un nuevo enlace.</p>
      </div>
    </div>
  );

  if (fase === "finalizado") return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{ background: `linear-gradient(160deg, ${C.azulOscuro} 0%, ${C.azul} 60%, ${C.azulClaro} 100%)` }}>
      <div className="text-center max-w-sm w-full">
        <div className="w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 shadow-xl"
          style={{ background: "rgba(255,255,255,0.15)", border: `3px solid ${C.dorado}` }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={C.dorado} strokeWidth="2.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2 className="text-3xl font-extrabold mb-2" style={{ color: C.blanco }}>Servicio finalizado</h2>
        <div className="h-0.5 w-16 mx-auto my-4 rounded-full" style={{ background: C.dorado }} />
        <p style={{ color: "rgba(255,255,255,.7)" }}>Gracias por su servicio.</p>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,.45)" }}>Puede cerrar esta página.</p>
      </div>
    </div>
  );

  if (fase === "inicio") return (
    <div className="min-h-screen flex flex-col"
      style={{ background: `linear-gradient(160deg, ${C.azulOscuro} 0%, ${C.azul} 55%, ${C.azulClaro} 100%)` }}>
      <div className="flex-1 flex flex-col items-center justify-center px-8 pt-16 pb-8">
        <img src="/icon-afa-conductor.png" alt="AFA Conductor" className="w-28 h-28 rounded-3xl mb-8"
          style={{ boxShadow: `0 8px 40px rgba(0,0,0,.4), 0 0 0 4px rgba(240,192,64,.3)` }} />
        <h1 className="text-4xl font-extrabold tracking-tight mb-1" style={{ color: C.blanco }}>AFA Conductor</h1>
        <div className="h-1 w-16 rounded-full my-3" style={{ background: C.dorado }} />
        <p className="text-base text-center" style={{ color: "rgba(255,255,255,.65)" }}>
          Toque el botón para iniciar su servicio
        </p>
      </div>
      <div className="px-6 pb-12">
        <button onClick={handleIniciarServicio}
          className="w-full py-5 rounded-2xl text-xl font-extrabold tracking-wide transition-all active:scale-95 shadow-xl"
          style={{ background: C.dorado, color: C.azulOscuro, boxShadow: `0 4px 24px rgba(240,192,64,.5)` }}>
          ▶  INICIAR SERVICIO
        </button>
        <p className="text-center text-xs mt-4" style={{ color: "rgba(255,255,255,.4)" }}>
          Se activará el GPS y se notificará el inicio del servicio
        </p>
      </div>
    </div>
  );

  // ── EN RUTA ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ background: C.grisClaro }}>

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex-shrink-0"
        style={{ background: `linear-gradient(135deg, ${C.azulOscuro} 0%, ${C.azul} 100%)` }}>
        <div className="flex items-center gap-3 mb-3">
          <img src="/icon-afa-conductor.png" alt="AFA" className="w-9 h-9 rounded-xl flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: C.dorado }}>AFA Conductor</p>
            <p className="text-sm font-semibold" style={{ color: "rgba(255,255,255,.8)" }}>En servicio</p>
          </div>
          <span className="text-xs font-bold px-3 py-1 rounded-full flex-shrink-0"
            style={{ background: "rgba(255,255,255,.15)", color: C.blanco }}>
            {completadas}/{paradas.length} paradas
          </span>
        </div>
        <div className="w-full rounded-full h-2" style={{ background: "rgba(255,255,255,.2)" }}>
          <div className="h-2 rounded-full transition-all duration-500"
            style={{ width: `${paradas.length ? (completadas / paradas.length) * 100 : 0}%`, background: C.dorado }} />
        </div>
      </div>

      {/* Card próxima parada */}
      <div className="px-4 pt-4 flex-shrink-0">
        {proximaParada ? (
          <div className="bg-white rounded-2xl p-4 shadow-sm" style={{ borderLeft: `4px solid ${C.azul}` }}>
            <p className="text-[10px] font-extrabold uppercase tracking-widest mb-1" style={{ color: C.azul }}>
              Próxima parada
            </p>
            <p className="text-xl font-bold" style={{ color: C.grisOscuro }}>{proximaParada.nombre}</p>
            {proximaParada.direccion && (
              <p className="text-sm mt-0.5" style={{ color: C.grisMedio }}>{proximaParada.direccion}</p>
            )}
            {proximaParada.hora_estimada && (
              <p className="text-sm mt-1" style={{ color: C.grisMedio }}>
                Hora estimada: <strong style={{ color: C.grisOscuro }}>{proximaParada.hora_estimada}</strong>
              </p>
            )}
            {/* GPS status + botón Ver ruta */}
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse" style={{ background: C.verde }} />
                <span className="text-xs truncate" style={{ color: C.grisMedio }}>GPS activo — avanza automáticamente</span>
              </div>
              <button
                onClick={handleAbrirMapa}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg flex-shrink-0 transition-all active:scale-95"
                style={{
                  background: mapaAbierto ? C.azul : `rgba(26,72,168,0.1)`,
                  color: mapaAbierto ? C.blanco : C.azul,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                </svg>
                {mapaAbierto ? "Cerrar mapa" : "Ver ruta"}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl p-4 text-center" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
            <p className="font-bold" style={{ color: C.verde }}>✓ Todas las paradas completadas</p>
          </div>
        )}
      </div>

      {/* ── PANEL DE MAPA (70vh, siempre en DOM) ──────────────────────────────── */}
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{
          height: mapaAbierto ? "70vh" : "0",
          transition: "height 0.35s cubic-bezier(0.4,0,0.2,1)",
        }}
      >
        <div ref={mapRef} className="relative" style={{ width: "100%", height: "70vh" }}>

          {/* Spinner cargando Mapbox */}
          {mapaAbierto && !mapListo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10"
              style={{ background: C.grisClaro }}>
              <div className="w-10 h-10 rounded-full animate-spin mb-3"
                style={{ border: `3px solid ${C.azul}`, borderTopColor: "transparent" }} />
              <p className="text-sm font-medium" style={{ color: C.grisMedio }}>Cargando mapa...</p>
            </div>
          )}

          {/* ── Overlay ETA (arriba) ────────────────────────────────────────── */}
          {mapaAbierto && mapListo && (
            <div className="absolute top-3 left-3 z-10 rounded-2xl overflow-hidden"
              style={{ boxShadow: "0 4px 24px rgba(0,0,0,.35)", minWidth: "160px" }}>
              <div className="px-4 py-3 flex items-center gap-4"
                style={{ background: `${C.azulOscuro}f0`, backdropFilter: "blur(10px)" }}>
                {etaMin != null ? (
                  <>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "rgba(255,255,255,.5)" }}>Llega en</p>
                      <p className="text-2xl font-extrabold leading-tight" style={{ color: C.blanco }}>
                        {etaMin < 60 ? `${etaMin} min` : `${Math.floor(etaMin / 60)}h ${etaMin % 60}m`}
                      </p>
                    </div>
                    {etaKm != null && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "rgba(255,255,255,.5)" }}>Dist.</p>
                        <p className="text-lg font-bold" style={{ color: C.dorado }}>
                          {etaKm < 1 ? `${Math.round(etaKm * 1000)}m` : `${etaKm.toFixed(1)}km`}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm" style={{ color: "rgba(255,255,255,.7)" }}>Calculando...</p>
                )}
              </div>
            </div>
          )}

          {/* ── Botón cerrar (esquina superior derecha) ─────────────────────── */}
          {mapaAbierto && mapListo && (
            <button onClick={() => setMapaAbierto(false)}
              className="absolute top-3 right-3 z-20 w-9 h-9 rounded-xl flex items-center justify-center shadow-lg"
              style={{ background: `${C.azulOscuro}dd` }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}

          {/* ── Botón centrar bus ────────────────────────────────────────────── */}
          {mapaAbierto && mapListo && mapDescentrado && ubicacion && (
            <button
              onClick={() => {
                mapInstanceRef.current?.easeTo({
                  center: [ubicacion.lng, ubicacion.lat],
                  bearing: modoNorteArriba ? 0 : -rumboRef.current,
                  zoom: 16,
                  pitch: 30,
                  duration: 800,
                });
                setMapDescentrado(false);
              }}
              className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-semibold shadow-xl"
              style={{ background: `${C.azulOscuro}f0`, backdropFilter: "blur(8px)", border: `1px solid rgba(255,255,255,0.2)` }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <line x1="12" y1="2" x2="12" y2="6"/>
                <line x1="12" y1="18" x2="12" y2="22"/>
                <line x1="2" y1="12" x2="6" y2="12"/>
                <line x1="18" y1="12" x2="22" y2="12"/>
              </svg>
              Centrar
            </button>
          )}

          {/* ── Brújula interactiva (esquina inferior derecha) ───────────────── */}
          {mapaAbierto && mapListo && (
            <button
              onClick={toggleModoNorte}
              className="absolute bottom-5 right-3 z-20 flex flex-col items-center justify-center rounded-full shadow-xl"
              style={{
                width: "52px", height: "52px",
                background: `${C.azulOscuro}f5`,
                border: `2px solid ${modoNorteArriba ? C.dorado : "rgba(255,255,255,0.2)"}`,
                boxShadow: modoNorteArriba ? `0 0 0 3px rgba(240,192,64,0.3)` : "0 4px 16px rgba(0,0,0,.4)",
              }}
            >
              {/* Aguja del compás: la punta roja siempre apunta al Norte real */}
              <div style={{ transform: `rotate(${compassCssRotation}deg)`, transition: "transform 0.4s ease", lineHeight: 0 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  {/* Punta norte (roja) */}
                  <path d="M12 2L9 12h6L12 2z" fill="#ef4444" />
                  {/* Punta sur (blanco semitransparente) */}
                  <path d="M12 22L9 12h6L12 22z" fill="rgba(255,255,255,0.35)" />
                  {/* Centro */}
                  <circle cx="12" cy="12" r="2.5" fill="white" />
                </svg>
              </div>
              {/* Etiqueta: dirección en modo heading-up, o "N" en North-up */}
              <span className="text-[9px] font-extrabold mt-0.5 leading-none"
                style={{ color: modoNorteArriba ? C.dorado : "rgba(255,255,255,0.75)" }}>
                {modoNorteArriba ? "N↑" : getDireccionLabel(rumbo)}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Lista de paradas */}
      <div className="flex-1 px-4 mt-4 space-y-2 pb-4">
        <p className="text-[10px] font-extrabold uppercase tracking-widest mb-3" style={{ color: C.grisMedio }}>
          Ruta completa
        </p>
        {paradas.map((p, i) => {
          const esProxima  = proximaParada?.id === p.id;
          const completada = p.estado === "completada";
          return (
            <div key={p.id}
              className="flex items-center gap-3 p-3 rounded-xl border transition-all"
              style={{
                background: completada ? C.grisClaro : C.blanco,
                borderColor: esProxima ? C.azul : "#e2e8f0",
                opacity: completada ? 0.55 : 1,
                boxShadow: esProxima ? `0 0 0 1px ${C.azul}` : "none",
              }}
            >
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-extrabold"
                style={{ background: completada ? C.verde : esProxima ? C.azul : "#cbd5e1", color: C.blanco }}>
                {completada
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  : i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`font-semibold truncate ${completada ? "line-through" : ""}`}
                  style={{ color: completada ? C.grisMedio : C.grisOscuro }}>{p.nombre}</p>
                {p.hora_estimada && <p className="text-xs" style={{ color: C.grisMedio }}>{p.hora_estimada}</p>}
              </div>
              {esProxima && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: C.azul, color: C.blanco }}>PRÓXIMA</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Botón FINALIZAR — siempre visible */}
      <div className="px-4 pb-8 pt-2 flex-shrink-0">
        <button onClick={() => setMostrarConfirmManual(true)}
          className="w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform"
          style={{ background: C.rojo, color: C.blanco, fontSize: "0.95rem" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          FINALIZAR SERVICIO
        </button>
      </div>

      {/* ── Modal: auto-finalizar ────────────────────────────────────────────── */}
      {mostrarConfirmFinal && (
        <div className="fixed inset-0 flex items-end justify-center z-50 p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: "#f0fdf4", border: `2px solid ${C.verde}` }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.verde} strokeWidth="2.5">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-1" style={{ color: C.grisOscuro }}>¿Llegó al destino?</h3>
            <p className="text-sm mb-1" style={{ color: C.grisMedio }}>Ha llegado a la última parada.</p>
            <p className="text-sm mb-4" style={{ color: C.grisMedio }}>
              Finaliza automáticamente en{" "}
              <strong style={{ color: C.grisOscuro }}>
                {Math.floor(cuentaRegresiva / 60)}:{String(cuentaRegresiva % 60).padStart(2, "0")}
              </strong>
            </p>
            <div className="w-full rounded-full h-2 mb-5" style={{ background: C.grisClaro }}>
              <div className="h-2 rounded-full transition-all duration-1000"
                style={{ width: `${(cuentaRegresiva / (AUTO_FINALIZAR_MS / 1000)) * 100}%`, background: C.azul }} />
            </div>
            <button onClick={ejecutarFinalizar} className="w-full py-4 rounded-2xl text-lg font-bold text-white mb-3"
              style={{ background: C.verde }}>Confirmar finalización</button>
            <button
              onClick={() => { setMostrarConfirmFinal(false); if (timerAutoFinalRef.current) clearTimeout(timerAutoFinalRef.current); if (intervaloCountdownRef.current) clearInterval(intervaloCountdownRef.current); }}
              className="w-full py-3 rounded-2xl text-base font-medium"
              style={{ background: C.grisClaro, color: C.grisMedio }}>Aún no llegué</button>
          </div>
        </div>
      )}

      {/* ── Modal: finalizar manual ──────────────────────────────────────────── */}
      {mostrarConfirmManual && (
        <div className="fixed inset-0 flex items-end justify-center z-50 p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: "#fef2f2", border: `2px solid ${C.rojo}` }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.rojo} strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-1" style={{ color: C.grisOscuro }}>¿Finalizar servicio?</h3>
            <p className="text-sm mb-6" style={{ color: C.grisMedio }}>
              El GPS se detendrá y se registrará el cierre del servicio.
            </p>
            <button onClick={ejecutarFinalizar} className="w-full py-4 rounded-2xl text-lg font-bold text-white mb-3"
              style={{ background: C.rojo }}>Sí, finalizar</button>
            <button onClick={() => setMostrarConfirmManual(false)}
              className="w-full py-3 rounded-2xl text-base font-medium"
              style={{ background: C.grisClaro, color: C.grisMedio }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}
