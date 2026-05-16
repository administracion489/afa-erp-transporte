"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Conductor = {
  id: number; nombre: string; dni: string | null; telefono: string | null;
  pin_acceso: string | null; activo_app: boolean; licencia?: string | null;
  vencimiento_licencia?: string | null; categoria_licencia?: string | null;
  sctr_salud_venc?: string | null; examen_medico_venc?: string | null;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; marca?: string | null; };
type Reserva   = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio?: string | null; vehiculo_id?: number | null; };
type Parada    = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; };
type Pasajero  = { id: number; nombre: string; dni: string | null; empresa: string | null; qr_code: string | null; foto_url: string | null; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; pasajero?: Pasajero; };
type CheckItem = { id: string; label: string; categoria: string; ok: boolean | null; };
type DocCond   = { id: number; tipo: string; nombre: string | null; url: string; vencimiento: string | null; };

type Tab = "ruta" | "paradas" | "checklist" | "documentos" | "perfil";

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CHECKLIST_ITEMS: CheckItem[] = [
  { id: "neumaticos",  label: "Neumáticos en buen estado",          categoria: "🔐 Seguridad",    ok: null },
  { id: "luces",       label: "Luces delanteras y traseras OK",      categoria: "🔐 Seguridad",    ok: null },
  { id: "frenos",      label: "Frenos funcionando correctamente",    categoria: "🔐 Seguridad",    ok: null },
  { id: "espejos",     label: "Espejos ajustados y limpios",         categoria: "🔐 Seguridad",    ok: null },
  { id: "cinturones",  label: "Cinturones de seguridad operativos",  categoria: "🔐 Seguridad",    ok: null },
  { id: "aceite",      label: "Nivel de aceite correcto",            categoria: "🔧 Mecánica",     ok: null },
  { id: "agua",        label: "Nivel de agua / refrigerante OK",     categoria: "🔧 Mecánica",     ok: null },
  { id: "combustible", label: "Combustible suficiente",              categoria: "🔧 Mecánica",     ok: null },
  { id: "bateria",     label: "Batería en buen estado",              categoria: "🔧 Mecánica",     ok: null },
  { id: "soat",        label: "SOAT vigente a bordo",                categoria: "📋 Documentos",   ok: null },
  { id: "licencia_ab", label: "Licencia de conducir a bordo",        categoria: "📋 Documentos",   ok: null },
  { id: "botiquin",    label: "Botiquín de primeros auxilios",       categoria: "🧰 Equipamiento", ok: null },
  { id: "extintor",    label: "Extintor vigente a bordo",            categoria: "🧰 Equipamiento", ok: null },
  { id: "limpieza",    label: "Unidad limpia y presentable",         categoria: "🧰 Equipamiento", ok: null },
];

const TIPOS_DOC = ["Licencia de conducir", "SCTR Salud", "Examen médico", "Psicosométrico", "Antecedentes", "Foto DNI", "Otro"];

// ─── COLORES ─────────────────────────────────────────────────────────────────

const C = {
  navy:    "#0b315f",
  navy2:   "#1e40af",
  white:   "#FFFFFF",
  gray50:  "#F8FAFC",
  gray100: "#F1F5F9",
  gray200: "#E2E8F0",
  gray400: "#94A3B8",
  gray600: "#475569",
  gray700: "#374151",
  gray800: "#1E293B",
  green:   "#16a34a",
  red:     "#dc2626",
  amber:   "#d97706",
};

