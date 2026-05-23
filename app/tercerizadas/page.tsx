"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Empresa = {
  id: number; razon_social: string; ruc: string | null;
  telefono: string | null; email: string | null;
  contacto_nombre: string | null; contacto_telefono: string | null;
  autorizacion_mtc: string | null; habilitacion_sutran: string | null;
  venc_autorizacion: string | null; venc_habilitacion: string | null;
  estado: string; observaciones: string | null; created_at: string;
};

type VehiculoTercero = {
  id: number; empresa_id: number; placa: string;
  categoria: string | null; marca: string | null; modelo: string | null;
  capacidad: number | null; estado: string;
};

type ConductorTercero = {
  id: number; empresa_id: number; nombre: string; dni: string | null;
  licencia: string | null; categoria_licencia: string | null;
  vencimiento_licencia: string | null; telefono: string | null;
  estado: string; pin_acceso: string | null; activo_app: boolean | null;
};

type DocumentoTercero = {
  id: number; empresa_id: number; vehiculo_id: number | null;
  tipo: string; numero: string | null;
  fecha_vencimiento: string | null; entidad_emisora: string | null;
  archivo_url: string | null; observaciones: string | null;
};

type TabActiva = "flota" | "conductores" | "documentos";

// ─── TIPOS DOC ────────────────────────────────────────────────────────────────

const TIPOS_DOC_TERCERO: Record<string, { icon: string; obligatorio: boolean }> = {
  "SOAT":                     { icon: "🚗", obligatorio: true  },
  "Revisión Técnica (CITV)":  { icon: "🔍", obligatorio: true  },
  "Habilitación SUTRAN":      { icon: "✅", obligatorio: true  },
  "Permiso Operación MTC":    { icon: "🏛️", obligatorio: true  },
  "Tarjeta de Propiedad":     { icon: "📋", obligatorio: true  },
  "SCTR Salud":               { icon: "🏥", obligatorio: true  },
  "SCTR Pensión":             { icon: "💼", obligatorio: true  },
  "Seguro Todo Riesgo":       { icon: "🛡️", obligatorio: false },
  "Responsabilidad Civil":    { icon: "⚖️", obligatorio: false },
  "Otro":                     { icon: "📄", obligatorio: false },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoDoc(f: string | null): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0)    return "vencido";
  if (d <= 30)  return "por_vencer";
  return "vigente";
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
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

const ESTADO_DOC_CFG = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563", dot: "#9ca3af" },
};

// Calcula si la empresa tiene problemas documentales críticos
function calcRiesgo(docs: DocumentoTercero[], conductores: ConductorTercero[]): "alto" | "medio" | "ok" {
  const docVencidos = docs.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido" &&
    TIPOS_DOC_TERCERO[d.tipo]?.obligatorio).length;
  const licVencidas = conductores.filter(c => {
    const d = diasPara(c.vencimiento_licencia);
    return d !== null && d < 0;
  }).length;
  if (docVencidos > 0 || licVencidas > 0) return "alto";
  const docPorV = docs.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer" &&
    TIPOS_DOC_TERCERO[d.tipo]?.obligatorio).length;
  if (docPorV > 0) return "medio";
  return "ok";
}

