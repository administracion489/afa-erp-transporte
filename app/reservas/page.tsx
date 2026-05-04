"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type EstadoReserva = "pendiente" | "programada" | "confirmada" | "en_curso" | "finalizada" | "cancelada";
type TipoReserva   = "propia" | "tercerizada";

type Cliente   = { id: number; nombre: string; empresa?: string; tipo?: string; };
type Vehiculo  = { id: number; placa: string; categoria?: string; estado?: string; estado_operativo?: string; capacidad_pasajeros?: number; };
type Conductor = { id: number; nombre: string; licencia?: string; vencimiento_licencia?: string; estado?: string; telefono?: string; };
type Proveedor = { id: number; nombre: string; estado?: string; telefono?: string; };

type Reserva = {
  id: number;
  cliente_id: number | null;
  cotizacion_id: number | null;
  vehiculo_id: number | null;
  conductor_id: number | null;
  proveedor_id: number | null;
  origen: string;
  destino: string;
  tipo: TipoReserva;
  estado: EstadoReserva;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  precio_cliente: number;
  costo_proveedor: number;
  margen: number;
  observaciones: string | null;
  created_at: string;
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

// Flujo lógico de estados
const FLUJO_ESTADO: Record<EstadoReserva, string> = {
  pendiente:  "Sin vehículo/conductor asignado",
  programada: "Vehículo y conductor asignados",
  confirmada: "Cliente confirmó el servicio",
  en_curso:   "Servicio en ejecución",
  finalizada: "Servicio completado",
  cancelada:  "Servicio cancelado",
};

const FORM_VACIO = {
  fecha_servicio: "", hora_servicio: "", tipo: "propia" as TipoReserva,
  estado: "pendiente" as EstadoReserva, vehiculo_id: "", conductor_id: "",
  proveedor_id: "", costo_proveedor: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diasRestantes(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha + "T00:00:00").getTime() - Date.now()) / 86400000);
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

