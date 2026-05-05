"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type EstadoReserva = "pendiente" | "programada" | "confirmada" | "en_curso" | "finalizada" | "cancelada";

type Cliente            = { id: number; nombre: string; empresa?: string; tipo?: string; };
type Vehiculo           = { id: number; placa: string; categoria?: string; estado?: string; estado_operativo?: string; capacidad_pasajeros?: number; };
type Conductor          = { id: number; nombre: string; licencia?: string; vencimiento_licencia?: string; estado?: string; telefono?: string; };
type EmpresaTercerizada = { id: number; razon_social: string; ruc?: string | null; telefono?: string | null; estado: string; };
type VehiculoTercero    = { id: number; empresa_id: number; placa: string; categoria?: string | null; capacidad?: number | null; estado: string; marca?: string | null; };
type ConductorTercero   = { id: number; empresa_id: number; nombre: string; licencia?: string | null; vencimiento_licencia?: string | null; telefono?: string | null; estado: string; };
type DocumentoTercero   = { id: number; empresa_id: number; tipo: string; fecha_vencimiento?: string | null; };

type Reserva = {
  id: number; cliente_id: number | null; cotizacion_id: number | null;
  vehiculo_id: number | null; conductor_id: number | null;
  tipo: string; estado: EstadoReserva;
  fecha_servicio: string | null; hora_servicio: string | null;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string | null; created_at: string;
  tipo_asignacion: string | null;
  empresa_tercerizada_id: number | null;
  vehiculo_tercero_id: number | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const ESTADO_CFG: Record<EstadoReserva, { label: string; bg: string; color: string; dot: string }> = {
  pendiente:  { label: "Pendiente",  bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
  programada: { label: "Programada", bg: "#e0f2fe", color: "#0369a1", dot: "#0284c7" },
  confirmada: { label: "Confirmada", bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  en_curso:   { label: "En curso",   bg: "#dbeafe", color: "#1d4ed8", dot: "#2563eb" },
  finalizada: { label: "Finalizada", bg: "#ede9fe", color: "#6d28d9", dot: "#7c3aed" },
  cancelada:  { label: "Cancelada",  bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
};

const FLUJO_ESTADO: Record<EstadoReserva, string> = {
  pendiente:  "Sin asignación",
  programada: "Asignado",
  confirmada: "Cliente confirmó",
  en_curso:   "En ejecución",
  finalizada: "Completado",
  cancelada:  "Cancelado",
};

const FORM_VACIO = {
  fecha_servicio: "", hora_servicio: "", tipo_asignacion: "propio",
  estado: "pendiente" as EstadoReserva,
  vehiculo_id: "", conductor_id: "",
  empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "",
  costo_proveedor: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
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

// Verificar si empresa tercerizada tiene docs obligatorios vencidos
function riesgoEmpresa(docs: DocumentoTercero[], empresaId: number): "alto" | "ok" {
  const OBLIGATORIOS = ["SOAT", "Revisión Técnica (CITV)", "Habilitación SUTRAN", "Permiso Operación MTC"];
  const docsEmp = docs.filter(d => d.empresa_id === empresaId);
  const vencidos = docsEmp.filter(d => OBLIGATORIOS.includes(d.tipo) && diasPara(d.fecha_vencimiento || null) !== null && diasPara(d.fecha_vencimiento || null)! < 0);
  return vencidos.length > 0 ? "alto" : "ok";
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ReservasPage() {
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [empresasTer,  setEmpresasTer]  = useState<EmpresaTercerizada[]>([]);
  const [vehTercero,   setVehTercero]   = useState<VehiculoTercero[]>([]);
  const [condTercero,  setCondTercero]  = useState<ConductorTercero[]>([]);
  const [docsTercero,  setDocsTercero]  = useState<DocumentoTercero[]>([]);
  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo,   setFiltroTipo]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, vRes, cRes, etRes, vtRes, ctRes, dtRes, rRes] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,capacidad_pasajeros").order("placa"),
      supabase.from("conductores").select("id,nombre,licencia,vencimiento_licencia,estado,telefono").order("nombre"),
      supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,telefono,estado").order("razon_social"),
      supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,capacidad,estado,marca").order("placa"),
      supabase.from("conductores_tercero").select("id,empresa_id,nombre,licencia,vencimiento_licencia,telefono,estado").order("nombre"),
      supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento"),
      supabase.from("reservas").select("*").order("fecha_servicio", { ascending: false }),
    ]);
    setClientes(clRes.data     || []);
    setVehiculos(vRes.data     || []);
    setConductores(cRes.data   || []);
    setEmpresasTer(etRes.data  || []);
    setVehTercero(vtRes.data   || []);
    setCondTercero(ctRes.data  || []);
    setDocsTercero(dtRes.data  || []);
    setReservas(rRes.data      || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── Helpers de nombre ─────────────────────────────────────────────────────

  const nombreCliente    = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };
  const nombreVehiculo   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreConductor  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "—";
  const nombreEmpTer     = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "—";
  const nombreVehTercero = (id: number | null) => vehTercero.find(v => v.id === id)?.placa || "—";

  // ── Filtros asignación ─────────────────────────────────────────────────────

  const vehiculosAptos        = vehiculos.filter(v => v.estado === "disponible" && (v.estado_operativo === "apto" || !v.estado_operativo));
  const conductoresDisponibles= conductores.filter(c => c.estado !== "no_disponible" && (!c.vencimiento_licencia || new Date(c.vencimiento_licencia) >= new Date()));

  // Empresa seleccionada en el form
  const empSelId      = form.empresa_tercerizada_id ? Number(form.empresa_tercerizada_id) : null;
  const vehEmpSel     = empSelId ? vehTercero.filter(v => v.empresa_id === empSelId && v.estado === "disponible") : [];
  const condEmpSel    = empSelId ? condTercero.filter(c => c.empresa_id === empSelId) : [];
  const riesgoEmpSel  = empSelId ? riesgoEmpresa(docsTercero, empSelId) : "ok";

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const editarReserva = (r: Reserva) => {
    setForm({
      fecha_servicio:        r.fecha_servicio          || "",
      hora_servicio:         r.hora_servicio?.slice(0,5) || "",
      tipo_asignacion:       r.tipo_asignacion          || "propio",
      estado:                r.estado                   || "pendiente",
      vehiculo_id:           r.vehiculo_id              ? String(r.vehiculo_id)              : "",
      conductor_id:          r.conductor_id             ? String(r.conductor_id)             : "",
      empresa_tercerizada_id:r.empresa_tercerizada_id   ? String(r.empresa_tercerizada_id)   : "",
      vehiculo_tercero_id:   r.vehiculo_tercero_id      ? String(r.vehiculo_tercero_id)      : "",
      conductor_tercero_id:  "",
      costo_proveedor:       r.costo_proveedor          ? String(r.costo_proveedor)          : "",
      observaciones:         r.observaciones            || "",
    });
    setEditandoId(r.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardarReserva = async () => {
    if (!editandoId) return;
    if (!form.fecha_servicio || !form.hora_servicio) { alert("Ingresa fecha y hora"); return; }
    if (form.tipo_asignacion === "propio" && (!form.vehiculo_id || !form.conductor_id)) {
      alert("Selecciona vehículo y conductor propios"); return;
    }
    if (form.tipo_asignacion === "tercerizado" && !form.empresa_tercerizada_id) {
      alert("Selecciona la empresa tercerizada"); return;
    }

    // Alerta si la empresa tiene docs vencidos
    if (form.tipo_asignacion === "tercerizado" && riesgoEmpSel === "alto") {
      const ok = confirm("⚠️ ALERTA: Esta empresa tiene documentos OBLIGATORIOS vencidos. Asignarla puede exponerte a multas y perjudicar al cliente. ¿Continuar de todas formas?");
      if (!ok) return;
    }

    setGuardando(true);
    const costo = form.tipo_asignacion === "tercerizado" ? Number(form.costo_proveedor || 0) : 0;

    let nuevoEstado = form.estado;
    const reservaActual = reservas.find(r => r.id === editandoId);
    if (reservaActual?.estado === "pendiente") {
      if (form.tipo_asignacion === "propio" && form.vehiculo_id && form.conductor_id) nuevoEstado = "programada";
      if (form.tipo_asignacion === "tercerizado" && form.empresa_tercerizada_id) nuevoEstado = "programada";
    }
    if (form.estado !== "pendiente") nuevoEstado = form.estado;

    const { error } = await supabase.from("reservas").update({
      fecha_servicio:         form.fecha_servicio,
      hora_servicio:          form.hora_servicio,
      tipo:                   form.tipo_asignacion === "propio" ? "propia" : "tercerizada",
      tipo_asignacion:        form.tipo_asignacion,
      estado:                 nuevoEstado,
      // Flota propia
      vehiculo_id:            form.tipo_asignacion === "propio" ? Number(form.vehiculo_id) : null,
      conductor_id:           form.tipo_asignacion === "propio" ? Number(form.conductor_id) : null,
      // Tercerizado
      empresa_tercerizada_id: form.tipo_asignacion === "tercerizado" ? Number(form.empresa_tercerizada_id) : null,
      vehiculo_tercero_id:    form.tipo_asignacion === "tercerizado" && form.vehiculo_tercero_id ? Number(form.vehiculo_tercero_id) : null,
      costo_proveedor:        costo,
      observaciones:          form.observaciones.trim() || null,
    }).eq("id", editandoId);

    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const eliminarReserva = async (id: number) => {
    if (!confirm("¿Eliminar esta reserva?")) return;
    await supabase.from("reservas").delete().eq("id", id);
    cargarDatos();
  };

  const cambiarEstadoRapido = async (id: number, estado: EstadoReserva) => {
    await supabase.from("reservas").update({ estado }).eq("id", id);
    setReservas(prev => prev.map(r => r.id === id ? { ...r, estado } : r));
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const hoy          = new Date().toISOString().split("T")[0];
  const totalRes     = reservas.length;
  const pendientes   = reservas.filter(r => r.estado === "pendiente").length;
  const programadas  = reservas.filter(r => r.estado === "programada").length;
  const confirmadas  = reservas.filter(r => r.estado === "confirmada").length;
  const enCurso      = reservas.filter(r => r.estado === "en_curso").length;
  const tercerizadas = reservas.filter(r => r.tipo === "tercerizada").length;
  const hoyCount     = reservas.filter(r => r.fecha_servicio === hoy).length;
  const ventas       = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const costos       = reservas.reduce((s, r) => s + Number(r.costo_proveedor || 0), 0);
  const margenTotal  = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => reservas.filter(r => {
    const q   = busqueda.toLowerCase();
    const txt = `${r.id} ${nombreCliente(r.cliente_id)} ${r.origen || ""} ${r.destino || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroEstado === "todos" || r.estado === filtroEstado) &&
      (filtroTipo   === "todos" || r.tipo   === filtroTipo);
  }), [reservas, busqueda, filtroEstado, filtroTipo, clientes]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reservas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Programación de servicios · flota propia o empresa tercerizada
            {hoyCount > 0 && <span className="ml-2 font-bold text-[#0b315f]">· 🚌 {hoyCount} servicio{hoyCount > 1 ? "s" : ""} hoy</span>}
          </p>
        </div>
        {editandoId && (
          <button onClick={limpiar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            ✕ Cancelar edición
          </button>
        )}
      </div>

      {/* FLUJO DE ESTADOS */}
      <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Flujo de estados</p>
        <div className="flex items-center gap-1 flex-wrap">
          {(Object.entries(FLUJO_ESTADO) as [EstadoReserva, string][]).map(([est, desc], i, arr) => {
            const cfg   = ESTADO_CFG[est];
            const count = reservas.filter(r => r.estado === est).length;
            return (
              <React.Fragment key={est}>
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
                    style={{ background: cfg.bg, color: cfg.color }}>
                    <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                    {cfg.label}
                    {count > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.dot }}>{count}</span>}
                  </div>
                  <p className="text-[9px] text-gray-400 mt-1 text-center max-w-[80px]">{desc}</p>
                </div>
                {i < arr.length - 1 && <span className="text-gray-300 text-lg mb-4">→</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total",        valor: totalRes,    color: "#0b315f", bg: "#eef3f8" },
          { label: "Pendientes",   valor: pendientes,  color: "#854d0e", bg: "#fef9c3" },
          { label: "Programadas",  valor: programadas, color: "#0369a1", bg: "#e0f2fe" },
          { label: "Confirmadas",  valor: confirmadas, color: "#166534", bg: "#dcfce7" },
          { label: "En curso",     valor: enCurso,     color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Tercerizadas", valor: tercerizadas,color: "#6d28d9", bg: "#ede9fe" },
          { label: "Hoy",          valor: hoyCount,    color: "#0f766e", bg: "#f0fdfa" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs financieros */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "Ventas reservas",  valor: fmtSoles(ventas),      color: "#166534", bg: "#dcfce7" },
          { label: "Costos proveedor", valor: fmtSoles(costos),      color: "#991b1b", bg: "#fee2e2" },
          { label: "Margen total",     valor: fmtSoles(margenTotal), color: "#1d4ed8", bg: "#dbeafe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO PROGRAMACIÓN */}
      {mostrarForm && editandoId && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>🗓️</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Programar reserva #{editandoId}</h2>
              <p className="text-xs text-gray-400">
                {(() => { const r = reservas.find(r => r.id === editandoId); return r ? `${(r as any).origen || ""} → ${(r as any).destino || ""} · ${fmtSoles(Number(r.precio_cliente || 0))}` : ""; })()}
              </p>
            </div>
          </div>

          {/* Nota */}
          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "#e0f2fe", color: "#0369a1" }}>
            💡 Al asignar recursos el estado pasará automáticamente a <b>Programada</b>. Para <b>tercerizado</b> el sistema verificará que la empresa no tenga documentos vencidos.
          </div>

          {/* Fecha / hora / tipo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del servicio</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
              </Campo>
              <Campo label="Hora *">
                <input type="time" className={inputCls()} value={form.hora_servicio} onChange={f("hora_servicio")} />
              </Campo>
              <Campo label="Tipo de asignación">
                <select className={inputCls()} value={form.tipo_asignacion}
                  onChange={e => setForm(p => ({ ...p, tipo_asignacion: e.target.value, vehiculo_id: "", conductor_id: "", empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "", costo_proveedor: "" }))}>
                  <option value="propio">🚌 Flota propia</option>
                  <option value="tercerizado">🤝 Empresa tercerizada</option>
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pendiente">Pendiente</option>
                  <option value="programada">Programada</option>
                  <option value="confirmada">Confirmada</option>
                  <option value="en_curso">En curso</option>
                  <option value="finalizada">Finalizada</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* Asignación */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              {form.tipo_asignacion === "propio" ? "Asignación de flota propia" : "Empresa tercerizada"}
            </p>

            {form.tipo_asignacion === "propio" ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label={`Vehículo (${vehiculosAptos.length} aptos) *`}>
                  <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                    <option value="">Seleccionar vehículo</option>
                    {vehiculosAptos.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.placa} · {v.categoria}{v.capacidad_pasajeros ? ` · ${v.capacidad_pasajeros} pax` : ""}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo label={`Conductor (${conductoresDisponibles.length} disponibles) *`}>
                  <select className={inputCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                    <option value="">Seleccionar conductor</option>
                    {conductoresDisponibles.map(c => (
                      <option key={c.id} value={c.id}>{c.nombre}{c.licencia ? ` · ${c.licencia}` : ""}</option>
                    ))}
                  </select>
                </Campo>
                <Campo label="Observaciones">
                  <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                </Campo>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Selector empresa */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Empresa tercerizada *" span={2}>
                    <select className={inputCls()} value={form.empresa_tercerizada_id} onChange={f("empresa_tercerizada_id")}>
                      <option value="">Seleccionar empresa</option>
                      {empresasTer.filter(e => e.estado === "activo").map(e => (
                        <option key={e.id} value={e.id}>
                          {riesgoEmpresa(docsTercero, e.id) === "alto" ? "🚨 " : ""}
                          {e.razon_social}{e.ruc ? ` · RUC ${e.ruc}` : ""}
                        </option>
                      ))}
                    </select>
                  </Campo>
                  <Campo label="Costo S/ *">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00"
                      value={form.costo_proveedor} onChange={f("costo_proveedor")} />
                    {form.costo_proveedor && (() => {
                      const r = reservas.find(r => r.id === editandoId);
                      const margen = Number(r?.precio_cliente || 0) - Number(form.costo_proveedor);
                      return (
                        <p className="text-[10px] mt-1 font-bold" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>
                          Margen: {fmtSoles(margen)}
                        </p>
                      );
                    })()}
                  </Campo>
                </div>

                {/* Alerta riesgo empresa */}
                {empSelId && riesgoEmpSel === "alto" && (
                  <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800">
                    🚨 <b>ATENCIÓN:</b> Esta empresa tiene documentos obligatorios vencidos. Al asignarla expones al cliente y a AFA a multas. Revisar módulo de Tercerizadas antes de confirmar.
                  </div>
                )}

                {/* Vehículo y conductor del tercero */}
                {empSelId && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Campo label={`Vehículo del tercero (${vehEmpSel.length} disponibles)`}>
                      <select className={inputCls()} value={form.vehiculo_tercero_id} onChange={f("vehiculo_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {vehEmpSel.map(v => (
                          <option key={v.id} value={v.id}>
                            {v.placa} · {v.categoria}{v.capacidad ? ` · ${v.capacidad} pax` : ""}
                          </option>
                        ))}
                      </select>
                    </Campo>
                    <Campo label={`Conductor del tercero (${condEmpSel.length})`}>
                      <select className={inputCls()} value={form.conductor_tercero_id} onChange={f("conductor_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {condEmpSel.map(c => {
                          const licOk = !c.vencimiento_licencia || diasPara(c.vencimiento_licencia)! >= 0;
                          return (
                            <option key={c.id} value={c.id}>
                              {!licOk ? "⚠️ " : ""}{c.nombre}{c.licencia ? ` · ${c.licencia}` : ""}
                            </option>
                          );
                        })}
                      </select>
                    </Campo>
                    <Campo label="Observaciones">
                      <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                    </Campo>
                  </div>
                )}

                {/* Info empresa seleccionada */}
                {empSelId && (() => {
                  const emp = empresasTer.find(e => e.id === empSelId);
                  if (!emp) return null;
                  return (
                    <div className="rounded-xl px-4 py-3 text-xs bg-gray-50 flex gap-6 flex-wrap">
                      <div><span className="text-gray-400">Empresa:</span> <b>{emp.razon_social}</b></div>
                      {emp.telefono && <div><span className="text-gray-400">Tel:</span> {emp.telefono}</div>}
                      <div><span className="text-gray-400">Flota disponible:</span> <b>{vehEmpSel.length} vehículos</b></div>
                      <div><span className="text-gray-400">Conductores:</span> <b>{condEmpSel.length}</b></div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={guardarReserva} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : "Guardar programación"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por cliente, ruta o ID..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          <option value="propia">🚌 Propia</option>
          <option value="tercerizada">🤝 Tercerizada</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["ID", "Cliente", "Ruta", "Fecha", "Asignación", "Recurso", "Precio", "Margen", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🎫</p><p className="font-medium">No hay reservas</p>
                </td></tr>
              ) : filtradas.map(r => {
                const estCfg    = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                const expandido = expandidoId === r.id;
                const margen    = Number(r.margen || 0);
                const dias      = diasPara(r.fecha_servicio);
                const esHoy     = r.fecha_servicio === hoy;
                const esTer     = r.tipo === "tercerizada";
                const riesgo    = esTer && r.empresa_tercerizada_id ? riesgoEmpresa(docsTercero, r.empresa_tercerizada_id) : "ok";

                return (
                  <React.Fragment key={r.id}>
                    <tr className={`border-t transition-colors cursor-pointer ${editandoId === r.id ? "bg-blue-50" : "hover:bg-gray-50"}`}
                      style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : r.id)}>

                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>

                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">#{r.id}</span>
                        {esHoy && <div className="text-[9px] font-bold text-orange-500">HOY</div>}
                        {riesgo === "alto" && <div className="text-[9px] font-bold text-red-600">🚨 DOC VENC.</div>}
                      </td>

                      <td className="p-3 font-bold text-gray-800 max-w-[120px]">
                        <div className="truncate">{nombreCliente(r.cliente_id)}</div>
                      </td>

                      <td className="p-3 text-gray-600 max-w-[160px]">
                        <div className="truncate text-xs">{(r as any).origen || "—"} → {(r as any).destino || "—"}</div>
                      </td>

                      <td className="p-3 text-xs">
                        <div className="text-gray-700 font-medium">{fmtFecha(r.fecha_servicio)}</div>
                        <div className="text-gray-400">{r.hora_servicio?.slice(0,5) || "—"}</div>
                        {dias !== null && dias >= 0 && dias <= 3 && !esHoy && (
                          <div className="text-[9px] font-bold text-amber-600">En {dias}d</div>
                        )}
                      </td>

                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                          style={esTer ? { background: "#ede9fe", color: "#6d28d9" } : { background: "#dbeafe", color: "#1d4ed8" }}>
                          {esTer ? "🤝 Tercerizado" : "🚌 Propio"}
                        </span>
                      </td>

                      <td className="p-3 text-xs">
                        {esTer ? (
                          <div>
                            <div className="font-bold text-gray-800 truncate max-w-[120px]">{nombreEmpTer(r.empresa_tercerizada_id)}</div>
                            {r.vehiculo_tercero_id && <div className="text-gray-400 font-mono">{nombreVehTercero(r.vehiculo_tercero_id)}</div>}
                          </div>
                        ) : (
                          <div>
                            <div className="font-bold text-gray-800">{nombreVehiculo(r.vehiculo_id)}</div>
                            <div className="text-gray-400">{nombreConductor(r.conductor_id)}</div>
                          </div>
                        )}
                      </td>

                      <td className="p-3 font-bold text-gray-800 text-xs">{fmtSoles(Number(r.precio_cliente || 0))}</td>

                      <td className="p-3 font-bold text-xs" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>
                        {fmtSoles(margen)}
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select value={r.estado}
                          onChange={e => cambiarEstadoRapido(r.id, e.target.value as EstadoReserva)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: estCfg.bg, color: estCfg.color }}>
                          {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5">
                          <button onClick={() => editarReserva(r)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                            🗓️ Programar
                          </button>
                          <button onClick={() => eliminarReserva(r.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>

                    {/* FILA EXPANDIDA */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Servicio</p>
                              <p><span className="text-gray-400">Origen:</span> {(r as any).origen || "—"}</p>
                              <p><span className="text-gray-400">Destino:</span> {(r as any).destino || "—"}</p>
                              <p><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha_servicio)}</p>
                              <p><span className="text-gray-400">Hora:</span> {r.hora_servicio?.slice(0,5) || "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {esTer ? "Empresa tercerizada" : "Flota propia"}
                              </p>
                              {esTer ? (
                                <>
                                  <p>🤝 <b>{nombreEmpTer(r.empresa_tercerizada_id)}</b></p>
                                  {r.vehiculo_tercero_id && <p>🚌 {nombreVehTercero(r.vehiculo_tercero_id)}</p>}
                                  {riesgo === "alto" && <p className="text-red-600 font-bold">🚨 Documentos vencidos</p>}
                                </>
                              ) : (
                                <>
                                  <p>🚌 <b>{nombreVehiculo(r.vehiculo_id)}</b></p>
                                  <p>👤 {nombreConductor(r.conductor_id)}</p>
                                  {conductores.find(c => c.id === r.conductor_id)?.telefono && (
                                    <p className="text-gray-400">📱 {conductores.find(c => c.id === r.conductor_id)?.telefono}</p>
                                  )}
                                </>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Financiero</p>
                              <div className="flex justify-between"><span className="text-gray-400">Precio cliente</span><b>{fmtSoles(Number(r.precio_cliente || 0))}</b></div>
                              <div className="flex justify-between"><span className="text-gray-400">Costo</span><span className="font-bold text-red-600">{fmtSoles(Number(r.costo_proveedor || 0))}</span></div>
                              <div className="flex justify-between border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                <b className="text-gray-600">Margen</b>
                                <span className="font-black" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(margen)}</span>
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Notas</p>
                              {r.cotizacion_id && <p className="text-gray-500">📄 Cotización #{r.cotizacion_id}</p>}
                              {r.observaciones ? <p className="text-gray-600 italic">"{r.observaciones}"</p> : <p className="text-gray-300">Sin observaciones</p>}
                              <p className="text-gray-300 text-[10px]">Creada: {new Date(r.created_at).toLocaleDateString("es-PE")}</p>
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
        {filtradas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtradas.length} de {totalRes} reservas</span>
            <span>AFA ERP · Operaciones</span>
          </div>
        )}
      </section>
    </main>
  );
}