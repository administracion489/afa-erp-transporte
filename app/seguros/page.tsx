"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Seguro = {
  id: number;
  tipo: string;
  aseguradora: string;
  numero_poliza: string | null;
  titular: string | null;
  vehiculo_id: number | null;
  proveedor_id: number | null;
  fecha_inicio: string | null;
  fecha_vencimiento: string;
  prima_total: number;
  cuota_mensual: number;
  estado: string;
  archivo_url: string | null;
  observaciones: string | null;
};

type Vehiculo  = { id: number; placa: string; categoria?: string; };
type Proveedor = { id: number; nombre: string; };

// ─── CONFIGURACIÓN DE TIPOS DE SEGURO ────────────────────────────────────────

type TipoSeguroConfig = {
  label: string; icon: string; color: string; bg: string;
  categoria: "obligatorio" | "complementario";
  descripcion: string; renovacion: string; // anual, mensual, etc.
  entidadLabel: string; // "vehículo", "empresa", "trabajador"
};

const TIPOS_SEGURO: Record<string, TipoSeguroConfig> = {
  soat: {
    label: "SOAT", icon: "🚗", color: "#dc2626", bg: "#fee2e2",
    categoria: "obligatorio",
    descripcion: "Seguro Obligatorio de Accidentes de Tránsito — por vehículo",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  cat: {
    label: "CAT", icon: "📜", color: "#b45309", bg: "#fef3c7",
    categoria: "obligatorio",
    descripcion: "Certificado Accidentes de Tránsito (alternativa SOAT provincias)",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  todo_riesgo: {
    label: "Todo Riesgo", icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe",
    categoria: "complementario",
    descripcion: "Cobertura total: robo, choque, incendio, daños a terceros",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  responsabilidad_civil: {
    label: "Resp. Civil", icon: "⚖️", color: "#7c3aed", bg: "#ede9fe",
    categoria: "complementario",
    descripcion: "Responsabilidad civil frente a terceros — por vehículo o flota",
    renovacion: "Anual", entidadLabel: "vehículo/empresa",
  },
  sctr_salud: {
    label: "SCTR Salud", icon: "🏥", color: "#0f766e", bg: "#f0fdfa",
    categoria: "obligatorio",
    descripcion: "Seguro Complementario Trabajo de Riesgo — Salud (Rimac, Pacífico, La Positiva)",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  sctr_pension: {
    label: "SCTR Pensión", icon: "💼", color: "#166534", bg: "#dcfce7",
    categoria: "obligatorio",
    descripcion: "Seguro Complementario Trabajo de Riesgo — Pensiones (ONP o AFP)",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  vida_ley: {
    label: "Vida Ley", icon: "❤️", color: "#9d174d", bg: "#fdf2f8",
    categoria: "obligatorio",
    descripcion: "Vida Ley D.L. 688 — obligatorio para trabajadores desde el 1er día",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  seguro_carga: {
    label: "Seg. Carga", icon: "📦", color: "#92400e", bg: "#fff7ed",
    categoria: "complementario",
    descripcion: "Seguro de transporte terrestre de carga y mercancías",
    renovacion: "Por servicio/anual", entidadLabel: "empresa",
  },
  patrimonio: {
    label: "Patrimonio", icon: "🏢", color: "#4b5563", bg: "#f3f4f6",
    categoria: "complementario",
    descripcion: "Seguro de bienes muebles, inmuebles, equipos e instalaciones",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  otro: {
    label: "Otro", icon: "📋", color: "#6b7280", bg: "#f9fafb",
    categoria: "complementario",
    descripcion: "Otro tipo de seguro",
    renovacion: "Variable", entidadLabel: "—",
  },
};

// ─── ASEGURADORAS PERÚ ────────────────────────────────────────────────────────

const ASEGURADORAS = [
  "Rimac Seguros", "Pacífico Seguros", "La Positiva Seguros",
  "Mapfre Perú", "Interseguro", "Protecta Security",
  "Chubb Perú", "Zurich Seguros", "BNP Paribas Cardif",
  "AFOCAT (regional)", "Otra",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function diasPara(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function calcEstado(fecha: string | null): "vigente" | "por_vencer" | "vencido" {
  const d = diasPara(fecha);
  if (d === null || d > 30) return "vigente";
  if (d <= 0) return "vencido";
  return "por_vencer";
}
function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
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
  tipo: "soat", aseguradora: "", numero_poliza: "", titular: "",
  vehiculo_id: "", proveedor_id: "", fecha_inicio: "",
  fecha_vencimiento: "", prima_total: "", cuota_mensual: "",
  archivo_url: "", observaciones: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function SegurosPage() {
  const [seguros,    setSeguros]    = useState<Seguro[]>([]);
  const [vehiculos,  setVehiculos]  = useState<Vehiculo[]>([]);
  const [proveedores,setProveedores]= useState<Proveedor[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [guardando,  setGuardando]  = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [mostrarForm,setMostrarForm]= useState(false);
  const [expandidoId,setExpandidoId]= useState<number | null>(null);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroEst,  setFiltroEst]  = useState("todos");
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [filtroCat,  setFiltroCat]  = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const tipoCfg = TIPOS_SEGURO[form.tipo] || TIPOS_SEGURO.otro;

  const cargarDatos = async () => {
    setLoading(true);
    const [sRes, vRes, pRes] = await Promise.all([
      supabase.from("seguros").select("*").order("fecha_vencimiento", { ascending: true }),
      supabase.from("vehiculos").select("id,placa,categoria").order("placa"),
      supabase.from("proveedores").select("id,nombre").order("nombre"),
    ]);
    setSeguros(sRes.data || []);
    setVehiculos(vRes.data || []);
    setProveedores(pRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreVehiculo  = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreProveedor = (id: number | null) => proveedores.find(p => p.id === id)?.nombre || "—";

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.aseguradora || !form.fecha_vencimiento) { alert("Completa aseguradora y fecha de vencimiento"); return; }
    setGuardando(true);
    const payload = {
      tipo:              form.tipo,
      aseguradora:       form.aseguradora.trim(),
      numero_poliza:     form.numero_poliza.trim()  || null,
      titular:           form.titular.trim()         || null,
      vehiculo_id:       form.vehiculo_id ? Number(form.vehiculo_id) : null,
      proveedor_id:      form.proveedor_id ? Number(form.proveedor_id) : null,
      fecha_inicio:      form.fecha_inicio           || null,
      fecha_vencimiento: form.fecha_vencimiento,
      prima_total:       Number(form.prima_total    || 0),
      cuota_mensual:     Number(form.cuota_mensual  || 0),
      estado:            calcEstado(form.fecha_vencimiento),
      archivo_url:       form.archivo_url.trim()     || null,
      observaciones:     form.observaciones.trim()   || null,
    };
    const { error } = editandoId
      ? await supabase.from("seguros").update(payload).eq("id", editandoId)
      : await supabase.from("seguros").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (s: Seguro) => {
    setForm({
      tipo:              s.tipo              || "soat",
      aseguradora:       s.aseguradora       || "",
      numero_poliza:     s.numero_poliza     || "",
      titular:           s.titular           || "",
      vehiculo_id:       s.vehiculo_id ? String(s.vehiculo_id) : "",
      proveedor_id:      s.proveedor_id ? String(s.proveedor_id) : "",
      fecha_inicio:      s.fecha_inicio      || "",
      fecha_vencimiento: s.fecha_vencimiento || "",
      prima_total:       s.prima_total ? String(s.prima_total) : "",
      cuota_mensual:     s.cuota_mensual ? String(s.cuota_mensual) : "",
      archivo_url:       s.archivo_url       || "",
      observaciones:     s.observaciones     || "",
    });
    setEditandoId(s.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este seguro?")) return;
    await supabase.from("seguros").delete().eq("id", id);
    cargarDatos();
  };

  // ── Seguros con estado calculado dinámicamente ─────────────────────────────

  const segurosCalc = useMemo(() =>
    seguros.map(s => ({ ...s, estado: calcEstado(s.fecha_vencimiento) })),
    [seguros]
  );

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const vigentes   = segurosCalc.filter(s => s.estado === "vigente").length;
  const porVencer  = segurosCalc.filter(s => s.estado === "por_vencer").length;
  const vencidos   = segurosCalc.filter(s => s.estado === "vencido").length;
  const primaTotal = segurosCalc.reduce((s, x) => s + Number(x.prima_total || 0), 0);
  const cuotaTotal = segurosCalc.reduce((s, x) => s + Number(x.cuota_mensual || 0), 0);

  const obligatorios   = segurosCalc.filter(s => TIPOS_SEGURO[s.tipo]?.categoria === "obligatorio").length;
  const complementarios= segurosCalc.filter(s => TIPOS_SEGURO[s.tipo]?.categoria === "complementario").length;

  // Próximos 60 días
  const proximosVencer = segurosCalc
    .filter(s => { const d = diasPara(s.fecha_vencimiento); return d !== null && d >= 0 && d <= 60; })
    .sort((a, b) => (diasPara(a.fecha_vencimiento) || 0) - (diasPara(b.fecha_vencimiento) || 0));

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = segurosCalc.filter(s => {
    const q   = busqueda.toLowerCase();
    const txt = `${s.aseguradora} ${s.numero_poliza || ""} ${s.titular || ""} ${s.tipo}`.toLowerCase();
    const cat = TIPOS_SEGURO[s.tipo]?.categoria || "complementario";
    return txt.includes(q) &&
      (filtroEst  === "todos" || s.estado === filtroEst) &&
      (filtroTipo === "todos" || s.tipo   === filtroTipo) &&
      (filtroCat  === "todos" || cat      === filtroCat);
  });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Seguros</h1>
          <p className="text-gray-400 text-sm mt-1">
            SOAT · SCTR · Vida Ley · Todo Riesgo · Resp. Civil · control de pólizas y vencimientos
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nueva póliza"}
        </button>
      </div>

      {/* ALERTAS CRÍTICAS */}
      {vencidos > 0 && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
          <span className="text-xl mt-0.5">🚨</span>
          <div>
            <span className="font-bold">{vencidos} seguro{vencidos > 1 ? "s" : ""} VENCIDO{vencidos > 1 ? "S" : ""} — </span>
            puede generar multas y dejar vehículos/trabajadores sin cobertura legal.
            {segurosCalc.filter(s => s.estado === "vencido" && TIPOS_SEGURO[s.tipo]?.categoria === "obligatorio").length > 0 && (
              <span className="font-black"> ¡Incluye seguros OBLIGATORIOS!</span>
            )}
          </div>
        </div>
      )}
      {porVencer > 0 && vencidos === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          ⚠️ <b>{porVencer} seguro{porVencer > 1 ? "s" : ""}</b> vence{porVencer > 1 ? "n" : ""} en los próximos 30 días — renovar con anticipación
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total pólizas",   valor: seguros.length,            color: "#0b315f", bg: "#eef3f8" },
          { label: "Vigentes",        valor: vigentes,                  color: "#166534", bg: "#dcfce7" },
          { label: "Por vencer",      valor: porVencer,                 color: "#854d0e", bg: "#fef9c3" },
          { label: "Vencidos",        valor: vencidos,                  color: "#991b1b", bg: "#fee2e2" },
          { label: "Obligatorios",    valor: obligatorios,              color: "#dc2626", bg: "#fee2e2" },
          { label: "Prima anual",     valor: fmtSoles(primaTotal),      color: "#6d28d9", bg: "#ede9fe" },
          { label: "Cuota mensual",   valor: fmtSoles(cuotaTotal),      color: "#0f766e", bg: "#f0fdfa" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-lg font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* TIMELINE — próximos 60 días */}
      {proximosVencer.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">📅 Próximos vencimientos — 60 días</h2>
          <div className="space-y-2">
            {proximosVencer.map(s => {
              const dias   = diasPara(s.fecha_vencimiento) || 0;
              const cfg    = TIPOS_SEGURO[s.tipo] || TIPOS_SEGURO.otro;
              const urgente= dias <= 7;
              const proximo= dias <= 30;
              const barW   = Math.max(0, 100 - (dias / 60) * 100);
              return (
                <div key={s.id} className="flex items-center gap-4 rounded-xl px-4 py-2.5"
                  style={{ background: urgente ? "#fee2e2" : proximo ? "#fef9c3" : "#f8fafc" }}>
                  <div className="text-xl">{cfg.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-gray-800">{cfg.label}</span>
                      <span className="text-xs text-gray-500">— {s.aseguradora}</span>
                      {s.numero_poliza && <span className="text-xs font-mono text-gray-400">{s.numero_poliza}</span>}
                      {s.vehiculo_id && <span className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-600">🚌 {nombreVehiculo(s.vehiculo_id)}</span>}
                    </div>
                    <div className="mt-1.5 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${barW}%`, background: urgente ? "#dc2626" : proximo ? "#eab308" : "#0b315f" }} />
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-black text-sm" style={{ color: urgente ? "#dc2626" : proximo ? "#854d0e" : "#0b315f" }}>
                      {dias === 0 ? "Hoy" : `${dias}d`}
                    </div>
                    <div className="text-[10px] text-gray-400">{fmtFecha(s.fecha_vencimiento)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: tipoCfg.bg }}>
              {tipoCfg.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar póliza" : "Registrar nueva póliza"}</h2>
              <p className="text-xs" style={{ color: tipoCfg.color }}>{tipoCfg.descripcion}</p>
            </div>
          </div>

          {/* Selector visual de tipo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de seguro</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {/* OBLIGATORIOS */}
              <div className="col-span-2 md:col-span-5">
                <p className="text-[10px] font-bold uppercase text-red-500 mb-1.5">🔴 Obligatorios</p>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-3">
                  {Object.entries(TIPOS_SEGURO).filter(([, v]) => v.categoria === "obligatorio").map(([k, v]) => {
                    const activo = form.tipo === k;
                    return (
                      <button key={k} onClick={() => setForm(p => ({ ...p, tipo: k }))}
                        className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 transition-all text-center"
                        style={{ background: activo ? v.bg : "white", borderColor: activo ? v.color : "#e5e7eb", color: activo ? v.color : "#9ca3af" }}>
                        <span className="text-lg">{v.icon}</span>
                        <span className="text-[10px] font-bold leading-tight">{v.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] font-bold uppercase text-blue-500 mb-1.5">🔵 Complementarios</p>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                  {Object.entries(TIPOS_SEGURO).filter(([, v]) => v.categoria === "complementario").map(([k, v]) => {
                    const activo = form.tipo === k;
                    return (
                      <button key={k} onClick={() => setForm(p => ({ ...p, tipo: k }))}
                        className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 transition-all text-center"
                        style={{ background: activo ? v.bg : "white", borderColor: activo ? v.color : "#e5e7eb", color: activo ? v.color : "#9ca3af" }}>
                        <span className="text-lg">{v.icon}</span>
                        <span className="text-[10px] font-bold leading-tight">{v.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Datos póliza */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la póliza</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Aseguradora *">
                <select className={inputCls()} value={form.aseguradora}
                  onChange={e => setForm(p => ({ ...p, aseguradora: e.target.value }))}>
                  <option value="">Seleccionar aseguradora</option>
                  {ASEGURADORAS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Campo>
              <Campo label="Número de póliza">
                <input className={inputCls("font-mono")} placeholder="Ej: POL-2024-001234" value={form.numero_poliza}
                  onChange={e => setForm(p => ({ ...p, numero_poliza: e.target.value }))} />
              </Campo>
              <Campo label="Titular / Contratante">
                <input className={inputCls()} placeholder="Ej: AFA Tours Perú SAC" value={form.titular}
                  onChange={e => setForm(p => ({ ...p, titular: e.target.value }))} />
              </Campo>

              {/* Vehículo — solo para seguros vehiculares */}
              {["soat", "cat", "todo_riesgo", "responsabilidad_civil"].includes(form.tipo) && (
                <Campo label="Vehículo asociado">
                  <select className={inputCls()} value={form.vehiculo_id}
                    onChange={e => setForm(p => ({ ...p, vehiculo_id: e.target.value }))}>
                    <option value="">Aplica a toda la flota</option>
                    {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>)}
                  </select>
                </Campo>
              )}

              <Campo label="Broker / Proveedor">
                <select className={inputCls()} value={form.proveedor_id}
                  onChange={e => setForm(p => ({ ...p, proveedor_id: e.target.value }))}>
                  <option value="">Sin broker</option>
                  {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </Campo>
            </div>
          </div>

          {/* Vigencia y costos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vigencia y costos</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha de inicio">
                <input type="date" className={inputCls()} value={form.fecha_inicio}
                  onChange={e => setForm(p => ({ ...p, fecha_inicio: e.target.value }))} />
              </Campo>
              <Campo label="Fecha de vencimiento *">
                <input type="date" className={inputCls(
                  form.fecha_vencimiento && diasPara(form.fecha_vencimiento) !== null && diasPara(form.fecha_vencimiento)! <= 0
                    ? "border-red-400 bg-red-50" : ""
                )} value={form.fecha_vencimiento}
                  onChange={e => setForm(p => ({ ...p, fecha_vencimiento: e.target.value }))} />
                {form.fecha_vencimiento && diasPara(form.fecha_vencimiento) !== null && (
                  <p className="text-[10px] mt-1 font-bold" style={{
                    color: diasPara(form.fecha_vencimiento)! <= 0 ? "#dc2626"
                      : diasPara(form.fecha_vencimiento)! <= 30 ? "#854d0e" : "#166534"
                  }}>
                    {diasPara(form.fecha_vencimiento)! <= 0 ? "⚠ Póliza vencida"
                      : `Vence en ${diasPara(form.fecha_vencimiento)} días`}
                  </p>
                )}
              </Campo>
              <Campo label="Prima total S/">
                <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.prima_total}
                  onChange={e => setForm(p => ({ ...p, prima_total: e.target.value }))} />
              </Campo>
              <Campo label="Cuota mensual S/">
                <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.cuota_mensual}
                  onChange={e => setForm(p => ({ ...p, cuota_mensual: e.target.value }))} />
              </Campo>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="URL póliza / archivo PDF">
              <input className={inputCls()} placeholder="https://... o ruta del archivo" value={form.archivo_url}
                onChange={e => setForm(p => ({ ...p, archivo_url: e.target.value }))} />
            </Campo>
            <Campo label="Observaciones">
              <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones}
                onChange={e => setForm(p => ({ ...p, observaciones: e.target.value }))} />
            </Campo>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar póliza" : "Guardar póliza"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por aseguradora, póliza, titular..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroCat} onChange={e => setFiltroCat(e.target.value)}>
          <option value="todos">Todas las categorías</option>
          <option value="obligatorio">🔴 Obligatorios</option>
          <option value="complementario">🔵 Complementarios</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          {Object.entries(TIPOS_SEGURO).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="vigente">✅ Vigentes</option>
          <option value="por_vencer">⚠️ Por vencer</option>
          <option value="vencido">🔴 Vencidos</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Tipo", "Aseguradora", "Póliza", "Vehículo", "Vigencia", "Días", "Prima", "Cuota", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🛡️</p><p className="font-medium">No hay seguros registrados</p>
                </td></tr>
              ) : filtrados.map(s => {
                const cfg      = TIPOS_SEGURO[s.tipo]  || TIPOS_SEGURO.otro;
                const dias     = diasPara(s.fecha_vencimiento);
                const expandido= expandidoId === s.id;
                const esOblig  = cfg.categoria === "obligatorio";
                const rowBg    = s.estado === "vencido" ? "#fff5f5" : s.estado === "por_vencer" ? "#fffbeb" : "white";

                const estadoBg    = s.estado === "vigente" ? "#dcfce7" : s.estado === "por_vencer" ? "#fef9c3" : "#fee2e2";
                const estadoColor = s.estado === "vigente" ? "#166534" : s.estado === "por_vencer" ? "#854d0e" : "#991b1b";
                const estadoLabel = s.estado === "vigente" ? "✅ Vigente" : s.estado === "por_vencer" ? "⚠️ Por vencer" : "🔴 Vencido";

                return (
                  <React.Fragment key={s.id}>
                    <tr className="border-t transition-colors cursor-pointer hover:brightness-95"
                      style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : s.id)}>

                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>

                      {/* Tipo */}
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-base">{cfg.icon}</span>
                          <div>
                            <div className="text-xs font-black" style={{ color: cfg.color }}>{cfg.label}</div>
                            {esOblig && <div className="text-[9px] text-red-500 font-bold uppercase">Obligatorio</div>}
                          </div>
                        </div>
                      </td>

                      {/* Aseguradora */}
                      <td className="p-3 font-bold text-gray-800 text-xs">{s.aseguradora}</td>

                      {/* Póliza */}
                      <td className="p-3 font-mono text-xs text-gray-500">{s.numero_poliza || "—"}</td>

                      {/* Vehículo */}
                      <td className="p-3 text-xs">
                        {s.vehiculo_id
                          ? <span className="font-mono font-bold text-[#0b315f] bg-blue-50 px-2 py-0.5 rounded">{nombreVehiculo(s.vehiculo_id)}</span>
                          : <span className="text-gray-400">Empresa</span>}
                      </td>

                      {/* Vigencia */}
                      <td className="p-3 text-xs text-gray-500">
                        <div>{fmtFecha(s.fecha_inicio)} →</div>
                        <div className="font-bold text-gray-700">{fmtFecha(s.fecha_vencimiento)}</div>
                      </td>

                      {/* Días */}
                      <td className="p-3">
                        {dias !== null ? (
                          <div className="text-center">
                            <div className="font-black text-sm" style={{
                              color: dias <= 0 ? "#dc2626" : dias <= 7 ? "#dc2626" : dias <= 30 ? "#d97706" : "#166534"
                            }}>
                              {dias <= 0 ? `+${Math.abs(dias)}d` : `${dias}d`}
                            </div>
                            <div className="text-[9px] text-gray-400">{dias <= 0 ? "vencido" : "restantes"}</div>
                          </div>
                        ) : "—"}
                      </td>

                      {/* Prima */}
                      <td className="p-3 font-bold text-xs text-gray-700">{fmtSoles(Number(s.prima_total || 0))}</td>

                      {/* Cuota */}
                      <td className="p-3 text-xs text-gray-500">
                        {Number(s.cuota_mensual) > 0 ? fmtSoles(Number(s.cuota_mensual)) + "/mes" : "—"}
                      </td>

                      {/* Estado */}
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-1 rounded-lg"
                          style={{ background: estadoBg, color: estadoColor }}>{estadoLabel}</span>
                      </td>

                      {/* Acciones */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          {s.archivo_url && (
                            <a href={s.archivo_url} target="_blank" rel="noopener noreferrer"
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-blue-50 text-blue-600 border-blue-100">
                              📄 PDF
                            </a>
                          )}
                          <button onClick={() => editar(s)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                            ✏️
                          </button>
                          <button onClick={() => eliminar(s.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Fila expandida */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Póliza</p>
                              <p><span className="text-gray-400">Tipo:</span> <b style={{ color: cfg.color }}>{cfg.icon} {cfg.label}</b></p>
                              <p><span className="text-gray-400">Categoría:</span> <b style={{ color: esOblig ? "#dc2626" : "#1d4ed8" }}>{esOblig ? "OBLIGATORIO" : "Complementario"}</b></p>
                              <p><span className="text-gray-400">Aseguradora:</span> <b>{s.aseguradora}</b></p>
                              <p><span className="text-gray-400">N° póliza:</span> <span className="font-mono">{s.numero_poliza || "—"}</span></p>
                              <p><span className="text-gray-400">Titular:</span> {s.titular || "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Cobertura</p>
                              <p><span className="text-gray-400">Vehículo:</span> <b>{s.vehiculo_id ? nombreVehiculo(s.vehiculo_id) : "Empresa / flota"}</b></p>
                              <p><span className="text-gray-400">Broker:</span> {s.proveedor_id ? nombreProveedor(s.proveedor_id) : "—"}</p>
                              <p className="text-gray-500 italic mt-1">"{cfg.descripcion}"</p>
                              <p className="text-gray-400">Renovación: {cfg.renovacion}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Vigencia y costos</p>
                              <p><span className="text-gray-400">Inicio:</span> {fmtFecha(s.fecha_inicio)}</p>
                              <p><span className="text-gray-400">Vencimiento:</span> <b style={{ color: dias !== null && dias <= 30 ? "#dc2626" : "#374151" }}>{fmtFecha(s.fecha_vencimiento)}</b></p>
                              <p><span className="text-gray-400">Días restantes:</span> <b style={{ color: dias !== null && dias <= 0 ? "#dc2626" : "#166534" }}>{dias !== null ? (dias <= 0 ? `Vencido hace ${Math.abs(dias)} días` : `${dias} días`) : "—"}</b></p>
                              <p><span className="text-gray-400">Prima total:</span> <b>{fmtSoles(Number(s.prima_total || 0))}</b></p>
                              <p><span className="text-gray-400">Cuota mensual:</span> {Number(s.cuota_mensual) > 0 ? fmtSoles(Number(s.cuota_mensual)) : "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Documentos</p>
                              {s.archivo_url
                                ? <a href={s.archivo_url} target="_blank" rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-blue-600 font-bold hover:underline">
                                    📄 Ver póliza / PDF
                                  </a>
                                : <p className="text-gray-300">Sin archivo adjunto</p>}
                              {s.observaciones && <p className="text-gray-500 italic mt-1">"{s.observaciones}"</p>}
                              {esOblig && dias !== null && dias <= 30 && (
                                <div className="mt-2 rounded-lg px-3 py-2 bg-red-50 text-red-700 text-[10px] font-bold">
                                  ⚠ Seguro obligatorio — renovar antes del {fmtFecha(s.fecha_vencimiento)} para evitar multas
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtrados.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {seguros.length} pólizas · Prima total: {fmtSoles(filtrados.reduce((s, x) => s + Number(x.prima_total || 0), 0))}</span>
            <span>AFA ERP · Seguros</span>
          </div>
        )}
      </section>
    </main>
  );
}