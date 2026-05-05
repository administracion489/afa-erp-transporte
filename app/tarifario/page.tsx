"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Tarifa = {
  id: number; origen: string; destino: string;
  tipo_vehiculo: string; capacidad_custom: string | null;
  equipamiento: string; tipo_servicio: string;
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
  fecha_servicio: string | null;
};

type Vista = "matriz" | "lista" | "historial";
type Equip = "full_equipo" | "basico";
type Servicio = "solo_ida" | "ida_retorno" | "ida_retorno_paradas" | "full_day";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIPOS_SERVICIO: Record<Servicio, { label: string; icon: string; desc: string; color: string; bg: string; confidencialDefault: boolean }> = {
  solo_ida:             { label: "Solo ida",              icon: "➡️", desc: "Un tramo sin retorno",                      color: "#0b315f", bg: "#eef3f8", confidencialDefault: false },
  ida_retorno:          { label: "Ida y retorno",         icon: "🔄", desc: "Ida y vuelta sin paradas intermedias",       color: "#166534", bg: "#dcfce7", confidencialDefault: false },
  ida_retorno_paradas:  { label: "Ida/retorno + paradas", icon: "📍", desc: "Recorrido con visitas o puntos intermedios", color: "#854d0e", bg: "#fef9c3", confidencialDefault: false },
  full_day:             { label: "Full Day / Tour",       icon: "⭐", desc: "Itinerario completo para agencias",          color: "#6d28d9", bg: "#ede9fe", confidencialDefault: true  },
};

const TIPOS_VEHICULO = [
  { id: "AUTO_4",      label: "Auto 4 pax",        pax: 4,  icon: "🚗" },
  { id: "SUV_4",       label: "SUV 4 pax",         pax: 4,  icon: "🚙" },
  { id: "SUV_6",       label: "SUV 6 pax",         pax: 6,  icon: "🚙" },
  { id: "MINIVAN_10",  label: "Minivan 10 pax",    pax: 10, icon: "🚐" },
  { id: "VAN_15",      label: "Van 15 pax",        pax: 15, icon: "🚐" },
  { id: "SPRINTER_17", label: "Sprinter 17 pax",   pax: 17, icon: "🚌" },
  { id: "SPRINTER_20", label: "Sprinter 20 pax",   pax: 20, icon: "🚌" },
  { id: "CUSTER_25",   label: "Custer 25 pax",     pax: 25, icon: "🚌" },
  { id: "MINIBUS_30",  label: "Minibus 30 pax",    pax: 30, icon: "🚌" },
  { id: "MINIBUS_35",  label: "Minibus 35 pax",    pax: 35, icon: "🚌" },
  { id: "BUS_40",      label: "Bus 40 pax",        pax: 40, icon: "🚌" },
  { id: "BUS_45",      label: "Bus 45 pax",        pax: 45, icon: "🚌" },
  { id: "BUS_49",      label: "Bus 49 pax",        pax: 49, icon: "🚌" },
  { id: "BUS_50",      label: "Bus 50 pax",        pax: 50, icon: "🚌" },
  { id: "BUS_54",      label: "Bus 54 pax",        pax: 54, icon: "🚌" },
  { id: "BUS_60",      label: "Bus 60 pax",        pax: 60, icon: "🚌" },
  { id: "CUSTOM",      label: "Personalizado",     pax: 0,  icon: "✏️" },
];

