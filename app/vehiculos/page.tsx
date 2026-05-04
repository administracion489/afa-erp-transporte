"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = {
  id: number;
  placa: string;
  categoria: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
  color: string | null;
  capacidad_pasajeros: number | null;
  carga_maxima: string | null;
  estado: string | null;
  kilometraje_actual: number | null;
  proximo_mantenimiento_km: number | null;
  estado_operativo: string | null;
  observaciones: string | null;
};

type Documento = {
  id: number;
  vehiculo_id: number;
  tipo_documento: string;
  numero_documento: string | null;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  obligatorio: boolean | null;
  archivo_url: string | null;
  estado: string | null;
};

type Vista = "flota" | "documentos";

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CATEGORIAS = ["AUTO", "SUV", "VAN", "MINIBUS", "BUS"];
const TIPOS_DOC  = [
  "Tarjeta de propiedad",
  "SOAT",
  "Revisión técnica",
  "Tarjeta de circulación",
  "Seguro todo riesgo",
  "Otro",
];

const ESTADO_OPERATIVO: Record<string, { label: string; bg: string; color: string; dot: string }> = {
  apto:    { label: "Apto",    bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  no_apto: { label: "No apto", bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
};

const ESTADO_DOC: Record<string, { label: string; bg: string; color: string }> = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563" },
};

const ESTADO_VEHICULO: Record<string, { label: string; bg: string; color: string }> = {
  disponible:    { label: "Disponible",    bg: "#dcfce7", color: "#166534" },
  ocupado:       { label: "Ocupado",       bg: "#dbeafe", color: "#1d4ed8" },
  mantenimiento: { label: "Mantenimiento", bg: "#fef9c3", color: "#854d0e" },
  inactivo:      { label: "Inactivo",      bg: "#f3f4f6", color: "#4b5563" },
};

const ICONO_CAT: Record<string, string> = {
  AUTO: "🚗", SUV: "🚙", VAN: "🚐", MINIBUS: "🚌", BUS: "🚌",
};

const FORM_V = {
  placa: "", categoria: "BUS", marca: "", modelo: "", anio: "",
  color: "", capacidad: "", carga_maxima: "", estado: "disponible",
  km: "", proximo_km: "", observaciones: "",
};

const FORM_D = {
  vehiculo_id: "", tipo_documento: "SOAT", numero_documento: "",
  fecha_emision: "", fecha_vencimiento: "", archivo_url: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasParaVencer(fecha: string | null): number | null {
  if (!fecha) return null;
  const diff = new Date(fecha).getTime() - new Date().getTime();
  return Math.ceil(diff / 86400000);
}

function estadoDoc(fecha: string | null): string {
  const dias = diasParaVencer(fecha);
  if (dias === null) return "sin_fecha";
  if (dias < 0)  return "vencido";
  if (dias <= 30) return "por_vencer";
  return "vigente";
}

function esObligatorio(tipo: string, categoria?: string | null): boolean {
  if (["Tarjeta de propiedad", "SOAT", "Revisión técnica"].includes(tipo)) return true;
  if (tipo === "Tarjeta de circulación") return categoria !== "AUTO";
  return false;
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

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function VehiculosPage() {
  const [vehiculos, setVehiculos]     = useState<Vehiculo[]>([]);
  const [documentos, setDocumentos]   = useState<Documento[]>([]);
  const [loading, setLoading]         = useState(false);
  const [vista, setVista]             = useState<Vista>("flota");
  const [mostrarFormV, setMostrarFormV] = useState(false);
  const [mostrarFormD, setMostrarFormD] = useState(false);
  const [editandoId, setEditandoId]   = useState<number | null>(null);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [busqueda, setBusqueda]       = useState("");
  const [filtroCat, setFiltroCat]     = useState("todas");
  const [filtroEst, setFiltroEst]     = useState("todos");
  const [formV, setFormV]             = useState(FORM_V);
  const [formD, setFormD]             = useState(FORM_D);
  const [guardando, setGuardando]     = useState(false);

  const fv = (k: keyof typeof FORM_V) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormV(p => ({ ...p, [k]: e.target.value }));

  const fd = (k: keyof typeof FORM_D) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFormD(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarTodo = async () => {
    setLoading(true);
    const [{ data: vData }, { data: dData }] = await Promise.all([
      supabase.from("vehiculos").select("*").order("placa"),
      supabase.from("documentos_vehiculo").select("*").order("fecha_vencimiento"),
    ]);
    const vList = (vData || []) as Vehiculo[];
    const dList = (dData || []) as Documento[];

    // Recalcular estado_operativo localmente (sin N+1 queries)
    const actualizados = vList.map(v => {
      const docsV = dList.filter(d => d.vehiculo_id === v.id);
      const obligatorios = ["Tarjeta de propiedad", "SOAT", "Revisión técnica",
        ...(v.categoria !== "AUTO" ? ["Tarjeta de circulación"] : [])];
      const tieneProblema = obligatorios.some(tipo => {
        const doc = docsV.find(d => d.tipo_documento === tipo);
        if (!doc) return true;
        const est = estadoDoc(doc.fecha_vencimiento);
        return est === "vencido" || est === "sin_fecha";
      });
      return { ...v, estado_operativo: tieneProblema ? "no_apto" : "apto" };
    });

    setVehiculos(actualizados);
    setDocumentos(dList);
    setLoading(false);
  };

  useEffect(() => { cargarTodo(); }, []);

  // ── Vehículo CRUD ──────────────────────────────────────────────────────────

  const guardarVehiculo = async () => {
    if (!formV.placa.trim()) { alert("La placa es obligatoria"); return; }
    setGuardando(true);
    const payload = {
      placa: formV.placa.trim().toUpperCase(),
      categoria: formV.categoria,
      marca: formV.marca.trim() || null,
      modelo: formV.modelo.trim() || null,
      anio: formV.anio ? Number(formV.anio) : null,
      color: formV.color.trim() || null,
      capacidad_pasajeros: formV.capacidad ? Number(formV.capacidad) : null,
      carga_maxima: formV.carga_maxima.trim() || null,
      estado: formV.estado,
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
      anio: v.anio ? String(v.anio) : "",
      color: v.color || "",
      capacidad: v.capacidad_pasajeros ? String(v.capacidad_pasajeros) : "",
      carga_maxima: v.carga_maxima || "",
      estado: v.estado || "disponible",
      km: v.kilometraje_actual ? String(v.kilometraje_actual) : "",
      proximo_km: v.proximo_mantenimiento_km ? String(v.proximo_mantenimiento_km) : "",
      observaciones: v.observaciones || "",
    });
    setEditandoId(v.id); setMostrarFormV(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminarVehiculo = async (id: number, placa: string) => {
    if (!confirm(`¿Eliminar vehículo ${placa}? Se eliminarán también sus documentos.`)) return;
    await supabase.from("documentos_vehiculo").delete().eq("vehiculo_id", id);
    await supabase.from("vehiculos").delete().eq("id", id);
    cargarTodo();
  };

  // ── Documento CRUD ─────────────────────────────────────────────────────────

  const guardarDocumento = async () => {
    if (!formD.vehiculo_id || !formD.tipo_documento) {
      alert("Selecciona vehículo y tipo de documento"); return;
    }
    setGuardando(true);
    const vehiculo = vehiculos.find(v => v.id === Number(formD.vehiculo_id));
    const payload = {
      vehiculo_id: Number(formD.vehiculo_id),
      tipo_documento: formD.tipo_documento,
      numero_documento: formD.numero_documento.trim() || null,
      fecha_emision: formD.fecha_emision || null,
      fecha_vencimiento: formD.fecha_vencimiento || null,
      obligatorio: esObligatorio(formD.tipo_documento, vehiculo?.categoria),
      archivo_url: formD.archivo_url.trim() || null,
      estado: estadoDoc(formD.fecha_vencimiento || null),
    };
    const { error } = await supabase.from("documentos_vehiculo").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormD(FORM_D); setMostrarFormD(false);
    cargarTodo(); setGuardando(false);
  };

  const eliminarDocumento = async (id: number) => {
    if (!confirm("¿Eliminar este documento?")) return;
    await supabase.from("documentos_vehiculo").delete().eq("id", id);
    cargarTodo();
  };

  // ── Filtrado ───────────────────────────────────────────────────────────────

  const filtrados = vehiculos.filter(v => {
    const q = busqueda.toLowerCase();
    const coincide = v.placa.toLowerCase().includes(q) ||
      (v.marca || "").toLowerCase().includes(q) ||
      (v.modelo || "").toLowerCase().includes(q);
    const porCat = filtroCat === "todas" || v.categoria === filtroCat;
    const porEst = filtroEst === "todos"  || v.estado_operativo === filtroEst;
    return coincide && porCat && porEst;
  });

  // ── KPIs ───────────────────────────────────────────────────────────────────

  const total    = vehiculos.length;
  const aptos    = vehiculos.filter(v => v.estado_operativo === "apto").length;
  const noAptos  = vehiculos.filter(v => v.estado_operativo === "no_apto").length;
  const disponi  = vehiculos.filter(v => v.estado === "disponible").length;
  const docVenc  = documentos.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido").length;
  const docPorV  = documentos.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer").length;

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Flota</h1>
          <p className="text-gray-400 mt-1 text-sm">Vehículos, documentos y estado operativo · AFA Transportes</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setFormV(FORM_V); setEditandoId(null); setMostrarFormD(false); setMostrarFormV(v => !v); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
            style={{ background: mostrarFormV ? "#6b7280" : "#0b315f" }}
          >
            {mostrarFormV ? "✕ Cancelar" : "+ Vehículo"}
          </button>
          <button
            onClick={() => { setFormD(FORM_D); setMostrarFormV(false); setMostrarFormD(v => !v); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: mostrarFormD ? "#6b7280" : "#0b315f", color: mostrarFormD ? "#6b7280" : "#0b315f" }}
          >
            {mostrarFormD ? "✕ Cancelar" : "+ Documento"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: "Total flota",   valor: total,   color: "#0b315f", bg: "#eef3f8" },
          { label: "Aptos",         valor: aptos,   color: "#166534", bg: "#dcfce7" },
          { label: "No aptos",      valor: noAptos, color: "#991b1b", bg: "#fee2e2" },
          { label: "Disponibles",   valor: disponi, color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Docs vencidos", valor: docVenc, color: "#991b1b", bg: "#fee2e2" },
          { label: "Por vencer",    valor: docPorV, color: "#854d0e", bg: "#fef9c3" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-medium uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* ALERTAS documentos críticos */}
      {(docVenc > 0 || docPorV > 0) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
          <span className="text-base mt-0.5">⚠️</span>
          <div>
            <span className="font-bold">Atención: </span>
            {docVenc > 0 && <span>{docVenc} documento{docVenc > 1 ? "s" : ""} vencido{docVenc > 1 ? "s" : ""}. </span>}
            {docPorV > 0 && <span>{docPorV} documento{docPorV > 1 ? "s" : ""} vence{docPorV > 1 ? "n" : ""} en menos de 30 días.</span>}
          </div>
        </div>
      )}

      {/* FORM VEHÍCULO */}
      {mostrarFormV && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ background: "#0b315f" }}>🚌</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar vehículo" : "Nuevo vehículo"}</h2>
              <p className="text-xs text-gray-400">Placa obligatoria · resto opcional</p>
            </div>
          </div>

          {/* Datos principales */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Placa *">
                <input className={inputCls("font-mono uppercase")} placeholder="ABC-123" value={formV.placa} onChange={fv("placa")} />
              </Campo>
              <Campo label="Categoría">
                <select className={inputCls()} value={formV.categoria} onChange={fv("categoria")}>
                  {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </Campo>
              <Campo label="Estado disponibilidad">
                <select className={inputCls()} value={formV.estado} onChange={fv("estado")}>
                  <option value="disponible">Disponible</option>
                  <option value="ocupado">Ocupado</option>
                  <option value="mantenimiento">En mantenimiento</option>
                  <option value="inactivo">Inactivo</option>
                </select>
              </Campo>
              <Campo label="Marca">
                <input className={inputCls()} placeholder="Ej: Mercedes Benz" value={formV.marca} onChange={fv("marca")} />
              </Campo>
              <Campo label="Modelo">
                <input className={inputCls()} placeholder="Ej: OF 1721" value={formV.modelo} onChange={fv("modelo")} />
              </Campo>
              <Campo label="Año">
                <input type="number" className={inputCls()} placeholder="2020" value={formV.anio} onChange={fv("anio")} />
              </Campo>
              <Campo label="Color">
                <input className={inputCls()} placeholder="Blanco" value={formV.color} onChange={fv("color")} />
              </Campo>
              <Campo label="Capacidad pasajeros">
                <input type="number" className={inputCls()} placeholder="45" value={formV.capacidad} onChange={fv("capacidad")} />
              </Campo>
              <Campo label="Carga máxima">
                <input className={inputCls()} placeholder="5 ton" value={formV.carga_maxima} onChange={fv("carga_maxima")} />
              </Campo>
            </div>
          </div>

          {/* Kilometraje */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Kilometraje</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Kilometraje actual">
                <input type="number" className={inputCls()} placeholder="150000" value={formV.km} onChange={fv("km")} />
              </Campo>
              <Campo label="Próximo mantenimiento (km)">
                <input type="number" className={inputCls()} placeholder="160000" value={formV.proximo_km} onChange={fv("proximo_km")} />
              </Campo>
              <Campo label="Observaciones">
                <input className={inputCls()} placeholder="Notas internas..." value={formV.observaciones} onChange={fv("observaciones")} />
              </Campo>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button onClick={guardarVehiculo} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar vehículo" : "Guardar vehículo"}
            </button>
            <button onClick={() => { setFormV(FORM_V); setEditandoId(null); setMostrarFormV(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </section>
      )}

      {/* FORM DOCUMENTO */}
      {mostrarFormD && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: "#1262bd" }}>📄</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Registrar documento</h2>
              <p className="text-xs text-gray-400">El estado se calcula automáticamente por fecha de vencimiento</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Vehículo *">
              <select className={inputCls()} value={formD.vehiculo_id} onChange={fd("vehiculo_id")}>
                <option value="">Seleccionar vehículo</option>
                {vehiculos.map(v => (
                  <option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca}</option>
                ))}
              </select>
            </Campo>
            <Campo label="Tipo de documento *">
              <select className={inputCls()} value={formD.tipo_documento} onChange={fd("tipo_documento")}>
                {TIPOS_DOC.map(t => <option key={t}>{t}</option>)}
              </select>
            </Campo>
            <Campo label="Número de documento">
              <input className={inputCls()} placeholder="N° o código" value={formD.numero_documento} onChange={fd("numero_documento")} />
            </Campo>
            <Campo label="Fecha de emisión">
              <input type="date" className={inputCls()} value={formD.fecha_emision} onChange={fd("fecha_emision")} />
            </Campo>
            <Campo label="Fecha de vencimiento">
              <input type="date" className={inputCls()} value={formD.fecha_vencimiento} onChange={fd("fecha_vencimiento")} />
            </Campo>
            <Campo label="URL archivo / PDF">
              <input className={inputCls()} placeholder="https://..." value={formD.archivo_url} onChange={fd("archivo_url")} />
            </Campo>
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={guardarDocumento} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#1262bd" }}>
              {guardando ? "Guardando..." : "Guardar documento"}
            </button>
            <button onClick={() => { setFormD(FORM_D); setMostrarFormD(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b">
        {(["flota", "documentos"] as Vista[]).map(v => (
          <button key={v} onClick={() => setVista(v)}
            className="px-5 py-2.5 text-sm font-bold transition-all border-b-2 -mb-px"
            style={{
              borderColor: vista === v ? "#0b315f" : "transparent",
              color: vista === v ? "#0b315f" : "#9ca3af",
            }}>
            {v === "flota" ? `🚌 Flota (${vehiculos.length})` : `📄 Documentos (${documentos.length})`}
          </button>
        ))}
      </div>

      {/* ── VISTA FLOTA ── */}
      {vista === "flota" && (
        <>
          {/* Filtros */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
                placeholder="Buscar por placa, marca o modelo..."
                value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[140px]"
              value={filtroCat} onChange={e => setFiltroCat(e.target.value)}>
              <option value="todas">Todas las categorías</option>
              {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[150px]"
              value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
              <option value="todos">Todos los estados</option>
              <option value="apto">Aptos</option>
              <option value="no_apto">No aptos</option>
            </select>
          </div>

          {/* Tabla flota */}
          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    <th className="p-4 w-8"></th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Vehículo</th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Categoría</th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Capacidad</th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Kilometraje</th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Disponibilidad</th>
                    <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Operativo</th>
                    <th className="p-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wide">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="p-10 text-center text-gray-400">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                        Cargando flota...
                      </div>
                    </td></tr>
                  ) : filtrados.length === 0 ? (
                    <tr><td colSpan={8} className="p-10 text-center text-gray-400">
                      <p className="text-3xl mb-2">🚌</p>
                      <p className="font-medium">No se encontraron vehículos</p>
                    </td></tr>
                  ) : filtrados.map(v => {
                    const opCfg = ESTADO_OPERATIVO[v.estado_operativo || "apto"];
                    const estCfg = ESTADO_VEHICULO[v.estado || "disponible"];
                    const docsV = documentos.filter(d => d.vehiculo_id === v.id);
                    const expandido = expandidoId === v.id;
                    const kmAlert = v.proximo_mantenimiento_km && v.kilometraje_actual &&
                      (v.proximo_mantenimiento_km - v.kilometraje_actual) <= 5000;

                    return (
                      <>
                        <tr key={v.id}
                          className="border-t hover:bg-gray-50 transition-colors cursor-pointer"
                          style={{ borderColor: "#f1f5f9" }}
                          onClick={() => setExpandidoId(expandido ? null : v.id)}>
                          <td className="p-4 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                          {/* Placa */}
                          <td className="p-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                                style={{ background: "#eef3f8" }}>
                                {ICONO_CAT[v.categoria || "BUS"] || "🚌"}
                              </div>
                              <div>
                                <p className="font-black text-gray-900 font-mono">{v.placa}</p>
                                <p className="text-xs text-gray-400">{v.marca} {v.modelo} {v.anio ? `· ${v.anio}` : ""}</p>
                              </div>
                            </div>
                          </td>
                          {/* Categoría */}
                          <td className="p-4">
                            <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600">
                              {v.categoria}
                            </span>
                          </td>
                          {/* Capacidad */}
                          <td className="p-4 text-gray-600">
                            {v.capacidad_pasajeros ? `${v.capacidad_pasajeros} pax` : "—"}
                          </td>
                          {/* Kilometraje */}
                          <td className="p-4">
                            <p className="font-mono text-sm text-gray-700">
                              {v.kilometraje_actual ? `${Number(v.kilometraje_actual).toLocaleString()} km` : "—"}
                            </p>
                            {kmAlert && (
                              <p className="text-[10px] text-amber-600 font-bold">⚠ Mantenimiento próximo</p>
                            )}
                          </td>
                          {/* Estado disponibilidad */}
                          <td className="p-4" onClick={e => e.stopPropagation()}>
                            <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                              style={{ background: estCfg.bg, color: estCfg.color }}>
                              {estCfg.label}
                            </span>
                          </td>
                          {/* Estado operativo */}
                          <td className="p-4">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full" style={{ background: opCfg.dot }} />
                              <span className="text-xs font-bold" style={{ color: opCfg.color }}>{opCfg.label}</span>
                            </div>
                          </td>
                          {/* Acciones */}
                          <td className="p-4" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => editarVehiculo(v)}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                                Editar
                              </button>
                              <button onClick={() => eliminarVehiculo(v.id, v.placa)}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">
                                Eliminar
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* FILA EXPANDIDA */}
                        {expandido && (
                          <tr key={`${v.id}-exp`} style={{ background: "#f8fafc" }} className="border-t">
                            <td colSpan={8} className="px-6 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* Info vehículo */}
                                <div className="space-y-2 text-xs">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Datos del vehículo</p>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                                    {[
                                      ["Color", v.color],
                                      ["Carga máxima", v.carga_maxima],
                                      ["Próximo mant.", v.proximo_mantenimiento_km ? `${Number(v.proximo_mantenimiento_km).toLocaleString()} km` : null],
                                    ].map(([k, val]) => val ? (
                                      <div key={String(k)}>
                                        <span className="text-gray-400">{k}: </span>
                                        <span className="text-gray-700 font-medium">{val}</span>
                                      </div>
                                    ) : null)}
                                  </div>
                                  {v.observaciones && (
                                    <p className="text-gray-400 italic mt-1">"{v.observaciones}"</p>
                                  )}
                                </div>
                                {/* Documentos del vehículo */}
                                <div className="space-y-2">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                    Documentos ({docsV.length})
                                  </p>
                                  {docsV.length === 0 ? (
                                    <p className="text-xs text-gray-300">Sin documentos registrados</p>
                                  ) : (
                                    <div className="space-y-1.5">
                                      {docsV.map(d => {
                                        const est = estadoDoc(d.fecha_vencimiento);
                                        const cfg = ESTADO_DOC[est];
                                        const dias = diasParaVencer(d.fecha_vencimiento);
                                        return (
                                          <div key={d.id} className="flex items-center justify-between bg-white border rounded-lg px-3 py-2">
                                            <div className="text-xs">
                                              <span className="font-bold text-gray-700">{d.tipo_documento}</span>
                                              {d.fecha_vencimiento && (
                                                <span className="text-gray-400 ml-2">
                                                  vence {new Date(d.fecha_vencimiento).toLocaleDateString("es-PE")}
                                                  {dias !== null && dias >= 0 && ` (${dias}d)`}
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                              <span className="text-[10px] font-bold px-2 py-0.5 rounded"
                                                style={{ background: cfg.bg, color: cfg.color }}>
                                                {cfg.label}
                                              </span>
                                              {d.archivo_url && (
                                                <a href={d.archivo_url} target="_blank" rel="noreferrer"
                                                  className="text-blue-500 text-[10px] underline">PDF</a>
                                              )}
                                              <button onClick={() => eliminarDocumento(d.id)}
                                                className="text-red-400 hover:text-red-600 text-[10px] font-bold">✕</button>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtrados.length > 0 && (
              <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
                <span>{filtrados.length} de {total} vehículos</span>
                <span>AFA ERP · Flota</span>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── VISTA DOCUMENTOS ── */}
      {vista === "documentos" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Vehículo</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Documento</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Número</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Vencimiento</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Días</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Obligatorio</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Estado</th>
                  <th className="p-4 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Archivo</th>
                  <th className="p-4 text-right text-xs font-bold text-gray-500 uppercase tracking-wide">Acción</th>
                </tr>
              </thead>
              <tbody>
                {documentos.length === 0 ? (
                  <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📄</p>
                    <p className="font-medium">No hay documentos registrados</p>
                  </td></tr>
                ) : (
                  // Ordenar: vencidos primero, luego por_vencer, luego vigentes
                  [...documentos].sort((a, b) => {
                    const orden = { vencido: 0, por_vencer: 1, sin_fecha: 2, vigente: 3 };
                    return (orden[estadoDoc(a.fecha_vencimiento) as keyof typeof orden] || 3) -
                      (orden[estadoDoc(b.fecha_vencimiento) as keyof typeof orden] || 3);
                  }).map(d => {
                    const veh = vehiculos.find(v => v.id === d.vehiculo_id);
                    const est = estadoDoc(d.fecha_vencimiento);
                    const cfg = ESTADO_DOC[est];
                    const dias = diasParaVencer(d.fecha_vencimiento);
                    return (
                      <tr key={d.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                        <td className="p-4">
                          <span className="font-black font-mono text-[#0b315f]">{veh?.placa || "—"}</span>
                          <span className="text-xs text-gray-400 ml-1">{veh?.categoria}</span>
                        </td>
                        <td className="p-4 font-medium text-gray-700">{d.tipo_documento}</td>
                        <td className="p-4 font-mono text-xs text-gray-500">{d.numero_documento || "—"}</td>
                        <td className="p-4 text-gray-600">
                          {d.fecha_vencimiento
                            ? new Date(d.fecha_vencimiento).toLocaleDateString("es-PE")
                            : "—"}
                        </td>
                        <td className="p-4">
                          {dias !== null ? (
                            <span className={`font-bold text-xs ${dias < 0 ? "text-red-600" : dias <= 30 ? "text-amber-600" : "text-gray-500"}`}>
                              {dias < 0 ? `${Math.abs(dias)}d vencido` : `${dias}d`}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="p-4">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded ${d.obligatorio ? "bg-red-50 text-red-600" : "bg-gray-100 text-gray-400"}`}>
                            {d.obligatorio ? "Sí" : "No"}
                          </span>
                        </td>
                        <td className="p-4">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                            style={{ background: cfg.bg, color: cfg.color }}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="p-4">
                          {d.archivo_url
                            ? <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-500 underline text-xs">Ver PDF</a>
                            : <span className="text-gray-300 text-xs">—</span>}
                        </td>
                        <td className="p-4 text-right">
                          <button onClick={() => eliminarDocumento(d.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {documentos.length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
              <span>{documentos.length} documentos · ordenados por urgencia</span>
              <span>AFA ERP · Documentos</span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}