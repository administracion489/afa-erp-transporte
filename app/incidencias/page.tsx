"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS EXACTOS SEGÚN TU SUPABASE ───────────────────────────────────────

type Severidad = "critico" | "alto" | "medio" | "bajo";
type EstadoK   = "reportado" | "en_gestion" | "descargo_legal" | "cerrado";
type TipoInc   =
  | "accidente" | "robo" | "atropello"
  | "falla_mecanica" | "unidad_detenida" | "falta_conductor"
  | "retraso" | "desvio" | "infraccion"
  | "estetica" | "limpieza" | "climatizacion";

type Incidencia = {
  id: string;
  tipo: TipoInc;
  severidad: Severidad;
  estado: EstadoK;
  descripcion: string;
  ubicacion: string | null;
  vehiculo_id: number | null;
  conductor_id: number | null;
  usuario_registro_id: string | null;
  usuario_responsable_id: string | null;
  cliente: string | null;
  requiere_reemplazo: boolean;
  reemplazo_enviado: boolean;
  soat_activado: boolean;
  numero_siniestro: string | null;
  impacto_economico: number;
  causa_raiz: string | null;
  accion_correctiva: string | null;
  reincidente: boolean;
  puntos_descuento_conductor: number;
  tiempo_resolucion_h: number | null;
  sla_limite_h: number;
  created_at: string;
  // joins
  vehiculo?: { placa: string; marca: string | null; modelo: string | null; } | null;
  conductor?: { nombre: string; dni: string | null; } | null;
};