const EQUIP_CFG: Record<Equip, { label: string; icon: string; color: string; bg: string }> = {
  full_equipo: { label: "Full Equipo", icon: "⭐", color: "#0b315f", bg: "#eef3f8" },
  basico:      { label: "Básico",      icon: "📦", color: "#4b5563", bg: "#f3f4f6" },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtPrecio(n: number, moneda = "PEN") {
  return `${moneda === "USD" ? "$ " : "S/ "}${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function norm(s: string) {
  return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}
function inputCls(e = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;
}
function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

const FORM_VACIO = {
  origen: "", destino: "", tipo_vehiculo: "AUTO_4", capacidad_custom: "",
  equipamiento: "full_equipo" as Equip, tipo_servicio: "solo_ida" as Servicio,
  precio: "", moneda: "PEN", confidencial: false,
  incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
  notas: "", activo: true,
};

// ─── CELDA EDITABLE ───────────────────────────────────────────────────────────

function CeldaMatriz({ tarifa, cotRef, onGuardar, confidencial }: {
  tarifa: Tarifa | null; cotRef: CotRef | null;
  onGuardar: (precio: number, id?: number) => void; confidencial?: boolean;
}) {
  const [editando, setEditando] = useState(false);
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  const abrir = () => { setVal(tarifa ? String(tarifa.precio) : (cotRef ? String(Math.round(Number(cotRef.precio_cliente) / 1.18)) : "")); setEditando(true); setTimeout(() => ref.current?.focus(), 50); };
  const guardar = () => { const p = Number(val); if (val.trim() && !isNaN(p) && p >= 0) onGuardar(p, tarifa?.id); setEditando(false); };

  if (editando) return (
    <td className="border border-gray-200 p-0 min-w-[100px]">
      <input ref={ref} type="number" min="0" className="w-full px-2 py-1.5 text-sm font-mono text-center border-0 outline-none bg-blue-50 font-bold"
        value={val} onChange={e => setVal(e.target.value)} onBlur={guardar}
        onKeyDown={e => { if (e.key === "Enter") guardar(); if (e.key === "Escape") setEditando(false); }} />
    </td>
  );

  // Tiene tarifa oficial
  if (tarifa) {
    const isConf = confidencial || tarifa.confidencial;
    return (
      <td className={`border p-0 min-w-[100px] cursor-pointer transition-colors group ${isConf ? "border-purple-100 hover:bg-purple-50" : "border-gray-100 hover:bg-blue-50"}`} onClick={abrir}>
        <div className="px-2 py-2 text-center">
          {isConf
            ? <div className="text-[10px] font-black text-purple-700">🔒 {fmtPrecio(tarifa.precio)}</div>
            : <div className="text-xs font-black text-gray-800 group-hover:text-blue-700 font-mono">{fmtPrecio(tarifa.precio)}</div>}
          {(tarifa.incluye_guia || tarifa.incluye_peajes || tarifa.incluye_alimentacion) && (
            <div className="text-[9px] mt-0.5 flex justify-center gap-0.5">
              {tarifa.incluye_guia && "🎤"}{tarifa.incluye_peajes && "🛣️"}{tarifa.incluye_alimentacion && "🍽️"}
            </div>
          )}
        </div>
      </td>
    );
  }

  // Solo tiene referencia de cotización (no tarifa oficial)
  if (cotRef) {
    const precioRef = Math.round(Number(cotRef.precio_cliente) / 1.18);
    return (
      <td className="border border-amber-100 p-0 min-w-[100px] cursor-pointer hover:bg-amber-50 transition-colors group" onClick={abrir}
        title={`Ref. cotización #${cotRef.numero_cotizacion || cotRef.id} · Precio con IGV: ${fmtPrecio(Number(cotRef.precio_cliente))}`}>
        <div className="px-2 py-2 text-center">
          <div className="text-[10px] font-bold text-amber-700 group-hover:text-amber-900 font-mono">{fmtPrecio(precioRef)}</div>
          <div className="text-[9px] text-amber-500">📋 ref. cot.</div>
        </div>
      </td>
    );
  }

  // Vacía
  return (
    <td className="border border-gray-100 p-0 min-w-[100px] cursor-pointer hover:bg-blue-50 transition-colors group" onClick={abrir}>
      <div className="px-2 py-2.5 text-center text-gray-200 text-[10px] group-hover:text-blue-400 font-bold">+ precio</div>
    </td>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function TarifarioPage() {
  const [tarifas,     setTarifas]     = useState<Tarifa[]>([]);
  const [cotRefs,     setCotRefs]     = useState<CotRef[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [vista,       setVista]       = useState<Vista>("matriz");
  const [servicioAct, setServicioAct] = useState<Servicio>("solo_ida");
  const [equipActivo, setEquipActivo] = useState<Equip>("full_equipo");
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroServ,  setFiltroServ]  = useState("todos");
  const [vehs,        setVehs]        = useState<string[]>(TIPOS_VEHICULO.filter(t => t.id !== "CUSTOM").map(t => t.id));
  const [mostrarCotRefs, setMostrarCotRefs] = useState(true);
  const [form, setForm] = useState(FORM_VACIO);
  const csvRef = useRef<HTMLInputElement>(null);

  const servicioActCfg = TIPOS_SERVICIO[servicioAct];

  const cambiarServicio = (s: Servicio) => {
    setServicioAct(s);
    setForm(p => ({ ...p, tipo_servicio: s, confidencial: TIPOS_SERVICIO[s].confidencialDefault }));
  };

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [tRes, cRes] = await Promise.all([
      supabase.from("tarifario").select("*").eq("activo", true).order("origen").order("destino"),
      supabase.from("cotizaciones").select("id,origen,destino,precio_cliente,tipo_vehiculo,tipo_servicio,equipamiento,numero_cotizacion,estado,fecha_servicio")
        .in("estado", ["aprobado", "enviado"]).order("id", { ascending: false }),
    ]);
    setTarifas(tRes.data || []);
    setCotRefs(cRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── Mapas ─────────────────────────────────────────────────────────────────

  const rutas = useMemo(() => {
    const set = new Set<string>();
    tarifas.forEach(t => set.add(`${t.origen}|||${t.destino}`));
    if (mostrarCotRefs) cotRefs.forEach(c => { if (c.origen && c.destino) set.add(`${c.origen.toUpperCase()}|||${c.destino.toUpperCase()}`); });
    return [...set].sort().map(r => { const [o, d] = r.split("|||"); return { origen: o, destino: d, key: r }; });
  }, [tarifas, cotRefs, mostrarCotRefs]);

  const rutasFiltradas = useMemo(() => {
    if (!busqueda.trim()) return rutas;
    const q = norm(busqueda);
    return rutas.filter(r => norm(r.origen).includes(q) || norm(r.destino).includes(q));
  }, [rutas, busqueda]);

  const mapaMatrix = useMemo(() => {
    const m: Record<string, Tarifa> = {};
    tarifas.forEach(t => { m[`${t.origen}|||${t.destino}|||${t.tipo_vehiculo}|||${t.equipamiento}|||${t.tipo_servicio}`] = t; });
    return m;
  }, [tarifas]);

  // Mapa de referencias de cotizaciones
  const mapaCotRef = useMemo(() => {
    const m: Record<string, CotRef> = {};
    cotRefs.forEach(c => {
      if (!c.tipo_vehiculo || !c.tipo_servicio || !c.equipamiento) return;
      const key = `${c.origen?.toUpperCase()}|||${c.destino?.toUpperCase()}|||${c.tipo_vehiculo}|||${c.equipamiento}|||${c.tipo_servicio}`;
      if (!m[key]) m[key] = c; // solo la más reciente
    });
    return m;
  }, [cotRefs]);

  const getTarifa = (o: string, d: string, t: string, e: string, s: string): Tarifa | null =>
    mapaMatrix[`${o}|||${d}|||${t}|||${e}|||${s}`] || null;
  const getCotRef = (o: string, d: string, t: string, e: string, s: string): CotRef | null =>
    mostrarCotRefs ? (mapaCotRef[`${o}|||${d}|||${t}|||${e}|||${s}`] || null) : null;

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.origen.trim() || !form.destino.trim() || !form.precio) { alert("Origen, destino y precio son obligatorios"); return; }
    if (form.tipo_vehiculo === "CUSTOM" && !form.capacidad_custom.trim()) { alert("Describe el vehículo personalizado"); return; }
    setGuardando(true);
    const payload = {
      origen: form.origen.trim().toUpperCase(), destino: form.destino.trim().toUpperCase(),
      tipo_vehiculo: form.tipo_vehiculo, capacidad_custom: form.tipo_vehiculo === "CUSTOM" ? form.capacidad_custom.trim() : null,
      equipamiento: form.equipamiento, tipo_servicio: form.tipo_servicio,
      precio: Number(form.precio), moneda: form.moneda, confidencial: form.confidencial,
      incluye_guia: form.incluye_guia, incluye_peajes: form.incluye_peajes, incluye_alimentacion: form.incluye_alimentacion,
      notas: form.notas.trim() || null, activo: true,
    };
    const { error } = editandoId
      ? await supabase.from("tarifario").update(payload).eq("id", editandoId)
      : await supabase.from("tarifario").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const guardarCelda = async (precio: number, origen: string, destino: string, tipo: string, equip: string, serv: string, id?: number) => {
    if (id) {
      await supabase.from("tarifario").update({ precio }).eq("id", id);
    } else {
      await supabase.from("tarifario").insert({
        origen: origen.toUpperCase(), destino: destino.toUpperCase(),
        tipo_vehiculo: tipo, equipamiento: equip, tipo_servicio: serv,
        precio, moneda: "PEN", confidencial: serv === "full_day",
        incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false, activo: true,
      });
    }
    cargarDatos();
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar esta tarifa?")) return;
    await supabase.from("tarifario").update({ activo: false }).eq("id", id);
    cargarDatos();
  };

  const editar = (t: Tarifa) => {
    setForm({
      origen: t.origen, destino: t.destino, tipo_vehiculo: t.tipo_vehiculo,
      capacidad_custom: t.capacidad_custom || "", equipamiento: t.equipamiento as Equip,
      tipo_servicio: t.tipo_servicio as Servicio, precio: String(t.precio), moneda: t.moneda,
      confidencial: t.confidencial, incluye_guia: t.incluye_guia, incluye_peajes: t.incluye_peajes,
      incluye_alimentacion: t.incluye_alimentacion, notas: t.notas || "", activo: t.activo,
    });
    setEditandoId(t.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  // ── CSV ────────────────────────────────────────────────────────────────────

  const importarCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { alert("CSV vacío"); return; }
    const header = lines[0].toLowerCase().split(",").map(h => h.trim());
    const g = (col: string) => header.indexOf(col);
    const iO = g("origen"), iD = g("destino"), iT = g("tipo_vehiculo"), iE = g("equipamiento"), iP = g("precio"), iS = g("tipo_servicio");
    if ([iO, iD, iT, iE, iP].includes(-1)) { alert("CSV requiere: origen, destino, tipo_vehiculo, equipamiento, precio"); return; }
    const rows = lines.slice(1).map(line => {
      const c = line.split(",").map(x => x.trim());
      return {
        origen: c[iO]?.toUpperCase() || "", destino: c[iD]?.toUpperCase() || "",
        tipo_vehiculo: c[iT] || "AUTO_4", equipamiento: c[iE] || "full_equipo",
        tipo_servicio: iS >= 0 ? c[iS] || "solo_ida" : "solo_ida",
        precio: Number(c[iP]) || 0, moneda: "PEN",
        confidencial: false, incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false, activo: true,
      };
    }).filter(r => r.origen && r.destino && r.precio > 0);
    if (!rows.length) { alert("Sin filas válidas"); return; }
    const { error } = await supabase.from("tarifario").insert(rows);
    if (error) { alert("Error: " + error.message); return; }
    alert(`✅ ${rows.length} tarifas importadas`);
    cargarDatos();
    if (csvRef.current) csvRef.current.value = "";
  };

  const exportarCSV = () => {
    const header = "origen,destino,tipo_vehiculo,equipamiento,tipo_servicio,precio,moneda,confidencial,incluye_guia,incluye_peajes,incluye_alimentacion,notas";
    const rows = tarifas.map(t =>
      `${t.origen},${t.destino},${t.tipo_vehiculo},${t.equipamiento},${t.tipo_servicio},${t.precio},${t.moneda},${t.confidencial},${t.incluye_guia},${t.incluye_peajes},${t.incluye_alimentacion},${t.notas || ""}`
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tarifario_afa.csv"; a.click();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const kpisPorServ = Object.entries(TIPOS_SERVICIO).map(([k, v]) => ({ serv: k, cfg: v, count: tarifas.filter(t => t.tipo_servicio === k).length }));
  const tiposVisibles = TIPOS_VEHICULO.filter(t => t.id !== "CUSTOM" && vehs.includes(t.id));

  const listaFiltrada = useMemo(() => tarifas.filter(t => {
    const q = norm(busqueda);
    return (!busqueda.trim() || norm(t.origen).includes(q) || norm(t.destino).includes(q)) &&
      (filtroServ === "todos" || t.tipo_servicio === filtroServ);
  }), [tarifas, busqueda, filtroServ]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-[1400px] mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Tarifario</h1>
          <p className="text-gray-400 text-sm mt-1">Precios oficiales · cotizaciones como referencia · base para sugerencias automáticas</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={importarCSV} />
          <button onClick={() => csvRef.current?.click()} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">📤 Importar CSV</button>
          <button onClick={exportarCSV} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">📥 Exportar</button>
          <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nueva tarifa"}
          </button>
        </div>
      </div>

      {/* Leyenda integración */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 border" style={{ background: "#eef3f8", borderColor: "#0b315f33" }}>
          <span className="font-black text-[#0b315f]">S/ 350</span>
          <span className="text-gray-500">Tarifa oficial registrada — editable con clic</span>
        </div>
        <div className="rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 border border-amber-200" style={{ background: "#fffbeb" }}>
          <span className="font-black text-amber-700">S/ 280 <span className="text-[9px]">📋 ref. cot.</span></span>
          <span className="text-gray-500">Precio de cotización aprobada — clic para fijar como oficial</span>
        </div>
        <div className="rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 border border-dashed border-gray-200">
          <span className="text-gray-300 font-bold">+ precio</span>
          <span className="text-gray-500">Sin tarifa aún — clic para agregar</span>
        </div>
      </div>

      {/* KPIs por tipo de servicio */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpisPorServ.map(({ serv, cfg, count }) => (
          <div key={serv} className="rounded-xl p-3 border cursor-pointer hover:shadow-sm transition-all"
            style={{ background: cfg.bg, borderColor: cfg.color + "33" }}
            onClick={() => { setServicioAct(serv as Servicio); setVista("matriz"); }}>
            <div className="flex items-center gap-2 mb-1"><span className="text-xl">{cfg.icon}</span>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cfg.color + "99" }}>{cfg.label}</p></div>
            <p className="text-2xl font-black" style={{ color: cfg.color }}>{count}</p>
            <p className="text-[10px]" style={{ color: cfg.color + "88" }}>{cfg.desc}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold">{editandoId ? "Editar tarifa" : "Nueva tarifa oficial"}</h2>

          {/* Tipo servicio */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de servicio</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {Object.entries(TIPOS_SERVICIO).map(([k, v]) => {
                const act = form.tipo_servicio === k;
                return (
                  <button key={k} onClick={() => cambiarServicio(k as Servicio)}
                    className="flex flex-col gap-1 px-4 py-3 rounded-xl border-2 transition-all text-left"
                    style={{ background: act ? v.bg : "white", borderColor: act ? v.color : "#e5e7eb", color: act ? v.color : "#9ca3af" }}>
                    <span className="text-2xl">{v.icon}</span>
                    <span className="font-black text-sm leading-tight">{v.label}</span>
                    <span className="text-[10px] opacity-70">{v.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tipo vehículo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de vehículo</p>
            <div className="grid grid-cols-4 md:grid-cols-9 gap-1.5">
              {TIPOS_VEHICULO.map(t => {
                const act = form.tipo_vehiculo === t.id;
                return (
                  <button key={t.id} onClick={() => setForm(p => ({ ...p, tipo_vehiculo: t.id }))}
                    className="flex flex-col items-center gap-0.5 px-1.5 py-2 rounded-xl border-2 transition-all"
                    style={{ background: act ? "#eef3f8" : "white", borderColor: act ? "#0b315f" : "#e5e7eb", color: act ? "#0b315f" : "#9ca3af" }}>
                    <span className="text-base">{t.icon}</span>
                    <span className="text-[8px] font-bold leading-tight text-center">{t.label}</span>
                  </button>
                );
              })}
            </div>
            {form.tipo_vehiculo === "CUSTOM" && (
              <div className="mt-3 rounded-xl border-2 border-dashed border-[#0b315f] px-4 py-3 bg-[#eef3f8]">
                <p className="text-[10px] font-bold text-[#0b315f] mb-1 uppercase">Describe el vehículo</p>
                <input className={inputCls()} placeholder="Ej: Bus Carrocería Especial 62 pax, Van Doble 22 pax..."
                  value={form.capacidad_custom} onChange={e => setForm(p => ({ ...p, capacidad_custom: e.target.value }))} />
              </div>
            )}
          </div>

          {/* Equipamiento */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Equipamiento</p>
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(EQUIP_CFG) as [Equip, typeof EQUIP_CFG[Equip]][]).map(([k, v]) => {
                const act = form.equipamiento === k;
                return (
                  <button key={k} onClick={() => setForm(p => ({ ...p, equipamiento: k }))}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all"
                    style={{ background: act ? v.bg : "white", borderColor: act ? v.color : "#e5e7eb", color: act ? v.color : "#9ca3af" }}>
                    <span className="text-2xl">{v.icon}</span>
                    <div className="text-left">
                      <p className="font-black text-sm">{v.label}</p>
                      <p className="text-[11px] opacity-70">{k === "full_equipo" ? "AC, TV, WiFi, comodidades premium" : "Servicio estándar sin extras"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Ruta y precio</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Origen *"><input className={inputCls("uppercase font-mono")} placeholder="LIMA" value={form.origen} onChange={e => setForm(p => ({ ...p, origen: e.target.value.toUpperCase() }))} /></Campo>
              <Campo label="Destino *"><input className={inputCls("uppercase font-mono")} placeholder="ICA" value={form.destino} onChange={e => setForm(p => ({ ...p, destino: e.target.value.toUpperCase() }))} /></Campo>
              <Campo label="Precio S/ *"><input type="number" min="0" className={inputCls("font-mono")} value={form.precio} onChange={e => setForm(p => ({ ...p, precio: e.target.value }))} /></Campo>
              <Campo label="Moneda">
                <select className={inputCls()} value={form.moneda} onChange={e => setForm(p => ({ ...p, moneda: e.target.value }))}>
                  <option value="PEN">🇵🇪 Soles</option><option value="USD">🇺🇸 Dólares</option>
                </select>
              </Campo>
              <Campo label="Notas" span={3}><input className={inputCls()} placeholder="Ej: Incluye 2 paradas · Huacachina y Paracas · 8 horas" value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} /></Campo>
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { key: "confidencial",         label: "🔒 Tarifa confidencial" },
                { key: "incluye_guia",          label: "🎤 Incluye guía" },
                { key: "incluye_peajes",        label: "🛣️ Incluye peajes" },
                { key: "incluye_alimentacion",  label: "🍽️ Incluye alimentación" },
              ].map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-[#0b315f]"
                    checked={(form as any)[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.checked }))} />
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar tarifa oficial"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b">
        {(["matriz", "lista", "historial"] as Vista[]).map(v => (
          <button key={v} onClick={() => setVista(v)}
            className="px-5 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {v === "matriz" ? "📊 Matriz" : v === "lista" ? "📋 Lista" : "📋 Cotizaciones referencia"}
          </button>
        ))}
      </div>

      {/* Búsqueda */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por origen o destino..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        {vista === "lista" && (
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroServ} onChange={e => setFiltroServ(e.target.value)}>
            <option value="todos">Todos los servicios</option>
            {Object.entries(TIPOS_SERVICIO).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
        )}
        {vista === "matriz" && (
          <label className="flex items-center gap-2 cursor-pointer px-4 py-2.5 border rounded-xl text-sm text-gray-600">
            <input type="checkbox" className="accent-amber-500" checked={mostrarCotRefs} onChange={e => setMostrarCotRefs(e.target.checked)} />
            <span>Mostrar referencias de cotizaciones</span>
          </label>
        )}
      </div>

      {/* ── VISTA MATRIZ ── */}
      {vista === "matriz" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {/* Tabs tipo servicio */}
          <div className="flex border-b overflow-x-auto" style={{ borderColor: "#f1f5f9" }}>
            {Object.entries(TIPOS_SERVICIO).map(([k, v]) => {
              const act = servicioAct === k;
              const count = tarifas.filter(t => t.tipo_servicio === k).length;
              return (
                <button key={k} onClick={() => setServicioAct(k as Servicio)}
                  className="flex items-center gap-2 px-5 py-3.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
                  style={{ borderColor: act ? v.color : "transparent", color: act ? v.color : "#9ca3af", background: act ? v.bg + "88" : "white" }}>
                  <span>{v.icon}</span>{v.label}
                  <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full text-white" style={{ background: act ? v.color : "#d1d5db" }}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Equipamiento + columnas */}
          <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-3" style={{ borderColor: "#f1f5f9" }}>
            <div className="flex rounded-xl border overflow-hidden flex-shrink-0">
              {(["full_equipo", "basico"] as Equip[]).map(eq => {
                const cfg = EQUIP_CFG[eq]; const act = equipActivo === eq;
                return (
                  <button key={eq} onClick={() => setEquipActivo(eq)} className="px-4 py-2 text-xs font-bold transition-all"
                    style={{ background: act ? cfg.color : "white", color: act ? "white" : cfg.color }}>
                    {cfg.icon} {cfg.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-gray-400 font-bold">Columnas:</span>
              {TIPOS_VEHICULO.filter(t => t.id !== "CUSTOM").map(t => {
                const act = vehs.includes(t.id);
                return (
                  <button key={t.id} onClick={() => setVehs(prev => act ? prev.filter(v => v !== t.id) : [...prev, t.id])}
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded border transition-all"
                    style={{ background: act ? "#eef3f8" : "white", borderColor: act ? "#0b315f" : "#e5e7eb", color: act ? "#0b315f" : "#9ca3af" }}>
                    {t.icon} {t.pax}p
                  </button>
                );
              })}
            </div>
          </div>

          {servicioAct === "full_day" && (
            <div className="px-4 py-2 text-xs flex items-center gap-2" style={{ background: "#ede9fe", color: "#6d28d9" }}>
              🔒 Los precios Full Day son <b>confidenciales</b> — en cotizaciones aparecen como "Tarifa especial · consultar"
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="text-sm border-collapse w-full">
              <thead>
                <tr>
                  <th className="border border-gray-200 px-4 py-3 text-left bg-gray-50 font-bold text-gray-700 sticky left-0 z-10 min-w-[220px]">
                    <div>Ruta <span className="font-normal text-gray-400">Origen → Destino</span></div>
                    <div className="text-[10px] font-normal text-gray-400">{servicioActCfg.icon} {servicioActCfg.label} · {EQUIP_CFG[equipActivo].icon} {EQUIP_CFG[equipActivo].label}</div>
                  </th>
                  {tiposVisibles.map(t => (
                    <th key={t.id} className="border border-gray-200 px-2 py-2 bg-gray-50 text-center" style={{ minWidth: 100 }}>
                      <div className="text-base">{t.icon}</div>
                      <div className="text-[10px] font-black text-gray-700 leading-tight">{t.label}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={tiposVisibles.length + 1} className="p-10 text-center text-gray-400">
                    <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-2" />Cargando...
                  </td></tr>
                ) : rutasFiltradas.length === 0 ? (
                  <tr><td colSpan={tiposVisibles.length + 1} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">🗺️</p><p>Sin rutas registradas</p>
                  </td></tr>
                ) : rutasFiltradas.map((ruta, i) => (
                  <tr key={ruta.key} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                    <td className="border border-gray-200 px-4 py-2.5 sticky left-0 z-10 font-bold"
                      style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                      <span className="font-black text-[#0b315f] font-mono">{ruta.origen}</span>
                      <span className="text-gray-300 mx-1.5">→</span>
                      <span className="font-bold text-gray-700">{ruta.destino}</span>
                    </td>
                    {tiposVisibles.map(t => {
                      const tarifa = getTarifa(ruta.origen, ruta.destino, t.id, equipActivo, servicioAct);
                      const cotRef = !tarifa ? getCotRef(ruta.origen, ruta.destino, t.id, equipActivo, servicioAct) : null;
                      return (
                        <CeldaMatriz key={t.id} tarifa={tarifa} cotRef={cotRef}
                          confidencial={servicioAct === "full_day"}
                          onGuardar={(precio, id) => guardarCelda(precio, ruta.origen, ruta.destino, t.id, equipActivo, servicioAct, id)} />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{rutasFiltradas.length} rutas · {servicioActCfg.icon} {servicioActCfg.label} · {EQUIP_CFG[equipActivo].label}</span>
            <span>AFA ERP · Tarifario</span>
          </div>
        </section>
      )}

      {/* ── VISTA LISTA ── */}
      {vista === "lista" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Ruta", "Servicio", "Vehículo", "Equipamiento", "Precio", "Incluye", "Notas", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listaFiltrada.map(t => {
                  const veh = TIPOS_VEHICULO.find(v => v.id === t.tipo_vehiculo);
                  const equip = EQUIP_CFG[t.equipamiento as Equip] || EQUIP_CFG.full_equipo;
                  const serv = TIPOS_SERVICIO[t.tipo_servicio as Servicio] || TIPOS_SERVICIO.solo_ida;
                  const incluye = [t.incluye_guia && "🎤 Guía", t.incluye_peajes && "🛣️ Peajes", t.incluye_alimentacion && "🍽️ Alim."].filter(Boolean).join(" · ");
                  return (
                    <tr key={t.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-bold">
                        <span className="text-[#0b315f] font-mono">{t.origen}</span>
                        <span className="text-gray-300 mx-1">→</span>
                        <span className="text-gray-700">{t.destino}</span>
                      </td>
                      <td className="p-3"><span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: serv.bg, color: serv.color }}>{serv.icon} {serv.label}</span></td>
                      <td className="p-3 text-xs"><div className="font-bold text-gray-700">{veh?.icon} {t.capacidad_custom || veh?.label || t.tipo_vehiculo}</div></td>
                      <td className="p-3"><span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: equip.bg, color: equip.color }}>{equip.icon} {equip.label}</span></td>
                      <td className="p-3 font-black font-mono">{t.confidencial ? <span className="text-purple-700">🔒 Conf.</span> : fmtPrecio(t.precio, t.moneda)}</td>
                      <td className="p-3 text-xs text-gray-500">{incluye || "—"}</td>
                      <td className="p-3 text-xs text-gray-400 max-w-[150px]"><div className="truncate">{t.notas || "—"}</div></td>
                      <td className="p-3">
                        <div className="flex gap-1.5">
                          <button onClick={() => editar(t)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => eliminar(t.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {listaFiltrada.length === 0 && (
                  <tr><td colSpan={8} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">🗺️</p><p>Sin tarifas</p></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── VISTA HISTORIAL COTIZACIONES ── */}
      {vista === "historial" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b" style={{ borderColor: "#f1f5f9" }}>
            <h2 className="text-sm font-bold text-gray-700">Cotizaciones aprobadas/enviadas como referencia de precios</h2>
            <p className="text-xs text-gray-400 mt-0.5">Estas cotizaciones aparecen en la matriz como 📋 referencia. Clic en una celda para fijar como tarifa oficial.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["N° Cot.", "Ruta", "Vehículo", "Tipo servicio", "Precio (con IGV)", "Precio (sin IGV)", "Estado", "Fecha serv."].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cotRefs.filter(c => { if (!busqueda.trim()) return true; const q = norm(busqueda); return norm(c.origen || "").includes(q) || norm(c.destino || "").includes(q); }).map(c => {
                  const veh = TIPOS_VEHICULO.find(v => v.id === c.tipo_vehiculo);
                  const serv = c.tipo_servicio ? TIPOS_SERVICIO[c.tipo_servicio as Servicio] : null;
                  const pSinIgv = Math.round(Number(c.precio_cliente) / 1.18 * 100) / 100;
                  return (
                    <tr key={c.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-mono font-black text-[#0b315f] text-xs">#{c.numero_cotizacion || c.id}</td>
                      <td className="p-3 font-bold"><span className="text-[#0b315f]">{c.origen}</span><span className="text-gray-300 mx-1">→</span><span className="text-gray-700">{c.destino}</span></td>
                      <td className="p-3 text-xs text-gray-600">{veh ? `${veh.icon} ${veh.label}` : c.tipo_vehiculo || "—"}</td>
                      <td className="p-3">{serv ? <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: serv.bg, color: serv.color }}>{serv.icon} {serv.label}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="p-3 font-bold text-gray-800 font-mono">S/ {Number(c.precio_cliente).toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td>
                      <td className="p-3 font-bold text-amber-700 font-mono">S/ {pSinIgv.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td>
                      <td className="p-3"><span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: c.estado === "aprobado" ? "#dcfce7" : "#e0f2fe", color: c.estado === "aprobado" ? "#166534" : "#0369a1" }}>{c.estado}</span></td>
                      <td className="p-3 text-xs text-gray-500">{c.fecha_servicio ? new Date(c.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE") : "—"}</td>
                    </tr>
                  );
                })}
                {cotRefs.length === 0 && (
                  <tr><td colSpan={8} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📋</p><p>No hay cotizaciones aprobadas o enviadas aún</p>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}