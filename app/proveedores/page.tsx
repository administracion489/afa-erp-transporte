"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Proveedor = {
  id: number; nombre: string; ruc: string | null;
  telefono: string | null; email: string | null;
  direccion: string | null; tipo: string;
  contacto_nombre: string | null; contacto_telefono: string | null;
  estado: string; observaciones: string | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const TIPOS_PROVEEDOR: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  taller:          { label: "Taller mecánico",    icon: "🔧", color: "#854d0e", bg: "#fef9c3" },
  grifo:           { label: "Grifo / combustible", icon: "⛽", color: "#ea580c", bg: "#fff7ed" },
  repuestos:       { label: "Repuestos",           icon: "⚙️", color: "#4b5563", bg: "#f3f4f6" },
  concesionario:   { label: "Concesionario / venta vehículos", icon: "🚍", color: "#1e40af", bg: "#dbeafe" },
  leasing:         { label: "Leasing / financiera", icon: "🏦", color: "#9a3412", bg: "#ffedd5" },
  seguros:         { label: "Seguros / broker",    icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe" },
  neumaticos:      { label: "Neumáticos",          icon: "🛞", color: "#0f766e", bg: "#f0fdfa" },
  lavadero:        { label: "Lavadero",            icon: "🚿", color: "#0284c7", bg: "#e0f2fe" },
  vulcanizadora:   { label: "Vulcanizadora",       icon: "🔩", color: "#7c3aed", bg: "#ede9fe" },
  electricista:    { label: "Electricista",        icon: "⚡", color: "#d97706", bg: "#fef3c7" },
  administrativo:  { label: "Administrativo",      icon: "📋", color: "#166534", bg: "#dcfce7" },
  otro:            { label: "Otro",                icon: "🏢", color: "#6b7280", bg: "#f9fafb" },
};

