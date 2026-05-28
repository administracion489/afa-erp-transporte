"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

type Modo    = "eventual" | "fijo";
type Equip   = "full_equipo" | "basico";

type Tarifa = {
  id: number;
  origen: string; destino: string;
  tipo_vehiculo: string; capacidad_custom: string | null;
  equipamiento: string; tipo_servicio: string;
  modo: string;
  precio: number; moneda: string;
  confidencial: boolean;
  incluye_guia: boolean; incluye_peajes: boolean; incluye_alimentacion: boolean;
  notas: string | null; activo: boolean;
};

type CotRef = {
  id: number; origen: string; destino: string;
  precio_cliente: number; tipo_vehiculo: string | null;
  tipo_servicio: string | null; equipamiento: string | null;
  numero_cotizacion: string | null; estado: string;
  modo_servicio: string | null;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

// Grupos de vehículos (eje horizontal de la matriz)
const GRUPOS_VEH = [
  {
    grupo: "Ligeros", color: "#6366f1", bg: "#eef2ff",
    vehs: [
      { id: "AUTO_4",  label: "Auto 4p",  icon: "🚗", pax: 4  },
      { id: "SUV_4",   label: "SUV 4p",   icon: "🚙", pax: 4  },
      { id: "SUV_6",   label: "SUV 6p",   icon: "🚙", pax: 6  },
    ],
  },
  {
    grupo: "Vans", color: "#0891b2", bg: "#ecfeff",
    vehs: [
      { id: "MINIVAN_10", label: "Minivan 10p", icon: "🚐", pax: 10 },
      { id: "VAN_15",     label: "Van 15p",     icon: "🚐", pax: 15 },
    ],
  },
  {
    grupo: "Buses", color: "#0b315f", bg: "#eef3f8",
    vehs: [
      { id: "SPRINTER_17", label: "Sprinter 17p", icon: "🚌", pax: 17 },
      { id: "SPRINTER_20", label: "Sprinter 20p", icon: "🚌", pax: 20 },
      { id: "CUSTER_25",   label: "Custer 25p",   icon: "🚌", pax: 25 },
      { id: "MINIBUS_30",  label: "Minibus 30p",  icon: "🚌", pax: 30 },
      { id: "MINIBUS_35",  label: "Minibus 35p",  icon: "🚌", pax: 35 },
      { id: "BUS_45",      label: "Bus 45p",      icon: "🚌", pax: 45 },
      { id: "BUS_49",      label: "Bus 49p",      icon: "🚌", pax: 49 },
      { id: "BUS_50",      label: "Bus 50p",      icon: "🚌", pax: 50 },
    ],
  },
];
const TODOS_VEH = GRUPOS_VEH.flatMap(g => g.vehs);

// Servicios EVENTUAL
const TABS_EVENTUAL = [
  {
    tab: "traslados", label: "Traslados", icon: "➡️", desc: "Punto a punto — precio total por viaje",
    color: "#0b315f", bg: "#eef3f8",
    servicios: [
      { id: "solo_ida",    label: "Solo Ida",      desc: "Sin retorno",               icon: "→"  },
      { id: "ida_retorno", label: "Ida y Retorno",  desc: "Horarios cerrados",          icon: "⇄"  },
    ],
  },
  {
    tab: "disposicion", label: "Disposición", icon: "🕐", desc: "Se cobra por horas de servicio",
    color: "#854d0e", bg: "#fef9c3",
    servicios: [
      { id: "ida_retorno_paradas", label: "Con Paradas",    desc: "Trámites, visitas, esperas", icon: "📍" },
    ],
  },
  {
    tab: "turismo", label: "Turismo y Recreación", icon: "⭐", desc: "Itinerarios completos",
    color: "#6d28d9", bg: "#ede9fe",
    servicios: [
      { id: "full_day",  label: "Full Day / Tour", desc: "8-12 horas con itinerario",   icon: "⭐" },
      { id: "multi_dia", label: "Multi-día",        desc: "2+ días: suma pernocte+viáticos", icon: "🏕️" },
    ],
  },
];

// Servicios FIJO
const TABS_FIJO = [
  {
    tab: "ruta_simple", label: "Ruta Simple", icon: "📍", desc: "Rutas lineales — precio por día",
    color: "#166534", bg: "#dcfce7",
    servicios: [
      { id: "fijo_solo_ida",    label: "Solo Ida",       desc: "Solo entrada o solo salida",   icon: "→" },
      { id: "transporte_personal", label: "Ida y Retorno", desc: "Recojo y retorno puntos fijos", icon: "⇄" },
    ],
  },
  {
    tab: "ruta_logistica", label: "Ruta Logística", icon: "🗺️", desc: "Multiparada — mayor desgaste",
    color: "#b45309", bg: "#fef3c7",
    servicios: [
      { id: "fijo_multiparada", label: "Con Paraderos", desc: "Serpenteo por varios puntos", icon: "📍" },
    ],
  },
  {
    tab: "reten", label: "Retén / Disponibilidad", icon: "🏭", desc: "Unidad en planta o disponible",
    color: "#0369a1", bg: "#e0f2fe",
    servicios: [
      { id: "fijo_reten", label: "Unidad en Planta", desc: "24h o turno — disponibilidad total", icon: "🔒" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const fmtP = (n: number, moneda = "PEN") =>
  `${moneda === "USD" ? "$ " : "S/ "}${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
const iCls = (e = "") =>
  `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;

// ══════════════════════════════════════════════════════════════════════════════
// CELDA EDITABLE DE LA MATRIZ
// ══════════════════════════════════════════════════════════════════════════════

function Celda({
  tarifa, cotRef, modo, onGuardar, confidencial,
}: {
  tarifa: Tarifa | null;
  cotRef: CotRef | null;
  modo: Modo;
  onGuardar: (precio: number, id?: number) => void;
  confidencial?: boolean;
}) {
  const [editando, setEditando] = useState(false);
  const [val, setVal]           = useState("");
  const ref = useRef<HTMLInputElement>(null);

  const abrir = () => {
    setVal(tarifa ? String(tarifa.precio) : cotRef ? String(Math.round(Number(cotRef.precio_cliente) / 1.18)) : "");
    setEditando(true);
    setTimeout(() => ref.current?.focus(), 50);
  };
  const guardar = () => {
    const p = Number(val);
    if (val.trim() && !isNaN(p) && p > 0) onGuardar(p, tarifa?.id);
    setEditando(false);
  };

  if (editando) return (
    <td className="border border-gray-200 p-0 min-w-[90px]">
      <input ref={ref} type="number" min="0" step="10"
        className="w-full px-2 py-1.5 text-sm font-mono text-center border-0 outline-none bg-blue-50 font-bold"
        value={val} onChange={e => setVal(e.target.value)}
        onBlur={guardar}
        onKeyDown={e => { if (e.key === "Enter") guardar(); if (e.key === "Escape") setEditando(false); }}
      />
    </td>
  );

  if (tarifa) {
    const isConf = confidencial || tarifa.confidencial;
    const precioMes = modo === "fijo" ? tarifa.precio * 26 : null;
    return (
      <td
        onClick={abrir}
        className={`border p-0 min-w-[90px] cursor-pointer transition-colors group ${isConf ? "border-purple-100 hover:bg-purple-50" : "border-gray-100 hover:bg-blue-50"}`}
      >
        <div className="px-2 py-2 text-center">
          {isConf ? (
            <p className="text-[10px] font-black text-purple-700">🔒 conf.</p>
          ) : (
            <>
              <p className="text-xs font-black text-gray-800 group-hover:text-blue-700 font-mono">
                {fmtP(tarifa.precio, tarifa.moneda)}
              </p>
              {precioMes && (
                <p className="text-[9px] text-gray-400 mt-0.5 font-mono">
                  ~{fmtP(precioMes)}/mes
                </p>
              )}
            </>
          )}
          <div className="text-[9px] mt-0.5 flex justify-center gap-0.5">
            {tarifa.incluye_guia && "🎤"}{tarifa.incluye_peajes && "🛣️"}{tarifa.incluye_alimentacion && "🍽️"}
          </div>
        </div>
      </td>
    );
  }

  if (cotRef) {
    const p = Math.round(Number(cotRef.precio_cliente) / 1.18);
    return (
      <td onClick={abrir}
        className="border border-amber-100 p-0 min-w-[90px] cursor-pointer hover:bg-amber-50 transition-colors group"
        title={`Ref. cotización #${cotRef.numero_cotizacion || cotRef.id}`}>
        <div className="px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-amber-700 font-mono">{fmtP(p)}</p>
          <p className="text-[9px] text-amber-500">📋 ref.</p>
        </div>
      </td>
    );
  }

  return (
    <td onClick={abrir}
      className="border border-gray-100 p-0 min-w-[90px] cursor-pointer hover:bg-blue-50 transition-colors group">
      <div className="px-2 py-2.5 text-center text-gray-200 text-[10px] group-hover:text-blue-400 font-bold">+ precio</div>
    </td>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE PLACES AUTOCOMPLETE
// ══════════════════════════════════════════════════════════════════════════════

function useGoogleMapsTar(){
  const[loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(typeof window==="undefined")return;
    if((window as any).google?.maps?.places){setLoaded(true);return;}
    const ex=document.getElementById("gmaps-script");
    if(ex){const h=()=>setLoaded(true);ex.addEventListener("load",h);return()=>ex.removeEventListener("load",h);}
    const s=document.createElement("script");
    s.id="gmaps-script";
    s.src=`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&language=es&region=PE`;
    s.async=true;s.defer=true;s.onload=()=>setLoaded(true);
    document.head.appendChild(s);
  },[]);
  return loaded;
}

function PlacesInputTar({placeholder,value,onChange,mapsLoaded}:{
  placeholder:string;value:string;onChange:(v:string)=>void;mapsLoaded:boolean;
}){
  const inputRef=useRef<HTMLInputElement>(null);
  const acRef=useRef<any>(null);
  useEffect(()=>{
    if(!mapsLoaded||!inputRef.current||acRef.current)return;
    acRef.current=new (window as any).google.maps.places.Autocomplete(inputRef.current,{
      componentRestrictions:{country:"pe"},
      fields:["formatted_address","geometry","place_id","name"],
      types:["geocode","establishment"],
    });
    acRef.current.addListener("place_changed",()=>{
      const p=acRef.current.getPlace();
      if(!p.geometry?.location)return;
      const pName=p.name||"";
      const pAddr=p.formatted_address||"";
      const address=pName&&pAddr&&!pAddr.toLowerCase().includes(pName.toLowerCase())?`${pName}, ${pAddr}`:pAddr||pName;
      onChange(address.toUpperCase());
    });
  },[mapsLoaded]);
  return(
    <div className="relative">
      <input ref={inputRef} type="text" value={value}
        onChange={e=>onChange(e.target.value.toUpperCase())}
        placeholder={placeholder}
        className={iCls("uppercase font-mono pr-8")+" bg-white"}/>
      {value&&<button type="button" onClick={()=>onChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 font-bold text-xs">✕</button>}
      {!mapsLoaded&&<div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FORMULARIO NUEVA TARIFA
// ══════════════════════════════════════════════════════════════════════════════

const FORM0 = {
  origen: "", destino: "", tipo_vehiculo: "BUS_49", capacidad_custom: "",
  equipamiento: "full_equipo" as Equip, tipo_servicio: "solo_ida",
  precio: "", moneda: "PEN", confidencial: false,
  incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
  notas: "", modo: "eventual" as Modo,
};

function FormTarifa({
  modo, onGuardado, editando, datoEditar, onCancelar, mapsLoaded,
}: {
  modo: Modo;
  onGuardado: () => void;
  editando: boolean;
  datoEditar: Tarifa | null;
  onCancelar: () => void;
  mapsLoaded: boolean;
}) {
  const [form,     setForm]     = useState(FORM0);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    if (datoEditar) {
      setForm({
        origen: datoEditar.origen, destino: datoEditar.destino,
        tipo_vehiculo: datoEditar.tipo_vehiculo, capacidad_custom: datoEditar.capacidad_custom || "",
        equipamiento: datoEditar.equipamiento as Equip, tipo_servicio: datoEditar.tipo_servicio,
        precio: String(datoEditar.precio), moneda: datoEditar.moneda,
        confidencial: datoEditar.confidencial,
        incluye_guia: datoEditar.incluye_guia, incluye_peajes: datoEditar.incluye_peajes,
        incluye_alimentacion: datoEditar.incluye_alimentacion,
        notas: datoEditar.notas || "", modo: (datoEditar.modo || "eventual") as Modo,
      });
    } else {
      setForm({ ...FORM0, modo });
    }
  }, [datoEditar, modo]);

  const tabs = modo === "eventual" ? TABS_EVENTUAL : TABS_FIJO;
  const servsDisp = tabs.flatMap(t => t.servicios);

  async function guardar() {
    if (!form.origen.trim() || !form.destino.trim() || !form.precio) {
      alert("Origen, destino y precio son obligatorios"); return;
    }
    setSaving(true);
    const payload = {
      origen: form.origen.trim().toUpperCase(), destino: form.destino.trim().toUpperCase(),
      tipo_vehiculo: form.tipo_vehiculo, capacidad_custom: form.tipo_vehiculo === "CUSTOM" ? form.capacidad_custom.trim() : null,
      equipamiento: form.equipamiento, tipo_servicio: form.tipo_servicio,
      modo: form.modo,
      precio: Number(form.precio), moneda: form.moneda,
      confidencial: form.confidencial || form.tipo_servicio === "full_day" || form.tipo_servicio === "multi_dia",
      incluye_guia: form.incluye_guia, incluye_peajes: form.incluye_peajes,
      incluye_alimentacion: form.incluye_alimentacion,
      notas: form.notas.trim() || null, activo: true,
    };
    const { error } = datoEditar
      ? await supabase.from("tarifario").update(payload).eq("id", datoEditar.id)
      : await supabase.from("tarifario").insert(payload);
    if (error) { alert(error.message); setSaving(false); return; }
    setSaving(false); onGuardado(); onCancelar();
  }

  return (
    <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
      <h2 className="text-lg font-bold text-gray-800">{datoEditar ? "Editar tarifa" : "Nueva tarifa oficial"}</h2>

      {/* Tipo de servicio */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
          Categoría del servicio ({modo === "eventual" ? "EVENTUAL" : "FIJO"})
        </p>
        <div className="space-y-2">
          {tabs.map(tab => (
            <div key={tab.tab}>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">{tab.icon} {tab.label}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
                {tab.servicios.map(s => {
                  const act = form.tipo_servicio === s.id;
                  return (
                    <button key={s.id} onClick={() => setForm(p => ({ ...p, tipo_servicio: s.id }))}
                      className="flex items-start gap-1.5 px-3 py-2 rounded-xl border-2 transition-all text-left"
                      style={{ background: act ? tab.bg : "white", borderColor: act ? tab.color : "#e5e7eb", color: act ? tab.color : "#9ca3af" }}>
                      <span className="text-base flex-shrink-0">{s.icon}</span>
                      <div>
                        <p className="font-bold text-xs">{s.label}</p>
                        <p className="text-[9px] opacity-70">{s.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Vehículo */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Vehículo</p>
        <div className="space-y-2">
          {GRUPOS_VEH.map(g => (
            <div key={g.grupo}>
              <p className="text-[9px] font-black uppercase tracking-wider mb-1" style={{ color: g.color }}>{g.grupo}</p>
              <div className="flex gap-1.5 flex-wrap">
                {g.vehs.map(v => {
                  const act = form.tipo_vehiculo === v.id;
                  return (
                    <button key={v.id} onClick={() => setForm(p => ({ ...p, tipo_vehiculo: v.id }))}
                      className="flex flex-col items-center px-2 py-1.5 rounded-xl border-2 transition-all min-w-[60px]"
                      style={{ background: act ? g.bg : "white", borderColor: act ? g.color : "#e5e7eb", color: act ? g.color : "#9ca3af" }}>
                      <span className="text-base">{v.icon}</span>
                      <span className="text-[9px] font-bold">{v.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Equipamiento */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { val: "full_equipo", label: "⭐ Full Equipo", sub: "AC, TV, USB, GPS cliente", color: "#0b315f", bg: "#eef3f8" },
          { val: "basico",      label: "📦 Básico",      sub: "Estándar — cumple ley",    color: "#4b5563", bg: "#f3f4f6" },
        ].map(e => {
          const act = form.equipamiento === e.val;
          return (
            <button key={e.val} onClick={() => setForm(p => ({ ...p, equipamiento: e.val as Equip }))}
              className="flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-all"
              style={{ background: act ? e.bg : "white", borderColor: act ? e.color : "#e5e7eb", color: act ? e.color : "#9ca3af" }}>
              <div><p className="font-bold text-sm">{e.label}</p><p className="text-[10px] opacity-70">{e.sub}</p></div>
            </button>
          );
        })}
      </div>

      {/* Origen / Destino / Precio */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Origen *</label>
          <PlacesInputTar placeholder="Ej: Plaza Norte, Lima" value={form.origen} mapsLoaded={mapsLoaded}
            onChange={v => setForm(p => ({ ...p, origen: v }))} />
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Destino *</label>
          <PlacesInputTar placeholder="Ej: Planta Cajamarquilla" value={form.destino} mapsLoaded={mapsLoaded}
            onChange={v => setForm(p => ({ ...p, destino: v }))} />
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
            {modo === "fijo" ? "Precio / Día S/ *" : "Precio total S/ *"}
          </label>
          <input type="number" min="0" className={iCls("font-mono")}
            placeholder="0.00" value={form.precio}
            onChange={e => setForm(p => ({ ...p, precio: e.target.value }))} />
          {modo === "fijo" && form.precio && (
            <p className="text-[10px] text-green-600 font-bold mt-1">
              ~S/ {(Number(form.precio) * 26).toLocaleString("es-PE")} / mes (×26 días)
            </p>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Moneda</label>
          <select className={iCls()} value={form.moneda} onChange={e => setForm(p => ({ ...p, moneda: e.target.value }))}>
            <option value="PEN">🇵🇪 Soles</option>
            <option value="USD">🇺🇸 Dólares</option>
          </select>
        </div>
        <div className="md:col-span-4">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Notas</label>
          <input className={iCls()} placeholder="Ej: Incluye 2 paradas · máx. 8 horas"
            value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} />
        </div>
      </div>

      {/* Checkboxes */}
      <div className="flex flex-wrap gap-4">
        {[
          { key: "confidencial",        label: "🔒 Confidencial (Full Day / Tours especiales)" },
          { key: "incluye_guia",        label: "🎤 Incluye guía" },
          { key: "incluye_peajes",      label: "🛣️ Incluye peajes" },
          { key: "incluye_alimentacion",label: "🍽️ Incluye alimentación" },
        ].map(({ key, label }) => (
          <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" className="w-4 h-4 accent-[#0b315f]"
              checked={(form as any)[key]}
              onChange={e => setForm(p => ({ ...p, [key]: e.target.checked }))} />
            {label}
          </label>
        ))}
      </div>

      <div className="flex gap-3">
        <button onClick={guardar} disabled={saving}
          className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
          style={{ background: "#0b315f" }}>
          {saving ? "Guardando..." : datoEditar ? "Actualizar" : "Guardar tarifa"}
        </button>
        <button onClick={onCancelar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
          Cancelar
        </button>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function TarifarioPage() {
  const mapsLoaded = useGoogleMapsTar();
  const [tarifas,     setTarifas]     = useState<Tarifa[]>([]);
  const [cotRefs,     setCotRefs]     = useState<CotRef[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [modo,        setModo]        = useState<Modo>("eventual");
  const [equip,       setEquip]       = useState<Equip>("full_equipo");
  const [tabActivo,   setTabActivo]   = useState("traslados");
  const [servActivo,  setServActivo]  = useState("solo_ida");
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoT,   setEditandoT]   = useState<Tarifa | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [mostrarRef,  setMostrarRef]  = useState(true);
  const csvRef = useRef<HTMLInputElement>(null);

  const tabs = modo === "eventual" ? TABS_EVENTUAL : TABS_FIJO;
  const tabCfg = tabs.find(t => t.tab === tabActivo) || tabs[0];

  // Cambiar modo → resetear tabs
  const cambiarModo = (m: Modo) => {
    setModo(m);
    const primerTab = m === "eventual" ? TABS_EVENTUAL[0] : TABS_FIJO[0];
    setTabActivo(primerTab.tab);
    setServActivo(primerTab.servicios[0].id);
  };

  // Cambiar tab → poner primer servicio
  const cambiarTab = (t: string) => {
    setTabActivo(t);
    const tabObj = tabs.find(x => x.tab === t);
    if (tabObj) setServActivo(tabObj.servicios[0].id);
  };

  const cargar = async () => {
    setLoading(true);
    const [tRes, cRes] = await Promise.all([
      supabase.from("tarifario").select("*").eq("activo", true).order("origen"),
      supabase.from("cotizaciones")
        .select("id,origen,destino,precio_cliente,tipo_vehiculo,tipo_servicio,equipamiento,numero_cotizacion,estado,modo_servicio")
        .in("estado", ["aprobado", "enviado"]).order("id", { ascending: false }),
    ]);
    setTarifas(tRes.data || []);
    setCotRefs(cRes.data || []);
    setLoading(false);
  };
  useEffect(() => { cargar(); }, []);

  // Mapas de búsqueda rápida
  const mapaT = useMemo(() => {
    const m: Record<string, Tarifa> = {};
    tarifas.forEach(t => {
      m[`${t.origen}|${t.destino}|${t.tipo_vehiculo}|${t.equipamiento}|${t.tipo_servicio}|${t.modo}`] = t;
    });
    return m;
  }, [tarifas]);

  const mapaCot = useMemo(() => {
    const m: Record<string, CotRef> = {};
    cotRefs.forEach(c => {
      if (!c.tipo_vehiculo || !c.tipo_servicio) return;
      const k = `${c.origen?.toUpperCase()}|${c.destino?.toUpperCase()}|${c.tipo_vehiculo}|${c.equipamiento}|${c.tipo_servicio}|${c.modo_servicio || "eventual"}`;
      if (!m[k]) m[k] = c;
    });
    return m;
  }, [cotRefs]);

  const getTarifa = (o: string, d: string, veh: string) =>
    mapaT[`${o}|${d}|${veh}|${equip}|${servActivo}|${modo}`] || null;

  const getCotRef = (o: string, d: string, veh: string) =>
    mostrarRef ? (mapaCot[`${o}|${d}|${veh}|${equip}|${servActivo}|${modo}`] || null) : null;

  // Rutas únicas para la matriz
  const rutas = useMemo(() => {
    const set = new Set<string>();
    tarifas.filter(t => t.modo === modo).forEach(t => set.add(`${t.origen}|||${t.destino}`));
    if (mostrarRef) {
      cotRefs.filter(c => (c.modo_servicio || "eventual") === modo)
        .forEach(c => { if (c.origen && c.destino) set.add(`${c.origen.toUpperCase()}|||${c.destino.toUpperCase()}`); });
    }
    return [...set].sort().map(r => {
      const [o, d] = r.split("|||");
      return { origen: o, destino: d };
    }).filter(r => {
      if (!busqueda.trim()) return true;
      const q = norm(busqueda);
      return norm(r.origen).includes(q) || norm(r.destino).includes(q);
    });
  }, [tarifas, cotRefs, modo, mostrarRef, busqueda]);

  // KPIs
  const kpiEv   = tarifas.filter(t => t.modo === "eventual").length;
  const kpiFijo = tarifas.filter(t => t.modo === "fijo").length;
  const kpiConf = tarifas.filter(t => t.confidencial).length;

  async function guardarCelda(precio: number, origen: string, destino: string, veh: string, id?: number) {
    const payload = {
      origen, destino, tipo_vehiculo: veh, equipamiento: equip,
      tipo_servicio: servActivo, modo, precio, moneda: "PEN",
      confidencial: ["full_day", "multi_dia"].includes(servActivo),
      incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false, activo: true,
    };
    if (id) await supabase.from("tarifario").update({ precio }).eq("id", id);
    else     await supabase.from("tarifario").insert(payload);
    cargar();
  }

  async function eliminar(id: number) {
    if (!confirm("¿Eliminar esta tarifa?")) return;
    await supabase.from("tarifario").update({ activo: false }).eq("id", id);
    cargar();
  }

  const exportarCSV = () => {
    const h = "origen,destino,modo,tipo_vehiculo,equipamiento,tipo_servicio,precio,moneda,confidencial,notas";
    const rows = tarifas.map(t =>
      `${t.origen},${t.destino},${t.modo},${t.tipo_vehiculo},${t.equipamiento},${t.tipo_servicio},${t.precio},${t.moneda},${t.confidencial},${t.notas || ""}`
    );
    const blob = new Blob([[h, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tarifario_afa.csv"; a.click();
  };

  const importarCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { alert("CSV vacío"); return; }
    const hdr = lines[0].toLowerCase().split(",").map(h => h.trim());
    const g = (c: string) => hdr.indexOf(c);
    const rows = lines.slice(1).map(line => {
      const c = line.split(",").map(x => x.trim());
      return {
        origen: c[g("origen")]?.toUpperCase() || "",
        destino: c[g("destino")]?.toUpperCase() || "",
        modo: c[g("modo")] || "eventual",
        tipo_vehiculo: c[g("tipo_vehiculo")] || "BUS_49",
        equipamiento: c[g("equipamiento")] || "full_equipo",
        tipo_servicio: c[g("tipo_servicio")] || "solo_ida",
        precio: Number(c[g("precio")]) || 0, moneda: "PEN",
        confidencial: false, incluye_guia: false, incluye_peajes: false,
        incluye_alimentacion: false, activo: true,
      };
    }).filter(r => r.origen && r.destino && r.precio > 0);
    if (!rows.length) { alert("Sin filas válidas"); return; }
    const { error } = await supabase.from("tarifario").insert(rows);
    if (error) { alert("Error: " + error.message); return; }
    alert(`✅ ${rows.length} tarifas importadas`);
    cargar();
    if (csvRef.current) csvRef.current.value = "";
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-[1500px] mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Tarifario</h1>
          <p className="text-sm text-gray-400 mt-1">Precios oficiales · Eventual (por evento) y Fijo (por día)</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={importarCSV} />
          <button onClick={() => csvRef.current?.click()}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            📤 Importar CSV
          </button>
          <button onClick={exportarCSV}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            📥 Exportar
          </button>
          <button onClick={() => { setEditandoT(null); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nueva tarifa"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Tarifas eventuales", val: kpiEv,   color: "#0b315f", bg: "#eef3f8" },
          { label: "Tarifas fijas",       val: kpiFijo, color: "#166534", bg: "#dcfce7" },
          { label: "Confidenciales",       val: kpiConf, color: "#6d28d9", bg: "#ede9fe" },
          { label: "Total activas",        val: tarifas.length, color: "#0369a1", bg: "#e0f2fe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.val}</p>
          </div>
        ))}
      </div>

      {/* Leyenda */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        {[
          { ex: "S/ 350",            sub: "Tarifa oficial — clic para editar",             style: "border-gray-200 bg-white" },
          { ex: "S/ 280 📋 ref.",    sub: "Ref. cotización aprobada — clic para fijar",    style: "border-amber-200 bg-amber-50 text-amber-700" },
          { ex: "+ precio",           sub: "Sin tarifa aún — clic para agregar",            style: "border-dashed border-gray-200" },
        ].map((l, i) => (
          <div key={i} className={`rounded-xl px-4 py-2.5 flex items-center gap-3 border ${l.style}`}>
            <span className="font-black text-sm">{l.ex}</span>
            <span className="text-gray-500">{l.sub}</span>
          </div>
        ))}
      </div>

      {/* FORMULARIO */}
      {mostrarForm && (
        <FormTarifa
          modo={modo} editando={!!editandoT} datoEditar={editandoT}
          onGuardado={cargar} onCancelar={() => { setMostrarForm(false); setEditandoT(null); }}
          mapsLoaded={mapsLoaded}
        />
      )}

      {/* ── TOGGLE MODO PRINCIPAL ── */}
      <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">

        {/* Modo EVENTUAL / FIJO */}
        <div className="flex border-b">
          {[
            { id: "eventual", label: "📋 EVENTUAL", sub: "Precio total por evento",     color: "#0b315f", bg: "#eef3f8" },
            { id: "fijo",     label: "📅 FIJO",     sub: "Precio por día · contratos",  color: "#166534", bg: "#dcfce7" },
          ].map(m => (
            <button key={m.id} onClick={() => cambiarModo(m.id as Modo)}
              className="flex-1 flex flex-col items-center py-4 border-b-2 transition-all"
              style={{
                borderColor: modo === m.id ? m.color : "transparent",
                background:  modo === m.id ? m.bg : "white",
                color:       modo === m.id ? m.color : "#9ca3af",
              }}>
              <span className="font-black text-base">{m.label}</span>
              <span className="text-[11px] mt-0.5 opacity-70">{m.sub}</span>
              <span className="text-[10px] font-black mt-1 px-2 py-0.5 rounded-full text-white"
                style={{ background: modo === m.id ? m.color : "#d1d5db" }}>
                {m.id === "eventual" ? kpiEv : kpiFijo} tarifas
              </span>
            </button>
          ))}
        </div>

        {/* Tabs de categoría */}
        <div className="flex border-b overflow-x-auto">
          {tabs.map(tab => {
            const count = tarifas.filter(t => t.modo === modo && tab.servicios.some(s => s.id === t.tipo_servicio)).length;
            return (
              <button key={tab.tab} onClick={() => cambiarTab(tab.tab)}
                className="flex items-center gap-2 px-5 py-3 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
                style={{
                  borderColor: tabActivo === tab.tab ? tab.color : "transparent",
                  color:       tabActivo === tab.tab ? tab.color : "#9ca3af",
                  background:  tabActivo === tab.tab ? tab.bg + "88" : "white",
                }}>
                <span>{tab.icon}</span>{tab.label}
                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full text-white"
                  style={{ background: tabActivo === tab.tab ? tab.color : "#d1d5db" }}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Sub-servicios del tab */}
        {tabCfg.servicios.length > 1 && (
          <div className="flex gap-2 px-4 py-3 border-b bg-gray-50 flex-wrap">
            {tabCfg.servicios.map(s => (
              <button key={s.id} onClick={() => setServActivo(s.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border-2 transition-all"
                style={{
                  background:  servActivo === s.id ? tabCfg.bg : "white",
                  borderColor: servActivo === s.id ? tabCfg.color : "#e5e7eb",
                  color:       servActivo === s.id ? tabCfg.color : "#9ca3af",
                }}>
                <span>{s.icon}</span>{s.label}
                <span className="text-[10px] opacity-70 hidden md:inline">— {s.desc}</span>
              </button>
            ))}
          </div>
        )}

        {/* Controles: Equipamiento + Mostrar refs + Búsqueda */}
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap border-b bg-white">
          {/* Equipamiento */}
          <div className="flex rounded-xl border overflow-hidden flex-shrink-0">
            {[
              { val: "full_equipo", icon: "⭐", label: "Full Equipo" },
              { val: "basico",      icon: "📦", label: "Básico"      },
            ].map(e => (
              <button key={e.val} onClick={() => setEquip(e.val as Equip)}
                className="px-4 py-2 text-xs font-bold transition-all"
                style={{
                  background: equip === e.val ? "#0b315f" : "white",
                  color:      equip === e.val ? "white"    : "#0b315f",
                }}>
                {e.icon} {e.label}
              </button>
            ))}
          </div>

          {/* Mostrar refs */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-600 border rounded-xl px-3 py-2">
            <input type="checkbox" className="accent-amber-500" checked={mostrarRef} onChange={e => setMostrarRef(e.target.checked)} />
            Mostrar referencias de cotizaciones
          </label>

          {/* Descripción del modo actual */}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] font-bold px-3 py-1 rounded-full border"
              style={{ background: tabCfg.bg, color: tabCfg.color, borderColor: tabCfg.color + "44" }}>
              {tabCfg.icon} {tabCfg.desc}
            </span>
            {modo === "fijo" && (
              <span className="text-[11px] font-bold bg-green-50 text-green-700 border border-green-200 px-3 py-1 rounded-full">
                Precio/Día → ×26 = Mes
              </span>
            )}
          </div>
        </div>

        {/* Búsqueda */}
        <div className="px-4 py-2 border-b">
          <input className="w-full max-w-sm border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
            placeholder="🔍 Filtrar por origen o destino..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          <span className="text-[11px] text-gray-400 ml-3">{rutas.length} rutas</span>
        </div>

        {/* ── MATRIZ ── */}
        <div className="overflow-x-auto">
          <table className="text-sm border-collapse w-full">
            <thead>
              {/* Fila de grupos */}
              <tr>
                <th className="border border-gray-200 px-4 py-2 text-left bg-gray-50 sticky left-0 z-10 min-w-[200px]" rowSpan={2}>
                  <div className="font-bold text-gray-700">Ruta</div>
                  <div className="text-[10px] text-gray-400 font-normal mt-0.5">
                    {tabCfg.icon} {tabCfg.servicios.find(s => s.id === servActivo)?.label} · {equip === "full_equipo" ? "⭐ Full Equipo" : "📦 Básico"}
                  </div>
                </th>
                {GRUPOS_VEH.map(g => (
                  <th key={g.grupo} colSpan={g.vehs.length}
                    className="border border-gray-200 px-2 py-1.5 text-center text-[10px] font-black uppercase tracking-wide"
                    style={{ background: g.bg, color: g.color }}>
                    {g.grupo}
                  </th>
                ))}
              </tr>
              {/* Fila de vehículos */}
              <tr>
                {TODOS_VEH.map(v => (
                  <th key={v.id} className="border border-gray-200 px-1 py-2 bg-gray-50 text-center min-w-[80px]">
                    <div className="text-base">{v.icon}</div>
                    <div className="text-[9px] font-black text-gray-600 leading-tight">{v.label}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={TODOS_VEH.length + 1} className="p-10 text-center text-gray-400">
                  <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-2" />Cargando...
                </td></tr>
              ) : rutas.length === 0 ? (
                <tr><td colSpan={TODOS_VEH.length + 1} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🗺️</p>
                  <p className="font-semibold">Sin rutas registradas</p>
                  <p className="text-xs mt-1">Haz clic en "+ precio" en cualquier celda o usa el botón "Nueva tarifa"</p>
                </td></tr>
              ) : rutas.map(({ origen, destino }, i) => (
                <tr key={`${origen}-${destino}`} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                  <td className="border border-gray-200 px-4 py-2.5 sticky left-0 z-10 font-bold"
                    style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                    <span className="font-black text-[#0b315f] font-mono text-sm">{origen}</span>
                    <span className="text-gray-300 mx-1.5">→</span>
                    <span className="font-bold text-gray-700 text-sm">{destino}</span>
                  </td>
                  {TODOS_VEH.map(v => {
                    const tarifa = getTarifa(origen, destino, v.id);
                    const cotRef = !tarifa ? getCotRef(origen, destino, v.id) : null;
                    return (
                      <Celda key={v.id}
                        tarifa={tarifa} cotRef={cotRef} modo={modo}
                        confidencial={["full_day", "multi_dia"].includes(servActivo)}
                        onGuardar={(precio, id) => guardarCelda(precio, origen, destino, v.id, id)}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between">
          <span>{rutas.length} rutas · {tabCfg.icon} {tabCfg.servicios.find(s => s.id === servActivo)?.label} · {equip === "full_equipo" ? "⭐ Full Equipo" : "📦 Básico"}</span>
          <span>AFA ERP · Tarifario {modo === "eventual" ? "EVENTUAL" : "FIJO"}</span>
        </div>
      </div>

      {/* Vista lista */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-700">Todas las tarifas activas</h2>
          <span className="text-xs text-gray-400">{tarifas.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                {["Modo","Ruta","Servicio","Vehículo","Equip.","Precio","Mes (×26)","Incluye","Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {tarifas.map(t => {
                const veh   = TODOS_VEH.find(v => v.id === t.tipo_vehiculo);
                const serv  = [...TABS_EVENTUAL, ...TABS_FIJO].flatMap(tab => tab.servicios).find(s => s.id === t.tipo_servicio);
                const tabOf = [...TABS_EVENTUAL, ...TABS_FIJO].find(tab => tab.servicios.some(s => s.id === t.tipo_servicio));
                const incluye = [t.incluye_guia && "🎤", t.incluye_peajes && "🛣️", t.incluye_alimentacion && "🍽️"].filter(Boolean).join(" ");
                return (
                  <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-3">
                      <span className={`text-[10px] font-black px-2 py-1 rounded-full ${t.modo === "fijo" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                        {t.modo === "fijo" ? "📅 FIJO" : "📋 EVENTUAL"}
                      </span>
                    </td>
                    <td className="p-3 font-bold">
                      <span className="text-[#0b315f] font-mono">{t.origen}</span>
                      <span className="text-gray-300 mx-1">→</span>
                      <span className="text-gray-700">{t.destino}</span>
                    </td>
                    <td className="p-3">
                      {tabOf && <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: tabOf.bg, color: tabOf.color }}>{tabOf.icon} {serv?.label || t.tipo_servicio}</span>}
                    </td>
                    <td className="p-3 text-xs text-gray-600">{veh?.icon} {t.capacidad_custom || veh?.label || t.tipo_vehiculo}</td>
                    <td className="p-3">
                      <span className="text-[10px] font-bold">{t.equipamiento === "full_equipo" ? "⭐ Full" : "📦 Básico"}</span>
                    </td>
                    <td className="p-3 font-black font-mono">
                      {t.confidencial ? <span className="text-purple-700">🔒 Conf.</span> : fmtP(t.precio, t.moneda)}
                      {t.modo === "fijo" && <p className="text-[10px] text-gray-400 font-normal">/día</p>}
                    </td>
                    <td className="p-3 text-xs text-gray-500 font-mono">
                      {t.modo === "fijo" && !t.confidencial ? `~${fmtP(t.precio * 26)}` : "—"}
                    </td>
                    <td className="p-3 text-sm">{incluye || "—"}</td>
                    <td className="p-3">
                      <div className="flex gap-1.5">
                        <button onClick={() => { setEditandoT(t); setMostrarForm(true); }}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                        <button onClick={() => eliminar(t.id)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}