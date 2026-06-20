"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Estado =
  | "loading"
  | "login"
  | "selector"
  | "espera"
  | "autorizado"
  | "ya_registrado"
  | "no_autorizado"
  | "otra_empresa";

type Conductor = {
  id: number; nombre: string; dni: string | null;
  _tabla: "conductores" | "conductores_tercero";
};

type PaxInfo    = { id: number; nombre: string; empresa: string | null; qr_code: string | null; };
type PaxParada  = { pasajero_id: number; parada_id: number; estado: string; pasajero: PaxInfo; };
type BusItem = {
  key: string; placa: string; categoria: string | null;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null;
};
type VehiculoRef = { id: number; placa: string; categoria: string | null } | null;
type ReservaItem  = {
  id: number; origen: string; destino: string;
  hora_servicio: string | null; estado: string | null;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  vehiculo: VehiculoRef; vehiculo_tercero: VehiculoRef;
};
type ParadaItem = {
  id: number; nombre: string; orden: number;
  hora_estimada: string | null;
  lat: number | null; lng: number | null;
  estado: string;
};

// Llave de acceso a /api/conductor. La manda la app sola; el servidor la exige solo si
// NEXT_PUBLIC_AFA_CONDUCTOR_KEY está configurada.
const AFA_KEY = process.env.NEXT_PUBLIC_AFA_CONDUCTOR_KEY || "";

// "servicio activo" = la reserva en_curso que el conductor inició en su celular.
const ES_ACTIVO = (e?: string | null) => e === "en_curso";
// "a bordo" = "abordado" (valor canónico de la BD) o "embarcado" (legacy en datos viejos).
const esAbordado = (e?: string | null) => e === "abordado" || e === "embarcado";

// Sesión del lector (independiente del APK conductor). DNI + PIN verificados en el server.
const SK = "afa_lector_v1";
function saveSession(c: Conductor) {
  try { localStorage.setItem(SK, JSON.stringify({ c, exp: Date.now() + 86400000 })); } catch {}
}
function loadSession(): Conductor | null {
  try {
    const r = localStorage.getItem(SK); if (!r) return null;
    const { c, exp } = JSON.parse(r);
    if (Date.now() > exp) { localStorage.removeItem(SK); return null; }
    return c;
  } catch { return null; }
}
function clearSession() { try { localStorage.removeItem(SK); } catch {} }

