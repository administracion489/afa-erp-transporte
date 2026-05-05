"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type TipoCliente  = "b2b" | "b2c";
type EstadoCliente = "activo" | "inactivo" | "bloqueado";

type Cliente = {
  id: number; nombre: string; tipo: TipoCliente;
  empresa?: string; ruc?: string; dni?: string;
  telefono?: string; email?: string; estado: EstadoCliente;
  direccion?: string; ciudad?: string; notas?: string;
  operativo_nombre?: string; operativo_celular?: string; operativo_email?: string;
  administrativo_nombre?: string; administrativo_celular?: string; administrativo_email?: string;
  created_at?: string;
};

const ESTADO_CONFIG: Record<EstadoCliente, { label: string; bg: string; color: string }> = {
  activo:    { label: "Activo",    bg: "#dcfce7", color: "#166534" },
  inactivo:  { label: "Inactivo",  bg: "#f3f4f6", color: "#4b5563" },
  bloqueado: { label: "Bloqueado", bg: "#fee2e2", color: "#991b1b" },
};

const FORM_VACIO = {
  nombre: "", tipo: "b2b" as TipoCliente, empresa: "", ruc: "", dni: "",
  telefono: "", email: "", estado: "activo" as EstadoCliente,
  direccion: "", ciudad: "", notas: "",
  operativo_nombre: "", operativo_celular: "", operativo_email: "",
  administrativo_nombre: "", administrativo_celular: "", administrativo_email: "",
};

