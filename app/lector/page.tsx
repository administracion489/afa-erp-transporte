"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Estado =
  | "loading"
  | "selector"
  | "espera"
  | "autorizado"
  | "ya_registrado"
  | "no_autorizado"
  | "otra_empresa";

type GpsEstado = "buscando" | "ok" | "sin_gps";

type PaxInfo    = { id: number; nombre: string; empresa: string | null; qr_code: string | null; };
type PaxParada  = { pasajero_id: number; parada_id: number; estado: string; pasajero: PaxInfo; };
type VehiculoItem = { id: number; placa: string; categoria: string | null; };
type ReservaItem  = {
  id: number; origen: string; destino: string;
  hora_servicio: string | null;
  vehiculo_id: number | null;
  vehiculo: { id: number; placa: string; categoria: string | null } | null;
};
type ParadaItem = {
  id: number; nombre: string; orden: number;
  hora_estimada: string | null;
  lat: number | null; lng: number | null;
  estado: string;
};

// ─── AUDIO (AudioContext nativo) ──────────────────────────────────────────────
// El AudioContext se inicializa al primer tap del usuario (requisito del navegador).
// • Autorizado   → 880 Hz, 0.15 s, fade-out suave     (ding agradable)
// • No autorizado→ 200 Hz, 0.15 s × 2 pulsos          (buzz-buzz de alerta)
// • Ya embarcado → SIN sonido, solo visual

function tonoCtx(
  ctx: AudioContext,
  freq: number,
  dur: number,
  vol: number,
  startDelay = 0,
) {
  try {
    const t = ctx.currentTime + startDelay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.01);
  } catch {}
}

function soundOk(ctx: AudioContext)  { tonoCtx(ctx, 880, 0.15, 0.4); }
function soundErr(ctx: AudioContext) {
  tonoCtx(ctx, 200, 0.15, 0.45, 0.00);  // pulso 1
  tonoCtx(ctx, 200, 0.15, 0.45, 0.22);  // pulso 2
}
// Ya embarcado → sin función de sonido (silencio intencional)

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getFechaLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toR = (d: number) => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

const F = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif";

// ─── LECTOR CONTENT ──────────────────────────────────────────────────────────

