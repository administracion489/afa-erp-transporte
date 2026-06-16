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
  _tipo: "propio" | "tercero";
};
type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  marca: string | null; capacidad_pasajeros: number | null; estado: string;
};
type VehiculoTercero = {
  id: number; placa: string; categoria: string | null;
  marca: string | null; modelo: string | null;
  capacidad: number | null; estado: string;
};
type UbicGPS = {
  vehiculo_id: number | null; conductor_id: number | null;
  vehiculo_tercero_id: number | null; conductor_tercero_id: number | null;
  lat: number; lng: number; velocidad: number; estado: string; timestamp: string;
};

// KEY COMPUESTA no ambigua para un punto GPS.
// Prioriza ids de tercero (ct/vt) sobre propios (c/v) para no colisionar:
// los ids se solapan entre tablas propias y de tercero.
function keyGps(u: {
  conductor_tercero_id?: number | null; conductor_id?: number | null;
  vehiculo_tercero_id?: number | null;  vehiculo_id?: number | null;
}): string | null {
  if (u.conductor_tercero_id != null) return `ct${u.conductor_tercero_id}`;
  if (u.conductor_id != null)         return `c${u.conductor_id}`;
  if (u.vehiculo_tercero_id != null)  return `vt${u.vehiculo_tercero_id}`;
  if (u.vehiculo_id != null)          return `v${u.vehiculo_id}`;
  return null;
}
type ServicioDesp = {
  id: number; origen: string | null; destino: string | null;
  hora_servicio: string | null; estado: string;
  pasajeros_despacho: string | null; precio_cliente: number;
  conductor_nombre: string; vehiculo_placa: string; cliente_nombre: string;
  vehiculo_id: number | null; conductor_id: number | null;
};
type PlaceResult = { address: string; lat: number; lng: number; placeId: string; };

// ─── GOOGLE MAPS HOOK ─────────────────────────────────────────────────────────

