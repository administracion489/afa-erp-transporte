"use client";
import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────

type Etapa =
  | "nuevo_lead"
  | "calificando"
  | "cotizacion_enviada"
  | "negociacion"
  | "ganado"
  | "perdido";

type Pipeline = {
  id: string;
  contacto_id: string;
  etapa: Etapa;
  empresa_nombre?: string;
  n_trabajadores?: number;
  rutas_descripcion?: string;
  frecuencia?: string;
  fecha_inicio_req?: string;
  monto_estimado?: number;
  cotizacion_id?: number;
  motivo_perdida?: string;
  notas?: string;
  asignado_a?: string;
  created_at: string;
  updated_at: string;
  crm_contactos?: { id: string; nombre: string; empresa?: string; telefono?: string; canal_origen: string };
};

type Actividad = {
  id: string; tipo: string; descripcion: string; fecha: string; completado: boolean;
  realizado_por?: string;
};

// ── Config etapas ─────────────────────────────────────────────────────────

const ETAPAS: { key: Etapa; label: string; color: string; bg: string; bgCol: string; icon: string }[] = [
  { key: "nuevo_lead",         label: "Nuevo Lead",        color: "#6b7280", bg: "#f3f4f6", bgCol: "#f9fafb", icon: "✨" },
  { key: "calificando",        label: "Calificando",       color: "#0369a1", bg: "#e0f2fe", bgCol: "#f0f9ff", icon: "🔍" },
  { key: "cotizacion_enviada", label: "Cotización Enviada",color: "#92400e", bg: "#fef3c7", bgCol: "#fffbeb", icon: "📄" },
  { key: "negociacion",        label: "Negociación",       color: "#7c3aed", bg: "#ede9fe", bgCol: "#faf5ff", icon: "🤝" },
  { key: "ganado",             label: "Ganado",            color: "#166534", bg: "#dcfce7", bgCol: "#f0fdf4", icon: "🏆" },
  { key: "perdido",            label: "Perdido",           color: "#991b1b", bg: "#fee2e2", bgCol: "#fff5f5", icon: "❌" },
];

const FRECUENCIAS = ["diaria", "semanal", "mensual", "eventual", "a_convenir"];
const TIPOS_ACT = ["nota", "llamada", "reunion", "tarea", "email"];

const fmtS = (n?: number) =>
  n != null ? `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 0 })}` : "—";

const fmtF = (s?: string) =>
  s ? new Date(s + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "short" }) : "—";

const diasEn = (s: string) => {
  const diff = new Date().getTime() - new Date(s).getTime();
  return Math.floor(diff / 86400000);
};

const avatarColor = (n: string) => {
  const cols = ["#0b315f", "#1262bd", "#16a34a", "#9333ea", "#dc2626", "#d97706"];
  return cols[(n.charCodeAt(0) ?? 0) % cols.length];
};

const FORM0 = {
  empresa_nombre: "", n_trabajadores: "", rutas_descripcion: "",
  frecuencia: "diaria", fecha_inicio_req: "", monto_estimado: "",
  notas: "", etapa: "nuevo_lead" as Etapa,
  contacto_nombre: "", contacto_telefono: "", contacto_email: "",
};

