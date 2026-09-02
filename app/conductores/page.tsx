"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Conductor = {
  id: number; nombre: string; dni: string | null;
  licencia: string; categoria_licencia: string | null;
  vencimiento_licencia: string | null;
  fecha_nacimiento: string | null; email: string | null;
  telefono: string | null; direccion: string | null;
  fecha_ingreso: string | null; tipo_contrato: string | null;
  fecha_venc_contrato: string | null;
  sistema_pensionario: string | null; afp_nombre: string | null;
  // Lo que hace falta para calcular su COSTO EMPRESA por día (gratificaciones, CTS,
  // EsSalud y SCTR según el régimen). Sin sueldo, el costeo de un servicio propio no
  // puede imputar el conductor y lo dice en pantalla. Ver lib/costeo-conductor.ts.
  sueldo_basico?: number | null;
  asignacion_familiar?: boolean | null;
  honorario_dia?: number | null;
  essalud_numero: string | null;
  sctr_salud_venc: string | null; sctr_pension_venc: string | null;
  examen_medico_venc: string | null; psicosometrico_venc: string | null;
  antecedentes_venc: string | null;
  vida_ley: boolean | null; vida_ley_venc: string | null;
  foto_url: string | null; estado: string;
  observaciones: string | null; created_at: string;
  pin_acceso?: string | null; activo_app?: boolean | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

// Clasificación oficial MTC — Art. 12 del Reglamento Nacional de Licencias de Conducir.
// Cada categoría habilita también las anteriores (A-IIb maneja lo de A-IIa y A-I, etc.).
const CATEGORIAS_LIC = [
  { valor: "A-I",    desc: "Autos particulares (M1/M2) y carga liviana (N1)" },
  { valor: "A-IIa",  desc: "Taxi, escolar, turístico y colectivo de pasajeros (M1)" },
  { valor: "A-IIb",  desc: "Pasajeros (M2) y mercancías (N2)" },
  { valor: "A-IIIa", desc: "Ómnibus / transporte de pasajeros (M3, +6 t)" },
  { valor: "A-IIIb", desc: "Carga pesada / camiones (N3)" },
  { valor: "A-IIIc", desc: "Pasajeros y carga (M3 + N3)" },
  { valor: "B-I",    desc: "Vehículos no motorizados (3+ ruedas)" },
  { valor: "B-IIb",  desc: "Motocicletas (L3/L4)" },
];

const TIPOS_CONTRATO = [
  { valor: "planilla",     label: "Planilla indefinida" },
  { valor: "plazo_fijo",   label: "Plazo fijo" },
  { valor: "honorarios",   label: "Recibo por honorarios" },
  { valor: "service",      label: "Service / tercero" },
  { valor: "eventual",     label: "Eventual" },
];

const AFP_NOMBRES = ["Integra", "Prima", "Profuturo", "Habitat"];

// Documentos SUNAFIL a controlar
const DOCS_SUNAFIL = [
  { key: "vencimiento_licencia",  label: "Licencia MTC",          icon: "🪪", obligatorio: true,  dias_alerta: 60  },
  { key: "fecha_venc_contrato",   label: "Contrato de trabajo",   icon: "📄", obligatorio: true,  dias_alerta: 30  },
  { key: "sctr_salud_venc",       label: "SCTR Salud",            icon: "🏥", obligatorio: true,  dias_alerta: 30  },
  { key: "sctr_pension_venc",     label: "SCTR Pensión",          icon: "💼", obligatorio: true,  dias_alerta: 30  },
  { key: "examen_medico_venc",    label: "Examen médico ocup.",   icon: "🩺", obligatorio: true,  dias_alerta: 30  },
  { key: "psicosometrico_venc",   label: "Cert. psicosométrico",  icon: "🧠", obligatorio: true,  dias_alerta: 30  },
  { key: "antecedentes_venc",     label: "Antecedentes",          icon: "📋", obligatorio: false, dias_alerta: 30  },
  { key: "vida_ley_venc",         label: "Seg. Vida Ley",         icon: "💛", obligatorio: false, dias_alerta: 30  },
];

