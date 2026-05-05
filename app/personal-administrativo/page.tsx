"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Personal = {
  id: number; nombre: string; dni: string | null;
  cargo: string | null; departamento: string | null;
  fecha_nacimiento: string | null; email: string | null;
  telefono: string | null; direccion: string | null;
  fecha_ingreso: string | null; tipo_contrato: string | null;
  fecha_venc_contrato: string | null;
  sistema_pensionario: string | null; afp_nombre: string | null;
  essalud_numero: string | null;
  sctr_salud_venc: string | null; sctr_pension_venc: string | null;
  examen_medico_venc: string | null; antecedentes_venc: string | null;
  vida_ley: boolean | null; vida_ley_venc: string | null;
  foto_url: string | null; estado: string; observaciones: string | null;
  created_at: string;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CARGOS = [
  "Gerente General", "Administrador", "Contador", "Asistente Contable",
  "Jefe de Operaciones", "Coordinador de Operaciones", "Asistente de Operaciones",
  "Jefe Comercial", "Ejecutivo de Ventas", "Atención al Cliente",
  "Jefe de RRHH", "Asistente de RRHH",
  "Jefe de Logística", "Coordinador de Flota",
  "Recepcionista", "Secretaria", "Asistente Administrativo",
  "Supervisor", "Jefe de Taller", "Almacenero", "Otro",
];

const DEPARTAMENTOS = [
  "Gerencia", "Administración", "Contabilidad / Finanzas",
  "Operaciones", "Comercial / Ventas", "RRHH",
  "Logística / Flota", "Tecnología", "Legal", "Otro",
];

const TIPOS_CONTRATO = [
  { valor: "planilla",     label: "Planilla indefinida",    desc: "Sin vencimiento" },
  { valor: "plazo_fijo",   label: "Plazo fijo",             desc: "Requiere vencimiento" },
  { valor: "honorarios",   label: "Recibo por honorarios",  desc: "Locador de servicios" },
  { valor: "service",      label: "Service / tercero",      desc: "Personal destacado" },
  { valor: "practicante",  label: "Practicante",            desc: "Convenio práctica" },
];

const AFP_NOMBRES = ["Integra", "Prima", "Profuturo", "Habitat"];

// Documentos SUNAFIL a controlar para administrativos
const DOCS_SUNAFIL = [
  { key: "fecha_venc_contrato", label: "Contrato de trabajo",  icon: "📄", obligatorio: true,  condicional: "plazo_fijo", diasAlerta: 30 },
  { key: "sctr_salud_venc",     label: "SCTR Salud",           icon: "🏥", obligatorio: true,  condicional: null,          diasAlerta: 30 },
  { key: "sctr_pension_venc",   label: "SCTR Pensión",         icon: "💼", obligatorio: true,  condicional: null,          diasAlerta: 30 },
  { key: "examen_medico_venc",  label: "Examen médico ocup.",  icon: "🩺", obligatorio: true,  condicional: null,          diasAlerta: 30 },
  { key: "antecedentes_venc",   label: "Antecedentes",         icon: "📋", obligatorio: false, condicional: null,          diasAlerta: 30 },
  { key: "vida_ley_venc",       label: "Seg. Vida Ley",        icon: "💛", obligatorio: false, condicional: "vida_ley",    diasAlerta: 30 },
];