// Cliente del endpoint service_role (igual patrón que el APK conductor/pasajero).
async function condApi(accion: string, params: Record<string, any> = {}) {
  const res = await fetch("/api/conductor", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-afa-key": AFA_KEY },
    body: JSON.stringify({ accion, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Error de red");
  return json;
}

// Normaliza el bus de una reserva (propio o tercero) a una forma única. Los ids de
// vehiculos y vehiculos_tercero se solapan, por eso la llave lleva prefijo p-/t-.
function busDe(r: ReservaItem | null): BusItem {
  if (r?.vehiculo) return { key: `p-${r.vehiculo.id}`, placa: r.vehiculo.placa, categoria: r.vehiculo.categoria, vehiculo_id: r.vehiculo.id, vehiculo_tercero_id: null };
  if (r?.vehiculo_tercero) return { key: `t-${r.vehiculo_tercero.id}`, placa: r.vehiculo_tercero.placa, categoria: r.vehiculo_tercero.categoria, vehiculo_id: null, vehiculo_tercero_id: r.vehiculo_tercero.id };
  return { key: "none", placa: "—", categoria: null, vehiculo_id: null, vehiculo_tercero_id: null };
}

// ─── AUDIO (AudioContext nativo) ──────────────────────────────────────────────
// • Autorizado   → 880 Hz, 0.15 s, fade-out suave   (ding agradable)
// • No autorizado→ 200 Hz × 2 pulsos                (buzz-buzz de alerta)
// • Ya embarcado → SIN sonido, solo visual

function tonoCtx(ctx: AudioContext, freq: number, dur: number, vol: number, startDelay = 0) {
  try {
    const t = ctx.currentTime + startDelay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g); o.start(t); o.stop(t + dur + 0.01);
  } catch {}
}
function soundOk(ctx: AudioContext)  { tonoCtx(ctx, 880, 0.15, 0.4); }
function soundErr(ctx: AudioContext) {
  tonoCtx(ctx, 200, 0.15, 0.45, 0.00);
  tonoCtx(ctx, 200, 0.15, 0.45, 0.22);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getFechaLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// ─── ÍCONOS SVG ───────────────────────────────────────────────────────────────

function IC({ ch, sz = 20, c = "currentColor", sw = 1.8, fill = "none" }: { ch: React.ReactNode; sz?: number; c?: string; sw?: number; fill?: string }) {
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill={fill} stroke={c}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>{ch}</svg>
  );
}
const IconBus      = (p: any) => <IC {...p} ch={<><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h20"/><path d="M4 19h2a1 1 0 0 0 1-1v-2h10v2a1 1 0 0 0 1 1h2"/><path d="M4 18V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10"/></>} />;
const IconScan     = (p: any) => <IC {...p} ch={<><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></>} />;
const IconPin      = (p: any) => <IC {...p} ch={<><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></>} />;
const IconClock    = (p: any) => <IC {...p} ch={<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>} />;
const IconCheck    = (p: any) => <IC {...p} ch={<path d="M5 12l5 5L20 6"/>} />;
const IconX        = (p: any) => <IC {...p} ch={<><path d="M6 6l12 12"/><path d="M18 6L6 18"/></>} />;
const IconUser     = (p: any) => <IC {...p} ch={<><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></>} />;
const IconLogout   = (p: any) => <IC {...p} ch={<><path d="M14 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h11"/></>} />;
const IconArrow    = (p: any) => <IC {...p} ch={<><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></>} />;
const IconRefresh  = (p: any) => <IC {...p} ch={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>} />;
const IconAlert    = (p: any) => <IC {...p} ch={<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>} />;
const IconBan      = (p: any) => <IC {...p} ch={<><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></>} />;
const IconBack     = (p: any) => <IC {...p} ch={<path d="M15 18l-6-6 6-6"/>} />;
const IconLink     = (p: any) => <IC {...p} ch={<><path d="M9 12a3 3 0 0 1 3-3h4a3 3 0 0 1 0 6h-1"/><path d="M15 12a3 3 0 0 1-3 3H8a3 3 0 0 1 0-6h1"/></>} />;
const IconForward  = (p: any) => <IC {...p} ch={<><path d="M13 5l7 7-7 7"/><path d="M4 5l7 7-7 7"/></>} />;

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function LectorQR() {
  // ── STATE ─────────────────────────────────────────────────────────────────
  const [estado,        setEstado]        = useState<Estado>("loading");
  const [conductor,     setConductor]     = useState<Conductor | null>(null);

  // Login
  const [dni,          setDni]          = useState("");
  const [pin,          setPin]          = useState("");
  const [loginErr,     setLoginErr]     = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Ruta activa
  const [reservaInfo,   setReservaInfo]   = useState<ReservaItem | null>(null);
  const [todasParadas,  setTodasParadas]  = useState<ParadaItem[]>([]);
  const [paradaActual,  setParadaActual]  = useState<ParadaItem | null>(null);
  const [pasajeros,     setPasajeros]     = useState<PaxParada[]>([]);
  const [embarcados,    setEmbarcados]    = useState(0);
  const [resultPax,     setResultPax]     = useState<PaxInfo | null>(null);
  const [msgCambio,     setMsgCambio]     = useState("");
  // modoManual = el operador inició un servicio que NO está en_curso (respaldo si el
  // celular del conductor está caído). En ese modo la tablet NO auto-cambia de servicio.
  const [modoManual,    setModoManual]    = useState(false);

  // Selector — paso 1: bus / paso 2: servicio
  const [reservas,      setReservas]      = useState<ReservaItem[]>([]);
  const [buses,         setBuses]         = useState<BusItem[]>([]);
  const [busSelKey,     setBusSelKey]     = useState<string | null>(null);
  const [reservaSelId,  setReservaSelId]  = useState<number | null>(null);

  // Audio
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const [audioListo, setAudioListo]  = useState(false);

  // ── REFS ──────────────────────────────────────────────────────────────────
  const scannerRef        = useRef<any>(null);
  const processingRef     = useRef(false);
  const wakeLockRef       = useRef<any>(null);
  const paradaRef         = useRef<ParadaItem | null>(null);
  const todasParadasRef   = useRef<ParadaItem[]>([]);
  const reservaRef        = useRef<ReservaItem | null>(null);
  const conductorRef      = useRef<Conductor | null>(null);
  const estadoRef         = useRef<Estado>("loading");
  const modoManualRef     = useRef(false);
  const cambiarParadaRef  = useRef<((p: ParadaItem) => void) | null>(null);
  const tickRef           = useRef<() => void>(() => {});

  useEffect(() => { paradaRef.current       = paradaActual;  }, [paradaActual]);
  useEffect(() => { todasParadasRef.current = todasParadas;  }, [todasParadas]);
  useEffect(() => { reservaRef.current      = reservaInfo;   }, [reservaInfo]);
  useEffect(() => { conductorRef.current    = conductor;     }, [conductor]);
  useEffect(() => { estadoRef.current       = estado;        }, [estado]);
  useEffect(() => { modoManualRef.current   = modoManual;    }, [modoManual]);

  const flash = useCallback((m: string, ms = 3000) => {
    setMsgCambio(m);
    setTimeout(() => setMsgCambio(prev => (prev === m ? "" : prev)), ms);
  }, []);

  // ── INIT: sesión existente → enganchar servicio activo; si no → login ──────
  useEffect(() => {
    const s = loadSession();
    if (!s) { setEstado("login"); return; }
    setConductor(s);
    (async () => {
      setEstado("loading");
      try {
        const { activo } = await refrescarServicios(s);
        if (activo) { setModoManual(false); await loadRuta(activo.id); }
        else setEstado("selector");
      } catch { setEstado("selector"); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── AUDIO: inicializar en el primer tap del usuario ───────────────────────
  useEffect(() => {
    const init = () => {
      if (audioCtxRef.current) return;
      try {
        audioCtxRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
        setAudioListo(true);
      } catch {}
    };
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

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  async function doLogin() {
    const d = dni.trim();
    if (d.length < 7) { setLoginErr("Ingresa tu DNI"); return; }
    if (pin.length < 4) { setLoginErr("PIN de 4 dígitos"); return; }
    setLoginErr(""); setLoginLoading(true);
    try {
      const r = await condApi("login", { dni: d, pin });
      if (!r.ok) { setLoginErr(r.error || "No se pudo ingresar"); setLoginLoading(false); return; }
      const c: Conductor = { id: r.conductor.id, nombre: r.conductor.nombre, dni: r.conductor.dni, _tabla: r.conductor.tabla };
      saveSession(c); setConductor(c); setPin("");
      setEstado("loading");
      const { activo } = await refrescarServicios(c);
      if (activo) { setModoManual(false); await loadRuta(activo.id); }
      else setEstado("selector");
    } catch (e: any) {
      setLoginErr(e?.message || "Error de red");
    } finally { setLoginLoading(false); }
  }

  function logout() {
    clearSession();
    setConductor(null);
    setReservas([]); setBuses([]); setBusSelKey(null); setReservaSelId(null);
    setReservaInfo(null); setTodasParadas([]); setParadaActual(null); setPasajeros([]);
    setModoManual(false);
    setDni(""); setPin(""); setLoginErr("");
    setEstado("login");
  }

  function volverSelector() {
    stopScanner();
    setReservaInfo(null); setTodasParadas([]); setParadaActual(null); setPasajeros([]);
    setModoManual(false);
    setEstado("selector");
  }

  // ── CARGA: servicios de hoy del conductor (devuelve la lista + el activo) ───
  async function refrescarServicios(c: Conductor): Promise<{ lista: ReservaItem[]; activo: ReservaItem | null }> {
    const { reservas: lista } = await condApi("lector_servicios", { cid: c.id, tabla: c._tabla, hoy: getFechaLocal() });
    const arr: ReservaItem[] = lista || [];
    setReservas(arr);
    const seen = new Set<string>();
    const vList: BusItem[] = [];
    for (const r of arr) {
      const b = busDe(r);
      if (b.key !== "none" && !seen.has(b.key)) { seen.add(b.key); vList.push(b); }
    }
    vList.sort((a, b) => a.placa.localeCompare(b.placa));
    setBuses(vList);
    const activo = arr.find(r => ES_ACTIVO(r.estado)) || null;
    return { lista: arr, activo };
  }

  // ── CARGA: ruta de una reserva (engancha la tablet a ese servicio) ─────────
  async function loadRuta(reservaId: number) {
    setEstado("loading");
    try {
      const { reserva, paradas } = await condApi("lector_ruta", { reservaId });
      if (reserva) setReservaInfo(reserva);
      const ps: ParadaItem[] = paradas || [];
      setTodasParadas(ps);
      const primera = ps.find(p => p.estado !== "completada") ?? ps[ps.length - 1] ?? null;
      setParadaActual(primera);
      if (primera) await loadPasajeros(primera.id);
      setEstado("espera");
    } catch {
      setEstado("selector");
    }
  }

  async function loadPasajeros(paradaId: number) {
    try {
      const { pasajeros: lista } = await condApi("pasajeros", { paradaIds: [paradaId] });
      const arr: PaxParada[] = lista || [];
      setPasajeros(arr);
      setEmbarcados(arr.filter(p => esAbordado(p.estado)).length);
    } catch {}
  }

  // ── Re-sincroniza paradas desde la BD y recalcula la parada activa ─────────
  // Núcleo compartido por el botón "Sincronizar" y el poll de seguimiento.
  const aplicarParadas = useCallback(async (reservaId: number) => {
    const { paradas } = await condApi("lector_ruta", { reservaId });
    const ps: ParadaItem[] = paradas || [];
    setTodasParadas(ps);
    const primera = ps.find(p => p.estado !== "completada") ?? ps[ps.length - 1] ?? null;
    if (primera && primera.id !== paradaRef.current?.id) {
      setParadaActual(primera);
      await loadPasajeros(primera.id);
    } else if (primera) {
      await loadPasajeros(primera.id);
    }
    return primera;
  }, []);

  const sincronizar = useCallback(async () => {
    const res = reservaRef.current;
    if (!res?.id) return;
    setMsgCambio("Sincronizando…");
    try {
      const primera = await aplicarParadas(res.id);
      flash(primera?.estado !== "completada" ? `Parada activa: ${primera?.nombre}` : "Recorrido finalizado");
    } catch { flash("No se pudo sincronizar"); }
  }, [aplicarParadas, flash]);

  // ── Avanzar parada manualmente (respaldo si el celular del conductor falla) ─
  async function siguienteParada() {
    const par = paradaRef.current;
    if (!par?.id) return;
    if (!window.confirm(`¿Marcar "${par.nombre}" como completada y pasar a la siguiente parada?`)) return;
    try {
      await condApi("marcar_parada", { paradaId: par.id });
      flash("Parada completada");
      await sincronizar();
    } catch { flash("No se pudo avanzar la parada"); }
  }

  // ── CAMBIAR PARADA ────────────────────────────────────────────────────────
  const cambiarParada = useCallback(async (nueva: ParadaItem) => {
    if (nueva.id === paradaRef.current?.id) return;
    setParadaActual(nueva);
    setResultPax(null);
    await loadPasajeros(nueva.id);
    flash(`Parada actualizada: ${nueva.nombre}`, 3500);
  }, [flash]);
  useEffect(() => { cambiarParadaRef.current = cambiarParada; }, [cambiarParada]);

  // ── POLL: seguir el servicio activo del conductor (cada 8 s) ───────────────
  // Engancha la tablet al servicio en_curso del celular, sigue su parada/conteo, y
  // suelta cuando el conductor finaliza. El intervalo es estable (solo cuelga del
  // login) y llama siempre al tick más reciente vía tickRef.
  const doTick = useCallback(async () => {
    const c = conductorRef.current; if (!c) return;
    const est = estadoRef.current;
    const activos = ["selector", "espera", "autorizado", "ya_registrado", "no_autorizado", "otra_empresa"];
    if (!activos.includes(est)) return;
    let activo: ReservaItem | null = null;
    try { ({ activo } = await refrescarServicios(c)); } catch { return; }
    const cur = reservaRef.current;
    if (activo) {
      if (!cur || cur.id !== activo.id) {
        // El conductor inició/cambió de servicio en su celular → engancharse.
        setModoManual(false);
        flash("Enganchado al servicio del conductor");
        await loadRuta(activo.id);
      } else {
        setModoManual(false);
        if (est === "espera") { try { await aplicarParadas(activo.id); } catch {} }
      }
    } else if (!modoManualRef.current && cur && est === "espera") {
      // Estábamos siguiendo un servicio que el conductor finalizó.
      flash("El conductor finalizó el servicio");
      volverSelector();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aplicarParadas, flash]);

  useEffect(() => { tickRef.current = doTick; }, [doTick]);
  useEffect(() => {
    if (!conductor) return;
    const id = setInterval(() => tickRef.current?.(), 8000);
    return () => clearInterval(id);
  }, [conductor]);

  // ── REALTIME paradas (sigue al celular al instante; el poll es el respaldo) ─
  useEffect(() => {
    if (!reservaInfo?.id) return;
    const ch = supabase
      .channel(`lector-paradas-${reservaInfo.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "paradas", filter: `reserva_id=eq.${reservaInfo.id}` },
        (payload: any) => {
          const upd: ParadaItem = payload.new;
          const nuevasTodas = todasParadasRef.current.map(p => p.id === upd.id ? { ...p, estado: upd.estado } : p);
          setTodasParadas(nuevasTodas);
          const primeraIncompleta = nuevasTodas.filter(p => p.estado !== "completada").sort((a, b) => a.orden - b.orden)[0];
          if (primeraIncompleta) {
            if (primeraIncompleta.id !== paradaRef.current?.id) cambiarParadaRef.current?.(primeraIncompleta);
          } else {
            const ultima = [...nuevasTodas].sort((a, b) => b.orden - a.orden)[0];
            if (ultima && ultima.id !== paradaRef.current?.id) cambiarParadaRef.current?.(ultima);
            flash("Recorrido finalizado", 5000);
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservaInfo?.id]);

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
        { fps: 12 },  // sin qrbox → detecta en toda la pantalla
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

    const fallarYContinuar = () => {
      if (ctx) soundErr(ctx);
      setResultPax(null);
      setEstado("no_autorizado");
      setTimeout(() => { setEstado("espera"); processingRef.current = false; }, 1500);
    };

    if (!par?.id || !res?.id) { fallarYContinuar(); return; }

    // Misma lógica autoritativa que el APK conductor ("un asiento por horario de salida").
    let resp: any = {};
    try {
      resp = await condApi("embarcar_qr", { qrCode: qrText, paradaId: par.id, reservaId: res.id });
      if (!resp?.ok && !resp?.noEncontrado) throw new Error(resp?.error || "error");
    } catch { fallarYContinuar(); return; }

    if (resp?.noEncontrado || !resp?.ok) { fallarYContinuar(); return; }

    // Ya embarcado en esta parada → solo visual, sin sonido
    if (resp?.yaEmbarcado) {
      setResultPax(resp.pasajero ?? null);
      setEstado("ya_registrado");
      setTimeout(() => { setEstado("espera"); processingRef.current = false; }, 1500);
      return;
    }

    // Pasajero de otra empresa → se registró igual, pero hay que alertar
    if (resp?.empresaAjena) {
      if (ctx) soundErr(ctx);
      setResultPax(resp.pasajero ?? null);
      setEstado("otra_empresa");
      loadPasajeros(par.id);
      setTimeout(() => { setEstado("espera"); processingRef.current = false; }, 2500);
      return;
    }

    // ✅ Autorizado
    if (ctx) soundOk(ctx);
    setResultPax(resp.pasajero ?? null);
    setEstado("autorizado");
    loadPasajeros(par.id);
    setTimeout(() => { setEstado("espera"); processingRef.current = false; }, 2000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ESTILOS BASE
  // ═══════════════════════════════════════════════════════════════════════════

  const GLOBAL_CSS = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap');
      @keyframes lqr-spin     { to{transform:rotate(360deg)} }
      @keyframes lqr-blink    { 0%,100%{opacity:1} 50%{opacity:.3} }
      @keyframes lqr-fadeIn   { from{opacity:0;transform:scale(.97)} to{opacity:1;transform:scale(1)} }
      @keyframes lqr-slideDown{ from{opacity:0;transform:translateX(-50%) translateY(-10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
      @keyframes lqr-scan     { 0%{top:8%} 50%{top:92%} 100%{top:8%} }
      #qr-reader, #qr-reader > div { width:100% !important; height:100% !important; padding:0 !important; border:none !important; }
      #qr-reader video  { position:absolute !important; inset:0 !important; width:100% !important; height:100% !important; object-fit:cover !important; display:block !important; }
      #qr-reader canvas, #qr-reader img, #qr-reader span { display:none !important; }
      * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    `}</style>
  );

  // ── LOADING ───────────────────────────────────────────────────────────────
  if (estado === "loading") return (
    <div style={{ position: "fixed", inset: 0, background: "#FAF8F2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, fontFamily: FONT }}>
      {GLOBAL_CSS}
      <div style={{ width: 42, height: 42, border: "3px solid rgba(11,49,95,.12)", borderTop: "3px solid #0b315f", borderRadius: "50%", animation: "lqr-spin .9s linear infinite" }} />
      <p style={{ color: "#6B7280", fontSize: 14, margin: 0, fontWeight: 600 }}>Cargando…</p>
    </div>
  );

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  if (estado === "login") {
    const puede = dni.trim().length >= 7 && pin.length >= 4 && !loginLoading;
    return (
      <div style={{ position: "fixed", inset: 0, background: "#FAF8F2", overflowY: "auto", fontFamily: FONT }}>
        {GLOBAL_CSS}
        <div style={{ maxWidth: 460, margin: "0 auto", padding: "56px 22px 40px", minHeight: "100%", display: "flex", flexDirection: "column" }}>
          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 34 }}>
            <div style={{ width: 70, height: 70, margin: "0 auto 18px", background: "#0b315f", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 30px -8px rgba(11,49,95,.5)" }}>
              <IconScan sz={34} c="#fff" />
            </div>
            <h1 style={{ color: "#0E1320", fontSize: 25, fontWeight: 800, margin: "0 0 6px", letterSpacing: -0.6 }}>Lector QR</h1>
            <p style={{ color: "#6B7280", fontSize: 14, margin: 0, fontWeight: 500 }}>Ingresa con tu DNI y PIN de conductor</p>
          </div>

          {/* Card */}
          <div style={{ background: "#fff", border: "1px solid #EFEEE6", borderRadius: 22, padding: "22px 20px 24px", boxShadow: "0 4px 16px rgba(0,0,0,.05)" }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", letterSpacing: 1.2, textTransform: "uppercase", margin: 0 }}>Documento de identidad</p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, borderBottom: `1.5px solid ${dni.length >= 7 ? "#0b315f" : "#E7E5DD"}`, paddingBottom: 8 }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 15, color: "#9AA1AC" }}>PE</span>
              <input
                type="tel" inputMode="numeric" maxLength={8} value={dni}
                onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 8); setDni(v); setLoginErr(""); if (v.length === 8) setTimeout(() => pinInputRef.current?.focus(), 80); }}
                placeholder="12345678"
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: MONO, fontWeight: 700, fontSize: 20, color: "#0E1320", letterSpacing: 1, padding: 0 }}
              />
            </div>

            <p style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", letterSpacing: 1.2, textTransform: "uppercase", margin: "22px 0 0" }}>PIN de acceso</p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, borderBottom: `1.5px solid ${pin.length >= 4 ? "#0b315f" : "#E7E5DD"}`, paddingBottom: 8 }}>
              <input
                ref={pinInputRef}
                type="password" inputMode="numeric" maxLength={6} value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setLoginErr(""); }}
                onKeyDown={e => { if (e.key === "Enter") doLogin(); }}
                placeholder="••••"
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: MONO, fontWeight: 700, fontSize: 22, color: "#0E1320", letterSpacing: 6, padding: 0 }}
              />
            </div>

            {loginErr && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18, background: "#FCEBEA", border: "1px solid #FECACA", borderRadius: 12, padding: "11px 14px" }}>
                <IconAlert sz={16} c="#B91C1C" />
                <span style={{ color: "#B91C1C", fontSize: 13, fontWeight: 700 }}>{loginErr}</span>
              </div>
            )}

            <button
              onClick={doLogin} disabled={!puede}
              style={{
                width: "100%", marginTop: 24, padding: "16px 0", borderRadius: 14, border: "none",
                background: puede ? "#0b315f" : "#E7E5DD",
                color: puede ? "#fff" : "#9AA1AC", fontFamily: FONT, fontSize: 16, fontWeight: 800,
                cursor: puede ? "pointer" : "not-allowed", letterSpacing: -0.2,
                boxShadow: puede ? "0 6px 20px -6px rgba(11,49,95,.55)" : "none", transition: "all .15s",
              }}>
              {loginLoading ? "Verificando…" : "Ingresar"}
            </button>
          </div>

          <p style={{ color: "#9AA1AC", fontSize: 12, textAlign: "center", marginTop: 18, lineHeight: 1.6 }}>
            La tablet se engancha sola al servicio que inicies en tu celular.<br />¿Acceso no activado? Llama a central.
          </p>
        </div>
      </div>
    );
  }

  // ── SELECTOR / ESPERANDO SERVICIO ──────────────────────────────────────────
  if (estado === "selector") {
    const serviciosDelBus = reservas.filter(r => busDe(r).key === busSelKey);

    return (
      <div style={{ position: "fixed", inset: 0, background: "#FAF8F2", overflowY: "auto", fontFamily: FONT }}>
        {GLOBAL_CSS}
        <div style={{ maxWidth: 500, margin: "0 auto", padding: "30px 22px 56px" }}>

          {/* Barra conductor */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
              <div style={{ width: 42, height: 42, borderRadius: 13, background: "#0b315f", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <IconUser sz={20} c="#fff" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9AA1AC", letterSpacing: 1, textTransform: "uppercase" }}>Conductor</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#0E1320", letterSpacing: -0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conductor?.nombre ?? "—"}</div>
              </div>
            </div>
            <button onClick={logout} style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #EFEEE6", borderRadius: 11, padding: "9px 13px", color: "#6B7280", fontFamily: FONT, fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
              <IconLogout sz={15} c="#6B7280" /> Salir
            </button>
          </div>

          {/* Esperando servicio activo */}
          <div style={{ background: "#fff", border: "1px solid #EFEEE6", borderRadius: 20, padding: "24px 20px", textAlign: "center", marginBottom: 30, boxShadow: "0 4px 16px rgba(0,0,0,.04)" }}>
            <div style={{ width: 54, height: 54, margin: "0 auto 16px", borderRadius: "50%", background: "#EEF2F8", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
              <div style={{ position: "absolute", inset: -2, borderRadius: "50%", border: "2.5px solid rgba(11,49,95,.18)", borderTopColor: "#0b315f", animation: "lqr-spin 1.1s linear infinite" }} />
              <IconLink sz={24} c="#0b315f" />
            </div>
            <h1 style={{ color: "#0E1320", fontSize: 20, fontWeight: 800, margin: "0 0 6px", letterSpacing: -0.5 }}>Esperando el servicio</h1>
            <p style={{ color: "#6B7280", fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>
              La tablet se enganchará sola cuando el conductor inicie un servicio en su celular.
            </p>
          </div>

          {/* Inicio manual (respaldo) */}
          <p style={{ color: "#9AA1AC", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, height: 1, background: "#E7E5DD" }} /> O inicia manualmente <span style={{ flex: 1, height: 1, background: "#E7E5DD" }} />
          </p>

          {buses.length === 0 ? (
            <div style={{ padding: "20px", borderRadius: 16, background: "#fff", border: "1px solid #EFEEE6", color: "#9AA1AC", textAlign: "center", fontSize: 14, marginBottom: 12 }}>
              No tienes buses asignados a servicios hoy
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 22 }}>
              {buses.map(v => {
                const sel = busSelKey === v.key;
                return (
                  <button key={v.key}
                    onClick={() => { setBusSelKey(v.key); setReservaSelId(null); }}
                    style={{
                      width: "100%", padding: "14px 16px", borderRadius: 16,
                      background: sel ? "#0b315f" : "#fff",
                      border: `1.5px solid ${sel ? "#0b315f" : "#EFEEE6"}`,
                      cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 14,
                      fontFamily: FONT, transition: "all .15s",
                      boxShadow: sel ? "0 8px 22px -8px rgba(11,49,95,.5)" : "0 1px 3px rgba(0,0,0,.03)",
                    }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: sel ? "rgba(255,255,255,.16)" : "#EEF2F8", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IconBus sz={21} c={sel ? "#fff" : "#0b315f"} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: 0.5, fontFamily: MONO, color: sel ? "#fff" : "#0E1320" }}>{v.placa}</div>
                      {v.categoria && <div style={{ color: sel ? "rgba(255,255,255,.6)" : "#9AA1AC", fontSize: 12, marginTop: 2, fontWeight: 600 }}>{v.categoria}</div>}
                    </div>
                    {sel && (
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <IconCheck sz={15} c="#0b315f" sw={2.4} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {busSelKey && serviciosDelBus.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 26 }}>
              {serviciosDelBus.map(r => {
                const sel = reservaSelId === r.id;
                const activo = ES_ACTIVO(r.estado);
                return (
                  <button key={r.id} onClick={() => setReservaSelId(r.id)}
                    style={{
                      width: "100%", padding: "14px 16px", borderRadius: 15,
                      background: sel ? "#E8F5E9" : "#fff",
                      border: `1.5px solid ${sel ? "#16a34a" : "#EFEEE6"}`,
                      cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                      fontFamily: FONT, transition: "all .15s",
                    }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14.5, color: "#0E1320", lineHeight: 1.35 }}>{r.origen} → {r.destino}</div>
                      <div style={{ color: "#9AA1AC", fontSize: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconClock sz={13} c="#9AA1AC" /> {r.hora_servicio || "—"}</span>
                        {activo && <span style={{ color: "#16a34a", fontWeight: 700 }}>· en curso</span>}
                      </div>
                    </div>
                    {sel && (
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <IconCheck sz={15} c="#fff" sw={2.4} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <button
            onClick={() => {
              if (!reservaSelId) return;
              if (!audioCtxRef.current) {
                try { audioCtxRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)(); setAudioListo(true); } catch {}
              }
              const r = reservas.find(x => x.id === reservaSelId);
              setModoManual(!ES_ACTIVO(r?.estado));
              loadRuta(reservaSelId);
            }}
            disabled={!reservaSelId}
            style={{
              width: "100%", padding: "16px 0", borderRadius: 16, border: "none",
              background: reservaSelId ? "#0b315f" : "#E7E5DD",
              color: reservaSelId ? "#fff" : "#9AA1AC",
              fontSize: 16, fontWeight: 800, cursor: reservaSelId ? "pointer" : "not-allowed",
              fontFamily: FONT, transition: "all .2s", letterSpacing: -0.3,
              boxShadow: reservaSelId ? "0 8px 24px -6px rgba(11,49,95,.5)" : "none",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
            }}>
            Iniciar lector QR <IconArrow sz={18} c={reservaSelId ? "#fff" : "#9AA1AC"} />
          </button>
        </div>
      </div>
    );
  }

  // ── PANTALLA ESCÁNER + OVERLAYS ───────────────────────────────────────────
  const total          = pasajeros.length;
  const overlayVisible = estado === "autorizado" || estado === "ya_registrado" || estado === "no_autorizado" || estado === "otra_empresa";
  const busActivo      = busDe(reservaInfo);

  const overlayCfg: Record<string, { bg: string; icon: React.ReactNode; titulo: string; sub: string }> = {
    autorizado:    { bg: "#16a34a", icon: <IconCheck sz={84} c="#fff" sw={2.6} />, titulo: resultPax?.nombre || "Autorizado",   sub: resultPax?.empresa || "" },
    ya_registrado: { bg: "#1d4ed8", icon: <IconAlert sz={78} c="#fff" />,          titulo: "Ya embarcado",                      sub: resultPax?.nombre  || "" },
    no_autorizado: { bg: "#dc2626", icon: <IconX sz={84} c="#fff" sw={2.6} />,     titulo: "No autorizado",                     sub: "Pasajero no encontrado" },
    otra_empresa:  { bg: "#dc2626", icon: <IconBan sz={80} c="#fff" />,            titulo: "Otra empresa",                      sub: `${resultPax?.empresa || "Pasajero"} — no es de este servicio (registrado)` },
  };
  const oCfg = overlayVisible ? overlayCfg[estado] : null;

  const linkCfg = modoManual
    ? { color: "#FACC15", label: "Modo manual · celular sin servicio" }
    : { color: "#4ADE80", label: "Enlazado · siguiendo al conductor" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", fontFamily: FONT, userSelect: "none", WebkitUserSelect: "none" }}>
      {GLOBAL_CSS}

      {/* ── VISOR QR a pantalla completa ── */}
      <div id="qr-reader" style={{ position: "absolute", inset: 0 }} />

      {/* ── Marco de escaneo + línea animada ── */}
      <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
        {([
          { top: 96,  left: 22,  bt: 4, bl: 4, r: "16px 0 0 0" },
          { top: 96,  right: 22, bt: 4, br: 4, r: "0 16px 0 0" },
          { bottom: 150, left: 22,  bb: 4, bl: 4, r: "0 0 0 16px" },
          { bottom: 150, right: 22, bb: 4, br: 4, r: "0 0 16px 0" },
        ] as any[]).map((s, i) => (
          <div key={i} style={{
            position: "absolute", width: 46, height: 46,
            top: s.top, bottom: s.bottom, left: s.left, right: s.right,
            borderStyle: "solid", borderColor: "#60A5FA", borderWidth: 0,
            borderTopWidth: s.bt || 0, borderBottomWidth: s.bb || 0, borderLeftWidth: s.bl || 0, borderRightWidth: s.br || 0,
            borderRadius: s.r,
          }} />
        ))}
        {!overlayVisible && (
          <div style={{ position: "absolute", left: 24, right: 24, height: 2, background: "linear-gradient(90deg, transparent, #60A5FA 20%, #60A5FA 80%, transparent)", boxShadow: "0 0 18px #3B82F6", animation: "lqr-scan 2.6s ease-in-out infinite" }} />
        )}
      </div>

      {/* ── BARRA SUPERIOR ── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
        background: "linear-gradient(to bottom, rgba(0,0,0,.92) 0%, transparent 100%)",
        padding: "18px 18px 40px", display: "flex", alignItems: "flex-start", gap: 12,
      }}>
        <button onClick={volverSelector}
          style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: "rgba(255,255,255,.14)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconBack sz={18} c="#fff" />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "rgba(255,255,255,.4)", fontSize: 11, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {busActivo.key !== "none" && (
              <span style={{ background: "rgba(96,165,250,.28)", borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 800, color: "#fff", fontFamily: MONO }}>{busActivo.placa}</span>
            )}
            <span>{reservaInfo?.origen} → {reservaInfo?.destino}</span>
          </div>
          <div style={{ color: "#fff", fontSize: 17, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {paradaActual?.nombre ?? "Detectando parada…"}
          </div>
          {paradaActual?.hora_estimada && (
            <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12, marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}>
              <IconClock sz={12} c="rgba(255,255,255,.4)" /> {paradaActual.hora_estimada}
            </div>
          )}
          {/* Estado de enlace */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 7 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: linkCfg.color, boxShadow: `0 0 6px ${linkCfg.color}` }} />
            <span style={{ color: linkCfg.color, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8 }}>{linkCfg.label}</span>
          </div>
        </div>

        {/* Contador */}
        <div style={{ background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 14, padding: "10px 16px", textAlign: "center", minWidth: 64, backdropFilter: "blur(10px)", flexShrink: 0 }}>
          <div style={{ color: "#4ADE80", fontSize: 25, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{embarcados}</div>
          <div style={{ color: "rgba(255,255,255,.4)", fontSize: 11, fontWeight: 600, marginTop: 1 }}>/ {total}</div>
          <div style={{ color: "rgba(255,255,255,.3)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.8, marginTop: 2 }}>a bordo</div>
        </div>
      </div>

      {/* ── NOTIFICACIÓN ── */}
      {msgCambio && (
        <div style={{
          position: "absolute", top: 118, left: "50%", transform: "translateX(-50%)",
          background: "rgba(11,49,95,.95)", backdropFilter: "blur(8px)", borderRadius: 12,
          padding: "10px 18px", color: "#fff", fontSize: 13, fontWeight: 700, zIndex: 30,
          whiteSpace: "nowrap", boxShadow: "0 4px 20px rgba(0,0,0,.4)", animation: "lqr-slideDown .3s ease",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <IconRefresh sz={14} c="#fff" /> {msgCambio}
        </div>
      )}

      {/* ── BARRA INFERIOR ── */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 20,
        background: "linear-gradient(to top, rgba(0,0,0,.9) 0%, transparent 100%)",
        padding: "40px 20px 30px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ADE80", boxShadow: "0 0 10px #4ADE80", animation: "lqr-blink 2s ease-in-out infinite" }} />
          <span style={{ color: "rgba(255,255,255,.7)", fontSize: 15, fontWeight: 500 }}>Apunta al QR del pasajero</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 420 }}>
          <button onClick={sincronizar} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: "rgba(96,165,250,.16)", border: "1px solid rgba(96,165,250,.32)", borderRadius: 12, padding: "11px 14px", color: "#93C5FD", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
            <IconRefresh sz={15} c="#93C5FD" /> Sincronizar
          </button>
          <button onClick={siguienteParada} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", borderRadius: 12, padding: "11px 14px", color: "rgba(255,255,255,.8)", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
            <IconForward sz={15} c="rgba(255,255,255,.8)" /> Siguiente parada
          </button>
        </div>
        {!audioListo && (
          <span style={{ color: "#FACC15", fontSize: 11, fontWeight: 600 }}>Toca la pantalla para activar el audio</span>
        )}
      </div>

      {/* ── OVERLAY RESULTADO ── */}
      {overlayVisible && oCfg && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50, background: oCfg.bg,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", animation: "lqr-fadeIn .12s ease",
        }}>
          <div style={{ marginBottom: 30, filter: "drop-shadow(0 8px 32px rgba(0,0,0,.3))" }}>{oCfg.icon}</div>
          <div style={{ color: "#fff", fontSize: 34, fontWeight: 900, textAlign: "center", padding: "0 32px", letterSpacing: -0.8, lineHeight: 1.15 }}>{oCfg.titulo}</div>
          {oCfg.sub && (
            <div style={{ color: "rgba(255,255,255,.78)", fontSize: 19, marginTop: 14, textAlign: "center", padding: "0 40px", lineHeight: 1.4, fontWeight: 500 }}>{oCfg.sub}</div>
          )}
          {estado === "ya_registrado" && (
            <div style={{ marginTop: 20, background: "rgba(255,255,255,.14)", borderRadius: 20, padding: "6px 14px", fontSize: 12, color: "rgba(255,255,255,.65)", fontWeight: 600 }}>Sin sonido</div>
          )}
        </div>
      )}
    </div>
  );
}