// ─── ✅ FIX FECHA TIMEZONE (PERU UTC-5) ──────────────────────────────────────
// PROBLEMA ORIGINAL: new Date().toISOString() devuelve fecha en UTC.
// En Lima (UTC-5), a las 7pm el sistema pedía el día SIGUIENTE → sin resultados.
// SOLUCIÓN: obtener fecha en zona horaria local del dispositivo.
function getFechaLocal(): string {
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ─── SESSION ──────────────────────────────────────────────────────────────────

const SK = "afa_cond_v2";
function saveSession(c: Conductor) {
  localStorage.setItem(SK, JSON.stringify({ c, exp: Date.now() + 12 * 3600000 }));
}
function loadSession(): Conductor | null {
  try {
    const r = localStorage.getItem(SK);
    if (!r) return null;
    const { c, exp } = JSON.parse(r);
    if (Date.now() > exp) { localStorage.removeItem(SK); return null; }
    return c;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SK); }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function diasPara(f: string | null) {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function docEstado(f: string | null) {
  const d = diasPara(f);
  if (d === null) return "sin";
  if (d < 0) return "vencido";
  if (d <= 30) return "pronto";
  return "ok";
}

// ─── COMPONENTES PEQUEÑOS ─────────────────────────────────────────────────────

function NavBtn({ active, icon, label, badge }: { active: boolean; icon: string; label: string; badge?: number }) {
  return (
    <div className="flex flex-col items-center relative py-2 flex-1">
      <span className="text-xl">{icon}</span>
      <span className="text-[9px] font-bold mt-0.5" style={{ color: active ? C.navy : C.gray400 }}>{label}</span>
      {active && <div className="absolute top-0 left-3 right-3 h-0.5 rounded-b" style={{ background: C.navy }} />}
      {badge && badge > 0 ? <div className="absolute top-1.5 right-2.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black text-white" style={{ background: C.red }}>{badge}</div> : null}
    </div>
  );
}

function Pill({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ color, background: bg }}>{children}</span>;
}

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
  const [cargando,     setCargando]     = useState(false); // ✅ NUEVO: estado de carga visible
  const [debugFecha,   setDebugFecha]   = useState("");    // ✅ NUEVO: debug de fecha

  // ── GPS ────────────────────────────────────────────────────────────────────
  const [enRuta,       setEnRuta]       = useState(false);
  const [posActual,    setPosActual]    = useState<GeolocationPosition | null>(null);
  const [velocidad,    setVelocidad]    = useState(0);
  const [totalEnvios,  setTotalEnvios]  = useState(0);
  const [ultimoEnvio,  setUltimoEnvio]  = useState<Date | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);
  const [iniciando,    setIniciando]    = useState(false);
  const watchIdRef     = useRef<number | null>(null);
  const intervalRef    = useRef<NodeJS.Timeout | null>(null);
  const posRef         = useRef<GeolocationPosition | null>(null);

  // ── SOS ────────────────────────────────────────────────────────────────────
  const [sosPct,       setSosPct]       = useState(0);
  const [sosActivo,    setSosActivo]    = useState(false);
  const [sosEnviado,   setSosEnviado]   = useState(false);
  const sosTimer       = useRef<NodeJS.Timeout | null>(null);
  const sosInterval    = useRef<NodeJS.Timeout | null>(null);

  // ── ✅ QR Scanner (RESTAURADO) ─────────────────────────────────────────────
  const [escanear,     setEscanear]     = useState(false);
  const [validando,    setValidando]    = useState<Pasajero | null>(null);
  const [boardingMsg,  setBoardingMsg]  = useState<{ok: boolean; msg: string} | null>(null);
  const qrRef          = useRef<any>(null);

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

  // ─── Inicializar ────────────────────────────────────────────────────────────

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setConductor(saved); cargarDatos(saved.id); }
    setIniting(false);
    return () => cleanup();
  }, []);

  function cleanup() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async function login() {
    if (dni.length < 7) { setLoginErr("Ingresa tu DNI"); return; }
    if (pin.length < 4) { setLoginErr("PIN de 4 dígitos"); return; }
    setLoginErr(""); setLoginLoading(true);
    const { data } = await supabase.from("conductores")
      .select("id,nombre,dni,telefono,pin_acceso,activo_app,licencia,vencimiento_licencia,categoria_licencia,sctr_salud_venc,examen_medico_venc")
      .eq("dni", dni.trim()).single();
    if (!data) { setLoginErr("DNI no encontrado"); setLoginLoading(false); return; }
    if (!data.activo_app) { setLoginErr("Acceso no activado. Llama a central."); setLoginLoading(false); return; }
    if (data.pin_acceso !== pin) { setLoginErr("PIN incorrecto"); setLoginLoading(false); return; }
    saveSession(data); setConductor(data); await cargarDatos(data.id); setLoginLoading(false);
  }

  // ─── ✅ Cargar datos (FECHA CORREGIDA) ───────────────────────────────────────
  // BUG ORIGINAL: usaba new Date().toISOString().split("T")[0] → fecha en UTC
  // FIX: usa getFechaLocal() que respeta la zona horaria del dispositivo (Peru UTC-5)

  const cargarDatos = useCallback(async (cid: number) => {
    setCargando(true);

    // ✅ CORRECCIÓN PRINCIPAL: fecha local, no UTC
    const hoy = getFechaLocal();
    setDebugFecha(hoy); // útil para debug en pantalla si es necesario

    console.log("[ConductorApp] Cargando reservas para fecha:", hoy);

    const [vR, rR, dR, ckR] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca").order("placa"),
      supabase.from("reservas")
        .select("id,origen,destino,fecha_servicio,hora_servicio,vehiculo_id")
        .eq("fecha_servicio", hoy)
        .order("hora_servicio"),
      supabase.from("documentos_conductor")
        .select("*")
        .eq("conductor_id", cid)
        .order("created_at", { ascending: false }),
      supabase.from("checklist_conductor")
        .select("id")
        .eq("conductor_id", cid)
        .eq("fecha", hoy)
        .limit(1),
    ]);

    console.log("[ConductorApp] Reservas encontradas:", rR.data?.length ?? 0, rR.error || "");

    setVehiculos(vR.data || []);

    const res = rR.data || [];
    setReservasHoy(res);

    // ✅ Si la reserva ya tiene vehículo asignado, preseleccionarlo
    if (res.length === 1 && res[0].vehiculo_id) {
      setVehiculoId(res[0].vehiculo_id);
    }

    setDocs(dR.data || []);
    if (ckR.data && ckR.data.length > 0) setCheckDone(true);

    setCargando(false);
  }, []);

  // ─── Cargar paradas ───────────────────────────────────────────────────────

  async function cargarParadas(reservaId: number) {
    const { data: ps } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    const listaParadas = ps || [];
    setParadas(listaParadas);
    if (listaParadas.length > 0) {
      const { data: pp } = await supabase.from("pasajeros_parada")
        .select("*, pasajero:pasajeros(*)")
        .in("parada_id", listaParadas.map(p => p.id));
      setPasajeros(pp || []);
    }
  }

  // ─── GPS + TRACKING ──────────────────────────────────────────────────────────
  // ✅ PREPARADO PARA INTEGRACIÓN CON PÁGINA DE SEGUIMIENTO
  // La tabla ubicaciones_gps alimenta el mapa en tiempo real.
  // Campos clave: vehiculo_id, conductor_id, lat, lng, velocidad, estado

  const enviarUbicacion = useCallback(async (pos: GeolocationPosition, estado = "en_ruta") => {
    if (!vehiculoId || !conductor) return;
    const payload = {
      vehiculo_id:  vehiculoId,
      conductor_id: conductor.id,
      reserva_id:   reservaActiva?.id || null,
      lat:          pos.coords.latitude,
      lng:          pos.coords.longitude,
      velocidad:    pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
      rumbo:        pos.coords.heading || 0,
      precision_m:  pos.coords.accuracy,
      estado,
      // ✅ timestamp explícito para sincronización con página de seguimiento
      created_at:   new Date().toISOString(),
    };
    const { error } = await supabase.from("ubicaciones_gps").insert(payload);
    if (error) console.error("[GPS] Error al enviar ubicación:", error.message);
    setUltimoEnvio(new Date());
    setTotalEnvios(p => p + 1);
    setVelocidad(pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0);
  }, [vehiculoId, conductor, reservaActiva]);

  async function iniciarRecorrido(reserva: Reserva) {
    if (!vehiculoId) { alert("Selecciona el vehículo primero"); return; }
    if (!navigator.geolocation) { alert("GPS no disponible en este dispositivo"); return; }
    setIniciando(true);
    setReservaActiva(reserva);
    await cargarParadas(reserva.id);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        posRef.current = pos; setPosActual(pos); enviarUbicacion(pos);
        setEnRuta(true); setIniciando(false); setTab("paradas");
        watchIdRef.current = navigator.geolocation.watchPosition(
          (p) => { posRef.current = p; setPosActual(p); },
          (e) => setGpsError(e.message),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
        // ✅ Envío GPS cada 10 segundos → actualiza mapa de seguimiento
        intervalRef.current = setInterval(() => {
          if (posRef.current) enviarUbicacion(posRef.current);
        }, 10000);
      },
      (e) => { setIniciando(false); alert(`GPS: ${e.message}`); },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function finalizarRecorrido() {
    if (!confirm("¿Finalizar el recorrido?")) return;
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (posRef.current) await enviarUbicacion(posRef.current, "finalizado");
    setEnRuta(false); setReservaActiva(null); setParadas([]); setPasajeros([]);
    setParadaIdx(0); setVelocidad(0); setTotalEnvios(0); setTab("ruta");
  }

  async function marcarParadaCompletada(paradaId: number) {
    await supabase.from("paradas").update({ estado: "completada" }).eq("id", paradaId);
    setParadas(prev => prev.map(p => p.id === paradaId ? { ...p, estado: "completada" } : p));
    if (paradaIdx < paradas.length - 1) setParadaIdx(i => i + 1);
    else finalizarRecorrido();
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
      if (posRef.current && vehiculoId && conductor) {
        await supabase.from("alertas_sos").insert({
          conductor_id: conductor.id, vehiculo_id: vehiculoId,
          reserva_id: reservaActiva?.id || null,
          lat: posRef.current.coords.latitude, lng: posRef.current.coords.longitude,
          mensaje: "🆘 EMERGENCIA SOS — Conductor solicita ayuda urgente",
        });
        await enviarUbicacion(posRef.current, "sos");
      }
      setSosEnviado(true);
      setTimeout(() => { setSosEnviado(false); setSosPct(0); }, 10000);
    }, 2000);
  }

  function cancelarSOS() {
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
    setSosActivo(false); setSosPct(0);
  }

  // ─── ✅ QR SCANNER (RESTAURADO COMPLETAMENTE) ─────────────────────────────────
  // Requiere: npm install html5-qrcode
  // Uso: el conductor escanea el QR del pasajero → valida identidad → confirma embarque

  useEffect(() => {
    if (!escanear) {
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
      return;
    }
    let stopped = false;
    import("html5-qrcode").then(({ Html5Qrcode }) => {
      if (stopped) return;
      // Asegurarse que el contenedor existe antes de iniciar
      const container = document.getElementById("qr-container");
      if (!container) return;
      const scanner = new Html5Qrcode("qr-container");
      qrRef.current = scanner;
      scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        async (text: string) => {
          // ✅ QR detectado → detener scanner → procesar
          scanner.stop().catch(() => {}); qrRef.current = null; setEscanear(false);
          await procesarQR(text);
        },
        () => {} // error silencioso durante escaneo continuo
      ).catch((err: any) => {
        console.error("[QR] Error al iniciar scanner:", err);
        setEscanear(false);
        alert("No se pudo acceder a la cámara. Verifica los permisos.");
      });
    }).catch((err) => {
      console.error("[QR] Error al cargar html5-qrcode:", err);
      alert("El módulo QR no está disponible. Ejecuta: npm install html5-qrcode");
    });
    return () => {
      stopped = true;
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
    };
  }, [escanear]);

  async function procesarQR(qrCode: string) {
    const { data: pasajero } = await supabase
      .from("pasajeros")
      .select("*")
      .eq("qr_code", qrCode)
      .single();
    if (!pasajero) {
      setBoardingMsg({ ok: false, msg: "❌ QR no reconocido. Pasajero no encontrado en el sistema." });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }
    setValidando(pasajero);
  }

  async function confirmarEmbarque(pasajero: Pasajero) {
    const paradaActual = paradas[paradaIdx];
    if (!paradaActual) return;
    const pp = pasajeros.find(p => p.pasajero_id === pasajero.id && p.parada_id === paradaActual.id);
    if (pp) {
      if (pp.estado === "embarcado") {
        setBoardingMsg({ ok: false, msg: `⚠️ ${pasajero.nombre} ya está registrado en esta parada.` });
        setValidando(null);
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }
      await supabase.from("pasajeros_parada").update({ estado: "embarcado" }).eq("id", pp.id);
      setPasajeros(prev => prev.map(p => p.id === pp.id ? { ...p, estado: "embarcado" } : p));
    }
    // ✅ Registrar boarding_log con ubicación GPS actual
    if (conductor && posRef.current) {
      await supabase.from("boarding_log").insert({
        reserva_id:   reservaActiva?.id,
        parada_id:    paradaActual.id,
        pasajero_id:  pasajero.id,
        conductor_id: conductor.id,
        metodo:       "qr",
        lat:          posRef.current.coords.latitude,
        lng:          posRef.current.coords.longitude,
      });
    }
    setBoardingMsg({ ok: true, msg: `✅ ${pasajero.nombre} embarcó correctamente` });
    setValidando(null);
    setTimeout(() => setBoardingMsg(null), 3000);
  }

  async function notificarRetraso() {
    if (!reservaActiva) return;
    setNotifEnviada(true);
    await supabase.from("alertas_sos").insert({
      conductor_id: conductor?.id,
      vehiculo_id:  vehiculoId,
      reserva_id:   reservaActiva.id,
      lat:          posRef.current?.coords.latitude || 0,
      lng:          posRef.current?.coords.longitude || 0,
      mensaje:      `⏰ RETRASO REPORTADO — Conductor en ruta a ${paradas[paradaIdx]?.nombre || "siguiente parada"}`,
    });
    setTimeout(() => setNotifEnviada(false), 5000);
  }

  // ─── 🗺️ NAVEGACIÓN ESTILO UBER ───────────────────────────────────────────────
  // Abre Waze o Google Maps con la parada actual como destino.
  // Prioridad: coordenadas lat/lng → si no hay, usa la dirección de texto.

  function abrirWaze(parada: Parada) {
    let url: string;
    if (parada.lat && parada.lng) {
      // Coordenadas exactas → navegación precisa
      url = `https://waze.com/ul?ll=${parada.lat},${parada.lng}&navigate=yes&zoom=17`;
    } else if (parada.direccion) {
      // Solo dirección de texto
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.direccion)}&navigate=yes`;
    } else {
      // Fallback: buscar por nombre de parada
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.nombre + ", Lima, Peru")}&navigate=yes`;
    }
    window.open(url, "_blank");
  }

  function abrirGoogleMaps(parada: Parada) {
    let dest: string;
    if (parada.lat && parada.lng) {
      dest = `${parada.lat},${parada.lng}`;
    } else if (parada.direccion) {
      dest = encodeURIComponent(parada.direccion);
    } else {
      dest = encodeURIComponent(parada.nombre + ", Lima, Peru");
    }
    // origin = posición actual del conductor (si disponible)
    const origin = posRef.current
      ? `&origin=${posRef.current.coords.latitude},${posRef.current.coords.longitude}`
      : "";
    const url = `https://www.google.com/maps/dir/?api=1&destination=${dest}${origin}&travelmode=driving`;
    window.open(url, "_blank");
  }

  // ─── Checklist ────────────────────────────────────────────────────────────────

  async function guardarChecklist() {
    if (!conductor) return;
    if (checks.some(c => c.ok === null)) { alert(`Faltan ${checks.filter(c => c.ok === null).length} ítems por completar`); return; }
    setCheckSaving(true);
    const { error } = await supabase.from("checklist_conductor").insert({
      conductor_id: conductor.id,
      vehiculo_id:  vehiculoId,
      fecha:        getFechaLocal(), // ✅ también corregido aquí
      items_json:   checks,
      km_inicio:    kmInicio ? Number(kmInicio) : null,
      observaciones: checkObs,
      estado:       checks.some(c => c.ok === false) ? "con_fallas" : "ok",
    });
    if (!error) setCheckDone(true);
    setCheckSaving(false);
  }

  // ─── Docs ─────────────────────────────────────────────────────────────────────

  async function subirDoc() {
    if (!conductor || !docUrl.trim()) return;
    setDocSaving(true);
    const { data } = await supabase.from("documentos_conductor").insert({
      conductor_id: conductor.id,
      tipo:         docTipo,
      url:          docUrl.trim(),
      nombre:       docTipo,
      vencimiento:  docVenc || null,
    }).select().single();
    if (data) setDocs(prev => [data, ...prev]);
    setDocUrl(""); setDocVenc(""); setDocSaving(false);
  }

  // ─── Cambiar PIN ─────────────────────────────────────────────────────────────

  async function cambiarPin() {
    if (pinNuevo.length < 4 || pinNuevo !== pinConfirm) { setPinMsg("PINs no coinciden"); return; }
    if (!conductor) return;
    await supabase.from("conductores").update({ pin_acceso: pinNuevo }).eq("id", conductor.id);
    const upd = { ...conductor, pin_acceso: pinNuevo };
    saveSession(upd); setConductor(upd);
    setPinMsg("✅ PIN cambiado"); setPinNuevo(""); setPinConfirm("");
    setTimeout(() => { setPinMsg(""); setCamPin(false); }, 2000);
  }

  function cerrarSesion() {
    if (enRuta && !confirm("Tienes un recorrido activo. ¿Salir igual?")) return;
    cleanup(); clearSession(); setConductor(null);
    setEnRuta(false); setDni(""); setPin(""); setTab("ruta");
  }

  // ─── Derivados ────────────────────────────────────────────────────────────────

  const vehSel        = vehiculos.find(v => v.id === vehiculoId);
  const paradaActual  = paradas[paradaIdx];
  const pasParada     = pasajeros.filter(p => p.parada_id === paradaActual?.id);
  const embarcados    = pasParada.filter(p => p.estado === "embarcado").length;
  const checkPct      = Math.round((checks.filter(c => c.ok !== null).length / checks.length) * 100);
  const checkFallas   = checks.filter(c => c.ok === false).length;
  const categorias    = [...new Set(CHECKLIST_ITEMS.map(i => i.categoria))];
  const docsBadge     = docs.filter(d => docEstado(d.vencimiento) === "vencido").length;

  // ══════════════════════════════════════════════════════════════════════════════
  // LOADING
  // ══════════════════════════════════════════════════════════════════════════════

  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.navy }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 40, height: 40, border: `4px solid rgba(255,255,255,0.3)`, borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }} />
        <p style={{ color: "white", fontSize: 14 }}>Cargando...</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // LOGIN
  // ══════════════════════════════════════════════════════════════════════════════

  if (!conductor) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.white, fontFamily: "system-ui,sans-serif" }}>
      <div style={{ background: C.navy, padding: "48px 24px 32px", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, background: "rgba(255,255,255,0.15)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 16px" }}>🚌</div>
        <h1 style={{ color: "white", fontWeight: 900, fontSize: 22, margin: 0 }}>AFA Tours Peru</h1>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 4 }}>Portal del Conductor</p>
      </div>

      <div style={{ flex: 1, padding: "32px 24px", maxWidth: 400, margin: "0 auto", width: "100%" }}>
        <p style={{ color: C.gray600, fontSize: 13, textAlign: "center", marginBottom: 24 }}>Ingresa con tu DNI y PIN personal</p>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Número de DNI</label>
          <input type="tel" inputMode="numeric" maxLength={8} value={dni}
            onChange={e => { setDni(e.target.value.replace(/\D/g,"").slice(0,8)); setLoginErr(""); }}
            style={{ width: "100%", padding: "14px 20px", borderRadius: 16, border: `2px solid ${dni.length >= 7 ? C.navy : C.gray200}`, fontSize: 22, fontWeight: 900, textAlign: "center", letterSpacing: 4, outline: "none", boxSizing: "border-box", color: C.gray800 }}
            placeholder="12345678" />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>PIN de acceso</label>
          <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 20 }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{ width: 18, height: 18, borderRadius: "50%", background: i < pin.length ? C.navy : "transparent", border: `2px solid ${i < pin.length ? C.navy : C.gray200}`, transition: "all 0.15s" }} />
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[1,2,3,4,5,6,7,8,9,"","0","⌫"].map((n, i) => (
              <button key={i}
                onClick={() => {
                  if (n === "⌫") setPin(p => p.slice(0,-1));
                  else if (n !== "" && pin.length < 4) setPin(p => p + n);
                  setLoginErr("");
                }}
                style={{
                  padding: "18px 0", borderRadius: 14, border: `1px solid ${C.gray200}`,
                  fontSize: 20, fontWeight: 900, background: n === "" ? "transparent" : C.white,
                  color: n === "⌫" ? C.gray400 : C.gray800,
                  cursor: n === "" ? "default" : "pointer",
                  visibility: n === "" ? "hidden" : "visible",
                  boxShadow: n !== "" ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                }}>
                {n}
              </button>
            ))}
          </div>
        </div>

        {loginErr && (
          <div style={{ background: "#FEF2F2", border: `1px solid #FECACA`, borderRadius: 12, padding: "12px 16px", marginBottom: 16, textAlign: "center" }}>
            <p style={{ color: C.red, fontSize: 13, fontWeight: 700, margin: 0 }}>⚠️ {loginErr}</p>
          </div>
        )}

        <button onClick={login} disabled={loginLoading || dni.length < 7 || pin.length < 4}
          style={{ width: "100%", padding: "16px 0", borderRadius: 16, border: "none", background: C.navy, color: "white", fontSize: 16, fontWeight: 900, cursor: "pointer", opacity: (loginLoading || dni.length < 7 || pin.length < 4) ? 0.4 : 1 }}>
          {loginLoading ? "Verificando..." : "INGRESAR →"}
        </button>

        <p style={{ textAlign: "center", color: C.gray400, fontSize: 12, marginTop: 24 }}>
          ¿Problemas? Llama: <a href="tel:966707225" style={{ color: C.navy, fontWeight: 700 }}>966 707 225</a>
        </p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // APP PRINCIPAL
  // ══════════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.gray50, fontFamily: "system-ui,sans-serif", maxWidth: 500, margin: "0 auto" }}>

      {/* ── HEADER ── */}
      <div style={{ background: C.navy, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, color: "white", fontSize: 15 }}>
            {conductor.nombre.charAt(0)}
          </div>
          <div>
            <p style={{ color: "white", fontWeight: 900, fontSize: 14, margin: 0 }}>{conductor.nombre.split(" ").slice(0,2).join(" ")}</p>
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, margin: 0 }}>
              {enRuta ? <span style={{ color: "#4ade80", fontWeight: 700 }}>● En Ruta</span> : "● Disponible"}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {enRuta && (
            <div style={{ background: "rgba(22,163,74,0.2)", border: "1px solid #4ade80", borderRadius: 8, padding: "4px 10px" }}>
              <p style={{ color: "#4ade80", fontSize: 12, fontWeight: 900, margin: 0 }}>{velocidad} km/h</p>
            </div>
          )}
          <button onClick={cerrarSesion} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "6px 12px", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Salir
          </button>
        </div>
      </div>

      {/* ── CONTENIDO ── */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>

        {/* ════ RUTA ════ */}
        {tab === "ruta" && (
          <div style={{ padding: 16 }}>

            {/* Banner checklist pendiente */}
            {!checkDone && (
              <div onClick={() => setTab("checklist")} style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 14, padding: "12px 16px", marginBottom: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>⚠️</span>
                <div>
                  <p style={{ color: "#92400E", fontWeight: 900, fontSize: 13, margin: 0 }}>Checklist pendiente</p>
                  <p style={{ color: "#B45309", fontSize: 11, margin: "2px 0 0" }}>Completa la inspección antes de iniciar</p>
                </div>
              </div>
            )}

            {/* Alerta licencia */}
            {conductor.vencimiento_licencia && (diasPara(conductor.vencimiento_licencia) ?? 999) <= 60 && (
              <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 14, padding: "12px 16px", marginBottom: 12 }}>
                <p style={{ color: C.red, fontWeight: 900, fontSize: 13, margin: 0 }}>
                  {(diasPara(conductor.vencimiento_licencia) ?? 0) < 0 ? "🚨 Licencia VENCIDA" : `⚠️ Licencia vence en ${diasPara(conductor.vencimiento_licencia)} días`}
                </p>
              </div>
            )}

            {/* Selección vehículo */}
            {!enRuta && (
              <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>🚌 Vehículo asignado</p>
                <select value={vehiculoId || ""} onChange={e => setVehiculoId(Number(e.target.value) || null)}
                  style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: `2px solid ${vehiculoId ? C.navy : C.gray200}`, fontSize: 15, fontWeight: 700, color: C.gray800, background: C.white, outline: "none" }}>
                  <option value="">Seleccionar vehículo...</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca || ""}</option>)}
                </select>
                {vehSel && (
                  <div style={{ marginTop: 10, padding: "8px 12px", background: C.gray50, borderRadius: 10, display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: C.gray600, fontSize: 12 }}>Placa seleccionada</span>
                    <span style={{ color: C.navy, fontSize: 14, fontWeight: 900, fontFamily: "monospace" }}>{vehSel.placa}</span>
                  </div>
                )}
              </div>
            )}

            {/* Servicios del día */}
            <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>
              Hoja de Ruta — {new Date().toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" })}
            </p>

            {/* ✅ Indicador de carga */}
            {cargando ? (
              <div style={{ background: C.white, borderRadius: 16, padding: 24, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <div style={{ width: 28, height: 28, border: `3px solid ${C.gray200}`, borderTop: `3px solid ${C.navy}`, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 10px" }} />
                <p style={{ color: C.gray400, fontSize: 13, margin: 0 }}>Cargando servicios...</p>
              </div>
            ) : reservasHoy.length === 0 ? (
              <div style={{ background: C.white, borderRadius: 16, padding: 32, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 36, marginBottom: 8 }}>📋</p>
                <p style={{ color: C.gray600, fontWeight: 700, margin: 0 }}>Sin servicios programados hoy</p>
                {/* ✅ Mostrar fecha que se consultó para debug */}
                <p style={{ color: C.gray400, fontSize: 11, marginTop: 8 }}>Consultando: {debugFecha}</p>
                <button
                  onClick={() => conductor && cargarDatos(conductor.id)}
                  style={{ marginTop: 14, padding: "10px 20px", borderRadius: 12, border: `1px solid ${C.navy}`, background: C.white, color: C.navy, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                  🔄 Actualizar
                </button>
              </div>
            ) : reservasHoy.map(r => {
              const esActiva = reservaActiva?.id === r.id;
              return (
                <div key={r.id} style={{ background: C.white, borderRadius: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", overflow: "hidden", border: esActiva ? `2px solid ${C.navy}` : `1px solid ${C.gray200}` }}>
                  <div style={{ height: 4, background: esActiva ? C.navy : C.gray200 }} />
                  <div style={{ padding: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div>
                        <p style={{ color: C.gray800, fontWeight: 900, fontSize: 16, margin: 0 }}>{r.origen}</p>
                        <p style={{ color: C.gray600, fontSize: 13, margin: "4px 0 0" }}>→ {r.destino}</p>
                      </div>
                      {esActiva
                        ? <Pill color="white" bg={C.navy}>EN RUTA</Pill>
                        : r.hora_servicio && <Pill color={C.navy} bg={C.gray100}>🕐 {r.hora_servicio}</Pill>}
                    </div>

                    {esActiva ? (
                      <button onClick={() => setTab("paradas")}
                        style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: C.navy, color: "white", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>
                        Ver recorrido →
                      </button>
                    ) : (
                      <button onClick={() => iniciarRecorrido(r)} disabled={iniciando || !vehiculoId}
                        style={{ width: "100%", padding: "14px 0", borderRadius: 12, border: "none", background: vehiculoId ? C.navy : C.gray200, color: vehiculoId ? "white" : C.gray400, fontSize: 15, fontWeight: 900, cursor: vehiculoId ? "pointer" : "not-allowed" }}>
                        {iniciando ? "📍 Obteniendo GPS..." : "▶ INICIAR RECORRIDO"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Stats GPS */}
            {enRuta && (
              <div style={{ background: C.white, borderRadius: 16, padding: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", marginTop: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { label: "Velocidad",    val: `${velocidad} km/h`,                                                        color: C.navy  },
                    { label: "Señales GPS",  val: String(totalEnvios),                                                         color: C.green },
                    { label: "Último envío", val: ultimoEnvio?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—", color: C.gray600 },
                    { label: "Precisión",    val: posActual ? `±${Math.round(posActual.coords.accuracy)}m` : "—",              color: C.gray600 },
                  ].map(s => (
                    <div key={s.label} style={{ background: C.gray50, borderRadius: 12, padding: "10px 14px" }}>
                      <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, textTransform: "uppercase", margin: 0 }}>{s.label}</p>
                      <p style={{ color: s.color, fontSize: 18, fontWeight: 900, margin: "4px 0 0" }}>{s.val}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════ PARADAS ════ */}
        {tab === "paradas" && (
          <div style={{ padding: 16 }}>
            {!enRuta ? (
              <div style={{ textAlign: "center", padding: 40 }}>
                <p style={{ fontSize: 36 }}>🗺️</p>
                <p style={{ color: C.gray600, fontWeight: 700 }}>Inicia un recorrido desde la Hoja de Ruta</p>
                <button onClick={() => setTab("ruta")} style={{ marginTop: 16, padding: "10px 24px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 700, cursor: "pointer" }}>Ir a Ruta →</button>
              </div>
            ) : paradas.length === 0 ? (
              <div>
                <div style={{ background: C.white, borderRadius: 16, padding: 20, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, animation: "pulse 1s infinite" }} />
                    <p style={{ color: C.green, fontWeight: 900, margin: 0 }}>GPS Activo — Viaje en curso</p>
                  </div>
                  <p style={{ color: C.navy, fontWeight: 900, fontSize: 18, margin: "0 0 4px" }}>{reservaActiva?.origen}</p>
                  <p style={{ color: C.gray600, fontSize: 14, margin: 0 }}>→ {reservaActiva?.destino}</p>
                  <div style={{ marginTop: 16, textAlign: "center" }}>
                    <p style={{ fontSize: 56, fontWeight: 900, color: C.navy, margin: 0, lineHeight: 1 }}>{velocidad}</p>
                    <p style={{ color: C.gray400, fontWeight: 700, margin: "4px 0 0" }}>km/h</p>
                  </div>

                  {/* 🗺️ Navegación al destino final */}
                  {reservaActiva?.destino && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.gray100}` }}>
                      <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>Navegar al destino</p>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <button
                          onClick={() => {
                            const dest = encodeURIComponent(reservaActiva.destino + ", Lima, Peru");
                            window.open(`https://waze.com/ul?q=${dest}&navigate=yes`, "_blank");
                          }}
                          style={{ padding: "12px 0", borderRadius: 12, border: "none", background: "#33CCFF", color: "#0b1b2e", fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
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
                          onClick={() => {
                            const dest = encodeURIComponent(reservaActiva.destino + ", Lima, Peru");
                            const origin = posRef.current ? `&origin=${posRef.current.coords.latitude},${posRef.current.coords.longitude}` : "";
                            window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}${origin}&travelmode=driving`, "_blank");
                          }}
                          style={{ padding: "12px 0", borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, color: C.navy, fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                          <svg width="14" height="17" viewBox="0 0 18 22" fill="none">
                            <path d="M9 0C4.03 0 0 4.03 0 9c0 6.75 9 13 9 13s9-6.25 9-13c0-4.97-4.03-9-9-9z" fill="#EA4335"/>
                            <circle cx="9" cy="9" r="3.5" fill="white"/>
                          </svg>
                          Maps
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button onClick={finalizarRecorrido} style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: `2px solid #FECACA`, background: "#FEF2F2", color: C.red, fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
                  ⏹ Finalizar recorrido
                </button>
              </div>
            ) : (
              <div>
                {/* ── 🗺️ TARJETA DE NAVEGACIÓN (estilo Uber conductor) ── */}
                {paradaActual && (
                  <div style={{
                    background: C.navy, borderRadius: 18, padding: 16, marginBottom: 12,
                    boxShadow: "0 4px 20px rgba(11,49,95,0.25)",
                  }}>
                    {/* Label destino */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 6px #4ade80" }} />
                      <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>
                        Siguiente parada · {paradaIdx + 1} de {paradas.length}
                      </p>
                    </div>

                    {/* Nombre y dirección */}
                    <p style={{ color: "white", fontWeight: 900, fontSize: 20, margin: "0 0 2px", lineHeight: 1.2 }}>
                      {paradaActual.nombre}
                    </p>
                    {paradaActual.direccion && (
                      <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, margin: "0 0 14px" }}>
                        📍 {paradaActual.direccion}
                      </p>
                    )}
                    {paradaActual.hora_estimada && (
                      <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, margin: "0 0 14px" }}>
                        🕐 Llegada estimada: <span style={{ color: "white", fontWeight: 700 }}>{paradaActual.hora_estimada}</span>
                      </p>
                    )}

                    {/* Botones de navegación */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {/* Waze */}
                      <button
                        onClick={() => abrirWaze(paradaActual)}
                        style={{
                          padding: "13px 0", borderRadius: 14, border: "none",
                          background: "#33CCFF", color: "#0b1b2e",
                          fontWeight: 900, fontSize: 15, cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                          boxShadow: "0 2px 10px rgba(51,204,255,0.4)",
                        }}>
                        {/* Waze logo SVG inline */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="10" r="8" fill="#33CCFF" stroke="#0b1b2e" strokeWidth="1.5"/>
                          <ellipse cx="12" cy="10" rx="5" ry="5" fill="white"/>
                          <circle cx="10.2" cy="9" r="1.1" fill="#0b1b2e"/>
                          <circle cx="13.8" cy="9" r="1.1" fill="#0b1b2e"/>
                          <path d="M9.5 11.5 Q12 13.5 14.5 11.5" stroke="#0b1b2e" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
                          <path d="M8 18 Q12 22 16 18" stroke="#0b1b2e" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                        </svg>
                        Waze
                      </button>

                      {/* Google Maps */}
                      <button
                        onClick={() => abrirGoogleMaps(paradaActual)}
                        style={{
                          padding: "13px 0", borderRadius: 14, border: "none",
                          background: "white", color: C.navy,
                          fontWeight: 900, fontSize: 15, cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                          boxShadow: "0 2px 10px rgba(255,255,255,0.2)",
                        }}>
                        {/* Google Maps pin SVG inline */}
                        <svg width="18" height="20" viewBox="0 0 18 22" fill="none">
                          <path d="M9 0C4.03 0 0 4.03 0 9c0 6.75 9 13 9 13s9-6.25 9-13c0-4.97-4.03-9-9-9z" fill="#EA4335"/>
                          <circle cx="9" cy="9" r="3.5" fill="white"/>
                        </svg>
                        Google Maps
                      </button>
                    </div>

                    {/* Info velocidad actual */}
                    {enRuta && velocidad > 0 && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>Velocidad actual</span>
                        <span style={{ color: "#4ade80", fontWeight: 900, fontSize: 14 }}>{velocidad} km/h</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Progreso */}
                <div style={{ background: C.white, borderRadius: 16, padding: "14px 16px", marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <p style={{ color: C.gray600, fontSize: 12, fontWeight: 700, margin: 0 }}>Progreso del recorrido</p>
                    <p style={{ color: C.navy, fontSize: 12, fontWeight: 900, margin: 0 }}>{paradaIdx + 1} / {paradas.length} paradas</p>
                  </div>
                  <div style={{ height: 6, background: C.gray100, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", background: C.navy, borderRadius: 3, width: `${((paradaIdx) / paradas.length) * 100}%`, transition: "width 0.5s" }} />
                  </div>
                </div>

                {/* Timeline */}
                <div style={{ display: "flex", gap: 16 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0, paddingTop: 4 }}>
                    {paradas.map((p, i) => (
                      <div key={p.id} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <div style={{
                          width: i === paradaIdx ? 24 : 18, height: i === paradaIdx ? 24 : 18,
                          borderRadius: "50%",
                          background: p.estado === "completada" ? C.navy : i === paradaIdx ? C.navy : C.gray200,
                          border: i === paradaIdx ? `3px solid ${C.navy}` : "none",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          boxShadow: i === paradaIdx ? `0 0 0 4px rgba(11,49,95,0.2)` : "none",
                          transition: "all 0.3s",
                        }}>
                          {p.estado === "completada" && <span style={{ color: "white", fontSize: 10, fontWeight: 900 }}>✓</span>}
                        </div>
                        {i < paradas.length - 1 && <div style={{ width: 2, height: 60, background: p.estado === "completada" ? C.navy : C.gray200, transition: "background 0.3s" }} />}
                      </div>
                    ))}
                  </div>

                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                    {paradas.map((p, i) => {
                      const esActual = i === paradaIdx;
                      const pp = pasajeros.filter(x => x.parada_id === p.id);
                      const emb = pp.filter(x => x.estado === "embarcado").length;
                      return (
                        <div key={p.id} style={{
                          background: esActual ? C.white : p.estado === "completada" ? C.gray50 : C.white,
                          borderRadius: 14,
                          border: esActual ? `2px solid ${C.navy}` : `1px solid ${C.gray200}`,
                          padding: esActual ? 16 : "10px 14px",
                          opacity: p.estado === "completada" ? 0.6 : 1,
                          boxShadow: esActual ? "0 4px 16px rgba(11,49,95,0.15)" : "none",
                          transition: "all 0.3s",
                          minHeight: 60,
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div>
                              <p style={{ color: esActual ? C.navy : C.gray800, fontWeight: esActual ? 900 : 700, fontSize: esActual ? 16 : 14, margin: 0 }}>{p.nombre}</p>
                              {p.hora_estimada && <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>🕐 {p.hora_estimada}</p>}
                              {pp.length > 0 && <p style={{ color: C.gray600, fontSize: 11, margin: "4px 0 0" }}>{emb}/{pp.length} pasajeros</p>}
                            </div>
                            {p.estado === "completada"
                              ? <Pill color="white" bg={C.navy}>✓ Completada</Pill>
                              : esActual ? <Pill color={C.navy} bg={C.gray100}>● Actual</Pill>
                              : <Pill color={C.gray400} bg={C.gray100}>Próxima</Pill>}
                          </div>

                          {/* Panel parada actual */}
                          {esActual && (
                            <div style={{ marginTop: 14 }}>
                              {/* Lista pasajeros */}
                              {pp.length > 0 && (
                                <div style={{ marginBottom: 12 }}>
                                  {pp.map(x => (
                                    <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.gray100}` }}>
                                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: x.estado === "embarcado" ? "#DCFCE7" : C.gray100, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                                        {x.estado === "embarcado" ? "✅" : "👤"}
                                      </div>
                                      <div style={{ flex: 1 }}>
                                        <p style={{ color: C.gray800, fontWeight: 700, fontSize: 13, margin: 0 }}>{x.pasajero?.nombre || `Pasajero #${x.pasajero_id}`}</p>
                                        {x.pasajero?.empresa && <p style={{ color: C.gray400, fontSize: 11, margin: 0 }}>{x.pasajero.empresa}</p>}
                                      </div>
                                      <Pill color={x.estado === "embarcado" ? C.green : C.gray400} bg={x.estado === "embarcado" ? "#DCFCE7" : C.gray100}>
                                        {x.estado === "embarcado" ? "A bordo" : "Esperando"}
                                      </Pill>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* ✅ Botones de acción - QR RESTAURADO */}
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                                <button onClick={() => setEscanear(true)}
                                  style={{ padding: "12px 0", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                                  <span style={{ fontSize: 18 }}>📷</span> Escanear QR
                                </button>
                                <button onClick={notificarRetraso} disabled={notifEnviada}
                                  style={{ padding: "12px 0", borderRadius: 12, border: `2px solid ${notifEnviada ? C.green : C.gray200}`, background: notifEnviada ? "#DCFCE7" : C.white, color: notifEnviada ? C.green : C.gray600, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                                  {notifEnviada ? "✅ Enviado" : "⏰ Notif. retraso"}
                                </button>
                              </div>

                              <button onClick={() => marcarParadaCompletada(p.id)}
                                style={{ width: "100%", padding: "14px 0", borderRadius: 12, border: "none", background: p.id === paradas[paradas.length - 1]?.id ? "#FEF2F2" : "#DCFCE7", color: p.id === paradas[paradas.length - 1]?.id ? C.red : C.green, fontSize: 14, fontWeight: 900, cursor: "pointer" }}>
                                {p.id === paradas[paradas.length - 1]?.id ? "🏁 Finalizar recorrido" : `✅ Confirmar llegada → Siguiente parada`}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* SOS */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ position: "relative", overflow: "hidden", borderRadius: 16 }}>
                    {sosActivo && (
                      <div style={{ position: "absolute", top: 0, left: 0, height: "100%", background: "rgba(0,0,0,0.3)", width: `${sosPct}%`, zIndex: 1, borderRadius: 16 }} />
                    )}
                    <button
                      onMouseDown={iniciarSOS} onMouseUp={cancelarSOS} onTouchStart={iniciarSOS} onTouchEnd={cancelarSOS}
                      style={{
                        width: "100%", padding: "16px 0", borderRadius: 16, border: "none",
                        background: sosEnviado ? C.green : sosActivo ? "#7F1D1D" : C.red,
                        color: "white", fontSize: 16, fontWeight: 900, cursor: "pointer",
                        position: "relative", zIndex: 2,
                        boxShadow: sosActivo ? `0 0 30px rgba(220,38,38,0.7)` : "none",
                        transition: "background 0.2s",
                      }}>
                      {sosEnviado ? "✅ SOS ENVIADO — Central notificada" : sosActivo ? `Mantén presionado... ${Math.round(sosPct)}%` : "🆘 EMERGENCIA / SOS"}
                    </button>
                  </div>
                  {!sosActivo && !sosEnviado && <p style={{ textAlign: "center", color: C.gray400, fontSize: 11, marginTop: 6 }}>Mantén presionado 2 segundos para activar</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════ CHECKLIST ════ */}
        {tab === "checklist" && (
          <div style={{ padding: 16 }}>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ color: C.gray800, fontWeight: 900, fontSize: 20, margin: 0 }}>Checklist Pre-Servicio</h2>
              <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>Inspección obligatoria · Se reporta al ERP</p>
            </div>

            {checkDone ? (
              <div style={{ background: C.white, borderRadius: 16, padding: 32, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 40, margin: "0 0 12px" }}>✅</p>
                <p style={{ color: C.navy, fontWeight: 900, fontSize: 18, margin: 0 }}>Checklist completado hoy</p>
                <p style={{ color: C.gray400, fontSize: 13, margin: "8px 0 20px" }}>La unidad fue inspeccionada</p>
                <button onClick={() => { setCheckDone(false); setChecks(CHECKLIST_ITEMS.map(i => ({ ...i }))); }}
                  style={{ padding: "10px 24px", borderRadius: 12, border: `1px solid ${C.navy}`, background: C.white, color: C.navy, fontWeight: 700, cursor: "pointer" }}>
                  Hacer nuevo checklist
                </button>
              </div>
            ) : (
              <>
                <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  <select value={vehiculoId || ""} onChange={e => setVehiculoId(Number(e.target.value) || null)}
                    style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 14, fontWeight: 700, color: C.gray800, marginBottom: 10, outline: "none", boxSizing: "border-box" }}>
                    <option value="">Seleccionar vehículo...</option>
                    {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria}</option>)}
                  </select>
                  <input type="number" placeholder="Km de inicio (ej: 152430)" value={kmInicio} onChange={e => setKmInicio(e.target.value)}
                    style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 14, fontWeight: 700, color: C.gray800, outline: "none", boxSizing: "border-box", fontFamily: "monospace" }} />
                </div>

                <div style={{ background: C.white, borderRadius: 14, padding: "12px 16px", marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, height: 8, background: C.gray100, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", background: checkFallas > 0 ? C.amber : C.navy, borderRadius: 4, width: `${checkPct}%`, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ color: C.navy, fontWeight: 900, fontSize: 14, flexShrink: 0 }}>{checkPct}%</span>
                  {checkFallas > 0 && <span style={{ color: C.red, fontWeight: 900, fontSize: 13, flexShrink: 0 }}>{checkFallas} falla{checkFallas > 1 ? "s" : ""}</span>}
                </div>

                {categorias.map(cat => (
                  <div key={cat} style={{ background: C.white, borderRadius: 16, padding: "12px 16px", marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                    <p style={{ color: C.gray800, fontWeight: 900, fontSize: 13, margin: "0 0 10px" }}>{cat}</p>
                    {checks.filter(c => c.categoria === cat).map(item => (
                      <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.gray100}` }}>
                        <p style={{ flex: 1, color: C.gray700, fontSize: 13, margin: 0 }}>{item.label}</p>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: true } : c))}
                            style={{ width: 36, height: 36, borderRadius: 10, border: "none", background: item.ok === true ? C.navy : C.gray100, color: item.ok === true ? "white" : C.gray400, fontWeight: 900, cursor: "pointer", fontSize: 14 }}>✓</button>
                          <button onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: false } : c))}
                            style={{ width: 36, height: 36, borderRadius: 10, border: "none", background: item.ok === false ? C.red : C.gray100, color: item.ok === false ? "white" : C.gray400, fontWeight: 900, cursor: "pointer", fontSize: 14 }}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                {checkFallas > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <textarea rows={3} placeholder="Describe las fallas detectadas..." value={checkObs} onChange={e => setCheckObs(e.target.value)}
                      style={{ width: "100%", padding: "14px", borderRadius: 14, border: `2px solid ${C.red}`, fontSize: 13, color: C.gray800, resize: "none", outline: "none", boxSizing: "border-box" }} />
                  </div>
                )}

                <button onClick={guardarChecklist} disabled={checkSaving || !vehiculoId}
                  style={{ width: "100%", padding: "16px 0", borderRadius: 14, border: "none", background: vehiculoId ? C.navy : C.gray200, color: "white", fontSize: 15, fontWeight: 900, cursor: vehiculoId ? "pointer" : "not-allowed" }}>
                  {checkSaving ? "Guardando..." : "✅ Enviar checklist al ERP"}
                </button>
              </>
            )}
          </div>
        )}

        {/* ════ DOCUMENTOS ════ */}
        {tab === "documentos" && (
          <div style={{ padding: 16 }}>
            <h2 style={{ color: C.gray800, fontWeight: 900, fontSize: 20, margin: "0 0 16px" }}>Mis Documentos</h2>
            <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>Estado de documentos</p>
              {[
                { label: "🪪 Licencia MTC",   fecha: conductor.vencimiento_licencia || null },
                { label: "🏥 SCTR Salud",     fecha: conductor.sctr_salud_venc || null },
                { label: "🩺 Examen médico",  fecha: conductor.examen_medico_venc || null },
              ].map(d => {
                const est = docEstado(d.fecha);
                const dias = diasPara(d.fecha);
                const cfg = {
                  ok:      { color: C.green, bg: "#DCFCE7", txt: dias !== null ? `Vence en ${dias}d` : "OK" },
                  pronto:  { color: C.amber, bg: "#FEF3C7", txt: `⚠ ${dias}d` },
                  vencido: { color: C.red,   bg: "#FEF2F2", txt: `🚨 Vencida` },
                  sin:     { color: C.gray400, bg: C.gray100, txt: "Sin fecha" },
                }[est];
                return (
                  <div key={d.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.gray100}` }}>
                    <span style={{ color: C.gray700, fontSize: 13 }}>{d.label}</span>
                    <Pill color={cfg.color} bg={cfg.bg}>{cfg.txt}</Pill>
                  </div>
                );
              })}
            </div>

            <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 12px" }}>Registrar documento (URL)</p>
              <select value={docTipo} onChange={e => setDocTipo(e.target.value)}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 13, color: C.gray800, outline: "none", marginBottom: 8, boxSizing: "border-box" }}>
                {TIPOS_DOC.map(t => <option key={t}>{t}</option>)}
              </select>
              <input placeholder="URL del documento (Google Drive, Dropbox...)" value={docUrl} onChange={e => setDocUrl(e.target.value)}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 13, color: C.gray800, outline: "none", marginBottom: 8, boxSizing: "border-box" }} />
              <input type="date" value={docVenc} onChange={e => setDocVenc(e.target.value)}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 13, color: C.gray800, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />
              <button onClick={subirDoc} disabled={docSaving || !docUrl}
                style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: docUrl ? C.navy : C.gray200, color: "white", fontWeight: 700, cursor: docUrl ? "pointer" : "not-allowed" }}>
                {docSaving ? "Guardando..." : "📤 Registrar"}
              </button>
            </div>

            {docs.map(d => (
              <div key={d.id} style={{ background: C.white, borderRadius: 14, padding: "12px 16px", marginBottom: 8, boxShadow: "0 1px 6px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <p style={{ color: C.gray800, fontWeight: 700, fontSize: 13, margin: 0 }}>{d.tipo}</p>
                  {d.vencimiento && <p style={{ color: docEstado(d.vencimiento) === "vencido" ? C.red : C.gray400, fontSize: 11, margin: "2px 0 0" }}>Vence: {new Date(d.vencimiento + "T00:00:00").toLocaleDateString("es-PE")}</p>}
                </div>
                <a href={d.url} target="_blank" rel="noreferrer" style={{ padding: "6px 14px", borderRadius: 10, border: `1px solid ${C.navy}`, color: C.navy, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>Ver →</a>
              </div>
            ))}
          </div>
        )}

        {/* ════ PERFIL ════ */}
        {tab === "perfil" && (
          <div style={{ padding: 16 }}>
            <div style={{ background: C.navy, borderRadius: 20, padding: 20, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 60, height: 60, borderRadius: 16, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, color: "white" }}>{conductor.nombre.charAt(0)}</div>
                <div>
                  <p style={{ color: "white", fontWeight: 900, fontSize: 18, margin: 0 }}>{conductor.nombre}</p>
                  <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, margin: "2px 0 0" }}>DNI: {conductor.dni}</p>
                  {conductor.licencia && <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, margin: "2px 0 0" }}>Lic. {conductor.licencia} · {conductor.categoria_licencia}</p>}
                </div>
              </div>
            </div>

            <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: camPin ? 12 : 0 }}>
                <p style={{ color: C.gray800, fontWeight: 700, fontSize: 14, margin: 0 }}>🔑 Cambiar PIN</p>
                <button onClick={() => setCamPin(v => !v)} style={{ background: "none", border: "none", color: C.navy, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{camPin ? "Cancelar" : "Cambiar"}</button>
              </div>
              {camPin && (
                <div>
                  {["Nuevo PIN (4 dígitos)", "Confirmar PIN"].map((ph, i) => (
                    <input key={i} type="password" inputMode="numeric" maxLength={4} placeholder={ph}
                      value={i === 0 ? pinNuevo : pinConfirm}
                      onChange={e => i === 0 ? setPinNuevo(e.target.value.replace(/\D/g,"").slice(0,4)) : setPinConfirm(e.target.value.replace(/\D/g,"").slice(0,4))}
                      style={{ width: "100%", padding: "12px", borderRadius: 12, border: `1px solid ${C.gray200}`, fontSize: 18, textAlign: "center", letterSpacing: 6, marginBottom: 8, outline: "none", boxSizing: "border-box" }} />
                  ))}
                  {pinMsg && <p style={{ color: pinMsg.includes("✅") ? C.green : C.red, fontWeight: 700, textAlign: "center", fontSize: 13 }}>{pinMsg}</p>}
                  <button onClick={cambiarPin} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 700, cursor: "pointer" }}>Guardar PIN</button>
                </div>
              )}
            </div>

            <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <p style={{ color: C.gray600, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>Información</p>
              {[
                ["📡 Señales GPS enviadas hoy", String(totalEnvios)],
                ["📅 Fecha del sistema",         debugFecha],
                ["📱 Versión App",               "2.1 Pro"],
              ].map(([label, val]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.gray100}` }}>
                  <span style={{ color: C.gray600, fontSize: 13 }}>{label}</span>
                  <span style={{ color: C.navy, fontWeight: 700, fontSize: 13 }}>{val}</span>
                </div>
              ))}
            </div>

            <button onClick={cerrarSesion} style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: `2px solid #FECACA`, background: "#FEF2F2", color: C.red, fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
              Cerrar sesión
            </button>
          </div>
        )}
      </div>

      {/* ── NAV BAR ── */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.gray200}`, display: "flex", zIndex: 20, boxShadow: "0 -2px 12px rgba(0,0,0,0.08)", maxWidth: 500, margin: "0 auto" }}>
        {([
          { id: "ruta"       as Tab, icon: "🏠", label: "Ruta" },
          { id: "paradas"    as Tab, icon: "🗺️", label: "Paradas", badge: enRuta && paradaActual ? paradas.length - paradaIdx : 0 },
          { id: "checklist"  as Tab, icon: "✅", label: "Checklist", badge: checkDone ? 0 : 1 },
          { id: "documentos" as Tab, icon: "📄", label: "Docs", badge: docsBadge },
          { id: "perfil"     as Tab, icon: "👤", label: "Perfil" },
        ]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, border: "none", background: "none", cursor: "pointer", padding: 0 }}>
            <NavBtn active={tab === t.id} icon={t.icon} label={t.label} badge={t.badge as number | undefined} />
          </button>
        ))}
      </div>

      {/* ── ✅ QR SCANNER OVERLAY (RESTAURADO) ── */}
      {escanear && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.95)", zIndex: 100, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <p style={{ color: "white", fontWeight: 900, fontSize: 18, margin: 0 }}>Escanear código QR</p>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, margin: "4px 0 0" }}>Apunta al código QR del pasajero</p>
          </div>
          <div style={{ position: "relative" }}>
            {/* ✅ El id="qr-container" debe existir en el DOM ANTES de que html5-qrcode intente usarlo */}
            <div id="qr-container" style={{ width: 300, height: 300, borderRadius: 16, overflow: "hidden" }} />
            {/* Marco guía */}
            <div style={{ position: "absolute", inset: 0, border: `3px solid ${C.navy}`, borderRadius: 16, pointerEvents: "none" }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{
                  position: "absolute", width: 30, height: 30,
                  borderColor: C.navy, borderStyle: "solid",
                  ...(i === 0 ? { top: 0, left: 0, borderWidth: "4px 0 0 4px", borderRadius: "4px 0 0 0" }
                    : i === 1 ? { top: 0, right: 0, borderWidth: "4px 4px 0 0", borderRadius: "0 4px 0 0" }
                    : i === 2 ? { bottom: 0, left: 0, borderWidth: "0 0 4px 4px", borderRadius: "0 0 0 4px" }
                    : { bottom: 0, right: 0, borderWidth: "0 4px 4px 0", borderRadius: "0 0 4px 0" }),
                }} />
              ))}
            </div>
          </div>
          <button onClick={() => setEscanear(false)}
            style={{ marginTop: 32, padding: "12px 32px", borderRadius: 14, border: "none", background: "rgba(255,255,255,0.15)", color: "white", fontWeight: 700, cursor: "pointer" }}>
            Cancelar
          </button>
        </div>
      )}

      {/* ── ✅ VALIDACIÓN PASAJERO ── */}
      {validando && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div style={{ background: C.white, borderRadius: "24px 24px 0 0", padding: 28, width: "100%", maxWidth: 500 }}>
            <div style={{ width: 40, height: 4, background: C.gray200, borderRadius: 2, margin: "0 auto 20px" }} />
            <p style={{ color: C.navy, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 16px" }}>Validación de identidad</p>

            <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 20 }}>
              <div style={{ width: 64, height: 64, borderRadius: 16, background: C.gray100, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0, overflow: "hidden" }}>
                {validando.foto_url
                  ? <img src={validando.foto_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : "👤"}
              </div>
              <div>
                <p style={{ color: C.gray800, fontWeight: 900, fontSize: 20, margin: 0 }}>{validando.nombre}</p>
                {validando.empresa && <p style={{ color: C.gray600, fontSize: 14, margin: "4px 0 0" }}>🏢 {validando.empresa}</p>}
                {validando.dni && <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>DNI: {validando.dni}</p>}
              </div>
            </div>

            {(() => {
              const pp = pasajeros.find(p => p.pasajero_id === validando.id && p.parada_id === paradaActual?.id);
              return pp ? (
                <div style={{ background: pp.estado === "embarcado" ? "#DCFCE7" : "#FEF3C7", borderRadius: 12, padding: "10px 16px", marginBottom: 20 }}>
                  <p style={{ color: pp.estado === "embarcado" ? C.green : C.amber, fontWeight: 700, fontSize: 13, margin: 0 }}>
                    {pp.estado === "embarcado" ? "✅ Ya embarcó en esta parada" : "🚶 Esperando embarque"}
                  </p>
                </div>
              ) : (
                <div style={{ background: C.gray50, borderRadius: 12, padding: "10px 16px", marginBottom: 20 }}>
                  <p style={{ color: C.gray600, fontSize: 13, margin: 0 }}>Pasajero encontrado · No asignado a esta parada</p>
                </div>
              );
            })()}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setValidando(null)}
                style={{ padding: "14px 0", borderRadius: 14, border: `1px solid ${C.gray200}`, background: C.white, color: C.gray600, fontWeight: 700, cursor: "pointer" }}>
                Cancelar
              </button>
              <button onClick={() => confirmarEmbarque(validando)}
                style={{ padding: "14px 0", borderRadius: 14, border: "none", background: C.navy, color: "white", fontWeight: 900, cursor: "pointer", fontSize: 15 }}>
                ✅ Confirmar embarque
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MENSAJE BOARDING ── */}
      {boardingMsg && (
        <div style={{
          position: "fixed", top: 70, left: "50%", transform: "translateX(-50%)",
          background: boardingMsg.ok ? C.green : C.red,
          color: "white", borderRadius: 14, padding: "14px 20px",
          fontWeight: 700, fontSize: 14, zIndex: 200,
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)", maxWidth: "90%", textAlign: "center",
        }}>
          {boardingMsg.msg}
        </div>
      )}

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        * { -webkit-tap-highlight-color: transparent; }
        select, input, button { font-family: system-ui, sans-serif; }
      `}</style>
    </div>
  );
}