// ── Component ─────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [cards, setCards] = useState<Pipeline[]>([]);
  const [selected, setSelected] = useState<Pipeline | null>(null);
  const [actividades, setActividades] = useState<Actividad[]>([]);
  const [cargando, setCargando] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ ...FORM0 });
  const [actForm, setActForm] = useState({ tipo: "nota", descripcion: "" });
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [editando, setEditando] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Pipeline>>({});

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Cargar ─────────────────────────────────────────────────────────────

  const cargar = useCallback(async () => {
    const { data } = await supabase
      .from("crm_pipeline")
      .select("*, crm_contactos(id,nombre,empresa,telefono,canal_origen)")
      .order("updated_at", { ascending: false });
    setCards(data ?? []);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const cargarActividades = useCallback(async (pipelineId: string) => {
    const { data } = await supabase
      .from("crm_actividades")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .order("fecha", { ascending: false });
    setActividades(data ?? []);
  }, []);

  useEffect(() => {
    if (selected) cargarActividades(selected.id);
  }, [selected, cargarActividades]);

  // ── Drag & drop ────────────────────────────────────────────────────────

  const onDragStart = (id: string) => setDragging(id);
  const onDrop = async (etapa: Etapa) => {
    if (!dragging) return;
    await supabase
      .from("crm_pipeline")
      .update({ etapa, updated_at: new Date().toISOString() })
      .eq("id", dragging);
    setDragging(null);
    if (selected?.id === dragging) setSelected((s) => s ? { ...s, etapa } : s);
    cargar();
  };

  // ── Crear lead ─────────────────────────────────────────────────────────

  const crearLead = async () => {
    if (!form.empresa_nombre.trim() && !form.contacto_nombre.trim()) return;

    // Crear contacto si no existe
    const { data: contacto } = await supabase
      .from("crm_contactos")
      .insert({
        nombre: form.contacto_nombre || form.empresa_nombre,
        empresa: form.empresa_nombre || null,
        telefono: form.contacto_telefono || null,
        email: form.contacto_email || null,
        canal_origen: "manual",
      })
      .select("id").single();

    if (!contacto) { showToast("Error creando contacto", false); return; }

    await supabase.from("crm_pipeline").insert({
      contacto_id: contacto.id,
      etapa: form.etapa,
      empresa_nombre: form.empresa_nombre || null,
      n_trabajadores: form.n_trabajadores ? parseInt(form.n_trabajadores) : null,
      rutas_descripcion: form.rutas_descripcion || null,
      frecuencia: form.frecuencia,
      fecha_inicio_req: form.fecha_inicio_req || null,
      monto_estimado: form.monto_estimado ? parseFloat(form.monto_estimado) : null,
      notas: form.notas || null,
    });

    setModal(false);
    setForm({ ...FORM0 });
    cargar();
    showToast("Lead creado");
  };

  // ── Guardar edición ────────────────────────────────────────────────────

  const guardarEdicion = async () => {
    if (!selected) return;
    await supabase.from("crm_pipeline")
      .update({ ...editForm, updated_at: new Date().toISOString() })
      .eq("id", selected.id);
    setSelected((s) => s ? { ...s, ...editForm } : s);
    setEditando(false);
    cargar();
    showToast("Guardado");
  };

  // ── Agregar actividad ──────────────────────────────────────────────────

  const agregarActividad = async () => {
    if (!selected || !actForm.descripcion.trim()) return;
    await supabase.from("crm_actividades").insert({
      pipeline_id: selected.id,
      contacto_id: selected.contacto_id,
      tipo: actForm.tipo,
      descripcion: actForm.descripcion,
    });
    setActForm({ tipo: "nota", descripcion: "" });
    cargarActividades(selected.id);
  };

  // ── Mover etapa ────────────────────────────────────────────────────────

  const moverEtapa = async (card: Pipeline, etapa: Etapa) => {
    await supabase.from("crm_pipeline")
      .update({ etapa, updated_at: new Date().toISOString() })
      .eq("id", card.id);
    setSelected((s) => s ? { ...s, etapa } : s);
    cargar();
    showToast(`Movido a ${ETAPAS.find((e) => e.key === etapa)?.label}`);
  };

  // ── Stats ──────────────────────────────────────────────────────────────

  const totalActivos = cards.filter((c) => !["ganado", "perdido"].includes(c.etapa));
  const totalValor = totalActivos.reduce((t, c) => t + (c.monto_estimado ?? 0), 0);
  const ganados = cards.filter((c) => c.etapa === "ganado");

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-gray-50">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white
          ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold text-[#0b315f]">Pipeline de Ventas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Transporte de personal — seguimiento de oportunidades</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden md:block">
            <div className="text-xs text-gray-400">En cartera</div>
            <div className="font-bold text-[#0b315f]">{fmtS(totalValor)}</div>
          </div>
          <div className="text-right hidden md:block">
            <div className="text-xs text-gray-400">Ganados</div>
            <div className="font-bold text-green-600">{ganados.length}</div>
          </div>
          <button
            onClick={() => setModal(true)}
            className="bg-[#0b315f] text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-[#1262bd] transition-colors"
          >
            + Nuevo lead
          </button>
          <a
            href="/crm"
            className="bg-gray-100 text-gray-600 px-4 py-2 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            ← Inbox
          </a>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Kanban ── */}
        <div className="flex-1 overflow-x-auto p-4">
          <div className="flex gap-3 h-full" style={{ minWidth: `${ETAPAS.length * 260}px` }}>
            {ETAPAS.map((etapa) => {
              const col = cards.filter((c) => c.etapa === etapa.key);
              const colValor = col.reduce((t, c) => t + (c.monto_estimado ?? 0), 0);
              return (
                <div
                  key={etapa.key}
                  className="flex flex-col rounded-2xl overflow-hidden flex-shrink-0"
                  style={{ width: 252, background: etapa.bgCol }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(etapa.key)}
                >
                  {/* Column header */}
                  <div className="px-3 py-3 flex items-center justify-between" style={{ background: etapa.bg }}>
                    <div className="flex items-center gap-1.5">
                      <span>{etapa.icon}</span>
                      <span className="text-sm font-semibold" style={{ color: etapa.color }}>{etapa.label}</span>
                      <span className="text-xs font-bold bg-white/70 px-1.5 py-0.5 rounded-full" style={{ color: etapa.color }}>
                        {col.length}
                      </span>
                    </div>
                    {colValor > 0 && (
                      <span className="text-xs font-semibold" style={{ color: etapa.color }}>
                        {fmtS(colValor)}
                      </span>
                    )}
                  </div>

                  {/* Cards */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {cargando && (
                      <div className="text-center text-xs text-gray-400 py-4">Cargando...</div>
                    )}
                    {col.map((c) => (
                      <div
                        key={c.id}
                        draggable
                        onDragStart={() => onDragStart(c.id)}
                        onClick={() => { setSelected(c); setEditando(false); setEditForm({}); }}
                        className={`bg-white rounded-xl p-3 cursor-pointer shadow-sm border hover:shadow-md transition-all
                          ${selected?.id === c.id ? "border-[#0b315f] ring-1 ring-[#0b315f]/30" : "border-gray-100"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 mt-0.5"
                            style={{ background: avatarColor(c.empresa_nombre ?? c.crm_contactos?.nombre ?? "") }}
                          >
                            {(c.empresa_nombre ?? c.crm_contactos?.nombre ?? "?")[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-gray-800 truncate">
                              {c.empresa_nombre || c.crm_contactos?.empresa || c.crm_contactos?.nombre || "Sin nombre"}
                            </div>
                            {c.crm_contactos?.nombre && c.empresa_nombre && (
                              <div className="text-xs text-gray-400 truncate">{c.crm_contactos.nombre}</div>
                            )}
                          </div>
                        </div>

                        <div className="mt-2 space-y-1">
                          {c.n_trabajadores && (
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                              <span>👥</span>
                              <span>{c.n_trabajadores.toLocaleString()} trabajadores</span>
                            </div>
                          )}
                          {c.frecuencia && (
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                              <span>🔄</span>
                              <span className="capitalize">{c.frecuencia}</span>
                            </div>
                          )}
                          {c.rutas_descripcion && (
                            <div className="text-xs text-gray-400 truncate">{c.rutas_descripcion}</div>
                          )}
                        </div>

                        <div className="mt-2.5 flex items-center justify-between">
                          {c.monto_estimado ? (
                            <span className="text-xs font-bold text-green-700">{fmtS(c.monto_estimado)}</span>
                          ) : <span />}
                          <span className="text-[10px] text-gray-400">{diasEn(c.updated_at)}d</span>
                        </div>
                      </div>
                    ))}
                    {col.length === 0 && !cargando && (
                      <div className="text-center text-xs text-gray-300 py-6">Arrastra aquí</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Panel detalle ── */}
        {selected && (
          <div className="w-80 flex-shrink-0 bg-white border-l border-gray-100 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="font-semibold text-gray-800 text-sm truncate">
                {selected.empresa_nombre || selected.crm_contactos?.empresa || selected.crm_contactos?.nombre}
              </span>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Mover etapa */}
              <div>
                <div className="text-xs text-gray-400 font-semibold mb-1.5">ETAPA</div>
                <select
                  value={selected.etapa}
                  onChange={(e) => moverEtapa(selected, e.target.value as Etapa)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  {ETAPAS.map((e) => (
                    <option key={e.key} value={e.key}>{e.icon} {e.label}</option>
                  ))}
                </select>
              </div>

              {/* Datos */}
              {!editando ? (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-xs text-gray-400 font-semibold">DETALLE</div>
                    <button
                      onClick={() => { setEditando(true); setEditForm({ ...selected }); }}
                      className="text-xs text-[#0b315f] underline"
                    >
                      Editar
                    </button>
                  </div>
                  <div className="space-y-1.5 text-sm">
                    {selected.empresa_nombre && <Row label="Empresa" value={selected.empresa_nombre} />}
                    {selected.crm_contactos?.nombre && <Row label="Contacto" value={selected.crm_contactos.nombre} />}
                    {selected.crm_contactos?.telefono && <Row label="Teléfono" value={selected.crm_contactos.telefono} />}
                    {selected.n_trabajadores && <Row label="Trabajadores" value={`${selected.n_trabajadores}`} />}
                    {selected.frecuencia && <Row label="Frecuencia" value={selected.frecuencia} />}
                    {selected.rutas_descripcion && <Row label="Rutas" value={selected.rutas_descripcion} />}
                    {selected.fecha_inicio_req && <Row label="Inicio requerido" value={fmtF(selected.fecha_inicio_req)} />}
                    {selected.monto_estimado && <Row label="Valor estimado" value={fmtS(selected.monto_estimado)} />}
                    {selected.notas && <Row label="Notas" value={selected.notas} />}
                    {selected.motivo_perdida && <Row label="Motivo perdida" value={selected.motivo_perdida} />}
                    <Row label="En pipeline" value={`${diasEn(selected.created_at)} días`} />
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-xs text-gray-400 font-semibold mb-1.5">EDITAR</div>
                  <div className="space-y-2">
                    {[
                      ["empresa_nombre", "Empresa"],
                      ["rutas_descripcion", "Rutas / descripción"],
                      ["notas", "Notas"],
                    ].map(([k, label]) => (
                      <div key={k}>
                        <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
                        <textarea
                          rows={2}
                          value={(editForm as any)[k] ?? ""}
                          onChange={(e) => setEditForm({ ...editForm, [k]: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-[#0b315f]/30"
                        />
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[10px] text-gray-400 mb-0.5">Trabajadores</div>
                        <input
                          type="number" min={0}
                          value={(editForm as any).n_trabajadores ?? ""}
                          onChange={(e) => setEditForm({ ...editForm, n_trabajadores: parseInt(e.target.value) })}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                        />
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-400 mb-0.5">Valor S/</div>
                        <input
                          type="number" min={0}
                          value={(editForm as any).monto_estimado ?? ""}
                          onChange={(e) => setEditForm({ ...editForm, monto_estimado: parseFloat(e.target.value) })}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-400 mb-0.5">Frecuencia</div>
                      <select
                        value={(editForm as any).frecuencia ?? "diaria"}
                        onChange={(e) => setEditForm({ ...editForm, frecuencia: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                      >
                        {FRECUENCIAS.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-400 mb-0.5">Fecha inicio requerida</div>
                      <input
                        type="date"
                        value={(editForm as any).fecha_inicio_req ?? ""}
                        onChange={(e) => setEditForm({ ...editForm, fecha_inicio_req: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                      />
                    </div>
                    {selected.etapa === "perdido" && (
                      <div>
                        <div className="text-[10px] text-gray-400 mb-0.5">Motivo de pérdida</div>
                        <input
                          value={(editForm as any).motivo_perdida ?? ""}
                          onChange={(e) => setEditForm({ ...editForm, motivo_perdida: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => setEditando(false)} className="flex-1 border border-gray-200 text-gray-600 py-1.5 rounded-lg text-xs">
                      Cancelar
                    </button>
                    <button onClick={guardarEdicion} className="flex-1 bg-[#0b315f] text-white py-1.5 rounded-lg text-xs font-semibold">
                      Guardar
                    </button>
                  </div>
                </div>
              )}

              {/* Link a conversación */}
              <div>
                <a
                  href="/crm"
                  className="flex items-center gap-2 text-xs text-[#0b315f] bg-[#0b315f]/5 rounded-lg px-3 py-2 hover:bg-[#0b315f]/10 transition-colors"
                >
                  <span>💬</span>
                  <span>Ver conversación en inbox</span>
                </a>
              </div>

              {/* Actividades */}
              <div>
                <div className="text-xs text-gray-400 font-semibold mb-2">ACTIVIDAD</div>

                {/* Nueva actividad */}
                <div className="bg-gray-50 rounded-xl p-3 mb-3">
                  <select
                    value={actForm.tipo}
                    onChange={(e) => setActForm({ ...actForm, tipo: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs mb-2 focus:outline-none"
                  >
                    {TIPOS_ACT.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                  <textarea
                    rows={2}
                    value={actForm.descripcion}
                    onChange={(e) => setActForm({ ...actForm, descripcion: e.target.value })}
                    placeholder="Agregar nota o actividad..."
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs resize-none focus:outline-none"
                  />
                  <button
                    onClick={agregarActividad}
                    disabled={!actForm.descripcion.trim()}
                    className="mt-2 w-full bg-[#0b315f] text-white py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                  >
                    Registrar
                  </button>
                </div>

                {/* Historial */}
                <div className="space-y-2">
                  {actividades.map((a) => (
                    <div key={a.id} className="bg-gray-50 rounded-lg px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">{a.tipo}</span>
                        <span className="text-[10px] text-gray-400">
                          {new Date(a.fecha).toLocaleDateString("es-PE", { day: "2-digit", month: "short" })}
                        </span>
                      </div>
                      <p className="text-xs text-gray-700 mt-0.5">{a.descripcion}</p>
                    </div>
                  ))}
                  {actividades.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-2">Sin actividades aún</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Modal nuevo lead ── */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-[#0b315f] mb-4">Nuevo Lead — Transporte de Personal</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-xs text-gray-500 mb-1 block">Empresa cliente *</label>
                <input
                  placeholder="Ej: Empresa Minera SAC"
                  value={form.empresa_nombre}
                  onChange={(e) => setForm({ ...form, empresa_nombre: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Nombre contacto</label>
                <input
                  placeholder="Nombre completo"
                  value={form.contacto_nombre}
                  onChange={(e) => setForm({ ...form, contacto_nombre: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Teléfono</label>
                <input
                  placeholder="51987654321"
                  value={form.contacto_telefono}
                  onChange={(e) => setForm({ ...form, contacto_telefono: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">N° trabajadores</label>
                <input
                  type="number" min={0}
                  placeholder="Ej: 250"
                  value={form.n_trabajadores}
                  onChange={(e) => setForm({ ...form, n_trabajadores: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Frecuencia</label>
                <select
                  value={form.frecuencia}
                  onChange={(e) => setForm({ ...form, frecuencia: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                >
                  {FRECUENCIAS.map((f) => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500 mb-1 block">Rutas / descripción del servicio</label>
                <textarea
                  rows={2}
                  placeholder="Ej: Recojo en San Isidro, entrega en planta Lurín"
                  value={form.rutas_descripcion}
                  onChange={(e) => setForm({ ...form, rutas_descripcion: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Fecha inicio requerida</label>
                <input
                  type="date"
                  value={form.fecha_inicio_req}
                  onChange={(e) => setForm({ ...form, fecha_inicio_req: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Valor estimado S/</label>
                <input
                  type="number" min={0}
                  placeholder="Ej: 15000"
                  value={form.monto_estimado}
                  onChange={(e) => setForm({ ...form, monto_estimado: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Etapa inicial</label>
                <select
                  value={form.etapa}
                  onChange={(e) => setForm({ ...form, etapa: e.target.value as Etapa })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                >
                  {ETAPAS.filter((e) => !["ganado", "perdido"].includes(e.key)).map((e) => (
                    <option key={e.key} value={e.key}>{e.icon} {e.label}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500 mb-1 block">Notas</label>
                <textarea
                  rows={2}
                  placeholder="Contexto adicional..."
                  value={form.notas}
                  onChange={(e) => setForm({ ...form, notas: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setModal(false)} className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50">
                Cancelar
              </button>
              <button
                onClick={crearLead}
                disabled={!form.empresa_nombre.trim() && !form.contacto_nombre.trim()}
                className="flex-1 bg-[#0b315f] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#1262bd] disabled:opacity-40"
              >
                Crear lead
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-400 text-xs w-24 flex-shrink-0">{label}</span>
      <span className="text-gray-700 text-xs flex-1">{value}</span>
    </div>
  );
}