const FORM_VACIO = {
  nombre: "", dni: "", cargo: "", departamento: "Administración",
  fecha_nacimiento: "", email: "", telefono: "", direccion: "",
  fecha_ingreso: "", tipo_contrato: "planilla", fecha_venc_contrato: "",
  sistema_pensionario: "afp", afp_nombre: "Integra", essalud_numero: "",
  sctr_salud_venc: "", sctr_pension_venc: "",
  examen_medico_venc: "", antecedentes_venc: "",
  vida_ley: false, vida_ley_venc: "",
  foto_url: "", estado: "activo", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoFecha(f: string | null, alerta = 30): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0) return "vencido";
  if (d <= alerta) return "por_vencer";
  return "vigente";
}
function calcEdad(f: string | null): number | null {
  if (!f) return null;
  const hoy = new Date(); const nac = new Date(f + "T00:00:00");
  let edad = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return edad;
}
function calcAntig(f: string | null): string {
  if (!f) return "—";
  const hoy = new Date(); const ing = new Date(f + "T00:00:00");
  let años = hoy.getFullYear() - ing.getFullYear();
  let meses = hoy.getMonth() - ing.getMonth();
  if (meses < 0) { años--; meses += 12; }
  if (años > 0) return `${años} año${años > 1 ? "s" : ""}${meses > 0 ? ` ${meses}m` : ""}`;
  if (meses > 0) return `${meses} mes${meses > 1 ? "es" : ""}`;
  return "Reciente";
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
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

// Score cumplimiento
function calcScore(p: Personal): { score: number; vencidos: string[]; porVencer: string[] } {
  const vencidos: string[] = []; const porVencer: string[] = [];
  DOCS_SUNAFIL.forEach(d => {
    if (d.condicional === "plazo_fijo" && p.tipo_contrato !== "plazo_fijo") return;
    if (d.condicional === "vida_ley" && !p.vida_ley) return;
    const val = (p as any)[d.key];
    const est = estadoFecha(val, d.diasAlerta);
    if (est === "vencido") vencidos.push(d.label);
    else if (est === "por_vencer") porVencer.push(d.label);
  });
  const total = DOCS_SUNAFIL.filter(d => {
    if (d.condicional === "plazo_fijo" && p.tipo_contrato !== "plazo_fijo") return false;
    if (d.condicional === "vida_ley" && !p.vida_ley) return false;
    return true;
  }).length || 1;
  const score = Math.max(0, Math.round(((total - vencidos.length * 2 - porVencer.length) / total) * 100));
  return { score, vencidos, porVencer };
}

function BadgeDoc({ fecha, diasAlerta = 30, label }: { fecha: string | null; diasAlerta?: number; label: string }) {
  const est = estadoFecha(fecha, diasAlerta);
  const dias = diasPara(fecha);
  const cfg = {
    vigente:    { bg: "#dcfce7", color: "#166534" },
    por_vencer: { bg: "#fef9c3", color: "#854d0e" },
    vencido:    { bg: "#fee2e2", color: "#991b1b" },
    sin_fecha:  { bg: "#f3f4f6", color: "#4b5563" },
  }[est];
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[10px]" style={{ background: cfg.bg }}>
      <span className="font-bold" style={{ color: cfg.color }}>{label}</span>
      <span className="font-mono" style={{ color: cfg.color }}>
        {fecha ? (est === "vencido" ? `${Math.abs(dias!)}d venc.` : est === "por_vencer" ? `${dias}d` : fmtFecha(fecha)) : "Sin fecha"}
      </span>
    </div>
  );
}