export default function ReservasPage() {
  const [clientes,    setClientes]    = useState<Cliente[]>([]);
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [reservas,    setReservas]    = useState<Reserva[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEstado,setFiltroEstado]= useState("todos");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, vRes, cRes, pRes, rRes] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,capacidad_pasajeros").order("placa"),
      supabase.from("conductores").select("id,nombre,licencia,vencimiento_licencia,estado,telefono").order("nombre"),
      supabase.from("proveedores").select("id,nombre,estado,telefono").order("nombre"),
      supabase.from("reservas").select("*").order("fecha_servicio", { ascending: false }),
    ]);
    setClientes(clRes.data   || []);
    setVehiculos(vRes.data   || []);
    setConductores(cRes.data || []);
    setProveedores(pRes.data || []);
    setReservas(rRes.data    || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreCliente   = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };
  const nombreVehiculo  = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreConductor = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "—";
  const nombreProveedor = (id: number | null) => proveedores.find(p => p.id === id)?.nombre || "—";

  const vehiculosAptos       = vehiculos.filter(v => v.estado_operativo === "apto" || v.estado === "disponible");
  const conductoresDisponibles = conductores.filter(c => { const activo = c.estado !== "inactivo" && c.estado !== "no_disponible"; const licOk = c.vencimiento_licencia ? new Date(c.vencimiento_licencia) >= new Date() : true; return activo && licOk; });
  const proveedoresActivos   = proveedores.filter(p => p.estado !== "inactivo");

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const editarReserva = (r: Reserva) => {
    setForm({
      fecha_servicio:  r.fecha_servicio  || "",
      hora_servicio:   r.hora_servicio?.slice(0, 5) || "",
      tipo:            r.tipo            || "propia",
      estado:          r.estado          || "pendiente",
      vehiculo_id:     r.vehiculo_id     ? String(r.vehiculo_id)  : "",
      conductor_id:    r.conductor_id    ? String(r.conductor_id) : "",
      proveedor_id:    r.proveedor_id    ? String(r.proveedor_id) : "",
      costo_proveedor: r.costo_proveedor ? String(r.costo_proveedor) : "",
      observaciones:   r.observaciones   || "",
    });
    setEditandoId(r.id);
    setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardarReserva = async () => {
    if (!editandoId) return;
    if (!form.fecha_servicio || !form.hora_servicio) { alert("Ingresa fecha y hora"); return; }
    if (form.tipo === "propia") {
      if (!form.vehiculo_id)  { alert("Selecciona un vehículo"); return; }
      if (!form.conductor_id) { alert("Selecciona un conductor"); return; }
    }
    if (form.tipo === "tercerizada" && !form.proveedor_id) { alert("Selecciona un proveedor"); return; }

    setGuardando(true);
    const costo = form.tipo === "tercerizada" ? Number(form.costo_proveedor || 0) : 0;

    // Auto-avanzar estado a "programada" si asigna vehículo/conductor y está pendiente
    let nuevoEstado = form.estado;
    const reservaActual = reservas.find(r => r.id === editandoId);
    if (reservaActual?.estado === "pendiente" && form.tipo === "propia" && form.vehiculo_id && form.conductor_id) {
      nuevoEstado = "programada";
    }
    if (reservaActual?.estado === "pendiente" && form.tipo === "tercerizada" && form.proveedor_id) {
      nuevoEstado = "programada";
    }
    // Respetar si el usuario eligió otro estado manualmente
    if (form.estado !== "pendiente") nuevoEstado = form.estado;

    const { error } = await supabase.from("reservas").update({
      fecha_servicio:  form.fecha_servicio,
      hora_servicio:   form.hora_servicio,
      tipo:            form.tipo,
      estado:          nuevoEstado,
      vehiculo_id:     form.tipo === "propia"      ? Number(form.vehiculo_id)  : null,
      conductor_id:    form.tipo === "propia"      ? Number(form.conductor_id) : null,
      proveedor_id:    form.tipo === "tercerizada" ? Number(form.proveedor_id) : null,
      costo_proveedor: form.tipo === "tercerizada" ? costo : 0,
      observaciones:   form.observaciones.trim() || null,
    }).eq("id", editandoId);

    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar();
    cargarDatos();
    setGuardando(false);
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
    const q = busqueda.toLowerCase();
    const txt = `${r.id} ${nombreCliente(r.cliente_id)} ${r.origen} ${r.destino}`.toLowerCase();
    return txt.includes(q) &&
      (filtroEstado === "todos" || r.estado === filtroEstado) &&
      (filtroTipo   === "todos" || r.tipo   === filtroTipo);
  }), [reservas, busqueda, filtroEstado, filtroTipo, clientes]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reservas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Programación de servicios · vehículo propio o proveedor tercerizado
            {hoyCount > 0 && <span className="ml-2 font-bold text-[#0b315f]">· 🚌 {hoyCount} servicio{hoyCount > 1 ? "s" : ""} hoy</span>}
          </p>
        </div>
        {editandoId && (
          <button onClick={limpiar}
            className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            ✕ Cancelar edición
          </button>
        )}
      </div>

      {/* FLUJO DE ESTADOS — visual */}
      <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Flujo de estados</p>
        <div className="flex items-center gap-1 flex-wrap">
          {(Object.entries(FLUJO_ESTADO) as [EstadoReserva, string][]).map(([est, desc], i, arr) => {
            const cfg = ESTADO_CFG[est];
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
                  <p className="text-[9px] text-gray-400 mt-1 text-center max-w-[90px]">{desc}</p>
                </div>
                {i < arr.length - 1 && <span className="text-gray-300 text-lg mb-4">→</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* KPIs fila 1 */}
      <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-3">
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

      {/* KPIs fila 2 */}
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
                {reservas.find(r => r.id === editandoId)?.origen} → {reservas.find(r => r.id === editandoId)?.destino}
                {" · "}{fmtSoles(Number(reservas.find(r => r.id === editandoId)?.precio_cliente || 0))}
              </p>
            </div>
          </div>

          {/* Nota de flujo */}
          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "#e0f2fe", color: "#0369a1" }}>
            💡 Al asignar vehículo/conductor, el estado pasará automáticamente a <b>Programada</b>. El cliente deberá confirmar para avanzar a <b>Confirmada</b>.
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del servicio</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha de servicio *">
                <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
              </Campo>
              <Campo label="Hora *">
                <input type="time" className={inputCls()} value={form.hora_servicio} onChange={f("hora_servicio")} />
              </Campo>
              <Campo label="Tipo de servicio">
                <select className={inputCls()} value={form.tipo}
                  onChange={e => setForm(p => ({ ...p, tipo: e.target.value as TipoReserva, vehiculo_id: "", conductor_id: "", proveedor_id: "", costo_proveedor: "" }))}>
                  <option value="propia">🚌 Propia</option>
                  <option value="tercerizada">🏢 Tercerizada</option>
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

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              {form.tipo === "propia" ? "Asignación de flota" : "Proveedor externo"}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {form.tipo === "propia" ? (
                <>
                  <Campo label={`Vehículo apto (${vehiculosAptos.length} disponibles) *`}>
                    <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                      <option value="">Seleccionar vehículo</option>
                      {vehiculosAptos.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.placa} · {v.categoria}{v.capacidad_pasajeros ? ` · ${v.capacidad_pasajeros} pax` : ""}
                        </option>
                      ))}
                    </select>
                  </Campo>
                  <Campo label={`Conductor disponible (${conductoresDisponibles.length}) *`}>
                    <select className={inputCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                      <option value="">Seleccionar conductor</option>
                      {conductoresDisponibles.map(c => (
                        <option key={c.id} value={c.id}>{c.nombre}{c.licencia ? ` · ${c.licencia}` : ""}</option>
                      ))}
                    </select>
                  </Campo>
                </>
              ) : (
                <>
                  <Campo label="Proveedor *">
                    <select className={inputCls()} value={form.proveedor_id} onChange={f("proveedor_id")}>
                      <option value="">Seleccionar proveedor</option>
                      {proveedoresActivos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select>
                  </Campo>
                  <Campo label="Costo proveedor S/ *">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00"
                      value={form.costo_proveedor} onChange={f("costo_proveedor")} />
                  </Campo>
                  {form.costo_proveedor && (
                    <div className="flex flex-col justify-end pb-1">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Margen estimado</p>
                      <p className="text-lg font-black" style={{
                        color: (Number(reservas.find(r => r.id === editandoId)?.precio_cliente || 0) - Number(form.costo_proveedor)) >= 0 ? "#166534" : "#991b1b"
                      }}>
                        {fmtSoles(Number(reservas.find(r => r.id === editandoId)?.precio_cliente || 0) - Number(form.costo_proveedor || 0))}
                      </p>
                    </div>
                  )}
                </>
              )}
              <Campo label="Observaciones">
                <input className={inputCls()} placeholder="Notas del servicio..."
                  value={form.observaciones} onChange={f("observaciones")} />
              </Campo>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button onClick={guardarReserva} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : "Guardar programación"}
            </button>
            <button onClick={limpiar}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por cliente, ruta o ID..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[170px]"
          value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="pendiente">Pendientes</option>
          <option value="programada">Programadas</option>
          <option value="confirmada">Confirmadas</option>
          <option value="en_curso">En curso</option>
          <option value="finalizada">Finalizadas</option>
          <option value="cancelada">Canceladas</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[140px]"
          value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          <option value="propia">Propia</option>
          <option value="tercerizada">Tercerizada</option>
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
                {["ID", "Cliente", "Ruta", "Fecha", "Tipo", "Asignación", "Precio", "Margen", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando reservas...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🎫</p>
                  <p className="font-medium">No hay reservas</p>
                </td></tr>
              ) : filtradas.map(r => {
                const estCfg    = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                const expandido = expandidoId === r.id;
                const margen    = Number(r.margen || 0);
                const dias      = diasRestantes(r.fecha_servicio);
                const esHoy     = r.fecha_servicio === hoy;

                return (
                  <React.Fragment key={r.id}>
                    <tr className={`border-t transition-colors cursor-pointer ${editandoId === r.id ? "bg-blue-50" : "hover:bg-gray-50"}`}
                      style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : r.id)}>

                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>

                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">#{r.id}</span>
                        {esHoy && <div className="text-[9px] font-bold text-orange-500 uppercase">Hoy</div>}
                      </td>

                      <td className="p-3 font-bold text-gray-800 max-w-[130px]">
                        <div className="truncate">{nombreCliente(r.cliente_id)}</div>
                      </td>

                      <td className="p-3 text-gray-600 max-w-[180px]">
                        <div className="truncate text-sm">{r.origen} → {r.destino}</div>
                      </td>

                      <td className="p-3">
                        <div className="text-xs text-gray-700 font-medium">{fmtFecha(r.fecha_servicio)}</div>
                        <div className="text-[10px] text-gray-400">{r.hora_servicio?.slice(0, 5) || "—"}</div>
                        {dias !== null && dias >= 0 && dias <= 3 && !esHoy && (
                          <div className="text-[9px] font-bold text-amber-600">En {dias}d</div>
                        )}
                      </td>

                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                          style={r.tipo === "propia" ? { background: "#dbeafe", color: "#1d4ed8" } : { background: "#ede9fe", color: "#6d28d9" }}>
                          {r.tipo === "propia" ? "🚌 Propia" : "🏢 Tercerizada"}
                        </span>
                      </td>

                      <td className="p-3 text-xs text-gray-600">
                        {r.tipo === "propia" ? (
                          <div>
                            <div className="font-bold text-gray-800">{nombreVehiculo(r.vehiculo_id)}</div>
                            <div className="text-gray-400">{nombreConductor(r.conductor_id)}</div>
                          </div>
                        ) : (
                          <div className="font-medium text-gray-700">{nombreProveedor(r.proveedor_id)}</div>
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
                          <option value="pendiente">Pendiente</option>
                          <option value="programada">Programada</option>
                          <option value="confirmada">Confirmada</option>
                          <option value="en_curso">En curso</option>
                          <option value="finalizada">Finalizada</option>
                          <option value="cancelada">Cancelada</option>
                        </select>
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => editarReserva(r)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                            🗓️ Programar
                          </button>
                          <button onClick={() => eliminarReserva(r.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>

                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Servicio</p>
                              <p className="text-gray-700"><span className="text-gray-400">Origen:</span> {r.origen}</p>
                              <p className="text-gray-700"><span className="text-gray-400">Destino:</span> {r.destino}</p>
                              <p className="text-gray-700"><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha_servicio)}</p>
                              <p className="text-gray-700"><span className="text-gray-400">Hora:</span> {r.hora_servicio?.slice(0, 5) || "—"}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {r.tipo === "propia" ? "Flota asignada" : "Proveedor"}
                              </p>
                              {r.tipo === "propia" ? (
                                <>
                                  <p className="text-gray-700">🚌 <b>{nombreVehiculo(r.vehiculo_id)}</b></p>
                                  <p className="text-gray-700">👤 {nombreConductor(r.conductor_id)}</p>
                                  {conductores.find(c => c.id === r.conductor_id)?.telefono && (
                                    <p className="text-gray-400">📱 {conductores.find(c => c.id === r.conductor_id)?.telefono}</p>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="text-gray-700">🏢 <b>{nombreProveedor(r.proveedor_id)}</b></p>
                                  {proveedores.find(p => p.id === r.proveedor_id)?.telefono && (
                                    <p className="text-gray-400">📱 {proveedores.find(p => p.id === r.proveedor_id)?.telefono}</p>
                                  )}
                                </>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Financiero</p>
                              <div className="flex justify-between"><span className="text-gray-400">Precio cliente</span><span className="font-bold text-gray-700">{fmtSoles(Number(r.precio_cliente || 0))}</span></div>
                              <div className="flex justify-between"><span className="text-gray-400">Costo proveedor</span><span className="font-bold text-red-600">{fmtSoles(Number(r.costo_proveedor || 0))}</span></div>
                              <div className="flex justify-between border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                <span className="font-bold text-gray-600">Margen</span>
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