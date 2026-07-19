"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import "mapbox-gl/dist/mapbox-gl.css";
import { pedirPermisoUbicacion, obtenerUbicacion } from "@/lib/geo";

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

// ─── CADENCIA DE ENVÍO ADAPTATIVA (mismo criterio que la app del conductor AFA) ──
// Denso cuando importa (cerca de paradero / en marcha) y espaciado detenido. Produce
// puntos a ~50-78 m → la huella (Map Matching por ventanas de lib/huella.ts) se pega a
// la pista igual que la app nativa, en vez de los ~110 m del envío PLANO de 10 s que
// dejaba rectas para los terceros que usan el link web.
const UMBRAL_PARADERO_M = 150;
function intervaloEnvioMs(kmh: number, cercaParadero: boolean): number {
  if (cercaParadero) return 3000;   // arribo/embarque: precisar la maniobra
  // Cadencia MÁS DENSA (jul-2026, pedido del usuario): más fixes en lento/urbano = más fuente para el
  // Map Matching (menos zigzag/estimado en la huella). El salto-gate de >40 m (abajo) también dispara.
  if (kmh < 3)  return 15000;       // detenido: heartbeat (antes 25 s)
  if (kmh < 20) return 3000;        // lento / tráfico denso (antes 5 s): "en lento solo veo 2 puntos"
  if (kmh < 60) return 3000;        // urbano (antes 4 s)
  return 3000;                      // carretera: más seguido para no saltar la huella
}
function cercaDeParadero(lat: number, lng: number, lista: Parada[]): boolean {
  for (const p of lista) {
    if (p.lat == null || p.lng == null) continue;
    if (distanciaMetros(lat, lng, Number(p.lat), Number(p.lng)) < UMBRAL_PARADERO_M) return true;
  }
  return false;
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
  const [cuentaRegresiva, setCuentaRegresiva]           = useState(AUTO_FINALIZAR_MS / 1000);
  const [holdProgress, setHoldProgress]                 = useState(0); // 0-100 para la barra de pulsación larga

  // ── Estado mapa ──────────────────────────────────────────────────────────────
  const [mapaAbierto, setMapaAbierto]       = useState(false);
  const [mapboxListo, setMapboxListo]       = useState(false);
  const [mapListo, setMapListo]             = useState(false);
  const [mapDescentrado, setMapDescentrado] = useState(false);
  const [ubicacion, setUbicacion]           = useState<{ lat: number; lng: number } | null>(null);
  const [etaMin, setEtaMin]                 = useState<number | null>(null);
  const [etaKm, setEtaKm]                  = useState<number | null>(null);

  // ── Permiso de ubicación (web nativo del navegador) ──────────────────────────
  const [errorGps, setErrorGps]                   = useState(false);   // GPS denegado/bloqueado por el navegador
  const [gpsCongelado, setGpsCongelado]           = useState(false);   // watchPosition dejó de dar fixes nuevos (pantalla bloqueada / 2º plano / sin alta precisión)
  const [gpsDebilM, setGpsDebilM]                 = useState(0);       // mediana ±m de los últimos fixes ≥60 m = ubicación por red (sin satélite): reubicar el teléfono
  const [gpsPegadoMin, setGpsPegadoMin]           = useState(0);       // min con la POSICIÓN byte-idéntica y fixes frescos = motor de ubicación del equipo colgado (variante #951; se destraba con toggle de Ubicación o reinicio)

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

  // ── Refs pulsación larga FINALIZAR ───────────────────────────────────────────
  const holdTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const HOLD_MS         = 3000;

  // ── Refs orientación ─────────────────────────────────────────────────────────
  const speedRef        = useRef<number>(0);           // velocidad actual m/s
  const rumboSuavRef    = useRef<number>(0);           // rumbo suavizado acumulado (no 0-360 bounded)
  const rumboRef        = useRef<number>(0);           // último rumbo para la brújula CSS

  // ── Throttle adaptativo de envío (mismo criterio que la app del conductor) ────
  const lastSentRef     = useRef<number>(0);           // ts del último envío
  const lastSentPosRef  = useRef<{ lat: number; lng: number } | null>(null);
  const fixesVelRef     = useRef<{ lat: number; lng: number; acc: number; ts: number }[]>([]); // ring → velocidad DERIVADA para la cadencia (equipos sin Doppler)
  const precisionRef    = useRef<number>(0);           // accuracy (m) del último fix
  const ultimoFixRef    = useRef<number>(0);           // ms del último fix RECIBIDO de watchPosition (watchdog anti-congelado)
  const accsRecRef      = useRef<number[]>([]);        // accuracy (m) de los últimos fixes RECIBIDOS (detector de GPS débil)
  const posPrevStrRef   = useRef<string>("");          // "lat,lng" del último fix (detector de posición clavada)
  const ultimoCambioPosRef = useRef<number>(0);        // ms de la última vez que la POSICIÓN cambió (variante motor colgado)

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
  const enviarUbicacion = useCallback(async (pos: { lat: number; lng: number }, accuracy?: number) => {
    const acc = accuracy ?? precisionRef.current ?? 0;
    if (acc > 1500) return;                                   // basura de torre celular
    const vel = Math.round(speedRef.current * 3.6);
    const ahora = Date.now();
    // Velocidad EFECTIVA para la CADENCIA: equipos sin Doppler reportan speed=0 SIEMPRE → el
    // throttle creía "detenido" (25 s) con el bus en marcha → puntos a ~100-130 m = zigzag
    // insuavizable (#871). Derivada del desplazamiento (ventana ≥8 s, ring ≤60 s) restando el
    // piso de ruido (suma de precisiones): parado con jitter NO cuenta como marcha. Solo afecta
    // el ritmo de envío; el campo `velocidad` guardado no cambia.
    const ring = fixesVelRef.current;
    // Submuestrear a ≥4 s por entrada: watchPosition emite ~1 fix/s + backstop 4 s; sin esto
    // las 12 entradas cubrían ~9 s y el ruido tapaba la marcha lenta (o la ventana nunca
    // llegaba a 8 s). Con ≥4 s por entrada, 12 entradas = ventana de 44-60 s.
    const lastR = ring[ring.length - 1];
    if (!lastR || ahora - lastR.ts >= 4000) ring.push({ lat: pos.lat, lng: pos.lng, acc: acc || 25, ts: ahora });
    while (ring.length > 12 || (ring.length && ahora - ring[0].ts > 60_000)) ring.shift();
    let velCad = vel;
    if (ring.length >= 2) {
      const viejo = ring[0];
      const dtV = (ahora - viejo.ts) / 1000;
      if (dtV >= 8) {
        const disp = distanciaMetros(pos.lat, pos.lng, viejo.lat, viejo.lng);
        const ruido = Math.min(150, (acc || 25) + viejo.acc);
        if (disp > ruido) {
          const kmhD = Math.round((disp / dtV) * 3.6);
          if (kmhD <= 130) velCad = Math.max(velCad, kmhD);
        }
      }
    }
    // Throttle ADAPTATIVO: el intervalo objetivo depende de la marcha; además, si saltó
    // > 60 m desde el último envío, refrescar YA. Piso anti-spam de 2.5 s (protege el API).
    const objetivo = intervaloEnvioMs(velCad, cercaDeParadero(pos.lat, pos.lng, paradasRef.current));
    const dt = ahora - lastSentRef.current;
    const distMov = lastSentPosRef.current
      ? distanciaMetros(pos.lat, pos.lng, lastSentPosRef.current.lat, lastSentPosRef.current.lng)
      : Infinity;
    if (dt < 2500) return;
    if (dt < objetivo && distMov < 40) return;   // antes 60 m → más puntos en marcha lenta
    lastSentRef.current = ahora;
    lastSentPosRef.current = { lat: pos.lat, lng: pos.lng };
    try {
      await fetch("/api/conductor-tercero/ubicacion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // fixTs = hora del último fix REAL (ultimoFixRef solo se setea en el callback, no en el
        // backstop) → no avanza al re-enviar el mismo punto, así el lector detecta "congelado".
        body: JSON.stringify({ token, lat: pos.lat, lng: pos.lng, velocidad: vel, rumbo: Math.round(rumboRef.current), precision: Math.round(acc), fixTs: ultimoFixRef.current ? new Date(ultimoFixRef.current).toISOString() : null }),
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
    setMostrarConfirmFinal(false);
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

  // ── Pulsación larga 3 s para FINALIZAR SERVICIO ───────────────────────────────
  const cancelarHold = useCallback(() => {
    if (holdTimerRef.current)    { clearTimeout(holdTimerRef.current);   holdTimerRef.current = null; }
    if (holdIntervalRef.current) { clearInterval(holdIntervalRef.current); holdIntervalRef.current = null; }
    setHoldProgress(0);
  }, []);

  const iniciarHold = useCallback(() => {
    cancelarHold();
    const inicio = Date.now();
    holdIntervalRef.current = setInterval(() => {
      const pct = Math.min(((Date.now() - inicio) / HOLD_MS) * 100, 100);
      setHoldProgress(pct);
    }, 40);
    holdTimerRef.current = setTimeout(() => {
      cancelarHold();
      ejecutarFinalizar();
    }, HOLD_MS);
  }, [cancelarHold, ejecutarFinalizar]);

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
    ultimoFixRef.current = Date.now(); // periodo de gracia: el watch recién armado no se juzga "congelado"
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, heading: h, speed: s, accuracy: acc } = pos.coords;
        ultimoFixRef.current = Date.now();   // fix fresco recibido → el watchdog no marca congelado
        setGpsCongelado(false);
        if (Number.isFinite(acc as number)) { accsRecRef.current.push(acc as number); if (accsRecRef.current.length > 20) accsRecRef.current.shift(); }
        // Cambio de POSICIÓN (byte a byte): un GPS sano SIEMPRE jitterea; si el motor del equipo
        // se cuelga sirve la MISMA posición con timestamps frescos (variante #951) → esto no avanza.
        const posStr = `${lat},${lng}`;
        if (posStr !== posPrevStrRef.current) { posPrevStrRef.current = posStr; ultimoCambioPosRef.current = Date.now(); setGpsPegadoMin(0); }
        posActualRef.current = { lat, lng };
        speedRef.current = s ?? 0;
        precisionRef.current = acc ?? 0;
        setUbicacion({ lat, lng });

        // Heading desde GPS solo cuando hay velocidad real (>~3 km/h)
        if (h != null && !isNaN(h) && s != null && s >= VELOCIDAD_MIN_GPS_M_S) {
          // Suavizado para evitar saltos bruscos
          const suavizado = suavizarAngulo(rumboSuavRef.current, h);
          rumboSuavRef.current = suavizado;
          setRumbo(Math.round(suavizado));
        }
        verificarGeofence(lat, lng);
        // Enviar en cada fix; el throttle adaptativo de enviarUbicacion decide el ritmo
        // real (~3-5 s en marcha, 25 s detenido) → huella densa como la app nativa.
        enviarUbicacion({ lat, lng }, acc ?? 0);
      },
      (err) => { console.warn("[GPS]", err.message); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 } // maximumAge:0 → exige fix FRESCO (no posición cacheada que finge movimiento)
    );
    // Backstop: si watchPosition deja de emitir (detenido), reintenta seguido; el
    // throttle adaptativo de enviarUbicacion gobierna el ritmo real (no fuerza cada 4 s).
    intervaloUbicacionRef.current = setInterval(() => {
      if (posActualRef.current) enviarUbicacion(posActualRef.current, precisionRef.current);
    }, 4000);
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

  // ── 1b. Disparar el prompt NATIVO del navegador al ENTRAR (como BCP / Google Maps) ─
  // Al abrir el enlace se pide la ubicación de inmediato; el navegador muestra su
  // diálogo nativo sin pasos manuales. Si el conductor concede, al tocar INICIAR
  // ya no hay fricción.
  useEffect(() => {
    if (cargando || fase !== "inicio") return;
    void pedirPermisoUbicacion().then((p) => {
      if (p === "granted") { setErrorGps(false); return; }
      // Pre-calienta el permiso → fuerza el diálogo nativo del navegador.
      obtenerUbicacion({ enableHighAccuracy: true, timeout: 10000 })
        .then(() => setErrorGps(false))
        .catch((e: any) => { if (e?.code === 1) setErrorGps(true); });
    });
  }, [cargando, fase]);

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

  // ── 3b. Watchdog anti-CONGELADO del GPS ──────────────────────────────────────
  // En el LINK WEB, watchPosition se SUSPENDE cuando la pantalla se bloquea o el chofer
  // pasa a otra app (Waze), y el backstop sigue re-enviando la ÚLTIMA posición → el bus se
  // ve "pegado" en el mapa aunque avance. (El rastreo de fondo real solo lo da la APP nativa.)
  // Aquí, con la pantalla VISIBLE: si no llega un fix nuevo en 60 s, re-armamos watchPosition
  // (fuerza un fix fresco) y marcamos `gpsCongelado` para avisar al chofer. Al llegar un fix,
  // el callback limpia la marca. No corre en 2º plano (el timer está suspendido igual). 60 s
  // (no 45) evita falsos positivos en un semáforo largo; un congelado real es indefinido.
  useEffect(() => {
    if (fase !== "en_ruta") return;
    const STALE_MS = 60_000;
    const iv = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const viejo = Date.now() - (ultimoFixRef.current || 0) > STALE_MS;
      setGpsCongelado(viejo);
      if (viejo) { detenerGPS(); iniciarGPS(); solicitarWakeLock(); } // re-armar: pide un fix fresco
      // GPS DÉBIL medido: mediana de los últimos fixes ≥60 m = red, sin satélite (permiso OK no
      // basta: el teléfono debe VER el cielo). El chofer puede corregirlo al momento.
      const a = [...accsRecRef.current].sort((x, y) => x - y);
      const accMed = a.length >= 5 ? a[Math.floor(a.length / 2)] : 0;
      setGpsDebilM(accMed >= 60 ? Math.round(accMed) : 0);
      // GPS PEGADO (motor del equipo colgado): fixes FRESCOS pero posición byte-idéntica ≥8 min
      // con precisión de red. Un chip sano jitterea siempre → no dispara parado con buen GPS.
      const clavadoMs = ultimoCambioPosRef.current > 0 && !viejo ? Date.now() - ultimoCambioPosRef.current : 0;
      setGpsPegadoMin(clavadoMs > 480_000 && accMed >= 60 ? Math.floor(clavadoMs / 60000) : 0);
    }, 15_000);
    return () => clearInterval(iv);
  }, [fase, detenerGPS, iniciarGPS, solicitarWakeLock]);

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
      const posInicial = await obtenerUbicacion({ enableHighAccuracy: true, timeout: 10000 });
      setErrorGps(false);
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
    } catch (e: any) {
      // Denegación de ubicación → mostramos recuperación in-situ (no pantalla muerta).
      if (e?.code === 1 /* PERMISSION_DENIED */) { setErrorGps(true); }
      else if (e?.code === 2 || e?.code === 3) { setErrorGps(true); } // sin señal / timeout: reintentable
      else { setErrorMsg("Error de red. Verifica tu conexión."); }
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
        {errorGps && (
          <div className="mb-4 rounded-2xl p-4 text-left" style={{ background: "rgba(255,255,255,.12)", border: "1px solid rgba(240,192,64,.4)" }}>
            <p className="text-sm font-bold mb-2" style={{ color: C.dorado }}>📍 Activa tu ubicación</p>
            <p className="text-xs leading-relaxed mb-3" style={{ color: "rgba(255,255,255,.8)" }}>
              Tu navegador bloqueó la ubicación. Toca el ícono 🔒 (o ⓘ) junto a la
              dirección web → <strong>Permisos</strong> → <strong>Ubicación</strong> →
              <strong> Permitir</strong>, y luego toca Reintentar. Verifica también que el
              GPS del teléfono esté encendido.
            </p>
            <button
              onClick={() => {
                setErrorGps(false);
                void obtenerUbicacion({ enableHighAccuracy: true, timeout: 10000 })
                  .then(() => setErrorGps(false))
                  .catch((e: any) => { if (e?.code === 1) setErrorGps(true); });
              }}
              className="w-full py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all"
              style={{ background: "rgba(255,255,255,.2)", color: C.blanco }}>
              Reintentar activar ubicación
            </button>
          </div>
        )}
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

      {/* Aviso GPS congelado: la posición dejó de actualizarse (pantalla bloqueada / 2º plano / sin alta precisión) */}
      {gpsCongelado && (
        <div className="px-4 pt-3 flex-shrink-0">
          <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={{ background: "#FEF3C7", border: "1px solid #F59E0B" }}>
            <span className="text-lg leading-none flex-shrink-0">⚠️</span>
            <div className="min-w-0">
              <p className="text-sm font-bold" style={{ color: "#92400E" }}>GPS detenido — el bus se ve pegado</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400E" }}>
                Mantén ESTA pantalla abierta y encendida, y activa la ubicación en <strong>Alta precisión</strong>. No bloquees el teléfono ni cambies de app durante el viaje.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Aviso GPS PEGADO: el motor de ubicación del equipo está colgado (posición idéntica con
          fixes frescos) — la central ve al bus detenido aunque esté en ruta. Toggle o reinicio. */}
      {!gpsCongelado && gpsPegadoMin > 0 && (
        <div className="px-4 pt-3 flex-shrink-0">
          <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={{ background: "#FEE2E2", border: "1.5px solid #DC2626" }}>
            <span className="text-lg leading-none flex-shrink-0">🛑</span>
            <div className="min-w-0">
              <p className="text-sm font-bold" style={{ color: "#991B1B" }}>GPS pegado: tu ubicación no cambia hace {gpsPegadoMin} min</p>
              <p className="text-xs mt-0.5" style={{ color: "#991B1B" }}>
                La central te ve <strong>detenido</strong> aunque estés en ruta. <strong>1)</strong> Apaga y
                enciende la <strong>Ubicación</strong> del teléfono. <strong>2)</strong> Si en 2-3 min sigue
                igual, <strong>reinicia el celular</strong>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Aviso GPS DÉBIL: el equipo entrega ±60m+ (red, sin satélite) — accionable por el chofer */}
      {!gpsCongelado && gpsPegadoMin === 0 && gpsDebilM > 0 && (
        <div className="px-4 pt-3 flex-shrink-0">
          <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={{ background: "#FEF3C7", border: "1px solid #F59E0B" }}>
            <span className="text-lg leading-none flex-shrink-0">📡</span>
            <div className="min-w-0">
              <p className="text-sm font-bold" style={{ color: "#92400E" }}>GPS débil: tu ubicación sale a ±{gpsDebilM} m</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400E" }}>
                Pon el teléfono <strong>con vista al cielo</strong> (soporte en parabrisas o ventana, no guantera) y desactiva el <strong>ahorro de batería</strong>. La empresa ve tu recorrido impreciso.
              </p>
            </div>
          </div>
        </div>
      )}

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
                <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse" style={{ background: gpsCongelado ? "#F59E0B" : C.verde }} />
                <span className="text-xs truncate" style={{ color: gpsCongelado ? "#92400E" : C.grisMedio }}>
                  {gpsCongelado ? "GPS detenido — mantén la pantalla abierta" : "GPS activo — avanza automáticamente"}
                </span>
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

      {/* Botón FINALIZAR — pulsación larga 3 s */}
      <div className="px-4 pb-8 pt-2 flex-shrink-0">
        <button
          onPointerDown={iniciarHold}
          onPointerUp={cancelarHold}
          onPointerLeave={cancelarHold}
          onContextMenu={e => e.preventDefault()}
          className="w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2 relative overflow-hidden select-none"
          style={{ background: holdProgress > 0 ? C.rojo : C.rojo, color: C.blanco, fontSize: "0.95rem", touchAction: "none" }}
        >
          {/* Barra de progreso que se llena de izquierda a derecha */}
          <div
            className="absolute inset-0 rounded-2xl pointer-events-none"
            style={{
              width: `${holdProgress}%`,
              background: "rgba(255,255,255,0.22)",
              transition: holdProgress === 0 ? "none" : "width 0.04s linear",
            }}
          />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" style={{ position: "relative", zIndex: 1 }}>
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          <span style={{ position: "relative", zIndex: 1 }}>
            {holdProgress > 0
              ? `Suelta para cancelar… ${Math.ceil(((100 - holdProgress) / 100) * HOLD_MS / 1000)}s`
              : "FINALIZAR SERVICIO"}
          </span>
        </button>
        {holdProgress === 0 && (
          <p className="text-center text-xs mt-2" style={{ color: C.grisMedio }}>
            Mantén presionado 3 segundos para finalizar
          </p>
        )}
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

    </div>
  );
}