const DEPTO_COLORES: Record<string, { color: string; bg: string }> = {
  "Gerencia":            { color: "#0b315f", bg: "#eef3f8" },
  "Administración":      { color: "#4b5563", bg: "#f3f4f6" },
  "Contabilidad / Finanzas": { color: "#166534", bg: "#dcfce7" },
  "Operaciones":         { color: "#0369a1", bg: "#e0f2fe" },
  "Comercial / Ventas":  { color: "#7c3aed", bg: "#ede9fe" },
  "RRHH":                { color: "#1d4ed8", bg: "#dbeafe" },
  "Logística / Flota":   { color: "#854d0e", bg: "#fef9c3" },
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function PersonalAdministrativoPage() {
  const [personal,    setPersonal]    = useState<Personal[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [vistaCards,  setVistaCards]  = useState(false);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroDepto, setFiltroDepto] = useState("todos");
  const [filtroAlerta,setFiltroAlerta]= useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: (e.target as HTMLInputElement).type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const { data, error } = await supabase.from("personal_administrativo").select("*").order("nombre");
    if (error) alert(error.message);
    else setPersonal(data || []);
    setLoading(false);
  };
  useEffect(() => { cargarDatos(); }, []);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    setGuardando(true);
    const payload: any = {
      nombre: form.nombre.trim(), dni: form.dni.trim() || null,
      cargo: form.cargo || null, departamento: form.departamento || null,
      fecha_nacimiento: form.fecha_nacimiento || null,
      email: form.email.trim() || null, telefono: form.telefono.trim() || null,
      direccion: form.direccion.trim() || null, fecha_ingreso: form.fecha_ingreso || null,
      tipo_contrato: form.tipo_contrato || null,
      fecha_venc_contrato: form.tipo_contrato === "plazo_fijo" ? (form.fecha_venc_contrato || null) : null,
      sistema_pensionario: form.sistema_pensionario || null,
      afp_nombre: form.sistema_pensionario === "afp" ? form.afp_nombre : null,
      essalud_numero: form.essalud_numero.trim() || null,
      sctr_salud_venc: form.sctr_salud_venc || null,
      sctr_pension_venc: form.sctr_pension_venc || null,
      examen_medico_venc: form.examen_medico_venc || null,
      antecedentes_venc: form.antecedentes_venc || null,
      vida_ley: form.vida_ley,
      vida_ley_venc: form.vida_ley ? (form.vida_ley_venc || null) : null,
      foto_url: form.foto_url.trim() || null, estado: form.estado,
      observaciones: form.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("personal_administrativo").update(payload).eq("id", editandoId)
      : await supabase.from("personal_administrativo").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (p: Personal) => {
    setForm({
      nombre: p.nombre || "", dni: p.dni || "",
      cargo: p.cargo || "", departamento: p.departamento || "Administración",
      fecha_nacimiento: p.fecha_nacimiento || "", email: p.email || "",
      telefono: p.telefono || "", direccion: p.direccion || "",
      fecha_ingreso: p.fecha_ingreso || "", tipo_contrato: p.tipo_contrato || "planilla",
      fecha_venc_contrato: p.fecha_venc_contrato || "",
      sistema_pensionario: p.sistema_pensionario || "afp",
      afp_nombre: p.afp_nombre || "Integra", essalud_numero: p.essalud_numero || "",
      sctr_salud_venc: p.sctr_salud_venc || "", sctr_pension_venc: p.sctr_pension_venc || "",
      examen_medico_venc: p.examen_medico_venc || "", antecedentes_venc: p.antecedentes_venc || "",
      vida_ley: p.vida_ley || false, vida_ley_venc: p.vida_ley_venc || "",
      foto_url: p.foto_url || "", estado: p.estado || "activo", observaciones: p.observaciones || "",
    });
    setEditandoId(p.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar a ${nombre}?`)) return;
    await supabase.from("personal_administrativo").delete().eq("id", id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const total        = personal.length;
  const activos      = personal.filter(p => p.estado === "activo").length;
  const contrVenc    = personal.filter(p => p.tipo_contrato === "plazo_fijo" && estadoFecha(p.fecha_venc_contrato, 30) === "vencido").length;
  const sctrVenc     = personal.filter(p => estadoFecha(p.sctr_salud_venc, 30) === "vencido" || estadoFecha(p.sctr_pension_venc, 30) === "vencido").length;
  const examenVenc   = personal.filter(p => estadoFecha(p.examen_medico_venc, 30) === "vencido").length;
  const porVencerTotal = personal.filter(p => {
    const { porVencer } = calcScore(p);
    return porVencer.length > 0;
  }).length;

  // Por departamento
  const deptosUnicos = [...new Set(personal.map(p => p.departamento).filter(Boolean))] as string[];

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => personal.filter(p => {
    const q = busqueda.toLowerCase();
    const txt = `${p.nombre} ${p.dni || ""} ${p.cargo || ""} ${p.departamento || ""}`.toLowerCase();
    const { vencidos, porVencer } = calcScore(p);
    const alertaMatch =
      filtroAlerta === "todos" ? true :
      filtroAlerta === "critico" ? vencidos.length > 0 :
      filtroAlerta === "atencion" ? porVencer.length > 0 :
      filtroAlerta === "ok" ? vencidos.length === 0 && porVencer.length === 0 : true;
    return txt.includes(q) &&
      (filtroDepto === "todos" || p.departamento === filtroDepto) && alertaMatch;
  }), [personal, busqueda, filtroDepto, filtroAlerta]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Personal Administrativo</h1>
          <p className="text-gray-400 text-sm mt-1">Contratos · SCTR · exámenes · AFP/ONP · cumplimiento SUNAFIL / MTPE</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setVistaCards(v => !v)} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            {vistaCards ? "📋 Tabla" : "🪪 Tarjetas"}
          </button>
          <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nuevo personal"}
          </button>
        </div>
      </div>

      {/* ALERTAS SUNAFIL */}
      {(contrVenc > 0 || sctrVenc > 0 || examenVenc > 0) && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-red-800 mb-1">🚨 Riesgo de multa SUNAFIL — acción inmediata requerida</p>
          {contrVenc  > 0 && <div className="text-xs text-red-700">• <b>{contrVenc}</b> contrato{contrVenc > 1 ? "s" : ""} de plazo fijo vencido — riesgo desnaturalización en planilla indefinida (Art. 77 LPCL)</div>}
          {sctrVenc   > 0 && <div className="text-xs text-red-700">• <b>{sctrVenc}</b> SCTR vencido — multa hasta 20 UIT ≈ S/ 103,000 (SUNAFIL)</div>}
          {examenVenc > 0 && <div className="text-xs text-red-700">• <b>{examenVenc}</b> examen médico ocupacional vencido — multa hasta 50 UIT ≈ S/ 257,500 (SST)</div>}
        </div>
      )}
      {porVencerTotal > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          ⚠️ <b>{porVencerTotal} persona{porVencerTotal > 1 ? "s" : ""}</b> con documentos por vencer en 30 días — renovar antes del vencimiento
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Total",          valor: total,       color: "#0b315f", bg: "#eef3f8" },
          { label: "Activos",        valor: activos,     color: "#166534", bg: "#dcfce7" },
          { label: "Contrato venc.", valor: contrVenc,   color: contrVenc > 0 ? "#991b1b" : "#166534",   bg: contrVenc > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "SCTR vencido",   valor: sctrVenc,    color: sctrVenc > 0 ? "#991b1b" : "#166534",    bg: sctrVenc > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Examen vencido", valor: examenVenc,  color: examenVenc > 0 ? "#991b1b" : "#166534",  bg: examenVenc > 0 ? "#fee2e2" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPI por departamento */}
      {deptosUnicos.length > 0 && (
        <section className="flex gap-2 flex-wrap">
          {deptosUnicos.map(dep => {
            const cnt = personal.filter(p => p.departamento === dep).length;
            const cfg = DEPTO_COLORES[dep] || { color: "#4b5563", bg: "#f3f4f6" };
            const act = filtroDepto === dep;
            return (
              <button key={dep} onClick={() => setFiltroDepto(act ? "todos" : dep)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 text-xs font-bold transition-all"
                style={{ background: act ? cfg.bg : "white", borderColor: act ? cfg.color : "#e5e7eb", color: act ? cfg.color : "#6b7280" }}>
                {dep}
                <span className="px-1.5 py-0.5 rounded-full text-white text-[9px] font-black" style={{ background: act ? cfg.color : "#d1d5db" }}>{cnt}</span>
              </button>
            );
          })}
        </section>
      )}

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold">{editandoId ? "Editar personal" : "Nuevo personal administrativo"}</h2>

          {/* Datos personales */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos personales</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Nombre completo *" span={2}><input className={inputCls()} placeholder="María García Rodríguez" value={form.nombre} onChange={f("nombre")} /></Campo>
              <Campo label="DNI"><input className={inputCls("font-mono")} placeholder="12345678" maxLength={8} value={form.dni} onChange={f("dni")} /></Campo>
              <Campo label="Fecha de nacimiento">
                <input type="date" className={inputCls()} value={form.fecha_nacimiento} onChange={f("fecha_nacimiento")} />
                {form.fecha_nacimiento && <p className="text-[10px] text-gray-400 mt-1">Edad: {calcEdad(form.fecha_nacimiento)} años</p>}
              </Campo>
              <Campo label="Teléfono"><input className={inputCls()} value={form.telefono} onChange={f("telefono")} /></Campo>
              <Campo label="Email"><input type="email" className={inputCls()} value={form.email} onChange={f("email")} /></Campo>
              <Campo label="Dirección" span={3}><input className={inputCls()} value={form.direccion} onChange={f("direccion")} /></Campo>
            </div>
          </div>

          {/* Cargo y departamento */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Puesto de trabajo</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Cargo / Puesto">
                <select className={inputCls()} value={form.cargo} onChange={f("cargo")}>
                  <option value="">Seleccionar cargo</option>
                  {CARGOS.map(c => <option key={c}>{c}</option>)}
                </select>
              </Campo>
              <Campo label="Departamento">
                <select className={inputCls()} value={form.departamento} onChange={f("departamento")}>
                  {DEPARTAMENTOS.map(d => <option key={d}>{d}</option>)}
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="activo">Activo</option>
                  <option value="inactivo">Inactivo</option>
                  <option value="de_baja">De baja</option>
                  <option value="vacaciones">De vacaciones</option>
                  <option value="licencia">Licencia</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* Contrato */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Contrato laboral — SUNAFIL / MTPE</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Fecha de ingreso">
                <input type="date" className={inputCls()} value={form.fecha_ingreso} onChange={f("fecha_ingreso")} />
                {form.fecha_ingreso && <p className="text-[10px] text-gray-400 mt-1">Antigüedad: {calcAntig(form.fecha_ingreso)}</p>}
              </Campo>
              <Campo label="Tipo de contrato">
                <select className={inputCls()} value={form.tipo_contrato} onChange={f("tipo_contrato")}>
                  {TIPOS_CONTRATO.map(t => <option key={t.valor} value={t.valor}>{t.label}</option>)}
                </select>
                <p className="text-[10px] text-gray-400 mt-0.5">{TIPOS_CONTRATO.find(t => t.valor === form.tipo_contrato)?.desc}</p>
              </Campo>
              {form.tipo_contrato === "plazo_fijo" && (
                <Campo label="Vencimiento contrato *">
                  <input type="date" className={inputCls(estadoFecha(form.fecha_venc_contrato) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.fecha_venc_contrato} onChange={f("fecha_venc_contrato")} />
                  {form.fecha_venc_contrato && (
                    <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(form.fecha_venc_contrato)! < 0 ? "#dc2626" : "#d97706" }}>
                      {diasPara(form.fecha_venc_contrato)! < 0 ? "⚠ VENCIDO — riesgo desnaturalización" : `Vence en ${diasPara(form.fecha_venc_contrato)}d`}
                    </p>
                  )}
                </Campo>
              )}
            </div>

            {/* Alerta vida ley */}
            {form.fecha_ingreso && (() => {
              const años = Math.floor((Date.now() - new Date(form.fecha_ingreso + "T00:00:00").getTime()) / (365.25 * 86400000));
              if (años >= 4 && !form.vida_ley) return (
                <div className="mt-3 rounded-xl px-4 py-2.5 text-xs text-amber-800 border border-amber-200" style={{ background: "#fef9c3" }}>
                  ⚠️ <b>Seguro Vida Ley obligatorio</b> — este trabajador tiene {años} años de antigüedad. El D.L. 688 obliga el seguro desde 4 años. Actívalo abajo.
                </div>
              );
            })()}
          </div>

          {/* Previsión social */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Previsión social — SUNAT / T-REGISTRO</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Sistema pensionario">
                <select className={inputCls()} value={form.sistema_pensionario} onChange={f("sistema_pensionario")}>
                  <option value="afp">AFP</option>
                  <option value="onp">ONP (Sistema Nacional)</option>
                  <option value="ninguno">Sin aporte (honorarios)</option>
                </select>
              </Campo>
              {form.sistema_pensionario === "afp" && (
                <Campo label="AFP">
                  <select className={inputCls()} value={form.afp_nombre} onChange={f("afp_nombre")}>
                    {AFP_NOMBRES.map(a => <option key={a}>{a}</option>)}
                  </select>
                </Campo>
              )}
              <Campo label="N° ESSALUD">
                <input className={inputCls("font-mono")} placeholder="Nro. de asegurado" value={form.essalud_numero} onChange={f("essalud_numero")} />
              </Campo>
            </div>
          </div>

          {/* Documentos SST y SUNAFIL */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Seguridad y Salud en el Trabajo — SST / SUNAFIL</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="🏥 SCTR Salud — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.sctr_salud_venc) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.sctr_salud_venc} onChange={f("sctr_salud_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Obligatorio planilla · renovar anualmente</p>
              </Campo>
              <Campo label="💼 SCTR Pensión — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.sctr_pension_venc) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.sctr_pension_venc} onChange={f("sctr_pension_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Complementa SCTR Salud</p>
              </Campo>
              <Campo label="🩺 Examen médico ocup. — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.examen_medico_venc) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.examen_medico_venc} onChange={f("examen_medico_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Anual · multa hasta 50 UIT si vence</p>
              </Campo>
              <Campo label="📋 Antecedentes — vencimiento">
                <input type="date" className={inputCls()} value={form.antecedentes_venc} onChange={f("antecedentes_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Penales · policiales · judiciales · 3 meses</p>
              </Campo>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer mt-5">
                  <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={form.vida_ley} onChange={f("vida_ley")} />
                  <span className="text-sm font-bold text-gray-700">💛 Seguro Vida Ley (D.L. 688)</span>
                </label>
                {form.vida_ley && (
                  <input type="date" className={inputCls()} placeholder="Vencimiento póliza" value={form.vida_ley_venc} onChange={f("vida_ley_venc")} />
                )}
                <p className="text-[10px] text-gray-400">Obligatorio desde 4 años de antigüedad</p>
              </div>
            </div>
          </div>

          <Campo label="Foto URL / URL carnet"><input className={inputCls()} placeholder="https://..." value={form.foto_url} onChange={f("foto_url")} /></Campo>
          <Campo label="Observaciones / notas internas"><input className={inputCls()} value={form.observaciones} onChange={f("observaciones")} /></Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar personal"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar nombre, DNI, cargo..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroDepto} onChange={e => setFiltroDepto(e.target.value)}>
          <option value="todos">Todos los departamentos</option>
          {DEPARTAMENTOS.map(d => <option key={d}>{d}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroAlerta} onChange={e => setFiltroAlerta(e.target.value)}>
          <option value="todos">Todas las alertas</option>
          <option value="critico">🚨 Con docs vencidos</option>
          <option value="atencion">⚠️ Por vencer</option>
          <option value="ok">✅ Sin alertas</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}</div>
      </section>

      {/* ── TARJETAS ── */}
      {vistaCards && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {loading ? <div className="col-span-3 p-10 text-center text-gray-400">Cargando...</div>
            : filtrados.map(p => {
              const { score, vencidos, porVencer } = calcScore(p);
              const scoreColor = vencidos.length > 0 ? "#dc2626" : porVencer.length > 0 ? "#d97706" : "#16a34a";
              const depCfg = DEPTO_COLORES[p.departamento || ""] || { color: "#4b5563", bg: "#f3f4f6" };
              return (
                <div key={p.id} className="bg-white rounded-2xl border-2 shadow-sm p-5 space-y-3 hover:shadow-md transition-all"
                  style={{ borderColor: vencidos.length > 0 ? "#fca5a5" : porVencer.length > 0 ? "#fde68a" : "#e5e7eb" }}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-full flex items-center justify-center font-black text-white text-lg flex-shrink-0" style={{ background: "#0b315f" }}>
                        {p.nombre.charAt(0)}
                      </div>
                      <div>
                        <p className="font-black text-gray-900">{p.nombre}</p>
                        {p.cargo && <p className="text-xs text-gray-600">{p.cargo}</p>}
                        {p.departamento && <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: depCfg.bg, color: depCfg.color }}>{p.departamento}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] font-bold uppercase" style={{ color: scoreColor }}>SUNAFIL</div>
                      <div className="text-2xl font-black" style={{ color: scoreColor }}>{score}%</div>
                    </div>
                  </div>

                  {/* Alertas */}
                  {vencidos.length > 0 && (
                    <div className="rounded-xl px-3 py-2 text-[10px] text-red-800 space-y-0.5" style={{ background: "#fee2e2" }}>
                      <p className="font-black">🚨 Vencidos:</p>
                      {vencidos.map(v => <p key={v}>· {v}</p>)}
                    </div>
                  )}
                  {porVencer.length > 0 && (
                    <div className="rounded-xl px-3 py-2 text-[10px] text-amber-800 space-y-0.5" style={{ background: "#fef9c3" }}>
                      <p className="font-black">⚠️ Por vencer:</p>
                      {porVencer.map(v => <p key={v}>· {v}</p>)}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div><p className="text-gray-400">Antigüedad</p><p className="font-bold">{calcAntig(p.fecha_ingreso)}</p></div>
                    <div><p className="text-gray-400">Contrato</p><p className="font-bold">{TIPOS_CONTRATO.find(t => t.valor === p.tipo_contrato)?.label || "—"}</p></div>
                    {p.sistema_pensionario && <div><p className="text-gray-400">Pensión</p><p className="font-bold">{p.sistema_pensionario === "afp" ? `AFP ${p.afp_nombre}` : p.sistema_pensionario.toUpperCase()}</p></div>}
                    {p.telefono && <div><p className="text-gray-400">Tel</p><a href={`tel:${p.telefono}`} className="font-bold text-[#0b315f]">{p.telefono}</a></div>}
                  </div>

                  <div className="flex gap-2 pt-1 border-t" style={{ borderColor: "#f1f5f9" }}>
                    <button onClick={() => editar(p)} className="flex-1 py-1.5 rounded-xl text-[10px] font-bold border hover:bg-gray-50 text-gray-700">✏️ Editar</button>
                    <button onClick={() => eliminar(p.id, p.nombre)} className="px-2.5 py-1.5 rounded-xl text-[10px] font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                  </div>
                </div>
              );
            })
          }
        </div>
      )}

      {/* ── TABLA ── */}
      {!vistaCards && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <th className="p-3 w-8"></th>
                  {["Personal", "DNI", "Cargo / Área", "Contrato", "SCTR", "Examen", "Antigüedad", "SUNAFIL", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                  </td></tr>
                ) : filtrados.length === 0 ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">👥</p><p>Sin personal registrado</p></td></tr>
                ) : filtrados.map(p => {
                  const { score, vencidos, porVencer } = calcScore(p);
                  const expandido = expandidoId === p.id;
                  const scoreColor = vencidos.length > 0 ? "#dc2626" : score >= 80 ? "#16a34a" : "#d97706";
                  const rowBg = vencidos.length > 0 ? "#fff5f5" : "white";
                  const sctrEst = estadoFecha(p.sctr_salud_venc) === "vencido" || estadoFecha(p.sctr_pension_venc) === "vencido";
                  const examenEst = estadoFecha(p.examen_medico_venc) === "vencido";
                  const contrVenc2 = p.tipo_contrato === "plazo_fijo" && estadoFecha(p.fecha_venc_contrato) === "vencido";
                  const depCfg = DEPTO_COLORES[p.departamento || ""] || { color: "#4b5563", bg: "#f3f4f6" };

                  return (
                    <React.Fragment key={p.id}>
                      <tr className="border-t cursor-pointer hover:brightness-95" style={{ background: rowBg, borderColor: "#f1f5f9" }}
                        onClick={() => setExpandidoId(expandido ? null : p.id)}>
                        <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-white text-sm" style={{ background: p.estado === "activo" ? "#0b315f" : "#9ca3af" }}>{p.nombre.charAt(0)}</div>
                            <div>
                              <p className="font-black text-gray-900">{p.nombre}</p>
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: p.estado === "activo" ? "#dcfce7" : "#f3f4f6", color: p.estado === "activo" ? "#166534" : "#4b5563" }}>{p.estado}</span>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 font-mono text-xs text-gray-600">{p.dni || "—"}</td>
                        <td className="p-3">
                          <p className="font-bold text-xs text-gray-800">{p.cargo || "—"}</p>
                          {p.departamento && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-lg" style={{ background: depCfg.bg, color: depCfg.color }}>{p.departamento}</span>}
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: contrVenc2 ? "#fee2e2" : "#dcfce7", color: contrVenc2 ? "#991b1b" : "#166534" }}>
                            {p.tipo_contrato === "plazo_fijo" ? (contrVenc2 ? "⚠ Vencido" : fmtFecha(p.fecha_venc_contrato)) : TIPOS_CONTRATO.find(t => t.valor === p.tipo_contrato)?.label || "—"}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: sctrEst ? "#fee2e2" : "#dcfce7", color: sctrEst ? "#991b1b" : "#166534" }}>
                            {sctrEst ? "🚨 Vencido" : "✅ OK"}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: examenEst ? "#fee2e2" : "#dcfce7", color: examenEst ? "#991b1b" : "#166534" }}>
                            {examenEst ? "🚨 Vencido" : "✅ OK"}
                          </span>
                        </td>
                        <td className="p-3 text-xs text-gray-600">{calcAntig(p.fecha_ingreso)}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden min-w-[50px]">
                              <div className="h-full rounded-full" style={{ width: `${score}%`, background: scoreColor }} />
                            </div>
                            <span className="text-xs font-black" style={{ color: scoreColor }}>{score}%</span>
                          </div>
                        </td>
                        <td className="p-3" onClick={e => e.stopPropagation()}>
                          <div className="flex gap-1">
                            <button onClick={() => editar(p)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                            <button onClick={() => eliminar(p.id, p.nombre)} className="px-2 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                          </div>
                        </td>
                      </tr>

                      {expandido && (
                        <tr style={{ background: "#f8fafc" }} className="border-t">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Personal</p>
                                <p><span className="text-gray-400">DNI:</span> <span className="font-mono">{p.dni || "—"}</span></p>
                                <p><span className="text-gray-400">Tel:</span> {p.telefono ? <a href={`tel:${p.telefono}`} className="text-[#0b315f] font-bold">{p.telefono}</a> : "—"}</p>
                                <p><span className="text-gray-400">Email:</span> {p.email || "—"}</p>
                                <p><span className="text-gray-400">Edad:</span> {calcEdad(p.fecha_nacimiento) || "—"} años</p>
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Documentos SUNAFIL</p>
                                {p.tipo_contrato === "plazo_fijo" && <BadgeDoc fecha={p.fecha_venc_contrato} diasAlerta={30} label="Contrato" />}
                                <BadgeDoc fecha={p.sctr_salud_venc}     diasAlerta={30} label="SCTR Salud" />
                                <BadgeDoc fecha={p.sctr_pension_venc}   diasAlerta={30} label="SCTR Pensión" />
                                <BadgeDoc fecha={p.examen_medico_venc}  diasAlerta={30} label="Examen médico" />
                                <BadgeDoc fecha={p.antecedentes_venc}   diasAlerta={30} label="Antecedentes" />
                                {p.vida_ley && <BadgeDoc fecha={p.vida_ley_venc} diasAlerta={30} label="Vida Ley" />}
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Laboral</p>
                                <p><span className="text-gray-400">Cargo:</span> {p.cargo || "—"}</p>
                                <p><span className="text-gray-400">Área:</span> {p.departamento || "—"}</p>
                                <p><span className="text-gray-400">Contrato:</span> {TIPOS_CONTRATO.find(t => t.valor === p.tipo_contrato)?.label}</p>
                                <p><span className="text-gray-400">Ingreso:</span> {fmtFecha(p.fecha_ingreso)}</p>
                                <p><span className="text-gray-400">Antigüedad:</span> <b>{calcAntig(p.fecha_ingreso)}</b></p>
                                <p><span className="text-gray-400">Pensión:</span> {p.sistema_pensionario === "afp" ? `AFP ${p.afp_nombre}` : p.sistema_pensionario?.toUpperCase() || "—"}</p>
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Score SUNAFIL</p>
                                <div className="rounded-xl px-3 py-2.5 text-center" style={{ background: scoreColor + "22" }}>
                                  <p className="text-3xl font-black" style={{ color: scoreColor }}>{score}%</p>
                                  <p className="text-[10px] font-bold" style={{ color: scoreColor }}>Cumplimiento</p>
                                </div>
                                {vencidos.length > 0 && <div className="text-[10px] text-red-700 space-y-0.5">{vencidos.map(v => <p key={v}>🚨 {v}</p>)}</div>}
                                {porVencer.length > 0 && <div className="text-[10px] text-amber-700 space-y-0.5">{porVencer.map(v => <p key={v}>⚠️ {v}</p>)}</div>}
                                {p.observaciones && <p className="italic text-gray-500 mt-2">"{p.observaciones}"</p>}
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
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {total} personas · {deptosUnicos.length} departamento{deptosUnicos.length !== 1 ? "s" : ""}</span>
            <span>AFA ERP · RRHH · Cumplimiento SUNAFIL / MTPE</span>
          </div>
        </section>
      )}
    </main>
  );
}