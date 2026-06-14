"use client";

import { useEffect, useRef, useState, useCallback, type ReactElement } from "react";
import { supabase } from "@/lib/supabase";
import { pedirPermisoUbicacion, obtenerUbicacion, observarUbicacion, geoDisponible, type GeoPos, type GeoWatch } from "@/lib/geo";
import {
  CondorMark,
  IconActivity, IconAlert, IconArrowLeft, IconArrowRight, IconBell, IconBus,
  IconCalendar, IconCamera, IconCheck, IconChevronRight, IconCircleAlert,
  IconClock, IconClose, IconFlag, IconFuel, IconGauge, IconKey, IconLogout,
  IconMail, IconMoreH, IconNav, IconPhone, IconPin, IconPlay, IconQR,
  IconReceipt, IconRefresh, IconRoute, IconScan, IconShield, IconStop,
  IconUser, IconUsers, IconWrench,
} from "@/app/_components/icons";
import {
  Chip, Eyebrow, StatusDot, PrimaryBtn, SecondaryBtn, TabBar,
  FONT_SANS, FONT_MONO, type TabItem,
} from "@/app/_components/ui";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Conductor = {
  id: number; nombre: string; dni: string | null; telefono: string | null;
  pin_acceso: string | null; activo_app: boolean; licencia?: string | null;
  vencimiento_licencia?: string | null; categoria_licencia?: string | null;
  sctr_salud_venc?: string | null; examen_medico_venc?: string | null;
  _tabla?: "conductores" | "conductores_tercero";
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; marca?: string | null; };
type Reserva   = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio?: string | null; vehiculo_id?: number | null; };
type Parada    = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; };
type Pasajero  = { id: number; nombre: string; dni: string | null; empresa: string | null; qr_code: string | null; foto_url: string | null; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; pasajero?: Pasajero; };
type CheckItem = { id: string; label: string; categoria: string; ok: boolean | null; };
type DocCond   = { id: number; tipo: string; nombre: string | null; url: string; vencimiento: string | null; };

type Tab = "ruta" | "paradas" | "checklist" | "documentos" | "perfil";

type IncidenciaTipo = "trafico" | "mecanica" | "pasajero" | "accidente" | "combustible" | "seguridad";
type Severidad      = "bajo" | "medio" | "alto";

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CHECKLIST_ITEMS: CheckItem[] = [
  { id: "neumaticos",  label: "Neumáticos en buen estado",          categoria: "Seguridad",    ok: null },
  { id: "luces",       label: "Luces delanteras y traseras OK",      categoria: "Seguridad",    ok: null },
  { id: "frenos",      label: "Frenos funcionando correctamente",    categoria: "Seguridad",    ok: null },
  { id: "espejos",     label: "Espejos ajustados y limpios",         categoria: "Seguridad",    ok: null },
  { id: "cinturones",  label: "Cinturones de seguridad operativos",  categoria: "Seguridad",    ok: null },
  { id: "aceite",      label: "Nivel de aceite correcto",            categoria: "Mecánica",     ok: null },
  { id: "agua",        label: "Nivel de agua / refrigerante OK",     categoria: "Mecánica",     ok: null },
  { id: "combustible", label: "Combustible suficiente",              categoria: "Mecánica",     ok: null },
  { id: "bateria",     label: "Batería en buen estado",              categoria: "Mecánica",     ok: null },
  { id: "soat",        label: "SOAT vigente a bordo",                categoria: "Documentos",   ok: null },
  { id: "licencia_ab", label: "Licencia de conducir a bordo",        categoria: "Documentos",   ok: null },
  { id: "botiquin",    label: "Botiquín de primeros auxilios",       categoria: "Equipamiento", ok: null },
  { id: "extintor",    label: "Extintor vigente a bordo",            categoria: "Equipamiento", ok: null },
  { id: "limpieza",    label: "Unidad limpia y presentable",         categoria: "Equipamiento", ok: null },
];

const TIPOS_DOC = ["Licencia de conducir", "SCTR Salud", "Examen médico", "Psicosométrico", "Antecedentes", "Foto DNI", "Otro"];

const INCIDENCIA_TIPOS: { id: IncidenciaTipo; label: string; icon: (p: any) => ReactElement }[] = [
  { id: "trafico",     label: "Tráfico",     icon: IconActivity },
  { id: "mecanica",    label: "Mecánica",    icon: IconWrench },
  { id: "pasajero",    label: "Pasajero",    icon: IconUser },
  { id: "accidente",   label: "Accidente",   icon: IconAlert },
  { id: "combustible", label: "Combustible", icon: IconFuel },
  { id: "seguridad",   label: "Seguridad",   icon: IconShield },
];