function useGoogleMaps() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as any).google?.maps?.places) { setLoaded(true); return; }
    const ex = document.getElementById("gmaps-script");
    if (ex) { ex.addEventListener("load", () => setLoaded(true)); return; }
    const s = document.createElement("script");
    s.id = "gmaps-script";
    s.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&language=es&region=PE`;
    s.async = true; s.defer = true; s.onload = () => setLoaded(true);
    document.head.appendChild(s);
  }, []);
  return loaded;
}

// ─── PLACES INPUT ─────────────────────────────────────────────────────────────

function PlacesInput({
  placeholder, value, onChange, onSelect, mapsLoaded,
}: {
  placeholder: string; value: string;
  onChange: (v: string) => void; onSelect: (r: PlaceResult) => void;
  mapsLoaded: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acRef    = useRef<google.maps.places.Autocomplete | null>(null);

  useEffect(() => {
    if (!mapsLoaded || !inputRef.current || acRef.current) return;
    acRef.current = new google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "pe" },
      fields: ["formatted_address", "geometry", "place_id", "name"],
      types: ["geocode", "establishment"],
    });
    acRef.current.addListener("place_changed", () => {
      const p = acRef.current!.getPlace();
      if (!p.geometry?.location) return;
      const address = p.formatted_address || p.name || "";
      onChange(address);
      onSelect({ address, lat: p.geometry.location.lat(), lng: p.geometry.location.lng(), placeId: p.place_id || "" });
    });
  }, [mapsLoaded]);

  return (
    <div className="relative">
      <input
        ref={inputRef} type="text" value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={iCls("pr-8 bg-white")}
      />
      {value && (
        <button
          onClick={() => { onChange(""); onSelect({ address: "", lat: 0, lng: 0, placeId: "" }); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 font-bold text-xs"
        >✕</button>
      )}
      {!mapsLoaded && (
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
      )}
    </div>
  );
}

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

function estadoConductorCfg(estado: string) {
  if (estado === "disponible")
    return { bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", label: "Disponible" };
  if (estado === "ocupado" || estado === "en_servicio")
    return { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500", label: "Ocupado" };
  return { bg: "bg-gray-100", text: "text-gray-500", dot: "bg-gray-400", label: estado || "Inactivo" };
}
function estadoVehiculoCfg(estado: string) {
  if (estado === "disponible")
    return { label: "✓ Disponible" };
  if (estado === "en_servicio" || estado === "ocupado")
    return { label: "⚡ En servicio" };
  if (estado === "mantenimiento")
    return { label: "🔧 Mantenimiento" };
  return { label: estado || "Inactivo" };
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
  // "propio:5" | "tercero:3" | ""
  conductor_key: "",
  vehiculo_id: "",
  precio_cliente: "",
  observaciones: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DespachadorPage() {
  const mapsLoaded = useGoogleMaps();

  // ── Data ───────────────────────────────────────────────────────────────────
  const [clientes,        setClientes]        = useState<Cliente[]>([]);
  const [conductores,     setConductores]     = useState<Conductor[]>([]);
  const [vehiculos,       setVehiculos]       = useState<Vehiculo[]>([]);
  const [vehiculosTercero, setVehiculosTercero] = useState<VehiculoTercero[]>([]);
  const [conductoresTercero, setConductoresTercero] = useState<Conductor[]>([]);
  const [serviciosHoy,    setServiciosHoy]    = useState<ServicioDesp[]>([]);
  const [ubicaciones,     setUbicaciones]     = useState<UbicGPS[]>([]);

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
  const markers      = useRef<Record<string, mapboxgl.Marker>>({});
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

  // ─── Marcadores GPS (patrón monitoreo: setLngLat en lugar de recrear) ──────

  useEffect(() => {
    if (!mapListo || !map.current) return;

    ubicaciones.forEach((u: UbicGPS) => {
      // Resolver contra la tabla correcta: si el punto trae ids _tercero,
      // buscar en vehiculosTercero/conductoresTercero (ids se solapan con propios).
      const veh    = u.vehiculo_tercero_id != null
        ? vehiculosTercero.find(v => v.id === u.vehiculo_tercero_id)
        : vehiculos.find(v => v.id === u.vehiculo_id);
      const cond   = u.conductor_tercero_id != null
        ? conductoresTercero.find(c => c.id === u.conductor_tercero_id)
        : conductores.find(c => c.id === u.conductor_id && c._tipo === "propio");
      const mins   = minDesde(u.timestamp);
      const activo = mins <= 10;
      const color  = activo ? "#0b315f" : "#9ca3af";
      const sinVeh = u.vehiculo_id == null && u.vehiculo_tercero_id == null;
      // Clave estable: KEY COMPUESTA no ambigua (ct/c/vt/v)
      const key = keyGps(u);
      if (!key) return;

      // Si ya existe el marcador, solo actualizamos posición
      if (markers.current[key]) {
        markers.current[key].setLngLat([Number(u.lng), Number(u.lat)]);
        return;
      }

      // Crear marcador nuevo
      const el = document.createElement("div");
      if (sinVeh) {
        // Conductor sin vehículo → ícono persona
        el.style.cssText = `
          width:34px;height:34px;border-radius:50%;
          background:${color};border:2px solid white;
          box-shadow:0 2px 8px rgba(0,0,0,.3);
          display:flex;align-items:center;justify-content:center;
          font-size:16px;cursor:pointer;
        `;
        el.innerHTML = "🧑";
      } else {
        el.style.cssText = `
          width:38px;height:38px;border-radius:50%;
          background:${color};border:3px solid white;
          box-shadow:0 2px 8px rgba(0,0,0,.3);
          display:flex;align-items:center;justify-content:center;
          font-size:17px;cursor:pointer;
        `;
        el.innerHTML = "🚌";
      }

      const popupContent = sinVeh
        ? `<div style="font-family:sans-serif;padding:4px 2px">
            <p style="font-weight:800;margin:0 0 3px;font-size:13px">${cond?.nombre || "Conductor"}</p>
            <p style="font-size:11px;color:#9ca3af;margin:0 0 2px">Sin vehículo asignado</p>
            <p style="font-size:11px;color:#9ca3af;margin:0">${mins <= 0 ? "Ahora" : `Hace ${mins}m`}</p>
          </div>`
        : `<div style="font-family:sans-serif;padding:4px 2px">
            <p style="font-weight:800;margin:0 0 3px;font-size:13px">${veh?.placa || "#" + (u.vehiculo_tercero_id ?? u.vehiculo_id)}</p>
            <p style="font-size:12px;color:#4b5563;margin:0 0 2px">${cond?.nombre || "Sin conductor"}</p>
            <p style="font-size:11px;color:#9ca3af;margin:0">${Number(u.velocidad).toFixed(0)} km/h · ${mins <= 0 ? "Ahora" : `Hace ${mins}m`}</p>
          </div>`;

      const popup = new mapboxgl.Popup({ offset: 26, maxWidth: "220px" }).setHTML(popupContent);

      markers.current[key] = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(u.lng), Number(u.lat)])
        .setPopup(popup)
        .addTo(map.current!);
    });
  }, [mapListo, ubicaciones, conductores, vehiculos, conductoresTercero, vehiculosTercero]);

  // ─── Carga de datos ────────────────────────────────────────────────────────

  const actualizarGPS = useCallback(async () => {
    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("vehiculo_id,conductor_id,vehiculo_tercero_id,conductor_tercero_id,lat,lng,velocidad,estado,timestamp")
      .order("timestamp", { ascending: false })
      .limit(400);
    if (!data) return;
    // Dedup por KEY COMPUESTA (ct/c/vt/v): los ids se solapan entre tablas
    // propias y de tercero, así que conductor_id/vehiculo_id solos son ambiguos.
    const latest: Record<string, UbicGPS> = {};
    data.forEach((u: UbicGPS) => {
      const key = keyGps(u);
      if (!key) return;
      if (!latest[key] || new Date(u.timestamp) > new Date(latest[key].timestamp))
        latest[key] = u;
    });
    setUbicaciones(Object.values(latest));
  }, []);

  const cargarDatos = useCallback(async () => {
    const hoy = getFechaHoy();
    const [clR, condR, condTerR, vR, vTerR, sR] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo,ruc,telefono").eq("estado", "activo").order("nombre"),
      supabase.from("conductores").select("id,nombre,licencia,estado,telefono").order("nombre"),
      supabase.from("conductores_tercero").select("id,nombre,licencia,estado,telefono").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,marca,capacidad_pasajeros,estado").order("placa"),
      supabase.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo,capacidad,estado").order("placa"),
      supabase.from("reservas")
        .select("id,origen,destino,estado,hora_servicio,pasajeros_despacho,precio_cliente,conductor_id,vehiculo_id,cliente_id")
        .eq("fecha_servicio", hoy)
        .eq("origen_despacho", true)
        .order("hora_servicio"),
    ]);

    // Combinar flota propia + tercerizados, marcando origen
    const condTer: Conductor[] = (condTerR.data || []).map((c: any) => ({ ...c, _tipo: "tercero" as const }));
    const cs: Conductor[] = [
      ...(condR.data || []).map((c: any) => ({ ...c, _tipo: "propio"   as const })),
      ...condTer,
    ].sort((a, b) => a.nombre.localeCompare(b.nombre));
    const vs: Vehiculo[]         = vR.data    || [];
    const vts: VehiculoTercero[] = vTerR.data || [];
    const cls: Cliente[]         = clR.data   || [];
    setConductores(cs);
    setConductoresTercero(condTer);
    setVehiculos(vs);
    setVehiculosTercero(vts);
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
      vehiculo_placa:   vs.find(v => v.id === r.vehiculo_id)?.placa   || "—",
      cliente_nombre:   cls.find(c => c.id === r.cliente_id)?.nombre  || "—",
      vehiculo_id:      r.vehiculo_id   ?? null,
      conductor_id:     r.conductor_id  ?? null,
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

    // Parsear selección de conductor ("propio:5" | "tercero:3" | "")
    const [condTipo, condIdStr] = form.conductor_key.split(":");
    const condIdNum = condIdStr ? Number(condIdStr) : null;
    const condPropioId   = condTipo === "propio"  && condIdNum ? condIdNum : null;
    const condTerceroId  = condTipo === "tercero" && condIdNum ? condIdNum : null;

    // Vehículo: propio → vehiculo_id, tercerizado → vehiculo_tercero_id
    const vehiculoIdFinal       = form.tipo_asignacion === "propio"      && form.vehiculo_id ? Number(form.vehiculo_id) : null;
    const vehiculoTerceroIdFinal = form.tipo_asignacion === "tercerizado" && form.vehiculo_id ? Number(form.vehiculo_id) : null;

    const { error: resErr } = await supabase.from("reservas").insert({
      cliente_id:              clienteId,
      conductor_id:            condPropioId,
      vehiculo_id:             vehiculoIdFinal,
      vehiculo_tercero_id:     vehiculoTerceroIdFinal,
      fecha_servicio:    form.fecha_servicio || getFechaHoy(),
      hora_servicio:     form.hora_servicio  || null,
      origen:            form.origen.trim(),
      destino:           form.destino.trim(),
      origen_despacho:   true,
      estado:            "confirmada",
      tipo_asignacion:   form.tipo_asignacion,
      precio_cliente:    Number(form.precio_cliente) || 0,
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

  const clienteSelec      = clientes.find(c => c.id === Number(form.cliente_id));
  const clientesFiltrados = clientes
    .filter(c => `${c.nombre} ${c.empresa || ""}`.toLowerCase().includes(busqCli.toLowerCase()))
    .slice(0, 8);

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
      <div className="flex-1 flex overflow-hidden min-h-0">

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
                <PlacesInput
                  placeholder="Punto de recogida"
                  value={form.origen}
                  mapsLoaded={mapsLoaded}
                  onChange={v => setForm(p => ({ ...p, origen: v }))}
                  onSelect={r => setForm(p => ({ ...p, origen: r.address }))}
                />
              </div>
              <div>
                <Label>Destino *</Label>
                <PlacesInput
                  placeholder="Punto de llegada"
                  value={form.destino}
                  mapsLoaded={mapsLoaded}
                  onChange={v => setForm(p => ({ ...p, destino: v }))}
                  onSelect={r => setForm(p => ({ ...p, destino: r.address }))}
                />
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
                    <button key={t}
                      onClick={() => setForm(p => ({
                        ...p,
                        tipo_asignacion: t,
                        conductor_key: "",   // limpiar al cambiar tipo
                        vehiculo_id:   "",   // limpiar vehículo también
                      }))}
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
                <select className={iCls()} value={form.conductor_key}
                  onChange={e => setForm(p => ({ ...p, conductor_key: e.target.value }))}>
                  <option value="">— Sin asignar —</option>
                  {conductores
                    .filter(c => form.tipo_asignacion === "propio"
                      ? c._tipo === "propio"
                      : c._tipo === "tercero")
                    .map(c => (
                      <option key={`${c._tipo}-${c.id}`} value={`${c._tipo}:${c.id}`}>
                        {c.nombre}{c.licencia ? ` · ${c.licencia}` : ""} [{estadoConductorCfg(c.estado).label}]
                      </option>
                    ))}
                  {conductores.filter(c =>
                    form.tipo_asignacion === "propio" ? c._tipo === "propio" : c._tipo === "tercero"
                  ).length === 0 && (
                    <option disabled>Sin conductores para este tipo</option>
                  )}
                </select>
              </div>

              <div>
                <Label>Vehículo</Label>
                <select className={iCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">— Sin asignar —</option>
                  {form.tipo_asignacion === "propio"
                    ? vehiculos.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.placa}{v.categoria ? ` — ${v.categoria}` : ""}
                          {v.marca ? ` · ${v.marca}` : ""}
                          {v.capacidad_pasajeros ? ` (${v.capacidad_pasajeros} pax)` : ""}
                          {" "}[{estadoVehiculoCfg(v.estado).label}]
                        </option>
                      ))
                    : vehiculosTercero.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.placa}{v.categoria ? ` — ${v.categoria}` : ""}
                          {v.marca ? ` · ${v.marca}` : ""}
                          {v.modelo ? ` ${v.modelo}` : ""}
                          {v.capacidad ? ` (${v.capacidad} pax)` : ""}
                          {" "}[{estadoVehiculoCfg(v.estado).label}]
                        </option>
                      ))
                  }
                  {form.tipo_asignacion === "propio" && vehiculos.length === 0 && (
                    <option disabled>Sin vehículos de flota propia…</option>
                  )}
                  {form.tipo_asignacion === "tercerizado" && vehiculosTercero.length === 0 && (
                    <option disabled>Sin vehículos tercerizados…</option>
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
              {serviciosHoy.map(s => {
                // ── Badge GPS: cruzar conductor_id / vehiculo_id contra ubicaciones activas ──
                const ubCond = s.conductor_id
                  ? ubicaciones.find(u => u.conductor_id === s.conductor_id)
                  : null;
                const ubVeh = s.vehiculo_id
                  ? ubicaciones.find(u => u.vehiculo_id === s.vehiculo_id)
                  : null;
                const ub = ubVeh || ubCond;  // prioridad: vehículo > conductor sin vehículo

                // Estado GPS
                let gpsBadge: { icon: string; label: string; bg: string; text: string } | null = null;
                if (!s.conductor_id && !s.vehiculo_id) {
                  gpsBadge = null; // sin asignación
                } else if (!ub) {
                  gpsBadge = { icon: "📵", label: "Sin GPS", bg: "bg-gray-100", text: "text-gray-500" };
                } else {
                  const mins = minDesde(ub.timestamp);
                  if (ub.vehiculo_id) {
                    // En ruta con vehículo
                    gpsBadge = mins <= 2
                      ? { icon: "🛰", label: "En ruta", bg: "bg-green-100", text: "text-green-700" }
                      : mins <= 10
                      ? { icon: "🛰", label: `Hace ${mins}m`, bg: "bg-amber-100", text: "text-amber-700" }
                      : { icon: "📵", label: "Sin señal", bg: "bg-gray-100", text: "text-gray-500" };
                  } else {
                    // Conductor conectado pero sin vehículo aún
                    gpsBadge = { icon: "🧑", label: "Sin vehículo", bg: "bg-blue-50", text: "text-blue-600" };
                  }
                }

                return (
                  <div key={s.id} className="rounded-xl border bg-white px-3 py-2.5 hover:border-[#0b315f]/30 transition-all">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-gray-800 truncate">
                          {s.origen || "—"} → {s.destino || "—"}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {s.hora_servicio ? s.hora_servicio.slice(0, 5) : "—"} · {s.cliente_nombre}
                        </p>
                        {/* Conductor + placa */}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {s.conductor_nombre !== "Sin asignar" && (
                            <span className="text-[10px] font-semibold text-gray-600">
                              👤 {s.conductor_nombre.split(" ").slice(0, 2).join(" ")}
                            </span>
                          )}
                          {s.vehiculo_placa !== "—" && (
                            <span className="text-[10px] font-mono font-bold bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">
                              🚌 {s.vehiculo_placa}
                            </span>
                          )}
                          {/* Badge GPS */}
                          {gpsBadge && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${gpsBadge.bg} ${gpsBadge.text}`}>
                              {gpsBadge.icon} {gpsBadge.label}
                            </span>
                          )}
                        </div>
                        {s.pasajeros_despacho && (
                          <p className="text-[10px] text-gray-400 mt-0.5">🧳 {s.pasajeros_despacho}</p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg ${
                          s.estado === "en_curso" ? "bg-green-100 text-green-700" :
                          s.estado === "finalizada" ? "bg-gray-100 text-gray-500" :
                          "bg-amber-100 text-amber-700"
                        }`}>
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
                );
              })}
            </div>
          )}
        </div>

        {/* ── RIGHT: Conductores + Mapa ── */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">

          {/* Flota completa — scroll horizontal */}
          <div className="flex-shrink-0 border-b bg-white px-4 py-3">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Toda la flota</p>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">
                {condDisp} disponible{condDisp !== 1 ? "s" : ""}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600">
                {conductores.length} total
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              {conductores.length === 0 ? (
                <p className="text-sm text-gray-400 py-2 italic">Cargando conductores…</p>
              ) : conductores.map(c => {
                const gps    = ubicaciones.find(u => u.conductor_id === c.id);
                const mins   = gps ? minDesde(gps.timestamp) : null;
                const online = mins !== null && mins <= 10;
                const cKey   = `${c._tipo}:${c.id}`;
                const sel    = form.conductor_key === cKey;
                const cfg    = estadoConductorCfg(c.estado);
                return (
                  <button key={cKey} onClick={() => setForm(p => ({
                    ...p,
                    conductor_key:   sel ? "" : cKey,
                    tipo_asignacion: sel ? p.tipo_asignacion : (c._tipo === "tercero" ? "tercerizado" : "propio"),
                  }))}
                    className={`flex-shrink-0 rounded-xl border px-3 py-2 text-left transition-all ${
                      sel ? "border-[#0b315f] bg-[#eef3f8] shadow-sm" : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}>
                    <div className="flex items-center gap-2">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${
                        c.estado === "disponible" ? "bg-[#0b315f]" : "bg-gray-400"
                      }`}>
                        {ini(c.nombre)}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-bold text-gray-800 whitespace-nowrap">
                            {c.nombre.split(" ").slice(0, 2).join(" ")}
                          </p>
                          {c._tipo === "tercero" && (
                            <span className="text-[8px] font-black px-1 py-0.5 rounded bg-purple-100 text-purple-600 leading-none flex-shrink-0">
                              3ro
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
                          <span className={`text-[9px] font-bold ${cfg.text}`}>{cfg.label}</span>
                        </div>
                        {online && (
                          <p className="text-[9px] text-gray-400 mt-0.5">
                            📡 {Number(gps!.velocidad).toFixed(0)} km/h
                          </p>
                        )}
                      </div>
                      {sel && <span className="text-[10px] text-[#0b315f] font-bold ml-1">✓</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mapa — flex-1 con min-h-0 para que Mapbox tome el alto real */}
          <div className="flex-1 relative min-h-0">
            <div ref={mapContainer} className="w-full h-full" />

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