const iniciales = (n: string) => n.split(" ").slice(0, 2).map(p => p[0]).join("").toUpperCase();
const avatarColor = (n: string) => {
  const cols = ["#0b315f","#1262bd","#0f6e56","#854F0B","#6b21a8","#b91c1c","#0369a1"];
  return cols[n.charCodeAt(0) % cols.length];
};

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={`space-y-1 ${span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}`}>
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30 focus:border-[#0b315f] transition-all";

export default function ClientesPage() {
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo,   setFiltroTipo]   = useState("todos");
  const [form,         setForm]         = useState(FORM_VACIO);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);

  const cargarClientes = async () => {
    setLoading(true);
    const { data, error } = await supabase.from("clientes").select("*").order("nombre").limit(1000);
    if (error) alert(error.message);
    else setClientes((data || []) as Cliente[]);
    setLoading(false);
  };

  useEffect(() => { cargarClientes(); }, []);

  const f = (key: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }));

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const abrirNuevo = () => {
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const editarCliente = (c: Cliente) => {
    setForm({
      nombre: c.nombre || "", tipo: c.tipo || "b2b", empresa: c.empresa || "",
      ruc: c.ruc || "", dni: c.dni || "", telefono: c.telefono || "",
      email: c.email || "", estado: c.estado || "activo",
      direccion: c.direccion || "", ciudad: c.ciudad || "", notas: c.notas || "",
      operativo_nombre: c.operativo_nombre || "", operativo_celular: c.operativo_celular || "",
      operativo_email: c.operativo_email || "", administrativo_nombre: c.administrativo_nombre || "",
      administrativo_celular: c.administrativo_celular || "", administrativo_email: c.administrativo_email || "",
    });
    setEditandoId(c.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardarCliente = async () => {
    if (!form.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    if (form.tipo === "b2b" && !form.empresa?.trim()) { alert("Para B2B, la razón social es obligatoria"); return; }
    setGuardando(true);
    const payload: Partial<Cliente> = {
      nombre: form.nombre.trim(), tipo: form.tipo, estado: form.estado,
      telefono: form.telefono.trim() || undefined, email: form.email.trim() || undefined,
      direccion: form.direccion.trim() || undefined, ciudad: form.ciudad.trim() || undefined,
      notas: form.notas.trim() || undefined,
      empresa: form.tipo === "b2b" ? form.empresa.trim() || undefined : undefined,
      ruc:     form.tipo === "b2b" ? form.ruc.trim()     || undefined : undefined,
      dni:     form.tipo === "b2c" ? form.dni.trim()     || undefined : undefined,
      operativo_nombre:       form.tipo === "b2b" ? form.operativo_nombre.trim()       || undefined : undefined,
      operativo_celular:      form.tipo === "b2b" ? form.operativo_celular.trim()      || undefined : undefined,
      operativo_email:        form.tipo === "b2b" ? form.operativo_email.trim()        || undefined : undefined,
      administrativo_nombre:  form.tipo === "b2b" ? form.administrativo_nombre.trim()  || undefined : undefined,
      administrativo_celular: form.tipo === "b2b" ? form.administrativo_celular.trim() || undefined : undefined,
      administrativo_email:   form.tipo === "b2b" ? form.administrativo_email.trim()   || undefined : undefined,
    };
    const { error } = editandoId
      ? await supabase.from("clientes").update(payload).eq("id", editandoId)
      : await supabase.from("clientes").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarClientes(); setGuardando(false);
  };

  const cambiarEstado = async (id: number, estado: EstadoCliente) => {
    await supabase.from("clientes").update({ estado }).eq("id", id);
    setClientes(prev => prev.map(c => c.id === id ? { ...c, estado } : c));
  };

  const eliminarCliente = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar "${nombre}"?`)) return;
    const { error } = await supabase.from("clientes").delete().eq("id", id);
    if (error) return alert(error.message);
    cargarClientes();
  };

  const total      = clientes.length;
  const b2b        = clientes.filter(c => c.tipo === "b2b").length;
  const b2c        = clientes.filter(c => c.tipo === "b2c").length;
  const activos    = clientes.filter(c => c.estado === "activo").length;
  const bloqueados = clientes.filter(c => c.estado === "bloqueado").length;

  const filtrados = clientes.filter(c => {
    const q = busqueda.toLowerCase();
    const coincide = c.nombre.toLowerCase().includes(q) ||
      (c.empresa || "").toLowerCase().includes(q) ||
      (c.ruc || "").includes(q) || (c.dni || "").includes(q);
    return coincide &&
      (filtroEstado === "todos" || c.estado === filtroEstado) &&
      (filtroTipo   === "todos" || c.tipo   === filtroTipo);
  });

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Clientes</h1>
          <p className="text-gray-400 mt-1 text-sm">Base comercial AFA Transportes · B2B y B2C</p>
        </div>
        <button onClick={mostrarForm ? limpiar : abrirNuevo}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo cliente"}
        </button>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Total",      valor: total,      color: "#0b315f", bg: "#eef3f8" },
          { label: "B2B",        valor: b2b,        color: "#1262bd", bg: "#eff6ff" },
          { label: "B2C",        valor: b2c,        color: "#0f6e56", bg: "#f0fdf4" },
          { label: "Activos",    valor: activos,    color: "#166534", bg: "#dcfce7" },
          { label: "Bloqueados", valor: bloqueados, color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-xs font-medium" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-3xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: "#0b315f" }}>
              {editandoId ? "✏️" : "+"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar cliente" : "Nuevo cliente"}</h2>
              <p className="text-xs text-gray-400">Los campos con * son obligatorios</p>
            </div>
          </div>

          {/* B2B / B2C */}
          <div className="flex gap-3">
            {(["b2b", "b2c"] as TipoCliente[]).map(t => (
              <button key={t} onClick={() => setForm(prev => ({ ...prev, tipo: t }))}
                className="flex-1 py-3 rounded-xl font-bold text-sm border-2 transition-all"
                style={{ borderColor: form.tipo === t ? "#0b315f" : "#e5e7eb", background: form.tipo === t ? "#0b315f" : "white", color: form.tipo === t ? "white" : "#6b7280" }}>
                {t === "b2b" ? "🏢 B2B — Empresa" : "👤 B2C — Persona natural"}
              </button>
            ))}
          </div>

          {/* Datos principales */}
          <div className="space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1">Datos principales</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {form.tipo === "b2b" ? (
                <>
                  <Campo label="Razón social *" span={2}><input className={inputCls} placeholder="Ej: GLOBAL BUS S.A.C." value={form.empresa} onChange={f("empresa")} /></Campo>
                  <Campo label="RUC"><input className={inputCls} placeholder="20XXXXXXXXX" maxLength={11} value={form.ruc} onChange={f("ruc")} /></Campo>
                  <Campo label="Nombre de contacto *" span={2}><input className={inputCls} placeholder="Nombre completo" value={form.nombre} onChange={f("nombre")} /></Campo>
                  <Campo label="Estado"><select className={inputCls} value={form.estado} onChange={f("estado")}><option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="bloqueado">Bloqueado</option></select></Campo>
                  <Campo label="Teléfono"><input className={inputCls} value={form.telefono} onChange={f("telefono")} /></Campo>
                  <Campo label="Email" span={2}><input type="email" className={inputCls} value={form.email} onChange={f("email")} /></Campo>
                </>
              ) : (
                <>
                  <Campo label="Nombre completo *" span={2}><input className={inputCls} value={form.nombre} onChange={f("nombre")} /></Campo>
                  <Campo label="DNI"><input className={inputCls} maxLength={8} value={form.dni} onChange={f("dni")} /></Campo>
                  <Campo label="Teléfono"><input className={inputCls} value={form.telefono} onChange={f("telefono")} /></Campo>
                  <Campo label="Email" span={2}><input type="email" className={inputCls} value={form.email} onChange={f("email")} /></Campo>
                  <Campo label="Estado"><select className={inputCls} value={form.estado} onChange={f("estado")}><option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="bloqueado">Bloqueado</option></select></Campo>
                </>
              )}
            </div>
          </div>

          {/* Contactos B2B */}
          {form.tipo === "b2b" && (
            <>
              <div className="space-y-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1">Contacto operativo</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Nombre"><input className={inputCls} value={form.operativo_nombre} onChange={f("operativo_nombre")} /></Campo>
                  <Campo label="Celular"><input className={inputCls} value={form.operativo_celular} onChange={f("operativo_celular")} /></Campo>
                  <Campo label="Email"><input type="email" className={inputCls} value={form.operativo_email} onChange={f("operativo_email")} /></Campo>
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1">Contacto administrativo</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Nombre"><input className={inputCls} value={form.administrativo_nombre} onChange={f("administrativo_nombre")} /></Campo>
                  <Campo label="Celular"><input className={inputCls} value={form.administrativo_celular} onChange={f("administrativo_celular")} /></Campo>
                  <Campo label="Email"><input type="email" className={inputCls} value={form.administrativo_email} onChange={f("administrativo_email")} /></Campo>
                </div>
              </div>
            </>
          )}

          {/* Ubicación */}
          <div className="space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1">Ubicación y notas</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Dirección" span={2}><input className={inputCls} value={form.direccion} onChange={f("direccion")} /></Campo>
              <Campo label="Ciudad"><input className={inputCls} value={form.ciudad} onChange={f("ciudad")} /></Campo>
              <Campo label="Notas internas" span={3}>
                <textarea className={inputCls + " resize-none"} rows={2} value={form.notas} onChange={f("notas")} />
              </Campo>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={guardarCliente} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar cliente" : "Guardar cliente"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por nombre, empresa, RUC o DNI..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[140px]" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          <option value="b2b">B2B — Empresa</option>
          <option value="b2c">B2C — Persona</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[150px]" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
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
                <th className="p-4 w-8"></th>
                {["Cliente", "Tipo", "Identificación", "Contacto", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando clientes...
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={7} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">👥</p>
                  <p className="font-medium">No se encontraron clientes</p>
                  <p className="text-xs mt-1">{busqueda || filtroEstado !== "todos" || filtroTipo !== "todos" ? "Prueba con otros filtros" : "Agrega el primer cliente"}</p>
                </td></tr>
              ) : (
                filtrados.map(c => {
                  const est = ESTADO_CONFIG[c.estado] || ESTADO_CONFIG.inactivo;
                  const expandido = expandidoId === c.id;
                  const nombreMostrado = c.tipo === "b2b" ? (c.empresa || c.nombre) : c.nombre;
                  return (
                    // ✅ KEY en el Fragment, no en el <tr>
                    <React.Fragment key={c.id}>
                      <tr className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }}
                        onClick={() => setExpandidoId(expandido ? null : c.id)}>
                        <td className="p-4 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-black flex-shrink-0"
                              style={{ background: avatarColor(nombreMostrado) }}>
                              {iniciales(nombreMostrado)}
                            </div>
                            <div>
                              <p className="font-bold text-gray-900">{nombreMostrado}</p>
                              {c.tipo === "b2b" && c.nombre !== c.empresa && (
                                <p className="text-xs text-gray-400">{c.nombre}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                            style={c.tipo === "b2b" ? { background: "#eff6ff", color: "#1d4ed8" } : { background: "#f0fdf4", color: "#166534" }}>
                            {c.tipo === "b2b" ? "🏢 B2B" : "👤 B2C"}
                          </span>
                        </td>
                        <td className="p-4 font-mono text-xs text-gray-500">
                          {c.tipo === "b2b" ? (c.ruc ? `RUC: ${c.ruc}` : "—") : (c.dni ? `DNI: ${c.dni}` : "—")}
                        </td>
                        <td className="p-4 text-gray-600 text-xs">
                          <div>{c.telefono || "—"}</div>
                          {c.email && <div className="text-gray-400">{c.email}</div>}
                        </td>
                        <td className="p-4" onClick={e => e.stopPropagation()}>
                          <select value={c.estado} onChange={e => cambiarEstado(c.id, e.target.value as EstadoCliente)}
                            className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                            style={{ background: est.bg, color: est.color }}>
                            <option value="activo">Activo</option>
                            <option value="inactivo">Inactivo</option>
                            <option value="bloqueado">Bloqueado</option>
                          </select>
                        </td>
                        <td className="p-4" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => editarCliente(c)} className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">Editar</button>
                            <button onClick={() => eliminarCliente(c.id, nombreMostrado)} className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">Eliminar</button>
                          </div>
                        </td>
                      </tr>

                      {/* FILA EXPANDIDA */}
                      {expandido && (
                        <tr style={{ background: "#f8fafc", borderColor: "#f1f5f9" }} className="border-t border-b">
                          <td colSpan={7} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                              <div className="space-y-1.5">
                                <p className="font-bold text-gray-500 uppercase tracking-wide text-[10px]">Datos generales</p>
                                {c.direccion && <p className="text-gray-600">📍 {c.direccion}{c.ciudad ? `, ${c.ciudad}` : ""}</p>}
                                {c.email     && <p className="text-gray-600">✉️ {c.email}</p>}
                                {c.telefono  && <p className="text-gray-600">📞 {c.telefono}</p>}
                                {c.notas     && <p className="text-gray-400 italic mt-1">"{c.notas}"</p>}
                                {!c.direccion && !c.email && !c.telefono && !c.notas && <p className="text-gray-300">Sin información adicional</p>}
                              </div>
                              {c.tipo === "b2b" && (
                                <div className="space-y-1.5">
                                  <p className="font-bold text-[#0b315f] uppercase tracking-wide text-[10px]">Contacto operativo</p>
                                  {c.operativo_nombre  && <p className="text-gray-700 font-medium">{c.operativo_nombre}</p>}
                                  {c.operativo_celular && <p className="text-gray-600">📱 {c.operativo_celular}</p>}
                                  {c.operativo_email   && <p className="text-gray-600">✉️ {c.operativo_email}</p>}
                                  {!c.operativo_nombre && !c.operativo_celular && !c.operativo_email && <p className="text-gray-300">No registrado</p>}
                                </div>
                              )}
                              {c.tipo === "b2b" && (
                                <div className="space-y-1.5">
                                  <p className="font-bold text-[#0b315f] uppercase tracking-wide text-[10px]">Contacto administrativo</p>
                                  {c.administrativo_nombre  && <p className="text-gray-700 font-medium">{c.administrativo_nombre}</p>}
                                  {c.administrativo_celular && <p className="text-gray-600">📱 {c.administrativo_celular}</p>}
                                  {c.administrativo_email   && <p className="text-gray-600">✉️ {c.administrativo_email}</p>}
                                  {!c.administrativo_nombre && !c.administrativo_celular && !c.administrativo_email && <p className="text-gray-300">No registrado</p>}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {filtrados.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {total} clientes · {b2b} empresas · {b2c} personas</span>
            <span>AFA ERP · Base comercial</span>
          </div>
        )}
      </section>
    </main>
  );
}