const FORM_VACIO = {
  nombre: "", dni: "", licencia: "", categoria_licencia: "A-IIb",
  vencimiento_licencia: "", fecha_nacimiento: "", email: "",
  telefono: "", direccion: "", fecha_ingreso: "",
  tipo_contrato: "planilla", fecha_venc_contrato: "",
  sistema_pensionario: "afp", afp_nombre: "Integra", essalud_numero: "",
  sueldo_basico: "", asignacion_familiar: false, honorario_dia: "",
  sctr_salud_venc: "", sctr_pension_venc: "",
  examen_medico_venc: "", psicosometrico_venc: "", antecedentes_venc: "",
  vida_ley: false, vida_ley_venc: "",
  foto_url: "", estado: "disponible", observaciones: "",
  pin_acceso: "", activo_app: false,
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

// Score de cumplimiento SUNAFIL (0-100)
function calcScore(c: Conductor): { score: number; vencidos: string[]; porVencer: string[] } {
  const vencidos: string[] = []; const porVencer: string[] = [];
  DOCS_SUNAFIL.forEach(d => {
    const val = (c as any)[d.key];
    if (d.key === "vida_ley_venc" && !c.vida_ley) return; // solo si tiene vida ley
    if (d.key === "fecha_venc_contrato" && c.tipo_contrato !== "plazo_fijo") return; // solo si es plazo fijo
    const est = estadoFecha(val, d.dias_alerta);
    if (est === "vencido") vencidos.push(d.label);
    else if (est === "por_vencer") porVencer.push(d.label);
  });
  const total = DOCS_SUNAFIL.filter(d => {
    if (d.key === "vida_ley_venc" && !c.vida_ley) return false;
    if (d.key === "fecha_venc_contrato" && c.tipo_contrato !== "plazo_fijo") return false;
    return true;
  }).length;
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
    <div className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[10px]"
      style={{ background: cfg.bg }}>
      <span className="font-bold" style={{ color: cfg.color }}>{label}</span>
      <span className="font-mono" style={{ color: cfg.color }}>
        {fecha ? (est === "vencido" ? `${Math.abs(dias!)}d venc.` : est === "por_vencer" ? `${dias}d` : fmtFecha(fecha)) : "Sin fecha"}
      </span>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ConductoresPage() {
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [vistaCards,  setVistaCards]  = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [filtroAlerta,setFiltroAlerta]= useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: (e.target as HTMLInputElement).type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const { data, error } = await supabase.from("conductores").select("*").order("nombre");
    if (error) alert(error.message);
    else setConductores(data || []);
    setLoading(false);
  };
  useEffect(() => { cargarDatos(); }, []);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.nombre.trim() || !form.licencia.trim()) { alert("Nombre y licencia son obligatorios"); return; }
    setGuardando(true);
    const payload: any = {
      nombre: form.nombre.trim(), dni: form.dni.trim() || null,
      licencia: form.licencia.trim(), categoria_licencia: form.categoria_licencia || null,
      vencimiento_licencia: form.vencimiento_licencia || null,
      fecha_nacimiento: form.fecha_nacimiento || null,
      email: form.email.trim() || null, telefono: form.telefono.trim() || null,
      direccion: form.direccion.trim() || null, fecha_ingreso: form.fecha_ingreso || null,
      tipo_contrato: form.tipo_contrato || null,
      fecha_venc_contrato: form.tipo_contrato === "plazo_fijo" ? (form.fecha_venc_contrato || null) : null,
      sistema_pensionario: form.sistema_pensionario || null,
      afp_nombre: form.sistema_pensionario === "afp" ? form.afp_nombre : null,
      essalud_numero: form.essalud_numero.trim() || null,
      sueldo_basico: form.sueldo_basico !== "" ? Number(form.sueldo_basico) : null,
      asignacion_familiar: form.asignacion_familiar,
      honorario_dia: form.honorario_dia !== "" ? Number(form.honorario_dia) : null,
      sctr_salud_venc: form.sctr_salud_venc || null,
      sctr_pension_venc: form.sctr_pension_venc || null,
      examen_medico_venc: form.examen_medico_venc || null,
      psicosometrico_venc: form.psicosometrico_venc || null,
      antecedentes_venc: form.antecedentes_venc || null,
      vida_ley: form.vida_ley,
      vida_ley_venc: form.vida_ley ? (form.vida_ley_venc || null) : null,
      foto_url: form.foto_url.trim() || null, estado: form.estado,
      observaciones: form.observaciones.trim() || null,
      pin_acceso: form.pin_acceso.trim() || null,
      activo_app: form.activo_app,
    };
    const { error } = editandoId
      ? await supabase.from("conductores").update(payload).eq("id", editandoId)
      : await supabase.from("conductores").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (c: Conductor) => {
    setForm({
      nombre: c.nombre || "", dni: c.dni || "", licencia: c.licencia || "",
      categoria_licencia: c.categoria_licencia || "A-IIb",
      vencimiento_licencia: c.vencimiento_licencia || "",
      fecha_nacimiento: c.fecha_nacimiento || "", email: c.email || "",
      telefono: c.telefono || "", direccion: c.direccion || "",
      fecha_ingreso: c.fecha_ingreso || "", tipo_contrato: c.tipo_contrato || "planilla",
      fecha_venc_contrato: c.fecha_venc_contrato || "",
      sistema_pensionario: c.sistema_pensionario || "afp",
      afp_nombre: c.afp_nombre || "Integra", essalud_numero: c.essalud_numero || "",
      sueldo_basico: c.sueldo_basico != null ? String(c.sueldo_basico) : "",
      asignacion_familiar: !!c.asignacion_familiar,
      honorario_dia: c.honorario_dia != null ? String(c.honorario_dia) : "",
      sctr_salud_venc: c.sctr_salud_venc || "", sctr_pension_venc: c.sctr_pension_venc || "",
      examen_medico_venc: c.examen_medico_venc || "", psicosometrico_venc: c.psicosometrico_venc || "",
      antecedentes_venc: c.antecedentes_venc || "",
      vida_ley: c.vida_ley || false, vida_ley_venc: c.vida_ley_venc || "",
      foto_url: c.foto_url || "", estado: c.estado || "disponible", observaciones: c.observaciones || "",
      pin_acceso: c.pin_acceso || "", activo_app: c.activo_app || false,
    });
    setEditandoId(c.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar conductor ${nombre}?`)) return;
    await supabase.from("conductores").delete().eq("id", id);
    cargarDatos();
  };

  const toggleEstado = async (c: Conductor) => {
    const nuevo = c.estado === "disponible" ? "no_disponible" : "disponible";
    await supabase.from("conductores").update({ estado: nuevo }).eq("id", c.id);
    setConductores(prev => prev.map(x => x.id === c.id ? { ...x, estado: nuevo } : x));
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const total        = conductores.length;
  const disponibles  = conductores.filter(c => c.estado === "disponible").length;
  const licVencidas  = conductores.filter(c => estadoFecha(c.vencimiento_licencia, 60) === "vencido").length;
  const licPorVencer = conductores.filter(c => estadoFecha(c.vencimiento_licencia, 60) === "por_vencer").length;
  const contratoVenc = conductores.filter(c => c.tipo_contrato === "plazo_fijo" && estadoFecha(c.fecha_venc_contrato, 30) === "vencido").length;
  const sctrVenc     = conductores.filter(c => estadoFecha(c.sctr_salud_venc, 30) === "vencido" || estadoFecha(c.sctr_pension_venc, 30) === "vencido").length;
  const examenVenc   = conductores.filter(c => estadoFecha(c.examen_medico_venc, 30) === "vencido" || estadoFecha(c.psicosometrico_venc, 30) === "vencido").length;

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => conductores.filter(c => {
    const q = busqueda.toLowerCase();
    const txt = `${c.nombre} ${c.dni || ""} ${c.licencia} ${c.categoria_licencia || ""}`.toLowerCase();
    const { score, vencidos } = calcScore(c);
    const alertaMatch =
      filtroAlerta === "todos" ? true :
      filtroAlerta === "critico" ? vencidos.length > 0 :
      filtroAlerta === "ok" ? vencidos.length === 0 : true;
    return txt.includes(q) &&
      (filtroEst === "todos" || c.estado === filtroEst) && alertaMatch;
  }), [conductores, busqueda, filtroEst, filtroAlerta]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Conductores</h1>
          <p className="text-gray-400 text-sm mt-1">Licencias · contratos · SCTR · exámenes médicos · cumplimiento SUNAFIL</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setVistaCards(v => !v)} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            {vistaCards ? "📋 Tabla" : "🪪 Tarjetas"}
          </button>
          <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nuevo conductor"}
          </button>
        </div>
      </div>

      {/* ALERTAS SUNAFIL */}
      {(licVencidas > 0 || contratoVenc > 0 || sctrVenc > 0 || examenVenc > 0) && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-red-800 mb-1">🚨 Riesgo de multa SUNAFIL — documentos vencidos</p>
          {licVencidas  > 0 && <div className="text-xs text-red-700">• <b>{licVencidas}</b> licencia{licVencidas > 1 ? "s" : ""} de conducir vencida{licVencidas > 1 ? "s" : ""} — conductor{licVencidas > 1 ? "es" : ""} NO pueden operar unidades</div>}
          {contratoVenc > 0 && <div className="text-xs text-red-700">• <b>{contratoVenc}</b> contrato{contratoVenc > 1 ? "s" : ""} de plazo fijo vencido{contratoVenc > 1 ? "s" : ""} — riesgo de desnaturalización</div>}
          {sctrVenc     > 0 && <div className="text-xs text-red-700">• <b>{sctrVenc}</b> SCTR vencido{sctrVenc > 1 ? "s" : ""} — multa hasta 20 UIT (S/ 103,000)</div>}
          {examenVenc   > 0 && <div className="text-xs text-red-700">• <b>{examenVenc}</b> examen médico/psicosométrico vencido{examenVenc > 1 ? "s" : ""} — multa hasta 50 UIT</div>}
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: "Total",           valor: total,          color: "#0b315f", bg: "#eef3f8" },
          { label: "Disponibles",     valor: disponibles,    color: "#166534", bg: "#dcfce7" },
          { label: "Lic. vencidas",   valor: licVencidas,    color: licVencidas > 0 ? "#991b1b" : "#166534",    bg: licVencidas > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Lic. por vencer", valor: licPorVencer,   color: licPorVencer > 0 ? "#854d0e" : "#166534",   bg: licPorVencer > 0 ? "#fef9c3" : "#dcfce7" },
          { label: "SCTR vencido",    valor: sctrVenc,       color: sctrVenc > 0 ? "#991b1b" : "#166534",       bg: sctrVenc > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Examen vencido",  valor: examenVenc,     color: examenVenc > 0 ? "#991b1b" : "#166534",     bg: examenVenc > 0 ? "#fee2e2" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold">{editandoId ? "Editar conductor" : "Nuevo conductor"}</h2>

          {/* Datos personales */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos personales</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Nombre completo *" span={2}><input className={inputCls()} placeholder="Juan Pérez Quispe" value={form.nombre} onChange={f("nombre")} /></Campo>
              <Campo label="DNI"><input className={inputCls("font-mono")} placeholder="12345678" maxLength={8} value={form.dni} onChange={f("dni")} /></Campo>
              <Campo label="Fecha de nacimiento"><input type="date" className={inputCls()} value={form.fecha_nacimiento} onChange={f("fecha_nacimiento")} />{form.fecha_nacimiento && <p className="text-[10px] text-gray-400 mt-1">Edad: {calcEdad(form.fecha_nacimiento)} años</p>}</Campo>
              <Campo label="Teléfono"><input className={inputCls()} value={form.telefono} onChange={f("telefono")} /></Campo>
              <Campo label="Email"><input className={inputCls()} value={form.email} onChange={f("email")} /></Campo>
              <Campo label="Dirección" span={3}><input className={inputCls()} value={form.direccion} onChange={f("direccion")} /></Campo>
            </div>
          </div>

          {/* Licencia */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Licencia MTC</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="N° Licencia *"><input className={inputCls("font-mono uppercase")} value={form.licencia} onChange={f("licencia")} /></Campo>
              <Campo label="Categoría MTC">
                <select className={inputCls()} value={form.categoria_licencia} onChange={f("categoria_licencia")}>
                  {CATEGORIAS_LIC.map(c => <option key={c.valor} value={c.valor}>{c.valor} — {c.desc}</option>)}
                </select>
              </Campo>
              <Campo label="Vencimiento licencia">
                <input type="date" className={inputCls(estadoFecha(form.vencimiento_licencia, 60) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.vencimiento_licencia} onChange={f("vencimiento_licencia")} />
                {form.vencimiento_licencia && <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(form.vencimiento_licencia)! < 0 ? "#dc2626" : diasPara(form.vencimiento_licencia)! <= 60 ? "#d97706" : "#166534" }}>
                  {diasPara(form.vencimiento_licencia)! < 0 ? `Vencida hace ${Math.abs(diasPara(form.vencimiento_licencia)!)}d` : `Vence en ${diasPara(form.vencimiento_licencia)}d`}
                </p>}
              </Campo>
            </div>
          </div>

          {/* Contrato */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Contrato laboral</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Fecha de ingreso"><input type="date" className={inputCls()} value={form.fecha_ingreso} onChange={f("fecha_ingreso")} />{form.fecha_ingreso && <p className="text-[10px] text-gray-400 mt-1">Antigüedad: {calcAntig(form.fecha_ingreso)}</p>}</Campo>
              <Campo label="Tipo de contrato">
                <select className={inputCls()} value={form.tipo_contrato} onChange={f("tipo_contrato")}>
                  {TIPOS_CONTRATO.map(t => <option key={t.valor} value={t.valor}>{t.label}</option>)}
                </select>
              </Campo>
              {form.tipo_contrato === "plazo_fijo" && (
                <Campo label="Vencimiento contrato *">
                  <input type="date" className={inputCls(estadoFecha(form.fecha_venc_contrato, 30) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.fecha_venc_contrato} onChange={f("fecha_venc_contrato")} />
                  {form.fecha_venc_contrato && <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(form.fecha_venc_contrato)! < 0 ? "#dc2626" : "#d97706" }}>
                    {diasPara(form.fecha_venc_contrato)! < 0 ? "⚠ Vencido — riesgo desnaturalización" : `Vence en ${diasPara(form.fecha_venc_contrato)}d`}
                  </p>}
                </Campo>
              )}
              <Campo label="Disponibilidad">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="disponible">Disponible</option>
                  <option value="no_disponible">No disponible</option>
                  <option value="de_baja">De baja</option>
                </select>
              </Campo>

              {/* ── Lo que hace falta para costear un servicio ──────────────────
                  El costo de un día de conductor no es el sueldo entre 30: es el
                  COSTO EMPRESA (con gratificaciones, CTS, EsSalud y SCTR según el
                  régimen) dividido entre los días que trabajó de verdad. Sin estos
                  campos, el costeo de un servicio de flota propia no puede imputar
                  el conductor y lo dice en pantalla. */}
              {form.tipo_contrato === "honorarios" ? (
                <Campo label="Honorario por día S/">
                  <input type="number" min="0" step="10" className={inputCls()}
                    value={form.honorario_dia} onChange={f("honorario_dia")} placeholder="0.00" />
                  <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                    Se contrata para el servicio, así que su importe va completo: no se
                    prorratea nada.
                  </p>
                </Campo>
              ) : (
                <>
                  <Campo label="Sueldo básico mensual S/">
                    <input type="number" min="0" step="50" className={inputCls()}
                      value={form.sueldo_basico} onChange={f("sueldo_basico")} placeholder="0.00" />
                    <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                      De aquí sale el costo empresa. El sueldo a secas lo subestima entre
                      24 % y 38 %, según el régimen.
                    </p>
                  </Campo>
                  <Campo label="Asignación familiar">
                    <label className="flex items-center gap-2 text-sm text-gray-700 py-2.5">
                      <input type="checkbox" checked={form.asignacion_familiar}
                        onChange={e => setForm(p => ({ ...p, asignacion_familiar: e.target.checked }))} />
                      Le corresponde (10 % de la RMV)
                    </label>
                    <p className="text-[10px] text-gray-400 leading-snug">
                      Depende de tener hijos menores, no de la empresa. Entra en la base de
                      EsSalud, de la gratificación y de la CTS.
                    </p>
                  </Campo>
                </>
              )}
            </div>
          </div>

          {/* Previsión social */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Previsión social (SUNAT)</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Sistema pensionario">
                <select className={inputCls()} value={form.sistema_pensionario} onChange={f("sistema_pensionario")}>
                  <option value="afp">AFP</option>
                  <option value="onp">ONP (SNP)</option>
                  <option value="ninguno">Sin sistema (honorarios)</option>
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

          {/* Documentos SUNAFIL */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Documentos SUNAFIL / Seguridad y Salud</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="🏥 SCTR Salud — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.sctr_salud_venc, 30) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.sctr_salud_venc} onChange={f("sctr_salud_venc")} />
              </Campo>
              <Campo label="💼 SCTR Pensión — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.sctr_pension_venc, 30) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.sctr_pension_venc} onChange={f("sctr_pension_venc")} />
              </Campo>
              <Campo label="🩺 Examen médico ocup. — vencimiento">
                <input type="date" className={inputCls(estadoFecha(form.examen_medico_venc, 30) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.examen_medico_venc} onChange={f("examen_medico_venc")} />
              </Campo>
              <Campo label="🧠 Psicosométrico — vencimiento (conductor)">
                <input type="date" className={inputCls(estadoFecha(form.psicosometrico_venc, 30) === "vencido" ? "border-red-400 bg-red-50" : "")} value={form.psicosometrico_venc} onChange={f("psicosometrico_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Obligatorio cada 2 años — MTC</p>
              </Campo>
              <Campo label="📋 Antecedentes — vencimiento">
                <input type="date" className={inputCls()} value={form.antecedentes_venc} onChange={f("antecedentes_venc")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Penales + policiales + judiciales</p>
              </Campo>
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={form.vida_ley} onChange={f("vida_ley")} />
                  <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">💛 Seguro Vida Ley</span>
                </label>
                {form.vida_ley && <input type="date" className={inputCls()} placeholder="Vencimiento póliza" value={form.vida_ley_venc} onChange={f("vida_ley_venc")} />}
                <p className="text-[10px] text-gray-400 mt-0.5">Obligatorio desde 4 años de antigüedad (D.L. 688)</p>
              </div>
            </div>
          </div>

          {/* Acceso app conductor */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Acceso app conductor</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="PIN de acceso (4 dígitos)">
                <input className={inputCls("font-mono")} type="text" inputMode="numeric" maxLength={4}
                  placeholder="Ej: 1234" value={form.pin_acceso} onChange={f("pin_acceso")} />
                <p className="text-[10px] text-gray-400 mt-0.5">Déjalo vacío para no modificar el PIN actual</p>
              </Campo>
              <div className="flex items-center gap-3 pt-5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={form.activo_app}
                    onChange={e => setForm(p => ({ ...p, activo_app: e.target.checked }))} />
                  <span className="text-sm font-semibold text-gray-700">Activo en app conductor</span>
                </label>
              </div>
            </div>
          </div>

          <Campo label="Observaciones / notas internas" span={3}>
            <input className={inputCls()} value={form.observaciones} onChange={f("observaciones")} />
          </Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar conductor"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar nombre, DNI, licencia..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos</option>
          <option value="disponible">✅ Disponibles</option>
          <option value="no_disponible">⛔ No disponibles</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroAlerta} onChange={e => setFiltroAlerta(e.target.value)}>
          <option value="todos">Todas las alertas</option>
          <option value="critico">🚨 Con docs vencidos</option>
          <option value="ok">✅ Sin alertas</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}</div>
      </section>

      {/* ── TARJETAS ── */}
      {vistaCards && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {loading ? <div className="col-span-3 p-10 text-center text-gray-400">Cargando...</div>
            : filtrados.map(c => {
              const { score, vencidos, porVencer } = calcScore(c);
              const scoreColor = vencidos.length > 0 ? "#dc2626" : porVencer.length > 0 ? "#d97706" : "#16a34a";
              const borderColor = vencidos.length > 0 ? "#fca5a5" : porVencer.length > 0 ? "#fde68a" : "#e5e7eb";
              return (
                <div key={c.id} className="bg-white rounded-2xl border-2 shadow-sm p-5 space-y-3 hover:shadow-md transition-all" style={{ borderColor }}>
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-full flex items-center justify-center font-black text-white text-lg flex-shrink-0" style={{ background: c.estado === "disponible" ? "#0b315f" : "#9ca3af" }}>
                        {c.nombre.charAt(0)}
                      </div>
                      <div>
                        <p className="font-black text-gray-900">{c.nombre}</p>
                        {c.dni && <p className="text-xs text-gray-400 font-mono">DNI: {c.dni}</p>}
                        {c.fecha_nacimiento && <p className="text-xs text-gray-400">{calcEdad(c.fecha_nacimiento)} años</p>}
                      </div>
                    </div>
                    {/* Score SUNAFIL */}
                    <div className="text-right flex-shrink-0">
                      <div className="text-[10px] font-bold uppercase" style={{ color: scoreColor }}>SUNAFIL</div>
                      <div className="text-2xl font-black" style={{ color: scoreColor }}>{score}%</div>
                    </div>
                  </div>

                  {/* Licencia */}
                  <div className="rounded-xl px-3 py-2 space-y-1" style={{ background: "#f8fafc" }}>
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-[10px] font-bold uppercase text-gray-400">Licencia</p>
                        <p className="font-mono font-black text-gray-800">{c.licencia}</p>
                        {c.categoria_licencia && <p className="text-[10px] text-gray-500">Cat. <b>{c.categoria_licencia}</b></p>}
                      </div>
                      <BadgeDoc fecha={c.vencimiento_licencia} diasAlerta={60} label="" />
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

                  {/* Datos */}
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    {c.telefono && <div><p className="text-gray-400">Tel</p><a href={`tel:${c.telefono}`} className="font-bold text-[#0b315f]">{c.telefono}</a></div>}
                    <div><p className="text-gray-400">Contrato</p><p className="font-bold text-gray-700">{TIPOS_CONTRATO.find(t => t.valor === c.tipo_contrato)?.label || "—"}</p></div>
                    <div><p className="text-gray-400">Antigüedad</p><p className="font-bold text-gray-700">{calcAntig(c.fecha_ingreso)}</p></div>
                    {c.sistema_pensionario && <div><p className="text-gray-400">Pensión</p><p className="font-bold text-gray-700">{c.sistema_pensionario === "afp" ? `AFP ${c.afp_nombre}` : c.sistema_pensionario.toUpperCase()}</p></div>}
                  </div>

                  <div className="flex gap-2 pt-1 border-t" style={{ borderColor: "#f1f5f9" }}>
                    <button onClick={() => toggleEstado(c)} className="text-[10px] font-bold px-2.5 py-1 rounded-lg" style={{ background: c.estado === "disponible" ? "#dcfce7" : "#f3f4f6", color: c.estado === "disponible" ? "#166534" : "#4b5563" }}>{c.estado === "disponible" ? "✅ Disponible" : "⛔ No disp."}</button>
                    <button onClick={() => editar(c)} className="flex-1 py-1.5 rounded-xl text-[10px] font-bold border hover:bg-gray-50 text-gray-700">✏️ Editar</button>
                    <button onClick={() => eliminar(c.id, c.nombre)} className="px-2.5 py-1.5 rounded-xl text-[10px] font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
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
                  {["Conductor", "DNI", "Licencia", "Venc. Lic.", "Contrato", "SCTR", "Examen Méd.", "SUNAFIL %", "Estado", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                  </td></tr>
                ) : filtrados.length === 0 ? (
                  <tr><td colSpan={11} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">🧑‍✈️</p><p>Sin conductores</p></td></tr>
                ) : filtrados.map(c => {
                  const { score, vencidos } = calcScore(c);
                  const expandido = expandidoId === c.id;
                  const scoreColor = vencidos.length > 0 ? "#dc2626" : score >= 80 ? "#16a34a" : "#d97706";
                  const rowBg = vencidos.length > 0 ? "#fff5f5" : "white";
                  const licEst = estadoFecha(c.vencimiento_licencia, 60);
                  const sctrEst = estadoFecha(c.sctr_salud_venc, 30) === "vencido" || estadoFecha(c.sctr_pension_venc, 30) === "vencido";
                  const examenEst = estadoFecha(c.examen_medico_venc, 30) === "vencido" || estadoFecha(c.psicosometrico_venc, 30) === "vencido";
                  const contrVenc = c.tipo_contrato === "plazo_fijo" && estadoFecha(c.fecha_venc_contrato, 30) === "vencido";

                  return (
                    <React.Fragment key={c.id}>
                      <tr className="border-t cursor-pointer hover:brightness-95" style={{ background: rowBg, borderColor: "#f1f5f9" }}
                        onClick={() => setExpandidoId(expandido ? null : c.id)}>
                        <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-white text-sm flex-shrink-0" style={{ background: c.estado === "disponible" ? "#0b315f" : "#9ca3af" }}>{c.nombre.charAt(0)}</div>
                            <div><p className="font-black text-gray-900">{c.nombre}</p><p className="text-[10px] text-gray-400">{calcAntig(c.fecha_ingreso)}</p></div>
                          </div>
                        </td>
                        <td className="p-3 font-mono text-xs text-gray-600">{c.dni || "—"}</td>
                        <td className="p-3">
                          <p className="font-mono font-bold text-xs">{c.licencia}</p>
                          {c.categoria_licencia && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{c.categoria_licencia}</span>}
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                            style={{ background: licEst === "vencido" ? "#fee2e2" : licEst === "por_vencer" ? "#fef9c3" : "#dcfce7", color: licEst === "vencido" ? "#991b1b" : licEst === "por_vencer" ? "#854d0e" : "#166534" }}>
                            {licEst === "vencido" ? `${Math.abs(diasPara(c.vencimiento_licencia)!)}d venc.` : licEst === "por_vencer" ? `${diasPara(c.vencimiento_licencia)}d` : "Vigente"}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: contrVenc ? "#fee2e2" : "#dcfce7", color: contrVenc ? "#991b1b" : "#166534" }}>
                            {c.tipo_contrato === "plazo_fijo" ? (contrVenc ? "⚠ Vencido" : fmtFecha(c.fecha_venc_contrato)) : TIPOS_CONTRATO.find(t => t.valor === c.tipo_contrato)?.label || "—"}
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
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden min-w-[50px]">
                              <div className="h-full rounded-full" style={{ width: `${score}%`, background: scoreColor }} />
                            </div>
                            <span className="text-xs font-black" style={{ color: scoreColor }}>{score}%</span>
                          </div>
                        </td>
                        <td className="p-3" onClick={e => e.stopPropagation()}>
                          <button onClick={() => toggleEstado(c)} className="text-[10px] font-bold px-2 py-1 rounded-lg"
                            style={{ background: c.estado === "disponible" ? "#dcfce7" : "#f3f4f6", color: c.estado === "disponible" ? "#166534" : "#4b5563" }}>
                            {c.estado === "disponible" ? "✅ Disp." : "⛔ No disp."}
                          </button>
                        </td>
                        <td className="p-3" onClick={e => e.stopPropagation()}>
                          <div className="flex gap-1">
                            <button onClick={() => editar(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                            <button onClick={() => eliminar(c.id, c.nombre)} className="px-2 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                          </div>
                        </td>
                      </tr>

                      {expandido && (
                        <tr style={{ background: "#f8fafc" }} className="border-t">
                          <td colSpan={11} className="px-6 py-4">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Personal</p>
                                <p><span className="text-gray-400">DNI:</span> <span className="font-mono">{c.dni || "—"}</span></p>
                                <p><span className="text-gray-400">Tel:</span> {c.telefono ? <a href={`tel:${c.telefono}`} className="text-[#0b315f] font-bold">{c.telefono}</a> : "—"}</p>
                                <p><span className="text-gray-400">Email:</span> {c.email || "—"}</p>
                                <p><span className="text-gray-400">Edad:</span> {calcEdad(c.fecha_nacimiento)} años</p>
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Documentos SUNAFIL</p>
                                <BadgeDoc fecha={c.vencimiento_licencia}   diasAlerta={60} label="Licencia" />
                                <BadgeDoc fecha={c.sctr_salud_venc}        diasAlerta={30} label="SCTR Salud" />
                                <BadgeDoc fecha={c.sctr_pension_venc}      diasAlerta={30} label="SCTR Pensión" />
                                <BadgeDoc fecha={c.examen_medico_venc}     diasAlerta={30} label="Examen médico" />
                                <BadgeDoc fecha={c.psicosometrico_venc}    diasAlerta={30} label="Psicosométrico" />
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Laboral</p>
                                <p><span className="text-gray-400">Contrato:</span> {TIPOS_CONTRATO.find(t => t.valor === c.tipo_contrato)?.label}</p>
                                {c.tipo_contrato === "plazo_fijo" && <BadgeDoc fecha={c.fecha_venc_contrato} diasAlerta={30} label="Venc. contrato" />}
                                <p><span className="text-gray-400">Ingreso:</span> {fmtFecha(c.fecha_ingreso)}</p>
                                <p><span className="text-gray-400">Antigüedad:</span> <b>{calcAntig(c.fecha_ingreso)}</b></p>
                                <p><span className="text-gray-400">Pensión:</span> {c.sistema_pensionario === "afp" ? `AFP ${c.afp_nombre}` : c.sistema_pensionario?.toUpperCase() || "—"}</p>
                                <BadgeDoc fecha={c.antecedentes_venc} diasAlerta={30} label="Antecedentes" />
                                {c.vida_ley && <BadgeDoc fecha={c.vida_ley_venc} diasAlerta={30} label="Vida Ley" />}
                              </div>
                              <div className="space-y-1.5">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Cumplimiento</p>
                                <div className="rounded-xl px-3 py-2.5 text-center" style={{ background: scoreColor + "22" }}>
                                  <p className="text-3xl font-black" style={{ color: scoreColor }}>{score}%</p>
                                  <p className="text-[10px] font-bold" style={{ color: scoreColor }}>Score SUNAFIL</p>
                                </div>
                                {c.observaciones && <p className="italic text-gray-500 mt-2">"{c.observaciones}"</p>}
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
            <span>{filtrados.length} de {total} conductores</span>
            <span>AFA ERP · RRHH · Cumplimiento SUNAFIL</span>
          </div>
        </section>
      )}
    </main>
  );
}