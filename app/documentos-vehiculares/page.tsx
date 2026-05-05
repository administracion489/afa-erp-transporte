"use client";

import React, { useEffect, useMemo, useState, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo  = { id: number; placa: string; categoria: string | null; marca: string | null; };
type Conductor = { id: number; nombre: string; };

type DocVehiculo = {
  id: number; vehiculo_id: number; conductor_id: number | null;
  tipo: string; numero: string | null;
  fecha_emision: string | null; fecha_vencimiento: string | null;
  entidad_emisora: string | null; archivo_url: string | null;
  observaciones: string | null; created_at: string;
};

type Vista = "tabla" | "vehiculos" | "calendario";

// ─── TIPOS DE DOCUMENTO ───────────────────────────────────────────────────────

const TIPOS_DOC: Record<string, {
  label: string; icon: string; obligatorio: boolean;
  renovacion: string; entidad: string;
}> = {
  "SOAT":                    { label: "SOAT",                    icon: "🚗", obligatorio: true,  renovacion: "Anual",      entidad: "Aseguradora" },
  "CAT":                     { label: "CAT",                     icon: "📜", obligatorio: true,  renovacion: "Anual",      entidad: "AFOCAT" },
  "Revisión Técnica (CITV)": { label: "Revisión Técnica (CITV)", icon: "🔍", obligatorio: true,  renovacion: "Semestral",  entidad: "CITV / MTC" },
  "Tarjeta de Propiedad":    { label: "Tarjeta de Propiedad",    icon: "📋", obligatorio: true,  renovacion: "Permanente", entidad: "SUNARP" },
  "Habilitación SUTRAN":     { label: "Habilitación SUTRAN",     icon: "✅", obligatorio: true,  renovacion: "Anual",      entidad: "SUTRAN" },
  "Permiso Operación MTC":   { label: "Permiso Operación MTC",   icon: "🏛️", obligatorio: true,  renovacion: "10 años",    entidad: "MTC" },
  "Tarjeta de Circulación":  { label: "Tarjeta de Circulación",  icon: "🏙️", obligatorio: true,  renovacion: "Anual",      entidad: "Municipio" },
  "Certificado GNV":         { label: "Certificado GNV",         icon: "💨", obligatorio: false, renovacion: "Anual",      entidad: "Taller cert." },
  "Certificado GLP":         { label: "Certificado GLP",         icon: "🔵", obligatorio: false, renovacion: "Anual",      entidad: "Taller cert." },
  "Seguro Todo Riesgo":      { label: "Seguro Todo Riesgo",      icon: "🛡️", obligatorio: false, renovacion: "Anual",      entidad: "Aseguradora" },
  "Responsabilidad Civil":   { label: "Responsabilidad Civil",   icon: "⚖️", obligatorio: false, renovacion: "Anual",      entidad: "Aseguradora" },
  "Otro":                    { label: "Otro",                    icon: "📄", obligatorio: false, renovacion: "Variable",   entidad: "—" },
};

const DOCS_OBLIGATORIOS = Object.entries(TIPOS_DOC)
  .filter(([, v]) => v.obligatorio).map(([k]) => k);

const CATEGORIAS_VEH = ["BUS", "MINIBUS", "CUSTER", "VAN", "SUV", "AUTO"];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoDoc(fecha: string | null): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(fecha);
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
function Campo({ label, span, req, children }: { label: string; span?: number; req?: boolean; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
        {label}{req && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const ESTADO_CFG = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534", dot: "#16a34a", fc: "#16a34a" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e", dot: "#eab308", fc: "#eab308" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b", dot: "#dc2626", fc: "#dc2626" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563", dot: "#9ca3af", fc: "#9ca3af" },
};

const FORM_VACIO = {
  vehiculo_id: "", conductor_id: "", tipo: "SOAT",
  numero: "", fecha_emision: "", fecha_vencimiento: "",
  entidad_emisora: "", archivo_url: "", observaciones: "",
};

// ─── INDICADOR COMPLETITUD ────────────────────────────────────────────────────

function IndicadorCompletitud({ docs, vehiculo }: { docs: DocVehiculo[]; vehiculo: Vehiculo }) {
  const tiposRegistrados = new Set(docs.map(d => d.tipo));
  const completados = DOCS_OBLIGATORIOS.filter(t => tiposRegistrados.has(t)).length;
  const total = DOCS_OBLIGATORIOS.length;
  const pct = Math.round((completados / total) * 100);
  const color = pct === 100 ? "#16a34a" : pct >= 70 ? "#eab308" : "#dc2626";
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="text-gray-400 font-bold uppercase tracking-wide">Completitud docs obligatorios</span>
        <span className="font-black" style={{ color }}>{completados}/{total} · {pct}%</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {pct < 100 && (
        <p className="text-[9px] text-gray-400 mt-0.5">
          Falta: {DOCS_OBLIGATORIOS.filter(t => !tiposRegistrados.has(t)).join(", ")}
        </p>
      )}
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DocumentosVehiculosPage() {
  const calRef = useRef<any>(null);

  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [documentos,  setDocumentos]  = useState<DocVehiculo[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [vista,       setVista]       = useState<Vista>("tabla");
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroVeh,   setFiltroVeh]   = useState("todos");
  const [filtroCond,  setFiltroCond]  = useState("todos");
  const [filtroCat,   setFiltroCat]   = useState("todas");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, cRes, dRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca").order("placa"),
      supabase.from("conductores").select("id,nombre").order("nombre"),
      supabase.from("documentos_vehiculo").select("*").order("fecha_vencimiento"),
    ]);
    setVehiculos(vRes.data || []);
    setConductores(cRes.data || []);
    setDocumentos(dRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreVehiculo  = (id: number) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreConductor = (id: number | null) => id ? conductores.find(c => c.id === id)?.nombre || "—" : null;

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.tipo) { alert("Selecciona vehículo y tipo"); return; }
    setGuardando(true);
    const cfg = TIPOS_DOC[form.tipo];
    const payload = {
      vehiculo_id:       Number(form.vehiculo_id),
      conductor_id:      form.conductor_id ? Number(form.conductor_id) : null,
      tipo:              form.tipo,
      numero:            form.numero.trim()            || null,
      fecha_emision:     form.fecha_emision            || null,
      fecha_vencimiento: form.fecha_vencimiento        || null,
      entidad_emisora:   form.entidad_emisora.trim()   || cfg?.entidad || null,
      archivo_url:       form.archivo_url.trim()       || null,
      observaciones:     form.observaciones.trim()     || null,
    };
    const { error } = editandoId
      ? await supabase.from("documentos_vehiculo").update(payload).eq("id", editandoId)
      : await supabase.from("documentos_vehiculo").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (d: DocVehiculo) => {
    setForm({
      vehiculo_id:       String(d.vehiculo_id),
      conductor_id:      d.conductor_id ? String(d.conductor_id) : "",
      tipo:              d.tipo,
      numero:            d.numero            || "",
      fecha_emision:     d.fecha_emision     || "",
      fecha_vencimiento: d.fecha_vencimiento || "",
      entidad_emisora:   d.entidad_emisora   || "",
      archivo_url:       d.archivo_url       || "",
      observaciones:     d.observaciones     || "",
    });
    setEditandoId(d.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este documento?")) return;
    await supabase.from("documentos_vehiculo").delete().eq("id", id);
    cargarDatos();
  };

  // ── Documentos enriquecidos ────────────────────────────────────────────────

  const docsCalc = useMemo(() =>
    documentos.map(d => ({ ...d, _estado: estadoDoc(d.fecha_vencimiento) })),
    [documentos]
  );

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const total      = documentos.length;
  const vigentes   = docsCalc.filter(d => d._estado === "vigente").length;
  const porVencer  = docsCalc.filter(d => d._estado === "por_vencer").length;
  const vencidos   = docsCalc.filter(d => d._estado === "vencido").length;
  const obligVenc  = docsCalc.filter(d => d._estado === "vencido" && TIPOS_DOC[d.tipo]?.obligatorio).length;
  const vehConProb = new Set(docsCalc.filter(d => d._estado === "vencido").map(d => d.vehiculo_id)).size;

  // Vehículos con todos los obligatorios al 100%
  const vehCompletos = vehiculos.filter(v => {
    const docs = docsCalc.filter(d => d.vehiculo_id === v.id);
    const tipos = new Set(docs.map(d => d.tipo));
    return DOCS_OBLIGATORIOS.every(t => tipos.has(t));
  }).length;

  // Próximos 60 días
  const proximosVencer = docsCalc
    .filter(d => { const d2 = diasPara(d.fecha_vencimiento); return d2 !== null && d2 >= 0 && d2 <= 60; })
    .sort((a, b) => (diasPara(a.fecha_vencimiento) || 0) - (diasPara(b.fecha_vencimiento) || 0));

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => docsCalc.filter(d => {
    const v   = vehiculos.find(v => v.id === d.vehiculo_id);
    const q   = busqueda.toLowerCase();
    const cond= conductores.find(c => c.id === d.conductor_id);
    const txt = `${v?.placa || ""} ${d.tipo} ${d.numero || ""} ${d.entidad_emisora || ""} ${cond?.nombre || ""}`.toLowerCase();
    const cat = v?.categoria?.toUpperCase() || "";
    return txt.includes(q) &&
      (filtroEst  === "todos" || d._estado === filtroEst) &&
      (filtroTipo === "todos" || d.tipo    === filtroTipo) &&
      (filtroVeh  === "todos" || String(d.vehiculo_id) === filtroVeh) &&
      (filtroCond === "todos" || String(d.conductor_id) === filtroCond) &&
      (filtroCat  === "todas" || cat.includes(filtroCat));
  }).sort((a, b) => {
    const ord = { vencido: 0, por_vencer: 1, sin_fecha: 2, vigente: 3 };
    return (ord[a._estado] || 3) - (ord[b._estado] || 3);
  }), [docsCalc, busqueda, filtroEst, filtroTipo, filtroVeh, filtroCond, filtroCat, vehiculos, conductores]);

  // ── Datos por vehículo ────────────────────────────────────────────────────

  const datosVehiculo = useMemo(() => vehiculos.map(v => {
    const cat = (v.categoria || "").toUpperCase();
    if (filtroCat !== "todas" && !cat.includes(filtroCat)) return null;
    const docs = docsCalc.filter(d => d.vehiculo_id === v.id);
    const tipos = new Set(docs.map(d => d.tipo));
    const completitud = DOCS_OBLIGATORIOS.filter(t => tipos.has(t)).length;
    const venc = docs.filter(d => d._estado === "vencido").length;
    const porV = docs.filter(d => d._estado === "por_vencer").length;
    return { vehiculo: v, docs, completitud, total_oblig: DOCS_OBLIGATORIOS.length, vencidos: venc, porVencer: porV };
  }).filter(Boolean) as NonNullable<ReturnType<typeof vehiculos.map>>[], [vehiculos, docsCalc, filtroCat]);

  // ── Eventos FullCalendar ──────────────────────────────────────────────────

  const eventosCalendario = docsCalc
    .filter(d => d.fecha_vencimiento)
    .map(d => {
      const v   = vehiculos.find(v => v.id === d.vehiculo_id);
      const cfg = ESTADO_CFG[d._estado];
      const tipoCfg = TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
      return {
        id:    String(d.id),
        title: `${tipoCfg.icon} ${v?.placa || "—"} · ${d.tipo}`,
        start: d.fecha_vencimiento!,
        backgroundColor: cfg.fc,
        borderColor:     cfg.fc,
        textColor:       "#fff",
        extendedProps:   { doc: d, vehiculo: v },
      };
    });

  // ── Imprimir ──────────────────────────────────────────────────────────────

  const imprimir = () => {
    const rows = filtrados.map(d => {
      const v = vehiculos.find(v => v.id === d.vehiculo_id);
      return `<tr>
        <td>${v?.placa || "—"}</td>
        <td>${v?.categoria || "—"}</td>
        <td>${d.tipo}</td>
        <td>${d.numero || "—"}</td>
        <td>${fmtFecha(d.fecha_vencimiento)}</td>
        <td>${diasPara(d.fecha_vencimiento) !== null ? (diasPara(d.fecha_vencimiento)! < 0 ? `${Math.abs(diasPara(d.fecha_vencimiento)!)}d vencido` : `${diasPara(d.fecha_vencimiento)}d`) : "—"}</td>
        <td>${ESTADO_CFG[d._estado]?.label || "—"}</td>
        <td>${TIPOS_DOC[d.tipo]?.obligatorio ? "SÍ" : "No"}</td>
      </tr>`;
    }).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Documentos Vehiculares — AFA Tours Perú</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; padding: 20px; }
  h1 { font-size: 16px; color: #0b315f; margin-bottom: 4px; }
  p { color: #666; margin-bottom: 12px; font-size: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #0b315f; color: white; padding: 6px 8px; text-align: left; font-size: 10px; text-transform: uppercase; }
  td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; font-size: 10px; }
  tr:nth-child(even) { background: #f8fafc; }
  @media print { @page { size: A4 landscape; margin: 15mm; } }
</style></head><body>
<h1>Documentos Vehiculares — AFA Tours Perú</h1>
<p>Generado: ${new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })} · ${filtrados.length} documentos</p>
<table><thead><tr>
  <th>Vehículo</th><th>Categ.</th><th>Tipo</th><th>Número</th>
  <th>Vencimiento</th><th>Días</th><th>Estado</th><th>Oblig.</th>
</tr></thead><tbody>${rows}</tbody></table>
<script>window.onload=()=>window.print();</script>
</body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Documentos Vehiculares</h1>
          <p className="text-gray-400 text-sm mt-1">
            SOAT · CITV · SUTRAN · MTC · control de vencimientos y completitud documental
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={imprimir}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            🖨️ Imprimir
          </button>
          <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nuevo documento"}
          </button>
        </div>
      </div>

      {/* ALERTAS */}
      {obligVenc > 0 && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
          <span className="text-xl">🚨</span>
          <div>
            <b>{obligVenc} documento{obligVenc > 1 ? "s" : ""} OBLIGATORIO{obligVenc > 1 ? "S" : ""} vencido{obligVenc > 1 ? "s" : ""}</b>
            {" — "}{vehConProb} vehículo{vehConProb > 1 ? "s" : ""} en riesgo de multa e inmovilización.
          </div>
        </div>
      )}
      {porVencer > 0 && obligVenc === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          ⚠️ <span><b>{porVencer} documento{porVencer > 1 ? "s" : ""}</b> vence{porVencer > 1 ? "n" : ""} en los próximos 30 días</span>
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total docs",     valor: total,         color: "#0b315f", bg: "#eef3f8" },
          { label: "Vigentes",       valor: vigentes,      color: "#166534", bg: "#dcfce7" },
          { label: "Por vencer",     valor: porVencer,     color: "#854d0e", bg: "#fef9c3" },
          { label: "Vencidos",       valor: vencidos,      color: "#991b1b", bg: "#fee2e2" },
          { label: "Oblig. vencidos",valor: obligVenc,     color: obligVenc > 0 ? "#991b1b" : "#166534", bg: obligVenc > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Veh. completos", valor: `${vehCompletos}/${vehiculos.length}`, color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Con problemas",  valor: vehConProb,    color: vehConProb > 0 ? "#991b1b" : "#166534", bg: vehConProb > 0 ? "#fee2e2" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* TIMELINE 60 días */}
      {proximosVencer.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">📅 Próximos vencimientos — 60 días</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {proximosVencer.slice(0, 12).map(d => {
              const v    = vehiculos.find(v => v.id === d.vehiculo_id);
              const dias = diasPara(d.fecha_vencimiento) || 0;
              const cfg  = TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
              const urg  = dias <= 7;
              const barW = Math.max(2, 100 - (dias / 60) * 100);
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer hover:brightness-95"
                  style={{ background: urg ? "#fee2e2" : dias <= 30 ? "#fef9c3" : "#f8fafc" }}
                  onClick={() => editar(d)}>
                  <span className="text-lg">{cfg.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs flex-wrap">
                      <span className="font-black text-[#0b315f] font-mono">{v?.placa || "—"}</span>
                      <span className="font-bold text-gray-700">{d.tipo}</span>
                      {cfg.obligatorio && <span className="text-[9px] text-red-600 font-bold bg-red-50 px-1.5 py-0.5 rounded">OBLIG.</span>}
                      {d.conductor_id && <span className="text-[9px] text-gray-500">👤 {nombreConductor(d.conductor_id)}</span>}
                    </div>
                    <div className="mt-1.5 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${barW}%`, background: urg ? "#dc2626" : dias <= 30 ? "#eab308" : "#0b315f" }} />
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 text-xs">
                    <div className="font-black" style={{ color: urg ? "#dc2626" : dias <= 30 ? "#854d0e" : "#0b315f" }}>
                      {dias === 0 ? "Hoy" : `${dias}d`}
                    </div>
                    <div className="text-[10px] text-gray-400">{fmtFecha(d.fecha_vencimiento)}</div>
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
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg"
              style={{ background: TIPOS_DOC[form.tipo]?.obligatorio ? "#dc2626" : "#0b315f" }}>
              {TIPOS_DOC[form.tipo]?.icon || "📄"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar documento" : "Nuevo documento vehicular"}</h2>
              <p className="text-xs" style={{ color: TIPOS_DOC[form.tipo]?.obligatorio ? "#dc2626" : "#6b7280" }}>
                {TIPOS_DOC[form.tipo]?.obligatorio ? "⚠ OBLIGATORIO — afecta estado operativo del vehículo" : "Complementario"}
                {" · "}{TIPOS_DOC[form.tipo]?.renovacion} · {TIPOS_DOC[form.tipo]?.entidad}
              </p>
            </div>
          </div>

          {/* Selector tipo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de documento</p>
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase text-red-500">🔴 Obligatorios por ley</p>
              <div className="grid grid-cols-4 md:grid-cols-7 gap-1.5 mb-2">
                {Object.entries(TIPOS_DOC).filter(([, v]) => v.obligatorio).map(([k, v]) => {
                  const act = form.tipo === k;
                  return (
                    <button key={k} onClick={() => setForm(p => ({ ...p, tipo: k, entidad_emisora: v.entidad }))}
                      className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                      style={{ background: act ? "#fee2e2" : "white", borderColor: act ? "#dc2626" : "#e5e7eb", color: act ? "#dc2626" : "#9ca3af" }}>
                      <span className="text-base">{v.icon}</span>
                      <span className="text-[9px] font-bold leading-tight">{v.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] font-bold uppercase text-blue-500">🔵 Complementarios</p>
              <div className="grid grid-cols-4 md:grid-cols-7 gap-1.5">
                {Object.entries(TIPOS_DOC).filter(([, v]) => !v.obligatorio).map(([k, v]) => {
                  const act = form.tipo === k;
                  return (
                    <button key={k} onClick={() => setForm(p => ({ ...p, tipo: k, entidad_emisora: v.entidad }))}
                      className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                      style={{ background: act ? "#dbeafe" : "white", borderColor: act ? "#1d4ed8" : "#e5e7eb", color: act ? "#1d4ed8" : "#9ca3af" }}>
                      <span className="text-base">{v.icon}</span>
                      <span className="text-[9px] font-bold leading-tight">{v.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del documento</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Vehículo" req>
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">Seleccionar vehículo</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca}</option>)}
                </select>
              </Campo>
              <Campo label="Conductor asociado (opcional)">
                <select className={inputCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                  <option value="">Sin conductor específico</option>
                  {conductores.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </Campo>
              <Campo label="Número / Código">
                <input className={inputCls("font-mono")} placeholder="N° de documento" value={form.numero} onChange={f("numero")} />
              </Campo>
              <Campo label="Entidad emisora">
                <input className={inputCls()} placeholder="Ej: Rimac Seguros, SUNARP..." value={form.entidad_emisora} onChange={f("entidad_emisora")} />
              </Campo>
              <Campo label="Fecha de emisión">
                <input type="date" className={inputCls()} value={form.fecha_emision} onChange={f("fecha_emision")} />
              </Campo>
              <Campo label="Fecha de vencimiento">
                <input type="date" className={inputCls(
                  form.fecha_vencimiento && diasPara(form.fecha_vencimiento) !== null && diasPara(form.fecha_vencimiento)! <= 0
                    ? "border-red-400 bg-red-50" : ""
                )} value={form.fecha_vencimiento} onChange={f("fecha_vencimiento")} />
                {form.fecha_vencimiento && diasPara(form.fecha_vencimiento) !== null && (
                  <p className="text-[10px] mt-1 font-bold" style={{
                    color: diasPara(form.fecha_vencimiento)! <= 0 ? "#dc2626"
                      : diasPara(form.fecha_vencimiento)! <= 30 ? "#854d0e" : "#166534"
                  }}>
                    {diasPara(form.fecha_vencimiento)! <= 0
                      ? `⚠ Vencido hace ${Math.abs(diasPara(form.fecha_vencimiento)!)} días`
                      : `✓ Vence en ${diasPara(form.fecha_vencimiento)} días`}
                  </p>
                )}
              </Campo>
            </div>
          </div>

          {/* Archivo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Archivo digital</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Campo label="URL del archivo (PDF, imagen, Drive...)">
                <input className={inputCls()} placeholder="https://drive.google.com/..." value={form.archivo_url} onChange={f("archivo_url")} />
                <p className="text-[10px] text-gray-400 mt-1">Formatos aceptados: PDF · JPG · PNG · Google Drive · Dropbox</p>
              </Campo>
              <Campo label="Observaciones">
                <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones} onChange={f("observaciones")} />
              </Campo>
            </div>

            {/* Preview del archivo */}
            {form.archivo_url && (
              <div className="mt-3 flex items-center gap-3 rounded-xl px-4 py-3 border" style={{ background: "#eef3f8" }}>
                <span className="text-2xl">📎</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-gray-700 truncate">{form.archivo_url}</p>
                  <p className="text-[10px] text-gray-400">Archivo adjunto · clic para verificar</p>
                </div>
                <a href={form.archivo_url} target="_blank" rel="noreferrer"
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                  Verificar →
                </a>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar documento" : "Guardar documento"}
            </button>
            <button onClick={limpiar}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {([
          ["tabla",     `📋 Tabla (${filtrados.length})`],
          ["vehiculos", `🚌 Por vehículo (${vehiculos.length})`],
          ["calendario","📅 Calendario"],
        ] as [Vista, string][]).map(([v, l]) => (
          <button key={v} onClick={() => setVista(v)}
            className="px-5 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {l}
          </button>
        ))}
      </div>

      {/* FILTROS (para tabla y vehículos) */}
      {vista !== "calendario" && (
        <section className="flex flex-col md:flex-row gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
              placeholder="Buscar por placa, tipo, número, conductor..."
              value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          </div>
          {/* Filtro categoría vehículo */}
          <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroCat} onChange={e => setFiltroCat(e.target.value)}>
            <option value="todas">Todas las categorías</option>
            {CATEGORIAS_VEH.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {/* Filtro vehículo */}
          <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroVeh} onChange={e => setFiltroVeh(e.target.value)}>
            <option value="todos">Todos los vehículos</option>
            {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
          </select>
          {/* Filtro conductor */}
          <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroCond} onChange={e => setFiltroCond(e.target.value)}>
            <option value="todos">Todos los conductores</option>
            {conductores.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          {/* Filtro tipo */}
          <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
            <option value="todos">Todos los tipos</option>
            {Object.entries(TIPOS_DOC).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
          {/* Filtro estado */}
          <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
            <option value="todos">Todos los estados</option>
            <option value="vencido">🔴 Vencidos</option>
            <option value="por_vencer">⚠️ Por vencer</option>
            <option value="vigente">✅ Vigentes</option>
            <option value="sin_fecha">Sin fecha</option>
          </select>
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400 whitespace-nowrap">
            {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
          </div>
        </section>
      )}

      {/* ── VISTA: TABLA ── */}
      {vista === "tabla" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Vehículo", "Tipo doc.", "Conductor", "Número", "Entidad", "Vencimiento", "Días", "Estado", "Archivo", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                    </div>
                  </td></tr>
                ) : filtrados.length === 0 ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📄</p><p className="font-medium">No hay documentos</p>
                  </td></tr>
                ) : filtrados.map(d => {
                  const v    = vehiculos.find(v => v.id === d.vehiculo_id);
                  const cfg  = ESTADO_CFG[d._estado];
                  const tipoCfg = TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
                  const dias = diasPara(d.fecha_vencimiento);
                  const rowBg = d._estado === "vencido" ? "#fff5f5" : d._estado === "por_vencer" ? "#fffbeb" : "white";
                  return (
                    <tr key={d.id} className="border-t hover:brightness-95 transition-all cursor-pointer"
                      style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => editar(d)}>
                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">{v?.placa || "—"}</span>
                        <div className="text-[10px] text-gray-400">{v?.categoria}</div>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <span>{tipoCfg.icon}</span>
                          <div>
                            <div className="text-xs font-bold text-gray-800">{d.tipo}</div>
                            {tipoCfg.obligatorio && <div className="text-[9px] text-red-500 font-bold">Obligatorio</div>}
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {d.conductor_id ? <span>👤 {nombreConductor(d.conductor_id)}</span> : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="p-3 font-mono text-xs text-gray-500">{d.numero || "—"}</td>
                      <td className="p-3 text-xs text-gray-500 max-w-[100px]"><div className="truncate">{d.entidad_emisora || "—"}</div></td>
                      <td className="p-3 text-xs font-medium text-gray-700">{fmtFecha(d.fecha_vencimiento)}</td>
                      <td className="p-3">
                        {dias !== null ? (
                          <span className="font-black text-xs" style={{ color: dias < 0 ? "#dc2626" : dias <= 7 ? "#dc2626" : dias <= 30 ? "#d97706" : "#166534" }}>
                            {dias < 0 ? `${Math.abs(dias)}d venc.` : `${dias}d`}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                          style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                      </td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        {d.archivo_url
                          ? <a href={d.archivo_url} target="_blank" rel="noreferrer"
                              className="text-blue-500 underline text-xs font-bold">📄 Ver</a>
                          : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5">
                          <button onClick={() => editar(d)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => eliminar(d.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtrados.length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
              <span>{filtrados.length} de {total} · ordenados por urgencia</span>
              <span>AFA ERP · Documentos Vehiculares</span>
            </div>
          )}
        </section>
      )}

      {/* ── VISTA: POR VEHÍCULO ── */}
      {vista === "vehiculos" && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {datosVehiculo.length === 0 ? (
            <div className="col-span-3 p-10 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-3xl mb-2">🚌</p><p>Sin vehículos registrados</p>
            </div>
          ) : datosVehiculo.map(({ vehiculo: v, docs, completitud, total_oblig, vencidos: venc, porVencer: porV }) => {
            const pct = Math.round((completitud / total_oblig) * 100);
            const borderColor = venc > 0 ? "#fca5a5" : porV > 0 ? "#fde68a" : pct === 100 ? "#86efac" : "#e5e7eb";
            return (
              <div key={v.id} className="bg-white rounded-2xl border-2 shadow-sm p-4 space-y-3"
                style={{ borderColor }}>
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🚌</span>
                    <div>
                      <p className="font-black font-mono text-gray-900">{v.placa}</p>
                      <p className="text-[10px] text-gray-400">{v.categoria} · {v.marca}</p>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {venc > 0 && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">🔴 {venc}</span>}
                    {porV > 0 && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">⚠️ {porV}</span>}
                    {venc === 0 && porV === 0 && pct === 100 && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">✅ OK</span>}
                  </div>
                </div>

                {/* Completitud */}
                <IndicadorCompletitud docs={docs} vehiculo={v} />

                {/* Lista de documentos */}
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {docs.length === 0 ? (
                    <p className="text-xs text-gray-300 text-center py-2">Sin documentos registrados</p>
                  ) : docs.map(d => {
                    const est    = d._estado;
                    const cfg    = ESTADO_CFG[est];
                    const tipoCfg= TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
                    const dias   = diasPara(d.fecha_vencimiento);
                    return (
                      <div key={d.id} className="flex items-center justify-between rounded-xl px-3 py-2 cursor-pointer hover:brightness-95"
                        style={{ background: cfg.bg + "66" }}
                        onClick={() => editar(d)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex-shrink-0">{tipoCfg.icon}</span>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-gray-700 truncate">{d.tipo}</p>
                            {d.conductor_id && <p className="text-[9px] text-gray-400">👤 {nombreConductor(d.conductor_id)}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {dias !== null && (
                            <span className="text-[10px] font-bold" style={{ color: cfg.color }}>
                              {dias < 0 ? `${Math.abs(dias)}d` : `${dias}d`}
                            </span>
                          )}
                          <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                          {d.archivo_url && (
                            <a href={d.archivo_url} target="_blank" rel="noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="text-[10px] text-blue-500 font-bold underline">PDF</a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Docs obligatorios faltantes */}
                {(() => {
                  const tipos = new Set(docs.map(d => d.tipo));
                  const faltantes = DOCS_OBLIGATORIOS.filter(t => !tipos.has(t));
                  if (faltantes.length === 0) return null;
                  return (
                    <div className="rounded-xl px-3 py-2 bg-gray-50 border border-dashed border-gray-200">
                      <p className="text-[9px] font-bold uppercase text-gray-400 mb-1">Sin registrar:</p>
                      <div className="flex flex-wrap gap-1">
                        {faltantes.map(t => (
                          <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                            {TIPOS_DOC[t]?.icon} {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <button onClick={() => { setForm({ ...FORM_VACIO, vehiculo_id: String(v.id) }); setEditandoId(null); setMostrarForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  className="w-full py-2 rounded-xl text-xs font-bold border text-[#0b315f] border-[#0b315f] hover:bg-blue-50 transition-all">
                  + Agregar documento
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── VISTA: CALENDARIO ── */}
      {vista === "calendario" && (
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between flex-wrap gap-3" style={{ borderColor: "#f1f5f9" }}>
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold text-gray-700">Vencimientos en el calendario</h2>
              <button onClick={() => calRef.current?.getApi().prev()} className="w-8 h-8 rounded-lg border flex items-center justify-center hover:bg-gray-50 text-gray-600">‹</button>
              <button onClick={() => calRef.current?.getApi().today()} className="px-3 py-1 rounded-lg border text-xs font-bold hover:bg-gray-50 text-gray-600">Hoy</button>
              <button onClick={() => calRef.current?.getApi().next()} className="w-8 h-8 rounded-lg border flex items-center justify-center hover:bg-gray-50 text-gray-600">›</button>
            </div>
            {/* Leyenda */}
            <div className="flex gap-3 flex-wrap">
              {[
                { color: "#16a34a", label: "Vigente" },
                { color: "#eab308", label: "Por vencer" },
                { color: "#dc2626", label: "Vencido" },
              ].map(l => (
                <div key={l.label} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full" style={{ background: l.color }} />
                  <span className="text-[11px] font-medium text-gray-500">{l.label}</span>
                </div>
              ))}
            </div>
          </div>

          <style>{`
            .fc { font-family: inherit; }
            .fc-toolbar { display: none !important; }
            .fc-event { border-radius: 6px !important; border-width: 0 !important; padding: 2px 6px !important; font-size: 11px !important; font-weight: 700 !important; cursor: pointer !important; }
            .fc-event:hover { opacity: .85 !important; }
            .fc-event-main { color: #fff !important; font-weight: 700 !important; }
            .fc-event-title { color: #fff !important; }
            .fc-daygrid-event { margin: 1px 2px !important; }
            .fc-col-header-cell { background: #f8fafc !important; }
            .fc-col-header-cell-cushion { font-size: 12px !important; font-weight: 700 !important; color: #374151 !important; text-decoration: none !important; padding: 8px 4px !important; }
            .fc-daygrid-day-number { font-size: 13px !important; font-weight: 600 !important; color: #374151 !important; text-decoration: none !important; }
            .fc-day-today { background: #eff6ff !important; }
            .fc-day-today .fc-daygrid-day-number { background: #0b315f !important; color: white !important; border-radius: 50% !important; width: 28px !important; height: 28px !important; display: flex !important; align-items: center !important; justify-content: center !important; }
            .fc-more-link { font-size: 11px !important; font-weight: 700 !important; color: #0b315f !important; }
            .fc-popover { border-radius: 12px !important; box-shadow: 0 8px 24px rgba(0,0,0,.15) !important; }
            .fc-popover-header { background: #0b315f !important; color: white !important; border-radius: 12px 12px 0 0 !important; padding: 8px 12px !important; }
          `}</style>

          <FullCalendar
            ref={calRef}
            plugins={[dayGridPlugin]}
            initialView="dayGridMonth"
            headerToolbar={false}
            locale="es"
            height={600}
            events={eventosCalendario}
            eventDisplay="block"
            dayMaxEvents={4}
            eventClick={(info) => {
              const d = info.event.extendedProps.doc as DocVehiculo;
              editar(d);
            }}
            eventContent={(arg) => {
              const d = arg.event.extendedProps.doc as DocVehiculo;
              const v = arg.event.extendedProps.vehiculo as Vehiculo | undefined;
              return (
                <div className="px-1 py-0.5 overflow-hidden" title={arg.event.title}>
                  <div className="font-bold text-white truncate" style={{ fontSize: "10px" }}>
                    {v?.placa || "—"} · {d.tipo}
                  </div>
                </div>
              );
            }}
          />

          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{eventosCalendario.length} documentos con fecha de vencimiento</span>
            <span>AFA ERP · Documentos Vehiculares</span>
          </div>
        </div>
      )}
    </main>
  );
}