function LectorContent() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const reservaParam = searchParams.get("reserva");

  // ── STATE ─────────────────────────────────────────────────────────────────
  const [estado,        setEstado]        = useState<Estado>("loading");
  const [reservaInfo,   setReservaInfo]   = useState<ReservaItem | null>(null);
  const [todasParadas,  setTodasParadas]  = useState<ParadaItem[]>([]);
  const [paradaActual,  setParadaActual]  = useState<ParadaItem | null>(null);
  const [pasajeros,     setPasajeros]     = useState<PaxParada[]>([]);
  const [embarcados,    setEmbarcados]    = useState(0);
  const [resultPax,     setResultPax]     = useState<PaxInfo | null>(null);
  const [msgCambio,     setMsgCambio]     = useState("");

  // GPS
  const [gpsEstado,  setGpsEstado]  = useState<GpsEstado>("buscando");
  const [distParada, setDistParada] = useState<number | null>(null);

  // Selector — paso 1: placa / paso 2: servicio
  const [vehiculos,     setVehiculos]     = useState<VehiculoItem[]>([]);
  const [reservas,      setReservas]      = useState<ReservaItem[]>([]);
  const [vehiculoSelId, setVehiculoSelId] = useState<number | null>(null);
  const [reservaSelId,  setReservaSelId]  = useState<number | null>(null);

  // Audio
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const [audioListo, setAudioListo]  = useState(false);

  // ── REFS ──────────────────────────────────────────────────────────────────
  const scannerRef        = useRef<any>(null);
  const processingRef     = useRef(false);
  const wakeLockRef       = useRef<any>(null);
  const gpsWatchRef       = useRef<number | null>(null);
  const lastGpsReportRef  = useRef<number>(0);
  const paradaRef         = useRef<ParadaItem | null>(null);
  const todasParadasRef   = useRef<ParadaItem[]>([]);
  const reservaRef        = useRef<ReservaItem | null>(null);
  const pasajerosRef      = useRef<PaxParada[]>([]);
  const cambiarParadaRef  = useRef<((p: ParadaItem) => void) | null>(null);

  useEffect(() => { paradaRef.current      = paradaActual;  }, [paradaActual]);
  useEffect(() => { todasParadasRef.current = todasParadas; }, [todasParadas]);
  useEffect(() => { reservaRef.current     = reservaInfo;   }, [reservaInfo]);
  useEffect(() => { pasajerosRef.current   = pasajeros;     }, [pasajeros]);

  // ── AUDIO: inicializar en el primer tap del usuario ───────────────────────
  useEffect(() => {
    const init = () => {
      if (audioCtxRef.current) return;
      try {
        audioCtxRef.current = new (
          (window as any).AudioContext || (window as any).webkitAudioContext
        )();
        setAudioListo(true);
      } catch {}
    };
    // Cualquier interacción del usuario inicializa el contexto
    document.addEventListener("touchstart", init, { once: true, passive: true });
    document.addEventListener("click",      init, { once: true });
    return () => {
      document.removeEventListener("touchstart", init);
      document.removeEventListener("click",      init);
    };
  }, []);

  // ── WAKE LOCK ─────────────────────────────────────────────────────────────
  const acquireWL = useCallback(async () => {
    try {
      if ("wakeLock" in navigator)
        wakeLockRef.current = await (navigator as any).wakeLock.request("screen");
    } catch {}
  }, []);

  useEffect(() => {
    acquireWL();
    const onVisible = () => { if (document.visibilityState === "visible") acquireWL(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => {});
    };
  }, [acquireWL]);

  // ── INIT ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (reservaParam) {
      loadRuta(Number(reservaParam));
    } else {
      loadReservas();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservaParam]);

  // Carga servicios del día → extrae placas únicas
  async function loadReservas() {
    const { data } = await supabase
      .from("reservas")
      .select("id, origen, destino, hora_servicio, vehiculo_id, vehiculo:vehiculos(id, placa, categoria)")
      .eq("fecha_servicio", getFechaLocal())
      .not("vehiculo_id", "is", null)
      .order("hora_servicio");

    const lista: ReservaItem[] = (data as any) || [];
    setReservas(lista);

    // Placas únicas, ordenadas alfabéticamente
    const seen = new Set<number>();
    const vList: VehiculoItem[] = [];
    for (const r of lista) {
      if (r.vehiculo_id && !seen.has(r.vehiculo_id)) {
        seen.add(r.vehiculo_id);
        vList.push({
          id:       r.vehiculo_id,
          placa:    (r.vehiculo as any)?.placa    ?? "—",
          categoria:(r.vehiculo as any)?.categoria ?? null,
        });
      }
    }
    vList.sort((a, b) => a.placa.localeCompare(b.placa));
    setVehiculos(vList);
    setEstado("selector");
  }

  async function loadRuta(reservaId: number) {
    setEstado("loading");
    const [{ data: res }, { data: pars }] = await Promise.all([
      supabase
        .from("reservas")
        .select("id, origen, destino, hora_servicio, vehiculo_id, vehiculo:vehiculos(id, placa, categoria)")
        .eq("id", reservaId)
        .single(),
      supabase
        .from("paradas")
        .select("id, nombre, orden, hora_estimada, lat, lng, estado")
        .eq("reserva_id", reservaId)
        .order("orden"),
    ]);

    if (res) setReservaInfo(res as any);
    const paradas: ParadaItem[] = (pars as any) || [];
    setTodasParadas(paradas);

    // Primera parada no completada; si todas están completas → última parada
    const primera = paradas.find(p => p.estado !== "completada")
      ?? paradas[paradas.length - 1]
      ?? null;
    setParadaActual(primera);
    if (primera) await loadPasajeros(primera.id);
    setEstado("espera");
  }

  /** Re-sincroniza el estado de todas las paradas desde Supabase y recalcula cuál es la activa */
  const sincronizar = useCallback(async () => {
    const res = reservaRef.current;
    if (!res?.id) return;
    setMsgCambio("Sincronizando…");
    const { data } = await supabase
      .from("paradas")
      .select("id, nombre, orden, hora_estimada, lat, lng, estado")
      .eq("reserva_id", res.id)
      .order("orden");
    const paradas: ParadaItem[] = (data as any) || [];
    setTodasParadas(paradas);

    const primera = paradas.find(p => p.estado !== "completada")
      ?? paradas[paradas.length - 1]
      ?? null;

    if (primera && primera.id !== paradaRef.current?.id) {
      setParadaActual(primera);
      await loadPasajeros(primera.id);
    } else if (primera) {
      // Misma parada, actualizar conteo
      await loadPasajeros(primera.id);
    }
    setMsgCambio(primera?.estado !== "completada"
      ? `Parada activa: ${primera?.nombre}`
      : "✓ Recorrido finalizado");
    setTimeout(() => setMsgCambio(""), 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPasajeros(paradaId: number) {
    const { data } = await supabase
      .from("pasajeros_parada")
      .select("pasajero_id, parada_id, estado, pasajero:pasajeros(id, nombre, empresa, qr_code)")
      .eq("parada_id", paradaId);
    const lista: PaxParada[] = (data as any) || [];
    setPasajeros(lista);
    setEmbarcados(lista.filter(p => p.estado === "embarcado").length);
  }

  // ── CAMBIAR PARADA ────────────────────────────────────────────────────────
  const cambiarParada = useCallback(async (nueva: ParadaItem) => {
    if (nueva.id === paradaRef.current?.id) return;
    setParadaActual(nueva);
    setResultPax(null);
    await loadPasajeros(nueva.id);
    setMsgCambio(`Parada actualizada: ${nueva.nombre}`);
    setTimeout(() => setMsgCambio(""), 3500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { cambiarParadaRef.current = cambiarParada; }, [cambiarParada]);

  // ── GPS: reporte + detección de parada ───────────────────────────────────
  const reportarGPS = useCallback(async (lat: number, lng: number, speed: number) => {
    const vid = reservaRef.current?.vehiculo_id;
    if (!vid) return;
    const now = Date.now();
    if (now - lastGpsReportRef.current < 15000) return;
    lastGpsReportRef.current = now;
    supabase.from("ubicaciones_gps").insert({
      vehiculo_id: vid,
      lat, lng,
      velocidad:  Math.round((speed || 0) * 3.6),
      estado:     "en_camino",
      timestamp:  new Date().toISOString(),
    }).then(() => {}).catch(() => {});
  }, []);

  const autoDetectarParada = useCallback((pos: { lat: number; lng: number }) => {
    const todas = todasParadasRef.current;
    if (!todas.length) return;
    const pendientes = todas
      .filter(p => p.estado !== "completada" && p.lat != null && p.lng != null)
      .map(p => ({ p, d: haversineM(pos.lat, pos.lng, p.lat!, p.lng!) }))
      .sort((a, b) => a.d - b.d);
    if (!pendientes.length) return;
    const { p: nearest, d } = pendientes[0];
    setDistParada(Math.round(d));
    if (d <= 400 || !paradaRef.current) cambiarParadaRef.current?.(nearest);
  }, []);

  useEffect(() => {
    if (estado !== "espera") {
      if (gpsWatchRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatchRef.current);
        gpsWatchRef.current = null;
      }
      return;
    }
    if (!navigator.geolocation) { setGpsEstado("sin_gps"); return; }
    const wid = navigator.geolocation.watchPosition(
      pos => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGpsEstado("ok");
        reportarGPS(coords.lat, coords.lng, pos.coords.speed ?? 0);
        autoDetectarParada(coords);
      },
      () => setGpsEstado("sin_gps"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    gpsWatchRef.current = wid;
    return () => { navigator.geolocation.clearWatch(wid); gpsWatchRef.current = null; };
  }, [estado, reportarGPS, autoDetectarParada]);

  // ── REALTIME paradas ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!reservaInfo?.id) return;
    const ch = supabase
      .channel(`lector-paradas-${reservaInfo.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "paradas",
          filter: `reserva_id=eq.${reservaInfo.id}` },
        (payload: any) => {
          const upd: ParadaItem = payload.new;

          // Construir la lista actualizada con el nuevo estado
          const nuevasTodas = todasParadasRef.current.map(p =>
            p.id === upd.id ? { ...p, estado: upd.estado } : p
          );
          setTodasParadas(nuevasTodas);

          // ── RECALCULAR parada activa en CUALQUIER cambio de estado ─────────
          // (antes solo cambiaba si se completaba la parada actual — bug)
          const primeraIncompleta = nuevasTodas
            .filter(p => p.estado !== "completada")
            .sort((a, b) => a.orden - b.orden)[0];

          if (primeraIncompleta) {
            // Hay paradas pendientes: ir a la primera
            if (primeraIncompleta.id !== paradaRef.current?.id) {
              cambiarParadaRef.current?.(primeraIncompleta);
            }
          } else {
            // Todas completadas: quedarse en la última y mostrar mensaje
            const ultima = nuevasTodas.sort((a, b) => b.orden - a.orden)[0];
            if (ultima && ultima.id !== paradaRef.current?.id) {
              cambiarParadaRef.current?.(ultima);
            }
            setMsgCambio("✓ Recorrido finalizado");
            setTimeout(() => setMsgCambio(""), 5000);
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [reservaInfo]);

  // ── SCANNER ───────────────────────────────────────────────────────────────
  const stopScanner = useCallback(async () => {
    try {
      if (scannerRef.current) {
        await scannerRef.current.stop();
        scannerRef.current.clear?.();
        scannerRef.current = null;
      }
    } catch {}
  }, []);

  const startScanner = useCallback(async () => {
    await stopScanner();
    processingRef.current = false;
    const el = document.getElementById("qr-reader");
    if (!el) return;
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const sc = new Html5Qrcode("qr-reader");
      scannerRef.current = sc;
      await sc.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: { width: 260, height: 260 } },
        (text: string) => {
          if (!processingRef.current) {
            processingRef.current = true;
            handleScan(text);
          }
        },
        () => {}
      );
    } catch (err) { console.warn("Scanner error:", err); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopScanner]);

  useEffect(() => {
    if (estado === "espera") {
      const t = setTimeout(() => startScanner(), 350);
      return () => clearTimeout(t);
    } else stopScanner();
  }, [estado, startScanner, stopScanner]);

  useEffect(() => () => { stopScanner(); }, [stopScanner]);

  // ── SCAN HANDLER ──────────────────────────────────────────────────────────
  async function handleScan(qrText: string) {
    const ctx = audioCtxRef.current;
    const par = paradaRef.current;
    const res = reservaRef.current;

    if (!par?.id || !res?.id) {
      if (ctx) soundErr(ctx);
      setResultPax(null);
      setEstado("no_autorizado");
      setTimeout(() => setEstado("espera"), 1500);
      return;
    }

    // Misma lógica autoritativa que la app del conductor (regla "un asiento por horario
    // de salida"): resuelve el QR, mueve/registra/consolida y escribe boarding_log en el
    // servidor. /api/conductor usa service_role, igual que el resto del flujo del conductor.
    let resp: any = {};
    try {
      const r = await fetch("/api/conductor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "embarcar_qr", qrCode: qrText, paradaId: par.id, reservaId: res.id }),
      });
      resp = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resp?.error || "error");
    } catch {
      if (ctx) soundErr(ctx);
      setResultPax(null);
      setEstado("no_autorizado");
      setTimeout(() => setEstado("espera"), 1500);
      return;
    }

    // QR no reconocido
    if (resp?.noEncontrado || !resp?.ok) {
      if (ctx) soundErr(ctx);                // 200 Hz × 2 pulsos
      setResultPax(null);
      setEstado("no_autorizado");
      setTimeout(() => setEstado("espera"), 1500);
      return;
    }

    // Ya estaba embarcado en esta parada → solo visual, sin sonido
    if (resp?.yaEmbarcado) {
      setResultPax(resp.pasajero ?? null);
      setEstado("ya_registrado");
      setTimeout(() => setEstado("espera"), 1500);
      return;
    }

    // Pasajero de otra empresa → se registró igual, pero hay que alertar
    if (resp?.empresaAjena) {
      if (ctx) soundErr(ctx);
      setResultPax(resp.pasajero ?? null);
      setEstado("otra_empresa");
      loadPasajeros(par.id);
      setTimeout(() => setEstado("espera"), 2500);
      return;
    }

    // ✅ Autorizado
    if (ctx) soundOk(ctx);                  // 880 Hz, 0.15 s
    setResultPax(resp.pasajero ?? null);
    setEstado("autorizado");
    // Refrescar lista/conteo real de la parada actual (el pax pudo moverse aquí desde otra)
    loadPasajeros(par.id);

    setTimeout(() => setEstado("espera"), 2000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  const rootStyle: React.CSSProperties = {
    position: "fixed", inset: 0, background: "#060F1E",
    fontFamily: F, userSelect: "none", WebkitUserSelect: "none",
  };

  // ── LOADING ───────────────────────────────────────────────────────────────
  if (estado === "loading") return (
    <div style={{ ...rootStyle, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <div style={{ width: 48, height: 48, border: "3px solid rgba(255,255,255,.1)", borderTop: "3px solid #3B82F6", borderRadius: "50%", animation: "spin .9s linear infinite" }} />
      <p style={{ color: "rgba(255,255,255,.45)", fontSize: 15, margin: 0 }}>Iniciando lector…</p>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ── SELECTOR ──────────────────────────────────────────────────────────────
  if (estado === "selector") {
    const serviciosDelBus = reservas.filter(r => r.vehiculo_id === vehiculoSelId);

    return (
      <div style={{ ...rootStyle, overflowY: "auto" }}>
        <div style={{ maxWidth: 500, margin: "0 auto", padding: "52px 24px 56px" }}>

          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <div style={{ width: 72, height: 72, margin: "0 auto 18px", background: "rgba(59,130,246,.15)", border: "1.5px solid rgba(59,130,246,.3)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34 }}>
              📱
            </div>
            <h1 style={{ color: "#fff", fontSize: 26, fontWeight: 800, margin: "0 0 8px", letterSpacing: -0.6 }}>Lector QR</h1>
            <p style={{ color: "rgba(255,255,255,.4)", fontSize: 14, margin: 0 }}>AFA Tours · Selecciona el bus y su ruta</p>
          </div>

          {/* Aviso GPS automático */}
          <div style={{ background: "rgba(34,197,94,.08)", border: "1px solid rgba(34,197,94,.18)", borderRadius: 12, padding: "12px 16px", marginBottom: 32, display: "flex", alignItems: "flex-start", gap: 12 }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>📍</span>
            <div>
              <div style={{ color: "#4ADE80", fontWeight: 700, fontSize: 13 }}>Parada automática por GPS</div>
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                La parada se detecta sola durante el recorrido. Solo selecciona el bus.
              </div>
            </div>
          </div>

          {/* ── PASO 1: PLACA ─────────────────────────────────────────────── */}
          <p style={{ color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 12px" }}>
            Paso 1 · Selecciona el bus
          </p>

          {vehiculos.length === 0 ? (
            <div style={{ padding: "24px", borderRadius: 14, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", color: "rgba(255,255,255,.3)", textAlign: "center", fontSize: 14, marginBottom: 28 }}>
              No hay buses asignados a servicios hoy
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
              {vehiculos.map(v => {
                const sel = vehiculoSelId === v.id;
                return (
                  <button key={v.id}
                    onClick={() => { setVehiculoSelId(v.id); setReservaSelId(null); }}
                    style={{
                      width: "100%", padding: "16px 18px", borderRadius: 14,
                      background: sel ? "rgba(59,130,246,.18)" : "rgba(255,255,255,.05)",
                      border: `1.5px solid ${sel ? "#3B82F6" : "rgba(255,255,255,.09)"}`,
                      color: "#fff", cursor: "pointer", textAlign: "left",
                      display: "flex", alignItems: "center", gap: 16,
                      fontFamily: F, transition: "all .15s",
                    }}>
                    {/* Ícono bus */}
                    <div style={{
                      width: 48, height: 48, borderRadius: 13, flexShrink: 0,
                      background: sel ? "#3B82F6" : "rgba(255,255,255,.1)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 22,
                    }}>🚌</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: 0.5 }}>{v.placa}</div>
                      {v.categoria && (
                        <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12, marginTop: 2, fontWeight: 500 }}>{v.categoria}</div>
                      )}
                    </div>
                    {sel && (
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>✓</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── PASO 2: SERVICIO (solo si hay bus seleccionado) ────────────── */}
          {vehiculoSelId && (
            <>
              <p style={{ color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 12px" }}>
                Paso 2 · Selecciona el servicio
              </p>

              {serviciosDelBus.length === 0 ? (
                <div style={{ padding: "20px", borderRadius: 14, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", color: "rgba(255,255,255,.3)", textAlign: "center", fontSize: 14, marginBottom: 28 }}>
                  Sin servicios asignados hoy para este bus
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
                  {serviciosDelBus.map(r => {
                    const sel = reservaSelId === r.id;
                    return (
                      <button key={r.id} onClick={() => setReservaSelId(r.id)}
                        style={{
                          width: "100%", padding: "15px 18px", borderRadius: 13,
                          background: sel ? "rgba(34,197,94,.15)" : "rgba(255,255,255,.05)",
                          border: `1.5px solid ${sel ? "#22C55E" : "rgba(255,255,255,.09)"}`,
                          color: "#fff", cursor: "pointer", textAlign: "left",
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          fontFamily: F, transition: "all .15s",
                        }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{r.origen} → {r.destino}</div>
                          <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12, marginTop: 3 }}>🕐 {r.hora_servicio || "—"}</div>
                        </div>
                        {sel && (
                          <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#22C55E", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0, marginLeft: 12 }}>✓</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Botón iniciar */}
          <button
            onClick={() => {
              if (!reservaSelId) return;
              // El tap en este botón también inicializa el AudioContext
              if (!audioCtxRef.current) {
                try {
                  audioCtxRef.current = new (
                    (window as any).AudioContext || (window as any).webkitAudioContext
                  )();
                  setAudioListo(true);
                } catch {}
              }
              router.push(`/lector?reserva=${reservaSelId}`);
            }}
            disabled={!reservaSelId}
            style={{
              width: "100%", padding: "18px 0", borderRadius: 16,
              background: reservaSelId
                ? "linear-gradient(135deg,#2563EB,#3B82F6)"
                : "rgba(255,255,255,.07)",
              border: "none",
              color: reservaSelId ? "#fff" : "rgba(255,255,255,.25)",
              fontSize: 16, fontWeight: 800,
              cursor: reservaSelId ? "pointer" : "not-allowed",
              fontFamily: F, transition: "all .2s",
              boxShadow: reservaSelId ? "0 6px 24px rgba(59,130,246,.4)" : "none",
              letterSpacing: -0.3,
            }}>
            Iniciar lector QR →
          </button>

          <p style={{ color: "rgba(255,255,255,.2)", fontSize: 11, textAlign: "center", marginTop: 16 }}>
            La parada se detecta automáticamente por GPS durante el recorrido
          </p>
        </div>
      </div>
    );
  }

  // ── PANTALLA ESCÁNER + OVERLAYS ───────────────────────────────────────────
  const total          = pasajeros.length;
  const overlayVisible = estado === "autorizado" || estado === "ya_registrado" || estado === "no_autorizado" || estado === "otra_empresa";

  const overlayCfg: Record<string, { bg: string; icon: string; titulo: string; sub: string }> = {
    autorizado:    { bg: "#16a34a", icon: "✅", titulo: resultPax?.nombre || "Autorizado",   sub: resultPax?.empresa || "" },
    ya_registrado: { bg: "#1e40af", icon: "⚠️", titulo: "Ya embarcado",                      sub: resultPax?.nombre  || "" },
    no_autorizado: { bg: "#dc2626", icon: "❌", titulo: "No autorizado",                     sub: "Pasajero no encontrado" },
    otra_empresa:  { bg: "#dc2626", icon: "⛔", titulo: "Otra empresa",                       sub: `${resultPax?.empresa || "Pasajero"} — no es de este servicio (registrado)` },
  };
  const oCfg = overlayVisible ? overlayCfg[estado] : null;

  const gpsCfg = {
    ok:       { color: "#4ADE80", label: "GPS activo · reportando", anim: "none" },
    buscando: { color: "#FACC15", label: "Buscando GPS…",           anim: "blink 1.5s ease-in-out infinite" },
    sin_gps:  { color: "#F87171", label: "Sin GPS",                 anim: "none" },
  }[gpsEstado];

  return (
    <div style={rootStyle}>

      {/* ── BARRA SUPERIOR ─────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
        background: "linear-gradient(to bottom, rgba(0,0,0,.92) 0%, transparent 100%)",
        padding: "20px 20px 40px",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Bus + ruta */}
          <div style={{ color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {reservaInfo?.vehiculo?.placa && (
              <span style={{ background: "rgba(59,130,246,.3)", borderRadius: 5, padding: "2px 8px", fontSize: 12, fontWeight: 800, color: "#fff" }}>
                {reservaInfo.vehiculo.placa}
              </span>
            )}
            <span>{reservaInfo?.origen} → {reservaInfo?.destino}</span>
          </div>

          {/* Parada actual */}
          <div style={{ color: "#fff", fontSize: 17, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {paradaActual?.nombre ?? "Detectando parada…"}
          </div>
          {paradaActual?.hora_estimada && (
            <div style={{ color: "rgba(255,255,255,.38)", fontSize: 12, marginTop: 3 }}>
              🕐 {paradaActual.hora_estimada}
              {distParada !== null && gpsEstado === "ok" && (
                <span style={{ marginLeft: 10, color: distParada < 200 ? "#4ADE80" : "rgba(255,255,255,.35)" }}>
                  · {fmtDist(distParada)}
                </span>
              )}
            </div>
          )}

          {/* GPS chip */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 7 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: gpsCfg.color, boxShadow: gpsEstado === "ok" ? `0 0 6px ${gpsCfg.color}` : "none", animation: gpsCfg.anim }} />
            <span style={{ color: gpsCfg.color, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8 }}>{gpsCfg.label}</span>
          </div>

          {/* Audio chip */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5 }}>
            <span style={{ fontSize: 11 }}>{audioListo ? "🔊" : "🔇"}</span>
            <span style={{ color: audioListo ? "rgba(255,255,255,.3)" : "#FACC15", fontSize: 10, fontWeight: 600 }}>
              {audioListo ? "Audio listo" : "Toca la pantalla para activar audio"}
            </span>
          </div>
        </div>

        {/* Contador */}
        <div style={{ background: "rgba(0,0,0,.6)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 14, padding: "10px 16px", textAlign: "center", minWidth: 64, backdropFilter: "blur(10px)", flexShrink: 0 }}>
          <div style={{ color: "#4ADE80", fontSize: 26, fontWeight: 900, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{embarcados}</div>
          <div style={{ color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 600, marginTop: 1 }}>/ {total}</div>
          <div style={{ color: "rgba(255,255,255,.25)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.8, marginTop: 2 }}>a bordo</div>
        </div>
      </div>

      {/* ── NOTIFICACIÓN CAMBIO DE PARADA ─────────────────────────────── */}
      {msgCambio && (
        <div style={{
          position: "absolute", top: 110, left: "50%", transform: "translateX(-50%)",
          background: "rgba(59,130,246,.92)", backdropFilter: "blur(8px)",
          borderRadius: 12, padding: "10px 18px", color: "#fff", fontSize: 13, fontWeight: 700,
          zIndex: 30, whiteSpace: "nowrap", boxShadow: "0 4px 20px rgba(0,0,0,.4)",
          animation: "slideDown .3s ease",
        }}>
          🔄 {msgCambio}
        </div>
      )}

      {/* ── VISOR QR ───────────────────────────────────────────────────── */}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", inset: -20, border: "1px solid rgba(255,255,255,.05)", borderRadius: 28, pointerEvents: "none" }} />
          <div id="qr-reader" style={{ width: 300, height: 300, borderRadius: 18, overflow: "hidden", background: "#111" }} />
          {([
            { top: -5,    left: -5,   borderTop:    "3.5px solid #3B82F6", borderLeft:   "3.5px solid #3B82F6", borderRadius: "8px 0 0 0" },
            { top: -5,    right: -5,  borderTop:    "3.5px solid #3B82F6", borderRight:  "3.5px solid #3B82F6", borderRadius: "0 8px 0 0" },
            { bottom: -5, left: -5,   borderBottom: "3.5px solid #3B82F6", borderLeft:   "3.5px solid #3B82F6", borderRadius: "0 0 0 8px" },
            { bottom: -5, right: -5,  borderBottom: "3.5px solid #3B82F6", borderRight:  "3.5px solid #3B82F6", borderRadius: "0 0 8px 0" },
          ] as React.CSSProperties[]).map((s, i) => (
            <div key={i} style={{ position: "absolute", width: 30, height: 30, ...s }} />
          ))}
        </div>
      </div>

      {/* ── BARRA INFERIOR ─────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 20,
        background: "linear-gradient(to top, rgba(0,0,0,.9) 0%, transparent 100%)",
        padding: "44px 24px 36px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 18,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ADE80", boxShadow: "0 0 10px #4ADE80", animation: "blink 2s ease-in-out infinite" }} />
          <span style={{ color: "rgba(255,255,255,.65)", fontSize: 15, fontWeight: 500 }}>Acerca tu QR al lector</span>
        </div>
        <button onClick={sincronizar} style={{
          background: "rgba(59,130,246,.15)", border: "1px solid rgba(59,130,246,.3)", borderRadius: 10,
          padding: "10px 22px", color: "rgba(147,197,253,.85)", fontSize: 13, fontWeight: 700,
          cursor: "pointer", fontFamily: F,
        }}>
          🔄 Sincronizar parada
        </button>
      </div>

      {/* ── OVERLAY RESULTADO ──────────────────────────────────────────── */}
      {overlayVisible && oCfg && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50, background: oCfg.bg,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          animation: "fadeIn .12s ease",
        }}>
          <div style={{ fontSize: 120, lineHeight: 1, marginBottom: 32, filter: "drop-shadow(0 8px 32px rgba(0,0,0,.3))" }}>
            {oCfg.icon}
          </div>
          <div style={{ color: "#fff", fontSize: 36, fontWeight: 900, textAlign: "center", padding: "0 32px", letterSpacing: -0.8, lineHeight: 1.15 }}>
            {oCfg.titulo}
          </div>
          {oCfg.sub && (
            <div style={{ color: "rgba(255,255,255,.75)", fontSize: 20, marginTop: 14, textAlign: "center", padding: "0 40px", lineHeight: 1.4, fontWeight: 500 }}>
              {oCfg.sub}
            </div>
          )}
          {/* Indicador silencio para ya_registrado */}
          {estado === "ya_registrado" && (
            <div style={{ marginTop: 20, background: "rgba(255,255,255,.12)", borderRadius: 20, padding: "6px 14px", fontSize: 12, color: "rgba(255,255,255,.6)", fontWeight: 600 }}>
              🔇 Sin sonido
            </div>
          )}
        </div>
      )}

      {/* ── CSS ────────────────────────────────────────────────────────── */}
      <style>{`
        @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes fadeIn   { from{opacity:0;transform:scale(.97)} to{opacity:1;transform:scale(1)} }
        @keyframes spin     { to{transform:rotate(360deg)} }
        @keyframes slideDown{ from{opacity:0;transform:translateX(-50%) translateY(-10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }

        #qr-reader video                   { width:300px !important; height:300px !important; object-fit:cover; border-radius:18px; display:block; }
        #qr-reader > img                   { display:none !important; }
        #qr-reader__status_span            { display:none !important; }
        #qr-reader__dashboard              { display:none !important; }
        #qr-reader__scan_region            { border:none !important; box-shadow:none !important; }
        #qr-reader__scan_region img        { display:none !important; }
        #qr-reader__header_message         { display:none !important; }
        #qr-reader__dashboard_section_csr  { display:none !important; }

        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
        body { margin:0; padding:0; overflow:hidden; }
      `}</style>
    </div>
  );
}

// ─── EXPORT CON SUSPENSE ──────────────────────────────────────────────────────

export default function LectorQR() {
  return (
    <Suspense fallback={
      <div style={{ position: "fixed", inset: 0, background: "#060F1E", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F }}>
        <div style={{ width: 44, height: 44, border: "3px solid rgba(255,255,255,.1)", borderTop: "3px solid #3B82F6", borderRadius: "50%", animation: "spin .9s linear infinite" }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    }>
      <LectorContent />
    </Suspense>
  );
}