const SEVERIDADES: { id: Severidad; label: string; color: string; bg: string }[] = [
  { id: "bajo",  label: "Leve",  color: "var(--c-success)", bg: "var(--c-success-tint)" },
  { id: "medio", label: "Media", color: "var(--c-warn)",    bg: "var(--c-warn-tint)" },
  { id: "alto",  label: "Alta",  color: "var(--c-danger)",  bg: "var(--c-danger-tint)" },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Fecha local (Lima UTC-5) — NO usar new Date().toISOString().
function getFechaLocal(): string {
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function diasPara(f: string | null) {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

// Llama al endpoint con service_role del conductor (saltea RLS — el conductor es
// anónimo porque usa PIN, no sesión Supabase). Lanza Error con el mensaje del server.
async function condApi(accion: string, params: Record<string, any> = {}) {
  const res = await fetch("/api/conductor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accion, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Error de red");
  return json;
}

function docEstado(f: string | null): "ok" | "pronto" | "vencido" | "sin" {
  const d = diasPara(f); if (d === null) return "sin";
  if (d < 0) return "vencido"; if (d <= 30) return "pronto"; return "ok";
}

function ini(n: string): string {
  return n.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function minutosAlServicio(hora: string | null | undefined): number | null {
  if (!hora) return null;
  const [h, m] = hora.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const diff = target.getTime() - now.getTime();
  return diff < 0 ? null : Math.floor(diff / 60000);
}

function fmtCountdown(mins: number): string {
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return `${String(mins).padStart(2, "0")}m`;
}

function fmtDuracion(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function playBeep(tipo: "ok" | "warn" | "error") {
  try {
    const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
    // Compresor para maximizar volumen sin distorsión
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    const play = (freq: number, startSec: number, dur: number, type: OscillatorType = "square") => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(comp);
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(1.0, ctx.currentTime + startSec);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + dur);
      osc.start(ctx.currentTime + startSec);
      osc.stop(ctx.currentTime + startSec + dur + 0.05);
    };
    if (tipo === "ok")    { play(880,  0,    0.10); play(1100, 0.14, 0.10); }
    if (tipo === "warn")  { play(440,  0,    0.20); }
    if (tipo === "error") { play(180,  0,    0.18, "sawtooth"); play(130, 0.20, 0.25, "sawtooth"); }
  } catch { /* AudioContext no disponible */ }
}

function fechaTitulo(): { dow: string; fecha: string } {
  const now = new Date();
  const dow = now.toLocaleDateString("es-PE", { weekday: "long" });
  const fecha = now.toLocaleDateString("es-PE", { day: "numeric", month: "long" });
  return { dow: dow.toUpperCase(), fecha };
}

// ─── SESSION ──────────────────────────────────────────────────────────────────

const SK = "afa_cond_v2";
function saveSession(c: Conductor) {
  localStorage.setItem(SK, JSON.stringify({ c, exp: Date.now() + 12 * 3600000 }));
}
function loadSession(): Conductor | null {
  try {
    const raw = localStorage.getItem(SK); if (!raw) return null;
    const { c, exp } = JSON.parse(raw);
    if (Date.now() > exp) { localStorage.removeItem(SK); return null; }
    return c;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SK); }

// ─── SERVICIO ACTIVO (persiste entre recargas) ────────────────────────────────

const SK_SRV = "afa_serv_v1";
type ServicioGuardado = {
  reservaId: number; vehiculoId: number;
  paradaIdx: number; inicioViaje: string;
};
function saveServicio(d: ServicioGuardado) {
  localStorage.setItem(SK_SRV, JSON.stringify(d));
}
function loadServicio(): ServicioGuardado | null {
  try {
    const raw = localStorage.getItem(SK_SRV);
    return raw ? (JSON.parse(raw) as ServicioGuardado) : null;
  } catch { return null; }
}
function clearServicio() { localStorage.removeItem(SK_SRV); }

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ConductorApp() {

  const [initing,      setIniting]      = useState(true);
  const [conductor,    setConductor]    = useState<Conductor | null>(null);
  const [tab,          setTab]          = useState<Tab>("ruta");

  // ── Login ──────────────────────────────────────────────────────────────────
  const [dni,          setDni]          = useState("");
  const [pin,          setPin]          = useState("");
  const [loginErr,     setLoginErr]     = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  // ── Datos ──────────────────────────────────────────────────────────────────
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [reservasHoy,  setReservasHoy]  = useState<Reserva[]>([]);
  const [vehiculoId,   setVehiculoId]   = useState<number | null>(null);
  const [reservaActiva,setReservaActiva]= useState<Reserva | null>(null);
  const [paradas,      setParadas]      = useState<Parada[]>([]);
  const [pasajeros,    setPasajeros]    = useState<PasajeroParada[]>([]);
  const [paradaIdx,    setParadaIdx]    = useState(0);
  const [docs,         setDocs]         = useState<DocCond[]>([]);
  const [cargando,     setCargando]     = useState(false);
  const [debugFecha,   setDebugFecha]   = useState("");
  const [debugInfo,    setDebugInfo]    = useState("");

  // ── GPS ────────────────────────────────────────────────────────────────────
  const [enRuta,       setEnRuta]       = useState(false);
  const [posActual,    setPosActual]    = useState<GeoPos | null>(null);
  const [velocidad,    setVelocidad]    = useState(0);
  const [totalEnvios,  setTotalEnvios]  = useState(0);
  const [ultimoEnvio,  setUltimoEnvio]  = useState<Date | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);
  const [iniciando,          setIniciando]          = useState(false);
  const [inicioViaje,        setInicioViaje]        = useState<Date | null>(null);
  const [restaurandoServicio,setRestaurandoServicio] = useState(false);
  const pinInputRef      = useRef<HTMLInputElement | null>(null);
  const watchIdRef       = useRef<GeoWatch | null>(null);
  const intervalRef      = useRef<NodeJS.Timeout | null>(null);
  const posRef           = useRef<GeoPos | null>(null);
  // Refs estables para GPS (evitan closures obsoletos en setInterval)
  const vehiculoIdRef    = useRef<number | null>(null);
  const conductorRef     = useRef<Conductor | null>(null);
  const reservaActivaRef = useRef<Reserva | null>(null);

  // ── Sync refs (para GPS sin closures obsoletos) ────────────────────────────
  useEffect(() => { vehiculoIdRef.current    = vehiculoId;    }, [vehiculoId]);
  useEffect(() => { conductorRef.current     = conductor;     }, [conductor]);
  useEffect(() => { reservaActivaRef.current = reservaActiva; }, [reservaActiva]);

  // ── Tick para refrescar countdown y duración (1 minuto) ────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── SOS ────────────────────────────────────────────────────────────────────
  const [sosPct,       setSosPct]       = useState(0);
  const [sosActivo,    setSosActivo]    = useState(false);
  const [sosEnviado,   setSosEnviado]   = useState(false);
  const sosTimer       = useRef<NodeJS.Timeout | null>(null);
  const sosInterval    = useRef<NodeJS.Timeout | null>(null);

  // ── QR Scanner ─────────────────────────────────────────────────────────────
  const [escanear,          setEscanear]          = useState(false);
  const [validando,         setValidando]         = useState<Pasajero | null>(null); // kept for TS compat, unused after redesign
  const [resultadoEmbarque, setResultadoEmbarque] = useState<{ pasajero: Pasajero; fueraLista: boolean } | null>(null);
  const [resultProgreso,    setResultProgreso]    = useState(0);
  const [boardingMsg,       setBoardingMsg]       = useState<{ok: boolean; msg: string} | null>(null);
  const qrRef               = useRef<any>(null);
  const resultIntervalRef   = useRef<NodeJS.Timeout | null>(null);

  // ── Checklist ──────────────────────────────────────────────────────────────
  const [checks,       setChecks]       = useState<CheckItem[]>(CHECKLIST_ITEMS.map(i => ({ ...i })));
  const [kmInicio,     setKmInicio]     = useState("");
  const [checkObs,     setCheckObs]     = useState("");
  const [checkDone,    setCheckDone]    = useState(false);
  const [checkSaving,  setCheckSaving]  = useState(false);

  // ── Docs ───────────────────────────────────────────────────────────────────
  const [docTipo,      setDocTipo]      = useState(TIPOS_DOC[0]);
  const [docUrl,       setDocUrl]       = useState("");
  const [docVenc,      setDocVenc]      = useState("");
  const [docSaving,    setDocSaving]    = useState(false);

  // ── Perfil ─────────────────────────────────────────────────────────────────
  const [pinNuevo,     setPinNuevo]     = useState("");
  const [pinConfirm,   setPinConfirm]   = useState("");
  const [pinMsg,       setPinMsg]       = useState("");
  const [camPin,       setCamPin]       = useState(false);

  // ── Notificación retraso ───────────────────────────────────────────────────
  const [notifEnviada, setNotifEnviada] = useState(false);

  // ── Sub-vistas nuevas ──────────────────────────────────────────────────────
  const [showManifiesto, setShowManifiesto] = useState(false);
  const [showFinViaje,   setShowFinViaje]   = useState(false);

  // ── Incidencia ─────────────────────────────────────────────────────────────
  const [showIncidencia, setShowIncidencia] = useState(false);
  const [incTipo,        setIncTipo]        = useState<IncidenciaTipo | null>(null);
  const [incSev,         setIncSev]         = useState<Severidad>("medio");
  const [incDesc,        setIncDesc]        = useState("");
  const [incRetraso,     setIncRetraso]     = useState("");
  const [incSaving,      setIncSaving]      = useState(false);

  // ─── Inicializar ────────────────────────────────────────────────────────────

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setConductor(saved); cargarDatos(saved.id, saved._tabla); }
    setIniting(false);
    return () => cleanup();
  }, []);

  function cleanup() {
    if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async function login() {
    if (dni.length < 7) { setLoginErr("Ingresa tu DNI"); return; }
    if (pin.length < 4) { setLoginErr("PIN de 4 dígitos"); return; }
    setLoginErr(""); setLoginLoading(true);

    // Buscar primero en conductores propios
    const { data } = await supabase.from("conductores")
      .select("id,nombre,dni,telefono,pin_acceso,activo_app,licencia,vencimiento_licencia,categoria_licencia,sctr_salud_venc,examen_medico_venc")
      .eq("dni", dni.trim()).single();

    if (data) {
      if (!data.activo_app) { setLoginErr("Acceso no activado. Llama a central."); setLoginLoading(false); return; }
      if (data.pin_acceso !== pin) { setLoginErr("PIN incorrecto"); setLoginLoading(false); return; }
      const c = { ...data, _tabla: "conductores" as const };
      saveSession(c); setConductor(c); await cargarDatos(c.id, c._tabla); setLoginLoading(false);
      return;
    }

    // Si no se encontró, buscar en conductores de terceros
    const { data: data2 } = await supabase.from("conductores_tercero")
      .select("id,nombre,dni,telefono,pin_acceso,activo_app,licencia,vencimiento_licencia,categoria_licencia")
      .eq("dni", dni.trim()).single();

    if (!data2) { setLoginErr("DNI no encontrado"); setLoginLoading(false); return; }
    if (!data2.activo_app) { setLoginErr("Acceso no activado. Llama a central."); setLoginLoading(false); return; }
    if (data2.pin_acceso !== pin) { setLoginErr("PIN incorrecto"); setLoginLoading(false); return; }
    const c2 = { ...data2, _tabla: "conductores_tercero" as const };
    saveSession(c2); setConductor(c2); await cargarDatos(c2.id, c2._tabla); setLoginLoading(false);
  }

  // ─── Cargar datos ───────────────────────────────────────────────────────────

  const cargarDatos = useCallback(async (cid: number, tabla?: string) => {
    setCargando(true);
    const hoy = getFechaLocal();
    setDebugFecha(hoy);

    let data: any;
    try {
      // Via service_role (saltea RLS) — el conductor es anónimo.
      data = await condApi("inicio", { cid, tabla: tabla ?? "conductores", hoy });
      setDebugInfo("");
    } catch (e: any) {
      setDebugInfo(`Error al cargar servicios: ${e?.message ?? "desconocido"}`);
      setCargando(false);
      return;
    }

    const res: Reserva[] = data.reservas || [];
    // Combinar vehículos propios y de tercero; usar el id correcto según el tipo de reserva
    const vehiculoIds    = new Set(res.map(r => r.vehiculo_id).filter(Boolean));
    const vehiculoTerIds = new Set(res.map(r => (r as any).vehiculo_tercero_id).filter(Boolean));
    const propios  = ((data.vehiculos        || []) as Vehiculo[]).filter(v => vehiculoIds.has(v.id));
    const terceros = ((data.vehiculosTercero || []) as Vehiculo[]).filter(v => vehiculoTerIds.has(v.id));
    setVehiculos([...propios, ...terceros]);
    setReservasHoy(res);
    // Auto-seleccionar vehículo si todas las reservas usan el mismo
    const vidsUnicos = [...new Set([...vehiculoIds, ...vehiculoTerIds])];
    if (vidsUnicos.length === 1) setVehiculoId(vidsUnicos[0] as number);
    setDocs(data.docs || []);
    if (data.checklistHecho) setCheckDone(true);
    setCargando(false);

    // ── Restaurar servicio activo si la sesión fue interrumpida ───────────
    const srv = loadServicio();
    if (srv) {
      const reserva = res.find(r => r.id === srv.reservaId);
      if (!reserva) { clearServicio(); return; }
      setVehiculoId(srv.vehiculoId);
      setReservaActiva(reserva);
      setInicioViaje(new Date(srv.inicioViaje));
      await cargarParadas(reserva.id);
      setParadaIdx(srv.paradaIdx);
      setEnRuta(true);
      setRestaurandoServicio(true);   // dispara el effect de GPS
      setTab("paradas");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cargarParadas(reservaId: number) {
    // Usa el API endpoint que auto-crea paradas desde origen/destino si no existen
    const res = await fetch(`/api/conductor-paradas?reservaId=${reservaId}`);
    const json = await res.json();
    if (!res.ok) {
      alert(`No se pudieron cargar las paradas: ${json.error ?? "Error desconocido"}`);
      return;
    }
    const listaParadas: Parada[] = json.paradas || [];
    setParadas(listaParadas);
    if (listaParadas.length > 0) {
      try {
        const { pasajeros: pp } = await condApi("pasajeros", { paradaIds: listaParadas.map((p: Parada) => p.id) });
        setPasajeros(pp || []);
      } catch (e: any) {
        console.error("[Pasajeros parada]", e?.message);
      }
    }
  }

  // ─── Restaurar servicio desde localStorage (el GPS ya corre desde login) ────
  useEffect(() => {
    if (!restaurandoServicio) return;
    setRestaurandoServicio(false);
    // GPS watchPosition ya está activo desde el useEffect de login — no reiniciar
  }, [restaurandoServicio]);

  // ─── GPS + TRACKING ──────────────────────────────────────────────────────────

  // Usa refs → nunca tiene closures obsoletos aunque el intervalo se cree antes del render
  const enviarUbicacion = useCallback(async (pos: GeoPos, estado = "") => {
    const vid  = vehiculoIdRef.current;
    const cond = conductorRef.current;
    const res  = reservaActivaRef.current;
    if (!cond) return;                        // sólo necesitamos el conductor
    const estadoFinal = estado || (vid ? "en_ruta" : "disponible");
    const payload = {
      vehiculo_id:  vid || null,              // null hasta que seleccione vehículo
      conductor_id: cond.id,
      reserva_id:   res?.id || null,
      lat:          pos.coords.latitude,
      lng:          pos.coords.longitude,
      velocidad:    pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
      rumbo:        pos.coords.heading || 0,
      precision_m:  pos.coords.accuracy,
      estado:       estadoFinal,
      created_at:   new Date().toISOString(),
    };
    try {
      await condApi("ubicacion", { payload });
      setUltimoEnvio(new Date());
      setTotalEnvios(p => p + 1);
    } catch (e: any) {
      console.error("[GPS] Error al enviar ubicación:", e?.message);
    }
    setVelocidad(pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── GPS desde login: activo en todo momento mientras el conductor esté logueado ─
  useEffect(() => {
    if (!conductor) return;
    if (!geoDisponible()) { setGpsError("GPS no disponible en este dispositivo"); return; }
    let cancelado = false;
    // Limpiar instancias previas por si acaso
    if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }

    (async () => {
      // En la app nativa esto dispara el diálogo de permisos del sistema
      // (igual que Maps/inDrive). En web el permiso se pide al leer la posición.
      const permiso = await pedirPermisoUbicacion();
      if (permiso === "denied")      { setGpsError("Permiso de ubicación denegado"); return; }
      if (permiso === "unavailable") { setGpsError("GPS no disponible en este dispositivo"); return; }
      if (cancelado) return;
      // Arrancar watchPosition continuo
      const w = await observarUbicacion(
        (pos) => { posRef.current = pos; setPosActual(pos); setGpsError(null); },
        (e)   => setGpsError(e.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );
      if (cancelado) { w.clear(); return; }
      watchIdRef.current = w;
    })();

    // Enviar ubicación cada 15 s (sin vehículo → 🧑 persona; con vehículo → 🚌 bus)
    intervalRef.current = setInterval(() => {
      if (posRef.current) enviarUbicacion(posRef.current);
    }, 15000);
    return () => {
      cancelado = true;
      if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id]);

  async function iniciarRecorrido(reserva: Reserva) {
    if (!checkDone) { alert("Debes completar el pre-viaje antes de iniciar el recorrido"); setTab("checklist"); return; }
    if (!vehiculoId) { alert("Selecciona el vehículo primero"); return; }
    setIniciando(true);
    await cargarParadas(reserva.id);
    // Transición INMEDIATA a la ruta — NO esperar al GPS (el watchPosition desde el
    // login ya rastrea). Bloquear aquí dejaba el botón colgado en "Obteniendo GPS…"
    // si el aparato no tenía señal.
    const ahora = new Date();
    setReservaActiva(reserva);
    setEnRuta(true);
    setInicioViaje(ahora);
    setIniciando(false);
    setTab("paradas");
    saveServicio({ reservaId: reserva.id, vehiculoId: vehiculoId!, paradaIdx: 0, inicioViaje: ahora.toISOString() });
    // Posición inicial best-effort, en segundo plano (no bloquea la UI).
    obtenerUbicacion({ enableHighAccuracy: true, timeout: 12000 })
      .then((pos) => { posRef.current = pos; setPosActual(pos); enviarUbicacion(pos); })
      .catch((e: any) => console.warn("[iniciarRecorrido] sin GPS inicial:", e?.message));
  }

  function finalizarRecorridoConfirmado() {
    if (posRef.current) enviarUbicacion(posRef.current, "finalizado");
    // GPS continúa activo en background desde el login
    clearServicio();   // eliminar servicio guardado al finalizar correctamente
    setEnRuta(false); setReservaActiva(null); setParadas([]); setPasajeros([]);
    setParadaIdx(0); setVelocidad(0); setTotalEnvios(0); setTab("ruta");
    setShowFinViaje(false);
    setInicioViaje(null);
  }

  async function marcarParadaCompletada(paradaId: number) {
    try {
      await condApi("marcar_parada", { paradaId });
    } catch (e: any) { alert(`Error al marcar parada: ${e?.message}`); return; }
    setParadas(prev => prev.map(p => p.id === paradaId ? { ...p, estado: "completada" } : p));
    if (paradaIdx < paradas.length - 1) {
      const nuevaIdx = paradaIdx + 1;
      setParadaIdx(nuevaIdx);
      saveServicio({
        reservaId:   reservaActiva!.id,
        vehiculoId:  vehiculoId!,
        paradaIdx:   nuevaIdx,
        inicioViaje: inicioViaje?.toISOString() ?? new Date().toISOString(),
      });
    } else {
      setShowFinViaje(true);
    }
  }

  // ─── SOS ─────────────────────────────────────────────────────────────────────

  function iniciarSOS() {
    if (sosEnviado) return;
    setSosActivo(true); setSosPct(0);
    let elapsed = 0;
    sosInterval.current = setInterval(() => {
      elapsed += 50;
      setSosPct(Math.min(100, (elapsed / 2000) * 100));
    }, 50);
    sosTimer.current = setTimeout(async () => {
      clearInterval(sosInterval.current!);
      setSosActivo(false); setSosPct(100);
      if (!conductor || !posRef.current) {
        alert("Error: GPS no disponible. SOS no pudo enviarse. Llama al +51 966 707 225.");
        setSosActivo(false); setSosPct(0);
        return;
      }
      const sosRes = await fetch("/api/conductor-alerta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reserva_id: reservaActiva?.id ?? null,
          lat:        posRef.current.coords.latitude,
          lng:        posRef.current.coords.longitude,
          motivo:     `SOS — ${conductor.nombre} solicita ayuda urgente`,
          estado:     "pendiente",
        }),
      });
      if (!sosRes.ok) {
        const j = await sosRes.json().catch(() => ({}));
        alert(`SOS no pudo registrarse: ${j.error ?? "error desconocido"}. Llama al +51 966 707 225.`);
        setSosPct(0);
        return;
      }
      await enviarUbicacion(posRef.current, "sos");
      setSosEnviado(true);
      setTimeout(() => { setSosEnviado(false); setSosPct(0); }, 10000);
    }, 2000);
  }

  function cancelarSOS() {
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
    setSosActivo(false); setSosPct(0);
  }

  // ─── QR SCANNER ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!escanear) {
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
      return;
    }
    let stopped = false;
    import("html5-qrcode").then(({ Html5Qrcode }) => {
      if (stopped) return;
      const container = document.getElementById("qr-container");
      if (!container) return;
      const scanner = new Html5Qrcode("qr-container");
      qrRef.current = scanner;
      scanner.start(
        { facingMode: "environment" },
        { fps: 12 },  // sin qrbox → detecta en toda la pantalla
        async (text: string) => {
          scanner.stop().catch(() => {}); qrRef.current = null; setEscanear(false);
          await procesarQR(text);
        },
        () => {}
      ).catch((err: any) => {
        console.error("[QR] Error al iniciar scanner:", err);
        setEscanear(false);
        alert("No se pudo acceder a la cámara. Verifica los permisos.");
      });
    }).catch((err: any) => {
      console.error("[QR] Error al cargar html5-qrcode:", err);
      alert("El módulo QR no está disponible. Ejecuta: npm install html5-qrcode");
    });
    return () => {
      stopped = true;
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
    };
  }, [escanear]);

  async function procesarQR(qrCode: string) {
    let pasajero: Pasajero | null = null;
    try {
      const r = await condApi("buscar_pasajero", { qrCode });
      pasajero = r.pasajero;
    } catch { /* tratado como no encontrado abajo */ }
    if (!pasajero) {
      playBeep("error");
      setBoardingMsg({ ok: false, msg: "QR no reconocido. Pasajero no encontrado en el sistema." });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }
    await confirmarEmbarque(pasajero);
  }

  async function confirmarEmbarque(pasajero: Pasajero) {
    const paradaActual = paradas[paradaIdx];
    if (!paradaActual) {
      playBeep("error");
      setBoardingMsg({ ok: false, msg: "Error: no hay parada activa." });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }

    const pp = pasajeros.find(p => p.pasajero_id === pasajero.id && p.parada_id === paradaActual.id);

    // Pasajero ya embarcado → advertencia y salir
    if (pp?.estado === "embarcado") {
      playBeep("warn");
      setBoardingMsg({ ok: false, msg: `${pasajero.nombre} ya está registrado en esta parada.` });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }

    // Pasajero en lista → marcar como embarcado
    if (pp) {
      try {
        await condApi("embarcar", { ppId: pp.id });
      } catch (e: any) {
        playBeep("error");
        setBoardingMsg({ ok: false, msg: `Error al registrar embarque: ${e?.message}` });
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }
      setPasajeros(prev => prev.map(p => p.id === pp.id ? { ...p, estado: "embarcado" } : p));
    }

    // Pasajero fuera de lista → registrar en pasajeros_parada vía API (service_role)
    const fueraLista = !pp;
    if (fueraLista) {
      // Actualizar estado local INMEDIATAMENTE (optimista) — con id temporal 0
      const tempEntry: PasajeroParada = {
        id: 0, parada_id: paradaActual.id, pasajero_id: pasajero.id,
        estado: "embarcado", pasajero,
      };
      setPasajeros(prev => [...prev, tempEntry]);

      // Persistir en DB vía API
      try {
        const res = await fetch("/api/conductor-alerta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tipo:        "embarque",
            parada_id:   paradaActual.id,
            pasajero_id: pasajero.id,
            reserva_id:  reservaActiva?.id ?? null,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.id) {
          // Actualizar el id temporal con el real
          setPasajeros(prev => prev.map(p =>
            p.id === 0 && p.pasajero_id === pasajero.id ? { ...p, id: json.id } : p
          ));
        } else if (!res.ok) {
          alert(`⚠️ Pasajero visible localmente pero no se pudo guardar en servidor: ${json.error ?? "error desconocido"}`);
        }
      } catch (e: any) {
        alert(`⚠️ Error de red al registrar embarque: ${e.message}`);
      }
    }
    playBeep(fueraLista ? "warn" : "ok");

    // Mostrar tarjeta resultado con barra de progreso (3 s)
    if (resultIntervalRef.current) clearInterval(resultIntervalRef.current);
    setResultadoEmbarque({ pasajero, fueraLista });
    setResultProgreso(0);
    let prog = 0;
    resultIntervalRef.current = setInterval(() => {
      prog++;
      setResultProgreso(prog);
      if (prog >= 100) {
        clearInterval(resultIntervalRef.current!);
        resultIntervalRef.current = null;
        setResultadoEmbarque(null);
        setResultProgreso(0);
      }
    }, 30); // 100 pasos × 30 ms = 3 000 ms
  }

  async function notificarRetraso() {
    if (!reservaActiva) { alert("No hay reserva activa"); return; }
    const res = await fetch("/api/conductor-alerta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reserva_id: reservaActiva.id,
        lat:        posRef.current?.coords.latitude  ?? null,
        lng:        posRef.current?.coords.longitude ?? null,
        motivo:     `Retraso reportado — en ruta a ${paradas[paradaIdx]?.nombre || "siguiente parada"}`,
        estado:     "pendiente",
      }),
    });
    const json = await res.json();
    if (!res.ok) { alert(`Error al notificar retraso: ${json.error}`); return; }
    setNotifEnviada(true);
    setTimeout(() => setNotifEnviada(false), 5000);
  }

  // ─── INCIDENCIA ────────────────────────────────────────────────────────────

  async function enviarIncidencia() {
    if (!conductor) return;
    if (!incTipo) { alert("Selecciona el tipo de incidencia"); return; }
    const desc = incDesc.trim();
    if (!desc) { alert("Ingresa una descripción de la incidencia"); return; }
    setIncSaving(true);

    const retrasoTxt = incRetraso ? ` (retraso estimado: ${Number(incRetraso)} min)` : "";
    const paradaNombre = paradas[paradaIdx]?.nombre || null;

    try {
      await condApi("incidencia", { incidencia: {
        conductor_id: conductor.id,
        vehiculo_id:  vehiculoId,
        reserva_id:   reservaActiva?.id || null,
        tipo:         incTipo,
        severidad:    incSev,
        descripcion:  desc + retrasoTxt,
        ubicacion:    paradaNombre,
        lat:          posRef.current?.coords.latitude || null,
        lng:          posRef.current?.coords.longitude || null,
        // estado: usa default 'reportado'
        // id: auto-generado INC-YYYY-NNNN
      } });
    } catch (e: any) {
      setIncSaving(false);
      setBoardingMsg({ ok: false, msg: `Error: ${e?.message}` });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }
    setIncSaving(false);
    setShowIncidencia(false);
    setIncTipo(null); setIncSev("medio"); setIncDesc(""); setIncRetraso("");
    setBoardingMsg({ ok: true, msg: "Incidencia reportada a operaciones" });
    setTimeout(() => setBoardingMsg(null), 3000);
  }

  // ─── NAV (Waze / Google Maps) ───────────────────────────────────────────────

  function abrirWaze(parada: Parada) {
    let url: string;
    if (parada.lat && parada.lng) {
      url = `https://waze.com/ul?ll=${parada.lat},${parada.lng}&navigate=yes&zoom=17`;
    } else if (parada.direccion) {
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.direccion)}&navigate=yes`;
    } else {
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.nombre + ", Lima, Peru")}&navigate=yes`;
    }
    window.open(url, "_blank");
  }

  function abrirGoogleMaps(parada: Parada) {
    let dest: string;
    if (parada.lat && parada.lng) dest = `${parada.lat},${parada.lng}`;
    else if (parada.direccion) dest = encodeURIComponent(parada.direccion);
    else dest = encodeURIComponent(parada.nombre + ", Lima, Peru");
    const origin = posRef.current
      ? `&origin=${posRef.current.coords.latitude},${posRef.current.coords.longitude}`
      : "";
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}${origin}&travelmode=driving`, "_blank");
  }

  // ─── Checklist ──────────────────────────────────────────────────────────────

  async function guardarChecklist() {
    if (!conductor) return;
    if (!vehiculoId) { alert("Selecciona el vehículo antes de iniciar el viaje"); return; }
    if (checks.some(c => c.ok === null)) {
      alert(`Faltan ${checks.filter(c => c.ok === null).length} ítems por completar`); return;
    }
    setCheckSaving(true);
    try {
      await condApi("checklist", { checklist: {
        conductor_id: conductor.id,
        vehiculo_id:  vehiculoId,
        fecha:        getFechaLocal(),
        items_json:   checks,
        km_inicio:    kmInicio ? Number(kmInicio) : null,
        observaciones: checkObs,
        estado:       checks.some(c => c.ok === false) ? "con_fallas" : "ok",
      } });
    } catch (e: any) {
      setCheckSaving(false);
      alert(`Error al guardar checklist: ${e?.message}`); return;
    }
    setCheckSaving(false);
    setCheckDone(true);
  }

  // ─── Docs ───────────────────────────────────────────────────────────────────

  async function subirDoc() {
    if (!conductor) return;
    if (!docUrl.trim()) { alert("Ingresa la URL del documento antes de registrar"); return; }
    setDocSaving(true);
    let data: any = null;
    try {
      const r = await condApi("documento", { documento: {
        conductor_id: conductor.id,
        tipo:         docTipo,
        url:          docUrl.trim(),
        nombre:       docTipo,
        vencimiento:  docVenc || null,
      } });
      data = r.documento;
    } catch (e: any) {
      setDocSaving(false);
      alert(`Error al registrar documento: ${e?.message}`); return;
    }
    setDocSaving(false);
    if (data) setDocs(prev => [data, ...prev]);
    setDocUrl(""); setDocVenc("");
  }

  // ─── Cambiar PIN ────────────────────────────────────────────────────────────

  async function cambiarPin() {
    if (pinNuevo.length < 4 || pinNuevo !== pinConfirm) { setPinMsg("PINs no coinciden"); return; }
    if (!conductor) return;
    try {
      await condApi("cambiar_pin", { cid: conductor.id, tabla: conductor._tabla, pin: pinNuevo });
    } catch (e: any) { setPinMsg(`Error: ${e?.message}`); setTimeout(() => setPinMsg(""), 4000); return; }
    const upd = { ...conductor, pin_acceso: pinNuevo };
    saveSession(upd); setConductor(upd);
    setPinMsg("PIN cambiado"); setPinNuevo(""); setPinConfirm("");
    setTimeout(() => { setPinMsg(""); setCamPin(false); }, 2000);
  }

  function cerrarSesion() {
    if (enRuta && !confirm("Tienes un recorrido activo. ¿Salir igual?")) return;
    cleanup(); clearSession(); setConductor(null);
    setEnRuta(false); setDni(""); setPin(""); setTab("ruta");
  }

  // ─── DERIVADOS ──────────────────────────────────────────────────────────────

  const vehSel        = vehiculos.find(v => v.id === vehiculoId);
  const paradaActual  = paradas[paradaIdx];
  const pasParada     = pasajeros.filter(p => p.parada_id === paradaActual?.id);
  const embarcados    = pasParada.filter(p => p.estado === "embarcado").length;
  const checkPct      = Math.round((checks.filter(c => c.ok !== null).length / checks.length) * 100);
  const checkFallas   = checks.filter(c => c.ok === false).length;
  const categorias    = Array.from(new Set(CHECKLIST_ITEMS.map(i => i.categoria)));
  const docsBadge     = docs.filter(d => docEstado(d.vencimiento) === "vencido").length;

  const proximaReserva = !enRuta ? reservasHoy.find(r => (minutosAlServicio(r.hora_servicio) ?? -1) >= 0) : null;
  const minsHastaProx  = proximaReserva ? minutosAlServicio(proximaReserva.hora_servicio) : null;
  void tick; // forzar re-render con el setInterval del minuto

  const totalReservados = pasajeros.length;
  const totalEmbarcados = pasajeros.filter(p => p.estado === "embarcado").length;
  const totalEsperando  = pasajeros.filter(p => p.estado === "esperando" || !p.estado).length;
  const totalNoShow     = pasajeros.filter(p => p.estado === "no_show").length;

  // ═══════════════════════════════════════════════════════════════════════════
  // LOADING
  // ═══════════════════════════════════════════════════════════════════════════

  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--c-navy)", fontFamily: FONT_SANS }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 40, height: 40, border: "4px solid rgba(255,255,255,0.3)", borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }} />
        <p style={{ color: "white", fontSize: 14, margin: 0 }}>Cargando…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════════════════════════

  if (!conductor) return (
    <div style={{
      minHeight: "100svh", background: "var(--c-paper)", fontFamily: FONT_SANS,
      display: "flex", flexDirection: "column", alignItems: "center",
      boxSizing: "border-box", overflowX: "hidden",
    }}>
      <div style={{
        width: "100%", maxWidth: 480, padding: "48px 20px 24px",
        boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center",
      }}>
        {/* ── Logo AFA Conductores ── */}
        <img
          src="/afaconductorsinfondo.png"
          alt="AFA Conductor"
          style={{ width: "min(220px, 55vw)", display: "block", marginBottom: 28 }}
        />
        <h1 style={{
          fontFamily: FONT_SANS, fontSize: "clamp(20px, 5vw, 26px)", fontWeight: 800, letterSpacing: -0.8,
          color: "var(--c-ink)", margin: "0 0 6px", textAlign: "center",
        }}>
          Buen día, conductor.
        </h1>
        <p style={{ color: "var(--c-mute)", fontSize: "clamp(13px, 3.5vw, 15px)", fontWeight: 500, margin: 0, textAlign: "center" }}>
          Ingresa con tu DNI y PIN personal para abrir tu jornada.
        </p>
      </div>

      {/* ── Card ── */}
      <div style={{
        width: "100%", maxWidth: 480, boxSizing: "border-box",
        padding: "0 16px 32px",
      }}>
        <div style={{
          background: "var(--c-surface)", border: "1px solid var(--c-line)",
          borderRadius: 22, padding: "20px 20px 24px",
          boxShadow: "0 4px 14px rgba(0,0,0,0.05)", boxSizing: "border-box",
        }}>
          {/* DNI */}
          <Eyebrow>Documento de identidad</Eyebrow>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 10, marginTop: 8,
            borderBottom: `1.5px solid ${dni.length >= 7 ? "var(--c-navy)" : "var(--c-line)"}`,
            paddingBottom: 8,
          }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 15, color: "var(--c-mute)", flexShrink: 0 }}>PE</span>
            <input
              type="tel" inputMode="numeric" maxLength={8} value={dni}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 8);
                setDni(val);
                setLoginErr("");
                if (val.length === 8) setTimeout(() => pinInputRef.current?.focus(), 80);
              }}
              placeholder="12345678"
              style={{
                flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
                fontFamily: FONT_MONO, fontSize: "clamp(22px, 6vw, 28px)", fontWeight: 800, letterSpacing: 4,
                color: "var(--c-ink)",
              }}
            />
            <span style={{
              fontSize: 11, fontWeight: 600, color: "var(--c-mute)",
              background: "var(--c-soft)", borderRadius: 6, padding: "2px 7px", flexShrink: 0,
            }}>
              8 díg.
            </span>
          </div>

          {/* PIN */}
          <div style={{ marginTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <Eyebrow>PIN de acceso</Eyebrow>
              <span style={{
                fontSize: 11, fontWeight: 600, color: "var(--c-mute)",
                background: "var(--c-soft)", borderRadius: 6, padding: "2px 7px",
              }}>
                4 díg.
              </span>
            </div>
            <div style={{
              padding: "6px 4px 12px",
              borderBottom: `1.5px solid ${pin.length === 4 ? "var(--c-navy)" : "var(--c-line)"}`,
              marginBottom: 18,
              transition: "border-color 0.2s",
            }}>
              <input
                ref={pinInputRef}
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                autoComplete="one-time-code"
                placeholder="••••"
                onChange={e => {
                  const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                  setPin(val);
                  setLoginErr("");
                  if (val.length === 4) setTimeout(() => login(), 120);
                }}
                onKeyDown={e => e.key === "Enter" && login()}
                style={{
                  fontFamily: FONT_MONO, fontSize: 32, fontWeight: 700,
                  color: "var(--c-ink)", letterSpacing: 10,
                  width: "100%", border: "none", outline: "none",
                  background: "transparent",
                }}
              />
            </div>
          </div>

          {/* Error */}
          {loginErr && (
            <div style={{
              marginTop: 14,
              background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
              borderRadius: 12, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <IconCircleAlert size={16} color="var(--c-danger)" />
              <span style={{ color: "var(--c-danger)", fontSize: 13, fontWeight: 600 }}>{loginErr}</span>
            </div>
          )}

          {/* Botón */}
          <div style={{ marginTop: 18 }}>
            <PrimaryBtn
              onClick={login}
              disabled={loginLoading || dni.length < 7 || pin.length < 4}
              icon={<IconArrowRight size={18} color="#fff" />}
              size="lg"
            >
              {loginLoading ? "Verificando…" : "Ingresar"}
            </PrimaryBtn>
          </div>
        </div>

        {/* ── Beneficios ── */}
        <div style={{ marginTop: 28 }}>
          <p style={{
            margin: "0 0 14px", textAlign: "center",
            fontSize: 10, fontWeight: 700, letterSpacing: 1.4,
            textTransform: "uppercase", color: "var(--c-mute)",
          }}>
            Tu jornada en una app
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              {
                icon: <IconRoute size={22} color="var(--c-navy)" />,
                titulo: "Ruta en vivo",
                sub: "GPS y paradas",
              },
              {
                icon: <IconScan size={22} color="var(--c-navy)" />,
                titulo: "Escanear QR",
                sub: "Embarque rápido",
              },
              {
                icon: <IconShield size={22} color="var(--c-navy)" />,
                titulo: "Pre-viaje",
                sub: "Checklist seguro",
              },
            ].map(b => (
              <div key={b.titulo} style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 16, padding: "14px 10px 12px",
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 8, textAlign: "center",
                boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 13,
                  background: "var(--c-navy-tint)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {b.icon}
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "var(--c-ink)", lineHeight: 1.2 }}>
                    {b.titulo}
                  </p>
                  <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--c-mute)", fontWeight: 500 }}>
                    {b.sub}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Soporte */}
        <p style={{ margin: "24px 0 32px", color: "var(--c-mute)", fontSize: 12, textAlign: "center", fontFamily: FONT_SANS }}>
          ¿Problemas para entrar? Llama a soporte ·{" "}
          <a href="tel:966707225" style={{ color: "var(--c-navy)", fontWeight: 700, textDecoration: "none" }}>
            966 707 225
          </a>
        </p>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SHELL PRINCIPAL
  // ═══════════════════════════════════════════════════════════════════════════

  const TABS: TabItem<Tab>[] = [
    { id: "ruta",       label: "Hoy",       icon: <IconCalendar size={20} /> },
    { id: "paradas",    label: "Ruta",      icon: <IconRoute size={20} />, badge: enRuta && paradaActual ? true : false },
    { id: "checklist",  label: "Pre-viaje", icon: <IconShield size={20} />, badge: !checkDone },
    { id: "documentos", label: "Docs",      icon: <IconReceipt size={20} />, badge: docsBadge > 0 },
    { id: "perfil",     label: "Perfil",    icon: <IconUser size={20} /> },
  ];

  const titulo = fechaTitulo();

  return (
    <div style={{
      minHeight: "100vh", background: "var(--c-paper)",
      fontFamily: FONT_SANS, color: "var(--c-ink)",
      display: "flex", flexDirection: "column",
      maxWidth: 520, margin: "0 auto",
    }}>

      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 30,
        background: "var(--c-paper)",
        padding: "14px 18px 10px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid var(--c-line-2)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12,
            background: "var(--c-navy)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 800, fontSize: 14, letterSpacing: -0.4,
          }}>
            {ini(conductor.nombre)}
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 800, fontSize: 14, color: "var(--c-ink)", lineHeight: 1.1 }}>
              {conductor.nombre.split(" ").slice(0, 2).join(" ")}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <StatusDot color={enRuta ? "var(--c-success)" : "var(--c-mute-2)"} pulse={enRuta} size={6} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-mute)" }}>
                {enRuta ? "En servicio" : "Disponible"}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {enRuta && vehSel && (
            <Chip color="var(--c-ink)" bg="var(--c-soft)" mono sw>
              {vehSel.placa}
            </Chip>
          )}
          {enRuta && velocidad > 0 && (
            <Chip color="var(--c-success)" bg="var(--c-success-tint)" mono sw>
              {velocidad} KM/H
            </Chip>
          )}
        </div>
      </header>

      {/* ── CONTENIDO ────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: "auto", paddingBottom: 90 }}>

        {/* ═══ HOY ═══ */}
        {tab === "ruta" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>{titulo.dow}</Eyebrow>
            <h1 style={{
              fontFamily: FONT_SANS, fontSize: 32, fontWeight: 800, letterSpacing: -1.1,
              color: "var(--c-ink)", margin: "4px 0 18px",
            }}>
              {titulo.fecha}
            </h1>

            {/* Banner pre-viaje pendiente */}
            {!checkDone && (
              <button
                onClick={() => setTab("checklist")}
                style={{
                  width: "100%", textAlign: "left",
                  background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 14, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10, fontFamily: FONT_SANS,
                }}
              >
                <IconShield size={20} color="var(--c-warn)" />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, color: "var(--c-warn)", fontWeight: 800, fontSize: 13 }}>
                    Pre-viaje pendiente
                  </p>
                  <p style={{ margin: "2px 0 0", color: "#92400E", fontSize: 11 }}>
                    Completa la inspección antes de iniciar
                  </p>
                </div>
                <IconChevronRight size={16} color="var(--c-warn)" />
              </button>
            )}

            {/* Alerta licencia */}
            {conductor.vencimiento_licencia && (diasPara(conductor.vencimiento_licencia) ?? 999) <= 60 && (
              <div style={{
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                borderRadius: 14, padding: "12px 14px", marginBottom: 14,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconAlert size={18} color="var(--c-danger)" />
                <p style={{ margin: 0, color: "var(--c-danger)", fontWeight: 800, fontSize: 13 }}>
                  {(diasPara(conductor.vencimiento_licencia) ?? 0) < 0
                    ? "Licencia VENCIDA"
                    : `Licencia vence en ${diasPara(conductor.vencimiento_licencia)} días`}
                </p>
              </div>
            )}

            {/* Estado GPS — visible si hay error de ubicación (permiso/aparato) */}
            {gpsError && (
              <div style={{
                background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                borderRadius: 14, padding: "12px 14px", marginBottom: 14,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconPin size={18} color="var(--c-warn)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, color: "var(--c-warn)", fontWeight: 800, fontSize: 13 }}>Ubicación: {gpsError}</p>
                  <p style={{ margin: "2px 0 0", color: "#92400E", fontSize: 11 }}>
                    Activa el GPS del teléfono y concede el permiso de ubicación.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    setGpsError(null);
                    const p = await pedirPermisoUbicacion();
                    if (p === "granted") {
                      try {
                        const pos = await obtenerUbicacion({ enableHighAccuracy: true, timeout: 15000 });
                        posRef.current = pos; setPosActual(pos); enviarUbicacion(pos);
                      } catch (e: any) { setGpsError(e?.message ?? "No se pudo obtener la ubicación"); }
                    } else {
                      setGpsError(p === "denied" ? "Permiso denegado" : "GPS no disponible");
                    }
                  }}
                  style={{ flexShrink: 0, background: "var(--c-warn)", border: "none", borderRadius: 10, padding: "8px 12px", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                  Activar
                </button>
              </div>
            )}

            {/* Hero card — próximo viaje (si no está en ruta) */}
            {!enRuta && proximaReserva && (
              <div style={{
                background: "var(--c-navy)", color: "#fff",
                borderRadius: 22, padding: 20, marginBottom: 14,
                boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <StatusDot color="rgba(255,255,255,0.8)" pulse size={6} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
                    Próximo viaje · sale en
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 40, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1,
                  }}>
                    {minsHastaProx !== null ? fmtCountdown(minsHastaProx) : "—"}
                  </span>
                  {proximaReserva.hora_servicio && (
                    <Chip color="#fff" bg="rgba(255,255,255,0.14)" mono sw>
                      {proximaReserva.hora_servicio.slice(0, 5)}
                    </Chip>
                  )}
                </div>

                <div style={{
                  margin: "16px 0", height: 1, background: "rgba(255,255,255,0.12)",
                }} />

                <p style={{
                  margin: "0 0 4px", fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
                  textTransform: "uppercase", color: "rgba(255,255,255,0.6)",
                }}>
                  Recorrido
                </p>
                <p style={{
                  margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.2,
                }}>
                  {proximaReserva.origen} → {proximaReserva.destino}
                </p>

                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 16, marginBottom: 16,
                }}>
                  {[
                    { lbl: "Reservas", val: String(reservasHoy.length) },
                    { lbl: "Vehículo", val: vehSel?.placa || "—", mono: true },
                    { lbl: "Hora",     val: proximaReserva.hora_servicio?.slice(0, 5) || "—", mono: true },
                  ].map(s => (
                    <div key={s.lbl}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                        {s.lbl}
                      </p>
                      <p style={{ margin: "4px 0 0", fontFamily: s.mono ? FONT_MONO : FONT_SANS, fontSize: 14, fontWeight: 700, letterSpacing: -0.2 }}>
                        {s.val}
                      </p>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => !checkDone ? setTab("checklist") : iniciarRecorrido(proximaReserva)}
                  disabled={iniciando}
                  style={{
                    width: "100%", padding: "14px 0", borderRadius: 14, border: "none",
                    background: "#fff", color: "var(--c-navy)",
                    fontFamily: FONT_SANS, fontWeight: 800, fontSize: 15,
                    cursor: iniciando ? "not-allowed" : "pointer",
                    opacity: iniciando ? 0.5 : 1,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    letterSpacing: -0.2,
                  }}
                >
                  {iniciando
                    ? <>Iniciando…</>
                    : !checkDone
                      ? <><IconShield size={17} color="var(--c-navy)" /> Iniciar pre-viaje</>
                      : <><IconPlay size={16} color="var(--c-navy)" /> Iniciar recorrido</>}
                </button>
              </div>
            )}

            {/* Hero card — viaje en curso */}
            {enRuta && reservaActiva && (
              <div style={{
                background: "var(--c-navy)", color: "#fff",
                borderRadius: 22, padding: 20, marginBottom: 14,
                boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <StatusDot color="var(--c-success)" pulse size={7} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
                    En curso · {paradaIdx + 1} de {paradas.length} paradas
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: -0.4 }}>
                  {reservaActiva.origen} → {reservaActiva.destino}
                </p>
                <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
                  Inicio: {inicioViaje?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—"}
                  {inicioViaje && ` · ${fmtDuracion(Date.now() - inicioViaje.getTime())} en ruta`}
                </p>
                <div style={{ marginTop: 14 }}>
                  <SecondaryBtn
                    onClick={() => setTab("paradas")}
                    icon={<IconRoute size={17} color="var(--c-navy)" />}
                  >
                    Ver paradas
                  </SecondaryBtn>
                </div>
              </div>
            )}

            {/* Selector vehículo */}
            {!enRuta && (
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 18, padding: 16, marginBottom: 14,
              }}>
                <Eyebrow><IconBus size={11} color="var(--c-mute)" /> &nbsp;Vehículo asignado</Eyebrow>
                <select
                  value={vehiculoId || ""}
                  onChange={e => setVehiculoId(Number(e.target.value) || null)}
                  style={{
                    width: "100%", marginTop: 10, padding: "12px 14px",
                    borderRadius: 12, border: `1.5px solid ${vehiculoId ? "var(--c-navy)" : "var(--c-line)"}`,
                    fontFamily: FONT_SANS, fontSize: 14, fontWeight: 700,
                    color: "var(--c-ink)", background: "var(--c-surface)", outline: "none",
                    boxSizing: "border-box",
                  }}
                >
                  <option value="">Seleccionar vehículo…</option>
                  {vehiculos.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.placa} — {v.categoria} {v.marca || ""}
                    </option>
                  ))}
                </select>
                {vehSel && (
                  <div style={{
                    marginTop: 10, padding: "10px 14px", borderRadius: 12,
                    background: "var(--c-soft)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ color: "var(--c-mute)", fontSize: 12, fontWeight: 500 }}>Placa</span>
                    <span style={{ fontFamily: FONT_MONO, color: "var(--c-navy)", fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>
                      {vehSel.placa}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Lista de servicios */}
            <Eyebrow style={{ marginBottom: 10 }}>Servicios programados</Eyebrow>

            {cargando ? (
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 16, padding: 24, textAlign: "center",
              }}>
                <div style={{ width: 28, height: 28, border: "3px solid var(--c-line)", borderTop: "3px solid var(--c-navy)", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 10px" }} />
                <p style={{ color: "var(--c-mute)", fontSize: 13, margin: 0 }}>Cargando servicios…</p>
              </div>
            ) : reservasHoy.length === 0 ? (
              <div style={{
                background: "var(--c-surface)", border: "1.5px dashed var(--c-line)",
                borderRadius: 16, padding: 28, textAlign: "center",
              }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 18,
                  background: "var(--c-navy-tint)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 12,
                }}>
                  <IconCalendar size={26} color="var(--c-navy)" />
                </div>
                <p style={{ color: "var(--c-ink)", fontWeight: 800, fontSize: 15, margin: 0 }}>
                  Sin servicios programados hoy
                </p>
                <p style={{ color: "var(--c-mute)", fontSize: 12, margin: "6px 0 14px", fontFamily: FONT_MONO }}>
                  {debugFecha}
                </p>
                {debugInfo && (
                  <p style={{ color: "var(--c-danger)", fontSize: 12, margin: "0 0 14px" }}>{debugInfo}</p>
                )}
                <SecondaryBtn
                  onClick={() => conductor && cargarDatos(conductor.id, conductor._tabla)}
                  icon={<IconRefresh size={16} color="var(--c-ink)" />}
                  full={false}
                >
                  Actualizar
                </SecondaryBtn>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {reservasHoy.map(r => {
                  const esActiva = reservaActiva?.id === r.id;
                  return (
                    <div
                      key={r.id}
                      style={{
                        background: "var(--c-surface)",
                        border: esActiva ? "2px solid var(--c-navy)" : "1px solid var(--c-line)",
                        borderRadius: 16, padding: 14,
                        boxShadow: esActiva ? "0 4px 14px rgba(11,49,95,0.12)" : "0 1px 3px rgba(0,0,0,0.03)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                        <div>
                          <p style={{ margin: 0, fontWeight: 800, fontSize: 16, letterSpacing: -0.3 }}>
                            {r.origen}
                          </p>
                          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--c-mute)" }}>
                            → {r.destino}
                          </p>
                        </div>
                        {esActiva ? (
                          <Chip color="#fff" bg="var(--c-navy)" sw>EN RUTA</Chip>
                        ) : r.hora_servicio ? (
                          <Chip color="var(--c-navy)" bg="var(--c-navy-tint)" mono sw>
                            {r.hora_servicio.slice(0, 5)}
                          </Chip>
                        ) : null}
                      </div>

                      {esActiva ? (
                        <PrimaryBtn
                          onClick={() => setTab("paradas")}
                          icon={<IconRoute size={16} color="#fff" />}
                        >
                          Ver recorrido
                        </PrimaryBtn>
                      ) : (
                        <PrimaryBtn
                          onClick={() => iniciarRecorrido(r)}
                          disabled={iniciando}
                          icon={<IconPlay size={15} color="#fff" />}
                        >
                          {iniciando ? "Iniciando…" : "Iniciar recorrido"}
                        </PrimaryBtn>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Stats GPS si en ruta */}
            {enRuta && (
              <div style={{
                marginTop: 16, background: "var(--c-surface)",
                border: "1px solid var(--c-line)", borderRadius: 16, padding: 14,
              }}>
                <Eyebrow style={{ marginBottom: 10 }}>Sesión GPS</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { lbl: "Velocidad",    val: `${velocidad}`, suf: "km/h", mono: true, color: "var(--c-navy)" },
                    { lbl: "Envíos GPS",   val: String(totalEnvios), mono: true, color: "var(--c-success)" },
                    { lbl: "Último envío", val: ultimoEnvio?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—", mono: true },
                    { lbl: "Precisión",    val: posActual ? `±${Math.round(posActual.coords.accuracy)}` : "—", suf: "m", mono: true },
                  ].map(s => (
                    <div key={s.lbl} style={{ background: "var(--c-soft)", borderRadius: 12, padding: "10px 12px" }}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                        {s.lbl}
                      </p>
                      <p style={{
                        margin: "4px 0 0",
                        fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                        fontSize: 18, fontWeight: 800, letterSpacing: -0.3,
                        color: s.color || "var(--c-ink)",
                      }}>
                        {s.val}{s.suf && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-mute)", marginLeft: 4 }}>{s.suf}</span>}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ═══ PARADAS (En ruta) ═══ */}
        {tab === "paradas" && (
          <section style={{ padding: "16px 18px 0" }}>
            {!enRuta ? (
              <div style={{
                background: "var(--c-surface)", border: "1.5px dashed var(--c-line)",
                borderRadius: 16, padding: 36, textAlign: "center",
              }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 22,
                  background: "var(--c-navy-tint)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14,
                }}>
                  <IconRoute size={30} color="var(--c-navy)" />
                </div>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Aún no iniciaste ningún viaje</p>
                <p style={{ margin: "6px 0 16px", color: "var(--c-mute)", fontSize: 13 }}>
                  Andá a “Hoy” y comenzá el recorrido desde ahí.
                </p>
                <SecondaryBtn
                  onClick={() => setTab("ruta")}
                  icon={<IconArrowLeft size={16} color="var(--c-ink)" />}
                  full={false}
                >
                  Ir a Hoy
                </SecondaryBtn>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <Eyebrow>En ruta · {reservaActiva?.origen} → {reservaActiva?.destino}</Eyebrow>
                    <h2 style={{
                      margin: "4px 0 0", fontSize: 22, fontWeight: 800, letterSpacing: -0.6,
                    }}>
                      Recorrido
                    </h2>
                  </div>
                  <button
                    onClick={() => setShowManifiesto(true)}
                    style={{
                      background: "var(--c-soft)", border: "1px solid var(--c-line)",
                      borderRadius: 12, padding: "8px 12px", cursor: "pointer",
                      fontFamily: FONT_SANS, fontWeight: 700, fontSize: 12,
                      color: "var(--c-ink)",
                      display: "inline-flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <IconUsers size={14} />
                    Manifiesto
                  </button>
                </div>

                {/* Progreso */}
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 12,
                  display: "flex", alignItems: "center", gap: 12,
                }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                      Progreso
                    </p>
                    <div style={{ marginTop: 6, height: 5, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${(paradaIdx / Math.max(1, paradas.length)) * 100}%`,
                        background: "linear-gradient(90deg, var(--c-navy), var(--c-success))",
                        borderRadius: 3, transition: "width 0.5s",
                      }} />
                    </div>
                  </div>
                  <Chip color="var(--c-navy)" bg="var(--c-navy-tint)" mono sw>
                    {paradaIdx} / {paradas.length}
                  </Chip>
                </div>

                {/* Timeline */}
                <Eyebrow style={{ marginBottom: 10 }}>Paradas del recorrido</Eyebrow>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                  {paradas.map((p, i) => {
                    const esActual = i === paradaIdx;
                    const completada = p.estado === "completada";
                    const pp = pasajeros.filter(x => x.parada_id === p.id);
                    const emb = pp.filter(x => x.estado === "embarcado").length;
                    return (
                      <div
                        key={p.id}
                        style={{
                          background: esActual ? "var(--c-navy-tint)" : "var(--c-surface)",
                          border: esActual ? "2px solid var(--c-navy)" : "1px solid var(--c-line)",
                          borderRadius: 14, padding: esActual ? 16 : "12px 14px",
                          opacity: completada ? 0.7 : 1,
                          transition: "all 0.3s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%",
                            background: completada ? "var(--c-navy)" : esActual ? "var(--c-coral)" : "var(--c-soft)",
                            border: esActual ? "3px solid #fff" : "none",
                            boxShadow: esActual ? "0 0 0 2px var(--c-coral)" : "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0, color: "#fff",
                          }}>
                            {completada
                              ? <IconCheck size={14} color="#fff" sw={2.5} />
                              : esActual
                                ? <IconPin size={14} color="#fff" sw={2.2} />
                                : <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute-2)" }}>{i + 1}</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{
                              margin: 0, fontSize: esActual ? 15 : 14,
                              fontWeight: esActual ? 800 : 700, letterSpacing: -0.2,
                              color: completada ? "var(--c-mute)" : "var(--c-ink)",
                              textDecoration: completada ? "line-through" : "none",
                            }}>
                              {p.nombre}
                            </p>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                              {p.hora_estimada && (
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: "var(--c-mute)", fontWeight: 600 }}>
                                  {p.hora_estimada.slice(0, 5)}
                                </span>
                              )}
                              {pp.length > 0 && (
                                <span style={{ fontSize: 11, color: "var(--c-mute)", fontWeight: 600 }}>
                                  {emb}/{pp.length} pasajeros
                                </span>
                              )}
                            </div>
                          </div>
                          {completada
                            ? <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>Hecho</Chip>
                            : esActual
                              ? <Chip color="var(--c-coral)" bg="var(--c-coral-tint)" sw>Actual</Chip>
                              : null}
                        </div>

                        {/* Panel parada actual */}
                        {esActual && (
                          <div style={{ marginTop: 14 }}>
                            {/* Navegación */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                              <button
                                onClick={() => abrirWaze(p)}
                                style={{
                                  padding: "11px 0", borderRadius: 12, border: "none",
                                  background: "#33CCFF", color: "#0b1b2e",
                                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 13, cursor: "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="10" r="8" fill="#33CCFF" stroke="#0b1b2e" strokeWidth="1.5"/>
                                  <ellipse cx="12" cy="10" rx="5" ry="5" fill="white"/>
                                  <circle cx="10.2" cy="9" r="1.1" fill="#0b1b2e"/>
                                  <circle cx="13.8" cy="9" r="1.1" fill="#0b1b2e"/>
                                  <path d="M9.5 11.5 Q12 13.5 14.5 11.5" stroke="#0b1b2e" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
                                </svg>
                                Waze
                              </button>
                              <button
                                onClick={() => abrirGoogleMaps(p)}
                                style={{
                                  padding: "11px 0", borderRadius: 12, border: "1px solid var(--c-line)",
                                  background: "var(--c-surface)", color: "var(--c-ink)",
                                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 13, cursor: "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                              >
                                <svg width="14" height="16" viewBox="0 0 18 22" fill="none">
                                  <path d="M9 0C4.03 0 0 4.03 0 9c0 6.75 9 13 9 13s9-6.25 9-13c0-4.97-4.03-9-9-9z" fill="#EA4335"/>
                                  <circle cx="9" cy="9" r="3.5" fill="white"/>
                                </svg>
                                Maps
                              </button>
                            </div>

                            {pp.length > 0 && (
                              <div style={{
                                background: "var(--c-surface)", borderRadius: 12,
                                border: "1px solid var(--c-line-2)", padding: 10, marginBottom: 12,
                              }}>
                                <Eyebrow style={{ marginBottom: 8 }}>Esperan en esta parada</Eyebrow>
                                {pp.map(x => {
                                  const onBoard = x.estado === "embarcado";
                                  return (
                                    <div key={x.id} style={{
                                      display: "flex", alignItems: "center", gap: 10,
                                      padding: "8px 0",
                                      borderBottom: "1px solid var(--c-line-2)",
                                    }}>
                                      <div style={{
                                        width: 32, height: 32, borderRadius: 10,
                                        background: onBoard ? "var(--c-success-tint)" : "var(--c-soft)",
                                        color: onBoard ? "var(--c-success)" : "var(--c-mute)",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        fontFamily: FONT_SANS, fontWeight: 800, fontSize: 12,
                                        flexShrink: 0,
                                      }}>
                                        {x.pasajero?.nombre ? ini(x.pasajero.nombre) : "?"}
                                      </div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: -0.1 }}>
                                          {x.pasajero?.nombre || `Pasajero #${x.pasajero_id}`}
                                        </p>
                                        {x.pasajero?.dni && (
                                          <p style={{ margin: "2px 0 0", fontFamily: FONT_MONO, fontSize: 10, color: "var(--c-mute)", fontWeight: 600 }}>
                                            DNI {x.pasajero.dni}
                                          </p>
                                        )}
                                      </div>
                                      {onBoard
                                        ? <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>A bordo</Chip>
                                        : <Chip color="var(--c-warn)" bg="var(--c-warn-tint)" sw>Esperando</Chip>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                              <PrimaryBtn
                                onClick={() => setEscanear(true)}
                                icon={<IconScan size={16} color="#fff" />}
                              >
                                Escanear QR
                              </PrimaryBtn>
                              <SecondaryBtn
                                onClick={notificarRetraso}
                                disabled={notifEnviada}
                                icon={notifEnviada
                                  ? <IconCheck size={15} color="var(--c-success)" />
                                  : <IconClock size={15} color="var(--c-ink)" />
                                }
                              >
                                {notifEnviada ? "Notificado" : "Retraso"}
                              </SecondaryBtn>
                            </div>

                            <PrimaryBtn
                              onClick={() => marcarParadaCompletada(p.id)}
                              color={p.id === paradas[paradas.length - 1]?.id ? "var(--c-coral)" : "var(--c-navy)"}
                              icon={<IconCheck size={17} color="#fff" sw={2.5} />}
                              size="lg"
                            >
                              {p.id === paradas[paradas.length - 1]?.id ? "Marcar llegada · finalizar" : "Marcar llegada"}
                            </PrimaryBtn>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Reportar incidencia */}
                <button
                  onClick={() => setShowIncidencia(true)}
                  style={{
                    width: "100%", padding: "13px 0", borderRadius: 14,
                    background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                    color: "var(--c-warn)", fontFamily: FONT_SANS, fontWeight: 800, fontSize: 14,
                    cursor: "pointer", marginBottom: 10,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  }}
                >
                  <IconAlert size={16} color="var(--c-warn)" />
                  Reportar incidencia
                </button>

                {/* SOS */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ position: "relative", overflow: "hidden", borderRadius: 16 }}>
                    {sosActivo && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, height: "100%",
                        background: "rgba(0,0,0,0.3)", width: `${sosPct}%`, zIndex: 1, borderRadius: 16,
                      }} />
                    )}
                    <button
                      onMouseDown={iniciarSOS} onMouseUp={cancelarSOS}
                      onTouchStart={iniciarSOS} onTouchEnd={cancelarSOS}
                      style={{
                        width: "100%", padding: "16px 0", borderRadius: 16, border: "none",
                        background: sosEnviado ? "var(--c-success)" : sosActivo ? "#7F1D1D" : "var(--c-danger)",
                        color: "#fff", fontFamily: FONT_SANS, fontSize: 15, fontWeight: 800,
                        cursor: "pointer", position: "relative", zIndex: 2,
                        boxShadow: sosActivo ? "0 0 30px rgba(220,38,38,0.7)" : "none",
                        transition: "background 0.2s",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      }}
                    >
                      <IconBell size={17} color="#fff" />
                      {sosEnviado ? "SOS enviado — Central notificada" : sosActivo ? `Mantén presionado… ${Math.round(sosPct)}%` : "Emergencia / SOS"}
                    </button>
                  </div>
                  {!sosActivo && !sosEnviado && (
                    <p style={{ textAlign: "center", color: "var(--c-mute)", fontSize: 11, marginTop: 6 }}>
                      Mantén presionado 2 segundos para activar
                    </p>
                  )}
                </div>

                {/* Finalizar */}
                <SecondaryBtn
                  onClick={() => setShowFinViaje(true)}
                  icon={<IconStop size={14} color="var(--c-danger)" />}
                  style={{ borderColor: "var(--c-danger)", color: "var(--c-danger)" }}
                >
                  Finalizar recorrido
                </SecondaryBtn>
              </>
            )}
          </section>
        )}

        {/* ═══ CHECKLIST (PRE-VIAJE) ═══ */}
        {tab === "checklist" && (
          <section style={{ padding: "16px 18px 0" }}>
            <button
              onClick={() => setTab("ruta")}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                display: "inline-flex", alignItems: "center", gap: 6,
                color: "var(--c-mute)", fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                marginBottom: 8,
              }}
            >
              <IconArrowLeft size={14} color="var(--c-mute)" />
              Hoy
            </button>
            <Eyebrow>Antes de salir</Eyebrow>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
                Pre-viaje
              </h2>
              <Chip
                color={checkPct === 100 ? "var(--c-success)" : "var(--c-navy)"}
                bg={checkPct === 100 ? "var(--c-success-tint)" : "var(--c-navy-tint)"}
                mono sw
              >
                {checks.filter(c => c.ok !== null).length}/{checks.length} · {checkPct}%
              </Chip>
            </div>

            {checkDone ? (
              <div style={{
                background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                borderRadius: 18, padding: 28, textAlign: "center",
              }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 22,
                  background: "#fff",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14,
                }}>
                  <IconCheck size={36} color="var(--c-success)" sw={2.5} />
                </div>
                <p style={{ margin: 0, fontWeight: 800, fontSize: 18, letterSpacing: -0.4 }}>
                  Pre-viaje completado
                </p>
                <p style={{ margin: "6px 0 18px", color: "var(--c-mute)", fontSize: 13 }}>
                  La unidad fue inspeccionada y reportada al ERP.
                </p>
                <SecondaryBtn
                  onClick={() => { setCheckDone(false); setChecks(CHECKLIST_ITEMS.map(i => ({ ...i }))); }}
                  icon={<IconRefresh size={15} color="var(--c-ink)" />}
                  full={false}
                >
                  Hacer nuevo
                </SecondaryBtn>
              </div>
            ) : (
              <>
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 16, padding: 14, marginBottom: 12,
                }}>
                  <Eyebrow>Vehículo y kilometraje</Eyebrow>
                  <select
                    value={vehiculoId || ""}
                    onChange={e => setVehiculoId(Number(e.target.value) || null)}
                    style={{
                      width: "100%", marginTop: 8, padding: "12px 14px",
                      borderRadius: 12, border: "1.5px solid var(--c-line)",
                      fontFamily: FONT_SANS, fontSize: 13, fontWeight: 700,
                      color: "var(--c-ink)", background: "var(--c-surface)",
                      outline: "none", boxSizing: "border-box",
                    }}
                  >
                    <option value="">Seleccionar vehículo…</option>
                    {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria}</option>)}
                  </select>
                  <input
                    type="number" placeholder="Km de inicio (ej: 152430)" value={kmInicio}
                    onChange={e => setKmInicio(e.target.value)}
                    style={{
                      width: "100%", marginTop: 8, padding: "12px 14px",
                      borderRadius: 12, border: "1.5px solid var(--c-line)",
                      fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
                      color: "var(--c-ink)", outline: "none", boxSizing: "border-box",
                    }}
                  />
                </div>

                {/* Barra progreso */}
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 12,
                }}>
                  <div style={{ height: 6, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${checkPct}%`,
                      background: checkFallas > 0 ? "var(--c-warn)" : "var(--c-navy)",
                      borderRadius: 3, transition: "width 0.3s",
                    }} />
                  </div>
                  {checkFallas > 0 && (
                    <p style={{ margin: "8px 0 0", color: "var(--c-danger)", fontWeight: 700, fontSize: 12 }}>
                      {checkFallas} falla{checkFallas > 1 ? "s" : ""} detectada{checkFallas > 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                {/* Ítems por categoría */}
                {categorias.map(cat => (
                  <div
                    key={cat}
                    style={{
                      background: "var(--c-surface)", border: "1px solid var(--c-line)",
                      borderRadius: 16, padding: "12px 14px", marginBottom: 10,
                    }}
                  >
                    <Eyebrow style={{ marginBottom: 8 }}>{cat}</Eyebrow>
                    {checks.filter(c => c.categoria === cat).map(item => (
                      <div
                        key={item.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "10px 0", borderBottom: "1px solid var(--c-line-2)",
                        }}
                      >
                        <p style={{ flex: 1, margin: 0, fontSize: 13, color: "var(--c-ink-2)", fontWeight: 500 }}>
                          {item.label}
                        </p>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: true } : c))}
                            style={{
                              width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer",
                              background: item.ok === true ? "var(--c-success)" : "var(--c-soft)",
                              color: item.ok === true ? "#fff" : "var(--c-mute)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            title="OK"
                          >
                            <IconCheck size={16} color={item.ok === true ? "#fff" : "var(--c-mute)"} sw={2.5} />
                          </button>
                          <button
                            onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: false } : c))}
                            style={{
                              width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer",
                              background: item.ok === false ? "var(--c-danger)" : "var(--c-soft)",
                              color: item.ok === false ? "#fff" : "var(--c-mute)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            title="Falla"
                          >
                            <IconClose size={15} color={item.ok === false ? "#fff" : "var(--c-mute)"} sw={2.5} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                {checkFallas > 0 && (
                  <textarea
                    rows={3} value={checkObs}
                    placeholder="Describe las fallas detectadas…"
                    onChange={e => setCheckObs(e.target.value)}
                    style={{
                      width: "100%", marginBottom: 12, padding: 14, borderRadius: 14,
                      border: "1.5px solid var(--c-danger)",
                      fontFamily: FONT_SANS, fontSize: 13, color: "var(--c-ink)",
                      background: "var(--c-surface)", resize: "none", outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                )}

                <PrimaryBtn
                  onClick={guardarChecklist}
                  disabled={checkSaving}
                  icon={<IconCheck size={17} color="#fff" sw={2.5} />}
                  size="lg"
                >
                  {checkSaving ? "Guardando…" : "Iniciar viaje"}
                </PrimaryBtn>
              </>
            )}
          </section>
        )}

        {/* ═══ DOCUMENTOS ═══ */}
        {tab === "documentos" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>Mis documentos</Eyebrow>
            <h2 style={{ margin: "4px 0 16px", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
              Vigencia
            </h2>

            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: "12px 14px", marginBottom: 12,
            }}>
              <Eyebrow>Estado actual</Eyebrow>
              {[
                { label: "Licencia MTC",   icon: IconKey,     fecha: conductor.vencimiento_licencia || null },
                { label: "SCTR Salud",     icon: IconShield,  fecha: conductor.sctr_salud_venc || null },
                { label: "Examen médico",  icon: IconReceipt, fecha: conductor.examen_medico_venc || null },
              ].map(d => {
                const est = docEstado(d.fecha);
                const dias = diasPara(d.fecha);
                const cfg = {
                  ok:      { color: "var(--c-success)", bg: "var(--c-success-tint)", txt: dias !== null ? `${dias}d` : "OK" },
                  pronto:  { color: "var(--c-warn)",    bg: "var(--c-warn-tint)",    txt: `${dias}d` },
                  vencido: { color: "var(--c-danger)",  bg: "var(--c-danger-tint)",  txt: "Vencida" },
                  sin:     { color: "var(--c-mute)",    bg: "var(--c-soft)",         txt: "Sin fecha" },
                }[est];
                const Ico = d.icon;
                return (
                  <div
                    key={d.label}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 0", borderBottom: "1px solid var(--c-line-2)",
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 12,
                      background: cfg.bg, color: cfg.color,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Ico size={18} color={cfg.color} />
                    </div>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--c-ink-2)" }}>
                      {d.label}
                    </span>
                    <Chip color={cfg.color} bg={cfg.bg} sw>{cfg.txt}</Chip>
                  </div>
                );
              })}
            </div>

            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 14, marginBottom: 12,
            }}>
              <Eyebrow>Registrar documento (URL)</Eyebrow>
              <select
                value={docTipo} onChange={e => setDocTipo(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontSize: 13, color: "var(--c-ink)",
                  outline: "none", boxSizing: "border-box", fontFamily: FONT_SANS, fontWeight: 600,
                }}
              >
                {TIPOS_DOC.map(t => <option key={t}>{t}</option>)}
              </select>
              <input
                placeholder="URL del documento (Drive, Dropbox…)" value={docUrl}
                onChange={e => setDocUrl(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontSize: 13, color: "var(--c-ink)",
                  outline: "none", boxSizing: "border-box", fontFamily: FONT_SANS,
                }}
              />
              <input
                type="date" value={docVenc} onChange={e => setDocVenc(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontFamily: FONT_MONO, fontSize: 13,
                  color: "var(--c-ink)", outline: "none", boxSizing: "border-box", marginBottom: 10,
                }}
              />
              <PrimaryBtn
                onClick={subirDoc}
                disabled={docSaving}
                icon={<IconArrowRight size={15} color="#fff" />}
              >
                {docSaving ? "Guardando…" : "Registrar"}
              </PrimaryBtn>
            </div>

            {docs.map(d => (
              <div
                key={d.id}
                style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 8,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: -0.1 }}>{d.tipo}</p>
                  {d.vencimiento && (
                    <p style={{
                      margin: "2px 0 0", fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
                      color: docEstado(d.vencimiento) === "vencido" ? "var(--c-danger)" : "var(--c-mute)",
                    }}>
                      Vence {new Date(d.vencimiento + "T00:00:00").toLocaleDateString("es-PE")}
                    </p>
                  )}
                </div>
                <a
                  href={d.url} target="_blank" rel="noreferrer"
                  style={{
                    padding: "6px 12px", borderRadius: 10, border: "1px solid var(--c-navy)",
                    color: "var(--c-navy)", fontSize: 12, fontWeight: 700, textDecoration: "none",
                    fontFamily: FONT_SANS,
                  }}
                >
                  Ver →
                </a>
              </div>
            ))}
          </section>
        )}

        {/* ═══ PERFIL ═══ */}
        {tab === "perfil" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>Mi cuenta</Eyebrow>
            <h2 style={{ margin: "4px 0 16px", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
              Perfil
            </h2>

            {/* Tarjeta identidad navy */}
            <div style={{
              background: "var(--c-navy)", color: "#fff",
              borderRadius: 22, padding: 20, marginBottom: 14, position: "relative", overflow: "hidden",
              boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
            }}>
              <div style={{
                position: "absolute", right: -10, top: -10, opacity: 0.08,
              }}>
                <IconBus size={120} color="#fff" />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative" }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 18,
                  background: "rgba(255,255,255,0.15)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 22, letterSpacing: -0.5,
                }}>
                  {ini(conductor.nombre)}
                </div>
                <div>
                  <p style={{ margin: 0, fontWeight: 800, fontSize: 19, letterSpacing: -0.4 }}>
                    {conductor.nombre}
                  </p>
                  <p style={{ margin: "4px 0 0", color: "rgba(255,255,255,0.65)", fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600 }}>
                    DNI {conductor.dni}
                  </p>
                  {conductor.categoria_licencia && (
                    <Chip color="#fff" bg="rgba(255,255,255,0.14)" sw style={{ marginTop: 6 }}>
                      Cat. {conductor.categoria_licencia}
                    </Chip>
                  )}
                </div>
              </div>
            </div>

            {/* Stats sesión */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14,
            }}>
              {[
                { lbl: "Envíos GPS", val: String(totalEnvios), mono: true },
                { lbl: "Reservas",   val: String(reservasHoy.length), mono: true },
                { lbl: "Fecha",      val: debugFecha, mono: true, sm: true },
              ].map(s => (
                <div
                  key={s.lbl}
                  style={{
                    background: "var(--c-surface)", border: "1px solid var(--c-line)",
                    borderRadius: 14, padding: "10px 12px",
                  }}
                >
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                    {s.lbl}
                  </p>
                  <p style={{
                    margin: "4px 0 0",
                    fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                    fontSize: s.sm ? 12 : 18, fontWeight: 800, letterSpacing: -0.3,
                    color: "var(--c-navy)",
                  }}>
                    {s.val}
                  </p>
                </div>
              ))}
            </div>

            {/* Cambiar PIN */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 14, marginBottom: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 12,
                    background: "var(--c-navy-tint)", color: "var(--c-navy)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <IconKey size={18} color="var(--c-navy)" />
                  </div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Cambiar PIN</p>
                </div>
                <button
                  onClick={() => setCamPin(v => !v)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--c-navy)", fontWeight: 700, fontSize: 13, fontFamily: FONT_SANS,
                  }}
                >
                  {camPin ? "Cancelar" : "Cambiar"}
                </button>
              </div>
              {camPin && (
                <div style={{ marginTop: 12 }}>
                  {["Nuevo PIN", "Confirmar PIN"].map((ph, i) => (
                    <input
                      key={i} type="password" inputMode="numeric" maxLength={4}
                      placeholder={ph}
                      value={i === 0 ? pinNuevo : pinConfirm}
                      onChange={e =>
                        i === 0
                          ? setPinNuevo(e.target.value.replace(/\D/g, "").slice(0, 4))
                          : setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 4))
                      }
                      style={{
                        width: "100%", padding: 12, borderRadius: 12, marginBottom: 8,
                        border: "1.5px solid var(--c-line)",
                        fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: 6,
                        textAlign: "center",
                        color: "var(--c-ink)", outline: "none", boxSizing: "border-box",
                      }}
                    />
                  ))}
                  {pinMsg && (
                    <p style={{
                      color: pinMsg.toLowerCase().includes("pin cambiado") ? "var(--c-success)" : "var(--c-danger)",
                      fontWeight: 700, textAlign: "center", fontSize: 13, margin: "0 0 8px",
                    }}>
                      {pinMsg}
                    </p>
                  )}
                  <PrimaryBtn onClick={cambiarPin}>Guardar PIN</PrimaryBtn>
                </div>
              )}
            </div>

            {/* Soporte */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 4, marginBottom: 14, overflow: "hidden",
            }}>
              {[
                { icon: IconPhone, lbl: "Central",  val: "966 707 225",                href: "tel:966707225" },
                { icon: IconMail,  lbl: "Email",    val: "transporte@afatoursperu.com", href: "mailto:transporte@afatoursperu.com" },
              ].map((row, i, arr) => {
                const Ico = row.icon;
                return (
                  <a
                    key={row.lbl} href={row.href}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 14px", textDecoration: "none",
                      borderBottom: i < arr.length - 1 ? "1px solid var(--c-line-2)" : "none",
                      color: "var(--c-ink)",
                    }}
                  >
                    <div style={{
                      width: 34, height: 34, borderRadius: 11,
                      background: "var(--c-navy-tint)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Ico size={16} color="var(--c-navy)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-mute)" }}>
                        {row.lbl}
                      </p>
                      <p style={{ margin: "2px 0 0", fontFamily: row.lbl === "Central" ? FONT_MONO : FONT_SANS, fontSize: 14, fontWeight: 700 }}>
                        {row.val}
                      </p>
                    </div>
                    <IconChevronRight size={16} color="var(--c-mute-2)" />
                  </a>
                );
              })}
            </div>

            <button
              onClick={cerrarSesion}
              style={{
                width: "100%", padding: "13px 0", borderRadius: 14,
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                color: "var(--c-danger)", fontFamily: FONT_SANS, fontWeight: 800, fontSize: 14,
                cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <IconLogout size={16} color="var(--c-danger)" />
              Cerrar sesión
            </button>
          </section>
        )}
      </main>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MANIFIESTO SUB-VISTA                                                */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showManifiesto && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 80,
          background: "var(--c-paper)", overflowY: "auto",
          fontFamily: FONT_SANS,
          maxWidth: 520, margin: "0 auto",
        }}>
          <header style={{
            position: "sticky", top: 0, background: "var(--c-paper)",
            padding: "16px 18px", borderBottom: "1px solid var(--c-line-2)",
            display: "flex", alignItems: "center", gap: 10, zIndex: 1,
          }}>
            <button
              onClick={() => setShowManifiesto(false)}
              style={{
                width: 36, height: 36, borderRadius: 12, border: "1px solid var(--c-line)",
                background: "var(--c-surface)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <IconArrowLeft size={16} color="var(--c-ink)" />
            </button>
            <div style={{ flex: 1 }}>
              <Eyebrow>Manifiesto · {vehSel?.placa || "—"}</Eyebrow>
              <h2 style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, letterSpacing: -0.6 }}>
                Pasajeros
              </h2>
            </div>
          </header>

          <div style={{ padding: "16px 18px 80px" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12,
            }}>
              {[
                { lbl: "Reservados", val: totalReservados, color: "var(--c-navy)",    bg: "var(--c-navy-tint)" },
                { lbl: "A bordo",    val: totalEmbarcados, color: "var(--c-success)", bg: "var(--c-success-tint)" },
                { lbl: "Esperando",  val: totalEsperando,  color: "var(--c-warn)",    bg: "var(--c-warn-tint)" },
                { lbl: "No show",    val: totalNoShow,     color: "var(--c-danger)",  bg: "var(--c-danger-tint)" },
              ].map(s => (
                <div key={s.lbl} style={{ background: s.bg, borderRadius: 14, padding: "10px 12px" }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: s.color }}>
                    {s.lbl}
                  </p>
                  <p style={{
                    margin: "4px 0 0", fontFamily: FONT_MONO, fontSize: 22, fontWeight: 800, letterSpacing: -0.5,
                    color: s.color,
                  }}>
                    {s.val}
                  </p>
                </div>
              ))}
            </div>

            {/* Bar ocupación */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 14, padding: "12px 14px", marginBottom: 14,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Eyebrow>Ocupación</Eyebrow>
                <Chip color="var(--c-navy)" bg="var(--c-navy-tint)" mono sw>
                  {totalEmbarcados}/{totalReservados}
                </Chip>
              </div>
              <div style={{ height: 6, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${totalReservados > 0 ? (totalEmbarcados / totalReservados) * 100 : 0}%`,
                  background: "linear-gradient(90deg, var(--c-navy), var(--c-success))",
                  borderRadius: 3, transition: "width 0.5s",
                }} />
              </div>
            </div>

            {/* Agrupado por parada */}
            {paradas.map((p, i) => {
              const ppList = pasajeros.filter(x => x.parada_id === p.id);
              if (ppList.length === 0) return null;
              const completada = p.estado === "completada";
              const esActual = i === paradaIdx;
              return (
                <div key={p.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%",
                      background: completada ? "var(--c-navy)" : esActual ? "var(--c-coral)" : "var(--c-soft)",
                      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      {completada
                        ? <IconCheck size={13} color="#fff" sw={2.5} />
                        : esActual
                          ? <IconPin size={13} color="#fff" />
                          : <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute-2)" }}>{i + 1}</span>}
                    </div>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: 14, letterSpacing: -0.2, flex: 1 }}>
                      {p.nombre}
                    </p>
                    {p.hora_estimada && (
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: "var(--c-mute)", fontWeight: 600 }}>
                        {p.hora_estimada.slice(0, 5)}
                      </span>
                    )}
                  </div>
                  <div style={{
                    background: "var(--c-surface)", border: "1px solid var(--c-line)",
                    borderRadius: 14, overflow: "hidden",
                  }}>
                    {ppList.map((x, idx) => {
                      const onBoard = x.estado === "embarcado";
                      const noShow = x.estado === "no_show";
                      return (
                        <div
                          key={x.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "10px 12px",
                            borderBottom: idx < ppList.length - 1 ? "1px solid var(--c-line-2)" : "none",
                          }}
                        >
                          <div style={{
                            width: 32, height: 32, borderRadius: 10,
                            background: onBoard ? "var(--c-success-tint)" : noShow ? "var(--c-danger-tint)" : "var(--c-soft)",
                            color: onBoard ? "var(--c-success)" : noShow ? "var(--c-danger)" : "var(--c-mute)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 800, fontSize: 12, flexShrink: 0,
                          }}>
                            {x.pasajero?.nombre ? ini(x.pasajero.nombre) : "?"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: -0.1 }}>
                              {x.pasajero?.nombre || `Pasajero #${x.pasajero_id}`}
                            </p>
                            {x.pasajero?.empresa && (
                              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--c-mute)" }}>
                                {x.pasajero.empresa}
                              </p>
                            )}
                          </div>
                          {x.pasajero?.dni && (
                            <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute)" }}>
                              {x.pasajero.dni}
                            </span>
                          )}
                          {onBoard
                            ? <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>A bordo</Chip>
                            : noShow
                              ? <Chip color="var(--c-danger)" bg="var(--c-danger-tint)" sw>No show</Chip>
                              : <Chip color="var(--c-warn)" bg="var(--c-warn-tint)" sw>Esperando</Chip>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* SCANNER QR (dark glass)                                             */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {escanear && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "#000" }}>

          {/* ── CSS: fuerza el video de html5-qrcode a llenar pantalla completa ── */}
          <style>{`
            #qr-container,
            #qr-container > div { width: 100% !important; height: 100% !important; padding: 0 !important; border: none !important; }
            #qr-container video  { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; object-fit: cover !important; display: block !important; }
            #qr-container canvas,
            #qr-container img    { display: none !important; }
            #qr-container span   { display: none !important; }
          `}</style>

          {/* Contenedor que html5-qrcode necesita — ocupa toda la pantalla */}
          <div id="qr-container" style={{ position: "absolute", inset: 0 }} />

          {/* ── Overlay: header ── */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
            padding: "52px 22px 20px",
            background: "linear-gradient(180deg, rgba(0,0,0,0.72) 60%, transparent)",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <button
              onClick={() => setEscanear(false)}
              style={{
                width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                background: "rgba(255,255,255,0.15)", border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <IconClose size={17} color="#fff" />
            </button>
            <div style={{ color: "#fff" }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.55)" }}>
                {paradaActual ? `Parada ${paradaIdx + 1} · ${paradaActual.nombre}` : "Escanear"}
              </p>
              <p style={{ margin: "2px 0 0", fontWeight: 800, fontSize: 17, letterSpacing: -0.3 }}>
                Escanear pasajero
              </p>
            </div>
          </div>

          {/* ── Overlay: brackets decorativos en las 4 esquinas de la pantalla ── */}
          <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
            {/* Esquina superior-izquierda */}
            <div style={{ position: "absolute", top: 90, left: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 }} />
            {/* Esquina superior-derecha */}
            <div style={{ position: "absolute", top: 90, right: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 }} />
            {/* Esquina inferior-izquierda */}
            <div style={{ position: "absolute", bottom: 110, left: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 }} />
            {/* Esquina inferior-derecha */}
            <div style={{ position: "absolute", bottom: 110, right: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 }} />
            {/* Línea de escaneo a todo ancho */}
            <div style={{
              position: "absolute", left: 20, right: 20, height: 2,
              top: "50%", transform: "translateY(-50%)",
              background: "linear-gradient(90deg, transparent, var(--c-coral) 20%, var(--c-coral) 80%, transparent)",
              boxShadow: "0 0 20px var(--c-coral)",
              animation: "scanLine 2s ease-in-out infinite",
            }} />
          </div>

          {/* ── Overlay: footer ── */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 2,
            padding: "20px 22px 40px",
            background: "linear-gradient(0deg, rgba(0,0,0,0.72) 60%, transparent)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
          }}>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.75)", fontSize: 14, fontWeight: 500, textAlign: "center" }}>
              Apunta al QR del pasajero
            </p>
            <button
              onClick={() => setEscanear(false)}
              style={{
                padding: "13px 36px", borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.10)", color: "#fff",
                fontFamily: FONT_SANS, fontWeight: 700, fontSize: 15, cursor: "pointer",
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TARJETA RESULTADO EMBARQUE (auto-dismiss 3 s, toca para cerrar)    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {resultadoEmbarque && (() => {
        const { pasajero: p, fueraLista } = resultadoEmbarque;
        const color  = fueraLista ? "var(--c-warn)"         : "var(--c-success)";
        const tint   = fueraLista ? "var(--c-warn-tint)"    : "var(--c-success-tint)";
        const titulo = fueraLista ? "⚠️ EMBARCADO — FUERA DE LISTA" : "✅ EMBARCADO";
        const sub    = fueraLista ? "Pasajero no estaba asignado a esta parada" : "Embarque registrado correctamente";
        const cerrar = () => {
          if (resultIntervalRef.current) { clearInterval(resultIntervalRef.current); resultIntervalRef.current = null; }
          setResultadoEmbarque(null); setResultProgreso(0);
        };
        return (
          <div
            onClick={cerrar}
            style={{
              position: "fixed", inset: 0, zIndex: 120,
              background: "rgba(0,0,0,0.65)",
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              animation: "sheetIn 0.22s ease-out",
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: "var(--c-paper)",
                borderRadius: "28px 28px 0 0",
                width: "100%", maxWidth: 520,
                overflow: "hidden",
                boxShadow: "0 -10px 40px rgba(0,0,0,0.2)",
              }}
            >
              {/* Header coloreado */}
              <div style={{
                background: tint, padding: "18px 22px 14px",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 12,
                  background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <IconCheck size={20} color="#fff" sw={2.5} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color, letterSpacing: 0.2 }}>{titulo}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color, opacity: 0.8 }}>{sub}</p>
                </div>
              </div>

              {/* Info del pasajero */}
              <div style={{ padding: "18px 22px 10px", display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 20, flexShrink: 0,
                  background: "var(--c-navy-tint)", color: "var(--c-navy)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 26, overflow: "hidden",
                }}>
                  {p.foto_url
                    ? <img src={p.foto_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : ini(p.nombre)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.15 }}>{p.nombre}</p>
                  {p.empresa && (
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--c-mute)" }}>{p.empresa}</p>
                  )}
                  {p.dni && (
                    <p style={{ margin: "3px 0 0", fontFamily: FONT_MONO, fontSize: 12, color: "var(--c-mute)", fontWeight: 600 }}>
                      DNI {p.dni}
                    </p>
                  )}
                </div>
              </div>

              {/* Barra de progreso + hint */}
              <div style={{ padding: "8px 22px 28px" }}>
                <div style={{ height: 4, background: "var(--c-line-2)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${resultProgreso}%`,
                    background: color, transition: "width 0.03s linear",
                  }} />
                </div>
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--c-mute)", textAlign: "center" }}>
                  Toca para cerrar
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MODAL INCIDENCIA                                                    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showIncidencia && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 105,
          background: "rgba(11,31,58,0.75)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          animation: "sheetIn 0.25s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: "28px 28px 0 0",
            padding: "0 0 22px", width: "100%", maxWidth: 520,
            maxHeight: "92vh", overflowY: "auto",
            boxShadow: "0 -10px 30px rgba(0,0,0,0.15)",
          }}>
            <div style={{ width: 40, height: 4, background: "var(--c-line)", borderRadius: 2, margin: "14px auto 16px" }} />

            <div style={{ padding: "0 22px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <Eyebrow color="var(--c-danger)">Reporte rápido</Eyebrow>
                <h2 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800, letterSpacing: -0.8 }}>
                  Incidencia
                </h2>
              </div>
              <button
                onClick={() => setShowIncidencia(false)}
                style={{
                  width: 34, height: 34, borderRadius: 12,
                  background: "var(--c-soft)", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <IconClose size={15} color="var(--c-ink)" />
              </button>
            </div>

            <div style={{ padding: "0 22px" }}>
              <Eyebrow style={{ marginBottom: 8 }}>Tipo</Eyebrow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                {INCIDENCIA_TIPOS.map(t => {
                  const sel = incTipo === t.id;
                  const Ico = t.icon;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setIncTipo(t.id)}
                      style={{
                        padding: "12px 8px", borderRadius: 14, cursor: "pointer",
                        border: sel ? "2px solid var(--c-navy)" : "1px solid var(--c-line)",
                        background: sel ? "var(--c-navy-tint)" : "var(--c-surface)",
                        boxShadow: sel ? "0 4px 14px rgba(11,49,95,0.12)" : "none",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                        fontFamily: FONT_SANS,
                      }}
                    >
                      <Ico size={22} color={sel ? "var(--c-navy)" : "var(--c-mute)"} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: sel ? "var(--c-navy)" : "var(--c-ink-2)" }}>
                        {t.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <Eyebrow style={{ marginBottom: 8 }}>Severidad</Eyebrow>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14,
                background: "var(--c-soft)", padding: 4, borderRadius: 12,
              }}>
                {SEVERIDADES.map(s => {
                  const sel = incSev === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setIncSev(s.id)}
                      style={{
                        padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer",
                        background: sel ? s.bg : "transparent",
                        color: sel ? s.color : "var(--c-mute)",
                        fontFamily: FONT_SANS, fontSize: 13, fontWeight: 700,
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>

              <Eyebrow style={{ marginBottom: 8 }}>Descripción (obligatoria)</Eyebrow>
              <textarea
                rows={3} value={incDesc} onChange={e => setIncDesc(e.target.value)}
                placeholder="Describe brevemente lo ocurrido…"
                required
                style={{
                  width: "100%", marginBottom: 12, padding: 12, borderRadius: 12,
                  border: "1.5px solid var(--c-line)",
                  fontFamily: FONT_SANS, fontSize: 13, color: "var(--c-ink)",
                  background: "var(--c-surface)", resize: "none", outline: "none",
                  boxSizing: "border-box",
                }}
              />

              <div style={{
                background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                borderRadius: 12, padding: "10px 14px", marginBottom: 16,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconClock size={18} color="var(--c-warn)" />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-warn)" }}>
                    Retraso estimado
                  </p>
                </div>
                <input
                  type="number" min={0} max={240} value={incRetraso}
                  onChange={e => setIncRetraso(e.target.value)}
                  placeholder="0"
                  style={{
                    width: 72, padding: "6px 8px", borderRadius: 8,
                    border: "1px solid var(--c-warn)", background: "#fff",
                    fontFamily: FONT_MONO, fontSize: 16, fontWeight: 800, color: "var(--c-warn)",
                    textAlign: "center", outline: "none",
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--c-warn)" }}>min</span>
              </div>

              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 12, padding: "10px 14px", marginBottom: 16,
              }}>
                <Eyebrow style={{ marginBottom: 6 }}>Notificará a</Eyebrow>
                {["Operaciones AFA", "Supervisor de flota", "Central — 966 707 225"].map(r => (
                  <div key={r} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                  }}>
                    <IconCheck size={14} color="var(--c-success)" sw={2.5} />
                    <span style={{ fontSize: 12, color: "var(--c-ink-2)" }}>{r}</span>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <SecondaryBtn onClick={() => setShowIncidencia(false)}>Cancelar</SecondaryBtn>
                <PrimaryBtn
                  onClick={enviarIncidencia}
                  disabled={incSaving}
                  color="var(--c-danger)"
                  icon={<IconBell size={15} color="#fff" />}
                >
                  {incSaving ? "Enviando…" : "Enviar"}
                </PrimaryBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MODAL FIN DE VIAJE                                                  */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showFinViaje && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 105,
          background: "rgba(11,31,58,0.75)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          animation: "sheetIn 0.25s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: "28px 28px 0 0",
            padding: "0 0 22px", width: "100%", maxWidth: 520,
            maxHeight: "92vh", overflowY: "auto",
            boxShadow: "0 -10px 30px rgba(0,0,0,0.15)",
          }}>
            <div style={{ width: 40, height: 4, background: "var(--c-line)", borderRadius: 2, margin: "14px auto 16px" }} />

            <div style={{
              margin: "0 22px 18px",
              background: "linear-gradient(135deg, var(--c-navy), var(--c-blue))",
              color: "#fff", borderRadius: 22, padding: 20, position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", right: -8, top: -8, opacity: 0.12 }}>
                <IconFlag size={100} color="#fff" />
              </div>
              <Eyebrow color="rgba(255,255,255,0.7)">Viaje finalizado</Eyebrow>
              <h2 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 800, letterSpacing: -0.6 }}>
                {reservaActiva?.origen} → {reservaActiva?.destino}
              </h2>
            </div>

            <div style={{ padding: "0 22px" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14,
              }}>
                {[
                  { lbl: "Duración",  val: inicioViaje ? fmtDuracion(Date.now() - inicioViaje.getTime()) : "—", mono: true },
                  { lbl: "Paradas",   val: `${paradaIdx + 1}/${paradas.length}`, mono: true },
                  { lbl: "A bordo",   val: String(totalEmbarcados), mono: true, color: "var(--c-success)" },
                  { lbl: "Envíos GPS", val: String(totalEnvios), mono: true },
                ].map(s => (
                  <div
                    key={s.lbl}
                    style={{
                      background: "var(--c-surface)", border: "1px solid var(--c-line)",
                      borderRadius: 14, padding: "12px 14px",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                      {s.lbl}
                    </p>
                    <p style={{
                      margin: "4px 0 0",
                      fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                      fontSize: 22, fontWeight: 800, letterSpacing: -0.5,
                      color: s.color || "var(--c-navy)",
                    }}>
                      {s.val}
                    </p>
                  </div>
                ))}
              </div>

              <Eyebrow style={{ marginBottom: 10 }}>Línea del tiempo</Eyebrow>
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 14, padding: 14, marginBottom: 16,
              }}>
                {[
                  { ico: IconPlay,   lbl: "Iniciaste viaje",     hora: inicioViaje?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—" },
                  { ico: IconPin,    lbl: "Primera parada",       hora: paradas[0]?.hora_estimada?.slice(0, 5) || "—" },
                  { ico: IconUsers,  lbl: `${totalEmbarcados} pasajeros embarcados`, hora: "" },
                  { ico: IconFlag,   lbl: "Cierre de viaje",      hora: new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) },
                ].map((row, i, arr) => {
                  const Ico = row.ico;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "8px 0",
                      borderBottom: i < arr.length - 1 ? "1px dashed var(--c-line-2)" : "none",
                    }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 9,
                        background: "var(--c-navy-tint)", color: "var(--c-navy)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0,
                      }}>
                        <Ico size={15} color="var(--c-navy)" />
                      </div>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--c-ink-2)" }}>
                        {row.lbl}
                      </span>
                      {row.hora && (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: "var(--c-mute)" }}>
                          {row.hora}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <SecondaryBtn onClick={() => setShowFinViaje(false)}>Cancelar</SecondaryBtn>
                <PrimaryBtn
                  onClick={finalizarRecorridoConfirmado}
                  icon={<IconStop size={15} color="#fff" />}
                >
                  Cerrar viaje
                </PrimaryBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TOAST                                                               */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {boardingMsg && (
        <div style={{
          position: "fixed", top: 78, left: "50%", transform: "translateX(-50%)",
          background: boardingMsg.ok ? "var(--c-success)" : "var(--c-danger)",
          color: "#fff", borderRadius: 14, padding: "12px 18px",
          fontFamily: FONT_SANS, fontWeight: 700, fontSize: 13, zIndex: 200,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)", maxWidth: "90%", textAlign: "center",
          display: "flex", alignItems: "center", gap: 8,
          animation: "sheetIn 0.25s ease-out",
        }}>
          {boardingMsg.ok
            ? <IconCheck size={16} color="#fff" sw={2.5} />
            : <IconCircleAlert size={16} color="#fff" />}
          {boardingMsg.msg}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>
    </div>
  );
}
