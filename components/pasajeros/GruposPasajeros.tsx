"use client";

// components/pasajeros/GruposPasajeros.tsx
// =============================================================================
// AFA Transportes · Gestión de Grupos de Pasajeros
// - CRUD completo de grupos
// - Asignación de miembros (drag-free, con checkboxes)
// - Definición de parada habitual y asiento por miembro
// - Duplicar grupo
// =============================================================================

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Cliente = { id: number; nombre: string; empresa: string | null; };
type Pasajero = {
  id: number; nombre: string; dni: string | null; empresa: string | null;
  cliente_id: number | null; activo: boolean;
};
type Grupo = {
  id: number; cliente_id: number | null; nombre: string;
  descripcion: string | null; color: string; icono: string;
  activo: boolean; veces_usado: number; ultimo_uso: string | null;
  cliente_empresa: string | null; cliente_nombre: string | null;
  total_miembros: number; miembros_con_parada: number;
};
type Miembro = {
  id: number; grupo_id: number; pasajero_id: number;
  parada_habitual_nom: string | null; asiento_habitual: string | null;
  orden_lista: number; notas: string | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const COLORES = [
  { hex: "#0b315f", nombre: "Azul AFA" },
  { hex: "#16a34a", nombre: "Verde" },
  { hex: "#dc2626", nombre: "Rojo" },
  { hex: "#6d28d9", nombre: "Morado" },
  { hex: "#0891b2", nombre: "Celeste" },
  { hex: "#ea580c", nombre: "Naranja" },
  { hex: "#be185d", nombre: "Rosa" },
  { hex: "#854d0e", nombre: "Mostaza" },
];

const ICONOS = ["👥", "🚌", "🏭", "⛏️", "🎓", "🌅", "🌆", "🌙", "📅", "🎯", "⭐", "🏃"];

const FORM_GRUPO_VACIO = {
  cliente_id: "", nombre: "", descripcion: "", color: "#0b315f", icono: "👥",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}

function fmtFechaRelativa(fecha: string | null): string {
  if (!fecha) return "Nunca";
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Ayer";
  if (dias < 7) return `Hace ${dias}d`;
  if (dias < 30) return `Hace ${Math.floor(dias / 7)}sem`;
  return `Hace ${Math.floor(dias / 30)}m`;
}

// ─── COMPONENTE PRINCIPAL ────────────────────────────────────────────────────

export default function GruposPasajeros({ clientes, pasajeros, onRefresh }: {
  clientes: Cliente[];
  pasajeros: Pasajero[];
  onRefresh?: () => void;
}) {
  const [grupos,        setGrupos]        = useState<Grupo[]>([]);
  const [miembros,      setMiembros]      = useState<Record<number, Miembro[]>>({});
  const [loading,       setLoading]       = useState(false);
  const [guardando,     setGuardando]     = useState(false);
  const [grupoExpandido,setGrupoExpandido]= useState<number | null>(null);
  const [busqueda,      setBusqueda]      = useState("");
  const [filtroCliente, setFiltroCliente] = useState("todos");

  // Modal de edición
  const [mostrarForm,   setMostrarForm]   = useState(false);
  const [editandoId,    setEditandoId]    = useState<number | null>(null);
  const [form,          setForm]          = useState(FORM_GRUPO_VACIO);

  // Modal de miembros
  const [grupoMiembros, setGrupoMiembros] = useState<Grupo | null>(null);
  const [pasajerosSel,  setPasajerosSel]  = useState<number[]>([]);
  const [paradaHab,     setParadaHab]     = useState<Record<number, string>>({});
  const [asientoHab,    setAsientoHab]    = useState<Record<number, string>>({});
  const [busquedaPas,   setBusquedaPas]   = useState("");

  // ── Carga ───────────────────────────────────────────────────────────────

  const cargarGrupos = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("grupos_con_stats")
      .select("*")
      .order("ultimo_uso", { ascending: false, nullsFirst: false });
    setGrupos((data || []) as Grupo[]);
    setLoading(false);
  }, []);

  useEffect(() => { cargarGrupos(); }, [cargarGrupos]);

  const cargarMiembros = async (grupoId: number) => {
    const { data } = await supabase
      .from("grupo_pasajeros")
      .select("*")
      .eq("grupo_id", grupoId)
      .order("orden_lista");
    setMiembros(prev => ({ ...prev, [grupoId]: (data || []) as Miembro[] }));
  };

  // ── CRUD Grupos ────────────────────────────────────────────────────────

  const guardarGrupo = async () => {
    if (!form.nombre.trim()) { alert("El nombre del grupo es obligatorio"); return; }
    setGuardando(true);
    const payload = {
      cliente_id:  form.cliente_id ? Number(form.cliente_id) : null,
      nombre:      form.nombre.trim(),
      descripcion: form.descripcion.trim() || null,
      color:       form.color,
      icono:       form.icono,
    };
    const { error } = editandoId
      ? await supabase.from("grupos_pasajeros").update(payload).eq("id", editandoId)
      : await supabase.from("grupos_pasajeros").insert({ ...payload, activo: true });
    if (error) { alert(error.message); setGuardando(false); return; }
    setForm(FORM_GRUPO_VACIO); setEditandoId(null); setMostrarForm(false);
    await cargarGrupos(); setGuardando(false);
  };

  const editarGrupo = (g: Grupo) => {
    setForm({
      cliente_id:  g.cliente_id ? String(g.cliente_id) : "",
      nombre:      g.nombre,
      descripcion: g.descripcion || "",
      color:       g.color,
      icono:       g.icono,
    });
    setEditandoId(g.id); setMostrarForm(true);
  };

  const eliminarGrupo = async (g: Grupo) => {
    if (!confirm(`¿Eliminar el grupo "${g.nombre}"?\n\nSe eliminarán las ${g.total_miembros} asociaciones de miembros (los pasajeros se mantienen).`)) return;
    await supabase.from("grupos_pasajeros").delete().eq("id", g.id);
    await cargarGrupos();
  };

  const duplicarGrupo = async (g: Grupo) => {
    const nuevoNombre = prompt("Nombre del grupo duplicado:", `${g.nombre} (copia)`);
    if (!nuevoNombre?.trim()) return;
    // 1) Crear grupo nuevo
    const { data: nuevo, error } = await supabase
      .from("grupos_pasajeros")
      .insert({
        cliente_id: g.cliente_id, nombre: nuevoNombre.trim(),
        descripcion: g.descripcion, color: g.color, icono: g.icono, activo: true,
      })
      .select().single();
    if (error || !nuevo) { alert(error?.message || "Error"); return; }
    // 2) Copiar miembros
    const { data: oldMiembros } = await supabase
      .from("grupo_pasajeros").select("*").eq("grupo_id", g.id);
    if (oldMiembros && oldMiembros.length > 0) {
      await supabase.from("grupo_pasajeros").insert(
        oldMiembros.map((m: Miembro) => ({
          grupo_id: nuevo.id, pasajero_id: m.pasajero_id,
          parada_habitual_nom: m.parada_habitual_nom,
          asiento_habitual: m.asiento_habitual,
          orden_lista: m.orden_lista, notas: m.notas,
        }))
      );
    }
    await cargarGrupos();
    alert(`✅ Grupo duplicado con ${oldMiembros?.length || 0} miembros`);
  };

  const toggleActivoGrupo = async (g: Grupo) => {
    await supabase.from("grupos_pasajeros").update({ activo: !g.activo }).eq("id", g.id);
    await cargarGrupos();
  };

  // ── Gestión de miembros ────────────────────────────────────────────────

  const abrirGestorMiembros = async (g: Grupo) => {
    setGrupoMiembros(g);
    setBusquedaPas("");
    const { data } = await supabase
      .from("grupo_pasajeros").select("*").eq("grupo_id", g.id);
    const memb = (data || []) as Miembro[];
    setPasajerosSel(memb.map(m => m.pasajero_id));
    const pHab: Record<number, string> = {};
    const aHab: Record<number, string> = {};
    memb.forEach(m => {
      if (m.parada_habitual_nom) pHab[m.pasajero_id] = m.parada_habitual_nom;
      if (m.asiento_habitual)    aHab[m.pasajero_id] = m.asiento_habitual;
    });
    setParadaHab(pHab);
    setAsientoHab(aHab);
  };

  const guardarMiembros = async () => {
    if (!grupoMiembros) return;
    setGuardando(true);
    // Borrar todos los miembros actuales y reinsertar (más simple que diff)
    await supabase.from("grupo_pasajeros").delete().eq("grupo_id", grupoMiembros.id);
    if (pasajerosSel.length > 0) {
      await supabase.from("grupo_pasajeros").insert(
        pasajerosSel.map((pid, i) => ({
          grupo_id: grupoMiembros.id,
          pasajero_id: pid,
          parada_habitual_nom: paradaHab[pid] || null,
          asiento_habitual:    asientoHab[pid] || null,
          orden_lista: i,
        }))
      );
    }
    setGuardando(false);
    setGrupoMiembros(null);
    await cargarGrupos();
    onRefresh?.();
    alert(`✅ ${pasajerosSel.length} miembros guardados en "${grupoMiembros.nombre}"`);
  };

  // ── Derivados ───────────────────────────────────────────────────────────

  const filtrados = grupos.filter(g => {
    const q = busqueda.toLowerCase();
    const matchTexto = g.nombre.toLowerCase().includes(q)
                    || (g.descripcion || "").toLowerCase().includes(q)
                    || (g.cliente_empresa || "").toLowerCase().includes(q);
    const matchCli = filtroCliente === "todos"
                  || (filtroCliente === "sin" && !g.cliente_id)
                  || g.cliente_id === Number(filtroCliente);
    return matchTexto && matchCli;
  });

  const totalGrupos = grupos.length;
  const grupoMasUsado = grupos.reduce((max, g) => g.veces_usado > (max?.veces_usado || 0) ? g : max, null as Grupo | null);
  const totalMiembros = grupos.reduce((sum, g) => sum + g.total_miembros, 0);

  // Pasajeros del cliente seleccionado en el modal de miembros
  const pasajerosCliente = grupoMiembros
    ? pasajeros.filter(p => p.activo && (
        !grupoMiembros.cliente_id  // grupo sin cliente: muestra todos
        || p.cliente_id === grupoMiembros.cliente_id
      ))
    : [];

  const pasajerosFiltrados = pasajerosCliente.filter(p => {
    const q = busquedaPas.toLowerCase();
    return p.nombre.toLowerCase().includes(q) || (p.dni || "").includes(q);
  });

  // ─── RENDER ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total grupos",       valor: totalGrupos,                color: "#0b315f", bg: "#eef3f8" },
          { label: "Pasajeros en grupos",valor: totalMiembros,              color: "#166534", bg: "#dcfce7" },
          { label: "Más usado",          valor: grupoMasUsado?.veces_usado || 0, color: "#6d28d9", bg: "#ede9fe", sub: grupoMasUsado?.nombre || "—" },
          { label: "Activos",            valor: grupos.filter(g => g.activo).length, color: "#1d4ed8", bg: "#dbeafe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-3xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
            {(k as any).sub && <p className="text-[10px] text-gray-500 truncate mt-0.5">{(k as any).sub}</p>}
          </div>
        ))}
      </section>

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-3 flex-wrap items-start">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar grupo, descripción o cliente..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm"
          value={filtroCliente} onChange={e => setFiltroCliente(e.target.value)}>
          <option value="todos">Todos los clientes</option>
          <option value="sin">Sin cliente asignado</option>
          {clientes.map(c => <option key={c.id} value={c.id}>{c.empresa || c.nombre}</option>)}
        </select>
        <button onClick={() => { setForm(FORM_GRUPO_VACIO); setEditandoId(null); setMostrarForm(true); }}
          className="px-4 py-2.5 rounded-xl font-bold text-sm text-white"
          style={{ background: "#0b315f" }}>
          + Nuevo grupo
        </button>
      </div>

      {/* Form de grupo (modal inline) */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border-2 shadow-sm p-6 space-y-4"
          style={{ borderColor: form.color }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl text-white"
              style={{ background: form.color }}>{form.icono}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar grupo" : "Nuevo grupo"}</h2>
              <p className="text-xs text-gray-400">Define un manifiesto reutilizable para servicios fijos</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Nombre *</label>
              <input className={inputCls()} placeholder="Ej: Turno Mañana - Planta Norte"
                value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Cliente</label>
              <select className={inputCls()} value={form.cliente_id}
                onChange={e => setForm(p => ({ ...p, cliente_id: e.target.value }))}>
                <option value="">Sin cliente (universal)</option>
                {clientes.map(c => <option key={c.id} value={c.id}>{c.empresa || c.nombre}</option>)}
              </select>
            </div>
            <div className="md:col-span-3">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Descripción</label>
              <input className={inputCls()} placeholder="Ej: Operarios que entran a las 06:00 a Planta Norte"
                value={form.descripcion} onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))} />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Color identificador</label>
              <div className="flex flex-wrap gap-2">
                {COLORES.map(c => (
                  <button key={c.hex} type="button" onClick={() => setForm(p => ({ ...p, color: c.hex }))}
                    className="w-8 h-8 rounded-lg border-2 transition-all"
                    style={{ background: c.hex, borderColor: form.color === c.hex ? "#000" : "transparent", transform: form.color === c.hex ? "scale(1.15)" : "scale(1)" }}
                    title={c.nombre} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Ícono</label>
              <div className="flex flex-wrap gap-1.5">
                {ICONOS.map(ic => (
                  <button key={ic} type="button" onClick={() => setForm(p => ({ ...p, icono: ic }))}
                    className="w-9 h-9 rounded-lg border text-lg transition-all"
                    style={{ background: form.icono === ic ? form.color : "white", borderColor: form.icono === ic ? form.color : "#e5e7eb" }}>
                    {ic}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardarGrupo} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: form.color }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar grupo" : "Crear grupo"}
            </button>
            <button onClick={() => { setForm(FORM_GRUPO_VACIO); setEditandoId(null); setMostrarForm(false); }}
              className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </section>
      )}

      {/* LISTA DE GRUPOS */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-400">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-2" />
            Cargando grupos...
          </div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-5xl mb-3">📦</p>
            <p className="font-bold text-gray-700 mb-1">
              {grupos.length === 0 ? "Aún no tienes grupos" : "Sin resultados"}
            </p>
            <p className="text-gray-400 text-sm mb-4">
              {grupos.length === 0
                ? "Crea tu primer grupo para servicios fijos (turnos diarios, rutas semanales, tours)"
                : "Prueba con otra búsqueda o filtro"}
            </p>
            {grupos.length === 0 && (
              <button onClick={() => setMostrarForm(true)}
                className="px-5 py-2.5 rounded-xl font-bold text-sm text-white"
                style={{ background: "#0b315f" }}>
                + Crear primer grupo
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "#f1f5f9" }}>
            {filtrados.map(g => {
              const expandido = grupoExpandido === g.id;
              const memb = miembros[g.id] || [];
              return (
                <div key={g.id} className={!g.activo ? "opacity-50" : ""}>
                  {/* Cabecera del grupo */}
                  <div className="flex items-center gap-4 p-4 hover:bg-gray-50 cursor-pointer"
                    onClick={() => {
                      const nId = expandido ? null : g.id;
                      setGrupoExpandido(nId);
                      if (nId && !miembros[g.id]) cargarMiembros(g.id);
                    }}>
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl text-white flex-shrink-0"
                      style={{ background: g.color }}>{g.icono}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-gray-900">{g.nombre}</p>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ background: g.color + "22", color: g.color }}>
                          {g.total_miembros} {g.total_miembros === 1 ? "miembro" : "miembros"}
                        </span>
                        {g.miembros_con_parada > 0 && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                            📍 {g.miembros_con_parada} con parada habitual
                          </span>
                        )}
                        {!g.activo && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700">INACTIVO</span>}
                      </div>
                      {g.descripcion && <p className="text-xs text-gray-500 mt-0.5">{g.descripcion}</p>}
                      <div className="flex gap-3 mt-1 text-[10px] text-gray-400">
                        {g.cliente_empresa && <span>🏢 {g.cliente_empresa}</span>}
                        <span>📊 Usado {g.veces_usado}x</span>
                        <span>🕐 {fmtFechaRelativa(g.ultimo_uso)}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      <button onClick={() => abrirGestorMiembros(g)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                        style={{ background: g.color }} title="Editar miembros">
                        👥 Miembros
                      </button>
                      <button onClick={() => editarGrupo(g)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50">✏️</button>
                      <button onClick={() => duplicarGrupo(g)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50" title="Duplicar">📋</button>
                      <button onClick={() => toggleActivoGrupo(g)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50"
                        title={g.activo ? "Desactivar" : "Activar"}>
                        {g.activo ? "🟢" : "🔴"}
                      </button>
                      <button onClick={() => eliminarGrupo(g)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                    </div>
                    <span className="text-gray-300 text-sm flex-shrink-0">{expandido ? "▼" : "▶"}</span>
                  </div>

                  {/* Lista de miembros expandida */}
                  {expandido && (
                    <div className="px-4 pb-4" style={{ background: "#f8fafc" }}>
                      {memb.length === 0 ? (
                        <div className="py-6 text-center text-xs text-gray-400 border-2 border-dashed rounded-xl">
                          <p className="mb-2">Sin miembros. Haz clic en <b>👥 Miembros</b> para agregar.</p>
                          <button onClick={() => abrirGestorMiembros(g)}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                            style={{ background: g.color }}>
                            + Agregar miembros
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2">
                          {memb.map((m, i) => {
                            const p = pasajeros.find(pas => pas.id === m.pasajero_id);
                            if (!p) return null;
                            return (
                              <div key={m.id} className="bg-white rounded-xl border px-3 py-2 flex items-center gap-2.5 text-xs"
                                style={{ borderColor: "#e2e8f0" }}>
                                <span className="text-gray-300 font-mono text-[10px] w-6">{i + 1}.</span>
                                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-black text-[11px] flex-shrink-0"
                                  style={{ background: g.color }}>{p.nombre.charAt(0)}</div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-bold text-gray-800 truncate">{p.nombre}</p>
                                  <div className="flex gap-2 text-[10px] text-gray-400">
                                    {p.dni && <span>DNI {p.dni}</span>}
                                    {m.parada_habitual_nom && <span className="text-green-600 font-bold">📍 {m.parada_habitual_nom}</span>}
                                    {m.asiento_habitual && <span className="text-blue-600 font-bold">💺 {m.asiento_habitual}</span>}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* MODAL DE GESTIÓN DE MIEMBROS */}
      {grupoMiembros && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.55)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b flex items-start justify-between gap-4" style={{ borderColor: "#e2e8f0" }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl text-white"
                  style={{ background: grupoMiembros.color }}>{grupoMiembros.icono}</div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Miembros · {grupoMiembros.nombre}</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {grupoMiembros.cliente_empresa
                      ? `Cliente: ${grupoMiembros.cliente_empresa} · ${pasajerosCliente.length} pasajeros disponibles`
                      : `Sin cliente · ${pasajerosCliente.length} pasajeros disponibles`}
                  </p>
                </div>
              </div>
              <button onClick={() => setGrupoMiembros(null)} className="text-2xl text-gray-300 hover:text-gray-600 leading-none">✕</button>
            </div>

            {/* Toolbar */}
            <div className="px-6 py-3 border-b flex gap-2 flex-wrap items-center" style={{ borderColor: "#f1f5f9", background: "#f8fafc" }}>
              <div className="relative flex-1 min-w-[200px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
                <input className="w-full border rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none"
                  placeholder="Buscar pasajero..." value={busquedaPas} onChange={e => setBusquedaPas(e.target.value)} />
              </div>
              <button onClick={() => setPasajerosSel(pasajerosFiltrados.map(p => p.id))}
                className="text-xs font-bold px-3 py-2 rounded-lg border hover:bg-gray-50">☑ Todos</button>
              <button onClick={() => setPasajerosSel([])}
                className="text-xs font-bold px-3 py-2 rounded-lg border hover:bg-gray-50">☐ Ninguno</button>
              <span className="text-xs font-bold text-gray-600">{pasajerosSel.length} seleccionados</span>
            </div>

            {/* Lista */}
            <div className="flex-1 overflow-y-auto px-6 py-3">
              {pasajerosFiltrados.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <p className="text-3xl mb-2">🔍</p>
                  <p className="text-sm font-bold">Sin pasajeros que coincidan</p>
                  {!grupoMiembros.cliente_id && <p className="text-xs mt-1">Este grupo no está vinculado a un cliente</p>}
                </div>
              ) : (
                <div className="space-y-2">
                  {pasajerosFiltrados.map(p => {
                    const sel = pasajerosSel.includes(p.id);
                    return (
                      <div key={p.id} className="rounded-xl border p-2.5 transition-all"
                        style={{ background: sel ? grupoMiembros.color + "11" : "white", borderColor: sel ? grupoMiembros.color : "#e2e8f0" }}>
                        <div className="flex items-center gap-3">
                          <div onClick={() => setPasajerosSel(prev => sel ? prev.filter(id => id !== p.id) : [...prev, p.id])}
                            className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 cursor-pointer"
                            style={{ background: sel ? grupoMiembros.color : "white", borderColor: sel ? grupoMiembros.color : "#d1d5db" }}>
                            {sel && <span className="text-white text-xs font-black">✓</span>}
                          </div>
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-black text-xs flex-shrink-0"
                            style={{ background: grupoMiembros.color }}>{p.nombre.charAt(0)}</div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-gray-800 text-sm truncate">{p.nombre}</p>
                            <p className="text-[10px] text-gray-400">{p.empresa || "Sin empresa"} {p.dni ? `· DNI ${p.dni}` : ""}</p>
                          </div>
                          {sel && (
                            <div className="flex gap-2 flex-shrink-0">
                              <input
                                className="border rounded-lg px-2 py-1 text-[11px] w-32"
                                placeholder="📍 Parada habitual"
                                value={paradaHab[p.id] || ""}
                                onChange={e => setParadaHab(prev => ({ ...prev, [p.id]: e.target.value }))} />
                              <input
                                className="border rounded-lg px-2 py-1 text-[11px] w-16 font-mono"
                                placeholder="💺 A1"
                                value={asientoHab[p.id] || ""}
                                onChange={e => setAsientoHab(prev => ({ ...prev, [p.id]: e.target.value }))} />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t flex items-center justify-between gap-3"
              style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
              <p className="text-[11px] text-gray-500">
                💡 Define <b>parada habitual</b> y <b>asiento</b> para que se autoasignen al aplicar el grupo a una reserva
              </p>
              <div className="flex gap-2">
                <button onClick={() => setGrupoMiembros(null)}
                  className="px-4 py-2 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
                <button onClick={guardarMiembros} disabled={guardando}
                  className="px-5 py-2 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                  style={{ background: grupoMiembros.color }}>
                  {guardando ? "Guardando..." : `✅ Guardar ${pasajerosSel.length} miembros`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}