type Vehiculo  = { id: number; placa: string; marca: string | null; modelo: string | null; };
type Conductor = { id: number; nombre: string; dni: string | null; };
type Usuario   = { id: string; nombre: string; };

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const SEV: Record<Severidad, { label: string; color: string; bg: string }> = {
  critico: { label: "Crítico", color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  alto:    { label: "Alto",    color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  medio:   { label: "Medio",   color: "#eab308", bg: "rgba(234,179,8,0.12)"  },
  bajo:    { label: "Bajo",    color: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
};

const ESTADO_K: Record<EstadoK, { label: string; color: string }> = {
  reportado:      { label: "Reportado",        color: "#6366f1" },
  en_gestion:     { label: "En Gestión",       color: "#f97316" },
  descargo_legal: { label: "Descargo / Legal", color: "#8b5cf6" },
  cerrado:        { label: "Cerrado",          color: "#16a34a" },
};

const TIPO_LABEL: Record<TipoInc, string> = {
  accidente:      "Accidente de tránsito",
  robo:           "Robo / Asalto",
  atropello:      "Atropello",
  falla_mecanica: "Falla mecánica",
  unidad_detenida:"Unidad detenida",
  falta_conductor:"Falta de conductor",
  retraso:        "Retraso operativo",
  desvio:         "Desvío de ruta",
  infraccion:     "Infracción / Papeleta",
  estetica:       "Daño estético",
  limpieza:       "Observación de limpieza",
  climatizacion:  "Falla de climatización",
};

const KANBAN_COLS: EstadoK[] = ["reportado","en_gestion","descargo_legal","cerrado"];

function horasDesde(fecha: string) {
  return Math.round((Date.now() - new Date(fecha).getTime()) / 360000) / 10;
}
function slaColor(limite: number, h: number) {
  const p = h / limite;
  if (p >= 1)    return { color: "#ef4444", label: "Vencido"    };
  if (p >= 0.75) return { color: "#f97316", label: "Por vencer" };
  return              { color: "#16a34a", label: "En tiempo"  };
}

// ─── ICONOS ──────────────────────────────────────────────────────────────────

type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const I = {
  Table:   (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>,
  Kanban:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="3" width="5" height="11" rx="1"/><rect x="10" y="3" width="5" height="7" rx="1"/><rect x="17" y="3" width="5" height="14" rx="1"/></svg>,
  Plus:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  X:       (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Alert:   (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Search:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Clock:   (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Bus:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>,
  User:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  MapPin:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Dollar:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Shield:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Swap:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>,
  BarChart:(p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>,
  Check:   (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="20 6 9 17 4 12"/></svg>,
  Eye:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Refresh: (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  Camera:  (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
};

// ─── MODAL NUEVA INCIDENCIA ──────────────────────────────────────────────────

function ModalNueva({ vehiculos, conductores, usuarios, sesionId, onClose, onGuardado }: {
  vehiculos: Vehiculo[]; conductores: Conductor[];
  usuarios: Usuario[]; sesionId: string;
  onClose: () => void; onGuardado: () => void;
}) {
  const [guardando, setGuardando] = useState(false);
  const [error,     setError]     = useState("");
  const [busVeh,    setBusVeh]    = useState("");
  const [busCon,    setBusCon]    = useState("");
  const [form, setForm] = useState({
    tipo: "" as TipoInc | "",
    severidad: "" as Severidad | "",
    descripcion: "", ubicacion: "", cliente: "",
    vehiculo_id: "", conductor_id: "",
    usuario_responsable_id: "",
    requiere_reemplazo: false, soat_activado: false,
    impacto_economico: "", causa_raiz: "",
  });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  const vehFiltrados = vehiculos.filter(v =>
    v.placa.toLowerCase().includes(busVeh.toLowerCase()) ||
    (v.marca || "").toLowerCase().includes(busVeh.toLowerCase())
  );
  const conFiltrados = conductores.filter(c =>
    c.nombre.toLowerCase().includes(busCon.toLowerCase()) ||
    (c.dni || "").includes(busCon)
  );

  async function guardar() {
    if (!form.tipo || !form.severidad || !form.descripcion.trim()) {
      setError("Completa tipo, severidad y descripción"); return;
    }
    setGuardando(true); setError("");
    const { error: err } = await supabase.from("incidencias").insert({
      tipo:                   form.tipo,
      severidad:              form.severidad,
      descripcion:            form.descripcion.trim(),
      ubicacion:              form.ubicacion || null,
      cliente:                form.cliente || null,
      vehiculo_id:            form.vehiculo_id  ? Number(form.vehiculo_id)  : null,
      conductor_id:           form.conductor_id ? Number(form.conductor_id) : null,
      usuario_registro_id:    sesionId || null,
      usuario_responsable_id: form.usuario_responsable_id || null,
      requiere_reemplazo:     form.requiere_reemplazo,
      soat_activado:          form.soat_activado,
      impacto_economico:      form.impacto_economico ? Number(form.impacto_economico) : 0,
      causa_raiz:             form.causa_raiz || null,
    });
    setGuardando(false);
    if (err) { setError(err.message); return; }
    onGuardado(); onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
      <div className="bg-[#0f1923] border border-white/10 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
              <I.Alert size={16} color="#ef4444"/>
            </div>
            <div>
              <h3 className="font-black text-white text-base leading-none">Registrar Incidencia</h3>
              <p className="text-white/30 text-xs mt-0.5">Se guarda en Supabase · SLA asignado automáticamente</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors">
            <I.X size={14} color="rgba(255,255,255,0.5)"/>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {/* Severidad */}
          <div>
            <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Severidad *</label>
            <div className="grid grid-cols-4 gap-2">
              {(["critico","alto","medio","bajo"] as Severidad[]).map(s => {
                const c = SEV[s]; const sel = form.severidad === s;
                return (
                  <button key={s} onClick={() => set("severidad", s)}
                    className="py-2.5 rounded-xl border-2 text-xs font-black transition-all"
                    style={{ borderColor: sel ? c.color : "rgba(255,255,255,0.08)", background: sel ? c.bg : "transparent", color: sel ? c.color : "rgba(255,255,255,0.3)" }}>
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tipo + Responsable */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Tipo *</label>
              <select value={form.tipo} onChange={e => set("tipo", e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-white/25">
                <option value="">Seleccionar...</option>
                {Object.entries(TIPO_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Responsable</label>
              <select value={form.usuario_responsable_id} onChange={e => set("usuario_responsable_id", e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-white/25">
                <option value="">Sin asignar</option>
                {usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre}</option>)}
              </select>
            </div>
          </div>

          {/* Vehículo + Conductor con búsqueda */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Vehículo</label>
              <input value={busVeh} onChange={e => setBusVeh(e.target.value)} placeholder="Filtrar placa o marca..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-white/15 outline-none mb-1.5"/>
              <select value={form.vehiculo_id} onChange={e => set("vehiculo_id", e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-white/25">
                <option value="">Sin unidad</option>
                {vehFiltrados.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.marca} {v.modelo}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Conductor</label>
              <input value={busCon} onChange={e => setBusCon(e.target.value)} placeholder="Filtrar nombre o DNI..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-white/15 outline-none mb-1.5"/>
              <select value={form.conductor_id} onChange={e => set("conductor_id", e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-white/25">
                <option value="">Sin conductor</option>
                {conFiltrados.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.dni ? ` — ${c.dni}` : ""}</option>)}
              </select>
            </div>
          </div>

          {/* Cliente */}
          <div>
            <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Cliente afectado</label>
            <input value={form.cliente} onChange={e => set("cliente", e.target.value)} placeholder="Nombre de empresa cliente"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25"/>
          </div>

          {/* Descripción */}
          <div>
            <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Descripción *</label>
            <textarea value={form.descripcion} onChange={e => set("descripcion", e.target.value)} rows={3}
              placeholder="Describe qué ocurrió, cómo y en qué circunstancias..."
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25 resize-none"/>
          </div>

          {/* Ubicación + Impacto */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Ubicación</label>
              <input value={form.ubicacion} onChange={e => set("ubicacion", e.target.value)} placeholder="Av. Nombre, cdra. N, Distrito"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25"/>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Impacto económico S/</label>
              <input type="number" value={form.impacto_economico} onChange={e => set("impacto_economico", e.target.value)} placeholder="0.00"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25"/>
            </div>
          </div>

          {/* Causa raíz */}
          <div>
            <label className="block text-[11px] font-bold text-white/35 uppercase tracking-wider mb-2">Causa raíz (opcional)</label>
            <input value={form.causa_raiz} onChange={e => set("causa_raiz", e.target.value)} placeholder="Ej: Mantenimiento preventivo vencido"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25"/>
          </div>

          {/* Checkboxes */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "requiere_reemplazo", icon: <I.Swap size={13}/>,   label: "Requiere reemplazo", sub: "Notifica a despacho" },
              { key: "soat_activado",      icon: <I.Shield size={13}/>, label: "Activar SOAT",       sub: "Genera expediente"  },
            ].map(item => (
              <label key={item.key}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${(form as any)[item.key] ? "border-blue-500/30 bg-blue-500/8" : "border-white/8 bg-white/3 hover:bg-white/5"}`}>
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${(form as any)[item.key] ? "bg-blue-500 border-blue-500" : "border-white/20"}`}>
                  {(form as any)[item.key] && <I.Check size={10} color="white" strokeWidth={3}/>}
                </div>
                <input type="checkbox" className="hidden" checked={(form as any)[item.key]} onChange={e => set(item.key, e.target.checked)}/>
                <div>
                  <div className="flex items-center gap-1.5 text-white/70 text-xs font-bold">{item.icon}{item.label}</div>
                  <p className="text-white/25 text-[10px] mt-0.5">{item.sub}</p>
                </div>
              </label>
            ))}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm font-semibold">⚠ {error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-white/8 flex gap-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-white/10 text-white/35 text-sm font-bold hover:bg-white/5 transition-colors">
            Cancelar
          </button>
          <button onClick={guardar} disabled={guardando}
            className="flex-1 py-3 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-black transition-colors">
            {guardando ? "Guardando..." : "Registrar Incidencia"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MODAL DETALLE + EDICIÓN ─────────────────────────────────────────────────

function ModalDetalle({ inc, usuarios, onClose, onActualizado }: {
  inc: Incidencia; usuarios: Usuario[];
  onClose: () => void; onActualizado: () => void;
}) {
  const [estado,      setEstado]      = useState<EstadoK>(inc.estado);
  const [accion,      setAccion]      = useState(inc.accion_correctiva || "");
  const [responsable, setResponsable] = useState(inc.usuario_responsable_id || "");
  const [guardando,   setGuardando]   = useState(false);
  const sev = SEV[inc.severidad];
  const h   = horasDesde(inc.created_at);
  const sla = slaColor(inc.sla_limite_h, h);

  async function actualizar() {
    setGuardando(true);
    await supabase.from("incidencias").update({
      estado,
      accion_correctiva:      accion || null,
      usuario_responsable_id: responsable || null,
    }).eq("id", inc.id);
    if (estado !== inc.estado) {
      await supabase.from("incidencias_log").insert({
        incidencia_id: inc.id, accion: "estado_cambiado",
        estado_anterior: inc.estado, estado_nuevo: estado,
      });
    }
    setGuardando(false);
    onActualizado(); onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
      <div className="bg-[#0f1923] border border-white/10 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-white/8 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-mono text-white/25 text-xs">{inc.id}</span>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ color: sev.color, background: sev.bg }}>{sev.label}</span>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ color: ESTADO_K[inc.estado].color, background: ESTADO_K[inc.estado].color+"22" }}>{ESTADO_K[inc.estado].label}</span>
            </div>
            <h3 className="font-black text-white text-base">{TIPO_LABEL[inc.tipo]}</h3>
            <p className="text-white/25 text-xs mt-0.5">{new Date(inc.created_at).toLocaleString("es-PE")} · {inc.cliente || "Sin cliente"}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center flex-shrink-0 transition-colors">
            <I.X size={14} color="rgba(255,255,255,0.5)"/>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          <div className="bg-white/3 border border-white/8 rounded-xl p-4">
            <p className="text-white/25 text-[10px] font-bold uppercase tracking-wider mb-2">Descripción</p>
            <p className="text-white/80 text-sm leading-relaxed">{inc.descripcion}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Placa",      val: inc.vehiculo?.placa || "—",            mono: true  },
              { label: "Conductor",  val: inc.conductor?.nombre || "—",          mono: false },
              { label: "Ubicación",  val: inc.ubicacion || "—",                  mono: false },
              { label: "Impacto",    val: inc.impacto_economico ? `S/ ${inc.impacto_economico.toLocaleString()}` : "—", mono: false },
              { label: "SLA",        val: `${h}h / ${inc.sla_limite_h}h`,        mono: false, slaCol: inc.estado === "cerrado" ? "#6366f1" : sla.color },
              { label: "Registrado", val: new Date(inc.created_at).toLocaleDateString("es-PE"), mono: false },
            ].map(item => (
              <div key={item.label} className="bg-white/3 border border-white/6 rounded-xl p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: item.slaCol || "rgba(255,255,255,0.25)" }}>{item.label}</p>
                <p className={`text-sm font-bold ${item.mono ? "font-mono" : ""}`} style={{ color: item.slaCol || "rgba(255,255,255,0.8)" }}>{item.val}</p>
              </div>
            ))}
          </div>

          {inc.soat_activado && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-3">
              <I.Shield size={18} color="#ef4444"/>
              <div>
                <p className="text-red-400 font-black text-sm">Protocolo SOAT Activado</p>
                {inc.numero_siniestro && <p className="text-red-300/50 text-xs mt-0.5">{inc.numero_siniestro}</p>}
              </div>
            </div>
          )}

          {inc.causa_raiz && (
            <div className="bg-white/3 border border-white/8 rounded-xl p-3">
              <p className="text-white/25 text-[10px] font-bold uppercase tracking-wider mb-1">Causa raíz</p>
              <p className="text-white/70 text-sm">{inc.causa_raiz}</p>
            </div>
          )}

          {/* Edición */}
          <div className="border-t border-white/8 pt-4 space-y-3">
            <p className="text-white/25 text-[11px] font-bold uppercase tracking-wider">Actualizar</p>
            <div>
              <label className="block text-[10px] font-bold text-white/25 uppercase tracking-wider mb-2">Cambiar estado</label>
              <div className="grid grid-cols-4 gap-1.5">
                {KANBAN_COLS.map(e => {
                  const cfg = ESTADO_K[e]; const sel = estado === e;
                  return (
                    <button key={e} onClick={() => setEstado(e)}
                      className="py-2 rounded-xl text-[10px] font-black border transition-all"
                      style={{ borderColor: sel ? cfg.color : "rgba(255,255,255,0.08)", background: sel ? cfg.color+"22" : "transparent", color: sel ? cfg.color : "rgba(255,255,255,0.25)" }}>
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-white/25 uppercase tracking-wider mb-1.5">Responsable</label>
              <select value={responsable} onChange={e => setResponsable(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-white/25">
                <option value="">Sin asignar</option>
                {usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-white/25 uppercase tracking-wider mb-1.5">Acción correctiva</label>
              <textarea value={accion} onChange={e => setAccion(e.target.value)} rows={2}
                placeholder="Describe la acción tomada..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/15 outline-none focus:border-white/25 resize-none"/>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-white/8 flex gap-3 flex-shrink-0">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl border border-white/10 text-white/35 text-sm font-bold hover:bg-white/5 transition-colors">
            Cancelar
          </button>
          <button onClick={actualizar} disabled={guardando}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-black transition-colors">
            {guardando ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function IncidenciasPage() {
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [usuarios,    setUsuarios]    = useState<Usuario[]>([]);
  const [sesionId,    setSesionId]    = useState("");
  const [cargando,    setCargando]    = useState(true);
  const [vista,       setVista]       = useState<"tabla"|"kanban">("tabla");
  const [modalNueva,  setModalNueva]  = useState(false);
  const [detalle,     setDetalle]     = useState<Incidencia | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroSev,   setFiltroSev]   = useState("todos");
  const [filtroEstado,setFiltroEstado]= useState("todos");

  const cargar = useCallback(async () => {
    setCargando(true);
    const [{ data: inc }, { data: veh }, { data: con }, { data: usr }, { data: ses }] =
      await Promise.all([
        supabase.from("incidencias").select(`
          *,
          vehiculo:vehiculos(placa, marca, modelo),
          conductor:conductores(nombre, dni)
        `).order("created_at", { ascending: false }),
        supabase.from("vehiculos").select("id, placa, marca, modelo"),
        supabase.from("conductores").select("id, nombre, dni").eq("estado", "activo"),
        supabase.from("usuarios").select("id, nombre").eq("activo", true),
        supabase.auth.getSession(),
      ]);
    setIncidencias((inc || []) as Incidencia[]);
    setVehiculos(veh || []);
    setConductores(con || []);
    setUsuarios(usr || []);
    setSesionId(ses?.session?.user?.id || "");
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Realtime
  useEffect(() => {
    const ch = supabase.channel("inc-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "incidencias" }, cargar)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cargar]);

  // KPIs
  const hoy          = new Date().toISOString().split("T")[0];
  const criticos     = incidencias.filter(d => d.severidad === "critico" && d.estado !== "cerrado").length;
  const sinAsignar   = incidencias.filter(d => !d.usuario_responsable_id && d.estado !== "cerrado").length;
  const impactoTotal = incidencias.reduce((s, d) => s + (d.impacto_economico || 0), 0);
  const hoyCount     = incidencias.filter(d => d.created_at.startsWith(hoy)).length;
  const tiempos      = incidencias.filter(d => d.tiempo_resolucion_h).map(d => d.tiempo_resolucion_h!);
  const avgRes       = tiempos.length ? (tiempos.reduce((a,b) => a+b,0)/tiempos.length).toFixed(1) : "—";

  // Top buses
  const topBuses = useMemo(() => {
    const c: Record<string, number> = {};
    incidencias.forEach(d => {
      const k = d.vehiculo?.placa || (d.vehiculo_id ? `#${d.vehiculo_id}` : null);
      if (k) c[k] = (c[k] || 0) + 1;
    });
    return Object.entries(c).sort((a,b) => b[1]-a[1]).slice(0,3);
  }, [incidencias]);

  // Filtrado
  const filtradas = useMemo(() => incidencias.filter(d => {
    if (filtroSev    !== "todos" && d.severidad !== filtroSev)    return false;
    if (filtroEstado !== "todos" && d.estado    !== filtroEstado) return false;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      return (d.vehiculo?.placa   || "").toLowerCase().includes(q)
          || (d.conductor?.nombre || "").toLowerCase().includes(q)
          || d.descripcion.toLowerCase().includes(q)
          || (d.cliente || "").toLowerCase().includes(q);
    }
    return true;
  }), [incidencias, filtroSev, filtroEstado, busqueda]);

  if (cargando) return (
    <div className="min-h-screen bg-[#080f18] flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-white/8 border-t-red-500 rounded-full animate-spin mx-auto mb-3"/>
        <p className="text-white/25 text-sm">Cargando incidencias...</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#080f18] text-white">
      {modalNueva && (
        <ModalNueva vehiculos={vehiculos} conductores={conductores}
          usuarios={usuarios} sesionId={sesionId}
          onClose={() => setModalNueva(false)} onGuardado={cargar}/>
      )}
      {detalle && (
        <ModalDetalle inc={detalle} usuarios={usuarios}
          onClose={() => setDetalle(null)} onActualizado={cargar}/>
      )}

      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"/>
              <span className="text-white/20 text-xs font-bold uppercase tracking-widest">Tiempo real · Supabase</span>
            </div>
            <h1 className="text-2xl font-black text-white leading-none">Gestión de Incidencias</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={cargar} className="px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 text-white/35 hover:bg-white/8 transition-colors">
              <I.Refresh size={14}/>
            </button>
            <button onClick={() => setModalNueva(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-black transition-colors shadow-lg shadow-red-500/20">
              <I.Plus size={14} color="white"/>Nueva Incidencia
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Críticas activas",    val: criticos,                              color: "#ef4444", icon: <I.Alert size={15} color="#ef4444"/>,    bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.2)"   },
            { label: "Incidencias hoy",     val: hoyCount,                              color: "#f97316", icon: <I.BarChart size={15} color="#f97316"/>,  bg: "rgba(249,115,22,0.1)",  border: "rgba(249,115,22,0.2)"  },
            { label: "Sin responsable",     val: sinAsignar,                            color: "#eab308", icon: <I.User size={15} color="#eab308"/>,      bg: "rgba(234,179,8,0.1)",   border: "rgba(234,179,8,0.2)"   },
            { label: "Impacto económico",   val: `S/${(impactoTotal/1000).toFixed(1)}k`,color: "#a78bfa", icon: <I.Dollar size={15} color="#a78bfa"/>,   bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.2)" },
            { label: "Tiempo prom. cierre", val: avgRes === "—" ? "—" : `${avgRes}h`,   color: "#34d399", icon: <I.Clock size={15} color="#34d399"/>,    bg: "rgba(52,211,153,0.1)",  border: "rgba(52,211,153,0.2)"  },
          ].map(k => (
            <div key={k.label} className="rounded-2xl p-4 border" style={{ background: k.bg, borderColor: k.border }}>
              <div className="mb-2">{k.icon}</div>
              <div className="font-black text-2xl leading-none" style={{ color: k.color }}>{k.val}</div>
              <div className="text-[11px] text-white/25 font-semibold mt-1 leading-tight">{k.label}</div>
            </div>
          ))}
        </div>

        {/* Mini dashboard */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Top buses */}
          <div className="bg-[#0f1923] border border-white/8 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <I.Bus size={14} color="#f97316"/>
              <p className="text-white/40 text-xs font-black uppercase tracking-wider">Top buses con incidencias</p>
            </div>
            {topBuses.length === 0
              ? <p className="text-white/15 text-xs text-center py-6">Sin datos aún</p>
              : topBuses.map(([placa, count], i) => (
                <div key={placa} className="flex items-center gap-3 mb-3 last:mb-0">
                  <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black ${i===0?"bg-amber-500/20 text-amber-400":"bg-white/5 text-white/25"}`}>{i+1}</div>
                  <span className="font-mono font-bold text-white/65 text-sm flex-1">{placa}</span>
                  <div className="h-1.5 rounded-full bg-white/8 w-16 overflow-hidden">
                    <div className="h-full rounded-full bg-orange-500" style={{ width:`${(count/topBuses[0][1])*100}%` }}/>
                  </div>
                  <span className="text-white/35 text-xs font-bold w-4">{count}</span>
                </div>
              ))
            }
          </div>

          {/* Por severidad */}
          <div className="bg-[#0f1923] border border-white/8 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <I.BarChart size={14} color="#6366f1"/>
              <p className="text-white/40 text-xs font-black uppercase tracking-wider">Por severidad</p>
            </div>
            {(["critico","alto","medio","bajo"] as Severidad[]).map(s => {
              const count = incidencias.filter(d => d.severidad === s).length;
              const max   = Math.max(...(["critico","alto","medio","bajo"] as Severidad[]).map(x => incidencias.filter(d=>d.severidad===x).length),1);
              return (
                <div key={s} className="flex items-center gap-2 mb-2.5 last:mb-0">
                  <span className="text-[11px] font-bold w-14" style={{ color: SEV[s].color }}>{SEV[s].label}</span>
                  <div className="h-1.5 rounded-full bg-white/8 flex-1 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width:`${(count/max)*100}%`, background: SEV[s].color }}/>
                  </div>
                  <span className="text-white/25 text-xs font-bold w-4">{count}</span>
                </div>
              );
            })}
          </div>

          {/* SLA */}
          <div className="bg-[#0f1923] border border-white/8 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <I.Clock size={14} color="#34d399"/>
              <p className="text-white/40 text-xs font-black uppercase tracking-wider">Estado de SLA</p>
            </div>
            {[
              { label:"En tiempo",  color:"#34d399", count: incidencias.filter(d=>{ const h=horasDesde(d.created_at); return h/d.sla_limite_h<0.75&&d.estado!=="cerrado"; }).length },
              { label:"Por vencer", color:"#f97316", count: incidencias.filter(d=>{ const p=horasDesde(d.created_at)/d.sla_limite_h; return p>=0.75&&p<1&&d.estado!=="cerrado"; }).length },
              { label:"Vencido",    color:"#ef4444", count: incidencias.filter(d=>horasDesde(d.created_at)>=d.sla_limite_h&&d.estado!=="cerrado").length },
              { label:"Cerrado",    color:"#6366f1", count: incidencias.filter(d=>d.estado==="cerrado").length },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: item.color }}/>
                  <span className="text-white/35 text-xs">{item.label}</span>
                </div>
                <span className="font-black text-sm" style={{ color: item.color }}>{item.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-[#0f1923] border border-white/8 rounded-2xl p-4">
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <I.Search size={14} color="rgba(255,255,255,0.15)" className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"/>
              <input className="w-full pl-9 pr-4 py-2.5 bg-white/5 border border-white/8 rounded-xl text-sm text-white placeholder-white/15 outline-none focus:border-white/20"
                placeholder="Buscar por placa, conductor, cliente o descripción..."
                value={busqueda} onChange={e => setBusqueda(e.target.value)}/>
            </div>
            <select value={filtroSev} onChange={e => setFiltroSev(e.target.value)}
              className="bg-white/5 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white/50 outline-none">
              <option value="todos">Toda severidad</option>
              {Object.entries(SEV).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
              className="bg-white/5 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white/50 outline-none">
              <option value="todos">Todos los estados</option>
              {Object.entries(ESTADO_K).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <div className="flex bg-white/5 rounded-xl p-1 gap-1">
              {(["tabla","kanban"] as const).map(v => (
                <button key={v} onClick={() => setVista(v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${vista===v?"bg-white/10 text-white":"text-white/25 hover:text-white/50"}`}>
                  {v === "tabla" ? <><I.Table size={13}/>Tabla</> : <><I.Kanban size={13}/>Kanban</>}
                </button>
              ))}
            </div>
          </div>
          <p className="text-white/15 text-xs mt-2">{filtradas.length} de {incidencias.length} incidencias</p>
        </div>

        {/* Vista Tabla */}
        {vista === "tabla" && (
          <div className="bg-[#0f1923] border border-white/8 rounded-2xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/8">
                  {["ID / Fecha","Severidad","Tipo","Unidad · Conductor","Ubicación","Cliente","SLA","Estado",""].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-[10px] font-black text-white/18 uppercase tracking-widest whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtradas.map(inc => {
                  const sev = SEV[inc.severidad];
                  const est = ESTADO_K[inc.estado];
                  const h   = horasDesde(inc.created_at);
                  const sla = slaColor(inc.sla_limite_h, h);
                  return (
                    <tr key={inc.id} className="hover:bg-white/3 transition-colors group">
                      <td className="px-4 py-3">
                        <div className="font-mono text-white/30 text-xs">{inc.id}</div>
                        <div className="text-white/18 text-[10px]">{new Date(inc.created_at).toLocaleDateString("es-PE")}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ color: sev.color, background: sev.bg }}>{sev.label}</span>
                      </td>
                      <td className="px-4 py-3 text-white/55 text-xs font-semibold max-w-[130px]">
                        <span className="truncate block">{TIPO_LABEL[inc.tipo]}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono font-black text-white/65 text-xs">{inc.vehiculo?.placa || "—"}</div>
                        <div className="text-white/22 text-[11px] truncate max-w-[120px]">{inc.conductor?.nombre || "—"}</div>
                      </td>
                      <td className="px-4 py-3 text-white/30 text-xs max-w-[140px]">
                        <span className="truncate block">{inc.ubicacion || "—"}</span>
                      </td>
                      <td className="px-4 py-3 text-white/40 text-xs font-semibold">{inc.cliente || "—"}</td>
                      <td className="px-4 py-3">
                        {inc.estado === "cerrado"
                          ? <span className="text-[11px] font-bold text-indigo-400">{inc.tiempo_resolucion_h}h</span>
                          : <>
                              <div className="flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full" style={{ background: sla.color }}/>
                                <span className="text-[11px] font-bold" style={{ color: sla.color }}>{sla.label}</span>
                              </div>
                              <div className="text-white/15 text-[10px]">{h}h / {inc.sla_limite_h}h</div>
                            </>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] font-black px-2 py-1 rounded-full" style={{ color: est.color, background: est.color+"22" }}>{est.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => setDetalle(inc)}
                          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 bg-white/8 hover:bg-white/15 text-white/40 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition-all">
                          <I.Eye size={11}/>Ver
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtradas.length === 0 && (
              <div className="py-16 text-center">
                <I.Search size={28} color="rgba(255,255,255,0.07)" className="mx-auto mb-3"/>
                <p className="text-white/18 text-sm">Sin resultados para los filtros aplicados</p>
              </div>
            )}
          </div>
        )}

        {/* Vista Kanban */}
        {vista === "kanban" && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {KANBAN_COLS.map(col => {
              const cfg      = ESTADO_K[col];
              const tarjetas = filtradas.filter(d => d.estado === col);
              return (
                <div key={col} className="bg-[#0f1923] border border-white/8 rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: cfg.color }}/>
                      <span className="text-white/55 text-xs font-black">{cfg.label}</span>
                    </div>
                    <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ color: cfg.color, background: cfg.color+"22" }}>{tarjetas.length}</span>
                  </div>
                  <div className="p-3 space-y-3 min-h-[200px]">
                    {tarjetas.map(inc => {
                      const sev = SEV[inc.severidad];
                      const h   = horasDesde(inc.created_at);
                      const sla = slaColor(inc.sla_limite_h, h);
                      return (
                        <div key={inc.id} onClick={() => setDetalle(inc)}
                          className="bg-white/3 border border-white/8 hover:border-white/15 rounded-xl p-3 cursor-pointer transition-all hover:bg-white/5 group">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ color: sev.color, background: sev.bg }}>{sev.label}</span>
                            <span className="font-mono text-white/18 text-[10px]">{inc.id}</span>
                          </div>
                          <p className="text-white/65 text-xs font-bold mb-1">{TIPO_LABEL[inc.tipo]}</p>
                          <p className="text-white/22 text-[11px] leading-relaxed line-clamp-2 mb-3">{inc.descripcion}</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            {inc.vehiculo?.placa && <span className="font-mono text-white/30 text-[10px] bg-white/5 px-1.5 py-0.5 rounded">{inc.vehiculo.placa}</span>}
                            {inc.soat_activado && <I.Shield size={11} color="#ef4444"/>}
                            {inc.requiere_reemplazo && <I.Swap size={11} color="#3b82f6"/>}
                            <div className="ml-auto flex items-center gap-1">
                              <div className="w-1.5 h-1.5 rounded-full" style={{ background: inc.estado==="cerrado"?"#6366f1":sla.color }}/>
                              <span className="text-[10px]" style={{ color: inc.estado==="cerrado"?"#6366f1":sla.color }}>{h}h</span>
                            </div>
                          </div>
                          <div className="mt-2 pt-2 border-t border-white/5 flex justify-between">
                            <span className="text-white/18 text-[10px]">{inc.cliente || "—"}</span>
                            <span className="text-white/15 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">Ver →</span>
                          </div>
                        </div>
                      );
                    })}
                    {tarjetas.length === 0 && <p className="text-white/10 text-xs text-center py-8">Sin incidencias</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        .line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
        select option{background:#0f1923;color:white;}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:4px;}
      `}</style>
    </div>
  );
}