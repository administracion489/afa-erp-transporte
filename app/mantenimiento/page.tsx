"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type TipoMant   = "preventivo" | "correctivo";
type EstadoMant = "pendiente" | "en_proceso" | "finalizado" | "cancelado";

type Vehiculo = {
  id: number;
  placa: string;
  categoria?: string;
  kilometraje_actual?: number;
  proximo_mantenimiento_km?: number;
};

type Mantenimiento = {
  id: number;
  vehiculo_id: number | null;
  fecha: string;
  tipo: TipoMant;
  kilometraje: number;
  descripcion: string;
  proveedor: string | null;
  costo: number;
  estado: EstadoMant;
  proximo_km: number;
  proxima_fecha: string | null;
  observaciones: string | null;
  created_at: string;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const ESTADO_CFG: Record<EstadoMant, { label: string; bg: string; color: string }> = {
  pendiente:  { label: "Pendiente",  bg: "#fef9c3", color: "#854d0e" },
  en_proceso: { label: "En proceso", bg: "#dbeafe", color: "#1d4ed8" },
  finalizado: { label: "Finalizado", bg: "#dcfce7", color: "#166534" },
  cancelado:  { label: "Cancelado",  bg: "#fee2e2", color: "#991b1b" },
};

const TIPO_CFG: Record<TipoMant, { label: string; bg: string; color: string; icon: string }> = {
  preventivo: { label: "Preventivo", bg: "#dbeafe", color: "#1d4ed8", icon: "🔧" },
  correctivo: { label: "Correctivo", bg: "#fee2e2", color: "#991b1b", icon: "🔨" },
};

const FORM_VACIO = {
  vehiculo_id: "", fecha: new Date().toISOString().split("T")[0],
  tipo: "preventivo" as TipoMant, kilometraje: "", descripcion: "",
  proveedor: "", costo: "", estado: "pendiente" as EstadoMant,
  proximo_km: "", proxima_fecha: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diasPara(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha).getTime() - Date.now()) / 86400000);
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