const FORM_VACIO = {
  nombre: "", ruc: "", telefono: "", email: "",
  direccion: "", tipo: "taller", contacto_nombre: "",
  contacto_telefono: "", estado: "activo", observaciones: "",
};

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

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ProveedoresPage() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarDatos = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("proveedores").select("*")
      // Excluir tipo transporte — esos van a Empresas Tercerizadas
      .neq("tipo", "transporte")
      .order("nombre");
    if (error) alert(error.message);
    else setProveedores(data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    setGuardando(true);
    const payload = {
      nombre: form.nombre.trim(), ruc: form.ruc.trim() || null,
      telefono: form.telefono.trim() || null, email: form.email.trim() || null,
      direccion: form.direccion.trim() || null, tipo: form.tipo,
      contacto_nombre: form.contacto_nombre.trim() || null,
      contacto_telefono: form.contacto_telefono.trim() || null,
      estado: form.estado, observaciones: form.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("proveedores").update(payload).eq("id", editandoId)
      : await supabase.from("proveedores").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (p: Proveedor) => {
    setForm({
      nombre: p.nombre || "", ruc: p.ruc || "",
      telefono: p.telefono || "", email: p.email || "",
      direccion: p.direccion || "", tipo: p.tipo || "taller",
      contacto_nombre: p.contacto_nombre || "",
      contacto_telefono: p.contacto_telefono || "",
      estado: p.estado || "activo", observaciones: p.observaciones || "",
    });
    setEditandoId(p.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar proveedor "${nombre}"?`)) return;
    await supabase.from("proveedores").delete().eq("id", id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const activos    = proveedores.filter(p => p.estado === "activo").length;
  const inactivos  = proveedores.filter(p => p.estado === "inactivo").length;
  const bloqueados = proveedores.filter(p => p.estado === "bloqueado").length;

  const kpisTipo = Object.entries(TIPOS_PROVEEDOR).map(([k, v]) => ({
    tipo: k, cfg: v, count: proveedores.filter(p => p.tipo === k).length,
  })).filter(d => d.count > 0);

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => proveedores.filter(p => {
    const q   = busqueda.toLowerCase();
    const txt = `${p.nombre} ${p.ruc || ""} ${p.email || ""} ${p.contacto_nombre || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroTipo === "todos" || p.tipo   === filtroTipo) &&
      (filtroEst  === "todos" || p.estado === filtroEst);
  }), [proveedores, busqueda, filtroTipo, filtroEst]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Proveedores</h1>
          <p className="text-gray-400 text-sm mt-1">
            Talleres · grifos · repuestos · seguros · servicios externos
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo proveedor"}
        </button>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total",      valor: proveedores.length, color: "#0b315f", bg: "#eef3f8" },
          { label: "Activos",    valor: activos,            color: "#166534", bg: "#dcfce7" },
          { label: "Inactivos",  valor: inactivos,          color: "#4b5563", bg: "#f3f4f6" },
          { label: "Bloqueados", valor: bloqueados,         color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs por tipo */}
      {kpisTipo.length > 0 && (
        <section className="flex gap-2 flex-wrap">
          {kpisTipo.map(({ tipo, cfg, count }) => (
            <button key={tipo} onClick={() => setFiltroTipo(filtroTipo === tipo ? "todos" : tipo)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all text-sm font-bold"
              style={{ background: filtroTipo === tipo ? cfg.bg : "white", borderColor: filtroTipo === tipo ? cfg.color : "#e5e7eb", color: filtroTipo === tipo ? cfg.color : "#6b7280" }}>
              <span>{cfg.icon}</span>
              <span>{cfg.label}</span>
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.color }}>{count}</span>
            </button>
          ))}
        </section>
      )}

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
              style={{ background: TIPOS_PROVEEDOR[form.tipo]?.bg || "#f3f4f6" }}>
              {TIPOS_PROVEEDOR[form.tipo]?.icon || "🏢"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar proveedor" : "Nuevo proveedor"}</h2>
              <p className="text-xs text-gray-400">{TIPOS_PROVEEDOR[form.tipo]?.label || "Proveedor externo"}</p>
            </div>
          </div>

          {/* Selector de tipo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de proveedor</p>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
              {Object.entries(TIPOS_PROVEEDOR).map(([k, v]) => {
                const act = form.tipo === k;
                return (
                  <button key={k} onClick={() => setForm(p => ({ ...p, tipo: k }))}
                    className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 transition-all text-center"
                    style={{ background: act ? v.bg : "white", borderColor: act ? v.color : "#e5e7eb", color: act ? v.color : "#9ca3af" }}>
                    <span className="text-lg">{v.icon}</span>
                    <span className="text-[9px] font-bold leading-tight">{v.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del proveedor</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Nombre / Razón social *" span={2}>
                <input className={inputCls()} placeholder="Ej: Taller El Motor SAC" value={form.nombre} onChange={f("nombre")} />
              </Campo>
              <Campo label="RUC">
                <input className={inputCls("font-mono")} placeholder="20123456789" maxLength={11} value={form.ruc} onChange={f("ruc")} />
              </Campo>
              <Campo label="Teléfono">
                <input className={inputCls()} placeholder="999 999 999" value={form.telefono} onChange={f("telefono")} />
              </Campo>
              <Campo label="Email">
                <input type="email" className={inputCls()} placeholder="correo@proveedor.com" value={form.email} onChange={f("email")} />
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="activo">Activo</option>
                  <option value="inactivo">Inactivo</option>
                  <option value="bloqueado">Bloqueado</option>
                </select>
              </Campo>
              <Campo label="Dirección" span={3}>
                <input className={inputCls()} placeholder="Av. Lima 123, Lima" value={form.direccion} onChange={f("direccion")} />
              </Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Contacto</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Nombre del contacto">
                <input className={inputCls()} placeholder="Persona de contacto" value={form.contacto_nombre} onChange={f("contacto_nombre")} />
              </Campo>
              <Campo label="Teléfono del contacto">
                <input className={inputCls()} placeholder="999 999 999" value={form.contacto_telefono} onChange={f("contacto_telefono")} />
              </Campo>
              <Campo label="Observaciones">
                <input className={inputCls()} placeholder="Notas internas..." value={form.observaciones} onChange={f("observaciones")} />
              </Campo>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar proveedor"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por nombre, RUC, contacto..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          {Object.entries(TIPOS_PROVEEDOR).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="activo">Activos</option>
          <option value="inactivo">Inactivos</option>
          <option value="bloqueado">Bloqueados</option>
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
                {["Proveedor", "Tipo", "RUC", "Teléfono", "Email", "Contacto", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🏢</p><p className="font-medium">No hay proveedores</p>
                </td></tr>
              ) : filtrados.map(p => {
                const tipoCfg  = TIPOS_PROVEEDOR[p.tipo] || TIPOS_PROVEEDOR.otro;
                const expandido= expandidoId === p.id;
                const estCfg   = p.estado === "activo" ? { bg: "#dcfce7", color: "#166534" }
                  : p.estado === "bloqueado" ? { bg: "#fee2e2", color: "#991b1b" }
                  : { bg: "#f3f4f6", color: "#4b5563" };

                return (
                  <React.Fragment key={p.id}>
                    <tr className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : p.id)}>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                      <td className="p-3 font-bold text-gray-900">{p.nombre}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                          style={{ background: tipoCfg.bg, color: tipoCfg.color }}>
                          {tipoCfg.icon} {tipoCfg.label}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-xs text-gray-500">{p.ruc || "—"}</td>
                      <td className="p-3 text-xs text-gray-500">{p.telefono || "—"}</td>
                      <td className="p-3 text-xs text-gray-500 max-w-[130px]"><div className="truncate">{p.email || "—"}</div></td>
                      <td className="p-3 text-xs text-gray-600">
                        {p.contacto_nombre || "—"}
                        {p.contacto_telefono && <div className="text-gray-400 text-[10px]">{p.contacto_telefono}</div>}
                      </td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                          style={{ background: estCfg.bg, color: estCfg.color }}>
                          {p.estado.charAt(0).toUpperCase() + p.estado.slice(1)}
                        </span>
                      </td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5">
                          <button onClick={() => editar(p)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => eliminar(p.id, p.nombre)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>

                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={9} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Empresa</p>
                              <p><span className="text-gray-400">Nombre:</span> <b>{p.nombre}</b></p>
                              <p><span className="text-gray-400">RUC:</span> <span className="font-mono">{p.ruc || "—"}</span></p>
                              <p><span className="text-gray-400">Tipo:</span> {tipoCfg.icon} {tipoCfg.label}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Contacto</p>
                              <p><span className="text-gray-400">Nombre:</span> {p.contacto_nombre || "—"}</p>
                              <p><span className="text-gray-400">Tel:</span> {p.contacto_telefono || "—"}</p>
                              <p><span className="text-gray-400">Email:</span> {p.email || "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Dirección</p>
                              <p className="text-gray-600">{p.direccion || "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Notas</p>
                              {p.observaciones ? <p className="italic text-gray-500">"{p.observaciones}"</p> : <p className="text-gray-300">Sin observaciones</p>}
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
            <span>{filtrados.length} de {proveedores.length} proveedores</span>
            <span>AFA ERP · Proveedores</span>
          </div>
        )}
      </section>
    </main>
  );
}