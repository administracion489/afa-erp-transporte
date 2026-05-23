"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Cliente = {
  id: number; nombre: string; empresa: string | null;
  tipo: string; ruc: string | null; telefono: string | null;
};
type Conductor = {
  id: number; nombre: string; licencia: string | null;
  estado: string; telefono: string | null;
};
type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  marca: string | null; capacidad_pasajeros: number | null; estado: string;
};
type UbicGPS = {
  vehiculo_id: number; conductor_id: number | null;
  lat: number; lng: number; velocidad: number; estado: string; timestamp: string;
};
type ServicioDesp = {
  id: number; origen: string | null; destino: string | null;
  hora_servicio: string | null; estado: string;
  pasajeros_despacho: string | null; precio_cliente: number;
  conductor_nombre: string; vehiculo_placa: string; cliente_nombre: string;
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getFechaHoy(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}
function getHoraActual(): string {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`;
}
function ini(nombre: string) {
  return nombre.split(" ").slice(0,2).map(w => w[0] || "").join("").toUpperCase();
}
function minDesde(ts: string) {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}
function iCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{children}</label>;
}

// ─── FORM VACÍO ───────────────────────────────────────────────────────────────

const FORM0 = {
  modo_cliente: "existente" as "existente" | "nuevo",
  cliente_id: "",
  nuevo_nombre: "",
  nuevo_tipo: "b2b" as "b2b" | "b2c",
  nuevo_empresa: "",
  nuevo_telefono: "",
  pasajeros: "",
  origen: "",
  destino: "",
  fecha_servicio: getFechaHoy(),
  hora_servicio: getHoraActual(),
  tipo_asignacion: "propio" as "propio" | "tercerizado",
  conductor_id: "",
  vehiculo_id: "",
  precio_cliente: "",
  observaciones: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DespachadorPage() {
  // ── Data ───────────────────────────────────────────────────────────────────
  const [clientes,      setClientes]      = useState<Cliente[]>([]);
  const [conductores,   setConductores]   = useState<Conductor[]>([]);
  const [vehiculos,     setVehiculos]     = useState<Vehiculo[]>([]);
  const [serviciosHoy,  setServiciosHoy]  = useState<ServicioDesp[]>([]);
  const [ubicaciones,   setUbicaciones]   = useState<UbicGPS[]>([]);

  // ── Form ───────────────────────────────────────────────────────────────────
  const [form,      setForm]      = useState({ ...FORM0 });
  const [guardando, setGuardando] = useState(false);
  const [exito,     setExito]     = useState(false);
  const [error,     setError]     = useState("");

  // ── Búsqueda cliente ───────────────────────────────────────────────────────
  const [busqCli,  setBusqCli]  = useState("");
  const [dropCli,  setDropCli]  = useState(false);

  // ── Mapa ───────────────────────────────────────────────────────────────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const markers      = useRef<Record<number, mapboxgl.Marker>>({});
  const [mapListo,   setMapListo]   = useState(false);

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const vehDisp   = vehiculos.filter(v => v.estado === "disponible").length;
  const condDisp  = conductores.filter(c => c.estado === "disponible").length;
  const dispHoy   = serviciosHoy.length;

  // ─── Mapa init ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-77.0428, -12.0464],
      zoom: 11,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.current.on("load", () => setMapListo(true));
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  // ─── Marcadores GPS ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapListo || !map.current) return;
    Object.values(markers.current).forEach(m => m.remove());
    markers.current = {};

    ubicaciones.forEach(u => {
      const veh  = vehiculos.find(v => v.id === u.vehiculo_id);
      const cond = conductores.find(c => c.id === u.conductor_id);
      if (!veh) return;

      const mins   = minDesde(u.timestamp);
      const activo = mins <= 10;
      const color  = activo ? "#0b315f" : "#9ca3af";

      const el = document.createElement("div");
      el.style.cssText = `
        width:38px;height:38px;border-radius:50%;
        background:${color};border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,.3);
        display:flex;align-items:center;justify-content:center;
        font-size:17px;cursor:pointer;
      `;
      el.innerHTML = "🚌";

      const popup = new mapboxgl.Popup({ offset: 26, maxWidth: "220px" }).setHTML(`
        <div style="font-family:sans-serif;padding:4px 2px">
          <p style="font-weight:800;margin:0 0 3px;font-size:13px">${veh.placa}</p>
          <p style="font-size:12px;color:#4b5563;margin:0 0 2px">${cond?.nombre || "Sin conductor"}</p>
          <p style="font-size:11px;color:#9ca3af;margin:0">${u.velocidad.toFixed(0)} km/h · ${mins <= 0 ? "Ahora" : `Hace ${mins}m`}</p>
        </div>
      `);

      markers.current[u.vehiculo_id] = new mapboxgl.Marker({ element: el })
        .setLngLat([u.lng, u.lat])
        .setPopup(popup)
        .addTo(map.current!);
    });
  }, [mapListo, ubicaciones, conductores, vehiculos]);

  // ─── Carga de datos ────────────────────────────────────────────────────────

  const actualizarGPS = useCallback(async () => {
    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("vehiculo_id,conductor_id,lat,lng,velocidad,estado,timestamp")
      .order("timestamp", { ascending: false })
      .limit(400);
    if (!data) return;
    const latest: Record<number, UbicGPS> = {};
    data.forEach((u: UbicGPS) => {
      if (!latest[u.vehiculo_id] || new Date(u.timestamp) > new Date(latest[u.vehiculo_id].timestamp))
        latest[u.vehiculo_id] = u;
    });
    setUbicaciones(Object.values(latest));
  }, []);

  const cargarDatos = useCallback(async () => {
    const hoy = getFechaHoy();
    const [clR, condR, vR, sR] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo,ruc,telefono").eq("estado", "activo").order("nombre"),
      supabase.from("conductores").select("id,nombre,licencia,estado,telefono").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,marca,capacidad_pasajeros,estado").order("placa"),
      supabase.from("reservas")
        .select("id,origen,destino,estado,hora_servicio,pasajeros_despacho,precio_cliente,conductor_id,vehiculo_id,cliente_id")
        .eq("fecha_servicio", hoy)
        .eq("origen_despacho", true)
        .order("hora_servicio"),
    ]);

    const cs: Conductor[] = condR.data || [];
    const vs: Vehiculo[]  = vR.data   || [];
    const cls: Cliente[]  = clR.data  || [];
    setConductores(cs);
    setVehiculos(vs);
    setClientes(cls);

    const servicios: ServicioDesp[] = (sR.data || []).map((r: any) => ({
      id:               r.id,
      origen:           r.origen,
      destino:          r.destino,
      hora_servicio:    r.hora_servicio,
      estado:           r.estado,
      pasajeros_despacho: r.pasajeros_despacho,
      precio_cliente:   r.precio_cliente,
      conductor_nombre: cs.find(c => c.id === r.conductor_id)?.nombre || "Sin asignar",
      vehiculo_placa:   vs.find(v => v.id === r.vehiculo_id)?.placa   || "Sin asignar",
      cliente_nombre:   cls.find(c => c.id === r.cliente_id)?.nombre  || "—",
    }));
    setServiciosHoy(servicios);
    await actualizarGPS();
  }, [actualizarGPS]);

  useEffect(() => {
    cargarDatos();
    const id = setInterval(actualizarGPS, 30_000);
    return () => clearInterval(id);
  }, [cargarDatos, actualizarGPS]);

  // ─── Despachar ─────────────────────────────────────────────────────────────

  const despachar = async () => {
    setError("");
    if (!form.origen.trim() || !form.destino.trim()) {
      setError("Origen y destino son obligatorios"); return;
    }
    if (form.modo_cliente === "existente" && !form.cliente_id) {
      setError("Selecciona un cliente"); return;
    }
    if (form.modo_cliente === "nuevo" && !form.nuevo_nombre.trim()) {
      setError("Ingresa el nombre del cliente"); return;
    }

    setGuardando(true);
    let clienteId: number | null = form.modo_cliente === "existente" ? Number(form.cliente_id) : null;

    if (form.modo_cliente === "nuevo") {
      const { data: nc, error: ncErr } = await supabase
        .from("clientes")
        .insert({
          nombre:   form.nuevo_nombre.trim(),
          tipo:     form.nuevo_tipo,
          empresa:  form.nuevo_empresa.trim() || null,
          telefono: form.nuevo_telefono.trim() || null,
          estado:   "activo",
        })
        .select("id").single();
      if (ncErr || !nc) { setError("Error al crear cliente: " + ncErr?.message); setGuardando(false); return; }
      clienteId = nc.id;
    }

    const { error: resErr } = await supabase.from("reservas").insert({
      cliente_id:        clienteId,
      conductor_id:      form.conductor_id  ? Number(form.conductor_id)  : null,
      vehiculo_id:       form.vehiculo_id   ? Number(form.vehiculo_id)   : null,
      fecha_servicio:    form.fecha_servicio || getFechaHoy(),
      hora_servicio:     form.hora_servicio  || null,
      origen:            form.origen.trim(),
      destino:           form.destino.trim(),
      origen_despacho:   true,
      estado:            "confirmada",
      tipo_asignacion:   form.tipo_asignacion,
      precio_cliente:    Number(form.precio_cliente) || 0,
      costo_proveedor:   0,
      margen:            0,
      pasajeros_despacho: form.pasajeros.trim() || null,
      observaciones:     form.observaciones.trim()
        ? `[DESPACHADOR] ${form.observaciones.trim()}`
        : "[DESPACHADOR]",
    });

    if (resErr) { setError("Error al despachar: " + resErr.message); setGuardando(false); return; }

    setExito(true);
    setForm({ ...FORM0, fecha_servicio: getFechaHoy(), hora_servicio: getHoraActual() });
    setBusqCli(""); setDropCli(false);
    await cargarDatos();
    setGuardando(false);
    setTimeout(() => setExito(false), 4000);
  };

  // ─── Helpers form ──────────────────────────────────────────────────────────

  const f = (k: keyof typeof FORM0) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const clienteSelec     = clientes.find(c => c.id === Number(form.cliente_id));
  const clientesFiltrados = clientes
    .filter(c => `${c.nombre} ${c.empresa || ""}`.toLowerCase().includes(busqCli.toLowerCase()))
    .slice(0, 8);
  const conductoresDisp  = conductores.filter(c => c.estado === "disponible");
  const vehiculosDisp    = vehiculos.filter(v => v.estado === "disponible");

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div className="h-[calc(100vh-0px)] flex flex-col overflow-hidden bg-gray-50">

      {/* ── HEADER ── */}
      <div className="flex-shrink-0 bg-white border-b px-6 py-4 flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚡</span>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Despachador</h1>
            <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider bg-amber-100 text-amber-700 border border-amber-200">
              TIEMPO REAL
            </span>
          </div>
          <p className="text-sm text-gray-400 mt-0.5">
            Genera servicios urgentes · pasan directo a Programación con alerta en Cotizaciones y Facturación
          </p>
        </div>

        {/* KPIs */}
        <div className="flex gap-2">
          {[
            { val: vehDisp,  label: "Vehículos libres",   bg: "bg-green-50",  border: "border-green-200",  text: "text-green-700",  sub: "text-green-500"  },
            { val: condDisp, label: "Conductores disp.",  bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700",   sub: "text-blue-500"   },
            { val: dispHoy,  label: "Despachados hoy",    bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-700",  sub: "text-amber-500"  },
          ].map(k => (
            <div key={k.label} className={`text-center px-4 py-2 rounded-xl border ${k.bg} ${k.border}`}>
              <p className={`text-2xl font-black ${k.text}`}>{k.val}</p>
              <p className={`text-[10px] font-bold uppercase ${k.sub}`}>{k.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── CUERPO ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── LEFT: Form ── */}
        <div className="w-[400px] xl:w-[440px] flex-shrink-0 flex flex-col border-r bg-white overflow-y-auto">
          <div className="p-5 space-y-4">

            {/* Éxito / Error */}
            {exito && (
              <div className="rounded-xl bg-green-50 border border-green-300 p-3 flex items-center gap-2 animate-in fade-in">
                <span className="text-lg">✅</span>
                <div>
                  <p className="text-sm font-bold text-green-800">Servicio despachado</p>
                  <p className="text-xs text-green-600">Ya aparece en Programación · alertas generadas</p>
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-300 p-3 text-sm font-semibold text-red-700">
                ⚠ {error}
              </div>
            )}

            {/* ── CLIENTE ── */}
            <div className="rounded-2xl border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Cliente</p>
                <div className="flex gap-1">
                  {(["existente", "nuevo"] as const).map(m => (
                    <button key={m} onClick={() => setForm(p => ({ ...p, modo_cliente: m }))}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                        form.modo_cliente === m ? "bg-[#0b315f] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}>
                      {m === "existente" ? "Existente" : "+ Nuevo"}
                    </button>
                  ))}
                </div>
              </div>

              {form.modo_cliente === "existente" ? (
                <div className="relative">
                  <input
                    className={iCls()}
                    placeholder="Buscar cliente o empresa…"
                    value={clienteSelec
                      ? `${clienteSelec.nombre}${clienteSelec.empresa ? ` — ${clienteSelec.empresa}` : ""}`
                      : busqCli}
                    onChange={e => { setBusqCli(e.target.value); setForm(p => ({ ...p, cliente_id: "" })); setDropCli(true); }}
                    onFocus={() => setDropCli(true)}
                    onBlur={() => setTimeout(() => setDropCli(false), 180)}
                  />
                  {clienteSelec && (
                    <button onClick={() => { setForm(p => ({ ...p, cliente_id: "" })); setBusqCli(""); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 text-sm">✕</button>
                  )}
                  {dropCli && busqCli && !clienteSelec && (
                    <div className="absolute z-50 w-full mt-1 bg-white border rounded-xl shadow-xl overflow-hidden max-h-52 overflow-y-auto">
                      {clientesFiltrados.length === 0
                        ? <p className="px-3 py-3 text-sm text-gray-400">Sin resultados</p>
                        : clientesFiltrados.map(c => (
                          <button key={c.id} onMouseDown={() => { setForm(p => ({ ...p, cliente_id: String(c.id) })); setBusqCli(""); setDropCli(false); }}
                            className="w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 border-b last:border-0">
                            <p className="font-semibold text-gray-800">{c.nombre}</p>
                            {c.empresa && <p className="text-xs text-gray-400">{c.empresa}</p>}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <input className={iCls()} placeholder="Nombre del cliente *" value={form.nuevo_nombre} onChange={f("nuevo_nombre")} />
                  <div className="grid grid-cols-2 gap-2">
                    <select className={iCls()} value={form.nuevo_tipo} onChange={f("nuevo_tipo")}>
                      <option value="b2b">Empresa (B2B)</option>
                      <option value="b2c">Persona (B2C)</option>
                    </select>
                    <input className={iCls()} placeholder="Empresa (opcional)" value={form.nuevo_empresa} onChange={f("nuevo_empresa")} />
                  </div>
                  <input className={iCls()} placeholder="Teléfono" value={form.nuevo_telefono} onChange={f("nuevo_telefono")} />
                  <p className="text-[10px] text-amber-600 bg-amber-50 rounded-lg px-2 py-1.5">
                    ⚠ Se creará en base de clientes — completa el perfil luego en <strong>Clientes</strong>
                  </p>
                </div>
              )}

              <div>
                <Label>Pasajero(s)</Label>
                <input className={iCls()} placeholder="Ej: Juan Pérez, María García…" value={form.pasajeros} onChange={f("pasajeros")} />
              </div>
            </div>

            {/* ── SERVICIO ── */}
            <div className="rounded-2xl border p-4 space-y-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Servicio</p>

              <div>
                <Label>Origen *</Label>
                <input className={iCls()} placeholder="Punto de recogida" value={form.origen} onChange={f("origen")} />
              </div>
              <div>
                <Label>Destino *</Label>
                <input className={iCls()} placeholder="Punto de llegada" value={form.destino} onChange={f("destino")} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Fecha</Label>
                  <input type="date" className={iCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
                </div>
                <div>
                  <Label>Hora</Label>
                  <input type="time" className={iCls()} value={form.hora_servicio} onChange={f("hora_servicio")} />
                </div>
              </div>
              <div>
                <Label>Precio S/</Label>
                <input type="number" min="0" step="0.01" className={iCls("font-mono")} placeholder="0.00" value={form.precio_cliente} onChange={f("precio_cliente")} />
              </div>
            </div>

            {/* ── ASIGNACIÓN ── */}
            <div className="rounded-2xl border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Asignación</p>
                <div className="flex gap-1">
                  {(["propio", "tercerizado"] as const).map(t => (
                    <button key={t} onClick={() => setForm(p => ({ ...p, tipo_asignacion: t }))}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition-all capitalize ${
                        form.tipo_asignacion === t ? "bg-[#0b315f] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}>
                      {t === "propio" ? "Flota propia" : "Tercerizado"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Conductor</Label>
                <select className={iCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                  <option value="">— Sin asignar —</option>
                  {conductoresDisp.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}{c.licencia ? ` · ${c.licencia}` : ""}
                    </option>
                  ))}
                  {conductoresDisp.length === 0 && (
                    <option disabled>Sin conductores disponibles</option>
                  )}
                </select>
              </div>

              <div>
                <Label>Vehículo</Label>
                <select className={iCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">— Sin asignar —</option>
                  {vehiculosDisp.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.placa} — {v.categoria || ""}
                      {v.marca ? ` · ${v.marca}` : ""}
                      {v.capacidad_pasajeros ? ` (${v.capacidad_pasajeros} pax)` : ""}
                    </option>
                  ))}
                  {vehiculosDisp.length === 0 && (
                    <option disabled>Sin vehículos disponibles</option>
                  )}
                </select>
              </div>

              <div>
                <Label>Instrucciones para el conductor</Label>
                <textarea className={iCls("resize-none")} rows={2}
                  placeholder="Notas especiales, punto exacto de recogida…"
                  value={form.observaciones} onChange={f("observaciones")} />
              </div>
            </div>

            {/* ── BOTÓN ── */}
            <button onClick={despachar} disabled={guardando}
              className="w-full py-4 rounded-2xl font-black text-white text-base disabled:opacity-50 transition-all hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "#0b315f" }}>
              <span className="text-xl">⚡</span>
              {guardando ? "Despachando…" : "Despachar servicio"}
            </button>

            <p className="text-[10px] text-gray-400 text-center leading-relaxed">
              Pasa directo a <strong>Programación</strong> como <em>Confirmado</em>.<br />
              Se genera alerta de pendiente en <strong>Cotizaciones</strong> y <strong>Facturación</strong>.
            </p>

          </div>

          {/* ── HISTORIAL DEL DÍA ── */}
          {serviciosHoy.length > 0 && (
            <div className="border-t px-5 py-4 space-y-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                Despachados hoy ({serviciosHoy.length})
              </p>
              {serviciosHoy.map(s => (
                <div key={s.id} className="rounded-xl border bg-white px-3 py-2.5 hover:border-[#0b315f]/30 transition-all">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-gray-800 truncate">
                        {s.origen || "—"} → {s.destino || "—"}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {s.hora_servicio ? s.hora_servicio.slice(0, 5) : "—"} · {s.cliente_nombre} · {s.conductor_nombre}
                      </p>
                      {s.pasajeros_despacho && (
                        <p className="text-xs text-gray-400">👤 {s.pasajeros_despacho}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-amber-100 text-amber-700">
                        {s.estado}
                      </span>
                      {s.precio_cliente > 0 && (
                        <span className="text-[10px] font-mono text-gray-500">
                          S/ {s.precio_cliente.toLocaleString("es-PE")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT: Mapa + Conductores ── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Conductores disponibles — scroll horizontal */}
          <div className="flex-shrink-0 border-b bg-white px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Flota disponible</p>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">
                {condDisp} conductor{condDisp !== 1 ? "es" : ""}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">
                {vehDisp} vehículo{vehDisp !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              {conductoresDisp.length === 0 ? (
                <p className="text-sm text-gray-400 py-2 italic">Sin conductores disponibles ahora</p>
              ) : conductoresDisp.map(c => {
                const gps   = ubicaciones.find(u => u.conductor_id === c.id);
                const mins  = gps ? minDesde(gps.timestamp) : null;
                const online = mins !== null && mins <= 10;
                const sel   = form.conductor_id === String(c.id);
                return (
                  <button key={c.id} onClick={() => setForm(p => ({ ...p, conductor_id: sel ? "" : String(c.id) }))}
                    className={`flex-shrink-0 rounded-xl border px-3 py-2 text-left transition-all ${
                      sel ? "border-[#0b315f] bg-[#eef3f8] shadow-sm" : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}>
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-full bg-[#0b315f] flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {ini(c.nombre)}
                      </div>
                      <div>
                        <p className="text-xs font-bold text-gray-800 whitespace-nowrap">
                          {c.nombre.split(" ").slice(0, 2).join(" ")}
                        </p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${online ? "bg-green-500" : "bg-gray-300"}`} />
                          <span className="text-[10px] text-gray-400">
                            {online ? `${gps!.velocidad.toFixed(0)} km/h` : "Sin GPS"}
                          </span>
                        </div>
                      </div>
                      {sel && <span className="text-[10px] text-[#0b315f] font-bold ml-1">✓</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mapa */}
          <div className="flex-1 relative">
            <div ref={mapContainer} className="absolute inset-0" />

            {!mapListo && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-100 z-10">
                <div className="flex items-center gap-2 text-gray-500">
                  <div className="w-5 h-5 border-2 border-gray-300 border-t-[#0b315f] rounded-full animate-spin" />
                  Cargando mapa…
                </div>
              </div>
            )}

            {/* Leyenda */}
            <div className="absolute bottom-4 left-4 z-10 bg-white/95 backdrop-blur rounded-xl shadow-lg border px-3 py-2 space-y-1">
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-1">GPS</p>
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <div className="w-3.5 h-3.5 rounded-full bg-[#0b315f]" /> En línea (&lt;10m)
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-400">
                <div className="w-3.5 h-3.5 rounded-full bg-gray-300" /> Sin señal
              </div>
              <p className="text-[9px] text-gray-400 pt-1 border-t">
                Click en 🚌 para detalles
              </p>
            </div>

            {/* Contador GPS */}
            <div className="absolute top-3 left-3 z-10 bg-white/95 backdrop-blur rounded-xl shadow border px-3 py-1.5">
              <p className="text-[10px] font-bold text-gray-600">
                🛰 {ubicaciones.length} unidad{ubicaciones.length !== 1 ? "es" : ""} con GPS activo
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