const FORM_EMP = {
  razon_social: "", ruc: "", telefono: "", email: "",
  contacto_nombre: "", contacto_telefono: "",
  autorizacion_mtc: "", habilitacion_sutran: "",
  venc_autorizacion: "", venc_habilitacion: "",
  estado: "activo", observaciones: "",
};
const FORM_VEH = { placa: "", categoria: "BUS", marca: "", modelo: "", capacidad: "", estado: "disponible" };
const FORM_COND = { nombre: "", dni: "", licencia: "", categoria_licencia: "A-IIb", vencimiento_licencia: "", telefono: "", estado: "disponible", pin_acceso: "", activo_app: false };
const FORM_DOC = { vehiculo_id: "", tipo: "SOAT", numero: "", fecha_vencimiento: "", entidad_emisora: "", archivo_url: "", observaciones: "" };

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function EmpresasTercerizadasPage() {
  const [empresas,    setEmpresas]    = useState<Empresa[]>([]);
  const [vehiculos,   setVehiculos]   = useState<VehiculoTercero[]>([]);
  const [conductores, setConductores] = useState<ConductorTercero[]>([]);
  const [documentos,  setDocumentos]  = useState<DocumentoTercero[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [empresaSel,  setEmpresaSel]  = useState<number | null>(null);
  const [tabActiva,   setTabActiva]   = useState<TabActiva>("flota");
  const [mostrarFormEmp,  setMostrarFormEmp]  = useState(false);
  const [mostrarFormVeh,  setMostrarFormVeh]  = useState(false);
  const [mostrarFormCond, setMostrarFormCond] = useState(false);
  const [mostrarFormDoc,  setMostrarFormDoc]  = useState(false);
  const [editEmpId,   setEditEmpId]   = useState<number | null>(null);
  const [editVehId,   setEditVehId]   = useState<number | null>(null);
  const [editCondId,  setEditCondId]  = useState<number | null>(null);
  const [editDocId,   setEditDocId]   = useState<number | null>(null);
  const [formEmp,  setFormEmp]  = useState(FORM_EMP);
  const [formVeh,  setFormVeh]  = useState(FORM_VEH);
  const [formCond, setFormCond] = useState(FORM_COND);
  const [formDoc,  setFormDoc]  = useState(FORM_DOC);

  const fe = (k: keyof typeof FORM_EMP) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormEmp(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarTodo = async () => {
    setLoading(true);
    const [eRes, vRes, cRes, dRes] = await Promise.all([
      supabase.from("empresas_tercerizadas").select("*").order("razon_social"),
      supabase.from("vehiculos_tercero").select("*").order("placa"),
      supabase.from("conductores_tercero").select("*").order("nombre"),
      supabase.from("documentos_tercero").select("*").order("fecha_vencimiento"),
    ]);
    setEmpresas(eRes.data   || []);
    setVehiculos(vRes.data  || []);
    setConductores(cRes.data|| []);
    setDocumentos(dRes.data || []);
    if (!empresaSel && (eRes.data || []).length > 0) setEmpresaSel((eRes.data || [])[0].id);
    setLoading(false);
  };

  useEffect(() => { cargarTodo(); }, []);

  const empActual   = empresas.find(e => e.id === empresaSel);
  const vehEmpresa  = vehiculos.filter(v => v.empresa_id === empresaSel);
  const condEmpresa = conductores.filter(c => c.empresa_id === empresaSel);
  const docEmpresa  = documentos.filter(d => d.empresa_id === empresaSel);

  // ── KPIs globales ─────────────────────────────────────────────────────────

  const totalEmpresas = empresas.length;
  const totalAlerta   = empresas.filter(e => {
    const docs  = documentos.filter(d => d.empresa_id === e.id);
    const conds = conductores.filter(c => c.empresa_id === e.id);
    return calcRiesgo(docs, conds) === "alto";
  }).length;
  const totalFlota    = vehiculos.length;

  // ── Alertas empresa seleccionada ──────────────────────────────────────────

  const riesgoEmp = empActual ? calcRiesgo(docEmpresa, condEmpresa) : "ok";
  const docsVencOblig  = docEmpresa.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido" && TIPOS_DOC_TERCERO[d.tipo]?.obligatorio);
  const docsPorVOblig  = docEmpresa.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer" && TIPOS_DOC_TERCERO[d.tipo]?.obligatorio);
  const licVencidas    = condEmpresa.filter(c => diasPara(c.vencimiento_licencia) !== null && diasPara(c.vencimiento_licencia)! < 0);

  // ── CRUD Empresa ──────────────────────────────────────────────────────────

  const guardarEmpresa = async () => {
    if (!formEmp.razon_social.trim()) { alert("Razón social obligatoria"); return; }
    setGuardando(true);
    const payload = {
      razon_social: formEmp.razon_social.trim(),
      ruc: formEmp.ruc.trim() || null,
      telefono: formEmp.telefono.trim() || null,
      email: formEmp.email.trim() || null,
      contacto_nombre: formEmp.contacto_nombre.trim() || null,
      contacto_telefono: formEmp.contacto_telefono.trim() || null,
      autorizacion_mtc: formEmp.autorizacion_mtc.trim() || null,
      habilitacion_sutran: formEmp.habilitacion_sutran.trim() || null,
      venc_autorizacion: formEmp.venc_autorizacion || null,
      venc_habilitacion: formEmp.venc_habilitacion || null,
      estado: formEmp.estado,
      observaciones: formEmp.observaciones.trim() || null,
    };
    const { error } = editEmpId
      ? await supabase.from("empresas_tercerizadas").update(payload).eq("id", editEmpId)
      : await supabase.from("empresas_tercerizadas").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(false);
    cargarTodo(); setGuardando(false);
  };

  const editarEmpresa = (e: Empresa) => {
    setFormEmp({
      razon_social: e.razon_social || "", ruc: e.ruc || "",
      telefono: e.telefono || "", email: e.email || "",
      contacto_nombre: e.contacto_nombre || "",
      contacto_telefono: e.contacto_telefono || "",
      autorizacion_mtc: e.autorizacion_mtc || "",
      habilitacion_sutran: e.habilitacion_sutran || "",
      venc_autorizacion: e.venc_autorizacion || "",
      venc_habilitacion: e.venc_habilitacion || "",
      estado: e.estado || "activo", observaciones: e.observaciones || "",
    });
    setEditEmpId(e.id); setMostrarFormEmp(true);
  };

  const eliminarEmpresa = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar "${nombre}" y todos sus datos?`)) return;
    await supabase.from("empresas_tercerizadas").delete().eq("id", id);
    if (empresaSel === id) setEmpresaSel(null);
    cargarTodo();
  };

  // ── CRUD Vehículo tercero ─────────────────────────────────────────────────

  const guardarVehiculo = async () => {
    if (!formVeh.placa.trim() || !empresaSel) { alert("Placa obligatoria"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      placa: formVeh.placa.trim().toUpperCase(),
      categoria: formVeh.categoria || null,
      marca: formVeh.marca.trim() || null,
      modelo: formVeh.modelo.trim() || null,
      capacidad: formVeh.capacidad ? Number(formVeh.capacidad) : null,
      estado: formVeh.estado,
    };
    const { error } = editVehId
      ? await supabase.from("vehiculos_tercero").update(payload).eq("id", editVehId)
      : await supabase.from("vehiculos_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(false);
    cargarTodo(); setGuardando(false);
  };

  // ── CRUD Conductor tercero ────────────────────────────────────────────────

  const guardarConductor = async () => {
    if (!formCond.nombre.trim() || !empresaSel) { alert("Nombre obligatorio"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      nombre: formCond.nombre.trim(),
      dni: formCond.dni.trim() || null,
      licencia: formCond.licencia.trim() || null,
      categoria_licencia: formCond.categoria_licencia || null,
      vencimiento_licencia: formCond.vencimiento_licencia || null,
      telefono: formCond.telefono.trim() || null,
      estado: formCond.estado,
      pin_acceso: formCond.pin_acceso.trim() || null,
      activo_app: formCond.activo_app,
    };
    const { error } = editCondId
      ? await supabase.from("conductores_tercero").update(payload).eq("id", editCondId)
      : await supabase.from("conductores_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(false);
    cargarTodo(); setGuardando(false);
  };

  // ── CRUD Documento tercero ────────────────────────────────────────────────

  const guardarDocumento = async () => {
    if (!formDoc.tipo || !empresaSel) { alert("Tipo obligatorio"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      vehiculo_id: formDoc.vehiculo_id ? Number(formDoc.vehiculo_id) : null,
      tipo: formDoc.tipo,
      numero: formDoc.numero.trim() || null,
      fecha_vencimiento: formDoc.fecha_vencimiento || null,
      entidad_emisora: formDoc.entidad_emisora.trim() || null,
      archivo_url: formDoc.archivo_url.trim() || null,
      observaciones: formDoc.observaciones.trim() || null,
    };
    const { error } = editDocId
      ? await supabase.from("documentos_tercero").update(payload).eq("id", editDocId)
      : await supabase.from("documentos_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(false);
    cargarTodo(); setGuardando(false);
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Empresas Tercerizadas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Flota externa · conductores · documentos · control de vencimientos para proteger tus servicios
          </p>
        </div>
        <button onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarFormEmp ? "#6b7280" : "#0b315f" }}>
          {mostrarFormEmp ? "✕ Cancelar" : "+ Nueva empresa"}
        </button>
      </div>

      {/* KPIs globales */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Empresas",         valor: totalEmpresas, color: "#0b315f", bg: "#eef3f8" },
          { label: "Con alertas",      valor: totalAlerta,   color: totalAlerta > 0 ? "#991b1b" : "#166534", bg: totalAlerta > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Vehículos totales",valor: totalFlota,    color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Conductores",      valor: conductores.length, color: "#6d28d9", bg: "#ede9fe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORM EMPRESA */}
      {mostrarFormEmp && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-900">{editEmpId ? "Editar empresa tercerizada" : "Nueva empresa tercerizada"}</h2>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la empresa</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Razón social *" span={2}><input className={inputCls()} placeholder="Transportes XYZ SAC" value={formEmp.razon_social} onChange={fe("razon_social")} /></Campo>
              <Campo label="RUC"><input className={inputCls("font-mono")} placeholder="20123456789" value={formEmp.ruc} onChange={fe("ruc")} /></Campo>
              <Campo label="Teléfono"><input className={inputCls()} value={formEmp.telefono} onChange={fe("telefono")} /></Campo>
              <Campo label="Email"><input className={inputCls()} value={formEmp.email} onChange={fe("email")} /></Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={formEmp.estado} onChange={fe("estado")}>
                  <option value="activo">Activo</option>
                  <option value="inactivo">Inactivo</option>
                  <option value="suspendido">Suspendido</option>
                </select>
              </Campo>
              <Campo label="Contacto principal"><input className={inputCls()} value={formEmp.contacto_nombre} onChange={fe("contacto_nombre")} /></Campo>
              <Campo label="Teléfono contacto"><input className={inputCls()} value={formEmp.contacto_telefono} onChange={fe("contacto_telefono")} /></Campo>
            </div>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Habilitaciones legales</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Campo label="N° Autorización MTC">
                <input className={inputCls("font-mono")} placeholder="Ej: MTC-001-2024" value={formEmp.autorizacion_mtc} onChange={fe("autorizacion_mtc")} />
              </Campo>
              <Campo label="Vencimiento autorización MTC">
                <input type="date" className={inputCls()} value={formEmp.venc_autorizacion} onChange={fe("venc_autorizacion")} />
                {formEmp.venc_autorizacion && (
                  <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(formEmp.venc_autorizacion) !== null && diasPara(formEmp.venc_autorizacion)! <= 0 ? "#dc2626" : "#166534" }}>
                    {diasPara(formEmp.venc_autorizacion) !== null && diasPara(formEmp.venc_autorizacion)! <= 0 ? "⚠ Vencida" : `Vence en ${diasPara(formEmp.venc_autorizacion)} días`}
                  </p>
                )}
              </Campo>
              <Campo label="N° Habilitación SUTRAN">
                <input className={inputCls("font-mono")} placeholder="Ej: SUTRAN-001-2024" value={formEmp.habilitacion_sutran} onChange={fe("habilitacion_sutran")} />
              </Campo>
              <Campo label="Vencimiento habilitación SUTRAN">
                <input type="date" className={inputCls()} value={formEmp.venc_habilitacion} onChange={fe("venc_habilitacion")} />
                {formEmp.venc_habilitacion && (
                  <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(formEmp.venc_habilitacion) !== null && diasPara(formEmp.venc_habilitacion)! <= 0 ? "#dc2626" : "#166534" }}>
                    {diasPara(formEmp.venc_habilitacion) !== null && diasPara(formEmp.venc_habilitacion)! <= 0 ? "⚠ Vencida" : `Vence en ${diasPara(formEmp.venc_habilitacion)} días`}
                  </p>
                )}
              </Campo>
            </div>
          </div>
          <Campo label="Observaciones"><input className={inputCls()} value={formEmp.observaciones} onChange={fe("observaciones")} /></Campo>
          <div className="flex gap-3">
            <button onClick={guardarEmpresa} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editEmpId ? "Actualizar" : "Guardar empresa"}
            </button>
            <button onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* LAYOUT PRINCIPAL: lista empresas + detalle */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">

        {/* Lista de empresas */}
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 px-1">Empresas ({empresas.length})</p>
          {loading ? (
            <div className="p-6 text-center text-gray-400 bg-white rounded-2xl border">Cargando...</div>
          ) : empresas.length === 0 ? (
            <div className="p-6 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-2xl mb-1">🚌</p>
              <p className="text-xs">Sin empresas registradas</p>
            </div>
          ) : empresas.map(e => {
            const docs   = documentos.filter(d => d.empresa_id === e.id);
            const conds  = conductores.filter(c => c.empresa_id === e.id);
            const vehs   = vehiculos.filter(v => v.empresa_id === e.id);
            const riesgo = calcRiesgo(docs, conds);
            const activa = empresaSel === e.id;
            return (
              <div key={e.id}
                className="bg-white rounded-2xl border-2 p-3 cursor-pointer transition-all hover:shadow-sm"
                style={{ borderColor: activa ? "#0b315f" : riesgo === "alto" ? "#fca5a5" : riesgo === "medio" ? "#fde68a" : "#e5e7eb" }}
                onClick={() => setEmpresaSel(e.id)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-black text-sm text-gray-900 truncate">{e.razon_social}</p>
                    <p className="text-[10px] text-gray-400 font-mono">{e.ruc || "Sin RUC"}</p>
                  </div>
                  <div className="flex-shrink-0">
                    {riesgo === "alto"  && <span className="text-sm">🚨</span>}
                    {riesgo === "medio" && <span className="text-sm">⚠️</span>}
                    {riesgo === "ok"    && <span className="text-sm">✅</span>}
                  </div>
                </div>
                <div className="flex gap-2 mt-2 text-[10px] text-gray-500">
                  <span>🚌 {vehs.length} veh.</span>
                  <span>👤 {conds.length} cond.</span>
                  <span>📄 {docs.length} docs</span>
                </div>
                {activa && (
                  <div className="flex gap-1 mt-2">
                    <button onClick={e2 => { e2.stopPropagation(); editarEmpresa(e); setMostrarFormEmp(true); }}
                      className="text-[10px] font-bold text-[#0b315f] hover:underline">✏️ Editar</button>
                    <span className="text-gray-300">·</span>
                    <button onClick={e2 => { e2.stopPropagation(); eliminarEmpresa(e.id, e.razon_social); }}
                      className="text-[10px] font-bold text-red-500 hover:underline">✕ Eliminar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Detalle empresa seleccionada */}
        <div className="xl:col-span-3 space-y-4">
          {!empActual ? (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">🚌</p>
              <p className="font-medium">Selecciona una empresa para ver su detalle</p>
            </div>
          ) : (
            <>
              {/* Header empresa */}
              <div className="bg-white rounded-2xl border shadow-sm p-5">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div>
                    <h2 className="text-xl font-black text-gray-900">{empActual.razon_social}</h2>
                    <p className="text-xs text-gray-400 mt-1">
                      {empActual.ruc && <span className="font-mono mr-3">RUC: {empActual.ruc}</span>}
                      {empActual.telefono && <span className="mr-3">📱 {empActual.telefono}</span>}
                      {empActual.email && <span>✉️ {empActual.email}</span>}
                    </p>
                    {empActual.contacto_nombre && (
                      <p className="text-xs text-gray-500 mt-1">Contacto: <b>{empActual.contacto_nombre}</b>{empActual.contacto_telefono && ` · ${empActual.contacto_telefono}`}</p>
                    )}
                  </div>
                  <span className="text-xs font-bold px-3 py-1 rounded-lg"
                    style={{ background: empActual.estado === "activo" ? "#dcfce7" : "#fee2e2", color: empActual.estado === "activo" ? "#166634" : "#991b1b" }}>
                    {empActual.estado.charAt(0).toUpperCase() + empActual.estado.slice(1)}
                  </span>
                </div>

                {/* Habilitaciones */}
                <div className="grid grid-cols-2 gap-3 mt-4">
                  {[
                    { label: "Autorización MTC", num: empActual.autorizacion_mtc, venc: empActual.venc_autorizacion },
                    { label: "Habilitación SUTRAN", num: empActual.habilitacion_sutran, venc: empActual.venc_habilitacion },
                  ].map(h => {
                    const est = estadoDoc(h.venc);
                    const cfg = ESTADO_DOC_CFG[est];
                    return (
                      <div key={h.label} className="rounded-xl px-3 py-2.5 border" style={{ background: cfg.bg + "44" }}>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{h.label}</p>
                        <p className="font-mono font-bold text-sm text-gray-800">{h.num || "—"}</p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                          <span className="text-[10px] font-bold" style={{ color: cfg.color }}>
                            {h.venc ? `${cfg.label} · ${fmtFecha(h.venc)}` : "Sin fecha"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Alertas empresa */}
                {riesgoEmp === "alto" && (
                  <div className="mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800 space-y-1">
                    <p className="font-black">🚨 RIESGO ALTO — No asignar a servicios hasta resolver:</p>
                    {docsVencOblig.map(d => <p key={d.id}>· Doc. vencido: <b>{d.tipo}</b></p>)}
                    {licVencidas.map(c => <p key={c.id}>· Licencia vencida: <b>{c.nombre}</b></p>)}
                  </div>
                )}
                {riesgoEmp === "medio" && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    ⚠️ {docsPorVOblig.length} documento{docsPorVOblig.length > 1 ? "s" : ""} obligatorio{docsPorVOblig.length > 1 ? "s" : ""} por vencer — renovar antes de asignar
                  </div>
                )}
              </div>

              {/* PESTAÑAS */}
              <div className="flex gap-1 border-b bg-white rounded-t-xl px-4 pt-3">
                {([
                  ["flota",      `🚌 Flota (${vehEmpresa.length})`],
                  ["conductores",`👤 Conductores (${condEmpresa.length})`],
                  ["documentos", `📄 Documentos (${docEmpresa.length})`],
                ] as [TabActiva, string][]).map(([t, l]) => (
                  <button key={t} onClick={() => setTabActiva(t)}
                    className="px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-all"
                    style={{ borderColor: tabActiva === t ? "#0b315f" : "transparent", color: tabActiva === t ? "#0b315f" : "#9ca3af" }}>
                    {l}
                  </button>
                ))}
              </div>

              {/* ── TAB: FLOTA ── */}
              {tabActiva === "flota" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <p className="text-sm font-bold text-gray-700">Vehículos de {empActual.razon_social}</p>
                    <button onClick={() => { setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar vehículo
                    </button>
                  </div>
                  {mostrarFormVeh && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Placa *">
                          <input className={inputCls("font-mono uppercase")} placeholder="ABC-123"
                            value={formVeh.placa} onChange={e => setFormVeh(p => ({ ...p, placa: e.target.value }))} />
                        </Campo>
                        <Campo label="Categoría">
                          <select className={inputCls()} value={formVeh.categoria}
                            onChange={e => setFormVeh(p => ({ ...p, categoria: e.target.value }))}>
                            {["AUTO","SUV","VAN","MINIBUS","BUS","CUSTER"].map(c => <option key={c}>{c}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Capacidad pax">
                          <input type="number" className={inputCls()} placeholder="45"
                            value={formVeh.capacidad} onChange={e => setFormVeh(p => ({ ...p, capacidad: e.target.value }))} />
                        </Campo>
                        <Campo label="Marca">
                          <input className={inputCls()} placeholder="Mercedes Benz"
                            value={formVeh.marca} onChange={e => setFormVeh(p => ({ ...p, marca: e.target.value }))} />
                        </Campo>
                        <Campo label="Modelo">
                          <input className={inputCls()} value={formVeh.modelo}
                            onChange={e => setFormVeh(p => ({ ...p, modelo: e.target.value }))} />
                        </Campo>
                        <Campo label="Estado">
                          <select className={inputCls()} value={formVeh.estado}
                            onChange={e => setFormVeh(p => ({ ...p, estado: e.target.value }))}>
                            <option value="disponible">Disponible</option>
                            <option value="ocupado">Ocupado</option>
                            <option value="inactivo">Inactivo</option>
                          </select>
                        </Campo>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarVehiculo} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editVehId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}
                  {vehEmpresa.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">Sin vehículos registrados</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {vehEmpresa.map(v => (
                        <div key={v.id} className="flex items-center gap-3 rounded-xl border px-4 py-3">
                          <span className="text-2xl">🚌</span>
                          <div className="flex-1">
                            <p className="font-black font-mono text-gray-900">{v.placa}</p>
                            <p className="text-xs text-gray-400">{v.categoria} · {v.marca} {v.modelo}{v.capacidad ? ` · ${v.capacidad} pax` : ""}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                              style={{ background: v.estado === "disponible" ? "#dcfce7" : "#f3f4f6", color: v.estado === "disponible" ? "#166534" : "#4b5563" }}>
                              {v.estado}
                            </span>
                            <button onClick={() => { setFormVeh({ placa: v.placa, categoria: v.categoria || "BUS", marca: v.marca || "", modelo: v.modelo || "", capacidad: v.capacidad ? String(v.capacidad) : "", estado: v.estado }); setEditVehId(v.id); setMostrarFormVeh(true); }}
                              className="text-xs font-bold text-gray-500 hover:text-gray-800">✏️</button>
                            <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("vehiculos_tercero").delete().eq("id", v.id); cargarTodo(); }}
                              className="text-xs font-bold text-red-400 hover:text-red-600">✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── TAB: CONDUCTORES ── */}
              {tabActiva === "conductores" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <p className="text-sm font-bold text-gray-700">Conductores de {empActual.razon_social}</p>
                    <button onClick={() => { setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar conductor
                    </button>
                  </div>
                  {mostrarFormCond && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Nombre *">
                          <input className={inputCls()} value={formCond.nombre} onChange={e => setFormCond(p => ({ ...p, nombre: e.target.value }))} />
                        </Campo>
                        <Campo label="DNI">
                          <input className={inputCls("font-mono")} maxLength={8} value={formCond.dni} onChange={e => setFormCond(p => ({ ...p, dni: e.target.value }))} />
                        </Campo>
                        <Campo label="Licencia">
                          <input className={inputCls("font-mono uppercase")} value={formCond.licencia} onChange={e => setFormCond(p => ({ ...p, licencia: e.target.value }))} />
                        </Campo>
                        <Campo label="Categoría">
                          <select className={inputCls()} value={formCond.categoria_licencia} onChange={e => setFormCond(p => ({ ...p, categoria_licencia: e.target.value }))}>
                            {["A-I","A-IIa","A-IIb","A-IIIb","A-IIIc"].map(c => <option key={c}>{c}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Venc. licencia">
                          <input type="date" className={inputCls()} value={formCond.vencimiento_licencia} onChange={e => setFormCond(p => ({ ...p, vencimiento_licencia: e.target.value }))} />
                        </Campo>
                        <Campo label="Teléfono">
                          <input className={inputCls()} value={formCond.telefono} onChange={e => setFormCond(p => ({ ...p, telefono: e.target.value }))} />
                        </Campo>
                        <Campo label="PIN acceso app (4 dígitos)">
                          <input className={inputCls("font-mono")} type="text" inputMode="numeric" maxLength={4}
                            placeholder="Ej: 1234" value={formCond.pin_acceso} onChange={e => setFormCond(p => ({ ...p, pin_acceso: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
                        </Campo>
                        <div className="flex items-center gap-2 pt-5">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={formCond.activo_app}
                              onChange={e => setFormCond(p => ({ ...p, activo_app: e.target.checked }))} />
                            <span className="text-xs font-semibold text-gray-700">Activo en app</span>
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarConductor} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editCondId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}
                  {condEmpresa.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">Sin conductores registrados</p>
                  ) : (
                    <div className="space-y-2">
                      {condEmpresa.map(c => {
                        const dias = diasPara(c.vencimiento_licencia);
                        const licEst = dias === null ? "sin_fecha" : dias < 0 ? "vencida" : dias <= 30 ? "por_vencer" : "vigente";
                        const licColor = licEst === "vencida" ? "#dc2626" : licEst === "por_vencer" ? "#d97706" : "#166534";
                        return (
                          <div key={c.id} className="flex items-center gap-3 rounded-xl border px-4 py-3"
                            style={{ borderColor: licEst === "vencida" ? "#fca5a5" : "#e5e7eb", background: licEst === "vencida" ? "#fff5f5" : "white" }}>
                            <div className="w-9 h-9 rounded-full flex items-center justify-center font-black text-white text-sm flex-shrink-0" style={{ background: "#0b315f" }}>
                              {c.nombre.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-bold text-gray-900">{c.nombre}</p>
                              <p className="text-xs text-gray-400">
                                {c.licencia && <span className="font-mono mr-2">{c.licencia}</span>}
                                {c.categoria_licencia && <span className="mr-2">Cat. {c.categoria_licencia}</span>}
                                {c.telefono && <span>📱 {c.telefono}</span>}
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-xs font-bold" style={{ color: licColor }}>
                                {licEst === "vencida" ? "🔴 Vencida" : licEst === "por_vencer" ? `⚠️ ${dias}d` : licEst === "vigente" ? `✅ ${dias}d` : "Sin fecha"}
                              </div>
                              <p className="text-[10px] text-gray-400">{fmtFecha(c.vencimiento_licencia)}</p>
                            </div>
                            <div className="flex gap-1">
                              <button onClick={() => { setFormCond({ nombre: c.nombre, dni: c.dni || "", licencia: c.licencia || "", categoria_licencia: c.categoria_licencia || "A-IIb", vencimiento_licencia: c.vencimiento_licencia || "", telefono: c.telefono || "", estado: c.estado, pin_acceso: c.pin_acceso || "", activo_app: c.activo_app || false }); setEditCondId(c.id); setMostrarFormCond(true); }}
                                className="text-xs font-bold text-gray-400 hover:text-gray-800">✏️</button>
                              <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("conductores_tercero").delete().eq("id", c.id); cargarTodo(); }}
                                className="text-xs font-bold text-red-400 hover:text-red-600">✕</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── TAB: DOCUMENTOS ── */}
              {tabActiva === "documentos" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <p className="text-sm font-bold text-gray-700">Documentos de {empActual.razon_social}</p>
                    <button onClick={() => { setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar documento
                    </button>
                  </div>
                  {mostrarFormDoc && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Tipo *">
                          <select className={inputCls()} value={formDoc.tipo} onChange={e => setFormDoc(p => ({ ...p, tipo: e.target.value }))}>
                            {Object.entries(TIPOS_DOC_TERCERO).map(([k, v]) => <option key={k} value={k}>{v.icon} {k}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Vehículo asociado">
                          <select className={inputCls()} value={formDoc.vehiculo_id} onChange={e => setFormDoc(p => ({ ...p, vehiculo_id: e.target.value }))}>
                            <option value="">Empresa (general)</option>
                            {vehEmpresa.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Número">
                          <input className={inputCls("font-mono")} value={formDoc.numero} onChange={e => setFormDoc(p => ({ ...p, numero: e.target.value }))} />
                        </Campo>
                        <Campo label="Fecha vencimiento">
                          <input type="date" className={inputCls()} value={formDoc.fecha_vencimiento} onChange={e => setFormDoc(p => ({ ...p, fecha_vencimiento: e.target.value }))} />
                        </Campo>
                        <Campo label="Entidad emisora">
                          <input className={inputCls()} value={formDoc.entidad_emisora} onChange={e => setFormDoc(p => ({ ...p, entidad_emisora: e.target.value }))} />
                        </Campo>
                        <Campo label="URL archivo">
                          <input className={inputCls()} placeholder="https://..." value={formDoc.archivo_url} onChange={e => setFormDoc(p => ({ ...p, archivo_url: e.target.value }))} />
                        </Campo>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarDocumento} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editDocId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}
                  {docEmpresa.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">Sin documentos registrados</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                            {["Tipo", "Vehículo", "Número", "Vencimiento", "Días", "Estado", "Archivo", ""].map(h => (
                              <th key={h} className="p-2 text-left font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {docEmpresa.sort((a, b) => {
                            const ord = { vencido: 0, por_vencer: 1, sin_fecha: 2, vigente: 3 };
                            return (ord[estadoDoc(a.fecha_vencimiento)] || 3) - (ord[estadoDoc(b.fecha_vencimiento)] || 3);
                          }).map(d => {
                            const est = estadoDoc(d.fecha_vencimiento);
                            const cfg = ESTADO_DOC_CFG[est];
                            const dias = diasPara(d.fecha_vencimiento);
                            const tipoCfg = TIPOS_DOC_TERCERO[d.tipo] || { icon: "📄", obligatorio: false };
                            const veh = vehiculos.find(v => v.id === d.vehiculo_id);
                            const rowBg = est === "vencido" ? "#fff5f5" : est === "por_vencer" ? "#fffbeb" : "white";
                            return (
                              <tr key={d.id} className="border-t" style={{ background: rowBg, borderColor: "#f1f5f9" }}>
                                <td className="p-2">
                                  <div className="flex items-center gap-1">
                                    <span>{tipoCfg.icon}</span>
                                    <span className="font-bold text-gray-800">{d.tipo}</span>
                                    {tipoCfg.obligatorio && <span className="text-[9px] text-red-500 font-bold">OBL</span>}
                                  </div>
                                </td>
                                <td className="p-2 font-mono text-[#0b315f]">{veh ? veh.placa : "Empresa"}</td>
                                <td className="p-2 font-mono text-gray-500">{d.numero || "—"}</td>
                                <td className="p-2">{fmtFecha(d.fecha_vencimiento)}</td>
                                <td className="p-2 font-black" style={{ color: dias !== null && dias < 0 ? "#dc2626" : dias !== null && dias <= 30 ? "#d97706" : "#166534" }}>
                                  {dias !== null ? (dias < 0 ? `${Math.abs(dias)}d venc.` : `${dias}d`) : "—"}
                                </td>
                                <td className="p-2">
                                  <span className="font-bold px-2 py-0.5 rounded-lg text-[10px]"
                                    style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                                </td>
                                <td className="p-2">
                                  {d.archivo_url
                                    ? <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-500 font-bold underline">Ver</a>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="p-2">
                                  <div className="flex gap-1">
                                    <button onClick={() => { setFormDoc({ vehiculo_id: d.vehiculo_id ? String(d.vehiculo_id) : "", tipo: d.tipo, numero: d.numero || "", fecha_vencimiento: d.fecha_vencimiento || "", entidad_emisora: d.entidad_emisora || "", archivo_url: d.archivo_url || "", observaciones: d.observaciones || "" }); setEditDocId(d.id); setMostrarFormDoc(true); }}
                                      className="text-gray-400 hover:text-gray-800">✏️</button>
                                    <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("documentos_tercero").delete().eq("id", d.id); cargarTodo(); }}
                                      className="text-red-400 hover:text-red-600">✕</button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}