export default function MantenimientoPage() {
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [registros,   setRegistros]   = useState<Mantenimiento[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, mRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,kilometraje_actual,proximo_mantenimiento_km").order("placa"),
      supabase.from("mantenimiento").select("*").order("fecha", { ascending: false }),
    ]);
    setVehiculos(vRes.data || []);
    setRegistros(mRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreVehiculo = (id: number | null) => {
    const v = vehiculos.find(v => v.id === id);
    return v ? `${v.placa}${v.categoria ? ` · ${v.categoria}` : ""}` : "—";
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => {
    setForm(FORM_VACIO);
    setEditandoId(null);
    setMostrarForm(false);
  };

  const editar = (r: Mantenimiento) => {
    setForm({
      vehiculo_id:  r.vehiculo_id  ? String(r.vehiculo_id) : "",
      fecha:        r.fecha        || "",
      tipo:         r.tipo         || "preventivo",
      kilometraje:  r.kilometraje  ? String(r.kilometraje)  : "",
      descripcion:  r.descripcion  || "",
      proveedor:    r.proveedor    || "",
      costo:        r.costo        ? String(r.costo)         : "",
      estado:       r.estado       || "pendiente",
      proximo_km:   r.proximo_km   ? String(r.proximo_km)   : "",
      proxima_fecha: r.proxima_fecha || "",
      observaciones: r.observaciones || "",
    });
    setEditandoId(r.id);
    setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.fecha || !form.descripcion.trim()) {
      alert("Selecciona vehículo, fecha y descripción"); return;
    }
    setGuardando(true);

    const payload = {
      vehiculo_id:   Number(form.vehiculo_id),
      fecha:         form.fecha,
      tipo:          form.tipo,
      kilometraje:   Number(form.kilometraje  || 0),
      descripcion:   form.descripcion.trim(),
      proveedor:     form.proveedor.trim()     || null,
      costo:         Number(form.costo        || 0),
      estado:        form.estado,
      proximo_km:    Number(form.proximo_km   || 0),
      proxima_fecha: form.proxima_fecha        || null,
      observaciones: form.observaciones.trim() || null,
    };

    const { error } = editandoId
      ? await supabase.from("mantenimiento").update(payload).eq("id", editandoId)
      : await supabase.from("mantenimiento").insert(payload);

    if (error) { alert(error.message); setGuardando(false); return; }

    // Actualizar kilometraje del vehículo si es mayor al actual
    if (form.proximo_km) {
      const vehiculo = vehiculos.find(v => v.id === Number(form.vehiculo_id));
      if (vehiculo && Number(form.proximo_km) > (vehiculo.proximo_mantenimiento_km || 0)) {
        await supabase.from("vehiculos")
          .update({ proximo_mantenimiento_km: Number(form.proximo_km) })
          .eq("id", Number(form.vehiculo_id));
      }
    }

    limpiar();
    cargarDatos();
    setGuardando(false);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este registro?")) return;
    await supabase.from("mantenimiento").delete().eq("id", id);
    cargarDatos();
  };

  const cambiarEstado = async (id: number, estado: EstadoMant) => {
    await supabase.from("mantenimiento").update({ estado }).eq("id", id);
    setRegistros(prev => prev.map(r => r.id === id ? { ...r, estado } : r));
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const total       = registros.length;
  const pendientes  = registros.filter(r => r.estado === "pendiente").length;
  const enProceso   = registros.filter(r => r.estado === "en_proceso").length;
  const finalizados = registros.filter(r => r.estado === "finalizado").length;
  const preventivos = registros.filter(r => r.tipo === "preventivo").length;
  const correctivos = registros.filter(r => r.tipo === "correctivo").length;
  const costoTotal  = registros.reduce((s, r) => s + Number(r.costo || 0), 0);
  const costoPreventivo = registros.filter(r => r.tipo === "preventivo").reduce((s, r) => s + Number(r.costo || 0), 0);
  const costoCorrectivo = registros.filter(r => r.tipo === "correctivo").reduce((s, r) => s + Number(r.costo || 0), 0);

  // Alertas — próximas fechas en 15 días
  const proximosAlerta = registros.filter(r => {
    const d = diasPara(r.proxima_fecha);
    return d !== null && d >= 0 && d <= 15 && r.estado !== "cancelado";
  });

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = registros.filter(r => {
    const v = vehiculos.find(v => v.id === r.vehiculo_id);
    const q = busqueda.toLowerCase();
    const txt = `${v?.placa || ""} ${r.descripcion} ${r.proveedor || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroTipo === "todos" || r.tipo   === filtroTipo) &&
      (filtroEst  === "todos" || r.estado === filtroEst);
  });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Mantenimiento</h1>
          <p className="text-gray-400 text-sm mt-1">
            Control preventivo y correctivo · costos · próximos servicios
          </p>
        </div>
        <button
          onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo registro"}
        </button>
      </div>

      {/* ALERTA próximos */}
      {proximosAlerta.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <span className="text-base mt-0.5">⚠️</span>
          <div>
            <span className="font-bold">{proximosAlerta.length} mantenimiento{proximosAlerta.length > 1 ? "s" : ""} próximo{proximosAlerta.length > 1 ? "s" : ""} (en 15 días): </span>
            {proximosAlerta.map(r => (
              <span key={r.id} className="mr-2">
                {nombreVehiculo(r.vehiculo_id)} — {fmtFecha(r.proxima_fecha)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total",        valor: total,       color: "#0b315f", bg: "#eef3f8" },
          { label: "Pendientes",   valor: pendientes,  color: "#854d0e", bg: "#fef9c3" },
          { label: "En proceso",   valor: enProceso,   color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Finalizados",  valor: finalizados, color: "#166534", bg: "#dcfce7" },
          { label: "Preventivos",  valor: preventivos, color: "#0369a1", bg: "#e0f2fe" },
          { label: "Correctivos",  valor: correctivos, color: "#991b1b", bg: "#fee2e2" },
          { label: "Costo total",  valor: fmtSoles(costoTotal), color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* Desglose costos */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border shadow-sm p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Costo preventivo</p>
            <p className="text-xl font-black text-blue-700 mt-0.5">{fmtSoles(costoPreventivo)}</p>
          </div>
          <div className="text-2xl">🔧</div>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Costo correctivo</p>
            <p className="text-xl font-black text-red-700 mt-0.5">{fmtSoles(costoCorrectivo)}</p>
          </div>
          <div className="text-2xl">🔨</div>
        </div>
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg"
              style={{ background: "#0b315f" }}>🔧</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {editandoId ? "Editar registro" : "Nuevo registro de mantenimiento"}
              </h2>
              <p className="text-xs text-gray-400">* campos obligatorios</p>
            </div>
          </div>

          {/* Identificación */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Vehículo *">
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">Seleccionar vehículo</option>
                  {vehiculos.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.placa}{v.categoria ? ` · ${v.categoria}` : ""}
                      {v.kilometraje_actual ? ` · ${Number(v.kilometraje_actual).toLocaleString()} km` : ""}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha} onChange={f("fecha")} />
              </Campo>
              <Campo label="Tipo">
                <select className={inputCls()} value={form.tipo} onChange={f("tipo")}>
                  <option value="preventivo">🔧 Preventivo</option>
                  <option value="correctivo">🔨 Correctivo</option>
                </select>
              </Campo>
              <Campo label="Descripción *" span={2}>
                <input className={inputCls()} placeholder="Ej: Cambio de aceite y filtros, revisión de frenos..." value={form.descripcion} onChange={f("descripcion")} />
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pendiente">Pendiente</option>
                  <option value="en_proceso">En proceso</option>
                  <option value="finalizado">Finalizado</option>
                  <option value="cancelado">Cancelado</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* Ejecución */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Ejecución y costos</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Kilometraje actual">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={form.kilometraje} onChange={f("kilometraje")} />
              </Campo>
              <Campo label="Proveedor / Taller">
                <input className={inputCls()} placeholder="Nombre del taller o proveedor" value={form.proveedor} onChange={f("proveedor")} />
              </Campo>
              <Campo label="Costo S/">
                <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.costo} onChange={f("costo")} />
              </Campo>
            </div>
          </div>

          {/* Próximo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Próximo mantenimiento</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Próximo KM">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 160000" value={form.proximo_km} onChange={f("proximo_km")} />
              </Campo>
              <Campo label="Próxima fecha">
                <input type="date" className={inputCls()} value={form.proxima_fecha} onChange={f("proxima_fecha")} />
              </Campo>
              <Campo label="Observaciones">
                <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones} onChange={f("observaciones")} />
              </Campo>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar registro" : "Guardar registro"}
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
            placeholder="Buscar por placa, descripción o taller..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[150px]"
          value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          <option value="preventivo">Preventivo</option>
          <option value="correctivo">Correctivo</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm min-w-[160px]"
          value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="pendiente">Pendientes</option>
          <option value="en_proceso">En proceso</option>
          <option value="finalizado">Finalizados</option>
          <option value="cancelado">Cancelados</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Fecha", "Vehículo", "Tipo", "Descripción", "Taller", "KM", "Costo", "Próximo", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🔧</p>
                  <p className="font-medium">No hay registros de mantenimiento</p>
                </td></tr>
              ) : filtrados.map(r => {
                const estCfg  = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                const tipoCfg = TIPO_CFG[r.tipo]     || TIPO_CFG.preventivo;
                const expandido = expandidoId === r.id;
                const diasProx  = diasPara(r.proxima_fecha);
                const alertaProx = diasProx !== null && diasProx >= 0 && diasProx <= 15;

                return (
                  <React.Fragment key={r.id}>
                    <tr
                      className="border-t hover:bg-gray-50 transition-colors cursor-pointer"
                      style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : r.id)}>

                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>

                      {/* Fecha */}
                      <td className="p-3 text-xs text-gray-600 font-medium">{fmtFecha(r.fecha)}</td>

                      {/* Vehículo */}
                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f] text-xs">{nombreVehiculo(r.vehiculo_id)}</span>
                      </td>

                      {/* Tipo */}
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                          style={{ background: tipoCfg.bg, color: tipoCfg.color }}>
                          {tipoCfg.icon} {tipoCfg.label}
                        </span>
                      </td>

                      {/* Descripción */}
                      <td className="p-3 text-gray-700 max-w-[180px]">
                        <div className="truncate text-xs">{r.descripcion}</div>
                      </td>

                      {/* Taller */}
                      <td className="p-3 text-xs text-gray-500">{r.proveedor || "—"}</td>

                      {/* KM */}
                      <td className="p-3 font-mono text-xs text-gray-600">
                        {r.kilometraje ? Number(r.kilometraje).toLocaleString() : "—"}
                      </td>

                      {/* Costo */}
                      <td className="p-3 font-bold text-xs text-red-700">
                        {fmtSoles(Number(r.costo || 0))}
                      </td>

                      {/* Próximo */}
                      <td className="p-3">
                        {r.proxima_fecha ? (
                          <div>
                            <div className="text-xs font-medium" style={{ color: alertaProx ? "#854d0e" : "#374151" }}>
                              {fmtFecha(r.proxima_fecha)}
                            </div>
                            {alertaProx && (
                              <div className="text-[9px] font-bold text-amber-600">
                                ⚠ En {diasProx}d
                              </div>
                            )}
                            {r.proximo_km ? (
                              <div className="text-[10px] text-gray-400 font-mono">
                                {Number(r.proximo_km).toLocaleString()} km
                              </div>
                            ) : null}
                          </div>
                        ) : r.proximo_km ? (
                          <span className="text-xs font-mono text-gray-500">
                            {Number(r.proximo_km).toLocaleString()} km
                          </span>
                        ) : "—"}
                      </td>

                      {/* Estado */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select value={r.estado}
                          onChange={e => cambiarEstado(r.id, e.target.value as EstadoMant)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: estCfg.bg, color: estCfg.color }}>
                          <option value="pendiente">Pendiente</option>
                          <option value="en_proceso">En proceso</option>
                          <option value="finalizado">Finalizado</option>
                          <option value="cancelado">Cancelado</option>
                        </select>
                      </td>

                      {/* Acciones */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => editar(r)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                            ✏️ Editar
                          </button>
                          <button onClick={() => eliminar(r.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* FILA EXPANDIDA */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">

                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Detalle del servicio</p>
                              <p className="text-gray-700"><span className="text-gray-400">Vehículo:</span> <b>{nombreVehiculo(r.vehiculo_id)}</b></p>
                              <p className="text-gray-700"><span className="text-gray-400">Tipo:</span> {tipoCfg.icon} {tipoCfg.label}</p>
                              <p className="text-gray-700"><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha)}</p>
                              <p className="text-gray-700"><span className="text-gray-400">KM:</span> {r.kilometraje ? Number(r.kilometraje).toLocaleString() + " km" : "—"}</p>
                              <p className="text-gray-700 mt-1 italic">"{r.descripcion}"</p>
                            </div>

                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Proveedor y costo</p>
                              <p className="text-gray-700"><span className="text-gray-400">Taller:</span> {r.proveedor || "—"}</p>
                              <p className="text-gray-700"><span className="text-gray-400">Costo:</span> <b className="text-red-700">{fmtSoles(Number(r.costo || 0))}</b></p>
                              {r.observaciones && (
                                <p className="text-gray-500 italic mt-1">"{r.observaciones}"</p>
                              )}
                            </div>

                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Próximo mantenimiento</p>
                              <p className="text-gray-700"><span className="text-gray-400">Fecha:</span> {fmtFecha(r.proxima_fecha)}</p>
                              <p className="text-gray-700"><span className="text-gray-400">KM:</span> {r.proximo_km ? Number(r.proximo_km).toLocaleString() + " km" : "—"}</p>
                              {alertaProx && (
                                <div className="mt-2 px-3 py-2 rounded-lg text-amber-800 text-[10px] font-bold" style={{ background: "#fef9c3" }}>
                                  ⚠ Mantenimiento en {diasProx} día{diasProx !== 1 ? "s" : ""}
                                </div>
                              )}
                              <p className="text-gray-300 text-[10px] mt-1">
                                Registrado: {new Date(r.created_at).toLocaleDateString("es-PE")}
                              </p>
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

        {filtrados.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {total} registros · Costo total: {fmtSoles(costoTotal)}</span>
            <span>AFA ERP · Mantenimiento</span>
          </div>
        )}
      </section>
    </main>
  );
}