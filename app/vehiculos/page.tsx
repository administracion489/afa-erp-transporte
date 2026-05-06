"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  marca: string | null; modelo: string | null; anio: number | null;
  color: string | null; capacidad_pasajeros: number | null;
  carga_maxima: string | null; estado: string | null;
  kilometraje_actual: number | null; proximo_mantenimiento_km: number | null;
  estado_operativo: string | null; observaciones: string | null;
  equipamiento: string | null;
  foto_externa_url: string | null; foto_interna_url: string | null;
  descripcion_unidad: string | null;
};

type DocVehiculo = {
  id: number; vehiculo_id: number; tipo: string; numero: string | null;
  fecha_emision: string | null; fecha_vencimiento: string | null;
  entidad_emisora: string | null; archivo_url: string | null;
  observaciones: string | null; created_at: string;
};

type Vista = "flota" | "documentos";

// ─── CONFIG DOCUMENTOS ────────────────────────────────────────────────────────

type TipoDocConfig = { label: string; icon: string; obligatorio: boolean; renovacion: string; entidad: string; };
const TIPOS_DOC: Record<string, TipoDocConfig> = {
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
const DOCS_OBLIGATORIOS = Object.entries(TIPOS_DOC).filter(([, v]) => v.obligatorio).map(([k]) => k);

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CATEGORIAS = ["AUTO", "SUV", "VAN", "MINIBUS", "BUS", "CUSTER"];
const ICONO_CAT: Record<string, string> = { AUTO: "🚗", SUV: "🚙", VAN: "🚐", MINIBUS: "🚌", BUS: "🚌", CUSTER: "🚐" };

const EQUIP_CFG = {
  full_equipo: { label: "Full Equipo",  icon: "⭐", desc: "AC · TV · WiFi · reclinables · bodega · GPS", color: "#0b315f", bg: "#eef3f8" },
  basico:      { label: "Básico",       icon: "📦", desc: "Servicio estándar sin equipamiento premium",   color: "#4b5563", bg: "#f3f4f6" },
};

const DESC_DEFECTO = {
  full_equipo: `Bus con capacidad para {cap} pasajeros, con aire acondicionado, sistema de audio (radio y TV), asientos reclinables con reposapiés, cortinas, bodega para equipaje y GPS en tiempo real.`,
  basico: `Bus con capacidad para {cap} pasajeros, con asientos estándar, bodega para equipaje y GPS en tiempo real.`,
};

const ESTADO_OPERATIVO: Record<string, { label: string; bg: string; color: string; dot: string }> = {
  apto:    { label: "Apto",    bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  no_apto: { label: "No apto", bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
};
const ESTADO_VEHICULO: Record<string, { label: string; bg: string; color: string }> = {
  disponible:    { label: "Disponible",    bg: "#dcfce7", color: "#166534" },
  ocupado:       { label: "Ocupado",       bg: "#dbeafe", color: "#1d4ed8" },
  mantenimiento: { label: "Mantenimiento", bg: "#fef9c3", color: "#854d0e" },
  inactivo:      { label: "Inactivo",      bg: "#f3f4f6", color: "#4b5563" },
};
const ESTADO_DOC: Record<string, { label: string; bg: string; color: string }> = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563" },
};

const FORM_V = {
  placa: "", categoria: "BUS", marca: "", modelo: "", anio: "",
  color: "", capacidad: "", carga_maxima: "", estado: "disponible",
  equipamiento: "full_equipo",
  foto_externa_url: "", foto_interna_url: "",
  descripcion_unidad: "",
  km: "", proximo_km: "", observaciones: "",
};

const FORM_D = {
  vehiculo_id: "", tipo: "SOAT", numero: "", fecha_emision: "",
  fecha_vencimiento: "", entidad_emisora: "", archivo_url: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoDoc(fecha: string | null): string {
  const d = diasPara(fecha);
  if (d === null) return "sin_fecha";
  if (d < 0) return "vencido";
  if (d <= 30) return "por_vencer";
  return "vigente";
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function Campo({ label, span, hint, children }: { label: string; span?: number; hint?: string; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}
function calcEstadoOperativo(docs: DocVehiculo[]): "apto" | "no_apto" {
  for (const tipo of DOCS_OBLIGATORIOS.filter(t => t !== "CAT")) {
    const doc = docs.find(d => d.tipo === tipo);
    if (!doc) continue;
    if (estadoDoc(doc.fecha_vencimiento) === "vencido") return "no_apto";
  }
  return "apto";
}
function FotoPreview({ url, label }: { url: string; label: string }) {
  if (!url) return null;
  const esImagen = /\.(jpg|jpeg|png|webp|gif)/i.test(url);
  const esDrive  = url.includes("drive.google.com");
  if (esDrive || esImagen) {
    let src = url;
    if (esDrive) {
      const match = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      // thumbnail funciona sin CORS para archivos públicos de Drive
      if (match) src = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800`;
    }
    return (
      <div className="rounded-xl overflow-hidden border mt-2" style={{ background: "#f8fafc" }}>
        <p className="text-[10px] font-bold uppercase text-gray-400 px-2 pt-2">{label}</p>
        <img src={src} alt={label} className="w-full h-40 object-cover mt-1"
          onError={e => { (e.target as HTMLImageElement).parentElement!.innerHTML = `<p class="text-xs text-gray-400 p-2">No se pudo cargar la imagen — verifica que el enlace sea público</p>`; }} />
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer"
      className="flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-bold text-[#0b315f] hover:bg-blue-50 mt-2"
      style={{ background: "#eef3f8" }}>
      🖼️ Ver {label} →
    </a>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function VehiculosPage() {
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [documentos,   setDocumentos]   = useState<DocVehiculo[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [vista,        setVista]        = useState<Vista>("flota");
  const [mostrarFormV, setMostrarFormV] = useState(false);
  const [mostrarFormD, setMostrarFormD] = useState(false);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [editandoDocId,setEditandoDocId]= useState<number | null>(null);
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroCat,    setFiltroCat]    = useState("todas");
  const [filtroEst,    setFiltroEst]    = useState("todos");
  const [filtroEquip,  setFiltroEquip]  = useState("todos");
  const [formV,        setFormV]        = useState(FORM_V);
  const [formD,        setFormD]        = useState(FORM_D);
  const [guardando,    setGuardando]    = useState(false);

  const fv = (k: keyof typeof FORM_V) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormV(p => ({ ...p, [k]: e.target.value }));
  const fd = (k: keyof typeof FORM_D) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormD(p => ({ ...p, [k]: e.target.value }));

  // Cuando cambia equipamiento → sugerir descripción por defecto
  const cambiarEquipamiento = (equip: string) => {
    setFormV(p => {
      const cap = p.capacidad || "—";
      const desc = p.descripcion_unidad;
      // Solo auto-rellena si está vacío o es el texto por defecto del otro equipamiento
      const defFull = DESC_DEFECTO.full_equipo.replace("{cap}", cap);
      const defBas  = DESC_DEFECTO.basico.replace("{cap}", cap);
      const esDefault = !desc || desc === defFull || desc === defBas;
      const nueva = esDefault
        ? (equip === "full_equipo" ? defFull : defBas)
        : desc;
      return { ...p, equipamiento: equip, descripcion_unidad: nueva };
    });
  };

  // Cuando cambia capacidad → actualizar descripción si es texto por defecto
  const cambiarCapacidad = (cap: string) => {
    setFormV(p => {
      const equip = p.equipamiento || "full_equipo";
      const defFull = DESC_DEFECTO.full_equipo.replace("{cap}", p.capacidad || "—");
      const defBas  = DESC_DEFECTO.basico.replace("{cap}", p.capacidad || "—");
      const esDefault = !p.descripcion_unidad || p.descripcion_unidad === defFull || p.descripcion_unidad === defBas;
      const nueva = esDefault
        ? (equip === "full_equipo"
            ? DESC_DEFECTO.full_equipo.replace("{cap}", cap || "—")
            : DESC_DEFECTO.basico.replace("{cap}", cap || "—"))
        : p.descripcion_unidad;
      return { ...p, capacidad: cap, descripcion_unidad: nueva };
    });
  };

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarTodo = async () => {
    setLoading(true);
    const [{ data: vData }, { data: dData }] = await Promise.all([
      supabase.from("vehiculos").select("*").order("placa"),
      supabase.from("documentos_vehiculo").select("*").order("fecha_vencimiento"),
    ]);
    const vList = (vData || []) as Vehiculo[];
    const dList = (dData || []) as DocVehiculo[];
    setVehiculos(vList.map(v => ({ ...v, estado_operativo: calcEstadoOperativo(dList.filter(d => d.vehiculo_id === v.id)) })));
    setDocumentos(dList);
    setLoading(false);
  };
  useEffect(() => { cargarTodo(); }, []);

  // ── Vehículo CRUD ──────────────────────────────────────────────────────────

  const guardarVehiculo = async () => {
    if (!formV.placa.trim()) { alert("La placa es obligatoria"); return; }
    setGuardando(true);
    const payload = {
      placa: formV.placa.trim().toUpperCase(), categoria: formV.categoria,
      marca: formV.marca.trim() || null, modelo: formV.modelo.trim() || null,
      anio: formV.anio ? Number(formV.anio) : null, color: formV.color.trim() || null,
      capacidad_pasajeros: formV.capacidad ? Number(formV.capacidad) : null,
      carga_maxima: formV.carga_maxima.trim() || null, estado: formV.estado,
      equipamiento: formV.equipamiento || "full_equipo",
      foto_externa_url: formV.foto_externa_url.trim() || null,
      foto_interna_url: formV.foto_interna_url.trim() || null,
      descripcion_unidad: formV.descripcion_unidad.trim() || null,
      kilometraje_actual: formV.km ? Number(formV.km) : null,
      proximo_mantenimiento_km: formV.proximo_km ? Number(formV.proximo_km) : null,
      observaciones: formV.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("vehiculos").update(payload).eq("id", editandoId)
      : await supabase.from("vehiculos").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormV(FORM_V); setEditandoId(null); setMostrarFormV(false);
    cargarTodo(); setGuardando(false);
  };

  const editarVehiculo = (v: Vehiculo) => {
    setFormV({
      placa: v.placa, categoria: v.categoria || "BUS",
      marca: v.marca || "", modelo: v.modelo || "",
      anio: v.anio ? String(v.anio) : "", color: v.color || "",
      capacidad: v.capacidad_pasajeros ? String(v.capacidad_pasajeros) : "",
      carga_maxima: v.carga_maxima || "", estado: v.estado || "disponible",
      equipamiento: v.equipamiento || "full_equipo",
      foto_externa_url: v.foto_externa_url || "",
      foto_interna_url: v.foto_interna_url || "",
      descripcion_unidad: v.descripcion_unidad || "",
      km: v.kilometraje_actual ? String(v.kilometraje_actual) : "",
      proximo_km: v.proximo_mantenimiento_km ? String(v.proximo_mantenimiento_km) : "",
      observaciones: v.observaciones || "",
    });
    setEditandoId(v.id); setMostrarFormV(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminarVehiculo = async (id: number, placa: string) => {
    if (!confirm(`¿Eliminar vehículo ${placa}?`)) return;
    await supabase.from("documentos_vehiculo").delete().eq("vehiculo_id", id);
    await supabase.from("vehiculos").delete().eq("id", id);
    cargarTodo();
  };

  // ── Documento CRUD ─────────────────────────────────────────────────────────

  const abrirFormDoc = (vehiculoId?: number) => {
    setFormD({ ...FORM_D, vehiculo_id: vehiculoId ? String(vehiculoId) : "" });
    setEditandoDocId(null); setMostrarFormV(false); setMostrarFormD(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };
  const editarDocumento = (d: DocVehiculo) => {
    setFormD({ vehiculo_id: String(d.vehiculo_id), tipo: d.tipo, numero: d.numero || "",
      fecha_emision: d.fecha_emision || "", fecha_vencimiento: d.fecha_vencimiento || "",
      entidad_emisora: d.entidad_emisora || "", archivo_url: d.archivo_url || "", observaciones: d.observaciones || "" });
    setEditandoDocId(d.id); setMostrarFormD(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };
  const guardarDocumento = async () => {
    if (!formD.vehiculo_id || !formD.tipo) { alert("Selecciona vehículo y tipo"); return; }
    setGuardando(true);
    const cfg = TIPOS_DOC[formD.tipo] || TIPOS_DOC["Otro"];
    const payload = {
      vehiculo_id: Number(formD.vehiculo_id), tipo: formD.tipo,
      numero: formD.numero.trim() || null, fecha_emision: formD.fecha_emision || null,
      fecha_vencimiento: formD.fecha_vencimiento || null,
      entidad_emisora: formD.entidad_emisora.trim() || cfg.entidad || null,
      archivo_url: formD.archivo_url.trim() || null, observaciones: formD.observaciones.trim() || null,
    };
    const { error } = editandoDocId
      ? await supabase.from("documentos_vehiculo").update(payload).eq("id", editandoDocId)
      : await supabase.from("documentos_vehiculo").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormD(FORM_D); setEditandoDocId(null); setMostrarFormD(false);
    cargarTodo(); setGuardando(false);
  };
  const eliminarDocumento = async (id: number) => {
    if (!confirm("¿Eliminar este documento?")) return;
    await supabase.from("documentos_vehiculo").delete().eq("id", id);
    cargarTodo();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const total     = vehiculos.length;
  const aptos     = vehiculos.filter(v => v.estado_operativo === "apto").length;
  const noAptos   = vehiculos.filter(v => v.estado_operativo === "no_apto").length;
  const disponi   = vehiculos.filter(v => v.estado === "disponible").length;
  const fullEquip = vehiculos.filter(v => (v.equipamiento || "full_equipo") === "full_equipo").length;
  const basico    = vehiculos.filter(v => v.equipamiento === "basico").length;
  const docVenc   = documentos.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido").length;
  const docPorV   = documentos.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer").length;

  const filtrados = vehiculos.filter(v => {
    const q = busqueda.toLowerCase();
    const ok = v.placa.toLowerCase().includes(q) || (v.marca || "").toLowerCase().includes(q) || (v.modelo || "").toLowerCase().includes(q);
    return ok && (filtroCat === "todas" || v.categoria === filtroCat)
              && (filtroEst === "todos" || v.estado_operativo === filtroEst)
              && (filtroEquip === "todos" || (v.equipamiento || "full_equipo") === filtroEquip);
  });

  const docsOrdenados = [...documentos].sort((a, b) => {
    const ord = { vencido: 0, por_vencer: 1, sin_fecha: 2, vigente: 3 };
    return (ord[estadoDoc(a.fecha_vencimiento) as keyof typeof ord] || 3) - (ord[estadoDoc(b.fecha_vencimiento) as keyof typeof ord] || 3);
  });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Flota</h1>
          <p className="text-gray-400 mt-1 text-sm">Vehículos · características · equipamiento · fotos · documentos</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setFormV(FORM_V); setEditandoId(null); setMostrarFormD(false); setMostrarFormV(v => !v); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarFormV ? "#6b7280" : "#0b315f" }}>
            {mostrarFormV ? "✕ Cancelar" : "+ Vehículo"}
          </button>
          <button onClick={() => { setMostrarFormV(false); setEditandoDocId(null); setFormD(FORM_D); setMostrarFormD(v => !v); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border hover:bg-gray-50"
            style={{ borderColor: mostrarFormD ? "#6b7280" : "#0b315f", color: mostrarFormD ? "#6b7280" : "#0b315f" }}>
            {mostrarFormD ? "✕ Cancelar" : "+ Documento"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {[
          { label: "Total flota",   valor: total,     color: "#0b315f", bg: "#eef3f8" },
          { label: "Aptos",         valor: aptos,     color: "#166534", bg: "#dcfce7" },
          { label: "No aptos",      valor: noAptos,   color: "#991b1b", bg: "#fee2e2" },
          { label: "Disponibles",   valor: disponi,   color: "#1d4ed8", bg: "#dbeafe" },
          { label: "⭐ Full Equipo", valor: fullEquip, color: "#0b315f", bg: "#eef3f8" },
          { label: "📦 Básico",     valor: basico,    color: "#4b5563", bg: "#f3f4f6" },
          { label: "Docs vencidos", valor: docVenc,   color: "#991b1b", bg: "#fee2e2" },
          { label: "Por vencer",    valor: docPorV,   color: "#854d0e", bg: "#fef9c3" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide leading-tight" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* ALERTA */}
      {(docVenc > 0 || docPorV > 0) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
          <span>⚠️</span>
          <div>
            <span className="font-bold">Atención: </span>
            {docVenc > 0 && <span>{docVenc} documento{docVenc > 1 ? "s" : ""} vencido{docVenc > 1 ? "s" : ""}. </span>}
            {docPorV > 0 && <span>{docPorV} vence{docPorV > 1 ? "n" : ""} en menos de 30 días.</span>}
            <button onClick={() => setVista("documentos")} className="underline font-bold ml-1">Ver documentos →</button>
          </div>
        </div>
      )}

      {/* ── FORMULARIO VEHÍCULO ── */}
      {mostrarFormV && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>🚌</div>
            <div>
              <h2 className="text-lg font-bold">{editandoId ? "Editar vehículo" : "Nuevo vehículo"}</h2>
              <p className="text-xs text-gray-400">La descripción de características se usa en los PDFs de cotización</p>
            </div>
          </div>

          {/* Identificación */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Placa *"><input className={inputCls("font-mono uppercase")} placeholder="ABC-123" value={formV.placa} onChange={fv("placa")} /></Campo>
              <Campo label="Categoría">
                <select className={inputCls()} value={formV.categoria} onChange={fv("categoria")}>
                  {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={formV.estado} onChange={fv("estado")}>
                  <option value="disponible">Disponible</option>
                  <option value="ocupado">Ocupado</option>
                  <option value="mantenimiento">En mantenimiento</option>
                  <option value="inactivo">Inactivo</option>
                </select>
              </Campo>
              <Campo label="Marca"><input className={inputCls()} placeholder="Mercedes Benz" value={formV.marca} onChange={fv("marca")} /></Campo>
              <Campo label="Modelo"><input className={inputCls()} placeholder="OF 1721" value={formV.modelo} onChange={fv("modelo")} /></Campo>
              <Campo label="Año"><input type="number" className={inputCls()} placeholder="2020" value={formV.anio} onChange={fv("anio")} /></Campo>
              <Campo label="Color"><input className={inputCls()} placeholder="Blanco" value={formV.color} onChange={fv("color")} /></Campo>
              <Campo label="Capacidad pasajeros">
                <input type="number" className={inputCls()} placeholder="45"
                  value={formV.capacidad}
                  onChange={e => cambiarCapacidad(e.target.value)} />
              </Campo>
              <Campo label="Carga máxima"><input className={inputCls()} placeholder="5 ton" value={formV.carga_maxima} onChange={fv("carga_maxima")} /></Campo>
            </div>
          </div>

          {/* EQUIPAMIENTO */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Equipamiento</p>
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(EQUIP_CFG) as [string, typeof EQUIP_CFG[keyof typeof EQUIP_CFG]][]).map(([k, v]) => {
                const act = formV.equipamiento === k;
                return (
                  <button key={k} onClick={() => cambiarEquipamiento(k)}
                    className="flex items-center gap-4 px-5 py-4 rounded-2xl border-2 transition-all text-left"
                    style={{ background: act ? v.bg : "white", borderColor: act ? v.color : "#e5e7eb", color: act ? v.color : "#9ca3af" }}>
                    <span className="text-3xl">{v.icon}</span>
                    <div>
                      <p className="font-black text-base">{v.label}</p>
                      <p className="text-xs opacity-70 mt-0.5">{v.desc}</p>
                    </div>
                    {act && <span className="ml-auto text-lg">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* CARACTERÍSTICAS DE LA UNIDAD */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              Características de la unidad
              <span className="ml-2 normal-case font-normal text-blue-500">→ aparece en el PDF de cotización</span>
            </p>
            <div className="rounded-xl border px-4 py-3 mb-3 text-xs text-blue-700" style={{ background: "#eff6ff" }}>
              💡 Este texto se imprime en el ANEXO 1 del PDF de cotización. Se auto-rellena al elegir el equipamiento, pero puedes personalizarlo.
            </div>
            <textarea
              className={inputCls("resize-none")}
              rows={4}
              placeholder="Ej: Bus con capacidad para 49 pasajeros, con aire acondicionado, sistema de audio (radio y TV), asientos reclinables con reposapiés, cortinas, bodega para equipaje y GPS en tiempo real."
              value={formV.descripcion_unidad}
              onChange={fv("descripcion_unidad")}
            />
            <div className="flex gap-2 mt-2">
              <button onClick={() => cambiarEquipamiento(formV.equipamiento)}
                className="text-[10px] font-bold text-blue-600 hover:underline">
                ↺ Restaurar texto por defecto
              </button>
            </div>
          </div>

          {/* FOTOS */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              Fotos del vehículo
              <span className="ml-2 normal-case font-normal text-blue-500">→ se incluyen en el PDF de cotización</span>
            </p>
            <div className="rounded-xl border px-4 py-3 mb-3 text-xs text-blue-700" style={{ background: "#eff6ff" }}>
              💡 Sube las fotos a Google Drive → clic derecho → "Obtener enlace" → "Cualquier persona con el enlace" → pegar URL aquí.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Campo label="📸 Foto exterior (URL)" hint="Lateral, frontal o 3/4 del vehículo">
                <input className={inputCls()} placeholder="https://drive.google.com/file/d/..." value={formV.foto_externa_url} onChange={fv("foto_externa_url")} />
                {formV.foto_externa_url && <FotoPreview url={formV.foto_externa_url} label="Exterior" />}
              </Campo>
              <Campo label="📸 Foto interior (URL)" hint="Asientos, pasillo, comodidades">
                <input className={inputCls()} placeholder="https://drive.google.com/file/d/..." value={formV.foto_interna_url} onChange={fv("foto_interna_url")} />
                {formV.foto_interna_url && <FotoPreview url={formV.foto_interna_url} label="Interior" />}
              </Campo>
            </div>
          </div>

          {/* Kilometraje */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Kilometraje</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Km actual"><input type="number" className={inputCls()} placeholder="150000" value={formV.km} onChange={fv("km")} /></Campo>
              <Campo label="Próximo mant. (km)"><input type="number" className={inputCls()} placeholder="160000" value={formV.proximo_km} onChange={fv("proximo_km")} /></Campo>
              <Campo label="Observaciones internas"><input className={inputCls()} value={formV.observaciones} onChange={fv("observaciones")} /></Campo>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardarVehiculo} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar vehículo"}
            </button>
            <button onClick={() => { setFormV(FORM_V); setEditandoId(null); setMostrarFormV(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* ── FORMULARIO DOCUMENTO ── */}
      {mostrarFormD && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold">{editandoDocId ? "Editar documento" : "Registrar documento"}</h2>
          <div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-2">
              <p className="col-span-3 md:col-span-6 text-[10px] font-bold uppercase text-red-500 mb-0.5">🔴 Obligatorios</p>
              {Object.entries(TIPOS_DOC).filter(([, v]) => v.obligatorio).map(([k, v]) => {
                const activo = formD.tipo === k;
                return (
                  <button key={k} onClick={() => setFormD(p => ({ ...p, tipo: k, entidad_emisora: v.entidad }))}
                    className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                    style={{ background: activo ? "#fee2e2" : "white", borderColor: activo ? "#dc2626" : "#e5e7eb", color: activo ? "#dc2626" : "#9ca3af" }}>
                    <span className="text-base">{v.icon}</span>
                    <span className="text-[9px] font-bold leading-tight">{v.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              <p className="col-span-3 md:col-span-6 text-[10px] font-bold uppercase text-blue-500 mb-0.5">🔵 Complementarios</p>
              {Object.entries(TIPOS_DOC).filter(([, v]) => !v.obligatorio).map(([k, v]) => {
                const activo = formD.tipo === k;
                return (
                  <button key={k} onClick={() => setFormD(p => ({ ...p, tipo: k, entidad_emisora: v.entidad }))}
                    className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                    style={{ background: activo ? "#dbeafe" : "white", borderColor: activo ? "#1d4ed8" : "#e5e7eb", color: activo ? "#1d4ed8" : "#9ca3af" }}>
                    <span className="text-base">{v.icon}</span>
                    <span className="text-[9px] font-bold leading-tight">{v.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Vehículo *">
              <select className={inputCls()} value={formD.vehiculo_id} onChange={fd("vehiculo_id")}>
                <option value="">Seleccionar vehículo</option>
                {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca}</option>)}
              </select>
            </Campo>
            <Campo label="Número / Código"><input className={inputCls("font-mono")} value={formD.numero} onChange={fd("numero")} /></Campo>
            <Campo label="Entidad emisora"><input className={inputCls()} value={formD.entidad_emisora} onChange={fd("entidad_emisora")} /></Campo>
            <Campo label="Fecha de emisión"><input type="date" className={inputCls()} value={formD.fecha_emision} onChange={fd("fecha_emision")} /></Campo>
            <Campo label="Fecha de vencimiento">
              <input type="date" className={inputCls(formD.fecha_vencimiento && diasPara(formD.fecha_vencimiento) !== null && diasPara(formD.fecha_vencimiento)! <= 0 ? "border-red-400 bg-red-50" : "")} value={formD.fecha_vencimiento} onChange={fd("fecha_vencimiento")} />
              {formD.fecha_vencimiento && diasPara(formD.fecha_vencimiento) !== null && (
                <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(formD.fecha_vencimiento)! <= 0 ? "#dc2626" : "#166534" }}>
                  {diasPara(formD.fecha_vencimiento)! <= 0 ? "⚠ Vencido" : `Vence en ${diasPara(formD.fecha_vencimiento)} días`}
                </p>
              )}
            </Campo>
            <Campo label="URL archivo PDF"><input className={inputCls()} placeholder="https://..." value={formD.archivo_url} onChange={fd("archivo_url")} /></Campo>
            <Campo label="Observaciones" span={3}><input className={inputCls()} value={formD.observaciones} onChange={fd("observaciones")} /></Campo>
          </div>
          <div className="flex gap-3">
            <button onClick={guardarDocumento} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#1262bd" }}>
              {guardando ? "Guardando..." : editandoDocId ? "Actualizar" : "Guardar documento"}
            </button>
            <button onClick={() => { setFormD(FORM_D); setEditandoDocId(null); setMostrarFormD(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b">
        {(["flota", "documentos"] as Vista[]).map(v => (
          <button key={v} onClick={() => setVista(v)}
            className="px-5 py-2.5 text-sm font-bold transition-all border-b-2 -mb-px"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {v === "flota" ? `🚌 Flota (${vehiculos.length})` : `📄 Documentos (${documentos.length})`}
          </button>
        ))}
      </div>

      {/* FILTROS */}
      {vista === "flota" && (
        <div className="flex flex-col md:flex-row gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
              placeholder="Buscar placa, marca, modelo..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          </div>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroCat} onChange={e => setFiltroCat(e.target.value)}>
            <option value="todas">Todas las categorías</option>
            {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
          </select>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEquip} onChange={e => setFiltroEquip(e.target.value)}>
            <option value="todos">Todo equipamiento</option>
            <option value="full_equipo">⭐ Full Equipo</option>
            <option value="basico">📦 Básico</option>
          </select>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
            <option value="todos">Todos los estados</option>
            <option value="apto">Aptos</option>
            <option value="no_apto">No aptos</option>
          </select>
        </div>
      )}

      {/* ── VISTA FLOTA ── */}
      {vista === "flota" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <th className="p-4 w-8"></th>
                  {["Vehículo", "Equipamiento", "Capacidad", "Km", "Fotos", "Disponibilidad", "Operativo", "Acciones"].map(h => (
                    <th key={h} className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
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
                  <tr><td colSpan={9} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">🚌</p><p>No se encontraron vehículos</p></td></tr>
                ) : filtrados.map(v => {
                  const opCfg    = ESTADO_OPERATIVO[v.estado_operativo || "apto"];
                  const estCfg   = ESTADO_VEHICULO[v.estado || "disponible"];
                  const equip    = v.equipamiento || "full_equipo";
                  const eqCfg    = EQUIP_CFG[equip as keyof typeof EQUIP_CFG] || EQUIP_CFG.full_equipo;
                  const docsV    = documentos.filter(d => d.vehiculo_id === v.id);
                  const expandido = expandidoId === v.id;
                  const kmAlert  = v.proximo_mantenimiento_km && v.kilometraje_actual && (v.proximo_mantenimiento_km - v.kilometraje_actual) <= 5000;
                  const docsCrit = docsV.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido").length;
                  const docsPorV = docsV.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer").length;
                  const nFotos   = [v.foto_externa_url, v.foto_interna_url].filter(Boolean).length;

                  return (
                    <React.Fragment key={v.id}>
                      <tr className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }}
                        onClick={() => setExpandidoId(expandido ? null : v.id)}>
                        <td className="p-4 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: "#eef3f8" }}>
                              {ICONO_CAT[v.categoria || "BUS"] || "🚌"}
                            </div>
                            <div>
                              <p className="font-black text-gray-900 font-mono">{v.placa}</p>
                              <p className="text-xs text-gray-400">{v.marca} {v.modelo}{v.anio ? ` · ${v.anio}` : ""}</p>
                              {(docsCrit > 0 || docsPorV > 0) && (
                                <p className="text-[10px] font-bold" style={{ color: docsCrit > 0 ? "#dc2626" : "#854d0e" }}>
                                  {docsCrit > 0 ? `⚠ ${docsCrit} doc. vencido${docsCrit > 1 ? "s" : ""}` : `⏰ ${docsPorV} por vencer`}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: eqCfg.bg, color: eqCfg.color }}>
                            {eqCfg.icon} {eqCfg.label}
                          </span>
                        </td>
                        <td className="p-4 text-gray-600">{v.capacidad_pasajeros ? `${v.capacidad_pasajeros} pax` : "—"}</td>
                        <td className="p-4">
                          <p className="font-mono text-sm text-gray-700">{v.kilometraje_actual ? `${Number(v.kilometraje_actual).toLocaleString()} km` : "—"}</p>
                          {kmAlert && <p className="text-[10px] text-amber-600 font-bold">⚠ Mant. próximo</p>}
                        </td>
                        <td className="p-4">
                          {nFotos > 0
                            ? <span className="text-xs font-bold text-blue-600">📸 {nFotos} foto{nFotos > 1 ? "s" : ""}</span>
                            : <span className="text-gray-300 text-xs">Sin fotos</span>}
                        </td>
                        <td className="p-4"><span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span></td>
                        <td className="p-4">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full" style={{ background: opCfg.dot }} />
                            <span className="text-xs font-bold" style={{ color: opCfg.color }}>{opCfg.label}</span>
                          </div>
                        </td>
                        <td className="p-4" onClick={e => e.stopPropagation()}>
                          <div className="flex gap-1.5">
                            <button onClick={() => editarVehiculo(v)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️ Editar</button>
                            <button onClick={() => abrirFormDoc(v.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border text-blue-600 border-blue-100 hover:bg-blue-50">+ Doc</button>
                            <button onClick={() => eliminarVehiculo(v.id, v.placa)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">✕</button>
                          </div>
                        </td>
                      </tr>

                      {expandido && (
                        <tr style={{ background: "#f8fafc" }} className="border-t">
                          <td colSpan={9} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                              {/* Características */}
                              <div className="space-y-3">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Características de la unidad</p>
                                <div className="rounded-xl p-3 border" style={{ background: eqCfg.bg + "88" }}>
                                  <p className="text-xs font-black" style={{ color: eqCfg.color }}>{eqCfg.icon} {eqCfg.label}</p>
                                  {v.descripcion_unidad
                                    ? <p className="text-xs text-gray-600 mt-1 leading-relaxed">{v.descripcion_unidad}</p>
                                    : <p className="text-xs text-gray-300 italic mt-1">Sin descripción registrada</p>}
                                </div>
                                {v.observaciones && <p className="text-xs text-gray-400 italic">"{v.observaciones}"</p>}
                              </div>
                              {/* Fotos */}
                              <div className="space-y-3">
                                <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Fotos</p>
                                {v.foto_externa_url
                                  ? <FotoPreview url={v.foto_externa_url} label="Exterior" />
                                  : <div className="rounded-xl border-2 border-dashed p-4 text-center text-gray-300 text-xs">Sin foto exterior</div>}
                                {v.foto_interna_url
                                  ? <FotoPreview url={v.foto_interna_url} label="Interior" />
                                  : <div className="rounded-xl border-2 border-dashed p-4 text-center text-gray-300 text-xs">Sin foto interior</div>}
                              </div>
                              {/* Documentos */}
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Documentos ({docsV.length})</p>
                                  <button onClick={() => abrirFormDoc(v.id)} className="text-[10px] font-bold text-blue-600 hover:underline">+ Agregar →</button>
                                </div>
                                {docsV.length === 0 ? <p className="text-xs text-gray-300">Sin documentos</p>
                                  : docsV.map(d => {
                                    const est = estadoDoc(d.fecha_vencimiento);
                                    const cfg = ESTADO_DOC[est];
                                    const dias = diasPara(d.fecha_vencimiento);
                                    const tipoCfg = TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
                                    return (
                                      <div key={d.id} className="flex items-center justify-between bg-white border rounded-xl px-3 py-2">
                                        <div className="text-xs flex items-center gap-2">
                                          <span>{tipoCfg.icon}</span>
                                          <div>
                                            <span className="font-bold text-gray-700">{d.tipo}</span>
                                            {d.fecha_vencimiento && <div className="text-[10px] text-gray-400">Vence: {fmtFecha(d.fecha_vencimiento)}{dias !== null && dias >= 0 ? ` (${dias}d)` : ""}</div>}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                                          {d.archivo_url && <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-500 text-[10px] font-bold underline">PDF</a>}
                                          <button onClick={() => editarDocumento(d)} className="text-gray-400 hover:text-gray-700 text-[10px]">✏️</button>
                                          <button onClick={() => eliminarDocumento(d.id)} className="text-red-400 text-[10px] font-bold">✕</button>
                                        </div>
                                      </div>
                                    );
                                  })}
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
            <span>{filtrados.length} de {total} vehículos · {fullEquip} Full Equipo · {basico} Básico</span>
            <span>AFA ERP · Flota</span>
          </div>
        </section>
      )}

      {/* ── VISTA DOCUMENTOS ── */}
      {vista === "documentos" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Vehículo", "Tipo", "Número", "Entidad emisora", "Vencimiento", "Días", "Estado", "Archivo", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {docsOrdenados.length === 0 ? (
                  <tr><td colSpan={9} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>Sin documentos</p></td></tr>
                ) : docsOrdenados.map(d => {
                  const veh = vehiculos.find(v => v.id === d.vehiculo_id);
                  const est = estadoDoc(d.fecha_vencimiento);
                  const cfg = ESTADO_DOC[est];
                  const tipoCfg = TIPOS_DOC[d.tipo] || TIPOS_DOC["Otro"];
                  const dias = diasPara(d.fecha_vencimiento);
                  return (
                    <tr key={d.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9", background: est === "vencido" ? "#fff5f5" : est === "por_vencer" ? "#fffbeb" : "white" }}>
                      <td className="p-3"><span className="font-black font-mono text-[#0b315f]">{veh?.placa || "—"}</span><span className="text-xs text-gray-400 ml-1">{veh?.categoria}</span></td>
                      <td className="p-3"><div className="flex items-center gap-1.5"><span>{tipoCfg.icon}</span><div><div className="text-xs font-bold text-gray-700">{d.tipo}</div>{tipoCfg.obligatorio && <div className="text-[9px] text-red-500 font-bold">Obligatorio</div>}</div></div></td>
                      <td className="p-3 font-mono text-xs text-gray-500">{d.numero || "—"}</td>
                      <td className="p-3 text-xs text-gray-500">{d.entidad_emisora || "—"}</td>
                      <td className="p-3 text-xs text-gray-600">{fmtFecha(d.fecha_vencimiento)}</td>
                      <td className="p-3">{dias !== null ? <span className="font-black text-xs" style={{ color: dias < 0 ? "#dc2626" : dias <= 30 ? "#d97706" : "#166534" }}>{dias < 0 ? `${Math.abs(dias)}d venc.` : `${dias}d`}</span> : "—"}</td>
                      <td className="p-3"><span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span></td>
                      <td className="p-3">{d.archivo_url ? <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-500 underline text-xs font-bold">📄 Ver</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="p-3"><div className="flex gap-1.5"><button onClick={() => editarDocumento(d)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button><button onClick={() => eliminarDocumento(d.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">✕</button></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{documentos.length} documentos · ordenados por urgencia</span>
            <span>AFA ERP · Documentos</span>
          </div>
        </section>
      )}
    </main>
  );
}