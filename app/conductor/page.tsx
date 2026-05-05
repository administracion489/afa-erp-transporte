"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Conductor = {
  id: number; nombre: string; dni: string | null;
  telefono: string | null; pin_acceso: string | null; activo_app: boolean;
};
type Vehiculo = { id: number; placa: string; categoria: string | null; };
type Reserva  = { id: number; origen: string; destino: string; fecha_servicio: string | null; vehiculo_id: number | null; };

type Pantalla = "login" | "seleccion" | "tracking";

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ConductorAppPage() {

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [pantalla,    setPantalla]    = useState<Pantalla>("login");
  const [conductor,   setConductor]   = useState<Conductor | null>(null);
  const [dniInput,    setDniInput]    = useState("");
  const [pinInput,    setPinInput]    = useState("");
  const [pinVisible,  setPinVisible]  = useState(false);
  const [loginError,  setLoginError]  = useState("");
  const [loginCarg,   setLoginCarg]   = useState(false);

  // ── Selección servicio ────────────────────────────────────────────────────
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [reservasHoy, setReservasHoy] = useState<Reserva[]>([]);
  const [vehiculoId,  setVehiculoId]  = useState<number | null>(null);
  const [reservaId,   setReservaId]   = useState<number | null>(null);
  const [selError,    setSelError]    = useState("");

  // ── Tracking ──────────────────────────────────────────────────────────────
  const [tracking,    setTracking]    = useState(false);
  const [posActual,   setPosActual]   = useState<GeolocationPosition | null>(null);
  const [gpsError,    setGpsError]    = useState<string | null>(null);
  const [ultimoEnvio, setUltimoEnvio] = useState<Date | null>(null);
  const [totalEnvios, setTotalEnvios] = useState(0);
  const [velocidad,   setVelocidad]   = useState(0);
  const [sosEnviado,  setSosEnviado]  = useState(false);
  const [iniciandoGps,setIniciandoGps]= useState(false);

  const watchId  = useRef<number | null>(null);
  const interval = useRef<NodeJS.Timeout | null>(null);
  const posRef   = useRef<GeolocationPosition | null>(null);

  // ── Login con DNI + PIN ───────────────────────────────────────────────────

  const handleLogin = async () => {
    if (!dniInput.trim() || dniInput.length < 7) { setLoginError("Ingresa tu DNI completo"); return; }
    if (!pinInput || pinInput.length < 4)         { setLoginError("El PIN debe tener 4 dígitos"); return; }
    setLoginError(""); setLoginCarg(true);

    const { data, error } = await supabase
      .from("conductores")
      .select("id,nombre,dni,telefono,pin_acceso,activo_app")
      .eq("dni", dniInput.trim())
      .single();

    if (error || !data) {
      setLoginError("DNI no encontrado. Contacta a tu supervisor.");
      setLoginCarg(false); return;
    }
    if (!data.activo_app) {
      setLoginError("Tu acceso a la app no está activado. Contacta a la central.");
      setLoginCarg(false); return;
    }
    if (!data.pin_acceso) {
      setLoginError("No tienes PIN asignado. Contacta a la central AFA.");
      setLoginCarg(false); return;
    }
    if (data.pin_acceso !== pinInput) {
      setLoginError("PIN incorrecto. Intenta de nuevo.");
      setLoginCarg(false); return;
    }

    // Login exitoso
    setConductor(data);
    await cargarDatosServicio(data.id);
    setPantalla("seleccion");
    setLoginCarg(false);
  };

  // ── Cargar vehículos y reservas del conductor ─────────────────────────────

  const cargarDatosServicio = async (conductorId: number) => {
    const hoy = new Date().toISOString().split("T")[0];
    const [vRes, rRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria").order("placa"),
      supabase.from("reservas")
        .select("id,origen,destino,fecha_servicio,vehiculo_id,conductor_id")
        .eq("fecha_servicio", hoy)
        .order("id", { ascending: false }),
    ]);
    setVehiculos(vRes.data || []);

    // Filtrar reservas del conductor o todas de hoy
    const todasHoy = rRes.data || [];
    const misReservas = todasHoy.filter((r: any) => r.conductor_id === conductorId);
    setReservasHoy(misReservas.length > 0 ? misReservas : todasHoy);

    // Auto-seleccionar si tiene una sola reserva
    if (misReservas.length === 1) {
      setReservaId(misReservas[0].id);
      if (misReservas[0].vehiculo_id) setVehiculoId(misReservas[0].vehiculo_id);
    }
  };

  // ── Enviar ubicación ──────────────────────────────────────────────────────

  const enviarUbicacion = async (pos: GeolocationPosition, estado = "en_ruta") => {
    if (!vehiculoId || !conductor) return;
    const { coords } = pos;
    await supabase.from("ubicaciones_gps").insert({
      vehiculo_id:  vehiculoId,
      conductor_id: conductor.id,
      reserva_id:   reservaId,
      lat:          coords.latitude,
      lng:          coords.longitude,
      velocidad:    coords.speed ? Math.round(coords.speed * 3.6) : 0,
      rumbo:        coords.heading || 0,
      precision_m:  coords.accuracy,
      estado,
    });
    setUltimoEnvio(new Date());
    setTotalEnvios(p => p + 1);
    setVelocidad(coords.speed ? Math.round(coords.speed * 3.6) : 0);
  };

  // ── Iniciar tracking GPS ──────────────────────────────────────────────────

  const iniciarTracking = () => {
    if (!vehiculoId) { setSelError("Selecciona el vehículo que vas a conducir"); return; }
    if (!navigator.geolocation) { setSelError("GPS no disponible en este dispositivo"); return; }
    setSelError(""); setIniciandoGps(true);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        posRef.current = pos; setPosActual(pos);
        enviarUbicacion(pos);
        setIniciandoGps(false); setTracking(true);
        setPantalla("tracking");

        watchId.current = navigator.geolocation.watchPosition(
          (p) => { posRef.current = p; setPosActual(p); },
          (e) => setGpsError(`GPS: ${e.message}`),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
        interval.current = setInterval(() => {
          if (posRef.current) enviarUbicacion(posRef.current);
        }, 10000);
      },
      (e) => {
        setIniciandoGps(false);
        setSelError(`No se pudo obtener GPS: ${e.message}. Activa el GPS del celular.`);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  // ── Finalizar servicio ────────────────────────────────────────────────────

  const finalizarServicio = async () => {
    if (!confirm("¿Finalizar el servicio?")) return;
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    if (interval.current) clearInterval(interval.current);
    if (posRef.current) await enviarUbicacion(posRef.current, "finalizado");
    setTracking(false); setTotalEnvios(0); setUltimoEnvio(null); setVelocidad(0);
    setPantalla("seleccion");
  };

  // ── Cerrar sesión ─────────────────────────────────────────────────────────

  const cerrarSesion = () => {
    if (tracking && !confirm("Tienes un servicio activo. ¿Cerrar sesión de todos modos?")) return;
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    if (interval.current) clearInterval(interval.current);
    setConductor(null); setDniInput(""); setPinInput("");
    setTracking(false); setVehiculoId(null); setReservaId(null);
    setPantalla("login");
  };

  // ── SOS ───────────────────────────────────────────────────────────────────

  const enviarSOS = async () => {
    if (!posRef.current || !vehiculoId) return;
    await enviarUbicacion(posRef.current, "sos");
    setSosEnviado(true);
    setTimeout(() => setSosEnviado(false), 5000);
  };

  useEffect(() => {
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      if (interval.current) clearInterval(interval.current);
    };
  }, []);

  const vehSel = vehiculos.find(v => v.id === vehiculoId);
  const resSel = reservasHoy.find(r => r.id === reservaId);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0f172a", fontFamily: "system-ui, sans-serif" }}>

      {/* HEADER */}
      <div className="px-4 py-4 flex items-center justify-between border-b" style={{ background: "#0b315f", borderColor: "#1e3a5f" }}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">🚌</span>
          <div>
            <h1 className="text-white font-black text-lg leading-tight">App Conductor</h1>
            <p className="text-blue-200 text-xs">AFA Tours Peru</p>
          </div>
        </div>
        {conductor && (
          <button onClick={cerrarSesion} className="text-blue-300 text-xs font-bold px-3 py-1.5 rounded-lg border border-blue-700 hover:bg-blue-900">
            Salir
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">

        {/* ── PANTALLA LOGIN ── */}
        {pantalla === "login" && (
          <div className="flex-1 flex flex-col justify-center p-6 space-y-6">
            <div className="text-center">
              <div className="w-20 h-20 rounded-full flex items-center justify-center text-4xl mx-auto mb-4" style={{ background: "#1e293b" }}>🧑‍✈️</div>
              <h2 className="text-white font-black text-2xl">Iniciar sesión</h2>
              <p className="text-gray-400 text-sm mt-1">Ingresa tu DNI y PIN personal</p>
            </div>

            <div className="space-y-4">
              {/* DNI */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">DNI</label>
                <input
                  type="number" inputMode="numeric" maxLength={8}
                  className="w-full rounded-2xl px-5 py-4 text-xl font-black text-white text-center border-2 tracking-widest"
                  style={{ background: "#1e293b", borderColor: dniInput ? "#3b82f6" : "#334155" }}
                  placeholder="12345678"
                  value={dniInput}
                  onChange={e => { setDniInput(e.target.value.slice(0, 8)); setLoginError(""); }}
                />
              </div>

              {/* PIN */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">PIN (4 dígitos)</label>
                <div className="relative">
                  <input
                    type={pinVisible ? "text" : "password"}
                    inputMode="numeric" maxLength={4}
                    className="w-full rounded-2xl px-5 py-4 text-3xl font-black text-white text-center border-2 tracking-widest pr-16"
                    style={{ background: "#1e293b", borderColor: pinInput ? "#3b82f6" : "#334155" }}
                    placeholder="••••"
                    value={pinInput}
                    onChange={e => { setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4)); setLoginError(""); }}
                    onKeyDown={e => e.key === "Enter" && handleLogin()}
                  />
                  <button onClick={() => setPinVisible(v => !v)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">
                    {pinVisible ? "🙈" : "👁️"}
                  </button>
                </div>

                {/* Teclado numérico visual */}
                <div className="grid grid-cols-3 gap-2 mt-3">
                  {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((n, i) => (
                    <button key={i}
                      onClick={() => {
                        if (n === "⌫") setPinInput(p => p.slice(0, -1));
                        else if (n !== "" && pinInput.length < 4) setPinInput(p => p + String(n));
                        setLoginError("");
                      }}
                      className="py-4 rounded-2xl font-black text-xl transition-all active:scale-95"
                      style={{
                        background: n === "" ? "transparent" : n === "⌫" ? "#1e293b" : "#1e3a5f",
                        color: "white",
                        visibility: n === "" ? "hidden" : "visible",
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Indicador PIN */}
              <div className="flex justify-center gap-3">
                {[0,1,2,3].map(i => (
                  <div key={i} className="w-4 h-4 rounded-full transition-all"
                    style={{ background: i < pinInput.length ? "#3b82f6" : "#334155" }} />
                ))}
              </div>

              {/* Error */}
              {loginError && (
                <div className="rounded-xl px-4 py-3 text-sm font-bold text-red-300 text-center" style={{ background: "#1c0202" }}>
                  ⚠️ {loginError}
                </div>
              )}

              {/* Botón login */}
              <button onClick={handleLogin} disabled={loginCarg || dniInput.length < 7 || pinInput.length < 4}
                className="w-full py-4 rounded-2xl font-black text-lg text-white transition-all active:scale-95 disabled:opacity-40"
                style={{ background: "#0b315f" }}>
                {loginCarg ? "Verificando..." : "INGRESAR →"}
              </button>
            </div>

            <p className="text-center text-gray-500 text-xs">
              ¿Olvidaste tu PIN? Llama a central:<br/>
              <a href="tel:966707225" className="text-blue-400 font-bold">966 707 225</a>
            </p>
          </div>
        )}

        {/* ── PANTALLA SELECCIÓN DE SERVICIO ── */}
        {pantalla === "seleccion" && conductor && (
          <div className="flex-1 flex flex-col p-4 space-y-4">

            {/* Bienvenida */}
            <div className="rounded-2xl p-4 text-center" style={{ background: "#1e293b" }}>
              <p className="text-gray-400 text-sm">Bienvenido,</p>
              <p className="text-white font-black text-xl">{conductor.nombre}</p>
              <p className="text-blue-300 text-xs">{new Date().toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" })}</p>
            </div>

            {/* Vehículo */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">🚌 Vehículo que vas a conducir</label>
              <select className="w-full rounded-xl px-4 py-3.5 text-base font-bold text-white border"
                style={{ background: "#1e293b", borderColor: vehiculoId ? "#3b82f6" : "#334155" }}
                value={vehiculoId || ""}
                onChange={e => { setVehiculoId(Number(e.target.value) || null); setSelError(""); }}>
                <option value="">Seleccionar vehículo...</option>
                {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria}</option>)}
              </select>
            </div>

            {/* Reservas del día */}
            {reservasHoy.length > 0 && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">🎫 Servicio de hoy</label>
                <div className="space-y-2">
                  {reservasHoy.map(r => {
                    const activa = reservaId === r.id;
                    const veh = vehiculos.find(v => v.id === r.vehiculo_id);
                    return (
                      <button key={r.id} onClick={() => {
                        setReservaId(activa ? null : r.id);
                        if (!activa && r.vehiculo_id) setVehiculoId(r.vehiculo_id);
                      }}
                        className="w-full rounded-xl p-3.5 text-left border-2 transition-all"
                        style={{ background: activa ? "#0b315f" : "#1e293b", borderColor: activa ? "#3b82f6" : "#334155" }}>
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-black text-white">#{r.id} · {r.origen}</p>
                            <p className="text-blue-300 text-sm">→ {r.destino}</p>
                            {veh && <p className="text-gray-400 text-xs mt-0.5">🚌 {veh.placa}</p>}
                          </div>
                          <div className="text-xl">{activa ? "✅" : "⬜"}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {reservasHoy.length === 0 && (
              <div className="rounded-xl px-4 py-3 text-center" style={{ background: "#1e293b" }}>
                <p className="text-gray-400 text-sm">Sin reservas asignadas para hoy</p>
                <p className="text-gray-500 text-xs">Puedes iniciar igual seleccionando el vehículo</p>
              </div>
            )}

            {/* Error */}
            {selError && (
              <div className="rounded-xl px-4 py-3 text-sm font-bold text-red-300" style={{ background: "#1c0202" }}>
                ⚠️ {selError}
              </div>
            )}

            {/* Botón iniciar */}
            <button onClick={iniciarTracking} disabled={iniciandoGps || !vehiculoId}
              className="w-full py-4 rounded-2xl font-black text-xl text-white transition-all active:scale-95 disabled:opacity-40 mt-auto"
              style={{ background: "#16a34a" }}>
              {iniciandoGps ? "📍 Obteniendo GPS..." : "▶ INICIAR SERVICIO"}
            </button>

            <p className="text-center text-[11px] text-gray-500">
              Tu ubicación se enviará cada 10 seg a la central AFA Tours
            </p>
          </div>
        )}

        {/* ── PANTALLA TRACKING ACTIVO ── */}
        {pantalla === "tracking" && conductor && (
          <div className="flex-1 flex flex-col p-4 space-y-4">

            {/* Estado GPS */}
            <div className="rounded-2xl p-5 text-center border-2" style={{ background: "#052e16", borderColor: "#16a34a" }}>
              <div className="flex items-center justify-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                <span className="text-green-400 font-black text-lg">GPS ACTIVO</span>
              </div>

              {/* Vehículo y conductor */}
              <p className="text-white font-black text-lg">{vehSel?.placa} — {vehSel?.categoria}</p>
              <p className="text-green-300">{conductor.nombre}</p>
              {resSel && <p className="text-green-200 text-xs mt-1">#{resSel.id} · {resSel.origen} → {resSel.destino}</p>}

              {/* Velocímetro */}
              <div className="mt-4 rounded-2xl p-4" style={{ background: "#0f172a" }}>
                <p className="text-6xl font-black text-white">{velocidad}</p>
                <p className="text-gray-400 font-bold">km/h</p>
              </div>

              {/* Coords */}
              {posActual && (
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl p-2" style={{ background: "#0f172a" }}>
                    <p className="text-gray-400">Lat</p>
                    <p className="text-white font-mono font-bold">{posActual.coords.latitude.toFixed(5)}</p>
                  </div>
                  <div className="rounded-xl p-2" style={{ background: "#0f172a" }}>
                    <p className="text-gray-400">Lng</p>
                    <p className="text-white font-mono font-bold">{posActual.coords.longitude.toFixed(5)}</p>
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl p-2" style={{ background: "#0f172a" }}>
                  <p className="text-gray-400">Señales enviadas</p>
                  <p className="text-green-400 font-black text-xl">{totalEnvios}</p>
                </div>
                <div className="rounded-xl p-2" style={{ background: "#0f172a" }}>
                  <p className="text-gray-400">Último envío</p>
                  <p className="text-white font-bold text-sm">{ultimoEnvio?.toLocaleTimeString("es-PE") || "—"}</p>
                </div>
              </div>
            </div>

            {/* Error GPS */}
            {gpsError && (
              <div className="rounded-xl px-4 py-3 text-sm text-red-300" style={{ background: "#1c0202" }}>⚠️ {gpsError}</div>
            )}

            {/* SOS */}
            <button onClick={enviarSOS}
              className="w-full py-5 rounded-2xl font-black text-xl text-white transition-all active:scale-95"
              style={{ background: sosEnviado ? "#166534" : "#dc2626" }}>
              {sosEnviado ? "✅ SOS ENVIADO — Central notificada" : "🆘 EMERGENCIA / SOS"}
            </button>
            {!sosEnviado && <p className="text-[10px] text-gray-500 text-center -mt-2">Presiona en caso de accidente o emergencia</p>}

            {/* Finalizar */}
            <button onClick={finalizarServicio}
              className="w-full py-3 rounded-2xl font-black text-base text-white border-2 border-red-900 active:scale-95"
              style={{ background: "#1c0202" }}>
              ⏹ FINALIZAR SERVICIO
            </button>

            <div className="rounded-xl px-4 py-2.5 text-center" style={{ background: "#1e293b" }}>
              <p className="text-[11px] text-gray-400">
                📡 Enviando ubicación cada <b className="text-white">10 segundos</b> · Central AFA Tours
              </p>
            </div>
          </div>
        )}
      </div>

      {/* FOOTER */}
      <div className="px-4 py-2 text-center border-t" style={{ background: "#0b315f", borderColor: "#1e3a5f" }}>
        <p className="text-blue-300 text-[10px]">AFA Tours Peru · Central: 966 707 225</p>
      </div>
    </div>
  );
}